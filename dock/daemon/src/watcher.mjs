// 进程观察器（T1.5）：发现已知 agent 首次出现/全部消失。
//
// 只在 daemon 里跑，3s 一次；命中判定复用适配器注册表，不按进程名子串猜。
// 副作用（自动吸附、气泡提示）由调用方订阅事件后决定。

import { resolveAdapter } from '../../adapters/registry.mjs'

export const WATCH_INTERVAL_MS = 3000

export function createAgentWatcher({ bridge, adapters, intervalMs = WATCH_INTERVAL_MS, now = () => Date.now() } = {}) {
  const seen = new Map() // agentId -> { hwnd, title, at }
  let timer = null
  let busy = false
  const handlers = { appear: [], gone: [] }

  function emit(kind, payload) {
    for (const fn of handlers[kind] || []) {
      try {
        fn(payload)
      } catch (err) {}
    }
  }

  async function poll() {
    if (busy || !bridge) return
    busy = true
    try {
      const windows = await bridge.snapshot()
      const current = new Map()
      for (const w of windows || []) {
        const det = resolveAdapter(w, adapters)
        if (det.fallback || !det.capabilities.follow) continue
        if (!current.has(det.id)) current.set(det.id, { hwnd: w.hwnd, title: w.title, pid: w.pid, at: now() })
      }
      for (const [id, win] of current) {
        if (!seen.has(id)) emit('appear', { agentId: id, name: (adapters || []).find((a) => a.id === id)?.name || id, window: win, at: now() })
      }
      for (const [id, win] of seen) {
        if (!current.has(id)) emit('gone', { agentId: id, window: win, at: now() })
      }
      seen.clear()
      for (const [id, win] of current) seen.set(id, win)
    } catch (err) {
      // 桥暂时失败不清空 seen：下一次轮询再判断，避免抖动出假「消失」
    } finally {
      busy = false
    }
  }

  return {
    start() {
      if (timer) return
      poll()
      timer = setInterval(poll, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
    on(kind, fn) {
      if (handlers[kind]) handlers[kind].push(fn)
      return () => {
        const i = handlers[kind].indexOf(fn)
        if (i >= 0) handlers[kind].splice(i, 1)
      }
    },
    async pollNow() {
      await poll()
    },
    known() {
      return [...seen.keys()]
    },
  }
}
