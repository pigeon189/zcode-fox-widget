// 适配器注册表：窗口 → 适配器。
//
// 匹配顺序不由数组顺序决定，而是「得分高者优先，同分看 priority，再同按 id」——
// 这样模块加载顺序变化不会改变行为，测试也能钉住排序规则。

import { normalizeWindow, scoreMatch, validateAdapter } from './contracts.mjs'
import { genericAdapter } from './generic.mjs'
import { zcodeAdapter } from './zcode/index.mjs'
import { workbuddyAdapter } from './workbuddy/index.mjs'
import { kimiAdapter } from './kimi/index.mjs'
import { dshAdapter } from './dsh/index.mjs'

// 顺序不重要（见上面的排序规则）
export const builtinAdapters = [genericAdapter, zcodeAdapter, workbuddyAdapter, kimiAdapter, dshAdapter]

export function adaptersWithBilling(list = builtinAdapters) {
  return list.filter((a) => a && a.capabilities && a.capabilities.billing === true)
}

export function assertAdapters(list) {
  const seen = new Set()
  const problems = []
  for (const a of list) {
    for (const e of validateAdapter(a)) problems.push(String(a && a.id) + ': ' + e)
    if (a && seen.has(a.id)) problems.push('duplicate adapter id: ' + a.id)
    if (a) seen.add(a.id)
  }
  return problems
}

// 返回 { id, name, adapter, score, fallback, capabilities }
export function resolveAdapter(win, list = builtinAdapters) {
  const w = normalizeWindow(win)
  const pool = (list || []).filter((a) => a && !a.fallback && a.capabilities)

  let best = null
  for (const a of pool) {
    const score = scoreMatch(a.match, w)
    if (score < 0) continue
    const cand = { adapter: a, score, priority: Number(a.priority) || 0 }
    if (!best) {
      best = cand
      continue
    }
    if (cand.score > best.score) best = cand
    else if (cand.score === best.score && cand.priority > best.priority) best = cand
    else if (cand.score === best.score && cand.priority === best.priority && String(a.id) < String(best.adapter.id)) best = cand
  }

  if (!best) {
    return {
      id: genericAdapter.id,
      name: genericAdapter.name,
      adapter: genericAdapter,
      score: 0,
      fallback: true,
      capabilities: { ...genericAdapter.capabilities },
    }
  }

  return {
    id: best.adapter.id,
    name: best.adapter.name,
    adapter: best.adapter,
    score: best.score,
    fallback: false,
    capabilities: { ...best.adapter.capabilities },
  }
}

// 给 /adapters 与 CLI 用的轻量描述（不带函数）
export function describeAdapters(list = builtinAdapters) {
  return (list || []).map((a) => ({
    id: a.id,
    name: a.name,
    priority: Number(a.priority) || 0,
    fallback: !!a.fallback,
    billing: !!(a.capabilities && a.capabilities.billing),
    follow: !!(a.capabilities && a.capabilities.follow),
    roleDefault: a.roleDefault || '',
    accent: a.accent || '',
    match: {
      exeBasenames: (a.match && a.match.exeBasenames) || [],
      exeIncludes: (a.match && a.match.exeIncludes) || [],
      titleIncludes: (a.match && a.match.titleIncludes) || [],
      classes: (a.match && a.match.classes) || [],
    },
  }))
}
