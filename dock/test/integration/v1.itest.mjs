import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { isProcessAlive, readLock } from '../../daemon/src/lock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(HERE, '..', '..', 'daemon', 'src', 'daemon.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHealth(dir, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = readLock(path.join(dir, 'daemon.lock'))
    if (lock && lock.port && isProcessAlive(lock.pid)) {
      try {
        const res = await fetch('http://127.0.0.1:' + lock.port + '/health', { signal: AbortSignal.timeout(1000) })
        if (res.ok) return { lock, health: await res.json() }
      } catch (err) {}
    }
    await sleep(120)
  }
  return null
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-v1-'))
const zcodeHome = path.join(dir, 'zcode-home')
let daemon = null
let started = null
let base = ''

function seedZcode() {
  const dbFile = path.join(zcodeHome, 'cli', 'db', 'db.sqlite')
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new DatabaseSync(dbFile)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER);
    CREATE TABLE model_usage (
      session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
      started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
      computed_total_tokens INTEGER, context_exceeded INTEGER
    );
  `)
  const now = Date.now()
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('s1', null, '集成测试会话', now, null, null)
  db.prepare(
    `INSERT INTO model_usage VALUES ('s1','t1','p','deepseek-v4.1','completed',?,?,?,?,?,?,?,?,?)`
  ).run(now - 1000, now - 900, 800, 200, 0, 0, 200, 1000, 0)
  db.close()
  const endpoint = path.join(zcodeHome, 'v2', 'runtime', 'provider', 'windows-x86_64', '9.9.9', 'ep')
  fs.mkdirSync(endpoint, { recursive: true })
  fs.writeFileSync(
    path.join(endpoint, 'zcode-builtin.json'),
    JSON.stringify({ config: { modelConfigRules: { modelRules: [{ modelMatch: '.*', config: { properties: { contextWindow: 1000000 } } }] } } })
  )
}

before(async () => {
  seedZcode()
  daemon = spawn(process.execPath, [DAEMON, '--data-dir', dir, '--port', '0', '--no-bridge'], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ZCODE_HOME: zcodeHome,
      ZCODE_DATA_BASE_DIR: zcodeHome,
      CODEBUDDY_HOME: path.join(dir, 'wb-home'),
      DSH_HOME: path.join(dir, 'dsh-home'),
      KIMI_CODE_HOME: path.join(dir, 'kimi-home'),
    },
  })
  started = await waitHealth(dir)
  assert.ok(started, 'daemon did not become healthy')
  base = 'http://127.0.0.1:' + started.health.port
})

after(async () => {
  try {
    if (started) {
      await fetch(base + '/shutdown', {
        method: 'POST',
        headers: { 'x-fox-token': started.lock.token },
        signal: AbortSignal.timeout(2000),
      })
    }
  } catch (err) {}
  try {
    if (daemon && !daemon.killed) daemon.kill()
  } catch (err) {}
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

const auth = () => ({ 'x-fox-token': started.lock.token, 'Content-Type': 'application/json' })

test('v1: /v1/state 返回宠物状态、四个宿主与 daemon 信息', async () => {
  const r = await (await fetch(base + '/v1/state')).json()
  assert.equal(r.ok, true)
  assert.equal(r.pet.mode, 'idle')
  assert.deepEqual(
    r.agents.map((a) => a.id).sort(),
    ['dsh', 'kimi', 'workbuddy', 'zcode']
  )
  assert.equal(r.daemon.port, started.health.port)
  assert.match(r.daemon.version, /^\d+\.\d+\.\d+/)
})

test('v1: 写接口缺 token 403，带 token 可改设置', async () => {
  const bad = await fetch(base + '/v1/settings', { method: 'PUT', body: JSON.stringify({ theme: 'dark' }) })
  assert.equal(bad.status, 403)
  const ok = await fetch(base + '/v1/settings', { method: 'PUT', headers: auth(), body: JSON.stringify({ theme: 'dark' }) })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.settings.theme, 'dark')
  const read = await (await fetch(base + '/v1/settings')).json()
  assert.equal(read.settings.theme, 'dark')
})

test('v1: 档案按 agent 覆盖，未覆盖字段继承全局', async () => {
  await fetch(base + '/v1/settings', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ displayMode: 'today', turnBubbleMs: 6000 }),
  })
  const put = await fetch(base + '/v1/profiles/zcode', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ roleId: 'whale', turnBubbleMs: 9000 }),
  })
  assert.equal(put.status, 200)
  const p = await (await fetch(base + '/v1/profiles/zcode')).json()
  assert.equal(p.profile.roleId, 'whale')
  assert.equal(p.profile.turnBubbleMs, 9000)
  assert.equal(p.profile.displayMode, 'today')
  const k = await (await fetch(base + '/v1/profiles/kimi')).json()
  assert.equal(k.profile.roleId, 'fox', '别的 agent 不受影响')
})

test('v1: 宠物命令走三态并持久化', async () => {
  const attach = await fetch(base + '/v1/pet/attach', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ exe: 'C:/Program Files/ZCode/ZCode.exe', title: 'ZCode', hwnd: '0x123', rect: { x: 1, y: 2, width: 3, height: 4 } }),
  })
  const a = await attach.json()
  assert.equal(a.pet.mode, 'attached')
  assert.equal(a.pet.profileOf, 'zcode')

  const float = await (await fetch(base + '/v1/pet/float', { method: 'POST', headers: auth(), body: '{}' })).json()
  assert.equal(float.pet.mode, 'floating')
  assert.equal(float.pet.profileOf, 'zcode')

  const reset = await (await fetch(base + '/v1/pet/reset', { method: 'POST', headers: auth(), body: '{}' })).json()
  assert.equal(reset.pet.mode, 'idle')
  assert.equal(reset.pet.profileOf, '')

  const state = await (await fetch(base + '/v1/state')).json()
  assert.equal(state.pet.mode, 'idle')
})

test('v1: attach 缺 agentId/hwnd 返回 400', async () => {
  const r = await fetch(base + '/v1/pet/attach', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ agentId: 'zcode' }),
  })
  assert.equal(r.status, 400)
})

test('v1: 上下文接口返回 used/limit/pct，并带会话列表', async () => {
  const r = await (await fetch(base + '/v1/agents/zcode/context')).json()
  assert.equal(r.ok, true)
  assert.equal(r.context.supported, true)
  assert.equal(r.context.used, 1000)
  assert.equal(r.context.limit, 1000000)
  assert.equal(r.context.pct, 0.1)
  assert.equal(r.context.confidence, 'exact')
  const s = await (await fetch(base + '/v1/agents/zcode/sessions')).json()
  assert.equal(s.ok, true)
  assert.equal(s.sessions[0].id, 's1')
  // 没有数据的宿主不补 0
  const none = await (await fetch(base + '/v1/agents/workbuddy/context')).json()
  assert.equal(none.context.supported, false)
  assert.equal(none.context.used, null)
})

test('v1: 厂商页走内置 engines，响应里没有完整密钥', async () => {
  const r = await (await fetch(base + '/v1/vendors')).json()
  assert.equal(r.ok, true)
  assert.equal(r.source, 'engines')
  assert.ok(Array.isArray(r.vendors) && r.vendors.length >= 30, '内置模板应全部返回')
  const text = JSON.stringify(r)
  assert.equal(/sk-[A-Za-z0-9_-]{16,}/.test(text), false, '厂商响应不得包含完整 key')
  assert.ok(r.vendors.every((v) => !('key' in v) && !('apiKey' in v)))
})

test('v1: 导入候选不含完整 key；凭据写入/删除走保险库', { skip: process.platform !== 'win32' }, async () => {
  const candidates = await (await fetch(base + '/v1/vendors/import/candidates')).json()
  assert.equal(candidates.ok, true)
  assert.ok(candidates.candidates.every((c) => !('key' in c) && typeof c.masked === 'string'))

  const bad = await fetch(base + '/v1/vendors/deepseek/credential', { method: 'POST', body: '{"key":"sk-x"}' })
  assert.equal(bad.status, 403)
  const set = await fetch(base + '/v1/vendors/deepseek/credential', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ key: 'fx-test-1234567890abcdef' }),
  })
  assert.equal(set.status, 200)
  const saved = await set.json()
  assert.equal(saved.maskedKey, 'fx-••••cdef')
  assert.equal(JSON.stringify(saved).includes('fx-test-'), false)

  const del = await fetch(base + '/v1/vendors/deepseek/credential', { method: 'DELETE', headers: auth() })
  assert.equal(del.status, 200)
  assert.equal((await del.json()).removed, true)
})

test('v1: 角色导入校验并通过，内置角色不可删除', async () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const imported = await fetch(base + '/v1/roles/import', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ id: 'it-role', name: '集成角色', dataBase64: png }),
  })
  assert.equal(imported.status, 200)
  const r = await imported.json()
  assert.equal(r.role.id, 'it-role')
  assert.equal(r.role.width, 1)
  const list = await (await fetch(base + '/v1/roles')).json()
  assert.ok(list.roles.some((x) => x.id === 'it-role' && x.name === '集成角色'))

  const delBuiltin = await fetch(base + '/v1/roles/fox', { method: 'DELETE', headers: auth() })
  assert.equal(delBuiltin.status, 400)
  const del = await fetch(base + '/v1/roles/it-role', { method: 'DELETE', headers: auth() })
  assert.equal(del.status, 200)
  assert.equal((await del.json()).removed, true)
})

test('v1: 余额校正写入/读取/删除', async () => {
  const post = await fetch(base + '/v1/vendors/deepseek/corrections', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ type: 'add', amount: 12.5, currency: 'CNY', note: '赠送' }),
  })
  assert.equal(post.status, 200)
  const created = (await post.json()).correction
  assert.ok(created.id)
  const list = await (await fetch(base + '/v1/vendors/deepseek/corrections')).json()
  assert.equal(list.corrections.length, 1)
  assert.equal(list.corrections[0].amount, 12.5)
  const del = await fetch(base + '/v1/vendors/corrections/' + encodeURIComponent(created.id), {
    method: 'DELETE',
    headers: auth(),
  })
  assert.equal(del.status, 200)
})

test('v1: 泡泡队列与导入来源接口可用', async () => {
  const bad = await fetch(base + '/v1/bubbles/queue', { method: 'POST', body: '{}' })
  assert.equal(bad.status, 403)
  const put = await fetch(base + '/v1/bubbles/queue', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ queue: ['第一句', { text: '第二句', sub: '副标题' }] }),
  })
  assert.equal(put.status, 200)
  const got = await (await fetch(base + '/v1/bubbles/queue')).json()
  assert.deepEqual(got.queue.map((x) => (typeof x === 'string' ? x : x.text)), ['第一句', '第二句'])
  const sources = await (await fetch(base + '/v1/import/sources')).json()
  assert.equal(sources.categories.length, 5)
})

test('v1: 宿主事件需要 token 并进入诊断包', async () => {
  const bad = await fetch(base + '/v1/events', { method: 'POST', body: '{"type":"turn-start"}' })
  assert.equal(bad.status, 403)
  const ok = await fetch(base + '/v1/events', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ type: 'permission-request', agentId: 'zcode' }),
  })
  assert.equal(ok.status, 200)
  const diag = await (await fetch(base + '/v1/diag/bundle')).json()
  assert.equal(diag.ok, true)
  assert.ok(diag.events.some((e) => e.type === 'permission-request'))
})

test('v1: 错误 Host 被拒绝（DNS rebinding 防护）', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: started.health.port, path: '/v1/state', headers: { Host: 'evil.example.com' } },
      (res) => {
        res.resume()
        resolve(res.statusCode)
      }
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 403)
})

test('v1: 旧路由带 X-Fox-Deprecated，/v1 不带', async () => {
  const old = await fetch(base + '/health')
  assert.equal(old.headers.get('x-fox-deprecated'), '1')
  const neu = await fetch(base + '/v1/state')
  assert.equal(neu.headers.get('x-fox-deprecated'), null)
})

test('v1: SSE 首帧与宠物状态变更推送', async () => {
  const ctrl = new AbortController()
  const res = await fetch(base + '/v1/stream', { signal: ctrl.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const waitFor = async (needle, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (buffer.includes(needle)) return true
      const r = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: false, value: null }), 300)),
      ])
      if (r.value) buffer += decoder.decode(r.value, { stream: true })
    }
    return buffer.includes(needle)
  }
  assert.ok(await waitFor(': connected'), 'SSE 必须有连接帧')
  await fetch(base + '/v1/pet/attach', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ agentId: 'kimi', hwnd: '0x9' }),
  })
  assert.ok(await waitFor('event: state'), '状态变更必须推送 state')
  assert.match(buffer, /"mode":"attached"/)
  ctrl.abort()
})
