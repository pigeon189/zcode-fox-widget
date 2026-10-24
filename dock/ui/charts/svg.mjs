import { h } from '../vendor/preact.module.js'
import { useLayoutEffect, useRef, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { fmtNum, fmtPct, fmtTokens, hhmm } from '../lib/format.mjs'

const html = htm.bind(h)

// 图表按容器实际宽度绘制：固定 viewBox + preserveAspectRatio="none" 会把
// 12px 字号和柱宽一起等比压扁，窄窗口下文字/柱子明显失真。
function useChartWidth(fallback = 704) {
  const ref = useRef(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const w = Math.round(el.getBoundingClientRect().width)
      if (w > 0) setWidth((prev) => (Math.abs(prev - w) > 1 ? w : prev))
    }
    read()
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(read)
      ro.observe(el)
      return () => ro.disconnect()
    }
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])
  return [ref, width || fallback]
}

function clampPct(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

export function Gauge({ pct, label = '', sub = '', size = 120, tone = '' }) {
  const v = clampPct(pct)
  const stroke = Math.max(6, Math.round(size * 0.08))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const color = tone ? 'var(--' + tone + ')' : 'var(--accent)'
  return html`<svg class="chart" width=${size} height=${size} viewBox=${'0 0 ' + size + ' ' + size} role="img"
    aria-label=${'上下文占用 ' + fmtPct(v) + (label ? '，' + label : '')}>
    <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--surface-2)" stroke-width=${stroke} />
    <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke=${color} stroke-width=${stroke}
      stroke-linecap="round" stroke-dasharray=${c} stroke-dashoffset=${c * (1 - v / 100)}
      transform=${'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'} />
    <text x="50%" y="47%" text-anchor="middle" dominant-baseline="middle" fill="var(--text)"
      font-size=${Math.min(32, Math.max(16, Math.round(size * 0.2)))} font-weight="700" font-family="var(--font-num)">${fmtPct(v)}</text>
    ${label
      ? html`<text x="50%" y="64%" text-anchor="middle" fill="var(--text-3)" font-size="12">${label}</text>`
      : null}
    ${sub ? html`<text x="50%" y="76%" text-anchor="middle" fill="var(--text-3)" font-size="12">${sub}</text>` : null}
  </svg>`
}

const BREAKDOWN_COLORS = {
  cacheRead: 'var(--c1)',
  input: 'var(--c2)',
  cacheWrite: 'var(--c3)',
  output: 'var(--c4)',
  reasoning: 'var(--c5)',
}

export const BREAKDOWN_LABELS = {
  cacheRead: '缓存命中',
  input: '未缓存输入',
  cacheWrite: '缓存写入',
  output: '输出',
  reasoning: '推理',
}

export function StackedBar({ parts }) {
  const list = Object.entries(parts || {}).filter(([, v]) => Number(v) > 0)
  const total = list.reduce((s, [, v]) => s + Number(v), 0)
  if (!total) {
    return html`<div class="empty" style=${{ minHeight: 80 }}><span class="small">该宿主未提供构成明细</span></div>`
  }
  return html`<div role="img" aria-label=${'请求构成：' + list.map(([k, v]) => (BREAKDOWN_LABELS[k] || k) + ' ' + fmtNum(v)).join('，')}>
    <div style=${{ display: 'flex', height: 24, borderRadius: 8, overflow: 'hidden', gap: '2px', background: 'var(--surface-2)' }}>
      ${list.map(([k, v]) => html`<div title=${BREAKDOWN_LABELS[k] + ' ' + fmtNum(v)}
        style=${{ width: Math.max(0.4, (Number(v) / total) * 100) + '%', background: BREAKDOWN_COLORS[k] || 'var(--c5)' }}></div>`)}
    </div>
    <div class="legend" style=${{ marginTop: 8 }}>
      ${list.map(
        ([k, v]) => html`<span><span class="swatch" style=${{ background: BREAKDOWN_COLORS[k] || 'var(--c5)' }}></span>${BREAKDOWN_LABELS[k] || k} <span class="muted">${fmtNum(v)}</span></span>`
      )}
    </div>
  </div>`
}

export function AreaChart({ points, limit = null, warn = 80, danger = 92, height = 260 }) {
  const list = (points || []).filter((p) => Number.isFinite(Number(p.used)))
  const [wrapRef, width] = useChartWidth()
  if (list.length < 2) {
    return html`<div class="chart-wrap" ref=${wrapRef}><div class="empty" style=${{ minHeight: height }}><span class="small">趋势点还不够（至少两次采样）</span></div></div>`
  }
  const maxY = Number(limit) > 0 ? Number(limit) : Math.max(...list.map((p) => Number(p.used))) * 1.1
  const padL = 48
  const padR = 16
  const padT = 12
  const padB = 28
  const iw = width - padL - padR
  const ih = height - padT - padB
  const x0 = Number(list[0].t)
  const x1 = Number(list[list.length - 1].t) || x0 + 1
  const xOf = (t) => padL + (x1 === x0 ? 0 : ((Number(t) - x0) / (x1 - x0)) * iw)
  const yOf = (v) => padT + ih - (Math.max(0, Math.min(maxY, Number(v))) / maxY) * ih
  const line = list.map((p, i) => (i ? 'L' : 'M') + xOf(p.t).toFixed(1) + ' ' + yOf(p.used).toFixed(1)).join(' ')
  const area = line + ' L' + xOf(x1).toFixed(1) + ' ' + (padT + ih) + ' L' + xOf(x0).toFixed(1) + ' ' + (padT + ih) + ' Z'
  return html`<div class="chart-wrap" ref=${wrapRef}>
    <svg class="chart" viewBox=${'0 0 ' + width + ' ' + height} preserveAspectRatio="none" role="img"
      aria-label=${'上下文占用趋势，最近 ' + list.length + ' 个采样点'}>
      ${[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const y = padT + ih * f
        return html`<line x1=${padL} y1=${y} x2=${width - padR} y2=${y} stroke="var(--border)" stroke-width="1" />
          <text x=${padL - 8} y=${y + 3} text-anchor="end" fill="var(--text-3)" font-size="12">${fmtNum(Math.round(maxY * (1 - f)))}</text>`
      })}
      ${[warn, danger].map((v) => {
        if (!(v > 0 && v < 100)) return null
        const y = yOf((maxY * v) / 100)
        return html`<line x1=${padL} y1=${y} x2=${width - padR} y2=${y} stroke=${v >= 92 ? 'var(--bad)' : 'var(--warn)'} stroke-width="1" stroke-dasharray="4 4" opacity="0.7" />
          <text x=${width - padR} y=${y - 4} text-anchor="end" fill=${v >= 92 ? 'var(--bad)' : 'var(--warn)'} font-size="12">${v}%</text>`
      })}
      <path d=${area} fill="color-mix(in srgb, var(--accent) 20%, transparent)" />
      <path d=${line} fill="none" stroke="var(--accent)" stroke-width="2" />
      ${list.map((p) => html`<circle cx=${xOf(p.t)} cy=${yOf(p.used)} r="5" fill="transparent">
        <title>${hhmm(p.t)} · ${fmtNum(p.used)}${limit ? ' / ' + fmtNum(limit) : ''}</title>
      </circle>`)}
      <text x=${padL} y=${height - 8} fill="var(--text-3)" font-size="12">${hhmm(x0)}</text>
      <text x=${width - padR} y=${height - 8} text-anchor="end" fill="var(--text-3)" font-size="12">${hhmm(x1)}</text>
    </svg>
  </div>`
}

export function ColumnChart({ data, height = 200, valueLabel = (v) => fmtNum(v), details = null, prev = null }) {
  const list = data || []
  const prevValues = Array.isArray(prev) ? prev.map((d) => (typeof d === 'number' ? d : Number(d && d.value) || 0)) : null
  const [hover, setHover] = useState(null)
  const [wrapRef, width] = useChartWidth()
  const max = Math.max(1, ...list.map((d) => Number(d.value) || 0), ...(prevValues || [0]))
  const padL = 40
  const padR = 12
  const padT = 12
  const padB = 28
  const iw = width - padL - padR
  const ih = height - padT - padB
  const slot = iw / Math.max(1, list.length)
  const barW = Math.max(6, Math.min(28, slot - 10))
  // 日期标签至少留 34px；从最新一天往前取整，保证最后一天总显示。
  const labelEvery = Math.max(1, Math.ceil(34 / Math.max(1, slot)))
  const chartLabel = '每日用量柱图' + (list.length ? '，' + list[0].label + ' 至 ' + list[list.length - 1].label : '')
  const active = hover != null ? list[hover] : null
  const activeRows =
    hover != null && Array.isArray(details)
      ? details[hover] || []
      : active && Array.isArray(active.details)
        ? active.details
        : []
  const barTop = active ? padT + ih - ((Number(active.value) || 0) / max) * ih : padT + ih
  // 气泡放条形侧面，避免盖住正在查看的柱子；靠近右边界时翻到左侧。
  const barCenter = hover == null ? padL : padL + slot * hover + slot / 2
  const tipRight = barCenter < width / 2
  const tipX = tipRight ? barCenter + barW / 2 + 10 : barCenter - barW / 2 - 10
  const tipY = Math.max(36, Math.min(height - 12, barTop))
  return html`<div class="chart-wrap" ref=${wrapRef}>
    <svg class="chart" viewBox=${'0 0 ' + width + ' ' + height} preserveAspectRatio="none" role="img" aria-label=${chartLabel}
      onMouseLeave=${() => setHover(null)}>
      ${[0, 0.5, 1].map((f) => html`<line x1=${padL} y1=${padT + ih * f} x2=${width - padR} y2=${padT + ih * f} stroke="var(--border)" />
        <text x=${padL - 6} y=${padT + ih * f + 3} text-anchor="end" fill="var(--text-3)" font-size="12">${f === 0 ? valueLabel(max) : f === 1 ? '0' : ''}</text>`)}
      ${hover != null
        ? html`<line x1=${padL + slot * hover + slot / 2} y1=${padT} x2=${padL + slot * hover + slot / 2} y2=${padT + ih}
            stroke="var(--text-3)" stroke-width="1" stroke-dasharray="3 3" opacity="0.8" />`
        : null}
      ${prevValues && prevValues.length
        ? html`<path d=${prevValues
            .map((v, i) => (i ? 'L' : 'M') + (padL + slot * i + slot / 2).toFixed(1) + ' ' + (padT + ih - (v / max) * ih).toFixed(1))
            .join(' ')} fill="none" stroke="var(--c5)" stroke-width="2" stroke-dasharray="4 3" />`
        : null}
      ${list.map((d, i) => {
        const value = Number(d.value) || 0
        const h = (value > 0 ? value : 0) / max * ih
        const x = padL + slot * i + (slot - barW) / 2
        return html`<g>
          ${h > 0
            ? html`<rect x=${x} y=${padT + ih - h} width=${barW} height=${Math.max(1, h)} rx="4"
                fill=${d.today ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 45%, transparent)'} />`
            : null}
          ${(list.length - 1 - i) % labelEvery === 0
            ? html`<text x=${x + barW / 2} y=${height - 8} text-anchor="middle" fill=${d.today ? 'var(--text)' : 'var(--text-3)'} font-size="12">${d.label}</text>`
            : null}
        </g>`
      })}
      ${list.map((d, i) => html`<rect x=${padL + slot * i} y=${padT} width=${slot} height=${ih}
        fill="transparent" pointer-events="all" onMouseEnter=${() => setHover(i)} />`)}
    </svg>
    ${prevValues
      ? html`<div class="legend"><span><span class="swatch" style=${{ background: 'var(--accent)' }}></span>本周期</span><span><span class="swatch" style=${{ background: 'var(--c5)' }}></span>上周期</span></div>`
      : null}
    ${active && activeRows.length
      ? html`<div class=${'chart-tip ' + (tipRight ? 'side-right' : 'side-left')} style=${{ left: tipX + 'px', top: tipY + 'px' }}>
          <div class="chart-tip-head"><span>${active.fullDate || active.label}</span><b>${valueLabel(active.value)}</b></div>
          ${activeRows.map(
            (r) => html`<div class="chart-tip-row"><span>${r.label}</span><b>${r.value}</b></div>`
          )}
        </div>`
      : null}
  </div>`
}

export function MiniBar({ pct, tone = '' }) {
  return html`<div class=${'progress ' + tone} role="img" aria-label=${'占用 ' + (Math.round((Number(pct) || 0) * 10) / 10) + '%'} style=${{ height: 6, minWidth: 80 }}>
    <span style=${{ width: clampPct(pct) + '%' }}></span>
  </div>`
}

// 多模型每日 token 趋势：series = [{key,label,values[],color?}]，labels 与 values 等长。
export function MultiLineChart({ labels = [], series = [], height = 260 }) {
  const [wrapRef, width] = useChartWidth()
  const padL = 48
  const padR = 16
  const padT = 14
  const padB = 30
  const iw = width - padL - padR
  const ih = height - padT - padB
  const list = Array.isArray(labels) ? labels : []
  const rows = (series || []).filter((s) => s && Array.isArray(s.values) && s.values.some((v) => Number(v) > 0))
  const maxY = Math.max(1, ...rows.flatMap((s) => s.values.map((v) => Number(v) || 0)))
  const xOf = (i) => padL + (list.length <= 1 ? iw / 2 : (i / (list.length - 1)) * iw)
  const xStep = list.length > 1 ? iw / (list.length - 1) : iw
  // 以像素间距而不是固定下标决定标签密度；从最后一天往前取整，末点总显示。
  const labelEvery = Math.max(1, Math.ceil(34 / Math.max(1, xStep)))
  const yOf = (v) => padT + ih - (Math.max(0, Number(v) || 0) / maxY) * ih
  return html`<div class="chart-wrap" ref=${wrapRef}>
    <svg class="chart" viewBox=${'0 0 ' + width + ' ' + height} preserveAspectRatio="none" role="img"
      aria-label=${'每日 Token 趋势，' + rows.length + ' 个模型' + (list.length ? '，' + list[0] + ' 至 ' + list[list.length - 1] : '')}>
      ${[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const y = padT + ih * f
        return html`<line x1=${padL} y1=${y} x2=${width - padR} y2=${y} stroke="var(--border)" stroke-width="1" />
          <text x=${padL - 8} y=${y + 3} text-anchor="end" fill="var(--text-3)" font-size="12">${fmtTokens(Math.round(maxY * (1 - f)))}</text>`
      })}
    ${rows.map((s, si) => {
      const color = s.color || 'var(--c' + ((si % 6) + 1) + ')'
      const path = s.values
        .map((v, i) => (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(v).toFixed(1))
        .join(' ')
      return html`<g>
        <path d=${path} fill="none" stroke=${color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        ${s.values.map((v, i) =>
          Number(v) > 0
            ? html`<circle cx=${xOf(i)} cy=${yOf(v)} r="2.5" fill=${color}>
                <title>${list[i] + ' · ' + (s.label || s.key) + '：' + fmtTokens(v)}</title>
              </circle>`
            : null
        )}
      </g>`
    })}
    ${(() => {
      return list.map((label, i) => {
        if ((list.length - 1 - i) % labelEvery !== 0) return null
        return html`<text x=${xOf(i)} y=${height - 8} text-anchor="middle" fill="var(--text-3)" font-size="12">${String(label).slice(5)}</text>`
      })
    })()}
    </svg>
  </div>`
}

// 轻量环形图：items = [{label,value,color?}]，中心显示总量。
export function Donut({ items = [], size = 150, thickness = 18, centerLabel = '', valueLabel = (v) => fmtTokens(v) }) {
  const list = (items || []).filter((it) => Number(it.value) > 0)
  const total = list.reduce((s, it) => s + Number(it.value), 0)
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  let offset = 0
  return html`<svg class="chart" width=${size} height=${size} viewBox=${'0 0 ' + size + ' ' + size} role="img"
    aria-label=${'模型用量占比：' + list.map((it) => (it.label || '') + ' ' + fmtTokens(it.value)).join('，')}>
    <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--surface-2)" stroke-width=${thickness} />
    ${list.map((it, i) => {
      const frac = total > 0 ? Number(it.value) / total : 0
      const dash = c * frac
      const node = html`<circle cx=${size / 2} cy=${size / 2} r=${r} fill="none"
        stroke=${it.color || 'var(--c' + ((i % 6) + 1) + ')'} stroke-width=${thickness}
        stroke-dasharray=${dash + ' ' + Math.max(0.001, c - dash)}
        stroke-dashoffset=${-offset} transform=${'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'}>
        <title>${(it.label || '') + '：' + valueLabel(it.value)}</title>
      </circle>`
      offset += dash
      return node
    })}
    <text x="50%" y="47%" text-anchor="middle" fill="var(--text)" font-size="18" font-weight="700" font-family="var(--font-num)">${valueLabel(total)}</text>
    <text x="50%" y="62%" text-anchor="middle" fill="var(--text-3)" font-size="12">${centerLabel || 'tokens'}</text>
  </svg>`
}

// 下钻用堆叠柱：series = [{key,label,values,color?}]，labels 等长。
const SERIES_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--text-3)']

export function StackedColumnChart({ labels = [], series = [], height = 220, valueLabel = (v) => fmtNum(v) }) {
  const [wrapRef, width] = useChartWidth()
  const [hover, setHover] = useState(null)
  const padL = 48
  const padR = 12
  const padT = 12
  const padB = 28
  const iw = width - padL - padR
  const ih = height - padT - padB
  const list = Array.isArray(labels) ? labels : []
  const rows = (series || []).filter((s) => s && Array.isArray(s.values))
  const totals = list.map((_, i) => rows.reduce((sum, s) => sum + (Number(s.values[i]) || 0), 0))
  const max = Math.max(1, ...totals)
  const slot = iw / Math.max(1, list.length)
  const barW = Math.max(4, Math.min(28, slot * 0.6))
  const labelEvery = Math.max(1, Math.ceil(34 / Math.max(1, slot)))
  const chartLabel =
    '堆叠柱图，' + rows.length + ' 个系列' + (list.length ? '，' + list[0] + ' 至 ' + list[list.length - 1] : '')
  const active = hover != null ? list[hover] : null
  const activeTotal = hover != null ? totals[hover] || 0 : 0
  const barTop = active ? padT + ih - (activeTotal / max) * ih : padT + ih
  const barCenter = hover == null ? padL : padL + slot * hover + slot / 2
  const tipRight = barCenter < width / 2
  const tipX = tipRight ? barCenter + barW / 2 + 10 : barCenter - barW / 2 - 10
  const tipY = Math.max(36, Math.min(height - 12, barTop))
  return html`<div class="chart-wrap" ref=${wrapRef}>
    <svg class="chart" viewBox=${'0 0 ' + width + ' ' + height} preserveAspectRatio="none" role="img"
      aria-label=${chartLabel} onMouseLeave=${() => setHover(null)}>
      ${[0, 0.5, 1].map((f) => html`<line x1=${padL} y1=${padT + ih * f} x2=${width - padR} y2=${padT + ih * f} stroke="var(--border)" />
        <text x=${padL - 6} y=${padT + ih * f + 3} text-anchor="end" fill="var(--text-3)" font-size="12">${f === 0 ? valueLabel(max) : f === 1 ? '0' : ''}</text>`)}
      ${hover != null
        ? html`<line x1=${padL + slot * hover + slot / 2} y1=${padT} x2=${padL + slot * hover + slot / 2} y2=${padT + ih}
            stroke="var(--text-3)" stroke-width="1" stroke-dasharray="3 3" opacity="0.8" />`
        : null}
      ${list.map((label, i) => {
        let y = padT + ih
        return html`<g>
          ${rows.map((s, si) => {
            const v = Number(s.values[i]) || 0
            if (v <= 0) return null
            const h = (v / max) * ih
            y -= h
            return html`<rect x=${padL + slot * i + (slot - barW) / 2} y=${y} width=${barW} height=${Math.max(1, h)}
              fill=${s.color || SERIES_COLORS[si % SERIES_COLORS.length]} />`
          })}
          ${(list.length - 1 - i) % labelEvery === 0
            ? html`<text x=${padL + slot * i + slot / 2} y=${height - 8} text-anchor="middle" fill="var(--text-3)" font-size="12">${label}</text>`
            : null}
        </g>`
      })}
      ${list.map((_, i) => html`<rect x=${padL + slot * i} y=${padT} width=${slot} height=${ih}
        fill="transparent" pointer-events="all" onMouseEnter=${() => setHover(i)} />`)}
    </svg>
    ${active && rows.length
      ? html`<div class=${'chart-tip ' + (tipRight ? 'side-right' : 'side-left')}
          style=${{ left: tipX + 'px', top: tipY + 'px' }}>
          <div class="chart-tip-head"><span>${active}</span><b>${valueLabel(activeTotal)}</b></div>
          ${rows.map(
            (s) => html`<div class="chart-tip-row"><span>${s.label || s.key}</span><b>${valueLabel(Number(s.values[hover]) || 0)}</b></div>`
          )}
        </div>`
      : null}
    ${rows.length
      ? html`<div class="legend">
          ${rows.map((s, i) => html`<span><span class="swatch" style=${{ background: s.color || SERIES_COLORS[i % SERIES_COLORS.length] }}></span>${s.label || s.key}</span>`)}
        </div>`
      : null}
  </div>`
}

// 状态时间线：segments = [{status,from,to}]
export function StatusTimeline({ segments = [], height = 24 }) {
  const list = (segments || []).filter((s) => s && Number(s.to) > Number(s.from))
  const total = list.reduce((sum, s) => sum + (Number(s.to) - Number(s.from)), 0) || 1
  const tone = {
    working: 'var(--st-working)',
    waiting_permission: 'var(--st-waiting)',
    waiting_input: 'var(--st-waiting)',
    error: 'var(--st-error)',
    done: 'var(--st-done)',
    idle: 'var(--st-idle)',
    unknown: 'var(--st-idle)',
  }
  return html`<div role="img" aria-label=${'状态时间线，' + list.length + ' 段'}
    style=${{ display: 'flex', height: height + 'px', borderRadius: 6, overflow: 'hidden', background: 'var(--surface-2)' }}>
    ${list.length
      ? list.map((s) => {
          const ms = Number(s.to) - Number(s.from)
          return html`<span title=${s.status + ' · ' + hhmm(s.from) + '–' + hhmm(s.to) + ' · ' + Math.max(1, Math.round(ms / 60000)) + ' 分钟'}
            style=${{ width: Math.max(0.5, (ms / total) * 100) + '%', background: tone[s.status] || 'var(--st-idle)' }}></span>`
        })
      : html`<span style=${{ flex: 1, background: 'var(--surface-2)' }}></span>`}
  </div>`
}

// 迷你趋势线。
export function Sparkline({ values = [], labels = [], width: fixedWidth = 0, height = 56, tone = 'var(--accent)', valueLabel = (v) => fmtNum(v) }) {
  const [wrapRef, measured] = useChartWidth(220)
  const width = fixedWidth || measured
  const list = (values || []).map((v) => Number(v) || 0)
  const max = Math.max(1, ...list)
  // 窄卡片（1280 下今日卡内宽约 210px）把左边距压到 38，给折线多留绘图宽度；
  // 再窄会切掉 12px 的 Y 轴标签，所以不再往下压。
  const padL = width < 220 ? 38 : 46
  const padR = 6
  const padT = 8
  const padB = 16
  const iw = Math.max(1, width - padL - padR)
  const ih = Math.max(1, height - padT - padB)
  const xOf = (i) => padL + (list.length <= 1 ? iw / 2 : (i / (list.length - 1)) * iw)
  const yOf = (v) => padT + ih - (Math.max(0, v) / max) * ih
  const line = list.map((v, i) => (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(v).toFixed(1)).join(' ')
  const area = list.length ? line + ' L' + xOf(list.length - 1).toFixed(1) + ' ' + (padT + ih) + ' L' + xOf(0).toFixed(1) + ' ' + (padT + ih) + ' Z' : ''
  const first = labels[0] || ''
  const last = labels[labels.length - 1] || ''
  return html`<div class="chart-wrap" ref=${wrapRef}>
    <svg class="chart" viewBox=${'0 0 ' + width + ' ' + height} width=${width} height=${height} role="img" aria-label=${'趋势，' + list.length + ' 个点'}>
      <line x1=${padL} y1=${padT + ih} x2=${width - padR} y2=${padT + ih} stroke="var(--border)" />
      <line x1=${padL} y1=${padT + ih / 2} x2=${width - padR} y2=${padT + ih / 2} stroke="var(--border)" stroke-dasharray="2 3" opacity="0.55" />
      <line x1=${padL} y1=${padT} x2=${width - padR} y2=${padT} stroke="var(--border)" stroke-dasharray="3 3" opacity="0.6" />
      <text x=${padL - 6} y=${padT + 4} text-anchor="end" fill="var(--text-3)" font-size="12">${valueLabel(max)}</text>
      <text x=${padL - 6} y=${padT + ih / 2 + 4} text-anchor="end" fill="var(--text-3)" font-size="12">${valueLabel(max / 2)}</text>
      <text x=${padL - 6} y=${height - padB + 4} text-anchor="end" fill="var(--text-3)" font-size="12">0</text>
      ${area ? html`<path d=${area} fill="color-mix(in srgb, ${tone} 12%, transparent)" />` : null}
      ${list.length ? html`<path d=${line} fill="none" stroke=${tone} stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />` : null}
      ${first ? html`<text x=${padL} y=${height - 3} fill="var(--text-3)" font-size="12">${first}</text>` : null}
      ${last ? html`<text x=${width - padR} y=${height - 3} text-anchor="end" fill="var(--text-3)" font-size="12">${last}</text>` : null}
    </svg>
  </div>`
}
