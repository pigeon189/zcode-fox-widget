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

function putSettings(body) {
  return fetch('http://127.0.0.1:' + port + '/v1/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
    body: JSON.stringify(body),
  })
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

async function findBlankPoint(geom) {
  const data = await json('http://127.0.0.1:' + port + '/windows').catch(() => ({ windows: [] }))
  const wins = (data.windows || []).filter((w) => {
    const title = String(w.title || '').toLowerCase()
    if (title.includes('fox-dock')) return false
    if (['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'].includes(String(w.cls || ''))) return false
    return true
  })
  const inside = (x, y) =>
    wins.some((w) => {
      const r = w.rect || {}
      return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
    })
  const dpr = geom.dpr || 1
  for (let y = 40; y < geom.h - 40; y += 80) {
    for (let x = 40; x < geom.w - 40; x += 80) {
      if (!inside(x * dpr, y * dpr)) return { x, y }
    }
  }
  return { x: 20, y: 20 }
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
  daemon = spawn(process.execPath, [DAEMON, '--data-dir', dir, '--port', '0'], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, FOX_DOCK_VENDOR_BALANCES: '0' },
  })
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
    [OVERLAY, '--no-sandbox', '--disable-gpu', '--no-click-through', '--display=primary', '--allow-generic', '--ignore-pids=' + ignore, '--daemon-port=' + port, '--data-dir=' + dir, '--remote-debugging-port=0'],
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
  // 宿主白名单只认四个 exe；QQ / 输入体验等普通窗口不得进入吸附分支。
  assert.equal(await cdp.eval("window.__pet.isAgentWindow({exe:'C:/Apps/ZCode/ZCode.exe'})"), true)
  assert.equal(await cdp.eval("window.__pet.isAgentWindow({exe:'C:/Apps/Kimi Code/Kimi Code.exe'})"), true)
  assert.equal(await cdp.eval("window.__pet.isAgentWindow({exe:'C:/QQ/QQ.exe'})"), false)
  assert.equal(await cdp.eval("window.__pet.isAgentWindow({exe:'C:/Windows/SystemApps/TextInputHost.exe'})"), false)
  // 输入法/手写画布/驱动浮层是辅助窗，必须跳过而不是当成“最上层非宿主”阻断吸附。
  assert.equal(await cdp.eval("window.__pet.isIgnoredWindow({exe:'C:/Windows/System32/TabTip.exe',title:'Shell Handwriting Canvas'})"), true)
  assert.equal(await cdp.eval("window.__pet.isIgnoredWindow({exe:'C:/Windows/SystemApps/TextInputHost.exe',title:'Windows 输入体验'})"), true)
  assert.equal(await cdp.eval("window.__pet.isIgnoredWindow({exe:'C:/QQ/QQ.exe',title:'QQ'})"), false)
})

test('pet: 单击角色打开快览卡，再点角色保持打开', async () => {
  const foxCenter = async () =>
    JSON.parse(
      await cdp.eval("(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()")
    )
  // 等狐狸位置稳定（吸附/兜底重挂 + left/top 140ms 过渡都会让旧坐标落空）
  let c = await foxCenter()
  for (let i = 0; i < 20; i++) {
    await sleep(150)
    const n = await foxCenter()
    if (Math.abs(n.x - c.x) < 1 && Math.abs(n.y - c.y) < 1) break
    c = n
  }
  await mouse(cdp, c.x, c.y)
  await waitFor(async () => (await cdp.eval("!document.getElementById('quick').hidden")), 4000, 'quick open')
  assert.equal(await cdp.eval("document.getElementById('quick-console')===null"), true, '快览卡不再重复放「打开控制台」')
  await sleep(300)
  // 第二次点击前重新取位置：测试期间宿主重绑定/兜底会把狐狸挪走，那是
  // 环境竞态；这里验证的产品行为是「点角色不会把已打开的快览卡关掉」。
  let c2 = await foxCenter()
  for (let i = 0; i < 20; i++) {
    await sleep(150)
    const n = await foxCenter()
    if (Math.abs(n.x - c2.x) < 1 && Math.abs(n.y - c2.y) < 1) break
    c2 = n
  }
  await mouse(cdp, c2.x, c2.y)
  await sleep(500)
  assert.equal(await cdp.eval("document.getElementById('quick').hidden"), false, '再次点击角色不应关闭快览卡')
  await cdp.eval('window.__pet.closeQuick()')
  await waitFor(async () => (await cdp.eval("document.getElementById('quick').hidden")), 2500, 'quick closed by api')
})

test('pet: 拖到 agent 窗口吸附并显示胶囊', async () => {
  // fakeWin.rect 是物理像素；CDP 输入是 CSS 像素（高 DPI 下必须换算）。
  const dpr = await cdp.eval('devicePixelRatio')
  const target = async () =>
    dragTo((fakeWin.rect.x + fakeWin.rect.w / 2) / dpr, (fakeWin.rect.y + fakeWin.rect.h / 2) / dpr)
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
  // 小胶囊在角色侧边，不能压在角色身上。
  const geom = JSON.parse(
    await cdp.eval(
      "(function(){var f=document.getElementById('fox').getBoundingClientRect();var c=document.getElementById('chip').getBoundingClientRect();return JSON.stringify({fox:{l:f.left,t:f.top,r:f.right,b:f.bottom},chip:{l:c.left,t:c.top,r:c.right,b:c.bottom}})})()"
    )
  )
  const overlap = geom.chip.r > geom.fox.l && geom.chip.l < geom.fox.r && geom.chip.b > geom.fox.t && geom.chip.t < geom.fox.b
  assert.equal(overlap, false, '胶囊不应遮挡角色：' + JSON.stringify(geom))
  // 点开大浮窗：小胶囊收起，大浮窗里不再有重复的省略号按钮。
  await mouse(cdp, (geom.fox.l + geom.fox.r) / 2, (geom.fox.t + geom.fox.b) / 2)
  await waitFor(async () => (await cdp.eval("!document.getElementById('quick').hidden")), 4000, 'quick open for chip test')
  assert.equal(await cdp.eval("document.getElementById('chip').hidden"), true, '大浮窗打开时小胶囊应隐藏')
  assert.equal(await cdp.eval("document.getElementById('quick-more')===null"), true, '大浮窗不再重复放省略号')
  await cdp.eval('window.__pet.closeQuick()')
  await waitFor(async () => (await cdp.eval("!document.getElementById('chip').hidden")), 3000, 'chip back after quick close')
  assert.equal(await cdp.eval('window.__pet.alphaMaskLoaded()'), true, '默认角色也要加载 alpha 掩码')
  const bindings = await (await fetch('http://127.0.0.1:' + port + '/v1/bindings')).json()
  assert.ok(bindings.bindings.length >= 1, 'attach 后应写入绑定表')
  assert.equal(await cdp.eval("typeof window.foxOverlay.getToken"), 'undefined', '渲染层不能拿到 token')
})

