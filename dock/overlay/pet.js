// fox-dock 宠物层（2.0 新界面）。
//
// 结构：角色 + 状态胶囊 + 气泡/台词 + 320px 快览卡 + 224px 菜单。
// 数据走 /v1（读用 fetch；写走主进程 daemon-write，渲染层不持有 token）。
// 交互：拖到 agent 窗口吸附；拖到桌面进入「悬浮」并沿用上一个 agent 的档案；
// 四象限贴边、左侧镜像；透明边按 alpha 掩码穿透。

const params = new URLSearchParams(location.search)
const PORT = Number(params.get('port') || 0)
const SELF_PID = Number(params.get('pid') || 0)
const CLICK_THROUGH = params.get('ct') !== '0'
const BASE = PORT ? 'http://127.0.0.1:' + PORT : ''
const IGNORE_PIDS = new Set(
  String(params.get('ignore') || '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
)
const IGNORE_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])

const ADAPTER_ROLES = { zcode: 'fox', workbuddy: 'xiaoke', kimi: 'kimi', dsh: 'whale' }
const ADAPTER_NAMES = { zcode: 'ZCode', workbuddy: 'WorkBuddy', kimi: 'Kimi Code', dsh: 'DeepSeek Harness', generic: '其它' }
const SCALES = [0.75, 1, 1.25, 1.5]

const fox = document.getElementById('fox')
const foxImg = document.getElementById('fox-img')
const foxBadge = document.getElementById('fox-badge')
const petMenuBtn = document.getElementById('pet-menu')
const chip = document.getElementById('chip')
const chipAdapter = document.getElementById('chip-adapter')
const chipValue = document.getElementById('chip-value')
const chipDot = document.getElementById('chip-dot')
const chipRingValue = document.getElementById('chip-ring-value')
const chipUnlink = document.getElementById('chip-unlink')
const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubble-text')
const bubbleSub = document.getElementById('bubble-sub')
const sayEl = document.getElementById('say')
const sayText = document.getElementById('say-text')
const quick = document.getElementById('quick')
const quickDot = document.getElementById('quick-dot')
const quickAgent = document.getElementById('quick-agent')
const quickStatus = document.getElementById('quick-status')
const quickValue = document.getElementById('quick-value')
const quickSub = document.getElementById('quick-sub')
const quickCtxBar = document.getElementById('quick-ctx-bar')
const quickCtxPct = document.getElementById('quick-ctx-pct')
const quickCtxAbs = document.getElementById('quick-ctx-abs')
const quickWindows = document.getElementById('quick-windows')
const quickRefresh = document.getElementById('quick-refresh')
const menu = document.getElementById('menu')
const dragHint = document.getElementById('drag-hint')

let settings = {
  theme: 'auto',
  scale: 1,
  scrollGap: 17,
  scrollGapOn: false,
  followMs: 500,
  roleId: 'fox',
  rolesByAdapter: {},
  profiles: {},
  hideMoney: false,
  dnd: false,
  menuButton: 'hover',
  showChip: true,
  turnBubble: true,
  turnBubbleMs: 5000,
  soundVolume: 0.5,
}
let state = { pet: { mode: 'idle', agentId: '', profileOf: '', lastAgentId: '', hwnd: '', rect: null }, agents: [] }
let snapshot = null
let context = null
let bound = { agentId: '', hwnd: '', title: '', exe: '', pid: 0, startMs: 0, rect: null }
// 吸附锚点：h/v 为 null 表示「窗口内自由位置」，用 hOff/vOff 记相对窗口左上角的偏移。
// 与旧挂件一致：只有拖到窗口外侧四分之一时才吸边，中间区域保持自由摆放。
let anchor = { h: 'right', v: 'bottom', hOff: 0, vOff: 0 }
let pos = { x: 0, y: 0 }
let origin = null
let dragging = false
let pressing = null
let pointer = null
let currentTarget = null
let hitSeq = 0
let lastHintText = ''
let roleId = settings.roleId
let roleCatalog = { ...FOX_ROLES }
let appliedRoleSrc = ''
let quickOpen = false
let menuOpen = false
let bubbleTimer = null
let sayTimer = null
let queue = []
let queueIndex = 0
let hideMoney = false
let alphaMask = null
let alphaRole = ''
let lastSnapshotFingerprint = ''
let followTimer = null
let followEvery = 0
let chatterTimer = null
let lastChatterMs = -1
let petModeFloating = false
let lastInteractive = null
let lastAttach = null
let hitBusy = false
let lastHitAt = 0
let startSnapshotSeen = false

const sounds = {
  press: new Audio('../assets/sounds/Ya1.mp3'),
  release: new Audio('../assets/sounds/Ya2.mp3'),
}
let soundAt = 0
function playSound(kind) {
  if (settings.dnd) return
  const a = sounds[kind]
  if (!a) return
  const now = performance.now()
  if (now - soundAt < 20) return
  soundAt = now
  // 快速连击时先停掉另一个音轨：按压音与松开音各用独立 Audio，
  // 不打断的话两次点击会叠在一起。
  for (const other of Object.values(sounds)) {
    if (other === a) continue
    try {
      other.pause()
      other.currentTime = 0
    } catch (err) {}
  }
  try {
    a.currentTime = 0
    a.volume = Math.max(0, Math.min(1, Number(settings.soundVolume) || 0.5))
    a.play().catch(() => {})
  } catch (err) {}
}

// ---------- API ----------

async function read(pathname) {
  if (!BASE) return null
  try {
    return await (await fetch(BASE + pathname, { cache: 'no-store' })).json()
  } catch (err) {
    return null
  }
}

