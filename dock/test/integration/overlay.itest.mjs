// 宠物层 2.0 集成测试：真 daemon + 真 Electron + 假 agent 窗口。
//
// 覆盖：启动渲染、单击快览、拖拽吸附、四象限贴边/镜像、拖到桌面悬浮、
// 设置轮询、气泡队列、菜单换角色、解除吸附重置。

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed')
    return r.result && r.result.value
  }
}

let daemon = null
let fake = null
let overlay = null
let cdp = null
let fakeCdp = null
let fakeWin = null
let port = 0
let token = ''
let dir = ''

async function mouse(cdpConn, x, y, button = 'left') {
  await cdpConn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: 1, clickCount: 1 })
  await sleep(40)
  await cdpConn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 })
}

async function dragTo(toX, toY) {
  const from = JSON.parse(
    await cdp.eval(
      "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()"
    )
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  const steps = 6
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((toX - from.x) * i) / steps,
      y: from.y + ((toY - from.y) * i) / steps,
      button: 'left',
      buttons: 1,
    })
    await sleep(40)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toX, y: toY, button: 'left', buttons: 1 })
  await sleep(300)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(500)
}

before(async (t) => {
  if (!ELECTRON) {
    t.skip('electron binary not found (set FOX_DOCK_ELECTRON)')
    return
  }
  dir = tempDir('fox-pet-')
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
  token = health.lock.token

  fake = spawn(ELECTRON, [FAKE_AGENT, '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: electronEnv(),
  })
  let fakeErr = ''
  fake.stderr.on('data', (d) => (fakeErr += String(d)))
  fakeWin = await waitFor(async () => {
    const w = await json('http://127.0.0.1:' + port + '/windows')
    return (w.windows || []).find((x) => x.title === 'FakeAgent') || null
  }, 20000, 'fake agent window')
  const fakeDevPort = await waitFor(async () => {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(fakeErr)
    return m ? Number(m[1]) : null
  }, 15000, 'fake devtools port')
  const fakeTarget = await waitFor(async () => {
    const list = await json('http://127.0.0.1:' + fakeDevPort + '/json/list').catch(() => [])
    return list.find((x) => x.type === 'page') || null
  }, 15000, 'fake page target')
  fakeCdp = new Cdp(fakeTarget.webSocketDebuggerUrl)
  await fakeCdp.ready
  await fakeCdp.send('Runtime.enable')

  // 测试环境里桌面被用户窗口覆盖：忽略除假 agent 外的所有窗口，才能验证「拖到空白」。
  const all = await json('http://127.0.0.1:' + port + '/windows')
  const ignore = [...new Set((all.windows || []).filter((w) => w.pid !== fakeWin.pid).map((w) => w.pid))].join(',')
  overlay = spawn(
    ELECTRON,
    [OVERLAY, '--no-sandbox', '--disable-gpu', '--no-click-through', '--ignore-pids=' + ignore, '--daemon-port=' + port, '--data-dir=' + dir, '--remote-debugging-port=0'],
    { stdio: ['ignore', 'ignore', 'pipe'], env: electronEnv() }
  )
  let stderr = ''
  overlay.stderr.on('data', (d) => (stderr += String(d)))
  const devPort = await waitFor(async () => {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)
    return m ? Number(m[1]) : null
  }, 20000, 'overlay devtools port')
  const target = await waitFor(async () => {
    const list = await json('http://127.0.0.1:' + devPort + '/json/list').catch(() => [])
    return list.find((x) => x.type === 'page' && x.url.includes('index.html')) || null
  }, 15000, 'overlay page target')
  cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await waitFor(async () => (await cdp.eval("document.readyState==='complete' && !!window.__pet")), 15000, 'pet ready')
})

