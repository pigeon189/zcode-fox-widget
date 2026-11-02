// MCP (stdio) 服务：让 ZCode 会话内可以直接查余额、启停挂件、改配置。
//
// 传输是 MCP 标准的 stdio + 换行分隔 JSON（NDJSON），不依赖任何 npm 包，
// 便于插件直接分发。stdout 只写协议消息，诊断信息一律走 stderr。
//
// 诊断日志前缀 `[zcode-whale]` 刻意保留（与 lib/server.mjs 的同类前缀、`/whale` 路由
// 同理由：不破坏既有日志排查习惯；产品名变更不回改日志前缀）。
import readline from 'node:readline'
import { pluginVersion } from './paths.mjs'
import { getBalance, readWidgetState, writeWidgetState } from './balance.mjs'
import { findApiKey, maskKey, normalizeGlmWalletRefreshInterval, readPluginConfig, writePluginConfig } from './credentials.mjs'
import { ensureServer, findRunningServer, stopServer, widgetUrl } from './service.mjs'
import { installRuntime, isRuntimeInstalled, overlayStatus, startOverlay, stopOverlay } from './overlay.mjs'
import { readLatestTurn } from './turn-cost.mjs'
import { turnPlanUsage } from './plan-balance.mjs'

// 币种只在这里定义一次；版本号单一来源是插件清单（pluginVersion 在 paths.mjs，
// server 与 MCP 共用同一实现——审查 P2-2），市场页与 MCP 握手展示同一个版本。
const CUR_SYMBOL = { CNY: '¥', USD: '$' }

const SERVER_INFO = { name: 'zcode-fox-widget', version: pluginVersion() }
const PROTOCOL_FALLBACK = '2024-11-05'
// 自己支持的协议版本。initialize 只能回这里面的值：原样回显客户端给的任意
// 字符串（例如 "9999"）等于宣称支持一个不存在的版本，后续按它发消息的客户端
// 会踩到我们没实现的行为（审查 S3）。
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18']

function money(amount, currency, digits) {
  const n = Number(amount)
  const fixed = isFinite(n) ? n.toFixed(digits === undefined ? 2 : digits) : '--'
  const sym = CUR_SYMBOL[currency] || ''
  if (sym) return sym + ' ' + fixed
  // 未知/缺失币种：无符号时按原样人民币口径，未知币种显式标出
  return !currency || currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency
}

function usageModeLabel(mode) {
  return mode === 'token' ? '实时·令牌' : '大肥鱼记账'
}

