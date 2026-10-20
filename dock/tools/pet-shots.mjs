#!/usr/bin/env node
// 宠物层截图：夹具 daemon + 浏览器渲染 overlay，覆盖四象限/悬浮/快览卡/菜单/气泡。
//
//   node tools/pet-shots.mjs [--theme light,dark] [--viewport 1280x720] [--port 39601]
//
// 输出 test/visual/__shots__/pet-*.png 与 index.html 联系表。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'test', 'visual', '__shots__')
const port = Number(process.env.FOX_DOCK_PET_PORT || 39601)

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const themes = String(arg('--theme', 'light,dark')).split(',')
const viewports = String(arg('--viewport', '1280x720')).split(',').map((v) => {
  const m = /^(\d+)x(\d+)$/.exec(v)
  return m ? { width: Number(m[1]), height: Number(m[2]), name: v } : null
}).filter(Boolean)

async function waitHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(500) })
      if (r.ok) return true
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}

const STATES = [
  { id: 'right-bottom', run: () => {} },
  { id: 'left-bottom', run: () => window.__pet.debugAttach('zcode', '0x1', { x: 100, y: 180, w: 960, h: 620 }, { h: 'left', v: 'bottom' }) },
  { id: 'right-top', run: () => window.__pet.debugAttach('zcode', '0x1', { x: 200, y: 80, w: 960, h: 620 }, { h: 'right', v: 'top' }) },
  { id: 'left-top', run: () => window.__pet.debugAttach('zcode', '0x1', { x: 100, y: 80, w: 960, h: 620 }, { h: 'left', v: 'top' }) },
  { id: 'free', run: () => window.__pet.debugAttach('zcode', '0x1', { x: 100, y: 80, w: 960, h: 620 }, { h: null, v: null, hOff: 120, vOff: 90 }) },
  { id: 'floating', run: () => window.__pet.debugFloat('zcode', 760, 360) },
  { id: 'quick', run: () => { window.__pet.debugAttach('zcode', '0x1', { x: 520, y: 180, w: 960, h: 620 }, { h: 'right', v: 'bottom' }); window.__pet.openQuick() } },
  { id: 'menu', run: () => { window.__pet.debugAttach('zcode', '0x1', { x: 520, y: 180, w: 960, h: 620 }, { h: 'right', v: 'bottom' }); window.__pet.openMenu(700, 220) } },
  { id: 'menu-bottom', run: () => { window.__pet.debugAttach('zcode', '0x1', { x: 520, y: 180, w: 960, h: 620 }, { h: 'right', v: 'bottom' }); window.__pet.openMenu(120, window.innerHeight - 60) } },
  { id: 'bubble', run: () => { window.__pet.debugAttach('zcode', '0x1', { x: 520, y: 180, w: 960, h: 620 }, { h: 'right', v: 'bottom' }); window.__pet.showBubble('上下文已用 82%，建议压缩会话', 'ZCode', { ms: 0 }) } },
  { id: 'say', run: () => { window.__pet.debugAttach('zcode', '0x1', { x: 520, y: 180, w: 960, h: 620 }, { h: 'right', v: 'bottom' }); window.__pet.say() } },
  { id: 'hide-money', run: () => { window.__pet.debugAttach('zcode', '0x1', { x: 520, y: 180, w: 960, h: 620 }, { h: 'right', v: 'bottom' }); window.__pet.setSettings({ hideMoney: true }); window.__pet.openQuick() } },
]

