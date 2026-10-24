// fox-dock 宠物层（2.0 新界面）。
//
// 结构：角色 + 状态胶囊 + 气泡/台词 + 320px 快览卡 + 196px 菜单。
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
// 系统/驱动辅助窗：它们会盖在宿主上但用户并不认为“指针指着它”，吸附判定必须跳过。
const AUX_EXES = new Set([
  'tabtip.exe',
  'textinputhost.exe',
  'nvidia overlay.exe',
  'nvidia share.exe',
  'searchhost.exe',
  'startmenuexperiencehost.exe',
  'shellexperiencehost.exe',
])
const AUX_TITLE_RE = /shell handwriting canvas|windows 输入体验|nvidia geforce overlay/i
// 只吸附这四个宿主；其它应用/桌面一律不绑。测试用 ?allowGeneric=1 放开，
// 让 fake-agent 这类普通 Electron 窗口能被命中。
const AGENT_EXES = new Set(['zcode.exe', 'workbuddy.exe', 'kimi code.exe', 'deepseek harness.exe'])
const AGENT_EXE_INCLUDES = ['/kimicode/', '/dsh-windows/']
const ALLOW_GENERIC = params.get('allowGeneric') === '1'

const ADAPTER_ROLES = { zcode: 'fox', workbuddy: 'xiaoke', kimi: 'kimi', dsh: 'whale' }
const ADAPTER_NAMES = { zcode: 'ZCode', workbuddy: 'WorkBuddy', kimi: 'Kimi Code', dsh: 'DeepSeek Harness', generic: '其它' }
const SCALES = [0.75, 1, 1.25, 1.5]

const fox = document.getElementById('fox')
const foxImg = document.getElementById('fox-img')
const petMenuBtn = document.getElementById('pet-menu')
const chip = document.getElementById('chip')
const chipAdapter = document.getElementById('chip-adapter')
const chipValue = document.getElementById('chip-value')
const chipDot = document.getElementById('chip-dot')
const chipRingValue = document.getElementById('chip-ring-value')
const chipMulti = document.getElementById('chip-multi')
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
const quickPeriod = document.getElementById('quick-period')
const quickPeriodLabel = document.getElementById('quick-period-label')
const quickPeriodCount = document.getElementById('quick-period-count')
const quickCtxBar = document.getElementById('quick-ctx-bar')
const quickCtxPct = document.getElementById('quick-ctx-pct')
const quickCtxAbs = document.getElementById('quick-ctx-abs')
const quickWindows = document.getElementById('quick-windows')
const quickSessionsEl = document.getElementById('quick-sessions')
const quickSessionList = document.getElementById('quick-session-list')
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
  // 与 daemon 的 DEFAULTS 保持一致（D2）：按模型族连续两拍切角色、今日预算。
  autoRoleByModel: true,
  budgetMoney: 0,
  budgetCredit: 0,
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
let lastHitSeq = 0
let pendingHit = null
let lastHintText = ''
let roleId = settings.roleId
let roleCatalog = { ...FOX_ROLES }
let appliedRoleSrc = ''
let quickOpen = false
let quickTop = null
let menuOpen = false
let bubbleTimer = null
let bubbleKind = ''
let sayTimer = null
let queue = []
let queueIndex = 0
let hideMoney = false
let alphaMask = null
let alphaRole = ''
let lastSnapshotFingerprint = ''
let lastSnapshotAt = 0
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
let placedOnce = false
let quickSessionItems = []
let quickSessionsAt = 0
let quickSessionsLoading = false
let quickSessionsPending = false
// 按模型换角色：两拍状态机（纯函数在 roles.js），状态跟当前绑定宿主走。
let autoRoleFor = ''
let autoRoleState = emptyAutoRole()
let lastAutoRoleByModel = null
let lastFoxSize = 0
// localStorage 不可用时的降级去重：只在本进程内有效，重载会再提醒一次。
let budgetMemorySeen = new Set()

// 与旧挂件一致：按下和松开各用一条音轨。短按松手时，松开音等到按下音
// 播到只剩 100ms 再起播（几乎无缝，又不会两个音从头叠在一起）；长按则在
// 松手时立刻补播。单音轨切 src 会把按下音截断，快按就只剩一半声音。
const SOUND_SRC = { press: '../assets/sounds/Ya1.mp3', release: '../assets/sounds/Ya2.mp3' }
// 与旧挂件一致：按下时整体压扁一点，松手弹回；以底边为原点，脚不离地。
const SQUISH = 'scaleY(0.88) scaleX(1.05)'
const pressAudio = new Audio(SOUND_SRC.press)
const releaseAudio = new Audio(SOUND_SRC.release)
let pressEnded = false
let releasePlayed = false
let releaseTimer = null

function soundVolume() {
  return Math.max(0, Math.min(1, Number(settings.soundVolume) || 0.5))
}

function playPress() {
  if (settings.dnd) return
  try {
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
    releaseAudio.pause()
    releaseAudio.currentTime = 0
    pressEnded = false
    releasePlayed = false
    pressAudio.onended = () => {
      pressEnded = true
      // 时长未知时的兜底：短按 → 按下音播完立刻接松开音
      if (!pressing && !releasePlayed) playRelease()
    }
    pressAudio.currentTime = 0
    pressAudio.volume = soundVolume()
    pressAudio.play().catch(() => {})
  } catch (err) {}
}

function playRelease() {
  if (settings.dnd || releasePlayed) return
  releasePlayed = true
  if (releaseTimer) {
    clearTimeout(releaseTimer)
    releaseTimer = null
  }
  try {
    releaseAudio.currentTime = 0
    releaseAudio.volume = soundVolume()
    releaseAudio.play().catch(() => {})
  } catch (err) {}
}

// pointerup：按下音已经播完 → 立刻补松开音；还没播完 → 排到结尾前 100ms。
function releaseAfterPress() {
  if (settings.dnd) return
  if (pressEnded) {
    playRelease()
    return
  }
  let dur = 0
  try {
    dur = pressAudio.duration
  } catch (err) {}
  if (Number.isFinite(dur) && dur > 0) {
    const remainMs = (dur - pressAudio.currentTime) * 1000
    releaseTimer = setTimeout(playRelease, Math.max(0, remainMs - 100))
  }
  // duration 还不可用时，pressAudio.onended 会兜底补播
}

function pressDown() {
  fox.style.transform = SQUISH
}

function pressUp() {
  fox.style.transform = 'scaleY(1) scaleX(1)'
}

// ---------- API ----------
// 本机 daemon 通道只走 preload IPC（主进程持令牌转发）：渲染层不直连网络，
// 拖拽期间渲染进程网络被挂起时也不受影响。浏览器直开（test:pet 截图）时
// 没有 preload，read/write 一律返回空，由用例的 debug 注入提供数据。

async function read(pathname) {
  const api = window.foxOverlay
  if (!api || typeof api.read !== 'function') return null
  try {
    return await api.read(pathname)
  } catch (err) {
    return null
  }
}

