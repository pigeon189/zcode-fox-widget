#!/usr/bin/env node
// 视觉回归（L5）：控制台 9 页 × 双主题 × 两视口 + pre.2 场景矩阵，与入库基线逐像素比较。
//
//   node tools/visual-test.mjs            # 比对（缺基线时提示先生成）
//   node tools/visual-test.mjs --update   # 生成/更新基线（需人工过目差异）
//
// 基线只在固定 Windows 机器 + 本机 Edge 上生成与比对；环境不符直接失败，
// 不允许「换台机器全红后随手更新基线」。

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PAGES = ['overview', 'sessions', 'usage', 'stats', 'quota', 'vendors', 'roles', 'settings', 'about']
const VIEWPORTS = ['960x680', '760x560']
const THEMES = ['light', 'dark']
const BASELINE = path.join(ROOT, 'test', 'visual', 'baseline', 'console')
const SHOTS = path.join(ROOT, 'test', 'visual', '__shots__')
const DIFF = path.join(ROOT, 'test', 'visual', '__diff__')
const PORT = Number(process.env.FOX_DOCK_VISUAL_PORT || 39531)
const BASE = 'http://127.0.0.1:' + PORT
const update = process.argv.includes('--update')

async function clickUsageTab(p, name) {
  await p.getByRole('tab', { name }).click()
  await p.evaluate(() => {
    const c = document.getElementById('content')
    const el = document.querySelector('[data-testid="usage.breakdown"]')
    if (c && el) c.scrollTop = c.scrollTop + el.getBoundingClientRect().top - c.getBoundingClientRect().top - 8
  })
}

// 自绘 DatePicker（ui/components/base.mjs）：点触发按钮，必要时翻月，再点日期格。
// 原生 input[type=date] 已被替换，视觉场景也必须走真实交互。
async function pickDate(p, label, dayKey) {
  await p.locator(`button[aria-label^="${label}"]`).click()
  const pop = p.locator('.dp-pop')
  await pop.waitFor({ state: 'visible' })
  const target = pop.locator(`[role="gridcell"]:not(.outside)[aria-label$="${dayKey}"]`)
  for (let i = 0; i < 24 && (await target.count()) === 0; i++) {
    const title = await pop.locator('.dp-title').innerText()
    const m = /(\d{4})年(\d{1,2})月/.exec(title)
    const cur = m ? m[1] + '-' + String(m[2]).padStart(2, '0') : ''
    await pop.getByRole('button', { name: dayKey.slice(0, 7) >= cur ? '下个月' : '上个月' }).click()
  }
  if ((await target.count()) === 0) throw new Error('日期 ' + dayKey + ' 不在可选窗口内')
  await target.click()
}

