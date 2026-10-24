// M4 增量等价性：追加日志后的结果 = 全量扫描结果（不重复计数）
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { getSessions as getWorkbuddySessions, _resetWorkbuddyLive } from '../../adapters/workbuddy/sessions.mjs'
import { getSessions as getDshSessions, _resetDshLiveCache } from '../../adapters/dsh/live.mjs'
import { aggregateUsage, getSessions as getZcodeSessions, readUsageRows, _resetZcodeSessions } from '../../adapters/zcode/sessions.mjs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sqlite = (() => {
  try {
    return require('node:sqlite')
  } catch (err) {
    return null
  }
})()

const NOW = Date.now()

function wbLine(i) {
  return (
    JSON.stringify({
      sessionId: 'wb_inc',
      timestamp: NOW - 60_000 + i * 1000,
      type: 'assistant',
      providerData: {
        conversationRequestId: 'r' + Math.floor(i / 3),
        model: 'wb-pro',
        rawUsage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, credit: 0.01 },
      },
    }) + '\n'
  )
}

test('incremental: WB 追加行后 tokens/credits 恰好等于全量（不重复）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-inc-wb-'))
  try {
    const projects = path.join(dir, 'projects')
    const sub = path.join(projects, 'p')
    fs.mkdirSync(sub, { recursive: true })
    const file = path.join(sub, 's.jsonl')
    for (let i = 0; i < 9; i++) fs.appendFileSync(file, wbLine(i))
    _resetWorkbuddyLive()
    const a = await getWorkbuddySessions({ projectsDir: projects, dbFile: path.join(dir, 'none.db'), now: NOW, limit: 10 })
    const aTokens = a.items[0].tokens.total
    assert.equal(aTokens, 1080)
    for (let i = 9; i < 15; i++) fs.appendFileSync(file, wbLine(i))
    const b = await getWorkbuddySessions({ projectsDir: projects, dbFile: path.join(dir, 'none.db'), now: NOW, limit: 10 })
    assert.equal(b.items[0].tokens.total, 1800)
    assert.equal(b.items[0].cost.amount, 0.15)
    // 冷启动（清缓存）重扫结果一致
    _resetWorkbuddyLive()
    const c = await getWorkbuddySessions({ projectsDir: projects, dbFile: path.join(dir, 'none.db'), now: NOW, limit: 10 })
    assert.deepEqual(c.items[0].tokens, b.items[0].tokens)
    assert.deepEqual(c.items[0].cost, b.items[0].cost)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function dshText(turn) {
  const events = [
    { type: 'session', id: 'dsh_inc', time: NOW - 60_000, title: 'inc' },
    { type: 'turn/start', time: NOW - 50_000, data: { turn } },
    {
      type: 'assistant/message',
      time: NOW - 49_000,
      data: { turn, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 140, cacheReadTokens: 20 }, message: { source: { model: 'deepseek-v4', provider: 'deepseek' } } },
    },
    { type: 'turn/end', time: NOW - 48_000, data: { turn, reason: { kind: 'completed' } } },
  ]
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

test('incremental: dsh 追加 zstd 帧后不重复计数', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-inc-dsh-'))
  try {
    const sessions = path.join(dir, 'sessions', 'p')
    fs.mkdirSync(sessions, { recursive: true })
    const file = path.join(sessions, 'session0.jsonl.zstd')
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(dshText(1))))
    _resetDshLiveCache()
    const a = await getDshSessions({ sessionsDir: sessions, now: NOW, limit: 10 })
    const first = a.items[0].tokens.total
    assert.ok(first > 0)
    fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(dshText(2))))
    const b = await getDshSessions({ sessionsDir: sessions, now: NOW, limit: 10 })
    assert.equal(b.items[0].tokens.total, first * 2)
    _resetDshLiveCache()
    const c = await getDshSessions({ sessionsDir: sessions, now: NOW, limit: 10 })
    assert.deepEqual(c.items[0].tokens, b.items[0].tokens)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('incremental: ZCode SQL 聚合 = 明细行手算（model 维度）', { skip: !sqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-inc-zc-'))
  try {
    const file = path.join(dir, 'db.sqlite')
    const db = new sqlite.DatabaseSync(file)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE model_usage (session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, computed_total_tokens INTEGER);
      CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER);
      CREATE TABLE tool_usage (session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);
    `)
    const ins = db.prepare(`INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    ins.run('s1', 't1', 'deepseek', 'deepseek-flash', 'completed', NOW - 3000, NOW - 2000, 1000, 200, 0, 300, 0, 1200)
    ins.run('s1', 't1', 'deepseek', 'deepseek-flash', 'completed', NOW - 1000, NOW - 500, 500, 100, 0, 100, 0, 600)
    db.close()
    _resetZcodeSessions()
    const agg = await aggregateUsage({ dbFile: file, by: 'model', since: NOW - 86400000, until: NOW, now: NOW })
    const rows = await readUsageRows({ dbFile: file, since: NOW - 86400000, until: NOW, now: NOW })
    const manual = rows.rows
      .filter((r) => r.model === 'deepseek-flash')
      .reduce((s, r) => ({ tokens: s.tokens + r.tokens, amount: s.amount + r.amount }), { tokens: 0, amount: 0 })
    const model = agg.series.find((s) => s.key === 'deepseek-flash')
    assert.equal(model.tokens, manual.tokens)
    assert.ok(Math.abs(model.amount - manual.amount) < 0.0001)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
