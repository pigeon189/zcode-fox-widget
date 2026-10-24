// DeepSeek Harness 会话层（D034）：多帧 zstd 会话日志 → 统一 Session。
//
// 事件（dsh 0.2.0-rc.2 实测）：
//   session / turn/start / turn/end / assistant/message / tool/call / tool/result
// 日志按文件分会话（子 agent 用 delegationDepth/origin 标记）。这里复用
// sessions.mjs 的逐帧解码，按事件尾部推断状态：
//   · turn/start 后无 turn/end → working；
//   · turn/end.reason.kind==='completed' → done（4s 后 idle）；
//   · tool/result.error != null → 工具错误；
//   · 无新事件 90s → idle。

import fs from 'node:fs'
import path from 'node:path'
import { costOfUsage } from '../../engines/pricing.mjs'
import { withCostProv } from '../../daemon/src/cost-prov.mjs'
import { decodeZstdFrames, defaultSessionsDir } from './sessions.mjs'
import { normalizeSession, summarizeSession, compareSessionToCursor, compareSessions, cursorOf, parseCursor } from '../../shared/session-model.mjs'
import { prov, unavailable } from '../../shared/provenance.mjs'

const MAX_FILES = 160
const MAX_BYTES = 64 * 1024 * 1024
const RECENT_MS = 90_000
const DONE_HOLD_MS = 4000
const cache = new Map()

export function _resetDshLiveCache() {
  cache.clear()
}

function walk(dir, out, depth = 0) {
  if (depth > 6) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      walk(p, out, depth + 1)
      continue
    }
    if (!/^session.*\.jsonl(\.zstd)?$/i.test(e.name)) continue
    try {
      const st = fs.statSync(p)
      out.push({ file: p, size: st.size, mtimeMs: st.mtimeMs })
    } catch (err) {}
  }
}

function readText(file, size) {
  if (size > MAX_BYTES) return ''
  let buf = null
  try {
    buf = fs.readFileSync(file)
  } catch (err) {
    return ''
  }
  if (file.toLowerCase().endsWith('.zstd')) {
    const d = decodeZstdFrames(buf, MAX_BYTES)
    return d.ok ? d.text : ''
  }
  return buf.toString('utf8')
}

// 会话聚合只依赖文件内容，与「现在」无关；按文件 size/mtime 缓存，避免
// LiveTracker 每 2 秒对每条 assistant/message 重新做一次定价。
function aggregateOf(events, meta) {
  const tokens = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  let costAmount = 0
  let costCurrency = 'CNY'
  let costProv = null
  let turns = 0
  let calls = 0
  let errors = 0
  let model = meta.model
  let provider = meta.provider
  let firstAt = 0
  let lastAt = 0
  for (const e of events) {
    if (e.type === 'turn/start') turns += 1
    if (e.type === 'tool/call') calls += 1
    if (e.type === 'tool/result' && e.data.error != null) errors += 1
    if (!firstAt || e.time < firstAt) firstAt = e.time
    if (e.time > lastAt) lastAt = e.time
    if (e.type !== 'assistant/message') continue
    const u = e.data.usage
    if (!u || typeof u !== 'object') continue
    const msg = e.data.message && typeof e.data.message === 'object' ? e.data.message : {}
    const src = msg.source && typeof msg.source === 'object' ? msg.source : {}
    if (src.model) model = String(src.model)
    if (src.provider) provider = String(src.provider)
    const input = Number(u.inputTokens) || 0
    const cacheRead = Number(u.cacheReadTokens) || 0
    const output = Number(u.outputTokens) || 0
    const total = Number(u.totalTokens) || input + cacheRead + output
    const c = withCostProv(
      costOfUsage(
        src.model || model,
        {
          input_tokens: Math.max(input, total - output),
          output_tokens: output,
          reasoning_tokens: Number(u.reasoningTokens) || 0,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: 0,
          computed_total_tokens: total,
        },
        e.time,
        src.provider || provider
      ),
      { asOf: e.time }
    )
    if (!c) continue
    tokens.total += Number(c.tokens) || 0
    tokens.input += input
    tokens.output += output
    tokens.cacheRead += cacheRead
    tokens.reasoning += Number(u.reasoningTokens) || 0
    costAmount += Number(c.amount) || 0
    costCurrency = c.currency || costCurrency
    costProv = costProv || c.prov
  }
  return { tokens, costAmount, costCurrency, costProv, turns, calls, errors, model, provider, firstAt, lastAt }
}

