// 自检：在不触碰用户真实数据的前提下，端到端验证「每轮对话消耗」链路。
//
// 做法是把 ZCODE_HOME 指向一个临时目录，在里面伪造一个最小化的 ZCode 会话库
// （turn_usage / model_usage 两张表），再拉起一个挂件服务实例，然后插入一条新的
// 已完成轮次，观察 /whale/last-turn.json 的 seq 是否从 0 递增到 1 且金额与定价
// 换算一致。顺带验证 health 接口与令牌关闭。
//
//   node tools/selftest.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { costOfUsage, priceFor, isPeakTime, resolveVendor, resolvePricing } from '../lib/pricing.mjs'
import { shapePlanPayload, normalizeModelKey } from '../lib/plan-balance.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-selftest-'))
const dbDir = path.join(tmpHome, 'cli', 'db')
const dataDir = path.join(tmpHome, 'whale')
fs.mkdirSync(dbDir, { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })

// Plan 配额日志的 fixture：写进 tmpHome/.zcode/v2/logs/<今天>.log，
// 服务进程以 ZCODE_DATA_BASE_DIR=tmpHome 启动，plan-balance 会优先读这里。
// 形状对齐真实日志：顶层 balances 是摘要（无 capabilities），模型映射在
// plans[].entitlements[].capabilities 里；另放一条带内联 capabilities 的桶测兜底路径。
const PLAN_FIXTURE = {
  balanceCount: 3,
  balances: [
    {
      entitlement_id: 'ent-flash',
      show_name: 'GLM-5.3-Flash',
      total_units: 100_000_000,
      used_units: 10_000_000,
      remaining_units: 90_000_000,
      available_units: 90_000_000,
      reserved_units: null,
    },
    {
      entitlement_id: 'ent-5p3',
      show_name: 'GLM-5.3',
      total_units: 3_000_000,
      used_units: 0,
      remaining_units: 3_000_000,
      available_units: 3_000_000,
      reserved_units: null,
    },
    {
      // 测试「balances 内联 capabilities」的兜底路径（部分版本可能带）
      entitlement_id: 'ent-extra',
      show_name: 'GLM-4.7-Flash',
      total_units: 1_000_000,
      used_units: 1_000_000,
      remaining_units: 0,
      available_units: 0,
      reserved_units: null,
      capabilities: ['model:glm-4.7-flash'],
    },
  ],
  code: 0,
  msg: '',
  payload: {
    code: 0,
    msg: '',
    data: {
      server_time: Math.floor(Date.now() / 1000),
      plans: [
        {
          plan_id: 'plan-fixture',
          name: 'ZCode Start',
          status: 'active',
          starts_at: Math.floor(Date.now() / 1000) - 86400,
          ends_at: Math.floor(Date.now() / 1000) + 86400,
          entitlements: [
            {
              entitlement_id: 'ent-flash',
              show_name: 'GLM-5.3-Flash',
              meter: 'model_usage',
              unit_type: 'token',
              capabilities: ['model:glm-5.3-flash'],
              grant_units: 100_000_000,
              period: 'one_time',
            },
            {
              entitlement_id: 'ent-5p3',
              show_name: 'GLM-5.3',
              meter: 'model_usage',
              unit_type: 'token',
              capabilities: ['model:glm-5.3'],
              grant_units: 3_000_000,
              period: 'one_time',
            },
          ],
        },
      ],
      balances: [],
    },
  },
}
const planLogDir = path.join(tmpHome, '.zcode', 'v2', 'logs')
fs.mkdirSync(planLogDir, { recursive: true })
const planLogLine =
  '[2026-09-29 08:42:27.092] [info] [pid:1] [main] [host-log] (local-1) [host] [2026-09-29 08:42:27.091] [pid:2] [usage-stats] billing/balance 请求完成 ' +
  JSON.stringify(PLAN_FIXTURE) +
  '\n'
fs.writeFileSync(path.join(planLogDir, todayKeyForLog() + '.log'), planLogLine, 'utf8')

function todayKeyForLog(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

const PORT = 39100 + Math.floor(Math.random() * 500)
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: PORT }), 'utf8')

