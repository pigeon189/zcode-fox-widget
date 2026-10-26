// ZCode 适配器：识别宿主窗口 + 读本机用量库 + 当前 provider 的额度/余额。
//
// 匹配只认 exe 基名（ZCode.exe）。这样不会误伤：
//   · ZCode 的浮层挂件（electron.exe）
//   · 其他以 zcode 命名的脚本进程
// 标题不参与匹配——标题里有项目名，用户一改就会抖动。

import { readAppStats, readUsage, dominantCurrency } from './store.mjs'
import { listZcodeSessions, readZcodeContext } from './context.mjs'
import {
  aggregateUsage as aggregateZcodeUsage,
  getLiveStatus as readZcodeLive,
  getArchivedKeys as readZcodeArchivedKeys,
  getSessionDetail as readZcodeSessionDetail,
  getSessions as readZcodeSessions,
  readToolUsageRows as readZcodeToolRows,
  readUsageRows as readZcodeUsageRows,
} from './sessions.mjs'
import { listVendorStatus } from '../../engines/vendors.mjs'
import { periodFor } from '../../engines/pricing.mjs'
import { prov, unavailable } from '../../shared/provenance.mjs'
import { PRICING_SNAPSHOT_DATE } from '../../shared/pricing-meta.mjs'

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

// 当前 provider -> 厂商模板。providerId 里可能带套餐/接入方式后缀，
// 用子串判定；认不出的 provider 不硬套余额（宁可不显示，也不张冠李戴）。
function vendorForProvider(vendors, provider) {
  const p = String(provider || '').toLowerCase()
  const byId = (id) => vendors.find((v) => v && v.id === id) || null
  if (!p) return null
  if (p.includes('commandcode') || p.includes('cmdgo')) return byId('commandcode')
  if (p.includes('deepseek')) return byId('deepseek')
  if (p.includes('bigmodel') || p.includes('zhipu') || p.includes('zai') || p.includes('glm')) {
    const plan = byId('zcode-plan')
    if (plan && plan.available && Number.isFinite(Number(plan.percentRemaining))) return plan
    return byId('bigmodel-glm')
  }
  if (p.includes('moonshot') || p.includes('kimi')) return byId('moonshot-cn')
  if (p.includes('openrouter')) return byId('openrouter')
  if (p.includes('minimax')) return byId('minimax-coding')
  // 火山方舟：订阅窗口卡（volc-plan）优先，拿不到窗口（未配置 AK/SK / 未订阅）时
  // 落按量卡（volcengine-ark，本机 token 计价）。'ark' 子串太短（dark 误命中），
  // 只认 volc / volcengine；UUID 接入点靠额度页的卡片看，不硬套。
  if (p.includes('volc')) return byId('volc-plan') || byId('volcengine-ark')
  return null
}

function windowOf(label, w) {
  if (!w || typeof w !== 'object') return null
  let usedPct = Number(w.percent)
  if (!Number.isFinite(usedPct) && Number(w.cap) > 0) usedPct = (Number(w.used) || 0) / Number(w.cap)
  if (!Number.isFinite(usedPct)) return null
  // 调用方统一传 0–1 的比例（cmdgo 的 percent、relay 的 percentUsed/100）。
  usedPct = Math.max(0, usedPct * 100)
  return {
    label,
    usedPct,
    remainingPct: Math.max(0, 100 - usedPct),
    resetAt: w.resetAt || null,
    remaining: w.remaining,
    total: w.total != null ? w.total : w.cap,
    prov: prov('exact', 'api', 'vendor:quota-window'),
  }
}

function windowsOfVendor(v) {
  if (!v) return []
  const out = []
  // 并列顺序与旧挂件一致：5 小时 → 本周 → 月度池。
  if (v.fiveHour) out.push(windowOf('5 小时', v.fiveHour))
  if (v.weekly) out.push(windowOf('本周', v.weekly))
  if (v.monthly) out.push(windowOf('月度池', v.monthly))
  if (Array.isArray(v.windows) && !out.length) {
    for (const w of v.windows) {
      // 中转站的窗口字段是 percentUsed（0–100），cmdgo 是 percent（0–1）。
      const raw = w.percentUsed != null ? Number(w.percentUsed) / 100 : w.percent
      const norm = windowOf(w.label || '窗口', {
        percent: raw,
        used: w.used,
        cap: w.cap,
        resetAt: w.resetAt,
        remaining: w.remaining,
        total: w.total,
      })
      if (norm) out.push(norm)
    }
  }
  return out.filter(Boolean)
}

