// dsh 应用用量统计：从会话日志（多帧 zstd）逐事件聚合。
//
// dsh 没有用量数据库；assistant/message 带 usage，turn/start|end 带回合边界，
// tool/call|result 带工具调用。这里复用 sessions.mjs 的逐帧解压，按统一契约
// 输出摘要/热力图/每日模型/工具用量，并按 DeepSeek 峰谷价计算金额。

import fs from 'node:fs'
import path from 'node:path'
import { costOfUsage } from '../../engines/pricing.mjs'
import { buildStats, dayIndexOf, rangeSince, tzOffsetMs } from '../stats.mjs'
import { decodeZstdFrames, defaultSessionsDir } from './sessions.mjs'

const MAX_FILES = 160
const MAX_BYTES = 64 * 1024 * 1024
const cache = new Map() // path|size|mtime -> events

export function _resetDshStatsCache() {
  cache.clear()
}

function walk(dir, out, depth = 0) {
  if (depth > 6) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      walk(p, out, depth + 1)
      continue
    }
    if (!/^session.*\.jsonl(\.zstd)?$/i.test(e.name)) continue
    try {
      const st = fs.statSync(p)
      out.push({ file: p, size: st.size, mtimeMs: st.mtimeMs })
    } catch (err) {}
  }
}

function parseFile(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch (err) {
    return []
  }
  const key = file + '|' + stat.size + '|' + stat.mtimeMs
  const hit = cache.get(key)
  if (hit) return hit
  let text = ''
  try {
    const buf = fs.readFileSync(file)
    if (file.toLowerCase().endsWith('.zstd')) {
      const d = decodeZstdFrames(buf)
      if (!d.ok) return []
      text = d.text
    } else {
      text = buf.toString('utf8')
    }
  } catch (err) {
    return []
  }
  const events = []
  let sessionId = path.basename(path.dirname(file))
  let createdAt = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.charCodeAt(0) !== 123) continue
    let o = null
    try {
      o = JSON.parse(line)
    } catch (err) {
      continue
    }
    if (!o || typeof o !== 'object') continue
    const time = Number(o.time)
    if (o.type === 'session') {
      sessionId = String(o.id || sessionId)
      createdAt = Number(o.createdAt) || createdAt
      continue
    }
    if (!Number.isFinite(time) || time <= 0) continue
    const d = o.data && typeof o.data === 'object' ? o.data : {}
    if (o.type === 'assistant/message') {
      const u = d.usage
      if (!u || typeof u !== 'object') continue
      const msg = d.message && typeof d.message === 'object' ? d.message : {}
      const src = msg.source && typeof msg.source === 'object' ? msg.source : {}
      const input = Number(u.inputTokens) || 0
      const cacheRead = Number(u.cacheReadTokens) || 0
      const output = Number(u.outputTokens) || 0
      const total = Number(u.totalTokens) || input + cacheRead + output
      const inputIncludingCache = total >= output ? total - output : input + cacheRead
      events.push({
        kind: 'use',
        time,
        sessionId,
        turn: Number(d.turn) || 0,
        model: String(src.model || ''),
        provider: String(src.provider || ''),
        input: inputIncludingCache,
        cacheRead,
        output,
        reasoning: Number(u.reasoningTokens) || 0,
        total: total || inputIncludingCache + output,
      })
    } else if (o.type === 'turn/start') {
      events.push({ kind: 'turnStart', time, sessionId, turn: Number(d.turn) || 0 })
    } else if (o.type === 'turn/end') {
      const reason = d.reason && typeof d.reason === 'object' ? d.reason : {}
      events.push({ kind: 'turnEnd', time, sessionId, turn: Number(d.turn) || 0, ok: reason.kind === 'completed' })
    } else if (o.type === 'tool/call') {
      events.push({ kind: 'toolCall', time, sessionId, callId: String(d.callId || ''), name: String(d.name || 'unknown') })
    } else if (o.type === 'tool/result') {
      const msg = d.message && typeof d.message === 'object' ? d.message : {}
      const src = msg.source && typeof msg.source === 'object' ? msg.source : {}
      events.push({ kind: 'toolResult', time, sessionId, callId: String(src.callId || d.callId || ''), error: d.error != null })
    }
  }
  if (createdAt) events.push({ kind: 'created', time: createdAt, sessionId })
  cache.set(key, events)
  if (cache.size > MAX_FILES) cache.delete(cache.keys().next().value)
  return events
}

function inRange(ts, since, until) {
  return ts >= since && ts <= until
}

