// 生成 pre.2 验收用的夹具场景（§9.3.1）。可重复执行，覆盖已有文件。
//   node tools/make-pre2-scenes.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(HERE, '..', 'test', 'fixtures', 'scenes')
const T = Date.UTC(2026, 9, 21, 4, 0, 0)
const DAY = 86400000
const stamp = (n) => new Date(T + n * DAY).toISOString().slice(0, 10)
const prov = (kind, origin, source, extra = {}) => ({ kind, origin, source, asOf: T, ...extra })

const agents = [
  { id: 'zcode', name: 'ZCode', running: true, windows: [{ hwnd: '0x1', pid: 100, title: 'TianShu v0.2' }], accent: '#f0a04b', roleDefault: 'fox', context: true },
  { id: 'workbuddy', name: 'WorkBuddy', running: true, windows: [{ hwnd: '0x2', pid: 200, title: 'WorkBuddy' }], accent: '#22b8a0', roleDefault: 'xiaoke', context: true },
  { id: 'kimi', name: 'Kimi Code', running: true, windows: [{ hwnd: '0x3', pid: 300, title: 'Kimi Code' }], accent: '#b07cff', roleDefault: 'kimi', context: true },
  { id: 'dsh', name: 'DeepSeek Harness', running: true, windows: [{ hwnd: '0x4', pid: 400, title: 'DeepSeek Harness' }], accent: '#4d6bfe', roleDefault: 'whale', context: true },
]
const pet = { mode: 'attached', agentId: 'zcode', lastAgentId: 'zcode', profileOf: 'zcode', hwnd: '0x1', rect: null, display: null }
const settings = {
  schema: 3,
  roleId: 'fox',
  theme: 'light',
  scale: 1,
  showChip: true,
  menuButton: 'hover',
  displayMode: 'auto',
  contextWarnPct: 80,
  quotaWarnPct: 0,
  budgetMoney: 0,
  weeklyBudget: 0,
  monthlyBudget: 0,
  costAnomalyX: 0,
  autoStart: true,
  confirmAlert: true,
  live: { enabled: true },
  permission: { takeover: false, waitMs: 15000, notify: 'whenHidden', hotkeys: { allow: 'Ctrl+Alt+Y', deny: 'Ctrl+Alt+N' } },
  ingest: { enabled: true },
  retentionDays: 30,
  profiles: {},
  hotkeys: { toggle: 'Ctrl+Alt+F', console: 'Ctrl+Alt+D', hideMoney: 'Ctrl+Alt+H' },
  pet,
}
const context = {
  supported: true,
  confidence: 'exact',
  sessionId: 'ses_parent',
  title: '重构 billing 适配器',
  model: 'deepseek-v4.1-flash',
  used: 475318,
  limit: 1000000,
  limitSource: 'host',
  pct: 47.5,
  breakdown: { input: 20000, cacheRead: 400000, output: 30000 },
  points: [
    { t: T - 3600000, used: 300000 },
    { t: T - 2400000, used: 380000 },
    { t: T - 1200000, used: 430000 },
    { t: T - 600000, used: 475318 },
  ],
  updatedAt: T,
  provenance: {
    used: prov('exact', 'local-db', 'zcode:db.sqlite#model_usage'),
    limit: prov('exact', 'local-db', 'zcode:db.sqlite'),
  },
}
function snapshot(o = {}) {
  return {
    ok: true,
    supported: true,
    unit: o.unit || 'money',
    capturedAt: T,
    today: o.today === undefined ? { amount: 12.34, currency: 'CNY', byCurrency: { CNY: 12.34 } } : o.today,
    turn: o.turn === undefined ? { amount: 0.28, currency: 'CNY', byCurrency: { CNY: 0.28 }, at: T - 60000 } : o.turn,
    balance: o.balance === undefined ? { amount: 63.2, currency: 'CNY' } : o.balance,
    quota: o.quota === undefined ? { usedPct: 28, remainingPct: 72 } : o.quota,
    quotaCard:
      o.quotaCard === undefined
        ? {
            kind: 'windows',
            title: 'GLM Plan',
            plan: 'GLM Plan',
            source: 'zplan',
            windows: [
              { key: '5h', label: '5 小时', usedPct: 28, remainingPct: 72, resetAt: T + 3 * 3600000, prov: prov('exact', 'api', 'vendor:zplan') },
              { key: 'week', label: '本周', usedPct: 42, remainingPct: 58, resetAt: T + 2 * DAY, prov: prov('exact', 'api', 'vendor:zplan') },
            ],
          }
        : o.quotaCard,
    details: o.details || [
      { label: '今日 tokens', value: '2.40M' },
      { label: '当前厂商', value: 'GLM Plan' },
    ],
    period: null,
    source: 'zcode:db.sqlite',
    usage: o.usage === undefined ? { todayTokens: 2400000, turnTokens: 180000 } : o.usage,
    provenance: {
      today: prov('estimated', 'pricing-table', 'pricing:2026-10 GLM 谷'),
      turn: prov('estimated', 'pricing-table', 'pricing:2026-10 GLM 谷'),
      balance: prov('exact', 'api', 'vendor:zplan'),
      quota: prov('exact', 'api', 'vendor:zplan'),
      usage: prov('exact', 'local-db', 'zcode:db.sqlite#model_usage'),
      ...(o.provenance || {}),
    },
  }
}
function session(o) {
  return {
    key: o.agentId + ':' + o.sessionId,
    agentId: o.agentId,
    sessionId: o.sessionId,
    parentKey: o.parentKey || null,
    title: o.title || '',
    cwd: o.cwd || '',
    model: o.model || '',
    provider: o.provider || '',
    status: o.status || 'idle',
    statusSince: o.statusSince || T - 120000,
    statusSource: o.statusSource || 'db',
    startedAt: o.startedAt == null ? T - 3600000 : o.startedAt,
    updatedAt: o.updatedAt == null ? T - 60000 : o.updatedAt,
    endedAt: o.endedAt || null,
    turns: {
      count: o.turns || 0,
      current: o.status === 'working' ? { id: 't', index: Math.max(1, o.turns || 1), startedAt: T - 60000 } : null,
      avgDurationMs: o.avgDurationMs || 42000,
    },
    tokens:
      o.tokens == null
        ? { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null }
        : {
            total: o.tokens,
            input: Math.round(o.tokens * 0.7),
            output: Math.round(o.tokens * 0.3),
            cacheRead: Math.round(o.tokens * 0.4),
            cacheWrite: null,
            reasoning: null,
          },
    cost: o.cost === undefined ? null : o.cost,
    tools: { calls: o.calls || 0, errors: o.errors || 0, running: o.running || [] },
    errors: { model: o.modelErrors || 0, tool: o.errors || 0, last: o.lastError || null },
    pending: o.pending || [],
    provenance: {
      tokens:
        o.tokens == null
          ? prov('unavailable', 'local-log', 'fixture:no-history', { reason: 'no-data' })
          : prov('exact', o.agentId === 'zcode' ? 'local-db' : 'local-log', 'fixture#' + o.agentId),
      cost: o.costProv || (o.cost ? prov('estimated', 'pricing-table', 'pricing:2026-10 fixture') : prov('unavailable', 'unknown', 'fixture:no-cost', { reason: 'no-data' })),
      status:
        o.statusProv ||
        (o.status === 'unknown'
          ? prov('unavailable', 'http', 'kimi:/sessions', { reason: 'host-unsupported' })
          : prov('exact', 'db', 'fixture#status')),
      tools:
        o.toolsProv ||
        (o.agentId === 'kimi'
          ? prov('unavailable', 'local-log', 'fixture#tools', { reason: 'host-unsupported' })
          : prov('exact', 'local-log', 'fixture#tools')),
    },
  }
}
function computeLive(items) {
  const counts = { working: 0, waiting: 0, waiting_permission: 0, waiting_input: 0, error: 0, done: 0, idle: 0, unknown: 0 }
  const byAgent = {}
  for (const s of items) {
    if (s.status === 'waiting_permission') {
      counts.waiting += 1
      counts.waiting_permission += 1
    } else if (s.status === 'waiting_input') {
      counts.waiting += 1
      counts.waiting_input += 1
    } else if (counts[s.status] != null) counts[s.status] += 1
    else counts.unknown += 1
    const r = byAgent[s.agentId] || (byAgent[s.agentId] = { working: 0, waiting: 0, error: 0, done: 0, total: 0, lastAt: 0 })
    r.total += 1
    r.lastAt = Math.max(r.lastAt, s.updatedAt)
    if (s.status === 'working') r.working += 1
    else if (s.status === 'waiting_permission' || s.status === 'waiting_input') r.waiting += 1
    else if (s.status === 'error') r.error += 1
    else if (s.status === 'done') r.done += 1
  }
  let aggregate = 'idle'
  if (counts.waiting_permission) aggregate = 'waiting_permission'
  else if (counts.error) aggregate = 'error'
  else if (counts.waiting_input) aggregate = 'waiting_input'
  else if (counts.working) aggregate = 'working'
  else if (counts.done) aggregate = 'done'
  else if (counts.unknown) aggregate = 'unknown'
  return { aggregate, counts, byAgent }
}
function write(name, extra = {}) {
  const items = extra.liveSessions || []
  const live = extra.live || computeLive(items)
  const scene = {
    state: { pet: { ...(extra.pet || pet) }, agents: extra.agents || agents, ...(extra.state || {}), live },
    agents: extra.agents || agents,
    snapshots: extra.snapshots || { zcode: snapshot() },
    contexts: extra.contexts || { zcode: context },
    liveSessions: items,
    live,
    details: extra.details || {},
    settings: { ...settings, ...(extra.settings || {}) },
    roles: [],
    profiles: { zcode: { roleId: 'fox' } },
    vendors: extra.vendors || [],
    usage: extra.usage || { today: { date: stamp(0), groups: [] }, days: [] },
    breakdown: extra.breakdown || null,
    stats: extra.stats || {},
    adapters: [
      { id: 'zcode', name: 'ZCode', billing: true, context: true, follow: true },
      { id: 'workbuddy', name: 'WorkBuddy', billing: true, context: true, follow: true },
      { id: 'kimi', name: 'Kimi Code', billing: true, context: true, follow: true },
      { id: 'dsh', name: 'DeepSeek Harness', billing: true, context: true, follow: true },
    ],
    bindings: [],
    update: { history: [] },
    ingest: { enabled: true, integrationDir: 'E:\\fox-dock\\integrations\\zcode-plugin' },
  }
  fs.writeFileSync(path.join(DIR, name + '.json'), JSON.stringify(scene, null, 2) + '\n')
}

