// D034 状态归约：表格驱动 + 随机序列不变量
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSession } from '../../shared/session-model.mjs'
import { LIVE_TIMEOUTS, expire, mergeSnapshot, reduce } from '../../shared/live-reduce.mjs'

function seed(over = {}) {
  return normalizeSession(
    {
      agentId: 'zcode',
      sessionId: 'ses_1',
      title: 't',
      status: 'idle',
      statusSource: 'db',
      updatedAt: 1000,
      ...over,
    },
    { now: 1000 }
  )
}

const at = (type, extra = {}) => ({ event: type, at: 2000, ...extra })

test('live-reduce: turn_start 从 idle/done/error 进入 working', () => {
  for (const status of ['idle', 'done', 'error', 'unknown', 'working']) {
    const r = reduce(seed({ status }), at('turn_start', { turnId: 't1' }))
    assert.equal(r.session.status, 'working')
    assert.equal(r.dropped, false)
  }
})

test('live-reduce: permission_request 进入 waiting_permission 且 pending 叠加', () => {
  let s = seed()
  let r = reduce(s, at('permission_request', { requestId: 'req-0000000000001', tool: 'Bash', preview: 'ls' }))
  s = r.session
  assert.equal(s.status, 'waiting_permission')
  assert.equal(s.pending.length, 1)
  r = reduce(s, at('permission_request', { requestId: 'req-0000000000002', tool: 'Read', at: 2001 }))
  s = r.session
  assert.equal(s.pending.length, 2)
  assert.equal(s.status, 'waiting_permission')
})

test('live-reduce: permission_resolved 只在没有其他 pending 时回到 working', () => {
  let s = seed()
  s = reduce(s, at('permission_request', { requestId: 'req-0000000000001', tool: 'Bash' })).session
  s = reduce(s, at('permission_request', { requestId: 'req-0000000000002', tool: 'Read', at: 2001 })).session
  s = reduce(s, at('permission_resolved', { requestId: 'req-0000000000001', decision: 'allow', at: 2002 })).session
  assert.equal(s.status, 'waiting_permission')
  assert.equal(s.pending.length, 1)
  s = reduce(s, at('permission_resolved', { requestId: 'req-0000000000002', decision: 'deny', at: 2003 })).session
  assert.equal(s.status, 'working')
  assert.equal(s.pending.length, 0)
})

test('live-reduce: tool_start / tool_end 维护 running 与错误计数', () => {
  let s = seed()
  s = reduce(s, at('tool_start', { tool: 'Bash' })).session
  assert.deepEqual(s.tools.running, [{ name: 'Bash', since: 2000 }])
  assert.equal(s.status, 'working')
  s = reduce(s, at('tool_end', { tool: 'Bash', error: true, message: 'boom', at: 2100 })).session
  assert.equal(s.tools.running.length, 0)
  assert.equal(s.tools.errors, 1)
  assert.equal(s.errors.tool, 1)
  assert.equal(s.status, 'error')
})

test('live-reduce: turn_end → done；4s 后 expire → idle', () => {
  let s = seed()
  s = reduce(s, at('turn_start', { turnId: 't1' })).session
  s = reduce(s, at('turn_end', { at: 3000 })).session
  assert.equal(s.status, 'done')
  assert.equal(s.statusSince, 3000)
  assert.equal(expire(s, 3000 + LIVE_TIMEOUTS.DONE_HOLD_MS - 1).changed, false)
  const e = expire(s, 3000 + LIVE_TIMEOUTS.DONE_HOLD_MS)
  assert.equal(e.changed, true)
  assert.equal(e.session.status, 'idle')
})

