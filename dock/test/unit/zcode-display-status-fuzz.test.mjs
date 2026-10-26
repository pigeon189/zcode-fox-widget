// ZCode 适配器 displayStatus 派生的属性/模糊测试（D056）：固定种子生成随机时序，
// 真实 SQLite 夹具走 getSessions 全链路，断言具体值。
// 不变量：
//   1. 合并优先级：活跃 > workflowBusy > turnActive > done > doneAt 5 分钟窗口 > idle；
//   2. cancelled + 无活跃 = idle（手动停止不显示「工作中/已完成」）；
//   3. doneAt 只来自 completed 回合或已结束的 workflow run（cancelled/error/活跃都不落）；
//   4. 状态筛选与展示同源（displayStatusOf）。
// 回合/窗口边界都带 ±1ms 样本；每个场景独立临时库，after() 统一清理。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

import { _resetZcodeSessions, getSessions } from '../../adapters/zcode/sessions.mjs'
import { DONE_DISPLAY_MS, displayStatusOf, normalizeSession } from '../../shared/session-model.mjs'

const require = createRequire(import.meta.url)
const sqlite = (() => {
  try {
    return require('node:sqlite')
  } catch (err) {
    return null
  }
})()

// 固定种子 PRNG（mulberry32）：任何失败样本都能用同一种子复现。
function mulberry32(seedNum) {
  let a = seedNum >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NOW0 = new Date(2026, 9, 27, 12, 0, 0).getTime()
const DONE_HOLD_MS = 4000
const dirs = []

after(() => {
  _resetZcodeSessions()
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch (err) {}
  }
})

