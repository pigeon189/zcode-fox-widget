import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCK = path.join(HERE, '..', '..')
const DAEMON = path.join(DOCK, 'daemon', 'src', 'daemon.mjs')
const OVERLAY = path.join(DOCK, 'overlay')
const FAKE_AGENT = path.join(DOCK, 'test', 'fixtures', 'fake-agent')

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

// agent shell 会带 ELECTRON_RUN_AS_NODE=1，让 electron 当 node 跑；必须剥掉。
function electronEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function json(url, options) {
  const res = await fetch(url, options)
  return res.json()
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
  throw new Error('timeout: ' + label + (last ? ' (' + last.message + ')' : ''))
}

class Cdp {
  constructor(url) {
    this.id = 0
    this.pending = new Map()
    this.ws = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = (e) => reject(new Error('ws error'))
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
    return r.result.value
  }

  close() {
    try {
      this.ws.close()
    } catch (err) {}
  }
}

const dir = tempDir('fox-dock-overlay-')
let daemon = null
let fake = null
let overlay = null
let cdp = null
let fakeCdp = null
let port = 0
let fakeWin = null
let binding = null
let geo = null

before(async (t) => {
  if (!ELECTRON) {
    t.skip('electron binary not found (set FOX_DOCK_ELECTRON)')
    return
  }

  daemon = spawn(process.execPath, [DAEMON, '--data-dir', dir, '--port', '0'], { stdio: 'ignore', windowsHide: true })
  const health = await waitFor(
    async () => {
      const lockFile = path.join(dir, 'daemon.lock')
      if (!fs.existsSync(lockFile)) return null
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (!lock.port) return null
      const h = await json('http://127.0.0.1:' + lock.port + '/health').catch(() => null)
      return h && h.ok ? { h, lock } : null
    },
    25000,
    'daemon health'
  )
  port = health.h.port

  fake = spawn(ELECTRON, [FAKE_AGENT, '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: electronEnv(),
  })
  let fakeErr = ''
  fake.stderr.on('data', (d) => {
    fakeErr += String(d)
  })
  let lastTitles = []
  fakeWin = await waitFor(async () => {
    const w = await json('http://127.0.0.1:' + port + '/windows')
    lastTitles = (w.windows || []).map((x) => x.title + '#' + x.pid).filter(Boolean)
    return (w.windows || []).find((x) => x.title === 'FakeAgent') || null
  }, 20000, 'fake agent window').catch((err) => {
    throw new Error(err.message + ' | fake.pid=' + fake.pid + ' alive=' + !fake.killed + ' | windows=' + JSON.stringify(lastTitles))
  })

  const fakeDevPort = await waitFor(async () => {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(fakeErr)
    return m ? Number(m[1]) : null
  }, 15000, 'fake devtools port')
  const fakeTarget = await waitFor(async () => {
    const list = await json('http://127.0.0.1:' + fakeDevPort + '/json/list').catch(() => [])
    return list.find((x) => x.type === 'page' && /fake-agent\/index\.html|FakeAgent/i.test(x.url)) || null
  }, 15000, 'fake page target')
  fakeCdp = new Cdp(fakeTarget.webSocketDebuggerUrl)
  await fakeCdp.ready
  await fakeCdp.send('Runtime.enable')

  // 桌面上还跑着用户自己的挂件浮层（全屏置顶）：它会把命中吃掉。
  // 用 ignore 列表排掉，规则与产品里的「忽略窗口」一致。
  const all = await json('http://127.0.0.1:' + port + '/windows')
  const otherOverlay = (all.windows || []).find((w) => /小挂件/.test(w.title || '') && /electron\.exe$/i.test(w.exe || ''))
  const ignoreArg = otherOverlay ? '--ignore-pids=' + otherOverlay.pid : '--ignore-pids='

  overlay = spawn(
    ELECTRON,
    [OVERLAY, '--no-sandbox', '--disable-gpu', '--no-click-through', ignoreArg, '--daemon-port=' + port, '--remote-debugging-port=0'],
    { stdio: ['ignore', 'ignore', 'pipe'], env: electronEnv() }
  )
  let stderr = ''
  overlay.stderr.on('data', (d) => {
    stderr += String(d)
  })

  const devPort = await waitFor(async () => {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)
    return m ? Number(m[1]) : null
  }, 20000, 'devtools port')

  const target = await waitFor(async () => {
    const list = await json('http://127.0.0.1:' + devPort + '/json/list').catch(() => [])
    return list.find((x) => x.type === 'page' && x.url.includes('index.html')) || null
  }, 15000, 'overlay page target')

  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await waitFor(async () => cdp.eval("document.readyState === 'complete' && !!document.getElementById('fox')"), 15000, 'overlay ready')

  geo = JSON.parse(
    await cdp.eval(
      "(function(){var r=document.getElementById('fox').getBoundingClientRect();" +
        'return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,sx:window.screenX,sy:window.screenY})})()'
    )
  )
})

