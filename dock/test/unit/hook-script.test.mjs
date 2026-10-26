// M5 §6.2 dock-hook.mjs：以子进程方式跑真脚本，喂 stdin 验证 fail-open 纪律。
import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateIngest } from '../../daemon/src/ingest.mjs'
import { assessRisk } from '../../daemon/src/risk.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(HERE, '..', '..', 'hooks', 'dock-hook.mjs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-hook-test-'))
fs.mkdirSync(path.join(dir, 'data'), { recursive: true })

let server = null
let serverPort = 0
let lastIngest = null
let lastBodyBytes = 0
let decision = 'deny'

function runHook(stdinPayload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FOX_DOCK_DATA: path.join(dir, 'data'), ...env },
    })
    const chunks = { out: [], err: [] }
    const t0 = Date.now()
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    child.stdout.on('data', (c) => chunks.out.push(c))
    child.stderr.on('data', (c) => chunks.err.push(c))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        ms: Date.now() - t0,
        stdout: Buffer.concat(chunks.out).toString('utf8'),
        stderr: Buffer.concat(chunks.err).toString('utf8'),
      })
    })
    if (stdinPayload != null) child.stdin.end(typeof stdinPayload === 'string' ? stdinPayload : JSON.stringify(stdinPayload))
    else child.stdin.end()
  })
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/v1/settings') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, settings: { permission: { takeover: true, waitMs: 15000 } } }))
        return
      }
      if (req.url === '/v1/ingest' && req.method === 'POST') {
        lastBodyBytes = Buffer.byteLength(body, 'utf8')
        try {
          lastIngest = JSON.parse(body)
        } catch (err) {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, decision, requestId: lastIngest ? lastIngest.requestId : '' }))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  serverPort = server.address().port
  fs.writeFileSync(
    path.join(dir, 'data', 'daemon.lock'),
    JSON.stringify({ at: Date.now(), pid: process.pid, port: serverPort, token: 'hooktesttoken', version: '0.0.0-test' })
  )
})

after(async () => {
  try {
    server.close()
  } catch (err) {}
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('hook: daemon 不在 → 非权限事件 300ms 内 exit 0', async () => {
  // 指向一个不存在的 dataDir（没有 daemon.lock）
  const child = spawn(process.execPath, [HOOK], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, FOX_DOCK_DATA: path.join(dir, 'missing') },
  })
  const t0 = Date.now()
  child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }))
  const code = await new Promise((r) => child.on('close', r))
  assert.equal(code, 0)
  assert.ok(Date.now() - t0 < 1500)
})

test('hook: 坏 JSON → exit 0', async () => {
  const r = await runHook('{not-json')
  assert.equal(r.code, 0)
})

test('hook: stdin 一直不关闭 → 5s 兜底后 exit 0（fail-open 不挂住）', async () => {
  const child = spawn(process.execPath, [HOOK], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, FOX_DOCK_DATA: path.join(dir, 'missing') },
  })
  const t0 = Date.now()
  // 只写半截 JSON，永不 end()：模拟宿主输入异常/一直不关 stdin。
  child.stdin.write('{"hook_event_name":"UserPromptSubmit"')
  const killer = setTimeout(() => child.kill('SIGKILL'), 15000)
  const code = await new Promise((r) => child.on('close', r))
  clearTimeout(killer)
  const ms = Date.now() - t0
  try {
    child.stdin.destroy()
  } catch (err) {}
  assert.equal(code, 0)
  assert.ok(ms >= 4000 && ms < 12000, '应在 5s 兜底后退出而不是挂住，实际 ' + ms + 'ms')
})

test('hook: 非权限事件 → 转发 ingest 且 exit 0（快速返回）', async () => {
  lastIngest = null
  const r = await runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', tool_name: 'Bash', tool_input: 'ls' })
  assert.equal(r.code, 0)
  assert.ok(r.ms < 5000)
  assert.equal(lastIngest.event, 'turn_start')
  assert.equal(lastIngest.sessionId, 's1')
  assert.equal(r.stdout, '')
})

test('hook: 权限事件 + daemon 回 deny → exit 2 且 stderr 含固定文案', async () => {
  decision = 'deny'
  const r = await runHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: 'rm -rf build/' })
  assert.equal(r.code, 2)
  assert.ok(r.stderr.includes('已由 fox-dock 拒绝'))
  assert.equal(lastIngest.event, 'permission_request')
  assert.equal(lastIngest.wait.mode, 'decision')
  assert.ok(lastIngest.requestId.length >= 16 && lastIngest.requestId.length <= 40)
  assert.ok(lastIngest.wait.timeoutMs <= 27000, '等待不得超过钩子超时-3s')
})