// §9.3.4 场景矩阵。act 只做「点击/滚动」这类确定性交互。
const SPECIALS = [
  { name: 'sessions-live', scene: 'sessions-live', page: 'sessions', vps: ['1280x800', '960x680', '760x560'] },
  { name: 'sessions-tab-turns', scene: 'sessions-live', page: 'sessions', vps: ['960x680'], act: (p) => p.getByRole('tab', { name: '回合' }).click() },
  { name: 'sessions-tab-tools', scene: 'sessions-live', page: 'sessions', vps: ['960x680'], act: (p) => p.getByRole('tab', { name: '工具' }).click() },
  { name: 'sessions-tab-context', scene: 'sessions-live', page: 'sessions', vps: ['960x680'], act: async (p) => { await p.getByRole('tab', { name: '上下文' }).click(); await p.waitForTimeout(500) } },
  { name: 'sessions-empty', scene: 'sessions-empty', page: 'sessions', vps: ['960x680'] },
  { name: 'sessions-kimi-only', scene: 'sessions-kimi-only', page: 'sessions', vps: ['960x680'] },
  { name: 'sessions-long-text', scene: 'sessions-long-text', page: 'sessions', vps: ['960x680', '760x560'] },
  { name: 'sessions-banner-permission', scene: 'permission-pending', page: 'sessions', vps: ['960x680'] },
  { name: 'sessions-banner-high-risk', scene: 'permission-high-risk', page: 'sessions', vps: ['960x680'] },
  { name: 'sessions-banner-host-only', scene: 'permission-observe-only', page: 'sessions', vps: ['960x680'] },
  { name: 'sessions-queue', scene: 'permission-queue', page: 'sessions', vps: ['960x680'] },
  { name: 'sessions-many', scene: 'sessions-many', page: 'sessions', vps: ['960x680'] },
  { name: 'overview-busy', scene: 'overview-busy', page: 'overview', vps: ['1280x800', '960x680', '760x560'] },
  { name: 'overview-idle', scene: 'overview-idle', page: 'overview', vps: ['1280x800', '960x680', '760x560'] },
  { name: 'usage-compare', scene: 'usage-compare', page: 'usage', vps: ['1280x800', '960x680'], act: (p) => p.evaluate(() => { const el = document.querySelector('input[aria-label="对比上一周期"]'); if (el) el.click() }) },
  { name: 'usage-prev-zero', scene: 'usage-prev-zero', page: 'usage', vps: ['1280x800', '960x680'], act: (p) => p.evaluate(() => { const el = document.querySelector('input[aria-label="对比上一周期"]'); if (el) el.click() }) },
  { name: 'usage-forecast-empty', scene: 'usage-forecast-empty', page: 'usage', vps: ['1280x800', '960x680'] },
  {
    name: 'usage-custom-range-error',
    scene: 'usage-compare',
    page: 'usage',
    vps: ['960x680'],
    act: async (p) => {
      await p.getByRole('tab', { name: '自定义' }).click()
      await pickDate(p, '开始日期', '2026-10-22')
      await pickDate(p, '结束日期', '2026-10-01')
      await p.getByRole('button', { name: '应用' }).click()
    },
  },
  { name: 'usage-breakdown-currency', scene: 'usage-breakdown-multi-currency', page: 'usage', vps: ['1280x800', '960x680'] },
  { name: 'usage-breakdown-tool', scene: 'usage-breakdown-tool', page: 'usage', vps: ['1280x800', '960x680'], act: (p) => clickUsageTab(p, '按工具') },
  { name: 'usage-breakdown-model', scene: 'usage-breakdown-model', page: 'usage', vps: ['1280x800', '960x680'], act: (p) => clickUsageTab(p, '按模型') },
  { name: 'usage-breakdown-vendor', scene: 'usage-breakdown-vendor', page: 'usage', vps: ['1280x800', '960x680'], act: (p) => clickUsageTab(p, '按厂商') },
  { name: 'usage-breakdown-session', scene: 'usage-breakdown-session', page: 'usage', vps: ['1280x800', '960x680'], act: (p) => clickUsageTab(p, '按会话') },
  { name: 'stats-sourcetags', scene: 'stats-sourcetags', page: 'stats', vps: ['960x680'] },
  { name: 'stats-kimi-empty', scene: 'stats-kimi-empty', page: 'stats', vps: ['960x680'] },
  { name: 'quota-matrix', scene: 'quota-matrix', page: 'quota', vps: ['1280x800', '960x680'], act: (p) => p.getByRole('tab', { name: '矩阵' }).click() },
  { name: 'settings-live-perm', scene: 'settings-live-perm', page: 'settings', vps: ['960x680'], act: (p) => p.evaluate(() => { const c = document.getElementById('content'); const el = document.getElementById('live'); if (c && el) c.scrollTop = c.scrollTop + el.getBoundingClientRect().top - c.getBoundingClientRect().top - 8 }) },
  { name: 'about-ingest-diag', scene: 'zcode-normal', page: 'about', vps: ['960x680'], act: (p) => p.evaluate(() => { const c = document.getElementById('content'); if (c) c.scrollTop = 420 }) },
  { name: 'sourcetag-gallery', scene: 'zcode-normal', url: '/ui/gallery.html', vps: ['1280x800'], fullPage: true },
  { name: 'provenance-all-kinds', scene: 'provenance-all-kinds', page: 'sessions', vps: ['960x680'] },
]

async function load(name, rel) {
  return import(pathToFileURL(path.join(ROOT, 'test', 'node_modules', name, rel)).href)
}

async function waitHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(500) })
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
    '--base', BASE,
    '--out', path.relative(ROOT, SHOTS),
  ]
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('截图失败：' + (r.stderr || r.stdout || '').slice(-400))
}

function specialFiles() {
  const out = []
  for (const sp of SPECIALS) for (const theme of THEMES) for (const vp of sp.vps) out.push(sp.name + '-' + theme + '-' + vp + '.png')
  return out
}

async function switchScene(name) {
  const r = await fetch(BASE + '/__fixture/scene', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!r.ok) throw new Error('切换场景失败：' + name)
}

async function annotatePage(p) {
  await p.evaluate(() => {
    const targets = [
      ['session-row', '.sess-row'],
      ['live-tile', '.live-tile'],
      ['source-tag', '.source-tag'],
      ['range-row', '.range-row'],
      ['quota-matrix', '.quota-matrix'],
      ['task-card', '.task-card > .card'],
    ]
    for (const [label, sel] of targets) {
      const el = document.querySelector(sel)
      if (!el) continue
      const r = el.getBoundingClientRect()
      const box = document.createElement('div')
      box.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;border:1px solid #ff2d55;' +
        'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px'
      const tag = document.createElement('span')
      tag.textContent = label + ' ' + Math.round(r.width) + '×' + Math.round(r.height)
      tag.style.cssText = 'position:absolute;left:0;top:-18px;background:#ff2d55;color:#fff;' +
        'font:11px/16px "Cascadia Mono",monospace;padding:0 4px;border-radius:3px;white-space:nowrap'
      box.appendChild(tag)
      document.body.appendChild(box)
    }
  })
  await p.waitForTimeout(80)
}

