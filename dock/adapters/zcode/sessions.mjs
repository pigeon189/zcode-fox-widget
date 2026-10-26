// ZCode 会话层（D034）：列表 / 详情 / 实时状态 / 用量行。
//
// 数据源：~/.zcode/cli/db/db.sqlite 的 session / model_usage / turn_usage /
// tool_usage。连接只读并复用；老版本缺表时逐项降级（不崩、不补 0）。
//
// 状态判定（M0 P-1 结论：库内没有「进行中」取值——实测 model_usage /
// turn_usage 只有 completed/error/cancelled 终态行，进行中的调用与回合
// 都不落行；只有 tool_usage 有 running）：
//   · 钩子注入的 working 由 LiveTracker 维护，这里只做库推断；
//   · tool_usage 有 running 行（10 分钟窗口内）→ working；
//   · 最新 model 行晚于最新回合结束（回合内的调用，回合行还没落）且距其
//     开始/完成 90s 内 → working（inferred）：思考、工具切换的阶段间隙
//     没有新行是常态，20s 窗口会把回合中途误判成空闲（状态横跳）；
//   · 最新 model_usage.status='error' 且之后没有新行 → error；
//   · 最新回合 completed 且 4s 内 → done，否则 idle（回合结束证据，'db'）；
//   · 没有回合表（老库）只能按静默推断的 idle 标 'inferred'，实时层的
//     滞回据此区分「静默推断」与「回合结束证据」。

import { createRequire } from 'node:module'
import fs from 'node:fs'
import { costOfUsage } from '../../engines/pricing.mjs'
import { isUnpriced, pricingUnavailable, withCostProv } from '../../daemon/src/cost-prov.mjs'
import { isPrepaidBilling } from './prepaid.mjs'
import {
  compareSessionToCursor,
  compareSessionsForSort,
  cursorOf,
  displayStatusOf,
  normalizeArchivedMode,
  normalizeSession,
  parseCursor,
  summarizeSession,
} from '../../shared/session-model.mjs'
import { defaultDbFile } from './context.mjs'

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

const connections = new Map()
const MAX_CONNECTIONS = 4
const DONE_HOLD_MS = 4000
// 回合内保持 working 的静默阈值（问题 6「状态横跳」）：库内没有 running 的
// 回合行，长工具执行完到下一次模型请求落库之间可以超过 90s。带回合结束证据
// 的路径不受这里影响；这个窗口只用于「最新 model 行晚于上一回合结束」的在跑
// 回合，放宽到 10 分钟，避免工具刚结束、首字未到就闪成空闲。钩子可用时由
// LiveTracker 的 turnActive 精确覆盖。
const WORKING_HOLD_MS = 10 * 60_000
// tool_usage 的 running 行是在途证据（宿主崩溃才会残留）。窗口从 5 分钟
// 放宽到 10 分钟，与 live-reduce expire 的在途工具保护上限同口径：终端
// 工具单次执行几分钟是常态，不能在 5–10 分钟之间先被误判空闲、下一次
// 轮询又被 running 行拉回工作中。
const RUNNING_TOOL_WINDOW_MS = 10 * 60_000
const RUNNING_VALUES = new Set(['running', 'pending', 'in_progress', 'in-progress', 'streaming', 'active'])

export function _resetZcodeSessions() {
  for (const c of connections.values()) {
    try {
      c.db.close()
    } catch (err) {}
  }
  connections.clear()
}

function tablesOf(db) {
  try {
    return new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => String(r.name)))
  } catch (err) {
    return new Set()
  }
}

function columnsOf(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name))
  } catch (err) {
    return []
  }
}

