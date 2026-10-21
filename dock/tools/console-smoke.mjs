#!/usr/bin/env node
// 控制台 Electron 真窗口冒烟（L6 的最小集合）：
//   · 启动夹具 daemon
//   · 用自管/已装 Electron 启动 console（remote debugging）
//   · CDP 连上后断言页面加载、无 pageerror、关键文本存在
//   · 截图到 test/visual/__shots__/console-electron.png
//
//   node tools/console-smoke.mjs
//
// 注意：当前 agent 会话可能带 ELECTRON_RUN_AS_NODE=1，启动时必须清掉，
// 否则 Electron 会按 Node 运行并立刻退出。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveRuntime } from '../daemon/src/runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PORT = Number(process.env.FOX_DOCK_SMOKE_PORT || 39521)
const CDP = Number(process.env.FOX_DOCK_SMOKE_CDP || 9231)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) })
      if (r.ok) return true
    } catch (err) {}
    await sleep(120)
  }
  return false
}

async function main() {
  const electron = resolveRuntime().path
  if (!electron) throw new Error('找不到 Electron 运行时（fox-dock runtime install 或 FOX_DOCK_ELECTRON）')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-console-smoke-'))
  const fixture = spawn(
    process.execPath,
    [path.join(HERE, 'fixture-daemon.mjs'), '--scene', path.join(ROOT, 'test', 'fixtures', 'scenes', 'zcode-normal.json'), '--port', String(PORT)],
    { stdio: 'ignore', windowsHide: true }
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  const con = spawn(
    electron,
    [path.join(ROOT, 'console'), '--daemon-port=' + PORT, '--data-dir=' + dir, '--remote-debugging-port=' + CDP, '--no-sandbox'],
    { stdio: 'ignore', windowsHide: true, env }
  )
  let failed = null
  try {
    if (!(await waitHttp('http://127.0.0.1:' + PORT + '/health', 8000))) throw new Error('夹具 daemon 未启动')
    if (!(await waitHttp('http://127.0.0.1:' + CDP + '/json/version', 12000))) throw new Error('控制台窗口未启动（CDP 不可达）')
    const { chromium } = await import(
      pathToFileURL(path.join(ROOT, 'test', 'node_modules', '@playwright', 'test', 'index.mjs')).href
    )
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + CDP)
    const pages = browser.contexts().flatMap((c) => c.pages())
    const page = pages.find((p) => p.url().includes('console.html'))
    if (!page) throw new Error('找不到控制台页面')
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForTimeout(1200)
    const text = await page.locator('body').innerText()
    for (const needle of ['fox-dock 控制台', '总览', '上下文', '厂商与密钥', '已连接']) {
      if (!text.includes(needle)) throw new Error('页面缺少文本：' + needle)
    }
    if (errors.length) throw new Error('页面 JS 异常：' + errors.join(' | '))
    fs.mkdirSync(path.join(ROOT, 'test', 'visual', '__shots__'), { recursive: true })
    await page.screenshot({ path: path.join(ROOT, 'test', 'visual', '__shots__', 'console-electron.png') })

    await page.getByTestId('nav.stats').click()
    await page.waitForTimeout(1200)
    const statsText = await page.locator('body').innerText()
    for (const needle of ['累计 Token', 'Token 活动', '每日 Token 趋势', '模型用量', '工具用量']) {
      if (!statsText.includes(needle)) throw new Error('统计页缺少文本：' + needle)
    }
    if (errors.length) throw new Error('统计页 JS 异常：' + errors.join(' | '))
    await page.screenshot({ path: path.join(ROOT, 'test', 'visual', '__shots__', 'console-stats-electron.png') })
    await page.locator('#content').evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(ROOT, 'test', 'visual', '__shots__', 'console-stats-bottom.png') })
    await browser.close()
  } catch (err) {
    failed = err
  } finally {
    try {
      con.kill()
    } catch (err) {}
    try {
      fixture.kill()
    } catch (err) {}
    await sleep(300)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {}
  }
  if (failed) {
    console.error('✗ 控制台真窗口冒烟失败：' + String(failed.message || failed))
    process.exit(1)
  }
  console.log('✅ 控制台真窗口冒烟通过（页面加载 / 无 JS 异常 / 关键文本 / 截图）')
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
