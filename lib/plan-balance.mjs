// ZCode Plan（start-plan 套餐）剩余配额：从 ZCode 客户端日志尾随解析。
//
// 背景：ZCode 桌面客户端每次刷新套餐余额，都会把完整 payload 明文写进当天日志
// （主进程 usage-stats 记录器，行内含「billing/balance 请求完成 」标记 + JSON）。
// 客户端约每分钟刷新一次，会话活跃时更密。挂件读不到客户端进程，也没有该接口
// 的凭据（plan key 存在客户端加密凭据库里），所以日志是最可靠的零密钥数据源。
//
// 日志位置（按顺序探测）：
//   1. $ZCODE_DATA_BASE_DIR/.zcode/v2/logs/<YYYY-MM-DD>.log   （数据目录迁移后，如 E:\ZCodeData）
//   2. <ZCODE_HOME>/v2/logs/<YYYY-MM-DD>.log                  （迁移前默认 ~/.zcode/v2/logs）
// 客户端关闭后当天文件不再更新：数据仍可用，按「日期非今天」标记 stale。
//
// 行格式（标记后是一个 JSON 对象，一行内）：
//   ... [usage-stats] billing/balance 请求完成 {"balanceCount":N,"balances":[...],...,
//        "payload":{"code":0,"data":{"server_time":...,"plans":[...],"balances":[...]}}}
// 顶层 balances 与 payload.data.balances 内容一致，取顶层即可；plans 在 payload.data.plans。
import fs from 'node:fs'
import path from 'node:path'
import { normalizeModelId } from './pricing.mjs'
import { resolveBillingSource } from './source.mjs'
import { v2DataDirCandidates, ZCODE_HOME } from './paths.mjs'

const MARKER = 'billing/balance 请求完成 '
const TAIL_BYTES = 512 * 1024
const MAX_LOOKBACK_DAYS = 7
const CACHE_TTL_MS = 30_000

// 归一化模型名供配额桶匹配：capabilities 里是 "model:glm-5.3-flash"，
// model_usage 里是 "GLM-5.3-Flash"，统一成小写、去网关前缀后比对。
// （与 pricing.mjs 的 normalizeModelId 同一逻辑，收敛到一处导出。）

function localDayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function logDirCandidates() {
  return v2DataDirCandidates().map((dir) => path.join(dir, 'logs'))
}

// 从一段日志文本里解析最后一个标记行；没有则返回 null
function parseLastBalanceLine(text) {
  const idx = text.lastIndexOf(MARKER)
  if (idx === -1) return null
  const lineEnd = text.indexOf('\n', idx)
  const line = lineEnd === -1 ? text.slice(idx + MARKER.length) : text.slice(idx + MARKER.length, lineEnd)
  try {
    const obj = JSON.parse(line.trim())
    return obj && typeof obj === 'object' ? obj : null
  } catch (err) {
    return null
  }
}

