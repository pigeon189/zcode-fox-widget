// 适配器接口（R4）：真服务 + 真 HTTP
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessAlive, readLock } from '../../daemon/src/lock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(HERE, '..', '..', 'daemon', 'src', 'daemon.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-adapters-'))
let daemon = null
let port = 0
let token = ''

async function waitHealth(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = readLock(path.join(dir, 'daemon.lock'))
    if (lock && lock.port && isProcessAlive(lock.pid)) {
      try {
        const res = await fetch('http://127.0.0.1:' + lock.port + '/health', { signal: AbortSignal.timeout(800) })
        const h = await res.json()
        if (h && h.ok) return { lock, health: h }
      } catch (err) {}
    }
    await sleep(150)
  }
  return null
}

const get = async (p) => {
  const res = await fetch('http://127.0.0.1:' + port + p)
  return { status: res.status, body: await res.json() }
}

const post = async (p, body) => {
  const res = await fetch('http://127.0.0.1:' + port + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

before(async () => {
  daemon = spawn(process.execPath, [DAEMON, '--data-dir', dir, '--port', '0'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  const started = await waitHealth()
  assert.ok(started, 'daemon did not become healthy')
  port = started.health.port
  token = started.lock.token
})

after(async () => {
  try {
    await fetch('http://127.0.0.1:' + port + '/shutdown', {
      method: 'POST',
      headers: { 'x-fox-token': token },
    })
  } catch (err) {}
  try {
    daemon.kill()
  } catch (err) {}
  await sleep(200)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('/adapters：列出内置适配器，字段可 JSON 序列化', async () => {
  const { status, body } = await get('/adapters')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.adapters))
  const generic = body.adapters.find((a) => a.id === 'generic')
  assert.ok(generic, 'generic adapter missing')
  assert.equal(generic.billing, false)
  assert.equal(generic.fallback, true)
  // 描述里不能有函数（否则 HTTP 序列化会丢字段而不是报错）
  assert.equal(typeof JSON.parse(JSON.stringify(generic)).id, 'string')
})

test('/resolve：未知进程回落到 generic（fallback:true）', async () => {
  const { status, body } = await get('/resolve?exe=' + encodeURIComponent('C:\\Windows\\notepad.exe') + '&title=hello')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.adapter.id, 'generic')
  assert.equal(body.adapter.fallback, true)
  assert.equal(body.adapter.capabilities.billing, false)
})

test('/bind：适配器由服务端判定，忽略客户端乱传的 adapterId', async () => {
  const win = {
    exe: 'C:\\Windows\\notepad.exe',
    pid: 4321,
    startMs: Date.now() - 5000,
    hwnd: 'abc123',
    title: '未接入的窗口',
    cls: 'Notepad',
    rect: { x: 10, y: 20, w: 300, h: 200 },
    adapterId: 'zcode', // 客户端谎报
  }
  const { status, body } = await post('/bind', win)
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.binding.adapterId, 'generic')
  assert.equal(body.binding.adapterHint, 'zcode')
  assert.equal(body.adapter.id, 'generic')
  assert.equal(body.binding.window.startMs, win.startMs)
})

test('/billing：generic 绑定返回 supported:false，且不编造数值', async () => {
  const list = await get('/bindings')
  const key = list.body.bindings[0].key
  const { status, body } = await get('/billing?key=' + encodeURIComponent(key))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.bindingKey, key)
  assert.equal(body.snapshot.supported, false)
  assert.equal(body.snapshot.today, null)
  assert.equal(body.snapshot.unit, null)
})

test('/billing：未知 key 返回 404；缺字段的 /bind 返回 400', async () => {
  assert.equal((await get('/billing?key=nope')).status, 404)
  const bad = await post('/bind', { exe: 'C:\\a\\b.exe' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.ok, false)
})

test('/diag.json：版本/适配器/绑定/日志齐全，且路径脱敏', async () => {
  const os = await import('node:os')
  const home = os.homedir()
  const res = await fetch('http://127.0.0.1:' + port + '/diag.json')
  const text = await res.text()
  const d = JSON.parse(text)
  assert.equal(res.status, 200)
  assert.equal(d.app, 'fox-dock')
  assert.equal(d.version, (await (await fetch('http://127.0.0.1:' + port + '/health')).json()).version)
  assert.ok(Array.isArray(d.adapters) && d.adapters.some((a) => a.id === 'generic'))
  assert.ok(d.bindingCount >= 1, 'should expose existing binding count')
  assert.ok(Array.isArray(d.logs))
  assert.ok(d.summary && d.summary.today)
  assert.equal(text.indexOf(home), -1, 'home dir must be redacted')
})

test('/settings：默认值可读，PUT 合并且丢弃未知字段', async () => {
  const d0 = await get('/settings')
  assert.equal(d0.status, 200)
  assert.equal(d0.body.ok, true)
  assert.equal(d0.body.settings.scale, 1)
  assert.equal(d0.body.settings.scrollGap, 17)

  const put = async (patch) => {
    const res = await fetch('http://127.0.0.1:' + port + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
      body: JSON.stringify(patch),
    })
    return { status: res.status, body: await res.json() }
  }

  const r1 = await put({ scale: 1.5, budgetMoney: 20, evil: '<script>' })
  assert.equal(r1.status, 200)
  assert.equal(r1.body.settings.scale, 1.5)
  assert.equal(r1.body.settings.budgetMoney, 20)
  assert.equal('evil' in r1.body.settings, false)

  // 只发改动项，其余字段必须保留
  const r2 = await put({ showChip: false })
  assert.equal(r2.body.settings.scale, 1.5)
  assert.equal(r2.body.settings.budgetMoney, 20)
  assert.equal(r2.body.settings.showChip, false)

  // 越界值夹回
  const r3 = await put({ followMs: 99999, quotaWarnPct: 130, scrollGap: -3 })
  assert.equal(r3.body.settings.followMs, 1000)
  assert.equal(r3.body.settings.quotaWarnPct, 100)
  assert.equal(r3.body.settings.scrollGap, 0)

  const back = await get('/settings')
  assert.deepEqual(back.body.settings, r3.body.settings)

  // 诊断包里也带设置（排障时不用再问用户改了什么）
  const diag = await get('/diag.json')
  assert.equal(diag.body.settings.scale, 1.5)

  // 复位，避免影响后续用例
  await put({ scale: 1, showChip: true, followMs: 500, scrollGap: 17, quotaWarnPct: 0, budgetMoney: 0 })
})

test('2.0 /adapters：内置四个宿主，带默认角色与强调色', async () => {
  const { status, body } = await get('/adapters')
  assert.equal(status, 200)
  const ids = body.adapters.map((a) => a.id)
  for (const id of ['zcode', 'workbuddy', 'kimi', 'dsh']) assert.ok(ids.includes(id), id)
  const kimi = body.adapters.find((a) => a.id === 'kimi')
  const dsh = body.adapters.find((a) => a.id === 'dsh')
  assert.equal(kimi.roleDefault, 'kimi')
  assert.equal(dsh.roleDefault, 'whale')
  assert.ok(kimi.accent && dsh.accent)
  assert.doesNotThrow(() => JSON.stringify(body.adapters))
})

test('2.0 /resolve：Kimi Code 与 dsh 的 exe 能命中各自适配器', async () => {
  const kimi = await get(
    '/resolve?exe=' + encodeURIComponent('E:\\KimiCode\\Kimi Code\\Kimi Code.exe') + '&title=' + encodeURIComponent('Kimi Code')
  )
  assert.equal(kimi.body.adapter.id, 'kimi')
  assert.equal(kimi.body.adapter.roleDefault, 'kimi')
  const dsh = await get(
    '/resolve?exe=' + encodeURIComponent('E:\\DSH-Windows\\DeepSeek Harness.exe') + '&title=' + encodeURIComponent('DeepSeek Harness')
  )
  assert.equal(dsh.body.adapter.id, 'dsh')
  assert.equal(dsh.body.adapter.roleDefault, 'whale')
})

test('2.0 /bind：返回 roleDefault/accent，客户端仍不能伪造适配器', async () => {
  const res = await fetch('http://127.0.0.1:' + port + '/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
    body: JSON.stringify({
      exe: 'E:\\KimiCode\\Kimi Code\\Kimi Code.exe',
      pid: 9876,
      startMs: Date.now() - 1000,
      hwnd: 'abc123',
      title: 'Kimi Code',
      cls: 'Chrome_WidgetWin_1',
      rect: { x: 0, y: 0, w: 800, h: 600 },
      adapterId: 'dsh',
    }),
  })
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.binding.adapterId, 'kimi')
  assert.equal(body.binding.adapterHint, 'dsh')
  assert.equal(body.adapter.roleDefault, 'kimi')
  assert.ok(body.adapter.accent)
})

