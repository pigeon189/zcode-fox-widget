// 浮层渲染层（R3）：拖拽 → 命中宿主窗口 → 绑定 → 吸附到窗口右上角。
//
// 穿透策略：默认整窗穿透，只有指针压在狐狸上时打开交互（Windows 上
// setIgnoreMouseEvents(true, {forward:true}) 会继续转发 mousemove，所以能用坐标
// 判定 hover，而不用依赖 e.target）。

const params = new URLSearchParams(location.search)
const PORT = Number(params.get('port') || 0)
const SELF_PID = Number(params.get('pid') || 0)
// ct=0 表示窗口不穿透（测试/排障用）：这时不需要光标轮询，
// 而且合成事件不会移动真实光标，轮询反而会把交互关掉。
const CLICK_THROUGH = params.get('ct') !== '0'

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
const chip = document.getElementById('chip')
const chipAdapter = document.getElementById('chip-adapter')
const chipValue = document.getElementById('chip-value')
const panel = document.getElementById('panel')
const panelTitle = document.getElementById('panel-title')
const panelBody = document.getElementById('panel-body')
const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubble-text')
const bubbleSub = document.getElementById('bubble-sub')
const foxImg = document.getElementById('fox-img')
const sayEl = document.getElementById('say')
const sayText = document.getElementById('say-text')

// 设置（由 daemon 持久化，见 daemon/src/settings.mjs）。这里的初值只用于首帧，
// 真实值在 loadSettings() 回来之前不会影响几何（狐狸默认 1×）。
let settings = {
  roleId: 'fox',
  chatterMs: 300000,
  scale: 1,
  showChip: true,
  followMs: 500,
  scrollGap: 17,
  turnBubble: true,
  turnBubbleMs: 5000,
  budgetMoney: 0,
  quotaWarnPct: 0,
  alertBubble: true,
}
let followTimer = null
let lastBoundRect = null
let bubbleTimer = null
let activeTab = 'detail'
let filterText = ''
let lastSummary = null
let lastBindings = []
// 上一轮的「今日累计 + 本轮」指纹：用来判断是不是又花了一轮
let turnFingerprint = null
let alertTimer = null
// 角色与台词
let roleId = 'fox'
let lastLine = ''
let sayTimer = null
let chatterTimer = null

let dragging = false
let pressing = null // { x, y, at }：按下但还没判定成拖拽
let interactive = false
let currentTarget = null
let lastHitAt = 0
let boundKey = ''
let boundHwnd = ''
let boundAdapter = null
// 狐狸左上角相对绑定窗口左上角的偏移（CSS px）；null = 没有就退回右上角
let boundAnchor = null
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
  positionBubble()
  positionSay()
  positionPanel()
}

const FOX_BASE = 80

function foxSize() {
  return Math.round(FOX_BASE * (Number(settings.scale) || 1))
}

// 缩放只改两个 CSS 变量，几何全部由它们算（狐狸、卡片、面板定位都读 foxSize）
function applyScale() {
  const size = foxSize()
  document.documentElement.style.setProperty('--fox-size', size + 'px')
  document.documentElement.style.setProperty('--fox-font', Math.round(size * 0.654) + 'px')
}

// ---------- 角色与台词（从挂件线移植） ----------

// 抽一句，尽量不连着说同一句
function pickLine(pool) {
  if (!Array.isArray(pool) || !pool.length) return ''
  if (pool.length === 1) return pool[0]
  let line = pool[Math.floor(Math.random() * pool.length)]
  for (let i = 0; i < 3 && line === lastLine; i++) line = pool[Math.floor(Math.random() * pool.length)]
  lastLine = line
  return line
}

function positionSay() {
  if (sayEl.hidden) return
  const fw = foxSize()
  const left = parseFloat(fox.style.left || '0') || 0
  const top = parseFloat(fox.style.top || '0') || 0
  const bw = sayEl.offsetWidth || 0
  const bh = sayEl.offsetHeight || 0
  let x = left + fw / 2 - bw / 2
  let y = top - bh - 8
  sayEl.classList.remove('below')
  // 面板也在角色旁边：气泡放到面板的**另一边**，别互相压住
  const panelTop = panelOpen ? parseFloat(panel.style.top || '0') || 0 : NaN
  const panelAbove = panelOpen && panelTop < top
  // 上方放不下（或面板在上面）就翻到下面，尖角跟着换方向
  if (y < 6 || panelAbove) {
    y = top + fw + 8
    sayEl.classList.add('below')
  }
  x = Math.max(8, Math.min(x, window.innerWidth - bw - 8))
  sayEl.style.left = Math.round(x) + 'px'
  sayEl.style.top = Math.round(Math.max(6, y)) + 'px'
}

function showSay(text, ms) {
  if (!text) return
  sayText.textContent = text
  sayEl.hidden = false
  positionSay()
  requestAnimationFrame(() => sayEl.classList.add('open'))
  if (sayTimer) clearTimeout(sayTimer)
  sayTimer = setTimeout(hideSay, Number(ms) || 5200)
}