export function readDshStats(opts = {}) {
  const now = Number(opts.now) || Date.now()
  const range = ['all', '7d', '30d'].includes(opts.range) ? opts.range : 'all'
  const since = Number.isFinite(opts.since) ? opts.since : rangeSince(range, now)
  const until = Number.isFinite(opts.until) ? opts.until : now
  const offset = Number.isFinite(opts.tzOffsetMs) ? opts.tzOffsetMs : tzOffsetMs(now)
  const dir = opts.sessionsDir || defaultSessionsDir()
  const files = []
  walk(dir, files)
  files.sort((a, b) => a.file.localeCompare(b.file))
  if (!files.length) return { supported: false, range, reason: 'sessions-missing', note: '找不到 dsh 会话目录（~/.dsh/sessions）' }

  let bytes = 0
  const uses = []
  const turnSpans = new Map() // session|turn -> { start, end }
  const toolCalls = []
  const toolResults = new Map()
  const sessions = new Set()
  let costAmount = 0
  let costCurrency = 'CNY'
  for (const f of files) {
    if (bytes > MAX_BYTES) break
    bytes += f.size
    const events = parseFile(f.file)
    for (const e of events) {
      if (e.time > now + 5 * 60_000) continue
      if (!inRange(e.time, since, until)) continue
      if (e.sessionId) sessions.add(e.sessionId)
      if (e.kind === 'use') {
        uses.push(e)
        const c = costOfUsage(
          e.model,
          {
            input_tokens: e.input,
            output_tokens: e.output,
            reasoning_tokens: e.reasoning,
            cache_read_input_tokens: e.cacheRead,
            cache_creation_input_tokens: 0,
            computed_total_tokens: e.total,
          },
          e.time,
          e.provider
        )
        if (Number(c.amount) > 0) {
          if (costAmount === 0) costCurrency = c.currency || costCurrency
          if ((c.currency || 'CNY') === costCurrency) costAmount += Number(c.amount) || 0
        }
      } else if (e.kind === 'turnStart') {
        const key = e.sessionId + '|' + e.turn
        const cur = turnSpans.get(key) || {}
        cur.start = e.time
        turnSpans.set(key, cur)
      } else if (e.kind === 'turnEnd') {
        const key = e.sessionId + '|' + e.turn
        const cur = turnSpans.get(key) || {}
        if (cur.start != null && e.time >= cur.start) cur.end = e.time
        turnSpans.set(key, cur)
      } else if (e.kind === 'toolCall') {
        toolCalls.push(e)
      } else if (e.kind === 'toolResult') {
        if (e.callId) toolResults.set(e.callId, e)
      }
    }
  }

  const totals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelRequestCount: uses.length,
    modelErrorCount: 0,
    avgTimeToFirstTokenMs: null,
  }
  const modelMap = new Map()
  const dayMap = new Map()
  const dayModelMap = new Map()
  for (const u of uses) {
    totals.totalTokens += u.total
    totals.inputTokens += u.input
    totals.outputTokens += u.output
    totals.reasoningTokens += u.reasoning
    totals.cacheReadTokens += u.cacheRead
    const modelId = u.model || null
    const m = modelMap.get(modelId) || { modelId, totalTokens: 0, inputTokens: 0, outputTokens: 0, requestCount: 0 }
    m.totalTokens += u.total
    m.inputTokens += u.input
    m.outputTokens += u.output
    m.requestCount += 1
    modelMap.set(modelId, m)
    const day = dayIndexOf(u.time, offset)
    const d = dayMap.get(day) || { dayIndex: day, totalTokens: 0, turnCount: 0, toolCallCount: 0 }
    d.totalTokens += u.total
    dayMap.set(day, d)
    if (modelId) {
      let byModel = dayModelMap.get(day)
      if (!byModel) {
        byModel = new Map()
        dayModelMap.set(day, byModel)
      }
      byModel.set(modelId, (byModel.get(modelId) || 0) + u.total)
    }
  }
  const durations = []
  const sessionDurations = new Map()
  for (const [key, span] of turnSpans) {
    if (span.start == null) continue
    const day = dayIndexOf(span.start, offset)
    const d = dayMap.get(day) || { dayIndex: day, totalTokens: 0, turnCount: 0, toolCallCount: 0 }
    d.turnCount += 1
    dayMap.set(day, d)
    const ms = span.end == null ? 0 : Math.max(0, span.end - span.start)
    durations.push(ms)
    const sid = key.slice(0, key.lastIndexOf('|'))
    sessionDurations.set(sid, (sessionDurations.get(sid) || 0) + ms)
  }
  const toolMap = new Map()
  for (const c of toolCalls) {
    const res = toolResults.get(c.callId)
    const t = toolMap.get(c.name) || { toolName: c.name, callCount: 0, errorCount: 0, totalMs: 0, timed: 0 }
    t.callCount += 1
    if (res && res.error) t.errorCount += 1
    if (res && res.time >= c.time) {
      t.totalMs += res.time - c.time
      t.timed += 1
    }
    toolMap.set(c.name, t)
    const day = dayIndexOf(c.time, offset)
    const d = dayMap.get(day) || { dayIndex: day, totalTokens: 0, turnCount: 0, toolCallCount: 0 }
    d.toolCallCount += 1
    dayMap.set(day, d)
  }

  const longestSessionMs = sessionDurations.size ? Math.max(...sessionDurations.values()) : 0
  const toolList = [...toolMap.values()].map((t) => ({
    toolName: t.toolName,
    callCount: t.callCount,
    errorCount: t.errorCount,
    avgDurationMs: t.timed ? t.totalMs / t.timed : null,
  }))

  return buildStats({
    range,
    now,
    since,
    until,
    tzOffsetMs: offset,
    source: 'dsh:sessions',
    unit: 'tokens',
    cost: costAmount > 0 ? { amount: Math.round(costAmount * 10000) / 10000, currency: costCurrency } : null,
    totals,
    turns: {
      totalSessions: sessions.size,
      totalTurns: turnSpans.size,
      avgTurnDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      longestSessionMs,
    },
    tools: { toolCallCount: toolCalls.length, toolErrorCount: toolList.reduce((s, t) => s + t.errorCount, 0) },
    models: [...modelMap.values()],
    toolList,
    days: [...dayMap.values()],
    dayModels: [...dayModelMap.entries()].flatMap(([dayIndex, byModel]) =>
      [...byModel.entries()].map(([modelId, totalTokens]) => ({ dayIndex, modelId, totalTokens }))
    ),
  })
}
