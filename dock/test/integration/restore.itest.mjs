// 浮层重启后恢复绑定（R10）：真 Electron + 真服务
//
// 不需要假 agent：随便挑一个当前存在的窗口绑定（只要 hwnd 还能读到 rect），
// 验证「关掉浮层再开，狐狸自己回到那个窗口」。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessAlive, readLock } from '../../daemon/src/lock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCK = path.join(HERE, '..', '..')
const DAEMON = path.join(DOCK, 'daemon', 'src', 'daemon.mjs')
const OVERLAY = path.join(DOCK, 'overlay')

function electronBinary() {
  const candidates = [
    process.env.FOX_DOCK_ELECTRON,
    path.join(os.homedir(), '.zcode', 'whale', 'desktop-runtime', 'node_modules', 'electron', 'dist', 'electron.exe'),
  ].filter(Boolean)
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch (err) {
      return false
    }
  })
}

const ELECTRON = process.platform === 'win32' ? electronBinary() : null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function electronEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      last = err
    }
    await sleep(150)
  }
  throw new Error('timeout: ' + label + (last ? '（' + last.message + '）' : ''))
}

class Cdp {
  constructor(url) {
    this.id = 0
    this.pending = new Map()
    this.ws = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('ws error'))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id || !this.pending.has(msg.id)) return
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'cdp error'))
      else p.resolve(msg.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || 'exception'))
    return r.result.value
  }
  close() {
    try {
      this.ws.close()
    } catch (err) {}
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-restore-'))
let daemon = null
let overlay = null
let port = 0
let token = ''
let bindingKey = ''

async function waitHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = readLock(path.join(dir, 'daemon.lock'))
    if (lock && lock.port && isProcessAlive(lock.pid)) {
      try {
        const h = await (await fetch('http://127.0.0.1:' + lock.port + '/health', { signal: AbortSignal.timeout(700) })).json()
        if (h && h.ok) return { lock, health: h }
      } catch (err) {}
    }
    await sleep(150)
  }
  return null
}

async function startOverlay(debugPort) {
  const child = spawn(
    ELECTRON,
    [OVERLAY, '--no-sandbox', '--disable-gpu', '--no-click-through', '--daemon-port=' + port, '--remote-debugging-port=' + debugPort],
    { stdio: ['ignore', 'ignore', 'pipe'], env: electronEnv() }
  )
  let err = ''
  child.stderr.on('data', (d) => {
    err += String(d)
  })
  const page = await waitFor(
    async () => {
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)
      if (!m) return null
      const list = await (await fetch('http://127.0.0.1:' + m[1] + '/json/list')).json()
      return list.find((x) => x.type === 'page' && /index\.html/.test(x.url)) || null
    },
    15000,
    'overlay page'
  )
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await waitFor(async () => !!(await cdp.eval("!!document.getElementById('fox')")), 10000, 'overlay dom')
  return { child, cdp }
}

before(async () => {
  if (!ELECTRON) return
  daemon = spawn(process.execPath, [DAEMON, '--data-dir', dir, '--port', '0'], { stdio: 'ignore', windowsHide: true })
  const started = await waitHealth()
  assert.ok(started, 'daemon did not become healthy')
  port = started.health.port
  token = started.lock.token

  // 找一个当前存在、hwnd/rect 可读的窗口来绑定
  const w = await (await fetch('http://127.0.0.1:' + port + '/windows')).json()
  const target = (w.windows || []).find((x) => x.hwnd && x.rect && x.rect.w > 100 && x.rect.h > 100 && x.pid !== process.pid)
  assert.ok(target, 'no usable window to bind')
  const r = await (
    await fetch('http://127.0.0.1:' + port + '/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exe: target.exe,
        pid: target.pid,
        startMs: target.startMs,
        hwnd: target.hwnd,
        title: target.title,
        rect: target.rect,
      }),
    })
  ).json()
  assert.equal(r.ok, true, JSON.stringify(r.body || r))
  bindingKey = r.binding.key
})

after(async () => {
  if (overlay) {
    try {
      overlay.cdp.close()
      overlay.child.kill()
    } catch (err) {}
  }
  try {
    await fetch('http://127.0.0.1:' + port + '/shutdown', { method: 'POST', headers: { 'x-fox-token': token } })
  } catch (err) {}
  try {
    daemon.kill()
  } catch (err) {}
  await sleep(300)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('overlay: 启动时恢复上次绑定', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')
  overlay = await startOverlay(9411)
  const got = await waitFor(
    async () => {
      const v = await overlay.cdp.eval(
        "JSON.stringify({restored:document.body.dataset.restored||'',key:document.body.dataset.boundKey||'',chipHidden:document.getElementById('chip').hidden})"
      )
      const o = JSON.parse(v)
      return o.restored === '1' && o.key ? o : null
    },
    10000,
    'binding restored'
  )
  assert.equal(got.key, bindingKey)
  assert.equal(got.chipHidden, false)
})

test('overlay: 关掉再开仍然恢复（不依赖上一次进程）', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')
  overlay.cdp.close()
  overlay.child.kill()
  await waitFor(async () => !isProcessAlive(overlay.child.pid), 8000, 'overlay exited')

  overlay = await startOverlay(9412)
  const got = await waitFor(
    async () => {
      const v = await overlay.cdp.eval("document.body.dataset.restored === '1' ? document.body.dataset.boundKey : ''")
      return v || null
    },
    10000,
    'binding restored again'
  )
  assert.equal(got, bindingKey)
})
