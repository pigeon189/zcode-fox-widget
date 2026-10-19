import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { _resetDshContextCache, listDshSessions, readDshContext } from '../../adapters/dsh/context.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ctx-dsh-'))
const home = path.join(dir, 'dsh')
const sessionsDir = path.join(home, 'sessions', 'proj', 'sess1')
const now = Date.now()

function frame(obj) {
  return zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n'))
}

function writeSession(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat(events.map(frame)))
}

function setup() {
  writeSession(path.join(sessionsDir, 'session.v4.jsonl.zstd'), [
    { type: 'session', id: 'sess1', delegationDepth: 0, title: '主会话', time: now - 8000 },
    { type: 'request/context', time: now - 7000, data: { provider: 'deepseek', model: 'deepseek-v4.1', contextWindow: 1000000 } },
    {
      type: 'assistant/message',
      time: now - 6000,
      data: {
        turn: 1,
        step: 1,
        message: { source: { provider: 'deepseek', model: 'deepseek-v4.1' } },
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          totalTokens: 600,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      },
    },
    { type: 'compaction/start', time: now - 5000, data: {} },
    { type: 'compaction/prune', time: now - 4900, data: { shadowedTokenCount: 188765 } },
    { type: 'compaction/end', time: now - 4800, data: {} },
    {
      type: 'assistant/message',
      time: now - 3000,
      data: {
        turn: 2,
        step: 1,
        message: { source: { provider: 'deepseek', model: 'deepseek-v4.1' } },
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
          cacheReadTokens: 600,
          cacheWriteTokens: 100,
          reasoningTokens: 50,
        },
      },
    },
  ])
  // 子 agent：时间更晚，但 delegationDepth>0，不能冒充当前会话
  writeSession(path.join(home, 'sessions', 'proj', 'child', 'session.v4.jsonl.zstd'), [
    { type: 'session', id: 'child', delegationDepth: 1, origin: 'sess1', time: now },
    {
      type: 'assistant/message',
      time: now,
      data: {
        turn: 1,
        message: { source: { model: 'deepseek-v4.1' } },
        usage: { inputTokens: 9000, outputTokens: 999, totalTokens: 9999 },
      },
    },
  ])
}

setup()

after(() => {
  _resetDshContextCache()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('dsh context: used=totalTokens，选主会话而不是更晚的 subagent', () => {
  _resetDshContextCache()
  const c = readDshContext({ home, sessionsDir: path.join(home, 'sessions'), now })
  assert.equal(c.supported, true)
  assert.equal(c.sessionId, 'sess1')
  assert.equal(c.used, 1200)
  assert.equal(c.limit, 1000000)
  assert.equal(c.limitSource, 'host')
  assert.equal(c.title, '主会话')
})

test('dsh context: 构成拆成「未缓存输入 + 缓存读 + 缓存写 + 输出 + 推理」', () => {
  const c = readDshContext({ home, sessionsDir: path.join(home, 'sessions'), now })
  assert.deepEqual(c.breakdown, { input: 300, cacheRead: 600, cacheWrite: 100, output: 200, reasoning: 50 })
})

test('dsh context: 压缩事件按实测记录，shadowedTokens 累加', () => {
  const c = readDshContext({ home, sessionsDir: path.join(home, 'sessions'), now })
  assert.equal(c.compaction.count, 1)
  assert.equal(c.compaction.shadowedTokens, 188765)
  assert.equal(c.compaction.derived, false)
  assert.equal(c.compaction.lastAt, now - 5000)
})

test('dsh context: 趋势点升序，最多 240 点', () => {
  const c = readDshContext({ home, sessionsDir: path.join(home, 'sessions'), now })
  assert.deepEqual(c.points.map((p) => p.used), [600, 1200])
})

test('dsh context: 没有 request/context 时从 cordis 配置取上限', () => {
  _resetDshContextCache()
  const dir2 = path.join(dir, 'dsh2')
  const file = path.join(dir2, 'sessions', 'p', 's', 'session.v4.jsonl.zstd')
  writeSession(file, [
    { type: 'session', id: 's2', delegationDepth: 0, time: now - 1000 },
    { type: 'assistant/message', time: now, data: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
  ])
  fs.mkdirSync(path.join(dir2, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(dir2, 'profiles', 'desktop', 'cordis.patch.yml'), 'models:\n  - contextWindow: 123456\n')
  const c = readDshContext({ home: dir2, sessionsDir: path.join(dir2, 'sessions'), now })
  assert.equal(c.limit, 123456)
  assert.equal(c.limitSource, 'config')
  assert.equal(c.confidence, 'derived')
})

test('dsh context: 没有会话 → no-data', () => {
  const c = readDshContext({ home: dir, sessionsDir: path.join(dir, 'empty'), now })
  assert.equal(c.supported, false)
  assert.equal(c.reason, 'no-data')
})

test('dsh sessions: 列表只列主会话并带占用', () => {
  _resetDshContextCache()
  const list = listDshSessions({ home, sessionsDir: path.join(home, 'sessions'), now })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'sess1')
  assert.equal(list[0].used, 1200)
  assert.equal(list[0].pct, 0.1)
})
