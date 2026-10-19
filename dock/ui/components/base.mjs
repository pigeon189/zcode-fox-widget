import { h } from '../vendor/preact.module.js'
import htm from '../vendor/htm.module.js'
import { Icon } from './icons.mjs'

const html = htm.bind(h)

export function Button({ variant = 'secondary', icon = '', children, loading = false, ...rest }) {
  return html`<button class=${'btn ' + variant} disabled=${rest.disabled || loading} ...${rest}>
    ${loading ? html`<${Icon} name="refresh" size=${14} />` : icon ? html`<${Icon} name=${icon} size=${16} />` : null}
    ${children}
  </button>`
}

export function IconButton({ icon, label, ...rest }) {
  return html`<button class="icon-btn" aria-label=${label} title=${label} ...${rest}><${Icon} name=${icon} size=${16} /></button>`
}

export function Card({ title = '', actions = null, class: cls = '', children, testid = '' }) {
  return html`<section class=${'card ' + cls} data-testid=${testid || undefined}>
    ${title ? html`<div class="card-head"><span class="card-title">${title}</span><span class="spacer"></span>${actions}</div>` : null}
    ${children}
  </section>`
}

export function Badge({ tone = 'neutral', children, title = '' }) {
  return html`<span class=${'badge ' + tone} title=${title || undefined}>${children}</span>`
}

export function Toggle({ checked, onChange, label, ariaLabel = '', disabled = false }) {
  return html`<label class="toggle">
    <input type="checkbox" aria-label=${ariaLabel || label || undefined} checked=${!!checked} disabled=${disabled} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span class="track"></span>
    ${label ? html`<span>${label}</span>` : null}
  </label>`
}

export function Input({ value, onInput, placeholder = '', type = 'text', class: cls = '', ...rest }) {
  return html`<input
    class=${'input ' + cls}
    type=${type}
    value=${value == null ? '' : value}
    placeholder=${placeholder}
    onInput=${(e) => onInput && onInput(e.currentTarget.value)}
    ...${rest}
  />`
}

export function Select({ value, options, onChange, class: cls = '', ...rest }) {
  return html`<select class=${'select ' + cls} value=${value} onChange=${(e) => onChange(e.currentTarget.value)} ...${rest}>
    ${options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
  </select>`
}

export function Segmented({ value, options, onChange, label = '视图' }) {
  return html`<div class="segmented" role="tablist" aria-label=${label}>
    ${options.map((o) => html`<button type="button" role="tab" aria-selected=${value === o.value} onClick=${() => onChange(o.value)}>
      ${o.dot ? html`<span class=${'dot ' + (o.dot === 'bad' ? 'offline' : '')}></span>` : null}${o.label}
    </button>`)}
  </div>`
}

export function ProgressBar({ pct, tone = '' }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0))
  return html`<div class=${'progress ' + tone} role="progressbar" aria-valuenow=${v} aria-valuemin="0" aria-valuemax="100">
    <span style=${{ width: v + '%' }}></span>
  </div>`
}

export function Stat({ label, value, sub = '', tone = '' }) {
  return html`<div class="card">
    <div class="stat-label">${label}</div>
    <div class="stat-value" style=${tone ? { color: 'var(--' + tone + ')' } : null}>${value}</div>
    ${sub ? html`<div class="stat-sub">${sub}</div>` : null}
  </div>`
}

export function EmptyState({ icon = 'info', title = '暂无数据', hint = '', action = null }) {
  return html`<div class="empty">
    <${Icon} name=${icon} size=${40} />
    <div class="title">${title}</div>
    ${hint ? html`<div class="hint">${hint}</div>` : null}
    ${action}
  </div>`
}

export function Skeleton({ height = 16, width = '100%' }) {
  return html`<div class="skeleton" style=${{ height: height + 'px', width }}></div>`
}

export function Dialog({ title, children, onClose, actions = null }) {
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose && onClose()}>
    <div class="dialog" role="dialog" aria-modal="true" aria-label=${title}>
      <h2>${title}</h2>
      ${children}
      <div class="actions">${actions || html`<${Button} onClick=${onClose}>关闭</${Button}>`}</div>
    </div>
  </div>`
}

export function Toasts({ items }) {
  return html`<div class="toast-wrap" aria-live="polite">
    ${items.map((t) => html`<div class=${'toast ' + (t.tone === 'bad' ? 'bad' : '')}>${t.text}</div>`)}
  </div>`
}

export function Field({ label, hint, children }) {
  return html`<div class="field">
    <label>${label}</label>
    ${children}
    ${hint ? html`<span class="small muted">${hint}</span>` : null}
  </div>`
}

export function SearchBox({ value, onInput, placeholder = '搜索…' }) {
  return html`<div class="row" style=${{ position: 'relative' }}>
    <span style=${{ position: 'absolute', left: 8, color: 'var(--text-3)', display: 'flex' }}><${Icon} name="search" size=${15} /></span>
    <input class="input search" style=${{ paddingLeft: 30 }} value=${value} placeholder=${placeholder} onInput=${(e) => onInput(e.currentTarget.value)} />
  </div>`
}

export function legendItems(items) {
  return html`<div class="legend">
    ${items.map((i) => html`<span><span class="swatch" style=${{ background: i.color }}></span>${i.label} ${i.value != null ? html`<span class="muted">${i.value}</span>` : null}</span>`)}
  </div>`
}