test('hook: 宿主 riskLevel 透传给 daemon（本地规则表认不出也不丢宿主判定）', async () => {
  decision = 'deny'
  const r = await runHook({
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    tool_name: 'mcp__x__opaque_op',
    tool_input: 'opaque',
    riskLevel: 'high',
  })
  assert.equal(r.code, 2)
  assert.equal(lastIngest.event, 'permission_request')
  assert.equal(lastIngest.riskLevel, 'high')
})

test('hook: 权限事件不再把 tool_input 截到 2000 字（长前缀尾命令仍判高风险）', async () => {
  decision = 'deny'
  lastIngest = null
  const prefix = 'safe '.repeat(600)
  const r = await runHook(
    { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: prefix + ' && rm -rf /' },
    {}
  )
  assert.equal(r.code, 2)
  assert.ok(lastIngest, 'daemon 必须收到 ingest')
  assert.ok(lastIngest.toolInput.length > 2000, '不得在钩子侧截到 2000 字')
  assert.ok(lastIngest.toolInput.includes('rm -rf /'), '尾部命令不能被截掉')
  // 走 daemon 同一套校验 + 判定：riskPreview 保留尾部命令并判 high
  const v = validateIngest(
    { v: 1, agent: 'zcode', event: 'permission_request', sessionId: 's1', ...lastIngest },
    { now: Date.now() }
  )
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.ok(v.event.riskPreview.includes('rm -rf /'))
  const risk = assessRisk({ tool: v.event.tool, preview: v.event.riskPreview, cwd: 'D:\\proj\\demo' })
  assert.equal(risk.level, 'high', JSON.stringify(risk.reasons))
})

test('hook: 多字节 tool_input 按字节裁剪，body 不超过 ingest 的 16KB 上限', async () => {
  decision = 'deny'
  lastIngest = null
  lastBodyBytes = 0
  const long = '安全'.repeat(4000) // 8000 字符，UTF-8 约 24KB
  const r = await runHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: long })
  assert.equal(r.code, 2)
  assert.ok(lastIngest, 'body 必须被 daemon 接受（不能因超限 413）')
  assert.ok(lastBodyBytes <= 16 * 1024, 'body bytes=' + lastBodyBytes)
  assert.ok(lastIngest.toolInput.length > 2000, '比原来的 2000 字上限更长：' + lastIngest.toolInput.length)
})

test('hook: 权限事件 allow → 分支 A 输出探针采信的严格 JSON', async () => {
  decision = 'allow'
  const r = await runHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: 'ls' })
  assert.equal(r.code, 0)
  // P-2 真机结论（2026-10-25）：只有这个形状被 ZCode 采信（严格 schema，多余键作废）。
  const parsed = JSON.parse(r.stdout.trim())
  assert.deepEqual(parsed, { continue: true, decision: 'approve' })
})

test('hook: 分支 A 覆盖开关（FOX_DOCK_HOOK_ALLOW=0 关闭 → 静默交回宿主）', async () => {
  decision = 'allow'
  const r = await runHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: 'ls' }, { FOX_DOCK_HOOK_ALLOW: '0' })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
})

test('hook: takeover 关闭 → 仍上报 permission_request，但不带 wait、不等待决策', async () => {
  // 临时把 settings 改回关闭
  const origHandler = server.listenerCount('request')
  assert.ok(origHandler > 0)
  server.closeAllConnections?.()
  await new Promise((r) => server.close(r))
  let closedBody = null
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/v1/settings') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, settings: { permission: { takeover: false } } }))
        return
      }
      if (req.url === '/v1/ingest' && req.method === 'POST') {
        try {
          closedBody = JSON.parse(body)
        } catch (err) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, decision: 'allow' }))
    })
  })
  await new Promise((r) => server.listen(serverPort, '127.0.0.1', r))
  const t0 = Date.now()
  const r = await runHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: 'ls' })
  assert.equal(r.code, 0)
  assert.ok(Date.now() - t0 < 5000, '不应等待决策')
  // 关闭接管也必须上报：daemon 靠它标 waiting_permission / 触发「通知 + 跳转宿主」。
  // 但不带 wait，宿主原生弹窗立即兜底（fail-open）。
  assert.ok(closedBody, '关闭接管时仍应 POST /v1/ingest')
  assert.equal(closedBody.event, 'permission_request')
  assert.equal(closedBody.wait, undefined, '关闭接管时不得带 wait')
  assert.equal(r.stdout, '', '关闭接管时不得输出 allow JSON')
})

test('hook: 未知事件名 → exit 0 不外发', async () => {
  lastIngest = null
  const r = await runHook({ hook_event_name: 'SomethingElse', session_id: 's1' })
  assert.equal(r.code, 0)
  assert.equal(lastIngest, null)
})