function hideSay() {
  if (sayTimer) clearTimeout(sayTimer)
  sayTimer = null
  sayEl.classList.remove('open')
  setTimeout(() => {
    if (!sayEl.classList.contains('open')) sayEl.hidden = true
  }, 200)
}

// 换角色：立绘做一次淡入；speak=true 时说这个角色的「挑经句」
function applyRole(id, speak) {
  const role = foxRoleOf(id)
  if (!role) return
  const changed = roleId !== role.id
  roleId = role.id
  if (changed) {
    foxImg.classList.add('switching')
    const clear = () => foxImg.classList.remove('switching')
    foxImg.addEventListener('load', clear, { once: true })
    foxImg.addEventListener(
      'error',
      () => {
        // 立绘缺失不该让整个角色消失：退回默认形象
        foxImg.src = FOX_ROLES.fox.image
        clear()
      },
      { once: true }
    )
    foxImg.src = role.image
    setTimeout(clear, 800)
  }
  if (speak) showSay(pickLine(role.pick.length ? role.pick : role.lines), 5200)
}

function sayRandom() {
  const role = foxRoleOf(roleId || settings.roleId)
  showSay(pickLine(role.lines), 5200)
}

// 随机台词：默认 5 分钟一句，可在设置里调或关掉。
// 拖拽中 / 面板开着 / 数字气泡正在显示时不抢话。
function restartChatter() {
  if (chatterTimer) clearInterval(chatterTimer)
  chatterTimer = null
  const ms = Number(settings.chatterMs) || 0
  if (ms <= 0) return
  chatterTimer = setInterval(() => {
    if (dragging || pressing || panelOpen) return
    if (!bubble.hidden) return
    sayRandom()
  }, Math.max(30000, ms))
}

// ---------- 气泡（每轮消耗 / 预算提醒） ----------

function positionBubble() {
  if (bubble.hidden) return
  const fw = foxSize()
  const left = parseFloat(fox.style.left || '0') || 0
  const top = parseFloat(fox.style.top || '0') || 0
  const bw = bubble.offsetWidth || 0
  const bh = bubble.offsetHeight || 0
  let x = left + fw / 2 - bw / 2
  let y = top - bh - 8
  if (y < 8) y = top + fw + 8
  x = Math.max(8, Math.min(x, window.innerWidth - bw - 8))
  bubble.style.left = Math.round(x) + 'px'
  bubble.style.top = Math.round(y) + 'px'
}

// ms 省略 = 一直显示（调用方自己隐藏，预算提醒走这条路）
function showBubble(text, sub, opts) {
  if (!settings.alertBubble && opts && opts.warn) return
  bubbleText.textContent = text
  bubbleSub.textContent = sub || ''
  bubbleSub.hidden = !sub
  bubble.classList.toggle('warn', !!(opts && opts.warn))
  bubble.hidden = false
  positionBubble()
  requestAnimationFrame(() => bubble.classList.add('open'))
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = null
  const ms = opts && Number(opts.ms)
  if (Number.isFinite(ms) && ms > 0) {
    bubbleTimer = setTimeout(() => hideBubble(), ms)
  }
}

function hideBubble() {
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = null
  bubble.classList.remove('open')
  setTimeout(() => {
    if (!bubble.classList.contains('open')) bubble.hidden = true
  }, 200)
}

// ---------- 设置（daemon 持久化） ----------