async function write(pathname, method, body) {
  const api = window.foxOverlay
  if (api && typeof api.write === 'function') return api.write(pathname, method || 'POST', body)
  try {
    return await (
      await fetch(BASE + pathname, {
        method: method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    ).json()
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

function patchSettings(patch) {
  settings = { ...settings, ...patch }
  applySettings()
  return write('/v1/settings', 'PUT', patch).then((r) => {
    if (r && r.ok && r.settings) {
      settings = { ...settings, ...r.settings }
      applySettings()
      renderQuick()
    }
    return r
  })
}

// ---------- 角色 / 主题 / 尺寸 ----------

function foxSize() {
  // 100% = 旧挂件默认档（scale 1.5）。旧挂件把角色画在 59.45% 的根框里，
  // 换算到新版整框显示约 0.892；这样 100% 与旧版默认大小一致，其余档位等比。
  const base = Math.min(250, Math.min(window.innerWidth, window.innerHeight) * 0.28) * 0.892
  return Math.max(122, Math.min(625, base * (Number(settings.scale) || 1)))
}

function roleForAgent(agentId) {
  const map = settings.rolesByAdapter || {}
  const profile = (settings.profiles || {})[agentId]
  if (profile && profile.roleId && roleCatalog[profile.roleId]) return profile.roleId
  if (agentId && map[agentId] && roleCatalog[map[agentId]]) return map[agentId]
  const agent = (state.agents || []).find((a) => a.id === agentId)
  if (agent && agent.roleDefault && roleCatalog[agent.roleDefault]) return agent.roleDefault
  if (agentId && ADAPTER_ROLES[agentId] && roleCatalog[ADAPTER_ROLES[agentId]]) return ADAPTER_ROLES[agentId]
  return settings.roleId && roleCatalog[settings.roleId] ? settings.roleId : 'fox'
}

// 所有内置强调色上纯黑文字的对比度都 ≥4.8:1（dsh #4d6bfe 为 4.85:1）。
function applyAccent(accent) {
  const a = accent || '#f0a04b'
  document.documentElement.style.setProperty('--pet-accent', a)
  document.documentElement.style.setProperty('--on-accent', '#000000')
}

function applyRole(id) {
  const role = roleCatalog[id] || roleCatalog.fox || FOX_ROLES.fox
  const changed = roleId !== role.id || appliedRoleSrc !== role.image
  roleId = role.id
  if (changed && role.image) {
    foxImg.src = role.image
    foxImg.alt = role.name
    appliedRoleSrc = role.image
    // 同一 id 重新导入（换图/GIF）时也要重建命中掩码。
    loadAlphaMask(role.id)
  }
  applyAccent(role.accent || '#f0a04b')
}

// 导入角色（含 GIF）由主进程读成 data URL；内置角色继续走相对路径。
async function loadRoleCatalog() {
  const r = await read('/v1/roles')
  if (!r || !r.ok || !Array.isArray(r.roles)) return
  const next = { ...FOX_ROLES }
  const api = window.foxOverlay
  for (const role of r.roles) {
    if (!role || !role.id || FOX_ROLES[role.id]) continue
    let image = role.image || ''
    if (api && typeof api.getRoleImage === 'function') {
      try {
        const data = await api.getRoleImage(role.id)
        if (data) image = data
      } catch (err) {}
    }
    if (!image) continue
    next[role.id] = {
      id: role.id,
      name: role.name || role.id,
      image,
      accent: role.accent || '#f0a04b',
      pick: FOX_ROLES.fox.pick,
      lines: FOX_ROLES.whale.lines,
    }
  }
  roleCatalog = next
  syncRole()
}

function syncRole() {
  const agentId = bound.agentId || state.pet.profileOf || state.pet.lastAgentId || ''
  const next = roleForAgent(agentId)
  const role = roleCatalog[next] || roleCatalog.fox || FOX_ROLES.fox
  // 不能只比 roleId：refreshState 曾在没换图时改过 roleId，导致这里误判「已应用」。
  if (next !== roleId || appliedRoleSrc !== role.image) {
    applyRole(next)
    renderChip()
    if (quickOpen) renderQuick()
  }
}

function applySettings() {
  hideMoney = !!settings.hideMoney
  document.documentElement.style.setProperty('--fox-size', foxSize() + 'px')
  document.body.dataset.menuButton = settings.menuButton || 'hover'
  const theme = settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : ''
  if (theme) document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = theme || 'light dark'
  syncRole()
  if (hideMoney) hideBubble()
  if (Number(settings.followMs) !== followEvery) restartFollowTimer()
  if (Number(settings.chatterMs) !== lastChatterMs) restartChatter()
  if (settings.petMode && state.pet.mode === 'attached' && !petModeFloating) {
    petModeFloating = true
    floatAt().finally(() => {
      petModeFloating = false
    })
  }
  placeAll()
  renderChip()
  if (quickOpen) renderQuick()
}

async function loadAlphaMask(id) {
  try {
    const api = window.foxOverlay
    const m = api && typeof api.getAlphaMask === 'function' ? await api.getAlphaMask(id) : null
    if (m && m.ok && Array.isArray(m.data)) {
      alphaMask = m
      alphaRole = id
    } else {
      alphaMask = null
    }
  } catch (err) {
    alphaMask = null
  }
}

// ---------- 格式化 ----------

function moneyText(money, unit) {
  if (hideMoney && unit !== 'percent') return '•••'
  if (!money || typeof money.amount !== 'number') return '—'
  if (unit === 'credit' || money.currency === 'CREDIT') {
    return money.amount.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' 积分'
  }
  const sym = money.currency === 'CNY' ? '¥' : money.currency === 'USD' ? '$' : (money.currency || '') + ' '
  const abs = Math.abs(money.amount)
  const digits = abs > 0 && abs < 0.01 ? 4 : 2
  return sym + money.amount.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function pctText(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%'
}

function tokensText(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
  return String(Math.round(v))
}

function resetText(v) {
  if (v == null || v === '') return ''
  const ms = typeof v === 'number' ? v : Date.parse(String(v))
  if (!Number.isFinite(ms)) return String(v).slice(0, 16)
  const delta = ms - Date.now()
  if (delta <= 0) return '即将重置'
  if (delta < 3600_000) return Math.round(delta / 60_000) + 'm 后重置'
  if (delta < 86400_000) return Math.round(delta / 3600_000) + 'h 后重置'
  return Math.round(delta / 86400_000) + 'd 后重置'
}

function mainMetric(snap, agentId) {
  if (!snap || snap.supported !== true) return { value: '—', label: '暂无数据' }
  const mode = settings.displayMode || 'auto'
  const card = snap.quotaCard || {}
  const preferBalance =
    mode === 'balance' || (mode === 'auto' && (agentId === 'dsh' || card.preferBalance || card.kind === 'balance'))
  if (preferBalance && snap.balance) {
    return { value: moneyText(snap.balance, snap.unit), label: '余额' }
  }
  const preferQuota =
    mode === 'quota' || (mode === 'auto' && (agentId === 'kimi' || card.kind === 'plan' || card.kind === 'windows'))
  if (preferQuota && snap.quota) {
    return { value: pctText(snap.quota.remainingPct), label: '剩余额度' }
  }
  if (snap.today) return { value: moneyText(snap.today, snap.unit), label: '今日已用' }
  if (snap.balance) return { value: moneyText(snap.balance, snap.unit), label: '余额' }
  return { value: '—', label: '暂无数据' }
}

// ---------- 位置 ----------

async function ensureOrigin() {
  if (origin) return origin
  try {
    const api = window.foxOverlay
    if (api && typeof api.getBounds === 'function') {
      const b = await api.getBounds()
      if (b && Number.isFinite(b.x)) origin = { x: b.x, y: b.y }
    }
  } catch (err) {}
  if (!origin) origin = { x: window.screenX || 0, y: window.screenY || 0 }
  return origin
}

function rectLocal(rect) {
  if (!rect) return null
  const dpr = window.devicePixelRatio || 1
  const o = origin || { x: window.screenX || 0, y: window.screenY || 0 }
  const w = (rect.w != null ? rect.w : rect.width) || 0
  const h = (rect.h != null ? rect.h : rect.height) || 0
  return { x: rect.x / dpr - o.x, y: rect.y / dpr - o.y, w: w / dpr, h: h / dpr }
}

function clampPos(x, y) {
  const s = foxSize()
  return {
    x: Math.max(0, Math.min(window.innerWidth - s, Math.round(x))),
    y: Math.max(0, Math.min(window.innerHeight - s, Math.round(y))),
  }
}

function place(x, y) {
  pos = clampPos(x, y)
  fox.style.left = pos.x + 'px'
  fox.style.top = pos.y + 'px'
  placeAll()
}

function screenHalf() {
  const s = foxSize()
  return {
    h: pos.x + s / 2 < window.innerWidth / 2 ? 'left' : 'right',
    v: pos.y + s / 2 < window.innerHeight / 2 ? 'top' : 'bottom',
  }
}

function shouldMirror(box) {
  if (state.pet.mode !== 'attached') return pos.x + foxSize() / 2 < window.innerWidth / 2
  if (anchor.h === 'left') return true
  if (anchor.h === 'right') return false
  const b = box || (bound.rect ? rectLocal(bound.rect) : null)
  if (b) return pos.x + foxSize() / 2 < b.x + b.w / 2
  return pos.x + foxSize() / 2 < window.innerWidth / 2
}

function placeAll() {
  const s = foxSize()
  const half = screenHalf()
  document.body.dataset.cornerH = half.h
  document.body.dataset.cornerV = half.v
  fox.classList.toggle('mirror', shouldMirror())
  positionChip()
  if (quickOpen) positionQuick()
  if (menuOpen) positionMenu()
  positionBubble()
  positionSay()
  const at = pointer || pos
  dragHint.style.left = Math.max(8, Math.min(window.innerWidth - dragHint.offsetWidth - 8, at.x + 16)) + 'px'
  dragHint.style.top = Math.max(8, Math.min(window.innerHeight - 40, at.y + 16)) + 'px'
}

// 旧挂件式吸附：窗口横向四分之一、纵向四分之一以内才吸边；
// 中间区域保持自由位置（相对窗口左上角的偏移），窗口移动/缩放时跟着走。
function anchorFromDrop(box) {
  const s = foxSize()
  const cx = pos.x - box.x + s / 2
  const cy = pos.y - box.y + s / 2
  const h = cx < box.w / 4 ? 'left' : cx > (box.w * 3) / 4 ? 'right' : null
  const v = cy < box.h / 4 ? 'top' : cy > (box.h * 3) / 4 ? 'bottom' : null
  return {
    h,
    v,
    hOff: h ? 0 : Math.max(0, Math.min(Math.max(0, box.w - s), pos.x - box.x)),
    vOff: v ? 0 : Math.max(0, Math.min(Math.max(0, box.h - s), pos.y - box.y)),
  }
}

function normalizeAnchor(raw) {
  if (!raw || typeof raw !== 'object') return null
  const h = raw.h === 'left' || raw.h === 'right' ? raw.h : null
  const v = raw.v === 'top' || raw.v === 'bottom' ? raw.v : null
  return {
    h,
    v,
    hOff: Math.max(0, Number(raw.hOff) || 0),
    vOff: Math.max(0, Number(raw.vOff) || 0),
  }
}

function loadAnchor(hwnd) {
  for (const key of ['fox-dock:anchor:' + hwnd, 'fox-dock:corner:' + hwnd]) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || 'null')
      const next = normalizeAnchor(raw)
      if (next) return next
    } catch (err) {}
  }
  return { h: 'right', v: 'bottom', hOff: 0, vOff: 0 }
}

function placeAnchored(rect) {
  const box = rectLocal(rect)
  if (!box) return
  const s = foxSize()
  // 只有右侧/下侧需要避让滚动条；左侧/上侧与旧挂件一样紧贴窗口边缘。
  const gap = settings.scrollGapOn ? Math.max(0, Number(settings.scrollGap) || 0) : 0
  const x =
    anchor.h === 'left'
      ? box.x
      : anchor.h === 'right'
        ? box.x + box.w - s - gap
        : box.x + anchor.hOff
  const y =
    anchor.v === 'top'
      ? box.y
      : anchor.v === 'bottom'
        ? box.y + box.h - s - gap
        : box.y + anchor.vOff
  place(x, y)
}

// ---------- 数据 ----------

async function refreshSettings() {
  const r = await read('/v1/settings')
  if (!r || !r.ok || !r.settings) return
  const next = { ...settings, ...r.settings }
  if (JSON.stringify(next) === JSON.stringify(settings)) return
  settings = next
  applySettings()
}

let restoredFor = ''
async function markRestored(hwnd) {
  if (restoredFor === hwnd && document.body.dataset.restored === '1') return
  const r = await read('/v1/bindings')
  const b = r && Array.isArray(r.bindings) ? r.bindings.find((x) => x.window && x.window.hwnd === hwnd) : null
  if (b) {
    restoredFor = hwnd
    document.body.dataset.restored = '1'
    document.body.dataset.boundKey = b.key
  } else {
    delete document.body.dataset.restored
    delete document.body.dataset.boundKey
  }
}

async function refreshState() {
  if (dragging || pressing) return
  const s = await read('/v1/state')
  if (!s || !s.ok) return
  state = s
  const p = s.pet || {}
  if (p.mode === 'attached' && p.hwnd) {
    if (bound.hwnd !== p.hwnd) {
      const agent = (s.agents || []).find((a) => a.id === p.agentId)
      bound = {
        agentId: p.agentId || '',
        hwnd: p.hwnd,
        title: (agent && agent.windows && agent.windows[0] && agent.windows[0].title) || '',
        exe: '',
        pid: 0,
        startMs: 0,
        rect: null,
      }
      anchor = loadAnchor(p.hwnd)
      place(0, 0) // 先夹住，rect 回来再贴边
    }
    markRestored(p.hwnd)
    refreshRect()
  } else if (p.mode === 'floating') {
    bound = { ...bound, agentId: '', hwnd: '' }
    delete document.body.dataset.restored
    delete document.body.dataset.boundKey
    if (p.rect && Number.isFinite(p.rect.x)) place(p.rect.x, p.rect.y)
  } else {
    bound = { agentId: '', hwnd: '', title: '', exe: '', pid: 0, startMs: 0, rect: null }
    delete document.body.dataset.restored
    delete document.body.dataset.boundKey
    if (!startSnapshotSeen) {
      place(window.innerWidth - foxSize() - 24, window.innerHeight - foxSize() - 24)
      startSnapshotSeen = true
    }
  }
  applySettings()
  renderChip()
}

async function refreshRect() {
  if (!bound.hwnd || dragging || pressing) return
  const r = await read('/rect?hwnd=' + encodeURIComponent(bound.hwnd))
  if (!r) return
  if (r.ok && r.rect) {
    bound.rect = r.rect
    placeAnchored(r.rect)
    foxBadge.hidden = true
  } else {
    foxBadge.hidden = false
    foxBadge.textContent = '窗口不可见'
  }
}

async function refreshAgentData(force) {
  const agentId = bound.agentId || state.pet.profileOf || state.pet.lastAgentId
  if (!agentId) {
    snapshot = null
    context = null
    renderChip()
    if (quickOpen) renderQuick()
    return
  }
  const d = await read('/v1/agents/' + encodeURIComponent(agentId) + '/snapshot' + (force ? '?force=1' : ''))
  if (!d || !d.ok) return
  snapshot = d.snapshot
  context = d.context
  const fp = snapshot ? [snapshot.today && snapshot.today.amount, snapshot.turn && snapshot.turn.amount, snapshot.ok].join('|') : ''
  if (startSnapshotSeen && fp !== lastSnapshotFingerprint && settings.turnBubble && snapshot && snapshot.ok && snapshot.turn) {
    const v = moneyText(snapshot.turn, snapshot.unit)
    showBubble('本轮 ' + v, ADAPTER_NAMES[agentId] || agentId, { ms: settings.turnBubbleMs })
  }
  lastSnapshotFingerprint = fp
  startSnapshotSeen = true
  renderChip()
  if (quickOpen) renderQuick()
}

async function loadQueue() {
  const r = await read('/v1/bubbles/queue')
  queue = r && r.ok && Array.isArray(r.queue) ? r.queue : []
  queueIndex = 0
}

// ---------- 渲染 ----------

function agentName(id) {
  const a = (state.agents || []).find((x) => x.id === id)
  return (a && a.name) || ADAPTER_NAMES[id] || (id ? id : 'fox-dock')
}

function agentAccent(id) {
  const a = (state.agents || []).find((x) => x.id === id)
  if (a && a.accent) return a.accent
  const role = FOX_ROLES[roleForAgent(id)]
  return (role && role.accent) || '#f0a04b'
}

function renderChip() {
  // 大浮窗与小胶囊共用角色侧边的同一块位置：打开大浮窗时收起小胶囊。
  const visible = !!(bound.agentId || state.pet.mode === 'floating') && settings.showChip && !quickOpen
  chip.hidden = !visible
  chip.classList.toggle('open', visible)
  chipUnlink.hidden = state.pet.mode !== 'floating'
  if (!visible) return
  const agentId = bound.agentId || state.pet.profileOf || ''
  chipAdapter.textContent = agentName(agentId)
  const metric = mainMetric(snapshot, agentId)
  chipValue.textContent = metric.value
  chipDot.className = 'chip-dot ' + (!snapshot || !snapshot.ok ? 'warn' : snapshot.supported === false ? 'bad' : '')
  const pct = context && context.supported && Number.isFinite(context.pct) ? context.pct : null
  const C = 2 * Math.PI * 7
  chipRingValue.style.strokeDasharray = String(C)
  chipRingValue.style.strokeDashoffset = String(C * (1 - (pct == null ? 0 : pct) / 100))
  const ring = document.getElementById('chip-ring')
  if (ring) ring.style.display = pct == null ? 'none' : ''
  applyAccent(agentAccent(agentId))
  placeAll()
}

function renderQuick() {
  if (quick.hidden) return
  const agentId = bound.agentId || state.pet.profileOf || ''
  const metric = mainMetric(snapshot, agentId)
  quickAgent.textContent = agentId ? agentName(agentId) : '未绑定'
  quickStatus.textContent =
    state.pet.mode === 'attached'
      ? bound.title || agentName(agentId)
      : state.pet.mode === 'floating'
        ? '桌面 · 沿用 ' + agentName(state.pet.profileOf)
        : settings.petMode
          ? '未吸附'
          : '拖到宿主窗口可吸附'
  quickDot.className = 'quick-dot ' + (!snapshot || !snapshot.ok ? 'bad' : '')
  quickValue.textContent = metric.value
  quickSub.textContent = metric.label + (snapshot && snapshot.turn ? ' · 上一轮 ' + moneyText(snapshot.turn, snapshot.unit) : '')
  const pct = context && context.supported && Number.isFinite(context.pct) ? context.pct : null
  quickCtxBar.style.width = (pct == null ? 0 : pct) + '%'
  quickCtxBar.style.background = pct == null ? 'var(--surface-2)' : pct >= 92 ? 'var(--bad)' : pct >= 80 ? 'var(--warn)' : 'var(--pet-accent)'
  quickCtxPct.textContent = pct == null ? '—' : pctText(pct)
  quickCtxAbs.textContent = context && context.supported ? tokensText(context.used) + (context.limit ? ' / ' + tokensText(context.limit) : '') : '暂无'
  quickWindows.replaceChildren()
  const windows = snapshot && snapshot.quotaCard && Array.isArray(snapshot.quotaCard.windows) ? snapshot.quotaCard.windows.slice(0, 3) : []
  for (const w of windows) {
    const row = document.createElement('div')
    row.className = 'quick-window'
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = w.label
    const bar = document.createElement('span')
    bar.className = 'bar'
    const fill = document.createElement('i')
    fill.style.width = Math.max(0, Math.min(100, Number(w.usedPct) || 0)) + '%'
    fill.style.background = (Number(w.usedPct) || 0) >= 92 ? 'var(--bad)' : (Number(w.usedPct) || 0) >= 80 ? 'var(--warn)' : 'var(--pet-accent)'
    bar.appendChild(fill)
    const pctEl = document.createElement('span')
    pctEl.className = 'pct'
    pctEl.textContent = pctText(w.remainingPct)
    const reset = document.createElement('span')
    reset.className = 'reset'
    reset.textContent = resetText(w.resetAt)
    row.append(label, bar, pctEl, reset)
    quickWindows.appendChild(row)
  }
  positionQuick()
}

// 角色侧边的横向位置：优先放在角色右边，放不下换左边，最后在视口内夹住。
// 小胶囊和大浮窗共用同一套落点，所以点开大浮窗时视觉上是「在原地展开」。
function sideX(width) {
  // 用实际渲染宽度而不是 foxSize()：样式变量尚未写入时两者可能短暂不一致，
  // 会让胶囊压到角色边缘。
  const rect = fox.getBoundingClientRect()
  const s = rect.width || foxSize()
  const half = screenHalf()
  let x = half.h === 'right' ? pos.x - width - 12 : pos.x + s + 12
  if (x < 8) x = pos.x + s + 12
  if (x + width > window.innerWidth - 8) x = pos.x - width - 12
  return Math.max(8, Math.min(window.innerWidth - width - 8, x))
}

function positionChip() {
  if (chip.hidden) return
  const w = chip.offsetWidth || 180
  const h = chip.offsetHeight || 32
  const foxH = fox.getBoundingClientRect().height || foxSize()
  const x = sideX(w)
  const y = Math.max(8, Math.min(window.innerHeight - h - 8, pos.y + foxH / 2 - h / 2))
  chip.style.left = Math.round(x) + 'px'
  chip.style.top = Math.round(y) + 'px'
}

function positionQuick() {
  if (quick.hidden) return
  const w = quick.offsetWidth || 320
  const h = quick.offsetHeight || 300
  const foxH = fox.getBoundingClientRect().height || foxSize()
  const x = sideX(w)
  const y = Math.max(8, Math.min(window.innerHeight - h - 8, pos.y + foxH / 2 - h / 2))
  quick.style.left = Math.round(x) + 'px'
  quick.style.top = Math.round(y) + 'px'
}

function toggleQuick(open) {
  quickOpen = typeof open === 'boolean' ? open : !quickOpen
  quick.hidden = !quickOpen
  // 大浮窗打开时收起小胶囊，两者占同一个侧边位置，不叠在角色身上。
  renderChip()
  if (quickOpen) {
    closeMenu()
    renderQuick()
    setInteractive(true)
  } else if (!menuOpen && !dragging) {
    setInteractive(false)
  }
}

function speak() {
  if (settings.dnd) return
  const role = FOX_ROLES[roleId] || FOX_ROLES.fox
  const lines = role.lines && role.lines.length ? role.lines : ['嘎？']
  showSay(lines[Math.floor(Math.random() * lines.length)])
}

// 气泡定位：先算可用空间，一次性放到「优先上方、放不下就下方」的最终位置，
// 再在视口内夹住；箭头单独指向角色中心。不做「先居中、发现撞边再跳到另一侧」
// 的二次移动，所以第一帧就是最终位置。
function positionPopover(el) {
  if (!el || el.hidden) return
  const s = foxSize()
  const margin = 8
  const w = el.offsetWidth || 200
  const h = el.offsetHeight || 50
  const center = pos.x + s / 2
  const aboveRoom = pos.y - 10 - margin
  const belowRoom = window.innerHeight - (pos.y + s) - 10 - margin
  let below
  if (h <= aboveRoom) below = false
  else if (h <= belowRoom) below = true
  else below = belowRoom > aboveRoom
  let y = below ? pos.y + s + 10 : pos.y - h - 10
  y = Math.max(margin, Math.min(window.innerHeight - h - margin, y))
  const x = Math.max(margin, Math.min(window.innerWidth - w - margin, center - w / 2))
  const arrow = Math.max(18, Math.min(w - 18, center - x))
  el.style.left = Math.round(x) + 'px'
  el.style.top = Math.round(y) + 'px'
  el.classList.toggle('below', below)
  el.style.setProperty('--arrow-left', Math.round(arrow) + 'px')
}

function positionSay() {
  positionPopover(sayEl)
}

function positionBubble() {
  positionPopover(bubble)
}

function showSay(text) {
  if (!text || settings.dnd) return
  if (sayTimer) clearTimeout(sayTimer)
  const wasOpen = !sayEl.hidden && sayEl.classList.contains('open')
  sayText.textContent = text
  if (!wasOpen) {
    sayEl.classList.remove('open')
    sayEl.style.visibility = 'hidden'
  }
  sayEl.hidden = false
  positionSay()
  if (!wasOpen) {
    sayEl.style.visibility = ''
    requestAnimationFrame(() => {
      if (!sayEl.hidden) sayEl.classList.add('open')
    })
  }
  sayTimer = setTimeout(hideSay, 5200)
}

function hideSay() {
  if (sayTimer) clearTimeout(sayTimer)
  sayTimer = null
  sayEl.classList.remove('open')
  setTimeout(() => {
    if (!sayEl.classList.contains('open')) sayEl.hidden = true
  }, 160)
}

function showBubble(text, sub, opts = {}) {
  if (settings.dnd) return
  // 隐藏金额 = 不弹消耗/余额气泡；金额本身在胶囊里也保持掩码。
  if (hideMoney) return
  if (!text || !text.trim()) return
  if (bubbleTimer) clearTimeout(bubbleTimer)
  const wasOpen = !bubble.hidden && bubble.classList.contains('open')
  bubbleText.textContent = text
  bubbleSub.textContent = sub || ''
  bubbleSub.hidden = !sub
  if (!wasOpen) {
    bubble.classList.remove('open')
    bubble.style.visibility = 'hidden'
  }
  bubble.hidden = false
  positionBubble()
  if (!wasOpen) {
    bubble.style.visibility = ''
    requestAnimationFrame(() => {
      if (!bubble.hidden) bubble.classList.add('open')
    })
  }
  const ms = opts.ms == null ? settings.turnBubbleMs : opts.ms
  if (ms > 0) bubbleTimer = setTimeout(hideBubble, Math.max(1500, ms))
}

function hideBubble() {
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = null
  bubble.classList.remove('open')
  setTimeout(() => {
    if (!bubble.classList.contains('open')) bubble.hidden = true
  }, 160)
}

function playQueueBubble() {
  if (!queue.length) return false
  const item = queue[queueIndex % queue.length]
  queueIndex++
  const text = typeof item === 'string' ? item : String((item && (item.text || item.content)) || '')
  const sub = item && typeof item === 'object' ? String(item.sub || item.subtitle || '') : ''
  if (!text.trim()) return false
  showBubble(text, sub, { ms: 6000 })
  return true
}

// ---------- 菜单 ----------

function menuItem(label, fn, opts = {}) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'menu-item' + (opts.danger ? ' danger' : '')
  b.textContent = label
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    closeMenu()
    fn()
  })
  return b
}

