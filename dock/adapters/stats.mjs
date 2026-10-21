// 统一「应用用量」统计契约。
//
// 数据源各不相同（ZCode SQLite / WorkBuddy transcript / dsh 会话日志），
// 但聚合口径与 UI 结构保持一致：摘要、热力图、每日模型、模型占比、工具用量。
// 口径对齐 ZCode 客户端自己的 usage/stats（source: agent-db）：
//   · 日界按本地时区（固定用当前时区偏移，和 ZCode 一样）；
//   · 当前连续天数从今天倒着数，遇到第一个空日就停；
//   · 热力图强度按当日 token / 区间峰值 token 分 5 档；
//   · 最长聊天时长按会话内已完成回合的累计时长，而不是墙钟首尾。

export const STATS_RANGES = ['all', '7d', '30d']
export const DAY_MS = 86400000

export function rangeSince(range, now = Date.now()) {
  const r = STATS_RANGES.includes(range) ? range : 'all'
  const t = Number(now) || Date.now()
  if (r === '7d') return t - 7 * DAY_MS
  if (r === '30d') return t - 30 * DAY_MS
  return 0
}

// 当前时区偏移（毫秒）。ZCode 用「现在」的偏移统一换算，这里保持一致。
export function tzOffsetMs(now = Date.now()) {
  return -new Date(Number(now) || Date.now()).getTimezoneOffset() * 60000
}

export function dayIndexOf(ms, offset = tzOffsetMs()) {
  return Math.floor((Number(ms) + Number(offset || 0)) / DAY_MS)
}

export function dateKeyOfDay(dayIndex) {
  return new Date(Number(dayIndex) * DAY_MS).toISOString().slice(0, 10)
}

