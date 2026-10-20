// 适配器契约与注册表（R4）
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  basenameOf,
  normalizeQuotaCard,
  normalizeSnapshot,
  normalizeWindow,
  scoreMatch,
  validateAdapter,
} from '../../adapters/contracts.mjs'
import { builtinAdapters, describeAdapters, resolveAdapter } from '../../adapters/registry.mjs'
import { genericAdapter } from '../../adapters/generic.mjs'

const fake = (over = {}) => ({
  id: 'fake',
  name: 'Fake',
  priority: 0,
  match: { exeBasenames: ['fake.exe'] },
  capabilities: { billing: false, follow: true },
  ...over,
})

test('contracts: basename 与路径规范化（反斜杠 / 大小写 / 空值）', () => {
  assert.equal(basenameOf('C:\\Program Files\\ZCode\\ZCode.exe'), 'zcode.exe')
  assert.equal(basenameOf('c:/x/y/APP.EXE'), 'app.exe')
  assert.equal(basenameOf(''), '')
  assert.equal(basenameOf(null), '')
})

test('contracts: 没有任何维度的 match 永不命中（防止变成吞噬一切的兜底）', () => {
  assert.equal(scoreMatch({}, { exe: 'C:\\a\\b.exe' }), -1)
  assert.equal(scoreMatch(null, { exe: 'C:\\a\\b.exe' }), -1)
})

test('contracts: exeBasenames 命中不看路径与大小写', () => {
  const spec = { exeBasenames: ['Fake.EXE'] }
  assert.ok(scoreMatch(spec, { exe: 'C:\\Program Files\\Fake\\fake.exe' }) > 0)
  assert.equal(scoreMatch(spec, { exe: 'C:\\Program Files\\Other\\fake2.exe' }), -1)
})

test('contracts: 多维度是 AND（exe 对了但标题不对 → 不命中）', () => {
  const spec = { exeBasenames: ['electron.exe'], titleIncludes: ['zcode'] }
  assert.ok(scoreMatch(spec, { exe: 'C:\\x\\electron.exe', title: 'ZCode 狐娘小挂件' }) > 0)
  assert.equal(scoreMatch(spec, { exe: 'C:\\x\\electron.exe', title: 'WorkBuddy' }), -1)
})

test('contracts: titlePatterns / classes 可用', () => {
  assert.ok(scoreMatch({ titlePatterns: [/^ZCode\b/] }, { title: 'ZCode — 项目' }) > 0)
  assert.equal(scoreMatch({ titlePatterns: [/^ZCode\b/] }, { title: 'My ZCode' }), -1)
  assert.ok(scoreMatch({ classes: ['Chrome_WidgetWin_1'] }, { cls: 'Chrome_WidgetWin_1' }) > 0)
  assert.equal(scoreMatch({ classes: ['Chrome_WidgetWin_1'] }, { cls: 'Notepad' }), -1)
})

test('contracts: normalizeWindow 提供派生字段且不抛异常', () => {
  const w = normalizeWindow({ exe: 'C:\\A\\B.EXE', title: 'Hello', pid: '42' })
  assert.equal(w.exeBase, 'b.exe')
  assert.equal(w.exeLower, 'c:/a/b.exe')
  assert.equal(w.titleLower, 'hello')
  assert.equal(w.pid, 42)
  assert.deepEqual(normalizeWindow(null), {
    exe: '',
    exeBase: '',
    exeLower: '',
    title: '',
    titleLower: '',
    cls: '',
    pid: 0,
    hwnd: '',
  })
})

test('contracts: validateAdapter 能指出具体问题', () => {
  assert.deepEqual(validateAdapter(fake()), [])
  assert.ok(validateAdapter(fake({ id: 'Bad Id' }))[0].includes('id'))
  assert.ok(validateAdapter(fake({ name: '' })).some((e) => e.includes('name')))
  assert.ok(validateAdapter(fake({ match: {} })).some((e) => e.includes('match')))
  assert.ok(validateAdapter(fake({ match: { nope: [] } })).some((e) => e.includes('unknown match dimension')))
  assert.ok(validateAdapter(fake({ capabilities: {} })).some((e) => e.includes('capabilities.billing')))
  assert.ok(
    validateAdapter(fake({ capabilities: { billing: true } })).some((e) => e.includes('createBilling'))
  )
})

