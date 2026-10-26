#!/usr/bin/env node
// fox-dock 宿主钩子（D035 / PLAN §6.2）：零依赖、单文件、永不阻塞宿主。
//
// 纪律：
//   · 任何异常 / 超时 / daemon 不在 → exit 0（fail-open，宿主原生弹窗兜底）；
//   · 非权限事件总耗时硬上限 300ms；
//   · 权限事件等待 min(设置等待时长, 30s 总预算扣掉已用时间后的剩余)，绝不越过钩子自身超时；
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
// 总预算从进程启动开始算：stdin 兜底可能先吃掉几秒，固定 -3s 会让
// 「stdin 5s + 等待 27s + 收尾」越过宿主 30s 上限。
const HOOK_STARTED_AT = Date.now()

// ── 权限事件的 tool_input 上报预算 ──
// daemon 用未脱敏的 toolInput（截到 8000 字）做高风险判定（ingest.mjs riskText），
// 钩子若先截到 2000 字，「长前缀 + 危险尾命令」会在 daemon 之前就被切掉。
// 但 POST /v1/ingest 有 16KB 体积上限：8000 个中文/emoji 字符按 UTF-8 会超过
// 它（整条事件会被 413 拒绝，连等待确认状态都上报不了）。所以这里按「字符上限
// 8000 + 序列化后字节上限 15KB」双重裁剪：ASCII 能完整送满 8000 字，多字节
// 文本按字节裁到上限内。
const RISK_INPUT_MAX_CHARS = 8000
const RISK_BODY_MAX_BYTES = 15 * 1024

// 按 UTF-8 字节安全截断（不把多字节字符切一半）。
function clipUtf8(text, maxBytes) {
  const s = String(text || '')
  const limit = Math.max(0, Math.floor(maxBytes))
  if (!limit || Buffer.byteLength(s, 'utf8') <= limit) return limit ? s : ''
  const buf = Buffer.from(s, 'utf8').subarray(0, limit)
  return buf.toString('utf8').replace(/\uFFFD+$/, '')
}

// 让含 toolInput 的 JSON body 不超过 ingest 上限；返回裁剪后的 toolInput。
function fitRiskInput(basePayload, rawText) {
  const source = String(rawText || '').slice(0, RISK_INPUT_MAX_CHARS)
  if (!source) return ''
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...basePayload, toolInput: '' }), 'utf8')
  let text = clipUtf8(source, RISK_BODY_MAX_BYTES - baseBytes)
  let bytes = Buffer.byteLength(JSON.stringify({ ...basePayload, toolInput: text }), 'utf8')
  // JSON 转义（引号/反斜杠/控制字符）会让字符串膨胀，按实际比例再缩。
  for (let i = 0; i < 4 && bytes > RISK_BODY_MAX_BYTES && text.length > 0; i++) {
    const next = Math.max(32, Math.floor(Buffer.byteLength(text, 'utf8') * (RISK_BODY_MAX_BYTES / bytes)) - 16)
    text = clipUtf8(text, next)
    bytes = Buffer.byteLength(JSON.stringify({ ...basePayload, toolInput: text }), 'utf8')
  }
  return text
}

// ── P-2 探针结论（2026-10-25 真机实测，详见 docs/dock/ADAPTERS.md）──
// ① stdin 双别名：tool_name/toolName、tool_input/toolInput、session_id/sessionId；
// ② stdout 允许：只有 {"continue":true,"decision":"approve"} 被采信
//    （hookSpecificOutput / 扁平 permissionDecision / decision.behavior 均无效）；
// ③ 拒绝走 exit 2 + stderr（文案透传给 agent）；stdout 的 deny 不被采信；
// ④ 原生确认卡片阻塞等待钩子（非并行）——等待时长可以放宽；
// ⑤ exit 0 无输出 → 原生弹窗照常出现（fail-open 兜底成立）。
// 分支开关：探针已确认支持 allow；FOX_DOCK_HOOK_ALLOW=0 可显式降级回分支 B。
const SUPPORTS_ALLOW = process.env.FOX_DOCK_HOOK_ALLOW !== '0'
const ALLOW_OUTPUT = JSON.stringify({ continue: true, decision: 'approve' })
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
    let timer = null
    const finish = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      // 必须把 stdin 句柄关掉：5s 兜底只 resolve 的话，宿主一直不关 stdin
      // （输入异常）时事件循环仍有活句柄，进程会挂住而不是 fail-open exit 0。
      try {
        process.stdin.pause()
      } catch (err) {}
      try {
        process.stdin.destroy()
      } catch (err) {}
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
    timer = setTimeout(finish, 5000)
    timer.unref?.()
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
  const toolInputFull = toolInputRaw == null ? '' : typeof toolInputRaw === 'string' ? toolInputRaw : JSON.stringify(toolInputRaw)
  // 非权限事件只带 2000 字；PermissionRequest 走 fitRiskInput（最多 8000 字，
  // 受 16KB body 上限约束）。
  const toolInput = toolInputFull.slice(0, 2000)
  const cwd = String((input && input.cwd) || '').slice(0, 400)
  // 宿主自报的风险等级（P-2 实测 PermissionRequest stdin 带 riskLevel）。
  // daemon 只拿它升级、不降级：本地规则表认不出的工具也不能丢掉宿主的结论。
  const riskLevel = String((input && input.riskLevel) || '').slice(0, 16)

  if (eventName === 'PermissionRequest') {
    const settings = await getSettings(lock)
    const perm = settings && settings.permission ? settings.permission : null
    // 接管关闭（默认）也必须上报：daemon 用它把会话标成 waiting_permission
    // 并驱动「通知 + 跳转宿主」（D036 / PLAN §6.2）。只是不带 wait——立即
    // exit 0 交回宿主原生弹窗，绝不阻塞。settings 读不到按关闭处理。
    const takeover = !!perm && perm.takeover === true
    const waitMs = Math.max(1000, Math.min(30000, Number(perm && perm.waitMs) || 15000))
    // 剩余预算按「30s − 已用时间 − 2s 收尾」算，stdin 慢或设置读取慢时自动缩短等待。
    const remaining = Math.max(1000, HOOK_TIMEOUT_MS - 2000 - (Date.now() - HOOK_STARTED_AT))
    const waitBudget = Math.min(waitMs, remaining)
    const requestId = crypto.randomUUID().replace(/-/g, '').slice(0, 32)
    const payload = {
      v: 1,
      agent: 'zcode',
      event: 'permission_request',
      sessionId,
      tool,
      cwd,
      requestId,
      riskLevel,
    }
    // 权限事件尽量把完整 tool_input 交给 daemon 的 8000 字风险判定文本（受
    // ingest 16KB 体积上限约束，见 fitRiskInput）；非权限事件仍只带 2000 字。
    payload.toolInput = fitRiskInput(payload, toolInputFull)
    if (takeover) payload.wait = { mode: 'decision', timeoutMs: waitBudget }
    // 关闭接管时只做一次快速上报（权限事件不受 300ms 非权限预算约束，
    // 但仍要远小于宿主弹窗的等待容忍度）。
    const r = await postIngest(lock, payload, takeover ? waitBudget + 500 : 2000)
    const decision = takeover && r ? r.body && r.body.decision : ''
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