function parseFile(file) {
  let st = null
  try {
    st = fs.statSync(file)
  } catch (err) {
    return null
  }
  const key = file + '|' + st.size + '|' + st.mtimeMs
  const hit = cache.get(key)
  if (hit) return hit
  const text = readText(file, st.size)
  if (!text) {
    const empty = {
      sessionId: path.basename(file).replace(/\.jsonl(\.zstd)?$/i, ''),
      events: [],
      meta: {},
      agg: aggregateOf([], {}),
    }
    cache.set(key, empty)
    return empty
  }
  let meta = { sessionId: path.basename(file).replace(/\.jsonl(\.zstd)?$/i, ''), title: '', cwd: '', model: '', provider: '', delegationDepth: 0, origin: '' }
  const events = []
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.charCodeAt(0) !== 123) continue
    let o = null
    try {
      o = JSON.parse(line)
    } catch (err) {
      continue
    }
    if (!o || typeof o !== 'object') continue
    const time = Number(o.time)
    if (!Number.isFinite(time) || time > Date.now() + 5 * 60_000) continue
    const data = o.data && typeof o.data === 'object' ? o.data : {}
    if (o.type === 'session') {
      meta = {
        sessionId: String(o.id || meta.sessionId),
        title: String(o.title || data.title || meta.title || ''),
        cwd: String(o.cwd || data.cwd || meta.cwd || ''),
        model: String(o.model || data.model || meta.model || ''),
        provider: String(o.provider || data.provider || meta.provider || ''),
        delegationDepth: Number(o.delegationDepth) || 0,
        origin: String(o.origin || ''),
      }
      continue
    }
    events.push({ type: String(o.type || ''), time, data, raw: o })
  }
  const value = { ...meta, events, agg: aggregateOf(events, meta) }
  cache.set(key, value)
  // 最多同时保留 MAX_FILES 个会话；32 会让 160 个文件每轮都被淘汰重解析。
  if (cache.size > MAX_FILES + 16) cache.delete(cache.keys().next().value)
  return value
}

function collect(opts = {}) {
  const dir = opts.sessionsDir || defaultSessionsDir(opts.dshHome || process.env.DSH_HOME || undefined)
  const files = []
  walk(dir, files)
  if (!files.length) return { ok: false, reason: 'sessions-missing', sessions: [] }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const sessions = []
  for (const f of files.slice(0, MAX_FILES)) {
    const parsed = parseFile(f.file)
    if (!parsed) continue
    sessions.push({ ...parsed, file: f.file, mtimeMs: f.mtimeMs })
  }
  return { ok: true, sessions }
}

