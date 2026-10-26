// 统一会话模型（D034）：四个宿主的会话都归一成同一个形状，UI 不做字段猜测。
//
// 硬规则：
//   · 所有数值 number|null，禁止 NaN / 字符串数字 / 负数；
//   · key = `${agentId}:${sessionId}`，全局唯一；
//   · 缺失不补 0（tokens / cost / timestamps 可以为 null），但 count 这类
//     可确定的计数默认 0；
//   · 字符串先截断再入模型；错误消息过 redact；
//   · 显式挑字段，不用对象展开 —— __proto__ 之类的键进不来。

import { defaultSourceOfAdapter, normalizeProv, originOfAdapter, prov, unavailable } from './provenance.mjs'
import { redactText } from './redact.mjs'

export const SESSION_STATUSES = [
  'working',
  'waiting_input',
  'waiting_permission',
  'error',
  'done',
  'idle',
  'unknown',
]
export const STATUS_SOURCES = ['hook', 'db', 'log', 'http', 'inferred', 'ingest']

// 归档三态：exclude（默认）/ only / all。非法值按 exclude 处理。
export const ARCHIVED_MODES = ['exclude', 'only', 'all']

// pending 没有显式 expiresAt 时的兜底（宿主 fail-open 截止约 15s）。
export const PENDING_DEFAULT_TTL_MS = 15_000

// 「已完成」的展示窗口：状态机仍在回合结束 4 秒后回落 idle，但列表/胶囊/
// 快览卡在这 5 分钟内继续显示「已完成」，避免用户事后看到的是「空闲」。
// 只做展示，不改变工作/等待/出错这些活跃状态。
export const DONE_DISPLAY_MS = 5 * 60_000

/**
 * 展示状态（D056）：活跃状态优先，其次 workflow 在跑，其次 5 分钟内的 doneAt。
 * 服务端与 UI 都只读这个函数，避免三个界面各算各的。
 */
export function displayStatusOf(session, now = Date.now()) {
  const s = session && typeof session === 'object' ? session : {}
  const status = SESSION_STATUSES.includes(s.status) ? s.status : 'unknown'
  if (status === 'waiting_permission') return 'waiting_permission'
  if (status === 'waiting_input') return 'waiting_input'
  if (status === 'error') return 'error'
  if (status === 'working') return 'working'
  // 后台还有 workflow/子任务在跑：即使本会话回合已结束也不能显示空闲/已完成。
  if (s.workflowBusy === true) return 'working'
  // 钩子确认当前回合仍在进行（工具结束到首字之间没有新库行）。
  if (s.turnActive === true) return 'working'
  if (status === 'done') return 'done'
  const doneAt = Number(s.doneAt)
  if (Number.isFinite(doneAt) && doneAt > 0 && now >= doneAt && now - doneAt < DONE_DISPLAY_MS) return 'done'
  return status === 'unknown' ? 'unknown' : 'idle'
}

export function normalizeArchivedMode(v, fallback = 'exclude') {
  const s = String(v == null ? '' : v).toLowerCase()
  return ARCHIVED_MODES.includes(s) ? s : fallback
}

export function matchesArchived(session, mode = 'exclude') {
  const archived = !!(session && session.archived === true)
  if (mode === 'only') return archived
  if (mode === 'all') return true
  return !archived
}

export const STATUS_LABELS = {
  working: '工作中',
  waiting_input: '等待输入',
  waiting_permission: '等待确认',
  error: '出错',
  done: '已完成',
  idle: '空闲',
  unknown: '状态未知',
}

// 聚合优先级：等待确认 > 出错 > 等待输入 > 工作中 > 已完成 > 空闲。
export const STATUS_PRIORITY = ['waiting_permission', 'error', 'waiting_input', 'working', 'done', 'idle', 'unknown']

const AGENT_RE = /^[a-z][a-z0-9-]{1,23}$/
const SESSION_RE = /^[A-Za-z0-9._:-]{1,80}$/

export function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.unknown
}

