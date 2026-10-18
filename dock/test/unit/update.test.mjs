// 独立更新（R9）：版本比较 / tar 解析 / 备份回滚 / 校验
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  applyFiles,
  compareVersions,
  extractPackage,
  pruneBackups,
  sha256,
  updateFromManifest,
} from '../../daemon/src/update.mjs'
import { untar, stripTopDir, safeRelPath, writeTar } from '../../shared/tar.mjs'

function tarEntry(name, data) {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const b of header) sum += b
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([header, data, pad])
}

function tarGz(entries) {
  const parts = []
  for (const [name, text] of Object.entries(entries)) parts.push(tarEntry(name, Buffer.from(text)))
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('update: 版本比较（含预发布）', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1)
  assert.equal(compareVersions('0.2.0-pre.1', '0.2.0'), -1)
  assert.equal(compareVersions('0.2.0-pre.2', '0.2.0-pre.1'), 1)
  assert.equal(compareVersions('0.2.0-pre.10', '0.2.0-pre.9'), 1)
  assert.throws(() => compareVersions('v0.2', '0.1.0'), /bad version/)
})

test('tar: 解析往返、剥掉顶层目录', () => {
  const gz = tarGz({
    'repo-ref/package.json': '{"name":"x"}',
    'repo-ref/lib/a.mjs': 'export const a = 1',
    'repo-ref/README.md': '# hi',
  })
  const raw = untar(gunzipSync(gz))
  assert.equal(raw.size, 3)
  const files = stripTopDir(raw)
  assert.deepEqual([...files.keys()].sort(), ['README.md', 'lib/a.mjs', 'package.json'])
  assert.equal(files.get('package.json').toString(), '{"name":"x"}')
})

test('tar: 没有统一前缀时保持原样', () => {
  const buf = Buffer.concat([tarEntry('a.txt', Buffer.from('A')), tarEntry('b.txt', Buffer.from('B')), Buffer.alloc(1024)])
  const files = stripTopDir(untar(buf))
  assert.deepEqual([...files.keys()].sort(), ['a.txt', 'b.txt'])
})

test('tar: 危险路径一律拒绝', () => {
  assert.equal(safeRelPath('../evil'), null)
  assert.equal(safeRelPath('/etc/passwd'), null)
  assert.equal(safeRelPath('C:/Windows/x'), null)
  assert.equal(safeRelPath('./a/b'), 'a/b')
  assert.equal(safeRelPath('a\\b'), 'a/b')

  const gz = tarGz({ 'x/../../evil.txt': 'boom' })
  assert.throws(() => extractPackage(gz), /unsafe path/)
})

test('apply: 覆盖写入并备份原文件', () => {
  const root = tempDir('fox-up-root-')
  const backup = tempDir('fox-up-bak-')
  try {
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(root, 'lib', 'a.mjs'), 'old')
    const r = applyFiles(root, new Map([['lib/a.mjs', Buffer.from('new')], ['lib/b.mjs', Buffer.from('b')]]), {
      backupDir: backup,
    })
    assert.equal(r.ok, true)
    assert.equal(fs.readFileSync(path.join(root, 'lib', 'a.mjs'), 'utf8'), 'new')
    assert.equal(fs.readFileSync(path.join(root, 'lib', 'b.mjs'), 'utf8'), 'b')
    assert.equal(fs.readFileSync(path.join(backup, 'lib', 'a.mjs'), 'utf8'), 'old')
    assert.equal(fs.existsSync(path.join(backup, 'lib', 'b.mjs')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(backup, { recursive: true, force: true })
  }
})

test('apply: 中途失败 → 整批回滚（原文件恢复、新文件删除）', () => {
  const root = tempDir('fox-up-root2-')
  const backup = tempDir('fox-up-bak2-')
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'old-a')
    // 目标路径先放一个目录，writeFileSync 必然失败
    fs.mkdirSync(path.join(root, 'blocked.txt'), { recursive: true })
    const r = applyFiles(
      root,
      new Map([
        ['a.txt', Buffer.from('new-a')],
        ['new.txt', Buffer.from('new')],
        ['blocked.txt', Buffer.from('x')],
      ]),
      { backupDir: backup }
    )
    assert.equal(r.ok, false)
    assert.ok(r.rollback && r.rollback.ok)
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'old-a')
    assert.equal(fs.existsSync(path.join(root, 'new.txt')), false)
    assert.equal(fs.statSync(path.join(root, 'blocked.txt')).isDirectory(), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(backup, { recursive: true, force: true })
  }
})

