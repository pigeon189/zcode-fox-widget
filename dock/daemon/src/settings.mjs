// 设置（schema 2）：全局默认 + 每个 agent 一份档案 + 宠物状态。
//
// 原则：
//   · 只收「dock 真能用上」的字段，每个字段都有取值范围，超界夹回而不是报错；
//   · 未知字段直接丢弃——设置文件可能被手改，不能让它变成任意数据通道；
//   · 读失败一律回默认值，设置坏了不该让整个挂件起不来；
//   · v1 → v2 迁移先备份 settings.json.v1.bak，未知字段仍按老规则丢弃。
//
// 档案（profile）= 角色、强调色、主数字口径、气泡设置、悬浮时数据源。
// 缺省字段继承全局设置，所以老用户升级后观感不变。

import fs from 'node:fs'
import path from 'node:path'

export const SCHEMA = 3

export const ROLES = ['fox', 'whale', 'gpt', 'kimi', 'xiaoke', 'gemini']
// 角色 id 也允许用户导入的 id（roles.mjs 同款安全字符集）；未知/不存在的 id
// 由 UI 回落到默认角色，但设置层必须先把选择保存下来，否则导入角色永远选不中。
const IMPORTED_ROLE_ID = /^[a-z0-9-]{2,24}$/
export function isRoleId(value) {
  const id = String(value || '')
  return ROLES.includes(id) || IMPORTED_ROLE_ID.test(id)
}
export const THEMES = ['light', 'dark', 'auto']
export const DISPLAY_MODES = ['auto', 'today', 'balance', 'quota']
export const ADAPTER_IDS = ['generic', 'zcode', 'workbuddy', 'kimi', 'dsh']
export const PET_MODES = ['idle', 'attached', 'floating']
export const SCALES = [0.75, 1, 1.25, 1.5]
export const CHATTER_MS = [0, 180000, 300000, 600000]
export const FLOATING_DATA = ['last', 'all']
// 失焦/最小化兜底角落（迁移 1.x defaultCorner）：右下/左下/右上/左上
export const FALLBACK_CORNERS = ['br', 'bl', 'tr', 'tl']
export const MENU_BUTTON = ['hover', 'always', 'hidden']
export const SHOW_STYLES = ['chip', 'bubble-card']
export const UPDATE_CHANNELS = ['stable', 'prerelease']
export const PERMISSION_NOTIFY = ['always', 'whenHidden', 'off']
export const PERMISSION_WAIT_MS = [8000, 15000, 30000]
export const RETENTION_DAYS = [7, 30, 90]

export const DEFAULT_PROFILE = {
  roleId: '',
  accent: '',
  displayMode: 'auto',
  turnBubble: true,
  turnBubbleMs: 5000,
  chatterMs: 300000,
  alertBubble: true,
  dnd: false,
  dataSource: 'last',
}