async function captureSpecials() {
  const { chromium } = await load('@playwright', 'test/index.mjs')
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    for (const sp of SPECIALS) {
      await switchScene(sp.scene)
      for (const theme of THEMES) {
        for (const vp of sp.vps) {
          const [width, height] = vp.split('x').map(Number)
          const ctx = await browser.newContext({
            viewport: { width, height },
            deviceScaleFactor: 1,
            colorScheme: theme,
            reducedMotion: 'reduce',
          })
          const p = await ctx.newPage()
          const errors = []
          p.on('pageerror', (e) => errors.push(e.message))
          const url = sp.url ? BASE + sp.url : BASE + '/ui/console.html#' + sp.page
          await p.goto(url, { waitUntil: 'networkidle' })
          await p.evaluate((t) => {
            document.documentElement.dataset.theme = t
            document.documentElement.style.colorScheme = t
          }, theme)
          await p.waitForTimeout(sp.name === 'sessions-many' ? 1200 : 500)
          if (sp.act) await sp.act(p)
          await p.waitForTimeout(400)
          // 遮罩必须在最终渲染之后：异步数据可能晚于首次 evaluate 才挂上。
          await p.evaluate(() => {
            for (const el of document.querySelectorAll('[data-visual-mask]')) el.style.visibility = 'hidden'
            // 旋转弧相位不确定：基线统一隐藏，几何由 ui-check 断言。
            for (const el of document.querySelectorAll('.spin')) el.style.visibility = 'hidden'
          })
          await p.waitForTimeout(120)
          if (errors.length) throw new Error(sp.name + ' JS 异常：' + errors.join(' | '))
          const shot = path.join(SHOTS, sp.name + '-' + theme + '-' + vp + '.png')
          await p.screenshot({ path: shot, fullPage: sp.fullPage === true })
          await annotatePage(p)
          await p.screenshot({ path: shot.replace(/\.png$/, '.annot.png'), fullPage: sp.fullPage === true })
          await ctx.close()
        }
      }
    }
  } finally {
    await browser.close()
  }
}

function diffPair(PNG, name, badRef) {
  const baseFile = path.join(BASELINE, name)
  const curFile = path.join(SHOTS, name)
  if (!fs.existsSync(baseFile) || !fs.existsSync(curFile)) {
    console.error('缺少截图：' + name)
    badRef.bad++
    return
  }
  badRef.total++
  const a = PNG.sync.read(fs.readFileSync(baseFile))
  const b = PNG.sync.read(fs.readFileSync(curFile))
  if (a.width !== b.width || a.height !== b.height) {
    console.error('尺寸不一致：' + name)
    badRef.bad++
    return
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
    badRef.bad++
    fs.mkdirSync(DIFF, { recursive: true })
    fs.writeFileSync(path.join(DIFF, name), PNG.sync.write(out))
    console.error('差异 ' + (ratio * 100).toFixed(2) + '%：' + name)
  }
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
  const badRef = { bad: 0, total: 0 }
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      for (const page of PAGES) diffPair(PNG, ['console', page, theme, vp, 'dpr1'].join('-') + '.png', badRef)
    }
  }
  for (const f of specialFiles()) diffPair(PNG, f, badRef)
  if (badRef.bad) {
    console.error('视觉回归失败：' + badRef.bad + ' / ' + badRef.total + ' 张（差异图在 __diff__）')
    return 1
  }
  console.log('✅ 视觉回归通过：' + badRef.total + ' 张（阈值 0.1%）')
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
    await captureSpecials()
    if (update) {
      fs.mkdirSync(BASELINE, { recursive: true })
      const expected = new Set()
      for (const theme of THEMES) for (const vp of VIEWPORTS) for (const page of PAGES) expected.add(['console', page, theme, vp, 'dpr1'].join('-') + '.png')
      for (const f of specialFiles()) expected.add(f)
      const ours = /^(sessions|overview|usage|stats|quota|settings|about|sourcetag)-.*\.png$/
      for (const f of fs.readdirSync(BASELINE)) {
        if (!expected.has(f) && (ours.test(f) || /^console-(overview|context|sessions|usage|stats|quota|vendors|roles|settings|about)-(light|dark)-(960x680|760x560)-dpr1\.png$/.test(f))) fs.rmSync(path.join(BASELINE, f), { force: true })
      }
      for (const f of expected) {
        const src = path.join(SHOTS, f)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(BASELINE, f))
      }
      fs.writeFileSync(
        path.join(BASELINE, 'env.json'),
        JSON.stringify({ platform: process.platform, arch: process.arch, edge: await edgeVersion(), dpr: 1, viewports: VIEWPORTS, themes: THEMES, specials: SPECIALS.length, generatedAt: new Date().toISOString() }, null, 2)
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