async function write(pathname, method, body) {
  const api = window.foxOverlay
  if (!api || typeof api.write !== 'function') return { ok: false, error: 'no-daemon-ipc' }
  try {
    return await api.write(pathname, method || 'POST', body)
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

let rolePending = null

function roleForAgent(agentId) {
  // 切换角色后，settings.profiles 要等下一次 /v1/settings 轮询才更新；
  // 这期间 syncRole 会算回旧角色，表现为「先切目标、又弹回、再切目标」。
  // 用短时 pending 覆盖，直到服务端设置追上来。
  if (rolePending && rolePending.roleId && Date.now() < rolePending.until) {
    const target = agentId || ''
    if (rolePending.agentId === target || rolePending.agentId === '__global') {
      // 服务端 profile 可能还没追上（仍是旧值或空）——这时继续用 pending。
      // 但如果 profile 被别处改成第三个值（控制台/导入），说明有更新的
      // 外部选择，必须让 profile 生效，不能一直被 15s 的 pending 压住。
      const prof = (settings.profiles || {})[target]
      const profRole = prof && prof.roleId ? prof.roleId : ''
      const prevRole = rolePending.prevRole || ''
      const external = !!profRole && profRole !== rolePending.roleId && profRole !== prevRole
      if (!external) return rolePending.roleId
    }
  }
  // 手动选角会把 autoRoleByModel 关掉（并在 profile 里写 roleId），
  // 所以这里只有在 auto 开启时才让模型族的判断优先；关闭时 profile 就是手动覆盖。
  if (settings.autoRoleByModel && autoRoleFor === (agentId || '') && autoRoleState.roleId && roleCatalog[autoRoleState.roleId]) {
    return autoRoleState.roleId
  }
  const map = settings.rolesByAdapter || {}
  const profile = (settings.profiles || {})[agentId]
  if (profile && profile.roleId && roleCatalog[profile.roleId]) return profile.roleId
  if (agentId && map[agentId] && roleCatalog[map[agentId]]) return map[agentId]
  const agent = (state.agents || []).find((a) => a.id === agentId)
  if (agent && agent.roleDefault && roleCatalog[agent.roleDefault]) return agent.roleDefault
  if (agentId && ADAPTER_ROLES[agentId] && roleCatalog[ADAPTER_ROLES[agentId]]) return ADAPTER_ROLES[agentId]
  return settings.roleId && roleCatalog[settings.roleId] ? settings.roleId : 'fox'
}

function resetAutoRole(agentId) {
  autoRoleFor = agentId || ''
  autoRoleState = emptyAutoRole()
}

// 一拍 = 一次新的 capturedAt。重复渲染/同一快照不会推进 streak。
function tickAutoRole(input, agentId) {
  const id = agentId || ''
  if (id !== autoRoleFor) resetAutoRole(id)
  if (!settings.autoRoleByModel) {
    autoRoleState = emptyAutoRole()
    return autoRoleState
  }
  autoRoleState = nextAutoRole(autoRoleState, input || {}, true)
  return autoRoleState
}

function maybeAutoRole(agentId) {
  if (!settings.autoRoleByModel) return
  const prev = autoRoleState.roleId
  const ctx = context || {}
  tickAutoRole(
    {
      // 模型名优先；宿主快照（D2）没有 model 时再退回上下文。
      model: String(ctx.model || (snapshot && snapshot.model) || ''),
      provider: String((snapshot && snapshot.provider) || ctx.provider || agentId || ''),
      capturedAt: Number(snapshot && snapshot.capturedAt) || 0,
    },
    agentId
  )
  if (autoRoleState.roleId !== prev) syncRole()
}

// 所有内置强调色上纯黑文字的对比度都 ≥4.8:1（dsh #4d6bfe 为 4.85:1）。
function applyAccent(accent) {
  const a = accent || '#f0a04b'
  document.documentElement.style.setProperty('--pet-accent', a)
  document.documentElement.style.setProperty('--on-accent', '#000000')
}

// 换角色的零延迟淡入（1.x v1.14 线口径）：src 立刻换（响应与硬切换一致），
// 只在新图 load 时把它瞬时压到 32% 透明度，下一帧放开由 CSS 过渡浮回。
// 一次性功能动画（D039 允许）；prefers-reduced-motion 下不动。
let roleFadePending = false

function prefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch (err) {
    return false
  }
}

foxImg.addEventListener('load', () => {
  if (!roleFadePending) return
  roleFadePending = false
  if (prefersReducedMotion()) return
  try {
    const prevT = foxImg.style.transition
    foxImg.style.transition = 'none'
    foxImg.style.opacity = '0.32'
    void foxImg.offsetWidth // 强制一次样式计算：两次赋值若在同一帧会被合并
    foxImg.style.transition = prevT
    foxImg.style.opacity = ''
  } catch (err) {}
})

function applyRole(id) {
  const role = roleCatalog[id] || roleCatalog.fox || FOX_ROLES.fox
  const changed = roleId !== role.id || appliedRoleSrc !== role.image
  roleId = role.id
  if (changed && role.image) {
    // 首帧（appliedRoleSrc 为空）不算「切换」，不淡入，避免启动截图停在半透明。
    roleFadePending = !!appliedRoleSrc
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
  // 重新开启「按模型换角色」要重新累计两拍；关闭时立刻丢掉自动角色。
  const autoOn = !!settings.autoRoleByModel
  if (lastAutoRoleByModel !== autoOn) {
    lastAutoRoleByModel = autoOn
    resetAutoRole(bound.agentId || state.pet.profileOf || state.pet.lastAgentId || '')
  }
  // 只有真正换档（角色大小变化）才重算快览卡锚点；普通设置轮询不能让它跳。
  const size = foxSize()
  if (lastFoxSize && size !== lastFoxSize) quickTop = null
  lastFoxSize = size
  document.documentElement.style.setProperty('--fox-size', size + 'px')
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
  if (n == null || n === '') return '—'
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

// 峰谷倒计时：只显示分钟级，够用又不会每秒闪数字；1 小时内显示分钟，
// 超过 1 小时显示 h+m。
function periodCountText(ms) {
  if (!Number.isFinite(ms)) return ''
  const delta = ms - Date.now()
  if (delta <= 0) return '即将切换'
  const min = Math.max(1, Math.ceil(delta / 60_000))
  if (min >= 60) {
    const h = Math.floor(min / 60)
    const m = min % 60
    return h + 'h' + (m ? m + 'm' : '')
  }
  return min + 'm'
}

function renderPeriod() {
  if (!quickOpen || quick.hidden) return
  const p = snapshot && snapshot.period
  if (!p) {
    quickPeriod.hidden = true
    return
  }
  quickPeriod.hidden = false
  quickPeriod.classList.toggle('peak', !!p.isPeak)
  quickPeriodLabel.textContent = p.isPeak ? '高峰时段' : '空闲时段'
  const left = periodCountText(Number(p.nextChangeAt))
  quickPeriodCount.textContent = left ? left + ' 后转' + (p.isPeak ? '谷' : '峰') : ''
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
  const next = clampPos(x, y)
  const moved = Math.abs(next.x - pos.x) > 0.5 || Math.abs(next.y - pos.y) > 0.5
  pos = next
  // 角色真的移动了才重新给大浮窗落位；跟随定时器重复上报同一 rect 时不能重置。
  if (moved) quickTop = null
  fox.style.left = pos.x + 'px'
  fox.style.top = pos.y + 'px'
  placeAll()
}

// 兜底位直接贴住窗口角落（窗口正常时与工作区严格重合，见 window-bounds.cjs），
// 不再留观感间距；仅自动隐藏任务栏开启时窗口自身留 1 DIP 防压滑出热区。
const CORNER_MARGIN = 0
const FALLBACK_CORNERS = ['br', 'bl', 'tr', 'tl']

// 失焦/最小化的兜底角落（迁移 1.x defaultCorner）：右下/左下/右上/左上。
function fallbackCorner() {
  const c = String((settings && settings.fallbackCorner) || 'br')
  return FALLBACK_CORNERS.indexOf(c) >= 0 ? c : 'br'
}

function cornerPos(corner) {
  const s = foxSize()
  const x = corner.indexOf('r') >= 0 ? window.innerWidth - s - CORNER_MARGIN : CORNER_MARGIN
  const y = corner.indexOf('b') >= 0 ? window.innerHeight - s - CORNER_MARGIN : CORNER_MARGIN
  return clampPos(x, y)
}

// 兜底朝向：站在屏幕角落时面向屏幕内侧（右侧角 → 朝左，左侧角 → 朝右）。
// 兜底期间 mode 可能仍是 attached，shouldMirror 的吸附分支会算出朝外，
// 所以用显式覆盖；恢复吸附、用户拖动或服务端还原位置时清掉。
let fallbackFacing = null

function placeFallbackCorner() {
  const corner = fallbackCorner()
  fallbackFacing = corner.indexOf('r') >= 0 ? 'left' : 'right'
  const target = cornerPos(corner)
  place(target.x, target.y)
  return target
}

let floatingDefaultPending = false
let floatingDefaultAt = 0
let floatingRectApplied = false
let lastServerMode = ''
let localFloatingAt = 0
// 宿主最小化/消失后的兜底位置：settings.fallbackCorner 指定的角落，并写回 floating.rect。
// 不写回的话下一次 /v1/state 轮询会拿旧 rect 把角色再挪走。
async function placeFloatingDefault() {
  const target = placeFallbackCorner()
  if (state.pet.mode !== 'floating') return target
  state.pet = { ...state.pet, rect: { x: target.x, y: target.y, width: foxSize(), height: foxSize() } }
  if (floatingDefaultPending || Date.now() - floatingDefaultAt < 2000) return target
  floatingDefaultPending = true
  try {
    const r = await write('/v1/pet/move', 'POST', {
      rect: { x: target.x, y: target.y, width: foxSize(), height: foxSize() },
    })
    if (r && r.ok && r.pet) state.pet = r.pet
  } catch (err) {}
  finally {
    floatingDefaultPending = false
    floatingDefaultAt = Date.now()
  }
  return target
}

function sameRect(a, b) {
  if (!a || !b) return false
  const aw = Number(a.width != null ? a.width : a.w)
  const ah = Number(a.height != null ? a.height : a.h)
  const bw = Number(b.width != null ? b.width : b.w)
  const bh = Number(b.height != null ? b.height : b.h)
  return Number(a.x) === Number(b.x) && Number(a.y) === Number(b.y) && aw === bw && ah === bh
}

function screenHalf() {
  const s = foxSize()
  return {
    h: pos.x + s / 2 < window.innerWidth / 2 ? 'left' : 'right',
    v: pos.y + s / 2 < window.innerHeight / 2 ? 'top' : 'bottom',
  }
}

function shouldMirror(box) {
  if (fallbackFacing) return fallbackFacing === 'right'
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

// 视口变化（换屏/DPI 变化）才允许重算快览卡锚点。
window.addEventListener('resize', () => {
  quickTop = null
  placeAll()
})

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
  fallbackFacing = null
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
  // 吸附后必须落在 agent 窗口矩形内；窗口缩小/自由偏移越界时夹回来，
  // 避免出现「显示已吸附，但挂件在窗口外」。
  const minX = box.x
  const maxX = box.x + Math.max(0, box.w - s)
  const minY = box.y
  const maxY = box.y + Math.max(0, box.h - s)
  place(Math.max(minX, Math.min(maxX, x)), Math.max(minY, Math.min(maxY, y)))
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
  const prevServerMode = lastServerMode
  const s = await read('/v1/state')
  if (!s || !s.ok) return
  state = s
  const p = s.pet || {}
  lastServerMode = p.mode || ''
  const localFloatRecent = Date.now() - localFloatingAt < 3000
  if (p.mode === 'attached' && p.hwnd) {
    // 用户刚拖到桌面时，daemon 可能还有一帧旧的 attached 响应在途；3 秒内
    // 以本地落点为准，避免 follow 把角色拉回吸附位置。
    if (localFloatRecent) return
    floatingRectApplied = false
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
      // 绑定切换：模型族要重新累计两拍，不能沿用上一个宿主的角色。
      resetAutoRole(p.agentId || '')
      place(0, 0) // 先夹住，rect 回来再贴边
    }
    markRestored(p.hwnd)
    refreshRect()
  } else if (p.mode === 'floating') {
    bound = { ...bound, agentId: '', hwnd: '' }
    delete document.body.dataset.restored
    delete document.body.dataset.boundKey
    // 旧状态可能把 attached 的宿主窗口矩形带进 floating；那不是角色坐标。
    // 一律识别出来并落到右下角，避免最小化后“随机飞到”宿主原来的位置。
    const hostRects = (s.agents || []).flatMap((a) => (a.windows || []).map((w) => w.rect)).filter(Boolean)
    const staleHostRect = !!(p.rect && hostRects.some((r) => sameRect(r, p.rect)))
    const lostAttachedHost = !localFloatRecent && prevServerMode === 'attached'
    if (lostAttachedHost) {
      // 吸附 → 悬浮只处理一次：宿主最小化/关闭，兜底右下角并写回位置。
      await placeFloatingDefault()
      floatingRectApplied = true
    } else if (!floatingRectApplied) {
      // 首次进入悬浮（启动恢复 / 其它客户端切换）才应用持久化位置；
      // 之后不再每次 /v1/state 都重放旧 rect，避免把用户刚拖到的位置拉回去。
      if (p.rect && Number.isFinite(p.rect.x) && !staleHostRect) {
        fallbackFacing = null
        place(p.rect.x, p.rect.y)
      } else {
        await placeFloatingDefault()
      }
      floatingRectApplied = true
    }
  } else {
    bound = { agentId: '', hwnd: '', title: '', exe: '', pid: 0, startMs: 0, rect: null }
    floatingRectApplied = false
    delete document.body.dataset.restored
    delete document.body.dataset.boundKey
    if (!placedOnce) {
      // 第一次拿到可用状态（首帧 /v1/state 可能因 daemon 刚起而失败过一次）
      // 才把角色放到兜底角落；不能等 startSnapshotSeen，否则会停在 (0,0)。
      placeFallbackCorner()
      placedOnce = true
    }
  }
  applySettings()
  renderChip()
}

// 宿主失前台/被完全覆盖的兜底防抖：/rect 带 background 标记持续超过该时长
// 才落位，避免频繁切窗时角色来回抖动；回前台后由 follow 轮询自动恢复吸附。
// 500ms 在「切走立刻有反馈」与「Alt+Tab 瞬间往返不抖动」之间取平衡（用户定稿）。
const HOST_BACKGROUND_FALLBACK_MS = 500
let hostBackgroundSince = 0

function noteHostBackground(isBackground) {
  const now = Date.now()
  if (!isBackground) {
    hostBackgroundSince = 0
    return false
  }
  if (!hostBackgroundSince) hostBackgroundSince = now
  return now - hostBackgroundSince >= HOST_BACKGROUND_FALLBACK_MS
}

// /rect 结果的统一处理（refreshRect 与测试的 debugRectResult 共用一条路径）。
// background 只影响「角色显示在哪」，不解除绑定、不改 daemon 状态（D041）：
// 宿主回前台后 placeAnchored 自动贴回去。
function applyRectResult(r) {
  if (r && r.ok && r.rect) {
    bound.rect = r.rect
    if (noteHostBackground(r.background === true)) {
      // 失前台超过阈值：落兜底位（不跟随后台宿主挪动）。
      placeFallbackCorner()
    } else {
      placeAnchored(r.rect)
    }
    return
  }
  const reason = r && r.reason
  if (reason === 'minimized' || reason === 'offscreen') {
    // 最小化/移出屏幕时 /rect 会明确失败；之前这里直接 return，角色停在
    // 旧位置不动。先落到兜底角落，等 daemon 转 floating 后再写回位置。
    hostBackgroundSince = 0
    placeFallbackCorner()
  }
}

async function refreshRect() {
  if (!bound.hwnd || dragging || pressing) return
  const r = await read('/rect?hwnd=' + encodeURIComponent(bound.hwnd))
  if (!r) return
  applyRectResult(r)
}

async function refreshAgentData(force) {
  const agentId = bound.agentId || state.pet.profileOf || state.pet.lastAgentId
  if (!agentId) {
    snapshot = null
    context = null
    resetAutoRole('')
    renderChip()
    if (quickOpen) renderQuick()
    return
  }
  const d = await read('/v1/agents/' + encodeURIComponent(agentId) + '/snapshot' + (force ? '?force=1' : ''))
  if (!d || !d.ok) return
  // 并发轮询/SSE 的旧响应晚到会覆盖新快照，也会让回合指纹倒退、重复弹泡。
  const capturedAt = Number(d.snapshot && d.snapshot.capturedAt) || 0
  if (capturedAt && capturedAt < lastSnapshotAt) return
  lastSnapshotAt = capturedAt
  snapshot = d.snapshot
  context = d.context
  maybeAutoRole(agentId)
  // 每次接受新快照后检查今日预算（同日同阈值只提醒一次）。
  checkBudgetAlerts()
  // 只认回合身份（completed_at），不能把今日金额算进来：回合内每次工具调用
  // 都会让今日金额变化，旧条件会把 5 秒气泡无限续期。
  const fp = turnFingerprint(snapshot)
  if (startSnapshotSeen && fp && fp !== lastSnapshotFingerprint && settings.turnBubble && snapshot.ok && snapshot.turn) {
    const v = moneyText(snapshot.turn, snapshot.unit)
    showBubble('本轮 ' + v, ADAPTER_NAMES[agentId] || agentId, { ms: settings.turnBubbleMs, kind: 'turn' })
  }
  lastSnapshotFingerprint = fp
  startSnapshotSeen = true
  renderChip()
  if (quickOpen) renderQuick()
}

function turnFingerprint(snap) {
  if (!snap || !snap.turn) return ''
  const at = Number(snap.turn.at)
  if (Number.isFinite(at) && at > 0) return 'at:' + at
  // 没有回合时间戳的宿主退回「金额 + 币种 + 本轮 tokens」，仍是稳定的
  // 回合级标识，不会随今日累计变化。
  return ['amt', snap.turn.amount, snap.turn.currency, snap.usage && snap.usage.turnTokens].join('|')
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

// 当前主数字实际属于哪个厂商/套餐。所有宿主共用快照字段：
// quotaCard.title（厂商名）→ plan（套餐）→ 窗口标题，逐级回退；
// 与宿主名相同的值不重复显示（避免「ZCode  ZCode」）。
function vendorLabel(agentId, withPlan = false) {
  const card = (snapshot && snapshot.quotaCard) || {}
  const agent = agentName(agentId)
  let name = card.title && card.title !== agent ? card.title : ''
  if (!name && snapshot && snapshot.plan && snapshot.plan !== agent) name = snapshot.plan
  if (!name && bound.title && bound.title !== agent) name = bound.title
  if (!name) return ''
  if (withPlan && card.plan && card.plan !== name) return name + ' · ' + card.plan
  return name
}

function agentAccent(id) {
  const a = (state.agents || []).find((x) => x.id === id)
  if (a && a.accent) return a.accent
  const role = FOX_ROLES[roleForAgent(id)]
  return (role && role.accent) || '#f0a04b'
}

// ---------- 会话状态（D034） ----------
const STATUS_TEXT = {
  working: '工作中',
  waiting_permission: '等待确认',
  waiting_input: '等待输入',
  error: '出错',
  done: '已完成',
  idle: '',
  unknown: '状态未知',
}
function statusOfCounts(row) {
  if (!row) return ''
  // 有会话在等待/工作时，不能因为另一个会话刚失败就整只狐狸显示「出错」。
  if (row.waiting > 0) return 'waiting_permission'
  if (row.working > 0) return 'working'
  if (row.error > 0) return 'error'
  if (row.done > 0) return 'done'
  return ''
}

function boundStatus() {
  const live = state.live || {}
  const agentId = bound.agentId || state.pet.profileOf || ''
  const byAgent = live.byAgent && agentId ? live.byAgent[agentId] : null
  // 已绑定某个宿主时，只信这个宿主的计数；没有记录就是空闲，不能拿全局
  // 聚合冒充（否则 WorkBuddy 工作中会让 ZCode 胶囊显示「工作中」）。
  if (agentId) return statusOfCounts(byAgent) || 'idle'
  return live.aggregate && live.aggregate !== 'idle' && live.aggregate !== 'unknown' ? live.aggregate : 'idle'
}

function openConsolePage(page) {
  if (window.foxOverlay && typeof window.foxOverlay.openConsole === 'function') {
    window.foxOverlay.openConsole(page)
  }
}

async function loadQuickSessions(force = false) {
  // SSE 的 session/sessions 事件可能很密；1 秒内复用结果，且同一时间只允许
  // 一个请求，避免响应乱序把新列表覆盖回旧列表。
  if (quickSessionsLoading) {
    if (force) quickSessionsPending = true
    return
  }
  if (!force && Date.now() - quickSessionsAt < 1000) return
  quickSessionsLoading = true
  const agentId = bound.agentId || state.pet.profileOf || ''
  try {
    const q = '/v1/sessions?limit=3&sort=updated' + (agentId ? '&agent=' + encodeURIComponent(agentId) : '')
    const d = await read(q)
    if (!d || !d.ok) return
    // 请求期间切换了绑定宿主：丢弃旧结果并补一次。
    const nowId = bound.agentId || state.pet.profileOf || ''
    if (agentId !== nowId) {
      quickSessionsPending = true
      return
    }
    quickSessionItems = Array.isArray(d.items) ? d.items.slice(0, 3) : []
    quickSessionsAt = Date.now()
    if (quickOpen) renderQuick()
  } finally {
    quickSessionsLoading = false
    if (quickSessionsPending) {
      quickSessionsPending = false
      loadQuickSessions(true)
    }
  }
}

function renderChip() {
  const profileId = bound.agentId || state.pet.profileOf || ''
  // 大浮窗与小胶囊共用角色侧边的同一块位置：打开大浮窗时收起小胶囊。
  // 悬浮时只在真的有上一份 agent 档案时显示；generic/空档案不显示「其它 —」。
  const hasProfile = !!profileId && profileId !== 'generic'
  const visible = !!(bound.agentId || (state.pet.mode === 'floating' && hasProfile)) && settings.showChip && !quickOpen && !hideMoney
  chip.hidden = !visible
  chip.classList.toggle('open', visible)
  if (!visible) return
  const agentId = profileId
  // 小胶囊第一行固定写宿主（ZCode / WorkBuddy…），余额属于哪个厂商放在
  // title 提示里；大浮窗的灰色副标题才显示厂商。
  const vendor = vendorLabel(agentId)
  const status = boundStatus()
  chipAdapter.textContent = agentName(agentId) + (STATUS_TEXT[status] ? ' · ' + STATUS_TEXT[status] : '')
  chip.title = agentName(agentId) + (vendor ? ' · ' + vendor : '')
  const metric = mainMetric(snapshot, agentId)
  chipValue.textContent = metric.value
  chipDot.className = 'chip-dot ' + (status === 'working' ? 'working' : status === 'error' ? 'bad' : status === 'waiting_permission' || status === 'waiting_input' ? 'warn' : status === 'done' ? 'done' : !snapshot || !snapshot.ok ? 'warn' : snapshot.supported === false ? 'bad' : '')
  const live = state.live || {}
  // 角标与胶囊状态保持同一口径：绑定了宿主就只数这个宿主，悬浮未绑定才看全局。
  const scope = bound.agentId && live.byAgent ? live.byAgent[bound.agentId] : live.counts
  const counts = scope || {}
  const active = (Number(counts.working) || 0) + (Number(counts.waiting) || 0)
  if (chipMulti) {
    chipMulti.hidden = active < 2
    chipMulti.textContent = active > 9 ? '9+' : String(active)
    chipMulti.setAttribute('aria-label', active + ' 个活跃会话')
    chipMulti.title = active + ' 个活跃会话'
  }
  const pct = context && context.supported && Number.isFinite(context.pct) ? context.pct : null
  const C = 2 * Math.PI * 7
  chipRingValue.style.strokeDasharray = String(C)
  chipRingValue.style.strokeDashoffset = String(C * (1 - (pct == null ? 0 : pct) / 100))
  const ring = document.getElementById('chip-ring')
  if (ring) ring.style.display = pct == null ? 'none' : ''
  applyAccent(agentAccent(agentId))
  // 只挪胶囊：renderChip 由快照/角色/状态频繁触发，不能顺带重算快览卡位置。
  positionChip()
}

function renderQuick() {
  if (quick.hidden) return
  const agentId = bound.agentId || state.pet.profileOf || ''
  const known = !!agentId && agentId !== 'generic'
  const metric = mainMetric(snapshot, agentId)
  quickAgent.textContent = known ? agentName(agentId) : state.pet.mode === 'floating' ? '桌面' : '未绑定'
  const vendor = known ? vendorLabel(agentId, true) : ''
  quickStatus.textContent =
    vendor ||
    (state.pet.mode === 'floating'
      ? known
        ? '桌面 · 沿用 ' + agentName(state.pet.profileOf)
        : '未绑定'
      : state.pet.mode === 'idle'
        ? settings.petMode
          ? '未吸附'
          : '拖到宿主窗口可吸附'
        : '')
  quickStatus.hidden = !quickStatus.textContent
  quickDot.className = 'quick-dot ' + (!snapshot || !snapshot.ok ? 'bad' : '')
  quickValue.textContent = metric.value
  quickSub.textContent = metric.label + (snapshot && snapshot.turn ? ' · 上一轮 ' + moneyText(snapshot.turn, snapshot.unit) : '')
  const pct = context && context.supported && Number.isFinite(context.pct) ? context.pct : null
  quickCtxBar.style.width = (pct == null ? 0 : pct) + '%'
  quickCtxBar.style.background = pct == null ? 'var(--surface-2)' : pct >= 92 ? 'var(--bad)' : pct >= 80 ? 'var(--warn)' : 'var(--pet-accent)'
  quickCtxPct.textContent = pct == null ? '—' : pctText(pct)
  const compacted = !!(context && context.supported && context.used == null && context.compaction)
  quickCtxAbs.textContent = compacted
    ? '已压缩'
    : context && context.supported && context.used != null
      ? tokensText(context.used) + (context.limit ? ' / ' + tokensText(context.limit) : '')
      : '暂无'
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
  renderPeriod()
  quickSessionsEl.hidden = quickSessionItems.length === 0
  quickSessionList.replaceChildren()
  for (const item of quickSessionItems) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'quick-session-row'
    row.setAttribute('aria-label', '打开会话 ' + (item.title || item.key))
    const dot = document.createElement('span')
    dot.className = 'status-dot ' + (item.status || 'unknown')
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = item.title || item.key
    const st = document.createElement('span')
    st.className = 'state'
    st.textContent = item.status === 'idle' ? '空闲' : STATUS_TEXT[item.status] || '状态未知'
    row.append(dot, title, st)
    row.addEventListener('click', () => {
      toggleQuick(false)
      openConsolePage('sessions?select=' + encodeURIComponent(item.key))
    })
    quickSessionList.appendChild(row)
  }
  // 内容/会话/气泡变化只改卡片内部布局；位置由 positionQuick 的锚点决定，
  // 这里绝不能重算，否则内容一变 top 就会被底部夹取推上去（表现为抽动）。
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
  // 默认与角色底边齐平（旧挂件的小胶囊观感），只贴侧边，不压角色。
  // 角色贴屏幕底边时允许胶囊触碰屏幕底边，不再额外留 8px，否则看起来仍偏高。
  const y = Math.max(8, Math.min(window.innerHeight - h, pos.y + foxH - h))
  chip.style.left = Math.round(x) + 'px'
  chip.style.top = Math.round(y) + 'px'
}

function positionQuick() {
  if (quick.hidden) return
  const w = quick.offsetWidth || 320
  const foxH = fox.getBoundingClientRect().height || foxSize()
  const x = sideX(w)
  // 锚点只在首次打开 / 角色移动 / 窗口尺寸变化时确定。之后内容（会话、额度窗口、
  // 台词气泡）怎么变，top 都不动：卡片向下伸展，放不下就在卡片内部滚动。
  // 唯一的例外是视口太小，锚点本身必须留在可视区里，才会被夹一次。
  if (quickTop == null) {
    const h = quick.offsetHeight || 300
    const reserve = Math.min(Math.max(h, 360), Math.min(480, window.innerHeight - 16))
    quickTop = Math.max(8, Math.min(window.innerHeight - reserve - 8, pos.y + foxH / 2 - reserve / 2))
  }
  const top = Math.max(8, Math.min(quickTop, Math.max(8, window.innerHeight - 120)))
  quickTop = top
  quick.style.left = Math.round(x) + 'px'
  quick.style.top = Math.round(top) + 'px'
  // 向下伸展的上限沿用卡片原来的 480px；超出后卡片内部滚动，不能反过来推 top。
  quick.style.maxHeight = Math.max(120, Math.min(480, window.innerHeight - top - 8)) + 'px'
}

function toggleQuick(open) {
  quickOpen = typeof open === 'boolean' ? open : !quickOpen
  quickTop = null
  quick.hidden = !quickOpen
  // 大浮窗打开时收起小胶囊，两者占同一个侧边位置，不叠在角色身上。
  renderChip()
  if (quickOpen) {
    closeMenu()
    renderQuick()
    // 打开时确定一次锚点；之后 renderQuick 不再改 top。
    positionQuick()
    loadQuickSessions(true)
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
  const quickRect = quickOpen && !quick.hidden ? quick.getBoundingClientRect() : null
  const clampX = (x) => Math.max(margin, Math.min(window.innerWidth - w - margin, x))
  const clampY = (y) => Math.max(margin, Math.min(window.innerHeight - h - margin, y))
  const foxRect = { left: pos.x, top: pos.y, right: pos.x + s, bottom: pos.y + s }
  const overlapRect = (x, y, rect) => {
    if (!rect) return 0
    const ww = Math.max(0, Math.min(x + w, rect.right) - Math.max(x, rect.left))
    const hh = Math.max(0, Math.min(y + h, rect.bottom) - Math.max(y, rect.top))
    return ww * hh
  }
  const overlap = (x, y) => overlapRect(x, y, quickRect)
  const foxOverlap = (x, y) => overlapRect(x, y, foxRect)
  const candidates = [
    // 默认优先角色上方；下方作为备选。
    { x: clampX(center - w / 2), y: clampY(pos.y - h - 10), below: false },
    { x: clampX(center - w / 2), y: clampY(pos.y + s + 10), below: true },
  ]
  // 大浮窗打开时，气泡被它盖住会看不清；把「浮窗上方/下方/左右外侧」也作为
  // 候选，选与浮窗重叠面积最小的那个。外侧候选是卡片很高、上下都放不下时的兜底。
  if (quickRect) {
    candidates.push({ x: clampX(center - w / 2), y: clampY(quickRect.top - h - 10), below: false })
    candidates.push({ x: clampX(center - w / 2), y: clampY(quickRect.bottom + 10), below: true })
    const sideY = clampY(pos.y + s / 2 - h / 2)
    candidates.push({ x: clampX(quickRect.right + 10), y: sideY, below: false })
    candidates.push({ x: clampX(quickRect.left - w - 10), y: sideY, below: false })
    // 角色贴右下角时，右侧/下方的候选很容易被屏幕边缘裁掉；优先放在
    // 快览卡左侧并与卡片底部对齐，保证整只气泡都在视口内。
    candidates.push({ x: clampX(quickRect.left - w - 10), y: clampY(quickRect.bottom - h), below: false })
    // 快览卡在角色同侧时，外侧候选可能压住角色本体；再补角色左右外侧。
    candidates.push({ x: clampX(pos.x + s + 10), y: sideY, below: false })
    candidates.push({ x: clampX(pos.x - w - 10), y: sideY, below: false })
  }
  let best = candidates[0]
  let bestScore = Infinity
  for (const c of candidates) {
    const overflow =
      (c.x <= margin + 1 || c.x + w >= window.innerWidth - margin - 1 ? 1 : 0) +
      (c.y <= margin + 1 || c.y + h >= window.innerHeight - margin - 1 ? 1 : 0)
    // 快览卡 > 角色本体 > 临时遮挡的优先级；最后才用上下偏好打破平手。
    // 完全在视口内是硬条件，宁可离角色远一点，也不能把气泡裁到屏幕外。
    const score = overlap(c.x, c.y) * 100 + foxOverlap(c.x, c.y) * 20 + overflow * 500 + (c.below ? 0.5 : 0)
    if (score < bestScore) {
      best = c
      bestScore = score
    }
  }
  const arrow = Math.max(18, Math.min(w - 18, center - best.x))
  el.style.left = Math.round(best.x) + 'px'
  el.style.top = Math.round(best.y) + 'px'
  el.classList.toggle('below', best.below)
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

let bubbleSeq = 0

function showBubble(text, sub, opts = {}) {
  if (settings.dnd) return
  // 隐藏金额 = 不弹消耗/余额气泡；金额本身在胶囊里也保持掩码。
  if (hideMoney) return
  if (!text || !text.trim()) return
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleKind = opts.kind === 'turn' || opts.kind === 'budget' ? opts.kind : 'queue'
  const wasOpen = !bubble.hidden && bubble.classList.contains('open')
  const seq = ++bubbleSeq
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
      // showBubble 后同一帧内被 hideBubble 关掉时，不能再把 open 加回来。
      if (seq === bubbleSeq && !bubble.hidden) bubble.classList.add('open')
    })
  }
  const ms = opts.ms == null ? settings.turnBubbleMs : opts.ms
  if (ms > 0) bubbleTimer = setTimeout(hideBubble, Math.max(1500, ms))
}

function hideBubble() {
  bubbleSeq += 1
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = null
  bubbleKind = ''
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
  showBubble(text, sub, { ms: 6000, kind: 'queue' })
  return true
}

// ---------- 今日预算提醒（P0-2） ----------

function budgetStorage() {
  try {
    return window.localStorage || null
  } catch (err) {
    return null
  }
}

function budgetSeen(key) {
  // 先看内存：storage 的 setItem 失败（配额满）但 getItem 还可用时，
  // 只查 storage 会漏掉同一进程里已经提醒过的键。
  if (budgetMemorySeen.has(key)) return true
  const store = budgetStorage()
  if (store) {
    try {
      return store.getItem(key) === '1'
    } catch (err) {}
  }
  return false
}

// localStorage 失败（隐私模式/配额满）时退回内存 Set：本次进程只提醒一次，
// 重载后会再提醒一次，这是已记录的降级，不做静默丢提醒。
function markBudgetSeen(key) {
  const store = budgetStorage()
  if (store) {
    try {
      store.setItem(key, '1')
      return
    } catch (err) {}
  }
  budgetMemorySeen.add(key)
}

// 只保留今天的键；昨天/更早的阈值记录没有价值，还会让 localStorage 越积越多。
function cleanBudgetKeys(today) {
  const store = budgetStorage()
  if (!store) return
  try {
    const stale = []
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)
      if (!key || key.indexOf(BUDGET_KEY_PREFIX) !== 0) continue
      const date = key.slice(BUDGET_KEY_PREFIX.length).split('.')[0]
      if (date !== today) stale.push(key)
    }
    for (const key of stale) store.removeItem(key)
  } catch (err) {}
}

