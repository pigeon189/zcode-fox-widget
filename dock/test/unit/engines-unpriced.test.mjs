// 价目表未收录的按量模型：引擎层金额不可得时不得补 0。
// 覆盖 usage-records（今日已用/厂商汇总/明细）与 turn-cost（每轮消耗）。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sqlite = (() => {
  try {
    return require('node:sqlite')
  } catch (err) {
    return null
  }
})()

const DAY_START = new Date().setHours(0, 0, 0, 0)
// 今天之内，且不会在零点附近落到昨天。
const AT = Math.max(DAY_START + 1, Date.now() - 1000)

const schema = `
  CREATE TABLE model_usage (
    session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
    started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, computed_total_tokens INTEGER,
    attempt_index INTEGER
  );
  CREATE TABLE turn_usage (
    session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER
  );
`

function writeDb(file) {
  try {
    fs.rmSync(file, { force: true })
  } catch (err) {}
  const db = new sqlite.DatabaseSync(file)
  db.exec(schema)
  return db
}

function insertRow(db, r) {
  db.prepare(`INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    r.session || 's1',
    r.turn || 't1',
    r.provider,
    r.model,
    r.status || 'completed',
    r.at,
    r.input || 0,
    r.output || 0,
    r.reasoning || 0,
    r.cacheRead || 0,
    r.cacheWrite || 0,
    r.total || 0,
    r.attempt || 0
  )
}

let tempRoot = null
let dbFile = null
let usageRecords = null
let todayVendorUsage = null
let resetUsageRecords = null
let readLatestTurn = null
let resetTurnCostDb = null

async function ensureModules() {
  if (usageRecords) return
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-eng-unpriced-'))
  dbFile = path.join(tempRoot, 'cli', 'db', 'db.sqlite')
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  process.env.ZCODE_HOME = tempRoot
  // paths.mjs 在模块加载时读 ZCODE_HOME，所以必须在设置环境变量之后再 import。
  const tc = await import('../../engines/turn-cost.mjs')
  readLatestTurn = tc.readLatestTurn
  resetTurnCostDb = tc._resetTurnCostDb
  const ur = await import('../../engines/usage-records.mjs?' + Date.now())
  usageRecords = ur.usageRecords
  todayVendorUsage = ur.todayVendorUsage
  resetUsageRecords = ur._resetUsageRecords
}

function seed(rows, turns = [{ session: 's1', turn: 't1' }]) {
  resetTurnCostDb()
  resetUsageRecords()
  const db = writeDb(dbFile)
  for (const r of rows) insertRow(db, r)
  for (const t of turns) {
    db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?)`).run(
      t.session || 's1',
      t.turn || 't1',
      t.status || 'completed',
      t.startedAt || AT - 60_000,
      t.completedAt || AT,
      60_000
    )
  }
  db.close()
}

after(() => {
  try {
    resetTurnCostDb()
    resetUsageRecords()
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } catch (err) {}
})

const priced = { provider: 'deepseek', model: 'deepseek-chat', at: AT, input: 1_000_000, output: 1_000_000, total: 2_000_000 }
const unpriced = { provider: 'openai', model: 'gpt-5', at: AT, input: 1_000_000, output: 1_000_000, total: 2_000_000 }

test('engines: 未收录模型不计 0 元（今日已用/厂商汇总/明细）', { skip: !sqlite }, async () => {
  await ensureModules()
  seed([priced, unpriced])
  const rec = usageRecords()
  assert.equal(rec.ok, true, JSON.stringify(rec))
  assert.ok(rec.today.totals.CNY > 0, JSON.stringify(rec.today.totals))
  assert.equal(rec.today.totals.USD, undefined, '未收录模型不能建 0 金额桶')
  assert.equal(rec.today.unpriced, 1, '记录「有行但算不出金额」的数量')
  assert.ok(rec.today.total > 0)
  assert.equal(rec.today.byVendor.OpenAI.amount, null, '厂商金额不可得')
  assert.ok(rec.today.byVendor.OpenAI.tokens > 0, 'tokens 照算')
  assert.ok(rec.today.byVendor.DeepSeek.amount > 0)
  const openaiModel = rec.today.models.find((m) => m.model === 'gpt-5')
  assert.equal(openaiModel.amount, null)
  assert.equal(openaiModel.market, null)
  // 「今日已用」主口径：不把未知价当 0 返回（调用方按 typeof 回退账号口径）
  assert.equal(todayVendorUsage('OpenAI').amount, null)
  assert.ok(todayVendorUsage('DeepSeek').amount > 0)
  // 逐日明细：可计价金额照常（USD 不会以 0 出现在 totals 里）
  const day = rec.days7.byDay[0]
  assert.ok(day.total > 0)
  assert.equal(day.totals.USD, undefined)
})

test('engines: 一整天只有未收录模型 → 今日/逐日/每轮金额均为 null', { skip: !sqlite }, async () => {
  await ensureModules()
  seed([unpriced])
  const rec = usageRecords()
  assert.equal(rec.ok, true, JSON.stringify(rec))
  assert.equal(rec.today.total, null, '今日金额不可得，不是 ¥0.00')
  assert.deepEqual(rec.today.totals, {})
  assert.equal(rec.today.unpriced, 1)
  assert.equal(rec.days7.byDay[0].total, null)
  assert.equal(rec.today.byVendor.OpenAI.amount, null)
  assert.equal(todayVendorUsage('OpenAI').amount, null)

  seed([unpriced])
  const turn = readLatestTurn()
  assert.equal(turn.ok, true, JSON.stringify(turn))
  assert.equal(turn.amount, null, '每轮金额不可得')
  assert.equal(turn.unpriced, 1)
  assert.ok(turn.tokens > 0, 'tokens 与逐模型明细仍可用')
  assert.equal(turn.models[0].amount, null)
})

test('engines: 可计价行金额照常（不因新规则被清零）', { skip: !sqlite }, async () => {
  await ensureModules()
  seed([priced])
  const rec = usageRecords()
  assert.ok(rec.today.total > 0)
  assert.equal(rec.today.unpriced, 0)
  assert.equal(rec.days7.byDay[0].total, rec.today.total)
  seed([priced])
  const turn = readLatestTurn()
  assert.ok(turn.amount > 0)
  assert.equal(turn.unpriced, 0)
})
