import { h } from '../vendor/preact.module.js'
import { useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { fmtNum, fmtPct, fmtTokens, hhmm } from '../lib/format.mjs'

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

export function ColumnChart({ data, height = 200, valueLabel = (v) => fmtNum(v), details = null }) {
  const list = data || []
  const [hover, setHover] = useState(null)
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
  const active = hover != null ? list[hover] : null
  const activeRows = hover != null && Array.isArray(details) ? details[hover] || [] : []
  const barTop = active ? padT + ih - ((Number(active.value) || 0) / max) * ih : padT + ih
  const tipAbove = barTop > 78
  const tipLeft = hover == null ? 0 : ((padL + slot * hover + slot / 2) / width) * 100
  return html`<div class="chart-wrap">
    <svg class="chart" viewBox=${'0 0 ' + width + ' ' + height} preserveAspectRatio="none" role="img" aria-label="每日用量柱图"
      onMouseLeave=${() => setHover(null)}>
      ${[0, 0.5, 1].map((f) => html`<line x1=${padL} y1=${padT + ih * f} x2=${width - padR} y2=${padT + ih * f} stroke="var(--border)" />
        <text x=${padL - 6} y=${padT + ih * f + 3} text-anchor="end" fill="var(--text-3)" font-size="12">${f === 0 ? valueLabel(max) : f === 1 ? '0' : ''}</text>`)}
      ${hover != null
        ? html`<line x1=${padL + slot * hover + slot / 2} y1=${padT} x2=${padL + slot * hover + slot / 2} y2=${padT + ih}
            stroke="var(--text-3)" stroke-width="1" stroke-dasharray="3 3" opacity="0.8" />`
        : null}
      ${list.map((d, i) => {
        const value = Number(d.value) || 0
        const h = (value > 0 ? value : 0) / max * ih
        const x = padL + slot * i + (slot - barW) / 2
        return html`<g>
          ${h > 0
            ? html`<rect x=${x} y=${padT + ih - h} width=${barW} height=${Math.max(1, h)} rx="4"
                fill=${d.today ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 45%, transparent)'}>
                <title>${d.label + '：' + valueLabel(value)}</title>
              </rect>`
            : null}
          <text x=${x + barW / 2} y=${height - 8} text-anchor="middle" fill=${d.today ? 'var(--text)' : 'var(--text-3)'} font-size="12">${d.label}</text>
        </g>`
      })}
      ${list.map((d, i) => html`<rect x=${padL + slot * i} y=${padT} width=${slot} height=${ih}
        fill="transparent" pointer-events="all" onMouseEnter=${() => setHover(i)} />`)}
    </svg>
    ${active && activeRows.length
      ? html`<div class=${'chart-tip' + (tipAbove ? '' : ' below')} style=${{ left: 'clamp(140px, ' + tipLeft + '%, calc(100% - 140px))', top: (barTop / height) * 100 + '%' }}>
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
  const width = 704
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
  const yOf = (v) => padT + ih - (Math.max(0, Number(v) || 0) / maxY) * ih
  return html`<svg class="chart" viewBox=${'0 0 ' + width + ' ' + height} preserveAspectRatio="none" role="img"
    aria-label=${'每日 Token 趋势，' + rows.length + ' 个模型'}>
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
      const every = list.length > 14 ? (list.length > 45 ? 7 : 5) : 1
      let lastShown = -999
      return list.map((label, i) => {
        const isLast = i === list.length - 1
        if (!isLast && i % every !== 0) return null
        // 末尾标签离上一个太近就省略，避免 x 轴两个日期叠在一起。
        if (lastShown >= 0 && i - lastShown < Math.max(2, Math.floor(every * 0.7))) return null
        lastShown = i
        return html`<text x=${xOf(i)} y=${height - 8} text-anchor="middle" fill="var(--text-3)" font-size="12">${String(label).slice(5)}</text>`
      })
    })()}
  </svg>`
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
