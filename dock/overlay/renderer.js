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
const chipDot = document.getElementById('chip-dot')
const petMenu = document.getElementById('pet-menu')
const panelAccent = document.getElementById('panel-accent')
const panelFresh = document.getElementById('panel-fresh')
const foxBadge = document.getElementById('fox-badge')

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
  theme: 'auto',
  displayMode: 'auto',
  autoRole: true,
  rolesByAdapter: {},
  showWeek: true,
  petMode: false,
  updateManifestUrl: '',
  autoUpdate: false,
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

// 与挂件线同款响应式基准：
//   clamp(122px, min(250px, min(100vw,100vh) * 0.28) * scale, 625px)
// 2560×1600 / 150% 下视口约 1020px 高 → 250px 基准；小屏回落到 122px。
// 之前固定 128px，只有原挂件的一半大，属于明确的观感回归。
const FOX_MIN = 122
const FOX_MAX = 250
const FOX_CAP = 625

// 每个宿主的默认角色：绑定后自动换人，但用户可以在「角色」页按宿主覆盖。
const ADAPTER_DEFAULT_ROLE = {
  zcode: 'fox',
  workbuddy: 'xiaoke',
  kimi: 'kimi',
  dsh: 'whale',
  generic: 'fox',
}

function foxSize() {
  const viewport = Math.min(window.innerWidth, window.innerHeight)
  const base = Math.max(FOX_MIN, Math.min(FOX_MAX, viewport * 0.28))
  const scaled = base * (Number(settings.scale) || 1)
  return Math.round(Math.max(FOX_MIN, Math.min(FOX_CAP, scaled)))
}

// 缩放只改两个 CSS 变量，几何全部由它们算（狐狸、卡片、面板定位都读 foxSize）
function applyScale() {
  const size = foxSize()
  document.documentElement.style.setProperty('--fox-size', size + 'px')
  document.documentElement.style.setProperty('--fox-font', Math.round(size * 0.654) + 'px')
}

// ---------- 主题与强调色 ----------

const themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null

function resolvedTheme() {
  if (settings.theme === 'light') return 'light'
  if (settings.theme === 'dark') return 'dark'
  return themeMedia && themeMedia.matches ? 'dark' : 'light'
}

function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme()
}

function roleAccent(id) {
  const role = (window.FOX_ROLES || {})[id]
  return (role && role.accent) || '#f0a04b'
}

function applyAccent(accent) {
  document.documentElement.style.setProperty('--accent', accent || roleAccent(roleId))
}

