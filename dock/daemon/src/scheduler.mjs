// 上下文调度（M2）：
//   · 有 SSE 订阅者或该 agent 是当前档案属主时按 pollMs 轮询；
//   · 其余情况降到 idleMs（30s），避免空转读盘；
//   · 失败指数退避到 60s，成功后立即恢复；
//   · 只在内容变化时广播 context 事件。

export const DEFAULT_POLL_MS = { default: 3000, dsh: 5000, kimi: 3000 }
export const IDLE_MS = 30_000
export const MAX_BACKOFF_MS = 60_000

export function createContextScheduler({
  adapters,
  service,
  sse,
  getSettings = () => ({}),
  pollMs = DEFAULT_POLL_MS,
  idleMs = IDLE_MS,
  now = () => Date.now(),
} = {}) {
  const state = new Map() // adapterId -> { lastAt, fail, backoffUntil, lastFingerprint }
  let timer = null
  let busy = false

  const contextAdapters = (adapters || []).filter((a) => a && a.capabilities && a.capabilities.context)

  function intervalFor(id, active) {
    if (!active) return idleMs
    return Number(pollMs[id] || pollMs.default) || 3000
  }

  function fingerprint(ctx) {
    if (!ctx) return ''
    const compaction = ctx.compaction ? ctx.compaction.lastAt || '' : ''
    return [ctx.supported, ctx.sessionId, ctx.used, ctx.limit, ctx.pct, ctx.updatedAt, compaction, ctx.reason || ''].join('|')
  }

  async function tick() {
    if (busy) return
    busy = true
    try {
      const settings = getSettings() || {}
      const owner = settings.pet && (settings.pet.profileOf || settings.pet.agentId)
      const subscribed = sse ? sse.clientCount() > 0 : false
      const nowMs = now()
      for (const adapter of contextAdapters) {
        const s = state.get(adapter.id) || { lastAt: 0, fail: 0, backoffUntil: 0, lastFingerprint: '' }
        state.set(adapter.id, s)
        if (nowMs < s.backoffUntil) continue
        const active = subscribed || (owner && owner === adapter.id)
        // 没有订阅者、也不是当前档案属主时不读盘：常驻进程不该在后台空转。
        // 一旦 UI 连上或吸附到该 agent，下一次 tick 立刻取数（lastAt 还是 0）。
        if (!active) continue
        if (nowMs - s.lastAt < intervalFor(adapter.id, true)) continue
        s.lastAt = nowMs
        try {
          const ctx = await service.get(adapter.id, { force: true })
          if (ctx.ok === false || ctx.supported === false) {
            s.fail += 1
            s.backoffUntil = nowMs + Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, s.fail))
          } else {
            s.fail = 0
            s.backoffUntil = 0
          }
          const fp = fingerprint(ctx)
          if (sse && fp !== s.lastFingerprint) {
            s.lastFingerprint = fp
            sse.broadcast('context', { adapterId: adapter.id, context: ctx })
          }
        } catch (err) {
          s.fail += 1
          s.backoffUntil = nowMs + Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, s.fail))
        }
      }
    } finally {
      busy = false
    }
  }

  return {
    start(intervalMs = 1000) {
      if (timer) return
      timer = setInterval(tick, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
    tick,
    _state: state,
  }
}
