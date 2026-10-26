import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Button, Card, DatePicker, EmptyState, Segmented, SourceTag } from '../components/base.mjs'
import { Donut, MultiLineChart } from '../charts/svg.mjs'
import { agentName, fmtNum } from '../lib/format.mjs'

const html = htm.bind(h)

const RANGES = [
  { value: 'all', label: '全部' },
  { value: '7d', label: '近 7 日' },
  { value: '30d', label: '近 30 日' },
  { value: 'custom', label: '自定义' },
]
const RANGE_LABEL = { all: '全部时间', '7d': '近 7 日', '30d': '近 30 日', custom: '自定义' }
const HEATMAP_MODES = [
  { value: 'daily', label: '每日' },
  { value: 'weekly', label: '每周' },
  { value: 'cumulative', label: '累计' },
]

function dayKey(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
function shiftKey(key, n) {
  const [y, m, d] = String(key || '').split('-').map(Number)
  return dayKey(new Date(y, m - 1, d + n).getTime())
}
function spanDays(from, to) {
  const a = Date.parse(from + 'T00:00:00')
  const b = Date.parse(to + 'T00:00:00')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000) + 1
}

function durationText(ms) {
  const n = Number(ms) || 0
  if (n <= 0) return '—'
  const min = Math.round(n / 60000)
  if (min < 60) return min + 'm'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h + 'h' + (m ? m + 'm' : '')
}

function humanTokens(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(v >= 1e10 ? 1 : 2) + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(v >= 1e6 ? 0 : 1) + '万'
  return String(Math.round(v))
}

function modelLabel(id) {
  let s = String(id || '未知模型')
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  // 列表宽度有限：只去掉 DeepSeek 公共前缀；不合并 -fast / -flash 等后缀，
  // 否则同名不同模型会显示成两个完全一样的标签。完整名放在 title。
  if (s.startsWith('deepseek-') && s.length > 16) s = s.slice(9)
  return s.length > 20 ? s.slice(0, 19) + '…' : s
}

const HEATMAP_WEEKS = 53

// 老 daemon/夹具可能只返回当前范围的几周；统一补成 53 列，避免右侧空白。
function padWeeks(heatmap) {
  const weeks = (heatmap && heatmap.weeks) || []
  if (weeks.length >= HEATMAP_WEEKS) return weeks
  const cells = new Map()
  for (const w of weeks) for (const d of w.days || []) if (d) cells.set(d.date, d)
  const endText = heatmap && heatmap.endDate
  const endDay = endText
    ? Math.floor(Date.parse(endText + 'T00:00:00Z') / 86400000)
    : Math.floor(Date.now() / 86400000)
  const endWeekday = new Date(endDay * 86400000).getUTCDay()
  const startDay = endDay - (52 * 7 + endWeekday)
  const out = []
  let week = null
  for (let d = startDay; d <= endDay; d++) {
    const date = new Date(d * 86400000).toISOString().slice(0, 10)
    const cell = cells.get(date) || { date, level: 0, totalTokens: 0, turnCount: 0, toolCallCount: 0, blank: true }
    const weekday = new Date(d * 86400000).getUTCDay()
    if (!week || weekday === 0) {
      week = { weekIndex: out.length, days: Array.from({ length: 7 }, () => null) }
      out.push(week)
    }
    week.days[weekday] = cell
  }
  return out
}

function heatLevel(value, max) {
  if (!(value > 0) || !(max > 0)) return 0
  const r = value / max
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1
}

// 与 ZCode 一致：每日/每周/累计共用同一面 53 周墙。
// 每周 = 当周合计；累计 = 截至当周的累计值。
function modeWeeks(weeks, mode) {
  if (mode !== 'weekly' && mode !== 'cumulative') return weeks
  let runTokens = 0
  let runTurns = 0
  let runTools = 0
  const out = weeks.map((w) => {
    const real = (w.days || []).filter((d) => d && !d.blank)
    const tokens = real.reduce((s, d) => s + (Number(d.totalTokens) || 0), 0)
    const turns = real.reduce((s, d) => s + (Number(d.turnCount) || 0), 0)
    const tools = real.reduce((s, d) => s + (Number(d.toolCallCount) || 0), 0)
    runTokens += tokens
    runTurns += turns
    runTools += tools
    const date = real[0] ? real[0].date : ''
    return {
      weekIndex: w.weekIndex,
      days: [
        {
          date,
          totalTokens: mode === 'cumulative' ? runTokens : tokens,
          turnCount: mode === 'cumulative' ? runTurns : turns,
          toolCallCount: mode === 'cumulative' ? runTools : tools,
          blank: !real.length && !(mode === 'cumulative' && runTokens > 0),
        },
      ],
    }
  })
  const max = Math.max(1, ...out.flatMap((w) => w.days.map((d) => (d && !d.blank ? d.totalTokens : 0))))
  for (const w of out) for (const d of w.days) if (d && !d.blank) d.level = heatLevel(d.totalTokens, max)
  return out
}

