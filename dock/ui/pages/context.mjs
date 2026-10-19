import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Card, EmptyState, Segmented, Select } from '../components/base.mjs'
import { AreaChart, Gauge, StackedBar } from '../charts/svg.mjs'
import { fmtDateTime, fmtNum, fmtPct, fmtTokens, pctTone } from '../lib/format.mjs'

const html = htm.bind(h)


function confidenceBadge(ctx) {
  if (!ctx) return null
  if (ctx.confidence === 'exact') return html`<${Badge} tone="ok">精确</${Badge}>`
  if (ctx.confidence === 'derived') return html`<${Badge} tone="info">推算</${Badge}>`
  return html`<${Badge} tone="neutral">不可得</${Badge}>`
}

function estimate(ctx) {
  const pts = (ctx.points || []).slice(-6)
  if (pts.length < 3 || !ctx.limit) return null
  const growth = []
  for (let i = 1; i < pts.length; i++) {
    const d = Number(pts[i].used) - Number(pts[i - 1].used)
    if (d > 0) growth.push(d)
  }
  if (growth.length < 2) return null
  const avg = growth.reduce((a, b) => a + b, 0) / growth.length
  const remain = Math.max(0, Number(ctx.limit) - Number(ctx.used))
  return { turns: Math.floor(remain / avg), avg }
}

export function ContextPage({ app }) {
  const [sessions, setSessions] = useState([])
  const [session, setSession] = useState('')
  const [range, setRange] = useState('session')
  const [ctx, setCtx] = useState(app.contexts[app.viewAgent] || null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    app
      .api('/v1/agents/' + encodeURIComponent(app.viewAgent) + '/sessions')
      .then((d) => {
        if (!alive) return
        const list = d.sessions || []
        setSessions(list)
        if (!session && list[0]) setSession(list[0].id)
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [app.viewAgent, app.refreshAt])

  useEffect(() => {
    let alive = true
    const qs = new URLSearchParams({ range })
    if (session) qs.set('session', session)
    setLoading(true)
    app
      .api('/v1/agents/' + encodeURIComponent(app.viewAgent) + '/context?' + qs.toString())
      .then((d) => alive && setCtx(d.context))
      .catch(() => {})
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [app.viewAgent, app.refreshAt, session, range])

  const est = ctx ? estimate(ctx) : null
  const title = ctx && ctx.supported ? ctx.title || '当前会话' : '上下文'

  return html`<div data-testid="page.context">
    <div class="row" style=${{ marginBottom: 16 }}>
      <select class="select" style=${{ width: 280 }} value=${session} onChange=${(e) => setSession(e.currentTarget.value)} aria-label="选择会话">
        <option value="">最近会话</option>
        ${sessions.map((s) => html`<option value=${s.id}>${(s.title || s.id).slice(0, 40)} · ${s.pct == null ? '—' : fmtPct(s.pct)}</option>`)}
      </select>
      <span class="spacer"></span>
      ${confidenceBadge(ctx)}
      <span class="small muted">${loading ? '更新中…' : ctx && ctx.updatedAt ? fmtDateTime(ctx.updatedAt) : ''}</span>
    </div>

    ${!ctx
      ? html`<${Card}><div class="skeleton" style=${{ height: 200 }}></div></${Card}>`
      : !ctx.supported
        ? html`<${Card}><${EmptyState} icon="layers" title=${app.reasonText(ctx.reason)} hint="打开一个会话后这里会自动出现" /></${Card}>`
        : html`<div class="grid">
            <div class="col-5">
              <${Card} title="当前占用" testid="ctx.gauge">
                <div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  ${ctx.limit
                    ? html`<${Gauge} pct=${ctx.pct} size=${176} tone=${pctTone(ctx.pct)} label="已用" />`
                    : html`<div class="big num" style=${{ fontSize: 32 }}>${fmtTokens(ctx.used)} tokens</div>`}
                  <div class="mono">${fmtNum(ctx.used)} / ${ctx.limit ? fmtNum(ctx.limit) : '未能确定上限'}</div>
                  <div class="small muted truncate" title=${ctx.model || ''}>${ctx.model || '未知模型'}</div>
                  <div class="small muted">上限来源：${ctx.limitSource === 'host' ? '宿主配置' : ctx.limitSource === 'config' ? '本机模型表' : ctx.limitSource === 'builtin-table' ? '内置表' : '未知'}</div>
                </div>
              </${Card}>
            </div>
            <div class="col-7">
              <${Card} title="最近一次请求的构成">
                <${StackedBar} parts=${ctx.breakdown} />
                <div style=${{ marginTop: 16 }}>
                  ${est
                    ? html`<div class="small">预计触顶：约还可 <b>${est.turns}</b> 轮（近 ${Math.max(2, (ctx.points || []).length)} 次平均 +${fmtTokens(est.avg)}/轮）</div>`
                    : html`<div class="small muted">样本不足，暂不估算触顶轮数</div>`}
                  ${ctx.compaction
                    ? html`<div class="small muted" style=${{ marginTop: 8 }}>压缩：本会话 ${ctx.compaction.count} 次${ctx.compaction.lastAt ? ' · 最近 ' + fmtDateTime(ctx.compaction.lastAt) : ''}${ctx.compaction.shadowedTokens ? '（节省约 ' + fmtNum(ctx.compaction.shadowedTokens) + ' tok）' : ''}${ctx.compaction.derived ? ' · 推测' : ''}</div>`
                    : null}
                </div>
              </${Card}>
            </div>
            <div class="col-12">
              <${Card} title="占用趋势" testid="ctx.trend">
                <${AreaChart} points=${ctx.points} limit=${ctx.limit} height=${280} />
              </${Card}>
            </div>
            <div class="col-12">
              <${Card} title="最近会话">
                <table class="table">
                  <thead><tr><th>标题</th><th style=${{ width: 160 }}>模型</th><th style=${{ width: 200 }}>占用</th><th style=${{ width: 80 }} class="right">请求数</th><th style=${{ width: 130 }} class="right">更新于</th></tr></thead>
                  <tbody>
                    ${sessions.length
                      ? sessions.map(
                          (s) => html`<tr style=${{ cursor: 'pointer' }} tabindex="0" role="button" onClick=${() => setSession(s.id)} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSession(s.id) } }}>
                            <td class="ellipsis" title=${s.title || s.id}>${s.title || s.id}</td>
                            <td class="ellipsis" title=${s.model || ''}>${s.model || '—'}</td>
                            <td><div class="row" style=${{ gap: 8 }}>
                              <div class="progress" style=${{ flex: 1 }}><span style=${{ width: Math.min(100, Number(s.pct) || 0) + '%', background: 'var(--' + (pctTone(s.pct) === 'ok' ? 'accent' : pctTone(s.pct)) + ')' }}></span></div>
                              <span class="small num" style=${{ width: 48, textAlign: 'right' }}>${s.pct == null ? '—' : fmtPct(s.pct)}</span>
                            </div></td>
                            <td class="right num">${s.requests || '—'}</td>
                            <td class="right small muted">${s.updatedAt ? fmtDateTime(s.updatedAt) : '—'}</td>
                          </tr>`
                        )
                      : html`<tr><td colSpan="5"><${EmptyState} title="还没有会话记录" /></td></tr>`}
                  </tbody>
                </table>
              </${Card}>
            </div>
          </div>`}
  </div>`
}
