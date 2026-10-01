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
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { costOfUsage, priceFor, isPeakTime, resolveVendor, resolvePricing, normalizeModelId } from '../lib/pricing.mjs'
import { shapePlanPayload } from '../lib/plan-balance.mjs'
import { getPath, TEMPLATES, fetchFromTemplate } from '../lib/vendors.mjs'
import { matchTemplateId, buildProviderEntries, invalidateDiscoverCache } from '../lib/discover.mjs'
import { computeTodayUsage } from '../lib/balance.mjs'
import { findApiKey, readPluginConfig } from '../lib/credentials.mjs'
import { resolveBillingSource, isNightOffpeak } from '../lib/source.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 浮层的 desktop/*.cjs 是 CommonJS（Electron 主进程），从 ESM 自检里 require 进来测
const requireCjs = createRequire(import.meta.url)
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
// v1.4.2 尾窗逐级扩读：标记行前垫 1.2MB 刷屏行、后垫 200KB，把标记整个
// 挤出旧版 512KB 尾窗——读不到今天的观测就会回退到昨天的死套餐残值
// （实测：2.4% 错值挂了一分钟）。服务必须逐级扩窗才能找到这条标记。
const planJunkHead = Buffer.alloc(1200 * 1024, 0x78)
const planJunkTail = Buffer.alloc(200 * 1024, 0x78)
fs.writeFileSync(
  path.join(planLogDir, todayKeyForLog() + '.log'),
  Buffer.concat([planJunkHead, Buffer.from('\n' + planLogLine), planJunkTail])
)

// 厂商自动发现 fixture：一个 bigmodel 规则（应命中 bigmodel-glm），一个本地网关
// 规则（baseURL 是环回地址，key 是网关鉴权用，必须被跳过，即使模型名含 deepseek），
// 一个 enc:v1: 加密凭据规则（无法解密必须跳过，不能当明文 key 用）。
// 注意：fixture 不放**明文** deepseek key——vendors.json 的 deepseek 模板拿到 key
// 会真的出网查余额；findApiKey 的发现路径改在纯函数段用注入路径覆盖。
fs.writeFileSync(
  path.join(tmpHome, '.zcode', 'v2', 'provider_config.json'),
  JSON.stringify({
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: 'bigmodel-standard-api',
            templateId: 'bigmodel-standard-api',
            providerName: 'BigModel API',
            config: {
              access: { type: 'api-key', apiKey: 'selftest-fake-bigmodel-key' },
              api: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
              modelOrder: ['GLM-5.3', 'GLM-5.3-Flash'],
            },
          },
          {
            providerId: 'cmdgo-bridge',
            providerName: 'CommandCode Go (cmdgo-bridge)',
            config: {
              access: { type: 'api-key', apiKey: 'selftest-fake-bridge-key' },
              api: { baseUrl: 'http://127.0.0.1:11435/v1' },
              modelOrder: ['deepseek/deepseek-v4-flash'],
            },
          },
          {
            providerId: 'deepseek-encrypted',
            templateId: 'deepseek',
            providerName: 'DeepSeek Encrypted',
            config: {
              access: { type: 'api-key', apiKey: 'enc:v1:selftest-ciphertext-not-a-key' },
              api: { baseUrl: 'https://api.deepseek.com/anthropic' },
              modelOrder: ['deepseek-flash'],
            },
          },
        ],
      },
    },
  }),
  'utf8'
)

// 内置模板 fixture：规则没写 api.baseUrl 时有效 baseURL 要从这里继承
fs.mkdirSync(path.join(tmpHome, '.zcode', 'v2', 'runtime', 'provider', 'test', '1.0.0', 'ep1'), { recursive: true })
fs.writeFileSync(
  path.join(tmpHome, '.zcode', 'v2', 'runtime', 'provider', 'test', '1.0.0', 'ep1', 'zcode-builtin.json'),
  JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: {
        templateRules: [
          {
            templateId: 'deepseek',
            config: {
              access: { type: 'api-key' },
              api: { type: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic' },
            },
          },
        ],
      },
    },
  }),
  'utf8'
)

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
  CREATE TABLE session_entry (
    type text not null,
    data text not null,
    time_updated integer not null
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
const atA = Date.now() - 60_000
insertTurn('sess_selftest', 'turn_A', { ...USAGE_B, input_tokens: 1, output_tokens: 1 }, atA)

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
  // MiMo 已入价目表：mimo-v2.6-pro 平价 3/6（缓存命中 0.025）——glmUsage 口径
  // = 90 万命中 + 10 万未命中 + 10 万输出 → 0.9×0.025 + 0.1×3 + 0.1×6
  const mimo = costOfUsage('mimo-v2.6-pro', glmUsage, at, 'xiaomi-mimo')
  const mimoExpect = 0.9 * 0.025 + 0.1 * 3 + 0.1 * 6
  check(
    'MiMo 按官网平价计价并带币种',
    resolveVendor('xiaomi-mimo', 'mimo-v2.6-pro') === 'mimo' && mimo.billable && mimo.currency === 'CNY' && Math.abs(mimo.amount - mimoExpect) < 1e-9,
    '期望 ¥' + mimoExpect.toFixed(6) + '，实际 ' + mimo.amount.toFixed(6)
  )
  // 网关私有 GLM 变体没有价目 → 不虚报
  const unknownGlm = costOfUsage('zai-org/GLM-5.2-Fast', glmUsage, at, 'cmdgo-bridge')
  check('未维护价目的 GLM 变体不虚报金额', unknownGlm.vendor === 'glm' && unknownGlm.billable === false && unknownGlm.amount === 0 && unknownGlm.tokens > 0)
}

