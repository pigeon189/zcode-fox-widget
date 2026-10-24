// D033 契约层强制对账：每个数值字段都有 provenance；缺失不补 0
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeContext, normalizeSnapshot, validateAdapter } from '../../adapters/contracts.mjs'
import { builtinAdapters } from '../../adapters/registry.mjs'
import { buildStats, emptyStats } from '../../adapters/stats.mjs'
import { PRICING_SNAPSHOT_DATE, withCostProv } from '../../daemon/src/cost-prov.mjs'
import { costOfUsage } from '../../engines/pricing.mjs'

const KEYS = ['today', 'turn', 'balance', 'quota', 'usage']

test('provenance-adapters: 四个内置适配器都能通过契约软校验（含 sessions 能力）', () => {
  for (const a of builtinAdapters) {
    const errors = validateAdapter(a)
    assert.deepEqual(errors, [], a.id + ': ' + errors.join(', '))
  }
})

test('provenance-adapters: 未声明来源 → 有值 estimated/unknown，缺值 unavailable', () => {
  const s = normalizeSnapshot(
    {
      supported: true,
      unit: 'money',
      today: { amount: 1, currency: 'CNY' },
      balance: { amount: 2, currency: 'CNY' },
      usage: { todayTokens: 10 },
    },
    { adapterId: 'zcode', adapterName: 'ZCode', now: 123 }
  )
  for (const k of KEYS) assert.ok(s.provenance[k], 'missing provenance.' + k)
  assert.equal(s.provenance.today.kind, 'estimated')
  assert.equal(s.provenance.today.origin, 'unknown')
  assert.equal(s.provenance.turn.kind, 'unavailable')
  assert.equal(s.provenance.turn.reason, 'no-data')
  assert.equal(s.provenance.balance.kind, 'estimated')
  assert.equal(s.provenance.quota.kind, 'unavailable')
  assert.equal(s.provenance.usage.kind, 'estimated')
})

test('provenance-adapters: 缺 usage 时 token 是 null + unavailable（不是 0）', () => {
  const s = normalizeSnapshot({ supported: true, unit: 'money' }, { adapterId: 'generic', now: 1 })
  assert.equal(s.usage.todayTokens, null)
  assert.equal(s.usage.turnTokens, null)
  assert.equal(s.provenance.usage.kind, 'unavailable')
})

test('provenance-adapters: 适配器显式声明优先，unavailable 必须带 reason', () => {
  const s = normalizeSnapshot(
    {
      supported: true,
      unit: 'money',
      today: { amount: 1, currency: 'CNY' },
      provenance: {
        today: { kind: 'exact', origin: 'api', source: 'vendor:x', asOf: 5 },
        balance: { kind: 'unavailable', origin: 'api', source: 'vendor:x' },
      },
    },
    { adapterId: 'kimi', now: 1 }
  )
  assert.equal(s.provenance.today.kind, 'exact')
  assert.equal(s.provenance.today.source, 'vendor:x')
  assert.equal(s.provenance.balance.reason, 'no-data')
})

test('provenance-adapters: 随机删字段属性测试（1000 次）永不出现 0 冒充缺失/NaN', () => {
  let seed = 3
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const fields = ['today', 'turn', 'balance', 'quota', 'usage']
  for (let i = 0; i < 1000; i++) {
    const raw = { supported: true, unit: 'money' }
    for (const f of fields) if (rand() < 0.5) raw[f] = f === 'usage' ? { todayTokens: 10, turnTokens: 2 } : f === 'quota' ? { usedPct: 10 } : { amount: 1, currency: 'CNY' }
    const s = normalizeSnapshot(raw, { adapterId: 'zcode', now: 99 })
    for (const k of fields) {
      const has = raw[k] != null
      if (!has) {
        assert.equal(s.provenance[k].kind, 'unavailable', k + ' should be unavailable')
        if (k === 'usage') assert.equal(s.usage.todayTokens, null)
      } else {
        assert.notEqual(s.provenance[k].kind, 'unavailable', k + ' should have a usable provenance')
      }
    }
    assert.ok(!Number.isNaN(Number(s.today && s.today.amount)))
  }
})

