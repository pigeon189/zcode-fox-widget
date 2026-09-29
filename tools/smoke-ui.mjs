// 前端冒烟：headless Edge/Chrome + CDP，加载真实挂件页面跑两条前端链路。
// widget.js 是 IIFE、内部函数拿不到，所以全部走真实交互：
//   1. 套餐轮次气泡（billable:false + quotaPct）必须显示「占当前配额 x%」
//      ——回归 showCostBubble 尾部清理把 hint 覆盖掉的缺陷
//   2. 菜单「显示」选择（displayMode）改动要持久化，刷新后保持
//      ——回归 writeWidgetState 白名单丢字段的缺陷
// 服务端与假库同 selftest（临时 ZCODE_HOME），浏览器进程用完即杀。
//
//   node tools/smoke-ui.mjs
//
// 本机找不到 Edge/Chrome 时打印 SKIP、以 0 退出（无浏览器的 CI 机器）。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const browser = BROWSERS.find((p) => {
  try {
    return fs.statSync(p).isFile()
  } catch (err) {
    return false
  }
})
if (!browser) {
  console.log('SKIP：本机未找到 Edge/Chrome，前端冒烟不可用')
  process.exit(0)
}

// ---------- 临时环境 + 假库（形状同 selftest） ----------
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-smoke-'))
const dbDir = path.join(tmpHome, 'cli', 'db')
const dataDir = path.join(tmpHome, 'whale')
fs.mkdirSync(dbDir, { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })
const PORT = 39600 + Math.floor(Math.random() * 300)
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: PORT }), 'utf8')

// Plan 配额 fixture：给 glm-4.7-flash 一个 100 万的桶，120k tokens 轮次 → 12%
const planLogDir = path.join(tmpHome, '.zcode', 'v2', 'logs')
fs.mkdirSync(planLogDir, { recursive: true })
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
const planFixture = {
  balances: [
    {
      entitlement_id: 'ent-free',
      show_name: 'GLM-4.7-Flash',
      total_units: 1_000_000,
      used_units: 0,
      remaining_units: 1_000_000,
      available_units: 1_000_000,
      reserved_units: null,
    },
  ],
  payload: { code: 0, data: { server_time: Math.floor(Date.now() / 1000), plans: [], balances: [] } },
}
fs.writeFileSync(
  path.join(planLogDir, todayKey() + '.log'),
  '[usage-stats] billing/balance 请求完成 ' + JSON.stringify(planFixture) + '\n',
  'utf8'
)

const db = new DatabaseSync(path.join(dbDir, 'db.sqlite'))
db.exec(`
  CREATE TABLE turn_usage (
    session_id text not null, turn_id text not null, status text not null,
    started_at integer not null, completed_at integer,
    input_tokens integer not null default 0, output_tokens integer not null default 0,
    reasoning_tokens integer not null default 0, cache_creation_input_tokens integer not null default 0,
    cache_read_input_tokens integer not null default 0, computed_total_tokens integer not null default 0,
    primary key(session_id, turn_id)
  );
  CREATE TABLE model_usage (
    id text primary key, session_id text not null, turn_id text, model_id text not null,
    provider_id text not null default '', status text not null default 'completed',
    attempt_index integer not null default 0, started_at integer not null,
    input_tokens integer not null default 0, output_tokens integer not null default 0,
    reasoning_tokens integer not null default 0, cache_creation_input_tokens integer not null default 0,
    cache_read_input_tokens integer not null default 0, computed_total_tokens integer not null default 0
  );
`)
function insertTurn(turnId, model, providerId, input, output) {
  const now = Date.now()
  db.prepare(
    `INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at, input_tokens, output_tokens, computed_total_tokens)
     VALUES ('sess_smoke', ?, 'completed', ?, ?, ?, ?, ?)`
  ).run(turnId, now - 1000, now, input, output, input + output)
  db.prepare(
    `INSERT INTO model_usage (id, session_id, turn_id, model_id, provider_id, started_at, input_tokens, output_tokens, computed_total_tokens)
     VALUES (?, 'sess_smoke', ?, ?, ?, ?, ?, ?, ?)`
  ).run('mu-' + turnId, turnId, model, providerId, now - 1000, input, output, input + output)
}
insertTurn('turn_0', 'GLM-4.7-Flash', 'account:zai-start-plan', 10, 10) // 历史轮次：服务启动只对齐

