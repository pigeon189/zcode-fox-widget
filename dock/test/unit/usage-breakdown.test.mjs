// M4 下钻聚合：5 种 by / 多币种 / other / prev / 缓存 / 范围校验
import assert from 'node:assert/strict'
import test from 'node:test'
import { createUsageBreakdown } from '../../daemon/src/usage-breakdown.mjs'

const NOW = new Date(2026, 9, 21, 12).getTime()

function adapter(id, rows, toolRows = []) {
  return {
    id,
    name: id,
    capabilities: { billing: true },
    async readUsageRows(opts = {}) {
      // 模拟真实 WorkBuddy/DSh：适配器内部按本地分钟过滤 timeMinutes。
      if (opts.timeMinutes == null) return { ok: true, rows }
      const hit = rows.filter((r) => {
        const d = new Date(Number(r.at) || 0)
        return d.getHours() * 60 + d.getMinutes() === opts.timeMinutes
      })
      return { ok: true, rows: hit }
    },
    async readToolUsageRows() {
      return { ok: true, rows: toolRows }
    },
  }
}

function row(over = {}) {
  return {
    agentId: 'zcode',
    sessionId: 's1',
    model: 'deepseek-flash',
    vendor: 'deepseek',
    vendorLabel: 'DeepSeek',
    tool: '',
    at: NOW - 3600_000,
    day: '2026-10-21',
    unit: 'money',
    currency: 'CNY',
    amount: 1,
    credits: null,
    tokens: 100,
    calls: 1,
    errors: 0,
    prov: { kind: 'estimated', origin: 'pricing-table', source: 'pricing', asOf: NOW },
    ...over,
  }
}

test('usage-breakdown: 5 种维度', async () => {
  const rows = [
    row({ sessionId: 's1', model: 'a', vendorLabel: 'V1', amount: 1, tokens: 100 }),
    row({ sessionId: 's2', model: 'b', vendorLabel: 'V2', amount: 2, tokens: 200 }),
  ]
  const tools = [
    { agentId: 'zcode', sessionId: 's1', tool: 'Bash', at: NOW, day: '2026-10-21', unit: 'money', currency: 'CNY', amount: 0, tokens: 0, calls: 3, errors: 1, prov: rows[0].prov },
  ]
  const b = createUsageBreakdown({ adapters: [adapter('zcode', rows, tools)], now: () => NOW })
  const byAgent = await b.get({ by: 'agent', range: '7d' })
  assert.equal(byAgent.ok, true)
  assert.equal(byAgent.series.length, 1)
  assert.equal(byAgent.series[0].calls, 5)
  assert.equal(byAgent.series[0].errors, 1)
  const byModel = await b.get({ by: 'model', range: '7d' })
  assert.deepEqual(byModel.series.map((s) => s.key).sort(), ['a', 'b'])
  const byVendor = await b.get({ by: 'vendor', range: '7d' })
  assert.deepEqual(byVendor.series.map((s) => s.key).sort(), ['V1', 'V2'])
  const bySession = await b.get({ by: 'session', range: '7d' })
  assert.deepEqual(bySession.series.map((s) => s.key).sort(), ['s1', 's2'])
  const byTool = await b.get({ by: 'tool', range: '7d' })
  assert.equal(byTool.series[0].key, 'Bash')
  assert.equal(byTool.series[0].calls, 3)
})

test('usage-breakdown: time 只过滤逐条明细，不改图表/合计', async () => {
  const rows = [
    row({ sessionId: 's1', model: 'a', at: new Date(2026, 9, 21, 10, 30).getTime(), amount: 2, tokens: 20 }),
    row({ sessionId: 's2', model: 'b', at: new Date(2026, 9, 21, 10, 31).getTime(), amount: 3, tokens: 30 }),
    row({ sessionId: 's3', model: 'c', at: new Date(2026, 9, 21, 11, 0).getTime(), amount: 5, tokens: 50 }),
  ]
  const b = createUsageBreakdown({ adapters: [adapter('zcode', rows)], now: () => NOW })
  const base = await b.get({ by: 'model', range: '7d' })
  assert.equal(base.detail, undefined, '没有 time 参数时不返回逐条明细')
  assert.equal(base.total.amount, 10)
  assert.equal(base.daily.length, 1, '按日汇总给总览图使用')
  assert.equal(base.daily[0].d, '2026-10-21')
  assert.equal(base.daily[0].amount, 10)
  assert.equal(base.daily[0].tokens, 100)

  const hit = await b.get({ by: 'model', range: '7d', time: '10:30' })
  assert.equal(hit.timeSupported, true)
  assert.deepEqual(hit.detail.map((x) => x.key), ['a'], '只返回该分钟的逐条记录')
  assert.equal(hit.detail[0].amount, 2)
  assert.equal(hit.total.amount, 10, '图表/合计仍按完整数据')
  assert.equal(hit.series.length, 3, '排名数据不被时间截断')
  assert.equal(hit.daily[0].amount, 10, '时间搜索不改按日汇总')

  const miss = await b.get({ by: 'model', range: '7d', time: '23:59' })
  assert.deepEqual(miss.detail, [])
  assert.equal(miss.total.amount, 10)
})

