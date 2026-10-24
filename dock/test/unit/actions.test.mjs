// M5 §6.3 ActionBroker：幂等 / 上限 / 一次性 resolve / 超时 / 断连清理 / 审计
import assert from 'node:assert/strict'
import test from 'node:test'
import { createActionBroker } from '../../daemon/src/actions.mjs'

function makeBroker(overrides = {}) {
  const events = []
  const logs = []
  let t = 1_000_000
  const broker = createActionBroker({
    sse: { broadcast: (event, data) => events.push({ event, data }) },
    log: (line) => logs.push(line),
    now: () => t,
    ...overrides,
  })
  return { broker, events, logs, tick: (ms) => (t += ms) }
}

const REQ = (n) => 'req' + String(n).padStart(28, '0')

test('actions: create 幂等，相同 requestId 不重复计数', () => {
  const { broker } = makeBroker()
  const a = broker.create({ requestId: REQ(1), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls' })
  const b = broker.create({ requestId: REQ(1), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls' })
  assert.equal(a.created, true)
  assert.equal(b.created, false)
  assert.equal(broker.listPending().length, 1)
})

test('actions: 同会话最多 5 个 pending，超限 ignored', () => {
  const { broker } = makeBroker()
  for (let i = 0; i < 5; i++) {
    const r = broker.create({ requestId: REQ(i), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'x' })
    assert.equal(r.ignored, undefined, '第 ' + i + ' 个不应超限')
  }
  const over = broker.create({ requestId: REQ(99), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'x' })
  assert.equal(over.ignored, true)
  assert.equal(over.reason, 'session-limit')
  // 其它会话不受影响
  const other = broker.create({ requestId: REQ(100), agentId: 'zcode', sessionId: 's2', tool: 'Bash', preview: 'x' })
  assert.equal(other.ignored, undefined)
})

test('actions: 同 agent 跨会话最多 20 个', () => {
  const { broker } = makeBroker()
  for (let i = 0; i < 20; i++) {
    const r = broker.create({ requestId: REQ(i), agentId: 'zcode', sessionId: 's' + i, tool: 'Bash', preview: 'x' })
    assert.equal(r.ignored, undefined, '第 ' + i + ' 个不应超限')
  }
  const over = broker.create({ requestId: REQ(999), agentId: 'zcode', sessionId: 'sx', tool: 'Bash', preview: 'x' })
  assert.equal(over.ignored, true)
  assert.equal(over.reason, 'agent-limit')
})

test('actions: resolve 一次性；重复 resolve 冲突；未知 id not-found', () => {
  const { broker } = makeBroker()
  broker.create({ requestId: REQ(1), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls' })
  assert.equal(broker.resolve(REQ(1), 'allow', 'pet').ok, true)
  const again = broker.resolve(REQ(1), 'deny', 'pet')
  assert.equal(again.ok, false)
  assert.equal(again.error, 'conflict')
  assert.equal(broker.resolve('nope000000000000000000000', 'deny', 'pet').error, 'not-found')
  assert.equal(broker.resolve(REQ(2), 'deny', 'pet').error, 'not-found')
  assert.equal(broker.resolve(REQ(3), 'deny', 'hacker').error, 'bad-via')
  broker.create({ requestId: REQ(4), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls' })
  assert.equal(broker.resolve(REQ(4), 'maybe', 'pet').error, 'bad-decision')
  broker.resolve(REQ(4), 'deny', 'pet')
  // 决策后不再算 pending
  assert.equal(broker.listPending().length, 0)
})

test('actions: wait 长轮询拿到决策并清理 waiter', async () => {
  const { broker } = makeBroker()
  broker.create({ requestId: REQ(1), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls', ttlMs: 30000 })
  const p = broker.wait(REQ(1), 10000)
  await Promise.resolve()
  broker.resolve(REQ(1), 'allow', 'hotkey')
  assert.equal(await p, 'allow')
  // 已终结后再 wait 立即返回既有决策（幂等，不挂起）
  assert.equal(await broker.wait(REQ(1), 50), 'allow')
})

test('actions: wait 超时返回 timeout，不改变 pending 状态（决策仍可后到）', async () => {
  const { broker, tick } = makeBroker()
  broker.create({ requestId: REQ(1), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls', ttlMs: 30000 })
  const p = broker.wait(REQ(1), 50)
  tick(60)
  assert.equal(await p, 'timeout')
  assert.equal(broker.get(REQ(1)).state, 'pending')
  const p2 = broker.wait(REQ(1), 1000)
  broker.resolve(REQ(1), 'deny', 'console')
  assert.equal(await p2, 'deny')
})

test('actions: expiresAt 到期 → timeout，waiter 拿到 timeout，SSE update+remove', async () => {
  const { broker, events, tick } = makeBroker()
  broker.create({ requestId: REQ(1), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls', ttlMs: 5000 })
  const p = broker.wait(REQ(1), 60000)
  tick(5001)
  // sweep 是真实定时器（500ms unref）；等一拍
  await new Promise((r) => setTimeout(r, 700))
  assert.equal(await p, 'timeout')
  assert.equal(broker.get(REQ(1)).state, 'timeout')
  const ops = events.filter((e) => e.event === 'action').map((e) => e.data.op)
  assert.ok(ops.includes('add'))
  assert.ok(ops.includes('update'))
  assert.ok(ops.includes('remove'))
})

test('actions: AbortSignal 断连只撤等待，pending 保留', async () => {
  const { broker } = makeBroker()
  broker.create({ requestId: REQ(1), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls', ttlMs: 30000 })
  const ac = new AbortController()
  const p = broker.wait(REQ(1), 30000, { signal: ac.signal })
  ac.abort()
  assert.equal(await p, 'timeout')
  assert.equal(broker.get(REQ(1)).state, 'pending')
})

test('actions: 审计只记 id/tool/decision/via，绝不记预览', () => {
  const { broker, logs } = makeBroker()
  const secretPreview = 'rm -rf / and sk-' + 'a'.repeat(30)
  broker.create({ requestId: REQ(1), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: secretPreview })
  broker.resolve(REQ(1), 'deny', 'pet')
  const entries = broker.listAudit()
  assert.equal(entries.length, 1)
  const e = entries[0]
  assert.deepEqual(Object.keys(e).sort(), ['at', 'decision', 'id', 'tool', 'via'])
  for (const line of logs) {
    assert.ok(!line.includes(secretPreview), '日志不得含预览原文')
  }
})

test('actions: noteExternalResolved 联动宿主侧已处理', () => {
  const { broker } = makeBroker()
  broker.create({ requestId: REQ(1), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls' })
  assert.equal(broker.noteExternalResolved(REQ(1), 'allow').ok, true)
  assert.equal(broker.get(REQ(1)).state, 'allowed')
  assert.equal(broker.listAudit()[0].via, 'host')
  // 无 pending → not-found 不抛
  assert.equal(broker.noteExternalResolved('missing00000000000000000', 'allow').ok, false)
  // ignored/timeout 也走终结
  broker.create({ requestId: REQ(2), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls' })
  broker.noteExternalResolved(REQ(2), 'ignored')
  assert.equal(broker.get(REQ(2)).state, 'timeout')
})

test('actions: reset 释放所有 waiter（等价 daemon 重启不持久化）', async () => {
  const { broker } = makeBroker()
  broker.create({ requestId: REQ(1), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'ls', ttlMs: 30000 })
  const p = broker.wait(REQ(1), 30000)
  broker.reset()
  assert.equal(await p, 'timeout')
  assert.equal(broker.listPending().length, 0)
})

test('actions: 上限释放——终结几个 pending 后可以再 create', () => {
  const { broker } = makeBroker()
  for (let i = 0; i < 5; i++) broker.create({ requestId: REQ(i), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'x' })
  assert.equal(broker.create({ requestId: REQ(50), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'x' }).ignored, true)
  broker.resolve(REQ(0), 'deny', 'pet')
  const ok = broker.create({ requestId: REQ(51), agentId: 'zcode', sessionId: 's1', tool: 'Bash', preview: 'x' })
  assert.equal(ok.ignored, undefined)
})
