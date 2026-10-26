// 回合活跃（turnActive，D056）合并的属性/模糊测试：固定种子的随机时序组合。
// 覆盖的不变量：
//   1. cancelled（手动停止）回合清 turnActive 且不落 doneAt；
//   2. doneAt 只在 completed 回合记录（error 结束 / 新回合 / 继续用量都清零）；
//   3. turnActive 15 分钟上限（从最后一次续命起算，±1ms 边界）；
//   4. db endedAt 晚于 turnActiveSince 才算确认结束（≥ 边界，±1ms）；
//   5. 事件乱序到达（at < updatedAt）被丢弃，状态逐字段不回退。
// 随机数用固定种子（mulberry32），失败样本断言具体的 displayStatus / turnActive / doneAt 值。
import assert from 'node:assert/strict'
import test from 'node:test'

import { DONE_DISPLAY_MS, displayStatusOf, normalizeSession } from '../../shared/session-model.mjs'
import { LIVE_TIMEOUTS, expire, mergeSnapshot, reduce } from '../../shared/live-reduce.mjs'

// 固定种子 PRNG：任何失败都能用同一种子复现。
function mulberry32(seedNum) {
  let a = seedNum >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const T0 = 1_790_000_000_000
const ACTIVE_STATUSES = ['working', 'waiting_permission', 'waiting_input', 'error']

function seed(over = {}) {
  return normalizeSession(
    {
      agentId: 'zcode',
      sessionId: 'ses_fuzz',
      title: 't',
      status: 'idle',
      statusSource: 'db',
      updatedAt: T0,
      ...over,
    },
    { now: T0 }
  )
}

function startTurn(baseAt, turnId = 't') {
  return reduce(seed({ status: 'idle', updatedAt: baseAt - 1000, statusSince: baseAt - 1000 }), {
    event: 'turn_start',
    at: baseAt,
    turnId,
  }).session
}

// ---------------------------------------------------------------------------
// 不变量 1：cancelled 清 turnActive 且不落 doneAt（随机 ±1ms 与随机续命）
// ---------------------------------------------------------------------------

test('cancelled 合并：endedAt ≥ turnActiveSince 清 turnActive，doneAt 保持 0（随机 ±1ms，300 样本）', () => {
  const rand = mulberry32(20261027)
  for (let i = 0; i < 300; i++) {
    const T = T0 + Math.floor(rand() * 86_400_000)
    let s = startTurn(T, 't' + i)
    assert.equal(s.turnActive, true)
    assert.equal(s.turnActiveSince, T)
    // 回合内随机续命（usage 不产生 running 工具行，只刷新 turnActiveSince），时间戳单调递增
    let last = T
    const refreshes = Math.floor(rand() * 3)
    for (let k = 0; k < refreshes; k++) {
      last += 1 + Math.floor(rand() * 60_000)
      s = reduce(s, { event: 'usage', at: last, usage: { input: 1 } }).session
      assert.equal(s.turnActiveSince, last, `样本 ${i}: usage 应续命 turnActiveSince`)
    }
    // 手动停止：适配器把 cancelled 回合报成 db idle + endedAt，doneAt 为空。
    // delta 相对最终 turnActiveSince（续命会把它从 T 推进到 last），
    // 覆盖 -1 / 0 / +1（确认边界）与随机正值。
    const since = Number(s.turnActiveSince)
    const delta = [-1, 0, 1, 1 + Math.floor(rand() * 600_000)][Math.floor(rand() * 4)]
    const endedAt = since + delta
    const incoming = seed({
      status: 'idle',
      statusSource: 'db',
      endedAt,
      doneAt: null,
      turnActive: false,
      updatedAt: Math.max(endedAt, last),
      statusSince: Math.max(endedAt, last),
    })
    const merged = mergeSnapshot(s, incoming, Math.max(endedAt, last)).session
    if (delta >= 0) {
      assert.equal(merged.turnActive, false, `样本 ${i}: endedAt=${endedAt} ≥ turnActiveSince=${since} 必须确认结束`)
      assert.equal(merged.turnActiveSince, 0, `样本 ${i}: 结束后活跃时刻必须清零`)
      assert.equal(merged.status, 'idle', `样本 ${i}: 手动停止后是空闲，不是 working/done`)
      assert.equal(merged.doneAt, 0, `样本 ${i}: cancelled 不落 doneAt`)
      for (const t of [endedAt, endedAt + 60_000, endedAt + DONE_DISPLAY_MS + 1]) {
        assert.equal(displayStatusOf(merged, t), 'idle', `样本 ${i}: t=+${t - endedAt}ms 必须是空闲，不能回闪已完成`)
      }
    } else {
      assert.equal(merged.turnActive, true, `样本 ${i}: endedAt=${endedAt} < turnActiveSince=${since} 不算确认结束`)
      assert.equal(merged.turnActiveSince, since, `样本 ${i}: 旧快照不能清活跃时刻`)
      assert.equal(merged.status, 'working', `样本 ${i}: 钩子说回合还在跑就不能显示空闲`)
      assert.equal(merged.doneAt, 0, `样本 ${i}: 未确认结束不能落 doneAt`)
    }
  }
})

// ---------------------------------------------------------------------------
// 不变量 2：doneAt 只在 completed 回合记录
// ---------------------------------------------------------------------------

test('doneAt 只在 completed 回合记录：error 结束 / 继续用量 / 新回合都清零（具体值断言）', () => {
  const T = T0 + 1000
  // turn_end 带 error → error 状态，不落 doneAt
  let s = startTurn(T, 't1')
  s = reduce(s, { event: 'turn_end', at: T + 5000, error: true, message: 'boom' }).session
  assert.equal(s.status, 'error')
  assert.equal(s.doneAt, 0, '错误结束不落 doneAt')
  assert.equal(s.turnActive, false)
  assert.equal(displayStatusOf(s, T + 60_000), 'error')

  // turn_end 正常完成 → doneAt 精确等于结束时刻；4 秒后状态机回落 idle，
  // doneAt 撑住 5 分钟展示窗口（±1ms 边界）
  let d = startTurn(T, 't2')
  d = reduce(d, { event: 'turn_end', at: T + 8000 }).session
  assert.equal(d.status, 'done')
  assert.equal(d.doneAt, T + 8000)
  assert.equal(d.doneAt, d.statusSince, 'done 的 doneAt 与 statusSince 同源')
  assert.equal(d.endedAt, T + 8000)
  assert.equal(displayStatusOf(d, T + 8000), 'done')
  d = expire(d, T + 8000 + LIVE_TIMEOUTS.DONE_HOLD_MS).session
  assert.equal(d.status, 'idle', '4 秒后状态机回落空闲')
  assert.equal(d.doneAt, T + 8000, '降级不能清掉 doneAt')
  assert.equal(displayStatusOf(d, T + 8000 + DONE_DISPLAY_MS - 1), 'done', '窗口内最后一刻仍是已完成')
  assert.equal(displayStatusOf(d, T + 8000 + DONE_DISPLAY_MS + 1), 'idle', '超过 5 分钟回落空闲')

  // session_end 同样落 doneAt
  const e = reduce(seed({ status: 'idle', updatedAt: T - 1000 }), { event: 'session_end', at: T + 9000 }).session
  assert.equal(e.status, 'done')
  assert.equal(e.doneAt, T + 9000)

  // done 之后 usage / turn_start 都清掉 doneAt（新回合不能被上一轮盖住）。
  // 用全新会话：机器状态还是 done 时 usage 才会回活。
  let c = startTurn(T, 't3')
  c = reduce(c, { event: 'turn_end', at: T + 8500 }).session
  assert.equal(c.doneAt, T + 8500)
  c = reduce(c, { event: 'usage', at: T + 9000, usage: { input: 1 } }).session
  assert.equal(c.status, 'working')
  assert.equal(c.doneAt, 0, 'usage 回到工作中必须清 doneAt')
  c = reduce(c, { event: 'turn_end', at: T + 9500 }).session
  assert.equal(c.doneAt, T + 9500)
  c = reduce(c, { event: 'turn_start', at: T + 10_000, turnId: 't4' }).session
  assert.equal(c.doneAt, 0, '新回合开始必须清上一轮 doneAt')
  assert.equal(c.status, 'working')
  assert.equal(displayStatusOf(c, T + 10_000), 'working')

  // 降级后 doneAt 撑展示窗口：单独的 usage 事件不会把 idle 拉回工作中（只在 done 上回活）
  let w = startTurn(T, 't4')
  w = reduce(w, { event: 'turn_end', at: T + 11_000 }).session
  w = expire(w, T + 11_000 + LIVE_TIMEOUTS.DONE_HOLD_MS).session
  assert.equal(w.status, 'idle')
  assert.equal(w.doneAt, T + 11_000)
  w = reduce(w, { event: 'usage', at: T + 12_000, usage: { input: 1 } }).session
  assert.equal(w.status, 'idle', '空闲上的孤立 usage 不回活（回合边界才回活）')
  assert.equal(displayStatusOf(w, T + 12_000 + DONE_DISPLAY_MS + 1), 'idle', '窗口外一直空闲')
})

test('合并口径：done 快照落 doneAt；cancelled（db idle + endedAt）与 error 快照不落', () => {
  const T = T0 + 2000
  const prev = startTurn(T, 't1')
  // completed：doneAt = 快照给的完成时刻，turnActive 被确认结束清掉
  const done = mergeSnapshot(
    prev,
    seed({ status: 'done', statusSource: 'db', endedAt: T + 4000, doneAt: T + 4000, updatedAt: T + 4000, statusSince: T + 4000 }),
    T + 4000
  ).session
  assert.equal(done.turnActive, false)
  assert.equal(done.turnActiveSince, 0)
  assert.equal(done.doneAt, T + 4000)
  assert.equal(displayStatusOf(done, T + 4000 + DONE_DISPLAY_MS - 1), 'done')
  // cancelled：db idle + endedAt，doneAt 必须保持 0
  const cancel = mergeSnapshot(
    prev,
    seed({ status: 'idle', statusSource: 'db', endedAt: T + 5000, doneAt: null, updatedAt: T + 5000, statusSince: T + 5000 }),
    T + 5000
  ).session
  assert.equal(cancel.turnActive, false)
  assert.equal(cancel.doneAt, 0, 'cancelled 快照不能让会话在 5 分钟窗口里显示已完成')
  assert.equal(displayStatusOf(cancel, T + 5000 + DONE_DISPLAY_MS + 1), 'idle')
  // error 快照：doneAt 清零
  const err = mergeSnapshot(
    prev,
    seed({ status: 'error', statusSource: 'db', updatedAt: T + 6000, statusSince: T + 6000 }),
    T + 6000
  ).session
  assert.equal(err.status, 'error')
  assert.equal(err.doneAt, 0)
})

// ---------------------------------------------------------------------------
// 不变量 3：turnActive 15 分钟上限（从最后一次续命起算）
// ---------------------------------------------------------------------------

test('turnActive 15 分钟上限：最后一次续命后 MAX-1 / MAX / MAX+1 三档（随机步长推进，200 样本）', () => {
  const rand = mulberry32(20261028)
  const MAX = LIVE_TIMEOUTS.TURN_ACTIVE_MAX_MS
  const steps = [1, 100, 1000, 30_000, 120_000]
  for (let i = 0; i < 200; i++) {
    const T = T0 + Math.floor(rand() * 3_600_000)
    let s = startTurn(T, 'cap' + i)
    let clock = T
    let lastTouch = T
    const n = 1 + Math.floor(rand() * 6)
    for (let k = 0; k < n; k++) {
      clock += steps[Math.floor(rand() * steps.length)]
      if (clock - lastTouch >= MAX) break
      s = reduce(s, { event: 'usage', at: clock, usage: { input: 1 } }).session
      lastTouch = clock
    }
    // 上限内（最后一次续命 + MAX - 1）保持活跃
    const inner = expire(s, lastTouch + MAX - 1).session
    assert.equal(inner.turnActive, true, `样本 ${i}: 上限内必须保持活跃`)
    assert.equal(inner.status, 'working', `样本 ${i}: 上限内不能回落空闲`)
    // 恰好等于上限：条件是 now - since > MAX，不动
    assert.equal(expire(s, lastTouch + MAX).session.turnActive, true, `样本 ${i}: 恰好 15 分钟还不放开`)
    // 超过 1ms：放开并回落空闲（usage 续命不产生 running 工具，无在途保护）
    const outer = expire(s, lastTouch + MAX + 1).session
    assert.equal(outer.turnActive, false, `样本 ${i}: 超过上限必须放开`)
    assert.equal(outer.turnActiveSince, 0, `样本 ${i}: 放开后活跃时刻清零`)
    assert.equal(outer.status, 'idle', `样本 ${i}: Stop 丢失兜底后回落空闲`)
    assert.equal(displayStatusOf(outer, lastTouch + MAX + 1), 'idle', `样本 ${i}: 兜底后不能显示已完成`)
  }
})

// ---------------------------------------------------------------------------
// 不变量 4：db endedAt 晚于 turnActiveSince 才算确认结束（±1ms 表驱动）
// ---------------------------------------------------------------------------

test('db 回合结束证据的边界：endedAt ≥ turnActiveSince 才确认（±1ms）；inferred 不算证据', () => {
  const T = T0 + 3000
  for (const [endedAt, expectClear] of [
    [T - 1, false],
    [T, true],
    [T + 1, true],
  ]) {
    const s = startTurn(T, 'edge')
    const incoming = seed({
      status: 'idle',
      statusSource: 'db',
      endedAt,
      doneAt: null,
      updatedAt: T + 5000,
      statusSince: T + 5000,
    })
    const merged = mergeSnapshot(s, incoming, T + 5000).session
    assert.equal(merged.turnActive, !expectClear, `endedAt=${endedAt}（turnActiveSince=${T}）`)
    if (expectClear) {
      assert.equal(merged.turnActiveSince, 0)
      assert.equal(merged.status, 'idle')
      assert.equal(merged.doneAt, 0)
    } else {
      assert.equal(merged.turnActiveSince, T)
      assert.equal(merged.status, 'working', '旧结束证据不能打掉钩子的回合活跃')
    }
  }
  // statusSource 不是 db（inferred）：即使带 endedAt 也不清钩子的活跃标记
  const s2 = startTurn(T, 'edge2')
  const inf = mergeSnapshot(
    s2,
    seed({ status: 'idle', statusSource: 'inferred', endedAt: T + 30_000, doneAt: null, updatedAt: T + 30_000, statusSince: T + 30_000 }),
    T + 30_000
  ).session
  assert.equal(inf.turnActive, true, '推断空闲不是回合结束证据')
  assert.equal(inf.status, 'working', '滞回：工具结束到首字之间不能被推断空闲打回')
})

// ---------------------------------------------------------------------------
// 不变量 5：事件乱序到达时状态不回退
// ---------------------------------------------------------------------------

test('乱序事件：旧事件重投递被丢弃，状态逐字段不回退（固定种子随机序列，60 轮）', () => {
  const rand = mulberry32(20261029)
  const types = ['turn_start', 'tool_start', 'tool_end', 'permission_request', 'permission_resolved', 'waiting_input', 'usage', 'turn_end', 'error']
  const gaps = [1, 5, 100, 1000, 30_000]
  for (let round = 0; round < 60; round++) {
    // 严格递增时间戳的规范序列（时钟推进步长随机）
    const events = []
    let clock = T0 + round * 1_000_000
    const len = 8 + Math.floor(rand() * 12)
    for (let i = 0; i < len; i++) {
      clock += gaps[Math.floor(rand() * gaps.length)]
      events.push({
        event: types[Math.floor(rand() * types.length)],
        at: clock,
        tool: 'Bash',
        requestId: 'req-fuzz-' + round + '-' + Math.floor(rand() * 3),
        usage: { input: 1, output: 1 },
        turnId: 'tr-' + round,
      })
    }
    let s = seed({ status: 'idle', updatedAt: events[0].at - 1000, statusSince: events[0].at - 1000 })
    for (let i = 0; i < events.length; i++) {
      // 重投递一条旧事件（at 严格小于当前 updatedAt）：必须整体丢弃。
      // 只取 j ≤ i-2：j = i-1 与 updatedAt 同毫秒，不属于乱序。
      if (i > 1 && rand() < 0.5) {
        const j = Math.floor(rand() * (i - 1))
        const before = s
        const r = reduce(s, events[j])
        assert.equal(r.dropped, true, `round ${round} step ${i}: 旧事件 at=${events[j].at} < updatedAt=${s.updatedAt} 必须丢弃`)
        assert.equal(r.session.updatedAt, before.updatedAt, '丢弃不能推进 updatedAt')
        assert.equal(r.session.status, before.status, '丢弃不能改状态')
        assert.equal(r.session.turns.count, before.turns.count, '丢弃不能重复计回合')
        assert.equal(r.session.turnActive, before.turnActive, '丢弃不能改回合活跃')
        assert.equal(r.session.doneAt, before.doneAt, '丢弃不能改 doneAt')
        assert.equal(r.session.pending.length, before.pending.length, '丢弃不能改 pending')
      }
      const r = reduce(s, events[i])
      assert.equal(r.dropped, false, `round ${round} step ${i}: 递增时间戳不应被丢弃`)
      s = r.session
      assert.ok(s.updatedAt >= events[i].at, 'updatedAt 单调推进到事件时刻')
      // 局部不变量
      assert.equal(s.pending.length > 0, s.status === 'waiting_permission', 'pending ⇔ waiting_permission')
      if (s.turnActive === true) {
        assert.ok(s.turnActiveSince > 0, 'turnActive 必须带活跃时刻')
        assert.ok(
          ACTIVE_STATUSES.includes(s.status),
          `round ${round} step ${i}: turnActive 与状态 ${s.status} 不兼容`
        )
      }
      if (s.status === 'done') {
        assert.equal(s.doneAt, s.statusSince, 'done 的 doneAt 与 statusSince 同源')
        assert.equal(s.turnActive, false, 'done 时回合已结束')
        assert.equal(displayStatusOf(s, s.updatedAt), 'done')
      } else {
        assert.ok(s.doneAt === 0 || s.status === 'idle', `doneAt=${s.doneAt} 只能在 done/idle 上保留`)
      }
      if (rand() < 0.1) s = expire(s, s.updatedAt).session
    }
  }
})

test('乱序快照：updatedAt 更旧的适配器快照整体被拒，状态不回退', () => {
  const T = T0 + 4000
  const prev = startTurn(T, 'stale')
  const r = mergeSnapshot(
    prev,
    seed({ status: 'done', statusSource: 'db', endedAt: T + 5000, doneAt: T + 5000, updatedAt: T - 500, statusSince: T - 500 }),
    T
  )
  assert.equal(r.changed, false, '旧快照不能产生变更')
  assert.equal(r.session.status, 'working', '旧 done 快照不能把活跃回合打成已完成')
  assert.equal(r.session.turnActive, true)
  assert.equal(r.session.doneAt, 0)
})

// ---------------------------------------------------------------------------
// 组合模糊：reduce + 适配器快照合并（cancelled / completed / inferred idle）+
// expire，随机步长推进时钟，断言用户可见的展示不变量。
// ---------------------------------------------------------------------------

test('组合模糊：reduce + 快照合并 + expire 的展示不变量（固定种子，40 轮 × 40 步）', () => {
  const rand = mulberry32(20261030)
  const types = ['turn_start', 'tool_start', 'tool_end', 'permission_request', 'permission_resolved', 'waiting_input', 'usage', 'turn_end', 'session_end', 'error']
  const steps = [1, 10, 500, 5000, 60_000, 200_000]
  for (let round = 0; round < 40; round++) {
    let s = seed({ status: 'idle', updatedAt: T0 + round * 100_000, statusSince: T0 + round * 100_000 })
    let clock = s.updatedAt
    for (let step = 0; step < 40; step++) {
      clock += steps[Math.floor(rand() * steps.length)]
      const statusBeforeOp = s.status
      let op = ''
      const roll = rand()
      if (roll < 0.15) {
        op = 'merge'
        // 适配器轮询快照：cancelled（db idle + endedAt）/ completed / 推断 idle
        const kind = rand()
        const cancelled = kind < 0.5
        const endedAt = clock - Math.floor(rand() * 1000)
        const prev = s
        const incoming = seed(
          cancelled
            ? { status: 'idle', statusSource: 'db', endedAt, doneAt: null, updatedAt: clock, statusSince: clock }
            : kind < 0.75
              ? { status: 'done', statusSource: 'db', endedAt: clock, doneAt: clock, updatedAt: clock, statusSince: clock }
              : { status: 'idle', statusSource: 'inferred', endedAt: null, doneAt: null, updatedAt: clock, statusSince: clock }
        )
        s = mergeSnapshot(prev, incoming, clock).session
        if (cancelled && prev.turnActive === true) {
          if (endedAt >= (Number(prev.turnActiveSince) || 0)) {
            assert.equal(s.turnActive, false, `round ${round} step ${step}: cancelled 快照必须清 turnActive`)
            assert.equal(s.doneAt, 0, `round ${round} step ${step}: cancelled 不落 doneAt`)
            assert.equal(displayStatusOf(s, clock), 'idle', `round ${round} step ${step}: 手动停止后是空闲`)
            assert.equal(displayStatusOf(s, clock + DONE_DISPLAY_MS + 1), 'idle', `round ${round} step ${step}: 停止不回闪已完成`)
          } else {
            assert.equal(s.turnActive, true, `round ${round} step ${step}: endedAt < turnActiveSince 不确认结束`)
          }
        }
      } else if (roll < 0.3) {
        op = 'expire'
        s = expire(s, clock).session
      } else {
        op = 'reduce'
        s = reduce(s, {
          event: types[Math.floor(rand() * types.length)],
          at: clock,
          tool: 'Bash',
          requestId: 'req-mix-' + round + '-' + Math.floor(rand() * 3),
          usage: { input: 1, output: 1 },
          turnId: 'mix-' + round,
        }).session
      }
      // 全局不变量（用户可见口径）
      assert.equal(s.pending.length > 0, s.status === 'waiting_permission', `round ${round} step ${step}: pending ⇔ waiting_permission`)
      assert.ok(s.updatedAt <= clock, `round ${round} step ${step}: updatedAt 不能超前于时钟`)
      if (s.turnActive === true) {
        assert.ok(s.turnActiveSince > 0 && s.turnActiveSince <= clock, 'turnActiveSince 必须在 (0, now] 内')
        // 历史缺陷转角（已修复，见文末回归用例）：expire 的 pending 过期分支
        // 曾把状态置 idle 而不管 turnActive。这里保留转角豁免改为断言
        // 「下一拍自愈为 working（或 15 分钟上限正确放开）」，防同类回归静默溜过。
        const expireEscape = op === 'expire' && statusBeforeOp === 'waiting_permission' && !ACTIVE_STATUSES.includes(s.status)
        if (expireEscape) {
          const healed = expire(s, clock + 1).session
          assert.ok(
            healed.status === 'working' || healed.turnActive === false,
            `round ${round} step ${step}: turnActive 空闲逃逸必须在下一拍自愈`
          )
        } else {
          assert.ok(ACTIVE_STATUSES.includes(s.status), `round ${round} step ${step}: turnActive 与状态 ${s.status} 不兼容`)
        }
      }
      if (s.status === 'done') assert.equal(s.turnActive, false, 'done 时回合已结束')
      const ds = displayStatusOf(s, clock)
      if (ACTIVE_STATUSES.includes(s.status)) {
        assert.equal(ds, s.status, `round ${round} step ${step}: 活跃状态必须原样透出`)
      } else if (s.turnActive === true || s.workflowBusy === true) {
        assert.equal(ds, 'working', `round ${round} step ${step}: 后台活跃必须压制成工作中`)
      } else if (s.status === 'done') {
        assert.equal(ds, 'done')
      } else if (s.doneAt > 0 && clock >= s.doneAt && clock - s.doneAt < DONE_DISPLAY_MS) {
        assert.equal(ds, 'done', `round ${round} step ${step}: doneAt 5 分钟窗口内显示已完成`)
      } else {
        assert.ok(ds === 'idle' || ds === 'unknown', `round ${round} step ${step}: 期望空闲，实际 ${ds}`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// 属性测试曾暴露的产品缺陷（2026-10-27 发现，同日修复转正）：
// expire() 的 pending 过期分支曾在清掉过期 pending 后直接置 idle/done，
// 不检查 next.turnActive——违反 D056「turnActive 压制 done/idle」，机器状态
// 闪 1 拍「空闲」。现在该分支在 turnActive 时置 working（statusSince=now、
// doneAt=0），本用例由 skip 转正为回归守卫。
// ---------------------------------------------------------------------------

test('turnActive 压制 pending 过期分支：不落空闲（已修复，回归守卫）', () => {
  const T = T0 + 5000
  let s = startTurn(T, 'escape')
  s = reduce(s, { event: 'permission_request', at: T + 1000, requestId: 'r1', tool: 'Bash', timeoutMs: 5000 }).session
  assert.equal(s.status, 'waiting_permission')
  assert.equal(s.turnActive, true)
  const e = expire(s, T + 6000).session
  assert.equal(e.turnActive, true, '回合仍被钩子确认活跃')
  assert.equal(e.status, 'working', 'turnActive 必须压制 pending 过期后的空闲降级')
  assert.equal(displayStatusOf(e, T + 6000), 'working')
})