if (themeMedia) {
  const onChange = () => {
    if (settings.theme === 'auto') {
      applyTheme()
      if (panelOpen) renderPanel(lastSummary, lastBindings)
    }
  }
  if (themeMedia.addEventListener) themeMedia.addEventListener('change', onChange)
  else if (themeMedia.addListener) themeMedia.addListener(onChange)
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

function showSay(text, ms, big) {
  if (!text) return
  sayText.textContent = text
  // 「挑经句」很短，放大成一句有存在感的开场白；普通台词保持 13px。
  sayEl.classList.toggle('big', !!big || String(text).length <= 12)
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

// 当前宿主该用哪个角色：
//   用户按宿主指定 > 宿主适配器默认 > 设置里的全局角色
function roleForAdapter(adapterId) {
  const map = settings.rolesByAdapter || {}
  if (adapterId && map[adapterId] && FOX_ROLES[map[adapterId]]) return map[adapterId]
  if (settings.autoRole && adapterId && ADAPTER_DEFAULT_ROLE[adapterId]) return ADAPTER_DEFAULT_ROLE[adapterId]
  return settings.roleId
}

// 透明边的命中掩码：64×64 alpha 位图，由主进程用 nativeImage 采样。
// 没有掩码时退回包围盒（旧行为），不会因为取不到掩码而让角色变得点不到。
let alphaMask = null
let alphaRole = ''
async function loadAlphaMask(id) {
  try {
    const api = window.foxOverlay
    const m = api && typeof api.getAlphaMask === 'function' ? await api.getAlphaMask(id) : null
    if (m && m.ok && Array.isArray(m.data)) {
      alphaMask = m
      alphaRole = id
    } else {
      alphaMask = null
      alphaRole = ''
    }
  } catch (err) {
    alphaMask = null
    alphaRole = ''
  }
}

// 换角色：立绘做一次淡入；speak=true 时说这个角色的「挑经句」
function applyRole(id, speak) {
  const role = foxRoleOf(id)
  if (!role) return
  const changed = roleId !== role.id
  roleId = role.id
  loadAlphaMask(role.id)
  applyAccent(role.accent)
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
  if (speak) showSay(pickLine(role.pick.length ? role.pick : role.lines), 6200, true)
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
      if (settings.petMode && boundKey) unbind()
      if (settings.autoUpdate && settings.updateManifestUrl) checkUpdate(false)
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
  applyTheme()
  const wantedRole = boundAdapter ? roleForAdapter(boundAdapter.id) : settings.roleId
  applyRole(wantedRole)
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
  const sym = m.currency === 'CNY' ? '¥' : m.currency === 'USD' ? '$' : m.currency === 'CREDIT' ? '' : (m.currency || '') + ' '
  const tail = m.currency === 'CREDIT' ? ' 积分' : ''
  const abs = Math.abs(m.amount)
  // 极小的一轮（<1 分）保留 4 位，避免显示成 ¥0.00 让人以为没花钱
  const digits = abs > 0 && abs < 0.01 ? 4 : 2
  return sym + m.amount.toFixed(digits) + tail
}

function fmtPct(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  return (Math.round(n * 10) / 10).toFixed(n < 10 ? 1 : 0).replace(/\.0$/, '') + '%'
}

function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M'
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K'
  return String(Math.round(v))
}

function fmtReset(v) {
  if (!v) return ''
  const ms = typeof v === 'number' ? v : Date.parse(String(v))
  if (!Number.isFinite(ms)) return ''
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch (err) {
    return ''
  }
}

function freshLabel(snap) {
  if (!snap || !snap.capturedAt) return ''
  const sec = Math.max(0, Math.round((Date.now() - Number(snap.capturedAt)) / 1000))
  if (sec < 5) return '刚刚更新'
  if (sec < 60) return sec + ' 秒前'
  return Math.round(sec / 60) + ' 分钟前'
}

// 主数字口径：
//   auto  → 有今日消耗就先看今日，其次看额度剩余，最后看余额
//   today / balance / quota → 用户明确指定
function mainMetric(snap) {
  if (!snap || !snap.ok) return null
  const mode = settings.displayMode || 'auto'
  const hasToday = snap.today && typeof snap.today.amount === 'number'
  const q = snap.quota || {}
  const hasQuota = typeof q.remainingPct === 'number'
  const hasBalance = snap.balance && typeof snap.balance.amount === 'number'
  if (mode === 'today' && hasToday) return { kind: 'today', text: fmtMoney(snap.today) || fmtNum(snap.today.amount) }
  if (mode === 'balance' && hasBalance) return { kind: 'balance', text: fmtMoney(snap.balance) }
  if (mode === 'quota' && hasQuota) return { kind: 'quota', text: '余 ' + fmtPct(q.remainingPct) }
  if (hasToday) return { kind: 'today', text: fmtMoney(snap.today) || fmtNum(snap.today.amount) + (snap.unit === 'credit' ? ' 积分' : '') }
  if (hasQuota) return { kind: 'quota', text: '余 ' + fmtPct(q.remainingPct) }
  if (hasBalance) return { kind: 'balance', text: fmtMoney(snap.balance) }
  const card = snap.quotaCard
  if (card && card.kind === 'plan') return { kind: 'plan', text: card.plan || '无额度窗口' }
  return null
}

// 卡片副标题：让「余额 / 套餐 / 上一轮」在一行里能看懂
function chipSub(snap) {
  if (!snap || !snap.ok) return ''
  const card = snap.quotaCard
  const parts = []
  if (card) {
    if (card.kind === 'balance' && card.balance) parts.push('余额 ' + fmtMoney(card.balance))
    else if (card.kind === 'windows' && card.windows && card.windows.length) {
      let worst = card.windows[0]
      for (const w of card.windows) if ((w.remainingPct || 0) < (worst.remainingPct || 0)) worst = w
      parts.push(worst.label + ' 余 ' + fmtPct(worst.remainingPct))
    } else if (card.kind === 'plan') {
      // 套餐名和宿主同名时（ZCode / WorkBuddy）不重复；有上一轮就显示上一轮。
      if (snap.turn) parts.push('上一轮 ' + (fmtMoney(snap.turn) || fmtNum(snap.turn.amount)))
      else if (card.plan && card.plan !== snap.adapterName) parts.push(card.plan)
    }
  }
  if (!parts.length && snap.turn) parts.push('上一轮 ' + (fmtMoney(snap.turn) || fmtNum(snap.turn.amount)))
  return parts.join(' · ')
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
  if (chipDot) {
    const accent = (boundAdapter && boundAdapter.accent) || (snap && snap.adapterId === 'dsh' ? '#4d6bfe' : '')
    if (accent) chipDot.style.background = accent
    else chipDot.style.removeProperty('background')
  }
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
  } else {
    const main = mainMetric(snap)
    // 主数字已经是余额/套餐时，副标题不再重复一遍同样的内容
    const sub = main && (main.kind === 'balance' || main.kind === 'plan') ? '' : chipSub(snap)
    if (main) {
      const prefix = main.kind === 'today' ? '今日 ' : main.kind === 'balance' ? '余额 ' : ''
      chipValue.textContent = prefix + main.text + (sub ? ' · ' + sub : '')
    } else {
      chipValue.textContent = sub || '已连接'
    }
    const tips = []
    if (snap.today) tips.push('今日 ' + (fmtMoney(snap.today) || fmtNum(snap.today.amount)))
    if (snap.turn) tips.push('上一轮 ' + (fmtMoney(snap.turn) || fmtNum(snap.turn.amount)))
    if (snap.balance) tips.push('余额 ' + fmtMoney(snap.balance))
    if (snap.quota && typeof snap.quota.remainingPct === 'number') tips.push('额度剩余 ' + fmtPct(snap.quota.remainingPct))
    if (snap.plan) tips.push('套餐 ' + snap.plan)
    if (tips.length) chip.title = tips.join('\n')
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

const PANEL_TABS = ['detail', 'quota', 'vendors', 'usage', 'roles', 'settings', 'about']
const TAB_TITLES = { detail: '', quota: '额度', vendors: '厂商', usage: '用量', roles: '角色', settings: '设置', about: '关于' }

let aboutDiag = null
let aboutLoading = false
let aboutError = ''
let detectedAgents = []
let detectedAt = 0
let detectionHinted = false
// 全厂商面板：复用同机挂件线的 /whale/vendors.json。
let vendorState = {
  adapter: '',
  loading: false,
  error: '',
  source: null,
  services: [],
  vendors: [],
  showAll: false,
}
let vendorSeq = 0
let updateState = null
let updateLoading = false

function setActiveTab(tab) {
  activeTab = PANEL_TABS.includes(tab) ? tab : 'detail'
  document.body.dataset.tab = activeTab
  for (const b of document.querySelectorAll('#panel .panel-tabs button')) {
    b.classList.toggle('active', b.dataset.tab === activeTab)
  }
}

function renderPanel(summary, bindings) {
  if (summary) lastSummary = summary
  if (bindings) lastBindings = bindings
  const name = (boundAdapter && boundAdapter.name) || '未绑定'
  panelTitle.textContent = activeTab === 'detail' ? name : TAB_TITLES[activeTab] || '面板'
  if (panelAccent) panelAccent.style.background = (boundAdapter && boundAdapter.accent) || roleAccent(roleId)
  if (panelFresh) panelFresh.textContent = lastSnapshot ? freshLabel(lastSnapshot) : ''
  setActiveTab(activeTab)
  clearNode(panelBody)
  if (activeTab === 'settings') renderSettings()
  else if (activeTab === 'about') renderAbout()
  else if (activeTab === 'quota') renderQuota()
  else if (activeTab === 'vendors') renderVendors()
  else if (activeTab === 'usage') renderUsage()
  else if (activeTab === 'roles') renderRoles()
  else renderDetail()
  positionPanel()
}

function sectionTitle(text, side) {
  const h = document.createElement('div')
  h.className = 'section-title'
  const a = document.createElement('span')
  a.textContent = text
  h.appendChild(a)
  if (side) {
    const b = document.createElement('span')
    b.className = 'side'
    b.textContent = side
    h.appendChild(b)
  }
  return h
}

function metricCard(k, v, s) {
  const d = document.createElement('div')
  d.className = 'metric'
  const a = document.createElement('div')
  a.className = 'k'
  a.textContent = k
  const b = document.createElement('div')
  b.className = 'v'
  b.textContent = v
  d.appendChild(a)
  d.appendChild(b)
  if (s) {
    const c = document.createElement('div')
    c.className = 's'
    c.textContent = s
    d.appendChild(c)
  }
  return d
}

function quotaCardEl(card, compact) {
  if (!card) return null
  const box = document.createElement('div')
  box.className = 'quota-card'

  const head = document.createElement('div')
  head.className = 'quota-head'
  const left = document.createElement('div')
  const title = document.createElement('div')
  title.className = 'qtitle'
  title.textContent = card.title || '额度'
  const sub = document.createElement('div')
  sub.className = 'qsub'
  sub.textContent = card.subtitle || ''
  left.appendChild(title)
  if (card.subtitle) left.appendChild(sub)
  head.appendChild(left)
  // plan 卡的主体已经是大号套餐名，标题右侧不再重复一枚同样的徽章
  if (card.kind !== 'plan' && (card.plan || card.account)) {
    const plan = document.createElement('span')
    plan.className = 'qplan'
    plan.textContent = card.plan || card.account
    head.appendChild(plan)
  }
  box.appendChild(head)

  if (card.kind === 'windows') {
    const windows = card.windows || []
    let worst = windows[0]
    for (const w of windows) if ((w.remainingPct || 0) < (worst.remainingPct || 0)) worst = w
    if (windows.length === 1 && worst) {
      const big = document.createElement('div')
      big.className = 'quota-big'
      const num = document.createElement('div')
      num.className = 'num'
      num.textContent = fmtPct(worst.remainingPct)
      const small = document.createElement('small')
      small.textContent = '剩余'
      num.appendChild(small)
      big.appendChild(num)
      const side = document.createElement('div')
      side.className = 'side'
      side.textContent = (worst.label || '窗口') + (fmtReset(worst.resetAt) ? ' · ' + fmtReset(worst.resetAt) + ' 重置' : '')
      big.appendChild(side)
      box.appendChild(big)
    } else if (worst) {
      const big = document.createElement('div')
      big.className = 'quota-big'
      const num = document.createElement('div')
      num.className = 'num'
      num.textContent = fmtPct(worst.remainingPct)
      const small = document.createElement('small')
      small.textContent = worst.label + ' 剩余'
      num.appendChild(small)
      big.appendChild(num)
      const side = document.createElement('div')
      side.className = 'side'
      side.textContent = windows.length + ' 个窗口'
      big.appendChild(side)
      box.appendChild(big)
    }
    for (const w of windows) {
      const rowEl = document.createElement('div')
      rowEl.className = 'qwin'
      const wh = document.createElement('div')
      wh.className = 'qwin-head'
      const label = document.createElement('span')
      label.className = 'qwin-label'
      label.textContent = w.label
      const pctEl = document.createElement('span')
      pctEl.className = 'qwin-pct' + ((w.remainingPct || 0) <= 5 ? ' critical' : (w.remainingPct || 0) <= 20 ? ' high' : '')
      pctEl.textContent = '已用 ' + fmtPct(w.usedPct) + ' · 余 ' + fmtPct(w.remainingPct)
      wh.appendChild(label)
      wh.appendChild(pctEl)
      rowEl.appendChild(wh)
      const bar = document.createElement('div')
      bar.className = 'qbar'
      const fill = document.createElement('i')
      fill.style.width = Math.max(0, Math.min(100, Number(w.usedPct) || 0)) + '%'
      bar.appendChild(fill)
      rowEl.appendChild(bar)
      const reset = fmtReset(w.resetAt)
      if (reset || w.detail) {
        const meta = document.createElement('div')
        meta.className = 'qwin-meta'
        meta.textContent = (reset ? reset + ' 重置' : '') + (w.detail ? (reset ? ' · ' : '') + w.detail : '')
        rowEl.appendChild(meta)
      }
      box.appendChild(rowEl)
    }
  } else if (card.kind === 'balance') {
    const big = document.createElement('div')
    big.className = 'balance-big'
    if (card.balance) {
      const cur = document.createElement('span')
      cur.className = 'cur'
      cur.textContent = card.balance.currency === 'CNY' ? '¥' : card.balance.currency === 'USD' ? '$' : card.balance.currency
      const amt = document.createElement('span')
      amt.className = 'amt'
      amt.textContent = Number(card.balance.amount).toFixed(2)
      big.appendChild(cur)
      big.appendChild(amt)
      const meta = document.createElement('div')
      meta.className = 'balance-meta'
      meta.textContent = '可用余额'
      big.appendChild(meta)
    } else {
      const amt = document.createElement('span')
      amt.className = 'amt'
      amt.textContent = '—'
      big.appendChild(amt)
    }
    box.appendChild(big)
  } else if (card.kind === 'plan') {
    const line = document.createElement('div')
    line.className = 'plan-line'
    const icon = document.createElement('div')
    icon.className = 'plan-icon'
    icon.textContent = (card.plan || 'P').slice(0, 1).toUpperCase()
    const main = document.createElement('div')
    const name = document.createElement('div')
    name.className = 'plan-name'
    name.textContent = card.plan || card.subtitle || '未开通套餐'
    const sub = document.createElement('div')
    sub.className = 'plan-sub'
    sub.textContent = card.account || '没有可读的额度窗口'
    main.appendChild(name)
    main.appendChild(sub)
    line.appendChild(icon)
    line.appendChild(main)
    box.appendChild(line)
  } else if (card.kind === 'error') {
    const line = document.createElement('div')
    line.className = 'plan-line'
    const icon = document.createElement('div')
    icon.className = 'plan-icon'
    icon.textContent = '!'
    const main = document.createElement('div')
    const name = document.createElement('div')
    name.className = 'plan-name'
    name.textContent = '额度读取失败'
    const sub = document.createElement('div')
    sub.className = 'plan-sub'
    sub.textContent = card.message || card.note || ''
    main.appendChild(name)
    main.appendChild(sub)
    line.appendChild(icon)
    line.appendChild(main)
    box.appendChild(line)
  }

  if (card.note && !compact) {
    const note = document.createElement('div')
    note.className = 'quota-note'
    note.textContent = card.note
    box.appendChild(note)
  }
  return box
}

// ---------- 总览 ----------

function matchesFilter(name, date) {
  const q = filterText.trim().toLowerCase()
  if (!q) return true
  return String(name || '').toLowerCase().includes(q) || String(date || '').includes(q)
}

function searchBox() {
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
  return wrap
}

function renderUnbound() {
  const hero = document.createElement('div')
  hero.className = 'hero'
  const avatar = document.createElement('div')
  avatar.className = 'hero-avatar'
  const img = document.createElement('img')
  img.src = foxRoleOf(roleId).image
  img.alt = ''
  avatar.appendChild(img)
  const main = document.createElement('div')
  main.className = 'hero-main'
  const name = document.createElement('div')
  name.className = 'hero-name'
  name.textContent = '还没有吸附'
  const sub = document.createElement('div')
  sub.className = 'hero-sub'
  sub.textContent = detectedAgents.length
    ? '检测到 ' + detectedAgents.length + ' 个 agent，拖我过去或点下面的按钮'
    : '拖到任意 agent 窗口上，我会自动识别计费口径'
  main.appendChild(name)
  main.appendChild(sub)
  const value = document.createElement('div')
  value.className = 'hero-value'
  value.textContent = detectedAgents.length ? String(detectedAgents.length) + ' 个' : '待绑定'
  if (detectedAgents.length) {
    value.appendChild(Object.assign(document.createElement('small'), { textContent: '检测到' }))
  }
  hero.appendChild(avatar)
  hero.appendChild(main)
  hero.appendChild(value)
  panelBody.appendChild(hero)

  if (detectedAgents.length) {
    panelBody.appendChild(sectionTitle('检测到的 agent', '点击直接吸附'))
    for (const agent of detectedAgents) {
      const r = document.createElement('div')
      r.className = 'panel-binding'
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = agent.adapter.name + ' · ' + (agent.title || agent.exe || '')
      label.title = agent.title || agent.exe || ''
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn primary'
      btn.textContent = '吸附'
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        bindDetected(agent)
      })
      r.appendChild(label)
      r.appendChild(btn)
      panelBody.appendChild(r)
    }
  } else {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '暂未检测到 agent 窗口。打开 ZCode / WorkBuddy / Kimi Code / DeepSeek Harness 后再点「重新识别」。'
    panelBody.appendChild(empty)
  }

  const actions = document.createElement('div')
  actions.className = 'panel-actions'
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.textContent = '重新识别'
  refresh.addEventListener('click', (e) => {
    e.stopPropagation()
    refreshAgents(true)
  })
  actions.appendChild(refresh)
  panelBody.appendChild(actions)

  panelBody.appendChild(sectionTitle('今日总览', lastSummary && lastSummary.today ? lastSummary.today.date : ''))
  const list = document.createElement('div')
  list.id = 'detail-list'
  panelBody.appendChild(list)
  renderDetailList()
}

