// 会话状态归约（D034）：纯函数，便于用随机序列测试不变量。
//
// 表驱动的 reduce(prev, evt, now) → { session, changed, dropped }：
//   · 时间倒退的事件被丢弃（dropped=true），但调用方可以计数；
//   · statusSince 只在 status 改变时更新；
//   · pending > 0 ⇔ status==='waiting_permission'；
//   · done 只由 turn_end 产生，4 秒后由 expire() 降为 idle。

import { SESSION_STATUSES } from './session-model.mjs'

const DONE_HOLD_MS = 4000
const WORKING_IDLE_MS = 90_000
// 钩子确认的「当前回合」最长存活：回合内任何事件都会刷新 turnActiveSince，
// 只有整段静默超过上限才认为 Stop 丢了，避免「工作中」永远不结束。
const TURN_ACTIVE_MAX_MS = 15 * 60_000
// 在途工具（tool_usage.status='running' / hook 注入的 tool_start 还没 tool_end）
// 的保护上限：终端工具单次执行几分钟是常态，running 未清空不算静默，90s 超时
// 不能把它打回空闲再被下一次轮询拉回工作中（状态横跳）。超过上限视为宿主
// 崩溃残留，不再保护。与 zcode 适配器的 RUNNING_TOOL_WINDOW_MS 同口径。
const RUNNING_TOOL_MAX_MS = 10 * 60_000
const PERMISSION_IDLE_MS = 10 * 60_000
const WAITING_INPUT_IDLE_MS = 30 * 60_000
const ERROR_IDLE_MS = 5 * 60_000
const MAX_PENDING = 5