function budgetBubbleText(alert) {
  const unit = alert.kind === 'credit' ? 'credit' : 'money'
  const used = moneyText({ amount: alert.amount, currency: alert.currency }, unit)
  const limit = moneyText({ amount: alert.threshold, currency: alert.currency }, unit)
  return '今日已用 ' + used + '，达到预算 ' + limit
}

// 每次接受新快照后调用。金额/积分各自独立，同一日期+同一阈值只提醒一次；
// 改阈值会生成新键，可以再次提醒；勿扰/隐藏金额直接不弹。
function checkBudgetAlerts() {
  if (settings.dnd || settings.hideMoney) return null
  const alert = budgetAlertOf(snapshot, settings)
  if (!alert) return null
  const agentId = bound.agentId || state.pet.profileOf || state.pet.lastAgentId || ''
  const today = localDateKey(Date.now())
  // 每次检查都顺手清掉旧日期的键；只留今天，避免记录无限增长。
  cleanBudgetKeys(today)
  const key = budgetAlertKey(today, agentId, alert.kind, alert.threshold)
  if (budgetSeen(key)) return null
  markBudgetSeen(key)
  showBubble(budgetBubbleText(alert), agentName(agentId), { ms: 8000, kind: 'budget' })
  return alert
}

// ---------- 菜单 ----------