const dbFile = path.join(dbDir, 'db.sqlite')
const db = new DatabaseSync(dbFile)
db.exec(`
  CREATE TABLE turn_usage (
    session_id text not null,
    turn_id text not null,
    status text not null check(status in ('running','completed','error','cancelled')),
    started_at integer not null,
    completed_at integer,
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    reasoning_tokens integer not null default 0,
    cache_creation_input_tokens integer not null default 0,
    cache_read_input_tokens integer not null default 0,
    computed_total_tokens integer not null default 0,
    primary key(session_id, turn_id)
  );
  CREATE TABLE model_usage (
    id text primary key,
    session_id text not null,
    turn_id text,
    model_id text not null,
    provider_id text not null default '',
    status text not null default 'completed',
    attempt_index integer not null default 0,
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
const USAGE_B = {
  input_tokens: 1_000_000,
  output_tokens: 100_000,
  reasoning_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

let muSeq = 0
// modelRows: [{ model, providerId, usage }]；缺省为单行 DeepSeek，与旧版单模型轮次一致
function insertTurn(sessionId, turnId, usage, atMs, modelRows) {
  db.prepare(
    `INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at,
      input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens)
     VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    turnId,
    atMs - 1000,
    atMs,
    usage.input_tokens || 0,
    usage.output_tokens || 0,
    usage.reasoning_tokens || 0,
    usage.cache_creation_input_tokens || 0,
    usage.cache_read_input_tokens || 0,
    usage.computed_total_tokens ||
      (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.reasoning_tokens || 0)
  )
  const rows = modelRows || [{ model: MODEL, providerId: 'deepseek-test', usage }]
  for (const r of rows) {
    muSeq += 1
    db.prepare(
      `INSERT INTO model_usage (id, session_id, turn_id, model_id, provider_id, status, attempt_index, started_at,
        input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens)
       VALUES (?, ?, ?, ?, ?, 'completed', 0, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'mu-' + turnId + '-' + muSeq,
      sessionId,
      turnId,
      r.model,
      r.providerId || '',
      atMs - 1000,
      r.usage.input_tokens || 0,
      r.usage.output_tokens || 0,
      r.usage.reasoning_tokens || 0,
      r.usage.cache_creation_input_tokens || 0,
      r.usage.cache_read_input_tokens || 0,
      r.usage.computed_total_tokens ||
        (r.usage.input_tokens || 0) + (r.usage.output_tokens || 0) + (r.usage.reasoning_tokens || 0)
    )
  }
}

// 轮次 A：服务启动时应当只做对齐，不当作"新的一轮"
insertTurn('sess_selftest', 'turn_A', { ...USAGE_B, input_tokens: 1, output_tokens: 1 }, Date.now() - 60_000)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  — ' + detail : ''))
}

// 纯函数校验：计价口径。ZCode 记录的 input 是「总输入」（已含缓存命中），
// 若整份按未命中价计费，缓存那 99% 会被重复计价——历史上就是这样虚高了 25 倍。
{
  const p = priceFor('deepseek-flash')
  const at = Date.now()
  const peak = isPeakTime(Math.floor(at / 1000))
  const idx = peak ? 1 : 0
  const usage = {
    input_tokens: 1_000_000,
    cache_read_input_tokens: 999_000,
    cache_creation_input_tokens: 0,
    output_tokens: 10_000,
    reasoning_tokens: 0,
    computed_total_tokens: 1_010_000, // input + output，即 input 含缓存
  }
  const got = costOfUsage('deepseek-flash', usage, at)
  const expect =
    (999_000 / 1e6) * p.hit[idx] + (1_000 / 1e6) * p.miss[idx] + (10_000 / 1e6) * p.out[idx]
  const wrongIfDoubleCounted =
    (999_000 / 1e6) * p.hit[idx] + (1_000_000 / 1e6) * p.miss[idx] + (10_000 / 1e6) * p.out[idx]
  check(
    '缓存命中不被按未命中价重复计费',
    Math.abs(got.amount - expect) < 1e-9,
    '期望 ¥' + expect.toFixed(6) + '，实际 ¥' + got.amount.toFixed(6) +
      '（重复计费会得到 ¥' + wrongIfDoubleCounted.toFixed(6) + '）'
  )
  check('拆分明细正确', got.breakdown.hit === 999_000 && got.breakdown.miss === 1_000, JSON.stringify(got.breakdown))
  // Anthropic 口径（input 不含缓存）也要能识别
  const anthropicStyle = {
    input_tokens: 1_000,
    cache_read_input_tokens: 999_000,
    cache_creation_input_tokens: 0,
    output_tokens: 10_000,
    total_tokens: 1_010_000, // = input + cacheRead + output
  }
  const a = costOfUsage('deepseek-flash', anthropicStyle, at)
  check(
    'Anthropic 口径（input 不含缓存）也能正确拆分',
    Math.abs(a.amount - expect) < 1e-9,
    '¥' + a.amount.toFixed(6)
  )
}

// 多厂商计价：GLM 平价/分档、供应商识别、不可计价兜底
{
  const at = Date.now()
  // GLM-5.3-Flash：0.8（未命中）/0.23（命中）/2.8（输出），input 含缓存口径
  const glmUsage = {
    input_tokens: 1_000_000,
    cache_read_input_tokens: 900_000,
    cache_creation_input_tokens: 0,
    output_tokens: 100_000,
    reasoning_tokens: 0,
    computed_total_tokens: 1_100_000,
  }
  const g = costOfUsage('GLM-5.3-Flash', glmUsage, at, 'account:zai-start-plan')
  const glmExpect = 0.9 * 0.23 + 0.1 * 0.8 + 0.1 * 2.8
  check(
    'GLM-5.3-Flash 按平价计价（input 含缓存拆分）',
    g.vendor === 'glm' && g.billable && Math.abs(g.amount - glmExpect) < 1e-9,
    '期望 ¥' + glmExpect.toFixed(6) + '，实际 ¥' + g.amount.toFixed(6)
  )
  check('GLM 平价不受峰谷时段影响', g.peak === false, 'peak=' + g.peak)

  // 分档：GLM-5.1 按 32K 输入分档
  const lo = resolvePricing({ model: 'glm-5.1', inTokens: 31 * 1024 })
  const hi = resolvePricing({ model: 'glm-5.1', inTokens: 33 * 1024 })
  check('GLM-5.1 输入 <32K/≥32K 分档正确', lo.miss[0] === 6 && hi.miss[0] === 8, 'miss ' + lo.miss[0] + ' vs ' + hi.miss[0])
  // 分档：GLM-4.7 按输出 0.2K 再分两档
  const outLo = resolvePricing({ model: 'glm-4.7', inTokens: 10 * 1024, outTokens: 100 })
  const outHi = resolvePricing({ model: 'glm-4.7', inTokens: 10 * 1024, outTokens: 1000 })
  check('GLM-4.7 输出 <0.2K/≥0.2K 分档正确', outLo.out[0] === 8 && outHi.out[0] === 14, 'out ' + outLo.out[0] + ' vs ' + outHi.out[0])
  // 免费模型
  const free = costOfUsage('GLM-4.7-Flash', glmUsage, at, 'account:zai-start-plan')
  check('GLM-4.7-Flash 免费但计 tokens', free.amount === 0 && free.tokens > 0 && free.billable === false, 'amount=' + free.amount + ' tokens=' + free.tokens)

  // 供应商识别：网关 provider_id 不干扰，模型名优先；未知供应商不虚报金额
  check('网关里的 DeepSeek 模型按 DeepSeek 计价', resolveVendor('cmdgo-bridge', 'deepseek/deepseek-v4-flash') === 'deepseek')
  check('start-plan 账户的 GLM 模型识别为 GLM', resolveVendor('account:zai-start-plan', 'GLM-5.3') === 'glm')
  const mimo = costOfUsage('mimo-v2.6-pro', glmUsage, at, 'xiaomi-mimo')
  check('不可计价供应商金额为 0 且标记 billable=false', resolveVendor('xiaomi-mimo', 'mimo-v2.6-pro') === null && mimo.amount === 0 && mimo.billable === false && mimo.tokens > 0)
  // 网关私有 GLM 变体没有价目 → 不虚报
  const unknownGlm = costOfUsage('zai-org/GLM-5.2-Fast', glmUsage, at, 'cmdgo-bridge')
  check('未维护价目的 GLM 变体不虚报金额', unknownGlm.vendor === 'glm' && unknownGlm.billable === false && unknownGlm.amount === 0 && unknownGlm.tokens > 0)
}

// ZCode Plan 日志解析：纯函数校验 shapePlanPayload
{
  const today = todayKeyForLog()
  const shaped = shapePlanPayload(PLAN_FIXTURE, today, Date.now())
  check(
    'Plan 日志解析：总量/剩余/百分比',
    shaped && shaped.ok && shaped.remaining === 93_000_000 && shaped.total === 104_000_000 && Math.abs(shaped.percentRemaining - 93 / 104) < 1e-9,
    shaped ? 'remaining=' + shaped.remaining + ' total=' + shaped.total : '解析失败'
  )
  check(
    'Plan 日志解析：按模型桶映射（entitlements capabilities + show_name 兜底）',
    shaped && shaped.byModel.length === 3 && normalizeModelKey('GLM-5.3-Flash') === 'glm-5.3-flash' && shaped.byModel[0].model === 'glm-5.3-flash' && shaped.byModel[0].totalUnits === 100_000_000,
    shaped ? JSON.stringify(shaped.byModel.map((b) => b.model)) : ''
  )
  check(
    'Plan 日志解析：到期时间取 active 套餐 ends_at',
    shaped && shaped.nextResetAt === PLAN_FIXTURE.payload.data.plans[0].ends_at * 1000,
    shaped ? String(shaped.nextResetAt) : ''
  )
  check('Plan 日志解析：当天数据不标 stale', shaped && shaped.stale === false)
  const staleShaped = shapePlanPayload(PLAN_FIXTURE, '2026-01-01', Date.now())
  check('Plan 日志解析：非当天的观测标记 stale', staleShaped && staleShaped.stale === true)
}

async function getJson(port, pathname) {
  const res = await fetch('http://127.0.0.1:' + port + pathname, { signal: AbortSignal.timeout(3000) })
  return res.json()
}

async function waitReady(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const health = await getJson(port, '/whale/health')
      if (health && health.app === 'zcode-whale-widget') return health
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'server.mjs')], {
  cwd: PLUGIN_ROOT,
  env: { ...process.env, ZCODE_HOME: tmpHome, ZCODE_DATA_BASE_DIR: tmpHome },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childLog = ''
child.stdout.on('data', (c) => (childLog += c))
child.stderr.on('data', (c) => (childLog += c))

try {
  console.log('🐳 挂件自检（临时 ZCODE_HOME=' + tmpHome + '）\n')

  const health = await waitReady(PORT, 8000)
  check('服务在临时端口就绪', !!health, health ? 'port=' + health.port + ' pid=' + health.pid : childLog.slice(0, 200))
  if (!health) throw new Error('服务未就绪')
  const port = health.port

  const first = await getJson(port, '/whale/last-turn.json')
  check('启动时对齐历史轮次（seq=0，不弹旧轮次）', first.seq === 0 && first.turn === null, JSON.stringify(first))

  const atB = Date.now()
  insertTurn('sess_selftest', 'turn_B', USAGE_B, atB)

  // 服务每秒轮询一次，给足两拍
  let second = null
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400))
    second = await getJson(port, '/whale/last-turn.json')
    if (second.seq > 0) break
  }
  check('新轮次被识别（seq 递增到 1）', second && second.seq === 1, JSON.stringify(second))

  const expected = costOfUsage(MODEL, USAGE_B, atB, 'deepseek-test').amount
  const got = second && typeof second.amount === 'number' ? second.amount : NaN
  check(
    '金额与峰谷定价换算一致',
    Math.abs(got - expected) < 1e-9,
    '期望 ¥' + expected.toFixed(6) + '，实际 ¥' + Number(got).toFixed(6) + '（' + (second && second.peak ? '高峰' : '空闲') + '时段）'
  )
  check('金额明显大于 0', got > 0, '¥' + Number(got).toFixed(4))
  check('轮次标识与模型被带上', !!(second && second.turn === 'turn_B' && second.model === MODEL), JSON.stringify({ turn: second && second.turn, model: second && second.model }))

  // 多模型轮次：GLM（套餐账户）+ DeepSeek 混合，金额应按行加总且带逐模型明细
  const atC = Date.now()
  insertTurn('sess_selftest', 'turn_C', USAGE_B, atC, [
    {
      model: 'GLM-5.3-Flash',
      providerId: 'account:zai-start-plan',
      usage: { input_tokens: 500_000, cache_read_input_tokens: 450_000, output_tokens: 50_000, computed_total_tokens: 550_000 },
    },
    {
      model: 'deepseek-flash',
      providerId: 'deepseek-test',
      usage: { input_tokens: 300_000, cache_read_input_tokens: 0, output_tokens: 30_000, computed_total_tokens: 330_000 },
    },
  ])
  let third = null
  const deadlineC = Date.now() + 6000
  while (Date.now() < deadlineC) {
    await new Promise((r) => setTimeout(r, 400))
    third = await getJson(port, '/whale/last-turn.json')
    if (third.seq > 1) break
  }
  const glmPart = costOfUsage('GLM-5.3-Flash', { input_tokens: 500_000, cache_read_input_tokens: 450_000, output_tokens: 50_000, computed_total_tokens: 550_000 }, atC, 'account:zai-start-plan').amount
  const dsPart = costOfUsage('deepseek-flash', { input_tokens: 300_000, cache_read_input_tokens: 0, output_tokens: 30_000, computed_total_tokens: 330_000 }, atC, 'deepseek-test').amount
  check(
    '多模型轮次按行加总并带逐模型明细',
    third && third.seq === 2 && Array.isArray(third.models) && third.models.length === 2 && Math.abs(third.amount - (glmPart + dsPart)) < 1e-9,
    '期望 ¥' + (glmPart + dsPart).toFixed(6) + '，实际 ¥' + Number(third && third.amount).toFixed(6) + '，models=' + (third && third.models ? third.models.length : '无')
  )
  check('混合轮次的金额构成两种厂商', glmPart > 0 && dsPart > 0, 'GLM ¥' + glmPart.toFixed(4) + ' + DeepSeek ¥' + dsPart.toFixed(4))

  // Plan 配额端到端：/whale/plan.json 读 fixture 日志；GLM 轮次的 quotaPct 用主模型桶算
  const plan = await getJson(port, '/whale/plan.json')
  check(
    'Plan 配额接口返回 fixture 观测',
    plan && plan.ok && plan.remaining === 93_000_000 && plan.total === 104_000_000,
    JSON.stringify(plan).slice(0, 160)
  )
  const expectPct = Math.round((550_000 / 100_000_000) * 10000) / 100
  check(
    '套餐轮次带「占配额百分比」',
    third && third.quotaPct === expectPct,
    '期望 ' + expectPct + '%，实际 ' + (third && third.quotaPct)
  )

  await new Promise((r) => setTimeout(r, 200))
  // 令牌关闭
  const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'))
  const res = await fetch('http://127.0.0.1:' + port + '/whale/shutdown', {
    method: 'POST',
    headers: { 'x-whale-token': info.token },
    signal: AbortSignal.timeout(3000),
  })
  const stopped = await res.json()
  check('带令牌可以关闭服务', !!(stopped && stopped.ok), JSON.stringify(stopped))

  await new Promise((r) => setTimeout(r, 500))
  let alive = true
  try {
    await fetch('http://127.0.0.1:' + port + '/whale/health', { signal: AbortSignal.timeout(1000) })
  } catch (err) {
    alive = false
  }
  check('关闭后端口不再响应', !alive)
} catch (err) {
  check('自检过程未抛异常', false, String((err && err.message) || err) + (childLog ? ' | ' + childLog.slice(0, 300) : ''))
} finally {
  try {
    child.kill()
  } catch (err) {}
  try {
    db.close()
  } catch (err) {}
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch (err) {}
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length === 0 ? '全部通过（' + results.length + '/' + results.length + '）' : '失败 ' + failed.length + ' 项'))
process.exit(failed.length === 0 ? 0 : 1)