function menuTitle(text) {
  const d = document.createElement('div')
  d.className = 'menu-title'
  d.textContent = text
  return d
}

function openMenu(x, y) {
  closeMenu()
  quickOpen = false
  quick.hidden = true
  menu.replaceChildren()
  menu.appendChild(menuItem('打开控制台', () => window.foxOverlay && window.foxOverlay.openConsole && window.foxOverlay.openConsole()))
  menu.appendChild(menuItem('说一句', speak))
  const sep = document.createElement('div')
  sep.className = 'menu-sep'
  menu.appendChild(sep)
  // 吸附只有一个总开关：关闭后角色不吸附、不跟随，留在桌面上。
  menu.appendChild(menuItem((settings.petMode ? '' : '✓ ') + '吸附到 agent 窗口', () => patchSettings({ petMode: !settings.petMode })))
  menu.appendChild(menuItem((settings.hideMoney ? '✓ ' : '') + '隐藏金额', () => patchSettings({ hideMoney: !settings.hideMoney })))
  menu.appendChild(menuItem((settings.dnd ? '✓ ' : '') + '勿扰（静音气泡与音效）', () => patchSettings({ dnd: !settings.dnd })))
  const sep2 = document.createElement('div')
  sep2.className = 'menu-sep'
  menu.appendChild(sep2)
  menu.appendChild(menuTitle('角色'))
  const roles = document.createElement('div')
  roles.className = 'menu-sub'
  for (const r of Object.values(roleCatalog)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'menu-role' + (roleId === r.id ? ' active' : '')
    b.title = r.name
    b.setAttribute('aria-label', r.name)
    const img = document.createElement('img')
    img.src = r.image
    img.alt = ''
    b.appendChild(img)
    b.addEventListener('click', async (e) => {
      e.stopPropagation()
      await pickRole(r.id)
      closeMenu()
    })
    roles.appendChild(b)
  }
  menu.appendChild(roles)
  menu.appendChild(menuTitle('大小'))
  const sizes = document.createElement('div')
  sizes.className = 'menu-sub'
  for (const s of SCALES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'menu-size' + (Number(settings.scale) === s ? ' active' : '')
    b.textContent = Math.round(s * 100) + '%'
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      patchSettings({ scale: s })
      closeMenu()
    })
    sizes.appendChild(b)
  }
  menu.appendChild(sizes)
  const sep3 = document.createElement('div')
  sep3.className = 'menu-sep'
  menu.appendChild(sep3)
  menu.appendChild(menuItem('隐藏角色', () => window.foxOverlay && window.foxOverlay.hideOverlay && window.foxOverlay.hideOverlay()))
  menu.appendChild(menuItem('退出 fox-dock', () => window.foxOverlay && window.foxOverlay.quitDock && window.foxOverlay.quitDock(), { danger: true }))

  menuOpen = true
  menu.hidden = false
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 232, x)) + 'px'
  menu.style.top = Math.max(8, Math.min(window.innerHeight - menu.offsetHeight - 8, y)) + 'px'
  setInteractive(true)
}