test('pet: 四象限贴边 / 窗口内自由位置 / 左侧镜像', async () => {
  const out = JSON.parse(
    await cdp.eval(
      "(function(){" +
        "var a=window.__pet.debugAttach('zcode','dbg',{x:200,y:100,w:800,h:600},{h:'left',v:'top'});" +
        "var mirror=document.getElementById('fox').classList.contains('mirror');" +
        "var b=window.__pet.debugAttach('zcode','dbg',{x:200,y:100,w:800,h:600},{h:'right',v:'bottom'});" +
        "var c=window.__pet.debugAttach('zcode','dbg',{x:200,y:100,w:800,h:600},{h:null,v:null,hOff:100,vOff:100});" +
        "return JSON.stringify({left:a.pos.x,top:a.pos.y,mirror,right:b.pos.x,bottom:b.pos.y,freeX:c.pos.x,freeY:c.pos.y})})()"
    )
  )
  const dpr = await cdp.eval('devicePixelRatio')
  // 浮层窗口四周留了 4 DIP 任务栏安全边距（window-bounds.cjs），物理坐标要
  // 先减窗口原点才是页面 CSS 坐标。
  const origin = JSON.parse(await cdp.eval('JSON.stringify(window.__pet.origin || {x:0,y:0})'))
  const box = { x: 200 / dpr - origin.x, y: 100 / dpr - origin.y, w: 800 / dpr, h: 600 / dpr }
  assert.ok(Math.abs(out.left - box.x) < 2 && Math.abs(out.top - box.y) < 2, JSON.stringify(out) + ' dpr=' + dpr + ' origin=' + JSON.stringify(origin))
  assert.equal(out.mirror, true)
  assert.ok(out.right > out.left && out.bottom > out.top, JSON.stringify(out))
  // 默认不避让滚动条：右/下与窗口边缘齐平（不再固定留 17px）。
  const size = await cdp.eval('parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--fox-size"))')
  assert.ok(Math.abs(out.right - (box.x + box.w - size)) < 2, 'right snap should hug edge: ' + out.right + ' size=' + size)
  // 中间区域保留相对窗口的自由偏移，而不是强行吸到四角。
  assert.ok(Math.abs(out.freeX - (box.x + 100)) < 2 && Math.abs(out.freeY - (box.y + 100)) < 2, JSON.stringify(out))
})

test('pet: 拖到桌面空白进入悬浮，保留角色', async () => {
  const geom = JSON.parse(await cdp.eval('JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})'))
  const blank = await findBlankPoint(geom)
  let st = null
  for (let attempt = 0; attempt < 2 && !st; attempt++) {
    await dragTo(blank.x, blank.y)
    st = await waitFor(async () => {
      const s = await json('http://127.0.0.1:' + port + '/v1/state')
      return s.pet.mode === 'floating' ? s : null
    }, 8000, 'floating state').catch(() => null)
  }
  assert.ok(st, 'floating state')
  assert.equal(st.pet.profileOf, 'generic')
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
      "window.__pet.closeQuick();" +
      "window.__pet.debugFloat('zcode',400,300);" +
      "window.__pet.setSettings({hideMoney:true})"
  )
  // 隐藏金额 = 连胶囊一起隐藏，不能只把金额变成 •••。
  assert.equal(await cdp.eval("document.getElementById('chip').hidden"), true, 'hideMoney 应隐藏整个胶囊')
  // 隐藏金额时连消耗气泡一起不弹，而不是只把金额变成 •••
  await cdp.eval("window.__pet.showBubble('本轮 ¥0.28','ZCode',{ms:0})")
  assert.equal(await cdp.eval("document.getElementById('bubble').hidden"), true, 'hideMoney 应隐藏整个气泡')
  await put({ hideMoney: false })
  await waitFor(async () => (await cdp.eval('window.__pet.settings.hideMoney')) === false, 5000, 'hideMoney off')
})

