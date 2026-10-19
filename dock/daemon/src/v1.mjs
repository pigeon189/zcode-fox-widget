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
import { normalizeContext } from '../../adapters/contracts.mjs'
import { resolveAdapter } from '../../adapters/registry.mjs'
import { readBindings } from './bindings.mjs'
import { getProfile, readSettings, resetSettings, writePet, writeProfile, writeSettings } from './settings.mjs'
import { recordSnapshot, summarize } from './ledger.mjs'
import { transition } from './state-machine.mjs'
import { deleteRole, importRole, listRoleLibrary, renameRole, suggestRoleId } from './roles.mjs'
import { addAdjustment, adjustmentSummary, applyAdjustments, listAdjustments, removeAdjustment } from './balance-adjustments.mjs'

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
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
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

function redactHome(value) {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return home ? String(value).split(home).join('~') : String(value)
}

function rolesIndexFile(paths) {
  return path.join(paths.dir, 'roles.json')
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
    sse,
    bridge,
    getPort,
    readUpdateState,
    contextService,
    contextHistory,
    engines,
    vault,
    log = () => {},
  } = deps

  const events = []
  let vendorCache = { at: 0, value: null }
  const VENDOR_TTL_MS = 30_000

  async function vendorsPayload(force) {
    if (engines) {
      if (!force && vendorCache.value && Date.now() - vendorCache.at < VENDOR_TTL_MS) return { ...vendorCache.value, cached: true }
      const r = await engines.listVendorStatus(force)
      const adjFile = path.join(paths.dir, 'balance-adjustments.json')
      const vendors = (r.vendors || []).map((v) => {
        const items = listAdjustments(adjFile, v.id)
        const summary = adjustmentSummary(items, v.currency || 'CNY')
        const balance = v.balance == null ? v.balance : applyAdjustments(v.balance, items, v.currency || 'CNY')
        return {
          ...v,
          balance,
          // 前端只消费稳定字段；keySource/keyMasked 也保留（掩码，不是密钥）
          configured: !!(v.keyMasked || (v.keySource && v.keySource !== 'none')),
          status: v.available ? 'ok' : 'unavailable',
          corrections: summary,
        }
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
        windows: wins.map((w) => ({ hwnd: w.hwnd, pid: w.pid, title: text(w.title, 200), rect: w.rect })),
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
    if (isWrite && !timingSafeEqual(req.headers['x-fox-token'], token)) {
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
        if (sse) sse.subscribe(req, res)
        else sendJson(res, 503, { ok: false, error: 'sse-unavailable' })
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
        if (type === 'drop-on-agent' && (!body.agentId || !body.hwnd)) {
          sendJson(res, 400, { ok: false, error: 'agentId-and-hwnd-required' })
          return true
        }
        // attach 支持传窗口描述；服务端判定适配器，不信任客户端自报。
        const agentId =
          body.agentId ||
          resolveAdapter({ exe: body.exe, title: body.title, cls: body.cls }, adapters).id
        const pet = petEvent(type, { ...body, agentId })
        await broadcastState()
        sendJson(res, 200, { ok: true, pet })
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
        sendJson(res, 200, { ok: true, event: ev })
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
        sendJson(res, 200, { ok: true, roles: listRoles(paths), suggestedId: suggestRoleId('role', listRoles(paths).map((r) => r.id)) })
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
          bindings: readBindings(paths.bindings).slice(0, 20),
          events: events.slice(-40),
          update: typeof readUpdateState === 'function' ? readUpdateState() : null,
        })
        return true
      }

      sendJson(res, 404, { ok: false, error: 'not-found', path: p })
      return true
    } catch (err) {
      log('v1 error ' + p + ': ' + (err && err.message ? err.message : err))
      sendJson(res, 400, { ok: false, error: String((err && err.message) || err).slice(0, 300) })
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
