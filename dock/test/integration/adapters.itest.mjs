// 适配器接口（R4）：真服务 + 真 HTTP
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-adapters-'))
let daemon = null
let port = 0
let token = ''

async function waitHealth(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = readLock(path.join(dir, 'daemon.lock'))
    if (lock && lock.port && isProcessAlive(lock.pid)) {
      try {
        const res = await fetch('http://127.0.0.1:' + lock.port + '/health', { signal: AbortSignal.timeout(800) })
        const h = await res.json()
        if (h && h.ok) return { lock, health: h }
      } catch (err) {}
    }
    await sleep(150)
  }
  return null
}

const get = async (p) => {
  const res = await fetch('http://127.0.0.1:' + port + p)
  return { status: res.status, body: await res.json() }
}

const post = async (p, body) => {
  const res = await fetch('http://127.0.0.1:' + port + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

before(async () => {
  daemon = spawn(process.execPath, [DAEMON, '--data-dir', dir, '--port', '0'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  const started = await waitHealth()
  assert.ok(started, 'daemon did not become healthy')
  port = started.health.port
  token = started.lock.token
})

after(async () => {
  try {
    await fetch('http://127.0.0.1:' + port + '/shutdown', {
      method: 'POST',
      headers: { 'x-fox-token': token },
    })
  } catch (err) {}
  try {
    daemon.kill()
  } catch (err) {}
  await sleep(200)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('/adapters：列出内置适配器，字段可 JSON 序列化', async () => {
  const { status, body } = await get('/adapters')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.adapters))
  const generic = body.adapters.find((a) => a.id === 'generic')
  assert.ok(generic, 'generic adapter missing')
  assert.equal(generic.billing, false)
  assert.equal(generic.fallback, true)
  // 描述里不能有函数（否则 HTTP 序列化会丢字段而不是报错）
  assert.equal(typeof JSON.parse(JSON.stringify(generic)).id, 'string')
})

test('/resolve：未知进程回落到 generic（fallback:true）', async () => {
  const { status, body } = await get('/resolve?exe=' + encodeURIComponent('C:\\Windows\\notepad.exe') + '&title=hello')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.adapter.id, 'generic')
  assert.equal(body.adapter.fallback, true)
  assert.equal(body.adapter.capabilities.billing, false)
})

test('/bind：适配器由服务端判定，忽略客户端乱传的 adapterId', async () => {
  const win = {
    exe: 'C:\\Windows\\notepad.exe',
    pid: 4321,
    startMs: Date.now() - 5000,
    hwnd: 'abc123',
    title: '未接入的窗口',
    cls: 'Notepad',
    rect: { x: 10, y: 20, w: 300, h: 200 },
    adapterId: 'zcode', // 客户端谎报
  }
  const { status, body } = await post('/bind', win)
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.binding.adapterId, 'generic')
  assert.equal(body.binding.adapterHint, 'zcode')
  assert.equal(body.adapter.id, 'generic')
  assert.equal(body.binding.window.startMs, win.startMs)
})

test('/billing：generic 绑定返回 supported:false，且不编造数值', async () => {
  const list = await get('/bindings')
  const key = list.body.bindings[0].key
  const { status, body } = await get('/billing?key=' + encodeURIComponent(key))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.bindingKey, key)
  assert.equal(body.snapshot.supported, false)
  assert.equal(body.snapshot.today, null)
  assert.equal(body.snapshot.unit, null)
})

test('/billing：未知 key 返回 404；缺字段的 /bind 返回 400', async () => {
  assert.equal((await get('/billing?key=nope')).status, 404)
  const bad = await post('/bind', { exe: 'C:\\a\\b.exe' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.ok, false)
})
