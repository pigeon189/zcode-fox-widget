// Kimi Code 上下文取数（M2，@unverified-live：API 形状来自安装包调研与假服务测试）。
//
// 只连 Kimi Code 自己的本地服务（固定 127.0.0.1，端口来自
// ~/.kimi-code/server/instances/*.json）。Bearer 用 ~/.kimi-code/server.token——
// 这是本地服务令牌，不是 OAuth access_token；不写日志、不进响应。
//
// 若本地服务没开或没有实例文件 → reason='not-running'；401/403 → 'auth'；
// 响应形状不认识 → 'schema'；没有会话 → 'no-session'。
// 磁盘上的 sessions 目录格式没有样本，不解析会话文件。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { contextPct } from '../contracts.mjs'

export function defaultKimiHome(env = process.env) {
  return String(env.KIMI_CODE_HOME || '').trim() || path.join(os.homedir(), '.kimi-code')
}

export function discoverLocalServer(opts = {}) {
  const env = opts.env || process.env
  if (opts.baseUrl) {
    return { baseUrl: String(opts.baseUrl).replace(/\/+$/, ''), token: String(opts.token || ''), source: 'opts' }
  }
  const home = opts.home || defaultKimiHome(env)
  const instancesDir = path.join(home, 'server', 'instances')
  let files = []
  try {
    files = fs.readdirSync(instancesDir).filter((n) => n.endsWith('.json'))
  } catch (err) {
    return { reason: 'not-running' }
  }
  let best = null
  for (const name of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(instancesDir, name), 'utf8'))
      const port = Number(raw.port)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
      const hb = Number(raw.heartbeat_at) || 0
      if (!best || hb > best.hb) {
        best = {
          hb,
          port,
          host: raw.host === 'localhost' ? '127.0.0.1' : String(raw.host || '127.0.0.1'),
          pid: Number(raw.pid) || 0,
        }
      }
    } catch (err) {}
  }
  if (!best || best.host !== '127.0.0.1') return { reason: 'not-running' }
  let token = ''
  try {
    token = fs.readFileSync(path.join(home, 'server.token'), 'utf8').trim()
  } catch (err) {}
  if (!token) return { reason: 'auth' }
  return { baseUrl: 'http://127.0.0.1:' + best.port, token, source: 'instances', pid: best.pid }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function pickNum(obj, keys) {
  for (const k of keys) {
    const n = num(obj && obj[k])
    if (n !== null) return n
  }
  return null
}

function asArray(body) {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return []
  for (const k of ['sessions', 'data', 'items', 'list']) {
    if (Array.isArray(body[k])) return body[k]
  }
  return []
}