function renderDetail() {
  if (!boundKey) {
    renderUnbound()
    return
  }
  const snap = lastSnapshot
  const boundTitle = document.body.dataset.boundTitle || ''
  const role = foxRoleOf(roleId)

  const hero = document.createElement('div')
  hero.className = 'hero'
  const avatar = document.createElement('div')
  avatar.className = 'hero-avatar'
  const img = document.createElement('img')
  img.src = role.image
  img.alt = ''
  avatar.appendChild(img)
  const main = document.createElement('div')
  main.className = 'hero-main'
  const name = document.createElement('div')
  name.className = 'hero-name'
  name.textContent = (boundAdapter && boundAdapter.name) || '已绑定'
  const badge = document.createElement('span')
  badge.className = 'badge ' + (!snap ? '' : !snap.supported ? 'warn' : !snap.ok ? 'bad' : 'live')
  badge.textContent = !snap ? '读取中' : !snap.supported ? '不计费' : !snap.ok ? '异常' : '已连接'
  name.appendChild(badge)
  const sub = document.createElement('div')
  sub.className = 'hero-sub'
  sub.textContent = boundTitle || (role && role.name) || ''
  sub.title = boundTitle
  main.appendChild(name)
  main.appendChild(sub)
  const value = document.createElement('div')
  value.className = 'hero-value'
  const main2 = mainMetric(snap)
  value.textContent = main2 ? main2.text : lastSnapshot ? '—' : '读取中…'
  const small = document.createElement('small')
  small.textContent = main2 && main2.kind === 'today' ? '今日' : main2 && main2.kind === 'balance' ? '余额' : main2 && main2.kind === 'quota' ? '额度' : ''
  value.appendChild(small)
  hero.appendChild(avatar)
  hero.appendChild(main)
  hero.appendChild(value)
  panelBody.appendChild(hero)

  if (snap && snap.supported && snap.ok) {
    const grid = document.createElement('div')
    grid.className = 'metric-grid'
    grid.appendChild(metricCard('今日', snap.today ? fmtMoney(snap.today) || fmtNum(snap.today.amount) + ' 积分' : '—', snap.today && snap.usage ? fmtTokens(snap.usage.todayTokens) + ' tokens' : ''))
    grid.appendChild(metricCard('上一轮', snap.turn ? fmtMoney(snap.turn) || fmtNum(snap.turn.amount) + ' 积分' : '—', snap.usage ? fmtTokens(snap.usage.turnTokens) + ' tokens' : ''))
    const q = snap.quota || {}
    grid.appendChild(
      metricCard(
        typeof q.remainingPct === 'number' ? '额度剩余' : snap.balance ? '余额' : '套餐',
        typeof q.remainingPct === 'number' ? fmtPct(q.remainingPct) : snap.balance ? fmtMoney(snap.balance) : snap.plan || '—',
        typeof q.usedPct === 'number' ? '已用 ' + fmtPct(q.usedPct) : ''
      )
    )
    panelBody.appendChild(grid)

    const card = quotaCardEl(snap.quotaCard)
    if (card) panelBody.appendChild(card)

    if (snap.account || snap.plan) {
      const account = document.createElement('div')
      account.className = 'account-card'
      const dot = document.createElement('div')
      dot.className = 'account-dot'
      dot.textContent = ((boundAdapter && boundAdapter.name) || 'A').slice(0, 1).toUpperCase()
      const box = document.createElement('div')
      box.className = 'account-main'
      const n = document.createElement('div')
      n.className = 'account-name'
      n.textContent = snap.account || snap.plan || '已连接'
      const s = document.createElement('div')
      s.className = 'account-sub'
      s.textContent = [snap.plan, snap.source].filter(Boolean).join(' · ')
      box.appendChild(n)
      box.appendChild(s)
      account.appendChild(dot)
      account.appendChild(box)
      panelBody.appendChild(account)
    }

    if (snap.details && snap.details.length) {
      panelBody.appendChild(sectionTitle('明细'))
      const sec = document.createElement('div')
      sec.className = 'panel-sec'
      for (const d of snap.details) sec.appendChild(row(d.label, d.value, d.hint))
      panelBody.appendChild(sec)
    }
    if (snap.source) {
      const sec = document.createElement('div')
      sec.className = 'panel-sec'
      sec.appendChild(row('数据源', snap.source, '适配器读取的本机数据源'))
      panelBody.appendChild(sec)
    }
  } else if (snap && !snap.supported) {
    const sec = document.createElement('div')
    sec.className = 'panel-sec'
    sec.appendChild(row('计费', '暂不支持'))
    sec.appendChild(row('说明', '只做吸附与跟随，不猜数字'))
    sec.appendChild(row('窗口', boundTitle || '—'))
    panelBody.appendChild(sec)
  } else if (snap && !snap.ok) {
    const sec = document.createElement('div')
    sec.className = 'panel-sec'
    sec.appendChild(row('状态', '读取失败'))
    sec.appendChild(row('原因', snap.error || '未知'))
    sec.appendChild(row('窗口', boundTitle || '—'))
    panelBody.appendChild(sec)
  } else {
    const sec = document.createElement('div')
    sec.className = 'panel-sec'
    sec.appendChild(row('状态', '读取中…'))
    sec.appendChild(row('窗口', boundTitle || '—'))
    panelBody.appendChild(sec)
  }

  panelBody.appendChild(searchBox())
  const list = document.createElement('div')
  list.id = 'detail-list'
  panelBody.appendChild(list)
  renderDetailList()

  const actions = document.createElement('div')
  actions.className = 'panel-actions'
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.textContent = '刷新'
  refresh.addEventListener('click', (e) => {
    e.stopPropagation()
    refreshBilling()
    refreshSummary()
  })
  actions.appendChild(refresh)
  const rescan = document.createElement('button')
  rescan.type = 'button'
  rescan.textContent = '重新识别'
  rescan.addEventListener('click', (e) => {
    e.stopPropagation()
    refreshAgents(true)
  })
  actions.appendChild(rescan)
  const un = document.createElement('button')
  un.type = 'button'
  un.className = 'danger'
  un.textContent = '解绑这个窗口'
  un.addEventListener('click', (e) => {
    e.stopPropagation()
    unbind().then(() => togglePanel(false))
  })
  actions.appendChild(un)
  panelBody.appendChild(actions)
}