export function aggregateOf(sessions) {
  const list = Array.isArray(sessions) ? sessions : []
  const counts = {
    working: 0,
    waiting: 0,
    waiting_permission: 0,
    waiting_input: 0,
    error: 0,
    done: 0,
    idle: 0,
    unknown: 0,
  }
  for (const s of list) {
    if (!s) continue
    // 计数与展示同源：displayStatus 已把 5 分钟内的 doneAt、workflowBusy
    // 与 turnActive 算进去；没有该字段时回退机器状态。
    const status = SESSION_STATUSES.includes(s.displayStatus) ? s.displayStatus : s.status
    if (status === 'working') counts.working += 1
    else if (status === 'waiting_permission') {
      counts.waiting += 1
      counts.waiting_permission += 1
    } else if (status === 'waiting_input') {
      counts.waiting += 1
      counts.waiting_input += 1
    } else if (status === 'error') counts.error += 1
    else if (status === 'done') counts.done += 1
    else if (status === 'idle') counts.idle += 1
    else counts.unknown += 1
  }
  let aggregate = 'idle'
  if (counts.waiting_permission > 0) aggregate = 'waiting_permission'
  else if (counts.error > 0) aggregate = 'error'
  else if (counts.waiting_input > 0) aggregate = 'waiting_input'
  else if (counts.working > 0) aggregate = 'working'
  else if (counts.done > 0) aggregate = 'done'
  else if (counts.idle > 0) aggregate = 'idle'
  else if (counts.unknown > 0) aggregate = 'unknown'
  if (!list.length) aggregate = 'idle'
  return { aggregate, counts }
}

function text(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max)
}

function num(v, { min = 0, max = Number.MAX_SAFE_INTEGER, int = true } = {}) {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  const clamped = Math.min(max, Math.max(min, n))
  return int ? Math.round(clamped) : clamped
}

function ts(v) {
  const n = num(v, { max: 8.64e15 })
  return n === null || n <= 0 ? null : n
}

function boolCount(v) {
  return num(v, { max: 1e12 }) || 0
}

function normalizeTokens(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    total: num(r.total),
    input: num(r.input),
    output: num(r.output),
    cacheRead: num(r.cacheRead),
    cacheWrite: num(r.cacheWrite),
    reasoning: num(r.reasoning),
  }
}

function normalizeCost(raw) {
  if (!raw || typeof raw !== 'object') return null
  const amount = num(raw.amount, { int: false, max: 1e12 })
  if (amount === null) return null
  return {
    amount: Math.round(amount * 10000) / 10000,
    currency: /^[A-Z]{3,8}$/.test(String(raw.currency || '')) ? String(raw.currency) : 'CNY',
    unit: ['money', 'credit', 'percent'].includes(raw.unit) ? raw.unit : 'money',
  }
}

function normalizeTurns(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const cur = r.current && typeof r.current === 'object' ? r.current : null
  return {
    count: boolCount(r.count),
    current: cur
      ? {
          id: text(cur.id, 80),
          index: num(cur.index, { max: 1e9 }),
          startedAt: ts(cur.startedAt),
        }
      : null,
    avgDurationMs: num(r.avgDurationMs, { max: 365 * 86400000 }),
  }
}

function normalizeTools(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const running = Array.isArray(r.running)
    ? r.running
        .map((x) => {
          if (!x || typeof x !== 'object') return null
          const name = text(x.name, 80)
          if (!name) return null
          return { name, since: ts(x.since) }
        })
        .filter(Boolean)
        .slice(0, 20)
    : []
  return { calls: boolCount(r.calls), errors: boolCount(r.errors), running }
}

function normalizeErrors(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const last = r.last && typeof r.last === 'object' ? r.last : null
  return {
    model: boolCount(r.model),
    tool: boolCount(r.tool),
    last: last
      ? {
          at: ts(last.at) || 0,
          kind: last.kind === 'model' ? 'model' : 'tool',
          message: redactText(last.message, 200),
        }
      : null,
  }
}

function keyOf(agentId, sessionId) {
  return agentId + ':' + sessionId
}

