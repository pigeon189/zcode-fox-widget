// WorkBuddy 积分读取：扫宿主 transcript（<HOST_HOME>/projects/<slug>/<sid>.jsonl）。
//
// 为什么不用 db：宿主库里 session_usage.credit_json 只保留「每个会话最后一次请求」
// 的积分（按请求覆盖），拿不出按日明细。transcript 里每次模型调用都带
// providerData.rawUsage.credit（宿主已经算好的积分）和 conversationRequestId，
// 按日聚合正合适——这也是挂件线同款口径。
//
// 口径：
//   · 今日积分 = 本地零点起、所有 rawUsage 事件的 credit 之和
//   · 上一轮 = 最近一个 conversationRequestId 的 credit 之和（一轮 agent 循环
//     会对同一个 requestId 落几十次调用，必须按请求归并，否则「上一轮」只是
//     最后一次调用的零头）
//
// 性能：只扫今天动过的文件（mtime 过滤），单文件只读尾部，按
// (path,size,mtime) 复用解析结果。2MB 尾部会低估 16%（挂件线实测），所以默认 32MB。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const CACHE_MAX = 8
const fileCache = new Map() // key -> { credits, events }

export function defaultProjectsDir() {
  if (process.env.FOX_DOCK_WORKBUDDY_PROJECTS) return process.env.FOX_DOCK_WORKBUDDY_PROJECTS
  const home = process.env.CODEBUDDY_HOME || path.join(os.homedir(), '.workbuddy')
  return path.join(home, 'projects')
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function tsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = Date.parse(String(v || ''))
  return Number.isFinite(t) ? t : 0
}

// 解析一个 transcript 里所有「带 rawUsage」的事件。
// 返回 { credits: [{ts, rid, credit, tokens}], truncated }
export function parseTranscript(file, maxBytes) {
  let stat = null
  try {
    stat = fs.statSync(file)
  } catch (err) {
    return { credits: [], truncated: false }
  }
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES
  const key = file + '|' + stat.size + '|' + stat.mtimeMs + '|' + cap
  const hit = fileCache.get(key)
  if (hit) return hit

  const truncated = stat.size > cap
  const start = truncated ? Math.max(0, stat.size - cap) : 0
  let text = ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    return { credits: [], truncated }
  }

  const credits = []
  for (const line of text.split(/\r?\n/)) {
    // 快速筛：绝大多数行没有 rawUsage，JSON.parse 全量太贵
    if (!line || line.indexOf('rawUsage') === -1) continue
    let o = null
    try {
      o = JSON.parse(line)
    } catch (err) {
      continue // 尾部截断时第一行可能是半行
    }
    const pd = o && o.providerData
    const raw = pd && pd.rawUsage
    if (!raw) continue
    const ts = tsOf(o.timestamp)
    if (!ts) continue
    const rid = String(pd.conversationRequestId || o.id || '')
    credits.push({
      ts,
      rid: rid || '@' + ts,
      credit: num(raw.credit),
      tokens: num(raw.prompt_tokens) + num(raw.completion_tokens),
    })
  }

  const out = { credits, truncated }
  fileCache.set(key, out)
  if (fileCache.size > CACHE_MAX) {
    const oldest = fileCache.keys().next().value
    fileCache.delete(oldest)
  }
  return out
}

function listTranscripts(projectsDir, sinceMs) {
  let dirs = []
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch (err) {
    return { files: [], reason: 'projects-missing' }
  }
  const files = []
  for (const d of dirs) {
    const sub = path.join(projectsDir, d.name)
    let names = []
    try {
      names = fs.readdirSync(sub)
    } catch (err) {
      continue
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const p = path.join(sub, n)
      try {
        const st = fs.statSync(p)
        // 今天没动过的文件不可能含今日事件（transcript 只追加）
        if (st.mtimeMs < sinceMs) continue
        files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs })
      } catch (err) {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { files, reason: null }
}

// 把事件按 conversationRequestId 归并成「轮」。
//
// **归属日期用轮的首个事件时间**，不是每个事件各自的时间——这是宿主/挂件线的口径：
// 一轮 agent 循环可能横跨午夜（本机实测跨 0 点的那一轮让两天各差 0.82 积分），
// 按事件归属会让同一轮被劈成两半，两个产品对不上账。
export function groupTurns(events) {
  const map = new Map()
  for (const e of events) {
    let t = map.get(e.rid)
    if (!t) {
      t = { rid: e.rid, ts: e.ts, credits: 0, tokens: 0, calls: 0 }
      map.set(e.rid, t)
    }
    t.credits += e.credit
    t.tokens += e.tokens
    t.calls++
    if (e.ts < t.ts) t.ts = e.ts
  }
  return [...map.values()]
}

// 返回 {
//   ok, today: { credits, tokens, events, files, truncated },
//   lastTurn: { credits, tokens, calls, at } | null, reason
// }
export function readCreditUsage(opts = {}) {
  const projectsDir = opts.projectsDir || defaultProjectsDir()
  const nowMs = Number(opts.now) || Date.now()
  const since = Number.isFinite(opts.since) ? opts.since : startOfLocalDay(nowMs)
  const until = Number.isFinite(opts.until) ? opts.until : Number.MAX_SAFE_INTEGER
  const maxBytes = opts.maxBytes

  // 文件按 mtime 过滤：多留 12 小时，保证「上一轮」在早上也能看到昨晚的那一轮
  const listed = listTranscripts(projectsDir, since - 12 * 3600_000)
  if (listed.reason) return { ok: false, reason: listed.reason, projectsDir }

  let credits = 0
  let tokens = 0
  let events = 0
  let truncated = 0
  let lastTurn = null

  for (const f of listed.files) {
    const parsed = parseTranscript(f.path, maxBytes)
    if (parsed.truncated) truncated++
    // 同一个文件内按轮归并；跨文件的同 id 不合并（与挂件线一致：各自成轮）
    for (const t of groupTurns(parsed.credits)) {
      if (!lastTurn || t.ts > lastTurn.ts) {
        lastTurn = { rid: t.rid, ts: t.ts, credits: t.credits, tokens: t.tokens, calls: t.calls }
      }
      if (t.ts < since || t.ts >= until) continue
      credits += t.credits
      tokens += t.tokens
      events += t.calls
    }
  }

  return {
    ok: true,
    today: {
      credits: Math.round(credits * 10000) / 10000,
      tokens,
      events,
      files: listed.files.length,
      truncated,
    },
    lastTurn: lastTurn
      ? {
          rid: lastTurn.rid,
          credits: Math.round(lastTurn.credits * 10000) / 10000,
          tokens: lastTurn.tokens,
          calls: lastTurn.calls,
          at: lastTurn.ts,
        }
      : null,
    projectsDir,
  }
}

export function startOfLocalDay(nowMs) {
  const d = new Date(Number(nowMs) || Date.now())
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function _clearCache() {
  fileCache.clear()
}