// 读一个日志文件的尾部并解析；没有标记行返回 null
function readLogFile(full) {
  let stat
  try {
    stat = fs.statSync(full)
  } catch (err) {
    return null
  }
  const start = Math.max(0, stat.size - TAIL_BYTES)
  let text = ''
  try {
    const fd = fs.openSync(full, 'r')
    try {
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    return null
  }
  const parsed = parseLastBalanceLine(text)
  return parsed ? { payload: parsed, mtimeMs: stat.mtimeMs } : null
}

// 顶层响应 → 展示结构。
// balances 每条是一个「配额桶」（客户端日志里是摘要形态，只有 7 个标量字段，
// **不含 capabilities**）：
//   { entitlement_id, show_name, total_units, used_units, remaining_units,
//     available_units, reserved_units }
// 模型映射要靠 plans[].entitlements[]：那里面有 capabilities:["model:glm-5.3-flash"]
// 和 entitlement_id，与 balance 的 entitlement_id 关联；对不上时退回用 show_name
// 归一化当模型名（start-plan 的桶 show_name 就是模型名，实测可用）。
// plans 每条是一个套餐：{ plan_id, name, status, starts_at, ends_at, entitlements }（秒级时间戳）
export function shapePlanPayload(raw, logDate, mtimeMs) {
  const balances = Array.isArray(raw && raw.balances) ? raw.balances : []
  const plansRaw =
    raw && raw.payload && raw.payload.data && Array.isArray(raw.payload.data.plans)
      ? raw.payload.data.plans
      : []
  if (!balances.length && !plansRaw.length) return null

  // entitlement_id → 模型名数组（来自套餐的 capabilities）
  const modelsByEntitlement = new Map()
  for (const p of plansRaw) {
    const ents = Array.isArray(p && p.entitlements) ? p.entitlements : []
    for (const e of ents) {
      if (!e || !e.entitlement_id) continue
      const caps = Array.isArray(e.capabilities) ? e.capabilities : []
      const models = caps
        .filter((c) => typeof c === 'string' && c.indexOf('model:') === 0)
        .map((c) => normalizeModelId(c.slice('model:'.length)))
        .filter(Boolean)
      if (models.length) modelsByEntitlement.set(e.entitlement_id, models)
    }
  }

  let remaining = 0
  let total = 0
  let used = 0
  const byModel = new Map()
  const resets = []
  for (const b of balances) {
    const r = Number(b.remaining_units)
    const t = Number(b.total_units)
    const u = Number(b.used_units)
    if (Number.isFinite(r)) remaining += r
    if (Number.isFinite(t)) total += t
    if (Number.isFinite(u)) used += u
    const models = modelsByEntitlement.get(b.entitlement_id) || [normalizeModelId(b.show_name)]
    for (const key of models) {
      if (!key) continue
      let entry = byModel.get(key)
      if (!entry) {
        entry = { model: key, showName: b.show_name || '', remainingUnits: 0, totalUnits: 0, usedUnits: 0 }
        byModel.set(key, entry)
      }
      if (Number.isFinite(r)) entry.remainingUnits += r
      if (Number.isFinite(t)) entry.totalUnits += t
      if (Number.isFinite(u)) entry.usedUnits += u
      if (!entry.showName && b.show_name) entry.showName = b.show_name
    }
    for (const tsKey of ['period_end', 'expires_at']) {
      const v = Number(b[tsKey])
      if (Number.isFinite(v) && v > 0) resets.push(v)
    }
  }
  // 到期/重置时间：优先取各桶周期结束的最早未来值；没有就取 active 套餐的 ends_at
  const nowSec = Date.now() / 1000
  let nextResetAt = null
  const futureResets = resets.filter((v) => v > nowSec).sort((a, b) => a - b)
  if (futureResets.length) nextResetAt = futureResets[0] * 1000
  else {
    const ends = plansRaw
      .filter((p) => p && String(p.status || '').toLowerCase() === 'active' && Number.isFinite(Number(p.ends_at)) && Number(p.ends_at) > 0)
      .map((p) => Number(p.ends_at) * 1000)
      .filter((v) => v > Date.now())
      .sort((a, b) => a - b)
    if (ends.length) nextResetAt = ends[0]
  }

  const plans = plansRaw.map((p) => ({
    planId: p.plan_id || '',
    name: p.name || '',
    status: p.status || '',
    startsAt: Number.isFinite(Number(p.starts_at)) ? Number(p.starts_at) * 1000 : null,
    endsAt: Number.isFinite(Number(p.ends_at)) ? Number(p.ends_at) * 1000 : null,
  }))

  return {
    ok: true,
    source: 'plan-log',
    logDate,
    stale: logDate !== localDayKey(),
    observedAt: mtimeMs,
    serverTime: (() => {
      const st = raw && raw.payload && raw.payload.data && Number(raw.payload.data.server_time)
      return Number.isFinite(st) && st > 0 ? st * 1000 : null
    })(),
    remaining,
    total,
    used,
    percentRemaining: total > 0 ? remaining / total : null,
    percentUsed: total > 0 ? used / total : null,
    nextResetAt,
    byModel: [...byModel.values()],
    plans,
  }
}

// 每个候选目录的探测结果：目录在不在、最新日志是哪天。数据目录迁移后，终端
// 场景（没有 ZCODE_DATA_BASE_DIR）会探到残留旧目录——把事实报出来，别让
// 「用户没套餐」和「找错目录」都挤在一个 no-plan-log 里。
function probeLogDirs(dates) {
  return logDirCandidates().map((dir) => {
    let exists = false
    let newest = null
    try {
      exists = fs.statSync(dir).isDirectory()
      newest =
        fs
          .readdirSync(dir)
          .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
          .sort()
          .pop() || null
    } catch (err) {}
    return { dir, exists, newestLog: newest }
  })
}

// 主入口：读候选目录里最近 N 天的日志，返回最近一次余额观测（带缓存）。
// 读不到任何观测时返回 { ok:false, reason, probedDirs }。
export function readPlanBalance() {
  const cached = readPlanBalance.cache
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload
  const today = localDayKey()
  const dates = []
  for (let i = 0; i < MAX_LOOKBACK_DAYS; i++) {
    const d = new Date(Date.now() - i * 86400_000)
    dates.push(localDayKey(d))
  }
  let found = null
  outer: for (const dir of logDirCandidates()) {
    for (const date of dates) {
      const hit = readLogFile(path.join(dir, date + '.log'))
      if (hit) {
        const shaped = shapePlanPayload(hit.payload, date, hit.mtimeMs)
        if (shaped) {
          found = shaped
          break outer
        }
      }
    }
  }
  const payload = found || { ok: false, reason: 'no-plan-log', probedDirs: probeLogDirs(dates) }
  readPlanBalance.cache = { at: Date.now(), payload }
  return payload
}

// 让缓存立即失效（测试与强制刷新用）
export function invalidatePlanCache() {
  readPlanBalance.cache = null
}

// 某个模型当前可用配额桶（供每轮消耗算「占配额百分比」）。返回 { totalUnits, remainingUnits } 或 null
export function quotaBucketForModel(plan, model) {
  if (!plan || !plan.ok || !Array.isArray(plan.byModel)) return null
  const key = normalizeModelId(model)
  const entry = plan.byModel.find((b) => b.model === key)
  if (!entry || !(entry.totalUnits > 0)) return null
  return { totalUnits: entry.totalUnits, remainingUnits: entry.remainingUnits }
}

// ---------- 套餐扣费轮的「余额口径」消耗 ----------
//
// 订阅套餐（Start plan 等）按量价目算出的金额是虚构的：配额按 tokens 扣、
// 不花钱。这类轮次的本轮消耗改用百分比表达，且基数与主显示「Plan 剩余 x%」
// 一致（占配额总量），两个数字可以直接相减对账。
// 返回 null 表示该轮没有套餐行；planTurn=true 表示有套餐行（即便读不到配额
// 观测——此时 pct 为 null，展示层宁可显示 tokens 也不显示虚构金额）。
export function turnPlanUsage(turn) {
  const rows = Array.isArray(turn && turn.models) ? turn.models : []
  // 只认「provider 本身是套餐」的行：付费 bigmodel 的 GLM 行模型名相同，
  // 但那是真金白银，不能混进配额口径
  const planRows = rows.filter(
    (m) => m && m.tokens > 0 && resolveBillingSource(m.providerId, m.model).source === 'plan'
  )
  if (!planRows.length) return null
  const dom = planRows.slice().sort((a, b) => b.tokens - a.tokens)[0]
  const out = {
    planTurn: true,
    pctOfTotal: null,
    pctOfBucket: null,
    tokens: dom.tokens,
    extraAmounts: extraAmountsOfTurn(turn),
  }
  const plan = readPlanBalance()
  if (!plan || !plan.ok || !(plan.total > 0)) return out
  out.pctOfTotal = Math.round((dom.tokens / plan.total) * 10000) / 100
  const bucket = quotaBucketForModel(plan, dom.model)
  if (bucket && bucket.totalUnits > 0) {
    out.pctOfBucket = Math.round((dom.tokens / bucket.totalUnits) * 10000) / 100
  }
  return out
}

// 轮内非套餐行的可计价金额（混合轮次：套餐部分按 %，其余源仍是真金白银，
// 在 hint 里补一句「另耗 ¥x」避免只报 % 漏掉真实开销）
export function extraAmountsOfTurn(turn) {
  const rows = Array.isArray(turn && turn.models) ? turn.models : []
  const out = {}
  for (const m of rows) {
    if (!m || !m.billable || !(Number(m.amount) > 0)) continue
    if (resolveBillingSource(m.providerId, m.model).source === 'plan') continue
    const cur = m.currency || 'CNY'
    out[cur] = (out[cur] || 0) + Number(m.amount)
  }
  const keys = Object.keys(out)
  if (!keys.length) return null
  for (const c of keys) out[c] = Math.round(out[c] * 1e6) / 1e6
  return out
}

export { normalizeModelId as normalizeModelKey, localDayKey }