function menuItem(label, fn, opts = {}) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'menu-item' + (opts.danger ? ' danger' : '')
  b.textContent = label
  if (opts.testid) b.dataset.testid = opts.testid
  if (opts.title) b.title = opts.title
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
  menu.appendChild(
    menuItem(
      (settings.autoRoleByModel ? '✓ ' : '') + '按模型换角色',
      toggleAutoRole,
      { testid: 'menu.autoRole', title: '按当前模型族连续两拍确认后自动切换角色；手动选角会关闭它' }
    )
  )
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
  // 「本次退出」与设置里的「开机自启」是两回事：这里只停本次的守护进程与宠物层，
  // 自启开关不受影响（下次开机照常拉起，或手动 npm start）。文案与托盘
  // （overlay/main.cjs）及 UI-SPEC §1 的「（本次退出）」保持一致。
  menu.appendChild(menuItem('退出 fox-dock（本次退出）', () => window.foxOverlay && window.foxOverlay.quitDock && window.foxOverlay.quitDock(), { danger: true }))

  menuOpen = true
  menu.hidden = false
  // 菜单不能超出屏幕：限制最大高度，位置按最终高度夹住；角色图片稍后加载
  // 导致高度变化时，ResizeObserver 会再夹一次。
  menu.style.maxHeight = Math.max(160, window.innerHeight - 16) + 'px'
  // 菜单宽度 196px（含边框）：x 右界按 196+8 夹，文本不会被屏幕边缘裁掉。
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 204, x)) + 'px'
  menu.style.top = Math.max(8, Math.min(window.innerHeight - menu.offsetHeight - 8, y)) + 'px'
  positionMenu()
  requestAnimationFrame(positionMenu)
  setInteractive(true)
}