// ---------- 额度 ----------

function renderQuota() {
  if (!boundKey) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '先吸附一个 agent 窗口，才能看到它的额度口径。'
    panelBody.appendChild(empty)
    return
  }
  const snap = lastSnapshot
  if (!snap) {
    panelBody.appendChild(row('状态', '读取中…'))
    return
  }
  if (!snap.supported) {
    panelBody.appendChild(row('状态', '暂不支持计费'))
    panelBody.appendChild(row('说明', '这个窗口没有额度适配器'))
    return
  }
  if (!snap.ok) {
    panelBody.appendChild(row('状态', '读取失败'))
    panelBody.appendChild(row('原因', snap.error || '未知'))
    return
  }
  const card = quotaCardEl(snap.quotaCard, false)
  if (card) panelBody.appendChild(card)
  else {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '这个适配器没有提供额度卡；今日消耗与上一轮见「总览」。'
    panelBody.appendChild(empty)
  }
  if (snap.details && snap.details.length) {
    panelBody.appendChild(sectionTitle('额度明细'))
    for (const d of snap.details) panelBody.appendChild(row(d.label, d.value, d.hint))
  }
  panelBody.appendChild(row('数据源', snap.source || '—'))
  panelBody.appendChild(row('更新时间', freshLabel(snap)))
}

// ---------- 全厂商（复用挂件线服务） ----------

function pct01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n * 1000) / 10))
}

function vendorKindLabel(v) {
  if (v.kind === 'balance') return '余额'
  if (v.kind === 'cmdgo') return '套餐 · 三重额度'
  if (v.kind === 'local-log' || v.kind === 'quota') return '套餐'
  if (v.kind === 'tokens') return '按量计价'
  return v.kind || '额度'
}

