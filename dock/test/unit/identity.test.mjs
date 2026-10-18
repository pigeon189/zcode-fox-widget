import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBindKey, parseBindKey, processKeyOf, sameProcess, normalizeExe, normalizeHwnd } from '../../shared/identity.mjs'

const base = {
  exe: 'C:\\Program Files\\ZCode\\ZCode.exe',
  pid: 4242,
  startMs: 1792320000000,
  hwnd: '0x1A2B3C',
}

test('bind key: 往返一致，路径与 hwnd 规范化', () => {
  const key = buildBindKey(base)
  assert.equal(key, 'c:/program files/zcode/zcode.exe|4242|1792320000000|1a2b3c')
  assert.deepEqual(parseBindKey(key), {
    exe: 'c:/program files/zcode/zcode.exe',
    pid: 4242,
    startMs: 1792320000000,
    hwnd: '1a2b3c',
  })
})

test('bind key: 同一进程的两个窗口 → 键不同、进程键相同', () => {
  const a = buildBindKey({ ...base, hwnd: 'A02D6' })
  const b = buildBindKey({ ...base, hwnd: '1202EC' })
  assert.notEqual(a, b)
  assert.equal(processKeyOf(a), processKeyOf(b))
  assert.equal(sameProcess(a, base), true)
})

test('bind key: 进程重启（pid 复用、启动时间不同）→ 不复用旧绑定', () => {
  const before = buildBindKey(base)
  const after = buildBindKey({ ...base, startMs: base.startMs + 60000, hwnd: 'A02D6' })
  assert.notEqual(processKeyOf(before), processKeyOf(after))
  assert.equal(sameProcess(before, { ...base, startMs: base.startMs + 60000 }), false)
})

test('bind key: 大小写与斜杠等价', () => {
  const a = buildBindKey({ ...base, exe: 'c:/program files/zcode/zcode.exe' })
  const b = buildBindKey({ ...base, exe: 'C:\\Program Files\\ZCode\\ZCode.exe' })
  assert.equal(a, b)
})

test('bind key: 非法输入明确报错', () => {
  assert.throws(() => buildBindKey({ ...base, exe: '' }), /exe required/)
  assert.throws(() => buildBindKey({ ...base, pid: 0 }), /pid invalid/)
  assert.throws(() => buildBindKey({ ...base, startMs: NaN }), /startMs invalid/)
  assert.throws(() => buildBindKey({ ...base, hwnd: 'zzz' }), /hwnd invalid/)
})

test('parse: 脏数据返回 null，不抛异常', () => {
  assert.equal(parseBindKey(''), null)
  assert.equal(parseBindKey('a|b'), null)
  assert.equal(parseBindKey('exe|0|1|1a'), null)
  assert.equal(parseBindKey('exe|1|-5|1a'), null)
  assert.equal(parseBindKey('exe|1|5|not-hex'), null)
  assert.equal(parseBindKey(null), null)
})

test('normalize: hwnd 去 0x、小写；非法返回空串', () => {
  assert.equal(normalizeHwnd('0XABC'), 'abc')
  assert.equal(normalizeHwnd(' abc '), 'abc')
  assert.equal(normalizeHwnd('0x'), '')
  assert.equal(normalizeHwnd('12g'), '')
})

test('normalize: exe 统一正斜杠与小写，去重复斜杠', () => {
  assert.equal(normalizeExe('C:\\\\A\\\\B.exe'), 'c:/a/b.exe')
  assert.equal(normalizeExe('  C:/A//B.exe '), 'c:/a/b.exe')
})
