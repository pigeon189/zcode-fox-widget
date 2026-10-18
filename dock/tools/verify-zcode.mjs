#!/usr/bin/env node
// ZCode 适配器对账：把 dock 算出来的「今日已用」与挂件线的实现逐币种比较。
//
// 这是**验证工具**，不参与运行时：dock 不 import 挂件线的任何代码（那会把两个
// 产品绑死）。只有这个脚本会在仓库里找到挂件线的 lib/usage-records.mjs 时，
// 用它的结果做基准；找不到就明确跳过。
//
// 用法：node tools/verify-zcode.mjs [--json] [--tolerance 0.01]

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readUsage, dominantCurrency } from '../adapters/zcode/store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REFERENCE = path.join(HERE, '..', '..', 'lib', 'usage-records.mjs')

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const asJson = process.argv.includes('--json')
const tolerance = Number(argValue('--tolerance', '0.01'))

const dock = readUsage({ now: Date.now() })
if (!dock.ok) {
  console.error('dock 读取失败：' + dock.reason + '（' + dock.dbFile + '）')
  process.exit(2)
}

let ref = null
let refReason = ''
try {
  const mod = await import(pathToFileURL(REFERENCE).href)
  const r = mod.usageRecords()
  if (r && r.ok) ref = r
  else refReason = (r && r.reason) || 'unknown'
} catch (err) {
  refReason = '挂件线源码不可用：' + String((err && err.message) || err)
}

const dockTotals = dock.today.byCurrency
const refTotals = (ref && ref.today && ref.today.totals) || null

const currencies = Array.from(new Set([...Object.keys(dockTotals), ...Object.keys(refTotals || {})])).sort()
const rows = currencies.map((cur) => {
  const a = dockTotals[cur] || 0
  const b = refTotals ? refTotals[cur] || 0 : null
  const delta = b === null ? null : a - b
  const pass = b === null ? null : Math.abs(delta) <= tolerance
  return { currency: cur, dock: a, reference: b, delta, pass }
})

// 今天常常是空的（刚起床没用量），只对今天做校验等于「0 对 0」。
// 额外逐日对账最近 7 天：把 dock 的时间窗拨到那一天，与挂件线的 byDay 比。
const days = []
if (ref && ref.days7 && Array.isArray(ref.days7.byDay)) {
  for (const d of ref.days7.byDay) {
    const [y, m, dd] = String(d.date).split('-').map(Number)
    const start = new Date(y, m - 1, dd).getTime()
    const end = new Date(y, m - 1, dd + 1).getTime()
    const got = readUsage({ now: start, since: start, until: end })
    const mine = got.ok ? got.today.byCurrency : {}
    const theirs = d.totals || {}
    const curs = Array.from(new Set([...Object.keys(mine), ...Object.keys(theirs)])).sort()
    const detail = curs.map((cur) => {
      const a = mine[cur] || 0
      const b = theirs[cur] || 0
      return { currency: cur, dock: a, reference: b, delta: a - b, pass: Math.abs(a - b) <= tolerance }
    })
    days.push({
      date: d.date,
      tokens: { dock: got.ok ? got.today.tokens : null, reference: d.tokens },
      detail,
      pass: detail.every((x) => x.pass) && (got.ok ? got.today.tokens === d.tokens : false),
    })
  }
}

const allPass = refTotals ? rows.every((r) => r.pass !== false) && days.every((d) => d.pass) : null

if (asJson) {
  console.log(
    JSON.stringify(
      {
        ok: allPass === true,
        compared: !!refTotals,
        reason: refReason || null,
        tolerance,
        rows,
        days,
        tokens: { dock: dock.today.tokens, reference: ref ? ref.today.tokens : null },
        lastTurn: dock.lastTurn,
      },
      null,
      2
    )
  )
  process.exit(allPass === false ? 1 : 0)
}

console.log('ZCode 今日已用对账（dock vs 挂件线）')
console.log('库：' + dock.dbFile)
console.log('')
console.log('CUR   dock        挂件线       差额')
for (const r of rows) {
  const d = r.delta === null ? '—' : (r.delta >= 0 ? '+' : '') + r.delta.toFixed(4)
  console.log(
    r.currency +
      '   ' +
      r.dock.toFixed(4).padEnd(11) +
      (r.reference === null ? '—' : r.reference.toFixed(4)).padEnd(12) +
      d +
      (r.pass === false ? '   ❌' : r.pass === true ? '   ✅' : '')
  )
}
console.log('')
console.log('tokens：dock ' + dock.today.tokens + ' / 挂件线 ' + (ref ? ref.today.tokens : '—'))
if (dock.lastTurn) {
  console.log(
    '上一轮：' + dock.lastTurn.amount.toFixed(4) + ' ' + dock.lastTurn.currency + '（' + dock.lastTurn.calls + ' 次调用）'
  )
}
if (!refTotals) {
  console.log('')
  console.log('⚠ 未做对账：' + refReason)
  process.exit(0)
}
if (days.length) {
  console.log('')
  console.log('近 7 天逐日对账（date / dock / 挂件线 / tokens）')
  for (const d of days) {
    const first = d.detail[0] || { dock: 0, reference: 0, currency: 'CNY' }
    const extra = d.detail.length > 1 ? '  (+' + (d.detail.length - 1) + ' 币种)' : ''
    console.log(
      d.date +
        '  ' +
        first.dock.toFixed(4).padEnd(11) +
        first.reference.toFixed(4).padEnd(12) +
        d.tokens.dock +
        '/' +
        d.tokens.reference +
        (d.pass ? '  ✅' : '  ❌') +
        extra
    )
  }
}
console.log('')
console.log(allPass ? '✅ 全部在容差内（' + tolerance + '）' : '❌ 有超出容差（' + tolerance + '）')
process.exit(allPass ? 0 : 1)