async function loadSettings() {
  if (!base) return
  try {
    const r = await (await fetch(base + '/settings', { cache: 'no-store' })).json()
    if (r && r.ok && r.settings) {
      settings = { ...settings, ...r.settings }
      applySettings()
    }
  } catch (err) {}
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch }
  applySettings()
  if (!base) return settings
  try {
    const r = await (
      await fetch(base + '/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    ).json()
    if (r && r.ok && r.settings) {
      settings = { ...settings, ...r.settings }
      applySettings()
    }
  } catch (err) {}
  return settings
}

function applySettings() {
  applyScale()
  applyRole(settings.roleId)
  restartChatter()
  updateChipVisibility()
  restartFollowTimer()
  restartAlertTimer()
  if (lastBoundRect) placeByAnchor(lastBoundRect)
  if (panelOpen) renderPanel(lastSummary, lastBindings)
}

function updateChipVisibility() {
  chip.hidden = !boundKey || !settings.showChip
}

// ---------- 提醒（今日预算 / 额度预警） ----------

function dayKeyNow() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// 同一天同一项只弹一次：预算刚超时会每 30s 命中一次，不节流会变成骚扰
function alertOnce(name, text, sub) {
  const key = 'fox-dock:alert:' + dayKeyNow() + ':' + name
  try {
    if (localStorage.getItem(key)) return false
    localStorage.setItem(key, '1')
  } catch (err) {}
  showBubble(text, sub, { warn: true, ms: Math.max(4000, settings.turnBubbleMs) })
  return true
}

function moneyTotalCny(groups) {
  let sum = 0
  let has = false
  for (const g of groups || []) {
    if (g.unit === 'money' && g.currency === 'CNY') {
      sum += Number(g.amount) || 0
      has = true
    }
  }
  return has ? Math.round(sum * 10000) / 10000 : null
}

async function checkAlerts() {
  if (!base) return
  // 额度预警：只看当前绑定窗口的快照（其它 agent 的额度不在这里消费）
  const snap = lastSnapshot
  const warnPct = Number(settings.quotaWarnPct) || 0
  if (warnPct > 0 && snap && snap.ok && snap.quota && typeof snap.quota.remainingPct === 'number') {
    if (snap.quota.remainingPct <= warnPct) {
      alertOnce(
        'quota:' + (snap.adapterId || 'x'),
        (snap.adapterName || '额度') + ' 快用完了',
        '剩余 ' + fmtNum(snap.quota.remainingPct) + '%（阈值 ' + warnPct + '%）'
      )
    }
  }

  const budget = Number(settings.budgetMoney) || 0
  if (budget > 0) {
    try {
      const r = await (await fetch(base + '/summary?days=1', { cache: 'no-store' })).json()
      const total = moneyTotalCny(r && r.today && r.today.groups)
      if (total !== null && total > budget) {
        alertOnce(
          'budget',
          '今日预算超了',
          '已用 ¥' + total.toFixed(2) + ' / 预算 ¥' + budget.toFixed(2)
        )
      }
    } catch (err) {}
  }
}

function restartAlertTimer() {
  if (alertTimer) clearInterval(alertTimer)
  alertTimer = null
  if (!base) return
  const budget = Number(settings.budgetMoney) || 0
  const warnPct = Number(settings.quotaWarnPct) || 0
  if (budget <= 0 && warnPct <= 0) return
  checkAlerts()
  alertTimer = setInterval(checkAlerts, 30000)
}

// 每轮消耗：适配器给的是「上一轮金额」，没有轮次 id，所以用
// 「今日累计 + 本轮金额」的指纹判断是否又花了一轮（两轮同额也能认出来）。
function noteTurn(snap) {
  if (!snap || !snap.ok || !snap.supported) {
    turnFingerprint = null
    return
  }
  const turnAmount = snap.turn && typeof snap.turn.amount === 'number' ? snap.turn.amount : null
  const todayAmount = snap.today && typeof snap.today.amount === 'number' ? snap.today.amount : null
  if (turnAmount === null && todayAmount === null) return
  const fp = String(todayAmount) + '|' + String(turnAmount)
  const prev = turnFingerprint
  turnFingerprint = fp
  if (prev === null || prev === fp) return
  if (!settings.turnBubble || turnAmount === null) return
  const label =
    snap.unit === 'money'
      ? fmtMoney(snap.turn)
      : fmtNum(turnAmount) + (snap.unit === 'credit' ? ' 积分' : snap.unit === 'percent' ? '%' : '')
  showBubble('本轮 ' + label, snap.adapterName || '', { ms: Number(settings.turnBubbleMs) || 5000 })
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
  noteTurn(snap)
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

const PANEL_TABS = ['detail', 'settings', 'about']

let aboutDiag = null
let aboutLoading = false
let aboutError = ''

function setActiveTab(tab) {
  activeTab = PANEL_TABS.includes(tab) ? tab : 'detail'
  for (const b of document.querySelectorAll('#panel .panel-tabs button')) {
    b.classList.toggle('active', b.dataset.tab === activeTab)
  }
}

function renderPanel(summary, bindings) {
  if (summary) lastSummary = summary
  if (bindings) lastBindings = bindings
  const name = (boundAdapter && boundAdapter.name) || '未绑定'
  panelTitle.textContent = activeTab === 'detail' ? name : activeTab === 'settings' ? '设置' : '关于'
  setActiveTab(activeTab)
  clearNode(panelBody)
  if (activeTab === 'settings') {
    renderSettings()
  } else if (activeTab === 'about') {
    renderAbout()
  } else {
    renderDetail()
  }
  positionPanel()
}

// ---------- 明细 ----------

function windowSection() {
  const sec = document.createElement('div')
  sec.className = 'panel-sec'
  const snap = lastSnapshot
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
    const today =
      snap.unit === 'money'
        ? fmtMoney(snap.today)
        : fmtNum(snap.today && snap.today.amount) + (snap.unit === 'credit' ? ' 积分' : '%')
    sec.appendChild(row('今日', today))
    if (snap.turn) {
      const t = snap.unit === 'money' ? fmtMoney(snap.turn) : fmtNum(snap.turn.amount) + (snap.unit === 'credit' ? ' 积分' : '')
      sec.appendChild(row('上一轮', t))
    }
    if (snap.quota && typeof snap.quota.remainingPct === 'number') {
      sec.appendChild(row('额度剩余', fmtNum(snap.quota.remainingPct) + '%'))
    }
    if (snap.source) sec.appendChild(row('来源', snap.source, '适配器读取的数据源'))
  }
  panelBody.appendChild(sec)
}

function matchesFilter(name, date) {
  const q = filterText.trim().toLowerCase()
  if (!q) return true
  return String(name || '').toLowerCase().includes(q) || String(date || '').includes(q)
}

function renderDetail() {
  // 多窗口歧义：同一个 agent 开了多个窗口时，标题是唯一能让人确认「绑对没绑对」的东西
  const boundTitle = document.body.dataset.boundTitle || ''
  if (boundKey && boundTitle) {
    const sub = document.createElement('div')
    sub.className = 'panel-sub'
    sub.textContent = boundTitle
    sub.title = boundTitle
    panelBody.appendChild(sub)
  }

  windowSection()

  const search = document.createElement('input')
  search.type = 'search'
  search.placeholder = '搜索适配器 / 日期'
  search.value = filterText
  search.addEventListener('input', () => {
    filterText = search.value
    renderDetailList()
  })
  search.addEventListener('focus', () => setInteractive(true))
  const wrap = document.createElement('div')
  wrap.className = 'setting'
  wrap.appendChild(search)
  panelBody.appendChild(wrap)

  const list = document.createElement('div')
  list.id = 'detail-list'
  panelBody.appendChild(list)
  renderDetailList()

  if (boundKey) {
    const actions = document.createElement('div')
    actions.className = 'panel-actions'
    const un = document.createElement('button')
    un.type = 'button'
    un.textContent = '解绑这个窗口'
    un.addEventListener('click', (e) => {
      e.stopPropagation()
      unbind().then(() => {
        togglePanel(false)
      })
    })
    actions.appendChild(un)
    panelBody.appendChild(actions)
  }
}

// 只重画列表：搜索框在输入时不能被重建，否则每敲一个字就丢焦点
function renderDetailList() {
  const list = document.getElementById('detail-list')
  if (!list) return
  clearNode(list)
  const summary = lastSummary

  if (summary && summary.today && summary.today.groups && summary.today.groups.length) {
    const matched = []
    for (const g of summary.today.groups) {
      for (const a of g.adapters) {
        if (matchesFilter(a.name, summary.today.date)) matched.push({ g, a })
      }
    }
    if (matched.length) {
      const h = document.createElement('h4')
      h.textContent = '全部 agent（今日）'
      list.appendChild(h)
      for (const { g, a } of matched) list.appendChild(row(a.name, groupLabel({ ...g, amount: a.amount })))
    }
  }

  const days = (summary && summary.days) || []
  const rows = []
  for (const d of days.slice().reverse().slice(0, 7)) {
    const parts = []
    for (const g of d.groups || []) {
      for (const a of g.adapters) {
        if (!matchesFilter(a.name, d.date)) continue
        parts.push(a.name + ' ' + groupLabel({ ...g, amount: a.amount }))
      }
    }
    if (parts.length) rows.push({ date: d.date, text: parts.join('　') })
  }
  if (rows.length) {
    const h = document.createElement('h4')
    h.textContent = rows.length + ' 天记录'
    list.appendChild(h)
    for (const r of rows) list.appendChild(row(r.date.slice(5), r.text))
  } else if (filterText.trim()) {
    list.appendChild(row('无匹配', '换个关键词试试'))
  }

  // 其它绑定：换窗口时常常忘了旧的那条，这里能直接清掉
  const others = (lastBindings || []).filter((b) => b.key !== boundKey).slice(0, 5)
  if (others.length) {
    const h = document.createElement('h4')
    h.textContent = '其它绑定'
    list.appendChild(h)
    for (const b of others) {
      const title = (b.window && b.window.title) || (b.window && b.window.exe) || b.key
      const r = document.createElement('div')
      r.className = 'panel-row panel-binding'
      const a = document.createElement('span')
      a.className = 'label'
      a.textContent = title.length > 18 ? title.slice(0, 18) + '…' : title
      a.title = title
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = '解绑'
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        fetch(base + '/bind?key=' + encodeURIComponent(b.key), { method: 'DELETE' })
          .then(() => refreshSummary())
          .catch(() => {})
      })
      r.appendChild(a)
      r.appendChild(btn)
      list.appendChild(r)
    }
  }
  positionPanel()
}