function statusOf(session, now) {
  let openTurn = null
  let lastTurnDone = null
  let lastEvent = null
  const running = new Map()
  const calls = new Map()
  let lastError = null
  for (const e of session.events) {
    lastEvent = e
    if (e.type === 'turn/start') openTurn = { turn: Number(e.data.turn) || 0, at: e.time }
    else if (e.type === 'turn/end') {
      openTurn = null
      lastTurnDone = { at: e.time, ok: String((e.data.reason && e.data.reason.kind) || 'completed') === 'completed' }
    } else if (e.type === 'tool/call') {
      const name = String(e.data.toolName || e.data.name || e.data.tool || 'unknown')
      const id = String(e.data.callId || e.data.id || name + '@' + e.time)
      calls.set(id, { name, at: e.time })
      running.set(name, { name, since: e.time })
    } else if (e.type === 'tool/result') {
      const id = String(e.data.callId || e.data.id || '')
      const c = calls.get(id)
      if (c) {
        calls.delete(id)
        running.delete(c.name)
      } else {
        const name = String(e.data.toolName || e.data.name || '')
        if (name) running.delete(name)
      }
      if (e.data.error != null) lastError = { at: e.time, message: '工具调用失败' }
    }
  }
  if (openTurn) return { status: 'working', running: [...running.values()], error: lastError }
  if (lastTurnDone) {
    if (now - lastTurnDone.at < DONE_HOLD_MS) return { status: 'done', running: [], error: lastError }
  }
  if (lastError && now - lastError.at < 5 * 60_000) return { status: 'error', running: [], error: lastError }
  if (lastEvent && now - lastEvent.time < RECENT_MS) return { status: 'working', running: [...running.values()], error: lastError }
  return { status: 'idle', running: [], error: lastError }
}

function buildSessions(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const coll = collect(opts)
  if (!coll.ok) return { ok: false, reason: coll.reason, items: [] }
  const items = []
  for (const s of coll.sessions) {
    const a = s.agg || aggregateOf(s.events, s)
    const tokens = { ...a.tokens }
    const costAmount = a.costAmount
    const costCurrency = a.costCurrency
    const costProv = a.costProv
    const turns = a.turns
    const calls = a.calls
    const errors = a.errors
    const model = a.model
    const provider = a.provider
    const firstAt = a.firstAt
    const lastAt = a.lastAt
    const status = statusOf(s, now)
    // 日志最后事件时间或文件 mtime 是真实宿主时间；都没有时 updatedAt 才补 now，
    // lastHostAt 保持 null（轮询不能拿 now 当证据清 pending）。
    const hostAt = Math.max(lastAt, s.mtimeMs || 0) || null
    const updatedAt = hostAt || now
    items.push(
      normalizeSession(
        {
          agentId: 'dsh',
          sessionId: s.sessionId,
          title: s.title || path.basename(s.file).replace(/\.jsonl(\.zstd)?$/i, ''),
          cwd: s.cwd,
          model,
          provider,
          status: status.status,
          statusSource: 'log',
          startedAt: firstAt || null,
          updatedAt,
          lastHostAt: hostAt,
          endedAt: status.status === 'done' ? lastAt : null,
          turns: {
            count: turns,
            current: status.status === 'working' ? { id: '', index: null, startedAt: lastAt || now } : null,
            avgDurationMs: null,
          },
          tokens,
          cost: costAmount > 0 ? { amount: Math.round(costAmount * 10000) / 10000, currency: costCurrency, unit: 'money' } : null,
          tools: { calls, errors, running: status.running },
          errors: {
            model: 0,
            tool: errors,
            last: status.error ? { at: status.error.at, kind: 'tool', message: status.error.message } : null,
          },
          provenance: {
            tokens: tokens.total ? prov('exact', 'local-log', 'dsh:sessions', { asOf: now }) : unavailable('no-data', 'dsh:sessions', 'local-log'),
            cost: costProv || unavailable('no-data', 'dsh:sessions', 'local-log'),
            status: prov('estimated', 'local-log', 'dsh:sessions', { asOf: now, note: '按会话日志尾部事件推断' }),
            tools: prov('exact', 'local-log', 'dsh:sessions#tool', { asOf: now }),
          },
        },
        { now }
      )
    )
  }
  return { ok: true, items }
}

function inRange(s, range, now) {
  if (!range || range === 'all') return true
  const day = 86400000
  const since = range === 'today' ? new Date(now).setHours(0, 0, 0, 0) : range === '7d' ? now - 7 * day : range === '30d' ? now - 30 * day : 0
  return Number(s.updatedAt) >= since
}

