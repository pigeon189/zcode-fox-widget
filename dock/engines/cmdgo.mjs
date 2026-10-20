// CommandCode 套餐三重额度读取：月度 credit 池 + 5 小时/周 两个滚动窗口。
//
// 路由与官方 CLI 逐条一致（对照 command-code CLI 路由表，DSH 侧
// dsh-cmdgo-provider 同款实现已实测可用）：
//   GET /alpha/whoami                 -> 用户名 + org（best effort）
//   GET /alpha/billing/credits        -> credits.monthlyCredits（月度池剩余）
//                                        + windowLimits.{fiveHour,weekly}{used,cap,exceeded,resetAt}
//   GET /alpha/billing/subscriptions  -> planId / currentPeriodEnd（best effort）
// 月度**总额度**接口不返回：按套餐目录由 planId 恢复（目录缺失时用
// 5 小时/周帽对反查——帽对与套餐一一对应，见 CMDGO_PLANS）。
//
// 出站仅 https://api.commandcode.ai，host 走显式白名单（assertSafeUpstream）；
// 凭据有两个来源，都**现读、不复制、不落盘**：
//   1. 宿主（ZCode / WorkBuddy）里配置的 CommandCode 官方 API provider——除 Go
//      套餐外的套餐发的就是这把官方 key（`user…`），与 CLI 共用 /alpha/billing；
//   2. cmdgo 反代的本地配置（Go 套餐走 CLI）：accounts.json + credentials.json。
// 同一账号常被配成两个 provider（OpenAI 兼容 + Anthropic），key 相同，按 key
// 去重成一个账号。每凭据 45s TTL 缓存，失败同样计入 TTL（坏 key 不被轮询打爆）。
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { assertSafeUpstream } from './credentials.mjs'
import { listZcodeProviders } from './discover.mjs'

const CMDGO_HOST = 'api.commandcode.ai'
const CMDGO_BASE = 'https://' + CMDGO_HOST
// 指纹头：网关按官方 CLI 校验客户端（user-agent/env/版本三者缺一不可）
const CC_VERSION = '1.31.0'
const CMDGO_HEADERS_BASE = {
  'user-agent': 'cli',
  'x-cli-environment': 'cli',
  'x-command-code-version': CC_VERSION,
  accept: 'application/json',
}
// 每凭据缓存 45s：页面侧轮询是 60s，取 45 留出余量——两边都取 60s 时轮询几乎
// 每次都刚好错过缓存，等于每轮都真出网。
const TTL_MS = 45_000
const TIMEOUT_MS = 8_000
// 反代（cmdgo-bridge）本地数据目录：accounts.json 存账号池状态，
// credentials.json 存 ref -> apiKey（只现读，不复制）。
// CMDGO_DIR 环境变量供测试隔离（selftest/smoke 指向空目录，绝不真出网）。
const CMDGO_DIR = process.env.CMDGO_DIR || path.join(homedir(), '.cmdgo-bridge')

function isCmdgoHost(host) {
  return host === CMDGO_HOST || host.endsWith('.' + CMDGO_HOST)
}

// 套餐目录：月度 credit 额度与 5 小时/周帽（帽 = 月度池的 30%/60%，
// GOAT/Pro 为 20%/50%）。帽对与套餐一一对应，可用来反查未知 planId。
//
// 2026-10-20 官方页：GOAT 卡片改为「$80 in credits」（对比表仍写 $70），
// 老账户保留 $70 月度池。新账户按 80、老账户按 legacyMonthly 70 计算百分比。
export const CMDGO_PLANS = [
  { id: 'individual-go', name: 'Go', monthly: 10, fiveHourCap: 3, weeklyCap: 6 },
  { id: 'individual-goat', name: 'GOAT', monthly: 80, fiveHourCap: 14, weeklyCap: 35, legacyMonthly: 70 },
  { id: 'individual-pro', name: 'Pro', monthly: 80, fiveHourCap: 16, weeklyCap: 40 },
  { id: 'individual-max-10x', name: 'Max 10×', monthly: 150, fiveHourCap: 45, weeklyCap: 90 },
  { id: 'individual-max-20x', name: 'Max 20×', monthly: 300, fiveHourCap: 90, weeklyCap: 180 },
  { id: 'team-pro', name: 'Team Pro', monthly: 40, fiveHourCap: 12, weeklyCap: 24 },
]

