// WorkBuddy 上下文取数（M2）。
//
// 首选 ~/.workbuddy/workbuddy.db：
//   session_usage(session_id, used, size, updated_at, credit_json)
//   sessions(id, title, custom_title, model, context_window, updated_at, deleted_at)
// `used` 是最后一次请求的 prompt_tokens（含缓存）；`size` 才是该会话的上下文上限
// （同模型存在 300k 与 1M 两种，必须以 size 为准），缺失时才回落 context_window。
//
// 库不存在时退回 transcript 的 providerData.rawUsage.prompt_tokens（只有 used，
// 上限未知 → pct=null，UI 只显示绝对值）。

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { contextPct } from '../contracts.mjs'

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
  if (env.FOX_DOCK_WORKBUDDY_DB) return env.FOX_DOCK_WORKBUDDY_DB
  const home = env.CODEBUDDY_HOME || path.join(os.homedir(), '.workbuddy')
  return path.join(home, 'workbuddy.db')
}

export function defaultProjectsDir(env = process.env) {
  if (env.FOX_DOCK_WORKBUDDY_PROJECTS) return env.FOX_DOCK_WORKBUDDY_PROJECTS
  const home = env.CODEBUDDY_HOME || path.join(os.homedir(), '.workbuddy')
  return path.join(home, 'projects')
}

const connections = new Map()
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
      latest: db.prepare(
        `SELECT su.session_id, su.used, su.size, su.updated_at,
                s.title, s.custom_title, s.model, s.context_window, s.updated_at AS session_updated
         FROM session_usage su
         LEFT JOIN sessions s ON s.id = su.session_id
         WHERE COALESCE(s.deleted_at, 0) = 0 AND su.used > 0
         ORDER BY su.updated_at DESC LIMIT 1`
      ),
      byId: db.prepare(
        `SELECT su.session_id, su.used, su.size, su.updated_at,
                s.title, s.custom_title, s.model, s.context_window, s.updated_at AS session_updated
         FROM session_usage su
         LEFT JOIN sessions s ON s.id = su.session_id
         WHERE su.session_id = ? LIMIT 1`
      ),
      sessions: db.prepare(
        `SELECT su.session_id, su.used, su.size, su.updated_at,
                s.title, s.custom_title, s.model, s.context_window
         FROM session_usage su
         LEFT JOIN sessions s ON s.id = su.session_id
         WHERE COALESCE(s.deleted_at, 0) = 0 AND su.used > 0
         ORDER BY su.updated_at DESC LIMIT ?`
      ),
    }
    const conn = { db, stmts }
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
}

function titleOf(row) {
  return String(row.custom_title || row.title || '').slice(0, 160)
}

function limitOf(row) {
  const size = Number(row.size)
  if (Number.isFinite(size) && size > 0) return { limit: size, source: 'host' }
  const cw = Number(row.context_window)
  if (Number.isFinite(cw) && cw > 0) return { limit: cw, source: 'config' }
  return { limit: null, source: 'unknown' }
}

// transcript 兜底：找最近修改的一个 .jsonl，读尾部最后一个 rawUsage.prompt_tokens。
export function readTranscriptContext({ projectsDir, maxBytes = 8 * 1024 * 1024 } = {}) {
  let best = null
  try {
    for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const sub = path.join(projectsDir, d.name)
      let names = []
      try {
        names = fs.readdirSync(sub)
      } catch (err) {
        continue
      }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue
        const p = path.join(sub, n)
        try {
          const st = fs.statSync(p)
          if (!best || st.mtimeMs > best.mtimeMs) best = { file: p, size: st.size, mtimeMs: st.mtimeMs }
        } catch (err) {}
      }
    }
  } catch (err) {
    return null
  }
  if (!best) return null
  const start = Math.max(0, best.size - maxBytes)
  let text = ''
  try {
    const fd = fs.openSync(best.file, 'r')
    try {
      const buf = Buffer.alloc(best.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    return null
  }
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('rawUsage')) continue
    try {
      const o = JSON.parse(line)
      const raw = o && o.providerData && o.providerData.rawUsage
      const used = Number(raw && raw.prompt_tokens)
      if (!Number.isFinite(used) || used <= 0) continue
      const ts = Date.parse(String(o.timestamp || ''))
      return {
        used,
        model: String((o.providerData && o.providerData.model) || ''),
        updatedAt: Number.isFinite(ts) ? ts : best.mtimeMs,
        file: best.file,
      }
    } catch (err) {}
  }
  return null
}

export function readWorkbuddyContext(opts = {}) {
  const env = opts.env || process.env
  const dbFile = opts.dbFile || defaultDbFile(env)
  const now = typeof opts.now === 'function' ? opts.now() : Date.now()
  const conn = openDb(dbFile)
  if (conn) {
    try {
      const row = opts.session ? conn.stmts.byId.get(String(opts.session)) : conn.stmts.latest.get()
      if (row && Number(row.used) > 0) {
        const lim = limitOf(row)
        return {
          supported: true,
          confidence: 'exact',
          sessionId: String(row.session_id),
          title: titleOf(row),
          model: String(row.model || ''),
          limit: lim.limit,
          limitSource: lim.source,
          used: Math.max(0, Number(row.used) || 0),
          points: [],
          updatedAt: Number(row.updated_at) || Number(row.session_updated) || now,
        }
      }
      return { supported: false, reason: 'no-session' }
    } catch (err) {
      return { supported: false, reason: 'schema', error: String((err && err.message) || err).slice(0, 200) }
    }
  }

  const tail = readTranscriptContext({ projectsDir: opts.projectsDir || defaultProjectsDir(env), maxBytes: opts.maxBytes })
  if (!tail) return { supported: false, reason: 'no-data' }
  return {
    supported: true,
    confidence: 'derived',
    sessionId: '',
    title: '',
    model: tail.model,
    limit: null,
    limitSource: 'unknown',
    used: tail.used,
    points: [],
    updatedAt: tail.updatedAt || now,
  }
}

export function listWorkbuddySessions(opts = {}) {
  const env = opts.env || process.env
  const conn = openDb(opts.dbFile || defaultDbFile(env))
  if (!conn) return []
  try {
    return conn.stmts.sessions.all(Math.max(1, Math.min(20, Number(opts.limit) || 8))).map((row) => {
      const lim = limitOf(row)
      return {
        id: String(row.session_id),
        title: titleOf(row),
        model: String(row.model || ''),
        used: Number(row.used) || 0,
        limit: lim.limit,
        pct: contextPct(Number(row.used) || 0, lim.limit),
        requests: 0,
        updatedAt: Number(row.updated_at) || 0,
      }
    })
  } catch (err) {
    return []
  }
}
