// ZCode 主界面「启动完成」判定：从客户端日志的就绪标记判断当前是否还在启动加载期。
//
// 背景（2026-10-01 实测）：ZCode 启动时主窗口很快就建出来了，但窗口里先是加载
// 动画，约 6 秒后主界面（启动页/任务列表）才真正就绪。浮层只跟随窗口矩形，
// 不知道这件事，于是鲸鱼在加载动画期间就冒了出来。这里用客户端自己写进日志的
// 启动标记做门控：
//   [startup] 创建主窗口 / [primary-window] creating main window (app-ready)
//     → 主窗口刚建好 = 还在加载
//   [database-startup] terminal {"status":"ready"} / window-controller.listTaskList OK
//     → 数据库与窗口控制器就绪 = 主界面开始加载内容，可以出鲸鱼了
//
// **标记必须归属到「当前这次启动」**：ZCode 每次启动都在同一天日志里追加，上一次
// 运行的「启动→就绪」序列原样躺在同一个文件里。只按位置取「最后一个 boot 标记 +
// 它后面有没有 ready 标记」，重开 ZCode 时就会把上一次的序列当成本次已就绪——
// 2026-10-01 实测：杀掉 ZCode 再启动，鲸鱼在加载动画里就出现了（截图实锤）。
// 归属依据是日志行里的 [pid:N]：主窗口与 [main] 日志同属 Electron 主进程，浮层
// 跟随脚本报上来的目标窗口 pid 正好可以拿来比对。拿不到 pid（非 Windows / 老版
// 跟随脚本）时退回旧口径：只看位置、不认归属。
//
// 标记取自 3.14.4 实测日志。为防将来标记改名导致永久不显示，调用方必须带
// 超时兜底（见 main.cjs：锚点时间超过 30 秒仍没有 ready 标记就放行）；
// 日志里根本没有启动标记、也没有进程身份信息（老版本/日志缺失）时一律放行。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 行首时间戳：日志主进程每行都带，用于把标记钉在时间轴上
const STAMP_RE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/
// 启动标记 / 就绪标记（与 3.14.4 实测日志逐字对齐）
const BOOT_LINE_RE = /\[(?:primary-window\] creating main window|startup\] 创建主窗口)/
const READY_LINE_RE = /\[database-startup\] terminal [^\n]*"status":"ready"|window-controller\.listTaskList OK/
// 行内第一个 [pid:N] 即主进程 pid（host-log 行后面还会带一层 host 进程的 pid，
// 那不属于主进程，不能取）
const PID_RE = /\[pid:(\d+)\]/
// 标记时间与「进程启动时间」之间允许的误差：两个时间都来自本机时钟，
// 正常只差毫秒级，留 1.5 秒给时钟/采样粒度。
const CLOCK_SKEW_MS = 1500
// 进程启动时间明显在未来 = 采样异常，直接忽略身份锚点（否则超时兜底永远不触发）
const FUTURE_SKEW_MS = 5000

function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(s)
  if (!m) return null
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])
  ).getTime()
}

// 逐行扫出全部启动/就绪标记，带上「行序号 + 行首时间 + 主进程 pid」。
// 行序号用于判断就绪标记是否出现在启动标记之后。
function scanMarkers(text) {
  const boot = []
  const ready = []
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isBoot = BOOT_LINE_RE.test(line)
    const isReady = READY_LINE_RE.test(line)
    if (!isBoot && !isReady) continue
    const st = STAMP_RE.exec(line)
    if (!st) continue
    const at = parseStamp(st[1])
    const pm = PID_RE.exec(line)
    const entry = { i, at, pid: pm ? Number(pm[1]) : 0 }
    if (isBoot) boot.push(entry)
    if (isReady) ready.push(entry)
  }
  return { boot, ready }
}

function result(state, bootAt, anchorAt, reason) {
  return { state, bootAt: bootAt || null, anchorAt: anchorAt || null, reason }
}

