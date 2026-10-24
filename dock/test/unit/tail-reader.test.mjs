// D034 增量读取：半行 / CRLF / 截断 / 分片 / UTF-8 / 超长行
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTailReader } from '../../shared/tail.mjs'

function tempFile(name = 'a.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-tail-'))
  return { dir, file: path.join(dir, name) }
}

test('tail: 只消费完整行，残行留到下次', () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, 'a\nb')
    const r = createTailReader(file)
    assert.deepEqual(r.poll().lines, ['a'])
    fs.appendFileSync(file, '\n')
    assert.deepEqual(r.poll().lines, ['b'])
    assert.deepEqual(r.poll().lines, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tail: 容忍 CRLF 与空行', () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, 'a\r\n\r\nb\r\n')
    const r = createTailReader(file)
    assert.deepEqual(r.poll().lines, ['a', 'b'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tail: 文件截断/重建 → reset 并从头读', () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, 'a\nb\n')
    const r = createTailReader(file)
    assert.deepEqual(r.poll().lines, ['a', 'b'])
    fs.writeFileSync(file, 'x\n')
    const p = r.poll()
    assert.equal(p.reset, true)
    assert.deepEqual(p.lines, ['x'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tail: maxChunk 分片多轮读完', () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, 'aaaa\nbbbb\ncccc\n')
    const r = createTailReader(file, { maxChunk: 5 })
    const out = []
    for (let i = 0; i < 10; i++) out.push(...r.poll().lines)
    assert.deepEqual(out, ['aaaa', 'bbbb', 'cccc'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tail: 空文件 / 不存在文件', () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, '')
    const r = createTailReader(file)
    assert.deepEqual(r.poll(), { ok: true, lines: [], reset: false })
    const missing = createTailReader(path.join(dir, 'nope'))
    const p = missing.poll()
    assert.equal(p.ok, false)
    assert.equal(p.reason, 'missing')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tail: UTF-8 多字节跨分片边界不损坏', () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, '中文\n测试\n')
    const r = createTailReader(file, { maxChunk: 4 })
    const out = []
    for (let i = 0; i < 10; i++) out.push(...r.poll().lines)
    assert.deepEqual(out, ['中文', '测试'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tail: 超长单行（>1MB）被丢弃并计数，不撑爆内存', () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, 'x'.repeat((1 << 20) + 10))
    const r = createTailReader(file)
    assert.deepEqual(r.poll().lines, [])
    fs.appendFileSync(file, '\nok\n')
    assert.deepEqual(r.poll().lines, ['ok'])
    assert.equal(r.state.droppedLongLines >= 1, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