// 新 GOAT 月度 credit 的生效日（老订阅按 createdAt 判断，保留 70）。
export const CMDGO_GOAT_CREDITS_FROM = Date.UTC(2026, 9, 20)

function isLegacyGoat(sub, fiveHourCap, weeklyCap) {
  const created = isRecord(sub) && typeof sub.createdAt === 'string' ? Date.parse(sub.createdAt) : NaN
  if (Number.isFinite(created)) return created < CMDGO_GOAT_CREDITS_FROM
  // 没有 createdAt（本地池）时，老帽对 14/35 视为 70 档；新 GOAT 若改成
  // 16/40，exact planId 仍会命中 GOAT，不受这条兜底影响。
  return Math.abs(fiveHourCap - 14) < 0.01 && Math.abs(weeklyCap - 35) < 0.01
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined)
const isRecord = (v) => typeof v === 'object' && v !== null

// planId -> 套餐目录条目：精确/最长前缀优先，其次帽对反查
export function resolveCmdgoPlan(planId, fiveHourCap, weeklyCap) {
  const id = str(planId)
  if (id) {
    const exact = CMDGO_PLANS.find((p) => p.id === id)
    if (exact) return exact
    const prefixed = CMDGO_PLANS.filter((p) => id.startsWith(p.id)).sort((a, b) => b.id.length - a.id.length)[0]
    if (prefixed) return prefixed
  }
  const five = num(fiveHourCap)
  const weekly = num(weeklyCap)
  if (five !== undefined && five > 0) {
    const byCaps = CMDGO_PLANS.find(
      (p) => Math.abs(p.fiveHourCap - five) < 0.01 && (weekly === undefined || Math.abs(p.weeklyCap - weekly) < 0.01)
    )
    if (byCaps) return byCaps
  }
  return undefined
}

function windowOf(raw) {
  if (!isRecord(raw)) return undefined
  const used = num(raw.used)
  const cap = num(raw.cap)
  if (used === undefined || cap === undefined || cap <= 0) return undefined
  const resetAt = num(raw.resetAt)
  return {
    used,
    cap,
    exceeded: raw.exceeded === true,
    resetAt: resetAt !== undefined && resetAt > 0 ? resetAt : null,
    remaining: Math.max(0, cap - used),
    percent: used / cap,
  }
}

// 三个原始响应 -> 气泡/预警要的扁平视图。任何一路缺失都尽力降级：
// credits 是主数据（缺失 = ok:false），subscription/whoami 只影响月度
// 总额度恢复与账号名展示。
export function shapeCmdgoUsage(credits, subscription, whoami) {
  if (!isRecord(credits)) return null
  const pool = isRecord(credits.credits) ? credits.credits : {}
  const limits = isRecord(credits.windowLimits) ? credits.windowLimits : {}
  const fiveHour = windowOf(limits.fiveHour)
  const weekly = windowOf(limits.weekly)
  const monthlyRemaining = num(pool.monthlyCredits)
  if (monthlyRemaining === undefined && !fiveHour && !weekly) return null
  const sub = isRecord(subscription) && isRecord(subscription.data) ? subscription.data : subscription
  const planId = isRecord(sub) ? str(sub.planId) : undefined
  const plan = resolveCmdgoPlan(planId, fiveHour?.cap, weekly?.cap)
  // 老 GOAT 账户保留 $70 月度池；新账户用 $80。createdAt 缺失时按旧帽对判断。
  const legacy = plan?.id === 'individual-goat' && isLegacyGoat(sub, fiveHour?.cap, weekly?.cap)
  const total = legacy && plan.legacyMonthly ? plan.legacyMonthly : plan?.monthly
  // 月度窗口的重置时间：套餐周期的 currentPeriodEnd（ISO 串或毫秒/秒数）
  const rawEnd = isRecord(sub) ? sub.currentPeriodEnd : undefined
  let periodEndMs = null
  if (typeof rawEnd === 'string') {
    const t = Date.parse(rawEnd)
    if (Number.isFinite(t)) periodEndMs = t
  } else if (typeof rawEnd === 'number' && Number.isFinite(rawEnd) && rawEnd > 0) {
    periodEndMs = rawEnd > 1e12 ? rawEnd : rawEnd * 1000
  }
  const monthly =
    monthlyRemaining !== undefined && total !== undefined
      ? {
          remaining: Math.max(0, monthlyRemaining),
          total,
          percent: Math.min(1, Math.max(0, (total - monthlyRemaining) / total)),
          resetAt: periodEndMs,
          legacy: !!legacy,
        }
      : null
  const owner = isRecord(whoami) && isRecord(whoami.user) ? whoami.user : undefined
  const userName = isRecord(owner) ? str(owner.userName) : undefined
  const limited = limits.limited === true
  return {
    plan: plan?.name ?? (planId ? 'Command Code' : null),
    userName: userName ?? null,
    monthly,
    fiveHour: fiveHour ?? null,
    weekly: weekly ?? null,
    limited,
    readAt: Date.now(),
  }
}

