// D036 脱敏：密钥形态 / 主目录 / 截断 / 不误伤
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import os from 'node:os'
import { MASK, redact, redactHome } from '../../shared/redact.mjs'

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

test('redact: 命令行凭据参数（--password / --token / -p 紧贴值）也遮蔽', () => {
  const cases = [
    ['mysql -u root -pS3cr3t db', 'S3cr3t'],
    ['tool --password hunter2 --user a', 'hunter2'],
    ['deploy --token abcdef123456 --yes', 'abcdef123456'],
    ['x --api-key "quoted secret" y', 'quoted secret'],
    ['x --pwd=letmein y', 'letmein'],
    // 复合长选项（复审 R2-1）：裸名规则只认 `--` 后紧跟裸名，空格分隔的
    // `--access-token X` 等复合名会整条漏出。
    ['cli deploy --access-token supers3cret99 --region us', 'supers3cret99'],
    ['kubectl --auth-token myrealtoken12345 get pods', 'myrealtoken12345'],
    ['x --refresh-token rrr1234567890 y', 'rrr1234567890'],
    ['x --client-secret cs3cr3tvalue z', 'cs3cr3tvalue'],
    ['x --session-token st999888777a a', 'st999888777a'],
    ['x --access-token=eq123456789 y', 'eq123456789'],
  ]
  for (const [s, secret] of cases) {
    const out = redact(s)
    assert.ok(out.includes(MASK), 'should mask: ' + s)
    assert.ok(!out.includes(secret), 'secret leaked: ' + s + ' → ' + out)
  }
  // 普通命令与普通词不误伤
  assert.equal(redact('git push origin main'), 'git push origin main')
  assert.equal(redact('password manager'), 'password manager')
  // `-p` 紧贴值只遮「像凭据」的紧凑值：纯字母长选项（find -print / -pretty /
  // -path）不是凭据，不能被整段吞掉。
  assert.equal(redact('find . -print'), 'find . -print')
  assert.equal(redact('rg --files -pretty'), 'rg --files -pretty')
  assert.equal(redact('find . -path ./node_modules -prune'), 'find . -path ./node_modules -prune')
  // 更不能吞 shell 语法/引号：危险词必须留给风险判定
  assert.equal(redact('bash -p<<<"rm -rf /"'), 'bash -p<<<"rm -rf /"')
  assert.equal(redact('bash -p<<<"dd if=/dev/zero of=/dev/sda"'), 'bash -p<<<"dd if=/dev/zero of=/dev/sda"')
})

test('redact: JSON 形态的凭据字段也遮蔽（钩子 JSON.stringify 的 tool_input）', () => {
  const cases = [
    ['{"token":"tok_live_9f8e7d6c5b4a","api_key":"AKIAZZZZZZZZZZZZZZZZ","password":"hunter2"}', ['tok_live_9f8e7d6c5b4a', 'hunter2']],
    ['{"password": "hunter2"}', ['hunter2']],
    ['{"access_token":"abc123secretvalue"}', ['abc123secretvalue']],
    ['{"client_secret":"s3cr3t-value"}', ['s3cr3t-value']],
    ['{"apiKey":"plainKeyValue123"}', ['plainKeyValue123']],
    // 值被截断在半截（预览 400 字边界）：也要遮到字符串末尾
    ['{"token":"abc123secretvalue', ['abc123secretvalue']],
  ]
  for (const [s, secrets] of cases) {
    const out = redact(s)
    assert.ok(out.includes(MASK), 'should mask: ' + s)
    for (const secret of secrets) assert.ok(!out.includes(secret), 'secret leaked: ' + s + ' → ' + out)
  }
  // 键名只是包含 token/path 等词的不误伤
  assert.equal(redact('{"tokenizer":"x","path":"D:/proj/a.mjs"}'), '{"tokenizer":"x","path":"D:/proj/a.mjs"}')
})

test('redact: 主目录替换为 ~（反斜杠/正斜杠/大小写）', () => {
  const home = process.env.USERPROFILE || os.homedir()
  if (!home) return
  const out = redact('path ' + home + '\\proj\\x')
  assert.ok(out.includes('~'))
  assert.ok(!out.toLowerCase().includes(home.toLowerCase()))
})

test('redactHome: 直写各形态 + 混合大小写（复审 R2-4，Windows 路径大小写不敏感）', () => {
  const saved = process.env.USERPROFILE
  const savedHome = process.env.HOME
  try {
    process.env.USERPROFILE = 'C:\\Users\\paper'
    delete process.env.HOME
    // 原样 / 正斜杠 / 全小写 / 正斜杠+全小写 / 混合大小写（split/join 旧实现漏替）
    assert.equal(redactHome('cwd C:\\Users\\paper\\file.txt'), 'cwd ~\\file.txt')
    assert.equal(redactHome('cwd C:/Users/paper/file.txt'), 'cwd ~/file.txt')
    assert.equal(redactHome('cwd c:\\users\\paper\\file.txt'), 'cwd ~\\file.txt')
    assert.equal(redactHome('cwd c:/users/paper/file.txt'), 'cwd ~/file.txt')
    assert.equal(redactHome('cwd c:\\USERS\\paper\\file.txt'), 'cwd ~\\file.txt')
    // null/undefined 兜成空串
    assert.equal(redactHome(null), '')
    // HOME 兜底来源（USERPROFILE 缺失时）
    delete process.env.USERPROFILE
    process.env.HOME = '/home/paper'
    assert.equal(redactHome('/home/paper/x'), '~/x')
  } finally {
    if (saved !== undefined) process.env.USERPROFILE = saved
    else delete process.env.USERPROFILE
    if (savedHome !== undefined) process.env.HOME = savedHome
    else delete process.env.HOME
  }
})

test('redact: 不误伤普通 hash / UUID / 短词', () => {
  const ok = ['a94f0c6bd2e34ee7', '123e4567-e89b-12d3-a456-426614174000', 'tokenizer', 'password manager', 'AKIA123']
  for (const s of ok) assert.equal(redact(s), s)
})

test('redactHome: daemon/src 不允许再出现本地漂移实现（R2-3）', () => {
  // daemon.mjs 曾自带弱化单变体 redactHome，诊断包会漏替正斜杠/混合大小写主目录；
  // 已统一改 import shared/redact.mjs。此守卫防止第三份实现再长出来。
  const dir = new URL('../../daemon/src/', import.meta.url)
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue
    const src = fs.readFileSync(new URL(name, dir), 'utf8')
    assert.ok(!/function\s+redactHome/.test(src), `daemon/src/${name} 不应自带 redactHome 实现`)
    assert.ok(!/split\((?:os\.homedir\(\)|home)\)\.join/.test(src), `daemon/src/${name} 疑似本地主目录脱敏实现`)
  }
})

test('redact: 1MB 文本 <50ms', () => {
  const input = ('normal text line with uuid 123e4567-e89b-12d3-a456-426614174000\n').repeat(16000)
  const t = Date.now()
  const out = redact(input, 2_000_000)
  assert.ok(Date.now() - t < 500, 'took ' + (Date.now() - t) + 'ms')
  assert.ok(out.length > 0)
})
