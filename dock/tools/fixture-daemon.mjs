#!/usr/bin/env node
// 夹具 daemon：给页面 E2E 与视觉基线提供「时间冻结、随机数固定」的假后端。
//
// 它不启动真 daemon（那会读本机宿主数据），只按 scene JSON 返回固定响应。
// 页面通过 ?port=<port> 指向它，与生产环境的 /v1 契约保持一致。
//
//   node tools/fixture-daemon.mjs --scene test/fixtures/scenes/zcode-normal.json --port 39490
//
// scene 结构：
//   { state, snapshot, snapshots, context, contexts, usage, breakdown, sessions,
//     details, vendors, settings, profiles, roles, bubbles, live, focus, focusNotFound }
// 未提供的字段返回中性空值（不是假 0）。
//
// 测试控制端点（仅夹具）：POST /__fixture/scene {name}、POST /__fixture/emit {event,data}、
// POST /__fixture/clock {now}、GET /__fixture/calls。

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
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
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

function loadScene(file) {
  if (!file) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    console.error('[fixture] 读不到场景文件 ' + file + '：' + (err && err.message ? err.message : err))
    process.exit(1)
  }
}

let scene = loadScene(sceneFile)
const startedAt = Date.now()
const calls = []
const sseClients = new Set()
let fixtureClock = 0

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data == null ? {} : data) + '\n\n'
  for (const res of [...sseClients]) {
    try {
      res.write(payload)
    } catch (err) {
      sseClients.delete(res)
    }
  }
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

function sessionItems() {
  const raw = pick('liveSessions', null) || pick('sessions', null)
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.items)) return raw.items
  // 老夹具按 agent 分数组：拍平成统一 Session 形状，避免 /v1/sessions 空列表。
  if (raw && typeof raw === 'object') {
    const out = []
    for (const [agentId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue
      for (const s of list) {
        const id = String(s.id || s.sessionId || '')
        out.push({
          key: agentId + ':' + id,
          agentId,
          sessionId: id,
          parentKey: null,
          title: s.title || '',
          cwd: s.cwd || '',
          model: s.model || '',
          provider: '',
          status: 'idle',
          statusSource: 'inferred',
          startedAt: Number(s.updatedAt) || 0,
          updatedAt: Number(s.updatedAt) || 0,
          turns: { count: Number(s.requests) || 0, current: null, avgDurationMs: null },
          tokens: { total: Number(s.used) || 0 },
          cost: null,
          tools: { calls: Number(s.requests) || 0, errors: 0, running: [] },
          errors: { model: 0, tool: 0, last: null },
          pending: [],
          provenance: {
            tokens: { kind: 'exact', origin: 'local-db', source: 'fixture#' + agentId, asOf: Date.now() },
            cost: { kind: 'unavailable', origin: 'unknown', source: 'fixture', asOf: Date.now(), reason: 'no-data' },
            status: { kind: 'estimated', origin: 'unknown', source: 'fixture', asOf: Date.now(), note: '夹具' },
            tools: { kind: 'exact', origin: 'local-db', source: 'fixture', asOf: Date.now() },
          },
        })
      }
    }
    return out
  }
  return []
}

function sessionCounts(items) {
  const counts = { working: 0, waiting: 0, waiting_permission: 0, waiting_input: 0, error: 0, done: 0, idle: 0, unknown: 0 }
  const byAgent = {}
  for (const s of items) {
    if (s.status === 'waiting_permission') {
      counts.waiting += 1
      counts.waiting_permission += 1
    } else if (s.status === 'waiting_input') {
      counts.waiting += 1
      counts.waiting_input += 1
    } else if (counts[s.status] != null) counts[s.status] += 1
    else counts.unknown += 1
    const row = byAgent[s.agentId] || (byAgent[s.agentId] = { working: 0, waiting: 0, error: 0, done: 0, total: 0, lastAt: 0 })
    row.total += 1
    row.lastAt = Math.max(row.lastAt, Number(s.updatedAt) || 0)
    if (s.status === 'working') row.working += 1
    else if (s.status === 'waiting_permission' || s.status === 'waiting_input') row.waiting += 1
    else if (s.status === 'error') row.error += 1
    else if (s.status === 'done') row.done += 1
  }
  let aggregate = 'idle'
  if (counts.waiting_permission) aggregate = 'waiting_permission'
  else if (counts.error) aggregate = 'error'
  else if (counts.waiting_input) aggregate = 'waiting_input'
  else if (counts.working) aggregate = 'working'
  else if (counts.done) aggregate = 'done'
  else if (counts.unknown) aggregate = 'unknown'
  return { aggregate, counts, byAgent }
}

