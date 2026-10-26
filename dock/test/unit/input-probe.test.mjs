// 输入链路探针（D057）：executeJavaScript 永久 pending 必须算超时失败，
// 连续两拍超时/异常才重载渲染进程。
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { probeOnce, createProbeWatchdog, createMousePolicy } = require('../../overlay/input-probe.cjs')

test('probeOnce 正常返回页面结果', async () => {
  const r = await probeOnce(async () => ({ hit: true, interactive: false }), 1000)
  assert.deepEqual(r, { timedOut: false, probe: { hit: true, interactive: false } })
})

test('probeOnce 永久 pending 超时，不返回 null 冒充「页面未就绪」', async () => {
  const r = await probeOnce(() => new Promise(() => {}), 20)
  assert.equal(r.timedOut, true)
  assert.equal(r.probe, null)
})

test('probeOnce 透传异常', async () => {
  await assert.rejects(
    () =>
      probeOnce(async () => {
        throw new Error('renderer-gone')
      }, 100),
    /renderer-gone/
  )
})

test('watchdog 连续两次失败才触发，成功会清零', () => {
  let stuck = 0
  const w = createProbeWatchdog({ limit: 2, onStuck: () => stuck++ })
  assert.equal(w.fail(), false)
  assert.equal(stuck, 0)
  assert.equal(w.fail(), true)
  assert.equal(stuck, 1)
  // 触发后计数清零，再连续两次才再次触发。
  assert.equal(w.fail(), false)
  w.ok()
  assert.equal(w.fail(), false)
  assert.equal(stuck, 1)
  assert.equal(w.fail(), true)
  assert.equal(stuck, 2)
})

// 复审 R1-1：探针（30s，DOM 真实命中）与 300ms zOrder 轮询是 setIgnoreMouseEvents
// 的两个写者。探针的纠正必须写回权威状态，否则轮询用陈旧 rendererInteractive
// 把纠正覆盖回去（狐狸每 30s 只有 ≤300ms 可点，或整窗吞点击）。
test('mousePolicy: 探针纠正写回权威状态，300ms 轮询重放不回滚', () => {
  const applied = []
  const p = createMousePolicy({ apply: (ignore) => applied.push(ignore) })
  // 渲染层自报「不交互」（指针未压角色）
  p.setInteractive(false)
  assert.deepEqual(applied, [true])
  // 探针说指针压在角色上：纠正生效且写回权威状态
  p.applyProbe({ hit: true })
  assert.deepEqual(applied, [true, false])
  // 300ms 轮询重放：只按当前状态 apply，不能把探针的纠正滚回去
  p.refresh()
  p.refresh()
  assert.deepEqual(applied, [true, false, false, false])
})

test('mousePolicy: 探针无效结果只重放不改状态；IPC 随后更新生效', () => {
  const applied = []
  const p = createMousePolicy({ apply: (ignore) => applied.push(ignore) })
  p.applyProbe(null)
  p.applyProbe({})
  p.applyProbe({ hit: 'yes' })
  assert.deepEqual(applied, [true, true, true], '初始 interactive=false → 穿透')
  p.setInteractive(true)
  assert.deepEqual(applied, [true, true, true, false])
})

test('mousePolicy: overlay 隐藏时无论交互与否都穿透，恢复显示后回到状态值', () => {
  const applied = []
  const p = createMousePolicy({ apply: (ignore) => applied.push(ignore) })
  p.setInteractive(true)
  p.setShown(false)
  assert.deepEqual(applied, [false, true])
  p.setShown(false) // 同值不重复 apply
  assert.deepEqual(applied, [false, true])
  p.setShown(true)
  assert.deepEqual(applied, [false, true, false])
})