test('provenance-adapters: 上下文 used/limit 分别标注（host/config/builtin-table）', () => {
  const host = normalizeContext(
    { supported: true, confidence: 'exact', used: 10, limit: 100, limitSource: 'host' },
    { adapterId: 'zcode', now: 1 }
  )
  assert.equal(host.provenance.used.kind, 'exact')
  assert.equal(host.provenance.used.origin, 'local-db')
  assert.equal(host.provenance.limit.kind, 'exact')
  assert.equal(host.provenance.limit.origin, 'local-db')
  const derived = normalizeContext(
    { supported: true, confidence: 'derived', used: 10, limit: 100, limitSource: 'builtin-table' },
    { adapterId: 'kimi', now: 1 }
  )
  assert.equal(derived.provenance.used.kind, 'estimated')
  assert.equal(derived.provenance.limit.kind, 'estimated')
  assert.equal(derived.provenance.limit.origin, 'unknown')
  assert.match(derived.provenance.limit.note, /内置窗口表/)
  const config = normalizeContext(
    { supported: true, confidence: 'exact', used: 1, limit: 2, limitSource: 'config' },
    { adapterId: 'kimi', now: 1 }
  )
  assert.equal(config.provenance.limit.origin, 'user')
  const missing = normalizeContext({ supported: false, reason: 'auth' }, { adapterId: 'kimi', now: 1 })
  assert.equal(missing.provenance.used.kind, 'unavailable')
  assert.equal(missing.provenance.used.reason, 'host-unsupported')
})

test('provenance-adapters: buildStats 每个维度都有 provenance；cost 是 estimated/pricing-table', () => {
  const stats = buildStats({
    now: 1000,
    source: 'zcode:db.sqlite',
    totals: { totalTokens: 10 },
    turns: { totalTurns: 1 },
    tools: { toolCallCount: 1 },
    models: [{ modelId: 'm', totalTokens: 10 }],
    cost: { amount: 1, currency: 'CNY' },
    credits: null,
  })
  for (const k of ['tokens', 'cost', 'credits', 'models', 'tools', 'turns']) assert.ok(stats.provenance[k], k)
  assert.equal(stats.provenance.tokens.origin, 'local-db')
  assert.equal(stats.provenance.cost.kind, 'estimated')
  assert.equal(stats.provenance.cost.origin, 'pricing-table')
  assert.equal(stats.provenance.credits.kind, 'unavailable')
  const empty = emptyStats('7d', 'no-data', { note: 'x' })
  assert.equal(empty.provenance.tokens.kind, 'unavailable')
})

test('provenance-adapters: withCostProv 不修改入参，价目快照日期可审计', () => {
  assert.match(PRICING_SNAPSHOT_DATE, /^\d{4}-\d{2}$/)
  const raw = costOfUsage('deepseek-flash', { input_tokens: 1_000_000, output_tokens: 0, computed_total_tokens: 1_000_000 }, Date.UTC(2026, 9, 19, 4), 'deepseek')
  const before = JSON.stringify(raw)
  const wrapped = withCostProv(raw, { asOf: 1 })
  assert.equal(JSON.stringify(raw), before)
  assert.notEqual(wrapped, raw)
  assert.equal(wrapped.prov.kind, 'estimated')
  assert.equal(wrapped.prov.origin, 'pricing-table')
  assert.match(wrapped.prov.source, /^pricing:\d{4}-\d{2} /)
  assert.match(wrapped.prov.note, new RegExp(PRICING_SNAPSHOT_DATE))
})

// ---------- 四个内置适配器的真实快照必须逐字段带 provenance ----------
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { zcodeAdapter } from '../../adapters/zcode/index.mjs'
import { _resetConnection as resetZcodeStore } from '../../adapters/zcode/store.mjs'
import { workbuddyAdapter } from '../../adapters/workbuddy/index.mjs'
import { _clearCache as resetWbTranscripts } from '../../adapters/workbuddy/transcripts.mjs'
import { dshAdapter } from '../../adapters/dsh/index.mjs'
import { _resetDshSessionCache } from '../../adapters/dsh/sessions.mjs'
import { kimiAdapter } from '../../adapters/kimi/index.mjs'
import { _resetKimiUsageCache } from '../../adapters/kimi/usage.mjs'

const require = createRequire(import.meta.url)
const sqlite = (() => {
  try {
    return require('node:sqlite')
  } catch (err) {
    return null
  }
})()

