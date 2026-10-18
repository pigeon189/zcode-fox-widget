#!/usr/bin/env node
// 真机端到端（R8 验收）：不依赖人工拖拽，用 CDP 在真实桌面上把狐狸拖到
// **真正的 ZCode / WorkBuddy 窗口**上，断言识别、绑定与数字。
//
// 这是手动验收脚本，不进 CI（依赖本机装了什么 agent）。
//
// 用法：node tools/e2e-real.mjs [--keep] [--verbose]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { overlayPidsOf } from '../daemon/src/electron.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCK = path.join(HERE, '..')
const DAEMON = path.join(DOCK, 'daemon', 'src', 'daemon.mjs')
const OVERLAY = path.join(DOCK, 'overlay')

const verbose = process.argv.includes('--verbose')
const keep = process.argv.includes('--keep')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(...a) {
  console.log(...a)
}
function vlog(...a) {
  if (verbose) console.log('  ·', ...a)
}

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

class Cdp {
  constructor(url) {
    this.id = 0
    this.pending = new Map()
    this.ws = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('ws error'))
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (!msg.id || !this.pending.has(msg.id)) return
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'cdp error'))
      else p.resolve(msg.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.text || 'exception'))
    return r.result.value
  }
  close() {
    try {
      this.ws.close()
    } catch (err) {}
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      last = err
    }
    await sleep(150)
  }
  throw new Error('timeout: ' + label + (last ? '（' + last.message + '）' : ''))
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  log((ok ? '✅ ' : '❌ ') + name + (detail && !ok ? '  ' + JSON.stringify(detail) : ''))
}
function skip(name, detail) {
  results.push({ name, ok: true, skipped: true })
  log('⏭ ' + name + '（跳过：' + detail + '）')
}

