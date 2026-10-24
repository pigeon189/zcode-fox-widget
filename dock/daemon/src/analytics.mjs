// 统计深化（M4）：环比、预测、重置倒计时。全部纯函数，便于固定时区测试。

import { prov } from '../../shared/provenance.mjs'

export const DAY_MS = 86400000

function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = new Date(y, mo - 1, d).getTime()
  return Number.isFinite(ms) ? { y, m: mo, d, ms } : null
}

export function dateKeyOf(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export function addDays(key, n) {
  const p = parseDateKey(key)
  if (!p) return ''
  return dateKeyOf(new Date(p.y, p.m - 1, p.d + Number(n)).getTime())
}

export function daysBetween(from, to) {
  const a = parseDateKey(from)
  const b = parseDateKey(to)
  if (!a || !b) return null
  return Math.round((b.ms - a.ms) / DAY_MS) + 1
}

// 等长、紧邻之前：today→昨天；7d→前 7 天。
export function previousPeriod({ from, to } = {}) {
  const days = daysBetween(from, to)
  if (!days || days < 1) return { from: '', to: '' }
  const prevTo = addDays(from, -1)
  const prevFrom = addDays(prevTo, -(days - 1))
  return { from: prevFrom, to: prevTo }
}

export function delta(cur, prev) {
  const c = cur == null ? null : Number(cur)
  const p = prev == null ? null : Number(prev)
  if (c === null || !Number.isFinite(c) || p === null || !Number.isFinite(p) || p === 0) {
    return { abs: c !== null && p !== null && Number.isFinite(c) && Number.isFinite(p) ? c - p : null, pct: null, dir: 'na' }
  }
  const abs = c - p
  return {
    abs: Math.round(abs * 10000) / 10000,
    pct: Math.round((abs / p) * 1000) / 10,
    dir: abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat',
  }
}

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate()
}

// 本月预测：取最近 7 个自然日中「已完整」且有数据的日子（≥3 天才出值）。
// value = 本月已发生 + 有数据日的日均 × 剩余天数。
export function forecastMonth({ days = [], now = Date.now() } = {}) {
  const n = new Date(Number(now) || Date.now())
  const y = n.getFullYear()
  const m = n.getMonth() + 1
  const today = n.getDate()
  const monthPrefix = y + '-' + String(m).padStart(2, '0')
  const amountOf = new Map()
  for (const row of Array.isArray(days) ? days : []) {
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.d || row.date || ''))) continue
    const key = String(row.d || row.date)
    const amount = Number(row.amount)
    if (!Number.isFinite(amount)) continue
    amountOf.set(key, (amountOf.get(key) || 0) + amount)
  }
  const monthToDate = [...amountOf.entries()]
    .filter(([k]) => k.startsWith(monthPrefix))
    .reduce((s, [, v]) => s + v, 0)
  const sample = []
  for (let i = 1; i <= 7; i++) {
    const date = dateKeyOf(new Date(y, m - 1, today - i).getTime())
    sample.push(amountOf.get(date) || 0)
  }
  const sampleDays = sample.filter((v) => v > 0).length
  const total = daysInMonth(y, m)
  const remaining = Math.max(0, total - today)
  if (sampleDays < 3) {
    return { ok: false, value: null, basis: 'trailing7', sampleDays, reason: 'insufficient-sample' }
  }
  const avg = sample.reduce((s, v) => s + v, 0) / sampleDays
  return {
    ok: true,
    value: Math.round((monthToDate + avg * remaining) * 10000) / 10000,
    basis: 'trailing7',
    sampleDays,
    remainingDays: remaining,
    provenance: prov('estimated', 'pricing-table', 'forecast:trailing7', {
      asOf: Number(now) || Date.now(),
      note: '按近 7 日日均外推，不含峰谷与周末差异',
    }),
  }
}

// resetAt 可能是毫秒数、ISO 串或空串；解析失败/过去时间 → null（不显示负数/NaN）。
export function resetsIn(resetAt, now = Date.now()) {
  if (resetAt === null || resetAt === undefined || resetAt === '') return null
  const at = typeof resetAt === 'number' ? resetAt : Date.parse(String(resetAt))
  if (!Number.isFinite(at)) return null
  const diff = at - (Number(now) || Date.now())
  return diff > 0 ? diff : null
}

export function resetLabel(resetAt, now = Date.now()) {
  const ms = resetsIn(resetAt, now)
  if (ms === null) return ''
  const min = Math.ceil(ms / 60000)
  if (min >= 24 * 60) {
    const d = new Date(Number(now) + ms)
    const p = (n) => String(n).padStart(2, '0')
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h && m) return h + ' 小时 ' + m + ' 分后'
  if (h) return h + ' 小时后'
  return m + ' 分后'
}