function heatDate(date) {
  const [y, m, d] = String(date || '').split('-').map(Number)
  return y && m && d ? m + '月' + d + '日' : String(date || '')
}

function Heatmap({ heatmap, mode = 'daily' }) {
  const allWeeks = padWeeks(heatmap)
  const weeks = modeWeeks(allWeeks, mode)
  const [hover, setHover] = useState(null)
  const enterCell = (d) => {
    if (!d || d.blank) return
    setHover(d)
  }
  const labels = []
  let lastMonth = ''
  for (const w of weeks) {
    const first = (w.days || []).find(Boolean)
    const month = first ? first.date.slice(0, 7) : ''
    labels.push(month && month !== lastMonth ? Number(month.slice(5)) + '月' : '')
    if (month) lastMonth = month
  }
  if (!weeks.length) return html`<${EmptyState} title="还没有活动记录" />`
  let total = 0
  let activeDays = 0
  for (const w of allWeeks) {
    for (const d of w.days || []) {
      if (!d) continue
      total += Number(d.totalTokens) || 0
      if (Number(d.totalTokens) > 0) activeDays += 1
    }
  }
  const label =
    'Token 活动热力图' +
    (heatmap && heatmap.startDate ? '，' + heatmap.startDate + ' 至 ' + heatmap.endDate : '') +
    '，共 ' + humanTokens(total) + ' tokens，' + activeDays + ' 个活跃日'
  const headDate = hover
    ? mode === 'weekly'
      ? heatDate(hover.date)
      : mode === 'cumulative'
        ? '截至 ' + heatDate(hover.date)
        : heatDate(hover.date)
    : ''
  const headSuffix = hover ? (mode === 'weekly' ? '当周' : mode === 'cumulative' ? '当周累计' : '') : ''
  return html`<div class="heatmap" role="img" aria-label=${label} onMouseLeave=${() => setHover(null)}>
    <div class="heatmap-readout" data-testid="stats.heatmapReadout">
      ${hover
        ? html`<span class="hm-head"><span class="hm-date">${headDate}</span>${headSuffix ? html`<span class="hm-suffix">${headSuffix}</span>` : null}</span>
            <span class="hm-metric"><b>${humanTokens(hover.totalTokens)}</b> tokens</span>
            <span class="hm-metric">轮消息 <b>${hover.turnCount}</b></span>
            <span class="hm-metric">工具调用 <b>${hover.toolCallCount}</b></span>`
        : html`<span class="hm-empty">悬停查看明细</span>`}
    </div>
    <div class="heatmap-months">
      ${labels.map((l) => html`<span class="heatmap-month">${l}</span>`)}
    </div>
    <div class=${'heatmap-weeks' + (mode === 'daily' ? '' : ' heatmap-single')}>
      ${weeks.map(
        (w) => html`<div class="heatmap-week">
          ${w.days.map((d) =>
            d && !d.blank
              ? html`<span class=${'heatmap-cell level-' + (Number(d.level) || 0)}
                  onMouseEnter=${() => enterCell(d)}></span>`
              : html`<span class="heatmap-cell level-0"></span>`
          )}
        </div>`
      )}
    </div>
    <div class="heatmap-legend"><span>较少</span>
      ${[0, 1, 2, 3, 4].map((l) => html`<i class=${'heatmap-cell level-' + l}></i>`)}
      <span>较多</span>
    </div>
  </div>`
}

