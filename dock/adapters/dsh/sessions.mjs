// dsh 用量：读 <DSH_HOME>/sessions 下的会话日志（session.v*.jsonl.zstd）。
//
// 日志是**多帧 zstd**：一个文件里每个事件批次一帧。Node 的
// zlib.zstdDecompressSync() 只解第一帧（实测 3.7MB 文件只出 251 字节），
// 所以这里自己按 zstd 帧头/块头切帧，再逐帧解压。
//
// 事件形状（DeepSeek Harness 0.2.0-rc.2 实测）：
//   {"type":"assistant/message","time":..., "data":{
//      "turn":1,"step":2,"message":{"source":{"provider":"deepseek-official","model":"..."}},
//      "usage":{"inputTokens":236,"outputTokens":295,"totalTokens":9491,
//               "cacheReadTokens":8960,"reasoningTokens":155}}}
//
// 口径与 ZCode 适配器一致：逐次调用按 DeepSeek 峰谷价折算，多币种不混加；
// 上一轮按 turn 归并（不是只看最后一次调用）。取不到价格时只统计 tokens。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { costOfUsage } from '../../engines/pricing.mjs'
import { isUnpriced } from '../../daemon/src/cost-prov.mjs'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f
const CACHE_TTL_MS = 15_000
const MAX_FILES = 48
const MAX_COMPRESSED_BYTES = 24 * 1024 * 1024
const cache = new Map()

export function _resetDshSessionCache() {
  cache.clear()
}

export function defaultSessionsDir(home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  return path.join(home, 'sessions')
}

export function startOfLocalDay(nowMs) {
  const d = new Date(Number(nowMs) || Date.now())
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function frameEnd(buf, start) {
  if (start + 4 > buf.length) return -1
  const magic = buf.readUInt32LE(start)
  if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
    if (start + 8 > buf.length) return -1
    const size = buf.readUInt32LE(start + 4)
    const end = start + 8 + size
    return end <= buf.length ? end : -1
  }
  if (magic !== ZSTD_MAGIC) return -1
  let p = start + 4
  if (p >= buf.length) return -1
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const single = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (!single) {
    if (p >= buf.length) return -1
    p += 1
  }
  p += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
  p += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  if (p > buf.length) return -1
  for (;;) {
    if (p + 3 > buf.length) return -1
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = bh & 1
    const type = (bh >> 1) & 3
    const size = bh >>> 3
    if (type === 3) return -1
    p += type === 1 ? 1 : size
    if (p > buf.length) return -1
    if (last) break
  }
  if (checksum) p += 4
  return p <= buf.length ? p : -1
}

// 按帧解压；任何一帧坏了就跳过它，不拖垮整个文件。
export function decodeZstdFrames(buf, maxOutput = 64 * 1024 * 1024) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return { ok: false, reason: 'zstd-unavailable', text: '' }
  }
  let start = 0
  let total = 0
  const parts = []
  let frames = 0
  while (start < buf.length) {
    const end = frameEnd(buf, start)
    if (end <= start) {
      // 坏帧/尾部垃圾：向后找下一个 zstd magic 继续，而不是放弃整个文件。
      const next = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), start + 1)
      if (next < 0) break
      start = next
      continue
    }
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(start, end))
      total += out.length
      if (total > maxOutput) return { ok: false, reason: 'too-large', text: '', frames }
      parts.push(out)
      frames += 1
    } catch (err) {
      // 坏帧跳过；如果整份都解不出来，调用方会得到空文本
    }
    start = end
  }
  return { ok: true, text: Buffer.concat(parts).toString('utf8'), frames }
}

function walkSessionFiles(dir, out, depth = 0) {
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
      walkSessionFiles(p, out, depth + 1)
      continue
    }
    if (!/^session.*\.jsonl(\.zstd)?$/i.test(e.name)) continue
    try {
      const st = fs.statSync(p)
      out.push({ file: p, size: st.size, mtimeMs: st.mtimeMs })
    } catch (err) {}
  }
}

function parseEvents(file, nowMs) {
  let buf = null
  try {
    buf = fs.readFileSync(file)
  } catch (err) {
    return { events: [], reason: 'read-failed' }
  }
  let text = ''
  if (file.toLowerCase().endsWith('.zstd')) {
    const d = decodeZstdFrames(buf)
    if (!d.ok) return { events: [], reason: d.reason }
    text = d.text
  } else {
    text = buf.toString('utf8')
  }
  const events = []
  let meta = { id: '', delegationDepth: 0, origin: '' }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.charCodeAt(0) !== 123 /* { */) continue
    let o = null
    try {
      o = JSON.parse(line)
    } catch (err) {
      continue
    }
    if (!o) continue
    if (o.type === 'session') {
      meta = {
        id: String(o.id || ''),
        delegationDepth: Number(o.delegationDepth) || 0,
        origin: String(o.origin || ''),
      }
      continue
    }
    if (o.type !== 'assistant/message' || !o.data || typeof o.data !== 'object') continue
    const u = o.data.usage
    if (!u || typeof u !== 'object') continue
    const msg = o.data.message && typeof o.data.message === 'object' ? o.data.message : {}
    const src = msg.source && typeof msg.source === 'object' ? msg.source : {}
    const time = Number(o.time)
    if (!Number.isFinite(time) || time > nowMs + 5 * 60_000) continue
    const input = Number(u.inputTokens) || 0
    const cacheRead = Number(u.cacheReadTokens) || 0
    const output = Number(u.outputTokens) || 0
    const total = Number(u.totalTokens) || input + cacheRead + output
    // DeepSeek 口径：input_tokens 含缓存命中；dsh 把 inputTokens 与 cacheReadTokens
    // 分开给，用 total-output 还原成「含缓存」的输入。
    const inputIncludingCache = total >= output ? total - output : input + cacheRead
    if (total <= 0 && inputIncludingCache <= 0 && output <= 0) continue
    events.push({
      file,
      time,
      turn: Number(o.data.turn) || 0,
      step: Number(o.data.step) || 0,
      sessionId: meta.id,
      delegationDepth: meta.delegationDepth,
      origin: meta.origin,
      model: String(src.model || ''),
      provider: String(src.provider || ''),
      input: inputIncludingCache,
      cacheRead,
      output,
      reasoning: Number(u.reasoningTokens) || 0,
      total: total || inputIncludingCache + output,
    })
  }
  return { events, reason: '' }
}

