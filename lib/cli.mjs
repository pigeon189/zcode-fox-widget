// 命令行入口，供 /whale 命令、skill 与人工排查使用。
// 只读操作（status/turn/url/json）不会拉起服务；start/stop 才会动进程。
import { findApiKey, maskKey, readPluginConfig, writePluginConfig } from './credentials.mjs'
import { getBalance, readWidgetState } from './balance.mjs'
import { isPeakTime } from './pricing.mjs'
import { readLatestTurn, readContextUsage } from './turn-cost.mjs'
import { usageRecords } from './usage-records.mjs'
import { turnPlanUsage } from './plan-balance.mjs'
import { listVendorStatus } from './vendors.mjs'
import { clearClosePause, ensureServer, findRunningServer, stopServer, widgetUrl, writeClosePause } from './service.mjs'
import { installRuntime, overlayStatus, startOverlay, stopOverlay, runtimePaths } from './overlay.mjs'
import {
  cmdWatchdogInstall,
  cmdWatchdogUninstall,
  cmdWatchdogStatus,
  cmdWatchdogRun,
} from './watchdog-cli.mjs'
import { migrationPreflight, probeMigrationOffer } from './migrate.mjs'

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
  // 'CREDIT' 是本挂件的积分口径标记（WorkBuddy 主口径），不加货币符号
  if (currency === 'CREDIT') return fixed + ' 积分'
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
  const ctx = readContextUsage()
  const rec = usageRecords()

  console.log('   🐳  WorkBuddy狐娘小挂件')
  console.log('   ──────────────────────────────')
  // 主口径：订阅积分（WorkBuddy 是订阅制，模型由宿主托管）
  if (rec && rec.ok) {
    console.log('   今日积分   ' + money(rec.today.credit, 'CREDIT') + '  （' + rec.today.calls + ' 次模型调用）')
    console.log('   近 7 天    ' + money(rec.days7.credit, 'CREDIT'))
  } else {
    console.log('   今日积分   读不到（' + ((rec && rec.reason) || 'unknown') + '）')
  }
  if (ctx.ok) {
    console.log(
      '   上下文     ' + ctx.used.toLocaleString('en-US') + ' / ' + ctx.size.toLocaleString('en-US') +
        (ctx.pct != null ? '（已用 ' + ctx.pct + '%）' : '')
    )
  } else {
    console.log('   上下文     读不到（' + (ctx.reason || 'unknown') + '）')
  }
  // 可选厂商余额卡（需要用户自己配 key；WorkBuddy 默认没有）
  if (payload.ok) {
    console.log('   余额(可选) ' + money(payload.totalBalance, payload.currency) + '  DeepSeek')
  } else {
    console.log('   余额(可选) 未配置或不可用：' + payload.error)
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
  console.log('   对账口径   ' + (ws.usageMode === 'token' ? '实时·令牌' : '大肥鱼记账'))
  if (cfg.port) console.log('   固定端口   ' + cfg.port)
  return 0
}

