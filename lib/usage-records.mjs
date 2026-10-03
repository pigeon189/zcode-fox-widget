// 用量记录聚合：直接读 ZCode 的 model_usage 库做按日/按模型统计。
//
// 与上游 DSH 版的差异：上游靠插件自己的事件账本，这里 ZCode 本来就把每轮、
// 每模型的真实 usage 落库（model_usage 一行 = 一次模型调用，含完整 token 分桶），
// 直读即可，不需要镜像账本，也不用做 90 天裁剪（库的生命周期归 ZCode 管）。
//
// 口径与每轮消耗一致（lib/pricing.mjs + lib/plan-balance.mjs）：
//   - 逐行按厂商价目折算金额（pricing 层的「等价市值」）；
//   - **订阅套餐行（resolveBillingSource 的 source='plan'，如 zai start-plan/
//     coding-plan）不计真金白银**：套餐按配额扣、不花钱，金额记 0、billable=false
//     但 tokens 照算——与轮级 turnPlanUsage/extraAmountsOfTurn 同一口径
//     （它们同样把 plan 行当配额剔出金额）；面板里这类行显示 tokens/配额。
//     唯一例外在用量记录面板的「模型排名」：行级 market（等价市值）让 Plan 行
//     参与排序与占比条（金额 0 的空进度条没法看），前端以 ≈ 标注非真实花费；
//     今日合计/对账/厂商汇总仍只含真金白银，两条口径不混。
//   - 网关/未知模型不可计价（pricing kind='none'/'free'）amount 同样记 0。
//   例外一：MiMo Token Plan（source='mimo-plan'）没有公开配额接口，主显示保留
//   「按今日消耗折算」的等价市值（README「MiMo 双源拆分」），是文档化的口径。
//   例外二：CommandCode Go（source='cmdgo'）**有意按模型市场价折算**计入金额，
//   不剔出「今日已用」。理由是它是预付 credit 池：额度本身由鲸鱼额度卡按百分比
//   表达（5 小时/周/月三道窗口），而「这一轮烧掉多少」只有折算成钱才有量纲可读；
//   套餐行（plan）剔出金额是因为它们按配额扣、连消费量都没有金额意义，两者不同。
//   已知代价：credit 以 USD 计价，行情是各厂商本币价，多币种日的「今日已用」
//   因此是「等价口径」而非账单口径，README「数据与计价口径」有同样声明。
// 「今日已用（金额）」= 当日可计价行的金额合计（本机口径）。
//
// 明细按「轮」聚合：一轮 agent 循环会对 model_usage 落几十上百行（每次模型
// 调用一行、时间相差几分钟），直接逐行展示就是一堆分钟级小账；这里按
// session_id + turn_id 归并，一条明细 = 一轮对话的全部模型调用之和。
import { getSharedDb } from './turn-cost.mjs'
import { costOfUsage } from './pricing.mjs'
import { resolveBillingSource } from './source.mjs'

let statements = null
let statementsConn = null

const RANGE_QUERY = `
  SELECT mu.model_id, mu.provider_id, mu.session_id, mu.turn_id, mu.started_at,
    mu.input_tokens, mu.output_tokens, mu.reasoning_tokens,
    mu.cache_read_input_tokens, mu.cache_creation_input_tokens, mu.computed_total_tokens
  FROM model_usage mu
  WHERE mu.status = 'completed' AND mu.started_at >= ?
  ORDER BY mu.started_at
`

// 记忆化指纹：一行聚合查询（行数 + 最晚时间）。调用方多（主显示 25s、面板 30s、
// 页面 60s 轮询），7 天窗口逐行折价不便宜；只按 TTL 缓存又会让刚落库的用量晚
// 半分钟才显示。指纹变了 = 库变过 → 重算，指纹没变且在 TTL 内 → 直接回缓存。
const FINGERPRINT_QUERY = `
  SELECT COUNT(*) AS n, COALESCE(MAX(started_at), 0) AS m FROM model_usage
`
const REC_CACHE_TTL_MS = 30_000

