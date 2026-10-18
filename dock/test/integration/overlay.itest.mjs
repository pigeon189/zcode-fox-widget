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
let dropPos = null // 拖拽落点（狐狸左上角，CSS px）
let port = 0
let fakeWin = null
let binding = null
let geo = null

// 把狐狸从当前位置拖到目标点（CSS 坐标）。合成事件下命中采样偶发失败，
// 因此调用方可以重试；这里只负责动作本身。
async function dragFoxTo(toX, toY) {
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
  await sleep(300)
}

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

test('drag: 从狐狸拖到宿主窗口中心 → 绑定该窗口', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  // CDP 合成事件里 screenX == clientX（不叠加窗口原点），渲染层算出的偏移就是 0；
  // 测试也按 0 算，两边才一致。真实鼠标用的是系统给的 screenX，不受影响。
  const curSx = 0
  const curSy = 0
  geo.sx = curSx
  geo.sy = curSy
  const dpr0 = Number(await cdp.eval('window.devicePixelRatio')) || 1
  const targetX = (fakeWin.rect.x + Math.floor(fakeWin.rect.w / 2)) / dpr0 - curSx
  const targetY = (fakeWin.rect.y + Math.floor(fakeWin.rect.h / 2)) / dpr0 - curSy
  // 松手时狐狸的左上角（拖动时是按指针居中放置的）
  dropPos = { x: targetX - 40, y: targetY - 40 }

  // 先确认这个点确实命中的是假窗口：桌面上别的窗口盖住它时，后面会绑错对象，
  // 失败信息会变成「binding created 超时」，看不出真正原因。
  const hitAtCenter = await json(
    'http://127.0.0.1:' + port + '/hit?x=' + (fakeWin.rect.x + Math.floor(fakeWin.rect.w / 2)) +
      '&y=' + (fakeWin.rect.y + Math.floor(fakeWin.rect.h / 2)) + '&exclude=' + overlay.pid
  )
  const topHit = (hitAtCenter.hits || [])[0]
  assert.ok(topHit, 'no window under fake agent center')
  assert.equal(topHit.pid, fakeWin.pid, 'fake agent should be the topmost window at its center, got ' + JSON.stringify(topHit))

  // 合成事件下命中采样偶发为 null（窗口被遮挡/时序），失败就重试；三次都失败才报错
  let found = null
  for (let attempt = 0; attempt < 3 && !found; attempt++) {
    if (attempt) await sleep(400)
    await dragFoxTo(targetX, targetY)
    found = await waitFor(async () => {
      const r = await json('http://127.0.0.1:' + port + '/bindings')
      return (r.bindings || []).find((b) => b.window && b.window.pid === fakeWin.pid) || null
    }, 3000, 'binding created').catch(() => null)
    if (!found && attempt === 2) {
      console.error('DEBUG drag', await cdp.eval('JSON.stringify(window.__foxDebug||{})'))
    }
  }
  assert.ok(found, 'binding created after retries')
  binding = found

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

test('anchor: 绑定后狐狸停在放下的位置（不再强行贴右上角）', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  await sleep(400) // 等 120ms 过渡结束
  const rect = await cdp.eval(
    "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,dpr:window.devicePixelRatio})})()"
  )
  const fox = JSON.parse(rect)
  assert.ok(dropPos, 'dropPos missing')

  const binds = await (await fetch('http://127.0.0.1:' + port + '/bindings')).json()
  const b = (binds.bindings || []).find((x) => x.window && x.window.pid === fakeWin.pid)
  const anchorInfo = JSON.stringify(b && b.anchor)
  assert.ok(Math.abs(fox.x - dropPos.x) <= 10, 'fox.x=' + fox.x + ' expected≈' + dropPos.x + ' anchor=' + anchorInfo)
  assert.ok(Math.abs(fox.y - dropPos.y) <= 10, 'fox.y=' + fox.y + ' expected≈' + dropPos.y + ' anchor=' + anchorInfo)
  assert.ok(b && (b.anchor.h || b.anchor.v || Number.isFinite(b.anchor.hOff)), 'binding should persist the drop anchor: ' + anchorInfo)
})

