// 绑定键：把「哪个窗口」编码成一个稳定字符串。
//
// 为什么不是标题：验证 3 里同一个进程的两个记事本窗口标题完全一样
// （"无标题 - Notepad"），标题随工作区/文件名变化，不能当身份。
//
// 键格式：exe|pid|startMs|hwnd
//   exe       规范化后的可执行文件路径（小写、正斜杠），区分不同安装位置的同名应用
//   pid       进程 id
//   startMs   进程启动时间（epoch ms）——pid 会被系统复用，必须带启动时间
//   hwnd      窗口句柄（小写十六进制，去掉 0x）
//
// 进程重启后 pid 可能复用、hwnd 也可能复用，但 startMs 不会重复；
// 单进程多窗口时 pid/startMs 相同、hwnd 不同——两个方向都能区分开。

export function normalizeExe(exe) {
  return String(exe == null ? '' : exe)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase()
}

export function normalizeHwnd(hwnd) {
  const s = String(hwnd == null ? '' : hwnd)
    .trim()
    .toLowerCase()
    .replace(/^0x/, '')
  return /^[0-9a-f]+$/.test(s) ? s : ''
}

export function buildBindKey(input) {
  const exe = normalizeExe(input && input.exe)
  const pid = Number(input && input.pid)
  const startMs = Number(input && input.startMs)
  const hwnd = normalizeHwnd(input && input.hwnd)
  if (!exe) throw new Error('bind key: exe required')
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('bind key: pid invalid')
  if (!Number.isFinite(startMs) || startMs <= 0) throw new Error('bind key: startMs invalid')
  if (!hwnd) throw new Error('bind key: hwnd invalid')
  return exe + '|' + pid + '|' + startMs + '|' + hwnd
}

export function parseBindKey(key) {
  const parts = String(key == null ? '' : key).split('|')
  // Windows 路径不允许 '|'，所以合法键固定 4 段
  if (parts.length !== 4) return null
  const exe = normalizeExe(parts[0])
  const pid = Number(parts[1])
  const startMs = Number(parts[2])
  const hwnd = normalizeHwnd(parts[3])
  if (!exe) return null
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (!Number.isFinite(startMs) || startMs <= 0) return null
  if (!hwnd) return null
  return { exe, pid, startMs, hwnd }
}

// 进程级键：hwnd 消失但进程还在时，用它兜底重绑
export function processKeyOf(key) {
  const p = typeof key === 'object' && key ? key : parseBindKey(key)
  if (!p) return ''
  const exe = normalizeExe(p.exe)
  const pid = Number(p.pid)
  const startMs = Number(p.startMs)
  if (!exe || !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startMs) || startMs <= 0) return ''
  return exe + '|' + pid + '|' + startMs
}

// 绑定键与一个进程描述是否指向同一进程（不看 hwnd）
export function sameProcess(key, proc) {
  const p = typeof key === 'string' ? parseBindKey(key) : key
  if (!p || !proc) return false
  return (
    normalizeExe(proc.exe) === normalizeExe(p.exe) &&
    Number(proc.pid) === Number(p.pid) &&
    Number(proc.startMs) === Number(p.startMs)
  )
}
