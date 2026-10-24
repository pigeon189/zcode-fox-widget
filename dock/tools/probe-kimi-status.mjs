#!/usr/bin/env node
// M0 P-3 探针：Kimi Code 本机服务的会话状态字段（只读，不入 CI）。
//
//   node tools/probe-kimi-status.mjs [--json]
//
// 有忙闲字段 → Kimi 支持 working/idle；没有 → status:'unknown' 且 provenance
// unavailable（host-unsupported），绝不伪造 working。

import { defaultKimiHome, discoverLocalServer } from '../adapters/kimi/context.mjs'

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const asJson = process.argv.includes('--json')
const home = arg('--home', '') || defaultKimiHome()
const server = discoverLocalServer({ home })
const report = { probe: 'P-3-kimi-status', at: new Date().toISOString(), home, ok: false, sessions: [], statusKeys: [], busyFields: [], conclusion: '' }

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function get(p) {
  const res = await fetch(server.baseUrl + p, {
    headers: { authorization: 'Bearer ' + server.token, accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  })
  let body = null
  try {
    body = await res.json()
  } catch (err) {}
  return { status: res.status, ok: res.ok, body }
}

function asArray(body) {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return []
  for (const k of ['sessions', 'data', 'items', 'list']) if (Array.isArray(body[k])) return body[k]
  return []
}

if (!server.baseUrl) {
  report.conclusion = 'Kimi 本地服务未运行（' + (server.reason || 'not-running') + '）'
} else {
  try {
    const list = await get('/sessions')
    const sessions = asArray(list.body)
    report.ok = list.ok
    report.sessionCount = sessions.length
    for (const s of sessions.slice(0, 5)) {
      const id = String(s.id || s.session_id || s.sessionId || '')
      const one = id ? await get('/sessions/' + encodeURIComponent(id) + '/status') : { ok: false, body: null }
      const keys = one.body && typeof one.body === 'object' ? Object.keys(one.body).sort() : []
      report.statusKeys = [...new Set([...report.statusKeys, ...keys])]
      report.sessions.push({ id, title: s.title || s.name || '', statusKeys: keys, status: one.body })
    }
    const busy = report.statusKeys.filter((k) => /^(state|status|busy|running|working|active|phase)$/i.test(k))
    report.busyFields = busy
    report.conclusion = busy.length
      ? '发现忙闲字段：' + busy.join(', ') + ' → 需人工确认取值语义后启用 working/idle'
      : '没有忙闲字段 → status 固定 unknown（host-unsupported），不得伪造 working'
  } catch (err) {
    report.error = String((err && err.message) || err)
    report.conclusion = '探测失败：' + report.error
  }
}

if (asJson) console.log(JSON.stringify(report, null, 2))
else {
  console.log('# Kimi Code 状态探针（P-3）')
  console.log(report.conclusion)
  console.log(JSON.stringify(report.sessions, null, 2))
}
