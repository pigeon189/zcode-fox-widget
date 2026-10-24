// D034 会话模型：异常输入清洗 / key / 状态聚合 / 游标
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateOf,
  compareSessionToCursor,
  compareSessions,
  compareSessionsForSort,
  cursorOf,
  matchesArchived,
  normalizeArchivedMode,
  normalizeSession,
  parseCursor,
  statusLabel,
  summarizeSession,
} from '../../shared/session-model.mjs'

const base = (over = {}) =>
  normalizeSession(
    {
      agentId: 'zcode',
      sessionId: 'ses_1',
      title: '会话',
      status: 'working',
      statusSource: 'db',
      updatedAt: 1000,
      tokens: { total: 10 },
      ...over,
    },
    { now: 2000 }
  )

test('session-model: key = agentId:sessionId，且不可被 raw.key 冒充', () => {
  const s = base({ key: 'evil:ses_1', sessionId: 'ses_1' })
  assert.equal(s.key, 'zcode:ses_1')
  assert.equal(base({ sessionId: 'a b/c' }).sessionId, 'abc')
  assert.equal(base({ agentId: 'Bad' }).key, 'generic:ses_1')
})

test('session-model: 数字清洗（字符串 / 负数 / NaN / Infinity / 巨大值）', () => {
  const s = base({
    tokens: { total: '12.7', input: -5, output: NaN, cacheRead: Infinity, cacheWrite: 1e30, reasoning: 'x' },
    turns: { count: '3', avgDurationMs: -1 },
    tools: { calls: '7', errors: -2, running: [{ name: 'Bash', since: 'oops' }, null, {}] },
  })
  assert.equal(s.tokens.total, 13)
  assert.equal(s.tokens.input, 0)
  assert.equal(s.tokens.output, null)
  assert.equal(s.tokens.cacheRead, null)
  assert.equal(s.tokens.cacheWrite, Number.MAX_SAFE_INTEGER)
  assert.equal(s.tokens.reasoning, null)
  assert.equal(s.turns.count, 3)
  assert.equal(s.turns.avgDurationMs, 0)
  assert.equal(s.tools.calls, 7)
  assert.equal(s.tools.errors, 0)
  assert.deepEqual(s.tools.running, [{ name: 'Bash', since: null }])
})

test('session-model: 循环对象/__proto__ 不污染原型，未知字段被丢弃', () => {
  const evil = { agentId: 'zcode', sessionId: 'ses_x', title: 'x', __proto__: { polluted: true }, constructor: { x: 1 } }
  evil.self = evil
  const s = normalizeSession(evil, { now: 1 })
  assert.equal({}.polluted, undefined)
  assert.equal('self' in s, false)
  assert.equal(Object.prototype.hasOwnProperty.call(s, 'constructor'), false)
})

test('session-model: 字符串长度夹取，错误消息脱敏', () => {
  const s = base({ title: 'x'.repeat(500), cwd: 'y'.repeat(600), errors: { last: { at: 1, kind: 'tool', message: 'sk-' + 'a'.repeat(40) } } })
  assert.equal(s.title.length, 200)
  assert.equal(s.cwd.length, 400)
  assert.ok(!s.errors.last.message.includes('sk-'))
})

test('session-model: unknown 状态带 unavailable/host-unsupported', () => {
  const s = base({ status: 'weird' })
  assert.equal(s.status, 'unknown')
  assert.equal(s.provenance.status.kind, 'unavailable')
  assert.equal(s.provenance.status.reason, 'host-unsupported')
  assert.equal(statusLabel(s.status), '状态未知')
})

test('session-model: aggregateOf 优先级与计数', () => {
  const list = [
    base({ sessionId: 'a', status: 'working' }),
    base({ sessionId: 'b', status: 'error' }),
    base({ sessionId: 'c', status: 'waiting_input' }),
    base({ sessionId: 'd', status: 'done' }),
  ]
  const agg = aggregateOf(list)
  assert.equal(agg.aggregate, 'error')
  assert.equal(agg.counts.working, 1)
  assert.equal(agg.counts.waiting, 1)
  assert.equal(agg.counts.error, 1)
  assert.equal(agg.counts.done, 1)
  assert.equal(aggregateOf([base({ status: 'waiting_permission' }), ...list]).aggregate, 'waiting_permission')
  assert.equal(aggregateOf([]).aggregate, 'idle')
  assert.equal(aggregateOf([base({ status: 'unknown' })]).aggregate, 'unknown')
})

test('session-model: 排序缺值排最后（不是当 0）', () => {
  const a = base({ sessionId: 'a', tokens: { total: null }, updatedAt: 5 })
  const b = base({ sessionId: 'b', tokens: { total: 0 }, updatedAt: 1 })
  const c = base({ sessionId: 'c', tokens: { total: 100 }, updatedAt: 2 })
  assert.deepEqual([a, b, c].sort((x, y) => compareSessions(x, y, 'tokens')).map((x) => x.sessionId), ['c', 'b', 'a'])
})