export async function getSessions(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const built = buildSessions({ ...opts, now })
  if (!built.ok) return { ok: true, supported: false, reason: built.reason, items: [], nextCursor: null }
  let items = built.items.filter((s) => inRange(s, opts.range, now))
  if (opts.status) items = items.filter((s) => s.status === opts.status)
  if (opts.q) {
    const q = String(opts.q).toLowerCase()
    items = items.filter((s) => (s.title + ' ' + s.cwd + ' ' + s.model).toLowerCase().includes(q))
  }
  const sort = ['updated', 'tokens', 'cost', 'duration'].includes(opts.sort) ? opts.sort : 'updated'
  items.sort((a, b) => compareSessions(a, b, sort))
  // keyset 游标：锚点会话的 updatedAt 可能被内存快照改写，不能要求精确相等。
  const cur = opts.cursor ? parseCursor(opts.cursor) : null
  const after = cur ? items.filter((s) => compareSessionToCursor(s, sort, cur) > 0) : items
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50))
  const page = after.slice(0, limit)
  return {
    ok: true,
    supported: true,
    items: page,
    nextCursor: after.length > limit && page.length ? cursorOf(page[page.length - 1], sort) : null,
    keys: items.map((s) => s.key),
    total: items.length,
  }
}

export async function getLiveStatus(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const since = Number(opts.sinceMs) || now - 10 * 60_000
  const r = await getSessions({ ...opts, range: 'all', limit: 200 })
  if (!r.supported) return { ok: true, supported: false, reason: r.reason, items: [] }
  return {
    ok: true,
    supported: true,
    items: r.items.filter((s) => Number(s.updatedAt) >= since || s.status === 'working').map(summarizeSession),
  }
}

export async function getSessionDetail(sessionId, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const coll = collect(opts)
  const s = coll.ok ? coll.sessions.find((x) => x.sessionId === String(sessionId)) : null
  if (!s) return { ok: true, supported: coll.ok, reason: coll.reason, session: null, turns: [], tools: [], models: [] }
  const built = buildSessions({ ...opts, now })
  const session = built.items.find((x) => x.sessionId === String(sessionId)) || null
  const turns = []
  const turnMap = new Map()
  const tools = new Map()
  const calls = new Map()
  for (const e of s.events) {
    if (e.type === 'turn/start') {
      const turn = Number(e.data.turn) || turns.length + 1
      turnMap.set(turn, { id: String(turn), index: turn, startedAt: e.time, endedAt: null, tokens: 0, status: 'running', model: '' })
    } else if (e.type === 'turn/end') {
      const turn = Number(e.data.turn) || turns.length
      const t = turnMap.get(turn)
      if (t) {
        t.endedAt = e.time
        t.status = String((e.data.reason && e.data.reason.kind) || 'completed') === 'completed' ? 'completed' : 'error'
      }
    } else if (e.type === 'assistant/message') {
      const turn = Number(e.data.turn) || 1
      const t = turnMap.get(turn) || { id: String(turn), index: turn, startedAt: e.time, endedAt: e.time, tokens: 0, status: 'completed', model: '' }
      const u = e.data.usage || {}
      t.tokens += Number(u.totalTokens) || 0
      const msg = e.data.message && e.data.message.source ? e.data.message.source : {}
      t.model = String(msg.model || t.model || '')
      turnMap.set(turn, t)
    } else if (e.type === 'tool/call') {
      const name = String(e.data.toolName || e.data.name || e.data.tool || 'unknown')
      calls.set(String(e.data.callId || e.data.id || name + '@' + e.time), { name, at: e.time })
      const t = tools.get(name) || { name, calls: 0, errors: 0, durations: [], lastAt: 0 }
      t.calls += 1
      t.lastAt = Math.max(t.lastAt, e.time)
      tools.set(name, t)
    } else if (e.type === 'tool/result') {
      const id = String(e.data.callId || e.data.id || '')
      const c = calls.get(id)
      if (c) {
        const t = tools.get(c.name)
        if (t) {
          if (e.data.error != null) t.errors += 1
          t.durations.push(Math.max(0, e.time - c.at))
        }
      }
    }
  }
  for (const t of [...turnMap.values()].sort((a, b) => a.index - b.index)) {
    turns.push({
      id: t.id,
      index: t.index,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      durationMs: t.endedAt ? Math.max(0, t.endedAt - t.startedAt) : null,
      tokens: t.tokens,
      cost: null,
      status: t.status,
      model: t.model,
    })
  }
  return {
    ok: true,
    supported: true,
    session,
    turns,
    tools: [...tools.values()].map((t) => ({
      name: t.name,
      calls: t.calls,
      errors: t.errors,
      avgDurationMs: t.durations.length ? Math.round(t.durations.reduce((a, b) => a + b, 0) / t.durations.length) : null,
      lastAt: t.lastAt,
    })),
    models: [],
  }
}