async function withServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url]
    if (!body) {
      res.writeHead(404)
      res.end('nope')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end(body)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    return await fn('http://127.0.0.1:' + port)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('updateFromManifest: sha256 不匹配 → 拒绝且不动文件', async () => {
  const root = tempDir('fox-up-root3-')
  const dataDir = tempDir('fox-up-data3-')
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'keep')
    const pkg = tarGz({ 'x/a.txt': 'evil' })
    await withServer({ '/pkg.tgz': pkg }, async (base) => {
      const r = await updateFromManifest(
        { version: '9.9.9', url: base + '/pkg.tgz', sha256: 'a'.repeat(64) },
        { root, dataDir, currentVersion: '0.1.0' }
      )
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'sha256-mismatch')
    })
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'keep')
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'update-state.json'), 'utf8'))
    assert.equal(st.history.at(-1).result, 'failed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('updateFromManifest: 不比当前新 → not-newer（不下载）', async () => {
  const root = tempDir('fox-up-root4-')
  const dataDir = tempDir('fox-up-data4-')
  try {
    const r = await updateFromManifest(
      { version: '0.1.0', url: 'http://127.0.0.1:1/none.tgz', sha256: 'b'.repeat(64) },
      { root, dataDir, currentVersion: '0.1.0' }
    )
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not-newer')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('updateFromManifest: 正常更新写入文件并记历史（包有顶层前缀）', async () => {
  const root = tempDir('fox-up-root5-')
  const dataDir = tempDir('fox-up-data5-')
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'old')
    const pkg = tarGz({ 'repo-ref/a.txt': 'new', 'repo-ref/lib/b.mjs': 'b' })
    await withServer({ '/pkg.tgz': pkg }, async (base) => {
      const r = await updateFromManifest(
        { version: '0.2.0-pre.1', url: base + '/pkg.tgz', sha256: sha256(pkg) },
        { root, dataDir, currentVersion: '0.2.0-pre.0' }
      )
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(r.files, 2)
    })
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'new')
    assert.equal(fs.readFileSync(path.join(root, 'lib', 'b.mjs'), 'utf8'), 'b')
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'update-state.json'), 'utf8'))
    assert.equal(st.appliedVersion, '0.2.0-pre.1')
    assert.equal(st.history.at(-1).result, 'ok')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------- 清单签名（D012） ----------

test('manifest: 签名 / 验签往返，键顺序与空白不影响', async () => {
  const { generateKeyPair, signManifest, verifyManifest, canonicalManifest } = await import('../../shared/manifest.mjs')
  const { publicKeyPem, privateKeyPem } = generateKeyPair()
  const signed = signManifest({ version: '0.2.0-pre.1', url: 'https://x/y.tgz', sha256: 'a'.repeat(64), notes: 'hi' }, privateKeyPem)
  assert.equal(verifyManifest(signed, publicKeyPem).ok, true)

  // 重新排字段顺序、加空格后仍应验签通过（规范串只认字段值）
  const reordered = { notes: 'hi', sha256: 'a'.repeat(64), url: 'https://x/y.tgz', version: '0.2.0-pre.1', signature: signed.signature }
  assert.equal(verifyManifest(reordered, publicKeyPem).ok, true)
  assert.equal(canonicalManifest(reordered), canonicalManifest(signed))
})