function vendorCard(v) {
  if (!v.available) {
    const rowEl = document.createElement('div')
    rowEl.className = 'vendor-unavailable'
    rowEl.dataset.vendor = v.id
    const name = document.createElement('span')
    name.className = 'vname'
    name.textContent = v.name
    const reason = document.createElement('span')
    reason.className = 'vreason'
    reason.textContent = v.reason || '未配置'
    reason.title = v.reason || ''
    rowEl.appendChild(name)
    rowEl.appendChild(reason)
    return rowEl
  }

  let card = null
  if (v.kind === 'balance' && typeof v.balance === 'number') {
    const sub = typeof v.todayUsage === 'number' ? '今日 ' + fmtMoney({ amount: v.todayUsage, currency: v.currency }) : ''
    card = quotaCardEl(
      {
        kind: 'balance',
        title: v.name,
        subtitle: vendorKindLabel(v),
        balance: { amount: v.balance, currency: v.currency || 'CNY' },
        note: [sub, v.note].filter(Boolean).join(' · '),
      },
      false
    )
  } else if (v.kind === 'cmdgo') {
    const windows = []
    for (const [label, w] of [['本月', v.monthly], ['5 小时', v.fiveHour], ['本周', v.weekly]]) {
      if (!w) continue
      let used = pct01(w.percent)
      if (used === null && typeof w.cap === 'number' && w.cap > 0 && typeof w.used === 'number') used = pct01(w.used / w.cap)
      if (used === null) continue
      windows.push({
        label,
        usedPct: used,
        remainingPct: Math.round((100 - used) * 10) / 10,
        resetAt: w.resetAt,
      })
    }
    card = quotaCardEl(
      {
        kind: windows.length ? 'windows' : 'plan',
        title: v.name,
        subtitle: v.planName ? v.planName + ' 套餐' : '套餐额度',
        plan: v.planName,
        account: v.account,
        windows,
        note: v.pool && v.pool.total ? '账号池 ' + (v.pool.available || 0) + '/' + v.pool.total + ' 可用 · ' + (v.note || '') : v.note,
      },
      false
    )
  } else if (v.kind === 'local-log' || v.kind === 'quota') {
    const rem = pct01(v.percentRemaining)
    const windows =
      rem === null
        ? []
        : [
            {
              label: '套餐',
              usedPct: Math.round((100 - rem) * 10) / 10,
              remainingPct: rem,
              resetAt: v.nextResetAt,
              detail:
                typeof v.remaining === 'number' && typeof v.total === 'number'
                  ? fmtNum(v.remaining) + ' / ' + fmtNum(v.total) + ' tokens'
                  : '',
            },
          ]
    card = quotaCardEl(
      {
        kind: windows.length ? 'windows' : 'plan',
        title: v.name,
        subtitle: vendorKindLabel(v),
        windows,
        note: v.note,
      },
      false
    )
  } else {
    card = quotaCardEl(
      {
        kind: 'plan',
        title: v.name,
        subtitle: vendorKindLabel(v),
        plan: v.kind === 'tokens' ? '按量计价' : v.kind,
        note: v.note,
      },
      false
    )
  }
  if (card) card.dataset.vendor = v.id
  return card
}

async function loadVendors(adapter, force) {
  if (!base) return
  const seq = ++vendorSeq
  vendorState.adapter = adapter
  vendorState.loading = true
  vendorState.error = ''
  if (panelOpen && activeTab === 'vendors') renderPanel(lastSummary, lastBindings)
  try {
    const q = '/vendors?adapter=' + encodeURIComponent(adapter) + (force ? '&force=1' : '')
    const r = await (await fetch(base + q, { cache: 'no-store' })).json()
    if (seq !== vendorSeq) return
    vendorState.loading = false
    vendorState.services = Array.isArray(r.services) ? r.services : []
    vendorState.source = r.source || null
    vendorState.vendors = Array.isArray(r.vendors) ? r.vendors : []
    vendorState.error = r.ok ? '' : r.error || r.reason || '读取失败'
  } catch (err) {
    if (seq !== vendorSeq) return
    vendorState.loading = false
    vendorState.error = String((err && err.message) || err)
  }
  if (panelOpen && activeTab === 'vendors') renderPanel(lastSummary, lastBindings)
}

function preferredVendorAdapter() {
  if (boundAdapter && (boundAdapter.id === 'zcode' || boundAdapter.id === 'workbuddy')) return boundAdapter.id
  return 'zcode'
}

function renderVendors() {
  const preferred = preferredVendorAdapter()
  if (!vendorState.adapter) vendorState.adapter = preferred
  if (!vendorState.loading && !vendorState.error && !vendorState.source && !vendorState.vendors.length) {
    loadVendors(vendorState.adapter, false)
  }

  const sourceRow = document.createElement('div')
  sourceRow.className = 'vendor-source'
  const label = document.createElement('span')
  label.className = 'vendor-source-label'
  label.textContent = '数据源'
  const sel = selectControl(
    [
      { value: 'zcode', label: 'ZCode 挂件' },
      { value: 'workbuddy', label: 'WorkBuddy 挂件' },
    ],
    vendorState.adapter,
    (v) => loadVendors(v, false)
  )
  sel.className = 'vendor-select'
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.className = 'btn'
  refresh.textContent = '刷新'
  refresh.addEventListener('click', (e) => {
    e.stopPropagation()
    loadVendors(vendorState.adapter, true)
  })
  sourceRow.appendChild(label)
  sourceRow.appendChild(sel)
  sourceRow.appendChild(refresh)
  panelBody.appendChild(sourceRow)

  if (vendorState.loading) {
    panelBody.appendChild(row('状态', '读取中…'))
    return
  }
  if (vendorState.error) {
    const sec = document.createElement('div')
    sec.className = 'panel-sec'
    sec.appendChild(row('状态', '读取失败'))
    sec.appendChild(row('原因', vendorState.error))
    panelBody.appendChild(sec)
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'btn'
    retry.textContent = '重试'
    retry.style.marginTop = '8px'
    retry.addEventListener('click', (e) => {
      e.stopPropagation()
      loadVendors(vendorState.adapter, true)
    })
    panelBody.appendChild(retry)
    return
  }

  const vendors = vendorState.vendors || []
  const available = vendors.filter((v) => v.available)
  const unavailable = vendors.filter((v) => !v.available)
  if (!available.length && !unavailable.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '挂件线服务没有返回厂商模板。'
    panelBody.appendChild(empty)
    return
  }

  const list = document.createElement('div')
  list.className = 'vendor-list'
  for (const v of available) {
    const card = vendorCard(v)
    if (card) list.appendChild(card)
  }
  if (!available.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没有可读的厂商余额/套餐；下面是未配置的模板。'
    list.appendChild(empty)
  }
  panelBody.appendChild(list)

  if (unavailable.length) {
    const toggle = document.createElement('div')
    toggle.className = 'setting'
    const lab = document.createElement('label')
    lab.textContent = '显示未配置（' + unavailable.length + '）'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = !!vendorState.showAll
    box.addEventListener('change', () => {
      vendorState.showAll = box.checked
      renderPanel(lastSummary, lastBindings)
    })
    toggle.appendChild(lab)
    toggle.appendChild(box)
    panelBody.appendChild(toggle)
    if (vendorState.showAll) {
      const more = document.createElement('div')
      more.className = 'vendor-list'
      for (const v of unavailable) {
        const r = vendorCard(v)
        if (r) more.appendChild(r)
      }
      panelBody.appendChild(more)
    }
  }

  if (vendorState.source) {
    const note = document.createElement('p')
    note.className = 'setting-hint'
    note.textContent =
      '来自 ' + (vendorState.source.app || vendorState.source.adapter) + ' v' + (vendorState.source.version || '?') +
      ' · 端口 ' + vendorState.source.port + '；只读本机接口，凭据不进入 dock。'
    panelBody.appendChild(note)
  }
}

