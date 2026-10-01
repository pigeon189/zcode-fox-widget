// 前端冒烟：headless Edge/Chrome + CDP，加载真实挂件页面跑两条前端链路。
// widget.js 是 IIFE、内部函数拿不到，所以全部走真实交互：
//   1. 套餐轮次气泡（Start plan 等订阅配额）显示「本轮消耗余额: x%」——金额是
//      虚构的；混合轮次 hint 补「另耗 ¥」；超宽文字自适应缩字/换行不顶出色泡
//      ——回归按量价目套在订阅配额上算钱、长文案顶破气泡两个缺陷
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

// ZCode 自己的用户配置：ui.theme = zai-light。挂件主题里的「跟随 ZCode」读它，
// 测试里把系统偏好模拟成深色来验证挂件跟的是 ZCode 而不是操作系统。
fs.mkdirSync(path.join(tmpHome, 'cli'), { recursive: true })
fs.writeFileSync(
  path.join(tmpHome, 'cli', 'config.json'),
  JSON.stringify({ ui: { locale: 'zh-CN', theme: 'zai-light' } }, null, 2),
  'utf8'
)

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

  // ① 套餐轮次气泡（v1.4.0 余额口径）：GLM-4.7-Flash 免费（billable=false）+
  //    account:zai-start-plan（套餐行），120k/1M 配额 = 12%——主数字显示「消耗
  //    余额百分比」而不是虚构金额，也不再是旧的 tokens+占配额组合
  insertTurn('turn_free', 'GLM-4.7-Flash', 'account:zai-start-plan', 100_000, 20_000)
  const cost1 = JSON.parse(
    (await pollEval(
      cdp,
      "(function(){var l=document.querySelector('.zcwv-label'),a=document.querySelector('.zcwv-amount'),h=document.querySelector('.zcwv-hint');" +
        "if(!l||!a||l.textContent!=='本轮消耗余额:')return null;" +
        "return JSON.stringify({amount:a.textContent,hint:h&&h.style.display!=='none'?h.textContent:''})})()",
      15000
    )) || 'null'
  )
  check(
    '套餐轮次气泡显示「本轮消耗余额: 12%」（不是虚构金额）',
    !!cost1 && cost1.amount === '12%' && String(cost1.hint).indexOf('消耗 12.0 万 tokens') !== -1,
    JSON.stringify(cost1)
  )

  // ①b 智能跟随主显示：selection 缺失时回落 model_usage（account:zai-start-plan
  // → Plan 配额口径），主数字是剩余百分比而不是 DeepSeek 余额
  // （必须赶在混合轮次插入前跑：turn_mix 的最后一行是 DeepSeek，会把回落源带偏）
  const planView = await pollEval(
    cdp,
    "(function(){var l=document.querySelector('.zcwv-label'),a=document.querySelector('.zcwv-amount');" +
      "return l&&a&&l.textContent==='Plan 配额'?(l.textContent+' | '+a.textContent):null})()",
    15000
  )
  check(
    'auto 跟随回落 model_usage：主显示切到 Plan 配额（百分比主数字）',
    typeof planView === 'string' && planView.indexOf('%') !== -1,
    'view=' + JSON.stringify(planView)
  )

  // ①-2 混合轮次：套餐行 + 付费行。主数字仍是配额口径，hint 用「另耗 ¥」补上
  //    非套餐行的真实开销；hint 文字长，顺带验证气泡文字自适应（缩字/换行后
  //    不超出安全行宽）
  db.prepare(
    `INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at, input_tokens, output_tokens, computed_total_tokens)
     VALUES ('sess_smoke', 'turn_mix', 'completed', ?, ?, 490000, 10000, 500000)`
  ).run(Date.now() - 1000, Date.now())
  const mixRows = [
    ['mu-mix-glm', 'GLM-4.7-Flash', 'account:zai-start-plan', 400_000, 0, 400_000],
    ['mu-mix-ds', 'deepseek-flash', 'deepseek-test', 90_000, 10_000, 100_000],
  ]
  for (const [id, model, providerId, input, output, total] of mixRows) {
    db.prepare(
      `INSERT INTO model_usage (id, session_id, turn_id, model_id, provider_id, started_at, input_tokens, output_tokens, computed_total_tokens)
       VALUES (?, 'sess_smoke', 'turn_mix', ?, ?, ?, ?, ?, ?)`
    ).run(id, model, providerId, Date.now() - 1000, input, output, total)
  }
  const cost2 = JSON.parse(
    (await pollEval(
      cdp,
      "(function(){var l=document.querySelector('.zcwv-label'),a=document.querySelector('.zcwv-amount'),h=document.querySelector('.zcwv-hint');" +
        "if(!l||!a||l.textContent!=='本轮消耗余额:'||a.textContent!=='40%')return null;" +
        'var b=document.querySelector(\'.zcwv-bubble\').getBoundingClientRect();' +
        'var avail=560*(b.width/1026),r=document.createRange();r.selectNodeContents(h);' +
        'return JSON.stringify({amount:a.textContent,hint:h.style.display!==\'none\'?h.textContent:\'\',' +
        'w:Math.round(r.getBoundingClientRect().width),avail:Math.round(avail),' +
        'fs:h.style.fontSize,ws:h.style.whiteSpace})})()',
      15000
    )) || 'null'
  )
  check(
    '混合轮次：配额口径主数字 + hint 补「另耗 ¥」真实开销',
    !!cost2 && cost2.amount === '40%' && String(cost2.hint).indexOf('消耗 40.0 万 tokens') !== -1 && String(cost2.hint).indexOf('另耗 ¥') !== -1,
    JSON.stringify(cost2)
  )
  check(
    '气泡文字自适应：超宽 hint 缩字/换行后不超出安全行宽',
    !!cost2 && Number(cost2.w) <= Number(cost2.avail) + 1 && (cost2.fs !== '' || cost2.ws === 'normal'),
    JSON.stringify(cost2)
  )

  // ①-3 无价目且非套餐的轮次（未知网关）：tokens 口径，绝不显示虚构金额
  insertTurn('turn_unk', 'zz-unknown-model', 'mystery-gateway', 3000, 2000)
  const cost3 = JSON.parse(
    (await pollEval(
      cdp,
      "(function(){var l=document.querySelector('.zcwv-label'),a=document.querySelector('.zcwv-amount');" +
        "if(!l||!a||l.textContent!=='本轮 tokens:')return null;" +
        "return JSON.stringify({amount:a.textContent})})()",
      15000
    )) || 'null'
  )
  check('无价目非套餐轮次显示 tokens 口径', !!cost3 && cost3.amount === '5,000', JSON.stringify(cost3))

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

  // ⑦ 角色：自定义下拉（不再是原生 select）——内置小狐娘/小鲸鱼无删除按钮，
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
    // title「选择形象」锁定角色触发器；列表按内容含「小狐娘」锁定角色列表
    "(function(){var ts=document.querySelectorAll('.zcwv-role-trigger'),t=null;" +
      "for(var i=0;i<ts.length;i++){if((ts[i].title||'').indexOf('\\u9009\\u62e9\\u5f62\\u8c61')===0){t=ts[i];break}}" +
      'if(!t)return null;t.click();' +
      "var ls=document.querySelectorAll('.zcwv-roles'),list=null;" +
      "for(var i=0;i<ls.length;i++){if(ls[i].textContent.indexOf('\\u5c0f\\u72d0\\u5a18')!==-1){list=ls[i];break}}" +
      'var rows=list?list.querySelectorAll(\'.zcwv-role-row\'):[],names=[],del=0,builtin=0;' +
      "for(var i=0;i<rows.length;i++){var p=rows[i].querySelector('.zcwv-role-pick');names.push(p?p.textContent:'');" +
      'if(rows[i].querySelector(\'.zcwv-role-del\'))del++;if(rows[i].querySelector(\'.zcwv-role-builtin\'))builtin++}' +
      'return {names:names,del:del,builtin:builtin,open:!!(list&&list.classList.contains(\'zcwv-roles-open\')),' +
      "trigger:t.querySelector('.zcwv-role-name').textContent}})()",
    12000
  )
  check(
    '角色下拉：三行都有删除（内置两个也可删，v1.6.0）+ 触发器显示当前角色名',
    roleView &&
      roleView.names.indexOf('小狐娘') !== -1 &&
      roleView.names.indexOf('小鲸鱼') !== -1 &&
      roleView.names.indexOf('冒烟角色') !== -1 &&
      roleView.del === 3 &&
      roleView.builtin === 2 &&
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
    '删除当前导入角色后回落默认小狐娘（roles 只剩内置、图片 608px）',
    rolesAfterDelete.roles.length === 2 && rolesAfterDelete.selected === 'xiaohuniang' && imgAfterDelete === 608,
    JSON.stringify({ n: rolesAfterDelete.roles.length, selected: rolesAfterDelete.selected, nw: imgAfterDelete })
  )
  // ⑦d 内置形象也能删（v1.6.0）：删掉「小狐娘」→ 列表少一个、选中的不再是它、
  //     鲸鱼图片仍拿得到（回落到剩下的形象）
  const builtinDelArmed = await cdp.eval(
    "(function(){var rows=document.querySelectorAll('.zcwv-role-row'),t=null;" +
      "for(var i=0;i<rows.length;i++){var p=rows[i].querySelector('.zcwv-role-pick');" +
      "if(p&&p.textContent==='小狐娘'){t=rows[i].querySelector('.zcwv-role-del')}}if(!t)return null;t.click();" +
      "var rows2=document.querySelectorAll('.zcwv-role-row');for(var j=0;j<rows2.length;j++){var p2=rows2[j].querySelector('.zcwv-role-pick');" +
      "if(p2&&p2.textContent==='小狐娘'){var d=rows2[j].querySelector('.zcwv-role-del');return d?d.textContent:null}}return 'gone'})()"
  )
  check('内置形象也能两步删除（点一次进入「再点删除」）', builtinDelArmed === '再点删除', JSON.stringify(builtinDelArmed))
  await cdp.eval(
    "(function(){var rows=document.querySelectorAll('.zcwv-role-row');for(var i=0;i<rows.length;i++){var p=rows[i].querySelector('.zcwv-role-pick');" +
      "if(p&&p.textContent==='小狐娘'){var d=rows[i].querySelector('.zcwv-role-del');if(d){d.click();return true}}}return false})()"
  )
  await new Promise((r) => setTimeout(r, 1200))
  const rolesAfterBuiltinDel = await (await fetch('http://127.0.0.1:' + PORT + '/whale/roles.json')).json()
  const imgAfterBuiltinDel = await cdp.eval(
    "(function(){var img=document.querySelector('img[src*=\"image.png\"]');return img?img.naturalWidth:0})()"
  )
  check(
    '删掉内置「小狐娘」：列表不再有它、选中项换人、图片仍可用',
    rolesAfterBuiltinDel.roles.filter((r) => r.builtin).map((r) => r.id).join(',') === 'whale' &&
      rolesAfterBuiltinDel.selected !== 'xiaohuniang' &&
      imgAfterBuiltinDel > 1,
    JSON.stringify({ builtins: rolesAfterBuiltinDel.roles.filter((r) => r.builtin).map((r) => r.id), selected: rolesAfterBuiltinDel.selected, nw: imgAfterBuiltinDel })
  )
  // 复原：把 hiddenBuiltins 清掉（= README 写的找回方式），内置形象回来
  const rolesIdxFile = path.join(tmpHome, 'whale', 'roles.json')
  const rolesIdx = JSON.parse(fs.readFileSync(rolesIdxFile, 'utf8'))
  rolesIdx.hiddenBuiltins = []
  fs.writeFileSync(rolesIdxFile, JSON.stringify(rolesIdx, null, 2), 'utf8')
  const rolesRestored = await (await fetch('http://127.0.0.1:' + PORT + '/whale/roles.json')).json()
  check(
    '清掉 hiddenBuiltins 后内置形象回来（README 的找回路径）',
    rolesRestored.roles.filter((r) => r.builtin).length === 2,
    JSON.stringify(rolesRestored.roles.filter((r) => r.builtin).map((r) => r.id))
  )

  // ⑧ 主题：三个选项（浅色模式/深色模式/跟随 ZCode）；「跟随 ZCode」跟的是
  // ZCode 的主题（ui.theme），不是操作系统
  const themeOpts = JSON.parse(
    await cdp.eval(
      "(function(){var ss=document.querySelectorAll('select'),out=null;for(var i=0;i<ss.length;i++){var vals=[],texts=[];" +
        'for(var j=0;j<ss[i].options.length;j++){vals.push(ss[i].options[j].value);texts.push(ss[i].options[j].textContent)}' +
        "if(vals.indexOf('system')!==-1){out={vals:vals,texts:texts};break}}return JSON.stringify(out)})()"
    )
  )
  check(
    '主题下拉：浅色模式 / 深色模式 / 跟随 ZCode',
    themeOpts &&
      themeOpts.vals.indexOf('light') !== -1 &&
      themeOpts.vals.indexOf('dark') !== -1 &&
      themeOpts.vals.indexOf('system') !== -1 &&
      themeOpts.texts.indexOf('浅色模式') !== -1 &&
      themeOpts.texts.indexOf('深色模式') !== -1 &&
      themeOpts.texts.indexOf('跟随 ZCode') !== -1,
    JSON.stringify(themeOpts)
  )
  // 把系统偏好模拟成深色，而 fixture 里 ZCode 是 zai-light（浅色）：
  // 页面必须仍是浅色 = 跟的是 ZCode 而不是系统
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
      "(function(){return JSON.stringify({dark:document.documentElement.classList.contains('zcw-theme-dark')," +
        "prefers:window.matchMedia('(prefers-color-scheme: dark)').matches})})()"
    )
  )
  check(
    '主题「跟随 ZCode」跟 ZCode 主题（系统模拟深色、ZCode 浅色 → 页面仍浅色）',
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
      '主题下拉打开为主题化列表（3 项 + 当前项高亮）',
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
          'return JSON.stringify({dark:document.documentElement.classList.contains(\'zcw-theme-dark\'),' +
          'label:label,val:val,listClosed:document.querySelectorAll(\'.zcwv-roles.zcwv-roles-open\').length===0})})()'
      )
    )
    check(
      '点「深色模式」后主题生效、触发器文字与 select.value 同步、列表收起',
      ddResult && ddResult.dark === true && ddResult.label === '深色模式' && ddResult.val === 'dark' && ddResult.listClosed === true,
      JSON.stringify(ddResult)
    )
  }

  // 后面的按钮配色断言针对深色主题，这里切回去（顺带验证 dark 仍能落盘生效）
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, theme: 'dark' }),
  })
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))

  // ⑨ 预警：DS¥/BM¥ 合并成同一行里的「余额¥」，与 Plan% 并列
  const alertRow = JSON.parse(
    await cdp.eval(
      "(function(){var rows=document.querySelectorAll('.zcwv-menu-row'),hit=null;" +
        "for(var i=0;i<rows.length;i++){var t=rows[i].textContent;" +
        "if(t.indexOf('预警 Plan%')!==-1){hit={text:t,inputs:rows[i].querySelectorAll('input[type=number]').length}}}return JSON.stringify(hit)})()"
    )
  )
  check(
    '预警行：Plan% 与余额¥ 同一行、两个输入框',
    alertRow && alertRow.text.indexOf('余额¥') !== -1 && alertRow.inputs === 2 && alertRow.text.indexOf('DS¥') === -1 && alertRow.text.indexOf('BM¥') === -1,
    JSON.stringify(alertRow)
  )
  await fetch('http://127.0.0.1:' + PORT + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, alerts: { planPct: 20, moneyAlert: 1.5 } }),
  })
  const alertBack = await (await fetch('http://127.0.0.1:' + PORT + '/whale/size.json')).json()
  check(
    '余额预警阈值持久化（moneyAlert）',
    alertBack.alerts && alertBack.alerts.planPct === 20 && alertBack.alerts.moneyAlert === 1.5,
    JSON.stringify(alertBack.alerts)
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

  await putSize({ scale: 1.5, theme: 'dark', displayMode: 'auto', alerts: { planPct: 0, moneyAlert: 0 } })
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
  if (stubA && stubA.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubA.identifier })

  // ⑫ 金额预警的币种口径（复审 N4）：阈值是「元」，美元厂商按近似汇率折算后比较。
  // $1.2 撞 ¥5 阈值在纯数值比较下不会触发（漏报），折算后 ¥8.52 应当触发，
  // 文案里给出原币与折算值。
  await putSize({ scale: 1.5, theme: 'dark', displayMode: 'auto', alerts: { planPct: 0, moneyAlert: 5 } })
  const stubB = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stubScript(true) })
  await cdp.send('Page.reload')
  const alertText = await pollEval(
    cdp,
    "(function(){var l=document.querySelector('.zcwv-label');var p=document.querySelector('.zcwv-period');" +
      "if(!l||!p)return null;if(l.textContent!=='余额预警')return null;" +
      'var b=document.querySelector(\'.zcwv-bubble\').getBoundingClientRect();' +
      'var r=document.createRange();r.selectNodeContents(p);' +
      'return JSON.stringify({title:l.textContent,body:p.textContent,' +
      'w:Math.round(r.getBoundingClientRect().width),avail:Math.round(560*(b.width/1026)),' +
      'fs:p.style.fontSize,ws:p.style.whiteSpace})})()',
    20000,
    250
  )
  const alertObj = alertText ? JSON.parse(alertText) : null
  check(
    '金额预警：美元厂商折算成人民币后比较（$1.20 ≈ ¥8.52 ≥ ¥5.00 触发）',
    !!alertObj && alertObj.body.indexOf('OpenAI 今日已用 $1.20') === 0 && alertObj.body.indexOf('约 ¥8.52') !== -1 && alertObj.body.indexOf('达到 ¥5.00') !== -1,
    JSON.stringify(alertObj)
  )
  check(
    '预警长句自适应：缩字/换行后不超出安全行宽（v1.4.0 溢出修复）',
    !!alertObj && Number(alertObj.w) <= Number(alertObj.avail) + 1 && alertObj.fs !== '' && alertObj.ws === 'normal',
    'w=' + (alertObj && alertObj.w) + ' avail=' + (alertObj && alertObj.avail) + ' fs=' + (alertObj && alertObj.fs) + ' ws=' + (alertObj && alertObj.ws)
  )
  if (stubB && stubB.identifier) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stubB.identifier })
  await putSize({ scale: 1.5, theme: 'dark', displayMode: 'auto', alerts: { planPct: 0, moneyAlert: 0 } })

  // ⑬ Plan 观测 stale（客户端今天还没刷新过日志）：显示旧值 + 「数据截至」
  //    日期标注，而不是一直挂在「加载中…」（v1.4.1）
  const staleStub = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      '(function(){var real=window.fetch;function json(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{"Content-Type":"application/json"}}))}' +
      'var S={ok:true,source:"plan",vendor:"zcode-plan",label:"Plan 配额",timeMode:"none",modelId:"GLM-5.3-Flash",currency:"CNY",from:"selection"};' +
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
      "if(!l||!a||l.textContent!=='Plan 配额')return null;" +
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

  // ⑭ 冻结检测活性点：6px 灰点坐在鲸鱼不透明区，每 700ms 黑白翻转并暴露
  // phase（主进程拿它与桌面像素哈希对账）。页面侧验证：点存在、phase 在
  // 推进、位置落在鲸鱼图片矩形内。eval 无 awaitPromise，用 pollEval 的
  // 轮询观察 phase 推进（首次见到记 p1，phase 超过 p1 才返回样本）
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3500))
  const liveView = await pollEval(
    cdp,
    "(function(){var L=window.__zcwLive,d=document.getElementById('__zcwLive');" +
      'if(!L||!d)return null;' +
      'if(window.__smokeP1===undefined){window.__smokeP1=L.phase;return null}' +
      'if(L.phase<=window.__smokeP1)return null;' +
      "var ir=document.querySelector('.zcwv-img'),dr=d.getBoundingClientRect(),r2=ir?ir.getBoundingClientRect():null;" +
      'return JSON.stringify({p1:window.__smokeP1,p2:L.phase,' +
      'inImg:!!(r2&&dr.left>=r2.left-2&&dr.right<=r2.right+2&&dr.top>=r2.top-2&&dr.bottom<=r2.bottom+2),' +
      'w:dr.width})})()',
    12000
  )
  const liveObj = liveView ? JSON.parse(liveView) : null
  check(
    '冻结检测活性点：存在、phase 推进、坐在鲸鱼图内',
    !!liveObj && liveObj.p2 > liveObj.p1 && liveObj.inImg && liveObj.w <= 8,
    JSON.stringify(liveObj)
  )
  // ⑮ 用量记录：今日模型排名可在「按金额 / 按 Token」之间切换（v1.6.0）。
  // 先补一轮「小而贵」的模型，让两个榜的头部必然不同：GLM-4.7-Flash 是套餐
  // （金额 0、token 很大）→ token 榜第一；deepseek-flash 按量计价（金额 > 0）
  // → 金额榜第一。
  insertTurn('turn_rank', 'deepseek-flash', 'deepseek-test', 2000, 1000)
  await cdp.send('Page.reload')
  await new Promise((r) => setTimeout(r, 3000))
  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++){" +
      "if(bs[i].textContent==='用量记录…'){bs[i].click();return true}}return false})()"
  )
  const RANK_PROBE =
    "(function(){var bs=document.querySelectorAll('.zcw-panel .zcw-panel-close');var label=null;" +
    "for(var i=0;i<bs.length;i++){var t=bs[i].textContent;if(t==='按金额'||t==='按 Token')label=t}" +
    "if(!label)return null;var rows=document.querySelectorAll('.zcw-panel .zcw-row'),first='';" +
    "for(var j=0;j<rows.length;j++){var c=rows[j].firstChild,txt=c?c.textContent:'';" +
    "if(/^\\d+\\. /.test(txt)){first=txt;break}}" +
    'return JSON.stringify({label:label,first:first})})()'
  // 等「按 Token」出现才算切成功（fetchUsage 是异步的，点完立刻读会拿到旧 DOM）
  const RANK_PROBE_TOKENS =
    "(function(){var bs=document.querySelectorAll('.zcw-panel .zcw-panel-close');var label=null;" +
    "for(var i=0;i<bs.length;i++){var t=bs[i].textContent;if(t==='按金额'||t==='按 Token')label=t}" +
    "if(label!=='按 Token')return null;var rows=document.querySelectorAll('.zcw-panel .zcw-row'),first='';" +
    "for(var j=0;j<rows.length;j++){var c=rows[j].firstChild,txt=c?c.textContent:'';" +
    "if(/^\\d+\\. /.test(txt)){first=txt;break}}" +
    'return JSON.stringify({label:label,first:first})})()'
  const rankAmount = JSON.parse((await pollEval(cdp, RANK_PROBE, 8000)) || 'null')
  check(
    '用量记录：默认按金额排名（第一位是按量的 deepseek-flash）',
    !!rankAmount && rankAmount.label === '按金额' && rankAmount.first.indexOf('deepseek-flash') !== -1,
    JSON.stringify(rankAmount)
  )
  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('.zcw-panel .zcw-panel-close');for(var i=0;i<bs.length;i++){" +
      "var t=bs[i].textContent;if(t==='按金额'||t==='按 Token'){bs[i].click();return true}}return false})()"
  )
  const rankTokens = JSON.parse((await pollEval(cdp, RANK_PROBE_TOKENS, 8000)) || 'null')
  check(
    '用量记录：切到按 Token 排名（第一位变成 token 最大的套餐模型）',
    !!rankTokens && rankTokens.label === '按 Token' && rankTokens.first.indexOf('GLM-4.7-Flash') !== -1,
    JSON.stringify(rankTokens)
  )
  check(
    '用量记录：两个口径的第一名不同（说明真的换了排序）',
    !!rankAmount && !!rankTokens && rankAmount.first !== rankTokens.first,
    JSON.stringify({ amount: rankAmount && rankAmount.first, tokens: rankTokens && rankTokens.first })
  )
  // ⑮b 对账行（v1.7.0）：今日块里并排放「本机口径 ↔ 账号口径」，充值等调整
  // 用菜单里的余额校正记一笔后两套账就对得上。fixture 里有 deepseek-flash 行，
  // 本机口径必须是数字；账号口径在无 key 的冒烟环境里显示 --。
  const reconView = await pollEval(
    cdp,
    "(function(){var ds=document.querySelectorAll('.zcw-panel .zcw-dim');for(var i=0;i<ds.length;i++){" +
      "if(ds[i].textContent.indexOf('对账')===0)return ds[i].textContent}return null})()",
    8000
  )
  check(
    '用量记录：对账行并排显示本机口径与账号口径',
    !!reconView &&
      reconView.indexOf('对账（DeepSeek）') === 0 &&
      reconView.indexOf('本机 ¥') !== -1 &&
      reconView.indexOf('账号') !== -1 &&
      reconView.indexOf('本机 --') === -1,
    reconView
  )

  await cdp.eval(
    "(function(){var bs=document.querySelectorAll('.zcw-panel .zcw-panel-close');for(var i=0;i<bs.length;i++){" +
      "if(bs[i].textContent==='关闭'){bs[i].click();return true}}return false})()"
  )

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
  const sndView = JSON.parse((await pollEval(cdp, SND_PROBE, 8000)) || 'null')
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
  await new Promise((r) => setTimeout(r, 3000))
  const sndImported = JSON.parse((await pollEval(cdp, SND_PROBE, 8000)) || 'null')
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
