// GLM Plan（zcode-plan / local-log）百分比口径：
//   plan 引擎（plan-balance / glm-plan-api）给的是 0–1 比例（percentRemaining = remaining/total，
//   同一条目同单位）；vendor 状态与 UI 契约是 0–100 百分数。
//   vendors.mjs#planVendorStatus 负责换算；缺失（total 不可得）不输出百分比，绝不编 0。
//   host-vendors.mjs（1.x 挂件线回退源）做同一换算。
import assert from 'node:assert/strict'
import test from 'node:test'
import { planVendorStatus } from '../../engines/vendors.mjs'
import { fmtPct } from '../../ui/lib/format.mjs'

const BASE = { id: 'zcode-plan', name: 'GLM Plan', kind: 'local-log', currency: 'tokens' }

test('plan: remaining==total（500M/500M，plan-log 源）→ 100% 剩余', () => {
  // 2026-10-24 本机实测 /v1/vendors 的 zcode-plan 条目：
  // remaining=500000000 total=500000000 source=plan-log stale=false
  const v = planVendorStatus(BASE, {
    ok: true,
    source: 'plan-log',
    stale: false,
    remaining: 500000000,
    total: 500000000,
    used: 0,
    percentRemaining: 500000000 / 500000000, // plan-balance.mjs 的 0–1 比例
    nextResetAt: 1795000000000,
  })
  assert.equal(v.available, true)
  assert.equal(v.source, 'plan-log')
  assert.equal(v.percentRemaining, 100)
  assert.equal(v.remaining, 500000000)
  assert.equal(v.total, 500000000)
  assert.equal(v.stale, false)
  // 前端实际渲染路径（ui/pages/quota.mjs 的 fmtPct(v.percentRemaining) + ' 剩余'）
  assert.equal(fmtPct(v.percentRemaining) + ' 剩余', '100% 剩余')
})

test('plan: 比例 0–1 → 百分数（0.0675 → 6.8，一位小数）', () => {
  const v = planVendorStatus(BASE, { ok: true, source: 'plan-log', percentRemaining: 0.0675, remaining: 135, total: 2000 })
  assert.equal(v.percentRemaining, 6.8)
  // overview.mjs 的用量条：100 − percentRemaining
  assert.equal(100 - v.percentRemaining, 93.2)
})

test('plan: total 缺失（percentRemaining=null）→ 不输出百分比，不编 0', () => {
  const v = planVendorStatus(BASE, { ok: true, source: 'plan-log', percentRemaining: null, remaining: 0, total: 0 })
  assert.equal(v.available, true)
  assert.equal(v.percentRemaining, undefined)
  assert.equal('percentRemaining' in v, true, '字段存在但值为 undefined（JSON 序列化时丢弃）')
  // UI 判空口径：v.percentRemaining != null → 不显示百分比
  assert.notEqual(v.percentRemaining != null, true)
})

test('plan: 引擎失败 → available=false，无百分比，带 reason', () => {
  const v = planVendorStatus(BASE, { ok: false, reason: 'no-plan-log' })
  assert.equal(v.available, false)
  assert.equal(v.reason, 'no-plan-log')
  assert.equal(v.percentRemaining, undefined)
  assert.equal(v.remaining, undefined)
})

test('plan: 直连接口源（glm-plan-api，单位=额度点数）同样换算且同条目', () => {
  const v = planVendorStatus(BASE, {
    ok: true,
    source: 'glm-plan-api',
    unit: 'credits',
    percentRemaining: 158 / 2000,
    remaining: 158,
    total: 2000,
  })
  assert.equal(v.source, 'glm-plan-api')
  assert.equal(v.percentRemaining, 7.9)
  // 百分比与 remaining/total 同一条目：158/2000 = 7.9%
  assert.equal(Math.round((v.remaining / v.total) * 1000) / 10, v.percentRemaining)
})