export function timeZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
  } catch (err) {
    return 'local'
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function levelFor(tokens, maxTokens) {
  if (!(tokens > 0) || !(maxTokens > 0)) return 0
  const r = tokens / maxTokens
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1
}

// 输入是各适配器已经按本地日界聚合好的最小结构，输出是 UI 直接消费的统计。
export function buildStats(input = {}) {
  const range = STATS_RANGES.includes(input.range) ? input.range : 'all'
  const now = Number(input.now) || Date.now()
  const offset = input.tzOffsetMs == null ? tzOffsetMs(now) : Number(input.tzOffsetMs) || 0
  const since = input.since == null ? rangeSince(range, now) : Number(input.since) || 0
  const until = input.until == null ? now : Number(input.until) || now
  const totals = input.totals || {}
  const turnTotals = input.turns || {}
  const toolTotals = input.tools || {}
  const models = (input.models || [])
    .map((m) => ({
      modelId: m.modelId == null ? null : String(m.modelId),
      totalTokens: Math.max(0, Math.round(num(m.totalTokens))),
      inputTokens: Math.max(0, Math.round(num(m.inputTokens))),
      outputTokens: Math.max(0, Math.round(num(m.outputTokens))),
      requestCount: Math.max(0, Math.round(num(m.requestCount))),
      ...(m.credits != null ? { credits: Math.round(num(m.credits) * 10000) / 10000 } : {}),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
  const tools = (input.toolList || [])
    .map((t) => ({
      toolName: String(t.toolName || 'unknown'),
      callCount: Math.max(0, Math.round(num(t.callCount))),
      errorCount: Math.max(0, Math.round(num(t.errorCount))),
      errorRate: num(t.callCount) > 0 ? Math.round((num(t.errorCount) / num(t.callCount)) * 10000) / 10000 : 0,
      avgDurationMs: t.avgDurationMs == null ? null : Math.round(num(t.avgDurationMs)),
    }))
    .sort((a, b) => b.callCount - a.callCount)

  const dayMap = new Map()
  for (const d of input.days || []) {
    const key = Math.round(num(d.dayIndex))
    const row = dayMap.get(key) || { dayIndex: key, totalTokens: 0, turnCount: 0, toolCallCount: 0 }
    row.totalTokens += Math.max(0, Math.round(num(d.totalTokens)))
    row.turnCount += Math.max(0, Math.round(num(d.turnCount)))
    row.toolCallCount += Math.max(0, Math.round(num(d.toolCallCount)))
    dayMap.set(key, row)
  }
  const modelDayMap = new Map()
  for (const d of input.dayModels || []) {
    const key = Math.round(num(d.dayIndex))
    let byModel = modelDayMap.get(key)
    if (!byModel) {
      byModel = new Map()
      modelDayMap.set(key, byModel)
    }
    const id = d.modelId == null ? null : String(d.modelId)
    byModel.set(id, (byModel.get(id) || 0) + Math.max(0, Math.round(num(d.totalTokens))))
  }

  const todayDay = dayIndexOf(now, offset)
  const earliest = Math.min(
    ...[...dayMap.keys()].filter((k) => k <= todayDay),
    ...[...modelDayMap.keys()].filter((k) => k <= todayDay),
    todayDay
  )
  const startDay = range === 'all' ? earliest : Math.min(todayDay, dayIndexOf(since, offset))
  const endDay = todayDay

  let activeDays = 0
  let longestStreakDays = 0
  let run = 0
  let peakDayTokens = 0
  let peakDayDate = null
  for (let d = startDay; d <= endDay; d++) {
    const tokens = dayMap.get(d)?.totalTokens || 0
    if (tokens > 0) {
      activeDays += 1
      run += 1
      longestStreakDays = Math.max(longestStreakDays, run)
    } else {
      run = 0
    }
    if (tokens > peakDayTokens) {
      peakDayTokens = tokens
      peakDayDate = dateKeyOfDay(d)
    }
  }
  // 当前连续天数从今天倒着数，遇到第一个没有用量的日期就停。
  let currentStreakDays = 0
  for (let d = endDay; d >= startDay; d--) {
    if ((dayMap.get(d)?.totalTokens || 0) > 0) currentStreakDays += 1
    else break
  }

  const days = []
  for (let d = startDay; d <= endDay; d++) {
    const row = dayMap.get(d) || { totalTokens: 0, turnCount: 0, toolCallCount: 0 }
    days.push({
      date: dateKeyOfDay(d),
      level: levelFor(row.totalTokens, peakDayTokens),
      totalTokens: row.totalTokens,
      turnCount: row.turnCount,
      toolCallCount: row.toolCallCount,
    })
  }

  const weeks = []
  let week = null
  for (const cell of days) {
    const weekday = new Date(Number(cell.date.slice(0, 4)), Number(cell.date.slice(5, 7)) - 1, Number(cell.date.slice(8, 10))).getDay()
    if (!week || weekday === 0) {
      week = { weekIndex: weeks.length, days: Array.from({ length: 7 }, () => null) }
      weeks.push(week)
    }
    week.days[weekday] = cell
  }

  const modelDays = []
  for (let d = startDay; d <= endDay; d++) {
    const byModel = modelDayMap.get(d)
    modelDays.push({
      date: dateKeyOfDay(d),
      models: byModel
        ? [...byModel.entries()].map(([modelId, totalTokens]) => ({ modelId, totalTokens }))
        : [],
    })
  }

  const tokenSum = models.reduce((s, m) => s + m.totalTokens, 0)
  const withShare = models.map((m) => ({ ...m, share: tokenSum > 0 ? m.totalTokens / tokenSum : 0 }))
  const favoriteModel = withShare[0]
    ? { modelId: withShare[0].modelId, totalTokens: withShare[0].totalTokens, share: withShare[0].share }
    : null

  const inputTokens = num(totals.inputTokens)
  const cacheRead = num(totals.cacheReadTokens)
  const cacheDenominator = inputTokens > 0 ? inputTokens : num(totals.cacheCreationTokens) + cacheRead
  const requests = num(totals.modelRequestCount)
  const toolCalls = num(toolTotals.toolCallCount)
  const totalCredits = input.credits != null ? Math.round(num(input.credits) * 10000) / 10000 : null

  return {
    supported: true,
    range,
    generatedAt: now,
    timeZone: input.timeZone || timeZoneName(),
    source: String(input.source || ''),
    unit: input.unit || 'tokens',
    currency: input.currency || '',
    cost: input.cost && typeof input.cost === 'object' ? input.cost : null,
    credits: input.credits != null ? Math.round(num(input.credits) * 10000) / 10000 : null,
    summary: {
      totalTokens: num(totals.totalTokens),
      inputTokens,
      outputTokens: num(totals.outputTokens),
      reasoningTokens: num(totals.reasoningTokens),
      cacheCreationTokens: num(totals.cacheCreationTokens),
      cacheReadTokens: cacheRead,
      cacheHitRate: cacheDenominator > 0 ? Math.min(1, cacheRead / cacheDenominator) : 0,
      totalSessions: Math.max(0, Math.round(num(turnTotals.totalSessions))),
      totalTurns: Math.max(0, Math.round(num(turnTotals.totalTurns))),
      toolCallCount: Math.max(0, Math.round(toolCalls)),
      toolErrorRate: toolCalls > 0 ? num(toolTotals.toolErrorCount) / toolCalls : 0,
      modelErrorRate: requests > 0 ? num(totals.modelErrorCount) / requests : 0,
      avgTimeToFirstTokenMs: totals.avgTimeToFirstTokenMs == null ? null : Math.round(num(totals.avgTimeToFirstTokenMs)),
      avgTurnDurationMs: turnTotals.avgTurnDurationMs == null ? null : Math.round(num(turnTotals.avgTurnDurationMs)),
      activeDays,
      currentStreakDays,
      longestSessionMs: Math.max(0, Math.round(num(turnTotals.longestSessionMs))),
      longestStreakDays,
      peakDayTokens,
      peakDayDate,
      favoriteModel,
      totalCredits,
    },
    heatmap: {
      startDate: dateKeyOfDay(startDay),
      endDate: dateKeyOfDay(endDay),
      maxTokens: peakDayTokens,
      weeks,
    },
    dailyModelUsage: modelDays,
    models: withShare,
    tools,
  }
}

export function emptyStats(range, reason, notes = {}) {
  const stats = buildStats({ range })
  return {
    ...stats,
    supported: false,
    reason: String(reason || 'no-data'),
    note: notes.note || '',
  }
}
