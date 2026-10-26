// 命令行入口，供 /whale 命令、skill 与人工排查使用。
// 只读操作（status/turn/url/json）不会拉起服务；start/stop 才会动进程。
import { findApiKey, maskKey, readPluginConfig, writePluginConfig } from './credentials.mjs'
import { getBalance, readWidgetState } from './balance.mjs'
import { isPeakTime } from './pricing.mjs'
import { readLatestTurn } from './turn-cost.mjs'
import { turnPlanUsage } from './plan-balance.mjs'
import { listVendorStatus } from './vendors.mjs'
import { listZcodeProviders } from './discover.mjs'
import { resolveBillingSource } from './source.mjs'
import { ensureServer, findRunningServer, stopServer, widgetUrl } from './service.mjs'
import { installRuntime, overlayStatus, startOverlay, stopOverlay, runtimePaths } from './overlay.mjs'
import { installWatch, startWatcher, stopWatcher, uninstallWatch, watchStatus, persistRuntimeEnv, watchScript } from './watch-install.mjs'
import { migrationPreflight, probeMigrationOffer } from './migrate.mjs'
import { spawnSync } from 'node:child_process'

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
    console.log('   🐳  ZCode狐娘小挂件')
    console.log('   ──────────────────────────────')
    console.log('   余额       ' + money(payload.totalBalance, payload.currency))
    // 今日已用主口径固定本机库；账号口径（大肥鱼记账/实时·令牌）做对账与兜底，
    // 两个数字不一致时把另一个也列出来（含其它设备的花费只有账号口径看得到）
    const srcLabel =
      payload.todayUsageSource === 'db'
        ? '本机库'
        : payload.todayUsageSource === 'token'
          ? '实时·令牌'
          : '大肥鱼记账'
    const cross = payload.todayUsageSource === 'db' ? payload.accountUsage : payload.todayUsageDb
    const crossName = payload.todayUsageSource === 'db' ? '账号' : '本机'
    const crossText =
      typeof cross === 'number' && Math.abs(cross - Number(payload.todayUsage)) > 0.005
        ? '  ' + crossName + ' ' + money(cross, payload.currency)
        : ''
    console.log('   今日已用   ' + money(payload.todayUsage, payload.currency) + '  (' + srcLabel + ')' + crossText)
    console.log('   当前时段   ' + (payload.isPeak ? '高峰时段' : '空闲时段') + '（' + todayLabel() + '）')
    if (payload.stale) console.log('   提示       本次为缓存值，接口暂时不可用：' + payload.error)
  } else {
    console.log('   🐳  ZCode狐娘小挂件')
    console.log('   ──────────────────────────────')
    console.log('   余额       获取失败')
    console.log('   原因       ' + payload.error)
    if (payload.code === 'NO_KEY') {
      console.log('')
      console.log('   配置方式（任选其一）：')
      console.log('     1. 在 ZCode 里添加 DeepSeek provider（baseURL 指向 api.deepseek.com）')
      console.log('     2. 设置环境变量 DEEPSEEK_API_KEY=sk-...')
      console.log('     3. echo <sk-...> | node lib/cli.mjs key  （密钥走 stdin，不留命令行痕迹）')
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
  console.log('   对账口径   ' + (ws.usageMode === 'token' ? '实时·令牌' : '大肥鱼记账'))
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
  // 套餐扣费轮（Start plan 等）按量价目算出的金额是虚构的：改按「余额的百分比」
  // 表达（与 /whale/plan.json 的「Plan 剩余 x%」同基数）；混合轮次另附非套餐行金额
  const planInfo = turnPlanUsage(t)
  let headline
  if (planInfo && planInfo.pctOfTotal != null) {
    headline = '套餐配额的 ' + planInfo.pctOfTotal + '%（' + thousands(planInfo.tokens) + ' tokens）'
    if (planInfo.extraAmounts) {
      const extra = Object.keys(planInfo.extraAmounts)
        .map((c) => money(planInfo.extraAmounts[c], c))
        .join(' + ')
      headline += '，另耗其他源 ' + extra
    }
  } else if (planInfo) {
    headline = '套餐轮次（无配额观测，仅 ' + thousands(planInfo.tokens) + ' tokens）'
  } else {
    headline = t.billable ? money(t.amount, t.currency) : '不可计价（仅统计 tokens）'
  }
  console.log('   上一轮对话消耗   ' + headline)
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
  // 缓存写入单价是 rates.cw（写入价 ≠ 未命中价，OpenAI/Qwen 等两者不同；
  // 用 r.miss 会让这行的单价与小计都错、各行相加对不上总额）
  if (b.cacheWrite) line('缓存写入', b.cacheWrite, r.cw)
  line('输出', b.output, r.out)
}

async function cmdWatch(argv) {
  const action = argv[0] || 'status'
  if (action === 'install') {
    persistRuntimeEnv()
    const i = installWatch()
    const w = startWatcher()
    console.log(JSON.stringify({ install: i, watcher: w, status: watchStatus() }, null, 2))
    return i.ok ? 0 : 1
  }
  if (action === 'uninstall') {
    console.log(JSON.stringify(uninstallWatch(), null, 2))
    return 0
  }
  if (action === 'stop') {
    console.log(JSON.stringify(stopWatcher(), null, 2))
    return 0
  }
  if (action === 'once') {
    // 让看门脚本自己走完整探测 + 幂等启动，CLI 只负责转交
    const r = spawnSync(process.execPath, [watchScript(), '--once'], { stdio: 'inherit', windowsHide: true })
    return r.status || 0
  }
  console.log(JSON.stringify(watchStatus(), null, 2))
  return 0
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

// 关闭插件（菜单里「关闭插件」的命令行等价入口，也是它的后台执行者）：停浮层 →
// 停服务。**只是把当前这一份停掉**，不写任何「别再自启」的标记——下次会话启动
// （SessionStart 钩子）或收到提问（UserPromptSubmit 兜底）时照常拉起，与手动
// 关掉窗口的语义一致。
async function cmdClose() {
  const ov = await stopOverlay()
  if (ov.ok) console.log('🐳 桌面浮层已关闭')
  const stopCode = await cmdStop()
  console.log('本次已关闭；下次会话启动时会照常拉起，想立刻回来：node lib/cli.mjs start')
  // 「本来就没在跑」不算失败（关闭的前置条件本就可以是「没跑」）
  if (stopCode === 0) return 0
  return (await findRunningServer()) ? 1 : 0
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
    await stopOverlay()
    await cmdWindow(['start'])
  }
  return 0
}

// 迁移预检（fox-dock 2.0，MIGRATE-TO-FOX-DOCK-2.md §4-2）：只读，绝不写任何文件。
// 非零退出码仅表示「检查项失败」，不表示迁移失败——迁移本身还没有发生。
async function cmdMigrate(argv) {
  if (argv[0] !== '--check') {
    console.log('用法：node lib/cli.mjs migrate --check   （只读预检，输出 JSON）')
    console.log('      检查项：config 键名 / 凭据数量（只报数量）/ dock 在线性 / 数据体积 / 启动项 / 上次更新状态')
    return argv.length ? 1 : 1
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
  turn: cmdTurn,
  start: cmdStart,
  stop: cmdStop,
  'restart-all': cmdRestartAll,
  close: cmdClose,
  key: () => cmdKey(rest),
  mode: () => cmdMode(rest),
  json: cmdJson,
  vendors: cmdVendors,
  // 只列选择计费声明所需的字段，不输出发现条目中的 API key。
  providers: async () => {
    console.log(JSON.stringify(listZcodeProviders().map((p) => ({
      providerId: p.providerId,
      source: resolveBillingSource(p.providerId, '', p.baseUrl).source,
    })), null, 2))
    return 0
  },
  window: () => cmdWindow(rest),
  watch: () => cmdWatch(rest),
  desktop: cmdDesktopInstall,
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

