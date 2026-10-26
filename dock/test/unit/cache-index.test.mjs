// M6 增量索引持久化：版本失配丢弃 / 原子+去抖 / 8MB LRU / 删缓存结果不变
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCacheIndex } from '../../shared/cache-index.mjs'
import { createTailReader } from '../../shared/tail.mjs'

const dirs = []
const instances = []
function newIndex(opts) {
  const idx = createCacheIndex(opts)
  instances.push(idx)
  return idx
}
function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-cache-'))
  dirs.push(dir)
  return path.join(dir, name)
}

function cleanupDirs() {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch (err) {}
  }
}

after(async () => {
  // 先去抖定时器（reset 会 clearTimeout），再等一拍让已排队的写盘结束，
  // 最后删目录；进程退出前再兜一次。
  for (const idx of instances) {
    try {
      idx.reset()
    } catch (err) {}
  }
  await sleep(600)
  cleanupDirs()
  await sleep(150)
  cleanupDirs()
})

// 进程退出前再清一次：兜住 after 之后、退出之前才触发的去抖写盘。
process.on('exit', cleanupDirs)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('cache-index: set → 去抖落盘 → 重新加载可读', async () => {
  const file = tmpFile('idx.json')
  const a = newIndex({ file, appVersion: '1.0.0', debounceMs: 50 })
  a.set('k1', { offset: 123, events: [1, 2] })
  a.flushSync()
  const b = newIndex({ file, appVersion: '1.0.0' })
  assert.deepEqual(b.get('k1'), { offset: 123, events: [1, 2] })
})

test('cache-index: appVersion / schemaVersion 不符 → 丢弃重建', () => {
  const file = tmpFile('idx-ver.json')
  const a = newIndex({ file, appVersion: '1.0.0', debounceMs: 10 })
  a.set('k', { x: 1 })
  a.flushSync()
  const b = newIndex({ file, appVersion: '2.0.0' })
  assert.equal(b.get('k'), null)
  assert.ok(b.discardedCount >= 1)
  // 版本匹配的可继续
  const c = newIndex({ file, appVersion: '1.0.0' })
  assert.deepEqual(c.get('k'), { x: 1 })
})

test('cache-index: 坏 JSON / 超大文件 → 丢弃不崩', () => {
  const bad = tmpFile('bad.json')
  fs.writeFileSync(bad, '{not json')
  const a = newIndex({ file: bad, appVersion: '1' })
  assert.equal(a.size, 0)
  const big = tmpFile('big.json')
  fs.writeFileSync(big, JSON.stringify({ schemaVersion: 1, appVersion: '1', entries: { x: { value: 'y'.repeat(9 * 1024 * 1024), at: 1 } } }))
  const b = newIndex({ file: big, appVersion: '1' })
  assert.equal(b.size, 0)
})

test('cache-index: LRU 淘汰——超出 8MB 按最久未用删', () => {
  const file = tmpFile('lru.json')
  const a = newIndex({ file, appVersion: '1', maxBytes: 8192, debounceMs: 5 })
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
  const a = newIndex({ file, appVersion: '1', debounceMs: 30 })
  a.set('k', 1)
  a.schedule()
  await sleep(500)
  assert.ok(fs.existsSync(file))
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))
  assert.equal(leftovers.length, 0)
})

test('tail: restore 恢复水位后增量续读（非法输入从头）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-tail-'))
  dirs.push(dir)
  const file = path.join(dir, 't.jsonl')
  fs.writeFileSync(file, '{"a":1}\n{"a":2}\n')
  const t = createTailReader(file)
  const first = t.poll()
  assert.equal(first.lines.length, 2)
  const st = t.state
  // 模拟重启：新 reader 恢复水位（offset + ino + 内容指纹）
  const t2 = createTailReader(file)
  assert.equal(t2.restore(st), true)
  fs.appendFileSync(file, '{"a":3}\n')
  assert.deepEqual(t2.poll().lines.map((l) => JSON.parse(l).a), [3])
  // 非法恢复值 → 从头读
  const t3 = createTailReader(file)
  assert.equal(t3.restore({ offset: -5 }), false)
  assert.equal(t3.poll().lines.length, 3)
  const t4 = createTailReader(file)
  assert.equal(t4.restore({ offset: 999999 }), false)
  assert.equal(t4.poll().lines.length, 3, 'offset 越界必须拒绝水位、从头读')
})

test('tail: 半行不写进 state.offset（重启后重新消费而不是永久丢弃）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-tail-'))
  const file = path.join(dir, 't.jsonl')
  try {
    fs.writeFileSync(file, 'a\nb')
    const t = createTailReader(file)
    assert.deepEqual(t.poll().lines, ['a'])
    const st = t.state
    assert.equal(st.offset, 2, '水位停在最后一个完整行之后，不含半行 "b"')
    assert.ok(st.readOffset > st.offset, '内部已读位置仍越过半行')
    // 重启：恢复后应重新读到半行，补 '\n' 后得到 b
    const t2 = createTailReader(file)
    assert.equal(t2.restore(st), true)
    fs.appendFileSync(file, '\n')
    assert.deepEqual(t2.poll().lines, ['b'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tail: 原地截断后重写到更大长度 → 内容指纹不符，拒绝沿用旧水位', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-tail-'))
  const file = path.join(dir, 't.jsonl')
  try {
    fs.writeFileSync(file, 'aaa\nbbb\n')
    const t = createTailReader(file)
    assert.deepEqual(t.poll().lines, ['aaa', 'bbb'])
    const st = t.state
    // 截断后重写：文件比旧 offset 更大，size 检查发现不了
    fs.writeFileSync(file, 'x'.repeat(32) + '\n')
    const t2 = createTailReader(file)
    assert.equal(t2.restore(st), false, '内容指纹不符必须拒绝水位')
    assert.deepEqual(t2.poll().lines, ['x'.repeat(32)], '从头读新文件，不能混入旧水位之后的内容')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cache-index: 写盘失败（目标路径是目录）不抛异常，保留 dirty 等下次重试', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-cache-'))
  dirs.push(root)
  const target = path.join(root, 'idx.json')
  fs.mkdirSync(target, { recursive: true }) // 让 rename 必然失败
  try {
    const a = newIndex({ file: target, appVersion: '1', debounceMs: 10 })
    a.set('k', 1)
    assert.doesNotThrow(() => a.flushSync(), '同步落盘失败不得抛到调用方')
    a.schedule()
    await sleep(400) // 去抖定时器里的失败也不能变成未捕获异常
    assert.doesNotThrow(() => a.flushSync())
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

test('workbuddy: 删除缓存后 collectEvents 结果不变（等价性守卫）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-wb-cache-'))
  dirs.push(tmp)
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
  // 清掉模块内可能还挂着的去抖定时器，避免 after 清理后又落盘重建目录。
  _resetWorkbuddyCache()
  _resetWorkbuddyLive()
  delete process.env.FOX_DOCK_WORKBUDDY_PROJECTS
})
