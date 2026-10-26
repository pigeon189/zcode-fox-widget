// 会话页展示状态（D056）：已完成 5 分钟窗口、计数/筛选同源、UI 只信 displayStatus
// （不会因为机器状态还挂在 working 就永远显示工作中），权限超时文案不得串到会话状态。
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PORT = Number(process.env.FOX_DOCK_SESS_E2E_PORT || 39714)
const BASE = 'http://127.0.0.1:' + PORT
let fixture = null
let browser = null

async function waitHealth(timeoutMs = 10000) {
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

before(async () => {
  fixture = spawn(
    process.execPath,
    [path.join(ROOT, 'tools', 'fixture-daemon.mjs'), '--scene', path.join(ROOT, 'test', 'fixtures', 'scenes', 'zcode-normal.json'), '--port', String(PORT)],
    { stdio: 'ignore', windowsHide: true }
  )
  assert.ok(await waitHealth(), 'fixture daemon did not start')
  const pw = await import(pathToFileURL(path.join(ROOT, 'test', 'node_modules', '@playwright', 'test', 'index.mjs')).href)
  browser = await pw.chromium.launch({ channel: 'msedge', headless: true })
})

after(async () => {
  try {
    if (browser) await browser.close()
  } catch (err) {}
  try {
    if (fixture) fixture.kill()
  } catch (err) {}
})

function item(id, title, status, displayStatus, updatedAt) {
  return {
    key: 'zcode:' + id,
    agentId: 'zcode',
    sessionId: id,
    title,
    cwd: 'E:/WorkSpace/fox-dock',
    model: 'deepseek-v4.1-flash',
    status,
    displayStatus,
    statusSource: 'db',
    statusSince: updatedAt,
    updatedAt,
    startedAt: updatedAt - 60_000,
    endedAt: displayStatus === 'done' ? updatedAt : null,
    doneAt: displayStatus === 'done' ? updatedAt : null,
    archived: false,
    turns: { count: 1, current: null, avgDurationMs: 1000 },
    tokens: { total: 12_345 },
    cost: null,
    costMarket: null,
    tools: { calls: 0, errors: 0, running: [] },
    errors: { model: 0, tool: 0, last: null },
    pending: [],
  }
}

test('e2e: 会话页按 displayStatus 显示已完成/工作中/空闲，计数与筛选同源', async () => {
  const now = Date.now()
  const items = [
    item('done', '刚完成的会话', 'idle', 'done', now - 60_000),
    item('work', '正在工作的会话', 'working', 'working', now - 1000),
    // 机器状态还挂在 working，但服务端已经判定空闲：UI 必须信 displayStatus，
    // 否则 Stop 丢失时会永远显示「工作中」。
    item('stale', '已经空闲但机器状态还挂着 working', 'working', 'idle', now - 600_000),
  ]
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' })
  const p = await ctx.newPage()
  const errors = []
  const sessionRequests = []
  p.on('pageerror', (e) => errors.push(e.message))
  try {
    await p.route('**/v1/sessions?*', (route) => {
      sessionRequests.push(route.request().url())
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          items,
          nextCursor: null,
          total: 3,
          shownRoots: 3,
          rootTotal: 3,
          truncated: false,
          counts: { working: 1, waiting: 0, waiting_permission: 0, waiting_input: 0, error: 0, done: 1, idle: 1, unknown: 0 },
          aggregate: 'working',
          byAgent: { zcode: { working: 1, waiting: 0, error: 0, done: 1, total: 3, lastAt: now } },
        }),
      })
    })
    await p.goto(BASE + '/ui/console.html#sessions', { waitUntil: 'networkidle' })
    await p.getByTestId('page.sessions').waitFor({ timeout: 10000 })
    await p.getByTestId('sessions.row.zcode:done').waitFor({ timeout: 10000 })

    const rowDone = await p.getByTestId('sessions.row.zcode:done').innerText()
    const rowWork = await p.getByTestId('sessions.row.zcode:work').innerText()
    const rowStale = await p.getByTestId('sessions.row.zcode:stale').innerText()
    assert.match(rowDone, /已完成/, '5 分钟内的 doneAt 应显示已完成：' + rowDone)
    assert.match(rowWork, /工作中/, 'working 应显示工作中：' + rowWork)
    assert.match(rowStale, /空闲/, 'UI 必须信 displayStatus，不能停在机器状态 working：' + rowStale)
    assert.doesNotMatch(rowStale, /工作中/, '已判定空闲的会话不能显示工作中：' + rowStale)

    const doneTile = await p.getByTestId('sessions.tile.done').innerText()
    assert.match(doneTile, /已完成\s*1/, '已完成计数应与展示同源：' + doneTile)

    const body = await p.locator('body').innerText()
    assert.doesNotMatch(body, /已超时/, '权限超时文案不能出现在会话页状态里')

    // 点已完成磁贴 → 请求带 status=done（筛选与服务端同一口径）
    await p.getByTestId('sessions.tile.done').click()
    await p.waitForFunction(() => document.querySelector('[data-testid="sessions.tile.done"]').getAttribute('aria-pressed') === 'true', null, { timeout: 5000 })
    await p.waitForTimeout(300)
    assert.ok(sessionRequests.some((u) => u.includes('status=done')), '筛选请求应带 status=done：' + sessionRequests.join(' | '))
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 已完成窗口过期后服务端回落空闲，页面不残留已完成', async () => {
  const now = Date.now()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' })
  const p = await ctx.newPage()
  try {
    await p.route('**/v1/sessions?*', (route) => {
      // 同一条会话第二次请求时已经超过 5 分钟：displayStatus 变回 idle。
      const done = route.request().url().includes('status=')
      const items = [item('aged', '五分钟前完成的会话', 'idle', done ? 'idle' : 'done', now - 6 * 60_000)]
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          items,
          nextCursor: null,
          total: 1,
          shownRoots: 1,
          rootTotal: 1,
          counts: { working: 0, waiting: 0, error: 0, done: done ? 0 : 1, idle: done ? 1 : 0 },
          aggregate: done ? 'idle' : 'done',
        }),
      })
    })
    await p.goto(BASE + '/ui/console.html#sessions', { waitUntil: 'networkidle' })
    await p.getByTestId('sessions.row.zcode:aged').waitFor({ timeout: 10000 })
    assert.match(await p.getByTestId('sessions.row.zcode:aged').innerText(), /已完成/)
    await p.getByTestId('sessions.tile.done').click()
    await p.waitForTimeout(400)
    const after = await p.getByTestId('sessions.row.zcode:aged').innerText()
    assert.match(after, /空闲/, '超过 5 分钟应回落空闲：' + after)
    assert.doesNotMatch(after, /已完成/, '过期后不能残留已完成：' + after)
  } finally {
    await ctx.close()
  }
})