// 上一轮消耗（积分主口径 + 等价金额附注）
async function cmdTurn() {
  const t = readLatestTurn()
  if (!t.ok) {
    console.log('   读不到每轮消耗数据：' + (t.reason || 'unknown'))
    return 1
  }
  const thousands = (n) => Number(n).toLocaleString('en-US')
  const planInfo = turnPlanUsage(t)
  let headline
  if (planInfo && planInfo.pctOfTotal != null) {
    headline = '套餐配额的 ' + planInfo.pctOfTotal + '%（' + thousands(planInfo.tokens) + ' tokens）'
  } else {
    headline = money(t.credit, 'CREDIT') + (t.calls ? '（' + t.calls + ' 次模型调用）' : '')
  }
  console.log('   上一轮对话消耗   ' + headline)
  console.log(
    '   模型             ' +
      (t.model || '未知') +
      (t.modelName ? '  ' + t.modelName : '') +
      (t.vendorLabel ? '  (' + t.vendorLabel + ')' : '')
  )
  if (t.marketAmount) {
    console.log('   等价金额         ≈ ' + money(t.marketAmount, t.marketCurrency, 4) + '  （按公开价目折算，非真实扣费）')
  }
  if (t.partial) console.log('   状态             该轮可能仍在进行/宿主尚未结算')
  const rows = Array.isArray(t.models) ? t.models : []
  if (rows.length > 1) console.log('   逐模型明细       共 ' + rows.length + ' 行')
  for (const m of rows) {
    const label =
      '   ' + (rows.length > 1 ? '· ' : '') + (m.model || '未知模型') + '  ' + thousands(m.tokens) + ' tokens'
    console.log(label + '  ' + money(m.credit, 'CREDIT', 4) + (m.calls ? ' × ' + m.calls : ''))
    printBreakdown(m)
  }
  console.log('   总处理 token     ' + thousands(t.tokens) + '  （含每一步重复携带的上下文）')
  console.log('   数据来源         ' + t.source)
  return 0
}

// 有价目表时打印分档明细；WorkBuddy 的积分口径没有单价，只有 token 分桶
function printBreakdown(m) {
  const b = m.breakdown
  if (!b) return
  const thousands = (n) => Number(n).toLocaleString('en-US')
  const pad = (s, w) => (s + ' '.repeat(Math.max(0, w - s.length)))
  const r = m.rates
  const sym = curSymbol(m.currency) || '¥'
  if (!r) {
    console.log('     ' + pad('缓存命中输入', 12) + thousands(b.hit) + ' tokens')
    console.log('     ' + pad('未命中输入', 12) + thousands(b.miss) + ' tokens')
    if (b.cacheWrite) console.log('     ' + pad('缓存写入', 12) + thousands(b.cacheWrite) + ' tokens')
    console.log('     ' + pad('输出', 12) + thousands(b.output) + ' tokens')
    return
  }
  const line = (label, tokens, rate) => {
    console.log(
      '     ' + pad(label, 8) + thousands(tokens) + ' tokens × ' + sym + rate + '/M = ' + sym +
        ((tokens / 1e6) * rate).toFixed(4)
    )
  }
  line('缓存命中输入', b.hit, r.hit)
  line('未命中输入', b.miss, r.miss)
  // 缓存写入单价是 rates.cw（写入价 ≠ 未命中价，OpenAI/Qwen 等两者不同；
  // 用 r.miss 会让这行的单价与小计都错、各行相加对不上总额）
  if (b.cacheWrite) line('缓存写入', b.cacheWrite, r.cw)
  line('输出', b.output, r.out)
}

async function cmdWindow(argv) {
  const action = argv[0] || 'status'
  if (action === 'start') {
    clearClosePause() // 显式起浮层 = 用户要它回来
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
    const s = await stopOverlay()
    if (!s.ok) {
      // **收不掉就绝不起新的**：旧实例还在时起新实例，两个 Electron 抢同一个
      // user-data-dir（GPUCache 文件锁）会把正在用的浮层一起弄坏（2026-10-14
      // 真机实测：旧浮层留下「主进程活着、页面空白」的僵尸态，桌面上什么都看不到）
      console.log('❌ 未能关闭现有浮层：' + s.error)
      console.log('   已中止（不起新实例，避免把正在用的浮层弄坏）')
      return 1
    }
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
    // 顺手装看门狗：想用桌面浮层的人本来就跑这条命令，等于零额外步骤。
    // WorkBuddy 启动应用时不触发任何插件钩子（详见 lib/watchdog.mjs 头注释），
    // 没有看门狗就会出现「启动客户端后一动不动 = 桌面上没有挂件」。
    // 不想要自启：node lib/cli.mjs watchdog uninstall
    if (process.platform === 'win32') {
      console.log('')
      console.log('顺手安装看门狗（让挂件随 WorkBuddy 启动就位；只需一次，可随时卸载）…')
      cmdWatchdogInstall()
    }
    console.log('   现在可以运行：node lib/cli.mjs window start')
    return 0
  }
  console.log('❌ 安装失败于「' + r.step + '」')
  console.log(String(r.output || '').trim())
  return 1
}

