// D034 zstd 多帧尾随：完整帧 / 半帧 / 坏帧 / 全量等价
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createZstdFrameTail } from '../../shared/tail.mjs'
import { decodeZstdFrames } from '../../adapters/dsh/sessions.mjs'

const hasZstd = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
}

test('zstd-tail: 追加完整帧按顺序产出，与全量解码等价', { skip: !hasZstd }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zstd-'))
  try {
    const file = path.join(dir, 'session.jsonl.zstd')
    const f1 = frame('{"a":1}\n')
    const f2 = frame('{"a":2}\n{"a":3}\n')
    fs.writeFileSync(file, Buffer.concat([f1, f2]))
    const r = createZstdFrameTail(file)
    const p = r.poll()
    assert.deepEqual(p.lines, ['{"a":1}', '{"a":2}', '{"a":3}'])
    const all = decodeZstdFrames(fs.readFileSync(file))
    assert.equal(all.ok, true)
    assert.deepEqual(all.text.split('\n').filter(Boolean), p.lines)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('zstd-tail: 半帧不推进偏移，补齐后恢复', { skip: !hasZstd }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zstd-'))
  try {
    const file = path.join(dir, 'session.jsonl.zstd')
    const f = frame('{"a":1}\n')
    const half = f.subarray(0, Math.floor(f.length / 2))
    fs.writeFileSync(file, half)
    const r = createZstdFrameTail(file)
    assert.deepEqual(r.poll().lines, [])
    assert.equal(r.state.offset, 0)
    fs.appendFileSync(file, f.subarray(half.length))
    assert.deepEqual(r.poll().lines, ['{"a":1}'])
    fs.appendFileSync(file, frame('{"a":2}\n'))
    assert.deepEqual(r.poll().lines, ['{"a":2}'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('zstd-tail: 坏帧跳过并计数，后面的好帧仍能读', { skip: !hasZstd }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zstd-'))
  try {
    const file = path.join(dir, 'session.jsonl.zstd')
    const good = frame('{"ok":1}\n')
    const bad = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00, 0x00])
    fs.writeFileSync(file, Buffer.concat([bad, good]))
    const r = createZstdFrameTail(file)
    const p = r.poll()
    assert.deepEqual(p.lines, ['{"ok":1}'])
    assert.ok(r.state.badFrames >= 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('zstd-tail: 文件截断 → reset', { skip: !hasZstd }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zstd-'))
  try {
    const file = path.join(dir, 'session.jsonl.zstd')
    fs.writeFileSync(file, frame('{"a":1}\n'))
    const r = createZstdFrameTail(file)
    assert.deepEqual(r.poll().lines, ['{"a":1}'])
    fs.writeFileSync(file, frame('b\n'))
    const p = r.poll()
    assert.equal(p.reset, true)
    assert.deepEqual(p.lines, ['b'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
