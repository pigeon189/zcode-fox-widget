#!/usr/bin/env node
// 真机对账：逐个宿主读上下文，打印 used/limit/pct 与来源。
// 与宿主界面人工核对时用；Kimi 没有会话时明确 SKIPPED，不算通过。
//
//   node tools/verify-context.mjs [--json]

import { readDshContext } from '../adapters/dsh/context.mjs'
import { readKimiContext } from '../adapters/kimi/context.mjs'
import { readWorkbuddyContext } from '../adapters/workbuddy/context.mjs'
import { readZcodeContext } from '../adapters/zcode/context.mjs'
import { contextPct, normalizeContext } from '../adapters/contracts.mjs'

const asJson = process.argv.includes('--json')
const now = () => Date.now()

function summarize(id, name, raw) {
  const c = normalizeContext(raw, { adapterId: id, adapterName: name })
  return {
    id,
    name,
    status: c.supported
      ? 'PASS'
      : c.reason === 'no-session' || c.reason === 'not-running'
        ? 'SKIPPED'
        : 'UNAVAILABLE',
    reason: c.reason || '',
    sessionId: c.sessionId,
    model: c.model,
    used: c.used,
    limit: c.limit,
    pct: c.supported ? c.pct : contextPct(c.used, c.limit),
    limitSource: c.limitSource,
    points: c.points.length,
    updatedAt: c.updatedAt,
    error: c.error || '',
  }
}

const rows = []
rows.push(summarize('zcode', 'ZCode', readZcodeContext({ now })))
rows.push(summarize('workbuddy', 'WorkBuddy', readWorkbuddyContext({ now })))
rows.push(summarize('dsh', 'DeepSeek Harness', readDshContext({ now })))
rows.push(summarize('kimi', 'Kimi Code', await readKimiContext({ now, timeoutMs: 2000 })))

if (asJson) {
  console.log(JSON.stringify({ ok: true, rows }, null, 2))
} else {
  for (const r of rows) {
    const value = r.used === null ? '—' : r.used.toLocaleString('en-US')
    const limit = r.limit === null ? '—' : r.limit.toLocaleString('en-US')
    const pct = r.pct === null ? '—' : r.pct + '%'
    console.log(
      [r.id.padEnd(10), r.status.padEnd(12), (value + ' / ' + limit).padEnd(24), pct.padEnd(8), r.limitSource.padEnd(13), r.reason || ''].join(' ')
    )
  }
  // 只要有一个「有数据但读失败」就退出非 0；SKIPPED 不失败。
  if (rows.some((r) => r.status === 'UNAVAILABLE')) process.exitCode = 1
}
