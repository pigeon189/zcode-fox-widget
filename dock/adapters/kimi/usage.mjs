// Kimi Code 套餐用量：GET /coding/v1/usages（宿主同款接口）。
//
// 响应形状（Kimi Code 1.1 实测 + 宿主源码里的 zod schema）：
//   {
//     usages: {
//       limit_5h?:          { used_ratio: 0.42, reset_time: "..." },
//       limit_7d?:          { used_ratio: 0.18, reset_time: "..." },
//       limit_month_total?: { used_ratio: 0.31, reset_time: "..." },
//       limit_month_code?:  { used_ratio: 0.07, reset_time: "..." }
//     },
//     boosterWallet?: {
//       balance: { type: "BOOSTER", amount: <1e6 定点>, amountLeft: <1e6 定点> },
//       monthlyChargeLimit?: { priceInCents, currency },
//       monthlyUsed?: { priceInCents, currency },
//       monthlyChargeLimitEnabled?: boolean
//     }
//   }
//
// 账号没开 Kimi For Coding 时接口返回 {}（Free 账号实测）。这时不能报错，
// 也不能编一个 0%：降级成「Free 套餐，没有可读窗口」交给 UI 说明。
//
// 结果缓存 60s：浮层每 3 秒轮询一次，额度接口没必要跟着打。

import {
  KIMI_BASE_URL,
  KIMI_OAUTH_HOST,
  credentialsFile,
  defaultKimiHome,
  getKimiAccessToken,
} from './credentials.mjs'

const WINDOW_DEFS = [
  { key: 'limit_5h', label: '5 小时', api: 'limit_5h' },
  { key: 'limit_7d', label: '7 天', api: 'limit_7d' },
  { key: 'month_total', label: '本月', api: 'limit_month_total' },
  { key: 'month_code', label: '本月 Code', api: 'limit_month_code' },
]

const CACHE_TTL_MS = 60_000
const cache = new Map()

export function _resetKimiUsageCache() {
  cache.clear()
}

function clampPct(n) {
  if (!Number.isFinite(n)) return null
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10))
}

// used_ratio 官方是 0..1；也容忍直接给百分数（>1.5 视为百分数）。
export function ratioToPct(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (n <= 1.5) return clampPct(n * 100)
  if (n <= 100) return clampPct(n)
  return 100
}

function parseWindow(entry) {
  if (!entry || typeof entry !== 'object') return null
  const remaining = ratioToPct(entry.used_ratio)
  if (remaining === null) return null
  // 接口给的是「已用比例」；字段命名保留 used，同时算出 remaining 给 UI。
  return {
    usedPct: remaining,
    remainingPct: clampPct(100 - remaining),
    resetAt: typeof entry.reset_time === 'string' ? entry.reset_time.slice(0, 40) : '',
  }
}

function fixedPointToCents(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  const cents = n / 1e6
  return cents > 0 && cents < 1 ? 1 : Math.round(cents)
}

export function parseKimiWallet(wallet) {
  if (!wallet || typeof wallet !== 'object') return null
  const balance = wallet.balance
  if (!balance || typeof balance !== 'object') return null
  const total = fixedPointToCents(balance.amount)
  if (total === null) return null
  const left = fixedPointToCents(balance.amountLeft)
  const cents = left === null ? total : left
  const currency =
    (wallet.monthlyChargeLimit && typeof wallet.monthlyChargeLimit.currency === 'string' && wallet.monthlyChargeLimit.currency) ||
    (wallet.monthlyUsed && typeof wallet.monthlyUsed.currency === 'string' && wallet.monthlyUsed.currency) ||
    'USD'
  const monthlyLimitCents = Number(wallet.monthlyChargeLimit && wallet.monthlyChargeLimit.priceInCents)
  const monthlyUsedCents = Number(wallet.monthlyUsed && wallet.monthlyUsed.priceInCents)
  return {
    amount: Math.round((cents / 100) * 10000) / 10000,
    currency,
    total: Math.round((total / 100) * 10000) / 10000,
    monthlyLimitCents: Number.isFinite(monthlyLimitCents) ? monthlyLimitCents : null,
    monthlyUsedCents: Number.isFinite(monthlyUsedCents) ? monthlyUsedCents : null,
    monthlyLimitEnabled: wallet.monthlyChargeLimitEnabled === true,
  }
}

