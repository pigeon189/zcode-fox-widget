// WorkBuddy 适配器：识别宿主窗口 + 读订阅积分消耗。
//
// 主口径是**积分**（宿主托管订阅，用户看不到逐笔金额），所以 unit='credit'，
// 不折算成钱——折算会让人以为那是账单。

import { readCreditUsage } from './transcripts.mjs'
import { listWorkbuddySessions, readWorkbuddyContext } from './context.mjs'
import { readWorkbuddyStats } from './stats.mjs'
import {
  getLiveStatus as readWorkbuddyLive,
  getSessionDetail as readWorkbuddySessionDetail,
  getSessions as readWorkbuddySessions,
  readToolUsageRows as readWorkbuddyToolRows,
  readUsageRows as readWorkbuddyUsageRows,
} from './sessions.mjs'
import { prov, unavailable } from '../../shared/provenance.mjs'

const REASON_TEXT = {
  'projects-missing': '找不到 WorkBuddy 的会话目录（~/.workbuddy/projects）',
}

function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M'
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K'
  return String(Math.round(v))
}

export const workbuddyAdapter = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  priority: 20,
  roleDefault: 'xiaoke',
  accent: '#0cc8a4',
  match: { exeBasenames: ['workbuddy.exe'] },
  capabilities: {
    billing: true,
    follow: true,
    context: true,
    stats: true,
    sessions: { list: true, detail: true, live: true, actions: [] },
  },

  getStats(opts = {}) {
    return readWorkbuddyStats(opts)
  },

  getContext(opts = {}) {
    return readWorkbuddyContext(opts)
  },

  listSessions(opts = {}) {
    return listWorkbuddySessions(opts)
  },

  getSessions(opts = {}) {
    return readWorkbuddySessions(opts)
  },

  getSessionDetail(sessionId, opts = {}) {
    return readWorkbuddySessionDetail(sessionId, opts)
  },

  getLiveStatus(opts = {}) {
    return readWorkbuddyLive(opts)
  },

  readUsageRows(opts = {}) {
    return readWorkbuddyUsageRows(opts)
  },

  readToolUsageRows(opts = {}) {
    return readWorkbuddyToolRows(opts)
  },

  createBilling(ctx = {}) {
    const now = typeof ctx.now === 'function' ? ctx.now : () => Date.now()
    return {
      async snapshot() {
        const r = readCreditUsage({ now: now() })
        if (!r.ok) return { supported: true, error: REASON_TEXT[r.reason] || r.reason }
        const details = [
          { label: '今日调用', value: String(r.today.events) + ' 次', hint: '按 transcript 内的模型调用统计' },
          { label: '今日 tokens', value: fmtTokens(r.today.tokens) },
        ]
        if (r.lastTurn) {
          details.push({ label: '上一轮调用', value: String(r.lastTurn.calls) + ' 次' })
          details.push({ label: '上一轮 tokens', value: fmtTokens(r.lastTurn.tokens) })
        }
        details.push({ label: '数据源', value: 'transcripts', hint: 'WorkBuddy 会话 transcript（只读）' })
        return {
          supported: true,
          unit: 'credit',
          today: { amount: r.today.credits, currency: 'CREDIT', byCurrency: { CREDIT: r.today.credits } },
          turn: r.lastTurn
            ? {
                amount: Math.round(r.lastTurn.credits * 10000) / 10000,
                currency: 'CREDIT',
                byCurrency: { CREDIT: Math.round(r.lastTurn.credits * 10000) / 10000 },
              }
            : null,
          quota: null,
          balance: null,
          quotaCard: {
            kind: 'plan',
            title: 'WorkBuddy',
            subtitle: '订阅积分',
            plan: 'WorkBuddy 订阅',
            note: '积分由 WorkBuddy 托管，挂件只统计消耗；余额/剩余积分以 WorkBuddy 客户端为准。',
          },
          details,
          plan: 'WorkBuddy 订阅',
          usage: {
            todayTokens: r.today.tokens,
            turnTokens: r.lastTurn ? r.lastTurn.tokens : 0,
          },
          provenance: {
            // 积分是宿主自己算好的，不折算成钱（折算会让人误以为是账单）。
            today: prov('exact', 'local-log', 'workbuddy:transcripts#rawUsage.credit'),
            turn: r.lastTurn
              ? prov('exact', 'local-log', 'workbuddy:transcripts#rawUsage.credit')
              : unavailable('no-data', 'workbuddy:transcripts', 'local-log'),
            balance: unavailable('host-unsupported', 'workbuddy:db', 'unknown'),
            quota: unavailable('host-unsupported', 'workbuddy:db', 'unknown'),
            usage: prov('exact', 'local-log', 'workbuddy:transcripts#rawUsage'),
          },
          source: 'workbuddy:transcripts',
        }
      },
    }
  },
}
