import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MAX_POINTS, createContextHistory } from '../../daemon/src/context-history.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ctx-hist-'))
const file = path.join(dir, 'context-history.json')

after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

test('history: 同一 used 不重复采点，变化才追加；落盘后可重新读回', () => {
  let nowMs = 1000
  const h = createContextHistory({ file, now: () => nowMs })
  h.record('zcode', { supported: true, sessionId: 's1', used: 100 })
  nowMs += 1000
  h.record('zcode', { supported: true, sessionId: 's1', used: 100 })
  nowMs += 1000
  h.record('zcode', { supported: true, sessionId: 's1', used: 200 })
  assert.deepEqual(h.get('zcode', 's1').map((p) => p.used), [100, 200])
  h.flush()

  const h2 = createContextHistory({ file, now: () => nowMs })
  assert.deepEqual(h2.get('zcode', 's1').map((p) => p.used), [100, 200])
})

test('history: used 不变但间隔 ≥30s 也会补一点（长会话趋势）', () => {
  let nowMs = 10_000
  const h = createContextHistory({ file: path.join(dir, 'gap.json'), now: () => nowMs })
  h.record('kimi', { supported: true, sessionId: 'k', used: 50 })
  nowMs += 31_000
  h.record('kimi', { supported: true, sessionId: 'k', used: 50 })
  assert.equal(h.get('kimi', 'k').length, 2)
})

test('history: 宿主历史回填并按时间去重，保留 ≤240 点', () => {
  const h = createContextHistory({ file: path.join(dir, 'points.json'), now: () => 999_999 })
  const points = Array.from({ length: 300 }, (_, i) => ({ t: i * 1000, used: i }))
  h.record('dsh', { supported: true, sessionId: 's', used: 299, points })
  const got = h.get('dsh', 's')
  assert.equal(got.length, MAX_POINTS)
  assert.equal(got[got.length - 1].used, 299)
  assert.ok(got.every((p, i) => i === 0 || p.t > got[i - 1].t))
})

test('history: 不支持的快照不写（不留假 0）', () => {
  const h = createContextHistory({ file: path.join(dir, 'no.json'), now: () => 1 })
  assert.equal(h.record('kimi', { supported: false, reason: 'no-session' }), null)
  assert.deepEqual(h.get('kimi', ''), [])
})

test('history: 超过 24h 的会话在落盘时被清掉，文件受体积上限约束', () => {
  let nowMs = 0
  const h = createContextHistory({ file: path.join(dir, 'prune.json'), now: () => nowMs })
  h.record('zcode', { supported: true, sessionId: 'old', used: 1 })
  nowMs = 25 * 3600_000
  h.record('zcode', { supported: true, sessionId: 'new', used: 2 })
  h.flush()
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'prune.json'), 'utf8'))
  assert.equal('zcode|old' in raw.sessions, false)
  assert.equal('zcode|new' in raw.sessions, true)
  assert.ok(fs.statSync(path.join(dir, 'prune.json')).size < 2 * 1024 * 1024)
})
