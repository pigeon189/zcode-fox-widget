// 适配器契约与注册表（R4）
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  basenameOf,
  normalizeSnapshot,
  normalizeWindow,
  scoreMatch,
  validateAdapter,
} from '../../adapters/contracts.mjs'
import { describeAdapters, resolveAdapter } from '../../adapters/registry.mjs'
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