async function cmdStart() {
  clearClosePause() // 显式启动 = 用户要它回来（也顺手解除「本次关闭」的暂停）
  const r = await ensureServer()
  if (r.running) {
    console.log('🐳 挂件已就绪：' + widgetUrl(r.port) + (r.started ? '（本次新启动）' : '（复用已在运行的服务）'))
    return 0
  }
  console.log('挂件服务启动失败：' + (r.error || '未知原因'))
  return 1
}

// 关闭插件（菜单里「关闭插件」的命令行等价入口，也是它的后台执行者）：停浮层 →
// 停服务，并留一个「本次关闭」标记——本线的看门狗会常暖服务、每 15 秒补活，不拦
// 它就会把刚关掉的挂件拉回来（见 watchdog.mjs 的 honorClosePause）。标记只活到
// 下次宿主启动、或挂件被别的路径（钩子 / 显式启动）拉回来，所以是「本次关闭」，
// 不是「以后都别自启」。
async function cmdClose() {
  writeClosePause()
  const ov = await stopOverlay()
  if (ov.ok) console.log('🐳 桌面浮层已关闭')
  const stopCode = await cmdStop()
  console.log('本次已关闭（看门狗本次停手）；下次启动 WorkBuddy 会照常拉起，想立刻回来：node lib/cli.mjs start')
  // 「本来就没在跑」不算失败（关闭的前置条件本就可以是「没跑」）
  if (stopCode === 0) return 0
  return (await findRunningServer()) ? 1 : 0
}

async function cmdStop() {
  const r = await stopServer()
  console.log(r.ok ? '🐳 挂件服务已停止' : '停止失败：' + r.error)
  return r.ok ? 0 : 1
}

// 从 stdin 读一整行（非交互环境）。密钥走命令行参数会留在 shell 历史、进程列表
//（Get-CimInstance Win32_Process 任何本机进程可读）与会话记录里，所以默认从
// stdin 读：`node lib/cli.mjs key` 或 `node lib/cli.mjs key -`（审查 X1）。
function readStdinText() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let data = ''
    try {
      process.stdin.setEncoding('utf8')
    } catch (err) {}
    process.stdin.on('data', (c) => {
      data += c
    })
    process.stdin.on('end', () => resolve(String(data).trim()))
    process.stdin.on('error', () => resolve(String(data).trim()))
  })
}

