// 统一账本（R7）：覆盖写入 / 单位隔离 / 币种隔离 / 修剪
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KEEP_DAYS, dayKeyOf, readLedger, recordSnapshot, summarize } from '../../daemon/src/ledger.mjs'

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ledger-'))
  return { file: path.join(dir, 'ledger.json'), dir }
}

const T = new Date(2026, 9, 18, 20, 0, 0).getTime()

const moneySnap = (amount, currency = 'CNY') => ({
  ok: true,
  adapterId: 'zcode',
  adapterName: 'ZCode',
  supported: true,
  unit: 'money',
  today: { amount, currency, byCurrency: { [currency]: amount } },
})

const creditSnap = (amount) => ({
  ok: true,
  adapterId: 'workbuddy',
  adapterName: 'WorkBuddy',
  supported: true,
  unit: 'credit',
  today: { amount, currency: 'CREDIT', byCurrency: { CREDIT: amount } },
})

test('ledger: 记录后今日汇总包含该适配器', () => {
  const { file, dir } = tempLedger()
  try {
    recordSnapshot(file, { adapterId: 'zcode', adapterName: 'ZCode', snapshot: moneySnap(1.23), now: T })
    const s = summarize(file, { now: T })
    assert.equal(s.today.date, dayKeyOf(T))
    assert.equal(s.today.groups.length, 1)
    assert.deepEqual(s.today.groups[0], {
      unit: 'money',
      currency: 'CNY',
      amount: 1.23,
      tokens: 0,
      adapters: [{ id: 'zcode', name: 'ZCode', amount: 1.23, tokens: 0 }],
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: 同一适配器重复写入是覆盖（累计值不是增量）', () => {
  const { file, dir } = tempLedger()
  try {
    recordSnapshot(file, { adapterId: 'zcode', adapterName: 'ZCode', snapshot: moneySnap(1), now: T })
    recordSnapshot(file, { adapterId: 'zcode', adapterName: 'ZCode', snapshot: moneySnap(1), now: T + 1000 })
    recordSnapshot(file, { adapterId: 'zcode', adapterName: 'ZCode', snapshot: moneySnap(2.5), now: T + 2000 })
    const s = summarize(file, { now: T })
    assert.equal(s.today.groups[0].amount, 2.5)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: 元与积分不混算（各自成组）', () => {
  const { file, dir } = tempLedger()
  try {
    recordSnapshot(file, { adapterId: 'zcode', adapterName: 'ZCode', snapshot: moneySnap(3), now: T })
    recordSnapshot(file, { adapterId: 'workbuddy', adapterName: 'WorkBuddy', snapshot: creditSnap(180), now: T })
    const s = summarize(file, { now: T })
    assert.equal(s.today.groups.length, 2)
    const byUnit = Object.fromEntries(s.today.groups.map((g) => [g.unit, g.amount]))
    assert.equal(byUnit.money, 3)
    assert.equal(byUnit.credit, 180)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: 不同币种不混算', () => {
  const { file, dir } = tempLedger()
  try {
    recordSnapshot(file, {
      adapterId: 'zcode',
      adapterName: 'ZCode',
      now: T,
      snapshot: {
        ok: true,
        supported: true,
        unit: 'money',
        today: { amount: 10, currency: 'CNY', byCurrency: { CNY: 10, USD: 2 } },
      },
    })
    const groups = summarize(file, { now: T }).today.groups
    assert.equal(groups.length, 2)
    assert.deepEqual(
      groups.map((g) => [g.currency, g.amount]),
      [
        ['CNY', 10],
        ['USD', 2],
      ]
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: 失败 / 不支持 / 非法单位一律不记（不留假 0）', () => {
  const { file, dir } = tempLedger()
  try {
    assert.equal(recordSnapshot(file, { adapterId: 'z', snapshot: { ok: false, supported: true, unit: 'money' }, now: T }).ok, false)
    assert.equal(recordSnapshot(file, { adapterId: 'g', snapshot: { ok: true, supported: false }, now: T }).ok, false)
    assert.equal(
      recordSnapshot(file, { adapterId: 'x', snapshot: { ok: true, supported: true, unit: 'widgets', today: {} }, now: T }).ok,
      false
    )
    assert.deepEqual(readLedger(file).days, {})
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: percent 口径记 usedPct', () => {
  const { file, dir } = tempLedger()
  try {
    recordSnapshot(file, {
      adapterId: 'p',
      adapterName: 'P',
      now: T,
      snapshot: { ok: true, supported: true, unit: 'percent', quota: { usedPct: 42, remainingPct: 58 } },
    })
    const g = summarize(file, { now: T }).today.groups[0]
    assert.equal(g.unit, 'percent')
    assert.equal(g.amount, 42)
    assert.equal(g.currency, 'PCT')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ledger: 只保留最近 14 天，历史按日期升序返回', () => {
  const { file, dir } = tempLedger()
  try {
    for (let i = 0; i < 20; i++) {
      const t = new Date(2026, 9, 1 + i, 12, 0, 0).getTime()
      recordSnapshot(file, { adapterId: 'zcode', adapterName: 'ZCode', snapshot: moneySnap(i + 1), now: t })
    }
    const raw = readLedger(file)
    assert.equal(Object.keys(raw.days).length, KEEP_DAYS)
    const s = summarize(file, { now: T, days: 7 })
    assert.equal(s.days.length, 7)
    assert.deepEqual(
      s.days.map((d) => d.date),
      ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