function positionMenu() {
  if (!menuOpen) return
  const w = menu.offsetWidth || 224
  const h = menu.offsetHeight || 300
  const x = parseFloat(menu.style.left || '200') || 200
  const y = parseFloat(menu.style.top || '200') || 200
  menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x)) + 'px'
  menu.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, y)) + 'px'
}

function closeMenu() {
  menuOpen = false
  menu.hidden = true
  if (!quickOpen && !dragging && !pressing) setInteractive(false)
}

async function pickRole(id) {
  roleId = id
  applyRole(id)
  const agentId = bound.agentId || state.pet.profileOf
  if (agentId) await write('/v1/profiles/' + encodeURIComponent(agentId), 'PUT', { roleId: id })
  else await patchSettings({ roleId: id })
  renderChip()
  if (quickOpen) renderQuick()
}

// ---------- 吸附 / 悬浮 ----------

function acceptable(win) {
  if (!win) return false
  if (IGNORE_PIDS.has(win.pid)) return false
  if (IGNORE_CLASSES.has(win.cls)) return false
  if (!win.exe && !win.title) return false
  if (/electron\.exe$/i.test(win.exe || '') && /fox-dock overlay|小挂件/i.test(win.title || '')) return false
  return true
}

async function hitAt(clientX, clientY, force = false) {
  const now = performance.now()
  if (!force && (hitBusy || now - lastHitAt < 30)) return currentTarget
  hitBusy = true
  lastHitAt = now
  try {
    const api = window.foxOverlay
    const dpr = window.devicePixelRatio || 1
    const o = await ensureOrigin()
    const px = Math.round((clientX + o.x) * dpr)
    const py = Math.round((clientY + o.y) * dpr)
    const data =
      api && typeof api.hit === 'function'
        ? await api.hit(px, py, SELF_PID)
        : await (await fetch(BASE + '/hit?x=' + px + '&y=' + py + '&exclude=' + SELF_PID)).json()
    return (data.hits || []).find(acceptable) || null
  } catch (err) {
    return null
  } finally {
    hitBusy = false
  }
}

