// ZCode 上下文取数（M2）。
//
// 口径（与方案 §3.1.3 一致）：
//   · used = 主会话最后一条 status='completed' 的 computed_total_tokens
//     （input + output；input 已含 cache read/write，**不再重复加**）
//   · limit 优先级：zcode-builtin.json 的 modelRules → cc-models.txt →
//     litellm.json.max_input_tokens → 内置 200k
//   · 子 agent 各有独立 session；只看 parent_id IS NULL 的主会话
//   · 趋势点直接取宿主历史（model_usage 多行），不依赖 daemon 一直在线
//
// 所有查询都走只读连接 + busy_timeout；schema 漂移时返回 reason='schema'，
// 不让 daemon 崩。

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { contextPct } from '../contracts.mjs'
import { zcodeDataBase } from '../../engines/paths.mjs'

const require = createRequire(import.meta.url)
let sqliteModule = null
let sqliteProbed = false

function loadSqlite() {
  if (sqliteProbed) return sqliteModule
  sqliteProbed = true
  try {
    sqliteModule = require('node:sqlite')
  } catch (err) {
    sqliteModule = null
  }
  return sqliteModule
}

export function defaultDbFile(env = process.env) {
  if (env.FOX_DOCK_ZCODE_DB) return env.FOX_DOCK_ZCODE_DB
  const home = env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
  return path.join(home, 'cli', 'db', 'db.sqlite')
}

// ---------- 上限配置 ----------

const LIMIT_CACHE_MS = 60_000
let limitCache = { at: 0, key: '', value: null }

function dataRoots(env = process.env) {
  const roots = []
  // 测试会传入自己的 env 对象；只有真实进程环境才回退到 ~/.zcode/whale 的
  // runtime-env.json，避免测试误读开发机上的数据目录。
  const base = String(env.ZCODE_DATA_BASE_DIR || '').trim() || (env === process.env ? zcodeDataBase(env) : '')
  if (base) {
    roots.push(path.join(base, '.zcode'))
    roots.push(base)
  }
  const home = env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
  roots.push(home)
  return [...new Set(roots.map((p) => path.resolve(p)))]
}

function walkLimited(dir, { maxDepth = 7, maxEntries = 4000 } = {}) {
  const out = []
  let seen = 0
  const stack = [{ dir, depth: 0 }]
  while (stack.length) {
    const { dir: d, depth } = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch (err) {
      continue
    }
    for (const e of entries) {
      if (++seen > maxEntries) return out
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: p, depth: depth + 1 })
      } else {
        out.push(p)
      }
    }
  }
  return out
}

function latestVersionDir(runtimeRoot) {
  try {
    const names = fs.readdirSync(runtimeRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    names.sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] || 0) - (pa[i] || 0)
        if (d) return d
      }
      return 0
    })
    return names[0] ? path.join(runtimeRoot, names[0]) : ''
  } catch (err) {
    return ''
  }
}

export function parseBuiltinRules(json) {
  const rules = json && json.config && json.config.modelConfigRules && json.config.modelConfigRules.modelRules
  if (!Array.isArray(rules)) return []
  const out = []
  for (const rule of rules) {
    if (!rule || typeof rule.modelMatch !== 'string') continue
    const props = rule.config && rule.config.properties
    const window = props && Number(props.contextWindow)
    if (!Number.isFinite(window) || window <= 0) continue
    try {
      out.push({ re: new RegExp(rule.modelMatch, 'i'), window })
    } catch (err) {}
  }
  return out
}