function ModelTrend({ stats }) {
  const all = stats.models || []
  const top = all.slice(0, 6)
  if (!top.length) return html`<${EmptyState} title="还没有模型用量" />`
  const daily = stats.dailyModelUsage || []
  const labels = daily.map((d) => d.date)
  const topIds = new Set(top.map((m) => m.modelId))
  const other = daily.map((d) =>
    (d.models || [])
      .filter((x) => !topIds.has(x.modelId))
      .reduce((s, x) => s + (Number(x.totalTokens) || 0), 0)
  )
  const series = top.map((m, i) => ({
    key: m.modelId || 'unknown',
    label: modelLabel(m.modelId),
    color: 'var(--c' + ((i % 6) + 1) + ')',
    values: daily.map((d) => {
      const hit = (d.models || []).find((x) => x.modelId === m.modelId)
      return hit ? Number(hit.totalTokens) || 0 : 0
    }),
  }))
  if (other.some((v) => v > 0)) {
    series.push({ key: '__other', label: '其他模型', color: 'var(--c7)', values: other })
  }
  return html`<div>
    <div class="legend model-legend">
      ${top.map(
        (m, i) => html`<span class="legend-chip" title=${m.modelId || '未知模型'}>
          <i style=${{ background: 'var(--c' + ((i % 6) + 1) + ')' }}></i>${modelLabel(m.modelId)}
        </span>`
      )}
      ${series.length > top.length
        ? html`<span class="legend-chip"><i style=${{ background: 'var(--c7)' }}></i>其他模型</span>`
        : null}
    </div>
    <${MultiLineChart} labels=${labels} series=${series} height=${250} />
  </div>`
}

function ModelShare({ stats }) {
  const all = stats.models || []
  const top = all.slice(0, 6)
  if (!top.length) return html`<${EmptyState} title="还没有模型用量" />`
  const otherTotal = all.slice(6).reduce((s, m) => s + (Number(m.totalTokens) || 0), 0)
  const share = top.reduce((s, m) => s + (Number(m.share) || 0), 0)
  const items = top.map((m, i) => ({
    label: modelLabel(m.modelId),
    value: m.totalTokens,
    color: 'var(--c' + ((i % 6) + 1) + ')',
  }))
  if (otherTotal > 0) items.push({ label: '其他模型', value: otherTotal, color: 'var(--c7)' })
  return html`<div class="model-share">
    <${Donut} items=${items} size=${150} centerLabel="tokens" valueLabel=${humanTokens} />
    <div class="model-share-list">
      ${top.map((m, i) => html`<div class="model-share-row">
        <i class="swatch" style=${{ background: 'var(--c' + ((i % 6) + 1) + ')' }}></i>
        <span class="model-name" title=${m.modelId || '未知模型'}>${modelLabel(m.modelId)}</span>
        <span class="model-share-pct">${Math.round((Number(m.share) || 0) * 1000) / 10}%</span>
        <span class="model-share-token">${humanTokens(m.totalTokens)}</span>
      </div>`)}
      ${otherTotal > 0
        ? html`<div class="model-share-row">
            <i class="swatch" style=${{ background: 'var(--c7)' }}></i>
            <span class="model-name">其他模型</span>
            <span class="model-share-pct">${Math.round((1 - share) * 1000) / 10}%</span>
            <span class="model-share-token">${humanTokens(otherTotal)}</span>
          </div>`
        : null}
    </div>
  </div>`
}

function ToolTable({ stats }) {
  const tools = stats.tools || []
  if (!tools.length) return html`<${EmptyState} title="该宿主没有工具调用明细" hint="ZCode / WorkBuddy / dsh 会记录工具调用；Kimi Code 不提供本地明细" />`
  return html`<table class="table">
    <thead><tr><th>工具</th><th class="right">调用</th><th class="right">错误率</th><th class="right">平均耗时</th></tr></thead>
    <tbody>${tools.slice(0, 12).map(
      (t) => html`<tr>
        <td class="truncate" title=${t.toolName}>${t.toolName}</td>
        <td class="right num">${fmtNum(t.callCount)}</td>
        <td class="right num">${Math.round((Number(t.errorRate) || 0) * 1000) / 10}%</td>
        <td class="right num">${t.avgDurationMs == null ? '—' : Math.round(t.avgDurationMs) + ' ms'}</td>
      </tr>`
    )}</tbody>
  </table>`
}