test('session-model: 游标 base64url 往返；非法游标返回 null；兼容老 {u,k}', () => {
  const s = base({ updatedAt: 123456 })
  const cur = cursorOf(s)
  assert.match(cur, /^[A-Za-z0-9_-]+$/)
  const parsed = parseCursor(cur)
  assert.equal(parsed.updatedAt, 123456)
  assert.equal(parsed.key, 'zcode:ses_1')
  assert.equal(parsed.sort, 'updated')
  assert.equal(parsed.val, 123456)
  assert.equal(parseCursor('not-a-cursor'), null)
  assert.equal(parseCursor(''), null)
  const legacy = Buffer.from(JSON.stringify({ u: 777, k: 'zcode:old' }), 'utf8').toString('base64url')
  assert.deepEqual(
    { updatedAt: parseCursor(legacy).updatedAt, key: parseCursor(legacy).key, val: parseCursor(legacy).val },
    { updatedAt: 777, key: 'zcode:old', val: 777 }
  )
})

test('session-model: archived 只认 === true，摘要保留 archived', () => {
  assert.equal(base().archived, false)
  assert.equal(base({ archived: 1 }).archived, false)
  assert.equal(base({ archived: 'true' }).archived, false)
  assert.equal(base({ archived: true }).archived, true)
  assert.equal(summarizeSession(base({ archived: true })).archived, true)
  assert.equal(summarizeSession(base()).archived, false)
})

test('session-model: 归档三态过滤', () => {
  const active = base({ sessionId: 'a' })
  const archived = base({ sessionId: 'b', archived: true })
  assert.deepEqual([active, archived].filter((s) => matchesArchived(s, 'exclude')).map((s) => s.sessionId), ['a'])
  assert.deepEqual([active, archived].filter((s) => matchesArchived(s, 'only')).map((s) => s.sessionId), ['b'])
  assert.equal([active, archived].filter((s) => matchesArchived(s, 'all')).length, 2)
  assert.equal(normalizeArchivedMode('ONLY'), 'only')
  assert.equal(normalizeArchivedMode('weird'), 'exclude')
  assert.equal(normalizeArchivedMode(undefined), 'exclude')
})

test('session-model: 全序比较器在等值时不返回 0（按 key 升序）', () => {
  const a = base({ sessionId: 'a', updatedAt: 500 })
  const b = base({ sessionId: 'b', updatedAt: 500 })
  assert.equal(compareSessionsForSort(a, b, 'updated'), -1)
  assert.equal(compareSessionsForSort(b, a, 'updated'), 1)
  assert.equal(compareSessionsForSort(a, a, 'updated'), 0)
  const sorted = [b, a].sort((x, y) => compareSessionsForSort(x, y, 'updated'))
  assert.deepEqual(sorted.map((x) => x.sessionId), ['a', 'b'])
})

test('session-model: keyset 游标定位不受锚点删除影响', () => {
  const a = base({ sessionId: 'a', updatedAt: 300 })
  const b = base({ sessionId: 'b', updatedAt: 200 })
  const c = base({ sessionId: 'c', updatedAt: 100 })
  const cur = parseCursor(cursorOf(b))
  assert.equal(compareSessionToCursor(c, 'updated', cur) > 0, true, 'c 在 b 之后')
  assert.equal(compareSessionToCursor(a, 'updated', cur) < 0, true, 'a 在 b 之前')
  // 锚点被删除后仍按 (val,key) 定位
  const parsed = parseCursor(cursorOf({ key: 'gone:z', updatedAt: 200 }, 'updated'))
  assert.equal(compareSessionToCursor(c, 'updated', parsed) > 0, true)
  assert.equal(compareSessionToCursor(a, 'updated', parsed) < 0, true)
})

test('session-model: pending 缺 expiresAt 时按 createdAt + 15s 兜底', () => {
  const s = base({ pending: [{ id: 'req-1', createdAt: 5000 }] })
  assert.equal(s.pending[0].createdAt, 5000)
  assert.equal(s.pending[0].expiresAt, 20000)
  const fallback = normalizeSession({ agentId: 'zcode', sessionId: 'x', pending: [{ id: 'r' }] }, { now: 9000 })
  assert.equal(fallback.pending[0].createdAt, 9000)
  assert.equal(fallback.pending[0].expiresAt, 24000)
})

test('session-model: summarizeSession 去掉大字段但保留来源', () => {
  const s = base({ cost: { amount: 1.2, currency: 'CNY', unit: 'money' }, tokens: { total: 9 } })
  const sum = summarizeSession(s)
  assert.equal(sum.tokens.total, 9)
  assert.equal(sum.cost.amount, 1.2)
  assert.equal(sum.provenance.status.kind, 'exact')
  assert.equal('errors' in sum, true)
})
