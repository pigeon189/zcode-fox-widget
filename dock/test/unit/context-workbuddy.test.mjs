import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { _resetContextConnection, listWorkbuddySessions, readWorkbuddyContext } from '../../adapters/workbuddy/context.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ctx-wb-'))
const home = path.join(dir, 'home')
const dbFile = path.join(home, 'workbuddy.db')

function setup() {
  fs.mkdirSync(home, { recursive: true })
  const db = new DatabaseSync(dbFile, { timeout: 5000 })
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT, custom_title TEXT, model TEXT,
      context_window INTEGER, updated_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE session_usage (
      session_id TEXT, used INTEGER, size INTEGER, updated_at INTEGER
    );
  `)
  const now = Date.now()
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run('s1', '标题一', '自定义标题', 'glm-5.3', 300000, now, null)
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run('s2', '标题二', null, 'deepseek-v4.1', 1000000, now - 1000, null)
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?)').run('s3', '已删除', null, 'glm-5.3', 300000, now + 5000, now + 5000)
  db.prepare('INSERT INTO session_usage VALUES (?,?,?,?)').run('s1', 120000, 300000, now - 500)
  db.prepare('INSERT INTO session_usage VALUES (?,?,?,?)').run('s2', 475318, 1000000, now)
  db.prepare('INSERT INTO session_usage VALUES (?,?,?,?)').run('s3', 999999, 300000, now + 5000)
  db.close()
  return now
}

const now = setup()

after(() => {
  _resetContextConnection()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('wb context: 取最近一个未删除会话，used/size 直接来自 session_usage', () => {
  _resetContextConnection()
  const c = readWorkbuddyContext({ dbFile, env: { CODEBUDDY_HOME: home }, now })
  assert.equal(c.supported, true)
  assert.equal(c.sessionId, 's2')
  assert.equal(c.used, 475318)
  assert.equal(c.limit, 1000000, 'size 优先')
  assert.equal(c.limitSource, 'host')
  assert.equal(c.title, '标题二')
  assert.equal(c.model, 'deepseek-v4.1')
  assert.equal(c.pct, undefined, 'pct 由 normalizeContext 统一计算，适配器不算')
})

test('wb context: 同模型 size 与 context_window 不同时以 size 为准', () => {
  _resetContextConnection()
  const c = readWorkbuddyContext({ dbFile, env: { CODEBUDDY_HOME: home }, now, session: 's1' })
  assert.equal(c.limit, 300000)
})

test('wb context: 会话列表排除已删除，按更新时间排序', () => {
  _resetContextConnection()
  const list = listWorkbuddySessions({ dbFile, env: { CODEBUDDY_HOME: home }, now })
  assert.deepEqual(list.map((s) => s.id), ['s2', 's1'])
  assert.equal(list[0].pct, 47.5)
})

test('wb context: 没有 DB 时退回 transcript 的 prompt_tokens，limit 未知', () => {
  _resetContextConnection()
  const projects = path.join(home, 'projects', 'proj')
  fs.mkdirSync(projects, { recursive: true })
  const file = path.join(projects, 'sess.jsonl')
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ timestamp: new Date(now - 5000).toISOString(), providerData: { rawUsage: { prompt_tokens: 100 } } }),
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        providerData: { rawUsage: { prompt_tokens: 321000 }, model: 'glm-5.3' },
      }),
    ].join('\n')
  )
  const c = readWorkbuddyContext({ dbFile: path.join(dir, 'missing.db'), env: { CODEBUDDY_HOME: home }, now })
  assert.equal(c.supported, true)
  assert.equal(c.used, 321000)
  assert.equal(c.limit, null)
  assert.equal(c.confidence, 'derived')
  assert.equal(c.model, 'glm-5.3')
})

test('wb context: 什么都没有 → no-data，不编 0', () => {
  _resetContextConnection()
  const c = readWorkbuddyContext({ dbFile: path.join(dir, 'none.db'), env: { CODEBUDDY_HOME: path.join(dir, 'nohome') }, now })
  assert.equal(c.supported, false)
  assert.equal(c.reason, 'no-data')
})
