import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { _resetWorkbuddyStatsCache, readWorkbuddyStats } from '../../adapters/workbuddy/stats.mjs'
import { _resetDshStatsCache, readDshStats } from '../../adapters/dsh/stats.mjs'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('workbuddy stats: transcript 里的每次调用都能进 token/积分/模型/工具', () => {
  const dir = tempDir('fox-wb-stats-')
  const project = path.join(dir, 'projects', 'demo')
  fs.mkdirSync(project, { recursive: true })
  const lines = [
    {
      type: 'function_call',
      timestamp: NOW - 1000,
      sessionId: 's1',
      callId: 'c1',
      name: 'Bash',
      providerData: {
        conversationRequestId: 'r1',
        model: 'deepseek-v4.1-flash',
        rawUsage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          total_tokens: 1100,
          cache_read_input_tokens: 400,
          credit: 0.5,
        },
      },
    },
    { type: 'function_call_result', timestamp: NOW - 500, sessionId: 's1', callId: 'c1', status: 'completed' },
  ]
  fs.writeFileSync(path.join(project, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))
  _resetWorkbuddyStatsCache()
  try {
    const s = readWorkbuddyStats({ projectsDir: path.join(dir, 'projects'), now: NOW, range: 'all', tzOffsetMs: 0 })
    assert.equal(s.supported, true)
    assert.equal(s.summary.totalTokens, 1100)
    assert.equal(s.summary.totalSessions, 1)
    assert.equal(s.summary.totalTurns, 1)
    assert.equal(s.summary.toolCallCount, 1)
    assert.equal(s.credits, 0.5)
    assert.equal(s.models.length, 1)
    assert.equal(s.models[0].modelId, 'deepseek-v4.1-flash')
    assert.equal(s.tools[0].toolName, 'Bash')
    assert.equal(s.tools[0].avgDurationMs, 500)
    assert.equal(s.summary.currentStreakDays, 1)
  } finally {
    _resetWorkbuddyStatsCache()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('dsh stats: 会话日志的 usage / turn / tool 事件聚合', () => {
  const dir = tempDir('fox-dsh-stats-')
  const lines = [
    { type: 'session', id: 's1', time: NOW - 10_000, createdAt: NOW - 10_000 },
    {
      type: 'assistant/message',
      time: NOW - 9000,
      data: {
        turn: 1,
        usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1050 },
        message: { source: { provider: 'deepseek', model: 'deepseek-flash' } },
      },
    },
    { type: 'turn/start', time: NOW - 9050, data: { turn: 1 } },
    { type: 'turn/end', time: NOW - 8000, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'tool/call', time: NOW - 8500, data: { callId: 'c1', name: 'Bash' } },
    { type: 'tool/result', time: NOW - 8400, data: { message: { source: { callId: 'c1' } } } },
  ]
  fs.writeFileSync(path.join(dir, 'session.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))
  _resetDshStatsCache()
  try {
    const s = readDshStats({ sessionsDir: dir, now: NOW, range: 'all', tzOffsetMs: 0 })
    assert.equal(s.supported, true)
    assert.equal(s.summary.totalTokens, 1050)
    assert.equal(s.summary.totalSessions, 1)
    assert.equal(s.summary.totalTurns, 1)
    assert.equal(s.summary.toolCallCount, 1)
    assert.equal(s.summary.longestSessionMs, 1050)
    assert.equal(s.models[0].modelId, 'deepseek-flash')
    assert.equal(s.tools[0].avgDurationMs, 100)
  } finally {
    _resetDshStatsCache()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
