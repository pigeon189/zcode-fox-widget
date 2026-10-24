// M6 增量索引持久化：版本失配丢弃 / 原子+去抖 / 8MB LRU / 删缓存结果不变
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCacheIndex } from '../../shared/cache-index.mjs'
import { createTailReader } from '../../shared/tail.mjs'

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fox-cache-')), name)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('cache-index: set → 去抖落盘 → 重新加载可读', async () => {
  const file = tmpFile('idx.json')
  const a = createCacheIndex({ file, appVersion: '1.0.0', debounceMs: 50 })
  a.set('k1', { offset: 123, events: [1, 2] })
  a.flushSync()
  const b = createCacheIndex({ file, appVersion: '1.0.0' })
  assert.deepEqual(b.get('k1'), { offset: 123, events: [1, 2] })
})

test('cache-index: appVersion / schemaVersion 不符 → 丢弃重建', () => {
  const file = tmpFile('idx-ver.json')
  const a = createCacheIndex({ file, appVersion: '1.0.0', debounceMs: 10 })
  a.set('k', { x: 1 })
  a.flushSync()
  const b = createCacheIndex({ file, appVersion: '2.0.0' })
  assert.equal(b.get('k'), null)
  assert.ok(b.discardedCount >= 1)
  // 版本匹配的可继续
  const c = createCacheIndex({ file, appVersion: '1.0.0' })
  assert.deepEqual(c.get('k'), { x: 1 })
})

test('cache-index: 坏 JSON / 超大文件 → 丢弃不崩', () => {
  const bad = tmpFile('bad.json')
  fs.writeFileSync(bad, '{not json')
  const a = createCacheIndex({ file: bad, appVersion: '1' })
  assert.equal(a.size, 0)
  const big = tmpFile('big.json')
  fs.writeFileSync(big, JSON.stringify({ schemaVersion: 1, appVersion: '1', entries: { x: { value: 'y'.repeat(9 * 1024 * 1024), at: 1 } } }))
  const b = createCacheIndex({ file: big, appVersion: '1' })
  assert.equal(b.size, 0)
})

test('cache-index: LRU 淘汰——超出 8MB 按最久未用删', () => {
  const file = tmpFile('lru.json')
  const a = createCacheIndex({ file, appVersion: '1', maxBytes: 8192, debounceMs: 5 })
  a.set('old', { blob: 'x'.repeat(3000) })
  a.set('new', { blob: 'y'.repeat(3000) })
  a.get('new') // 触摸 new
  a.set('newer', { blob: 'z'.repeat(3000) })
  a.flushSync()
  assert.equal(a.get('old'), null, '最久未用应被淘汰')
  assert.ok(a.get('new') !== null)
  assert.ok(a.get('newer') !== null)
})

test('cache-index: 原子写——落盘文件无 .tmp 残留', async () => {
  const file = tmpFile('atomic.json')
  const a = createCacheIndex({ file, appVersion: '1', debounceMs: 30 })
  a.set('k', 1)
  a.schedule()
  await sleep(500)
  assert.ok(fs.existsSync(file))
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))
  assert.equal(leftovers.length, 0)
})

test('tail: restore 恢复水位后增量续读（非法输入从头）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-tail-'))
  const file = path.join(dir, 't.jsonl')
  fs.writeFileSync(file, '{"a":1}\n{"a":2}\n')
  const t = createTailReader(file)
  const first = t.poll()
  assert.equal(first.lines.length, 2)
  const st = t.state
  // 模拟重启：新 reader 恢复水位
  const t2 = createTailReader(file)
  t2.restore({ offset: st.offset, ino: st.ino })
  fs.appendFileSync(file, '{"a":3}\n')
  assert.deepEqual(t2.poll().lines.map((l) => JSON.parse(l).a), [3])
  // 非法恢复值 → 从头读
  const t3 = createTailReader(file)
  t3.restore({ offset: -5 })
  assert.equal(t3.poll().lines.length, 3)
  const t4 = createTailReader(file)
  t4.restore({ offset: 999999 })
  assert.equal(t4.poll().lines.length, 3, 'offset 越界由 poll 的 size<offset 分支兜底')
})

test('workbuddy: 删除缓存后 collectEvents 结果不变（等价性守卫）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-wb-cache-'))
  process.env.FOX_DOCK_DATA = path.join(tmp, 'data')
  process.env.FOX_DOCK_WORKBUDDY_PROJECTS = path.join(tmp, 'projects')
  const { collectEvents, _resetWorkbuddyLive, _resetWorkbuddyCache } = await import('../../adapters/workbuddy/sessions.mjs')
  const projectsDir = process.env.FOX_DOCK_WORKBUDDY_PROJECTS
  fs.mkdirSync(path.join(projectsDir, 'proj-a'), { recursive: true })
  const transcript = path.join(projectsDir, 'proj-a', 'conv-1.jsonl')
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ timestamp: '2026-10-25T00:00:00.001Z', type: 'function_call', callId: 'c1', name: 'Bash', cwd: 'D:\\p' }),
      JSON.stringify({ timestamp: '2026-10-25T00:00:01.000Z', type: 'function_call_result', callId: 'c1', status: 'completed' }),
    ].join('\n') + '\n'
  )

  // 第一遍：写缓存
  _resetWorkbuddyLive()
  _resetWorkbuddyCache()
  const withCache = collectEvents({ projectsDir })
  assert.ok(withCache.ok && withCache.events.length >= 2, JSON.stringify(withCache).slice(0, 120))

  // 模拟重启：清内存 tails，保留磁盘缓存 → 结果一致
  _resetWorkbuddyLive()
  const restored = collectEvents({ projectsDir })
  assert.deepEqual(restored.events, withCache.events, '重启后用水位续读不得丢事件')

  // 删除缓存：全量重算 → 结果仍一致
  _resetWorkbuddyLive()
  _resetWorkbuddyCache()
  const cacheFile = path.join(process.env.FOX_DOCK_DATA, 'cache', 'workbuddy-index-v1.json')
  fs.rmSync(cacheFile, { force: true })
  const rebuilt = collectEvents({ projectsDir })
  assert.deepEqual(rebuilt.events, withCache.events, '删除缓存后必须与带缓存结果逐字段一致')
  delete process.env.FOX_DOCK_WORKBUDDY_PROJECTS
})