// ---------- 设置 ----------

function settingRow(labelText, control, hint) {
  const r = document.createElement('div')
  r.className = 'setting'
  const l = document.createElement('label')
  l.textContent = labelText
  r.appendChild(l)
  r.appendChild(control)
  if (hint) {
    const box = document.createElement('div')
    box.appendChild(r)
    const h = document.createElement('p')
    h.className = 'setting-hint'
    h.textContent = hint
    box.appendChild(h)
    return box
  }
  return r
}

function selectControl(options, value, onChange) {
  const sel = document.createElement('select')
  for (const o of options) {
    const op = document.createElement('option')
    op.value = String(o.value)
    op.textContent = o.label
    sel.appendChild(op)
  }
  sel.value = String(value)
  sel.addEventListener('change', () => onChange(sel.value))
  return sel
}

function checkboxControl(checked, onChange) {
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = !!checked
  box.addEventListener('change', () => onChange(box.checked))
  return box
}

function numberControl(value, { min, max, step }, onChange) {
  const input = document.createElement('input')
  input.type = 'number'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step || 1)
  input.value = String(value)
  input.addEventListener('change', () => {
    const n = Number(input.value)
    if (Number.isFinite(n)) onChange(n)
  })
  return input
}

function renderSettings() {
  const note = document.createElement('p')
  note.className = 'setting-hint'
  note.textContent = '改动立即生效并保存到本机（%LOCALAPPDATA%\\fox-dock\\settings.json）。'
  panelBody.appendChild(note)

  panelBody.appendChild(
    settingRow(
      '角色',
      selectControl(
        FOX_ROLE_ORDER.map((id) => ({ value: id, label: FOX_ROLES[id].name })),
        settings.roleId,
        (v) => {
          // 先换立绘并说一句「挑经句」，再落盘（saveSettings 内部不会重复换）
          applyRole(v, true)
          saveSettings({ roleId: v })
        }
      ),
      '换角色会同时换立绘和台词。'
    )
  )

  panelBody.appendChild(
    settingRow(
      '随机台词',
      selectControl(
        [
          { value: 0, label: '不说话' },
          { value: 180000, label: '3 分钟' },
          { value: 300000, label: '5 分钟' },
          { value: 600000, label: '10 分钟' },
        ],
        settings.chatterMs,
        (v) => saveSettings({ chatterMs: Number(v) })
      ),
      '角色会自己冒一句；拖拽中、面板打开时不说。'
    )
  )

  panelBody.appendChild(
    settingRow(
      '大小',
      selectControl(
        [
          { value: 0.75, label: '小' },
          { value: 1, label: '标准' },
          { value: 1.25, label: '大' },
          { value: 1.5, label: '特大' },
        ],
        settings.scale,
        (v) => saveSettings({ scale: Number(v) })
      )
    )
  )

  panelBody.appendChild(
    settingRow(
      '跟随间隔',
      selectControl(
        [
          { value: 250, label: '250ms' },
          { value: 500, label: '500ms' },
          { value: 1000, label: '1s' },
        ],
        settings.followMs,
        (v) => saveSettings({ followMs: Number(v) })
      ),
      '宿主窗口移动后，狐狸多久跟过去。太短会频繁读窗口矩形。'
    )
  )

  panelBody.appendChild(
    settingRow(
      '显示数字卡片',
      checkboxControl(settings.showChip, (v) => saveSettings({ showChip: v })),
      '关掉后只留狐狸，单击仍可看明细。'
    )
  )

  panelBody.appendChild(
    settingRow(
      '每轮消耗气泡',
      checkboxControl(settings.turnBubble, (v) => saveSettings({ turnBubble: v })),
      '绑定窗口每花完一轮，在狐狸头上冒一次金额。'
    )
  )

  panelBody.appendChild(
    settingRow(
      '气泡停留',
      numberControl(settings.turnBubbleMs / 1000, { min: 1, max: 15, step: 1 }, (v) =>
        saveSettings({ turnBubbleMs: Math.round(v * 1000) })
      ),
      '单位：秒（1–15）。'
    )
  )

  panelBody.appendChild(
    settingRow(
      '今日预算',
      numberControl(settings.budgetMoney, { min: 0, max: 1000000, step: 1 }, (v) => saveSettings({ budgetMoney: v })),
      '单位：元。跨 agent 汇总（只算人民币）超过就提醒一次，每天一次；0 = 不设。'
    )
  )

  panelBody.appendChild(
    settingRow(
      '额度预警',
      numberControl(settings.quotaWarnPct, { min: 0, max: 100, step: 5 }, (v) => saveSettings({ quotaWarnPct: v })),
      '剩余额度低于该百分比时提醒；只对能读出额度的适配器生效，0 = 关闭。'
    )
  )

  panelBody.appendChild(
    settingRow(
      '滚动条宽度',
      numberControl(settings.scrollGap, { min: 0, max: 60, step: 1 }, (v) => saveSettings({ scrollGap: v })),
      '贴右/下边时留出的距离，避免盖住宿主滚动条（px）。'
    )
  )

  panelBody.appendChild(
    settingRow(
      '提醒气泡',
      checkboxControl(settings.alertBubble, (v) => saveSettings({ alertBubble: v })),
      '预算 / 额度提醒；关掉后每轮消耗气泡仍按上面的开关走。'
    )
  )

  const foot = document.createElement('p')
  foot.className = 'setting-hint'
  foot.textContent = '注：音效、角色、桌宠模式没有移植——见 docs/dock/MIGRATION.md 里的理由。'
  panelBody.appendChild(foot)
}