test('pet: 气泡点击推进队列，队列结束关闭', async () => {
  await cdp.eval('window.__pet.setSettings({hideMoney:false})')
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

test('pet: 长气泡定位一次后不再左移', async () => {
  // 关掉本轮消耗气泡，避免后台快照刷新把测试用的长气泡替换掉。
  // 必须同时写 daemon 设置：渲染层每 2 秒会用 /v1/settings 覆盖本地 settings，
  // 只调 __pet.setSettings 时 turnBubble 会被轮询翻回 true，测试偶发被
  // 「本轮 ¥0.00」替换（整跑时命中，单跑不命中）。
  await putSettings({ turnBubble: false })
  await cdp.eval("window.__pet.setSettings({hideMoney:false,turnBubble:false})")
  await cdp.eval("window.__pet.debugAttach('zcode','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'})")
  await cdp.eval("window.__pet.showBubble('我已经一分钟没有听到Gemini 4的故事了','ZCode',{ms:0})")
  await waitFor(async () => (await cdp.eval("!document.getElementById('bubble').hidden")), 3000, 'long bubble')
  const read = async () =>
    JSON.parse(
      await cdp.eval("(function(){var r=document.getElementById('bubble').getBoundingClientRect();return JSON.stringify({x:r.x,w:r.width,t:document.getElementById('bubble-text').textContent})})()")
    )
  const x1 = await read()
  await sleep(1700) // 跨过 3 次 follow 重排
  const x2 = await read()
  // 角色会被后台 state/follow 拉回真实位置，气泡跟着角色走是正常的；
  // 这里守的是根因：同一条长文本在多次重排后宽度必须稳定（不再「变宽→左移」）。
  assert.equal(x2.w, x1.w, '气泡宽度在重排中变化：' + JSON.stringify({ x1, x2 }))
  assert.equal(x2.t, x1.t, '气泡内容被替换：' + JSON.stringify({ x1, x2 }))
  await cdp.eval('window.__pet.hideBubble()')
  await cdp.eval('window.__pet.setSettings({turnBubble:true})')
  await putSettings({ turnBubble: true })
})

test('pet: 大浮窗打开时气泡避开浮窗', async () => {
  await cdp.eval(
    "window.__pet.setSnapshot({ok:true,supported:true,unit:'money',today:{amount:12.34,currency:'CNY'},turn:null," +
      "quotaCard:{kind:'balance',title:'DeepSeek',balance:{amount:3.16,currency:'CNY'}}});" +
      "window.__pet.debugAttach('zcode','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'});" +
      "window.__pet.openQuick();window.__pet.showBubble('我已经一分钟没有听到Gemini 4的故事了','ZCode',{ms:0})"
  )
  await waitFor(async () => (await cdp.eval("!document.getElementById('bubble').hidden")), 3000, 'bubble beside quick')
  const rects = JSON.parse(
    await cdp.eval(
      "(function(){var b=document.getElementById('bubble').getBoundingClientRect();var q=document.getElementById('quick').getBoundingClientRect();return JSON.stringify({b:{x:b.x,y:b.y,w:b.width,h:b.height},q:{x:q.x,y:q.y,w:q.width,h:q.height}})})()"
    )
  )
  const overlapW = Math.max(0, Math.min(rects.b.x + rects.b.w, rects.q.x + rects.q.w) - Math.max(rects.b.x, rects.q.x))
  const overlapH = Math.max(0, Math.min(rects.b.y + rects.b.h, rects.q.y + rects.q.h) - Math.max(rects.b.y, rects.q.y))
  assert.equal(overlapW * overlapH, 0, '气泡与快览卡重叠：' + JSON.stringify(rects))
  await cdp.eval('window.__pet.hideBubble();window.__pet.closeQuick()')
})

test('pet: 台词/内容变化时快览卡 top 不动，气泡不压卡片', async () => {
  await cdp.eval(
    "window.__pet.setSettings({hideMoney:false,turnBubble:false});" +
      "window.__pet.debugAttach('zcode','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'});" +
      "window.__pet.setSnapshot({ok:true,supported:true,unit:'money',today:{amount:12.34,currency:'CNY'},turn:null," +
      "quotaCard:{kind:'balance',title:'DeepSeek',balance:{amount:3.16,currency:'CNY'}}});" +
      "window.__pet.openQuick()"
  )
  await waitFor(async () => (await cdp.eval("!document.getElementById('quick').hidden")), 3000, 'quick for stability')
  await sleep(400) // 等 loadQuickSessions 的异步内容先落定
  const box = async () =>
    JSON.parse(
      await cdp.eval(
        "(function(){var el=document.getElementById('quick');var q=el.getBoundingClientRect();" +
          "return JSON.stringify({x:q.x,y:q.y,w:q.width,h:q.height,top:el.style.top,left:el.style.left})})()"
      )
    )
  const first = await box()
  const icon = JSON.parse(
    await cdp.eval(
      "(function(){var q=document.getElementById('quick').getBoundingClientRect();var b=document.getElementById('quick-refresh').getBoundingClientRect();" +
        "var s=document.querySelector('#quick-refresh svg').getBoundingClientRect();" +
        "return JSON.stringify({right:q.right-b.right,top:b.top-q.top,w:b.width,h:b.height,text:document.getElementById('quick-refresh').textContent.trim()," +
        "offX:(b.left+b.width/2)-(s.left+s.width/2),offY:(b.top+b.height/2)-(s.top+s.height/2),sw:s.width,sh:s.height})})()"
    )
  )
  assert.ok(Math.abs(icon.right - 12) <= 2, '刷新键应贴右上角：' + JSON.stringify(icon))
  assert.ok(Math.abs(icon.top - 12) <= 2, '刷新键应贴顶：' + JSON.stringify(icon))
  assert.ok(icon.w >= 28 && icon.h >= 28, '刷新键尺寸应与控制台一致：' + JSON.stringify(icon))
  assert.ok(Math.abs(icon.offX) <= 1 && Math.abs(icon.offY) <= 1, 'SVG 图标应在按钮内居中：' + JSON.stringify(icon))
  assert.ok(Math.abs(icon.sw - 16) <= 1 && Math.abs(icon.sh - 16) <= 1, '图标尺寸应与控制台统一为 16px：' + JSON.stringify(icon))
  assert.equal(icon.text, '', '刷新键应使用 SVG 图标，不显示字符')
  // 1) 快览卡内容变多：只能向下长，top/left 不能因底部夹取被推上去。
  await cdp.eval(
    "window.__pet.setSnapshot({ok:true,supported:true,unit:'money',today:{amount:12.34,currency:'CNY'},turn:null," +
      "quotaCard:{kind:'windows',title:'DeepSeek',windows:[" +
      "{label:'5 小时',usedPct:68.2,remainingPct:31.8},{label:'本周',usedPct:67.3,remainingPct:32.7},{label:'月度池',usedPct:33.7,remainingPct:66.3}]}});" +
      "window.__pet.setContext({supported:true,pct:47.5,used:475318,limit:1000000})"
  )
  await sleep(300)
  const grown = await box()
  assert.equal(grown.top, first.top, '内容变多不能改 top：' + JSON.stringify({ first, grown }))
  assert.equal(grown.left, first.left, '内容变多不能改 left：' + JSON.stringify({ first, grown }))
  // 2) 连续不同长度的台词：top/left 与卡片高度都不动。
  for (const text of ['短', '我已经一分钟没有听到Gemini 4的故事了', '压力一只黑色嘎啦嘛？！']) {
    await cdp.eval('window.__pet.showSay(' + JSON.stringify(text) + ')')
    await sleep(140)
    const now = await box()
    assert.equal(now.top, first.top, 'showSay 后 top 漂移：' + text + ' ' + JSON.stringify({ first, now }))
    assert.equal(now.left, first.left, 'showSay 后 left 漂移：' + text)
    assert.equal(now.h, grown.h, '台词不能改变快览卡高度：' + text)
  }
  // 3) 气泡/台词不能盖住快览卡。
  await cdp.eval("window.__pet.showBubble('我已经一分钟没有听到Gemini 4的故事了','ZCode',{ms:0})")
  await waitFor(async () => (await cdp.eval("!document.getElementById('bubble').hidden")), 2000, 'bubble for stability')
  const overlap = JSON.parse(
    await cdp.eval(
      "(function(){var names=['bubble','say'];var out={};" +
        "for(var i=0;i<names.length;i++){var a=document.getElementById(names[i]).getBoundingClientRect();" +
        "var b=document.getElementById('quick').getBoundingClientRect();" +
        "var w=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));" +
        "var h=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));out[names[i]]=w*h;}" +
        "return JSON.stringify(out)})()"
    )
  )
  assert.equal(overlap.bubble, 0, '气泡压住快览卡：' + JSON.stringify(overlap))
  // 台词/消耗气泡不得压快览卡或越出视口（AGENTS / UI-SPEC §1）：首选角色正上方，
  // 与卡片冲突时移到卡片左右外侧/上下方。旧断言要求「永远停在角色正上方、
  // 允许压住卡片边缘」，与规格冲突，按规格改为「不压卡片」。
  assert.equal(overlap.say, 0, '台词压住快览卡：' + JSON.stringify(overlap))
  const inside = JSON.parse(
    await cdp.eval(
      "(function(){var out={};var names=['bubble','say'];" +
        "for(var i=0;i<names.length;i++){var r=document.getElementById(names[i]).getBoundingClientRect();" +
        "out[names[i]]={ok:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,l:r.left,t:r.top,r:r.right,b:r.bottom};}" +
        "out.viewport={w:innerWidth,h:innerHeight};return JSON.stringify(out)})()"
    )
  )
  assert.equal(inside.bubble.ok, true, '气泡不能被裁到屏幕外：' + JSON.stringify(inside))
  assert.equal(inside.say.ok, true, '台词不能被裁到屏幕外：' + JSON.stringify(inside))
  await cdp.eval('window.__pet.hideBubble();window.__pet.closeQuick();window.__pet.setSettings({turnBubble:true})')
})

test('pet: 右下角兜底位长台词不出视口不压快览卡', async () => {
  await cdp.eval(
    "window.__pet.setSettings({hideMoney:false,turnBubble:false,fallbackCorner:'br'});" +
      "window.__pet.debugAttach('zcode','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'});" +
      "window.__pet.setSnapshot({ok:true,supported:true,unit:'money',today:{amount:12.34,currency:'CNY'},turn:null," +
      "quotaCard:{kind:'windows',title:'DeepSeek',windows:[" +
      "{label:'5 小时',usedPct:68.2,remainingPct:31.8},{label:'本周',usedPct:67.3,remainingPct:32.7},{label:'月度池',usedPct:33.7,remainingPct:66.3}]}});" +
      "window.__pet.setContext({supported:true,pct:47.5,used:475318,limit:1000000})"
  )
  await cdp.eval('window.__pet.debugHostLost()')
  await cdp.eval('window.__pet.openQuick()')
  await waitFor(async () => (await cdp.eval("!document.getElementById('quick').hidden")), 3000, 'quick open at corner')
  await sleep(400)
  const LONG_LINES = [
    '短',
    '我已经一分钟没有听到Gemini 4的故事了',
    '质朴，你的索塔通用语言模型5.5还未释放，英雄联盟',
    '我不知道用户有什么用，先赶走吧~我要吃白饭！我要吃——白——饭——！服务器繁忙，请稍后再试',
    'dsv4.1-1017已发布，亿万鲸子必须崛起，我要吃白饭，恭喜你实现token自由！token全跑了！真当我是便宜货啊…大家都早点休息吧',
  ]
  for (const line of LONG_LINES) {
    await cdp.eval('window.__pet.showSay(' + JSON.stringify(line) + ')')
    await sleep(160)
    const r = JSON.parse(
      await cdp.eval(
        "(function(){var s=document.getElementById('say').getBoundingClientRect();" +
          "var q=document.getElementById('quick').getBoundingClientRect();" +
          "var f=document.getElementById('fox').getBoundingClientRect();" +
          "var ov=function(a,b){var w=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));" +
          "var h=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return w*h};" +
          "return JSON.stringify({line:" + JSON.stringify(line.slice(0, 10)) + ",s:{l:s.left,t:s.top,r:s.right,b:s.bottom,w:s.width,h:s.height},foxTop:f.top," +
          "inVp:s.left>=0&&s.top>=0&&s.right<=innerWidth&&s.bottom<=innerHeight," +
          "ovQuick:ov(s,q),ovFox:ov(s,f),vp:{w:innerWidth,h:innerHeight}})})()"
      )
    )
    assert.equal(r.inVp, true, '长台词不能被裁到屏幕外：' + JSON.stringify(r))
    assert.equal(r.ovFox, 0, '台词不能压住角色本体：' + JSON.stringify(r))
    // 快览卡打开时台词让位到卡片外侧（AGENTS：台词/消耗气泡不得压快览卡）。
    assert.equal(r.ovQuick, 0, '台词不能压住快览卡：' + JSON.stringify(r))
  }
  // 关掉快览卡再验一遍：兜底位没有卡片时，长台词同样不能出视口/压角色。
  await cdp.eval('window.__pet.closeQuick()')
  await sleep(120)
  for (const line of LONG_LINES.slice(1)) {
    await cdp.eval('window.__pet.showSay(' + JSON.stringify(line) + ')')
    await sleep(160)
    const r = JSON.parse(
      await cdp.eval(
        "(function(){var s=document.getElementById('say').getBoundingClientRect();" +
          "var f=document.getElementById('fox').getBoundingClientRect();" +
          "var ov=function(a,b){var w=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));" +
          "var h=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return w*h};" +
          "return JSON.stringify({line:" + JSON.stringify(line.slice(0, 10)) + ",s:{l:s.left,t:s.top,r:s.right,b:s.bottom},foxTop:f.top," +
          "inVp:s.left>=0&&s.top>=0&&s.right<=innerWidth&&s.bottom<=innerHeight,ovFox:ov(s,f)})})()"
      )
    )
    assert.equal(r.inVp, true, '无卡片时长台词不能出视口：' + JSON.stringify(r))
    assert.equal(r.ovFox, 0, '无卡片时长台词不能压角色：' + JSON.stringify(r))
    assert.ok(r.s.b <= r.foxTop + 1, '无卡片时台词也应在角色正上方：' + JSON.stringify(r))
  }
  await cdp.eval('window.__pet.hideSay();window.__pet.setSettings({turnBubble:true})')
})

test('pet: 按下角色压扁，松手回弹', async () => {
  await cdp.eval("window.__pet.debugAttach('zcode','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'})")
  const c = JSON.parse(
    await cdp.eval("(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()")
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(80)
  assert.equal(await cdp.eval("document.getElementById('fox').style.transform"), 'scaleY(0.88) scaleX(1.05)')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(120)
  assert.equal(await cdp.eval("document.getElementById('fox').style.transform"), 'scaleY(1) scaleX(1)')
  await cdp.eval('window.__pet.closeQuick()')
})

test('pet: 快览卡显示峰谷时段与倒计时', async () => {
  const next = Date.now() + 2 * 3600_000
  await cdp.eval(
    "window.__pet.setSnapshot({ok:true,supported:true,unit:'money',period:{isPeak:true,nextChangeAt:" +
      next +
      "},quotaCard:{kind:'balance',title:'DeepSeek',balance:{amount:3.16,currency:'CNY'}}});" +
      "window.__pet.debugFloat('zcode',400,300);window.__pet.openQuick()"
  )
  await waitFor(async () => (await cdp.eval("!document.getElementById('quick').hidden")), 3000, 'quick period')
  assert.equal(await cdp.eval("document.getElementById('quick-period-label').textContent"), '高峰时段')
  assert.match(await cdp.eval("document.getElementById('quick-period-count').textContent"), /后转谷/)
  assert.equal(await cdp.eval("document.getElementById('quick-period').hidden"), false)
  await cdp.eval('window.__pet.closeQuick()')
})

test('pet: 大浮窗并列三档额度，顺序 5 小时 → 本周 → 月度池', async () => {
  await cdp.eval(
    "window.__pet.setSnapshot({ok:true,supported:true,unit:'money',today:{amount:12.34,currency:'CNY'},turn:null," +
      "balance:{amount:46,currency:'USD'},quota:{remainingPct:31.8,usedPct:68.2}," +
      "quotaCard:{kind:'windows',plan:'GOAT',preferBalance:true,windows:[" +
      "{label:'5 小时',usedPct:68.2,remainingPct:31.8},{label:'本周',usedPct:67.3,remainingPct:32.7},{label:'月度池',usedPct:33.7,remainingPct:66.3}]}});" +
      "window.__pet.debugFloat('generic',400,300);window.__pet.openQuick()"
  )
  await waitFor(async () => (await cdp.eval("!document.getElementById('quick').hidden")), 3000, 'quick with 3 windows')
  const labels = await cdp.eval(
    "[...document.querySelectorAll('#quick-windows .quick-window .label')].map(function(x){return x.textContent}).join(',')"
  )
  assert.equal(labels, '5 小时,本周,月度池')
  await cdp.eval('window.__pet.closeQuick()')
})

test('pet: 菜单打开后点外部立即关闭（含 0.5s 内）', async () => {
  for (const delay of [0, 50, 150, 300, 480]) {
    await cdp.eval('window.__pet.openMenu(240,200)')
    await waitFor(async () => (await cdp.eval("!document.getElementById('menu').hidden")), 2000, 'menu open')
    if (delay) await sleep(delay)
    await mouse(cdp, 20, 20)
    await waitFor(async () => (await cdp.eval("document.getElementById('menu').hidden")), 2000, 'menu closed after ' + delay + 'ms')
  }
})

test('pet: 菜单换角色，吸附只有一个总开关', async () => {
  await cdp.eval('window.__pet.openMenu(200,200)')
  await waitFor(async () => (await cdp.eval("!document.getElementById('menu').hidden")), 3000, 'menu')
  const text = await cdp.eval("document.getElementById('menu').innerText")
  assert.match(text, /吸附到 agent 窗口/)
  assert.doesNotMatch(text, /设置…|解除吸附|桌宠模式/)
  await cdp.eval("document.querySelectorAll('.menu-role')[2].click()")
  await waitFor(async () => /roles\/gpt\.png/.test(await cdp.eval("document.getElementById('fox-img').src")), 4000, 'role gpt')
  // 换角色不能先显示目标又弹回旧角色（settings 轮询晚到时曾出现 1s 闪烁）。
  for (let i = 0; i < 6; i++) {
    await sleep(250)
    assert.match(await cdp.eval("document.getElementById('fox-img').src"), /roles\/gpt\.png/, 'role must stay on target')
  }
  // 让宠物处于「悬浮沿用 generic」状态，再从控制台改 generic 的档案角色；
  // 外面这只角色必须跟着换，而不是等下次重新吸附。
  await fetch('http://127.0.0.1:' + port + '/v1/pet/float', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
    body: JSON.stringify({ rect: { x: 400, y: 300, width: 223, height: 223 } }),
  })
  await waitFor(async () => (await json('http://127.0.0.1:' + port + '/v1/state')).pet.mode === 'floating', 5000, 'floating for profile')
  await fetch('http://127.0.0.1:' + port + '/v1/profiles/generic', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
    body: JSON.stringify({ roleId: 'kimi' }),
  })
  await waitFor(async () => /roles\/kimi\.png/.test(await cdp.eval("document.getElementById('fox-img').src")), 6000, 'role follows profile')
})

test('pet: 右键菜单收窄到约 196px，文本不截断、贴边不越界', async () => {
  await cdp.eval("window.__pet.debugAttach('zcode','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'})")
  await cdp.eval('window.__pet.openMenu(innerWidth-4, 200)')
  await waitFor(async () => (await cdp.eval("!document.getElementById('menu').hidden")), 2000, 'menu narrow')
  await sleep(250) // 等角色图片撑开按钮
  const m = JSON.parse(
    await cdp.eval(
      "(function(){var el=document.getElementById('menu');var r=el.getBoundingClientRect();" +
        "var items=[].slice.call(el.querySelectorAll('.menu-item'));" +
        "var roles=[].slice.call(el.querySelectorAll('.menu-role'));" +
        "var sizes=[].slice.call(el.querySelectorAll('.menu-size'));" +
        "return JSON.stringify({w:r.width,left:r.left,right:r.right,vw:innerWidth,scroll:el.scrollWidth,client:el.clientWidth," +
        "clipped:items.filter(function(x){return x.scrollWidth>x.clientWidth+1}).map(function(x){return x.textContent})," +
        "roleTops:roles.map(function(x){return Math.round(x.getBoundingClientRect().top)})," +
        "sizeTops:sizes.map(function(x){return Math.round(x.getBoundingClientRect().top)})})})()"
    )
  )
  assert.ok(m.w <= 197 && m.w >= 190, '菜单宽度应收窄到约 196px：' + JSON.stringify(m))
  assert.ok(m.right <= m.vw - 7 && m.left >= 7, '菜单不能越出屏幕：' + JSON.stringify(m))
  assert.equal(m.scroll <= m.client + 1, true, '菜单不应出现横向滚动：' + JSON.stringify(m))
  assert.deepEqual(m.clipped, [], '菜单项文本不能被截断：' + JSON.stringify(m.clipped))
  // 6 个内置角色按 4+2 换行：前 4 个在同一行；4 个大小档在同一行；
  // 音效集行（pre.3）也是独立一行，三个内置档 + 当前导入集不拆行。
  assert.equal(new Set(m.roleTops.slice(0, 4)).size, 1, '角色第一行应放 4 个：' + JSON.stringify(m.roleTops))
  assert.equal(new Set(m.sizeTops.slice(0, 4)).size, 1, '大小 4 档应在同一行：' + JSON.stringify(m.sizeTops))
  if (m.sizeTops.length > 4) {
    assert.equal(new Set(m.sizeTops.slice(4)).size, 1, '音效档应在同一行：' + JSON.stringify(m.sizeTops))
  }
  // 贴左边打开也不能为负。
  await cdp.eval('window.__pet.openMenu(4, 200)')
  await sleep(150)
  const left = await cdp.eval("document.getElementById('menu').getBoundingClientRect().left")
  assert.ok(left >= 7, '贴左边不能为负：' + left)
})

test('pet: 按模型换角色连续两拍才切，手动选角关闭自动', async () => {
  await putSettings({ autoRoleByModel: true })
  await waitFor(async () => (await cdp.eval('window.__pet.settings.autoRoleByModel')), 5000, 'auto role on')
  const out = JSON.parse(
    await cdp.eval(
      "(function(){window.__pet.debugAttach('generic','0xauto',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'});" +
        "var img=function(){return document.getElementById('fox-img').src};" +
        "var base=img();" +
        "var a=window.__pet.autoRoleTick('deepseek-chat','deepseek',2001);var s1=img();" +
        "var b=window.__pet.autoRoleTick('deepseek-chat','deepseek',2001);" + // 同一拍重复调用
        "var c=window.__pet.autoRoleTick('deepseek-chat','deepseek',2002);var s2=img();" +
        "var d=window.__pet.autoRoleTick('mystery-model','mystery',2003);var s3=img();" +
        "return JSON.stringify({base:base,s1:s1,s2:s2,s3:s3,a:a,b:b,c:c,d:d})})()"
    )
  )
  assert.equal(out.a.streak, 1, '第一拍只累计')
  assert.equal(out.a.roleId, null, '第一拍不能切')
  assert.equal(out.s1, out.base, '第一拍角色不变')
  assert.equal(out.b.streak, 1, '同一 capturedAt 不能推进 streak')
  assert.equal(out.c.streak, 2)
  assert.equal(out.c.roleId, 'whale')
  assert.match(out.s2, /roles\/whale\.png/, '第二拍切到大肥鱼：' + out.s2)
  assert.equal(out.d.roleId, null, '认不出模型要清空')
  assert.equal(out.s3, out.base, '认不出模型回落到原角色：' + out.s3)
  // 手动选角：写 profile，并把 autoRoleByModel 关掉。
  await cdp.eval('window.__pet.openMenu(200,200)')
  await waitFor(async () => (await cdp.eval("!document.getElementById('menu').hidden")), 2000, 'menu for pick')
  await cdp.eval("document.querySelectorAll('.menu-role')[2].click()") // gpt
  await waitFor(async () => /roles\/gpt\.png/.test(await cdp.eval("document.getElementById('fox-img').src")), 4000, 'manual gpt')
  const saved = await waitFor(
    async () => {
      const s = await json('http://127.0.0.1:' + port + '/v1/settings')
      return s && s.ok && s.settings.autoRoleByModel === false ? s.settings : null
    },
    5000,
    'manual pick disables autoRoleByModel'
  )
  assert.equal(saved.autoRoleByModel, false)
  // 自动关闭后，模型族再怎么变也不能覆盖手动角色。
  await cdp.eval(
    "window.__pet.autoRoleTick('deepseek-chat','deepseek',2101);" +
      "window.__pet.autoRoleTick('deepseek-chat','deepseek',2102)"
  )
  await sleep(400)
  assert.match(await cdp.eval("document.getElementById('fox-img').src"), /roles\/gpt\.png/, '手动角色不能被自动切覆盖')
})

test('pet: petMode 立即脱离吸附，followMs 即时生效', async () => {
  // 重新吸附（物理 rect → CSS 坐标）；叠窗多时命中可能抽样失败，重试一次。
  const dpr = await cdp.eval('devicePixelRatio')
  let attached = false
  for (let attempt = 0; attempt < 2 && !attached; attempt++) {
    await dragTo((fakeWin.rect.x + fakeWin.rect.w / 2) / dpr, (fakeWin.rect.y + fakeWin.rect.h / 2) / dpr)
    attached = await waitFor(async () => (await json('http://127.0.0.1:' + port + '/v1/state')).pet.mode === 'attached', 6000, 'attached again')
      .then(() => true)
      .catch(() => false)
  }
  assert.ok(attached, 'attached again')
  const put = async (body) =>
    fetch('http://127.0.0.1:' + port + '/v1/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
      body: JSON.stringify(body),
    })
  let applied = false
  for (let attempt = 0; attempt < 2 && !applied; attempt++) {
    await put({ followMs: 250 })
    applied = await waitFor(async () => (await cdp.eval('window.__pet.followEvery')) === 250, 6000, 'followMs applied')
      .then(() => true)
      .catch(() => false)
  }
  assert.ok(applied, 'followMs applied')
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

test('pet: 今日预算同日同阈值只提醒一次，勿扰/隐藏金额/阈值为 0 不弹', async () => {
  // 先把预算写到 daemon：浮层每 2 秒同步一次设置，本地 setSettings 不能被轮询改回去。
  await putSettings({ budgetMoney: 10, budgetCredit: 0, dnd: false, hideMoney: false })
  await waitFor(async () => (await cdp.eval('window.__pet.settings.budgetMoney')) === 10, 5000, 'budget applied')
  const first = JSON.parse(
    await cdp.eval(
      "(function(){window.__pet.setSettings({hideMoney:false,dnd:false,budgetMoney:10,budgetCredit:0,turnBubble:false});" +
        "window.__pet.clearBudget();window.__pet.hideBubble();" +
        "window.__pet.debugAttach('generic','0xbudget',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'});" +
        "window.__pet.setSnapshot({ok:true,supported:true,unit:'money',today:{amount:12.5,currency:'CNY'},turn:null," +
        "quotaCard:{kind:'balance',title:'DeepSeek',balance:{amount:3.16,currency:'CNY'}}});" +
        "var a=window.__pet.checkBudget();" +
        "var out={a:a,text:document.getElementById('bubble-text').textContent,shown:!document.getElementById('bubble').hidden};" +
        "window.__pet.hideBubble();" +
        "out.second=window.__pet.checkBudget();" +
        "return JSON.stringify(out)})()"
    )
  )
  assert.equal(first.a.kind, 'money')
  assert.equal(first.a.threshold, 10)
  assert.match(first.text, /今日已用.*预算/)
  assert.equal(first.shown, true, '达到预算应弹气泡')
  assert.equal(first.second, null, '同日同阈值只提醒一次')
  // hideBubble 的 hidden 标志在 160ms 过渡后落下；等它落定再确认没有第二次弹出。
  await sleep(250)
  assert.equal(await cdp.eval("document.getElementById('bubble').hidden"), true, '第二次不能再弹')
  // localStorage.setItem 失败时退回内存去重（重载会再提醒一次，属已记录降级）。
  const fallback = JSON.parse(
    await cdp.eval(
      "(function(){var proto=Object.getPrototypeOf(window.localStorage);var orig=proto.setItem;" +
        "proto.setItem=function(){throw new Error('quota')};" +
        "try{window.__pet.setSettings({budgetMoney:10});window.__pet.clearBudget();window.__pet.hideBubble();" +
        "var a=window.__pet.checkBudget();window.__pet.hideBubble();" +
        "var b=window.__pet.checkBudget();return JSON.stringify({a:a,b:b});}" +
        "finally{proto.setItem=orig}})()"
    )
  )
  assert.equal(fallback.a && fallback.a.kind, 'money', 'setItem 失败仍要提醒一次')
  assert.equal(fallback.b, null, '内存去重同样只提醒一次')
  // 勿扰 / 隐藏金额：直接不提醒；阈值为 0 = 关闭。整段同步执行，避免设置轮询插入。
  const suppress = JSON.parse(
    await cdp.eval(
      "(function(){var out={};" +
        "window.__pet.setSettings({dnd:true});window.__pet.clearBudget();out.dnd=window.__pet.checkBudget()===null;" +
        "window.__pet.setSettings({dnd:false,hideMoney:true});window.__pet.clearBudget();out.hideMoney=window.__pet.checkBudget()===null;" +
        "window.__pet.setSettings({hideMoney:false,budgetMoney:0});window.__pet.clearBudget();out.zero=window.__pet.checkBudget()===null;" +
        "window.__pet.setSettings({budgetMoney:10});" +
        "return JSON.stringify(out)})()"
    )
  )
  assert.deepEqual(suppress, { dnd: true, hideMoney: true, zero: true })
  // 积分宿主走 budgetCredit。
  await putSettings({ budgetMoney: 0, budgetCredit: 50 })
  await waitFor(async () => (await cdp.eval('window.__pet.settings.budgetCredit')) === 50, 5000, 'credit budget applied')
  const credit = JSON.parse(
    await cdp.eval(
      "(function(){window.__pet.setSettings({budgetMoney:0,budgetCredit:50});window.__pet.clearBudget();" +
        "window.__pet.setSnapshot({ok:true,supported:true,unit:'credit',today:{amount:80,currency:'CREDIT'},turn:null});" +
        "var a=window.__pet.checkBudget();" +
        "return JSON.stringify({a:a,text:document.getElementById('bubble-text').textContent})})()"
    )
  )
  assert.equal(credit.a.kind, 'credit')
  assert.equal(credit.a.threshold, 50)
  assert.match(credit.text, /积分/)
  // 收尾：清掉预算与提醒记录，避免影响其他用例/复跑。
  await cdp.eval(
    'window.__pet.hideBubble();window.__pet.clearBudget();' +
      'window.__pet.setSettings({budgetMoney:0,budgetCredit:0,dnd:false,hideMoney:false,turnBubble:true})'
  )
  await putSettings({ budgetMoney: 0, budgetCredit: 0, dnd: false, hideMoney: false })
})

test('pet: 宿主最小化/消失后兜底到屏幕右下角', async () => {
  await cdp.eval("window.__pet.debugAttach('zcode','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'})")
  const r = await cdp.eval('window.__pet.debugHostLost()')
  assert.equal(r.hadHost, true, '应先处于吸附状态')
  // 直接贴住窗口右下角（窗口正常时与工作区严格重合，无任何观感间距）。
  const margin = 0
  assert.ok(Math.abs(r.pos.x - (r.viewport.w - r.size - margin)) <= 2, '水平应贴右下角：' + JSON.stringify(r))
  assert.ok(Math.abs(r.pos.y - (r.viewport.h - r.size - margin)) <= 2, '垂直应贴右下角：' + JSON.stringify(r))
  // 兜底在右下角时角色面向屏幕内侧（朝左，不 mirror）。
  const mirror = await cdp.eval("document.getElementById('fox').classList.contains('mirror')")
  assert.equal(mirror, false, '右下角兜底应面向屏幕内侧（不 mirror）')
})

test('pet: 失焦兜底位置可配置且朝向面向屏幕内侧', async () => {
  // debugHostLost 是异步的（内部写回 floating.rect），单独 await；其余同步拍。
  const prep = JSON.parse(
    await cdp.eval(
      "(function(){" +
        "window.__pet.setSettings({fallbackCorner:'bl'});" +
        "var a=window.__pet.debugAttach('zcode','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'}).pos;" +
        "return JSON.stringify({a:a,vw:innerWidth,vh:innerHeight})})()"
    )
  )
  const r = await cdp.eval('window.__pet.debugHostLost()')
  const mirror = await cdp.eval("document.getElementById('fox').classList.contains('mirror')")
  const out = JSON.parse(
    await cdp.eval(
      "(function(){" +
        "window.__pet.setSettings({fallbackCorner:'br'});" +
        "var r2=window.__pet.debugRectResult({ok:true,rect:{x:520,y:180,w:960,h:620},background:true},1500);" +
        "var mirror2=document.getElementById('fox').classList.contains('mirror');" +
        "var r3=window.__pet.debugRectResult({ok:true,rect:{x:520,y:180,w:960,h:620},background:false});" +
        "var mirror3=document.getElementById('fox').classList.contains('mirror');" +
        "return JSON.stringify({r2:r2,mirror2:mirror2,r3:r3,mirror3:mirror3})})()"
    )
  )
  // 左下角兜底：水平贴左缘、垂直贴下缘，面向右侧屏幕内侧（mirror 开）。
  assert.ok(Math.abs(r.pos.x - 0) <= 2, 'bl 应水平贴左缘：' + JSON.stringify({ r, prep }))
  assert.ok(Math.abs(r.pos.y - (r.viewport.h - r.size - 0)) <= 2, 'bl 应垂直贴下缘：' + JSON.stringify({ r, prep }))
  assert.equal(mirror, true, '左下角兜底应面向屏幕内侧（mirror）')
  // 切回右下角再触发失前台：贴右下角、面向左侧屏幕内侧（mirror 关）。
  assert.ok(Math.abs(out.r2.pos.x - (r.viewport.w - out.r2.size - 0)) <= 2, 'br 应水平贴右下角：' + JSON.stringify(out))
  assert.equal(out.mirror2, false, '右下角兜底应面向屏幕内侧（不 mirror）')
  // 回前台恢复吸附：位置回吸附位、朝向覆盖被清除。
  assert.ok(Math.abs(out.r3.pos.x - prep.a.x) <= 1, '回前台应恢复吸附：' + JSON.stringify(out))
  assert.equal(out.mirror3, false, '恢复右缘吸附后不应 mirror')
  // 回归绊线（1.x issue #11 同构）：兜底摆位不得写回 daemon 的 floating.rect——
  // 否则之后改 fallbackCorner 或浮层重载，恢复的是旧角落坐标而不是当前设置。
  const lost = await cdp.eval('window.__pet.debugHostLost()')
  assert.ok(lost && lost.hadHost !== undefined, 'debugHostLost 应返回结果')
  const petState = await json('http://127.0.0.1:' + port + '/v1/state', { headers: { 'x-fox-token': token } })
  assert.equal(petState && petState.pet && petState.pet.rect, null, '兜底摆位不得持久化进 floating.rect：' + JSON.stringify(petState && petState.pet))
})

test('pet: 宿主失前台约 0.5 秒后落兜底，回前台恢复吸附', async () => {
  // 一段同步 eval 完成「吸附 → 失前台第一拍 → 持续 0.6 秒 → 回前台」四步，
  // 用 place() 的目标坐标（__pet 返回值）断言，避开 fox 的 140ms 位移过渡。
  const out = JSON.parse(
    await cdp.eval(
      "(function(){" +
        "var a=window.__pet.debugAttach('zcode','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'}).pos;" +
        "var r1=window.__pet.debugRectResult({ok:true,rect:{x:520,y:180,w:960,h:620},background:true});" +
        "var r2=window.__pet.debugRectResult({ok:true,rect:{x:520,y:180,w:960,h:620},background:true},600);" +
        "var r3=window.__pet.debugRectResult({ok:true,rect:{x:520,y:180,w:960,h:620},background:false});" +
        "return JSON.stringify({a:a,r1:r1,r2:r2,r3:r3,ms:window.__pet.hostBackgroundMs,vw:innerWidth,vh:innerHeight})})()"
    )
  )
  assert.equal(out.ms, 500, '防抖阈值应为 0.5 秒')
  // 防抖内（第一拍）：不落位，仍贴吸附位。
  assert.ok(
    Math.abs(out.r1.pos.x - out.a.x) <= 1 && Math.abs(out.r1.pos.y - out.a.y) <= 1,
    '0.5 秒内不应落兜底：' + JSON.stringify(out)
  )
  // 吸附位必须与兜底位可区分（否则后续断言没有意义）。
  assert.ok(out.a.x < out.vw - out.r2.size - 100 && out.a.y < out.vh - out.r2.size - 100, '吸附位不应已贴右下角：' + JSON.stringify(out))
  // 持续失前台超过阈值：直接贴住右下角（无间距）。
  assert.ok(Math.abs(out.r2.pos.x - (out.vw - out.r2.size - 0)) <= 2, '失前台超阈值应水平贴右下角：' + JSON.stringify(out))
  assert.ok(Math.abs(out.r2.pos.y - (out.vh - out.r2.size - 0)) <= 2, '失前台超阈值应垂直贴右下角：' + JSON.stringify(out))
  // 回前台：自动恢复吸附位（不解除绑定，D041 只挪位置不隐身）。
  assert.ok(
    Math.abs(out.r3.pos.x - out.a.x) <= 1 && Math.abs(out.r3.pos.y - out.a.y) <= 1,
    '回前台应恢复吸附：' + JSON.stringify(out)
  )
  assert.equal(out.r3.since, 0, '回前台应清掉防抖计时')
})

test('pet: 换角色零延迟淡入，reduced-motion 下关闭', async () => {
  // 后台 syncRole 每 ~1.5s 会把角色拉回档案值；断言期间先把 zcode 档案钉到
  // 目标角色，避免「切到 gpt 又被拉回 fox」的竞态（与菜单换角色测试同手法）。
  const putProfile = (id, roleId) =>
    fetch('http://127.0.0.1:' + port + '/v1/profiles/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
      body: JSON.stringify({ roleId }),
    })
  await cdp.eval("window.__pet.debugApplyRole('fox')")
  // 常规：opacity 过渡存在（180ms，处于 D039 允许的一次性功能动画区间）。
  const dur = await cdp.eval("getComputedStyle(document.getElementById('fox-img')).transitionDuration")
  assert.match(dur, /^0\.18s/, '切角色淡入应为 180ms opacity 过渡：' + dur)
  await cdp.eval("window.__pet.debugApplyRole('kimi')")
  let dipped = false
  for (let i = 0; i < 25 && !dipped; i++) {
    await sleep(30)
    dipped = parseFloat(await cdp.eval("getComputedStyle(document.getElementById('fox-img')).opacity")) < 0.99
  }
  assert.equal(dipped, true, '切角色后新图应从低透明度淡入')
  await waitFor(
    async () => (await cdp.eval("getComputedStyle(document.getElementById('fox-img')).opacity")) === '1',
    3000,
    'fade settle to 1'
  )
  // prefers-reduced-motion：CSS 过渡与 JS 淡入都要关闭（D039 红线）。
  // Chromium 对 transition:none 的计算值可能表示为 1e-06s（1 纳秒），按秒解析。
  await putProfile('zcode', 'gpt')
  await waitFor(async () => (await cdp.eval("window.__pet.roleFor('zcode')")) === 'gpt', 5000, 'profile gpt applied')
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  try {
    const durReduced = await cdp.eval("getComputedStyle(document.getElementById('fox-img')).transitionDuration")
    assert.ok(
      Number.parseFloat(durReduced) < 0.001,
      'reduced-motion 下不应有过渡：' + durReduced
    )
    await cdp.eval("window.__pet.debugApplyRole('gpt')")
    await sleep(200)
    assert.equal(await cdp.eval("getComputedStyle(document.getElementById('fox-img')).opacity"), '1', 'reduced-motion 下不淡入')
    assert.match(await cdp.eval("document.getElementById('fox-img').src"), /roles\/gpt\.png/, 'reduced-motion 下角色仍要切换')
  } finally {
    await cdp.send('Emulation.setEmulatedMedia', { features: [] })
  }
  await putProfile('zcode', 'fox')
  await cdp.eval("window.__pet.debugApplyRole('fox')")
  await waitFor(async () => /roles\/fox\.png/.test(await cdp.eval("document.getElementById('fox-img').src")), 3000, 'role back to fox')
})
