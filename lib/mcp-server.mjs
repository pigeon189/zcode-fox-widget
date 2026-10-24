// MCP (stdio) 服务：让 WorkBuddy 会话内可以直接查用量、启停挂件、改配置。
//
// 传输是 MCP 标准的 stdio + 换行分隔 JSON（NDJSON），不依赖任何 npm 包，
// 便于插件直接分发。stdout 只写协议消息，诊断信息一律走 stderr。
import readline from 'node:readline'
import { pluginVersion } from './paths.mjs'
import { HOST_LABEL } from './host.mjs'
import { getBalance, readWidgetState, writeWidgetState } from './balance.mjs'
import { findApiKey, maskKey, readPluginConfig, writePluginConfig } from './credentials.mjs'
import { clearClosePause, ensureServer, findRunningServer, stopServer, widgetUrl, writeClosePause } from './service.mjs'
import { installRuntime, isRuntimeInstalled, overlayStatus, startOverlay, stopOverlay } from './overlay.mjs'
import { readLatestTurn, readContextUsage } from './turn-cost.mjs'
import { turnPlanUsage } from './plan-balance.mjs'
import { usageRecords } from './usage-records.mjs'

// 币种只在这里定义一次；版本号单一来源是插件清单（pluginVersion 在 paths.mjs，
// server 与 MCP 共用同一实现——审查 P2-2），市场页与 MCP 握手展示同一个版本。
const CUR_SYMBOL = { CNY: '¥', USD: '$' }

const SERVER_INFO = { name: 'fox-widget', version: pluginVersion() }
const PROTOCOL_FALLBACK = '2024-11-05'