async function cmdKey(argv) {
  let key = String(argv[0] || '').trim()
  if (!key || key === '-') key = String(await readStdinText()).trim()
  if (!key) {
    console.log('用法：echo <sk-...> | node lib/cli.mjs key   （推荐，密钥不进 shell 历史/进程列表）')
    console.log('      node lib/cli.mjs key           从 stdin 读一行')
    console.log('      node lib/cli.mjs key sk-xxx    直接给参数（会留在 shell 历史里，不推荐）')
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
  console.log('对账口径已切换为：' + (mode === 'token' ? '实时·令牌' : '大肥鱼记账'))
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

// 更新完成后的整体重启：停服务 → 起服务 → 重建桌面浮层窗口。
// 由 lib/update.mjs 以 detached 子进程方式调用（停自己不能把重启流程一起带走）。
async function cmdRestartAll() {
  const stopCode = await cmdStop()
  // 「本来就没在跑」不算故障（重启的前置条件本就可以是「没跑」）；但「停不掉」
  // 必须停下来说清楚——否则紧接着的 start 会探到还没退干净的旧进程，误判为
  // 「复用已在运行的服务」，最后落得一个服务都没有
  if (stopCode !== 0 && (await findRunningServer())) {
    console.log('❌ 旧服务未能在超时内停止，已放弃重启（避免新旧进程抢同一端口）')
    return 1
  }
  const startCode = await cmdStart()
  if (startCode !== 0) return startCode
  if ((await overlayStatus()).running) {
    const s = await stopOverlay()
    if (!s.ok) {
      // 同 cmdWindow restart：收不掉就别起第二个（会抢 user-data-dir 弄坏正在用的那个）
      console.log('❌ 现有浮层未能关闭，已跳过浮层重启：' + s.error)
      return 0
    }
    await cmdWindow(['start'])
  }
  return 0
}

// 看门狗：让挂件随 WorkBuddy 应用启动而出现（不再依赖回退对话/发消息这类
// 会话动作——应用启动本身不触发任何插件钩子，见 lib/watchdog.mjs 头注释）。
async function cmdWatchdog(argv) {
  const action = argv[0] || 'status'
  if (action === 'install') return cmdWatchdogInstall()
  if (action === 'uninstall') return cmdWatchdogUninstall()
  if (action === 'run') return cmdWatchdogRun()
  if (action !== 'status') {
    console.log('用法：node lib/cli.mjs watchdog install|uninstall|status|run')
    return 1
  }
  return cmdWatchdogStatus()
}

// 迁移预检（fox-dock 2.0，MIGRATE-TO-FOX-DOCK-2.md §4-2）：只读，绝不写任何文件。
// 非零退出码仅表示「检查项失败」，不表示迁移失败——迁移本身还没有发生。
async function cmdMigrate(argv) {
  if (argv[0] !== '--check') {
    console.log('用法：node lib/cli.mjs migrate --check   （只读预检，输出 JSON）')
    console.log('      检查项：config 键名 / 凭据数量（只报数量）/ dock 在线性 / 数据体积 / 启动项 / 上次更新状态')
    return 1
  }
  const pre = await migrationPreflight({})
  console.log(JSON.stringify(pre, null, 2))
  if (!pre.ok) {
    const failed = Object.keys(pre.checks).filter((k) => !pre.checks[k])
    console.error('未通过的检查项：' + failed.join('、'))
    return 1
  }
  return 0
}

// 一次性迁移探测（隐藏命令，供 SessionStart 的 detached 子进程调用）：只读远端
// plugin.json 的 migration 块，8s 预算、24h 节流、失败静默；不做任何下载或替换。
async function cmdMigrateProbe() {
  const r = await probeMigrationOffer({})
  console.log(JSON.stringify(r, null, 2))
  return 0
}

const [cmd, ...rest] = process.argv.slice(2)
const commands = {
  status: cmdStatus,
  // credits 与 status 同义：WorkBuddy 的主口径就是积分，命令名直说更清楚
  credits: cmdStatus,
  turn: cmdTurn,
  start: cmdStart,
  stop: cmdStop,
  'restart-all': cmdRestartAll,
  close: cmdClose,
  key: () => cmdKey(rest),
  mode: () => cmdMode(rest),
  json: cmdJson,
  vendors: cmdVendors,
  window: () => cmdWindow(rest),
  desktop: cmdDesktopInstall,
  watchdog: () => cmdWatchdog(rest),
  migrate: () => cmdMigrate(rest),
  'migrate-probe': () => cmdMigrateProbe(),
  url: async () => {
    const running = await findRunningServer()
    console.log(running ? widgetUrl(running.port) : '')
    return running ? 0 : 1
  },
}

// 直接 `commands[cmd]` 会顺着原型链取到 'constructor' / 'toString' 这类属性，
// 结果拿到一个非 Promise 值，`.then` 在顶层抛 TypeError（`node lib/cli.mjs
// constructor` 即可复现，审查 S4）。只认自有属性，且必须是函数。
const own = Object.prototype.hasOwnProperty.call(commands, cmd) ? commands[cmd] : null
const run = typeof own === 'function' ? own : cmdStatus
run()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error('执行失败：' + String((err && err.message) || err))
    process.exit(1)
  })
