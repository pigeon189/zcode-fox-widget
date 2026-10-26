import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Card, EmptyState, ProgressBar, SourceTag } from '../components/base.mjs'
import { PermBanner } from '../components/perm-banner.mjs'
import { ColumnChart, Sparkline } from '../charts/svg.mjs'
import { Icon } from '../components/icons.mjs'
import {
  agentName,
  fmtCredit,
  fmtDuration,
  fmtMoney,
  fmtPct,
  fmtTokens,
  mainMetric,
  pctTone,
  remainText,
  sessionStatusLabel,
  shortDay,
  usedPctOf,
} from '../lib/format.mjs'

const html = htm.bind(h)

function vendorPercent(v) {
  if (v.kind === 'cmdgo') {
    const w = v.monthly || v.weekly || v.fiveHour
    return w && Number.isFinite(Number(w.percent)) ? Number(w.percent) * 100 : null
  }
  if (v.percentRemaining != null) return 100 - Number(v.percentRemaining)
  const w = Array.isArray(v.windows) && v.windows.length ? v.windows[v.windows.length - 1] : null
  if (!w) return null
  const used = w.percentUsed != null ? Number(w.percentUsed) : w.percent != null ? Number(w.percent) : null
  if (used == null) return null
  return w.percentUsed != null ? used : usedPctOf(used)
}

function vendorValue(v) {
  if (v.kind === 'cmdgo' && v.monthly && v.monthly.remaining != null) return fmtMoney(v.monthly.remaining, v.currency || 'USD')
  if (v.kind === 'cmdgo' && v.monthly) return remainText(Number(v.monthly.percent) * 100)
  if (v.balance != null) return fmtMoney(v.balance, v.currency || 'CNY')
  if (v.percentRemaining != null) return fmtPct(v.percentRemaining) + ' 剩余'
  const w = Array.isArray(v.windows) && v.windows.length ? v.windows[0] : null
  if (w) {
    const used = w.percentUsed != null ? Number(w.percentUsed) : w.percent != null ? Number(w.percent) : null
    const usedPct = used == null ? null : w.percentUsed != null ? used : usedPctOf(used)
    if (usedPct != null) return remainText(usedPct)
  }
  return v.available ? '接口可用' : '—'
}

function vendorSub(v) {
  if (v.kind === 'cmdgo' && v.planName) return v.planName + (v.account ? ' · ' + v.account : '')
  if (v.kind === 'relay') return '中转站' + (v.windows && v.windows.length ? ' · ' + v.windows[0].label : '')
  if (v.kind === 'local-log') return '订阅套餐'
  if (v.kind === 'volc') return '订阅窗口'
  if (v.kind === 'cmdgo') return 'CommandCode'
  return v.available ? '接口可用' : v.reason || '暂无数据'
}

function VendorBalanceCard({ vendors, app }) {
  const list = (vendors || [])
    .filter(
      (v) =>
        v.configured &&
        (v.balance != null ||
          v.percentRemaining != null ||
          (v.windows && v.windows.length) ||
          (v.kind === 'cmdgo' && v.monthly))
    )
    .sort((a, b) => {
      if (!!b.available !== !!a.available) return b.available ? 1 : -1
      if (a.id === 'commandcode') return -1
      if (b.id === 'commandcode') return 1
      return String(a.name).localeCompare(String(b.name), 'zh-CN')
    })
  return html`<div class="col-12">
    <${Card} title="厂商余额" testid="overview.vendors"
      actions=${html`<span class="row" style=${{ gap: 8 }}>
        <span class="small muted">已配置 ${list.length} 家</span>
        <button type="button" class="link-btn" onClick=${() => app.navigate && app.navigate('quota')}>查看全部</button>
      </span>`}>
      ${!vendors
        ? html`<div class="skeleton" style=${{ height: 80 }}></div>`
        : list.length
          ? html`<div class="vendor-mini-grid">
              ${list.slice(0, 8).map((v) => {
                const used = vendorPercent(v)
                return html`<div class="vendor-mini" title=${v.reason || ''}>
                  <div class="vendor-mini-head">
                    <span class=${'vendor-mini-dot' + (v.available ? '' : ' offline')} style=${v.available ? null : { background: 'var(--text-3)' }}></span>
                    <span class="vendor-mini-name">${v.name}</span>
                  </div>
                  <div class="vendor-mini-value">${vendorValue(v)}</div>
                  <div class="vendor-mini-sub">${vendorSub(v)}</div>
                  ${used != null
                    ? html`<div class="vendor-mini-bar"><i style=${{ width: Math.max(0, Math.min(100, used)) + '%', background: used >= 92 ? 'var(--bad)' : used >= 80 ? 'var(--warn)' : 'var(--ok)' }}></i></div>`
                    : null}
                </div>`
              })}
            </div>`
          : html`<${EmptyState} icon="wallet" title="还没有可读的厂商余额" hint="在「厂商与密钥」里配置 API Key，或直接从宿主导入凭据" />`}
    </${Card}>
  </div>`
}

