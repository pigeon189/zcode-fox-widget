// 展示格式化：金额/积分/百分比/时间。单位紧贴数字，千分位，24 小时制。

// 隐藏金额（隐私模式）：只影响展示，不改任何数据。
let HIDE_MONEY = false
export function setHideMoney(value) {
  HIDE_MONEY = value === true
}

export function currencySymbol(currency) {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  if (currency === 'CREDIT') return ''
  return currency ? currency + ' ' : ''
}

export function fmtMoney(amount, currency = 'CNY') {
  if (HIDE_MONEY) return '•••'
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2
  const text = n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return currencySymbol(currency) + text
}

export function fmtCredit(amount) {
  if (HIDE_MONEY) return '•••'
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' 积分'
}

export function fmtUnit(money, unit) {
  if (!money || typeof money !== 'object') return '—'
  if (unit === 'credit' || money.currency === 'CREDIT') return fmtCredit(money.amount)
  if (unit === 'percent') return fmtPct(money.amount)
  return fmtMoney(money.amount, money.currency)
}

export function fmtPct(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return (Math.round(v * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%'
}

export function fmtNum(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return v.toLocaleString('en-US')
}

export function fmtTokens(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2) + 'M'
  if (v >= 1_000) return (v / 1_000).toFixed(v >= 100_000 ? 0 : 1) + 'K'
  return String(Math.round(v))
}

export function fmtTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  try {
    return new Date(n).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch (err) {
    return '—'
  }
}

export function fmtDateTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  try {
    return new Date(n).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch (err) {
    return '—'
  }
}

export function fmtRelative(ms, now = Date.now()) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = n - now
  const abs = Math.abs(d)
  if (abs < 60_000) return d >= 0 ? '即将' : '刚刚'
  if (abs < 3600_000) return Math.round(abs / 60_000) + ' 分钟' + (d >= 0 ? '后' : '前')
  if (abs < 86400_000) return Math.round(abs / 3600_000) + ' 小时' + (d >= 0 ? '后' : '前')
  return Math.round(abs / 86400_000) + ' 天' + (d >= 0 ? '后' : '前')
}

export function fmtReset(value) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number') return fmtRelative(value)
  const ms = Date.parse(String(value))
  if (Number.isFinite(ms)) return fmtRelative(ms)
  return String(value).slice(0, 20)
}

export function pctTone(pct) {
  const n = Number(pct)
  if (!Number.isFinite(n)) return 'neutral'
  if (n >= 92) return 'bad'
  if (n >= 80) return 'warn'
  return 'ok'
}

// 厂商窗口的 percent 有两种口径：cmdgo/真实接口是 0–1，中转站快照是 0–100。
// 大于 1 一律按百分比理解；正好 1 视为 100%。
export function usedPctOf(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return n > 1 ? n : n * 100
}

// 「剩余」文案：超额时直接说超额多少，不显示负数。
export function remainText(usedPct) {
  const n = Number(usedPct)
  if (!Number.isFinite(n)) return '—'
  if (n > 100) return '已超额 ' + fmtPct(n - 100)
  return fmtPct(100 - n) + ' 剩余'
}

export function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export function shortDay(key) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(key || ''))
  return m ? Number(m[1]) + '/' + Number(m[2]) : String(key || '')
}

export function hhmm(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return ''
  try {
    return new Date(n).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
  } catch (err) {
    return ''
  }
}

export const AGENT_NAMES = { zcode: 'ZCode', workbuddy: 'WorkBuddy', kimi: 'Kimi Code', dsh: 'DeepSeek Harness', generic: '其它' }

export function agentName(id) {
  return AGENT_NAMES[id] || String(id || '—')
}

export function reasonText(reason) {
  return (
    {
      'not-running': '宿主未运行',
      'no-session': '还没有会话',
      'no-data': '该宿主暂未提供上下文数据',
      auth: '凭据失效，请在宿主里重新登录',
      schema: '宿主数据格式已变化，请更新 fox-dock',
    }[reason] || '暂无数据'
  )
}