test('live-reduce: 超时降级（working 90s / error 5min / waiting_input 30min / permission 10min）', () => {
  const w = expire(seed({ status: 'working', updatedAt: 1000, statusSince: 1000 }), 1000 + LIVE_TIMEOUTS.WORKING_IDLE_MS)
  assert.equal(w.session.status, 'idle')
  const er = expire(seed({ status: 'error', updatedAt: 1000, statusSince: 1000 }), 1000 + LIVE_TIMEOUTS.ERROR_IDLE_MS)
  assert.equal(er.session.status, 'idle')
  const wi = expire(seed({ status: 'waiting_input', updatedAt: 1000, statusSince: 1000 }), 1000 + LIVE_TIMEOUTS.WAITING_INPUT_IDLE_MS)
  assert.equal(wi.session.status, 'idle')
  const p = reduce(seed(), at('permission_request', { requestId: 'req-0000000000001' })).session
  const pe = expire(p, p.statusSince + LIVE_TIMEOUTS.PERMISSION_IDLE_MS)
  assert.equal(pe.session.status, 'idle')
  assert.deepEqual(pe.session.pending, [])
})

test('live-reduce: 时间倒退事件被丢弃但会话不变', () => {
  const s = seed({ updatedAt: 5000 })
  const r = reduce(s, at('turn_start', { at: 4000 }))
  assert.equal(r.dropped, true)
  assert.equal(r.changed, false)
  assert.equal(r.session.status, s.status)
})

test('live-reduce: 随机序列不变量（固定种子 10000 步）', () => {
  let seedNum = 42
  const rand = () => {
    seedNum = (seedNum * 1103515245 + 12345) & 0x7fffffff
    return seedNum / 0x7fffffff
  }
  const types = ['turn_start', 'tool_start', 'tool_end', 'permission_request', 'permission_resolved', 'waiting_input', 'error', 'turn_end', 'usage']
  let s = seed()
  let clock = 1000
  for (let i = 0; i < 10000; i++) {
    clock += Math.floor(rand() * 500)
    const type = types[Math.floor(rand() * types.length)]
    const evt = { event: type, at: clock, tool: 'Bash', requestId: 'req-' + String(1000000000000 + (i % 5)), usage: { input: 1, output: 1 } }
    const r = reduce(s, evt)
    s = r.session
    assert.equal(s.pending.length > 0, s.status === 'waiting_permission', 'invariant: pending ⇔ waiting_permission')
    assert.ok(!Number.isNaN(s.tokens.total))
    assert.ok(s.updatedAt >= 1000)
    if (rand() < 0.05) s = expire(s, clock).session
  }
})

test('live-reduce: mergeSnapshot 取较大的 token/工具计数，不让轮询打回实时数据', () => {
  const mem = seed({ tokens: { total: 100, input: 50 }, tools: { calls: 5, errors: 1 }, updatedAt: 2000 })
  const incoming = seed({ tokens: { total: 80, input: 40 }, tools: { calls: 3, errors: 0 }, updatedAt: 2000 })
  const r = mergeSnapshot(mem, incoming, 2000)
  assert.equal(r.session.tokens.total, 100)
  assert.equal(r.session.tools.calls, 5)
  assert.equal(r.session.tools.errors, 1)
  assert.equal(mergeSnapshot(mem, seed({ updatedAt: 1000 }), 2000).changed, false)
})

test('live-reduce: 适配器轮询不能清掉仍然活着的 pending（宿主还在弹窗）', () => {
  const mem = seed()
  mem.pending = [{ id: 'req-0000000000001', kind: 'permission', state: 'pending', createdAt: 2000, expiresAt: 60000 }]
  mem.status = 'waiting_permission'
  mem.statusSince = 1500
  mem.updatedAt = 2000
  // 适配器只能报 unknown / waiting_permission：没有「处理完」的证据。
  for (const status of ['unknown', 'waiting_permission']) {
    const incoming = seed({ status, updatedAt: 2500 })
    const r = mergeSnapshot(mem, incoming, 2500)
    assert.equal(r.session.pending.length, 1)
    assert.equal(r.session.status, 'waiting_permission')
    assert.equal(r.session.statusSince, 1500)
  }
  // 时间没有推进过 pending 创建时间：空闲快照也不足以清掉。
  const stale = seed({ status: 'idle', updatedAt: 2000 })
  const r = mergeSnapshot(mem, stale, 2000)
  assert.equal(r.session.pending.length, 1)
  assert.equal(r.session.status, 'waiting_permission')
})

