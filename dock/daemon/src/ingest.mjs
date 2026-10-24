// POST /v1/ingest 协议 v1（D037）：公开给内置 shim 与自定义 agent。
//
// 校验原则：
//   · 逐字段挑，不用对象展开；未知字段丢弃；
//   · 字符串先 slice 再正则；数字必须 Number.isFinite 且 >= 0；
//   · 自定义 agent 上限 8 个；超出 429；
//   · 令牌桶 50 req/s、突发 100；
//   · 任何输入都只能得到 ok:true 或确定的 4xx，绝不抛异常。
//
// 真实性与来源：内置 agent 的 origin 记 local-log；自定义 agent 一律
// unknown/estimated（它自己报的数无法验证），且不参与跨 agent 汇总。

import crypto from 'node:crypto'
import { redact } from '../../shared/redact.mjs'

export const INGEST_EVENTS = [
  'session_start',
  'turn_start',
  'tool_start',
  'tool_end',
  'waiting_input',
  'permission_request',
  'permission_resolved',
  'turn_end',
  'error',
  'usage',
]
export const BUILTIN_AGENTS = ['zcode', 'workbuddy', 'kimi', 'dsh']
export const MAX_CUSTOM_AGENTS = 8
export const MAX_BODY_BYTES = 16 * 1024
export const RATE_PER_SEC = 50
export const RATE_BURST = 100
export const MAX_SKEW_MS = 5 * 60_000

const AGENT_RE = /^[a-z][a-z0-9-]{1,23}$/
const SESSION_RE = /^[A-Za-z0-9._:-]{1,80}$/
const REQUEST_RE = /^[A-Za-z0-9_-]{16,40}$/

const customAgents = new Set()
const seen = new Map() // fingerprint -> at
let bucket = { tokens: RATE_BURST, at: 0 }

export function resetIngestState() {
  customAgents.clear()
  seen.clear()
  bucket = { tokens: RATE_BURST, at: 0 }
}

export function customAgentCount() {
  return customAgents.size
}

export function rateAllowed(nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now()
  if (!bucket.at) bucket.at = now
  const elapsed = Math.max(0, now - bucket.at) / 1000
  bucket.tokens = Math.min(RATE_BURST, bucket.tokens + elapsed * RATE_PER_SEC)
  bucket.at = now
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

function text(v, max) {
  return String(v == null ? '' : v).slice(0, max)
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function bad(error) {
  return { ok: false, error, status: 400 }
}

// body 已由调用方限制体积并 JSON.parse。返回 { ok, event } 或 { ok:false,error,status }。
export function validateIngest(body, opts = {}) {
  const now = Number(opts.now) || Date.now()
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null
  if (!b) return bad('bad-body')
  if (b.v !== 1) return bad('bad-field:v')
  const agent = text(b.agent, 24)
  if (!AGENT_RE.test(agent)) return bad('bad-field:agent')
  const isBuiltin = BUILTIN_AGENTS.includes(agent)
  if (!isBuiltin && !customAgents.has(agent)) {
    if (customAgents.size >= MAX_CUSTOM_AGENTS) return { ok: false, error: 'too-many-agents', status: 429 }
    customAgents.add(agent)
  }
  const event = text(b.event, 32)
  if (!INGEST_EVENTS.includes(event)) return bad('bad-field:event')
  const sessionId = text(b.sessionId, 80)
  if (!SESSION_RE.test(sessionId)) return bad('bad-field:sessionId')

  const turnId = text(b.turnId, 80)
  let at = numOrNull(b.at)
  let skew = 0
  if (at !== null && Math.abs(at - now) > MAX_SKEW_MS) {
    skew = 1
    at = null
  }
  const clean = {
    v: 1,
    agentId: agent,
    isBuiltin,
    event,
    sessionId,
    turnId,
    at: at === null ? now : Math.round(at),
    serverAt: now,
    skew,
    title: text(b.title, 200),
    cwd: text(b.cwd, 400),
    model: text(b.model, 80),
    provider: text(b.provider, 80),
    tool: text(b.tool, 80),
    preview: b.toolInput == null ? '' : redact(b.toolInput, 400),
    requestId: '',
    timeoutMs: 15000,
    usage: null,
    cost: null,
    decision: '',
  }

  if (event === 'permission_request') {
    const rid = text(b.requestId, 40)
    if (!REQUEST_RE.test(rid)) return bad('bad-field:requestId')
    clean.requestId = rid
    const wait = b.wait && typeof b.wait === 'object' ? b.wait : null
    if (wait) {
      if (wait.mode !== 'decision') return bad('bad-field:wait')
      const t = numOrNull(wait.timeoutMs)
      clean.timeoutMs = t === null ? 15000 : Math.max(1, Math.min(30000, Math.round(t)))
    }
  }
  if (event === 'permission_resolved') {
    const d = text(b.decision, 16)
    if (d && !['allow', 'deny', 'timeout', 'ignored'].includes(d)) return bad('bad-field:decision')
    clean.decision = d
    clean.requestId = text(b.requestId, 40)
  }

  if (b.usage && typeof b.usage === 'object') {
    const u = {}
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
      const n = numOrNull(b.usage[k])
      if (n !== null) u[k] = Math.round(n)
    }
    clean.usage = Object.keys(u).length ? u : null
  }
  if (b.cost && typeof b.cost === 'object') {
    const amount = numOrNull(b.cost.amount)
    const currency = text(b.cost.currency, 8).toUpperCase()
    if (amount !== null && /^[A-Z]{3,8}$/.test(currency)) {
      clean.cost = { amount: Math.round(amount * 10000) / 10000, currency }
    }
  }

  // 幂等：同 agent/session/event/at/requestId/tool 在 60s 内重复 → duplicate。
  const fp = crypto
    .createHash('sha1')
    .update([agent, sessionId, event, clean.at, clean.requestId, clean.tool, clean.usage ? JSON.stringify(clean.usage) : ''].join('|'))
    .digest('hex')
  const prev = seen.get(fp)
  if (prev && now - prev < 60_000) return { ok: true, event: clean, duplicate: true }
  seen.set(fp, now)
  if (seen.size > 1000) {
    for (const [k, v] of seen) {
      if (now - v > 60_000) seen.delete(k)
      if (seen.size <= 800) break
    }
  }
  return { ok: true, event: clean, duplicate: false }
}

// 旧挂件 /v1/events 的 type → ingest event。
export function mapLegacyEvent(type, agentId) {
  const t = String(type || '')
  const map = {
    'permission-request': 'permission_request',
    'user-prompt': 'turn_start',
    'user-prompt-submit': 'turn_start',
    'turn-start': 'turn_start',
    'turn-end': 'turn_end',
    'tool-start': 'tool_start',
    'tool-end': 'tool_end',
    'waiting-input': 'waiting_input',
    error: 'error',
    usage: 'usage',
  }
  return {
    v: 1,
    agent: BUILTIN_AGENTS.includes(String(agentId || '')) ? String(agentId) : 'zcode',
    event: map[t] || 'turn_start',
    sessionId: 'legacy',
  }
}
