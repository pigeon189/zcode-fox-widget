import { h, Fragment } from './vendor/preact.module.js'
import { useEffect, useMemo, useRef, useState } from './vendor/hooks.module.js'
import { render } from './vendor/preact.module.js'
import htm from './vendor/htm.module.js'
import { Icon } from './components/icons.mjs'
import { Badge, IconButton, Segmented, Skeleton, Toasts } from './components/base.mjs'
import { fmtPct, fmtReset, fmtTime, agentName, reasonText, pctTone, setHideMoney } from './lib/format.mjs'
import { OverviewPage } from './pages/overview.mjs'
import { ContextPage } from './pages/context.mjs'
import { UsagePage } from './pages/usage.mjs'
import { QuotaPage } from './pages/quota.mjs'
import { VendorsPage } from './pages/vendors.mjs'
import { RolesPage } from './pages/roles.mjs'
import { SettingsPage } from './pages/settings.mjs'
import { AboutPage } from './pages/about.mjs'

const html = htm.bind(h)

const PAGES = [
  { id: 'overview', label: '总览', icon: 'dashboard', group: '监控' },
  { id: 'context', label: '上下文', icon: 'layers', group: '监控' },
  { id: 'usage', label: '用量', icon: 'chart', group: '监控' },
  { id: 'quota', label: '额度与余额', icon: 'gauge', group: '监控' },
  { id: 'vendors', label: '厂商与密钥', icon: 'plug', group: '管理' },
  { id: 'roles', label: '角色与气泡', icon: 'smile', group: '管理' },
  { id: 'settings', label: '设置', icon: 'settings', group: '管理' },
  { id: 'about', label: '关于与诊断', icon: 'info', group: '' },
]
const PAGE_COMPONENTS = {
  overview: OverviewPage,
  context: ContextPage,
  usage: UsagePage,
  quota: QuotaPage,
  vendors: VendorsPage,
  roles: RolesPage,
  settings: SettingsPage,
  about: AboutPage,
}

const params = new URLSearchParams(location.search)
const BASE =
  String(params.get('base') || '') ||
  (params.get('port') ? 'http://127.0.0.1:' + params.get('port') : '') ||
  (/^https?:$/.test(location.protocol) ? location.origin : '')

async function rawApi(pathname, opts = {}) {
  if (window.foxDock && window.foxDock.api) {
    const r = await window.foxDock.api(pathname, opts)
    return r
  }
  if (!BASE) throw new Error('无法连接 daemon（缺少 base/port）')
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
}

async function api(pathname, opts = {}) {
  const r = await rawApi(pathname, opts)
  if (!r.ok || (r.data && r.data.ok === false && r.data.error)) {
    const message = (r.data && (r.data.error || r.data.reason)) || 'HTTP ' + r.status
    const err = new Error(String(message))
    err.status = r.status
    throw err
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
    const fromHash = String(location.hash || '').replace('#', '')
    return PAGE_COMPONENTS[fromHash] ? fromHash : 'overview'
  })
  const [view, setView] = useState('follow')
  const [refreshAt, setRefreshAt] = useState(Date.now())
  const [connected, setConnected] = useState(true)
  const [toasts, toast] = useToasts()
  const [roleImages, setRoleImages] = useState({})
  const [lastDataAt, setLastDataAt] = useState(0)
  const [events, setEvents] = useState([])
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
    return d
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
        } else if (event === 'event') {
          setEvents((list) => [...list.slice(-19), data])
          if (data.type === 'permission-request') {
            const cur = settings || {}
            if (cur.confirmAlert !== false) toast('ZCode 正在等待确认', '')
          }
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
      setRefreshAt(Date.now())
    }, 15000)
    return () => clearInterval(timer)
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

  function navigate(id) {
    if (!PAGE_COMPONENTS[id]) return
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
    events,
    api,
    toast,
    refresh,
    navigate,
    reloadState,
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
          <${Segmented} value=${view} options=${viewOptions} onChange=${setView} label="视角" />
          <span class="spacer"></span>
          <span class="fresh">${lastDataAt ? '上次更新 ' + fmtTime(lastDataAt) : ''}</span>
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
  </${Fragment}>`
}

render(html`<${App} />`, document.getElementById('root'))