// ---------- sessions-live ----------
const parent = session({ agentId: 'zcode', sessionId: 'ses_parent', title: '重构 billing 适配器', cwd: 'D:\\WorkSpace\\fox-dock', model: 'deepseek-v4.1-flash', status: 'working', tokens: 1234567, cost: { amount: 1.23, currency: 'CNY', unit: 'money' }, turns: 12, calls: 38, errors: 1 })
const children = [
  session({ agentId: 'zcode', sessionId: 'ses_c1', parentKey: 'zcode:ses_parent', title: '子任务：补单元测试', cwd: 'D:\\WorkSpace\\fox-dock', model: 'deepseek-v4.1-flash', status: 'done', tokens: 220000, cost: { amount: 0.21, currency: 'CNY', unit: 'money' }, turns: 3, calls: 8, updatedAt: T - 120000, endedAt: T - 120000 }),
  session({ agentId: 'zcode', sessionId: 'ses_c2', parentKey: 'zcode:ses_parent', title: '子任务：核对导出格式', cwd: 'D:\\WorkSpace\\fox-dock', model: 'deepseek-v4.1-flash', status: 'error', tokens: 88000, cost: { amount: 0.08, currency: 'CNY', unit: 'money' }, turns: 2, calls: 4, errors: 1, lastError: { at: T - 20000, kind: 'tool', message: '工具调用失败：Bash' }, updatedAt: T - 20000, endedAt: T - 20000 }),
  session({ agentId: 'zcode', sessionId: 'ses_c3', parentKey: 'zcode:ses_parent', title: '子任务：更新文档', cwd: 'D:\\WorkSpace\\fox-dock', model: 'deepseek-v4.1-flash', status: 'done', tokens: 64000, cost: { amount: 0.06, currency: 'CNY', unit: 'money' }, turns: 1, calls: 2, updatedAt: T - 300000, endedAt: T - 300000 }),
]
const wait = session({ agentId: 'zcode', sessionId: 'ses_wait', title: '修复流式响应截断', cwd: 'D:\\WorkSpace\\fox-dock\\dock', model: 'glm-5.3', status: 'waiting_permission', tokens: 210000, cost: { amount: 0.43, currency: 'CNY', unit: 'money' }, turns: 4, calls: 12, updatedAt: T - 10000, pending: [{ id: 'req-0000000000001', kind: 'permission', agentId: 'zcode', sessionKey: 'zcode:ses_wait', tool: 'Bash', preview: 'rm -rf build/', risk: 'high', createdAt: T - 10000, expiresAt: T + 14000, state: 'pending' }] })
const wb = session({ agentId: 'workbuddy', sessionId: 'wb1', title: '整理发布说明', cwd: 'E:\\notes', model: 'wb-pro', status: 'waiting_input', tokens: 560000, cost: { amount: 50, currency: 'CREDIT', unit: 'credit' }, costProv: prov('exact', 'local-log', 'workbuddy:transcripts#rawUsage.credit'), turns: 5, calls: 9, updatedAt: T - 40000 })
const dsh = session({ agentId: 'dsh', sessionId: 'dsh1', title: '调试 dsh 会话日志', cwd: 'E:\\dsh\\proj', model: 'deepseek-v4', status: 'idle', tokens: 320000, cost: { amount: 0.31, currency: 'CNY', unit: 'money' }, turns: 3, calls: 6, updatedAt: T - 3600000 })
const kimi = session({ agentId: 'kimi', sessionId: 'kimi1', title: 'Kimi 套餐问答', cwd: '', model: 'kimi-k2', status: 'unknown', tokens: null, cost: null, turns: 0, calls: 0, updatedAt: T - 600000 })
write('sessions-live', {
  liveSessions: [parent, ...children, wait, wb, dsh, kimi],
  details: {
    'zcode:ses_parent': {
      turns: [
        { id: 't1', index: 1, startedAt: T - 3600000, endedAt: T - 3540000, durationMs: 60000, tokens: 300000, cost: { amount: 0.3, currency: 'CNY', unit: 'money' }, status: 'completed', model: 'deepseek-v4.1-flash' },
        { id: 't2', index: 2, startedAt: T - 1800000, endedAt: T - 1740000, durationMs: 60000, tokens: 520000, cost: { amount: 0.52, currency: 'CNY', unit: 'money' }, status: 'completed', model: 'deepseek-v4.1-flash' },
        { id: 't3', index: 3, startedAt: T - 120000, endedAt: T - 60000, durationMs: 60000, tokens: 414567, cost: { amount: 0.41, currency: 'CNY', unit: 'money' }, status: 'completed', model: 'deepseek-v4.1-flash' },
      ],
      tools: [
        { name: 'Bash', calls: 18, errors: 1, avgDurationMs: 1200, lastAt: T - 100000 },
        { name: 'Read', calls: 12, errors: 0, avgDurationMs: 80, lastAt: T - 90000 },
        { name: 'Edit', calls: 8, errors: 0, avgDurationMs: 140, lastAt: T - 80000 },
      ],
      models: [{ modelId: 'deepseek-v4.1-flash', provider: 'deepseek', tokens: 1234567, calls: 38, errors: 1 }],
    },
    'zcode:ses_wait': {
      turns: [{ id: 't1', index: 1, startedAt: T - 600000, endedAt: T - 480000, durationMs: 120000, tokens: 210000, cost: { amount: 0.43, currency: 'CNY', unit: 'money' }, status: 'completed', model: 'glm-5.3' }],
      tools: [{ name: 'Bash', calls: 6, errors: 0, avgDurationMs: 900, lastAt: T - 100000 }],
      models: [],
    },
  },
})

