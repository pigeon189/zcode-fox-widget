// 计费链路（R5/R6/R7）：真 HTTP + 合成数据源
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessAlive, readLock } from '../../daemon/src/lock.mjs'
import { costOfUsage } from '../../adapters/zcode/pricing.mjs'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(HERE, '..', '..', 'daemon', 'src', 'daemon.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-billing-'))
const dataDir = path.join(root, 'data')
const zcodeDb = path.join(root, 'zcode', 'db.sqlite')
const wbProjects = path.join(root, 'wb', 'projects')

// 固定落在「本地今天」内：凌晨 0–1 点跑测试时，now-1h 已经是昨天，
// 会让「今日合计」断言读成 0（假失败）。取一小时前，但不早于今天零点后 1 秒。
const NOW0 = Date.now()
const DAY0 = new Date(NOW0)
DAY0.setHours(0, 0, 0, 0)
const ROW_TS = Math.min(NOW0 - 1000, Math.max(DAY0.getTime() + 1000, NOW0 - 60 * 60_000))
const ZC_IN = 1_000_000
const ZC_OUT = 1_000_000

function buildZcodeDb() {
  fs.mkdirSync(path.dirname(zcodeDb), { recursive: true })
  const db = new DatabaseSync(zcodeDb)
  db.exec(`
    CREATE TABLE model_usage (
      id TEXT, session_id TEXT, turn_id TEXT, provider_id TEXT, model_id TEXT, status TEXT,
      started_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, computed_total_tokens INTEGER
    );
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
  `)
  db.prepare(
    `INSERT INTO model_usage VALUES ('m1','s1','t1','deepseek','deepseek-flash','completed',?,?,?,0,0,0,?)`
  ).run(ROW_TS, ZC_IN, ZC_OUT, ZC_IN + ZC_OUT)
  db.prepare(`INSERT INTO turn_usage VALUES ('s1','t1','completed',?,?)`).run(ROW_TS, ROW_TS + 5000)
  db.close()
}

function buildWbProjects() {
  const dir = path.join(wbProjects, 'proj-a')
  fs.mkdirSync(dir, { recursive: true })
  const ev = (ts, rid, credit) =>
    JSON.stringify({ timestamp: ts, providerData: { conversationRequestId: rid, rawUsage: { credit, prompt_tokens: 100, completion_tokens: 10 } } })
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [ev(ROW_TS, 'r1', 2), ev(ROW_TS + 1000, 'r1', 1.5)].join('\n') + '\n')
}

let daemon = null
let port = 0
let token = ''

const get = async (p) => {
  const res = await fetch('http://127.0.0.1:' + port + p)
  return { status: res.status, body: await res.json() }
}
const post = async (p, body) => {
  const res = await fetch('http://127.0.0.1:' + port + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}
const bind = async (win) => {
  const r = await post('/bind', win)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const b = await get('/billing?key=' + encodeURIComponent(r.body.binding.key))
  assert.equal(b.status, 200, JSON.stringify(b.body))
  return b.body.snapshot
}

before(async () => {
  buildZcodeDb()
  buildWbProjects()
  daemon = spawn(process.execPath, [DAEMON, '--data-dir', dataDir, '--port', '0'], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, FOX_DOCK_ZCODE_DB: zcodeDb, FOX_DOCK_WORKBUDDY_PROJECTS: wbProjects },
  })
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const lock = readLock(path.join(dataDir, 'daemon.lock'))
    if (lock && lock.port && isProcessAlive(lock.pid)) {
      try {
        const h = await (await fetch('http://127.0.0.1:' + lock.port + '/health', { signal: AbortSignal.timeout(800) })).json()
        if (h && h.ok) {
          port = lock.port
          token = lock.token
          break
        }
      } catch (err) {}
    }
    await sleep(150)
  }
  assert.ok(port, 'daemon did not become healthy')
})

after(async () => {
  try {
    await fetch('http://127.0.0.1:' + port + '/shutdown', { method: 'POST', headers: { 'x-fox-token': token } })
  } catch (err) {}
  try {
    daemon.kill()
  } catch (err) {}
  await sleep(200)
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch (err) {}
})

test('billing: ZCode 窗口 → 元口径，金额与直接计价一致', async () => {
  const snap = await bind({
    exe: 'C:\\Apps\\ZCode\\ZCode.exe',
    pid: 1111,
    startMs: 1700000000000,
    hwnd: 'aa01',
    title: 'ZCode',
  })
  const expected = costOfUsage(
    'deepseek-flash',
    {
      input_tokens: ZC_IN,
      output_tokens: ZC_OUT,
      reasoning_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      computed_total_tokens: ZC_IN + ZC_OUT,
    },
    ROW_TS,
    'deepseek'
  )
  assert.equal(snap.adapterId, 'zcode')
  assert.equal(snap.supported, true)
  assert.equal(snap.ok, true)
  assert.equal(snap.unit, 'money')
  assert.ok(Math.abs(snap.today.amount - expected.amount) < 1e-6, JSON.stringify({ got: snap.today, expected }))
  assert.equal(snap.today.currency, 'CNY')
})

test('billing: WorkBuddy 窗口 → 积分口径（整轮归并）', async () => {
  const snap = await bind({
    exe: 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    pid: 2222,
    startMs: 1700000001000,
    hwnd: 'aa02',
    title: 'WorkBuddy',
  })
  assert.equal(snap.adapterId, 'workbuddy')
  assert.equal(snap.unit, 'credit')
  assert.equal(snap.today.amount, 3.5)
  assert.equal(snap.today.currency, 'CREDIT')
  assert.equal(snap.turn.amount, 3.5)
})

test('billing: 未接入窗口 → supported:false', async () => {
  const snap = await bind({
    exe: 'C:\\Windows\\notepad.exe',
    pid: 3333,
    startMs: 1700000002000,
    hwnd: 'aa03',
    title: '无标题',
  })
  assert.equal(snap.adapterId, 'generic')
  assert.equal(snap.supported, false)
  assert.equal(snap.today, null)
})

test('summary: 元与积分分开汇总，累计值不重复相加', async () => {
  // 再取一次 ZCode 的计费（模拟轮询），账本必须是覆盖而不是累加
  const list = await get('/bindings')
  const zc = list.body.bindings.find((b) => b.adapterId === 'zcode')
  await get('/billing?key=' + encodeURIComponent(zc.key))
  await get('/billing?key=' + encodeURIComponent(zc.key))

  const s = await get('/summary')
  assert.equal(s.status, 200)
  assert.equal(s.body.ok, true)
  const groups = s.body.today.groups
  const money = groups.find((g) => g.unit === 'money' && g.currency === 'CNY')
  const credit = groups.find((g) => g.unit === 'credit' && g.currency === 'CREDIT')
  assert.ok(money && credit, JSON.stringify(groups))
  assert.equal(money.adapters.length, 1)
  assert.equal(credit.amount, 3.5)
  // generic 不进账本
  assert.equal(groups.length, 2)

  const week = await get('/summary?days=7')
  assert.ok(week.body.days.length >= 1)
  assert.equal(week.body.days[week.body.days.length - 1].date, s.body.today.date)
})