export async function readUsageRows(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const coll = collect(opts)
  if (!coll.ok) return { ok: false, reason: coll.reason, rows: [] }
  const since = Number(opts.since) || 0
  const until = Number(opts.until) || now
  const tm = Number(opts.timeMinutes)
  const timeMinutes = Number.isInteger(tm) && tm >= 0 && tm < 1440 ? tm : null
  const rows = []
  for (const s of coll.sessions) {
    for (const e of s.events) {
      if (e.type !== 'assistant/message' || e.time < since || e.time > until) continue
      if (timeMinutes != null) {
        const d = new Date(e.time)
        if (d.getHours() * 60 + d.getMinutes() !== timeMinutes) continue
      }
      const u = e.data.usage
      if (!u || typeof u !== 'object') continue
      const msg = e.data.message && e.data.message.source ? e.data.message.source : {}
      const c = withCostProv(
        costOfUsage(
          msg.model || '',
          {
            input_tokens: Number(u.inputTokens) || 0,
            output_tokens: Number(u.outputTokens) || 0,
            reasoning_tokens: Number(u.reasoningTokens) || 0,
            cache_read_input_tokens: Number(u.cacheReadTokens) || 0,
            cache_creation_input_tokens: 0,
            computed_total_tokens: Number(u.totalTokens) || 0,
          },
          e.time,
          msg.provider || ''
        ),
        { asOf: now }
      )
      if (!c) continue
      rows.push({
        agentId: 'dsh',
        sessionId: s.sessionId,
        session: s.sessionId,
        model: String(msg.model || ''),
        vendor: String(msg.provider || c.vendor || ''),
        vendorLabel: c.vendorLabel || '',
        tool: '',
        at: e.time,
        day: dayKey(e.time),
        unit: 'money',
        currency: c.currency || 'CNY',
        amount: Math.round((Number(c.amount) || 0) * 10000) / 10000,
        credits: null,
        tokens: Number(c.tokens) || 0,
        calls: 1,
        errors: 0,
        prov: c.prov,
      })
      if (rows.length >= 200000) return { ok: true, rows, truncated: true }
    }
  }
  return { ok: true, rows, truncated: false }
}

export async function readToolUsageRows(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const coll = collect(opts)
  if (!coll.ok) return { ok: false, reason: coll.reason, rows: [] }
  const since = Number(opts.since) || 0
  const until = Number(opts.until) || now
  const rows = []
  for (const s of coll.sessions) {
    for (const e of s.events) {
      if (e.type !== 'tool/call' || e.time < since || e.time > until) continue
      rows.push({
        agentId: 'dsh',
        sessionId: s.sessionId,
        session: s.sessionId,
        model: '',
        vendor: '',
        tool: String(e.data.toolName || e.data.name || e.data.tool || 'unknown'),
        at: e.time,
        day: dayKey(e.time),
        unit: 'money',
        currency: 'CNY',
        amount: 0,
        credits: null,
        tokens: 0,
        calls: 1,
        errors: 0,
        prov: prov('exact', 'local-log', 'dsh:sessions#tool/call', { asOf: now }),
      })
      if (rows.length >= 200000) return { ok: true, rows, truncated: true }
    }
  }
  return { ok: true, rows, truncated: false }
}

function dayKey(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