// 六家厂商价目与特殊计价规则（GPT 长上下文档 / Qwen 输入档 / MiniMax 512K 档 /
// Kimi 缓存写 TTL 档 / Claude 缓存写 1.25x / 未知模型不套 DeepSeek 价）
{
  const at = Date.now()
  // OpenAI：272K 输入整单取档（>272K 输入×2 / 输出×1.5）
  const gptLo = resolvePricing({ model: 'gpt-5.6-terra', inTokens: 200000 })
  const gptHi = resolvePricing({ model: 'gpt-5.6-terra', inTokens: 300000 })
  check(
    'GPT-5.6 按 272K 输入整单分档（输入×2 / 输出×1.5）',
    gptLo.miss[0] === 2 && gptHi.miss[0] === 4 && gptLo.out[0] === 12 && gptHi.out[0] === 18 && gptLo.currency === 'USD',
    JSON.stringify({ lo: gptLo.miss, hi: gptHi.miss })
  )
  // Claude：平价 + 缓存写 1.25×输入；日期后缀模型名靠前缀匹配
  const cl = costOfUsage(
    'claude-sonnet-5-5-20260201',
    { input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000, output_tokens: 0 },
    at
  )
  check(
    'Claude 前缀匹配 + 缓存写 1.25×输入（USD）',
    cl.vendor === 'anthropic' && cl.currency === 'USD' && Math.abs(cl.amount - (2 + 2.5)) < 1e-9,
    'amount=' + cl.amount.toFixed(4)
  )
  // Qwen：按输入 token 分档整单取档（官方 K=1,000）
  const qLo = resolvePricing({ model: 'qwen3-max', inTokens: 30000 })
  const qHi = resolvePricing({ model: 'qwen3-max', inTokens: 200000 })
  check(
    'qwen3-max 输入分档（<=32K / 32K-128K / 128K-256K）',
    qLo.tier === '<=32K' && qLo.miss[0] === 2.5 && qHi.tier === '128K-256K' && qHi.miss[0] === 7
  )
  // MiniMax：M3 以 512K 输入为界
  const mmLo = resolvePricing({ model: 'MiniMax-M3', inTokens: 500000 })
  const mmHi = resolvePricing({ model: 'MiniMax-M3', inTokens: 600000 })
  check(
    'MiniMax-M3 512K 分档',
    mmLo.tier === '<=512K' && mmLo.miss[0] === 2.1 && mmHi.tier === '>512K' && mmHi.miss[0] === 4.2
  )
  // Kimi：缓存写按 TTL 计价，无 TTL 信息按默认 5min 档（k3 写价 20）
  const kimi = costOfUsage(
    'kimi-k3',
    { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000, output_tokens: 0 },
    at
  )
  check('Kimi 缓存写按默认 5min TTL 档计价', kimi.billable && Math.abs(kimi.amount - 20) < 1e-9, 'amount=' + kimi.amount)
  // 未知模型不套任何价目（含「仅 provider 名沾 DeepSeek」的误配场景）
  const unknown = costOfUsage('mystery-9000', { input_tokens: 1000, output_tokens: 10 }, at, 'weird-corp')
  const providerOnly = costOfUsage('totally-unknown', { input_tokens: 1000, output_tokens: 10 }, at, 'deepseek')
  check(
    '未知模型只计 tokens 不折算金额（不再套 DeepSeek 价）',
    unknown.billable === false && unknown.amount === 0 && providerOnly.billable === false && providerOnly.amount === 0
  )
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
    shaped && shaped.byModel.length === 3 && normalizeModelId('GLM-5.3-Flash') === 'glm-5.3-flash' && shaped.byModel[0].model === 'glm-5.3-flash' && shaped.byModel[0].totalUnits === 100_000_000,
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

  // ZCode 启动就绪判定（浮层门控用）：日志里有 boot 标记但没有 ready 标记 =
  // 加载动画期间，浮层先不显示；缺 boot 标记（老版本/日志缺失）一律放行。
  // v1.5.4：标记要认「本次启动」的 pid——同一天日志里躺着上一次运行完整的
  // 「启动→就绪」序列，只按位置判断会把上一次的序列当成本次已就绪，于是重开
  // ZCode 时鲸鱼在加载动画里就出现了（2026-10-01 实测 + 截图）。
  {
    const { evaluateBootState } = requireCjs(path.join(PLUGIN_ROOT, 'desktop', 'ui-ready.cjs'))
    const boot = '[2026-10-01 10:00:26.874] [info] [pid:1] [main] [primary-window] creating main window (app-ready)\n'
    const domReady = '[2026-10-01 10:00:27.328] [info] [pid:1] [main] [createWindow] dom-ready fired (local-1)\n'
    const dbReady = '[2026-10-01 10:00:32.708] [info] [pid:1] [main] [database-startup] terminal {"attemptId":"x","status":"ready","durationMs":4967}\n'
    const taskList = '[2026-10-01 10:00:33.305] [info] [x] window-controller.listTaskList OK (20.8ms)\n'
    const s1 = evaluateBootState(boot + domReady)
    check('启动就绪判定：主窗口刚建好 = 加载中', s1.state === 'loading' && s1.bootAt === 1790820026874, JSON.stringify(s1))
    const s2 = evaluateBootState(boot + domReady + dbReady)
    check('启动就绪判定：数据库 ready 后放行', s2.state === 'ready', JSON.stringify(s2))
    const s3 = evaluateBootState(boot + domReady + taskList)
    check('启动就绪判定：任务列表拉取成功也放行', s3.state === 'ready', JSON.stringify(s3))
    const s4 = evaluateBootState('随便一段没有启动标记的日志\n')
    check('启动就绪判定：无启动标记不拦（老版本/日志缺失）', s4.state === 'ready', JSON.stringify(s4))
    const s5 = evaluateBootState(boot + dbReady + boot)
    check('启动就绪判定：二次启动后重新进入加载态', s5.state === 'loading', JSON.stringify(s5))

    // 场景取自 2026-10-01 实测：12:48 那次运行完整收尾（boot 12:48:14 →
    // database-startup ready 12:48:16），13:20:49 用户重开 ZCode（pid 7876，
    // 主界面 13:20:56 才就绪）。加载动画期间读到的日志尾窗里只有上一次的标记。
    const stampOf = (s) => new Date(s.replace(' ', 'T')).getTime()
    const oldRun =
      '[2026-10-01 12:48:14.874] [info] [pid:3812] [main] [startup] 创建主窗口\n' +
      '[2026-10-01 12:48:14.874] [info] [pid:3812] [main] [primary-window] creating main window (app-ready)\n' +
      '[2026-10-01 12:48:16.000] [info] [pid:3812] [main] [database-startup] terminal {"attemptId":"a","status":"ready","durationMs":5007}\n' +
      '[2026-10-01 12:48:16.500] [info] [pid:3812] [main] [host-log] (local-1) [host] [2026-10-01 12:48:16.500] [pid:99999] [zcode-host] [rpc:call] window-controller.listTaskList OK (0.1ms)\n'
    const newBoot =
      '[2026-10-01 13:20:49.981] [info] [pid:7876] [main] [startup] 创建主窗口\n' +
      '[2026-10-01 13:20:49.982] [info] [pid:7876] [main] [primary-window] creating main window (app-ready)\n'
    const newReady = '[2026-10-01 13:20:56.385] [info] [pid:7876] [main] [database-startup] terminal {"attemptId":"b","status":"ready","durationMs":4983}\n'
    const NEW_PID_START = stampOf('2026-10-01 13:20:48.500') // 进程启动时间
    const NEW = { pid: 7876, processStartAt: NEW_PID_START }

    const r1 = evaluateBootState(oldRun, NEW)
    check(
      '启动就绪判定：上一次运行的就绪序列不冒充本次（重开 ZCode 时拦住加载动画）',
      r1.state === 'loading' && r1.anchorAt === NEW_PID_START,
      JSON.stringify(r1)
    )
    const r2 = evaluateBootState(oldRun + newBoot, NEW)
    check('启动就绪判定：本次 boot 之后还没就绪 = 加载中', r2.state === 'loading' && r2.reason === 'loading-after-boot', JSON.stringify(r2))
    const r3 = evaluateBootState(oldRun + newBoot + newReady, NEW)
    check('启动就绪判定：本次 boot 之后的就绪标记放行', r3.state === 'ready' && r3.reason === 'ready-after-boot', JSON.stringify(r3))
    const r4 = evaluateBootState(newReady, NEW)
    check('启动就绪判定：boot 被刷出尾窗但本次就绪标记在场 = 放行', r4.state === 'ready', JSON.stringify(r4))
    const r5 = evaluateBootState(oldRun, { processStartAt: NEW_PID_START })
    check('启动就绪判定：只有进程启动时间也能拦住（pid 拿不到时）', r5.state === 'loading', JSON.stringify(r5))
    const r6 = evaluateBootState(oldRun, { pid: 3812, processStartAt: NEW_PID_START })
    check('启动就绪判定：pid 相同但标记早于本次进程 = 仍算加载中', r6.state === 'loading', JSON.stringify(r6))
    const r7 = evaluateBootState(oldRun)
    check('启动就绪判定：既无 pid 也无进程时间时退回旧口径（不拦）', r7.state === 'ready', JSON.stringify(r7))
    const r8 = evaluateBootState(oldRun + newBoot + newReady, { pid: 7876 })
    check('启动就绪判定：只给 pid 也能放行', r8.state === 'ready', JSON.stringify(r8))
    // 进程启动时间取了未来值（采样异常）：当无效身份处理，不能让超时兜底失效
    const r9 = evaluateBootState(oldRun + newBoot, { pid: 7876, processStartAt: Date.now() + 3600_000 })
    check('启动就绪判定：未来时间戳的身份锚点被忽略', r9.state === 'loading' && r9.anchorAt && r9.anchorAt < Date.now(), JSON.stringify(r9))
  }

  // v1.4.2：过期套餐的遗留桶不冒充当前配额——balances 里会残留死套餐的桶
  // （remaining=0 但 total 仍在），跨套餐求和会把百分比稀释失真
  const deadFixture = JSON.parse(JSON.stringify(PLAN_FIXTURE))
  deadFixture.balances.push({
    entitlement_id: 'ent-legacy-0817',
    show_name: 'GLM-5.3',
    total_units: 3_000_000,
    used_units: 3_000_000,
    remaining_units: 0,
    available_units: 0,
    reserved_units: null,
  })
  const deadShaped = shapePlanPayload(deadFixture, today, Date.now())
  check(
    'Plan 日志解析：死套餐遗留桶被剔除（不稀释总量）',
    deadShaped && deadShaped.total === 104_000_000 && deadShaped.byModel.length === 3,
    'total=' + (deadShaped && deadShaped.total) + ' models=' + (deadShaped ? deadShaped.byModel.length : '无')
  )
  // 老格式日志（plans 列表为空，无法归属套餐）：保留全量桶，不误杀
  const legacyFixture = JSON.parse(JSON.stringify(PLAN_FIXTURE))
  legacyFixture.payload.data.plans = []
  const legacyShaped = shapePlanPayload(legacyFixture, today, Date.now())
  check(
    'Plan 日志解析：无 plans 的老格式回退全量桶',
    legacyShaped && legacyShaped.total === 104_000_000,
    'total=' + (legacyShaped && legacyShaped.total)
  )
}