// ---------- empty / kimi-only / long ----------
write('sessions-empty', { liveSessions: [], contexts: { zcode: { supported: false, reason: 'no-session' } }, snapshots: {} })
const kimiOnlyAgents = [agents[2]]
write('sessions-kimi-only', {
  state: { pet: { ...pet, agentId: 'kimi', lastAgentId: 'kimi', profileOf: 'kimi', hwnd: '0x3' }, agents: kimiOnlyAgents },
  agents: kimiOnlyAgents,
  liveSessions: [],
  contexts: { kimi: { supported: false, reason: 'no-data' } },
  snapshots: {
    kimi: snapshot({
      unit: 'percent',
      today: null,
      turn: null,
      balance: null,
      quota: { usedPct: 20, remainingPct: 80 },
      quotaCard: { kind: 'windows', title: 'Kimi Code', plan: 'Kimi For Coding', windows: [{ key: '5h', label: '5 小时', usedPct: 20, remainingPct: 80, resetAt: T + 2 * 3600000, prov: prov('exact', 'api', 'kimi:/coding/v1/usages') }] },
      usage: { todayTokens: null, turnTokens: null },
      provenance: { today: prov('unavailable', 'api', 'kimi:/coding/v1/usages', { reason: 'host-unsupported' }), usage: prov('unavailable', 'api', 'kimi:/coding/v1/usages', { reason: 'host-unsupported' }) },
    }),
  },
})
const longTitle = '重构 billing 适配器并补齐成本真相层与跨宿主会话实时状态、导出与额度矩阵的完整实现说明（含中文、English、emoji 🚀🧪，以及极端长标题）'
const longCwd = 'D:\\WorkSpace\\fox-dock\\dock\\adapters\\zcode\\sessions\\with-a-very-long-directory-name\\and-another-deep-level\\project'
const longItems = [
  session({ agentId: 'zcode', sessionId: 'ses_long1', title: longTitle, cwd: longCwd, model: 'deepseek-v4.1-flash-with-a-very-long-model-name', status: 'working', tokens: 1234567890, cost: { amount: 1234.5678, currency: 'CNY', unit: 'money' }, turns: 999, calls: 1234, errors: 12, updatedAt: T - 1000 }),
  session({ agentId: 'zcode', sessionId: 'ses_long2', parentKey: 'zcode:ses_long1', title: '子任务：' + longTitle, cwd: longCwd, model: 'deepseek-v4.1-flash', status: 'error', tokens: 0, cost: null, turns: 0, calls: 0, errors: 1, updatedAt: T - 2000 }),
  session({ agentId: 'workbuddy', sessionId: 'wb_long', title: 'WorkBuddy 超长标题 ' + longTitle, cwd: 'E:\\notes\\very-long-path\\with\\many\\levels', model: 'wb-pro', status: 'done', tokens: null, cost: { amount: 99.99, currency: 'CREDIT', unit: 'credit' }, costProv: prov('exact', 'local-log', 'workbuddy:transcripts#rawUsage.credit'), turns: 99, calls: 99, updatedAt: T - 3000 }),
]
for (let i = 0; i < 120; i++) {
  longItems.push(session({ agentId: 'zcode', sessionId: 'ses_bulk_' + i, title: '批量会话 ' + i, status: i % 7 === 0 ? 'working' : 'idle', tokens: i % 5 === 0 ? null : i * 1000, cost: i % 5 === 0 ? null : { amount: i / 100, currency: 'CNY', unit: 'money' }, turns: i, calls: i, updatedAt: T - 10000 - i * 1000 }))
}
write('sessions-long-text', {
  liveSessions: longItems,
  details: {
    'zcode:ses_long1': {
      turns: [{ id: 't1', index: 1, startedAt: T - 100000, endedAt: T - 1000, durationMs: 99000, tokens: 1234567890, cost: { amount: 1234.5678, currency: 'CNY', unit: 'money' }, status: 'completed', model: 'deepseek-v4.1-flash' }],
      tools: [{ name: 'Bash', calls: 1234, errors: 12, avgDurationMs: 123456, lastAt: T - 1000 }],
      models: [],
    },
  },
})

