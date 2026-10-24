import { h, Fragment } from './vendor/preact.module.js'
import { useEffect, useMemo, useRef, useState } from './vendor/hooks.module.js'
import { render } from './vendor/preact.module.js'
import htm from './vendor/htm.module.js'
import { Icon } from './components/icons.mjs'
import { Badge, IconButton, Segmented, Skeleton, Toasts } from './components/base.mjs'
import { Wizard } from './components/wizard.mjs'
import { fmtPct, fmtReset, fmtTime, agentName, reasonText, pctTone, setHideMoney } from './lib/format.mjs'
import { OverviewPage } from './pages/overview.mjs'
import { SessionsPage } from './pages/sessions.mjs'
import { UsagePage } from './pages/usage.mjs'
import { StatsPage } from './pages/stats.mjs'
import { QuotaPage } from './pages/quota.mjs'
import { VendorsPage } from './pages/vendors.mjs'
import { RolesPage } from './pages/roles.mjs'
import { SettingsPage } from './pages/settings.mjs'
import { AboutPage } from './pages/about.mjs'

const html = htm.bind(h)

const PAGES = [
  { id: 'overview', label: '总览', icon: 'dashboard', group: '监控' },
  { id: 'sessions', label: '会话', icon: 'sessions', group: '监控' },
  { id: 'usage', label: '用量', icon: 'chart', group: '监控' },
  { id: 'stats', label: '统计', icon: 'activity', group: '监控' },
  { id: 'quota', label: '额度与余额', icon: 'gauge', group: '监控' },
  { id: 'vendors', label: '厂商与密钥', icon: 'plug', group: '管理' },
  { id: 'roles', label: '角色与气泡', icon: 'smile', group: '管理' },
  { id: 'settings', label: '设置', icon: 'settings', group: '管理' },
  { id: 'about', label: '关于与诊断', icon: 'info', group: '' },
]
const PAGE_COMPONENTS = {
  overview: OverviewPage,
  sessions: SessionsPage,
  usage: UsagePage,
  stats: StatsPage,
  quota: QuotaPage,
  vendors: VendorsPage,
  roles: RolesPage,
  settings: SettingsPage,
  about: AboutPage,
}

const params = new URLSearchParams(location.search)
const PAGE_PARAM = String(params.get('page') || '')
if (/^(sessions|overview|usage|stats|quota|vendors|roles|settings|about)(\?[A-Za-z0-9%&=_.:-]*)?$/.test(PAGE_PARAM)) {
  history.replaceState(null, '', '#' + PAGE_PARAM)
}
const BASE =
  String(params.get('base') || '') ||
  (params.get('port') ? 'http://127.0.0.1:' + params.get('port') : '') ||
  (/^https?:$/.test(location.protocol) ? location.origin : '')

const API_CACHE = new Map()
const API_CACHE_LIMIT = 120
let forceUntil = 0

// 页面切换时复用最近一次成功结果：统计/用量/厂商这类数据变化慢，重复抓取
// 只会让每次点导航都等几秒。实时性强的会话列表/状态不缓存。
function cacheTtlFor(pathname) {
  const p = String(pathname).split('?')[0]
  if (/^\/v1\/agents\/[^/]+\/stats$/.test(p)) return 60000
  if (/^\/v1\/usage(\/breakdown)?$/.test(p)) return 30000
  if (/^\/v1\/vendors(\/.*)?$/.test(p)) return 30000
  if (/^\/v1\/roles$/.test(p)) return 60000
  if (/^\/v1\/diag\/bundle$/.test(p)) return 30000
  if (/^\/v1\/profiles\/[^/]+$/.test(p)) return 30000
  if (/^\/v1\/sessions\/[^/]+\/context$/.test(p)) return 3000
  if (/^\/v1\/sessions\/[^/]+$/.test(p)) return 8000
  if (/^\/v1\/agents\/[^/]+\/snapshot$/.test(p)) return 5000
  if (/^\/v1\/agents\/[^/]+\/context$/.test(p)) return 3000
  return 0
}