test('usage-breakdown: 无 aggregateUsage 的积分源，时间搜索不改图表/合计/单位', async () => {
  const rows = [
    row({ agentId: 'workbuddy', unit: 'credit', currency: 'CREDIT', amount: 0, credits: 5, at: new Date(2026, 9, 21, 10, 30).getTime() }),
    row({ agentId: 'workbuddy', unit: 'credit', currency: 'CREDIT', amount: 0, credits: 2, at: new Date(2026, 9, 21, 10, 31).getTime() }),
    row({ agentId: 'workbuddy', unit: 'credit', currency: 'CREDIT', amount: 0, credits: 3, at: new Date(2026, 9, 21, 11, 0).getTime() }),
  ]
  const b = createUsageBreakdown({ adapters: [adapter('workbuddy', rows)], now: () => NOW })
  const hit = await b.get({ by: 'agent', range: '7d', time: '10:30' })
  assert.equal(hit.unit, 'credit')
  assert.equal(hit.total.credits, 10, '积分合计仍按完整数据')
  assert.equal(hit.series.length, 1)
  assert.equal(hit.series[0].credits, 10, '排名/图表不被时间截断')
  assert.equal(hit.detail.length, 1)
  assert.equal(hit.detail[0].credits, 5)

  const miss = await b.get({ by: 'agent', range: '7d', time: '23:59' })
  assert.equal(miss.unit, 'credit', '空命中不能把积分单位翻成金额')
  assert.equal(miss.total.credits, 10)
  assert.equal(miss.series.length, 1)
  assert.deepEqual(miss.detail, [])
})

test('usage-breakdown: 多币种不跨币种相加，主币种单列', async () => {
  const rows = [row({ amount: 10, currency: 'CNY' }), row({ amount: 2, currency: 'USD', sessionId: 's2' })]
  const b = createUsageBreakdown({ adapters: [adapter('zcode', rows)], now: () => NOW })
  const r = await b.get({ by: 'agent', range: '7d' })
  assert.equal(r.total.byCurrency.CNY, 10)
  assert.equal(r.total.byCurrency.USD, 2)
  assert.equal(r.total.amount, 10, '默认只汇总主币种')
  assert.equal(r.currency, 'CNY')
  // 逐日汇总同样只按输出币种：CNY 10 + USD 2 不能报成 12
  assert.equal(r.daily[0].amount, 10, 'daily.amount 不跨币种相加')
  assert.equal(r.daily[0].byCurrency.CNY, 10)
  assert.equal(r.daily[0].byCurrency.USD, 2)
  const usd = await b.get({ by: 'agent', range: '7d', currency: 'USD' })
  assert.equal(usd.total.amount, 2)
  assert.equal(usd.daily[0].amount, 2, '指定 USD 时 daily.amount 取 USD 口径')
})

test('usage-breakdown: 积分与金额不混在同一 series', async () => {
  const creditRows = [row({ agentId: 'workbuddy', unit: 'credit', currency: 'CREDIT', amount: 0, credits: 50, tokens: 10 })]
  const b = createUsageBreakdown({ adapters: [adapter('workbuddy', creditRows)], now: () => NOW })
  const r = await b.get({ by: 'agent', range: '7d' })
  assert.equal(r.unit, 'credit')
  assert.equal(r.series[0].credits, 50)
  assert.equal(r.series[0].amount, 0)
})

test('usage-breakdown: 超过 8 类合并到 other', async () => {
  const rows = []
  for (let i = 0; i < 12; i++) rows.push(row({ model: 'm' + i, amount: 12 - i, tokens: 100 - i }))
  const b = createUsageBreakdown({ adapters: [adapter('zcode', rows)], now: () => NOW })
  const r = await b.get({ by: 'model', range: '7d' })
  assert.equal(r.series.length, 8)
  assert.ok(r.other)
  assert.equal(r.other.key, '__other')
  assert.equal(r.series.length + 4, 12)
})

