import test from 'node:test'
import assert from 'node:assert/strict'

import { createContextService } from '../../daemon/src/context-service.mjs'
import { createContextScheduler } from '../../daemon/src/scheduler.mjs'

function fakeAdapter(id, fn) {
  return {
    id,
    name: id,
    capabilities: { billing: true, follow: true, context: true },
    getContext: fn,
  }
}

function fakeSse(clients = 0) {
  return {
    events: [],
    broadcast(e, d) {
      this.events.push({ e, d })
    },
    clientCount() {
      return this.clients === undefined ? clients : this.clients
    },
  }
}

test('scheduler: 没有订阅者且不是档案属主 → 不读盘', async () => {
  let calls = 0
  const adapters = [fakeAdapter('zcode', () => (calls++, { supported: false, reason: 'no-session' }))]
  const service = createContextService({ adapters })
  const sse = fakeSse(0)
  const s = createContextScheduler({ adapters, service, sse, getSettings: () => ({ pet: { mode: 'idle' } }) })
  await s.tick()
  assert.equal(calls, 0)
})

test('scheduler: 订阅时轮询，内容变化才广播', async () => {
  let used = 10
  const adapters = [fakeAdapter('zcode', () => ({ supported: true, used, limit: 100, sessionId: 's', confidence: 'exact' }))]
  let nowMs = 1000
  const service = createContextService({ adapters, now: () => nowMs, ttlMs: 0 })
  const sse = fakeSse(1)
  const s = createContextScheduler({
    adapters,
    service,
    sse,
    getSettings: () => ({ pet: { mode: 'attached', agentId: 'zcode' } }),
    now: () => nowMs,
    pollMs: { default: 1000 },
  })
  await s.tick()
  assert.equal(sse.events.filter((e) => e.e === 'context').length, 1)
  nowMs += 2000
  await s.tick() // used 未变 → 不广播
  assert.equal(sse.events.filter((e) => e.e === 'context').length, 1)
  used = 20
  nowMs += 2000
  await s.tick()
  const events = sse.events.filter((e) => e.e === 'context')
  assert.equal(events.length, 2)
  assert.equal(events[1].d.context.used, 20)
  assert.equal(events[1].d.context.pct, 20)
})

test('scheduler: 失败按指数退避，成功后恢复', async () => {
  let fail = true
  let calls = 0
  const adapters = [
    fakeAdapter('kimi', () => {
      calls++
      if (fail) throw new Error('boom')
      return { supported: true, used: 1, limit: 10, sessionId: 'k' }
    }),
  ]
  let nowMs = 1000
  const service = createContextService({ adapters, now: () => nowMs, ttlMs: 0 })
  const s = createContextScheduler({
    adapters,
    service,
    sse: fakeSse(1),
    getSettings: () => ({}),
    now: () => nowMs,
    pollMs: { default: 100 },
  })
  await s.tick()
  assert.equal(calls, 1)
  nowMs += 200
  await s.tick() // 退避中，不调用
  assert.equal(calls, 1)
  fail = false
  nowMs += 5000
  await s.tick()
  assert.equal(calls, 2)
  assert.equal(s._state.get('kimi').fail, 0)
})

test('scheduler: 压缩事件时间变化也要广播（used 同为 null）', async () => {
  let lastAt = 1000
  const adapters = [
    fakeAdapter('zcode', () => ({
      supported: true,
      used: null,
      limit: 200000,
      sessionId: 's',
      confidence: 'derived',
      compaction: { count: 1, lastAt, derived: false },
      updatedAt: lastAt,
    })),
  ]
  let nowMs = 5000
  const service = createContextService({ adapters, now: () => nowMs, ttlMs: 0 })
  const sse = fakeSse(1)
  const s = createContextScheduler({
    adapters,
    service,
    sse,
    getSettings: () => ({ pet: { mode: 'attached', agentId: 'zcode' } }),
    now: () => nowMs,
    pollMs: { default: 1000 },
  })
  await s.tick()
  assert.equal(sse.events.filter((e) => e.e === 'context').length, 1)
  lastAt = 4000
  nowMs += 2000
  await s.tick()
  const events = sse.events.filter((e) => e.e === 'context')
  assert.equal(events.length, 2, '压缩时间变化应触发 context 广播')
  assert.equal(events[1].d.context.used, null)
  assert.equal(events[1].d.context.compaction.lastAt, 4000)
})
