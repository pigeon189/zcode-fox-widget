// 审查修复回归：WorkBuddy 增量索引落盘事件被截断时，重启不得静默少计。
//
// 背景：每条 transcript 的事件列表会持久化到 cache/workbuddy-index-v1.json，
// 落盘上限 4000 条。旧实现重启时直接 slice(-4000) 并恢复水位，长 transcript
// 只用最后 4000 条重建 tokens/credits（provenance 却仍是 exact）。现在落盘写
// eventsComplete，事件不完整时重启从头完整重读。
//
// paths.mjs 在模块加载时读 FOX_DOCK_DATA，所以必须在 import 之前设置环境变量。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-wb-restart-'))
process.env.FOX_DOCK_DATA = path.join(root, 'data')
process.env.FOX_DOCK_WORKBUDDY_DB = path.join(root, 'none', 'workbuddy.db')

const sessions = await import('../../adapters/workbuddy/sessions.mjs')
const { collectEvents, getSessions, readUsageRows, _resetWorkbuddyLive, _resetWorkbuddyCache, _flushWorkbuddyCache } = sessions

const CACHE_FILE = path.join(process.env.FOX_DOCK_DATA, 'cache', 'workbuddy-index-v1.json')
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0)

function writeTranscript(projectsDir, name, count) {
  const dir = path.join(projectsDir, 'proj-' + name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name + '.jsonl')
  const lines = []
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 9, 25, 0, 0, 0) + i * 1000).toISOString(),
        providerData: {
          conversationRequestId: 'r' + Math.floor(i / 3),
          model: 'wb-pro',
          rawUsage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, credit: 0.01 },
        },
      })
    )
  }
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function cacheEntry(file) {
  const payload = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
  return payload.entries['tail:' + file] && payload.entries['tail:' + file].value
}

function usageLine(i, { total = 120, credit = 0.01, rid } = {}) {
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 9, 25, 0, 0, 0) + i * 1000).toISOString(),
    providerData: {
      conversationRequestId: rid || 'r' + i,
      model: 'wb-pro',
      rawUsage: { prompt_tokens: total - 20, completion_tokens: 20, total_tokens: total, credit },
    },
  })
}

// 不自动补末尾换行：回归用例需要自己控制「半行」边界。
function writeLines(projectsDir, name, lines) {
  const dir = path.join(projectsDir, 'proj-' + name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name + '.jsonl')
  fs.writeFileSync(file, lines.join('\n'))
  return file
}

function sessionOf(items, id) {
  return items.find((s) => s.sessionId === id)
}

function cleanup() {
  _resetWorkbuddyLive()
  _resetWorkbuddyCache()
}

after(() => {
  cleanup()
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } catch (err) {}
})

test('workbuddy: >4000 事件的 transcript 重启后仍按全量重算（不少计、不标错 exact）', async () => {
  try {
    const projectsDir = path.join(root, 'projects-long')
    const file = writeTranscript(projectsDir, 'conv-long', 5000)
    _resetWorkbuddyLive()
    _resetWorkbuddyCache()

    const first = collectEvents({ projectsDir })
    assert.equal(first.ok, true)
    assert.equal(first.events.length, 5000)
    const before = sessionOf((await getSessions({ projectsDir, now: NOW, range: 'all', limit: 10 })).items, 'conv-long')
    assert.ok(before, '首次读取应能聚合出会话')
    assert.equal(before.tokens.total, 600000, '5000 × 120 tokens')
    assert.equal(before.cost.amount, 50, '5000 × 0.01 credit')
    assert.equal(before.provenance.tokens.kind, 'exact')

    // 落盘：事件超限只存尾部 4000 条，但必须标记 eventsComplete=false
    _flushWorkbuddyCache()
    const saved = cacheEntry(file)
    assert.ok(saved, '应写入缓存条目')
    assert.equal(saved.events.length, 4000, '落盘仍按体积上限截断')
    assert.equal(saved.eventsComplete, false, '截断状态必须落盘，重启才知道要重算')

    // 模拟 daemon 重启：清内存（保留磁盘缓存）后再读
    _resetWorkbuddyLive()
    _resetWorkbuddyCache()
    const restarted = collectEvents({ projectsDir })
    assert.equal(restarted.events.length, 5000, '重启后不得只剩 4000 个事件')

    const after = sessionOf((await getSessions({ projectsDir, now: NOW, range: 'all', limit: 10 })).items, 'conv-long')
    assert.equal(after.tokens.total, 600000, '重启后 tokens 不得少计')
    assert.equal(after.cost.amount, 50, '重启后 credits 不得少计')
    assert.equal(after.provenance.tokens.kind, 'exact')

    const rows = await readUsageRows({ projectsDir, now: NOW, since: 0, until: NOW + 86400000 })
    assert.equal(rows.ok, true)
    assert.equal(rows.rows.length, 5000, '用量明细也不得丢事件')
    assert.ok(Math.abs(rows.rows.reduce((s, r) => s + r.credits, 0) - 50) < 1e-6)
  } finally {
    cleanup()
  }
})