// ---------- permission scenes ----------
const p1 = session({ agentId: 'zcode', sessionId: 'ses_perm1', title: '权限确认：普通工具', model: 'glm-5.3', status: 'waiting_permission', tokens: 1200, cost: { amount: 0.01, currency: 'CNY', unit: 'money' }, turns: 2, calls: 3, pending: [{ id: 'req_perm_000000000001', kind: 'permission', agentId: 'zcode', sessionKey: 'zcode:ses_perm1', tool: 'Read', preview: '读取 D:\\proj\\README.md', risk: 'normal', createdAt: T - 2000, expiresAt: T + 13000, state: 'pending' }] })
write('permission-pending', { liveSessions: [p1] })
const high = session({ agentId: 'zcode', sessionId: 'ses_high', title: '危险命令确认', model: 'glm-5.3', status: 'waiting_permission', tokens: 2200, cost: { amount: 0.02, currency: 'CNY', unit: 'money' }, turns: 2, calls: 4, pending: [{ id: 'req_high_0000000000001', kind: 'permission', agentId: 'zcode', sessionKey: 'zcode:ses_high', tool: 'Bash', preview: 'rm -rf build/\nrm -rf dist/\nsudo rm -rf /tmp/cache', risk: 'high', createdAt: T - 1000, expiresAt: T + 14000, state: 'pending' }] })
write('permission-high-risk', { liveSessions: [high] })
const q1 = session({ agentId: 'zcode', sessionId: 'ses_q1', title: '队列一', status: 'waiting_permission', tokens: 100, cost: { amount: 0.01, currency: 'CNY', unit: 'money' }, pending: [{ id: 'req_q_000000000000001', kind: 'permission', agentId: 'zcode', sessionKey: 'zcode:ses_q1', tool: 'Bash', preview: 'npm run build', risk: 'normal', createdAt: T - 3000, expiresAt: T + 12000, state: 'pending' }] })
const q2 = session({ agentId: 'zcode', sessionId: 'ses_q2', title: '队列二', status: 'waiting_permission', tokens: 200, cost: { amount: 0.02, currency: 'CNY', unit: 'money' }, pending: [{ id: 'req_q_000000000000002', kind: 'permission', agentId: 'zcode', sessionKey: 'zcode:ses_q2', tool: 'Edit', preview: 'src/app.mjs', risk: 'normal', createdAt: T - 2000, expiresAt: T + 13000, state: 'pending' }] })
const q3 = session({ agentId: 'workbuddy', sessionId: 'wb_q3', title: '队列三', status: 'waiting_permission', tokens: 300, cost: { amount: 1, currency: 'CREDIT', unit: 'credit' }, costProv: prov('exact', 'local-log', 'workbuddy:transcripts#rawUsage.credit'), pending: [{ id: 'req_q_000000000000003', kind: 'permission', agentId: 'workbuddy', sessionKey: 'workbuddy:wb_q3', tool: 'Write', preview: 'notes/release.md', risk: 'normal', createdAt: T - 1000, expiresAt: T + 14000, state: 'pending' }] })
write('permission-queue', { liveSessions: [q1, q2, q3] })
write('permission-observe-only', { liveSessions: [p1], settings: { permission: { takeover: false, waitMs: 15000, notify: 'whenHidden', hotkeys: { allow: 'Ctrl+Alt+Y', deny: 'Ctrl+Alt+N' } } } })