function openDb(file) {
  if (!file || !fs.existsSync(file)) return null
  const hit = connections.get(file)
  if (hit) return hit
  const sqlite = loadSqlite()
  if (!sqlite) return null
  let db = null
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 3000 })
    const tables = tablesOf(db)
    if (!tables.has('session') && !tables.has('model_usage')) {
      db.close()
      return null
    }
    const sessionCols = tables.has('session') ? columnsOf(db, 'session') : []
    const modelCols = tables.has('model_usage') ? columnsOf(db, 'model_usage') : []
    // 标题生成 / 校验请求不属于对话回合，不能改变会话状态。
    const liveSource = modelCols.includes('query_source')
      ? ` AND (query_source IS NULL OR query_source NOT IN ('session_title','goal_summary_title','target_completion_verification'))`
      : ''
    const mLiveSource = modelCols.includes('query_source')
      ? ` AND (m.query_source IS NULL OR m.query_source NOT IN ('session_title','goal_summary_title','target_completion_verification'))`
      : ''
    const has = (table) => tables.has(table)
    const conn = {
      db,
      tables,
      sessionCols,
      cache: new Map(),
      // 查询按「表是否存在」预编译；缺表时返回空数组。
      stmts: {},
    }
    if (has('session')) {
      const parent = sessionCols.includes('parent_id') ? 's.parent_id' : 'NULL AS parent_id'
      const title = sessionCols.includes('title') ? 's.title' : "'' AS title"
      const updated = sessionCols.includes('time_updated') ? 's.time_updated' : 'NULL AS time_updated'
      const created = sessionCols.includes('time_created') ? 's.time_created' : 'NULL AS time_created'
      const cwdCol = ['cwd', 'directory', 'workdir', 'working_directory'].find((c) => sessionCols.includes(c))
      const cwd = cwdCol ? `s.${cwdCol}` : 'NULL AS cwd'
      const hasArchived = sessionCols.includes('time_archived')
      const archivedSel = hasArchived ? 'COALESCE(s.time_archived, 0) AS timeArchived' : '0 AS timeArchived'
      // session.time_updated 会被标题等元数据更新，不能单独当作「新回合已开始」；
      // 最新消息时间才是用户/助手确实产生了新内容的信号。
      // session.time_updated 会被标题等元数据更新；最近消息时间才是「新回合
      // 已开始」的信号。按会话聚合一次，避免 sessions 每行做相关子查询。
      conn.stmts.lastMessageAll = has('message')
        ? db.prepare(
            `SELECT session_id AS sessionId, MAX(time_created) AS at
             FROM message WHERE time_created >= ? GROUP BY session_id`
          )
        : null
      // 归档三态用固定 SQL 片段（archived 已白名单校验），按模式懒编译。
      conn.sessionSelect = `SELECT s.id AS sessionId, ${title}, ${parent}, ${cwd}, ${updated}, ${created}, ${archivedSel}`
      conn.sessionHasArchived = hasArchived
      conn.stmts.sessionById = db.prepare(
        `${conn.sessionSelect} FROM session s WHERE s.id = ? LIMIT 1`
      )
      // 归档三态需要看见「祖先已归档」的子会话：子会话自己的 time_archived
      // 可能为空，但它必须随父。先取一个窗口内的全部行，再按父链判定。
      conn.stmts.allSessions = db.prepare(
        `${conn.sessionSelect} FROM session s ORDER BY COALESCE(s.time_updated, 0) DESC LIMIT ?`
      )
      // 轻量归档索引：自身或祖先已归档的会话 id。用递归 CTE 从归档根向下
      // 展开，不受「前 N 行」窗口影响（大库里近期归档的会话不会漏）。
      conn.stmts.archivedTree = hasArchived
        ? db.prepare(
            sessionCols.includes('parent_id')
              ? `WITH RECURSIVE archived(id) AS (
                   SELECT id FROM session WHERE COALESCE(time_archived, 0) > 0
                   UNION
                   SELECT s.id FROM session s JOIN archived a ON s.parent_id = a.id
                 )
                 SELECT id AS sessionId FROM archived`
              : `SELECT id AS sessionId FROM session WHERE COALESCE(time_archived, 0) > 0`
          )
        : null
    }
    if (has('model_usage')) {
      conn.stmts.models = db.prepare(
        // 按「整点桶」分组（D054 审计）：计价要看调用发生时的峰谷档位，
        // 把整个会话/模型压成一行再用最后一笔时间计价，会让跨峰谷的用量全部
        // 按最后那笔的档位算（实测同一会话差 3%）。DeepSeek 的峰谷边界
        // （PEAK_HOURS 为整点、周末谷价生效分界在 UTC 16:00）都落在整点，
        // 所以按 UTC 整点桶聚合既能逐笔精确计价，又不会退化成逐行开销。
        `SELECT session_id AS sessionId, model_id AS modelId, provider_id AS providerId,
           COALESCE(SUM(computed_total_tokens), 0) AS total,
           COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(output_tokens), 0) AS output,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
           COALESCE(SUM(cache_read_input_tokens), 0) AS cacheRead,
           COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheWrite,
           COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
           COUNT(*) AS calls,
           MAX(started_at) AS lastAt,
           MIN(started_at) AS bucketAt
         FROM model_usage
         GROUP BY session_id, model_id, provider_id, CAST(started_at / 3600000 AS INTEGER)`
      )
      conn.stmts.lastUsage = db.prepare(
        `SELECT session_id AS sessionId, model_id AS modelId, provider_id AS providerId, status, started_at AS at,
           COALESCE(completed_at, started_at) AS doneAt
         FROM model_usage WHERE session_id = ?${liveSource} ORDER BY started_at DESC LIMIT 1`
      )
      conn.stmts.usageBySession = db.prepare(
        `SELECT session_id AS sessionId, model_id AS modelId, provider_id AS providerId, status,
           started_at AS at, COALESCE(completed_at, started_at) AS doneAt,
           input_tokens AS input, output_tokens AS output, reasoning_tokens AS reasoning,
           cache_read_input_tokens AS cacheRead, cache_creation_input_tokens AS cacheWrite,
           computed_total_tokens AS total
         FROM model_usage WHERE started_at >= ? AND started_at <= ? ORDER BY started_at`
      )
      conn.stmts.usageRows = db.prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, model_id AS modelId, provider_id AS providerId,
           status, started_at AS at,
           input_tokens AS input, output_tokens AS output, reasoning_tokens AS reasoning,
           cache_read_input_tokens AS cacheRead, cache_creation_input_tokens AS cacheWrite,
           computed_total_tokens AS total
         FROM model_usage WHERE started_at >= ? AND started_at <= ? ORDER BY started_at LIMIT 200000`
      )
      // 一次扫描拿每个会话的最新调用（避免按会话逐条全表扫，200k 行时差 20s+）
      conn.stmts.lastModelAll = db.prepare(
        `SELECT m.session_id AS sessionId, m.status AS status, m.started_at AS at,
           COALESCE(m.completed_at, m.started_at) AS doneAt
         FROM model_usage m
         JOIN (SELECT session_id, MAX(started_at) AS mx FROM model_usage WHERE 1=1${liveSource} GROUP BY session_id) x
           ON x.session_id = m.session_id AND x.mx = m.started_at
         WHERE 1=1${mLiveSource}`
      )
      // 回合明细的成本必须按 (模型, provider, 整点桶) 分组后再汇总：旧实现
      // 用 MAX(model_id) 把整轮 token 压给一个模型，混合模型回合（主模型 + 快模型、
      // 换模型、子代理不同模型）会整体乘错价（D054 审计）。这里保留分组行，
      // 由 getSessionDetail 逐组计价后按 turnId 汇总。
      conn.stmts.turnsFallback = db.prepare(
        `SELECT turn_id AS turnId, session_id AS sessionId, model_id AS modelId, provider_id AS providerId,
           MIN(started_at) AS bucketAt,
           MIN(started_at) AS startedAt,
           MAX(COALESCE(completed_at, started_at)) AS endedAt,
           COALESCE(SUM(computed_total_tokens), 0) AS tokens,
           COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
           COALESCE(SUM(cache_read_input_tokens), 0) AS cacheRead,
           COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheWrite,
           COUNT(*) AS calls,
           MAX(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS hasError
         FROM model_usage WHERE session_id = ?${liveSource}
         GROUP BY turn_id, model_id, provider_id, CAST(started_at / 3600000 AS INTEGER)
         ORDER BY startedAt`
      )
      // 老库没有 turn_usage 时，回合数按 model_usage 的 turn_id 去重。一次扫描
      // 成表，避免在 sessions 的每一行里做相关子查询（200k 行会到 19s）。
      if (!has('turn_usage')) {
        conn.stmts.turnCountAll = db.prepare(
          `SELECT session_id AS sessionId, COUNT(DISTINCT turn_id) AS count
           FROM model_usage
           WHERE 1=1${liveSource}
           GROUP BY session_id`
        )
      }
    }
    if (has('turn_usage')) {
      conn.stmts.turnAgg = db.prepare(
        `SELECT session_id AS sessionId, COUNT(*) AS count,
           AVG(CASE WHEN status = 'completed' THEN duration_ms END) AS avgDurationMs,
           MAX(started_at) AS lastStart, MAX(COALESCE(completed_at, started_at)) AS lastEnd,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM turn_usage GROUP BY session_id`
      )
      conn.stmts.lastTurn = db.prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, status, started_at AS at,
           COALESCE(completed_at, started_at + COALESCE(duration_ms, 0)) AS doneAt, duration_ms AS durationMs,
           (CASE WHEN completed_at IS NOT NULL OR duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS ended
         FROM turn_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`
      )
      conn.stmts.lastTurnAll = db.prepare(
        `SELECT t.session_id AS sessionId, t.turn_id AS turnId, t.status AS status,
           t.started_at AS at, COALESCE(t.completed_at, t.started_at + COALESCE(t.duration_ms, 0)) AS doneAt,
           t.duration_ms AS durationMs,
           (CASE WHEN t.completed_at IS NOT NULL OR t.duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS ended
         FROM turn_usage t
         JOIN (SELECT session_id, MAX(started_at) AS mx FROM turn_usage GROUP BY session_id) x
           ON x.session_id = t.session_id AND x.mx = t.started_at`
      )
      conn.stmts.turns = db.prepare(
        `SELECT turn_id AS turnId, started_at AS startedAt,
           COALESCE(completed_at, started_at + COALESCE(duration_ms, 0)) AS endedAt,
           duration_ms AS durationMs, status
         FROM turn_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT ?`
      )
    }
    if (has('tool_usage')) {
      conn.stmts.toolAgg = db.prepare(
        `SELECT session_id AS sessionId, COUNT(*) AS calls,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
           MAX(started_at) AS lastAt
         FROM tool_usage GROUP BY session_id`
      )
      conn.stmts.toolRunning = db.prepare(
        `SELECT tool_name AS name, MAX(started_at) AS since FROM tool_usage
         WHERE session_id = ? AND status NOT IN ('completed','error','failed','cancelled') AND started_at >= ?
         GROUP BY tool_name ORDER BY since DESC LIMIT 20`
      )
      conn.stmts.toolRunningAll = db.prepare(
        `SELECT session_id AS sessionId, tool_name AS name, MAX(started_at) AS since FROM tool_usage
         WHERE status NOT IN ('completed','error','failed','cancelled') AND started_at >= ?
         GROUP BY session_id, tool_name ORDER BY since DESC`
      )
      conn.stmts.toolList = db.prepare(
        `SELECT tool_name AS name, COUNT(*) AS calls,
           COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
           AVG(duration_ms) AS avgDurationMs, MAX(started_at) AS lastAt
         FROM tool_usage WHERE session_id = ? GROUP BY tool_name ORDER BY calls DESC LIMIT 50`
      )
      conn.stmts.lastTool = db.prepare(
        `SELECT status, started_at AS at FROM tool_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`
      )
      conn.stmts.usageToolRows = db.prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, tool_name AS tool, status, started_at AS at
         FROM tool_usage WHERE started_at >= ? AND started_at <= ? ORDER BY started_at LIMIT 200000`
      )
    }
    if (connections.size >= MAX_CONNECTIONS) {
      const oldest = connections.keys().next().value
      try {
        connections.get(oldest).db.close()
      } catch (err) {}
      connections.delete(oldest)
    }
    connections.set(file, conn)
    return conn
  } catch (err) {
    // prepare 失败时连接已打开；不关会在 Windows 上锁住库文件（测试清理 EPERM）。
    try {
      if (db) db.close()
    } catch (e) {}
    return null
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 归档三态查询：SQL 片段只由固定常量拼成（archived 已白名单校验），
// 不拼接任何外部输入。
function sessionsStmt(conn, archived) {
  const mode = normalizeArchivedMode(archived)
  const key = 'sessions:' + mode
  if (conn.stmts[key]) return conn.stmts[key]
  if (!conn.sessionSelect) return null
  let clause = ''
  if (mode === 'only') clause = conn.sessionHasArchived ? 'AND COALESCE(s.time_archived, 0) > 0' : 'AND 0 = 1'
  else if (mode === 'exclude' && conn.sessionHasArchived) clause = 'AND COALESCE(s.time_archived, 0) = 0'
  try {
    conn.stmts[key] = conn.db.prepare(
      `${conn.sessionSelect} FROM session s WHERE 1=1 ${clause}
       ORDER BY COALESCE(s.time_updated, 0) DESC LIMIT ?`
    )
  } catch (err) {
    return null
  }
  return conn.stmts[key]
}

function dominantCurrency(byCurrency) {
  const keys = Object.keys(byCurrency || {})
  if (!keys.length) return 'CNY'
  return keys.sort((a, b) => (byCurrency[b] || 0) - (byCurrency[a] || 0))[0]
}

// 逐组定价：返回 { cost, market, prov }；多币种只取主币种（不跨币种求和）。
// 组按「模型 + provider + 整点桶」划分，所以每行（含换模型后的新模型）都用
// 自己那一小时的真实档位计价，不会把旧模型的 token 乘到新模型价上，也不会把
// 谷时用量按峰时算。预付池（plan / cmdgo / 火山订阅）金额记 0、tokens 照算——
// 与「今日已用」、每轮消耗、用量记录同一口径（D054）。
// market 是同一批 token 的「等价市值」：预付池行也有值，只用于成本列显示 «≈»，
// 不参与任何真金白银合计（用量记录的模型排名同款口径）。
// 价目表未收录的模型（costOfUsage kind='none'，rates 为 null）不是「免费」而是
// 「算不出来」：金额不进桶、不补 0；整批都不可计价时 cost 给 null（UI 显示 —），
// provenance 记 unavailable，避免把真实消耗显示成 ¥0.00（D033「缺失不补 0」）。
function priceGroups(groups, now) {
  const byCurrency = {}
  const marketByCurrency = {}
  let provValue = null
  let priced = 0
  let unpriced = 0
  for (const g of groups) {
    const c = withCostProv(
      costOfUsage(
        g.modelId,
        {
          input_tokens: g.input,
          output_tokens: g.output,
          reasoning_tokens: g.reasoning,
          cache_read_input_tokens: g.cacheRead,
          cache_creation_input_tokens: g.cacheWrite,
          computed_total_tokens: g.total,
        },
        Number(g.bucketAt || g.lastAt) || now,
        g.providerId
      ),
      { asOf: now }
    )
    if (!c || !c.tokens) continue
    const prepaid = isPrepaidBilling(g.providerId, g.modelId)
    // 预付池行即使价目表没收录，真实支出仍是 0（走套餐），按 0 入账；
    // 只有「按量计费但算不出价」的行才不能补 0。
    if (!prepaid && isUnpriced(c)) {
      unpriced += 1
      continue
    }
    priced += 1
    const raw = Number(c.amount) || 0
    const amount = prepaid ? 0 : raw
    const cur = c.currency || 'CNY'
    byCurrency[cur] = (byCurrency[cur] || 0) + amount
    if (!isUnpriced(c)) marketByCurrency[cur] = (marketByCurrency[cur] || 0) + raw
    provValue = provValue || c.prov
  }
  if (!priced) {
    return { cost: null, market: null, prov: unpriced ? pricingUnavailable({ asOf: now }) : null }
  }
  const key = dominantCurrency(byCurrency)
  const marketKey = dominantCurrency(marketByCurrency)
  return {
    cost: { amount: Math.round((byCurrency[key] || 0) * 10000) / 10000, currency: key, unit: 'money' },
    market: Object.keys(marketByCurrency).length
      ? { amount: Math.round((marketByCurrency[marketKey] || 0) * 10000) / 10000, currency: marketKey, unit: 'money' }
      : null,
    prov:
      unpriced && provValue
        ? { ...provValue, note: [provValue.note, '部分模型价目未收录，金额只含可计价部分'].filter(Boolean).join(' · ') }
        : provValue,
  }
}

function statusOf(conn, sessionId, now, index = null, sessionAt = 0) {
  let lastModel = null
  let lastTurn = null
  let runningTools = []
  if (index && index.lastModel) {
    lastModel = index.lastModel.get(String(sessionId)) || null
    lastTurn = index.lastTurn ? index.lastTurn.get(String(sessionId)) || null : null
    runningTools = index.running ? index.running.get(String(sessionId)) || [] : []
  } else {
    try {
      if (conn.stmts.lastUsage) lastModel = conn.stmts.lastUsage.get(sessionId) || null
      if (conn.stmts.lastTurn) lastTurn = conn.stmts.lastTurn.get(sessionId) || null
      if (conn.stmts.toolRunning) runningTools = conn.stmts.toolRunning.all(sessionId, now - RUNNING_TOOL_WINDOW_MS)
    } catch (err) {}
  }
  if (runningTools.length) return { status: 'working', statusSource: 'db', running: runningTools }
  if (lastModel && RUNNING_VALUES.has(String(lastModel.status).toLowerCase())) {
    return { status: 'working', statusSource: 'db', running: [] }
  }
  if (lastTurn && RUNNING_VALUES.has(String(lastTurn.status).toLowerCase())) {
    return { status: 'working', statusSource: 'db', running: [] }
  }
  const lastModelAt = Number(lastModel && lastModel.at) || 0
  const lastTurnAt = Number(lastTurn && lastTurn.at) || 0
  const lastTurnDone = Number(lastTurn && lastTurn.doneAt) || lastTurnAt
  const lastAt = Math.max(lastModelAt, lastTurnAt)
  const lastDone = Math.max(lastTurnDone, Number(lastModel && lastModel.doneAt) || 0)
  const modelStatus = String((lastModel && lastModel.status) || '').toLowerCase()
  const turnStatus = String((lastTurn && lastTurn.status) || '').toLowerCase()
  // 新回合的 model 行可能早于 turn_usage 落库；它比上一回合结束更晚，
  // 就说明会话已经重新开始，不能沿用上一回合的 error/done。session.time_updated
  // 在回合开始/消息落库时更新，用来覆盖「首轮模型调用尚未产生 model_usage」的空窗。
  const modelAfterTurn = lastModelAt > lastTurnDone
  // 阶段间隙的保持锚点取 model 行「开始/完成时间的较大者」：长流式回复完成后
  // （completed_at 远晚于 started_at）仍从完成时刻起算 90s，不会被 started_at
  // 提前耗尽。
  const lastModelSeen = Math.max(lastModelAt, Number(lastModel && lastModel.doneAt) || 0)
  const holdModel = modelAfterTurn && now - lastModelSeen < WORKING_HOLD_MS
  // 只有上一回合确实有结束标记时才用「消息比回合结束更晚」判断新回合；
  // 否则 cancelled/error 且 completed_at 缺失会把回合内的消息误当成新回合。
  const turnEnded = !!(lastTurn && Number(lastTurn.ended) === 1)
  const sessionAfterTurn = turnEnded && Number(sessionAt) > lastTurnDone + 2000
  const sessionActive = sessionAfterTurn && now - Number(sessionAt) < 5 * 60_000
  const recentError = now - Math.max(lastAt, lastDone) < 5 * 60_000

  if (turnStatus) {
    if (turnStatus === 'error') {
      if (sessionActive || holdModel) return { status: 'working', statusSource: 'inferred', running: [] }
      if (recentError) return { status: 'error', statusSource: 'db', running: [] }
      return { status: 'idle', statusSource: 'db', running: [] }
    }
    if (turnStatus === 'completed' || turnStatus === 'cancelled') {
      // cancelled 有明确结束时刻时，最后一笔 model 行即使晚于 completed_at
      // 也属于被停止的回合，不能用 holdModel 再撑 10 分钟「工作中」。
      // 只有 cancelled 之后又出现新消息（用户重新发话）才按新回合推断。
      if (turnStatus === 'cancelled' && turnEnded) {
        return sessionActive
          ? { status: 'working', statusSource: 'inferred', running: [] }
          : { status: 'idle', statusSource: 'db', running: [] }
      }
      if (sessionActive || holdModel) return { status: 'working', statusSource: 'inferred', running: [] }
      const hold = turnStatus === 'completed' && now - lastTurnDone < DONE_HOLD_MS
      return { status: hold ? 'done' : 'idle', statusSource: 'db', running: [] }
    }
  }
  // 没有 turn_usage（老库）时才用 model_usage 的终态判断：单次请求失败不代表
  // 整个会话失败，且历史累计错误不能作为当前状态。
  if (modelStatus === 'error' && recentError) return { status: 'error', statusSource: 'db', running: [] }
  if (Math.max(lastAt, lastDone) && now - Math.max(lastAt, lastDone) < WORKING_HOLD_MS) {
    return { status: 'working', statusSource: 'inferred', running: [] }
  }
  // 老库没有回合表，这个 idle 只能是「按静默推断」：标 inferred 让实时层
  // 的滞回把它与回合结束证据区分开（工作中会话要等 90s 静默才降级）。
  return { status: 'idle', statusSource: 'inferred', running: [] }
}

function buildIndex(conn, now) {
  // LiveTracker 每 2s 轮询一次；索引全量重建约 200ms（真实库 2 万条用量）。
  // 1 秒桶会让每次轮询都落到新桶，等于每 2s 阻塞一次事件循环，健康检查/
  // 控制台请求会被拖到 1s+。3 秒桶保证最多 3 秒状态延迟，同时把重建降到
  // 每 4–6 秒一次。
  const key = Math.floor(now / 3000)
  const hit = conn.cache.get(key)
  if (hit) return hit
  const byId = new Map()
  const ensure = (id) => {
    if (!byId.has(id)) byId.set(id, { id, models: [], tools: null, turns: null })
    return byId.get(id)
  }
  try {
    for (const m of conn.stmts.models ? conn.stmts.models.all() : []) ensure(String(m.sessionId)).models.push(m)
  } catch (err) {}
  try {
    for (const t of conn.stmts.turnAgg ? conn.stmts.turnAgg.all() : []) ensure(String(t.sessionId)).turns = t
  } catch (err) {}
  try {
    for (const t of conn.stmts.toolAgg ? conn.stmts.toolAgg.all() : []) ensure(String(t.sessionId)).tools = t
  } catch (err) {}
  const lastModel = new Map()
  const lastTurn = new Map()
  const running = new Map()
  const turnCount = new Map()
  const lastMessage = new Map()
  const priority = (s) => {
    const v = String(s || '').toLowerCase()
    if (RUNNING_VALUES.has(v)) return 4
    if (v === 'error') return 3
    if (v === 'completed') return 2
    if (v === 'cancelled') return 1
    return 0
  }
  const pickLatest = (map, r) => {
    const id = String(r.sessionId)
    const cur = map.get(id)
    if (!cur || Number(r.at) > Number(cur.at) || (Number(r.at) === Number(cur.at) && priority(r.status) > priority(cur.status))) {
      map.set(id, r)
    }
  }
  try {
    for (const r of conn.stmts.lastModelAll ? conn.stmts.lastModelAll.all() : []) pickLatest(lastModel, r)
  } catch (err) {}
  try {
    for (const r of conn.stmts.lastTurnAll ? conn.stmts.lastTurnAll.all() : []) pickLatest(lastTurn, r)
  } catch (err) {}
  try {
    for (const r of conn.stmts.turnCountAll ? conn.stmts.turnCountAll.all() : []) turnCount.set(String(r.sessionId), Number(r.count) || 0)
  } catch (err) {}
  try {
    for (const r of conn.stmts.lastMessageAll ? conn.stmts.lastMessageAll.all(now - 30 * 86400000) : []) {
      lastMessage.set(String(r.sessionId), Number(r.at) || 0)
    }
  } catch (err) {}
  try {
    for (const r of conn.stmts.toolRunningAll ? conn.stmts.toolRunningAll.all(now - RUNNING_TOOL_WINDOW_MS) : []) {
      const id = String(r.sessionId)
      const list = running.get(id) || []
      if (list.length < 20) list.push({ name: String(r.name || ''), since: num(r.since) })
      running.set(id, list)
    }
  } catch (err) {}
  // workflow 活动：动态 workflow（dwf_run）与旧 workflow_run 都带
  // parent_session_id。只要还有 running/pending 的 run，父会话就不能显示
  // idle/done（长跑 workflow 的编排回合可能已经结束）；全部结束时用
  // 最近一次 run 的 time_updated 起算 5 分钟「已完成」展示窗口。
  const workflowBusy = new Map()
  const workflowEnd = new Map()
  for (const table of ['dwf_run', 'workflow_run']) {
    if (!conn.tables || !conn.tables.has(table)) continue
    let rows = []
    try {
      rows = conn.db
        .prepare(`SELECT parent_session_id AS sid, status AS status, time_updated AS at FROM ${table} WHERE parent_session_id IS NOT NULL AND parent_session_id <> ''`)
        .all()
    } catch (err) {
      rows = []
    }
    for (const r of rows) {
      const sid = String(r.sid || '')
      if (!sid) continue
      const st = String(r.status || '').toLowerCase()
      const at = num(r.at)
      if (st === 'running' || st === 'pending') {
        workflowBusy.set(sid, Math.max(Number(workflowBusy.get(sid)) || 0, at))
      } else {
        workflowEnd.set(sid, Math.max(Number(workflowEnd.get(sid)) || 0, at))
      }
    }
  }
  byId.lastModel = lastModel
  byId.lastTurn = lastTurn
  byId.running = running
  byId.turnCount = turnCount
  byId.lastMessage = lastMessage
  byId.workflowBusy = workflowBusy
  byId.workflowEnd = workflowEnd
  conn.cache.clear()
  conn.cache.set(key, byId)
  return byId
}

function sessionFromRow(conn, row, index, now) {
  const id = String(row.sessionId || '')
  const entry = index.get(id) || { models: [], turns: null, tools: null }
  const hasModels = entry.models.length > 0
  const tokens = hasModels
    ? { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    : { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null }
  let errors = 0
  let calls = 0
  let lastAt = 0
  for (const m of entry.models) {
    tokens.total += Number(m.total) || 0
    tokens.input += Number(m.input) || 0
    tokens.output += Number(m.output) || 0
    tokens.cacheRead += Number(m.cacheRead) || 0
    tokens.cacheWrite += Number(m.cacheWrite) || 0
    tokens.reasoning += Number(m.reasoning) || 0
    errors += Number(m.errors) || 0
    calls += Number(m.calls) || 0
    lastAt = Math.max(lastAt, Number(m.lastAt) || 0)
  }
  const priced = priceGroups(entry.models, now)
  const statusInfo = statusOf(conn, id, now, index, Number(index.lastMessage && index.lastMessage.get(id)) || 0)
  const toolsRunning = Array.isArray(statusInfo.running) ? statusInfo.running.map((x) => ({ name: String(x.name || ''), since: num(x.since) })) : []
  const wfBusyAt = Number(index.workflowBusy && index.workflowBusy.get(id)) || 0
  const wfEndAt = Number(index.workflowEnd && index.workflowEnd.get(id)) || 0
  const workflowBusy = wfBusyAt > 0
  // 手动停止（cancelled）与异常（error）不是「完成」：前者要立刻回空闲，
  // 不能落 doneAt 让它在 5 分钟窗口里显示「已完成」；后者按 error 处理。
  const lastTurnInfo = index.lastTurn && index.lastTurn.get(id) || null
  const lastTurnStatus = String(lastTurnInfo && lastTurnInfo.status || '').toLowerCase()
  const lastTurnCompleted = lastTurnStatus === 'completed'
  // 编排回合结束但 workflow 还在跑：父会话按 working 计，筛选/计数才不会漏掉。
  const status = workflowBusy && (statusInfo.status === 'idle' || statusInfo.status === 'done') ? 'working' : statusInfo.status
  // 「当前模型」取最近一次真实调用，而不是该会话历史里第一个出现的模型。
  // 模型切换后（GLM → DeepSeek/CommandCode）列表必须显示现在用的那个。
  let provider = ''
  let model = ''
  let modelAt = -1
  for (const m of entry.models) {
    if (!m.modelId) continue
    const at = Number(m.lastAt) || 0
    if (at >= modelAt) {
      modelAt = at
      model = String(m.modelId)
      provider = String(m.providerId || '')
    }
  }
  if (!provider) provider = entry.models.find((m) => m.providerId)?.providerId || ''
  if (!model) model = entry.models.find((m) => m.modelId)?.modelId || ''
  const baseUpdated = Math.max(
    Number(row.time_updated) || 0,
    lastAt,
    Number(entry.turns && entry.turns.lastEnd) || 0
  )
  const updatedAt = baseUpdated || now
  const raw = {
    agentId: 'zcode',
    sessionId: id,
    parentKey: row.parent_id ? 'zcode:' + String(row.parent_id) : null,
    title: row.title || '',
    cwd: row.cwd || '',
    model,
    provider,
    status,
    statusSource: workflowBusy ? 'db' : statusInfo.statusSource,
    statusSince: status === 'done' ? Number(entry.turns && entry.turns.lastEnd) || now : workflowBusy ? wfBusyAt : updatedAt,
    startedAt: Number(row.time_created) || (entry.turns && Number(entry.turns.lastStart)) || (lastAt || null),
    updatedAt: Math.min(now, updatedAt),
    // 真实宿主时间（库里的时间戳）；拿不到就是 null，不能用 now 冒充，
    // 否则轮询会被误判成「宿主已经处理完」。
    lastHostAt: baseUpdated || null,
    endedAt: entry.turns && entry.turns.lastEnd ? Number(entry.turns.lastEnd) : null,
    // 5 分钟「已完成」展示窗口的起算点：回合结束与 workflow 结束取较晚者。
    // 只有「完成」的回合（completed）才带 doneAt；cancelled/error/活跃状态
    // 都不能让旧的结束时间在以后回闪成「已完成」。
    doneAt:
      workflowBusy || !lastTurnCompleted || status === 'working' || status === 'waiting_permission' || status === 'waiting_input' || status === 'error'
        ? wfEndAt || null
        : Math.max(Number(entry.turns && entry.turns.lastEnd) || 0, wfEndAt) || null,
    workflowBusy,
    workflowBusySince: wfBusyAt || null,
    archived: Number(row.timeArchived) > 0,
    turns: {
      count: Number(entry.turns && entry.turns.count) || Number(index.turnCount && index.turnCount.get(id)) || 0,
      current: status === 'working' ? { id: '', index: null, startedAt: Number(row.time_updated) || now } : null,
      avgDurationMs: entry.turns && entry.turns.avgDurationMs != null ? Math.round(Number(entry.turns.avgDurationMs)) : null,
    },
    tokens,
    cost: priced.cost,
    // 等价市值只在真有差异（预付池行被归零）时输出，避免前端到处显示 «≈»
    costMarket:
      priced.market && (!priced.cost || Math.abs(Number(priced.market.amount) - Number(priced.cost.amount)) > 0.00005)
        ? priced.market
        : null,
    tools: {
      calls: Number(entry.tools && entry.tools.calls) || calls,
      errors: Number(entry.tools && entry.tools.errors) || errors,
      running: toolsRunning,
    },
    errors: {
      model: errors,
      tool: Number(entry.tools && entry.tools.errors) || 0,
      last: null,
    },
    provenance: {
      tokens: {
        kind: entry.models.length ? 'exact' : 'unavailable',
        origin: 'local-db',
        source: 'zcode:db.sqlite#model_usage',
        asOf: now,
        ...(entry.models.length ? {} : { reason: 'no-data' }),
      },
      cost: priced.prov || { kind: 'unavailable', origin: 'local-db', source: 'zcode:db.sqlite', asOf: now, reason: 'no-data' },
      status: {
        kind: statusInfo.statusSource === 'inferred' ? 'estimated' : 'exact',
        origin: 'local-db',
        source: 'zcode:db.sqlite#turn_usage',
        asOf: now,
        ...(statusInfo.statusSource === 'inferred' ? { note: '按最近活动推断' } : {}),
      },
      tools: {
        kind: conn.tables.has('tool_usage') ? 'exact' : 'unavailable',
        origin: 'local-db',
        source: 'zcode:db.sqlite#tool_usage',
        asOf: now,
        ...(conn.tables.has('tool_usage') ? {} : { reason: 'schema' }),
      },
    },
  }
  return normalizeSession(raw, { now })
}

const SCAN_LIMIT = 2000

function sessionsOf(conn, now, archived = 'exclude', scanLimit = SCAN_LIMIT) {
  const index = buildIndex(conn, now)
  const mode = normalizeArchivedMode(archived)
  let rows = []
  const stmt = sessionsStmt(conn, mode)
  if (stmt) {
    try {
      rows = stmt.all(scanLimit)
    } catch (err) {
      rows = []
    }
  }
  // 归档是父会话属性：父会话被归档后，time_archived 为空的子会话不能因此
  // 被提升成根会话（exclude 模式会把它当成活跃会话），也不能在 only 模式
  // 里丢下。沿 parent_id 链判断祖先是否归档。
  if (conn.sessionHasArchived && conn.stmts.sessionById && mode !== 'all') {
    const cache = new Map()
    const archivedThrough = (id, depth = 0) => {
      const key = String(id || '')
      if (!key) return false
      if (cache.has(key)) return cache.get(key)
      if (depth > 16) return false
      let row = null
      try {
        row = conn.stmts.sessionById.get(key)
      } catch (err) {
        row = null
      }
      let value = !!(row && Number(row.timeArchived) > 0)
      if (!value && row && row.parent_id) value = archivedThrough(String(row.parent_id), depth + 1)
      cache.set(key, value)
      return value
    }
    if (mode === 'exclude') {
      rows = rows.filter((r) => !archivedThrough(r.sessionId))
    } else if (mode === 'only') {
      // only：SQL 只查到了自身 time_archived>0 的行；补上同一窗口里随父归档
      // 的子会话，再统一按父链过滤。
      const pool = new Map()
      try {
        for (const r of conn.stmts.allSessions.all(scanLimit)) pool.set(String(r.sessionId), r)
      } catch (err) {}
      for (const r of rows) pool.set(String(r.sessionId), r)
      rows = [...pool.values()].filter((r) => archivedThrough(r.sessionId))
    }
  }
  // 没有 session 表的极老版本：从 model_usage 反推会话 id（没有归档信息）。
  if (!rows.length && conn.stmts.models && !conn.sessionSelect && normalizeArchivedMode(archived) !== 'only') {
    for (const id of index.keys()) rows.push({ sessionId: id })
  }
  return {
    items: rows.map((row) => sessionFromRow(conn, row, index, now)),
    truncated: rows.length >= scanLimit,
  }
}

function inRange(s, range, now) {
  if (!range || range === 'all') return true
  const day = 86400000
  const since = range === 'today' ? new Date(now).setHours(0, 0, 0, 0) : range === '7d' ? now - 7 * day : range === '30d' ? now - 30 * day : 0
  return Number(s.updatedAt) >= since
}

export async function getSessions(opts = {}) {
  const file = opts.dbFile || defaultDbFile(opts.env || process.env)
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const conn = openDb(file)
  if (!conn) return { ok: true, supported: false, reason: 'db-missing', items: [], nextCursor: null, total: 0 }
  if (opts.agent && opts.agent !== 'zcode') {
    return { ok: true, supported: true, items: [], nextCursor: null, total: 0, shownRoots: 0, rootTotal: 0, truncated: false }
  }
  const archived = normalizeArchivedMode(opts.archived)
  const { items: scanned, truncated } = sessionsOf(conn, now, archived)

  // 根/子分层：parentKey 指向候选集内的会话即子会话；只有根参与排序分页。
  // 子会话不占 limit/total/cursor，随父会话一起返回（createdAt 倒序，≤20）。
  const byKey = new Map()
  for (const s of scanned) byKey.set(s.key, s)
  const roots = []
  const childrenByParent = new Map()
  for (const s of scanned) {
    if (s.parentKey && byKey.has(s.parentKey)) {
      const arr = childrenByParent.get(s.parentKey) || []
      arr.push(s)
      childrenByParent.set(s.parentKey, arr)
    } else {
      roots.push(s)
    }
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => compareSessionsForSort(a, b, 'updated'))
    if (arr.length > 20) arr.length = 20
  }

  // status / q / range 只过滤根会话；子会话只受 archived 过滤。
  // 状态筛选用展示状态：5 分钟内的已完成、workflow 在跑的父会话都要能筛到。
  let filtered = roots.filter((s) => inRange(s, opts.range, now))
  if (opts.status) filtered = filtered.filter((s) => displayStatusOf(s, now) === opts.status)
  if (opts.q) {
    const q = String(opts.q).toLowerCase()
    filtered = filtered.filter((s) => (s.title + ' ' + s.cwd + ' ' + s.model).toLowerCase().includes(q))
  }
  const sort = ['updated', 'tokens', 'cost', 'duration'].includes(opts.sort) ? opts.sort : 'updated'
  filtered.sort((a, b) => compareSessionsForSort(a, b, sort))
  const cur = opts.cursor ? parseCursor(opts.cursor) : null
  const after = cur ? filtered.filter((s) => compareSessionToCursor(s, sort, cur) > 0) : filtered
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50))
  const page = after.slice(0, limit)
  const items = []
  const keys = []
  for (const root of page) {
    items.push(root)
    for (const child of childrenByParent.get(root.key) || []) items.push(child)
  }
  // 过滤后的全部会话 key（含子会话，不受游标/分页影响）。实时层用它判断
  // 内存里哪些会话适配器不认识，避免 total 少计或把镜像重复相加。
  for (const root of filtered) {
    keys.push(root.key)
    for (const child of childrenByParent.get(root.key) || []) keys.push(child.key)
  }
  return {
    ok: true,
    supported: true,
    items,
    keys,
    nextCursor: after.length > limit && page.length ? cursorOf(page[page.length - 1], sort) : null,
    total: filtered.length,
    shownRoots: page.length,
    rootTotal: filtered.length,
    truncated,
  }
}

// 供 LiveTracker 同步内存快照的归档状态。内存里的会话可能来自归档前的
// 轮询：适配器列表已经不返回它，但内存副本的 archived 仍是 false。
// 返回「自身或任一祖先已归档」的 key（子会话随父）。
export function getArchivedKeys(opts = {}) {
  const file = opts.dbFile || defaultDbFile(opts.env || process.env)
  const conn = openDb(file)
  if (!conn || !conn.stmts.archivedTree) return { ok: true, supported: false, keys: [] }
  let rows = []
  try {
    rows = conn.stmts.archivedTree.all()
  } catch (err) {
    return { ok: true, supported: false, keys: [] }
  }
  return { ok: true, supported: true, keys: rows.map((r) => 'zcode:' + String(r.sessionId)) }
}

export async function getLiveStatus(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const since = Number(opts.sinceMs) || now - 10 * 60_000
  const r = await getSessions({ ...opts, range: 'all', limit: 200, sort: 'updated' })
  if (!r.supported) return { ok: true, supported: false, reason: r.reason, items: [] }
  return {
    ok: true,
    supported: true,
    items: r.items
      .filter((s) => Number(s.updatedAt) >= since || s.status === 'working' || s.status.startsWith('waiting'))
      .map((s) => summarizeSession(s)),
  }
}

export async function getSessionDetail(sessionId, opts = {}) {
  const file = opts.dbFile || defaultDbFile(opts.env || process.env)
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const conn = openDb(file)
  if (!conn) return { ok: true, supported: false, reason: 'db-missing', session: null, turns: [], tools: [], models: [] }
  const index = buildIndex(conn, now)
  let row = null
  try {
    row = conn.stmts.sessionById ? conn.stmts.sessionById.get(String(sessionId)) : null
  } catch (err) {}
  if (!row) row = { sessionId: String(sessionId), title: '', parent_id: null, time_updated: now }
  const session = sessionFromRow(conn, row, index, now)
  const turns = []
  // turn_usage 只有时长；token/成本按 turn 从 model_usage 归并（不把明细行拉进内存）。
  // model_usage 的每个分组行是 (回合, 模型, provider, 整点桶)：逐组计价后再按回合
  // 汇总，混合模型回合不会被压成单一模型的价格（D054）。
  const turnAgg = new Map()
  if (conn.stmts.turnsFallback) {
    try {
      for (const t of conn.stmts.turnsFallback.all(String(sessionId))) {
        const turnId = String(t.turnId || '')
        const priced = priceGroups([{ ...t, lastAt: t.endedAt }], now)
        const tokens = Number(t.tokens) || 0
        let agg = turnAgg.get(turnId)
        if (!agg) {
          agg = { tokens: 0, byCurrency: {}, marketByCurrency: {}, model: '', modelTokens: -1, hasError: false, startedAt: 0, endedAt: 0 }
          turnAgg.set(turnId, agg)
        }
        agg.tokens += tokens
        agg.hasError = agg.hasError || Number(t.hasError) > 0
        const started = num(t.startedAt)
        agg.startedAt = agg.startedAt ? Math.min(agg.startedAt, started) : started
        agg.endedAt = Math.max(agg.endedAt, num(t.endedAt))
        if (priced.cost) agg.byCurrency[priced.cost.currency] = (agg.byCurrency[priced.cost.currency] || 0) + priced.cost.amount
        if (priced.market) agg.marketByCurrency[priced.market.currency] = (agg.marketByCurrency[priced.market.currency] || 0) + priced.market.amount
        // 回合主模型按 token 最大的一组展示（旧实现取 MAX(model_id)，纯字典序）
        if (tokens > agg.modelTokens) {
          agg.modelTokens = tokens
          agg.model = String(t.modelId || '')
        }
      }
      for (const [turnId, agg] of turnAgg) {
        const cur = dominantCurrency(agg.byCurrency)
        const marketCur = dominantCurrency(agg.marketByCurrency)
        const cost = Object.keys(agg.byCurrency).length
          ? { amount: Math.round((agg.byCurrency[cur] || 0) * 10000) / 10000, currency: cur, unit: 'money' }
          : null
        const market = Object.keys(agg.marketByCurrency).length
          ? { amount: Math.round((agg.marketByCurrency[marketCur] || 0) * 10000) / 10000, currency: marketCur, unit: 'money' }
          : null
        turnAgg.set(turnId, {
          tokens: Math.round(agg.tokens),
          cost,
          costMarket: market && (!cost || Math.abs(market.amount - cost.amount) > 0.00005) ? market : null,
          model: agg.model,
          hasError: agg.hasError,
          startedAt: agg.startedAt,
          endedAt: agg.endedAt,
        })
      }
    } catch (err) {}
  }
  if (conn.stmts.turns) {
    try {
      for (const t of conn.stmts.turns.all(String(sessionId), 200)) {
        const agg = turnAgg.get(String(t.turnId || '')) || null
        turns.push({
          id: String(t.turnId || ''),
          index: turns.length + 1,
          startedAt: num(t.startedAt),
          endedAt: num(t.endedAt),
          durationMs: t.durationMs == null ? null : Math.round(Number(t.durationMs)),
          tokens: agg ? agg.tokens : null,
          cost: agg ? agg.cost : null,
          costMarket: agg ? agg.costMarket || null : null,
          status: ['completed', 'error', 'running', 'cancelled'].includes(String(t.status))
            ? String(t.status)
            : String(t.status) === 'completed'
              ? 'completed'
              : 'running',
          model: agg ? agg.model : '',
        })
      }
    } catch (err) {}
  } else if (conn.stmts.turnsFallback) {
    for (const [turnId, agg] of turnAgg) {
      turns.push({
        id: turnId,
        index: turns.length + 1,
        startedAt: agg.startedAt,
        endedAt: agg.endedAt,
        durationMs: agg.startedAt && agg.endedAt ? Math.max(0, agg.endedAt - agg.startedAt) : null,
        tokens: agg.tokens,
        cost: agg.cost,
        costMarket: agg.costMarket || null,
        status: agg.hasError ? 'error' : 'completed',
        model: agg.model,
      })
    }
  }
  const tools = []
  if (conn.stmts.toolList) {
    try {
      for (const t of conn.stmts.toolList.all(String(sessionId))) {
        tools.push({
          name: String(t.name || 'unknown'),
          calls: Number(t.calls) || 0,
          errors: Number(t.errors) || 0,
          avgDurationMs: t.avgDurationMs == null ? null : Math.round(Number(t.avgDurationMs)),
          lastAt: num(t.lastAt),
        })
      }
    } catch (err) {}
  }
  // 索引里的模型行按「模型 + provider + 整点桶」分组，展示时要并回
  // 「模型 + provider」一项，否则同一模型会被拆成多行（D054）。
  const modelAgg = new Map()
  for (const m of index.get(String(sessionId))?.models || []) {
    const key = String(m.modelId || '') + '|' + String(m.providerId || '')
    const cur = modelAgg.get(key) || { modelId: m.modelId, provider: m.providerId, tokens: 0, calls: 0, errors: 0 }
    cur.tokens += Number(m.total) || 0
    cur.calls += Number(m.calls) || 0
    cur.errors += Number(m.errors) || 0
    modelAgg.set(key, cur)
  }
  const models = [...modelAgg.values()].map((m) => ({
    modelId: String(m.modelId || ''),
    provider: String(m.provider || ''),
    tokens: Math.round(Number(m.tokens) || 0),
    calls: Number(m.calls) || 0,
    errors: Number(m.errors) || 0,
  }))
  return { ok: true, supported: true, session, turns: turns.reverse(), tools, models }
}

// 用量明细行（M4 下钻）。单位统一 money；金额逐行按价目折算并带 provenance。
export async function readUsageRows(opts = {}) {
  const file = opts.dbFile || defaultDbFile(opts.env || process.env)
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const conn = openDb(file)
  if (!conn || !conn.stmts.usageRows) return { ok: false, reason: 'db-unavailable', rows: [] }
  const since = Number(opts.since) || 0
  const until = Number(opts.until) || now
  // P0-3 时间过滤：先按本地 HH:MM 过滤原始行，再计价，避免为不匹配的行做无谓计算。
  const tm = Number(opts.timeMinutes)
  const timeMinutes = Number.isInteger(tm) && tm >= 0 && tm < 1440 ? tm : null
  const rows = []
  try {
    for (const r of conn.stmts.usageRows.all(since, until)) {
      if (timeMinutes != null) {
        const d = new Date(Number(r.at) || 0)
        if (d.getHours() * 60 + d.getMinutes() !== timeMinutes) continue
      }
      const c = withCostProv(
        costOfUsage(
          r.modelId,
          {
            input_tokens: r.input,
            output_tokens: r.output,
            reasoning_tokens: r.reasoning,
            cache_read_input_tokens: r.cacheRead,
            cache_creation_input_tokens: r.cacheWrite,
            computed_total_tokens: r.total,
          },
          Number(r.at) || until,
          r.providerId
        ),
        { asOf: now }
      )
      if (!c) continue
      const hasUsage = Number(c.tokens) > 0
      if (!hasUsage && String(r.status) !== 'error') continue
      // 与会话列表 / 回合明细 / aggregateUsage 同一判据（D054）：预付池行
      // 金额记 0、tokens 照算；价目表未收录的非预付行金额不可得（null +
      // unavailable），不能按 0 元进明细表。
      const prepaid = isPrepaidBilling(r.providerId, r.modelId)
      const unpriced = !prepaid && isUnpriced(c)
      const amount = unpriced ? null : prepaid ? 0 : Number(c.amount) || 0
      rows.push({
        agentId: 'zcode',
        sessionId: String(r.sessionId || ''),
        session: String(r.sessionId || ''),
        model: String(r.modelId || ''),
        vendor: String(r.providerId || c.vendor || ''),
        vendorLabel: c.vendorLabel || '',
        tool: '',
        at: Number(r.at) || 0,
        day: dayKey(r.at),
        unit: 'money',
        currency: c.currency,
        amount: amount === null ? null : Math.round(amount * 10000) / 10000,
        credits: null,
        tokens: Number(c.tokens) || 0,
        calls: 1,
        errors: String(r.status) === 'error' ? 1 : 0,
        status: String(r.status || ''),
        prov: unpriced ? pricingUnavailable({ asOf: now }) : c.prov,
      })
    }
  } catch (err) {
    return { ok: false, reason: 'db-read-failed', rows: [] }
  }
  return { ok: true, rows, truncated: rows.length >= 200000 }
}

// 工具行没有金额/token，只贡献调用与错误计数。
export async function readToolUsageRows(opts = {}) {
  const file = opts.dbFile || defaultDbFile(opts.env || process.env)
  const conn = openDb(file)
  if (!conn || !conn.stmts.usageToolRows) return { ok: false, reason: 'db-unavailable', rows: [] }
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const since = Number(opts.since) || 0
  const until = Number(opts.until) || now
  const rows = []
  try {
    for (const r of conn.stmts.usageToolRows.all(since, until)) {
      rows.push({
        agentId: 'zcode',
        sessionId: String(r.sessionId || ''),
        session: String(r.sessionId || ''),
        model: '',
        vendor: '',
        tool: String(r.tool || 'unknown'),
        at: Number(r.at) || 0,
        day: dayKey(r.at),
        unit: 'money',
        currency: 'CNY',
        amount: 0,
        credits: null,
        tokens: 0,
        calls: 1,
        errors: String(r.status) === 'error' ? 1 : 0,
        status: String(r.status || ''),
        prov: { kind: 'exact', origin: 'local-db', source: 'zcode:db.sqlite#tool_usage', asOf: now },
      })
    }
  } catch (err) {
    return { ok: false, reason: 'db-read-failed', rows: [] }
  }
  return { ok: true, rows, truncated: rows.length >= 200000 }
}

function dayKey(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// M4 下钻聚合：在 SQL 里按维度 + 天 + 模型/厂商分组，**不把明细行拉进内存**。
// 返回与 usage-breakdown 一致的 series 形状（金额已按价目逐组折算）。
export async function aggregateUsage(opts = {}) {
  const file = opts.dbFile || defaultDbFile(opts.env || process.env)
  const now = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const conn = openDb(file)
  if (!conn || !conn.stmts.usageRows) return { ok: false, reason: 'db-unavailable', series: [] }
  const since = Number(opts.since) || 0
  const until = Number(opts.until) || now
  const by = ['agent', 'model', 'vendor', 'session', 'tool'].includes(opts.by) ? opts.by : 'agent'
  const dayIndexExpr = `CAST((started_at + ?) / 86400000 AS INTEGER)`
  const offset = Number(opts.tzOffsetMs) || -new Date(now).getTimezoneOffset() * 60000
  const series = new Map()
  const ensure = (key, label) => {
    const k = String(key || 'unknown')
    let s = series.get(k)
    if (!s) {
      s = {
        key: k,
        label: label || k,
        tokens: 0,
        amount: 0,
        credits: null,
        calls: 0,
        errors: 0,
        byDay: new Map(),
        byCurrency: {},
        prov: null,
      }
      series.set(k, s)
    }
    return s
  }
  try {
    if (by === 'tool') {
      if (!conn.stmts.usageToolRows) return { ok: true, series: [] }
      const stmt = conn.db.prepare(
        `SELECT tool_name AS tool, ${dayIndexExpr} AS dayIndex, COUNT(*) AS calls,
           COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors
         FROM tool_usage WHERE started_at >= ? AND started_at <= ?
         GROUP BY tool, dayIndex`
      )
      for (const r of stmt.all(offset, since, until)) {
        const s = ensure(r.tool || 'unknown')
        s.calls += Number(r.calls) || 0
        s.errors += Number(r.errors) || 0
        const day = dateKeyOfDay(Number(r.dayIndex))
        const d = s.byDay.get(day) || { d: day, tokens: 0, amount: 0, credits: null, calls: 0 }
        d.calls += Number(r.calls) || 0
        s.byDay.set(day, d)
        s.prov = s.prov || { kind: 'exact', origin: 'local-db', source: 'zcode:db.sqlite#tool_usage', asOf: now }
      }
    } else {
      const dim = by === 'agent' ? `'zcode'` : by === 'model' ? 'model_id' : by === 'vendor' ? 'provider_id' : 'session_id'
      const stmt = conn.db.prepare(
        `SELECT ${dim} AS k, model_id AS modelId, provider_id AS providerId, session_id AS sessionId,
           ${dayIndexExpr} AS dayIndex,
           MIN(started_at) AS at,
           COALESCE(SUM(computed_total_tokens), 0) AS total,
           COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(output_tokens), 0) AS output,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
           COALESCE(SUM(cache_read_input_tokens), 0) AS cacheRead,
           COALESCE(SUM(cache_creation_input_tokens), 0) AS cacheWrite,
           COUNT(*) AS calls,
           COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors
         FROM model_usage WHERE started_at >= ? AND started_at <= ?
         GROUP BY k, dayIndex, model_id, provider_id, session_id, CAST(started_at / 3600000 AS INTEGER)`
      )
      for (const r of stmt.all(offset, since, until)) {
        const s = ensure(r.k)
        const c = withCostProv(
          costOfUsage(
            r.modelId,
            {
              input_tokens: r.input,
              output_tokens: r.output,
              reasoning_tokens: r.reasoning,
              cache_read_input_tokens: r.cacheRead,
              cache_creation_input_tokens: r.cacheWrite,
              computed_total_tokens: r.total,
            },
            // 整点桶的起始时刻：同一小时内峰谷档位相同，用桶内最早时间计价即可，
            // 不再拿区间末端（旧实现把历史用量全按查询末端的档位算）。
            Number(r.at) || until,
            r.providerId
          ),
          { asOf: now }
        )
        if (!c) continue
        // 预付池金额记 0、tokens 照算（与今日已用/用量记录同口径，D054）。
        // 价目表未收录的行（非预付、rates 为 null）金额不可得：不进金额桶、
        // 不补 0，tokens/calls 照算；provenance 由 out 里标 unavailable。
        const prepaid = isPrepaidBilling(r.providerId, r.modelId)
        const unpriced = !prepaid && isUnpriced(c)
        const amount = unpriced ? null : prepaid ? 0 : Number(c.amount) || 0
        s.tokens += Number(c.tokens) || 0
        s.calls += Number(r.calls) || 0
        s.errors += Number(r.errors) || 0
        const cur = c.currency || 'CNY'
        if (amount === null) s.unpriced = (s.unpriced || 0) + 1
        else s.byCurrency[cur] = Math.round(((s.byCurrency[cur] || 0) + amount) * 10000) / 10000
        s.prov = s.prov || c.prov
        const day = dateKeyOfDay(Number(r.dayIndex))
        const d = s.byDay.get(day) || { d: day, tokens: 0, amount: 0, credits: null, calls: 0, priced: 0, unpriced: 0 }
        d.tokens += Number(c.tokens) || 0
        d.calls += Number(r.calls) || 0
        // 逐日金额沿用「等价市值」口径（总览 7 天图含预付等价），但必须按币种
        // 分桶：此前把各币种金额直加再按 series 主币种归类，USD 会被算成 CNY。
        // priced/unpriced 用来区分「已知的 0」（预付/免费）与「算不出来」，
        // 后者在输出里是 null，不能补 0。
        if (amount !== null) {
          d.priced += 1
          const raw = Number(c.amount) || 0
          d.amount = Math.round(((d.amount || 0) + raw) * 10000) / 10000
          if (raw !== 0) {
            d.byCurrency = d.byCurrency || {}
            d.byCurrency[cur] = Math.round(((d.byCurrency[cur] || 0) + raw) * 10000) / 10000
          }
        } else {
          d.unpriced += 1
        }
        s.byDay.set(day, d)
      }
    }
  } catch (err) {
    return { ok: false, reason: 'db-read-failed', series: [] }
  }
  const out = []
  for (const s of series.values()) {
    const pricedCur = Object.keys(s.byCurrency)
    const cur = dominantCurrency(s.byCurrency)
    const provValue = s.unpriced
      ? pricedCur.length && s.prov
        ? { ...s.prov, note: [s.prov.note, '部分模型价目未收录，金额只含可计价部分'].filter(Boolean).join(' · ') }
        : pricingUnavailable({ asOf: now })
      : s.prov
    out.push({
      key: s.key,
      label: s.label,
      tokens: Math.round(s.tokens),
      amount: pricedCur.length ? s.byCurrency[cur] : null,
      credits: null,
      calls: s.calls,
      errors: s.errors,
      // 逐日金额归一到 series 主币种口径（与 usage-breakdown 一致）；完整分桶
      // 保留在 byDay[].byCurrency。此前这里直接混加各币种，USD 会被当 CNY。
      // 一天只有未收录模型时 amount 必须是 null（不是 0）：usage-breakdown/UI
      // 据此显示「—」，不会把「算不出来」画成 ¥0.00。
      byDay: [...s.byDay.values()].sort((a, b) => (a.d < b.d ? -1 : 1)).map((d) => {
        const buckets = d.byCurrency && Object.keys(d.byCurrency).length
        const amount = buckets
          ? d.byCurrency[cur] || 0
          : d.priced > 0
            ? Math.round((Number(d.amount) || 0) * 10000) / 10000
            : d.unpriced > 0
              ? null
              : 0
        return {
          d: d.d,
          tokens: d.tokens,
          amount,
          credits: d.credits,
          calls: d.calls,
          ...(buckets ? { byCurrency: d.byCurrency } : {}),
        }
      }),
      byCurrency: s.byCurrency,
      currency: pricedCur.length ? cur : '',
      prov: provValue,
    })
  }
  return { ok: true, series: out, unit: 'money' }
}

function dateKeyOfDay(dayIndex) {
  return new Date(Number(dayIndex) * 86400000).toISOString().slice(0, 10)
}
