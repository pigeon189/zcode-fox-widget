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
// 标记取自 3.14.4 实测日志。为防将来标记改名导致永久不显示，调用方必须带
// 超时兜底（见 main.cjs：boot 标记超过 30 秒仍没有 ready 标记就放行）；
// 日志里根本没有 boot 标记（老版本/日志缺失）时也一律放行。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const BOOT_RE =
  /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\][^\n]*\[(?:primary-window\] creating main window|startup\] 创建主窗口)/
const READY_RE = /\[database-startup\] terminal [^\n]*"status":"ready"|window-controller\.listTaskList OK/

function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(s)
  if (!m) return null
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])
  ).getTime()
}

// 判定日志文本的最后一次启动状态。
// 返回 { state: 'ready'|'loading', bootAt: number|null }
function evaluateBootState(text) {
  const src = String(text || '')
  const gre = new RegExp(BOOT_RE.source, 'g')
  let last = null
  let m
  while ((m = gre.exec(src)) !== null) last = m
  if (!last) return { state: 'ready', bootAt: null } // 没有启动标记：不拦
  const after = src.slice(last.index)
  const bootAt = parseStamp(last[1])
  if (READY_RE.test(after)) return { state: 'ready', bootAt }
  return { state: 'loading', bootAt }
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

function yesterdayKey() {
  return todayKey(new Date(Date.now() - 86400000))
}

module.exports = { evaluateBootState, logDirCandidates, readNewestLogTail, BOOT_RE, READY_RE }