async function snapshotOf(adapter, ctx = {}, env = {}) {
  const saved = {}
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k]
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  try {
    const raw = await adapter.createBilling({ now: () => Date.now(), ...ctx }).snapshot()
    return normalizeSnapshot(raw, { adapterId: adapter.id, adapterName: adapter.name, now: Date.now() })
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function assertProvShape(snap) {
  for (const k of KEYS) assert.ok(snap.provenance[k], 'missing provenance.' + k)
  for (const k of KEYS) {
    const p = snap.provenance[k]
    assert.ok(['exact', 'estimated', 'unavailable'].includes(p.kind))
    assert.ok(['api', 'local-db', 'local-log', 'pricing-table', 'user', 'unknown'].includes(p.origin))
    if (p.kind === 'unavailable') assert.ok(p.reason)
  }
}

test('provenance-adapters: ZCode 快照（金额估算/用量本地库/余额不可得）', { skip: !sqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-prov-zc-'))
  try {
    const file = path.join(dir, 'db.sqlite')
    const db = new sqlite.DatabaseSync(file)
    db.exec(`CREATE TABLE model_usage (session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, computed_total_tokens INTEGER);
      CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER);
      CREATE TABLE tool_usage (session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);`)
    db.prepare(`INSERT INTO model_usage VALUES ('s','t','deepseek','deepseek-flash','completed',?,1000,200,0,0,0,1200)`).run(Date.now() - 1000)
    db.close()
    resetZcodeStore()
    const s = await snapshotOf(zcodeAdapter, {}, { FOX_DOCK_ZCODE_DB: file, FOX_DOCK_VENDOR_BALANCES: '0' })
    assertProvShape(s)
    assert.equal(s.provenance.today.kind, 'estimated')
    assert.equal(s.provenance.today.origin, 'pricing-table')
    assert.equal(s.provenance.usage.kind, 'exact')
    assert.equal(s.provenance.usage.origin, 'local-db')
    assert.equal(s.provenance.balance.kind, 'unavailable')
    assert.match(s.provenance.today.note || '', /价目/)
  } finally {
    resetZcodeStore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('provenance-adapters: WorkBuddy 快照（积分 exact/local-log，余额不可得）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-prov-wb-'))
  try {
    const sub = path.join(dir, 'p')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(
      path.join(sub, 's.jsonl'),
      JSON.stringify({ sessionId: 'w1', timestamp: Date.now() - 1000, providerData: { conversationRequestId: 'r1', model: 'wb-pro', rawUsage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, credit: 0.5 } } }) + '\n'
    )
    resetWbTranscripts()
    const s = await snapshotOf(workbuddyAdapter, {}, { FOX_DOCK_WORKBUDDY_PROJECTS: dir })
    assertProvShape(s)
    assert.equal(s.provenance.today.kind, 'exact')
    assert.equal(s.provenance.today.origin, 'local-log')
    assert.equal(s.provenance.usage.origin, 'local-log')
    assert.equal(s.provenance.balance.kind, 'unavailable')
    assert.equal(s.unit, 'credit')
  } finally {
    resetWbTranscripts()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('provenance-adapters: dsh 快照（金额估算/日志本地/余额失败不可得）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-prov-dsh-'))
  try {
    const sessions = path.join(dir, 'sessions', 'p')
    fs.mkdirSync(sessions, { recursive: true })
    const events = [
      { type: 'session', id: 'd1', time: Date.now() - 5000 },
      { type: 'assistant/message', time: Date.now() - 4000, data: { turn: 1, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 14, cacheReadTokens: 2 }, message: { source: { model: 'deepseek-v4', provider: 'deepseek' } } } },
    ]
    fs.writeFileSync(path.join(sessions, 'session0.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    _resetDshSessionCache()
    const s = await snapshotOf(dshAdapter, { dshHome: dir, fetchImpl: async () => { throw new Error('offline') } }, { FOX_DOCK_VENDOR_BALANCES: '0' })
    assertProvShape(s)
    assert.equal(s.provenance.today.kind, 'estimated')
    assert.equal(s.provenance.today.origin, 'pricing-table')
    assert.equal(s.provenance.usage.kind, 'exact')
    assert.equal(s.provenance.usage.origin, 'local-log')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('provenance-adapters: Kimi 快照（套餐窗口 exact/api，token 历史不可得）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-prov-kimi-'))
  try {
    const file = path.join(dir, 'credentials.json')
    fs.writeFileSync(file, JSON.stringify({ access_token: 'token', expires_at: Math.floor(Date.now() / 1000) + 3600 }))
    _resetKimiUsageCache()
    const fetchImpl = async (url) => {
      if (String(url).includes('/usages')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ usages: { limit_5h: { used_ratio: 0.2, reset_time: '2026-10-22T12:00:00Z' } } }),
        }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    const s = await snapshotOf(kimiAdapter, { kimiCredentialsFile: file, baseUrl: 'http://127.0.0.1:9', fetchImpl }, {})
    assertProvShape(s)
    assert.equal(s.provenance.quota.kind, 'exact')
    assert.equal(s.provenance.quota.origin, 'api')
    assert.equal(s.provenance.usage.kind, 'unavailable')
    assert.equal(s.provenance.usage.reason, 'host-unsupported')
    assert.equal(s.provenance.today.kind, 'unavailable')
  } finally {
    _resetKimiUsageCache()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
