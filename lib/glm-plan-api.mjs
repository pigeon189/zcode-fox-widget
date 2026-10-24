// GLM Plan（订阅套餐）剩余配额：直连 bigmodel 套餐用量接口。
//
// 【与「BigModel 按量余额」不是一回事】本模块读的是**订阅套餐**的窗口用量
//（5 小时窗口 / 本周窗口），接口是
//   https://open.bigmodel.cn/api/monitor/usage/quota/limit
//（bigmodel.cn 主站同路径也可用，见 GLM_PLAN_QUOTA_HOSTS）。按量计费账户的**余额**
// 没有公开查询接口（见 vendors.mjs 的 bigmodel-glm 模板），两者 url 不同、语义不同，
// 绝不互相冒充——订阅配额只喂「GLM Plan 剩余配额」这个显示位。
//
// 【为什么需要它】客户端从 start-plan 切到 individual-coding-plan 之后，客户端日志里的
// billing/balance 响应变成空桶（plans / balances 皆空，code=0、success=true），尾随日志
// 只能读到**过期套餐的残留快照**，显示永久 stale（issue #3）。该账号不属于 zcode-plan
// 计费体系，客户端也不再为它轮询余额——日志这条路对它永久失效。所以这里直连接口取
// 实时值，日志退居兜底（取源顺序见 plan-balance.mjs 的 readPlanBalance）。
//
// 接口形状（实测 2026-10-16，lite 档）：
//   { code:200, success:true, data:{ level:'lite', limits:[
//       { type:'CREDIT_LIMIT', unit:3, number:5, usage:2000, currentValue:0,    remaining:2000, percentage:0 },
//       { type:'CREDIT_LIMIT', unit:6, number:1, usage:2000, currentValue:1841, remaining:158,  percentage:92,
//         nextResetTime:1792656212983 } ] } }
//   · percentage 是**已用**百分比（0–100）；remaining/usage/currentValue 是同一窗口的
//     额度点数（不是 token 数——本插件不对它做 token 折算，只如实显示）
//   · unit/number 描述窗口长度。实测归纳：unit 3 + number 5 → 5 小时窗口（无
//     nextResetTime，几小时内自然回满）；unit 6 + number 1 → 本周窗口（nextResetTime
//     约 7 天后，据此确认）。认不出的组合按 `unit×number` 原样标注，不硬猜
//   · 老套餐账号（start-plan 那类）返回的是另一种嵌套形状
//     limits[].TOKENS_LIMIT.{percentage,remaining,total}（zhipu-quota 模板沿用的写法），
//     这里一并兼容，见 shapeQuotaPayload
import { assertSafeUpstream, maskKey, readPluginConfig } from './credentials.mjs'
import { findDiscoveredKey } from './discover.mjs'

const QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
const QUOTA_HOSTS = ['open.bigmodel.cn']

// 出站地址常量导出给自检钉白名单（与 vendors.mjs 的 host 常量同一用途）
export const GLM_PLAN_QUOTA_URL = QUOTA_URL
export const GLM_PLAN_QUOTA_HOSTS = QUOTA_HOSTS.slice()

const FETCH_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 60_000

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const round1 = (v) => Math.round(v * 10) / 10

// unit × number → 窗口名。映射是实测归纳（见文件头），认不出的组合原样标注。
export function windowLabel(unit, number) {
  const u = num(unit)
  const n = num(number)
  if (u === 3 && n) return n + ' 小时'
  if (u === 6 && n === 1) return '本周'
  if (u === 6 && n) return n + ' 周'
  if (!u || !n) return '套餐'
  return 'unit' + u + '×' + n
}

// 把接口响应塑形成「按窗口的配额」；两种形状都收，认不出返回 null。
// 返回 { ok:true, source:'glm-plan-api', level, windows[], primaryWindow, percentRemaining,
//        percentUsed, remaining, total, nextResetAt } —— percentRemaining/percentUsed 是
// 0–1 的比例（与 plan-balance 的日志口径一致），remaining/total 是主窗口的额度点数。
export function shapeQuotaPayload(data) {
  const d = data && data.data ? data.data : null
  const limits = d && Array.isArray(d.limits) ? d.limits : []
  const level = d && typeof d.level === 'string' && d.level.trim() ? d.level.trim() : null
  const windows = []

  for (const item of limits) {
    if (!item || typeof item !== 'object') continue
    // 形状 A（现役）：平铺
    const flatPct = num(item.percentage)
    if (flatPct !== null) {
      const used = num(item.currentValue)
      const cap = num(item.usage)
      const remaining = num(item.remaining)
      windows.push({
        label: windowLabel(item.unit, item.number),
        percentUsed: clampPct(flatPct),
        remaining,
        total: cap,
        used,
        resetAt: num(item.nextResetTime) || null,
      })
      continue
    }
    // 形状 B（老套餐账号 / zhipu-quota 模板沿用）：limits[].TOKENS_LIMIT.*
    const nested = item.TOKENS_LIMIT
    if (nested && typeof nested === 'object') {
      const pct = num(nested.percentage)
      if (pct === null) continue
      const remaining = num(nested.remaining)
      const total = num(nested.total) !== null ? num(nested.total) : num(nested.limit)
      windows.push({
        label: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '套餐',
        percentUsed: clampPct(pct),
        remaining,
        total,
        used: remaining !== null && total !== null ? Math.max(0, total - remaining) : null,
        resetAt: num(nested.nextResetTime) || num(item.nextResetTime) || null,
      })
    }
  }
  if (!windows.length) return null

  // 主窗口 = **剩余最低（已用最高）**的那条：两个窗口里真正卡住你的是它，
  // 主显示的百分比与「剩余低于阈值」预警都该盯它（与 CommandCode 三重额度
  // 「取最紧窗口」同一口径）。并列时取靠前的那条（接口给的顺序稳定）。
  let primary = windows[0]
  for (const w of windows) {
    if (w.percentUsed > primary.percentUsed) primary = w
  }
  // 剩余比例优先用「剩余 / 总量」（比接口的百分比字段多一位有效数字），
  // 缺任一数字时回落到 100 − percentage
  const pctFromNumbers =
    primary.remaining !== null && primary.total !== null && primary.total > 0 ? primary.remaining / primary.total : null
  const percentRemaining = pctFromNumbers !== null ? clamp01(pctFromNumbers) : clamp01(1 - primary.percentUsed / 100)
  return {
    ok: true,
    source: 'glm-plan-api',
    // 单位是**额度点数**（不是 token）：主显示的百分比成立，但每轮消耗的
    // 「占配额 %」不能拿它当分母（见 plan-balance.turnPlanUsage 的守卫）
    unit: 'credits',
    level,
    windows,
    primaryWindow: primary.label,
    percentRemaining,
    percentUsed: clamp01(primary.percentUsed / 100),
    remaining: primary.remaining,
    total: primary.total,
    nextResetAt: primary.resetAt || null,
    observedAt: Date.now(),
  }
}

