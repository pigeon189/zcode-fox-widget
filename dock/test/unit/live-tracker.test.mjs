// D034 LiveTracker：注入 / 轮询 / SSE 只在变化时 / 持久化 / 保留期
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLiveTracker } from '../../daemon/src/live-tracker.mjs'
import * as kimiSessions from '../../adapters/kimi/sessions.mjs'
import { normalizeSession } from '../../shared/session-model.mjs'

function fakeSse() {
  const sent = []
  return {
    sent,
    broadcast(event, data) {
      sent.push({ event, data })
    },
    clientCount() {
      return 1
    },
  }
}

function session(key, over = {}) {
  const [agentId, sessionId] = String(key).split(':')
  return {
    agentId,
    sessionId,
    title: 'T ' + key,
    status: 'working',
    statusSource: 'db',
    updatedAt: 1000,
    tokens: { total: 10 },
    ...over,
  }
}

function makeTracker(opts = {}) {
  let clock = opts.now || 1000
  const sse = opts.sse || fakeSse()
  const adapters = opts.adapters || []
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'fox-live-'))
  const file = path.join(dir, 'live-sessions.json')
  const tracker = createLiveTracker({
    adapters,
    sse,
    file,
    now: () => clock,
    getSettings: () => ({ retentionDays: opts.retentionDays || 30, live: { enabled: true } }),
  })
  return {
    tracker,
    sse,
    dir,
    file,
    advance(ms) {
      clock += ms
    },
    get now() {
      return clock
    },
  }
}

