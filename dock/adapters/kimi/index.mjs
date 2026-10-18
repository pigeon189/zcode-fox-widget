// Kimi Code 适配器：识别宿主窗口 + 读 Kimi For Coding 套餐额度。
//
// 口径：
//   · 有套餐窗口 → 百分比口径；主数字 = 剩余最少的那一档
//   · 只有 booster 钱包 → 金额口径（钱包余额）
//   · Free 账号（接口返回 {}）→ 套餐卡片，明确写「没有可读窗口」，不编 0%
//
// Kimi Code 的 OAuth access_token 只有 15 分钟，刷新由 credentials.mjs 负责；
// 额度接口结果缓存 60s（见 usage.mjs）。

import { readKimiStatus } from './usage.mjs'

function worstWindow(windows) {
  let used = 0
  let remaining = 100
  for (const w of windows) {
    if (typeof w.usedPct === 'number') used = Math.max(used, w.usedPct)
    if (typeof w.remainingPct === 'number') remaining = Math.min(remaining, w.remainingPct)
  }
  return { usedPct: Math.round(used * 10) / 10, remainingPct: Math.round(remaining * 10) / 10 }
}

function fmtReset(v) {
  if (!v) return ''
  const ms = typeof v === 'number' ? v : Date.parse(String(v))
  if (!Number.isFinite(ms)) return ''
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch (err) {
    return ''
  }
}

export const kimiAdapter = {
  id: 'kimi',
  name: 'Kimi Code',
  priority: 20,
  roleDefault: 'kimi',
  accent: '#b07cff',
  match: {
    exeBasenames: ['kimi code.exe'],
    exeIncludes: ['/kimicode/'],
  },
  capabilities: { billing: true, follow: true },

  createBilling(ctx = {}) {
    const now = typeof ctx.now === 'function' ? ctx.now : () => Date.now()
    return {
      async snapshot() {
        const r = await readKimiStatus({
          now: now(),
          fetchImpl: ctx.fetchImpl,
          home: ctx.kimiHome,
          file: ctx.kimiCredentialsFile,
          baseUrl: ctx.kimiBaseUrl,
        })
        if (!r.ok) return { supported: true, error: r.error }

        const plan = r.plan || ''
        const account = r.account || ''
        const details = []
        if (account) details.push({ label: '账号', value: account })
        if (r.region) details.push({ label: '区域', value: r.region })
        if (plan) details.push({ label: '套餐', value: plan })
        for (const w of r.windows) {
          const reset = fmtReset(w.resetAt)
          if (reset) details.push({ label: w.label + '重置', value: reset })
        }

        if (r.windows.length) {
          const q = worstWindow(r.windows)
          return {
            supported: true,
            unit: 'percent',
            quota: q,
            quotaCard: {
              kind: 'windows',
              title: 'Kimi Code',
              subtitle: plan ? plan + ' 套餐' : '套餐额度',
              plan,
              account,
              windows: r.windows.map((w) => ({
                key: w.key,
                label: w.label,
                usedPct: w.usedPct,
                remainingPct: w.remainingPct,
                resetAt: w.resetAt,
              })),
              note: '额度来自 Kimi Code /coding/v1/usages；窗口与客户端显示同源。',
            },
            details,
            plan,
            account,
            usage: { todayTokens: 0, turnTokens: 0 },
            source: 'kimi:/coding/v1/usages',
          }
        }

        if (r.wallet) {
          return {
            supported: true,
            unit: 'money',
            balance: { amount: r.wallet.amount, currency: r.wallet.currency || 'USD' },
            quotaCard: {
              kind: 'balance',
              title: 'Kimi Code',
              subtitle: plan ? plan + ' 套餐' : '加油包余额',
              plan,
              account,
              balance: { amount: r.wallet.amount, currency: r.wallet.currency || 'USD' },
              note: r.wallet.monthlyLimitEnabled ? '加油包余额；月度充值上限已启用。' : '加油包余额。',
            },
            details,
            plan,
            account,
            usage: { todayTokens: 0, turnTokens: 0 },
            source: 'kimi:/coding/v1/usages',
          }
        }

        // Free / 无套餐窗口：有一条明确的说明，比一个假的 0% 更有用。
        return {
          supported: true,
          unit: 'percent',
          quota: null,
          quotaCard: {
            kind: 'plan',
            title: 'Kimi Code',
            subtitle: account || '没有可读的套餐窗口',
            plan,
            account,
            note: '当前账号没有可读的套餐额度窗口（Free 账号或未订阅 Kimi For Coding）；额度以 Kimi Code 客户端为准。',
          },
          details,
          plan,
          account,
          usage: { todayTokens: 0, turnTokens: 0 },
          source: 'kimi:/coding/v1/usages',
        }
      },
    }
  },
}