test('2.0 /update/check：未配置清单时明确返回 manifest-not-configured', async () => {
  const { status, body } = await get('/update/check')
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'manifest-not-configured')
  assert.match(body.current, /^\d+\.\d+\.\d+/)
  assert.match(body.error, /更新清单/)
})

test('2.0 /agents：有桥时返回数组，无桥时明确 bridge-unavailable', async () => {
  const { status, body } = await get('/agents')
  if (status === 503) {
    assert.equal(body.ok, false)
    assert.equal(body.error, 'bridge-unavailable')
    return
  }
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.agents))
  for (const a of body.agents) {
    assert.ok(a.adapter && a.adapter.id && a.adapter.name)
    assert.ok(!('createBilling' in a.adapter), '不能把函数泄漏给前端')
  }
})

test('2.0 /settings：主题/主数字/自动换角色/按宿主角色都能写回并被净化', async () => {
  const put = async (patch) => {
    const res = await fetch('http://127.0.0.1:' + port + '/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-fox-token': token },
      body: JSON.stringify(patch),
    })
    return { status: res.status, body: await res.json() }
  }
  const r = await put({
    theme: 'dark',
    displayMode: 'quota',
    autoRole: false,
    showWeek: false,
    rolesByAdapter: { kimi: 'whale', zcode: 'fox', evil: 'fox', dsh: 'bad id!' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.settings.theme, 'dark')
  assert.equal(r.body.settings.displayMode, 'quota')
  assert.equal(r.body.settings.autoRole, false)
  assert.equal(r.body.settings.showWeek, false)
  assert.deepEqual(r.body.settings.rolesByAdapter, { kimi: 'whale', zcode: 'fox' })

  const bad = await put({ theme: 'purple', displayMode: 'nope' })
  assert.equal(bad.body.settings.theme, 'auto')
  assert.equal(bad.body.settings.displayMode, 'auto')

  // 复位
  await put({ theme: 'auto', displayMode: 'auto', autoRole: true, showWeek: true, rolesByAdapter: {} })
})
