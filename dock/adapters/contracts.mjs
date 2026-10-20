// 适配器契约（R4）。
//
// 设计取舍（D006）：**只支持内置适配器 + 声明式匹配规则**，不加载第三方 JS。
// 第三方代码意味着沙箱、签名、杀软误报三座山；而「进程名 + 路径片段 + 标题片段」
// 这套声明式规则已经能覆盖实际需求。
//
// 一个适配器长这样：
//   {
//     id: 'zcode',
//     name: 'ZCode',
//     priority: 10,                       // 同分时的排序（大的优先）
//     match: {                            // 各维度 AND，维度内 OR；空维度忽略
//       exeBasenames: ['zcode.exe'],
//       exeIncludes: ['\\.zcode\\'],
//       titleIncludes: ['zcode'],
//     },
//     capabilities: { billing: true, follow: true },
//     createBilling(ctx) { return { snapshot() {...} } },
//   }
//
// **没有任何匹配约束的适配器永不命中**——否则一个写错的适配器会成为吞噬所有窗口的兜底。

export const UNITS = ['money', 'credit', 'percent']

const MATCH_DIMENSIONS = ['exeBasenames', 'exeIncludes', 'titleIncludes', 'titlePatterns', 'classes']

export function basenameOf(p) {
  const s = String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .trim()
  const i = s.lastIndexOf('/')
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase()
}

export function normalizeWindow(win) {
  const w = win && typeof win === 'object' ? win : {}
  return {
    exe: String(w.exe == null ? '' : w.exe),
    exeBase: basenameOf(w.exe),
    exeLower: String(w.exe == null ? '' : w.exe).replace(/\\/g, '/').toLowerCase(),
    title: String(w.title == null ? '' : w.title),
    titleLower: String(w.title == null ? '' : w.title).toLowerCase(),
    cls: String(w.cls == null ? '' : w.cls),
    pid: Number(w.pid) || 0,
    hwnd: String(w.hwnd == null ? '' : w.hwnd),
  }
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim())
  if (typeof v === 'string' && v.trim()) return [v]
  return []
}

function asRegexArray(v) {
  if (!Array.isArray(v)) return []
  return v.filter((x) => x instanceof RegExp)
}

// 返回匹配得分：-1 = 不匹配，>=1 = 匹配（分越高越具体，用于同分排序）
export function scoreMatch(spec, win) {
  if (!spec || typeof spec !== 'object') return -1
  const w = win && win.exeBase !== undefined ? win : normalizeWindow(win)

  let dimensions = 0
  let score = 0

  const check = (list, test) => {
    dimensions++
    return list.some(test)
  }

  const bases = asArray(spec.exeBasenames).map((s) => basenameOf(s))
  if (bases.length) {
    if (!check(bases, (b) => b === w.exeBase)) return -1
    score += 2
  }

  const includes = asArray(spec.exeIncludes).map((s) => s.replace(/\\/g, '/').toLowerCase())
  if (includes.length) {
    if (!check(includes, (s) => w.exeLower.includes(s))) return -1
    score += 1
  }

  const titles = asArray(spec.titleIncludes).map((s) => s.toLowerCase())
  if (titles.length) {
    if (!check(titles, (s) => w.titleLower.includes(s))) return -1
    score += 1
  }

  const patterns = asRegexArray(spec.titlePatterns)
  if (patterns.length) {
    if (!check(patterns, (re) => re.test(w.title))) return -1
    score += 1
  }

  const classes = asArray(spec.classes)
  if (classes.length) {
    if (!check(classes, (c) => c === w.cls)) return -1
    score += 1
  }

  if (!dimensions) return -1
  return score
}

export function validateAdapter(a) {
  const errors = []
  if (!a || typeof a !== 'object') return ['adapter must be an object']
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(String(a.id || ''))) errors.push('id must match /^[a-z][a-z0-9-]{1,30}$/')
  if (!String(a.name || '').trim()) errors.push('name required')
  const dims = Object.keys(a.match || {})
  if (!dims.length) errors.push('match spec required')
  for (const d of dims) if (!MATCH_DIMENSIONS.includes(d)) errors.push('unknown match dimension: ' + d)
  const caps = a.capabilities || {}
  if (typeof caps.billing !== 'boolean') errors.push('capabilities.billing must be boolean')
  if (caps.billing && typeof a.createBilling !== 'function') errors.push('capabilities.billing requires createBilling()')
  return errors
}

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function pct(v) {
  const n = finiteOrNull(v)
  if (n === null) return null
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10))
}

function text(v, max = 120) {
  return String(v == null ? '' : v).trim().slice(0, max)
}

