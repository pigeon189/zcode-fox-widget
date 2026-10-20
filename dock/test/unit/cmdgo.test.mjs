import test from 'node:test'
import assert from 'node:assert/strict'

import { CMDGO_PLANS, resolveCmdgoPlan, shapeCmdgoUsage, shapePoolQuota } from '../../engines/cmdgo.mjs'

const credits = {
  credits: { monthlyCredits: 40 },
  windowLimits: {
    fiveHour: { used: 1, cap: 14 },
    weekly: { used: 2, cap: 35 },
  },
}

test('cmdgo: GOAT 月度 credits 统一为 80，不再区分老账户', () => {
  const goat = CMDGO_PLANS.find((p) => p.id === 'individual-goat')
  assert.equal(goat.monthly, 80)
  assert.equal('legacyMonthly' in goat, false)

  const oldSub = { success: true, data: { planId: 'individual-goat', createdAt: '2026-09-29T14:05:55.000Z' } }
  const newSub = { success: true, data: { planId: 'individual-goat', createdAt: '2026-10-20T12:00:00Z' } }
  const oldPrice = { success: true, data: { planId: 'individual-goat', priceId: 'price_1U0sTYDSZgxV3MJKUKHcvFxc' } }
  for (const sub of [oldSub, newSub, oldPrice]) {
    const monthly = shapeCmdgoUsage(credits, sub, undefined).monthly
    assert.equal(monthly.total, 80)
    assert.equal('legacy' in monthly, false)
  }
})

test('cmdgo: 其它套餐的月度 credits 与帽对反查', () => {
  const cases = [
    ['individual-go', 10],
    ['individual-pro', 80],
    ['individual-max-10x', 150],
    ['individual-max-20x', 300],
    ['team-pro', 40],
  ]
  for (const [id, monthly] of cases) {
    assert.equal(resolveCmdgoPlan(id, 0, 0).monthly, monthly, id)
  }
  assert.equal(resolveCmdgoPlan(undefined, 3, 6).name, 'Go')
  assert.equal(resolveCmdgoPlan(undefined, 14, 35).name, 'GOAT')
  assert.equal(resolveCmdgoPlan(undefined, 16, 40).name, 'Pro')
  assert.equal(resolveCmdgoPlan(undefined, 45, 90).name, 'Max 10×')
})

test('cmdgo: 本地池 GOAT/Pro 月度池都按 80', () => {
  const goatPool = shapePoolQuota({
    id: 'goat',
    quota: { monthlyCredits: 40, fiveHour: { used: 1, cap: 14 }, weekly: { used: 2, cap: 35 } },
  })
  assert.equal(goatPool.monthly.total, 80)
  assert.equal('legacy' in goatPool.monthly, false)

  const proPool = shapePoolQuota({
    id: 'pro',
    quota: { monthlyCredits: 40, fiveHour: { used: 1, cap: 16 }, weekly: { used: 2, cap: 40 } },
  })
  assert.equal(proPool.monthly.total, 80)
  assert.equal('legacy' in proPool.monthly, false)
})