// 判定日志文本的最后一次启动状态。
// opts.pid           当前 ZCode 主进程 pid（浮层跟随脚本上报的目标窗口 pid）
// opts.processStartAt 该进程的启动时间（毫秒时间戳）
// 返回 { state:'ready'|'loading', bootAt, anchorAt, reason }
//   anchorAt = 本次加载从何时算起（超时兜底据此放行；拿不到任何时间则为 null）
function evaluateBootState(text, opts) {
  const pid = Number(opts && opts.pid) || 0
  let since = Number(opts && opts.processStartAt) || 0
  if (since && since > Date.now() + FUTURE_SKEW_MS) since = 0

  const { boot, ready } = scanMarkers(text)
  // 标记归属：pid 对得上（拿不到 pid 就不认归属）；时间上属于本次进程生命周期
  const own = (e) => {
    if (pid && e.pid !== pid) return false
    if (since && e.at && e.at < since - CLOCK_SKEW_MS) return false
    return true
  }

  let lastBoot = null
  for (const b of boot) if (own(b)) lastBoot = b

  if (!lastBoot) {
    // 本次启动的 boot 标记还没出现（进程刚起，或已刷出尾窗）：只要看到本次启动
    // 的就绪标记，就算就绪（重刷屏把 boot 标记挤出尾窗时靠这条放行）
    let readyOwn = null
    for (const e of ready) if (own(e)) readyOwn = e
    if (readyOwn) return result('ready', null, since || readyOwn.at, 'ready-marker')
    // 一条本次启动的标记都没有，但知道进程身份 → 还在加载（进程才刚起来）
    if (pid || since) return result('loading', null, since, 'no-own-marker')
    // 既没有标记也没有身份信息（老版本/日志缺失）→ 不拦
    return result('ready', null, null, 'no-marker')
  }

  let readyAfter = null
  for (const e of ready) if (own(e) && e.i > lastBoot.i) readyAfter = e
  if (readyAfter) return result('ready', lastBoot.at, lastBoot.at, 'ready-after-boot')
  return result('loading', lastBoot.at, Math.max(lastBoot.at || 0, since) || null, 'loading-after-boot')
}

// ZCode v2 数据目录候选（与 lib/paths.mjs 的 v2DataDirCandidates 同口径）：
// 迁移后进程内带 ZCODE_DATA_BASE_DIR，普通终端只能退回 ~/.zcode。
function logDirCandidates() {
  const dirs = []
  const base = String(process.env.ZCODE_DATA_BASE_DIR || '').trim()
  if (base) dirs.push(path.join(base, '.zcode', 'v2', 'logs'))
  const home = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
  dirs.push(path.join(home, 'v2', 'logs'))
  return dirs
}

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function yesterdayKey() {
  return todayKey(new Date(Date.now() - 86400000))
}

// 读最近一份客户端日志的尾部（只看尾窗，够找到最近一次启动的标记）。
// 返回 { text, file } 或 null。
function readNewestLogTail(maxBytes = 262144) {
  const want = Math.max(4096, Number(maxBytes) || 262144)
  let best = null
  for (const dir of logDirCandidates()) {
    for (const name of [todayKey(), yesterdayKey()]) {
      const file = path.join(dir, name + '.log')
      try {
        const st = fs.statSync(file)
        if (!best || st.mtimeMs > best.mtimeMs) best = { file, size: st.size, mtimeMs: st.mtimeMs }
      } catch (err) {}
    }
  }
  if (!best) return null
  try {
    const start = Math.max(0, best.size - want)
    const fd = fs.openSync(best.file, 'r')
    try {
      const buf = Buffer.alloc(best.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      return { text: buf.toString('utf8'), file: best.file }
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    return null
  }
}

module.exports = {
  evaluateBootState,
  logDirCandidates,
  readNewestLogTail,
  BOOT_LINE_RE,
  READY_LINE_RE,
}
