// 中转站额度读取：把常见中转站按平台归成三类，统一成一张额度卡。
//
// 三类平台（社区实测与官方文档归纳；字段做宽容映射，站点升级不至于整卡失效）：
//   1. New API / One API：PackyCode、DuckCoding、云雾、H API、UU API、
//      APINebula、LinkAI、88Code。优先用 API Key 调 `/api/usage/token`
//      （token 级可用额度），其次 OpenAI 兼容账单接口
//      `/v1/dashboard/billing/{subscription,usage}`，最后才用「系统访问令牌 +
//      用户 ID」调 `/api/user/self`（账户级余额）。
//   2. Sub2API：SSSAICode 等。`/v1/usage` 直接给 5h / 1d / 7d 窗口，
//      或 unrestricted 模式给余额——正好对应「5 小时 + 日/周窗口」卡片。
//   3. Cubence：`/v1/user/subscription-info` 给余额与 5 小时窗口。
//
// 安全口径与厂商模板一致：出站 host 走**站点注册表里的显式白名单**，不从
// 用户填的 URL 现算；密钥只在本进程内存里用，不落盘、不打印。
//
// 价格口径：中转站没有单独的站点倍率表，实际调用按 model_id 走 pricing.mjs
// 的厂商价目；本文件只负责额度/余额读取。
import { assertSafeUpstream, readPluginConfig } from './credentials.mjs'
import { listZcodeProviders } from './discover.mjs'

const TTL_MS = 45_000
const TIMEOUT_MS = 8_000
const CENT = 1 / 500_000 // New API 默认 500000 quota = $1

// 站点注册表。hosts 用于匹配 provider 的 baseURL；keywords 用于匹配 provider
// 名（PackyCode 等站把调用地址换成 cf.api.fan 这类通用域名后，只能靠名字认）。
// apiHosts 是出站白名单；不写时等于 hosts。
export const RELAYS = [
  {
    id: 'packycode',
    name: 'PackyCode',
    platform: 'newapi',
    hosts: ['packyapi.com', 'packyapi.ai'],
    apiHosts: ['packyapi.com', 'packyapi.ai', 'cf.api.fan', 'slb-v1.api.fan'],
    keywords: ['packy'],
    model: 'balance',
    note: 'New API 站：API Key 查 token 额度，或配置系统访问令牌 + 用户 ID 查账户余额',
  },
  {
    id: 'duckcoding',
    name: 'DuckCoding',
    platform: 'newapi',
    hosts: ['duckcoding.com', 'duckcoding.ai'],
    keywords: ['duckcoding', 'duckcode', '小黄鸭', '鸭鸭'],
    model: 'balance',
    note: 'New API 站：余额扣费；部分部署只开放系统访问令牌查询',
  },
  {
    id: 'yunwu',
    name: '云雾 API',
    platform: 'newapi',
    hosts: ['yunwu.ai'],
    keywords: ['yunwu', '云雾'],
    model: 'balance',
    note: 'New API 站：余额扣费',
  },
  {
    id: 'hapi',
    name: 'H API',
    platform: 'newapi',
    hosts: ['hapiopen.cc'],
    keywords: ['hapiopen', 'h api'],
    model: 'balance',
    note: 'New API 站：余额扣费',
  },
  {
    id: 'uuapi',
    name: 'UU API',
    platform: 'newapi',
    hosts: ['uuapi.net', 'uuapi.io'],
    keywords: ['uuapi', 'uu api'],
    model: 'balance',
    note: 'New API 站：余额扣费',
  },
  {
    id: 'apinebula',
    name: 'APINebula',
    platform: 'newapi',
    hosts: ['apinebula.ai', 'apinebula.com'],
    keywords: ['apinebula'],
    model: 'balance',
    note: 'New API 站：余额扣费（调用域名可能是 img-api / api 子域）',
  },
  {
    id: 'linkai',
    name: 'LinkAI',
    platform: 'newapi',
    hosts: ['linkai.shop', 'linkai.pics'],
    keywords: ['linkai.shop', 'linkai.pics', 'linkai relay'],
    model: 'balance',
    note: 'New API 站：余额扣费（注意与同名 LinkAI Agent 平台区分）',
  },
  {
    id: '88code',
    name: '88Code',
    platform: 'newapi',
    hosts: ['88code.org', '88code.ai'],
    keywords: ['88code'],
    model: 'balance',
    note: 'New API 站：API Key 查 token 额度；账户级套餐窗口需要登录令牌，不在此列',
  },
  {
    id: 'sssaicode',
    name: 'SSSAICode',
    platform: 'sub2api',
    hosts: ['sssaicode.com', 'sssaiapi.com', 'sssaicodeapi.com'],
    keywords: ['sssaicode', 'sssai'],
    model: 'windows',
    note: 'Sub2API 站：/v1/usage 给 5 小时 / 本日 / 本周窗口',
  },
  {
    id: 'cubence',
    name: 'Cubence',
    platform: 'cubence',
    hosts: ['cubence.com'],
    keywords: ['cubence'],
    model: 'windows',
    note: 'Cubence：/v1/user/subscription-info 给余额与 5 小时窗口',
  },
]

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return null
}
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
const isRecord = (v) => typeof v === 'object' && v !== null