// 金额归一：多币种不混加，主币种与 byCurrency 都保留。
// credit 口径的「币种」是 CREDIT（宿主积分），不是货币码。
function normalizeMoney(v, unit) {
  if (!v || typeof v !== 'object') return null
  const amount = finiteOrNull(v.amount)
  if (amount === null) return null
  const fallback = unit === 'credit' ? 'CREDIT' : 'CNY'
  const currency = /^[A-Z]{3,8}$/.test(String(v.currency || '')) ? String(v.currency) : fallback
  const byCurrency = {}
  if (v.byCurrency && typeof v.byCurrency === 'object') {
    for (const [k, raw] of Object.entries(v.byCurrency)) {
      const n = finiteOrNull(raw)
      if (n !== null && /^[A-Z]{3,8}$/.test(k)) byCurrency[k] = Math.round(n * 10000) / 10000
    }
  }
  if (!Object.keys(byCurrency).length) byCurrency[currency] = Math.round(amount * 10000) / 10000
  const out = { amount: Math.round(amount * 10000) / 10000, currency, byCurrency }
  // 回合身份：浮层用它判断「这是一轮新的消耗」，不能拿今日金额当触发条件，
  // 否则回合内每次调用都会重弹气泡并把自动关闭计时重新拉满。
  const at = finiteOrNull(v.at)
  if (at !== null && at > 0) out.at = at
  return out
}

// 额度卡：前端只消费这个结构，不再猜各家字段。
//   kind=windows  一个或多个配额窗口（Kimi Plan、CommandCode 等）
//   kind=balance  现金余额（DeepSeek、Moonshot 等）
//   kind=plan     有套餐但没有可读窗口（Kimi Free 等）
//   kind=error    读取失败（错误原因在 message/note）
export const QUOTA_CARD_KINDS = ['windows', 'balance', 'plan', 'error']

function normalizeQuotaWindow(raw) {
  if (!raw || typeof raw !== 'object') return null
  const label = text(raw.label, 24)
  if (!label) return null
  let used = pct(raw.usedPct)
  let remaining = pct(raw.remainingPct)
  if (remaining === null && used !== null) remaining = pct(100 - used)
  if (used === null && remaining !== null) used = pct(100 - remaining)
  if (used === null && remaining === null) return null
  const resetRaw = raw.resetAt == null ? '' : raw.resetAt
  const resetAt =
    typeof resetRaw === 'number' && Number.isFinite(resetRaw)
      ? resetRaw
      : typeof resetRaw === 'string'
        ? resetRaw.slice(0, 40)
        : ''
  return {
    key: text(raw.key || label, 40)
      .toLowerCase()
      .replace(/\s+/g, '-'),
    label,
    usedPct: used,
    remainingPct: remaining,
    resetAt,
    detail: text(raw.detail, 80),
  }
}

export function normalizeQuotaCard(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') return null
  const kind = QUOTA_CARD_KINDS.includes(raw.kind) ? raw.kind : ''
  if (!kind) return null
  const windows = Array.isArray(raw.windows)
    ? raw.windows.map(normalizeQuotaWindow).filter(Boolean).slice(0, 8)
    : []
  const out = {
    kind,
    title: text(raw.title, 48) || text(ctx.adapterName, 48),
    subtitle: text(raw.subtitle, 80),
    plan: text(raw.plan, 40),
    account: text(raw.account, 60),
    note: text(raw.note, 160),
    windows,
    balance: normalizeMoney(raw.balance, 'money'),
    message: text(raw.message, 200),
    // 预付/套餐宿主（如 CommandCode）即使同时有窗口，也优先显示余额；
    // source 让 UI 能区分同形状的套餐（cmdgo / plan / relay）。
    preferBalance: raw.preferBalance === true,
    source: text(raw.source, 60),
  }
  // 没有窗口的 windows 卡没有意义：降级成 plan（有套餐名）或丢掉
  if (kind === 'windows' && !windows.length) {
    if (out.plan) out.kind = 'plan'
    else if (!out.message) out.message = '额度接口没有返回可显示的窗口'
  }
  return out
}

function normalizeDetails(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map((d) => {
      if (!d || typeof d !== 'object') return null
      const label = text(d.label, 24)
      const value = text(d.value, 80)
      if (!label || !value) return null
      return { label, value, hint: text(d.hint, 120) }
    })
    .filter(Boolean)
    .slice(0, 12)
}

// 所有适配器的返回值都必须过这一关：
//   · unit 只能是 money / credit / percent，避免「元」和「积分」被相加
//   · 金额一律 number 或 null（不出现字符串、NaN、Infinity）
//   · 百分比夹在 0..100
// R7 的统一账本直接消费这个结构，不再各自解析。
// 上下文契约（D029）：
//   · 读不到就 supported=false + reason，绝不把缺失当 0（不补零）；
//   · pct 只能由 contextPct() 统一计算，适配器不得自己算百分比；
//   · points 是宿主能给出的历史（旧→新），daemon 采样补齐由上层负责。
export const CONTEXT_CONFIDENCE = ['exact', 'derived', 'unavailable']
export const CONTEXT_REASONS = ['not-running', 'no-session', 'no-data', 'auth', 'schema']

export function contextPct(used, limit) {
  const u = finiteOrNull(used)
  const l = finiteOrNull(limit)
  if (u === null || l === null || l <= 0) return null
  return Math.min(100, Math.max(0, Math.round((u / l) * 1000) / 10))
}