after(() => {
  if (fakeCdp) fakeCdp.close()
  for (const p of [overlay, fake, daemon]) {
    try {
      if (p) p.kill()
    } catch (err) {}
  }
  if (cdp) cdp.close()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('drag: 从狐狸拖到宿主窗口中心 → 绑定该窗口并吸附到右上角', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const targetX = fakeWin.rect.x + Math.floor(fakeWin.rect.w / 2) - geo.sx
  const targetY = fakeWin.rect.y + Math.floor(fakeWin.rect.h / 2) - geo.sy

  // 先确认这个点确实命中的是假窗口：桌面上别的窗口盖住它时，后面会绑错对象，
  // 失败信息会变成「binding created 超时」，看不出真正原因。
  const hitAtCenter = await json(
    'http://127.0.0.1:' + port + '/hit?x=' + (fakeWin.rect.x + Math.floor(fakeWin.rect.w / 2)) +
      '&y=' + (fakeWin.rect.y + Math.floor(fakeWin.rect.h / 2)) + '&exclude=' + overlay.pid
  )
  const topHit = (hitAtCenter.hits || [])[0]
  assert.ok(topHit, 'no window under fake agent center')
  assert.equal(topHit.pid, fakeWin.pid, 'fake agent should be the topmost window at its center, got ' + JSON.stringify(topHit))

  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', buttons: 1, clickCount: 1 })
  const steps = 6
  for (let i = 1; i <= steps; i++) {
    const x = geo.x + ((targetX - geo.x) * i) / steps
    const y = geo.y + ((targetY - geo.y) * i) / steps
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await sleep(40)
  }
  // 落点再补一次 move 并多等一会儿：最后一次命中采样是异步的，
  // 机器忙时 120ms 可能还没回来，指针已经松开 → 绑到上一帧的窗口（实测偶发）。
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: targetY, button: 'left', buttons: 1 })
  await sleep(250)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y: targetY, button: 'left', buttons: 0, clickCount: 1 })

  binding = await waitFor(async () => {
    const r = await json('http://127.0.0.1:' + port + '/bindings')
    return (r.bindings || []).find((b) => b.window && b.window.pid === fakeWin.pid) || null
  }, 8000, 'binding created')

  assert.equal(binding.window.hwnd, fakeWin.hwnd)
  assert.match(binding.key, new RegExp('\\|' + fakeWin.pid + '\\|'))
  assert.equal(binding.adapterId, 'generic', '未识别的窗口应落到 generic')

  const boundKey = await cdp.eval('document.body.dataset.boundKey || ""')
  assert.equal(boundKey, binding.key)
})

test('chip: 绑定未接入窗口 → 显示「暂不支持计费」，不编造数字', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const chip = await waitFor(async () => {
    const raw = await cdp.eval(
      "(function(){var c=document.getElementById('chip');if(!c)return 'null';" +
        "return JSON.stringify({hidden:c.hidden,adapter:document.body.dataset.adapterId||''," +
        "text:(c.textContent||'').replace(/\\\\s+/g,' ').trim(),cls:c.className})})()"
    )
    const v = JSON.parse(raw)
    // 「读取中…」是绑定后、第一次 /billing 回来之前的中间态，不能当成最终结果
    return v && v.hidden === false && v.text && v.text.indexOf('读取中') === -1 ? v : null
  }, 8000, 'chip visible')

  assert.equal(chip.adapter, 'generic')
  assert.match(chip.text, /通用窗口/)
  assert.match(chip.text, /暂不支持计费/)
  assert.match(chip.cls, /muted/)
})

