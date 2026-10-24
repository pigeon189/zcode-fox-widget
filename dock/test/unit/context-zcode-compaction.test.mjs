// ZCode 上下文：压缩事件与标题生成请求不能污染「当前占用」。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import { _resetContextConnection, readZcodeContext } from '../../adapters/zcode/context.mjs'

const require = createRequire(import.meta.url)
const sqlite = (() => {
  try {
    return require('node:sqlite')
  } catch (err) {
    return null
  }
})()

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime()
const dirs = []

after(() => {
  _resetContextConnection()
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (err) {}
  }
})

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ctx-compact-'))
  dirs.push(dir)
  const file = path.join(dir, 'db.sqlite')
  const db = new sqlite.DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_updated INTEGER,
      time_compacting INTEGER, time_archived INTEGER
    );
    CREATE TABLE model_usage (
      session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, query_source TEXT,
      started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
      computed_total_tokens INTEGER, context_exceeded INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT
    );
  `)
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('main', null, '主会话', NOW - 1000, null, null)
  const ins = db.prepare(
    `INSERT INTO model_usage
     (session_id,turn_id,model_id,status,query_source,started_at,completed_at,input_tokens,output_tokens,
      reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens,context_exceeded)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  // 压缩前的最后一次主回合
  ins.run('main', 't1', 'deepseek-flash', 'completed', 'main_turn', NOW - 60_000, NOW - 50_000, 1000, 200, 0, 0, 0, 1200, 0)
  // 压缩请求本身会把整段旧上下文算进去，不能当作当前占用
  ins.run('main', 'tc', 'deepseek-flash', 'completed', 'compact', NOW - 30_000, NOW - 10_000, 800_000, 5000, 0, 0, 0, 805_000, 0)
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(
    'p1',
    'main',
    'm1',
    NOW - 10_000,
    JSON.stringify({ type: 'compaction', auto: false, trigger: 'manual' })
  )
  db.close()
  return { dir, file }
}

test('zcode context: 压缩后旧回合占用失效，used=null 让预警立即解除', { skip: !sqlite }, () => {
  const { dir, file } = makeDb()
  try {
    _resetContextConnection()
    const c = readZcodeContext({ dbFile: file, env: { ZCODE_HOME: dir, ZCODE_DATA_BASE_DIR: dir }, now: NOW })
    assert.equal(c.supported, true)
    assert.equal(c.sessionId, 'main')
    assert.equal(c.used, null)
    assert.equal(c.pct, undefined, 'readZcodeContext 不派生 pct，由 normalizeContext 处理')
    assert.equal(c.compaction.count, 1)
    assert.equal(c.compaction.derived, false)
    assert.equal(c.compaction.lastAt, NOW - 10_000)
    assert.equal(c.breakdown, undefined)
    assert.equal(c.updatedAt, NOW - 10_000)
  } finally {
    _resetContextConnection()
  }
})

test('zcode context: 压缩后的下一轮主回合恢复精确占用，标题生成不计入', { skip: !sqlite }, () => {
  const { dir, file } = makeDb()
  try {
    const db = new sqlite.DatabaseSync(file)
    db.prepare(
      `INSERT INTO model_usage
       (session_id,turn_id,model_id,status,query_source,started_at,completed_at,input_tokens,output_tokens,
        reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens,context_exceeded)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('main', 't2', 'deepseek-flash', 'completed', 'main_turn', NOW - 5000, NOW - 4000, 400, 100, 0, 0, 0, 500, 0)
    // 标题生成比主回合更晚、token 更大；它不是上下文占用
    db.prepare(
      `INSERT INTO model_usage
       (session_id,turn_id,model_id,status,query_source,started_at,completed_at,input_tokens,output_tokens,
        reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens,context_exceeded)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('main', 'tt', 'deepseek-flash', 'completed', 'session_title', NOW - 3000, NOW - 2000, 90_000, 20, 0, 0, 0, 90_020, 0)
    db.close()
    _resetContextConnection()
    const c = readZcodeContext({ dbFile: file, env: { ZCODE_HOME: dir, ZCODE_DATA_BASE_DIR: dir }, now: NOW })
    assert.equal(c.used, 500)
    assert.equal(c.updatedAt, NOW - 4000)
    assert.equal(c.compaction.count, 1, '压缩历史仍保留在详情里')
    assert.ok(c.points.every((p) => p.used < 100_000), '趋势点只含主回合')
  } finally {
    _resetContextConnection()
  }
})