function groupsTotal(groups, unit, currency) {
  let sum = 0
  for (const g of groups || []) {
    if (unit && g.unit !== unit) continue
    if (currency && g.currency !== currency) continue
    sum += Number(g.amount) || 0
  }
  return sum
}

function dayTotal(day, unit, currency) {
  return groupsTotal(day && day.groups, unit, currency)
}

function compactTokens(v) {
  const n = Number(v) || 0
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'
  return String(Math.round(n))
}

// 同一天可能同时有 CNY/USD 两个金额分组，token 是同一批用量；按 adapter 去重。
function dayTokens(day, currency) {
  const byAdapter = new Map()
  for (const g of (day && day.groups) || []) {
    if (g.unit !== 'money') continue
    if (currency && g.currency !== currency) continue
    for (const a of g.adapters || []) {
      const id = a.id || a.name || 'unknown'
      byAdapter.set(id, Math.max(Number(byAdapter.get(id)) || 0, Number(a.tokens) || 0))
    }
  }
  let sum = 0
  for (const v of byAdapter.values()) sum += v
  return sum
}

function pickCurrency(days) {
  const totals = {}
  for (const d of days || []) for (const g of d.groups || []) if (g.unit === 'money') totals[g.currency] = (totals[g.currency] || 0) + (Number(g.amount) || 0)
  const keys = Object.keys(totals)
  return keys.sort((a, b) => totals[b] - totals[a])[0] || 'CNY'
}

function trendBadge(deltaPct, toneInvert = false) {
  if (deltaPct == null) return html`<${Badge} tone="neutral">昨日无数据</${Badge}>`
  const up = deltaPct > 0
  const tone = deltaPct === 0 ? 'neutral' : up ? (toneInvert ? 'ok' : 'bad') : toneInvert ? 'bad' : 'ok'
  return html`<${Badge} tone=${tone}>
    <${Icon} name=${up ? 'trendUp' : 'trendDown'} size=${12} /> 较昨日 ${up ? '+' : ''}${deltaPct}%
  </${Badge}>`
}

