// WorkBuddy 适配器：识别宿主窗口 + 读订阅积分消耗。
//
// 主口径是**积分**（宿主托管订阅，用户看不到逐笔金额），所以 unit='credit'，
// 不折算成钱——折算会让人以为那是账单。

import { readCreditUsage } from './transcripts.mjs'

const REASON_TEXT = {
  'projects-missing': '找不到 WorkBuddy 的会话目录（~/.workbuddy/projects）',
}

export const workbuddyAdapter = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  priority: 20,
  match: { exeBasenames: ['workbuddy.exe'] },
  capabilities: { billing: true, follow: true },

  createBilling(ctx = {}) {
    const now = typeof ctx.now === 'function' ? ctx.now : () => Date.now()
    return {
      async snapshot() {
        const r = readCreditUsage({ now: now() })
        if (!r.ok) return { supported: true, error: REASON_TEXT[r.reason] || r.reason }
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
          source: 'workbuddy:transcripts',
        }
      },
    }
  },
}
