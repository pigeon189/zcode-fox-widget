// ZCode 适配器：识别宿主窗口 + 读本机用量库。
//
// 匹配只认 exe 基名（ZCode.exe）。这样不会误伤：
//   · ZCode 的浮层挂件（electron.exe）
//   · 其他以 zcode 命名的脚本进程
// 标题不参与匹配——标题里有项目名，用户一改就会抖动。

import { readUsage, dominantCurrency } from './store.mjs'
import { listZcodeSessions, readZcodeContext } from './context.mjs'

const REASON_TEXT = {
  'sqlite-unavailable': '当前 Node 没有 node:sqlite（需 ≥ 22.5）',
  'db-missing': '找不到 ZCode 用量库（~/.zcode/cli/db/db.sqlite）',
  'db-unavailable': 'ZCode 用量库暂时打不开',
  'db-read-failed': 'ZCode 用量库读取失败',
}

function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M'
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K'
  return String(Math.round(v))
}

function fmtMoney(amount, currency) {
  const n = Number(amount) || 0
  const sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : (currency || '') + ' '
  const digits = n > 0 && n < 0.01 ? 4 : 2
  return sym + n.toFixed(digits)
}

export const zcodeAdapter = {
  id: 'zcode',
  name: 'ZCode',
  priority: 20,
  roleDefault: 'fox',
  accent: '#f0a04b',
  match: { exeBasenames: ['zcode.exe'] },
  capabilities: { billing: true, follow: true, context: true },

  getContext(opts = {}) {
    return readZcodeContext(opts)
  },

  listSessions(opts = {}) {
    return listZcodeSessions(opts)
  },

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
        const details = [
          { label: '今日 tokens', value: fmtTokens(r.today.tokens), hint: '按 ZCode 用量库逐次调用统计' },
          { label: '今日调用', value: String(r.today.calls) + ' 次' },
        ]
        // 厂商分布：ZCode 的用量库里本来就有 provider/model，按厂商拆开显示，
        // 不再只给一个「今日合计」。按 tokens 排序（不同币种金额不可直接相加）。
        const vendors = Object.entries(r.today.byVendor || {})
          .sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0))
          .slice(0, 8)
        for (const [id, v] of vendors) {
          const cur = dominantCurrency(v.byCurrency)
          const label = v.label || id
          details.push({
            label: '厂商 · ' + label,
            value: fmtMoney(v.byCurrency[cur], cur) + ' · ' + fmtTokens(v.tokens),
            hint: String(v.calls) + ' 次调用',
          })
        }
        if (r.lastTurn) {
          details.push({ label: '上一轮 tokens', value: fmtTokens(r.lastTurn.tokens) })
          details.push({ label: '上一轮调用', value: String(r.lastTurn.calls) + ' 次' })
        }
        details.push({ label: '数据源', value: 'db.sqlite', hint: 'ZCode 本机用量库（只读）' })
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
          quotaCard: {
            kind: 'plan',
            title: 'ZCode',
            subtitle: '按厂商口径计费',
            plan: 'ZCode',
            note: '今日消耗按 ZCode 用量库逐轮计价；余额/套餐取决于当前 provider，由 ZCode 侧的价目与额度源决定。',
          },
          details,
          plan: 'ZCode',
          usage: {
            todayTokens: r.today.tokens,
            turnTokens: r.lastTurn ? r.lastTurn.tokens : 0,
          },
          source: 'zcode:db.sqlite',
        }
      },
    }
  },
}
