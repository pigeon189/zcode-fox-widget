// WorkBuddy 会话层（D034）：DB 元数据 + transcript 事件。
//
// transcript 是追加写入的 jsonl：每行带 providerData.rawUsage（每次模型调用）或
// function_call / function_call_result（工具）。这里按 sessionId 聚合，并只读
// 最近活跃文件的尾部做实时状态推断：
//   · function_call 没有对应 result → 工具运行中 + working；
//   · 最后一个 result.status 非 completed → error；
//   · 无新事件超过 90s → idle；4s 内刚结束 → done。

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { defaultDbFile, defaultProjectsDir } from './context.mjs'
import { listTranscripts } from './transcripts.mjs'
import { normalizeSession, summarizeSession, compareSessionToCursor, compareSessions, cursorOf, parseCursor } from '../../shared/session-model.mjs'
import { createTailReader } from '../../shared/tail.mjs'
import { createCacheIndex } from '../../shared/cache-index.mjs'
import { DATA_DIR, pluginVersion } from '../../engines/paths.mjs'
import { prov, unavailable } from '../../shared/provenance.mjs'

const require = createRequire(import.meta.url)
let sqliteModule = null
let sqliteProbed = false

function loadSqlite() {
  if (sqliteProbed) return sqliteModule
  sqliteProbed = true
  try {
    sqliteModule = require('node:sqlite')
  } catch (err) {
    sqliteModule = null
  }
  return sqliteModule
}

const MAX_TAIL = 4 * 1024 * 1024
const RECENT_MS = 90_000
const DONE_HOLD_MS = 4000
const connections = new Map()

function dbSessions(file) {
  if (!file || !fs.existsSync(file)) return new Map()
  const sqlite = loadSqlite()
  if (!sqlite) return new Map()
  const hit = connections.get(file)
  let conn = hit
  if (!conn) {
    try {
      const db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 2000 })
      conn = {
        db,
        stmt: db.prepare(
          `SELECT su.session_id AS id, su.used AS used, su.size AS size, su.updated_at AS updatedAt,
             s.title AS title, s.custom_title AS customTitle, s.model AS model, s.updated_at AS sessionUpdated
           FROM session_usage su LEFT JOIN sessions s ON s.id = su.session_id
           WHERE COALESCE(s.deleted_at, 0) = 0`
        ),
      }
      if (connections.size >= 4) {
        const oldest = connections.keys().next().value
        try {
          connections.get(oldest).db.close()
        } catch (err) {}
        connections.delete(oldest)
      }
      connections.set(file, conn)
    } catch (err) {
      return new Map()
    }
  }
  const out = new Map()
  try {
    for (const r of conn.stmt.all()) {
      out.set(String(r.id), {
        id: String(r.id),
        title: String(r.customTitle || r.title || ''),
        model: String(r.model || ''),
        used: Number(r.used) || 0,
        limit: Number(r.size) || null,
        updatedAt: Number(r.updatedAt || r.sessionUpdated) || 0,
      })
    }
  } catch (err) {}
  return out
}

function tsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Date.parse(String(v || ''))
  return Number.isFinite(n) ? n : 0
}