async function bindTo(win) {
  const box = rectLocal(win.rect)
  const nextAnchor = box ? anchorFromDrop(box) : anchor
  const data = await write('/v1/pet/attach', 'POST', {
    exe: win.exe,
    title: win.title,
    cls: win.cls,
    pid: win.pid,
    startMs: win.startMs,
    hwnd: win.hwnd,
    rect: win.rect,
    anchor: nextAnchor,
  }).catch((err) => ({ ok: false, error: String((err && err.message) || err) }))
  lastAttach = data
  if (!data || !data.ok) return false
  bound = { agentId: data.pet.agentId, hwnd: win.hwnd, title: win.title, exe: win.exe, pid: win.pid, startMs: win.startMs, rect: win.rect }
  anchor = nextAnchor
  localStorage.setItem('fox-dock:anchor:' + win.hwnd, JSON.stringify(anchor))
  state.pet = data.pet
  roleId = roleForAgent(data.pet.agentId)
  applyRole(roleId)
  placeAnchored(win.rect)
  renderChip()
  markRestored(win.hwnd)
  refreshAgentData(true)
  return true
}

async function floatAt() {
  const data = await write('/v1/pet/float', 'POST', {
    rect: { x: Math.round(pos.x), y: Math.round(pos.y), width: foxSize(), height: foxSize() },
  })
  if (data && data.ok) state.pet = data.pet
  bound = { ...bound, agentId: '', hwnd: '' }
  roleId = roleForAgent(state.pet.profileOf || state.pet.lastAgentId || '')
  applyRole(roleId)
  renderChip()
  return data
}