test('snap: 绑定后狐狸贴在窗口右上角（±30px）', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  await sleep(400) // 等吸附的 120ms 过渡结束
  const rect = await cdp.eval(
    "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,dpr:window.devicePixelRatio})})()"
  )
  const fox = JSON.parse(rect)
  const dpr = fox.dpr || 1
  const expectedX = (fakeWin.rect.x + fakeWin.rect.w) / dpr - geo.sx - 52 - 12
  const expectedY = fakeWin.rect.y / dpr + 12 - geo.sy
  assert.ok(Math.abs(fox.x - expectedX) <= 30, 'fox.x=' + fox.x + ' expected≈' + expectedX)
  assert.ok(Math.abs(fox.y - expectedY) <= 30, 'fox.y=' + fox.y + ' expected≈' + expectedY)
})

test('panel: 单击狐狸打开明细面板（不是拖拽），再点收起', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const pos = JSON.parse(
    await cdp.eval(
      "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()"
    )
  )

  const click = async () => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
  }

  await click()
  const opened = await waitFor(
    async () => (await cdp.eval("document.body.dataset.panel || ''")) === 'open',
    6000,
    'panel opened'
  )
  assert.ok(opened)
  const title = await cdp.eval("document.getElementById('panel-title').textContent")
  assert.ok(title && title.length > 0, JSON.stringify(title))
  const rows = Number(await cdp.eval("document.querySelectorAll('#panel-body .panel-row').length"))
  assert.ok(rows >= 1, 'panel should have at least one row, got ' + rows)

  // 再点一次收起
  await click()
  const closed = await waitFor(
    async () => (await cdp.eval("document.body.dataset.panel || ''")) === 'closed',
    6000,
    'panel closed'
  )
  assert.ok(closed)
})

test('reanchor: 宿主窗口移动后狐狸跟随（500ms 轮询）', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const before = (await json('http://127.0.0.1:' + port + '/windows')).windows.find((x) => x.pid === fakeWin.pid)
  const dpr = Number(await cdp.eval('window.devicePixelRatio')) || 1
  // window.moveTo 用 CSS 像素；桥读回来是物理像素
  await fakeCdp.eval('window.moveTo(' + (before.rect.x / dpr + 60) + ',' + (before.rect.y / dpr + 40) + ')')

  const dx = 60 * dpr
  const moved = await waitFor(async () => {
    const w = (await json('http://127.0.0.1:' + port + '/windows')).windows.find((x) => x.pid === fakeWin.pid)
    return w && Math.abs(w.rect.x - (before.rect.x + dx)) <= 8 ? w : null
  }, 8000, 'fake window moved')

  const fox = await waitFor(async () => {
    const r = JSON.parse(
      await cdp.eval(
        "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y})})()"
      )
    )
    const expectedX = (moved.rect.x + moved.rect.w) / dpr - geo.sx - 52 - 12
    return Math.abs(r.x - expectedX) <= 30 ? r : null
  }, 8000, 'fox re-anchored')

  assert.ok(fox)
  fakeWin = moved
})

test('panel: 「解绑这个窗口」清掉绑定并收起面板', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const before = await (await fetch('http://127.0.0.1:' + port + '/bindings')).json()
  const mine = (before.bindings || []).find((b) => b.window && b.window.pid === fakeWin.pid)
  assert.ok(mine, 'binding should exist before unbind')

  const pos = JSON.parse(
    await cdp.eval(
      "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()"
    )
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(50)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
  await waitFor(async () => (await cdp.eval("document.body.dataset.panel || ''")) === 'open', 6000, 'panel open')

  const clicked = await cdp.eval(
    "(function(){var bs=document.querySelectorAll('#panel button');" +
      "for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('解绑这个窗口')!==-1){bs[i].click();return true}}return false})()"
  )
  assert.equal(clicked, true, 'unbind button should exist when bound')

  const gone = await waitFor(
    async () => {
      const r = await (await fetch('http://127.0.0.1:' + port + '/bindings')).json()
      return (r.bindings || []).some((b) => b.key === mine.key) ? null : true
    },
    6000,
    'binding removed'
  )
  assert.ok(gone)
  const closed = await waitFor(async () => (await cdp.eval("document.body.dataset.panel || ''")) === 'closed', 6000, 'panel closed')
  assert.ok(closed)
})
