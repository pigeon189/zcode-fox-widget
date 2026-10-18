// /vendors：真 daemon + 假挂件线服务，验证路由、白名单端口与字段收敛。
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessAlive, readLock } from '../../daemon/src/lock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(HERE, '..', '..', 'daemon', 'src', 'daemon.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-vendors-'))
let daemon = null
let mock = null
let port = 0
let token = ''

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/whale/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, app: 'zcode-fox-widget', version: '1.15.1', port: server.address().port }))
        return
      }
      if (req.url === '/whale/vendors.json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: true,
            vendors: [
              {
                id: 'deepseek',
                name: 'DeepSeek',
                kind: 'balance',
                currency: 'CNY',
                available: true,
                balance: 0.63,
                keySource: 'E:\\ZCodeData\\.zcode\\provider_config.json',
              },
              { id: 'openai', name: 'OpenAI', kind: 'tokens', available: false, reason: '未配置凭据' },
            ],
          })
        )
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

before(async () => {
  mock = await startMock()
  const mockPort = mock.address().port
  daemon = spawn(process.execPath, [DAEMON, '--data-dir', dir, '--port', '0'], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, FOX_DOCK_VENDOR_PORTS: String(mockPort) },
  })
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const lock = readLock(path.join(dir, 'daemon.lock'))
    if (lock && lock.port && isProcessAlive(lock.pid)) {
      try {
        const h = await (await fetch('http://127.0.0.1:' + lock.port + '/health', { signal: AbortSignal.timeout(800) })).json()
        if (h && h.ok) {
          port = lock.port
          token = lock.token
          break
        }
      } catch (err) {}
    }
    await sleep(150)
  }
  assert.ok(port, 'daemon did not become healthy')
})

after(async () => {
  try {
    await fetch('http://127.0.0.1:' + port + '/shutdown', { method: 'POST', headers: { 'x-fox-token': token } })
  } catch (err) {}
  try {
    daemon.kill()
  } catch (err) {}
  try {
    mock.close()
  } catch (err) {}
  await sleep(150)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('/vendors：按白名单端口找到服务并收敛字段', async () => {
  const res = await fetch('http://127.0.0.1:' + port + '/vendors?adapter=zcode&force=1')
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.adapter, 'zcode')
  assert.equal(body.source.app, 'zcode-fox-widget')
  assert.equal(body.vendors.length, 2)
  assert.equal(body.vendors[0].balance, 0.63)
  assert.equal('keySource' in body.vendors[0], false)
  assert.doesNotThrow(() => JSON.stringify(body))
})

test('/vendors：请求另一个宿主时明确 service-unavailable', async () => {
  const res = await fetch('http://127.0.0.1:' + port + '/vendors?adapter=workbuddy&force=1')
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'service-unavailable')
  assert.ok(Array.isArray(body.services))
  assert.equal(body.services[0].adapter, 'zcode')
})

test('/vendors：不带 adapter 时默认用第一个可用服务', async () => {
  const res = await fetch('http://127.0.0.1:' + port + '/vendors?force=1')
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.adapter, 'zcode')
})