test('contracts: normalizeSnapshot 不支持时清空所有数值', () => {
  const s = normalizeSnapshot({ supported: false }, { adapterId: 'generic', adapterName: '通用', now: 123 })
  assert.equal(s.ok, true)
  assert.equal(s.supported, false)
  assert.equal(s.unit, null)
  assert.equal(s.today, null)
  assert.equal(s.capturedAt, 123)
  assert.equal(s.error, null)
})

test('contracts: normalizeSnapshot 拒绝非法单位（防止元与积分混算）', () => {
  const s = normalizeSnapshot({ supported: true, unit: 'dollars' }, { adapterId: 'x' })
  assert.equal(s.ok, false)
  assert.match(s.error, /unit/)
})

test('contracts: normalizeSnapshot 金额取 4 位、百分比夹紧、NaN 归 null', () => {
  const s = normalizeSnapshot(
    {
      supported: true,
      unit: 'money',
      today: { amount: 1.23456789, currency: 'CNY' },
      quota: { usedPct: 130, remainingPct: -5 },
      turn: { amount: NaN },
    },
    { adapterId: 'x', adapterName: 'X' }
  )
  assert.equal(s.today.amount, 1.2346)
  assert.equal(s.today.currency, 'CNY')
  assert.equal(s.turn, null)
  assert.deepEqual(s.quota, { usedPct: 100, remainingPct: 0 })
})

test('contracts: 回合时间戳透传（浮层用它判断是否新回合）', () => {
  const s = normalizeSnapshot(
    { supported: true, unit: 'money', turn: { amount: 1.23, currency: 'CNY', at: 1792463882196 } },
    { adapterId: 'zcode', adapterName: 'ZCode' }
  )
  assert.equal(s.turn.at, 1792463882196)
})

test('contracts: normalizeSnapshot 透传 error 并标记 ok=false', () => {
  const s = normalizeSnapshot({ supported: true, unit: 'money', error: 'db locked' }, { adapterId: 'x' })
  assert.equal(s.ok, false)
  assert.equal(s.error, 'db locked')
})

test('registry: 无匹配时回落到 generic，并标记 fallback', () => {
  const r = resolveAdapter({ exe: 'C:\\Windows\\notepad.exe', title: '无标题' }, [genericAdapter, fake()])
  assert.equal(r.id, 'generic')
  assert.equal(r.fallback, true)
  assert.equal(r.capabilities.billing, false)
})

test('registry: 命中专用适配器，得分更高者优先', () => {
  const loose = fake({ id: 'loose', name: 'Loose', match: { exeBasenames: ['electron.exe'] } })
  const tight = fake({
    id: 'tight',
    name: 'Tight',
    match: { exeBasenames: ['electron.exe'], titleIncludes: ['zcode'] },
  })
  const r = resolveAdapter({ exe: 'C:\\x\\electron.exe', title: 'ZCode' }, [genericAdapter, loose, tight])
  assert.equal(r.id, 'tight')
  assert.equal(r.fallback, false)
  assert.ok(r.score > 0)
})

test('registry: 同分看 priority，再同按 id 稳定排序', () => {
  const a = fake({ id: 'bbb', name: 'B', priority: 1 })
  const b = fake({ id: 'aaa', name: 'A', priority: 5 })
  assert.equal(resolveAdapter({ exe: 'C:\\x\\fake.exe' }, [genericAdapter, a, b]).id, 'aaa')
  const c = fake({ id: 'ccc', name: 'C', priority: 1 })
  assert.equal(resolveAdapter({ exe: 'C:\\x\\fake.exe' }, [genericAdapter, a, c]).id, 'bbb')
})

test('registry: 标了 fallback 的适配器不参与匹配', () => {
  const tricky = fake({ id: 'tricky', name: 'Tricky', fallback: true, match: { exeBasenames: ['fake.exe'] } })
  assert.equal(resolveAdapter({ exe: 'C:\\x\\fake.exe' }, [tricky, genericAdapter]).id, 'generic')
})

