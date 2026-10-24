// ZCode 适配器（R5）：用临时 sqlite 库验证聚合口径
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAppStats, readUsage, _resetConnection } from '../../adapters/zcode/store.mjs'
import { zcodeAdapter } from '../../adapters/zcode/index.mjs'
import { resolveAdapter } from '../../adapters/registry.mjs'
import { createBillingService } from '../../daemon/src/billing.mjs'

// 单测不读开发机上的厂商凭据，也不出网；快照只验证用量库聚合。
process.env.FOX_DOCK_VENDOR_BALANCES = '0'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

// 2026-10-19 12:00 (+08)；行数据放在同日 03:00（DeepSeek 谷价）
const NOON = Date.UTC(2026, 9, 19, 4, 0, 0)
const OFFPEAK = Date.UTC(2026, 9, 18, 19, 0, 0)

function makeDb(rows, turns = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zcode-db-'))
  const file = path.join(dir, 'db.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE model_usage (
      id TEXT, session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
      started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, computed_total_tokens INTEGER,
      duration_ms INTEGER, time_to_first_token_ms INTEGER
    );
    CREATE TABLE turn_usage (
      session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER
    );
    CREATE TABLE tool_usage (
      session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER
    );
  `)
  const insM = db.prepare(
    `INSERT INTO model_usage (id, session_id, turn_id, provider_id, model_id, status, started_at,
      input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, computed_total_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  rows.forEach((r, i) => {
    insM.run(
      'm' + i,
      r.session || 's1',
      r.turn || 't1',
      r.provider || 'deepseek',
      r.model || 'deepseek-flash',
      r.status || 'completed',
      r.startedAt,
      r.input || 0,
      r.output || 0,
      r.reasoning || 0,
      r.cacheRead || 0,
      r.cacheWrite || 0,
      (r.input || 0) + (r.output || 0)
    )
  })
  const insT = db.prepare('INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at) VALUES (?,?,?,?,?)')
  turns.forEach((t) => insT.run(t.session || 's1', t.turn || 't1', t.status || 'completed', t.startedAt, t.completedAt || t.startedAt))
  db.close()
  _resetConnection()
  return { file, dir }
}

// store 持有只读连接；Windows 上不先关连接就删文件会 EBUSY
function cleanup(dir) {
  _resetConnection()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
}

const bigRow = (over = {}) => ({
  startedAt: OFFPEAK,
  input: 1_000_000,
  output: 1_000_000,
  ...over,
})

// 显式给统计区间：CI runner 是 UTC，开发机是 UTC+8，不能依赖 runner 的
// 「本地零点」去圈选固定时间戳，否则同一批行会在另一个时区落到昨天。
const readDay = (file) => readUsage({ dbFile: file, now: NOON, since: OFFPEAK, until: NOON })

test('zcode: 今日合计 = 逐行计价之和（1M 输入 + 1M 输出 = ¥5.00 谷价）', () => {
  const { file, dir } = makeDb([bigRow(), bigRow({ turn: 't2' })])
  try {
    const r = readDay(file)
    assert.equal(r.ok, true)
    assert.equal(r.today.calls, 2)
    assert.equal(r.today.tokens, 4_000_000)
    assert.ok(Math.abs(r.today.byCurrency.CNY - 10) < 1e-6, JSON.stringify(r.today.byCurrency))
  } finally {
    cleanup(dir)
  }
})

test('zcode: 预付池（cmdgo）金额记 0，但 tokens 照算', () => {
  const { file, dir } = makeDb([bigRow({ provider: 'cmdgo-bridge' })])
  try {
    const r = readDay(file)
    assert.equal(r.ok, true)
    assert.equal(r.today.byCurrency.CNY || 0, 0)
    assert.equal(r.today.tokens, 2_000_000)
  } finally {
    cleanup(dir)
  }
})

test('zcode: 零 token 行、昨日行、非 completed 行都不计入今日', () => {
  const { file, dir } = makeDb([
    bigRow(),
    { startedAt: OFFPEAK, input: 0, output: 0 },
    bigRow({ startedAt: OFFPEAK - 1, turn: 't2' }),
    bigRow({ startedAt: OFFPEAK, status: 'failed', turn: 't3' }),
  ])
  try {
    const r = readDay(file)
    assert.equal(r.ok, true)
    assert.equal(r.today.calls, 1)
    assert.ok(Math.abs(r.today.byCurrency.CNY - 5) < 1e-6)
  } finally {
    cleanup(dir)
  }
})

test('zcode: 多币种分开累计（USD 与 CNY 不相加）', () => {
  const { file, dir } = makeDb([bigRow(), bigRow({ provider: 'openai', model: 'gpt-5.5', turn: 't2' })])
  try {
    const r = readDay(file)
    assert.equal(r.ok, true)
    assert.ok(r.today.byCurrency.CNY > 0)
    assert.ok(r.today.byCurrency.USD > 0)
    assert.ok(r.today.byCurrency.USD < 100)
  } finally {
    cleanup(dir)
  }
})

test('zcode: 按厂商拆分今日金额与 tokens', () => {
  const { file, dir } = makeDb([
    bigRow(),
    bigRow({ provider: 'openai', model: 'gpt-5.5', turn: 't2' }),
    bigRow({ provider: 'cmdgo-bridge', turn: 't3' }),
  ])
  try {
    const r = readDay(file)
    assert.equal(r.ok, true)
    assert.ok(r.today.byVendor.deepseek, JSON.stringify(r.today.byVendor))
    assert.ok(r.today.byVendor.openai, JSON.stringify(r.today.byVendor))
    assert.equal(r.today.byVendor.openai.byCurrency.USD > 0, true)
    assert.equal(r.today.byVendor.deepseek.calls, 2)
    // cmdgo 预付池金额记 0，但仍算 tokens/调用
    assert.equal(r.today.byVendor.deepseek.byCurrency.CNY, 5)
  } finally {
    cleanup(dir)
  }
})

test('zcode: 上一轮取最近 completed 的 turn', () => {
  const { file, dir } = makeDb(
    [bigRow({ turn: 'old', startedAt: OFFPEAK - 3600_000 }), bigRow({ turn: 'new' }), bigRow({ turn: 'new' })],
    [
      { turn: 'old', startedAt: OFFPEAK - 3600_000, completedAt: OFFPEAK - 3500_000 },
      { turn: 'new', startedAt: OFFPEAK, completedAt: OFFPEAK + 10_000 },
    ]
  )
  try {
    const r = readDay(file)
    assert.equal(r.ok, true)
    assert.ok(r.lastTurn, 'lastTurn missing')
    assert.equal(r.lastTurn.calls, 2)
    assert.equal(r.lastTurn.at, OFFPEAK + 10_000)
    assert.ok(Math.abs(r.lastTurn.amount - 10) < 1e-6)
  } finally {
    cleanup(dir)
  }
})

test('zcode: 回合进行中按最新一次调用切厂商，不等回合结束', () => {
  const { file, dir } = makeDb(
    [
      bigRow({ turn: 'prev', provider: 'cmdgo-bridge', startedAt: OFFPEAK }),
      bigRow({ turn: 'active', provider: 'deepseek', startedAt: OFFPEAK + 60_000 }),
    ],
    [{ turn: 'prev', startedAt: OFFPEAK, completedAt: OFFPEAK + 10_000 }]
  )
  try {
    const r = readDay(file)
    assert.equal(r.ok, true)
    // 最近 completed 的回合仍是 CommandCode，但当前调用已经换成 DeepSeek
    assert.equal(r.lastTurn && r.lastTurn.provider, 'cmdgo-bridge')
    assert.equal(r.lastProvider, 'deepseek')
    assert.equal(r.lastModel, 'deepseek-flash')
  } finally {
    cleanup(dir)
  }
})

test('zcode: 统计页聚合总量、模型、日与热力图', () => {
  const { file, dir } = makeDb(
    [bigRow({ turn: 't1' }), bigRow({ turn: 't2' })],
    [{ turn: 't1', startedAt: OFFPEAK, completedAt: OFFPEAK + 10_000 }]
  )
  try {
    const s = readAppStats({ dbFile: file, range: 'all', now: NOON, since: OFFPEAK, until: NOON, tzOffsetMs: 8 * 3600_000 })
    assert.equal(s.supported, true, JSON.stringify(s))
    assert.equal(s.summary.totalTokens, 4_000_000)
    assert.equal(s.summary.totalSessions, 1)
    assert.equal(s.summary.totalTurns, 1)
    assert.equal(s.models.length, 1)
    assert.equal(s.models[0].share, 1)
    assert.equal(s.heatmap.weeks.length, 53, '活动墙固定最近 53 周')
    assert.equal(s.heatmap.maxTokens, 4_000_000)
    assert.equal(s.summary.currentStreakDays, 1)
  } finally {
    cleanup(dir)
  }
})

test('zcode: 老库没有 tool_usage 时只降级统计，不影响今日/上一轮', () => {
  const { file, dir } = makeDb([bigRow()], [{ turn: 't1', startedAt: OFFPEAK, completedAt: OFFPEAK + 10_000 }])
  try {
    const raw = new DatabaseSync(file)
    raw.exec('DROP TABLE tool_usage')
    raw.close()
    _resetConnection()
    const usage = readDay(file)
    assert.equal(usage.ok, true)
    assert.equal(usage.today.tokens, 2_000_000)
    const stats = readAppStats({ dbFile: file, range: 'all', now: NOON, since: OFFPEAK, until: NOON, tzOffsetMs: 8 * 3600_000 })
    assert.equal(stats.supported, false)
    assert.equal(stats.reason, 'db-read-failed')
  } finally {
    cleanup(dir)
  }
})

test('zcode: 库不存在 → db-missing；适配器返回可读错误而不是 0 元', async () => {
  const missing = path.join(os.tmpdir(), 'fox-zcode-nope-' + Date.now(), 'db.sqlite')
  const r = readUsage({ dbFile: missing, now: NOON })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'db-missing')

  // 默认路径在这台机器上是**存在**的，必须显式指向不存在的库才能测「库缺失」
  const prev = process.env.FOX_DOCK_ZCODE_DB
  process.env.FOX_DOCK_ZCODE_DB = missing
  try {
    const svc = createBillingService({ adapters: [zcodeAdapter] })
    const snap = await svc.snapshot({ exe: 'C:\\Apps\\ZCode\\ZCode.exe', title: 'ZCode' })
    assert.equal(snap.adapterId, 'zcode')
    assert.equal(snap.supported, true)
    assert.equal(snap.ok, false)
    assert.match(snap.error, /用量库|ZCode/)
  } finally {
    if (prev === undefined) delete process.env.FOX_DOCK_ZCODE_DB
    else process.env.FOX_DOCK_ZCODE_DB = prev
  }
})

test('zcode: 窗口识别只认 exe 基名，不误伤浮层与其它进程', () => {
  const hit = resolveAdapter({ exe: 'C:\\Users\\x\\AppData\\Local\\Programs\\ZCode\\ZCode.exe', title: 'ZCode — x' }, [
    zcodeAdapter,
  ])
  assert.equal(hit.id, 'zcode')
  assert.equal(hit.fallback, false)

  assert.equal(resolveAdapter({ exe: 'C:\\x\\electron.exe', title: 'ZCode狐娘小挂件' }, [zcodeAdapter]).id, 'generic')
  assert.equal(resolveAdapter({ exe: 'C:\\x\\notepad.exe', title: 'zcode.txt' }, [zcodeAdapter]).id, 'generic')
})
