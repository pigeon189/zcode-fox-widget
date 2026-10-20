import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Button, Card, EmptyState, SearchBox, Segmented } from '../components/base.mjs'
import { ColumnChart } from '../charts/svg.mjs'
import { agentName, fmtCredit, fmtMoney, fmtNum, fmtTokens, shortDay } from '../lib/format.mjs'

const html = htm.bind(h)

const RANGES = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
]
const METRICS = [
  { value: 'money', label: '金额 / 积分' },
  { value: 'tokens', label: 'Token' },
]

function flatten(usage, metric) {
  const rows = []
  for (const day of (usage && usage.days) || []) {
    for (const g of day.groups || []) {
      for (const a of g.adapters || []) {
        rows.push({
          date: day.date,
          agentId: a.id,
          agent: a.name || agentName(a.id),
          unit: g.unit,
          currency: g.currency,
          amount: Number(a.amount) || 0,
          tokens: Number(a.tokens) || 0,
        })
      }
    }
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.amount - a.amount))
}

function sumValue(rows, metric) {
  return rows.reduce((s, r) => s + (metric === 'tokens' ? r.tokens : r.amount), 0)
}

function dominant(rows) {
  const map = new Map()
  for (const r of rows) {
    const key = r.unit + '|' + r.currency
    map.set(key, (map.get(key) || 0) + r.amount)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])[0] || null
}

