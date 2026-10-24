// overlayWorkAreaBounds 单元测试（2026-10-24 定稿口径：正常与工作区精确重合，
// 仅「工作区==整屏」（任务栏自动隐藏）或拿不到屏幕 bounds 时留 1 DIP 防压
// 任务栏滑出热区——1.x v1.16.2 issue #8 的最小化版本）。纯函数，不依赖 Electron。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { TASKBAR_REVEAL_INSET, overlayWorkAreaBounds } = require('../../overlay/window-bounds.cjs')

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 }

test('bounds: 任务栏常驻（工作区小于屏幕）时与工作区精确重合，兜底角可贴角', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 }
  assert.deepEqual(overlayWorkAreaBounds(wa, SCREEN), { x: 0, y: 0, width: 1920, height: 1040 })
})

test('bounds: 任务栏在左/上（工作区原点平移）同样精确重合', () => {
  const wa = { x: 48, y: 0, width: 1872, height: 1080 }
  assert.deepEqual(overlayWorkAreaBounds(wa, SCREEN), { x: 48, y: 0, width: 1872, height: 1080 })
})

test('bounds: 自动隐藏任务栏（工作区==整屏）时四周留 1 DIP，不得与整屏重合', () => {
  assert.equal(TASKBAR_REVEAL_INSET, 1)
  const b = overlayWorkAreaBounds(SCREEN, SCREEN)
  assert.deepEqual(b, { x: 1, y: 1, width: 1918, height: 1078 })
  assert.ok(b.x > SCREEN.x && b.y > SCREEN.y)
  assert.ok(b.x + b.width < SCREEN.x + SCREEN.width)
  assert.ok(b.y + b.height < SCREEN.y + SCREEN.height)
})

test('bounds: 拿不到屏幕 bounds 时保守留缝（不与整屏严格重合）', () => {
  const b = overlayWorkAreaBounds({ x: 0, y: 0, width: 1920, height: 1080 })
  assert.deepEqual(b, { x: 1, y: 1, width: 1918, height: 1078 })
})

test('bounds: 极小工作区仍返回至少 1x1，不产生负尺寸', () => {
  const b = overlayWorkAreaBounds({ x: 0, y: 0, width: 2, height: 2 }, SCREEN)
  assert.deepEqual(b, { x: 0, y: 0, width: 2, height: 2 })
  const b2 = overlayWorkAreaBounds(SCREEN, SCREEN)
  assert.equal(Number.isFinite(b2.width), true)
})

test('bounds: 非法工作区回落 1x1 原点，不抛错', () => {
  assert.deepEqual(overlayWorkAreaBounds(null, SCREEN), { x: 0, y: 0, width: 1, height: 1 })
})
