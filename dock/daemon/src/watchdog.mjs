#!/usr/bin/env node
// watchdog：登录启动的就是它。它拉起 daemon，并在 daemon 异常退出时重启。
// 约定：daemon 退出码 0 = 用户主动停止（不再拉起）；其它（含被 kill）= 重启。
//
// 单独一个锁：避免登录时被启动两次（启动文件夹 + 手动双击）。

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireLock, readLock, releaseLock } from './lock.mjs'
import { pathsFor } from './paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(HERE, 'daemon.mjs')

// 健康探活：daemon 进程还活着但事件循环卡死时，/health 会超时。watchdog 是
// 独立进程，能在这种情况下杀掉并重启它，避免浮层探活失败后退出、桌宠消失。
const HEALTH_POLL_MS = 5000
const HEALTH_TIMEOUT_MS = 2000
const HEALTH_FAIL_MS = 60_000
const STARTUP_GRACE_MS = 15_000

// 探活判定（纯函数，时钟由调用方注入，便于单测）：
//   · shouldProbeHealth：启动宽限内 / lock 未就绪（pid 不匹配或无端口）时不探活；
//   · trackUnhealthy：探活成功清零；失败记录连续失败起点，累计达 failMs 才杀
//     （杀后由调用方重置 unhealthySince，避免下一轮立即再杀）。
export function shouldProbeHealth({ now, startedAt, childPid, lock, graceMs = STARTUP_GRACE_MS }) {
  if (now - startedAt < graceMs) return false
  if (!lock || Number(lock.pid) !== Number(childPid) || !lock.port) return false
  return true
}

export function trackUnhealthy({ now, unhealthySince = 0, probeOk, failMs = HEALTH_FAIL_MS }) {
  if (probeOk) return { unhealthySince: 0, kill: false }
  const since = unhealthySince || now
  return { unhealthySince: since, kill: now - since >= failMs }
}

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
      let unhealthySince = 0
      let checking = false
      const monitor = setInterval(async () => {
        if (checking || !child || child.exitCode !== null) return
        const lock = readLock(paths.lock)
        if (!shouldProbeHealth({ now: Date.now(), startedAt, childPid: child.pid, lock })) return
        checking = true
        let probeOk = false
        try {
          const res = await fetch('http://127.0.0.1:' + lock.port + '/health', {
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
          })
          probeOk = !!res.ok
        } catch (err) {
        } finally {
          checking = false
        }
        const verdict = trackUnhealthy({ now: Date.now(), unhealthySince, probeOk })
        unhealthySince = verdict.unhealthySince
        if (verdict.kill) {
          unhealthySince = 0
          console.log('[fox-dock] daemon health timeout, restarting pid=' + child.pid)
          try {
            child.kill('SIGKILL')
          } catch (err) {}
        }
      }, HEALTH_POLL_MS)
      if (monitor.unref) monitor.unref()
      const code = await new Promise((resolve) => child.once('exit', (c, sig) => resolve(sig ? null : c)))
      clearInterval(monitor)
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
