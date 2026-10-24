// DeepSeek 余额构成（赠金 / 充值）链路：
//   balance.mjs#balanceSplit → vendors.mjs#splitFieldsOfBalance
//   → zcode/index.mjs#balanceSplitOfVendor → contracts.mjs#normalizeSnapshot
// 缺失一律 null，不补 0；真的 0 保留为 0。
import assert from 'node:assert/strict'
import test from 'node:test'
import { balanceSplit } from '../../engines/balance.mjs'
import { deepseekVendorStatus, splitFieldsOfBalance } from '../../engines/vendors.mjs'
import { balanceSplitOfVendor } from '../../adapters/zcode/index.mjs'
import { normalizeBalanceSplit, normalizeSnapshot } from '../../adapters/contracts.mjs'

test('balance: DeepSeek 赠金/充值字段拆出，缺失为 null、真实 0 保留', () => {
  assert.deepEqual(balanceSplit({ granted_balance: 1.25, topped_up_balance: 10.5 }), {
    grantedBalance: 1.25,
    toppedBalance: 10.5,
  })
  assert.deepEqual(balanceSplit({ granted_balance: 0, topped_up_balance: 0 }), {
    grantedBalance: 0,
    toppedBalance: 0,
  })
  assert.deepEqual(balanceSplit({}), { grantedBalance: null, toppedBalance: null })
  assert.deepEqual(balanceSplit({ granted_balance: '', topped_up_balance: 'abc' }), {
    grantedBalance: null,
    toppedBalance: null,
  })
  assert.deepEqual(balanceSplit(null), { grantedBalance: null, toppedBalance: null })
})

test('vendors: DeepSeek payload 只有成功且字段合法时才带构成', () => {
  assert.deepEqual(splitFieldsOfBalance({ ok: true, grantedBalance: 2, toppedBalance: 3, currency: 'CNY' }), {
    grantedBalance: 2,
    toppedBalance: 3,
    currency: 'CNY',
  })
  assert.deepEqual(splitFieldsOfBalance({ ok: true }), {
    grantedBalance: null,
    toppedBalance: null,
    currency: null,
  })
  assert.deepEqual(splitFieldsOfBalance({ ok: false, grantedBalance: 2, toppedBalance: 3 }), {
    grantedBalance: null,
    toppedBalance: null,
    currency: null,
  })
  const bad = splitFieldsOfBalance({ ok: true, grantedBalance: -1, toppedBalance: 'x', currency: 'cny' })
  assert.equal(bad.grantedBalance, null)
  assert.equal(bad.toppedBalance, null)
  assert.equal(bad.currency, null)
})

test('vendors: DeepSeek vendor 状态透出构成（失败/缺失为 null，币种回落模板）', () => {
  const base = { id: 'deepseek', name: 'DeepSeek', kind: 'balance', currency: 'CNY' }
  const ok = deepseekVendorStatus(base, {
    ok: true,
    totalBalance: 12.5,
    currency: 'USD',
    grantedBalance: 2.5,
    toppedBalance: 10,
  })
  assert.equal(ok.balance, 12.5)
  assert.equal(ok.grantedBalance, 2.5)
  assert.equal(ok.toppedBalance, 10)
  assert.equal(ok.currency, 'USD')

  const missing = deepseekVendorStatus(base, { ok: true, totalBalance: 1 })
  assert.equal(missing.grantedBalance, null)
  assert.equal(missing.toppedBalance, null)
  assert.equal(missing.currency, 'CNY', '余额接口没给币种时回落模板币种')

  const failed = deepseekVendorStatus(base, { ok: false, error: 'no key', grantedBalance: 2 })
  assert.equal(failed.available, false)
  assert.equal(failed.balance, undefined)
  assert.equal(failed.grantedBalance, null, '失败时不允许残留构成')
})

test('zcode: vendor 状态映射为 balanceSplit（其它厂商没有字段就是 null）', () => {
  assert.deepEqual(
    balanceSplitOfVendor({ balance: 12.34, currency: 'CNY', grantedBalance: 2.34, toppedBalance: 10 }),
    { granted: 2.34, topped: 10, currency: 'CNY' }
  )
  assert.equal(balanceSplitOfVendor({ balance: 12.34, currency: 'CNY' }), null, '没有构成字段 → null')
  assert.equal(balanceSplitOfVendor({ balance: null, grantedBalance: 2 }), null, '没有余额 → null')
  assert.equal(balanceSplitOfVendor(null), null)
  assert.deepEqual(balanceSplitOfVendor({ balance: 1, grantedBalance: 0 }), {
    granted: 0,
    topped: null,
    currency: null,
  })
})

test('contracts: balanceSplit 归一化，缺余额/两侧皆空/负数都收敛', () => {
  const s = normalizeSnapshot(
    {
      supported: true,
      unit: 'money',
      balance: { amount: 12.34567, currency: 'CNY' },
      balanceSplit: { granted: 2.34567, topped: 10, currency: 'CNY' },
    },
    { adapterId: 'zcode', now: 123 }
  )
  assert.deepEqual(s.balanceSplit, { granted: 2.3457, topped: 10, currency: 'CNY' })

  // 缺 currency 时跟随主余额
  const fallback = normalizeSnapshot(
    {
      supported: true,
      unit: 'money',
      balance: { amount: 1, currency: 'USD' },
      balanceSplit: { granted: 1 },
    },
    { adapterId: 'zcode' }
  )
  assert.deepEqual(fallback.balanceSplit, { granted: 1, topped: null, currency: 'USD' })

  // 非法币种同样回落到主余额
  const badCur = normalizeSnapshot(
    {
      supported: true,
      unit: 'money',
      balance: { amount: 1, currency: 'USD' },
      balanceSplit: { topped: 1, currency: 'usd' },
    },
    { adapterId: 'zcode' }
  )
  assert.equal(badCur.balanceSplit.currency, 'USD')

  // 两侧都拿不到 → 整行隐藏（不是 0/0）
  assert.equal(
    normalizeSnapshot(
      {
        supported: true,
        unit: 'money',
        balance: { amount: 1, currency: 'CNY' },
        balanceSplit: { granted: null, topped: null },
      },
      { adapterId: 'zcode' }
    ).balanceSplit,
    null
  )

  // 没有余额时不输出构成
  assert.equal(
    normalizeSnapshot(
      { supported: true, unit: 'money', balanceSplit: { granted: 1, topped: 2 } },
      { adapterId: 'zcode' }
    ).balanceSplit,
    null
  )

  // 负数一侧丢弃，另一侧保留
  const negative = normalizeSnapshot(
    {
      supported: true,
      unit: 'money',
      balance: { amount: 1, currency: 'CNY' },
      balanceSplit: { granted: -1, topped: 0 },
    },
    { adapterId: 'zcode' }
  )
  assert.deepEqual(negative.balanceSplit, { granted: null, topped: 0, currency: 'CNY' })

  // supported=false 时整块清空
  assert.equal(
    normalizeSnapshot({ supported: false, balanceSplit: { granted: 1, topped: 2 } }, { adapterId: 'generic' })
      .balanceSplit,
    null
  )
})

test('contracts: normalizeBalanceSplit 直接校验', () => {
  assert.equal(normalizeBalanceSplit(null, { balance: { amount: 1, currency: 'CNY' } }), null)
  assert.equal(normalizeBalanceSplit({ granted: 1 }, {}), null, '没有主余额就不输出')
  assert.deepEqual(normalizeBalanceSplit({ granted: 0 }, { balance: { amount: 1, currency: 'CNY' } }), {
    granted: 0,
    topped: null,
    currency: 'CNY',
  })
})
