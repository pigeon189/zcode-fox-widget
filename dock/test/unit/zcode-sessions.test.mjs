// D034 ZCode 会话层：现场建库（node:sqlite）
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { costOfUsage } from '../../engines/pricing.mjs'
import { createUsageBreakdown } from '../../daemon/src/usage-breakdown.mjs'
import {
  _resetZcodeSessions,
  aggregateUsage,
  getArchivedKeys,
  getLiveStatus,
  getSessionDetail,
  getSessions,
  readUsageRows,
} from '../../adapters/zcode/sessions.mjs'

const require = createRequire(import.meta.url)
const sqlite = (() => {
  try {
    return require('node:sqlite')
  } catch (err) {
    return null
  }
})()

const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime()

function makeDb(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zsess-'))
  const file = path.join(dir, 'db.sqlite')
  const db = new sqlite.DatabaseSync(file, { timeout: 5000 })
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER);
    CREATE TABLE model_usage (
      session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
      started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      computed_total_tokens INTEGER
    );
    CREATE TABLE turn_usage (
      session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER
    );
    ${opts.noTools ? '' : `CREATE TABLE tool_usage (session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);`}
  `)
  db.prepare(`INSERT INTO session VALUES ('s1', NULL, '主会话', ?, ?, NULL, NULL)`).run(NOW - 60_000, NOW - 1000)
  db.prepare(`INSERT INTO session VALUES ('s2', 's1', '子任务', ?, ?, NULL, NULL)`).run(NOW - 50_000, NOW - 500)
  if (opts.archived) {
    db.prepare(`INSERT INTO session VALUES ('s3', NULL, '归档主会话', ?, ?, NULL, ?)`).run(NOW - 70_000, NOW - 2000, NOW - 1500)
    db.prepare(`INSERT INTO session VALUES ('s4', 's3', '归档子任务', ?, ?, NULL, ?)`).run(NOW - 69_000, NOW - 1900, NOW - 1400)
  }
  if (opts.archivedChildUnmarked) {
    // 父会话已归档，子会话自己的 time_archived 为空：必须随父归档/排除。
    db.prepare(`INSERT INTO session VALUES ('s5', 's3', '未标记归档的子任务', ?, ?, NULL, NULL)`).run(NOW - 68_000, NOW - 1800)
  }
  const insM = db.prepare(
    `INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  // 谷价时段（UTC 04:00）之外用 NOW 的本地时间无所谓，只要 tokens 有值
  insM.run('s1', 't1', 'deepseek', 'deepseek-flash', 'completed', NOW - 60_000, NOW - 59_000, 1000, 200, 0, 0, 0, 1200)
  insM.run('s1', 't1', 'deepseek', 'deepseek-flash', 'completed', NOW - 50_000, NOW - 49_000, 500, 100, 0, 0, 0, 600)
  insM.run('s2', 't2', 'deepseek', 'deepseek-flash', 'completed', NOW - 40_000, NOW - 39_000, 300, 50, 0, 0, 0, 350)
  if (opts.latestModel) {
    // 会话中途切换模型：最新调用必须覆盖列表上的旧模型。
    insM.run('s1', 't1', 'commandcode', 'deepseek/deepseek-v4.1-flash', 'completed', NOW - 30_000, NOW - 29_000, 10, 1, 0, 0, 0, 11)
  }
  if (!opts.noTools) {
    const insT = db.prepare(`INSERT INTO tool_usage VALUES (?,?,?,?,?,?)`)
    insT.run('s1', 't1', 'Bash', 'completed', NOW - 55_000, 1200)
    insT.run('s1', 't1', 'Bash', 'error', NOW - 54_000, 300)
    insT.run('s1', 't1', 'Read', 'completed', NOW - 53_000, 80)
  }
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?)`).run('s1', 't1', 'completed', NOW - 60_000, NOW - 48_000, 12_000)
  db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?)`).run('s2', 't2', 'completed', NOW - 40_000, NOW - 38_000, 2_000)
  // 额外用量行（计费审计用例）：{ session, turn, provider, model, at, input, output, reasoning, cacheRead, cacheWrite, total }
  for (const r of opts.extraRows || []) {
    insM.run(
      r.session || 's1', r.turn || 't1', r.provider, r.model, r.status || 'completed', r.at, r.at + 1000,
      r.input || 0, r.output || 0, r.reasoning || 0, r.cacheRead || 0, r.cacheWrite || 0, r.total || 0
    )
  }
  db.close()
  return { dir, file }
}

