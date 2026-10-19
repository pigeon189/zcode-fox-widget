import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessAlive, readLock } from '../../daemon/src/lock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(HERE, '..', '..', 'daemon', 'src', 'daemon.mjs')
const WATCHDOG = path.join(HERE, '..', '..', 'daemon', 'src', 'watchdog.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function healthOf(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1000) })
    return await res.json()
  } catch (err) {
    return null
  }
}

async function waitHealth(dir, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = readLock(path.join(dir, 'daemon.lock'))
    if (lock && lock.port && isProcessAlive(lock.pid)) {
      const h = await healthOf(lock.port)
      if (h && h.ok) return { lock, health: h }
    }
    await sleep(150)
  }
  return null
}

function spawnDaemon(dir, extra = []) {
  return spawn(process.execPath, [DAEMON, '--data-dir', dir, '--port', '0', ...extra], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

const dir = tempDir('fox-dock-daemon-')
let daemon = null
let started = null

before(async () => {
  daemon = spawnDaemon(dir)
  started = await waitHealth(dir)
  assert.ok(started, 'daemon did not become healthy')
})

after(() => {
  try {
    if (daemon && !daemon.killed) daemon.kill()
  } catch (err) {}
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('daemon: /health 返回版本、端口、桥状态', () => {
  assert.equal(started.health.app, 'fox-dock')
  assert.ok(started.health.pid > 0)
  assert.ok(started.health.port > 0)
  assert.equal(started.health.bridgeReady, true)
  assert.match(started.health.version, /^\d+\.\d+\.\d+/)
})

test('daemon: /windows /cursor /hit 可用', async () => {
  const base = 'http://127.0.0.1:' + started.health.port
  const w = await (await fetch(base + '/windows')).json()
  assert.equal(w.ok, true)
  assert.ok(Array.isArray(w.windows) && w.windows.length > 0)
  const c = await (await fetch(base + '/cursor')).json()
  assert.equal(c.ok, true)
  const h = await (await fetch(base + '/hit?x=' + c.x + '&y=' + c.y)).json()
  assert.equal(h.ok, true)
  assert.ok(Array.isArray(h.hits))
})

test('daemon: 第二个实例以退出码 2 结束', async () => {
  const second = spawnDaemon(dir)
  const code = await new Promise((resolve) => {
    second.once('exit', (c) => resolve(c))
    setTimeout(() => resolve('timeout'), 15000)
  })
  assert.equal(code, 2)
  // 原实例不受影响
  const h = await healthOf(started.health.port)
  assert.ok(h && h.ok)
})

test('daemon: /shutdown 需要令牌，带令牌后干净退出且释放锁', async () => {
  const base = 'http://127.0.0.1:' + started.health.port
  const bad = await fetch(base + '/shutdown', { method: 'POST', headers: { 'x-fox-token': 'wrong' } })
  assert.equal(bad.status, 403)

  const res = await fetch(base + '/shutdown', {
    method: 'POST',
    headers: { 'x-fox-token': started.lock.token },
  })
  assert.equal(res.status, 200)
  const code = await new Promise((resolve) => daemon.once('exit', (c) => resolve(c)))
  assert.equal(code, 0)
  assert.equal(readLock(path.join(dir, 'daemon.lock')), null)
})

test('watchdog: daemon 被强杀后自动拉起，正常停止后一起退出', async () => {
  const wdir = tempDir('fox-dock-watchdog-')
  const wd = spawn(process.execPath, [WATCHDOG, '--data-dir', wdir, '--port', '0', '--restart-delay', '200'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    const first = await waitHealth(wdir)
    assert.ok(first, 'watchdog did not bring the daemon up')
    const firstPid = first.health.pid

    process.kill(firstPid, 'SIGKILL')
    // 等 watchdog 拉起新实例（pid 必须变化）
    let second = null
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const h = await waitHealth(wdir, 1500)
      if (h && h.health.pid !== firstPid) {
        second = h
        break
      }
      await sleep(150)
    }
    assert.ok(second, 'watchdog did not restart the daemon')
    assert.notEqual(second.health.pid, firstPid)

    // 正常停止 → daemon 退出 0 → watchdog 随之退出
    await fetch('http://127.0.0.1:' + second.health.port + '/shutdown', {
      method: 'POST',
      headers: { 'x-fox-token': second.lock.token },
    })
    const wdCode = await new Promise((resolve) => {
      wd.once('exit', (c) => resolve(c))
      setTimeout(() => resolve('timeout'), 8000)
    })
    assert.equal(wdCode, 0)
  } finally {
    try {
      wd.kill()
    } catch (err) {}
    try {
      fs.rmSync(wdir, { recursive: true, force: true })
    } catch (err) {}
  }
})

test('watchdog: 连续 8 次强杀都能拉起，绑定不丢', async () => {
  const wdir = tempDir('fox-dock-crash-')
  const wd = spawn(process.execPath, [WATCHDOG, '--data-dir', wdir, '--port', '0', '--restart-delay', '150'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    let cur = await waitHealth(wdir)
    assert.ok(cur, 'watchdog did not start')

    // 先写一条绑定，验证反复崩溃不丢数据
    const key = 'c:/x/fake.exe|1|1700000000000|abc'
    await fetch('http://127.0.0.1:' + cur.health.port + '/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fox-token': cur.lock.token },
      body: JSON.stringify({
        exe: 'C://x//fake.exe',
        pid: 1,
        startMs: 1700000000000,
        hwnd: 'abc',
        title: 'crash-test',
      }),
    })

    const pids = [cur.health.pid]
    for (let i = 0; i < 8; i++) {
      process.kill(cur.health.pid, 'SIGKILL')
      const deadline = Date.now() + 15000
      let next = null
      while (Date.now() < deadline) {
        const h = await waitHealth(wdir, 1200)
        if (h && h.health.pid !== cur.health.pid) {
          next = h
          break
        }
        await sleep(120)
      }
      assert.ok(next, 'restart #' + (i + 1) + ' failed')
      cur = next
      pids.push(cur.health.pid)
    }

    assert.equal(new Set(pids).size, pids.length, 'pid should change on every restart')
    const binds = await (await fetch('http://127.0.0.1:' + cur.health.port + '/bindings')).json()
    assert.ok(
      (binds.bindings || []).some((b) => b.key === key),
      'binding should survive 8 crashes'
    )

    await fetch('http://127.0.0.1:' + cur.health.port + '/shutdown', {
      method: 'POST',
      headers: { 'x-fox-token': cur.lock.token },
    })
    const code = await new Promise((resolve) => {
      wd.once('exit', (c) => resolve(c))
      setTimeout(() => resolve('timeout'), 8000)
    })
    assert.equal(code, 0)
  } finally {
    try {
      wd.kill()
    } catch (err) {}
    try {
      fs.rmSync(wdir, { recursive: true, force: true })
    } catch (err) {}
  }
})
