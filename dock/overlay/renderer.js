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
const chip = document.getElementById('chip')
const chipAdapter = document.getElementById('chip-adapter')
const chipValue = document.getElementById('chip-value')
const panel = document.getElementById('panel')
const panelTitle = document.getElementById('panel-title')
const panelBody = document.getElementById('panel-body')

let dragging = false
let pressing = null // { x, y, at }：按下但还没判定成拖拽
let interactive = false
let currentTarget = null
let lastHitAt = 0
let boundKey = ''
let boundHwnd = ''
let boundAdapter = null
let lastSnapshot = null
let billingTimer = null
let panelOpen = false
let summaryTimer = null

// 测试与排障用的计数器（无副作用）
window.__foxDebug = { downs: 0, moves: 0, ups: 0, hits: 0, clicks: 0, targets: [] }

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
  placeChip()
  positionPanel()
}

function foxSize() {
  return 52
}

// ---------- 绑定后的数字卡片（R4：只展示，不可点） ----------

function fmtNum(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  return String(Math.round(n * 100) / 100)
}

function fmtMoney(m) {
  if (!m || typeof m.amount !== 'number') return ''
  const cur = !m.currency || m.currency === 'CNY' ? '¥' : ''
  return cur + (Math.round(m.amount * 100) / 100).toFixed(2)
}

function placeChip() {
  if (chip.hidden) return
  const w = chip.offsetWidth || 0
  const left = parseFloat(fox.style.left || '0') || 0
  const top = parseFloat(fox.style.top || '0') || 0
  chip.style.left = Math.round(left + foxSize() - w) + 'px'
  chip.style.top = Math.round(top + foxSize() + 6) + 'px'
}

function renderChip(snap) {
  lastSnapshot = snap || lastSnapshot
  const name = (boundAdapter && boundAdapter.name) || (snap && snap.adapterName) || '已绑定'
  chipAdapter.textContent = name
  chip.classList.remove('muted', 'error')
  chip.removeAttribute('title')

  if (!snap) {
    chipValue.textContent = '读取中…'
    chip.classList.add('muted')
  } else if (!snap.supported) {
    chipValue.textContent = '暂不支持计费'
    chip.classList.add('muted')
    chip.title = '这个窗口还没有适配器，只做吸附与跟随，不显示数字'
  } else if (!snap.ok) {
    chipValue.textContent = '读取失败'
    chip.classList.add('error')
    chip.title = snap.error || '未知原因'
  } else if (snap.unit === 'percent') {
    const q = snap.quota || {}
    chipValue.textContent =
      typeof q.usedPct === 'number' ? '已用 ' + q.usedPct + '%' : typeof q.remainingPct === 'number' ? '余 ' + q.remainingPct + '%' : '—'
    chip.title = '配额口径'
  } else if (snap.unit === 'credit') {
    chipValue.textContent = snap.today ? '今日 ' + fmtNum(snap.today.amount) + ' 积分' : '—'
    if (snap.turn) chip.title = '上一轮 ' + fmtNum(snap.turn.amount) + ' 积分'
  } else {
    chipValue.textContent = snap.today ? '今日 ' + fmtMoney(snap.today) : '—'
    if (snap.turn) chip.title = '上一轮 ' + fmtMoney(snap.turn)
  }
  placeChip()
}

async function refreshBilling() {
  if (!boundKey || !base) return
  try {
    const res = await fetch(base + '/billing?key=' + encodeURIComponent(boundKey), { cache: 'no-store' })
    if (res.status === 404) {
      await unbind()
      return
    }
    const data = await res.json()
    if (data.ok && data.snapshot) renderChip(data.snapshot)
  } catch (err) {}
}

function startBilling() {
  stopBilling()
  refreshBilling()
  billingTimer = setInterval(refreshBilling, 3000)
}

function stopBilling() {
  if (billingTimer) clearInterval(billingTimer)
  billingTimer = null
}

// ---------- 明细面板（R8：点狐狸打开） ----------

function clearNode(n) {
  while (n.firstChild) n.removeChild(n.firstChild)
}

function row(label, value, title) {
  const r = document.createElement('div')
  r.className = 'panel-row'
  const a = document.createElement('span')
  a.className = 'label'
  a.textContent = label
  const b = document.createElement('span')
  b.className = 'value'
  b.textContent = value
  if (title) b.title = String(title)
  r.appendChild(a)
  r.appendChild(b)
  return r
}

function groupLabel(g) {
  if (g.unit === 'money') {
    if (g.currency === 'CNY') return '¥' + g.amount.toFixed(2)
    if (g.currency === 'USD') return '$' + g.amount.toFixed(2)
    return g.currency + ' ' + g.amount.toFixed(2)
  }
  if (g.unit === 'credit') return fmtNum(g.amount) + ' 积分'
  if (g.unit === 'percent') return fmtNum(g.amount) + '%'
  return fmtNum(g.amount) + ' ' + g.unit
}

