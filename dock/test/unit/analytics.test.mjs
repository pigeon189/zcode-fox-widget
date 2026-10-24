// M4 统计深化：环比 / 预测 / 重置倒计时
import assert from 'node:assert/strict'
import test from 'node:test'
import { addDays, dateKeyOf, daysBetween, delta, forecastMonth, previousPeriod, resetLabel, resetsIn } from '../../daemon/src/analytics.mjs'

test('analytics: previousPeriod 等长且紧邻之前（普通月 / 月初 / 闰日 / 年初）', () => {
  assert.deepEqual(previousPeriod({ from: '2026-10-01', to: '2026-10-21' }), { from: '2026-09-10', to: '2026-09-30' })
  assert.deepEqual(previousPeriod({ from: '2026-10-01', to: '2026-10-01' }), { from: '2026-09-30', to: '2026-09-30' })
  assert.deepEqual(previousPeriod({ from: '2024-03-01', to: '2024-03-07' }), { from: '2024-02-23', to: '2024-02-29' })
  assert.deepEqual(previousPeriod({ from: '2026-01-01', to: '2026-01-07' }), { from: '2025-12-25', to: '2025-12-31' })
  assert.deepEqual(previousPeriod({ from: '', to: '' }), { from: '', to: '' })
})

test('analytics: addDays / daysBetween / dateKeyOf', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01')
  assert.equal(addDays('2024-02-28', 1), '2024-02-29')
  assert.equal(daysBetween('2026-10-01', '2026-10-21'), 21)
  assert.equal(daysBetween('x', '2026-10-21'), null)
  assert.equal(dateKeyOf(new Date(2026, 0, 5).getTime()), '2026-01-05')
})

test('analytics: delta 的 prev=0/null/负数', () => {
  assert.deepEqual(delta(120, 100), { abs: 20, pct: 20, dir: 'up' })
  assert.deepEqual(delta(80, 100), { abs: -20, pct: -20, dir: 'down' })
  assert.deepEqual(delta(100, 100), { abs: 0, pct: 0, dir: 'flat' })
  assert.deepEqual(delta(100, 0), { abs: 100, pct: null, dir: 'na' })
  assert.deepEqual(delta(100, null), { abs: null, pct: null, dir: 'na' })
  assert.deepEqual(delta(null, 10), { abs: null, pct: null, dir: 'na' })
})

test('analytics: forecastMonth 样本 2/3/7 天、月初、月末', () => {
  const now = new Date(2026, 9, 21, 12).getTime()
  const days = []
  for (let i = 1; i <= 7; i++) days.push({ d: addDays('2026-10-21', -i), amount: i === 4 ? 0 : 2 })
  const r = forecastMonth({ days, now })
  assert.equal(r.ok, true)
  assert.equal(r.sampleDays, 6)
  assert.ok(r.value > 0)
  assert.equal(r.provenance.origin, 'pricing-table')
  const two = forecastMonth({ days: days.slice(0, 2).map((d) => ({ ...d, amount: 0 })), now })
  assert.equal(two.ok, false)
  assert.equal(two.reason, 'insufficient-sample')
  const monthStart = forecastMonth({
    days: days.map((d) => ({ ...d, d: d.d.replace('2026-10', '2026-11') })),
    now: new Date(2026, 10, 1, 9).getTime(),
  })
  assert.equal(monthStart.ok, false, '月初前 7 天不在本月也算样本；这里全给 0 → 样本不足')
  const endDays = []
  for (let i = 1; i <= 7; i++) endDays.push({ d: addDays('2026-10-31', -i), amount: 2 })
  const monthEnd = forecastMonth({ days: endDays, now: new Date(2026, 9, 31, 23).getTime() })
  assert.equal(monthEnd.ok, true)
  assert.equal(monthEnd.remainingDays, 0)
})

test('analytics: resetsIn 支持毫秒/ISO/空串/过去/非法', () => {
  const now = new Date('2026-10-21T10:00:00Z').getTime()
  assert.equal(resetsIn(now + 3600_000, now), 3600_000)
  assert.equal(resetsIn(new Date(now + 60_000).toISOString(), now), 60_000)
  assert.equal(resetsIn('', now), null)
  assert.equal(resetsIn(null, now), null)
  assert.equal(resetsIn(now - 1, now), null)
  assert.equal(resetsIn('not-a-date', now), null)
  assert.match(resetLabel(now + 3 * 3600_000, now), /小时后$/)
  assert.match(resetLabel(now + 90 * 60_000, now), /分后$/)
  assert.match(resetLabel(now + 30 * 3600_000, now), /^\d{2}-\d{2} \d{2}:\d{2}$/)
})
