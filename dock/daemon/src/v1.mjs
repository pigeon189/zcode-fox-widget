// /v1 API（D028）：控制台与宿主 shim 的唯一入口。
//
// 约定：
//   · 读接口只允许环回 Host（防 DNS rebinding）；写接口另需 x-fox-token；
//   · 响应结构稳定，前端不做字段猜测；
//   · 任何密钥都不出现在响应里（保险库只回 maskedKey，M3 接入）。
//   · 旧路由（/health /windows /bind ...）继续保留一个版本，响应头加
//     X-Fox-Deprecated: 1（在 daemon.mjs 统一加），新前端不再使用。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeContext } from '../../adapters/contracts.mjs'
import { resolveAdapter } from '../../adapters/registry.mjs'
import { readBindings, upsertBinding } from './bindings.mjs'
import { getProfile, readSettings, resetSettings, writePet, writeProfile, writeSettings } from './settings.mjs'
import { buildBindKey } from '../../shared/identity.mjs'
import { recordSnapshot, summarize } from './ledger.mjs'
import { transition } from './state-machine.mjs'
import { deleteRole, importRole, listRoleLibrary, renameRole, suggestRoleId } from './roles.mjs'
import { addAdjustment, adjustmentSummary, applyAdjustments, listAdjustments, removeAdjustment } from './balance-adjustments.mjs'
import { CATEGORIES, importCategories, inspectSources } from './import-old.mjs'
import { MAX_BODY_BYTES, mapLegacyEvent, rateAllowed, validateIngest } from './ingest.mjs'
import { assessRisk } from './risk.mjs'
import { RESOLVE_VIAS } from './actions.mjs'
import { deleteSoundSet, listSounds, resolveSoundBytes, saveSoundSet } from './sounds.mjs'
import { prov } from '../../shared/provenance.mjs'
import { redactHome } from '../../shared/redact.mjs'

const DOCK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > limit) {
        settled = true
        const err = new Error('body too large')
        err.code = 'too-large'
        reject(err)
        // 不 destroy：把剩余数据读掉，才能把 413 正常写回客户端。
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(new Error('bad json'))
      }
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  if (ba.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(ba, bb)
  } catch (err) {
    return false
  }
}

function hostAllowed(req, port) {
  const host = String(req.headers.host || '').toLowerCase()
  // HTTP/1.0 或测试客户端可能不带 Host；带了就必须是环回。
  if (!host) return true
  return host === '127.0.0.1:' + port || host === 'localhost:' + port || host === '[::1]:' + port
}

