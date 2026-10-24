#!/usr/bin/env node
// M0 P-1 探针：ZCode 用量库结构（只读，不入 CI）。
//
//   node tools/probe-zcode-db.mjs [--db <file>] [--json]
//
// 判定：
//   · 三张用量表里是否存在 running / pending / in_progress 之类「进行中」取值；
//   · session.parent_id 样例（子会话关系）；
//   · turn_usage / tool_usage 的列与状态取值。
// 输出直接贴进 docs/dock/ADAPTERS.md「实时信号矩阵」。

import fs from 'node:fs'
import { createRequire } from 'node:module'
import { defaultDbFile } from '../adapters/zcode/context.mjs'

const require = createRequire(import.meta.url)
const sqlite = (() => {
  try {
    return require('node:sqlite')
  } catch (err) {
    return null
  }
})()

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const dbFile = arg('--db', '') || defaultDbFile()
const asJson = process.argv.includes('--json')

const IN_PROGRESS = /^(running|pending|in_progress|in-progress|streaming|active|started)$/i

function columns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => ({ name: r.name, type: r.type, pk: r.pk }))
  } catch (err) {
    return []
  }
}

function statusValues(db, table) {
  try {
    return db.prepare(`SELECT DISTINCT status FROM ${table}`).all().map((r) => String(r.status))
  } catch (err) {
    return null
  }
}

function sampleRows(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params)
  } catch (err) {
    return []
  }
}

const report = {
  probe: 'P-1-zcode-db',
  at: new Date().toISOString(),
  dbFile,
  ok: false,
  sqlite: !!sqlite,
  tables: {},
  inProgressValues: [],
  parentSamples: [],
  conclusion: '',
}

if (!sqlite) {
  report.conclusion = 'node:sqlite 不可用（需 Node ≥ 22.5）'
} else if (!fs.existsSync(dbFile)) {
  report.conclusion = '库文件不存在：' + dbFile
} else {
  let db = null
  try {
    db = new sqlite.DatabaseSync(dbFile, { readOnly: true, timeout: 2000 })
    for (const table of ['session', 'model_usage', 'turn_usage', 'tool_usage']) {
      const cols = columns(db, table)
      const statuses = cols.some((c) => c.name === 'status') ? statusValues(db, table) : null
      report.tables[table] = { columns: cols, statusValues: statuses }
      for (const s of statuses || []) if (IN_PROGRESS.test(s)) report.inProgressValues.push(table + ':' + s)
    }
    report.parentSamples = sampleRows(
      db,
      `SELECT id, parent_id, title, time_updated FROM session WHERE parent_id IS NOT NULL ORDER BY time_updated DESC LIMIT 5`
    )
    report.sessionCount = sampleRows(db, `SELECT COUNT(*) AS n FROM session`)[0]?.n ?? null
    report.ok = true
    report.conclusion = report.inProgressValues.length
      ? '库内有进行中状态：' + report.inProgressValues.join(', ') + ' → working 可由库直接判定'
      : '库内没有进行中状态 → working 用「最近 N 秒新行 + turn 未 completed」推断，statusSource=inferred'
  } catch (err) {
    report.error = String((err && err.message) || err)
    report.conclusion = '读取失败：' + report.error
  } finally {
    try {
      if (db) db.close()
    } catch (err) {}
  }
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('# ZCode 用量库探针（P-1）')
  console.log(report.conclusion)
  for (const [table, info] of Object.entries(report.tables)) {
    console.log('\n[' + table + ']')
    console.log('  columns: ' + info.columns.map((c) => c.name + ':' + (c.type || '?')).join(', '))
    console.log('  status:  ' + (info.statusValues === null ? '(无 status 列)' : info.statusValues.join(', ')))
  }
  console.log('\nparent_id 样例: ' + JSON.stringify(report.parentSamples))
}