function getPath(obj, pathName) {
  let cur = obj
  for (const part of String(pathName || '').split('.')) {
    if (!isRecord(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

function firstNum(obj, keys) {
  if (!isRecord(obj)) return null
  for (const k of keys) {
    const v = num(getPath(obj, k))
    if (v !== null) return v
  }
  return null
}

function firstStr(obj, keys) {
  if (!isRecord(obj)) return null
  for (const k of keys) {
    const v = str(getPath(obj, k))
    if (v) return v
  }
  return null
}

function toMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw > 1e12 ? raw : raw * 1000
  if (typeof raw === 'string' && raw) {
    const t = Date.parse(raw)
    if (Number.isFinite(t)) return t
  }
  return null
}

function clampPct(v) {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10))
}

function asData(body) {
  if (!isRecord(body)) return null
  return isRecord(body.data) ? body.data : body
}

function balanceOf(remaining, used, total, currency) {
  const r = num(remaining)
  const u = num(used)
  const t = num(total)
  if (r === null && u === null && t === null) return null
  return {
    remaining: r,
    used: u,
    total: t !== null ? t : r !== null && u !== null ? r + u : null,
    currency: currency || 'USD',
  }
}

// ---------- 站点识别 ----------

export function findRelay(host, providerName) {
  const h = String(host || '').toLowerCase()
  const hay = String(providerName || '').toLowerCase()
  for (const r of RELAYS) {
    if (h && (r.hosts || []).some((suffix) => h === suffix || h.endsWith('.' + suffix))) return r
  }
  for (const r of RELAYS) {
    if (hay && (r.keywords || []).some((kw) => hay.indexOf(kw) !== -1)) return r
  }
  return null
}

// 从宿主 provider 里找该站的条目（key 现读；本地网关/密文跳过）
export function findRelayProvider(relay) {
  for (const e of listZcodeProviders()) {
    if (!e || !e.apiKey || e.keyEncrypted || e.isLocal) continue
    const hit = findRelay(e.host, e.providerName)
    if (hit && hit.id === relay.id) return e
  }
  return null
}

// ---------- HTTP ----------

async function getJson(url, auth, allowedHosts, extraHeaders) {
  let u
  try {
    u = assertSafeUpstream(url, allowedHosts)
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  try {
    const res = await fetch(u, {
      headers: { accept: 'application/json', ...(auth ? { authorization: auth } : {}), ...(extraHeaders || {}) },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, status: res.status, error: 'HTTP ' + res.status + (text ? ': ' + text.slice(0, 120) : '') }
    }
    try {
      return { ok: true, data: JSON.parse(text) }
    } catch (err) {
      return { ok: false, error: '响应不是合法 JSON' }
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

// ---------- 归一化：New API ----------

// /api/usage/token：token 级额度。total_* 是 New API 的 quota 单位
//（默认 500000 = $1）；有的站直接给美元，用「数值是否 > 10000」做启发式。
export function shapeNewApiTokenUsage(relay, body) {
  const d = asData(body)
  if (!isRecord(d)) return null
  const granted = firstNum(d, ['total_granted', 'total_grant', 'granted'])
  const used = firstNum(d, ['total_used', 'used'])
  let available = firstNum(d, ['total_available', 'available', 'remaining'])
  if (available === null && granted !== null && used !== null) available = granted - used
  if (d.unlimited_quota === true || d.unlimited === true) {
    return {
      ok: true,
      id: relay.id,
      name: relay.name,
      kind: 'balance',
      currency: 'USD',
      balance: { remaining: null, used: used === null ? null : used * CENT, total: null, currency: 'USD', unlimited: true },
      source: 'newapi-usage-token',
    }
  }
  if (available === null) return null
  const scale = (granted !== null && granted > 10000) || available > 10000 ? CENT : 1
  return shapeBalanceOrMonthly(relay, {
    remaining: available * scale,
    used: used === null ? null : used * scale,
    total: granted === null ? null : granted * scale,
    source: 'newapi-usage-token',
  })
}

// /v1/dashboard/billing/subscription + /usage：hard_limit_usd 是总额，
// total_usage 的单位是美分；剩余 = 总额 − 已用。
export function shapeNewApiBilling(relay, subBody, usageBody) {
  const sub = asData(subBody)
  if (!isRecord(sub)) return null
  const hard = firstNum(sub, ['hard_limit_usd', 'system_hard_limit_usd', 'soft_limit_usd'])
  if (hard === null) return null
  if (hard >= 100000000) {
    return {
      ok: true,
      id: relay.id,
      name: relay.name,
      kind: 'balance',
      currency: 'USD',
      balance: { remaining: null, used: null, total: null, currency: 'USD', unlimited: true },
      source: 'newapi-billing',
    }
  }
  const u = asData(usageBody)
  const cents = u ? firstNum(u, ['total_usage', 'totalUsage']) : null
  if (cents === null) return null
  const used = cents / 100
  return shapeBalanceOrMonthly(relay, {
    remaining: Math.max(0, hard - used),
    used,
    total: hard,
    source: 'newapi-billing',
  })
}

// /api/user/self：账户级余额（系统访问令牌 + New-Api-User 用户 ID）。
export function shapeNewApiUserSelf(relay, body) {
  const d = asData(body)
  if (!isRecord(d)) return null
  const quota = firstNum(d, ['quota', 'remaining_quota', 'balance'])
  if (quota === null) return null
  const used = firstNum(d, ['used_quota', 'used'])
  const scale = quota > 10000 || (used !== null && used > 10000) ? CENT : 1
  return shapeBalanceOrMonthly(relay, {
    remaining: quota * scale,
    used: used === null ? null : used * scale,
    total: used === null ? null : (quota + used) * scale,
    source: 'newapi-user-self',
  })
}

function shapeBalanceOrMonthly(relay, raw) {
  const balance = balanceOf(raw.remaining, raw.used, raw.total, 'USD')
  if (!balance) return null
  if (relay.model === 'monthly' && balance.total && balance.total > 0) {
    const used = balance.used === null ? Math.max(0, balance.total - (balance.remaining || 0)) : balance.used
    return {
      ok: true,
      id: relay.id,
      name: relay.name,
      kind: 'quota',
      currency: 'USD',
      balance,
      windows: [
        {
          label: '本月',
          percentUsed: clampPct((used / balance.total) * 100),
          used,
          total: balance.total,
          remaining: balance.remaining,
          resetAt: null,
        },
      ],
      source: raw.source,
    }
  }
  return { ok: true, id: relay.id, name: relay.name, kind: 'balance', currency: 'USD', balance, source: raw.source }
}

// ---------- 归一化：Sub2API ----------

function windowLabel(raw) {
  const s = String(raw || '').toLowerCase().replace(/\s+/g, '')
  if (s === '5h' || s === '5hour' || s === '5小时') return '5小时'
  if (s === '1d' || s === '24h' || s === 'day' || s === 'daily' || s === '本日' || s === '今日') return '本日'
  if (s === '7d' || s === 'week' || s === 'weekly' || s === '168h' || s === '本周') return '本周'
  if (s === '30d' || s === 'month' || s === 'monthly' || s === '本月') return '本月'
  return raw ? String(raw) : '额度'
}

function shapeWindow(raw) {
  if (!isRecord(raw)) return null
  let used = firstNum(raw, ['used', 'usage', 'used_usd', 'usedUsd', 'consumed'])
  const total = firstNum(raw, ['total', 'limit', 'quota', 'cap'])
  let remaining = firstNum(raw, ['remaining', 'left', 'remain'])
  if (remaining === null && used !== null && total !== null) remaining = Math.max(0, total - used)
  if (used === null && remaining !== null && total !== null) used = Math.max(0, total - remaining)
  if (used === null || !total) return null
  const resetAt = firstNum(raw, ['reset_at_ms']) || null
  const resetRaw = resetAt === null ? (raw.reset_at ?? raw.resetAt ?? raw.reset_time ?? raw.resetTime) : resetAt
  return {
    label: windowLabel(raw.window || raw.period || raw.name || raw.window_name),
    percentUsed: clampPct((used / total) * 100),
    used,
    total,
    remaining,
    resetAt: toMs(resetRaw),
  }
}

export function shapeSub2Usage(relay, body) {
  const d = asData(body)
  if (!isRecord(d)) return null
  const rawLimits = Array.isArray(d.rate_limits) ? d.rate_limits : Array.isArray(d.rateLimits) ? d.rateLimits : []
  const windows = rawLimits.map(shapeWindow).filter(Boolean)
  const currency = str(d.currency) || str(d.unit) || 'USD'
  const remaining = firstNum(d, ['remaining', 'balance', 'quota.remaining', 'wallet.balance'])
  const used = firstNum(d, ['used', 'used_balance', 'quota.used'])
  const total = firstNum(d, ['total', 'quota.total', 'limit'])
  const balance = balanceOf(remaining, used, total, currency)
  if (windows.length) {
    return {
      ok: true,
      id: relay.id,
      name: relay.name,
      kind: 'quota',
      currency,
      windows,
      balance,
      source: 'sub2api',
    }
  }
  if (balance) {
    return { ok: true, id: relay.id, name: relay.name, kind: 'balance', currency, balance, source: 'sub2api' }
  }
  return null
}

// ---------- 归一化：Cubence ----------

function findBalanceObject(d) {
  if (!isRecord(d)) return null
  const direct = firstNum(d, ['balance', 'remaining', 'credit', 'credits', 'available', 'wallet.balance'])
  const used = firstNum(d, ['used', 'used_balance', 'usage', 'wallet.used'])
  const total = firstNum(d, ['total', 'quota', 'limit', 'wallet.total'])
  const currency = str(d.currency) || 'USD'
  return balanceOf(direct, used, total, currency)
}

function findCubenceFiveHour(d) {
  if (!isRecord(d)) return null
  const candidates = [
    d.fiveHour,
    d.five_hour,
    d.five_hours,
    d.window5h,
    d.usage5h,
    d['5h'],
    getPath(d, 'subscription.fiveHour'),
    getPath(d, 'subscription.five_hour'),
    getPath(d, 'usage.fiveHour'),
    getPath(d, 'usage.five_hour'),
  ]
  for (const c of candidates) {
    const w = shapeWindow(c)
    if (w) {
      w.label = '5小时'
      return w
    }
  }
  return null
}

export function shapeCubence(relay, body) {
  const d = asData(body)
  if (!isRecord(d)) return null
  const balance = findBalanceObject(d) || findBalanceObject(getPath(d, 'subscription')) || findBalanceObject(getPath(d, 'wallet'))
  const five = findCubenceFiveHour(d) || findCubenceFiveHour(getPath(d, 'subscription'))
  if (five) {
    return {
      ok: true,
      id: relay.id,
      name: relay.name,
      kind: 'quota',
      currency: (balance && balance.currency) || 'USD',
      windows: [five],
      balance,
      source: 'cubence',
    }
  }
  if (balance) {
    return { ok: true, id: relay.id, name: relay.name, kind: 'balance', currency: balance.currency, balance, source: 'cubence' }
  }
  return null
}

// ---------- 汇总卡 ----------

export function quotaCardOf(status) {
  if (!status || !status.ok) {
    return {
      kind: 'error',
      title: (status && status.name ? status.name : '中转站') + ' 额度',
      reason: (status && status.reason) || '读取失败',
    }
  }
  const title = status.name + (status.kind === 'quota' ? ' 额度' : ' 余额')
  if (status.kind === 'quota' && Array.isArray(status.windows) && status.windows.length) {
    return {
      kind: 'windows',
      title,
      rows: status.windows.map((w) => ({
        label: w.label,
        percentUsed: w.percentUsed,
        used: w.used,
        total: w.total,
        remaining: w.remaining,
        resetAt: w.resetAt,
      })),
      balance: status.balance || null,
      currency: status.currency || 'USD',
    }
  }
  if (status.balance) {
    return {
      kind: 'balance',
      title,
      balance: status.balance,
      currency: status.balance.currency || status.currency || 'USD',
    }
  }
  return { kind: 'error', title, reason: '该站未返回可展示的额度' }
}

// ---------- 主入口（带 TTL 缓存与并发合并） ----------

const cache = new Map()
const pending = new Map()

function relayOrigin(relay, provider) {
  let base = provider && provider.baseUrl
  if (!base || (provider && provider.isLocal)) base = 'https://' + relay.hosts[0]
  try {
    return new URL(base).origin
  } catch (err) {
    return 'https://' + relay.hosts[0]
  }
}

async function readNewApi(relay, ctx) {
  const errors = []
  // 1) API Key → token 额度（最省事，绝大多数站都能用）
  if (ctx.key) {
    const token = await getJson(ctx.origin + '/api/usage/token', 'Bearer ' + ctx.key, ctx.allowed)
    if (token.ok) {
      const shaped = shapeNewApiTokenUsage(relay, token.data)
      if (shaped) return shaped
      errors.push('token 额度响应结构不符合预期')
    } else {
      errors.push('/api/usage/token: ' + token.error)
    }

    // 2) OpenAI 兼容账单：API Key 直接查总额与已用
    const sub = await getJson(ctx.origin + '/v1/dashboard/billing/subscription', 'Bearer ' + ctx.key, ctx.allowed)
    if (sub.ok) {
      const now = new Date()
      const start = '2024-01-01'
      const end = new Date(now.getTime() + 86400_000).toISOString().slice(0, 10)
      const usage = await getJson(
        ctx.origin + '/v1/dashboard/billing/usage?start_date=' + start + '&end_date=' + end,
        'Bearer ' + ctx.key,
        ctx.allowed,
      )
      const shaped = shapeNewApiBilling(relay, sub.data, usage.ok ? usage.data : null)
      if (shaped) return shaped
      errors.push('账单响应结构不符合预期')
    } else {
      errors.push('/v1/dashboard/billing: ' + sub.error)
    }
  }

  // 3) 系统访问令牌 + 用户 ID → 账户余额
  const auth = ctx.auth || {}
  if (auth.token && auth.userId) {
    const self = await getJson(ctx.origin + '/api/user/self', String(auth.token), ctx.allowed, {
      'New-Api-User': String(auth.userId),
    })
    if (self.ok) {
      const shaped = shapeNewApiUserSelf(relay, self.data)
      if (shaped) return shaped
      errors.push('/api/user/self 响应结构不符合预期')
    } else {
      errors.push('/api/user/self: ' + self.error)
    }
  } else if (ctx.key) {
    errors.push('未配置系统访问令牌/用户 ID')
  }
  return { ok: false, id: relay.id, name: relay.name, reason: errors.join('；') }
}

async function readSub2Api(relay, ctx) {
  if (!ctx.key) return { ok: false, id: relay.id, name: relay.name, reason: '未找到该站的 API Key' }
  const res = await getJson(ctx.origin + '/v1/usage', 'Bearer ' + ctx.key, ctx.allowed)
  if (!res.ok) return { ok: false, id: relay.id, name: relay.name, reason: '/v1/usage: ' + res.error }
  const shaped = shapeSub2Usage(relay, res.data)
  if (shaped) return shaped
  return { ok: false, id: relay.id, name: relay.name, reason: '/v1/usage 响应结构不符合预期' }
}

async function readCubence(relay, ctx) {
  if (!ctx.key) return { ok: false, id: relay.id, name: relay.name, reason: '未找到该站的 API Key' }
  const res = await getJson(ctx.origin + '/v1/user/subscription-info', 'Bearer ' + ctx.key, ctx.allowed)
  if (!res.ok) return { ok: false, id: relay.id, name: relay.name, reason: '/v1/user/subscription-info: ' + res.error }
  const shaped = shapeCubence(relay, res.data)
  if (shaped) return shaped
  return { ok: false, id: relay.id, name: relay.name, reason: '/v1/user/subscription-info 响应结构不符合预期' }
}

export function invalidateRelayCache() {
  cache.clear()
}

export async function readRelayQuota(relay, opts) {
  const o = opts || {}
  const provider = o.provider || findRelayProvider(relay)
  const cfg = readPluginConfig()
  const key = o.apiKey || (provider && provider.apiKey) || str(cfg.vendorKeys && cfg.vendorKeys['relay-' + relay.id])
  const auth = o.auth || (cfg.relayAuth && cfg.relayAuth[relay.id]) || {}
  if (!key && !(auth.token && auth.userId)) {
    return { ok: false, id: relay.id, name: relay.name, reason: '未找到该站的 API Key' }
  }
  const origin = relayOrigin(relay, provider)
  const allowed = relay.apiHosts || relay.hosts
  // 缓存键不含密钥本体；providerId 足以区分多账号
  const cacheKey = relay.id + '|' + origin + '|' + (provider && provider.providerId ? provider.providerId : 'default')
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.status
  const inflight = pending.get(cacheKey)
  if (inflight) return inflight
  const ctx = { origin, key, auth, allowed }
  const task = (async () => {
    let status
    try {
      if (relay.platform === 'sub2api') status = await readSub2Api(relay, ctx)
      else if (relay.platform === 'cubence') status = await readCubence(relay, ctx)
      else status = await readNewApi(relay, ctx)
    } catch (err) {
      status = { ok: false, id: relay.id, name: relay.name, reason: String((err && err.message) || err) }
    }
    cache.set(cacheKey, { at: Date.now(), status })
    pending.delete(cacheKey)
    return status
  })()
  pending.set(cacheKey, task)
  return task
}