test('snap: 放到窗口右侧 → 贴右边缘（四分吸附）', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const dpr = Number(await cdp.eval('window.devicePixelRatio')) || 1
  const from = JSON.parse(
    await cdp.eval(
      "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()"
    )
  )
  const curSx = 0
  const curSy = 0
  const toX = (fakeWin.rect.x + fakeWin.rect.w * 0.9) / dpr
  const toY = (fakeWin.rect.y + fakeWin.rect.h * 0.2) / dpr

  let saved = null
  for (let attempt = 0; attempt < 3 && !saved; attempt++) {
    if (attempt) await sleep(400)
    await dragFoxTo(toX, toY)
    saved = await waitFor(async () => {
      const r = await json('http://127.0.0.1:' + port + '/bindings')
      const b = (r.bindings || []).find((x) => x.window && x.window.pid === fakeWin.pid)
      return b && b.anchor && b.anchor.h === 'right' && b.anchor.v === 'top' ? b : null
    }, 3000, 'snapped anchor').catch(() => null)
    if (!saved && attempt === 2) {
      console.error('DEBUG snap', await cdp.eval('JSON.stringify(window.__foxDebug||{})'))
    }
  }
  assert.ok(saved, 'snapped anchor after retries')

  // 贴右边缘：left = 窗口宽 - 52；贴上边缘：top = 0。
  // 窗口左/上边界用「落点的 client 坐标 - 落在窗口内的比例」反推，
  // 不依赖 window.screenX（它在窗口激活前后会变）。
  const wCss = fakeWin.rect.w / dpr
  const hCss = fakeWin.rect.h / dpr
  const winLeft = toX - wCss * 0.9
  const winTop = toY - hCss * 0.2
  // 默认设置 scrollGap=17：贴右边要给滚动条留出 17px；角色默认 64px
  const wantX = winLeft + wCss - 80 - 17
  const wantY = winTop
  const fox = await waitFor(async () => {
    const r = JSON.parse(
      await cdp.eval(
        "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y})})()"
      )
    )
    return Math.abs(r.x - wantX) <= 6 && Math.abs(r.y - wantY) <= 6 ? { r, wantX, wantY } : null
  }, 8000, 'fox snapped to right edge').catch(async (err) => {
    throw new Error(err.message + ' | fox=' + (await cdp.eval("JSON.stringify(document.getElementById('fox').getBoundingClientRect())")))
  })

  assert.ok(fox)
  assert.equal(saved.anchor.h, 'right')
  assert.equal(saved.anchor.v, 'top')
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
  const beforeFox = JSON.parse(
    await cdp.eval(
      "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y})})()"
    )
  )
  const dpr = Number(await cdp.eval('window.devicePixelRatio')) || 1
  // window.moveTo 用 CSS 像素；桥读回来是物理像素
  await fakeCdp.eval('window.moveTo(' + (before.rect.x / dpr + 60) + ',' + (before.rect.y / dpr + 40) + ')')

  const dx = 60 * dpr
  const moved = await waitFor(async () => {
    const w = (await json('http://127.0.0.1:' + port + '/windows')).windows.find((x) => x.pid === fakeWin.pid)
    return w && Math.abs(w.rect.x - (before.rect.x + dx)) <= 8 ? w : null
  }, 8000, 'fake window moved')

  // 相对位置不变：窗口移动 (60,40)，狐狸也移动 (60,40)
  const fox = await waitFor(async () => {
    const r = JSON.parse(
      await cdp.eval(
        "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y})})()"
      )
    )
    return Math.abs(r.x - (beforeFox.x + 60)) <= 12 && Math.abs(r.y - (beforeFox.y + 40)) <= 12 ? r : null
  }, 8000, 'fox re-anchored')

  assert.ok(fox)
  fakeWin = moved
})