// 厂商模板框架：字段路径求值与模板匹配
{
  const obj = { a: { b: [{ c: 42 }], d: 'x' } }
  check('字段路径求值 a.b[0].c', getPath(obj, 'a.b[0].c') === 42)
  check('字段路径求值：取不到返回 undefined', getPath(obj, 'a.b[9].c') === undefined && getPath(obj, 'a.b[0].c.d') === undefined)
  check(
    '模板匹配：bigmodel/glm/智谱关键词 → bigmodel-glm',
    matchTemplateId(['bigmodel-standard-api', 'BigModel API']) === 'bigmodel-glm' &&
      matchTemplateId(['some', 'GLM-5.3']) === 'bigmodel-glm' &&
      matchTemplateId(['zhipu-coding']) === 'bigmodel-glm'
  )
  check(
    '模板匹配：deepseek / openrouter / kimi 国内国际',
    matchTemplateId(['deepseek-test']) === 'deepseek' &&
      matchTemplateId(['openrouter']) === 'openrouter' &&
      matchTemplateId(['moonshot-cn', 'Kimi 国内']) === 'moonshot-cn' &&
      matchTemplateId(['moonshot-intl']) === 'moonshot-intl'
  )
  check('模板匹配：本地网关关键词不做 vendor 判定', matchTemplateId(['cmdgo-bridge']) === null)
}

