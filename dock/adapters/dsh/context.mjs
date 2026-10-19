// dsh 上下文取数（M2）。
//
// 与 sessions.mjs 共用「多帧 zstd 逐帧解」的规则，但这里要的是：
//   · 最近一次 usage 的 used / breakdown
//   · request/context 里的 contextWindow
//   · compaction/* 事件（实测存在的压缩记录）
//   · 同一会话的历史点
//
// 口径：used = input + cacheRead + cacheWrite + output（= totalTokens）；
// 这里的 input 是「含缓存的输入」，所以不要再把 cacheRead 加第二次。
// 只解尾部最近若干文件，按 (path,size,mtime) 缓存解析结果。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { contextPct } from '../contracts.mjs'
import { decodeZstdFrames, defaultSessionsDir } from './sessions.mjs'

const MAX_FILES = 12
const MAX_COMPRESSED_BYTES = 24 * 1024 * 1024
const CACHE_TTL_MS = 5000
const cache = new Map() // key(path|size|mtime) -> parsed
const resultCache = new Map() // sessionsDir -> { at, value }

export function _resetDshContextCache() {
  cache.clear()
  resultCache.clear()
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

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function parseFile(file, nowMs) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch (err) {
    return { events: [], contexts: [], compactions: [], meta: { id: '', delegationDepth: 0, origin: '', title: '' } }
  }
  const key = file + '|' + stat.size + '|' + stat.mtimeMs
  const hit = cache.get(key)
  if (hit) return hit

  let text = ''
  try {
    const buf = fs.readFileSync(file)
    if (file.toLowerCase().endsWith('.zstd')) {
      const d = decodeZstdFrames(buf)
      if (!d.ok) return { events: [], contexts: [], compactions: [], meta: { id: '', delegationDepth: 0, origin: '', title: '' } }
      text = d.text
    } else {
      text = buf.toString('utf8')
    }
  } catch (err) {
    return { events: [], contexts: [], compactions: [], meta: { id: '', delegationDepth: 0, origin: '', title: '' } }
  }

  const events = []
  const contexts = []
  const compactions = []
  let meta = { id: '', delegationDepth: 0, origin: '', title: '' }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.charCodeAt(0) !== 123) continue
    let o = null
    try {
      o = JSON.parse(line)
    } catch (err) {
      continue
    }
    if (!o || typeof o !== 'object') continue
    const time = num(o.time)
    if (o.type === 'session') {
      meta = {
        id: String(o.id || meta.id || ''),
        delegationDepth: num(o.delegationDepth),
        origin: String(o.origin || ''),
        title: String(o.title || meta.title || ''),
      }
      continue
    }
    if (o.type === 'request/context') {
      const d = o.data && typeof o.data === 'object' ? o.data : {}
      const cw = num(d.contextWindow) || num(d.context_window)
      if (cw > 0 && time) contexts.push({ t: time, contextWindow: cw, model: String(d.model || ''), provider: String(d.provider || '') })
      continue
    }
    if (typeof o.type === 'string' && o.type.startsWith('compaction/')) {
      const d = o.data && typeof o.data === 'object' ? o.data : {}
      const shadowed = num(d.shadowedTokenCount) || num(d.shadowedTokens)
      compactions.push({ t: time, type: o.type, shadowed })
      continue
    }
    if (o.type !== 'assistant/message' || !o.data || typeof o.data !== 'object') continue
    const u = o.data.usage
    if (!u || typeof u !== 'object') continue
    if (!time || time > nowMs + 5 * 60_000) continue
    const msg = o.data.message && typeof o.data.message === 'object' ? o.data.message : {}
    const src = msg.source && typeof msg.source === 'object' ? msg.source : {}
    const inputRaw = num(u.inputTokens)
    const cacheRead = num(u.cacheReadTokens)
    const cacheWrite = num(u.cacheWriteTokens)
    const output = num(u.outputTokens)
    const total = num(u.totalTokens) || inputRaw + cacheRead + cacheWrite + output
    // input 含缓存：total - output 是本次请求实际送入的上下文
    const inputIncludingCache = total >= output ? total - output : inputRaw + cacheRead + cacheWrite
    if (total <= 0 && inputIncludingCache <= 0 && output <= 0) continue
    events.push({
      t: time,
      turn: num(o.data.turn),
      step: num(o.data.step),
      sessionId: meta.id,
      delegationDepth: meta.delegationDepth,
      origin: meta.origin,
      model: String(src.model || ''),
      provider: String(src.provider || ''),
      input: inputIncludingCache,
      inputRaw,
      cacheRead,
      cacheWrite,
      output,
      reasoning: num(u.reasoningTokens),
      total: total || inputIncludingCache + output,
    })
  }
  const parsed = { events, contexts, compactions, meta }
  cache.set(key, parsed)
  if (cache.size > 64) cache.delete(cache.keys().next().value)
  return parsed
}

function configLimit(home) {
  const file = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  try {
    const text = fs.readFileSync(file, 'utf8')
    // 取文件里最后一个 contextWindow；同机配置通常按模型段落排列，最后一段是当前会话模型
    const all = [...text.matchAll(/contextWindow\s*:\s*(\d+)/g)]
    const last = all[all.length - 1]
    const n = last ? Number(last[1]) : 0
    return Number.isFinite(n) && n > 0 ? n : null
  } catch (err) {
    return null
  }
}