test('panel: 「解绑这个窗口」清掉绑定并收起面板', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const before = await (await fetch('http://127.0.0.1:' + port + '/bindings')).json()
  const mine = (before.bindings || []).find((b) => b.window && b.window.pid === fakeWin.pid)
  assert.ok(mine, 'binding should exist before unbind')

  // 合成点击偶发丢掉（时序），开面板这件事重试几次；每次重新读狐狸位置
  let opened = false
  for (let i = 0; i < 3 && !opened; i++) {
    if (i) {
      await sleep(300)
      await cdp.eval('if (panelOpen) togglePanel(false)')
    }
    const pos = JSON.parse(
      await cdp.eval(
        "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()"
      )
    )
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
    opened = await waitFor(
      async () => (await cdp.eval("document.body.dataset.panel || ''")) === 'open',
      2500,
      'panel open'
    )
      .then(() => true)
      .catch(() => false)
  }
  assert.ok(opened, 'panel should open after retries')

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

// ---------- 从挂件线移植的功能（设置 / 气泡 / 关于） ----------

test('settings: 面板里的「大小」改完立刻生效，并写回服务端', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  await cdp.eval("togglePanel(true); activeTab='settings'; renderPanel(null, [])")
  const hasControls = await cdp.eval(
    "(function(){var b=document.querySelector('#panel-body');if(!b)return null;" +
      "return JSON.stringify({select:b.querySelectorAll('select').length,number:b.querySelectorAll('input[type=number]').length," +
      "check:b.querySelectorAll('input[type=checkbox]').length})})()"
  )
  const ctl = JSON.parse(hasControls)
  assert.ok(ctl.select >= 2 && ctl.number >= 3 && ctl.check >= 3, hasControls)

  // 按 label 找控件：面板里第一个 select 现在是「角色」，不能再靠位置选
  await cdp.eval(
    "(function(){var rows=document.querySelectorAll('#panel-body .setting');" +
      "for(var i=0;i<rows.length;i++){var l=rows[i].querySelector('label');" +
      "if(l&&l.textContent==='大小'){var s=rows[i].querySelector('select');s.value='1.5';" +
      "s.dispatchEvent(new Event('change',{bubbles:true}));return true}}return false})()"
  )
  const size = await waitFor(async () => {
    const w = Number(await cdp.eval("document.getElementById('fox').getBoundingClientRect().width"))
    return w >= 119 && w <= 121 ? w : null
  }, 5000, 'fox resized to 1.5x')
  assert.ok(size)

  const saved = await (await fetch('http://127.0.0.1:' + port + '/settings')).json()
  assert.equal(saved.settings.scale, 1.5)

  // 复位，后面的用例按 1× 计算几何
  await cdp.eval(
    "(function(){var rows=document.querySelectorAll('#panel-body .setting');" +
      "for(var i=0;i<rows.length;i++){var l=rows[i].querySelector('label');" +
      "if(l&&l.textContent==='大小'){var s=rows[i].querySelector('select');s.value='1';" +
      "s.dispatchEvent(new Event('change',{bubbles:true}));return true}}return false})()"
  )
  await sleep(300)
})

test('about: 关于页显示版本 / 数据目录 / 复制按钮', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  await cdp.eval("activeTab='about'; renderPanel(null, [])")
  const text = await waitFor(async () => {
    const s = String(await cdp.eval("document.querySelector('#panel-body') ? document.querySelector('#panel-body').textContent : ''"))
    return s.indexOf('版本') !== -1 && s.indexOf('数据目录') !== -1 ? s : null
  }, 8000, 'about tab filled')
  assert.ok(text)
  assert.match(text, /v\d+\.\d+\.\d+/)

  const hasCopy = await cdp.eval(
    "(function(){var bs=document.querySelectorAll('#panel-body button');" +
      "for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('复制诊断信息')!==-1)return true}return false})()"
  )
  assert.equal(hasCopy, true)
  await cdp.eval("togglePanel(false)")
})

test('bubble: 每轮消耗气泡会出现并自动消失', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  await cdp.eval("showBubble('本轮 ¥0.42','ZCode',{ms:900})")
  // open 类是在 requestAnimationFrame 里加的（为了触发淡入过渡），不能同步断言
  const shown = await waitFor(async () => {
    const raw = await cdp.eval(
      "(function(){var b=document.getElementById('bubble');" +
        "return JSON.stringify({hidden:b.hidden,open:b.classList.contains('open'),text:b.textContent})})()"
    )
    const v = JSON.parse(raw)
    return v.hidden === false && v.open === true ? v : null
  }, 3000, 'bubble visible')
  assert.ok(shown)
  assert.ok(shown.text.indexOf('本轮 ¥0.42') !== -1, shown.text)

  const gone = await waitFor(
    async () => (await cdp.eval("document.getElementById('bubble').hidden")) === true,
    4000,
    'bubble auto hidden'
  )
  assert.ok(gone)
})

test('bubble: 今日累计或本轮金额变化时冒一次，首次不冒', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const snap = (today, turn) =>
    "renderChip({ok:true,supported:true,unit:'money',adapterId:'zcode',adapterName:'ZCode'," +
    "today:{amount:" + today + ",currency:'CNY',byCurrency:{CNY:" + today + "}}," +
    "turn:{amount:" + turn + ",currency:'CNY'}})"

  await cdp.eval("turnFingerprint=null; hideBubble()")
  // hideBubble 有 200ms 淡出，等它真的收起再开始
  await waitFor(async () => (await cdp.eval("document.getElementById('bubble').hidden")) === true, 3000, 'bubble hidden')
  await cdp.eval(snap(10, 0.5))
  await sleep(200)
  assert.equal(await cdp.eval("document.getElementById('bubble').hidden"), true, '首次读到不该冒泡')

  await cdp.eval(snap(10.5, 0.5))
  const after = await waitFor(async () => {
    const raw = await cdp.eval(
      "(function(){var b=document.getElementById('bubble');" +
        "return JSON.stringify({hidden:b.hidden,text:b.textContent})})()"
    )
    const v = JSON.parse(raw)
    return v.hidden === false ? v : null
  }, 3000, 'bubble after turn change')
  assert.ok(after)
  assert.ok(after.text.indexOf('本轮 ¥0.50') !== -1, after.text)
  await cdp.eval('hideBubble()')
})

