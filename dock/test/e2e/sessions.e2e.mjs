// 页面 E2E（Playwright + 夹具 daemon）：会话页导航 / 详情标签 / 状态筛选 / 重定向
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PORT = Number(process.env.FOX_DOCK_E2E_PORT || 39711)
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

async function newPage(hash) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(BASE + '/ui/console.html#' + hash, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  return { ctx, p, errors }
}

// 自绘 DatePicker（ui/components/base.mjs）：点触发按钮，必要时翻月，再点目标日期格。
// 原生 input[type=date] 已被替换，不能再 fill。
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
  assert.ok((await target.count()) > 0, '日期 ' + dayKey + ' 不在可选窗口内')
  await target.click()
}

test('e2e: 会话列表与详情标签', async () => {
  const { ctx, p, errors } = await newPage('sessions')
  try {
    await p.waitForSelector('.sess-row', { timeout: 10000 })
    assert.ok((await p.locator('.sess-row').count()) >= 5)
    await p.getByText('重构 billing 适配器').first().click()
    await p.waitForTimeout(300)
    assert.match(await p.locator('.sess-detail').innerText(), /重构 billing 适配器/)
    await p.getByRole('tab', { name: '上下文' }).click()
    await p.waitForTimeout(500)
    assert.match(await p.locator('.sess-detail').innerText(), /当前占用/)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 状态计数条筛选', async () => {
  const { ctx, p } = await newPage('sessions')
  try {
    await p.waitForSelector('.sess-row', { timeout: 10000 })
    await p.getByRole('button', { name: /等待确认/ }).first().click()
    await p.waitForTimeout(400)
    const count = await p.locator('.sess-row').count()
    assert.equal(count, 1)
  } finally {
    await ctx.close()
  }
})

test('e2e: #context 重定向到会话页上下文标签', async () => {
  const { ctx, p } = await newPage('context')
  try {
    await p.waitForSelector('.sess-row', { timeout: 10000 })
    const hash = await p.evaluate(() => location.hash)
    assert.match(hash, /^#sessions\?/)
    assert.match(hash, /tab=context/)
  } finally {
    await ctx.close()
  }
})

async function switchScene(name) {
  const r = await fetch(BASE + '/__fixture/scene', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  assert.equal(r.ok, true, 'switch scene failed: ' + name)
}

async function fixtureCalls() {
  const r = await fetch(BASE + '/__fixture/calls')
  return (await r.json()).calls || []
}

test('e2e: 键盘 ↑↓ + Enter 切换选中会话', async () => {
  await switchScene('sessions-live')
  const { ctx, p } = await newPage('sessions')
  try {
    await p.waitForSelector('.sess-row', { timeout: 10000 })
    const before = await p.evaluate(() => location.hash)
    await p.locator('.sess-scroll').focus()
    await p.keyboard.press('ArrowDown')
    await p.keyboard.press('Enter')
    await p.waitForTimeout(300)
    const after = await p.evaluate(() => location.hash)
    assert.notEqual(after, before)
    assert.match(after, /select=/)
  } finally {
    await ctx.close()
  }
})

test('e2e: 子任务展开与「子任务出错」徽标', async () => {
  await switchScene('sessions-live')
  const { ctx, p } = await newPage('sessions')
  try {
    await p.waitForSelector('.sess-row', { timeout: 10000 })
    const before = await p.locator('.sess-row').count()
    assert.ok(await p.getByText('1 个子任务出错').first().isVisible())
    await p.getByRole('button', { name: '展开子任务' }).first().click()
    await p.waitForTimeout(250)
    assert.ok((await p.locator('.sess-row').count()) > before)
    await p.getByRole('button', { name: '折叠子任务' }).first().click()
    await p.waitForTimeout(200)
    assert.equal(await p.locator('.sess-row').count(), before)
  } finally {
    await ctx.close()
  }
})

test('e2e: SSE 推 session upsert 后列表即时出现', async () => {
  await switchScene('sessions-live')
  const { ctx, p } = await newPage('sessions')
  try {
    await p.waitForSelector('.sess-row', { timeout: 10000 })
    await fetch(BASE + '/__fixture/emit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'session',
        data: {
          op: 'upsert',
          session: {
            key: 'zcode:ses_sse',
            agentId: 'zcode',
            sessionId: 'ses_sse',
            parentKey: null,
            title: 'SSE 实时新会话',
            cwd: 'D:\proj',
            model: 'deepseek-flash',
            provider: 'deepseek',
            status: 'working',
            statusSince: Date.now(),
            statusSource: 'ingest',
            startedAt: Date.now() - 1000,
            updatedAt: Date.now(),
            turns: { count: 1 },
            tokens: { total: 1000 },
            cost: { amount: 0.01, currency: 'CNY', unit: 'money' },
            tools: { calls: 1, errors: 0, running: [] },
            errors: { model: 0, tool: 0, last: null },
            pending: [],
            provenance: {
              tokens: { kind: 'exact', origin: 'local-log', source: 'ingest', asOf: Date.now() },
              cost: { kind: 'estimated', origin: 'pricing-table', source: 'pricing', asOf: Date.now() },
              status: { kind: 'exact', origin: 'local-log', source: 'ingest', asOf: Date.now() },
              tools: { kind: 'exact', origin: 'local-log', source: 'ingest', asOf: Date.now() },
            },
          },
        },
      }),
    })
    await p.waitForTimeout(900)
    assert.ok(await p.getByText('SSE 实时新会话').first().isVisible())
  } finally {
    await ctx.close()
  }
})

