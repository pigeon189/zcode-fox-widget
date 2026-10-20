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
  const c = JSON.parse(
    await cdp.eval("(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()")
  )
  await mouse(cdp, c.x, c.y)
  await waitFor(async () => (await cdp.eval("!document.getElementById('quick').hidden")), 4000, 'quick open')
  assert.equal(await cdp.eval("document.getElementById('quick-console')===null"), true, '快览卡不再重复放「打开控制台」')
  await sleep(300)
  await mouse(cdp, c.x, c.y)
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
  const box = { x: 200 / dpr, y: 100 / dpr, w: 800 / dpr, h: 600 / dpr }
  assert.ok(Math.abs(out.left - box.x) < 2 && Math.abs(out.top - box.y) < 2, JSON.stringify(out) + ' dpr=' + dpr)
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
  const left = fakeWin.rect.x / geom.dpr
  const bottom = (fakeWin.rect.y + fakeWin.rect.h) / geom.dpr
  const blank = left > 80 ? { x: 20, y: 20 } : bottom < geom.h - 60 ? { x: 20, y: geom.h - 30 } : { x: geom.w - 20, y: 20 }
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
      "window.__pet.debugFloat('zcode',400,300);" +
      "window.__pet.setSettings({hideMoney:true})"
  )
  assert.equal(await cdp.eval("document.getElementById('chip-value').textContent"), '•••')
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

test('pet: 菜单换角色，吸附只有一个总开关', async () => {
  await cdp.eval('window.__pet.openMenu(200,200)')
  await waitFor(async () => (await cdp.eval("!document.getElementById('menu').hidden")), 3000, 'menu')
  const text = await cdp.eval("document.getElementById('menu').innerText")
  assert.match(text, /吸附到 agent 窗口/)
  assert.doesNotMatch(text, /设置…|解除吸附|桌宠模式/)
  await cdp.eval("document.querySelectorAll('.menu-role')[2].click()")
  await waitFor(async () => /roles\/gpt\.png/.test(await cdp.eval("document.getElementById('fox-img').src")), 4000, 'role gpt')
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
