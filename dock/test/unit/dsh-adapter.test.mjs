// dsh 适配器：多帧 zstd 会话解析、余额、今日/上一轮、无凭据与账本兜底。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { dshAdapter } from '../../adapters/dsh/index.mjs'
import {
  _resetDshSessionCache,
  decodeZstdFrames,
  defaultSessionsDir,
  readDshwLedger,
  scanDshUsage,
} from '../../adapters/dsh/sessions.mjs'
import {
  _resetDeepSeekBalanceCache,
  parseDeepSeekBalance,
  readDeepSeekKey,
} from '../../adapters/dsh/credentials.mjs'
import { resolveAdapter } from '../../adapters/registry.mjs'
import { genericAdapter } from '../../adapters/generic.mjs'
import { normalizeSnapshot } from '../../adapters/contracts.mjs'

function tempHome(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dsh-'))
  if (opts.key !== false) {
    fs.writeFileSync(path.join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: ' + (opts.key || 'sk-test-key') + '\n')
  }
  return dir
}

function cleanup(dir) {
  _resetDshSessionCache()
  _resetDeepSeekBalanceCache()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
}

const FRAME = (obj) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'))

function writeSession(home, id, frames) {
  const dir = path.join(defaultSessionsDir(home), '--C-Users--', 'session-' + id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat(frames))
}

function event(time, turn, step, usage, model = 'deepseek-v4.1-flash-expires-on-0910', provider = 'deepseek-official') {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider, model } },
      usage,
    },
  }
}

function localMs(h, m = 0) {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

function balanceResponse(amount = 12.34, currency = 'CNY') {
  return new Response(
    JSON.stringify({
      is_available: true,
      balance_infos: [
        { currency, total_balance: String(amount), granted_balance: '1.00', topped_up_balance: String(amount - 1) },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

test('dsh: 多帧 zstd 全部解出来（Node 单帧解码会漏）', () => {
  const a = FRAME({ type: 'a', n: 1 })
  const b = FRAME({ type: 'b', n: 2 })
  const d = decodeZstdFrames(Buffer.concat([a, b]))
  assert.equal(d.ok, true)
  const lines = d.text.trim().split('\n').map((x) => JSON.parse(x))
  assert.deepEqual(lines.map((x) => x.type), ['a', 'b'])
  assert.ok(d.frames >= 2)
})

test('dsh: 坏帧被跳过，不影响后续帧', () => {
  const good = FRAME({ type: 'a', n: 1 })
  const bad = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff, 0xff])
  const good2 = FRAME({ type: 'b', n: 2 })
  const d = decodeZstdFrames(Buffer.concat([bad, good, good2]))
  assert.equal(d.ok, true)
  const types = d.text.trim().split('\n').map((x) => JSON.parse(x).type)
  assert.deepEqual(types, ['a', 'b'])
})

test('dsh: 今日按调用求和，上一轮按 turn 归并', () => {
  const home = tempHome()
  try {
    writeSession(home, 'a', [
      FRAME({ type: 'session', version: 3 }),
      FRAME(event(localMs(10, 0), 1, 1, { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadTokens: 0 })),
      FRAME(event(localMs(10, 1), 1, 2, { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, cacheReadTokens: 0 })),
      FRAME(event(localMs(11, 0), 2, 1, { inputTokens: 3000, outputTokens: 1500, totalTokens: 4500, cacheReadTokens: 0 })),
    ])
    const r = scanDshUsage({ home, now: () => localMs(12) })
    assert.equal(r.ok, true)
    assert.equal(r.today.calls, 3)
    assert.equal(r.today.tokens, 9000)
    assert.ok(r.today.amount > 0, JSON.stringify(r.today))
    assert.equal(r.lastTurn.turn, 2)
    assert.equal(r.lastTurn.calls, 1)
    assert.equal(r.lastTurn.tokens, 4500)
  } finally {
    cleanup(home)
  }
})

test('dsh: 缓存命中 + 坏行跳过', () => {
  const home = tempHome()
  try {
    const dir = path.join(defaultSessionsDir(home), 'w', 'session-x')
    fs.mkdirSync(dir, { recursive: true })
    const good = FRAME(event(localMs(9), 1, 1, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }))
    const broken = zlib.zstdCompressSync(Buffer.from('{"type":"assistant/message", broken\n'))
    fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([good, broken]))
    const r1 = scanDshUsage({ home, now: () => localMs(12) })
    const r2 = scanDshUsage({ home, now: () => localMs(12) })
    assert.equal(r1.today.calls, 1)
    assert.equal(r2.today.calls, 1)
  } finally {
    cleanup(home)
  }
})

test('dsh: DeepSeek 余额解析优先 CNY，字段齐全', () => {
  const parsed = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '1.50' },
      { currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' },
    ],
  })
  assert.equal(parsed.amount, 12.34)
  assert.equal(parsed.currency, 'CNY')
  assert.equal(parsed.granted, 2)
  assert.equal(parsed.toppedUp, 10.34)
  assert.equal(parsed.available, true)
})

test('dsh: 从 .credentials.yaml 读 key，env 优先', () => {
  const home = tempHome({ key: 'sk-file' })
  try {
    const r = readDeepSeekKey({ home, env: {} })
    assert.equal(r.key, 'sk-file')
    assert.match(r.source, /credentials\.yaml/)
    const e = readDeepSeekKey({ home, env: { DEEPSEEK_API_KEY: 'sk-env' } })
    assert.equal(e.key, 'sk-env')
    assert.match(e.source, /env/)
  } finally {
    cleanup(home)
  }
})

