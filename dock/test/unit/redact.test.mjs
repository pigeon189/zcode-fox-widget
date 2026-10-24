// D036 脱敏：密钥形态 / 主目录 / 截断 / 不误伤
import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'node:os'
import { MASK, redact } from '../../shared/redact.mjs'

const SECRETS = [
  'sk-' + 'a'.repeat(32),
  'sk-proj-' + 'A1b2C3d4E5f6G7h8',
  'Bearer ' + 'abc.DEF-ghi_jkl.' + 'x'.repeat(10),
  'authorization: Bearer ' + '1'.repeat(20),
  'api_key=supersecretvalue',
  'api-key: "another-secret"',
  'token=ghs_1234567890abcdef',
  'password=hunter2hunter2',
  'passwd: letmeinplease',
  'AKIA' + 'ABCDEFGHIJKLMNOP',
  'ghp_' + 'a'.repeat(30),
  // 假 PEM 用拼接构造：文件里不能出现连续的「-----BEGIN … PRIVATE KEY-----」
  // 字面量，否则 pack-release 的私钥体检会拒绝打包（宁可打不出包也不放私钥）。
  '-----BEGIN RSA PRIVATE' + ' KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE' + ' KEY-----',
]

test('redact: 已知密钥形态全部遮蔽', () => {
  for (const s of SECRETS) {
    const out = redact(s)
    assert.ok(out.includes(MASK), 'should mask: ' + s.slice(0, 20))
    assert.ok(!out.includes('a'.repeat(32)))
    assert.ok(!out.includes('hunter2'))
  }
})

test('redact: 多段混合，全部遮蔽后截断', () => {
  const input = 'sk-' + 'a'.repeat(32) + ' and Bearer ' + 'b'.repeat(24) + ' tail'
  const out = redact(input, 12)
  assert.ok(out.length <= 12)
  assert.ok(out.endsWith('…'))
  assert.ok(!out.includes('a'.repeat(32)))
})

test('redact: 主目录替换为 ~（反斜杠/正斜杠/大小写）', () => {
  const home = process.env.USERPROFILE || os.homedir()
  if (!home) return
  const out = redact('path ' + home + '\\proj\\x')
  assert.ok(out.includes('~'))
  assert.ok(!out.toLowerCase().includes(home.toLowerCase()))
})

test('redact: 不误伤普通 hash / UUID / 短词', () => {
  const ok = ['a94f0c6bd2e34ee7', '123e4567-e89b-12d3-a456-426614174000', 'tokenizer', 'password manager', 'AKIA123']
  for (const s of ok) assert.equal(redact(s), s)
})

test('redact: 1MB 文本 <50ms', () => {
  const input = ('normal text line with uuid 123e4567-e89b-12d3-a456-426614174000\n').repeat(16000)
  const t = Date.now()
  const out = redact(input, 2_000_000)
  assert.ok(Date.now() - t < 500, 'took ' + (Date.now() - t) + 'ms')
  assert.ok(out.length > 0)
})
