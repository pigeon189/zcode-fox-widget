// 前端冒烟：headless Edge/Chrome + CDP，加载真实挂件页面跑两条前端链路。
// widget.js 是 IIFE、内部函数拿不到，所以全部走真实交互：
//   1. 每轮消耗气泡（WorkBuddy 主口径 = 订阅积分）显示「上一轮消耗: N 积分」——
//      主显示是今日积分；超宽文案自适应缩字/换行不顶出色泡
//   2. 菜单「显示」选择（displayMode）改动要持久化，刷新后保持
//      ——回归 writeWidgetState 白名单丢字段的缺陷
// 服务端与假库同 selftest（临时 CODEBUDDY_HOME），浏览器进程用完即杀。
//
//   node tools/smoke-ui.mjs
//
// 本机找不到 Edge/Chrome 时打印 SKIP、以 0 退出（无浏览器的 CI 机器）。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
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

// ---------- 临时环境 + 假库（形状同 selftest：WorkBuddy workbuddy.db + transcript） ----------
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-smoke-'))
const dataDir = path.join(tmpHome, 'plugin-data')
fs.mkdirSync(dataDir, { recursive: true })
process.env.CODEBUDDY_HOME = tmpHome
process.env.FOX_WIDGET_DATA_DIR = dataDir
// 挑一个真的空闲的端口：服务发现端口被占会自动改试 +1（lib/server.mjs listen 的
// attemptsLeft 回退），而测试只认自己写进 config 的 PORT——一旦被占（例如另一条
// 产品线的冒烟同时在跑：两边都是从 39600 起的随机池），就会报「服务在临时端口就绪」
// 的假失败。所以先探一下端口空闲再落进 config。
async function pickFreePort(min, max) {
  for (let i = 0; i < 50; i++) {
    const p = min + Math.floor(Math.random() * (max - min))
    const free = await new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(p, '127.0.0.1')
    })
    if (free) return p
  }
  throw new Error('挑不到空闲端口（' + min + '-' + max + '）')
}

const PORT = await pickFreePort(39600, 39900)
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: PORT }), 'utf8')

// 宿主 preferences：theme = light。挂件主题里的「跟随 WorkBuddy」读它，
// 测试里把系统偏好模拟成深色来验证挂件跟的是 WorkBuddy 而不是操作系统。
fs.mkdirSync(path.join(tmpHome, 'storage', 'user-1-personal', 'global'), { recursive: true })
fs.writeFileSync(
  path.join(tmpHome, 'storage', 'user-1-personal', 'global', 'preferences.json'),
  JSON.stringify({ theme: 'light' }),
  'utf8'
)

// WorkBuddy 会话库：sessions（当前会话/模型）+ session_usage（上下文 + 每请求积分）
const db = new DatabaseSync(path.join(tmpHome, 'workbuddy.db'))
db.exec(`
  CREATE TABLE sessions (
    id text primary key, cwd text, model text, title text, custom_title text,
    updated_at integer, last_activity_at integer, is_background_automation integer default 0, deleted_at integer
  );
  CREATE TABLE session_usage (
    session_id text primary key, used integer, size integer, updated_at integer, credit_json text
  );
`)
const SESSION = 'sess_smoke'
const transcriptFile = path.join(tmpHome, 'projects', 'smoke', SESSION + '.jsonl')
fs.mkdirSync(path.dirname(transcriptFile), { recursive: true })
function writeSession(model) {
  const t = Date.now()
  db.prepare(
    'INSERT OR REPLACE INTO sessions (id, cwd, model, title, custom_title, updated_at, last_activity_at, is_background_automation, deleted_at) VALUES (?,?,?,?,?,?,?,0,NULL)'
  ).run(SESSION, 'C:/work', model, '冒烟会话', null, t, t)
}
const hostCredits = {}
function writeUsage(used, size) {
  const t = Date.now()
  db.prepare('INSERT OR REPLACE INTO session_usage (session_id, used, size, updated_at, credit_json) VALUES (?,?,?,?,?)').run(
    SESSION,
    used,
    size,
    t,
    JSON.stringify(hostCredits)
  )
}
// 一轮 = 一条模型调用（同一 conversationRequestId）。credit 写进宿主 credit_json，
// rawUsage 用 WorkBuddy 口径（prompt_tokens 含缓存命中、completion 含思考）。
function appendTurn(turnId, model, input, output, credit, at) {
  const rawUsage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: input,
    prompt_cache_write_tokens: 0,
    completion_thinking_tokens: 0,
    credit,
  }
  const line = JSON.stringify({
    timestamp: at || Date.now(),
    type: 'function_call',
    providerData: { conversationRequestId: turnId, model, requestModelId: model, requestModelName: model, rawUsage },
  })
  fs.appendFileSync(transcriptFile, line + '\n')
}
function insertTurn(turnId, model, input, output, credit, at) {
  appendTurn(turnId, model, input, output, credit, at)
  hostCredits[turnId] = credit
  writeUsage(50_000, 200_000)
}
writeSession('glm-5.3')
writeUsage(50_000, 200_000)
insertTurn('turn_0', 'glm-5.3', 10, 10, 0) // 历史轮次：服务启动只对齐

// ---------- CDP 小客户端（Node 内置 WebSocket，无第三方依赖） ----------
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    // 页面内未捕获异常也收集起来：用例里的交互若触发了页面侧报错，assert 往往只看到
    // 「undefined 不是合法 JSON」这种间接症状，把真正的异常描述带出来便于定位
    this.exceptions = []
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params && msg.params.exceptionDetails
        const text = (d && (d.exception && d.exception.description || d.text)) || ''
        if (text) this.exceptions.push(String(text).split('\n').slice(0, 3).join(' | ').slice(0, 300))
      }
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
async function waitReady(port, deadlineMs, child) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const h = await (await fetch('http://127.0.0.1:' + port + '/whale/health', { signal: AbortSignal.timeout(1500) })).json()
      if (h && h.app === 'fox-widget') return h
    } catch (err) {}
    // 子进程已经退了就别再空等：早退多半是端口占用或启动即崩，日志里有原因
    if (child && child.exitCode !== null) return null
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
// 探针 + 重载重试：音效/角色列表是页面加载时一次性拉的，接口偶发一枪没回来就会
// 缺项，而且这两处不轮询、不会自愈——实测偶发过一次假失败。第一次拿不到就重载再试。
async function pollEvalReload(cdp, expression, deadlineMs, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const v = await pollEval(cdp, expression, deadlineMs)
    if (v) return v
    if (i < tries - 1) await cdp.send('Page.reload')
  }
  return null
}

