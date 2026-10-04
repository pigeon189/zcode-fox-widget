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
// 凭据从 cmdgo 反代的本地配置现读（多账号池），**不复制、不落盘**；
// 每凭据 60s TTL 缓存，失败同样计入 TTL（坏 key 不被状态轮询打爆）。
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { assertSafeUpstream } from './credentials.mjs'

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

// 套餐目录：月度 credit 额度与 5 小时/周帽（帽 = 月度池的 30%/60%，
// GOAT/Pro 为 20%/50%）。帽对与套餐一一对应，可用来反查未知 planId。
export const CMDGO_PLANS = [
  { id: 'individual-go', name: 'Go', monthly: 10, fiveHourCap: 3, weeklyCap: 6 },
  { id: 'individual-goat', name: 'GOAT', monthly: 70, fiveHourCap: 14, weeklyCap: 35 },
  { id: 'individual-pro', name: 'Pro', monthly: 80, fiveHourCap: 16, weeklyCap: 40 },
  { id: 'individual-max-10x', name: 'Max 10×', monthly: 150, fiveHourCap: 45, weeklyCap: 90 },
  { id: 'individual-max-20x', name: 'Max 20×', monthly: 300, fiveHourCap: 90, weeklyCap: 180 },
  { id: 'team-pro', name: 'Team Pro', monthly: 40, fiveHourCap: 12, weeklyCap: 24 },
]

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
  const total = plan?.monthly
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
  const over = (w) => !!w && (w.exceeded === true || (Number(w.percent) || 0) >= 1)
  if (over(data.fiveHour) || over(data.weekly)) return false
  if (data.monthly && (Number(data.monthly.percent) || 0) >= 1) return false
  if (data.limited === true && data.monthly && (Number(data.monthly.percent) || 0) >= 0.99) return false
  return true
}

// 预计「解锁时刻」：撞墙窗口里**最晚**的重置时间（必须等它，见 bindingWindow
// 同款语义）；没有撞墙窗口但被网关标限（墙在窗口算术看不见的地方，如月池
// 见底）时，保守取全部窗口里最晚的重置时间；连重置时间都没有 → null
//（排序时按 +∞ 处理，排在最后）。
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
  return null
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

// 账号候选顺序（导出供测试：这是「展示哪个账号 / 池算几个」的唯一组装点）
export function accountCandidates(dir) {
  const local = readCmdgoAccounts(dir)
  // 有 key 的账号按「最近使用」优先——bridge 也会优先把请求给这个账号
  const { active, available, total } = pickActiveAccount(local.accounts)
  const ordered = []
  const push = (acct) => {
    if (!acct || !acct.ref || !local.keys[acct.ref]) return
    if (ordered.some((x) => x.ref === acct.ref)) return
    ordered.push({ ref: acct.ref, userName: acct.userName || null })
  }
  push(active)
  const byRecency = local.accounts
    .filter((a) => a && a.enabled !== false && local.keys[a.ref])
    .sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0))
  for (const a of byRecency) push(a)
  // 兜底路：credentials.json 里有 key 而 accounts.json 没有条目的场景（单 key 手填）。
  // 但**用户在 bridge 里显式停用的账号必须排除**——否则它会被选成「当前账号」显示
  // 额度、还被算进 pool.available，看着像「还有额度可烧」（停用是用户的明确意志）。
  const disabled = new Set(
    local.accounts.filter((a) => a && a.enabled === false).map((a) => a.ref),
  )
  for (const ref of Object.keys(local.keys)) {
    if (disabled.has(ref)) continue
    push({ ref, userName: null })
  }
  return { ordered, pool: { available, total } }
}

export function invalidateCmdgoCache() {
  cache.clear()
}

async function fetchKeyCached(ref, force) {
  const cached = cache.get(ref)
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached
  const key = readCmdgoAccounts().keys[ref]
  if (!key) return { at: Date.now(), error: 'key 缺失' }
  try {
    const raw = await fetchCmdgoKey(CMDGO_BASE, key)
    const data = shapeCmdgoUsage(raw.credits, raw.subscription, raw.whoami)
    const entry = data ? { at: Date.now(), data } : { at: Date.now(), error: '响应结构不符合预期' }
    cache.set(ref, entry)
    return entry
  } catch (err) {
    const entry = { at: Date.now(), error: String((err && err.message) || err) }
    cache.set(ref, entry)
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
  const snapshots = await Promise.all(
    ordered.map(async (cand) => ({ cand, entry: await fetchKeyCached(cand.ref, force) })),
  )
  const { withData, usable, chosen } = chooseSnapshot(snapshots)
  const pool = { available: usable.length, total: ordered.length, cooldownFree: acctPool.available }
  if (!chosen) {
    const lastErr = snapshots.map((s) => s.entry.error).filter(Boolean).pop()
    return { ok: false, reason: lastErr || '读取失败', pool }
  }
  const payload = { ref: chosen.cand.ref, pool, ...chosen.entry.data }
  if (chosen.entry.data.userName == null && chosen.cand.userName) payload.userName = chosen.cand.userName
  return { ok: true, ...payload }
}