function parseLine(line, fallback) {
  if (!line || line.charCodeAt(0) !== 123) return []
  let o = null
  try {
    o = JSON.parse(line)
  } catch (err) {
    return []
  }
  if (!o || typeof o !== 'object') return []
  const ts = tsOf(o.timestamp)
  if (!ts) return []
  const out = []
  const sessionId = String(o.sessionId || o.session_id || fallback)
  const pd = o.providerData && typeof o.providerData === 'object' ? o.providerData : {}
  const raw = pd.rawUsage && typeof pd.rawUsage === 'object' ? pd.rawUsage : null
  if (raw) {
    out.push({
      kind: 'usage',
      ts,
      sessionId,
      rid: String(pd.conversationRequestId || o.id || '@' + ts),
      model: String(pd.model || pd.requestModelId || pd.requestModelName || o.model || ''),
      input: Number(raw.prompt_tokens) || 0,
      output: Number(raw.completion_tokens) || 0,
      total: Number(raw.total_tokens) || (Number(raw.prompt_tokens) || 0) + (Number(raw.completion_tokens) || 0),
      cacheRead: Number(raw.prompt_cache_hit_tokens) || Number(raw.cached_tokens) || 0,
      cacheWrite: Number(raw.prompt_cache_write_tokens) || 0,
      reasoning: Number(raw.completion_thinking_tokens) || 0,
      credit: Number(raw.credit) || 0,
      cwd: String(o.cwd || pd.cwd || ''),
    })
  }
  if (o.type === 'function_call') {
    out.push({ kind: 'call', ts, sessionId, callId: String(o.callId || o.id || ''), tool: String(o.name || 'unknown'), cwd: String(o.cwd || '') })
  } else if (o.type === 'function_call_result') {
    out.push({ kind: 'result', ts, sessionId, callId: String(o.callId || ''), status: String(o.status || ''), cwd: String(o.cwd || '') })
  }
  return out
}

// 增量尾随：每个 transcript 只读追加部分（20MB 首次全读，之后 1 行 <1ms）。
// 水位 + 已解析事件持久化到 cache/workbuddy-index-v1.json（M6）：daemon 重启
// 后接着读，不用重放整个 transcript。缓存只存可重建状态——删除缓存文件后
// 全量重算的结果必须与带缓存一致（incremental-equivalence 测试守卫）。
//
// 落盘事件上限 4000 条（控制缓存体积）。**事件被截断时水位不可信**：重启后
// 断点续读会让 tokens/credits 静默少计（长 transcript 只重建最后 4000 条），
// 而 provenance 仍标 exact。所以落盘时写 eventsComplete，重启时只有完整事件才
// 恢复水位；不完整/旧版本缓存一律从头完整重读（读取循环到 EOF 才返回，避免
// 「部分事件 + exact」的中间态）。
const tails = new Map()
let cacheIndex = null
const MAX_PERSIST_EVENTS = 4000

function cacheIndexOf() {
  if (!cacheIndex) {
    cacheIndex = createCacheIndex({
      file: path.join(DATA_DIR, 'cache', 'workbuddy-index-v1.json'),
      appVersion: pluginVersion(),
      debounceMs: 2000,
    })
  }
  return cacheIndex
}

export function _resetWorkbuddyCache() {
  if (cacheIndex) cacheIndex.reset()
  cacheIndex = null
}

// 测试用：立即落盘（正常路径靠 2s 去抖 + 进程退出钩子）。
export function _flushWorkbuddyCache() {
  if (cacheIndex) cacheIndex.flushSync()
}

export function _resetWorkbuddyLive() {
  tails.clear()
  fileAggs.clear()
}