// 金额文本：'CREDIT' 是我们自己的积分口径标记，不加货币符号、后缀「积分」。
// 其它币种照旧（CNY/USD 等）——等价市值那一层会用到。
function money(amount, currency, digits) {
  const n = Number(amount)
  const fixed = isFinite(n) ? n.toFixed(digits === undefined ? 2 : digits) : '--'
  if (currency === 'CREDIT') return fixed + ' 积分'
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
    name: 'whale_credits',
    description:
      '查询 WorkBuddy 的订阅积分消耗：当前会话上下文余量、今日积分合计、最近一轮消耗的 credit。数据来自宿主自己的会话库与 transcript（积分由宿主算好，无需配置任何密钥）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'whale_balance',
    description:
      '查询第三方厂商余额（可选功能）。WorkBuddy 是订阅积分制，默认没有用户自带的厂商 key；只有在你自行配置了 DEEPSEEK_API_KEY 之类的凭据、或写了 vendorKeys 时才有数据。主口径请用 whale_credits。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'whale_widget',
    description:
      '管理鲸鱼挂件。start/stop/status/url 针对网页版挂件服务（浏览器打开地址即可）；overlay_start/overlay_stop/overlay_status 针对桌面浮层——一个透明置顶窗口，鲸鱼直接浮在 WorkBuddy 界面上，默认鼠标穿透、只在指针压到鲸鱼时才接管鼠标，所以不挡任何操作。close = 关闭插件（把当前这一份停掉：服务与浮层，并让看门狗本次停手；下次启动 WorkBuddy 会照常拉起）。',
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
      '读取上一轮对话的消耗：订阅积分（宿主 credit 口径，主显示）、处理 token 数、模型与逐模型明细，另附按公开价目折算的等价金额。数据来自 WorkBuddy 的 session_usage 与会话 transcript。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'whale_config',
    description:
      '查看或修改鲸鱼挂件配置。apiKey 仅用于可选的第三方厂商余额接口（WorkBuddy 默认不需要）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get 查看，set 修改' },
        apiKey: { type: 'string', description: 'DeepSeek API Key（sk- 开头），仅 set 时使用；可选' },
        usageMode: { type: 'string', enum: ['ledger', 'token'], description: '对账口径（大肥鱼记账 / 实时·令牌）' },
        port: { type: 'number', description: '挂件服务固定端口，改后需重启服务' },
        autoStartWidget: { type: 'boolean', description: `是否在 ${HOST_LABEL} 会话启动时自动拉起挂件服务` },
        autoStartOverlay: { type: 'boolean', description: '是否在会话启动时自动拉起桌面浮层（需已装 Electron 运行时）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]

// 积分口径的主查询：会话身份 + 上下文余量 + 今日积分 + 上一轮 credit。
function toolCredits() {
  const ctx = readContextUsage()
  const rec = usageRecords()
  const t = readLatestTurn()
  const lines = ['🐳 WorkBuddy 订阅积分']
  if (ctx.ok) {
    lines.push(
      '上下文：' + ctx.used.toLocaleString('en-US') + ' / ' + ctx.size.toLocaleString('en-US') +
        (ctx.pct != null ? '（已用 ' + ctx.pct + '%，余 ' + ctx.remaining.toLocaleString('en-US') + '）' : '')
    )
  } else {
    lines.push('上下文：读不到（' + (ctx.reason || 'unknown') + '）')
  }
  if (rec && rec.ok) {
    lines.push('今日积分：' + money(rec.today.credit, 'CREDIT') + '（' + rec.today.calls + ' 次模型调用）')
    lines.push('近 7 天：' + money(rec.days7.credit, 'CREDIT'))
  } else {
    lines.push('今日积分：读不到（' + ((rec && rec.reason) || 'unknown') + '）')
  }
  if (t.ok) {
    lines.push('上一轮：' + money(t.credit, 'CREDIT') + '（' + t.model + '，' + t.calls + ' 次调用）')
  }
  return { text: lines.join('\n') }
}

async function toolBalance() {
  const p = await getBalance()
  if (!p.ok) {
    const hint =
      p.code === 'NO_KEY'
        ? '\n\nWorkBuddy 默认没有用户自带的厂商凭据（模型由宿主托管）。想用余额卡就自己配一下：设置环境变量 DEEPSEEK_API_KEY，或用 whale_config 的 set 动作写入 apiKey。'
        : ''
    return {
      text: '🐳 余额获取失败：' + p.error + hint,
      isError: true,
    }
  }
  const lines = [
    '🐳 DeepSeek 余额（可选厂商卡）',
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
    clearClosePause() // 显式起浮层 = 用户要它回来
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
    clearClosePause() // 显式启动 = 用户要它回来（也顺手解除「本次关闭」的暂停）
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
    // 关闭插件 = 停浮层 + 停服务 + 留「本次关闭」标记（本线看门狗会每 15 秒补活，
    // 不拦它就会把刚关掉的挂件拉回来；标记活到下次宿主启动或挂件被别的路径拉起）
    writeClosePause()
    const ov = await stopOverlay()
    const r = await stopServer()
    if (!r.ok && (await findRunningServer())) {
      return { text: '关闭失败：服务未停止（' + r.error + '）', isError: true }
    }
    return {
      text:
        '🐳 插件已关闭：桌面浮层' +
        (ov.ok ? '与服务都已停止' : '未在运行，服务已停止') +
        '。本次关闭期间看门狗停手；下次启动 WorkBuddy 会照常拉起，想立刻回来：action=start。',
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
      text: '读不到每轮消耗数据（' + (t.reason || 'unknown') + '）。需要 WorkBuddy 已经完成过至少一轮对话。',
      isError: true,
    }
  }
  const n = (v) => Number(v).toLocaleString('en-US')
  // 套餐扣费轮的主显示与 cli.mjs cmdTurn 同口径：套餐观测到位时按「余额的百分比」
  // 表达，不按公开价目折算（那对套餐轮是虚构金额）；当前 turnPlanUsage 是占位
  // （恒 null），走 credit 分支——接通套餐观测后两处自动同口径。
  const planInfo = turnPlanUsage(t)
  const headline = planInfo && planInfo.pctOfTotal != null
    ? '套餐配额的 ' + planInfo.pctOfTotal + '%（' + n(planInfo.tokens) + ' tokens）'
    : money(t.credit, 'CREDIT') + (t.calls ? '（' + t.calls + ' 次模型调用）' : '')
  const lines = [
    '🐳 上一轮对话消耗：' + headline,
    '模型：' + (t.model || '未知') + (t.modelName ? '（' + t.modelName + '）' : '') + (t.vendorLabel ? ' · ' + t.vendorLabel : ''),
  ]
  if (t.marketAmount) lines.push('等价金额：≈ ' + money(t.marketAmount, t.marketCurrency, 4) + '（按公开价目折算，非真实扣费）')
  if (t.partial) lines.push('状态：该轮可能仍在进行/尚未结算（宿主还没写入 credit）')
  const rows = Array.isArray(t.models) ? t.models : []
  for (const m of rows) {
    const head = (rows.length > 1 ? '· ' : '') + (m.model || '未知模型') + '  ' + n(m.tokens) + ' tokens'
    lines.push(head + '  ' + money(m.credit, 'CREDIT', 4) + (m.calls ? ' × ' + m.calls : ''))
    const b = m.breakdown
    if (b) {
      lines.push('  缓存命中输入 ' + n(b.hit) + ' / 未命中输入 ' + n(b.miss) + (b.cacheWrite ? ' / 缓存写入 ' + n(b.cacheWrite) : '') + ' / 输出 ' + n(b.output))
    }
  }
  lines.push('总处理 token：' + n(t.tokens) + '（含每一步重复携带的上下文）')
  lines.push('数据来源：' + t.source)
  return { text: lines.join('\n') }
}

async function toolConfig(args) {
  const action = args && args.action
  if (action === 'set') {
    const patch = {}
    if (typeof args.apiKey === 'string' && args.apiKey.trim()) patch.apiKey = args.apiKey.trim()
    if (args.usageMode === 'ledger' || args.usageMode === 'token') {
      patch.usageMode = args.usageMode
      writeWidgetState({ usageMode: args.usageMode })
    }
    if (Number.isInteger(args.port) && args.port > 0 && args.port < 65536) patch.port = args.port
    if (typeof args.autoStartWidget === 'boolean') patch.autoStartWidget = args.autoStartWidget
    if (typeof args.autoStartOverlay === 'boolean') patch.autoStartOverlay = args.autoStartOverlay
    if (Object.keys(patch).length === 0) {
      return { text: '没有需要修改的字段。', isError: true }
    }
    writePluginConfig(patch)
    const changed = Object.keys(patch)
      .map((k) => (k === 'apiKey' ? 'apiKey（已写入，不显示明文）' : k + '=' + String(patch[k])))
      .join(', ')
    const note = patch.port ? '\n端口变更需要重启挂件服务（action=stop 再 start）。' : ''
    return { text: '已更新：' + changed + note }
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
    ].join('\n'),
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'whale_credits':
      return toolCredits()
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
    // 版本协商：客户端请求的版本若在我们支持的集合里就照它回，否则回自己支持的
    // 兜底版本（2026-10-14 审查 P2-G：此前无条件原样回显，等于声明支持任意版本）
    const supported = [PROTOCOL_FALLBACK, '2025-03-26', '2025-06-18']
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: supported.indexOf(String(requested || '')) !== -1 ? requested : PROTOCOL_FALLBACK,
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
    process.stderr.write('[fox-widget] ' + String((err && err.message) || err) + '\n')
  })
})
// 客户端关闭 stdin 就退出，否则进程会一直挂在事件循环里
rl.on('close', () => {
  chain.then(() => process.exit(0)).catch(() => process.exit(0))
})

process.stderr.write('[fox-widget] MCP server ready (' + SERVER_INFO.version + ')\n')