const server = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'server.mjs')], {
  cwd: PLUGIN_ROOT,
  env: {
    ...process.env,
    CODEBUDDY_HOME: tmpHome,
    FOX_WIDGET_DATA_DIR: dataDir,
    // CommandCode 额度读取隔离：指向空目录，绝不读真实反代凭据、绝不真出网
    CMDGO_DIR: path.join(tmpHome, 'cmdgo-empty'),
    // 版本自检会向镜像发真实请求：冒烟环境关掉，更新面板改用 fetch 桩驱动
    WHALE_DISABLE_UPDATE_CHECK: '1',
  },
  // 接住服务日志：就绪失败时要能从 detail 里看出是端口占用还是启动崩
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (chunk) => (serverLog += chunk))
server.stderr.on('data', (chunk) => (serverLog += chunk))
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-smoke-profile-'))
let edge = null
let cdp = null
try {
  console.log('🖥️ 前端冒烟（' + path.basename(browser) + ' headless, 服务端口 ' + PORT + '）\n')
  // 启动等待给足 30 秒：机器忙时 node 冷启动可能远超 8 秒，曾被判成假失败
  const health = await waitReady(PORT, 30000, server)
  check('服务在临时端口就绪', !!health, health ? 'pid=' + health.pid : 'port=' + PORT + ' exitCode=' + server.exitCode + ' log=' + serverLog.slice(0, 400))
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

  // ① 每轮消耗气泡（WorkBuddy 主口径 = 订阅积分）：一轮 credit=12 → 标题
  //    「上一轮消耗:」，主数字「12.00 积分」，小字补调用次数 / 等价金额 / 上下文
  //    【弹泡时机】服务只在「轮次推进」时弹**上一轮**（WB 的积分逐次调用就落账，
  //    否则气泡会在本轮刚出首字时弹），所以每个被断言的轮次后跟一个 credit=0 触发轮
  insertTurn('turn_1', 'glm-5.3', 100_000, 20_000, 12)
  insertTurn('turn_1_adv', 'glm-5.3', 1000, 100, 0)
  const cost1 = JSON.parse(
    (await pollEval(
      cdp,
      "(function(){var l=document.querySelector('.zcwv-label'),a=document.querySelector('.zcwv-amount'),h=document.querySelector('.zcwv-hint');" +
        "if(!l||!a||l.textContent!=='本轮消耗：')return null;" +
        "return JSON.stringify({amount:a.textContent,hint:h&&h.style.display!=='none'?h.textContent:''})})()",
      20000
    )) || 'null'
  )
  check(
    '每轮消耗气泡显示「上一轮消耗: 12.00 积分」+ 小字（调用次数/上下文）',
    !!cost1 && cost1.amount === '12.00 积分' && String(cost1.hint).indexOf('次调用') !== -1 && String(cost1.hint).indexOf('上下文 25%') !== -1,
    JSON.stringify(cost1)
  )

  // ①b 智能跟随主显示：auto 模式下 WorkBuddy 恒定走 credits 源，
  //     主数字 = 今日积分（宿主 credit 合计），不再是 Plan 配额百分比
  const creditView = await pollEval(
    cdp,
    "(function(){var l=document.querySelector('.zcwv-label'),a=document.querySelector('.zcwv-amount');" +
      "if(!l||!a||l.textContent!=='今日积分')return null;" +
      "var t=a.textContent;if(!t||t==='…'||t==='--')return null;" +
      "return l.textContent+' | '+t})()",
    20000
  )
  check(
    'auto 跟随：主显示为「今日积分」（订阅积分口径，主数字是积分）',
    typeof creditView === 'string' && /^\d/.test(String(creditView).split(' | ')[1] || ''),
    'view=' + JSON.stringify(creditView)
  )

  // ①-2 再插一轮（credit=40）：气泡主数字跟进新轮次，且文字自适应不超出安全行宽
  insertTurn('turn_mix', 'deepseek-v4.1-flash', 90_000, 10_000, 40)
  insertTurn('turn_mix_adv', 'deepseek-v4.1-flash', 1000, 100, 0)
  const cost2 = JSON.parse(
    (await pollEval(
      cdp,
      "(function(){var l=document.querySelector('.zcwv-label'),a=document.querySelector('.zcwv-amount'),h=document.querySelector('.zcwv-hint');" +
        "if(!l||!a||l.textContent!=='本轮消耗：'||a.textContent!=='40.00 积分')return null;" +
        'var b=document.querySelector(\'.zcwv-bubble\').getBoundingClientRect();' +
        'var avail=560*(b.width/1026),r=document.createRange();r.selectNodeContents(h);' +
        'return JSON.stringify({amount:a.textContent,hint:h.style.display!==\'none\'?h.textContent:\'\',' +
        'w:Math.round(r.getBoundingClientRect().width),avail:Math.round(avail),' +
        'fs:h.style.fontSize,ws:h.style.whiteSpace})})()',
      20000
    )) || 'null'
  )
  check(
    '新一轮：气泡主数字跟进（40.00 积分）+ 小字含调用次数',
    !!cost2 && cost2.amount === '40.00 积分' && String(cost2.hint).indexOf('次调用') !== -1,
    JSON.stringify(cost2)
  )
  check(
    '气泡文字自适应：小字缩字/换行后不超出安全行宽',
    !!cost2 && Number(cost2.w) <= Number(cost2.avail) + 1 && (cost2.fs !== '' || cost2.ws === 'normal'),
    JSON.stringify(cost2)
  )

  // ①-3 credit=0 的轮次（宿主未扣费）：billable=false → 退 tokens 口径，不虚报金额
  insertTurn('turn_unk', 'zz-unknown-model', 3000, 2000, 0)
  insertTurn('turn_unk_adv', 'zz-unknown-model', 1000, 100, 0)
  const cost3 = JSON.parse(
    (await pollEval(
      cdp,
      "(function(){var l=document.querySelector('.zcwv-label'),a=document.querySelector('.zcwv-amount');" +
        "if(!l||!a||l.textContent!=='本轮 tokens：')return null;" +
        "return JSON.stringify({amount:a.textContent})})()",
      20000
    )) || 'null'
  )
  check('credit=0 的轮次退 tokens 口径（不虚报 0 积分）', !!cost3 && cost3.amount === '5,000', JSON.stringify(cost3))

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

  // ④ 按钮配色跟随 WorkBuddy 深色主题（中性表面，不是旧版亮蓝）。
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

  // ⑤ 手动切 DeepSeek 源：无 key 时错误文案必须完整换行显示
  // ——回归 slice(0,14) 把「未找到 DeepSeek API Key…」截成「未找到DeepSeek A」的缺陷
  await cdp.eval(
    "(function(){var ss=document.querySelectorAll('select');for(var i=0;i<ss.length;i++){var s=ss[i],vals=[];" +
      'for(var j=0;j<s.options.length;j++)vals.push(s.options[j].value);' +
      "if(vals.indexOf('plan')!==-1&&vals.indexOf('glm')!==-1&&vals.indexOf('ds')!==-1){" +
      "s.value='ds';s.dispatchEvent(new Event('change'));return true}}return false})()"
  )
  const dsView = await pollEval(
    cdp,
    "(function(){var l=document.querySelector('.zcwv-label'),h=document.querySelector('.zcwv-hint');" +
      "if(!l||!h||l.textContent!=='DeepSeek 余额')return null;" +
      "return {hint:h.textContent,wrap:h.className.indexOf('zcwv-wrap')!==-1}})()",
    12000
  )
  check(
    'DeepSeek 源错误文案完整显示（不截断 + 换行样式）',
    dsView && typeof dsView.hint === 'string' && dsView.hint.indexOf('未找到 DeepSeek API Key') !== -1 && dsView.wrap === true,
    JSON.stringify(dsView).slice(0, 160)
  )

  // ⑥ 手动切 GLM 按量：主显示标题换成 GLM 今日已用（不再是 DeepSeek 余额）
  await cdp.eval(
    "(function(){var ss=document.querySelectorAll('select');for(var i=0;i<ss.length;i++){var s=ss[i],vals=[];" +
      'for(var j=0;j<s.options.length;j++)vals.push(s.options[j].value);' +
      "if(vals.indexOf('plan')!==-1&&vals.indexOf('glm')!==-1&&vals.indexOf('ds')!==-1){" +
      "s.value='glm';s.dispatchEvent(new Event('change'));return true}}return false})()"
  )
  const glmView = await pollEval(
    cdp,
    "(function(){var l=document.querySelector('.zcwv-label');return l&&l.textContent==='GLM 今日已用'?l.textContent:null})()",
    12000
  )
  check('GLM 按量源主显示标题切换', glmView === 'GLM 今日已用', 'label=' + JSON.stringify(glmView))

  // ⑦ 角色：自定义下拉（不再是原生 select）——内置嘎啦嘛/大肥鱼无删除按钮，
  //    导入件行尾带小 × 与改名按钮
  await fetch('http://127.0.0.1:' + PORT + '/whale/role-upload.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '冒烟角色',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    }),
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  const roleView = await pollEval(
    cdp,
    // v1.3.2 起通用下拉（音效/主题等）复用 .zcwv-role-trigger 样式，必须按
    // title「选择形象」锁定角色触发器；列表按内容含「嘎啦嘛」锁定角色列表
    "(function(){var ts=document.querySelectorAll('.zcwv-role-trigger'),t=null;" +
      "for(var i=0;i<ts.length;i++){if((ts[i].title||'').indexOf('\\u9009\\u62e9\\u5f62\\u8c61')===0){t=ts[i];break}}" +
      'if(!t)return null;t.click();' +
      "var ls=document.querySelectorAll('.zcwv-roles'),list=null;" +
      "for(var i=0;i<ls.length;i++){if(ls[i].textContent.indexOf('\\u560e\\u5566\\u561b')!==-1){list=ls[i];break}}" +
      'var rows=list?list.querySelectorAll(\'.zcwv-role-row\'):[],names=[],del=0,builtin=0;' +
      "for(var i=0;i<rows.length;i++){var p=rows[i].querySelector('.zcwv-role-pick');names.push(p?p.textContent:'');" +
      'if(rows[i].querySelector(\'.zcwv-role-del\'))del++;if(rows[i].querySelector(\'.zcwv-role-builtin\'))builtin++}' +
      'return {names:names,del:del,builtin:builtin,open:!!(list&&list.classList.contains(\'zcwv-roles-open\')),' +
      "trigger:t.querySelector('.zcwv-role-name').textContent}})()",
    12000
  )
  check(
    '角色下拉：每行都有删除（内置形象也可删，v1.6.0）+ 触发器显示当前角色名',
    roleView &&
      roleView.names.indexOf('嘎啦嘛') !== -1 &&
      roleView.names.indexOf('大肥鱼') !== -1 &&
      roleView.names.indexOf('冒烟角色') !== -1 &&
      roleView.del === 7 &&
      roleView.builtin === 6 &&
      roleView.open === true &&
      roleView.trigger === '冒烟角色',
    JSON.stringify(roleView)
  )
  // 「内置」徽章文字居中（v1.7.2）：span 作为 flex 项被块化，只有 height 不做
  // 垂直对齐时 10px 文字贴顶——钉住 inline-flex + center
  const BADGE_PROBE =
    "(function(){var b=document.querySelector('.zcwv-role-builtin');if(!b)return null;" +
    'var cs=getComputedStyle(b);return JSON.stringify({display:cs.display,align:cs.alignItems,justify:cs.justifyContent})})()'
  const badgeView = JSON.parse((await pollEval(cdp, BADGE_PROBE, 8000)) || 'null')
  check(
    '「内置」徽章文字居中（flex + 双向 center；flex 项会把 inline-flex 块化为 flex）',
    !!badgeView &&
      ['flex', 'inline-flex'].indexOf(badgeView.display) !== -1 &&
      badgeView.align === 'center' &&
      badgeView.justify === 'center',
    JSON.stringify(badgeView)
  )

  // ⑦b 改名：点 ✎ 行内变输入框 → 回车提交 → 服务端与触发器同步
  await cdp.eval(
    "(function(){var rows=document.querySelectorAll('.zcwv-role-row');" +
      "for(var i=0;i<rows.length;i++){var mini=rows[i].querySelectorAll('.zcwv-role-mini');" +
      "if(mini.length&&mini[0]&&mini[0].textContent==='✎'){mini[0].click();return true}}return false})()"
  )
  const renameOk = await pollEval(
    cdp,
    "(function(){var inp=document.querySelector('.zcwv-role-rename');if(!inp)return null;" +
      "inp.value='改过名的冒烟角色';inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));return true})()",
    5000
  )
  await new Promise((r) => setTimeout(r, 900))
  const rolesAfterRename = await (await fetch('http://127.0.0.1:' + PORT + '/whale/roles.json')).json()
  const renamed = (rolesAfterRename.roles || []).find((r) => r && r.name === '改过名的冒烟角色')
  check('角色行内改名写入服务端', !!renameOk && !!renamed, JSON.stringify(renamed))

  // ⑦c 删除：第一次点 × 只进入确认态（「再点删除」），第二次才真的删；
  //     删掉的正好是当前形象 → 回落剩下的第一个形象（图片仍可用）。
  //     v1.6.0 起内置形象也有 ×，所以显式取最后一行（导入件在列表末尾）来测。
  const delArmed = await cdp.eval(
    "(function(){var bs=document.querySelectorAll('.zcwv-role-del');var b=bs[bs.length-1];if(!b)return null;b.click();" +
      "var a=document.querySelectorAll('.zcwv-role-del');return a[a.length-1].textContent})()"
  )
  check('删除按钮两步确认（第一次点击进入「再点删除」）', delArmed === '再点删除', JSON.stringify(delArmed))
  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('.zcwv-role-del');var b=bs[bs.length-1];if(b)b.click();return true})()"
  )
  await new Promise((r) => setTimeout(r, 1200))
  const rolesAfterDelete = await (await fetch('http://127.0.0.1:' + PORT + '/whale/roles.json')).json()
  const imgAfterDelete = await cdp.eval(
    "(function(){var img=document.querySelector('img[src*=\"image.png\"]');return img?img.naturalWidth:0})()"
  )
  check(
    '删除当前导入角色后回落默认嘎啦嘛（roles 只剩内置、图片 610px）',
    rolesAfterDelete.roles.length === 6 && rolesAfterDelete.roles.every((r) => r.builtin) &&
      rolesAfterDelete.selected === 'fox' && imgAfterDelete === 610,
    JSON.stringify({ n: rolesAfterDelete.roles.length, selected: rolesAfterDelete.selected, nw: imgAfterDelete })
  )
  // ⑦d 内置形象也能删（v1.6.0）：删掉「嘎啦嘛」→ 列表少一个、选中的不再是它、
  //     鲸鱼图片仍拿得到（回落到剩下的形象）
  const builtinDelArmed = await cdp.eval(
    "(function(){var rows=document.querySelectorAll('.zcwv-role-row'),t=null;" +
      "for(var i=0;i<rows.length;i++){var p=rows[i].querySelector('.zcwv-role-pick');" +
      "if(p&&p.textContent==='嘎啦嘛'){t=rows[i].querySelector('.zcwv-role-del')}}if(!t)return null;t.click();" +
      "var rows2=document.querySelectorAll('.zcwv-role-row');for(var j=0;j<rows2.length;j++){var p2=rows2[j].querySelector('.zcwv-role-pick');" +
      "if(p2&&p2.textContent==='嘎啦嘛'){var d=rows2[j].querySelector('.zcwv-role-del');return d?d.textContent:null}}return 'gone'})()"
  )
  check('内置形象也能两步删除（点一次进入「再点删除」）', builtinDelArmed === '再点删除', JSON.stringify(builtinDelArmed))
  await cdp.eval(
    "(function(){var rows=document.querySelectorAll('.zcwv-role-row');for(var i=0;i<rows.length;i++){var p=rows[i].querySelector('.zcwv-role-pick');" +
      "if(p&&p.textContent==='嘎啦嘛'){var d=rows[i].querySelector('.zcwv-role-del');if(d){d.click();return true}}}return false})()"
  )
  await new Promise((r) => setTimeout(r, 1200))
  const rolesAfterBuiltinDel = await (await fetch('http://127.0.0.1:' + PORT + '/whale/roles.json')).json()
  const imgAfterBuiltinDel = await cdp.eval(
    "(function(){var img=document.querySelector('img[src*=\"image.png\"]');return img?img.naturalWidth:0})()"
  )
  check(
    '删掉内置「嘎啦嘛」：列表不再有它、选中项换人、图片仍可用',
    rolesAfterBuiltinDel.roles.filter((r) => r.builtin).map((r) => r.id).join(',') === 'whale,gpt,kimi,xiaoke,gemini' &&
      rolesAfterBuiltinDel.selected !== 'fox' &&
      imgAfterBuiltinDel > 1,
    JSON.stringify({ builtins: rolesAfterBuiltinDel.roles.filter((r) => r.builtin).map((r) => r.id), selected: rolesAfterBuiltinDel.selected, nw: imgAfterBuiltinDel })
  )
  // 复原：把 hiddenBuiltins 清掉（= README 写的找回方式），内置形象回来
  const rolesIdxFile = path.join(dataDir, 'roles.json')
  const rolesIdx = JSON.parse(fs.readFileSync(rolesIdxFile, 'utf8'))
  rolesIdx.hiddenBuiltins = []
  fs.writeFileSync(rolesIdxFile, JSON.stringify(rolesIdx, null, 2), 'utf8')
  const rolesRestored = await (await fetch('http://127.0.0.1:' + PORT + '/whale/roles.json')).json()
  check(
    '清掉 hiddenBuiltins 后内置形象回来（README 的找回路径）',
    rolesRestored.roles.filter((r) => r.builtin).length === 6 && rolesRestored.roles.some((r) => r.builtin && r.id === 'gemini'),
    JSON.stringify(rolesRestored.roles.filter((r) => r.builtin).map((r) => r.id))
  )

  // ⑧ 主题：三个选项（浅色模式/深色模式/跟随 WorkBuddy）；「跟随 WorkBuddy」
  // 跟的是宿主的主题（preferences.theme），不是操作系统
  const themeOpts = JSON.parse(
    await cdp.eval(
      "(function(){var ss=document.querySelectorAll('select'),out=null;for(var i=0;i<ss.length;i++){var vals=[],texts=[];" +
        'for(var j=0;j<ss[i].options.length;j++){vals.push(ss[i].options[j].value);texts.push(ss[i].options[j].textContent)}' +
        "if(vals.indexOf('system')!==-1){out={vals:vals,texts:texts};break}}return JSON.stringify(out)})()"
    )
  )
  check(
    '主题下拉：浅色模式 / 深色模式 / 跟随 WorkBuddy',
    themeOpts &&
      themeOpts.vals.indexOf('light') !== -1 &&
      themeOpts.vals.indexOf('dark') !== -1 &&
      themeOpts.vals.indexOf('system') !== -1 &&
      themeOpts.texts.indexOf('浅色模式') !== -1 &&
      themeOpts.texts.indexOf('深色模式') !== -1 &&
      themeOpts.texts.indexOf('跟随 WorkBuddy') !== -1,
    JSON.stringify(themeOpts)
  )
  // 气泡配色随角色（浅色 + 深色两套）：未登记角色（用户导入的）回落到大肥鱼
  const ROLE_INK = {
    whale: { light: 'rgb(32, 49, 112)', dark: 'rgb(93, 141, 222)' },
    fox: { light: 'rgb(61, 68, 96)', dark: 'rgb(167, 167, 167)' },
    gpt: { light: 'rgb(123, 111, 196)', dark: 'rgb(211, 186, 231)' },
    kimi: { light: 'rgb(173, 129, 255)', dark: 'rgb(180, 184, 227)' },
    xiaoke: { light: 'rgb(217, 119, 87)', dark: 'rgb(217, 119, 87)' },
  }
  const curRole = (await (await fetch('http://127.0.0.1:' + PORT + '/whale/roles.json')).json()).selected
  const wantInk = ROLE_INK[curRole] || ROLE_INK.whale
  const readInk = async () =>
    JSON.parse(
      await cdp.eval(
        "(function(){var s=document.querySelector('.zcwv-bubble .zcwv-bshape');var t=document.querySelector('.zcwv-text');" +
          "return JSON.stringify({stroke:s?getComputedStyle(s).stroke:null,text:t?getComputedStyle(t).color:null," +
          "dark:document.documentElement.classList.contains('zcwv-theme-dark')})})()"
      )
    )
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, theme: 'light' }),
  })
  // 主题要重载页面才落地（与其他主题用例同一套做法）
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 2500))
  const inkLight = await readInk()
  check(
    '浅色：气泡描边与文字都按角色着色（未登记角色回落大肥鱼蓝）',
    !!inkLight && inkLight.dark === false && inkLight.stroke === wantInk.light && inkLight.text !== 'rgb(212, 212, 212)',
    JSON.stringify({ role: curRole, ink: inkLight })
  )
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, theme: 'dark' }),
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 2500))
  const inkDark = await readInk()
  check(
    '深色：气泡描边与文字也按角色着色（同一套角色映射）',
    !!inkDark && inkDark.dark === true && inkDark.stroke === wantInk.dark,
    JSON.stringify({ role: curRole, ink: inkDark })
  )
  // 把系统偏好模拟成深色，而 fixture 里 WorkBuddy 主题是 light（浅色）：
  // 页面必须仍是浅色 = 跟的是 WorkBuddy 而不是系统
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  })
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, theme: 'system' }),
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  const sysTheme = JSON.parse(
    await cdp.eval(
      "(function(){return JSON.stringify({dark:document.documentElement.classList.contains('zcwv-theme-dark')," +
        "prefers:window.matchMedia('(prefers-color-scheme: dark)').matches})})()"
    )
  )
  check(
    '主题「跟随 WorkBuddy」跟宿主主题（系统模拟深色、WorkBuddy 浅色 → 页面仍浅色）',
    sysTheme.prefers === true && sysTheme.dark === false,
    JSON.stringify(sysTheme)
  )
  await cdp.send('Emulation.setEmulatedMedia', { features: [] })

  // ⑧b 主题下拉已换成自定义组件（与角色下拉同款触发器 + 主题化列表）。
  // 回归：原生 select 的系统弹窗不吃主题，且弹出期间模态捕获全屏鼠标
  // （浮层里鲸鱼/菜单全点不动）；换自定义列表后整条链路走真实点击验证。
  // 菜单若没开，先真实点击菜单按钮（坐标都在页面里取好）
  const menuState = JSON.parse(
    await cdp.eval(
      "(function(){var open=document.querySelector('.zcwv-menu').classList.contains('zcwv-menu-open');" +
        'var b=document.querySelector(\'.zcwv-menu-btn\').getBoundingClientRect();' +
        'return JSON.stringify({open:open,x:b.left+b.width/2,y:b.top+b.height/2})})()'
    )
  )
  if (!menuState.open) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(menuState.x),
      y: Math.round(menuState.y),
      button: 'none',
      pointerType: 'mouse',
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(menuState.x),
      y: Math.round(menuState.y),
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(menuState.x),
      y: Math.round(menuState.y),
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    })
    await new Promise((r) => setTimeout(r, 400))
  }
  const themeTrigger = JSON.parse(
    await cdp.eval(
      "(function(){var ts=document.querySelectorAll('.zcwv-role-trigger');" +
        "for(var i=0;i<ts.length;i++){if((ts[i].title||'').indexOf('\\u9009\\u62e9\\u4e3b\\u9898')===0){" +
        'var r=ts[i].getBoundingClientRect();' +
        'return JSON.stringify({open:true,x:r.left+r.width/2,y:r.top+r.height/2,' +
        "label:ts[i].querySelector('.zcwv-role-name').textContent})}}return JSON.stringify({open:false})})()"
    )
  )
  check('找到主题下拉触发器（角色下拉同款）', themeTrigger && themeTrigger.open, JSON.stringify(themeTrigger))
  if (themeTrigger && themeTrigger.open) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(themeTrigger.x),
      y: Math.round(themeTrigger.y),
      button: 'none',
      pointerType: 'mouse',
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(themeTrigger.x),
      y: Math.round(themeTrigger.y),
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(themeTrigger.x),
      y: Math.round(themeTrigger.y),
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    })
    await new Promise((r) => setTimeout(r, 300))
    const ddState = JSON.parse(
      await cdp.eval(
        "(function(){var ls=document.querySelectorAll('.zcwv-roles.zcwv-roles-open'),hit=null;" +
          'for(var i=0;i<ls.length;i++){var head=ls[i].querySelector(\'.zcwv-roles-head\');' +
          "if(head&&head.textContent==='\\u4e3b\\u9898'){" +
          'var picks=ls[i].querySelectorAll(\'.zcwv-role-pick\'),texts=[],on=0;' +
          'for(var j=0;j<picks.length;j++){texts.push(picks[j].textContent);' +
          "if(picks[j].parentNode.className.indexOf('zcwv-role-row-on')!==-1)on++}" +
          'hit={n:picks.length,texts:texts,onRow:on}}}return JSON.stringify(hit)})()'
      )
    )
    check(
      '主题下拉打开为主题化列表（3 项：跟随/浅色/深色 + 当前项高亮）',
      ddState && ddState.n === 3 && ddState.onRow === 1 && ddState.texts.indexOf('深色模式') !== -1,
      JSON.stringify(ddState)
    )
    const darkPick = JSON.parse(
      await cdp.eval(
        "(function(){var ls=document.querySelectorAll('.zcwv-roles.zcwv-roles-open');" +
          'for(var i=0;i<ls.length;i++){var head=ls[i].querySelector(\'.zcwv-roles-head\');' +
          "if(head&&head.textContent==='\\u4e3b\\u9898'){var picks=ls[i].querySelectorAll('.zcwv-role-pick');" +
          "for(var j=0;j<picks.length;j++){if(picks[j].textContent==='\\u6df1\\u8272\\u6a21\\u5f0f'){" +
          'var r=picks[j].getBoundingClientRect();' +
          'return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})}}}}return null})()'
      )
    )
    if (darkPick) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: Math.round(darkPick.x),
        y: Math.round(darkPick.y),
        button: 'left',
        buttons: 1,
        clickCount: 1,
        pointerType: 'mouse',
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: Math.round(darkPick.x),
        y: Math.round(darkPick.y),
        button: 'left',
        buttons: 0,
        clickCount: 1,
        pointerType: 'mouse',
      })
      await new Promise((r) => setTimeout(r, 400))
    }
    const ddResult = JSON.parse(
      await cdp.eval(
        "(function(){var ts=document.querySelectorAll('.zcwv-role-trigger'),label=null;" +
          "for(var i=0;i<ts.length;i++){if((ts[i].title||'').indexOf('\\u9009\\u62e9\\u4e3b\\u9898')===0){" +
          "label=ts[i].querySelector('.zcwv-role-name').textContent}}" +
          "var ss=document.querySelectorAll('select'),val=null;" +
          "for(var k=0;k<ss.length;k++){var vs=[];for(var j=0;j<ss[k].options.length;j++)vs.push(ss[k].options[j].value);" +
          "if(vs.indexOf('system')!==-1)val=ss[k].value}" +
          'return JSON.stringify({dark:document.documentElement.classList.contains(\'zcwv-theme-dark\'),' +
          'label:label,val:val,listClosed:document.querySelectorAll(\'.zcwv-roles.zcwv-roles-open\').length===0})})()'
      )
    )
    check(
      '点「深色模式」后主题生效、触发器文字与 select.value 同步、列表收起',
      ddResult && ddResult.dark === true && ddResult.label === '深色模式' && ddResult.val === 'dark' && ddResult.listClosed === true,
      JSON.stringify(ddResult)
    )
  }

  // ⑧b 主题回滚回归（v1.8.1）：「大肥鱼蓝白」第四态已回滚——写 theme:'whale'
  // 必须被服务端归一成 light，页面不得出现 zcwv-theme-whale
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, theme: 'whale' }),
  })
  const rolledBack = (await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()).theme
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 2500))
  const noWhale = JSON.parse(
    await cdp.eval(
      "(function(){var ss=document.querySelectorAll('select'),vals=null;" +
        'for(var k=0;k<ss.length;k++){var vs=[];for(var j=0;j<ss[k].options.length;j++)vs.push(ss[k].options[j].value);' +
        "if(vs.indexOf('system')!==-1)vals=vs}" +
        'return JSON.stringify({theme:document.documentElement.className,' +
        'opts:vals})})()'
    )
  )
  check(
    '蓝白主题已回滚：theme=whale 不再被接受（保留前值），主题下拉只有 3 项',
    rolledBack !== 'whale' &&
      noWhale &&
      noWhale.theme.indexOf('zcwv-theme-whale') === -1 &&
      Array.isArray(noWhale.opts) &&
      noWhale.opts.length === 3 &&
      noWhale.opts.indexOf('whale') === -1,
    JSON.stringify({ rolledBack, opts: noWhale && noWhale.opts })
  )

  // ⑧c 桌宠模式（v1.8.0）：状态持久化走服务端；这一行只对浮层渲染
  // （浏览器模式没有「浮层显隐」这回事，整行不显示——断言这一点，防漂移）
  const petRowInBrowser = JSON.parse(
    await cdp.eval(
      "(function(){var rs=document.querySelectorAll('.zcwv-menu-row'),hit=null;" +
        "for(var i=0;i<rs.length;i++){if(rs[i].textContent.indexOf('桌宠模式')!==-1)hit=true}" +
        'return JSON.stringify({has:!!hit,hasFollow:document.body.textContent.indexOf("跟随延迟")!==-1})})()'
    )
  )
  check(
    '桌宠模式行:浏览器模式不渲染（与「跟随延迟」同为浮层专属）',
    petRowInBrowser && petRowInBrowser.has === false && petRowInBrowser.hasFollow === false,
    JSON.stringify(petRowInBrowser)
  )
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, petMode: true }),
  })
  const petOn = (await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()).petMode
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, petMode: false }),
  })
  const petOff = (await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()).petMode
  check('桌宠模式状态持久化（PUT true → 回读 true；再置 false → 回读 false）', petOn === true && petOff === false, JSON.stringify({ petOn, petOff }))

  // ⑧e 帧调度逃生门（v1.8.2）：渲染被遮挡节流时 CSS 过渡拿不到起始帧，浮层
  // UI 会「开了但停在透明态」。逃生门给 <html> 挂 zcwv-anim-off 关掉过渡——
  // 断言挂上后过渡时长真的归零（主线程样式不受节流影响，状态立即到位）。
  await cdp.eval("document.documentElement.classList.add('zcwv-anim-off')")
  const animOff = JSON.parse(
    await cdp.eval(
      "(function(){var m=document.querySelector('.zcwv-menu');return JSON.stringify({dur:getComputedStyle(m).transitionDuration})})()"
    )
  )
  await cdp.eval("document.documentElement.classList.remove('zcwv-anim-off')")
  const animOn = JSON.parse(
    await cdp.eval(
      "(function(){var m=document.querySelector('.zcwv-menu');return JSON.stringify({dur:getComputedStyle(m).transitionDuration})})()"
    )
  )
  check(
    '帧调度逃生门：zcwv-anim-off 时浮层 UI 过渡归零、摘除后恢复',
    !!animOff && animOff.dur.indexOf('0s') === 0 && !!animOn && animOn.dur.indexOf('0s') !== 0,
    JSON.stringify({ off: animOff, on: animOn })
  )

  // ⑧f 桌宠纵向贴顶（v1.8.2）：root 顶部 40.55% 是气泡区、角色 PNG 又常带
  // 透明边——按 root 整盒钳制的话角色永远拖不到屏幕顶。桌宠模式下纵向下界
  // 改按「角色图不透明内容」计算：拖到顶后 root 顶部允许伸出屏幕（top<0），
  // 而图片内容的可视上缘齐屏顶。浏览器模式下 petMode 经 PUT+reload 生效
  // （PUT 不通知运行中的页面，与真实浮层行为一致）。
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, petMode: true }),
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 2500))
  const dragTop = JSON.parse(
    await cdp.eval(
      "(function(){var img=document.querySelector('.zcwv-root img');var r=img.getBoundingClientRect();" +
        'return JSON.stringify({cx:r.left+r.width/2,cy:r.top+r.height/2})})()'
    )
  )
  async function injectedDrag(fromX, fromY, toX, toY) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(fromX), y: Math.round(fromY), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(fromX + ((toX - fromX) * i) / 10),
        y: Math.round(fromY + ((toY - fromY) * i) / 10),
        button: 'left',
        buttons: 1,
        pointerType: 'mouse',
      })
      await new Promise((r) => setTimeout(r, 25))
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(toX), y: Math.round(toY), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
    await new Promise((r) => setTimeout(r, 500))
  }
  await injectedDrag(dragTop.cx, dragTop.cy, dragTop.cx, 4)
  const afterTop = JSON.parse(
    await cdp.eval(
      "(function(){var root=document.querySelector('.zcwv-root');var img=document.querySelector('.zcwv-root img');" +
        'var rr=root.getBoundingClientRect();var ir=img.getBoundingClientRect();' +
        // 角色图的不透明内容上缘（画布实测，与 measureArtPads 同口径）：
        // 贴顶后它必须齐屏顶（img 盒顶可以带 PNG 自身的透明顶边略负）
        'var c=document.createElement("canvas");c.width=610;c.height=610;' +
        'var ctx=c.getContext("2d");ctx.drawImage(img,0,0,610,610);' +
        'var d=ctx.getImageData(0,0,610,610).data;var first=-1;' +
        'for(var y=0;y<610&&first<0;y++){for(var x=0;x<610;x++){if(d[(y*610+x)*4+3]>10){first=y;break}}}' +
        'var artTop=first<0?ir.top:ir.top+(first/610)*ir.height;' +
        'return JSON.stringify({rootTop:Math.round(rr.top),imgTop:Math.round(ir.top),artTop:Math.round(artTop),imgBottom:Math.round(ir.bottom),vh:innerHeight})})()'
    )
  )
  check(
    '桌宠贴顶：拖到屏顶后 root 允许伸出（top<0）且角色不透明内容齐屏顶',
    afterTop.rootTop < -80 && afterTop.artTop >= -3 && afterTop.artTop <= 8 && afterTop.imgBottom <= afterTop.vh + 1,
    JSON.stringify(afterTop)
  )
  // 气泡防裁切：贴顶时点鲸鱼出泡，气泡（锚在 root 顶部）应被整体下移、完整在屏内
  const clickPt = JSON.parse(
    await cdp.eval(
      "(function(){var r=document.querySelector('.zcwv-root img').getBoundingClientRect();" +
        'return JSON.stringify({cx:r.left+r.width/2,cy:r.top+r.height/2})})()'
    )
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(clickPt.cx), y: Math.round(clickPt.cy), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await new Promise((r) => setTimeout(r, 60))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(clickPt.cx), y: Math.round(clickPt.cy), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  await new Promise((r) => setTimeout(r, 600))
  const bubbleNudge = JSON.parse(
    await cdp.eval(
      "(function(){var b=document.querySelector('.zcwv-bubble');var r=b.getBoundingClientRect();" +
        'return JSON.stringify({open:b.classList.contains(\'zcwv-bubble-open\'),top:Math.round(r.top),style:b.style.top||""})})()'
    )
  )
  check(
    '桌宠贴顶出泡：气泡整体下移伸出量、完整在屏内',
    !!bubbleNudge && bubbleNudge.open === true && bubbleNudge.top >= 0,
    JSON.stringify(bubbleNudge)
  )
  // 还原：关桌宠 + 回到贴底位置（后续用例的深色配色断言不受位置影响，但
  // petMode 残留会让「浏览器模式不渲染桌宠行」类断言读到 true）
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, petMode: false }),
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 2500))

  // 后面的按钮配色断言针对深色主题，这里切回去（顺带验证 dark 仍能落盘生效）
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, theme: 'dark' }),
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))

  // ⑨ 预警：额度阈值泛化成一条「额度%」（GLM Plan + CommandCode 共用），
  // 与 DS¥/BM¥ 合并成的「余额¥」并列。v1.8.0 起这两格在记账二级页里
  // （面板行常驻 DOM，不必先打开面板）
  const alertRow = JSON.parse(
    await cdp.eval(
      "(function(){var rows=document.querySelectorAll('.zcwv-book-row'),hit=null;" +
        "for(var i=0;i<rows.length;i++){var t=rows[i].textContent;" +
        "if(t.indexOf('额度%')!==-1){hit={text:t,inputs:rows[i].querySelectorAll('input[type=number]').length}}}return JSON.stringify(hit)})()"
    )
  )
  check(
    '预警行：额度%（泛化）与余额¥ 同一行、两个输入框（且已收进记账二级页）',
    alertRow && alertRow.text.indexOf('余额¥') !== -1 && alertRow.inputs === 2 && alertRow.text.indexOf('DS¥') === -1 && alertRow.text.indexOf('BM¥') === -1,
    JSON.stringify(alertRow)
  )
  // ⑨d 记账二级页（v1.8.0 引入；v1.8.7 起用量记录回到一级菜单，本页只剩预警
  // 与校正）；面板能开能关（关掉是必须的——面板锚在鲸鱼头顶，留着会挡住后面
  // 用例的真实点击）
  const bookEntry = JSON.parse(
    await cdp.eval(
      "(function(){var ts=document.querySelectorAll('.zcwv-role-trigger'),nm=null;" +
        "for(var i=0;i<ts.length;i++){if((ts[i].title||'').indexOf('\\u9009\\u62e9\\u5f62\\u8c61')===0){" +
        "nm=ts[i].querySelector('.zcwv-role-name').textContent}}" +
        "var rs=document.querySelectorAll('.zcwv-menu-row'),label=null;" +
        "for(var i=0;i<rs.length;i++){var b=rs[i].querySelector('button');" +
        "if(b&&/^=.+记账=$/.test(b.textContent)){label=b.textContent}}return JSON.stringify({name:nm,label:label})})()"
    )
  )
  // 文案必须跟着当前形象走（本用例跑到这里时内置嘎啦嘛已被 ⑦d 删掉，选中的是大肥鱼）
  check(
    '记账入口在一级菜单，文案为「=角色名记账=」且随角色名',
    !!bookEntry && !!bookEntry.name && bookEntry.label === '=' + bookEntry.name + '记账=',
    JSON.stringify(bookEntry)
  )
  const bookOpened = JSON.parse(
    await cdp.eval(
      "(function(){var bs=document.querySelectorAll('.zcwv-menu-row button');" +
        "for(var i=0;i<bs.length;i++){if(/^=.+记账=$/.test(bs[i].textContent)){bs[i].click();" +
        "var p=document.querySelector('.zcwv-book');" +
        "return JSON.stringify({open:!!p&&p.classList.contains('zcwv-panel-open')," +
        "rows:p?p.querySelectorAll('.zcwv-book-row').length:0," +
        "hasUsage:!!p&&p.textContent.indexOf('用量记录')!==-1," +
        "inputs:p?p.querySelectorAll('input[type=number]').length:0})}}return null})()"
    )
  )
  // 4 个数字输入框 = 额度% + 余额¥ + 到账¥ + 扣减¥（校正收在这一页）；
  // 4 行 = 预警阈值 + 预警内容模板（DSH 移植：Plan / CmdGo / 余额三入口）+
  // 校正 + 其余行（结构见 buildBookPanel）；用量记录不在本页（v1.8.7 移回一级菜单）
  check(
    '记账二级页：入口可开，阈值 / 预警内容模板 / 校正齐备（4 行，无用量记录）',
    !!bookOpened && bookOpened.open === true && bookOpened.rows === 4 && bookOpened.hasUsage === false && bookOpened.inputs === 4,
    JSON.stringify(bookOpened)
  )
  const bookClosed = JSON.parse(
    await cdp.eval(
      "(function(){var p=document.querySelector('.zcwv-book');if(!p)return null;var bs=p.querySelectorAll('button');" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent==='返回'){bs[i].click();" +
        "return JSON.stringify({open:p.classList.contains('zcwv-panel-open')})}}return null})()"
    )
  )
  check('记账二级页：返回按钮收起面板', !!bookClosed && bookClosed.open === false, JSON.stringify(bookClosed))
  // ⑨e 预警内容模板的「出泡预览」与真出泡同源：预览要显示该预警来源自己的内置
  //     文案（Plan / CmdGo / 余额 三份各不相同），而不是当前计费源的内置视图——
  //     此前三个预览都显示同一份「今日积分 xx 高峰时段」，与实际出泡不符。
  async function alertPreviewText(label) {
    await cdp.eval(
      "(function(){var bs=document.querySelectorAll('.zcwv-menu-row button');" +
        "for(var i=0;i<bs.length;i++){if(/^=.+=\\u8bb0\\u8d26=$/.test(bs[i].textContent)){bs[i].click();break}}return true})()"
    )
    await new Promise((r) => setTimeout(r, 500))
    const clicked = await cdp.eval(
      "(function(){var p=document.querySelector('.zcwv-book');if(!p)return false;var bs=p.querySelectorAll('button');" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent==='" +
        label +
        "'){bs[i].click();return true}}return false})()"
    )
    if (!clicked) return null
    await new Promise((r) => setTimeout(r, 500))
    const preview = JSON.parse(
      await cdp.eval(
        "(function(){var ed=document.querySelector('.zcwv-editor');if(!ed)return JSON.stringify({err:'no-editor'});" +
          "var big=ed.querySelector('.zcwv-bprev-big');if(!big)return JSON.stringify({err:'no-preview'});" +
          "var out=[];var ls=big.querySelectorAll('.zcwv-bprev-line');" +
          "for(var k=0;k<ls.length;k++)out.push(ls[k].textContent);" +
          "return JSON.stringify({lines:out})})()"
      )
    )
    await cdp.eval(
      "(function(){var ed=document.querySelector('.zcwv-editor');if(!ed)return false;var bs=ed.querySelectorAll('button');" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent==='\\u5173\\u95ed'){bs[i].click();return true}}return false})()"
    )
    await new Promise((r) => setTimeout(r, 300))
    return preview && preview.lines ? preview.lines.join(' ') : null
  }
  const pvPlan = await alertPreviewText('Plan')
  const pvCmdgo = await alertPreviewText('CmdGo')
  const pvBalance = await alertPreviewText('\u4f59\u989d')
  check(
    '预警预览：Plan 模板的预览是 GLM Plan 的内置预警文案（不是当前计费源的内置视图）',
    typeof pvPlan === 'string' && pvPlan.indexOf('GLM Plan \u5269\u4f59') !== -1,
    JSON.stringify(pvPlan)
  )
  check(
    '预警预览：CmdGo 模板的预览是 CommandCode 的内置预警文案',
    typeof pvCmdgo === 'string' && pvCmdgo.indexOf('CommandCode') !== -1 && pvCmdgo.indexOf('GLM Plan') === -1,
    JSON.stringify(pvCmdgo)
  )
  check(
    '预警预览：余额模板的预览是 DeepSeek 余额预警文案（含阈值口径）',
    typeof pvBalance === 'string' && pvBalance.indexOf('DeepSeek \u4f59\u989d') !== -1 && pvBalance.indexOf('\u4f4e\u4e8e') !== -1,
    JSON.stringify(pvBalance)
  )
  // 用量记录回到一级菜单（v1.8.7）：菜单里恰有一个「用量记录…」按钮
  const usageInMenu = JSON.parse(
    await cdp.eval(
      "(function(){var bs=document.querySelectorAll('.zcwv-menu-row button');var n=0;" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent==='用量记录…')n++}return JSON.stringify({n:n})})()"
    )
  )
  check(
    '用量记录回到一级菜单：菜单里恰有一个「用量记录…」按钮',
    !!usageInMenu && usageInMenu.n === 1,
    JSON.stringify(usageInMenu)
  )

  // ⑨b UI 审查回归（v1.7.3）：U5 分隔线节点复用 / U3 下拉实色底 / U6 编辑器复选框类
  const menuStruct = JSON.parse(
    await cdp.eval(
      "(function(){var rs=document.querySelector('.zcwv-roles');var bg=getComputedStyle(rs).backgroundColor;" +
        'var alpha=bg.indexOf("rgba(")===0?Number(bg.split(",")[3]):1;' +
        'return JSON.stringify({seps:document.querySelectorAll(".zcwv-menu-sep").length,rolesAlpha:alpha,bg:bg})})()'
    )
  )
  check(
    '菜单结构：两条分隔线都在（U5 节点复用回归）、下拉列表底色不透明（U3）',
    !!menuStruct && menuStruct.seps === 2 && menuStruct.rolesAlpha === 1,
    JSON.stringify(menuStruct)
  )
  // 隐藏菜单按钮（移植 DSH）：开启后按钮不再出现、右键角色唤出菜单且落地持久化
  const hideRow = JSON.parse(
    await cdp.eval(
      "(function(){var rows=document.querySelectorAll('.zcwv-menu-row');" +
        "for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('隐藏菜单按钮')!==-1){" +
        "var c=rows[i].querySelector('input[type=checkbox]');if(!c)return null;c.click();" +
        "return JSON.stringify({found:true,checked:c.checked,cls:c.className})}}return null})()"
    )
  )
  // 悬停在角色上（原本会让按钮显形）也不该再出现按钮
  const whalePt = JSON.parse(
    await cdp.eval(
      "(function(){var r=document.querySelector('.zcwv-root img');" +
        "return JSON.stringify({x:Math.round(r.getBoundingClientRect().left+40),y:Math.round(r.getBoundingClientRect().top+40)})})()"
    )
  )
  await cdp.eval(
    "(function(){document.dispatchEvent(new PointerEvent('pointermove',{clientX:" +
      whalePt.x + ",clientY:" + whalePt.y + ",bubbles:true,pointerType:'mouse'}));return 'ok'})()"
  )
  // saveConfig 现在 300ms 去抖（UI 审查 I5），读落盘状态前要等过这个窗口
  await new Promise((r) => setTimeout(r, 700))
  const btnHidden = JSON.parse(
    await cdp.eval(
      "(function(){var b=document.querySelector('.zcwv-menu-btn');" +
        "return JSON.stringify({visible:b.classList.contains('zcwv-menu-btn-visible')," +
        "pe:getComputedStyle(b).pointerEvents})})()"
    )
  )
  const hideSaved = await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()
  check(
    '隐藏菜单按钮：开启后悬停也不显形（按钮已消失）且写入配置',
    !!hideRow && hideRow.found === true && hideRow.checked === true && hideRow.cls.indexOf('zcwv-check') !== -1 &&
      !!btnHidden && btnHidden.visible === false && btnHidden.pe === 'none' &&
      hideSaved.menuBtnHide === true,
    JSON.stringify({ row: hideRow, btn: btnHidden, saved: hideSaved.menuBtnHide })
  )
  // 关掉菜单（点界面之外）→ 右键角色重新唤出：位置与点按钮唤出一致（锚点仍是按钮矩形）
  await cdp.eval("(function(){document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}));return 'ok'})()")
  await new Promise((r) => setTimeout(r, 200))
  const menuClosed = JSON.parse(await cdp.eval("(function(){return JSON.stringify({open:document.querySelector('.zcwv-menu').classList.contains('zcwv-menu-open')})})()"))
  const openedByRight = JSON.parse(
    await cdp.eval(
      // 角色本体在画布右下（气泡占左上），右键得落在角色身上；逐个候选点试，
      // 落到气泡/面板（chrome）上的会被正确忽略，所以要多试几个
      '(function(){var img=document.querySelector(".zcwv-root img");var r=img.getBoundingClientRect();' +
        'var cands=[[0.72,0.62],[0.62,0.72],[0.82,0.55],[0.55,0.78],[0.68,0.5]];' +
        'var m=document.querySelector(".zcwv-menu");' +
        'for(var i=0;i<cands.length;i++){var x=Math.round(r.left+r.width*cands[i][0]),y=Math.round(r.top+r.height*cands[i][1]);' +
        'var t=document.elementFromPoint(x,y);' +
        'if(!t||t.closest(".zcwv-bubble")||t.closest(".zcwv-menu")||t.closest(".zcwv-panel"))continue;' +
        't.dispatchEvent(new MouseEvent("contextmenu",{clientX:x,clientY:y,bubbles:true,cancelable:true}));' +
        'if(m.classList.contains("zcwv-menu-open")){var mr=m.getBoundingClientRect();' +
        'return JSON.stringify({open:true,anchored:mr.left>0&&mr.top>0,tried:i+1})}}' +
        'return JSON.stringify({open:false,anchored:false,tried:cands.length})})()'
    )
  )
  check(
    '隐藏菜单按钮：右键角色可正常唤出菜单（菜单已收起后再唤出，位置锚点有效）',
    !!menuClosed && menuClosed.open === false && !!openedByRight && openedByRight.open === true && openedByRight.anchored === true,
    JSON.stringify({ closed: menuClosed, right: openedByRight })
  )
  // 复原：关掉菜单并把开关拨回（后续用例依赖按钮可点）
  await cdp.eval(
    "(function(){document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}));" +
      "var rows=document.querySelectorAll('.zcwv-menu-row');for(var i=0;i<rows.length;i++){" +
      "if(rows[i].textContent.indexOf('隐藏菜单按钮')!==-1){var c=rows[i].querySelector('input[type=checkbox]');" +
      "if(c&&c.checked)c.click()}}return 'ok'})()"
  )
  // 同上：saveConfig 300ms 去抖后再读落盘值
  await new Promise((r) => setTimeout(r, 700))
  const hideRestored = await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()
  check('隐藏菜单按钮：关闭后恢复原状（配置回 false）', hideRestored.menuBtnHide === false, JSON.stringify({ saved: hideRestored.menuBtnHide }))
  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++){" +
      "if(bs[i].textContent==='按压泡泡设置'){bs[i].click();return true}}return false})()"
  )
  const advChk = JSON.parse(
    await pollEval(
      cdp,
      "(function(){var c=document.querySelector('.zcwv-editor input[type=checkbox]');if(!c)return null;return JSON.stringify({cls:c.className,open:document.querySelectorAll('.zcwv-editor.zcwv-panel-open').length===1})})()",
      6000
    )
  )
  check(
    '按压泡泡编辑器：「点按推进队列」复选框带 zcwv-check（U6，accent 不落默认绿）',
    !!advChk && advChk.open === true && advChk.cls.indexOf('zcwv-check') !== -1,
    JSON.stringify(advChk)
  )
  // 出厂默认队列（无自定义配置时）：第二次点击是一个加权三选一（峰谷文字 /
  // 随机语句 / rua 动图），三张并排子卡各带权重角标——不再有"内置随机语句"
  // 这类不可编辑的壳（对照 DSH：默认内容同样是普通可编辑配置）
  const defQueue = JSON.parse(
    await pollEval(
      cdp,
      "(function(){var c=document.querySelectorAll('.zcwv-bq-card');var b=document.querySelectorAll('.zcwv-bq-wbadge');" +
        "if(!c.length)return null;return JSON.stringify({cards:c.length,badges:b.length})})()",
      6000
    )
  )
  let queueRole = null
  try {
    queueRole = (await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()).roleId
  } catch (err) {}
  const queueAllowsRua = queueRole === 'whale' || queueRole === 'xiaoke'
  check(
    '出厂默认队列：加权变体（大肥鱼/小克三选一，其他角色二选一）',
    !!defQueue && defQueue.badges === (queueAllowsRua ? 3 : 2) && defQueue.cards >= 4,
    JSON.stringify({ defQueue, role: queueRole, allowRua: queueAllowsRua })
  )
  // 调色板「直接拖进下方虚线框」（审查 P3-D 回归）：落点必须是面板里那个虚线框节点本身。
  // 曾经这里重复 var 出一个游离节点当落点，wirePointerDrop 的
  // elementFromPoint(...).closest('.zcwv-bq-chips') === zone 恒为 false ——
  // 拖拽静默失效，而「点一下加入」照常可用，所以人工点测发现不了。
  // 断定只能钉在「拖完模块真的进去了」上：游离节点不挂在文档里，站在外面查 DOM
  // 查不出它（querySelector 本来就只返回挂在文档里的那个，拿它自测恒真）。
  const stepOpen = await cdp.eval(
    "(function(){var cs=document.querySelectorAll('.zcwv-bq-card');for(var i=0;i<cs.length;i++){" +
      "if((cs[i].textContent||'').indexOf('首次点击')!==-1){cs[i].click();return 'ok'}}return 'no'})()"
  )
  const dropZone = JSON.parse(
    (await pollEval(
      cdp,
      "(function(){var z=document.querySelector('.zcwv-bq-chips');if(!z)return null;" +
        "var r=z.getBoundingClientRect();if(!r.width)return null;" +
        "var cx=Math.round(r.left+r.width/2),cy=Math.round(r.top+r.height/2);" +
        "var under=document.elementFromPoint(cx,cy);" +
        "return JSON.stringify({cx:cx,cy:cy,hit:!!(under&&under.closest&&under.closest('.zcwv-bq-chips')===z)," +
        "viewChips:document.querySelectorAll('.zcwv-bq-viewchip').length})})()",
      6000
    )) || 'null'
  )
  check(
    '调色板拖拽前置：编辑页就位（虚线框可命中、首泡仍是内置视图）',
    stepOpen === 'ok' && !!dropZone && dropZone.hit === true && dropZone.viewChips === 1,
    JSON.stringify({ stepOpen: stepOpen, dropZone: dropZone })
  )
  const palChip = JSON.parse(
    await cdp.eval(
      "(function(){var bs=document.querySelectorAll('.zcwv-field button');" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent==='余额数值'){var r=bs[i].getBoundingClientRect();" +
        "return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})}}" +
        "return JSON.stringify({x:0,y:0})})()"
    )
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: palChip.x, y: palChip.y, button: 'none', pointerType: 'mouse' })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: palChip.x, y: palChip.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  // 先横向挪过 6px 门槛（wirePointerDrop 的触发条件），再进虚线框
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: palChip.x + 24, y: palChip.y + 4, button: 'left', buttons: 1, pointerType: 'mouse' })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dropZone.cx, y: dropZone.cy, button: 'left', buttons: 1, pointerType: 'mouse' })
  await new Promise((r) => setTimeout(r, 300))
  const afterDrop = JSON.parse(
    await cdp.eval(
      "(function(){return JSON.stringify({viewChips:document.querySelectorAll('.zcwv-bq-viewchip').length," +
        "chips:document.querySelectorAll('.zcwv-bq-chips .zcwv-bq-chip').length})})()"
    )
  )
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dropZone.cx, y: dropZone.cy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
  check(
    '拖「余额数值」进虚线框：模块真的落进去了（内置视图被替换成文本模块）',
    !!afterDrop && afterDrop.viewChips === 0 && afterDrop.chips >= 1,
    JSON.stringify(afterDrop)
  )
  // 返回 = 取消这一泡的编辑，把面板还给后面的用例
  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('.zcwv-editor button');for(var i=0;i<bs.length;i++){" +
      "if(bs[i].textContent==='返回'){bs[i].click();return true}}return false})()"
  )
  await new Promise((r) => setTimeout(r, 200))
  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('.zcwv-editor button');for(var i=0;i<bs.length;i++){" +
      "if(bs[i].textContent==='关闭'){bs[i].click();return true}}return false})()"
  )
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, alerts: { quotaPct: 20, moneyAlert: 1.5 } }),
  })
  const alertBack = await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()
  check(
    '余额/额度预警阈值持久化（quotaPct + moneyAlert）',
    alertBack.alerts && alertBack.alerts.quotaPct === 20 && alertBack.alerts.moneyAlert === 1.5,
    JSON.stringify(alertBack.alerts)
  )
  // ⑨c UI 审查回归（U16）：额度阈值必须**回填进输入框**——v1.7.8 的 cmdgoPct 只写不读，
  // 用户设完一刷新页面输入框就显示 0、预警静默失效（挂件每个会话都会重新加载页面）
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  const quotaBackfill = JSON.parse(
    await cdp.eval(
      "(function(){var rows=document.querySelectorAll('.zcwv-book-row'),out=null;" +
        "for(var i=0;i<rows.length;i++){var t=rows[i].textContent;" +
        "if(t.indexOf('额度%')!==-1){var ins=rows[i].querySelectorAll('input[type=number]');" +
        "out={q:ins[0]?ins[0].value:null,m:ins[1]?ins[1].value:null}}}return JSON.stringify(out)})()"
    )
  )
  check(
    '额度阈值刷新后回填输入框（U16：只写不读回归）',
    !!quotaBackfill && quotaBackfill.q === '20' && quotaBackfill.m === '1.5',
    JSON.stringify(quotaBackfill)
  )

  // ⑩ 自定义气泡文字：首次点击显示自定义文字（占位符被替换），再点依次走队列，走完收起
  await fetch('http://127.0.0.1:' + PORT + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      first: { text: '冒烟首屏 {time}', size: 'B' },
      items: [{ text: '冒烟第二句', size: 'A' }, { text: '冒烟第三句', size: 'C' }],
    }),
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  const whaleAt = JSON.parse(
    await cdp.eval(
      "(function(){var img=document.querySelector('.zcwv-img').getBoundingClientRect();" +
        'return JSON.stringify({x:Math.round(img.left+img.width/2),y:Math.round(img.bottom-40)})})()'
    )
  )
  async function clickWhale() {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: whaleAt.x, y: whaleAt.y, button: 'none', pointerType: 'mouse' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: whaleAt.x, y: whaleAt.y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: whaleAt.x, y: whaleAt.y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    await new Promise((r) => setTimeout(r, 500))
  }
  await clickWhale()
  const firstText = await pollEval(
    cdp,
    "(function(){var a=document.querySelector('.zcwv-amount');return a&&a.style.display!=='none'?a.textContent:null})()",
    8000
  )
  check(
    '自定义「首次点击显示」渲染并替换占位符',
    typeof firstText === 'string' && firstText.indexOf('冒烟首屏') === 0 && firstText.indexOf('{time}') === -1,
    'first=' + JSON.stringify(firstText)
  )
  const bubbleRect = JSON.parse(
    await cdp.eval(
      "(function(){var b=document.querySelector('.zcwv-bubble').getBoundingClientRect();" +
        'return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+40)})})()'
    )
  )
  async function clickBubble() {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bubbleRect.x, y: bubbleRect.y, button: 'none', pointerType: 'mouse' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bubbleRect.x, y: bubbleRect.y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bubbleRect.x, y: bubbleRect.y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    await new Promise((r) => setTimeout(r, 700))
  }
  const bubbleText = async () =>
    cdp.eval(
      "(function(){var t=document.querySelector('.zcwv-text');var parts=[];" +
        "var ns=t.querySelectorAll('div');for(var i=0;i<ns.length;i++){if(ns[i].style.display!=='none'&&ns[i].textContent)parts.push(ns[i].textContent)}" +
        "return parts.join('|')})()"
    )
  await clickBubble()
  const step2 = await bubbleText()
  await clickBubble()
  const step3 = await bubbleText()
  await clickBubble()
  const step4 = await cdp.eval("document.querySelector('.zcwv-bubble').classList.contains('zcwv-bubble-open')")
  check(
    '自定义「再次点击显示」按队列推进并在走完后收起',
    typeof step2 === 'string' && step2.indexOf('冒烟第二句') !== -1 && step3.indexOf('冒烟第三句') !== -1 && step4 === false,
    JSON.stringify({ step2: step2, step3: step3, open: step4 })
  )
  await fetch('http://127.0.0.1:' + PORT + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, first: null, items: [] }),
  })
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

  // ⑪ MiMo Token Plan 计费源：标题随源切换 + 时段行改用配额口径
  // （复审缺失测试 #3：MiMo Plan 夜间 0.8x 只有服务端断言，前端展示无覆盖）
  // 用 fetch 桩喂一个 mimo-plan 会话，Math.random 固定为 0 → 随机台词组必中 group1
  // （权重 45 在第一位，r=0 必落它），于是时段行可确定性断言。
  const stubScript = (withOpenAiUsage) =>
    '(function(){var real=window.fetch;' +
    'function json(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{"Content-Type":"application/json"}}))}' +
    'var S={ok:true,source:"mimo-plan",vendor:"mimo",label:"MiMo Token Plan",timeMode:"offpeak-x0.8",modelId:"mimo-v2.6-pro",currency:"CNY",from:"selection"};' +
    'var U=' +
    (withOpenAiUsage
      ? '{ok:true,today:{total:1.2,tokens:1000,totals:{USD:1.2},models:[{model:"gpt-5.6-terra",vendorLabel:"OpenAI",amount:1.2,tokens:1000,currency:"USD"}]}}'
      : '{ok:true,today:{total:0,tokens:0,totals:{},models:[]}}') +
    ';Math.random=function(){return 0};' +
    'window.fetch=function(u,o){var s=String(u&&u.url?u.url:u);' +
    'if(s.indexOf("/whale/session.json")!==-1)return json(S);' +
    'if(s.indexOf("/whale/usage-records.json")!==-1)return json(U);' +
    'return real.apply(this,arguments)}})()'

  const putSize = (body) =>
    fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json())

  await putSize({ scale: 1.5, theme: 'dark', displayMode: 'auto', alerts: { quotaPct: 0, moneyAlert: 0 } })
  const stubA = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stubScript(false) })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 4000))
  const mimoLabel = await cdp.eval("(function(){var n=document.querySelector('.zcwv-label');return n?n.textContent:null})()")
  check(
    'MiMo Plan 计费源：气泡标题随源切换（MiMo Plan 今日消耗）',
    mimoLabel === 'MiMo Plan 今日消耗',
    'label=' + JSON.stringify(mimoLabel)
  )
  await clickWhale()
  await clickBubble()
  const mimoPeriod = await bubbleText()
  check(
    'MiMo Plan 时段行改用配额口径（常规时段 / 配额 0.8x），不出现高峰·空闲时段',
    typeof mimoPeriod === 'string' &&
      (mimoPeriod.indexOf('常规时段') !== -1 || mimoPeriod.indexOf('配额 0.8x') !== -1) &&
      mimoPeriod.indexOf('高峰时段') === -1 &&
      mimoPeriod.indexOf('空闲时段') === -1,
    'text=' + JSON.stringify(mimoPeriod)
  )
  // size.json 的 PUT 要求带 scale（缺了会被 400 拒掉），其余字段才合并
  await putSize({ scale: 1.5, displayMode: 'ds' })
  // displayMode 由页面每 60 秒拉一次配置，改完必须重载才会生效
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3500))
  await clickWhale()
  await clickBubble()
  const dsPeriod = await bubbleText()
  check(
    '对照：DeepSeek 峰谷源仍显示高峰/空闲时段（配额口径不外溢）',
    typeof dsPeriod === 'string' && (dsPeriod.indexOf('高峰时段') !== -1 || dsPeriod.indexOf('空闲时段') !== -1),
    'text=' + JSON.stringify(dsPeriod)
  )
  // ⑪+ 峰谷倒计时 + 流光（对齐上游「时段倒计时」）：{countdown} 占位符出
  // HH:MM:SS，行挂红/绿系流光渐变，活动行 ticker 逐秒原地走字
  const dsCount = typeof dsPeriod === 'string' ? (dsPeriod.match(/\d{2}:\d{2}:\d{2}/) || [null])[0] : null
  check('峰谷倒计时：时段行带 HH:MM:SS（{countdown} 占位符）', !!dsCount, 'text=' + JSON.stringify(dsPeriod))
  const flowCls = await cdp.eval(
    "(function(){var n=document.querySelector('.zcwv-text .zcwv-flow');if(!n)return null;" +
      "return n.className.indexOf('zcwv-flow-peak')!==-1?'peak':(n.className.indexOf('zcwv-flow-off')!==-1?'off':'?')})()"
  )
  check('峰谷流光：倒计时行挂红/绿系流光渐变（zcwv-flow-peak/off）', flowCls === 'peak' || flowCls === 'off', JSON.stringify(flowCls))
  const cd1 = await cdp.eval(
    "(function(){var ns=document.querySelectorAll('.zcwv-text .zcwv-flow');for(var i=0;i<ns.length;i++){if(/\\d{2}:\\d{2}:\\d{2}/.test(ns[i].textContent))return ns[i].textContent}return null})()"
  )
  await new Promise((r) => setTimeout(r, 1300))
  const cd2 = await cdp.eval(
    "(function(){var ns=document.querySelectorAll('.zcwv-text .zcwv-flow');for(var i=0;i<ns.length;i++){if(/\\d{2}:\\d{2}:\\d{2}/.test(ns[i].textContent))return ns[i].textContent}return null})()"
  )
  check('峰谷倒计时逐秒走字（1.3s 后读数变化，原地改写）', !!cd1 && !!cd2 && cd1 !== cd2, JSON.stringify({ t1: cd1, t2: cd2 }))
  // ⑪b2 U33：流光必须在「减少动态效果」下停住（原实现只靠全局 !important 名单，
  // 而那条名单没点名 .zcwv-flow，等于开着系统设置也照跑 2.6s 循环横扫）。
  // 用 CDP 真开一次媒体模拟，按计算样式断言，而不是只看选择器写没写。
  {
    const flowAnimBefore = await cdp.eval(
      "(function(){var n=document.querySelector('.zcwv-text .zcwv-flow');if(!n)return null;" +
        "var cs=getComputedStyle(n);return JSON.stringify({name:cs.animationName,dur:cs.animationDuration})})()"
    )
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await new Promise((r) => setTimeout(r, 300))
    const flowAnimAfter = await cdp.eval(
      "(function(){var n=document.querySelector('.zcwv-text .zcwv-flow');if(!n)return null;" +
        "var cs=getComputedStyle(n);return JSON.stringify({name:cs.animationName,dur:cs.animationDuration," +
        "bg:cs.backgroundImage})})()"
    )
    await cdp.send('Emulation.setEmulatedMedia', { features: [] })
    await new Promise((r) => setTimeout(r, 200))
    const flowAnimBack = await cdp.eval(
      "(function(){var n=document.querySelector('.zcwv-text .zcwv-flow');if(!n)return null;" +
        "return getComputedStyle(n).animationName})()"
    )
    const parsedBefore = (() => {
      try {
        return JSON.parse(flowAnimBefore)
      } catch (err) {
        return null
      }
    })()
    const parsedAfter = (() => {
      try {
        return JSON.parse(flowAnimAfter)
      } catch (err) {
        return null
      }
    })()
    check(
      'U33：开启「减少动态效果」后流光停止（animation:none），语义渐变仍在，关掉后恢复',
      !!parsedBefore &&
        parsedBefore.name === 'zcwvFlow' &&
        !!parsedAfter &&
        parsedAfter.name === 'none' &&
        /gradient/.test(String(parsedAfter.bg)) &&
        flowAnimBack === 'zcwvFlow',
      JSON.stringify({ before: parsedBefore, reduced: parsedAfter, back: flowAnimBack })
    )
  }
  // ⑪c 图挂降级：gif error 置 gifFailed 后，纯图步（r=0.99 确定性命中权重 5 的
  // 图片变体）降级成一句备胎文案，不再渲染破图。rua 只在大肥鱼/小克身上，
  // 先切到大肥鱼再测。
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, roleId: 'whale' }),
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 2500))
  await cdp.eval(
    'Math.random=function(){return 0.99};' +
      "(function(){var g=document.querySelector('.zcwv-gif');if(g)g.dispatchEvent(new Event('error'));return true})()"
  )
  await clickWhale()
  await clickBubble()
  const gifFailText = await bubbleText()
  const gifHidden = await cdp.eval("(function(){var g=document.querySelector('.zcwv-gif');return g?g.style.display==='none':false})()")
  check(
    '图挂降级：纯图步出备胎文案（gif 加载失败/没有动图给你看/动图不见了），不再渲染破图',
    typeof gifFailText === 'string' &&
      (gifFailText.indexOf('gif 加载失败') !== -1 ||
        gifFailText.indexOf('没有动图给你看') !== -1 ||
        gifFailText.indexOf('动图不见了') !== -1) &&
      gifHidden === true,
    JSON.stringify({ text: gifFailText, hidden: gifHidden })
  )
  // ⑪d 点角色续时（对齐上游 whaleClick 第 1 泡语义）：第 1 泡显示中再点角色只
  // 重置计时，不重置队列不重绘——label 上打的标记必须原样保留。balance/usage
  // 两个桩都慢 2 秒返回：第二次点击时 refresh 与 refreshUsageSummary（点角色
  // 都会触发）仍 busy/在途，窗口内没有任何重绘来源；两拍成功渲染写的都是
  // 同一份内容，生产里视觉无感，与续时分支无关。
  await cdp.eval(
    '(function(){var real=window.fetch;var slow=function(obj){return new Promise(function(res){' +
      'setTimeout(function(){res(new Response(JSON.stringify(obj),{status:200,headers:{"Content-Type":"application/json"}}))},2000)})};' +
      'window.fetch=function(u,o){var s=String(u&&u.url?u.url:u);' +
      "if(s.indexOf('/whale/balance.json')!==-1)return slow({ok:true,totalBalance:1.23,currency:'CNY',todayUsage:0.45,isPeak:false,peakNextChangeAt:9999999999});" +
      "if(s.indexOf('/whale/usage-records.json')!==-1)return slow({ok:false,error:'stub'});" +
      'return real.apply(this,arguments)};return true})()'
  )
  await clickWhale() // 正在引语/降级步（index 1）→ 回到序列开头（视图步）
  await cdp.eval("(function(){document.querySelector('.zcwv-label').textContent='TTL续时标记';return true})()")
  await clickWhale() // 第 1 泡显示中再点 → 仅续时
  const markNow = await cdp.eval(
    "(function(){return {t:document.querySelector('.zcwv-label').textContent," +
      "open:document.querySelector('.zcwv-bubble').classList.contains('zcwv-bubble-open')}})()"
  )
  check(
    '点角色续时：第 1 泡显示中再点角色不重绘（标记原样保留）且气泡仍开着',
    !!markNow && markNow.t === 'TTL续时标记' && markNow.open === true,
    JSON.stringify(markNow)
  )
  if (stubA && stubA.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubA.identifier })

  // ⑪b 厂商余额进气泡小字（v1.8.8）：有官方余额模板的按量厂商（Kimi/Moonshot），
  // 服务端把模板余额附进 session.json（vendorBalance），小字显示「· 余额 ¥ x」，
  // 主数字保持今日已用。桩直接给 vendorBalance + Kimi 的 byVendor 用量。
  await putSize({ scale: 1.5, theme: 'dark', displayMode: 'auto', alerts: { quotaPct: 0, moneyAlert: 0 } })
  const stubVendor = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      '(function(){var real=window.fetch;function json(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{"Content-Type":"application/json"}}))}' +
      'var S={ok:true,source:"kimi",vendor:"kimi",label:"Kimi 今日已用",timeMode:"none",modelId:"kimi-k3",currency:"CNY",from:"selection",vendorBalance:{id:"moonshot-cn",amount:8.508731,currency:"CNY"}};' +
      'var U={ok:true,today:{total:0.28,tokens:54000,totals:{CNY:0.28},byVendor:{Kimi:{amount:0.28,tokens:54000,currency:"CNY"}},models:[]}};' +
      'window.fetch=function(u,o){var s=String(u&&u.url?u.url:u);' +
      'if(s.indexOf("/whale/session.json")!==-1)return json(S);' +
      'if(s.indexOf("/whale/usage-records.json")!==-1)return json(U);' +
      'return real.apply(this,arguments)}})()',
  })
  await cdp.send('Page.reload')
  // 首次用量拉取在页面加载后 8 秒（setTimeout(refreshUsageSummary, 8000)），
  // amount/hint 依赖 usageToday，必须等过这个节拍
  await new Promise((r) => setTimeout(r, 9500))
  const kimiView = JSON.parse(
    await cdp.eval(
      "(function(){var l=document.querySelector('.zcwv-label'),a=document.querySelector('.zcwv-amount'),h=document.querySelector('.zcwv-hint');" +
        'return JSON.stringify({label:l?l.textContent:null,amount:a?a.textContent:null,hint:h?h.textContent:null})})()'
    )
  )
  check(
    'Kimi 余额主显示（v1.8.9 重构）：label「Kimi 余额」、amount ¥ 8.51、hint 今日已用 ¥0.28',
    !!kimiView && kimiView.label === 'Kimi 余额' && kimiView.amount === '¥8.51' &&
      typeof kimiView.hint === 'string' && kimiView.hint.indexOf('今日已用 ¥0.28') !== -1,
    JSON.stringify(kimiView)
  )
  if (stubVendor && stubVendor.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubVendor.identifier })

  // ⑫ 消费型预警已取消（v1.7.7）：美元厂商今日已用再大也不弹预警泡，「余额¥」
  // 只剩 DeepSeek 余额见底一个语义（冒烟环境没有 DS key，凑不出余额见底，负向
  // 断言：喂 OpenAI 消耗数据后 9 秒内不得出现任何「预警」标题的泡泡）
  await putSize({ scale: 1.5, theme: 'dark', displayMode: 'auto', alerts: { quotaPct: 0, moneyAlert: 5 } })
  const stubB = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stubScript(true) })
  await cdp.send('Page.reload')
  let alertSeen = null
  for (let i = 0; i < 30; i++) {
    const label = await cdp.eval("(function(){var l=document.querySelector('.zcwv-label');return l?l.textContent:null})()")
    if (label === '余额预警' || label === '消费预警') {
      alertSeen = label
      break
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  check(
    '消费型预警已取消：OpenAI 今日已用超阈值不再弹预警泡',
    !alertSeen,
    'saw=' + JSON.stringify(alertSeen)
  )
  if (stubB && stubB.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubB.identifier })
  await putSize({ scale: 1.5, theme: 'dark', displayMode: 'auto', alerts: { quotaPct: 0, moneyAlert: 0 } })

  // ⑬ Plan 观测 stale（客户端今天还没刷新过日志）：显示旧值 + 「数据截至」
  //    日期标注，而不是一直挂在「加载中…」（v1.4.1）
  const staleStub = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      '(function(){var real=window.fetch;function json(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{"Content-Type":"application/json"}}))}' +
      'var S={ok:true,source:"plan",vendor:"zcode-plan",label:"GLM Plan 配额",timeMode:"none",modelId:"GLM-5.3-Flash",currency:"CNY",from:"selection"};' +
      'var P={ok:true,source:"plan-log",logDate:"2026-09-01",stale:true,observedAt:Date.now(),serverTime:Math.floor(Date.now()/1000),remaining:240000,total:10000000,used:9760000,percentRemaining:0.024,percentUsed:0.976,nextResetAt:null,byModel:[],plans:[]};' +
      'window.fetch=function(u,o){var s=String(u&&u.url?u.url:u);' +
      'if(s.indexOf("/whale/session.json")!==-1)return json(S);' +
      'if(s.indexOf("/whale/plan.json")!==-1)return json(P);' +
      'return real.apply(this,arguments)}})()',
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3500))
  const staleView = await pollEval(
    cdp,
    "(function(){var l=document.querySelector('.zcwv-label'),a=document.querySelector('.zcwv-amount'),h=document.querySelector('.zcwv-hint');" +
      "if(!l||!a||l.textContent!=='GLM Plan 配额')return null;" +
      "return JSON.stringify({amount:a.textContent,hint:h.textContent})})()",
    15000
  )
  const staleObj = staleView ? JSON.parse(staleView) : null
  check(
    'Plan 观测 stale 时显示旧值并标注数据日期（不再永远「加载中…」）',
    !!staleObj && staleObj.amount === '2.4%' && String(staleObj.hint).indexOf('数据截至 09-01') !== -1,
    JSON.stringify(staleObj)
  )
  if (staleStub && staleStub.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: staleStub.identifier })

  // ⑮ 用量记录：今日模型排名可在「按金额（积分口径）/ 按 Token」之间切换。
  // 先补两轮让两个榜的头部必然不同：qwen3-max 积分高、token 少 →
  // 积分榜第一；kimi-k3 积分低、token 巨大 → token 榜第一。
  insertTurn('turn_rank_amt', 'qwen3-max', 900, 100, 200)
  insertTurn('turn_rank_tok', 'kimi-k3', 800_000, 100_000, 1)
  // 3 天前的历史轮次：old-model 只在 7 天榜里出现，token 足够大，必然占据
  // 7 天 token 榜首位（当天 token 第一仍是 kimi-k3）。
  insertTurn('turn_week', 'old-model', 9_000_000, 1_000_000, 0, Date.now() - 3 * 86400000)
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++){" +
      "if(bs[i].textContent==='用量记录…'){bs[i].click();return true}}return false})()"
  )
  const RANK_PROBE =
    "(function(){var bs=document.querySelectorAll('.zcwv-panel .zcwv-panel-close');var label=null;" +
    "for(var i=0;i<bs.length;i++){var t=bs[i].textContent;if(t==='按金额'||t==='按 Token')label=t}" +
    "if(!label)return null;var rows=document.querySelectorAll('.zcwv-panel .zcwv-row'),first='';" +
    "for(var j=0;j<rows.length;j++){var c=rows[j].firstChild,txt=c?c.textContent:'';" +
    "if(/^\\d+\\. /.test(txt)){first=txt;break}}" +
    'return JSON.stringify({label:label,first:first})})()'
  // 等「按 Token」出现才算切成功（fetchUsage 是异步的，点完立刻读会拿到旧 DOM）
  const RANK_PROBE_TOKENS =
    "(function(){var bs=document.querySelectorAll('.zcwv-panel .zcwv-panel-close');var label=null;" +
    "for(var i=0;i<bs.length;i++){var t=bs[i].textContent;if(t==='按金额'||t==='按 Token')label=t}" +
    "if(label!=='按 Token')return null;var rows=document.querySelectorAll('.zcwv-panel .zcwv-row'),first='';" +
    "for(var j=0;j<rows.length;j++){var c=rows[j].firstChild,txt=c?c.textContent:'';" +
    "if(/^\\d+\\. /.test(txt)){first=txt;break}}" +
    'return JSON.stringify({label:label,first:first})})()'
  const rankAmount = JSON.parse((await pollEval(cdp, RANK_PROBE, 8000)) || 'null')
  check(
    '用量记录：默认按金额（积分）排名（第一位是积分最高的 qwen3-max）',
    !!rankAmount && rankAmount.label === '按金额' && rankAmount.first.indexOf('qwen3-max') !== -1,
    JSON.stringify(rankAmount)
  )
  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('.zcwv-panel .zcwv-panel-close');for(var i=0;i<bs.length;i++){" +
      "var t=bs[i].textContent;if(t==='按金额'||t==='按 Token'){bs[i].click();return true}}return false})()"
  )
  const rankTokens = JSON.parse((await pollEval(cdp, RANK_PROBE_TOKENS, 8000)) || 'null')
  check(
    '用量记录：切到按 Token 排名（第一位变成 token 最大的 kimi-k3）',
    !!rankTokens && rankTokens.label === '按 Token' && rankTokens.first.indexOf('kimi-k3') !== -1,
    JSON.stringify(rankTokens)
  )
  check(
    '用量记录：两个口径的第一名不同（说明真的换了排序）',
    !!rankAmount && !!rankTokens && rankAmount.first !== rankTokens.first,
    JSON.stringify({ amount: rankAmount && rankAmount.first, tokens: rankTokens && rankTokens.first })
  )
  const rankBtnGap = JSON.parse(
    (await cdp.eval(
      "(function(){var bs=document.querySelectorAll('.zcwv-panel .zcwv-panel-close');var a=null,b=null;" +
        "for(var i=0;i<bs.length;i++){var t=bs[i].textContent;if(t==='按当天'||t==='按7天')a=bs[i];if(t==='按金额'||t==='按 Token')b=bs[i]}" +
        'if(!a||!b)return null;var ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return JSON.stringify({gap:Math.round(rb.left-ra.right)})})()'
    )) || 'null'
  )
  check(
    '用量记录：范围/口径两个按钮并排（不再被 space-between 拉到两端）',
    !!rankBtnGap && rankBtnGap.gap >= 0 && rankBtnGap.gap <= 12,
    JSON.stringify(rankBtnGap)
  )
  // ⑮a 模型排名范围切换：按当天 ↔ 按 7 天。当前口径仍是「按 Token」，
  // 3 天前的 old-model（10M tokens）应只在 7 天榜里出现并排第一；切回当天后
  // 又回到当天的 token 第一（kimi-k3）。
  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('.zcwv-panel .zcwv-panel-close');for(var i=0;i<bs.length;i++){" +
      "var t=bs[i].textContent;if(t==='按当天'||t==='按7天'){bs[i].click();return true}}return false})()"
  )
  const SCOPE_PROBE =
    "(function(){var bs=document.querySelectorAll('.zcwv-panel .zcwv-panel-close');var scope=null;" +
    "for(var i=0;i<bs.length;i++){var t=bs[i].textContent;if(t==='按当天'||t==='按7天')scope=t}" +
    "if(scope!=='按7天')return null;var rows=document.querySelectorAll('.zcwv-panel .zcwv-row'),first='';" +
    "for(var j=0;j<rows.length;j++){var c=rows[j].firstChild,txt=c?c.textContent:'';" +
    "if(/^\\d+\\. /.test(txt)){first=txt;break}}" +
    'return JSON.stringify({scope:scope,first:first})})()'
  const scopeWeek = JSON.parse((await pollEval(cdp, SCOPE_PROBE, 8000)) || 'null')
  check(
    '用量记录：切到按 7 天后，3 天前的 old-model 进入 token 榜并排第一',
    !!scopeWeek && scopeWeek.scope === '按7天' && scopeWeek.first.indexOf('old-model') !== -1,
    JSON.stringify(scopeWeek)
  )
  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('.zcwv-panel .zcwv-panel-close');for(var i=0;i<bs.length;i++){" +
      "var t=bs[i].textContent;if(t==='按当天'||t==='按7天'){bs[i].click();return true}}return false})()"
  )
  const SCOPE_BACK_PROBE =
    "(function(){var bs=document.querySelectorAll('.zcwv-panel .zcwv-panel-close');var scope=null;" +
    "for(var i=0;i<bs.length;i++){var t=bs[i].textContent;if(t==='按当天'||t==='按7天')scope=t}" +
    "if(scope!=='按当天')return null;var rows=document.querySelectorAll('.zcwv-panel .zcwv-row'),first='';" +
    "for(var j=0;j<rows.length;j++){var c=rows[j].firstChild,txt=c?c.textContent:'';" +
    "if(/^\\d+\\. /.test(txt)){first=txt;break}}" +
    'return JSON.stringify({scope:scope,first:first})})()'
  const scopeToday = JSON.parse((await pollEval(cdp, SCOPE_BACK_PROBE, 8000)) || 'null')
  check(
    '用量记录：切回按当天后，old-model 消失、第一位回到当天的 kimi-k3',
    !!scopeToday && scopeToday.scope === '按当天' && scopeToday.first.indexOf('kimi-k3') !== -1,
    JSON.stringify(scopeToday)
  )
  // ⑮b 用量记录主口径（WorkBuddy）：面板今日块标题为「今日积分」（订阅积分口径）。
  // ZCode 的「本机 ¥ ↔ 账号」对账行在 WorkBuddy 已不适用（余额卡对账只在配了厂商
  // key、且用可选余额卡时出现）。
  const panelHead = await pollEval(
    cdp,
    "(function(){var ps=document.querySelectorAll('.zcwv-panel');for(var i=0;i<ps.length;i++){" +
      "if(ps[i].textContent.indexOf('今日积分')!==-1)return ps[i].textContent.slice(0,120)}return null})()",
    8000
  )
  check(
    '用量记录：面板今日块标题为「今日积分」（订阅积分口径，不再是「本机 ¥」对账）',
    typeof panelHead === 'string' && panelHead.indexOf('今日积分') !== -1,
    'head=' + JSON.stringify(panelHead)
  )

  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('.zcwv-panel .zcwv-panel-close');for(var i=0;i<bs.length;i++){" +
      "if(bs[i].textContent==='关闭'){bs[i].click();return true}}return false})()"
  )

  // ⑯ CommandCode 三重额度卡（v1.7.8）：cmdgo 源 + /whale/cmdgo.json fixture
  // → 气泡整卡渲染（标题 + 三窗口条最紧在前 + 池健康 + 重置行），与三行文本互斥
  const cmdgoStub =
    '(function(){var real=window.fetch;' +
    'function json(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{"Content-Type":"application/json"}}))}' +
    'var S={ok:true,source:"cmdgo",vendor:"commandcode",label:"CommandCode",timeMode:"none",modelId:"zai-org/GLM-5.3",currency:"USD",from:"selection"};' +
    'var C={ok:true,ref:"COMMANDCODE_API_KEY_TEST",pool:{available:2,total:3},plan:"Go",userName:"pigeon189",limited:false,' +
    'monthly:{remaining:6.9,total:10,percent:0.31},' +
    'fiveHour:{used:2.79,cap:3,exceeded:false,resetAt:' + (Date.now() + 84 * 60000) + ',remaining:0.21,percent:0.93},' +
    'weekly:{used:4.68,cap:6,exceeded:false,resetAt:' + (Date.now() + 2 * 86400000) + ',remaining:1.32,percent:0.78},readAt:Date.now()};' +
    'window.fetch=function(u,o){var s=String(u&&u.url?u.url:u);' +
    'if(s.indexOf("/whale/session.json")!==-1)return json(S);' +
    'if(s.indexOf("/whale/cmdgo.json")!==-1)return json(C);' +
    'if(s.indexOf("/whale/plan.json")!==-1)return json({ok:false,reason:"no-plan-log"});' +
    'return real.apply(this,arguments)}})()'
  const stubCmdgo = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: cmdgoStub })
  await cdp.send('Page.reload')
  const qcardView = await pollEval(
    cdp,
    "(function(){var q=document.querySelector('.zcwv-qcard');" +
      // 用计算样式判断可见：内联置空串会退回样式表的 display:none（曾漏判此 bug）
      "if(!q||getComputedStyle(q).display==='none')return null;" +
      'var head=q.querySelector(".zcwv-qhead").textContent;' +
      'var rows=[].map.call(q.querySelectorAll(".zcwv-qrow"),function(r){return{name:r.querySelector(".zcwv-qname").textContent,pct:r.querySelector(".zcwv-qpct").textContent,fill:r.querySelector(".zcwv-qbar i").style.width,fillCls:r.querySelector(".zcwv-qbar i").className}});' +
      'var subs=[].map.call(q.querySelectorAll(".zcwv-qsub"),function(s){return s.textContent});' +
      'var three=document.querySelector(".zcwv-label").style.display==="none";' +
      'return JSON.stringify({head:head,rows:rows,subs:subs,textHidden:three})})()',
    15000
  )
  const qcardObj = qcardView ? JSON.parse(qcardView) : null
  check(
    'CommandCode 额度卡：标题 + 三窗口（固定顺序 5小时/本周/本月）+ 池健康/账号 + 重置行，三行文本隐藏',
    !!qcardObj &&
      qcardObj.head === 'CommandCode 额度' &&
      qcardObj.textHidden === true &&
      qcardObj.rows.length === 3 &&
      qcardObj.rows[0].name === '5小时' &&
      qcardObj.rows[0].pct === '93%' &&
      qcardObj.rows[1].name === '本周' &&
      qcardObj.rows[2].name === '本月' &&
      qcardObj.subs[0].indexOf('账号池 2/3 可用') !== -1 &&
      qcardObj.subs[0].indexOf('pigeon189') !== -1 &&
      // 未撞墙时倒计时取已用最高的窗口（fixture 里 5小时 93% 最紧）
      qcardObj.subs[1].indexOf('5小时') === 0 &&
      qcardObj.subs[1].indexOf('后重置') !== -1,
    JSON.stringify(qcardObj)
  )
  check(
    '窗口条三档配色：<70% accent / 70–89% amber / ≥90% red',
    !!qcardObj &&
      qcardObj.rows[0].fillCls.indexOf('zcwv-qred') !== -1 &&
      qcardObj.rows[1].fillCls.indexOf('zcwv-qamber') !== -1 &&
      qcardObj.rows[2].fillCls === '' &&
      qcardObj.rows[0].fill === '93%',
    JSON.stringify(qcardObj && qcardObj.rows)
  )
  if (stubCmdgo && stubCmdgo.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubCmdgo.identifier })

  // ⑯a 中转站额度卡：服务端在 session.json 里给 quotaCard，前端按形状渲染。
  // 三种形状各验一次：多窗口（Sub2API）、纯余额（New API）、读取失败。
  await putSize({ scale: 1.5, theme: 'dark', displayMode: 'auto', alerts: { quotaPct: 0, moneyAlert: 0 } })
  const relayStub = (card) =>
    '(function(){var real=window.fetch;' +
    'function json(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{"Content-Type":"application/json"}}))}' +
    'var S={ok:true,source:"claude",vendor:"anthropic",label:"Claude",timeMode:"none",modelId:"claude-sonnet-5-5",currency:"USD",from:"selection",quotaCard:' +
    JSON.stringify(card) +
    '};' +
    'window.fetch=function(u,o){var s=String(u&&u.url?u.url:u);' +
    'if(s.indexOf("/whale/session.json")!==-1)return json(S);' +
    'return real.apply(this,arguments)}})()'
  const windowsCard = {
    kind: 'windows',
    title: 'SSSAICode 额度',
    rows: [
      { label: '5小时', percentUsed: 20, resetAt: Date.now() + 84 * 60000 },
      { label: '本日', percentUsed: 55 },
      { label: '本周', percentUsed: 82, resetAt: Date.now() + 3 * 86400000 },
    ],
    balance: { remaining: 12.34, used: 3.21, total: 15.55, currency: 'USD' },
    currency: 'USD',
  }
  const stubRelayWindows = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: relayStub(windowsCard) })
  await cdp.send('Page.reload')
  const relayWindowsView = await pollEval(
    cdp,
    "(function(){var q=document.querySelector('.zcwv-qcard');" +
      "if(!q||getComputedStyle(q).display==='none')return null;" +
      'var head=q.querySelector(".zcwv-qhead").textContent;' +
      'var rows=[].map.call(q.querySelectorAll(".zcwv-qrow"),function(r){return{name:r.querySelector(".zcwv-qname").textContent,pct:r.querySelector(".zcwv-qpct").textContent,fill:r.querySelector(".zcwv-qbar i").style.width}});' +
      'var subs=[].map.call(q.querySelectorAll(".zcwv-qsub"),function(s){return s.textContent});' +
      'var textHidden=document.querySelector(".zcwv-label").style.display==="none";' +
      'return JSON.stringify({head:head,rows:rows,subs:subs,textHidden:textHidden})})()',
    15000
  )
  const relayWindowsObj = relayWindowsView ? JSON.parse(relayWindowsView) : null
  check(
    '中转站窗口卡：标题 + 5小时/本日/本周三行 + 余额小字 + 最紧窗口倒计时，三行文本隐藏',
    !!relayWindowsObj &&
      relayWindowsObj.head === 'SSSAICode 额度' &&
      relayWindowsObj.textHidden === true &&
      relayWindowsObj.rows.length === 3 &&
      relayWindowsObj.rows[0].name === '5小时' &&
      relayWindowsObj.rows[0].pct === '20%' &&
      relayWindowsObj.rows[1].name === '本日' &&
      relayWindowsObj.rows[1].pct === '55%' &&
      relayWindowsObj.rows[2].name === '本周' &&
      relayWindowsObj.rows[2].pct === '82%' &&
      relayWindowsObj.subs[0].indexOf('剩 $12.34') !== -1 &&
      relayWindowsObj.subs[0].indexOf('已用 $3.21') !== -1 &&
      relayWindowsObj.subs[1].indexOf('本周') === 0 &&
      relayWindowsObj.subs[1].indexOf('后重置') !== -1,
    JSON.stringify(relayWindowsObj)
  )
  if (stubRelayWindows && stubRelayWindows.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubRelayWindows.identifier })

  // 单窗口（月度 / Cubence 5小时）按 GLM Plan 的数字口径：大号剩余百分比 + 重置/余额小字
  const singleCard = {
    kind: 'windows',
    title: 'Cubence 额度',
    rows: [{ label: '5小时', percentUsed: 24.6, resetAt: Date.now() + 3 * 3600000 }],
    balance: { remaining: 12.34, used: 3.21, total: 15.55, currency: 'USD' },
    currency: 'USD',
  }
  const stubRelaySingle = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: relayStub(singleCard) })
  await cdp.send('Page.reload')
  const relaySingleView = await pollEval(
    cdp,
    "(function(){var q=document.querySelector('.zcwv-qcard');" +
      "if(document.querySelector('.zcwv-label').textContent!=='Cubence 额度')return null;" +
      "return JSON.stringify({qcard:q&&getComputedStyle(q).display!=='none'," +
      'label:document.querySelector(".zcwv-label").textContent,' +
      'amount:document.querySelector(".zcwv-amount").textContent,' +
      'hint:document.querySelector(".zcwv-hint").textContent})})()',
    15000
  )
  const relaySingleObj = relaySingleView ? JSON.parse(relaySingleView) : null
  check(
    '中转站单窗口：大号剩余百分比（75.4%）+ 重置/余额小字，不画进度条',
    !!relaySingleObj &&
      relaySingleObj.qcard === false &&
      relaySingleObj.label === 'Cubence 额度' &&
      relaySingleObj.amount === '75.4%' &&
      relaySingleObj.hint.indexOf('5小时') !== -1 &&
      relaySingleObj.hint.indexOf('后重置') !== -1 &&
      relaySingleObj.hint.indexOf('剩 $12.34') !== -1,
    JSON.stringify(relaySingleObj)
  )
  if (stubRelaySingle && stubRelaySingle.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubRelaySingle.identifier })

  const balanceCard = {
    kind: 'balance',
    title: 'PackyCode 余额',
    balance: { remaining: 12.34, used: 3.21, total: 15.55, currency: 'USD' },
    currency: 'USD',
  }
  const stubRelayBalance = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: relayStub(balanceCard) })
  await cdp.send('Page.reload')
  const relayBalanceView = await pollEval(
    cdp,
    "(function(){var q=document.querySelector('.zcwv-qcard');" +
      "if(document.querySelector('.zcwv-label').textContent!=='PackyCode 余额')return null;" +
      "return JSON.stringify({qcard:q&&getComputedStyle(q).display!=='none'," +
      'label:document.querySelector(".zcwv-label").textContent,' +
      'amount:document.querySelector(".zcwv-amount").textContent,' +
      'hint:document.querySelector(".zcwv-hint").textContent})})()',
    15000
  )
  const relayBalanceObj = relayBalanceView ? JSON.parse(relayBalanceView) : null
  check(
    '中转站余额卡：主数字 = 剩余余额，小字 = 已用/总额，额度卡隐藏',
    !!relayBalanceObj &&
      relayBalanceObj.qcard === false &&
      relayBalanceObj.label === 'PackyCode 余额' &&
      relayBalanceObj.amount === '$12.34' &&
      relayBalanceObj.hint.indexOf('已用 $3.21') !== -1 &&
      relayBalanceObj.hint.indexOf('总额 $15.55') !== -1,
    JSON.stringify(relayBalanceObj)
  )
  if (stubRelayBalance && stubRelayBalance.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubRelayBalance.identifier })

  const errorCard = { kind: 'error', title: 'DuckCoding 额度', reason: '未找到该站的 API Key' }
  const stubRelayError = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: relayStub(errorCard) })
  await cdp.send('Page.reload')
  const relayErrorView = await pollEval(
    cdp,
    "(function(){var q=document.querySelector('.zcwv-qcard');" +
      "if(!q||getComputedStyle(q).display==='none')return null;" +
      'return JSON.stringify({head:q.querySelector(".zcwv-qhead").textContent,sub:q.querySelector(".zcwv-qsub").textContent})})()',
    15000
  )
  const relayErrorObj = relayErrorView ? JSON.parse(relayErrorView) : null
  check(
    '中转站额度读取失败：卡片说清原因，不冒充余额',
    !!relayErrorObj && relayErrorObj.head === 'DuckCoding 额度' && relayErrorObj.sub.indexOf('API Key') !== -1,
    JSON.stringify(relayErrorObj)
  )
  if (stubRelayError && stubRelayError.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubRelayError.identifier })

  // ⑯b 撞墙窗口（真实数据实测到：三账号均撞周限）。这里构造「5小时 + 本周」同时
  // 撞墙、且本周重置更晚的场景，一次验三件事：已限流文案（不显示 101%）、
  // 倒计时取**最晚**重置的那道墙（本周，而不是时间更早的 5小时）、池全满时的说人话文案
  const soonReset = Date.now() + 20 * 60000
  const laterReset = Date.now() + 4 * 86400000
  const cmdgoLimited =
    '(function(){var real=window.fetch;' +
    'function json(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{"Content-Type":"application/json"}}))}' +
    'var S={ok:true,source:"cmdgo",vendor:"commandcode",label:"CommandCode",timeMode:"none",modelId:"zai-org/GLM-5.3",currency:"USD",from:"selection"};' +
    'var C={ok:true,ref:"K",pool:{available:0,total:3},plan:"Go",userName:"demo-account-2",limited:true,' +
    'monthly:{remaining:3.96,total:10,percent:0.60,resetAt:' + (Date.now() + 26 * 86400000) + '},' +
    'fiveHour:{used:3.03,cap:3,exceeded:true,resetAt:' + soonReset + ',remaining:0,percent:1.01},' +
    'weekly:{used:6.12,cap:6,exceeded:true,resetAt:' + laterReset + ',remaining:0,percent:1.02},readAt:Date.now()};' +
    'window.fetch=function(u,o){var s=String(u&&u.url?u.url:u);' +
    'if(s.indexOf("/whale/session.json")!==-1)return json(S);' +
    'if(s.indexOf("/whale/cmdgo.json")!==-1)return json(C);' +
    'return real.apply(this,arguments)};' +
    // 固定随机数：⑯c 点气泡会抽随机台词，抽到 gif 组就没有文字行可断言
    'Math.random=function(){return 0}})()'
  const stubLimited = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: cmdgoLimited })
  await cdp.send('Page.reload')
  const limitedView = await pollEval(
    cdp,
    "(function(){var q=document.querySelector('.zcwv-qcard');if(!q||getComputedStyle(q).display==='none')return null;" +
      'var rows=[].map.call(q.querySelectorAll(".zcwv-qrow"),function(r){return{r:r.querySelector(".zcwv-qname").textContent,p:r.querySelector(".zcwv-qpct").textContent,f:r.querySelector(".zcwv-qbar i").style.width}});' +
      'var subs=[].map.call(q.querySelectorAll(".zcwv-qsub"),function(s){return s.textContent});' +
      'return JSON.stringify({rows:rows,subs:subs})})()',
    15000
  )
  const limitedObj = limitedView ? JSON.parse(limitedView) : null
  check(
    'CommandCode 撞墙窗口显示「已限流」（条满宽、不显示 101%）',
    !!limitedObj &&
      limitedObj.rows[0].r === '5小时' &&
      limitedObj.rows[0].p === '已限流' &&
      limitedObj.rows[0].f === '100%' &&
      limitedObj.rows[1].r === '本周' &&
      limitedObj.rows[1].p === '已限流',
    JSON.stringify(limitedObj && limitedObj.rows)
  )
  check(
    '多窗口同时撞墙：倒计时取最晚重置的那道墙（本周），池全满时说「已全部限流」',
    !!limitedObj &&
      limitedObj.subs[0].indexOf('账号池已全部限流') !== -1 &&
      limitedObj.subs[1].indexOf('本周') === 0 &&
      limitedObj.subs[1].indexOf('4 天后重置') !== -1,
    JSON.stringify(limitedObj && limitedObj.subs)
  )
  if (stubLimited && stubLimited.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubLimited.identifier })

  // ⑯b2 不到 100% 不谎报「已限流」（2026-10-04 真机实锤）：月池 99.54% 四舍五入
  // 成 100 会被旧逻辑标成「已限流」，而账号其实还剩 0.046 credit——单账号池被
  // 网关限流（limited=true）时服务端仍会把这个账号送来展示，卡片必须如实显示
  // 一位小数（99.5%），「已限流」只留给网关 exceeded 或比例真到 100% 的窗口
  const nearReset = Date.now() + 22 * 86400000
  const cmdgoNearWall =
    '(function(){var real=window.fetch;' +
    'function json(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{"Content-Type":"application/json"}}))}' +
    'var S={ok:true,source:"cmdgo",vendor:"commandcode",label:"CommandCode",timeMode:"none",modelId:"zai-org/GLM-5.3",currency:"USD",from:"selection"};' +
    'var C={ok:true,ref:"K1",pool:{available:0,total:1},plan:"Go",userName:"pigeon189",limited:true,' +
    'monthly:{remaining:0.0457,total:10,percent:0.9954,resetAt:' + nearReset + '},' +
    'fiveHour:{used:0.912,cap:3,exceeded:false,resetAt:' + (Date.now() + 5 * 3600000) + ',remaining:2.088,percent:0.3041},' +
    'weekly:{used:3.947,cap:6,exceeded:false,resetAt:' + (Date.now() + 6 * 86400000) + ',remaining:2.053,percent:0.6578},readAt:Date.now()};' +
    'window.fetch=function(u,o){var s=String(u&&u.url?u.url:u);' +
    'if(s.indexOf("/whale/session.json")!==-1)return json(S);' +
    'if(s.indexOf("/whale/cmdgo.json")!==-1)return json(C);' +
    'return real.apply(this,arguments)};' +
    // 固定随机数：⑯c 点气泡会抽随机台词，抽到 gif 组就没有文字行可断言
    'Math.random=function(){return 0}})()'
  const stubNearWall = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: cmdgoNearWall })
  await cdp.send('Page.reload')
  const nearWallView = await pollEval(
    cdp,
    "(function(){var q=document.querySelector('.zcwv-qcard');if(!q||getComputedStyle(q).display==='none')return null;" +
      'var rows=[].map.call(q.querySelectorAll(".zcwv-qrow"),function(r){return{r:r.querySelector(".zcwv-qname").textContent,p:r.querySelector(".zcwv-qpct").textContent,f:r.querySelector(".zcwv-qbar i").style.width}});' +
      'var subs=[].map.call(q.querySelectorAll(".zcwv-qsub"),function(s){return s.textContent});' +
      'return JSON.stringify({rows:rows,subs:subs})})()',
    15000
  )
  const nearWallObj = nearWallView ? JSON.parse(nearWallView) : null
  check(
    '月池 99.54% 显示一位小数（不谎报已限流），其余窗口正常百分比，限流单账号说「已全部限流」',
    !!nearWallObj &&
      nearWallObj.rows[2].r === '本月' &&
      nearWallObj.rows[2].p === '99.5%' &&
      nearWallObj.rows[2].f === '99.54%' &&
      nearWallObj.rows[1].p === '66%' &&
      nearWallObj.rows[0].p === '30%' &&
      nearWallObj.subs[0].indexOf('账号池已全部限流') !== -1,
    JSON.stringify(nearWallObj && nearWallObj.rows)
  )
  if (stubNearWall && stubNearWall.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubNearWall.identifier })

  // ⑯c 点气泡推进到第二页（随机台词 / 自定义步）：额度卡必须让位，不能与台词叠加
  // （实测反馈：卡片的隐藏只写在 render() 顶部，而推进走 applyBubbleLines 直渲，
  // 于是第二页台词压在卡片上）
  // 先点鲸鱼把气泡打开（⑯ 只断言卡片在 DOM 里，气泡可能还是关着的）
  const whaleAtNow = JSON.parse(
    await cdp.eval(
      "(function(){var i=document.querySelector('.zcwv-img').getBoundingClientRect();" +
        'return JSON.stringify({x:Math.round(i.left+i.width/2),y:Math.round(i.bottom-40)})})()'
    )
  )
  const clickAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' })
  }
  await clickAt(whaleAtNow.x, whaleAtNow.y)
  const bubbleOpen = await pollEval(
    cdp,
    "(function(){var b=document.querySelector('.zcwv-bubble');return b&&b.classList.contains('zcwv-bubble-open')?true:null})()",
    8000
  )
  check('⑯c 前置：点鲸鱼打开气泡', !!bubbleOpen)
  const bubAt = JSON.parse(
    await cdp.eval(
      "(function(){var b=document.querySelector('.zcwv-bubble').getBoundingClientRect();" +
        'return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height*0.34)})})()'
    )
  )
  await clickAt(bubAt.x, bubAt.y)
  const secondPage = await pollEval(
    cdp,
    "(function(){var q=document.querySelector('.zcwv-qcard');if(!q)return null;" +
      "if(getComputedStyle(q).display!=='none')return null;" +
      'var t=[document.querySelector(".zcwv-label"),document.querySelector(".zcwv-amount"),document.querySelector(".zcwv-hint")]' +
      '.filter(function(e){return e&&e.style.display!=="none"&&e.textContent.trim()}).length;' +
      'return t>0?JSON.stringify({hidden:true,lines:t}):null})()',
    15000
  )
  check(
    '点气泡推进第二页：额度卡隐藏、台词独占气泡（不叠加）',
    !!secondPage,
    'view=' + JSON.stringify(secondPage)
  )

  // ⑯d 代码审查 M1 回归：cmdgo 源 + 自定义「首次按压」步 —— 额度卡不得顶掉自定义
  // 内容。render() 的 qcard 分支自带 return，过去排在「自定义步优先」三道守卫之前，
  // 于是卡片稳定覆盖首步（打开气泡与 60s 轮询都会走到 render）。
  await fetch('http://127.0.0.1:' + PORT + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, first: { text: '冒烟自定义首步', size: 'B' }, items: [] }),
  })
  const stubFirstStep = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: cmdgoStub })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  const whaleFirst = JSON.parse(
    await cdp.eval(
      "(function(){var i=document.querySelector('.zcwv-img').getBoundingClientRect();" +
        'return JSON.stringify({x:Math.round(i.left+i.width/2),y:Math.round(i.bottom-40)})})()'
    )
  )
  await clickAt(whaleFirst.x, whaleFirst.y)
  const firstStepView = await pollEval(
    cdp,
    "(function(){var q=document.querySelector('.zcwv-qcard');var a=document.querySelector('.zcwv-amount');" +
      'if(!a)return null;' +
      "var cardHidden=!q||getComputedStyle(q).display==='none';" +
      "var txt=a.style.display!=='none'&&a.textContent.indexOf('冒烟自定义首步')!==-1;" +
      'return cardHidden&&txt?JSON.stringify({card:false,text:a.textContent}):null})()',
    15000
  )
  check(
    '⑯d cmdgo 源下自定义首步优先于额度卡（M1 回归：卡片不再绕过守卫）',
    !!firstStepView,
    'view=' + JSON.stringify(firstStepView)
  )
  if (stubFirstStep && stubFirstStep.identifier) {
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubFirstStep.identifier })
  }
  // 复位气泡内容，免得影响后面的用例
  await fetch('http://127.0.0.1:' + PORT + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, first: null, items: [] }),
  })

  // ⑯ 音效库：导入集出现在下拉里、选中导入集时「删除当前」出现、内置集时隐藏
  // （导入本身走接口，页面侧只验 UI 与选择状态）
  const sndWav = Buffer.from('RIFF0000WAVEfmt ', 'latin1').toString('base64')
  const sndUpRes = await fetch('http://127.0.0.1:' + PORT + '/whale/sound-upload.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟音效', press: { dataUrl: 'data:audio/wav;base64,' + sndWav } }),
  })
  const sndUp = await sndUpRes.json()
  check('音效导入接口：服务端接受并返回 id', sndUpRes.ok && sndUp.ok === true && !!sndUp.id, JSON.stringify({ id: sndUp.id }))
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  const SND_PROBE =
    "(function(){var ss=document.querySelectorAll('select'),hit=null;for(var i=0;i<ss.length;i++){" +
    'var vals=[],texts=[];for(var j=0;j<ss[i].options.length;j++){vals.push(ss[i].options[j].value);texts.push(ss[i].options[j].textContent)}' +
    "if(vals.indexOf('duck')!==-1){hit={vals:vals,texts:texts,value:ss[i].value};break}}" +
    "var imp=0,bs=document.querySelectorAll('button');" +
    "for(var k=0;k<bs.length;k++){if(bs[k].textContent==='导入…')imp++}" +
    'return JSON.stringify({sets:hit?hit.vals:null,texts:hit?hit.texts:null,value:hit?hit.value:null,importBtns:imp})})()'
  const sndView = JSON.parse((await pollEvalReload(cdp, SND_PROBE, 8000)) || 'null')
  check(
    '音效库：内置两套 + 导入集都在下拉里（导入集带名字），音效/角色两行按钮都叫「导入…」',
    !!sndView &&
      sndView.sets &&
      sndView.sets.indexOf('duck') !== -1 &&
      sndView.sets.indexOf('fx1') !== -1 &&
      sndView.sets.indexOf(sndUp.id) !== -1 &&
      (sndView.texts || []).join(',').indexOf('冒烟音效') !== -1 &&
      sndView.importBtns === 2,
    JSON.stringify(sndView)
  )
  // 音效下拉列表与角色列表同构：只有导入集带逐行 ×（内置不可删）
  const SND_LIST_PROBE =
    "(function(){var ts=document.querySelectorAll('.zcwv-role-trigger'),t=null;" +
    "for(var i=0;i<ts.length;i++){if((ts[i].title||'').indexOf('\\u9009\\u62e9\\u97f3\\u6548')===0){t=ts[i];break}}" +
    "if(!t)return null;t.click();" +
    "var ls=document.querySelectorAll('.zcwv-roles'),list=null;" +
    "for(var i=0;i<ls.length;i++){var h=ls[i].querySelector('.zcwv-roles-head');if(h&&h.textContent==='\\u97f3\\u6548'){list=ls[i];break}}" +
    "if(!list)return null;var rows=list.querySelectorAll('.zcwv-role-row'),del=0,armed=0;" +
    "for(var j=0;j<rows.length;j++){var b=rows[j].querySelector('.zcwv-role-del');if(b){del++;if(b.textContent==='\\u518d\\u70b9\\u5220\\u9664')armed++}}" +
    'return JSON.stringify({open:list.classList.contains("zcwv-roles-open"),del:del,armed:armed})})()'
  const sndList = JSON.parse((await pollEval(cdp, SND_LIST_PROBE, 8000)) || 'null')
  check(
    '音效下拉：只有导入集带逐行 ×（内置行无删除），与角色列表结构一致',
    !!sndList && sndList.open === true && sndList.del === 1 && sndList.armed === 0,
    JSON.stringify(sndList)
  )
  // 两步删除：第一次点 × 只进入「再点删除」确认态（与角色删除同款）
  await cdp.eval(
    "(function(){var ls=document.querySelectorAll('.zcwv-roles');for(var i=0;i<ls.length;i++){" +
      "var h=ls[i].querySelector('.zcwv-roles-head');if(h&&h.textContent==='\\u97f3\\u6548'){" +
      "var b=ls[i].querySelector('.zcwv-role-del');if(b){b.click();return true}}}return false})()"
  )
  const SND_ARM_PROBE =
    "(function(){var ls=document.querySelectorAll('.zcwv-roles'),found=false,heads=[],armed=0;" +
    "for(var i=0;i<ls.length;i++){var h=ls[i].querySelector('.zcwv-roles-head');heads.push(h?h.textContent:'(无头)');" +
    "if(h&&h.textContent==='\\u97f3\\u6548'){found=true;var rows=ls[i].querySelectorAll('.zcwv-role-row');" +
    "for(var j=0;j<rows.length;j++){var b=rows[j].querySelector('.zcwv-role-del');if(b&&b.textContent==='\\u518d\\u70b9\\u5220\\u9664')armed++}}}" +
    'return JSON.stringify({found:found,heads:heads,armed:armed})})()'
  const sndArmed = JSON.parse((await pollEval(cdp, SND_ARM_PROBE, 8000)) || 'null')
  check(
    '音效删除两步确认：第一次点 × 进入「再点删除」',
    !!sndArmed && sndArmed.found === true && sndArmed.armed === 1,
    JSON.stringify(sndArmed)
  )
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // 必须带 scale：size.json 的写入以 scale 为必填（缺了直接 400）
    body: JSON.stringify({ scale: 1.5, soundSet: sndUp.id }),
  })
  const sndState = await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()
  check('音效选择写入 widget-state（选中导入集）', sndState.soundSet === sndUp.id, JSON.stringify({ soundSet: sndState.soundSet }))
  await cdp.send('Page.reload')
  // 等到触发器真的跟上选中项（不能只等固定时长：重载后页面可能已经画出下拉但还没
  // 应用状态，此时读到的是默认项 'duck'——实测偶发过一次假失败）。首次超时再重载一次。
  const sndImported = JSON.parse(
    (await pollEvalReload(
      cdp,
      "(function(){var ss=document.querySelectorAll('select'),hit=null;for(var i=0;i<ss.length;i++){" +
        "var vals=[];for(var j=0;j<ss[i].options.length;j++){vals.push(ss[i].options[j].value)}" +
        "if(vals.indexOf('duck')!==-1){hit=ss[i];break}}" +
        "if(!hit||hit.value!==" + JSON.stringify(sndUp.id) + ")return null;" +
        "return JSON.stringify({value:hit.value})})()",
      15000
    )) || 'null'
  )
  check(
    '音效库：选中导入集生效（触发器跟随选中项）',
    !!sndImported && sndImported.value === sndUp.id,
    JSON.stringify(sndImported && { value: sndImported.value })
  )
  // 收尾：删掉冒烟音效，别留进 fixture 的持久状态
  await fetch('http://127.0.0.1:' + PORT + '/whale/sound-delete.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: sndUp.id }),
  })
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, soundSet: 'duck' }),
  })
  // ==== 设置按钮 + 设置窗口跟随角色配色（浅色档生效、深色档不跟）====
  // 不硬编码色值：以气泡描边色（同一份 ROLE_INK_PAIR 浅色档）为基准比对，
  // 以后调整角色配色不会把这个用例改红，但「跟色链路断了」会红
  const readRoleInk = async () =>
    JSON.parse(
      await cdp.eval(
        "(function(){var q=function(s,p){var e=document.querySelector(s);return e?getComputedStyle(e)[p]:null};" +
          "var rs=document.querySelectorAll('.zcwv-range');" +
          "return JSON.stringify({btnBorder:q('.zcwv-menu-btn','borderTopColor'),rowColor:q('.zcwv-menu-row','color')," +
          "barBg:q('.zcwv-menu-btn span','backgroundColor')," +
          "panelBorder:q('.zcwv-panel','borderTopColor'),rolesBorder:q('.zcwv-roles','borderTopColor')," +
          "bookRow:q('.zcwv-book-row','color'),numBorder:q('.zcwv-number','borderTopColor')," +
          "numColor:q('.zcwv-number','color'),checkAccent:q('.zcwv-check','accentColor')," +
          "dimColor:q('.zcwv-roles-head','color'),checkBorderW:q('.zcwv-check','borderTopWidth')," +
          "checkCheckedBorderW:q('.zcwv-check:checked','borderTopWidth'),checkAppearance:q('.zcwv-check','appearance')," +
          "rangeAppearance:rs.length?getComputedStyle(rs[0]).appearance:null," +
          "rangeAccent:rs.length?getComputedStyle(rs[0]).accentColor:null," +
          "stroke:q('.zcwv-bubble .zcwv-bshape','stroke')," +
          // U31：正文色走派生变体（--zcw-role-ink-text），装饰件走角色原色
          "inkText:(getComputedStyle(document.documentElement).getPropertyValue('--zcw-role-ink-text')||'').trim()," +
          "checkMark:(getComputedStyle(document.documentElement).getPropertyValue('--zcw-check-mark')||'').trim()," +
          "dark:document.documentElement.classList.contains('zcwv-theme-dark')})})()"
      )
    )
  const pickRoleByName = async (name) => {
    await cdp.eval(
      "(function(){var ts=document.querySelectorAll('.zcwv-role-trigger');for(var i=0;i<ts.length;i++){" +
        "if((ts[i].title||'').indexOf('选择形象')===0){ts[i].click();return 'open'}}return 'no'})()"
    )
    await new Promise((r) => setTimeout(r, 500))
    const r = await cdp.eval(
      "(function(){var n=" + JSON.stringify(name) + ";var ps=document.querySelectorAll('.zcwv-role-pick');" +
        "for(var i=0;i<ps.length;i++){if(ps[i].textContent===n){ps[i].click();return 'ok'}}return 'no'})()"
    )
    await new Promise((r) => setTimeout(r, 800))
    return r
  }
  const setThemeAndReload = async (theme) => {
    await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 1.5, theme: theme }),
    })
    await cdp.send('Page.reload')
    // 固定等 3 秒偶发不够（重载 + 状态拉取 + 应用主题排队时读到上一档，实测飘过一次），
    // 改成轮询 DOM 直到主题真的切过来
    const wantDark = theme === 'dark'
    const deadline = Date.now() + 12000
    for (;;) {
      await new Promise((r) => setTimeout(r, 300))
      let got = null
      try {
        got = JSON.parse(
          await cdp.eval(
            "(function(){try{return JSON.stringify({dark:document.documentElement.classList.contains('zcwv-theme-dark')})}catch(e){return '{}'}})()"
          )
        )
      } catch (err) {
        got = null
      }
      if (got && got.dark === wantDark) break
      if (Date.now() > deadline) break
    }
  }
  await setThemeAndReload('light')
  const inkDefault = await readRoleInk()
  const pickedXiaoke = await pickRoleByName('小克')
  const inkXiaoke = await readRoleInk()
  const rgbOf = (hex) => {
    const h = String(hex || '').replace('#', '')
    return h.length === 6 ? 'rgb(' + [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')' : null
  }
  // U31：正文用派生色、装饰用原色。两者必须不同（小克 #d97757 只有 3.12:1，
  // 派生后 ≥4.5:1），但都随角色走、都与默认角色不同
  const derivedXiaoke = rgbOf(inkXiaoke.inkText)
  check(
    '角色配色跟到整套浅色界面（正文走派生达标色、装饰件走角色原色）',
    pickedXiaoke === 'ok' &&
      !!inkXiaoke &&
      inkXiaoke.dark === false &&
      inkXiaoke.btnBorder !== inkDefault.btnBorder &&
      inkXiaoke.panelBorder !== inkDefault.panelBorder &&
      inkXiaoke.rolesBorder !== inkDefault.rolesBorder &&
      inkXiaoke.rowColor !== inkDefault.rowColor &&
      inkXiaoke.bookRow !== inkDefault.bookRow &&
      // 装饰件与气泡描边同源（角色浅色原值）
      inkXiaoke.barBg === inkXiaoke.stroke &&
      inkXiaoke.checkAccent === inkXiaoke.stroke &&
      inkXiaoke.rangeAccent === inkXiaoke.stroke &&
      // U31：正文（菜单行 / 记账行 / 文本框 / 次级文字）改用派生达标色，
      // 不再等于原色，但仍带角色色相
      !!derivedXiaoke &&
      inkXiaoke.rowColor === derivedXiaoke &&
      inkXiaoke.bookRow === derivedXiaoke &&
      inkXiaoke.numColor === derivedXiaoke &&
      derivedXiaoke !== inkXiaoke.stroke &&
      // 次级文字（用量记录的对账/日志行、下拉表头…）也跟色
      !!inkXiaoke.dimColor &&
      inkXiaoke.dimColor !== inkDefault.dimColor &&
      // 勾选对勾默认白（2026-10-16 起：内置六色一律白勾、整套界面统一；只有填充
      // 浅到白勾看不清时才给深色勾——小克这种中间调仍是白勾）
      inkXiaoke.checkMark === '#ffffff' &&
      // 复选框浅色档自绘：勾选态与未勾选态同为 1px 描边（原生勾选态偏重）
      inkXiaoke.checkAppearance === 'none' &&
      inkXiaoke.checkBorderW === '1px' &&
      inkXiaoke.checkCheckedBorderW === '1px' &&
      // 拖动条浅色档必须自绘：原生空槽会按 accent 明度翻色（小克/kimi 变深灰"黑底"）
      inkXiaoke.rangeAppearance === 'none',
    JSON.stringify({ picked: pickedXiaoke, derived: derivedXiaoke, def: inkDefault, xiaoke: inkXiaoke })
  )
  await setThemeAndReload('dark')
  const darkXiaoke = await readRoleInk()
  const pickedWhale = await pickRoleByName('大肥鱼')
  const darkWhale = await readRoleInk()
  check(
    '深色档一律不跟角色，且控件与浅色档同构（自绘滑块/复选框，白勾由深色 token 兜底）',
    pickedWhale === 'ok' &&
      !!darkXiaoke &&
      darkXiaoke.dark === true &&
      darkXiaoke.btnBorder === darkWhale.btnBorder &&
      darkXiaoke.panelBorder === darkWhale.panelBorder &&
      darkXiaoke.rolesBorder === darkWhale.rolesBorder &&
      darkXiaoke.rowColor === darkWhale.rowColor &&
      darkXiaoke.barBg === darkWhale.barBg &&
      darkXiaoke.bookRow === darkWhale.bookRow &&
      darkXiaoke.numColor === darkWhale.numColor &&
      darkXiaoke.checkAccent === darkWhale.checkAccent &&
      darkXiaoke.dimColor === darkWhale.dimColor &&
      darkXiaoke.rangeAccent === darkWhale.rangeAccent &&
      darkXiaoke.rangeAppearance === 'none' &&
      darkWhale.rangeAppearance === 'none' &&
      darkXiaoke.checkAppearance === 'none' &&
      darkXiaoke.checkMark === '#fff' &&
      darkWhale.checkMark === '#fff',
    JSON.stringify({ xiaoke: darkXiaoke, whale: darkWhale })
  )
  await setThemeAndReload('light')
  // ==== 切角色后「出厂台词池」重烤（2026-10-07 实测：嘎啦嘛念小克的台词）====
  // 台词池是烤进保存配置的，所以「以小克身份保存过一次」的配置里装的是小克台词。
  // 这里模拟这份病态配置（3 条小克专属台词），切到嘎啦嘛后重新加载：队列必须换成
  // 嘎啦嘛的池。识别口径 = 模块里每条台词的文本都落在某个角色的出厂池内（只看文本，
  // 不看字号/权重/条数），用户自己写过的台词不匹配、原样保留。
  const XIAOKE_ONLY = ['大肥鱼...', '说中文≠不会封号', '你问这本书里面有什么？答案是思考链哦']
  const pickedFox = await pickRoleByName('嘎啦嘛')
  await fetch('http://127.0.0.1:' + PORT + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 2,
      tapAdvance: true,
      steps: [{ modules: [{ type: 'rand', lines: XIAOKE_ONLY.slice(), size: 'A' }] }],
    }),
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  await clickWhale()
  const rebakedLine = await pollEval(
    cdp,
    "(function(){var t=[document.querySelector('.zcwv-label'),document.querySelector('.zcwv-amount'),document.querySelector('.zcwv-hint')];" +
      "for(var i=0;i<3;i++){if(t[i]&&t[i].style.display!=='none'&&t[i].textContent)return t[i].textContent}return null})()",
    8000
  )
  check(
    '切角色后出厂台词池重烤：嘎啦嘛不念小克台词（配置里烤着的小克池被换成当前角色池）',
    pickedFox === 'ok' &&
      typeof rebakedLine === 'string' &&
      rebakedLine.trim().length > 0 &&
      XIAOKE_ONLY.indexOf(rebakedLine.trim()) === -1,
    JSON.stringify({ picked: pickedFox, line: rebakedLine })
  )
  await fetch('http://127.0.0.1:' + PORT + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 2, tapAdvance: true, steps: [] }),
  })

  // ⑬ 版本更新面板 + 新版本提醒（v1.11.0 引入）：用 fetch 桩喂「有新版本」状态，
  //    走真实交互（菜单在，点按钮开面板、点跳过、点返回）。桩随 reload 生效，
  //    检查放在最后，免得重置前面的用例状态。
  const updateStub =
    '(function(){var real=window.fetch;window.__upSkip=false;window.__upClose=false;window.fetch=function(u,o){' +
    "var s=String(u&&u.url?u.url:u);if(s.indexOf('/whale/update.json')!==-1){" +
    "if(o&&o.method==='POST'){try{var a=JSON.parse(o.body||'{}');if(a.action==='skip')window.__upSkip=true;if(a.action==='unskip')window.__upSkip=false;if(a.action==='close')window.__upClose=true}catch(e){}}" +
    "var b={ok:true,version:'1.10.0',latest:'9.9.9',available:true,skipped:window.__upSkip?'9.9.9':null," +
    "skipActive:window.__upSkip,busy:false,phase:null,progress:0,message:null,source:'stub'};" +
    "return Promise.resolve(new Response(JSON.stringify(b),{status:200,headers:{'Content-Type':'application/json'}}))}" +
    'return real.apply(this,arguments)}})()'
  const stubUp = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: updateStub })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  await pollEval(cdp, "document.readyState === 'complete' && !!document.querySelector('.zcwv-hint')", 12000)
  // 新版本提醒：boot 后的第一次轮询就应弹一次提醒气泡
  const upNotify = await pollEval(
    cdp,
    "(function(){var l=document.querySelector('.zcwv-label');var open=document.querySelector('.zcwv-bubble').classList.contains('zcwv-bubble-open');" +
      "return (open&&l&&l.textContent.indexOf('\\u53d1\\u73b0\\u65b0\\u7248\\u672c')===0)?l.textContent:null})()",
    8000
  )
  check('发现新版本时弹一次提醒气泡', upNotify === '发现新版本 v9.9.9', JSON.stringify(upNotify))

  // 打开菜单 → 更新行状态文字 + 入口按钮
  await cdp.eval("(function(){document.querySelector('.zcwv-menu-btn').click();return true})()")
  await new Promise((r) => setTimeout(r, 600))
  const upMenu = JSON.parse(
    await cdp.eval(
      "(function(){var st=document.querySelector('.zcwv-update-state');var bs=document.querySelectorAll('.zcwv-menu-row button');var btn=null;" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('\\u68c0\\u67e5\\u66f4\\u65b0')===0)btn=bs[i]}" +
        "return JSON.stringify({state:st?st.textContent:null,hasBtn:!!btn})})()"
    )
  )
  check(
    '菜单「更新」行：入口在 + 状态显示有新版本',
    !!upMenu && upMenu.hasBtn === true && upMenu.state === '有新版 v9.9.9',
    JSON.stringify(upMenu)
  )
  const upPanel = JSON.parse(
    await cdp.eval(
      "(function(){var bs=document.querySelectorAll('.zcwv-menu-row button');var btn=null;" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf('\\u68c0\\u67e5\\u66f4\\u65b0')===0)btn=bs[i]}" +
        "if(!btn)return JSON.stringify({err:'no-btn'});btn.click();" +
        "var p=document.querySelector('.zcwv-update');if(!p)return JSON.stringify({err:'no-panel'});" +
        "var vers=p.querySelectorAll('.zcwv-update-ver');var bs2=p.querySelectorAll('button');var labels=[];" +
        "for(var j=0;j<bs2.length;j++)labels.push(bs2[j].textContent);" +
        "return JSON.stringify({open:p.classList.contains('zcwv-panel-open'),cur:vers[0]?vers[0].textContent:null," +
        'latest:vers[1]?vers[1].textContent:null,labels:labels})})()'
    )
  )
  check(
    '更新面板：打开显示当前 / 最新版本，主按钮为「立即更新」',
    !!upPanel && upPanel.open === true && upPanel.cur === 'v1.10.0' && upPanel.latest === 'v9.9.9' &&
      (upPanel.labels || []).indexOf('立即更新') !== -1 && (upPanel.labels || []).indexOf('跳过此版本') !== -1,
    JSON.stringify(upPanel)
  )
  const upSkipped = JSON.parse(
    await cdp.eval(
      "(function(){var p=document.querySelector('.zcwv-update');var bs=p.querySelectorAll('button');" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent==='\\u8df3\\u8fc7\\u6b64\\u7248\\u672c'){bs[i].click();" +
        "return JSON.stringify({clicked:true})}}return JSON.stringify({clicked:false})})()"
    )
  )
  const upAfterSkip = await pollEval(
    cdp,
    "(function(){var p=document.querySelector('.zcwv-update');if(!p)return null;var bs=p.querySelectorAll('button');var labels=[];" +
      "for(var i=0;i<bs.length;i++)labels.push(bs[i].textContent);" +
      "return labels.indexOf('\\u53d6\\u6d88\\u8df3\\u8fc7')!==-1?labels.join(','):null})()",
    6000
  )
  check('更新面板：跳过此版本 → 按钮变「取消跳过」（状态回报 skipActive）', !!upSkipped.clicked && !!upAfterSkip, JSON.stringify(upAfterSkip))
  // 关闭插件：在「重启挂件」右侧，且要二次确认（关掉就没界面可点回来了）；
  // 第一次点击只改文案，第二次才真的发 action=close（桩会记下，不会真关）
  const upCloseOrder = JSON.parse(
    await cdp.eval(
      "(function(){var p=document.querySelector('.zcwv-update');if(!p)return JSON.stringify({err:'no-panel'});" +
        "var bs=p.querySelectorAll('button');var labels=[];" +
        "for(var i=0;i<bs.length;i++)labels.push(bs[i].textContent);" +
        "var row=bs.length?bs[bs.length-1].parentNode:null;" +
        "return JSON.stringify({labels:labels,restart:labels.indexOf('\\u91cd\\u542f\\u6302\\u4ef6')," +
        "close:labels.indexOf('\\u5173\\u95ed\\u63d2\\u4ef6')," +
        "panelClient:p.clientWidth,panelScroll:p.scrollWidth," +
        "rowClient:row?row.clientWidth:null,rowScroll:row?row.scrollWidth:null})})()"
    )
  )
  check(
    '更新面板：「关闭插件」紧跟在「重启挂件」右侧',
    !!upCloseOrder && upCloseOrder.restart >= 0 && upCloseOrder.close === upCloseOrder.restart + 1,
    JSON.stringify(upCloseOrder)
  )
  check(
    '更新面板：按钮行加满四个按钮后不横向溢出（面板 320px / 按钮行 nowrap）',
    !!upCloseOrder && upCloseOrder.panelScroll <= upCloseOrder.panelClient + 1 &&
      upCloseOrder.rowScroll <= upCloseOrder.rowClient + 1,
    JSON.stringify({panelClient: upCloseOrder.panelClient, panelScroll: upCloseOrder.panelScroll, rowClient: upCloseOrder.rowClient, rowScroll: upCloseOrder.rowScroll})
  )
  const upCloseArmed = JSON.parse(
    await cdp.eval(
      "(function(){var p=document.querySelector('.zcwv-update');var bs=p.querySelectorAll('button');" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent==='\\u5173\\u95ed\\u63d2\\u4ef6'){bs[i].click();break}}" +
        "return JSON.stringify({armed:window.__upClose===true,label:bs[bs.length-1].textContent})})()"
    )
  )
  check(
    '关闭插件：第一次点只改文案（确认关闭？），不发关闭请求',
    !!upCloseArmed && upCloseArmed.armed === false && upCloseArmed.label === '\u786e\u8ba4\u5173\u95ed\uff1f',
    JSON.stringify(upCloseArmed)
  )
  const upCloseFired = JSON.parse(
    await cdp.eval(
      "(function(){var p=document.querySelector('.zcwv-update');var bs=p.querySelectorAll('button');" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent==='\\u786e\\u8ba4\\u5173\\u95ed\\uff1f'){bs[i].click();break}}" +
        "return JSON.stringify({fired:window.__upClose===true})})()"
    )
  )
  check('关闭插件：第二次点才发 action=close', !!upCloseFired && upCloseFired.fired === true, JSON.stringify(upCloseFired))
  const upClosed = JSON.parse(
    await cdp.eval(
      "(function(){var p=document.querySelector('.zcwv-update');var bs=p.querySelectorAll('button');" +
        "for(var i=0;i<bs.length;i++){if(bs[i].textContent==='\\u8fd4\\u56de'){bs[i].click();" +
        "return JSON.stringify({open:p.classList.contains('zcwv-panel-open')})}}return JSON.stringify({err:'no-back'})})()"
    )
  )
  check('更新面板：返回按钮收起面板', !!upClosed && upClosed.open === false, JSON.stringify(upClosed))
  if (stubUp && stubUp.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubUp.identifier })

  // ⑭ 按模型换角色 + 等确认提醒（v-next）
  // 桩直接在当前页面里覆盖 fetch（不 reload）：模型/钩子状态由 window.__model、
  // window.__hook 两个旋钮驱动，页面自己的 3s（会话）/5s（钩子）轮询会跟着变。
  const stubAuto = await cdp.eval(
    "(function(){if(window.__stubInstalled)return 'already';window.__stubInstalled=1;" +
      'window.__model="deepseek/deepseek-flash";window.__hook={ts:0,waiting:false,event:""};var real=window.fetch;' +
      "function json(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{'Content-Type':'application/json'}}))}" +
      'var U={ok:true,today:{total:0,tokens:0,totals:{},models:[]}};' +
      'window.fetch=function(u,o){var s=String(u&&u.url?u.url:u);' +
      "if(s.indexOf('/whale/session.json')!==-1)return json({ok:true,source:'stub',vendor:'stub',label:'Stub',timeMode:'none',modelId:window.__model,currency:'CNY',from:'selection'});" +
      "if(s.indexOf('/whale/usage-records.json')!==-1)return json(U);" +
      "if(s.indexOf('/whale/hook.json')!==-1)return json({ok:true,configured:window.__hook.ts>0,event:window.__hook.event,tool:'',ts:window.__hook.ts,ageSec:0,fresh:true,waiting:window.__hook.waiting,counts:{}});" +
      'return real.apply(this,arguments)};return "ok"})()'
  )
  check('测试桩已生效（fetch 桩覆盖成功；桩失效会让下面的断言给出误导性结果）', stubAuto === 'ok', String(stubAuto))
  const roleNow = async () =>
    cdp.eval(
      "(function(){var ts=document.querySelectorAll('.zcwv-role-trigger'),n=null;" +
        "for(var i=0;i<ts.length;i++){if((ts[i].title||'').indexOf('\\u9009\\u62e9\\u5f62\\u8c61')===0){n=ts[i].querySelector('.zcwv-role-name')}}" +
        'return n?n.textContent:null})()'
    )
  // 页面断言统一走容错解析：eval 里若抛异常会返回 undefined，直接 JSON.parse 会把
  // 症状掩盖成「undefined 不是合法 JSON」（本次新增用例踩过这个坑）
  const parseJsonSafe = (raw) => {
    try {
      return JSON.parse(raw)
    } catch (err) {
      return { err: 'bad-json:' + String(raw).slice(0, 80) }
    }
  }
  // 菜单行结构：按模型换角色（默认勾选）+ 「等确认提醒」复选框（默认不勾，和
  // 按压泡泡设置同一行；菜单里不再有「钩子 <最近事件>」那行——诊断走 /whale/hook.json）
  const menuNewRows = parseJsonSafe(
    await cdp.eval(
      "(function(){var rows=document.querySelectorAll('.zcwv-menu-row');var out={auto:null,ask:null,askRowHasBubbleBtn:false,hookRowGone:true};" +
        "for(var i=0;i<rows.length;i++){var t=rows[i].textContent;" +
        "if(t.indexOf('\\u6309\\u6a21\\u578b\\u6362\\u89d2\\u8272')!==-1){var cb=rows[i].querySelector('.zcwv-check');out.auto=cb?cb.checked:null}" +
        "if(t.indexOf('\\u7b49\\u786e\\u8ba4\\u63d0\\u9192')!==-1){var cb2=rows[i].querySelector('.zcwv-ask-check');out.ask=cb2?cb2.checked:null;" +
        "var bs=rows[i].querySelectorAll('button');for(var j=0;j<bs.length;j++){if(bs[j].textContent.indexOf('\\u6309\\u538b\\u6ce1\\u6ce1\\u8bbe\\u7f6e')!==-1)out.askRowHasBubbleBtn=true}}" +
        "if(t.indexOf('\\u94a9\\u5b50')!==-1)out.hookRowGone=false}" +
        'return JSON.stringify(out)})()'
    )
  )
  const autoSwitch = async () =>
    parseJsonSafe(
      await cdp.eval(
        "(function(){try{var rows=document.querySelectorAll('.zcwv-menu-row');" +
          "for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('\\u6309\\u6a21\\u578b\\u6362\\u89d2\\u8272')!==-1){" +
          "var cb=rows[i].querySelector('.zcwv-check');return JSON.stringify({checked:cb?cb.checked:null})}}return '{}'}catch(e){return JSON.stringify({err:String(e)})}})()"
      )
    )
  const clickAutoSwitch = () =>
    cdp.eval(
      "(function(){var rows=document.querySelectorAll('.zcwv-menu-row');for(var i=0;i<rows.length;i++){" +
        "if(rows[i].textContent.indexOf('\\u6309\\u6a21\\u578b\\u6362\\u89d2\\u8272')!==-1){rows[i].querySelector('.zcwv-check').click();return true}}return false})()"
    )
  const menuIsOpen = () => cdp.eval("(function(){return !!document.querySelector('.zcwv-menu.zcwv-menu-open')})()")
  const ensureMenuOpen = async () => {
    if (!(await menuIsOpen())) await cdp.eval("(function(){document.querySelector('.zcwv-menu-btn').click();return true})()")
    await new Promise((r) => setTimeout(r, 800))
  }
  check(
    '菜单：「等确认提醒」和按压泡泡设置同一行、默认不勾；「钩子 <最近事件>」诊断行已移除',
    typeof menuNewRows.auto === 'boolean' &&
      menuNewRows.ask === false &&
      menuNewRows.askRowHasBubbleBtn === true &&
      menuNewRows.hookRowGone === true,
    JSON.stringify(menuNewRows)
  )
  // 开关初值必须与 widget-state 一致：本次实现踩过「变量声明落在 buildMenu 调用之后，
  // 初始化时把引用又置回 null/undefined」的坑——那时复选框初值就不对、点它还抛异常
  const wsAuto = await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()
  check(
    '按模型换角色：开关初值与 widget-state 一致（防声明顺序类回归）',
    menuNewRows.auto === (wsAuto.autoRole !== false),
    JSON.stringify({ ui: menuNewRows.auto, state: wsAuto.autoRole })
  )
  // 前面的用例点过角色列表（= 手动表态）把开关关掉了，这里按用户的做法重新打开
  if (!(await autoSwitch()).checked) await clickAutoSwitch()
  await new Promise((r) => setTimeout(r, 600))
  const switchOn = (await autoSwitch()).checked === true
  check('按模型换角色：开关可重新打开（打开即按当前模型判一次）', switchOn, JSON.stringify(await autoSwitch()))
  // 按模型换角色：期望值按「实际存在的角色」算——前面的用例删过内置形象，
  // 这里从 roles.json 现读，避免把测试写成对删除顺序的隐式依赖
  const rolesNow = await (await fetch('http://127.0.0.1:' + PORT + '/whale/roles.json')).json()
  const hasRole = (id) => (rolesNow.roles || []).some((r) => r && r.id === id)
  const nameOf = (id) => {
    const hit = (rolesNow.roles || []).find((r) => r && r.id === id)
    return hit ? hit.name : null
  }
  const beforeAuto = await roleNow()
  const expectAfter = (id) => (hasRole(id) ? nameOf(id) : beforeAuto) // 角色缺失时不该换人
  const snap = async () =>
    parseJsonSafe(
      await cdp.eval(
        "(function(){try{function q(s){var n=document.querySelector(s);return n?n.textContent:null}" +
          "var rows=document.querySelectorAll('.zcwv-menu-row'),sw=null;" +
          "for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('\\u6309\\u6a21\\u578b\\u6362\\u89d2\\u8272')!==-1){var cb=rows[i].querySelector('.zcwv-check');sw=cb?cb.checked:null}}" +
          "return JSON.stringify({model:String(window.__model),stub:!!window.__stubInstalled,auto:q('.zcwv-role-name'),switchOn:sw})}catch(e){return JSON.stringify({err:String(e)})}})()"
      )
    )
  // 迟滞（P3-4）：同一目标要连续两拍才切，而模型轮询间隔是 3 秒 → 一次模型族变化
  // 最迟约 6 秒后才生效。留 7 秒，并把「不该换人」的负向用例也拉到同一时长，
  // 免得断言因为窗口太短而恒真。
  const AUTO_ROLE_SETTLE_MS = 7000
  // 先切回 deepseek-flash 并等迟滞，确认切到 whale（大肥鱼）——前面的用例手动选过角色，
  // 这里从「当前模型」重新收敛，避免把断言写成对前面用例残留状态的隐式依赖
  await cdp.eval("window.__model='deepseek/deepseek-flash'")
  await new Promise((r) => setTimeout(r, AUTO_ROLE_SETTLE_MS))
  const afterDs = await roleNow()
  await cdp.eval("window.__model='zai-org/GLM-5.3'")
  await new Promise((r) => setTimeout(r, AUTO_ROLE_SETTLE_MS))
  const afterGlm = await roleNow()
  const snapGlm = await snap()
  await cdp.eval("window.__model='cmdgo-bridge/moonshotai/Kimi-K3'")
  await new Promise((r) => setTimeout(r, AUTO_ROLE_SETTLE_MS))
  const afterKimi = await roleNow()
  await cdp.eval("window.__model='google/gemini-4-argon'")
  await new Promise((r) => setTimeout(r, AUTO_ROLE_SETTLE_MS))
  const afterGemini = await roleNow()
  check(
    '按模型换角色：模型族切换 → 形象跟着换（DeepSeek / GLM / Kimi / Gemini→哈基米；缺失的角色不换）',
    afterDs === expectAfter('whale') && afterGlm === expectAfter('fox') && afterKimi === expectAfter('kimi') &&
      afterKimi === nameOf('kimi') && afterGemini === expectAfter('gemini') && afterGemini === nameOf('gemini'),
    JSON.stringify({ ds: afterDs, glm: afterGlm, kimi: afterKimi, gemini: afterGemini, has: { whale: hasRole('whale'), fox: hasRole('fox'), kimi: hasRole('kimi'), gemini: hasRole('gemini') }, snap: snapGlm, pageErr: cdp.exceptions.slice(-2) })
  )
  // 手动选角色 = 明确表态：开关自动关掉，之后模型再变也不跟随
  const manual = parseJsonSafe(
    (await cdp.eval(
      "(function(){try{var ts=document.querySelectorAll('.zcwv-role-trigger');" +
        "for(var i=0;i<ts.length;i++){if((ts[i].title||'').indexOf('\\u9009\\u62e9\\u5f62\\u8c61')===0){ts[i].click();break}}" +
        "var rows=document.querySelectorAll('.zcwv-role-row');" +
        "for(var i=0;i<rows.length;i++){var p=rows[i].querySelector('.zcwv-role-pick');" +
        "if(p&&p.textContent!=='\\u5c0f\\u514b'){var nm=p.textContent;p.click();return JSON.stringify({picked:true,name:nm})}}" +
        'return JSON.stringify({picked:false})}catch(e){return JSON.stringify({err:String(e)})}})()'
    )) || '{"err":"eval-undefined"}'
  )
  await new Promise((r) => setTimeout(r, 700))
  const autoOff = parseJsonSafe(
    await cdp.eval(
      "(function(){var rows=document.querySelectorAll('.zcwv-menu-row');" +
        "for(var i=0;i<rows.length;i++){if(rows[i].textContent.indexOf('\\u6309\\u6a21\\u578b\\u6362\\u89d2\\u8272')!==-1){" +
        "var cb=rows[i].querySelector('.zcwv-check');return JSON.stringify({checked:cb?cb.checked:null})}}return '{}'})()"
    )
  )
  await cdp.eval("window.__model='deepseek/deepseek-flash'")
  await new Promise((r) => setTimeout(r, AUTO_ROLE_SETTLE_MS))
  const afterManual = await roleNow()
  check(
    '手动选角色后「按模型换角色」自动关闭，且模型再变也不跟随（尊重手动选择）',
    manual.picked === true && autoOff.checked === false && afterManual === manual.name,
    JSON.stringify({ manual, autoOff, after: afterManual })
  )
  // 重新打开开关：模型立即生效，不必等下一拍轮询
  if (!(await autoSwitch()).checked) await clickAutoSwitch()
  await new Promise((r) => setTimeout(r, 900))
  const afterReopen = await roleNow()
  check(
    '重新打开「按模型换角色」时立刻按当前模型判一次（不等 3 秒轮询）',
    afterReopen === expectAfter('whale'),
    JSON.stringify({ after: afterReopen, expect: expectAfter('whale'), switch: await autoSwitch() })
  )
  // 角色彩色渐变（哈基米）：切到它 → 装饰件渐变变量与气泡 SVG 描边渐变都生效；
  // 切回非渐变角色（大肥鱼）→ 变量清空、描边回到实色。两面对照才说明「只有渐变角色吃」
  const gradSnapOf = async () =>
    parseJsonSafe(
      await cdp.eval(
        "(function(){var cs=getComputedStyle(document.documentElement);" +
          "var stops=document.querySelectorAll('#zcwInkGrad .zcwv-inkstop');var cols=[];" +
          "for(var i=0;i<stops.length;i++)cols.push(stops[i].getAttribute('stop-color'));" +
          "return JSON.stringify({grad:(cs.getPropertyValue('--zcw-role-ink-grad')||'').trim()," +
          "bubbleInk:(cs.getPropertyValue('--zcw-bubble-ink')||'').trim(),stops:cols})})()"
      )
    )
  const gradPickedGem = await pickRoleByName('哈基米')
  await new Promise((r) => setTimeout(r, 1200))
  const gradSnapGem = await gradSnapOf()
  const gradPickedWhale = await pickRoleByName('大肥鱼')
  await new Promise((r) => setTimeout(r, 1200))
  const gradSnapWhale = await gradSnapOf()
  check(
    '角色渐变：哈基米的气泡描边走 SVG 渐变、装饰件拿到 linear-gradient 变量',
    gradPickedGem === 'ok' &&
      !!gradSnapGem &&
      gradSnapGem.bubbleInk === 'url(#zcwInkGrad)' &&
      gradSnapGem.grad.indexOf('linear-gradient') === 0 &&
      gradSnapGem.grad.indexOf('#9cd5d0') !== -1 &&
      gradSnapGem.grad.indexOf('#cce1ac') !== -1 &&
      gradSnapGem.grad.indexOf('#f2ebb6') !== -1 &&
      gradSnapGem.stops.length === 7 &&
      gradSnapGem.stops[0] === '#9cd5d0' &&
      gradSnapGem.stops[1] === '#80c0f1',
    JSON.stringify({ picked: gradPickedGem, grad: gradSnapGem })
  )
  check(
    '角色渐变：非渐变角色（大肥鱼）没有渐变（描边回到实色、装饰件变量清空）',
    gradPickedWhale === 'ok' &&
      !!gradSnapWhale &&
      gradSnapWhale.grad === '' &&
      /^#[0-9a-f]{6}$/i.test(gradSnapWhale.bubbleInk),
    JSON.stringify({ picked: gradPickedWhale, grad: gradSnapWhale })
  )
  // 等确认提醒：先开启开关（它在「气泡」行、与按压泡泡设置同一行；「钩子 <最近事件>」
  // 那一行已移除），再喂 waiting=true → 弹一次；同 ts 再轮询不重复弹
  const hookTs = Math.floor(Date.now() / 1000)
  await cdp.eval(
    '(function(){window.__hook={ts:' + hookTs + ",waiting:false,event:'UserPromptSubmit'};return true})()"
  )
  await ensureMenuOpen()
  const clickAskSwitch = () =>
    cdp.eval(
      "(function(){var rows=document.querySelectorAll('.zcwv-menu-row');for(var i=0;i<rows.length;i++){" +
        "if(rows[i].textContent.indexOf('\\u7b49\\u786e\\u8ba4\\u63d0\\u9192')!==-1){rows[i].querySelector('.zcwv-ask-check').click();return true}}return false})()"
    )
  const askSwitchState = async () =>
    parseJsonSafe(
      await cdp.eval(
        "(function(){var rows=document.querySelectorAll('.zcwv-menu-row');for(var i=0;i<rows.length;i++){" +
          "if(rows[i].textContent.indexOf('\\u7b49\\u786e\\u8ba4\\u63d0\\u9192')!==-1){var cb=rows[i].querySelector('.zcwv-ask-check');" +
          "return JSON.stringify({checked:cb?cb.checked:null})}}return '{}'})()"
      )
    )
  if (!(await askSwitchState()).checked) await clickAskSwitch()
  await new Promise((r) => setTimeout(r, 400))
  const askOn = await askSwitchState()
  check('等确认提醒：开关可打开（与按压泡泡设置同行的复选框）', askOn && askOn.checked === true, JSON.stringify(askOn))
  await cdp.eval(
    '(function(){window.__hook={ts:' + (hookTs + 1) + ",waiting:true,event:'PermissionRequest'};return true})()"
  )
  await ensureMenuOpen() // 再刷一次 → waiting 生效
  const alertShown = await pollEval(
    cdp,
    "(function(){var b=document.querySelector('.zcwv-bubble');var l=document.querySelector('.zcwv-label');" +
      "return (b&&b.classList.contains('zcwv-bubble-open')&&l&&l.textContent.indexOf('\\u5728\\u7b49\\u4f60\\u786e\\u8ba4')!==-1)?l.textContent:null})()",
    9000
  )
  check('等确认提醒：开启后宿主发通知 → 挂件弹一次提醒气泡', !!alertShown, JSON.stringify(alertShown))
  // 关掉气泡 → 同一事件时间戳再轮询一次 → 不应再弹（去重按 ts）
  await cdp.eval(
    "(function(){var b=document.querySelector('.zcwv-bubble');b.dispatchEvent(new MouseEvent('click',{bubbles:true}));return true})()"
  )
  await new Promise((r) => setTimeout(r, 600))
  await ensureMenuOpen() // 触发 pollHook（同一 ts）
  await new Promise((r) => setTimeout(r, 1200))
  const alertAgain = await cdp.eval(
    "(function(){var b=document.querySelector('.zcwv-bubble');var l=document.querySelector('.zcwv-label');" +
      "return (b&&b.classList.contains('zcwv-bubble-open')&&l&&l.textContent.indexOf('\\u5728\\u7b49\\u4f60\\u786e\\u8ba4')!==-1)?true:false})()"
  )
  check('等确认提醒：同一事件只提醒一次（按事件时间戳去重，不刷屏）', alertAgain === false, JSON.stringify(alertAgain))
  // 桩是页面内覆盖的（见上），不需要 removeScriptToEvaluateOnNewDocument

  // （原 ⑮「接管看门狗」用例已随该修复一并回滚：实测它没有解决宿主暂停，
  //   而「接管中 6 秒无活动就交还」本身还有副作用——指针停在角色上超过 6 秒后
  //   角色会变成点不到。相关代码与自检钉桩都已移除。）
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
