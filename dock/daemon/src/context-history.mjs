// 上下文趋势采样（M2）。
//
// 宿主自己能给历史的（ZCode 的 model_usage、dsh 的 usage 事件）由适配器直接回填；
// 给不了历史的（Kimi、WB 的 DB）由 daemon 每次拿到新 used 时追加一点。
//
// 约束：
//   · 每个 (agent, session) 最多 240 点；
//   · 只保留 24 小时；
//   · 落盘文件 ≤ 2MB，超出丢最旧会话；
//   · 写入去抖 2s，daemon 被 kill 最多丢 2 秒的采样。

import fs from 'node:fs'
import path from 'node:path'

export const MAX_POINTS = 240
export const KEEP_MS = 24 * 3600_000
export const MAX_BYTES = 2 * 1024 * 1024
export const SAMPLE_GAP_MS = 30_000
export const WRITE_DEBOUNCE_MS = 2000

function keyOf(agentId, sessionId) {
  return String(agentId) + '|' + String(sessionId || '')
}

function clonePoints(points) {
  return (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.used)))
    .map((p) => ({ t: Math.round(Number(p.t)), used: Math.max(0, Math.round(Number(p.used))) }))
}

function dedupe(points) {
  const map = new Map()
  for (const p of points) map.set(p.t, p)
  return [...map.values()].sort((a, b) => a.t - b.t).slice(-MAX_POINTS)
}

export function createContextHistory({ file, now = () => Date.now(), maxBytes = MAX_BYTES, keepMs = KEEP_MS } = {}) {
  let data = { version: 1, sessions: {} }
  let loaded = false
  let timer = null

  function load() {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') {
        for (const [key, value] of Object.entries(raw.sessions)) {
          if (!value || typeof value !== 'object') continue
          data.sessions[key] = {
            agentId: String(value.agentId || ''),
            sessionId: String(value.sessionId || ''),
            updatedAt: Number(value.updatedAt) || 0,
            points: clonePoints(value.points).slice(-MAX_POINTS),
          }
        }
      }
    } catch (err) {
      data = { version: 1, sessions: {} }
    }
  }

  function prune(nowMs) {
    for (const [key, value] of Object.entries(data.sessions)) {
      if (!value.updatedAt || nowMs - value.updatedAt > keepMs) delete data.sessions[key]
    }
    // 体积闸：仍然超限时按 updatedAt 从旧到新删
    let text = JSON.stringify(data)
    if (Buffer.byteLength(text) <= maxBytes) return
    const keys = Object.keys(data.sessions).sort((a, b) => (data.sessions[a].updatedAt || 0) - (data.sessions[b].updatedAt || 0))
    for (const k of keys) {
      delete data.sessions[k]
      text = JSON.stringify(data)
      if (Buffer.byteLength(text) <= maxBytes) break
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!file) return
    try {
      prune(now())
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.' + process.pid + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data))
      fs.renameSync(tmp, file)
    } catch (err) {}
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, WRITE_DEBOUNCE_MS)
    timer.unref?.()
  }

  return {
    record(agentId, context) {
      load()
      if (!context || context.supported !== true || !Number.isFinite(Number(context.used))) return null
      const nowMs = now()
      const key = keyOf(agentId, context.sessionId)
      const entry =
        data.sessions[key] ||
        (data.sessions[key] = { agentId: String(agentId), sessionId: String(context.sessionId || ''), updatedAt: nowMs, points: [] })
      entry.updatedAt = nowMs
      // 宿主历史优先：先并进去重，再按采样规则补当前点
      const merged = dedupe([...clonePoints(context.points), ...entry.points])
      const last = merged[merged.length - 1]
      const used = Math.round(Number(context.used))
      if (!last || last.used !== used || nowMs - last.t >= SAMPLE_GAP_MS) {
        merged.push({ t: nowMs, used })
      }
      entry.points = dedupe(merged).slice(-MAX_POINTS)
      schedule()
      return entry.points
    },

    get(agentId, sessionId) {
      load()
      const entry = data.sessions[keyOf(agentId, sessionId)]
      return entry ? entry.points.slice() : []
    },

    clear() {
      data = { version: 1, sessions: {} }
      loaded = true
      flush()
    },

    flush,
    _data: () => data,
  }
}