function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function startOfToday() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function getStatements() {
  const conn = getSharedDb()
  if (!conn) return null
  if (statements && statementsConn === conn) return statements
  try {
    statements = {
      range: conn.prepare(RANGE_QUERY),
      fingerprint: conn.prepare(FINGERPRINT_QUERY),
    }
    statementsConn = conn
    return statements
  } catch (err) {
    return null
  }
}

function priceRow(r) {
  const usage = {
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    reasoning_tokens: r.reasoning_tokens,
    cache_read_input_tokens: r.cache_read_input_tokens,
    cache_creation_input_tokens: r.cache_creation_input_tokens,
    computed_total_tokens: r.computed_total_tokens,
  }
  const c = costOfUsage(r.model_id, usage, Number(r.started_at) || Date.now(), r.provider_id)
  // 订阅套餐行（zai start-plan/coding-plan 等）按配额扣、不花钱：金额记 0、
  // 不算可计价，tokens 照算。pricing 层给的是「等价市值」（计算与展示要用到
  // 等价市值的地方如 MiMo Plan 今日消耗、computeTodayUsage），但「今日已用
  // （金额）」与厂商金额合计只能含真金白银，否则套餐用量会把金额虚高
  // （与 turnPlanUsage/extraAmountsOfTurn 的剔除口径一致）。
  const planQuota = resolveBillingSource(r.provider_id, r.model_id).source === 'plan'
  return {
    ts: Number(r.started_at) || 0,
    model: r.model_id || '',
    providerId: r.provider_id || '',
    vendorLabel: c.vendorLabel,
    vendor: c.vendor,
    tokens: c.tokens,
    amount: planQuota ? 0 : c.amount,
    // 等价市值（pricing 层折算）：订阅套餐行也有值。真金白银口径（今日合计/
    // 厂商汇总/预警）不用它；只有用量记录的「模型排名」拿它给 Plan 行参与
    // 排名与占比条（金额 0 的空进度条没法看），前端行上以 ≈ 标注非真实花费
    market: c.amount,
    plan: planQuota,
    currency: c.currency || 'CNY',
    billable: planQuota ? false : c.billable,
  }
}

function blankDay() {
  // total 为各币种直接相加的数值合计（单币种时精确）；totals 按币种分列，
  // 展示层一律用 totals，多币种不混加。
  return { total: 0, tokens: 0, totals: {}, models: new Map() }
}

function addAmount(totals, currency, amount) {
  const cur = currency || 'CNY'
  totals[cur] = (totals[cur] || 0) + amount
}

function addRow(day, row) {
  day.total += row.amount
  day.tokens += row.tokens
  addAmount(day.totals, row.currency, row.amount)
  const key = row.model + '|' + row.providerId
  let m = day.models.get(key)
  if (!m) {
    m = { model: row.model, providerId: row.providerId, vendorLabel: row.vendorLabel, currency: row.currency, tokens: 0, amount: 0, market: 0, plan: false }
    day.models.set(key, m)
  }
  m.tokens += row.tokens
  m.amount += row.amount
  m.market += row.market || 0
  if (row.plan) m.plan = true
}

// 金额榜的排名键：优先等价市值。Plan 套餐行 amount=0 但 market>0，靠它参与
// 排名与占比条；其余行 market 与 amount 相等，排序结果与真金白银口径一致
const rankByMarket = (m) => Number(m.market) || 0

function modelsList(modelsMap, limit, rankKey) {
  const rank = rankKey || ((m) => Number(m.amount) || 0)
  const list = [...modelsMap.values()].sort((a, b) => rank(b) - rank(a) || b.tokens - a.tokens)
  return limit ? list.slice(0, limit) : list
}