async function main() {
  const ELECTRON = electronBinary()
  if (!ELECTRON) {
    console.error('找不到 Electron 运行时（设 FOX_DOCK_ELECTRON 指过去）')
    process.exit(2)
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-e2e-'))
  let daemon = null
  let overlay = null
  let cdp = null

  try {
    daemon = spawn(process.execPath, [DAEMON, '--data-dir', dataDir, '--port', '0'], { stdio: 'ignore', windowsHide: true })
    const started = await waitFor(
      async () => {
        const lock = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.lock'), 'utf8'))
        if (!lock.port) return null
        const h = await (await fetch('http://127.0.0.1:' + lock.port + '/health', { signal: AbortSignal.timeout(700) })).json()
        return h && h.ok ? { ...h, token: lock.token } : null
      },
      20000,
      'daemon health'
    )
    const port = started.port
    log('daemon :' + port)

    const all = await (await fetch('http://127.0.0.1:' + port + '/windows')).json()
    const targets = (all.windows || []).filter((w) => /^(zcode|workbuddy)\.exe$/i.test(path.basename(w.exe || '')))
    if (!targets.length) {
      console.error('没找到 ZCode / WorkBuddy 窗口（先把它们打开）')
      process.exit(3)
    }
    vlog('目标窗口', targets.map((t) => path.basename(t.exe) + '#' + t.pid))

    // 桌面上的浮层（其它挂件 + 可能残留的 fox-dock）会吃掉命中，按标题识别后排除
    const overlayPids = overlayPidsOf(all.windows)
    const overlays = overlayPids.map((pid) => ({ pid }))
    const ignoreArg = '--ignore-pids=' + overlayPids.join(',')
    vlog('忽略浮层', overlayPids)

    overlay = spawn(
      ELECTRON,
      [OVERLAY, '--no-sandbox', '--disable-gpu', '--no-click-through', ignoreArg, '--daemon-port=' + port, '--remote-debugging-port=0'],
      { stdio: ['ignore', 'ignore', 'pipe'], env: electronEnv() }
    )
    let err = ''
    overlay.stderr.on('data', (d) => {
      err += String(d)
    })
    const devPort = await waitFor(
      async () => {
        const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)
        return m ? Number(m[1]) : null
      },
      15000,
      'overlay devtools'
    )
    const page = await waitFor(
      async () => {
        const list = await (await fetch('http://127.0.0.1:' + devPort + '/json/list')).json()
        return list.find((x) => x.type === 'page' && /index\.html/.test(x.url)) || null
      },
      15000,
      'overlay page'
    )
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')
    // 页面可能还没解析完 DOM
    await waitFor(async () => !!(await cdp.eval("!!document.getElementById('fox')")), 10000, 'overlay dom')
    log('overlay 就绪')

    // 目标窗口可能被别的窗口压住（实测 WorkBuddy 盖住 ZCode 一半），
    // 从中心开始按网格找「命中结果确实是它」的点。
    // 浮层自己也是全屏置顶，必须一起排除（否则命中的永远是它）
    const ignored = new Set([...overlays.map((o) => o.pid), overlay.pid])
    async function pickVisiblePoint(t) {
      const fractions = [
        [0.5, 0.5],
        [0.5, 0.3],
        [0.3, 0.5],
        [0.7, 0.5],
        [0.5, 0.7],
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
        // 窗口被大面积遮挡时，边缘常常还露着一条
        [0.03, 0.5],
        [0.03, 0.15],
        [0.03, 0.85],
        [0.97, 0.5],
        [0.5, 0.97],
      ]
      for (const [fx, fy] of fractions) {
        const x = Math.round(t.rect.x + t.rect.w * fx)
        const y = Math.round(t.rect.y + t.rect.h * fy)
        const r = await (
          await fetch('http://127.0.0.1:' + port + '/hit?x=' + x + '&y=' + y + '&exclude=' + overlay.pid)
        ).json()
        const top = (r.hits || []).find((h) => !ignored.has(h.pid))
        if (top && top.pid === t.pid) return { x, y }
      }
      return null
    }

    async function topHitAt(t) {
      const x = Math.round(t.rect.x + t.rect.w / 2)
      const y = Math.round(t.rect.y + t.rect.h / 2)
      const r = await (await fetch('http://127.0.0.1:' + port + '/hit?x=' + x + '&y=' + y + '&exclude=' + overlay.pid)).json()
      return (r.hits || []).find((h) => !ignored.has(h.pid)) || null
    }

    // 逐个目标：从狐狸当前位置拖到目标窗口的可见点
    const boundUnits = new Set()
    let index = 0
    for (const target of targets) {
      index++
      const fox = JSON.parse(
        await cdp.eval(
          "(function(){var r=document.getElementById('fox').getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()"
        )
      )
      const dpr = Number(await cdp.eval('window.devicePixelRatio')) || 1
      // CDP 合成事件的 screenX == clientX，窗口原点按 0 算才对得上（真实鼠标没有这个问题）
      const sx = 0
      const sy = 0
      const spot = await pickVisiblePoint(target)
      if (!spot) {
        // 用户可能正把别的窗口铺满屏幕。这不是 dock 的缺陷，别报成失败——
        // 但也绝不假装通过：单独计成 skipped，并在结尾如实说明。
        const top = await topHitAt(target)
        skip('真机拖拽 #' + index + '：' + path.basename(target.exe), '窗口被遮挡' + (top ? '（最上层是 ' + (top.title || top.exe) + '）' : ''))
        continue
      }
      const toX = spot.x / dpr - sx
      const toY = spot.y / dpr - sy

      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fox.x, y: fox.y, button: 'left', buttons: 1, clickCount: 1 })
      const steps = 8
      for (let i = 1; i <= steps; i++) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: fox.x + ((toX - fox.x) * i) / steps,
          y: fox.y + ((toY - fox.y) * i) / steps,
          button: 'left',
          buttons: 1,
        })
        await sleep(50)
      }
      await sleep(120)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 })

      const expected = /zcode/i.test(target.exe) ? 'zcode' : 'workbuddy'
      let binding = null
      try {
        binding = await waitFor(
          async () => {
            const r = await (await fetch('http://127.0.0.1:' + port + '/bindings')).json()
            return (r.bindings || []).find((b) => b.window && b.window.pid === target.pid && b.adapterId === expected) || null
          },
          10000,
          'binding ' + expected
        )
      } catch (e) {
        check('真机拖拽 #' + index + '：绑定到 ' + expected, false, e.message)
        continue
      }
      check('真机拖拽 #' + index + '：绑定到 ' + expected, true)
      boundUnits.add(expected === 'zcode' ? 'money' : 'credit')
      vlog('binding', binding.key)

      // 数字：等到不是「读取中」
      const chip = await waitFor(
        async () => {
          const raw = await cdp.eval(
            "(function(){var c=document.getElementById('chip');if(!c||c.hidden)return 'null';" +
              "return JSON.stringify({text:(c.textContent||'').replace(/\\\\s+/g,' ').trim(),cls:c.className})})()"
          )
          const val = JSON.parse(raw)
          return val && val.text && val.text.indexOf('读取中') === -1 ? val : null
        },
        15000,
        'chip for ' + expected
      ).catch(() => null)

      if (expected === 'zcode') {
        check('ZCode：chip 显示今日金额（¥）', !!chip && /今日\s*¥/.test(chip.text), chip)
      } else {
        check('WorkBuddy：chip 显示今日积分', !!chip && /今日\s*[\d.]+\s*积分/.test(chip.text), chip)
      }
    }

    // 汇总接口：已绑定的适配器都要进账本（被遮挡跳过的不算）
    const summary = await (await fetch('http://127.0.0.1:' + port + '/summary')).json()
    const units = new Set((summary.today.groups || []).map((g) => g.unit))
    const missing = [...boundUnits].filter((u) => !units.has(u))
    check(
      '汇总：包含已绑定适配器的口径（' + ([...boundUnits].join(' + ') || '无') + '）',
      boundUnits.size > 0 && missing.length === 0,
      { bound: [...boundUnits], got: [...units] }
    )
  } finally {
    if (cdp) cdp.close()
    for (const p of [overlay, daemon]) {
      try {
        if (p && !p.killed) p.kill()
      } catch (err) {}
    }
    await sleep(300)
    if (!keep) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true })
      } catch (err) {}
    } else {
      log('保留数据目录：' + dataDir)
    }
  }

  const failed = results.filter((r) => !r.ok)
  const skipped = results.filter((r) => r.skipped)
  log('')
  if (failed.length) {
    log('❌ ' + failed.length + '/' + results.length + ' 项失败' + (skipped.length ? '（另有 ' + skipped.length + ' 项跳过）' : ''))
    process.exit(1)
  }
  log('✅ ' + (results.length - skipped.length) + '/' + results.length + ' 项全过' + (skipped.length ? '，' + skipped.length + ' 项因窗口被遮挡跳过' : ''))
  process.exit(0)
}

main().catch((err) => {
  console.error('e2e-real 失败：' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