function positionMenu() {
  if (!menuOpen) return
  const w = menu.offsetWidth || 196
  const h = menu.offsetHeight || 300
  // 菜单太高时贴着屏幕上边，剩下的靠自身滚动；不能把顶部夹成负数。
  const maxTop = Math.max(8, window.innerHeight - h - 8)
  const x = parseFloat(menu.style.left || '200') || 200
  const y = parseFloat(menu.style.top || '200') || 200
  menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x)) + 'px'
  menu.style.top = Math.max(8, Math.min(maxTop, y)) + 'px'
}

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    if (menuOpen) positionMenu()
  }).observe(menu)
}

function closeMenu() {
  menuOpen = false
  menu.hidden = true
  if (!quickOpen && !dragging && !pressing) setInteractive(false)
}

async function toggleAutoRole() {
  const next = !settings.autoRoleByModel
  const agentId = bound.agentId || state.pet.profileOf || state.pet.lastAgentId || ''
  resetAutoRole(agentId)
  rolePending = null
  await patchSettings({ autoRoleByModel: next })
  syncRole()
  renderChip()
  if (quickOpen) renderQuick()
}

async function pickRole(id) {
  const agentId = bound.agentId || state.pet.profileOf
  const prevProfiles = settings.profiles
  const prevRoleId = settings.roleId
  const prevAuto = settings.autoRoleByModel
  const prevProfileRole = agentId ? ((prevProfiles || {})[agentId] || {}).roleId || '' : ''
  // 手动选角 = 明确覆盖：立即关闭「按模型换角色」，清掉两拍状态。
  resetAutoRole(agentId || '')
  // 15 秒覆盖窗口：慢的设置回执不能让角色先弹回再切（旧值 6 秒在慢响应下不够）。
  rolePending = { agentId: agentId || '__global', roleId: id, prevRole: prevProfileRole, until: Date.now() + 15000 }
  if (agentId) {
    settings = {
      ...settings,
      autoRoleByModel: false,
      profiles: { ...(settings.profiles || {}), [agentId]: { ...((settings.profiles || {})[agentId] || {}), roleId: id } },
    }
  } else {
    settings = { ...settings, roleId: id, autoRoleByModel: false }
  }
  roleId = id
  applyRole(id)
  let ok = true
  let profileWritten = false
  if (agentId) {
    const r = await write('/v1/profiles/' + encodeURIComponent(agentId), 'PUT', { roleId: id })
    ok = !!(r && r.ok)
    if (ok) {
      profileWritten = true
      // 手动选角必须同时关闭自动换角色；这个请求失败也算整体失败，否则
      // 15s 覆盖窗口过后角色会被模型族重新覆盖。
      const s = await write('/v1/settings', 'PUT', { autoRoleByModel: false })
      ok = !!(s && s.ok)
    }
  } else {
    const r = await patchSettings({ roleId: id, autoRoleByModel: false })
    ok = !!(r && r.ok)
  }
  if (!ok) {
    rolePending = null
    settings = { ...settings, profiles: prevProfiles, roleId: prevRoleId, autoRoleByModel: prevAuto }
    // 第一段 PUT /v1/profiles 已成功、第二段 settings 失败：服务端 profile 里
    // 已是新 roleId。rolePending 清空后下一次 settings 轮询会把角色再弹到
    // 服务端值，表现为「先弹回旧角色、又被切到新角色」的抖动——这里把
    // 服务端 profile 也写回旧值，两边一致（roleId:'' 合法，表示清除覆盖）。
    if (profileWritten) {
      try {
        await write('/v1/profiles/' + encodeURIComponent(agentId), 'PUT', { roleId: prevProfileRole })
      } catch (err) {}
    }
    syncRole()
  }
  renderChip()
  if (quickOpen) renderQuick()
}

