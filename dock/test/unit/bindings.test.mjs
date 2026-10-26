import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findBinding, MAX_BINDINGS, readBindings, removeBinding, upsertBinding, writeBindings } from '../../daemon/src/bindings.mjs'

const dirs = []
function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-bind-'))
  dirs.push(dir)
  return path.join(dir, 'bindings.json')
}

after(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch (err) {}
  }
})

const sample = (n) => ({
  key: 'c:/app/zcode.exe|' + n + '|1792320000000|1a' + n,
  adapterId: 'generic',
  window: { title: 'ZCode ' + n, pid: n, hwnd: '1a' + n, rect: { x: 0, y: 0, w: 10, h: 10 } },
})

test('bindings: 空文件/损坏文件都读成空数组', () => {
  const file = tempFile()
  assert.deepEqual(readBindings(file), [])
  fs.writeFileSync(file, '{oops')
  assert.deepEqual(readBindings(file), [])
  fs.writeFileSync(file, '[{"nokey":1}]')
  assert.deepEqual(readBindings(file), [])
})

test('bindings: upsert 按 key 去重，最新的排最前', () => {
  const file = tempFile()
  upsertBinding(file, sample(1))
  upsertBinding(file, sample(2))
  const list = readBindings(file)
  assert.equal(list.length, 2)
  assert.equal(list[0].key, sample(2).key)
  const updated = upsertBinding(file, { ...sample(1), anchor: { corner: 'bottom-left' } })
  assert.equal(updated.anchor.corner, 'bottom-left')
  const again = readBindings(file)
  assert.equal(again.length, 2)
  assert.equal(again[0].key, sample(1).key)
})

test('bindings: 超过上限只保留前 MAX_BINDINGS 条', () => {
  const file = tempFile()
  for (let i = 0; i < MAX_BINDINGS + 8; i++) upsertBinding(file, sample(i + 1))
  assert.equal(readBindings(file).length, MAX_BINDINGS)
})

test('bindings: remove 只删指定 key，找不到时报告 removed=false', () => {
  const file = tempFile()
  upsertBinding(file, sample(1))
  upsertBinding(file, sample(2))
  const r = removeBinding(file, sample(1).key)
  assert.equal(r.removed, true)
  assert.equal(r.bindings.length, 1)
  assert.equal(findBinding(file, sample(1).key), null)
  assert.equal(removeBinding(file, 'nope').removed, false)
})

test('bindings: 写入是原子替换（临时文件不残留）', () => {
  const file = tempFile()
  writeBindings(file, [sample(1)])
  const dir = path.dirname(file)
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})
