import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStats, dateKeyOfDay, dayIndexOf, rangeSince } from '../../adapters/stats.mjs'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)
const BASE = dayIndexOf(NOW, 0) - 4

function fixture() {
  const days = [
    { dayIndex: BASE, totalTokens: 100, turnCount: 1, toolCallCount: 2 },
    { dayIndex: BASE + 1, totalTokens: 0, turnCount: 0, toolCallCount: 0 },
    { dayIndex: BASE + 2, totalTokens: 200, turnCount: 2, toolCallCount: 3 },
    { dayIndex: BASE + 3, totalTokens: 300, turnCount: 3, toolCallCount: 4 },
    { dayIndex: BASE + 4, totalTokens: 400, turnCount: 4, toolCallCount: 5 },
  ]
  return {
    range: 'all',
    now: NOW,
    since: 0,
    until: NOW,
    tzOffsetMs: 0,
    source: 'test',
    totals: {
      totalTokens: 1000,
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 600,
      cacheCreationTokens: 100,
      modelRequestCount: 10,
      modelErrorCount: 1,
      avgTimeToFirstTokenMs: 123,
    },
    turns: { totalSessions: 2, totalTurns: 10, avgTurnDurationMs: 5000, longestSessionMs: 60000 },
    tools: { toolCallCount: 20, toolErrorCount: 2 },
    models: [
      { modelId: 'a', totalTokens: 700, inputTokens: 650, outputTokens: 50, requestCount: 7 },
      { modelId: 'b', totalTokens: 300, inputTokens: 250, outputTokens: 50, requestCount: 3 },
    ],
    toolList: [
      { toolName: 'Bash', callCount: 15, errorCount: 1, avgDurationMs: 120 },
      { toolName: 'Read', callCount: 5, errorCount: 1, avgDurationMs: 20 },
    ],
    days,
    dayModels: days.flatMap((d) => [
      { dayIndex: d.dayIndex, modelId: 'a', totalTokens: Math.round(d.totalTokens * 0.7) },
      { dayIndex: d.dayIndex, modelId: 'b', totalTokens: Math.round(d.totalTokens * 0.3) },
    ]),
  }
}

test('stats: 摘要 / 连续天数 / 峰值 / 模型占比', () => {
  const s = buildStats(fixture())
  assert.equal(s.supported, true)
  assert.equal(s.summary.totalTokens, 1000)
  assert.equal(s.summary.activeDays, 4)
  assert.equal(s.summary.currentStreakDays, 3)
  assert.equal(s.summary.longestStreakDays, 3)
  assert.equal(s.summary.peakDayTokens, 400)
  assert.equal(s.summary.peakDayDate, dateKeyOfDay(BASE + 4))
  assert.equal(s.summary.favoriteModel.modelId, 'a')
  assert.ok(Math.abs(s.summary.cacheHitRate - 600 / 900) < 1e-9)
  assert.equal(s.summary.toolErrorRate, 0.1)
  assert.equal(s.summary.modelErrorRate, 0.1)
  assert.equal(s.models[0].share, 0.7)
  assert.equal(s.tools[0].errorRate, 0.0667)
})

test('stats: 热力图按周对齐，日/周/累计都由 UI 从同一份数据派生', () => {
  const s = buildStats(fixture())
  assert.ok(s.heatmap.weeks.length >= 1)
  const cells = s.heatmap.weeks.flatMap((w) => w.days).filter(Boolean)
  assert.equal(cells.length, 5)
  assert.equal(cells[0].date, dateKeyOfDay(BASE))
  assert.equal(cells.at(-1).date, dateKeyOfDay(BASE + 4))
  assert.equal(s.heatmap.maxTokens, 400)
  assert.equal(s.dailyModelUsage.length, 5)
})

test('stats: 当前连续天数从今天倒着数，最近一天为空就归零', () => {
  const input = fixture()
  input.days[4].totalTokens = 0
  const s = buildStats(input)
  assert.equal(s.summary.currentStreakDays, 0)
  assert.equal(s.summary.longestStreakDays, 2)
})

test('stats: rangeSince 与非法 range 回退全部', () => {
  assert.equal(rangeSince('7d', NOW), NOW - 7 * 86400000)
  assert.equal(rangeSince('30d', NOW), NOW - 30 * 86400000)
  assert.equal(rangeSince('all', NOW), 0)
  assert.equal(rangeSince('nope', NOW), 0)
})