// ---------- 用量 ----------

function renderUsage() {
  panelBody.appendChild(sectionTitle('全部 agent', lastSummary && lastSummary.today ? '今日 · ' + lastSummary.today.date : '今日'))
  panelBody.appendChild(searchBox())
  const list = document.createElement('div')
  list.id = 'detail-list'
  panelBody.appendChild(list)
  renderDetailList()

  if (lastBindings && lastBindings.length) {
    panelBody.appendChild(sectionTitle('绑定管理', lastBindings.length + ' 个窗口'))
    for (const b of lastBindings.slice(0, 8)) {
      const r = document.createElement('div')
      r.className = 'panel-binding'
      const label = document.createElement('span')
      label.className = 'label'
      const title = (b.window && b.window.title) || (b.window && b.window.exe) || b.key
      label.textContent = (b.adapterId || 'generic') + ' · ' + title
      label.title = title
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = b.key === boundKey ? '当前' : '解绑'
      btn.disabled = b.key === boundKey
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        fetch(base + '/bind?key=' + encodeURIComponent(b.key), { method: 'DELETE' })
          .then(() => refreshSummary())
          .catch(() => {})
      })
      r.appendChild(label)
      r.appendChild(btn)
      panelBody.appendChild(r)
    }
  }
}

// ---------- 角色 ----------

function roleDescriptions() {
  return window.FOX_ROLE_DESC || {}
}

function renderRoles() {
  const note = document.createElement('p')
  note.className = 'setting-hint'
  note.textContent = '换角色会同时换立绘、强调色和台词。吸附到不同宿主时，默认换成本宿主的角色；也可以在下面按宿主单独指定。'
  panelBody.appendChild(note)

  const grid = document.createElement('div')
  grid.className = 'role-grid'
  for (const id of FOX_ROLE_ORDER) {
    const role = FOX_ROLES[id]
    const card = document.createElement('div')
    card.className = 'role-card' + (id === roleId ? ' active' : '')
    card.dataset.role = id
    const img = document.createElement('img')
    img.src = role.image
    img.alt = role.name
    const name = document.createElement('div')
    name.className = 'rn'
    name.textContent = role.name
    const tag = document.createElement('div')
    tag.className = 'rt'
    tag.textContent = (roleDescriptions()[id] || role.tag || '').slice(0, 12)
    card.appendChild(img)
    card.appendChild(name)
    card.appendChild(tag)
    card.addEventListener('click', () => {
      const patch = { roleId: id }
      if (boundAdapter) {
        patch.rolesByAdapter = { ...(settings.rolesByAdapter || {}), [boundAdapter.id]: id }
        settings.rolesByAdapter = patch.rolesByAdapter
      }
      settings.roleId = id
      applyRole(id, true)
      saveSettings(patch)
      renderPanel(lastSummary, lastBindings)
    })
    grid.appendChild(card)
  }
  panelBody.appendChild(grid)

  const active = foxRoleOf(roleId)
  panelBody.appendChild(sectionTitle('当前角色', active.name))
  const line = document.createElement('div')
  line.className = 'role-line'
  line.textContent = (active.lines && active.lines.length ? active.lines[0] : '') || '这个角色还没有台词。'
  panelBody.appendChild(line)
  const say = document.createElement('button')
  say.type = 'button'
  say.className = 'btn'
  say.textContent = '说一句'
  say.style.marginTop = '8px'
  say.addEventListener('click', (e) => {
    e.stopPropagation()
    sayRandom()
  })
  panelBody.appendChild(say)

  panelBody.appendChild(sectionTitle('按宿主指定', '留空 = 用默认'))
  const adapterNames = { zcode: 'ZCode', workbuddy: 'WorkBuddy', kimi: 'Kimi Code', dsh: 'DeepSeek Harness' }
  for (const id of ['zcode', 'workbuddy', 'kimi', 'dsh']) {
    if (lastBindings && !lastBindings.some((b) => b.adapterId === id)) {
      // 仍然显示，让用户提前配置
    }
    const map = settings.rolesByAdapter || {}
    const current = map[id] || ''
    panelBody.appendChild(
      settingRow(
        adapterNames[id] || id,
        selectControl(
          [{ value: '', label: '默认（' + (FOX_ROLES[ADAPTER_DEFAULT_ROLE[id]] || FOX_ROLES.fox).name + '）' }].concat(
            FOX_ROLE_ORDER.map((rid) => ({ value: rid, label: FOX_ROLES[rid].name }))
          ),
          current,
          (v) => {
            const next = { ...(settings.rolesByAdapter || {}) }
            if (v) next[id] = v
            else delete next[id]
            settings.rolesByAdapter = next
            saveSettings({ rolesByAdapter: next })
          }
        )
      )
    )
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

  const days = settings.showWeek === false ? [] : (summary && summary.days) || []
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

function textControl(value, placeholder, onChange) {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'url-input'
  input.placeholder = placeholder || ''
  input.value = String(value == null ? '' : value)
  input.addEventListener('change', () => onChange(input.value.trim()))
  return input
}

function renderSettings() {
  const note = document.createElement('p')
  note.className = 'setting-hint'
  note.textContent = '改动立即生效并保存到本机（%LOCALAPPDATA%\\fox-dock\\settings.json）。'
  panelBody.appendChild(note)

  panelBody.appendChild(sectionTitle('外观'))
  panelBody.appendChild(
    settingRow(
      '主题',
      selectControl(
        [
          { value: 'auto', label: '跟随系统' },
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
        ],
        settings.theme,
        (v) => {
          settings.theme = v
          applyTheme()
          saveSettings({ theme: v })
        }
      ),
      '浮层是透明窗，深色主题下用深色卡片。'
    )
  )
  panelBody.appendChild(
    settingRow(
      '角色',
      selectControl(
        FOX_ROLE_ORDER.map((id) => ({ value: id, label: FOX_ROLES[id].name })),
        roleId,
        (v) => {
          const patch = { roleId: v }
          if (boundAdapter) {
            patch.rolesByAdapter = { ...(settings.rolesByAdapter || {}), [boundAdapter.id]: v }
            settings.rolesByAdapter = patch.rolesByAdapter
          }
          settings.roleId = v
          applyRole(v, true)
          saveSettings(patch)
        }
      ),
      '换角色会同时换立绘、强调色和台词；吸附时默认按宿主换人。'
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
      ),
      '标准档约 123px 高（128px 容器）；立绘为 610×610，内容高 587。'
    )
  )
  panelBody.appendChild(
    settingRow(
      '主数字',
      selectControl(
        [
          { value: 'auto', label: '自动' },
          { value: 'today', label: '今日消耗' },
          { value: 'balance', label: '余额' },
          { value: 'quota', label: '额度剩余' },
        ],
        settings.displayMode,
        (v) => {
          settings.displayMode = v
          renderChip(lastSnapshot)
          saveSettings({ displayMode: v })
        }
      ),
      '卡片和面板里优先显示哪个数字。'
    )
  )

  panelBody.appendChild(sectionTitle('行为'))
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
      '宿主窗口移动后，狐狸多久跟过去。'
    )
  )
  panelBody.appendChild(
    settingRow(
      '自动换角色',
      checkboxControl(settings.autoRole, (v) => {
        settings.autoRole = v
        saveSettings({ autoRole: v })
      }),
      '绑定 ZCode / WorkBuddy / Kimi Code / dsh 时自动换成本宿主角色。'
    )
  )
  panelBody.appendChild(
    settingRow(
      '桌宠模式',
      checkboxControl(settings.petMode, (v) => {
        settings.petMode = v
        if (v) unbind().then(() => saveSettings({ petMode: true }))
        else saveSettings({ petMode: false })
      }),
      '开启后不吸附、不跟随窗口，角色可以随意摆在屏幕上；想重新吸附时关掉再拖。'
    )
  )
  panelBody.appendChild(
    settingRow(
      '显示数字卡片',
      checkboxControl(settings.showChip, (v) => saveSettings({ showChip: v })),
      '关掉后只留狐狸，单击仍可看面板。'
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
      '提醒气泡',
      checkboxControl(settings.alertBubble, (v) => saveSettings({ alertBubble: v })),
      '预算 / 额度提醒；关掉后每轮消耗气泡仍按上面的开关走。'
    )
  )
  panelBody.appendChild(
    settingRow(
      '显示 7 天用量',
      checkboxControl(settings.showWeek, (v) => saveSettings({ showWeek: v })),
      '在总览底部显示最近 7 天的跨 agent 汇总。'
    )
  )

  panelBody.appendChild(sectionTitle('提醒阈值'))
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
      '剩余额度低于该百分比时提醒；0 = 关闭。'
    )
  )
  panelBody.appendChild(
    settingRow(
      '滚动条宽度',
      numberControl(settings.scrollGap, { min: 0, max: 60, step: 1 }, (v) => saveSettings({ scrollGap: v })),
      '贴右/下边时留出的距离，避免盖住宿主滚动条（px）。'
    )
  )

  panelBody.appendChild(sectionTitle('更新'))
  panelBody.appendChild(
    settingRow(
      '清单地址',
      textControl(settings.updateManifestUrl, 'https://…/update.json', (v) => saveSettings({ updateManifestUrl: v })),
      '签名清单地址；发布 dock-v* 后填入。留空 = 未配置更新源。'
    )
  )
  panelBody.appendChild(
    settingRow(
      '启动时检查',
      checkboxControl(settings.autoUpdate, (v) => saveSettings({ autoUpdate: v })),
      '启动后自动检查一次；不会自动落盘更新，安装仍走 CLI 的 update --apply。'
    )
  )

  const foot = document.createElement('p')
  foot.className = 'setting-hint'
  foot.textContent = '设置只存在本机；不读取密钥内容，不上传任何数据。'
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