export const DEFAULTS = {
  schema: SCHEMA,
  // 角色（立绘 + 台词）。未知 id 一律回落 fox，见 normalizeSettings
  roleId: 'fox',
  // 随机台词间隔（ms）。0 = 不说话
  chatterMs: 300000,
  // 角色大小（倍率）。只允许这几档：连续值会让吸附/气泡定位在不同缩放下出偏差
  scale: 1,
  showChip: true,
  showStyle: 'chip',
  menuButton: 'hover',
  // 绑定窗口的跟随间隔（ms）
  followMs: 500,
  // 贴右/下边时给滚动条留的宽度（0 = 紧贴）。scrollGapOn 是总开关：
  // 旧挂件默认不避让；只有显式打开才留这条缝。
  scrollGap: 17,
  scrollGapOn: false,
  // 每轮消耗气泡
  turnBubble: true,
  turnBubbleMs: 5000,
  // 今日预算（元）。0 = 不设
  budgetMoney: 0,
  // 今日预算（积分）。0 = 不设；仅对 unit=credit / 币种 CREDIT 的宿主生效
  budgetCredit: 0,
  weeklyBudget: 0,
  monthlyBudget: 0,
  // 额度剩余低于该百分比时提醒（0 = 不提醒）
  quotaWarnPct: 0,
  balanceWarnMoney: 0,
  contextWarnPct: 80,
  costAnomalyX: 0,
  alertBubble: true,
  // 2.0：主题与主数字口径
  theme: 'auto', // light | dark | auto
  displayMode: 'auto', // auto | today | balance | quota
  // 绑定后按宿主默认角色换人（zcode→fox、wb→小克、kimi→kimi 娘、dsh→大肥鱼）
  autoRole: true,
  // 按当前模型族自动换角色（GLM→fox、DeepSeek→whale…，连续两拍确认）。
  // 默认开；用户在菜单/角色页手动选角后由前端关闭，尊重手动选择。
  autoRoleByModel: true,
  // 每个宿主单独指定的角色；空 = 用适配器默认
  rolesByAdapter: {},
  // 面板打开时显示 7 天用量块
  showWeek: true,
  // 桌宠模式：不吸附/不跟随，角色可自由摆在屏幕上
  petMode: false,
  // 宿主失前台/最小化/被覆盖时的兜底角落（也是无历史位置时的首帧落点）
  fallbackCorner: 'br',
  autoAttachNewAgent: false,
  reattachOnRestart: true,
  floatingData: 'last',
  hideMoney: false,
  dnd: false,
  // 音效不再单独开关：随「勿扰」静音（D031）；音量保留默认 0.5
  soundVolume: 0.5,
  confirmAlert: true,
  autoStart: true,
  language: 'zh-CN',
  // 更新清单地址（留空 = 未配置；发布 dock-v* 后填 signed manifest 地址）
  updateManifestUrl: '',
  // 启动时检查更新
  autoUpdate: false,
  updateChannel: 'prerelease',
  hotkeys: {
    toggle: 'Ctrl+Alt+F',
    console: 'Ctrl+Alt+D',
    hideMoney: 'Ctrl+Alt+H',
  },
  // 2.0-pre.2（schema 3）：会话实时层与权限接管
  live: {
    enabled: true,
  },
  permission: {
    // 接管权限请求：默认关（D036）。关闭时只通知 + 跳转宿主。
    takeover: false,
    // 超时后交回宿主原生弹窗。
    waitMs: 15000,
    notify: 'whenHidden',
    hotkeys: {
      allow: 'Ctrl+Alt+Y',
      deny: 'Ctrl+Alt+N',
    },
  },
  ingest: {
    enabled: true,
  },
  // 只影响 fox-dock 自己的 live-sessions 缓存，不删宿主数据。
  retentionDays: 30,
  // 跨 agent 的自定义 agent 上限由 ingest 层维护；这里只留开关。
  onboarded: false,
  // 每个 agent 一份档案；键是适配器 id
  profiles: {},
  // 宠物状态机（持久化，重启后按身份键恢复）
  pet: {
    mode: 'idle',
    agentId: '',
    lastAgentId: '',
    profileOf: '',
    hwnd: '',
    rect: null,
    display: null,
  },
}

