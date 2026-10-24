// 可信度标签（D033）：每个金额 / token / 百分比都携带 provenance。
//
// 三件套：
//   kind   exact | estimated | unavailable      —— 这个数有多可信
//   origin api | local-db | local-log | pricing-table | user | unknown —— 从哪来
//   source 人类可读的数据源标识（不含用户名路径）
//
// 硬规则（延续 D010 / D029）：
//   · 缺失不补 0：kind='unavailable' 时数值必须是 null（由调用方保证）；
//   · unavailable 必须带 reason，非法输入降级为 unavailable/schema；
//   · 合并多个 provenance 时取最差（unavailable > estimated > exact），
//     origin 取最弱（api > local-db > local-log > pricing-table > user > unknown）。

export const PROV_KINDS = ['exact', 'estimated', 'unavailable']
export const PROV_ORIGINS = ['api', 'local-db', 'local-log', 'pricing-table', 'user', 'unknown']
export const PROV_REASONS = ['not-running', 'no-session', 'no-data', 'auth', 'schema', 'host-unsupported']

const KIND_RANK = { unused: 0, exact: 3, estimated: 2, unavailable: 1 }
const ORIGIN_RANK = { api: 6, 'local-db': 5, 'local-log': 4, 'pricing-table': 3, user: 2, unknown: 1 }

function text(v, max = 200) {
  return String(v == null ? '' : v).trim().slice(0, max)
}

function finiteOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return null
}

export function isProv(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    PROV_KINDS.includes(value.kind) &&
    PROV_ORIGINS.includes(value.origin)
  )
}

// 构造并校验。非法 kind/origin 不抛异常（daemon 不该因为适配器写错而崩），
// 而是降级成 unavailable/unknown/schema。
export function prov(kind, origin, source, extra = {}) {
  const k = PROV_KINDS.includes(kind) ? kind : 'unavailable'
  const o = PROV_ORIGINS.includes(origin) ? origin : 'unknown'
  const e = extra && typeof extra === 'object' ? extra : {}
  const out = {
    kind: k,
    origin: o,
    source: text(source, 200),
    asOf: Math.max(0, Math.round(finiteOrNull(e.asOf) ?? 0)),
  }
  const note = text(e.note, 200)
  if (note) out.note = note
  if (k === 'unavailable') {
    out.reason = PROV_REASONS.includes(String(e.reason || '')) ? String(e.reason) : 'no-data'
  } else if (e.reason && PROV_REASONS.includes(String(e.reason))) {
    out.reason = String(e.reason)
  }
  return out
}

export function unavailable(reason, source = '', origin = 'unknown', extra = {}) {
  return prov('unavailable', origin, source, { ...extra, reason })
}

// 合并：最差 kind；origin 取最弱；reason 取最差项的理由。
export function worstOf(...provs) {
  const list = provs.flat(Infinity).filter(isProv)
  if (!list.length) return unavailable('no-data', '', 'unknown')
  let worstKind = 'exact'
  let weakestOrigin = 'api'
  for (const p of list) {
    if (KIND_RANK[p.kind] < KIND_RANK[worstKind]) worstKind = p.kind
    if (ORIGIN_RANK[p.origin] < ORIGIN_RANK[weakestOrigin]) weakestOrigin = p.origin
  }
  const sameKind = list.filter((p) => p.kind === worstKind)
  const reason = sameKind.map((p) => p.reason).find(Boolean)
  const note = sameKind.map((p) => p.note).find(Boolean)
  const sources = [...new Set(list.map((p) => p.source).filter(Boolean))].slice(0, 3)
  const out = {
    kind: worstKind,
    origin: weakestOrigin,
    source: sources.join(' + ').slice(0, 200),
    asOf: Math.max(0, ...list.map((p) => Number(p.asOf) || 0)),
  }
  if (note) out.note = note
  if (worstKind === 'unavailable') out.reason = PROV_REASONS.includes(String(reason || '')) ? reason : 'no-data'
  return out
}

// 非法输入 → unavailable/unknown/schema（不是抛错，也不是补 0）。
export function normalizeProv(raw, fallback = {}) {
  if (isProv(raw)) {
    const out = {
      kind: raw.kind,
      origin: raw.origin,
      source: text(raw.source, 200),
      asOf: Math.max(0, Math.round(finiteOrNull(raw.asOf) ?? 0)),
    }
    const note = text(raw.note, 200)
    if (note) out.note = note
    if (raw.kind === 'unavailable') {
      out.reason = PROV_REASONS.includes(String(raw.reason || '')) ? String(raw.reason) : 'no-data'
    } else if (raw.reason && PROV_REASONS.includes(String(raw.reason))) {
      out.reason = String(raw.reason)
    }
    return out
  }
  if (raw == null) {
    // 有明确 fallback 语义（字段缺失但知道原因）时用它；否则按非法输入处理。
    if (fallback.reason || fallback.source) {
      return unavailable(fallback.reason || 'no-data', fallback.source || '', fallback.origin || 'unknown', { asOf: fallback.asOf })
    }
    return unavailable('schema', '', 'unknown', { asOf: fallback.asOf, note: '来源标签缺失' })
  }
  return unavailable('schema', fallback.source || '', 'unknown', { asOf: fallback.asOf, note: '来源标签格式不合法' })
}

// UI 四标签。user（余额校正等手工值）→ estimated + note。
export function uiLabelOf(p) {
  const v = normalizeProv(p)
  if (v.kind === 'unavailable') return 'unavailable'
  if (v.kind === 'estimated') return 'estimate'
  if (v.origin === 'api') return 'official'
  if (v.origin === 'local-db' || v.origin === 'local-log') return 'local'
  return 'estimate'
}

export const UI_LABELS = {
  official: '官方接口',
  local: '本地日志',
  estimate: '估算',
  unavailable: '不可得',
}

export const UI_ICONS = {
  official: 'shieldCheck',
  local: 'fileText',
  estimate: 'calculator',
  unavailable: 'ban',
}

// 适配器 → 默认数据来源。用于在契约层补默认标签，不让每个字段重复写一遍。
export function originOfAdapter(adapterId) {
  const id = String(adapterId || '')
  if (id === 'zcode') return 'local-db'
  if (id === 'workbuddy' || id === 'dsh') return 'local-log'
  if (id === 'kimi') return 'api'
  return 'unknown'
}

export function defaultSourceOfAdapter(adapterId) {
  const id = String(adapterId || '')
  if (id === 'zcode') return 'zcode:db.sqlite'
  if (id === 'workbuddy') return 'workbuddy:transcripts'
  if (id === 'dsh') return 'dsh:sessions'
  if (id === 'kimi') return 'kimi:/coding/v1/usages'
  return id || 'unknown'
}
