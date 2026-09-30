// 命令行入口，供 /whale 命令、skill 与人工排查使用。
// 只读操作（status/turn/url/json）不会拉起服务；start/stop 才会动进程。
import { findApiKey, maskKey, readPluginConfig, writePluginConfig } from './credentials.mjs'
import { getBalance, readWidgetState } from './balance.mjs'
import { isPeakTime } from './pricing.mjs'
import { readLatestTurn } from './turn-cost.mjs'
import { listVendorStatus } from './vendors.mjs'
import { ensureServer, findRunningServer, stopServer, widgetUrl } from './service.mjs'
import { installRuntime, overlayStatus, startOverlay, stopOverlay, runtimePaths } from './overlay.mjs'

// 金额文本：币种必须由调用方给出。v1.2.0 起计价是多币种的（OpenAI/Claude 用
// USD），把 CNY 写死在调用点会让美元轮次显示成人民币金额（差约 7 倍）。
const CUR_SYMBOL = { CNY: '¥', USD: '$' }

function curSymbol(currency) {
  return CUR_SYMBOL[currency] || ''
}

function money(amount, currency, digits) {
  const n = Number(amount)
  const d = digits === undefined ? 2 : digits
  const fixed = isFinite(n) ? n.toFixed(d) : '--'
  const sym = curSymbol(currency)
  if (sym) return sym + ' ' + fixed
  // 未知/缺失币种：无符号时退化为原样人民币口径，未知币种显式标出
  return !currency || currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency
}

function todayLabel() {
  return new Date().toLocaleDateString('zh-CN')
}

async function cmdStatus() {
  const payload = await getBalance()
  const cfg = readPluginConfig()
  const ws = readWidgetState()
  const running = await findRunningServer()
  const overlay = await overlayStatus()
  const key = findApiKey()

  if (payload.ok) {
    console.log('   🐳  DeepSeek 余额小鲸鱼 · ZCode')
    console.log('   ──────────────────────────────')
    console.log('   余额       ' + money(payload.totalBalance, payload.currency))
    console.log(
      '   今日已用   ' + money(payload.todayUsage, payload.currency) +
        (payload.usageMode === 'token' ? '  (实时·令牌)' : '  (小鲸鱼记账)')
    )
    console.log('   当前时段   ' + (payload.isPeak ? '高峰时段' : '空闲时段') + '（' + todayLabel() + '）')
    if (payload.stale) console.log('   提示       本次为缓存值，接口暂时不可用：' + payload.error)
  } else {
    console.log('   🐳  DeepSeek 余额小鲸鱼 · ZCode')
    console.log('   ──────────────────────────────')
    console.log('   余额       获取失败')
    console.log('   原因       ' + payload.error)
    if (payload.code === 'NO_KEY') {
      console.log('')
      console.log('   配置方式（任选其一）：')
      console.log('     1. 在 ZCode 里添加 DeepSeek provider（baseURL 指向 api.deepseek.com）')
      console.log('     2. 设置环境变量 DEEPSEEK_API_KEY=sk-...')
      console.log('     3. node lib/cli.mjs key sk-...')
    }
  }
  console.log('   ──────────────────────────────')
  console.log(
    '   挂件       ' +
      (running ? widgetUrl(running.port) + '  (运行中 pid ' + (running.health && running.health.pid) + ')' : '未运行（node lib/cli.mjs start 启动）')
  )
  console.log(
    '   桌面浮层   ' +
      (overlay.running
        ? '运行中（pid ' + overlay.pid + '）'
        : overlay.installed
          ? '未运行（node lib/cli.mjs window start 启动）'
          : '未运行 · Electron 运行时未安装（node lib/cli.mjs desktop install）')
  )
  console.log('   用量模式   ' + (ws.usageMode === 'token' ? '实时·令牌' : '小鲸鱼记账'))
  console.log(
    '   凭据       ' + (key.key ? maskKey(key.key) + '  (' + key.source + ')' : '未配置')
  )
  if (cfg.port) console.log('   固定端口   ' + cfg.port)
  return 0
}