// ---------- 吸附 / 悬浮 ----------

function isAgentWindow(win) {
  const exe = String((win && win.exe) || '').replace(/\\/g, '/').toLowerCase()
  const base = exe.split('/').pop()
  return AGENT_EXES.has(base) || AGENT_EXE_INCLUDES.some((part) => exe.includes(part))
}

function isIgnoredWindow(win) {
  if (!win) return true
  if (IGNORE_PIDS.has(win.pid)) return true
  if (IGNORE_CLASSES.has(win.cls)) return true
  if (!win.exe && !win.title) return true
  const exe = String(win.exe || '').replace(/\\/g, '/').toLowerCase()
  const base = exe.split('/').pop()
  if (AUX_EXES.has(base)) return true
  if (AUX_TITLE_RE.test(String(win.title || ''))) return true
  return /electron\.exe$/i.test(win.exe || '') && /fox-dock overlay|小挂件/i.test(win.title || '')
}

// 返回 { win, seq, fresh }：seq 在真正发起命中的那一刻递增，调用方只应用
// 比已应用结果更新的响应；被节流/忙线时返回 fresh:false，不再拿上一次的
// currentTarget 冒充当前位置（否则拖到 ZCode 上仍显示「松手放在桌面」）。
async function hitAt(clientX, clientY, force = false) {
  const now = performance.now()
  if (!force) {
    if (hitBusy) {
      pendingHit = { x: clientX, y: clientY }
      return { win: null, seq: 0, fresh: false }
    }
    if (now - lastHitAt < 30) return { win: null, seq: 0, fresh: false }
  }
  const seq = ++hitSeq
  hitBusy = true
  lastHitAt = now
  try {
    const api = window.foxOverlay
    const dpr = window.devicePixelRatio || 1
    const o = await ensureOrigin()
    const px = Math.round((clientX + o.x) * dpr)
    const py = Math.round((clientY + o.y) * dpr)
    const data = api && typeof api.hit === 'function' ? await api.hit(px, py, SELF_PID) : null
    const hits = data && Array.isArray(data.hits) ? data.hits : []
    // 只认指针最上层的真实窗口：如果最上面是 QQ/桌面/输入体验，就落桌面，
    // 不再从下面翻出 ZCode 来吸附（那会把挂件贴到用户没指着的窗口上）。
    const top = hits.find((w) => !isIgnoredWindow(w))
    if (!top) return { win: null, seq, fresh: true }
    if (isAgentWindow(top)) return { win: top, seq, fresh: true }
    return { win: ALLOW_GENERIC ? top : null, seq, fresh: true }
  } catch (err) {
    return { win: null, seq, fresh: false }
  } finally {
    hitBusy = false
    if (pendingHit) {
      const p = pendingHit
      pendingHit = null
      probeAt(p.x, p.y, true)
    }
  }
}

