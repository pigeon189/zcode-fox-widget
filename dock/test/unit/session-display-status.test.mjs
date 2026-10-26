// D056：已完成展示窗口（5 分钟）、回合活跃标记与状态合并。
// 覆盖用户可见的三类回归：已完成抓不到、工作中不结束、权限超时被误报成已完成。
import assert from 'node:assert/strict'
import test from 'node:test'

import { DONE_DISPLAY_MS, aggregateOf, displayStatusOf, summarizeSession } from '../../shared/session-model.mjs'
import { LIVE_TIMEOUTS, expire, mergeSnapshot, reduce } from '../../shared/live-reduce.mjs'

const T = 1_790_000_000_000

function seed(over = {}) {
  return {
    key: 'zcode:s1',
    agentId: 'zcode',
    sessionId: 's1',
    title: '会话',
    status: 'idle',
    statusSource: 'db',
    statusSince: T - 1000,
    updatedAt: T - 1000,
    startedAt: T - 60_000,
    endedAt: null,
    doneAt: null,
    turnActive: false,
    workflowBusy: false,
    turns: { count: 0, current: null, avgDurationMs: null },
    tokens: { total: 0 },
    tools: { calls: 0, errors: 0, running: [] },
    errors: { model: 0, tool: 0, last: null },
    pending: [],
    ...over,
  }
}

test('展示状态：doneAt 在 5 分钟内算已完成，超过才回落空闲', () => {
  const s = seed({ status: 'idle', doneAt: T, statusSince: T, updatedAt: T })
  assert.equal(displayStatusOf(s, T + 1_000), 'done')
  assert.equal(displayStatusOf(s, T + 4 * 60_000), 'done', '4 分钟仍应是已完成')
  assert.equal(displayStatusOf(s, T + DONE_DISPLAY_MS - 1), 'done', '窗口内最后一刻仍是已完成')
  assert.equal(displayStatusOf(s, T + DONE_DISPLAY_MS + 1), 'idle', '超过 5 分钟回落空闲')
})

test('展示状态：活跃状态优先于 doneAt / workflowBusy / turnActive', () => {
  for (const status of ['working', 'waiting_permission', 'waiting_input', 'error']) {
    assert.equal(
      displayStatusOf(seed({ status, doneAt: T, workflowBusy: true, turnActive: true }), T + 1000),
      status,
      status + ' 不应被已完成/后台任务覆盖'
    )
  }
})

test('展示状态：workflow 在跑 → 工作中；turnActive → 工作中', () => {
  assert.equal(displayStatusOf(seed({ status: 'idle', workflowBusy: true }), T), 'working')
  assert.equal(displayStatusOf(seed({ status: 'done', workflowBusy: true, doneAt: T }), T), 'working')
  assert.equal(displayStatusOf(seed({ status: 'idle', turnActive: true }), T), 'working')
  // 没有 doneAt 的普通空闲不能被当成已完成（抓取只认 doneAt）
  assert.equal(displayStatusOf(seed({ status: 'idle' }), T), 'idle')
})

test('回合结束 → done（4s 后机器空闲，但展示窗口继续 5 分钟）', () => {
  let s = reduce(seed(), { event: 'turn_start', at: T, turnId: 't1' }).session
  assert.equal(s.status, 'working')
  assert.equal(s.turnActive, true)

  s = reduce(s, { event: 'turn_end', at: T + 30_000 }).session
  assert.equal(s.status, 'done')
  assert.equal(s.doneAt, T + 30_000)
  assert.equal(s.turnActive, false)

  // 4 秒后状态机回落 idle，但展示仍是已完成
  s = expire(s, T + 30_000 + LIVE_TIMEOUTS.DONE_HOLD_MS).session
  assert.equal(s.status, 'idle')
  assert.equal(s.doneAt, T + 30_000, '降级不能清掉 doneAt')
  assert.equal(displayStatusOf(s, T + 30_000 + 4 * 60_000), 'done', '5 分钟内仍应抓到已完成')
  assert.equal(displayStatusOf(s, T + 30_000 + DONE_DISPLAY_MS + 1), 'idle')
})