function mockSession(i, archived = false) {
  const t = 1792399900000 - i * 60000
  return {
    key: 'mock:ses_' + i,
    agentId: 'zcode',
    sessionId: 'ses_' + i,
    parentKey: null,
    title: (archived ? '已归档' : '活跃') + '会话 ' + String(i).padStart(2, '0'),
    cwd: 'D:/work/project-' + i,
    model: 'deepseek-v4.1-flash',
    provider: 'deepseek',
    status: 'done',
    statusSince: t,
    statusSource: 'db',
    startedAt: t - 600000,
    updatedAt: t,
    endedAt: t,
    archived,
    turns: { count: i + 1 },
    tokens: { total: 1000 + i },
    cost: { amount: 0.01, currency: 'CNY', unit: 'money' },
    tools: { calls: 2, errors: 0, running: [] },
    errors: { model: 0, tool: 0, last: null },
    pending: [],
    provenance: {
      tokens: { kind: 'exact', origin: 'local-db', source: 'mock', asOf: t },
      cost: { kind: 'estimated', origin: 'pricing-table', source: 'mock', asOf: t },
      status: { kind: 'exact', origin: 'local-db', source: 'mock', asOf: t },
      tools: { kind: 'exact', origin: 'local-db', source: 'mock', asOf: t },
    },
  }
}

// 夹具 daemon 暂不实现 cursor；用 route 拦截只验证 UI 分页契约。
function mockListHandler(rows) {
  return async (route) => {
    const req = route.request()
    const u = new URL(req.url())
    if (req.method() !== 'GET' || u.pathname !== '/v1/sessions') return route.continue()
    const limit = Math.max(1, Math.min(200, Number(u.searchParams.get('limit') || 50) || 50))
    const archived = u.searchParams.get('archived') || 'exclude'
    const status = u.searchParams.get('status') || ''
    const q = (u.searchParams.get('q') || '').toLowerCase()
    let list = rows.filter((s) => (archived === 'all' ? true : archived === 'only' ? s.archived : !s.archived))
    if (status) list = list.filter((s) => s.status === status)
    if (q) list = list.filter((s) => s.title.toLowerCase().includes(q))
    list = list.slice().sort((a, b) => b.updatedAt - a.updatedAt)
    const cur = u.searchParams.get('cursor') || ''
    const offset = /^o:(\d+)$/.test(cur) ? Number(cur.slice(2)) : 0
    const page = list.slice(offset, offset + limit)
    const next = offset + page.length
    const counts = { working: 0, waiting: 0, waiting_permission: 0, error: 0, done: list.length, idle: 0 }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        items: page,
        nextCursor: next < list.length ? 'o:' + next : null,
        total: list.length,
        rootTotal: list.length,
        shownRoots: page.length,
        truncated: false,
        counts,
        aggregate: 'done',
      }),
    })
  }
}

