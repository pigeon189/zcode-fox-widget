// 浮层进程识别：自己的按端口认，别人的「小挂件」不能误杀。
import assert from 'node:assert/strict'
import test from 'node:test'
import { foxDockOverlayPidsOf, overlayPidsOf } from '../../daemon/src/electron.mjs'

const win = (title, pid, exe = 'C:\\electron\\electron.exe') => ({ title, pid, exe })

test('foxDockOverlayPidsOf：只认自己的标题与端口', () => {
  const windows = [
    win('fox-dock overlay 39401', 11),
    win('fox-dock overlay 39402', 12),
    win('fox-dock overlay', 13),
    win('WorkBuddy狐娘小挂件', 14),
    win('ZCode狐娘小挂件', 15),
    win('fox-dock overlay 39401', 16, 'C:\\Other\\app.exe'),
  ]
  assert.deepEqual(foxDockOverlayPidsOf(windows, 39401), [11])
  assert.deepEqual(foxDockOverlayPidsOf(windows, 39402), [12])
  // 没有端口时不挑端口，但仍不认别的挂件
  assert.deepEqual(foxDockOverlayPidsOf(windows), [11, 12, 13])
})

test('overlayPidsOf：命中排除仍然包含所有挂件浮层', () => {
  const windows = [
    win('fox-dock overlay 39401', 11),
    win('WorkBuddy狐娘小挂件', 14),
    win('普通窗口', 15),
  ]
  assert.deepEqual(overlayPidsOf(windows), [11, 14])
})
