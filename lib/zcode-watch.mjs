#!/usr/bin/env node
// 登录后常驻的轻量看门进程：ZCode.exe 一出现就拉起挂件服务/浮层。
//
// 为什么不是钩子：ZCode 只有 SessionStart 等 7 个事件，没有 AppStart；
// 用户不选会话时钩子不触发，挂件就等到第一次对话才出现。
//
// 启动方式：lib/watch-install.mjs 在 Startup 文件夹写一个隐藏 VBS，登录时跑
// `node lib/zcode-watch.mjs --daemon`。它只做进程探测（tasklist），发现状态
// 从「没有 ZCode」变成「有 ZCode」时调用一次 boot-widget 的幂等启动。
//
// 使用：
//   node lib/zcode-watch.mjs --daemon     常驻（VBS 用）
//   node lib/zcode-watch.mjs --once       检测一次并启动（测试/排障）
//   node lib/zcode-watch.mjs --status     查看看门进程、Startup 项与插件启用状态
//   node lib/zcode-watch.mjs --install    安装 Startup 项并启动看门进程
//   node lib/zcode-watch.mjs --uninstall  移除
//   node lib/zcode-watch.mjs --stop       只停看门进程
//
// 反向职责：ZCode 禁用插件（「取消使用」）只改 enabledPlugins，不通知已运行的进程。
// 常驻期间每 5s 查一次插件状态，明确被禁用就停浮层、停服务、删 Startup 项并退出
// （issue #24：禁用后挂件还挂在桌面上，只能任务管理器手杀）。判定口径见
// lib/plugin-state.mjs 的头部注释。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// 先读回 ZCode 启动时保存的目录环境（登录环境通常没有 ZCODE_DATA_BASE_DIR）。
// 必须在动态 import 业务模块之前做：paths.mjs 在 import 时就定了 DATA_DIR。
function applyRuntimeEnv() {
  const home = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
  const file = path.join(home, 'whale', 'runtime-env.json')
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const key of ['ZCODE_HOME', 'ZCODE_DATA_BASE_DIR']) {
      const v = typeof j[key] === 'string' ? j[key].trim() : ''
      if (v && !process.env[key]) process.env[key] = v
    }
  } catch (err) {}
}
applyRuntimeEnv()

const HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
const DATA_DIR = path.join(HOME, 'whale')
const LOCK_FILE = path.join(DATA_DIR, 'zcode-watch.lock')
const LOG_FILE = path.join(DATA_DIR, 'zcode-watch.log')
const LOG_KEEP = 200
const INTERVAL_MS = 3000
// 插件启用状态几拍查一次：config.json 只有几 KB，5s 的代价可忽略，
// 但又能在用户点「取消使用」后很快把挂件收掉（issue #24）。
const DISABLED_POLL_MS = 5000

const { ensureWidgetStarted } = await import('./boot-widget.mjs')
const { readPluginConfig } = await import('./credentials.mjs')
const { installWatch, startWatcher, stopWatcher, uninstallWatch, watchStatus, persistRuntimeEnv } = await import('./watch-install.mjs')
const { pluginEnabledStateNow } = await import('./plugin-state.mjs')
const { stopServer } = await import('./service.mjs')
const { stopOverlay } = await import('./overlay.mjs')

function log(text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + text + '\n', 'utf8')
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    if (lines.length > LOG_KEEP) fs.writeFileSync(LOG_FILE, lines.slice(-LOG_KEEP).join('\n') + '\n', 'utf8')
  } catch (err) {}
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

function readLock() {
  try {
    const j = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    return j && Number.isInteger(j.pid) ? j : null
  } catch (err) {
    return null
  }
}

function acquireLock() {
  const cur = readLock()
  if (cur && cur.pid !== process.pid && pidAlive(cur.pid)) return false
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }))
    return true
  } catch (err) {
    return false
  }
}

function releaseLock() {
  const cur = readLock()
  if (cur && cur.pid === process.pid) {
    try {
      fs.unlinkSync(LOCK_FILE)
    } catch (err) {}
  }
}

export function parseTasklistOutput(text) {
  return /\bzcode\.exe\b/i.test(String(text || ''))
}

export async function isZCodeRunning(opts = {}) {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/NH'], {
        windowsHide: true,
        timeout: 3000,
        maxBuffer: 64 * 1024,
      })
      return parseTasklistOutput(stdout)
    } catch (err) {
      return false
    }
  }
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', 'ZCode'], { timeout: 2000 })
    return String(stdout || '').trim().length > 0
  } catch (err) {
    return false
  }
}

