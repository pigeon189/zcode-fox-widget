#!/usr/bin/env node
// 截图矩阵：按页面 × 主题 × 视口出 PNG，并生成联系表。
//
//   node tools/shots.mjs [--page gallery,console,pet] [--theme light,dark]
//                        [--viewport 960x680,760x560] [--dpr 1,1.5]
//                        [--base http://127.0.0.1:39490] [--out <dir>]
//
// 依赖 dock/test/node_modules（仅开发依赖）。浏览器用本机 Edge（channel:'msedge'），
// 不下载 Playwright 自带 Chromium。输出目录不进仓库。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const pages = list(arg('--page', 'gallery'))
const consolePages = list(arg('--console-pages', 'overview'))
const themes = list(arg('--theme', 'light,dark'))
const viewports = list(arg('--viewport', '960x680,760x560')).map((v) => {
  const m = v.match(/^(\d+)x(\d+)$/)
  if (!m) throw new Error('bad viewport: ' + v)
  return { width: Number(m[1]), height: Number(m[2]), name: m[1] + 'x' + m[2] }
})
const dprs = list(arg('--dpr', '1')).map(Number)
const base = arg('--base', '')
const outDir = path.resolve(ROOT, arg('--out', 'test/visual/__shots__'))

async function loadPlaywright() {
  const candidate = path.join(ROOT, 'test', 'node_modules', '@playwright', 'test', 'index.mjs')
  if (!fs.existsSync(candidate)) {
    throw new Error('缺少 Playwright：先执行 cd dock/test && npm install（浏览器用本机 Edge，不需要下载）')
  }
  return import(pathToFileURL(candidate).href)
}

function pageUrl(name, hash = '') {
  if (name === 'gallery') {
    return base ? base.replace(/\/$/, '') + '/ui/gallery.html' : pathToFileURL(path.join(ROOT, 'ui', 'gallery.html')).href
  }
  if (name === 'console') {
    return (base || '') + '/ui/console.html' + (hash ? '#' + hash : '')
  }
  if (name === 'pet') {
    return (base || '') + '/ui/pet.html'
  }
  throw new Error('unknown page: ' + name)
}

async function main() {
  const { chromium } = await loadPlaywright()
  fs.mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const shots = []

  for (const page of pages) {
    const variants = page === 'console' ? consolePages : ['']
    for (const variant of variants) {
      for (const theme of themes) {
        for (const vp of viewports) {
          for (const dpr of dprs) {
          const name = [page, variant, theme, vp.name, 'dpr' + dpr].filter(Boolean).join('-')
          const ctx = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: dpr,
            colorScheme: theme === 'dark' ? 'dark' : 'light',
            reducedMotion: 'reduce',
          })
          const p = await ctx.newPage()
          const url = pageUrl(page, variant)
          await p.goto(url, { waitUntil: 'networkidle' })
          // 视觉确定性：主题由页面读取 localStorage/query，这里显式写主题类。
          await p.evaluate((t) => {
            document.documentElement.dataset.theme = t
            document.documentElement.style.colorScheme = t
          }, theme)
          await p.waitForTimeout(800)
          const file = path.join(outDir, name + '.png')
          await p.screenshot({ path: file, fullPage: false })
          shots.push({ name, page: variant ? page + '/' + variant : page, theme, viewport: vp.name, dpr, file })
          await ctx.close()
        }
      }
    }
    }
  }

  await browser.close()
  writeContactSheet(shots)
  console.log('已生成 ' + shots.length + ' 张截图：' + outDir)
  console.log('联系表：' + path.join(outDir, 'index.html'))
}

function writeContactSheet(shots) {
  const groups = new Map()
  for (const s of shots) {
    const key = s.page + ' · ' + s.theme
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }
  const sections = [...groups.entries()]
    .map(([key, list]) => {
      const cards = list
        .map(
          (s) =>
            '<figure><a href="' +
            path.basename(s.file) +
            '"><img src="' +
            path.basename(s.file) +
            '" loading="lazy" alt="' +
            s.name +
            '"></a><figcaption>' +
            s.viewport +
            ' · DPR ' +
            s.dpr +
            '</figcaption></figure>'
        )
        .join('')
      return '<section><h2>' + key + '</h2><div class="grid">' + cards + '</div></section>'
    })
    .join('\n')
  const html =
    '<!doctype html><meta charset="utf-8"><title>fox-dock 截图联系表</title>' +
    '<style>body{font:14px/1.5 "Segoe UI","Microsoft YaHei UI",sans-serif;margin:24px;background:#f6f7f9;color:#172033}' +
    'h2{font-size:16px;margin:24px 0 12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}' +
    'figure{margin:0;background:#fff;border:1px solid #e3e6eb;border-radius:8px;padding:8px}' +
    'img{width:100%;display:block;border-radius:4px}figcaption{font-size:12px;color:#66708a;margin-top:6px}</style>' +
    '<h1>fox-dock 截图联系表</h1>' +
    sections
  fs.writeFileSync(path.join(outDir, 'index.html'), html)
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
