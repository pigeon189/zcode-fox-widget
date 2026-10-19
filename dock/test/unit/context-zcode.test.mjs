import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { _resetContextConnection, listZcodeSessions, parseCcModels, readZcodeContext } from '../../adapters/zcode/context.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ctx-zcode-'))
const home = path.join(dir, 'home')
const dbFile = path.join(home, 'cli', 'db', 'db.sqlite')

function setup() {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new DatabaseSync(dbFile)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_updated INTEGER,
      time_compacting INTEGER, time_archived INTEGER
    );
    CREATE TABLE model_usage (
      session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
      started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
      computed_total_tokens INTEGER, context_exceeded INTEGER
    );
  `)
  const now = Date.now()
  const insSession = db.prepare(
    'INSERT INTO session (id,parent_id,title,time_updated,time_compacting,time_archived) VALUES (?,?,?,?,?,?)'
  )
  insSession.run('main', null, '主会话', now, now - 1000, null)
  insSession.run('child', 'main', '子会话', now + 1000, null, null)
  const ins = db.prepare(
    `INSERT INTO model_usage
     (session_id,turn_id,provider_id,model_id,status,started_at,completed_at,input_tokens,output_tokens,
      reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens,context_exceeded)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  // 主会话：两条 completed，取最后一条；input 含缓存（1000 里 600 缓存 + 100 写入）
  ins.run('main', 't1', 'p', 'deepseek-v4.1', 'completed', now - 5000, now - 4000, 500, 100, 0, 0, 0, 600, 0)
  ins.run('main', 't2', 'p', 'deepseek-v4.1', 'completed', now - 3000, now - 2000, 1000, 200, 50, 100, 600, 1200, 0)
  ins.run('main', 't3', 'p', 'deepseek-v4.1', 'error', now - 1000, now - 900, 9999, 9999, 0, 0, 0, 19998, 1)
  // 子会话更晚，但不能被选中
  ins.run('child', 'c1', 'p', 'deepseek-v4.1', 'completed', now, now + 100, 8888, 888, 0, 0, 0, 9776, 0)
  db.close()

  // 上限配置：zcode-builtin.json 与 cc-models.txt
  const endpoint = path.join(home, 'v2', 'runtime', 'provider', 'windows-x86_64', '9.9.9', 'endpoint-x')
  fs.mkdirSync(endpoint, { recursive: true })
  fs.writeFileSync(
    path.join(endpoint, 'zcode-builtin.json'),
    JSON.stringify({
      config: {
        modelConfigRules: {
          modelRules: [
            { modelMatch: '.*', config: { properties: { contextWindow: 200000 } } },
            { modelMatch: 'deepseek.*', config: { properties: { contextWindow: 1000000 } } },
          ],
        },
      },
    })
  )
  const ws = path.join(home, 'workspace', 'default')
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'cc-models.txt'), 'TOTAL 1\ngpt-6-astra | /responses | 1050000\n')
  return now
}

const now = setup()
const env = { ZCODE_HOME: home, ZCODE_DATA_BASE_DIR: home }

after(() => {
  _resetContextConnection()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('zcode context: used 取主会话最后一条 completed 的 computed_total_tokens', () => {
  _resetContextConnection()
  const c = readZcodeContext({ dbFile, env, now })
  assert.equal(c.supported, true)
  assert.equal(c.sessionId, 'main', '不能选到子会话')
  assert.equal(c.used, 1200)
  assert.equal(c.model, 'deepseek-v4.1')
  assert.equal(c.limit, 1000000, 'host 规则优先于默认 200k')
  assert.equal(c.limitSource, 'host')
  assert.equal(c.confidence, 'exact')
})

test('zcode context: 构成不重复加缓存（input - cacheRead - cacheWrite）', () => {
  const c = readZcodeContext({ dbFile, env, now })
  assert.deepEqual(c.breakdown, { input: 300, cacheRead: 600, cacheWrite: 100, output: 200, reasoning: 50 })
})

test('zcode context: 趋势点按时间升序，错误行被忽略', () => {
  const c = readZcodeContext({ dbFile, env, now })
  assert.equal(c.points.length, 2)
  assert.deepEqual(c.points.map((p) => p.used), [600, 1200])
  assert.ok(c.points[0].t < c.points[1].t)
})

test('zcode context: 压缩时间存在时给出推测标记', () => {
  const c = readZcodeContext({ dbFile, env, now })
  assert.equal(c.compaction.count, 1)
  assert.equal(c.compaction.derived, true)
})

test('zcode context: 指定 session 只读该会话；不存在的会话 → no-session', () => {
  _resetContextConnection()
  const main = readZcodeContext({ dbFile, env, now, session: 'main' })
  assert.equal(main.sessionId, 'main')
  const missing = readZcodeContext({ dbFile, env, now, session: 'nope' })
  assert.equal(missing.supported, false)
  assert.equal(missing.reason, 'no-session')
})

test('zcode context: 缺库 → no-data（不是 0 上下文）', () => {
  const c = readZcodeContext({ dbFile: path.join(dir, 'missing.sqlite'), env, now })
  assert.equal(c.supported, false)
  assert.equal(c.reason, 'no-data')
  assert.equal(c.used, undefined)
})

test('zcode context: 会话列表带 used/limit/pct，不过滤掉子会话（列表面板只展示主会话）', () => {
  _resetContextConnection()
  const list = listZcodeSessions({ dbFile, env, now, limit: 8 })
  assert.equal(list.length, 1, '只列 parent_id IS NULL 的主会话')
  assert.equal(list[0].id, 'main')
  assert.equal(list[0].used, 1200)
  assert.equal(list[0].limit, 1000000)
  assert.equal(list[0].pct, 0.1)
})

test('zcode limits: cc-models 与内置表兜底', () => {
  assert.deepEqual(parseCcModels('TOTAL 1\ngpt-6-astra | /responses | 1050000\n')[0], { model: 'gpt-6-astra', window: 1050000 })
  // 没有匹配规则时回落到默认 200k
  const c = readZcodeContext({ dbFile, env, now, session: 'main' })
  assert.equal(c.limitSource, 'host')
})
