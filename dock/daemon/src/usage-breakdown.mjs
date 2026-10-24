// 用量下钻聚合（M4）：GET /v1/usage/breakdown?by=...
//
// 单位/币种永不混加：
//   · money 行按币种分组，输出主币种（dominantCurrency）；
//   · credit（WorkBuddy 积分）单独放 credits，不与金额相加；
//   · 默认按 30s 缓存，custom 范围最多 5 分钟。

import { dateKeyOf, daysBetween, previousPeriod } from './analytics.mjs'
import { worstOf, prov } from '../../shared/provenance.mjs'

const BYS = ['agent', 'model', 'vendor', 'tool', 'session']
const RANGES = ['today', '7d', '30d', 'custom']
const CACHE_TTL = 30_000
const CUSTOM_TTL = 5 * 60_000
const DAY_MS = 86400000

function startOfDay(ms) {
  const d = new Date(Number(ms) || Date.now())
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function endOfDay(ms) {
  return startOfDay(ms) + DAY_MS - 1
}

// 时间过滤（P0-3）：0..1439 的本地分钟数。只用于明细行，不改变图表/合计。
function parseTimeMinutes(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function atMatchesMinutes(at, minutes) {
  if (minutes == null) return true
  const d = new Date(Number(at) || 0)
  return d.getHours() * 60 + d.getMinutes() === minutes
}

export function createUsageBreakdown({ adapters, now = () => Date.now() } = {}) {
  const cache = new Map()

  async function aggregateOne(adapter, by, since, until, at, timeMinutes = null) {
    const keyOfRow = (row) =>
      by === 'agent' ? row.agentId :
      by === 'model' ? row.model || 'unknown' :
      by === 'vendor' ? row.vendorLabel || row.vendor || 'unknown' :
      by === 'tool' ? row.tool || 'unknown' :
      row.sessionId || row.session || 'unknown'
    const detailOfRows = (rows) =>
      (rows || [])
        .filter((row) => atMatchesMinutes(row.at, timeMinutes))
        .map((row) => {
          const key = String(keyOfRow(row) || 'unknown')
          return {
            key,
            label: key,
            at: Number(row.at) || 0,
            day: row.day || dateKeyOf(row.at),
            tokens: Number(row.tokens) || 0,
            amount: row.unit === 'credit' ? 0 : Number(row.amount) || 0,
            credits: row.unit === 'credit' ? Math.round((Number(row.credits) || 0) * 10000) / 10000 : null,
            calls: Number(row.calls) || 0,
            errors: Number(row.errors) || 0,
            unit: row.unit === 'credit' ? 'credit' : 'money',
            currency: row.currency || '',
            prov: row.prov || null,
          }
        })
    // 时间明细需要逐条记录；aggregateUsage 只有按日聚合，所以单独读一次 rows。
    const readDetail = async () => {
      if (timeMinutes == null || typeof adapter.readUsageRows !== 'function') return { detail: undefined, timeSupported: false }
      try {
        const rr = await adapter.readUsageRows({ since, until, now: at, timeMinutes })
        if (!rr || rr.ok === false) return { detail: [], timeSupported: false }
        let rows = by === 'tool' ? [] : rr.rows || []
        if (['agent', 'session', 'tool'].includes(by) && typeof adapter.readToolUsageRows === 'function') {
          try {
            const t = await adapter.readToolUsageRows({ since, until, now: at })
            if (t && t.ok !== false) rows = rows.concat(t.rows || [])
          } catch (err) {}
        }
        return { detail: detailOfRows(rows), timeSupported: true }
      } catch (err) {
        return { detail: [], timeSupported: false }
      }
    }

    if (typeof adapter.aggregateUsage === 'function') {
      const r = await adapter.aggregateUsage({ by, since, until, now: at, tzOffsetMs: -new Date(at).getTimezoneOffset() * 60000 })
      if (!r || r.ok === false) return { ok: false, reason: r && r.reason, series: [], truncated: false }
      const d = await readDetail()
      return { ok: true, series: r.series || [], truncated: false, unit: r.unit || 'money', ...d }
    }
    if (typeof adapter.readUsageRows !== 'function') return { ok: false, reason: 'host-unsupported', series: [] }
    // 聚合必须用完整 rows：有些适配器（WorkBuddy/DSh）会在 readUsageRows 内部
    // 按 timeMinutes 过滤；把过滤后的 rows 再拿来做 series/total 会让图表、磁贴、
    // 合计随时间搜索一起变化。时间只作用于下面的 detail。
    const r = await adapter.readUsageRows({ since, until, now: at })
    if (!r || r.ok === false) return { ok: false, reason: r && r.reason, series: [], truncated: false }
    let rows = by === 'tool' ? [] : r.rows || []
    if (['agent', 'session', 'tool'].includes(by) && typeof adapter.readToolUsageRows === 'function') {
      try {
        const t = await adapter.readToolUsageRows({ since, until, now: at })
        if (t && t.ok !== false) rows = rows.concat(t.rows || [])
      } catch (err) {}
    }
    const detail = timeMinutes == null ? undefined : detailOfRows(rows)
    const timeSupported = timeMinutes == null ? undefined : true
    if (!rows.length) return { ok: true, series: [], truncated: r.truncated === true, unit: 'money', detail, timeSupported }
    const map = new Map()
    const unit = rows.some((x) => x.unit === 'money') ? 'money' : rows.some((x) => x.unit === 'credit') ? 'credit' : 'money'
    for (const row of rows) {
      const key =
        by === 'agent' ? row.agentId :
        by === 'model' ? row.model || 'unknown' :
        by === 'vendor' ? row.vendorLabel || row.vendor || 'unknown' :
        by === 'tool' ? row.tool || 'unknown' :
        row.sessionId || row.session || 'unknown'
      if (!key) continue
      let s = map.get(key)
      if (!s) {
        s = {
          key,
          label: key,
          tokens: 0,
          amount: 0,
          credits: 0,
          calls: 0,
          errors: 0,
          byDay: new Map(),
          byCurrency: {},
          provs: [],
        }
        map.set(key, s)
      }
      s.tokens += Number(row.tokens) || 0
      s.calls += Number(row.calls) || 0
      s.errors += Number(row.errors) || 0
      if (row.unit === 'credit') s.credits += Number(row.credits) || 0
      else {
        const cur = row.currency || 'CNY'
        s.byCurrency[cur] = Math.round(((s.byCurrency[cur] || 0) + (Number(row.amount) || 0)) * 10000) / 10000
      }
      if (row.prov) s.provs.push(row.prov)
      const day = row.day || dateKeyOf(row.at)
      const d = s.byDay.get(day) || { d: day, tokens: 0, amount: 0, credits: null, calls: 0, byCurrency: {} }
      d.tokens += Number(row.tokens) || 0
      d.calls += Number(row.calls) || 0
      if (row.unit === 'credit') d.credits = Math.round(((d.credits || 0) + (Number(row.credits) || 0)) * 10000) / 10000
      else {
        const dayCur = row.currency || 'CNY'
        d.amount = Math.round(((d.amount || 0) + (Number(row.amount) || 0)) * 10000) / 10000
        d.byCurrency[dayCur] = Math.round(((d.byCurrency[dayCur] || 0) + (Number(row.amount) || 0)) * 10000) / 10000
      }
      s.byDay.set(day, d)
    }
    const series = [...map.values()].map((s) => {
      const cur = dominant(s.byCurrency)
      return {
        key: s.key,
        label: s.label,
        tokens: Math.round(s.tokens),
        amount: s.byCurrency[cur] || 0,
        credits: s.credits > 0 ? Math.round(s.credits * 10000) / 10000 : null,
        calls: s.calls,
        errors: s.errors,
        // series 内多币种时 byDay.amount 不能是混加值：归一到 series 主币种，
        // 完整分桶保留在 byDay[].byCurrency（消费方按需取）。
        byDay: [...s.byDay.values()]
          .sort((a, b) => (a.d < b.d ? -1 : 1))
          .map((d) => ({
            ...d,
            amount:
              d.byCurrency && Object.keys(d.byCurrency).length
                ? Math.round(((Number(d.byCurrency[cur]) || 0) * 10000)) / 10000
                : Math.round((Number(d.amount) || 0) * 10000) / 10000,
          })),
        byCurrency: s.byCurrency,
        currency: cur,
        prov: s.provs.length ? worstOf(s.provs) : null,
      }
    })
    return { ok: true, series, truncated: r.truncated === true, unit, detail, timeSupported }
  }

  async function compute(params, depth = 0) {
    const at = now()
    const by = BYS.includes(params.by) ? params.by : 'agent'
    const range = RANGES.includes(params.range) ? params.range : '7d'
    const today = startOfDay(at)
    let since
    let until = at
    let fromKey
    let toKey
    if (range === 'custom') {
      const f = /^\d{4}-\d{2}-\d{2}$/.test(String(params.from || '')) ? String(params.from) : ''
      const t = /^\d{4}-\d{2}-\d{2}$/.test(String(params.to || '')) ? String(params.to) : ''
      if (!f || !t) return { ok: false, status: 400, error: 'bad-range' }
      const days = daysBetween(f, t)
      if (days === null || days < 1) return { ok: false, status: 400, error: 'bad-range' }
      if (days > 366) return { ok: false, status: 400, error: 'range-too-long' }
      since = new Date(Number(f.slice(0, 4)), Number(f.slice(5, 7)) - 1, Number(f.slice(8, 10))).getTime()
      until = endOfDay(new Date(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10))).getTime())
      fromKey = f
      toKey = t
    } else {
      const n = range === 'today' ? 1 : range === '30d' ? 30 : 7
      since = startOfDay(at - (n - 1) * DAY_MS)
      fromKey = dateKeyOf(since)
      toKey = dateKeyOf(at)
    }
    const currency = /^[A-Z]{3,8}$/.test(String(params.currency || '')) ? String(params.currency) : ''
    // 时间只影响明细表（P0-3）；不带 time 时行为与原来完全一致。
    const timeMinutes = parseTimeMinutes(params.time)
    const key = [by, range, fromKey, toKey, params.agent || '', currency, params.compare ? 'cmp' : 'one', depth, timeMinutes == null ? '' : timeMinutes].join('|')
    const hit = cache.get(key)
    const ttl = range === 'custom' ? CUSTOM_TTL : CACHE_TTL
    if (hit && at - hit.at < ttl) return { ...hit.value, cached: true }

    const list = (adapters || []).filter((a) => a && a.capabilities && a.capabilities.billing !== false)
    const chosen = params.agent ? list.filter((a) => a.id === params.agent) : list
    const merged = new Map()
    const detailRows = []
    let detailSeen = false
    let provs = []
    let truncated = false
    let anyOk = false
    let unit = 'money'
    const units = []
    for (const adapter of chosen) {
      let r = null
      try {
        r = await aggregateOne(adapter, by, since, until, at, timeMinutes)
      } catch (err) {
        r = { ok: false, reason: 'exception', series: [] }
      }
      if (!r || r.ok === false) continue
      anyOk = true
      if (r.truncated) truncated = true
      if (Array.isArray(r.detail)) {
        detailSeen = true
        for (const row of r.detail) detailRows.push(row)
      }
      units.push(r.unit || 'money')
      for (const s of r.series || []) {
        const k = String(s.key || 'unknown')
        let m = merged.get(k)
        if (!m) {
          m = {
            key: k,
            label: s.label || k,
            tokens: 0,
            credits: 0,
            calls: 0,
            errors: 0,
            byDay: new Map(),
            byCurrency: {},
            provs: [],
          }
          merged.set(k, m)
        }
        m.tokens += Number(s.tokens) || 0
        m.credits += Number(s.credits) || 0
        m.calls += Number(s.calls) || 0
        m.errors += Number(s.errors) || 0
        for (const [cur, amount] of Object.entries(s.byCurrency || {})) {
          m.byCurrency[cur] = Math.round(((m.byCurrency[cur] || 0) + (Number(amount) || 0)) * 10000) / 10000
        }
        if (!Object.keys(s.byCurrency || {}).length && Number(s.amount)) {
          const cur = s.currency || 'CNY'
          m.byCurrency[cur] = Math.round(((m.byCurrency[cur] || 0) + Number(s.amount)) * 10000) / 10000
        }
        if (s.prov) m.provs.push(s.prov)
        if (s.prov) provs.push(s.prov)
        for (const d of s.byDay || []) {
          const day = String(d.d || '')
          const row = m.byDay.get(day) || { d: day, tokens: 0, amount: 0, credits: null, calls: 0, byCurrency: {} }
          row.tokens += Number(d.tokens) || 0
          row.calls += Number(d.calls) || 0
          if (d.credits != null) row.credits = Math.round(((row.credits || 0) + Number(d.credits)) * 10000) / 10000
          if (d.amount != null) row.amount = Math.round(((row.amount || 0) + Number(d.amount)) * 10000) / 10000
          // 金额分桶优先；上游 series 没给分桶时按它的主币种归入（0 值不建桶）。
          if (d.byCurrency && Object.keys(d.byCurrency).length) {
            for (const [c, v] of Object.entries(d.byCurrency)) {
              row.byCurrency[c] = Math.round(((row.byCurrency[c] || 0) + (Number(v) || 0)) * 10000) / 10000
            }
          } else if ((Number(d.amount) || 0) !== 0) {
            const c = s.currency || 'CNY'
            row.byCurrency[c] = Math.round(((row.byCurrency[c] || 0) + Number(d.amount)) * 10000) / 10000
          }
          m.byDay.set(day, row)
        }
      }
    }
    if (!anyOk) {
      const value = {
        ok: true,
        supported: false,
        reason: 'host-unsupported',
        by,
        range: { from: fromKey, to: toKey },
        series: [],
        total: null,
        daily: [],
        detail: timeMinutes == null ? undefined : [],
        timeSupported: timeMinutes == null ? undefined : false,
      }
      cache.set(key, { at, value })
      return value
    }
    unit = units.includes('money') ? 'money' : 'credit'
    const all = [...merged.values()].map((m) => {
      const cur = currency || dominant(m.byCurrency)
      const amount = m.byCurrency[cur] || 0
      return {
        key: m.key,
        label: m.label,
        tokens: Math.round(m.tokens),
        amount: unit === 'money' ? amount : 0,
        credits: unit === 'credit' ? Math.round(m.credits * 10000) / 10000 : null,
        calls: m.calls,
        errors: m.errors,
        // 跨适配器合并后的 byDay.amount 同样归一到输出币种口径，不混加。
        byDay: [...m.byDay.values()]
          .sort((a, b) => (a.d < b.d ? -1 : 1))
          .map((d) => ({
            ...d,
            amount:
              d.byCurrency && Object.keys(d.byCurrency).length
                ? Math.round(((Number(d.byCurrency[cur]) || 0) * 10000)) / 10000
                : Math.round((Number(d.amount) || 0) * 10000) / 10000,
          })),
        byCurrency: m.byCurrency,
        currency: unit === 'money' ? cur : '',
        prov: m.provs.length ? worstOf(m.provs) : null,
      }
    })
    // 按日汇总（所有 series，不只 top 8）：总览的 7 天图直接消费这份数据，
    // 与用量页的每日条形同源。金额按 series 的主币种分组，不跨币种相加。
    const dailyMap = new Map()
    for (const s of all) {
      const cur = s.currency || 'CNY'
      for (const d of s.byDay || []) {
        const row = dailyMap.get(d.d) || { d: d.d, tokens: 0, amount: 0, credits: null, calls: 0, byCurrency: {} }
        row.tokens += Number(d.tokens) || 0
        row.calls += Number(d.calls) || 0
        if (unit === 'credit') {
          row.credits = Math.round(((row.credits || 0) + (Number(d.credits) || 0)) * 10000) / 10000
        } else {
          const amt = Number(d.amount) || 0
          // daily.amount 保持历史口径（各 series 主币种直加，仅作总量参考）；
          // byCurrency 优先用逐日分桶，series 没给时按 series 主币种归入。
          row.amount += amt
          if (d.byCurrency && Object.keys(d.byCurrency).length) {
            for (const [c, v] of Object.entries(d.byCurrency)) {
              row.byCurrency[c] = Math.round(((row.byCurrency[c] || 0) + (Number(v) || 0)) * 10000) / 10000
            }
          } else {
            row.byCurrency[cur] = Math.round(((row.byCurrency[cur] || 0) + amt) * 10000) / 10000
          }
        }
        dailyMap.set(d.d, row)
      }
    }
    const daily = [...dailyMap.values()]
      .map((x) => ({ ...x, amount: Math.round(x.amount * 10000) / 10000, tokens: Math.round(x.tokens) }))
      .sort((a, b) => (a.d < b.d ? -1 : 1))
    const metric = unit === 'credit' ? 'credits' : 'amount'
    all.sort((a, b) => (Number(b[metric]) || 0) - (Number(a[metric]) || 0) || b.tokens - a.tokens)
    const totalByCurrency = all.reduce((acc, x) => {
      for (const [cur, v] of Object.entries(x.byCurrency || {})) acc[cur] = Math.round(((acc[cur] || 0) + v) * 10000) / 10000
      return acc
    }, {})
    const outCurrency = currency || dominant(totalByCurrency)
    const top = all.slice(0, 8)
    const rest = all.slice(8)
    const other = rest.length
      ? (() => {
          // 「其他」聚合行：金额按币种分桶（与 daily 一致，不跨币种直加），
          // amount 取输出币种口径。
          const byCurrency = {}
          for (const x of rest) {
            for (const [cur, v] of Object.entries(x.byCurrency || {})) {
              byCurrency[cur] = Math.round(((byCurrency[cur] || 0) + v) * 10000) / 10000
            }
          }
          return {
            key: '__other',
            label: '其他',
            tokens: rest.reduce((s, x) => s + x.tokens, 0),
            amount: unit === 'money' ? byCurrency[outCurrency] || 0 : 0,
            byCurrency,
            currency: unit === 'money' ? outCurrency : '',
            credits: unit === 'credit' ? rest.reduce((s, x) => s + (Number(x.credits) || 0), 0) : null,
            calls: rest.reduce((s, x) => s + x.calls, 0),
            errors: rest.reduce((s, x) => s + x.errors, 0),
            byDay: [],
            prov: null,
          }
        })()
      : null
    const totals = {
      tokens: all.reduce((s, x) => s + x.tokens, 0),
      // 绝不跨币种相加：只汇总选定/主币种，其余放 byCurrency。
      amount: totalByCurrency[outCurrency] || 0,
      credits: unit === 'credit' ? Math.round(all.reduce((s, x) => s + (Number(x.credits) || 0), 0) * 10000) / 10000 : null,
      calls: all.reduce((s, x) => s + x.calls, 0),
      errors: all.reduce((s, x) => s + x.errors, 0),
      byCurrency: totalByCurrency,
    }
    const value = {
      ok: true,
      supported: true,
      by,
      range: { from: fromKey, to: toKey, days: daysBetween(fromKey, toKey) },
      unit,
      currency: outCurrency,
      series: top,
      other,
      total: totals,
      daily,
      truncated,
      prev: null,
      detail: timeMinutes == null ? undefined : detailRows.sort((a, b) => b.at - a.at).slice(0, 200),
      timeSupported: timeMinutes == null ? undefined : detailSeen,
      provenance: {
        tokens: provs.length ? worstOf(provs) : prov('estimated', 'unknown', 'breakdown', { asOf: at }),
        amount: unit === 'money' && provs.length ? worstOf(provs) : null,
      },
    }
    if (params.compare && depth === 0) {
      const pp = previousPeriod({ from: fromKey, to: toKey })
      if (pp.from && pp.to) {
        const prev = await compute({ ...params, range: 'custom', from: pp.from, to: pp.to, compare: false, time: '' }, depth + 1)
        if (prev.ok) value.prev = { range: prev.range, series: prev.series, other: prev.other, total: prev.total }
      }
    }
    cache.set(key, { at, value })
    return value
  }

  return {
    get(params = {}) {
      return compute(params)
    },
    clear() {
      cache.clear()
    },
  }
}

function dominant(byCurrency) {
  const keys = Object.keys(byCurrency || {})
  if (!keys.length) return 'CNY'
  return keys.sort((a, b) => (byCurrency[b] || 0) - (byCurrency[a] || 0))[0]
}