function renderPanel(summary) {
  const name = (boundAdapter && boundAdapter.name) || '未绑定'
  panelTitle.textContent = name
  clearNode(panelBody)

  const snap = lastSnapshot
  const sec = document.createElement('div')
  sec.className = 'panel-sec'
  if (!boundKey) {
    sec.appendChild(row('状态', '拖到 agent 窗口上试试'))
  } else if (!snap) {
    sec.appendChild(row('状态', '读取中…'))
  } else if (!snap.supported) {
    sec.appendChild(row('今日', '暂不支持计费'))
    sec.appendChild(row('说明', '已绑定与跟随，但不猜数字', '这个窗口还没有适配器'))
  } else if (!snap.ok) {
    sec.appendChild(row('状态', '读取失败', snap.error))
    sec.appendChild(row('原因', snap.error || '未知', snap.error))
  } else {
    const today = snap.unit === 'money' ? fmtMoney(snap.today) : fmtNum(snap.today && snap.today.amount) + (snap.unit === 'credit' ? ' 积分' : '%')
    sec.appendChild(row('今日', today))
    if (snap.turn) {
      const t = snap.unit === 'money' ? fmtMoney(snap.turn) : fmtNum(snap.turn.amount) + (snap.unit === 'credit' ? ' 积分' : '')
      sec.appendChild(row('上一轮', t))
    }
    if (snap.source) sec.appendChild(row('来源', snap.source, '适配器读取的数据源'))
  }
  panelBody.appendChild(sec)

  if (summary && summary.today && summary.today.groups && summary.today.groups.length) {
    const h = document.createElement('h4')
    h.textContent = '全部 agent（今日）'
    panelBody.appendChild(h)
    for (const g of summary.today.groups) {
      for (const a of g.adapters) {
        panelBody.appendChild(row(a.name, groupLabel({ ...g, amount: a.amount })))
      }
    }
  }

  const days = (summary && summary.days) || []
  const withData = days.filter((d) => d.groups && d.groups.length)
  if (withData.length) {
    const h = document.createElement('h4')
    h.textContent = '最近 ' + withData.length + ' 天'
    panelBody.appendChild(h)
    for (const d of withData.slice(-7).reverse()) {
      const text = d.groups.map(groupLabel).join('　')
      panelBody.appendChild(row(d.date.slice(5), text))
    }
  }

  positionPanel()
}

function positionPanel() {
  if (!panelOpen) return
  const fw = foxSize()
  const left = parseFloat(fox.style.left || '0') || 0
  const top = parseFloat(fox.style.top || '0') || 0
  const pw = panel.offsetWidth || 240
  const ph = panel.offsetHeight || 160
  let x = left + fw - pw
  let y = top + fw + 10
  x = Math.max(8, Math.min(x, window.innerWidth - pw - 8))
  if (y + ph > window.innerHeight - 8) y = Math.max(8, top - ph - 10)
  panel.style.left = Math.round(x) + 'px'
  panel.style.top = Math.round(y) + 'px'
}

async function refreshSummary() {
  if (!base) return
  try {
    const res = await fetch(base + '/summary?days=7', { cache: 'no-store' })
    const data = await res.json()
    if (data.ok && panelOpen) renderPanel(data)
  } catch (err) {}
}

function togglePanel(open) {
  const want = typeof open === 'boolean' ? open : !panelOpen
  if (want === panelOpen) return
  panelOpen = want
  panel.hidden = !panelOpen
  document.body.dataset.panel = panelOpen ? 'open' : 'closed'
  if (panelOpen) {
    renderPanel(null)
    refreshSummary()
    summaryTimer = setInterval(refreshSummary, 5000)
    setInteractive(true)
  } else {
    if (summaryTimer) clearInterval(summaryTimer)
    summaryTimer = null
    setInteractive(false)
  }
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
      boundAdapter = data.adapter || { id: data.binding.adapterId, name: data.binding.adapterId }
      document.body.dataset.boundKey = boundKey
      document.body.dataset.boundTitle = win.title || ''
      document.body.dataset.adapterId = boundAdapter.id
      fox.title = '已绑定：' + (win.title || win.exe) + '（' + boundAdapter.name + '）'
      chip.hidden = false
      renderChip(null)
      startBilling()
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
  boundAdapter = null
  stopBilling()
  chip.hidden = true
  chipValue.textContent = ''
  delete document.body.dataset.boundKey
  delete document.body.dataset.boundTitle
  delete document.body.dataset.adapterId
  fox.title = '拖到 agent 窗口上'
}

// 指针在窗口上移动（穿透模式下由 forward 转发）
window.addEventListener('mousemove', (e) => {
  if (dragging || pressing) return
  // 面板打开时整窗可交互（点空白处即收起），其余时候只有狐狸可交互
  if (panelOpen) {
    setInteractive(true)
    return
  }
  setInteractive(isOverFox(e.clientX, e.clientY))
})

fox.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  try {
    fox.setPointerCapture(e.pointerId)
  } catch (err) {}
  // 先不进入拖拽：移动超过阈值才算拖，否则松开就是「点击开面板」
  pressing = { x: e.clientX, y: e.clientY, at: performance.now() }
  window.__foxDebug.downs++
  setInteractive(true)
})

window.addEventListener('pointermove', (e) => {
  window.__foxDebug.moves++
  if (!pressing) return
  if (!dragging) {
    const dx = e.clientX - pressing.x
    const dy = e.clientY - pressing.y
    if (Math.hypot(dx, dy) <= 5) return
    dragging = true
    if (panelOpen) togglePanel(false)
    fox.classList.add('dragging')
  }
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
  if (!pressing) return
  const wasDragging = dragging
  pressing = null
  dragging = false
  window.__foxDebug.ups++
  fox.classList.remove('dragging')
  showTarget(null)

  if (!wasDragging) {
    window.__foxDebug.clicks++
    togglePanel()
    if (!panelOpen) setInteractive(isOverFox(e.clientX, e.clientY))
    return
  }

  const target = currentTarget
  currentTarget = null
  if (target) await bind(target)
  setInteractive(isOverFox(e.clientX, e.clientY))
})

// 面板打开时点面板外面 → 收起（这一下会被浮层吃掉，和常见菜单一致）
document.addEventListener('mousedown', (e) => {
  if (!panelOpen) return
  if (panel.contains(e.target) || fox.contains(e.target)) return
  togglePanel(false)
})

document.getElementById('panel-close').addEventListener('click', (e) => {
  e.stopPropagation()
  togglePanel(false)
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
