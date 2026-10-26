import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { acquireLock, isProcessAlive, readLock, releaseLock, updateLock } from '../../daemon/src/lock.mjs'

const dirs = []
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-lock-'))
  dirs.push(dir)
  return dir
}

after(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch (err) {}
  }
})

test('lock: 首次获取成功，读回字段一致', () => {
  const dir = tempDir()
  const file = path.join(dir, 'daemon.lock')
  const r = acquireLock(file, { pid: process.pid, port: 39401, token: 'abc' })
  assert.equal(r.ok, true)
  const cur = readLock(file)
  assert.equal(cur.pid, process.pid)
  assert.equal(cur.port, 39401)
  assert.equal(cur.token, 'abc')
  assert.ok(cur.at > 0)
})

test('lock: 同进程重复获取视为接管（不死锁）', () => {
  const dir = tempDir()
  const file = path.join(dir, 'daemon.lock')
  acquireLock(file, { pid: process.pid })
  const again = acquireLock(file, { pid: process.pid, port: 39402 })
  assert.equal(again.ok, true)
  assert.equal(readLock(file).port, 39402)
})

test('lock: 活着的其它进程持有 → 拒绝并返回 holder', () => {
  const dir = tempDir()
  const file = path.join(dir, 'daemon.lock')
  // 起一个确定存活、且不删锁的子进程当“别人”
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: holder.pid, at: Date.now() }))
    const r = acquireLock(file, { pid: 999999 })
    assert.equal(r.ok, false)
    assert.equal(r.holder.pid, holder.pid)
  } finally {
    holder.kill()
  }
})

test('lock: 陈旧锁（进程不存在）可接管', () => {
  const dir = tempDir()
  const file = path.join(dir, 'daemon.lock')
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, at: Date.now() - 60000 }))
  const r = acquireLock(file, { pid: process.pid, port: 39403 })
  assert.equal(r.ok, true)
  assert.equal(r.tookOver, true)
  assert.equal(readLock(file).pid, process.pid)
})

test('lock: 损坏文件视为陈旧锁', () => {
  const dir = tempDir()
  const file = path.join(dir, 'daemon.lock')
  fs.writeFileSync(file, '{not json')
  const r = acquireLock(file, { pid: process.pid })
  assert.equal(r.ok, true)
})

test('lock: updateLock 合并字段；releaseLock 只删自己的', () => {
  const dir = tempDir()
  const file = path.join(dir, 'daemon.lock')
  acquireLock(file, { pid: process.pid, token: 't1' })
  updateLock(file, { port: 39404 })
  assert.equal(readLock(file).token, 't1')
  assert.equal(readLock(file).port, 39404)
  assert.equal(releaseLock(file, 123456), false)
  assert.ok(readLock(file))
  assert.equal(releaseLock(file, process.pid), true)
  assert.equal(readLock(file), null)
})

test('lock: isProcessAlive 自身为真，不存在的 pid 为假', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(999999), false)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive('abc'), false)
})