// 凭据发现：有效 baseURL 继承内置模板、enc:v1: 密文跳过、本地网关标记
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cred-fx-'))
  // fixture 布局对齐 v2DataDirCandidates()：<base>/.zcode/v2/，ZCODE_DATA_BASE_DIR=<base>
  const fxV2 = path.join(fx, '.zcode', 'v2')
  fs.mkdirSync(path.join(fxV2, 'runtime', 'provider', 'x', '1', 'e'), { recursive: true })
  fs.writeFileSync(
    path.join(fxV2, 'runtime', 'provider', 'x', '1', 'e', 'zcode-builtin.json'),
    JSON.stringify({
      revision: 1,
      config: {
        providerConfigRules: {
          templateRules: [
            { templateId: 'deepseek', config: { api: { baseUrl: 'https://api.deepseek.com/anthropic' } } },
            { templateId: 'xiaomi-mimo', config: { api: { baseUrl: 'https://api.xiaomimimo.com/anthropic' } } },
          ],
        },
      },
    }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(fxV2, 'provider_config.json'),
    JSON.stringify({
      config: {
        providerConfigRules: {
          providerRules: [
            { providerId: 'deepseek', templateId: 'deepseek', config: { access: { type: 'api-key', apiKey: 'selftest-fake-key-aaaa' } } },
            {
              providerId: 'deepseek-enc',
              templateId: 'deepseek',
              config: { access: { type: 'api-key', apiKey: 'enc:v1:selftest-ciphertext' }, api: { baseUrl: 'https://api.deepseek.com/anthropic' } },
            },
            {
              providerId: 'mimo-plan',
              templateId: 'xiaomi-mimo',
              config: { access: { type: 'api-key', apiKey: 'selftest-fake-key-bbbb' }, api: { baseUrl: 'https://token-plan-cn.xiaomimimo.com' } },
            },
          ],
        },
      },
    }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(fx, 'cli-config.json'),
    JSON.stringify({ provider: { 'local-gw': { options: { baseURL: 'http://127.0.0.1:11435/v1', apiKey: 'selftest-fake-key-cccc' } } } }),
    'utf8'
  )
  const entries = buildProviderEntries({ v2Dirs: [fxV2], cliConfigFile: path.join(fx, 'cli-config.json') })
  const byId = {}
  for (const e of entries) byId[e.providerId] = e
  check(
    '凭据发现：无 baseUrl 规则从内置模板继承有效 baseURL',
    byId.deepseek && byId.deepseek.host === 'api.deepseek.com' && byId.deepseek.apiKey === 'selftest-fake-key-aaaa',
    byId.deepseek ? 'host=' + byId.deepseek.host : '缺失'
  )
  check(
    '凭据发现：enc:v1: 密文跳过（不当明文 key）',
    byId['deepseek-enc'] && byId['deepseek-enc'].keyEncrypted === true && byId['deepseek-enc'].apiKey === ''
  )
  check(
    '凭据发现：规则自带 baseUrl 覆盖模板（mimo plan 端点可辨识）',
    byId['mimo-plan'] && byId['mimo-plan'].host === 'token-plan-cn.xiaomimimo.com'
  )
  check('凭据发现：本地网关标记 isLocal', byId['local-gw'] && byId['local-gw'].isLocal === true && byId['local-gw'].host === '127.0.0.1')

  // findApiKey 端到端：ZCODE_DATA_BASE_DIR 注入后应命中 fixture 的 deepseek 规则
  const savedBase = process.env.ZCODE_DATA_BASE_DIR
  const savedEnvKey = process.env.DEEPSEEK_API_KEY
  process.env.ZCODE_DATA_BASE_DIR = fx
  delete process.env.DEEPSEEK_API_KEY
  try {
    const r = findApiKey()
    if (readPluginConfig().apiKey) {
      check('findApiKey 命中 ZCode provider（跳过：插件配置已设 apiKey）', true, 'source=' + r.source)
    } else {
      check(
        'findApiKey 命中 ZCode provider（模板继承 baseURL 的 deepseek 规则）',
        r.source === 'zcode-provider' && r.key === 'selftest-fake-key-aaaa',
        'source=' + r.source
      )
    }
  } finally {
    if (savedBase === undefined) delete process.env.ZCODE_DATA_BASE_DIR
    else process.env.ZCODE_DATA_BASE_DIR = savedBase
    if (savedEnvKey !== undefined) process.env.DEEPSEEK_API_KEY = savedEnvKey
  }
  fs.rmSync(fx, { recursive: true, force: true })
}

// 计费源解析：智能跟随的统一判据（providerId / modelId / 有效 baseURL）
{
  const r = (pid, model, url) => resolveBillingSource(pid, model, url).source
  check(
    '计费源：订阅套餐 provider → Plan 配额',
    r('account:zai-start-plan', 'GLM-5.3') === 'plan' && r('x:coding-plan', 'any') === 'plan'
  )
  check(
    '计费源：MiMo 双端点按 URL 区分（token-plan vs api）',
    r('xiaomi-mimo', 'mimo-v2.6-pro', 'https://token-plan-cn.xiaomimimo.com') === 'mimo-plan' &&
      r('xiaomi-mimo', 'mimo-v2.6-pro', 'https://api.xiaomimimo.com/anthropic') === 'mimo-api'
  )
  check(
    '计费源：DeepSeek / GLM / 其它厂商按 URL 与模型名识别',
    r('deepseek', 'deepseek-v4-pro', 'https://api.deepseek.com/anthropic') === 'ds' &&
      r('bigmodel-standard-api', 'GLM-5.3', 'https://open.bigmodel.cn/api/paas/v4') === 'glm' &&
      r('openai-p', 'gpt-5.6-terra', 'https://api.openai.com/v1') === 'openai' &&
      r('moonshot-kimi', 'kimi-k3', 'https://api.moonshot.cn/anthropic') === 'kimi'
  )
  check(
    '计费源：网关转发靠模型名兜底（deepseek/、xiaomi/mimo-）',
    r('cmdgo-bridge', 'deepseek/deepseek-v4-flash', 'http://127.0.0.1:11435/v1') === 'ds' &&
      r('cmdgo-bridge', 'xiaomi/mimo-v2.6-pro', 'http://127.0.0.1:11435/v1') === 'mimo-api'
  )
  check(
    '计费源：全未知 → tokens（不冒充任何厂商）',
    r('mystery-corp', 'totally-unknown-9000') === 'tokens' && resolveBillingSource('', '', '').source === 'tokens'
  )
  check(
    '计费源：timeMode 标记（DeepSeek 峰谷 / MiMo Plan 夜间系数 / 平价 none）',
    resolveBillingSource('deepseek', 'deepseek-flash').timeMode === 'peak-valley' &&
      resolveBillingSource('xiaomi-mimo', 'mimo-v2.6-pro', 'https://token-plan-cn.xiaomimimo.com').timeMode === 'offpeak-x0.8' &&
      resolveBillingSource('bigmodel-standard-api', 'GLM-5.3').timeMode === 'none'
  )
  // isNightOffpeak：北京时间 0–8 点（构造两个确定时刻验证）
  const atNight = Date.UTC(2026, 8, 29, 20, 0, 0) // 北京 09-30 04:00
  const atDay = Date.UTC(2026, 8, 29, 6, 0, 0) // 北京 09-29 14:00
  check('MiMo 夜间时段判定（北京时间 0-8 点）', isNightOffpeak(atNight) === true && isNightOffpeak(atDay) === false)
}

// 实时·令牌模式的平台用量解析（computeTodayUsage）：接口只给 token 分桶，
// 金额要按峰谷价自行换算，是「今日已用」在 token 模式下的唯一算法，必须有 fixture。
{
  const bucket = (time, hit, miss, out) => ({
    time,
    usage: { PROMPT_CACHE_HIT_TOKEN: hit, PROMPT_CACHE_MISS_TOKEN: miss, RESPONSE_TOKEN: out },
  })
  const wrap = (series) => ({ data: { biz_data: { series } } })
  const p = priceFor('deepseek-flash')
  // 峰谷价按 isPeakTime(b.time) 选档（b.time 是**秒**，idx=1 为高峰）。
  // 高峰 = 工作日北京时间 9:00–12:00 / 14:00–18:00；2026-09-29 是周二。
  const offSec = Date.UTC(2026, 8, 29, 4, 30, 0) / 1000 // 北京 12:30（空闲）
  const peakSec = Date.UTC(2026, 8, 29, 2, 0, 0) / 1000 // 北京 10:00（高峰）
  const offIdx = isPeakTime(offSec) ? 1 : 0
  const peakIdx = isPeakTime(peakSec) ? 1 : 0
  const rate = (idx) => ({ hit: p.hit[idx], miss: p.miss[idx], out: p.out[idx] })

  const flat = computeTodayUsage(
    wrap([
      { model: 'deepseek-flash', buckets: [bucket(offSec, 400_000, 100_000, 50_000), bucket(offSec, 100_000, 0, 0)] },
    ])
  )
  const r0 = rate(offIdx)
  const expectFlat = (500_000 / 1e6) * r0.hit + (100_000 / 1e6) * r0.miss + (50_000 / 1e6) * r0.out
  check(
    'computeTodayUsage：多桶按命中/未命中/输出三档换算并求和',
    flat && Math.abs(flat.amount - expectFlat) < 1e-9 && flat.tokens === 650_000,
    flat ? '期望 ¥' + expectFlat.toFixed(6) + '，实际 ¥' + flat.amount.toFixed(6) + ' tokens=' + flat.tokens : '返回 null'
  )

  const peak = computeTodayUsage(wrap([{ model: 'deepseek-flash', buckets: [bucket(peakSec, 500_000, 100_000, 50_000)] }]))
  const r1 = rate(peakIdx)
  const expectPeak = (500_000 / 1e6) * r1.hit + (100_000 / 1e6) * r1.miss + (50_000 / 1e6) * r1.out
  check(
    'computeTodayUsage：高峰桶按高峰档计价',
    peak && Math.abs(peak.amount - expectPeak) < 1e-9,
    peak ? '期望 ¥' + expectPeak.toFixed(6) + '，实际 ¥' + peak.amount.toFixed(6) : '返回 null'
  )
  check(
    'computeTodayUsage：峰谷档位确实不同（同一用量两种价）',
    Math.abs(expectPeak - expectFlat) > 1e-6 && peakIdx !== offIdx,
    '峰值索引 ' + peakIdx + ' vs 空闲索引 ' + offIdx
  )

  check(
    'computeTodayUsage：全零用量/空结构 → null（不虚报 0 元）',
    computeTodayUsage(wrap([{ model: 'deepseek-flash', buckets: [bucket(offSec, 0, 0, 0)] }])) === null &&
      computeTodayUsage(wrap([])) === null &&
      computeTodayUsage(null) === null
  )
  check(
    'computeTodayUsage：data.series 直挂结构也被接受（接口版本差异兜底）',
    !!computeTodayUsage({ data: { series: [{ model: 'deepseek-flash', buckets: [bucket(offSec, 1000, 0, 0)] }] } })
  )
}

// 厂商模板出站白名单：host 必须是模板里的独立常量，不能从 url 现算（v1.3.0 复审 S2）
{
  const urlSections = Object.entries(TEMPLATES)
    .map(([id, tpl]) => [id, tpl.kind === 'quota' ? tpl.quota : tpl.balance])
    .filter(([, s]) => s && typeof s.url === 'string')
  check(
    '模板白名单：每个带 url 的模板都显式声明 host 且与 url 一致',
    urlSections.length >= 4 &&
      urlSections.every(([, s]) => typeof s.host === 'string' && s.host.trim().toLowerCase() === new URL(s.url).hostname.toLowerCase()),
    urlSections.map(([id, s]) => id + '=' + s.host).join(', ')
  )
  const bad = await fetchFromTemplate({ kind: 'balance', balance: { url: 'https://api.moonshot.cn/v1/x', host: 'evil.example', pick: () => null } }, 'k')
  check(
    '模板白名单：host 与 url 不一致 → 拒绝（url 自证清白的漏洞已堵）',
    bad && bad.ok === false && /白名单/.test(String(bad.reason)),
    JSON.stringify(bad)
  )
  const noHost = await fetchFromTemplate({ kind: 'balance', balance: { url: 'https://api.moonshot.cn/v1/x', pick: () => null } }, 'k')
  check('模板白名单：未声明 host → 拒绝（fail closed）', noHost && noHost.ok === false && /未声明 host/.test(String(noHost.reason)), JSON.stringify(noHost))
  const loopback = await fetchFromTemplate(
    { kind: 'balance', balance: { url: 'http://127.0.0.1:11435/v1/credits', host: '127.0.0.1', pick: () => null } },
    'k'
  )
  check(
    '模板白名单：环回地址即使 host 声明一致也被拒',
    loopback && loopback.ok === false && /环回|私有|保留/.test(String(loopback.reason)),
    JSON.stringify(loopback)
  )
}

// 凭据发现的短 TTL 缓存（v1.3.0 复审 N3）：默认路径 5 秒内复用，显式失效后重扫
{
  const v2dir = path.join(tmpHome, '.zcode', 'v2')
  const savedBase = process.env.ZCODE_DATA_BASE_DIR
  process.env.ZCODE_DATA_BASE_DIR = tmpHome
  try {
    const probeId = 'n3-cache-probe'
    const legacyFile = path.join(v2dir, 'config.json')
    const saved = fs.existsSync(legacyFile) ? fs.readFileSync(legacyFile, 'utf8') : null
    invalidateDiscoverCache()
    const before = buildProviderEntries()
    check('发现缓存：首次调用即全量扫描', Array.isArray(before) && !before.some((e) => e.providerId === probeId))
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ provider: { [probeId]: { options: { baseURL: 'https://probe.example/v1' } } } }),
      'utf8'
    )
    const cached = buildProviderEntries()
    check(
      '发现缓存：TTL 内新增配置不重扫（前端 3 秒轮询不再全量扫描）',
      !cached.some((e) => e.providerId === probeId),
      'entries=' + cached.length
    )
    check('发现缓存：命中时返回副本（调用方改不动缓存）', cached !== buildProviderEntries() && cached.length === buildProviderEntries().length)
    invalidateDiscoverCache()
    const fresh = buildProviderEntries()
    check(
      '发现缓存：显式失效后重扫并看到新配置',
      fresh.some((e) => e.providerId === probeId && e.baseUrl === 'https://probe.example/v1'),
      'entries=' + fresh.length
    )
    if (saved === null) fs.rmSync(legacyFile, { force: true })
    else fs.writeFileSync(legacyFile, saved, 'utf8')
    invalidateDiscoverCache()
  } finally {
    if (savedBase === undefined) delete process.env.ZCODE_DATA_BASE_DIR
    else process.env.ZCODE_DATA_BASE_DIR = savedBase
    invalidateDiscoverCache()
  }
}

