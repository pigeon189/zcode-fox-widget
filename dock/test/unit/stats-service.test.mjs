import test from 'node:test'
import assert from 'node:assert/strict'

import { createStatsService } from '../../daemon/src/stats-service.mjs'

test('stats service: 按宿主/范围缓存，force 绕过', async () => {
  let calls = 0
  let seen = null
  const adapter = {
    id: 'demo',
    async getStats(opts) {
      calls += 1
      seen = opts
      return { supported: true, range: opts.range, summary: { totalTokens: calls } }
    },
  }
  let now = Date.UTC(2026, 9, 21, 12, 0, 0)
  const svc = createStatsService({ adapters: [adapter], ttlMs: 1000, now: () => now })
  const a = await svc.get('demo', { range: '7d' })
  const b = await svc.get('demo', { range: '7d' })
  assert.equal(a.summary.totalTokens, 1)
  assert.equal(b.cached, true)
  assert.equal(calls, 1)
  assert.equal(seen.range, '7d')
  assert.equal(seen.since, now - 7 * 86400000)
  const c = await svc.get('demo', { range: '7d', force: true })
  assert.equal(c.summary.totalTokens, 2)
  assert.equal(calls, 2)
  now += 1500
  await svc.get('demo', { range: '7d' })
  assert.equal(calls, 3)
})

test('stats service: 未知宿主 / 未实现 getStats 返回可读原因', async () => {
  const svc = createStatsService({ adapters: [{ id: 'plain' }] })
  const a = await svc.get('missing')
  assert.equal(a.supported, false)
  assert.equal(a.reason, 'stats-unavailable')
  const b = await svc.get('plain')
  assert.equal(b.supported, false)
  assert.equal(b.reason, 'stats-unavailable')
})