function clampNum(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function bool(v, fallback) {
  if (v === true || v === false) return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

function nearest(value, steps) {
  return steps.reduce((best, s) => (Math.abs(s - value) < Math.abs(best - value) ? s : best), steps[0])
}

function pickEnum(value, allowed, fallback) {
  return allowed.includes(String(value || '')) ? String(value) : fallback
}

export function normalizeProfile(raw, fallback = DEFAULT_PROFILE) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const f = fallback && typeof fallback === 'object' ? fallback : DEFAULT_PROFILE
  const roleRaw = String(r.roleId || f.roleId || '')
  const roleId = isRoleId(roleRaw) ? roleRaw : ''
  const accent = /^#[0-9a-fA-F]{6}$/.test(String(r.accent || '')) ? String(r.accent).toLowerCase() : ''
  return {
    roleId,
    accent,
    displayMode: pickEnum(r.displayMode, DISPLAY_MODES, pickEnum(f.displayMode, DISPLAY_MODES, 'auto')),
    turnBubble: bool(r.turnBubble, typeof f.turnBubble === 'boolean' ? f.turnBubble : true),
    turnBubbleMs: Math.round(clampNum(r.turnBubbleMs, 2000, 15000, typeof f.turnBubbleMs === 'number' ? f.turnBubbleMs : 5000)),
    chatterMs: nearest(
      clampNum(r.chatterMs, 0, 600000, typeof f.chatterMs === 'number' ? f.chatterMs : 300000),
      CHATTER_MS
    ),
    alertBubble: bool(r.alertBubble, typeof f.alertBubble === 'boolean' ? f.alertBubble : true),
    dnd: bool(r.dnd, typeof f.dnd === 'boolean' ? f.dnd : false),
    dataSource: pickEnum(r.dataSource, FLOATING_DATA, pickEnum(f.dataSource, FLOATING_DATA, 'last')),
  }
}

// 档案合并：全局默认 → 该 agent 的覆盖值
export function getProfile(settings, agentId) {
  const s = settings && typeof settings === 'object' ? settings : DEFAULTS
  const base = normalizeProfile(
    {
      roleId: s.roleId,
      displayMode: s.displayMode,
      turnBubble: s.turnBubble,
      turnBubbleMs: s.turnBubbleMs,
      chatterMs: s.chatterMs,
      alertBubble: s.alertBubble,
      dnd: s.dnd,
      dataSource: s.floatingData,
    },
    DEFAULT_PROFILE
  )
  const id = String(agentId || '')
  const override = id && s.profiles && typeof s.profiles === 'object' ? s.profiles[id] : null
  return normalizeProfile(override ? { ...base, ...override } : base, base)
}

// 档案只存「与全局不同的字段」。如果把缺省字段也补成默认值，
// 用户以后改全局设置时，档案会把旧默认值钉死（继承关系断裂）。
export function normalizeProfilePatch(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  if ('roleId' in r) {
    const role = String(r.roleId || '')
    if (isRoleId(role) || role === '') out.roleId = role
  }
  if ('accent' in r) out.accent = /^#[0-9a-fA-F]{6}$/.test(String(r.accent || '')) ? String(r.accent).toLowerCase() : ''
  if ('displayMode' in r && DISPLAY_MODES.includes(String(r.displayMode || ''))) out.displayMode = String(r.displayMode)
  if ('turnBubble' in r) out.turnBubble = bool(r.turnBubble, DEFAULT_PROFILE.turnBubble)
  if ('turnBubbleMs' in r) out.turnBubbleMs = Math.round(clampNum(r.turnBubbleMs, 2000, 15000, DEFAULT_PROFILE.turnBubbleMs))
  if ('chatterMs' in r) out.chatterMs = nearest(clampNum(r.chatterMs, 0, 600000, DEFAULT_PROFILE.chatterMs), CHATTER_MS)
  if ('alertBubble' in r) out.alertBubble = bool(r.alertBubble, DEFAULT_PROFILE.alertBubble)
  if ('dnd' in r) out.dnd = bool(r.dnd, DEFAULT_PROFILE.dnd)
  if ('dataSource' in r && FLOATING_DATA.includes(String(r.dataSource || ''))) out.dataSource = String(r.dataSource)
  return out
}

export function normalizeProfiles(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [id, profile] of Object.entries(raw)) {
    if (!ADAPTER_IDS.includes(id)) continue
    out[id] = normalizeProfilePatch(profile)
  }
  return out
}

function normalizeRect(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  const w = Number(raw.width || raw.w)
  const h = Number(raw.height || raw.h)
  if (![x, y, w, h].every(Number.isFinite)) return null
  return { x: Math.round(x), y: Math.round(y), width: Math.max(0, Math.round(w)), height: Math.max(0, Math.round(h)) }
}