function eventsOf(file) {
  try {
    let entry = tails.get(file)
    // 缓存不可信（缺失 / 事件被截断 / 旧版本无 eventsComplete 标记）时必须从头
    // 完整重读；只有「事件完整」的缓存才能恢复水位做增量续读。
    let rebuild = false
    if (!entry) {
      entry = { tail: createTailReader(file, { maxChunk: MAX_TAIL }), events: [] }
      const saved = cacheIndexOf().get('tail:' + file)
      // restore() 只在「水位可信」时返回 true：残行已从水位里排除，恢复后会
      // 重新读那半行；文件被截断/重写（指纹不符）时返回 false，调用方必须
      // 连落盘事件一起丢弃、从头重读，不能拿旧事件拼新文件尾部。
      if (saved && saved.eventsComplete === true && Array.isArray(saved.events) && entry.tail.restore(saved)) {
        entry.events = saved.events
      } else {
        rebuild = true
      }
      if (tails.size > 32) tails.delete(tails.keys().next().value)
      tails.set(file, entry)
    }
    let dirty = false
    for (;;) {
      const p = entry.tail.poll()
      if (!p.ok) return entry.events
      if (p.reset) {
        // 文件被截断/轮转：水位作废，必须重读到 EOF。落盘状态也要跟着清掉，
        // 否则下次启动又会拿旧水位去撞同一份新文件。
        entry.events = []
        rebuild = true
        dirty = true
      }
      if (p.lines.length) {
        const fallback = path.basename(file, '.jsonl')
        for (const line of p.lines) for (const e of parseLine(line, fallback)) entry.events.push(e)
        dirty = true
      }
      // 增量续读只读一拍；重建则一直读到文件末尾，避免在「部分事件」上产出
      // exact 的 tokens/credits。用 readOffset（已读位置）判断 EOF：state.offset
      // 是最后一个完整行之后，停在半行时会小于 size。
      if (!rebuild) break
      const st = entry.tail.state
      if (!st.size || st.readOffset >= st.size) break
    }
    if (dirty) {
      const st = entry.tail.state
      const complete = entry.events.length <= MAX_PERSIST_EVENTS
      cacheIndexOf().set('tail:' + file, {
        // offset 是最后一个完整行之后（不含内存里的残行），重启后不会跳过它。
        offset: st.offset,
        ino: st.ino,
        checkpoint: st.checkpoint,
        // 事件超限只存尾部（控制缓存体积），但标记 eventsComplete=false：
        // 下次启动会全量重读，不会拿截断的事件重建出偏小的数值。
        events: complete ? entry.events : entry.events.slice(-MAX_PERSIST_EVENTS),
        eventsComplete: complete,
      })
      cacheIndexOf().schedule()
    }
    return entry.events
  } catch (err) {
    return []
  }
}

export function collectEvents(opts = {}) {
  const listed = listTranscripts(opts.projectsDir || defaultProjectsDir(opts.env || process.env), 0)
  if (listed.reason) return { ok: false, reason: listed.reason, events: [] }
  const files = listed.files.slice(0, 64)
  const events = []
  for (const f of files) for (const e of eventsOf(f.path)) events.push(e)
  events.sort((a, b) => a.ts - b.ts)
  return { ok: true, events, files: files.length }
}

function statusOf(sessionEvents, now) {
  const calls = new Map()
  const running = []
  let last = null
  let lastError = null
  for (const e of sessionEvents) {
    last = e
    if (e.kind === 'call') {
      calls.set(e.callId, e)
      running.push({ name: e.tool, since: e.ts })
    } else if (e.kind === 'result') {
      const c = calls.get(e.callId)
      if (c) {
        calls.delete(e.callId)
        const idx = running.findIndex((x) => x.name === c.tool)
        if (idx >= 0) running.splice(idx, 1)
      }
      if (e.status && e.status !== 'completed') lastError = { at: e.ts, message: '工具调用失败：' + (c ? c.tool : '') }
    }
  }
  if (running.length) return { status: 'working', running, error: lastError }
  if (last && now - last.ts < DONE_HOLD_MS) return { status: 'done', running: [], error: lastError }
  if (lastError && now - lastError.at < 5 * 60_000) return { status: 'error', running: [], error: lastError }
  if (last && now - last.ts < RECENT_MS) return { status: 'working', running: [], error: lastError }
  return { status: 'idle', running: [], error: lastError }
}

function blankAgg(id) {
  return {
    id,
    title: '',
    model: '',
    cwd: '',
    updatedAt: 0,
    startedAt: 0,
    turns: new Map(),
    tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    credits: 0,
    calls: 0,
    errors: 0,
    openCalls: new Map(),
    running: new Map(),
    lastEvent: null,
    lastError: null,
    lastUsage: null,
  }
}