async function getJson(port, pathname) {
  const res = await fetch('http://127.0.0.1:' + port + pathname, { signal: AbortSignal.timeout(3000) })
  return res.json()
}

// CLI 文本出口（node lib/cli.mjs <args>）：v1.3.0 复审 N1 的回归面在这条路径上，
// 之前的测试只覆盖 HTTP JSON 接口，币种就是从这里漏出去的。
function runCli(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'cli.mjs'), ...args], {
      cwd: PLUGIN_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d) => (stdout += d))
    c.stderr.on('data', (d) => (stderr += d))
    c.on('close', (code) => resolve({ code, stdout, stderr }))
    setTimeout(() => {
      try {
        c.kill()
      } catch (err) {}
    }, 8000)
  })
}

// MCP（stdio NDJSON）：写请求后等一会儿收响应，再结束进程。
function runMcp(requests, env, waitMs = 2500) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'mcp-server.mjs')], {
      cwd: PLUGIN_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', () => {})
    for (const r of requests) c.stdin.write(JSON.stringify(r) + '\n')
    setTimeout(() => {
      try {
        c.kill()
      } catch (err) {}
      resolve(
        out
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => {
            try {
              return JSON.parse(l)
            } catch (err) {
              return null
            }
          })
          .filter(Boolean)
      )
    }, waitMs)
  })
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

const serverEnv = { ...process.env, ZCODE_HOME: tmpHome, ZCODE_DATA_BASE_DIR: tmpHome }
let childLog = ''
function spawnServer() {
  const c = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'server.mjs')], {
    cwd: PLUGIN_ROOT,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  c.stdout.on('data', (chunk) => (childLog += chunk))
  c.stderr.on('data', (chunk) => (childLog += chunk))
  return c
}
let child = spawnServer()