// ---------- 指针交互 ----------

function isInside(el, x, y) {
  if (!el || el.hidden) return false
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

function isOverFox(x, y) {
  const r = fox.getBoundingClientRect()
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false
  if (alphaMask && alphaRole === roleId && r.width > 0) {
    const ix = Math.min(63, Math.max(0, Math.floor(((x - r.left) / r.width) * 64)))
    const iy = Math.min(63, Math.max(0, Math.floor(((y - r.top) / r.height) * 64)))
    return alphaMask.data[iy * 64 + ix] > 12
  }
  return true
}

function isOverUI(x, y) {
  return isOverFox(x, y) || isInside(chip, x, y) || isInside(petMenuBtn, x, y) ||
    (!bubble.hidden && isInside(bubble, x, y)) || (!sayEl.hidden && isInside(sayEl, x, y)) ||
    quickOpen && isInside(quick, x, y) || menuOpen && isInside(menu, x, y)
}

function setInteractive(on) {
  const v = !!on
  if (lastInteractive === v) return
  lastInteractive = v
  try {
    if (window.foxOverlay && window.foxOverlay.setInteractive) window.foxOverlay.setInteractive(v)
  } catch (err) {}
}

function restartFollowTimer() {
  if (followTimer) clearInterval(followTimer)
  followTimer = null
  followEvery = Math.max(200, Math.min(1000, Number(settings.followMs) || 500))
  followTimer = setInterval(() => {
    if (!bound.hwnd || dragging || pressing || settings.petMode) return
    refreshRect()
  }, followEvery)
}

function restartChatter() {
  if (chatterTimer) clearInterval(chatterTimer)
  chatterTimer = null
  lastChatterMs = Number(settings.chatterMs) || 0
  if (lastChatterMs <= 0) return
  chatterTimer = setInterval(() => {
    if (settings.dnd || dragging || pressing || quickOpen || menuOpen || !bubble.hidden) return
    speak()
  }, Math.max(30000, lastChatterMs))
}

fox.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  pressing = { x: e.clientX, y: e.clientY, moved: false }
  playSound('press')
  setInteractive(true)
})

