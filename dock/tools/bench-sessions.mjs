#!/usr/bin/env node
// M2/M4 基准：合成 ZCode 库 / WB jsonl / dsh zstd，测会话列表与下钻聚合。
//
//   node tools/bench-sessions.mjs [--rows 200000] [--mb 20] [--dsh 40]
//
// 结果打印 JSON；发版前把结果贴进 docs/dock/TESTING.md「基准」小节。
// 目标：/v1/sessions p95 <200ms、aggregateUsage p95 <300ms、WB 增量 <20ms。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { aggregateUsage, getSessions, _resetZcodeSessions } from '../adapters/zcode/sessions.mjs'
import { getSessions as getWorkbuddySessions, _resetWorkbuddyLive } from '../adapters/workbuddy/sessions.mjs'
import { getSessions as getDshSessions } from '../adapters/dsh/live.mjs'

const require = createRequire(import.meta.url)
const sqlite = (() => {
  try {
    return require('node:sqlite')
  } catch (err) {
    return null
  }
})()

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0) return Number(process.argv[i + 1]) || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? Number(eq.slice(name.length + 1)) || fallback : fallback
}

const ROWS = arg('--rows', 200_000)
const MB = arg('--mb', 20)
const DSH = arg('--dsh', 40)
const NOW = Date.now()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-bench-'))

function p95(list) {
  if (!list.length) return null
  const sorted = [...list].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] * 10) / 10
}

async function benchZcode() {
  if (!sqlite) return { skipped: 'node:sqlite unavailable' }
  const file = path.join(dir, 'db.sqlite')
  const db = new sqlite.DatabaseSync(file, { timeout: 5000 })
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE model_usage (session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, computed_total_tokens INTEGER);
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER);
    CREATE TABLE tool_usage (session_id TEXT, turn_id TEXT, tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);
  `)
  const insS = db.prepare(`INSERT INTO session VALUES (?,?,?,?,?,?,NULL)`)
  const insM = db.prepare(`INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insT = db.prepare(`INSERT INTO turn_usage VALUES (?,?,?,?,?,?)`)
  const insTool = db.prepare(`INSERT INTO tool_usage VALUES (?,?,?,?,?,?)`)
  db.exec('BEGIN')
  const sessions = Math.max(1, Math.floor(ROWS / 50))
  for (let s = 0; s < sessions; s++) {
    const sid = 'sess_' + s
    insS.run(sid, null, 'bench session ' + s, 'D:\\bench', NOW - 86400000, NOW - s * 1000)
    for (let i = 0; i < 50; i++) {
      const at = NOW - s * 1000 - i * 1000
      insM.run(sid, 't' + Math.floor(i / 10), 'deepseek', 'deepseek-flash', 'completed', at, at + 500, 1000, 200, 0, 300, 0, 1200)
      if (i % 10 === 0) insT.run(sid, 't' + Math.floor(i / 10), 'completed', at, at + 9000, 9000)
      if (i % 5 === 0) insTool.run(sid, 't' + Math.floor(i / 10), 'Bash', 'completed', at, 120)
    }
  }
  db.exec('COMMIT')
  db.close()
  const out = { rows: ROWS, sessions }
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now()
    await getSessions({ dbFile: file, now: NOW, limit: 50 })
    ;(out.sessionsMs || (out.sessionsMs = [])).push(performance.now() - t0)
  }
  for (const by of ['agent', 'model', 'session']) {
    const times = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      await aggregateUsage({ dbFile: file, now: NOW, by, since: NOW - 7 * 86400000, until: NOW })
      times.push(performance.now() - t0)
    }
    out['breakdown_' + by + 'Ms'] = times.map((x) => Math.round(x * 10) / 10)
    out['breakdown_' + by + '_p95'] = p95(times)
  }
  out.sessions_p95 = p95(out.sessionsMs)
  out.sessionsMs = out.sessionsMs.map((x) => Math.round(x * 10) / 10)
  _resetZcodeSessions()
  return out
}

async function benchWorkbuddy() {
  const home = path.join(dir, 'wb')
  const proj = path.join(home, 'projects', 'bench')
  fs.mkdirSync(proj, { recursive: true })
  const file = path.join(proj, 'bench.jsonl')
  const line = (i) =>
    JSON.stringify({
      sessionId: 'wb_bench',
      timestamp: NOW - 3600_000 + i,
      type: 'assistant',
      providerData: {
        conversationRequestId: 'r' + Math.floor(i / 20),
        model: 'wb-pro',
        rawUsage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, credit: 0.02 },
      },
    }) + '\n'
  const target = MB * 1024 * 1024
  const fd = fs.openSync(file, 'w')
  let written = 0
  let i = 0
  while (written < target) {
    const chunk = line(i++)
    fs.writeSync(fd, chunk)
    written += Buffer.byteLength(chunk)
  }
  fs.closeSync(fd)
  _resetWorkbuddyLive && _resetWorkbuddyLive()
  const t0 = performance.now()
  const first = await getWorkbuddySessions({ projectsDir: path.join(home, 'projects'), dbFile: path.join(home, 'none.db'), now: NOW, limit: 50 })
  const fullMs = performance.now() - t0
  const inc = []
  for (let k = 0; k < 5; k++) {
    fs.appendFileSync(file, line(i++))
    const t1 = performance.now()
    await getWorkbuddySessions({ projectsDir: path.join(home, 'projects'), dbFile: path.join(home, 'none.db'), now: NOW, limit: 50 })
    inc.push(performance.now() - t1)
  }
  return {
    mb: MB,
    lines: i,
    firstCallMs: Math.round(fullMs * 10) / 10,
    appendMs: inc.map((x) => Math.round(x * 10) / 10),
    appendOneLine_p95: p95(inc),
    appendOneLineMs: Math.round(Math.min(...inc) * 10) / 10,
    ok: !!(first && first.ok),
  }
}

async function benchDsh() {
  const home = path.join(dir, 'dsh')
  const sessions = path.join(home, 'sessions', 'p1')
  fs.mkdirSync(sessions, { recursive: true })
  for (let i = 0; i < DSH; i++) {
    const events = [
      { type: 'session', id: 'dsh_' + i, time: NOW - 3600_000, title: 'dsh bench ' + i },
      { type: 'turn/start', time: NOW - 3000_000, data: { turn: 1 } },
      {
        type: 'assistant/message',
        time: NOW - 2900_000,
        data: { turn: 1, usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1400, cacheReadTokens: 200 }, message: { source: { model: 'deepseek-v4', provider: 'deepseek' } } },
      },
      { type: 'turn/end', time: NOW - 2800_000, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
    fs.writeFileSync(path.join(sessions, 'session' + i + '.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(text)))
  }
  const times = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    await getDshSessions({ sessionsDir: sessions, now: NOW, limit: 50 })
    times.push(performance.now() - t0)
  }
  return { files: DSH, ms: times.map((x) => Math.round(x * 10) / 10), p95: p95(times) }
}

try {
  const result = {
    at: new Date().toISOString(),
    zcode: await benchZcode(),
    workbuddy: await benchWorkbuddy(),
    dsh: await benchDsh(),
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
