// UI 回归：热力图格子尺寸、图表随容器宽度自适应。
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PORT = Number(process.env.FOX_DOCK_UI_E2E_PORT || 39712)
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

async function open(hash, width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, reducedMotion: 'reduce' })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(BASE + '/ui/console.html#' + hash, { waitUntil: 'networkidle' })
  await p.waitForTimeout(300)
  return { ctx, p, errors }
}

async function openRouted(hash, setup, width = 1280, waitUntil = 'networkidle') {
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, reducedMotion: 'reduce' })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await setup(p)
  await p.goto(BASE + '/ui/console.html#' + hash, { waitUntil })
  await p.waitForTimeout(300)
  return { ctx, p, errors }
}

test('e2e: 总览当前会话读 displayStatus（陈旧 working 不能冒充工作中）', async () => {
  const items = [
    {
      key: 'zcode:wait',
      agentId: 'zcode',
      sessionId: 'wait',
      title: '在等我输入的会话',
      status: 'working',
      displayStatus: 'waiting_input',
      model: 'deepseek-v4.1-flash',
      startedAt: Date.now() - 60_000,
    },
  ]
  const { ctx, p, errors } = await openRouted('overview', async (page) => {
    await page.route(/\/v1\/sessions\?/, (route) =>
      route.fulfill({
        json: { ok: true, items, counts: { working: 0, waiting_input: 1, waiting_permission: 0, idle: 0, done: 0, error: 0 }, total: 1, rootTotal: 1 },
      })
    )
  })
  try {
    await p.waitForSelector('[data-testid="overview.current-session"]', { timeout: 10000 })
    const text = await p.locator('[data-testid="overview.current-session"]').innerText()
    assert.match(text, /等待输入/, '徽标应读 displayStatus：' + text)
    assert.doesNotMatch(text, /工作中/, 'raw status=working 不能显示成工作中：' + text)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 上下文切换失败时不残留上一会话数据，并显示重试', async () => {
  const sessions = [
    { key: 'zcode:sA', agentId: 'zcode', sessionId: 'sA', title: '会话 A', status: 'idle', displayStatus: 'idle', model: 'model-A' },
    { key: 'zcode:sB', agentId: 'zcode', sessionId: 'sB', title: '会话 B', status: 'idle', displayStatus: 'idle', model: 'model-B' },
  ]
  const { ctx, p, errors } = await openRouted('sessions?select=zcode%3AsA&tab=context', async (page) => {
    await page.route(/\/v1\/sessions\?/, (route) =>
      route.fulfill({ json: { ok: true, items: sessions, counts: { idle: 2 }, total: 2, rootTotal: 2 } })
    )
    await page.route(/\/v1\/sessions\/[^/?]+$/, async (route) => {
      const key = decodeURIComponent(route.request().url().split('/v1/sessions/')[1].split('?')[0])
      const hit = sessions.find((s) => s.key === key)
      if (!hit) return route.fulfill({ status: 404, json: { ok: false } })
      return route.fulfill({ json: { ok: true, session: hit, turns: [], tools: [], models: [] } })
    })
    await page.route(/\/v1\/agents\/[^/]+\/context\?/, async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('session') === 'sA') {
        return route.fulfill({
          json: { ok: true, context: { supported: true, used: 400, limit: 1000, pct: 40, model: 'model-A', points: [], breakdown: {} } },
        })
      }
      return route.fulfill({ status: 500, json: { ok: false, error: 'boom' } })
    })
  })
  try {
    await p.waitForSelector('[data-testid="context.panel"]', { timeout: 10000 })
    await p.waitForFunction(() => (document.querySelector('[data-testid="context.panel"]') || {}).textContent.indexOf('model-A') >= 0, null, { timeout: 8000 })
    await p.evaluate(() => {
      location.hash = '#sessions?select=zcode%3AsB&tab=context'
    })
    await p.waitForFunction(() => /上下文读取失败/.test((document.querySelector('[data-testid="context.panel"]') || {}).textContent || ''), null, { timeout: 8000 })
    const text = await p.locator('[data-testid="context.panel"]').innerText()
    assert.doesNotMatch(text, /model-A|40%/, 'B 失败时不能残留 A 的数据：' + text)
    assert.match(text, /重试/)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 切换选中会话时详情面板与选中行同源，旧详情不挂在新行下（复审 R3-3）', async () => {
  const sessions = [
    { key: 'zcode:sA', agentId: 'zcode', sessionId: 'sA', title: '详情标题甲', status: 'idle', model: 'model-A' },
    { key: 'zcode:sB', agentId: 'zcode', sessionId: 'sB', title: '列表标题乙', status: 'idle', model: 'model-B' },
  ]
  const { ctx, p, errors } = await openRouted('sessions?select=zcode%3AsA', async (page) => {
    await page.route(/\/v1\/sessions\?/, (route) =>
      route.fulfill({ json: { ok: true, items: sessions, counts: { idle: 2 }, total: 2, rootTotal: 2 } })
    )
    await page.route(/\/v1\/sessions\/[^/?]+$/, async (route) => {
      const key = decodeURIComponent(route.request().url().split('/v1/sessions/')[1].split('?')[0])
      const hit = sessions.find((s) => s.key === key)
      if (!hit) return route.fulfill({ status: 404, json: { ok: false } })
      if (key === 'zcode:sB') {
        // B 的详情延迟返回：窗口期内详情面板必须显示 B 的列表行数据，
        // 不能继续渲染 A 的详情（「跳转到宿主窗口」会作用于旧会话）。
        await new Promise((r) => setTimeout(r, 1500))
      }
      // B 的详情标题与列表行刻意不同，两个数据源可区分；A 保持原标题。
      const payload = key === 'zcode:sB' ? { ...hit, title: '详情标题乙' } : hit
      return route.fulfill({ json: { ok: true, session: payload, turns: [], tools: [], models: [] } })
    })
  })
  try {
    await p.waitForSelector('[data-testid="sessions.detail"]', { timeout: 10000 })
    await p.waitForFunction(() => (document.querySelector('[data-testid="sessions.detail"]') || {}).textContent.indexOf('详情标题甲') >= 0, null, { timeout: 8000 })
    await p.evaluate(() => {
      location.hash = '#sessions?select=zcode%3AsB'
    })
    await p.waitForTimeout(400)
    const during = await p.locator('[data-testid="sessions.detail"]').innerText()
    assert.match(during, /列表标题乙/, 'B 详情未返回期间应显示 B 的列表行数据：' + during)
    assert.doesNotMatch(during, /详情标题甲|model-A/, '不能继续渲染 A 的详情：' + during)
    await p.waitForFunction(() => (document.querySelector('[data-testid="sessions.detail"]') || {}).textContent.indexOf('详情标题乙') >= 0, null, { timeout: 8000 })
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 预算逐键输入 1.25 不会被回写成 251', async () => {
  const { ctx, p, errors } = await open('settings')
  try {
    await p.waitForSelector('[data-testid="settings.budgetMoney"]', { timeout: 10000 })
    const input = p.locator('[data-testid="settings.budgetMoney"]')
    await input.click()
    await input.fill('')
    await input.pressSequentially('1.25')
    assert.equal(await input.inputValue(), '1.25', '编辑期间不能被受控回写改掉')
    const deadline = Date.now() + 5000
    let saved = null
    while (Date.now() < deadline) {
      const d = await (await fetch(BASE + '/v1/settings')).json()
      saved = d.settings && d.settings.budgetMoney
      if (Number(saved) === 1.25) break
      await p.waitForTimeout(120)
    }
    assert.equal(Number(saved), 1.25, '服务端最终预算应为 1.25，实际 ' + saved)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 积分周期只有 credits 时每日图仍画出柱形', async () => {
  const d1 = '2026-10-25'
  const d2 = '2026-10-26'
  const { ctx, p, errors } = await openRouted('usage', async (page) => {
    await page.route(/\/v1\/usage\/breakdown\?/, (route) =>
      route.fulfill({
        json: {
          ok: true,
          unit: 'credit',
          range: { days: 2, from: d1, to: d2 },
          total: { credits: 120, tokens: 0, calls: 2, errors: 0 },
          series: [
            {
              key: 'commandcode',
              label: 'CommandCode',
              tokens: 0,
              amount: null,
              credits: 120,
              calls: 2,
              errors: 0,
              byDay: [
                { d: d1, tokens: 0, amount: null, credits: 50, calls: 1 },
                { d: d2, tokens: 0, amount: null, credits: 70, calls: 1 },
              ],
            },
          ],
          provenance: {},
        },
      })
    )
  })
  try {
    await p.waitForSelector('[data-testid="usage.chart"] svg.chart', { timeout: 10000 })
    const bars = await p.locator('[data-testid="usage.chart"] svg.chart rect[fill^="var(--c"]').count()
    assert.ok(bars >= 2, '积分柱形不能为空图，实际 rect=' + bars)
    const text = await p.locator('[data-testid="usage.chart"]').innerText()
    assert.match(text, /积分/)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 日期选择器方向键移动后活动日有可见焦点', async () => {
  const { ctx, p, errors } = await open('usage')
  try {
    await p.getByRole('tab', { name: '自定义' }).click()
    await p.waitForSelector('[data-testid="usage.fromDate"]', { timeout: 5000 })
    await p.locator('[data-testid="usage.fromDate"]').click()
    await p.waitForSelector('.dp-pop', { timeout: 5000 })
    await p.locator('.dp-pop').press('ArrowRight')
    const active = await p.evaluate(() => {
      const el = document.querySelector('.dp-day.active')
      if (!el) return null
      const s = getComputedStyle(el)
      return { outline: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor }
    })
    assert.ok(active, '必须有 .dp-day.active')
    assert.notEqual(active.outline, 'none', '活动日必须有可见 outline：' + JSON.stringify(active))
    assert.notEqual(active.width, '0px')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 诊断未返回时导出按钮禁用，返回后才可用', async () => {
  let release
  const gate = new Promise((res) => {
    release = res
  })
  const { ctx, p, errors } = await openRouted('about', async (page) => {
    await page.route(/\/v1\/diag\/bundle/, async (route) => {
      await gate
      return route.fulfill({ json: { ok: true, generatedAt: new Date().toISOString(), paths: { dataDir: '~\\fox-dock' } } })
    })
  }, 1280, 'domcontentloaded')
  try {
    const btn = p.getByRole('button', { name: '导出诊断包' })
    await btn.waitFor({ timeout: 10000 })
    assert.equal(await btn.isDisabled(), true, '诊断未返回前不能导出空包')
    release()
    await p.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('导出诊断包'))
      return b && !b.disabled
    }, null, { timeout: 8000 })
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 总览待处理用服务端计数，不被前 30 条列表漏报', async () => {
  const { ctx, p, errors } = await openRouted('overview', async (page) => {
    await page.route(/\/v1\/sessions\?/, (route) =>
      route.fulfill({
        json: { ok: true, items: [], counts: { working: 0, waiting_input: 0, waiting_permission: 2, idle: 0, done: 0, error: 0 }, total: 35, rootTotal: 35 },
      })
    )
  })
  try {
    await p.waitForSelector('[data-testid="overview.pending"]', { timeout: 10000 })
    const text = await p.locator('[data-testid="overview.pending"]').innerText()
    assert.match(text, /2/, '应显示全局待处理 2：' + text)
    assert.match(text, /等待确认|待处理/)
    assert.doesNotMatch(text, /没有待处理事项/)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 长下拉键盘导航不被静止鼠标抢回焦点', async () => {
  const sets = Array.from({ length: 12 }, (_, i) => ({ id: 's' + i, name: '合成音效 ' + (i + 1), builtin: false }))
  const { ctx, p, errors } = await openRouted('roles', async (page) => {
    await page.route(/\/v1\/sounds$/, (route) => route.fulfill({ json: { ok: true, sets } }))
  })
  try {
    await p.waitForSelector('[data-testid="sounds.select"]', { timeout: 10000 })
    await p.locator('[data-testid="sounds.select"]').click()
    await p.waitForSelector('.select-pop', { timeout: 5000 })
    // 指针停在首项上，之后只用键盘：旧实现会在列表滚动时被 mouseenter 抢回。
    await p.locator('.select-pop .select-option').first().hover()
    for (let i = 0; i < 11; i++) await p.locator('.select-pop').press('ArrowDown')
    const active = p.locator('.select-option.active')
    assert.equal(await active.count(), 1)
    assert.equal((await active.innerText()).trim(), '合成音效 12', '键盘活动项不能被静止指针覆盖')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: Token 活动是填满卡片宽度的 53 周绿墙，格子为正方形', async () => {
  const { ctx, p, errors } = await open('stats')
  try {
    await p.waitForSelector('.heatmap .heatmap-cell', { timeout: 10000 })
    const data = await p.evaluate(() => {
      const host = document.querySelector('.heatmap')
      const weeks = document.querySelector('.heatmap-weeks')
      const cells = [...document.querySelectorAll('.heatmap .heatmap-cell')].map((el) => {
        const r = el.getBoundingClientRect()
        return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, cls: el.className }
      })
      const months = [...document.querySelectorAll('.heatmap .heatmap-month')].filter((el) => el.textContent.trim()).length
      return { host: host.getBoundingClientRect(), weeks: weeks.getBoundingClientRect(), cells, months }
    })
    assert.ok(data.cells.length >= 350, '应渲染约 53×7 个日格')
    for (const c of data.cells) {
      assert.ok(c.w >= 7 && c.w <= 24, '格子宽度随容器自适应：' + JSON.stringify(c))
      assert.ok(Math.abs(c.w - c.h) <= 1, '格子必须是正方形：' + JSON.stringify(c))
      assert.ok(!/(^|\s)empty(\s|$)/.test(c.cls), '格子不能带全局 .empty 空态类：' + c.cls)
    }
    assert.ok(Math.abs(data.weeks.right - data.host.right) <= 3, '活动墙应填满卡片宽度')
    assert.ok(data.months >= 6, '53 周应标出月份刻度')
    const active = p.locator('.heatmap-weeks .heatmap-cell:not(.level-0)').first()
    await active.hover()
    await p.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="stats.heatmapReadout"]')
        return !!(el && /tokens/.test(el.textContent || ''))
      },
      null,
      { timeout: 3000 }
    )
    assert.match(await p.locator('[data-testid="stats.heatmapReadout"]').innerText(), /tokens/, '格子 hover 应显示明细读数')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 近 7 天柱图 viewBox 跟随容器宽度，字号不缩放', async () => {
  const { ctx, p, errors } = await open('overview')
  try {
    await p.waitForSelector('[data-testid="overview.week"] .chart-wrap svg.chart', { timeout: 10000 })
    const read = () =>
      p.$eval('[data-testid="overview.week"] .chart-wrap', (wrap) => {
        const svg = wrap.querySelector('svg.chart')
        const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number)
        const label = svg.querySelector('text')
        return {
          wrap: Math.round(wrap.getBoundingClientRect().width),
          vb: Math.round(vb[2] || 0),
          font: label ? getComputedStyle(label).fontSize : '',
        }
      })
    const wide = await read()
    assert.ok(Math.abs(wide.wrap - wide.vb) <= 2, '宽窗口 viewBox 应等于容器宽度：' + JSON.stringify(wide))
    assert.equal(wide.font, '12px')

    await p.setViewportSize({ width: 900, height: 820 })
    await p.waitForTimeout(400)
    const narrow = await read()
    assert.ok(narrow.wrap < wide.wrap, '窄窗口容器应变窄')
    assert.ok(Math.abs(narrow.wrap - narrow.vb) <= 2, '窄窗口 viewBox 仍应等于容器宽度：' + JSON.stringify(narrow))
    assert.equal(narrow.font, '12px', '字号不能被 viewBox 缩放')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 控制台已打开时 hash 变化会切换页面（桌宠会话直达）', async () => {
  const { ctx, p, errors } = await open('stats')
  try {
    await p.waitForSelector('[data-testid="page.stats"]', { timeout: 10000 })
    await p.evaluate(() => {
      location.hash = '#sessions?tab=context'
    })
    await p.waitForSelector('[data-testid="page.sessions"]', { timeout: 5000 })
    assert.equal(await p.locator('[data-testid="page.stats"]').count(), 0, '统计页应已卸载')
    assert.match(await p.evaluate(() => location.hash), /^#sessions/)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 长区间图表 x 轴日期标签不重叠（760 宽）', async () => {
  const { ctx, p, errors } = await open('stats', 760)
  try {
    await p.waitForSelector('[data-testid="page.stats"] svg.chart', { timeout: 10000 })
    const groups = await p.$$eval('[data-testid="page.stats"] svg.chart', (svgs) =>
      svgs.map((svg) =>
        [...svg.querySelectorAll('text')]
          .filter((t) => /^\d{2}[-/]\d{2}$/.test((t.textContent || '').trim()))
          .map((t) => {
            const r = t.getBoundingClientRect()
            return { left: r.left, right: r.right, text: t.textContent.trim() }
          })
          .sort((a, b) => a.left - b.left)
      )
    )
    for (const labels of groups) {
      for (let i = 1; i < labels.length; i++) {
        const overlap = labels[i - 1].right - labels[i].left
        assert.ok(overlap <= 1, '日期标签重叠 ' + overlap.toFixed(1) + 'px：' + labels[i - 1].text + ' / ' + labels[i].text)
      }
    }
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 页面切换复用 GET 缓存，刷新按钮才重新请求', async () => {
  const { ctx, p, errors } = await open('stats')
  try {
    const statsReqs = []
    p.on('request', (r) => {
      if (/\/v1\/agents\/[^/]+\/stats/.test(r.url())) statsReqs.push(r.url())
    })
    await p.reload({ waitUntil: 'networkidle' })
    await p.waitForSelector('.heatmap-cell', { timeout: 10000 })
    const first = statsReqs.length
    assert.ok(first >= 1)
    await p.locator('[data-testid="nav.overview"]').click()
    await p.waitForSelector('[data-testid="page.overview"]')
    await p.locator('[data-testid="nav.stats"]').click()
    await p.waitForSelector('.heatmap-cell')
    await p.waitForTimeout(300)
    assert.equal(statsReqs.length, first, '返回统计页不应重新抓取')
    // 页面内刷新按钮必须带 force=1 穿透缓存
    await p.getByRole('button', { name: '刷新' }).last().click()
    await p.waitForTimeout(400)
    assert.ok(statsReqs.length > first, '刷新按钮应重新请求')
    assert.match(statsReqs.at(-1), /force=1/)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 总览与用量柱图 hover 有虚线对齐和明细气泡', async () => {
  const { ctx, p, errors } = await open('overview')
  try {
    const hover = async (card) => {
      await p.waitForSelector(card + ' .chart-wrap svg.chart', { timeout: 10000 })
      const slot = p.locator(card + ' svg.chart rect[fill="transparent"]').first()
      await slot.hover()
      await p.waitForSelector(card + ' .chart-tip', { timeout: 3000 })
      const text = await p.locator(card + ' .chart-tip').innerText()
      assert.ok(text.length > 0, 'tooltip should have content')
      assert.match(text, /[¥$]/, 'tooltip should show amount: ' + text)
      const dashes = await p.locator(card + ' svg.chart line[stroke-dasharray="3 3"]').count()
      assert.ok(dashes > 0, 'hover should draw dashed guide')
    }
    await hover('[data-testid="overview.week"]')
    await p.locator('[data-testid="nav.usage"]').click()
    await p.waitForSelector('[data-testid="page.usage"]')
    await hover('[data-testid="usage.chart"]')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 总览/用量隐藏无效的 agent 视角切换，统计仍保留', async () => {
  const { ctx, p, errors } = await open('overview')
  try {
    await p.waitForSelector('[data-testid="page.overview"]', { timeout: 10000 })
    assert.equal(await p.getByText('跟随角色', { exact: true }).count(), 0, '总览是四 agent 合并视图，不应显示视角切换')
    assert.ok((await p.locator('[data-testid="overview.today-cost"] svg.chart text').count()) >= 3, '今日成本折线应有坐标轴文字')
    await p.locator('[data-testid="nav.usage"]').click()
    await p.waitForSelector('[data-testid="page.usage"]')
    assert.equal(await p.getByText('跟随角色', { exact: true }).count(), 0, '用量不应显示视角切换')
    await p.locator('[data-testid="nav.stats"]').click()
    await p.waitForSelector('[data-testid="page.stats"]')
    assert.equal(await p.getByText('跟随角色', { exact: true }).count(), 1, '统计按宿主取数，保留视角切换')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: Token 活动支持每日/每周/累计且气泡文案对应', async () => {
  const { ctx, p, errors } = await open('stats')
  try {
    await p.waitForSelector('.heatmap-week .heatmap-cell:not(.level-0)', { timeout: 10000 })
    const hoverFirst = async () => {
      await p.locator('.heatmap-weeks .heatmap-cell:not(.level-0)').first().hover()
      await p.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="stats.heatmapReadout"]')
          return !!(el && /tokens/.test(el.textContent || ''))
        },
        null,
        { timeout: 3000 }
      )
      return (await p.locator('[data-testid="stats.heatmapReadout"]').innerText()).replace(/\s+/g, ' ')
    }
    assert.match(await hoverFirst(), /tokens/)
    await p.getByRole('tab', { name: '每周' }).click()
    await p.waitForTimeout(200)
    assert.ok((await p.locator('.heatmap-weeks .heatmap-cell').count()) <= 53, '每周模式每列一个格子')
    assert.match(await hoverFirst(), /当周/)
    await p.getByRole('tab', { name: '累计' }).click()
    await p.waitForTimeout(200)
    assert.match(await hoverFirst(), /截至 .* 当周累计/)
    await p.getByRole('tab', { name: '每日' }).click()
    await p.waitForTimeout(200)
    assert.ok((await p.locator('.heatmap-weeks .heatmap-cell').count()) >= 350, '每日模式恢复 7 行墙')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 权限横幅「允许一次」同时要求 takeover 与 allowOnce', async () => {
  const baseSettings = await (await fetch(BASE + '/v1/settings')).json()
  const cases = [
    [{ takeover: false, allowOnce: true }, false],
    [{ takeover: true, allowOnce: false }, false],
    [{ takeover: false, allowOnce: false }, false],
    [{ takeover: true, allowOnce: true }, true],
  ]
  const actions = [{ id: 'a1', kind: 'permission', agentId: 'zcode', sessionKey: 'zcode:s1', tool: 'Bash', preview: 'ls', risk: 'normal', state: 'pending' }]
  for (const [permission, expectAllow] of cases) {
    for (const hash of ['overview', 'sessions']) {
      const ctx = await browser.newContext({ viewport: { width: 960, height: 680 }, reducedMotion: 'reduce' })
      const p = await ctx.newPage()
      try {
        await p.route('**/v1/actions*', (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, actions }) })
        )
        // takeover 关闭后 broker 里的 pending 还有 TTL，横幅仍会显示；只校验按钮口径。
        await p.route('**/v1/settings*', (route) => {
          const settings = {
            ...(baseSettings.settings || {}),
            onboarded: true,
            permission: { ...((baseSettings.settings || {}).permission || {}), ...permission },
          }
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...baseSettings, settings }) })
        })
        await p.goto(BASE + '/ui/console.html#' + hash, { waitUntil: 'networkidle' })
        await p.waitForSelector('[data-testid="perm.banner"]', { timeout: 5000 })
        const labels = await p.evaluate(() =>
          [...document.querySelectorAll('[data-testid="perm.banner"] button')].map((b) => b.textContent.trim())
        )
        assert.deepEqual(
          labels,
          expectAllow ? ['去宿主处理', '拒绝', '允许一次'] : ['去宿主处理', '拒绝'],
          hash + ' ' + JSON.stringify(permission) + ' → ' + JSON.stringify(labels)
        )
      } finally {
        await ctx.close()
      }
    }
  }
})

