#!/usr/bin/env node
// 夹具 daemon：给页面 E2E 与视觉基线提供「时间冻结、随机数固定」的假后端。
//
// 它不启动真 daemon（那会读本机宿主数据），只按 scene JSON 返回固定响应。
// 页面通过 ?port=<port> 指向它，与生产环境的 /v1 契约保持一致。
//
//   node tools/fixture-daemon.mjs --scene test/fixtures/scenes/zcode-normal.json --port 39490
//
// scene 结构：
//   { state, snapshot, context, usage, vendors, settings, profiles, roles, bubbles }
// 未提供的字段返回中性空值（不是假 0）。

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const sceneArg = arg('--scene', '')
const sceneFile = sceneArg ? path.resolve(ROOT, sceneArg) : ''
const port = Number(arg('--port', '39490'))

function loadScene() {
  if (!sceneFile) return {}
  try {
    return JSON.parse(fs.readFileSync(sceneFile, 'utf8'))
  } catch (err) {
    console.error('[fixture] 读不到场景文件 ' + sceneFile + '：' + (err && err.message ? err.message : err))
    process.exit(1)
  }
}

const scene = loadScene()
const startedAt = Date.now()

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

function pick(name, fallback) {
  if (scene[name] !== undefined) return scene[name]
  return typeof fallback === 'function' ? fallback() : fallback
}

function contextOf(id) {
  const table = scene.contexts
  if (table && table[id]) return table[id]
  return pick('context', { supported: false, confidence: 'unavailable', reason: 'no-session', points: [] })
}

function serveStatic(req, res, p) {
  const clean = path.normalize(p).replace(/^(\.\.[/\\])+/, '')
  const file = path.join(ROOT, clean)
  if (!file.startsWith(ROOT)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return true
  }
  let stat
  try {
    stat = fs.statSync(file)
  } catch (err) {
    return false
  }
  if (!stat.isFile()) return false
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  fs.createReadStream(file).pipe(res)
  return true
}

function stateBody() {
  return {
    ok: true,
    pet: { mode: 'idle', agentId: '', lastAgentId: '', rect: null, display: null },
    agents: [],
    daemon: { version: '2.0.0-fixture', uptime: Math.round((Date.now() - startedAt) / 1000), port },
    ...pick('state', {}),
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const p = url.pathname

  if (p === '/health') {
    sendJson(res, 200, { ok: true, app: 'fox-dock', version: '2.0.0-fixture', pid: process.pid, port, bridgeReady: false })
    return
  }

  if (p === '/v1/state') {
    sendJson(res, 200, stateBody())
    return
  }

  if (p === '/v1/agents' || p === '/agents') {
    sendJson(res, 200, { ok: true, agents: pick('agents', []) })
    return
  }

  const snapMatch = p.match(/^\/v1\/agents\/([^/]+)\/snapshot$/)
  if (snapMatch) {
    const id = decodeURIComponent(snapMatch[1])
    const snaps = pick('snapshots', null)
    sendJson(res, 200, { ok: true, adapterId: id, snapshot: snaps ? snaps[id] || null : pick('snapshot', null), context: contextOf(id) })
    return
  }

  const ctxMatch = p.match(/^\/v1\/agents\/([^/]+)\/context$/)
  if (ctxMatch) {
    sendJson(res, 200, { ok: true, context: contextOf(decodeURIComponent(ctxMatch[1])) })
    return
  }

  const sessMatch = p.match(/^\/v1\/agents\/([^/]+)\/sessions$/)
  if (sessMatch) {
    const table = pick('sessions', null)
    const id = decodeURIComponent(sessMatch[1])
    sendJson(res, 200, { ok: true, sessions: Array.isArray(table) ? table : (table && table[id]) || [] })
    return
  }

  if (p === '/v1/usage' || p === '/summary') {
    sendJson(res, 200, { ok: true, ...pick('usage', { groups: [], models: [], modelsByTokens: [], rankTotal: null, total: [] }) })
    return
  }

  if (p === '/v1/vendors' || p === '/vendors') {
    sendJson(res, 200, { ok: true, vendors: pick('vendors', []) })
    return
  }

  if (p === '/v1/settings' || p === '/settings') {
    if (req.method === 'PUT') {
      sendJson(res, 200, { ok: true, settings: pick('settings', {}) })
      return
    }
    sendJson(res, 200, { ok: true, settings: pick('settings', {}) })
    return
  }

  const profMatch = p.match(/^\/v1\/profiles\/([^/]+)$/)
  if (profMatch) {
    sendJson(res, 200, { ok: true, profile: pick('profiles', {})[decodeURIComponent(profMatch[1])] || null })
    return
  }

  if (p === '/v1/diag/bundle') {
    sendJson(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      app: 'fox-dock',
      version: '2.0.0-fixture',
      runtime: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid, port, uptimeSec: Math.round((Date.now() - startedAt) / 1000) },
      paths: { dataDir: '%LOCALAPPDATA%\\fox-dock' },
      adapters: scene.adapters || [],
      bindings: scene.bindings || [],
      update: scene.update || { history: [] },
      ...pick('diag', {}),
    })
    return
  }

  if (p === '/update/check') {
    sendJson(res, 200, { ok: false, reason: 'manifest-not-configured', current: '2.0.0-fixture', error: '未配置更新清单地址。' })
    return
  }

  if (p === '/v1/roles') {
    sendJson(res, 200, { ok: true, roles: pick('roles', []) })
    return
  }

  if (p === '/v1/bubbles/templates') {
    sendJson(res, 200, { ok: true, templates: pick('bubbles', []) })
    return
  }

  if (p === '/v1/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    res.write(': fixture stream\n\n')
    // 推送一帧 state，页面首屏之后有变化也能验证 SSE 路径。
    res.write('event: state\ndata: ' + JSON.stringify(stateBody()) + '\n\n')
    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch (err) {}
    }, 15000)
    beat.unref?.()
    req.on('close', () => clearInterval(beat))
    return
  }

  if (p === '/v1/events' && req.method === 'POST') {
    sendJson(res, 200, { ok: true })
    return
  }

  if (p === '/shutdown' && req.method === 'POST') {
    sendJson(res, 200, { ok: true, stopping: true })
    setTimeout(() => process.exit(0), 20)
    return
  }

  // 静态文件：只用于视觉/E2E 测试（/ui、/overlay 等），不参与生产路径
  if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, p)) return

  sendJson(res, 404, { ok: false, error: 'not-found', path: p })
})

server.listen(port, '127.0.0.1', () => {
  console.log('[fixture] listening on http://127.0.0.1:' + port + (sceneFile ? ' scene=' + path.basename(sceneFile) : ' scene=(empty)'))
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
