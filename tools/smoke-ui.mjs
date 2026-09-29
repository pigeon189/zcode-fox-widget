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

  // ①b 智能跟随主显示：selection 缺失时回落 model_usage（account:zai-start-plan
  // → Plan 配额口径），主数字是剩余百分比而不是 DeepSeek 余额
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
    "(function(){var t=document.querySelector('.zcwv-role-trigger');if(!t)return null;t.click();" +
      "var rows=document.querySelectorAll('.zcwv-role-row'),names=[],del=0,builtin=0;" +
      "for(var i=0;i<rows.length;i++){var p=rows[i].querySelector('.zcwv-role-pick');names.push(p?p.textContent:'');" +
      "if(rows[i].querySelector('.zcwv-role-del'))del++;if(rows[i].querySelector('.zcwv-role-builtin'))builtin++}" +
      "var img=document.querySelector('img[src*=\"image.png\"]');" +
      "return {names:names,del:del,builtin:builtin,open:document.querySelector('.zcwv-roles').classList.contains('zcwv-roles-open')," +
      "trigger:document.querySelector('.zcwv-role-name')?document.querySelector('.zcwv-role-name').textContent:''}})()",
    12000
  )
  check(
    '角色下拉：内置两项（无删除）+ 导入项（带 ×），触发器显示当前角色名',
    roleView &&
      roleView.names.indexOf('小狐娘') !== -1 &&
      roleView.names.indexOf('小鲸鱼') !== -1 &&
      roleView.names.indexOf('冒烟角色') !== -1 &&
      roleView.del === 1 &&
      roleView.builtin === 2 &&
      roleView.open === true &&
      roleView.trigger === '冒烟角色',
    JSON.stringify(roleView)
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
  //     删掉的正好是当前形象 → 回落默认小狐娘（图片仍是 608px 的小狐娘）
  const delArmed = await cdp.eval(
    "(function(){var b=document.querySelector('.zcwv-role-del');if(!b)return null;b.click();" +
      "return document.querySelector('.zcwv-role-del')?document.querySelector('.zcwv-role-del').textContent:null})()"
  )
  check('删除按钮两步确认（第一次点击进入「再点删除」）', delArmed === '再点删除', JSON.stringify(delArmed))
  await cdp.eval("(function(){var b=document.querySelector('.zcwv-role-del');if(b)b.click();return true})()")
  await new Promise((r) => setTimeout(r, 1200))
  const rolesAfterDelete = await (await fetch('http://127.0.0.1:' + PORT + '/whale/roles.json')).json()
  const imgAfterDelete = await cdp.eval(
    "(function(){var img=document.querySelector('img[src*=\"image.png\"]');return img?img.naturalWidth:0})()"
  )
  check(
    '删除导入角色后回落默认小狐娘（roles 只剩内置、图片 608px）',
    rolesAfterDelete.roles.length === 2 && rolesAfterDelete.selected === 'xiaohuniang' && imgAfterDelete === 608,
    JSON.stringify({ n: rolesAfterDelete.roles.length, selected: rolesAfterDelete.selected, nw: imgAfterDelete })
  )

  // ⑧ 主题：三个选项（浅色模式/深色模式/跟随系统），system 按系统偏好着色
  const themeOpts = JSON.parse(
    await cdp.eval(
      "(function(){var ss=document.querySelectorAll('select'),out=null;for(var i=0;i<ss.length;i++){var vals=[],texts=[];" +
        'for(var j=0;j<ss[i].options.length;j++){vals.push(ss[i].options[j].value);texts.push(ss[i].options[j].textContent)}' +
        "if(vals.indexOf('system')!==-1){out={vals:vals,texts:texts};break}}return JSON.stringify(out)})()"
    )
  )
  check(
    '主题下拉：浅色模式 / 深色模式 / 跟随系统',
    themeOpts &&
      themeOpts.vals.indexOf('light') !== -1 &&
      themeOpts.vals.indexOf('dark') !== -1 &&
      themeOpts.vals.indexOf('system') !== -1 &&
      themeOpts.texts.indexOf('浅色模式') !== -1 &&
      themeOpts.texts.indexOf('深色模式') !== -1 &&
      themeOpts.texts.indexOf('跟随系统') !== -1,
    JSON.stringify(themeOpts)
  )
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
    '主题「跟随系统」按 prefers-color-scheme 着色',
    sysTheme.dark === sysTheme.prefers,
    JSON.stringify(sysTheme)
  )
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
