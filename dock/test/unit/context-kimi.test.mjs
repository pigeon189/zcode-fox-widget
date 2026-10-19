import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { listKimiSessions, readKimiContext } from '../../adapters/kimi/context.mjs'

const TOKEN = 'fixture-token-do-not-log'
let server = null
let port = 0
let mode = 'ok'

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(res, 401, { error: 'unauthorized' })
    if (mode === 'unauthorized') return send(res, 401, { error: 'unauthorized' })
    if (req.url === '/sessions') {
      if (mode === 'empty') return send(res, 200, { sessions: [] })
      if (mode === 'schema') return send(res, 200, { odd: true })
      return send(res, 200, {
        sessions: [
          { id: 's1', title: '重构 billing 适配器', model: 'kimi-k3', updated_at: 1000 },
          { id: 's2', title: '旧会话', model: 'kimi-k3', updated_at: 500 },
        ],
      })
    }
    if (req.url === '/sessions/s1/status') {
      if (mode === 'schema') return send(res, 200, { weird: 1 })
      return send(res, 200, {
        session_id: 's1',
        title: '重构 billing 适配器',
        model: 'kimi-k3',
        context_tokens: 475318,
        max_context_tokens: 1000000,
        usage: {
          input_tokens: 475000,
          cache_read_tokens: 292100,
          cache_creation_tokens: 4000,
          output_tokens: 318,
          context_limit: 1000000,
        },
      })
    }
    if (req.url === '/sessions/s2/status') {
      return send(res, 200, { context_tokens: 1000, max_context_tokens: 262144, model: 'kimi-k3-256k' })
    }
    return send(res, 404, { error: 'not-found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(() => {
  if (server) server.close()
})

const opts = () => ({ baseUrl: 'http://127.0.0.1:' + port, token: TOKEN, fetchImpl: fetch, now: () => Date.now() })

test('kimi context: 正常状态给出 used/limit/breakdown', async () => {
  mode = 'ok'
  const c = await readKimiContext(opts())
  assert.equal(c.supported, true)
  assert.equal(c.sessionId, 's1')
  assert.equal(c.used, 475318)
  assert.equal(c.limit, 1000000)
  assert.equal(c.limitSource, 'host')
  assert.equal(c.confidence, 'exact')
  assert.equal(c.breakdown.input, 475000 - 292100 - 4000)
  assert.equal(c.breakdown.cacheRead, 292100)
  assert.equal(c.breakdown.cacheWrite, 4000)
  assert.equal(c.breakdown.output, 318)
})

test('kimi context: token 不出现在返回对象里', async () => {
  mode = 'ok'
  const c = await readKimiContext(opts())
  assert.equal(JSON.stringify(c).includes(TOKEN), false)
})

test('kimi context: 401 → auth；空列表 → no-session；形状漂移 → schema', async () => {
  mode = 'unauthorized'
  assert.equal((await readKimiContext(opts())).reason, 'auth')
  mode = 'empty'
  assert.equal((await readKimiContext(opts())).reason, 'no-session')
  mode = 'schema'
  assert.equal((await readKimiContext(opts())).reason, 'schema')
})

test('kimi context: 服务不在 → not-running（不抛错）', async () => {
  const c = await readKimiContext({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, fetchImpl: fetch, timeoutMs: 300 })
  assert.equal(c.supported, false)
  assert.equal(c.reason, 'not-running')
})

test('kimi sessions: 列出会话并带上下文占用', async () => {
  mode = 'ok'
  const list = await listKimiSessions(opts())
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 's1')
  assert.equal(list[0].used, 475318)
  assert.equal(list[0].pct, 47.5)
  assert.equal(list[1].limit, 262144)
})