function clearApiCache() {
  API_CACHE.clear()
}

async function rawApi(pathname, opts = {}) {
  if (window.foxDock && window.foxDock.api) {
    return window.foxDock.api(pathname, opts)
  }
  if (!BASE) throw new Error('无法连接 daemon（缺少 base/port）')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(BASE + pathname, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs || 20000),
      })
      let data = null
      try {
        data = await res.json()
      } catch (err) {}
      return { status: res.status, ok: res.ok, data }
    } catch (err) {
      const method = opts.method || 'GET'
      if (method !== 'GET' || attempt === 1) throw err
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  throw new Error('fetch failed')
}

async function api(pathname, opts = {}) {
  const method = opts.method || 'GET'
  let path = pathname
  const forced = method === 'GET' && (opts.force === true || Date.now() < forceUntil)
  if (forced && !/[?&]force=1(&|$)/.test(path)) path += (path.includes('?') ? '&' : '?') + 'force=1'
  const ttl = method === 'GET' && !forced ? (opts.ttl != null ? Number(opts.ttl) : cacheTtlFor(path)) : 0
  if (ttl > 0) {
    const hit = API_CACHE.get(path)
    if (hit && Date.now() - hit.at <= ttl) return hit.data
    if (hit) API_CACHE.delete(path)
  }
  const r = await rawApi(path, { ...opts, method })
  if (!r.ok || (r.data && r.data.ok === false && r.data.error)) {
    const message = (r.data && (r.data.error || r.data.reason)) || 'HTTP ' + r.status
    const err = new Error(String(message))
    err.status = r.status
    throw err
  }
  if (ttl > 0) {
    API_CACHE.set(path, { at: Date.now(), data: r.data })
    if (API_CACHE.size > API_CACHE_LIMIT) API_CACHE.delete(API_CACHE.keys().next().value)
  }
  return r.data
}

function useToasts() {
  const [items, setItems] = useState([])
  const idRef = useRef(0)
  function toast(text, tone = '') {
    const id = ++idRef.current
    setItems((list) => [...list, { id, text: String(text), tone }])
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 4200)
  }
  return [items, toast]
}

