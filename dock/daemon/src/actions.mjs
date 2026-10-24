// ActionBroker（D036 / PLAN §6.3）：权限请求的登记、长轮询与一次性决策。
//
// 硬约束：
//   · create 幂等：相同 requestId 返回同一个 pending，不重复计数；
//   · 上限：同会话最多 5 个、同 agent 最多 20 个 pending，超限直接 ignored
//     （钩子侧 fail-open 交回宿主原生弹窗）；
//   · resolve 只允许 pending → allowed|denied 一次，重复 resolve 是 409；
//   · 到期（expiresAt）→ timeout，等待方拿到 'timeout'，宿主侧 fail-open；
//   · daemon 重启不持久化：pending 全部消失，钩子因连接断开自然 fail-open；
//   · 审计只记 id/tool/decision/via，绝不记预览原文。

export const DECISIONS = ['allow', 'deny']
export const TERMINAL_STATES = ['allowed', 'denied', 'timeout', 'ignored']
export const RESOLVE_VIAS = ['pet', 'console', 'hotkey', 'notification', 'timeout', 'host']

export const MAX_PER_SESSION = 5
export const MAX_PER_AGENT = 20
const AUDIT_CAP = 200

export function createActionBroker({ sse = null, log = () => {}, now = () => Date.now() } = {}) {
  const pending = new Map() // id -> action
  const waiters = new Map() // id -> Set<{ settle, timer, onAbort }>
  const audit = []
  let sweep = null

  function broadcast(op, action) {
    if (!sse) return
    try {
      sse.broadcast('action', { op, action: publicView(action) })
    } catch (err) {
      log('action sse broadcast failed: ' + (err && err.message ? err.message : err))
    }
  }

  function publicView(a) {
    return {
      id: a.id,
      kind: a.kind,
      agentId: a.agentId,
      sessionKey: a.sessionKey,
      tool: a.tool,
      preview: a.preview,
      risk: a.risk,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
      state: a.state,
    }
  }

  function countPending(filter) {
    let n = 0
    for (const a of pending.values()) {
      if (a.state === 'pending' && filter(a)) n += 1
    }
    return n
  }

  function settleWaiters(id, decision) {
    const set = waiters.get(id)
    if (!set) return
    waiters.delete(id)
    for (const w of set) {
      if (w.timer) clearTimeout(w.timer)
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort)
      try {
        w.settle(decision)
      } catch (err) {}
    }
  }

  function finish(action, state) {
    action.state = state
    settleWaiters(action.id, state === 'allowed' ? 'allow' : state === 'denied' ? 'deny' : 'timeout')
    broadcast('update', action)
    broadcast('remove', action)
    scheduleSweep()
  }

  function auditPush(entry) {
    audit.push(entry)
    if (audit.length > AUDIT_CAP) audit.splice(0, audit.length - AUDIT_CAP)
    log('action ' + entry.id + ' tool=' + entry.tool + ' decision=' + entry.decision + ' via=' + entry.via)
  }

  function ensureSweep() {
    if (sweep) return
    sweep = setInterval(() => {
      const t = now()
      let dirty = false
      for (const a of [...pending.values()]) {
        if (a.state === 'pending' && t >= a.expiresAt) {
          auditPush({ at: t, id: a.id, tool: a.tool, decision: 'timeout', via: 'timeout' })
          finish(a, 'timeout')
          dirty = true
        }
      }
      if (!dirty && !pending.size) stopSweep()
    }, 500)
    sweep.unref?.()
  }

  function stopSweep() {
    if (!sweep) return
    clearInterval(sweep)
    sweep = null
  }

  function scheduleSweep() {
    if ([...pending.values()].some((a) => a.state === 'pending')) ensureSweep()
    else stopSweep()
  }

  return {
    // 创建（幂等）。返回 { action } 或 { ignored: true, reason }。
    create({ requestId, agentId, sessionId, tool, preview, risk = 'normal', ttlMs = 30000, kind = 'permission' }) {
      const id = String(requestId || '')
      const existing = pending.get(id)
      if (existing && existing.state === 'pending') return { action: existing, created: false }
      if (existing) {
        // 上一轮已终结：以同 id 重开一个新的 pending（requestId 由客户端保证新鲜）。
        pending.delete(id)
      }
      const sessionKey = agentId + ':' + (sessionId || '-')
      if (countPending((a) => a.sessionKey === sessionKey) >= MAX_PER_SESSION) {
        return { ignored: true, reason: 'session-limit' }
      }
      if (countPending((a) => a.agentId === agentId) >= MAX_PER_AGENT) {
        return { ignored: true, reason: 'agent-limit' }
      }
      const t = now()
      const action = {
        id,
        kind,
        agentId: String(agentId || ''),
        sessionKey,
        tool: String(tool || ''),
        preview: String(preview || ''),
        risk: risk === 'high' ? 'high' : 'normal',
        createdAt: t,
        expiresAt: t + Math.max(1000, Number(ttlMs) || 30000),
        state: 'pending',
      }
      pending.set(id, action)
      broadcast('add', action)
      ensureSweep()
      return { action, created: true }
    },

    // 长轮询：等待该 id 的决策。返回 'allow' | 'deny' | 'timeout'。
    // 连接断开（AbortSignal）只是撤回等待，不影响 pending 本身。
    wait(id, timeoutMs = 15000, { signal = null } = {}) {
      const action = pending.get(id)
      if (!action || action.state !== 'pending') {
        return Promise.resolve(action && action.state === 'allowed' ? 'allow' : action && action.state === 'denied' ? 'deny' : 'timeout')
      }
      return new Promise((resolve) => {
        const w = { settle: resolve, timer: null, signal, onAbort: null }
        const remain = Math.max(0, action.expiresAt - now())
        const limit = Math.max(1, Number(timeoutMs) || 15000)
        w.timer = setTimeout(() => {
          const set = waiters.get(id)
          if (set) {
            set.delete(w)
            if (!set.size) waiters.delete(id)
          }
          if (signal && w.onAbort) signal.removeEventListener('abort', w.onAbort)
          resolve('timeout')
        }, Math.min(limit, remain))
        if (signal) {
          w.onAbort = () => {
            const set = waiters.get(id)
            if (set) {
              set.delete(w)
              if (!set.size) waiters.delete(id)
            }
            if (w.timer) clearTimeout(w.timer)
            resolve('timeout')
          }
          if (signal.aborted) w.onAbort()
          else signal.addEventListener('abort', w.onAbort, { once: true })
        }
        if (!waiters.has(id)) waiters.set(id, new Set())
        waiters.get(id).add(w)
      })
    },

    // 一次性决策。成功返回 { ok:true, action }；其余返回 { ok:false, error }。
    resolve(id, decision, via) {
      if (!RESOLVE_VIAS.includes(via)) return { ok: false, error: 'bad-via' }
      const action = pending.get(id)
      if (!action) return { ok: false, error: 'not-found' }
      if (action.state !== 'pending') return { ok: false, error: 'conflict' }
      if (!DECISIONS.includes(decision)) return { ok: false, error: 'bad-decision' }
      auditPush({ at: now(), id, tool: action.tool, decision, via })
      finish(action, decision === 'allow' ? 'allowed' : 'denied')
      return { ok: true, action: publicView(action) }
    },

    // ingest 的 permission_resolved（宿主自己已处理）联动：无 pending 忽略。
    noteExternalResolved(id, decision) {
      const action = pending.get(id)
      if (!action || action.state !== 'pending') return { ok: false, error: 'not-found' }
      const d = decision === 'allow' ? 'allow' : decision === 'deny' ? 'deny' : null
      if (!d) {
        auditPush({ at: now(), id, tool: action.tool, decision: String(decision || 'unknown'), via: 'host' })
        finish(action, 'timeout')
        return { ok: true, action: publicView(action) }
      }
      auditPush({ at: now(), id, tool: action.tool, decision: d, via: 'host' })
      finish(action, d === 'allow' ? 'allowed' : 'denied')
      return { ok: true, action: publicView(action) }
    },

    get(id) {
      const a = pending.get(id)
      return a ? publicView(a) : null
    },

    listPending() {
      return [...pending.values()].filter((a) => a.state === 'pending').map(publicView)
    },

    listAudit() {
      return audit.slice()
    },

    // 测试/重启清理：放弃所有 pending（等价于 daemon 重启的语义）。
    reset() {
      for (const a of [...pending.values()]) {
        if (a.state === 'pending') {
          settleWaiters(a.id, 'timeout')
        }
      }
      pending.clear()
      stopSweep()
    },
  }
}