// 套餐按模型分桶 → 前端可直接画进度条的结构（D053）。
// GLM 赠送池按模型分开记账（GLM-5.3 / GLM-5.3-Flash 各自总额与余量），汇总百分比
// 会把单个桶的告急摊平（实测总桶 0.2% 剩余时另一桶还接近满额）。百分比只取同一桶
// 的 remaining/total，total 不可得就不给——绝不补 0（D046）。
export function bucketsOfVendor(v) {
  if (!v || !Array.isArray(v.byModel)) return []
  const out = []
  for (const b of v.byModel) {
    if (!b) continue
    const total = Number(b.totalUnits)
    const remaining = Number(b.remainingUnits)
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(remaining)) continue
    const remainingPct = Math.max(0, Math.min(100, Math.round((remaining / total) * 1000) / 10))
    out.push({
      key: String(b.model || b.showName || 'bucket-' + out.length),
      label: String(b.showName || b.model || '配额桶').slice(0, 24),
      remainingPct,
      usedPct: Math.round((100 - remainingPct) * 10) / 10,
      remaining,
      total,
    })
  }
  return out.slice(0, 8)
}

// 把一条厂商状态压成前端稳定消费的卡片数据。
export function quotaCardOf(vendors, active) {
  if (!active) {
    return {
      kind: 'plan',
      title: 'ZCode',
      subtitle: '按厂商口径计费',
      plan: 'ZCode',
      note: '今日消耗按 ZCode 用量库逐轮计价；余额/套餐取决于当前 provider，由 ZCode 侧的价目与额度源决定。',
    }
  }
  const windows = windowsOfVendor(active)
  const buckets = bucketsOfVendor(active)
  const plan = active.planName || (active.kind === 'local-log' ? active.name : '') || active.name
  if (windows.length) {
    return {
      kind: 'windows',
      title: active.name,
      subtitle: active.account ? '账号 ' + active.account : plan,
      plan,
      account: active.account || '',
      note: active.note || '',
      source: active.id,
      preferBalance: active.id === 'commandcode',
      windows,
      buckets,
    }
  }
  if (active.percentRemaining != null && active.id === 'zcode-plan') {
    return {
      kind: 'plan',
      title: active.name,
      subtitle: '订阅套餐',
      plan,
      note: buckets.length ? '总剩余只作参考；下方按模型分桶，单桶告急单独标出' : '剩余额度来自套餐用量接口',
      source: active.id,
      buckets,
    }
  }
  if (active.balance != null) {
    return {
      kind: 'balance',
      title: active.name,
      subtitle: active.kind === 'relay' ? '中转站余额' : '账户余额',
      balance: { amount: active.balance, currency: active.currency || 'CNY' },
      source: active.id,
    }
  }
  return {
    kind: 'plan',
    title: active.name,
    subtitle: '按厂商口径计费',
    plan,
    note: active.reason || '该厂商暂无可读余额',
    source: active.id,
    buckets,
  }
}

// 余额构成（D2）：把 vendor 状态里的 grantedBalance / toppedBalance 映射成
// UI 稳定字段 { granted, topped, currency }。只有余额非空、且两侧至少一个为
// 有限非负数时才输出；任何缺失保持 null（不补 0）。非 DeepSeek 厂商没有这两个
// 字段，因此返回 null，不会伪造构成。
export function balanceSplitOfVendor(v) {
  if (!v || typeof v !== 'object') return null
  const amount = Number(v.balance)
  if (v.balance == null || !Number.isFinite(amount)) return null
  const part = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null)
  const granted = part(v.grantedBalance)
  const topped = part(v.toppedBalance)
  if (granted === null && topped === null) return null
  return {
    granted,
    topped,
    currency: /^[A-Z]{3,8}$/.test(String(v.currency || '')) ? String(v.currency) : null,
  }
}

function compactVendor(v) {
  const windows = windowsOfVendor(v)
  return {
    id: v.id,
    name: v.name,
    kind: v.kind,
    currency: v.currency || '',
    available: !!v.available,
    plan: v.planName || (v.kind === 'local-log' ? v.name : ''),
    account: v.account || '',
    balance: v.balance != null ? v.balance : null,
    percentRemaining: v.percentRemaining != null ? v.percentRemaining : null,
    windows,
    reason: v.reason || '',
  }
}

