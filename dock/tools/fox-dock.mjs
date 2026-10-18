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
import { describeAdapters, resolveAdapter } from '../adapters/registry.mjs'
import { DEFAULT_CHANNEL, compareVersions, fetchManifest, readUpdateState, updateFromManifest } from '../daemon/src/update.mjs'

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
    const withAdapters = windows.map((w) => {
      const d = resolveAdapter(w)
      return { ...w, adapter: { id: d.id, name: d.name, fallback: d.fallback, billing: d.capabilities.billing } }
    })
    const hitsWithAdapters = hits.map((h) => {
      const d = resolveAdapter(h)
      return { ...h, adapter: { id: d.id, name: d.name, fallback: d.fallback, billing: d.capabilities.billing } }
    })
    console.log(
      JSON.stringify(
        { ok: true, version: VERSION, readyMs, snapMs, cursor, windows: withAdapters, hits: hitsWithAdapters },
        null,
        2
      )
    )
    return
  }

  console.log('fox-dock ' + VERSION + '  doctor')
  console.log('bridge ready in ' + readyMs + 'ms, snapshot ' + windows.length + ' windows in ' + snapMs + 'ms')
  console.log('')
  console.log(
    pad('Z', 4) + pad('PID', 7) + pad('DPI', 5) + pad('RECT', 21) + pad('ADAPTER', 12) + pad('EXE', 26) + 'TITLE'
  )
  for (const w of windows.slice(0, 40)) {
    const exe = w.exe ? w.exe.split(/[\\/]/).pop() : '(unknown)'
    const rect = w.rect.x + ',' + w.rect.y + ' ' + w.rect.w + 'x' + w.rect.h
    const d = resolveAdapter(w)
    const tag = d.fallback ? '—' : d.id
    console.log(pad(w.z, 4) + pad(w.pid, 7) + pad(w.dpi, 5) + pad(rect, 21) + pad(tag, 12) + pad(exe, 26) + w.title)
  }
  console.log('')
  console.log('cursor ' + cursor.x + ',' + cursor.y + ' (own pid ' + process.pid + ' excluded)')
  if (!hits.length) console.log('  no window under cursor')
  for (const h of hits) {
    const exe = h.exe ? h.exe.split(/[\\/]/).pop() : '(unknown)'
    const d = resolveAdapter(h)
    console.log('  z=' + h.z + ' pid=' + h.pid + ' ' + exe + ' [' + (d.fallback ? 'no adapter' : d.name) + ']  ' + JSON.stringify(h.title))
  }
}

function defaultManifestUrl() {
  const channel = argValue(process.argv, '--channel') || DEFAULT_CHANNEL
  return (
    argValue(process.argv, '--manifest') ||
    process.env.FOX_DOCK_MANIFEST ||
    'https://raw.githubusercontent.com/pigeon189/zcode-fox-widget/' + channel + '/docs/dock/update.json'
  )
}

const DOCK_ROOT = path.join(HERE, '..')
const UPDATE_PUBKEY = path.join(DOCK_ROOT, 'keys', 'update-pub.pem')

