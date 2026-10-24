// Kimi Code 会话层（D034）：只有会话列表，没有 turn / tool / 历史。
//
// 硬规则：**不得伪造 working**。M0 P-3 没有发现可用的忙闲字段，所以 status
// 固定 unknown，provenance=unavailable/host-unsupported。上下文占用来自
// /sessions/:id/status，只用于详情，不冒充 token 历史。

import { discoverLocalServer } from './context.mjs'
import { normalizeSession, summarizeSession, compareSessionToCursor, compareSessions, cursorOf, parseCursor } from '../../shared/session-model.mjs'
import { unavailable } from '../../shared/provenance.mjs'

function asArray(body) {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return []
  for (const k of ['sessions', 'data', 'items', 'list']) if (Array.isArray(body[k])) return body[k]
  return []
}

async function requestJson(server, p, opts = {}) {
  const res = await (opts.fetchImpl || fetch)(server.baseUrl + p, {
    headers: { authorization: 'Bearer ' + server.token, accept: 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs || 4000),
  })
  let body = null
  try {
    body = await res.json()
  } catch (err) {}
  return { status: res.status, ok: res.ok, body }
}

function rowsFrom(body, now) {
  return asArray(body).map((s) => {
    const id = String(s.id || s.session_id || s.sessionId || '')
    // 真实宿主时间；拿不到就是 null，不能用 now 冒充（否则轮询会误清 pending）。
    const hostAt = Number(s.updated_at || s.updatedAt || s.last_active_at) || null
    const updatedAt = hostAt || now
    return normalizeSession(
      {
        agentId: 'kimi',
        sessionId: id,
        title: String(s.title || s.name || ''),
        model: String(s.model || s.model_id || ''),
        status: 'unknown',
        statusSource: 'http',
        startedAt: Number(s.created_at || s.createdAt) || null,
        updatedAt,
        lastHostAt: hostAt,
        turns: { count: Number(s.turn_count || s.turns) || 0, current: null, avgDurationMs: null },
        tokens: { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
        cost: null,
        tools: { calls: 0, errors: 0, running: [] },
        errors: { model: 0, tool: 0, last: null },
        provenance: {
          tokens: unavailable('host-unsupported', 'kimi:/sessions', 'api'),
          cost: unavailable('host-unsupported', 'kimi:/sessions', 'api'),
          status: unavailable('host-unsupported', 'kimi:/sessions', 'api', { note: 'Kimi 没有忙闲字段' }),
          tools: unavailable('host-unsupported', 'kimi:/sessions', 'api'),
        },
      },
      { now }
    )
  })
}

export async function getSessions(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const server = discoverLocalServer(opts)
  if (!server.baseUrl) return { ok: true, supported: false, reason: 'not-running', items: [], nextCursor: null }
  let list = null
  try {
    list = await requestJson(server, '/sessions', opts)
  } catch (err) {
    return { ok: true, supported: false, reason: 'not-running', items: [], nextCursor: null }
  }
  if (list.status === 401 || list.status === 403) return { ok: true, supported: false, reason: 'auth', items: [], nextCursor: null }
  if (!list.ok) return { ok: true, supported: false, reason: list.status === 404 ? 'no-data' : 'schema', items: [], nextCursor: null }
  let items = rowsFrom(list.body, now)
  if (opts.status) items = items.filter((s) => s.status === opts.status)
  if (opts.q) {
    const q = String(opts.q).toLowerCase()
    items = items.filter((s) => (s.title + ' ' + s.model).toLowerCase().includes(q))
  }
  const sort = ['updated', 'tokens', 'cost', 'duration'].includes(opts.sort) ? opts.sort : 'updated'
  items.sort((a, b) => compareSessions(a, b, sort))
  // keyset 游标：按 (排序值,key) 比较，不要求锚点会话的 updatedAt 与游标完全相等。
  // 内存里的实时快照可能把同一条会话的 updatedAt 改得比适配器快照新，用
  // (updatedAt,key) 精确 findIndex 会找不到锚点而回落 offset=0，导致重复/丢页。
  const cur = opts.cursor ? parseCursor(opts.cursor) : null
  const after = cur ? items.filter((s) => compareSessionToCursor(s, sort, cur) > 0) : items
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50))
  const page = after.slice(0, limit)
  return {
    ok: true,
    supported: true,
    items: page,
    nextCursor: after.length > limit && page.length ? cursorOf(page[page.length - 1], sort) : null,
    // 过滤后的全部会话 key（不受游标/分页影响）：实时层用它判断内存里
    // 哪些会话是适配器不认识的（hook-only），从而给出稳定且不重复的 total。
    keys: items.map((s) => s.key),
    total: items.length,
  }
}

export async function getLiveStatus(opts = {}) {
  // 没有忙闲字段：不返回任何 working；列表仍可用于「状态未知」的展示。
  const r = await getSessions({ ...opts, limit: 100 })
  if (!r.supported) return { ok: true, supported: false, reason: r.reason, items: [] }
  return { ok: true, supported: true, items: r.items.map(summarizeSession) }
}

export async function getSessionDetail(sessionId, opts = {}) {
  const r = await getSessions({ ...opts, limit: 200 })
  const session = r.items.find((s) => s.sessionId === String(sessionId)) || null
  return { ok: true, supported: r.supported, reason: r.reason, session, turns: [], tools: [], models: [] }
}

export async function readUsageRows() {
  return { ok: false, reason: 'host-unsupported', rows: [], truncated: false }
}

export async function readToolUsageRows() {
  return { ok: false, reason: 'host-unsupported', rows: [], truncated: false }
}
