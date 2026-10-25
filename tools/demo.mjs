// 演示/人工验收：用假数据起一个挂件服务，并周期性产生"新的一轮"，
// 用于在浏览器里观察每轮消耗的红色积分气泡弹出。
// 全程使用临时 CODEBUDDY_HOME，不读写真实会话库。
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
const dataDir = path.join(tmpHome, 'plugin-data')
fs.mkdirSync(dataDir, { recursive: true })

const port = Number(process.argv[2]) || 39500 + Math.floor(Math.random() * 400)
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port }), 'utf8')

// WorkBuddy 会话库：sessions + session_usage（credit_json 记每请求积分）
const db = new DatabaseSync(path.join(tmpHome, 'workbuddy.db'), { timeout: 5000 })
db.exec(`
  CREATE TABLE sessions (
    id text primary key, cwd text, model text, title text, custom_title text,
    updated_at integer, last_activity_at integer, is_background_automation integer default 0, deleted_at integer
  );
  CREATE TABLE session_usage (
    session_id text primary key, used integer, size integer, updated_at integer, credit_json text
  );
`)
const SESSION = 'sess_demo'
const model = 'glm-5.3'
db.prepare(
  'INSERT OR REPLACE INTO sessions (id, cwd, model, title, custom_title, updated_at, last_activity_at, is_background_automation, deleted_at) VALUES (?,?,?,?,?,?,?,0,NULL)'
).run(SESSION, 'C:/work', model, '演示会话', null, Date.now(), Date.now())

const transcriptDir = path.join(tmpHome, 'projects', 'demo')
fs.mkdirSync(transcriptDir, { recursive: true })
const transcriptFile = path.join(transcriptDir, SESSION + '.jsonl')
const credits = {}

let turnSeq = 0
function insertTurn() {
  turnSeq += 1
  const turnId = 'turn_demo_' + turnSeq
  const now = Date.now()
  const prompt = 200_000 + Math.floor(Math.random() * 900_000)
  const completion = 20_000 + Math.floor(Math.random() * 120_000)
  const hit = Math.floor(Math.random() * 400_000)
  const credit = Math.round((1 + Math.random() * 30) * 100) / 100
  const line = JSON.stringify({
    timestamp: now,
    type: 'function_call',
    providerData: {
      conversationRequestId: turnId,
      model,
      requestModelId: model,
      requestModelName: 'GLM-5.3',
      rawUsage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_cache_hit_tokens: hit,
        prompt_cache_miss_tokens: prompt - hit,
        prompt_cache_write_tokens: 0,
        completion_thinking_tokens: 0,
        credit,
      },
    },
  })
  fs.appendFileSync(transcriptFile, line + '\n')
  credits[turnId] = credit
  db.prepare('INSERT OR REPLACE INTO session_usage (session_id, used, size, updated_at, credit_json) VALUES (?,?,?,?,?)').run(
    SESSION,
    50_000 + turnSeq * 1000,
    200_000,
    now,
    JSON.stringify(credits)
  )
  console.log('  + 新增一轮 ' + turnId + '：输入 ' + prompt + '（命中 ' + hit + '）、输出 ' + completion + '、积分 ' + credit)
}

insertTurn() // 历史轮次：服务启动时只会对齐，不会弹泡

const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'server.mjs')], {
  cwd: PLUGIN_ROOT,
  env: {
    ...process.env,
    CODEBUDDY_HOME: tmpHome,
    FOX_WIDGET_DATA_DIR: dataDir,
    WHALE_DISABLE_UPDATE_CHECK: '1',
  },
  stdio: 'ignore',
  detached: false,
})

console.log('🐳 演示服务已启动')
console.log('   地址: http://127.0.0.1:' + port + '/')
console.log('   临时数据目录: ' + tmpHome)
console.log('   每 15 秒插入一条新轮次，浏览器里应看到红色积分气泡\n')

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
