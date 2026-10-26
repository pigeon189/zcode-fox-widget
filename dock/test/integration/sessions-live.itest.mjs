// 集成：真 daemon + 合成 ZCode 库 + SSE + 会话事件注入
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-sessions-'))
const zcodeHome = path.join(dir, 'zcode-home')
let daemon = null
let started = null
let base = ''
let dbFile = ''

function seedZcode() {
  dbFile = path.join(zcodeHome, 'cli', 'db', 'db.sqlite')
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new DatabaseSync(dbFile, { timeout: 5000 })
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER);
    CREATE TABLE model_usage (
      session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
      started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
      computed_total_tokens INTEGER, context_exceeded INTEGER
    );
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER);
    CREATE TABLE tool_usage (session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);
  `)
  const now = Date.now()
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?)').run('ses_it_1', null, '集成会话一', 'D:\\proj\\fox-dock', now - 60000, now - 1000, null, null)
  db.prepare(
    `INSERT INTO model_usage VALUES ('ses_it_1','t1','deepseek','deepseek-flash','completed',?,?,?,?,?,?,?,?,0)`
  ).run(now - 60000, now - 59000, 1000, 200, 0, 0, 200, 1200)
  db.prepare(`INSERT INTO turn_usage VALUES ('ses_it_1','t1','completed',?,?,10000)`).run(now - 60000, now - 50000)
  db.close()
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
      FOX_DOCK_VENDOR_BALANCES: '0',
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

test('sessions: ZCode 历史会话出现在 /v1/sessions 与详情', async () => {
  const r = await (await fetch(base + '/v1/sessions?limit=20')).json()
  assert.equal(r.ok, true)
  const item = r.items.find((s) => s.sessionId === 'ses_it_1')
  assert.ok(item, 'missing seeded session: ' + JSON.stringify(r.items.map((x) => x.key)))
  assert.equal(item.key, 'zcode:ses_it_1')
  assert.ok(item.tokens.total >= 1200)
  assert.equal(item.provenance.tokens.kind, 'exact')
  const d = await (await fetch(base + '/v1/sessions/' + encodeURIComponent(item.key))).json()
  assert.equal(d.ok, true)
  assert.equal(d.session.key, 'zcode:ses_it_1')
  assert.ok(Array.isArray(d.turns))
})

test('sessions: ingest 驱动 working → done → waiting_permission', async () => {
  const post = (body, headers = auth()) =>
    fetch(base + '/v1/ingest', { method: 'POST', headers, body: JSON.stringify(body) })
  const r1 = await (await post({ v: 1, agent: 'zcode', event: 'turn_start', sessionId: 'ses_it_1', title: '集成会话一' })).json()
  assert.equal(r1.ok, true)
  let list = await (await fetch(base + '/v1/sessions?limit=20')).json()
  let item = list.items.find((s) => s.sessionId === 'ses_it_1')
  assert.equal(item.status, 'working')
  assert.equal(list.counts.working >= 1, true)

  const r2 = await (await post({ v: 1, agent: 'zcode', event: 'tool_start', sessionId: 'ses_it_1', tool: 'Bash' })).json()
  assert.equal(r2.ok, true)
  list = await (await fetch(base + '/v1/sessions?limit=20')).json()
  item = list.items.find((s) => s.sessionId === 'ses_it_1')
  assert.equal(item.tools.calls >= 1, true)

  await post({ v: 1, agent: 'zcode', event: 'turn_end', sessionId: 'ses_it_1' })
  list = await (await fetch(base + '/v1/sessions?limit=20')).json()
  item = list.items.find((s) => s.sessionId === 'ses_it_1')
  assert.equal(item.status, 'done')

  await post({
    v: 1,
    agent: 'zcode',
    event: 'permission_request',
    sessionId: 'ses_it_1',
    requestId: 'req_integration_0001',
    tool: 'Bash',
    toolInput: 'rm -rf build/',
    wait: { mode: 'decision', timeoutMs: 1000 },
  })
  list = await (await fetch(base + '/v1/sessions?limit=20')).json()
  item = list.items.find((s) => s.sessionId === 'ses_it_1')
  assert.equal(item.status, 'waiting_permission')
  assert.equal(list.aggregate, 'waiting_permission')
  assert.ok(Array.isArray(item.pending) && item.pending.length >= 1)

  // D036：待办含命令预览与 requestId，不能经匿名读面枚举。再登记一个不带 wait
  // 的待办（立即返回、默认 15s TTL），对比匿名与持令牌两种读法。
  await post({
    v: 1,
    agent: 'zcode',
    event: 'permission_request',
    sessionId: 'ses_it_1',
    requestId: 'req_integration_0002',
    tool: 'Bash',
    toolInput: 'echo secret-preview',
  })
  const anon = await (await fetch(base + '/v1/sessions?limit=20')).json()
  const anonPending = (anon.items.find((s) => s.sessionId === 'ses_it_1') || {}).pending || []
  assert.ok(anonPending.length >= 1)
  for (const p of anonPending) {
    assert.equal(p.preview, undefined, '匿名 /v1/sessions 不得返回命令预览')
    assert.equal(p.id, undefined, '匿名 /v1/sessions 不得返回 requestId')
  }
  const authed = await (
    await fetch(base + '/v1/sessions?limit=20', { headers: { 'x-fox-token': started.lock.token } })
  ).json()
  const authedPending = (authed.items.find((s) => s.sessionId === 'ses_it_1') || {}).pending || []
  const full = authedPending.find((p) => String(p.preview || '').includes('echo secret-preview'))
  assert.ok(full, '持令牌的调用方仍能拿到完整待办: ' + JSON.stringify(authedPending))
  assert.ok(full.id, '持令牌时保留 requestId')

  // 详情是同一条待办的另一个匿名读面，必须与列表同口径。
  const sessKey = (anon.items.find((s) => s.sessionId === 'ses_it_1') || {}).key
  const anonDetail = await (await fetch(base + '/v1/sessions/' + encodeURIComponent(sessKey))).json()
  assert.equal(anonDetail.ok, true)
  const anonDetailPending = (anonDetail.session && anonDetail.session.pending) || []
  assert.ok(anonDetailPending.length >= 1, '匿名详情仍应看到待办状态')
  for (const p of anonDetailPending) {
    assert.equal(p.preview, undefined, '匿名 /v1/sessions/:key 不得返回命令预览')
    assert.equal(p.id, undefined, '匿名 /v1/sessions/:key 不得返回 requestId')
  }
})

test('sessions: 无令牌 403 / 非法字段 400 / 超大体积 413', async () => {
  const noToken = await fetch(base + '/v1/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, agent: 'zcode', event: 'turn_start', sessionId: 'ses_it_1' }),
  })
  assert.equal(noToken.status, 403)
  const bad = await (
    await fetch(base + '/v1/ingest', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ v: 1, agent: 'Bad Agent', event: 'turn_start', sessionId: 's' }),
    })
  ).json()
  assert.equal(bad.ok, false)
  assert.match(bad.error, /bad-field/)
  const huge = await fetch(base + '/v1/ingest', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ v: 1, agent: 'zcode', event: 'turn_start', sessionId: 's', title: 'x'.repeat(20000) }),
  })
  assert.equal(huge.status, 413)
})

test('sessions: SSE 新订阅者先收到全量 sessions（待办无预览/id）', async () => {
  // 新登记一个待办，避免依赖上一条用例的 TTL。
  await fetch(base + '/v1/ingest', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      v: 1,
      agent: 'zcode',
      event: 'permission_request',
      sessionId: 'ses_it_1',
      requestId: 'req_sse_preview_0001',
      tool: 'Bash',
      toolInput: 'echo sse-secret-preview',
    }),
  })
  const res = await fetch(base + '/v1/stream', { signal: AbortSignal.timeout(5000) })
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && !text.includes('event: sessions')) {
    const { value, done } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
  }
  try {
    await reader.cancel()
  } catch (err) {}
  assert.match(text, /event: sessions/)
  assert.match(text, /ses_it_1/)
  // SSE 匿名可订阅：载荷里的待办必须与匿名 /v1/sessions 同口径。
  const dataLine = text.split(/\r?\n/).find((l) => l.startsWith('data: ') && l.includes('"items"'))
  assert.ok(dataLine, 'SSE sessions 载荷应可解析: ' + text.slice(0, 300))
  const payload = JSON.parse(dataLine.slice('data: '.length))
  const item = (payload.items || []).find((s) => s.sessionId === 'ses_it_1') || {}
  assert.ok((item.pending || []).length >= 1, 'SSE 应推送待办状态')
  for (const p of item.pending || []) {
    assert.equal(p.preview, undefined, '匿名 SSE sessions 不得返回命令预览')
    assert.equal(p.id, undefined, '匿名 SSE sessions 不得返回 requestId')
  }
})
