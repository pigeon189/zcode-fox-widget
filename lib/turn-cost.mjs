// 每轮对话消耗：读取 ZCode 自己记录的 turn 用量并换算成金额。
//
// 上游 DSH 版监听宿主进程的 session/event 事件流（assistant/message 带真实
// usage，turn/end 时结算）。ZCode 插件拿不到进程内事件，但 ZCode 会把每一轮
// 的真实 token 用量落库到 <ZCODE_HOME>/cli/db/db.sqlite 的 turn_usage 表，
// 语义完全对应，所以这里改为查询该表；数据库不可用时回退到模型 I/O 日志。
//
// 计价按 model_usage 的**逐模型行**聚合：一轮里多个模型（快模型 + 主模型、
// 重试尝试）各占一行、各带完整 token 分桶，按行分别计价后求和——旧版只取
// 该轮最后一个模型，混合模型的轮次金额会算错。
//
// 数据库连接是持久只读的：服务每秒轮询一次，旧版每拍新开连接+重编译语句，
// 现改为复用连接与 prepared statement；连接出错自动关闭重建（带退避）。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DB_FILE, ROLLOUT_DIR } from './paths.mjs'
import { costOfUsage } from './pricing.mjs'

const require = createRequire(import.meta.url)
const TAIL_BYTES = 256 * 1024
const REOPEN_BACKOFF_MS = 5000

let sqliteModule = null
let sqliteProbed = false

function loadSqlite() {
  if (sqliteProbed) return sqliteModule
  sqliteProbed = true
  try {
    // node:sqlite 自 Node 22.5 起内置；拿不到就退回日志解析。
    sqliteModule = require('node:sqlite')
  } catch (err) {
    sqliteModule = null
  }
  return sqliteModule
}

// ---------- 持久只读连接 ----------

let dbConn = null
let statements = null
let lastOpenFailAt = 0

function openDb() {
  if (dbConn) return dbConn
  if (!fs.existsSync(DB_FILE)) return null
  if (Date.now() - lastOpenFailAt < REOPEN_BACKOFF_MS) return null
  const sqlite = loadSqlite()
  if (!sqlite) return null
  try {
    dbConn = new sqlite.DatabaseSync(DB_FILE, { readOnly: true, timeout: 2000 })
    statements = {
      latestTurn: dbConn.prepare(LATEST_TURN_QUERY),
      modelRows: dbConn.prepare(MODEL_ROWS_QUERY),
    }
  } catch (err) {
    lastOpenFailAt = Date.now()
    closeDb()
    return null
  }
  return dbConn
}

function closeDb() {
  try {
    if (dbConn) dbConn.close()
  } catch (err) {}
  dbConn = null
  statements = null
}

const LATEST_TURN_QUERY = `
  SELECT t.session_id, t.turn_id,
    COALESCE(t.completed_at, t.started_at) AS ts
  FROM turn_usage t
  WHERE t.status = 'completed'
  ORDER BY COALESCE(t.completed_at, t.started_at) DESC
  LIMIT 1
`

// 该轮的全部模型行：各带完整 token 分桶；token 全为 0 的行（纯失败尝试）
// 由调用方按「无消耗」跳过。errored 行只要有 token 就计——厂商侧已按实际
// 处理量扣费，漏掉反而低估。
const MODEL_ROWS_QUERY = `
  SELECT model_id, provider_id, status,
    input_tokens, output_tokens, reasoning_tokens,
    cache_read_input_tokens, cache_creation_input_tokens, computed_total_tokens
  FROM model_usage
  WHERE session_id = ? AND turn_id = ?
  ORDER BY started_at, attempt_index
`