async function cmdTurn() {
  const t = readLatestTurn()
  if (!t.ok) {
    console.log('   读不到每轮消耗数据：' + (t.reason || 'unknown'))
    return 1
  }
  const thousands = (n) => Number(n).toLocaleString('en-US')
  console.log('   上一轮对话消耗   ' + (t.billable ? money(t.amount, t.currency) : '不可计价（仅统计 tokens）'))
  console.log(
    '   模型             ' +
      (t.model || '未知') +
      (t.providerId ? '  [' + t.providerId + ']' : '') +
      (t.vendorLabel ? '  (' + t.vendorLabel + ')' : '')
  )
  if (t.peak) console.log('   计价时段         高峰（DeepSeek 峰谷价）')
  const rows = Array.isArray(t.models) ? t.models : []
  if (rows.length > 1) console.log('   逐模型明细       共 ' + rows.length + ' 行')
  for (const m of rows) {
    const label =
      '   ' + (rows.length > 1 ? '· ' : '') + (m.model || '未知模型') + '  ' + thousands(m.tokens) + ' tokens'
    if (!m.billable) {
      console.log(label + (rows.length > 1 ? '  （' + (m.vendorLabel || '不可计价') + '）' : ''))
      continue
    }
    console.log(label + ' = ' + money(m.amount, m.currency, 4) + (m.peak ? '（高峰）' : ''))
    printBreakdown(m)
  }
  console.log('   总 token         ' + thousands(t.tokens))
  console.log('   数据来源         ' + t.source)
  return 0
}

function printBreakdown(m) {
  const b = m.breakdown
  const r = m.rates
  if (!b || !r) return
  const thousands = (n) => Number(n).toLocaleString('en-US')
  const pad = (s, w) => (s + ' '.repeat(Math.max(0, w - s.length)))
  const sym = curSymbol(m.currency) || '¥'
  const line = (label, tokens, rate) => {
    console.log(
      '     ' + pad(label, 8) + thousands(tokens) + ' tokens × ' + sym + rate + '/M = ' + sym +
        ((tokens / 1e6) * rate).toFixed(4)
    )
  }
  line('缓存命中输入', b.hit, r.hit)
  line('未命中输入', b.miss, r.miss)
  if (b.cacheWrite) line('缓存写入', b.cacheWrite, r.miss)
  line('输出', b.output, r.out)
}

async function cmdWindow(argv) {
  const action = argv[0] || 'status'
  if (action === 'start') {
    const r = await startOverlay()
    if (r.running) {
      console.log('🐳 桌面浮层已就绪（pid ' + r.pid + '）—— 鲸鱼浮在桌面上，只在指针压到它时才接管鼠标')
      console.log('   关掉：node lib/cli.mjs window stop')
      return 0
    }
    console.log('桌面浮层启动失败：' + (r.error || '未知原因'))
    if (r.hint) console.log('   ' + r.hint)
    return 1
  }
  if (action === 'stop') {
    const r = await stopOverlay()
    console.log(r.ok ? '🐳 桌面浮层已关闭' : '关闭失败：' + r.error)
    return r.ok ? 0 : 1
  }
  if (action === 'restart') {
    // 画面冻结（页面活着但停在旧帧，见 main.cjs 的 kickPresentation）的一键
    // 恢复：重建窗口 = 新的合成视觉；也用于改动窗口参数后快速生效
    await stopOverlay()
    console.log('🐳 桌面浮层已关闭')
    return cmdWindow(['start'])
  }
  const s = await overlayStatus()
  console.log('桌面浮层：' + (s.running ? '运行中（pid ' + s.pid + '）' : '未运行'))
  console.log('Electron 运行时：' + (s.installed ? '已安装 ' + runtimePaths().electronExe : '未安装（node lib/cli.mjs desktop install）'))
  return 0
}

async function cmdDesktopInstall() {
  console.log('正在安装 Electron 运行时到 ' + runtimePaths().runtimeDir + ' …')
  console.log('（约 150MB，一次性；之后桌面浮层直接可用）')
  const r = await installRuntime()
  if (r.ok) {
    console.log('✅ 安装完成：' + r.electronExe)
    console.log('   现在可以运行：node lib/cli.mjs window start')
    return 0
  }
  console.log('❌ 安装失败于「' + r.step + '」')
  console.log(String(r.output || '').trim())
  return 1
}