test('workbuddy: 事件未超上限时缓存完整，重启走增量续读且结果一致', async () => {
  try {
    const projectsDir = path.join(root, 'projects-small')
    const file = writeTranscript(projectsDir, 'conv-small', 100)
    _resetWorkbuddyLive()
    _resetWorkbuddyCache()
    assert.equal(collectEvents({ projectsDir }).events.length, 100)
    _flushWorkbuddyCache()
    const saved = cacheEntry(file)
    assert.equal(saved.events.length, 100)
    assert.equal(saved.eventsComplete, true, '事件完整时才能恢复水位续读')

    _resetWorkbuddyLive()
    _resetWorkbuddyCache()
    assert.equal(collectEvents({ projectsDir }).events.length, 100)
    const item = sessionOf((await getSessions({ projectsDir, now: NOW, range: 'all', limit: 10 })).items, 'conv-small')
    assert.equal(item.tokens.total, 12000)
    assert.equal(item.cost.amount, 1)
  } finally {
    cleanup()
  }
})

test('workbuddy: 落盘时尾部半行未完成，重启补换行后仍计入（不丢事件）', async () => {
  try {
    const projectsDir = path.join(root, 'projects-half')
    // a/b 两行完整，c 只写了一半（没有换行）
    const file = writeLines(projectsDir, 'conv-half', [usageLine(0), usageLine(1), usageLine(2)])
    _resetWorkbuddyLive()
    _resetWorkbuddyCache()
    assert.equal(collectEvents({ projectsDir }).events.length, 2, '半行 c 未完成前只有 2 条')

    _flushWorkbuddyCache()
    const saved = cacheEntry(file)
    assert.equal(saved.eventsComplete, true)
    assert.ok(saved.checkpoint, '水位必须带内容指纹')

    // 模拟 daemon 重启；宿主随后补上换行完成第 3 行
    _resetWorkbuddyLive()
    _resetWorkbuddyCache()
    fs.appendFileSync(file, '\n')
    const after = collectEvents({ projectsDir })
    assert.equal(after.events.length, 3, '重启后必须重新读到落盘时未完成的半行')

    const item = sessionOf((await getSessions({ projectsDir, now: NOW, range: 'all', limit: 10 })).items, 'conv-half')
    assert.equal(item.tokens.total, 360, '3 × 120 tokens，半行事件不能丢')
    assert.equal(item.cost.amount, 0.03, '3 × 0.01 credit')
  } finally {
    cleanup()
  }
})

test('workbuddy: 文件原地截断重写后重启，不拿旧水位混读新文件', async () => {
  try {
    const projectsDir = path.join(root, 'projects-trunc')
    const file = writeLines(projectsDir, 'conv-trunc', [usageLine(0), usageLine(1)])
    fs.appendFileSync(file, '\n')
    _resetWorkbuddyLive()
    _resetWorkbuddyCache()
    assert.equal(collectEvents({ projectsDir }).events.length, 2)
    _flushWorkbuddyCache()

    // 模拟文件被原地截断后重写成更长的内容（size 检查发现不了，ino 也可能不变）
    _resetWorkbuddyLive()
    _resetWorkbuddyCache()
    fs.writeFileSync(
      file,
      [
        usageLine(10, { total: 200, credit: 0.02, rid: 'n10' }),
        usageLine(11, { total: 200, credit: 0.02, rid: 'n11' }),
        usageLine(12, { total: 200, credit: 0.02, rid: 'n12' }),
      ].join('\n') + '\n'
    )
    const after = collectEvents({ projectsDir })
    assert.equal(after.events.length, 3, '必须从头读新文件，不能旧事件 + 新尾部混读')
    assert.deepEqual(
      after.events.map((e) => e.rid),
      ['n10', 'n11', 'n12']
    )
    const item = sessionOf((await getSessions({ projectsDir, now: NOW, range: 'all', limit: 10 })).items, 'conv-trunc')
    assert.equal(item.tokens.total, 600)
    assert.equal(item.cost.amount, 0.06)
  } finally {
    cleanup()
  }
})