// ---------- 关于 / 自检 ----------

async function loadDiag() {
  if (aboutLoading || !base) return
  aboutLoading = true
  aboutError = ''
  try {
    const r = await fetch(base + '/diag.json', { cache: 'no-store' })
    const d = await r.json()
    if (!d || d.ok === false) throw new Error((d && d.error) || '读取失败')
    aboutDiag = d
  } catch (err) {
    aboutError = String((err && err.message) || err)
  }
  aboutLoading = false
  if (activeTab === 'about') renderPanel(lastSummary, lastBindings)
}

function electronVersion() {
  const m = /Electron\/([\d.]+)/.exec(navigator.userAgent || '')
  return m ? m[1] : '—'
}

function renderAbout() {
  if (!aboutDiag) {
    panelBody.appendChild(row('状态', aboutError ? '读取失败：' + aboutError : '读取中…'))
    if (!aboutLoading) loadDiag()
    return
  }
  const d = aboutDiag
  panelBody.appendChild(row('版本', 'v' + d.version))
  panelBody.appendChild(row('运行', 'Electron ' + electronVersion() + ' · ' + d.runtime.platform + '/' + d.runtime.arch))
  panelBody.appendChild(row('服务', 'pid ' + d.runtime.pid + ' · 端口 ' + d.runtime.port + ' · ' + d.runtime.uptimeSec + 's'))
  panelBody.appendChild(row('数据目录', d.paths.dataDir, d.paths.dataDir))
  panelBody.appendChild(row('适配器', (d.adapters || []).map((a) => a.name).join('、') || '—'))
  panelBody.appendChild(row('绑定', String(d.bindingCount || 0) + ' 个窗口'))
  const up = d.update || {}
  if (up.appliedVersion || up.latest) {
    panelBody.appendChild(row('更新', (up.appliedVersion || d.version) + ' → ' + (up.latest || '—')))
  }

  const h = document.createElement('h4')
  h.textContent = '最近日志'
  panelBody.appendChild(h)
  const pre = document.createElement('pre')
  pre.className = 'diag-log'
  const lines = (d.logs || []).slice(-14)
  pre.textContent = lines.length ? lines.join('\n') : '（暂无）'
  panelBody.appendChild(pre)

  const actions = document.createElement('div')
  actions.className = 'panel-actions'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = '复制诊断信息'
  copy.title = '不含密钥；路径里的用户名已替换成 ~'
  copy.addEventListener('click', (e) => {
    e.stopPropagation()
    copyDiagnostics()
  })
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.textContent = '刷新'
  refresh.style.marginLeft = '6px'
  refresh.addEventListener('click', (e) => {
    e.stopPropagation()
    aboutDiag = null
    renderPanel(lastSummary, lastBindings)
  })
  actions.appendChild(copy)
  actions.appendChild(refresh)
  panelBody.appendChild(actions)

  const hint = document.createElement('p')
  hint.className = 'setting-hint'
  hint.textContent = '遇到问题把这个贴给维护者即可（不含密钥，路径已脱敏）。'
  panelBody.appendChild(hint)
  positionPanel()
}

