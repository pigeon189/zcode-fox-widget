import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessAlive, readLock } from '../../daemon/src/lock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', '..', 'tools', 'fox-dock.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-ensure-'))

function runEnsure(extra = [], env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [CLI, 'ensure', '--data-dir', dir, ...extra], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FOX_DOCK_PORT: '0', ...env },
    })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (err) {}
      resolve({ code: 'timeout', ms: Date.now() - t0, stderr })
    }, 15000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, ms: Date.now() - t0, stderr })
    })
  })
}

async function health() {
  const lock = readLock(path.join(dir, 'daemon.lock'))
  if (!lock || !lock.port || !isProcessAlive(lock.pid)) return null
  try {
    const res = await fetch('http://127.0.0.1:' + lock.port + '/health', { signal: AbortSignal.timeout(1000) })
    return res.ok ? await res.json() : null
  } catch (err) {
    return null
  }
}

after(async () => {
  const lock = readLock(path.join(dir, 'daemon.lock'))
  if (lock && lock.port) {
    try {
      await fetch('http://127.0.0.1:' + lock.port + '/shutdown', {
        method: 'POST',
        headers: { 'x-fox-token': lock.token },
        signal: AbortSignal.timeout(2000),
      })
    } catch (err) {}
  }
  await sleep(400)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('ensure: daemon 不在线时拉起，重复调用幂等且快速返回', async () => {
  const first = await runEnsure(['--no-overlay'])
  assert.equal(first.code, 0, first.stderr)
  const h = await health()
  assert.ok(h && h.ok, 'daemon 必须在线')
  const lock = readLock(path.join(dir, 'daemon.lock'))

  const second = await runEnsure(['--no-overlay'])
  assert.equal(second.code, 0, second.stderr)
  assert.ok(second.ms < 3000, '在线时 ensure 必须快速返回（实测 ' + second.ms + 'ms）')
  const lock2 = readLock(path.join(dir, 'daemon.lock'))
  assert.equal(lock2.pid, lock.pid, '不能起第二个 daemon')
})
