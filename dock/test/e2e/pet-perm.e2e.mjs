// 宠物层权限卡回归（D036 / UI-SPEC）：队列里还有待办时不得误报「已超时」并藏按钮；
// 未到期被宿主/控制台处理掉属于正常处理，不提示超时；真正到期才显示「已超时」。
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PORT = Number(process.env.FOX_DOCK_PET_E2E_PORT || 39713)
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

// 纯浏览器渲染宠物层（与 test:pet 同款）：无 preload，靠 window.__pet 注入。
async function openPet() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' })
  await ctx.addInitScript(() => {
    window.foxOverlay = {
      setInteractive() {},
      getCursor: async () => ({ x: 0, y: 0 }),
      getBounds: async () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }),
      getAlphaMask: async () => ({ ok: false }),
      hit: async () => ({ ok: true, hits: [] }),
      write: async () => ({ ok: true }),
      openConsole() {},
      hideOverlay() {},
      quitDock() {},
      onPermActions() {},
    }
  })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto(BASE + '/overlay/index.html?port=' + PORT + '&pid=999999&ct=0', { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('#fox', { timeout: 10000 })
  await p.evaluate(() => window.__pet.setSettings({ permission: { takeover: true, allowOnce: true, hotkeys: {} } }))
  return { ctx, p, errors }
}

function action(id, tool, expiresInMs) {
  const now = Date.now()
  return {
    id,
    kind: 'permission',
    agentId: 'zcode',
    sessionKey: 'zcode:s1',
    tool,
    preview: tool + ' 预览',
    risk: 'normal',
    state: 'pending',
    createdAt: now - 1000,
    expiresAt: now + expiresInMs,
  }
}

function readCard(p) {
  return p.evaluate(() => ({
    hidden: document.getElementById('perm').hidden,
    tool: document.getElementById('perm-tool').textContent,
    expired: !document.getElementById('perm-expired').hidden,
    deny: !document.getElementById('perm-deny').hidden,
    allow: !document.getElementById('perm-allow').hidden,
  }))
}

test('e2e: 权限卡——队列还有待办时不误报「已超时」，新待办按钮立即可用', async () => {
  const { ctx, p, errors } = await openPet()
  try {
    await p.evaluate((a) => window.__pet.debugPermActions([a]), action('a1', 'Bash', 30000))
    const first = await readCard(p)
    assert.equal(first.hidden, false, '第一条待办应显示卡片')
    assert.equal(first.tool, 'Bash')
    assert.equal(first.expired, false)
    assert.equal(first.deny, true)
    assert.equal(first.allow, true)

    // a1 被宿主/控制台处理（未到期），队列里还有 b2：直接切到 b2，不显示「已超时」。
    await p.evaluate((a) => window.__pet.debugPermActions([a]), action('b2', 'Read', 30000))
    const second = await readCard(p)
    assert.equal(second.hidden, false, '有其它待办时卡片不能收起')
    assert.equal(second.tool, 'Read', '应立即展示新的待办')
    assert.equal(second.expired, false, '不能误报「已超时」')
    assert.equal(second.deny, true, '新待办的拒绝按钮不能被藏')
    assert.equal(second.allow, true, '新待办的允许按钮不能被藏')
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})

test('e2e: 权限卡——未到期被处理直接收起，真正到期才提示「已超时」', async () => {
  const { ctx, p, errors } = await openPet()
  try {
    // 未到期（expiresAt 在未来）被外部处理：正常收起，不提示超时。
    await p.evaluate((a) => window.__pet.debugPermActions([a]), action('c1', 'Bash', 30000))
    assert.equal((await readCard(p)).hidden, false)
    await p.evaluate(() => window.__pet.debugPermActions([]))
    const handled = await readCard(p)
    assert.equal(handled.hidden, true, '被处理后卡片应收起')
    assert.equal(handled.expired, false, '非超时处理不显示「已超时」')

    // 真正到期：显示「已超时」，按钮收起，4 秒后卡片自动收起。
    await p.evaluate((a) => window.__pet.debugPermActions([a]), action('c2', 'Bash', -1000))
    assert.equal((await readCard(p)).hidden, false)
    await p.evaluate(() => window.__pet.debugPermActions([]))
    const expired = await readCard(p)
    assert.equal(expired.hidden, false, '到期后先显示「已超时」提示')
    assert.equal(expired.expired, true, '到期应显示「已超时」')
    assert.equal(expired.deny, false)
    assert.equal(expired.allow, false)
    await p.waitForFunction(() => document.getElementById('perm').hidden, null, { timeout: 7000 })
    assert.equal(errors.length, 0, errors.join(' | '))
  } finally {
    await ctx.close()
  }
})