test('alert: 预算只算人民币、同日同一项只弹一次', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const res = JSON.parse(
    await cdp.eval(
      "(function(){localStorage.clear();" +
        "var total=moneyTotalCny([{unit:'money',currency:'CNY',amount:12.34}," +
        "{unit:'money',currency:'USD',amount:99},{unit:'credit',currency:'CREDIT',amount:100}]);" +
        "var first=alertOnce('unit-test','今日预算超了','已用 ¥12.34');" +
        "var second=alertOnce('unit-test','今日预算超了','已用 ¥12.34');" +
        "return JSON.stringify({total:total,first:first,second:second})})()"
    )
  )
  // 美元与积分不能和人民币相加
  assert.equal(res.total, 12.34)
  assert.equal(res.first, true)
  assert.equal(res.second, false, '同一天同一项只能提醒一次')
  await cdp.eval('hideBubble()')
})

test('search: 明细列表按适配器名过滤', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const built = await cdp.eval(
    "(function(){" +
      "lastSummary={today:{date:'2026-10-18',groups:[" +
      "{unit:'money',currency:'CNY',amount:10,adapters:[{id:'zcode',name:'ZCode',amount:10}]}," +
      "{unit:'credit',currency:'CREDIT',amount:193,adapters:[{id:'workbuddy',name:'WorkBuddy',amount:193}]}]},days:[]};" +
      "lastBindings=[];filterText='';" +
      "togglePanel(true);activeTab='detail';renderPanel(lastSummary,[]);" +
      "var all=document.getElementById('detail-list').textContent;" +
      "filterText='work';renderDetailList();" +
      "var filtered=document.getElementById('detail-list').textContent;" +
      "filterText='zzz';renderDetailList();" +
      "var none=document.getElementById('detail-list').textContent;" +
      "filterText='';renderDetailList();togglePanel(false);" +
      "return JSON.stringify({all:all,filtered:filtered,none:none})})()"
  )
  const v = JSON.parse(built)
  assert.ok(v.all.indexOf('ZCode') !== -1 && v.all.indexOf('WorkBuddy') !== -1, v.all)
  assert.ok(v.filtered.indexOf('ZCode') === -1 && v.filtered.indexOf('WorkBuddy') !== -1, v.filtered)
  assert.ok(v.none.indexOf('无匹配') !== -1, v.none)
})

test('guard: 最小化窗口的 -32000 矩形不会把狐狸扔到屏幕外', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const before = JSON.parse(
    await cdp.eval(
      "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y})})()"
    )
  )
  const plausible = JSON.parse(
    await cdp.eval(
      "(function(){return JSON.stringify({min:plausibleRect({x:-32000,y:-32000,w:283,h:40})," +
        "zero:plausibleRect({x:0,y:0,w:0,h:40}),nan:plausibleRect({x:NaN,y:0,w:10,h:10})," +
        "ok:plausibleRect({x:0,y:0,w:800,h:600})})})()"
    )
  )
  assert.equal(plausible.min, false)
  assert.equal(plausible.zero, false)
  assert.equal(plausible.nan, false)
  assert.equal(plausible.ok, true)

  await cdp.eval("placeByAnchor({x:-32000,y:-32000,w:283,h:40})")
  await sleep(200)
  const after = JSON.parse(
    await cdp.eval(
      "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y})})()"
    )
  )
  // 无效矩形时狐狸必须待在原处，不能被摆到屏幕外
  assert.ok(Math.abs(after.x - before.x) <= 1 && Math.abs(after.y - before.y) <= 1, JSON.stringify({ before, after }))
})

// ---------- 角色立绘与台词（R12） ----------

test('role: 默认显示嘎啦嘛立绘，尺寸跟着设置走', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const info = JSON.parse(
    await cdp.eval(
      "(function(){var i=document.getElementById('fox-img');var r=i.getBoundingClientRect();" +
        "return JSON.stringify({src:i.getAttribute('src'),w:r.width,h:r.height," +
        "natural:i.naturalWidth,role:roleId})})()"
    )
  )
  assert.match(info.src, /assets\/roles\/fox\.png$/)
  assert.equal(info.role, 'fox')
  assert.equal(info.w, 80)
  assert.equal(info.h, 80)
  assert.ok(info.natural > 0, '立绘必须真的加载出来')
})