function normalizeBreakdown(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const keys = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning']
  const out = {}
  for (const k of keys) {
    const n = finiteOrNull(raw[k])
    if (n !== null && n >= 0) out[k] = Math.round(n)
  }
  return Object.keys(out).length ? out : undefined
}

function normalizeCompaction(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const count = Math.max(0, Math.round(finiteOrNull(raw.count) || 0))
  if (!count) return undefined
  return {
    count,
    lastAt: finiteOrNull(raw.lastAt) || (typeof raw.lastAt === 'string' ? raw.lastAt.slice(0, 40) : ''),
    shadowedTokens: finiteOrNull(raw.shadowedTokens) === null ? undefined : Math.round(raw.shadowedTokens),
    derived: raw.derived === true,
  }
}

export function normalizeContext(raw, ctx = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const adapterId = String(ctx.adapterId || r.adapterId || 'generic')
  const adapterName = String(ctx.adapterName || r.adapterName || adapterId)
  const supported = r.supported === true
  const confidence = supported
    ? r.confidence === 'exact' || r.confidence === 'derived'
      ? r.confidence
      : 'derived'
    : 'unavailable'
  const reason = supported
    ? undefined
    : CONTEXT_REASONS.includes(String(r.reason || ''))
      ? String(r.reason)
      : 'no-data'
  const used = supported ? finiteOrNull(r.used) : null
  const limit = supported ? finiteOrNull(r.limit) : null
  const points = Array.isArray(r.points)
    ? r.points
        .map((p) => {
          if (!p || typeof p !== 'object') return null
          const t = finiteOrNull(p.t)
          const u = finiteOrNull(p.used)
          if (t === null || u === null) return null
          return { t, used: Math.max(0, Math.round(u)), turnId: p.turnId ? String(p.turnId).slice(0, 60) : undefined }
        })
        .filter(Boolean)
        .slice(-240)
    : []
  return {
    ok: r.ok !== false,
    adapterId,
    adapterName,
    supported,
    confidence,
    reason,
    sessionId: text(r.sessionId, 80),
    title: text(r.title, 160),
    model: text(r.model, 80),
    limit,
    limitSource: ['host', 'config', 'builtin-table', 'unknown'].includes(String(r.limitSource || ''))
      ? String(r.limitSource)
      : 'unknown',
    used,
    pct: supported ? contextPct(used, limit) : null,
    breakdown: supported ? normalizeBreakdown(r.breakdown) : undefined,
    compaction: supported ? normalizeCompaction(r.compaction) : undefined,
    points,
    updatedAt: finiteOrNull(r.updatedAt) || (typeof r.updatedAt === 'string' ? r.updatedAt.slice(0, 40) : ''),
    error: r.error ? String(r.error).slice(0, 300) : '',
  }
}

export function normalizeSnapshot(raw, ctx = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const adapterId = String(ctx.adapterId || r.adapterId || 'generic')
  const adapterName = String(ctx.adapterName || r.adapterName || adapterId)
  const supported = r.supported === true
  const unit = UNITS.includes(r.unit) ? r.unit : null

  const out = {
    ok: r.ok !== false,
    adapterId,
    adapterName,
    supported,
    capturedAt: Number(ctx.now) || Date.now(),
    unit: supported ? unit : null,
    today: supported ? normalizeMoney(r.today, unit) : null,
    turn: supported ? normalizeMoney(r.turn, unit) : null,
    balance: supported ? normalizeMoney(r.balance, unit) : null,
    quota: supported
      ? r.quota && typeof r.quota === 'object'
        ? { usedPct: pct(r.quota.usedPct), remainingPct: pct(r.quota.remainingPct) }
        : null
      : null,
    // 2.0：给 UI 的账户/额度/明细。适配器可以只给其中一部分。
    quotaCard: supported ? normalizeQuotaCard(r.quotaCard, { adapterName }) : null,
    plan: supported ? text(r.plan, 40) : '',
    account: supported ? text(r.account, 60) : '',
    details: supported ? normalizeDetails(r.details) : [],
    usage: supported
      ? {
          todayTokens: Math.max(0, Math.round(finiteOrNull(r.usage && r.usage.todayTokens) || 0)),
          turnTokens: Math.max(0, Math.round(finiteOrNull(r.usage && r.usage.turnTokens) || 0)),
        }
      : null,
    // 分时计价（当前是 DeepSeek 系）：isPeak + 下一次切换时刻（毫秒）。
    // 平价厂商为 null，前端不显示峰谷行。
    period:
      supported && r.period && typeof r.period === 'object'
        ? { isPeak: r.period.isPeak === true, nextChangeAt: finiteOrNull(r.period.nextChangeAt) }
        : null,
    source: supported && r.source ? String(r.source).slice(0, 200) : '',
    error: null,
  }

  if (r.error) {
    out.ok = false
    out.error = String(r.error).slice(0, 300)
  } else if (supported && !unit) {
    out.ok = false
    out.error = 'adapter returned no valid unit'
  }

  return out
}
