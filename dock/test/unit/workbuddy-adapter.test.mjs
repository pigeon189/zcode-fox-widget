// WorkBuddy 适配器（R6）：合成 transcript 验证积分聚合
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseTranscript,
  readCreditUsage,
  startOfLocalDay,
  _clearCache,
} from '../../adapters/workbuddy/transcripts.mjs'
import { workbuddyAdapter } from '../../adapters/workbuddy/index.mjs'
import { resolveAdapter } from '../../adapters/registry.mjs'
import { createBillingService } from '../../daemon/src/billing.mjs'

const DAY_START = startOfLocalDay(Date.now())
const NOW = DAY_START + 12 * 3600_000
const T1 = DAY_START + 1 * 3600_000
const T2 = DAY_START + 2 * 3600_000
const T3 = DAY_START + 3 * 3600_000

function ev(ts, rid, credit, prompt = 100, completion = 20) {
  return JSON.stringify({
    timestamp: ts,
    providerData: { conversationRequestId: rid, rawUsage: { credit, prompt_tokens: prompt, completion_tokens: completion } },
  })
}

function makeProjects(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-wb-'))
  for (const [rel, lines] of Object.entries(files)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, lines.join('\n') + '\n')
    // 让文件「今天动过」，否则 mtime 过滤会跳过
    const t = new Date(DAY_START + 11 * 3600_000)
    fs.utimesSync(p, t, t)
  }
  _clearCache()
  return root
}

function cleanup(root) {
  _clearCache()
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch (err) {}
}

test('workbuddy: 今日积分 = 当天所有事件的 credit 之和', () => {
  const root = makeProjects({
    'proj-a/s1.jsonl': [ev(T1, 'r1', 0.5), ev(T2, 'r2', 1.25), ev(T2, 'r2', 0.25)],
    'proj-b/s2.jsonl': [ev(T3, 'r3', 2)],
  })
  try {
    const r = readCreditUsage({ projectsDir: root, now: NOW })
    assert.equal(r.ok, true)
    assert.equal(r.today.credits, 4)
    assert.equal(r.today.events, 4)
    assert.equal(r.today.tokens, 4 * 120)
  } finally {
    cleanup(root)
  }
})

test('workbuddy: 上一轮按 requestId 归并（不是最后一次调用的零头）', () => {
  const root = makeProjects({
    'p/s1.jsonl': [ev(T1, 'r1', 0.5), ev(T2, 'r2', 0.4), ev(T3, 'r2', 0.6)],
  })
  try {
    const r = readCreditUsage({ projectsDir: root, now: NOW })
    assert.equal(r.ok, true)
    assert.equal(r.lastTurn.rid, 'r2')
    assert.equal(r.lastTurn.calls, 2)
    assert.ok(Math.abs(r.lastTurn.credits - 1) < 1e-9)
    // 轮的时间戳 = 首个事件（与宿主口径一致，见 groupTurns 的注释）
    assert.equal(r.lastTurn.at, T2)
  } finally {
    cleanup(root)
  }
})

test('workbuddy: 跨午夜的轮整轮归到开始那天（与宿主口径一致）', () => {
  const lateYesterday = DAY_START - 30 * 60_000
  const earlyToday = DAY_START + 10 * 60_000
  const root = makeProjects({
    'p/s1.jsonl': [ev(lateYesterday, 'rx', 0.7), ev(earlyToday, 'rx', 0.3), ev(T1, 'ry', 1)],
  })
  try {
    const r = readCreditUsage({ projectsDir: root, now: NOW })
    assert.equal(r.ok, true)
    // rx 整轮（1.0）归昨天，今天只剩 ry
    assert.equal(r.today.credits, 1)
    assert.equal(r.today.events, 1, 'events 只统计归属今天的轮里的调用')
  } finally {
    cleanup(root)
  }
})

test('workbuddy: 昨天的事件不计入今日，但文件仍会被扫到', () => {
  const root = makeProjects({
    'p/s1.jsonl': [ev(DAY_START - 60_000, 'r0', 9), ev(T1, 'r1', 1)],
  })
  try {
    const r = readCreditUsage({ projectsDir: root, now: NOW })
    assert.equal(r.today.credits, 1)
    assert.equal(r.today.events, 1)
  } finally {
    cleanup(root)
  }
})

test('workbuddy: 坏行（截断的半行 / 非 JSON）被跳过，不中断整份解析', () => {
  const root = makeProjects({
    'p/s1.jsonl': ['{"timestamp":', 'not json at all', ev(T1, 'r1', 0.75), ev(T2, 'r2', 0.25)],
  })
  try {
    const r = readCreditUsage({ projectsDir: root, now: NOW })
    assert.equal(r.ok, true)
    assert.equal(r.today.credits, 1)
  } finally {
    cleanup(root)
  }
})

test('workbuddy: 会话目录不存在 → projects-missing（不是 0 积分）', () => {
  const missing = path.join(os.tmpdir(), 'fox-wb-nope-' + Date.now())
  const r = readCreditUsage({ projectsDir: missing, now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'projects-missing')
})

test('workbuddy: parseTranscript 尾部截断时如实标记', () => {
  const root = makeProjects({
    'p/s1.jsonl': [ev(T1, 'r1', 0.5), ev(T2, 'r2', 0.5)],
  })
  try {
    const file = path.join(root, 'p', 's1.jsonl')
    const full = parseTranscript(file, 10 * 1024 * 1024)
    assert.equal(full.credits.length, 2)
    assert.equal(full.truncated, false)
    _clearCache()
    const tiny = parseTranscript(file, 120)
    assert.equal(tiny.truncated, true)
  } finally {
    cleanup(root)
  }
})

test('workbuddy: 适配器输出 credit 口径，不折成金额', async () => {
  const root = makeProjects({ 'p/s1.jsonl': [ev(T1, 'r1', 1.5)] })
  const prev = process.env.FOX_DOCK_WORKBUDDY_PROJECTS
  process.env.FOX_DOCK_WORKBUDDY_PROJECTS = root
  try {
    const svc = createBillingService({ adapters: [workbuddyAdapter] })
    const snap = await svc.snapshot({ exe: 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe', title: 'WorkBuddy' })
    assert.equal(snap.adapterId, 'workbuddy')
    assert.equal(snap.supported, true)
    assert.equal(snap.unit, 'credit')
    assert.equal(snap.today.amount, 1.5)
    assert.equal(snap.today.currency, 'CREDIT')
    assert.equal(snap.turn.amount, 1.5)
  } finally {
    if (prev === undefined) delete process.env.FOX_DOCK_WORKBUDDY_PROJECTS
    else process.env.FOX_DOCK_WORKBUDDY_PROJECTS = prev
    cleanup(root)
  }
})

test('workbuddy: 窗口识别只认 WorkBuddy.exe，不误伤浮层', () => {
  assert.equal(
    resolveAdapter({ exe: 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe', title: 'WorkBuddy' }, [workbuddyAdapter]).id,
    'workbuddy'
  )
  assert.equal(resolveAdapter({ exe: 'C:\\x\\electron.exe', title: 'WorkBuddy狐娘小挂件' }, [workbuddyAdapter]).id, 'generic')
})