test('usage-breakdown: other 行按币种分桶，amount 不跨币种直加', async () => {
  // 前 8 名按金额进 series；第 9、10 名是 USD 记录，落进 other。
  // other.amount 只能取输出币种（CNY 主币种 → 0），USD 总量在 byCurrency 里。
  const rows = []
  for (let i = 0; i < 8; i++) rows.push(row({ model: 'm' + i, amount: 20 - i, currency: 'CNY' }))
  rows.push(row({ model: 'usd-a', amount: 5, currency: 'USD' }))
  rows.push(row({ model: 'usd-b', amount: 3, currency: 'USD' }))
  const b = createUsageBreakdown({ adapters: [adapter('zcode', rows)], now: () => NOW })
  const r = await b.get({ by: 'model', range: '7d' })
  assert.ok(r.other)
  assert.deepEqual(r.other.byCurrency, { USD: 8 }, 'other 行按币种分桶，只含落选系列的真实币种')
  assert.equal(r.other.amount, 0, '主币种 CNY 下 other.amount 不能把 USD 直加进来')
  assert.equal(r.other.currency, 'CNY')
  const usd = await b.get({ by: 'model', range: '7d', currency: 'USD' })
  assert.deepEqual(
    usd.series.slice(0, 2).map((s) => s.key).sort(),
    ['usd-a', 'usd-b'],
    '指定 USD 时排名按 USD 金额，USD 系列进榜、CNY 系列落选'
  )
  assert.equal(usd.other.amount, 0, 'other 里没有 USD 记录，USD 口径为 0 而不是 CNY 直加值')
  // CNY 系列的 USD 金额全是 0，按 token tie-break：tokens 最小的两名（14、13）落选
  assert.equal(usd.other.byCurrency.CNY, 27, '落选 CNY 系列的真实金额在 other 分桶里')
  assert.equal(usd.other.currency, 'USD')
})

test('usage-breakdown: series 内多币种时 byDay.amount 归一到主币种', async () => {
  // 同一 agent 同一天既有 CNY 又有 USD：byDay[].amount 只能是 CNY 口径，
  // 完整分桶在 byDay[].byCurrency；daily[].byCurrency 也按真实币种累计。
  const rows = [
    row({ amount: 4, currency: 'CNY', at: NOW - 7200_000 }),
    row({ amount: 2, currency: 'USD', at: NOW - 3600_000 }),
  ]
  const b = createUsageBreakdown({ adapters: [adapter('zcode', rows)], now: () => NOW })
  const r = await b.get({ by: 'agent', range: '7d' })
  assert.equal(r.series[0].currency, 'CNY')
  assert.equal(r.series[0].amount, 4)
  assert.equal(r.series[0].byDay[0].amount, 4, 'byDay.amount 不混加 USD')
  assert.equal(r.series[0].byDay[0].byCurrency.USD, 2)
  const day = r.daily.find((x) => x.d === '2026-10-21')
  assert.equal(day.byCurrency.CNY, 4)
  assert.equal(day.byCurrency.USD, 2)
})

test('usage-breakdown: 自定义范围校验（from>to / 跨度 >366 / 非法）', async () => {
  const b = createUsageBreakdown({ adapters: [adapter('zcode', [])], now: () => NOW })
  const bad1 = await b.get({ by: 'agent', range: 'custom', from: '2026-10-20', to: '2026-10-01' })
  assert.equal(bad1.ok, false)
  assert.equal(bad1.status, 400)
  const bad2 = await b.get({ by: 'agent', range: 'custom', from: '2024-01-01', to: '2026-01-02' })
  assert.equal(bad2.ok, false)
  assert.equal(bad2.error, 'range-too-long')
  const bad3 = await b.get({ by: 'agent', range: 'custom', from: 'x', to: '2026-10-01' })
  assert.equal(bad3.ok, false)
})

test('usage-breakdown: prev 环比与缓存', async () => {
  const rows = [row({ amount: 2 })]
  const b = createUsageBreakdown({ adapters: [adapter('zcode', rows)], now: () => NOW })
  const r = await b.get({ by: 'agent', range: '7d', compare: true })
  assert.ok(r.prev)
  assert.equal(r.prev.range.from, '2026-10-08')
  const again = await b.get({ by: 'agent', range: '7d', compare: true })
  assert.equal(again.cached, true)
})

test('usage-breakdown: 无适配器支持时 supported:false，不伪造 0', async () => {
  const kimi = { id: 'kimi', name: 'Kimi', capabilities: { billing: true }, async readUsageRows() { return { ok: false, reason: 'host-unsupported', rows: [] } } }
  const b = createUsageBreakdown({ adapters: [kimi], now: () => NOW })
  const r = await b.get({ by: 'agent', range: '7d' })
  assert.equal(r.supported, false)
  assert.equal(r.series.length, 0)
})

