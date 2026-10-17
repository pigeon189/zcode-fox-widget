// 每轮对话消耗：读 WorkBuddy 自己记的积分用量。
//
// 数据源（2026-10-14 实测，见 docs/porting/phase-0.md）：
//   A. <HOST_HOME>/workbuddy.db 的 session_usage 表
//        session_usage(session_id, used, size, updated_at, credit_json)
//        credit_json = {"<conversationRequestId>": <credit>}
//        —— **积分由宿主算好**，这是主口径（移植要求「优先直接用宿主算好的 credit」）。
//        used/size 同时给出上下文占用，顺手支持「上下文余量」这个 ZCode 侧没有的能力。
//   B. <HOST_HOME>/projects/<cwd slug>/<sessionId>.jsonl 的 providerData.rawUsage
//        —— 每次模型调用一条，含 prompt_tokens / completion_tokens /
//        prompt_cache_hit_tokens / prompt_cache_miss_tokens / prompt_cache_write_tokens /
//        completion_thinking_tokens / credit，以及 requestModelId / conversationRequestId。
//        积分以 A 为准，B 用来出「逐模型明细 + 等价金额」。
//
// 为什么还要等价金额：WorkBuddy 是订阅积分制，积分是主口径；但用户手里可能另有
// 按量 API Key（厂商模板那一套），所以每轮同时给一个「按公开价目折算的等价市值」
// 作为附注（costOfUsage，与 vendors/pricing 同源），**不参与主显示**。
//
// 口径红线（承 HANDOFF §7.2.2 / §10.2）：rawUsage 的 prompt_tokens **包含**缓存命中，
// 自算金额必须复用 splitInputTokens（否则缓存那 99% 被按未命中价重复计费，金额虚高
// 十几倍）。这里不自己减，而是把字段映射成 pricing 认得的形状交给它处理。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { HOST_DB_FILE, HOST_PROJECTS_DIR } from './host.mjs'
import { HOOK_STATE_FILE } from './paths.mjs'
import { costOfUsage } from './pricing.mjs'
import { hostModelInfo } from './host-models.mjs'

const require = createRequire(import.meta.url)
const REOPEN_BACKOFF_MS = 5000
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024

// 积分口径的「币种」标记：前端与 CLI 见到它就走积分数值渲染，不加货币符号。
export const CREDIT_CURRENCY = 'CREDIT'

let sqliteModule = null
let sqliteProbed = false

function loadSqlite() {
  if (sqliteProbed) return sqliteModule
  sqliteProbed = true
  try {
    // node:sqlite 自 Node 22.5 起内置【实测 WorkBuddy 自带 node v22.22.2，可用】。
    // 拿不到时不抛错：调用方会退回「只读 transcript」的降级路径。
    sqliteModule = require('node:sqlite')
  } catch (err) {
    sqliteModule = null
  }
  return sqliteModule
}

export function sqliteAvailable() {
  return !!loadSqlite()
}

// ---------- 持久只读连接 ----------

let dbConn = null
let statements = null
let lastOpenFailAt = 0

const SESSION_USAGE_QUERY = `
  SELECT session_id, used, size, credit_json, updated_at
  FROM session_usage
  WHERE session_id = ?
`
const SESSION_ROW_QUERY = `
  SELECT id, cwd, model, title, custom_title, updated_at, last_activity_at, is_background_automation
  FROM sessions
  WHERE id = ?
`
// 没有 hook 状态时（例如手工在终端跑 cli）：取最近活跃的**前台**会话。
// is_background_automation 是宿主给后台自动化轮次打的标记，必须跳过，
// 否则角色会被后台任务带得乱动（HANDOFF §4 第 4 条的噪音过滤）。
const LATEST_SESSION_QUERY = `
  SELECT id, cwd, model, title, custom_title, updated_at, last_activity_at
  FROM sessions
  WHERE COALESCE(is_background_automation, 0) = 0 AND deleted_at IS NULL
  ORDER BY updated_at DESC, rowid DESC
  LIMIT 1
`
const USAGE_ROWS_QUERY = `
  SELECT session_id, used, size, credit_json, updated_at
  FROM session_usage
  ORDER BY updated_at DESC
  LIMIT 200
`

