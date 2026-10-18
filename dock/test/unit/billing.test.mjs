// 计费快照服务（R4）：缓存 / 合并 / 失败不缓存
import assert from 'node:assert/strict'
import test from 'node:test'
import { createBillingService } from '../../daemon/src/billing.mjs'
import { genericAdapter } from '../../adapters/generic.mjs'

const WIN = { exe: 'C:\\Apps\\Fake\\fake.exe', title: 'FakeAgent', pid: 100 }

function adapterWith(over = {}) {
  let calls = 0
  const a = {
    id: 'fake',
    name: 'Fake',
    priority: 1,
    match: { exeBasenames: ['fake.exe'] },
    capabilities: { billing: true, follow: true },
    createBilling() {
      return {
        async snapshot() {
          calls++
          return {
            supported: true,
            unit: 'money',
            today: { amount: calls, currency: 'CNY' },
            turn: { amount: 0.5 },
            source: 'unit-test',
            ...over,
          }
        },
      }
    },
    _calls: () => calls,
  }
  return a
}

test('billing: generic 窗口返回 supported:false（不猜数字）', async () => {
  const svc = createBillingService({ adapters: [genericAdapter] })
  const s = await svc.snapshot({ exe: 'C:\\Windows\\notepad.exe', title: '无标题' })
  assert.equal(s.supported, false)
  assert.equal(s.adapterId, 'generic')
  assert.equal(s.today, null)
  assert.equal(s.error, null)
})

test('billing: TTL 内复用缓存，第二次标 cached', async () => {
  const a = adapterWith()
  let t = 1000
  const svc = createBillingService({ adapters: [genericAdapter, a], ttlMs: 3000, now: () => t })
  const s1 = await svc.snapshot(WIN)
  t += 1000
  const s2 = await svc.snapshot(WIN)
  assert.equal(s1.cached, undefined)
  assert.equal(s2.cached, true)
  assert.equal(s2.today.amount, 1)
  assert.equal(a._calls(), 1)
})

test('billing: TTL 过期后重新取；force 立即重取', async () => {
  const a = adapterWith()
  let t = 1000
  const svc = createBillingService({ adapters: [genericAdapter, a], ttlMs: 3000, now: () => t })
  await svc.snapshot(WIN)
  t += 3001
  const s2 = await svc.snapshot(WIN)
  assert.equal(s2.today.amount, 2)
  const s3 = await svc.snapshot(WIN, { force: true })
  assert.equal(s3.today.amount, 3)
  assert.equal(a._calls(), 3)
})

test('billing: 并发请求合并成一次适配器调用', async () => {
  const a = adapterWith()
  const svc = createBillingService({ adapters: [genericAdapter, a] })
  const [x, y, z] = await Promise.all([svc.snapshot(WIN), svc.snapshot(WIN), svc.snapshot(WIN)])
  assert.equal(a._calls(), 1)
  assert.equal(x.today.amount, 1)
  assert.equal(y.today.amount, 1)
  assert.equal(z.today.amount, 1)
})

test('billing: 适配器抛异常 → ok:false 且带 adapterId，不缓存', async () => {
  let calls = 0
  const boom = {
    id: 'boom',
    name: 'Boom',
    priority: 1,
    match: { exeBasenames: ['fake.exe'] },
    capabilities: { billing: true },
    createBilling() {
      return {
        async snapshot() {
          calls++
          throw new Error('db locked')
        },
      }
    },
  }
  const svc = createBillingService({ adapters: [genericAdapter, boom] })
  const s1 = await svc.snapshot(WIN)
  assert.equal(s1.ok, false)
  assert.match(s1.error, /db locked/)
  assert.equal(s1.adapterId, 'boom')
  const s2 = await svc.snapshot(WIN)
  assert.equal(s2.ok, false)
  assert.equal(calls, 2, '失败不缓存，应重试')
})

test('billing: createBilling 抛异常也被兜住', async () => {
  const broken = {
    id: 'broken',
    name: 'Broken',
    priority: 1,
    match: { exeBasenames: ['fake.exe'] },
    capabilities: { billing: true },
    createBilling() {
      throw new Error('nope')
    },
  }
  const svc = createBillingService({ adapters: [genericAdapter, broken] })
  const s = await svc.snapshot(WIN)
  assert.equal(s.ok, false)
  assert.match(s.error, /nope/)
})
