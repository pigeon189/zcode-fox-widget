import { Component, Fragment, h } from '../vendor/preact.module.js'
import { useEffect, useRef, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Icon } from './icons.mjs'
import { UI_ICONS, UI_LABELS, normalizeProv, uiLabelOf } from '../../shared/provenance.mjs'

const html = htm.bind(h)

// 渲染错误兜底：任何一个页面渲染抛错都不能把整个控制台变成白屏。
// 页面级边界（console.mjs 按页 key）让侧栏、标题栏与其它页面继续可用；
// 顶层边界兜住 App 自身。错误同时进 window.__foxRenderErrors（环形）方便诊断包带走。
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
    this.reset = this.reset.bind(this)
  }
  static getDerivedStateFromError(error) {
    return { error: error || new Error('unknown render error') }
  }
  componentDidCatch(error, info) {
    try {
      const ring = (window.__foxRenderErrors = window.__foxRenderErrors || [])
      ring.push({
        at: Date.now(),
        where: String(this.props.where || ''),
        message: String((error && error.message) || error),
        stack: String((error && error.stack) || '').slice(0, 4000),
        componentStack: String((info && info.componentStack) || '').slice(0, 2000),
      })
      if (ring.length > 20) ring.shift()
      console.error('[fox-dock] 渲染异常（' + (this.props.where || '?') + '）', error, info)
    } catch (err) {}
  }
  reset() {
    this.setState({ error: null })
  }
  render() {
    const err = this.state.error
    if (!err) return this.props.children
    const detail = String(err.stack || err.message || err)
    return html`<div class="card" data-testid="page.crash" style=${{ margin: '0 0 16px' }}>
      <div class="card-head"><span class="card-title">这个页面渲染出错</span></div>
      <div class="small muted" style=${{ marginBottom: 8 }}>
        侧栏和其它页面仍可用；先「重新渲染」，仍然失败再「重新加载控制台」。
      </div>
      <pre
        class="small"
        style=${{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', margin: '0 0 12px', fontFamily: 'var(--font-mono)' }}
      >${detail.slice(0, 2000)}</pre>
      <div class="row" style=${{ gap: 8 }}>
        <${Button} onClick=${this.reset}>重新渲染</${Button}>
        <${Button} variant="ghost" onClick=${() => location.reload()}>重新加载控制台</${Button}>
        <${Button}
          variant="ghost"
          onClick=${() => {
            try {
              navigator.clipboard.writeText(detail)
            } catch (e) {}
          }}
        >复制错误</${Button}>
      </div>
    </div>`
  }
}

