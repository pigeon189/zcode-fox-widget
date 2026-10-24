import { h } from '../vendor/preact.module.js'
import { useEffect, useRef, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Button, Card, EmptyState, IconButton, SearchBox, Segmented, Select, SourceTag } from '../components/base.mjs'
import { Sparkline, StatusTimeline } from '../charts/svg.mjs'
import { Icon } from '../components/icons.mjs'
import {
  agentName,
  fmtCredit,
  fmtDuration,
  fmtMoney,
  fmtNum,
  fmtPct,
  fmtRelativeShort,
  fmtTokens,
  sessionStatusLabel,
} from '../lib/format.mjs'
import { ContextPanel } from './context.mjs'

const html = htm.bind(h)

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'working', label: '工作中' },
  { value: 'waiting_permission', label: '等待确认' },
  { value: 'waiting_input', label: '等待输入' },
  { value: 'error', label: '出错' },
  { value: 'done', label: '已完成' },
  { value: 'idle', label: '空闲' },
]
const SORT_OPTIONS = [
  { value: 'updated', label: '最近更新' },
  { value: 'tokens', label: '消耗最高' },
  { value: 'cost', label: '成本最高' },
  { value: 'duration', label: '耗时最长' },
]
const TABS = [
  { value: 'overview', label: '概览' },
  { value: 'turns', label: '回合' },
  { value: 'tools', label: '工具' },
  { value: 'context', label: '上下文' },
]
// 一页只取 25 个根会话；子会话跟随父会话一起返回，不占分页。
const PAGE_SIZE = 25
const ARCHIVED_OPTIONS = [
  { value: 'exclude', label: '当前' },
  { value: 'only', label: '已归档' },
  { value: 'all', label: '全部' },
]
const ARCHIVED_VALUES = ARCHIVED_OPTIONS.map((o) => o.value)

function archivedOf(value) {
  return ARCHIVED_VALUES.includes(value) ? value : 'exclude'
}

function listQuery({ agent, status, sort, q, archived, cursor, limit = PAGE_SIZE }) {
  const qs = new URLSearchParams({ limit: String(limit), sort })
  if (agent) qs.set('agent', agent)
  if (status) qs.set('status', status)
  if (q) qs.set('q', q)
  if (archived && archived !== 'exclude') qs.set('archived', archived)
  // 「全部/已归档」要看历史：默认 30 天窗口会把旧归档挡掉。
  if (archived === 'only' || archived === 'all') qs.set('range', 'all')
  if (cursor) qs.set('cursor', cursor)
  return '/v1/sessions?' + qs.toString()
}

function mergeSessions(prev, next) {
  const map = new Map(prev.map((s) => [s.key, s]))
  for (const s of next) map.set(s.key, s)
  return [...map.values()]
}