test('e2e: 音量「静音」(soundVolume=0) 不被回落成 50%', async () => {
  const baseSettings = await (await fetch(BASE + '/v1/settings')).json()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  try {
    await p.route('**/v1/settings*', (route) => {
      const settings = { ...(baseSettings.settings || {}), soundVolume: 0, onboarded: true }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...baseSettings, settings }) })
    })
    await p.goto(BASE + '/ui/console.html#roles', { waitUntil: 'networkidle' })
    await p.waitForSelector('[data-testid="sounds.volume"]', { timeout: 10000 })
    const text = (await p.locator('[data-testid="sounds.volume"]').innerText()).replace(/\s+/g, ' ').trim()
    assert.match(text, /静音/, 'soundVolume=0 应显示「静音」而不是 50%：' + text)
    assert.doesNotMatch(text, /50%/, 'soundVolume=0 被回落成 50%：' + text)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 刷新重载 settings——外部改动后设置页不再显示启动旧值', async () => {
  const baseSettings = await (await fetch(BASE + '/v1/settings')).json()
  let autoStart = true
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  try {
    await p.route('**/v1/settings*', (route) => {
      const settings = { ...(baseSettings.settings || {}), onboarded: true, autoStart }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...baseSettings, settings }) })
    })
    await p.goto(BASE + '/ui/console.html#settings', { waitUntil: 'networkidle' })
    await p.waitForSelector('[data-testid="page.settings"]', { timeout: 10000 })
    await p.getByRole('button', { name: '启动与更新' }).click()
    await p.waitForTimeout(300)
    const check = p.locator('#startup input[type="checkbox"]').first()
    assert.equal(await check.isChecked(), true, '启动时应读到 autoStart=true')
    // 模拟外部改设置（向导完成 / 另一个入口修改）。
    autoStart = false
    await p.getByRole('button', { name: '刷新' }).last().click()
    await p.waitForFunction(() => {
      const el = document.querySelector('#startup input[type="checkbox"]')
      return el && !el.checked
    }, null, { timeout: 5000 })
    assert.equal(await check.isChecked(), false, '刷新后应重载 settings：' + (await p.locator('#startup').innerText()))
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 向导完成时开机自启失败 → 不把 autoStart 写进 settings', async () => {
  // D048：设置页的「开机自启」必须与启动文件夹里的启动件一致。autostart 失败时
  // 只 toast，不能继续把 autoStart 写进 /v1/onboarding/complete。
  const baseSettings = await (await fetch(BASE + '/v1/settings')).json()
  let completeBody = null
  let autostartCalls = 0
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  try {
    await p.route('**/v1/settings*', (route) => {
      const settings = { ...(baseSettings.settings || {}), onboarded: false, autoStart: true }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...baseSettings, settings }) })
    })
    await p.route('**/v1/onboarding*', (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          onboarded: false,
          hosts: [{ id: 'zcode', name: 'ZCode', running: true }],
          legacy: { found: false, sources: [] },
          integrationDir: '',
        }),
      })
    })
    await p.route('**/v1/maintenance/autostart', (route) => {
      autostartCalls += 1
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'mock-fail' }) })
    })
    await p.route('**/v1/onboarding/complete', (route) => {
      completeBody = route.request().postDataJSON()
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })
    await p.goto(BASE + '/ui/console.html#overview', { waitUntil: 'networkidle' })
    await p.getByTestId('wizard.next').waitFor({ timeout: 10000 })
    await p.getByTestId('wizard.next').click()
    await p.getByTestId('wizard.next').click()
    await p.getByTestId('wizard.finish').click()
    await p.waitForTimeout(600)
    assert.equal(autostartCalls, 1, '完成时应尝试设置开机自启')
    assert.ok(completeBody, 'onboarding/complete 应被调用')
    assert.equal('autoStart' in completeBody, false, 'autostart 失败时不得写 autoStart：' + JSON.stringify(completeBody))
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})
