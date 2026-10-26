// 控制台金额格式化：缺失（null/空串）必须显示「不可得」，不能被 Number(null)=0 编成 0 元。
import assert from 'node:assert/strict'
import test from 'node:test'
import { fmtCredit, fmtMoney, fmtUnit } from '../../ui/lib/format.mjs'

test('format: 金额/积分缺失显示「—」，不编 0', () => {
  assert.equal(fmtMoney(null), '—')
  assert.equal(fmtMoney(undefined), '—')
  assert.equal(fmtMoney(''), '—')
  assert.equal(fmtMoney(null, 'USD'), '—')
  assert.equal(fmtCredit(null), '—')
  assert.equal(fmtUnit({ amount: null, currency: 'CNY' }, 'money'), '—')
})

test('format: 真实的 0 仍按 0 显示', () => {
  assert.equal(fmtMoney(0), '¥0.00')
  assert.equal(fmtMoney(0, 'USD'), '$0.00')
  assert.equal(fmtCredit(0), '0 积分')
})