// 账号池：enabled 且冷却已过的账号里，取最近一次成功调用的那个——
// 它就是「当前正在消耗额度的账号」；同时统计池可用数
export function pickActiveAccount(accounts, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const list = Array.isArray(accounts) ? accounts : []
  const alive = list.filter((a) => a && a.enabled !== false && !(Number(a.cooldownUntil) > now))
  const active = alive.filter((a) => Number.isFinite(Number(a.lastUsedAt))).sort((a, b) => Number(b.lastUsedAt) - Number(a.lastUsedAt))[0]
  return { active: active ?? alive[0] ?? null, available: alive.length, total: list.length }
}

// 读反代本地配置：credentials.json（ref -> key）+ accounts.json（池状态）。
// 文件缺失/坏 JSON 一律降级为空池——单 key 模式（env/config）另行兜底。
export function readCmdgoAccounts(dir) {
  const base = dir ?? CMDGO_DIR
  const out = { keys: {}, accounts: [] }
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(base, 'credentials.json'), 'utf8'))
    if (creds && typeof creds === 'object') {
      for (const [ref, entry] of Object.entries(creds)) {
        // 反代存的是 { value, source } 对象（FileCredentials 的 StoreShape）；
        // 兼容纯字符串形式，两种都收
        const raw = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.value : ''
        if (typeof raw === 'string' && raw.trim()) out.keys[ref] = raw.trim()
      }
    }
  } catch (err) {}
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(base, 'accounts.json'), 'utf8'))
    if (idx && Array.isArray(idx.accounts)) out.accounts = idx.accounts
  } catch (err) {}
  return out
}