async function probeAt(clientX, clientY, force = false) {
  const r = await hitAt(clientX, clientY, force)
  if (!r || !r.fresh || !dragging) return
  if (r.seq < lastHitSeq) return
  lastHitSeq = r.seq
  currentTarget = r.win
  fox.classList.toggle('armed', !!r.win)
  setDragHint(r.win ? '松手吸附到 ' + (r.win.title || r.win.exe) : '松手放在桌面', !!r.win)
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
  resetAutoRole(data.pet.agentId || '')
  // 重新吸附 = 新的失前台防抖起点：不能带着旧计时立刻把角色弹回右下角。
  hostBackgroundSince = 0
  localStorage.setItem('fox-dock:anchor:' + win.hwnd, JSON.stringify(anchor))
  state.pet = data.pet
  floatingRectApplied = false
  localFloatingAt = 0
  lastServerMode = 'attached'
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
  floatingRectApplied = true
  fallbackFacing = null // 用户亲手拖到的地方：朝向回到屏幕中线规则
  localFloatingAt = Date.now()
  lastServerMode = 'floating'
  bound = { ...bound, agentId: '', hwnd: '' }
  const profileId = state.pet.profileOf || state.pet.lastAgentId || ''
  resetAutoRole(profileId)
  roleId = roleForAgent(profileId)
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

function setBusy(on) {
  try {
    if (window.foxOverlay && window.foxOverlay.setBusy) window.foxOverlay.setBusy(!!on)
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
  pressDown()
  playPress()
  setBusy(true)
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
    // 落点提示会盖住胶囊；拖拽期间先收起胶囊，松手后再按新状态渲染。
    chip.style.visibility = 'hidden'
    // 关闭「吸附到 agent 窗口」后角色不再与窗口绑定，拖拽不需要落点提示。
    dragHint.hidden = settings.petMode
    lastHintText = ''
  }
  if (!dragging) return
  place(e.clientX - foxSize() / 2, e.clientY - foxSize() / 2)
  if (settings.petMode) {
    currentTarget = null
    fox.classList.remove('armed')
    return
  }
  probeAt(e.clientX, e.clientY)
})