export function normalizeSession(raw, ctx = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const agentId = AGENT_RE.test(String(r.agentId || ctx.agentId || ''))
    ? String(r.agentId || ctx.agentId)
    : 'generic'
  const sessionId = text(r.sessionId || ctx.sessionId, 80).replace(/[^A-Za-z0-9._:-]/g, '')
  const key = sessionId ? keyOf(agentId, sessionId) : text(r.key, 120)
  const status = SESSION_STATUSES.includes(r.status) ? r.status : 'unknown'
  const statusSource = STATUS_SOURCES.includes(r.statusSource) ? r.statusSource : 'inferred'
  const nowMs = ts(ctx.now) || Date.now()
  const updatedAt = ts(r.updatedAt) || nowMs
  const startedAt = ts(r.startedAt)
  const endedAt = ts(r.endedAt)
  const tokens = normalizeTokens(r.tokens)
  const cost = normalizeCost(r.cost)
  // 预付/套餐用量的等价市值：与真实支出分开保存，成本为 0 时展示 «≈»（D054）
  const costMarket = normalizeCost(r.costMarket)
  const statusProv =
    r.provenance && r.provenance.status
      ? normalizeProv(r.provenance.status, { origin: originOfAdapter(agentId), source: defaultSourceOfAdapter(agentId) })
      : status === 'unknown'
        ? unavailable('host-unsupported', defaultSourceOfAdapter(agentId), originOfAdapter(agentId))
        : prov('exact', defaultStatusOrigin(statusSource, agentId), defaultSourceOfAdapter(agentId), { asOf: updatedAt })
  const tokenProv =
    r.provenance && r.provenance.tokens
      ? normalizeProv(r.provenance.tokens, { origin: originOfAdapter(agentId), source: defaultSourceOfAdapter(agentId) })
      : tokens.total === null
        ? unavailable('no-data', defaultSourceOfAdapter(agentId), originOfAdapter(agentId))
        : prov('exact', originOfAdapter(agentId), defaultSourceOfAdapter(agentId), { asOf: updatedAt })
  const costProv =
    r.provenance && r.provenance.cost
      ? normalizeProv(r.provenance.cost, { origin: 'pricing-table', source: 'pricing' })
      : cost === null
        ? unavailable('no-data', defaultSourceOfAdapter(agentId), originOfAdapter(agentId))
        : prov('estimated', 'pricing-table', 'pricing', { asOf: updatedAt })
  const toolsProv =
    r.provenance && r.provenance.tools
      ? normalizeProv(r.provenance.tools, { origin: originOfAdapter(agentId), source: defaultSourceOfAdapter(agentId) })
      : prov('exact', originOfAdapter(agentId), defaultSourceOfAdapter(agentId), { asOf: updatedAt })

  const out = {
    key: key.slice(0, 120),
    agentId,
    sessionId,
    parentKey: r.parentKey ? text(r.parentKey, 120) : null,
    title: text(r.title, 200),
    cwd: text(r.cwd, 400),
    model: text(r.model, 80),
    provider: text(r.provider, 80),
    status,
    statusSince: ts(r.statusSince) || updatedAt,
    statusSource,
    startedAt,
    updatedAt,
    endedAt,
    // 最近一次「回合结束」的时间：done 的 5 分钟展示窗口从这里起算。
    // 与 endedAt 分开是因为 endedAt 可能来自适配器的上一回合结束，而
    // doneAt 只在真正进入 done 时写入（含 workflow 结束）。
    doneAt: ts(r.doneAt),
    // 钩子确认当前回合仍在进行；workflowBusy 表示以本会话为父的
    // workflow/dwf run 仍在跑（两者都压制 done/idle）。
    turnActive: r.turnActive === true,
    turnActiveSince: ts(r.turnActiveSince),
    workflowBusy: r.workflowBusy === true,
    workflowBusySince: ts(r.workflowBusySince),
    archived: r.archived === true,
    // 真实宿主时间（不是适配器补的 now）。用于判断轮询是否带来了新证据，
    // 避免「updatedAt 永远是 now」把等待确认误清。
    lastHostAt: ts(r.lastHostAt),
    turns: normalizeTurns(r.turns),
    tokens,
    cost,
    costMarket,
    tools: normalizeTools(r.tools),
    errors: normalizeErrors(r.errors),
    pending: Array.isArray(r.pending)
      ? r.pending
          .filter((x) => x && typeof x === 'object')
          .slice(0, 5)
          .map((x) => {
            const createdAt = ts(x.createdAt) || nowMs
            const expiresAt = ts(x.expiresAt) || createdAt + PENDING_DEFAULT_TTL_MS
            return {
              id: text(x.id, 80),
              kind: 'permission',
              agentId: text(x.agentId, 24) || agentId,
              sessionKey: text(x.sessionKey, 120) || key,
              tool: text(x.tool, 80),
              preview: redactText(x.preview, 400),
              risk: x.risk === 'high' ? 'high' : 'normal',
              createdAt,
              expiresAt,
              state: ['pending', 'allowed', 'denied', 'timeout', 'ignored'].includes(x.state) ? x.state : 'pending',
            }
          })
      : [],
    provenance: { tokens: tokenProv, cost: costProv, status: statusProv, tools: toolsProv },
  }
  return out
}