export function normalizePet(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const mode = pickEnum(r.mode, PET_MODES, 'idle')
  const agentId = ADAPTER_IDS.includes(String(r.agentId || '')) ? String(r.agentId) : ''
  const lastAgentId = ADAPTER_IDS.includes(String(r.lastAgentId || '')) ? String(r.lastAgentId) : agentId
  let profileOf = ADAPTER_IDS.includes(String(r.profileOf || '')) ? String(r.profileOf) : ''
  if (mode === 'floating' && !profileOf) profileOf = lastAgentId || 'generic'
  if (mode === 'idle') profileOf = ''
  return {
    mode,
    agentId: mode === 'attached' ? agentId : '',
    lastAgentId,
    profileOf,
    hwnd: String(r.hwnd || '').slice(0, 40),
    rect: normalizeRect(r.rect),
    display: r.display == null ? null : String(r.display).slice(0, 40),
  }
}

export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const scaleRaw = clampNum(r.scale, 0.6, 2, DEFAULTS.scale)
  // 取最接近的档位，避免手改出 1.13 这种值后在界面上「选不中」
  const scale = nearest(scaleRaw, SCALES)
  const followRaw = clampNum(r.followMs, 200, 5000, DEFAULTS.followMs)
  const followMs = nearest(followRaw, [250, 500, 1000])
  const roleRaw = String(r.roleId || '')
  const roleId = isRoleId(roleRaw) ? roleRaw : DEFAULTS.roleId
  const chatterRaw = clampNum(r.chatterMs, 0, 600000, DEFAULTS.chatterMs)
  const chatterMs = nearest(chatterRaw, CHATTER_MS)
  const theme = pickEnum(r.theme, THEMES, DEFAULTS.theme)
  const displayMode = pickEnum(r.displayMode, DISPLAY_MODES, DEFAULTS.displayMode)
  const hot = r.hotkeys && typeof r.hotkeys === 'object' ? r.hotkeys : {}
  // 升级迁移：旧设置文件没有 autoRoleByModel 字段，但 profiles 里已有手动
  // 选角。默认 true 会在升级后用模型族角色覆盖这些手动选择；把这类历史
  // 配置视为 opt-out（false）。新装（无手动 profile）仍保持默认 true。
  const rawProfiles = r.profiles && typeof r.profiles === 'object' ? r.profiles : {}
  const hasManualProfileRole = Object.values(rawProfiles).some(
    (p) => p && typeof p === 'object' && typeof p.roleId === 'string' && p.roleId
  )
  const autoRoleByModel =
    r.autoRoleByModel === undefined && hasManualProfileRole
      ? false
      : bool(r.autoRoleByModel, DEFAULTS.autoRoleByModel)
  return {
    schema: SCHEMA,
    roleId,
    chatterMs,
    scale,
    showChip: bool(r.showChip, DEFAULTS.showChip),
    showStyle: pickEnum(r.showStyle, SHOW_STYLES, DEFAULTS.showStyle),
    menuButton: pickEnum(r.menuButton, MENU_BUTTON, DEFAULTS.menuButton),
    followMs,
    scrollGap: Math.round(clampNum(r.scrollGap, 0, 60, DEFAULTS.scrollGap)),
    scrollGapOn: bool(r.scrollGapOn, DEFAULTS.scrollGapOn),
    turnBubble: bool(r.turnBubble, DEFAULTS.turnBubble),
    turnBubbleMs: Math.round(clampNum(r.turnBubbleMs, 2000, 15000, DEFAULTS.turnBubbleMs)),
    budgetMoney: Math.round(clampNum(r.budgetMoney, 0, 1000000, DEFAULTS.budgetMoney) * 100) / 100,
    budgetCredit: Math.round(clampNum(r.budgetCredit, 0, 1000000, DEFAULTS.budgetCredit) * 100) / 100,
    weeklyBudget: Math.round(clampNum(r.weeklyBudget, 0, 10000000, DEFAULTS.weeklyBudget) * 100) / 100,
    monthlyBudget: Math.round(clampNum(r.monthlyBudget, 0, 100000000, DEFAULTS.monthlyBudget) * 100) / 100,
    quotaWarnPct: Math.round(clampNum(r.quotaWarnPct, 0, 100, DEFAULTS.quotaWarnPct)),
    balanceWarnMoney: Math.round(clampNum(r.balanceWarnMoney, 0, 1000000, DEFAULTS.balanceWarnMoney) * 100) / 100,
    contextWarnPct: Math.round(clampNum(r.contextWarnPct, 0, 100, DEFAULTS.contextWarnPct)),
    costAnomalyX: Math.round(clampNum(r.costAnomalyX, 0, 20, DEFAULTS.costAnomalyX) * 10) / 10,
    alertBubble: bool(r.alertBubble, DEFAULTS.alertBubble),
    theme,
    displayMode,
    autoRole: bool(r.autoRole, DEFAULTS.autoRole),
    autoRoleByModel,
    rolesByAdapter: normalizeRolesByAdapter(r.rolesByAdapter),
    showWeek: bool(r.showWeek, DEFAULTS.showWeek),
    petMode: bool(r.petMode, DEFAULTS.petMode),
    fallbackCorner: pickEnum(r.fallbackCorner, FALLBACK_CORNERS, DEFAULTS.fallbackCorner),
    autoAttachNewAgent: bool(r.autoAttachNewAgent, DEFAULTS.autoAttachNewAgent),
    reattachOnRestart: bool(r.reattachOnRestart, DEFAULTS.reattachOnRestart),
    floatingData: pickEnum(r.floatingData, FLOATING_DATA, DEFAULTS.floatingData),
    hideMoney: bool(r.hideMoney, DEFAULTS.hideMoney),
    dnd: bool(r.dnd, DEFAULTS.dnd),
    soundVolume: Math.round(clampNum(r.soundVolume, 0, 1, DEFAULTS.soundVolume) * 100) / 100,
    confirmAlert: bool(r.confirmAlert, DEFAULTS.confirmAlert),
    autoStart: bool(r.autoStart, DEFAULTS.autoStart),
    language: String(r.language || DEFAULTS.language) === 'en' ? 'en' : 'zh-CN',
    updateManifestUrl: normalizeManifestUrl(r.updateManifestUrl),
    autoUpdate: bool(r.autoUpdate, DEFAULTS.autoUpdate),
    updateChannel: pickEnum(r.updateChannel, UPDATE_CHANNELS, DEFAULTS.updateChannel),
    hotkeys: {
      toggle: normalizeHotkey(hot.toggle, DEFAULTS.hotkeys.toggle),
      console: normalizeHotkey(hot.console, DEFAULTS.hotkeys.console),
      hideMoney: normalizeHotkey(hot.hideMoney, DEFAULTS.hotkeys.hideMoney),
    },
    live: { enabled: bool(r.live && r.live.enabled, DEFAULTS.live.enabled) },
    permission: normalizePermission(r.permission),
    ingest: { enabled: bool(r.ingest && r.ingest.enabled, DEFAULTS.ingest.enabled) },
    retentionDays: pickNumber(r.retentionDays, RETENTION_DAYS, DEFAULTS.retentionDays),
    onboarded: bool(r.onboarded, DEFAULTS.onboarded),
    profiles: normalizeProfiles(r.profiles),
    pet: normalizePet(r.pet),
  }
}