function breakdownOf(e) {
  const out = {}
  const uncached = Math.max(0, e.input - e.cacheRead - e.cacheWrite)
  if (uncached) out.input = uncached
  if (e.cacheRead) out.cacheRead = e.cacheRead
  if (e.cacheWrite) out.cacheWrite = e.cacheWrite
  if (e.output) out.output = e.output
  if (e.reasoning) out.reasoning = e.reasoning
  return Object.keys(out).length ? out : undefined
}

function isMain(e) {
  return !e.origin && e.delegationDepth === 0
}

export function readDshContext(opts = {}) {
  const env = opts.env || process.env
  const home = opts.home || env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const sessionsDir = opts.sessionsDir || defaultSessionsDir(home)
  const now = typeof opts.now === 'function' ? opts.now() : Date.now()
  const cacheKey = sessionsDir + '|' + String(opts.session || '')
  const hit = resultCache.get(cacheKey)
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value

  const files = []
  walk(sessionsDir, files)
  if (!files.length) {
    const value = { supported: false, reason: 'no-data' }
    resultCache.set(cacheKey, { at: now, value })
    return value
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const chosen = []
  let compressed = 0
  for (const f of files) {
    if (chosen.length >= MAX_FILES || compressed + f.size > MAX_COMPRESSED_BYTES) break
    chosen.push(f)
    compressed += f.size
  }

  const all = []
  const contexts = []
  const compactions = []
  for (const f of chosen) {
    const p = parseFile(f.file, now)
    for (const e of p.events) all.push({ ...e, file: f.file })
    for (const c of p.contexts) contexts.push({ ...c, file: f.file })
    for (const c of p.compactions) compactions.push({ ...c, file: f.file })
  }
  if (!all.length) {
    const value = { supported: false, reason: 'no-session' }
    resultCache.set(cacheKey, { at: now, value })
    return value
  }

  const main = all.filter(isMain)
  const pool = main.length ? main : all
  let picked = null
  if (opts.session) picked = pool.filter((e) => e.sessionId === String(opts.session)).sort((a, b) => b.t - a.t)[0] || null
  if (!picked) picked = pool.slice().sort((a, b) => b.t - a.t)[0]
  if (!picked) {
    const value = { supported: false, reason: 'no-session' }
    resultCache.set(cacheKey, { at: now, value })
    return value
  }

  const sessionEvents = all.filter((e) => (picked.sessionId ? e.sessionId === picked.sessionId : e.file === picked.file))
  const points = sessionEvents
    .slice()
    .sort((a, b) => a.t - b.t)
    .slice(-240)
    .map((e) => ({ t: e.t, used: e.total }))

  const limitEvents = contexts.filter((c) => c.file === picked.file).sort((a, b) => b.t - a.t)
  const hostLimit = limitEvents[0] ? limitEvents[0].contextWindow : null
  const limit = hostLimit || configLimit(home)
  const comp = compactions.filter((c) => c.file === picked.file).sort((a, b) => a.t - b.t)
  const starts = comp.filter((c) => c.type === 'compaction/start')
  let compaction
  if (starts.length) {
    const last = starts[starts.length - 1]
    const shadowed = comp.filter((c) => c.t >= last.t).reduce((sum, c) => sum + (c.shadowed || 0), 0)
    compaction = {
      count: starts.length,
      lastAt: last.t,
      shadowedTokens: shadowed || undefined,
      derived: false,
    }
  }

  const used = Math.max(0, picked.total)
  const value = {
    supported: true,
    confidence: hostLimit ? 'exact' : 'derived',
    sessionId: picked.sessionId ? String(picked.sessionId) : '',
    title: String(parseFile(picked.file, now).meta.title || ''),
    model: String(picked.model || ''),
    limit,
    limitSource: hostLimit ? 'host' : limit ? 'config' : 'unknown',
    used,
    breakdown: breakdownOf(picked),
    compaction,
    points,
    updatedAt: picked.t,
  }
  resultCache.set(cacheKey, { at: now, value })
  return value
}

export function listDshSessions(opts = {}) {
  const env = opts.env || process.env
  const home = opts.home || env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const sessionsDir = opts.sessionsDir || defaultSessionsDir(home)
  const now = typeof opts.now === 'function' ? opts.now() : Date.now()
  const files = []
  walk(sessionsDir, files)
  if (!files.length) return []
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const bySession = new Map()
  for (const f of files.slice(0, MAX_FILES)) {
    const p = parseFile(f.file, now)
    const pool = p.events.filter(isMain)
    if (!pool.length) continue // subagent 文件没有主会话事件，不列
    for (const e of pool) {
      const id = e.sessionId || f.file
      const cur = bySession.get(id)
      if (!cur || e.t > cur.t) bySession.set(id, { ...e, file: f.file, title: p.meta.title, limitEvent: p.contexts.sort((a, b) => b.t - a.t)[0] })
    }
  }
  return [...bySession.values()]
    .sort((a, b) => b.t - a.t)
    .slice(0, Math.max(1, Math.min(20, Number(opts.limit) || 8)))
    .map((e) => {
      const limit = (e.limitEvent && e.limitEvent.contextWindow) || configLimit(home)
      return {
        id: String(e.sessionId || path.basename(e.file)),
        title: String(e.title || ''),
        model: e.model,
        used: e.total,
        limit,
        pct: contextPct(e.total, limit),
        requests: 0,
        updatedAt: e.t,
      }
    })
}
