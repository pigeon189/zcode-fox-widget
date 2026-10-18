// ZCode 用量读取：直接查 <ZCODE_HOME>/cli/db/db.sqlite。
//
// ZCode 把每一轮、每一次模型调用的真实 usage 落库（model_usage 一行 = 一次调用），
// 语义与「每轮消耗」完全对应，不需要镜像账本。
//
// 口径与 ZCode 挂件线一致（这是硬要求，否则两处会显示两个数字）：
//   · 今日 = 本地零点起、status='completed' 的行
//   · 逐行按 pricing.costOfUsage 折算，预付池（plan / cmdgo）金额记 0、tokens 照算
//   · tokens 为 0 的行跳过
//   · 多币种不混加：分别累计，主币种 = 金额最大的那个

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { costOfUsage } from './pricing.mjs'
import { isPrepaidRow } from './prepaid.mjs'

const require = createRequire(import.meta.url)

let sqliteModule = null
let sqliteProbed = false

function loadSqlite() {
  if (sqliteProbed) return sqliteModule
  sqliteProbed = true
  try {
    // node:sqlite 自 Node 22.5 起内置
    sqliteModule = require('node:sqlite')
  } catch (err) {
    sqliteModule = null
  }
  return sqliteModule
}

export function defaultDbFile() {
  if (process.env.FOX_DOCK_ZCODE_DB) return process.env.FOX_DOCK_ZCODE_DB
  const home = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
  return path.join(home, 'cli', 'db', 'db.sqlite')
}

// ---------- 只读连接（复用 + 失败退避） ----------

const REOPEN_BACKOFF_MS = 5000
let conn = null
let connFile = ''
let stmts = null
let lastFailAt = 0

function closeConn() {
  try {
    if (conn) conn.close()
  } catch (err) {}
  conn = null
  stmts = null
  connFile = ''
}

function openDb(file) {
  if (conn && connFile === file) return conn
  if (conn && connFile !== file) closeConn()
  if (Date.now() - lastFailAt < REOPEN_BACKOFF_MS) return null
  if (!file || !fs.existsSync(file)) return null
  const sqlite = loadSqlite()
  if (!sqlite) return null
  try {
    conn = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 2000 })
    stmts = {
      since: conn.prepare(
        `SELECT model_id, provider_id, session_id, turn_id, started_at,
           input_tokens, output_tokens, reasoning_tokens,
           cache_read_input_tokens, cache_creation_input_tokens, computed_total_tokens
         FROM model_usage
         WHERE status = 'completed' AND started_at >= ? AND started_at < ?
         ORDER BY started_at`
      ),
      latestTurn: conn.prepare(
        `SELECT session_id, turn_id, COALESCE(completed_at, started_at) AS ts
         FROM turn_usage
         WHERE status = 'completed'
         ORDER BY COALESCE(completed_at, started_at) DESC
         LIMIT 1`
      ),
      turnRows: conn.prepare(
        `SELECT model_id, provider_id, started_at,
           input_tokens, output_tokens, reasoning_tokens,
           cache_read_input_tokens, cache_creation_input_tokens, computed_total_tokens
         FROM model_usage
         WHERE session_id = ? AND turn_id = ?`
      ),
    }
    connFile = file
    return conn
  } catch (err) {
    lastFailAt = Date.now()
    closeConn()
    return null
  }
}

export function startOfLocalDay(nowMs) {
  const d = new Date(Number(nowMs) || Date.now())
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function priceRows(rows) {
  const byCurrency = {}
  const byVendor = {}
  let tokens = 0
  let calls = 0
  let lastTs = 0
  for (const r of rows) {
    const c = costOfUsage(
      r.model_id,
      {
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        reasoning_tokens: r.reasoning_tokens,
        cache_read_input_tokens: r.cache_read_input_tokens,
        cache_creation_input_tokens: r.cache_creation_input_tokens,
        computed_total_tokens: r.computed_total_tokens,
      },
      Number(r.started_at) || Date.now(),
      r.provider_id
    )
    if (!c.tokens) continue
    const amount = isPrepaidRow(r.provider_id) ? 0 : c.amount
    const cur = c.currency || 'CNY'
    byCurrency[cur] = (byCurrency[cur] || 0) + amount
    // 按厂商拆分：面板里的「厂商分布」直接用这个，不再只给一个总金额。
    const vendor = String(c.vendor || 'unknown')
    const v = byVendor[vendor] || (byVendor[vendor] = { label: c.vendorLabel || vendor, byCurrency: {}, tokens: 0, calls: 0 })
    v.byCurrency[cur] = (v.byCurrency[cur] || 0) + amount
    v.tokens += c.tokens
    v.calls += 1
    tokens += c.tokens
    calls += 1
    lastTs = Math.max(lastTs, Number(r.started_at) || 0)
  }
  return { byCurrency, byVendor, tokens, calls, lastTs }
}

export function dominantCurrency(byCurrency) {
  const keys = Object.keys(byCurrency || {})
  if (!keys.length) return 'CNY'
  return keys.sort((a, b) => (byCurrency[b] || 0) - (byCurrency[a] || 0))[0]
}

// 读今日 + 上一轮。返回 { ok, today, lastTurn } 或 { ok:false, reason }
export function readUsage(opts = {}) {
  const file = opts.dbFile || defaultDbFile()
  const nowMs = Number(opts.now) || Date.now()
  if (!loadSqlite()) return { ok: false, reason: 'sqlite-unavailable', dbFile: file }
  if (!file || !fs.existsSync(file)) return { ok: false, reason: 'db-missing', dbFile: file }

  const db = openDb(file)
  if (!db) return { ok: false, reason: 'db-unavailable', dbFile: file }

  let rows = []
  try {
    // 默认「今日」；对账工具会用 since/until 指定任意一天
    const since = Number.isFinite(opts.since) ? opts.since : startOfLocalDay(nowMs)
    const until = Number.isFinite(opts.until) ? opts.until : Number.MAX_SAFE_INTEGER
    rows = stmts.since.all(since, until)
  } catch (err) {
    closeConn()
    return { ok: false, reason: 'db-read-failed', dbFile: file }
  }

  const today = priceRows(rows)

  let lastTurn = null
  try {
    const t = stmts.latestTurn.get()
    if (t) {
      const tr = priceRows(stmts.turnRows.all(t.session_id, t.turn_id))
      if (tr.calls > 0) {
        const cur = dominantCurrency(tr.byCurrency)
        lastTurn = {
          amount: tr.byCurrency[cur] || 0,
          currency: cur,
          tokens: tr.tokens,
          calls: tr.calls,
          at: Number(t.ts) || 0,
        }
      }
    }
  } catch (err) {
    closeConn()
    // 今日已经读到，上一轮失败不影响主数字
    lastTurn = null
  }

  return { ok: true, today, lastTurn, dbFile: file }
}

// 测试用：断掉连接（临时库被删/替换后重新打开）
export function _resetConnection() {
  closeConn()
  lastFailAt = 0
}
