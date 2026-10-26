// ZCode 实时状态：历史累计错误不能把当前会话标成 error，新回合开始要覆盖上一回合终态。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import { _resetZcodeSessions, getSessionDetail, getSessions } from '../../adapters/zcode/sessions.mjs'

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
  _resetZcodeSessions()
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (err) {}
  }
})

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zlive-'))
  dirs.push(dir)
  const file = path.join(dir, 'db.sqlite')
  const db = new sqlite.DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER);
    CREATE TABLE model_usage (
      session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, query_source TEXT,
      started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      computed_total_tokens INTEGER
    );
    CREATE TABLE turn_usage (
      session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER
    );
    CREATE TABLE tool_usage (session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  `)
  const insS = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)')
  const insM = db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const insT = db.prepare('INSERT INTO turn_usage VALUES (?,?,?,?,?,?)')
  const insTool = db.prepare('INSERT INTO tool_usage VALUES (?,?,?,?,?,?)')
  const insMsg = db.prepare('INSERT INTO message VALUES (?,?,?,?)')

  // s1：上一回合已完成，但历史上有模型/工具错误；当前没有新回合 → idle，不能是 error
  insS.run('s1', null, '历史错误', NOW - 60_000, NOW - 39_500, null, null)
  insMsg.run('m1', 's1', NOW - 40_500, '{}')
  insM.run('s1', 't1', 'deepseek', 'deepseek-flash', 'completed', 'main_turn', NOW - 50_000, NOW - 40_000, 1000, 100, 0, 0, 0, 1100)
  insM.run('s1', 't1', 'deepseek', 'deepseek-flash', 'error', 'main_turn', NOW - 45_000, NOW - 44_000, 500, 0, 0, 0, 0, 500)
  insT.run('s1', 't1', 'completed', NOW - 50_000, NOW - 40_000, 10_000)
  insTool.run('s1', 't1', 'Bash', 'error', NOW - 44_000, 100)

  // s2：上一回合真的失败，之后没有新活动 → error
  insS.run('s2', null, '失败回合', NOW - 60_000, NOW - 9000, null, null)
  insMsg.run('m2', 's2', NOW - 12_000, '{}')
  insM.run('s2', 't2', 'deepseek', 'deepseek-flash', 'error', 'main_turn', NOW - 12_000, NOW - 10_000, 900, 0, 0, 0, 0, 900)
  insT.run('s2', 't2', 'error', NOW - 12_000, NOW - 9000, 3000)

  // s3：上一回合失败，但 session 已更新（新回合刚开始，turn_usage 还没落库）→ working
  insS.run('s3', null, '新回合已开始', NOW - 60_000, NOW - 1000, null, null)
  insMsg.run('m3', 's3', NOW - 1000, '{}')
  insM.run('s3', 't3', 'deepseek', 'deepseek-flash', 'error', 'main_turn', NOW - 20_000, NOW - 18_000, 900, 0, 0, 0, 0, 900)
  insT.run('s3', 't3', 'error', NOW - 20_000, NOW - 18_000, 2000)

  // s4：取消的回合不是错误，也不应一直 working
  insS.run('s4', null, '已取消', NOW - 60_000, NOW - 8000, null, null)
  insMsg.run('m4', 's4', NOW - 8000, '{}')
  insM.run('s4', 't4', 'deepseek', 'deepseek-flash', 'completed', 'main_turn', NOW - 20_000, NOW - 15_000, 700, 50, 0, 0, 0, 750)
  insT.run('s4', 't4', 'cancelled', NOW - 20_000, NOW - 8000, 12_000)

  // s5：标题生成错误晚于成功回合，但不能把会话标成 error
  insS.run('s5', null, '标题生成失败', NOW - 60_000, NOW - 14_500, null, null)
  insMsg.run('m5', 's5', NOW - 15_000, '{}')
  insM.run('s5', 't5', 'deepseek', 'deepseek-flash', 'completed', 'main_turn', NOW - 20_000, NOW - 15_000, 700, 50, 0, 0, 0, 750)
  insM.run('s5', 'tt', 'deepseek', 'deepseek-flash', 'error', 'session_title', NOW - 9000, NOW - 8000, 200, 0, 0, 0, 0, 200)
  insT.run('s5', 't5', 'completed', NOW - 20_000, NOW - 15_000, 5000)

  // s6（问题 6）：回合仍在进行——消息已 6 分钟（sessionActive 失效），最新
  // 模型调用属于回合内（晚于上一回合结束）且完成于 50s 前：思考间隙必须
  // 保持 working，不能按 20s 新鲜度横跳到空闲。
  insS.run('s6', null, '回合内思考间隙', NOW - 500_000, NOW - 50_000, null, null)
  insMsg.run('m6', 's6', NOW - 360_000, '{}')
  insM.run('s6', 't6c', 'deepseek', 'deepseek-flash', 'completed', 'main_turn', NOW - 70_000, NOW - 50_000, 800, 100, 0, 0, 0, 900)
  insT.run('s6', 't6', 'completed', NOW - 420_000, NOW - 400_000, 20_000)

  // s7（问题 6）：同场景，但最新模型调用完成于 11 分钟前（≥10 分钟静默阈值）→ 空闲
  insS.run('s7', null, '静默超阈值', NOW - 800_000, NOW - 660_000, null, null)
  insMsg.run('m7', 's7', NOW - 780_000, '{}')
  insM.run('s7', 't7c', 'deepseek', 'deepseek-flash', 'completed', 'main_turn', NOW - 690_000, NOW - 660_000, 800, 100, 0, 0, 0, 900)
  insT.run('s7', 't7', 'completed', NOW - 800_000, NOW - 780_000, 20_000)

  // s8（问题 6）：终端工具已 running 7 分钟：在途证据（10 分钟窗口内），
  // 保持 working；5 分钟窗口会把它误判成空闲、下一次轮询又拉回工作中。
  insS.run('s8', null, '长工具执行中', NOW - 600_000, NOW - 420_000, null, null)
  insMsg.run('m8', 's8', NOW - 430_000, '{}')
  insM.run('s8', 't8', 'deepseek', 'deepseek-flash', 'completed', 'main_turn', NOW - 440_000, NOW - 430_000, 600, 60, 0, 0, 0, 660)
  insT.run('s8', 't8', 'completed', NOW - 440_000, NOW - 430_000, 10_000)
  insTool.run('s8', 't8c', 'Bash', 'running', NOW - 420_000, null)
  db.close()
  return { dir, file }
}

test('zcode live: 历史累计错误不影响当前状态', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb()
  try {
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: NOW, sort: 'updated', limit: 20 })
    const by = Object.fromEntries(r.items.map((s) => [s.sessionId, s.status]))
    assert.equal(by.s1, 'idle', '已完成回合后的历史错误不能标成 error')
    assert.equal(by.s2, 'error', '最新回合失败应显示 error')
    assert.equal(by.s3, 'working', '新回合已开始（session 更新）应显示 working')
    assert.equal(by.s4, 'idle', '取消的回合不应显示 error/working')
    assert.equal(by.s5, 'idle', '标题生成错误不能影响会话状态')
    assert.equal(by.s6, 'working', '回合内思考间隙（最新调用完成 50s）应保持 working')
    assert.equal(by.s7, 'idle', '静默超过 10 分钟阈值应回落空闲')
    assert.equal(by.s8, 'working', 'running 工具（7 分钟）是在途证据，应保持 working')
    const s8 = r.items.find((x) => x.sessionId === 's8')
    assert.deepEqual(s8.tools.running, [{ name: 'Bash', since: NOW - 420_000 }], 'running 工具要随快照带出（实时层在途保护用）')
  } finally {
    _resetZcodeSessions()
  }
})

test('zcode live: 取消回合在详情里显示 cancelled，不伪装成进行中', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb()
  try {
    _resetZcodeSessions()
    const d = await getSessionDetail('s4', { dbFile: file, now: NOW })
    assert.equal(d.turns.length, 1)
    assert.equal(d.turns[0].status, 'cancelled')
  } finally {
    _resetZcodeSessions()
  }
})

// 问题 6「状态横跳」时间回放：s6 的回合未结束、最新模型调用完成于 NOW-50s。
// 长工具结束到首字之间没有新库行，10 分钟静默阈值内必须持续 working；
// 阈值耗尽（无任何新证据）才回落 idle。
test('zcode live: 回合内思考间隙按 10 分钟保持——时间回放不横跳', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb()
  const statusAt = async (when) => {
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: when, sort: 'updated', limit: 20 })
    return r.items.find((x) => x.sessionId === 's6')
  }
  try {
    assert.equal((await statusAt(NOW)).status, 'working', 't=0：距最后证据 50s，回合内保持 working')
    assert.equal((await statusAt(NOW + 30_000)).status, 'working', 't=+30s：距最后证据 80s，仍在窗口内')
    assert.equal((await statusAt(NOW + 530_000)).status, 'working', 't=+530s：距最后证据 580s，不提前降级')
    const after = await statusAt(NOW + 560_000)
    assert.equal(after.status, 'idle', 't=+560s：距最后证据 610s，10 分钟阈值耗尽 → idle')
    assert.equal(after.statusSource, 'db', '降级来自上一回合的终态行（回合结束证据），不是推断')
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