const TOOLS = [
  {
    name: 'whale_balance',
    description:
      '查询 DeepSeek 账户余额、今日已用金额与当前峰谷时段。今日已用在大肥鱼记账模式下由余额差值累计，在实时·令牌模式下由平台用量接口按峰谷定价换算。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'whale_widget',
    description:
      '管理鲸鱼挂件。start/stop/status/url 针对网页版挂件服务（浏览器打开地址即可）；overlay_start/overlay_stop/overlay_status 针对桌面浮层——一个透明置顶窗口，鲸鱼直接浮在 ZCode 界面上，默认鼠标穿透、只在指针压到鲸鱼时才接管鼠标，所以不挡任何操作。close = 关闭插件（把当前这一份停掉：服务与浮层；下次会话启动时钩子会照常拉起）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'url', 'close', 'overlay_start', 'overlay_stop', 'overlay_status'],
          description: '要执行的动作',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'whale_last_turn',
    description:
      '读取上一轮对话的真实消耗（token 数按峰谷定价换算成金额）。数据来自 ZCode 记录的 turn 用量。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'whale_config',
    description:
      '查看或修改鲸鱼挂件配置。apiKey 用于访问 DeepSeek 余额接口（未配置时会自动复用 ZCode 里已有的 DeepSeek provider 凭据）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get 查看，set 修改' },
        apiKey: { type: 'string', description: 'DeepSeek API Key（sk- 开头），仅 set 时使用' },
        usageMode: { type: 'string', enum: ['ledger', 'token'], description: '对账口径（大肥鱼记账 / 实时·令牌）' },
        port: { type: 'number', description: '挂件服务固定端口，改后需重启服务' },
        autoStartWidget: { type: 'boolean', description: '是否在 ZCode 会话启动时自动拉起挂件服务' },
        autoStartOverlay: { type: 'boolean', description: '是否在会话启动时自动拉起桌面浮层（需已装 Electron 运行时）' },
        refreshGlmWalletOnTurnComplete: { type: 'boolean', description: '回合结束时强制刷新一次 GLM 按量钱包余额（默认关；只刷这一个模板）' },
        minGlmWalletRefreshIntervalMs: { type: 'number', description: '上一项的最小间隔毫秒数，下限 2 分钟、只能调大（无效值不落盘）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]

async function toolBalance() {
  const p = await getBalance()
  if (!p.ok) {
    const key = findApiKey()
    const hint =
      p.code === 'NO_KEY'
        ? '\n\n尚未配置凭据。可用 whale_config 的 set 动作写入 apiKey，或在 ZCode 里添加 baseURL 指向 api.deepseek.com 的 DeepSeek provider。'
        : ''
    return {
      text: '🐳 余额获取失败：' + p.error + hint,
      isError: true,
    }
  }
  const lines = [
    '🐳 DeepSeek 余额',
    '余额：' + money(p.totalBalance, p.currency),
    '今日已用：' + money(p.todayUsage, p.currency) + '（' + usageModeLabel(p.usageMode) + '）',
    '当前时段：' + (p.isPeak ? '高峰时段' : '空闲时段'),
    '更新时间：' + p.updatedAt,
  ]
  if (p.usageFallback) lines.push('提示：平台令牌不可用（' + p.usageFallback + '），已回落记账模式。')
  if (p.stale) lines.push('提示：接口暂时不可用，以上为最近一次成功的缓存值。')
  return { text: lines.join('\n') }
}

async function toolWidget(args) {
  const action = args && args.action
  if (action === 'overlay_start') {
    if (!isRuntimeInstalled()) {
      return {
        text:
          '桌面浮层需要 Electron 运行时（约 150MB，一次性）。请在终端执行：\n  node lib/cli.mjs desktop install\n装好后再执行 overlay_start，或直接 node lib/cli.mjs window start。',
        isError: true,
      }
    }
    const r = await startOverlay()
    if (!r.running) return { text: '桌面浮层启动失败：' + (r.error || '未知原因'), isError: true }
    return {
      text:
        '🐳 桌面浮层已就绪（pid ' +
        r.pid +
        '）：鲸鱼浮在桌面上，默认鼠标穿透，指针压到鲸鱼上才会接管鼠标。' +
        (r.started ? '（本次新启动）' : '（复用已在运行的浮层）'),
    }
  }
  if (action === 'overlay_stop') {
    const r = await stopOverlay()
    return r.ok ? { text: '🐳 桌面浮层已关闭' } : { text: '关闭失败：' + r.error, isError: true }
  }
  if (action === 'overlay_status') {
    const s = await overlayStatus()
    const lines = ['桌面浮层：' + (s.running ? '运行中（pid ' + s.pid + '）' : '未运行')]
    lines.push('Electron 运行时：' + (s.installed ? '已安装' : '未安装（node lib/cli.mjs desktop install）'))
    if (s.running) lines.push('提示：浮层是透明置顶的，鼠标移上去才会接管点击；node lib/cli.mjs window stop 可关闭。')
    return { text: lines.join('\n') }
  }
  if (action === 'start') {
    const r = await ensureServer()
    if (!r.running) return { text: '启动失败：' + (r.error || '未知原因'), isError: true }
    return {
      text:
        '🐳 挂件已就绪：' +
        widgetUrl(r.port) +
        (r.started ? '（本次新启动）' : '（复用已在运行的服务）') +
        '\n用浏览器打开该地址即可看到大肥鱼；用支持透明窗口的容器打开则是桌面挂件效果。',
    }
  }
  if (action === 'stop') {
    const r = await stopServer()
    return r.ok ? { text: '🐳 挂件服务已停止' } : { text: '停止失败：' + r.error, isError: true }
  }
  if (action === 'close') {
    // 关闭插件 = 停浮层 + 停服务（本次关闭，不写任何「别再自启」的标记：
    // 下次会话启动/收到提问时钩子照常拉起）
    const ov = await stopOverlay()
    const r = await stopServer()
    if (!r.ok && (await findRunningServer())) {
      return { text: '关闭失败：服务未停止（' + r.error + '）', isError: true }
    }
    return {
      text:
        '🐳 插件已关闭：桌面浮层' +
        (ov.ok ? '与服务都已停止' : '未在运行，服务已停止') +
        '。本次关闭不影响自启——下次会话启动时会照常拉起；想立刻回来：action=start。',
    }
  }
  if (action === 'url') {
    const running = await findRunningServer()
    return running
      ? { text: widgetUrl(running.port) }
      : { text: '挂件服务未在运行', isError: true }
  }
  const running = await findRunningServer()
  if (!running) return { text: '挂件服务未运行。可用 action=start 启动。' }
  const key = findApiKey()
  return {
    text: [
      '🐳 挂件服务运行中',
      '地址：' + widgetUrl(running.port),
      'pid：' + (running.health && running.health.pid),
      '对账口径：' + usageModeLabel(readWidgetState().usageMode),
      '凭据：' + (key.key ? maskKey(key.key) + '（' + key.source + '）' : '未配置'),
    ].join('\n'),
  }
}

function toolLastTurn() {
  const t = readLatestTurn()
  if (!t.ok) {
    return {
      text: '读不到每轮消耗数据（' + (t.reason || 'unknown') + '）。需要 ZCode 已经完成过至少一轮对话。',
      isError: true,
    }
  }
  const n = (v) => Number(v).toLocaleString('en-US')
  // 套餐扣费轮（Start plan 等）按量价目算出的金额是虚构的：改按「余额的百分比」
  // 表达（与 cli.mjs cmdTurn / server.mjs 载荷同口径）；混合轮次另附非套餐行金额
  const planInfo = turnPlanUsage(t)
  let headline
  if (planInfo && planInfo.pctOfTotal != null) {
    headline = '套餐配额的 ' + planInfo.pctOfTotal + '%（' + n(planInfo.tokens) + ' tokens）'
    if (planInfo.extraAmounts) {
      const extra = Object.keys(planInfo.extraAmounts)
        .map((c) => money(planInfo.extraAmounts[c], c))
        .join(' + ')
      headline += '，另耗其他源 ' + extra
    }
  } else if (planInfo) {
    headline = '套餐轮次（无配额观测，仅 ' + n(planInfo.tokens) + ' tokens）'
  } else {
    headline = t.billable ? money(t.amount, t.currency) : '不可计价（仅统计 tokens）'
  }
  const lines = [
    '🐳 上一轮对话消耗：' + headline,
    '模型：' + (t.model || '未知') + (t.providerId ? '（' + t.providerId + '）' : '') + (t.vendorLabel ? ' · ' + t.vendorLabel : ''),
  ]
  if (t.peak) lines.push('计价时段：高峰（DeepSeek 峰谷价）')
  const rows = Array.isArray(t.models) ? t.models : []
  for (const m of rows) {
    const head = (rows.length > 1 ? '· ' : '') + (m.model || '未知模型') + '  ' + n(m.tokens) + ' tokens'
    if (!m.billable) {
      lines.push(head + '（' + (m.vendorLabel || '不可计价') + '）')
      continue
    }
    // 币种按行给（同一轮可能混币种），符号随行变化
    const sym = CUR_SYMBOL[m.currency] || '¥'
    const m4 = (v) => Number(v).toFixed(4)
    lines.push(head + ' = ' + money(m.amount, m.currency, 4) + (m.peak ? '（高峰）' : ''))
    const b = m.breakdown
    const r = m.rates
    if (b && r) {
      lines.push('  缓存命中输入 ' + n(b.hit) + ' × ' + sym + r.hit + '/M = ' + sym + m4((b.hit / 1e6) * r.hit))
      lines.push('  未命中输入   ' + n(b.miss) + ' × ' + sym + r.miss + '/M = ' + sym + m4((b.miss / 1e6) * r.miss))
      if (b.cacheWrite) {
        // 单价用 rates.cw（写入价，与总额口径一致；用 r.miss 会让各行相加对不上总额）
        lines.push('  缓存写入     ' + n(b.cacheWrite) + ' × ' + sym + r.cw + '/M = ' + sym + m4((b.cacheWrite / 1e6) * r.cw))
      }
      lines.push('  输出         ' + n(b.output) + ' × ' + sym + r.out + '/M = ' + sym + m4((b.output / 1e6) * r.out))
    }
  }
  lines.push('总 token：' + n(t.tokens))
  lines.push('数据来源：' + t.source)
  return { text: lines.join('\n') }
}

async function toolConfig(args) {
  const action = args && args.action
  if (action === 'set') {
    const patch = {}
    const invalid = []
    if (typeof args.apiKey === 'string' && args.apiKey.trim()) patch.apiKey = args.apiKey.trim()
    if (args.usageMode === 'ledger' || args.usageMode === 'token') {
      patch.usageMode = args.usageMode
      writeWidgetState({ usageMode: args.usageMode })
    }
    if (Number.isInteger(args.port) && args.port > 0 && args.port < 65536) patch.port = args.port
    if (typeof args.autoStartWidget === 'boolean') patch.autoStartWidget = args.autoStartWidget
    if (typeof args.autoStartOverlay === 'boolean') patch.autoStartOverlay = args.autoStartOverlay
    if (typeof args.refreshGlmWalletOnTurnComplete === 'boolean') {
      patch.refreshGlmWalletOnTurnComplete = args.refreshGlmWalletOnTurnComplete
    }
    if (args.minGlmWalletRefreshIntervalMs !== undefined) {
      // 归一化在 credentials.mjs：下限 2 分钟、上限 1 小时；无效值不落盘（保持原值）
      const min = normalizeGlmWalletRefreshInterval(args.minGlmWalletRefreshIntervalMs)
      if (min) patch.minGlmWalletRefreshIntervalMs = min
      else invalid.push('minGlmWalletRefreshIntervalMs（毫秒数，读取时钳在 120000–3600000）')
    }
    if (Object.keys(patch).length === 0) {
      return { text: invalid.length ? '没有可修改的字段：' + invalid.join('、') : '没有需要修改的字段。', isError: true }
    }
    writePluginConfig(patch)
    const changed = Object.keys(patch)
      .map((k) => (k === 'apiKey' ? 'apiKey（已写入，不显示明文）' : k + '=' + String(patch[k])))
      .join(', ')
    const note = patch.port ? '\n端口变更需要重启挂件服务（action=stop 再 start）。' : ''
    const warn = invalid.length ? '\n未生效：' + invalid.join('、') : ''
    return { text: '已更新：' + changed + warn + note }
  }
  const cfg = readPluginConfig()
  const key = findApiKey()
  const ws = readWidgetState()
  const ov = await overlayStatus()
  return {
    text: [
      '🐳 鲸鱼挂件配置',
      '凭据：' + (key.key ? maskKey(key.key) + '（来源 ' + key.source + '）' : '未配置'),
      '对账口径：' + usageModeLabel(ws.usageMode),
      '固定端口：' + (cfg.port || '自动（默认 39321）'),
      '会话自启：服务 ' + (cfg.autoStartWidget ? '开' : '关') + '、桌面浮层 ' + (cfg.autoStartOverlay ? '开' : '关'),
      '桌面浮层：' + (ov.running ? '运行中（pid ' + ov.pid + '）' : ov.installed ? '未运行' : '未运行 · 运行时未安装'),
      '挂件外观：大小 ' + ws.scale + '、音效 ' + (ws.sound ? ws.soundSet : '关闭') + '、气泡 ' + (ws.bubbleOn ? '开' : '关'),
      'GLM 钱包回合刷新：' + (cfg.refreshGlmWalletOnTurnComplete
        ? '开（最小间隔 ' + cfg.minGlmWalletRefreshIntervalMs + 'ms）'
        : '关'),
    ].join('\n'),
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'whale_balance':
      return toolBalance()
    case 'whale_widget':
      return toolWidget(args)
    case 'whale_last_turn':
      return toolLastTurn()
    case 'whale_config':
      return toolConfig(args)
    default:
      return { text: '未知工具：' + name, isError: true }
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

async function handle(msg) {
  const id = msg && msg.id
  const method = msg && msg.method
  // 通知（无 id）不需要响应
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') return
    return
  }
  if (method === 'initialize') {
    const requested = msg.params && msg.params.protocolVersion
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOLS.indexOf(String(requested || '')) !== -1 ? requested : PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    })
    return
  }
  if (method === 'ping') {
    write({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const name = msg.params && msg.params.name
    const args = (msg.params && msg.params.arguments) || {}
    try {
      const out = await callTool(name, args)
      write({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: out.text }], isError: !!out.isError },
      })
    } catch (err) {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: '工具执行失败：' + String((err && err.message) || err) }],
          isError: true,
        },
      })
    }
    return
  }
  write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + String(method) } })
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
// 串行处理：避免多个工具调用并发时响应顺序错乱
let chain = Promise.resolve()
rl.on('line', (line) => {
  const text = String(line).trim()
  if (!text) return
  let msg
  try {
    msg = JSON.parse(text)
  } catch (err) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  chain = chain.then(() => handle(msg)).catch((err) => {
    process.stderr.write('[zcode-whale] ' + String((err && err.message) || err) + '\n')
  })
})
// 客户端关闭 stdin 就退出，否则进程会一直挂在事件循环里
rl.on('close', () => {
  chain.then(() => process.exit(0)).catch(() => process.exit(0))
})

process.stderr.write('[zcode-whale] MCP server ready (' + SERVER_INFO.version + ')\n')
