import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Win32Bridge } from '../../daemon/src/win32.mjs'

let bridge
let windows

before(async () => {
  bridge = new Win32Bridge()
  await bridge.start()
  windows = await bridge.snapshot()
})

after(() => {
  if (bridge) bridge.stop()
})

test('bridge: snapshot 返回可见窗口，字段齐全', () => {
  assert.ok(windows.length > 0, 'expected at least one visible window')
  for (const w of windows.slice(0, 20)) {
    assert.match(w.hwnd, /^[0-9a-f]+$/)
    assert.ok(w.pid > 0)
    assert.ok(w.startMs > 0, 'startMs missing for pid ' + w.pid)
    assert.ok(w.rect.w > 0 && w.rect.h > 0)
    assert.ok(typeof w.title === 'string')
    assert.ok(typeof w.cls === 'string')
  }
  assert.ok(
    windows.some((w) => /explorer\.exe$/i.test(w.exe || '')),
    'expected explorer.exe in the window list'
  )
})

test('bridge: 最上层窗口中心点命中它自己', async () => {
  const top = windows[0]
  const cx = top.rect.x + Math.floor(top.rect.w / 2)
  const cy = top.rect.y + Math.floor(top.rect.h / 2)
  const hits = await bridge.hit(cx, cy)
  assert.ok(hits.length > 0, 'no hit at topmost window center')
  assert.equal(hits[0].hwnd, top.hwnd)
})

test('bridge: 排除自身 pid 后不再返回该进程的窗口', async () => {
  const top = windows[0]
  const cx = top.rect.x + Math.floor(top.rect.w / 2)
  const cy = top.rect.y + Math.floor(top.rect.h / 2)
  const hits = await bridge.hit(cx, cy, top.pid)
  assert.ok(hits.every((h) => h.pid !== top.pid))
  assert.ok(hits.length <= 5)
})

test('bridge: rect 与 snapshot 一致', async () => {
  const w = windows.find((x) => x.rect.w > 200 && x.rect.h > 200) || windows[0]
  const r = await bridge.rect(w.hwnd)
  assert.equal(r.ok, true)
  assert.deepEqual(r.rect, w.rect)
})

test('bridge: 连续 200 次命中 < 3s（拖拽采样预算）', async () => {
  const top = windows[0]
  const cx = top.rect.x + Math.floor(top.rect.w / 2)
  const cy = top.rect.y + Math.floor(top.rect.h / 2)
  const t0 = Date.now()
  for (let i = 0; i < 200; i++) await bridge.hit(cx, cy)
  const ms = Date.now() - t0
  assert.ok(ms < 3000, '200 hits took ' + ms + 'ms')
})

test('bridge: rect 对无效句柄返回结构化失败（不抛错）', async () => {
  const r = await bridge.rect('fffff')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'rect-failed')
})

test('bridge: rect 对正常窗口返回可用矩形', async () => {
  const w = windows[0]
  const r = await bridge.rect(w.hwnd)
  assert.equal(r.ok, true)
  assert.ok(r.rect.w > 0 && r.rect.h > 0)
  // 桥与 snapshot 必须看到同一个矩形（差 1px 容差）
  assert.ok(Math.abs(r.rect.x - w.rect.x) <= 1 && Math.abs(r.rect.y - w.rect.y) <= 1)
})