function clampPct(v) {
  const n = num(v)
  if (n === null) return 0
  return Math.min(100, Math.max(0, n))
}
function clamp01(v) {
  const n = num(v)
  if (n === null) return null
  return Math.min(1, Math.max(0, n))
}

// 套餐接口的凭据：与凭据发现链同源（环境变量 → 插件配置 vendorKeys → 从宿主 provider
// 配置发现）。模板 id 用 bigmodel-glm —— discover.mjs 把 bigmodel / zhipu / glm 关键词
// 一律归到它，所以宿主机型商里配的那把 GLM key 走这条链就能拿到；zhipu-quota 也接受。
export function resolveGlmPlanKey() {
  const envNames = ['ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'GLM_API_KEY']
  for (const name of envNames) {
    const v = String(process.env[name] || '').trim()
    if (v) return { key: v, source: 'env:' + name }
  }
  const cfg = readPluginConfig()
  const vendorKeys = cfg && typeof cfg.vendorKeys === 'object' ? cfg.vendorKeys : null
  if (vendorKeys) {
    for (const id of ['bigmodel-glm', 'zhipu-quota']) {
      const v = typeof vendorKeys[id] === 'string' ? vendorKeys[id].trim() : ''
      if (v) return { key: v, source: 'plugin-config:' + id }
    }
  }
  for (const id of ['bigmodel-glm', 'zhipu-quota']) {
    const found = findDiscoveredKey(id)
    if (found && found.key) return { key: found.key, source: found.source }
  }
  return { key: '', source: 'none' }
}

let cache = { at: 0, payload: null }
let pending = null
// 「这个账号有 GLM 订阅套餐」的**同步**判据：最近一次成功取到套餐配额时记下 level
//（level 是 Coding Plan 专有字段；按量账号的监控端点不会返回它）。热路径——会话来源
// 判定 / 每轮计价 / 用量记录——不能等一次网络请求，所以在这里记一份事实给它们同步读：
// 订阅持有者的 GLM 用量走的是**订阅配额**，按量价目套出来的金额是虚构的（与「预付池
// 不计真金白银」同一条口径），那些路径据此把 GLM 行当 Plan 行处理。
// 取到配额但**没有 level**（端点改形状 / 已无套餐）时清空，避免规则粘住。
let subscriptionLevel = null

export function glmSubscriptionActive() {
  return !!subscriptionLevel
}

// 取套餐配额（60s 缓存 + 并发合并）。**任何失败都不抛**：返回
// { ok:false, reason }，由调用方回落到日志源——接口挂了不能把配额显示一起带走。
export async function fetchGlmPlanQuota({ force = false } = {}) {
  if (!force && cache.payload && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload
  if (!force && pending) return pending
  const task = (async () => {
    const { key, source } = resolveGlmPlanKey()
    if (!key) return { ok: false, reason: 'no-key', keySource: source }
    let url
    try {
      // 出站硬约束：仅 https、显式主机白名单、拒环回/私有/保留地址（与其余模板同口径）
      url = assertSafeUpstream(QUOTA_URL, QUOTA_HOSTS)
    } catch (err) {
      return { ok: false, reason: 'blocked-upstream', keySource: source }
    }
    try {
      const res = await fetch(url, {
        // 官方两种写法都收（实测 raw key 与 Bearer 都 200）；沿用 zhipu-quota 模板的 raw 形态
        headers: { Authorization: key, 'Content-Type': 'application/json' },
        // redirect:'error'（同 relays/vendors）：白名单只覆盖首跳，不跟随重定向
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) return { ok: false, reason: 'http-' + res.status, keySource: source }
      const data = await res.json()
      const shaped = shapeQuotaPayload(data)
      if (!shaped) {
        subscriptionLevel = null // 端点不再给出套餐窗口：清掉「有订阅」的事实
        return { ok: false, reason: 'shape-mismatch', keySource: source }
      }
      subscriptionLevel = shaped.level || null
      return { ...shaped, keySource: source, keyMasked: maskKey(key) }
    } catch (err) {
      // 网络/超时这类**瞬时**失败不改判据（订阅还在，只是这次没读到）
      return { ok: false, reason: String((err && err.message) || err).slice(0, 120), keySource: source }
    }
  })()
  if (!force) pending = task
  try {
    const payload = await task
    cache = { at: Date.now(), payload }
    return payload
  } finally {
    if (pending === task) pending = null
  }
}

// 让缓存立即失效（测试与强制刷新用）
export function invalidateGlmPlanCache() {
  cache = { at: 0, payload: null }
}