function priceEvents(events) {
  const byCurrency = {}
  let tokens = 0
  let calls = 0
  let priced = 0
  let unpriced = 0
  for (const e of events) {
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
    if (!c) continue
    calls += 1
    tokens += Number(c.tokens) || 0
    // 价目表未收录（rates=null）是「算不出来」，不是「免费」：不进币种桶、
    // 不补 0。kind='free' 有 rates、金额确实是 0，照常计入。
    if (isUnpriced(c)) {
      unpriced += 1
      continue
    }
    priced += 1
    const amount = Number(c.amount) || 0
    const currency = c.currency || 'CNY'
    byCurrency[currency] = (byCurrency[currency] || 0) + amount
  }
  const keys = Object.keys(byCurrency).sort((a, b) => (byCurrency[b] || 0) - (byCurrency[a] || 0))
  return {
    // 没有任何可计价行时金额不可得（null），不能借 0/CNY 冒充。
    amount: keys.length ? Math.round((byCurrency[keys[0]] || 0) * 10000) / 10000 : unpriced > 0 ? null : 0,
    currency: keys[0] || '',
    byCurrency: keys.length ? byCurrency : {},
    tokens,
    calls,
    priced: priced > 0,
    unpriced,
  }
}

function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// dsh-whale-widget 的账本（老用户可能一直开着它）。只在会话事件读不到今日
// 用量时兜底——它记的是「余额差」，与逐轮 token 计价不是同一口径。
export function readDshwLedger(home, nowMs) {
  const file = path.join(home, '.dshw-usage.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const key = dayKey(nowMs)
    let amount = null
    if (raw && typeof raw.history === 'object' && Number.isFinite(Number(raw.history[key]))) amount = Number(raw.history[key])
    else if (raw && raw.date === key && Number.isFinite(Number(raw.todayUsage))) amount = Number(raw.todayUsage)
    return {
      hasToday: amount !== null,
      amount: Math.round((amount || 0) * 10000) / 10000,
      currency: /^[A-Z]{3}$/.test(String((raw && raw.lastCurrency) || '')) ? raw.lastCurrency : 'CNY',
      lastBalance: raw && Number.isFinite(Number(raw.lastBalance)) ? Number(raw.lastBalance) : null,
      source: '.dshw-usage.json',
    }
  } catch (err) {
    return null
  }
}

// 返回 { ok, today, lastTurn, files, reason }
export function scanDshUsage(opts = {}) {
  const home = opts.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const sessionsDir = opts.sessionsDir || defaultSessionsDir(home)
  const nowMs = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const dayStart = startOfLocalDay(nowMs)
  const cacheKey = sessionsDir + '|' + dayStart
  const hit = cache.get(cacheKey)
  if (hit && nowMs - hit.at < CACHE_TTL_MS) return hit.value

  let files = []
  walkSessionFiles(sessionsDir, files)
  if (!files.length) {
    const value = { ok: false, reason: 'sessions-missing', today: null, lastTurn: null, files: 0 }
    cache.set(cacheKey, { at: nowMs, value })
    return value
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const todayFiles = files.filter((f) => f.mtimeMs >= dayStart - 6 * 3600_000)
  const chosen = []
  const seen = new Set()
  for (const f of todayFiles) {
    if (chosen.length >= MAX_FILES) break
    chosen.push(f)
    seen.add(f.file)
  }
  // 上一轮可能发生在昨天，但文件仍是最新的：补上最近一个文件。
  if (files[0] && !seen.has(files[0].file)) chosen.push(files[0])

  const all = []
  let compressed = 0
  let truncated = false
  for (const f of chosen) {
    compressed += f.size
    if (compressed > MAX_COMPRESSED_BYTES) {
      truncated = true
      break
    }
    const r = parseEvents(f.file, nowMs)
    for (const e of r.events) all.push(e)
  }

  const todayEvents = all.filter((e) => e.time >= dayStart && e.time <= nowMs + 5 * 60_000)
  const today = priceEvents(todayEvents)

  let lastTurn = null
  // 「上一轮」优先取主会话（delegationDepth=0 且不是 subagent），
  // 否则子 agent 的最后一轮会冒充用户眼前这一轮。今日总额仍包含所有调用。
  const mainEvents = all.filter((e) => !e.origin && e.delegationDepth === 0)
  const latest = (mainEvents.length ? mainEvents : all).slice().sort((a, b) => b.time - a.time)[0]
  if (latest) {
    const turnEvents = all.filter((e) => e.file === latest.file && e.turn === latest.turn)
    const p = priceEvents(turnEvents)
    lastTurn = {
      ...p,
      at: Math.max(...turnEvents.map((e) => e.time)),
      turn: latest.turn,
      model: latest.model,
      provider: latest.provider,
      sessionId: latest.sessionId,
    }
  }

  const value = {
    ok: true,
    today: { ...today, events: todayEvents.length },
    lastTurn,
    files: chosen.length,
    events: all.length,
    truncated,
    reason: '',
  }
  cache.set(cacheKey, { at: nowMs, value })
  return value
}
