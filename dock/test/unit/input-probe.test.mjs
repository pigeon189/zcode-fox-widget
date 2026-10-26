// 输入链路探针（D057）：executeJavaScript 永久 pending 必须算超时失败，
// 连续两拍超时/异常才重载渲染进程。
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { probeOnce, createProbeWatchdog } = require('../../overlay/input-probe.cjs')

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
