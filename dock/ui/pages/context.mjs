import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Card, EmptyState, SourceTag } from '../components/base.mjs'
import { AreaChart, Gauge, StackedBar } from '../charts/svg.mjs'
import { fmtDateTime, fmtNum, fmtPct, fmtTokens, pctTone } from '../lib/format.mjs'

const html = htm.bind(h)

function confidenceBadge(ctx) {
  if (!ctx) return null
  // 压缩后、下一轮对话前没有可用的当前占用：状态是确定的，数值不是。
  if (ctx.used == null && ctx.compaction) return html`<${Badge} tone="info">已压缩</${Badge}>`
  if (ctx.used == null) return html`<${Badge} tone="neutral">暂无占用</${Badge}>`
  if (ctx.confidence === 'exact') return html`<${Badge} tone="ok">精确</${Badge}>`
  if (ctx.confidence === 'derived') return html`<${Badge} tone="info">推算</${Badge}>`
  return html`<${Badge} tone="neutral">不可得</${Badge}>`
}

function estimate(ctx) {
  if (ctx.used == null) return null
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

// 上下文面板（原「上下文」页）：会话详情的「上下文」标签直接挂载。
// 保留原有 testid（ctx.*），不再单独占一页。
export function ContextPanel({ app, agentId = '', sessionId = '', compact = false }) {
  const id = agentId || app.viewAgent
  const [ctx, setCtx] = useState((app.contexts && app.contexts[id]) || null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    const qs = new URLSearchParams({ range: 'session' })
    if (sessionId) qs.set('session', sessionId)
    setLoading(true)
    app
      .api('/v1/agents/' + encodeURIComponent(id) + '/context?' + qs.toString())
      .then((d) => alive && setCtx(d.context))
      .catch(() => {})
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [id, sessionId, app.refreshAt])

  const est = ctx ? estimate(ctx) : null

  return html`<div data-testid="context.panel" class=${compact ? 'context-compact' : ''}>
    <div class="row" style=${{ marginBottom: 12 }}>
      ${confidenceBadge(ctx)}
      ${ctx && ctx.provenance && ctx.provenance.used ? html`<${SourceTag} prov=${ctx.provenance.used} variant="dot" />` : null}
      <span class="spacer"></span>
      <span class="small muted">${loading ? '更新中…' : ctx && ctx.updatedAt ? fmtDateTime(ctx.updatedAt) : ''}</span>
    </div>

    ${!ctx
      ? html`<div class="skeleton" style=${{ height: 160 }}></div>`
      : !ctx.supported
        ? html`<${EmptyState} icon="layers" title=${app.reasonText(ctx.reason)} hint="打开一个会话后这里会自动出现" />`
        : html`<div class="grid">
            <div class=${compact ? 'col-12' : 'col-5'}>
              <${Card} title="当前占用" testid="ctx.gauge">
                <div style=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  ${ctx.used == null
                    ? ctx.compaction
                      ? html`<div class="empty" style=${{ minHeight: compact ? 96 : 140, padding: 8 }}>
                          <span class="small">已压缩，下一轮对话后刷新占用</span>
                          ${ctx.compaction.lastAt
                            ? html`<span class="small muted">最近压缩 ${fmtDateTime(ctx.compaction.lastAt)}</span>`
                            : null}
                        </div>`
                      : html`<div class="empty" style=${{ minHeight: compact ? 96 : 140, padding: 8 }}>
                          <span class="small">暂无当前占用数据</span>
                        </div>`
                    : ctx.limit
                      ? html`<${Gauge} pct=${ctx.pct} size=${compact ? 120 : 176} tone=${pctTone(ctx.pct)} label="已用" />`
                      : html`<div class="big num" style=${{ fontSize: 32 }}>${fmtTokens(ctx.used)} tokens</div>`}
                  <div class="mono">${ctx.used == null ? '—' : fmtNum(ctx.used)} / ${ctx.limit ? fmtNum(ctx.limit) : '未能确定上限'}</div>
                  <div class="small muted truncate" title=${ctx.model || ''}>${ctx.model || '未知模型'}</div>
                  <div class="small muted">上限来源：${ctx.limitSource === 'host' ? '宿主配置' : ctx.limitSource === 'config' ? '本机模型表' : ctx.limitSource === 'builtin-table' ? '内置表' : '未知'}</div>
                </div>
              </${Card}>
            </div>
            <div class=${compact ? 'col-12' : 'col-7'}>
              <${Card} title="最近一次请求的构成">
                ${ctx.used == null
                  ? html`<div class="small muted">${ctx.compaction ? '压缩后暂无构成数据，下一轮对话后恢复。' : '暂无构成数据。'}</div>`
                  : html`<${StackedBar} parts=${ctx.breakdown} />`}
                <div style=${{ marginTop: 16 }}>
                  ${est
                    ? html`<div class="small">预计触顶：约还可 <b>${est.turns}</b> 轮（近 ${Math.max(2, (ctx.points || []).length)} 次平均 +${fmtTokens(est.avg)}/轮）</div>`
                    : ctx.used == null && ctx.compaction
                      ? html`<div class="small muted">压缩后暂不估算，下一轮对话后恢复</div>`
                      : html`<div class="small muted">样本不足，暂不估算触顶轮数</div>`}
                  ${ctx.compaction
                    ? html`<div class="small muted" style=${{ marginTop: 8 }}>压缩：本会话 ${ctx.compaction.count} 次${ctx.compaction.lastAt ? ' · 最近 ' + fmtDateTime(ctx.compaction.lastAt) : ''}${ctx.compaction.shadowedTokens ? '（节省约 ' + fmtNum(ctx.compaction.shadowedTokens) + ' tok）' : ''}${ctx.compaction.derived ? ' · 推测' : ''}</div>`
                    : null}
                </div>
              </${Card}>
            </div>
            <div class="col-12">
              <${Card} title="占用趋势" testid="ctx.trend">
                <${AreaChart} points=${ctx.points} limit=${ctx.limit} height=${compact ? 220 : 280} />
              </${Card}>
            </div>
          </div>`}
  </div>`
}
