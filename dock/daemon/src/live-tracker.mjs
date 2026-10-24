// LiveTracker（D034）：把「适配器轮询」与「事件注入」合成一张会话表。
//
// 数据流：
//   adapter.getLiveStatus() ─┐
//   POST /v1/ingest ─────────┼─ reduce → sessions Map ─┬─ SSE session {op,session}
//   POST /v1/events（旧兼容）┘                          ├─ SSE sessions {items}（15s + 新订阅者）
//                                                      └─ 节流写盘 live-sessions.json（≤200 摘要）
//
// 轮询频率：有 SSE 订阅者或桌宠可见 → 2s；否则 15s；失败指数退避上限 60s。
// 任何适配器异常都只记退避，不抛到事件循环。

import fs from 'node:fs'
import path from 'node:path'
import {
  aggregateOf,
  compareSessionToCursor,
  compareSessionsForSort,
  cursorOf,
  matchesArchived,
  normalizeArchivedMode,
  normalizeSession,
  parseCursor,
  sortValue,
  STATUS_PRIORITY,
  summarizeSession,
} from '../../shared/session-model.mjs'
import { expire, mergeSnapshot, reduce } from '../../shared/live-reduce.mjs'

const ACTIVE_POLL_MS = 2000
const IDLE_POLL_MS = 15_000
const MAX_BACKOFF_MS = 60_000
const FULL_BROADCAST_MS = 15_000
const PERSIST_DEBOUNCE_MS = 2000
const MAX_SESSIONS = 5000
const MAX_PERSIST = 200
// 跨宿主视图每个适配器固定取最近 N 个根会话（适配器单页上限 200）。
// 超过这个窗口的会话在跨宿主视图不可见，必须用 truncated 明确告知。
const ADAPTER_WINDOW = 200
const LIST_CACHE_MS = 5000
const MAX_CHILDREN_PER_ROOT = 20

function keyOf(agentId, sessionId) {
  return agentId + ':' + sessionId
}

function splitKey(key) {
  const s = String(key || '')
  const idx = s.indexOf(':')
  if (idx <= 0) return null
  return { agentId: s.slice(0, idx), sessionId: s.slice(idx + 1) }
}

function fingerprint(s) {
  if (!s) return ''
  return [
    s.status,
    s.statusSince,
    s.updatedAt,
    s.turns && s.turns.count,
    s.tokens && s.tokens.total,
    s.tools && s.tools.calls,
    s.tools && s.tools.errors,
    s.pending && s.pending.length,
    s.errors && s.errors.last && s.errors.last.at,
  ].join('|')
}

