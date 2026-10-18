// 浮层渲染层（R3）：拖拽 → 命中宿主窗口 → 绑定 → 吸附到窗口右上角。
//
// 穿透策略：默认整窗穿透，只有指针压在狐狸上时打开交互（Windows 上
// setIgnoreMouseEvents(true, {forward:true}) 会继续转发 mousemove，所以能用坐标
// 判定 hover，而不用依赖 e.target）。

const params = new URLSearchParams(location.search)
const PORT = Number(params.get('port') || 0)
const SELF_PID = Number(params.get('pid') || 0)
const IGNORE_PIDS = new Set(
  String(params.get('ignore') || '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
)

const IGNORE_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow',
  'NarratorHelperWindow',
  'ThumbnailDeviceHelperWnd',
])

const fox = document.getElementById('fox')
const targetEl = document.getElementById('target')

let dragging = false
let interactive = false
let currentTarget = null
let lastHitAt = 0
let boundKey = ''
let boundHwnd = ''

// 测试与排障用的计数器（无副作用）
window.__foxDebug = { downs: 0, moves: 0, ups: 0, hits: 0, targets: [] }

const base = PORT ? 'http://127.0.0.1:' + PORT : ''
// 桥给出的是物理像素（进程 DPI-aware），页面坐标是 CSS 像素
const DPR = window.devicePixelRatio || 1

function setInteractive(on) {
  if (interactive === on) return
  interactive = on
  try {
    window.foxOverlay && window.foxOverlay.setInteractive(on)
  } catch (err) {}
}

function place(x, y) {
  fox.style.left = Math.round(x) + 'px'
  fox.style.top = Math.round(y) + 'px'
}

function foxSize() {
  return 52
}

function isOverFox(x, y) {
  const r = fox.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

function toView(x, y) {
  return { x: x / DPR - window.screenX, y: y / DPR - window.screenY }
}

function acceptable(win) {
  if (!win) return false
  if (IGNORE_PIDS.has(win.pid)) return false
  if (IGNORE_CLASSES.has(win.cls)) return false
  if (!win.exe && !win.title) return false
  return true
}

async function hitAt(x, y) {
  if (!base) return null
  try {
    const res = await fetch(
      base + '/hit?x=' + Math.round(x * DPR) + '&y=' + Math.round(y * DPR) + '&exclude=' + SELF_PID,
      {
        cache: 'no-store',
      }
    )
    const data = await res.json()
    if (!data.ok) return null
    return (data.hits || []).find(acceptable) || null
  } catch (err) {
    return null
  }
}

function showTarget(win) {
  if (!win) {
    targetEl.hidden = true
    return
  }
  const p = toView(win.rect.x, win.rect.y)
  targetEl.hidden = false
  targetEl.style.left = p.x + 'px'
  targetEl.style.top = p.y + 'px'
  targetEl.style.width = win.rect.w / DPR + 'px'
  targetEl.style.height = win.rect.h / DPR + 'px'
}

function snapTo(win) {
  const p = toView(win.rect.x + win.rect.w, win.rect.y)
  p.x -= foxSize() + 12
  p.y += 12
  place(p.x, p.y)
}

async function bind(win) {
  if (!base) return
  try {
    const res = await fetch(base + '/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hwnd: win.hwnd,
        pid: win.pid,
        exe: win.exe,
        startMs: win.startMs,
        title: win.title,
        rect: win.rect,
        adapterId: 'generic',
        anchor: { corner: 'top-right' },
      }),
    })
    const data = await res.json()
    if (data.ok && data.binding) {
      boundKey = data.binding.key
      boundHwnd = win.hwnd
      document.body.dataset.boundKey = boundKey
      document.body.dataset.boundTitle = win.title || ''
      fox.title = '已绑定：' + (win.title || win.exe)
      snapTo(win)
      return true
    }
  } catch (err) {}
  return false
}

async function unbind() {
  if (!boundKey || !base) return
  try {
    await fetch(base + '/bind?key=' + encodeURIComponent(boundKey), { method: 'DELETE' })
  } catch (err) {}
  boundKey = ''
  boundHwnd = ''
  delete document.body.dataset.boundKey
  delete document.body.dataset.boundTitle
  fox.title = '拖到 agent 窗口上'
}

// 指针在窗口上移动（穿透模式下由 forward 转发）
window.addEventListener('mousemove', (e) => {
  if (dragging) return
  setInteractive(isOverFox(e.clientX, e.clientY))
})

fox.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  try {
    fox.setPointerCapture(e.pointerId)
  } catch (err) {}
  dragging = true
  window.__foxDebug.downs++
  fox.classList.add('dragging')
  setInteractive(true)
  place(e.clientX - foxSize() / 2, e.clientY - foxSize() / 2)
})

window.addEventListener('pointermove', (e) => {
  window.__foxDebug.moves++
  if (!dragging) return
  place(e.clientX - foxSize() / 2, e.clientY - foxSize() / 2)
  const now = performance.now()
  if (now - lastHitAt < 30) return
  lastHitAt = now
  hitAt(e.screenX, e.screenY).then((win) => {
    if (!dragging) return
    window.__foxDebug.hits++
    window.__foxDebug.targets.push(win ? win.title + '#' + win.pid : null)
    currentTarget = win
    showTarget(win)
  })
})

window.addEventListener('pointerup', async (e) => {
  if (!dragging) return
  dragging = false
  window.__foxDebug.ups++
  fox.classList.remove('dragging')
  showTarget(null)
  const target = currentTarget
  currentTarget = null
  if (target) await bind(target)
  setInteractive(false)
})

// 跟随绑定窗口：窗口被拖动/缩放后，狐狸重新贴回右上角
setInterval(async () => {
  if (!boundKey || !boundHwnd || !base) return
  try {
    const res = await fetch(base + '/rect?hwnd=' + encodeURIComponent(boundHwnd), { cache: 'no-store' })
    const data = await res.json()
    if (data.ok && data.rect) {
      snapTo({ rect: data.rect })
    } else {
      await unbind()
    }
  } catch (err) {}
}, 500)

// 初始位置：右下角
place(window.innerWidth - foxSize() - 28, window.innerHeight - foxSize() - 96)
