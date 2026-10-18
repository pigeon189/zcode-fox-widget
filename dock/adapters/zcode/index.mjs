// ZCode 适配器：识别宿主窗口 + 读本机用量库。
//
// 匹配只认 exe 基名（ZCode.exe）。这样不会误伤：
//   · ZCode 的浮层挂件（electron.exe）
//   · 其他以 zcode 命名的脚本进程
// 标题不参与匹配——标题里有项目名，用户一改就会抖动。

import { readUsage, dominantCurrency } from './store.mjs'

const REASON_TEXT = {
  'sqlite-unavailable': '当前 Node 没有 node:sqlite（需 ≥ 22.5）',
  'db-missing': '找不到 ZCode 用量库（~/.zcode/cli/db/db.sqlite）',
  'db-unavailable': 'ZCode 用量库暂时打不开',
  'db-read-failed': 'ZCode 用量库读取失败',
}

export const zcodeAdapter = {
  id: 'zcode',
  name: 'ZCode',
  priority: 20,
  match: { exeBasenames: ['zcode.exe'] },
  capabilities: { billing: true, follow: true },

  createBilling(ctx = {}) {
    const now = typeof ctx.now === 'function' ? ctx.now : () => Date.now()
    return {
      async snapshot() {
        const r = readUsage({ now: now() })
        if (!r.ok) {
          return { supported: true, error: REASON_TEXT[r.reason] || r.reason }
        }
        const byCur = r.today.byCurrency
        const cur = dominantCurrency(byCur)
        return {
          supported: true,
          unit: 'money',
          today: { amount: byCur[cur] || 0, currency: cur, byCurrency: byCur },
          turn: r.lastTurn
            ? {
                amount: r.lastTurn.amount,
                currency: r.lastTurn.currency,
                byCurrency: { [r.lastTurn.currency]: r.lastTurn.amount },
              }
            : null,
          quota: null,
          balance: null,
          source: 'zcode:db.sqlite',
        }
      },
    }
  },
}