function defaultStatusOrigin(source, agentId) {
  if (source === 'hook') return 'local-log'
  if (source === 'http') return 'api'
  return originOfAdapter(agentId)
}

// SSE / 列表用的轻量摘要：去掉大字段，只保留 UI 首屏需要的部分。
export function summarizeSession(s) {
  const x = s && typeof s === 'object' ? s : {}
  return {
    key: String(x.key || ''),
    agentId: String(x.agentId || ''),
    sessionId: String(x.sessionId || ''),
    parentKey: x.parentKey || null,
    title: String(x.title || ''),
    cwd: String(x.cwd || ''),
    model: String(x.model || ''),
    provider: String(x.provider || ''),
    status: SESSION_STATUSES.includes(x.status) ? x.status : 'unknown',
    statusSince: Number(x.statusSince) || 0,
    statusSource: STATUS_SOURCES.includes(x.statusSource) ? x.statusSource : 'inferred',
    startedAt: x.startedAt == null ? null : Number(x.startedAt) || null,
    updatedAt: Number(x.updatedAt) || 0,
    endedAt: x.endedAt == null ? null : Number(x.endedAt) || null,
    doneAt: x.doneAt == null ? null : Number(x.doneAt) || null,
    turnActive: x.turnActive === true,
    workflowBusy: x.workflowBusy === true,
    // 服务端派生（live-tracker 写入）；没有就直接读 status。
    displayStatus: SESSION_STATUSES.includes(x.displayStatus) ? x.displayStatus : null,
    archived: x.archived === true,
    lastHostAt: x.lastHostAt == null ? null : Number(x.lastHostAt) || null,
    turns: { count: Number(x.turns && x.turns.count) || 0 },
    tokens: { total: x.tokens && x.tokens.total != null ? Number(x.tokens.total) : null },
    cost: x.cost && Number.isFinite(Number(x.cost.amount))
      ? { amount: Number(x.cost.amount), currency: String(x.cost.currency || 'CNY'), unit: String(x.cost.unit || 'money') }
      : null,
    // 预付/套餐用量的等价市值（不是真实支出）：成本列为 0 时前端用 «≈» 展示（D054）
    costMarket: x.costMarket && Number.isFinite(Number(x.costMarket.amount))
      ? { amount: Number(x.costMarket.amount), currency: String(x.costMarket.currency || 'CNY'), unit: String(x.costMarket.unit || 'money') }
      : null,
    tools: { calls: Number(x.tools && x.tools.calls) || 0, errors: Number(x.tools && x.tools.errors) || 0 },
    errors: { model: Number(x.errors && x.errors.model) || 0, tool: Number(x.errors && x.errors.tool) || 0 },
    pending: Array.isArray(x.pending) ? x.pending.slice(0, 3) : [],
    provenance: x.provenance || null,
  }
}

