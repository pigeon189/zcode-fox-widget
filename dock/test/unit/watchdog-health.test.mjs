// watchdog 健康探活判定的单测（第 1 轮审查意见 5）：
//   · shouldProbeHealth：启动宽限 / lock 未就绪（pid 不匹配、无端口）时不探活；
//   · trackUnhealthy：探活成功清零；失败累计 failMs 才杀，杀后重置。
// 这两个纯函数是 runWatchdog 内 5s 轮询 /health 的判定核心；daemon 卡死→
// SIGKILL 重启的端到端路径由 test/integration/daemon.itest.mjs 覆盖退出重启。

import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldProbeHealth, trackUnhealthy, parseWatchdogArgs, daemonArgsFor } from '../../daemon/src/watchdog.mjs'

const T0 = 1_800_000_000_000

test('shouldProbeHealth: 启动宽限内不探活', () => {
  const lock = { pid: 4321, port: 39401 }
  assert.equal(shouldProbeHealth({ now: T0, startedAt: T0, childPid: 4321, lock, graceMs: 15_000 }), false)
  assert.equal(shouldProbeHealth({ now: T0 + 14_999, startedAt: T0, childPid: 4321, lock, graceMs: 15_000 }), false)
  assert.equal(shouldProbeHealth({ now: T0 + 15_000, startedAt: T0, childPid: 4321, lock, graceMs: 15_000 }), true)
})

test('shouldProbeHealth: lock 缺失 / pid 不匹配 / 无端口时不探活', () => {
  const now = T0 + 60_000
  const startedAt = T0
  assert.equal(shouldProbeHealth({ now, startedAt, childPid: 4321, lock: null }), false)
  assert.equal(shouldProbeHealth({ now, startedAt, childPid: 4321, lock: { pid: 9999, port: 39401 } }), false)
  assert.equal(shouldProbeHealth({ now, startedAt, childPid: 4321, lock: { pid: 4321 } }), false)
  assert.equal(shouldProbeHealth({ now, startedAt, childPid: 4321, lock: { pid: '4321', port: 39401 } }), true, 'lock.pid 是字符串数字也应匹配')
})

test('trackUnhealthy: 探活成功清零失败累计', () => {
  assert.deepEqual(trackUnhealthy({ now: T0, unhealthySince: T0 - 30_000, probeOk: true }), {
    unhealthySince: 0,
    kill: false,
  })
})

test('trackUnhealthy: 失败先记起点，未到 failMs 不杀', () => {
  assert.deepEqual(trackUnhealthy({ now: T0, unhealthySince: 0, probeOk: false, failMs: 60_000 }), {
    unhealthySince: T0,
    kill: false,
  })
  assert.deepEqual(trackUnhealthy({ now: T0 + 59_999, unhealthySince: T0, probeOk: false, failMs: 60_000 }), {
    unhealthySince: T0,
    kill: false,
  })
})

test('trackUnhealthy: 连续失败累计达 failMs 才杀', () => {
  assert.deepEqual(trackUnhealthy({ now: T0 + 60_000, unhealthySince: T0, probeOk: false, failMs: 60_000 }), {
    unhealthySince: T0,
    kill: true,
  })
  // 杀后调用方重置 unhealthySince=0：下一次失败从新起点重新计
  assert.deepEqual(trackUnhealthy({ now: T0 + 65_000, unhealthySince: 0, probeOk: false, failMs: 60_000 }), {
    unhealthySince: T0 + 65_000,
    kill: false,
  })
})

test('trackUnhealthy: 中途成功会打断连续失败窗口', () => {
  let s = 0
  let r = trackUnhealthy({ now: T0, unhealthySince: s, probeOk: false, failMs: 60_000 })
  s = r.unhealthySince
  r = trackUnhealthy({ now: T0 + 30_000, unhealthySince: s, probeOk: true, failMs: 60_000 })
  s = r.unhealthySince
  assert.equal(s, 0)
  r = trackUnhealthy({ now: T0 + 80_000, unhealthySince: s, probeOk: false, failMs: 60_000 })
  assert.equal(r.kill, false, '成功清零后重新累计，不能把旧窗口叠加成 80s')
  s = r.unhealthySince
  r = trackUnhealthy({ now: T0 + 80_000 + 60_000, unhealthySince: s, probeOk: false, failMs: 60_000 })
  assert.equal(r.kill, true)
})

test('parseWatchdogArgs / daemonArgsFor: 回归（探活重构不应动到参数层）', () => {
  const opts = parseWatchdogArgs(['--data-dir', 'D:\\d', '--port', '39500', '--once'])
  assert.equal(opts.dataDir, 'D:\\d')
  assert.equal(opts.port, '39500')
  assert.equal(opts.once, true)
  assert.equal(opts.bridge, true)
  assert.deepEqual(daemonArgsFor(opts).slice(1), ['--data-dir', 'D:\\d', '--port', '39500'])
})
