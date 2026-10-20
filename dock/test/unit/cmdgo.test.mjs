import test from 'node:test'
import assert from 'node:assert/strict'

import { CMDGO_GOAT_CREDITS_FROM, CMDGO_PLANS, resolveCmdgoPlan, shapeCmdgoUsage, shapePoolQuota } from '../../engines/cmdgo.mjs'

const credits = {
  credits: { monthlyCredits: 40 },
  windowLimits: {
    fiveHour: { used: 1, cap: 14 },
    weekly: { used: 2, cap: 35 },
  },
}

test('cmdgo: 2026-10-20 起 GOAT 月度 credits 为 80，老账户保留 70', () => {
  const goat = CMDGO_PLANS.find((p) => p.id === 'individual-goat')
  assert.equal(goat.monthly, 80)
  assert.equal(goat.legacyMonthly, 70)
  assert.ok(CMDGO_GOAT_CREDITS_FROM > 0)

  const oldSub = { success: true, data: { planId: 'individual-goat', createdAt: '2026-09-29T14:05:55.000Z' } }
  const newSub = { success: true, data: { planId: 'individual-goat', createdAt: '2026-10-20T12:00:00Z' } }
  // 缺少 createdAt：只有已知老 priceId 才按 70，其余按新 80（本地池不能默认老账户）
  const noCreated = { success: true, data: { planId: 'individual-goat', priceId: 'price_unknown' } }
  const oldPrice = { success: true, data: { planId: 'individual-goat', priceId: 'price_1U0sTYDSZgxV3MJKUKHcvFxc' } }
  assert.equal(shapeCmdgoUsage(credits, oldSub, undefined).monthly.total, 70)
  assert.equal(shapeCmdgoUsage(credits, oldSub, undefined).monthly.legacy, true)
  assert.equal(shapeCmdgoUsage(credits, newSub, undefined).monthly.total, 80)
  assert.equal(shapeCmdgoUsage(credits, newSub, undefined).monthly.legacy, false)
  assert.equal(shapeCmdgoUsage(credits, noCreated, undefined).monthly.total, 80)
  assert.equal(shapeCmdgoUsage(credits, noCreated, undefined).monthly.legacy, false)
  assert.equal(shapeCmdgoUsage(credits, oldPrice, undefined).monthly.total, 70)
  assert.equal(shapeCmdgoUsage(credits, oldPrice, undefined).monthly.legacy, true)
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

test('cmdgo: 本地池没有 createdAt 时按新 80 档，不默认老账户', () => {
  const oldCapsPool = shapePoolQuota({
    id: 'goat-old-caps',
    quota: { monthlyCredits: 40, fiveHour: { used: 1, cap: 14 }, weekly: { used: 2, cap: 35 } },
  })
  assert.equal(oldCapsPool.monthly.total, 80)
  assert.equal(oldCapsPool.monthly.legacy, false)

  const proPool = shapePoolQuota({
    id: 'pro',
    quota: { monthlyCredits: 40, fiveHour: { used: 1, cap: 16 }, weekly: { used: 2, cap: 40 } },
  })
  assert.equal(proPool.monthly.total, 80)
  assert.equal(proPool.monthly.legacy, false)
})
