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
import { costOfUsage } from '../../engines/pricing.mjs'
import { buildStats, tzOffsetMs } from '../stats.mjs'
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

function expandHome(p, homeDir) {
  const s = String(p || '').trim()
  if (!s) return ''
  if (s === '~') return homeDir
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(homeDir, s.slice(2))
  return s
}

// ZCode 支持在 ~/.zcode/cli/config.json 里覆盖 storage.dir / storage.sessionDbPath；
// 默认路径是 <storage.dir 或 ~/.zcode>/cli/db/db.sqlite。统计页要跟宿主读同一个库。
export function defaultDbFile() {
  if (process.env.FOX_DOCK_ZCODE_DB) return process.env.FOX_DOCK_ZCODE_DB
  const home = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'cli', 'config.json'), 'utf8'))
    const storage = cfg && typeof cfg.storage === 'object' ? cfg.storage : {}
    const dir = expandHome(storage.dir, home)
    const db = expandHome(storage.sessionDbPath, home)
    if (db) return path.isAbsolute(db) ? db : path.resolve(dir || home, db)
    if (dir) return path.join(dir, 'cli', 'db', 'db.sqlite')
  } catch (err) {}
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
      // 回合进行中 turn_usage 还没有 completed 行，但 model_usage 已经按每次
      // 调用逐条写入；当前厂商必须以这条最新调用为准，否则会沿用上一个完成
      // 回合的厂商（表现为对话中余额卡停在旧厂商，回合结束才切换）。
      latestModel: conn.prepare(
        `SELECT provider_id, model_id
         FROM model_usage
         WHERE status = 'completed' AND computed_total_tokens > 0
         ORDER BY started_at DESC
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
  const byProvider = {}
  let tokens = 0
  let calls = 0
  let lastTs = 0
  let lastProvider = ''
  let lastModel = ''
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
    // provider 是「用户实际在用哪家」的权威线索（如 commandcode / deepseek），
    // 厂商余额与主数字口径据此选择；rows 按 started_at 升序，最后一行即最近一次。
    const pid = String(r.provider_id || '')
    if (pid) {
      const p = byProvider[pid] || (byProvider[pid] = { calls: 0, tokens: 0 })
      p.calls += 1
      p.tokens += c.tokens
      lastProvider = pid
      lastModel = String(r.model_id || '')
    }
    tokens += c.tokens
    calls += 1
    lastTs = Math.max(lastTs, Number(r.started_at) || 0)
  }
  return { byCurrency, byVendor, byProvider, tokens, calls, lastTs, lastProvider, lastModel }
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
          // 上一轮实际走的 provider（CommandCode / DeepSeek …），气泡与面板
          // 据此决定显示哪家的余额。
          provider: tr.lastProvider || '',
          model: tr.lastModel || '',
        }
      }
    }
  } catch (err) {
    closeConn()
    // 今日已经读到，上一轮失败不影响主数字
    lastTurn = null
  }

  // 当前厂商取「最近一次真实调用」，而不是最近一个 completed 回合：
  // 进行中的回合还没有 completed 的 turn_usage 行，但新厂商的第一次调用
  // 已经落进 model_usage，余额卡应当在对话中就切换。
  let live = null
  try {
    const m = stmts.latestModel.get()
    if (m && m.provider_id) live = { provider: String(m.provider_id), model: String(m.model_id || '') }
  } catch (err) {
    // 读不到就退回回合/今日口径，不影响主数字
  }

  return {
    ok: true,
    today,
    lastTurn,
    lastProvider: (live && live.provider) || (lastTurn && lastTurn.provider) || today.lastProvider || '',
    lastModel: (live && live.model) || (lastTurn && lastTurn.model) || today.lastModel || '',
    dbFile: file,
  }
}

// 应用用量统计：对齐 ZCode 客户端 usage/stats 的 queryAppUsage。
// 返回统一 stats 契约；DB 不可用时明确返回 unsupported，不补 0。
export function readAppStats(opts = {}) {
  const file = opts.dbFile || defaultDbFile()
  const now = Number(opts.now) || Date.now()
  const until = Number.isFinite(opts.until) ? opts.until : now
  const since = Number.isFinite(opts.since) ? opts.since : 0
  const offset = Number.isFinite(opts.tzOffsetMs) ? opts.tzOffsetMs : tzOffsetMs(now)
  const range = ['all', '7d', '30d'].includes(opts.range) ? opts.range : 'all'
  const sqlite = loadSqlite()
  if (!sqlite) return { supported: false, range, reason: 'sqlite-unavailable', note: '当前 Node 没有 node:sqlite（需 ≥ 22.5）' }
  if (!file || !fs.existsSync(file)) return { supported: false, range, reason: 'db-missing', note: '找不到 ZCode 用量库' }
  // 统计查询单独开连接：老版本 ZCode 没有 tool_usage/telemetry 列时，
  // 只让统计页降级，不能把今日/上一轮快照一起拖垮。
  let db = null
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 5000 })
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(computed_total_tokens), 0) AS totalTokens,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
           COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheCreationTokens,
           COALESCE(SUM(cache_read_input_tokens), 0) AS cacheReadTokens,
           COUNT(*) AS modelRequestCount,
           COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS modelErrorCount,
           AVG(time_to_first_token_ms) AS avgTimeToFirstTokenMs
         FROM model_usage WHERE started_at >= ? AND started_at <= ?`
      )
      .get(since, until)
    const turns = db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS totalSessions,
           COUNT(*) AS totalTurns,
           AVG(CASE WHEN status = 'completed' THEN duration_ms END) AS avgTurnDurationMs
         FROM turn_usage WHERE started_at >= ? AND started_at <= ?`
      )
      .get(since, until)
    const longest = db
      .prepare(
        `SELECT COALESCE(MAX(sessionDurationMs), 0) AS longestSessionMs FROM (
           SELECT COALESCE(SUM(CASE WHEN status = 'completed' THEN duration_ms ELSE 0 END), 0) AS sessionDurationMs
           FROM turn_usage WHERE started_at >= ? AND started_at <= ?
           GROUP BY session_id
         )`
      )
      .get(since, until)
    const tools = db
      .prepare(
        `SELECT COUNT(*) AS toolCallCount,
           COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS toolErrorCount
         FROM tool_usage WHERE started_at >= ? AND started_at <= ?`
      )
      .get(since, until)
    const models = db
      .prepare(
        `SELECT model_id AS modelId,
           COALESCE(SUM(computed_total_tokens), 0) AS totalTokens,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COUNT(*) AS requestCount
         FROM model_usage WHERE started_at >= ? AND started_at <= ?
         GROUP BY model_id ORDER BY totalTokens DESC`
      )
      .all(since, until)
    const toolList = db
      .prepare(
        `SELECT tool_name AS toolName, COUNT(*) AS callCount,
           COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errorCount,
           AVG(duration_ms) AS avgDurationMs
         FROM tool_usage WHERE started_at >= ? AND started_at <= ?
         GROUP BY tool_name ORDER BY callCount DESC`
      )
      .all(since, until)
    const days = [
      ...db.prepare(`SELECT CAST((started_at + ?) / ? AS INTEGER) AS dayIndex,
           COALESCE(SUM(computed_total_tokens), 0) AS totalTokens
         FROM model_usage WHERE started_at >= ? AND started_at <= ? GROUP BY dayIndex`).all(offset, 86400000, since, until),
      ...db.prepare(`SELECT CAST((started_at + ?) / ? AS INTEGER) AS dayIndex, COUNT(*) AS turnCount
         FROM turn_usage WHERE started_at >= ? AND started_at <= ? GROUP BY dayIndex`).all(offset, 86400000, since, until),
      ...db.prepare(`SELECT CAST((started_at + ?) / ? AS INTEGER) AS dayIndex, COUNT(*) AS toolCallCount
         FROM tool_usage WHERE started_at >= ? AND started_at <= ? GROUP BY dayIndex`).all(offset, 86400000, since, until),
    ]
    const dayModels = db
      .prepare(
        `SELECT CAST((started_at + ?) / ? AS INTEGER) AS dayIndex,
           model_id AS modelId,
           COALESCE(SUM(computed_total_tokens), 0) AS totalTokens
         FROM model_usage WHERE started_at >= ? AND started_at <= ?
         GROUP BY dayIndex, model_id`
      )
      .all(offset, 86400000, since, until)
    return buildStats({
      range,
      now,
      since,
      until,
      tzOffsetMs: offset,
      source: 'zcode:db.sqlite',
      unit: 'tokens',
      totals: {
        ...totals,
        // ZCode 的 input_tokens 不含缓存命中（实测 cache_read 会大于 input）。
        // 统计页把输入侧还原成「含缓存」，cacheHitRate 才有正确的分母。
        inputTokens: Number(totals.inputTokens) + Number(totals.cacheReadTokens),
        avgTimeToFirstTokenMs: totals.avgTimeToFirstTokenMs == null ? null : Number(totals.avgTimeToFirstTokenMs),
      },
      turns: {
        ...turns,
        avgTurnDurationMs: turns.avgTurnDurationMs == null ? null : Number(turns.avgTurnDurationMs),
        longestSessionMs: Number(longest && longest.longestSessionMs) || 0,
      },
      tools,
      models,
      toolList,
      days,
      dayModels,
    })
  } catch (err) {
    return { supported: false, range, reason: 'db-read-failed', note: 'ZCode 用量库读取失败' }
  } finally {
    try {
      if (db) db.close()
    } catch (err) {}
  }
}

// 测试用：断掉连接（临时库被删/替换后重新打开）
export function _resetConnection() {
  closeConn()
  lastFailAt = 0
}
