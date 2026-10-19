import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  addAdjustment,
  applyAdjustments,
  listAdjustments,
  removeAdjustment,
} from '../../daemon/src/balance-adjustments.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-adj-'))
const file = path.join(dir, 'balance-adjustments.json')

after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

test('adjustments: add / subtract / set 按时间顺序作用，币种不混算', () => {
  const a = addAdjustment(file, { vendorId: 'deepseek', type: 'add', amount: 10, currency: 'CNY', note: '赠送' })
  const b = addAdjustment(file, { vendorId: 'deepseek', type: 'subtract', amount: 2.5, currency: 'CNY' })
  const c = addAdjustment(file, { vendorId: 'deepseek', type: 'set', amount: 20, currency: 'CNY' })
  addAdjustment(file, { vendorId: 'deepseek', type: 'add', amount: 99, currency: 'USD' })
  assert.equal(applyAdjustments(5, listAdjustments(file, 'deepseek'), 'CNY'), 20)
  assert.equal(applyAdjustments(5, listAdjustments(file, 'deepseek'), 'USD'), 104)
  assert.equal(listAdjustments(file, 'deepseek').length, 4)
  assert.ok(a.id && b.id && c.id)
})

test('adjustments: 无修正时原值返回，null 保持 null', () => {
  assert.equal(applyAdjustments(12.34, [], 'CNY'), 12.34)
  assert.equal(applyAdjustments(null, [], 'CNY'), null)
})

test('adjustments: 非法类型/金额/币种被拒绝', () => {
  assert.throws(() => addAdjustment(file, { vendorId: 'xy', type: 'nope', amount: 1 }), /类型/)
  assert.throws(() => addAdjustment(file, { vendorId: 'xy', type: 'add', amount: -1 }), /金额/)
  assert.throws(() => addAdjustment(file, { vendorId: '../x', type: 'add', amount: 1 }), /vendorId/)
  const item = addAdjustment(file, { vendorId: 'kimi', type: 'add', amount: 1, currency: 'bad!' })
  assert.equal(item.currency, 'CNY')
})

test('adjustments: 删除单条', () => {
  const item = addAdjustment(file, { vendorId: 'kimi', type: 'add', amount: 3 })
  assert.equal(removeAdjustment(file, item.id).removed, true)
  assert.equal(removeAdjustment(file, item.id).removed, false)
})
