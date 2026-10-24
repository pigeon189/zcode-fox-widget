// 应用用量统计服务：按宿主调用 adapter.getStats，并做 60 秒缓存。
//
// 统计查询比单次快照重（ZCode 全量聚合约 100–200ms，WorkBuddy 首次扫
// transcript 更久），所以只在控制台打开统计页时按需计算；缓存按
// (agentId, range) 分开，force=1 可强制刷新。

import { rangeSince, timeZoneName, tzOffsetMs } from '../../adapters/stats.mjs'

export const STATS_TTL_MS = 60_000

export function createStatsService({ adapters, ttlMs = STATS_TTL_MS, now = () => Date.now() } = {}) {
  const cache = new Map()
  const inflight = new Map()

  function find(id) {
    return (adapters || []).find((a) => a && a.id === id) || null
  }

  async function compute(adapter, range, at, custom = null) {
    if (!adapter || typeof adapter.getStats !== 'function') {
      return { supported: false, range, reason: 'stats-unavailable', note: '该宿主暂不提供用量统计' }
    }
    const opts = {
      range: range === 'custom' ? 'all' : range,
      now: at,
      since: custom ? custom.since : rangeSince(range, at),
      until: custom ? custom.until : at,
      tzOffsetMs: tzOffsetMs(at),
      timeZone: timeZoneName(),
    }
    try {
      const value = await adapter.getStats(opts)
      return value && typeof value === 'object'
        ? value
        : { supported: false, range, reason: 'stats-failed', note: '统计结果为空' }
    } catch (err) {
      return { supported: false, range, reason: 'stats-failed', note: String((err && err.message) || err).slice(0, 200) }
    }
  }

  async function get(id, opts = {}) {
    const range = ['all', '7d', '30d', 'custom'].includes(opts.range) ? opts.range : 'all'
    const force = opts.force === true
    let custom = null
    if (range === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(String(opts.from || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(opts.to || ''))) {
      const f = String(opts.from)
      const t = String(opts.to)
      custom = {
        since: new Date(Number(f.slice(0, 4)), Number(f.slice(5, 7)) - 1, Number(f.slice(8, 10))).getTime(),
        until: new Date(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)) + 1).getTime() - 1,
      }
    }
    const key = id + '|' + range + (custom ? '|' + custom.since + '|' + custom.until : '')
    const at = now()
    const hit = cache.get(key)
    if (!force && hit && at - hit.at <= ttlMs) return { ...hit.value, cached: true }
    let p = inflight.get(key)
    if (!p) {
      p = compute(find(id), range, at, custom)
        .then((value) => {
          cache.set(key, { at, value })
          return value
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, p)
    }
    const value = await p
    return { ...value, cached: false }
  }

  return { get, clear: () => cache.clear() }
}
