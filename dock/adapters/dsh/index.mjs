// DeepSeek Harness（dsh）适配器：识别宿主窗口 + 余额 + 会话用量。
//
// 两套数据源：
//   · 余额：dsh 凭据里的 DeepSeek API Key → api.deepseek.com/user/balance
//   · 今日 / 上一轮：<DSH_HOME>/sessions 的多帧 zstd 会话日志，逐次调用计价
// 余额接口读不到时不影响用量；两者都读不到才报错（不写假 0）。

import { defaultDshHome, readDeepSeekBalance } from './credentials.mjs'
import { readDshwLedger, scanDshUsage } from './sessions.mjs'
import { listDshSessions, readDshContext } from './context.mjs'
import { periodFor } from '../../engines/pricing.mjs'

function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M'
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K'
  return String(Math.round(v))
}

function fmtMoney(m) {
  if (!m || typeof m.amount !== 'number') return ''
  const sym = m.currency === 'CNY' ? '¥' : m.currency === 'USD' ? '$' : m.currency + ' '
  return sym + m.amount.toFixed(2)
}

export const dshAdapter = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  priority: 20,
  roleDefault: 'whale',
  accent: '#4d6bfe',
  match: {
    exeBasenames: ['deepseek harness.exe'],
    exeIncludes: ['/dsh-windows/'],
  },
  capabilities: { billing: true, follow: true, context: true },

  getContext(opts = {}) {
    return readDshContext(opts)
  },

  listSessions(opts = {}) {
    return listDshSessions(opts)
  },

  createBilling(ctx = {}) {
    const now = typeof ctx.now === 'function' ? ctx.now : () => Date.now()
    return {
      async snapshot() {
        const nowMs = now()
        const sessions = scanDshUsage({
          now: nowMs,
          home: ctx.dshHome,
          sessionsDir: ctx.dshSessionsDir,
        })
        const balance = await readDeepSeekBalance({
          now: nowMs,
          home: ctx.dshHome,
          fetchImpl: ctx.fetchImpl,
        })

        let today = sessions.ok ? sessions.today : null
        let todaySource = 'dsh:sessions'
        let ledger = null
        if (!today || !today.calls) {
          ledger = readDshwLedger(ctx.dshHome || defaultDshHome(), nowMs)
          // 只有「旧账本确实记了今天」且会话里没有记录时才兜底；
          // 账本里没有今天条目时不能把 lastBalance 当成今日用量。
          if (ledger && ledger.hasToday && (!today || today.amount === 0)) {
            today = {
              amount: ledger.amount,
              currency: ledger.currency,
              byCurrency: { [ledger.currency]: ledger.amount },
              tokens: 0,
              calls: 0,
              priced: false,
            }
            todaySource = 'dsh:.dshw-usage.json'
          }
        }

        const details = []
        if (today) {
          details.push({
            label: '今日 tokens',
            value: fmtTokens(today.tokens),
            hint: todaySource === 'dsh:sessions' ? '按会话日志逐次调用统计' : '旧账本只记金额，不含 tokens',
          })
        }
        const turn = sessions.ok ? sessions.lastTurn : null
        if (turn) {
          details.push({
            label: '上一轮 tokens',
            value: fmtTokens(turn.tokens),
            hint: turn.model || '',
          })
          if (turn.model) details.push({ label: '上一轮模型', value: turn.model })
        }
        if (balance.ok) {
          details.push({ label: '余额来源', value: balance.source || 'DeepSeek API' })
          if (balance.toppedUp || balance.granted) {
            details.push({
              label: '余额构成',
              value: '充值 ' + fmtMoney({ amount: balance.toppedUp, currency: balance.currency }) + ' · 赠送 ' + fmtMoney({ amount: balance.granted, currency: balance.currency }),
            })
          }
        } else {
          details.push({ label: '余额', value: '读取失败', hint: balance.error || '' })
        }
        if (ledger && ledger.hasToday && ledger.lastBalance !== null) {
          details.push({ label: '旧账本余额', value: fmtMoney({ amount: ledger.lastBalance, currency: ledger.currency }) })
        }
        if (sessions.ok) {
          details.push({
            label: '会话日志',
            value: String(sessions.files) + ' 个文件',
            hint: sessions.truncated ? '文件过多，只统计了最近一部分' : '',
          })
        }

        if (!sessions.ok && !balance.ok) {
          return {
            supported: true,
            error: 'dsh 数据读取失败：' + (sessions.reason || balance.error || '未知原因'),
          }
        }

        const todayMoney = today
          ? { amount: today.amount, currency: today.currency, byCurrency: today.byCurrency }
          : null
        const turnMoney = turn
          ? { amount: turn.amount, currency: turn.currency, byCurrency: turn.byCurrency }
          : null

        const quotaCard = balance.ok
          ? {
              kind: 'balance',
              title: 'DeepSeek 余额',
              subtitle: '按量付费',
              plan: 'DeepSeek 按量',
              balance: { amount: balance.amount, currency: balance.currency },
              note: '余额来自 DeepSeek 开放平台；今日用量按 dsh 会话日志逐轮计价。',
            }
          : {
              kind: 'plan',
              title: 'DeepSeek 余额',
              subtitle: '按量付费',
              plan: 'DeepSeek 按量',
              note: balance.error || '没有找到 dsh 的 DeepSeek 凭据（API Key），余额不可读；今日用量仍按会话日志统计。',
            }

        return {
          supported: true,
          unit: 'money',
          today: todayMoney,
          turn: turnMoney,
          balance: balance.ok ? { amount: balance.amount, currency: balance.currency } : null,
          quotaCard,
          details,
          plan: 'DeepSeek 按量',
          account: balance.ok && balance.currency ? 'DeepSeek · ' + balance.currency : 'DeepSeek',
          period: periodFor('deepseek-flash', 'deepseek'),
          usage: {
            todayTokens: today ? today.tokens : 0,
            turnTokens: turn ? turn.tokens : 0,
          },
          source: todaySource + (balance.ok ? ' + api.deepseek.com' : ''),
        }
      },
    }
  },
}
