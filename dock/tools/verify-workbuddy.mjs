#!/usr/bin/env node
// WorkBuddy 适配器对账：dock 算的积分与**正在运行的挂件**逐日比较。
//
// 与 verify-zcode 的区别：WB 线的服务通常开着，直接问它比自己 import 更接近
// 用户看到的数字（对方也走同一套 transcript 扫描 + 30s 记忆化）。
//
// 用法：node tools/verify-workbuddy.mjs [--port 39321] [--json] [--tolerance 0.01]

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readCreditUsage, startOfLocalDay } from '../adapters/workbuddy/transcripts.mjs'

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const port = Number(argValue('--port', '39321'))
const tolerance = Number(argValue('--tolerance', '0.01'))
const asJson = process.argv.includes('--json')

async function fetchJson(p) {
  const res = await fetch('http://127.0.0.1:' + port + p, { signal: AbortSignal.timeout(4000) })
  return res.json()
}

let ref = null
let refReason = ''
let refSource = ''

async function grabHttp() {
  try {
    const r = await fetchJson('/whale/usage-records.json')
    if (!r || !r.ok) {
      refReason = '挂件返回 ok=false（' + ((r && r.reason) || '?') + '）'
      return null
    }
    return r
  } catch (err) {
    refReason = '连不上 127.0.0.1:' + port + '（挂件没运行？）'
    return null
  }
}

// 参考值优先用**新进程里算一遍**：运行中的挂件有 30s 记忆化，会话正在写盘时
// 会给出明显落后的数字（实测差 50+ 积分），拿它当基准会把 dock 的正确值判成错。
async function grabFresh() {
  const mod =
    argValue('--reference-module', '') ||
    process.env.FOX_DOCK_WB_REFERENCE ||
    path.join(
      process.env.USERPROFILE || '',
      '.workbuddy',
      'plugins',
      'cache',
      'fox-local',
      'fox-widget',
      '2.0.0',
      'lib',
      'usage-records.mjs'
    )
  if (!fs.existsSync(mod)) {
    refReason = '找不到挂件线参考模块：' + mod
    return null
  }
  try {
    const m = await import(pathToFileURL(mod).href)
    const r = m.usageRecords()
    if (!r || !r.ok) {
      refReason = '参考模块返回 ok=false（' + ((r && r.reason) || '?') + '）'
      return null
    }
    return r
  } catch (err) {
    refReason = '参考模块执行失败：' + String((err && err.message) || err)
    return null
  }
}

const useHttp = process.argv.includes('--http')
ref = useHttp ? await grabHttp() : await grabFresh()
refSource = useHttp ? 'running service' : 'fresh module'
if (!ref && !useHttp) {
  // 参考模块不可用时退回运行中的服务，并注明来源
  ref = await grabHttp()
  refSource = 'running service (fallback)'
}

const now = Date.now()
const dock = readCreditUsage({ now })

if (!dock.ok) {
  console.error('dock 读取失败：' + dock.reason)
  process.exit(2)
}

const refToday = ref && ref.today && ref.today.totals ? Number(ref.today.totals.CREDIT || 0) : null
// 文件仍在增长：两次读取间隔内的差异按「0.5% 或 0.05 积分」取大者
const tokenTol = ref ? Math.max(2000, Math.round(Number(ref.today.tokens || 0) * 0.001)) : 0
const todayRow = {
  dock: dock.today.credits,
  reference: refToday,
  tokens: { dock: dock.today.tokens, reference: ref ? ref.today.tokens : null },
  tolerance,
  pass:
    refToday === null
      ? null
      : Math.abs(dock.today.credits - refToday) <= tolerance &&
        Math.abs(dock.today.tokens - ref.today.tokens) <= tokenTol,
}

const days = []
if (ref && ref.days7 && Array.isArray(ref.days7.byDay)) {
  for (const d of ref.days7.byDay) {
    const [y, m, dd] = String(d.date).split('-').map(Number)
    const start = new Date(y, m - 1, dd).getTime()
    const end = new Date(y, m - 1, dd + 1).getTime()
    const got = readCreditUsage({ now: start, since: start, until: end })
    const theirCredit = Number((d.totals && d.totals.CREDIT) || 0)
    const mine = got.ok ? got.today.credits : 0
    days.push({
      date: d.date,
      credit: { dock: mine, reference: theirCredit },
      tokens: { dock: got.ok ? got.today.tokens : null, reference: d.tokens },
      pass:
        got.ok && Math.abs(mine - theirCredit) <= tolerance && got.today.tokens === d.tokens,
    })
  }
}

const allPass = refToday === null ? null : todayRow.pass && days.every((d) => d.pass)

if (asJson) {
  console.log(
    JSON.stringify(
      {
        ok: allPass === true,
        compared: refToday !== null,
        reason: refReason || null,
        tolerance,
        today: todayRow,
        days,
        files: dock.today.files,
        truncated: dock.today.truncated,
        lastTurn: dock.lastTurn,
      },
      null,
      2
    )
  )
  process.exit(allPass === false ? 1 : 0)
}

console.log('WorkBuddy 积分对账（dock vs 挂件线：' + refSource + '）')
console.log('会话目录：' + dock.projectsDir)
console.log('')
console.log('今日：dock ' + dock.today.credits + ' / 挂件 ' + (refToday === null ? '—' : refToday) + ' 积分' + (todayRow.pass === false ? '  ❌' : todayRow.pass ? '  ✅' : ''))
console.log('     tokens：dock ' + dock.today.tokens + ' / 挂件 ' + (ref ? ref.today.tokens : '—'))
if (ref && Number(ref.truncatedTranscripts || 0) > 0) {
  console.log('     ⚠ 挂件报告 ' + ref.truncatedTranscripts + ' 个 transcript 被尾部截断（它会偏低）')
}
if (ref && Number(ref.truncatedTranscripts || 0) > 0) {
  console.log('     ⚠ 挂件报告 ' + ref.truncatedTranscripts + ' 个 transcript 被尾部截断（它会偏低）')
}
console.log('     扫描文件 ' + dock.today.files + ' 个，事件 ' + dock.today.events + ' 个' + (dock.today.truncated ? '（有 ' + dock.today.truncated + ' 个文件被尾部截断）' : ''))
if (dock.lastTurn) {
  console.log('上一轮：' + dock.lastTurn.credits + ' 积分（' + dock.lastTurn.calls + ' 次调用）')
}

if (refToday === null) {
  console.log('')
  console.log('⚠ 未做对账：' + refReason)
  process.exit(0)
}

console.log('')
console.log('近 7 天逐日（date / dock / 挂件 / tokens）')
for (const d of days) {
  console.log(
    d.date +
      '  ' +
      String(d.credit.dock).padEnd(12) +
      String(d.credit.reference).padEnd(12) +
      d.tokens.dock +
      '/' +
      d.tokens.reference +
      (d.pass ? '  ✅' : '  ❌')
  )
}
console.log('')
console.log(allPass ? '✅ 全部在容差内（' + tolerance + ' 积分，tokens 需完全一致）' : '❌ 有超出容差')
process.exit(allPass ? 0 : 1)
