// 用量记录聚合：直接读 ZCode 的 model_usage 库做按日/按模型统计。
//
// 与上游 DSH 版的差异：上游靠插件自己的事件账本，这里 ZCode 本来就把每轮、
// 每模型的真实 usage 落库（model_usage 一行 = 一次模型调用，含完整 token 分桶），
// 直读即可，不需要镜像账本，也不用做 90 天裁剪（库的生命周期归 ZCode 管）。
//
// 口径与每轮消耗一致（lib/pricing.mjs）：逐行按厂商价目折算金额，
// 不可计价供应商（订阅套餐/网关）amount 记 0 但 tokens 照算；
// 「今日已用（金额）」= 当日可计价行的金额合计（本机口径）。
//
// 明细按「轮」聚合：一轮 agent 循环会对 model_usage 落几十上百行（每次模型
// 调用一行、时间相差几分钟），直接逐行展示就是一堆分钟级小账；这里按
// session_id + turn_id 归并，一条明细 = 一轮对话的全部模型调用之和。
import { getSharedDb } from './turn-cost.mjs'
import { costOfUsage } from './pricing.mjs'

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
    statements = { range: conn.prepare(RANGE_QUERY) }
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
  return {
    ts: Number(r.started_at) || 0,
    model: r.model_id || '',
    providerId: r.provider_id || '',
    vendorLabel: c.vendorLabel,
    vendor: c.vendor,
    tokens: c.tokens,
    amount: c.amount,
    billable: c.billable,
  }
}

function blankDay() {
  return { total: 0, tokens: 0, models: new Map() }
}

function addRow(day, row) {
  day.total += row.amount
  day.tokens += row.tokens
  const key = row.model + '|' + row.providerId
  let m = day.models.get(key)
  if (!m) {
    m = { model: row.model, providerId: row.providerId, vendorLabel: row.vendorLabel, tokens: 0, amount: 0 }
    day.models.set(key, m)
  }
  m.tokens += row.tokens
  m.amount += row.amount
}

function modelsList(modelsMap, limit) {
  const list = [...modelsMap.values()].sort((a, b) => b.amount - a.amount || b.tokens - a.tokens)
  return limit ? list.slice(0, limit) : list
}

// 汇总：今日 / 近 7 天 / 最近轮次（按轮聚合的明细）。db 不可用时返回 { ok:false, reason }。
export function usageRecords() {
  const st = getStatements()
  if (!st) return { ok: false, reason: 'db-unavailable' }
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
      t = { ts: priced.ts, calls: 0, amount: 0, tokens: 0, billable: false, models: new Map() }
      turnMap.set(tkey, t)
    }
    if (priced.ts < t.ts) t.ts = priced.ts
    t.calls += 1
    t.amount += priced.amount
    t.tokens += priced.tokens
    if (priced.billable) t.billable = true
    const mk = priced.model + '|' + priced.providerId
    let m = t.models.get(mk)
    if (!m) {
      m = { model: priced.model, providerId: priced.providerId, vendorLabel: priced.vendorLabel, calls: 0, amount: 0, tokens: 0 }
      t.models.set(mk, m)
    }
    m.calls += 1
    m.amount += priced.amount
    m.tokens += priced.tokens
  })

  const days = [...byDay.keys()].sort()
  const daysList = days.map((d) => {
    const b = byDay.get(d)
    return { date: d, total: b.total, tokens: b.tokens }
  })

  // 近 7 天按模型合计（占比条数据）
  const week = blankDay()
  for (const b of byDay.values()) {
    week.total += b.total
    week.tokens += b.tokens
    for (const [key, m] of b.models) {
      let m2 = week.models.get(key)
      if (!m2) {
        m2 = { model: m.model, providerId: m.providerId, vendorLabel: m.vendorLabel, tokens: 0, amount: 0 }
        week.models.set(key, m2)
      }
      m2.tokens += m.tokens
      m2.amount += m.amount
    }
  }

  // 明细按开始时间倒序，最新一轮在最上；轮内模型按金额降序（复用 modelsList）
  const turns = [...turnMap.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((t) => ({
      ts: t.ts,
      calls: t.calls,
      amount: t.amount,
      tokens: t.tokens,
      billable: t.billable,
      models: modelsList(t.models, 8),
    }))

  return {
    ok: true,
    generatedAt: Date.now(),
    today: {
      date: dayKey(todayStart),
      total: today.total,
      tokens: today.tokens,
      models: modelsList(today.models, 12),
    },
    days7: { total: week.total, tokens: week.tokens, byDay: daysList },
    modelsWeek: modelsList(week.models, 12),
    turns: turns.slice(-100).reverse(),
  }
}