test('dsh: 适配器 → 余额卡 + 今日金额 + tokens', async () => {
  const home = tempHome()
  try {
    writeSession(home, 'b', [
      FRAME(event(localMs(10, 0), 1, 1, { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 })),
      FRAME(event(localMs(11, 0), 2, 1, { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 })),
    ])
    const raw = await dshAdapter
      .createBilling({ now: () => localMs(12), dshHome: home, fetchImpl: async () => balanceResponse(12.34) })
      .snapshot({})
    const snap = normalizeSnapshot(raw, { adapterId: 'dsh', adapterName: 'DeepSeek Harness' })
    assert.equal(snap.ok, true)
    assert.equal(snap.unit, 'money')
    assert.equal(snap.balance.amount, 12.34)
    assert.equal(snap.balance.currency, 'CNY')
    assert.equal(snap.quotaCard.kind, 'balance')
    assert.equal(snap.today.amount > 0, true)
    assert.equal(snap.usage.todayTokens, 4500)
    assert.equal(snap.usage.turnTokens, 3000)
    assert.ok(snap.details.some((d) => d.label === '余额来源'))
  } finally {
    cleanup(home)
  }
})

test('dsh: 没有 key → 仍显示今日用量，余额卡降级为 plan 说明', async () => {
  const home = tempHome({ key: false })
  try {
    writeSession(home, 'c', [FRAME(event(localMs(10, 0), 1, 1, { inputTokens: 100, outputTokens: 50, totalTokens: 150 }))])
    const raw = await dshAdapter.createBilling({ now: () => localMs(12), dshHome: home, fetchImpl: async () => balanceResponse() }).snapshot({})
    const snap = normalizeSnapshot(raw, { adapterId: 'dsh', adapterName: 'DeepSeek Harness' })
    assert.equal(snap.ok, true)
    assert.equal(snap.balance, null)
    assert.equal(snap.quotaCard.kind, 'plan')
    assert.match(snap.quotaCard.note, /凭据|余额/)
    assert.equal(snap.today.amount >= 0, true)
  } finally {
    cleanup(home)
  }
})

test('dsh: 会话目录为空时用 .dshw-usage.json 的今日金额兜底', async () => {
  const home = tempHome()
  try {
    const today = new Date()
    const key = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
    fs.writeFileSync(
      path.join(home, '.dshw-usage.json'),
      JSON.stringify({ date: key, todayUsage: 2.5, history: { [key]: 2.5 }, lastBalance: 9.9, lastCurrency: 'CNY' })
    )
    const ledger = readDshwLedger(home, today.getTime())
    assert.equal(ledger.amount, 2.5)
    const r = scanDshUsage({ home, now: () => today.getTime() })
    assert.equal(r.ok, false)
    const raw = await dshAdapter
      .createBilling({ now: () => today.getTime(), dshHome: home, fetchImpl: async () => balanceResponse(9.9) })
      .snapshot({})
    const snap = normalizeSnapshot(raw, { adapterId: 'dsh', adapterName: 'DeepSeek Harness' })
    assert.equal(snap.ok, true)
    assert.equal(snap.today.amount, 2.5)
    assert.equal(snap.source.includes('.dshw-usage.json'), true)
  } finally {
    cleanup(home)
  }
})

test('dsh: 上一轮优先主会话，不被更晚的 subagent 抢走', () => {
  const home = tempHome()
  try {
    // 主会话：turns 1/2
    writeSession(home, 'main', [
      FRAME({ type: 'session', version: 3, id: 'main', delegationDepth: 0 }),
      FRAME(event(localMs(10, 0), 1, 1, { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 })),
      FRAME(event(localMs(10, 30), 2, 1, { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 })),
    ])
    // 子 agent：时间更晚，turn 号从 1 开始
    writeSession(home, 'sub', [
      FRAME({ type: 'session', version: 3, id: 'sub', delegationDepth: 1, origin: 'subagent' }),
      FRAME(event(localMs(11, 0), 1, 1, { inputTokens: 9000, outputTokens: 4000, totalTokens: 13000 }, 'claude-sonnet-5-5', 'anthropic')),
    ])
    const r = scanDshUsage({ home, now: () => localMs(12) })
    assert.equal(r.ok, true)
    assert.equal(r.today.calls, 3, '今日总额仍包含 subagent')
    assert.equal(r.lastTurn.model, 'deepseek-v4.1-flash-expires-on-0910')
    assert.equal(r.lastTurn.turn, 2)
    assert.equal(r.lastTurn.calls, 1)
  } finally {
    cleanup(home)
  }
})

test('dsh: 旧账本没有今天条目时 hasToday=false，不冒充今日用量', () => {
  const home = tempHome()
  try {
    fs.writeFileSync(
      path.join(home, '.dshw-usage.json'),
      JSON.stringify({ date: '2000-01-01', todayUsage: 9.9, history: { '2000-01-01': 9.9 }, lastBalance: 8.8, lastCurrency: 'CNY' })
    )
    const ledger = readDshwLedger(home, Date.now())
    assert.equal(ledger.hasToday, false)
    assert.equal(ledger.amount, 0)
    assert.equal(ledger.lastBalance, 8.8)
  } finally {
    cleanup(home)
  }
})

test('dsh: 窗口识别只认 DeepSeek Harness.exe', () => {
  const hit = resolveAdapter(
    { exe: 'E:\\DSH-Windows\\DeepSeek Harness.exe', title: 'DeepSeek Harness' },
    [genericAdapter, dshAdapter]
  )
  assert.equal(hit.id, 'dsh')
  const miss = resolveAdapter({ exe: 'C:\\Apps\\electron.exe', title: 'DeepSeek Harness' }, [genericAdapter, dshAdapter])
  assert.equal(miss.id, 'generic')
})