async function main() {
  const fixture = spawn(
    process.execPath,
    [path.join(HERE, 'fixture-daemon.mjs'), '--scene', path.join(ROOT, 'test', 'fixtures', 'scenes', 'zcode-normal.json'), '--port', String(port)],
    { stdio: 'ignore', windowsHide: true }
  )
  const shots = []
  try {
    if (!(await waitHealth())) throw new Error('夹具 daemon 未启动')
    const { chromium } = await import(
      pathToFileURL(path.join(ROOT, 'test', 'node_modules', '@playwright', 'test', 'index.mjs')).href
    )
    const browser = await chromium.launch({ channel: 'msedge', headless: true })
    fs.mkdirSync(OUT, { recursive: true })
    for (const theme of themes) {
      for (const vp of viewports) {
        for (const st of STATES) {
          const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: theme, reducedMotion: 'reduce' })
          await ctx.addInitScript(() => {
            window.foxOverlay = {
              setInteractive() {},
              getCursor: async () => ({ x: 0, y: 0 }),
              getBounds: async () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }),
              getAlphaMask: async () => ({ ok: false }),
              hit: async () => ({ ok: true, hits: [] }),
              write: async () => ({ ok: true }),
              openConsole() {},
              hideOverlay() {},
              quitDock() {},
            }
          })
          const page = await ctx.newPage()
          const errors = []
          page.on('pageerror', (e) => errors.push(e.message))
          const url = 'http://127.0.0.1:' + port + '/overlay/index.html?port=' + port + '&pid=999999&ct=0'
          await page.goto(url, { waitUntil: 'domcontentloaded' })
          await page.waitForSelector('#fox', { timeout: 10000 })
          await page.waitForTimeout(900)
          await page.evaluate((t) => {
            document.documentElement.dataset.theme = t
            document.documentElement.style.colorScheme = t
          }, theme)
          await page.evaluate(st.run)
          await page.waitForTimeout(250)
          if (errors.length) throw new Error(st.id + ' JS 异常：' + errors.join(' | '))
          const geom = await page.evaluate(() => {
            const box = (id) => {
              const el = document.getElementById(id)
              if (!el || el.hidden) return null
              const r = el.getBoundingClientRect()
              return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
            }
            return { width: innerWidth, height: innerHeight, fox: box('fox'), chip: box('chip'), quick: box('quick'), menu: box('menu') }
          })
          if (geom.quick) {
            for (const key of ['fox', 'chip']) {
              const r = geom[key]
              if (!r) continue
              const ox = Math.min(r.right, geom.quick.right) - Math.max(r.left, geom.quick.left)
              const oy = Math.min(r.bottom, geom.quick.bottom) - Math.max(r.top, geom.quick.top)
              if (ox > 0 && oy > 0) throw new Error(st.id + ' 快览卡遮挡 ' + key + '：' + JSON.stringify({ quick: geom.quick, [key]: r }))
            }
          }
          for (const key of ['fox', 'quick', 'menu']) {
            const r = geom[key]
            if (!r) continue
            if (r.left < -1 || r.top < -1 || r.right > geom.width + 1 || r.bottom > geom.height + 1) {
              throw new Error(st.id + ' ' + key + ' 越界：' + JSON.stringify({ viewport: [geom.width, geom.height], rect: r }))
            }
          }
          const name = 'pet-' + st.id + '-' + theme + '-' + vp.name + '.png'
          await page.screenshot({ path: path.join(OUT, name) })
          shots.push({ name, theme, viewport: vp.name, state: st.id })
          await ctx.close()
        }
      }
    }
    await browser.close()
    writeSheet(shots)
    console.log('已生成 ' + shots.length + ' 张宠物层截图：' + OUT)
  } finally {
    try {
      fixture.kill()
    } catch (err) {}
  }
}

function writeSheet(shots) {
  const cards = shots
    .map(
      (s) =>
        '<figure><a href="' + s.name + '"><img src="' + s.name + '" loading="lazy" alt="' + s.name + '"></a><figcaption>' +
        s.state + ' · ' + s.theme + ' · ' + s.viewport + '</figcaption></figure>'
    )
    .join('')
  const html =
    '<!doctype html><meta charset="utf-8"><title>fox-dock 宠物层截图</title>' +
    '<style>body{font:14px/1.5 "Segoe UI","Microsoft YaHei UI",sans-serif;margin:24px;background:#f6f7f9;color:#172033}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}' +
    'figure{margin:0;background:#fff;border:1px solid #e3e6eb;border-radius:8px;padding:8px}img{width:100%;display:block}figcaption{font-size:12px;color:#66708a;margin-top:6px}</style>' +
    '<h1>fox-dock 宠物层截图</h1><div class="grid">' + cards + '</div>'
  fs.writeFileSync(path.join(OUT, 'pet-index.html'), html)
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