function getJson(base, pathName, key, orgQuery) {
  const url = assertSafeUpstream(base + pathName + orgQuery, [CMDGO_HOST])
  return fetch(url, {
    headers: { ...CMDGO_HEADERS_BASE, authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(async (res) => {
    const text = await res.text()
    if (!res.ok) throw new Error('HTTP ' + res.status)
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new Error('响应不是合法 JSON')
    }
  })
}

// 单凭据完整读取：whoami（best effort）拿 orgId -> credits（主数据）-> subscription（best effort）
export async function fetchCmdgoKey(baseURL, key) {
  const base = (baseURL ?? CMDGO_BASE).replace(/\/+$/, '')
  let orgQuery = ''
  try {
    const whoami = await getJson(base, '/alpha/whoami', key, '')
    const dataRoot = isRecord(whoami?.data) ? whoami.data : whoami
    const org = isRecord(dataRoot) && isRecord(dataRoot.org) ? dataRoot.org : undefined
    const orgId = isRecord(org) ? str(org.id) : undefined
    if (orgId) orgQuery = `?orgId=${encodeURIComponent(orgId)}`
    const credits = await getJson(base, '/alpha/billing/credits', key, orgQuery)
    const subscription = await getJson(base, '/alpha/billing/subscriptions', key, orgQuery).catch(() => undefined)
    return { credits, subscription, whoami }
  } catch (err) {
    // whoami 失败时上面已抛——orgId 只是展示增强，降级为无 org 重试一次主路由
    const credits = await getJson(base, '/alpha/billing/credits', key, '')
    const subscription = await getJson(base, '/alpha/billing/subscriptions', key, '').catch(() => undefined)
    return { credits, subscription, whoami: undefined }
  }
}

// 快照是否「还有额度可烧」：任一窗口 exceeded / 已用≥100% 即视为撞墙。
// 网关 limited 标志是**粘滞**的（真机 2026-10-04 二次实锤：账号升级 GOAT
// 后配额全满、请求正常，limited 仍是 true——v1.8.3 把它当「当前不可用」
// 的权威信号，结果唯一健康的账号被踢出可选池，卡片继续展示旧套餐超额）。
// 所以它只在能被佐证时才采信：某个窗口撞墙（over 检查），或月池已用 ≥99%
//（月池见底、网关已拒绝请求、墙不在窗口算术里的场景——v1.8.3 的原始案例）。
export function snapshotUsable(data) {
  if (!data) return false
  // 本地池会把请求失败/限流的账号标成冷却中：冷却期内不算「可烧」
  if (Number(data.cooldownUntil) > Date.now()) return false
  const over = (w) => !!w && (w.exceeded === true || (Number(w.percent) || 0) >= 1)
  if (over(data.fiveHour) || over(data.weekly)) return false
  if (data.monthly && (Number(data.monthly.percent) || 0) >= 1) return false
  if (data.limited === true && data.monthly && (Number(data.monthly.percent) || 0) >= 0.99) return false
  return true
}

// 预计「解锁时刻」：撞墙窗口里**最晚**的重置时间（必须等它，见 bindingWindow
// 同款语义）；没有撞墙窗口但被网关标限（墙在窗口算术看不见的地方，如月池
// 见底）时，保守取全部窗口里最晚的重置时间；连重置时间都没有 → null
//（排序时按 +∞ 处理，排在最后）。本地池的冷却截止也算一种「解锁时刻」。
function unblockAt(data) {
  if (!data) return null
  const over = (w) => !!w && (w.exceeded === true || (Number(w.percent) || 0) >= 1)
  const wins = [data.fiveHour, data.weekly, data.monthly]
  const overResets = wins.filter((w) => over(w) && w.resetAt).map((w) => Number(w.resetAt))
  if (overResets.length) return Math.max(...overResets)
  if (data.limited === true) {
    const all = wins.map((w) => (w && w.resetAt ? Number(w.resetAt) : null)).filter((t) => t)
    if (all.length) return Math.max(...all)
  }
  const cooldown = Number(data.cooldownUntil) || 0
  return cooldown > Date.now() ? cooldown : null
}

// 选展示账号（导出供测试）：优先「最近使用的可用账号」（bridge 也把它当
// 消耗主力）；**全部撞墙时改选最早解锁的**——把「什么时候能用回来」最短
// 的那面墙摆出来。真机场景：两账号本周撞墙（重置差两天）、一个网关限流但
// 墙看不见，选今天就把本周窗口重置的那个，倒计时才有意义；限流但看不见墙
// 的账号按最晚重置时间排最后。
export function chooseSnapshot(snapshots) {
  const withData = (Array.isArray(snapshots) ? snapshots : []).filter((s) => s && s.entry && s.entry.data)
  const usable = withData.filter((s) => snapshotUsable(s.entry.data))
  let chosen = usable[0] || null
  if (!chosen && withData.length) {
    chosen = withData
      .map((s) => ({ s, at: unblockAt(s.entry.data) }))
      .sort((a, b) => (a.at === null ? Infinity : a.at) - (b.at === null ? Infinity : b.at))[0].s
  }
  return { withData, usable, chosen }
}

// ---- 汇总入口（带每凭据 TTL 缓存） ----
const cache = new Map() // ref -> { at, data } | { at, error }
const poolCache = new Map() // poolBase -> { at, group } | { at, error }
const poolPending = new Map() // poolBase -> Promise

// 宿主里配置的 CommandCode provider。两种形态都收：
//   1. 官方 API（除 Go 套餐外）：baseURL 指向 api.commandcode.ai，key 是官方
//      `user…`；同一账号的 OpenAI/Anthropic 两个 provider 共用 key，按 key 去重。
//   2. 本地账号池（如 commandcode-pool）：baseURL 指向环回地址，/health 直接给出
//      每个账号的额度快照；按 pool origin 去重（两个接入点共用一个池）。
// 只对「名字里带 CommandCode/cmdgo 的本地点」查 /health——其它本地网关是别的
// 东西，不能凭"本地"就去敲它的端口。
function isCmdgoProviderName(e) {
  const hay = [e.providerId, e.providerName, e.templateId].filter(Boolean).join(' ').toLowerCase()
  return hay.indexOf('commandcode') !== -1 || hay.indexOf('cmdgo') !== -1
}

function loopbackOrigin(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const loopback = h === 'localhost' || h === '::1' || h === '127.0.0.1' || /^127\./.test(h)
    return loopback ? u.origin : ''
  } catch (err) {
    return ''
  }
}

export function readHostCmdgoAccounts(entries) {
  const list = Array.isArray(entries) ? entries : listZcodeProviders()
  const seenKeys = new Set()
  const seenPools = new Set()
  const out = []
  for (const e of list) {
    if (!isRecord(e)) continue
    if (e.isLocal) {
      if (!isCmdgoProviderName(e)) continue
      const origin = loopbackOrigin(e.baseUrl)
      if (!origin || seenPools.has(origin)) continue
      seenPools.add(origin)
      out.push({
        ref: 'pool:' + origin,
        userName: String(e.providerName || '').trim() || null,
        key: e.apiKey || '',
        poolBase: origin,
        kind: 'pool',
        source: 'host-pool',
      })
      continue
    }
    if (!e.apiKey || e.keyEncrypted) continue
    if (!isCmdgoHost(String(e.host || '').toLowerCase())) continue
    if (seenKeys.has(e.apiKey)) continue
    seenKeys.add(e.apiKey)
    const label = String(e.providerName || '')
      .replace(/\s*[（(]\s*Claude\s*[）)]\s*$/i, '')
      .trim()
    out.push({
      ref: 'provider:' + e.providerId,
      userName: label || null,
      key: e.apiKey,
      kind: 'official',
      source: 'host-provider',
    })
  }
  return out
}

// 本地池 /health 的单账号快照 -> 与官方接口塑形后的同一形状。池里没有
// subscription，套餐总额靠 5 小时/周帽对反查（帽对与套餐一一对应）。
export function shapePoolQuota(account) {
  if (!isRecord(account)) return null
  const q = isRecord(account.quota) ? account.quota : null
  if (!q) return null
  const fiveHour = windowOf(q.fiveHour)
  const weekly = windowOf(q.weekly)
  const monthlyRemaining = num(q.monthlyCredits)
  const plan = resolveCmdgoPlan(undefined, fiveHour?.cap, weekly?.cap)
  const legacy = plan?.id === 'individual-goat' && isLegacyGoat(null, fiveHour?.cap, weekly?.cap)
  const total = legacy && plan.legacyMonthly ? plan.legacyMonthly : plan?.monthly
  const monthly =
    monthlyRemaining !== undefined && total
      ? {
          remaining: Math.max(0, monthlyRemaining),
          total,
          percent: Math.min(1, Math.max(0, (total - monthlyRemaining) / total)),
          resetAt: null,
          legacy: !!legacy,
        }
      : null
  if (!monthly && !fiveHour && !weekly) return null
  // 卡片标题已经是「CommandCode 额度」，账号行再带一遍厂商名只会挤掉真正
  // 有用的信息（气泡小字是单行省略号）——去掉前缀，留下「GOAT 账号 1」
  const label = (str(account.label) || str(account.id) || '').replace(/^CommandCode\s+/i, '').trim()
  return {
    plan: plan?.name ?? null,
    userName: label || null,
    monthly,
    fiveHour: fiveHour ?? null,
    weekly: weekly ?? null,
    limited: false,
    cooldownUntil: Number(account.cooldownUntil) || 0,
    readAt: Date.now(),
  }
}

// 账号候选顺序（导出供测试：这是「展示哪个账号 / 池算几个」的唯一组装点）
// 反代账号（有 lastUsedAt 的按最近使用优先）在前，宿主 provider 在后；
// 两路共用一把 key 时只保留先出现的那个（不会把同一个账号算两次）。
export function mergeAccountCandidates(local, hostAccounts) {
  const keys = (local && local.keys) || {}
  const accounts = Array.isArray(local && local.accounts) ? local.accounts : []
  // 有 key 的账号按「最近使用」优先——bridge 也会优先把请求给这个账号
  const { active, available } = pickActiveAccount(accounts)
  const ordered = []
  const seenKeys = new Set()
  const seenRefs = new Set()
  const push = (acct) => {
    if (!acct || !acct.ref) return false
    const key = acct.key !== undefined ? acct.key : keys[acct.ref]
    if (!key || seenRefs.has(acct.ref) || seenKeys.has(key)) return false
    seenRefs.add(acct.ref)
    seenKeys.add(key)
    ordered.push({
      ref: acct.ref,
      userName: acct.userName || null,
      key,
      kind: acct.kind || 'bridge',
      poolBase: acct.poolBase || null,
      source: acct.source || 'bridge',
    })
    return true
  }
  push(active)
  const byRecency = accounts
    .filter((a) => a && a.enabled !== false && keys[a.ref])
    .sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0))
  for (const a of byRecency) push(a)
  // 兜底路：credentials.json 里有 key 而 accounts.json 没有条目的场景（单 key 手填）。
  // 但**用户在 bridge 里显式停用的账号必须排除**——否则它会被选成「当前账号」显示
  // 额度、还被算进 pool.available，看着像「还有额度可烧」（停用是用户的明确意志）。
  const disabled = new Set(accounts.filter((a) => a && a.enabled === false).map((a) => a.ref))
  for (const ref of Object.keys(keys)) {
    if (disabled.has(ref)) continue
    push({ ref, userName: null })
  }
  let hostAdded = 0
  for (const a of Array.isArray(hostAccounts) ? hostAccounts : []) {
    if (push(a)) hostAdded += 1
  }
  return {
    ordered,
    pool: { available: available + hostAdded, total: ordered.length },
  }
}