function applyEvent(a, e) {
  if (e.cwd && !a.cwd) a.cwd = e.cwd
  if (e.model && !a.model) a.model = e.model
  if (e.ts > a.updatedAt) a.updatedAt = e.ts
  if (!a.startedAt || e.ts < a.startedAt) a.startedAt = e.ts
  if (!a.lastEvent || e.ts >= a.lastEvent.ts) a.lastEvent = e
  if (e.kind === 'usage') {
    a.tokens.total += e.total
    a.tokens.input += e.input
    a.tokens.output += e.output
    a.tokens.cacheRead += e.cacheRead
    a.tokens.cacheWrite += e.cacheWrite
    a.tokens.reasoning += e.reasoning
    a.credits += e.credit
    const t = a.turns.get(e.rid) || { id: e.rid, startedAt: e.ts, endedAt: e.ts, tokens: 0, credits: 0, calls: 0 }
    t.startedAt = Math.min(t.startedAt, e.ts)
    t.endedAt = Math.max(t.endedAt, e.ts)
    t.tokens += e.total
    t.credits += e.credit
    t.calls += 1
    a.turns.set(e.rid, t)
    if (!a.lastUsage || e.ts >= a.lastUsage.ts) a.lastUsage = e
  } else if (e.kind === 'call') {
    a.calls += 1
    a.openCalls.set(e.callId, { tool: e.tool, at: e.ts })
    a.running.set(e.tool, { name: e.tool, since: e.ts })
  } else if (e.kind === 'result') {
    const c = a.openCalls.get(e.callId)
    if (c) {
      a.openCalls.delete(e.callId)
      a.running.delete(c.tool)
    }
    if (e.status && e.status !== 'completed') {
      a.errors += 1
      if (!a.lastError || e.ts >= a.lastError.at) a.lastError = { at: e.ts, message: '工具调用失败：' + (c ? c.tool : '') }
    }
  }
}

