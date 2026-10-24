import test from 'node:test'
import assert from 'node:assert/strict'

import { initialPet, restorePet, transition } from '../../daemon/src/state-machine.mjs'

const idle = initialPet()
const attached = transition(idle, { type: 'drop-on-agent', agentId: 'zcode', hwnd: '0x1', rect: { x: 1, y: 2, width: 3, height: 4 } })
const floating = transition(attached, { type: 'drop-on-desktop', rect: { x: 10, y: 20, width: 30, height: 40 } })

test('state: 初始是 idle，且没有档案属主', () => {
  assert.equal(idle.mode, 'idle')
  assert.equal(idle.profileOf, '')
  assert.equal(idle.agentId, '')
})

test('state: 拖到 agent → attached，档案属主随之变化', () => {
  assert.equal(attached.mode, 'attached')
  assert.equal(attached.agentId, 'zcode')
  assert.equal(attached.lastAgentId, 'zcode')
  assert.equal(attached.profileOf, 'zcode')
  assert.equal(attached.hwnd, '0x1')
  assert.deepEqual(attached.rect, { x: 1, y: 2, width: 3, height: 4 })
})

test('state: 拖到桌面 → floating，档案不变', () => {
  assert.equal(floating.mode, 'floating')
  assert.equal(floating.agentId, '')
  assert.equal(floating.lastAgentId, 'zcode')
  assert.equal(floating.profileOf, 'zcode', '悬浮态必须沿用上一个 agent 的档案')
  assert.equal(floating.hwnd, '0x1', 'lastHwnd 保留，用于窗口重现时重绑')
})

test('state: 从 idle 直接拖到桌面 → floating(generic)，不留空 profileOf', () => {
  const f = transition(idle, { type: 'drop-on-desktop' })
  assert.equal(f.mode, 'floating')
  assert.equal(f.profileOf, 'generic')
})

test('state: 窗口关闭 → floating（不是 idle），不沿用宿主窗口矩形', () => {
  const s = transition(attached, { type: 'agent-window-gone' })
  assert.equal(s.mode, 'floating')
  assert.equal(s.profileOf, 'zcode')
  assert.equal(s.agentId, '')
  assert.equal(s.rect, null, 'attached 的 rect 是宿主窗口坐标，不能当成角色位置')
})

test('state: 窗口重现且允许自动重吸附 → attached；不允许则保持 floating', () => {
  const back = transition(floating, { type: 'agent-window-back', agentId: 'zcode', hwnd: '0x2' })
  assert.equal(back.mode, 'attached')
  assert.equal(back.hwnd, '0x2')
  const no = transition(floating, { type: 'agent-window-back', agentId: 'zcode', hwnd: '0x2' }, { reattach: false })
  assert.equal(no.mode, 'floating')
  const other = transition(floating, { type: 'agent-window-back', agentId: 'kimi', hwnd: '0x3' })
  assert.equal(other.mode, 'floating', '不能重绑到别的 agent')
})

test('state: 明确重置 → idle；未知事件不改状态', () => {
  const r = transition(attached, { type: 'reset' })
  assert.equal(r.mode, 'idle')
  assert.equal(r.profileOf, '')
  assert.deepEqual(transition(floating, { type: 'nope' }), floating)
})

test('state: attached 必须有 hwnd，缺了不改变状态', () => {
  assert.deepEqual(transition(idle, { type: 'drop-on-agent', agentId: 'zcode' }), idle)
  assert.deepEqual(transition(idle, { type: 'drop-on-agent', hwnd: '0x1' }), idle)
})

test('state: auto-attach 只在 idle 时生效（除非显式要求）', () => {
  const a = transition(idle, { type: 'auto-attach', agentId: 'kimi', hwnd: '0x9' })
  assert.equal(a.mode, 'attached')
  const keep = transition(floating, { type: 'auto-attach', agentId: 'kimi', hwnd: '0x9' })
  assert.deepEqual(keep, floating)
  const force = transition(floating, { type: 'auto-attach', agentId: 'kimi', hwnd: '0x9' }, { requireIdle: false })
  assert.equal(force.mode, 'attached')
})

test('state: 移动只改几何，不改档案属主', () => {
  const m = transition(attached, { type: 'move', rect: { x: 5, y: 6, width: 7, height: 8 } })
  assert.deepEqual(m.rect, { x: 5, y: 6, width: 7, height: 8 })
  assert.equal(m.profileOf, 'zcode')
  assert.equal(m.mode, 'attached')
})

test('state: 启动恢复：窗口还在保持 attached，不在则转 floating', () => {
  const still = restorePet(attached, { windows: [{ hwnd: '0x1', agentId: 'zcode' }] })
  assert.equal(still.mode, 'attached')
  const gone = restorePet(attached, { windows: [] })
  assert.equal(gone.mode, 'floating')
  assert.equal(gone.profileOf, 'zcode')
})

test('state: 随机事件序列 10000 条，不变量始终成立', () => {
  // 固定种子 LCG，保证失败可复现
  let seed = 0x12345678
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }
  const events = [
    { type: 'drop-on-agent', agentId: 'zcode', hwnd: '0x1' },
    { type: 'drop-on-agent', agentId: 'kimi', hwnd: '0x2' },
    { type: 'drop-on-desktop' },
    { type: 'agent-window-gone' },
    { type: 'agent-window-back', agentId: 'zcode', hwnd: '0x1' },
    { type: 'auto-attach', agentId: 'dsh', hwnd: '0x3' },
    { type: 'reset' },
    { type: 'move', rect: { x: 1, y: 1, width: 2, height: 2 } },
    { type: 'bogus' },
  ]
  let state = idle
  for (let i = 0; i < 10000; i++) {
    const ev = events[Math.floor(rand() * events.length)]
    state = transition(state, ev, { reattach: rand() > 0.2 })
    if (state.mode === 'attached') {
      assert.ok(state.agentId, 'attached 必须有 agentId')
      assert.ok(state.hwnd, 'attached 必须有 hwnd')
      assert.equal(state.profileOf, state.agentId)
    } else if (state.mode === 'floating') {
      assert.ok(state.profileOf, 'floating 必须有 profileOf')
      assert.equal(state.agentId, '')
    } else {
      assert.equal(state.mode, 'idle')
      assert.equal(state.profileOf, '')
    }
  }
})