export function parseKimiUsage(payload) {
  const usages = payload && typeof payload === 'object' && payload.usages && typeof payload.usages === 'object' ? payload.usages : {}
  const windows = []
  for (const def of WINDOW_DEFS) {
    const parsed = parseWindow(usages[def.api])
    if (!parsed) continue
    windows.push({ key: def.key, label: def.label, ...parsed })
  }
  return {
    windows,
    wallet: parseKimiWallet(payload && payload.boosterWallet),
  }
}

async function fetchJson(url, token, { fetchImpl, timeoutMs = 10000 } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch
  const res = await doFetch(url, {
    headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  let body = null
  try {
    body = await res.json()
  } catch (err) {}
  return { status: res.status, ok: res.ok, body }
}

function planNameOf(me) {
  if (!me || typeof me !== 'object') return ''
  const level = String(me.user_level_name || '').trim()
  if (level) return level
  if (Number(me.goods_version) > 0) return 'Kimi For Coding'
  return ''
}

// 返回：
//   { ok:true, windows, wallet, plan, account, region, usageUrl, meUrl }
//   { ok:false, error }
export async function readKimiStatus(opts = {}) {
  const home = opts.home || defaultKimiHome(opts.env)
  const file = opts.file || credentialsFile(home)
  const baseUrl = String(opts.baseUrl || process.env.KIMI_CODE_BASE_URL || KIMI_BASE_URL).replace(/\/+$/, '')
  const nowMs = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const cacheKey = file + '|' + baseUrl
  const hit = cache.get(cacheKey)
  if (hit && nowMs - hit.at < CACHE_TTL_MS) return hit.value

  try {
    let token = await getKimiAccessToken({
      home,
      file,
      now: nowMs,
      fetchImpl: opts.fetchImpl,
      oauthHost: opts.oauthHost || KIMI_OAUTH_HOST,
      clientId: opts.clientId,
      timeoutMs: opts.timeoutMs,
    })
    let usage = await fetchJson(baseUrl + '/usages', token, opts)
    // access_token 可能在两次读取之间被宿主换掉：401 时强制刷新一次再试。
    if (usage.status === 401) {
      token = await getKimiAccessToken({
        home,
        file,
        now: nowMs,
        forceRefresh: true,
        fetchImpl: opts.fetchImpl,
        oauthHost: opts.oauthHost || KIMI_OAUTH_HOST,
        clientId: opts.clientId,
        timeoutMs: opts.timeoutMs,
      })
      usage = await fetchJson(baseUrl + '/usages', token, opts)
    }
    if (!usage.ok) {
      if (usage.status === 404) {
        const value = { ok: false, error: 'Kimi Code 额度接口不可用（账号可能没有 Kimi For Coding）' }
        cache.set(cacheKey, { at: nowMs, value })
        return value
      }
      const detail =
        usage.body && usage.body.error && typeof usage.body.error.message === 'string'
          ? usage.body.error.message.slice(0, 120)
          : ''
      const value = { ok: false, error: 'Kimi Code 额度读取失败（HTTP ' + usage.status + (detail ? '：' + detail : '') + '）' }
      cache.set(cacheKey, { at: nowMs, value })
      return value
    }
    const parsed = parseKimiUsage(usage.body)

    let me = null
    try {
      const r = await fetchJson(baseUrl + '/me', token, opts)
      if (r.ok && r.body && typeof r.body === 'object') me = r.body
    } catch (err) {}

    const value = {
      ok: true,
      windows: parsed.windows,
      wallet: parsed.wallet,
      plan: planNameOf(me),
      account: me && typeof me.nickname === 'string' ? me.nickname.slice(0, 60) : '',
      region: me && typeof me.region === 'string' ? me.region : '',
      userId: me && typeof me.user_id === 'string' ? me.user_id : '',
      usageUrl: baseUrl + '/usages',
    }
    cache.set(cacheKey, { at: nowMs, value })
    return value
  } catch (err) {
    const value = { ok: false, error: String((err && err.message) || err).slice(0, 200) }
    cache.set(cacheKey, { at: nowMs, value })
    return value
  }
}