window.addEventListener('pointerup', async (e) => {
  if (!pressing) return
  const wasDragging = dragging
  pressing = null
  pressUp()
  releaseAfterPress()
  let target = currentTarget
  dragging = false
  currentTarget = null
  pointer = null
  hitSeq++
  fox.classList.remove('dragging', 'armed')
  dragHint.hidden = true
  if (!wasDragging) {
    // 再次点击角色只更新台词，不把已经打开的快览卡关掉。
    setBusy(false)
    if (!quickOpen) toggleQuick(true)
    speak()
    return
  }
  // 松手点重新采样，避免拖拽节流留下上一次的 target（例如最后 30ms 已经
  // 移到 QQ/桌面上，却仍按旧 target 吸附）；同时用松手坐标校正一次落点，
  // 防止最后一段 pointermove 被节流时浮层仍停在旧位置。
  if (!settings.petMode) {
    const hit = await hitAt(e.clientX, e.clientY, true)
    target = hit && hit.win ? hit.win : null
  }
  place(e.clientX - foxSize() / 2, e.clientY - foxSize() / 2)
  if (settings.petMode) {
    await floatAt()
  } else if (target) {
    const ok = await bindTo(target)
    if (!ok) await floatAt()
  } else {
    await floatAt()
  }
  setBusy(false)
  chip.style.visibility = ''
  renderChip()
  setInteractive(isOverUI(e.clientX, e.clientY))
})

window.addEventListener('pointercancel', () => {
  if (!pressing) return
  pressing = null
  dragging = false
  chip.style.visibility = ''
  renderChip()
  setBusy(false)
  setInteractive(false)
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
  // 本轮消耗 / 预算提醒是通知，不是按压队列：点一下就是关掉它。
  if (bubbleKind === 'turn' || bubbleKind === 'budget') {
    hideBubble()
    return
  }
  if (!queue.length) await loadQueue()
  if (playQueueBubble()) return
  hideBubble()
})
quickRefresh.addEventListener('click', () => refreshAgentData(true))
menu.addEventListener('pointerdown', (e) => e.stopPropagation())
function closeTransientOnOutside(x, y) {
  if (quickOpen && !isInside(quick, x, y) && !isInside(fox, x, y)) toggleQuick(false)
  if (menuOpen && !isInside(menu, x, y) && !isInside(petMenuBtn, x, y)) closeMenu()
}
// mousedown 在某些「浮层刚打开/鼠标从穿透态切回」的时序里会丢；
// 再挂一层 pointerdown，保证点菜单外一定收起。
document.addEventListener('mousedown', (e) => closeTransientOnOutside(e.clientX, e.clientY))
window.addEventListener('pointerdown', (e) => closeTransientOnOutside(e.clientX, e.clientY), true)
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
  try {
    if (window.foxOverlay && typeof window.foxOverlay.onHidden === 'function') {
      window.foxOverlay.onHidden(() => {
        toggleQuick(false)
        closeMenu()
        hideBubble()
        hideSay()
      })
    }
  } catch (err) {}
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
  setInterval(renderPeriod, 1000)
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
      es.addEventListener('sessions', () => {
        if (quickOpen) loadQuickSessions()
        renderChip()
      })
      es.addEventListener('session', () => {
        if (quickOpen) loadQuickSessions()
      })
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
  roleForModel: (model, provider) => foxRoleForModel(model, provider),
  get autoRole() { return { ...autoRoleState, agentId: autoRoleFor } },
  get quickTop() { return quickTop },
  autoRoleTick(model, provider, capturedAt) {
    const agentId = bound.agentId || state.pet.profileOf || state.pet.lastAgentId || ''
    tickAutoRole({ model, provider, capturedAt: Number(capturedAt) || 0 }, agentId)
    syncRole()
    renderChip()
    if (quickOpen) renderQuick()
    return { ...autoRoleState, agentId: autoRoleFor }
  },
  checkBudget: () => checkBudgetAlerts(),
  clearBudget() {
    budgetMemorySeen = new Set()
    const store = budgetStorage()
    if (!store) return
    try {
      const stale = []
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)
        if (key && key.indexOf(BUDGET_KEY_PREFIX) === 0) stale.push(key)
      }
      for (const key of stale) store.removeItem(key)
    } catch (err) {}
  },
  isAgentWindow: (w) => isAgentWindow(w),
  isIgnoredWindow: (w) => isIgnoredWindow(w),
  hitAt: async (x, y, force) => {
    const r = await hitAt(x, y, force)
    return r && r.win ? r.win : null
  },
  get currentRole() { return roleId },
  syncRole: () => syncRole(),
  alphaMaskLoaded: () => !!alphaMask,
  get followEvery() { return followEvery },
  debugAttach(agentId, hwnd, rect, c) {
    bound = { agentId, hwnd, title: 'debug', exe: 'debug.exe', pid: 1, startMs: 1, rect }
    state.pet = { mode: 'attached', agentId, hwnd, profileOf: agentId, lastAgentId: agentId }
    // 测试里 debugAttach 只改渲染层，不改 daemon；保持 floatingRectApplied
    // 为 true，避免后台 /v1/state 轮询把测试位置拉回上一次 floating.rect。
    floatingRectApplied = true
    anchor = normalizeAnchor(c) || { h: 'right', v: 'bottom', hOff: 0, vOff: 0 }
    resetAutoRole(agentId)
    hostBackgroundSince = 0
    roleId = roleForAgent(agentId)
    applyRole(roleId)
    placeAnchored(rect)
    renderChip()
    return { pos, anchor }
  },
  debugFloat(agentId, x, y) {
    state.pet = { mode: 'floating', agentId: '', profileOf: agentId, lastAgentId: agentId }
    fallbackFacing = null
    bound = { agentId: '', hwnd: '', title: '', exe: '', pid: 0, startMs: 0, rect: null }
    floatingRectApplied = true
    lastServerMode = 'floating'
    resetAutoRole(agentId)
    roleId = roleForAgent(agentId)
    applyRole(roleId)
    place(x, y)
    renderChip()
  },
  async debugHostLost() {
    const hadHost = !!bound.hwnd
    bound = { ...bound, agentId: '', hwnd: '' }
    state.pet = { ...state.pet, mode: 'floating', agentId: '', rect: null }
    const target = await placeFloatingDefault()
    floatingRectApplied = true
    renderChip()
    return { hadHost, pos, target, size: foxSize(), viewport: { w: window.innerWidth, h: window.innerHeight } }
  },
  // 模拟一条 /rect 结果走 refreshRect 的同一处理路径（失前台兜底测试用）。
  // bgMs：把「已处于 background 的时长」直接拨到该毫秒数，跳过真实 0.5 秒等待。
  debugRectResult(r, bgMs) {
    if (r && r.ok && r.background && Number.isFinite(Number(bgMs))) hostBackgroundSince = Date.now() - Number(bgMs)
    applyRectResult(r)
    return {
      pos: { ...pos },
      size: foxSize(),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      since: hostBackgroundSince,
    }
  },
  get hostBackgroundMs() { return HOST_BACKGROUND_FALLBACK_MS },
  debugApplyRole(id) {
    applyRole(roleCatalog[id] ? id : 'fox')
    return roleId
  },
  get origin() { return origin ? { ...origin } : null },
  openQuick() { toggleQuick(true) },
  closeQuick() { toggleQuick(false) },
  openMenu,
  showBubble,
  hideBubble,
  reloadQueue: loadQueue,
  say: speak,
  showSay: (text) => showSay(text),
  setSettings(patch) { settings = { ...settings, ...patch }; applySettings() },
  setSnapshot(s) { snapshot = s; renderChip(); if (quickOpen) renderQuick() },
  setContext(c) { context = c; renderChip(); if (quickOpen) renderQuick() },
  setLive(live) { state.live = live; renderChip(); if (quickOpen) renderQuick() },
}

boot()
