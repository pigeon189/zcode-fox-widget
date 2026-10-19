// 上下文服务：适配器调用 + 归一 + 短 TTL + 历史采样。v1 与调度器共用同一份缓存。

import { normalizeContext } from '../../adapters/contracts.mjs'

export const DEFAULT_CONTEXT_TTL_MS = 3000

export function createContextService({ adapters, history, ttlMs = DEFAULT_CONTEXT_TTL_MS, now = () => Date.now() } = {}) {
  const cache = new Map()
  const inflight = new Map()

  function adapterOf(id) {
    return (adapters || []).find((a) => a && a.id === id) || null
  }

  function unsupported(id, reason = 'no-data') {
    const a = adapterOf(id)
    return normalizeContext({ supported: false, reason }, { adapterId: id, adapterName: a ? a.name : id })
  }

  async function compute(adapter, query) {
    const nowMs = now()
    const raw = await adapter.getContext({ now: () => nowMs, session: query.session || '', range: query.range || 'session' })
    const value = normalizeContext(raw, { adapterId: adapter.id, adapterName: adapter.name })
    if (history && value.supported) {
      const points = history.record(adapter.id, value)
      if (points && points.length && (!value.points || !value.points.length)) value.points = points
    }
    return value
  }

  return {
    async get(adapterId, query = {}) {
      const id = String(adapterId || '')
      const adapter = adapterOf(id)
      if (!adapter || typeof adapter.getContext !== 'function') return unsupported(id, 'no-data')
      const key = id + '|' + String(query.session || '')
      const hit = cache.get(key)
      if (!query.force && hit && now() - hit.at <= ttlMs) return hit.value
      let p = inflight.get(key)
      if (!p) {
        p = compute(adapter, query)
          .catch((err) =>
            normalizeContext(
              { supported: false, reason: 'schema', error: String((err && err.message) || err).slice(0, 200) },
              { adapterId: id, adapterName: adapter.name }
            )
          )
          .finally(() => inflight.delete(key))
        inflight.set(key, p)
      }
      const value = await p
      cache.set(key, { at: now(), value })
      return value
    },

    async sessions(adapterId, opts = {}) {
      const adapter = adapterOf(String(adapterId || ''))
      if (!adapter || typeof adapter.listSessions !== 'function') return []
      try {
        const r = await adapter.listSessions({ limit: opts.limit || 8 })
        return Array.isArray(r) ? r.slice(0, 20) : []
      } catch (err) {
        return []
      }
    },

    _reset() {
      cache.clear()
    },
  }
}