function hashQuery() {
  const raw = String(location.hash || '').replace(/^#/, '')
  const idx = raw.indexOf('?')
  return new URLSearchParams(idx >= 0 ? raw.slice(idx + 1) : '')
}

function replaceHash(values) {
  const q = new URLSearchParams(values)
  const qs = q.toString()
  history.replaceState(null, '', '#sessions' + (qs ? '?' + qs : ''))
}

function statusDot(s) {
  return html`<span class=${'status-dot ' + (s || 'unknown')} aria-hidden="true"></span>`
}

function StatusMark({ status }) {
  if (status === 'working') return html`<span class="spin" aria-hidden="true"></span>`
  return statusDot(status)
}

function costText(session) {
  const c = session && session.cost
  if (!c) return '—'
  if (c.unit === 'credit' || c.currency === 'CREDIT') return fmtCredit(c.amount)
  return fmtMoney(c.amount, c.currency)
}

function durationMs(session) {
  if (!session || !session.startedAt) return 0
  return Math.max(0, (Number(session.updatedAt) || 0) - (Number(session.startedAt) || 0))
}

function shortModel(model) {
  const s = String(model || '')
  if (!s) return ''
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

function cwdTail(cwd) {
  const s = String(cwd || '').replace(/\\/g, '/')
  if (!s) return ''
  return s.split('/').filter(Boolean).slice(-2).join('/')
}

export function SessionsPage({ app }) {
  const initial = hashQuery()
  const [items, setItems] = useState([])
  const [counts, setCounts] = useState({})
  const [aggregate, setAggregate] = useState('idle')
  const [rootTotal, setRootTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState(null)
  const [truncated, setTruncated] = useState(false)
  const [q, setQ] = useState(initial.get('q') || '')
  const [debouncedQ, setDebouncedQ] = useState(q)
  const [status, setStatus] = useState(initial.get('status') || '')
  const [sort, setSort] = useState(initial.get('sort') || 'updated')
  const [archived, setArchived] = useState(() => archivedOf(initial.get('archived') || 'exclude'))
  const [selected, setSelected] = useState(initial.get('select') || '')
  const [tab, setTab] = useState(TABS.some((t) => t.value === initial.get('tab')) ? initial.get('tab') : 'overview')
  const [expanded, setExpanded] = useState(() => new Set())
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [focusIndex, setFocusIndex] = useState(0)
  const scrollRef = useRef(null)

  const agent = app.view === 'follow' ? '' : app.viewAgent
  const isKimi = (agent || app.viewAgent) === 'kimi'
  // 归档只有 ZCode 有真实语义；只看 WorkBuddy/Kimi/dsh 时不显示该筛选。
  const showArchived = !agent || agent === 'zcode'
  const archivedMode = showArchived ? archived : 'exclude'
  const now = Date.now()

  const queryState = { agent, status, sort, q: debouncedQ.trim(), archived: archivedMode }
  const filterKey = [agent, status, archivedMode, sort, debouncedQ.trim()].join('\u0000')
  const filterRef = useRef(filterKey)
  filterRef.current = filterKey
  const stateRef = useRef(queryState)
  stateRef.current = queryState
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const pageCountRef = useRef(0)
  const reqRef = useRef(0)
  const mountedRef = useRef(false)
  const liveTimerRef = useRef(null)

  useEffect(() => {
    function onHash() {
      const h = hashQuery()
      if (h.has('select')) setSelected(h.get('select') || '')
      if (h.has('tab')) {
        const t = h.get('tab')
        setTab(TABS.some((x) => x.value === t) ? t : 'overview')
      }
      if (h.has('q')) setQ(h.get('q') || '')
      if (h.has('status')) setStatus(h.get('status') || '')
      if (h.has('sort')) setSort(h.get('sort') || 'updated')
      if (h.has('archived')) setArchived(archivedOf(h.get('archived')))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 220)
    return () => clearTimeout(t)
  }, [q])

  // 切到没有归档语义的宿主时，把隐藏的归档筛选复位，避免空列表。
  useEffect(() => {
    if (!showArchived && archived !== 'exclude') setArchived('exclude')
  }, [showArchived, archived])

  // 筛选/排序/视角/归档变化：清空列表并只取第一页。
  useEffect(() => {
    let alive = true
    const gen = ++reqRef.current
    const key = filterKey
    pageCountRef.current = 0
    setItems([])
    setNextCursor(null)
    setRootTotal(0)
    setTruncated(false)
    setFocusIndex(0)
    setLoading(true)
    setError('')
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    app
      .api(listQuery({ ...stateRef.current, cursor: null }))
      .then((d) => {
        if (!alive || gen !== reqRef.current || key !== filterRef.current) return
        const list = Array.isArray(d.items) ? d.items : []
        pageCountRef.current = 1
        setItems(list)
        setNextCursor(d.nextCursor || null)
        setCounts(d.counts || {})
        setAggregate(d.aggregate || 'idle')
        setRootTotal(d.rootTotal == null ? Number(d.total) || list.length : Number(d.rootTotal))
        setTruncated(d.truncated === true)
        if (selectedRef.current) {
          if (!list.some((s) => s.key === selectedRef.current)) setSelected('')
        } else if (list[0]) {
          select(list[0].key, false)
        }
      })
      .catch((e) => alive && gen === reqRef.current && setError(String(e.message || e)))
      .finally(() => alive && gen === reqRef.current && setLoading(false))
    return () => {
      alive = false
    }
  }, [filterKey])

  // 15 秒轮询 / SSE：在顶部且只有一页时轻量重取第一页；否则只更新计数，
  // 绝不重建滚动容器（旧实现每次 liveTick 都整表重取，滚动会被拽回末尾）。
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    softRefresh()
  }, [app.refreshAt])

  useEffect(() => {
    if (!mountedRef.current) return
    if (pageCountRef.current === 0) return
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
    liveTimerRef.current = setTimeout(() => {
      liveTimerRef.current = null
      softRefresh()
    }, 300)
    return () => {
      if (liveTimerRef.current) {
        clearTimeout(liveTimerRef.current)
        liveTimerRef.current = null
      }
    }
  }, [app.liveTick])

  async function softRefresh() {
    if (pageCountRef.current === 0) return
    const snap = stateRef.current
    const key = [snap.agent, snap.status, snap.archived, snap.sort, snap.q].join('\u0000')
    if (filterRef.current !== key) return
    const el = scrollRef.current
    const atTop = !el || el.scrollTop < 8
    const firstPage = pageCountRef.current <= 1
    const size = atTop && firstPage ? PAGE_SIZE : 1
    try {
      const d = await app.api(listQuery({ ...snap, cursor: null, limit: size }))
      if (filterRef.current !== key) return
      setCounts(d.counts || {})
      setAggregate(d.aggregate || 'idle')
      const total = Number(d.rootTotal)
      if (Number.isFinite(total)) setRootTotal(total)
      else if (Number.isFinite(Number(d.total))) setRootTotal(Number(d.total))
      if (d.truncated === true) setTruncated(true)
      if (!atTop || !firstPage) return
      // 只在用户没有滚动且没有加载更多页时替换第一页，保持 scrollTop 不变。
      const list = Array.isArray(d.items) ? d.items : []
      setItems(list)
      setNextCursor(d.nextCursor || null)
      if (selectedRef.current && !list.some((s) => s.key === selectedRef.current)) setSelected('')
    } catch (err) {}
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    const key = filterRef.current
    setLoadingMore(true)
    setError('')
    try {
      const d = await app.api(listQuery({ ...stateRef.current, cursor: nextCursor }))
      if (key !== filterRef.current) return
      const page = Array.isArray(d.items) ? d.items : []
      pageCountRef.current += 1
      setItems((prev) => mergeSessions(prev, page))
      setNextCursor(d.nextCursor || null)
      if (d.counts) setCounts(d.counts)
      if (d.aggregate) setAggregate(d.aggregate)
      const total = Number(d.rootTotal)
      if (Number.isFinite(total)) setRootTotal(total)
      else if (Number.isFinite(Number(d.total))) setRootTotal(Number(d.total))
      if (d.truncated === true) setTruncated(true)
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    let alive = true
    app
      .api('/v1/sessions/' + encodeURIComponent(selected))
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetail(null))
    return () => {
      alive = false
    }
  }, [selected, app.refreshAt, app.liveTick])

  // 键盘移动焦点时把行带入视口；只在 focusIndex 变化时执行，避免数据刷新拽动滚动。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const row = el.querySelector('.sess-row.focused')
    if (!row) return
    const r = row.getBoundingClientRect()
    const c = el.getBoundingClientRect()
    if (r.top < c.top) el.scrollTop += r.top - c.top
    else if (r.bottom > c.bottom) el.scrollTop += r.bottom - c.bottom
  }, [focusIndex])

  useEffect(() => {
    const values = { tab }
    if (selected) values.select = selected
    if (status) values.status = status
    if (sort && sort !== 'updated') values.sort = sort
    if (archivedMode && archivedMode !== 'exclude') values.archived = archivedMode
    replaceHash(values)
  }, [selected, tab, status, sort, archivedMode])

  function select(key, update = true) {
    setSelected(key)
    if (update) setTab('overview')
    if (update) setFocusIndex(0)
  }

  function clearFilters() {
    setQ('')
    setStatus('')
    setSort('updated')
    setArchived('exclude')
    setSelected('')
  }

  // 父/子分组：parentKey 指向本页列表里存在的会话才嵌套。
  const byKey = new Map(items.map((s) => [s.key, s]))
  const children = new Map()
  const roots = []
  for (const s of items) {
    if (s.parentKey && byKey.has(s.parentKey)) {
      const list = children.get(s.parentKey) || []
      list.push(s)
      children.set(s.parentKey, list)
    } else roots.push(s)
  }
  const visible = []
  for (const s of roots) {
    visible.push({ session: s, depth: 0 })
    if (expanded.has(s.key)) for (const c of children.get(s.key) || []) visible.push({ session: c, depth: 1 })
  }
  const shown = visible
  const loadedRoots = roots.length
  const current = detail && detail.session ? detail.session : byKey.get(selected) || null
  const pending = items.flatMap((s) => (s.pending || []).map((p) => ({ ...p, agentId: s.agentId, sessionKey: s.key })))
  const waitingCount = Number(counts.waiting_permission != null ? counts.waiting_permission : counts.waiting) || 0
  const pendingCount = Math.max(waitingCount, pending.length)
  const kimiEmpty = isKimi && !items.length

  function onKeyDown(e) {
    if (!visible.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIndex((i) => Math.min(visible.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setFocusIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setFocusIndex(visible.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = visible[focusIndex]
      if (row) select(row.session.key)
    }
  }

  async function focusHost() {
    if (!current) return
    try {
      const r = await app.api('/v1/sessions/' + encodeURIComponent(current.key) + '/focus', { method: 'POST', body: {} })
      if (r.method === 'flash') app.toast('已提醒 ' + agentName(current.agentId) + ' 窗口（系统限制，未能直接切换）')
      else app.toast('已切换到 ' + agentName(current.agentId))
    } catch (e) {
      app.toast(e.status === 404 ? '没有找到宿主窗口' : String(e.message || e), 'bad')
    }
  }

  async function copyId() {
    if (!current) return
    try {
      await navigator.clipboard.writeText(current.sessionId || current.key)
      app.toast('已复制会话 ID')
    } catch (e) {
      app.toast('复制失败', 'bad')
    }
  }

  return html`<div data-testid="page.sessions">
    ${pendingCount > 0
      ? html`<div class="banner-warn" style=${{ marginBottom: 16 }}>
          <${Icon} name="alert" size=${18} />
          <div>
            <div class="banner-text">${pendingCount} 个权限请求等待处理</div>
            <div class="banner-sub">${pending[0] ? agentName(pending[0].agentId) + ' · ' + (pending[0].tool || '工具') : '打开宿主窗口确认或拒绝'}</div>
          </div>
          <div class="banner-actions">
            <${Button} variant="ghost" icon="externalLink" onClick=${focusHost}>去宿主处理</${Button}>
          </div>
        </div>`
      : null}

    <${Card} class="live-strip" testid="sessions.strip">
      ${[
        { key: 'working', label: '工作中', count: counts.working || 0, status: 'working' },
        { key: 'waiting', label: '等待确认', count: (counts.waiting_permission != null ? counts.waiting_permission : counts.waiting) || 0, status: 'waiting_permission' },
        { key: 'error', label: '出错', count: counts.error || 0, status: 'error' },
        { key: 'done', label: '已完成', count: counts.done || 0, status: 'done' },
      ].map(
        (tile) => html`<button type="button" class="live-tile" role="button" aria-pressed=${status === tile.status}
          onClick=${() => setStatus(status === tile.status ? '' : tile.status)} data-testid=${'sessions.tile.' + tile.key}>
          ${tile.key === 'working' && tile.count > 0 ? html`<span class="spin" aria-hidden="true"></span>` : statusDot(tile.status)}
          <span class="live-label">${tile.label}</span>
          <span class="live-count num">${tile.count}</span>
        </button>`
      )}
    </${Card}>

    ${error ? html`<div class="alert-bar bad" style=${{ marginTop: 12 }}>${error}</div>` : null}

    <div class="sessions-layout" style=${{ marginTop: 16 }}>
      <${Card} title="会话" actions=${html`<span class="small muted">共 ${rootTotal} 个 · 已显示 ${loadedRoots} 个</span>`} testid="sessions.list">
        <div class="sess-toolbar">
          <${SearchBox} value=${q} onInput=${setQ} placeholder="搜索标题 / 路径 / 模型" />
          <${Select} value=${status} options=${STATUS_OPTIONS} onChange=${setStatus} ariaLabel="状态筛选" />
          ${showArchived
            ? html`<${Select} value=${archived} options=${ARCHIVED_OPTIONS} onChange=${setArchived} ariaLabel="归档筛选" data-testid="sessions.archived" />`
            : null}
          <${Select} value=${sort} options=${SORT_OPTIONS} onChange=${setSort} ariaLabel="排序" />
        </div>
        ${loading && !items.length
          ? html`<div class="sess-loading small muted">正在加载会话…</div>`
          : !items.length
          ? html`<${EmptyState}
              icon="sessions"
              title=${kimiEmpty ? 'Kimi Code 没有会话历史' : archived === 'only' ? '没有已归档的会话' : status || q ? '没有符合条件的会话' : '还没有会话记录'}
              hint=${kimiEmpty
                ? 'Kimi Code 只提供套餐窗口和上下文占用，不提供会话历史。'
                : archived === 'only'
                  ? '归档会话只有 ZCode 提供；切回「当前」查看活跃会话。'
                  : status || q
                    ? ''
                    : '打开任意受支持的 agent 并发起一次对话后，这里会实时出现。'}
              action=${kimiEmpty
                ? html`<${Button} onClick=${() => app.navigate('quota')}>查看套餐额度</${Button}>`
                : archived === 'only'
                  ? html`<${Button} onClick=${() => setArchived('exclude')}>查看当前会话</${Button}>`
                  : status || q
                    ? html`<${Button} onClick=${clearFilters}>清除筛选</${Button}>`
                    : null}
            />`
          : html`<div class="sess-scroll" ref=${scrollRef} tabIndex="0" role="region"
              aria-label=${'会话列表，共 ' + rootTotal + ' 个'}
              onKeyDown=${onKeyDown}>
              <table class="sess-table">
                <thead><tr>
                  <th class="col-status">状态</th>
                  <th class="sess-title-cell">会话</th>
                  <th class="right col-turns">回合</th>
                  <th class="right col-tokens">Token</th>
                  <th class="right col-cost">成本</th>
                  <th class="right col-duration">耗时</th>
                  <th class="right col-updated">更新</th>
                </tr></thead>
                <tbody>
                  ${shown.map((row, idx) => {
                    const s = row.session
                    const kids = children.get(s.key) || []
                    const kidError = kids.some((k) => k.status === 'error')
                    return html`<tr class=${'sess-row ' + (selected === s.key ? 'selected ' : '') + (idx === focusIndex ? 'focused ' : '') + (row.depth ? 'sub' : '')}
                      role="row" aria-selected=${selected === s.key} tabIndex=${-1}
                      onClick=${() => select(s.key)} data-testid=${'sessions.row.' + s.key}>
                      <td class="col-status">
                        <div class="sess-cell"><${StatusMark} status=${s.status} /><span class="small">${sessionStatusLabel(s.status)}</span></div>
                      </td>
                      <td class="sess-title-cell">
                        <div class=${'sess-cell' + (row.depth ? ' sess-indent' : '')}>
                          ${row.depth
                            ? html`<${Icon} name="subtask" size=${14} />`
                            : kids.length
                              ? html`<button type="button" class=${'sess-chevron' + (expanded.has(s.key) ? ' open' : '')}
                                  aria-label=${expanded.has(s.key) ? '折叠子任务' : '展开子任务'}
                                  onClick=${(e) => {
                                    e.stopPropagation()
                                    setExpanded((prev) => {
                                      const next = new Set(prev)
                                      if (next.has(s.key)) next.delete(s.key)
                                      else next.add(s.key)
                                      return next
                                    })
                                  }}><${Icon} name="chevron" size=${14} /></button>`
                              : null}
                          <div class="sess-main">
                            <div class="sess-line">
                              <div class="sess-title" title=${s.title || s.key}>${s.title || '(未命名会话)'}</div>
                            </div>
                            <div class="sess-sub" title=${s.cwd || ''}>${[agentName(s.agentId), shortModel(s.model), cwdTail(s.cwd)].filter(Boolean).join(' · ')}</div>
                          </div>
                          ${kidError ? html`<${Badge} tone="bad">1 个子任务出错</${Badge}>` : null}
                        </div>
                      </td>
                      <td class="right num col-turns">${s.turns ? s.turns.count : '—'}</td>
                      <td class="right num col-tokens" title=${s.tokens && s.tokens.total != null ? fmtNum(s.tokens.total) : ''}>
                        ${s.tokens && s.tokens.total != null ? fmtTokens(s.tokens.total) : '—'}
                      </td>
                      <td class="right col-cost">
                        <div class="sess-cell" style=${{ justifyContent: 'flex-end' }}>
                          <span class="num">${costText(s)}</span>
                          <${SourceTag} prov=${s.provenance && s.provenance.cost} variant="dot" />
                        </div>
                      </td>
                      <td class="right num col-duration">${s.startedAt ? fmtDuration(durationMs(s)) : '—'}</td>
                      <td class="right small muted col-updated" data-visual-mask>${fmtRelativeShort(s.updatedAt, now)}</td>
                    </tr>`
                  })}
                </tbody>
              </table>
            </div>
            ${!loading && (nextCursor || truncated)
              ? html`<div class="sess-more" data-testid="sessions.footer">
                  <span class="small muted">
                    共 ${rootTotal} 个 · 已显示 ${loadedRoots} 个${truncated ? ' · 受宿主数据窗口限制，可能有更早的会话未显示' : ''}
                  </span>
                  ${nextCursor
                    ? html`<${Button} data-testid="sessions.loadMore" loading=${loadingMore} onClick=${loadMore}>加载更多对话</${Button}>`
                    : null}
                </div>`
              : null}`}
      </${Card}>

      <div class="sess-detail">
        <${Card} testid="sessions.detail">
          ${!current
            ? html`<${EmptyState} icon="sessions" title="选择一个会话" hint="左侧列表里点一行查看详情" />`
            : html`<div>
                <div class="sess-detail-head">
                  <div style=${{ minWidth: 0, flex: 1 }}>
                    <div class="sess-title" title=${current.title || current.key}>${current.title || '(未命名会话)'}</div>
                    <div class="row" style=${{ marginTop: 6, gap: 8 }}>
                      <${Badge} tone=${current.status === 'error' ? 'bad' : current.status === 'working' ? 'info' : current.status === 'waiting_permission' || current.status === 'waiting_input' ? 'warn' : current.status === 'done' ? 'ok' : 'neutral'}>
                        ${sessionStatusLabel(current.status)}
                      </${Badge}>
                      <span class="small muted">${agentName(current.agentId)}${current.model ? ' · ' + current.model : ''}</span>
                      ${current.statusSource === 'inferred' ? html`<span class="small muted" title="按最近活动推断">· 推断</span>` : null}
                    </div>
                  </div>
                  <${IconButton} icon="copy" label="复制会话 ID" onClick=${copyId} />
                </div>

                <div class="sess-tabs" role="tablist" aria-label="会话详情">
                  ${TABS.map(
                    (t) => html`<button type="button" role="tab" aria-selected=${tab === t.value} class=${'btn ' + (tab === t.value ? 'primary' : 'ghost')}
                      onClick=${() => setTab(t.value)}>${t.label}</button>`
                  )}
                </div>

                ${tab === 'overview'
                  ? html`<div>
                      <div class="sess-stats">
                        <${StatBox} label="总 Token" value=${current.tokens && current.tokens.total != null ? fmtTokens(current.tokens.total) : '—'} prov=${current.provenance && current.provenance.tokens} />
                        <${StatBox} label="成本" value=${costText(current)} prov=${current.provenance && current.provenance.cost} />
                        <${StatBox} label="回合数" value=${current.turns ? fmtNum(current.turns.count) : '—'} prov=${current.provenance && current.provenance.status} />
                        <${StatBox} label="总耗时" value=${current.startedAt ? fmtDuration(durationMs(current)) : '—'} prov=${current.provenance && current.provenance.status} />
                      </div>
                      <div class="small muted" style=${{ margin: '12px 0 6px', fontWeight: 600 }}>状态时间线</div>
                      <${StatusTimeline} segments=${timelineOf(current, now)} />
                      <div class="row small muted" style=${{ marginTop: 4 }}>
                        <span>${current.startedAt ? new Date(current.startedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</span>
                        <span class="spacer"></span>
                        <span>${new Date(current.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                      </div>
                      ${current.errors && current.errors.last
                        ? html`<div class="sess-error"><${Badge} tone="bad">${current.errors.last.kind === 'model' ? '模型' : '工具'}错误</${Badge}> <span>${current.errors.last.message || ''}</span></div>`
                        : null}
                    </div>`
                  : null}

                ${tab === 'turns'
                  ? html`<table class="table">
                      <thead><tr><th style=${{ width: 40 }}>#</th><th style=${{ width: 80 }}>开始</th><th style=${{ width: 72 }} class="right">耗时</th><th style=${{ width: 88 }} class="right">Token</th><th style=${{ width: 96 }} class="right">成本</th><th style=${{ width: 64 }}>状态</th></tr></thead>
                      <tbody>
                        ${(detail && detail.turns && detail.turns.length
                          ? detail.turns.slice(0, 50)
                          : []
                        ).map(
                          (t) => html`<tr>
                            <td class="num">${t.index}</td>
                            <td class="mono small">${t.startedAt ? new Date(t.startedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</td>
                            <td class="right num">${t.durationMs != null ? fmtDuration(t.durationMs) : '—'}</td>
                            <td class="right num">${t.tokens != null ? fmtTokens(t.tokens) : '—'}</td>
                            <td class="right num">${t.cost ? (t.cost.unit === 'credit' ? fmtCredit(t.cost.amount) : fmtMoney(t.cost.amount, t.cost.currency)) : '—'}</td>
                            <td>${t.status === 'error' ? html`<${Badge} tone="bad">出错</${Badge}>` : t.status === 'running' ? html`<${Badge} tone="info">进行中</${Badge}>` : t.status === 'cancelled' ? html`<${Badge} tone="neutral">已取消</${Badge}>` : html`<span class="small muted">完成</span>`}</td>
                          </tr>`
                        )}
                        ${!detail || !detail.turns || !detail.turns.length
                          ? html`<tr><td colSpan="6"><${EmptyState} title="没有回合明细" hint=${current.agentId === 'kimi' ? 'Kimi Code 不提供回合历史' : '该宿主没有返回回合数据'} /></td></tr>`
                          : null}
                      </tbody>
                    </table>`
                  : null}

                ${tab === 'tools'
                  ? html`<table class="table">
                      <thead><tr><th>工具</th><th style=${{ width: 64 }} class="right">调用</th><th style=${{ width: 72 }} class="right">错误率</th><th style=${{ width: 88 }} class="right">平均耗时</th></tr></thead>
                      <tbody>
                        ${(detail && detail.tools ? detail.tools : []).map((t) => {
                          const max = Math.max(1, ...(detail.tools || []).map((x) => x.calls || 0))
                          return html`<tr>
                            <td>
                              <div class="truncate" title=${t.name}>${t.name}</div>
                              <div class="progress" style=${{ height: 4, marginTop: 4 }}><span style=${{ width: ((t.calls || 0) / max) * 100 + '%', background: 'var(--c1)' }}></span></div>
                            </td>
                            <td class="right num">${fmtNum(t.calls)}</td>
                            <td class="right num">${t.calls ? Math.round((t.errors / t.calls) * 1000) / 10 : 0}%</td>
                            <td class="right num">${t.avgDurationMs == null ? '—' : Math.round(t.avgDurationMs) + ' ms'}</td>
                          </tr>`
                        })}
                        ${!detail || !detail.tools || !detail.tools.length
                          ? html`<tr><td colSpan="4"><${EmptyState} title="没有工具调用" hint=${current.agentId === 'kimi' ? 'Kimi Code 不提供工具明细' : ''} /></td></tr>`
                          : null}
                      </tbody>
                    </table>`
                  : null}

                ${tab === 'context'
                  ? detail && detail.session && current.agentId === 'kimi'
                    ? html`<${EmptyState} icon="layers" title="Kimi Code 只提供上下文占用" hint="可以在宿主里查看当前会话上下文" />`
                    : html`<${ContextPanel} app=${app} agentId=${current.agentId} sessionId=${current.sessionId} compact=${true} />`
                  : null}

                <div style=${{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 12 }}>
                  <${Button} variant="primary" icon="externalLink" onClick=${focusHost} style=${{ width: '100%', height: 32 }}>跳转到宿主窗口</${Button}>
                </div>
              </div>`}
        </${Card}>
      </div>
    </div>
  </div>`
}

function StatBox({ label, value, prov }) {
  return html`<div class="card" style=${{ padding: 12 }}>
    <div class="stat-label"><span>${label}</span>${prov ? html`<${SourceTag} prov=${prov} variant="dot" />` : null}</div>
    <div class="stat-value" style=${{ fontSize: 20 }}>${value}</div>
  </div>`
}

// 简化时间线：开始 → 状态切换点 → 现在（没有逐段历史时至少表达当前状态）。
function timelineOf(s, now) {
  const from = Number(s.startedAt) || Number(s.statusSince) || Number(s.updatedAt) || now
  const since = Number(s.statusSince) || from
  const segments = []
  if (since > from) segments.push({ status: 'idle', from, to: since })
  // 以最后活动时间作为终点（而不是点击时的 now），截图/审计可重现。
  const end = Math.max(Number(s.updatedAt) || 0, since + 1000)
  segments.push({ status: s.status, from: Math.max(from, since), to: end })
  return segments
}