function makeDb(file, sc) {
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
    CREATE TABLE dwf_run (parent_session_id TEXT, status TEXT, time_updated INTEGER);
  `)
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run(
    sc.id, null, '场景 ' + sc.id, sc.turnStart - 60_000, sc.messageAt || sc.turnEnd, null, null
  )
  if (sc.turn) {
    db.prepare('INSERT INTO turn_usage VALUES (?,?,?,?,?,?)').run(
      sc.id, 't1', sc.turn.status, sc.turnStart, sc.turnEnd, sc.turnEnd - sc.turnStart
    )
  }
  if (sc.model) {
    db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      sc.id, 't1', 'deepseek', 'deepseek-flash', sc.model.status, 'main_turn',
      sc.model.startedAt, sc.model.completedAt, 100, 10, 0, 0, 0, 110
    )
  }
  if (sc.tool) {
    db.prepare('INSERT INTO tool_usage VALUES (?,?,?,?,?,?)').run(
      sc.id, 't1', sc.tool.name, sc.tool.status, sc.tool.startedAt, null
    )
  }
  if (sc.messageAt != null) {
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', sc.id, sc.messageAt, '{}')
  }
  if (sc.wf) {
    db.prepare('INSERT INTO dwf_run VALUES (?,?,?)').run(sc.id, sc.wf.status, sc.wf.timeUpdated)
  }
  db.close()
}

// 每个场景孤立一个分支，期望值由生成参数直接算出（不是镜像 statusOf 全逻辑）。
function expectedOf(sc, now) {
  const turnEnd = sc.turnEnd
  switch (sc.family) {
    case 'completed': {
      const status = now - turnEnd < DONE_HOLD_MS ? 'done' : 'idle'
      return { status, statusSource: 'db', doneAt: turnEnd, endedAt: turnEnd, workflowBusy: false, displayStatus: now - turnEnd < DONE_DISPLAY_MS ? 'done' : 'idle' }
    }
    case 'cancelled':
    case 'cancelled-stale-model':
      // 手动停止：idle + 无 doneAt，任何时刻都不显示工作中/已完成
      return { status: 'idle', statusSource: 'db', doneAt: null, endedAt: turnEnd, workflowBusy: false, displayStatus: 'idle' }
    case 'cancelled-new-message': {
      // 停止后用户重新发话（>2s）→ 按新回合推断工作中；静默 5 分钟后回空闲
      const active = now - sc.messageAt < 5 * 60_000
      return { status: active ? 'working' : 'idle', statusSource: active ? 'inferred' : 'db', doneAt: null, endedAt: turnEnd, workflowBusy: false, displayStatus: active ? 'working' : 'idle' }
    }
    case 'cancelled-running-tool':
      // 在途工具（10 分钟窗口内）是工作证据：优先级高于停止后的 idle
      return { status: 'working', statusSource: 'db', doneAt: null, endedAt: turnEnd, workflowBusy: false, displayStatus: 'working' }
    case 'workflow-running':
      // workflow 在跑压制 idle/done：即使编排回合已结束也显示工作中
      return { status: 'working', statusSource: 'db', doneAt: null, endedAt: turnEnd, workflowBusy: true, displayStatus: 'working' }
    case 'workflow-ended-completed': {
      const wfEnd = sc.wfEnd
      const status = now - turnEnd < DONE_HOLD_MS ? 'done' : 'idle'
      // 4 秒内机器状态就是 done；降级后由 doneAt（= wfEnd）撑窗口，
      // 且 displayStatusOf 要求 now ≥ doneAt（未来时刻不预支）。
      const display =
        now - turnEnd < DONE_HOLD_MS || (now >= wfEnd && now - wfEnd < DONE_DISPLAY_MS) ? 'done' : 'idle'
      return { status, statusSource: 'db', doneAt: Math.max(turnEnd, wfEnd), endedAt: turnEnd, workflowBusy: false, displayStatus: display }
    }
    case 'workflow-ended-cancelled': {
      // workflow 全部结束：用 run 的结束时间起算 5 分钟「已完成」展示窗口
      // （停止的回合本身不落 doneAt，这里展示的是 workflow 的完成）
      const wfEnd = sc.wfEnd
      const display = now >= wfEnd && now - wfEnd < DONE_DISPLAY_MS ? 'done' : 'idle'
      return { status: 'idle', statusSource: 'db', doneAt: wfEnd, endedAt: turnEnd, workflowBusy: false, displayStatus: display }
    }
    case 'error-turn': {
      const active = now - turnEnd < 5 * 60_000
      return { status: active ? 'error' : 'idle', statusSource: 'db', doneAt: null, endedAt: turnEnd, workflowBusy: false, displayStatus: active ? 'error' : 'idle' }
    }
    default:
      throw new Error('未知场景族 ' + sc.family)
  }
}

function nowGridOf(sc) {
  const grid = new Set([sc.turnEnd, sc.turnEnd + 1, sc.turnEnd + DONE_HOLD_MS - 1, sc.turnEnd + DONE_HOLD_MS, sc.base, sc.base + 60_000])
  if (sc.wfEnd != null) {
    grid.add(sc.wfEnd)
    grid.add(sc.wfEnd + DONE_DISPLAY_MS - 1)
    grid.add(sc.wfEnd + DONE_DISPLAY_MS)
    grid.add(sc.wfEnd + DONE_DISPLAY_MS + 1)
  } else {
    grid.add(sc.turnEnd + DONE_DISPLAY_MS - 1)
    grid.add(sc.turnEnd + DONE_DISPLAY_MS)
    grid.add(sc.turnEnd + DONE_DISPLAY_MS + 1)
  }
  if (sc.messageAt != null) {
    grid.add(sc.messageAt + 5 * 60_000 - 1)
    grid.add(sc.messageAt + 5 * 60_000)
    grid.add(sc.messageAt + 5 * 60_000 + 1)
  }
  if (sc.family === 'error-turn') {
    grid.add(sc.turnEnd + 5 * 60_000 - 1)
    grid.add(sc.turnEnd + 5 * 60_000)
    grid.add(sc.turnEnd + 5 * 60_000 + 1)
  }
  return [...grid].sort((a, b) => a - b)
}

// 9 个场景族 × 每族 3 个随机样本 = 27 个独立临时库
const FAMILIES = [
  'completed',
  'cancelled',
  'cancelled-stale-model',
  'cancelled-new-message',
  'cancelled-running-tool',
  'workflow-running',
  'workflow-ended-completed',
  'workflow-ended-cancelled',
  'error-turn',
]

function makeScenario(family, i, rand) {
  const turnEnd = NOW0 + i * 3_600_000 - 10_000 - Math.floor(rand() * 5_000)
  const turnStart = turnEnd - 30_000 - Math.floor(rand() * 120_000)
  const sc = { id: 'sc' + i, family, turnEnd, turnStart, base: turnEnd + 30_000, messageAt: null, model: null, tool: null, wf: null, wfEnd: null }
  switch (family) {
    case 'completed': {
      sc.turn = { status: 'completed' }
      // model 行完成于回合结束之前：不触发 modelAfterTurn 的 holdModel 分支
      sc.model = { status: 'completed', startedAt: turnStart, completedAt: turnEnd - 1 - Math.floor(rand() * 3_000) }
      sc.messageAt = turnEnd - Math.floor(rand() * 2_000)
      break
    }
    case 'cancelled': {
      sc.turn = { status: 'cancelled' }
      sc.model = { status: 'cancelled', startedAt: turnStart + 1000, completedAt: turnEnd - 1 - Math.floor(rand() * 2_000) }
      sc.messageAt = turnEnd - Math.floor(rand() * 2_000)
      break
    }
    case 'cancelled-stale-model': {
      // 最后一笔 model 行晚于 cancelled 的结束时刻：停止的明确结束必须压过 holdModel
      sc.turn = { status: 'cancelled' }
      const late = turnEnd + 500 + Math.floor(rand() * 500)
      sc.model = { status: 'cancelled', startedAt: late, completedAt: late + 300 }
      sc.messageAt = turnEnd - Math.floor(rand() * 2_000)
      break
    }
    case 'cancelled-new-message': {
      sc.turn = { status: 'cancelled' }
      sc.model = { status: 'cancelled', startedAt: turnStart + 1000, completedAt: turnEnd - 500 }
      sc.messageAt = turnEnd + 3000 // > lastTurnDone + 2000 → 按新回合推断
      break
    }
    case 'cancelled-running-tool': {
      sc.turn = { status: 'cancelled' }
      sc.model = { status: 'cancelled', startedAt: turnStart + 1000, completedAt: turnEnd - 500 }
      sc.messageAt = turnEnd - Math.floor(rand() * 2_000)
      sc.tool = { name: 'Bash', status: 'running', startedAt: sc.base - 60_000 }
      break
    }
    case 'workflow-running': {
      sc.turn = { status: 'completed' }
      sc.model = { status: 'completed', startedAt: turnStart, completedAt: turnEnd - 500 }
      sc.wf = { status: 'running', timeUpdated: turnEnd + 4000 }
      break
    }
    case 'workflow-ended-completed': {
      sc.turn = { status: 'completed' }
      sc.model = { status: 'completed', startedAt: turnStart, completedAt: turnEnd - 500 }
      sc.wfEnd = turnEnd + 4000
      sc.wf = { status: 'succeeded', timeUpdated: sc.wfEnd }
      break
    }
    case 'workflow-ended-cancelled': {
      sc.turn = { status: 'cancelled' }
      sc.model = { status: 'cancelled', startedAt: turnStart + 1000, completedAt: turnEnd - 500 }
      sc.messageAt = turnEnd - Math.floor(rand() * 2_000)
      sc.wfEnd = turnEnd + 4000
      sc.wf = { status: 'failed', timeUpdated: sc.wfEnd }
      break
    }
    case 'error-turn': {
      sc.turn = { status: 'error' }
      sc.model = { status: 'error', startedAt: turnEnd - 1000, completedAt: turnEnd }
      break
    }
  }
  return sc
}

test('displayStatus 派生：9 场景族 × 随机时序的优先级 / 停止 / 窗口不变量', { skip: !sqlite }, async () => {
  const rand = mulberry32(20261027)
  const scenarios = []
  for (let i = 0; i < FAMILIES.length * 3; i++) {
    scenarios.push(makeScenario(FAMILIES[i % FAMILIES.length], i, rand))
  }
  for (const sc of scenarios) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zdisp-'))
    dirs.push(dir)
    const file = path.join(dir, 'db.sqlite')
    makeDb(file, sc)
    for (const now of nowGridOf(sc)) {
      const exp = expectedOf(sc, now)
      const r = await getSessions({ dbFile: file, now, range: 'all', limit: 50, sort: 'updated' })
      assert.equal(r.ok, true, `${sc.id}(${sc.family})`)
      assert.equal(r.supported, true)
      const s = r.items.find((x) => x.sessionId === sc.id)
      assert.ok(s, `${sc.id}(${sc.family}) now=${now}: 会话必须在列表里`)
      const tag = `${sc.id}(${sc.family}) now-now0=${now - NOW0}`
      assert.equal(s.status, exp.status, tag + ' status')
      assert.equal(s.statusSource, exp.statusSource, tag + ' statusSource')
      assert.equal(s.doneAt, exp.doneAt, tag + ' doneAt')
      assert.equal(s.endedAt, exp.endedAt, tag + ' endedAt')
      assert.equal(s.workflowBusy, exp.workflowBusy, tag + ' workflowBusy')
      assert.equal(displayStatusOf(s, now), exp.displayStatus, tag + ' displayStatus')
    }
    // 状态筛选与展示同源：某状态筛得到 ⇔ displayStatus 命中
    const atBase = expectedOf(sc, sc.base)
    for (const st of ['working', 'done', 'idle', 'error']) {
      const fr = await getSessions({ dbFile: file, now: sc.base, range: 'all', limit: 50, sort: 'updated', status: st })
      const hit = fr.items.some((x) => x.sessionId === sc.id)
      assert.equal(hit, atBase.displayStatus === st, `${sc.id}(${sc.family}) 筛选 ${st}: 命中=${hit} 应为 ${atBase.displayStatus === st}`)
    }
  }
})

// ---------------------------------------------------------------------------
// 优先级表：adapter 快照永远不带 turnActive（normalizeSession 归 false），
// turnActive / workflowBusy 的压制在纯会话对象上表驱动验证。
// ---------------------------------------------------------------------------

test('displayStatusOf 合并优先级：活跃 > workflowBusy > turnActive > done > doneAt 窗口 > idle', () => {
  const T = NOW0
  const mk = (over) => ({
    agentId: 'zcode',
    sessionId: 's',
    status: 'idle',
    statusSource: 'db',
    updatedAt: T,
    statusSince: T,
    doneAt: null,
    turnActive: false,
    workflowBusy: false,
    ...over,
  })
  // 1. 活跃状态最高：压过 workflowBusy / turnActive / 新鲜 doneAt
  for (const st of ['working', 'waiting_permission', 'waiting_input', 'error']) {
    const s = mk({ status: st, workflowBusy: true, turnActive: true, doneAt: T })
    assert.equal(displayStatusOf(s, T + 1000), st, st + ' 优先级最高')
  }
  // 2. workflowBusy > turnActive > done/doneAt
  assert.equal(displayStatusOf(mk({ status: 'done', doneAt: T, workflowBusy: true, turnActive: true }), T + 1000), 'working')
  assert.equal(displayStatusOf(mk({ status: 'idle', workflowBusy: true, turnActive: true }), T + 1000), 'working')
  // 3. turnActive > done / doneAt 窗口
  assert.equal(displayStatusOf(mk({ status: 'done', doneAt: T, turnActive: true }), T + 1000), 'working')
  assert.equal(displayStatusOf(mk({ status: 'idle', turnActive: true, doneAt: T }), T + 1000), 'working')
  // 4. done 状态直接显示已完成
  assert.equal(displayStatusOf(mk({ status: 'done', doneAt: T }), T + 1000), 'done')
  // 5. doneAt 5 分钟窗口（±1ms）
  assert.equal(displayStatusOf(mk({ status: 'idle', doneAt: T }), T + DONE_DISPLAY_MS - 1), 'done')
  assert.equal(displayStatusOf(mk({ status: 'idle', doneAt: T }), T + DONE_DISPLAY_MS + 1), 'idle')
  // 6. 都不命中 → idle；未知 → unknown
  assert.equal(displayStatusOf(mk({ status: 'idle' }), T), 'idle')
  assert.equal(displayStatusOf(mk({ status: 'unknown' }), T), 'unknown')
  // 8. 手动停止不显示「工作中/已完成」；且适配器快照经 normalizeSession 归一后
  //    turnActive 恒为布尔 false（非 true 值一律归 false），宿主快照无法伪造回合活跃。
  const cancelled = mk({ status: 'idle', doneAt: null, endedAt: T - 20_000 })
  assert.equal(displayStatusOf(cancelled, T), 'idle')
  assert.equal(displayStatusOf(cancelled, T + 60_000), 'idle')
  assert.equal(displayStatusOf(cancelled, T + DONE_DISPLAY_MS + 1), 'idle')
  const norm = normalizeSession(
    { agentId: 'zcode', sessionId: 's', status: 'idle', statusSource: 'db', updatedAt: T, doneAt: null, turnActive: 'yes' },
    { now: T }
  )
  assert.equal(norm.turnActive, false, '非布尔 true 一律归 false，宿主快照无法伪造回合活跃')
  assert.equal(displayStatusOf(norm, T), 'idle')
})