export function parseCcModels(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([^|#]+?)\s*\|\s*[^|]*\|\s*(\d+)\s*$/.exec(line)
    if (!m) continue
    const n = Number(m[2])
    if (Number.isFinite(n) && n > 0) out.push({ model: m[1].trim().toLowerCase(), window: n })
  }
  return out
}

function loadLimitSources(env = process.env) {
  const files = { builtin: [], ccModels: [], litellm: [] }
  for (const root of dataRoots(env)) {
    const runtime = latestVersionDir(path.join(root, 'v2', 'runtime', 'provider', 'windows-x86_64'))
    if (runtime) {
      for (const p of walkLimited(runtime, { maxDepth: 3, maxEntries: 2000 })) {
        if (path.basename(p) === 'zcode-builtin.json') files.builtin.push(p)
      }
    }
    const ws = path.join(root, 'workspace', 'default')
    const cc = path.join(ws, 'cc-models.txt')
    if (fs.existsSync(cc)) files.ccModels.push(cc)
    const litellm = path.join(ws, 'litellm.json')
    if (fs.existsSync(litellm)) files.litellm.push(litellm)
  }
  return files
}

export function resolveContextLimit(model, opts = {}) {
  const env = opts.env || process.env
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const key = model + '|' + dataRoots(env).join(';')
  if (limitCache.value && limitCache.key === key && now - limitCache.at < LIMIT_CACHE_MS) return limitCache.value
  const files = opts.files || loadLimitSources(env)
  const modelLower = String(model || '').toLowerCase()
  let value = null

  for (const file of files.builtin || []) {
    try {
      const rules = parseBuiltinRules(JSON.parse(fs.readFileSync(file, 'utf8')))
      // 规则按顺序叠加；后匹配到的 contextWindow 覆盖前者（更具体的规则通常在后）
      for (const rule of rules) if (rule.re.test(model)) value = { limit: rule.window, source: 'host' }
      if (value) break
    } catch (err) {}
  }

  if (!value) {
    for (const file of files.ccModels || []) {
      try {
        const rows = parseCcModels(fs.readFileSync(file, 'utf8'))
        const hit = rows.find((r) => r.model === modelLower) || rows.find((r) => modelLower.includes(r.model))
        if (hit) {
          value = { limit: hit.window, source: 'config' }
          break
        }
      } catch (err) {}
    }
  }

  if (!value) {
    for (const file of files.litellm || []) {
      try {
        const json = JSON.parse(fs.readFileSync(file, 'utf8'))
        const row = json && json[model]
        const n = row && Number(row.max_input_tokens)
        if (Number.isFinite(n) && n > 0) {
          value = { limit: n, source: 'config' }
          break
        }
      } catch (err) {}
    }
  }

  if (!value) value = { limit: 200000, source: 'builtin-table' }
  limitCache = { at: now, key, value }
  return value
}

// ---------- 只读连接 ----------

const connections = new Map() // file -> { db, stmts, at }
let lastFailAt = 0

function openDb(file) {
  if (!file || !fs.existsSync(file)) return null
  const sqlite = loadSqlite()
  if (!sqlite) return null
  const hit = connections.get(file)
  if (hit) return hit
  if (Date.now() - lastFailAt < 5000) return null
  try {
    const db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 2000 })
    const stmts = {
      latestSession: db.prepare(
        `SELECT id, title, time_updated, time_compacting
         FROM session
         WHERE parent_id IS NULL AND COALESCE(time_archived, 0) = 0
         ORDER BY time_updated DESC LIMIT 1`
      ),
      sessionById: db.prepare(`SELECT id, title, time_updated, time_compacting FROM session WHERE id = ?`),
      lastUsage: db.prepare(
        `SELECT turn_id, model_id, provider_id, input_tokens, output_tokens, reasoning_tokens,
                cache_read_input_tokens, cache_creation_input_tokens, computed_total_tokens,
                COALESCE(completed_at, started_at) AS ts, context_exceeded
         FROM model_usage
         WHERE session_id = ? AND status = 'completed' AND computed_total_tokens > 0
         ORDER BY COALESCE(completed_at, started_at) DESC LIMIT 1`
      ),
      points: db.prepare(
        `SELECT COALESCE(completed_at, started_at) AS ts, computed_total_tokens AS used
         FROM model_usage
         WHERE session_id = ? AND status = 'completed' AND computed_total_tokens > 0
         ORDER BY COALESCE(completed_at, started_at) DESC LIMIT 240`
      ),
      sessions: db.prepare(
        `SELECT s.id, s.title, s.time_updated,
           (SELECT m.model_id FROM model_usage m
             WHERE m.session_id = s.id AND m.status = 'completed'
             ORDER BY COALESCE(m.completed_at, m.started_at) DESC LIMIT 1) AS model_id,
           (SELECT m.computed_total_tokens FROM model_usage m
             WHERE m.session_id = s.id AND m.status = 'completed'
             ORDER BY COALESCE(m.completed_at, m.started_at) DESC LIMIT 1) AS used,
           (SELECT COUNT(*) FROM model_usage m
             WHERE m.session_id = s.id AND m.status = 'completed') AS requests
         FROM session s
         WHERE s.parent_id IS NULL AND COALESCE(s.time_archived, 0) = 0
         ORDER BY s.time_updated DESC LIMIT ?`
      ),
    }
    const conn = { db, stmts, at: Date.now() }
    connections.set(file, conn)
    return conn
  } catch (err) {
    lastFailAt = Date.now()
    return null
  }
}

