#!/usr/bin/env node
// fox-dock 宿主钩子（D035 / PLAN §6.2）：零依赖、单文件、永不阻塞宿主。
//
// 纪律：
//   · 任何异常 / 超时 / daemon 不在 → exit 0（fail-open，宿主原生弹窗兜底）；
//   · 非权限事件总耗时硬上限 300ms；
//   · 权限事件等待 min(设置等待时长, 钩子超时-3s)，绝不越过钩子自身超时；
//   · 拒绝 = exit 2 + stderr；允许 = 分支 A 输出探针确认的 JSON / 分支 B 静默
//     （交回宿主原生弹窗）；
//   · 只挂低频事件（见 integrations/zcode-plugin/hooks.json），不挂 Pre/PostToolUse。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// ── 以下两个常量与 integrations/zcode-plugin/hooks.json 保持一致 ──
const HOOK_TIMEOUT_MS = 30000
const NON_PERMISSION_BUDGET_MS = 300

// ── P-2 探针结论回填处 ─────────────────────────────────────────────
// 真机探针确认「stdout JSON 能表达 allow」后把 SUPPORTS_ALLOW 改为 true，
// 并按探针接受的形状调整 ALLOW_OUTPUT（严格 schema，多余键即校验失败）。
// 结论与依据记录在 docs/dock/ADAPTERS.md 实时信号矩阵。
const SUPPORTS_ALLOW = process.env.FOX_DOCK_HOOK_ALLOW === '1'
const ALLOW_OUTPUT = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'allow' } })
const DENY_MESSAGE = '已由 fox-dock 拒绝'

function dataDir() {
  const direct = String(process.env.FOX_DOCK_DATA || '').trim()
  if (direct) return path.resolve(direct)
  const base =
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'fox-dock')
}

function readDaemonLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir(), 'daemon.lock'), 'utf8'))
    const port = Number(raw.port)
    const token = String(raw.token || '')
    if (Number.isFinite(port) && port > 0 && token) return { port, token }
  } catch (err) {}
  return null
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try {
        resolve(Buffer.concat(chunks).toString('utf8'))
      } catch (err) {
        resolve('')
      }
    }
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
    // stdin 异常挂起时兜底（钩子总时长红线之外的最后防线）
    setTimeout(finish, 5000).unref?.()
  })
}

// 不用 process.exit：Windows 上 fetch keep-alive 未断时硬退出会触发 fail-fast。
// 统一「设置 exitCode + connection: close + 让事件循环自然排空」。
class HookExit extends Error {}
function bye(code) {
  process.exitCode = code
  throw new HookExit('hook exit ' + code)
}

function exit0() {
  process.exitCode = 0
  throw new HookExit('hook exit 0')
}

async function postIngest(lock, payload, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(50, timeoutMs))
  try {
    const res = await fetch('http://127.0.0.1:' + lock.port + '/v1/ingest', {
      method: 'POST',
      headers: { 'x-fox-token': lock.token, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    const text = await res.text()
    try {
      return { status: res.status, body: JSON.parse(text) }
    } catch (err) {
      return { status: res.status, body: null }
    }
  } catch (err) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function getSettings(lock) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), NON_PERMISSION_BUDGET_MS)
  try {
    const res = await fetch('http://127.0.0.1:' + lock.port + '/v1/settings', {
      headers: { 'x-fox-token': lock.token, connection: 'close' },
      signal: ctrl.signal,
    })
    const body = await res.json()
    return body && body.settings ? body.settings : null
  } catch (err) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const raw = await readStdin()
  let input = null
  try {
    input = raw ? JSON.parse(raw) : null
  } catch (err) {
    exit0()
  }
  const eventName = String((input && input.hook_event_name) || '')
  const lock = readDaemonLock()
  if (!lock || !eventName) exit0()

  const sessionId = String((input && input.session_id) || '').slice(0, 80) || 'hook'
  const tool = String((input && input.tool_name) || '').slice(0, 80)
  const toolInputRaw = input && input.tool_input
  const toolInput = toolInputRaw == null ? '' : typeof toolInputRaw === 'string' ? toolInputRaw.slice(0, 2000) : JSON.stringify(toolInputRaw).slice(0, 2000)
  const cwd = String((input && input.cwd) || '').slice(0, 400)

  if (eventName === 'PermissionRequest') {
    const settings = await getSettings(lock)
    const perm = settings && settings.permission ? settings.permission : null
    if (!perm || perm.takeover !== true) exit0()
    const waitMs = Math.max(1000, Math.min(30000, Number(perm.waitMs) || 15000))
    const budget = Math.max(1000, HOOK_TIMEOUT_MS - 3000)
    const requestId = crypto.randomUUID().replace(/-/g, '').slice(0, 32)
    const r = await postIngest(
      lock,
      {
        v: 1,
        agent: 'zcode',
        event: 'permission_request',
        sessionId,
        tool,
        toolInput,
        cwd,
        requestId,
        wait: { mode: 'decision', timeoutMs: Math.min(waitMs, budget) },
      },
      Math.min(waitMs, budget) + 2000
    )
    const decision = r && r.body && r.body.decision
    if (decision === 'deny') {
      process.stderr.write(DENY_MESSAGE + '\n')
      bye(2)
    }
    if (decision === 'allow' && SUPPORTS_ALLOW) {
      process.stdout.write(ALLOW_OUTPUT + '\n')
      bye(0)
    }
    // allow（分支 B）/ timeout / ignored / 任何异常 → 交回宿主原生弹窗
    exit0()
  }

  // 低频事件：turn_start / turn_end / error。300ms 预算内发不出去就放弃。
  const eventMap = { UserPromptSubmit: 'turn_start', Stop: 'turn_end', PostToolUseFailure: 'error' }
  const event = eventMap[eventName]
  if (!event) exit0()
  await postIngest(lock, { v: 1, agent: 'zcode', event, sessionId, tool, toolInput, cwd }, NON_PERMISSION_BUDGET_MS)
  exit0()
}

main().catch((err) => {
  if (!(err instanceof HookExit)) process.exitCode = 0
})