// 按 token 消耗排序的同款列表（页面「按 Token 排名」用）。
// 两个榜的头部常常不是同一批模型（便宜的模型可能 token 巨大、贵的模型 token 很小），
// 所以服务端把两个榜都截好给页面，页面只做展示不做排序。
export function modelsByTokens(modelsMap, limit) {
  const list = [...modelsMap.values()].sort((a, b) => b.tokens - a.tokens || b.amount - a.amount)
  return limit ? list.slice(0, limit) : list
}

// 厂商级汇总（按 pricing 的厂商标签）：主显示「今日已用」与面板「对账」都用它，
// 数字与面板逐模型明细出自同一批行，不会两处对不上。用完整模型表（不是截断后的
// Top12 列表）分组，模型多的日子也不会少算。
function vendorSums(modelsMap) {
  const out = {}
  for (const m of modelsMap.values()) {
    const k = m.vendorLabel || '未知'
    if (!out[k]) out[k] = { amount: 0, tokens: 0, currency: m.currency || 'CNY' }
    out[k].amount += Number(m.amount) || 0
    out[k].tokens += Number(m.tokens) || 0
    if (m.currency) out[k].currency = m.currency
  }
  for (const k of Object.keys(out)) out[k].amount = Math.round(out[k].amount * 1e6) / 1e6
  return out
}

// 本机库口径的「今日已用」：当天某个厂商的模型调用合计（金额 + tokens）。
// 这是主显示的口径来源——它按模型/按厂商看得见、不受充值干扰；账号口径
// （小鲸鱼记账 / 实时·令牌）退居「对账 + 本机无数据时的兜底」。
// hasRows=false 表示今天本机没有该厂商的调用记录，调用方应回退账号口径。
// 与 usageRecords() 共用同一次聚合（见上），保证主显示和面板永远同源。
export function todayVendorUsage(vendorLabel) {
  const want = String(vendorLabel || '')
  const blank = { ok: false, hasRows: false, amount: 0, tokens: 0, currency: 'CNY' }
  if (!want) return blank
  const rec = usageRecords()
  if (!rec || !rec.ok) return blank
  const hit = rec.today.byVendor[want]
  if (!hit) return { ok: true, hasRows: false, amount: 0, tokens: 0, currency: 'CNY' }
  return {
    ok: true,
    hasRows: true,
    amount: hit.amount,
    tokens: hit.tokens,
    currency: hit.currency || 'CNY',
  }
}

// 汇总：今日 / 近 7 天 / 最近轮次（按轮聚合的明细）。db 不可用时返回 { ok:false, reason }。
// 记忆化：表指纹（行数+最晚时间）没变且在 TTL 内直接回缓存——见 FINGERPRINT_QUERY。
let recCache = null

export function usageRecords() {
  const st = getStatements()
  if (!st) return { ok: false, reason: 'db-unavailable' }
  let fp = null
  try {
    const row = st.fingerprint.get()
    fp = String(row ? row.n : 0) + ':' + String(row ? row.m : 0)
  } catch (err) {
    fp = null
  }
  const now = Date.now()
  if (recCache && fp !== null && recCache.fp === fp && now - recCache.at < REC_CACHE_TTL_MS) {
    return recCache.payload
  }
  const payload = computeUsageRecords(st, now)
  recCache = { at: now, fp, payload }
  return payload
}