after(async () => {
  try {
    await fetch('http://127.0.0.1:' + port + '/shutdown', { method: 'POST', headers: { 'x-fox-token': token } })
  } catch (err) {}
  for (const p of [overlay, fake, daemon]) {
    try {
      if (p) p.kill()
    } catch (err) {}
  }
  await sleep(300)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('pet: 启动后显示角色，胶囊默认隐藏', async () => {
  assert.equal(await cdp.eval("!!document.getElementById('fox-img')"), true)
  assert.match(await cdp.eval("document.getElementById('fox-img').src"), /roles\/fox\.png/)
  assert.equal(await cdp.eval("document.getElementById('chip').hidden"), true)
})

test('pet: 单击角色打开快览卡，再点收起', async () => {
  const c = JSON.parse(
    await cdp.eval("(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()")
  )
  await mouse(cdp, c.x, c.y)
  await waitFor(async () => (await cdp.eval("!document.getElementById('quick').hidden")), 4000, 'quick open')
  await sleep(300)
  await mouse(cdp, c.x, c.y)
  try {
    await waitFor(async () => (await cdp.eval("document.getElementById('quick').hidden")), 2500, 'quick close')
  } catch (err) {
    await mouse(cdp, c.x, c.y)
    await waitFor(async () => (await cdp.eval("document.getElementById('quick').hidden")), 4000, 'quick close retry')
  }
})

test('pet: 拖到 agent 窗口吸附并显示胶囊', async () => {
  const target = async () => dragTo(fakeWin.rect.x + fakeWin.rect.w / 2, fakeWin.rect.y + fakeWin.rect.h / 2)
  await target()
  let st = null
  try {
    st = await waitFor(async () => {
      const s = await json('http://127.0.0.1:' + port + '/v1/state')
      return s.pet.mode === 'attached' ? s : null
    }, 5000, 'attached state')
  } catch (err) {
    await target()
    st = await waitFor(async () => {
      const s = await json('http://127.0.0.1:' + port + '/v1/state')
      return s.pet.mode === 'attached' ? s : null
    }, 8000, 'attached state retry')
  }
  assert.equal(st.pet.agentId, 'generic')
  await waitFor(async () => (await cdp.eval("!document.getElementById('chip').hidden")), 5000, 'chip visible')
  assert.match(await cdp.eval("document.getElementById('chip-value').textContent"), /—|¥|积分|%/)
  assert.equal(await cdp.eval('window.__pet.alphaMaskLoaded()'), true, '默认角色也要加载 alpha 掩码')
  const bindings = await (await fetch('http://127.0.0.1:' + port + '/v1/bindings')).json()
  assert.ok(bindings.bindings.length >= 1, 'attach 后应写入绑定表')
  assert.equal(await cdp.eval("typeof window.foxOverlay.getToken"), 'undefined', '渲染层不能拿到 token')
})

test('pet: 四象限贴边与左侧镜像', async () => {
  const out = JSON.parse(
    await cdp.eval(
      "(function(){" +
        "var a=window.__pet.debugAttach('zcode','dbg',{x:200,y:100,w:800,h:600},{h:'left',v:'top'});" +
        "var mirror=document.getElementById('fox').classList.contains('mirror');" +
        "var b=window.__pet.debugAttach('zcode','dbg',{x:200,y:100,w:800,h:600},{h:'right',v:'bottom'});" +
        "return JSON.stringify({left:a.pos.x,top:a.pos.y,mirror,right:b.pos.x,bottom:b.pos.y})})()"
    )
  )
  assert.ok(out.left <= 230 && out.top <= 130, JSON.stringify(out))
  assert.equal(out.mirror, true)
  assert.ok(out.right > out.left && out.bottom > out.top, JSON.stringify(out))
})

test('pet: 拖到桌面空白进入悬浮，保留角色', async () => {
  const geom = JSON.parse(await cdp.eval('JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})'))
  const left = fakeWin.rect.x / geom.dpr
  const bottom = (fakeWin.rect.y + fakeWin.rect.h) / geom.dpr
  const blank = left > 80 ? { x: 20, y: 20 } : bottom < geom.h - 60 ? { x: 20, y: geom.h - 30 } : { x: geom.w - 20, y: 20 }
  await dragTo(blank.x, blank.y)
  const st = await waitFor(async () => {
    const s = await json('http://127.0.0.1:' + port + '/v1/state')
    return s.pet.mode === 'floating' ? s : null
  }, 8000, 'floating state')
  assert.equal(st.pet.profileOf, 'generic')
  await waitFor(async () => (await cdp.eval("!document.getElementById('chip-unlink').hidden")), 4000, 'unlink')
  const pos = JSON.parse(await cdp.eval("(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y})})()"))
  assert.ok(Math.abs(pos.x - blank.x) < 140 && Math.abs(pos.y - blank.y) < 140, '落点不能被 follow 拉回：' + JSON.stringify({ pos, blank }))
})

test('pet: 控制台改设置后浮层 2 秒内生效（隐藏金额）', async () => {
  const put = async (body) =>
    fetch('http://127.0.0.1:' + port + '/v1/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
      body: JSON.stringify(body),
    })
  await put({ hideMoney: true })
  // 先验证轮询把设置同步进浮层，再用固定快照验证所有金额被掩码。
  await waitFor(async () => (await cdp.eval('window.__pet.settings.hideMoney')), 5000, 'settings poll')
  await cdp.eval(
    "window.__pet.setSnapshot({ok:true,supported:true,unit:'money',today:{amount:12.34,currency:'CNY'},turn:{amount:0.28,currency:'CNY'}});" +
      "window.__pet.setContext({supported:true,pct:47.5,used:475318,limit:1000000});" +
      "window.__pet.debugFloat('generic',400,300);" +
      "window.__pet.setSettings({hideMoney:true})"
  )
  assert.equal(await cdp.eval("document.getElementById('chip-value').textContent"), '•••')
  await put({ hideMoney: false })
})

test('pet: 气泡点击推进队列，队列结束关闭', async () => {
  await fetch('http://127.0.0.1:' + port + '/v1/bubbles/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
    body: JSON.stringify({ queue: ['第一句', '第二句'] }),
  })
  await cdp.eval("window.__pet.showBubble('占位','测试',{ms:0})")
  await waitFor(async () => (await cdp.eval("!document.getElementById('bubble').hidden")), 3000, 'bubble')
  const rect = JSON.parse(
    await cdp.eval("(function(){var r=document.getElementById('bubble').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()")
  )
  await mouse(cdp, rect.x, rect.y)
  await waitFor(async () => (await cdp.eval("document.getElementById('bubble-text').textContent")) === '第一句', 3000, 'queue 1')
  await mouse(cdp, rect.x, rect.y)
  await waitFor(async () => (await cdp.eval("document.getElementById('bubble-text').textContent")) === '第二句', 3000, 'queue 2')
})