test('e2e: 每页 25 条 + 加载更多 + 归档筛选 + 滚动不跳', async () => {
  const rows = []
  for (let i = 0; i < 55; i++) rows.push(mockSession(i, false))
  for (let i = 0; i < 5; i++) rows.push(mockSession(100 + i, true))
  const ctx = await browser.newContext({ viewport: { width: 960, height: 680 }, reducedMotion: 'reduce' })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.route('**/v1/sessions*', mockListHandler(rows))
  try {
    await p.goto(BASE + '/ui/console.html#sessions', { waitUntil: 'networkidle' })
    await p.waitForSelector('.sess-row', { timeout: 10000 })
    assert.equal(await p.locator('.sess-row').count(), 25, 'first page')
    const more = p.locator('[data-testid="sessions.loadMore"]')
    assert.ok(await more.isVisible(), 'load more should be visible')

    // 960 默认窗口：列表占满内容宽度，详情在下方（不再留右侧空栏）。
    const listBox = await p.locator('[data-testid="sessions.list"]').boundingBox()
    const detailBox = await p.locator('.sess-detail').boundingBox()
    assert.ok(detailBox.y >= listBox.y + listBox.height - 2, 'detail should stack below list')
    const titleWidth = await p.locator('.sess-table .sess-title-cell').first().evaluate((el) => el.getBoundingClientRect().width)
    assert.ok(titleWidth >= 280, 'title column width=' + titleWidth)

    const scroller = p.locator('.sess-scroll')
    await scroller.evaluate((el) => {
      el.scrollTop = Math.round(el.scrollHeight * 0.4)
    })
    const scrollBefore = await scroller.evaluate((el) => el.scrollTop)
    assert.ok(scrollBefore > 0)

    // SSE 事件只在顶部重取；滚动后只更新计数，不能把列表拽回顶部/末尾。
    await fetch(BASE + '/__fixture/emit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'session', data: { op: 'upsert', session: mockSession(999, false) } }),
    })
    await p.waitForTimeout(800)
    assert.equal(await p.locator('.sess-row').count(), 25)
    assert.equal(await scroller.evaluate((el) => el.scrollTop), scrollBefore)

    await more.click()
    await p.waitForFunction(() => document.querySelectorAll('.sess-row').length === 50, null, { timeout: 5000 })
    assert.ok((await scroller.evaluate((el) => el.scrollTop)) >= scrollBefore - 1, 'scroll preserved on append')
    assert.equal(await p.locator('.sess-table tbody tr[aria-hidden="true"]').count(), 0, 'no spacer rows')
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true)

    // 归档筛选重置分页，只显示已归档。
    await p.getByRole('combobox', { name: '归档筛选' }).click()
    await p.getByRole('option', { name: '已归档' }).click()
    await p.waitForFunction(() => document.querySelectorAll('.sess-row').length === 5, null, { timeout: 5000 })
    assert.equal(await p.locator('[data-testid="sessions.loadMore"]').count(), 0)
    assert.equal(await p.locator('[data-testid="sessions.list"] .small.muted').first().innerText(), '共 5 个 · 已显示 5 个')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 2000 条场景只加载一页，滚动不再跳到末尾', async () => {
  await switchScene('sessions-many')
  const { ctx, p } = await newPage('sessions')
  try {
    await p.waitForSelector('.sess-row', { timeout: 15000 })
    const count = await p.locator('.sess-row').count()
    assert.ok(count > 0 && count <= 25, 'page rows=' + count)
    const scroller = p.locator('.sess-scroll')
    await scroller.hover()
    await p.mouse.wheel(0, 500)
    await p.mouse.wheel(0, 500)
    await p.waitForTimeout(400)
    const pos = await scroller.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }))
    assert.ok(pos.top > 0, 'wheel should scroll the list')
    assert.ok(pos.top < pos.max, 'should not be pinned to the end after two wheels')
    assert.equal(await p.locator('.sess-table tbody tr[aria-hidden="true"]').count(), 0)
  } finally {
    await ctx.close()
  }
})