function readFromDatabase() {
  const conn = openDb()
  if (!conn) return null
  let turnRow = null
  let rows = []
  try {
    turnRow = statements.latestTurn.get()
    if (!turnRow) return null
    rows = statements.modelRows.all(turnRow.session_id, turnRow.turn_id)
  } catch (err) {
    // 句柄失效（库被重建/迁移）时丢弃连接，下一拍自动重开
    closeDb()
    return null
  }
  const models = []
  let amount = 0
  let tokens = 0
  let peak = false
  let billableRows = 0
  let lastModelId = ''
  let lastProviderId = ''
  const totals = { hit: 0, miss: 0, cacheWrite: 0, output: 0 }
  const tsMs = Number(turnRow.ts) || Date.now()
  for (const r of rows) {
    const usage = {
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      reasoning_tokens: r.reasoning_tokens,
      cache_read_input_tokens: r.cache_read_input_tokens,
      cache_creation_input_tokens: r.cache_creation_input_tokens,
      computed_total_tokens: r.computed_total_tokens,
    }
    const c = costOfUsage(r.model_id, usage, tsMs, r.provider_id)
    if (!c.tokens) continue // 纯失败且没有处理任何 token 的行不进统计
    amount += c.amount
    tokens += c.tokens
    peak = peak || c.peak
    if (c.billable) billableRows += 1
    totals.hit += c.breakdown.hit
    totals.miss += c.breakdown.miss
    totals.cacheWrite += c.breakdown.cacheWrite
    totals.output += c.breakdown.output
    models.push({
      providerId: r.provider_id || '',
      model: r.model_id || '',
      status: r.status || '',
      tokens: c.tokens,
      amount: c.amount,
      billable: c.billable,
      vendor: c.vendor,
      vendorLabel: c.vendorLabel,
      tier: c.tier,
      peak: c.peak,
      breakdown: c.breakdown,
      rates: c.rates,
    })
    lastModelId = r.model_id || lastModelId
    lastProviderId = r.provider_id || lastProviderId
  }
  // 轮级口径：金额可加总；billable 取「存在可计价行」；vendor 展示主行（消耗最大的行）的
  return {
    source: 'turn_usage',
    sessionId: turnRow.session_id,
    turnId: turnRow.turn_id,
    ts: tsMs,
    model: lastModelId,
    providerId: lastProviderId,
    amount,
    tokens,
    peak,
    tier: models.length ? pickDominant(models).tier : 'none',
    billable: billableRows > 0,
    vendor: models.length ? pickDominant(models).vendor : null,
    vendorLabel: models.length ? pickDominant(models).vendorLabel : '无用量',
    breakdown: totals,
    models,
  }
}

// 消耗最大的模型行作为该轮的「主模型」（展示用；金额仍按行加总）
function pickDominant(models) {
  let best = models[0]
  for (const m of models) {
    if (m.amount > best.amount || (m.amount === best.amount && m.tokens > best.tokens)) best = m
  }
  return best
}

// 回退路径：模型 I/O 日志每行是一次模型请求，取最后一笔主对话的 usage。
function readFromRollout() {
  let entries = []
  try {
    entries = fs
      .readdirSync(ROLLOUT_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && /^model-io-.*\.jsonl$/.test(e.name))
      .map((e) => {
        const full = path.join(ROLLOUT_DIR, e.name)
        try {
          return { full, mtime: fs.statSync(full).mtimeMs }
        } catch (err) {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
  } catch (err) {
    return null
  }
  for (const entry of entries) {
    let text = ''
    try {
      const stat = fs.statSync(entry.full)
      const start = Math.max(0, stat.size - TAIL_BYTES)
      const fd = fs.openSync(entry.full, 'r')
      try {
        const buf = Buffer.alloc(stat.size - start)
        fs.readSync(fd, buf, 0, buf.length, start)
        text = buf.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      continue
    }
    const lines = text.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      let o
      try {
        o = JSON.parse(lines[i])
      } catch (err) {
        continue // 截断的首行必然不完整，跳过
      }
      const usage = o && o.response && o.response.usage
      const role = o && o.model && o.model.role
      if (!usage || role !== 'main') continue
      const modelId = (o.model && o.model.modelId) || (o.response && o.response.modelId) || ''
      const providerId = (o.model && o.model.providerId) || ''
      const c = costOfUsage(modelId, usage, Date.parse(o.completedAt) || Date.now(), providerId)
      return {
        source: 'rollout',
        sessionId: o.sessionId || '',
        turnId: o.turnId || '',
        ts: Date.parse(o.completedAt) || Date.now(),
        model: modelId,
        providerId,
        amount: c.amount,
        tokens: c.tokens,
        peak: c.peak,
        tier: c.tier,
        billable: c.billable,
        vendor: c.vendor,
        vendorLabel: c.vendorLabel,
        breakdown: c.breakdown,
        models: [
          {
            providerId,
            model: modelId,
            status: 'completed',
            tokens: c.tokens,
            amount: c.amount,
            billable: c.billable,
            vendor: c.vendor,
            vendorLabel: c.vendorLabel,
            tier: c.tier,
            peak: c.peak,
            breakdown: c.breakdown,
            rates: c.rates,
          },
        ],
      }
    }
  }
  return null
}

// 返回最近一轮完成的消耗，已换算金额（不可计价供应商 amount=0、billable=false，
// tokens 与逐模型明细仍然可用）。读不到数据时返回 ok:false 但仍是结构化结果，
// 前端不会因此报错。
export function readLatestTurn() {
  const raw = readFromDatabase() || readFromRollout()
  if (!raw) {
    return { ok: false, reason: 'no-turn-data' }
  }
  return { ok: true, ...raw }
}

// 上游用「seq 递增」让前端识别新的一轮。这里由识别 (session, turn) 是否变化
// 得到同样的效果，而且服务重启后不会把旧轮次误判成新的。
export function turnIdentity(current) {
  if (!current || !current.ok) return ''
  return current.sessionId + '/' + current.turnId
}

export { costOfUsage }