async function cmdStart() {
  const r = await ensureServer()
  if (r.running) {
    console.log('🐳 挂件已就绪：' + widgetUrl(r.port) + (r.started ? '（本次新启动）' : '（复用已在运行的服务）'))
    return 0
  }
  console.log('挂件服务启动失败：' + (r.error || '未知原因'))
  return 1
}

async function cmdStop() {
  const r = await stopServer()
  console.log(r.ok ? '🐳 挂件服务已停止' : '停止失败：' + r.error)
  return r.ok ? 0 : 1
}

function cmdKey(argv) {
  const key = argv[0]
  if (!key) {
    console.log('用法：node lib/cli.mjs key sk-xxxxxxxx')
    return 1
  }
  if (!/^sk-/.test(key)) {
    console.log('看起来不像 DeepSeek API Key（应以 sk- 开头），仍已写入。')
  }
  writePluginConfig({ apiKey: key })
  console.log('已写入插件配置：' + maskKey(key) + '（' + readPluginConfig().apiKey.length + ' 字符）')
  return 0
}

function cmdMode(argv) {
  const mode = argv[0] === 'token' ? 'token' : argv[0] === 'ledger' ? 'ledger' : null
  if (!mode) {
    console.log('用法：node lib/cli.mjs mode ledger|token')
    return 1
  }
  writePluginConfig({ usageMode: mode })
  console.log('用量模式已切换为：' + (mode === 'token' ? '实时·令牌' : '小鲸鱼记账'))
  return 0
}

async function cmdJson() {
  const payload = await getBalance()
  const running = await findRunningServer()
  const key = findApiKey()
  console.log(
    JSON.stringify(
      {
        ok: payload.ok,
        totalBalance: payload.totalBalance,
        currency: payload.currency,
        todayUsage: payload.todayUsage,
        usageMode: payload.usageMode,
        isPeak: payload.isPeak,
        error: payload.error,
        stale: payload.stale || false,
        widget: running ? { running: true, url: widgetUrl(running.port), port: running.port } : { running: false },
        credential: { source: key.source, masked: maskKey(key.key) },
        now: new Date().toISOString(),
        peakNow: isPeakTime(Math.floor(Date.now() / 1000)),
      },
      null,
      2
    )
  )
  return 0
}

async function cmdVendors() {
  const { ok, vendors, reason } = await listVendorStatus(false)
  if (!ok) {
    console.log('厂商状态读取失败：' + reason)
    return 1
  }
  for (const v of vendors) {
    let line = '  ' + v.name.padEnd(20, ' ') + '[' + v.kind + '] '
    if (v.kind === 'balance') {
      line += v.available
        ? '余额 ' + (Number.isFinite(v.balance) ? v.balance.toFixed(2) : '--') + ' ' + v.currency + (v.stale ? '（stale）' : '')
        : '不可用：' + (v.reason || '未知')
    } else if (v.kind === 'local-log') {
      line += v.available
        ? '剩余 ' + (v.percentRemaining != null ? (v.percentRemaining * 100).toFixed(1) + '%' : '--') + (v.stale ? '（stale）' : '')
        : '不可用：' + (v.reason || '未知')
    } else if (v.kind === 'quota') {
      line += v.available
        ? (v.windows || []).map((w) => w.label + ' 已用 ' + (w.percentUsed != null ? w.percentUsed.toFixed(1) + '%' : '--')).join(' / ') || '无窗口数据'
        : '不可用：' + (v.reason || '未知')
    } else {
      line += v.available ? '就绪（' + (v.keySource || '无凭据') + '）' : '不可用：' + (v.reason || '未知')
    }
    if (v.keySource && v.kind !== 'tokens') line += '  {' + v.keySource + '}'
    console.log(line)
  }
  return 0
}

const [cmd, ...rest] = process.argv.slice(2)
const commands = {
  status: cmdStatus,
  turn: cmdTurn,
  start: cmdStart,
  stop: cmdStop,
  key: () => cmdKey(rest),
  mode: () => cmdMode(rest),
  json: cmdJson,
  vendors: cmdVendors,
  window: () => cmdWindow(rest),
  desktop: cmdDesktopInstall,
  url: async () => {
    const running = await findRunningServer()
    console.log(running ? widgetUrl(running.port) : '')
    return running ? 0 : 1
  },
}

const run = commands[cmd] || cmdStatus
run()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error('执行失败：' + String((err && err.message) || err))
    process.exit(1)
  })
