import { h } from '../vendor/preact.module.js'
import { useEffect, useMemo, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Button, Card, DatePicker, EmptyState, ProgressBar, SearchBox, Segmented, SourceTag, Toggle } from '../components/base.mjs'
import { ColumnChart, StackedColumnChart } from '../charts/svg.mjs'
import { Icon } from '../components/icons.mjs'
import { agentName, fmtCredit, fmtMoney, fmtNum, fmtTokens, hhmm, shortDay } from '../lib/format.mjs'
import { filenameFor, toCsv, toJson } from '../lib/export.mjs'

const html = htm.bind(h)

const RANGES = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'custom', label: '自定义' },
]
const METRICS = [
  { value: 'money', label: '金额 / 积分' },
  { value: 'tokens', label: 'Token' },
]
const BYS = [
  { value: 'agent', label: '按 Agent' },
  { value: 'model', label: '按模型' },
  { value: 'vendor', label: '按厂商' },
  { value: 'tool', label: '按工具' },
  { value: 'session', label: '按会话' },
]
const BY_NOUN = { agent: 'Agent', model: '模型', vendor: '厂商', tool: '工具', session: '会话' }

function dayKey(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

// 明细搜索：模型名/厂商/会话等自由词 + 日期（2026-10-17、10-17、10月17日）。
// 日期必须自成词，避免把模型名里的版本号（claude-3-5-sonnet）误当成 03-05。
// 时间词（14:30）交给 daemon 过滤逐条明细；图表/磁贴/合计仍用完整聚合。
function parseFilterQuery(raw) {
  const q = String(raw || '').trim().toLowerCase()
  if (!q) return null
  const words = []
  const dates = []
  const times = []
  const re =
    /(?<![a-z0-9-])(?:(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})月(\d{1,2})日?|(\d{1,2})[-/](\d{1,2})|(\d{1,2}):(\d{2}))(?![a-z0-9-])/g
  let last = 0
  let m
  while ((m = re.exec(q))) {
    const before = q.slice(last, m.index).trim()
    if (before) words.push(...before.split(/\s+/).filter(Boolean))
    if (m[1]) dates.push(m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]))
    else if (m[4]) dates.push('--' + pad2(m[4]) + '-' + pad2(m[5]))
    else if (m[6]) dates.push('--' + pad2(m[6]) + '-' + pad2(m[7]))
    else if (m[8]) {
      const hh = Number(m[8])
      const mm = Number(m[9])
      // 24:00 / 99:99 不是时间：当作普通搜索词，避免 daemon 忽略后又被
      // 误报成“数据源不支持逐条时间”。
      if (hh <= 23 && mm <= 59) times.push(pad2(m[8]) + ':' + m[9])
      else words.push(m[0])
    }
    last = re.lastIndex
  }
  const rest = q.slice(last).trim()
  if (rest) words.push(...rest.split(/\s+/).filter(Boolean))
  return { raw: q, words, dates, times }
}

function dayMatches(day, token) {
  if (!day) return false
  return token.length === 10 ? day === token : day.slice(5) === token.slice(2)
}

function rowMatchesQuery(row, q) {
  // 只有时间词时不返回全部：必须命中逐条时间（由 daemon 的时间明细提供）。
  if (!q.words.length && !q.dates.length && q.times.length && !row.time && row.at == null) return false
  for (const w of q.words) if (!((row.label + ' ' + row.key).toLowerCase().includes(w))) return false
  if (q.dates.length && !q.dates.some((t) => dayMatches(row.day, t))) return false
  if (q.times.length) {
    const t = row.time || (row.at ? hhmm(row.at) : '')
    if (!t || !q.times.some((x) => t === x)) return false
  }
  return true
}

function seriesMatchesQuery(s, q, timeKeys = null) {
  for (const w of q.words) if (!((s.label + ' ' + s.key).toLowerCase().includes(w))) return false
  if (q.dates.length && !(s.byDay || []).some((d) => q.dates.some((t) => dayMatches(d.d, t)))) return false
  if (q.times.length) {
    // 排名只保留在目标时间有逐条记录的维度值。
    if (!timeKeys || !timeKeys.has(s.key)) return false
  }
  return true
}