// ---------- CDP 小客户端（Node 内置 WebSocket，无第三方依赖） ----------
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }
  get ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true })
    return r && r.result ? r.result.value : undefined
  }
  close() {
    try {
      this.ws.close()
    } catch (err) {}
  }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  — ' + detail : ''))
}
async function waitReady(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const h = await (await fetch('http://127.0.0.1:' + port + '/whale/health', { signal: AbortSignal.timeout(1500) })).json()
      if (h && h.app === 'zcode-whale-widget') return h
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}
async function pollEval(cdp, expression, deadlineMs, intervalMs = 500) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const v = await cdp.eval(expression)
    if (v) return v
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

const server = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'server.mjs')], {
  cwd: PLUGIN_ROOT,
  env: { ...process.env, ZCODE_HOME: tmpHome, ZCODE_DATA_BASE_DIR: tmpHome },
  stdio: 'ignore',
})
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-smoke-profile-'))
let edge = null
let cdp = null
try {
  console.log('🖥️ 前端冒烟（' + path.basename(browser) + ' headless, 服务端口 ' + PORT + '）\n')
  const health = await waitReady(PORT, 8000)
  check('服务在临时端口就绪', !!health)
  if (!health) throw new Error('服务未就绪')

  edge = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--window-size=900,700',
      '--user-data-dir=' + tmpProfile,
      '--remote-debugging-port=0',
      'http://127.0.0.1:' + PORT + '/',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let dbgPort = 0
  let exitInfo = null
  const wsLine = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 20000)
    const onChunk = (chunk) => {
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(String(chunk))
      if (m && !dbgPort) {
        dbgPort = Number(m[1])
        clearTimeout(timer)
        resolve(dbgPort)
      }
    }
    edge.stderr.on('data', onChunk)
    edge.stdout.on('data', onChunk)
    edge.once('exit', (code, sig) => {
      exitInfo = 'exit ' + code + '/' + sig
      clearTimeout(timer)
      resolve(null)
    })
  })
  check('浏览器调试端口就绪', !!dbgPort, dbgPort ? 'port=' + dbgPort : '未捕获 DevTools 行' + (exitInfo ? '（浏览器 ' + exitInfo + '）' : ''))

  const targets = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/list')).json()
  const page = targets.find((t) => t.type === 'page' && t.url.indexOf('127.0.0.1:' + PORT) !== -1)
  check('找到挂件页面 target', !!page, page ? page.url : JSON.stringify(targets.map((t) => t.url)))
  if (!page) throw new Error('页面 target 不存在')

  cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  const booted = await pollEval(
    cdp,
    "(document.readyState === 'complete' && document.querySelector('.zcwv-hint')) ? true : false",
    12000
  )
  check('挂件前端完成初始化', !!booted)

  // ① 套餐轮次气泡：GLM-4.7-Flash 免费（billable=false），120k/1M 桶 = 12%
  insertTurn('turn_free', 'GLM-4.7-Flash', 'account:zai-start-plan', 100_000, 20_000)
  // 只认「占当前配额」字样：随机台词气泡也可能占用 hint，不能见文本就过
  const hint2 = await pollEval(
    cdp,
    "(function(){var h=document.querySelector('.zcwv-hint');return h&&h.style.display!=='none'&&h.textContent.indexOf('占当前配额 12')!==-1?h.textContent:null})()",
    15000
  )
  check(
    '套餐轮次气泡显示「占当前配额 12%」',
    typeof hint2 === 'string' && hint2.indexOf('占当前配额 12') !== -1,
    'hint=' + JSON.stringify(hint2)
  )

  // ② displayMode：模拟菜单选择 → size.json 落盘 → 刷新后保持
  const picked = await cdp.eval(
    "(function(){var ss=document.querySelectorAll('select');for(var i=0;i<ss.length;i++){var s=ss[i],vals=[];" +
      'for(var j=0;j<s.options.length;j++)vals.push(s.options[j].value);' +
      "if(vals.indexOf('plan')!==-1&&vals.indexOf('glm')!==-1&&vals.indexOf('ds')!==-1){" +
      "s.value='plan';s.dispatchEvent(new Event('change'));return {ok:true,value:s.value}}}" +
      'return {ok:false}})()'
  )
  check('找到「显示」下拉并选中 Plan 配额', picked && picked.ok && picked.value === 'plan', JSON.stringify(picked))
  await new Promise((r) => setTimeout(r, 1200))
  const saved = await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()
  check('displayMode 已持久化到 widget-state', saved.displayMode === 'plan', 'displayMode=' + saved.displayMode)

  // ③ 菜单按钮可点：悬停出现 → 真实点击打开设置菜单。
  // 回归：按钮压在鲸鱼不透明像素上，onDocClickStopper 曾在捕获层吃掉 click。
  const bp = JSON.parse(
    await cdp.eval(
      "(function(){var b=document.querySelector('.zcwv-menu-btn').getBoundingClientRect();" +
        'return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)})})()'
    )
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bp.x, y: bp.y, button: 'none', pointerType: 'mouse' })
  const btnVisible = await pollEval(
    cdp,
    "document.querySelector('.zcwv-menu-btn').classList.contains('zcwv-menu-btn-visible') ? true : null",
    5000
  )
  check('悬停后菜单按钮出现', !!btnVisible)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bp.x, y: bp.y, button: 'left', clickCount: 1, pointerType: 'mouse' })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bp.x, y: bp.y, button: 'left', clickCount: 1, pointerType: 'mouse' })
  const menuOpen = await pollEval(
    cdp,
    "document.querySelector('.zcwv-menu').classList.contains('zcwv-menu-open') ? true : null",
    5000
  )
  check('点击菜单按钮打开设置菜单', !!menuOpen)

  // ④ 按钮配色跟随 ZCode 深色主题（中性表面，不是旧版亮蓝）。
  // applyConfig 只在页面加载时跑，所以先落盘再统一刷新。
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, theme: 'dark' }),
  })

  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  const reloaded = await cdp.eval(
    "(function(){var ss=document.querySelectorAll('select');for(var i=0;i<ss.length;i++){var s=ss[i],vals=[];" +
      'for(var j=0;j<s.options.length;j++)vals.push(s.options[j].value);' +
      "if(vals.indexOf('plan')!==-1&&vals.indexOf('glm')!==-1&&vals.indexOf('ds')!==-1)return s.value}" +
      'return null})()'
  )
  check('刷新后 displayMode 保持 Plan 配额', reloaded === 'plan', 'value=' + JSON.stringify(reloaded))
  const btnStyle = JSON.parse(
    await cdp.eval(
      "(function(){var b=document.querySelector('.zcwv-menu-btn');" +
        'return JSON.stringify({bg:getComputedStyle(b).backgroundColor,bar:getComputedStyle(b.querySelector("span")).backgroundColor})})()'
    )
  )
  check(
    '深色主题菜单按钮为中性表面（#2b2b2b 底 + 浅灰横杠）',
    btnStyle.bg === 'rgba(43, 43, 43, 0.95)' && btnStyle.bar === 'rgb(212, 212, 212)',
    JSON.stringify(btnStyle)
  )
} catch (err) {
  check('冒烟过程未抛异常', false, String((err && err.message) || err))
} finally {
  if (cdp) cdp.close()
  if (edge) {
    // Electron/Chromium 是多进程树，taskkill 按树杀干净
    const r = spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
    if (r.status !== 0) {
      try {
        edge.kill()
      } catch (err) {}
    }
  }
  try {
    server.kill()
  } catch (err) {}
  try {
    db.close()
  } catch (err) {}
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch (err) {}
  try {
    fs.rmSync(tmpProfile, { recursive: true, force: true })
  } catch (err) {}
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length === 0 ? '前端冒烟全部通过（' + results.length + '/' + results.length + '）' : '失败 ' + failed.length + ' 项'))
process.exit(failed.length === 0 ? 0 : 1)