test('usage-breakdown: 上游 amount=null（价目未收录）不被补成 0，明细行保持 null', async () => {
  const a = {
    id: 'zcode',
    name: 'ZCode',
    capabilities: { billing: true },
    async aggregateUsage() {
      return {
        ok: true,
        unit: 'money',
        series: [
          {
            key: 'gpt-5',
            label: 'gpt-5',
            tokens: 100,
            amount: null,
            currency: '',
            byCurrency: {},
            byDay: [{ d: '2026-10-21', tokens: 100, amount: null, credits: null, calls: 2 }],
            prov: { kind: 'unavailable', origin: 'pricing-table', source: 'pricing:test', asOf: NOW, reason: 'no-data', note: '未收录' },
          },
        ],
      }
    },
    async readUsageRows() {
      return {
        ok: true,
        rows: [
          {
            agentId: 'zcode',
            sessionId: 's1',
            model: 'gpt-5',
            vendor: 'openai',
            vendorLabel: 'OpenAI',
            tool: '',
            at: NOW,
            day: '2026-10-21',
            unit: 'money',
            currency: 'USD',
            amount: null,
            credits: null,
            tokens: 100,
            calls: 1,
            errors: 0,
            prov: { kind: 'unavailable', origin: 'pricing-table', source: 'pricing:test', asOf: NOW, reason: 'no-data', note: '未收录' },
          },
        ],
      }
    },
  }
  const b = createUsageBreakdown({ adapters: [a], now: () => NOW })
  const r = await b.get({ by: 'model', range: '7d' })
  assert.equal(r.series[0].amount, null, '金额不可得不是 0')
  assert.deepEqual(r.series[0].byCurrency, {})
  assert.equal(r.series[0].byDay[0].amount, null, '逐日金额同样不可得（不是 0）')
  assert.equal(r.total.amount, null, '没有可计价金额时合计为 null')
  assert.equal(r.series[0].prov.kind, 'unavailable')
  // 逐日汇总：不把空 byCurrency 归到默认 CNY（否则总览/用量页显示 ¥0.00）
  assert.equal(r.daily.length, 1)
  assert.equal(r.daily[0].amount, null, 'daily.amount 不可得')
  assert.deepEqual(r.daily[0].byCurrency, {}, 'daily 不建 CNY:0 桶')

  const d = await b.get({ by: 'model', range: '7d', time: '12:00' })
  assert.equal(d.detail.length, 1)
  assert.equal(d.detail[0].amount, null, '明细行金额保持 null，不补 0')
  assert.equal(d.detail[0].prov.kind, 'unavailable')
})

test('usage-breakdown: readUsageRows 的 amount=null 不被折叠成 0（dsh 未收录模型）', async () => {
  const unavailableProv = { kind: 'unavailable', origin: 'pricing-table', source: 'pricing:test', asOf: NOW, reason: 'no-data' }
  // 全不可得：series / byDay / daily / total 全 null，不建 CNY:0 桶
  const onlyUnpriced = await createUsageBreakdown({
    adapters: [adapter('dsh', [row({ agentId: 'dsh', model: 'unknown-gateway-model', amount: null, currency: '', prov: unavailableProv })])],
    now: () => NOW,
  }).get({ by: 'model', range: '7d' })
  assert.equal(onlyUnpriced.series[0].amount, null)
  assert.deepEqual(onlyUnpriced.series[0].byCurrency, {})
  assert.equal(onlyUnpriced.series[0].byDay[0].amount, null)
  assert.equal(onlyUnpriced.total.amount, null)
  assert.equal(onlyUnpriced.daily[0].amount, null)
  assert.deepEqual(onlyUnpriced.daily[0].byCurrency, {})
  assert.equal(onlyUnpriced.daily[0].tokens, 100, 'tokens 照算')

  // 混合：可计价部分照常，未收录行不把金额抬成 0 元合计
  const mixed = await createUsageBreakdown({
    adapters: [
      adapter('dsh', [
        row({ agentId: 'dsh', model: 'deepseek-chat', amount: 3, currency: 'CNY' }),
        row({ agentId: 'dsh', model: 'unknown-gateway-model', amount: null, currency: '', prov: unavailableProv }),
      ]),
    ],
    now: () => NOW,
  }).get({ by: 'agent', range: '7d' })
  assert.equal(mixed.series[0].amount, 3)
  assert.equal(mixed.daily[0].amount, 3)
  assert.deepEqual(mixed.daily[0].byCurrency, { CNY: 3 })
  assert.equal(mixed.total.amount, 3)
})