function emptyFilterHint(q, timeSupported = true) {
  if (q.times.length && !timeSupported) return '当前数据源不提供逐条时间，无法按时间过滤；试试模型名或日期。'
  if (q.times.length && !q.words.length && !q.dates.length) return '这个时间没有记录；试试其他时间，或按模型名、日期搜索。'
  return '试试模型名或日期，例如 deepseek、10-17。'
}

function shiftKey(key, n) {
  const [y, m, d] = String(key || '').split('-').map(Number)
  if (!y) return ''
  return dayKey(new Date(y, m - 1, d + n).getTime())
}

function spanDays(from, to) {
  const a = Date.parse(from + 'T00:00:00')
  const b = Date.parse(to + 'T00:00:00')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000) + 1
}

function rangeDays(range, from, to) {
  if (range === 'custom') return spanDays(from, to) || 0
  return range === 'today' ? 1 : range === '30d' ? 30 : 7
}

function labelsFor(days, from, to) {
  const out = []
  const n = Math.max(0, Math.min(366, days || 0))
  const end = to || dayKey()
  for (let i = n - 1; i >= 0; i--) out.push(shiftKey(end, -i))
  return out
}

function delta(cur, prev) {
  const c = Number(cur) || 0
  const p = Number(prev) || 0
  if (!p) return { pct: null }
  return { pct: Math.round(((c - p) / p) * 1000) / 10 }
}

function download(name, text, type) {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function forecastFrom(rowsByDay) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const prefix = y + '-' + String(m).padStart(2, '0')
  const total = new Date(y, m, 0).getDate()
  const sample = []
  for (let i = 1; i <= 7; i++) sample.push(Number(rowsByDay[shiftKey(dayKey(), -i)]) || 0)
  const sampleDays = sample.filter((v) => v > 0).length
  if (sampleDays < 3) return { ok: false, sampleDays }
  const mtd = Object.entries(rowsByDay)
    .filter(([d]) => d.startsWith(prefix))
    .reduce((s, [, v]) => s + (Number(v) || 0), 0)
  const avg = sample.reduce((a, b) => a + b, 0) / sampleDays
  return { ok: true, value: mtd + avg * Math.max(0, total - now.getDate()), sampleDays }
}

