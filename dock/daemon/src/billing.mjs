// 计费快照服务（R4）：适配器调用 + 短 TTL 缓存 + 统一结构。
//
// 为什么要缓存：浮层每 2 秒轮询一次，而适配器要读 sqlite / 扫 transcript。
// 3 秒 TTL 足够让界面「几乎实时」，又不会把磁盘 IO 打满。
// 失败结果不进缓存（下一次立刻重试），成功结果按适配器维度缓存。

import { normalizeSnapshot } from '../../adapters/contracts.mjs'
import { resolveAdapter } from '../../adapters/registry.mjs'

export const DEFAULT_TTL_MS = 3000

export function createBillingService({ adapters, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const cache = new Map() // adapterId -> { at, value }
  const inflight = new Map() // adapterId -> Promise

  function unsupported(det) {
    return normalizeSnapshot(
      { supported: false },
      { adapterId: det.id, adapterName: det.name, now: now() }
    )
  }

  async function compute(det, win) {
    const adapter = det.adapter
    try {
      const billing = adapter.createBilling({ now })
      if (!billing || typeof billing.snapshot !== 'function') {
        return { ok: false, adapterId: det.id, adapterName: det.name, supported: true, error: 'adapter has no snapshot()' }
      }
      const raw = await billing.snapshot({ window: win })
      return normalizeSnapshot(raw, { adapterId: det.id, adapterName: det.name, now: now() })
    } catch (err) {
      return {
        ok: false,
        adapterId: det.id,
        adapterName: det.name,
        supported: true,
        capturedAt: now(),
        unit: null,
        today: null,
        turn: null,
        balance: null,
        quota: null,
        source: '',
        error: String((err && err.message) || err).slice(0, 300),
      }
    }
  }

  return {
    // win：窗口描述（exe/title/cls/pid...）；返回统一快照
    async snapshot(win, opts = {}) {
      const det = resolveAdapter(win, adapters)
      if (!det.capabilities.billing) return unsupported(det)

      const key = det.id
      const ttl = Number.isFinite(opts.ttlMs) ? Number(opts.ttlMs) : ttlMs
      const hit = cache.get(key)
      if (!opts.force && hit && now() - hit.at <= ttl) {
        return { ...hit.value, cached: true }
      }

      // 同一个适配器的并发请求合并成一次（浮层与 CLI 同时问也只读一次盘）
      let p = inflight.get(key)
      if (!p) {
        p = compute(det, win).finally(() => inflight.delete(key))
        inflight.set(key, p)
      }
      const value = await p

      if (value.ok) cache.set(key, { at: now(), value })
      else cache.delete(key)
      return value
    },

    // 给测试/诊断用
    _cacheSize() {
      return cache.size
    },
    _reset() {
      cache.clear()
    },
  }
}
