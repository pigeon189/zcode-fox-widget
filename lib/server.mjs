// ZCode 版鲸鱼挂件的本地 HTTP 服务。
//
// 对应上游 DSH 版的 webServer 路由表，但 ZCode 插件没有「往界面注入脚本」的
// 能力，所以改为自带一个独立页面：浏览器打开 http://127.0.0.1:<port>/ 就是
// 同一只鲸鱼挂件。
//
// 安全边界（本地服务容易被任意网页探测）：
//   - 只监听 127.0.0.1，不对外暴露
//   - 校验 Host 头，防 DNS rebinding
//   - 写操作校验 Origin，拒绝跨站伪造
//   - 关闭服务需要 server.json 里的随机令牌
//   - 不返回通配 CORS 头（页面与接口同源，不需要跨域）
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getBalance,
  invalidateBalanceCache,
  readWidgetState,
  writeWidgetState,
} from './balance.mjs'
import { findApiKey, maskKey, readPluginConfig } from './credentials.mjs'
import {
  DEFAULT_PORT,
  GIF_CANDIDATES,
  IMAGE_CANDIDATES,
  SERVER_INFO_FILE,
  SOUND_SETS,
  WIDGET_STATE_FILE,
} from './paths.mjs'
import { readLatestTurn, turnIdentity } from './turn-cost.mjs'
import { readPlanBalance, quotaBucketForModel } from './plan-balance.mjs'
import { listVendorStatus } from './vendors.mjs'
import { usageRecords } from './usage-records.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET_JS = path.join(HERE, 'widget.js')
const VERSION = '1.0.0'
const MAX_BODY = 8192
const TOKEN = crypto.randomBytes(16).toString('hex')

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// 只读一次的资产缓存（图片/音效每次请求读盘、no-store，避免换素材后浏览器
// 仍用旧字节——这点沿用了上游的结论）。
function readFirst(candidates) {
  for (const p of candidates) {
    try {
      const bytes = fs.readFileSync(p)
      if (bytes && bytes.length > 0) return bytes
    } catch (err) {}
  }
  return null
}

// ---------- 每轮消耗：把 turn 变化翻译成前端能识别的递增 seq ----------
let lastTurnPayload = { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }
let currentIdentity = null
let seq = 0

function pollTurnCost() {
  let t
  try {
    t = readLatestTurn()
  } catch (err) {
    return
  }
  const id = turnIdentity(t)
  if (!t || !t.ok || !id) return
  if (currentIdentity === null) {
    // 服务刚起来：对齐当前轮次，不把历史最后一条当成"新的一轮"
    currentIdentity = id
    return
  }
  if (id !== currentIdentity) {
    currentIdentity = id
    seq += 1
    lastTurnPayload = {
      ok: true,
      seq,
      turn: t.turnId,
      amount: t.amount,
      tokens: t.tokens,
      model: t.model,
      peak: t.peak,
      ts: t.ts,
      // 多厂商计价扩展：billable=false 表示该轮供应商无价目（如订阅套餐/网关），
      // 前端应按 tokens/配额口径展示而不是 ¥0.00；models 为逐模型明细
      billable: t.billable !== false,
      providerId: t.providerId,
      vendor: t.vendor,
      vendorLabel: t.vendorLabel,
      breakdown: t.breakdown,
      models: t.models,
      // 套餐（计划扣费）口径：本轮 tokens 占该模型当前配额桶的百分比
      quotaPct: turnQuotaPct(t),
    }
  }
}

// 计划扣费轮次的「占配额百分比」：在该轮模型行里找 GLM 行（轮级 vendor 可能
// 是金额更大的 DeepSeek 行），取消耗最大的 GLM 行除以其当前配额桶总量。
// 读不到配额桶（客户端没刷过日志/模型没对上桶）时返回 null。
function turnQuotaPct(t) {
  if (!Array.isArray(t.models) || !t.models.length) return null
  const plan = readPlanBalance()
  if (!plan || !plan.ok) return null
  const dom = t.models
    .filter((m) => m.vendor === 'glm' && m.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)[0]
  if (!dom) return null
  const bucket = quotaBucketForModel(plan, dom.model)
  if (!bucket) return null
  return Math.round((dom.tokens / bucket.totalUnits) * 10000) / 100
}

