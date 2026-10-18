#!/usr/bin/env node
// watchdog：登录启动的就是它。它拉起 daemon，并在 daemon 异常退出时重启。
// 约定：daemon 退出码 0 = 用户主动停止（不再拉起）；其它（含被 kill）= 重启。
//
// 单独一个锁：避免登录时被启动两次（启动文件夹 + 手动双击）。

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLock, releaseLock } from './lock.mjs'
import { pathsFor } from './paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(HERE, 'daemon.mjs')

export function parseWatchdogArgs(argv) {
  const out = { dataDir: '', port: '', bridge: true, restartDelay: 1000, maxDelay: 30000, once: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data-dir') out.dataDir = argv[++i] || ''
    else if (a.startsWith('--data-dir=')) out.dataDir = a.slice('--data-dir='.length)
    else if (a === '--port') out.port = argv[++i] || ''
    else if (a.startsWith('--port=')) out.port = a.slice('--port='.length)
    else if (a === '--no-bridge') out.bridge = false
    else if (a === '--restart-delay') out.restartDelay = Number(argv[++i]) || out.restartDelay
    else if (a === '--max-delay') out.maxDelay = Number(argv[++i]) || out.maxDelay
    else if (a === '--once') out.once = true
  }
  return out
}

export function daemonArgsFor(opts) {
  const args = [DAEMON]
  if (opts.dataDir) args.push('--data-dir', opts.dataDir)
  if (opts.port) args.push('--port', String(opts.port))
  if (opts.bridge === false) args.push('--no-bridge')
  return args
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function runWatchdog(argv = process.argv.slice(2)) {
  const opts = parseWatchdogArgs(argv)
  const paths = pathsFor(opts.dataDir)
  const lock = acquireLock(paths.watchdogLock, { pid: process.pid, startMs: Date.now(), role: 'watchdog' })
  if (!lock.ok) {
    console.log('[fox-dock] watchdog already running pid=' + lock.holder.pid)
    return 2
  }

  let stopping = false
  let child = null
  const stop = () => {
    stopping = true
    try {
      if (child) child.kill()
    } catch (err) {}
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  let delay = opts.restartDelay
  try {
    while (!stopping) {
      const startedAt = Date.now()
      child = spawn(process.execPath, daemonArgsFor(opts), { stdio: 'inherit', windowsHide: true })
      const code = await new Promise((resolve) => child.once('exit', (c, sig) => resolve(sig ? null : c)))
      if (stopping) break
      if (code === 0) {
        console.log('[fox-dock] daemon stopped cleanly, watchdog exits')
        break
      }
      if (opts.once) {
        console.log('[fox-dock] daemon exited code=' + code + ' (--once, no restart)')
        return code == null ? 1 : code
      }
      if (Date.now() - startedAt > 60000) delay = opts.restartDelay
      console.log('[fox-dock] daemon exited code=' + code + ', restart in ' + delay + 'ms')
      await sleep(delay)
      delay = Math.min(Math.round(delay * 1.5), opts.maxDelay)
    }
  } finally {
    releaseLock(paths.watchdogLock, process.pid)
    if (child && !child.killed && stopping) {
      try {
        child.kill()
      } catch (err) {}
    }
  }
  return 0
}

function isEntry() {
  try {
    const entry = process.argv[1]
    return entry && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  } catch (err) {
    return false
  }
}

if (isEntry()) {
  runWatchdog().then(
    (code) => process.exit(code),
    (err) => {
      console.error('[fox-dock] watchdog fatal: ' + (err && err.stack ? err.stack : err))
      process.exit(1)
    }
  )
}