export function accountCandidates(dir, hostAccounts) {
  const local = readCmdgoAccounts(dir)
  const extra = hostAccounts === undefined ? readHostCmdgoAccounts() : hostAccounts
  return mergeAccountCandidates(local, extra)
}

export function invalidateCmdgoCache() {
  cache.clear()
  poolCache.clear()
}

const POOL_TIMEOUT_MS = 4_000

function getLocalJson(url, key) {
  const headers = { accept: 'application/json' }
  if (key) headers.authorization = 'Bearer ' + key
  return fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(POOL_TIMEOUT_MS),
  }).then(async (res) => {
    const text = await res.text()
    if (!res.ok) throw new Error('HTTP ' + res.status)
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new Error('响应不是合法 JSON')
    }
  })
}

// 本地池一次 /health 拉全量账号，按池缓存（两个接入点共用一个池，只敲一次）。
async function fetchPoolCached(cand, force) {
  const base = cand.poolBase
  const cached = poolCache.get(base)
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached
  const pending = poolPending.get(base)
  if (!force && pending) return pending
  const task = (async () => {
    try {
      const payload = await getLocalJson(new URL('/health', base).toString(), cand.key)
      const accounts = isRecord(payload) && Array.isArray(payload.accounts) ? payload.accounts : []
      const members = []
      for (const a of accounts) {
        if (!isRecord(a) || a.enabled === false) continue
        const data = shapePoolQuota(a)
        if (!data) continue
        members.push({
          ref: cand.ref + '#' + (str(a.id) || String(members.length)),
          userName: data.userName,
          lastUsedAt: Number(a.lastUsedAt) || 0,
          data,
        })
      }
      // 池的策略是「最近使用的账号优先」；没用过的排后面（稳定排序）
      members.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      const entry = { at: Date.now(), group: members }
      poolCache.set(base, entry)
      return entry
    } catch (err) {
      const entry = { at: Date.now(), error: String((err && err.message) || err) }
      poolCache.set(base, entry)
      return entry
    } finally {
      poolPending.delete(base)
    }
  })()
  poolPending.set(base, task)
  return task
}