test('live-tracker: ingest 产生 upsert 与聚合状态', () => {
  const h = makeTracker()
  try {
    const r = h.tracker.ingest({ agentId: 'zcode', sessionId: 's1', event: 'turn_start', at: 1000, title: 'hello' })
    assert.equal(r.ok, true)
    assert.equal(r.session.key, 'zcode:s1')
    assert.equal(r.session.status, 'working')
    const upserts = h.sse.sent.filter((e) => e.event === 'session' && e.data.op === 'upsert')
    assert.equal(upserts.length, 1)
    const agg = h.tracker.aggregate()
    assert.equal(agg.aggregate, 'working')
    assert.equal(agg.counts.working, 1)
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 子会话状态归到父会话，计数不重复', async () => {
  const adapter = {
    id: 'zcode',
    name: 'ZCode',
    capabilities: { sessions: true },
    async getSessions() {
      return {
        ok: true,
        supported: true,
        total: 1,
        keys: ['zcode:p', 'zcode:c'],
        items: [
          session('zcode:p', { status: 'idle', updatedAt: 1000, title: 'parent' }),
          session('zcode:c', { status: 'working', updatedAt: 1000, title: 'child', parentKey: 'zcode:p' }),
        ],
      }
    },
  }
  const h = makeTracker({ adapters: [adapter] })
  try {
    const r = await h.tracker.list({ limit: 10, range: '30d' })
    assert.equal(r.total, 1, 'total 只计根会话')
    assert.equal(r.counts.working, 1, '子会话工作只让父会话算一个 working')
    assert.equal(r.byAgent.zcode.total, 1, 'byAgent.total 也只计根会话')
    assert.equal(r.items.length, 2, '父页仍返回父+子，便于展开')
    const working = await h.tracker.list({ limit: 10, range: '30d', status: 'working' })
    assert.equal(working.total, 1, '按工作中筛选应命中父会话')
    assert.equal(working.items[0].key, 'zcode:p')
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 时间倒退事件不覆盖，事件幂等', () => {
  const h = makeTracker({ now: 10_000 })
  try {
    h.tracker.ingest({ agentId: 'zcode', sessionId: 's1', event: 'turn_start', at: 10_000 })
    const r = h.tracker.ingest({ agentId: 'zcode', sessionId: 's1', event: 'turn_end', at: 5000 })
    assert.equal(r.dropped, true)
    assert.equal(h.tracker.get('zcode:s1').status, 'working')
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: done 4s 后降 idle 并广播', () => {
  const h = makeTracker({ now: 1000 })
  try {
    h.tracker.ingest({ agentId: 'zcode', sessionId: 's1', event: 'turn_start', at: 1000 })
    h.tracker.ingest({ agentId: 'zcode', sessionId: 's1', event: 'turn_end', at: 2000 })
    assert.equal(h.tracker.get('zcode:s1').status, 'done')
    h.advance(5000)
    h.tracker.tickExpire()
    assert.equal(h.tracker.get('zcode:s1').status, 'idle')
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 适配器轮询结果合入（新会话）且不覆盖更新的内存状态', async () => {
  const adapter = {
    id: 'zcode',
    capabilities: { sessions: { list: true, live: true } },
    async getLiveStatus() {
      return {
        ok: true,
        supported: true,
        items: [session('zcode:s1', { updatedAt: 3000, status: 'working', title: 'from adapter' }), session('zcode:s2', { updatedAt: 2000 })],
      }
    },
    async getSessions() {
      return { ok: true, supported: true, items: [session('zcode:s3', { updatedAt: 1500 })] }
    },
    async getSessionDetail() {
      return { ok: true, session: session('zcode:s1', { updatedAt: 3000 }), turns: [], tools: [], models: [] }
    },
  }
  const h = makeTracker({ now: 3000, adapters: [adapter] })
  try {
    h.tracker.ingest({ agentId: 'zcode', sessionId: 's1', event: 'waiting_input', at: 3500 })
    await h.tracker.tick()
    const s1 = h.tracker.get('zcode:s1')
    assert.equal(s1.status, 'waiting_input', '内存里更新的状态不被轮询打回')
    assert.ok(h.tracker.get('zcode:s2'))
    const list = await h.tracker.list({ agent: 'zcode' })
    assert.ok(list.items.some((x) => x.key === 'zcode:s3'))
    const d = await h.tracker.detail('zcode:s1')
    assert.ok(d.ok)
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 持久化原子写 + 重启恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-live-'))
  try {
    const h = makeTracker({ dir, now: 5000 })
    h.tracker.ingest({ agentId: 'zcode', sessionId: 's1', event: 'turn_start', at: 5000, title: 'persist me' })
    h.tracker._persistNow()
    const raw = JSON.parse(fs.readFileSync(h.file, 'utf8'))
    assert.equal(raw.schemaVersion, 1)
    assert.equal(raw.items.length, 1)
    assert.equal(raw.items[0].key, 'zcode:s1')
    const h2 = makeTracker({ dir, now: 6000 })
    assert.ok(h2.tracker.get('zcode:s1'))
    assert.equal(h2.tracker.get('zcode:s1').title, 'persist me')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('live-tracker: 重启后同时间戳以适配器累计量为准（成本不冻结在旧价目）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-live-'))
  try {
    // 旧进程：按旧口径算出 317.09 并持久化
    const h = makeTracker({ dir, now: 5000 })
    h.tracker.ingest({
      agentId: 'zcode',
      sessionId: 's1',
      event: 'usage',
      at: 5000,
      usage: { total: 100 },
      cost: { amount: 317.09, currency: 'CNY' },
    })
    h.tracker._persistNow()

    // 新进程：宿主库里这一笔没有新行（updatedAt 相同），但适配器按新口径重算
    const adapter = {
      id: 'zcode',
      capabilities: { sessions: { list: true, live: true } },
      async getSessions() {
        return {
          ok: true,
          supported: true,
          items: [
            {
              agentId: 'zcode',
              sessionId: 's1',
              title: 'T',
              status: 'idle',
              statusSource: 'db',
              updatedAt: 5000,
              tokens: { total: 100 },
              cost: { amount: 12.31, currency: 'CNY', unit: 'money' },
            },
          ],
        }
      },
      async getLiveStatus() {
        return { ok: true, supported: true, items: [] }
      },
      async getSessionDetail() {
        return { ok: true, session: null, turns: [], tools: [], models: [] }
      },
    }
    const h2 = makeTracker({ dir, now: 6000, adapters: [adapter] })
    const r = await h2.tracker.list({ limit: 10, range: '30d' })
    const s = r.items.find((x) => x.key === 'zcode:s1')
    assert.ok(s, '会话仍在列表里')
    assert.equal(s.cost.amount, 12.31, '累计成本以适配器为准')
    assert.equal(s.tokens.total, 100)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('live-tracker: retentionDays 清理旧 idle 会话，保留 working', () => {
  const h = makeTracker({ now: 100 * 86400000, retentionDays: 7 })
  try {
    h.tracker.ingest({ agentId: 'zcode', sessionId: 'old', event: 'session_end', at: 1 })
    h.tracker.ingest({ agentId: 'zcode', sessionId: 'live', event: 'turn_start', at: 100 * 86400000 })
    const removed = h.tracker.cleanup()
    assert.ok(removed >= 1)
    assert.equal(h.tracker.get('zcode:old'), null)
    assert.ok(h.tracker.get('zcode:live'))
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

function adapterOf(id, items, over = {}) {
  return {
    id,
    capabilities: { sessions: { list: true, live: true } },
    async getSessions(opts = {}) {
      return { ok: true, supported: true, items: opts.agent && opts.agent !== id ? [] : items, total: items.length }
    },
    async getLiveStatus() {
      return { ok: true, supported: true, items: [] }
    },
    ...over,
  }
}

test('live-tracker: archived=exclude|only|all，跨宿主 archived=only 不泄漏活跃会话', async () => {
  const zcode = adapterOf('zcode', [
    session('zcode:a1', { updatedAt: 3000, status: 'idle' }),
    session('zcode:a1c', { updatedAt: 2900, status: 'idle', parentKey: 'zcode:a1' }),
    session('zcode:ar1', { updatedAt: 2000, status: 'idle', archived: true }),
    session('zcode:ar1c', { updatedAt: 1900, status: 'idle', archived: true, parentKey: 'zcode:ar1' }),
  ])
  const workbuddy = adapterOf('workbuddy', [session('workbuddy:w1', { updatedAt: 2500, status: 'idle' })])
  const h = makeTracker({ now: 5000, adapters: [zcode, workbuddy] })
  try {
    const active = await h.tracker.list({ limit: 50, range: 'all' })
    assert.deepEqual(active.items.map((s) => s.key).sort(), ['workbuddy:w1', 'zcode:a1', 'zcode:a1c'])
    assert.equal(active.total, 2, 'total 只计根会话')
    assert.equal(active.byAgent.zcode.total, 1, 'byAgent.total 只计根会话')

    const only = await h.tracker.list({ limit: 50, archived: 'only' })
    assert.deepEqual(only.items.map((s) => s.key).sort(), ['zcode:ar1', 'zcode:ar1c'])
    assert.equal(only.total, 1)
    assert.equal(only.byAgent.workbuddy, undefined, '没有归档语义的宿主不能带出活跃会话')

    const all = await h.tracker.list({ limit: 50, archived: 'all', range: 'all' })
    assert.deepEqual(all.items.map((s) => s.key).sort(), [
      'workbuddy:w1',
      'zcode:a1',
      'zcode:a1c',
      'zcode:ar1',
      'zcode:ar1c',
    ])
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 跨宿主 total 恰好等于窗口不算截断，超过才标记', async () => {
  const items = Array.from({ length: 200 }, (_, i) => session('zcode:x' + i, { updatedAt: 10000 - i, status: 'idle' }))
  const exact = makeTracker({ now: 20000, adapters: [adapterOf('zcode', items)] })
  const over = makeTracker({
    now: 20000,
    adapters: [
      {
        ...adapterOf('zcode', items),
        async getSessions() {
          return { ok: true, supported: true, items, total: 201 }
        },
      },
    ],
  })
  try {
    const a = await exact.tracker.list({ limit: 50, range: 'all' })
    assert.equal(a.truncated, false, '200 个根会话全部在窗口内')
    const b = await over.tracker.list({ limit: 50, range: 'all' })
    assert.equal(b.truncated, true, '201 个说明窗口外还有会话')
  } finally {
    fs.rmSync(exact.dir, { recursive: true, force: true })
    fs.rmSync(over.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 根/子分页，子会话不占 limit，游标跨页不重复', async () => {
  const items = []
  for (let i = 0; i < 7; i++) {
    items.push(session('zcode:r' + i, { updatedAt: 7000 - i * 100, status: 'idle', title: '根 ' + i }))
    items.push(session('zcode:r' + i + 'c', { updatedAt: 7000 - i * 100 - 10, status: 'idle', parentKey: 'zcode:r' + i }))
  }
  const h = makeTracker({ now: 9000, adapters: [adapterOf('zcode', items)] })
  try {
    const seen = []
    let cursor = null
    let pages = 0
    do {
      const r = await h.tracker.list({ limit: 3, cursor: cursor || undefined, range: 'all' })
      const roots = r.items.filter((s) => !s.parentKey)
      assert.equal(roots.length, Math.min(3, 7 - seen.length))
      assert.equal(r.items.length, roots.length * 2, '每个根带自己的子会话')
      assert.equal(r.total, 7)
      assert.equal(r.shownRoots, roots.length)
      seen.push(...roots.map((s) => s.key))
      cursor = r.nextCursor
      pages += 1
      assert.ok(pages < 10)
    } while (cursor)
    assert.equal(seen.length, 7)
    assert.equal(new Set(seen).size, 7)
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 相同 updatedAt 的跨宿主分页使用全序游标，不跳条不重复', async () => {
  const items = []
  for (let i = 0; i < 9; i++) items.push(session('zcode:same' + i, { updatedAt: 4000, status: 'idle' }))
  const h = makeTracker({ now: 6000, adapters: [adapterOf('zcode', items)] })
  try {
    const keys = []
    let cursor = null
    do {
      const r = await h.tracker.list({ limit: 2, cursor: cursor || undefined, range: 'all' })
      keys.push(...r.items.map((s) => s.key))
      cursor = r.nextCursor
    } while (cursor)
    assert.equal(keys.length, 9)
    assert.equal(new Set(keys).size, 9)
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 单宿主游标不要求锚点 updatedAt 完全相等，翻页不重不漏', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: 's' + i, title: 't' + i, updated_at: 10000 - i * 100 }))
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ sessions: rows }) })
  const adapter = {
    id: 'kimi',
    capabilities: { sessions: { list: true, live: true } },
    getSessions: (opts) =>
      kimiSessions.getSessions({ ...opts, baseUrl: 'http://127.0.0.1:1', token: 'x', fetchImpl }),
  }
  const h = makeTracker({ now: 20000, adapters: [adapter] })
  try {
    // 内存快照把第 25 个根会话的 updatedAt 改得比适配器快照新，并且多一条
    // 只在内存里的会话：游标锚点与适配器记录不再逐字段相等。其余 29 条
    // 内存会话是适配器会话的镜像（不能重复计入 total）。
    for (let i = 0; i < 30; i++) {
      if (i === 23) continue
      h.tracker._sessions.set(
        'kimi:s' + i,
        normalizeSession(
          { agentId: 'kimi', sessionId: 's' + i, title: 't' + i, status: 'idle', updatedAt: 10000 - i * 100 },
          { now: 20000 }
        )
      )
    }
    h.tracker.ingest({ agentId: 'kimi', sessionId: 'sX', event: 'turn_start', at: 7790 })
    h.tracker.ingest({ agentId: 'kimi', sessionId: 's23', event: 'turn_start', at: 7750 })
    const seen = []
    const totals = []
    let cursor = null
    let pages = 0
    do {
      const r = await h.tracker.list({ agent: 'kimi', limit: 25, range: 'all', cursor: cursor || undefined })
      seen.push(...r.items.filter((s) => !s.parentKey).map((s) => s.key))
      totals.push(r.total)
      cursor = r.nextCursor
      pages += 1
      assert.ok(pages < 10)
    } while (cursor)
    assert.equal(seen.length, 31, '30 条适配器会话 + 1 条内存独有会话都要可达')
    assert.equal(new Set(seen).size, 31, '翻页不能重复')
    assert.deepEqual(totals, [31, 31], 'total 要计入内存独有会话，且不能随页跳动或重复计数')
    assert.ok(seen.includes('kimi:s29'), '最后一页之后的会话不能丢')
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 内存里归档前的副本按适配器归档状态过滤', async () => {
  const adapter = {
    id: 'zcode',
    capabilities: { sessions: { list: true, live: true, archived: true } },
    async getSessions() {
      return { ok: true, supported: true, items: [], keys: [], total: 0 }
    },
    async getLiveStatus() {
      return { ok: true, supported: true, items: [] }
    },
    async getArchivedKeys() {
      return { ok: true, supported: true, keys: ['zcode:p', 'zcode:c'] }
    },
  }
  const h = makeTracker({ now: 20000, adapters: [adapter] })
  try {
    // 内存里保留归档前的副本（archived=false）：适配器现在已经不再返回它们。
    h.tracker._sessions.set(
      'zcode:p',
      normalizeSession({ agentId: 'zcode', sessionId: 'p', status: 'idle', updatedAt: 5000, archived: false }, { now: 20000 })
    )
    h.tracker._sessions.set(
      'zcode:c',
      normalizeSession(
        { agentId: 'zcode', sessionId: 'c', parentKey: 'zcode:p', status: 'idle', updatedAt: 4000, archived: false },
        { now: 20000 }
      )
    )
    const cross = await h.tracker.list({ limit: 50, range: 'all' })
    assert.deepEqual(cross.items, [], '跨宿主 exclude 不能复活内存里的归档会话')
    assert.equal(cross.total, 0)
    const single = await h.tracker.list({ agent: 'zcode', limit: 50, range: 'all' })
    assert.deepEqual(single.items, [], '单宿主 exclude 同样不能复活')
    assert.equal(single.total, 0)
    const only = await h.tracker.list({ agent: 'zcode', limit: 50, archived: 'only' })
    assert.deepEqual(only.items.map((s) => s.key).sort(), ['zcode:c', 'zcode:p'], '归档视图仍能看到它们')
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 非 zcode 适配器没有真实宿主时间时不误清 pending', async () => {
  let live = { status: 'idle', updatedAt: 1000, statusSince: 1000, lastHostAt: null }
  const adapter = {
    id: 'kimi',
    capabilities: { sessions: { list: true, live: true } },
    async getSessions() {
      return { ok: true, supported: true, items: [], total: 0 }
    },
    async getLiveStatus() {
      return { ok: true, supported: true, items: [session('kimi:s1', live)] }
    },
  }
  const h = makeTracker({ now: 1000, adapters: [adapter] })
  try {
    h.tracker.ingest({ agentId: 'kimi', sessionId: 's1', event: 'permission_request', requestId: 'req-1', at: 1000, timeoutMs: 15000 })
    h.advance(2000)
    // updatedAt 推进但 lastHostAt 为 null：可能是适配器补的 now，不能当证据。
    live = { status: 'idle', updatedAt: 3000, statusSince: 3000, lastHostAt: null }
    await h.tracker.tick()
    assert.equal(h.tracker.get('kimi:s1').status, 'waiting_permission')
    assert.equal(h.tracker.get('kimi:s1').pending.length, 1)
    // 真实宿主时间推进 + 明确状态：宿主已经处理完，可以回落。
    h.advance(2000)
    live = { status: 'idle', updatedAt: 5000, statusSince: 2500, lastHostAt: 2500 }
    await h.tracker.tick()
    assert.equal(h.tracker.get('kimi:s1').status, 'idle')
    assert.deepEqual(h.tracker.get('kimi:s1').pending, [])
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: pending 过期后胶囊回落，不卡在等待确认', () => {
  const h = makeTracker({ now: 1000 })
  try {
    h.tracker.ingest({ agentId: 'zcode', sessionId: 's1', event: 'permission_request', requestId: 'req-1', at: 1000, timeoutMs: 15000 })
    assert.equal(h.tracker.get('zcode:s1').status, 'waiting_permission')
    h.advance(14999)
    h.tracker.tickExpire()
    assert.equal(h.tracker.get('zcode:s1').status, 'waiting_permission', '未到 expiresAt 不能误清')
    h.advance(1)
    h.tracker.tickExpire()
    const s = h.tracker.get('zcode:s1')
    assert.equal(s.status, 'idle')
    assert.deepEqual(s.pending, [])
    const upserts = h.sse.sent.filter((e) => e.event === 'session' && e.data.op === 'upsert')
    assert.ok(upserts.some((e) => e.data.session.status === 'idle'))
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

test('live-tracker: 适配器证据（updatedAt 推进且状态明确）清除 pending；未知状态/未推进时保留', async () => {
  let live = { status: 'unknown', updatedAt: 1000 }
  const adapter = {
    id: 'zcode',
    capabilities: { sessions: { list: true, live: true } },
    async getSessions() {
      return { ok: true, supported: true, items: [], total: 0 }
    },
    async getLiveStatus() {
      return { ok: true, supported: true, items: [session('zcode:s1', live)] }
    },
  }
  const h = makeTracker({ now: 1000, adapters: [adapter] })
  try {
    h.tracker.ingest({ agentId: 'zcode', sessionId: 's1', event: 'permission_request', requestId: 'req-1', at: 1000, timeoutMs: 15000 })
    // 时间未推进 + unknown：宿主可能还在弹窗，必须保留。
    await h.tracker.tick()
    assert.equal(h.tracker.get('zcode:s1').status, 'waiting_permission')
    assert.equal(h.tracker.get('zcode:s1').pending.length, 1)
    // 只有 updatedAt 被补成 now、没有真实宿主时间：不能当作证据。
    h.advance(2000)
    live = { status: 'idle', updatedAt: 3000, statusSince: 3000, lastHostAt: null }
    await h.tracker.tick()
    assert.equal(h.tracker.get('zcode:s1').status, 'waiting_permission')
    assert.equal(h.tracker.get('zcode:s1').pending.length, 1)
    // 真实宿主时间推进 + 明确 idle：宿主已经处理完，即使没有 resolution 事件也回落。
    h.advance(2000)
    live = { status: 'idle', updatedAt: 5000, statusSince: 2500, lastHostAt: 2500 }
    await h.tracker.tick()
    const s = h.tracker.get('zcode:s1')
    assert.equal(s.status, 'idle')
    assert.deepEqual(s.pending, [])
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

// 问题 6「状态横跳」：适配器在思考/工具切换的间隙只能按静默推断 idle
// （statusSource='inferred'，证据时间不推进）；滞回让 working 保持到 90s
// 静默。带回合结束证据的终态（db）立即降级；在途 running 工具不算静默，
// expire 不会把下一次轮询又要拉回 working 的会话打回空闲。
test('live-tracker: 阶段间隙的推断空闲不横跳，回合结束证据立即空闲', async () => {
  let live = { status: 'working', statusSource: 'db', updatedAt: 1000, statusSince: 1000 }
  const adapter = {
    id: 'zcode',
    capabilities: { sessions: { list: true, live: true } },
    async getSessions() {
      return { ok: true, supported: true, items: [], total: 0 }
    },
    async getLiveStatus() {
      return { ok: true, supported: true, items: [session('zcode:s1', live)] }
    },
  }
  const h = makeTracker({ now: 3000, adapters: [adapter] })
  try {
    await h.tracker.tick()
    assert.equal(h.tracker.get('zcode:s1').status, 'working')

    // 思考间隙：适配器只能按静默推断 idle，证据时间（updatedAt）不推进
    h.advance(30_000)
    live = { status: 'idle', statusSource: 'inferred', updatedAt: 1000, statusSince: 1000 }
    await h.tracker.tick()
    h.advance(30_000)
    await h.tracker.tick()
    assert.equal(h.tracker.get('zcode:s1').status, 'working', '60s 内的推断空闲不能把工作中打回空闲')

    // 适配器带回 running 工具：证据时间仍停在 1000，90s 超时也不算静默
    h.advance(30_000) // now=93_000，距证据 92s
    live = {
      status: 'working',
      statusSource: 'db',
      updatedAt: 1000,
      statusSince: 1000,
      tools: { calls: 3, errors: 0, running: [{ name: 'Bash', since: 93_000 }] },
    }
    await h.tracker.tick()
    h.tracker.tickExpire()
    assert.equal(h.tracker.get('zcode:s1').status, 'working', '在途 running 工具不算静默，不与 expire 拉锯')
    h.advance(10_000)
    h.tracker.tickExpire()
    assert.equal(h.tracker.get('zcode:s1').status, 'working', 'running 未清空期间持续保持')

    // 回合结束证据（db idle）：立即降级，不吃 90s 宽限
    live = { status: 'idle', statusSource: 'db', updatedAt: 104_000, statusSince: 104_000 }
    h.advance(1000)
    await h.tracker.tick()
    assert.equal(h.tracker.get('zcode:s1').status, 'idle', '回合结束证据直接降级')
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})
