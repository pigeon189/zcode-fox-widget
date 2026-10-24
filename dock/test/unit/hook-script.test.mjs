// M5 §6.2 dock-hook.mjs：以子进程方式跑真脚本，喂 stdin 验证 fail-open 纪律。
import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(HERE, '..', '..', 'hooks', 'dock-hook.mjs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-hook-test-'))
fs.mkdirSync(path.join(dir, 'data'), { recursive: true })

let server = null
let serverPort = 0
let lastIngest = null
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

test('hook: 权限事件 allow → 分支 B 默认静默 exit 0（交回宿主）', async () => {
  decision = 'allow'
  const r = await runHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: 'ls' })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
})

test('hook: 权限事件 allow → 分支 A（FOX_DOCK_HOOK_ALLOW=1）输出严格 JSON', async () => {
  decision = 'allow'
  const r = await runHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_input: 'ls' }, { FOX_DOCK_HOOK_ALLOW: '1' })
  assert.equal(r.code, 0)
  const parsed = JSON.parse(r.stdout.trim())
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput'])
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow')
})

test('hook: takeover 关闭 → 权限事件不等待，直接 exit 0', async () => {
  // 临时把 settings 改回关闭
  const origHandler = server.listenerCount('request')
  assert.ok(origHandler > 0)
  server.closeAllConnections?.()
  await new Promise((r) => server.close(r))
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/v1/settings') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, settings: { permission: { takeover: false } } }))
        return
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
})

test('hook: 未知事件名 → exit 0 不外发', async () => {
  lastIngest = null
  const r = await runHook({ hook_event_name: 'SomethingElse', session_id: 's1' })
  assert.equal(r.code, 0)
  assert.equal(lastIngest, null)
})