async function updateCmd(args) {
  const dataDir = pathsFor(dataDirFrom(args)).dir
  const stateFile = path.join(dataDir, 'update-state.json')
  const url = defaultManifestUrl()

  if (args.includes('--history')) {
    const st = readUpdateState(stateFile)
    if (!st.history.length) {
      console.log('暂无更新记录')
      return
    }
    for (const h of st.history.slice().reverse()) {
      console.log(
        new Date(h.at).toLocaleString() + '  v' + (h.from || '?') + ' → v' + (h.to || '?') + '  ' + h.result + (h.error ? '  ' + h.error : '')
      )
    }
    return
  }

  let manifest = null
  // --pubkey 供测试与密钥轮换使用；默认仓库里的发布公钥
  const pubkeyPath = argValue(args, '--pubkey') || UPDATE_PUBKEY
  const publicKeyPem = fs.existsSync(pubkeyPath) ? fs.readFileSync(pubkeyPath, 'utf8') : ''
  try {
    manifest = await fetchManifest(url, {
      publicKeyPem,
      // 默认必须验签；--no-verify 只给本地调试用，会在输出里显式警告
      requireSignature: !args.includes('--no-verify'),
    })
    if (args.includes('--no-verify')) console.warn('⚠ 已跳过清单签名校验（--no-verify），仅限本地调试')
  } catch (err) {
    console.error('检查失败：' + (err && err.message ? err.message : err))
    console.error('（清单地址：' + url + '；可用 --manifest 或 FOX_DOCK_MANIFEST 覆盖）')
    process.exitCode = 1
    return
  }

  const cmp = compareVersions(manifest.version, VERSION)
  console.log('当前 v' + VERSION + '，清单 v' + manifest.version + (cmp > 0 ? '（有更新）' : '（已是最新）'))
  if (manifest.notes) console.log('说明：' + manifest.notes)
  if (!args.includes('--apply')) {
    console.log('加 --apply 执行更新（更新后需重启：fox-dock stop 再 start）')
    return
  }
  if (cmp <= 0) return

  const root = argValue(args, '--root') || path.resolve(DOCK_ROOT)
  console.log('目标目录：' + root)
  const r = await updateFromManifest(manifest, { root, dataDir, currentVersion: VERSION })
  if (!r.ok) {
    console.error('更新失败：' + r.reason + (r.error ? '（' + r.error + '）' : ''))
    if (r.rollback && !r.rollback.ok) console.error('⚠ 回滚未完成：' + r.rollback.errors.join('; '))
    process.exitCode = 1
    return
  }
  console.log('已写入 ' + r.files + ' 个文件，备份在 ' + r.backupDir)
  console.log('重启后生效：fox-dock stop && fox-dock start')
}

function adapters() {
  const list = describeAdapters()
  console.log(pad('ID', 14) + pad('NAME', 16) + pad('BILLING', 9) + pad('FALLBACK', 10) + 'MATCH')
  for (const a of list) {
    const m = []
    if (a.match.exeBasenames.length) m.push('exe=' + a.match.exeBasenames.join('|'))
    if (a.match.exeIncludes.length) m.push('path~' + a.match.exeIncludes.join('|'))
    if (a.match.titleIncludes.length) m.push('title~' + a.match.titleIncludes.join('|'))
    if (a.match.classes.length) m.push('cls=' + a.match.classes.join('|'))
    console.log(
      pad(a.id, 14) +
        pad(a.name, 16) +
        pad(a.billing ? 'yes' : '-', 9) +
        pad(a.fallback ? 'yes' : '-', 10) +
        (m.length ? m.join(' & ') : '(兜底，不参与匹配)')
    )
  }
}

async function diag(args) {
  const paths = pathsFor(dataDirFrom(args))
  const lock = readLock(paths.lock)
  if (!lock || !lock.port) {
    console.error('daemon 没在跑（先 fox-dock start）')
    process.exitCode = 1
    return
  }
  try {
    const res = await fetch('http://127.0.0.1:' + lock.port + '/diag.json', { signal: AbortSignal.timeout(3000) })
    const data = await res.json()
    const out = argValue(args, '--out')
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
      fs.writeFileSync(out, JSON.stringify(data, null, 2))
      console.log('诊断包已写入：' + path.resolve(out))
      console.log('（不含密钥；路径里的用户名已替换成 ~）')
      return
    }
    console.log(JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('读取诊断失败：' + (err && err.message ? err.message : err))
    process.exitCode = 1
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
  else if (cmd === 'adapters') adapters()
  else if (cmd === 'update') await updateCmd(rest)
  else if (cmd === 'diag') await diag(rest)
  else if (cmd === 'start') await start(rest)
  else if (cmd === 'stop') await stop(rest)
  else if (cmd === 'status') await status(rest)
  else if (cmd === 'install') await install(rest)
  else if (cmd === 'uninstall') await uninstall(rest)
  else if (cmd === 'version' || cmd === '--version' || cmd === '-v') console.log(VERSION)
  else {
    console.log('usage: fox-dock <doctor|adapters|diag|update|start|stop|status|install|uninstall|version> [--data-dir <dir>]')
    process.exitCode = cmd ? 1 : 0
  }
} catch (err) {
  console.error('fox-dock: ' + (err && err.message ? err.message : err))
  process.exitCode = 1
}
