// 演示/人工验收：用假数据起一个挂件服务，并周期性产生"新的一轮"，
// 用于在浏览器里观察每轮消耗的红色金额气泡弹出。
// 全程使用临时 ZCODE_HOME，不读写真实会话库。
//
//   node tools/demo.mjs            # 随机端口
//   node tools/demo.mjs 39999      # 指定端口
//
// 打开打印出的地址即可；每 15 秒会插入一条已完成轮次。Ctrl+C 退出并清理。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-demo-'))
const dbDir = path.join(tmpHome, 'cli', 'db')
const dataDir = path.join(tmpHome, 'whale')
fs.mkdirSync(dbDir, { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })

const port = Number(process.argv[2]) || 39500 + Math.floor(Math.random() * 400)
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port }), 'utf8')

const db = new DatabaseSync(path.join(dbDir, 'db.sqlite'))
db.exec(`
  CREATE TABLE turn_usage (
    session_id text not null,
    turn_id text not null,
    status text not null,
    started_at integer not null,
    completed_at integer,
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    reasoning_tokens integer not null default 0,
    cache_creation_input_tokens integer not null default 0,
    cache_read_input_tokens integer not null default 0,
    primary key(session_id, turn_id)
  );
  CREATE TABLE model_usage (
    id text primary key,
    session_id text not null,
    turn_id text,
    model_id text not null,
    started_at integer not null,
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    reasoning_tokens integer not null default 0,
    cache_creation_input_tokens integer not null default 0,
    cache_read_input_tokens integer not null default 0,
    computed_total_tokens integer not null default 0
  );
`)

const MODEL = 'deepseek-flash'
let turnSeq = 0
function insertTurn() {
  turnSeq += 1
  const turnId = 'turn_demo_' + turnSeq
  const now = Date.now()
  const usage = {
    input: 200_000 + Math.floor(Math.random() * 900_000),
    output: 20_000 + Math.floor(Math.random() * 120_000),
    cacheRead: Math.floor(Math.random() * 400_000),
  }
  db.prepare(
    `INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at,
      input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens)
     VALUES ('sess_demo', ?, 'completed', ?, ?, ?, ?, 0, 0, ?)`
  ).run(turnId, now - 3000, now, usage.input, usage.output, usage.cacheRead)
  db.prepare(
    `INSERT INTO model_usage (id, session_id, turn_id, model_id, started_at,
      input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).run(
    'mu-' + turnId,
    'sess_demo',
    turnId,
    MODEL,
    now - 3000,
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.input + usage.cacheRead + usage.output
  )
  console.log('  + 新增一轮 ' + turnId + '：输入 ' + usage.input + '、缓存读 ' + usage.cacheRead + '、输出 ' + usage.output)
}

insertTurn() // 历史轮次：服务启动时只会对齐，不会弹泡

const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'server.mjs')], {
  cwd: PLUGIN_ROOT,
  env: { ...process.env, ZCODE_HOME: tmpHome },
  stdio: 'ignore',
  detached: false,
})

console.log('🐳 演示服务已启动')
console.log('   地址: http://127.0.0.1:' + port + '/')
console.log('   临时数据目录: ' + tmpHome)
console.log('   每 15 秒插入一条新轮次，浏览器里应看到红色金额气泡\n')

const timer = setInterval(insertTurn, 15000)

function cleanup() {
  clearInterval(timer)
  try {
    child.kill()
  } catch (err) {}
  try {
    db.close()
  } catch (err) {}
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    console.log('\n已清理临时数据目录')
  } catch (err) {}
  process.exit(0)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