// ---------- usage scenes ----------
const dayList = [1.2, 2.1, 0, 3.4, 1.8, 2.6, 4.2].map((amount, i) => ({ d: stamp(i - 6), tokens: [120000, 210000, 0, 340000, 180000, 260000, 420000][i], amount, credits: null, calls: 10 + i, errors: i % 4 === 0 ? 1 : 0 }))
const breakdownBase = (series, total, prev) => ({
  ok: true,
  supported: true,
  by: 'agent',
  range: { from: dayList[0].d, to: dayList[6].d, days: 7 },
  unit: 'money',
  currency: 'CNY',
  series,
  other: null,
  total,
  truncated: false,
  prev,
  provenance: { tokens: { kind: 'exact', origin: 'local-db', source: 'fixture' }, amount: { kind: 'estimated', origin: 'pricing-table', source: 'fixture' } },
})
const totalOf = (series) => ({
  tokens: series.reduce((s, x) => s + x.tokens, 0),
  amount: Math.round(series.reduce((s, x) => s + x.amount, 0) * 10000) / 10000,
  credits: null,
  calls: series.reduce((s, x) => s + x.calls, 0),
  errors: series.reduce((s, x) => s + x.errors, 0),
  byCurrency: { CNY: Math.round(series.reduce((s, x) => s + x.amount, 0) * 10000) / 10000 },
})
const s1 = { key: 'zcode', label: 'ZCode', tokens: 2400000, amount: 12.34, credits: null, calls: 86, errors: 2, byDay: dayList, prov: prov('estimated', 'pricing-table', 'pricing:2026-10 zcode') }
const s2 = { key: 'dsh', label: 'DeepSeek Harness', tokens: 620000, amount: 3.21, credits: null, calls: 24, errors: 0, byDay: dayList.map((x) => ({ ...x, tokens: Math.round(x.tokens * 0.25), amount: Math.round(x.amount * 0.25 * 100) / 100 })), prov: prov('estimated', 'pricing-table', 'pricing:2026-10 deepseek') }
const usageDays = dayList.map((x) => ({ date: x.d, groups: [{ unit: 'money', currency: 'CNY', amount: x.amount, tokens: x.tokens, adapters: [{ id: 'zcode', name: 'ZCode', amount: x.amount, tokens: x.tokens }] }] }))
write('usage-compare', {
  breakdown: breakdownBase([s1, s2], totalOf([s1, s2]), {
    range: { from: stamp(-13), to: stamp(-7) },
    series: [{ ...s1, amount: 10.2, byDay: dayList.map((x) => ({ ...x, amount: Math.round(x.amount * 0.8 * 100) / 100 })) }, { ...s2, amount: 2.8 }],
    other: null,
    total: { tokens: 2500000, amount: 13, credits: null, calls: 100, errors: 1, byCurrency: { CNY: 13 } },
  }),
  usage: { today: { date: stamp(0), groups: [] }, days: usageDays },
})
write('usage-prev-zero', {
  breakdown: breakdownBase([s1], totalOf([s1]), { range: { from: stamp(-13), to: stamp(-7) }, series: [], other: null, total: { tokens: 0, amount: 0, credits: null, calls: 0, errors: 0, byCurrency: { CNY: 0 } } }),
  usage: { today: { date: stamp(0), groups: [] }, days: [] },
})
write('usage-forecast-empty', {
  breakdown: breakdownBase([s1], totalOf([s1]), null),
  usage: { today: { date: stamp(0), groups: [] }, days: [{ date: stamp(0), groups: [{ unit: 'money', currency: 'CNY', amount: 1.2, tokens: 120000, adapters: [{ id: 'zcode', name: 'ZCode', amount: 1.2, tokens: 120000 }] }] }] },
})
const usd = { key: 'zcode-usd', label: 'ZCode · USD', tokens: 900000, amount: 1.2, credits: null, calls: 20, errors: 0, currency: 'USD', byDay: dayList.map((x) => ({ ...x, amount: Math.round(x.amount * 0.1 * 100) / 100 })), prov: prov('estimated', 'pricing-table', 'pricing:2026-10 zcode USD') }
const creditS = { key: 'workbuddy', label: 'WorkBuddy', tokens: 500000, amount: 0, credits: 193.5, calls: 32, errors: 0, byDay: dayList.map((x) => ({ ...x, amount: 0, credits: 10 })), prov: prov('exact', 'local-log', 'workbuddy:transcripts#rawUsage.credit') }
write('usage-breakdown-multi-currency', {
  breakdown: breakdownBase([s1, usd, creditS], { tokens: 3800000, amount: 12.34, credits: 193.5, calls: 138, errors: 2, byCurrency: { CNY: 12.34, USD: 1.2 } }, null),
  usage: { today: { date: stamp(0), groups: [] }, days: [] },
})
const toolS = { key: 'Bash', label: 'Bash', tokens: 0, amount: 0, credits: null, calls: 120, errors: 3, byDay: dayList.map((x) => ({ ...x, amount: 0, tokens: 0, calls: x.calls })), prov: prov('exact', 'local-db', 'zcode:db.sqlite#tool_usage') }
write('usage-breakdown-tool', { breakdown: { ...breakdownBase([toolS], { tokens: 0, amount: 0, credits: null, calls: 120, errors: 3, byCurrency: { CNY: 0 } }, null), by: 'tool' }, usage: { today: { date: stamp(0), groups: [] }, days: [] } })