test('e2e: 跳转宿主窗口发出 focus 请求', async () => {
  await switchScene('permission-pending')
  const { ctx, p } = await newPage('sessions')
  try {
    await p.waitForSelector('.banner-warn', { timeout: 10000 })
    await p.getByRole('button', { name: '去宿主处理' }).click()
    await p.waitForTimeout(500)
    const calls = await fixtureCalls()
    assert.ok(calls.some((c) => c.method === 'POST' && /\/focus$/.test(c.path)), JSON.stringify(calls.slice(-3)))
  } finally {
    await ctx.close()
  }
})

test('e2e: 权限横幅（高风险不显示允许一次）', async () => {
  await switchScene('permission-high-risk')
  const { ctx, p } = await newPage('sessions')
  try {
    await p.waitForSelector('.banner-warn', { timeout: 10000 })
    assert.match(await p.locator('.banner-warn').innerText(), /1 个权限请求等待处理/)
    assert.equal(await p.getByRole('button', { name: '允许一次' }).count(), 0)
  } finally {
    await ctx.close()
  }
})

test('e2e: 自定义范围非法时不发查询请求', async () => {
  await switchScene('usage-compare')
  const { ctx, p } = await newPage('usage')
  try {
    await p.waitForSelector('[data-testid="page.usage"]', { timeout: 10000 })
    await p.getByRole('tab', { name: '自定义' }).click()
    await p.waitForTimeout(500)
    const before = (await fixtureCalls()).filter((c) => c.method === 'GET' && c.path === '/v1/usage/breakdown').length
    await pickDate(p, '开始日期', '2026-10-22')
    await pickDate(p, '结束日期', '2026-10-01')
    await p.getByRole('button', { name: '应用' }).click()
    await p.waitForTimeout(500)
    assert.ok(await p.locator('.range-error').isVisible())
    const after = (await fixtureCalls()).filter((c) => c.method === 'GET' && c.path === '/v1/usage/breakdown').length
    assert.equal(after, before)
  } finally {
    await ctx.close()
  }
})

test('e2e: 下钻切到按工具显示调用次数而不是金额 0', async () => {
  await switchScene('usage-breakdown-tool')
  const { ctx, p } = await newPage('usage')
  try {
    await p.waitForSelector('[data-testid="page.usage"]', { timeout: 10000 })
    await p.getByRole('tab', { name: '按工具' }).click()
    await p.waitForTimeout(500)
    const text = await p.locator('[data-testid="page.usage"]').innerText()
    assert.match(text, /总调用/)
    assert.match(text, /Bash/)
  } finally {
    await ctx.close()
  }
})

test('e2e: 设置「会话与权限」改动立即 PUT', async () => {
  await switchScene('settings-live-perm')
  const { ctx, p } = await newPage('settings')
  try {
    await p.waitForSelector('[data-testid="page.settings"]', { timeout: 10000 })
    await p.getByRole('button', { name: '会话与权限' }).click()
    await p.waitForTimeout(300)
    const box = p.locator('#live input[type="checkbox"]').first()
    assert.ok(await box.count())
    await box.click({ force: true })
    await p.waitForTimeout(400)
    const calls = await fixtureCalls()
    assert.ok(calls.some((c) => c.method === 'PUT' && c.path === '/v1/settings'), JSON.stringify(calls.slice(-3)))
  } finally {
    await ctx.close()
  }
})

test('e2e: CSV/JSON 导出（BOM、表头、JSON 元信息）', async () => {
  await switchScene('usage-compare')
  const { ctx, p } = await newPage('usage')
  try {
    await p.waitForSelector('[data-testid="page.usage"]', { timeout: 10000 })
    const [csvDownload] = await Promise.all([
      p.waitForEvent('download'),
      p.getByRole('button', { name: 'CSV' }).click(),
    ])
    const csvPath = await csvDownload.path()
    const csv = fs.readFileSync(csvPath)
    assert.equal(csv[0], 0xef)
    assert.equal(csv[1], 0xbb)
    assert.equal(csv[2], 0xbf)
    const text = csv.toString('utf8')
    assert.match(text, /date,agent,session,model,vendor,tool,unit,currency,amount,credits,tokens,calls,errors,provenance_kind,provenance_origin,provenance_source/)
    const [jsonDownload] = await Promise.all([
      p.waitForEvent('download'),
      p.getByRole('button', { name: 'JSON' }).click(),
    ])
    const json = JSON.parse(fs.readFileSync(await jsonDownload.path(), 'utf8'))
    assert.ok(json.meta && json.meta.generatedAt)
    assert.ok(Array.isArray(json.rows) && json.rows.length > 0)
    assert.ok(json.meta.notes.some((n) => n.includes('估算')))
  } finally {
    await ctx.close()
  }
})