function mergeAgg(dst, src) {
  for (const k of ['total', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) dst.tokens[k] += src.tokens[k]
  dst.credits += src.credits
  dst.calls += src.calls
  dst.errors += src.errors
  if (src.cwd && !dst.cwd) dst.cwd = src.cwd
  if (src.model && !dst.model) dst.model = src.model
  if (!dst.startedAt || (src.startedAt && src.startedAt < dst.startedAt)) dst.startedAt = src.startedAt || dst.startedAt
  if (src.updatedAt > dst.updatedAt) dst.updatedAt = src.updatedAt
  for (const [rid, t] of src.turns) {
    const cur = dst.turns.get(rid)
    if (!cur) dst.turns.set(rid, { ...t })
    else {
      cur.startedAt = Math.min(cur.startedAt, t.startedAt)
      cur.endedAt = Math.max(cur.endedAt, t.endedAt)
      cur.tokens += t.tokens
      cur.credits += t.credits
      cur.calls += t.calls
    }
  }
  for (const [k, v] of src.openCalls) dst.openCalls.set(k, v)
  for (const [k, v] of src.running) dst.running.set(k, v)
  if (!dst.lastEvent || (src.lastEvent && src.lastEvent.ts >= dst.lastEvent.ts)) dst.lastEvent = src.lastEvent
  if (!dst.lastError || (src.lastError && src.lastError.at >= dst.lastError.at)) dst.lastError = src.lastError
  if (!dst.lastUsage || (src.lastUsage && src.lastUsage.ts >= dst.lastUsage.ts)) dst.lastUsage = src.lastUsage
}

function statusFromAgg(a, now) {
  if (a.running.size) return { status: 'working', running: [...a.running.values()], error: a.lastError }
  if (a.lastEvent && now - a.lastEvent.ts < 4000) return { status: 'done', running: [], error: a.lastError }
  if (a.lastError && now - a.lastError.at < 5 * 60_000) return { status: 'error', running: [], error: a.lastError }
  if (a.lastEvent && now - a.lastEvent.ts < 90_000) return { status: 'working', running: [], error: a.lastError }
  return { status: 'idle', running: [], error: a.lastError }
}

// 按文件增量聚合：追加 1 行只处理 1 个事件，不再重扫 20MB transcript。
const fileAggs = new Map()

function aggregateFile(file) {
  const events = eventsOf(file)
  let entry = fileAggs.get(file)
  if (!entry || events.length < entry.count) {
    entry = { count: 0, sessions: new Map() }
    fileAggs.set(file, entry)
  }
  for (let i = entry.count; i < events.length; i++) {
    const e = events[i]
    let a = entry.sessions.get(e.sessionId)
    if (!a) {
      a = blankAgg(e.sessionId)
      entry.sessions.set(e.sessionId, a)
    }
    applyEvent(a, e)
  }
  entry.count = events.length
  return entry.sessions
}

function buildSessions(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const db = dbSessions(opts.dbFile || defaultDbFile(opts.env || process.env))
  const listed = listTranscripts(opts.projectsDir || defaultProjectsDir(opts.env || process.env), 0)
  if (listed.reason) return { ok: false, reason: listed.reason, items: [] }
  const byId = new Map()
  function ensure(id) {
    if (!byId.has(id)) {
      const a = blankAgg(id)
      const row = db.get(id)
      if (row) {
        a.title = row.title || ''
        a.model = row.model || ''
        a.updatedAt = row.updatedAt || 0
      }
      byId.set(id, a)
    }
    return byId.get(id)
  }
  for (const [id] of db) ensure(id)
  for (const f of listed.files.slice(0, 64)) {
    for (const [id, a] of aggregateFile(f.path)) mergeAgg(ensure(id), a)
  }
  const items = []
  for (const a of byId.values()) {
    const status = statusFromAgg(a, now)
    // transcript 里的真实时间；没有就保持 null，不能让补出来的 now 被当成
    // 「宿主已经处理完」的证据。
    const hostAt = Number(a.updatedAt) || null
    if (!a.updatedAt) a.updatedAt = now
    items.push(
      normalizeSession(
        {
          agentId: 'workbuddy',
          sessionId: a.id,
          title: a.title,
          cwd: a.cwd,
          model: a.model,
          status: status.status,
          statusSource: 'log',
          startedAt: a.startedAt || null,
          updatedAt: a.updatedAt,
          lastHostAt: hostAt,
          endedAt: status.status === 'done' ? a.updatedAt : null,
          turns: {
            count: a.turns.size,
            current: status.status === 'working' ? { id: '', index: null, startedAt: a.lastUsage ? a.lastUsage.ts : now } : null,
            avgDurationMs: null,
          },
          tokens: a.tokens,
          cost: a.credits ? { amount: Math.round(a.credits * 10000) / 10000, currency: 'CREDIT', unit: 'credit' } : null,
          tools: { calls: a.calls, errors: a.errors, running: status.running },
          errors: {
            model: 0,
            tool: a.errors,
            last: status.error ? { at: status.error.at, kind: 'tool', message: status.error.message } : null,
          },
          provenance: {
            tokens: prov('exact', 'local-log', 'workbuddy:transcripts#rawUsage', { asOf: now }),
            cost: a.credits
              ? prov('exact', 'local-log', 'workbuddy:transcripts#rawUsage.credit', { asOf: now })
              : unavailable('no-data', 'workbuddy:transcripts', 'local-log'),
            status: prov('estimated', 'local-log', 'workbuddy:transcripts', { asOf: now, note: '按 transcript 尾部事件推断' }),
            tools: prov('exact', 'local-log', 'workbuddy:transcripts#function_call', { asOf: now }),
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
  const built = buildSessions({ ...opts, now })
  if (!built.ok) return { ok: true, supported: false, reason: built.reason, session: null, turns: [], tools: [], models: [] }
  const session = built.items.find((s) => s.sessionId === String(sessionId)) || null
  if (!session) return { ok: true, supported: true, session: null, turns: [], tools: [], models: [] }
  // 详情需要更完整的事件（buildSessions 不保留原始事件到返回值）。
  const coll = collectEvents({ ...opts, now })
  const events = coll.ok ? coll.events.filter((e) => e.sessionId === String(sessionId)) : []
  const turnMap = new Map()
  const tools = new Map()
  const callMap = new Map()
  let credit = 0
  for (const e of events) {
    if (e.kind === 'usage') {
      credit += e.credit
      const t = turnMap.get(e.rid) || { id: e.rid, startedAt: e.ts, endedAt: e.ts, tokens: 0, cost: { amount: 0, currency: 'CREDIT', unit: 'credit' }, status: 'completed', model: e.model }
      t.startedAt = Math.min(t.startedAt, e.ts)
      t.endedAt = Math.max(t.endedAt, e.ts)
      t.tokens += e.total
      t.cost.amount = Math.round((t.cost.amount + e.credit) * 10000) / 10000
      turnMap.set(e.rid, t)
    } else if (e.kind === 'call') {
      callMap.set(e.callId, e)
      const t = tools.get(e.tool) || { name: e.tool, calls: 0, errors: 0, durations: [], lastAt: 0 }
      t.calls += 1
      t.lastAt = Math.max(t.lastAt, e.ts)
      tools.set(e.tool, t)
    } else if (e.kind === 'result') {
      const c = callMap.get(e.callId)
      if (c) {
        const t = tools.get(c.tool)
        if (t) {
          if (e.status && e.status !== 'completed') t.errors += 1
          t.durations.push(Math.max(0, e.ts - c.ts))
        }
      }
    }
  }
  const turns = [...turnMap.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((t, i) => ({
      id: t.id,
      index: i + 1,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      durationMs: Math.max(0, t.endedAt - t.startedAt),
      tokens: t.tokens,
      cost: t.cost,
      status: 'completed',
      model: t.model || '',
    }))
  const toolRows = [...tools.values()]
    .sort((a, b) => b.calls - a.calls)
    .map((t) => ({
      name: t.name,
      calls: t.calls,
      errors: t.errors,
      avgDurationMs: t.durations.length ? Math.round(t.durations.reduce((a, b) => a + b, 0) / t.durations.length) : null,
      lastAt: t.lastAt,
    }))
  const models = []
  return { ok: true, supported: true, session, turns, tools: toolRows, models }
}

// transcript 用量行：credits 口径，不折成钱。
export async function readUsageRows(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const coll = collectEvents({ ...opts, now })
  if (!coll.ok) return { ok: false, reason: coll.reason, rows: [] }
  const since = Number(opts.since) || 0
  const until = Number(opts.until) || now
  const tm = Number(opts.timeMinutes)
  const timeMinutes = Number.isInteger(tm) && tm >= 0 && tm < 1440 ? tm : null
  const rows = []
  for (const e of coll.events) {
    if (e.kind !== 'usage' || e.ts < since || e.ts > until) continue
    if (timeMinutes != null) {
      const d = new Date(e.ts)
      if (d.getHours() * 60 + d.getMinutes() !== timeMinutes) continue
    }
    rows.push({
      agentId: 'workbuddy',
      sessionId: e.sessionId,
      session: e.sessionId,
      model: e.model,
      vendor: 'WorkBuddy',
      tool: '',
      at: e.ts,
      day: dayKey(e.ts),
      unit: 'credit',
      currency: 'CREDIT',
      amount: 0,
      credits: Math.round(e.credit * 10000) / 10000,
      tokens: e.total,
      calls: 1,
      errors: 0,
      prov: prov('exact', 'local-log', 'workbuddy:transcripts#rawUsage.credit', { asOf: now }),
    })
    if (rows.length >= 200000) break
  }
  return { ok: true, rows, truncated: rows.length >= 200000 }
}

export async function readToolUsageRows(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const coll = collectEvents({ ...opts, now })
  if (!coll.ok) return { ok: false, reason: coll.reason, rows: [] }
  const since = Number(opts.since) || 0
  const until = Number(opts.until) || now
  const rows = []
  for (const e of coll.events) {
    if (e.kind !== 'call' || e.ts < since || e.ts > until) continue
    rows.push({
      agentId: 'workbuddy',
      sessionId: e.sessionId,
      session: e.sessionId,
      model: '',
      vendor: '',
      tool: e.tool,
      at: e.ts,
      day: dayKey(e.ts),
      unit: 'credit',
      currency: 'CREDIT',
      amount: 0,
      credits: 0,
      tokens: 0,
      calls: 1,
      errors: 0,
      prov: prov('exact', 'local-log', 'workbuddy:transcripts#function_call', { asOf: now }),
    })
    if (rows.length >= 200000) break
  }
  return { ok: true, rows, truncated: rows.length >= 200000 }
}

function dayKey(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