function App() {
  const [boot, setBoot] = useState(null)
  const [state, setState] = useState(null)
  const [settings, setSettings] = useState(null)
  const [roles, setRoles] = useState([])
  const [vendors, setVendors] = useState(null)
  const [snapshots, setSnapshots] = useState({})
  const [contexts, setContexts] = useState({})
  const [sessions, setSessions] = useState([])
  const [profile, setProfile] = useState(null)
  const [page, setPage] = useState(() => {
    const raw = String(location.hash || '').replace('#', '')
    let id = raw.split('?')[0]
    if (id === 'context') {
      id = 'sessions'
      history.replaceState(null, '', '#sessions?tab=context')
    } else if (!PAGE_COMPONENTS[id]) {
      try {
        id = localStorage.getItem('fox-dock.console.page') || ''
      } catch (err) {
        id = ''
      }
      if (id === 'context') {
        id = 'sessions'
        history.replaceState(null, '', '#sessions?tab=context')
      }
    }
    return PAGE_COMPONENTS[id] ? id : 'overview'
  })
  const [view, setView] = useState('follow')
  const [refreshAt, setRefreshAt] = useState(Date.now())
  const [connected, setConnected] = useState(true)
  const [toasts, toast] = useToasts()
  const [roleImages, setRoleImages] = useState({})
  const [lastDataAt, setLastDataAt] = useState(0)
  const [events, setEvents] = useState([])
  const [liveTick, setLiveTick] = useState(0)
  const [permActions, setPermActions] = useState([])
  const [showWizard, setShowWizard] = useState(false)
  const refreshRef = useRef(refreshAt)
  refreshRef.current = refreshAt

  const viewAgent = useMemo(() => {
    if (view !== 'follow') return view
    const pet = (state && state.pet) || {}
    return pet.profileOf || pet.agentId || 'zcode'
  }, [view, state])

  async function reloadState() {
    const d = await api('/v1/state')
    setState(d)
    setConnected(true)
    return d
  }
  // M5 权限待办：/v1/actions 不缓存；SSE action 事件与 15s 兜底轮询都会刷新。
  async function reloadActions() {
    try {
      const d = await api('/v1/actions', { force: true })
      setPermActions(d && Array.isArray(d.actions) ? d.actions : [])
    } catch (err) {}
  }
  async function resolveAction(id, decision) {
    try {
      const r = await api('/v1/actions/' + encodeURIComponent(id) + '/resolve', { method: 'POST', body: { decision, via: 'console' } })
      if (r && r.ok) toast(decision === 'allow' ? '已允许本次执行' : '已拒绝，交回宿主处理', '')
    } catch (err) {
      toast('处理失败：' + (err && err.message ? err.message : err), 'bad')
    }
    reloadActions()
  }
  async function loadSettings() {
    const d = await api('/v1/settings')
    setSettings(d.settings)
    return d.settings
  }
  async function reloadRoles() {
    const r = await api('/v1/roles')
    setRoles(r.roles || [])
    return r.roles || []
  }
  async function reloadVendors(force = false) {
    const d = await api('/v1/vendors' + (force ? '?force=1' : ''))
    setVendors(d.vendors || [])
    return d.vendors || []
  }
  function refresh() {
    // 刷新按钮必须真的穿透两层缓存：渲染层缓存 + daemon 各服务的 TTL。
    // forceUntil 让紧随 refreshAt 的 GET 自动带 force=1。
    forceUntil = Date.now() + 3000
    clearApiCache()
    setRefreshAt(Date.now())
  }

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const b = window.foxDock && window.foxDock.bootstrap ? await window.foxDock.bootstrap() : { version: '2.0.0', electron: '', node: '', platform: '', dataDir: '' }
        if (!alive) return
        setBoot(b)
        const s = await loadSettings()
        applyTheme(s.theme)
        const st = await reloadState()
        const r = await api('/v1/roles')
        setRoles(r.roles || [])
        // 首次接入向导：仅当未完成 onboarding 且发现至少 1 个宿主时弹（M6）。
        if (s.onboarded !== true) {
          try {
            const ob = await api('/v1/onboarding')
            if (ob && ob.ok && ((ob.hosts || []).some((x) => x.running) || (ob.legacy && ob.legacy.found))) {
              if (alive) setShowWizard(true)
            }
          } catch (err) {}
        }
      } catch (err) {
        if (alive) toast('连接 daemon 失败：' + String(err.message || err), 'bad')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 厂商余额：总览与额度页共用一份；60 秒刷新一次（各引擎自身还有 TTL）。
  useEffect(() => {
    let alive = true
    const load = () =>
      api('/v1/vendors')
        .then((d) => alive && setVendors(d.vendors || []))
        .catch(() => {})
    load()
    const timer = setInterval(load, 60000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // 角色图片：内置资源走 file://；导入角色由主进程读成 data URL。
  useEffect(() => {
    if (!roles.length) return
    let alive = true
    ;(async () => {
      const out = {}
      for (const r of roles) {
        if (window.foxDock && window.foxDock.readRoleImage) {
          try {
            const url = await window.foxDock.readRoleImage(r.id)
            if (url) out[r.id] = url
          } catch (err) {}
        }
        if (!out[r.id] && r.builtin) out[r.id] = '../overlay/' + r.image
      }
      if (alive) setRoleImages(out)
    })()
    return () => {
      alive = false
    }
  }, [roles])

  // 所有 agent 的计费快照 + 上下文（总览对比用）
  useEffect(() => {
    if (!state || !state.agents) return
    let alive = true
    ;(async () => {
      const snaps = {}
      const ctxs = {}
      await Promise.all(
        state.agents.map(async (a) => {
          try {
            const d = await api('/v1/agents/' + encodeURIComponent(a.id) + '/snapshot')
            snaps[a.id] = d.snapshot
            if (d.context) ctxs[a.id] = d.context
          } catch (err) {}
        })
      )
      if (!alive) return
      setSnapshots((prev) => ({ ...prev, ...snaps }))
      setContexts((prev) => ({ ...prev, ...ctxs }))
      setLastDataAt(Date.now())
    })()
    return () => {
      alive = false
    }
  }, [state && (state.agents || []).map((a) => a.id + (a.running ? '1' : '0')).join(','), refreshAt])

  // 当前视角的会话与档案
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [s, p] = await Promise.all([
          api('/v1/agents/' + encodeURIComponent(viewAgent) + '/sessions').catch(() => ({ sessions: [] })),
          api('/v1/profiles/' + encodeURIComponent(viewAgent)).catch(() => ({ profile: null })),
        ])
        if (!alive) return
        setSessions(s.sessions || [])
        setProfile(p.profile || null)
      } catch (err) {}
    })()
    return () => {
      alive = false
    }
  }, [viewAgent, refreshAt])

  // SSE：主进程代理；普通浏览器回退 EventSource
  useEffect(() => {
    let cleanup = () => {}
    if (window.foxDock && window.foxDock.onEvent) {
      setConnected(true)
      cleanup = window.foxDock.onEvent(({ event, data }) => {
        if (event === 'state') {
          setState(data)
          setConnected(true)
        } else if (event === 'context' && data && data.adapterId) {
          setContexts((prev) => ({ ...prev, [data.adapterId]: data.context }))
        } else if (event === 'session' || event === 'sessions' || event === 'live') {
          setLiveTick((n) => n + 1)
          if (event === 'sessions' || event === 'live') {
            setState((prev) => (prev ? { ...prev, live: data } : prev))
          }
        } else if (event === 'event') {
          setEvents((list) => [...list.slice(-19), data])
          if (data.type === 'permission-request') {
            const cur = settings || {}
            if (cur.confirmAlert !== false) toast('ZCode 正在等待确认', '')
          }
        } else if (event === 'action') {
          reloadActions()
        }
      })
    } else if (BASE) {
      const es = new EventSource(BASE + '/v1/stream')
      es.addEventListener('state', (e) => {
        try {
          setState(JSON.parse(e.data))
        } catch (err) {}
      })
      es.addEventListener('context', (e) => {
        try {
          const d = JSON.parse(e.data)
          setContexts((prev) => ({ ...prev, [d.adapterId]: d.context }))
        } catch (err) {}
      })
      es.addEventListener('session', () => setLiveTick((n) => n + 1))
      es.addEventListener('action', () => reloadActions())
      es.addEventListener('sessions', (e) => {
        try {
          setState((prev) => (prev ? { ...prev, live: JSON.parse(e.data) } : prev))
        } catch (err) {}
        setLiveTick((n) => n + 1)
      })
      es.onopen = () => setConnected(true)
      es.onerror = () => setConnected(false)
      cleanup = () => es.close()
    }
    return cleanup
  }, [settings && settings.confirmAlert])

  // 兜底轮询：SSE 正常时也每 15 秒校正一次（防漏事件）
  useEffect(() => {
    setHideMoney(!!(settings && settings.hideMoney))
  }, [settings && settings.hideMoney])

  // 跟随系统时，OS 切换深浅色也要同步原生标题栏按钮区。
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (!settings || !settings.theme || settings.theme === 'auto') applyTheme('auto')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings && settings.theme])

  useEffect(() => {
    const timer = setInterval(() => {
      reloadState().catch(() => setConnected(false))
      reloadActions()
      setRefreshAt(Date.now())
    }, 15000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    reloadActions()
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey && !e.altKey && !e.shiftKey) {
        const n = Number(e.key)
        if (n >= 1 && n <= 7) {
          e.preventDefault()
          const target = PAGES[n - 1]
          if (target) navigate(target.id)
        }
      }
      if (e.key === 'F5') {
        e.preventDefault()
        refresh()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function applyTheme(theme) {
    const t = theme === 'light' || theme === 'dark' ? theme : ''
    if (t) document.documentElement.dataset.theme = t
    else delete document.documentElement.dataset.theme
    document.documentElement.style.colorScheme = t || 'light dark'
    // 右上角系统按钮区是原生层，颜色必须跟 titlebar 实际背景一致。
    try {
      const styles = getComputedStyle(document.documentElement)
      const color = styles.getPropertyValue('--surface').trim()
      const symbolColor = styles.getPropertyValue('--text').trim()
      if (window.foxDock && window.foxDock.setTitleBarTheme) window.foxDock.setTitleBarTheme(color, symbolColor)
    } catch (err) {}
  }

  useEffect(() => {
    function onHash() {
      const raw = String(location.hash || '').replace('#', '')
      let id = raw.split('?')[0]
      if (id === 'context') {
        id = 'sessions'
        history.replaceState(null, '', '#sessions?tab=context')
      }
      if (PAGE_COMPONENTS[id]) setPage(id)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  function navigate(id) {
    if (id === 'context') id = 'sessions'
    if (!PAGE_COMPONENTS[id]) return
    if (!['sessions', 'stats', 'quota'].includes(id)) setView('follow')
    setPage(id)
    location.hash = id
    try {
      localStorage.setItem('fox-dock.console.page', id)
    } catch (err) {}
  }

  async function saveSettings(patch) {
    const prev = settings
    setSettings((s) => ({ ...s, ...patch }))
    try {
      const d = await api('/v1/settings', { method: 'PUT', body: patch })
      setSettings(d.settings)
      applyTheme(d.settings.theme)
      refresh()
    } catch (err) {
      setSettings(prev)
      toast('保存失败：' + String(err.message || err), 'bad')
    }
  }

  async function copyDiagnostics() {
    try {
      const d = await api('/v1/diag/bundle')
      await navigator.clipboard.writeText(JSON.stringify(d, null, 2))
      toast('已复制诊断信息')
    } catch (err) {
      toast('复制失败：' + String(err.message || err), 'bad')
    }
  }

  async function resetSettings() {
    if (!window.confirm('把全部设置恢复默认？账本与上下文历史不受影响。')) return
    try {
      const d = await api('/v1/maintenance/reset-settings', { method: 'POST', body: {} })
      setSettings(d.settings)
      applyTheme(d.settings.theme)
      toast('设置已恢复默认')
      refresh()
    } catch (err) {
      toast('重置失败：' + String(err.message || err), 'bad')
    }
  }

  async function clearUsage() {
    if (!window.confirm('清空用量账本与上下文历史？此操作不可撤销。')) return
    try {
      await api('/v1/maintenance/clear-usage', { method: 'POST', body: {} })
      toast('已清空用量缓存')
      refresh()
    } catch (err) {
      toast('清空失败：' + String(err.message || err), 'bad')
    }
  }

  function roleIdForAgent(id) {
    if (profile && id === viewAgent && profile.roleId) return profile.roleId
    const agent = (state && state.agents || []).find((a) => a.id === id)
    if (agent && agent.roleDefault) return agent.roleDefault
    const byDefault = roles.find((r) => (r.defaultFor || []).includes(id))
    if (byDefault) return byDefault.id
    if (settings && settings.rolesByAdapter && settings.rolesByAdapter[id]) return settings.rolesByAdapter[id]
    return (settings && settings.roleId) || 'fox'
  }

  function agentAccent(id) {
    const a = (state && state.agents || []).find((x) => x.id === id)
    if (a && a.accent) return a.accent
    const roleId = (profile && profile.roleId) || ((roles.find((r) => (r.defaultFor || []).includes(id)) || {}).id)
    const r = roles.find((x) => x.id === roleId)
    return (r && r.accent) || '#f0a04b'
  }

  function bindLabel() {
    const pet = (state && state.pet) || {}
    if (pet.mode === 'attached') return { text: '跟随中 · ' + agentName(pet.agentId), tone: 'ok' }
    if (pet.mode === 'floating') return { text: '桌面 · 沿用 ' + agentName(pet.profileOf), tone: 'info' }
    return { text: '未吸附', tone: 'neutral' }
  }

  const Page = PAGE_COMPONENTS[page] || OverviewPage
  const app = {
    boot,
    state,
    settings,
    roles,
    vendors,
    snapshots,
    contexts,
    sessions,
    profile,
    refreshAt,
    viewAgent,
    view,
    events,
    live: (state && state.live) || { aggregate: 'idle', counts: {} },
    liveTick,
    api,
    clearApiCache,
    toast,
    refresh,
    navigate,
    reloadState,
    reloadActions,
    resolveAction,
    permActions,
    reloadRoles,
    reloadVendors,
    saveSettings,
    copyDiagnostics,
    resetSettings,
    clearUsage,
    roleImageUrl: (id) => roleImages[id] || '',
    roleIdForAgent,
    agentAccent,
    agentName,
    bindLabel,
    reasonText,
    fmtTime,
    fmtReset,
  }

  const agents = (state && state.agents) || []
  const viewOptions = [
    { value: 'follow', label: '跟随角色', dot: connected ? 'ok' : 'bad' },
    ...agents.map((a) => ({ value: a.id, label: a.name, dot: a.running ? 'ok' : 'bad' })),
  ]
  const groups = ['监控', '管理']
  const online = connected && state
  // 只有按宿主取数的页面才显示视角切换；总览/用量是四 agent 合并视图，
  // 厂商/角色/设置/关于也不按宿主变化。
  const showAgentSwitch = ['sessions', 'stats', 'quota'].includes(page)

  return html`<${Fragment}>
    <div class="titlebar">
      <div class="brand"><span class=${'dot ' + (online ? '' : 'offline')}></span>fox-dock 控制台</div>
      <span class="spacer"></span>
      <span class="meta">v${boot ? boot.version : ''} · ${connected ? '已连接' : '连接中断，重试中…'}</span>
    </div>
    <div class="app">
      <aside class="sidebar">
        ${groups.map(
          (g) => html`<div class="nav-group">
            <div class="nav-title">${g}</div>
            ${PAGES.filter((p) => p.group === g).map(
              (p) => html`<button class="nav-item" aria-current=${page === p.id ? 'page' : undefined} onClick=${() => navigate(p.id)} aria-label=${p.label} title=${p.label} data-testid=${'nav.' + p.id}>
                <${Icon} name=${p.icon} size=${18} /><span>${p.label}</span>
              </button>`
            )}
          </div>`
        )}
        <div class="sidebar-footer">
          <button class="nav-item" aria-current=${page === 'about' ? 'page' : undefined} onClick=${() => navigate('about')} aria-label="关于与诊断" title="关于与诊断" data-testid="nav.about">
            <${Icon} name="info" size=${18} /><span>关于与诊断</span>
          </button>
          <div class="row sidebar-status"><span class=${'dot ' + (online ? '' : 'offline')} title=${online ? '在线' : '离线'}></span><span class="status-text">${online ? '在线' : '离线'} · v${boot ? boot.version : ''}</span></div>
        </div>
      </aside>
      <main class="main">
        <header class="page-head">
          <h1>${(PAGES.find((p) => p.id === page) || {}).label || '关于与诊断'}</h1>
          ${showAgentSwitch ? html`<${Segmented} value=${view} options=${viewOptions} onChange=${setView} label="视角" />` : null}
          <span class="spacer"></span>
          <span class="fresh" data-visual-mask>${lastDataAt ? '上次更新 ' + fmtTime(lastDataAt) : ''}</span>
          <${IconButton} icon="refresh" label="刷新" onClick=${refresh} />
        </header>
        <div class="content" id="content" tabindex="0" aria-label="页面内容">
          ${!state
            ? html`<div class="card"><${Skeleton} height=${28} /><div style=${{ height: 12 }}></div><${Skeleton} height=${200} /></div>`
            : html`<${Page} app=${app} />`}
        </div>
      </main>
    </div>
    <${Toasts} items=${toasts} />
    ${showWizard ? html`<${Wizard} app=${app} onClose=${() => setShowWizard(false)} />` : null}
  </${Fragment}>`
}

render(html`<${App} />`, document.getElementById('root'))