export const zcodeAdapter = {
  id: 'zcode',
  name: 'ZCode',
  priority: 20,
  roleDefault: 'fox',
  accent: '#f0a04b',
  match: { exeBasenames: ['zcode.exe'] },
  capabilities: {
    billing: true,
    follow: true,
    context: true,
    stats: true,
    sessions: { list: true, detail: true, live: true, archived: true, actions: [] },
  },

  getStats(opts = {}) {
    return readAppStats(opts)
  },

  getContext(opts = {}) {
    return readZcodeContext(opts)
  },

  listSessions(opts = {}) {
    return listZcodeSessions(opts)
  },

  getSessions(opts = {}) {
    return readZcodeSessions(opts)
  },

  getSessionDetail(sessionId, opts = {}) {
    return readZcodeSessionDetail(sessionId, opts)
  },

  getLiveStatus(opts = {}) {
    return readZcodeLive(opts)
  },

  getArchivedKeys(opts = {}) {
    return readZcodeArchivedKeys(opts)
  },

  readUsageRows(opts = {}) {
    return readZcodeUsageRows(opts)
  },

  readToolUsageRows(opts = {}) {
    return readZcodeToolRows(opts)
  },

  aggregateUsage(opts = {}) {
    return aggregateZcodeUsage(opts)
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
        const pricedToday = Object.keys(byCur).length > 0
        // 价目表未收录的按量模型：金额不可得。整天都算不出金额时给 null（契约
        // 会丢掉 today、UI 显示「—」），不把真实消耗显示成 ¥0.00。
        const todayMissing = !pricedToday && r.today.unpriced > 0
        const today =
          pricedToday || !todayMissing ? { amount: pricedToday ? byCur[cur] || 0 : 0, currency: cur, byCurrency: byCur } : null
        const todayNote = todayMissing
          ? '价目快照 ' + PRICING_SNAPSHOT_DATE + ' 未收录今日全部模型，金额不可得'
          : r.today.unpriced > 0
            ? 'token × 价目表；部分模型价目未收录，金额只含可计价部分'
            : 'token × 价目表；预付/套餐行金额记 0'
        const details = [
          { label: '今日 tokens', value: fmtTokens(r.today.tokens), hint: '按 ZCode 用量库逐次调用统计' },
          { label: '今日调用', value: String(r.today.calls) + ' 次' },
        ]

        // 厂商余额：取「当前 provider」对应厂商的额度/余额；同时把已配置的
        // 厂商压成一份列表给控制台的「厂商余额」卡（Data: /v1/vendors 同源）。
        // 单测通过 FOX_DOCK_VENDOR_BALANCES=0 关掉，避免读开发机真实凭据/出网。
        let vendorStatus = []
        if (process.env.FOX_DOCK_VENDOR_BALANCES !== '0') {
          try {
            const status = await listVendorStatus()
            vendorStatus = Array.isArray(status.vendors) ? status.vendors : []
          } catch (err) {}
        }
        const provider = r.lastProvider || ''
        const active = vendorForProvider(vendorStatus, provider)
        const card = quotaCardOf(vendorStatus, active)
        const windows = card.windows || []
        const lowest = windows.length
          ? windows.reduce((a, b) => (Number(b.remainingPct) < Number(a.remainingPct) ? b : a), windows[0])
          : null
        const quota = lowest
          ? {
              remainingPct: Number(lowest.remainingPct),
              usedPct: Number(lowest.usedPct),
              label: lowest.label,
              resetAt: lowest.resetAt,
            }
          : active && active.percentRemaining != null
            ? {
                remainingPct: Number(active.percentRemaining),
                usedPct: Math.max(0, 100 - Number(active.percentRemaining)),
                label: '套餐',
                resetAt: active.nextResetAt || null,
              }
            : null
        let balance = null
        if (active) {
          if (active.id === 'commandcode' && active.monthly && active.monthly.remaining != null) {
            balance = { amount: Number(active.monthly.remaining), currency: 'USD' }
          } else if (active.balance != null) {
            balance = { amount: Number(active.balance), currency: active.currency || 'CNY' }
          }
        }

        if (active) {
          details.unshift({
            label: '当前厂商',
            value: active.name + (active.planName ? ' · ' + active.planName : ''),
            hint: provider || '按最近一次调用识别',
          })
        }
        // 厂商分布：ZCode 的用量库里本来就有 provider/model，按厂商拆开显示，
        // 不再只给一个「今日合计」。按 tokens 排序（不同币种金额不可直接相加）。
        const vendors = Object.entries(r.today.byVendor || {})
          .sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0))
          .slice(0, 8)
        for (const [id, v] of vendors) {
          const vcur = dominantCurrency(v.byCurrency)
          const label = v.label || id
          const priced = Object.keys(v.byCurrency).length > 0
          details.push({
            label: '厂商 · ' + label,
            // 只有未收录模型时金额不可得：显示「—」，不要显示 ¥0.00。
            value: (priced ? fmtMoney(v.byCurrency[vcur], vcur) : '—') + ' · ' + fmtTokens(v.tokens),
            hint: String(v.calls) + ' 次调用',
          })
        }
        if (r.lastTurn) {
          details.push({ label: '上一轮 tokens', value: fmtTokens(r.lastTurn.tokens) })
          details.push({ label: '上一轮调用', value: String(r.lastTurn.calls) + ' 次' })
        }
        details.push({ label: '数据源', value: 'db.sqlite', hint: 'ZCode 本机用量库（只读）' })

        // 余额构成：DeepSeek 的赠金/充值拆分（其它厂商为 null）
        const balanceSplit = balanceSplitOfVendor(active)

        const vendorList = vendorStatus
          .filter(
            (v) =>
              v &&
              (v.configured ||
                v.available ||
                Number(v.pool && v.pool.total) > 0 ||
                (v.kind === 'cmdgo' && v.pool && Number(v.pool.total) > 0))
          )
          .map(compactVendor)
          .filter((v) => v.available || v.balance != null || v.percentRemaining != null || v.windows.length)

        // 预付池（CommandCode / 套餐）逐轮计价金额恒为 0，不能把「¥0.00」当成
        // 真实消耗展示；tokens 仍保留在 details 与 usage 里。
        const prepaid = active && (active.id === 'commandcode' || active.kind === 'local-log')
        const turn =
          r.lastTurn && r.lastTurn.amount != null && !(prepaid && !(Number(r.lastTurn.amount) > 0))
            ? {
                amount: r.lastTurn.amount,
                currency: r.lastTurn.currency,
                byCurrency: { [r.lastTurn.currency]: r.lastTurn.amount },
                at: r.lastTurn.at,
              }
            : null

        return {
          supported: true,
          unit: 'money',
          today,
          turn,
          quota,
          balance,
          balanceSplit,
          quotaCard: card,
          vendors: vendorList,
          details,
          plan: active ? active.planName || active.name : 'ZCode',
          account: active ? active.account || '' : '',
          provider,
          // 峰谷只对分时计价的模型出现（当前是 DeepSeek 系）；平价厂商为 null。
          period: periodFor(r.lastModel, provider),
          usage: {
            todayTokens: r.today.tokens,
            turnTokens: r.lastTurn ? r.lastTurn.tokens : 0,
          },
          provenance: {
            today: todayMissing
              ? unavailable('no-data', 'pricing:' + PRICING_SNAPSHOT_DATE + ' zcode', 'pricing-table', {
                  asOf: now(),
                  note: todayNote,
                })
              : prov('estimated', 'pricing-table', 'pricing:' + PRICING_SNAPSHOT_DATE + ' zcode', {
                  asOf: now(),
                  note: todayNote,
                }),
            turn: r.lastTurn
              ? prov('estimated', 'pricing-table', 'pricing:' + PRICING_SNAPSHOT_DATE + ' zcode', {
                  asOf: now(),
                  note: 'token × 价目表',
                })
              : unavailable('no-data', 'zcode:db.sqlite#model_usage', 'local-db'),
            balance: balance
              ? prov('exact', 'api', 'vendor:' + (active ? active.id : 'unknown'))
              : unavailable(active ? 'no-data' : 'not-running', 'zcode:vendors', 'unknown'),
            quota: quota
              ? prov('exact', 'api', 'vendor:' + (active ? active.id : 'unknown'))
              : unavailable(active ? 'no-data' : 'not-running', 'zcode:vendors', 'unknown'),
            usage: prov('exact', 'local-db', 'zcode:db.sqlite#model_usage'),
          },
          source: 'zcode:db.sqlite',
        }
      },
    }
  },
}