async function checkUpdate(force) {
  if (!base || updateLoading) return
  updateLoading = true
  if (panelOpen && activeTab === 'about') renderPanel(lastSummary, lastBindings)
  try {
    const r = await (await fetch(base + '/update/check' + (force ? '?force=1' : ''), { cache: 'no-store' })).json()
    updateState = r
  } catch (err) {
    updateState = { ok: false, reason: 'network', error: String((err && err.message) || err) }
  }
  updateLoading = false
  if (panelOpen && activeTab === 'about') renderPanel(lastSummary, lastBindings)
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

  panelBody.appendChild(sectionTitle('更新'))
  if (updateLoading) {
    panelBody.appendChild(row('状态', '检查中…'))
  } else if (!updateState) {
    panelBody.appendChild(row('状态', settings.updateManifestUrl ? '未检查' : '未配置更新源'))
  } else if (!updateState.ok) {
    panelBody.appendChild(row('状态', '检查失败'))
    panelBody.appendChild(row('原因', updateState.error || updateState.reason || '未知'))
  } else {
    panelBody.appendChild(row('当前', 'v' + updateState.current))
    panelBody.appendChild(row('最新', 'v' + updateState.latest))
    panelBody.appendChild(row('结果', updateState.hasUpdate ? '有更新' : '已是最新'))
    if (updateState.notes) panelBody.appendChild(row('说明', updateState.notes))
  }
  const check = document.createElement('button')
  check.type = 'button'
  check.className = 'btn'
  check.textContent = '检查更新'
  check.style.marginTop = '8px'
  check.addEventListener('click', (e) => {
    e.stopPropagation()
    checkUpdate(true)
  })
  panelBody.appendChild(check)

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
  const margin = 8
  const gap = 10
  const maxPanel = Math.floor(window.innerHeight * 0.76)
  // 面板必须避开角色：优先放在空间更大的一侧，并把高度限制在该侧可用空间内，
  // 内容超出就滚动。否则面板一开就把角色盖住（真机实测）。
  const below = window.innerHeight - (top + fw + gap) - margin
  const above = top - gap - margin
  const useBelow = below >= above
  const avail = Math.max(140, Math.min(Math.max(below, above), maxPanel))
  panel.style.maxHeight = avail + 'px'
  const pw = panel.offsetWidth || 240
  const ph = Math.min(panel.offsetHeight || 160, avail)
  const x = Math.max(margin, Math.min(left + fw - pw, window.innerWidth - pw - margin))
  let y
  if (useBelow) {
    y = top + fw + gap
    if (y + ph > window.innerHeight - margin) y = Math.max(margin, window.innerHeight - margin - ph)
  } else {
    y = Math.max(margin, top - gap - ph)
  }
  panel.style.left = Math.round(x) + 'px'
  panel.style.top = Math.round(y) + 'px'
}

function updateAgentBadge() {
  if (!foxBadge) return
  if (!boundKey && detectedAgents.length) {
    foxBadge.hidden = false
    foxBadge.textContent = String(detectedAgents.length)
    foxBadge.title = '检测到 ' + detectedAgents.length + ' 个 agent'
  } else {
    foxBadge.hidden = true
  }
}

// 自动识别：向 daemon 要「当前桌面上认得出的 agent 窗口」。
// 只做提示与一键吸附，不自动抢绑——用户拖到哪里才算数。
async function refreshAgents(force) {
  if (!base) return
  try {
    const r = await (await fetch(base + '/agents', { cache: 'no-store' })).json()
    if (!r || !r.ok) return
    detectedAgents = Array.isArray(r.agents) ? r.agents : []
    detectedAt = Date.now()
    updateAgentBadge()
    if (!boundKey && !detectionHinted && detectedAgents.length) {
      detectionHinted = true
      const names = Array.from(new Set(detectedAgents.map((a) => a.adapter.name))).slice(0, 3).join('、')
      showBubble('检测到 ' + detectedAgents.length + ' 个 agent', names + ' · 拖我过去吸附', { ms: 4200 })
    }
    if (force && panelOpen && activeTab === 'detail') renderPanel(lastSummary, lastBindings)
  } catch (err) {}
}