async function fetchEntryCached(cand, force) {
  if (cand.kind === 'pool') return fetchPoolCached(cand, force)
  const cached = cache.get(cand.ref)
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached
  const key = cand.key
  if (!key) return { at: Date.now(), error: 'key 缺失' }
  try {
    const raw = await fetchCmdgoKey(CMDGO_BASE, key)
    const data = shapeCmdgoUsage(raw.credits, raw.subscription, raw.whoami)
    const entry = data ? { at: Date.now(), data } : { at: Date.now(), error: '响应结构不符合预期' }
    cache.set(cand.ref, entry)
    return entry
  } catch (err) {
    const entry = { at: Date.now(), error: String((err && err.message) || err) }
    cache.set(cand.ref, entry)
    return entry
  }
}

// 主入口：返回 { ok, ref, pool, userName, plan, monthly, fiveHour, weekly, limited, reason? }。
// 账号选择：按「最近使用」顺序取数，**优先返回还有额度的账号**——当前账号撞墙
// 而池里还有可用账号时显示后者（bridge 也会切过去）；全部撞墙时显示**最早
// 解锁**的那个（把「什么时候能用回来」最短的那面墙和重置时间摆出来，
// 见 chooseSnapshot）。
// 池可用数 pool.available 按**额度快照**算（还有额度可烧的账号数），不是「没在
// 冷却中」的账号数——后者会把刚撞墙、bridge 还没来得及标记的账号也算成可用；
// 网关 limited 标志只在有佐证（窗口撞墙 / 月池≥99%）时才计不可用，
// 它是粘滞标志，升级/重置后可能残留（见 snapshotUsable）。
// 取数**并行**（每凭据 3 个上游请求，串行时池越大越慢，9 个请求 × 8s 超时最坏
// 24s，会把 /whale/cmdgo.json 和 /whale/vendors.json 一起拖住）；TTL 命中时
// 纯内存，稳态下每 45s 才真出网一轮。
export async function readCmdgoQuota(force) {
  const { ordered, pool: acctPool } = accountCandidates()
  if (!ordered.length) return { ok: false, reason: 'no-credentials', pool: { available: 0, total: 0 } }
  const fetched = await Promise.all(
    ordered.map(async (cand) => ({ cand, entry: await fetchEntryCached(cand, force) })),
  )
  // 本地池的一个 candidate 会在 /health 里展开成多个账号：把 group 摊平成
  // 快照，池的 available/total 就按真实账号数算，而不是按「几个池」算。
  const snapshots = []
  for (const { cand, entry } of fetched) {
    if (entry && Array.isArray(entry.group)) {
      for (const m of entry.group) {
        snapshots.push({ cand: { ref: m.ref, userName: m.userName }, entry: { at: entry.at, data: m.data } })
      }
    } else {
      snapshots.push({ cand, entry })
    }
  }
  const { withData, usable, chosen } = chooseSnapshot(snapshots)
  const pool = { available: usable.length, total: snapshots.length, cooldownFree: acctPool.available }
  if (!chosen) {
    const lastErr = fetched.map((f) => f.entry && f.entry.error).filter(Boolean).pop()
    return { ok: false, reason: lastErr || '读取失败', pool }
  }
  const payload = { ref: chosen.cand.ref, pool, ...chosen.entry.data }
  if (chosen.entry.data.userName == null && chosen.cand.userName) payload.userName = chosen.cand.userName
  return { ok: true, ...payload }
}
