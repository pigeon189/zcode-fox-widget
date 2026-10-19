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
//   CommandCode Go（source='cmdgo'）**同样不计真金白银**：它是预付 credit 池，
//   钱在买 credit 时就付了，一轮轮的消耗只有折算成钱才有量纲可读，所以折算值
//   留在等价市值（模型排名里以 ≈ 标注）与它的三重额度卡上，不并进任何厂商的
//   「今日已用」。2026-10-15 修正（此前有意计入，见 git log），起因：同一天先走
//   CommandCode 再转官方 API，官方 ¥1.48 被 credit 折算的 ¥4.26 抬高成 ¥5.73，
//   一眼看上去像官方 API 花了 5 块多。
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

// 记忆化指纹：只要「最晚 rowid」。调用方多（主显示 25s、面板 30s、页面 60s
// 轮询），7 天窗口逐行折价不便宜；只按 TTL 缓存又会让刚落库的用量晚半分钟才
// 显示。指纹变了 = 库变过 → 重算，指纹没变且在 TTL 内 → 直接回缓存。
// 用 rowid 而非 started_at：DB 只读打开、建不了 started_at 索引，后者只能全表扫；
// rowid 走内建 btree。曾被带上 COUNT(*)，那是**全表扫**且对判定毫无帮助——
// 追加行必然让 MAX(rowid) 变大，删除行也不会让 MAX 变大（审查 P3）。
const FINGERPRINT_QUERY = `
  SELECT COALESCE(MAX(rowid), 0) AS m FROM model_usage
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
  // 预付池行（订阅套餐 plan、CommandCode credit）按配额扣、不花该厂商的按量账单：
  // 金额记 0、不算可计价，tokens 照算。pricing 层给的是「等价市值」（要用到
  // 等价市值的地方见下），但「今日已用（金额）」与厂商金额合计只能含真金白银，
  // 否则预付池用量会把金额虚高（与 turnPlanUsage/extraAmountsOfTurn 的剔除口径一致）。
  //
  // CommandCode 这条是 2026-10-15 补的，起因是一个真实误报：当天上午走
  // CommandCode 反代、下午转官方 API，官方那部分折价 ¥1.48，而「DeepSeek 今日
  // 已用」把它和 CommandCode 的 credit 折算（¥4.26，其中 8 千万 cache 读占大头）
  // 加在一起显示 ¥5.73 —— 用户看到的是「我一共才花了 1 块多」。credit 池的钱在
  // 买 credit 时就付了，不该并进任何厂商的按量账单。
  const billSrc = resolveBillingSource(r.provider_id, r.model_id)
  const prepaid = billSrc.source === 'plan' || billSrc.source === 'cmdgo'
  // 金额归零之后，CommandCode 的厂商标签也归到它自己（第三方转售，不是 DeepSeek
  // 的订阅）：否则面板里两个来源的 tokens 并成一格、看不出钱花在哪。订阅套餐行
  // 仍按模型厂商归组（GLM Plan 就是 GLM 自己的配额）。
  const reseller = billSrc.source === 'cmdgo'
  return {
    ts: Number(r.started_at) || 0,
    model: r.model_id || '',
    providerId: r.provider_id || '',
    vendorLabel: reseller ? billSrc.label : c.vendorLabel,
    vendor: reseller ? billSrc.vendor : c.vendor,
    tokens: c.tokens,
    amount: prepaid ? 0 : c.amount,
    // 等价市值（pricing 层折算）：预付池行也有值。真金白银口径（今日合计/
    // 厂商汇总/预警）不用它；只有用量记录的「模型排名」拿它给这类行参与
    // 排名与占比条（金额 0 的空进度条没法看），前端行上以 ≈ 标注非真实花费
    market: c.amount,
    plan: prepaid,
    currency: c.currency || 'CNY',
    billable: prepaid ? false : c.billable,
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
// （大肥鱼记账 / 实时·令牌）退居「对账 + 本机无数据时的兜底」。
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
    fp = String(row ? row.m : 0)
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

  // 近 7 天按模型合计（占比条数据）。除了「每日汇总」，也把两个榜一起算好：
  // 页面可以在「按当天 / 按 7 天」之间切换，两个范围都直接拿现成的排序结果。
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
    days7: {
      total: week.total,
      tokens: week.tokens,
      totals: week.totals,
      byDay: daysList,
      // 与 today 同形的两个榜：页面的「按当天 / 按 7 天」切换直接换数据源，
      // 不在前端重排/截断（排序口径与当天榜完全一致）。
      rankTotal: [...week.models.values()].reduce((s, m) => s + (Number(m.market) || 0), 0),
      models: modelsList(week.models, 12, rankByMarket),
      modelsByTokens: modelsByTokens(week.models, 12),
    },
    turns: turns.slice(-100).reverse(),
  }
}