async function bindDetected(agent) {
  if (!agent || !agent.rect || !plausibleRect(agent.rect)) return false
  const tl = windowTopLeft(agent.rect)
  const gap = Math.max(0, Math.min(60, Number(settings.scrollGap) || 0))
  place(tl.x + agent.rect.w / DPR - foxSize() - gap, tl.y)
  const ok = await bind(agent)
  if (ok) {
    updateAgentBadge()
    if (panelOpen) renderPanel(lastSummary, lastBindings)
  }
  return ok
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
    lastBindings = binds.ok ? binds.bindings : lastBindings
    // 设置页/搜索框正在输入时不重建 DOM，否则每 5 秒丢一次焦点
    const active = document.activeElement
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')
    if (data.ok && panelOpen && !typing && ['detail', 'quota', 'usage', 'roles'].includes(activeTab)) {
      renderPanel(data, lastBindings)
    }
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
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false
  if (alphaMask && alphaRole === roleId && r.width > 0 && r.height > 0) {
    const ix = Math.min(alphaMask.width - 1, Math.max(0, Math.floor(((x - r.left) / r.width) * alphaMask.width)))
    const iy = Math.min(alphaMask.height - 1, Math.max(0, Math.floor(((y - r.top) / r.height) * alphaMask.height)))
    return alphaMask.data[iy * alphaMask.width + ix] > 12
  }
  return true
}

function isInside(el, x, y) {
  if (!el || el.hidden) return false
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

// 可交互区域：角色 + 数字卡片 +（打开时的）面板。
// 数字卡片是看得见的按钮，必须接住点击，不能穿透到下面的宿主窗口。
function isOverUI(x, y) {
  if (isOverFox(x, y)) return true
  // 菜单键/徽标是角色的控件，可能落在立绘的透明区上方，不能靠 alpha 判定
  if (isInside(petMenu, x, y)) return true
  if (isInside(foxBadge, x, y)) return true
  if (isInside(chip, x, y)) return true
  if (panelOpen && isInside(panel, x, y)) return true
  return false
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
  // 其它挂件的全屏浮层也是 electron.exe；它们不是 agent 宿主。
  // 按标题排除，避免 bind 到 ZCode/WorkBuddy 的小挂件上。
  if (/electron\.exe$/i.test(win.exe || '') && /小挂件|fox-dock overlay/i.test(win.title || '')) return false
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
  // 宿主窗口比浮层视口更宽/更高时（最大化后右边缘常超出屏幕），
  // 相对锚点算出来的坐标会落到视口外；最终位置必须钳在浮层内，
  // 否则角色会贴着屏幕边缘消失。
  const px = Math.max(0, Math.min(tl.x + x, window.innerWidth - size))
  const py = Math.max(0, Math.min(tl.y + y, window.innerHeight - size))
  place(px, py)
}

async function bind(win) {
  if (!base || settings.petMode) return false
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
      if (boundAdapter.id === 'zcode' || boundAdapter.id === 'workbuddy') {
        vendorState.adapter = boundAdapter.id
        vendorState.source = null
        vendorState.vendors = []
        vendorState.error = ''
      }
      boundAnchor = data.binding.anchor && (data.binding.anchor.h || data.binding.anchor.v || Number.isFinite(data.binding.anchor.hOff)) ? data.binding.anchor : anchor
      document.body.dataset.boundKey = boundKey
      document.body.dataset.boundTitle = win.title || ''
      document.body.dataset.adapterId = boundAdapter.id
      fox.title = '已绑定：' + (win.title || win.exe) + '（' + boundAdapter.name + '）'
      updateChipVisibility()
      renderChip(null)
      startBilling()
      placeByAnchor(win.rect)
      // 吸附到谁就用谁的角色：ZCode→嘎啦嘛、WorkBuddy→小克、
      // Kimi Code→kimi 娘、dsh→大肥鱼；用户可在「角色」页按宿主覆盖。
      applyRole(roleForAdapter(boundAdapter.id), true)
      updateAgentBadge()
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
  applyRole(settings.roleId)
  updateAgentBadge()
  refreshAgents()
}

// 指针在窗口上移动（穿透模式下由 forward 转发）
window.addEventListener('mousemove', (e) => {
  if (dragging || pressing) return
  // 面板打开时整窗可交互（点空白处即收起），其余时候只有狐狸可交互
  if (panelOpen) {
    setInteractive(true)
    return
  }
  setInteractive(isOverUI(e.clientX, e.clientY))
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
    const over = isOverUI(p.x - o.x, p.y - o.y)
    setInteractive(panelOpen || over)
  } catch (err) {}
}, 50)

fox.addEventListener('pointerdown', (e) => {
  // 只响应左键：右键/中键不拖拽、不换台词、不开关面板。
  if (e.button !== 0) return
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
  if (settings.petMode) {
    setArmed(false)
    currentTarget = null
    return
  }
  const now = performance.now()
  if (now - lastHitAt < 30) return
  lastHitAt = now
  hitAt(e.screenX, e.screenY).then((win) => {
    if (!dragging || settings.petMode) return
    window.__foxDebug.hits++
    window.__foxDebug.targets.push(win ? win.title + '#' + win.pid : null)
    currentTarget = win
    setArmed(!!win)
  })
})

window.addEventListener('pointerup', async (e) => {
  if (!pressing) return
  if (e.button !== 0) {
    // 左键按住时又点了别的键：取消这次点击，不触发面板/台词。
    pressing = null
    dragging = false
    fox.classList.remove('dragging')
    setInteractive(isOverUI(e.clientX, e.clientY))
    return
  }
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
    if (!panelOpen) setInteractive(isOverUI(e.clientX, e.clientY))
    return
  }

  const target = currentTarget
  currentTarget = null
  setArmed(false)
  if (settings.petMode) {
    // 桌宠模式：拖到哪就待在哪，不吸附、不跟随、不绑定。
    setInteractive(isOverUI(e.clientX, e.clientY))
    return
  }
  if (target) {
    await bind(target)
  } else if (boundKey) {
    // 拖到空白处松手 = 解绑：狐狸停在这儿，不再跟着原来的窗口跑
    await unbind()
  }
  setInteractive(isOverUI(e.clientX, e.clientY))
})

// 数字卡片：左键打开/收起面板；右键不做事，也不弹系统菜单。
chip.addEventListener('click', (e) => {
  if (e.button !== 0) return
  e.stopPropagation()
  togglePanel()
})
for (const el of [fox, chip, petMenu]) {
  el.addEventListener('contextmenu', (e) => e.preventDefault())
}

// 角色右上角的小菜单按钮：只负责把面板叫出来，不触发拖拽/台词。
if (petMenu) {
  petMenu.addEventListener('pointerdown', (e) => e.stopPropagation())
  petMenu.addEventListener('pointerup', (e) => e.stopPropagation())
  petMenu.addEventListener('click', (e) => {
    e.stopPropagation()
    togglePanel()
  })
}

// 面板打开时点面板外面 → 收起（这一下会被浮层吃掉，和常见菜单一致）
document.addEventListener('mousedown', (e) => {
  if (!panelOpen) return
  if (panel.contains(e.target) || fox.contains(e.target) || chip.contains(e.target)) return
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
    if (activeTab === 'quota' && boundKey) refreshBilling()
    if (activeTab === 'vendors' && !vendorState.loading && !vendorState.source && !vendorState.error) {
      loadVendors(vendorState.adapter || preferredVendorAdapter(), false)
    }
    if (activeTab === 'detail' && !boundKey) refreshAgents()
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
  if (!base || settings.petMode) return false
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
      applyRole(roleForAdapter(boundAdapter.id))
      if (rectOk) placeByAnchor(rect.rect)
      return true
    }
  } catch (err) {}
  return false
}

// 初始位置：右下角（先按默认缩放摆一次，设置回来后会重算）
applyTheme()
applyAccent(roleId)
place(window.innerWidth - foxSize() - 28, window.innerHeight - foxSize() - 96)
applyScale()
loadSettings().then(() => {
  restoreBinding()
  refreshAgents()
})
setInterval(() => {
  if (!boundKey) refreshAgents()
}, 20000)