export function _resetContextConnection() {
  for (const c of connections.values()) {
    try {
      c.db.close()
    } catch (err) {}
  }
  connections.clear()
  lastFailAt = 0
  limitCache = { at: 0, key: '', value: null }
}

function breakdownOf(row) {
  const out = {}
  const input = Number(row.input_tokens) || 0
  const cacheRead = Number(row.cache_read_input_tokens) || 0
  const cacheWrite = Number(row.cache_creation_input_tokens) || 0
  const output = Number(row.output_tokens) || 0
  const reasoning = Number(row.reasoning_tokens) || 0
  const uncached = Math.max(0, input - cacheRead - cacheWrite)
  if (uncached) out.input = uncached
  if (cacheRead) out.cacheRead = cacheRead
  if (cacheWrite) out.cacheWrite = cacheWrite
  if (output) out.output = output
  if (reasoning) out.reasoning = reasoning
  return Object.keys(out).length ? out : undefined
}

export function readZcodeContext(opts = {}) {
  const env = opts.env || process.env
  const file = opts.dbFile || defaultDbFile(env)
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  if (!loadSqlite()) return { supported: false, reason: 'no-data', error: 'node:sqlite 不可用' }
  if (!fs.existsSync(file)) return { supported: false, reason: 'no-data' }
  const conn = openDb(file)
  if (!conn) return { supported: false, reason: 'schema' }

  try {
    let session = null
    if (opts.session) session = conn.stmts.sessionById.get(String(opts.session)) || null
    else session = conn.stmts.latestSession.get() || null
    if (!session) return { supported: false, reason: 'no-session' }

    const last = conn.stmts.lastUsage.get(session.id)
    if (!last) return { supported: false, reason: 'no-session', sessionId: session.id, title: String(session.title || '') }

    const points = conn.stmts.points
      .all(session.id)
      .map((r) => ({ t: Number(r.ts) || 0, used: Number(r.used) || 0 }))
      .filter((p) => p.t > 0)
      .reverse()
    const lim = resolveContextLimit(last.model_id, { env, now })
    const used = Math.max(0, Number(last.computed_total_tokens) || 0)
    const compaction = session.time_compacting
      ? { count: 1, lastAt: Number(session.time_compacting), derived: true }
      : undefined
    return {
      supported: true,
      confidence: 'exact',
      sessionId: String(session.id),
      title: String(session.title || ''),
      model: String(last.model_id || ''),
      limit: lim.limit,
      limitSource: lim.source,
      used,
      breakdown: breakdownOf(last),
      compaction,
      points,
      updatedAt: Number(last.ts) || Number(session.time_updated) || now,
    }
  } catch (err) {
    try {
      conn.db.close()
    } catch (e) {}
    connections.delete(file)
    return { supported: false, reason: 'schema', error: String((err && err.message) || err).slice(0, 200) }
  }
}

export function listZcodeSessions(opts = {}) {
  const env = opts.env || process.env
  const file = opts.dbFile || defaultDbFile(env)
  const now = typeof opts.now === 'function' ? opts.now() : Date.now()
  const conn = openDb(file)
  if (!conn) return []
  try {
    return conn.stmts.sessions
      .all(Math.max(1, Math.min(20, Number(opts.limit) || 8)))
      .filter((s) => Number(s.used) > 0)
      .map((s) => {
        const lim = resolveContextLimit(s.model_id, { env, now })
        return {
          id: String(s.id),
          title: String(s.title || ''),
          model: String(s.model_id || ''),
          used: Number(s.used) || 0,
          limit: lim.limit,
          pct: contextPct(Number(s.used) || 0, lim.limit),
          requests: Number(s.requests) || 0,
          updatedAt: Number(s.time_updated) || 0,
        }
      })
  } catch (err) {
    return []
  }
}
