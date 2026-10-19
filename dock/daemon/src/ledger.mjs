// 统一账本（R7）：把各适配器的「今日」快照按 (日期, 适配器, 单位, 币种) 归档。
//
// 三条硬规则：
//   1. **单位不混算**：money / credit / percent 各自成组，绝不求和
//      （¥1.2 + 193 积分没有意义）。
//   2. **币种不混算**：CNY 与 USD 分开，不做汇率换算（dock 不猜汇率）。
//   3. **只认累计值**：适配器给的是「今日累计」，不是增量；同一适配器同一日期
//      反复写入是覆盖，不是相加。否则每秒轮询会把金额滚成天文数字。
//
// 账本是**观察记录**，不是账单：某个适配器今天没被打开过，就不会有它的记录。
// 界面上要如实显示「今天有哪些 agent 被看到过」。

import fs from 'node:fs'
import path from 'node:path'

export const KEEP_DAYS = 30

export function dayKeyOf(ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export function readLedger(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || !raw.days || typeof raw.days !== 'object') return { days: {} }
    return { days: raw.days }
  } catch (err) {
    return { days: {} }
  }
}

function writeLedger(file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2))
  fs.renameSync(tmp, file)
}

function prune(ledger, nowMs) {
  const keys = Object.keys(ledger.days).sort()
  if (keys.length <= KEEP_DAYS) return
  const drop = keys.slice(0, keys.length - KEEP_DAYS)
  for (const k of drop) delete ledger.days[k]
}

// 记录一次快照。supported=false / ok=false 不写（宁可缺一条，也不要假 0）。
export function recordSnapshot(file, { adapterId, adapterName, snapshot, now }) {
  if (!snapshot || snapshot.supported !== true || snapshot.ok === false) {
    return { ok: false, reason: 'not-recordable' }
  }
  const unit = snapshot.unit
  if (!unit || !['money', 'credit', 'percent'].includes(unit)) {
    return { ok: false, reason: 'bad-unit' }
  }
  const day = dayKeyOf(now)
  const ledger = readLedger(file)
  if (!ledger.days[day]) ledger.days[day] = {}

  const amounts = {}
  if (unit === 'percent') {
    const q = snapshot.quota || {}
    if (typeof q.usedPct === 'number') amounts.PCT = q.usedPct
  } else if (snapshot.today && typeof snapshot.today.amount === 'number') {
    const by = snapshot.today.byCurrency && Object.keys(snapshot.today.byCurrency).length
      ? snapshot.today.byCurrency
      : { [snapshot.today.currency || 'CNY']: snapshot.today.amount }
    for (const [cur, amt] of Object.entries(by)) {
      if (typeof amt === 'number' && Number.isFinite(amt)) amounts[cur] = Math.round(amt * 10000) / 10000
    }
  }

  ledger.days[day][adapterId] = {
    name: String(adapterName || adapterId),
    unit,
    amounts,
    // token 是同一口径下的量纲补充（金额/积分/百分比仍各自成组）
    tokens: Math.max(0, Math.round(Number(snapshot.usage && snapshot.usage.todayTokens) || 0)),
    at: Number(now) || Date.now(),
  }
  prune(ledger, now)
  writeLedger(file, ledger)
  return { ok: true }
}

function groupsOf(dayEntry) {
  const groups = new Map() // unit|currency -> { unit, currency, amount, adapters: [] }
  for (const [id, row] of Object.entries(dayEntry || {})) {
    for (const [cur, amt] of Object.entries(row.amounts || {})) {
      const key = row.unit + '|' + cur
      let g = groups.get(key)
      if (!g) {
        g = { unit: row.unit, currency: cur, amount: 0, tokens: 0, adapters: [] }
        groups.set(key, g)
      }
      g.amount += Number(amt) || 0
      g.tokens += Number(row.tokens) || 0
      g.adapters.push({ id, name: row.name, amount: Number(amt) || 0, tokens: Number(row.tokens) || 0 })
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, amount: Math.round(g.amount * 10000) / 10000 }))
    .sort((a, b) => a.unit.localeCompare(b.unit) || a.currency.localeCompare(b.currency))
}

// 汇总：今天 + 最近 N 天（只含有记录的天）
export function summarize(file, { now, days = 7 } = {}) {
  const ledger = readLedger(file)
  const today = dayKeyOf(now)
  const keys = Object.keys(ledger.days).sort()
  const keep = keys.slice(-Math.max(1, days))
  return {
    today: { date: today, groups: groupsOf(ledger.days[today]) },
    days: keep.map((d) => ({ date: d, groups: groupsOf(ledger.days[d]) })),
  }
}