// 下钻维度场景：同一批数据换 key/label，验证 5 个维度的排版。
const modelA = { ...s1, key: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash' }
const modelB = { ...s2, key: 'glm-5.3', label: 'glm-5.3' }
write('usage-breakdown-model', { breakdown: { ...breakdownBase([modelA, modelB], totalOf([modelA, modelB]), null), by: 'model' }, usage: { today: { date: stamp(0), groups: [] }, days: usageDays } })
const vendorA = { ...s1, key: 'DeepSeek', label: 'DeepSeek' }
const vendorB = { ...s2, key: '智谱', label: '智谱' }
write('usage-breakdown-vendor', { breakdown: { ...breakdownBase([vendorA, vendorB], totalOf([vendorA, vendorB]), null), by: 'vendor' }, usage: { today: { date: stamp(0), groups: [] }, days: usageDays } })
const sessA = { ...s1, key: 'sess_alpha', label: '重构 billing 适配器' }
const sessB = { ...s2, key: 'sess_beta', label: '修复流式响应截断' }
write('usage-breakdown-session', { breakdown: { ...breakdownBase([sessA, sessB], totalOf([sessA, sessB]), null), by: 'session' }, usage: { today: { date: stamp(0), groups: [] }, days: usageDays } })

// ---------- quota matrix ----------
const w = (label, used, reset) => ({ key: label, label, usedPct: used, remainingPct: 100 - used, resetAt: reset, prov: prov('exact', 'api', 'vendor:fixture') })
write('quota-matrix', {
  vendors: [
    { id: 'zplan', name: 'GLM Plan', kind: 'local-log', available: true, configured: true, planName: 'GLM Plan', windows: [w('5 小时', 28, T + 3 * 3600000), w('本周', 42, T + 2 * DAY), w('月度池', 58, T + 12 * DAY)] },
    { id: 'deepseek', name: 'DeepSeek', kind: 'balance', available: true, configured: true, balance: 63.2, currency: 'CNY' },
    { id: 'commandcode', name: 'CommandCode', kind: 'cmdgo', available: true, configured: true, planName: 'GOAT', monthly: { remaining: 40.6, total: 70, percent: 0.42, resetAt: T + 9 * DAY }, fiveHour: { percent: 0.18, resetAt: T + 2 * 3600000 }, weekly: { percent: 0.3, resetAt: T + 3 * DAY } },
    { id: 'kimi', name: 'Kimi', kind: 'balance', available: true, configured: true, balance: 21.5, currency: 'CNY' },
    { id: 'relay', name: '中转站 Relay', kind: 'relay', available: true, configured: true, percentRemaining: 88, currency: 'USD' },
    { id: 'opencode', name: 'OpenCode Go', kind: 'local-log', available: true, configured: true, planName: 'Go', windows: [w('本月 Code', 7, T + 20 * DAY)] },
    { id: 'mini', name: 'MiniMax', kind: 'balance', available: false, configured: true, reason: '额度接口读取失败' },
    { id: 'unconf', name: '未配置厂商', kind: 'balance', available: false, configured: false, reason: '未配置 API Key' },
  ],
})

// ---------- provenance all kinds ----------
const kinds = [
  ['official', 'exact', 'api', 'vendor:deepseek', '官方接口：余额直读'],
  ['local', 'exact', 'local-db', 'zcode:db.sqlite#model_usage', '本地日志：ZCode 用量库'],
  ['estimate', 'estimated', 'pricing-table', 'pricing:2026-10 deepseek peak/a-very-long-vendor-label-for-overflow-test', '估算：token × 价目表，长来源文本用于溢出检查'],
  ['unavailable', 'unavailable', 'unknown', 'kimi:/sessions', '不可得：宿主不支持'],
]
write('provenance-all-kinds', {
  liveSessions: kinds.map((k, i) =>
    session({
      agentId: i === 2 ? 'dsh' : 'zcode',
      sessionId: 'ses_prov_' + i,
      title: '来源标签：' + k[0],
      status: 'idle',
      tokens: i === 3 ? null : 1000 * (i + 1),
      cost: i === 3 ? null : { amount: 0.1 * (i + 1), currency: 'CNY', unit: 'money' },
      costProv: prov(k[1], k[2], k[3], k[1] === 'unavailable' ? { reason: 'host-unsupported', note: k[4] } : { note: k[4] }),
    })
  ),
})

// ---------- overview busy / idle ----------
write('overview-busy', {
  liveSessions: [parent, wait, wb, dsh, kimi],
  usage: {
    today: { date: stamp(0), groups: [{ unit: 'money', currency: 'CNY', amount: 12.34, tokens: 2400000, adapters: [{ id: 'zcode', name: 'ZCode', amount: 12.34, tokens: 2400000 }] }, { unit: 'credit', currency: 'CREDIT', amount: 193.5, tokens: 890000, adapters: [{ id: 'workbuddy', name: 'WorkBuddy', amount: 193.5, tokens: 890000 }] }] },
    days: usageDays.map((d) => ({ ...d, groups: [...d.groups, { unit: 'credit', currency: 'CREDIT', amount: 20, tokens: 80000, adapters: [{ id: 'workbuddy', name: 'WorkBuddy', amount: 20, tokens: 80000 }] }] })),
  },
  vendors: [
    { id: 'deepseek', name: 'DeepSeek', kind: 'balance', available: true, configured: true, balance: 63.2, currency: 'CNY' },
    { id: 'zplan', name: 'GLM Plan', kind: 'local-log', available: true, configured: true, planName: 'GLM Plan', percentRemaining: 72 },
    { id: 'kimi', name: 'Kimi', kind: 'balance', available: true, configured: true, balance: 21.5, currency: 'CNY' },
  ],
})
write('overview-idle', {
  liveSessions: [],
  usage: { today: { date: stamp(0), groups: [] }, days: [{ date: stamp(0), groups: [] }] },
  contexts: { zcode: { supported: false, reason: 'no-session' } },
  snapshots: {
    zcode: snapshot({
      today: null,
      turn: null,
      balance: null,
      quota: null,
      quotaCard: null,
      usage: { todayTokens: null, turnTokens: null },
      provenance: {
        today: prov('unavailable', 'unknown', 'fixture', { reason: 'no-data' }),
        turn: prov('unavailable', 'unknown', 'fixture', { reason: 'no-data' }),
        balance: prov('unavailable', 'unknown', 'fixture', { reason: 'no-data' }),
        quota: prov('unavailable', 'unknown', 'fixture', { reason: 'no-data' }),
        usage: prov('unavailable', 'unknown', 'fixture', { reason: 'no-data' }),
      },
    }),
  },
})

// ---------- stats ----------
const sp = (kind, origin, source) => ({ kind, origin, source, asOf: T })
const stats = {
  supported: true,
  range: '7d',
  generatedAt: T,
  timeZone: 'Asia/Shanghai',
  source: 'zcode:db.sqlite',
  unit: 'tokens',
  currency: 'CNY',
  cost: { amount: 15.55, currency: 'CNY' },
  credits: null,
  provenance: { tokens: sp('exact', 'local-db', 'zcode:db.sqlite#model_usage'), cost: sp('estimated', 'pricing-table', 'pricing:2026-10'), credits: sp('unavailable', 'unknown', 'fixture'), models: sp('exact', 'local-db', 'zcode:db.sqlite'), tools: sp('exact', 'local-db', 'zcode:db.sqlite#tool_usage'), turns: sp('exact', 'local-db', 'zcode:db.sqlite#turn_usage') },
  summary: { totalTokens: 3020000, inputTokens: 2500000, outputTokens: 520000, reasoningTokens: 12000, cacheCreationTokens: 0, cacheReadTokens: 2100000, cacheHitRate: 0.84, totalSessions: 6, totalTurns: 32, toolCallCount: 120, toolErrorRate: 0.02, modelErrorRate: 0.01, avgTimeToFirstTokenMs: 820, avgTurnDurationMs: 42000, activeDays: 6, currentStreakDays: 4, longestSessionMs: 3600000, longestStreakDays: 5, peakDayTokens: 620000, peakDayDate: stamp(0), favoriteModel: { modelId: 'deepseek-v4.1-flash', totalTokens: 1800000, share: 0.6 }, totalCredits: null },
  heatmap: { startDate: stamp(-6), endDate: stamp(0), maxTokens: 620000, weeks: [{ weekIndex: 0, days: dayList.map((x, i) => ({ date: x.d, level: i % 5, totalTokens: x.tokens, turnCount: i + 1, toolCallCount: i * 2 })) }] },
  dailyModelUsage: dayList.map((x) => ({ date: x.d, models: [{ modelId: 'deepseek-v4.1-flash', totalTokens: x.tokens }] })),
  models: [{ modelId: 'deepseek-v4.1-flash', totalTokens: 1800000, inputTokens: 1500000, outputTokens: 300000, requestCount: 50, share: 0.6 }, { modelId: 'glm-5.3', totalTokens: 1220000, inputTokens: 1000000, outputTokens: 220000, requestCount: 30, share: 0.4 }],
  tools: [{ toolName: 'Bash', callCount: 80, errorCount: 2, errorRate: 0.025, avgDurationMs: 1200 }, { toolName: 'Read', callCount: 40, errorCount: 0, errorRate: 0, avgDurationMs: 80 }],
}
write('stats-sourcetags', { stats: { zcode: stats } })
write('stats-kimi-empty', {
  state: { pet: { ...pet, agentId: 'kimi', lastAgentId: 'kimi', profileOf: 'kimi', hwnd: '0x3' }, agents: kimiOnlyAgents },
  agents: kimiOnlyAgents,
  stats: { kimi: { supported: false, range: '7d', reason: 'no-local-history', note: 'Kimi Code 只提供套餐额度窗口，没有本地逐日用量历史；额度与重置时间请看「额度与余额」。' } },
  snapshots: { kimi: snapshot({ unit: 'percent', today: null, turn: null, balance: null, quota: { usedPct: 20, remainingPct: 80 }, quotaCard: { kind: 'windows', title: 'Kimi Code', plan: 'Kimi For Coding', windows: [w('5 小时', 20, T + 3600000)] }, usage: { todayTokens: null, turnTokens: null }, provenance: { today: prov('unavailable', 'api', 'kimi:/coding/v1/usages', { reason: 'host-unsupported' }), usage: prov('unavailable', 'api', 'kimi:/coding/v1/usages', { reason: 'host-unsupported' }) } }) },
})

// ---------- settings ----------
write('settings-live-perm', {
  settings: {
    permission: { takeover: true, waitMs: 30000, notify: 'always', hotkeys: { allow: 'Ctrl+Alt+Y', deny: 'Ctrl+Alt+N' } },
    live: { enabled: true },
    ingest: { enabled: true },
    retentionDays: 90,
  },
})

// ---------- sessions-many ----------
const states = ['working', 'waiting_permission', 'waiting_input', 'error', 'done', 'idle', 'unknown']
const many = []
for (let i = 0; i < 2000; i++) {
  const agentId = ['zcode', 'workbuddy', 'dsh', 'kimi'][i % 4]
  const status = states[i % states.length]
  many.push(
    session({
      agentId,
      sessionId: 'ses_many_' + i,
      parentKey: i % 10 === 0 && i > 0 ? 'zcode:ses_many_' + (i - 1) : null,
      title: '会话 ' + i + ' · 批量场景',
      cwd: 'D:\\bench\\p' + (i % 20),
      model: 'model-' + (i % 6),
      status,
      tokens: i % 11 === 0 ? null : 1000 * (i % 500),
      cost: i % 11 === 0 ? null : { amount: (i % 900) / 100, currency: 'CNY', unit: 'money' },
      turns: i % 40,
      calls: i % 60,
      errors: i % 17 === 0 ? 1 : 0,
      updatedAt: T - i * 1000,
      startedAt: T - 3600000 - i * 1000,
    })
  )
}
write('sessions-many', { liveSessions: many })

console.log('scenes written to', DIR)
