import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Card, EmptyState, ProgressBar, Segmented, Select } from '../components/base.mjs'
import { agentName, fmtDateTime, fmtMoney, fmtPct, pctTone, fmtReset } from '../lib/format.mjs'

const html = htm.bind(h)

const FILTERS = [
  { value: 'configured', label: '已配置' },
  { value: 'all', label: '全部' },
  { value: 'error', label: '异常' },
]
const SORTS = [
  { value: 'balance', label: '按余额' },
  { value: 'name', label: '按名称' },
  { value: 'usage', label: '按用量' },
]

function VendorCard({ v }) {
  const color = v.kind === 'relay' ? '#8b5cf6' : v.kind === 'local-log' ? '#f0a04b' : v.kind === 'cmdgo' ? '#10b981' : 'var(--text-3)'
  const value =
    v.percentRemaining != null
      ? fmtPct(v.percentRemaining) + ' 剩余'
      : v.balance != null
        ? fmtMoney(v.balance, v.currency || 'USD')
        : v.available
          ? '接口可用'
          : '—'
  return html`<div class="card vendor-card">
    <div class="vendor-head">
      <div class="vendor-avatar" style=${{ background: color }}>${String(v.name || '?').slice(0, 1)}</div>
      <div style=${{ minWidth: 0, flex: 1 }}>
        <div class="row"><span style=${{ fontWeight: 600 }}>${v.name}</span><span class="spacer"></span>
          ${v.configured ? html`<${Badge} tone="ok">已配置</${Badge}>` : html`<${Badge} tone="neutral">未配置</${Badge}>`}
        </div>
        <div class="small muted">${v.kind === 'relay' ? '中转站' : v.kind === 'local-log' ? '订阅套餐' : v.kind === 'cmdgo' ? 'CommandCode' : v.kind === 'balance' ? '余额接口' : v.kind === 'quota' ? '额度接口' : '模板'}</div>
      </div>
    </div>
    <div class="row" style=${{ alignItems: 'baseline' }}>
      <span class="num" style=${{ fontSize: 20, fontWeight: 700 }}>${value}</span>
      ${v.todayUsage != null ? html`<span class="small muted">今日 ${fmtMoney(v.todayUsage, v.currency || 'CNY')}</span>` : null}
    </div>
    ${v.windows && v.windows.length
      ? v.windows.slice(0, 2).map((w) => html`<div>
          <div class="row small"><span>${w.label || '窗口'}</span><span class="spacer"></span><span>${w.percent != null ? fmtPct(w.percent) : ''}</span></div>
          <${ProgressBar} pct=${w.percent} tone=${pctTone(w.percent)} />
        </div>`)
      : null}
    ${v.reason ? html`<div class="small muted truncate" title=${v.reason}>${v.reason}</div>` : null}
    <div class="row small muted">
      <span>${v.keyMasked || (v.keySource && v.keySource !== 'none' ? v.keySource : '')}</span>
      <span class="spacer"></span>
      ${v.source ? html`<span class="mono">${v.source}</span>` : null}
    </div>
  </div>`
}

export function QuotaPage({ app }) {
  const [vendors, setVendors] = useState(null)
  const [filter, setFilter] = useState('configured')
  const [sort, setSort] = useState('balance')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    app
      .api('/v1/vendors')
      .then((d) => alive && setVendors(d.vendors || []))
      .catch((e) => alive && setError(String(e.message || e)))
    return () => {
      alive = false
    }
  }, [app.refreshAt])

  const snap = app.snapshots[app.viewAgent]
  const card = snap && snap.quotaCard
  const windows = (card && card.windows) || []
  const list = (vendors || [])
    .filter((v) => (filter === 'all' ? true : filter === 'configured' ? v.configured : !v.available && v.configured))
    .sort((a, b) => {
      if (sort === 'name') return String(a.name).localeCompare(String(b.name), 'zh-CN')
      if (sort === 'usage') return (b.todayUsage || 0) - (a.todayUsage || 0)
      return (b.balance || b.remaining || 0) - (a.balance || a.remaining || 0)
    })
  const unconfigured = (vendors || []).filter((v) => !v.configured)

  return html`<div data-testid="page.quota">
    ${error ? html`<div class="alert-bar bad">${error}</div>` : null}
    <div class="card" style=${{ marginBottom: 16 }}>
      <div class="card-head"><span class="card-title">${agentName(app.viewAgent)} 的额度</span><span class="spacer"></span>
        ${snap ? html`<span class="small muted">${snap.capturedAt ? fmtDateTime(snap.capturedAt) : ''}</span>` : null}
      </div>
      ${!card
        ? html`<${EmptyState} icon="gauge" title="该宿主没有额度数据" hint="适配器未提供 quotaCard" />`
        : card.kind === 'windows'
          ? windows.length === 1
            ? html`<div class="row" style=${{ alignItems: 'baseline', gap: 12 }}>
                <span class="num" style=${{ fontSize: 40, fontWeight: 700 }}>${fmtPct(windows[0].remainingPct)}</span>
                <span class="muted">剩余 · ${windows[0].label}${windows[0].resetAt ? ' · ' + fmtReset(windows[0].resetAt) + '重置' : ''}</span>
              </div>`
            : windows.map(
                (w) => html`<div style=${{ marginBottom: 14 }}>
                  <div class="row"><span>${w.label}</span><span class="spacer"></span><span class="num">${fmtPct(w.remainingPct)} 剩余</span><span class="small muted" style=${{ width: 120, textAlign: 'right' }}>${fmtReset(w.resetAt)}</span></div>
                  <${ProgressBar} pct=${w.usedPct} tone=${pctTone(w.usedPct)} />
                </div>`
              )
          : card.kind === 'balance'
            ? html`<div class="row" style=${{ alignItems: 'baseline', gap: 12 }}>
                <span class="num" style=${{ fontSize: 32, fontWeight: 700 }}>${card.balance ? fmtMoney(card.balance.amount, card.balance.currency) : '—'}</span>
                <span class="muted">余额</span>
              </div>`
            : card.kind === 'error'
              ? html`<div class="alert-bar bad">${card.message || '额度读取失败'}</div>`
              : html`<div class="row" style=${{ gap: 12 }}>
                  <${Badge} tone="neutral">${card.plan || '套餐'}</${Badge}>
                  <span class="muted">${card.note || '没有可读的套餐额度窗口'}</span>
                </div>`}
      ${card && card.note && card.kind !== 'plan' ? html`<div class="small muted" style=${{ marginTop: 8 }}>${card.note}</div>` : null}
    </div>

    <div class="row" style=${{ marginBottom: 12 }}>
      <${Segmented} value=${filter} options=${FILTERS} onChange=${setFilter} />
      <${Select} aria-label="排序" value=${sort} options=${SORTS} onChange=${setSort} />
      <span class="spacer"></span>
      <span class="small muted">未配置模板 ${unconfigured.length} 个</span>
    </div>

    ${!vendors
      ? html`<div class="card"><div class="skeleton" style=${{ height: 200 }}></div></div>`
      : list.length
        ? html`<div class="vendor-grid">${list.map((v) => html`<${VendorCard} v=${v} />`)}</div>`
        : html`<${Card}><${EmptyState} title="没有符合筛选的厂商" hint="切换到「全部」查看所有模板" /></${Card}>`}
  </div>`
}