test('pet: 菜单换角色', async () => {
  await cdp.eval('window.__pet.openMenu(200,200)')
  await waitFor(async () => (await cdp.eval("!document.getElementById('menu').hidden")), 3000, 'menu')
  await cdp.eval("document.querySelectorAll('.menu-role')[2].click()")
  await waitFor(async () => /roles\/gpt\.png/.test(await cdp.eval("document.getElementById('fox-img').src")), 4000, 'role gpt')
})

test('pet: petMode 立即脱离吸附，followMs 即时生效', async () => {
  // 重新吸附
  await dragTo(fakeWin.rect.x + fakeWin.rect.w / 2, fakeWin.rect.y + fakeWin.rect.h / 2)
  await waitFor(async () => (await json('http://127.0.0.1:' + port + '/v1/state')).pet.mode === 'attached', 6000, 'attached again')
  const put = async (body) =>
    fetch('http://127.0.0.1:' + port + '/v1/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
      body: JSON.stringify(body),
    })
  await put({ followMs: 250 })
  await waitFor(async () => (await cdp.eval('window.__pet.followEvery')) === 250, 5000, 'followMs applied')
  await put({ petMode: true })
  await waitFor(async () => (await json('http://127.0.0.1:' + port + '/v1/state')).pet.mode === 'floating', 6000, 'petMode floats')
  await put({ petMode: false })

  const bad = await fetch('http://127.0.0.1:' + port + '/v1/pet/reset', { method: 'POST', body: '{}' })
  assert.equal(bad.status, 403)
})

test('pet: 解除吸附并重置', async () => {
  await fetch('http://127.0.0.1:' + port + '/v1/pet/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
    body: '{}',
  })
  const st = await waitFor(async () => {
    const s = await json('http://127.0.0.1:' + port + '/v1/state')
    return s.pet.mode === 'idle' ? s : null
  }, 5000, 'idle')
  assert.equal(st.pet.profileOf, '')
  await waitFor(async () => (await cdp.eval("document.getElementById('chip').hidden")), 4000, 'chip hidden')
})