export function OverviewPage({ app }) {
  const [usage, setUsage] = useState(null)
  const [breakdown, setBreakdown] = useState(null)
  const [sessions, setSessions] = useState([])
  const [sessionCounts, setSessionCounts] = useState({})
  // 图表高度是按窗口宽度算的 prop；只靠数据轮询重渲染时，从最大化切回窗口化
  // 会先按上一轮的形状画一次、约一秒后才适配（真机反馈）。监听 resize，下一帧
  // 就重渲染，与 CSS 媒体查询同步生效。
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setViewportWidth(window.innerWidth)
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])
  useEffect(() => {
    let alive = true
    app
      .api('/v1/usage?range=7d&groupBy=agent&metric=money')
      .then((d) => alive && setUsage(d))
      .catch(() => alive && setUsage({ days: [], today: { groups: [] } }))
    return () => {
      alive = false
    }
  }, [app.refreshAt, app.viewAgent])

  // 7 天图与用量页同源：账本只记录「观察到」的金额，预付/套餐日会被记成 0；
  // 下钻按 token 价目折算，才能看到当天实际发生的用量。两处必须用同一份日汇总，
  // 否则同一天会出现「总览 0 元、用量有数据」。
  useEffect(() => {
    let alive = true
    app
      .api('/v1/usage/breakdown?range=7d&by=agent&compare=0')
      .then((d) => alive && setBreakdown(d))
      .catch(() => alive && setBreakdown(null))
    return () => {
      alive = false
    }
  }, [app.refreshAt])

  useEffect(() => {
    let alive = true
    app
      .api('/v1/sessions?limit=30&sort=updated')
      .then((d) => {
        if (!alive) return
        setSessions(d.items || [])
        setSessionCounts(d.counts || {})
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [app.refreshAt, app.liveTick])

  const id = app.viewAgent
  const snap = app.snapshots[id]
  const ctx = app.contexts[id]
  const settings = app.settings || {}
  const metric = mainMetric(snap, settings.displayMode, id)
  const card = (snap && snap.quotaCard) || null
  const alerts = []
  if (ctx && ctx.supported && ctx.pct >= (Number(settings.contextWarnPct) || 80)) {
    alerts.push({ tone: ctx.pct >= 92 ? 'bad' : 'warn', text: '上下文已用 ' + fmtPct(ctx.pct) + '，建议压缩会话', go: 'sessions' })
  }
  if (snap && snap.quota && Number(settings.quotaWarnPct) > 0 && snap.quota.remainingPct <= Number(settings.quotaWarnPct)) {
    alerts.push({ tone: 'warn', text: '额度剩余 ' + fmtPct(snap.quota.remainingPct) + '，低于预警阈值', go: 'quota' })
  }
  const cur = pickCurrency(usage && usage.days)
  const days = (usage && usage.days) || []
  const today = days[days.length - 1] || (usage && usage.today) || null
  const yesterday = days[days.length - 2] || null
  const todayMoney = dayTotal(today, 'money', cur)
  const yesterdayMoney = dayTotal(yesterday, 'money', cur)
  const todayCredits = dayTotal(today, 'credit', 'CREDIT')
  const todayTokens = dayTokens(today, cur)
  const yesterdayTokens = dayTokens(yesterday, cur)
  // 预付池/套餐行的金额按设计记 0；不能把「有 1.5 亿 token 的今天」显示成 ¥0.00。
  const prepaidToday = todayMoney <= 0 && todayTokens > 0
  const tokenDeltaPct =
    yesterdayTokens > 0 ? Math.round(((todayTokens - yesterdayTokens) / yesterdayTokens) * 1000) / 10 : null
  const hasMoney = days.some((d) => (d.groups || []).some((g) => g.unit === 'money' && (Number(g.amount) || 0) !== 0))
  const hasCredit = days.some((d) => (d.groups || []).some((g) => g.unit === 'credit' && (Number(g.amount) || 0) !== 0))
  const deltaPct = yesterdayMoney > 0 ? Math.round(((todayMoney - yesterdayMoney) / yesterdayMoney) * 1000) / 10 : null
  if (snap && snap.today && snap.unit === 'money' && Number(settings.budgetMoney) > 0 && snap.today.amount > Number(settings.budgetMoney)) {
    alerts.push({ tone: 'bad', text: '今日已用超过预算 ' + fmtMoney(settings.budgetMoney, snap.today.currency), go: 'usage' })
  }
  if (snap && snap.balance && Number(settings.balanceWarnMoney) > 0 && snap.balance.amount <= Number(settings.balanceWarnMoney)) {
    alerts.push({ tone: 'warn', text: '余额 ' + fmtMoney(snap.balance.amount, snap.balance.currency) + ' 低于预警值', go: 'quota' })
  }
  if (usage && Number(settings.costAnomalyX) > 0) {
    const vals = days.slice(0, -1).map((d) => dayTotal(d, 'money', cur))
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
    if (avg > 0 && todayMoney > avg * Number(settings.costAnomalyX)) {
      alerts.push({ tone: 'warn', text: '今日用量是近 7 日均值的 ' + (todayMoney / avg).toFixed(1) + ' 倍', go: 'usage' })
    }
  }

  const dailyRows = breakdown && Array.isArray(breakdown.daily) ? breakdown.daily : []
  const dailyByDate = new Map(dailyRows.map((x) => [x.d, x]))
  const chartCur = (breakdown && breakdown.currency) || cur
  const series = days.map((d) => {
    const daily = dailyByDate.get(d.date)
    const ledgerValue = dayTotal(d, 'money', chartCur)
    // daily.amount 是服务端跨币种直加的总量，多币种下不是 chartCur 口径；
    // byCurrency 有内容时严格按币种取（缺该币种即 0），只有 byCurrency 整体
    // 缺失/为空（如旧 daemon）才回退 amount。
    const value = daily
      ? daily.byCurrency && Object.keys(daily.byCurrency).length
        ? Number(daily.byCurrency[chartCur]) || 0
        : Number(daily.amount) || 0
      : ledgerValue
    const tokens = daily
      ? Number(daily.tokens) || 0
      : d.groups && d.groups.reduce((s, g) => s + (Number(g.tokens) || 0), 0)
    const includesPrepaid = !!daily && Math.abs(value - ledgerValue) > 0.0001
    return {
      label: shortDay(d.date),
      fullDate: d.date,
      value,
      includesPrepaid,
      today: d.date === (usage && usage.today && usage.today.date),
      details: [
        { label: includesPrepaid ? '金额（含预付等价）' : '金额', value: fmtMoney(value, chartCur) },
        { label: 'Token', value: fmtTokens(tokens) },
      ],
    }
  })
  const chartHasMoney = series.some((s) => Number(s.value) > 0)
  const hasPrepaidEquivalent = series.some((s) => s.includesPrepaid)
  // 窄窗口（任务卡两列，含默认 960×680）压图表高度，保证「近 7 天成本 / 额度窗口」
  // 和上面四张任务卡同屏；宽窗口维持原高度。迷你图高度必须与 CSS 的
  // `.today-chart .chart` 保持一致——两边不一致时 SVG viewBox 会等比缩放，
  // 左右留出大片空白（真机截图）。
  const compactOverview = viewportWidth <= 1279
  const weekChartHeight = compactOverview ? 148 : 220
  const sparkHeight = compactOverview ? 56 : 90
  const sparkDays = days.slice(-7)
  const spark = sparkDays.map((d) => (prepaidToday ? dayTokens(d, cur) : dayTotal(d, 'money', cur)))
  const sparkLabels = sparkDays.map((d) => shortDay(d.date))
  const sparkValueLabel = prepaidToday ? (v) => compactTokens(v) : (v) => fmtMoney(v, cur)
  const windows = card && card.windows ? card.windows.slice(0, 3) : []
  const agents = (app.state && app.state.agents) || []
  // 当前会话与徽标都读服务端展示状态（D056）：机器 status=working 可能是钩子
  // 留下的陈旧值，只有 displayStatus 能区分空闲/已完成。
  const shownStatus = (s) => s.displayStatus || s.status || 'unknown'
  const currentSession =
    sessions.find((s) => shownStatus(s) === 'working') ||
    sessions.find((s) => shownStatus(s) === 'waiting_permission') ||
    sessions.find((s) => shownStatus(s) === 'waiting_input') ||
    null
  const currentStatus = currentSession ? shownStatus(currentSession) : ''
  const pending = sessions.flatMap((s) => (s.pending || []).map((p) => ({ ...p, agentId: s.agentId, sessionKey: s.key })))
  // 待办数用服务端全局计数兜底：列表只取最近 30 条，落在后面的等待确认会话
  // 不能因此整块显示「没有待处理事项」。
  const pendingTotal = Math.max(pending.length, Number(sessionCounts.waiting_permission) || 0)
  const counts = (app.live && app.live.counts) || sessionCounts || {}
  const liveStatus = (agentId) => {
    const by = app.live && app.live.byAgent && app.live.byAgent[agentId]
    if (!by) return { text: '空闲', tone: 'neutral' }
    if (by.error > 0) return { text: '出错', tone: 'bad' }
    // 优先用拆分计数：waiting 是旧服务端的合并值，分不清「等待确认」与
    // 「等待输入」，会把等待输入误报成等待确认。
    if (by.waiting_permission > 0) return { text: '等待确认', tone: 'warn' }
    if (by.waiting_input > 0) return { text: '等待输入', tone: 'warn' }
    if (by.waiting > 0) return { text: '等待确认', tone: 'warn' }
    if (by.working > 0) return { text: '工作中', tone: 'info' }
    if (by.done > 0) return { text: '已完成', tone: 'ok' }
    return { text: '空闲', tone: 'neutral' }
  }

  return html`<div class="grid" data-testid="page.overview">
    ${app.permActions && app.permActions.length ? html`<${PermBanner} app=${app} />` : null}
    ${alerts.slice(0, 3).map((a) => html`<div class="col-12"><div class=${'alert-bar ' + (a.tone === 'bad' ? 'bad' : '')} role="button" tabindex="0" onClick=${() => app.navigate(a.go)} onKeyDown=${(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        app.navigate(a.go)
      }
    }} style=${{ cursor: 'pointer', marginBottom: 0 }}>${a.text}</div></div>`)}

    <div class="col-3 task-card">
      <${Card} testid="overview.today-cost" class="today-card">
        <div class="today-head">
          <span class="stat-label"><span>${prepaidToday ? '今日用量' : '今日成本'}</span><${SourceTag} prov=${snap && snap.provenance && snap.provenance.today} variant="dot" /></span>
          <span class="spacer"></span>
          ${prepaidToday ? trendBadge(tokenDeltaPct) : trendBadge(deltaPct)}
        </div>
        <div class="stat-value num" style=${{ fontSize: 32 }}>
          ${prepaidToday ? fmtTokens(todayTokens) : hasMoney ? fmtMoney(todayMoney, cur) : hasCredit ? fmtCredit(todayCredits) : '—'}
        </div>
        <div class="today-chart">
          <${Sparkline} values=${spark} labels=${sparkLabels} height=${sparkHeight} valueLabel=${sparkValueLabel} />
        </div>
      </${Card}>
    </div>

    <div class="col-3 task-card">
      <${Card} testid="overview.current-session">
        <div class="stat-label"><span>当前会话</span>
          ${currentSession ? html`<${Badge} tone=${currentStatus === 'error' ? 'bad' : currentStatus === 'working' ? 'info' : currentStatus === 'done' ? 'ok' : 'warn'}>${sessionStatusLabel(currentStatus)}</${Badge}>` : null}
        </div>
        ${currentSession
          ? html`<div>
              <div class="sess-title" style=${{ whiteSpace: 'normal', marginTop: 10 }}>${currentSession.title || currentSession.key}</div>
              <div class="small muted" data-visual-mask style=${{ margin: '4px 0 10px' }}>${[currentSession.model, currentSession.startedAt ? '已运行 ' + fmtDuration(Date.now() - currentSession.startedAt) : ''].filter(Boolean).join(' · ')}</div>
              <div class="row" style=${{ gap: 8 }}>
                <${ProgressBar} pct=${ctx && ctx.pct != null ? ctx.pct : null} tone=${pctTone(ctx && ctx.pct)} label="上下文占用" />
                <span class="small num">${ctx && ctx.pct != null ? fmtPct(ctx.pct) : '—'}</span>
                <button type="button" class="link-btn" onClick=${() => app.navigate('sessions')}>查看会话</button>
              </div>
            </div>`
          : html`<${EmptyState} icon="sessions" title="当前没有进行中的会话" hint="" />`}
      </${Card}>
    </div>

    <div class="col-3 task-card">
      <${Card} testid="overview.pending">
        <div class="stat-label"><span>待处理</span><span class="spacer"></span><span class="num">${pendingTotal}</span></div>
        ${pendingTotal
          ? html`<div>
              ${pending.slice(0, 3).map(
                (p) => html`<div class="row" style=${{ minHeight: 40, gap: 8 }}>
                  <${Icon} name="shield" size=${16} />
                  <span class="small truncate" style=${{ flex: 1 }}>${agentName(p.agentId)} · ${p.tool || '权限请求'}</span>
                </div>`
              )}
              ${!pending.length
                ? html`<div class="small muted" style=${{ margin: '6px 0' }}>有 ${pendingTotal} 个会话在等待确认，去会话页查看</div>`
                : null}
              <button type="button" class="link-btn" onClick=${() => app.navigate('sessions')}>查看全部 ${pendingTotal} 条</button>
            </div>`
          : html`<${EmptyState} icon="check" title="没有待处理事项" hint="" />`}
      </${Card}>
    </div>

    <div class="col-3 task-card">
      <${Card} testid="overview.alerts">
        <div class="stat-label"><span>预警</span><span class="spacer"></span><span class="num">${alerts.length}</span></div>
        ${alerts.length
          ? html`<div>
              ${alerts.slice(0, 4).map(
                (a) => html`<div class="row" style=${{ minHeight: 36, gap: 8 }}>
                  <${Icon} name="alert" size=${14} className=${a.tone === 'bad' ? 'danger' : ''} />
                  <span class="small truncate" style=${{ flex: 1 }} title=${a.text}>${a.text}</span>
                  <button type="button" class="link-btn" onClick=${() => app.navigate(a.go)}>去处理</button>
                </div>`
              )}
            </div>`
          : html`<${EmptyState} icon="check" title="一切正常" hint="" />`}
      </${Card}>
    </div>

    <div class="col-7">
      <${Card} title="近 7 天成本" testid="overview.week" actions=${html`<span class="small muted">${hasPrepaidEquivalent ? '含预付等价 · ' : ''}${chartCur}</span>`}>
        ${chartHasMoney && series.length ? html`<${ColumnChart} data=${series} height=${weekChartHeight} valueLabel=${(v) => fmtMoney(v, chartCur)} />` : html`<${EmptyState} title="还没有用量记录" hint="打开一次宿主会话后这里会出现" />`}
      </${Card}>
    </div>

    <div class="col-5">
      <${Card} title="额度窗口" testid="overview.quota">
        ${windows.length
          ? windows.map((w) => html`<div style=${{ marginBottom: 12 }}>
              <div class="row"><span class="small">${w.label}</span><span class="spacer"></span><span class="small num">${fmtPct(w.remainingPct)}</span>
                <${SourceTag} prov=${w.prov} variant="dot" />
              </div>
              <${ProgressBar} pct=${w.usedPct} tone=${pctTone(w.usedPct)} label=${w.label + ' 已用'} />
              ${w.resetAt ? html`<div class="small muted" data-visual-mask>${app.fmtReset(w.resetAt)}重置</div>` : null}
            </div>`)
          : card && card.kind === 'balance' && card.balance
            ? html`<div class="row" style=${{ alignItems: 'baseline', gap: 8 }}>
                <span class="num" style=${{ fontSize: 32, fontWeight: 700 }}>${fmtMoney(card.balance.amount, card.balance.currency)}</span>
                <span class="muted">余额</span>
                <${SourceTag} prov=${snap && snap.provenance && snap.provenance.balance} variant="dot" />
              </div>
              <div class="small muted" style=${{ marginTop: 8 }}>${card.note || ''}</div>`
            : html`<${EmptyState} icon="gauge" title="没有可读的额度窗口" hint=${card && card.note ? card.note : '该宿主没有提供额度窗口'} />`}
      </${Card}>
    </div>

    <${VendorBalanceCard} vendors=${app.vendors} app=${app} />

    <div class="col-12">
      <${Card} title="全部 Agent 今日">
        <table class="table">
          <thead><tr><th style=${{ width: 200 }}>Agent</th><th class="right">今日</th><th style=${{ width: 220 }}>上下文</th><th style=${{ width: 140 }}>状态</th></tr></thead>
          <tbody>
            ${agents.map((a) => {
              const c = app.contexts[a.id]
              const s = app.snapshots[a.id]
              const st = liveStatus(a.id)
              return html`<tr>
                <td><div class="row"><span style=${{ width: 8, height: 8, borderRadius: 4, background: a.accent || 'var(--accent)' }}></span>${a.name}</div></td>
                <td class="right num">${s && s.supported ? (s.unit === 'credit' ? fmtCredit(s.today && s.today.amount) : s.today ? fmtMoney(s.today.amount, s.today.currency) : '—') : '—'}</td>
                <td><div class="row" style=${{ gap: 8 }}><${ProgressBar} pct=${c && c.pct} tone=${pctTone(c && c.pct)} label="上下文占用" /><span class="small muted">${c && c.supported ? fmtPct(c.pct) : '—'}</span></div></td>
                <td><${Badge} tone=${st.tone}>${st.text}</${Badge}> <span class="small muted">${a.running ? '运行中' : '未运行'}</span></td>
              </tr>`
            })}
          </tbody>
        </table>
      </${Card}>
    </div>
  </div>`
}