function computeUsageRecords(st, now) {
  const todayStart = startOfToday()
  const weekStart = todayStart - 6 * 86400_000
  let rows = []
  try {
    rows = st.range.all(weekStart)
  } catch (err) {
    return { ok: false, reason: 'db-read-failed' }
  }

  const today = blankDay()
  const byDay = new Map()
  const turnMap = new Map()
  rows.forEach((r, i) => {
    const priced = priceRow(r)
    if (!priced.tokens) return
    const day = dayKey(priced.ts)
    if (!byDay.has(day)) byDay.set(day, blankDay())
    const bucket = byDay.get(day)
    addRow(bucket, priced)
    if (priced.ts >= todayStart) addRow(today, priced)

    // 按轮归并：同 session/turn 的所有模型行合成一条明细；缺失 turn_id 的
    // 旧行无法归轮，退化为逐行一条，避免把不相干的行并进同一轮。
    const tkey = r.turn_id ? (r.session_id || '') + '/' + r.turn_id : '@row-' + i + '-' + turnMap.size
    let t = turnMap.get(tkey)
    if (!t) {
      t = { ts: priced.ts, calls: 0, amount: 0, tokens: 0, totals: {}, billable: false, models: new Map() }
      turnMap.set(tkey, t)
    }
    if (priced.ts < t.ts) t.ts = priced.ts
    t.calls += 1
    t.amount += priced.amount
    t.tokens += priced.tokens
    addAmount(t.totals, priced.currency, priced.amount)
    if (priced.billable) t.billable = true
    const mk = priced.model + '|' + priced.providerId
    let m = t.models.get(mk)
    if (!m) {
      m = { model: priced.model, providerId: priced.providerId, vendorLabel: priced.vendorLabel, currency: priced.currency, calls: 0, amount: 0, tokens: 0 }
      t.models.set(mk, m)
    }
    m.calls += 1
    m.amount += priced.amount
    m.tokens += priced.tokens
  })

  const days = [...byDay.keys()].sort()
  const daysList = days.map((d) => {
    const b = byDay.get(d)
    return { date: d, total: b.total, tokens: b.tokens, totals: b.totals }
  })

  // 近 7 天按模型合计（占比条数据）
  const week = blankDay()
  for (const b of byDay.values()) {
    week.total += b.total
    week.tokens += b.tokens
    for (const [cur, amt] of Object.entries(b.totals)) addAmount(week.totals, cur, amt)
    for (const [key, m] of b.models) {
      let m2 = week.models.get(key)
      if (!m2) {
        m2 = { model: m.model, providerId: m.providerId, vendorLabel: m.vendorLabel, currency: m.currency, tokens: 0, amount: 0, market: 0, plan: false }
        week.models.set(key, m2)
      }
      m2.tokens += m.tokens
      m2.amount += m.amount
      m2.market += m.market || 0
      if (m.plan) m2.plan = true
    }
  }

  // 明细按开始时间倒序，最新一轮在最上；轮内模型按金额降序（复用 modelsList）
  const turns = [...turnMap.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((t) => ({
      ts: t.ts,
      calls: t.calls,
      amount: t.amount,
      currency: Object.keys(t.totals).sort((x, y) => t.totals[y] - t.totals[x])[0] || 'CNY',
      totals: t.totals,
      tokens: t.tokens,
      billable: t.billable,
      models: modelsList(t.models, 8),
    }))

  return {
    ok: true,
    generatedAt: now,
    today: {
      date: dayKey(todayStart),
      total: today.total,
      tokens: today.tokens,
      totals: today.totals,
      // 金额榜排名值合计（含 Plan 行的等价市值）——占比条分母；与 total
      // （真金白银口径的「今日已用」）分开，两条口径不混。
      // 已知局限（同 blankDay 的注记）：这里是各币种 market 直接相加/比较，
      // 单币种时精确，多币种日的排序与占比条会按数值而非汇率比较（¥50 会排在
      // $10≈¥71 前面）。展示层不承诺汇率换算，故保留数值口径。
      rankTotal: [...today.models.values()].reduce((s, m) => s + (Number(m.market) || 0), 0),
      models: modelsList(today.models, 12, rankByMarket),
      modelsByTokens: modelsByTokens(today.models, 12),
      // 厂商级汇总：主显示与「对账」行用它（同一批行，保证与明细同源）
      byVendor: vendorSums(today.models),
    },
    days7: { total: week.total, tokens: week.tokens, totals: week.totals, byDay: daysList },
    turns: turns.slice(-100).reverse(),
  }
}