function finite(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function clone(prev) {
  const p = prev && typeof prev === 'object' ? prev : {}
  return {
    ...p,
    turns: { ...(p.turns || { count: 0, current: null, avgDurationMs: null }) },
    tokens: {
      total: null,
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
      ...(p.tokens || {}),
    },
    tools: {
      calls: 0,
      errors: 0,
      running: [],
      ...(p.tools || {}),
      running: Array.isArray(p.tools && p.tools.running) ? p.tools.running.map((x) => ({ ...x })) : [],
    },
    errors: {
      model: 0,
      tool: 0,
      last: null,
      ...(p.errors || {}),
    },
    pending: Array.isArray(p.pending) ? p.pending.map((x) => ({ ...x })) : [],
  }
}

function setStatus(next, status, at) {
  if (!SESSION_STATUSES.includes(status)) return false
  if (next.status === status) return false
  next.status = status
  next.statusSince = at
  // 5 分钟「已完成」展示窗口：进入 done 记时刻；回到任何活跃状态立刻清掉，
  // 新回合不能被上一轮的 doneAt 盖住。
  if (status === 'done') next.doneAt = at
  else if (status === 'working' || status === 'waiting_permission' || status === 'waiting_input' || status === 'error') {
    next.doneAt = 0
  }
  return true
}

// 回合内事件刷新活跃时间；turn_end / session_end 负责清 turnActive。
function touchTurn(next, at) {
  if (next.turnActive === true) next.turnActiveSince = at
}

function addTokens(next, usage) {
  if (!usage || typeof usage !== 'object') return
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
  let delta = 0
  for (const k of keys) {
    const n = finite(usage[k], 0)
    if (n <= 0) continue
    next.tokens[k] = (Number(next.tokens[k]) || 0) + n
    delta += n
  }
  const total = finite(usage.total, 0)
  if (total > 0) next.tokens.total = (Number(next.tokens.total) || 0) + total
  else if (delta > 0) next.tokens.total = (Number(next.tokens.total) || 0) + delta
}

export function reduce(prev, evt, now = Date.now()) {
  const e = evt && typeof evt === 'object' ? evt : {}
  const at = finite(e.at, now)
  const p = prev && typeof prev === 'object' ? prev : null
  if (p && Number.isFinite(Number(p.updatedAt)) && at < Number(p.updatedAt)) {
    return { session: p, changed: false, dropped: true }
  }
  const next = clone(p)
  let changed = !p
  const before = JSON.stringify({ s: next.status, u: next.updatedAt, t: next.tokens, tl: next.tools, e: next.errors })

  if (!Number.isFinite(Number(next.updatedAt)) || at >= Number(next.updatedAt)) next.updatedAt = at
  if (e.title && e.title !== next.title) {
    next.title = String(e.title).slice(0, 200)
    changed = true
  }
  if (e.cwd && e.cwd !== next.cwd) next.cwd = String(e.cwd).slice(0, 400)
  if (e.model && e.model !== next.model) next.model = String(e.model).slice(0, 80)
  if (e.provider && e.provider !== next.provider) next.provider = String(e.provider).slice(0, 80)

  const type = String(e.event || e.type || '')
  switch (type) {
    case 'session_start':
      if (!next.startedAt) next.startedAt = at
      if (next.status === 'unknown' || next.status === 'idle') setStatus(next, 'working', at)
      break

    case 'turn_start': {
      next.startedAt = next.startedAt || at
      next.turns.count = (Number(next.turns.count) || 0) + 1
      next.turns.current = { id: String(e.turnId || '').slice(0, 80), index: next.turns.count, startedAt: at }
      next.endedAt = null
      // 钩子确认的回合边界：turn_end 之前即使库里出现 completed 行也不显示
      // 空闲/已完成（工具结束到首字之间的空档）。
      next.turnActive = true
      next.turnActiveSince = at
      setStatus(next, 'working', at)
      break
    }

    case 'tool_start': {
      const name = String(e.tool || '').slice(0, 80)
      if (name && next.tools.running.length < 20) {
        next.tools.running.push({ name, since: at })
      }
      next.tools.calls = (Number(next.tools.calls) || 0) + 1
      touchTurn(next, at)
      setStatus(next, 'working', at)
      break
    }

    case 'tool_end': {
      touchTurn(next, at)
      const name = String(e.tool || '').slice(0, 80)
      const idx = name ? next.tools.running.findIndex((x) => x.name === name) : -1
      if (idx >= 0) next.tools.running.splice(idx, 1)
      if (e.error) {
        next.tools.errors = (Number(next.tools.errors) || 0) + 1
        next.errors.tool = (Number(next.errors.tool) || 0) + 1
        next.errors.last = { at, kind: 'tool', message: String(e.message || '工具调用失败').slice(0, 200) }
        setStatus(next, 'error', at)
      } else {
        dropPendingBefore(next, at)
        if (next.status === 'waiting_permission' && next.pending.length === 0) {
          setStatus(next, 'working', at)
        }
      }
      break
    }

    case 'permission_request': {
      touchTurn(next, at)
      const id = String(e.requestId || '').slice(0, 80)
      const ttl = at + Math.min(30000, Math.max(1000, finite(e.timeoutMs, 15000)))
      if (id) {
        const existing = next.pending.find((x) => x.id === id)
        if (existing) {
          // 重复请求只刷新截止时间，不叠加 pending。
          existing.expiresAt = Math.max(Number(existing.expiresAt) || 0, ttl)
          existing.state = 'pending'
        } else if (next.pending.length < MAX_PENDING) {
          next.pending.push({
            id,
            kind: 'permission',
            agentId: String(e.agentId || next.agentId || ''),
            sessionKey: String(next.key || ''),
            tool: String(e.tool || '').slice(0, 80),
            preview: String(e.preview || '').slice(0, 400),
            risk: e.risk === 'high' ? 'high' : 'normal',
            createdAt: at,
            expiresAt: ttl,
            state: 'pending',
          })
        }
      }
      setStatus(next, 'waiting_permission', at)
      break
    }

    case 'permission_resolved': {
      // 等待确认也是回合内事件：用户处理完权限后回合会继续跑，必须续命，
      // 否则长回合在第 15 分钟被误判空闲（D056）。
      touchTurn(next, at)
      const id = String(e.requestId || '')
      const idx = id ? next.pending.findIndex((x) => x.id === id) : 0
      if (idx >= 0 && next.pending[idx]) {
        next.pending[idx].state = e.decision === 'deny' ? 'denied' : e.decision === 'timeout' ? 'timeout' : 'allowed'
        next.pending.splice(idx, 1)
      }
      if (next.pending.length === 0 && next.status === 'waiting_permission') setStatus(next, 'working', at)
      break
    }

    case 'waiting_input':
      setStatus(next, 'waiting_input', at)
      break

    case 'model_error':
    case 'tool_error':
    case 'error': {
      if (type === 'model_error') next.errors.model = (Number(next.errors.model) || 0) + 1
      else if (type === 'tool_error') next.errors.tool = (Number(next.errors.tool) || 0) + 1
      next.errors.last = {
        at,
        kind: type === 'model_error' ? 'model' : 'tool',
        message: String(e.message || '执行失败').slice(0, 200),
      }
      setStatus(next, 'error', at)
      break
    }

    case 'turn_end': {
      dropPendingBefore(next, at)
      next.turnActive = false
      const duration = next.turns.current && next.turns.current.startedAt ? at - next.turns.current.startedAt : null
      next.turns.current = null
      if (duration !== null && duration >= 0) {
        const prior = Number(next.turns.avgDurationMs)
        next.turns.avgDurationMs = Number.isFinite(prior) && prior > 0
          ? Math.round((prior + duration) / 2)
          : Math.round(duration)
      }
      if (e.error) {
        next.errors.last = { at, kind: 'model', message: String(e.message || '会话结束于错误').slice(0, 200) }
        setStatus(next, 'error', at)
      } else {
        next.endedAt = at
        setStatus(next, 'done', at)
      }
      break
    }

    case 'usage':
      touchTurn(next, at)
      dropPendingBefore(next, at)
      addTokens(next, e.usage)
      if (e.cost && Number.isFinite(Number(e.cost.amount))) {
        next.cost = {
          amount: Math.round(Number(e.cost.amount) * 10000) / 10000,
          currency: /^[A-Z]{3,8}$/.test(String(e.cost.currency || '')) ? String(e.cost.currency) : 'CNY',
          unit: 'money',
        }
      }
      if (next.status === 'done') setStatus(next, 'working', at)
      break

    case 'session_end':
      dropPendingBefore(next, at)
      next.turnActive = false
      next.endedAt = at
      setStatus(next, 'done', at)
      break

    default:
      break
  }

  // 不变量：pending > 0 必须是等待确认；pending 空时不能停在 waiting_permission。
  if (next.pending.length > 0 && next.status !== 'waiting_permission') {
    setStatus(next, 'waiting_permission', at)
  } else if (next.pending.length === 0 && next.status === 'waiting_permission') {
    setStatus(next, 'working', at)
  }

  const after = JSON.stringify({ s: next.status, u: next.updatedAt, t: next.tokens, tl: next.tools, e: next.errors })
  return { session: next, changed: changed || before !== after, dropped: false }
}

// 这个 pending 是否已经过了宿主 fail-open 截止时间。
function pendingExpired(p, now) {
  const exp = Number(p && p.expiresAt)
  return Number.isFinite(exp) && exp > 0 && exp <= now
}

function pendingOf(raw) {
  return Array.isArray(raw) ? raw.filter((x) => x && typeof x === 'object').map((x) => ({ ...x })) : []
}

// 宿主已经产生更晚的明确事件（回合结束 / 会话结束 / 用量 / 工具完成），
// 早于该事件的 pending 不可能还在等待，直接清掉。
function dropPendingBefore(next, at) {
  const before = next.pending.length
  next.pending = next.pending.filter((p) => !(Number(p.createdAt) < Number(at)))
  return next.pending.length !== before
}

// 会话是否还有在途工具（10 分钟内的 running 行）：在途工具是在飞证据，
// 不算静默。
function hasLiveRunningTool(s, now) {
  const list = s && s.tools && Array.isArray(s.tools.running) ? s.tools.running : []
  return list.some((t) => t && now - (Number(t.since) || 0) < RUNNING_TOOL_MAX_MS)
}

// 超时降级：done 4s、working 90s（在途 running 工具在 10 分钟内不算静默）、
// waiting_permission 10min、waiting_input 30min、error 5min。
// waiting_permission 先按每条 pending 自己的 expiresAt 清理：宿主已经处理完但没有
// resolution 事件时，不能靠 10 分钟长挂。
export function expire(prev, now = Date.now()) {
  const s = prev && typeof prev === 'object' ? prev : null
  if (!s || !SESSION_STATUSES.includes(s.status)) return { session: s, changed: false }
  const sinceStatus = now - (Number(s.statusSince) || 0)
  const sinceUpdate = now - (Number(s.updatedAt) || 0)
  const beforePending = Array.isArray(s.pending) ? s.pending : []
  const livePending = pendingOf(beforePending).filter((p) => !pendingExpired(p, now))
  const next = { ...s, tools: { ...s.tools }, pending: livePending }
  let changed = livePending.length !== beforePending.length

  // Stop 丢失兜底：turnActive 只由回合内事件续命，整段静默超过上限就放开，
  // 不让「工作中」永远不结束。
  if (next.turnActive === true && now - (Number(next.turnActiveSince) || Number(next.statusSince) || now) > TURN_ACTIVE_MAX_MS) {
    next.turnActive = false
    next.turnActiveSince = 0
    changed = true
  }

  if (livePending.length === 0 && s.status === 'waiting_permission') {
    // 没有活着的 pending 就不能再显示「等待确认」：刚结束的回合保持 done 4s，
    // 否则回落 idle，而不是再等 10 分钟。
    const endedAt = Number(s.endedAt) || 0
    next.status = endedAt > 0 && now - endedAt < DONE_HOLD_MS ? 'done' : 'idle'
    next.statusSince = now
    changed = true
  } else if (next.turnActive === true && (s.status === 'idle' || s.status === 'done')) {
    // 钩子说回合还在跑：库里的 idle/done 快照不能把它打下去。
    next.status = 'working'
    next.statusSince = now
    next.doneAt = 0
    changed = true
  } else if (s.status === 'done' && sinceStatus >= DONE_HOLD_MS) {
    next.status = 'idle'
    next.statusSince = now
    changed = true
  } else if (s.status === 'working' && sinceUpdate >= WORKING_IDLE_MS && !hasLiveRunningTool(s, now) && next.turnActive !== true) {
    next.status = 'idle'
    next.statusSince = now
    changed = true
  } else if (s.status === 'waiting_permission' && sinceStatus >= PERMISSION_IDLE_MS) {
    next.status = 'idle'
    next.statusSince = now
    next.pending = []
    changed = true
  } else if (s.status === 'waiting_input' && sinceStatus >= WAITING_INPUT_IDLE_MS) {
    next.status = 'idle'
    next.statusSince = now
    changed = true
  } else if (s.status === 'error' && sinceStatus >= ERROR_IDLE_MS) {
    next.status = 'idle'
    next.statusSince = now
    changed = true
  }
  return { session: changed ? next : s, changed }
}

// 适配器轮询结果合入内存表：适配器有更新的 updatedAt 才覆盖状态；
// token/工具数取较大值（适配器通常更完整），避免轮询把注入的实时数据打回去。
//
// working 滞回（问题 6）：按静默推断的 idle 快照（statusSource='inferred'）
// 在距上次宿主证据 WORKING_IDLE_MS 内不降级「工作中」；回合结束证据不受宽限。
//
// pending 保护（问题 11）：只有「仍然活着」的 pending 才能把状态钉在
// waiting_permission。以下任一情况都清除 pending 并采用适配器状态：
//   · pending 已过 expiresAt；
//   · 适配器给出明确状态（done/idle/working/error/waiting_input）且
//     宿主证据时间晚于 pending.createdAt（宿主已经处理完，只是没发 resolution 事件）。
// 证据时间默认取 incoming.updatedAt；调用方可用 opts.evidenceAt 覆盖成真实
// 宿主时间（ZCode 的 updatedAt 可能被补成 now，不能当作证据）。
// 适配器仍报 unknown / waiting_permission，或时间没有推进时，保持等待确认。

// running 取两侧并集（同名取较新 since）：适配器轮询窗口内的 running 行与
// 事件注入的 tool_start 都是在途证据；清空由适配器窗口 / expire 的
// RUNNING_TOOL_MAX_MS 上限兜底，不会永久钉住。
function mergeRunning(a, b) {
  const out = (Array.isArray(a) ? a : []).filter((x) => x && x.name).map((x) => ({ ...x }))
  for (const x of Array.isArray(b) ? b : []) {
    if (!x || !x.name) continue
    const hit = out.find((y) => y.name === x.name)
    if (!hit) out.push({ ...x })
    else if (Number(x.since) > Number(hit.since)) hit.since = x.since
  }
  return out.slice(0, 20)
}

export function mergeSnapshot(prev, incoming, now = Date.now(), opts = {}) {
  if (!prev) return { session: incoming, changed: true }
  if (!incoming) return { session: prev, changed: false }
  if (Number(incoming.updatedAt) < Number(prev.updatedAt)) return { session: prev, changed: false }
  const next = {
    ...prev,
    ...incoming,
    turns: { ...prev.turns, ...incoming.turns },
    tokens: { ...prev.tokens },
    tools: { ...prev.tools },
    errors: { ...prev.errors, ...incoming.errors },
    pending: [],
    provenance: incoming.provenance || prev.provenance,
  }
  for (const k of ['total', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
    const a = prev.tokens && prev.tokens[k]
    const b = incoming.tokens && incoming.tokens[k]
    const an = typeof a === 'number' && Number.isFinite(a)
    const bn = typeof b === 'number' && Number.isFinite(b)
    next.tokens[k] = an && bn ? Math.max(a, b) : bn ? b : an ? a : null
  }
  next.tools.calls = Math.max(Number(prev.tools && prev.tools.calls) || 0, Number(incoming.tools && incoming.tools.calls) || 0)
  next.tools.errors = Math.max(Number(prev.tools && prev.tools.errors) || 0, Number(incoming.tools && incoming.tools.errors) || 0)
  next.tools.running = mergeRunning(prev.tools && prev.tools.running, incoming.tools && incoming.tools.running)

  // 回合活跃标记只由钩子维护，适配器快照不认识它：只有库里给出更晚的
  // 「回合结束」证据才清掉。completed 记在 done，手动停止记在 cancelled
  // （适配器报 idle + endedAt），两种都必须清，否则用户按停止后胶囊会一直
  // 显示工作中直到 15 分钟上限。
  const dbEndedAt = Number(incoming.endedAt) || 0
  const dbTurnEnded =
    String(incoming.statusSource || '') === 'db' &&
    dbEndedAt > 0 &&
    dbEndedAt >= Number(prev.turnActiveSince || 0)
  const confirmedEnd =
    dbTurnEnded ||
    (incoming.status === 'done' &&
      String(incoming.statusSource || '') === 'db' &&
      Number(incoming.updatedAt) >= Number(prev.turnActiveSince || 0))
  next.turnActive = incoming.turnActive === true || (prev.turnActive === true && !confirmedEnd)
  next.turnActiveSince = next.turnActive
    ? Math.max(Number(prev.turnActiveSince) || 0, Number(incoming.turnActiveSince) || 0)
    : 0
  // workflowBusy 以适配器为准（它查 dwf_run/workflow_run）；适配器没给字段时保留旧值。
  next.workflowBusy =
    incoming.workflowBusy === true || (incoming.workflowBusy === undefined && prev.workflowBusy === true)
  next.workflowBusySince = next.workflowBusy
    ? Math.max(Number(prev.workflowBusySince) || 0, Number(incoming.workflowBusySince) || 0)
    : 0

  // doneAt：活跃状态清零；done 用本次快照的时间；idle 保留（5 分钟窗口）。
  const incomingActive = ['working', 'waiting_permission', 'waiting_input', 'error'].includes(next.status)
  if (incomingActive) next.doneAt = 0
  else if (next.status === 'done') next.doneAt = Number(incoming.doneAt) || Number(incoming.statusSince) || now
  else next.doneAt = Number(incoming.doneAt) || Number(prev.doneAt) || 0

  // 滞回（问题 6「状态横跳」）：适配器按静默推断的 idle（statusSource='inferred'，
  // 没有回合结束证据）不能立刻把「工作中」打回空闲——思考/工具切换的间隙没有
  // 新库行是常态。保持 working 直到距上次宿主证据超过 WORKING_IDLE_MS（与
  // expire 同口径）；带回合结束证据的快照（statusSource='db' 等）不受宽限。
  // 下面的 pending 规则仍在其后生效：等待确认优先于滞回。
  const holdWorking =
    prev.status === 'working' &&
    incoming.status === 'idle' &&
    String(incoming.statusSource || '') === 'inferred' &&
    now - Number(prev.updatedAt) < WORKING_IDLE_MS
  if (holdWorking) {
    next.status = 'working'
    next.statusSource = prev.statusSource
    next.statusSince = prev.statusSince
  }

  // 钩子说回合仍在进行 / 父会话还有 workflow 在跑：空闲/已完成都不能成立。
  if (next.turnActive === true || next.workflowBusy === true) {
    if (next.status !== 'error') {
      next.status = 'working'
      next.statusSource = prev.statusSource || next.statusSource
      next.statusSince = prev.statusSince || next.statusSince
      next.doneAt = 0
    }
  }

  const prevPending = pendingOf(prev.pending).filter((p) => !pendingExpired(p, now))
  const incomingPending = pendingOf(incoming.pending).filter((p) => !pendingExpired(p, now))
  let pending = incomingPending.length ? incomingPending : prevPending
  // 宿主明确处理完毕（或已进入别的状态）且时间推进过 pending 创建时间 → 清掉。
  const explicit = ['done', 'idle', 'working', 'error', 'waiting_input'].includes(incoming.status)
  const newestCreatedAt = pending.reduce((m, p) => Math.max(m, Number(p.createdAt) || 0), 0)
  const evidenceAt =
    opts && opts.evidenceAt !== undefined && Number.isFinite(Number(opts.evidenceAt))
      ? Number(opts.evidenceAt)
      : Number(incoming.updatedAt)
  const advanced = evidenceAt > newestCreatedAt
  if (pending.length > 0 && explicit && advanced) pending = []

  next.pending = pending.map((x) => ({ ...x }))
  if (pending.length > 0) {
    // 仍在等待确认：不能被适配器的空闲/未知状态覆盖。
    if (next.status !== 'waiting_permission') {
      next.status = 'waiting_permission'
      next.statusSince = prev.statusSince || now
    } else {
      next.statusSince = prev.statusSince || incoming.statusSince || now
    }
  }
  const changed = JSON.stringify({ ...next, key: undefined }) !== JSON.stringify({ ...prev, key: undefined })
  return { session: next, changed }
}

export const LIVE_TIMEOUTS = {
  DONE_HOLD_MS,
  WORKING_IDLE_MS,
  TURN_ACTIVE_MAX_MS,
  RUNNING_TOOL_MAX_MS,
  PERMISSION_IDLE_MS,
  WAITING_INPUT_IDLE_MS,
  ERROR_IDLE_MS,
  MAX_PENDING,
}
