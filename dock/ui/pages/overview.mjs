import { h, Fragment } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Card, EmptyState, ProgressBar } from '../components/base.mjs'
import { Gauge, ColumnChart, MiniBar } from '../charts/svg.mjs'
import { agentName, fmtCredit, fmtMoney, fmtNum, fmtPct, fmtTokens, mainMetric, pctTone, remainText, shortDay, usedPctOf } from '../lib/format.mjs'

const html = htm.bind(h)

function vendorPercent(v) {
  if (v.kind === 'cmdgo') {
    // 迷你卡的主数字是月度池剩余，进度条也用月度池，避免「数字月度、进度条周」。
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
  if (v.kind === 'cmdgo' && v.monthly && v.monthly.remaining != null) {
    return fmtMoney(v.monthly.remaining, v.currency || 'USD')
  }
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

function groupTotal(groups, unit, currency, metric = 'money') {
  if (!Array.isArray(groups)) return 0
  return groups
    .filter((g) => (unit ? g.unit === unit : true) && (currency ? g.currency === currency : true))
    .reduce((sum, g) => sum + (metric === 'tokens' ? Number(g.tokens) || 0 : Number(g.amount) || 0), 0)
}

function pickSeries(usage, unit, currency) {
  const days = (usage && usage.days) || []
  const metric = 'money'
  return days.map((d) => {
    const groups = d.groups || []
    const g = groups.find((x) => x.unit === unit && x.currency === currency) || groups.find((x) => x.unit === unit) || null
    return {
      label: shortDay(d.date),
      value: g ? Number(g.amount) || 0 : 0,
      today: d.date === (usage.today && usage.today.date),
      currency: g ? g.currency : currency,
    }
  })
}

export function OverviewPage({ app }) {
  const [usage, setUsage] = useState(null)
  const [usage30, setUsage30] = useState(null)
  useEffect(() => {
    let alive = true
    app
      .api('/v1/usage?range=7d&groupBy=agent&metric=money')
      .then((d) => alive && setUsage(d))
      .catch(() => alive && setUsage({ days: [], today: { groups: [] } }))
    app
      .api('/v1/usage?range=30d&groupBy=agent&metric=money')
      .then((d) => alive && setUsage30(d))
      .catch(() => alive && setUsage30({ days: [], today: { groups: [] } }))
    return () => {
      alive = false
    }
  }, [app.refreshAt, app.viewAgent])

  const id = app.viewAgent
  const snap = app.snapshots[id]
  const ctx = app.contexts[id]
  const settings = app.settings || {}
  const metric = mainMetric(snap, settings.displayMode, id)
  const card = (snap && snap.quotaCard) || null
  const accent = app.agentAccent(id)
  const pct = ctx && ctx.pct
  const alerts = []
  if (ctx && ctx.supported && ctx.pct >= (Number(settings.contextWarnPct) || 80)) {
    alerts.push({ tone: ctx.pct >= 92 ? 'bad' : 'warn', text: '上下文已用 ' + fmtPct(ctx.pct) + '，建议压缩会话' })
  }
  if (snap && snap.quota && Number(settings.quotaWarnPct) > 0 && snap.quota.remainingPct <= Number(settings.quotaWarnPct)) {
    alerts.push({ tone: 'warn', text: '额度剩余 ' + fmtPct(snap.quota.remainingPct) + '，低于预警阈值' })
  }
  if (snap && snap.today && snap.unit === 'money' && Number(settings.budgetMoney) > 0 && snap.today.amount > Number(settings.budgetMoney)) {
    alerts.push({ tone: 'bad', text: '今日已用超过预算 ' + fmtMoney(settings.budgetMoney, snap.today.currency) })
  }
  const cur = (snap && snap.today && snap.today.currency) || 'CNY'
  const sumGroups = (apiUsage, pred) => {
    let total = 0
    for (const day of (apiUsage && apiUsage.days) || []) {
      if (!pred(day)) continue
      for (const g of day.groups || []) {
        if (g.unit === 'money' && g.currency === cur) total += Number(g.amount) || 0
      }
    }
    return total
  }
  const todayKey = usage && usage.today ? usage.today.date : ''
  const weekTotal = usage ? sumGroups(usage, () => true) : 0
  const monthTotal = usage30 ? sumGroups(usage30, () => true) : 0
  if (Number(settings.weeklyBudget) > 0 && weekTotal > Number(settings.weeklyBudget)) {
    alerts.push({ tone: 'warn', text: '近 7 天已用 ' + fmtMoney(weekTotal, cur) + '，超过 7 天预算 ' + fmtMoney(settings.weeklyBudget, cur) })
  }
  if (Number(settings.monthlyBudget) > 0 && monthTotal > Number(settings.monthlyBudget)) {
    alerts.push({ tone: 'warn', text: '近 30 天已用 ' + fmtMoney(monthTotal, cur) + '，超过 30 天预算 ' + fmtMoney(settings.monthlyBudget, cur) })
  }
  if (snap && snap.balance && Number(settings.balanceWarnMoney) > 0 && snap.balance.currency === cur && snap.balance.amount <= Number(settings.balanceWarnMoney)) {
    alerts.push({ tone: 'warn', text: '余额 ' + fmtMoney(snap.balance.amount, snap.balance.currency) + ' 低于预警值' })
  }
  if (usage && Number(settings.costAnomalyX) > 0) {
    const prev = ((usage.days || []).filter((d) => d.date !== todayKey))
    const vals = prev.map((d) => {
      let v = 0
      for (const g of d.groups || []) {
        if (g.unit !== 'money' || g.currency !== cur) continue
        for (const a of g.adapters || []) if (a.id === id) v += Number(a.amount) || 0
      }
      return v
    })
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
    const today = snap && snap.today ? Number(snap.today.amount) || 0 : 0
    if (avg > 0 && today > avg * Number(settings.costAnomalyX)) {
      alerts.push({ tone: 'warn', text: '今日用量是近 7 日均值的 ' + (today / avg).toFixed(1) + ' 倍' })
    }
  }

  const series = usage ? pickSeries(usage, snap && snap.unit, snap && snap.today ? snap.today.currency : 'CNY') : []
  const windows = card && card.windows ? card.windows.slice(0, 3) : []
  const agents = (app.state && app.state.agents) || []
  const todayGroups = (usage && usage.today && usage.today.groups) || []
  const cardSub = card
    ? [card.title, card.plan].filter((v, i, list) => v && list.indexOf(v) === i).join(' · ')
    : ''

  return html`<div class="grid" data-testid="page.overview">
    ${alerts.map((a) => html`<div class="col-12"><div class=${'alert-bar ' + (a.tone === 'bad' ? 'bad' : '')}>${a.text}</div></div>`)}

    <div class="col-7">
      <${Card} testid="overview.hero">
        <div class="hero">
          <div class="avatar" style=${{ background: 'color-mix(in srgb, ' + accent + ' 16%, var(--surface-2))', color: accent }}>
            ${app.roleImageUrl(app.roleIdForAgent(id)) ? html`<img src=${app.roleImageUrl(app.roleIdForAgent(id))} alt="" />` : agentName(id).slice(0, 1)}
          </div>
          <div class="hero-main">
            <div class="row">
              <span style=${{ fontSize: 16, fontWeight: 600 }}>${agentName(id)}</span>
              <${Badge} tone=${app.bindLabel().tone}>${app.bindLabel().text}</${Badge}>
            </div>
            <div class="big">${metric.value}</div>
            <div class="sub">${metric.label}${metric.sub ? ' · ' + metric.sub : ''}</div>
          </div>
        </div>
      </${Card}>
    </div>

    <div class="col-5">
      <${Card} title="上下文" testid="overview.context">
        ${ctx && ctx.supported
          ? html`<div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <${Gauge} pct=${ctx.pct} size=${120} tone=${pctTone(ctx.pct)} label="已用" />
              <div style=${{ minWidth: 0 }}>
                <div class="mono nowrap">${fmtNum(ctx.used)} / ${ctx.limit ? fmtNum(ctx.limit) : '—'}</div>
                <div class="small muted truncate" title=${ctx.model || ''}>${ctx.model || '未知模型'}</div>
                <div class="row" style=${{ marginTop: 6 }}>
                  <${Badge} tone=${ctx.confidence === 'exact' ? 'ok' : ctx.confidence === 'derived' ? 'info' : 'neutral'}>
                    ${ctx.confidence === 'exact' ? '精确' : ctx.confidence === 'derived' ? '推算' : '不可得'}
                  </${Badge}>
                </div>
              </div>
            </div>`
          : html`<${EmptyState} icon="layers" title="未检测到会话" hint=${app.reasonText(ctx && ctx.reason)} />`}
      </${Card}>
    </div>

    <div class="col-4"><${Card} class="stat">
      <div class="stat-label">上一轮</div>
      <div class="stat-value">${snap && snap.turn ? (snap.unit === 'credit' ? fmtCredit(snap.turn.amount) : fmtMoney(snap.turn.amount, snap.turn.currency)) : '—'}</div>
      <div class="stat-sub">${snap && snap.turn ? app.fmtTime(snap.capturedAt) : '暂无'}</div>
    </${Card}></div>
    <div class="col-4"><${Card} class="stat">
      <div class="stat-label">今日调用 / Tokens</div>
      <div class="stat-value">${snap && snap.usage ? fmtTokens(snap.usage.todayTokens) : '—'}</div>
      <div class="stat-sub">${snap && snap.details ? (snap.details.find((d) => d.label.includes('调用')) || {}).value || '—' : '—'}</div>
    </${Card}></div>
    <div class="col-4"><${Card} class="stat">
      <div class="stat-label">${snap && snap.balance ? '余额' : '额度'}</div>
      <div class="stat-value">${snap && snap.balance ? fmtMoney(snap.balance.amount, snap.balance.currency) : snap && snap.quota ? fmtPct(snap.quota.remainingPct) + ' 剩余' : '不可得'}</div>
      <div class="stat-sub">${snap && snap.error ? snap.error : cardSub || (card && card.note) || '宿主未提供额度'}</div>
    </${Card}></div>

    <${VendorBalanceCard} vendors=${app.vendors} app=${app} />

    <div class="col-7">
      <${Card} title="近 7 天用量" testid="overview.week" actions=${html`<span class="small muted">${series.length ? series[series.length - 1].currency : ''}</span>`}>
        ${series.length ? html`<${ColumnChart} data=${series} height=${220} valueLabel=${(v) => fmtMoney(v, series[0].currency)} />` : html`<${EmptyState} title="还没有用量记录" hint="打开一次宿主会话后这里会出现" />`}
      </${Card}>
    </div>

    <div class="col-5">
      <${Card} title="额度窗口" testid="overview.quota">
        ${windows.length
          ? windows.map((w) => html`<div style=${{ marginBottom: 12 }}>
              <div class="row"><span class="small">${w.label}</span><span class="spacer"></span><span class="small num">${fmtPct(w.remainingPct)}</span></div>
              <${ProgressBar} pct=${w.usedPct} tone=${pctTone(w.usedPct)} label=${w.label + ' 已用'} />
              ${w.resetAt ? html`<div class="small muted">${app.fmtReset(w.resetAt)}重置</div>` : null}
            </div>`)
          : html`<${EmptyState} icon="gauge" title="没有可读的额度窗口" hint=${card && card.note ? card.note : '该宿主没有提供额度窗口'} />`}
      </${Card}>
    </div>

    <div class="col-12">
      <${Card} title="全部 Agent 今日">
        <table class="table">
          <thead><tr><th style=${{ width: 200 }}>Agent</th><th class="right">今日</th><th style=${{ width: 220 }}>上下文</th><th style=${{ width: 120 }}>状态</th></tr></thead>
          <tbody>
            ${agents.map((a) => {
              const c = app.contexts[a.id]
              const s = app.snapshots[a.id]
              return html`<tr>
                <td><div class="row"><span style=${{ width: 8, height: 8, borderRadius: 4, background: a.accent || 'var(--accent)' }}></span>${a.name}</div></td>
                <td class="right num">${s && s.supported ? (s.unit === 'credit' ? fmtCredit(s.today && s.today.amount) : s.today ? fmtMoney(s.today.amount, s.today.currency) : '—') : '—'}</td>
                <td><div class="row" style=${{ gap: 8 }}><${MiniBar} pct=${c && c.pct} tone=${pctTone(c && c.pct)} /><span class="small muted">${c && c.supported ? fmtPct(c.pct) : '—'}</span></div></td>
                <td><${Badge} tone=${a.running ? 'ok' : 'neutral'}>${a.running ? '运行中' : '未运行'}</${Badge}></td>
              </tr>`
            })}
          </tbody>
        </table>
      </${Card}>
    </div>
  </div>`
}
