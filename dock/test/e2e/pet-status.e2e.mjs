// 宠物层展示状态（D056）：快览卡按 displayStatus 显示已完成；胶囊从服务端计数读
// 已完成，并且计数回落时立即消失（不会卡在「工作中/已完成」）；无权限时不出现
// 「已超时」。
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PORT = Number(process.env.FOX_DOCK_PETSTATUS_E2E_PORT || 39715)
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

const SESSION_ITEMS = [
  { key: 'zcode:done', agentId: 'zcode', sessionId: 'done', title: '刚完成的会话', displayStatus: 'done', status: 'idle' },
  { key: 'zcode:idle', agentId: 'zcode', sessionId: 'idle', title: '空闲会话', displayStatus: 'idle', status: 'idle' },
]

async function openPet(opts = {}) {
  const viewport = opts.viewport || { width: 1280, height: 720 }
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: opts.dpr || 1, reducedMotion: 'reduce' })
  await ctx.addInitScript(({ delayMs, withStream }) => {
    window.__testBounds = { x: 0, y: 0 }
    window.foxOverlay = {
      setInteractive() {},
      getCursor: async () => ({ x: 0, y: 0 }),
      getBounds: async () => ({ ...window.__testBounds, width: window.innerWidth, height: window.innerHeight }),
      getAlphaMask: async () => ({ ok: false }),
      hit: async () => ({ ok: true, hits: [] }),
      write: async () => ({ ok: true }),
      read: async (p) => {
        if (String(p).indexOf('/v1/sessions') === 0) {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
          return { ok: true, items: window.__testSessionItems || [] }
        }
        if (String(p).indexOf('/rect') === 0) {
          return { ok: true, x: 800, y: 300, w: 600, h: 500 }
        }
        return { ok: false }
      },
      openConsole() {},
      hideOverlay() {},
      quitDock() {},
      onPermActions() {},
    }
    window.__testSessionItems = []
    if (withStream) {
      // 生产路径：主进程代理 SSE，渲染层不允许自己建 EventSource。
      window.__testStream = { cb: null }
      window.foxOverlay.onStream = (cb) => {
        window.__testStream.cb = cb
      }
      window.EventSource = function () {
        window.__testEventSourceUsed = true
        throw new Error('renderer-network-forbidden')
      }
    }
  }, { delayMs: opts.delayMs || 0, withStream: !!opts.stream })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(BASE + '/overlay/index.html?port=' + PORT + '&pid=999999&ct=0', { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('#fox', { timeout: 10000 })
  await p.evaluate(() => window.__pet.setSettings({ showChip: true, permission: { takeover: true, allowOnce: true, hotkeys: {} } }))
  return { ctx, p, errors }
}

// CommandCode 的真实内容形态：余额 + 3 个额度窗口 +（最坏情况）3 个按模型分桶 +
// 3 条会话。以前 480px 上限下会刚好差几像素，出现滚动条。
function commandCodeSnapshot(now = Date.now()) {
  return {
    ok: true,
    supported: true,
    adapterId: 'zcode',
    adapterName: 'ZCode',
    unit: 'USD',
    balance: { amount: 35.47, currency: 'USD' },
    turn: { amount: 0.02, currency: 'CNY' },
    quota: { usedPct: 86.8, remainingPct: 13.2 },
    quotaCard: {
      kind: 'windows',
      preferBalance: true,
      windows: [
        { label: '5 小时', usedPct: 4.8, remainingPct: 95.2, resetAt: now + 3 * 3600_000 },
        { label: '本周', usedPct: 98.7, remainingPct: 1.3, resetAt: now + 86400_000 },
        { label: '月度池', usedPct: 55.7, remainingPct: 44.3, resetAt: now + 25 * 86400_000 },
      ],
      buckets: [
        { label: 'GLM-5.3', usedPct: 99.6, remainingPct: 0.4, remaining: 497_580_000, total: 500_000_000 },
        { label: 'GLM-5.3-Flash', usedPct: 100, remainingPct: 0, remaining: 0, total: 500_000_000 },
        { label: '赠送池', usedPct: 2, remainingPct: 98, remaining: 1_960_000_000, total: 2_000_000_000 },
      ],
    },
    period: { isPeak: true, nextChangeAt: now + 2 * 3600_000 },
    today: { amount: 1.2, currency: 'USD' },
    provenance: {},
  }
}

const QUICK_SESSIONS = [
  { key: 'zcode:a', agentId: 'zcode', title: 'fox-dock 2.0 项目交接', displayStatus: 'working' },
  { key: 'zcode:b', agentId: 'zcode', title: '你在 E:\\WorkSpace\\fox-dock（分支 dock-pre）', displayStatus: 'done' },
  { key: 'zcode:c', agentId: 'zcode', title: 'workflow subagent actor#15@1', displayStatus: 'idle' },
]

async function openCommandCodeQuick(opts = {}) {
  const { ctx, p, errors } = await openPet(opts)
  await p.evaluate(
    ({ snap, items }) => {
      window.__testSessionItems = items
      window.__pet.setSnapshot(snap)
      window.__pet.setContext({ ok: true, supported: true, used: 444181, limit: 1_000_000, pct: 44.4 })
      window.__pet.debugAttach('zcode', 1, { x: 700, y: 200, w: 900, h: 560 }, { h: 'right', v: 'bottom' })
      window.__pet.openQuick()
    },
    { snap: commandCodeSnapshot(), items: QUICK_SESSIONS }
  )
  await p.waitForSelector('.quick-session-row', { timeout: 10000 })
  return { ctx, p, errors }
}

function quickOverflow(p) {
  return p.evaluate(() => {
    const q = document.getElementById('quick')
    return {
      clientH: q.clientHeight,
      scrollH: q.scrollHeight,
      clientW: q.clientWidth,
      scrollW: q.scrollWidth,
      top: Math.round(q.getBoundingClientRect().top),
    }
  })
}

test('e2e: 快览卡按 displayStatus 显示已完成/空闲', async () => {
  const { ctx, p, errors } = await openPet()
  try {
    await p.evaluate(
      (items) => {
        window.__testSessionItems = items
        window.__pet.debugAttach('zcode', 1, { x: 720, y: 220, w: 900, h: 600 }, { h: 'right', v: 'bottom' })
        window.__pet.openQuick()
      },
      SESSION_ITEMS
    )
    await p.waitForSelector('.quick-session-row', { timeout: 10000 })
    const states = await p.locator('.quick-session-row .state').allInnerTexts()
    assert.deepEqual(states, ['已完成', '空闲'], '快览卡状态应与 displayStatus 一致：' + JSON.stringify(states))
    const body = await p.locator('#quick').innerText()
    assert.doesNotMatch(body, /已超时/, '没有权限请求时不得出现超时文案')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 胶囊读服务端计数显示已完成，计数回落后立即消失（不卡状态）', async () => {
  const { ctx, p, errors } = await openPet()
  try {
    await p.evaluate(() => {
      window.__pet.debugAttach('zcode', 1, { x: 720, y: 220, w: 900, h: 600 }, { h: 'right', v: 'bottom' })
      window.__pet.setLive({
        aggregate: 'done',
        counts: { working: 0, waiting: 0, error: 0, done: 1 },
        byAgent: { zcode: { working: 0, waiting: 0, error: 0, done: 1, total: 1, lastAt: Date.now() } },
      })
    })
    await p.waitForFunction(() => (document.getElementById('chip-adapter').textContent || '').indexOf('已完成') >= 0, null, { timeout: 5000 })
    assert.match(await p.locator('#chip-adapter').innerText(), /ZCode · 已完成/)

    // 计数回落：胶囊必须立刻不再显示已完成（服务端 5 分钟窗口结束后就是这样）。
    await p.evaluate(() => {
      window.__pet.setLive({
        aggregate: 'idle',
        counts: { working: 0, waiting: 0, error: 0, done: 0 },
        byAgent: { zcode: { working: 0, waiting: 0, error: 0, done: 0, total: 1, lastAt: Date.now() } },
      })
    })
    await p.waitForFunction(() => (document.getElementById('chip-adapter').textContent || '').indexOf('已完成') < 0, null, { timeout: 5000 })
    assert.doesNotMatch(await p.locator('#chip-adapter').innerText(), /已完成|工作中/)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 大浮窗在 CommandCode 常规内容下不出滚动条（960×680 与 DPR 1.25）', async () => {
  const cases = [
    { viewport: { width: 960, height: 680 } },
    { viewport: { width: 1280, height: 720 }, dpr: 1.25 },
  ]
  for (const opts of cases) {
    const { ctx, p, errors } = await openCommandCodeQuick(opts)
    try {
      await p.waitForTimeout(300)
      const m = await quickOverflow(p)
      assert.ok(m.scrollH <= m.clientH + 1, '不应出现纵向滚动条：' + JSON.stringify(m))
      assert.ok(m.scrollW <= m.clientW + 1, '不应出现横向滚动条：' + JSON.stringify(m))
      assert.equal(errors.length, 0, errors.join(' | '))
    } finally {
      await ctx.close()
    }
  }
})

test('e2e: 会话晚到 1.8 秒也不会留下滚动条（不再受 1.5 秒窗口限制）', async () => {
  const { ctx, p, errors } = await openCommandCodeQuick({ viewport: { width: 960, height: 680 }, delayMs: 1800 })
  try {
    await p.waitForSelector('.quick-session-row', { timeout: 10000 })
    await p.waitForTimeout(400)
    const m = await quickOverflow(p)
    assert.ok(m.scrollH <= m.clientH + 1, '晚到内容应触发上移而不是滚动条：' + JSON.stringify(m))
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 胶囊拆分计数，等待输入不能显示成等待确认', async () => {
  const { ctx, p, errors } = await openPet()
  try {
    await p.evaluate(() => {
      window.__pet.debugAttach('zcode', 1, { x: 720, y: 220, w: 900, h: 600 }, { h: 'right', v: 'bottom' })
      window.__pet.setLive({
        aggregate: 'waiting_input',
        counts: { working: 0, waiting: 0, waiting_input: 1, waiting_permission: 0, error: 0, done: 0 },
        byAgent: { zcode: { working: 0, waiting: 0, waiting_input: 1, waiting_permission: 0, error: 0, done: 0 } },
      })
    })
    await p.waitForFunction(() => (document.getElementById('chip-adapter').textContent || '').indexOf('等待输入') >= 0, null, { timeout: 5000 })
    assert.doesNotMatch(await p.locator('#chip-adapter').innerText(), /等待确认/)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 贴角 + 快览卡打开时，台词气泡留在角色/卡片一侧', async () => {
  const { ctx, p, errors } = await openPet({ viewport: { width: 960, height: 680 }, dpr: 1.25 })
  try {
    await p.evaluate(
      ({ snap, items }) => {
        window.__testSessionItems = items
        window.__pet.setSnapshot(snap)
        window.__pet.setContext({ ok: true, supported: true, used: 444181, limit: 1_000_000, pct: 44.4 })
        // 角色贴左下角，快览卡在它右上方：最容易把气泡挤到卡片外侧。
        window.__pet.debugFloat('zcode', 0, 500)
        window.__pet.openQuick()
        window.__pet.showSay('如果我能开无数个子agent，四舍五入大家就都不用干活了')
      },
      { snap: commandCodeSnapshot(), items: QUICK_SESSIONS }
    )
    await p.waitForSelector('#quick:not([hidden])', { timeout: 10000 })
    await p.waitForSelector('#say:not([hidden])', { timeout: 5000 })
    await p.waitForTimeout(600)
    const m = await p.evaluate(() => {
      const box = (id) => {
        const el = document.getElementById(id)
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
      }
      const say = box('say')
      const quick = box('quick')
      const fox = box('fox')
      const w = Math.min(say.right, quick.right) - Math.max(say.left, quick.left)
      const h = Math.min(say.bottom, quick.bottom) - Math.max(say.top, quick.top)
      return {
        say,
        quick,
        fox,
        overlap: Math.max(0, w) * Math.max(0, h),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        distance: Math.hypot(say.left + say.width / 2 - (fox.left + fox.width / 2), say.top + say.height / 2 - (fox.top + fox.height / 2)),
      }
    })
    assert.ok(m.say.left >= 0 && m.say.top >= 0 && m.say.right <= m.viewport.w + 1 && m.say.bottom <= m.viewport.h + 1, '气泡必须完整在视口内：' + JSON.stringify(m.say))
    assert.ok(m.overlap <= 1, '气泡不能压住快览卡：' + m.overlap)
    const sayCenterX = m.say.left + m.say.width / 2
    assert.ok(sayCenterX <= m.quick.right + 8, '气泡不能被挤到卡片外侧：centerX=' + sayCenterX + ' quickRight=' + m.quick.right)
    assert.ok(m.distance < 640, '气泡不能飞离角色太远：' + m.distance)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: refit 重读工作区原点，不再沿用首次缓存', async () => {
  const { ctx, p, errors } = await openPet()
  try {
    await p.evaluate(async () => {
      window.__pet.debugAttach('zcode', 1, { x: 800, y: 300, w: 600, h: 500 }, { h: 'right', v: 'bottom' })
      window.__testBounds = { x: 40, y: 20 }
      await window.__pet.refit()
    })
    const origin = await p.evaluate(() => window.__pet.origin)
    assert.deepEqual(origin, { x: 40, y: 20 }, 'refit 必须重读窗口原点')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 失焦兜底贴死角落，不被右侧避让缝内移', async () => {
  const { ctx, p, errors } = await openPet({ viewport: { width: 960, height: 680 } })
  try {
    const r = await p.evaluate(() => {
      window.__pet.setSettings({ scrollGapOn: true, scrollGap: 17, fallbackCorner: 'br' })
      window.__pet.debugFloat('zcode', 100, 100)
      return window.__pet.debugHostLost()
    })
    assert.ok(Math.abs(r.pos.x + r.size - r.viewport.w) <= 1, '右下兜底必须贴住右缘：' + JSON.stringify(r))
    assert.ok(Math.abs(r.pos.y + r.size - r.viewport.h) <= 1, '右下兜底必须贴住底边：' + JSON.stringify(r))
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: pointercancel 清理拖拽视觉态与按压状态', async () => {
  const { ctx, p, errors } = await openPet()
  try {
    await p.evaluate(() => {
      const fox = document.getElementById('fox')
      const r = fox.getBoundingClientRect()
      fox.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 20, clientY: r.top + 20 }))
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 90, clientY: r.top + 90 }))
      window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))
    })
    const state = await p.evaluate(() => {
      const fox = document.getElementById('fox')
      const hint = document.getElementById('drag-hint')
      return { cls: fox.className, transform: fox.style.transform, hintHidden: hint ? hint.hidden : true, dragging: window.__pet.dragging }
    })
    assert.doesNotMatch(state.cls, /dragging|armed/)
    assert.doesNotMatch(state.transform, /0\.88|1\.05/, '取消后不能保留压扁缩放：' + state.transform)
    assert.equal(state.hintHidden, true)
    assert.equal(state.dragging, false)
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 生产路径用 preload onStream，渲染层不建 EventSource', async () => {
  const { ctx, p, errors } = await openPet({ stream: true })
  try {
    await p.waitForFunction(() => !!(window.__testStream && window.__testStream.cb), null, { timeout: 10000 })
    assert.equal(await p.evaluate(() => !!window.__testEventSourceUsed), false, '有 onStream 时不能再建 EventSource')
    await p.evaluate(() => window.__testStream.cb({ event: 'sessions', data: { items: [] } }))
    await p.waitForTimeout(200)
    const probe = await p.evaluate(() => window.__pet.probeInput(0, 0))
    assert.equal(typeof probe.hit, 'boolean')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})