function pickNumber(value, allowed, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return allowed.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), fallback)
}

function normalizePermission(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const hot = r.hotkeys && typeof r.hotkeys === 'object' ? r.hotkeys : {}
  return {
    takeover: bool(r.takeover, DEFAULTS.permission.takeover) === true,
    waitMs: pickNumber(r.waitMs, PERMISSION_WAIT_MS, DEFAULTS.permission.waitMs),
    notify: pickEnum(r.notify, PERMISSION_NOTIFY, DEFAULTS.permission.notify),
    hotkeys: {
      allow: normalizeHotkey(hot.allow, DEFAULTS.permission.hotkeys.allow),
      deny: normalizeHotkey(hot.deny, DEFAULTS.permission.hotkeys.deny),
    },
  }
}

function normalizeHotkey(v, fallback) {
  // 缺省（字段不存在）用默认键；显式空串表示用户关闭了这个热键。
  if (v == null) return fallback
  const s = String(v).trim().replace(/\bWin\b/gi, 'Super')
  if (!s) return ''
  // 只收 Electron accelerator 的安全子集，避免写进全局热键时抛错。
  // 允许 Ctrl/Alt/Shift/Super + 字母数字或 F1–F24（D039 权限热键需要）。
  if (!/^(Ctrl|Alt|Shift|Super)(\+(Ctrl|Alt|Shift|Super))*\+([A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(s)) return fallback
  return s.slice(0, 60)
}

function normalizeManifestUrl(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    return s.slice(0, 300)
  } catch (err) {
    return ''
  }
}

// 每个宿主一个角色；只接受已知 adapter + 已知 role，防止设置文件变成任意数据通道。
export function normalizeRolesByAdapter(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [adapter, role] of Object.entries(raw)) {
    if (!ADAPTER_IDS.includes(adapter)) continue
    if (!isRoleId(role)) continue
    out[adapter] = String(role)
  }
  return out
}