test('e2e: 热力图读数固定在点阵外，每周/累计日期不拆行', async () => {
  await switchScene('zcode-normal')
  const { ctx, p, errors } = await newPage('stats')
  try {
    await p.waitForSelector('.heatmap', { timeout: 10000 })
    await p.getByRole('tab', { name: '每周' }).click()
    await p.waitForTimeout(300)
    await p.locator('.heatmap-weeks .heatmap-cell.level-4').first().hover()
    const readout = p.locator('[data-testid="stats.heatmapReadout"]')
    assert.match(await readout.innerText(), /当周/)
    assert.match(await readout.innerText(), /tokens/)
    const geometry = await p.evaluate(() => {
      const r = document.querySelector('[data-testid="stats.heatmapReadout"]').getBoundingClientRect()
      const grid = document.querySelector('.heatmap-weeks').getBoundingClientRect()
      const head = document.querySelector('.hm-head')
      const h = head.getBoundingClientRect()
      return { readoutBottom: r.bottom, gridTop: grid.top, headHeight: h.height, headWidth: head.scrollWidth, headClient: head.clientWidth }
    })
    assert.ok(geometry.readoutBottom <= geometry.gridTop + 1, 'readout must not overlap the heat grid')
    assert.ok(geometry.headHeight < 24, 'date head should stay on one line')
    assert.ok(geometry.headWidth <= geometry.headClient + 1, 'date head must not overflow')
    assert.equal(await p.locator('.chart-tip.heatmap-tip').count(), 0)

    await p.getByRole('tab', { name: '累计' }).click()
    await p.waitForTimeout(300)
    await p.locator('.heatmap-weeks .heatmap-cell.level-4').first().hover()
    assert.match(await readout.innerText(), /截至/)
    assert.match(await readout.innerText(), /当周累计/)
    const height = await p.locator('.hm-head').evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(height < 24, 'cumulative head should stay on one line')
    assert.equal(errors.length, 0, errors.join(' | '))

    // 暗色 + 960 默认窗口下同样不能遮住点阵。
    const dark = await browser.newContext({ viewport: { width: 960, height: 680 }, colorScheme: 'dark', reducedMotion: 'reduce' })
    const dp = await dark.newPage()
    try {
      await dp.goto(BASE + '/ui/console.html#stats', { waitUntil: 'networkidle' })
      await dp.waitForSelector('.heatmap-cell', { timeout: 10000 })
      await dp.getByRole('tab', { name: '每周' }).click()
      await dp.waitForTimeout(300)
      await dp.locator('.heatmap-weeks .heatmap-cell.level-4').first().hover()
      assert.match(await dp.locator('[data-testid="stats.heatmapReadout"]').innerText(), /当周/)
      const gap = await dp.evaluate(() => {
        const r = document.querySelector('[data-testid="stats.heatmapReadout"]').getBoundingClientRect()
        return r.bottom - document.querySelector('.heatmap-weeks').getBoundingClientRect().top
      })
      assert.ok(gap <= 1, 'dark readout overlaps grid: ' + gap)
    } finally {
      await dark.close()
    }
  } finally {
    await ctx.close()
  }
})

test('e2e: 深色主题下会话页与用量页可用', async () => {
  await switchScene('sessions-live')
  const darkCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce', acceptDownloads: true })
  const p = await darkCtx.newPage()
  try {
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(BASE + '/ui/console.html#sessions', { waitUntil: 'networkidle' })
    await p.waitForSelector('.sess-row', { timeout: 10000 })
    assert.equal(errors.length, 0, errors.join(' | '))
    await p.locator('[data-testid="nav.usage"]').click()
    await p.waitForTimeout(700)
    assert.ok(await p.getByText('总成本').first().isVisible())
  } finally {
    await darkCtx.close()
  }
})
