// 更新 CLI 端到端（R9）：本地 HTTP + 真进程 + 签名清单
//
// 覆盖：--check 能识别有更新；--apply 把包落到 --root 指定的目录；
// 签名不对时拒绝；--root 不传也不会碰真实安装目录（这条靠测试用 --root 保证）。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { writeTar } from '../../shared/tar.mjs'
import { generateKeyPair, signManifest } from '../../shared/manifest.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCK = path.join(HERE, '..', '..')
const CLI = path.join(DOCK, 'tools', 'fox-dock.mjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-upcli-'))
const installRoot = path.join(root, 'install')
const dataDir = path.join(root, 'data')
const keyFile = path.join(root, 'pub.pem')
const { publicKeyPem, privateKeyPem } = generateKeyPair()

const pkg = gzipSync(
  Buffer.concat([
    writeTar(
      new Map([
        ['dock-9.9.9/sentinel.txt', Buffer.from('v999')],
        ['dock-9.9.9/lib/new.mjs', Buffer.from('export const x = 9')],
      ])
    ),
  ])
)

let server = null
let origin = ''
let manifestUrl = ''

before(async () => {
  fs.mkdirSync(installRoot, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(installRoot, 'sentinel.txt'), 'v-old')
  fs.writeFileSync(keyFile, publicKeyPem)

  const sha256 = (await import('node:crypto')).createHash('sha256').update(pkg).digest('hex')
  server = http.createServer((req, res) => {
    if (req.url === '/pkg.tgz') {
      res.writeHead(200, { 'Content-Type': 'application/gzip' })
      res.end(pkg)
      return
    }
    if (req.url === '/update.json') {
      const m = signManifest(
        { version: '9.9.9', url: origin + '/pkg.tgz', sha256, notes: 'test' },
        privateKeyPem
      )
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(m))
      return
    }
    if (req.url === '/bad.json') {
      const m = signManifest({ version: '9.9.9', url: origin + '/pkg.tgz', sha256, notes: 'test' }, privateKeyPem)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // 篡改受保护字段，签名必须失效
      res.end(JSON.stringify({ ...m, sha256: 'f'.repeat(64) }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  origin = 'http://127.0.0.1:' + server.address().port
  manifestUrl = origin + '/update.json'
})

after(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(root, { recursive: true, force: true })
})

function runCli(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('exit', (code) => resolve({ code, out, err }))
  })
}

test('update --check：识别到更新且不写文件', async () => {
  const r = await runCli(['update', '--check', '--manifest', manifestUrl, '--pubkey', keyFile, '--data-dir', dataDir])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /有更新/)
  assert.equal(fs.readFileSync(path.join(installRoot, 'sentinel.txt'), 'utf8'), 'v-old')
})

test('update --check：签名被篡改 → 拒绝', async () => {
  const r = await runCli(['update', '--check', '--manifest', origin + '/bad.json', '--pubkey', keyFile, '--data-dir', dataDir])
  assert.equal(r.code, 1)
  assert.match(r.err, /signature/)
})

test('update --apply：落盘到 --root，并记入 update-state', async () => {
  const r = await runCli([
    'update',
    '--apply',
    '--manifest',
    manifestUrl,
    '--pubkey',
    keyFile,
    '--data-dir',
    dataDir,
    '--root',
    installRoot,
  ])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /已写入 2 个文件/)
  assert.equal(fs.readFileSync(path.join(installRoot, 'sentinel.txt'), 'utf8'), 'v999')
  assert.equal(fs.readFileSync(path.join(installRoot, 'lib', 'new.mjs'), 'utf8'), 'export const x = 9')

  const hist = await runCli(['update', '--history', '--data-dir', dataDir])
  assert.match(hist.out, /9\.9\.9/)
  assert.match(hist.out, /ok/)
})