function copyDiagnostics() {
  if (!aboutDiag) return
  const text = JSON.stringify(aboutDiag, null, 2)
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
  } catch (err) {}
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
    const [sumRes, bindRes] = await Promise.all([
      fetch(base + '/summary?days=7', { cache: 'no-store' }),
      fetch(base + '/bindings', { cache: 'no-store' }),
    ])
    const data = await sumRes.json()
    const binds = await bindRes.json()
    if (data.ok && panelOpen) renderPanel(data, binds.ok ? binds.bindings : [])
  } catch (err) {}
}

function togglePanel(open) {
  const want = typeof open === 'boolean' ? open : !panelOpen
  if (want === panelOpen) return
  panelOpen = want
  panel.hidden = !panelOpen
  document.body.dataset.panel = panelOpen ? 'open' : 'closed'
  if (panelOpen) {
    renderPanel(null, [])
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

// 窗口在屏幕上的位置：**用指针事件自己算**（screenX - clientX）。
// window.screenX 在窗口激活/DPI 校正前后会变（实测差 128px），拿它换算会错位。
let screenOffset = null
function updateScreenOffset(e) {
  if (!e) return
  screenOffset = { x: e.screenX - e.clientX, y: e.screenY - e.clientY }
}
let boundsOrigin = null
try {
  if (window.foxOverlay && window.foxOverlay.getBounds) {
    window.foxOverlay.getBounds().then((b) => {
      if (b && Number.isFinite(b.x)) boundsOrigin = { x: b.x, y: b.y }
    })
  }
} catch (err) {}

function screenOrigin() {
  return screenOffset || boundsOrigin || { x: window.screenX, y: window.screenY }
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
  const px = Math.round(x * DPR)
  const py = Math.round(y * DPR)
  try {
    // 优先走主进程：拖拽期间渲染进程的网络请求会被 Chromium 整体挂起
    const api = window.foxOverlay
    const data =
      api && typeof api.hit === 'function'
        ? await api.hit(px, py, SELF_PID)
        : await (await fetch(base + '/hit?x=' + px + '&y=' + py + '&exclude=' + SELF_PID, { cache: 'no-store' })).json()
    if (!data || !data.ok) return null
    return (data.hits || []).find(acceptable) || null
  } catch (err) {
    return null
  }
}

// 只让狐狸自己有反应（描边 + 轻微放大），不画目标窗口的框
function setArmed(on) {
  fox.classList.toggle('armed', !!on)
}

function windowTopLeft(rect) {
  const o = screenOrigin()
  return { x: rect.x / DPR - o.x, y: rect.y / DPR - o.y }
}

// 四分吸附（与挂件线同款语义）：落点中心靠哪条边就贴哪条边，中间区域保留自由位置。
// 锚点存 {h,v,hOff,vOff}：h/v 是贴的边，为 null 时 hOff/vOff 是离左上角的距离。
function anchorForDrop(win) {
  const tl = windowTopLeft(win.rect)
  const w = win.rect.w / DPR
  const h = win.rect.h / DPR
  const left = (parseFloat(fox.style.left || '0') || 0) - tl.x
  const top = (parseFloat(fox.style.top || '0') || 0) - tl.y
  const cx = left + foxSize() / 2
  const cy = top + foxSize() / 2
  const a = { h: null, v: null, hOff: 0, vOff: 0 }
  if (cx < w / 4) a.h = 'left'
  else if (cx > (w * 3) / 4) a.h = 'right'
  else a.hOff = Math.round(Math.min(Math.max(0, left), Math.max(0, w - foxSize())))
  if (cy < h / 4) a.v = 'top'
  else if (cy > (h * 3) / 4) a.v = 'bottom'
  else a.vOff = Math.round(Math.min(Math.max(0, top), Math.max(0, h - foxSize())))
  return a
}

// Windows 给最小化窗口的矩形是 (-32000,-32000)：拿它定位会把狐狸扔到屏幕外
// （真机踩过：用户以为挂件没启动）。宁可不动，也不要摆到看不见的地方。
function plausibleRect(rect) {
  if (!rect || typeof rect !== 'object') return false
  const { x, y, w, h } = rect
  if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) return false
  if (w <= 0 || h <= 0) return false
  if (x <= -30000 || y <= -30000) return false
  return true
}

function placeByAnchor(rect) {
  if (!plausibleRect(rect)) return
  lastBoundRect = rect
  const tl = windowTopLeft(rect)
  const w = rect.w / DPR
  const h = rect.h / DPR
  const size = foxSize()
  const a = boundAnchor || { h: 'right', v: 'top', hOff: 0, vOff: 0 }
  // 贴右边时留出滚动条宽度，否则会正好盖住宿主的滚动条（挂件线同款处理）
  const gap = Math.max(0, Math.min(60, Number(settings.scrollGap) || 0))
  let x
  if (a.h === 'left') x = 0
  else if (a.h === 'right') x = Math.max(0, w - size - gap)
  else x = Math.min(Math.max(0, Number(a.hOff) || 0), Math.max(0, w - size))
  let y
  if (a.v === 'top') y = 0
  else if (a.v === 'bottom') y = Math.max(0, h - size - gap)
  else y = Math.min(Math.max(0, Number(a.vOff) || 0), Math.max(0, h - size))
  place(tl.x + x, tl.y + y)
}

async function bind(win) {
  if (!base) return
  // 四分吸附：靠边就贴边，中间就留在原地
  const anchor = anchorForDrop(win)
  turnFingerprint = null
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
        anchor,
      }),
    })
    const data = await res.json()
    if (data.ok && data.binding) {
      boundKey = data.binding.key
      boundHwnd = win.hwnd
      boundAdapter = data.adapter || { id: data.binding.adapterId, name: data.binding.adapterId }
      boundAnchor = data.binding.anchor && (data.binding.anchor.h || data.binding.anchor.v || Number.isFinite(data.binding.anchor.hOff)) ? data.binding.anchor : anchor
      document.body.dataset.boundKey = boundKey
      document.body.dataset.boundTitle = win.title || ''
      document.body.dataset.adapterId = boundAdapter.id
      fox.title = '已绑定：' + (win.title || win.exe) + '（' + boundAdapter.name + '）'
      updateChipVisibility()
      renderChip(null)
      startBilling()
      placeByAnchor(win.rect)
      sayRandom()
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
  boundAnchor = null
  stopBilling()
  updateChipVisibility()
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

// 光标轮询（权威来源）：穿透状态下 mousemove 转发在部分场景收不到——
// 实测 WorkBuddy 在前台时狐狸完全点不到。改为每 50ms 直接问一次系统光标位置，
// 压在狐狸上就打开交互，否则立刻回到穿透。
setInterval(async () => {
  if (!CLICK_THROUGH || pressing || dragging) return
  const api = window.foxOverlay
  if (!api || typeof api.getCursor !== 'function') return
  try {
    const p = await api.getCursor()
    if (!p) return
    const o = screenOrigin()
    const over = isOverFox(p.x - o.x, p.y - o.y)
    setInteractive(panelOpen || over)
  } catch (err) {}
}, 50)

fox.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  updateScreenOffset(e)
  // 不设 pointer capture：窗口本身就是全屏的，指针跑不出去；
  // capture 期间 Chromium 会把渲染进程的微任务推迟到手势结束（实测 hit 请求全卡到松手后才回）

  // 先不进入拖拽：移动超过阈值才算拖，否则松开就是「点击开面板」
  pressing = { x: e.clientX, y: e.clientY, at: performance.now() }
  window.__foxDebug.downs++
  setArmed(false)
  setInteractive(true)
})

