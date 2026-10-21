#!/usr/bin/env node
// 视觉回归（L5）：控制台 8 页 × 双主题 × 两个视口，与入库基线逐像素比较。
//
//   node tools/visual-test.mjs            # 比对（缺基线时提示先生成）
//   node tools/visual-test.mjs --update   # 生成/更新基线（需人工过目差异）
//
// 基线只在固定 Windows 机器 + 本机 Edge 上生成与比对；环境不符直接失败，
// 不允许「换台机器全红后随手更新基线」。

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PAGES = ['overview', 'context', 'usage', 'stats', 'quota', 'vendors', 'roles', 'settings', 'about']
const VIEWPORTS = ['960x680', '760x560']
const THEMES = ['light', 'dark']
const BASELINE = path.join(ROOT, 'test', 'visual', 'baseline', 'console')
const SHOTS = path.join(ROOT, 'test', 'visual', '__shots__')
const DIFF = path.join(ROOT, 'test', 'visual', '__diff__')
const PORT = Number(process.env.FOX_DOCK_VISUAL_PORT || 39531)
const update = process.argv.includes('--update')

async function load(name, rel) {
  return import(pathToFileURL(path.join(ROOT, 'test', 'node_modules', name, rel)).href)
}

async function waitHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(500) })
      if (r.ok) return true
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}

async function edgeVersion() {
  const { chromium } = await load('@playwright', 'test/index.mjs')
  const b = await chromium.launch({ channel: 'msedge', headless: true })
  const v = b.version()
  await b.close()
  return v
}

function generate() {
  const args = [
    path.join(HERE, 'shots.mjs'),
    '--page', 'console',
    '--console-pages', PAGES.join(','),
    '--theme', THEMES.join(','),
    '--viewport', VIEWPORTS.join(','),
    '--dpr', '1',
    '--base', 'http://127.0.0.1:' + PORT,
    '--out', path.relative(ROOT, SHOTS),
  ]
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('截图失败：' + (r.stderr || r.stdout || '').slice(-400))
}

async function compare() {
  const { PNG } = await load('pngjs', 'lib/png.js')
  const envFile = path.join(BASELINE, 'env.json')
  const current = {
    platform: process.platform,
    arch: process.arch,
    edge: await edgeVersion(),
    dpr: 1,
    viewports: VIEWPORTS,
    themes: THEMES,
  }
  if (!fs.existsSync(envFile)) {
    console.log('没有视觉基线：先运行 npm run visual:update，并人工过目截图。')
    return 1
  }
  const saved = JSON.parse(fs.readFileSync(envFile, 'utf8'))
  if (saved.platform !== current.platform || saved.arch !== current.arch || saved.edge !== current.edge) {
    console.error('ENV-MISMATCH：基线环境 ' + JSON.stringify(saved) + '；当前 ' + JSON.stringify(current))
    console.error('换机器/换 Edge 版本后不要直接更新基线；请在固定环境重跑。')
    return 1
  }
  fs.rmSync(DIFF, { recursive: true, force: true })
  let bad = 0
  let total = 0
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      for (const page of PAGES) {
        const name = ['console', page, theme, vp, 'dpr1'].join('-') + '.png'
        const baseFile = path.join(BASELINE, name)
        const curFile = path.join(SHOTS, name)
        if (!fs.existsSync(baseFile) || !fs.existsSync(curFile)) {
          console.error('缺少截图：' + name)
          bad++
          continue
        }
        total++
        const a = PNG.sync.read(fs.readFileSync(baseFile))
        const b = PNG.sync.read(fs.readFileSync(curFile))
        if (a.width !== b.width || a.height !== b.height) {
          console.error('尺寸不一致：' + name)
          bad++
          continue
        }
        let diff = 0
        const out = new PNG({ width: a.width, height: a.height })
        for (let i = 0; i < a.data.length; i += 4) {
          const d =
            Math.abs(a.data[i] - b.data[i]) +
            Math.abs(a.data[i + 1] - b.data[i + 1]) +
            Math.abs(a.data[i + 2] - b.data[i + 2]) +
            Math.abs(a.data[i + 3] - b.data[i + 3])
          if (d > 24) {
            diff++
            out.data[i] = 255
            out.data[i + 1] = 0
            out.data[i + 2] = 0
            out.data[i + 3] = 255
          } else {
            out.data[i] = a.data[i]
            out.data[i + 1] = a.data[i + 1]
            out.data[i + 2] = a.data[i + 2]
            out.data[i + 3] = 40
          }
        }
        const ratio = diff / (a.width * a.height)
        if (ratio > 0.001) {
          bad++
          fs.mkdirSync(DIFF, { recursive: true })
          fs.writeFileSync(path.join(DIFF, name), PNG.sync.write(out))
          console.error('差异 ' + (ratio * 100).toFixed(2) + '%：' + name)
        }
      }
    }
  }
  if (bad) {
    console.error('视觉回归失败：' + bad + ' / ' + total + ' 张（差异图在 __diff__）')
    return 1
  }
  console.log('✅ 视觉回归通过：' + total + ' 张（阈值 0.1%）')
  return 0
}

async function main() {
  const fixture = spawn(
    process.execPath,
    [path.join(HERE, 'fixture-daemon.mjs'), '--scene', path.join(ROOT, 'test', 'fixtures', 'scenes', 'zcode-normal.json'), '--port', String(PORT)],
    { stdio: 'ignore', windowsHide: true }
  )
  try {
    if (!(await waitHealth())) throw new Error('夹具 daemon 未启动')
    generate()
    if (update) {
      fs.rmSync(BASELINE, { recursive: true, force: true })
      fs.mkdirSync(BASELINE, { recursive: true })
      for (const f of fs.readdirSync(SHOTS)) {
        if (f.endsWith('.png')) fs.copyFileSync(path.join(SHOTS, f), path.join(BASELINE, f))
      }
      fs.writeFileSync(
        path.join(BASELINE, 'env.json'),
        JSON.stringify({ platform: process.platform, arch: process.arch, edge: await edgeVersion(), dpr: 1, viewports: VIEWPORTS, themes: THEMES, generatedAt: new Date().toISOString() }, null, 2)
      )
      console.log('已更新视觉基线：' + BASELINE)
      return
    }
    process.exitCode = await compare()
  } finally {
    try {
      fixture.kill()
    } catch (err) {}
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