async function requestJson(baseUrl, token, p, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const res = await fetchImpl(baseUrl + p, {
    headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  let body = null
  try {
    body = await res.json()
  } catch (err) {}
  return { status: res.status, ok: res.ok, body }
}

export function parseStatusShape(status) {
  if (!status || typeof status !== 'object') return null
  const u = status.usage && typeof status.usage === 'object' ? status.usage : {}
  const used = pickNum(status, ['context_tokens', 'contextTokens', 'used', 'context_usage_tokens'])
  const fromUsage = pickNum(u, ['context_tokens', 'contextTokens', 'prompt_tokens', 'input_tokens'])
  const limit = pickNum(status, ['max_context_tokens', 'maxContextTokens', 'context_limit', 'context_window', 'contextWindow'])
  const model = String(status.model || status.model_id || u.model || '').slice(0, 80)
  const finalUsed = used !== null ? used : fromUsage
  if (finalUsed === null && limit === null) return null
  const breakdown = {}
  const input = pickNum(u, ['input_tokens', 'inputTokens'])
  const cacheRead = pickNum(u, ['cache_read_tokens', 'cacheReadTokens'])
  const cacheWrite = pickNum(u, ['cache_creation_tokens', 'cacheWriteTokens'])
  const output = pickNum(u, ['output_tokens', 'outputTokens'])
  const uncached = input !== null ? Math.max(0, input - (cacheRead || 0) - (cacheWrite || 0)) : null
  if (uncached) breakdown.input = uncached
  if (cacheRead) breakdown.cacheRead = cacheRead
  if (cacheWrite) breakdown.cacheWrite = cacheWrite
  if (output) breakdown.output = output
  return {
    used: finalUsed === null ? null : Math.max(0, Math.round(finalUsed)),
    limit: limit === null ? null : Math.max(0, limit),
    model,
    breakdown: Object.keys(breakdown).length ? breakdown : undefined,
    sessionId: String(status.session_id || status.sessionId || status.id || '').slice(0, 80),
    title: String(status.title || status.name || '').slice(0, 160),
    updatedAt: num(status.updated_at || status.updatedAt),
  }
}

// 上限兜底：config.toml 的 max_context_size + 安装包调研得到的窗口表
export function configLimitFallback(model, opts = {}) {
  const env = opts.env || process.env
  const home = opts.home || defaultKimiHome(env)
  let table = null
  try {
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8')
    const m = /max_context_size\s*=\s*(\d+)/.exec(toml)
    if (m) table = Number(m[1])
  } catch (err) {}
  const modelLower = String(model || '').toLowerCase()
  if (!Number.isFinite(table) || table <= 0) {
    if (modelLower.includes('256k')) table = 262144
    else if (modelLower.includes('highspeed')) table = 262144
    else table = 1048576
  }
  return table
}

export async function readKimiContext(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Date.now()
  const server = discoverLocalServer(opts)
  if (!server.baseUrl) return { supported: false, reason: server.reason || 'not-running' }
  const fetchImpl = opts.fetchImpl || fetch

  let list
  try {
    list = await requestJson(server.baseUrl, server.token, '/sessions', { fetchImpl, timeoutMs: opts.timeoutMs })
  } catch (err) {
    return { supported: false, reason: 'not-running' }
  }
  if (list.status === 401 || list.status === 403) return { supported: false, reason: 'auth' }
  if (!list.ok) return { supported: false, reason: list.status === 404 ? 'no-data' : 'schema' }

  const sessions = asArray(list.body)
  if (!sessions.length) {
    // 200 但既不是数组、也没有 sessions/data/items/list：形状不认识 → schema；
    // 明确的空列表才是 no-session。
    const body = list.body
    const known = body && typeof body === 'object' && ['sessions', 'data', 'items', 'list'].some((k) => Array.isArray(body[k]))
    if (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length && !known) {
      return { supported: false, reason: 'schema' }
    }
    return { supported: false, reason: 'no-session' }
  }

  // 选指定会话，或列表里最近更新的那个（字段名在版本间有差异，按时间兜底）。
  let picked = null
  if (opts.session) picked = sessions.find((s) => String(s.id || s.session_id || '') === String(opts.session)) || null
  if (!picked) {
    picked = sessions.slice().sort((a, b) => {
      const ta = Number(a.updated_at || a.updatedAt || a.last_active_at || 0)
      const tb = Number(b.updated_at || b.updatedAt || b.last_active_at || 0)
      return tb - ta
    })[0]
  }
  if (!picked) return { supported: false, reason: 'no-session' }
  const sessionId = String(picked.id || picked.session_id || picked.sessionId || '')

  let status = null
  if (sessionId) {
    try {
      const r = await requestJson(server.baseUrl, server.token, '/sessions/' + encodeURIComponent(sessionId) + '/status', {
        fetchImpl,
        timeoutMs: opts.timeoutMs,
      })
      if (r.status === 401 || r.status === 403) return { supported: false, reason: 'auth' }
      if (r.ok) status = r.body
    } catch (err) {
      return { supported: false, reason: 'not-running' }
    }
  }

  const parsed = parseStatusShape(status) || parseStatusShape(picked)
  if (!parsed) return { supported: false, reason: 'schema' }
  const model = parsed.model || String(picked.model || '')
  const limit = parsed.limit || configLimitFallback(model, opts)
  const used = parsed.used === null ? null : parsed.used
  if (used === null) return { supported: false, reason: 'no-data' }

  return {
    supported: true,
    confidence: parsed.limit ? 'exact' : 'derived',
    sessionId: parsed.sessionId || sessionId,
    title: parsed.title || String(picked.title || ''),
    model,
    limit,
    limitSource: parsed.limit ? 'host' : 'config',
    used,
    breakdown: parsed.breakdown,
    points: [],
    updatedAt: parsed.updatedAt || Number(picked.updated_at || picked.updatedAt) || now,
  }
}

export async function listKimiSessions(opts = {}) {
  const server = discoverLocalServer(opts)
  if (!server.baseUrl) return []
  try {
    const r = await requestJson(server.baseUrl, server.token, '/sessions', { fetchImpl: opts.fetchImpl || fetch })
    if (!r.ok) return []
    const raw = asArray(r.body).slice(0, Math.max(1, Math.min(20, Number(opts.limit) || 8)))
    return Promise.all(
      raw.map(async (s) => {
        const id = String(s.id || s.session_id || s.sessionId || '')
        let status = null
        if (id) {
          try {
            const one = await requestJson(server.baseUrl, server.token, '/sessions/' + encodeURIComponent(id) + '/status', {
              fetchImpl: opts.fetchImpl || fetch,
              timeoutMs: opts.timeoutMs,
            })
            if (one.ok) status = one.body
          } catch (err) {}
        }
        const p = parseStatusShape(status) || parseStatusShape(s) || {}
        const limit = p.limit || configLimitFallback(p.model || s.model, opts)
        const used = p.used === null || p.used === undefined ? null : p.used
        return {
          id,
          title: String(p.title || s.title || s.name || ''),
          model: String(p.model || s.model || ''),
          used,
          limit,
          pct: used === null ? null : contextPct(used, limit),
          requests: Number(s.turn_count || s.turns || 0) || 0,
          updatedAt: Number(s.updated_at || s.updatedAt || 0) || 0,
        }
      })
    )
  } catch (err) {
    return []
  }
}