// 排序：updated / tokens / cost / duration。缺值排最后（不是 0）。
//
// 必须是「全序」：每个会话都能和其它会话分出先后，否则分页游标在等值时
// 会跳条或重复（控制台「滚两下就跳到末尾」的数据层诱因之一）。
// 顺序：排序值降序 → key 升序 → updatedAt 降序；只有同一个 key 才返回 0。
export function compareSessionsForSort(a, b, sort = 'updated') {
  const av = sortValue(a, sort)
  const bv = sortValue(b, sort)
  if (av === null && bv !== null) return 1
  if (av !== null && bv === null) return -1
  if (av !== null && bv !== null && av !== bv) return bv - av
  const ak = String((a && a.key) || '')
  const bk = String((b && b.key) || '')
  if (ak !== bk) return ak < bk ? -1 : 1
  const au = Number(a && a.updatedAt) || 0
  const bu = Number(b && b.updatedAt) || 0
  if (au !== bu) return bu - au
  return 0
}

export function compareSessions(a, b, sort = 'updated') {
  return compareSessionsForSort(a, b, sort)
}

export function sortValue(s, sort) {
  if (!s) return null
  if (sort === 'tokens') return s.tokens && s.tokens.total != null ? Number(s.tokens.total) : null
  if (sort === 'cost') return s.cost && Number.isFinite(Number(s.cost.amount)) ? Number(s.cost.amount) : null
  if (sort === 'duration') {
    if (s.startedAt && s.updatedAt) return Math.max(0, s.updatedAt - s.startedAt)
    return null
  }
  return Number(s.updatedAt) || 0
}

// 游标 v1：{v:1,s,val,k,u}。val 是排序值（updated 时等于 u），k/u 保证
// 老适配器按 (updatedAt,key) 偏移仍能工作。老游标 {u,k} 由 parseCursor 兼容。
export function cursorOf(s, sort = 'updated') {
  const x = s && typeof s === 'object' ? s : {}
  const safeSort = ['updated', 'tokens', 'cost', 'duration'].includes(sort) ? sort : 'updated'
  const val = sortValue(x, safeSort)
  const payload = JSON.stringify({
    v: 1,
    s: safeSort,
    val: val === null ? null : val,
    k: String(x.key || ''),
    u: Number(x.updatedAt) || 0,
  })
  return Buffer.from(payload, 'utf8').toString('base64url')
}

export function parseCursor(cursor) {
  try {
    const raw = JSON.parse(Buffer.from(String(cursor || ''), 'base64url').toString('utf8'))
    if (!raw || typeof raw !== 'object') return null
    const u = Number(raw.u)
    const k = String(raw.k || '')
    if (!Number.isFinite(u) || !k) return null
    const sort = ['updated', 'tokens', 'cost', 'duration'].includes(raw.s) ? raw.s : 'updated'
    let val = sort === 'updated' ? u : null
    if (raw.v && raw.val !== undefined) {
      if (raw.val === null) val = null
      else if (Number.isFinite(Number(raw.val))) val = Number(raw.val)
      else return null
    }
    return {
      v: Number(raw.v) || 0,
      mode: raw.mode === 'all' || raw.mode === 'agent' ? raw.mode : '',
      agent: String(raw.agent || ''),
      sort,
      val,
      key: k,
      updatedAt: u,
    }
  } catch (err) {
    return null
  }
}

// keyset 比较：会话排在游标之后返回 >0，之前返回 <0，同一 key 返回 0。
// 锚点会话被删除也不影响——只按 (val,key) 比较，不做「找不到就回第一页」。
export function compareSessionToCursor(s, sort, cur) {
  if (!s) return 0
  if (!cur) return 1
  const safeSort = cur.sort || sort || 'updated'
  const synthetic = {
    key: String(cur.key || ''),
    updatedAt: Number(cur.updatedAt) || 0,
    tokens: { total: safeSort === 'tokens' ? (cur.val == null ? null : Number(cur.val)) : null },
    cost: safeSort === 'cost' ? { amount: cur.val == null ? null : Number(cur.val) } : null,
    startedAt:
      safeSort === 'duration' && cur.val != null
        ? (Number(cur.updatedAt) || 0) - Number(cur.val)
        : null,
  }
  return compareSessionsForSort(s, synthetic, safeSort)
}
