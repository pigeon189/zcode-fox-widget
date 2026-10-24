// D033 provenance：构造 / 降级 / 合并 / UI 四标签
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROV_KINDS,
  PROV_ORIGINS,
  isProv,
  normalizeProv,
  prov,
  uiLabelOf,
  unavailable,
  worstOf,
} from '../../shared/provenance.mjs'

test('provenance: prov() 校验 kind/origin/source/asOf', () => {
  const p = prov('exact', 'local-db', 'zcode:db', { asOf: 123 })
  assert.equal(p.kind, 'exact')
  assert.equal(p.origin, 'local-db')
  assert.equal(p.source, 'zcode:db')
  assert.equal(p.asOf, 123)
  const bad = prov('nope', 'nope', '', {})
  assert.equal(bad.kind, 'unavailable')
  assert.equal(bad.origin, 'unknown')
  assert.equal(bad.reason, 'no-data')
})

test('provenance: PROV_KINDS / PROV_ORIGINS 是固定集合', () => {
  assert.deepEqual(PROV_KINDS, ['exact', 'estimated', 'unavailable'])
  assert.deepEqual(PROV_ORIGINS, ['api', 'local-db', 'local-log', 'pricing-table', 'user', 'unknown'])
})

test('provenance: normalizeProv 对 null/数字/未知 kind 降级', () => {
  for (const raw of [null, 42, 'exact', [], { kind: 'exact', origin: 'nope' }, { kind: 'nope', origin: 'api' }]) {
    const p = normalizeProv(raw)
    assert.equal(p.kind, 'unavailable')
    assert.equal(p.origin, 'unknown')
    assert.equal(p.reason, 'schema')
    assert.ok(isProv(p))
  }
  const fallback = normalizeProv(null, { reason: 'not-running', origin: 'api', source: 'kimi' })
  assert.equal(fallback.reason, 'not-running')
  assert.equal(fallback.origin, 'api')
})

test('provenance: unavailable 必须带 reason，否则降级 no-data', () => {
  assert.equal(unavailable().reason, 'no-data')
  assert.equal(unavailable('auth').reason, 'auth')
  const p = normalizeProv({ kind: 'unavailable', origin: 'api', source: 'x' })
  assert.equal(p.reason, 'no-data')
})

test('provenance: worstOf 取最差 kind，origin 取最弱', () => {
  const exactApi = prov('exact', 'api', 'a')
  const estLog = prov('estimated', 'local-log', 'b')
  const unavail = unavailable('no-data', 'c', 'pricing-table')
  assert.equal(worstOf(exactApi, estLog).kind, 'estimated')
  assert.equal(worstOf(exactApi, estLog).origin, 'local-log')
  assert.equal(worstOf(exactApi, estLog, unavail).kind, 'unavailable')
  assert.equal(worstOf(exactApi, estLog, unavail).origin, 'pricing-table')
  assert.equal(worstOf(exactApi, estLog, unavail).reason, 'no-data')
  assert.equal(worstOf().kind, 'unavailable')
  // 全排列都满足：结果不会比任一项更可信
  const list = [exactApi, estLog, unavail]
  for (const a of list) for (const b of list) {
    const w = worstOf(a, b)
    assert.ok(w.kind === 'unavailable' || (w.kind === 'estimated' && (a.kind !== 'exact' || b.kind !== 'exact')) || (w.kind === 'exact' && a.kind === 'exact' && b.kind === 'exact'))
  }
})

test('provenance: uiLabelOf 的 8 种组合', () => {
  assert.equal(uiLabelOf(prov('exact', 'api', '')), 'official')
  assert.equal(uiLabelOf(prov('exact', 'local-db', '')), 'local')
  assert.equal(uiLabelOf(prov('exact', 'local-log', '')), 'local')
  assert.equal(uiLabelOf(prov('exact', 'pricing-table', '')), 'estimate')
  assert.equal(uiLabelOf(prov('exact', 'user', '')), 'estimate')
  assert.equal(uiLabelOf(prov('exact', 'unknown', '')), 'estimate')
  assert.equal(uiLabelOf(prov('estimated', 'api', '')), 'estimate')
  assert.equal(uiLabelOf(prov('estimated', 'local-log', '')), 'estimate')
  assert.equal(uiLabelOf(unavailable('no-data', '')), 'unavailable')
  assert.equal(uiLabelOf(null), 'unavailable')
})