// ---------- 请求校验 ----------
function hostAllowed(req, port) {
  const host = String(req.headers.host || '')
  const allowed = ['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]
  return allowed.indexOf(host) !== -1
}

function originAllowed(req, port) {
  const origin = req.headers.origin
  if (!origin) return true // 非浏览器请求（curl 等）没有 Origin
  const allowed = ['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://[::1]:' + port]
  return allowed.indexOf(String(origin)) !== -1
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > MAX_BODY) {
        settled = true
        // 丢弃剩余数据但保持连接可写，让调用方能收到明确的 400，
        // 而不是被 destroy 后只看到连接中断。
        req.resume()
        reject(new Error('body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (err) {
    body = JSON.stringify({ ok: false, error: '序列化失败' })
  }
  res.writeHead(status, JSON_HEADERS)
  res.end(body)
}

function sendBytes(res, contentType, bytes) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': String(bytes.length),
  })
  res.end(bytes)
}

// ---------- 独立页面 ----------
// 背景默认透明：这样用支持透明窗口的浏览器/OBS/桌面挂件容器打开时，鲸鱼是
// 直接浮在桌面上的；普通浏览器里就是白底 + 右下角鲸鱼。
function pageHtml(port, dark) {
  const bg = dark ? '#12161f' : 'transparent'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek 余额小鲸鱼 · ZCode</title>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:${bg}}
