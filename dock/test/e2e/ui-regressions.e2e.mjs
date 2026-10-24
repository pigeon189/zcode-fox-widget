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