test('新回合开始会立刻清掉上一轮的已完成，不能被 5 分钟窗口盖住', () => {
  let s = reduce(seed(), { event: 'turn_start', at: T, turnId: 't1' }).session
  s = reduce(s, { event: 'turn_end', at: T + 10_000 }).session
  assert.equal(displayStatusOf(s, T + 20_000), 'done')
  s = reduce(s, { event: 'turn_start', at: T + 30_000, turnId: 't2' }).session
  assert.equal(s.status, 'working')
  assert.equal(s.doneAt, 0)
  assert.equal(displayStatusOf(s, T + 30_000), 'working')
})

test('工具结束到首字之间：turnActive 让推断 idle 不能把会话打回空闲', () => {
  let s = reduce(seed(), { event: 'turn_start', at: T, turnId: 't1' }).session
  s = reduce(s, { event: 'tool_start', at: T + 1000, tool: 'Bash' }).session
  // 长工具执行 4 分钟（库内没有 running 行时只能靠钩子）
  s = reduce(s, { event: 'tool_end', at: T + 240_000, tool: 'Bash' }).session
  s = mergeSnapshot(
    s,
    seed({ status: 'idle', statusSource: 'inferred', updatedAt: T + 250_000, statusSince: T + 250_000 }),
    T + 250_000
  ).session
  assert.equal(s.status, 'working', '工具结束、首字未到不能显示空闲')
  assert.equal(displayStatusOf(s, T + 250_000), 'working')

  // 90 秒旧阈值早已过去，钩子仍说回合在跑
  s = expire(s, T + 400_000).session
  assert.equal(s.status, 'working')
  assert.equal(displayStatusOf(s, T + 400_000), 'working')
})

test('工作中不会永远不结束：Stop 丢失时按 TURN_ACTIVE_MAX_MS 放开', () => {
  let s = reduce(seed(), { event: 'turn_start', at: T, turnId: 't1' }).session
  s = expire(s, T + LIVE_TIMEOUTS.TURN_ACTIVE_MAX_MS - 1000).session
  assert.equal(s.status, 'working', '上限内保持工作中')
  s = expire(s, T + LIVE_TIMEOUTS.TURN_ACTIVE_MAX_MS + 1000).session
  assert.equal(s.turnActive, false)
  assert.equal(s.status, 'idle', '整段静默超过上限后必须回落空闲')
})

test('db done 是可靠的回合结束证据，会清掉 turnActive；db idle 不会', () => {
  let s = reduce(seed(), { event: 'turn_start', at: T, turnId: 't1' }).session
  s = mergeSnapshot(
    s,
    seed({ status: 'idle', statusSource: 'db', updatedAt: T + 30_000, statusSince: T + 30_000 }),
    T + 30_000
  ).session
  assert.equal(s.turnActive, true, 'db idle 不能清掉钩子的回合活跃标记')
  s = mergeSnapshot(
    s,
    seed({ status: 'done', statusSource: 'db', updatedAt: T + 40_000, statusSince: T + 40_000, endedAt: T + 40_000 }),
    T + 40_000
  ).session
  assert.equal(s.status, 'done')
  assert.equal(s.turnActive, false)
  assert.equal(s.doneAt, T + 40_000)
})

test('workflow 在跑的父会话：adapter 的 idle 被 workflowBusy 压成 working', () => {
  const prev = seed({ status: 'working', workflowBusy: true, workflowBusySince: T, updatedAt: T })
  // 适配器同一份快照：回合已结束（idle）但 dwf_run 仍 running。
  const incoming = seed({
    status: 'idle',
    statusSource: 'db',
    updatedAt: T + 5000,
    statusSince: T + 5000,
    workflowBusy: true,
    workflowBusySince: T,
  })
  const merged = mergeSnapshot(prev, incoming, T + 5000).session
  assert.equal(merged.status, 'working')
  assert.equal(merged.workflowBusy, true)
  assert.equal(merged.doneAt, 0)
})