test('registry: describeAdapters 不泄漏函数（可直接 JSON 序列化）', () => {
  const list = describeAdapters([genericAdapter])
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'generic')
  assert.equal(list[0].billing, false)
  assert.doesNotThrow(() => JSON.stringify(list))
})

test('registry: 内置适配器覆盖四个宿主，并带默认角色/强调色', () => {
  const ids = builtinAdapters.map((a) => a.id)
  for (const id of ['zcode', 'workbuddy', 'kimi', 'dsh']) assert.ok(ids.includes(id), id)
  const described = describeAdapters(builtinAdapters)
  const kimi = described.find((a) => a.id === 'kimi')
  const dsh = described.find((a) => a.id === 'dsh')
  assert.equal(kimi.roleDefault, 'kimi')
  assert.equal(dsh.roleDefault, 'whale')
  assert.ok(kimi.accent && dsh.accent)
})

test('contracts: quotaCard 窗口从 used 推 remaining，越界夹紧', () => {
  const card = normalizeQuotaCard(
    {
      kind: 'windows',
      title: 'Kimi Code',
      plan: 'Pro',
      windows: [
        { key: 'limit_5h', label: '5 小时', usedPct: 42 },
        { key: 'limit_7d', label: '7 天', usedPct: 130, resetAt: '2026-10-19T05:00:00Z' },
        { label: '' },
      ],
    },
    { adapterName: 'Kimi Code' }
  )
  assert.equal(card.kind, 'windows')
  assert.equal(card.windows.length, 2)
  assert.equal(card.windows[0].remainingPct, 58)
  assert.equal(card.windows[1].usedPct, 100)
  assert.equal(card.windows[1].remainingPct, 0)
  assert.equal(card.windows[1].resetAt, '2026-10-19T05:00:00Z')
})

test('contracts: 空窗口的 windows 卡降级为 plan / 明确说明', () => {
  const plan = normalizeQuotaCard({ kind: 'windows', plan: 'Free', windows: [] })
  assert.equal(plan.kind, 'plan')
  const empty = normalizeQuotaCard({ kind: 'windows', windows: [] })
  assert.equal(empty.kind, 'windows')
  assert.match(empty.message, /没有返回/)
})

test('contracts: quotaCard 余额与 details 都要净化和限长', () => {
  const card = normalizeQuotaCard({
    kind: 'balance',
    title: 'x'.repeat(100),
    balance: { amount: 12.34567, currency: 'CNY', byCurrency: { CNY: 12.34567, bad: 'x' } },
    note: 'n'.repeat(500),
  })
  assert.equal(card.title.length, 48)
  assert.equal(card.note.length, 160)
  assert.equal(card.balance.amount, 12.3457)
  assert.deepEqual(card.balance.byCurrency, { CNY: 12.3457 })

  const snap = normalizeSnapshot(
    {
      supported: true,
      unit: 'money',
      today: { amount: 1, currency: 'CNY' },
      details: [
        { label: ' 今日 ', value: ' 5 ', hint: 'h'.repeat(300) },
        { label: '', value: 'x' },
        { label: 'bad', value: '' },
        ...Array.from({ length: 20 }, (_, i) => ({ label: 'l' + i, value: 'v' })),
      ],
      usage: { todayTokens: 1234.6, turnTokens: -3 },
    },
    { adapterId: 'x' }
  )
  assert.equal(snap.details.length, 12)
  assert.deepEqual(snap.details[0], { label: '今日', value: '5', hint: 'h'.repeat(120) })
  assert.equal(snap.usage.todayTokens, 1235)
  assert.equal(snap.usage.turnTokens, 0)
})

test('contracts: 不支持计费时新字段一律清空', () => {
  const s = normalizeSnapshot(
    {
      supported: false,
      quotaCard: { kind: 'plan', plan: 'Free' },
      details: [{ label: 'a', value: 'b' }],
      usage: { todayTokens: 99 },
    },
    { adapterId: 'generic', adapterName: '通用' }
  )
  assert.equal(s.quotaCard, null)
  assert.deepEqual(s.details, [])
  assert.equal(s.usage, null)
  assert.equal(s.plan, '')
  assert.equal(s.account, '')
})