test('live-reduce: 宿主处理完但没有 resolution 事件时，轮询证据清除 pending 并回落', () => {
  const mem = seed()
  mem.pending = [{ id: 'req-0000000000001', kind: 'permission', state: 'pending', createdAt: 2000, expiresAt: 60000 }]
  mem.status = 'waiting_permission'
  mem.statusSince = 2000
  mem.updatedAt = 2000
  for (const status of ['done', 'idle', 'working', 'error', 'waiting_input']) {
    const incoming = seed({ status, updatedAt: 2500, statusSince: 2500 })
    const r = mergeSnapshot(mem, incoming, 2500)
    assert.equal(r.session.pending.length, 0, status + ' 应清除 pending')
    assert.equal(r.session.status, status)
  }
  // pending 本身过期：即使适配器仍报 unknown 也不能继续保护。
  const expired = seed({ status: 'unknown', updatedAt: 3000 })
  const r = mergeSnapshot(mem, expired, 60000)
  assert.equal(r.session.pending.length, 0)
  assert.equal(r.session.status, 'unknown')
})

test('live-reduce: expire 按每条 pending 的 expiresAt 清理，不等 10 分钟', () => {
  const p = reduce(seed(), at('permission_request', { requestId: 'req-0000000000001', timeoutMs: 15000 })).session
  assert.equal(p.pending[0].expiresAt, 17000)
  assert.equal(expire(p, 16999).changed, false)
  const e = expire(p, 17000)
  assert.equal(e.changed, true)
  assert.equal(e.session.pending.length, 0)
  assert.equal(e.session.status, 'idle')
  // 刚结束的回合在 DONE_HOLD_MS 内保持 done
  const done = { ...p, endedAt: 16990 }
  const d = expire(done, 17000)
  assert.equal(d.session.status, 'done')
  const after = expire(d.session, 17000 + LIVE_TIMEOUTS.DONE_HOLD_MS)
  assert.equal(after.session.status, 'idle')
})

test('live-reduce: 重复 requestId 不叠加 pending，只刷新截止时间', () => {
  let s = reduce(seed(), at('permission_request', { requestId: 'req-0000000000001', timeoutMs: 5000, at: 2000 })).session
  assert.equal(s.pending.length, 1)
  assert.equal(s.pending[0].expiresAt, 7000)
  s = reduce(s, at('permission_request', { requestId: 'req-0000000000001', timeoutMs: 15000, at: 3000 })).session
  assert.equal(s.pending.length, 1)
  assert.equal(s.pending[0].expiresAt, 18000)
})

test('live-reduce: 宿主随后发生的 turn_end/session_end/usage 事件清除更早的 pending', () => {
  const base = reduce(seed(), at('permission_request', { requestId: 'req-0000000000001', at: 2000 })).session
  assert.equal(base.pending.length, 1)
  const ended = reduce(base, at('turn_end', { at: 3000 })).session
  assert.equal(ended.pending.length, 0)
  assert.equal(ended.status, 'done')
  const ended2 = reduce(base, at('session_end', { at: 3000 })).session
  assert.equal(ended2.pending.length, 0)
  const used = reduce(base, at('usage', { at: 3000, usage: { total: 5 } })).session
  assert.equal(used.pending.length, 0)
})

// ---------------------------------------------------------------------------
// 问题 6「状态横跳」事件序列回放：真实链路 = 事件注入（reduce）+ 适配器轮询
// （mergeSnapshot）+ 每秒 expire。思考 / 工具 running / 工具结果 / 继续生成
// 都发生在同一个回合内，不得被阶段间隙的「静默推断空闲」打回。
// ---------------------------------------------------------------------------