test('workflow 结束后用 run 的结束时间起算已完成，而不是父回合结束时间', () => {
  // 真实链路上状态机会在 4 秒后把 done 降成 idle，doneAt 负责撑住展示窗口。
  const s = seed({ status: 'idle', doneAt: T + 60_000, updatedAt: T + 60_000 })
  assert.equal(displayStatusOf(s, T + 60_000 + 4 * 60_000), 'done', 'run 结束后 4 分钟仍是已完成')
  assert.equal(displayStatusOf(s, T + 60_000 + DONE_DISPLAY_MS + 1), 'idle', 'run 结束后 5 分钟回落空闲')
})

test('权限超时不会被当成已完成：没有 doneAt 的 idle 就是空闲', () => {
  let s = reduce(seed({ status: 'working', updatedAt: T, statusSince: T }), {
    event: 'permission_request',
    at: T + 1000,
    requestId: 'r1',
    tool: 'Bash',
    preview: 'ls',
    timeoutMs: 1000,
  }).session
  assert.equal(s.status, 'waiting_permission')
  s = expire(s, T + 3000).session
  assert.equal(s.pending.length, 0)
  assert.equal(s.status, 'idle')
  assert.equal(displayStatusOf(s, T + 3000), 'idle', '超时不能落成已完成')
})

test('权限处理完成后续命回合：第 16 分钟仍工作中，静默 15 分钟才回落', () => {
  let s = reduce(seed({ status: 'idle', updatedAt: T }), { event: 'turn_start', at: T, turnId: 't1' }).session
  s = reduce(s, { event: 'permission_request', at: T + 60_000, requestId: 'r1', tool: 'Bash', preview: 'ls', timeoutMs: 5000 }).session
  s = reduce(s, { event: 'permission_resolved', at: T + 14 * 60_000, requestId: 'r1', decision: 'allow' }).session
  assert.equal(s.turnActiveSince, T + 14 * 60_000, 'resolution 也要刷新活跃时间')
  // 旧实现停在 1 分钟，第 16 分钟被 expire 误判空闲。
  const at16 = expire(s, T + 16 * 60_000).session
  assert.equal(at16.turnActive, true)
  assert.equal(at16.status, 'working')
  assert.equal(displayStatusOf(at16, T + 16 * 60_000), 'working')
  // 从 resolution 起静默满 15 分钟才放开。
  const at29 = expire(s, T + 29 * 60_000 + 1000).session
  assert.equal(at29.turnActive, false)
  assert.equal(at29.status, 'idle')
})

test('手动停止（db cancelled）清掉钩子留下的 turnActive，立刻显示空闲', () => {
  const prev = seed({ status: 'working', turnActive: true, turnActiveSince: T, updatedAt: T })
  const incoming = seed({
    status: 'idle',
    statusSource: 'db',
    endedAt: T + 20_000,
    doneAt: null,
    turnActive: false,
    updatedAt: T + 20_000,
    statusSince: T + 20_000,
  })
  const merged = mergeSnapshot(prev, incoming, T + 20_000).session
  assert.equal(merged.turnActive, false)
  assert.equal(merged.status, 'idle')
  assert.equal(displayStatusOf(merged, T + 20_000), 'idle')
  assert.notEqual(displayStatusOf(merged, T + 20_000), 'done', '停止不是完成')
})

test('计数与展示同源：displayStatus 已算好的行按已完成计数', () => {
  const agg = aggregateOf([
    { status: 'idle', displayStatus: 'done' },
    { status: 'working', displayStatus: 'working' },
    { status: 'done', displayStatus: 'idle' },
  ])
  assert.equal(agg.counts.done, 1)
  assert.equal(agg.counts.working, 1)
  assert.equal(agg.counts.idle, 1)
  assert.equal(agg.aggregate, 'working')
})

test('summarizeSession 带上展示字段（SSE/快览卡直接可用）', () => {
  const s = seed({ status: 'idle', doneAt: T, displayStatus: 'done', workflowBusy: false, turnActive: false })
  const sum = summarizeSession(s)
  assert.equal(sum.doneAt, T)
  assert.equal(sum.displayStatus, 'done')
  assert.equal(sum.turnActive, false)
  assert.equal(sum.workflowBusy, false)
})