try {
  console.log('🐳 挂件自检（临时 ZCODE_HOME=' + tmpHome + '）\n')

  const health = await waitReady(PORT, 8000)
  check('服务在临时端口就绪', !!health, health ? 'port=' + health.port + ' pid=' + health.pid : childLog.slice(0, 200))
  if (!health) throw new Error('服务未就绪')
  check(
    'health 带 key 探测诊断（列出 provider 条目，enc 密文被标记）',
    health.keyProbe && Array.isArray(health.keyProbe.entries) &&
      health.keyProbe.entries.some((e) => e.providerId === 'deepseek-encrypted' && e.keyEncrypted === true),
    'keySource=' + health.keySource + ' entries=' + ((health.keyProbe && health.keyProbe.entries) || []).length
  )
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
  // v1.4.0：套餐轮的余额口径——planPct 占配额总量（与主显示「Plan 剩余 x%」同
  // 基数），混合轮次把非套餐行的真实金额放进 extraAmounts；纯 DeepSeek 轮不带
  const expectPlanPct = Math.round((550_000 / 104_000_000) * 10000) / 100
  check(
    '套餐轮次带「消耗余额百分比」（占配额总量，同主显示基数）',
    third && third.planTurn === true && third.planPct === expectPlanPct && third.planTokens === 550_000,
    '期望 ' + expectPlanPct + '%/550000，实际 ' + (third && third.planPct) + '%/' + (third && third.planTokens)
  )
  check(
    '混合轮次的非套餐行金额进 extraAmounts（套餐行被剔除）',
    third && third.extraAmounts && Math.abs(third.extraAmounts.CNY - dsPart) < 1e-9 && Object.keys(third.extraAmounts).length === 1,
    '期望 CNY ' + dsPart.toFixed(6) + '，实际 ' + JSON.stringify(third && third.extraAmounts)
  )
  check(
    '纯 DeepSeek 轮不带套餐口径（planTurn=false，planPct=null）',
    second && second.planTurn === false && second.planPct === null && second.extraAmounts === null,
    'planTurn=' + (second && second.planTurn) + ' planPct=' + (second && second.planPct)
  )

  // 厂商模板端到端：自动发现命中 bigmodel 规则、跳过本地网关；无 key 的模板不可用
  const vendors = await getJson(port, '/whale/vendors.json')
  const byId = {}
  for (const v of (vendors && vendors.vendors) || []) byId[v.id] = v
  check(
    '厂商模板清单完整（7 家）',
    vendors && vendors.ok && ['deepseek', 'zcode-plan', 'bigmodel-glm', 'openrouter', 'moonshot-cn', 'moonshot-intl', 'zhipu-quota'].every((id) => byId[id]),
    vendors && vendors.vendors ? vendors.vendors.map((v) => v.id).join(',') : '无'
  )
  check(
    '自动发现命中 bigmodel 规则（key 来自 v2 provider_config）',
    byId['bigmodel-glm'] && byId['bigmodel-glm'].available === true && String(byId['bigmodel-glm'].keySource || '').indexOf('v2-provider-config') === 0,
    byId['bigmodel-glm'] ? JSON.stringify({ available: byId['bigmodel-glm'].available, keySource: byId['bigmodel-glm'].keySource }) : '缺失'
  )
  check(
    '本地网关/加密凭据被跳过：deepseek 走 NO_KEY 快速路径不出网',
    byId['deepseek'] && byId['deepseek'].available === false && String(byId['deepseek'].reason || '').indexOf('未找到 DeepSeek API Key') === 0,
    byId['deepseek'] ? JSON.stringify({ available: byId['deepseek'].available, reason: byId['deepseek'].reason }).slice(0, 160) : '缺失'
  )
  check(
    '无凭据模板不可用且不虚报余额',
    byId['openrouter'] && byId['openrouter'].available === false && byId['openrouter'].balance === undefined,
    byId['openrouter'] ? 'available=' + byId['openrouter'].available : '缺失'
  )
  check(
    'Plan 模板走日志源',
    byId['zcode-plan'] && byId['zcode-plan'].available === true && byId['zcode-plan'].kind === 'local-log',
    byId['zcode-plan'] ? 'available=' + byId['zcode-plan'].available : '缺失'
  )

  // 用量记录：今日按模型聚合与逐条事件
  const usage = await getJson(port, '/whale/usage-records.json')
  const usageModels = usage && usage.ok ? usage.today.models.map((m) => m.model) : []
  check(
    '用量记录：今日含两个模型的聚合',
    usage && usage.ok && usageModels.indexOf('GLM-5.3-Flash') !== -1 && usageModels.indexOf('deepseek-flash') !== -1,
    'models=' + usageModels.join(',')
  )
  check(
    '用量记录：今日金额与全部轮次一致（A+B+C）',
    usage && usage.ok,
    'total=' + (usage && usage.today ? usage.today.total : '无')
  )
  if (usage && usage.ok) {
    const costA = costOfUsage('deepseek-flash', { input_tokens: 1, output_tokens: 1, computed_total_tokens: 2 }, atA, 'deepseek-test').amount
    const costB = costOfUsage('deepseek-flash', USAGE_B, atB, 'deepseek-test').amount
    const expectedToday = costA + costB + glmPart + dsPart
    check(
      '用量记录：今日金额 = 三轮之和',
      Math.abs(usage.today.total - expectedToday) < 1e-9,
      '期望 ¥' + expectedToday.toFixed(6) + '，实际 ¥' + usage.today.total.toFixed(6)
    )
  }
  // 明细按轮聚合：一轮 = session/turn 相同的全部模型行之和
  check(
    '用量记录：带最近轮次列表（按轮聚合）',
    usage && usage.ok && Array.isArray(usage.turns) && usage.turns.length >= 2,
    'turns=' + (usage && usage.turns ? usage.turns.length : '无')
  )
  if (usage && usage.ok && Array.isArray(usage.turns)) {
    const turnC = usage.turns.find((t) => (t.models || []).some((m) => m.model === 'GLM-5.3-Flash'))
    check(
      '用量记录：多模型轮次归并为一条且金额 = 两模型之和',
      turnC && turnC.calls === 2 && turnC.models.length === 2 && Math.abs(turnC.amount - (glmPart + dsPart)) < 1e-9,
      turnC
        ? 'calls=' + turnC.calls + ' models=' + turnC.models.length + ' ¥' + turnC.amount.toFixed(6)
        : '未找到含 GLM 的轮次'
    )
  }

  // N1 回归（v1.3.0 复审）：多币种轮次的**文本出口**不能把美元写成人民币。
  // cli.mjs / mcp-server.mjs 曾把 'CNY' 写死在金额格式化里，OpenAI/Claude 轮次会
  // 显示成 ¥0.30（与真实价值差约 7 倍）。这里插一条 OpenAI 轮次，走真实 CLI 与
  // MCP 文本路径核对，顺带核对 MCP 握手版本号与 plugin.json 一致（复审 N2）。
  const atD = Date.now()
  const USD_USAGE = { input_tokens: 120_000, cache_read_input_tokens: 20_000, output_tokens: 8_000, computed_total_tokens: 128_000 }
  insertTurn('sess_selftest', 'turn_USD', USD_USAGE, atD, [{ model: 'gpt-5.6-terra', providerId: 'openai', usage: USD_USAGE }])
  const usdExpected = costOfUsage('gpt-5.6-terra', USD_USAGE, atD, 'openai')
  let usdTurn = null
  const deadlineUsd = Date.now() + 6000
  while (Date.now() < deadlineUsd) {
    await new Promise((r) => setTimeout(r, 400))
    usdTurn = await getJson(port, '/whale/last-turn.json')
    if (usdTurn.seq > 2) break
  }
  check(
    '多币种轮次被识别（seq 递增到 3，币种为 USD）',
    usdTurn && usdTurn.seq === 3 && usdTurn.currency === 'USD' && Math.abs(usdTurn.amount - usdExpected.amount) < 1e-9,
    usdTurn ? 'seq=' + usdTurn.seq + ' currency=' + usdTurn.currency + ' amount=' + usdTurn.amount : '无'
  )
  const cliEnv = { ...serverEnv }
  const cliTurn = await runCli(['turn'], cliEnv)
  check(
    'CLI 每轮消耗按币种显示（USD 轮次出现 $，不再写成 ¥）',
    cliTurn.code === 0 && /\$\s*\d/.test(cliTurn.stdout) && cliTurn.stdout.indexOf('¥') === -1,
    cliTurn.stdout.split('\n').slice(0, 2).join(' | ') + (cliTurn.stderr ? ' [stderr] ' + cliTurn.stderr.slice(0, 120) : '')
  )
  check(
    'CLI 逐档明细的单价也随币种（$ x/M 而非 ¥ x/M）',
    cliTurn.stdout.indexOf('× $') !== -1,
    cliTurn.stdout.split('\n').filter((l) => l.indexOf('×') !== -1).join(' | ').slice(0, 200)
  )
  const mcpOut = await runMcp([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whale_last_turn', arguments: {} } }], cliEnv)
  const mcpInit = mcpOut.find((m) => m.id === 1)
  const mcpTurn = mcpOut.find((m) => m.id === 2)
  const mcpText = mcpTurn && mcpTurn.result && mcpTurn.result.content && mcpTurn.result.content[0] ? mcpTurn.result.content[0].text : ''
  check(
    'MCP whale_last_turn 按币种显示（USD 轮次出现 $，不再写成 ¥）',
    mcpText && mcpText.indexOf('$') !== -1 && mcpText.indexOf('¥') === -1,
    mcpText.split('\n').slice(0, 2).join(' | ')
  )
  const pluginJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.zcode-plugin', 'plugin.json'), 'utf8'))
  const mcpVersion = mcpInit && mcpInit.result && mcpInit.result.serverInfo ? mcpInit.result.serverInfo.version : null
  check(
    'MCP 握手版本号与 plugin.json 一致（单一来源）',
    mcpVersion === pluginJson.version,
    'mcp=' + mcpVersion + ' plugin.json=' + pluginJson.version
  )

  // 预警设置归一：DS/BM 两个阈值合并成单一 moneyAlert，负数/非法值归 0
  const putRes = await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, alerts: { planPct: 20, moneyAlert: 5.5, deepseekBelow: -3, bigmodelDaily: 9 } }),
  })
  const putBody = await putRes.json()
  check(
    '预警设置写入并归一（moneyAlert 生效，旧键不再各自保留）',
    putRes.ok && putBody.alerts && putBody.alerts.planPct === 20 && putBody.alerts.moneyAlert === 5.5 && putBody.alerts.deepseekBelow === undefined,
    JSON.stringify(putBody.alerts)
  )
  const sizeBack = await getJson(port, '/whale/size.json')
  check('预警设置持久化回读', sizeBack && sizeBack.alerts && sizeBack.alerts.planPct === 20, JSON.stringify(sizeBack.alerts))
  // 旧配置迁移：模拟升级用户的文件（只有 DS¥/BM¥ 旧键、没有 moneyAlert），
  // 读出来应是 moneyAlert=deepseekBelow（先设过的那个），旧键不再保留
  const legacyState = JSON.parse(fs.readFileSync(path.join(dataDir, 'widget-state.json'), 'utf8'))
  legacyState.alerts = { planPct: 20, deepseekBelow: 7.5, bigmodelDaily: 3 }
  fs.writeFileSync(path.join(dataDir, 'widget-state.json'), JSON.stringify(legacyState), 'utf8')
  const legacyBack = await getJson(port, '/whale/size.json')
  check(
    '预警旧键迁移（deepseekBelow/bigmodelDaily → moneyAlert）',
    legacyBack &&
      legacyBack.alerts &&
      legacyBack.alerts.moneyAlert === 7.5 &&
      legacyBack.alerts.deepseekBelow === undefined,
    JSON.stringify(legacyBack.alerts)
  )

  // 角色库：内置小狐娘（默认）/小鲸鱼固定在前，上传件自动启用；未指定时默认小狐娘
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const upRes = await fetch('http://127.0.0.1:' + port + '/whale/role-upload.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '自检鲸鱼', dataUrl: tinyPng }),
  })
  const upBody = await upRes.json()
  check('角色上传成功并自动启用', upRes.ok && upBody.ok && typeof upBody.id === 'string', JSON.stringify(upBody))
  const roles1 = await getJson(port, '/whale/roles.json')
  check(
    '角色列表：内置小狐娘/小鲸鱼在前 + 上传件，selected 指向上传件',
    roles1 && roles1.ok && roles1.roles.length === 3 && roles1.roles[0].id === 'xiaohuniang' && roles1.roles[0].name === '小狐娘' && roles1.roles[1].id === 'whale' && roles1.roles[1].name === '小鲸鱼' && roles1.selected === upBody.id,
    JSON.stringify(roles1).slice(0, 200)
  )
  // 超过旧版全局 8KB body 上限的上传也应成功（真实头像截图普遍几十 KB 起）
  const bigDataUrl = 'data:image/png;base64,' + Buffer.alloc(15000, 97).toString('base64')
  const upBigRes = await fetch('http://127.0.0.1:' + port + '/whale/role-upload.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'big-selftest', dataUrl: bigDataUrl }),
  })
  const upBigBody = await upBigRes.json()
  check('超过 8KB 的角色上传成功', upBigRes.ok && upBigBody.ok === true, JSON.stringify(upBigBody))
  const imgRes = await fetch('http://127.0.0.1:' + port + '/whale/image.png')
  check('启用角色后 image.png 仍可用', imgRes.ok && (imgRes.headers.get('content-type') || '').indexOf('image/png') === 0, 'HTTP ' + imgRes.status)
  await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, roleId: null }),
  })
  const roles2 = await getJson(port, '/whale/roles.json')
  check('未指定角色 = 默认小狐娘（selected=xiaohuniang）', roles2 && roles2.ok && roles2.selected === 'xiaohuniang', JSON.stringify(roles2.selected))
  const imgDef = Buffer.from(await (await fetch('http://127.0.0.1:' + port + '/whale/image.png')).arrayBuffer())
  const glmPng = fs.readFileSync(path.join(PLUGIN_ROOT, 'assets', 'GLM.png'))
  check(
    '默认形象图 = 小狐娘 GLM.png（608x608）',
    imgDef.equals(glmPng) && imgDef.readUInt32BE(16) === 608 && imgDef.readUInt32BE(20) === 608,
    'len=' + imgDef.length
  )
  await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, roleId: 'whale' }),
  })
  const imgWhale = Buffer.from(await (await fetch('http://127.0.0.1:' + port + '/whale/image.png')).arrayBuffer())
  const whalePng = fs.readFileSync(path.join(PLUGIN_ROOT, 'assets', 'DSniang1.png'))
  check('切换小鲸鱼后 image.png 换成 DSniang1.png', imgWhale.equals(whalePng), 'len=' + imgWhale.length)

  // 角色改名：导入件可改名，内置形象拒绝
  const rnRes = await fetch('http://127.0.0.1:' + port + '/whale/role-rename.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: upBody.id, name: '改过名的鲸鱼' }),
  })
  const rnBody = await rnRes.json()
  const rnHit = rnBody.roles ? rnBody.roles.find((r) => r && r.id === upBody.id) : null
  check('导入角色改名成功', rnRes.ok && rnBody.ok === true && !!rnHit && rnHit.name === '改过名的鲸鱼', JSON.stringify(rnHit))
  const rnBuiltin = await fetch('http://127.0.0.1:' + port + '/whale/role-rename.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'xiaohuniang', name: '不许改' }),
  })
  const rnBuiltinBody = await rnBuiltin.json()
  check('内置形象不可改名', rnBuiltin.status === 400 && rnBuiltinBody.ok === false, JSON.stringify(rnBuiltinBody))

  // 角色删除：索引 + 图片文件一起清；删掉的正好是当前形象时回落默认角色
  const delUp = await fetch('http://127.0.0.1:' + port + '/whale/role-upload.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '待删除', dataUrl: tinyPng }),
  })
  const delUpBody = await delUp.json()
  const beforeDel = await getJson(port, '/whale/roles.json')
  const delRes = await fetch('http://127.0.0.1:' + port + '/whale/role-delete.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: delUpBody.id }),
  })
  const delBody = await delRes.json()
  const afterIds = (delBody.roles || []).map((r) => r.id)
  check(
    '导入角色删除（索引 + 文件 + 选中回落默认小狐娘）',
    delRes.ok &&
      delBody.ok === true &&
      afterIds.indexOf(delUpBody.id) === -1 &&
      delBody.selected === 'xiaohuniang' &&
      afterIds.length === beforeDel.roles.length - 1,
    JSON.stringify({ selected: delBody.selected, n: afterIds.length })
  )
  const delImgRes = await fetch('http://127.0.0.1:' + port + '/whale/image.png')
  check('删除当前形象后 image.png 仍可用（回落默认图）', delImgRes.ok, 'HTTP ' + delImgRes.status)
  const delBuiltin = await fetch('http://127.0.0.1:' + port + '/whale/role-delete.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'whale' }),
  })
  const delBuiltinBody = await delBuiltin.json()
  check('内置形象不可删除', delBuiltin.status === 400 && delBuiltinBody.ok === false, JSON.stringify(delBuiltinBody))

  // 按压泡泡（v2 点击序列 + 模块行）：默认空、v2 写入归一、v1 迁移、持久化回读
  const bc0 = await getJson(port, '/whale/bubble-content.json')
  check(
    '按压泡泡默认空（v2, steps=[], tapAdvance=true）',
    bc0 && bc0.ok === true && bc0.v === 2 && bc0.tapAdvance === true && Array.isArray(bc0.steps) && bc0.steps.length === 0,
    JSON.stringify(bc0)
  )
  const manySteps = []
  for (let i = 0; i < 20; i++) {
    manySteps.push({ modules: [{ type: 'text', text: 'x'.repeat(300), size: 'Z' }] })
  }
  const bcPost = await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 2,
      tapAdvance: false,
      steps: [{ modules: [{ type: 'text', text: '第一行\n第二行', size: 'B' }, { type: 'text', text: '   ', size: 'A' }] }].concat(manySteps),
    }),
  })
  const bcBody = await bcPost.json()
  check(
    '按压泡泡 v2 写入归一（空白模块丢弃 / 最多 12 步 / 每行 200 字 / 非法字号回 A / tapAdvance 保留）',
    bcPost.ok &&
      bcBody.ok === true &&
      bcBody.v === 2 &&
      bcBody.tapAdvance === false &&
      bcBody.steps.length === 12 &&
      bcBody.steps[0].modules.length === 1 &&
      bcBody.steps[0].modules[0].size === 'B' &&
      bcBody.steps[0].modules[0].text === '第一行\n第二行',
    JSON.stringify({ n: bcBody.steps.length, mods: bcBody.steps[0].modules.length, size: bcBody.steps[0].modules[0].size })
  )
  const bcBack = await getJson(port, '/whale/bubble-content.json')
  check(
    '按压泡泡持久化回读一致',
    bcBack && bcBack.v === 2 && bcBack.steps.length === 12 && bcBack.steps[0].modules[0].text === '第一行\n第二行',
    JSON.stringify(bcBack).slice(0, 120)
  )
  // 「内置视图」模块（v1.5.2）：整泡语义，既不被当空模块过滤、也不被当空步丢弃
  const bcView = await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 2, tapAdvance: true, steps: [{ modules: [{ type: 'view', size: 'A' }] }, { modules: [{ type: 'text', text: '第二泡' }] }, { modules: [] }] }),
  })
  const bcViewBody = await bcView.json()
  check(
    '按压泡泡「内置视图」步保留（空模块步仍丢弃）',
    bcViewBody.ok === true &&
      bcViewBody.steps.length === 2 &&
      bcViewBody.steps[0].modules.length === 1 &&
      bcViewBody.steps[0].modules[0].type === 'view' &&
      bcViewBody.steps[1].modules[0].text === '第二泡',
    JSON.stringify(bcViewBody).slice(0, 200)
  )
  // v1 旧配置 POST → 迁移成 v2（first → 第 1 步，items → 后续步）
  const bcMig = await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, first: { text: '旧配置首次', size: 'A' }, items: [{ text: '旧配置第二条', size: 'C' }, { text: '  ', size: 'A' }] }),
  })
  const bcMigBody = await bcMig.json()
  check(
    '按压泡泡 v1 配置自动迁移（first→步1 / items→步2+ / 空条目丢弃）',
    bcMigBody.ok === true &&
      bcMigBody.v === 2 &&
      bcMigBody.steps.length === 2 &&
      bcMigBody.steps[0].modules[0].text === '旧配置首次' &&
      bcMigBody.steps[1].modules[0].size === 'C',
    JSON.stringify(bcMigBody).slice(0, 160)
  )
  await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 2, tapAdvance: true, steps: [] }),
  })
  const bcReset = await getJson(port, '/whale/bubble-content.json')
  check('按压泡泡可恢复默认（清空序列）', bcReset && bcReset.v === 2 && bcReset.steps.length === 0, JSON.stringify(bcReset).slice(0, 80))

  // 余额校正接口：GET 汇总 + POST 落账（自检环境无 DeepSeek 账本，应为空本形态）
  const adjGet = await getJson(port, '/whale/balance-adjustments.json')
  check('余额校正 GET 返回汇总', adjGet && adjGet.ok === true && adjGet.hasBook === false, JSON.stringify(adjGet))
  const adjPost = await fetch('http://127.0.0.1:' + port + '/whale/balance-adjustments.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credits: 10, otherDebits: 2 }),
  })
  const adjBody = await adjPost.json()
  check(
    '余额校正 POST 落账（credits=10/otherDebits=2）',
    adjPost.ok && adjBody.ok && adjBody.credits === 10 && adjBody.otherDebits === 2 && adjBody.needsReview === false,
    JSON.stringify(adjBody)
  )
  const adjBad = await fetch('http://127.0.0.1:' + port + '/whale/balance-adjustments.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credits: -5, otherDebits: 0 }),
  })
  const adjBadBody = await adjBad.json()
  check('负数金额被拒绝', adjBad.ok && adjBadBody.ok === false, JSON.stringify(adjBadBody))

  // 挂件配置：displayMode（智能切换的手动覆盖）写读往返；非法值回落 auto
  const dmPut = await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, displayMode: 'plan' }),
  })
  const dmGet = await getJson(port, '/whale/size.json')
  check('displayMode 写入并持久化回读', dmPut.ok && dmGet.displayMode === 'plan', 'displayMode=' + dmGet.displayMode)
  await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, displayMode: 'hacker' }),
  })
  const dmBad = await getJson(port, '/whale/size.json')
  check('displayMode 非法值被丢弃（保留原值）', dmBad.displayMode === 'plan', 'displayMode=' + dmBad.displayMode)

  // 安全路由：Host 校验（防 DNS rebinding）/ Origin 校验（防跨站写）/ 关闭令牌
  function rawRequest(method, requestPath, headers, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path: requestPath, headers: headers || {}, timeout: 3000 },
        (res) => {
          let buf = ''
          res.on('data', (c) => (buf += c))
          res.on('end', () => resolve({ status: res.statusCode, body: buf }))
        }
      )
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
  }
  const badHost = await rawRequest('GET', '/whale/health', { host: 'evil.example:' + port })
  check('伪造 Host 头被 403', badHost.status === 403, 'HTTP ' + badHost.status)
  const crossOrigin = await rawRequest(
    'PUT',
    '/whale/size.json',
    { host: '127.0.0.1:' + port, origin: 'http://evil.example', 'content-type': 'application/json' },
    JSON.stringify({ scale: 2 })
  )
  check('跨 Origin 写请求被 403', crossOrigin.status === 403, 'HTTP ' + crossOrigin.status)
  const badToken = await rawRequest('POST', '/whale/shutdown', { host: '127.0.0.1:' + port, 'x-whale-token': 'wrong-token' })
  check('错误令牌关闭被 403', badToken.status === 403, 'HTTP ' + badToken.status)
  const noToken = await rawRequest('POST', '/whale/shutdown', { host: '127.0.0.1:' + port })
  check('无令牌关闭被 403', noToken.status === 403, 'HTTP ' + noToken.status)

  // 服务重启：seq 必须从持久化值续上——否则重启后已打开的页面对齐在旧计数上，
  // 新服务的每一轮都会被当成"旧轮次"，每轮消耗气泡静默失效
  const seqBeforeRestart = (await getJson(port, '/whale/last-turn.json')).seq
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill()
  })
  child = spawnServer()
  const health2 = await waitReady(port, 8000)
  check('重启后服务重新就绪', !!health2, health2 ? 'pid=' + health2.pid : childLog.slice(-200))
  const afterRestart = await getJson(port, '/whale/last-turn.json')
  check(
    '重启后 seq 从持久化值续上（对齐不回退）',
    afterRestart && afterRestart.seq === seqBeforeRestart && afterRestart.turn === null,
    '重启前 seq=' + seqBeforeRestart + '，重启后 ' + JSON.stringify(afterRestart)
  )
  insertTurn('sess_selftest', 'turn_D', USAGE_B, Date.now())
  let fourth = null
  const deadlineD = Date.now() + 6000
  while (Date.now() < deadlineD) {
    await new Promise((r) => setTimeout(r, 400))
    fourth = await getJson(port, '/whale/last-turn.json')
    if (fourth.seq > seqBeforeRestart) break
  }
  check(
    '重启后新一轮 seq 继续单调递增',
    fourth && fourth.seq === seqBeforeRestart + 1 && fourth.turn === 'turn_D',
    JSON.stringify(fourth ? { seq: fourth.seq, turn: fourth.turn } : fourth)
  )

  // v1.4.2：多行套餐轮求和——model_usage 一行是一次 API 请求，长 agent 轮
  // 有几十行（上下文逐请求增长），取「最大单行」会少算一到两个数量级
  // （实测 38 行轮 sum=9.97M vs 单行最大 275k，显示 0.28% 而非 9.97%）
  const atE = Date.now()
  const planRows = [
    { model: 'GLM-5.3-Flash', providerId: 'account:zai-start-plan', usage: { input_tokens: 400_000, cache_read_input_tokens: 350_000, output_tokens: 50_000, computed_total_tokens: 400_000 } },
    { model: 'GLM-5.3-Flash', providerId: 'account:zai-start-plan', usage: { input_tokens: 300_000, cache_read_input_tokens: 250_000, output_tokens: 50_000, computed_total_tokens: 300_000 } },
    { model: 'GLM-5.3-Flash', providerId: 'account:zai-start-plan', usage: { input_tokens: 250_000, cache_read_input_tokens: 200_000, output_tokens: 50_000, computed_total_tokens: 250_000 } },
  ]
  insertTurn('sess_selftest', 'turn_E', USAGE_B, atE, planRows)
  let fifth = null
  const deadlineE = Date.now() + 6000
  while (Date.now() < deadlineE) {
    await new Promise((r) => setTimeout(r, 400))
    fifth = await getJson(port, '/whale/last-turn.json')
    if (fifth.seq > seqBeforeRestart + 1) break
  }
  // 行 tokens 口径 = 命中+未命中+缓存写+输出（与计费一致），三行分别是
  // 450k/350k/300k（input 全部带 cache_read 时 = input+output）
  const sumTokens = 1_100_000
  const expectSumPct = Math.round((sumTokens / 104_000_000) * 10000) / 100
  check(
    '多行套餐轮按全行求和（planTokens=1.1M，planPct 同基数）',
    fifth && fifth.turn === 'turn_E' && fifth.planTurn === true && fifth.planTokens === sumTokens && fifth.planPct === expectSumPct,
    '期望 ' + sumTokens + ' tokens / ' + expectSumPct + '%，实际 ' + (fifth && fifth.planTokens) + ' / ' + (fifth && fifth.planPct) + '%'
  )

  // 智能跟随：selection 优先；不可识别时回落最近 model_usage（对话发起时识别）
  db.prepare('INSERT INTO session_entry (type, data, time_updated) VALUES (?, ?, ?)').run(
    'runtime/model_selection',
    JSON.stringify({ modelSelection: { providerId: 'bigmodel-standard-api', modelId: 'GLM-5.3-Flash' } }),
    Date.now()
  )
  const sel1 = await getJson(port, '/whale/session.json')
  check(
    'session.json：输入框选择即生效（bigmodel URL → glm 源）',
    sel1 && sel1.ok && sel1.from === 'selection' && sel1.source === 'glm' && sel1.label === 'GLM 按量',
    JSON.stringify(sel1).slice(0, 160)
  )
  db.prepare('UPDATE session_entry SET data = ?, time_updated = ? WHERE type = ?').run(
    JSON.stringify({ modelSelection: { providerId: 'xiaomi-mimo', modelId: 'mimo-v2.6-pro' } }),
    Date.now() + 1,
    'runtime/model_selection'
  )
  const sel2 = await getJson(port, '/whale/session.json')
  check(
    'session.json：MiMo 无 URL 信息默认 mimo-api（平价无时段行）',
    sel2 && sel2.ok && sel2.source === 'mimo-api' && sel2.timeMode === 'none',
    JSON.stringify(sel2).slice(0, 160)
  )
  insertTurn('sess_sel', 'turn_sel', { input_tokens: 1000, output_tokens: 100 }, Date.now() + 10, [
    { model: 'kimi-k3', providerId: 'moonshot-kimi', usage: { input_tokens: 1000, output_tokens: 100 } },
  ])
  db.prepare('UPDATE session_entry SET data = ?, time_updated = ? WHERE type = ?').run(
    JSON.stringify({ modelSelection: { providerId: 'mystery-corp', modelId: 'totally-unknown-9000' } }),
    Date.now() + 2,
    'runtime/model_selection'
  )
  const sel3 = await getJson(port, '/whale/session.json')
  check(
    'session.json：selection 不可识别时回落 model_usage（kimi-k3 → kimi 源）',
    sel3 && sel3.ok && sel3.from === 'model-usage' && sel3.source === 'kimi' && sel3.modelId === 'kimi-k3',
    JSON.stringify(sel3).slice(0, 160)
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