// 适配器在阶段间隙只能给出的快照：按静默推断 idle（inferred，无回合结束证据），
// 证据时间（updatedAt）停留在最后一次库行。
const pollIdleInferred = (atMs, over = {}) =>
  seed({ status: 'idle', statusSource: 'inferred', updatedAt: atMs, statusSince: atMs, ...over })

test('live-reduce 回放: 回合内思考→工具running→工具结果→继续生成不横跳', () => {
  const T = 1_000_000
  // 用户发消息开启新回合（事件注入）
  let s = reduce(seed({ status: 'idle', updatedAt: T - 60_000, statusSince: T - 60_000 }), {
    event: 'turn_start',
    at: T,
    turnId: 'turn-1',
  }).session
  assert.equal(s.status, 'working')

  // 0–40s：assistant 思考中——库里没有新行，适配器只能按静默推断 idle。
  // 每 2s 一次轮询，全程必须保持 working。
  for (let d = 2000; d <= 40_000; d += 2000) {
    s = mergeSnapshot(s, pollIdleInferred(T), T + d).session
    assert.equal(s.status, 'working', '思考阶段 t+' + d + 'ms 不得横跳到空闲')
  }

  // 45s：终端工具开始 → running；62s：工具结束；随后继续 assistant 生成
  s = reduce(s, { event: 'tool_start', at: T + 45_000, tool: 'Bash' }).session
  assert.deepEqual(s.tools.running, [{ name: 'Bash', since: T + 45_000 }])
  assert.equal(s.status, 'working')
  s = reduce(s, { event: 'tool_end', at: T + 62_000, tool: 'Bash' }).session
  assert.equal(s.tools.running.length, 0)
  assert.equal(s.status, 'working')

  // 工具结果后继续生成：轮询仍只能推断 idle（证据时间停在 tool_end 时刻）
  for (let d = 64_000; d <= 80_000; d += 2000) {
    s = mergeSnapshot(s, pollIdleInferred(T + 62_000), T + d).session
    assert.equal(s.status, 'working', '工具结果后继续生成 t+' + d + 'ms 不得横跳')
  }
})

test('live-reduce 回放: 长静默（≥90s 无任何证据）→ 空闲', () => {
  const T = 2_000_000
  let s = reduce(seed({ status: 'idle', updatedAt: T - 1000, statusSince: T - 1000 }), {
    event: 'turn_start',
    at: T,
    turnId: 'turn-2',
  }).session
  // 证据时间停在 T：89s 时滞回仍保持 working，91s 起接受推断空闲
  s = mergeSnapshot(s, pollIdleInferred(T), T + LIVE_TIMEOUTS.WORKING_IDLE_MS - 1000).session
  assert.equal(s.status, 'working')
  s = mergeSnapshot(s, pollIdleInferred(T), T + LIVE_TIMEOUTS.WORKING_IDLE_MS + 1000).session
  assert.equal(s.status, 'idle')
})

test('live-reduce 回放: 回合结束证据（db 终态）立即降级，不吃 90s 宽限', () => {
  const T = 3_000_000
  let s = reduce(seed({ status: 'idle', updatedAt: T - 1000, statusSince: T - 1000 }), {
    event: 'turn_start',
    at: T,
    turnId: 'turn-3',
  }).session
  s = mergeSnapshot(s, pollIdleInferred(T), T + 30_000).session
  assert.equal(s.status, 'working')
  // 适配器看到最新回合 completed（4s 内）→ done
  s = mergeSnapshot(
    s,
    seed({ status: 'done', statusSource: 'db', updatedAt: T + 31_000, statusSince: T + 31_000, endedAt: T + 31_000 }),
    T + 31_000
  ).session
  assert.equal(s.status, 'done')
  // done 4s 后 expire → idle
  s = expire(s, T + 31_000 + LIVE_TIMEOUTS.DONE_HOLD_MS).session
  assert.equal(s.status, 'idle')
  // 回合结束已过 4s：适配器直接给 db idle → 立即空闲，同样不吃宽限
  let s2 = reduce(seed({ status: 'idle', updatedAt: T - 1000, statusSince: T - 1000 }), {
    event: 'turn_start',
    at: T,
    turnId: 'turn-3b',
  }).session
  s2 = mergeSnapshot(s2, seed({ status: 'idle', statusSource: 'db', updatedAt: T + 40_000, statusSince: T + 40_000 }), T + 40_000).session
  assert.equal(s2.status, 'idle')
})