function setDragHint(text, armed) {
  if (lastHintText !== text) {
    lastHintText = text
    dragHint.textContent = text
  }
  dragHint.classList.toggle('armed', !!armed)
}

window.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY }
  if (!pressing) {
    if (!CLICK_THROUGH) return
    setInteractive(isOverUI(e.clientX, e.clientY))
    return
  }
  const dx = e.clientX - pressing.x
  const dy = e.clientY - pressing.y
  if (!dragging && Math.hypot(dx, dy) > 5) {
    dragging = true
    pressing.moved = true
    hideBubble()
    toggleQuick(false)
    closeMenu()
    fox.classList.add('dragging')
    dragHint.hidden = false
    lastHintText = ''
  }
  if (!dragging) return
  place(e.clientX - foxSize() / 2, e.clientY - foxSize() / 2)
  if (settings.petMode) {
    currentTarget = null
    fox.classList.remove('armed')
    setDragHint('松手放在桌面', false)
    return
  }
  const seq = ++hitSeq
  hitAt(e.clientX, e.clientY).then((win) => {
    // 只认最新一次命中结果：旧的异步返回晚到会把提示文字改回去。
    if (!dragging || seq !== hitSeq) return
    currentTarget = win
    fox.classList.toggle('armed', !!win)
    const name = agentName(bound.agentId || state.pet.profileOf)
    setDragHint(win ? '松手吸附到 ' + (win.title || win.exe) : '松手放在桌面（保留 ' + name + ' 设置）', !!win)
  })
})

