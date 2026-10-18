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
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './main.mjs'
import { acquireLock, readLock, releaseLock, updateLock } from './lock.mjs'
import { DEFAULT_PORT, MAX_PORT_TRIES, pathsFor } from './paths.mjs'
import { Win32Bridge } from './win32.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
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

function log(...parts) {
  console.log('[fox-dock] ' + parts.join(' '))
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
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
