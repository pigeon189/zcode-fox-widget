// D037 ingest 协议 v1：字段边界 / 模糊输入 / 限流 / 自定义 agent
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CUSTOM_AGENTS,
  mapLegacyEvent,
  rateAllowed,
  resetIngestState,
  validateIngest,
} from '../../daemon/src/ingest.mjs'

const base = (over = {}) => ({
  v: 1,
  agent: 'zcode',
  event: 'turn_start',
  sessionId: 'ses_1',
  ...over,
})

test('ingest: 合法事件通过并归一化字段', () => {
  resetIngestState()
  const r = validateIngest(base({ title: 'x'.repeat(300), cwd: 'c', toolInput: 'sk-' + 'a'.repeat(40) }), { now: 1000 })
  assert.equal(r.ok, true)
  assert.equal(r.event.title.length, 200)
  assert.ok(!r.event.preview.includes('sk-'))
  assert.equal(r.event.at, 1000)
})

test('ingest: v / agent / event / sessionId / requestId 的边界', () => {
  resetIngestState()
  assert.equal(validateIngest({ ...base(), v: 2 }).error, 'bad-field:v')
  assert.equal(validateIngest({ ...base(), v: '1' }).error, 'bad-field:v')
  assert.equal(validateIngest(base({ agent: 'Bad' })).error, 'bad-field:agent')
  assert.equal(validateIngest(base({ agent: 'A'.repeat(30) })).error, 'bad-field:agent')
  assert.equal(validateIngest(base({ event: 'nope' })).error, 'bad-field:event')
  assert.equal(validateIngest(base({ sessionId: 'bad space' })).error, 'bad-field:sessionId')
  assert.equal(validateIngest(base({ event: 'permission_request', requestId: 'short' })).error, 'bad-field:requestId')
  assert.equal(validateIngest(base({ event: 'permission_request', requestId: 'r'.repeat(16) })).ok, true)
})

test('ingest: 时间偏差 >5 分钟忽略 at 并记 skew', () => {
  resetIngestState()
  const r = validateIngest(base({ at: 1000 }), { now: 1000 + 6 * 60_000 })
  assert.equal(r.ok, true)
  assert.equal(r.event.skew, 1)
  assert.equal(r.event.at, 1000 + 6 * 60_000)
})

test('ingest: usage/cost 只收有限非负数；非法值不写入', () => {
  resetIngestState()
  const r = validateIngest(base({ event: 'usage', usage: { input: 10, output: -1, cacheRead: '5', cacheWrite: Infinity, reasoning: NaN }, cost: { amount: 1.2, currency: 'us' } }), { now: 1000 })
  assert.equal(r.ok, true)
  assert.deepEqual(r.event.usage, { input: 10, cacheRead: 5 })
  assert.equal(r.event.cost, null, 'currency 必须大写 3-8 位')
})

test('ingest: 自定义 agent 上限 8 个，超出 429', () => {
  resetIngestState()
  for (let i = 0; i < MAX_CUSTOM_AGENTS; i++) {
    const r = validateIngest(base({ agent: 'custom-' + i, sessionId: 's' + i }), { now: 1000 + i })
    assert.equal(r.ok, true)
  }
  const over = validateIngest(base({ agent: 'custom-x', sessionId: 'sx' }), { now: 2000 })
  assert.equal(over.ok, false)
  assert.equal(over.status, 429)
})

test('ingest: 重复事件 60s 内幂等', () => {
  resetIngestState()
  const evt = base({ event: 'permission_request', requestId: 'r'.repeat(16), at: 1000 })
  assert.equal(validateIngest(evt, { now: 1000 }).duplicate, false)
  assert.equal(validateIngest(evt, { now: 1100 }).duplicate, true)
  assert.equal(validateIngest(evt, { now: 70_000 }).duplicate, false)
})

test('ingest: 令牌桶 50 req/s、突发 100', () => {
  resetIngestState()
  let t = 1_000_000
  let allowed = 0
  for (let i = 0; i < 100; i++) if (rateAllowed(t)) allowed++
  assert.equal(allowed, 100)
  assert.equal(rateAllowed(t), false)
  assert.equal(rateAllowed(t + 20), true, '20ms 补 1 个令牌')
})

test('ingest: 模糊测试 5000 个随机 JSON，只能 ok 或确定 4xx，绝不抛异常', () => {
  resetIngestState()
  let seed = 7
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const values = [null, 0, -1, 1.5, Infinity, NaN, '', 'x', 'sk-' + 'a'.repeat(30), [], {}, true, false, '__proto__', '\u0000', 'a'.repeat(1000)]
  for (let i = 0; i < 5000; i++) {
    const obj = {}
    const keys = ['v', 'agent', 'event', 'sessionId', 'at', 'title', 'toolInput', 'usage', 'cost', 'wait', 'requestId', 'nested', '__proto__']
    for (let k = 0; k < 1 + Math.floor(rand() * 8); k++) {
      const key = keys[Math.floor(rand() * keys.length)]
      const val = values[Math.floor(rand() * values.length)]
      obj[key] = val
    }
    if (rand() < 0.3) obj.usage = { input: values[Math.floor(rand() * values.length)] }
    if (rand() < 0.2) obj.wait = { mode: rand() < 0.5 ? 'decision' : 'x', timeoutMs: values[Math.floor(rand() * values.length)] }
    if (rand() < 0.1) obj.__proto__ = { polluted: true }
    let r
    assert.doesNotThrow(() => {
      r = validateIngest(obj, { now: 1000 + i })
    })
    assert.equal(typeof r.ok, 'boolean')
    if (!r.ok) {
      assert.ok([400, 429].includes(r.status), 'error status must be 4xx: ' + JSON.stringify(r))
      assert.ok(String(r.error).startsWith('bad-field:') || r.error === 'too-many-agents' || r.error === 'bad-body')
    }
  }
  assert.equal({}.polluted, undefined)
})

test('ingest: 旧事件类型映射', () => {
  assert.equal(mapLegacyEvent('permission-request', 'zcode').event, 'permission_request')
  assert.equal(mapLegacyEvent('user-prompt', 'workbuddy').event, 'turn_start')
  assert.equal(mapLegacyEvent('unknown', 'evil').agent, 'zcode')
})