window.addEventListener('pointerup', async (e) => {
  if (!pressing) return
  playSound('release')
  const wasDragging = dragging
  let target = currentTarget
  pressing = null
  dragging = false
  currentTarget = null
  pointer = null
  hitSeq++
  fox.classList.remove('dragging', 'armed')
  dragHint.hidden = true
  if (!wasDragging) {
    // 再次点击角色只更新台词，不把已经打开的快览卡关掉。
    if (!quickOpen) toggleQuick(true)
    speak()
    return
  }
  if (!target && !settings.petMode) target = await hitAt(e.clientX, e.clientY, true)
  if (settings.petMode) {
    await floatAt()
  } else if (target) {
    const ok = await bindTo(target)
    if (!ok) await floatAt()
  } else {
    await floatAt()
  }
  setInteractive(isOverUI(e.clientX, e.clientY))
})

fox.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  openMenu(e.clientX, e.clientY)
})
petMenuBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
petMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  const r = petMenuBtn.getBoundingClientRect()
  openMenu(r.left, r.bottom + 4)
})
chip.addEventListener('click', (e) => {
  e.stopPropagation()
  toggleQuick()
})
bubble.addEventListener('click', async (e) => {
  e.stopPropagation()
  if (!queue.length) await loadQueue()
  if (playQueueBubble()) return
  hideBubble()
})
quickRefresh.addEventListener('click', () => refreshAgentData(true))
menu.addEventListener('pointerdown', (e) => e.stopPropagation())
document.addEventListener('mousedown', (e) => {
  if (quickOpen && !isInside(quick, e.clientX, e.clientY) && !isInside(fox, e.clientX, e.clientY)) toggleQuick(false)
  if (menuOpen && !isInside(menu, e.clientX, e.clientY)) closeMenu()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    toggleQuick(false)
    closeMenu()
    hideBubble()
    hideSay()
  }
})

// 光标轮询：穿透模式下 mousemove 转发在部分宿主前台时收不到
setInterval(async () => {
  if (!CLICK_THROUGH || dragging || pressing) return
  const api = window.foxOverlay
  if (!api || typeof api.getCursor !== 'function') return
  try {
    const p = await api.getCursor()
    const o = await ensureOrigin()
    setInteractive(quickOpen || menuOpen || isOverUI(p.x - o.x, p.y - o.y))
  } catch (err) {}
}, 50)

// ---------- 引导 ----------

async function boot() {
  await ensureOrigin()
  const s = await read('/v1/settings')
  if (s && s.ok && s.settings) settings = { ...settings, ...s.settings }
  // 先应用尺寸/主题，再等角色库（导入角色可能稍慢），避免首帧用旧尺寸。
  applySettings()
  await loadRoleCatalog()
  applySettings()
  await refreshState()
  await loadQueue()
  await refreshAgentData(true)
  setInterval(refreshState, 1500)
  setInterval(() => (quickOpen ? 0 : refreshSettings()), 2000)
  setInterval(() => (quickOpen ? 0 : refreshAgentData(false)), 3000)
  setInterval(loadRoleCatalog, 30000)
  setInterval(loadRoleCatalog, 30000)
  restartFollowTimer()
  setInterval(loadQueue, 15000)
  if (BASE) {
    try {
      const es = new EventSource(BASE + '/v1/stream')
      es.addEventListener('state', (e) => {
        try {
          state = JSON.parse(e.data)
          refreshState()
        } catch (err) {}
      })
      es.addEventListener('context', () => refreshAgentData(false))
      es.onerror = () => {}
    } catch (err) {}
  }
}

window.__pet = {
  get state() { return state },
  get settings() { return settings },
  get bound() { return bound },
  get dragging() { return dragging },
  get quickOpen() { return quickOpen },
  get menuOpen() { return menuOpen },
  get currentTarget() { return currentTarget },
  get snapshot() { return snapshot },
  get context() { return context },
  get anchor() { return anchor },
  get lastAttach() { return lastAttach },
  get roleCatalog() { return Object.keys(roleCatalog) },
  roleFor: (id) => roleForAgent(id),
  get currentRole() { return roleId },
  syncRole: () => syncRole(),
  alphaMaskLoaded: () => !!alphaMask,
  get followEvery() { return followEvery },
  debugAttach(agentId, hwnd, rect, c) {
    bound = { agentId, hwnd, title: 'debug', exe: 'debug.exe', pid: 1, startMs: 1, rect }
    state.pet = { mode: 'attached', agentId, hwnd, profileOf: agentId, lastAgentId: agentId }
    anchor = normalizeAnchor(c) || { h: 'right', v: 'bottom', hOff: 0, vOff: 0 }
    roleId = roleForAgent(agentId)
    applyRole(roleId)
    placeAnchored(rect)
    renderChip()
    return { pos, anchor }
  },
  debugFloat(agentId, x, y) {
    state.pet = { mode: 'floating', agentId: '', profileOf: agentId, lastAgentId: agentId }
    bound = { agentId: '', hwnd: '', title: '', exe: '', pid: 0, startMs: 0, rect: null }
    roleId = roleForAgent(agentId)
    applyRole(roleId)
    place(x, y)
    renderChip()
  },
  openQuick() { toggleQuick(true) },
  closeQuick() { toggleQuick(false) },
  openMenu,
  showBubble,
  reloadQueue: loadQueue,
  say: speak,
  setSettings(patch) { settings = { ...settings, ...patch }; applySettings() },
  setSnapshot(s) { snapshot = s; renderChip(); if (quickOpen) renderQuick() },
  setContext(c) { context = c; renderChip(); if (quickOpen) renderQuick() },
}

boot()