window.addEventListener('pointermove', (e) => {
  window.__foxDebug.moves++
  updateScreenOffset(e)
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
    setArmed(!!win)
  })
})

window.addEventListener('pointerup', async (e) => {
  if (!pressing) return
  updateScreenOffset(e)
  const wasDragging = dragging
  pressing = null
  dragging = false
  window.__foxDebug.ups++
  fox.classList.remove('dragging')

  if (!wasDragging) {
    window.__foxDebug.clicks++
    sayRandom()
    togglePanel()
    if (!panelOpen) setInteractive(isOverFox(e.clientX, e.clientY))
    return
  }

  const target = currentTarget
  currentTarget = null
  setArmed(false)
  if (target) {
    await bind(target)
  } else if (boundKey) {
    // 拖到空白处松手 = 解绑：狐狸停在这儿，不再跟着原来的窗口跑
    await unbind()
  }
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

for (const btn of document.querySelectorAll('#panel .panel-tabs button')) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    activeTab = btn.dataset.tab || 'detail'
    renderPanel(lastSummary, lastBindings)
    if (activeTab === 'about') loadDiag()
  })
}

// 跟随绑定窗口：窗口被拖动/缩放后，狐狸按锚点重新贴回去。
// **拖拽/按住期间必须让路**——否则定时器会把狐狸拽回旧位置，用户拖到一半就被抢走。
function restartFollowTimer() {
  if (followTimer) clearInterval(followTimer)
  followTimer = null
  if (!base) return
  const every = Math.max(200, Number(settings.followMs) || 500)
  followTimer = setInterval(async () => {
    if (!boundKey || !boundHwnd || dragging || pressing) return
    try {
      const res = await fetch(base + '/rect?hwnd=' + encodeURIComponent(boundHwnd), { cache: 'no-store' })
      const data = await res.json()
      if (data.ok && data.rect) {
        placeByAnchor(data.rect)
      } else if (data.reason === 'minimized' || data.reason === 'offscreen' || data.reason === 'rect-failed') {
        // 宿主最小化 / 暂时离屏：保留绑定，狐狸就地等着，别把绑定也丢了
      } else {
        await unbind()
      }
    } catch (err) {}
  }, every)
}