export function UsagePage({ app }) {
  const initialFrom = shiftKey(dayKey(), -6)
  const [range, setRange] = useState('7d')
  const [customFrom, setCustomFrom] = useState(initialFrom)
  const [customTo, setCustomTo] = useState(dayKey())
  const [applied, setApplied] = useState({ from: initialFrom, to: dayKey() })
  const [metric, setMetric] = useState('money')
  const [currency, setCurrency] = useState('')
  const [compare, setCompare] = useState(false)
  const [by, setBy] = useState('agent')
  const [query, setQuery] = useState('')
  const [breakdown, setBreakdown] = useState(null)
  const [ledger, setLedger] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [rangeError, setRangeError] = useState('')

  const today = dayKey()
  const minDate = shiftKey(today, -365)
  const days = rangeDays(range, applied.from, applied.to)
  // 搜索词里的时间（HH:MM）要作为请求参数交给 daemon，才能拿到逐条时间明细。
  // 只有完整的时间词才会触发重新请求。
  const parsedQuery = useMemo(() => parseFilterQuery(query), [query])
  const timeFilter = parsedQuery && parsedQuery.times.length ? parsedQuery.times[0] : ''
  // 夹具/后端返回的 range 才是权威日期（客户端时钟可能与快照不同）。
  const labels = breakdown && breakdown.range
    ? labelsFor(breakdown.range.days || days, breakdown.range.from, breakdown.range.to)
    : labelsFor(days, applied.from, applied.to)

  useEffect(() => {
    let alive = true
    const qs = new URLSearchParams({ by, range, compare: compare ? '1' : '0' })
    if (range === 'custom') {
      qs.set('from', applied.from)
      qs.set('to', applied.to)
    }
    if (currency) qs.set('currency', currency)
    if (timeFilter) qs.set('time', timeFilter)
    setError('')
    setLoading(true)
    app
      .api('/v1/usage/breakdown?' + qs.toString())
      .then((d) => alive && setBreakdown(d))
      .catch((e) => {
        if (!alive) return
        // 读取失败不能继续展示上一组筛选的数据：日期标签已经换了，旧图会被
        // 误读成当前区间。
        setBreakdown(null)
        setError(String(e.message || e))
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [by, range, applied.from, applied.to, compare, currency, timeFilter, app.refreshAt])

  useEffect(() => {
    let alive = true
    app
      .api('/v1/usage?range=30d&groupBy=agent&metric=money')
      .then((d) => alive && setLedger(d))
      .catch(() => alive && setLedger({ days: [], today: { groups: [] } }))
    return () => {
      alive = false
    }
  }, [app.refreshAt])

  function applyCustom() {
    const n = spanDays(customFrom, customTo)
    if (!customFrom || !customTo) return setRangeError('请选择开始与结束日期')
    if (customFrom > customTo) return setRangeError('开始日期不能晚于结束日期')
    if (n > 366) return setRangeError('范围最长 366 天')
    setRangeError('')
    setApplied({ from: customFrom, to: customTo })
  }

  const series = (breakdown && breakdown.series) || []
  const unit = (breakdown && breakdown.unit) || 'money'
  const cur = currency || (breakdown && breakdown.currency) || 'CNY'
  const total = (breakdown && breakdown.total) || null
  // 工具维度没有金额/token，只按调用次数展示（否则整页都是 0）。
  const isTool = by === 'tool'
  const valueOf = (row) => (isTool ? row.calls : metric === 'tokens' ? row.tokens : unit === 'credit' ? row.credits : row.amount)
  const fmtValue = (v) => (isTool ? fmtNum(v) : metric === 'tokens' ? fmtTokens(v) : unit === 'credit' ? fmtCredit(v) : fmtMoney(v, cur))
  const rowValue = (r) => (r && r.credits != null && unit === 'money' ? fmtCredit(r.credits) : fmtValue(valueOf(r)))
  // 金额图/排名只展示当前币种；其它币种通过上方币种切换查看。
  const displaySeries = unit === 'money'
    ? series.filter((s) => (!s.currency || s.currency === cur) && !(s.credits != null && !Number(s.amount)))
    : series
  // 搜索作用于排名、明细表和导出；图表、磁贴、合计仍按完整数据（P0-3 边界），
  // 时间过滤需要 daemon 返回的逐条明细（breakdown.detail，带 at）。
  const timeActive = !!(parsedQuery && parsedQuery.times.length)
  const timeDetail = timeActive && breakdown && Array.isArray(breakdown.detail) ? breakdown.detail : null
  const timeKeys = timeDetail ? new Set(timeDetail.map((r) => r.key)) : null
  const timeSupported = !timeActive || !!(breakdown && breakdown.timeSupported)
  const filteredSeries = parsedQuery ? displaySeries.filter((s) => seriesMatchesQuery(s, parsedQuery, timeKeys)) : displaySeries
  const detailAll = []
  if (timeDetail) {
    for (const r of timeDetail) {
      detailAll.push({
        key: r.key,
        label: r.label,
        day: r.day,
        time: hhmm(r.at),
        at: r.at,
        tokens: r.tokens,
        amount: r.amount,
        credits: r.credits,
        calls: r.calls,
        errors: r.errors,
        prov: r.prov,
      })
    }
  } else {
    for (const s of displaySeries) {
      const byDay = Array.isArray(s.byDay) ? s.byDay : []
      if (!byDay.length) {
        detailAll.push({ key: s.key, label: s.label, day: '', tokens: s.tokens, amount: s.amount, credits: s.credits, calls: s.calls, errors: s.errors, prov: s.prov })
        continue
      }
      for (const d of byDay) {
        detailAll.push({ key: s.key, label: s.label, day: d.d, tokens: d.tokens, amount: d.amount, credits: d.credits, calls: d.calls, errors: d.errors, prov: s.prov })
      }
    }
  }
  const filteredDetail = parsedQuery ? detailAll.filter((r) => rowMatchesQuery(r, parsedQuery)) : null
  const sortedDetail = filteredDetail
    ? [...filteredDetail].sort((a, b) => String(b.day || '').localeCompare(String(a.day || '')) || (Number(valueOf(b)) || 0) - (Number(valueOf(a)) || 0))
    : []
  const rank = [...filteredSeries].sort((a, b) => (Number(valueOf(b)) || 0) - (Number(valueOf(a)) || 0))
  const rankMax = Math.max(1, ...rank.map((r) => Number(valueOf(r)) || 0))
  const totalValue = total ? (isTool ? total.calls : metric === 'tokens' ? total.tokens : unit === 'credit' ? total.credits : total.amount) : null
  const prevValue = compare && breakdown && breakdown.prev && breakdown.prev.total
    ? isTool
      ? breakdown.prev.total.calls
      : metric === 'tokens'
        ? breakdown.prev.total.tokens
        : unit === 'credit'
          ? breakdown.prev.total.credits
          : breakdown.prev.total.amount
    : null
  const d = delta(totalValue, prevValue)
  const perDay = totalValue != null && days > 0 ? totalValue / days : null
  const rowsByDay = {}
  const ledgerDays = ledger && Array.isArray(ledger.days) ? ledger.days : []
  if (ledgerDays.length) {
    for (const day of ledgerDays) {
      for (const g of day.groups || []) {
        if (g.unit === 'money' && g.currency === cur) rowsByDay[day.date] = (rowsByDay[day.date] || 0) + (Number(g.amount) || 0)
      }
    }
  } else {
    for (const s of series) for (const x of s.byDay || []) {
      if (x.amount != null && !rowsByDay[x.d]) rowsByDay[x.d] = Number(x.amount) || 0
    }
  }
  const forecast = isTool ? { ok: false, sampleDays: 0 } : forecastFrom(rowsByDay)

  // 图表只画前 5 个系列（--c1..--c5）；第 6 个起并入「其他」（--c7，与统计页
  // 模型占比「其他模型」同口径），避免图与排名/明细的全量口径不一致。
  const TOP_N = 5
  const chartSource = displaySeries.slice(0, TOP_N)
  const chartRest = displaySeries.slice(TOP_N)
  const hasCreditsOnly = unit === 'money' && displaySeries.length !== series.length
  const chartLabels = chartSource.length
    ? labels.map((k) => shortDay(k))
    : []
  const valueAt = (s, k) => {
    const hit = (s.byDay || []).find((x) => x.d === k)
    if (!hit) return 0
    // 积分周期没有 amount（后端只给 credits）：必须按 unit 选字段，否则
    // 有数据的积分会被画成空图。
    return Number(isTool ? hit.calls : metric === 'tokens' ? hit.tokens : unit === 'credit' ? hit.credits : hit.amount) || 0
  }
  const chartSeries = chartSource.map((s, i) => ({
    key: s.key,
    label: s.label,
    color: 'var(--c' + ((i % 5) + 1) + ')',
    values: labels.map((k) => valueAt(s, k)),
  }))
  if (chartRest.length) {
    chartSeries.push({
      key: '__other',
      label: '其他',
      color: 'var(--c7)',
      values: labels.map((k) => chartRest.reduce((sum, s) => sum + valueAt(s, k), 0)),
    })
  }
  const dailyTotal = labels.map((k, i) => ({
    label: shortDay(k),
    fullDate: k,
    value: chartSeries.reduce((sum, s) => sum + (Number(s.values[i]) || 0), 0),
    today: k === today,
  }))
  const prevDaily = compare && breakdown && breakdown.prev ? (() => {
    const map = {}
    for (const s of breakdown.prev.series || []) for (const x of s.byDay || []) {
      map[x.d] = (map[x.d] || 0) + (Number(isTool ? x.calls : metric === 'tokens' ? x.tokens : unit === 'credit' ? x.credits : x.amount) || 0)
    }
    return labels.map((k) => map[k] || 0)
  })() : null

  function exportRows() {
    const rows = []
    // 导出口径与当前筛选一致：搜索词生效时只导出命中的系列（时间过滤在
    // 服务端已按 time 请求参数收窄）；否则界面看到的排名与导出内容会对不上。
    const source = parsedQuery ? filteredSeries : series
    for (const s of source) {
      const base = {
        agentId: by === 'agent' ? s.key : '',
        sessionId: by === 'session' ? s.key : '',
        title: by === 'session' ? s.label : '',
        model: by === 'model' ? s.key : '',
        vendor: by === 'vendor' ? s.key : '',
        tool: by === 'tool' ? s.key : '',
        unit,
        currency: cur,
        prov: s.prov,
      }
      if (Array.isArray(s.byDay) && s.byDay.length) {
        for (const d of s.byDay) {
          rows.push({
            ...base,
            date: d.d,
            // 金额未收录时保持 null（CSV/JSON 都写空），不能 Number(null)=0。
            amount: unit === 'money' ? (d.amount == null ? null : Number(d.amount)) : 0,
            credits: d.credits != null ? d.credits : unit === 'credit' ? s.credits : null,
            tokens: Number(d.tokens) || 0,
            calls: Number(d.calls) || 0,
            errors: 0,
          })
        }
      } else {
        rows.push({
          ...base,
          date: applied.to || today,
          amount: unit === 'money' ? s.amount : 0,
          credits: s.credits != null ? s.credits : unit === 'credit' ? s.credits : null,
          tokens: s.tokens,
          calls: s.calls,
          errors: s.errors,
        })
      }
    }
    return rows
  }

  return html`<div data-testid="page.usage">
    <div class="row wrap" style=${{ marginBottom: 12, gap: 8 }}>
      <${Segmented} value=${range} options=${RANGES} onChange=${setRange} />
      <${Segmented} value=${metric} options=${METRICS} onChange=${setMetric} />
      ${breakdown && unit === 'money'
        ? html`<${Segmented} value=${cur} options=${[...new Set([cur, ...(Object.keys((total && total.byCurrency) || {}))])].map((c) => ({ value: c, label: c === 'CREDIT' ? '积分' : c }))} onChange=${setCurrency} label="币种" />`
        : null}
      <${Toggle} checked=${compare} onChange=${setCompare} label="对比上一周期" ariaLabel="对比上一周期" />
      <span class="spacer"></span>
      <span class="row" style=${{ gap: 8, marginLeft: 'auto' }}>
        <${Button} variant="ghost" icon="download" disabled=${!breakdown || !!error} onClick=${() => download(filenameFor({ from: labels[0] || applied.from, to: labels[labels.length - 1] || today, by, ext: 'csv' }), toCsv(exportRows()), 'text/csv;charset=utf-8')}>CSV</${Button}>
        <${Button} variant="ghost" icon="download" disabled=${!breakdown || !!error} onClick=${() => download(filenameFor({ from: labels[0] || applied.from, to: labels[labels.length - 1] || today, by, ext: 'json' }), toJson({ meta: { range, by, from: labels[0], to: labels[labels.length - 1] }, rows: exportRows(), total, provenance: breakdown && breakdown.provenance }), 'application/json')}>JSON</${Button}>
      </span>
    </div>

    ${range === 'custom'
      ? html`<div class="range-row">
          <${DatePicker} value=${customFrom} onChange=${setCustomFrom} min=${minDate} max=${today} ariaLabel="开始日期" invalid=${!!rangeError} testid="usage.fromDate" />
          <span class="small muted">至</span>
          <${DatePicker} value=${customTo} onChange=${setCustomTo} min=${minDate} max=${today} ariaLabel="结束日期" invalid=${!!rangeError} testid="usage.toDate" />
          <${Button} variant="secondary" onClick=${applyCustom}>应用</${Button}>
          ${rangeError ? html`<span class="range-error">${rangeError}</span>` : null}
        </div>`
      : null}

    ${error ? html`<div class="alert-bar bad" style=${{ margin: '12px 0' }}>${error}</div>` : null}
    ${breakdown && breakdown.truncated ? html`<div class="alert-bar" style=${{ margin: '12px 0' }}>数据量较大，仅统计最近 20 万条</div>` : null}

    <div class="grid" style=${{ marginTop: 12 }}>
      <div class="col-3"><${Tile} label=${isTool ? '总调用' : unit === 'credit' ? '总积分' : '总成本'} value=${totalValue == null ? '—' : fmtValue(totalValue)} delta=${d.pct} prov=${breakdown && breakdown.provenance && (isTool ? breakdown.provenance.tokens : breakdown.provenance.amount)} /></div>
      <div class="col-3"><${Tile} label=${isTool ? '总错误' : '总 Token'} value=${total ? (isTool ? fmtNum(total.errors) : fmtTokens(total.tokens)) : '—'} prov=${breakdown && breakdown.provenance && breakdown.provenance.tokens} /></div>
      <div class="col-3"><${Tile} label=${isTool ? '日均调用' : '日均成本'} value=${perDay == null ? '—' : fmtValue(perDay)} /></div>
      <div class="col-3">${isTool ? html`<${Tile} label="涉及工具" value=${fmtNum(series.length)} sub="按调用次数统计" />` : html`<${Tile} label="本月预测" value=${forecast.ok ? fmtValue(forecast.value) : '—'} sub=${forecast.ok ? '按近 7 日日均外推' : '样本不足（需 ≥3 个有数据的日子）'} mask=${true} tag=${html`<${SourceTag} kind="estimate" variant="dot" />`} />`}</div>

      <div class="col-12">
        <${Card} title="每日用量" testid="usage.chart" actions=${html`<span class="small muted">${metric === 'tokens' ? 'Token' : unit === 'credit' ? '积分' : cur}</span>`}>
          ${loading && !breakdown
            ? html`<div class="skeleton" style=${{ height: 240 }}></div>`
            : displaySeries.length
              ? compare
                ? html`<${ColumnChart} data=${dailyTotal} prev=${prevDaily} height=${240} valueLabel=${(v) => fmtValue(v)} details=${dailyTotal.map((x) => [{ label: '合计', value: fmtValue(x.value) }])} />`
                : html`<${StackedColumnChart} labels=${chartLabels} series=${chartSeries} height=${240} valueLabel=${(v) => fmtValue(v)} />`
              : error
                ? html`<${EmptyState} icon="alert" title="用量读取失败" hint=${error} />`
                : html`<${EmptyState} title="还没有用量记录" hint="dock 只记录它观察到的时间段" />`}
          ${hasCreditsOnly ? html`<div class="small muted" style=${{ marginTop: 8 }}>其它币种与积分单独统计，不参与当前金额图；可用上方币种切换查看，积分见下方明细。</div>` : null}
        </${Card}>
      </div>

      <div class="col-12">
        <${Card} title="下钻" testid="usage.breakdown"
          actions=${html`<${Segmented} value=${by} options=${BYS} onChange=${setBy} label="下钻维度" />`}>
          <div class="usage-tools">
            <${SearchBox} value=${query} onInput=${setQuery} placeholder=${'搜索' + BY_NOUN[by] + ' / 日期 / 时间'} testid="usage.search" />
            ${query
              ? html`<${Button} variant="ghost" onClick=${() => setQuery('')}>清除</${Button}>`
              : null}
            ${parsedQuery
              ? html`<span class="small muted" data-testid="usage.filterCount">
                  筛选后 ${filteredDetail.length} / 共 ${detailAll.length} 条 · 仅影响明细展示
                  ${parsedQuery.times.length
                    ? timeDetail
                      ? '（按逐条时间过滤）'
                      : '（当前数据源不提供逐条时间）'
                    : ''}
                </span>`
              : null}
          </div>
          <div class="grid">
            <div class="col-7">
              ${displaySeries.length
                ? html`<${StackedColumnChart} labels=${chartLabels} series=${chartSeries} height=${200} valueLabel=${(v) => fmtValue(v)} />`
                : html`<${EmptyState} title="没有可下钻的数据" />`}
            </div>
            <div class="col-5">
              ${rank.length
                ? html`<div class="bar-list">
                    ${rank.slice(0, 8).map(
                      (r) => html`<div class="bar-row">
                        <span class="label" title=${r.label}>${r.label}</span>
                        <${ProgressBar} pct=${((Number(valueOf(r)) || 0) / rankMax) * 100} label=${r.label + ' 占比'} />
                        <span class="value">${rowValue(r)}</span>
                      </div>`
                    )}
                  </div>`
                : html`<div class="small muted" style=${{ padding: '24px 0' }}>${parsedQuery ? '没有匹配的排名' : '没有数据'}</div>`}
            </div>
          </div>
          ${parsedQuery
            ? sortedDetail.length
              ? html`<table class="table usage-detail-table" style=${{ marginTop: 12 }}>
                  <thead><tr>
                    <th class="col-day">日期</th>
                    <th>${BYS.find((b) => b.value === by).label.replace('按', '')}</th>
                    <th class="right col-tokens">Token</th>
                    <th class="right col-money">金额 / 积分</th>
                    <th class="right col-calls">调用</th>
                    <th class="right col-errors">错误</th>
                    <th class="col-prov">来源</th>
                  </tr></thead>
                  <tbody>
                    ${sortedDetail.slice(0, 200).map(
                      (r) => html`<tr>
                        <td class="num">${r.day || '累计'}${r.time ? ' ' + r.time : ''}</td>
                        <td class="truncate" title=${r.label}>${r.label}</td>
                        <td class="right num">${isTool ? '—' : fmtTokens(r.tokens)}</td>
                        <td class="right num">${isTool ? '—' : unit === 'credit' || r.credits != null ? fmtCredit(r.credits) : fmtMoney(r.amount, cur)}</td>
                        <td class="right num">${fmtNum(r.calls)}</td>
                        <td class="right num">${fmtNum(r.errors)}</td>
                        <td><${SourceTag} prov=${r.prov} variant="dot" /> <span class="small muted">${r.prov ? (r.prov.kind === 'exact' ? '精确' : r.prov.kind === 'estimated' ? '估算' : '不可得') : '不可得'}</span></td>
                      </tr>`
                    )}
                  </tbody>
                </table>
                ${sortedDetail.length > 200
                  ? html`<div class="small muted" style=${{ marginTop: 8 }}>仅显示前 200 条匹配记录，请缩小筛选范围。</div>`
                  : null}`
              : html`<${EmptyState} icon="search" title="没有匹配的记录" hint=${emptyFilterHint(parsedQuery, timeSupported)} />`
            : html`<table class="table" style=${{ marginTop: 12 }}>
                <thead><tr>
                  <th>${BYS.find((b) => b.value === by).label.replace('按', '')}</th>
                  <th class="right" style=${{ width: 110 }}>Token</th>
                  <th class="right" style=${{ width: 110 }}>金额 / 积分</th>
                  <th class="right" style=${{ width: 80 }}>调用</th>
                  <th class="right" style=${{ width: 80 }}>错误</th>
                  <th style=${{ width: 96 }}>来源</th>
                </tr></thead>
                <tbody>
                  ${[...displaySeries, ...(breakdown && breakdown.other ? [breakdown.other] : [])].map(
                    (r) => html`<tr style=${{ cursor: by === 'session' ? 'pointer' : 'default' }}
                      onClick=${() => by === 'session' && app.navigate('sessions')}>
                      <td class="truncate" title=${r.label}>${by === 'session'
                        ? html`<button type="button" class="link-btn" onClick=${(e) => {
                            e.stopPropagation()
                            app.navigate('sessions')
                          }}>${r.label}</button>`
                        : r.label}</td>
                      <td class="right num">${isTool ? '—' : fmtTokens(r.tokens)}</td>
                      <td class="right num">${isTool ? '—' : r.credits != null && unit === 'money' ? fmtCredit(r.credits) : unit === 'credit' ? fmtCredit(r.credits) : fmtMoney(r.amount, cur)}</td>
                      <td class="right num">${fmtNum(r.calls)}</td>
                      <td class="right num">${fmtNum(r.errors)}</td>
                      <td><${SourceTag} prov=${r.prov} variant="dot" /> <span class="small muted">${r.prov ? (r.prov.kind === 'exact' ? '精确' : r.prov.kind === 'estimated' ? '估算' : '不可得') : '不可得'}</span></td>
                    </tr>`
                  )}
                  ${!displaySeries.length ? html`<tr><td colSpan="6"><${EmptyState} title="没有匹配的记录" /></td></tr>` : null}
                </tbody>
              </table>`}
        </${Card}>
      </div>
    </div>
  </div>`
}

function Tile({ label, value, sub = '', delta: deltaPct = null, prov = null, tag = null, mask = false }) {
  return html`<div class="card" style=${{ minHeight: 104 }}>
    <div class="stat-label"><span>${label}</span>${tag || (prov ? html`<${SourceTag} prov=${prov} variant="dot" />` : null)}</div>
    <div class="stat-value num" style=${{ fontSize: 24 }} data-visual-mask=${mask ? '' : undefined}>${value}</div>
    ${deltaPct != null
      ? html`<div class="row" style=${{ marginTop: 4 }}><${Badge} tone=${deltaPct > 0 ? 'bad' : deltaPct < 0 ? 'ok' : 'neutral'}>
          <${Icon} name=${deltaPct >= 0 ? 'trendUp' : 'trendDown'} size=${12} /> 较上周期 ${deltaPct > 0 ? '+' : ''}${deltaPct}%
        </${Badge}></div>`
      : null}
    ${sub ? html`<div class="stat-sub">${sub}</div>` : null}
  </div>`
}
