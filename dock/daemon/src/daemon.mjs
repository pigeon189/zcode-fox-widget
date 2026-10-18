#!/usr/bin/env node
// fox-dock 常驻服务（R2）。
//
// 职责：
//   · 单实例（lock 文件 + pid 存活判定）
//   · 拉起并持有 Win32 桥
//   · 本地 HTTP（仅 127.0.0.1）：/health /windows /hit /cursor /shutdown
//   · 心跳文件（供 watchdog 与诊断读取）
//
// 退出码约定：0 = 正常停止（watchdog 不再拉起）；2 = 已有实例在跑；其它 = 异常。

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './main.mjs'
import { acquireLock, releaseLock, updateLock } from './lock.mjs'
import { readBindings, removeBinding, upsertBinding } from './bindings.mjs'
import { createBillingService } from './billing.mjs'
import { readHostVendors } from './host-vendors.mjs'
import { compareVersions, fetchManifest } from './update.mjs'
import { recordSnapshot, summarize } from './ledger.mjs'
import { readSettings, writeSettings } from './settings.mjs'
import { buildBindKey } from '../../shared/identity.mjs'
import { builtinAdapters, describeAdapters, resolveAdapter } from '../../adapters/registry.mjs'
import { DEFAULT_PORT, MAX_PORT_TRIES, pathsFor } from './paths.mjs'
import { Win32Bridge } from './win32.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPDATE_PUBKEY = path.join(HERE, '..', '..', 'keys', 'update-pub.pem')
let updateCheckCache = null

function isEntry() {
  try {
    const entry = process.argv[1]
    return entry && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  } catch (err) {
    return false
  }
}

export function parseArgs(argv) {
  const out = { dataDir: '', port: DEFAULT_PORT, bridge: true, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data-dir') out.dataDir = argv[++i] || ''
    else if (a.startsWith('--data-dir=')) out.dataDir = a.slice('--data-dir='.length)
    else if (a === '--port') out.port = Number(argv[++i])
    else if (a.startsWith('--port=')) out.port = Number(a.slice('--port='.length))
    else if (a === '--no-bridge') out.bridge = false
    else if (a === '--verbose' || a === '-v') out.verbose = true
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) out.port = DEFAULT_PORT
  return out
}

// 内存里留最近 200 行日志：/diag.json 要能带出去，而常驻进程的 stdout 常常没人接
const LOG_RING = []
function log(...parts) {
  const line = '[fox-dock] ' + parts.join(' ')
  LOG_RING.push(new Date().toISOString().slice(11, 19) + ' ' + parts.join(' '))
  if (LOG_RING.length > 200) LOG_RING.shift()
  console.log(line)
}

function redactHome(text) {
  try {
    const home = os.homedir()
    return home ? String(text).split(home).join('~') : String(text)
  } catch (err) {
    return String(text)
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  if (ba.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(ba, bb)
  } catch (err) {
    return false
  }
}

async function probeHealth(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1200) })
    const data = await res.json()
    return data && data.app === 'fox-dock' ? data : null
  } catch (err) {
    return null
  }
}

function listenOn(server, port, tries) {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const tryPort = (p) => {
      const onError = (err) => {
        server.removeListener('listening', onListening)
        if (err && err.code === 'EADDRINUSE' && attempt < tries - 1) {
          attempt++
          tryPort(p + 1)
          return
        }
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve(server.address().port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(p, '127.0.0.1')
    }
    tryPort(port)
  })
}