</style>
</head>
<body>
<script defer src="/whale/widget.js"></script>
</body>
</html>
`
}

// ---------- 路由 ----------
function createRequestHandler(port) {
  return async function handle(req, res) {
    if (!hostAllowed(req, port)) {
      sendJson(res, 403, { ok: false, error: 'host not allowed' })
      return
    }
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1:' + port)
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'bad request' })
      return
    }
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()
    const isWrite = method === 'PUT' || method === 'POST' || method === 'DELETE'
    if (isWrite && !originAllowed(req, port)) {
      sendJson(res, 403, { ok: false, error: 'origin not allowed' })
      return
    }

    // 页面
    if (pathname === '/' || pathname === '/index.html') {
      const html = pageHtml(port, url.searchParams.get('bg') === 'dark')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(html)
      return
    }

    // 前端脚本
    if (pathname === '/whale/widget.js') {
      try {
        const js = fs.readFileSync(WIDGET_JS)
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(js.length),
        })
        res.end(js)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('widget.js unavailable')
      }
      return
    }

    // 鲸鱼形象
    if (pathname === '/whale/image.png') {
      const bytes = readFirst(IMAGE_CANDIDATES)
      if (!bytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('whale image unavailable')
        return
      }
      sendBytes(res, 'image/png', bytes)
      return
    }

    // 随机台词用的动图
    if (pathname === '/whale/rua.gif') {
      const bytes = readFirst(GIF_CANDIDATES)
      if (!bytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('rua gif unavailable')
        return
      }
      sendBytes(res, 'image/gif', bytes)
      return
    }

    // 音效：?set=duck|fx1
    if (pathname === '/whale/sound/press.mp3' || pathname === '/whale/sound/release.mp3') {
      const setName = url.searchParams.get('set')
      const set = SOUND_SETS[setName] || SOUND_SETS.duck
      const bytes = readFirst(pathname.endsWith('press.mp3') ? set.press : set.release)
      if (!bytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('sound unavailable')
        return
      }
      sendBytes(res, 'audio/mpeg', bytes)
      return
    }

    // 余额：任何情况下都回 200 + JSON，绝不悬挂
    if (pathname === '/whale/balance.json') {
      try {
        sendJson(res, 200, await getBalance())
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          code: 'ERROR',
          error: String((err && err.message) || err).slice(0, 200),
        })
      }
      return
    }

    // ZCode Plan（套餐）剩余配额：零密钥，来自客户端日志的最近一次余额观测
    if (pathname === '/whale/plan.json') {
      try {
        sendJson(res, 200, readPlanBalance())
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 厂商模板状态：余额/配额/可用性（?refresh=1 强制绕过缓存取数）
    if (pathname === '/whale/vendors.json') {
      try {
        const force = url.searchParams.get('refresh') === '1'
        sendJson(res, 200, await listVendorStatus(force))
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 用量记录：今日 / 近 7 天 / 最近事件（直读 model_usage）
    if (pathname === '/whale/usage-records.json') {
      try {
        sendJson(res, 200, usageRecords())
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 最近一轮消耗
    if (pathname === '/whale/last-turn.json') {
      sendJson(res, 200, lastTurnPayload)
      return
    }

    // 挂件配置：GET 读、PUT/POST 写
    if (pathname === '/whale/size.json') {
      if (isWrite) {
        try {
          const parsed = JSON.parse(await readBody(req))
          if (typeof parsed.scale !== 'number') {
            sendJson(res, 400, { ok: false, error: 'missing scale' })
            return
          }
          const before = readWidgetState()
          const result = writeWidgetState(parsed)
          // 用量模式变化时让余额缓存失效，下次请求立即按新模式计算
          if (parsed.usageMode && parsed.usageMode !== before.usageMode) invalidateBalanceCache()
          sendJson(res, result.persistError ? 500 : 200, result)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
        return
      }
      sendJson(res, 200, readWidgetState())
      return
    }

    // 健康检查：给命令、MCP、hook 用来判断服务是否已在跑
    if (pathname === '/whale/health') {
      const cfg = readPluginConfig()
      const found = findApiKey()
      sendJson(res, 200, {
        ok: true,
        app: 'zcode-whale-widget',
        version: VERSION,
        pid: process.pid,
        port,
        usageMode: readWidgetState().usageMode,
        keySource: found.source,
        keyMasked: maskKey(found.key),
        stateFile: WIDGET_STATE_FILE,
        portPinned: cfg.port,
      })
      return
    }

    // 关闭服务（需要 server.json 里的令牌，防止别的本地程序随手关掉）
    if (pathname === '/whale/shutdown' && isWrite) {
      if (String(req.headers['x-whale-token'] || '') !== TOKEN) {
        sendJson(res, 403, { ok: false, error: 'bad token' })
        return
      }
      sendJson(res, 200, { ok: true, stopping: true })
      setTimeout(() => stop(0), 50)
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }
}

// ---------- 生命周期 ----------
let server = null
let turnTimer = null
let boundPort = null

function writeServerInfo(port) {
  try {
    fs.mkdirSync(path.dirname(SERVER_INFO_FILE), { recursive: true })
    fs.writeFileSync(
      SERVER_INFO_FILE,
      JSON.stringify(
        {
          pid: process.pid,
          port,
          url: 'http://127.0.0.1:' + port + '/',
          token: TOKEN,
          version: VERSION,
          startedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    )
  } catch (err) {}
}

function clearServerInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(SERVER_INFO_FILE, 'utf8'))
    // 只清理自己写下的记录，避免误删新进程的信息
    if (info && info.pid === process.pid) fs.unlinkSync(SERVER_INFO_FILE)
  } catch (err) {}
}

function stop(code) {
  try {
    if (turnTimer) clearInterval(turnTimer)
  } catch (err) {}
  clearServerInfo()
  try {
    if (server) server.close()
  } catch (err) {}
  // 给 in-flight 响应一点时间落地
  setTimeout(() => process.exit(code), 60)
}

// 端口占用时向后顺延，避免和其它本地服务抢端口
function listen(port, attemptsLeft) {
  server = http.createServer(createRequestHandler(port))
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      try {
        server.close()
      } catch (e) {}
      listen(port + 1, attemptsLeft - 1)
      return
    }
    console.error('[zcode-whale] 无法启动挂件服务:', String((err && err.message) || err))
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    boundPort = port
    writeServerInfo(port)
    pollTurnCost()
    turnTimer = setInterval(pollTurnCost, 1000)
    console.log('🐳 DeepSeek 余额小鲸鱼已就绪: http://127.0.0.1:' + port + '/')
    console.log('   数据目录: ' + path.dirname(WIDGET_STATE_FILE))
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

const configPort = readPluginConfig().port
listen(configPort || DEFAULT_PORT, 20)

export { boundPort, stop }
