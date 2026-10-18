#!/usr/bin/env node
// 短时 soak（R10 的前置检查）：常驻服务 + 浮层连跑一段时间，
// 每秒打一轮接口，看稳定性与响应时间，而不是「跑一下没崩」。
//
// 用法：node tools/soak.mjs [--seconds 120] [--interval 1000]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCK = path.join(HERE, '..')
const DAEMON = path.join(DOCK, 'daemon', 'src', 'daemon.mjs')
const OVERLAY = path.join(DOCK, 'overlay')

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0) return Number(process.argv[i + 1])
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? Number(eq.slice(name.length + 1)) : fallback
}

const seconds = Number.isFinite(argValue('--seconds', 120)) ? argValue('--seconds', 120) : 120
const interval = Number.isFinite(argValue('--interval', 1000)) ? argValue('--interval', 1000) : 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function electronBinary() {
  const candidates = [
    process.env.FOX_DOCK_ELECTRON,
    path.join(os.homedir(), '.zcode', 'whale', 'desktop-runtime', 'node_modules', 'electron', 'dist', 'electron.exe'),
  ].filter(Boolean)
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch (err) {
      return false
    }
  })
}

function electronEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {}
    await sleep(150)
  }
  throw new Error('timeout: ' + label)
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-soak-'))
  let daemon = null
  let overlay = null
  const samples = []
  let errors = 0

  try {
    daemon = spawn(process.execPath, [DAEMON, '--data-dir', dataDir, '--port', '0'], { stdio: 'ignore', windowsHide: true })
    const started = await waitFor(async () => {
      const lock = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.lock'), 'utf8'))
      if (!lock.port) return null
      const h = await (await fetch('http://127.0.0.1:' + lock.port + '/health', { signal: AbortSignal.timeout(700) })).json()
      return h && h.ok ? { ...h, token: lock.token } : null
    }, 20000, 'daemon')
    const port = started.port
    const pid = started.pid

    const ELECTRON = electronBinary()
    if (ELECTRON) {
      overlay = spawn(ELECTRON, [OVERLAY, '--no-sandbox', '--disable-gpu', '--daemon-port=' + port], {
        stdio: 'ignore',
        env: electronEnv(),
      })
    }

    const t0 = Date.now()
    let rounds = 0
    console.log('soak ' + seconds + 's，端口 ' + port + '，pid ' + pid + (overlay ? ' + overlay pid ' + overlay.pid : '（无 Electron，只跑服务）'))
    while (Date.now() - t0 < seconds * 1000) {
      const s = Date.now()
      try {
        const [h, w, sum] = await Promise.all([
          fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
          fetch('http://127.0.0.1:' + port + '/windows', { signal: AbortSignal.timeout(3000) }).then((r) => r.json()),
          fetch('http://127.0.0.1:' + port + '/summary', { signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
        ])
        if (!h.ok || !w.ok || !sum.ok) errors++
        if (h.pid !== pid) {
          errors++
          console.error('pid changed during soak: ' + h.pid)
          break
        }
        samples.push({ ms: Date.now() - s, windows: (w.windows || []).length })
      } catch (err) {
        errors++
      }
      rounds++
      await sleep(interval)
    }

    const times = samples.map((x) => x.ms).sort((a, b) => a - b)
    const pct = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))] || 0
    const alive = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) })
      .then((r) => r.json())
      .catch(() => null)

    console.log('轮数 ' + rounds + '，失败 ' + errors + '，请求耗时 p50 ' + pct(0.5) + 'ms / p95 ' + pct(0.95) + 'ms / max ' + (times.at(-1) || 0) + 'ms')
    console.log('结束状态：' + (alive && alive.ok ? '健康，uptime ' + alive.uptimeSec + 's' : '❌ 不健康'))
    const ok = errors === 0 && alive && alive.ok
    console.log(ok ? '✅ soak 通过' : '❌ soak 失败')
    process.exitCode = ok ? 0 : 1
  } finally {
    for (const p of [overlay, daemon]) {
      try {
        if (p && !p.killed) p.kill()
      } catch (err) {}
    }
    await sleep(300)
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch (err) {}
  }
}

main().catch((err) => {
  console.error('soak 失败：' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