test('live-reduce 回放: 等待确认的出现与过期不受滞回影响', () => {
  const T = 4_000_000
  let s = reduce(seed({ status: 'working', updatedAt: T, statusSince: T }), {
    event: 'permission_request',
    at: T + 1000,
    requestId: 'req-0000000000001',
    tool: 'Bash',
    timeoutMs: 15000,
  }).session
  assert.equal(s.status, 'waiting_permission')
  assert.equal(s.pending.length, 1)
  // 阶段间隙的推断空闲轮询不能把等待确认打回 working/idle
  s = mergeSnapshot(s, pollIdleInferred(T + 1000), T + 5000).session
  assert.equal(s.status, 'waiting_permission')
  assert.equal(s.pending.length, 1)
  // expiresAt 过期 → expire 清 pending 回落 idle（无回合结束标记）
  const e = expire(s, T + 1000 + 15000)
  assert.equal(e.changed, true)
  assert.equal(e.session.pending.length, 0)
  assert.equal(e.session.status, 'idle')
})

test('live-reduce: expire 把在途 running 工具（10 分钟内）当作工作证据，不算静默', () => {
  const T = 5_000_000
  const base = seed({
    status: 'working',
    updatedAt: T,
    statusSince: T,
    tools: { calls: 1, errors: 0, running: [{ name: 'Bash', since: T }] },
  })
  // 90s 静默超时已到，但 Bash 仍在 running → 不降级（否则下一次轮询带回
  // running 又升回 working，1–2s 一次横跳）
  assert.equal(expire(base, T + LIVE_TIMEOUTS.WORKING_IDLE_MS + 1000).changed, false)
  // running 超过 10 分钟：视为宿主崩溃残留，不再保护
  const stale = expire(base, T + LIVE_TIMEOUTS.RUNNING_TOOL_MAX_MS + 1000)
  assert.equal(stale.changed, true)
  assert.equal(stale.session.status, 'idle')
})

test('live-reduce: mergeSnapshot 合并两侧 running 工具（同名取较新 since）', () => {
  const mem = seed({
    status: 'working',
    updatedAt: 2000,
    tools: { calls: 2, errors: 0, running: [{ name: 'Bash', since: 1000 }] },
  })
  const incoming = seed({
    status: 'working',
    statusSource: 'db',
    updatedAt: 2500,
    tools: { calls: 5, errors: 0, running: [{ name: 'Read', since: 2500 }] },
  })
  const r = mergeSnapshot(mem, incoming, 2500)
  assert.deepEqual(
    r.session.tools.running.slice().sort((a, b) => (a.name < b.name ? -1 : 1)),
    [
      { name: 'Bash', since: 1000 },
      { name: 'Read', since: 2500 },
    ]
  )
  // 同名工具：适配器侧更近的 since 胜出
  const r2 = mergeSnapshot(mem, seed({ status: 'working', statusSource: 'db', updatedAt: 2500, tools: { calls: 5, errors: 0, running: [{ name: 'Bash', since: 2200 }] } }), 2500)
  assert.deepEqual(r2.session.tools.running, [{ name: 'Bash', since: 2200 }])
})