test('zcode-sessions: 列表聚合、parentKey、成本/来源', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb()
  try {
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: NOW, sort: 'updated', limit: 10 })
    assert.equal(r.supported, true)
    assert.equal(r.items.length, 2)
    const s1 = r.items.find((x) => x.sessionId === 's1')
    assert.equal(s1.key, 'zcode:s1')
    assert.equal(s1.turns.count, 1)
    assert.equal(s1.tokens.total, 1800)
    assert.equal(s1.tools.calls, 3)
    assert.equal(s1.tools.errors, 1)
    assert.ok(s1.cost && s1.cost.amount >= 0)
    assert.equal(s1.provenance.tokens.origin, 'local-db')
    assert.equal(s1.lastHostAt, NOW - 1000, 'lastHostAt 用库里真实时间，不用 now')
    const s2 = r.items.find((x) => x.sessionId === 's2')
    assert.equal(s2.parentKey, 'zcode:s1')
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 列表模型取最近一次调用，不取历史首个模型', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb({ latestModel: true })
  try {
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: NOW, sort: 'updated', limit: 10 })
    const s1 = r.items.find((x) => x.sessionId === 's1')
    assert.equal(s1.model, 'deepseek/deepseek-v4.1-flash')
    assert.equal(s1.provider, 'commandcode')
    const d = await getSessionDetail('s1', { dbFile: file, now: NOW })
    assert.equal(d.session.model, 'deepseek/deepseek-v4.1-flash')
    assert.equal(d.session.provider, 'commandcode')
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 详情 turns/tools/models', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb()
  try {
    _resetZcodeSessions()
    const r = await getSessionDetail('s1', { dbFile: file, now: NOW })
    assert.equal(r.session.sessionId, 's1')
    assert.equal(r.turns.length, 1)
    assert.equal(r.turns[0].tokens, 1800)
    assert.equal(r.tools.length, 2)
    assert.equal(r.models.length, 1)
    assert.equal(r.models[0].calls, 2)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 缺 tool_usage 时降级不崩', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb({ noTools: true })
  try {
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: NOW, limit: 10 })
    assert.equal(r.items.length, 2)
    assert.equal(r.items.find((x) => x.sessionId === 's1').provenance.tools.kind, 'unavailable')
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 最近 20s 有活动 → working(inferred)；旧会话 idle', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb()
  try {
    _resetZcodeSessions()
    // NOW 的上一轮 completed 在 48s 前 → idle
    const r = await getSessions({ dbFile: file, now: NOW, limit: 10 })
    assert.equal(r.items.find((x) => x.sessionId === 's1').status, 'idle')
    // 把最近活动挪到 5s 前 → inferred working
    _resetZcodeSessions()
    const db = new sqlite.DatabaseSync(file, { timeout: 5000 })
    db.prepare(`UPDATE model_usage SET started_at = ?, completed_at = ? WHERE session_id = 's1' AND turn_id = 't1'`).run(NOW - 5000, NOW - 4000)
    db.prepare(`UPDATE turn_usage SET status = 'running' WHERE session_id = 's1'`).run()
    db.close()
    const r2 = await getSessions({ dbFile: file, now: NOW, limit: 10 })
    assert.equal(r2.items.find((x) => x.sessionId === 's1').status, 'working')
    assert.equal(r2.items.find((x) => x.sessionId === 's1').statusSource, 'db')
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: aggregateUsage 5 种维度且金额不跨币种', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb()
  try {
    _resetZcodeSessions()
    for (const by of ['agent', 'model', 'vendor', 'session', 'tool']) {
      const r = await aggregateUsage({ dbFile: file, now: NOW, by, since: NOW - 86400000, until: NOW })
      assert.equal(r.ok, true)
      assert.ok(Array.isArray(r.series))
      if (by === 'tool') {
        const bash = r.series.find((s) => s.key === 'Bash')
        assert.equal(bash.calls, 2)
        assert.equal(bash.errors, 1)
      } else if (by === 'agent') {
        assert.equal(r.series.length, 1)
        assert.equal(r.series[0].key, 'zcode')
        assert.ok(r.series[0].tokens > 0)
      }
    }
    const rows = await readUsageRows({ dbFile: file, now: NOW, since: NOW - 86400000, until: NOW })
    assert.equal(rows.ok, true)
    assert.equal(rows.rows.length, 3)
    assert.ok(rows.rows.every((r) => r.prov && r.prov.origin === 'pricing-table'))
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: getLiveStatus 只返回近期会话', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb()
  try {
    _resetZcodeSessions()
    const r = await getLiveStatus({ dbFile: file, now: NOW, sinceMs: NOW - 10 * 60_000 })
    assert.equal(r.supported, true)
    assert.ok(r.items.length >= 1)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

function makePagingDb({ roots = 6, childrenPerRoot = 2, sameUpdatedAt = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zpage-'))
  const file = path.join(dir, 'db.sqlite')
  const db = new sqlite.DatabaseSync(file, { timeout: 5000 })
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER);
    CREATE TABLE model_usage (
      session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
      started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      computed_total_tokens INTEGER
    );
    CREATE TABLE turn_usage (
      session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER
    );
    CREATE TABLE tool_usage (session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);
  `)
  const ins = db.prepare(`INSERT INTO session VALUES (?,?,?,?,?,NULL,NULL)`)
  for (let i = 0; i < roots; i++) {
    const id = 'r' + i
    const updated = sameUpdatedAt ? NOW - 1000 : NOW - i * 1000
    ins.run(id, null, '根会话 ' + i, NOW - 100_000, updated)
    for (let j = 0; j < childrenPerRoot; j++) {
      ins.run(id + 'c' + j, id, '子会话 ' + i + '-' + j, NOW - 90_000, updated - (j + 1))
    }
  }
  db.close()
  return { dir, file }
}

async function pageAll(file, limit) {
  const roots = []
  let cursor = null
  let pages = 0
  do {
    const r = await getSessions({ dbFile: file, now: NOW, limit, cursor: cursor || undefined, sort: 'updated' })
    for (const s of r.items) if (!s.parentKey) roots.push(s)
    cursor = r.nextCursor
    pages += 1
    assert.ok(pages < 50, '分页不应死循环')
  } while (cursor)
  return { roots, pages }
}

test('zcode-sessions: readUsageRows 支持按本地分钟过滤（P0-3 时间）', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb()
  try {
    _resetZcodeSessions()
    const sampleAt = NOW - 60_000
    const d = new Date(sampleAt)
    const tm = d.getHours() * 60 + d.getMinutes()
    const hit = await readUsageRows({ dbFile: file, now: NOW, since: NOW - 3_600_000, until: NOW, timeMinutes: tm })
    assert.ok(hit.rows.length >= 1)
    for (const r of hit.rows) {
      const x = new Date(r.at)
      assert.equal(x.getHours() * 60 + x.getMinutes(), tm)
    }
    const miss = await readUsageRows({ dbFile: file, now: NOW, since: NOW - 3_600_000, until: NOW, timeMinutes: (tm + 1) % 1440 })
    assert.equal(miss.rows.length, 0)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: archived=exclude|only|all，SQL 参数化且子会话随父', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb({ archived: true })
  try {
    _resetZcodeSessions()
    const exclude = await getSessions({ dbFile: file, now: NOW, limit: 10 })
    assert.deepEqual(exclude.items.map((s) => s.sessionId).sort(), ['s1', 's2'])
    assert.equal(exclude.total, 1, 'total 只计根会话')
    assert.ok(exclude.items.every((s) => s.archived === false))

    const only = await getSessions({ dbFile: file, now: NOW, limit: 10, archived: 'only' })
    assert.deepEqual(only.items.map((s) => s.sessionId).sort(), ['s3', 's4'])
    assert.equal(only.total, 1)
    assert.equal(only.items.find((s) => s.sessionId === 's3').archived, true)
    assert.equal(only.items.find((s) => s.sessionId === 's4').parentKey, 'zcode:s3')

    const all = await getSessions({ dbFile: file, now: NOW, limit: 10, archived: 'all' })
    assert.deepEqual(all.items.map((s) => s.sessionId).sort(), ['s1', 's2', 's3', 's4'])
    assert.equal(all.total, 2)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 子会话 time_archived 为空但父已归档时随父排除/显示', { skip: !sqlite }, async () => {
  const { dir, file } = makeDb({ archived: true, archivedChildUnmarked: true })
  try {
    _resetZcodeSessions()
    const exclude = await getSessions({ dbFile: file, now: NOW, limit: 10 })
    assert.deepEqual(exclude.items.map((s) => s.sessionId).sort(), ['s1', 's2'], '不能把归档父的子会话提升成活跃根')
    assert.equal(exclude.total, 1)

    const only = await getSessions({ dbFile: file, now: NOW, limit: 10, archived: 'only' })
    assert.deepEqual(only.items.map((s) => s.sessionId).sort(), ['s3', 's4', 's5'], '子会话随父进入归档视图')
    assert.equal(only.total, 1)
    assert.equal(only.items.find((s) => s.sessionId === 's5').archived, false)

    const keys = getArchivedKeys({ dbFile: file })
    assert.equal(keys.supported, true)
    assert.deepEqual(keys.keys.sort(), ['zcode:s3', 'zcode:s4', 'zcode:s5'], '父链归档的子会话也要返回')
    const activeKeys = (await getSessions({ dbFile: file, now: NOW, limit: 10 })).keys
    assert.deepEqual(activeKeys.sort(), ['zcode:s1', 'zcode:s2'], 'getSessions 返回过滤后的全部 key')
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 根会话分页，子会话不占 limit/total/cursor', { skip: !sqlite }, async () => {
  const { dir, file } = makePagingDb({ roots: 12, childrenPerRoot: 2 })
  try {
    _resetZcodeSessions()
    const first = await getSessions({ dbFile: file, now: NOW, limit: 5 })
    const firstRoots = first.items.filter((s) => !s.parentKey)
    assert.equal(firstRoots.length, 5)
    assert.equal(first.items.length, 5 + 5 * 2)
    assert.equal(first.total, 12)
    assert.equal(first.shownRoots, 5)
    assert.ok(first.nextCursor)

    const second = await getSessions({ dbFile: file, now: NOW, limit: 5, cursor: first.nextCursor })
    const secondRoots = second.items.filter((s) => !s.parentKey)
    assert.equal(secondRoots.length, 5)
    assert.equal(second.total, 12)
    const overlap = secondRoots.filter((s) => firstRoots.some((x) => x.key === s.key))
    assert.equal(overlap.length, 0, '第二页不能重复第一页的根')

    const third = await getSessions({ dbFile: file, now: NOW, limit: 5, cursor: second.nextCursor })
    assert.equal(third.items.filter((s) => !s.parentKey).length, 2)
    assert.equal(third.nextCursor, null)

    const all = await pageAll(file, 5)
    assert.equal(all.roots.length, 12)
    assert.equal(new Set(all.roots.map((s) => s.key)).size, 12)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 相同 updatedAt 下分页不跳条、不重复（全序游标）', { skip: !sqlite }, async () => {
  const { dir, file } = makePagingDb({ roots: 9, childrenPerRoot: 1, sameUpdatedAt: true })
  try {
    _resetZcodeSessions()
    const all = await pageAll(file, 2)
    assert.equal(all.roots.length, 9)
    assert.equal(new Set(all.roots.map((s) => s.key)).size, 9)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: status/q 只过滤根会话，子会话仍随父返回', { skip: !sqlite }, async () => {
  const { dir, file } = makePagingDb({ roots: 2, childrenPerRoot: 1 })
  try {
    _resetZcodeSessions()
    const db = new sqlite.DatabaseSync(file, { timeout: 5000 })
    db.prepare(`UPDATE session SET title = 'alpha 根' WHERE id = 'r0'`).run()
    db.prepare(`UPDATE session SET title = 'beta 根' WHERE id = 'r1'`).run()
    db.prepare(`UPDATE session SET title = '子会话不参与搜索' WHERE id = 'r0c0'`).run()
    db.prepare(`INSERT INTO turn_usage VALUES ('r0', 't0', 'running', ?, NULL, NULL)`).run(NOW - 1000)
    db.close()
    _resetZcodeSessions()

    const q = await getSessions({ dbFile: file, now: NOW, limit: 10, q: 'alpha' })
    assert.deepEqual(q.items.map((s) => s.sessionId).sort(), ['r0', 'r0c0'])
    assert.equal(q.total, 1)

    const working = await getSessions({ dbFile: file, now: NOW, limit: 10, status: 'working' })
    assert.deepEqual(working.items.map((s) => s.sessionId).sort(), ['r0', 'r0c0'])
    assert.equal(working.total, 1)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

// ---------- D054 计费审计：换模型分段 / 预付池归零 / 峰谷分档 ----------

function expectedCost(rows) {
  let sum = 0
  for (const r of rows) {
    sum += costOfUsage(
      r.model,
      {
        input_tokens: r.input || 0,
        output_tokens: r.output || 0,
        reasoning_tokens: r.reasoning || 0,
        cache_read_input_tokens: r.cacheRead || 0,
        cache_creation_input_tokens: r.cacheWrite || 0,
        computed_total_tokens: r.total || 0,
      },
      r.at,
      r.provider
    ).amount
  }
  return Math.round(sum * 10000) / 10000
}

const BASE_ROWS = [
  { model: 'deepseek-flash', provider: 'deepseek', at: NOW - 60_000, input: 1000, output: 200, total: 1200 },
  { model: 'deepseek-flash', provider: 'deepseek', at: NOW - 50_000, input: 500, output: 100, total: 600 },
]

test('zcode-sessions: 中途换模型按各自模型计价（不把旧 token 乘新价）', { skip: !sqlite }, async () => {
  const glm = { model: 'GLM-5.3', provider: 'bigmodel-api', at: NOW - 3600_000, input: 4000, output: 900, total: 4900 }
  const { dir, file } = makeDb({ extraRows: [glm] })
  try {
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: NOW, limit: 10 })
    const s1 = r.items.find((x) => x.sessionId === 's1')
    const want = Math.round((expectedCost(BASE_ROWS) + expectedCost([glm])) * 10000) / 10000
    assert.equal(s1.cost.amount, want)
    assert.equal(s1.tokens.total, 1800 + 4900)
    assert.equal(s1.costMarket, null, '没有预付池行时不输出等价市值')
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 套餐/预付池 token 照算、金额记 0（GLM start plan / CommandCode）', { skip: !sqlite }, async () => {
  const prepaidRows = [
    // GLM start plan（订阅配额）与 CommandCode（credit 池）：两笔都不该进金额
    { model: 'GLM-5.3', provider: 'account:zai-start-plan', at: NOW - 30_000, input: 2_000_000, output: 500_000, total: 2_500_000 },
    { model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode', at: NOW - 20_000, input: 1_000_000, output: 200_000, total: 1_200_000 },
  ]
  const { dir, file } = makeDb({ extraRows: prepaidRows })
  try {
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: NOW, limit: 10 })
    const s1 = r.items.find((x) => x.sessionId === 's1')
    // 金额只剩两笔官方 DeepSeek 调用（与「今日已用」同口径）
    assert.equal(s1.cost.amount, expectedCost(BASE_ROWS), '预付池金额必须为 0，不抬高会话成本')
    assert.equal(s1.tokens.total, 1800 + 3_700_000, 'tokens 照算')
    // 等价市值：全部 token 按价目折算，仅用于成本列的 «≈» 展示
    const market = Math.round((expectedCost(BASE_ROWS) + expectedCost(prepaidRows)) * 10000) / 10000
    assert.equal(s1.costMarket.amount, market)
    assert.equal(s1.costMarket.currency, s1.cost.currency)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 峰谷分档按每笔发生时间，而非会话最后一次调用', { skip: !sqlite }, async () => {
  const day = new Date(2026, 9, 21) // 周三
  const valleyAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 2, 0, 0).getTime()
  const peakAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10, 0, 0).getTime()
  const volatile = { model: 'deepseek-flash', provider: 'deepseek', input: 3000, output: 600, total: 3600 }
  const rows = [{ ...volatile, at: valleyAt }, { ...volatile, at: peakAt }]
  // 两笔的档位必须真的不同，否则这个用例没有区分力
  assert.notEqual(
    costOfUsage('deepseek-flash', { input_tokens: 3000, output_tokens: 600, computed_total_tokens: 3600 }, valleyAt, 'deepseek').amount,
    costOfUsage('deepseek-flash', { input_tokens: 3000, output_tokens: 600, computed_total_tokens: 3600 }, peakAt, 'deepseek').amount
  )
  const { dir, file } = makeDb({ extraRows: rows })
  try {
    _resetZcodeSessions()
    const r = await getSessions({ dbFile: file, now: NOW, limit: 10 })
    const s1 = r.items.find((x) => x.sessionId === 's1')
    const want = Math.round((expectedCost(BASE_ROWS) + expectedCost(rows)) * 10000) / 10000
    assert.equal(s1.cost.amount, want)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 回合明细的混合模型（主模型 + 换模型）分段计价', { skip: !sqlite }, async () => {
  const rows = [
    // 同一回合 t1：deepseek 与 GLM 按量各一笔
    { model: 'deepseek-flash', provider: 'deepseek', turn: 't1', at: NOW - 45_000, input: 800, output: 160, total: 960 },
    { model: 'GLM-5.3', provider: 'bigmodel-api', turn: 't1', at: NOW - 44_000, input: 2000, output: 400, total: 2400 },
  ]
  const { dir, file } = makeDb({ extraRows: rows })
  try {
    _resetZcodeSessions()
    const d = await getSessionDetail('s1', { dbFile: file, now: NOW })
    const turn = d.turns.find((t) => t.id === 't1')
    const want = Math.round((expectedCost(BASE_ROWS) + expectedCost(rows)) * 10000) / 10000
    assert.equal(turn.cost.amount, want)
    assert.equal(turn.tokens, 1800 + 960 + 2400)
    // 详情里的模型列表并回「模型 + provider」，不能被整点桶拆成多行
    assert.equal(d.models.length, 2)
    assert.deepEqual(d.models.map((m) => m.modelId).sort(), ['GLM-5.3', 'deepseek-flash'])
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

// ---------- 审查修复：逐日多币种 / 用量明细预付口径 / 未收录模型不补 0 ----------

// makeDb() 固定插入的三笔 DeepSeek 用量（s1 两笔 + s2 一笔），同一本地日。
const DEFAULT_DB_ROWS = [
  { model: 'deepseek-flash', provider: 'deepseek', at: NOW - 60_000, input: 1000, output: 200, total: 1200 },
  { model: 'deepseek-flash', provider: 'deepseek', at: NOW - 50_000, input: 500, output: 100, total: 600 },
  { model: 'deepseek-flash', provider: 'deepseek', at: NOW - 40_000, input: 300, output: 50, total: 350 },
]

test('zcode-sessions: byDay 金额按真实币种分桶，daily 不把 USD 当成 CNY', { skip: !sqlite }, async () => {
  // 同一天同一 agent 既有 CNY（DeepSeek）又有 USD（Anthropic）：此前 agent 的
  // byDay.amount 直接混加，usage-breakdown 又把混合值整体记到主币种 CNY。
  const usdRow = { model: 'claude-sonnet-4-5', provider: 'anthropic', at: NOW - 20_000, input: 1000, output: 200, total: 1200 }
  const { dir, file } = makeDb({ extraRows: [usdRow] })
  try {
    _resetZcodeSessions()
    const agg = await aggregateUsage({ dbFile: file, now: NOW, by: 'agent', since: NOW - 86400000, until: NOW })
    const series = agg.series[0]
    const byDay = series.byDay[0]
    const wantCny = expectedCost(DEFAULT_DB_ROWS)
    const wantUsd = expectedCost([usdRow])
    assert.ok(wantUsd > 0, 'USD 行必须真的计价（否则用例没有区分力）')
    assert.ok(Math.abs(byDay.byCurrency.CNY - wantCny) < 0.0002, JSON.stringify(byDay.byCurrency))
    assert.ok(Math.abs(byDay.byCurrency.USD - wantUsd) < 0.0002, 'USD 分桶不能并入 CNY')
    assert.ok(Math.abs(byDay.amount - wantCny) < 0.0002, 'byDay.amount 归一到 series 主币种')

    // 走真实链路（适配器 aggregateUsage → usage-breakdown）：daily 是总览 7 天图的数据源。
    const adapter = {
      id: 'zcode',
      name: 'ZCode',
      capabilities: { billing: true },
      aggregateUsage: (opts = {}) => aggregateUsage({ ...opts, dbFile: file }),
    }
    const b = createUsageBreakdown({ adapters: [adapter], now: () => NOW })
    const r = await b.get({ by: 'agent', range: '7d' })
    assert.equal(r.total.byCurrency.CNY > 0, true)
    assert.ok(Math.abs(r.total.byCurrency.CNY - wantCny) < 0.0002, JSON.stringify(r.total.byCurrency))
    assert.ok(Math.abs(r.total.byCurrency.USD - wantUsd) < 0.0002, 'USD 总量不能算进 CNY')
    const day = r.daily[0]
    assert.ok(Math.abs(day.byCurrency.CNY - wantCny) < 0.0002, JSON.stringify(day.byCurrency))
    assert.ok(Math.abs(day.byCurrency.USD - wantUsd) < 0.0002, 'daily.byCurrency 必须按真实币种分桶')
    assert.ok(Math.abs(day.amount - wantCny) < 0.0002, 'daily.amount 不混加 USD')
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 用量明细对预付池行金额记 0（与会话/回合/聚合同判据）', { skip: !sqlite }, async () => {
  const prepaid = { model: 'deepseek/deepseek-v4.1-flash', provider: 'commandcode', at: NOW - 30_000, input: 1_000_000, output: 200_000, total: 1_200_000 }
  const { dir, file } = makeDb({ extraRows: [prepaid] })
  try {
    _resetZcodeSessions()
    const rows = await readUsageRows({ dbFile: file, now: NOW, since: NOW - 86400000, until: NOW })
    const prepaidRow = rows.rows.find((r) => r.model === prepaid.model)
    assert.ok(prepaidRow, '预付池行仍要出现在明细里（tokens 照算）')
    assert.equal(prepaidRow.amount, 0, '预付池行金额必须记 0，不能按价目表算真金白银')
    assert.ok(prepaidRow.tokens > 0)
    const priced = rows.rows.find((r) => r.model === 'deepseek-flash')
    assert.ok(priced && priced.amount > 0, '按量计费行金额照常')
    // 与 aggregateUsage 同口径（同一份数据里预付模型金额为 0）
    const agg = await aggregateUsage({ dbFile: file, now: NOW, by: 'model', since: NOW - 86400000, until: NOW })
    const modelSeries = agg.series.find((s) => s.key === prepaid.model)
    assert.equal(modelSeries.amount, 0)
    assert.equal(modelSeries.byCurrency.CNY, 0)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('zcode-sessions: 价目表未收录的模型金额 null + unavailable（不编 0）', { skip: !sqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zunpriced-'))
  const file = path.join(dir, 'db.sqlite')
  const db = new sqlite.DatabaseSync(file, { timeout: 5000 })
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER);
    CREATE TABLE model_usage (
      session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
      started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
      computed_total_tokens INTEGER
    );
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER);
    CREATE TABLE tool_usage (session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);
  `)
  db.prepare(`INSERT INTO session VALUES ('u1', NULL, '仅未收录模型', ?, ?, NULL, NULL)`).run(NOW - 60_000, NOW - 1000)
  db.prepare(`INSERT INTO session VALUES ('u2', NULL, '混合模型', ?, ?, NULL, NULL)`).run(NOW - 60_000, NOW - 1000)
  const ins = db.prepare(`INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  ins.run('u1', 't1', 'openai', 'gpt-5', 'completed', NOW - 30_000, NOW - 29_000, 1000, 200, 0, 0, 0, 1200)
  ins.run('u2', 't2', 'openai', 'gpt-5', 'completed', NOW - 30_000, NOW - 29_000, 1000, 200, 0, 0, 0, 1200)
  ins.run('u2', 't2', 'deepseek', 'deepseek-flash', 'completed', NOW - 20_000, NOW - 19_000, 1000, 200, 0, 0, 0, 1200)
  db.close()
  try {
    _resetZcodeSessions()
    // costOfUsage 对未收录模型返回 billable:false + rates:null（不是免费，而是算不出来）
    const gpt = costOfUsage('gpt-5', { input_tokens: 1000, output_tokens: 200, computed_total_tokens: 1200 }, NOW - 30_000, 'openai')
    assert.equal(gpt.rates, null)
    assert.equal(gpt.billable, false)

    const r = await getSessions({ dbFile: file, now: NOW, limit: 10 })
    const u1 = r.items.find((x) => x.sessionId === 'u1')
    assert.equal(u1.tokens.total, 1200, 'tokens 照算')
    assert.equal(u1.cost, null, '金额不可得就是 null，不能显示 ¥0.00')
    assert.equal(u1.provenance.cost.kind, 'unavailable')
    assert.equal(u1.provenance.cost.origin, 'pricing-table')

    // 混合会话：只累加可计价部分，并在 provenance 说明「部分未收录」
    const u2 = r.items.find((x) => x.sessionId === 'u2')
    const want = costOfUsage('deepseek-flash', { input_tokens: 1000, output_tokens: 200, computed_total_tokens: 1200 }, NOW - 20_000, 'deepseek').amount
    assert.ok(u2.cost && Math.abs(u2.cost.amount - want) < 1e-9, JSON.stringify(u2.cost))
    assert.ok(String(u2.provenance.cost.note || '').includes('未收录'), JSON.stringify(u2.provenance.cost))

    const agg = await aggregateUsage({ dbFile: file, now: NOW, by: 'model', since: NOW - 86400000, until: NOW })
    const gptSeries = agg.series.find((s) => s.key === 'gpt-5')
    assert.equal(gptSeries.amount, null)
    assert.deepEqual(gptSeries.byCurrency, {})
    assert.equal(gptSeries.prov.kind, 'unavailable')
    // 逐日金额也必须是 null（不能补 0），否则用量页/总览会把「不可得」显示成 ¥0.00
    assert.equal(gptSeries.byDay[0].amount, null)
    assert.equal(gptSeries.byDay[0].byCurrency, undefined)

    const rows = await readUsageRows({ dbFile: file, now: NOW, since: NOW - 86400000, until: NOW })
    const gptRow = rows.rows.find((x) => x.model === 'gpt-5')
    assert.equal(gptRow.amount, null)
    assert.equal(gptRow.prov.kind, 'unavailable')
    assert.equal(gptRow.tokens, 1200)
  } finally {
    _resetZcodeSessions()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})
