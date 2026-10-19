// 全厂商面板的数据桥：只认本机挂件服务，去掉 keySource 等本机路径。
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import {
  _resetHostVendorCache,
  listVendorServices,
  readHostVendors,
  vendorPorts,
} from '../../daemon/src/host-vendors.mjs'

function startMock({ app = 'zcode-fox-widget', vendors = [], status = 200 } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/whale/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, app, version: '1.15.1', port: server.address().port }))
        return
      }
      if (req.url === '/whale/vendors.json') {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, vendors }))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const SAMPLE = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'balance',
    currency: 'CNY',
    available: true,
    balance: 0.63,
    todayUsage: 0.000563,
    keySource: 'E:\\ZCodeData\\.zcode\\provider_config.json',
    keyMasked: 'sk-***',
    note: '内置余额接口',
  },
  {
    id: 'commandcode',
    name: 'CommandCode',
    kind: 'cmdgo',
    currency: 'USD',
    available: true,
    planName: 'GOAT',
    account: 'paper189',
    monthly: { remaining: 39.8, total: 70, percent: 0.431, resetAt: 1794269138000 },
    fiveHour: { used: 0.77, cap: 14, remaining: 13.23, percent: 0.055, exceeded: false },
    weekly: { used: 5.95, cap: 35, remaining: 29.05, percent: 0.17 },
    pool: { available: 1, total: 2, cooldownFree: 2 },
    keySource: 'C:\\Users\\paper\\.commandcode\\config.json',
  },
  { id: 'glm', name: 'GLM Plan', kind: 'local-log', available: true, percentRemaining: 0.0675, remaining: 135, total: 2000 },
  { id: 'openai', name: 'OpenAI', kind: 'tokens', available: false, reason: '未配置凭据（环境变量或 ~/.zcode/whale/config.json）' },
]

test('vendorPorts：环境变量端口白名单 / 默认范围', () => {
  assert.deepEqual(vendorPorts({}), [39321, 39322, 39323, 39324, 39325, 39326, 39327, 39328, 39329, 39330])
  assert.deepEqual(vendorPorts({ FOX_DOCK_VENDOR_PORTS: '41001, 41002,bad,99999' }), [41001, 41002])
  assert.equal(vendorPorts({ FOX_DOCK_VENDOR_PORTS: 'bad' }).length, 10)
})

test('host-vendors：识别 zcode 服务并收敛字段，去掉 keySource', async () => {
  const server = await startMock({ vendors: SAMPLE })
  const port = server.address().port
  try {
    _resetHostVendorCache()
    const r = await readHostVendors('zcode', { ports: [port], force: true })
    assert.equal(r.ok, true)
    assert.equal(r.adapter, 'zcode')
    assert.equal(r.source.port, port)
    assert.equal(r.vendors.length, 4)
    const ds = r.vendors.find((v) => v.id === 'deepseek')
    assert.equal(ds.balance, 0.63)
    assert.equal(ds.todayUsage, 0.000563)
    assert.equal('keySource' in ds, false)
    assert.equal('keyMasked' in ds, false)
    const cc = r.vendors.find((v) => v.id === 'commandcode')
    assert.equal(cc.planName, 'GOAT')
    assert.equal(cc.monthly.remaining, 39.8)
    assert.equal(cc.fiveHour.exceeded, false)
    assert.deepEqual(cc.pool, { available: 1, total: 2, cooldownFree: 2, kind: '' })
    const glm = r.vendors.find((v) => v.id === 'glm')
    assert.equal(glm.percentRemaining, 0.0675)
  } finally {
    server.close()
  }
})

test('host-vendors：workbuddy 服务映射 + 缓存命中', async () => {
  const server = await startMock({ app: 'fox-widget', vendors: SAMPLE })
  const port = server.address().port
  try {
    _resetHostVendorCache()
    const services = await listVendorServices({ ports: [port], force: true })
    assert.equal(services.length, 1)
    assert.equal(services[0].adapter, 'workbuddy')
    const a = await readHostVendors('workbuddy', { ports: [port], force: true })
    const b = await readHostVendors('workbuddy', { ports: [port] })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(b.cached, true)
  } finally {
    server.close()
  }
})

test('host-vendors：没有服务 / HTTP 失败 / 未知 app 都返回可读原因', async () => {
  _resetHostVendorCache()
  const missing = await readHostVendors('zcode', { ports: [1], force: true })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'service-unavailable')

  const server = await startMock({ vendors: SAMPLE, status: 500 })
  const port = server.address().port
  try {
    _resetHostVendorCache()
    const r = await readHostVendors('zcode', { ports: [port], force: true })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'http')
  } finally {
    server.close()
  }
})