function openDb() {
  if (dbConn) return dbConn
  if (!fs.existsSync(HOST_DB_FILE)) return null
  if (Date.now() - lastOpenFailAt < REOPEN_BACKOFF_MS) return null
  const sqlite = loadSqlite()
  if (!sqlite) return null
  try {
    dbConn = new sqlite.DatabaseSync(HOST_DB_FILE, { readOnly: true, timeout: 2000 })
    statements = {
      sessionUsage: dbConn.prepare(SESSION_USAGE_QUERY),
      sessionRow: dbConn.prepare(SESSION_ROW_QUERY),
      latestSession: dbConn.prepare(LATEST_SESSION_QUERY),
      usageRows: dbConn.prepare(USAGE_ROWS_QUERY),
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

// 共享只读连接：用量记录聚合（usage-records.mjs）复用同一条连接与退避策略，
// 避免每个模块各自开库。返回 null 表示库不可用。
export function getSharedDb() {
  return openDb()
}

// ---------- 小工具 ----------

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function parseJson(text) {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : null
  } catch (err) {
    return null
  }
}

function tsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = Date.parse(String(v || ''))
  return Number.isFinite(t) ? t : 0
}

function readHookState() {
  return parseJson(fs.existsSync(HOOK_STATE_FILE) ? fs.readFileSync(HOOK_STATE_FILE, 'utf8') : '') || {}
}

// 会话 slug：宿主按 cwd 把 transcript 分到子目录。**不去复刻 slug 规则**
// （驱动器大小写/分隔符写法不稳定），而是按 sessionId 去 projects/*/ 里找同名 jsonl。
function findTranscriptBySession(sessionId) {
  const sid = String(sessionId || '')
  if (!sid) return ''
  let dirs = []
  try {
    dirs = fs.readdirSync(HOST_PROJECTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch (err) {
    return ''
  }
  for (const d of dirs) {
    const p = path.join(HOST_PROJECTS_DIR, d.name, sid + '.jsonl')
    if (fs.existsSync(p)) return p
  }
  return ''
}

// ---------- 当前会话 ----------

// 返回 { ok, sessionId, transcriptPath, model, modelName?, cwd, title, from }
// 优先钩子状态（会话内一定有：SessionStart/UserPromptSubmit 都会写），
// 没有则退回「最近活跃的前台会话」。
export function resolveSession() {
  const state = readHookState()
  const sid = String(state.sessionId || '')
  if (sid) {
    const conn = openDb()
    let row = null
    if (conn) {
      try {
        row = statements.sessionRow.get(sid)
      } catch (err) {
        closeDb()
      }
    }
    const transcriptPath = String(state.transcriptPath || '') || findTranscriptBySession(sid)
    if (row || transcriptPath) {
      return {
        ok: true,
        sessionId: sid,
        transcriptPath,
        model: (row && row.model) || String(state.model || ''),
        cwd: (row && row.cwd) || '',
        title: (row && (row.custom_title || row.title)) || '',
        from: 'hook-state',
      }
    }
  }
  const conn = openDb()
  if (!conn) return { ok: false, reason: 'db-unavailable' }
  let row = null
  try {
    row = statements.latestSession.get()
  } catch (err) {
    closeDb()
    return { ok: false, reason: 'db-read-failed' }
  }
  if (!row) return { ok: false, reason: 'no-session' }
  return {
    ok: true,
    sessionId: row.id,
    transcriptPath: findTranscriptBySession(row.id),
    model: row.model || '',
    cwd: row.cwd || '',
    title: row.custom_title || row.title || '',
    from: 'latest-session',
  }
}

export function readSessionUsage(sessionId) {
  const conn = openDb()
  if (!conn) return { ok: false, reason: 'db-unavailable' }
  try {
    const row = statements.sessionUsage.get(String(sessionId || ''))
    if (!row) return { ok: false, reason: 'no-usage' }
    return {
      ok: true,
      sessionId: row.session_id,
      used: num(row.used),
      size: num(row.size),
      credits: parseJson(row.credit_json) || {},
      updatedAt: num(row.updated_at) || 0,
    }
  } catch (err) {
    closeDb()
    return { ok: false, reason: 'db-read-failed' }
  }
}

// 上下文余量（ZCode 侧没有的能力，WorkBuddy 现成）。pct 为**已用**百分比。
export function readContextUsage(session) {
  const s = session || resolveSession()
  if (!s.ok) return { ok: false, reason: s.reason || 'no-session' }
  const u = readSessionUsage(s.sessionId)
  if (!u.ok) return { ok: false, reason: u.reason }
  const size = u.size > 0 ? u.size : 0
  return {
    ok: true,
    sessionId: s.sessionId,
    used: u.used,
    size,
    pct: size > 0 ? Math.min(100, Math.round((u.used / size) * 1000) / 10) : null,
    remaining: size > 0 ? Math.max(0, size - u.used) : null,
    updatedAt: u.updatedAt,
  }
}

// ---------- transcript 解析 ----------

// WorkBuddy 的 rawUsage → pricing.mjs 认得的形状。
// 关键映射：
//   prompt_tokens            = 总输入（**含**缓存命中）→ input_tokens
//   prompt_cache_hit_tokens  → cache_read_input_tokens（splitInputTokens 靠它减掉命中）
//   prompt_cache_write_tokens→ cache_creation_input_tokens
//   completion_tokens        **含**思考 → 非思考输出 = completion - thinking，思考单列
// 这样交给 costOfUsage，它自己会按「input 是总输入」口径拆分，不会重复计费。
//
// **优先用宿主自己拆好的 hit/miss**：宿主同时给了 `prompt_cache_hit_tokens` 与
// `prompt_cache_miss_tokens`；当下游的输入总量与两者之和不一致时（数据异常、
// 或上游改了字段语义），信宿主的分档比信「总量 − 命中」更可靠。做法是把
// `input_tokens` 传成 `hit + miss`，于是 splitInputTokens 算出的 miss 恰好等于
// 宿主给的 miss。两个字段都缺失时才退回 prompt_tokens。
export function usageFromRawUsage(raw) {
  const r = raw || {}
  const hit = num(r.prompt_cache_hit_tokens)
  const miss = num(r.prompt_cache_miss_tokens)
  const completion = num(r.completion_tokens)
  const thinking = num(r.completion_thinking_tokens)
  const promptTotal = num(r.prompt_tokens)
  const hasSplit = r.prompt_cache_hit_tokens !== undefined || r.prompt_cache_miss_tokens !== undefined
  const inputTokens = hasSplit ? hit + miss : promptTotal
  return {
    input_tokens: inputTokens,
    output_tokens: Math.max(0, completion - thinking),
    reasoning_tokens: thinking,
    cache_read_input_tokens: hit,
    cache_creation_input_tokens: num(r.prompt_cache_write_tokens),
    // 总量字段供 splitInputTokens 判口径：用「输入 + 输出」而非原样透传，
    // 免得宿主给的 total 与分档字段不一致时触发 Anthropic 分支而重复计价
    computed_total_tokens: inputTokens + completion,
  }
}

// 读一个 transcript，按 conversationRequestId 归并成「轮」。
// 返回按时间（行序）升序的轮数组；每轮含宿主积分、token 分桶与逐模型明细。
// maxBytes 用于只读尾部（用量记录聚合要扫很多文件，不需要读到历史最前面）。
//
// 【缓存】同 (path, size, mtimeMs) 直接复用解析结果：服务端每秒轮询一次轮次，
// 17MB 的 transcript 单次全量读+解析实测 30ms（事件循环被按住约 3%，期间
// /whale/health 等接口全部排队，2026-10-14 审查 P1-5）。缓存上限 6 份，超出按
// 插入序淘汰。**返回的是共享数组，调用方只读、不得改写。**
const TRANSCRIPT_CACHE_MAX = 6
const transcriptCache = new Map() // key -> 轮数组（只读）

export function readTranscriptTurns(transcriptPath, maxBytes) {
  const out = []
  if (!transcriptPath) return out
  let stat = null
  try {
    stat = fs.statSync(transcriptPath)
  } catch (err) {
    return out
  }
  const cacheKey = transcriptPath + '|' + stat.size + '|' + stat.mtimeMs
  const cached = transcriptCache.get(cacheKey)
  if (cached) return cached
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_TRANSCRIPT_BYTES
  let text = ''
  try {
    // 大文件只读尾部：一轮的历史明细用不到，只要最近的若干轮。
    const start = Math.max(0, stat.size - cap)
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    return out
  }
  const lines = text.split(/\r?\n/)
  const byId = new Map()
  let order = 0
  for (const line of lines) {
    if (!line || line.indexOf('rawUsage') === -1) continue
    const o = parseJson(line)
    const pd = o && o.providerData
    if (!pd || !pd.rawUsage) continue
    const rid = String(pd.conversationRequestId || o.id || '')
    if (!rid) continue
    let t = byId.get(rid)
    if (!t) {
      t = {
        requestId: rid,
        ts: tsOf(o.timestamp),
        model: '',
        modelName: '',
        calls: 0,
        credit: 0,
        tokens: 0,
        breakdown: { hit: 0, miss: 0, cacheWrite: 0, output: 0 },
        models: new Map(),
        order: order++,
      }
      byId.set(rid, t)
    }
    const raw = pd.rawUsage
    const usage = usageFromRawUsage(raw)
    const modelId = String(pd.requestModelId || pd.model || '')
    const modelName = String(pd.requestModelName || '')
    const priced = costOfUsage(modelId, usage, t.ts || Date.now(), '')
    const credit = num(raw.credit)
    const hit = usage.cache_read_input_tokens
    const miss = Math.max(0, usage.input_tokens - hit)
    const cw = usage.cache_creation_input_tokens
    const output = num(raw.completion_tokens)
    const tokens = hit + miss + cw + output
    t.calls += 1
    t.credit += credit
    t.tokens += tokens
    t.breakdown.hit += hit
    t.breakdown.miss += miss
    t.breakdown.cacheWrite += cw
    t.breakdown.output += output
    t.marketAmount = (t.marketAmount || 0) + (priced.billable ? priced.amount : 0)
    t.marketCurrency = priced.currency || t.marketCurrency || 'CNY'
    if (modelId) t.model = modelId
    if (modelName) t.modelName = modelName
    if (!t.ts) t.ts = tsOf(o.timestamp)
    const key = modelId + '|' + modelName
    let m = t.models.get(key)
    if (!m) {
      m = {
        model: modelId,
        modelName,
        calls: 0,
        credit: 0,
        tokens: 0,
        amount: 0,
        currency: priced.currency || 'CNY',
        billable: !!priced.billable,
        vendor: priced.vendor,
        vendorLabel: priced.vendorLabel,
        tier: priced.tier,
        peak: !!priced.peak,
        breakdown: { hit: 0, miss: 0, cacheWrite: 0, output: 0 },
        rates: priced.rates || null,
      }
      t.models.set(key, m)
    }
    m.calls += 1
    m.credit += credit
    m.tokens += tokens
    m.amount += priced.billable ? priced.amount : 0
    m.breakdown.hit += hit
    m.breakdown.miss += miss
    m.breakdown.cacheWrite += cw
    m.breakdown.output += output
    if (priced.rates) m.rates = priced.rates
  }
  const turns = [...byId.values()].sort((a, b) => a.order - b.order)
  for (const t of turns) {
    t.models = [...t.models.values()].sort((a, b) => b.credit - a.credit || b.tokens - a.tokens)
    delete t.order
  }
  // 入缓存（见函数头）：超出上限按插入序淘汰
  transcriptCache.set(cacheKey, turns)
  while (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
    transcriptCache.delete(transcriptCache.keys().next().value)
  }
  return turns
}

// ---------- 对外主入口 ----------

// 最近一轮完成的消耗。**积分为主口径**（amount/currency 即积分值 + 'CREDIT'），
// 另附 marketAmount/marketCurrency（按公开价目折算的等价市值）供厂商卡与明细用。
// 读不到数据时返回 ok:false 但仍是结构化结果，前端不会因此报错。
//
// offset=0 取最新一轮；offset=1 取**上一轮**。WB 的积分是逐次模型调用就预先落账
// 的（transcript 一出现新 rid、credit_json 里立刻有它的积分），而一轮常有多次调用，
// 「上一轮消耗」气泡必须等轮次推进才弹 —— 服务端在 rid 前进时用 offset=1 取
// 刚完结的上一轮（见 server.mjs 的 pollTurnCost）。
export function readLatestTurn(offset = 0) {
  const session = resolveSession()
  if (!session.ok) return { ok: false, reason: session.reason || 'no-session' }
  const usage = readSessionUsage(session.sessionId)
  const turns = readTranscriptTurns(session.transcriptPath)
  const last = turns.length > offset ? turns[turns.length - 1 - offset] : null
  if (!last) {
    // 库里有积分但没有 transcript（例如 transcript 被清理）：只用宿主积分兜底，
    // 模型名退到 sessions.model。
    if (usage.ok) {
      const ids = Object.keys(usage.credits || {})
      if (ids.length > offset) {
        const rid = ids[ids.length - 1 - offset]
        const credit = num(usage.credits[rid])
        // 这条兜底路径没有 transcript，只能拿当前模型 + 结算时间判免费（同主路径口径）
        const hmFallback = hostModelInfo(session.model || '', usage.updatedAt || Date.now())
        return {
          ok: true,
          source: 'session_usage',
          sessionId: session.sessionId,
          turnId: rid,
          ts: usage.updatedAt || Date.now(),
          model: session.model || '',
          providerId: '',
          amount: credit,
          credit,
          currency: CREDIT_CURRENCY,
          amounts: { [CREDIT_CURRENCY]: credit },
          tokens: 0,
          peak: false,
          tier: 'none',
          billable: credit > 0,
          free: hmFallback.free,
          freeLabel: hmFallback.freeLabel,
          vendor: null,
          vendorLabel: '订阅积分',
          breakdown: { hit: 0, miss: 0, cacheWrite: 0, output: 0 },
          models: [],
          partial: true,
        }
      }
    }
    // 读不到数据时区分「真的还没有数据」与「环境读不了」（node:sqlite 缺失）：
    // 后者带上 degraded，服务端据此按 30s 退避而不是每 2.5s 重扫一遍
    // transcript（审查 P1/C2）。
    return sqliteAvailable()
      ? { ok: false, reason: 'no-turn-data' }
      : {
          ok: false,
          reason: 'no-turn-data',
          hint: 'node:sqlite 不可用（需要 Node ≥ 22.5，当前 ' + process.version + '）',
          degraded: true,
        }
  }
  // 宿主算好的 credit 优先（credit_json 是权威值）；缺失时用 rawUsage.credit 求和兜底。
  const hostCredit = usage.ok && last.requestId in (usage.credits || {}) ? num(usage.credits[last.requestId]) : null
  const credit = hostCredit === null ? last.credit : hostCredit
  const vendorLabel = last.models.length ? last.models[0].vendorLabel : '订阅积分'
  const vendor = last.models.length ? last.models[0].vendor : null
  // 免费促销标注（宿主商品配置）：这一轮 0 积分时，说清「是免费模型」而不是
  // 「网关/套餐」，气泡就不必把「0 积分」当消耗摆出来（见 lib/host-models.mjs）。
  const hm = hostModelInfo(last.model || session.model || '', last.ts || Date.now())
  return {
    ok: true,
    source: 'transcript',
    sessionId: session.sessionId,
    turnId: last.requestId,
    ts: last.ts || Date.now(),
    model: last.model || session.model || '',
    modelName: last.modelName || '',
    providerId: '',
    amount: credit,
    credit,
    // 附加的等价市值（按公开价目折算）。不代表真实扣费，仅供对账参考。
    marketAmount: last.marketAmount || 0,
    marketCurrency: last.marketCurrency || 'CNY',
    currency: CREDIT_CURRENCY,
    amounts: { [CREDIT_CURRENCY]: credit },
    tokens: last.tokens,
    peak: last.models.some((m) => m.peak),
    tier: last.models.length ? last.models[0].tier : 'none',
    billable: credit > 0,
    free: hm.free,
    freeLabel: hm.freeLabel,
    vendor,
    vendorLabel: credit > 0 ? '订阅积分' : vendorLabel,
    breakdown: last.breakdown,
    models: last.models,
    calls: last.calls,
    // transcript 已出现该请求但 credit_json 还没记 = 该轮仍在进行/尚未结算
    partial: hostCredit === null,
  }
}

// 上游用「seq 递增」让前端识别新的一轮。这里由识别 (session, request) 是否变化
// 得到同样的效果，而且服务重启后不会把旧轮次误判成新的。
export function turnIdentity(current) {
  if (!current || !current.ok) return ''
  return current.sessionId + '/' + current.turnId
}

// 当前模型：给「按模型自动换角色」与计费源判定用。
// WorkBuddy 的 sessions.model 就是当前选择的模型（实测值见 phase-0.md），
// transcript 的 requestModelId 是「最近一次真实调用用的模型」，作为兜底。
export function readActiveSelection() {
  const session = resolveSession()
  if (session.ok && session.model) {
    return { ok: true, providerId: '', modelId: session.model, updatedAt: Date.now() }
  }
  const turns = session.ok ? readTranscriptTurns(session.transcriptPath) : []
  const last = turns.length ? turns[turns.length - 1] : null
  if (last && last.model) return { ok: true, providerId: '', modelId: last.model, updatedAt: last.ts || 0 }
  return { ok: false, reason: session.ok ? 'no-model' : session.reason || 'no-session' }
}

export function readLatestUsageModel() {
  const session = resolveSession()
  if (!session.ok) return { ok: false, reason: session.reason || 'no-session' }
  const turns = readTranscriptTurns(session.transcriptPath)
  const last = turns.length ? turns[turns.length - 1] : null
  if (last && last.model) return { ok: true, providerId: '', modelId: last.model, ts: last.ts || 0 }
  if (session.model) return { ok: true, providerId: '', modelId: session.model, ts: 0 }
  return { ok: false, reason: 'no-usage' }
}

// 今日积分合计（宿主口径）：把当天有更新的会话的 credit_json 汇总。
// 说明：credit_json 是**按 requestId 累积**的键值表（实测单会话有 18 个请求键，
// 2026-10-14 审查 P2-A 推翻了早先「按请求覆盖、只留最后一笔」的判断），但它
// **没有时间戳**，无法知道每笔属于哪一天 —— 所以这里只能做「库不可用/无
// transcript」时的轻量兜底，且只取每会话最后一笔（偏低）。真正的按日聚合走
// transcript（lib/usage-records.mjs 的 usageRecords）。
export function todayCreditFromUsage() {
  const conn = openDb()
  if (!conn) return { ok: false, reason: 'db-unavailable' }
  let rows = []
  try {
    rows = statements.usageRows.all()
  } catch (err) {
    closeDb()
    return { ok: false, reason: 'db-read-failed' }
  }
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const dayStart = start.getTime()
  let total = 0
  let sessions = 0
  for (const r of rows) {
    if (num(r.updated_at) < dayStart) continue
    const credits = parseJson(r.credit_json) || {}
    const ids = Object.keys(credits)
    if (!ids.length) continue
    sessions += 1
    total += num(credits[ids[ids.length - 1]])
  }
  return { ok: true, credit: total, sessions }
}

export { costOfUsage }