export function StatsPage({ app }) {
  const agents = ((app.state && app.state.agents) || []).filter((a) => a && a.id && a.id !== 'generic')
  const [range, setRange] = useState('all')
  const [from, setFrom] = useState(shiftKey(dayKey(), -6))
  const [to, setTo] = useState(dayKey())
  const [applied, setApplied] = useState({ from: shiftKey(dayKey(), -6), to: dayKey() })
  const [rangeError, setRangeError] = useState('')
  const [mode, setMode] = useState('daily')
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  // 宿主切换复用页面顶部的全局选择器（跟随角色 / ZCode / WorkBuddy …），
  // 统计页不再重复放一排同样的宿主页签。
  const selected = agents.some((a) => a.id === app.viewAgent)
    ? app.viewAgent
    : agents[0] && agents[0].id

  useEffect(() => {
    if (!selected) return
    let alive = true
    setLoading(true)
    setError('')
    const qs = new URLSearchParams({ range, ...(reloadKey ? { force: '1' } : {}) })
    if (range === 'custom') {
      qs.set('from', applied.from)
      qs.set('to', applied.to)
    }
    app
      .api('/v1/agents/' + encodeURIComponent(selected) + '/stats?' + qs.toString())
      .then((d) => alive && setStats(d.stats))
      .catch((e) => alive && setError(String(e.message || e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [selected, range, applied.from, applied.to, reloadKey, app.refreshAt])

  const s = (stats && stats.supported && stats.summary) || null
  const cachePct = s ? Math.round((Number(s.cacheHitRate) || 0) * 1000) / 10 : 0
  const modelErr = s ? Math.round((Number(s.modelErrorRate) || 0) * 1000) / 10 : 0
  const toolErr = s ? Math.round((Number(s.toolErrorRate) || 0) * 1000) / 10 : 0

  // 工具条：左侧标签占固定 208px，日期段控件的横向位置不随宿主名长短移动；
  // 刷新只用页头的图标按钮（这里不再放第二个「刷新」）。
  return html`<div data-testid="page.stats">
    <div class="row wrap" style=${{ marginBottom: 16 }}>
      <span
        class="small muted truncate"
        style=${{ flex: '0 0 208px', maxWidth: 208 }}
        title=${selected ? agentName(selected) + ' · 应用用量' : '应用用量'}
      >${selected ? agentName(selected) + ' · 应用用量' : '应用用量'}</span>
      <${Segmented} value=${range} options=${RANGES} onChange=${setRange} />
      <span class="spacer"></span>
    </div>

    ${range === 'custom'
      ? html`<div class="range-row">
          <${DatePicker} value=${from} onChange=${setFrom} min=${shiftKey(dayKey(), -365)} max=${dayKey()} ariaLabel="开始日期" invalid=${!!rangeError} testid="stats.fromDate" />
          <span class="small muted">至</span>
          <${DatePicker} value=${to} onChange=${setTo} min=${shiftKey(dayKey(), -365)} max=${dayKey()} ariaLabel="结束日期" invalid=${!!rangeError} testid="stats.toDate" />
          <${Button} variant="secondary" onClick=${() => {
            const n = spanDays(from, to)
            if (!from || !to) return setRangeError('请选择开始与结束日期')
            if (from > to) return setRangeError('开始日期不能晚于结束日期')
            if (n > 366) return setRangeError('范围最长 366 天')
            setRangeError('')
            setApplied({ from, to })
          }}>应用</${Button}>
          ${rangeError ? html`<span class="range-error">${rangeError}</span>` : null}
        </div>`
      : null}

    ${error ? html`<div class="alert-bar bad">${error}</div>` : null}

    ${!stats && loading
      ? html`<${Card} title="正在统计"><div class="small muted">正在读取本地会话历史，首次统计可能需要一点时间。</div></${Card}>`
      : null}

    ${stats && !stats.supported
      ? html`<${Card} title="用量统计">
          <${EmptyState} title="该宿主没有本地历史用量" hint=${stats.note || 'Kimi Code 只提供套餐额度窗口，没有逐日 token 历史。'} />
          ${selected === 'kimi' ? html`<div class="row" style=${{ marginTop: 12 }}><${Button} onClick=${() => app.navigate('quota')}>查看套餐额度</${Button}></div>` : null}
        </${Card}>`
      : null}

    ${s
      ? html`<div class="stats-summary">
          <div class="stat-tile"><div class="stat-label"><span>累计 Token</span><${SourceTag} prov=${stats.provenance && stats.provenance.tokens} variant="dot" /></div><div class="stat-value">${humanTokens(s.totalTokens)}</div><div class="stat-sub">${RANGE_LABEL[range]}</div></div>
          <div class="stat-tile"><div class="stat-label"><span>峰值单日</span><${SourceTag} prov=${stats.provenance && stats.provenance.tokens} variant="dot" /></div><div class="stat-value">${humanTokens(s.peakDayTokens)}</div><div class="stat-sub">${s.peakDayDate || '—'}</div></div>
          <div class="stat-tile"><div class="stat-label"><span>最长聊天</span><${SourceTag} prov=${stats.provenance && stats.provenance.turns} variant="dot" /></div><div class="stat-value">${durationText(s.longestSessionMs)}</div><div class="stat-sub">按回合累计</div></div>
          <div class="stat-tile"><div class="stat-label"><span>当前连续</span><${SourceTag} prov=${stats.provenance && stats.provenance.tokens} variant="dot" /></div><div class="stat-value">${s.currentStreakDays} 天</div><div class="stat-sub">从今天往前数</div></div>
          <div class="stat-tile"><div class="stat-label"><span>最长连续</span><${SourceTag} prov=${stats.provenance && stats.provenance.tokens} variant="dot" /></div><div class="stat-value">${s.longestStreakDays} 天</div><div class="stat-sub">${s.activeDays} 个活跃日</div></div>
        </div>

        <div class="row wrap stats-quality">
          <span class="quality-chip">会话 <b>${fmtNum(s.totalSessions)}</b> <${SourceTag} prov=${stats.provenance && stats.provenance.turns} variant="dot" /></span>
          <span class="quality-chip">回合 <b>${fmtNum(s.totalTurns)}</b> <${SourceTag} prov=${stats.provenance && stats.provenance.turns} variant="dot" /></span>
          <span class="quality-chip">工具调用 <b>${fmtNum(s.toolCallCount)}</b> <${SourceTag} prov=${stats.provenance && stats.provenance.tools} variant="dot" /></span>
          <span class="quality-chip">Cache 命中 <b>${cachePct}%</b> <${SourceTag} prov=${stats.provenance && stats.provenance.tokens} variant="dot" /></span>
          <span class="quality-chip">模型错误 <b>${modelErr}%</b> <${SourceTag} prov=${stats.provenance && stats.provenance.tokens} variant="dot" /></span>
          <span class="quality-chip">工具错误 <b>${toolErr}%</b> <${SourceTag} prov=${stats.provenance && stats.provenance.tools} variant="dot" /></span>
          ${s.avgTimeToFirstTokenMs != null ? html`<span class="quality-chip">首 token <b>${Math.round(s.avgTimeToFirstTokenMs)} ms</b> <${SourceTag} prov=${stats.provenance && stats.provenance.tokens} variant="dot" /></span>` : null}
          ${s.avgTurnDurationMs != null ? html`<span class="quality-chip">平均回合 <b>${durationText(s.avgTurnDurationMs)}</b> <${SourceTag} prov=${stats.provenance && stats.provenance.turns} variant="dot" /></span>` : null}
          ${stats.credits != null ? html`<span class="quality-chip">累计积分 <b>${fmtNum(stats.credits)}</b> <${SourceTag} prov=${stats.provenance && stats.provenance.credits} variant="dot" /></span>` : null}
          ${stats.cost ? html`<span class="quality-chip">累计成本 <b>${stats.cost.currency === 'CNY' ? '¥' : '$'}${Math.round(Number(stats.cost.amount) * 100) / 100}</b> <${SourceTag} prov=${stats.provenance && stats.provenance.cost} variant="dot" /></span>` : null}
          <span class="spacer"></span>
          <span class="small muted">${stats.source || ''}${stats.cached ? ' · 缓存' : ''}</span>
        </div>

        <div class="grid">
          <div class="col-12">
            <${Card} title="Token 活动"
              actions=${html`<${Segmented} value=${mode} options=${HEATMAP_MODES} onChange=${setMode} />`}>
              <${Heatmap} heatmap=${stats.heatmap} mode=${mode} />
              <div class="small muted" style=${{ marginTop: 8 }}>
                ${mode === 'daily' ? '每格 1 天' : mode === 'weekly' ? '每格 1 周（当周合计）' : '每格为截至当周的累计'} · 最近 53 周；颜色越深代表 Token 越多。
                ${stats.heatmap && stats.heatmap.maxTokens > 0
                  ? ' 最活跃日期是 ' + (stats.heatmap.peakDate || s.peakDayDate || '—') + '，约 ' + humanTokens(stats.heatmap.maxTokens) + ' tokens。'
                  : ' 最近 53 周还没有活动记录。'}
              </div>
            </${Card}>
          </div>
          <div class="col-7">
            <${Card} title="每日 Token 趋势">
              <${ModelTrend} stats=${stats} />
            </${Card}>
          </div>
          <div class="col-5">
            <${Card} title="模型用量">
              <${ModelShare} stats=${stats} />
            </${Card}>
          </div>
          <div class="col-12">
            <${Card} title="工具用量">
              <${ToolTable} stats=${stats} />
            </${Card}>
          </div>
        </div>`
      : null}
  </div>`
}