async function runOnce() {
  // 插件被禁用后不允许再拉起任何东西：SessionStart 钩子在禁用后本来就不会跑，
  // 但看门进程是登录级常驻，必须自己过这一道门。
  const plugin = pluginEnabledStateNow()
  if (plugin.state === 'disabled') {
    log('skip plugin-disabled ' + plugin.matched.map((m) => m.key).join(','))
    return { ok: true, zcodeRunning: await isZCodeRunning(), skipped: 'plugin-disabled' }
  }
  const running = await isZCodeRunning()
  if (!running) {
    log('probe zcode=absent')
    return { ok: true, zcodeRunning: false, started: false }
  }
  const cfg = readPluginConfig()
  if (!cfg.autoStartWithZcode) {
    log('skip autoStartWithZcode=false')
    return { ok: true, zcodeRunning: true, skipped: 'autoStartWithZcode=false' }
  }
  const startedAt = Date.now()
  const r = await ensureWidgetStarted({ cfg, startedAt, source: 'zcode-watch' })
  log(
    'zcode=present server=' + r.server +
      ' overlay=' + r.overlay +
      ' dock=' + r.dock +
      ' elapsed=' + (Date.now() - startedAt) + 'ms'
  )
  return { ok: true, zcodeRunning: true, ...r }
}

// 用户点了「取消使用」：挂件服务/浮层都还活着，连同看门进程自己一起收掉。
// Startup 项同时删掉（插件已被禁用，保留它只会每次登录白起一次再退出）；
// 重新启用插件后由 SessionStart 钩子（autostart.mjs 的 installWatch）自动装回。
// 注意不能调 uninstallWatch() 的默认分支：stopWatcher() 会按锁里的 pid 给自己
// 发 SIGTERM 再同步等它退出，等于自己等自己，所以传 stopWatcher:false。
async function shutdownForPluginDisabled(plugin) {
  const keys = plugin.matched.map((m) => m.key).join(',')
  log('plugin disabled (' + keys + ')；收掉挂件与看门进程')
  let overlay = 'unknown'
  try {
    const r = await stopOverlay()
    overlay = r && r.ok ? 'stopped' : (r && r.error) || 'not-running'
  } catch (err) {
    overlay = 'error:' + String((err && err.message) || err)
  }
  let server = 'unknown'
  try {
    const r = await stopServer()
    server = r && r.ok ? 'stopped' : (r && r.error) || 'not-running'
  } catch (err) {
    server = 'error:' + String((err && err.message) || err)
  }
  let vbs = 'absent'
  try {
    const r = uninstallWatch({ stopWatcher: false })
    vbs = r && r.removed ? 'removed' : 'absent'
  } catch (err) {
    vbs = 'error:' + String((err && err.message) || err)
  }
  log('shutdown overlay=' + overlay + ' server=' + server + ' startup=' + vbs)
}

async function daemon() {
  if (!acquireLock()) {
    return 0
  }
  log('watch start pid=' + process.pid)
  const stop = (signal) => {
    log('watch stop ' + signal)
    releaseLock()
    process.exit(0)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('exit', releaseLock)

  let last = null
  let lastPluginCheckAt = 0
  for (;;) {
    // 反向职责：用户在 ZCode 里禁用/卸载插件时不会通知已运行的进程，这里自己看。
    if (Date.now() - lastPluginCheckAt >= DISABLED_POLL_MS) {
      lastPluginCheckAt = Date.now()
      const plugin = pluginEnabledStateNow()
      if (plugin.state === 'disabled') {
        await shutdownForPluginDisabled(plugin)
        releaseLock()
        return 0
      }
    }
    const running = await isZCodeRunning()
    if (running && last !== true) {
      await runOnce()
    } else if (!running && last === true) {
      log('zcode=absent (process exit); keep service running')
    }
    last = running
    await new Promise((r) => setTimeout(r, INTERVAL_MS))
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--install')) {
    persistRuntimeEnv()
    const w = installWatch()
    const s = startWatcher()
    console.log(JSON.stringify({ install: w, watcher: s, status: watchStatus() }, null, 2))
    return 0
  }
  if (args.includes('--uninstall')) {
    console.log(JSON.stringify(uninstallWatch(), null, 2))
    return 0
  }
  if (args.includes('--stop')) {
    console.log(JSON.stringify(stopWatcher(), null, 2))
    return 0
  }
  if (args.includes('--status')) {
    console.log(
      JSON.stringify(
        { ...watchStatus(), zcodeRunning: await isZCodeRunning(), plugin: pluginEnabledStateNow() },
        null,
        2
      )
    )
    return 0
  }
  if (args.includes('--once') || args.includes('--dry-run')) {
    if (args.includes('--dry-run')) {
      console.log(JSON.stringify({ zcodeRunning: await isZCodeRunning() }, null, 2))
      return 0
    }
    console.log(JSON.stringify(await runOnce(), null, 2))
    return 0
  }
  return daemon()
}

function isEntry() {
  try {
    return process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  } catch (err) {
    return false
  }
}

// 被 selftest/CLI import 时只导出函数，不启动看门循环。
if (isEntry()) {
  const code = await main()
  if (typeof code === 'number') process.exit(code)
}
