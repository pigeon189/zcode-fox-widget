// WorkBuddy 应用用量统计：从 transcript 的逐次模型调用/工具事件聚合。
//
// 与 ZCode 的统计页同一套契约。WorkBuddy 没有本地 SQLite 用量库，但每行
// providerData.rawUsage 都带宿主算好的 token / credit，够做摘要、热力图、
// 模型占比和工具用量。turn 按 conversationRequestId 归并，和积分口径一致。

import fs from 'node:fs'
import path from 'node:path'
import { buildStats, dayIndexOf, rangeSince, tzOffsetMs } from '../stats.mjs'
import { defaultProjectsDir, listTranscripts } from './transcripts.mjs'

const CACHE_MAX = 64
const cache = new Map() // path|size|mtime -> parsed

export function _resetWorkbuddyStatsCache() {
  cache.clear()
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function usageOf(o) {
  const pd = o && o.providerData
  const raw = pd && pd.rawUsage
  if (!raw) return null
  const input = num(raw.prompt_tokens)
  const output = num(raw.completion_tokens)
  const total = num(raw.total_tokens) || input + output
  const details = raw.completion_tokens_details && typeof raw.completion_tokens_details === 'object' ? raw.completion_tokens_details : {}
  const promptDetails = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object' ? raw.prompt_tokens_details : {}
  return {
    input,
    output,
    total,
    cacheRead: num(raw.prompt_cache_hit_tokens) || num(raw.cache_read_input_tokens) || num(raw.cached_tokens) || num(promptDetails.cached_tokens),
    cacheCreation: num(raw.prompt_cache_write_tokens) || num(raw.cache_creation_input_tokens),
    reasoning: num(details.reasoning_tokens) || num(raw.completion_thinking_tokens),
    credit: num(raw.credit),
    model: String(pd.model || pd.requestModelId || pd.requestModelName || o.model || ''),
    rid: String(pd.conversationRequestId || o.id || ''),
  }
}

function parseFile(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch (err) {
    return { uses: [], calls: [], results: [] }
  }
  const key = file + '|' + stat.size + '|' + stat.mtimeMs
  const hit = cache.get(key)
  if (hit) return hit

  const fallbackSession = path.basename(file, path.extname(file))
  const uses = []
  const calls = []
  const results = []
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { uses, calls, results }
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    // 只解析统计相关行；transcript 里大量 message/reasoning 行不需要展开。
    if (line.indexOf('rawUsage') === -1 && line.indexOf('"function_call') === -1) continue
    let o = null
    try {
      o = JSON.parse(line)
    } catch (err) {
      continue
    }
    if (!o || typeof o !== 'object') continue
    const ts = num(o.timestamp)
    if (!ts) continue
    const sessionId = String(o.sessionId || o.session_id || fallbackSession)
    // function_call 行本身也带 providerData.rawUsage；先记 usage，再记工具调用。
    const u = usageOf(o)
    if (u) uses.push({ ts, sessionId, rid: u.rid || '@' + ts, ...u })
    if (o.type === 'function_call') {
      calls.push({ ts, sessionId, callId: String(o.callId || o.id || ''), name: String(o.name || 'unknown') })
      continue
    }
    if (o.type === 'function_call_result') {
      results.push({ ts, sessionId, callId: String(o.callId || ''), status: String(o.status || '') })
      continue
    }
  }

  const out = { uses, calls, results }
  cache.set(key, out)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  return out
}

function inRange(ts, since, until) {
  return ts >= since && ts <= until
}