test('role: 切换角色 → 立绘换图、说挑经句、落盘', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  await cdp.eval("togglePanel(true); activeTab='settings'; renderPanel(null, [])")
  const switched = await cdp.eval(
    "(function(){var rows=document.querySelectorAll('#panel-body .setting');" +
      "for(var i=0;i<rows.length;i++){var l=rows[i].querySelector('label');" +
      "if(l&&l.textContent==='角色'){var s=rows[i].querySelector('select');s.value='kimi';" +
      "s.dispatchEvent(new Event('change',{bubbles:true}));return true}}return false})()"
  )
  assert.equal(switched, true, '设置页应该有角色下拉')

  const img = await waitFor(async () => {
    const v = JSON.parse(
      await cdp.eval(
        "(function(){var i=document.getElementById('fox-img');" +
          "return JSON.stringify({src:i.getAttribute('src'),natural:i.naturalWidth})})()"
      )
    )
    return /kimi\.png$/.test(v.src) && v.natural > 0 ? v : null
  }, 8000, 'role image switched')
  assert.ok(img)

  // 换角色会说一句「挑经句」
  const said = await waitFor(
    async () => {
      const v = JSON.parse(
        await cdp.eval(
          "(function(){var s=document.getElementById('say');" +
            "return JSON.stringify({hidden:s.hidden,text:s.textContent.trim()})})()"
        )
      )
      return v.hidden === false && v.text ? v : null
    },
    4000,
    'role speaks on switch'
  )
  assert.ok(said)
  assert.ok(said.text.length >= 2, said.text)

  const saved = await (await fetch('http://127.0.0.1:' + port + '/settings')).json()
  assert.equal(saved.settings.roleId, 'kimi')

  // 复位
  await cdp.eval(
    "(function(){var rows=document.querySelectorAll('#panel-body .setting');" +
      "for(var i=0;i<rows.length;i++){var l=rows[i].querySelector('label');" +
      "if(l&&l.textContent==='角色'){var s=rows[i].querySelector('select');s.value='fox';" +
      "s.dispatchEvent(new Event('change',{bubbles:true}));return true}}return false})()"
  )
  await sleep(400)
  await cdp.eval('togglePanel(false)')
})

test('role: 说话气泡会出现、自动消失，且相邻两次不重复', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  await cdp.eval('hideSay()')
  await waitFor(async () => (await cdp.eval("document.getElementById('say').hidden")) === true, 3000, 'say hidden')
  await cdp.eval('sayRandom()')
  const shown = await waitFor(async () => {
    const v = JSON.parse(
      await cdp.eval(
        "(function(){var s=document.getElementById('say');" +
          "return JSON.stringify({hidden:s.hidden,open:s.classList.contains('open'),text:s.textContent.trim()})})()"
      )
    )
    return v.hidden === false && v.open && v.text ? v : null
  }, 3000, 'say visible')
  assert.ok(shown)
  assert.ok(shown.text.length >= 2, shown.text)

  const lines = JSON.parse(
    await cdp.eval(
      "(function(){var out=[];for(var i=0;i<30;i++)out.push(pickLine(FOX_ROLES.whale.lines));" +
        "return JSON.stringify(out)})()"
    )
  )
  assert.equal(lines.length, 30)
  for (let i = 1; i < lines.length; i++) {
    assert.notEqual(lines[i], lines[i - 1], '相邻两次台词不能重复')
  }
  await cdp.eval('hideSay()')
})

test('role: 六个角色的立绘与台词池都完整', async (t) => {
  if (!ELECTRON) return t.skip('electron binary not found')

  const packs = JSON.parse(
    await cdp.eval(
      "(function(){var out={};for(var id in FOX_ROLES){var r=FOX_ROLES[id];" +
        "out[id]={name:r.name,image:r.image,pick:r.pick.length,lines:r.lines.length}}return JSON.stringify(out)})()"
    )
  )
  const ids = Object.keys(packs)
  assert.equal(ids.length, 6)
  for (const id of ids) {
    assert.ok(packs[id].name, id + ' 缺名字')
    assert.match(packs[id].image, new RegExp('assets/roles/' + id + '\\.png$'))
    assert.ok(packs[id].pick >= 1, id + ' 缺挑经句')
    assert.ok(packs[id].lines >= 7, id + ' 台词太少')
  }
})
