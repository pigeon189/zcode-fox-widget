#!/usr/bin/env node
// fox-dock CLI：doctor / start / stop / status / version。
// install/uninstall 在 R2 后续接入（需要写启动项，当前环境不便自动验证）。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Win32Bridge } from '../daemon/src/win32.mjs'
import { VERSION } from '../daemon/src/main.mjs'
import { isProcessAlive, readLock } from '../daemon/src/lock.mjs'
import { pathsFor } from '../daemon/src/paths.mjs'
import { installLauncher, uninstallLauncher } from '../daemon/src/install.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WATCHDOG = path.join(HERE, '..', 'daemon', 'src', 'watchdog.mjs')

function pad(s, n) {
  s = String(s == null ? '' : s)
  let w = 0
  for (const ch of s) w += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1
  return s + ' '.repeat(Math.max(0, n - w))
}

function dataDirFrom(args) {
  const i = args.indexOf('--data-dir')
  if (i >= 0) return args[i + 1] || ''
  const eq = args.find((a) => a.startsWith('--data-dir='))
  return eq ? eq.slice('--data-dir='.length) : ''
}

async function healthOf(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1000) })
    return await res.json()
  } catch (err) {
    return null
  }
}

async function waitHealthy(paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = readLock(paths.lock)
    if (lock && lock.port && isProcessAlive(lock.pid)) {
      const h = await healthOf(lock.port)
      if (h && h.ok) return h
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

async function doctor(args) {
  const asJson = args.includes('--json')
  const bridge = new Win32Bridge()
  const t0 = Date.now()
  await bridge.start()
  const readyMs = Date.now() - t0
  const t1 = Date.now()
  const windows = await bridge.snapshot()
  const snapMs = Date.now() - t1
  const cursor = await bridge.cursor()
  const hits = await bridge.hit(cursor.x, cursor.y, process.pid)
  bridge.stop()

  if (asJson) {
    console.log(JSON.stringify({ ok: true, version: VERSION, readyMs, snapMs, cursor, windows, hits }, null, 2))
    return
  }

  console.log('fox-dock ' + VERSION + '  doctor')
  console.log('bridge ready in ' + readyMs + 'ms, snapshot ' + windows.length + ' windows in ' + snapMs + 'ms')
  console.log('')
  console.log(pad('Z', 4) + pad('PID', 7) + pad('DPI', 5) + pad('RECT', 21) + pad('EXE', 30) + 'TITLE')
  for (const w of windows.slice(0, 40)) {
    const exe = w.exe ? w.exe.split(/[\\/]/).pop() : '(unknown)'
    const rect = w.rect.x + ',' + w.rect.y + ' ' + w.rect.w + 'x' + w.rect.h
    console.log(pad(w.z, 4) + pad(w.pid, 7) + pad(w.dpi, 5) + pad(rect, 21) + pad(exe, 30) + w.title)
  }
  console.log('')
  console.log('cursor ' + cursor.x + ',' + cursor.y + ' (own pid ' + process.pid + ' excluded)')
  if (!hits.length) console.log('  no window under cursor')
  for (const h of hits) {
    const exe = h.exe ? h.exe.split(/[\\/]/).pop() : '(unknown)'
    console.log('  z=' + h.z + ' pid=' + h.pid + ' ' + exe + '  ' + JSON.stringify(h.title))
  }
}

async function start(args) {
  const dataDir = dataDirFrom(args)
  const paths = pathsFor(dataDir)
  const lock = readLock(paths.lock)
  if (lock && isProcessAlive(lock.pid)) {
    const h = lock.port ? await healthOf(lock.port) : null
    if (h && h.ok) {
      console.log('already running pid=' + h.pid + ' port=' + h.port)
      return
    }
  }
  const child = spawn(process.execPath, [WATCHDOG, ...(dataDir ? ['--data-dir', dataDir] : [])], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  const h = await waitHealthy(paths, 15000)
  if (!h) {
    console.error('start failed: daemon did not become healthy in 15s')
    process.exitCode = 1
    return
  }
  console.log('started pid=' + h.pid + ' port=' + h.port + ' version=' + h.version)
}

async function stop(args) {
  const dataDir = dataDirFrom(args)
  const paths = pathsFor(dataDir)
  const lock = readLock(paths.lock)
  if (!lock) {
    console.log('not running')
    return
  }
  if (!isProcessAlive(lock.pid)) {
    console.log('stale lock (pid ' + lock.pid + ' gone)')
    return
  }
  try {
    const res = await fetch('http://127.0.0.1:' + lock.port + '/shutdown', {
      method: 'POST',
      headers: { 'x-fox-token': lock.token || '' },
      signal: AbortSignal.timeout(3000),
    })
    const data = await res.json()
    if (!data.ok) {
      console.error('stop failed: ' + (data.error || 'unknown'))
      process.exitCode = 1
      return
    }
  } catch (err) {
    console.error('stop failed: ' + (err && err.message ? err.message : err))
    process.exitCode = 1
    return
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!isProcessAlive(lock.pid)) {
      console.log('stopped')
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  console.error('stopped (sent), but pid ' + lock.pid + ' still alive')
  process.exitCode = 1
}

async function status(args) {
  const dataDir = dataDirFrom(args)
  const paths = pathsFor(dataDir)
  const lock = readLock(paths.lock)
  if (!lock) {
    console.log('not running')
    return
  }
  const h = lock.port ? await healthOf(lock.port) : null
  if (!h || !h.ok) {
    console.log('lock present but no health (pid ' + lock.pid + ' alive=' + isProcessAlive(lock.pid) + ')')
    process.exitCode = 1
    return
  }
  console.log(
    'running pid=' + h.pid + ' port=' + h.port + ' version=' + h.version + ' uptime=' + h.uptimeSec + 's bridge=' + h.bridgeReady
  )
}

function argValue(args, name) {
  const i = args.indexOf(name)
  if (i >= 0) return args[i + 1] || ''
  const eq = args.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : ''
}

async function install(args) {
  const dataDir = path.resolve(dataDirFrom(args) || pathsFor().dir)
  const startupOverride = argValue(args, '--startup-dir')
  const r = installLauncher({
    dataDir,
    startupDir: startupOverride || undefined,
    nodePath: process.execPath,
    watchdogPath: WATCHDOG,
    format: args.includes('--cmd') ? 'cmd' : 'vbs',
  })
  console.log('launcher written: ' + r.file)
  console.log('下次登录会自动启动；现在想立刻跑：fox-dock start' + (dataDir ? ' --data-dir ' + dataDir : ''))
}

async function uninstall(args) {
  const startupOverride = argValue(args, '--startup-dir')
  const r = uninstallLauncher({ startupDir: startupOverride || undefined })
  console.log(r.removed.length ? 'removed: ' + r.removed.join(', ') : 'no launcher found')
  if (args.includes('--purge')) {
    await stop(args)
    const dir = pathsFor(dataDirFrom(args)).dir
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      console.log('purged: ' + dir)
    } catch (err) {
      console.error('purge failed: ' + (err && err.message ? err.message : err))
    }
  }
}

const [, , cmd, ...rest] = process.argv
try {
  if (cmd === 'doctor') await doctor(rest)
  else if (cmd === 'start') await start(rest)
  else if (cmd === 'stop') await stop(rest)
  else if (cmd === 'status') await status(rest)
  else if (cmd === 'install') await install(rest)
  else if (cmd === 'uninstall') await uninstall(rest)
  else if (cmd === 'version' || cmd === '--version' || cmd === '-v') console.log(VERSION)
  else {
    console.log('usage: fox-dock <doctor|start|stop|status|install|uninstall|version> [--data-dir <dir>]')
    process.exitCode = cmd ? 1 : 0
  }
} catch (err) {
  console.error('fox-dock: ' + (err && err.message ? err.message : err))
  process.exitCode = 1
}
