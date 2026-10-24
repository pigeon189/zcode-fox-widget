// M5 集成：/v1/ingest wait 长轮询 + /v1/actions 决策闭环（真 daemon）
//
// 注意：同一测试进程里并发两个 wait 长轮询时，undici 曾出现响应配对错乱
// （daemon 侧逐条 debug 证实每个响应都发给了正确 socket，但客户端 await 到了
// 另一个请求的 body）。因此这里一次只长轮询一个请求；第二个请求不带 wait、
// 只登记，并用响应自带的 requestId 做身份断言兜底。
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-actions-'))
let daemon = null
let started = null
let base = ''

const RID = (n) => 'itestrq' + String(n).padStart(25, '0')

function auth() {
  return { 'x-fox-token': started.lock.token, 'Content-Type': 'application/json' }
}

async function ingest(event, extra = {}) {
  return fetch(base + '/v1/ingest', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ v: 1, agent: 'zcode', sessionId: 'itest', event, ...extra }),
  })
}

before(async () => {
  daemon = spawn(process.execPath, [DAEMON, '--data-dir', dir, '--port', '0', '--no-bridge'], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ZCODE_HOME: path.join(dir, 'zh'), ZCODE_DATA_BASE_DIR: path.join(dir, 'zh') },
  })
  started = await waitHealth(dir)
  assert.ok(started, 'daemon did not become healthy')
  base = 'http://127.0.0.1:' + started.health.port
})

after(async () => {
  try {
    if (started) await fetch(base + '/shutdown', { method: 'POST', headers: auth(), signal: AbortSignal.timeout(2000) })
  } catch (err) {}
  try {
    if (daemon && !daemon.killed) daemon.kill()
  } catch (err) {}
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('actions: takeover 关闭时 wait 立即 ignored（fail-open to host）', async () => {
  const res = await ingest('permission_request', {
    requestId: RID(1),
    tool: 'Bash',
    toolInput: 'ls',
    wait: { mode: 'decision', timeoutMs: 3000 },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.decision, 'ignored')
})

test('actions: takeover 开启 → pending 登记 + 高风险标注 + resolve deny 回传', async () => {
  const put = await fetch(base + '/v1/settings', {
    method: 'PUT',
    headers: auth(),
    body: JSON.stringify({ permission: { takeover: true, waitMs: 15000 } }),
  })
  assert.equal(put.status, 200)

  const slow = ingest('permission_request', {
    requestId: RID(2),
    tool: 'Bash',
    toolInput: 'rm -rf build/ && deploy --key sk-' + 'abcdefghijklmnop123456',
    wait: { mode: 'decision', timeoutMs: 8000 },
  })
  // 只登记不等待：避免同进程并发长轮询的响应配对问题（见文件头注释）。
  const register = await ingest('permission_request', { requestId: RID(3), tool: 'Bash', toolInput: 'ls' })
  assert.equal((await register.json()).ok, true)
  await sleep(400)

  const list = await (await fetch(base + '/v1/actions')).json()
  assert.equal(list.ok, true)
  const high = list.actions.find((a) => a.id === RID(2))
  const low = list.actions.find((a) => a.id === RID(3))
  assert.ok(high, '高危请求应已登记')
  assert.equal(high.risk, 'high')
  assert.ok(high.preview.includes('rm -rf'), '卡片预览保留命令文本（供用户判断）')
  assert.ok(!high.preview.includes('sk-' + 'abcdefghijklmnop123456'), '预览里的密钥必须已遮蔽')
  assert.ok(low, '普通请求应已登记')
  assert.equal(low.risk, 'normal')

  // 无 token 403
  const noAuth = await fetch(base + '/v1/actions/' + RID(2) + '/resolve', {
    method: 'POST',
    body: JSON.stringify({ decision: 'deny', via: 'pet' }),
  })
  assert.equal(noAuth.status, 403)
  // 非法 via 400
  const badVia = await fetch(base + '/v1/actions/' + RID(2) + '/resolve', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ decision: 'deny', via: 'timeout' }),
  })
  assert.equal(badVia.status, 400)

  const resolve = await fetch(base + '/v1/actions/' + RID(2) + '/resolve', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ decision: 'deny', via: 'pet' }),
  })
  assert.equal(resolve.status, 200)
  const resolved = await resolve.json()
  assert.equal(resolved.action.state, 'denied')

  const waitBody = await (await slow).json()
  assert.equal(waitBody.requestId, RID(2), '长轮询响应必须自标识为同一请求')
  assert.equal(waitBody.decision, 'deny')

  // 重复 resolve → 409
  const again = await fetch(base + '/v1/actions/' + RID(2) + '/resolve', {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ decision: 'allow', via: 'pet' }),
  })
  assert.equal(again.status, 409)

  const after = await (await fetch(base + '/v1/actions')).json()
  assert.ok(!after.actions.some((a) => a.id === RID(2)), '决策后该 pending 应消失')
})

test('actions: 客户端 wait 超时 → decision timeout（宿主 fail-open）', async () => {
  const res = await ingest('permission_request', {
    requestId: RID(4),
    tool: 'Bash',
    toolInput: 'echo waiting',
    wait: { mode: 'decision', timeoutMs: 1200 },
  })
  const body = await res.json()
  assert.equal(body.decision, 'timeout')
})

test('actions: permission_resolved 事件联动收起 pending 并回传 allow', async () => {
  const slow = ingest('permission_request', {
    requestId: RID(5),
    tool: 'Bash',
    toolInput: 'git status',
    wait: { mode: 'decision', timeoutMs: 20000 },
  })
  await sleep(300)
  const list = await (await fetch(base + '/v1/actions')).json()
  assert.ok(list.actions.some((a) => a.id === RID(5)))
  const resolved = await ingest('permission_resolved', { requestId: RID(5), decision: 'allow' })
  assert.equal(resolved.status, 200)
  const waitBody = await (await slow).json()
  assert.equal(waitBody.requestId, RID(5))
  assert.equal(waitBody.decision, 'allow')
})
