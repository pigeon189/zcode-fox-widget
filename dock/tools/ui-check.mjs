#!/usr/bin/env node
// 控制台页面自检（L4 + L5 的结构部分）：
//   · 启动夹具 daemon + Edge，逐页访问
//   · 无 JS 异常、无横向滚动、最小字号 ≥12、交互元素有可访问名称
//   · axe 严重/致命违规为 0
//
//   node tools/ui-check.mjs [--theme light,dark] [--axe 0|1]
//
// 依赖 dock/test/node_modules（仅开发依赖）。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PAGES = ['overview', 'context', 'usage', 'quota', 'vendors', 'roles', 'settings', 'about']

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const themes = String(arg('--theme', 'light,dark')).split(',').filter(Boolean)
const withAxe = arg('--axe', '1') !== '0'
const port = Number(arg('--port', '39511'))
const base = 'http://127.0.0.1:' + port

async function loadPlaywright() {
  return import(pathToFileURL(path.join(ROOT, 'test', 'node_modules', '@playwright', 'test', 'index.mjs')).href)
}
async function loadAxe() {
  return import(pathToFileURL(path.join(ROOT, 'test', 'node_modules', '@axe-core', 'playwright', 'dist', 'index.mjs')).href)
}

async function waitHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(500) })
      if (r.ok) return true
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}

async function main() {
  const scene = path.join(ROOT, 'test', 'fixtures', 'scenes', 'zcode-normal.json')
  const fixture = spawn(process.execPath, [path.join(HERE, 'fixture-daemon.mjs'), '--scene', scene, '--port', String(port)], {
    stdio: 'ignore',
    windowsHide: true,
  })
  const problems = []
  try {
    if (!(await waitHealth())) throw new Error('夹具 daemon 未启动')
    const { chromium } = await loadPlaywright()
    const { AxeBuilder } = withAxe ? await loadAxe() : { AxeBuilder: null }
    const browser = await chromium.launch({ channel: 'msedge', headless: true })
    for (const theme of themes) {
      for (const page of PAGES) {
        const ctx = await browser.newContext({ viewport: { width: 960, height: 680 }, colorScheme: theme, reducedMotion: 'reduce' })
        const p = await ctx.newPage()
        const errors = []
        p.on('pageerror', (e) => errors.push(e.message))
        await p.goto(base + '/ui/console.html#' + page, { waitUntil: 'networkidle' })
        await p.evaluate((t) => {
          document.documentElement.dataset.theme = t
          document.documentElement.style.colorScheme = t
        }, theme)
        await p.waitForTimeout(350)
        if (errors.length) problems.push(page + '/' + theme + ' JS 异常：' + errors.join(' | '))

        const layout = await p.evaluate(() => {
          const out = { overflow: false, small: [], unnamed: [] }
          out.overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
          const seen = new Set()
          while (walker.nextNode()) {
            const node = walker.currentNode
            const text = String(node.textContent || '').trim()
            if (!text) continue
            const el = node.parentElement
            if (!el || seen.has(el) || el.closest('svg')) continue
            seen.add(el)
            const style = getComputedStyle(el)
            if (style.display === 'none' || style.visibility === 'hidden') continue
            const size = parseFloat(style.fontSize)
            if (size < 12) out.small.push(Math.round(size * 10) / 10 + 'px ' + el.tagName)
          }
          for (const el of document.querySelectorAll('button, [role="button"], input, select, textarea, a[href]')) {
            if (el.closest('[hidden]')) continue
            const name =
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              (el.textContent || '').trim() ||
              el.getAttribute('placeholder') ||
              (el.labels && el.labels[0] && el.labels[0].textContent) ||
              ''
            if (!String(name).trim()) out.unnamed.push(el.tagName + (el.id ? '#' + el.id : ''))
          }
          return out
        })
        if (layout.overflow) problems.push(page + '/' + theme + ' 出现横向滚动')
        if (layout.small.length) problems.push(page + '/' + theme + ' 字号 <12：' + layout.small.slice(0, 4).join(', '))
        if (layout.unnamed.length) problems.push(page + '/' + theme + ' 无可访问名称：' + layout.unnamed.slice(0, 4).join(', '))

        if (AxeBuilder) {
          const result = await new AxeBuilder({ page: p }).analyze()
          const bad = result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
          if (bad.length) problems.push(page + '/' + theme + ' axe：' + bad.map((v) => v.id + '(' + v.nodes.length + ')').join(', '))
        }
        await ctx.close()
      }
    }
    await browser.close()
  } finally {
    try {
      fixture.kill()
    } catch (err) {}
  }

  if (problems.length) {
    for (const p of problems) console.error('✗ ' + p)
    console.error('UI 自检失败：' + problems.length + ' 项')
    process.exit(1)
  }
  console.log('UI 自检通过：' + PAGES.length + ' 页 × ' + themes.length + ' 主题（布局 / 可访问名称 / axe' + (withAxe ? '' : ' 已关闭') + '）')
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