export function readWorkbuddyStats(opts = {}) {
  const now = Number(opts.now) || Date.now()
  const range = ['all', '7d', '30d'].includes(opts.range) ? opts.range : 'all'
  const since = Number.isFinite(opts.since) ? opts.since : rangeSince(range, now)
  const until = Number.isFinite(opts.until) ? opts.until : now
  const offset = Number.isFinite(opts.tzOffsetMs) ? opts.tzOffsetMs : tzOffsetMs(now)
  const listed = listTranscripts(opts.projectsDir || defaultProjectsDir(), 0)
  if (listed.reason) {
    return { supported: false, range, reason: listed.reason, note: '找不到 WorkBuddy 会话目录（~/.workbuddy/projects）' }
  }

  const uses = []
  const calls = []
  const results = []
  for (const f of listed.files) {
    const parsed = parseFile(f.path)
    for (const u of parsed.uses) if (inRange(u.ts, since, until)) uses.push(u)
    for (const c of parsed.calls) if (inRange(c.ts, since, until)) calls.push(c)
    for (const r of parsed.results) if (inRange(r.ts, since, until)) results.push(r)
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
  const turnMap = new Map()
  const sessionSpan = new Map()
  let credits = 0

  function touchSession(id, ts) {
    const cur = sessionSpan.get(id)
    if (!cur) sessionSpan.set(id, { first: ts, last: ts })
    else {
      if (ts < cur.first) cur.first = ts
      if (ts > cur.last) cur.last = ts
    }
  }

  for (const u of uses) {
    totals.totalTokens += u.total
    totals.inputTokens += u.input
    totals.outputTokens += u.output
    totals.reasoningTokens += u.reasoning
    totals.cacheCreationTokens += u.cacheCreation
    totals.cacheReadTokens += u.cacheRead
    credits += u.credit

    const modelId = u.model || null
    const m = modelMap.get(modelId) || { modelId, totalTokens: 0, inputTokens: 0, outputTokens: 0, requestCount: 0, credits: 0 }
    m.totalTokens += u.total
    m.inputTokens += u.input
    m.outputTokens += u.output
    m.requestCount += 1
    m.credits += u.credit
    modelMap.set(modelId, m)

    const day = dayIndexOf(u.ts, offset)
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

    const t = turnMap.get(u.rid)
    if (!t) turnMap.set(u.rid, { first: u.ts, last: u.ts, sessionId: u.sessionId })
    else {
      if (u.ts < t.first) t.first = u.ts
      if (u.ts > t.last) t.last = u.ts
    }
    touchSession(u.sessionId, u.ts)
  }

  const resultByCall = new Map()
  for (const r of results) if (r.callId) resultByCall.set(r.callId, r)
  const toolMap = new Map()
  for (const c of calls) {
    const res = resultByCall.get(c.callId)
    const t = toolMap.get(c.name) || { toolName: c.name, callCount: 0, errorCount: 0, totalMs: 0, timed: 0 }
    t.callCount += 1
    if (res && res.status && res.status !== 'completed') t.errorCount += 1
    if (res && res.ts >= c.ts) {
      t.totalMs += res.ts - c.ts
      t.timed += 1
    }
    toolMap.set(c.name, t)
    const day = dayIndexOf(c.ts, offset)
    const d = dayMap.get(day) || { dayIndex: day, totalTokens: 0, turnCount: 0, toolCallCount: 0 }
    d.toolCallCount += 1
    dayMap.set(day, d)
    touchSession(c.sessionId, c.ts)
  }
  for (const t of turnMap.values()) {
    const day = dayIndexOf(t.first, offset)
    const d = dayMap.get(day) || { dayIndex: day, totalTokens: 0, turnCount: 0, toolCallCount: 0 }
    d.turnCount += 1
    dayMap.set(day, d)
  }

  const turnDurations = [...turnMap.values()].map((t) => Math.max(0, t.last - t.first))
  // 与 ZCode 的「最长聊天」同口径：会话内各回合时长之和，而不是首尾墙钟差
  //（transcript 的会话可能跨天闲置，首尾差会把吃饭睡觉都算进去）。
  const sessionTurnMs = new Map()
  for (const t of turnMap.values()) {
    sessionTurnMs.set(t.sessionId, (sessionTurnMs.get(t.sessionId) || 0) + Math.max(0, t.last - t.first))
  }
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
    source: 'workbuddy:transcripts',
    unit: 'tokens',
    credits,
    totals,
    turns: {
      totalSessions: sessionSpan.size,
      totalTurns: turnMap.size,
      avgTurnDurationMs: turnDurations.length ? turnDurations.reduce((a, b) => a + b, 0) / turnDurations.length : null,
      longestSessionMs: sessionTurnMs.size ? Math.max(...sessionTurnMs.values()) : 0,
    },
    tools: { toolCallCount: calls.length, toolErrorCount: toolList.reduce((s, t) => s + t.errorCount, 0) },
    models: [...modelMap.values()].map((m) => ({ ...m, credits: Math.round(m.credits * 10000) / 10000 })),
    toolList,
    days: [...dayMap.values()],
    dayModels: [...dayModelMap.entries()].flatMap(([dayIndex, byModel]) =>
      [...byModel.entries()].map(([modelId, totalTokens]) => ({ dayIndex, modelId, totalTokens }))
    ),
  })
}
