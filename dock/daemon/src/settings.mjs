// 设置（从挂件线移植的那批开关）。
//
// 原则：
//   · 只收「dock 真能用上」的字段，每个字段都有取值范围，超界夹回而不是报错；
//   · 未知字段直接丢弃——设置文件可能被手改，不能让它变成任意数据通道；
//   · 读失败一律回默认值，设置坏了不该让整个挂件起不来。

import fs from 'node:fs'
import path from 'node:path'

export const DEFAULTS = {
  // 角色（立绘 + 台词）。未知 id 一律回落 fox，见 normalizeSettings
  roleId: 'fox',
  // 随机台词间隔（ms）。0 = 不说话
  chatterMs: 300000,
  // 角色大小（倍率）。只允许这几档：连续值会让吸附/气泡定位在不同缩放下出偏差
  scale: 1,
  showChip: true,
  // 绑定窗口的跟随间隔（ms）
  followMs: 500,
  // 贴右/下边时给滚动条留的宽度（0 = 紧贴）
  scrollGap: 17,
  // 每轮消耗气泡
  turnBubble: true,
  turnBubbleMs: 5000,
  // 今日预算（元）。0 = 不设
  budgetMoney: 0,
  // 额度剩余低于该百分比时提醒（0 = 不提醒）
  quotaWarnPct: 0,
  alertBubble: true,
  // 2.0：主题与主数字口径
  theme: 'auto', // light | dark | auto
  displayMode: 'auto', // auto | today | balance | quota
  // 绑定后按宿主默认角色换人（zcode→fox、wb→小克、kimi→kimi 娘、dsh→大肥鱼）
  autoRole: true,
  // 每个宿主单独指定的角色；空 = 用适配器默认
  rolesByAdapter: {},
  // 面板打开时显示 7 天用量块
  showWeek: true,
}

export const SCALES = [0.75, 1, 1.25, 1.5]
const FOLLOW_MS = [250, 500, 1000]
export const ROLES = ['fox', 'whale', 'gpt', 'kimi', 'xiaoke', 'gemini']
export const CHATTER_MS = [0, 180000, 300000, 600000]
export const THEMES = ['light', 'dark', 'auto']
export const DISPLAY_MODES = ['auto', 'today', 'balance', 'quota']
export const ADAPTER_IDS = ['generic', 'zcode', 'workbuddy', 'kimi', 'dsh']

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

// 归一：未知字段被丢弃，越界值夹回，非法值回默认
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const scaleRaw = clampNum(r.scale, 0.6, 2, DEFAULTS.scale)
  // 取最接近的档位，避免手改出 1.13 这种值后在界面上「选不中」
  const scale = SCALES.reduce((best, s) => (Math.abs(s - scaleRaw) < Math.abs(best - scaleRaw) ? s : best), SCALES[0])
  const followRaw = clampNum(r.followMs, 200, 5000, DEFAULTS.followMs)
  const followMs = FOLLOW_MS.reduce((best, s) => (Math.abs(s - followRaw) < Math.abs(best - followRaw) ? s : best), FOLLOW_MS[0])
  const roleRaw = String(r.roleId || '')
  const roleId = ROLES.includes(roleRaw) ? roleRaw : DEFAULTS.roleId
  const chatterRaw = clampNum(r.chatterMs, 0, 600000, DEFAULTS.chatterMs)
  const chatterMs = CHATTER_MS.reduce((best, s) => (Math.abs(s - chatterRaw) < Math.abs(best - chatterRaw) ? s : best), CHATTER_MS[0])
  const theme = THEMES.includes(String(r.theme || '')) ? String(r.theme) : DEFAULTS.theme
  const displayMode = DISPLAY_MODES.includes(String(r.displayMode || '')) ? String(r.displayMode) : DEFAULTS.displayMode
  return {
    roleId,
    chatterMs,
    scale,
    showChip: bool(r.showChip, DEFAULTS.showChip),
    followMs,
    scrollGap: Math.round(clampNum(r.scrollGap, 0, 60, DEFAULTS.scrollGap)),
    turnBubble: bool(r.turnBubble, DEFAULTS.turnBubble),
    turnBubbleMs: Math.round(clampNum(r.turnBubbleMs, 1000, 15000, DEFAULTS.turnBubbleMs)),
    budgetMoney: Math.round(clampNum(r.budgetMoney, 0, 1000000, DEFAULTS.budgetMoney) * 100) / 100,
    quotaWarnPct: Math.round(clampNum(r.quotaWarnPct, 0, 100, DEFAULTS.quotaWarnPct)),
    alertBubble: bool(r.alertBubble, DEFAULTS.alertBubble),
    theme,
    displayMode,
    autoRole: bool(r.autoRole, DEFAULTS.autoRole),
    rolesByAdapter: normalizeRolesByAdapter(r.rolesByAdapter),
    showWeek: bool(r.showWeek, DEFAULTS.showWeek),
  }
}

// 每个宿主一个角色；只接受已知 adapter + 已知 role，防止设置文件变成任意数据通道。
export function normalizeRolesByAdapter(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [adapter, role] of Object.entries(raw)) {
    if (!ADAPTER_IDS.includes(adapter)) continue
    if (!ROLES.includes(String(role || ''))) continue
    out[adapter] = String(role)
  }
  return out
}

export function readSettings(file) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (err) {
    return { ...DEFAULTS }
  }
}

// 合并写：只覆盖 patch 里出现过的字段（前端可能只发改动的那一项）
export function writeSettings(file, patch) {
  const cur = readSettings(file)
  const next = normalizeSettings({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}) })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
  return next
}
