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

// 所有适配器的返回值都必须过这一关：
//   · unit 只能是 money / credit / percent，避免「元」和「积分」被相加
//   · 金额一律 number 或 null（不出现字符串、NaN、Infinity）
//   · 百分比夹在 0..100
// R7 的统一账本直接消费这个结构，不再各自解析。
export function normalizeSnapshot(raw, ctx = {}) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const adapterId = String(ctx.adapterId || r.adapterId || 'generic')
  const adapterName = String(ctx.adapterName || r.adapterName || adapterId)
  const supported = r.supported === true
  const unit = UNITS.includes(r.unit) ? r.unit : null

  const money = (v) => {
    if (!v || typeof v !== 'object') return null
    const amount = finiteOrNull(v.amount)
    if (amount === null) return null
    // credit 口径的「币种」是 CREDIT（宿主积分），不是货币码；长度放宽到 3–8
    const fallback = unit === 'credit' ? 'CREDIT' : 'CNY'
    const currency = /^[A-Z]{3,8}$/.test(String(v.currency || '')) ? String(v.currency) : fallback
    // 多币种不混加：byCurrency 保留每种币种的真实金额，展示层只挑主币种
    const byCurrency = {}
    if (v.byCurrency && typeof v.byCurrency === 'object') {
      for (const [k, raw] of Object.entries(v.byCurrency)) {
        const n = finiteOrNull(raw)
        if (n !== null && /^[A-Z]{3,8}$/.test(k)) byCurrency[k] = Math.round(n * 10000) / 10000
      }
    }
    if (!Object.keys(byCurrency).length) byCurrency[currency] = Math.round(amount * 10000) / 10000
    return { amount: Math.round(amount * 10000) / 10000, currency, byCurrency }
  }

  const out = {
    ok: r.ok !== false,
    adapterId,
    adapterName,
    supported,
    capturedAt: Number(ctx.now) || Date.now(),
    unit: supported ? unit : null,
    today: supported ? money(r.today) : null,
    turn: supported ? money(r.turn) : null,
    balance: supported ? money(r.balance) : null,
    quota: supported
      ? r.quota && typeof r.quota === 'object'
        ? { usedPct: pct(r.quota.usedPct), remainingPct: pct(r.quota.remainingPct) }
        : null
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
