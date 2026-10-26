// ZCode workflow 父会话状态（D056）：编排回合结束但 dwf_run 还在跑时不能显示空闲；
// run 结束后用 run 的 time_updated 起算 5 分钟「已完成」窗口。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import { _resetZcodeSessions, getSessions } from '../../adapters/zcode/sessions.mjs'
import { DONE_DISPLAY_MS, displayStatusOf } from '../../shared/session-model.mjs'

const require = createRequire(import.meta.url)
const sqlite = (() => {
  try {
    return require('node:sqlite')
  } catch (err) {
    return null
  }
})()

const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime()
const dirs = []

after(() => {
  _resetZcodeSessions()
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (err) {}
  }
})

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zworkflow-'))
  dirs.push(dir)
  const file = path.join(dir, 'db.sqlite')
  const db = new sqlite.DatabaseSync(file, { timeout: 5000 })
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER);
    CREATE TABLE model_usage (
      session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, query_source TEXT,
      started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      computed_total_tokens INTEGER
    );
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER);
    CREATE TABLE tool_usage (session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE dwf_run (id TEXT PRIMARY KEY, parent_session_id TEXT, name TEXT, status TEXT, time_updated INTEGER);
  `)
  // 父会话的回合在 7 分钟前就结束了：单看库会判 idle。
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('s1', null, '编排会话', NOW - 600_000, NOW - 400_000, null, null)
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 's1', NOW - 500_000, '{}')
  db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    's1',
    't1',
    'deepseek',
    'deepseek-flash',
    'completed',
    'main_turn',
    NOW - 480_000,
    NOW - 450_000,
    1000,
    100,
    0,
    0,
    0,
    1100
  )
  db.prepare('INSERT INTO turn_usage VALUES (?,?,?,?,?,?)').run('s1', 't1', 'completed', NOW - 480_000, NOW - 450_000, 30_000)
  db.prepare('INSERT INTO dwf_run VALUES (?,?,?,?,?)').run('run-1', 's1', 'pre.3 收敛轮', 'running', NOW - 30_000)
  db.close()
  return { dir, file }
}

function setRun(file, status, at) {
  const db = new sqlite.DatabaseSync(file, { timeout: 5000 })
  try {
    db.prepare('UPDATE dwf_run SET status = ?, time_updated = ? WHERE id = ?').run(status, at, 'run-1')
  } finally {
    db.close()
  }
}

test('workflow 在跑：父会话回合已结束也显示工作中，且能被 working 筛选命中', { skip: !sqlite }, async () => {
  const { file } = makeDb()
  try {
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: NOW, sort: 'updated', limit: 20 })
    const s = r.items.find((x) => x.sessionId === 's1')
    assert.ok(s, '会话应出现在列表里')
    assert.equal(s.workflowBusy, true)
    assert.equal(s.status, 'working', 'workflow 在跑不能显示空闲')
    assert.equal(displayStatusOf(s, NOW), 'working')

    _resetZcodeSessions()
    const filtered = await getSessions({ dbFile: file, now: NOW, status: 'working', limit: 20 })
    assert.ok(filtered.items.some((x) => x.sessionId === 's1'), 'working 筛选应包含 workflow 父会话')
  } finally {
    _resetZcodeSessions()
  }
})

test('workflow 结束：从 run 的结束时间起算 5 分钟已完成，之后回落空闲', { skip: !sqlite }, async () => {
  const { file } = makeDb()
  try {
    setRun(file, 'completed', NOW - 60_000)
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: NOW, sort: 'updated', limit: 20 })
    const s = r.items.find((x) => x.sessionId === 's1')
    assert.equal(s.workflowBusy, false)
    assert.equal(s.status, 'idle', '父回合早已结束，机器状态是空闲')
    assert.equal(s.doneAt, NOW - 60_000, 'doneAt 取 workflow 结束时间，而不是父回合结束时间')
    assert.equal(displayStatusOf(s, NOW), 'done')
    assert.equal(displayStatusOf(s, NOW + 3 * 60_000), 'done', '4 分钟后仍应显示已完成')
    assert.equal(displayStatusOf(s, NOW + 4 * 60_000 + 1000), 'idle', '5 分钟后回落空闲')

    _resetZcodeSessions()
    const filtered = await getSessions({ dbFile: file, now: NOW, status: 'done', limit: 20 })
    assert.ok(filtered.items.some((x) => x.sessionId === 's1'), 'done 筛选应抓到刚结束的 workflow 父会话')
  } finally {
    _resetZcodeSessions()
  }
})

test('没有 workflow 表的老库：不影响原有状态与筛选', { skip: !sqlite }, async () => {
  const { file } = makeDb()
  try {
    const db = new sqlite.DatabaseSync(file, { timeout: 5000 })
    db.exec('DROP TABLE dwf_run')
    db.close()
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: NOW, sort: 'updated', limit: 20 })
    const s = r.items.find((x) => x.sessionId === 's1')
    assert.equal(s.workflowBusy, false)
    assert.equal(s.status, 'idle')
  } finally {
    _resetZcodeSessions()
  }
})

test('已完成展示窗口常量是 5 分钟', () => {
  assert.equal(DONE_DISPLAY_MS, 5 * 60_000)
})