test('manifest: 改任何受保护字段都验不过', async () => {
  const { generateKeyPair, signManifest, verifyManifest } = await import('../../shared/manifest.mjs')
  const { publicKeyPem, privateKeyPem } = generateKeyPair()
  const base = { version: '0.2.0', url: 'https://x/y.tgz', sha256: 'b'.repeat(64), notes: '' }
  const signed = signManifest(base, privateKeyPem)
  for (const patch of [{ version: '0.3.0' }, { url: 'https://evil/x.tgz' }, { sha256: 'c'.repeat(64) }, { notes: 'x' }]) {
    const v = verifyManifest({ ...signed, ...patch }, publicKeyPem)
    assert.equal(v.ok, false, JSON.stringify(patch))
    assert.equal(v.reason, 'bad-signature')
  }
})

test('manifest: 缺签名 / 换公钥 / 坏 base64 都被拒绝', async () => {
  const { generateKeyPair, signManifest, verifyManifest } = await import('../../shared/manifest.mjs')
  const a = generateKeyPair()
  const b = generateKeyPair()
  const signed = signManifest({ version: '1.0.0', url: 'https://x/y', sha256: 'd'.repeat(64) }, a.privateKeyPem)
  assert.equal(verifyManifest({ ...signed, signature: '' }, a.publicKeyPem).reason, 'missing-signature')
  assert.equal(verifyManifest(signed, b.publicKeyPem).reason, 'bad-signature')
  assert.equal(verifyManifest({ ...signed, signature: '!!!' }, a.publicKeyPem).ok, false)
  assert.equal(verifyManifest(signed, '').reason, 'no-public-key')
})

test('fetchManifest: 未签名清单默认拒绝，签名后放行', async () => {
  const { generateKeyPair, signManifest } = await import('../../shared/manifest.mjs')
  const { fetchManifest } = await import('../../daemon/src/update.mjs')
  const { publicKeyPem, privateKeyPem } = generateKeyPair()
  const base = { version: '0.2.0-pre.2', url: 'https://x/y.tgz', sha256: 'e'.repeat(64), notes: '' }

  await withServer(
    { '/unsigned.json': JSON.stringify(base), '/signed.json': JSON.stringify(signManifest(base, privateKeyPem)) },
    async (origin) => {
      await assert.rejects(() => fetchManifest(origin + '/unsigned.json', { publicKeyPem }), /signature/)
      const ok = await fetchManifest(origin + '/signed.json', { publicKeyPem })
      assert.equal(ok.version, '0.2.0-pre.2')
      // 显式关闭校验时未签名也放行（仅本地调试）
      const loose = await fetchManifest(origin + '/unsigned.json', { requireSignature: false })
      assert.equal(loose.version, '0.2.0-pre.2')
    }
  )
})

test('tar: writeTar 与 untar 往返（含超过 100 字节的长路径）', () => {
  const long = 'dock/adapters/' + 'x'.repeat(120) + '/index.mjs'
  const files = new Map([
    ['dock/package.json', Buffer.from('{"name":"fox-dock"}')],
    ['dock/lib/a.mjs', Buffer.from('export const a = 1')],
    [long, Buffer.from('long-name')],
  ])
  const back = untar(writeTar(files))
  assert.equal(back.size, 3)
  assert.equal(back.get('dock/package.json').toString(), '{"name":"fox-dock"}')
  assert.equal(back.get(long).toString(), 'long-name')
})

test('update: 备份目录只保留最近 3 份', () => {
  const dir = tempDir('fox-up-prune-')
  try {
    for (const name of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']) {
      fs.mkdirSync(path.join(dir, name), { recursive: true })
    }
    const r = pruneBackups(dir, 3)
    assert.equal(r.removed, 2)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-01-03', '2026-01-04', '2026-01-05'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
