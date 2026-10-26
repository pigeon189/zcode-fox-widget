// 套餐按模型分桶（D053）：GLM 赠送池的每个模型桶要能直接画进度条，
// 快览卡与控制台额度页共用同一份结构（quotaCard.buckets）。
//   · 引擎侧：planVendorStatus 的 byModel 补 0–100 百分比（plan-vendor-status.test.mjs）
//   · 适配器侧：vendor.byModel → quotaCard.buckets（本文件上半）
//   · 契约侧：normalizeQuotaCard 净化桶、总额不可得整条丢弃（本文件下半）
import assert from 'node:assert/strict'
import test from 'node:test'
import { bucketsOfVendor, quotaCardOf } from '../../adapters/zcode/index.mjs'
import { normalizeQuotaCard } from '../../adapters/contracts.mjs'

const VENDOR = {
  id: 'zcode-plan',
  name: 'GLM Plan',
  kind: 'local-log',
  percentRemaining: 0.2,
  byModel: [
    { model: 'glm-5.3-flash', showName: 'GLM-5.3-Flash', remainingUnits: 0, totalUnits: 300000000, percentRemaining: 0, percentUsed: 100 },
    { model: 'glm-5.3', showName: 'GLM-5.3', remainingUnits: 767206, totalUnits: 200000000, percentRemaining: 0.4, percentUsed: 99.6 },
  ],
}

test('bucketsOfVendor: 每个模型桶带 0–100 百分比与剩余/总量', () => {
  const buckets = bucketsOfVendor(VENDOR)
  assert.equal(buckets.length, 2)
  assert.equal(buckets[0].key, 'glm-5.3-flash')
  assert.equal(buckets[0].label, 'GLM-5.3-Flash')
  assert.equal(buckets[0].remainingPct, 0)
  assert.equal(buckets[0].usedPct, 100)
  assert.equal(buckets[1].remainingPct, 0.4)
  assert.equal(buckets[1].usedPct, 99.6)
  assert.equal(buckets[1].remaining, 767206)
  assert.equal(buckets[1].total, 200000000)
})

test('bucketsOfVendor: total 不可得或非法的桶丢弃，不补 0', () => {
  const buckets = bucketsOfVendor({
    byModel: [
      { model: 'a', remainingUnits: 10, totalUnits: 0 },
      { model: 'b', remainingUnits: 10 },
      { model: 'c', remainingUnits: 'x', totalUnits: 100 },
      null,
      { model: 'd', remainingUnits: 50, totalUnits: 100 },
    ],
  })
  assert.deepEqual(buckets.map((b) => b.key), ['d'])
  assert.equal(buckets[0].remainingPct, 50)
})

test('bucketsOfVendor: 没有 byModel（接口源/其它厂商）返回空数组', () => {
  assert.deepEqual(bucketsOfVendor({ id: 'zcode-plan' }), [])
  assert.deepEqual(bucketsOfVendor(null), [])
})

test('quotaCardOf: GLM 套餐卡 kind=plan 且带 buckets（快览卡/控制台顶部卡数据源）', () => {
  const active = { ...VENDOR, id: 'zcode-plan', name: 'GLM Plan', kind: 'local-log', byModel: VENDOR.byModel }
  const card = quotaCardOf([active], active)
  assert.equal(card.kind, 'plan')
  assert.equal(card.source, 'zcode-plan')
  assert.equal(card.buckets.length, 2)
  // 汇总百分比不作为主数字的唯一来源：note 明说分桶在下方
  assert.match(card.note, /按模型分桶/)
  // 契约层净化后仍是两条（这是快览卡真正拿到的结构）
  assert.equal(normalizeQuotaCard(card, { adapterName: 'ZCode' }).buckets.length, 2)
})

test('quotaCardOf: 没有活动厂商时不造 buckets', () => {
  const card = quotaCardOf([], null)
  assert.equal(card.kind, 'plan')
  assert.equal(card.buckets, undefined)
})

test('contracts: quotaCard.buckets 净化且保留百分比（快览卡与额度页共用）', () => {
  const card = normalizeQuotaCard({
    kind: 'plan',
    plan: 'GLM Plan',
    note: '总剩余只作参考',
    buckets: [
      { key: 'GLM-5.3-Flash', label: 'GLM-5.3-Flash', remaining: 0, total: 300000000 },
      { label: 'GLM-5.3', remaining: 767206, total: 200000000, remainingPct: 0.4 },
      { label: '', remaining: 1, total: 2 },
      { label: '无总额', remaining: 1, total: 0 },
      { label: '负数', remaining: -1, total: 100 },
    ],
  })
  assert.equal(card.kind, 'plan')
  assert.equal(card.buckets.length, 2)
  assert.equal(card.buckets[0].key, 'glm-5.3-flash')
  assert.equal(card.buckets[0].label, 'GLM-5.3-Flash')
  // 没给百分比时按同条目 remaining/total 推，usedPct 跟着反推
  assert.equal(card.buckets[0].remainingPct, 0)
  assert.equal(card.buckets[0].usedPct, 100)
  assert.equal(card.buckets[1].remainingPct, 0.4)
  assert.equal(card.buckets[1].usedPct, 99.6)
})

test('contracts: 没有 buckets 字段的旧 payload 得到空数组（UI 按无桶渲染）', () => {
  const card = normalizeQuotaCard({ kind: 'plan', plan: 'Free' })
  assert.deepEqual(card.buckets, [])
})