export function Button({ variant = 'secondary', icon = '', children, loading = false, ...rest }) {
  // disabled 必须最后展开：旧写法先算 disabled 再展开 rest，rest 里的
  // disabled=false 会把 loading 覆盖掉，慢请求期间可以重复提交。
  return html`<button class=${'btn ' + variant} ...${rest} disabled=${rest.disabled || loading}>
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

export function Toggle({ checked, onChange, label, ariaLabel = '', disabled = false, ...rest }) {
  // data-testid 等透传属性挂在外层 label 上（此前被静默丢弃，向导的
  // wizard.autostart 因此在 DOM 里找不到）。
  return html`<label class="toggle" ...${rest}>
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
    const desired = Math.min(list.length * 34 + 8, 300)
    // 弹层必须完整留在视口内：长列表靠内部滚动，不能上沿在屏里、下沿被裁掉。
    const maxH = Math.max(120, Math.min(desired, window.innerHeight - 16))
    let top = r.bottom + 4
    if (top + maxH > window.innerHeight - 8 && r.top - maxH - 4 >= 8) top = r.top - maxH - 4
    top = Math.max(8, Math.min(top, window.innerHeight - maxH - 8))
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    setPos({ left, top, width, maxH })
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
        // 只收起下拉，不能连带关掉外层 Dialog；Dialog 侧按 DOM 里的弹层判断。
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

  // 键盘移动活动项时把它滚进弹层可视区（长列表在 760 高窗口里会超出）。
  useEffect(() => {
    if (!open || !popRef.current) return
    const pop = popRef.current
    const el = pop.querySelectorAll('[role="option"]')[active]
    if (!el) return
    const top = el.offsetTop
    const bottom = top + el.offsetHeight
    if (top < pop.scrollTop) pop.scrollTop = top
    else if (bottom > pop.scrollTop + pop.clientHeight) pop.scrollTop = bottom - pop.clientHeight
  }, [active, open])

  function choose(option) {
    setOpen(false)
    // 选完把焦点还给触发器，后续 Tab 流程不会掉到 body。
    const el = triggerRef.current
    if (el) setTimeout(() => el.focus(), 0)
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
          style=${{ left: pos.left + 'px', top: pos.top + 'px', width: pos.width + 'px', maxHeight: pos.maxH + 'px' }}
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
          ${/* 用 mousemove 而不是 mouseenter：键盘上下移动会让选项在静止的
               指针下滚动，mouseenter 会把活动项抢回鼠标位置，连续按方向键
               就永远到不了列表末尾。只有指针真的移动才接受 hover。 */
            list.map(
            (o, i) => html`<button
              type="button"
              role="option"
              aria-selected=${String(o.value) === String(value)}
              class=${'select-option' + (i === active ? ' active' : '') + (String(o.value) === String(value) ? ' selected' : '')}
              onMouseMove=${() => setActive((a) => (a === i ? a : i))}
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

// 自绘日期选择：原生 <input type="date"> 的弹层由系统绘制，和设计令牌/暗色主题
// 对不上，而且在窄窗口下会溢出。这里用触发按钮 + fixed 日历弹层，键盘与焦点
// 行为按 WAI-ARIA 日历模式实现，不引入第三方库。
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function pad2(n) {
  return String(n).padStart(2, '0')
}

function keyOfDay(y, m, d) {
  return y + '-' + pad2(m) + '-' + pad2(d)
}

function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return { y, m: mo, d }
}

function todayKey() {
  const now = new Date()
  return keyOfDay(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

// 42 格（周一开头）的月视图；相邻月份的日期照常显示但淡化。
function monthCells(y, m) {
  const first = new Date(y, m - 1, 1)
  const offset = (first.getDay() + 6) % 7
  const start = new Date(y, m - 1, 1 - offset)
  const out = []
  for (let i = 0; i < 42; i++) {
    const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const yy = dt.getFullYear()
    const mm = dt.getMonth() + 1
    const dd = dt.getDate()
    out.push({ key: keyOfDay(yy, mm, dd), d: dd, outside: mm !== m || yy !== y })
  }
  return out
}

function inRange(key, min, max) {
  if (min && key < min) return false
  if (max && key > max) return false
  return true
}

function displayDay(key) {
  const p = parseDayKey(key)
  return p ? p.y + '-' + pad2(p.m) + '-' + pad2(p.d) : ''
}

export function DatePicker({
  value = '',
  onChange,
  min = '',
  max = '',
  ariaLabel = '选择日期',
  disabled = false,
  invalid = false,
  testid = '',
  class: cls = '',
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => {
    const p = parseDayKey(value) || parseDayKey(todayKey())
    return { y: p.y, m: p.m }
  })
  const [active, setActive] = useState(() => displayDay(value) || todayKey())
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const popRef = useRef(null)
  const idRef = useRef('')
  if (!idRef.current) idRef.current = 'dp-' + Math.random().toString(36).slice(2)
  const today = todayKey()
  const cells = monthCells(view.y, view.m)
  const activeKey = cells.some((c) => c.key === active) ? active : cells.find((c) => !c.outside)?.key || active

  function place() {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const width = 252
    const est = 254
    let top = r.bottom + 4
    if (top + est > window.innerHeight - 8) {
      top = r.top - est - 4 >= 8 ? r.top - est - 4 : Math.max(8, window.innerHeight - est - 8)
    }
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    setPos({ left, top })
  }

  function openPicker() {
    if (disabled) return
    const candidate = displayDay(value) || today
    let start = candidate
    if (!inRange(start, min, max)) {
      if (inRange(today, min, max)) start = today
      else if (min && today < min) start = min
      else if (max) start = max
    }
    const p = parseDayKey(start) || parseDayKey(today)
    setView({ y: p.y, m: p.m })
    setActive(keyOfDay(p.y, p.m, p.d))
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    place()
    const el = triggerRef.current
    const onDown = (e) => {
      if ((el && el.contains(e.target)) || (popRef.current && popRef.current.contains(e.target))) return
      setOpen(false)
    }
    const onScroll = () => place()
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    const raf = requestAnimationFrame(() => {
      if (popRef.current) popRef.current.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function close(refocus = true) {
    setOpen(false)
    if (refocus && triggerRef.current) triggerRef.current.focus()
  }

  function pick(key) {
    if (!inRange(key, min, max)) return
    if (onChange) onChange(key)
    close()
  }

  function goMonth(delta) {
    const p = parseDayKey(activeKey) || parseDayKey(today)
    const dt = new Date(p.y, p.m - 1 + delta, Math.min(p.d, 28))
    const first = keyOfDay(dt.getFullYear(), dt.getMonth() + 1, 1)
    const last = keyOfDay(dt.getFullYear(), dt.getMonth() + 1, new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate())
    if ((delta > 0 && max && first > max) || (delta < 0 && min && last < min)) return
    setView({ y: dt.getFullYear(), m: dt.getMonth() + 1 })
    setActive(keyOfDay(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()))
  }

  function goDay(days) {
    const p = parseDayKey(activeKey)
    if (!p) return
    const dt = new Date(p.y, p.m - 1, p.d + days)
    const key = keyOfDay(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
    if (!inRange(key, min, max)) return
    setView({ y: dt.getFullYear(), m: dt.getMonth() + 1 })
    setActive(key)
  }

  function onKeyDown(e) {
    // 焦点在“上个月/下个月”按钮上时，Enter/Space 交给按钮自己处理，避免同时选中日期。
    if (e.target !== popRef.current && (e.key === 'Enter' || e.key === ' ')) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      goDay(-1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      goDay(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      goDay(-7)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      goDay(7)
    } else if (e.key === 'Home') {
      e.preventDefault()
      const p = parseDayKey(activeKey)
      if (p) {
        const offset = (new Date(p.y, p.m - 1, p.d).getDay() + 6) % 7
        goDay(-offset)
      }
    } else if (e.key === 'End') {
      e.preventDefault()
      const p = parseDayKey(activeKey)
      if (p) {
        const offset = (new Date(p.y, p.m - 1, p.d).getDay() + 6) % 7
        goDay(6 - offset)
      }
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      goMonth(-1)
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      goMonth(1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(activeKey)
    } else if (e.key === 'Tab') {
      // 关闭时把焦点还给触发按钮，不能落到 body（规格：关闭后回到触发按钮）。
      e.preventDefault()
      close()
    }
  }

  const shown = displayDay(value)
  const rows = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  const monthStart = keyOfDay(view.y, view.m, 1)
  const monthEnd = keyOfDay(view.y, view.m, new Date(view.y, view.m, 0).getDate())
  const prevDisabled = !!(min && monthStart <= min)
  const nextDisabled = !!(max && monthEnd >= max)

  return html`<span class=${'date-picker ' + cls}>
    <button
      ref=${triggerRef}
      type="button"
      class=${'dp-trigger' + (invalid ? ' invalid' : '')}
      disabled=${disabled}
      aria-label=${ariaLabel + ' ' + (shown || '选择日期')}
      aria-haspopup="dialog"
      aria-expanded=${open}
      aria-invalid=${invalid ? 'true' : undefined}
      data-testid=${testid || undefined}
      onClick=${() => (open ? close() : openPicker())}
    >
      <span class=${'dp-value' + (shown ? '' : ' empty')}>${shown || '选择日期'}</span>
      <${Icon} name="calendar" size=${15} />
    </button>
    ${open && pos
      ? html`<div
          ref=${popRef}
          class="dp-pop"
          role="dialog"
          aria-modal="true"
          aria-label=${ariaLabel + '，日历'}
          aria-activedescendant=${idRef.current + '-' + activeKey}
          tabindex="-1"
          style=${{ left: pos.left + 'px', top: pos.top + 'px' }}
          onKeyDown=${onKeyDown}
        >
          <div class="dp-head">
            <button type="button" class="dp-nav prev" aria-label="上个月" disabled=${prevDisabled} onClick=${() => goMonth(-1)}>
              <${Icon} name="chevron" size=${16} />
            </button>
            <span class="dp-title" aria-live="polite">${view.y}年${view.m}月</span>
            <button type="button" class="dp-nav next" aria-label="下个月" disabled=${nextDisabled} onClick=${() => goMonth(1)}>
              <${Icon} name="chevron" size=${16} />
            </button>
          </div>
          <div class="dp-weekdays" aria-hidden="true">
            ${WEEKDAYS.map((w) => html`<span class="dp-weekday">${w}</span>`)}
          </div>
          <div class="dp-grid" role="grid" aria-label=${view.y + '年' + view.m + '月'}>
            ${rows.map(
              (row) => html`<div class="dp-row" role="row">
                ${row.map((c) => {
                  const selected = shown === c.key
                  const isToday = c.key === today
                  const dayDisabled = !inRange(c.key, min, max)
                  return html`<button
                    type="button"
                    role="gridcell"
                    id=${idRef.current + '-' + c.key}
                    class=${'dp-day' + (c.outside ? ' outside' : '') + (isToday ? ' today' : '') + (activeKey === c.key ? ' active' : '')}
                    aria-label=${c.d + ' 日 ' + c.key + (isToday ? '，今天' : '')}
                    aria-selected=${selected}
                    aria-current=${isToday ? 'date' : undefined}
                    disabled=${dayDisabled}
                    onClick=${() => pick(c.key)}
                    onMouseEnter=${() => setActive(c.key)}
                  ><span aria-hidden="true">${c.d}</span></button>`
                })}
              </div>`
            )}
          </div>
        </div>`
      : null}
  </span>`
}

export function Segmented({ value, options, onChange, label = '视图' }) {
  return html`<div class="segmented" role="tablist" aria-label=${label}>
    ${options.map((o) => html`<button type="button" role="tab" aria-selected=${value === o.value} onClick=${() => onChange(o.value)}>
      ${o.dot ? html`<span class=${'dot ' + (o.dot === 'bad' ? 'offline' : '')}></span>` : null}${o.label}
    </button>`)}
  </div>`
}

export function ProgressBar({ pct, tone = '', label = '' }) {
  // 不可得不能画成 0%：0% 会被读成「额度耗尽/上下文为空」。缺失时保留
  // 占位条但去掉 progressbar 语义，读屏与视觉都明确是「暂不可得」。
  const known = pct != null && pct !== '' && Number.isFinite(Number(pct))
  if (!known) {
    return html`<div class=${'progress unavailable ' + tone} role="img" aria-label=${(label || '进度') + '：暂不可得'}>
      <span style=${{ width: '0%' }}></span>
    </div>`
  }
  const v = Math.max(0, Math.min(100, Number(pct)))
  return html`<div class=${'progress ' + tone} role="progressbar" aria-label=${label || '进度'} aria-valuenow=${v} aria-valuemin="0" aria-valuemax="100">
    <span style=${{ width: v + '%' }}></span>
  </div>`
}

function clockText(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '未知'
  try {
    return new Date(n).toLocaleTimeString('zh-CN', { hour12: false })
  } catch (err) {
    return '未知'
  }
}

// 可信度标签（D033）。kind 可直接传 UI 标签（official/local/estimate/unavailable）
// 或完整 provenance；两种写法都归一到四标签。
export function SourceTag({ kind = '', prov = null, source = '', asOf = 0, note = '', variant = 'full', label = '' }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const timer = useRef(null)
  const normalized = normalizeProv(prov || (kind ? { kind: provKindOf(kind), origin: provOriginOf(kind), source, asOf, note } : null))
  const ui = UI_LABELS[kind] ? kind : uiLabelOf(normalized)
  const shownSource = normalized.source || source || '未声明数据源'
  const shownNote = normalized.note || note || (ui === 'estimate' ? '按可得数据推算' : '')
  const full = variant !== 'dot'

  function place(show) {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!show) {
      setOpen(false)
      return
    }
    timer.current = setTimeout(() => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const width = Math.min(280, window.innerWidth - 16)
      let left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left))
      let top = r.bottom + 6
      if (top + 92 > window.innerHeight - 8 && r.top - 98 >= 8) top = r.top - 98
      setPos({ left, top, width })
      setOpen(true)
    }, 150)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const content = full
    ? html`<span class=${'source-tag full prov-' + ui} ref=${ref} tabIndex="0"
        onMouseEnter=${() => place(true)} onMouseLeave=${() => place(false)}
        onFocus=${() => place(true)} onBlur=${() => place(false)}
        aria-label=${'数据来源：' + (label || UI_LABELS[ui])}>
        <${Icon} name=${UI_ICONS[ui]} size=${12} /><span>${label || UI_LABELS[ui]}</span>
      </span>`
    : html`<span class=${'source-tag dot prov-' + ui} ref=${ref} role="img" tabIndex="0"
        onMouseEnter=${() => place(true)} onMouseLeave=${() => place(false)}
        onFocus=${() => place(true)} onBlur=${() => place(false)}
        aria-label=${'数据来源：' + (label || UI_LABELS[ui])}>
        <${Icon} name=${UI_ICONS[ui]} size=${12} />
      </span>`

  return html`<${Fragment}>
    ${content}
    ${open && pos
      ? html`<div class="source-pop" role="tooltip" style=${{ left: pos.left + 'px', top: pos.top + 'px', width: pos.width + 'px' }}>
          <div><b>来源：</b>${shownSource}</div>
          <div><b>读取：</b>${clockText(normalized.asOf || asOf)}</div>
          <div><b>说明：</b>${shownNote || UI_LABELS[ui]}</div>
        </div>`
      : null}
  </${Fragment}>`
}

function provKindOf(label) {
  if (label === 'official' || label === 'local') return 'exact'
  if (label === 'estimate') return 'estimated'
  return 'unavailable'
}

function provOriginOf(label) {
  if (label === 'official') return 'api'
  if (label === 'local') return 'local-log'
  if (label === 'estimate') return 'pricing-table'
  return 'unknown'
}

export function Stat({ label, value, sub = '', tone = '', prov = null }) {
  return html`<div class="card">
    <div class="stat-label"><span>${label}</span>${prov ? html`<${SourceTag} prov=${prov} variant="dot" />` : null}</div>
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
        // 内层下拉/日期弹层打开时，Esc 先收起它们；不能把整个表单一起关掉。
        if (document.querySelector('.select-pop, .dp-pop')) return
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

export function SearchBox({ value, onInput, placeholder = '搜索…', testid = '' }) {
  return html`<div class="row" style=${{ position: 'relative' }}>
    <span style=${{ position: 'absolute', left: 8, color: 'var(--text-3)', display: 'flex' }}><${Icon} name="search" size=${15} /></span>
    <input class="input search" type="search" aria-label=${placeholder} data-testid=${testid || undefined} style=${{ paddingLeft: 30 }} value=${value} placeholder=${placeholder} onInput=${(e) => onInput(e.currentTarget.value)} />
  </div>`
}

export function legendItems(items) {
  return html`<div class="legend">
    ${items.map((i) => html`<span><span class="swatch" style=${{ background: i.color }}></span>${i.label} ${i.value != null ? html`<span class="muted">${i.value}</span>` : null}</span>`)}
  </div>`
}