// 主数字口径：auto 时按宿主特点选。
export function mainMetric(snapshot, displayMode = 'auto', agentId = '') {
  if (!snapshot || snapshot.supported !== true) {
    return { value: '—', label: '暂无数据', sub: snapshot && snapshot.error ? snapshot.error : '', tone: 'neutral' }
  }
  const unit = snapshot.unit
  const card = snapshot.quotaCard || {}
  const vendorName = card.title && card.title !== agentName(agentId) ? card.title : ''
  const planName = card.plan && card.plan !== vendorName ? card.plan : ''
  const vendorSub = vendorName ? vendorName + (planName ? ' · ' + planName : '') : planName
  let mode = displayMode
  if (!mode || mode === 'auto') {
    // 「按宿主」：预付/套餐型宿主优先显示余额或剩余额度，按量型才显示今日已用。
    if (agentId === 'workbuddy') mode = 'today'
    else if (snapshot.balance && (agentId === 'dsh' || card.preferBalance || card.kind === 'balance')) mode = 'balance'
    else if (snapshot.quota && (agentId === 'kimi' || card.kind === 'plan' || card.kind === 'windows')) mode = 'quota'
    else mode = 'today'
  }
  if (mode === 'balance' && snapshot.balance) {
    return { value: fmtMoney(snapshot.balance.amount, snapshot.balance.currency), label: '余额', sub: vendorSub, tone: 'neutral' }
  }
  if (mode === 'quota' && snapshot.quota) {
    return {
      value: fmtPct(snapshot.quota.remainingPct),
      label: '剩余额度',
      sub: vendorSub || card.plan || '',
      tone: pctTone(100 - Number(snapshot.quota.usedPct || 0)),
    }
  }
  if (mode === 'today' && snapshot.today) {
    const isCredit = unit === 'credit' || snapshot.today.currency === 'CREDIT'
    return {
      value: isCredit ? fmtCredit(snapshot.today.amount) : fmtMoney(snapshot.today.amount, snapshot.today.currency),
      label: isCredit ? '今日已用积分' : '今日已用',
      sub: snapshot.turn ? '上一轮 ' + (isCredit ? fmtCredit(snapshot.turn.amount) : fmtMoney(snapshot.turn.amount, snapshot.turn.currency)) : '',
      tone: 'neutral',
    }
  }
  if (snapshot.today) {
    return {
      value: fmtUnit(snapshot.today, unit),
      label: unit === 'credit' ? '今日已用积分' : '今日已用',
      sub: '',
      tone: 'neutral',
    }
  }
  if (snapshot.balance) return { value: fmtMoney(snapshot.balance.amount, snapshot.balance.currency), label: '余额', sub: '', tone: 'neutral' }
  return { value: '—', label: '暂无数据', sub: '', tone: 'neutral' }
}

// ---------- 会话状态（D034） ----------
export const SESSION_STATUS_LABELS = {
  working: '工作中',
  waiting_input: '等待输入',
  waiting_permission: '等待确认',
  error: '出错',
  done: '已完成',
  idle: '空闲',
  unknown: '状态未知',
}

export function sessionStatusLabel(status) {
  return SESSION_STATUS_LABELS[status] || SESSION_STATUS_LABELS.unknown
}

export function fmtDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '—'
  const sec = Math.round(n / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  // 超过一天的时长用「N 天 H:MM」：纯 H:MM 在 >99 小时会显示成 120:42，
  // 容易被读成分:秒。
  if (h >= 24) {
    const days = Math.floor(h / 24)
    const hh = h % 24
    return days + ' 天 ' + hh + ':' + String(m).padStart(2, '0')
  }
  if (h > 0) return h + ':' + String(m).padStart(2, '0')
  return m + ':' + String(s).padStart(2, '0')
}

export function fmtRelativeShort(ms, now = Date.now()) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const diff = now - n
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return Math.round(diff / 60_000) + ' 分钟前'
  if (diff < 86400_000) return Math.round(diff / 3600_000) + ' 小时前'
  if (diff < 2 * 86400_000) return '昨天'
  return Math.round(diff / 86400_000) + ' 天前'
}