export async function runDaemon(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  const paths = pathsFor(opts.dataDir)
  fs.mkdirSync(paths.dir, { recursive: true })
  fs.mkdirSync(paths.logs, { recursive: true })

  const token = crypto.randomBytes(16).toString('hex')
  const startedAt = Date.now()
  const info = { pid: process.pid, startMs: startedAt, version: VERSION, token, port: null }

  const lock = acquireLock(paths.lock, info)
  if (!lock.ok) {
    log('already running pid=' + lock.holder.pid + ' port=' + (lock.holder.port || '?'))
    return 2
  }

  const bridge = opts.bridge ? new Win32Bridge() : null
  let bridgeReady = false
  if (bridge) {
    try {
      await bridge.start()
      bridgeReady = true
    } catch (err) {
      log('bridge failed: ' + (err && err.message ? err.message : err))
    }
  }

  // 适配器：内置 + 声明式匹配；计费快照带 3 秒缓存
  const adapters = builtinAdapters
  const billing = createBillingService({ adapters })

  // 更新状态文件由 CLI 写、daemon 只读；读不到就给空历史，不要把诊断接口弄挂
  function readUpdateStateSafe() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(paths.dir, 'update-state.json'), 'utf8'))
      return { latest: raw.latest || null, appliedVersion: raw.appliedVersion || null, history: Array.isArray(raw.history) ? raw.history.slice(-5) : [] }
    } catch (err) {
      return { latest: null, appliedVersion: null, history: [] }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const p = url.pathname

    if (p === '/health') {
      sendJson(res, 200, {
        ok: true,
        app: 'fox-dock',
        version: VERSION,
        pid: process.pid,
        port: server.address() ? server.address().port : null,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        bridgeReady,
      })
      return
    }

    if (p === '/windows' || p === '/hit' || p === '/cursor') {
      if (!bridge || !bridgeReady) {
        sendJson(res, 503, { ok: false, error: 'bridge-unavailable' })
        return
      }
      try {
        if (p === '/windows') {
          sendJson(res, 200, { ok: true, windows: await bridge.snapshot() })
        } else if (p === '/cursor') {
          const c = await bridge.cursor()
          sendJson(res, 200, { ok: true, ...c })
        } else {
          const x = Number(url.searchParams.get('x'))
          const y = Number(url.searchParams.get('y'))
          const exclude = Number(url.searchParams.get('exclude') || 0)
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            sendJson(res, 400, { ok: false, error: 'bad-point' })
            return
          }
          sendJson(res, 200, { ok: true, hits: await bridge.hit(x, y, exclude) })
        }
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }

    if (p === '/adapters' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, adapters: describeAdapters(adapters) })
      return
    }

    // 全厂商余额/套餐：复用同机挂件线的 /whale/vendors.json。
    // adapter=zcode|workbuddy；不带时返回可用服务列表与默认数据源。
    if (p === '/vendors' && req.method === 'GET') {
      try {
        const adapter = url.searchParams.get('adapter') || ''
        const force = url.searchParams.get('force') === '1'
        const data = await readHostVendors(adapter, { force })
        sendJson(res, 200, data)
      } catch (err) {
        sendJson(res, 500, { ok: false, reason: 'exception', error: String((err && err.message) || err) })
      }
      return
    }

    // 检查更新：只做「读签名清单 + 比较版本」，落盘仍走 CLI 的 update --apply。
    if (p === '/update/check' && req.method === 'GET') {
      const settings = readSettings(paths.settings)
      const manifestUrl = String(process.env.FOX_DOCK_MANIFEST || settings.updateManifestUrl || '').trim()
      if (!manifestUrl) {
        sendJson(res, 200, {
          ok: false,
          reason: 'manifest-not-configured',
          current: VERSION,
          error: '未配置更新清单地址。发布 dock-v* 后，在设置里填入签名清单 URL。',
        })
        return
      }
      const force = url.searchParams.get('force') === '1'
      const cacheKey = manifestUrl + '|' + VERSION
      if (!force && updateCheckCache && updateCheckCache.key === cacheKey && Date.now() - updateCheckCache.at < 5 * 60_000) {
        sendJson(res, 200, { ...updateCheckCache.value, cached: true })
        return
      }
      try {
        const publicKeyPem = fs.existsSync(UPDATE_PUBKEY) ? fs.readFileSync(UPDATE_PUBKEY, 'utf8') : ''
        const manifest = await fetchManifest(manifestUrl, { publicKeyPem, requireSignature: true, timeoutMs: 8000 })
        const value = {
          ok: true,
          current: VERSION,
          latest: manifest.version,
          hasUpdate: compareVersions(manifest.version, VERSION) > 0,
          notes: manifest.notes || '',
          checkedAt: Date.now(),
        }
        updateCheckCache = { key: cacheKey, at: Date.now(), value }
        sendJson(res, 200, value)
      } catch (err) {
        const value = {
          ok: false,
          reason: 'check-failed',
          current: VERSION,
          error: String((err && err.message) || err).slice(0, 300),
        }
        updateCheckCache = { key: cacheKey, at: Date.now(), value }
        sendJson(res, 200, value)
      }
      return
    }

    // 2.0：列出当前桌面上「认得出」的 agent 窗口，供浮层做首次提示/一键吸附。
    // 只返回命中内置适配器的窗口；未知窗口仍可拖拽绑定（generic）。
    if (p === '/agents' && req.method === 'GET') {
      if (!bridge || !bridgeReady) {
        sendJson(res, 503, { ok: false, error: 'bridge-unavailable' })
        return
      }
      try {
        const windows = await bridge.snapshot()
        const agents = []
        for (const w of windows || []) {
          const det = resolveAdapter(w, adapters)
          if (det.fallback) continue
          agents.push({
            hwnd: w.hwnd,
            pid: w.pid,
            startMs: w.startMs,
            exe: w.exe,
            title: w.title,
            cls: w.cls,
            rect: w.rect,
            adapter: {
              id: det.id,
              name: det.name,
              roleDefault: det.adapter.roleDefault || '',
              accent: det.adapter.accent || '',
            },
          })
        }
        sendJson(res, 200, { ok: true, agents })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }

    if (p === '/resolve' && req.method === 'GET') {
      const det = resolveAdapter(
        {
          exe: url.searchParams.get('exe') || '',
          title: url.searchParams.get('title') || '',
          cls: url.searchParams.get('cls') || '',
          pid: Number(url.searchParams.get('pid') || 0),
        },
        adapters
      )
      sendJson(res, 200, {
        ok: true,
        adapter: {
          id: det.id,
          name: det.name,
          fallback: det.fallback,
          score: det.score,
          capabilities: det.capabilities,
          roleDefault: det.adapter.roleDefault || '',
          accent: det.adapter.accent || '',
        },
      })
      return
    }

    if (p === '/billing' && req.method === 'GET') {
      const key = url.searchParams.get('key') || ''
      const binding = key ? readBindings(paths.bindings).find((b) => b.key === key) : null
      if (!binding) {
        sendJson(res, 404, { ok: false, error: 'binding-not-found' })
        return
      }
      const snap = await billing.snapshot(binding.window, {
        force: url.searchParams.get('force') === '1',
      })
      // 记账：只记成功且可计价的快照（失败/不支持不写假 0）
      recordSnapshot(paths.ledger, {
        adapterId: snap.adapterId,
        adapterName: snap.adapterName,
        snapshot: snap,
        now: Date.now(),
      })
      sendJson(res, 200, { ok: true, bindingKey: binding.key, snapshot: snap })
      return
    }

    if (p === '/diag.json' && req.method === 'GET') {
      // 给人贴给维护者用的诊断包：不含密钥（dock 根本不存密钥），路径里的用户名脱敏
      const binds = readBindings(paths.bindings)
      sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        app: 'fox-dock',
        version: VERSION,
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
          port: server.address() ? server.address().port : null,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        },
        paths: { dataDir: redactHome(paths.dir), ledger: redactHome(paths.ledger) },
        bridgeReady,
        adapters: describeAdapters(adapters),
        bindings: binds.slice(0, 20).map((b) => ({
          adapterId: b.adapterId,
          title: b.window ? b.window.title : '',
          exe: redactHome(b.window ? b.window.exe : ''),
          pid: b.window ? b.window.pid : 0,
          at: b.at,
        })),
        bindingCount: binds.length,
        settings: readSettings(paths.settings),
        summary: summarize(paths.ledger, { now: Date.now(), days: 7 }),
        update: readUpdateStateSafe(),
        logs: LOG_RING.slice(-60).map((l) => redactHome(l).slice(0, 300)),
      })
      return
    }

    if (p === '/summary' && req.method === 'GET') {
      const days = Number(url.searchParams.get('days') || 7)
      sendJson(res, 200, {
        ok: true,
        ...summarize(paths.ledger, { now: Date.now(), days: Number.isFinite(days) ? days : 7 }),
      })
      return
    }

    if (p === '/settings' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, settings: readSettings(paths.settings) })
      return
    }

    if (p === '/settings' && req.method === 'PUT') {
      try {
        const patch = await readBody(req)
        const settings = writeSettings(paths.settings, patch)
        sendJson(res, 200, { ok: true, settings })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }

    if (p === '/bindings' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, bindings: readBindings(paths.bindings) })
      return
    }

    if (p === '/bind' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        const key = buildBindKey({
          exe: body.exe,
          pid: body.pid,
          startMs: body.startMs,
          hwnd: body.hwnd,
        })
        // 适配器由**服务端**判定：客户端传的 adapterId 只作为提示记录，
        // 避免前端被改坏或被第三方页面误导而写错计费口径。
        const det = resolveAdapter({ exe: body.exe, title: body.title, cls: body.cls }, adapters)
        const saved = upsertBinding(paths.bindings, {
          key,
          adapterId: det.id,
          adapterHint: typeof body.adapterId === 'string' ? body.adapterId.slice(0, 40) : '',
          anchor: body.anchor,
          window: {
            title: String(body.title || '').slice(0, 200),
            exe: String(body.exe || '').slice(0, 400),
            pid: Number(body.pid),
            startMs: Number(body.startMs),
            hwnd: String(body.hwnd || ''),
            cls: String(body.cls || '').slice(0, 120),
            rect: body.rect || null,
          },
        })
        sendJson(res, 200, {
          ok: true,
          binding: saved,
          adapter: {
            id: det.id,
            name: det.name,
            fallback: det.fallback,
            capabilities: det.capabilities,
            roleDefault: det.adapter.roleDefault || '',
            accent: det.adapter.accent || '',
          },
        })
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }

    if (p === '/bind' && req.method === 'DELETE') {
      const key = url.searchParams.get('key') || ''
      const r = removeBinding(paths.bindings, key)
      sendJson(res, 200, { ok: true, removed: r.removed, bindings: r.bindings })
      return
    }

    if (p === '/rect' && req.method === 'GET') {
      if (!bridge || !bridgeReady) {
        sendJson(res, 503, { ok: false, error: 'bridge-unavailable' })
        return
      }
      try {
        const hwnd = url.searchParams.get('hwnd') || ''
        const r = await bridge.rect(hwnd)
        // 桥会区分「窗口最小化 / 已离屏」与「读失败」：前者前端要原地等，后者才解绑
        if (r && r.ok && r.rect) sendJson(res, 200, { ok: true, rect: r.rect })
        else sendJson(res, 200, { ok: false, reason: (r && (r.reason || r.error)) || 'rect-unavailable' })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }

    if (p === '/shutdown' && req.method === 'POST') {
      if (!timingSafeEqual(req.headers['x-fox-token'], token)) {
        sendJson(res, 403, { ok: false, error: 'bad-token' })
        return
      }
      sendJson(res, 200, { ok: true, stopping: true })
      setTimeout(() => shutdown(0), 50)
      return
    }

    sendJson(res, 404, { ok: false, error: 'not-found' })
  })

  let actualPort
  try {
    actualPort = await listenOn(server, opts.port, MAX_PORT_TRIES)
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      const other = await probeHealth(opts.port)
      if (other) {
        log('another instance answers on ' + opts.port + ', exiting')
        releaseLock(paths.lock, process.pid)
        if (bridge) bridge.stop()
        return 2
      }
    }
    releaseLock(paths.lock, process.pid)
    if (bridge) bridge.stop()
    throw err
  }
  updateLock(paths.lock, { port: actualPort })
  log('listening on 127.0.0.1:' + actualPort + ' pid=' + process.pid + ' version=' + VERSION)

  const beat = setInterval(() => {
    try {
      fs.writeFileSync(
        paths.heartbeat,
        JSON.stringify({
          pid: process.pid,
          port: actualPort,
          at: Date.now(),
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          bridgeReady,
        })
      )
    } catch (err) {}
  }, 1000)
  beat.unref && beat.unref()

  let shuttingDown = false
  function shutdown(code) {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(beat)
    try {
      fs.unlinkSync(paths.heartbeat)
    } catch (err) {}
    try {
      server.close()
    } catch (err) {}
    try {
      if (bridge) bridge.stop()
    } catch (err) {}
    releaseLock(paths.lock, process.pid)
    setTimeout(() => process.exit(code), 30)
  }

  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))
  process.on('exit', () => {
    releaseLock(paths.lock, process.pid)
  })

  // 被 require/import 时不阻塞：调用方自行持有进程
  return new Promise(() => {})
}

if (isEntry()) {
  if (process.argv.includes('--version')) {
    console.log(VERSION)
    process.exit(0)
  }
  runDaemon().then(
    (code) => {
      if (typeof code === 'number') process.exit(code)
    },
    (err) => {
      console.error('[fox-dock] fatal: ' + (err && err.stack ? err.stack : err))
      process.exit(1)
    }
  )
}