function text(v, max = 160) {
  return String(v == null ? '' : v).trim().slice(0, max)
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return fallback
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

function rolesIndexFile(paths) {
  return path.join(paths.dir, 'roles.json')
}

// 会话响应统一脱敏：cwd 只保留 ~ 起头的写法；标题/错误消息不含主目录。
//
// 待办（pending）里带命令预览与 requestId，等同于权限决策的读取面（D036）。
// GET /v1/actions 已经要求令牌；会话列表/详情是匿名读面，只有持有
// x-fox-token 的调用方（控制台经主进程转发）才能拿到 preview/id，匿名方
// 只保留能安全展示的状态字段（工具名/风险/截止时间）。
function sanitizePending(p, { authorized } = {}) {
  if (!p || typeof p !== 'object') return p
  const out = {
    kind: p.kind,
    agentId: p.agentId,
    sessionKey: p.sessionKey,
    tool: p.tool,
    risk: p.risk,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    state: p.state,
  }
  if (authorized) {
    out.id = p.id
    out.preview = redactHome(p.preview ? p.preview : '')
  }
  return out
}

function sanitizeSession(s, opts = {}) {
  if (!s || typeof s !== 'object') return s
  return {
    ...s,
    title: redactHome(s.title || ''),
    cwd: redactHome(s.cwd || ''),
    errors:
      s.errors && s.errors.last && s.errors.last.message
        ? { ...s.errors, last: { ...s.errors.last, message: redactHome(s.errors.last.message) } }
        : s.errors,
    pending: Array.isArray(s.pending) ? s.pending.map((p) => sanitizePending(p, opts)) : s.pending,
  }
}

function listRoles(paths) {
  return listRoleLibrary({ rolesDir: paths.rolesDir, indexFile: rolesIndexFile(paths) })
}

function listBubbleTemplates(paths) {
  const raw = readJsonFile(paths.bubbleTemplates, [])
  return Array.isArray(raw) ? raw.slice(0, 50) : []
}

export function createV1Router(deps) {
  const {
    paths,
    token,
    version,
    startedAt,
    adapters,
    billing,
    stats,
    sse,
    bridge,
    getPort,
    readUpdateState,
    contextService,
    contextHistory,
    engines,
    vault,
    setAutoStart,
    getAutoStart,
    liveTracker = null,
    broker = null,
    usageBreakdown = null,
    log = () => {},
  } = deps

  const events = []
  let vendorCache = { at: 0, value: null }
  const VENDOR_TTL_MS = 30_000

  // 厂商状态的 provenance：origin 按 kind 真实映射（local-log 的 plan-log 源 →
  // 本地日志，直连接口源 → api；远程模板一律 api），不由前端按 available 布尔
  // 断言；asOf 是这份状态在 daemon 侧的组装时刻（30s TTL 内命中缓存时即上次
  // 组装时刻），不是浏览器渲染时刻。余额被人工校正过的卡降为 estimated/user。
  function vendorProvOf(v, at) {
    const source = 'vendor:' + v.id
    if (!v.available) return prov('unavailable', 'unknown', source, { asOf: at, reason: 'no-data' })
    if (v.kind === 'tokens') return prov('unavailable', 'unknown', source, { asOf: at, reason: 'no-data' })
    const origin = v.kind === 'local-log' ? (/api/i.test(String(v.source || '')) ? 'api' : 'local-log') : 'api'
    const corrected = v.balance != null && v.corrections && Number(v.corrections.count) > 0
    if (corrected) return prov('estimated', 'user', source, { asOf: at, note: '官方读数 + 人工校正' })
    return prov('exact', origin, source, { asOf: at })
  }

  async function vendorsPayload(force) {
    if (engines) {
      if (!force && vendorCache.value && Date.now() - vendorCache.at < VENDOR_TTL_MS) return { ...vendorCache.value, cached: true }
      const r = await engines.listVendorStatus(force)
      const adjFile = path.join(paths.dir, 'balance-adjustments.json')
      const at = Date.now()
      const vendors = (r.vendors || []).map((v) => {
        const items = listAdjustments(adjFile, v.id)
        const summary = adjustmentSummary(items, v.currency || 'CNY')
        const balance = v.balance == null ? v.balance : applyAdjustments(v.balance, items, v.currency || 'CNY')
        const out = {
          ...v,
          balance,
          // 前端只消费稳定字段；keySource/keyMasked 也保留（掩码，不是密钥）。
          // cmdgo 的凭据是宿主 provider / 本地池，不一定有 keyMasked；
          // 池里有账号就算已配置。local-log 同理（套餐日志/接口可用即已配置）。
          configured: !!(
            v.keyMasked ||
            (v.keySource && v.keySource !== 'none') ||
            (v.kind === 'cmdgo' && Number(v.pool && v.pool.total) > 0) ||
            (v.kind === 'local-log' && v.available)
          ),
          status: v.available ? 'ok' : 'unavailable',
          corrections: summary,
        }
        out.prov = vendorProvOf(out, at)
        return out
      })
      const value = { ok: r.ok !== false, vendors, source: 'engines' }
      vendorCache = { at: Date.now(), value }
      return value
    }
    const { readHostVendors } = await import('./host-vendors.mjs')
    const data = await readHostVendors('', { force })
    return { ok: data.ok !== false, reason: data.reason || '', source: 'legacy-service', services: data.services || [], vendors: data.vendors || [] }
  }

  async function contextFor(adapterId, query = {}) {
    const id = String(adapterId || '')
    if (!contextService) {
      const adapter = (adapters || []).find((a) => a && a.id === id)
      return normalizeContext({ supported: false, reason: 'no-data' }, { adapterId: id, adapterName: adapter ? adapter.name : id })
    }
    return contextService.get(id, query)
  }

  async function sessionsFor(adapterId) {
    if (!contextService) return []
    return contextService.sessions(adapterId, { limit: 8 })
  }

  async function windowsNow() {
    if (!bridge) return []
    try {
      return await bridge.snapshot()
    } catch (err) {
      return []
    }
  }

  function agentsFrom(windows) {
    const list = (adapters || []).filter((a) => a && a.id !== 'generic' && a.capabilities && a.capabilities.billing)
    return list.map((a) => {
      const wins = (windows || []).filter((w) => resolveAdapter(w, adapters).id === a.id)
      return {
        id: a.id,
        name: a.name,
        running: wins.length > 0,
        windows: wins.map((w) => ({ hwnd: w.hwnd, pid: w.pid, title: redactHome(text(w.title, 200)), rect: w.rect })),
        accent: a.accent || '',
        roleDefault: a.roleDefault || '',
        context: !!(a.capabilities && a.capabilities.context),
      }
    })
  }

  async function stateBody() {
    const settings = readSettings(paths.settings)
    const windows = await windowsNow()
    return {
      ok: true,
      pet: settings.pet,
      agents: agentsFrom(windows),
      profiles: settings.profiles,
      settings: {
        theme: settings.theme,
        hideMoney: settings.hideMoney,
        dnd: settings.dnd,
        petMode: settings.petMode,
        scale: settings.scale,
        autoAttachNewAgent: settings.autoAttachNewAgent,
        reattachOnRestart: settings.reattachOnRestart,
        contextWarnPct: settings.contextWarnPct,
        hotkeys: settings.hotkeys,
      },
      bindings: readBindings(paths.bindings).slice(0, 20).map((b) => ({
        key: b.key,
        adapterId: b.adapterId,
        title: b.window ? b.window.title : '',
        hwnd: b.window ? b.window.hwnd : '',
      })),
      daemon: {
        version,
        uptime: Math.round((Date.now() - startedAt) / 1000),
        port: getPort(),
      },
      // 宠物层只消费聚合状态，不自己拉会话表（D034）。
      live: liveTracker ? liveTracker.aggregate() : { aggregate: 'idle', counts: { working: 0, waiting: 0, error: 0, done: 0 }, byAgent: {} },
    }
  }

  function petEvent(type, payload = {}) {
    const settings = readSettings(paths.settings)
    const next = transition(settings.pet, { type, ...payload }, { reattach: settings.reattachOnRestart })
    writePet(paths.settings, next)
    return next
  }

  async function broadcastState() {
    if (!sse) return
    try {
      sse.broadcast('state', await stateBody())
    } catch (err) {}
  }

  async function handle(req, res, url) {
    const p = url.pathname
    if (!p.startsWith('/v1/')) return false
    const port = getPort()
    if (!hostAllowed(req, port)) {
      sendJson(res, 403, { ok: false, error: 'bad-host' })
      return true
    }

    const method = String(req.method || 'GET').toUpperCase()
    const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
    // 读接口的「持令牌」不是必须，但持令牌才能看到权限待办的 preview/id。
    const authorized = timingSafeEqual(req.headers['x-fox-token'], token)
    if (isWrite && !authorized) {
      sendJson(res, 403, { ok: false, error: 'bad-token' })
      return true
    }

    try {
      // ---------- 状态 ----------
      if (p === '/v1/state' && method === 'GET') {
        sendJson(res, 200, await stateBody())
        return true
      }

      if (p === '/v1/stream' && method === 'GET') {
        if (sse) {
          sse.subscribe(req, res)
          // 新订阅者先收一份全量会话摘要，之后只收增量。
          if (liveTracker) liveTracker.sendFull(res)
        } else sendJson(res, 503, { ok: false, error: 'sse-unavailable' })
        return true
      }

      // ---------- agent 数据 ----------
      const snapMatch = p.match(/^\/v1\/agents\/([^/]+)\/snapshot$/)
      if (snapMatch && method === 'GET') {
        const id = decodeURIComponent(snapMatch[1])
        const windows = await windowsNow()
        const win = (windows || []).find((w) => resolveAdapter(w, adapters).id === id) || null
        const snap = await billing.snapshotById(id, { force: url.searchParams.get('force') === '1', window: win })
        if (snap.supported && snap.ok) {
          recordSnapshot(paths.ledger, { adapterId: snap.adapterId, adapterName: snap.adapterName, snapshot: snap, now: Date.now() })
        }
        sendJson(res, 200, {
          ok: true,
          adapterId: id,
          snapshot: snap,
          context: await contextFor(id, { force: url.searchParams.get('force') === '1' }),
        })
        return true
      }

      const statsMatch = p.match(/^\/v1\/agents\/([^/]+)\/stats$/)
      if (statsMatch && method === 'GET') {
        const id = decodeURIComponent(statsMatch[1])
        const range = ['all', '7d', '30d', 'custom'].includes(String(url.searchParams.get('range') || ''))
          ? String(url.searchParams.get('range'))
          : 'all'
        const from = text(url.searchParams.get('from'), 10)
        const to = text(url.searchParams.get('to'), 10)
        if (range === 'custom' && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to)) {
          sendJson(res, 400, { ok: false, error: 'bad-range' })
          return true
        }
        const value = stats
          ? await stats.get(id, { range, from, to, force: url.searchParams.get('force') === '1' })
          : { supported: false, range, reason: 'stats-unavailable', note: '统计服务未启用' }
        sendJson(res, 200, { ok: true, adapterId: id, stats: value })
        return true
      }

      const ctxMatch = p.match(/^\/v1\/agents\/([^/]+)\/context$/)
      if (ctxMatch && method === 'GET') {
        const id = decodeURIComponent(ctxMatch[1])
        sendJson(res, 200, {
          ok: true,
          context: await contextFor(id, {
            force: url.searchParams.get('force') === '1',
            session: url.searchParams.get('session') || '',
            range: url.searchParams.get('range') || 'session',
          }),
        })
        return true
      }

      const sessMatch = p.match(/^\/v1\/agents\/([^/]+)\/sessions$/)
      if (sessMatch && method === 'GET') {
        sendJson(res, 200, { ok: true, sessions: await sessionsFor(decodeURIComponent(sessMatch[1])) })
        return true
      }

      // ---------- 跨 agent 会话（M2/D034） ----------
      if (p === '/v1/sessions' && method === 'GET') {
        if (!liveTracker) {
          sendJson(res, 200, { ok: true, items: [], nextCursor: null, total: 0, counts: {}, aggregate: 'idle' })
          return true
        }
        const agent = text(url.searchParams.get('agent'), 24)
        const archivedRaw = String(url.searchParams.get('archived') || 'exclude')
        const archived = ['exclude', 'only', 'all'].includes(archivedRaw) ? archivedRaw : 'exclude'
        const rangeRaw = String(url.searchParams.get('range') || '')
        const q = {
          agent,
          status: text(url.searchParams.get('status'), 24),
          q: text(url.searchParams.get('q'), 100),
          sort: ['updated', 'tokens', 'cost', 'duration'].includes(String(url.searchParams.get('sort') || ''))
            ? String(url.searchParams.get('sort'))
            : 'updated',
          limit: Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50) || 50)),
          cursor: text(url.searchParams.get('cursor'), 200),
          // 归档视图没有显式 range 时默认全量，否则归档旧会话会被 30d 挡掉。
          range: archived === 'only' && !rangeRaw
            ? 'all'
            : ['today', '7d', '30d', 'all'].includes(rangeRaw)
              ? rangeRaw
              : '30d',
          archived,
        }
        const r = await liveTracker.list(q)
        sendJson(res, 200, {
          ok: true,
          items: (r.items || []).map((s) => sanitizeSession(s, { authorized })),
          nextCursor: r.nextCursor || null,
          total: r.total || 0,
          shownRoots: r.shownRoots || 0,
          rootTotal: r.rootTotal || 0,
          truncated: r.truncated === true,
          counts: r.counts || {},
          aggregate: r.aggregate || 'idle',
          byAgent: r.byAgent || {},
        })
        return true
      }

      const sessCtxMatch = p.match(/^\/v1\/sessions\/([^/]+)\/context$/)
      if (sessCtxMatch && method === 'GET') {
        const key = decodeURIComponent(sessCtxMatch[1])
        const idx = key.indexOf(':')
        const adapterId = idx > 0 ? key.slice(0, idx) : ''
        const sessionId = idx > 0 ? key.slice(idx + 1) : ''
        sendJson(res, 200, {
          ok: true,
          context: await contextFor(adapterId, {
            force: url.searchParams.get('force') === '1',
            session: sessionId,
            range: url.searchParams.get('range') || 'session',
          }),
        })
        return true
      }

      const sessFocusMatch = p.match(/^\/v1\/sessions\/([^/]+)\/focus$/)
      if (sessFocusMatch && method === 'POST') {
        if (!bridge) {
          sendJson(res, 503, { ok: false, error: 'bridge-unavailable' })
          return true
        }
        const key = decodeURIComponent(sessFocusMatch[1])
        const idx = key.indexOf(':')
        const agentId = idx > 0 ? key.slice(0, idx) : ''
        const sessionId = idx > 0 ? key.slice(idx + 1) : ''
        let cwd = ''
        try {
          const d = liveTracker ? await liveTracker.detail(key) : null
          cwd = (d && d.session && d.session.cwd) || ''
        } catch (err) {}
        const windows = (await windowsNow()).filter((w) => resolveAdapter(w, adapters).id === agentId)
        if (!windows.length) {
          sendJson(res, 404, { ok: false, error: 'host-window-not-found' })
          return true
        }
        // ① 标题包含 cwd 末级目录者优先 ② 绑定中的该 agent 窗口 ③ 该 agent 任一窗口。
        const tail = String(cwd || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || ''
        let pick =
          (tail && windows.find((w) => String(w.title || '').toLowerCase().includes(tail.toLowerCase()))) ||
          null
        if (!pick) {
          try {
            const hwndSet = new Set(windows.map((w) => String(w.hwnd)))
            const bound = readBindings(paths.bindings)
              .filter((b) => b && b.window && String(b.window.hwnd || '') && hwndSet.has(String(b.window.hwnd)))
              .map((b) => String(b.window.hwnd))
            if (bound.length) pick = windows.find((w) => String(w.hwnd) === bound[0]) || null
          } catch (err) {}
        }
        pick = pick || windows[0]
        const r = await bridge.focus(pick.hwnd)
        if (!r.ok) {
          sendJson(res, 404, { ok: false, error: r.error || 'host-window-not-found' })
          return true
        }
        sendJson(res, 200, { ok: true, method: r.method })
        return true
      }

      const sessDetailMatch = p.match(/^\/v1\/sessions\/([^/]+)$/)
      if (sessDetailMatch && method === 'GET') {
        if (!liveTracker) {
          sendJson(res, 404, { ok: false, error: 'session-not-found' })
          return true
        }
        const r = await liveTracker.detail(decodeURIComponent(sessDetailMatch[1]))
        if (!r.ok) {
          sendJson(res, r.error === 'bad-key' ? 400 : 404, r)
          return true
        }
        sendJson(res, 200, {
          ok: true,
          session: sanitizeSession(r.session, { authorized }),
          turns: (r.turns || []).map((t) => ({ ...t, model: redactHome(t.model || '') })),
          tools: r.tools || [],
          models: r.models || [],
        })
        return true
      }

      // ---------- 用量 ----------
      if (p === '/v1/usage' && method === 'GET') {
        const range = ['today', '7d', '30d'].includes(String(url.searchParams.get('range') || ''))
          ? String(url.searchParams.get('range'))
          : 'today'
        const days = range === 'today' ? 1 : range === '30d' ? 30 : 7
        const summary = summarize(paths.ledger, { now: Date.now(), days })
        sendJson(res, 200, {
          ok: true,
          range,
          groupBy: ['agent', 'vendor', 'model'].includes(String(url.searchParams.get('groupBy') || ''))
            ? String(url.searchParams.get('groupBy'))
            : 'agent',
          metric: url.searchParams.get('metric') === 'tokens' ? 'tokens' : 'money',
          today: summary.today,
          days: summary.days,
          // 模型与厂商维度来自适配器的逐条记录，M2/M3 填充；这里不伪造。
          models: [],
          modelsByTokens: [],
          rankTotal: null,
        })
        return true
      }

      // ---------- 用量下钻（M4） ----------
      if (p === '/v1/usage/breakdown' && method === 'GET') {
        if (!usageBreakdown) {
          sendJson(res, 503, { ok: false, error: 'breakdown-unavailable' })
          return true
        }
        const r = await usageBreakdown.get({
          by: text(url.searchParams.get('by'), 16) || 'agent',
          range: text(url.searchParams.get('range'), 16) || '7d',
          from: text(url.searchParams.get('from'), 10),
          to: text(url.searchParams.get('to'), 10),
          agent: text(url.searchParams.get('agent'), 24),
          currency: text(url.searchParams.get('currency'), 8),
          time: text(url.searchParams.get('time'), 5),
          compare: url.searchParams.get('compare') === '1',
        })
        res.setHeader('X-Fox-Cache', r.cached ? 'hit' : 'miss')
        if (!r.ok) {
          sendJson(res, r.status || 400, { ok: false, error: r.error || 'breakdown-failed' })
          return true
        }
        sendJson(res, 200, r)
        return true
      }

      // ---------- 厂商 ----------
      if (p === '/v1/vendors' && method === 'GET') {
        sendJson(res, 200, await vendorsPayload(url.searchParams.get('force') === '1'))
        return true
      }

      if (p === '/v1/vendors/import/candidates' && method === 'GET') {
        if (!engines) {
          sendJson(res, 503, { ok: false, error: 'engines-unavailable' })
          return true
        }
        const candidates = engines.discoverCandidates().map((c) => ({
          templateId: c.templateId,
          providerId: c.providerId,
          name: c.name,
          host: c.host,
          source: c.source,
          isLocal: c.isLocal,
          keyEncrypted: c.keyEncrypted,
          masked: c.masked,
        }))
        sendJson(res, 200, { ok: true, candidates })
        return true
      }

      if (p === '/v1/vendors/import' && method === 'POST') {
        if (!engines || !vault) {
          sendJson(res, 503, { ok: false, error: 'engines-unavailable' })
          return true
        }
        const body = await readBody(req)
        const r = engines.importCandidates(body.ids, vault)
        vendorCache = { at: 0, value: null }
        sendJson(res, 200, { ok: true, ...r })
        return true
      }

      // 余额校正：只记录人工修正，不写宿主
      const corrMatch = p.match(/^\/v1\/vendors\/([^/]+)\/corrections$/)
      if (corrMatch) {
        const id = decodeURIComponent(corrMatch[1])
        const file = path.join(paths.dir, 'balance-adjustments.json')
        if (method === 'GET') {
          sendJson(res, 200, { ok: true, corrections: listAdjustments(file, id) })
          return true
        }
        if (method === 'POST') {
          const body = await readBody(req)
          try {
            const item = addAdjustment(file, {
              vendorId: id,
              type: body.type,
              amount: body.amount,
              currency: body.currency,
              note: body.note,
            })
            vendorCache = { at: 0, value: null }
            sendJson(res, 200, { ok: true, correction: item })
          } catch (err) {
            sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
          }
          return true
        }
      }

      if (p.startsWith('/v1/vendors/corrections/') && method === 'DELETE') {
        const id = decodeURIComponent(p.slice('/v1/vendors/corrections/'.length))
        const r = removeAdjustment(path.join(paths.dir, 'balance-adjustments.json'), id)
        vendorCache = { at: 0, value: null }
        sendJson(res, 200, { ok: true, ...r })
        return true
      }

      const credMatch = p.match(/^\/v1\/vendors\/([^/]+)\/credential$/)
      if (credMatch) {
        const id = decodeURIComponent(credMatch[1])
        if (!vault) {
          sendJson(res, 503, { ok: false, error: 'vault-unavailable', hint: '非 Windows 请使用环境变量' })
          return true
        }
        try {
          if (method === 'POST' || method === 'PUT') {
            const body = await readBody(req)
            if (!body.key || typeof body.key !== 'string') {
              sendJson(res, 400, { ok: false, error: 'key-required' })
              return true
            }
            const saved = vault.set(id, body.key)
            vendorCache = { at: 0, value: null }
            sendJson(res, 200, { ok: true, id, maskedKey: saved.masked, source: 'vault' })
            return true
          }
          if (method === 'DELETE') {
            const r = vault.delete(id)
            vendorCache = { at: 0, value: null }
            sendJson(res, 200, { ok: true, ...r })
            return true
          }
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err).slice(0, 200) })
          return true
        }
      }

      const testMatch = p.match(/^\/v1\/vendors\/([^/]+)\/test$/)
      if (testMatch && method === 'POST') {
        if (!engines) {
          sendJson(res, 503, { ok: false, error: 'engines-unavailable' })
          return true
        }
        const r = await engines.testTemplate(decodeURIComponent(testMatch[1]))
        sendJson(res, 200, r)
        return true
      }

      if (p === '/v1/bindings' && method === 'GET') {
        sendJson(res, 200, { ok: true, bindings: readBindings(paths.bindings) })
        return true
      }

      // ---------- 设置与档案 ----------
      if (p === '/v1/settings' && method === 'GET') {
        sendJson(res, 200, { ok: true, settings: readSettings(paths.settings) })
        return true
      }

      if (p === '/v1/settings' && method === 'PUT') {
        const patch = await readBody(req)
        const settings = writeSettings(paths.settings, patch)
        await broadcastState()
        sendJson(res, 200, { ok: true, settings })
        return true
      }

      const profMatch = p.match(/^\/v1\/profiles\/([^/]+)$/)
      if (profMatch) {
        const id = decodeURIComponent(profMatch[1])
        if (method === 'GET') {
          const settings = readSettings(paths.settings)
          sendJson(res, 200, {
            ok: true,
            agentId: id,
            profile: getProfile(settings, id),
            override: settings.profiles[id] || null,
          })
          return true
        }
        if (method === 'PUT') {
          const patch = await readBody(req)
          writeProfile(paths.settings, id, patch)
          const settings = readSettings(paths.settings)
          await broadcastState()
          sendJson(res, 200, {
            ok: true,
            agentId: id,
            profile: getProfile(settings, id),
            override: settings.profiles[id] || null,
          })
          return true
        }
      }

      // ---------- 宠物状态机 ----------
      if (p.startsWith('/v1/pet/') && method === 'POST') {
        const action = p.slice('/v1/pet/'.length)
        const body = await readBody(req)
        const map = {
          attach: 'drop-on-agent',
          'drop-on-agent': 'drop-on-agent',
          float: 'drop-on-desktop',
          'drop-on-desktop': 'drop-on-desktop',
          reset: 'reset',
          'window-gone': 'agent-window-gone',
          'window-back': 'agent-window-back',
          move: 'move',
        }
        const type = map[action]
        if (!type) {
          sendJson(res, 404, { ok: false, error: 'unknown-pet-action', action })
          return true
        }
        if (type === 'drop-on-agent' && (!body.hwnd || (!body.agentId && !body.exe && !body.title))) {
          sendJson(res, 400, { ok: false, error: 'agentId-and-hwnd-required' })
          return true
        }
        // attach 支持传窗口描述；服务端判定适配器，不信任客户端自报。
        const det = resolveAdapter({ exe: body.exe, title: body.title, cls: body.cls }, adapters)
        const pet = petEvent(type, { ...body, agentId: det.id })
        if (type === 'drop-on-agent') {
          try {
          const key = buildBindKey({ exe: body.exe, pid: body.pid, startMs: body.startMs, hwnd: body.hwnd })
          upsertBinding(paths.bindings, {
            key,
            adapterId: det.id,
            anchor: body.anchor,
            window: {
              title: String(body.title || '').slice(0, 200),
              exe: String(body.exe || '').slice(0, 400),
              pid: Number(body.pid) || 0,
              startMs: Number(body.startMs) || 0,
              hwnd: String(body.hwnd || ''),
              cls: String(body.cls || '').slice(0, 120),
              rect: body.rect || null,
            },
          })
          } catch (err) {
            log('binding write skipped: ' + (err && err.message ? err.message : err))
          }
        }
        await broadcastState()
        sendJson(res, 200, { ok: true, pet })
        return true
      }

      // ---------- 事件注入（M2 内部使用；M5 公开协议） ----------
      if (p === '/v1/ingest' && method === 'POST') {
        const settings = readSettings(paths.settings)
        if (!settings.ingest || settings.ingest.enabled === false) {
          sendJson(res, 403, { ok: false, error: 'ingest-disabled' })
          return true
        }
        if (!rateAllowed(Date.now())) {
          sendJson(res, 429, { ok: false, error: 'rate-limited' })
          return true
        }
        let body = null
        try {
          body = await readBody(req, MAX_BODY_BYTES)
        } catch (err) {
          sendJson(res, err && err.code === 'too-large' ? 413 : 400, {
            ok: false,
            error: err && err.code === 'too-large' ? 'body-too-large' : 'bad-json',
          })
          return true
        }
        const v = validateIngest(body, { now: Date.now() })
        if (!v.ok) {
          sendJson(res, v.status || 400, { ok: false, error: v.error })
          return true
        }
        if (!liveTracker) {
          sendJson(res, 503, { ok: false, error: 'live-unavailable' })
          return true
        }
        if (v.duplicate) {
          sendJson(res, 200, { ok: true, duplicate: true, eventId: null })
          return true
        }
        const event = v.event
        // 高风险判定（D036）用「未截断的脱敏文本 + 宿主自报 riskLevel」：展示用
        // preview 截到 400 字会漏掉「长前缀 + 危险命令尾」，MCP 写工具也要按写
        // 工具检查路径。判定只影响 UI 保护（热键/默认焦点/徽标）。
        const permRisk = event.event === 'permission_request'
          ? // 判定用未脱敏的 riskText（脱敏规则会吞掉整段凭据参数后的命令，
            // 用 preview/riskPreview 判定会把 high 降成 normal）；riskText 只
            // 作为 validateIngest 的返回值存在，不挂在 event 上、不写库。
            assessRisk({ tool: event.tool, preview: v.riskText || event.riskPreview || event.preview, cwd: event.cwd, hostRisk: event.riskLevel })
          : null
        if (permRisk) event.risk = permRisk.level
        const r = liveTracker.ingest(event)
        // permission_resolved（宿主自己已处理）：联动 broker 收起对应卡片。
        if (event.event === 'permission_resolved' && event.requestId && broker) {
          broker.noteExternalResolved(event.requestId, event.decision)
        }
        // 权限请求：takeover 开启时一律登记进 ActionBroker（权限卡可见）；
        // 带 wait 的客户端再长轮询等决策。takeover 关闭只登记会话状态、不阻塞
        // 宿主（fail-open to host）。任何一条路都不阻塞宿主超过 wait 上限。
        if (event.event === 'permission_request' && broker && settings.permission && settings.permission.takeover === true) {
          const perm = settings.permission || {}
          const waitMs = Math.max(1000, Math.min(30000, Number(event.timeoutMs) || 15000))
          const created = broker.create({
            requestId: event.requestId,
            agentId: event.agentId,
            sessionId: event.sessionId,
            tool: event.tool,
            preview: event.preview,
            risk: permRisk ? permRisk.level : 'normal',
            ttlMs: Math.max(Number(perm.waitMs) || 15000, waitMs),
          })
          if (created.ignored && body && body.wait) {
            sendJson(res, 200, { ok: true, eventId: event.requestId || null, decision: 'ignored', requestId: event.requestId, reason: created.reason })
            return true
          }
        }
        const waitDecision = event.event === 'permission_request' && body && body.wait
        if (waitDecision && (!settings.permission || settings.permission.takeover !== true)) {
          sendJson(res, 200, { ok: true, eventId: event.requestId || null, decision: 'ignored', requestId: event.requestId })
          return true
        }
        if (waitDecision) {
          if (!broker || !broker.get(event.requestId)) {
            sendJson(res, 200, { ok: true, eventId: event.requestId || null, decision: 'timeout', requestId: event.requestId })
            return true
          }
          const waitMs = Math.max(1000, Math.min(30000, Number(event.timeoutMs) || 15000))
          const decision = await broker.wait(event.requestId, waitMs)
          sendJson(res, 200, { ok: true, eventId: event.requestId || null, decision, requestId: event.requestId })
          return true
        }
        sendJson(res, 200, { ok: true, eventId: event.requestId || null, changed: r.changed !== false })
        return true
      }

      // ---------- 首次接入向导（M6） ----------
      if (p === '/v1/onboarding' && method === 'GET') {
        const settings = readSettings(paths.settings)
        const windows = await windowsNow()
        const hosts = (adapters || [])
          .filter((a) => a && a.id !== 'generic' && a.capabilities && a.capabilities.billing)
          .map((a) => ({
            id: a.id,
            name: a.name,
            running: (windows || []).some((w) => resolveAdapter(w, adapters).id === a.id),
          }))
        // 旧挂件数据（只读探测，不导入）
        let legacy = { found: false, sources: [] }
        try {
          const inspected = inspectSources()
          // 匿名读面：旧挂件目录只用于展示来源，路径里的本机用户名不外发。
          legacy.sources = (inspected || []).map((s) => ({ id: s.id, label: s.label, dir: redactHome(s.dir || ''), categories: s.categories || {} }))
          legacy.found = legacy.sources.length > 0
        } catch (err) {}
        const integrationDir = path.join(DOCK_ROOT, 'integrations', 'zcode-plugin')
        sendJson(res, 200, {
          ok: true,
          onboarded: settings.onboarded === true,
          hosts,
          legacy,
          // 向导要把它复制到剪贴板给用户手动添加插件，只有持令牌的控制台能拿原路径。
          integrationDir: fs.existsSync(integrationDir) ? (authorized ? integrationDir : redactHome(integrationDir)) : '',
        })
        return true
      }
      if (p === '/v1/onboarding/complete' && method === 'POST') {
        const body = await readBody(req)
        const patch = { onboarded: true }
        if (body && body.autoStart !== undefined) patch.autoStart = body.autoStart === true
        const s = writeSettings(paths.settings, patch)
        sendJson(res, 200, { ok: true, settings: { onboarded: s.onboarded, autoStart: s.autoStart } })
        return true
      }

      // ---------- 音效库（1.x v1.16.3 语音库迁移） ----------
      if (p === '/v1/sounds' && method === 'GET') {
        sendJson(res, 200, listSounds(paths.settings))
        return true
      }
      if (p === '/v1/sounds/import' && method === 'POST') {
        let body = null
        try {
          body = await readBody(req, 9 * 1024 * 1024)
        } catch (err) {
          sendJson(res, err && err.code === 'too-large' ? 413 : 400, {
            ok: false,
            error: err && err.code === 'too-large' ? 'body-too-large' : 'bad-json',
          })
          return true
        }
        const r = saveSoundSet(paths.settings, body)
        sendJson(res, r.ok ? 200 : 400, r)
        return true
      }
      const soundDeleteMatch = p.match(/^\/v1\/sounds\/([^/]+)$/)
      if (soundDeleteMatch && method === 'DELETE') {
        const r = deleteSoundSet(paths.settings, decodeURIComponent(soundDeleteMatch[1]).slice(0, 44))
        sendJson(res, r.ok ? 200 : 400, r)
        return true
      }
      const soundFileMatch = p.match(/^\/v1\/sounds\/([^/]+)\/file\/(press|release)$/)
      if (soundFileMatch && method === 'GET') {
        // 导入集音频是用户私有内容，和 /v1/actions 同口径要求令牌：浮层走
        // 主进程 read-sound IPC（持令牌），浏览器/匿名进程不需要这个读面。
        if (!timingSafeEqual(req.headers['x-fox-token'], token)) {
          sendJson(res, 403, { ok: false, error: 'bad-token' })
          return true
        }
        const hit = resolveSoundBytes(decodeURIComponent(soundFileMatch[1]).slice(0, 44), soundFileMatch[2])
        if (!hit) {
          sendJson(res, 404, { ok: false, error: 'sound-not-found' })
          return true
        }
        res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'no-store' })
        res.end(hit.bytes)
        return true
      }

      // ---------- 待处理权限动作（M5） ----------
      // 待办里带命令预览与 requestId，等同于权限决策的「读取面」：即使写接口
      // 已要求令牌，答对 Host 就能匿名枚举 pending 也不合适。读也要求令牌
      // （UI 都经主进程持令牌转发；钩子/诊断走同一 lock 令牌）。
      if (p === '/v1/actions' && method === 'GET') {
        if (!timingSafeEqual(req.headers['x-fox-token'], token)) {
          sendJson(res, 403, { ok: false, error: 'bad-token' })
          return true
        }
        sendJson(res, 200, { ok: true, actions: broker ? broker.listPending() : [] })
        return true
      }
      const actionResolveMatch = p.match(/^\/v1\/actions\/([^/]+)\/resolve$/)
      if (actionResolveMatch && method === 'POST') {
        const body = await readBody(req)
        const id = decodeURIComponent(actionResolveMatch[1]).slice(0, 40)
        const decision = text(body.decision, 16)
        const via = text(body.via, 16) || 'console'
        if (!broker) {
          sendJson(res, 503, { ok: false, error: 'actions-unavailable' })
          return true
        }
        if (!RESOLVE_VIAS.includes(via) || via === 'timeout') {
          sendJson(res, 400, { ok: false, error: 'bad-via' })
          return true
        }
        const r = broker.resolve(id, decision, via)
        if (!r.ok) {
          // high-risk-host-only：高风险动作只能回宿主原生弹窗，任何通道都不允许
          // 由 daemon 代答「允许」。
          const status = r.error === 'not-found' ? 404 : r.error === 'conflict' ? 409 : r.error === 'high-risk-host-only' ? 403 : 400
          sendJson(res, status, { ok: false, error: r.error })
          return true
        }
        await broadcastState()
        sendJson(res, 200, { ok: true, action: r.action })
        return true
      }

      // ---------- 宿主事件（等确认提醒 / 轮开始） ----------
      if (p === '/v1/events' && method === 'POST') {
        const body = await readBody(req)
        const ev = {
          type: text(body.type, 40),
          agentId: text(body.agentId, 20),
          sessionId: text(body.sessionId, 80),
          at: Date.now(),
        }
        if (!ev.type) {
          sendJson(res, 400, { ok: false, error: 'type-required' })
          return true
        }
        events.push(ev)
        if (events.length > 200) events.shift()
        if (sse) sse.broadcast('event', ev)
        // 旧入口映射到 ingest：permission-request → waiting_permission 等。
        if (liveTracker) {
          const mapped = mapLegacyEvent(ev.type, ev.agentId)
          if (ev.sessionId) mapped.sessionId = ev.sessionId
          if (ev.type === 'permission-request') {
            mapped.event = 'permission_request'
            mapped.sessionId = ev.sessionId || 'legacy'
            mapped.requestId = 'legacy-' + ev.at.toString(36) + '-000000'
            mapped.tool = text(body.tool, 80)
          }
          const v = validateIngest(mapped, { now: Date.now() })
          if (v.ok && !v.duplicate) liveTracker.ingest(v.event)
        }
        sendJson(res, 200, { ok: true, event: ev })
        return true
      }

      // ---------- 旧挂件数据导入 ----------
      if (p === '/v1/import/sources' && method === 'GET') {
        sendJson(res, 200, { ok: true, sources: inspectSources(), categories: CATEGORIES })
        return true
      }

      if (p === '/v1/import' && method === 'POST') {
        const body = await readBody(req)
        try {
          const r = await importCategories({
            source: body.source,
            categories: body.categories,
            paths,
            env: process.env,
          })
          if (r.settingsPatch && Object.keys(r.settingsPatch).length) {
            writeSettings(paths.settings, r.settingsPatch)
            await broadcastState()
          }
          sendJson(res, 200, { ok: true, ...r })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
        return true
      }

      // ---------- Win32 桥重启（显示缩放/分辨率变化后 DPI 上下文要重建） ----------
      // PowerShell 桥在启动时确定 DPI 感知上下文；用户改了显示缩放后，桥返回的
      // 窗口矩形仍按旧缩放换算（实测 150%→125% 时偏大 1.2 倍），浮层按新 DPI
      // 摆放就会把角色放到宿主窗口下方。浮层监听 display-metrics-changed 后调用
      // 这个端点重建桥，再按新工作区重设窗口。
      if (p === '/v1/maintenance/bridge-restart' && method === 'POST') {
        try {
          if (bridge && typeof bridge.stop === 'function') bridge.stop()
          if (bridge && typeof bridge.start === 'function') await bridge.start()
          sendJson(res, 200, { ok: true, running: !!(bridge && bridge.running) })
        } catch (err) {
          sendJson(res, 503, { ok: false, error: String((err && err.message) || err) })
        }
        return true
      }

      // ---------- 开机自启（控制台与托盘共用同一条安装/移除路径） ----------
      if (p === '/v1/maintenance/autostart' && (method === 'GET' || method === 'POST')) {
        try {
          if (method === 'GET') {
            sendJson(res, 200, { ok: true, installed: typeof getAutoStart === 'function' ? !!getAutoStart() : false })
            return true
          }
          const body = await readBody(req)
          const r = typeof setAutoStart === 'function' ? setAutoStart(body.enabled === true) : { enabled: false, installed: false }
          sendJson(res, 200, { ok: true, ...r })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
        return true
      }

      // ---------- 维护 ----------
      if (p === '/v1/maintenance/reset-settings' && method === 'POST') {
        const r = resetSettings(paths.settings)
        await broadcastState()
        sendJson(res, 200, { ok: true, settings: r.settings, backup: r.backup })
        return true
      }

      if (p === '/v1/maintenance/clear-usage' && method === 'POST') {
        for (const file of [paths.ledger, paths.contextHistory]) {
          try {
            fs.unlinkSync(file)
          } catch (err) {}
        }
        if (contextHistory && typeof contextHistory.clear === 'function') contextHistory.clear()
        sendJson(res, 200, { ok: true })
        return true
      }

      // ---------- 角色 / 气泡模板 ----------
      if (p === '/v1/roles' && method === 'GET') {
        const adapterDefaults = Object.fromEntries((adapters || []).map((a) => [a.id, a.roleDefault || '']).filter(([, r]) => r))
        const roleList = listRoles(paths).map((r) => ({
          ...r,
          defaultFor: Object.entries(adapterDefaults).filter(([, role]) => role === r.id).map(([id]) => id),
        }))
        sendJson(res, 200, { ok: true, roles: roleList, suggestedId: suggestRoleId('role', roleList.map((r) => r.id)) })
        return true
      }

      if (p === '/v1/roles/import' && method === 'POST') {
        const body = await readBody(req, 5 * 1024 * 1024)
        try {
          const b64 = String(body.dataBase64 || '')
          if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b64) || b64.length < 40) throw new Error('图片数据无效')
          const buffer = Buffer.from(b64, 'base64')
          const role = importRole({
            rolesDir: paths.rolesDir,
            indexFile: rolesIndexFile(paths),
            id: body.id,
            name: body.name,
            buffer,
            overwrite: body.overwrite === true,
          })
          await broadcastState()
          sendJson(res, 200, { ok: true, role })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
        return true
      }

      if (p === '/v1/roles/rename' && method === 'POST') {
        const body = await readBody(req)
        try {
          const role = renameRole({
            rolesDir: paths.rolesDir,
            indexFile: rolesIndexFile(paths),
            id: body.id,
            name: body.name,
          })
          sendJson(res, 200, { ok: true, role })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
        return true
      }

      const roleMatch = p.match(/^\/v1\/roles\/([^/]+)$/)
      if (roleMatch && method === 'DELETE') {
        try {
          const id = decodeURIComponent(roleMatch[1])
          const r = deleteRole({ rolesDir: paths.rolesDir, indexFile: rolesIndexFile(paths), id })
          sendJson(res, 200, { ok: true, ...r })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
        return true
      }

      if (p === '/v1/bubbles/templates' && method === 'GET') {
        sendJson(res, 200, { ok: true, templates: listBubbleTemplates(paths) })
        return true
      }

      if (p === '/v1/bubbles/queue' && method === 'GET') {
        const raw = readJsonFile(paths.bubbleQueue, [])
        const queue = Array.isArray(raw) ? raw : Array.isArray(raw && raw.queue) ? raw.queue : []
        sendJson(res, 200, { ok: true, queue: queue.slice(0, 12) })
        return true
      }

      if (p === '/v1/bubbles/queue' && method === 'POST') {
        const body = await readBody(req)
        const queue = (Array.isArray(body.queue) ? body.queue : []).slice(0, 12)
        writeJsonFile(paths.bubbleQueue, queue)
        sendJson(res, 200, { ok: true, queue })
        return true
      }

      if (p === '/v1/bubbles/templates' && method === 'POST') {
        const body = await readBody(req)
        const templates = Array.isArray(body.templates) ? body.templates.slice(0, 50) : []
        writeJsonFile(paths.bubbleTemplates, templates)
        sendJson(res, 200, { ok: true, templates })
        return true
      }

      // ---------- 诊断 ----------
      if (p === '/v1/diag/bundle' && (method === 'GET' || method === 'POST')) {
        const windows = await windowsNow()
        const settings = readSettings(paths.settings)
        sendJson(res, 200, {
          ok: true,
          generatedAt: new Date().toISOString(),
          app: 'fox-dock',
          version,
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
            port,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          },
          paths: { dataDir: redactHome(paths.dir) },
          agents: agentsFrom(windows),
          adapters: (adapters || []).map((a) => ({
            id: a.id,
            name: a.name,
            billing: !!(a.capabilities && a.capabilities.billing),
            context: !!(a.capabilities && a.capabilities.context),
            follow: !!(a.capabilities && a.capabilities.follow),
          })),
          settings: { ...settings, profiles: Object.keys(settings.profiles).length },
          bindings: readBindings(paths.bindings).slice(0, 20).map((b) => ({
            ...b,
            key: redactHome(b.key || ''),
            window: b.window ? { ...b.window, exe: redactHome(b.window.exe || ''), title: redactHome(b.window.title || '') } : null,
          })),
          events: events.slice(-40),
          live: liveTracker ? liveTracker.aggregate() : null,
          ingest: {
            enabled: !!(readSettings(paths.settings).ingest && readSettings(paths.settings).ingest.enabled !== false),
            // 诊断包会被导出/转发：安装目录里的本机用户名不落进包里。
            integrationDir: redactHome(path.join(DOCK_ROOT, 'integrations', 'zcode-plugin')),
          },
          update: typeof readUpdateState === 'function' ? readUpdateState() : null,
        })
        return true
      }

      sendJson(res, 404, { ok: false, error: 'not-found', path: p })
      return true
    } catch (err) {
      log('v1 error ' + p + ': ' + (err && err.message ? err.message : err))
      const tooLarge = err && err.code === 'too-large'
      sendJson(res, tooLarge ? 413 : 400, {
        ok: false,
        error: tooLarge ? 'body-too-large' : String((err && err.message) || err).slice(0, 300),
      })
      return true
    }
  }

  return {
    handle,
    contextFor,
    stateBody,
    petEvent,
    broadcastState,
    _events: events,
  }
}
