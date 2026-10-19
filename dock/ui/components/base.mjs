import { h } from '../vendor/preact.module.js'
import { useEffect, useRef, useState } from '../vendor/hooks.module.js'
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

// 自绘下拉：原生 <select> 的弹出层是系统控件，样式不可控，而且在设置页
// 靠近窗口边缘时会让内容区滚动/漂移。这里用触发按钮 + fixed 弹出层，
// 样式与其余控件一致，也不会改变页面布局。
export function Select({ value, options = [], onChange, class: cls = '', label = '', ariaLabel = '', disabled = false, ...rest }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const popRef = useRef(null)
  const list = Array.isArray(options) ? options : []
  const current = list.find((o) => String(o.value) === String(value))
  const currentLabel = current ? current.label : value == null ? '' : String(value)

  function place() {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const width = Math.max(r.width, 168)
    const est = Math.min(list.length * 34 + 8, 300)
    let top = r.bottom + 4
    if (top + est > window.innerHeight - 8 && r.top - est - 4 >= 8) top = r.top - est - 4
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    setPos({ left, top, width })
  }

  useEffect(() => {
    if (!open) return
    const idx = list.findIndex((o) => String(o.value) === String(value))
    setActive(idx >= 0 ? idx : 0)
    place()
    const el = triggerRef.current
    const onDown = (e) => {
      if ((el && el.contains(e.target)) || (popRef.current && popRef.current.contains(e.target))) return
      setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        if (el) el.focus()
      }
    }
    const onScroll = () => place()
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    const raf = requestAnimationFrame(() => {
      if (popRef.current) popRef.current.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value])

  function choose(option) {
    setOpen(false)
    if (onChange && String(option.value) !== String(value)) onChange(option.value)
  }

  return html`<div class="select-wrap">
    <button
      ref=${triggerRef}
      type="button"
      class=${'select-trigger ' + cls}
      disabled=${disabled}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded=${open}
      aria-label=${ariaLabel || label || undefined}
      onClick=${() => setOpen(!open)}
      onKeyDown=${(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          setOpen(true)
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setOpen(!open)
        }
      }}
      ...${rest}
    >
      <span class="select-value">${currentLabel}</span>
      <${Icon} name="chevron" size=${14} />
    </button>
    ${open && pos
      ? html`<div
          ref=${popRef}
          class="select-pop"
          role="listbox"
          tabindex="-1"
          style=${{ left: pos.left + 'px', top: pos.top + 'px', width: pos.width + 'px' }}
          onKeyDown=${(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(list.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const option = list[active]
              if (option) choose(option)
            } else if (e.key === 'Tab') {
              setOpen(false)
            }
          }}
        >
          ${list.map(
            (o, i) => html`<button
              type="button"
              role="option"
              aria-selected=${String(o.value) === String(value)}
              class=${'select-option' + (i === active ? ' active' : '') + (String(o.value) === String(value) ? ' selected' : '')}
              onMouseEnter=${() => setActive(i)}
              onClick=${() => choose(o)}
            >
              ${o.label}
            </button>`
          )}
        </div>`
      : null}
  </div>`
}

// 自绘复选框：导入向导里的原生 checkbox 太廉价，且各浏览器外观不一致。
export function Checkbox({ checked, onChange, label = '', ariaLabel = '', disabled = false, children }) {
  return html`<label class=${'check-row' + (disabled ? ' disabled' : '')}>
    <input type="checkbox" aria-label=${ariaLabel || label || undefined} checked=${!!checked} disabled=${disabled}
      onChange=${(e) => onChange && onChange(e.currentTarget.checked)} />
    <span class="check-box" aria-hidden="true"><${Icon} name="check" size=${12} /></span>
    ${children || label ? html`<span class="check-label">${children || label}</span>` : null}
  </label>`
}

export function Segmented({ value, options, onChange, label = '视图' }) {
  return html`<div class="segmented" role="tablist" aria-label=${label}>
    ${options.map((o) => html`<button type="button" role="tab" aria-selected=${value === o.value} onClick=${() => onChange(o.value)}>
      ${o.dot ? html`<span class=${'dot ' + (o.dot === 'bad' ? 'offline' : '')}></span>` : null}${o.label}
    </button>`)}
  </div>`
}

export function ProgressBar({ pct, tone = '', label = '' }) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0))
  return html`<div class=${'progress ' + tone} role="progressbar" aria-label=${label || '进度'} aria-valuenow=${v} aria-valuemin="0" aria-valuemax="100">
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
  const ref = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    const el = ref.current
    const focusables = () =>
      Array.from(el ? el.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])') : []).filter(
        (x) => !x.disabled && x.offsetParent !== null
      )
    const first = focusables()[0]
    if (first) first.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (onClose) onClose()
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (!list.length) return
      const idx = list.indexOf(document.activeElement)
      if (e.shiftKey) {
        if (idx <= 0) {
          e.preventDefault()
          list[list.length - 1].focus()
        }
      } else if (idx === list.length - 1 || idx === -1) {
        e.preventDefault()
        list[0].focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous && typeof previous.focus === 'function') previous.focus()
    }
  }, [])
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose && onClose()}>
    <div class="dialog" ref=${ref} role="dialog" aria-modal="true" aria-label=${title}>
      <h2>${title}</h2>
      ${children}
      <div class="actions">${actions || html`<${Button} onClick=${onClose}>关闭</${Button}>`}</div>
    </div>
  </div>`
}

export function Toasts({ items }) {
  return html`<div class="toast-wrap" role="status" aria-live="polite">
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
    <input class="input search" aria-label=${placeholder} style=${{ paddingLeft: 30 }} value=${value} placeholder=${placeholder} onInput=${(e) => onInput(e.currentTarget.value)} />
  </div>`
}

export function legendItems(items) {
  return html`<div class="legend">
    ${items.map((i) => html`<span><span class="swatch" style=${{ background: i.color }}></span>${i.label} ${i.value != null ? html`<span class="muted">${i.value}</span>` : null}</span>`)}
  </div>`
}