export function createLiveTracker({
  adapters,
  sse = null,
  file = '',
  getSettings = () => ({}),
  getPetVisible = () => false,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const sessions = new Map()
  const state = new Map() // adapterId -> { fail, backoffUntil, lastAt }
  let timer = null
  let persistTimer = null
  let fullTimer = null
  let busy = false
  let lastFullAt = 0
  let subscribedBefore = 0
  let lastAggregate = ''
  let lastPollAt = 0
  let listCache = null
  const archivedCache = new Map() // adapterId -> { at, keys:Set }

  function invalidateListCache() {
    listCache = null
  }

  // 归档状态是适配器侧的权威信息：内存快照可能保留归档前的副本（轮询在
  // 归档之前写入，之后适配器就不再返回它），只靠 s.archived 会把已归档
  // 会话重新放进「当前」。有能力的适配器返回「自身或祖先已归档」的 key。
  async function archivedKeysFor(adapter, at) {
    const cap = adapter && adapter.capabilities && adapter.capabilities.sessions
    if (!cap || cap.archived !== true || typeof adapter.getArchivedKeys !== 'function') return null
    const hit = archivedCache.get(adapter.id)
    if (hit && at - hit.at < LIST_CACHE_MS) return hit.keys
    try {
      const r = await adapter.getArchivedKeys({ now: () => at })
      if (!r || r.supported === false) return null
      const keys = new Set(Array.isArray(r.keys) ? r.keys : [])
      archivedCache.set(adapter.id, { at, keys })
      return keys
    } catch (err) {
      return null
    }
  }

  // 归档会话只从适配器历史里取，不参与实时徽标/持久化。
  function visibleSessions() {
    return [...sessions.values()].filter((s) => s.archived !== true)
  }

  function statsOf(list) {
    const rows = Array.isArray(list) ? list : []
    const agg = aggregateOf(rows)
    const byAgent = {}
    for (const s of rows) {
      const row = byAgent[s.agentId] || (byAgent[s.agentId] = { working: 0, waiting: 0, error: 0, done: 0, total: 0, lastAt: 0 })
      row.total += 1
      row.lastAt = Math.max(Number(row.lastAt) || 0, Number(s.updatedAt) || 0)
      if (s.status === 'working') row.working += 1
      else if (s.status === 'waiting_permission' || s.status === 'waiting_input') row.waiting += 1
      else if (s.status === 'error') row.error += 1
      else if (s.status === 'done') row.done += 1
    }
    return { aggregate: agg.aggregate, counts: agg.counts, byAgent }
  }

  // 根/子分层：parentKey 指向候选集内的会话即视为子会话。
  function groupSessions(list) {
    const byKey = new Map()
    for (const s of list) byKey.set(s.key, s)
    const roots = []
    const childrenByParent = new Map()
    for (const s of list) {
      if (s.parentKey && byKey.has(s.parentKey)) {
        const arr = childrenByParent.get(s.parentKey) || []
        arr.push(s)
        childrenByParent.set(s.parentKey, arr)
      } else {
        roots.push(s)
      }
    }
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => compareSessionsForSort(a, b, 'updated'))
      if (arr.length > MAX_CHILDREN_PER_ROOT) arr.length = MAX_CHILDREN_PER_ROOT
    }
    return { byKey, roots, childrenByParent }
  }

  function childrenFor(root, childrenByParent) {
    return childrenByParent.get(root.key) || []
  }

  // 控制台的状态计数按「根会话」算：子会话的工作/等待要归到父会话，
  // 否则一个父会话带两个子任务会显示成 3 个「工作中」，与实际会话数不符。
  function rootStatusOf(root, childrenByParent) {
    const statuses = [root.status, ...childrenFor(root, childrenByParent).map((c) => c.status)]
    for (const status of STATUS_PRIORITY) if (statuses.includes(status)) return status
    return root.status
  }

  function rootStatusMap(roots, childrenByParent) {
    const map = new Map()
    for (const root of roots) map.set(root.key, rootStatusOf(root, childrenByParent))
    return map
  }

  function statsOfRoots(roots, childrenByParent) {
    const statuses = rootStatusMap(roots, childrenByParent)
    return statsOf(roots.map((root) => ({ ...root, status: statuses.get(root.key) })))
  }

  function flattenRoots(pageRoots, childrenByParent) {
    const out = []
    for (const root of pageRoots) {
      out.push(root)
      for (const child of childrenFor(root, childrenByParent)) out.push(child)
    }
    return out
  }

  function matchSearch(s, q) {
    if (!q) return true
    const needle = String(q).toLowerCase()
    return (String(s.title || '') + ' ' + String(s.cwd || '') + ' ' + String(s.model || '')).toLowerCase().includes(needle)
  }

  // v2 游标：mode='all'（跨宿主固定窗口）或 'agent'（单宿主直通适配器）。
  function encodeCursor(mode, sort, s, agentId) {
    const val = sortValue(s, sort)
    const payload = JSON.stringify({
      v: 2,
      mode,
      ...(agentId ? { agent: agentId } : {}),
      s: sort,
      val: val === null ? null : val,
      k: String((s && s.key) || ''),
      u: Number(s && s.updatedAt) || 0,
    })
    return Buffer.from(payload, 'utf8').toString('base64url')
  }

  // 把解析后的游标还原成 v1 字符串，交给适配器继续翻页。
  function reencodeCursor(cur) {
    if (!cur) return ''
    const payload = JSON.stringify({ v: 1, s: cur.sort, val: cur.val, k: cur.key, u: cur.updatedAt })
    return Buffer.from(payload, 'utf8').toString('base64url')
  }

  function cursorAfter(list, sort, cur) {
    if (!cur || cur.sort !== sort) return list
    return list.filter((s) => compareSessionToCursor(s, sort, cur) > 0)
  }

  function settings() {
    const s = getSettings() || {}
    return s && typeof s === 'object' ? s : {}
  }

  function retentionDays() {
    const d = Number(settings().retentionDays)
    return Number.isFinite(d) && d > 0 ? Math.min(365, Math.round(d)) : 30
  }

  function liveEnabled() {
    const s = settings()
    return !(s.live && s.live.enabled === false)
  }

  function persistNow() {
    if (!file) return
    try {
      const items = visibleSessions()
        .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
        .slice(0, MAX_PERSIST)
        .map(summarizeSession)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.' + process.pid + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, at: now(), items }))
      fs.renameSync(tmp, file)
    } catch (err) {
      log('live-sessions persist failed: ' + (err && err.message ? err.message : err))
    }
  }

  function schedulePersist() {
    if (!file || persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
    }, PERSIST_DEBOUNCE_MS)
    persistTimer.unref?.()
  }

  function loadPersisted() {
    if (!file) return
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      const items = Array.isArray(raw && raw.items) ? raw.items : []
      for (const item of items.slice(0, MAX_SESSIONS)) {
        const key = String(item && item.key || '')
        const parts = splitKey(key)
        if (!parts) continue
        const session = normalizeSession(
          {
            ...item,
            agentId: parts.agentId,
            sessionId: parts.sessionId,
            status: item.status || 'idle',
            statusSource: item.statusSource || 'inferred',
            provenance: item.provenance || undefined,
            tokens: item.tokens || {},
            turns: item.turns || {},
            tools: item.tools || {},
            errors: item.errors || {},
          },
          { now: now() }
        )
        sessions.set(session.key, session)
      }
    } catch (err) {}
  }

  function broadcastUpsert(session) {
    if (!sse) return
    try {
      sse.broadcast('session', { op: 'upsert', session: summarizeSession(session) })
    } catch (err) {}
  }

  function broadcastRemove(key) {
    if (!sse) return
    try {
      sse.broadcast('session', { op: 'remove', key })
    } catch (err) {}
  }

  function summaries() {
    return visibleSessions()
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      .map(summarizeSession)
  }

  function aggregate() {
    // 胶囊/控制台徽标的「工作中/等待确认」也按根会话算；子任务不重复计数。
    const { roots, childrenByParent } = groupSessions(visibleSessions())
    return statsOfRoots(roots, childrenByParent)
  }

  function broadcastSessions(force = false) {
    if (!sse) return
    const at = now()
    if (!force && at - lastFullAt < FULL_BROADCAST_MS) return
    lastFullAt = at
    try {
      sse.broadcast('sessions', { items: summaries(), ...aggregate() })
    } catch (err) {}
  }

  function broadcastState() {
    const agg = aggregate()
    if (agg.aggregate === lastAggregate) return
    lastAggregate = agg.aggregate
    if (!sse) return
    try {
      sse.broadcast('live', { ...agg })
    } catch (err) {}
  }

  function cleanup() {
    const cutoff = now() - retentionDays() * 86400000
    let removed = 0
    for (const [key, s] of sessions) {
      if (Number(s.updatedAt) < cutoff && s.status !== 'working' && !String(s.status).startsWith('waiting')) {
        sessions.delete(key)
        removed += 1
      }
    }
    // 上限：淘汰最旧的 idle/done 会话（working/waiting 永不淘汰）
    if (sessions.size > MAX_SESSIONS) {
      const candidates = [...sessions.values()]
        .filter((s) => s.status === 'idle' || s.status === 'done' || s.status === 'unknown')
        .sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt))
      for (const s of candidates) {
        if (sessions.size <= MAX_SESSIONS) break
        sessions.delete(s.key)
        removed += 1
      }
    }
    if (removed) schedulePersist()
    return removed
  }

  function tickExpire() {
    const at = now()
    for (const [key, s] of [...sessions]) {
      const r = expire(s, at)
      if (!r.changed) continue
      sessions.set(key, r.session)
      broadcastUpsert(r.session)
      schedulePersist()
      invalidateListCache()
    }
    cleanup()
    broadcastState()
  }

  function upsertSession(raw, ctx = {}) {
    const incoming = normalizeSession(raw, { now: now() })
    if (!incoming.sessionId) return null
    const prev = sessions.get(incoming.key)
    let result
    if (prev) {
      // updatedAt 在宿主没有时间戳时会被适配器补成 now；只有 lastHostAt 才是
      // 真实宿主时间，不能拿补出来的 now 清掉等待中的权限请求。所有适配器
      // 都按这个规则处理；没有 lastHostAt 的适配器宁可保留 pending，等到
      // expiresAt 再回落，也不误清宿主仍在等待的请求。
      const hostAt = Number(incoming.lastHostAt)
      const evidenceAt = Number.isFinite(hostAt) && hostAt > 0 ? hostAt : null
      result = mergeSnapshot(prev, incoming, now(), { evidenceAt })
    } else {
      result = { session: incoming, changed: true }
    }
    if (result.changed && result.session) {
      sessions.set(incoming.key, result.session)
      broadcastUpsert(result.session)
      schedulePersist()
      broadcastState()
      invalidateListCache()
    }
    return result.session
  }

  // 事件注入（已由 v1/ingest 校验过）。
  function ingest(evt) {
    const e = evt && typeof evt === 'object' ? evt : {}
    if (!e.agentId || !e.sessionId) return { ok: false, error: 'agent-and-session-required' }
    const key = keyOf(e.agentId, e.sessionId)
    const prev = sessions.get(key)
    const base = prev || {
      key,
      agentId: e.agentId,
      sessionId: e.sessionId,
      parentKey: null,
      title: e.title || '',
      cwd: e.cwd || '',
      model: e.model || '',
      provider: e.provider || '',
      status: 'idle',
      statusSince: now(),
      statusSource: 'ingest',
      startedAt: e.at || now(),
      updatedAt: e.at || now(),
      endedAt: null,
      turns: { count: 0, current: null, avgDurationMs: null },
      tokens: { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
      cost: null,
      tools: { calls: 0, errors: 0, running: [] },
      errors: { model: 0, tool: 0, last: null },
      pending: [],
    }
    const r = reduce(base, e, now())
    if (r.dropped) return { ok: true, dropped: true, session: summarizeSession(prev) }
    const next = normalizeSession({ ...r.session, statusSource: 'ingest' }, { now: now() })
    sessions.set(key, next)
    broadcastUpsert(next)
    schedulePersist()
    broadcastState()
    invalidateListCache()
    return { ok: true, dropped: false, session: next, changed: r.changed }
  }

  async function pollAdapters() {
    const at = now()
    const list = (adapters || []).filter((a) => a && a.capabilities && a.capabilities.sessions)
    for (const adapter of list) {
      const s = state.get(adapter.id) || { fail: 0, backoffUntil: 0, lastAt: 0 }
      state.set(adapter.id, s)
      if (at < s.backoffUntil) continue
      if (typeof adapter.getLiveStatus !== 'function') continue
      s.lastAt = at
      try {
        const r = await adapter.getLiveStatus({ now: () => at, sinceMs: at - 10 * 60_000, limit: 200 })
        if (!r || r.supported === false) {
          if (r && r.reason && r.reason !== 'not-running') {
            s.fail += 1
            s.backoffUntil = at + Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, s.fail))
          }
          continue
        }
        s.fail = 0
        s.backoffUntil = 0
        for (const item of r.items || []) upsertSession(item, { adapterId: adapter.id })
      } catch (err) {
        s.fail += 1
        s.backoffUntil = at + Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, s.fail))
      }
    }
  }

  async function tick() {
    if (busy || !liveEnabled()) return
    busy = true
    try {
      const subscribed = sse ? sse.clientCount() > 0 : false
      if (subscribed && subscribedBefore === 0) {
        // 新订阅者：立刻全量推一次。
        lastFullAt = 0
        broadcastSessions(true)
      }
      subscribedBefore = subscribed
      const interval = pollInterval()
      const at = now()
      if (at - lastPollAt >= interval) {
        lastPollAt = at
        await pollAdapters()
      }
      broadcastSessions(false)
    } finally {
      busy = false
    }
  }

  function pollInterval() {
    const subscribed = sse ? sse.clientCount() > 0 : false
    return subscribed || getPetVisible() ? ACTIVE_POLL_MS : IDLE_POLL_MS
  }

  function start() {
    if (timer) return
    loadPersisted()
    lastFullAt = 0
    timer = setInterval(() => {
      tick().catch(() => {})
    }, ACTIVE_POLL_MS)
    timer.unref?.()
    const exp = setInterval(tickExpire, 1000)
    exp.unref?.()
    timer._expire = exp
    fullTimer = setInterval(() => broadcastSessions(true), FULL_BROADCAST_MS)
    fullTimer.unref?.()
    tick().catch(() => {})
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      if (timer._expire) clearInterval(timer._expire)
      timer = null
    }
    if (fullTimer) {
      clearInterval(fullTimer)
      fullTimer = null
    }
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
      persistNow()
    }
  }

  // 跨宿主固定窗口：每个适配器取最近 ADAPTER_WINDOW 个根会话，合并后按
  // 全序 keyset 切片。结果缓存 5s（ingest/upsert 失效），避免每次「加载更多」
  // 都重扫所有宿主。
  async function collectAll(q, at) {
    const cacheKey = JSON.stringify({
      status: q.status,
      q: q.q,
      range: q.range,
      archived: q.archived,
      sort: q.sort,
    })
    if (listCache && listCache.key === cacheKey && at - listCache.at < LIST_CACHE_MS) {
      return listCache.snapshot
    }
    const all = new Map()
    for (const s of sessions.values()) all.set(s.key, s)
    const adaptersToQuery = (adapters || []).filter(
      (a) => a && a.capabilities && a.capabilities.sessions && typeof a.getSessions === 'function'
    )
    let truncated = false
    for (const adapter of adaptersToQuery) {
      try {
        const r = await adapter.getSessions({
          range: q.range || '30d',
          limit: ADAPTER_WINDOW,
          sort: q.sort || 'updated',
          status: q.status || '',
          q: q.q || '',
          archived: q.archived,
          now: () => at,
        })
        if (!r || r.supported === false) continue
        const list = Array.isArray(r.items) ? r.items : []
        const archivedKeys = await archivedKeysFor(adapter, at)
        for (const item of list) {
          let session = normalizeSession(item, { now: at })
          if (archivedKeys && archivedKeys.has(session.key)) session = { ...session, archived: true }
          // 内存里有会话就以内存为准（它合并了轮询与注入）；适配器确实更新时才替换。
          const prev = all.get(session.key)
          if (!prev || Number(session.updatedAt) > Number(prev.updatedAt)) all.set(session.key, session)
        }
        // 内存里归档前的副本不会出现在适配器结果里；按权威集合补上 archived，
        // 否则 listAll 的 matchesArchived 会把它们当成活跃会话。
        if (archivedKeys) {
          for (const [key, s] of all) {
            if (s.agentId !== adapter.id || s.archived === true || !archivedKeys.has(key)) continue
            all.set(key, { ...s, archived: true })
          }
        }
        if (r.truncated === true) truncated = true
        // total 计根会话；zcode 的 items 还含子会话，不能用 items.length 判断窗口。
        const total = Number(r.total)
        if (Number.isFinite(total)) {
          // 恰好等于窗口说明全部会话都在窗口内，只有超出才是截断。
          if (total > ADAPTER_WINDOW) truncated = true
        } else if (list.length >= ADAPTER_WINDOW) truncated = true
      } catch (err) {}
    }
    const snapshot = { rows: [...all.values()], truncated }
    listCache = { at, key: cacheKey, snapshot }
    return snapshot
  }

  async function listAll(q, at) {
    const { rows, truncated } = await collectAll(q, at)
    const nodes = rows.filter((s) => matchesArchived(s, q.archived) && (!q.agent || s.agentId === q.agent))
    const { roots, childrenByParent } = groupSessions(nodes)
    // status/q 只过滤根会话；子会话只受 archived 过滤。状态筛选按父+子合并后的
    // 根状态，保证「子任务在工作中」的父会话会出现在「工作中」筛选里。
    const rootStatuses = rootStatusMap(roots, childrenByParent)
    const filteredRoots = roots
      .filter((s) => (!q.status || rootStatuses.get(s.key) === q.status) && matchSearch(s, q.q))
      .sort((a, b) => compareSessionsForSort(a, b, q.sort))
    const cur = q.cursor ? parseCursor(q.cursor) : null
    const after = cursorAfter(filteredRoots, q.sort, cur)
    const page = after.slice(0, q.limit)
    const nextCursor =
      after.length > q.limit && page.length
        ? encodeCursor('all', q.sort, page[page.length - 1])
        : null
    const items = flattenRoots(page, childrenByParent)
    return {
      ok: true,
      items,
      nextCursor,
      total: filteredRoots.length,
      shownRoots: page.length,
      rootTotal: filteredRoots.length,
      truncated,
      ...statsOfRoots(roots, childrenByParent),
    }
  }

  async function listAgent(q, adapter, at) {
    const cur = q.cursor ? parseCursor(q.cursor) : null
    const r = await adapter.getSessions({
      range: q.range || '30d',
      limit: q.limit,
      sort: q.sort,
      status: q.status || '',
      q: q.q || '',
      archived: q.archived,
      cursor: reencodeCursor(cur),
      now: () => at,
    })
    if (!r || r.supported === false) {
      // 适配器暂时不可用（宿主没开）时仍展示内存里的实时会话。
      return listAll(q, at)
    }
    const archivedKeys = await archivedKeysFor(adapter, at)
    const adapterKeys = Array.isArray(r.keys) ? new Set(r.keys) : null
    const byKey = new Map()
    for (const item of Array.isArray(r.items) ? r.items : []) {
      let s = normalizeSession(item, { now: at })
      if (s.agentId !== adapter.id) continue
      if (archivedKeys && archivedKeys.has(s.key)) s = { ...s, archived: true }
      // 游标锚点已经在上一页返回过。内存快照可能改写它的 updatedAt，适配器
      // keyset 过滤时仍可能再次带出来；这里直接跳过，避免跨页重复。
      if (cur && s.key === cur.key) continue
      if (!matchesArchived(s, q.archived)) continue
      byKey.set(s.key, s)
    }
    // 内存态覆盖同 key 的适配器快照，并补进适配器这一页没覆盖到的会话。
    // 后续页同样合并，但由游标过滤掉已经返回过的位置，避免重复。
    const memNodes = []
    for (const raw of sessions.values()) {
      if (raw.agentId !== adapter.id) continue
      // 适配器已归档、但内存还留着归档前副本的会话，必须按归档处理。
      const s = archivedKeys && archivedKeys.has(raw.key) ? { ...raw, archived: true } : raw
      if (!matchesArchived(s, q.archived)) continue
      // memNodes 用于 total，必须与游标无关（锚点也要计入），
      // byKey 则跳过上一页已经返回过的锚点。
      memNodes.push(s)
      if (cur && s.key === cur.key) continue
      byKey.set(s.key, s)
    }
    // 父会话在适配器里、但不在这一页时，不要把内存子会话提升成根（会与
    // total 的「父在适配器里就不算额外根」口径不一致）；父会话所在页会带它。
    if (adapterKeys) {
      for (const s of memNodes) {
        if (!s.parentKey || !adapterKeys.has(s.parentKey) || byKey.has(s.parentKey)) continue
        byKey.delete(s.key)
      }
    }
    const { roots, childrenByParent } = groupSessions([...byKey.values()])
    const rootStatuses = rootStatusMap(roots, childrenByParent)
    const filteredRoots = roots
      .filter((s) => (!q.status || rootStatuses.get(s.key) === q.status) && matchSearch(s, q.q))
      .sort((a, b) => compareSessionsForSort(a, b, q.sort))
    const after = cursorAfter(filteredRoots, q.sort, cur)
    const page = after.slice(0, q.limit)
    const pageLast = page[page.length - 1] || null
    const more = after.length > q.limit || (!!r.nextCursor && !!pageLast)
    const nextCursor = more && pageLast ? encodeCursor('agent', q.sort, pageLast, adapter.id) : null
    // total = 适配器根会话总数 + 内存里适配器不认识的根会话（hook-only）。
    // 适配器返回的 keys 是过滤后的全部会话（不受分页影响），所以这个数跨页
    // 稳定，也不会把内存里的适配器镜像重复相加。没有 keys 的老适配器退回
    // max(adapterTotal, 当前合并根数)。
    const adapterTotal = Number(r.total)
    let total
    if (Number.isFinite(adapterTotal)) {
      if (adapterKeys) {
        const memKeys = new Set(memNodes.map((s) => s.key))
        const extraRoots = memNodes.filter(
          (s) =>
            !adapterKeys.has(s.key) &&
            // 父会话在适配器或内存里存在时，这是子会话，不单独计根。
            !(s.parentKey && (adapterKeys.has(s.parentKey) || memKeys.has(s.parentKey))) &&
            (!q.status || s.status === q.status) &&
            matchSearch(s, q.q)
        )
        total = adapterTotal + extraRoots.length
      } else {
        total = Math.max(adapterTotal, filteredRoots.length)
      }
    } else {
      total = filteredRoots.length
    }
    return {
      ok: true,
      items: flattenRoots(page, childrenByParent),
      nextCursor,
      total,
      shownRoots: page.length,
      rootTotal: total,
      truncated: r.truncated === true,
      ...statsOfRoots(roots, childrenByParent),
    }
  }

  async function list(query = {}) {
    const raw = query && typeof query === 'object' ? query : {}
    const at = now()
    const q = {
      agent: String(raw.agent || ''),
      status: String(raw.status || ''),
      q: String(raw.q || ''),
      sort: ['updated', 'tokens', 'cost', 'duration'].includes(raw.sort) ? raw.sort : 'updated',
      limit: Math.max(1, Math.min(200, Number(raw.limit) || 50)),
      cursor: String(raw.cursor || ''),
      range: ['today', '7d', '30d', 'all'].includes(raw.range) ? raw.range : '30d',
      archived: normalizeArchivedMode(raw.archived),
    }
    if (q.archived === 'only' && raw.range == null) q.range = 'all'
    if (!q.agent) return listAll(q, at)
    const adapter = (adapters || []).find((a) => a && a.id === q.agent && typeof a.getSessions === 'function')
    if (!adapter) return listAll(q, at)
    try {
      return await listAgent(q, adapter, at)
    } catch (err) {
      return listAll(q, at)
    }
  }

  async function detail(key) {
    const parts = splitKey(decodeURIComponent(String(key || '')))
    if (!parts) return { ok: false, error: 'bad-key' }
    const mem = sessions.get(parts.agentId + ':' + parts.sessionId) || null
    const adapter = (adapters || []).find((a) => a && a.id === parts.agentId) || null
    let extra = null
    if (adapter && typeof adapter.getSessionDetail === 'function') {
      try {
        extra = await adapter.getSessionDetail(parts.sessionId, { now: () => now() })
      } catch (err) {
        extra = null
      }
    }
    const session = mem || (extra && extra.session) || null
    if (!session) return { ok: false, error: 'session-not-found' }
    return {
      ok: true,
      session,
      turns: (extra && extra.turns) || [],
      tools: (extra && extra.tools) || [],
      models: (extra && extra.models) || [],
    }
  }

  function sendFull(res) {
    if (!res) return
    try {
      const data = JSON.stringify({ items: summaries(), ...aggregate() })
      res.write('event: sessions\ndata: ' + data + '\n\n')
    } catch (err) {}
  }

  loadPersisted()

  return {
    start,
    stop,
    tick,
    tickExpire,
    ingest,
    list,
    detail,
    sendFull,
    broadcastSessions,
    cleanup,
    aggregate,
    get(key) {
      return sessions.get(String(key || '')) || null
    },
    _sessions: sessions,
    _persistNow: persistNow,
  }
}