// 重建上次的绑定：重启浮层（或更新后）不用再拖一次。
// 只认「窗口还在」的那条——进程重启后 hwnd 失效，就不要恢复，免得狐狸挂在空处。
async function restoreBinding() {
  if (!base) return
  try {
    const r = await (await fetch(base + '/bindings', { cache: 'no-store' })).json()
    const list = (r.bindings || []).filter((b) => b.window && b.window.hwnd)
    for (const b of list) {
      const rectRes = await fetch(base + '/rect?hwnd=' + encodeURIComponent(b.window.hwnd), { cache: 'no-store' })
      const rect = await rectRes.json()
      const rectOk = rect.ok && rect.rect && plausibleRect(rect.rect)
      // 窗口只是最小化/暂时离屏：绑定仍然有效，先认领，等它回来再摆位置。
      // 只有读不到矩形（窗口已经关了）才放弃这条绑定。
      const transient = rect.reason === 'minimized' || rect.reason === 'offscreen' || rect.reason === 'rect-failed'
      if (!rectOk && !transient) continue
      const det = await (
        await fetch(
          base +
            '/resolve?exe=' + encodeURIComponent(b.window.exe || '') +
            '&title=' + encodeURIComponent(b.window.title || ''),
          { cache: 'no-store' }
        )
      ).json()
      boundKey = b.key
      boundHwnd = b.window.hwnd
      turnFingerprint = null
      boundAdapter = det.ok ? det.adapter : { id: b.adapterId, name: b.adapterId }
      boundAnchor = b.anchor && typeof b.anchor === 'object' ? b.anchor : null
      document.body.dataset.boundKey = boundKey
      document.body.dataset.boundTitle = b.window.title || ''
      document.body.dataset.adapterId = boundAdapter.id
      document.body.dataset.restored = '1'
      fox.title = '已恢复绑定：' + (b.window.title || b.window.exe) + '（' + boundAdapter.name + '）'
      updateChipVisibility()
      renderChip(null)
      startBilling()
      if (rectOk) placeByAnchor(rect.rect)
      return true
    }
  } catch (err) {}
  return false
}

// 初始位置：右下角（先按默认缩放摆一次，设置回来后会重算）
place(window.innerWidth - foxSize() - 28, window.innerHeight - foxSize() - 96)
applyScale()
loadSettings()
restoreBinding()
