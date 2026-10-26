// ZCode 手动停止（turn_usage.status='cancelled'）的展示口径：
// 停止不是完成——适配器给 idle + endedAt（用于清掉钩子留下的 turnActive），
// 不能落 doneAt，否则 5 分钟窗口里会被显示成「已完成」。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zcancel-'))
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
  `)
  // s_cancel：用户在第 2 秒手动停止；s_done：正常完成。
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('s_cancel', null, '被停止的会话', NOW - 60_000, NOW - 58_000, null, null)
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('s_done', null, '完成的会话', NOW - 60_000, NOW - 50_000, null, null)
  for (const [id, title, at] of [['s_cancel', '被停止的会话', NOW - 58_000], ['s_done', '完成的会话', NOW - 50_000]]) {
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m_' + id, id, at, '{}')
  }
  // 模拟被停止回合的最后一笔 model 行晚于 completed_at 落库：旧逻辑会用
  // holdModel 再撑 10 分钟「工作中」，cancelled 的明确结束时刻必须压过它。
  db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    's_cancel', 't1', 'deepseek', 'deepseek-flash', 'cancelled', 'main_turn',
    NOW - 57_500, NOW - 57_400, 100, 0, 0, 0, 0, 100
  )
  db.prepare('INSERT INTO turn_usage VALUES (?,?,?,?,?,?)').run('s_cancel', 't1', 'cancelled', NOW - 59_000, NOW - 58_000, 1200)
  db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    's_done', 't2', 'deepseek', 'deepseek-flash', 'completed', 'main_turn',
    NOW - 55_000, NOW - 50_000, 100, 10, 0, 0, 0, 110
  )
  db.prepare('INSERT INTO turn_usage VALUES (?,?,?,?,?,?)').run('s_done', 't2', 'completed', NOW - 55_000, NOW - 50_000, 5000)
  db.close()
  return file
}

test('cancelled 回合：idle、无 doneAt、endedAt 用于清 turnActive', { skip: !sqlite }, async () => {
  const file = makeDb()
  const r = await getSessions({ dbFile: file, now: NOW, range: 'all', limit: 50, sort: 'updated' })
  assert.equal(r.ok, true)
  const cancel = r.items.find((s) => s.sessionId === 's_cancel')
  assert.ok(cancel)
  assert.equal(cancel.status, 'idle')
  assert.equal(cancel.doneAt, null)
  assert.equal(cancel.endedAt, NOW - 58_000)
  assert.equal(displayStatusOf(cancel, NOW), 'idle')
  // 停止后 1 分钟仍然不能变成「已完成」。
  assert.equal(displayStatusOf(cancel, NOW + 60_000), 'idle')
})

test('completed 回合：doneAt 撑住 5 分钟已完成窗口', { skip: !sqlite }, async () => {
  const file = makeDb()
  const r = await getSessions({ dbFile: file, now: NOW, range: 'all', limit: 50, sort: 'updated' })
  const done = r.items.find((s) => s.sessionId === 's_done')
  assert.ok(done)
  assert.equal(done.doneAt, NOW - 50_000)
  assert.equal(displayStatusOf(done, NOW), 'done')
  assert.equal(displayStatusOf(done, NOW - 50_000 + DONE_DISPLAY_MS + 1), 'idle')
})

test('状态筛选按展示状态：cancelled 只出现在空闲里', { skip: !sqlite }, async () => {
  const file = makeDb()
  const idle = await getSessions({ dbFile: file, now: NOW, range: 'all', limit: 50, sort: 'updated', status: 'idle' })
  assert.ok(idle.items.some((s) => s.sessionId === 's_cancel'))
  const done = await getSessions({ dbFile: file, now: NOW, range: 'all', limit: 50, sort: 'updated', status: 'done' })
  assert.ok(!done.items.some((s) => s.sessionId === 's_cancel'))
})
