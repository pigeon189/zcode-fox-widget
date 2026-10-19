import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createVault, maskSecret, protectSecret, unprotectSecret } from '../../daemon/src/vault.mjs'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-vault-'))
  return { dir, file: path.join(dir, 'vault.json') }
}

test('vault: 掩码前 3 后 4，短于 8 位全掩', () => {
  assert.equal(maskSecret('fx-1234567890abcdef'), 'fx-••••cdef')
  assert.equal(maskSecret('short'), '****')
  assert.equal(maskSecret(''), '')
})

test('vault: DPAPI 往返（Windows）', { skip: process.platform !== 'win32' }, () => {
  const plain = 'fx-test-' + 'x'.repeat(24)
  const cipher = protectSecret(plain)
  assert.notEqual(cipher, plain)
  assert.equal(unprotectSecret(cipher), plain)
})

test('vault: 写入文件不含明文，读取/删除/列表正确', { skip: process.platform !== 'win32' }, () => {
  const { dir, file } = tempFile()
  try {
    const v = createVault({ file })
    const secret = 'fx-live-' + 'a'.repeat(20)
    const r = v.set('deepseek', secret)
    assert.equal(r.masked, 'fx-••••aaaa')
    const raw = fs.readFileSync(file, 'utf8')
    assert.equal(raw.includes(secret), false, '保险库文件里不能出现明文')
    assert.equal(v.get('deepseek'), secret)
    assert.equal(v.has('deepseek'), true)
    assert.deepEqual(v.list().map((x) => x.id), ['deepseek'])
    const provider = v.provider()
    assert.equal(provider.get('deepseek'), secret)
    assert.equal(v.delete('deepseek').removed, true)
    assert.equal(v.get('deepseek'), '')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: 密文被篡改 → 明确报错，不返回垃圾', { skip: process.platform !== 'win32' }, () => {
  const { dir, file } = tempFile()
  try {
    const v = createVault({ file })
    v.set('kimi', 'fx-kimi-' + 'b'.repeat(20))
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const orig = Buffer.from(raw.items.kimi.data, 'base64')
    // 偏移 5/10 落在 DPAPI blob 头部（会被忽略），改中间的数据区才代表真实篡改
    orig[Math.floor(orig.length / 2)] ^= 0xff
    raw.items.kimi.data = orig.toString('base64')
    fs.writeFileSync(file, JSON.stringify(raw))
    const v2 = createVault({ file })
    assert.throws(() => v2.get('kimi'), /vault-dpapi|vault-corrupt/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('vault: 非法 id / 空密钥被拒绝', () => {
  const { dir, file } = tempFile()
  try {
    const v = createVault({ file })
    assert.throws(() => v.set('../evil', 'x'), /vault-bad-id/)
    assert.throws(() => v.set('deepseek', '   '), /vault-empty-secret/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