function readRaw(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  } catch (err) {
    return null
  }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

// v1/v2 → v3：只做一次，备份坏不了原文件。老 schema 文件必须无损升级：
// 已有字段原样保留，新字段补默认值。
export function migrateSettingsFile(file) {
  const raw = readRaw(file)
  if (!raw || raw.schema === SCHEMA) return false
  const from = raw.schema == null ? 1 : Number(raw.schema) === 1 ? 1 : 2
  try {
    const backup = file + '.v' + from + '.bak'
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
  } catch (err) {}
  writeAtomic(file, normalizeSettings(raw))
  return true
}

export function readSettings(file) {
  migrateSettingsFile(file)
  const raw = readRaw(file)
  if (!raw) return normalizeSettings({})
  return normalizeSettings(raw)
}

function mergeProfiles(current, patch) {
  const out = { ...(current || {}) }
  for (const [id, value] of Object.entries(patch || {})) {
    if (value === null) {
      delete out[id]
      continue
    }
    if (!ADAPTER_IDS.includes(id)) continue
    if (value && typeof value === 'object') out[id] = normalizeProfilePatch({ ...(out[id] || {}), ...value })
  }
  return out
}

// 合并写：标量浅合并；profiles 按 agent 深合并；pet 整体覆盖（调用方传完整状态）。
export function writeSettings(file, patch) {
  const cur = readSettings(file)
  const p = patch && typeof patch === 'object' ? patch : {}
  const nextRaw = { ...cur, ...p }
  if (p.profiles && typeof p.profiles === 'object') nextRaw.profiles = mergeProfiles(cur.profiles, p.profiles)
  if (p.hotkeys && typeof p.hotkeys === 'object') nextRaw.hotkeys = { ...cur.hotkeys, ...p.hotkeys }
  if (p.pet && typeof p.pet === 'object') nextRaw.pet = { ...cur.pet, ...p.pet }
  if (p.live && typeof p.live === 'object') nextRaw.live = { ...cur.live, ...p.live }
  if (p.ingest && typeof p.ingest === 'object') nextRaw.ingest = { ...cur.ingest, ...p.ingest }
  if (p.permission && typeof p.permission === 'object') {
    nextRaw.permission = {
      ...cur.permission,
      ...p.permission,
      hotkeys: { ...(cur.permission && cur.permission.hotkeys), ...(p.permission.hotkeys || {}) },
    }
  }
  const next = normalizeSettings(nextRaw)
  writeAtomic(file, next)
  return next
}

// 重置：先备份再写默认值。返回 { settings, backup }。
export function resetSettings(file) {
  let backup = ''
  try {
    if (fs.existsSync(file)) {
      backup = file + '.bak-' + Date.now()
      fs.copyFileSync(file, backup)
    }
  } catch (err) {
    backup = ''
  }
  const settings = normalizeSettings({})
  writeAtomic(file, settings)
  return { settings, backup }
}

export function writeProfile(file, agentId, patch) {
  const id = String(agentId || '')
  if (!ADAPTER_IDS.includes(id)) throw new Error('unknown agent: ' + id)
  return writeSettings(file, { profiles: { [id]: patch || {} } })
}

export function writePet(file, pet) {
  return writeSettings(file, { pet })
}