function stateBody() {
  const body = {
    ok: true,
    pet: { mode: 'idle', agentId: '', lastAgentId: '', rect: null, display: null },
    agents: [],
    daemon: { version: '2.0.0-fixture', uptime: Math.round((Date.now() - startedAt) / 1000), port },
    ...pick('state', {}),
  }
  if (!body.live) {
    const raw = pick('sessions', null)
    body.live = raw && raw.counts ? { aggregate: raw.aggregate || 'idle', counts: raw.counts, byAgent: raw.byAgent || {} } : sessionCounts(sessionItems())
  }
  return body
}

function readJson(req, limit = 1 << 20) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) return resolve({})
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const p = url.pathname

  if (p === '/health') {
    sendJson(res, 200, { ok: true, app: 'fox-dock', version: '2.0.0-fixture', pid: process.pid, port, bridgeReady: false })
    return
  }

  // ---------- 测试控制端点（仅夹具） ----------
  if (p === '/__fixture/scene' && req.method === 'POST') {
    const body = await readJson(req)
    const name = path.basename(String((body && body.name) || ''))
    const file = path.join(ROOT, 'test', 'fixtures', 'scenes', name + '.json')
    try {
      scene = JSON.parse(fs.readFileSync(file, 'utf8'))
      sendJson(res, 200, { ok: true, scene: name })
    } catch (err) {
      sendJson(res, 404, { ok: false, error: 'scene-not-found' })
    }
    return
  }
  if (p === '/__fixture/emit' && req.method === 'POST') {
    const body = await readJson(req)
    const event = String((body && body.event) || 'session')
    const data = body && body.data
    // 让 SSE 事件同时改变夹具状态，页面重取列表时能看到效果。
    if (event === 'sessions' && data && Array.isArray(data.items)) {
      scene.liveSessions = data.items
    } else if (event === 'session' && data && data.session) {
      const list = sessionItems().slice()
      const idx = list.findIndex((x) => x.key === data.session.key)
      if (data.op === 'remove') {
        if (idx >= 0) list.splice(idx, 1)
      } else if (idx >= 0) list[idx] = { ...list[idx], ...data.session }
      else list.unshift(data.session)
      scene.liveSessions = list
    }
    broadcast(event, data)
    sendJson(res, 200, { ok: true })
    return
  }
  if (p === '/__fixture/clock' && req.method === 'POST') {
    const body = await readJson(req)
    fixtureClock = Number(body && body.now) || Date.now()
    sendJson(res, 200, { ok: true, now: fixtureClock })
    return
  }
  if (p === '/__fixture/calls' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, calls, clock: fixtureClock })
    return
  }

  if (p === '/rect') {
    const hwnd = url.searchParams.get('hwnd') || ''
    const rect = (scene.rects && scene.rects[hwnd]) || scene.defaultRect || { x: 520, y: 180, w: 960, h: 620 }
    sendJson(res, 200, { ok: true, rect })
    return
  }

  if (p === '/hit') {
    sendJson(res, 200, { ok: true, hits: scene.hits || [] })
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

  const statsMatch = p.match(/^\/v1\/agents\/([^/]+)\/stats$/)
  if (statsMatch) {
    const id = decodeURIComponent(statsMatch[1])
    const table = pick('stats', null)
    sendJson(res, 200, {
      ok: true,
      adapterId: id,
      stats:
        (table && table[id]) ||
        table || {
          supported: false,
          range: url.searchParams.get('range') || 'all',
          reason: 'no-data',
          note: '夹具没有统计样本',
        },
    })
    return
  }

  const sessMatch = p.match(/^\/v1\/agents\/([^/]+)\/sessions$/)
  if (sessMatch) {
    const table = pick('sessions', null)
    const id = decodeURIComponent(sessMatch[1])
    sendJson(res, 200, { ok: true, sessions: Array.isArray(table) ? table : (table && table[id]) || [] })
    return
  }

  // ---------- 跨 agent 会话 ----------
  if (p === '/v1/sessions') {
    let items = sessionItems()
    const agent = url.searchParams.get('agent') || ''
    const status = url.searchParams.get('status') || ''
    const q = (url.searchParams.get('q') || '').toLowerCase()
    const sort = url.searchParams.get('sort') || 'updated'
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50) || 50))
    if (agent) items = items.filter((s) => s.agentId === agent)
    if (status) items = items.filter((s) => s.status === status)
    if (q) items = items.filter((s) => ((s.title || '') + ' ' + (s.cwd || '') + ' ' + (s.model || '')).toLowerCase().includes(q))
    items = items.slice().sort((a, b) => {
      if (sort === 'tokens') return (Number(b.tokens && b.tokens.total) || 0) - (Number(a.tokens && a.tokens.total) || 0)
      if (sort === 'cost') return (Number(b.cost && b.cost.amount) || 0) - (Number(a.cost && a.cost.amount) || 0)
      if (sort === 'duration') return (Number(b.updatedAt) - Number(b.startedAt) || 0) - (Number(a.updatedAt) - Number(a.startedAt) || 0)
      return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
    })
    const agg = sessionCounts(items)
    sendJson(res, 200, { ok: true, items: items.slice(0, limit), nextCursor: null, total: items.length, ...agg })
    return
  }

  const sessFocus = p.match(/^\/v1\/sessions\/([^/]+)\/focus$/)
  if (sessFocus && req.method === 'POST') {
    calls.push({ method: 'POST', path: p, body: await readJson(req) })
    if (scene.focusNotFound) {
      sendJson(res, 404, { ok: false, error: 'host-window-not-found' })
      return
    }
    sendJson(res, 200, { ok: true, method: (scene.focus && scene.focus.method) || 'foreground' })
    return
  }

  const sessCtx = p.match(/^\/v1\/sessions\/([^/]+)\/context$/)
  if (sessCtx) {
    const key = decodeURIComponent(sessCtx[1])
    const agentId = key.split(':')[0] || 'zcode'
    sendJson(res, 200, { ok: true, context: contextOf(agentId) })
    return
  }

  const sessOne = p.match(/^\/v1\/sessions\/([^/]+)$/)
  if (sessOne) {
    const key = decodeURIComponent(sessOne[1])
    const item = sessionItems().find((s) => s.key === key) || null
    if (!item) {
      sendJson(res, 404, { ok: false, error: 'session-not-found' })
      return
    }
    const detail = (scene.details && scene.details[key]) || {}
    sendJson(res, 200, { ok: true, session: item, turns: detail.turns || [], tools: detail.tools || [], models: detail.models || [] })
    return
  }

  if (p === '/v1/usage/breakdown') {
    calls.push({ method: 'GET', path: p, query: Object.fromEntries(url.searchParams) })
    const fallback = {
      ok: true,
      supported: true,
      by: url.searchParams.get('by') || 'agent',
      range: { from: '2026-10-15', to: '2026-10-21', days: 7 },
      unit: 'money',
      currency: 'CNY',
      series: [],
      other: null,
      total: { tokens: 0, amount: 0, credits: null, calls: 0, errors: 0, byCurrency: { CNY: 0 } },
      truncated: false,
      prev: url.searchParams.get('compare') === '1' ? { range: { from: '2026-10-08', to: '2026-10-14' }, series: [], other: null, total: { tokens: 0, amount: 0, credits: null, calls: 0, errors: 0, byCurrency: { CNY: 0 } } } : null,
      provenance: {
        tokens: { kind: 'exact', origin: 'local-db', source: 'fixture' },
        amount: { kind: 'estimated', origin: 'pricing-table', source: 'fixture' },
      },
    }
    sendJson(res, 200, pick('breakdown', fallback))
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
      const body = await readJson(req)
      calls.push({ method: 'PUT', path: p, body })
      if (scene.settingsFail) {
        sendJson(res, 500, { ok: false, error: 'settings-write-failed' })
        return
      }
      scene.settings = { ...(scene.settings || {}), ...(body || {}) }
      sendJson(res, 200, { ok: true, settings: scene.settings })
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
      ingest: scene.ingest || { enabled: true, integrationDir: 'E:\\fox-dock\\integrations\\zcode-plugin' },
      live: (scene.sessions && scene.sessions.counts) ? { aggregate: scene.sessions.aggregate || 'idle', counts: scene.sessions.counts, byAgent: scene.sessions.byAgent || {} } : sessionCounts(sessionItems()),
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
    sseClients.add(res)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    })
    res.write(': fixture stream\n\n')
    res.write('event: state\ndata: ' + JSON.stringify(stateBody()) + '\n\n')
    const items = sessionItems()
    if (items.length) {
      const agg = sessionCounts(items)
      res.write('event: sessions\ndata: ' + JSON.stringify({ items, ...agg }) + '\n\n')
    }
    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch (err) {}
    }, 15000)
    beat.unref?.()
    req.on('close', () => {
      sseClients.delete(res)
      clearInterval(beat)
    })
    return
  }

  if (p === '/v1/events' && req.method === 'POST') {
    calls.push({ method: 'POST', path: p, body: await readJson(req) })
    sendJson(res, 200, { ok: true })
    return
  }

  if (p === '/v1/ingest' && req.method === 'POST') {
    const body = await readJson(req)
    calls.push({ method: 'POST', path: p, body })
    sendJson(res, 200, { ok: true, decision: scene.ingestDecision || 'ignored' })
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
