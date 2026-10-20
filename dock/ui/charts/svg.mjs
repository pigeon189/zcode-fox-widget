import { h } from '../vendor/preact.module.js'
import htm from '../vendor/htm.module.js'
import { fmtNum, fmtPct, hhmm } from '../lib/format.mjs'

const html = htm.bind(h)

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
  const width = 704
  if (list.length < 2) {
    return html`<div class="empty" style=${{ minHeight: height }}><span class="small">趋势点还不够（至少两次采样）</span></div>`
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
  return html`<svg class="chart" viewBox=${'0 0 ' + width + ' ' + height} preserveAspectRatio="none" role="img"
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
  </svg>`
}

export function ColumnChart({ data, height = 200, valueLabel = (v) => fmtNum(v) }) {
  const list = data || []
  const width = 704
  const max = Math.max(1, ...list.map((d) => Number(d.value) || 0))
  const padL = 40
  const padR = 12
  const padT = 12
  const padB = 28
  const iw = width - padL - padR
  const ih = height - padT - padB
  const slot = iw / Math.max(1, list.length)
  const barW = Math.max(6, Math.min(28, slot - 10))
  return html`<svg class="chart" viewBox=${'0 0 ' + width + ' ' + height} preserveAspectRatio="none" role="img" aria-label="每日用量柱图">
    ${[0, 0.5, 1].map((f) => html`<line x1=${padL} y1=${padT + ih * f} x2=${width - padR} y2=${padT + ih * f} stroke="var(--border)" />
      <text x=${padL - 6} y=${padT + ih * f + 3} text-anchor="end" fill="var(--text-3)" font-size="12">${f === 0 ? valueLabel(max) : f === 1 ? '0' : ''}</text>`)}
    ${list.map((d, i) => {
      const value = Number(d.value) || 0
      const h = (value > 0 ? value : 0) / max * ih
      const x = padL + slot * i + (slot - barW) / 2
      return html`<g>
        ${h > 0
          ? html`<rect x=${x} y=${padT + ih - h} width=${barW} height=${Math.max(1, h)} rx="4" fill=${d.today ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 45%, transparent)'}>
              <title>${d.label + '：' + valueLabel(value)}</title>
            </rect>`
          : null}
        <text x=${x + barW / 2} y=${height - 8} text-anchor="middle" fill=${d.today ? 'var(--text)' : 'var(--text-3)'} font-size="12">${d.label}</text>
      </g>`
    })}
  </svg>`
}

export function MiniBar({ pct, tone = '' }) {
  return html`<div class=${'progress ' + tone} role="img" aria-label=${'占用 ' + (Math.round((Number(pct) || 0) * 10) / 10) + '%'} style=${{ height: 6, minWidth: 80 }}>
    <span style=${{ width: clampPct(pct) + '%' }}></span>
  </div>`
}