function toCsv(rows) {
  const head = ['日期', 'Agent', '单位', '币种', '金额/积分', 'Token']
  const lines = [head.join(',')]
  for (const r of rows) {
    lines.push([r.date, r.agent, r.unit, r.currency, r.amount, r.tokens].map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(','))
  }
  return '\ufeff' + lines.join('\r\n')
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

export function UsagePage({ app }) {
  const [range, setRange] = useState('7d')
  const [groupBy, setGroupBy] = useState('agent')
  const [metric, setMetric] = useState('money')
  const [search, setSearch] = useState('')
  const [usage, setUsage] = useState(null)
  const [error, setError] = useState('')
  const [sel, setSel] = useState('')

  useEffect(() => {
    let alive = true
    setError('')
    app
      .api('/v1/usage?range=' + range + '&groupBy=' + groupBy + '&metric=' + metric)
      .then((d) => alive && setUsage(d))
      .catch((e) => alive && setError(String(e.message || e)))
    return () => {
      alive = false
    }
  }, [range, groupBy, metric, app.refreshAt])

  const rows = flatten(usage, metric)
  const filtered = rows.filter((r) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (r.agent + ' ' + r.date + ' ' + r.currency).toLowerCase().includes(q)
  })
  // 单位/币种不混算：先按当前 agent 的口径选一组，其余可手动切换。
  const keys = [...new Set(rows.map((r) => r.unit + '|' + r.currency))]
  const snap = app.snapshots[app.viewAgent]
  const preferred = snap && snap.unit ? snap.unit + '|' + ((snap.today && snap.today.currency) || (snap.unit === 'credit' ? 'CREDIT' : 'CNY')) : ''
  const dom = dominant(rows)
  const active = sel || (preferred && keys.includes(preferred) ? preferred : dom ? dom[0] : '')
  const unit = active ? active.split('|')[0] : 'money'
  const currency = active ? active.split('|')[1] : 'CNY'
  const rowsCur = active ? filtered.filter((r) => r.unit + '|' + r.currency === active) : filtered
  const fmt = (v, u = unit, c = currency) => (u === 'credit' || c === 'CREDIT' ? fmtCredit(v) : fmtMoney(v, c))

  const chart = ((usage && usage.days) || []).map((day) => {
    const dayRows = (day.groups || []).flatMap((g) =>
      (g.adapters || []).map((a) => ({ unit: g.unit, currency: g.currency, amount: Number(a.amount) || 0, tokens: Number(a.tokens) || 0 }))
    )
    const matching = active ? dayRows.filter((r) => r.unit + '|' + r.currency === active) : dayRows
    const value = metric === 'tokens' ? matching.reduce((s, r) => s + r.tokens, 0) : matching.reduce((s, r) => s + r.amount, 0)
    return { label: shortDay(day.date), value, today: day.date === (usage.today && usage.today.date) }
  })

  const rank = (usage && usage.today && usage.today.groups ? usage.today.groups : [])
    .flatMap((g) => (g.adapters || []).map((a) => ({ ...a, unit: g.unit, currency: g.currency, key: g.unit + '|' + g.currency })))
    .filter((r) => !active || r.key === active)
    .sort((a, b) => (metric === 'tokens' ? b.tokens - a.tokens : b.amount - a.amount))
    .slice(0, 8)
  const rankMax = Math.max(1, ...rank.map((r) => (metric === 'tokens' ? r.tokens : r.amount)))
  const total = sumValue(rowsCur, metric)
  // 预付池（CommandCode / 订阅套餐）的逐轮金额按 0 计，但 tokens 照常统计；
  // 只看金额会以为「今天没花钱」，给一条口径提示。
  const prepaidOnly =
    metric === 'money' && rowsCur.length > 0 && rowsCur.every((r) => !r.amount) && rowsCur.some((r) => r.tokens)

  return html`<div data-testid="page.usage">
    <div class="row wrap" style=${{ marginBottom: 16 }}>
      <${Segmented} value=${range} options=${RANGES} onChange=${setRange} />
      <${Segmented} value=${metric} options=${METRICS} onChange=${setMetric} />
      <${SearchBox} value=${search} onInput=${setSearch} placeholder="搜索 Agent / 日期" />
      ${keys.length > 1
        ? html`<${Segmented} value=${active} options=${keys.map((k) => ({ value: k, label: k.endsWith('|CREDIT') ? '积分' : k.split('|')[1] }))} onChange=${setSel} label="币种" />`
        : null}
      <span class="spacer"></span>
      <${Button} icon="download" onClick=${() => download('fox-dock-usage.csv', toCsv(rowsCur), 'text/csv')}>CSV</${Button}>
      <${Button} icon="download" onClick=${() => download('fox-dock-usage.json', JSON.stringify({ range, groupBy, metric, rows: rowsCur }, null, 2), 'application/json')}>JSON</${Button}>
    </div>

    ${error ? html`<div class="alert-bar bad">${error}</div>` : null}

    <div class="grid">
      <div class="col-12">
        <${Card} title="每日用量" testid="usage.chart" actions=${html`<span class="small muted">${metric === 'tokens' ? 'Token' : currency}</span>`}>
          ${chart.length ? html`<${ColumnChart} data=${chart} height=${240} valueLabel=${(v) => (metric === 'tokens' ? fmtTokens(v) : fmt(v))} />` : html`<${EmptyState} title="还没有用量记录" hint="dock 只记录它观察到的时间段" />`}
          ${prepaidOnly ? html`<div class="small muted" style=${{ marginTop: 8 }}>该区间金额为 0：预付池（CommandCode / 套餐）按 0 计费，Token 照常统计；可切换「Token」查看。</div>` : null}
        </${Card}>
      </div>
      <div class="col-7">
        <${Card} title="排名" testid="usage.rank">
          ${rank.length
            ? html`<div class="bar-list">
                ${rank.map(
                  (r) => html`<div class="bar-row">
                    <span class="label" title=${r.name}>${r.name}</span>
                    <div class="progress" style=${{ height: 8 }}><span style=${{ width: ((metric === 'tokens' ? r.tokens : r.amount) / rankMax) * 100 + '%' }}></span></div>
                    <span class="value">${metric === 'tokens' ? fmtTokens(r.tokens) : r.unit === 'credit' ? fmtCredit(r.amount) : fmtMoney(r.amount, r.currency)}</span>
                  </div>`
                )}
              </div>`
            : html`<${EmptyState} title="今天还没有记录" />`}
        </${Card}>
      </div>
      <div class="col-5">
        <${Card} title="缓存命中率">
          <${EmptyState} icon="chart" title="暂无逐请求缓存明细" hint="暂不支持逐请求缓存明细，后续版本提供" />
        </${Card}>
      </div>
      <div class="col-12">
        <${Card} title="明细" actions=${html`<span class="small muted">合计 ${metric === 'tokens' ? fmtTokens(total) : fmt(total)}</span>`}>
          <table class="table">
            <thead><tr><th style=${{ width: 110 }}>日期</th><th>Agent</th><th style=${{ width: 80 }}>单位</th><th style=${{ width: 80 }}>币种</th><th class="right" style=${{ width: 120 }}>金额/积分</th><th class="right" style=${{ width: 110 }}>Token</th></tr></thead>
            <tbody>
              ${rowsCur.length
                ? rowsCur.slice(0, 60).map(
                    (r) => html`<tr>
                      <td class="mono">${r.date}</td>
                      <td>${r.agent}</td>
                      <td><${Badge} tone=${r.unit === 'credit' ? 'info' : 'neutral'}>${r.unit === 'credit' ? '积分' : r.unit === 'money' ? '金额' : '百分比'}</${Badge}></td>
                      <td class="mono">${r.currency}</td>
                      <td class="right num">${r.unit === 'credit' ? fmtCredit(r.amount) : r.unit === 'percent' ? fmtNum(r.amount) + '%' : fmtMoney(r.amount, r.currency)}</td>
                      <td class="right num">${r.tokens ? fmtTokens(r.tokens) : '—'}</td>
                    </tr>`
                  )
                : html`<tr><td colSpan="6"><${EmptyState} title="没有匹配的记录" /></td></tr>`}
            </tbody>
          </table>
        </${Card}>
      </div>
    </div>
  </div>`
}
