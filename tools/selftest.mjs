// 自检：在不触碰用户真实数据的前提下，端到端验证「每轮对话消耗」链路。
//
// 做法是把 ZCODE_HOME 指向一个临时目录，在里面伪造一个最小化的 ZCode 会话库
// （turn_usage / model_usage 两张表），再拉起一个挂件服务实例，然后插入一条新的
// 已完成轮次，观察 /whale/last-turn.json 的 seq 是否从 0 递增到 1 且金额与定价
// 换算一致。顺带验证 health 接口与令牌关闭。
//
//   node tools/selftest.mjs
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { costOfUsage, priceFor, isPeakTime, nextPeakChange, resolveVendor, resolvePricing, normalizeModelId } from '../lib/pricing.mjs'
import { shapePlanPayload, turnPlanUsage, extraAmountsOfTurn, quotaBucketForModel, readPlanBalance, readPlanQuota, invalidatePlanCache, readLogFile } from '../lib/plan-balance.mjs'
import { shapeQuotaPayload, windowLabel, fetchGlmPlanQuota, GLM_PLAN_QUOTA_URL, GLM_PLAN_QUOTA_HOSTS } from '../lib/glm-plan-api.mjs'
import { getPath, TEMPLATES, fetchFromTemplate, pickVendorBalance, listVendorStatus } from '../lib/vendors.mjs'
import { isBlockedHost } from '../lib/blocked-host.mjs'
import { matchTemplateId, buildProviderEntries, invalidateDiscoverCache } from '../lib/discover.mjs'
import { balanceSplit, computeTodayUsage, resolveTodayUsage, pickBalanceInfo, platformUsageUrl } from '../lib/balance.mjs'
import { mapZcodeTheme, themeOfConfig, resolveZcodeTheme } from '../lib/zcode-theme.mjs'
import { safeMirrorUrl, isOwnOverlayCommandLine, runtimePaths } from '../lib/overlay.mjs'
import { MODEL_ROLE_RULES, roleIdForModel, BUILTIN_ROLES } from '../lib/paths.mjs'
import { assertSafeUpstream, findApiKey, readPluginConfig } from '../lib/credentials.mjs'
import { resolveBillingSource, isNightOffpeak } from '../lib/source.mjs'
import { buildWatchVbs, installWatch, uninstallWatch, watchStatus, loadRuntimeEnv } from '../lib/watch-install.mjs'

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
// v1.7.8 套餐切换间隙的空桶快照：真实日志里新套餐窗口开始前会有 balances=[]
// 的过渡观测（实测 2026-10-02 末尾连续 4 条）。把它垫在好观测**之后**，
// plan.json 端到端断言即验证「按行从新到旧跳过空桶、取最近的有效观测」
const planEmptyLine =
  '[2026-09-29 08:42:28.001] [info] [pid:1] [main] [host-log] (local-1) [host] [2026-09-29 08:42:28.001] [pid:2] [usage-stats] billing/balance 请求完成 ' +
  JSON.stringify({
    balances: [],
    payload: { code: 0, data: { server_time: Math.floor(Date.now() / 1000), plans: PLAN_FIXTURE.payload.data.plans, balances: [] } },
  }) +
  '\n'
fs.writeFileSync(
  path.join(planLogDir, todayKeyForLog() + '.log'),
  Buffer.concat([planJunkHead, Buffer.from('\n' + planLogLine), planJunkTail, Buffer.from('\n' + planEmptyLine)])
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
          ... [['volcengine-ark', '/api/v3'], ['volc-plan-test', '/api/coding/v3'], ['9de0b0cd-43cc-4b9d-867c-32030235e990', '/api/plan/v3']].map(([providerId, pathname]) => ({
            providerId, config: { api: { baseUrl: 'https://ark.cn-beijing.volces.com' + pathname } },
          })),
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

// 挑一个真的空闲的端口：服务发现端口被占会自动改试 +1（lib/server.mjs listen 的
// attemptsLeft 回退），而测试只认自己写进 config 的 PORT——一旦被占（例如另一条
// 产品线的自检同时在跑：两边都是从 39100 起的随机池），就会报「服务在临时端口就绪」
// 的假失败。所以先探一下端口空闲再落进 config。
async function pickFreePort(min, max) {
  for (let i = 0; i < 50; i++) {
    const p = min + Math.floor(Math.random() * (max - min))
    const free = await new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(p, '127.0.0.1')
    })
    if (free) return p
  }
  throw new Error('挑不到空闲端口（' + min + '-' + max + '）')
}

const PORT = await pickFreePort(39100, 39600)
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: PORT }), 'utf8')

// ZCode 自己的用户配置（<ZCODE_HOME>/cli/config.json）：挂件「跟随 ZCode 主题」
// 读它的 ui.theme。这里放 zai-dark，验证 zai-* 皮肤 → 挂件浅/深的映射。
fs.mkdirSync(path.join(tmpHome, 'cli'), { recursive: true })
fs.writeFileSync(
  path.join(tmpHome, 'cli', 'config.json'),
  JSON.stringify({ ui: { locale: 'zh-CN', theme: 'zai-dark' } }, null, 2),
  'utf8'
)

const dbFile = path.join(dbDir, 'db.sqlite')
const db = new DatabaseSync(dbFile)
// 服务端只读轮询与测试写入并发；WAL + busy_timeout 避免偶发 SQLITE_BUSY。
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 10000')
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
  // GPT-6 系列（2026-10-03 官网价）：astra 旗舰之上 / 6.1-sol 旗舰 / luna 迷你，
  // 同 272K 分档；带日期后缀的模型名靠前缀匹配
  const g6aLo = resolvePricing({ model: 'gpt-6-astra', inTokens: 200000 })
  const g6aHi = resolvePricing({ model: 'gpt-6-astra', inTokens: 300000 })
  check(
    'GPT-6 系列 272K 分档（astra $10/$50→$20/$75；6.1-sol $2/$10；luna $0.1/$0.5）',
    g6aLo.miss[0] === 10 &&
      g6aHi.miss[0] === 20 &&
      g6aLo.out[0] === 50 &&
      g6aHi.out[0] === 75 &&
      resolvePricing({ model: 'gpt-6.1-sol', inTokens: 100000 }).miss[0] === 2 &&
      resolvePricing({ model: 'gpt-6.1-sol', inTokens: 100000 }).out[0] === 10 &&
      resolvePricing({ model: 'gpt-6-luna', inTokens: 100000 }).miss[0] === 0.1 &&
      resolvePricing({ model: 'gpt-6.1-sol-20261001', inTokens: 100000 }).miss[0] === 2,
    JSON.stringify({ astraLo: g6aLo.miss, astraHi: g6aHi.miss })
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
  // MiniMax M3.1-Flash（2026-10-24 官网）：输入 1 / 输出 4 / 缓存读 0.1，无缓存写列
  const mm31 = resolvePricing({ model: 'MiniMax-M3.1-Flash' })
  check(
    'MiniMax-M3.1-Flash 官方价（1/4/0.1，缓存写 0）',
    mm31.kind === 'flat' &&
      mm31.miss[0] === 1 &&
      mm31.out[0] === 4 &&
      mm31.hit[0] === 0.1 &&
      mm31.cw[0] === 0,
    JSON.stringify(mm31)
  )
  // Kimi：缓存写按 TTL 计价，无 TTL 信息按默认 5min 档（k3 写价 20）
  const kimi = costOfUsage(
    'kimi-k3',
    { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000, output_tokens: 0 },
    at
  )
  check('Kimi 缓存写按默认 5min TTL 档计价', kimi.billable && Math.abs(kimi.amount - 20) < 1e-9, 'amount=' + kimi.amount)
  // Kimi K3.1 Pro（2026-10-24 官方价目）：输入 13 / 输出 68 / 缓存读 1.3 / 写 13；
  // highspeed 26 / 136 / 1.3 / 26。简写 k3.1-pro 也要命中同一档，不能落回 K3。
  const k31 = resolvePricing({ model: 'kimi-k3.1-pro' })
  const k31h = resolvePricing({ model: 'kimi-k3.1-pro-highspeed' })
  const k31alias = resolvePricing({ model: 'k3.1-pro' })
  const k31cw = costOfUsage(
    'kimi-k3.1-pro',
    { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000, output_tokens: 0 },
    at
  )
  check(
    'Kimi K3.1 Pro 官方价（13/68/1.3/13；highspeed 26/136/1.3/26，简写同价）',
    k31.kind === 'flat' &&
      k31.miss[0] === 13 &&
      k31.out[0] === 68 &&
      k31.hit[0] === 1.3 &&
      k31.cw[0] === 13 &&
      k31h.miss[0] === 26 &&
      k31h.out[0] === 136 &&
      k31h.hit[0] === 1.3 &&
      k31h.cw[0] === 26 &&
      k31alias.miss[0] === 13 &&
      Math.abs(k31cw.amount - 13) < 1e-9,
    JSON.stringify({ k31, k31h, k31alias, cwAmount: k31cw.amount })
  )
  // GPT-5.6-cyber（2026-10-03 官网+LiteLLM 双源）：272K 整单分档
  const cyberLo = resolvePricing({ model: 'gpt-5.6-cyber', inTokens: 100000 })
  const cyberHi = resolvePricing({ model: 'gpt-5.6-cyber', inTokens: 300000 })
  check(
    'GPT-5.6-cyber 272K 分档（$12.5/$75 → $25/$112.5，读 1.25 / 写 15.625）',
    cyberLo.miss[0] === 12.5 &&
      cyberHi.miss[0] === 25 &&
      cyberLo.out[0] === 75 &&
      cyberHi.out[0] === 112.5 &&
      cyberLo.hit[0] === 1.25 &&
      cyberLo.cw[0] === 15.625,
    JSON.stringify({ lo: cyberLo.miss, hi: cyberHi.miss })
  )
  // Kimi 下线模型清除（2026-10-10 复核，docs/models：kimi-latest / k2.5 /
  // 快照版 / moonshot-v1 系均下线迁移 k3）——旧名按「无价目、仅统计 tokens」
  const kmDead = costOfUsage('kimi-k2.5', { input_tokens: 1_000_000, output_tokens: 0 }, at)
  check(
    'Kimi 下线条目移除：旧名不计价，k3/k2.7-code/k2.6 保留',
    kmDead && kmDead.billable === false &&
      resolvePricing({ model: 'kimi-latest' }).kind === 'none' &&
      resolvePricing({ model: 'moonshot-v1-128k' }).kind === 'none' &&
      resolvePricing({ model: 'kimi-k3' }).miss[0] === 20 &&
      resolvePricing({ model: 'kimi-k2.7-code' }).miss[0] === 6.5 &&
      resolvePricing({ model: 'kimi-k2.6' }).out[0] === 27,
    'k25 billable=' + (kmDead && kmDead.billable)
  )
  // DeepSeek V4.1-Flash 调价（2026-10-10 官网）：flash 输入 1/2、输出 4/8、
  // 命中 0.02/0.04（空闲/高峰）；旧名 v4-flash 同价承接；pro 不变
  const dsP = priceFor('deepseek-flash')
  check(
    'DeepSeek flash 调价（miss 1/2、out 4/8、hit 0.02/0.04），旧名同价，pro 不变',
    dsP.miss[0] === 1 && dsP.miss[1] === 2 && dsP.out[0] === 4 && dsP.out[1] === 8 &&
      dsP.hit[0] === 0.02 && dsP.hit[1] === 0.04 &&
      priceFor('deepseek-v4-flash').miss[1] === 2 &&
      priceFor('deepseek-v4-pro').miss[1] === 9.0,
    JSON.stringify({ miss: dsP.miss, out: dsP.out, hit: dsP.hit })
  )
  // OpenAI 2026-10-10 增补：gpt-6-sol（6.0 旗舰）/ gpt-5.3 / gpt-5.5-pro / gpt-5.5-cyber
  check(
    'OpenAI 增补条目：6-sol $2/$10；5.3 $1.75/$14；5.5-pro $30/$180；5.5-cyber 272K 分档',
    resolvePricing({ model: 'gpt-6-sol', inTokens: 100000 }).miss[0] === 2 &&
      resolvePricing({ model: 'gpt-6-sol', inTokens: 100000 }).out[0] === 10 &&
      resolvePricing({ model: 'gpt-6-sol', inTokens: 300000 }).miss[0] === 4 &&
      resolvePricing({ model: 'gpt-5.3-codex' }).miss[0] === 1.75 &&
      resolvePricing({ model: 'gpt-5.5-pro' }).out[0] === 180 &&
      resolvePricing({ model: 'gpt-5.5-cyber', inTokens: 100000 }).miss[0] === 12.5 &&
      resolvePricing({ model: 'gpt-5.5-cyber', inTokens: 300000 }).out[0] === 112.5,
    JSON.stringify({
      sol: resolvePricing({ model: 'gpt-6-sol', inTokens: 100000 }).miss,
      pro: resolvePricing({ model: 'gpt-5.5-pro' }).out,
    })
  )
  // Claude 2026-10-10：sonnet-5-5 缓存读修正 0.1；haiku-5-5 按 100K 输入整单
  // 分档（>100K ×5）；mythos 系与 fable 同价
  const haikuLo = resolvePricing({ model: 'claude-haiku-5-5', inTokens: 50000 })
  const haikuHi = resolvePricing({ model: 'claude-haiku-5-5', inTokens: 200000 })
  check(
    'Claude 增补与修正：sonnet-5-5 读 0.1；haiku-5-5 100K 分档（$0.1→$0.5）；mythos 同 fable',
    resolvePricing({ model: 'claude-sonnet-5-5' }).hit[0] === 0.1 &&
      haikuLo.tier === '<=100K' && haikuLo.miss[0] === 0.1 && haikuLo.out[0] === 0.5 &&
      haikuHi.tier === '>100K' && haikuHi.miss[0] === 0.5 && haikuHi.out[0] === 2.5 &&
      resolvePricing({ model: 'claude-mythos-5-1' }).miss[0] === 10 &&
      resolvePricing({ model: 'claude-mythos-5' }).hit[0] === 1,
    JSON.stringify({ lo: haikuLo.miss, hi: haikuHi.miss })
  )
  // Qwen 2026-10-10 补齐：qwen3.6-plus / qwen3.6-flash / qwen3.5-flash 分档
  const q36p = resolvePricing({ model: 'qwen3.6-plus', inTokens: 100000 })
  const q36f = resolvePricing({ model: 'qwen3.6-flash', inTokens: 300000 })
  const q35f = resolvePricing({ model: 'qwen3.5-flash', inTokens: 200000 })
  check(
    'Qwen 补齐：3.6-plus ≤256K ¥2/¥12；3.6-flash >256K ¥4.8/¥28.8；3.5-flash 128K-256K ¥0.8/¥8',
    q36p.miss[0] === 2 && q36p.out[0] === 12 &&
      q36f.tier === '256K-1M' && q36f.miss[0] === 4.8 && q36f.out[0] === 28.8 &&
      q35f.tier === '128K-256K' && q35f.miss[0] === 0.8 && q35f.out[0] === 8,
    JSON.stringify({ p: q36p.miss, f: q36f.miss, f35: q35f.miss })
  )
  // Gemini 全家桶（2026-10-15 官方价抓取）：4 Argon 促销价 + ar 短名 + 3.1 Pro 200K
  // 分档 + 缓存写无按 token 价目记 0（隐式缓存只收缓存读）
  const arFlat = resolvePricing({ model: 'gemini-4-argon', inTokens: 400000 })
  const arAlias = resolvePricing({ model: 'gemini-4-ar' })
  const proLo = resolvePricing({ model: 'gemini-3.1-pro-preview', inTokens: 150000 })
  const proHi = resolvePricing({ model: 'gemini-3.1-pro-preview', inTokens: 300000 })
  check(
    'Gemini 全家桶：4 Ar 促销 $2/$10、缓存读 $0.10、缓存写记 0（输入档不影响）；3.1 Pro 200K 整单取档（$2/$12 → $4/$18）',
    arFlat.vendor === 'gemini' && arFlat.currency === 'USD' &&
      arFlat.tier === 'flat' && arFlat.miss[0] === 2 && arFlat.out[0] === 10 && arFlat.hit[0] === 0.1 && arFlat.cw[0] === 0 &&
      arAlias.miss[0] === 2 &&
      proLo.tier === '<=200K' && proLo.miss[0] === 2 && proLo.out[0] === 12 &&
      proHi.tier === '>200K' && proHi.miss[0] === 4 && proHi.out[0] === 18,
    JSON.stringify({ ar: [arFlat.miss, arFlat.out, arFlat.hit, arFlat.cw], proLo: proLo.miss, proHi: proHi.miss })
  )
  check(
    'Gemini 网关前缀与其余在售族：google/ 网关、3.8/3.6 Flash、3.5/3.1 Flash-Lite、3 Flash preview、2.5 系各自命中',
    resolvePricing({ providerId: 'google', model: 'whatever' }).vendor === 'gemini' &&
      resolvePricing({ model: 'google/gemini-4-argon' }).vendor === 'gemini' &&
      resolvePricing({ model: 'gemini-3.8-flash' }).miss[0] === 0.75 &&
      resolvePricing({ model: 'gemini-3.6-flash' }).out[0] === 3.75 &&
      resolvePricing({ model: 'gemini-3.5-flash-lite' }).miss[0] === 0.3 &&
      resolvePricing({ model: 'gemini-3.1-flash-lite' }).out[0] === 1.5 &&
      resolvePricing({ model: 'gemini-3-flash-preview' }).miss[0] === 0.5 &&
      resolvePricing({ model: 'gemini-2.5-pro', inTokens: 250000 }).tier === '>200K' &&
      resolvePricing({ model: 'gemini-2.5-flash' }).miss[0] === 0.3 &&
      resolvePricing({ model: 'gemini-2.5-flash-lite' }).out[0] === 0.4,
    JSON.stringify({
      gw: resolvePricing({ providerId: 'google', model: 'whatever' }).vendor,
      f38: resolvePricing({ model: 'gemini-3.8-flash' }).miss,
      p25: resolvePricing({ model: 'gemini-2.5-pro', inTokens: 250000 }).tier,
    })
  )
  check(
    'Gemini 非文本族不套文本价（veo / imagen / embedding 只计 tokens）',
    resolvePricing({ model: 'veo-3.1-generate' }).kind === 'none' &&
      resolvePricing({ model: 'gemini-3-pro-image-preview' }).kind === 'none' &&
      resolvePricing({ model: 'text-embedding-005' }).kind === 'none',
    JSON.stringify([resolvePricing({ model: 'veo-3.1-generate' }).kind, resolvePricing({ model: 'text-embedding-005' }).kind])
  )
  // 未知模型不套任何价目（含「仅 provider 名沾 DeepSeek」的误配场景）
  const unknown = costOfUsage('mystery-9000', { input_tokens: 1000, output_tokens: 10 }, at, 'weird-corp')
  const providerOnly = costOfUsage('totally-unknown', { input_tokens: 1000, output_tokens: 10 }, at, 'deepseek')
  check(
    '未知模型只计 tokens 不折算金额（不再套 DeepSeek 价）',
    unknown.billable === false && unknown.amount === 0 && providerOnly.billable === false && providerOnly.amount === 0
  )
}

// GLM Plan 日志解析：纯函数校验 shapePlanPayload
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
  // 单位声明：日志源是 token、直连套餐接口源是额度点数——两边的百分比只在同单位
  // 下可比（turnPlanUsage 用 unit 守卫，防「tokens ÷ 点数」的假百分比）
  check('Plan 日志解析：单位声明为 tokens（与接口源的 credits 区分）', shaped && shaped.unit === 'tokens', String(shaped && shaped.unit))

  // —— GLM Plan 直连套餐接口（issue #3）：形状 / 取源链 / 出站白名单 ——
  // 形状 A（现役 individual-coding-plan，实测 2026-10-16 lite 档）：limits[] 平铺
  const apiFlat = shapeQuotaPayload({
    code: 200,
    success: true,
    data: {
      level: 'lite',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 2000, percentage: 0 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 2000, currentValue: 1841, remaining: 158, percentage: 92, nextResetTime: 1792656212983 },
      ],
    },
  })
  check(
    'GLM 套餐接口：平铺形状（CREDIT_LIMIT）→ 两窗口 + 主窗口取「剩余最低」那条',
    !!apiFlat &&
      apiFlat.ok &&
      apiFlat.source === 'glm-plan-api' &&
      apiFlat.unit === 'credits' &&
      apiFlat.level === 'lite' &&
      apiFlat.windows.length === 2 &&
      apiFlat.windows[0].label === '5 小时' &&
      apiFlat.windows[1].label === '本周' &&
      apiFlat.primaryWindow === '本周' &&
      apiFlat.remaining === 158 &&
      apiFlat.total === 2000 &&
      // 剩余 = 158 / 2000 = 7.9%（与接口的「已用 92%」互为印证）
      Math.abs(apiFlat.percentRemaining - 0.079) < 1e-9 &&
      Math.abs(apiFlat.percentUsed - 0.92) < 1e-9 &&
      apiFlat.nextResetAt === 1792656212983,
    JSON.stringify(apiFlat && { w: apiFlat.windows, primary: apiFlat.primaryWindow, pct: apiFlat.percentRemaining })
  )
  const apiFull = shapeQuotaPayload({
    data: { level: 'pro', limits: [{ type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 1000, currentValue: 1000, remaining: 0, percentage: 100 }] },
  })
  check(
    'GLM 套餐接口：百分比与 remaining/total 互为印证（用完的窗口剩余 0%）',
    !!apiFull && apiFull.percentRemaining === 0 && apiFull.percentUsed === 1 && apiFull.primaryWindow === '本周',
    JSON.stringify(apiFull && { pct: apiFull.percentRemaining, used: apiFull.percentUsed })
  )
  // 形状 B（老套餐账号 / zhipu-quota 模板沿用）：limits[].TOKENS_LIMIT.*
  const apiNested = shapeQuotaPayload({
    data: { limits: [{ name: 'GLM-5.3', TOKENS_LIMIT: { percentage: 37.5, remaining: 62500000, total: 100000000 } }] },
  })
  check(
    'GLM 套餐接口：嵌套形状（TOKENS_LIMIT）照样收（老套餐账号兼容）',
    !!apiNested &&
      apiNested.windows.length === 1 &&
      apiNested.windows[0].label === 'GLM-5.3' &&
      apiNested.windows[0].percentUsed === 37.5 &&
      apiNested.remaining === 62500000 &&
      Math.abs(apiNested.percentRemaining - 0.625) < 1e-9,
    JSON.stringify(apiNested && apiNested.windows)
  )
  check(
    'GLM 套餐接口：认不出的响应不硬猜（返回 null，调用方回落到日志源）',
    shapeQuotaPayload({ code: 200, data: { limits: [] } }) === null &&
      shapeQuotaPayload({ code: 200, data: { facts: 'nope' } }) === null &&
      shapeQuotaPayload(null) === null &&
      shapeQuotaPayload({ data: { limits: [{ percent: 5 }] } }) === null,
    '空 / 无 limits / 无关字段'
  )
  check(
    'GLM 套餐接口：窗口名按 unit×number 归纳，认不出的组合原样标注',
    windowLabel(3, 5) === '5 小时' &&
      windowLabel(6, 1) === '本周' &&
      windowLabel(6, 2) === '2 周' &&
      windowLabel(9, 3) === 'unit9×3' &&
      windowLabel(null, null) === '套餐',
    [windowLabel(3, 5), windowLabel(6, 1), windowLabel(6, 2), windowLabel(9, 3), windowLabel(null, null)].join(' / ')
  )
  // 出站硬约束：套餐接口地址必须过白名单校验（仅 https + 显式主机），明文/外域一律拒
  const safeOk = (() => {
    try {
      assertSafeUpstream(GLM_PLAN_QUOTA_URL, GLM_PLAN_QUOTA_HOSTS)
      return true
    } catch (err) {
      return false
    }
  })()
  const safeReject = (u) => {
    try {
      assertSafeUpstream(u, GLM_PLAN_QUOTA_HOSTS)
      return false
    } catch (err) {
      return true
    }
  }
  check(
    'GLM 套餐接口：出站地址过白名单（https + 显式 host），明文或外域被拒',
    safeOk &&
      safeReject('http://open.bigmodel.cn/api/monitor/usage/quota/limit') &&
      safeReject('https://evil.example.com/api/monitor/usage/quota/limit') &&
      safeReject('https://127.0.0.1/api/monitor/usage/quota/limit'),
    GLM_PLAN_QUOTA_URL
  )
  // 取源链（进程内只能这样验）：测试进程读的是**真机**数据目录（paths.mjs 的
  // ZCODE_HOME 是模块常量，import 时求值，改 process.env 不管用），所以这里不去
  // 碰 readPlanQuota——端到端断言放在下面的自检服务上（它跑在 fixture 环境里）。
  // 没有凭据/没有日志的回落路径用**干净环境的子进程**验（见下）。
  {
    // 子进程 + 空数据目录：模块常量在子进程里重新求值 → 发现链找不到任何凭据，
    // 且日志目录为空 → 两个源都没有数据。全程不出网（没 key 就早返回）。
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plan-nokey-'))
    const childEnv = { ...process.env, ZCODE_HOME: emptyHome, ZCODE_DATA_BASE_DIR: emptyHome, FOX_WIDGET_DATA_DIR: emptyHome }
    delete childEnv.ZHIPU_API_KEY
    delete childEnv.BIGMODEL_API_KEY
    delete childEnv.GLM_API_KEY
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { fetchGlmPlanQuota } from " +
          JSON.stringify(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'glm-plan-api.mjs')).href) +
          ";\nimport { readPlanQuota } from " +
          JSON.stringify(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'plan-balance.mjs')).href) +
          ";\nconst api = await fetchGlmPlanQuota({ force: true });\nconst chain = await readPlanQuota();\nconsole.log(JSON.stringify({ api: { ok: api.ok, reason: api.reason, keySource: api.keySource }, chain: { ok: chain.ok, reason: chain.reason, apiReason: chain.apiReason } }));",
      ],
      { encoding: 'utf8', timeout: 20000, env: childEnv }
    )
    let out = null
    try {
      out = JSON.parse(String(probe.stdout || '').trim().split('\n').pop())
    } catch (err) {}
    check(
      'GLM 套餐接口：干净环境里没凭据时如实回 no-key（不抛错、不出网）',
      !!out && out.api.ok === false && out.api.reason === 'no-key' && out.api.keySource === 'none',
      JSON.stringify(out && out.api) + ' stderr=' + String(probe.stderr || '').slice(0, 120)
    )
    check(
      'GLM Plan 取源链：两个源都没数据时保留 no-plan-log 文案并把接口原因附上',
      !!out && out.chain.ok === false && out.chain.reason === 'no-plan-log' && out.chain.apiReason === 'no-key',
      JSON.stringify(out && out.chain)
    )
    fs.rmSync(emptyHome, { recursive: true, force: true })
  }

  // issue #14 回归：新鲜日志但剩余额度为 0（限时活动套餐用完仍在有效期内，
  // 客户端继续轮询它——日志「新鲜」却只是废弃套餐的最后一份快照）。取源链要
  // 补试一次直连接口；接口不可用（这里无凭据，早返回不出网）时保留日志的 0%。
  {
    const zeroHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-plan-zero-'))
    const zeroLogDir = path.join(zeroHome, '.zcode', 'v2', 'logs')
    fs.mkdirSync(zeroLogDir, { recursive: true })
    const zeroFixture = {
      balanceCount: 1,
      balances: [
        {
          entitlement_id: 'ent-devday',
          show_name: 'ZCode 1024 Dev Day',
          total_units: 500_000_000,
          used_units: 500_000_000,
          remaining_units: 0,
          available_units: 0,
          reserved_units: null,
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
              plan_id: 'zcode-v3-start-plan-zero',
              name: 'ZCode 1024 Dev Day',
              status: 'active',
              // 仍在有效期：expiresAt 未到，客户端才会继续轮询它
              starts_at: Math.floor(Date.now() / 1000) - 86400,
              ends_at: Math.floor(Date.now() / 1000) + 7 * 86400,
              entitlements: [
                {
                  entitlement_id: 'ent-devday',
                  show_name: 'ZCode 1024 Dev Day',
                  meter: 'model_usage',
                  unit_type: 'token',
                  capabilities: ['model:glm-5.3'],
                  grant_units: 500_000_000,
                  period: 'one_time',
                },
              ],
            },
          ],
          balances: [],
        },
      },
    }
    const zeroLine =
      '[2026-10-24 21:00:00.000Z] [info] [pid:1] [main] [host-log] (local-1) [host] [2026-10-24 21:00:00.000Z] [pid:2] [usage-stats] billing/balance 请求完成 ' +
      JSON.stringify(zeroFixture) +
      '\n'
    fs.writeFileSync(path.join(zeroLogDir, todayKeyForLog() + '.log'), zeroLine)
    const childEnv = { ...process.env, ZCODE_HOME: zeroHome, ZCODE_DATA_BASE_DIR: zeroHome, FOX_WIDGET_DATA_DIR: zeroHome }
    delete childEnv.ZHIPU_API_KEY
    delete childEnv.BIGMODEL_API_KEY
    delete childEnv.GLM_API_KEY
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { readPlanQuota } from " +
          JSON.stringify(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'plan-balance.mjs')).href) +
          ";\nconst chain = await readPlanQuota();\nconsole.log(JSON.stringify({ ok: chain.ok, source: chain.source, percentRemaining: chain.percentRemaining, stale: chain.stale }));",
      ],
      { encoding: 'utf8', timeout: 20000, env: childEnv }
    )
    let zeroOut = null
    try {
      zeroOut = JSON.parse(String(probe.stdout || '').trim().split('\n').pop())
    } catch (err) {}
    check(
      'GLM Plan 取源链：新鲜日志 0% 且接口不可用时保留日志 0%（issue #14，不误判成无数据）',
      !!zeroOut && zeroOut.ok === true && zeroOut.source === 'plan-log' && zeroOut.percentRemaining === 0 && zeroOut.stale === false,
      JSON.stringify(zeroOut) + ' stderr=' + String(probe.stderr || '').slice(0, 120)
    )
    fs.rmSync(zeroHome, { recursive: true, force: true })
  }

  // issue #14 绊线：取源链必须有「新鲜日志 0% → 补试直连接口」的子分支。
  // 接口有剩余的翻转半边需要真凭据，端到端在报告者账号上验证过（issue #14），
  // 这里钉住分支存在防重构悄悄丢掉。
  {
    const planSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'plan-balance.mjs'), 'utf8')
    check(
      'GLM Plan 取源链：新鲜日志 0% 时补试直连接口的子分支（issue #14 绊线）',
      planSrc.indexOf('} else if (log.percentRemaining <= 0) {') !== -1 &&
        planSrc.indexOf('if (api && api.ok && api.percentRemaining > 0) payload = api') !== -1,
      ''
    )
  }

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
    // 期望值必须按**本地时区**算：ui-ready 的 parseStamp 用的是本地时间分量，
    // 写死 +08:00 的 epoch 在 UTC 的 CI 上必挂（2026-10-18 CI 实测）。
    const bootAtLocal = new Date(2026, 9, 1, 10, 0, 26, 874).getTime()
    check('启动就绪判定：主窗口刚建好 = 加载中', s1.state === 'loading' && s1.bootAt === bootAtLocal, JSON.stringify(s1))
    const s2 = evaluateBootState(boot + domReady + dbReady)
    check('启动就绪判定：数据库 ready 后放行', s2.state === 'ready', JSON.stringify(s2))
    const s3 = evaluateBootState(boot + domReady + taskList)
    check('启动就绪判定：任务列表拉取成功也放行', s3.state === 'ready', JSON.stringify(s3))
    const s4 = evaluateBootState('随便一段没有启动标记的日志\n')
    check('启动就绪判定：无启动标记不拦（老版本/日志缺失）', s4.state === 'ready', JSON.stringify(s4))
    const s5 = evaluateBootState(boot + dbReady + boot)
    check('启动就绪判定：二次启动后重新进入加载态', s5.state === 'loading', JSON.stringify(s5))

    // 场景取自 2026-10-01 实测：12:48 那次运行完整收尾（boot 12:48:14 →
    // database-startup ready 12:48:16），13:20:49 重新打开 ZCode（pid 7876，
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
  // 空桶快照（套餐切换间隙）塑形后 percentRemaining=null——读取层据此跳行；
  // 端到端覆盖见 fixture（好观测之后垫了一条空桶行）+ plan.json 断言
  const emptyShaped = shapePlanPayload(
    { balances: [], payload: { code: 0, data: { server_time: 1790000000, plans: PLAN_FIXTURE.payload.data.plans, balances: [] } } },
    today,
    Date.now()
  )
  check(
    'Plan 日志解析：空桶快照塑形为 percentRemaining=null（供读取层跳过）',
    emptyShaped && emptyShaped.percentRemaining === null && emptyShaped.total === 0
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

// CommandCode 三重额度：套餐目录恢复 + 窗口塑形 + 活跃账号选择（纯函数，
// 不出网——HTTP 层只验 vendors.json 的 no-credentials 降级）
{
  const {
    shapeCmdgoUsage,
    resolveCmdgoPlan,
    pickActiveAccount,
    accountCandidates,
    readCmdgoAccounts,
    readHostCmdgoAccounts,
    mergeAccountCandidates,
    shapePoolQuota,
    fetchCmdgoKey,
  } = await import('../lib/cmdgo.mjs')
  const credits = {
    credits: { monthlyCredits: 6.9, purchasedCredits: 0.5, freeCredits: 0 },
    windowLimits: {
      fiveHour: { used: 2.79, cap: 3, exceeded: false, resetAt: 1790000000000 },
      weekly: { used: 3.48, cap: 6, exceeded: false, resetAt: 1790500000000 },
      limited: false,
    },
  }
  const subscription = { data: { planId: 'individual-go', status: 'active', currentPeriodEnd: '2026-10-31T00:00:00Z' } }
  const whoami = { user: { userName: 'pigeon189', name: 'P' } }
  const shaped = shapeCmdgoUsage(credits, subscription, whoami)
  check(
    'CommandCode 塑形：月度池按套餐目录恢复（Go $10）、5小时/周窗口百分比',
    shaped &&
      shaped.plan === 'Go' &&
      shaped.monthly &&
      shaped.monthly.total === 10 &&
      Math.abs(shaped.monthly.percent - 0.31) < 1e-9 &&
      Math.abs(shaped.fiveHour.percent - 2.79 / 3) < 1e-9 &&
      Math.abs(shaped.weekly.percent - 3.48 / 6) < 1e-9 &&
      shaped.userName === 'pigeon189' &&
      shaped.limited === false,
    JSON.stringify(shaped)
  )
  check(
    'CommandCode 套餐目录：帽对反查未知 planId（20%/50% → GOAT）',
    resolveCmdgoPlan('individual-go').monthly === 10 &&
      resolveCmdgoPlan('individual-max-20x-fallback')?.monthly === 300 &&
      resolveCmdgoPlan('mystery-plan', 14, 35)?.id === 'individual-goat'
  )
  const accounts = [
    { ref: 'A', enabled: true, cooldownUntil: 0, lastUsedAt: 1000 },
    { ref: 'B', enabled: true, cooldownUntil: Date.now() + 600_000, lastUsedAt: 9999 },
    { ref: 'C', enabled: false, lastUsedAt: 8888 },
  ]
  const picked = pickActiveAccount(accounts)
  check(
    'CommandCode 账号池：冷却/停用剔除，活跃账号取最近调用',
    picked.active.ref === 'A' && picked.available === 1 && picked.total === 3
  )
  check('CommandCode 空池降级', pickActiveAccount([]).active === null && pickActiveAccount([]).total === 0)
  const shapedEmpty = shapeCmdgoUsage({ credits: {}, windowLimits: {} }, undefined, undefined)
  check('CommandCode 塑形：主路由缺失返回 null（读取层报错）', shapedEmpty === null)

  // 候选组装（代码审查 M2 的落点）：停用账号既不进候选（不会被选成「当前账号」
  // 显示额度）也不计池可用数；纯字符串 / {value,source} 两种凭据形状都收
  const candDir = path.join(tmpHome, 'cmdgo-candidates')
  fs.mkdirSync(candDir, { recursive: true })
  fs.writeFileSync(
    path.join(candDir, 'credentials.json'),
    JSON.stringify({ REF_A: { value: 'k-a', source: 'file' }, REF_B: { value: 'k-b' }, REF_C: 'k-c' }),
    'utf8'
  )
  fs.writeFileSync(
    path.join(candDir, 'accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [
        { id: 'a', ref: 'REF_A', userName: 'acct-a', enabled: true, lastUsedAt: 200 },
        { id: 'b', ref: 'REF_B', userName: 'acct-b', enabled: false, lastUsedAt: 300 },
      ],
    }),
    'utf8'
  )
  const cands = accountCandidates(candDir, [])
  const candRefs = cands.ordered.map((c) => c.ref)
  check(
    '账号候选：停用账号被排除（展示与池计数都不含），裸 key 仍是候选',
    candRefs.indexOf('REF_A') !== -1 &&
      candRefs.indexOf('REF_C') !== -1 &&
      candRefs.indexOf('REF_B') === -1 &&
      candRefs[0] === 'REF_A' &&
      cands.pool.total === 2 &&
      cands.pool.available === 1,
    JSON.stringify({ refs: candRefs, pool: cands.pool })
  )

  // 官方 API 接入点（除 Go 套餐外发的就是这把 `user…` 官方 key）：宿主里同一
  // 账号常配两个 provider（OpenAI 兼容 + Anthropic）共用一把 key，必须按 key
  // 去重成一个账号；本地网关 / 密文 / 非 CommandCode 域名都不收。
  const hostEntries = [
    {
      providerId: 'commandcode-goat-1',
      providerName: 'CommandCode GOAT · 账号 1',
      host: 'api.commandcode.ai',
      apiKey: 'user-key-a',
      isLocal: false,
      keyEncrypted: false,
    },
    {
      providerId: 'commandcode-goat-1-claude',
      providerName: 'CommandCode GOAT · 账号 1 (Claude)',
      host: 'api.commandcode.ai',
      apiKey: 'user-key-a',
      isLocal: false,
      keyEncrypted: false,
    },
    {
      providerId: 'commandcode-goat-2',
      providerName: 'CommandCode GOAT · 账号 2',
      host: 'api.commandcode.ai',
      apiKey: 'user-key-b',
      isLocal: false,
      keyEncrypted: false,
    },
    { providerId: 'deepseek', providerName: 'DeepSeek', host: 'api.deepseek.com', apiKey: 'sk-x', isLocal: false },
    { providerId: 'local-cc', providerName: '本地反代', host: '127.0.0.1', apiKey: 'user-key-c', isLocal: true },
    {
      providerId: 'commandcode-pool',
      providerName: 'CommandCode GOAT Pool',
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:11490/v1',
      apiKey: 'ccp-token',
      isLocal: true,
    },
    {
      providerId: 'commandcode-pool-claude',
      providerName: 'CommandCode GOAT Pool (Claude)',
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:11490/v1',
      apiKey: 'ccp-token',
      isLocal: true,
    },
    { providerId: 'enc-cc', providerName: '密文', host: 'api.commandcode.ai', apiKey: '', isLocal: false, keyEncrypted: true },
    { providerId: 'no-key', providerName: '无 key', host: 'api.commandcode.ai', apiKey: '', isLocal: false },
  ]
  const hostAccts = readHostCmdgoAccounts(hostEntries)
  check(
    'CommandCode 官方 API：同一账号两个 provider 共用 key 只算一个（名称去 (Claude) 后缀）',
    hostAccts.length === 3 &&
      hostAccts[0].ref === 'provider:commandcode-goat-1' &&
      hostAccts[0].key === 'user-key-a' &&
      hostAccts[0].userName === 'CommandCode GOAT · 账号 1' &&
      hostAccts[1].key === 'user-key-b',
    JSON.stringify(hostAccts.map((a) => ({ ref: a.ref, name: a.userName })))
  )
  check(
    'CommandCode 本地池：按 pool origin 去重（OpenAI/Claude 两个接入点只查一次 /health）',
    hostAccts[2].kind === 'pool' &&
      hostAccts[2].ref === 'pool:http://127.0.0.1:11490' &&
      hostAccts[2].poolBase === 'http://127.0.0.1:11490',
    JSON.stringify(hostAccts[2])
  )
  const poolShaped = shapePoolQuota({
    id: 'goat-1',
    label: 'CommandCode GOAT 账号 1',
    quota: {
      monthlyCredits: 45.08,
      fiveHour: { used: 0.6, cap: 14, exceeded: false, resetAt: 1792219604599 },
      weekly: { used: 0.67, cap: 35, exceeded: false, resetAt: 1792804438334 },
    },
  })
  check(
    'CommandCode 本地池：/health 快照按帽对恢复套餐（14/35 → GOAT $70），月度已用比例与窗口一致',
    poolShaped &&
      poolShaped.plan === 'GOAT' &&
      poolShaped.monthly.total === 70 &&
      Math.abs(poolShaped.monthly.percent - (70 - 45.08) / 70) < 1e-9 &&
      Math.abs(poolShaped.fiveHour.percent - 0.6 / 14) < 1e-9 &&
      Math.abs(poolShaped.weekly.percent - 0.67 / 35) < 1e-9 &&
      poolShaped.userName === 'GOAT 账号 1',
    JSON.stringify(poolShaped)
  )
  const merged = mergeAccountCandidates(readCmdgoAccounts(candDir), hostAccts)
  check(
    'CommandCode 账号池：反代账号在前、宿主 provider 并入，池总数/可用数含官方与本地池',
    merged.ordered.length === 5 &&
      merged.ordered[0].ref === 'REF_A' &&
      merged.ordered[2].ref === 'provider:commandcode-goat-1' &&
      merged.ordered[4].ref === 'pool:http://127.0.0.1:11490' &&
      merged.pool.total === 5 &&
      merged.pool.available === 4,
    JSON.stringify({ refs: merged.ordered.map((c) => c.ref), pool: merged.pool })
  )
  const overlap = mergeAccountCandidates(readCmdgoAccounts(candDir), [
    { ref: 'provider:x', key: 'k-a', userName: 'dup' },
  ])
  check(
    'CommandCode 账号池：反代与官方 API 共用同一把 key 时只保留先出现的账号',
    overlap.ordered.length === 2 && overlap.ordered.every((c) => c.key !== 'k-a' || c.ref === 'REF_A'),
    JSON.stringify(overlap.ordered.map((c) => c.ref))
  )
  const shapes = readCmdgoAccounts(candDir)
  check(
    '凭据两种形状都收（{value,source} 对象 + 纯字符串，v1.7.9 实修点回归）',
    shapes.keys.REF_A === 'k-a' && shapes.keys.REF_B === 'k-b' && shapes.keys.REF_C === 'k-c',
    JSON.stringify(Object.keys(shapes.keys))
  )

  // 池可用判定与展示账号选择（2026-10-04 真机实锤）：网关 limited=true 的账号
  // 即使三个窗口都没满也不算「可用」——月池见底时网关已开始拒绝请求，窗口
  // 算术看不见这道墙。全部撞墙时展示账号选「最早解锁」的（把最短的那面墙和
  // 它的重置倒计时摆出来），限流但看不见墙的账号按最晚重置时间排最后。
  {
    const { chooseSnapshot, snapshotUsable } = await import('../lib/cmdgo.mjs')
    const snap = (ref, data) => ({ cand: { ref }, entry: { at: 0, data } })
    const H = 3600_000
    const now = Date.now()
    // 真机三账号形状：A=月池见底被网关限流（窗口全没满，月池重置最晚）、
    // B=本周超额（今天稍晚重置）、C=本周超额（两天后重置）
    const acctA = {
      limited: true,
      userName: 'pigeon189',
      monthly: { remaining: 0.0457, total: 10, percent: 0.9954, resetAt: now + 22 * 24 * H },
      fiveHour: { used: 0.912, cap: 3, exceeded: false, resetAt: now + 5 * H, remaining: 2.088, percent: 0.3041 },
      weekly: { used: 3.947, cap: 6, exceeded: false, resetAt: now + 6 * 24 * H, remaining: 2.053, percent: 0.6578 },
    }
    const acctB = {
      limited: true,
      fiveHour: null,
      weekly: { used: 6.009, cap: 6, exceeded: true, resetAt: now + 4 * H, remaining: 0, percent: 1.0015 },
      monthly: { remaining: 3.99, total: 10, percent: 0.6009, resetAt: now + 23 * 24 * H },
    }
    const acctC = {
      limited: true,
      fiveHour: null,
      weekly: { used: 6.044, cap: 6, exceeded: true, resetAt: now + 2 * 24 * H, remaining: 0, percent: 1.0073 },
      monthly: { remaining: 3.96, total: 10, percent: 0.6044, resetAt: now + 25 * 24 * H },
    }
    check(
      'snapshotUsable：limited 需佐证才采信——窗口撞墙或月池≥99% 即不可用；配额全满的粘滞残留（GOAT 升级）不算不可用',
      snapshotUsable(acctA) === false &&
        snapshotUsable(acctB) === false &&
        // pigeon189 去掉月池佐证（percent < 0.99）后即使 limited=true 也恢复可用
        snapshotUsable({ ...acctA, limited: false }) === true &&
        snapshotUsable({ ...acctA, monthly: { ...acctA.monthly, percent: 0.5 } }) === true,
      JSON.stringify({
        a: snapshotUsable(acctA),
        aNoFlag: snapshotUsable({ ...acctA, limited: false }),
        aHalfPool: snapshotUsable({ ...acctA, monthly: { ...acctA.monthly, percent: 0.5 } }),
      })
    )
    // GOAT 升级回归（2026-10-04 二次真机）：limited 粘滞残留 + 配额全满 → 可用，
    // 且在有可用账号时优先展示它（不被「其他账号解锁更早」换人）
    const goat = {
      limited: true,
      userName: 'pigeon189',
      plan: 'GOAT',
      monthly: { remaining: 69.23, total: 70, percent: 0.0111, resetAt: now + 31 * 24 * H },
      fiveHour: { used: 0.774, cap: 14, exceeded: false, resetAt: now + 5 * H, remaining: 13.226, percent: 0.0553 },
      weekly: { used: 0.774, cap: 35, exceeded: false, resetAt: now + 7 * 24 * H, remaining: 34.226, percent: 0.0221 },
    }
    check(
      'GOAT 升级粘滞 limited：配额全满仍判可用，展示账号选它而非旧超额账号',
      snapshotUsable(goat) === true,
      JSON.stringify({ usable: snapshotUsable(goat) })
    )
    const withGoat = chooseSnapshot([snap('GOAT', goat), snap('C', acctC), snap('B', acctB)])
    check(
      '池里唯一健康的 GOAT 账号被选为展示账号（pool 可用数 1）',
      withGoat.usable.length === 1 && withGoat.chosen.cand.ref === 'GOAT',
      JSON.stringify({ usable: withGoat.usable.length, chosen: withGoat.chosen && withGoat.chosen.cand.ref })
    )
    // 生产顺序 = 最近使用优先：C 最新、A 次之、B 最旧；全部撞墙 → 选 B（今天重置）
    const allDead = chooseSnapshot([snap('C', acctC), snap('A', acctA), snap('B', acctB)])
    check(
      '全撞墙时展示账号选最早解锁的（B 今天重置 < C 两天后 < A 限流无墙按最晚重置排最后）',
      allDead.usable.length === 0 &&
        allDead.withData.length === 3 &&
        allDead.chosen &&
        allDead.chosen.cand.ref === 'B',
      JSON.stringify({ usable: allDead.usable.length, chosen: allDead.chosen && allDead.chosen.cand.ref })
    )
    // 有可用账号时仍按「最近使用」优先，不被「别人解锁更早」干扰
    const hasUsable = chooseSnapshot([
      snap('B', acctB),
      snap('D', { limited: false, fiveHour: { used: 1, cap: 3, exceeded: false, percent: 0.333 }, weekly: { used: 2, cap: 6, exceeded: false, percent: 0.333 }, monthly: { percent: 0.5 } }),
    ])
    check(
      '存在可用账号时优先展示可用账号（不因其他账号解锁更早而换人）',
      hasUsable.usable.length === 1 && hasUsable.chosen.cand.ref === 'D',
      JSON.stringify({ chosen: hasUsable.chosen && hasUsable.chosen.cand.ref })
    )
    // 空数组 / 全失败：chosen 为 null，readCmdgoQuota 据此走「读取失败」分支
    const empty = chooseSnapshot([])
    check('chooseSnapshot 空入参降级（无 chosen、无异常）', empty.withData.length === 0 && empty.chosen === null && empty.usable.length === 0)
  }

  // whoami 失败降级：丢掉 orgId 直接重试主路由，credits 仍要拿到（此前只靠人工实测）
  {
    const realFetch = globalThis.fetch
    const urls = []
    globalThis.fetch = async (url) => {
      const u = String(url)
      urls.push(u)
      if (u.indexOf('/alpha/whoami') !== -1) throw new Error('whoami down')
      if (u.indexOf('/alpha/billing/credits') !== -1) {
        return new Response(
          JSON.stringify({ data: { credits: { monthlyCredits: 4 }, windowLimits: { fiveHour: { used: 1, cap: 3 } } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (u.indexOf('/alpha/billing/subscriptions') !== -1) {
        return new Response(JSON.stringify({ data: { planId: 'individual-go', currentPeriodEnd: '2026-11-01T00:00:00Z' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error('unexpected ' + u)
    }
    try {
      const got = await fetchCmdgoKey('https://api.commandcode.ai', 'k')
      const creditUrl = urls.filter((u) => u.indexOf('/credits') !== -1)[0] || ''
      check(
        'whoami 失败降级重试主路由（无 orgId 仍取到 credits）',
        !!got.credits && urls.filter((u) => u.indexOf('/whoami') !== -1).length === 1 && creditUrl.indexOf('orgId') === -1,
        JSON.stringify(urls.map((u) => u.replace('https://api.commandcode.ai', '')))
      )
    } finally {
      globalThis.fetch = realFetch
    }
  }
}

// 火山方舟 Coding Plan：V4 签名固定向量 + 双形状塑形 + 错误分类（纯函数，零出网）。
// 签名算法与火山官方 V4 参考实现及 ZnonEn/dsh-volcark-quota（BSD-3）逐步对照；
// 向量由实现生成后锁定（固定 AK/SK/时刻/请求体），防后续改动破坏签名。
{
  const {
    formatXDate,
    normQuery,
    volcengineSign,
    shapeVolcCoding,
    shapeVolcAfp,
    volcWindowMeta,
    classifyVolcError,
  } = await import('../lib/volc-plan.mjs')
  check(
    '火山 V4：X-Date 格式与查询串排序',
    formatXDate(new Date(Date.UTC(2026, 9, 19, 8, 9, 5))) === '20261019T080905Z' &&
      normQuery({ Version: '2024-01-01', Action: 'GetCodingPlanUsage' }) ===
        'Action=GetCodingPlanUsage&Version=2024-01-01'
  )
  const vNow = Date.UTC(2026, 9, 19, 8, 9, 5)
  const vQuery = { Action: 'GetCodingPlanUsage', Version: '2024-01-01' }
  const vSigned = volcengineSign('AKLTdummy', 'SKdummy', 'POST', '/', vQuery, '{}', vNow)
  check(
    '火山 V4：固定向量签名（头集 + Authorization 结构 + 签名值锁定）',
    vSigned['X-Date'] === '20261019T080905Z' &&
      /^HMAC-SHA256 Credential=AKLTdummy\/20261019\/cn-beijing\/ark\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/.test(
        vSigned.Authorization
      ) &&
      vSigned.Authorization.endsWith('Signature=3d02e41badd55e7b3a2102a4c0cd616286bb3ffd3b19003e73d8a400caea0f04'),
    vSigned.Authorization
  )
  check(
    '火山 V4：body / 时刻 / SK 任一变化签名都变',
    volcengineSign('AKLTdummy', 'SKdummy', 'POST', '/', vQuery, '{"a":1}', vNow).Authorization !==
      vSigned.Authorization &&
      // X-Date 精度到秒：差 1 毫秒签名不变属正确行为，这里差 1 秒
      volcengineSign('AKLTdummy', 'SKdummy', 'POST', '/', vQuery, '{}', vNow + 1000).Authorization !==
        vSigned.Authorization &&
      volcengineSign('AKLTdummy', 'SKother', 'POST', '/', vQuery, '{}', vNow).Authorization !==
        vSigned.Authorization
  )
  const vShaped = shapeVolcCoding({
    QuotaUsage: [
      { Level: 'session', Percent: 42.35, ResetTimestamp: 1768000000 },
      { Level: 'weekly', Percent: 18, ResetTimestamp: 1768500000 },
      { Level: 'monthly', Percent: 9.4, ResetTimestamp: 0 },
    ],
  })
  check(
    '火山塑形：QuotaUsage 三窗口归一（Level→5h/week/month，秒→毫秒，超 100% 截断）',
    vShaped &&
      vShaped.planType === 'coding' &&
      vShaped.windows.length === 3 &&
      vShaped.windows[0].name === '5h' &&
      vShaped.windows[0].label === '5小时' &&
      Math.abs(vShaped.windows[0].usedPct - 42.35) < 1e-9 &&
      Math.abs(vShaped.windows[0].remainingPct - 57.65) < 1e-9 &&
      vShaped.windows[0].resetAt === 1768000000000 &&
      vShaped.windows[2].name === 'month' &&
      vShaped.windows[2].resetAt === null,
    JSON.stringify(vShaped)
  )
  check(
    '火山塑形：QuotaUsage 超 100% 视为已撞墙（exceeded，remaining 不出负数）',
    (() => {
      const s = shapeVolcCoding({ QuotaUsage: [{ Level: '5h', Percent: 137, ResetTimestamp: 1 }] })
      return s.windows[0].usedPct === 100 && s.windows[0].exceeded === true && s.windows[0].remainingPct === 0
    })()
  )
  check('火山塑形：空数据 -> null（不推断订阅状态）', shapeVolcCoding({ QuotaUsage: [] }) === null)
  const vAfp = shapeVolcAfp({
    AFPFiveHour: { Quota: 100, Used: 42, ResetTime: 1768000000 },
    AFPWeekly: { Quota: 100, Used: 5, ResetTime: 0 },
  })
  check(
    '火山塑形：AFP 回退形状（Quota/Used 折百分比，窗口固定序）',
    vAfp &&
      vAfp.planType === 'agent' &&
      vAfp.windows.length === 2 &&
      vAfp.windows[0].name === '5h' &&
      Math.abs(vAfp.windows[0].usedPct - 42) < 1e-9 &&
      vAfp.windows[0].resetAt === 1768000000000 &&
      vAfp.windows[1].name === 'week',
    JSON.stringify(vAfp)
  )
  check('火山 Agent 保留近一天窗口', shapeVolcAfp({ AFPDaily: { Quota: '100', Used: '25', ResetTime: 1768000000000 } }).windows[0].name === 'daily')
  const badNumbers = [undefined, null, '', '  ', false, true, {}, [], 'bad']
  check('火山塑形：无效 Used/Percent 不伪造零用量', badNumbers.every((v) =>
    shapeVolcAfp({ AFPWeekly: { Quota: 100, Used: v } }) === null &&
    shapeVolcCoding({ QuotaUsage: [{ Level: 'weekly', Percent: v }] }) === null))
  const partial = shapeVolcAfp({ AFPFiveHour: { Quota: 100 }, AFPWeekly: { Quota: '100', Used: '0' } })
  check('火山塑形：保留真实零值和其它有效窗口（兼容数字字符串）',
    partial.windows.length === 1 && partial.windows[0].usedPct === 0 && partial.windows[0].remainingPct === 100)
  const { readVolcCredentials } = await import('../lib/volc-plan.mjs')
  const fakeConfig = () => ({ vendorKeys: { 'volc-access-key-id': 'AKLTfake-config', 'volc-access-key-secret': 'fake-config-secret' } })
  check('火山凭据：完整环境变量对优先于配置',
    readVolcCredentials({ VOLC_ACCESS_KEY_ID: 'AKLTfake-env', VOLC_ACCESS_KEY_SECRET: 'fake-env-secret' }, fakeConfig).source === 'env:VOLC_ACCESS_KEY_ID')
  check('火山凭据：半套别名不拼接，回退完整配置对',
    readVolcCredentials({ VOLC_ACCESS_KEY_ID: 'AKLTfake-env', VOLC_ARK_ACCESS_KEY_SECRET: 'fake-other-secret' }, fakeConfig).ak === 'AKLTfake-config')
  check('火山凭据：半套首选之后仍可选择其它完整环境变量对',
    readVolcCredentials({ VOLC_ACCESS_KEY_ID: 'AKLTfake-env', ARK_ACCESS_KEY_ID: 'AKLTfake-pair', ARK_ACCESS_KEY_SECRET: 'fake-pair-secret' }, fakeConfig).ak === 'AKLTfake-pair')
  check('火山凭据：双键缺一则无凭据', readVolcCredentials({}, () => ({ vendorKeys: { 'volc-access-key-id': 'AKLTfake' } })) === null)
  check(
    '火山窗口名：未知 Level 原样保留（显示层 label 兜底）',
    volcWindowMeta('session').name === '5h' && volcWindowMeta('mystery').name === 'mystery'
  )
  check(
    '火山错误分类：401/签名类 -> invalid-credentials；InvalidTimestamp -> clock-skew；404 -> not-subscribed',
    classifyVolcError({ status: 401, code: '', message: 'x' }).reason === 'invalid-credentials' &&
      classifyVolcError({ status: 400, code: 'SignatureDoesNotMatch', message: 'x' }).reason ===
        'invalid-credentials' &&
      classifyVolcError({ status: 400, code: 'InvalidTimestamp', message: 'x' }).reason === 'clock-skew' &&
      classifyVolcError({ status: 404, code: 'NotFound', message: 'x' }).reason === 'not-subscribed'
  )
}

// 火山主入口 readVolcPlanQuota 的分支逻辑（mock https.request，零出网；结束时恢复
// 全局 request 与凭据环境变量——后续块还有真实 HTTP 测试。callVolc 走
// node:https.request 出网（undici fetch 会剥手动 Host 头导致签名不匹配），mock 拦 request）
{
  const volc = await import('../lib/volc-plan.mjs')
  const realRequest = https.request
  const prevAk = process.env.VOLC_ACCESS_KEY_ID
  const prevSk = process.env.VOLC_ACCESS_KEY_SECRET
  // 响应形状模拟 https.IncomingMessage（statusCode + 'data'/'end' 事件）
  const volcJson = (body, status = 200) => ({ statusCode: status, bodyText: JSON.stringify(body) })
  const codingBody = { Result: { QuotaUsage: [{ Level: 'weekly', Percent: 18, ResetTimestamp: 1768500000 }] } }
  const afpBody = { Result: { AFPWeekly: { Quota: 100, Used: 5, ResetTime: 0 } } }
  const notFound = volcJson({ ResponseMetadata: { Error: { Code: 'NotFound', Message: 'not found' } } }, 404)
  const unauthorized = volcJson({ ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch', Message: 'x' } } }, 401)
  let respond = () => notFound
  let calls = 0
  try {
    process.env.VOLC_ACCESS_KEY_ID = 'AKLTtest'
    process.env.VOLC_ACCESS_KEY_SECRET = 'SKtest'
    https.request = (url, opts, cb) => {
      const handlers = {}
      const res = {
        statusCode: 0,
        on(ev, fn) {
          handlers[ev] = fn
          return res
        },
      }
      const req = {
        on(ev, fn) {
          if (ev === 'error') handlers.reqError = fn
          return req
        },
        setTimeout() {
          return req
        },
        write() {},
        end() {
          // 异步回包，模拟真实网络时序：先 cb(res) 再 data -> end
          queueMicrotask(() => {
            const r = respond(String(url))
            if (r.error) { handlers.reqError(r.error); return }
            res.statusCode = r.statusCode
            cb(res)
            if (handlers.data) handlers.data(r.bodyText)
            if (handlers.end) handlers.end()
          })
        },
      }
      calls += 1
      return req
    }
    respond = () => notFound
    let p = await volc.readVolcPlanQuota(true, 'coding')
    check('火山：404 返回稳定错误，不查询另一套餐', !p.ok && p.reason === 'not-subscribed' && calls === 1)
    const actions = []
    respond = (u) => { actions.push(new URL(u).searchParams.get('Action')); return volcJson(u.includes('GetCodingPlanUsage') ? codingBody : afpBody) }
    const [coding, agent] = await Promise.all([volc.readVolcPlanQuota(true, 'coding'), volc.readVolcPlanQuota(true, 'agent')])
    check('火山：两种套餐独立查询官方 Action', coding.ok && agent.ok && coding.planType === 'coding' && agent.planType === 'agent' &&
      actions.sort().join(',') === 'GetAFPUsage,GetCodingPlanUsage')
    const cachedCalls = calls
    await Promise.all([volc.readVolcPlanQuota(false, 'coding'), volc.readVolcPlanQuota(false, 'agent')])
    check('火山：两种套餐缓存互不覆盖', calls === cachedCalls)
    const concurrentCalls = calls
    await Promise.all([volc.readVolcPlanQuota(true, 'coding'), volc.readVolcPlanQuota(true, 'coding')])
    check('火山：强制刷新也合并同套餐在途请求', calls === concurrentCalls + 1)
    respond = () => ({ error: new Error('offline') })
    const beforeFailure = calls
    p = await volc.readVolcPlanQuota(true, 'coding')
    check('火山：网络失败返回稳定结构且不跨套餐回退', p && !p.ok && p.reason === 'request-failed' && calls === beforeFailure + 1)
    const failedCalls = calls
    await volc.readVolcPlanQuota(false, 'coding')
    const stillAgent = await volc.readVolcPlanQuota(false, 'agent')
    check('火山：失败计入 TTL，另一套餐成功缓存保留', calls === failedCalls && stillAgent.ok && stillAgent.planType === 'agent')
    respond = () => volcJson({ Result: {} })
    p = await volc.readVolcPlanQuota(true, 'agent')
    check('火山：成功空数据不推断未订阅', !p.ok && p.reason === 'no-data' && p.planType === 'agent')
    respond = () => unauthorized
    p = await volc.readVolcPlanQuota(true, 'coding')
    check('火山：凭据错误保持分类与稳定错误', !p.ok && p.reason === 'invalid-credentials' && p.planType === 'coding')
    const oldKeyCalls = calls
    process.env.VOLC_ACCESS_KEY_SECRET = 'fake-rotated-secret'
    respond = () => volcJson(codingBody)
    p = await volc.readVolcPlanQuota(false, 'coding')
    check('火山：凭据变更不复用旧缓存', p.ok && calls === oldKeyCalls + 1)
    const invalidCalls = calls
    p = await volc.readVolcPlanQuota(true, 'other')
    check('火山：未知套餐不出网', !p.ok && p.reason === 'unknown-plan' && calls === invalidCalls)
  } finally {
    https.request = realRequest
    if (prevAk === undefined) delete process.env.VOLC_ACCESS_KEY_ID
    else process.env.VOLC_ACCESS_KEY_ID = prevAk
    if (prevSk === undefined) delete process.env.VOLC_ACCESS_KEY_SECRET
    else process.env.VOLC_ACCESS_KEY_SECRET = prevSk
  }
}

// 中转站额度：站点识别 + 三类平台响应塑形 + 余额/窗口卡 + HTTP 兜底链
//（纯函数用 fixture；HTTP 用 mock fetch，不出网）
{
  const R = await import('../lib/relays.mjs')
  const ids = R.RELAYS.map((r) => r.id)
  check(
    '中转站注册表：常用站覆盖（PackyCode/DuckCoding/云雾/H API/UU/APINebula/LinkAI/88Code/SSSAICode/Cubence）',
    ids.indexOf('packycode') !== -1 &&
      ids.indexOf('duckcoding') !== -1 &&
      ids.indexOf('yunwu') !== -1 &&
      ids.indexOf('hapi') !== -1 &&
      ids.indexOf('uuapi') !== -1 &&
      ids.indexOf('apinebula') !== -1 &&
      ids.indexOf('linkai') !== -1 &&
      ids.indexOf('88code') !== -1 &&
      ids.indexOf('sssaicode') !== -1 &&
      ids.indexOf('cubence') !== -1,
    ids.join(',')
  )
  check(
    '中转站识别：host 精确/子域都命中',
    R.findRelay('api.packyapi.ai', '')?.id === 'packycode' &&
      R.findRelay('api.duckcoding.ai', '')?.id === 'duckcoding' &&
      R.findRelay('node-hk.sssaiapi.com', '')?.id === 'sssaicode' &&
      R.findRelay('api.cubence.com', '')?.id === 'cubence' &&
      R.findRelay('img-api.apinebula.ai', '')?.id === 'apinebula'
  )
  check(
    '中转站识别：调用地址换成通用域名时按 provider 名兜底（cf.api.fan + PackyCode）',
    R.findRelay('cf.api.fan', 'PackyCode')?.id === 'packycode' &&
      R.findRelay('', 'SSSAICode')?.id === 'sssaicode' &&
      R.findRelay('', 'Cubence')?.id === 'cubence'
  )
  check(
    '中转站识别：不误伤官方域名 / 同名 Agent 平台 / 相似域名',
    R.findRelay('api.deepseek.com', 'DeepSeek') === null &&
      R.findRelay('api.openai.com', 'OpenAI') === null &&
      R.findRelay('linkai.cloud', 'LinkAI Agent') === null &&
      R.findRelay('cf.api.fan', '') === null &&
      R.findRelay('evilpackyapi.ai', '') === null
  )

  const packy = R.RELAYS.find((r) => r.id === 'packycode')
  const t1 = R.shapeNewApiTokenUsage(packy, {
    data: { total_granted: 5000000, total_used: 1000000, total_available: 4000000 },
  })
  check(
    'New API token 额度：quota 单位按 500000=$1 换算（$10 / 已用 $2 / 剩 $8）',
    t1 && t1.ok && t1.kind === 'balance' && t1.balance.remaining === 8 && t1.balance.used === 2 && t1.balance.total === 10,
    JSON.stringify(t1)
  )
  const t2 = R.shapeNewApiTokenUsage(packy, {
    data: { total_granted: '15.5', total_used: '3.5', total_available: '12' },
  })
  check(
    'New API token 额度：字符串数值 + 直接给美元的站（不再除以 500000）',
    t2 && t2.balance.remaining === 12 && t2.balance.used === 3.5 && t2.balance.total === 15.5,
    JSON.stringify(t2)
  )
  const t3 = R.shapeNewApiTokenUsage(packy, { data: { unlimited_quota: true, total_used: 1000000 } })
  check(
    'New API token 额度：unlimited_quota 不冒充 $0 余额',
    t3 && t3.balance.unlimited === true && t3.balance.remaining === null,
    JSON.stringify(t3)
  )
  const t4 = R.shapeNewApiTokenUsage(packy, { data: { total_granted: 5000000, total_used: 1000000 } })
  check(
    'New API token 额度：缺 total_available 时用 granted − used 兜底',
    t4 && t4.balance.remaining === 8 && t4.balance.used === 2,
    JSON.stringify(t4)
  )
  const b1 = R.shapeNewApiBilling(packy, { hard_limit_usd: 10 }, { total_usage: 400 })
  check(
    'New API 账单：hard_limit − 已用（total_usage 是美分）',
    b1 && b1.kind === 'balance' && b1.balance.remaining === 6 && b1.balance.used === 4 && b1.balance.total === 10,
    JSON.stringify(b1)
  )
  const b2 = R.shapeNewApiBilling(packy, { hard_limit_usd: 100000000 }, { total_usage: 1 })
  check('New API 账单：哨兵值 100000000 = 无限制，不当成 $1 亿', b2 && b2.balance.unlimited === true, JSON.stringify(b2))
  check(
    'New API 账单：只有总额没有 usage 时返回 null（不编造剩余）',
    R.shapeNewApiBilling(packy, { hard_limit_usd: 10 }, null) === null
  )
  const u1 = R.shapeNewApiUserSelf(packy, { data: { quota: 4000000, used_quota: 1000000 } })
  check(
    'New API /api/user/self：账户级 quota + used_quota 换算',
    u1 && u1.balance.remaining === 8 && u1.balance.used === 2 && u1.balance.total === 10,
    JSON.stringify(u1)
  )
  const monthly = R.shapeNewApiTokenUsage(
    { id: 'monthly-demo', name: 'Monthly Demo', model: 'monthly' },
    { data: { total_granted: 5000000, total_used: 1000000, total_available: 4000000 } }
  )
  check(
    'New API 月限额：注册表标 monthly 时出「本月」窗口（20% 已用）',
    monthly && monthly.kind === 'quota' && monthly.windows.length === 1 && monthly.windows[0].label === '本月' && monthly.windows[0].percentUsed === 20,
    JSON.stringify(monthly)
  )

  const sssai = { id: 'sssaicode', name: 'SSSAICode' }
  const s1 = R.shapeSub2Usage(sssai, {
    mode: 'quota_limited',
    rate_limits: [
      { window: '5h', used: 1, total: 5, reset_at: '2026-10-18T00:00:00Z' },
      { window: '1d', used: 2, total: 10 },
      { window: '7d', used: 20, total: 100 },
    ],
  })
  check(
    'Sub2API：5h/1d/7d 三窗口映射为 5小时/本日/本周，百分比与重置时间都保留',
    s1 &&
      s1.kind === 'quota' &&
      s1.windows.length === 3 &&
      s1.windows[0].label === '5小时' &&
      s1.windows[0].percentUsed === 20 &&
      s1.windows[0].resetAt > 0 &&
      s1.windows[1].label === '本日' &&
      s1.windows[2].label === '本周' &&
      s1.windows[2].percentUsed === 20,
    JSON.stringify(s1)
  )
  const s2 = R.shapeSub2Usage(sssai, { data: { mode: 'quota_limited', rate_limits: [{ window: '5h', used: 12, total: 10 }] } })
  check('Sub2API：已用超过总额时夹到 100%（不显示 120%）', s2 && s2.windows[0].percentUsed === 100, JSON.stringify(s2))
  const s3 = R.shapeSub2Usage(sssai, { data: { mode: 'unrestricted', remaining: 12.5, used: 2.5, total: 15 } })
  check(
    'Sub2API：unrestricted 模式退回余额卡（不硬造窗口）',
    s3 && s3.kind === 'balance' && s3.balance.remaining === 12.5 && s3.balance.used === 2.5,
    JSON.stringify(s3)
  )
  check('Sub2API：结构不符返回 null（读取层报错）', R.shapeSub2Usage(sssai, { foo: 'bar' }) === null)

  const cub = { id: 'cubence', name: 'Cubence' }
  const c1 = R.shapeCubence(cub, { balance: 12.34, five_hour: { used: 1.23, limit: 5 } })
  check(
    'Cubence：5 小时窗口 + 余额同时展示',
    c1 &&
      c1.kind === 'quota' &&
      c1.windows.length === 1 &&
      c1.windows[0].label === '5小时' &&
      c1.windows[0].percentUsed === 24.6 &&
      c1.balance.remaining === 12.34,
    JSON.stringify(c1)
  )
  const c2 = R.shapeCubence(cub, { data: { subscription: { balance: 9.5, fiveHour: { remaining: 4, total: 5 } } } })
  check(
    'Cubence：data/subscription 嵌套 + 只给 remaining/total 也能算出已用',
    c2 && c2.windows[0].percentUsed === 20 && c2.balance.remaining === 9.5,
    JSON.stringify(c2)
  )
  const c3 = R.shapeCubence(cub, { balance: 3.2 })
  check('Cubence：只有余额时出余额卡', c3 && c3.kind === 'balance' && c3.balance.remaining === 3.2, JSON.stringify(c3))
  check('Cubence：结构不符返回 null', R.shapeCubence(cub, { foo: 1 }) === null)

  const cardWindows = R.quotaCardOf(s1)
  const cardBalance = R.quotaCardOf(s3)
  const cardError = R.quotaCardOf({ ok: false, name: 'DuckCoding', reason: '未找到该站的 API Key' })
  check(
    '额度卡形状：窗口卡带 rows/sub 余额，余额卡带 amount，错误卡带 reason',
    cardWindows.kind === 'windows' &&
      cardWindows.title === 'SSSAICode 额度' &&
      cardWindows.rows.length === 3 &&
      cardWindows.balance === null &&
      cardBalance.kind === 'balance' &&
      cardBalance.title === 'SSSAICode 余额' &&
      cardBalance.balance.remaining === 12.5 &&
      cardError.kind === 'error' &&
      cardError.title === 'DuckCoding 额度' &&
      cardError.reason.indexOf('API Key') !== -1,
    JSON.stringify({ cardWindows, cardBalance, cardError })
  )

  // ---- HTTP 适配器：mock fetch 覆盖兜底链、缓存、并发与白名单 ----
  const realFetch = globalThis.fetch
  let calls = []
  const json = (o, status) =>
    new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json' } })
  const provider = {
    providerId: 'selftest-packy',
    baseUrl: 'https://api.packyapi.ai',
    host: 'api.packyapi.ai',
    apiKey: 'k-test',
    providerName: 'PackyCode',
    isLocal: false,
  }
  try {
    R.invalidateRelayCache()
    calls = []
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return json({ data: { total_granted: 5000000, total_used: 1000000, total_available: 4000000 } })
    }
    const q1 = await R.readRelayQuota(packy, { provider, auth: {} })
    check(
      'New API HTTP：/api/usage/token 成功即返回余额（只出网一次）',
      q1.ok && q1.source === 'newapi-usage-token' && q1.balance.remaining === 8 && calls.length === 1,
      JSON.stringify({ q1, calls })
    )
    const beforeCache = calls.length
    await R.readRelayQuota(packy, { provider, auth: {} })
    check('中转站缓存：45s 内同一 provider 不重复出网', calls.length === beforeCache, JSON.stringify(calls))

    R.invalidateRelayCache()
    calls = []
    globalThis.fetch = async (url) => {
      const s = String(url)
      calls.push(s)
      if (s.indexOf('/api/usage/token') !== -1) return json({ error: 'not found' }, 404)
      if (s.indexOf('/v1/dashboard/billing/subscription') !== -1) return json({ hard_limit_usd: 10 })
      if (s.indexOf('/v1/dashboard/billing/usage') !== -1) return json({ total_usage: 400 })
      return json({}, 404)
    }
    const q2 = await R.readRelayQuota(packy, { provider, auth: {} })
    check(
      'New API HTTP：token 接口 404 → 账单接口兜底（subscription + usage 两次）',
      q2.ok && q2.source === 'newapi-billing' && q2.balance.remaining === 6 && calls.length === 3,
      JSON.stringify({ q2, calls })
    )

    R.invalidateRelayCache()
    calls = []
    let selfHeaders = null
    globalThis.fetch = async (url, opts) => {
      const s = String(url)
      calls.push(s)
      if (s.indexOf('/api/user/self') !== -1) {
        selfHeaders = opts.headers
        return json({ data: { quota: 4000000, used_quota: 1000000 } })
      }
      return json({}, 404)
    }
    const q3 = await R.readRelayQuota(packy, {
      provider: { ...provider, apiKey: '' },
      auth: { token: 'sys-token', userId: '42' },
    })
    check(
      'New API HTTP：系统访问令牌 + 用户 ID 兜底（Authorization 原文 + New-Api-User）',
      q3.ok &&
        q3.source === 'newapi-user-self' &&
        q3.balance.remaining === 8 &&
        selfHeaders &&
        selfHeaders.authorization === 'sys-token' &&
        selfHeaders['New-Api-User'] === '42',
      JSON.stringify({ q3, headers: selfHeaders && { authorization: selfHeaders.authorization, user: selfHeaders['New-Api-User'] } })
    )

    R.invalidateRelayCache()
    calls = []
    globalThis.fetch = async () => {
      calls.push('SHOULD_NOT_FETCH')
      throw new Error('network should not be reached')
    }
    const hapi = R.RELAYS.find((r) => r.id === 'hapi')
    const q4 = await R.readRelayQuota(hapi, {
      provider: {
        providerId: 'selftest-hapi',
        baseUrl: 'https://hapiopen.cc',
        host: 'hapiopen.cc',
        apiKey: '',
        providerName: 'H API',
        isLocal: false,
      },
      auth: {},
    })
    check(
      '中转站无凭据：不出网，直接说「未找到 API Key」',
      !q4.ok && /API Key/.test(String(q4.reason)) && calls.length === 0,
      JSON.stringify({ q4, calls })
    )

    R.invalidateRelayCache()
    calls = []
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return json({
        mode: 'quota_limited',
        rate_limits: [
          { window: '5h', used: 1, total: 5 },
          { window: '7d', used: 50, total: 100 },
        ],
      })
    }
    const q5 = await R.readRelayQuota(R.RELAYS.find((r) => r.id === 'sssaicode'), {
      provider: {
        providerId: 'selftest-sssai',
        baseUrl: 'https://node-hk.sssaiapi.com',
        host: 'node-hk.sssaiapi.com',
        apiKey: 'k-test',
        providerName: 'SSSAICode',
        isLocal: false,
      },
      auth: {},
    })
    check(
      'Sub2API HTTP：/v1/usage 两窗口正常返回',
      q5.ok && q5.windows.length === 2 && q5.windows[0].label === '5小时' && q5.windows[1].label === '本周',
      JSON.stringify(q5)
    )

    R.invalidateRelayCache()
    calls = []
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return json({ balance: 12.34, five_hour: { used: 1.23, limit: 5 } })
    }
    const q6 = await R.readRelayQuota(R.RELAYS.find((r) => r.id === 'cubence'), {
      provider: {
        providerId: 'selftest-cubence',
        baseUrl: 'https://api.cubence.com',
        host: 'api.cubence.com',
        apiKey: 'k-test',
        providerName: 'Cubence',
        isLocal: false,
      },
      auth: {},
    })
    check(
      'Cubence HTTP：/v1/user/subscription-info 余额 + 5 小时窗口',
      q6.ok && q6.windows[0].label === '5小时' && q6.balance.remaining === 12.34,
      JSON.stringify(q6)
    )

    R.invalidateRelayCache()
    calls = []
    const q7 = await R.readRelayQuota(packy, {
      provider: { ...provider, baseUrl: 'https://evil.example', host: 'evil.example' },
      auth: {},
    })
    check(
      '中转站出站白名单：provider 指向非注册表主机时拒绝，且不发请求',
      !q7.ok && calls.length === 0,
      JSON.stringify({ q7, calls })
    )

    R.invalidateRelayCache()
    calls = []
    let release = null
    const gate = new Promise((resolve) => {
      release = resolve
    })
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      await gate
      return json({ data: { total_granted: 5000000, total_used: 1000000, total_available: 4000000 } })
    }
    const p1 = R.readRelayQuota(packy, { provider, auth: {} })
    const p2 = R.readRelayQuota(packy, { provider, auth: {} })
    release()
    const [r1, r2] = await Promise.all([p1, p2])
    check(
      '中转站并发合并：同一 provider 的两个并发请求只出网一次',
      calls.length === 1 && r1.ok && r2.ok && r1.balance.remaining === 8,
      JSON.stringify({ calls, ok: [r1.ok, r2.ok] })
    )
  } finally {
    globalThis.fetch = realFetch
    R.invalidateRelayCache()
  }
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
    '计费源：非火山 coding-plan 保持 GLM 套餐（含 individual-coding-plan），volc 名称不冒充',
    ['individual-coding-plan', 'account:individual-coding-plan', 'account:coding-plan']
      .every((pid) => resolveBillingSource(pid, 'GLM-5.3', undefined, { glmSubscription: false }).source === 'plan') &&
      resolveBillingSource('volc-coding-plan', 'GLM-5.3', undefined, { glmSubscription: false }).source !== 'plan'
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
    '计费源：Gemini 按官方端点 / provider 名 / 模型名三路识别（都是 USD 现金口径）',
    r('google', 'gemini-4-argon', 'https://generativelanguage.googleapis.com/v1beta/openai') === 'gemini' &&
      r('google-cloud', 'whatever', '') === 'gemini' &&
      r('', 'gemini-4-ar', '') === 'gemini' &&
      resolveBillingSource('google', 'gemini-4-argon').currency === 'USD' &&
      resolveBillingSource('google', 'gemini-4-argon').timeMode === 'none'
  )
  check(
    '计费源：cmdgo 反代 → CommandCode 额度口径（限额走其套餐池，不看模型名）',
    r('cmdgo-bridge', 'deepseek/deepseek-v4-flash', 'http://127.0.0.1:11435/v1') === 'cmdgo' &&
      r('cmdgo-bridge', 'xiaomi/mimo-v2.6-pro', 'http://127.0.0.1:11435/v1') === 'cmdgo'
  )
  check(
    '计费源：CommandCode 官方 API provider（commandcode-*）也走额度口径，不按模型名算成厂商真金白银',
    r('commandcode-goat-1', 'gpt-6-luna') === 'cmdgo' &&
      r('commandcode-goat-1-claude', 'claude-sonnet-5-5') === 'cmdgo' &&
      r('commandcode-goat-2', 'deepseek/deepseek-v4-pro') === 'cmdgo'
  )
  const ark = 'https://ark.cn-beijing.volces.com'
  const vr = (url, pid = '9de0b0cd-43cc-4b9d-867c-32030235e990', config = {}) =>
    resolveBillingSource(pid, 'deepseek-v3', url, { config, glmSubscription: false })
  check('火山：不含厂商关键词的 provider 按官方路径区分三种模式',
    vr(ark + '/api/v3').source === 'volc-api' && vr(ark + '/api/v3').volcMode === 'api' &&
    vr(ark + '/api/coding').source === 'volc' && vr(ark + '/api/coding').planType === 'coding' &&
    vr(ark + '/api/plan/v3').source === 'volc' && vr(ark + '/api/plan/v3').planType === 'agent')
  check('火山：支持两种协议、末尾斜杠和域名大小写',
    [ark + '/api/coding/v3/', 'https://ARK.CN-BEIJING.VOLCES.COM/api/coding'].every(u => vr(u).planType === 'coding') &&
    [ark + '/api/plan/', ark + '/api/plan/v3'].every(u => vr(u).planType === 'agent'))
  check('火山：未知路径与非标准入口不能自动清零',
    ['/api/coding-extra', '/api/plan/v3/chat/completions', '/API/coding', '/api/coding?x=1', '/api/coding#x', '/api/%63oding', '/'].every(p => vr(ark + p).source === 'volc-api') &&
    ['http://ark.cn-beijing.volces.com/api/coding', 'https://ark.cn-beijing.volces.com:8443/api/coding',
      'https://user@ark.cn-beijing.volces.com/api/coding', 'https://other.volces.com/api/coding',
      'https://open.volcengineapi.com/api/coding'].every(u => vr(u).source === 'volc-api'))
  check('火山：伪域名不能进入火山分类',
    ['evilvolces.com', 'volcengine.example.com', 'ark.cn-beijing.volces.com.evil.example'].every(h => vr('https://' + h + '/api/coding').vendor !== 'volc'))
  check('火山：provider 名称与旧声明不覆盖 URL',
    vr(ark + '/api/v3', 'volc-coding-plan', { volcBillingByProvider: { 'volc-coding-plan': 'plan' }, displayMode: 'volc' }).source === 'volc-api' &&
    vr(ark + '/api/plan', 'uuid', { volcBillingByProvider: { uuid: 'api' } }).planType === 'agent' &&
    vr('', 'volc-coding-plan').vendor !== 'volc')
  check('火山：平台标签与套餐类型一致', vr(ark + '/api/v3').label === '火山方舟' &&
    vr(ark + '/api/coding').label === '火山 Coding Plan' && vr(ark + '/api/plan').label === '火山 Agent Plan')
  // GLM 订阅修正：大模型的 provider/host 名字区分不出「订阅」与「按量」（同一个
  // open.bigmodel.cn、同一把 key 形状），但账号事实分得出——有 GLM Coding Plan 套餐
  // 配额时按 Plan 口径（订阅持有者的 GLM 用量扣的是订阅额度，不是按量账单）
  check(
    '计费源：GLM 订阅修正（账号有套餐配额时 GLM 源按 Plan 口径；无订阅事实时保持按量）',
    resolveBillingSource('bigmodel-api', 'GLM-5.3-Flash', undefined, { glmSubscription: true }).source === 'plan' &&
      resolveBillingSource('bigmodel-api', 'GLM-5.3-Flash', undefined, { glmSubscription: true }).label === 'GLM Plan 配额' &&
      resolveBillingSource('bigmodel-api', 'GLM-5.3-Flash', undefined, { glmSubscription: false }).source === 'glm' &&
      // 只改 GLM 源：其它厂商（含 DeepSeek / MiMo）不受这条修正影响
      resolveBillingSource('deepseek', 'deepseek-flash', undefined, { glmSubscription: true }).source === 'ds' &&
      resolveBillingSource('xiaomi-mimo', 'mimo-v2.6-pro', undefined, { glmSubscription: true }).source === 'mimo-api' &&
      resolveBillingSource('bigmodel-standard-api', 'GLM-5.3', 'https://open.bigmodel.cn/api/paas/v4', { glmSubscription: true }).source === 'plan',
    JSON.stringify({
      sub: resolveBillingSource('bigmodel-api', 'GLM-5.3-Flash', undefined, { glmSubscription: true }).source,
      plain: resolveBillingSource('bigmodel-api', 'GLM-5.3-Flash', undefined, { glmSubscription: false }).source,
      ds: resolveBillingSource('deepseek', 'deepseek-flash', undefined, { glmSubscription: true }).source,
    })
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

// v1.8.0 与上游 DSH 版对齐补齐的模板：字段口径照上游（纯函数，不出网）
{
  const nov = TEMPLATES.novita.balance.pick({ availableBalance: 123456 })
  const step = TEMPLATES.stepfun.balance.pick({ balance: 12.5 })
  check(
    '新模板：novita 原始单位 1e-4 换算 + stepfun 余额字段',
    nov && Math.abs(nov.amount - 12.3456) < 1e-9 && nov.currency === 'USD' && step && step.amount === 12.5 && step.currency === 'CNY',
    JSON.stringify({ nov, step })
  )
  // Gemini 双条目（2026-10-15）：API key 按量（凭据可发现）+ 订阅（无凭据设计，
  // statusNote 说明「额度在官网看」，未配置凭据不是故障）
  check(
    'Gemini 模板：api 条目带 GEMINI_API_KEY 凭据链；订阅条目无凭据设计且 statusNote 就位',
    TEMPLATES.gemini && TEMPLATES.gemini.kind === 'tokens' && (TEMPLATES.gemini.envKeys || []).indexOf('GEMINI_API_KEY') !== -1 &&
      TEMPLATES['gemini-plan'] && TEMPLATES['gemini-plan'].kind === 'tokens' &&
      (TEMPLATES['gemini-plan'].envKeys || []).length === 0 &&
      String(TEMPLATES['gemini-plan'].statusNote || '').indexOf('gemini.google.com') !== -1,
    JSON.stringify({ api: TEMPLATES.gemini && TEMPLATES.gemini.envKeys, plan: TEMPLATES['gemini-plan'] && TEMPLATES['gemini-plan'].kind })
  )
  // 订阅条目无凭据时的状态载荷：available=false 但 reason 是说明文案而非「未配置凭据」
  //（listVendorStatus 不出网：tokens kind 只读本地配置）
  const vstat = await listVendorStatus(true)
  const gp = vstat.vendors.find((v) => v.id === 'gemini-plan')
  check(
    'Gemini 订阅：无凭据时状态回落到 statusNote（listVendorStatus 不出网）',
    gp && gp.available === false && String(gp.reason || '').indexOf('官方无公开的订阅余额接口') !== -1,
    JSON.stringify(gp && { available: gp.available, reason: (gp.reason || '').slice(0, 40) })
  )
  const mm = TEMPLATES['minimax-coding'].quota.pick({
    model_remains: [{ current_interval_remaining_percent: 62, current_weekly_remaining_percent: 81 }],
  })
  check(
    '新模板：MiniMax 剩余% → 已用%（5 小时 + 本周两条）',
    Array.isArray(mm) &&
      mm.length === 2 &&
      mm[0].label === '5 小时' &&
      mm[0].percentUsed === 38 &&
      mm[1].label === '本周' &&
      mm[1].percentUsed === 19,
    JSON.stringify(mm)
  )
  const oc = TEMPLATES['opencode-go'].quota.pick({
    usage: { rolling: { percent: 42, resetsAt: 1790000000000 }, weekly: { percent: 7 }, monthly: { percent: 3 } },
  })
  check(
    '新模板：OpenCode Go 三窗口（接口直接给已用%，带重置时间）',
    Array.isArray(oc) &&
      oc.length === 3 &&
      oc[0].label === '5 小时' &&
      oc[0].percentUsed === 42 &&
      oc[0].resetAt === 1790000000000 &&
      oc[2].label === '本月',
    JSON.stringify(oc)
  )
  const kc = TEMPLATES['kimi-coding'].quota.pick({ usage: { remaining: 25, limit: 100 } })
  check('新模板：Kimi Coding 剩余/总额 → 已用 75%', Array.isArray(kc) && kc.length === 1 && kc[0].percentUsed === 75, JSON.stringify(kc))
  // v1.8.9：真实响应是 used/limit（无 remaining）+ usage=周窗口 + limits[]=滚动窗口；
  // 5 小时窗口 = window.duration(timeUnit) 折算 250–360 分钟
  const kw = TEMPLATES['kimi-coding'].quota.pick({ usage: { used: 30, limit: 100, resetTime: '2026-10-12T00:00:00Z' } })
  check(
    'kimi-coding：used/limit 口径 → 周额度 70%，resetTime 透传',
    Array.isArray(kw) && kw.length === 1 && kw[0].label === '周额度' && kw[0].percentUsed === 30 && kw[0].resetAt === '2026-10-12T00:00:00Z',
    JSON.stringify(kw)
  )
  const kd = TEMPLATES['kimi-coding'].quota.pick({
    usage: { used: 30, limit: 100, resetTime: '2026-10-12T00:00:00Z' },
    limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { used: 2, limit: 20, resetTime: '2026-10-05T18:00:00Z' } }],
  })
  check(
    'kimi-coding：双窗口——周额度在前，5 小时窗口（HOUR×5=300 分钟）取 row.detail',
    Array.isArray(kd) && kd.length === 2 && kd[0].label === '周额度' && kd[0].percentUsed === 30 &&
      kd[1].label === '5 小时' && kd[1].percentUsed === 10 && kd[1].resetAt === '2026-10-05T18:00:00Z',
    JSON.stringify(kd)
  )
  // v1.8.10：pickVendorBalance 兼容数组与 {vendors:[...]} 包装两种形态，
  // 按优先级取第一个 ok 且 balance 为数字的模板；不可用条目跳过
  const pvb = pickVendorBalance(
    { ok: true, vendors: [{ id: 'moonshot-intl', ok: true, balance: 2.5, currency: 'USD' }, { id: 'moonshot-cn', ok: true, balance: 8.5, currency: 'CNY' }] },
    ['moonshot-cn', 'moonshot-intl']
  )
  check(
    '厂商余额挑选：包装对象形态 + 优先级取 moonshot-cn（CNY）',
    pvb && pvb.id === 'moonshot-cn' && pvb.amount === 8.5 && pvb.currency === 'CNY',
    JSON.stringify(pvb)
  )
  const pva = pickVendorBalance([{ id: 'moonshot-cn', available: false, reason: '未配置凭据' }], ['moonshot-cn', 'moonshot-intl'])
  check('厂商余额挑选：数组形态 + 不可用条目跳过（返回 null）', pva === null, JSON.stringify(pva))
  const kb = TEMPLATES['kimi-coding'].quota.pick({
    usage: { used: 30, limit: 100 },
    limits: [{ window: { duration: 18000, timeUnit: 'TIME_UNIT_SECOND' }, detail: { used: 9, limit: 10 } }],
  })
  check(
    'kimi-coding：SECOND 单位折算（18000s=300 分钟）也识别为 5 小时窗口；缺 resetAt 为 null',
    Array.isArray(kb) && kb.length === 2 && kb[1].label === '5 小时' && kb[1].percentUsed === 90 && kb[1].resetAt === null,
    JSON.stringify(kb)
  )
  const zi = TEMPLATES['zhipu-coding-intl'].quota.pick({ data: { limits: [{ TOKENS_LIMIT: { percentage: 88 } }] } })
  check('新模板：国际站 z.ai 与国内站同形（host 换域）', Array.isArray(zi) && zi[0].percentUsed === 88, JSON.stringify(zi))
  check(
    '新模板：缺字段一律返回 null（不编造额度）',
    TEMPLATES['minimax-coding'].quota.pick({}) === null &&
      TEMPLATES['kimi-coding'].quota.pick({ usage: { limit: 100 } }) === null &&
      TEMPLATES.novita.balance.pick({}) === null &&
      TEMPLATES['opencode-go'].quota.pick({ usage: {} }) === null
  )
  const want = [
    'stepfun',
    'novita',
    'kimi-coding',
    'minimax-coding',
    'minimax-coding-intl',
    'opencode-go',
    'zhipu-coding-intl',
    'openai',
    'anthropic',
    'gemini',
    'xai',
    'groq',
    'mistral',
    'together',
    'fireworks',
    'deepinfra',
    'cerebras',
    'siliconflow-cn',
    'siliconflow-en',
    'volcengine-ark',
    'dashscope',
    'qianfan',
    'hunyuan',
    'spark',
    'modelscope',
    'ollama',
  ]
  const missing = want.filter((id) => !TEMPLATES[id])
  check('新补厂商模板齐全（26 条）', missing.length === 0, '缺：' + missing.join(','))
  const matches = {
    stepfun: matchTemplateId(['stepfun', 'Step-3.7-Flash']),
    novita: matchTemplateId(['novita']),
    kimiCoding: matchTemplateId(['kimi-coding', 'Kimi Coding']),
    minimax: matchTemplateId(['minimaxi']),
    opencode: matchTemplateId(['opencode-go']),
    dashscope: matchTemplateId(['dashscope', 'qwen-max']),
    anthropic: matchTemplateId(['anthropic', 'claude-sonnet']),
    ollama: matchTemplateId(['local', 'ollama']),
    zaiIntl: matchTemplateId(['z.ai', 'intl']),
  }
  check(
    '模板匹配：新厂商关键词命中且不误伤（cmdgo-bridge / GLM 大陆站仍走原判定）',
    matches.stepfun === 'stepfun' &&
      matches.novita === 'novita' &&
      matches.kimiCoding === 'kimi-coding' &&
      matches.minimax === 'minimax-coding' &&
      matches.opencode === 'opencode-go' &&
      matches.dashscope === 'dashscope' &&
      matches.anthropic === 'anthropic' &&
      matches.ollama === 'ollama' &&
      matches.zaiIntl === 'zhipu-coding-intl' &&
      matchTemplateId(['zhipu-coding']) === 'bigmodel-glm' &&
      matchTemplateId(['cmdgo-bridge']) === null,
    JSON.stringify(matches)
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

// 立绘几何自检用：只解 PNG 拿「画布尺寸 + alpha 包围盒」，够判同画布/内容高/右边底边贴齐
function pngGeom(buf) {
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  const ch = buf[25] === 6 ? 4 : buf[25] === 2 ? 3 : 1
  let off = 8
  const idat = []
  while (off < buf.length - 8) {
    const len = buf.readUInt32BE(off)
    const type = buf.slice(off + 4, off + 8).toString('ascii')
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len))
    else if (type === 'IEND') break
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  let prev = Buffer.alloc(stride)
  const rows = []
  let p = 0
  for (let y = 0; y < h; y++) {
    const f = raw[p++]
    const line = raw.slice(p, p + stride)
    p += stride
    const cur = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0
      const b = prev[i]
      const c = i >= ch ? prev[i - ch] : 0
      let v = line[i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
    rows.push(cur)
    prev = cur
  }
  let minX = w, maxX = -1, minY = h, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const al = ch === 4 ? rows[y][x * 4 + 3] : 255
      if (al <= 8) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { w, h, minX, maxX, minY, maxY, cw: maxX - minX + 1, chh: maxY - minY + 1 }
}

async function waitReady(port, deadlineMs, child) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const health = await getJson(port, '/whale/health')
      if (health && health.app === 'zcode-fox-widget') return health
    } catch (err) {}
    // 子进程已经退了就别再空等：早退多半是端口占用或启动即崩，日志里有原因
    if (child && child.exitCode !== null) return null
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

const serverEnv = {
  ...process.env,
  ZCODE_HOME: tmpHome,
  ZCODE_DATA_BASE_DIR: tmpHome,
  // CommandCode 额度读取隔离：指向空目录，绝不读真实反代凭据、绝不真出网
  CMDGO_DIR: path.join(tmpHome, 'cmdgo-empty'),
  // 版本自检会向镜像发真实请求：测试环境整个关掉（见 lib/update.mjs 的 startAutoCheck）
  WHALE_DISABLE_UPDATE_CHECK: '1',
}
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

  // 启动等待给足 30 秒：机器忙（并发跑别的测试、杀软扫描、磁盘争用）时 node 冷启动
  // 可能远超 8 秒，曾被判成「服务未就绪」的假失败。子进程早退则不等满。
  const health = await waitReady(PORT, 30000, child)
  check(
    '服务在临时端口就绪',
    !!health,
    health
      ? 'port=' + health.port + ' pid=' + health.pid
      : 'port=' + PORT + ' exitCode=' + child.exitCode + ' log=' + childLog.slice(0, 400)
  )
  if (!health) throw new Error('服务未就绪')
  const port = health.port
  // 凭据诊断需要令牌（审查 U2）：这个端口本机任意进程都能读，所以掩码 key / 候选凭据
  // 文件路径 / 状态文件路径只在带令牌时回；未鉴权只回 keySource。
  const serverInfo = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'))
  const anonHealth = await (await fetch('http://127.0.0.1:' + port + '/whale/health')).json()
  const authedHealth = await (
    await fetch('http://127.0.0.1:' + port + '/whale/health', { headers: { 'x-whale-token': serverInfo.token } })
  ).json()
  check(
    'health 免鉴权只回 keySource（掩码 key / 候选路径 / 状态文件路径都收起来）',
    anonHealth.keySource !== undefined &&
      anonHealth.keyProbe === undefined &&
      anonHealth.keyMasked === undefined &&
      anonHealth.stateFile === undefined,
    JSON.stringify({
      keySource: anonHealth.keySource,
      probe: !!anonHealth.keyProbe,
      masked: !!anonHealth.keyMasked,
      stateFile: !!anonHealth.stateFile,
    })
  )
  check(
    'health 带令牌回 key 探测诊断（列出 provider 条目，enc 密文被标记）',
    authedHealth.keyProbe &&
      Array.isArray(authedHealth.keyProbe.entries) &&
      authedHealth.keyProbe.entries.some((e) => e.providerId === 'deepseek-encrypted' && e.keyEncrypted === true),
    'keySource=' + authedHealth.keySource + ' entries=' + ((authedHealth.keyProbe && authedHealth.keyProbe.entries) || []).length
  )
  // 关于 / 自检（v1.15.2）：一份脱敏诊断快照，供用户直接复制给维护者
  {
    const res = await fetch('http://127.0.0.1:' + port + '/whale/diag.json')
    const text = await res.text()
    const diag = JSON.parse(text)
    const home = os.homedir()
    check(
      '关于 / 自检：返回版本、运行环境与服务信息',
      res.ok &&
        diag.ok &&
        diag.plugin.version === health.version &&
        !!diag.runtime.node &&
        diag.runtime.port === port &&
        typeof diag.runtime.uptimeSec === 'number',
      JSON.stringify({ v: diag.plugin && diag.plugin.version, node: diag.runtime && diag.runtime.node, port: diag.runtime && diag.runtime.port })
    )
    check(
      '关于 / 自检：路径做过家目录脱敏（响应里不含用户主目录）',
      typeof diag.paths.dataDir === 'string' && diag.paths.dataDir.indexOf(home) === -1 && text.indexOf(home) === -1,
      diag.paths.dataDir
    )
    check(
      '关于 / 自检：只回 hasApiKey 布尔值，响应里没有密钥明文或掩码',
      typeof diag.config.hasApiKey === 'boolean' &&
        diag.config.apiKey === undefined &&
        !/sk-[A-Za-z0-9]{6,}/.test(text) &&
        text.indexOf('keyMasked') === -1,
      'hasApiKey=' + diag.config.hasApiKey
    )
    check(
      '关于 / 自检：带更新状态与浮层日志尾部（无任务时 phase 归 null）',
      !!diag.update &&
        diag.update.current === diag.plugin.version &&
        diag.update.busy === false &&
        diag.update.phase === null &&
        Array.isArray(diag.logs.overlayTail) &&
        diag.logs.overlayTail.length <= 20,
      JSON.stringify({ update: diag.update && diag.update.current, tail: diag.logs.overlayTail.length })
    )
  }

  // 浮层 spawn：环境清理 + profile 按端口隔离（审查 I1·U4）。这条是**行为**断言，
  // 直接调真函数，不靠源码正则。
  {
    const { overlaySpawnEnv, overlayProfileDir } = await import('../lib/overlay.mjs')
    const { DATA_DIR: overlayDataDir } = await import('../lib/paths.mjs')
    const prevRN = process.env.ELECTRON_RUN_AS_NODE
    const prevNO = process.env.NODE_OPTIONS
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.NODE_OPTIONS = '--require=host-shim.cjs'
    const env = overlaySpawnEnv({ port: 12345 })
    if (prevRN === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = prevRN
    if (prevNO === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = prevNO
    const prof = overlayProfileDir(12345)
    check(
      '浮层 spawn：清掉 ELECTRON_RUN_AS_NODE/NODE_OPTIONS，数据目录与 profile 按端口隔离',
      env.ELECTRON_RUN_AS_NODE === undefined &&
        env.NODE_OPTIONS === undefined &&
        env.WHALE_PORT === '12345' &&
        (env.WHALE_DATA_DIR === undefined || env.WHALE_DATA_DIR === overlayDataDir) &&
        prof.indexOf(overlayDataDir) === 0 &&
        prof.indexOf('12345') !== -1 &&
        overlayProfileDir(12345) !== overlayProfileDir(12346),
      JSON.stringify({ port: env.WHALE_PORT, dataDir: env.WHALE_DATA_DIR, profile: prof })
    )
  }

  // 审查 P2-2：版本号单一来源——health（server 动态读 plugin.json）、清单、
  // marketplace.json 副本三者一致，漂移即发版漏改
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.zcode-plugin', 'plugin.json'), 'utf8'))
  const marketplaceManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'marketplace.json'), 'utf8'))
  check(
    '版本号单一来源：health = plugin.json = marketplace.json',
    health.version === pluginManifest.version && marketplaceManifest.plugins[0].version === pluginManifest.version,
    JSON.stringify({ health: health.version, plugin: pluginManifest.version, market: marketplaceManifest.plugins[0].version })
  )
  // 独立页面 CSP（审查 P3-3）：textContent + http(s) href 的 XSS 防线由浏览器强制化
  {
    const pageResp = await fetch('http://127.0.0.1:' + port + '/')
    const csp = pageResp.headers.get('content-security-policy') || ''
    check(
      '独立页面带 CSP：default-src/script-src self、img-src self data:',
      /default-src 'self'/.test(csp) && /script-src 'self'/.test(csp) && /img-src 'self' data:/.test(csp),
      JSON.stringify({ csp: csp.slice(0, 140) })
    )
  }
  // 审查 P3-2：本地/私有判定统一口径——link-local / CGNAT / 0.0.0.0/8 都拦、
  // 公网域名放行；discover 与 credentials 共用 lib/blocked-host.mjs
  check(
    '本地判定统一口径：169.254/100.64/0.0.0.0 拦截、公网放行',
    isBlockedHost('169.254.169.254') && isBlockedHost('100.64.0.1') && isBlockedHost('0.1.2.3') &&
      isBlockedHost('localhost') && isBlockedHost('192.168.1.1') && !isBlockedHost('api.deepseek.com'),
    JSON.stringify({ linkLocal: isBlockedHost('169.254.169.254'), cgnat: isBlockedHost('100.64.0.1'), thisNet: isBlockedHost('0.1.2.3') })
  )
  // 审查 P3-2 同型回归：IPv4-mapped IPv6（::ffff:127.0.0.1 / ::ffff:7f00:1）解包后
  // 按 IPv4 判定——否则形如 http://[::ffff:127.0.0.1]:8080/ 的网关不被识别成本地
  check(
    '本地判定 IPv4-mapped IPv6：映射的环回/私网拦、映射的公网放行、NAT64 前缀保守拦',
    isBlockedHost('::ffff:127.0.0.1') && isBlockedHost('[::ffff:127.0.0.1]') && isBlockedHost('[::ffff:7f00:1]') &&
      isBlockedHost('::ffff:192.168.1.1') && isBlockedHost('[64:ff9b::1]') && !isBlockedHost('::ffff:8.8.8.8'),
    JSON.stringify({
      mappedLoopback: isBlockedHost('::ffff:127.0.0.1'),
      mappedHex: isBlockedHost('[::ffff:7f00:1]'),
      mappedPrivate: isBlockedHost('::ffff:192.168.1.1'),
      nat64: isBlockedHost('[64:ff9b::1]'),
      mappedPublic: isBlockedHost('::ffff:8.8.8.8'),
    })
  )
  // 周末全天谷价（pricing.isPeakTime）：2026-08-23 00:00（北京，周日）起周末不再有高峰。
  // 判定基准 = 北京日历日；生效时刻之前（含前 1 小时的周六）照旧按旧规则计价
  {
    const from = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // = 2026-08-23 00:00+08（周日）
    check(
      '周末全天谷价：生效前 1 小时（周六 10:00+08）仍判高峰；生效后的周日 10:00/15:00 判谷价；周一 10:00 照常高峰',
      isPeakTime(from - 14 * 3600) === true &&
        isPeakTime(from + 10 * 3600) === false &&
        isPeakTime(from + 15 * 3600) === false &&
        isPeakTime(from + 34 * 3600) === true,
      JSON.stringify({
        satBeforeEdge: isPeakTime(from - 14 * 3600),
        sunMorning: isPeakTime(from + 10 * 3600),
        sunAfternoon: isPeakTime(from + 15 * 3600),
        monday: isPeakTime(from + 34 * 3600),
      })
    )
  }
  // 峰谷倒计时的切换点推算（pricing.nextPeakChange）：与 isPeakTime 同口径，
  // 边界点 = 北京 0/9/12/14/18 点整。周五晚/周六都要跨过周末找到周一 9:00
  {
    const mon10 = Math.floor(Date.UTC(2026, 9, 12, 2, 0, 0) / 1000) // 周一 10:00+08（高峰）
    const mon13 = mon10 + 3 * 3600 // 13:00（12–14 谷段）
    const mon12 = mon10 + 2 * 3600 // 12:00:00 整（恰在边界，谷侧）
    const fri19 = Math.floor(Date.UTC(2026, 9, 16, 11, 0, 0) / 1000) // 周五 19:00+08（谷）
    const sat10 = Math.floor(Date.UTC(2026, 9, 17, 2, 0, 0) / 1000) // 周六 10:00+08（谷）
    const mon09 = Math.floor(Date.UTC(2026, 9, 19, 1, 0, 0) / 1000) // 下周一 09:00+08
    const tue09 = Math.floor(Date.UTC(2026, 9, 13, 1, 0, 0) / 1000) // 次日 09:00+08
    check(
      'nextPeakChange：峰中→当天 12:00；12:00 整→14:00；谷段→14:00；深夜→次日 9:00；周五晚/周六跨周末→周一 9:00',
      nextPeakChange(mon10) === mon10 + 2 * 3600 &&
        nextPeakChange(mon12) === mon12 + 2 * 3600 &&
        nextPeakChange(mon13) === mon13 + 3600 &&
        nextPeakChange(fri19) === mon09 &&
        nextPeakChange(sat10) === mon09 &&
        nextPeakChange(mon10 + 13 * 3600) === tue09,
      JSON.stringify({
        peakToNoon: nextPeakChange(mon10) - mon10,
        noonEdge: nextPeakChange(mon12) - mon12,
        valleyTo14: nextPeakChange(mon13) - mon13,
        friToMon: Math.round((nextPeakChange(fri19) - fri19) / 3600),
        satToMon: Math.round((nextPeakChange(sat10) - sat10) / 3600),
        nightTo9: Math.round((nextPeakChange(mon10 + 13 * 3600) - (mon10 + 13 * 3600)) / 3600),
      })
    )
  }
  // Plan 日志尾窗逐级扩读 + 32MB 封顶（审查 P2-2 回归）：封顶后找不到标记就
  // 如实返回 null，绝不再同步读整个文件（Infinity 级会把服务事件循环冻结数秒）
  {
    const lab = path.join(tmpHome, 'plan-tail-lab')
    fs.mkdirSync(lab, { recursive: true })
    const markerLine = (payload) => '[' + new Date().toISOString() + '][info] billing/balance 请求完成 ' + JSON.stringify(payload) + '\n'
    const big = path.join(lab, 'big.log')
    const fdBig = fs.openSync(big, 'w')
    fs.writeSync(fdBig, markerLine({ percentRemaining: 42 }), 0) // 标记在文件头：任何尾窗都罩不住
    fs.ftruncateSync(fdBig, 33 * 1024 * 1024) // 稀疏补长到 33MB，标记落在 32MB 尾窗之外
    fs.closeSync(fdBig)
    check(
      'Plan 尾窗封顶：标记在 32MB 尾窗之外（33MB 文件）→ 如实返回 null',
      readLogFile(big) === null,
      JSON.stringify({ hit: readLogFile(big) !== null })
    )
    const mid = path.join(lab, 'mid.log')
    const fdMid = fs.openSync(mid, 'w')
    fs.writeSync(fdMid, 'x'.repeat(1024 * 1024) + '\n')
    fs.writeSync(fdMid, markerLine({ percentRemaining: 7 }), 2 * 1024 * 1024) // 标记距尾部 3MB：第一级漏、第二级罩住
    fs.ftruncateSync(fdMid, 5 * 1024 * 1024)
    fs.closeSync(fdMid)
    const midHit = readLogFile(mid)
    check(
      'Plan 尾窗扩读：标记距尾 3MB（512KB 漏、4MB 罩住）→ 仍能找到',
      !!midHit && midHit.lines.length === 1 && midHit.lines[0].percentRemaining === 7,
      JSON.stringify(midHit && midHit.lines[0])
    )
    const near = path.join(lab, 'near.log')
    fs.writeFileSync(near, markerLine({ percentRemaining: 9 }), 'utf8')
    const nearHit = readLogFile(near)
    check(
      'Plan 尾窗默认档：标记在 512KB 内 → 直接命中',
      !!nearHit && nearHit.lines.length === 1 && nearHit.lines[0].percentRemaining === 9,
      JSON.stringify(nearHit && nearHit.lines[0])
    )
  }

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
  // 按量（真金白银）行的合计：套餐行与后面的 CommandCode credit 行都不进这个数。
  // 主显示的「DeepSeek 今日已用」就该等于它。
  const paidApiTotal =
    costOfUsage('deepseek-flash', { input_tokens: 1, output_tokens: 1, computed_total_tokens: 2 }, atA, 'deepseek-test').amount +
    costOfUsage('deepseek-flash', USAGE_B, atB, 'deepseek-test').amount +
    dsPart
  check(
    '多模型轮次按行加总并带逐模型明细（套餐行按配额扣、金额记 0 不进轮级金额）',
    third && third.seq === 2 && Array.isArray(third.models) && third.models.length === 2 && Math.abs(third.amount - dsPart) < 1e-9,
    '期望 ¥' + dsPart.toFixed(6) + '，实际 ¥' + Number(third && third.amount).toFixed(6) + '，models=' + (third && third.models ? third.models.length : '无')
  )
  check('混合轮次的金额构成两种厂商', glmPart > 0 && dsPart > 0, 'GLM ¥' + glmPart.toFixed(4) + ' + DeepSeek ¥' + dsPart.toFixed(4))

  // Plan 配额端到端：/whale/plan.json 读 fixture 日志；GLM 轮次的 quotaPct 用主模型桶算。
  // fixture 日志是**当天**的 → 取源链必须停在日志源上（新鲜日志优先，一次出站都不发）
  const plan = await getJson(port, '/whale/plan.json')
  check(
    'Plan 配额接口返回 fixture 观测，且取源链停在新鲜日志上',
    plan && plan.ok && plan.remaining === 93_000_000 && plan.total === 104_000_000 && plan.source === 'plan-log' && plan.unit === 'tokens',
    JSON.stringify(plan).slice(0, 200)
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
    '厂商模板清单完整（原 8 家 + v1.8.0 补齐的 26 条都在 vendors.json 里）',
    vendors &&
      vendors.ok &&
      [
        'deepseek',
        'zcode-plan',
        'commandcode',
        'bigmodel-glm',
        'openrouter',
        'moonshot-cn',
        'moonshot-intl',
        'zhipu-quota',
        'stepfun',
        'novita',
        'kimi-coding',
        'minimax-coding',
        'minimax-coding-intl',
        'opencode-go',
        'zhipu-coding-intl',
        'openai',
        'anthropic',
        'gemini',
        'xai',
        'groq',
        'mistral',
        'together',
        'fireworks',
        'deepinfra',
        'cerebras',
        'siliconflow-cn',
        'siliconflow-en',
        'volcengine-ark',
        'dashscope',
        'qianfan',
        'hunyuan',
        'spark',
        'modelscope',
        'ollama',
      ].every((id) => byId[id]),
    vendors && vendors.vendors ? vendors.vendors.map((v) => v.id).join(',') : '无'
  )
  check(
    '新补的无余额接口模板按 kind:tokens 呈现（只判凭据，不编造余额）',
    byId.openai &&
      byId.openai.kind === 'tokens' &&
      byId.openai.balance === undefined &&
      byId.ollama &&
      byId.ollama.kind === 'tokens',
    JSON.stringify({ openaiKind: byId.openai && byId.openai.kind, ollamaKind: byId.ollama && byId.ollama.kind })
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

  // 用量记录：今天按模型聚合与逐条事件。先补一轮 2 天前的历史用量，用来区分
  // 「按当天」与「按 7 天」两个模型榜：old-model 只在 7 天榜里出现，且 token
  // 足够大，必然会占据 7 天 token 榜首位。
  const atOld = Date.now() - 2 * 86400_000
  insertTurn(
    'sess_selftest',
    'turn_week_old',
    { input_tokens: 4_000_000, output_tokens: 1_000_000, computed_total_tokens: 5_000_000 },
    atOld,
    [
      {
        model: 'old-model',
        providerId: 'deepseek-test',
        usage: { input_tokens: 4_000_000, output_tokens: 1_000_000, computed_total_tokens: 5_000_000 },
      },
      {
        model: 'deepseek-flash',
        providerId: 'deepseek-test',
        usage: { input_tokens: 100_000, output_tokens: 50_000, computed_total_tokens: 150_000 },
      },
    ]
  )
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
    // v1.7.1（QA I-1）：套餐行（source='plan'）按配额扣、不花钱，日聚合的金额
    // 只含真金白银——glmPart 是 pricing 层的等价市值，不进「今日已用（金额）」
    const expectedToday = costA + costB + dsPart
    check(
      '用量记录：今日金额 = 付费行之和（套餐行不计金额）',
      Math.abs(usage.today.total - expectedToday) < 1e-9,
      '期望 ¥' + expectedToday.toFixed(6) + '，实际 ¥' + usage.today.total.toFixed(6) + '（套餐等价市值 ¥' + glmPart.toFixed(6) + ' 已剔除）'
    )
    // 套餐行金额归零但 tokens 照算：面板与主显示按配额/tokens 表达。
    // v1.7.5：行级补等价市值（market）——只喂「模型排名」的排序与占比条
    const planRow = (usage.today.models || []).find((m) => m.providerId === 'account:zai-start-plan')
    check(
      '用量记录：套餐行金额记 0 但 tokens 照算 + 市值在（与轮级 turnPlanUsage 同口径）',
      planRow && planRow.amount === 0 && planRow.tokens > 0 && planRow.plan === true && Number(planRow.market) > 0,
      JSON.stringify(planRow || null)
    )
    check(
      '用量记录：rankTotal（排名值合计）≥ total（真金白银），两条口径分离',
      Number(usage.today.rankTotal) >= usage.today.total,
      'rankTotal=' + usage.today.rankTotal + ' total=' + usage.today.total
    )
    check(
      '用量记录：厂商金额不含套餐（byVendor.GLM 金额为 0、tokens 在）',
      usage.today.byVendor && usage.today.byVendor.GLM && usage.today.byVendor.GLM.amount === 0 && usage.today.byVendor.GLM.tokens > 0,
      JSON.stringify((usage.today.byVendor || {}).GLM || null)
    )
    // 7 天模型榜：服务端把 range × 口径 的四个榜都排好，页面只换数据源。
    const weekModels = (usage.days7 && usage.days7.models) || []
    const weekTokens = (usage.days7 && usage.days7.modelsByTokens) || []
    const todayNames = (usage.today.models || []).map((m) => m.model)
    const oldWeek = weekModels.find((m) => m.model === 'old-model')
    check(
      '用量记录：7 天模型榜包含更早的模型，当天榜不包含',
      !!oldWeek && todayNames.indexOf('old-model') === -1,
      JSON.stringify({ week: weekModels.map((m) => m.model), today: todayNames })
    )
    check(
      '用量记录：7 天 token 榜把更早的大 token 模型排到首位',
      weekTokens.length > 0 && weekTokens[0].model === 'old-model',
      JSON.stringify(weekTokens.slice(0, 3).map((m) => ({ model: m.model, tokens: m.tokens })))
    )
    const todayDeep = (usage.today.models || []).find((m) => m.model === 'deepseek-flash')
    const weekDeep = weekModels.find((m) => m.model === 'deepseek-flash')
    check(
      '用量记录：7 天同一模型的 token 大于当天（聚合了更早的用量）',
      !!weekDeep && !!todayDeep && weekDeep.tokens > todayDeep.tokens,
      JSON.stringify({ week: weekDeep && weekDeep.tokens, today: todayDeep && todayDeep.tokens })
    )
    const rankOfWeek = (m) => Number(m.market) || Number(m.amount) || 0
    const descByAmount = weekModels.every((m, i) => i === 0 || rankOfWeek(weekModels[i - 1]) >= rankOfWeek(m))
    const descByTokens = weekTokens.every((m, i) => i === 0 || Number(weekTokens[i - 1].tokens) >= Number(m.tokens))
    check(
      '用量记录：7 天两个榜各自降序，rankTotal 与模型榜同源（≥ 真金白银）',
      weekModels.length > 0 &&
        weekTokens.length > 0 &&
        descByAmount &&
        descByTokens &&
        Number(usage.days7.rankTotal) >= Number(usage.days7.total),
      JSON.stringify({
        amt: weekModels.map(rankOfWeek),
        tok: weekTokens.map((m) => m.tokens),
        rankTotal: usage.days7.rankTotal,
        total: usage.days7.total,
      })
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
      '用量记录：多模型轮次归并为一条且金额只含付费模型（套餐行金额 0）',
      turnC && turnC.calls === 2 && turnC.models.length === 2 && Math.abs(turnC.amount - dsPart) < 1e-9,
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

  // CommandCode 反代（预付 credit 池）不计真金白银：2026-10-15 的真实现场是
  // 「上午走 CommandCode、下午转官方 API」，官方那部分 ¥1.48，而「DeepSeek 今日
  // 已用」把 credit 折算的 ¥4.26 一起加进来显示 ¥5.73 —— 用户看到的是「我才花了
  // 1 块多」。这条钉住三件事：credit 行金额 0、归到自己的厂商标签、官方行照算。
  {
    const atCmdgo = Date.now()
    const CMDGO_USAGE = {
      input_tokens: 1_000_000,
      cache_read_input_tokens: 40_000_000,
      output_tokens: 100_000,
      computed_total_tokens: 41_100_000,
    }
    insertTurn('sess_selftest', 'turn_cmdgo', CMDGO_USAGE, atCmdgo, [
      { model: 'deepseek/deepseek-v4.1-flash', providerId: 'cmdgo-bridge', usage: CMDGO_USAGE },
    ])
    let cmdgoTurn = null
    const deadlineCmdgo = Date.now() + 6000
    while (Date.now() < deadlineCmdgo) {
      await new Promise((r) => setTimeout(r, 400))
      cmdgoTurn = await getJson(port, '/whale/last-turn.json')
      if (cmdgoTurn.seq > 3) break
    }
    const market = costOfUsage('deepseek/deepseek-v4.1-flash', CMDGO_USAGE, atCmdgo, 'cmdgo-bridge').amount
    check(
      'CommandCode 轮次按 tokens 展示（credit 池不折算成金额）',
      cmdgoTurn && cmdgoTurn.billable === false && cmdgoTurn.amount === 0 && cmdgoTurn.tokens > 0 && market > 0,
      cmdgoTurn
        ? 'billable=' + cmdgoTurn.billable + ' amount=' + cmdgoTurn.amount + ' tokens=' + cmdgoTurn.tokens + '（等价市值 ¥' + market.toFixed(4) + ' 不计）'
        : '无'
    )
    const rec = await getJson(port, '/whale/usage-records.json')
    const apiTotal = paidApiTotal
    if (rec && rec.ok) {
      const row = (rec.today.models || []).find((m) => m.providerId === 'cmdgo-bridge')
      check(
        '用量记录：CommandCode 行金额记 0 但 tokens/市值在，且归到自己的厂商标签',
        row && row.amount === 0 && row.plan === true && row.tokens > 0 && Number(row.market) > 0 && row.vendorLabel === 'CommandCode',
        JSON.stringify(row || null)
      )
      check(
        '「DeepSeek 今日已用」不含 CommandCode 折算（只剩按量行之和）',
        Math.abs(rec.today.byVendor.DeepSeek.amount - apiTotal) < 1e-9 && rec.today.byVendor.DeepSeek.tokens > 0,
        'DeepSeek 厂商 ¥' + rec.today.byVendor.DeepSeek.amount.toFixed(6) + '（含 credit 时会是 ¥' + (apiTotal + market).toFixed(6) + '）'
      )
      check(
        'CommandCode 行独立成厂商（金额 0、tokens 在），不再并进 DeepSeek',
        rec.today.byVendor.CommandCode && rec.today.byVendor.CommandCode.amount === 0 && rec.today.byVendor.CommandCode.tokens > 0,
        JSON.stringify(rec.today.byVendor.CommandCode || null)
      )
      const bvSum = Object.keys(rec.today.byVendor).reduce((s, k) => s + (Number(rec.today.byVendor[k].amount) || 0), 0)
      const rankOverTotal = rec.today.rankTotal - rec.today.total
      check(
        '今日合计 = 各厂商真金白银之和，credit 折算只进排名的等价市值',
        Math.abs(rec.today.total - bvSum) < 2e-6 && rankOverTotal >= Number(row.market) - 1e-9,
        'total=¥' + rec.today.total.toFixed(6) + ' rankTotal=¥' + rec.today.rankTotal.toFixed(6) + ' 多出的 ¥' + rankOverTotal.toFixed(6) + ' 里含 credit 等价 ¥' + Number(row.market).toFixed(6)
      )
    } else {
      check('用量记录：CommandCode 行金额记 0 但 tokens/市值在，且归到自己的厂商标签', false, '接口不可用')
    }
  }

  // 预警设置归一：额度阈值泛化为单一 quotaPct（旧键 planPct/cmdgoPct 折入），
  // moneyAlert 仍由 DS/BM 两个旧键合并，负数/非法值归 0
  const putRes = await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, alerts: { quotaPct: 20, moneyAlert: 5.5, deepseekBelow: -3, bigmodelDaily: 9 } }),
  })
  const putBody = await putRes.json()
  check(
    '预警阈值写入并归一（quotaPct + moneyAlert 两条，旧键不再各自保留）',
    putRes.ok &&
      putBody.alerts &&
      putBody.alerts.quotaPct === 20 &&
      putBody.alerts.moneyAlert === 5.5 &&
      putBody.alerts.planPct === undefined &&
      putBody.alerts.cmdgoPct === undefined &&
      putBody.alerts.deepseekBelow === undefined,
    JSON.stringify(putBody.alerts)
  )
  const sizeBack = await getJson(port, '/whale/size.json')
  check(
    '预警设置持久化回读',
    sizeBack && sizeBack.alerts && sizeBack.alerts.quotaPct === 20 && sizeBack.alerts.moneyAlert === 5.5,
    JSON.stringify(sizeBack.alerts)
  )
  // 今日预算（v1.15.2）：与其他预警并列保存；负数/非法归 0，超大值封顶 1e6
  const budgetPut = await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, alerts: { budgetToday: 12.34 } }),
  })
  const budgetBody = await budgetPut.json()
  check(
    '今日预算：写入后与其他预警并存（12.34，不覆盖已有阈值）',
    budgetPut.ok && budgetBody.alerts && budgetBody.alerts.budgetToday === 12.34 && budgetBody.alerts.quotaPct === 20 && budgetBody.alerts.moneyAlert === 5.5,
    JSON.stringify(budgetBody.alerts)
  )
  const budgetNeg = await (
    await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 1.5, alerts: { budgetToday: -5 } }),
    })
  ).json()
  check('今日预算：负数归 0（等于关闭）', budgetNeg.alerts && budgetNeg.alerts.budgetToday === 0, JSON.stringify(budgetNeg.alerts))
  const budgetHuge = await (
    await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 1.5, alerts: { budgetToday: 9e9 } }),
    })
  ).json()
  check('今日预算：超大值封顶 1e6（防手滑多打几个零）', budgetHuge.alerts && budgetHuge.alerts.budgetToday === 1000000, JSON.stringify(budgetHuge.alerts))
  const budgetText = await (
    await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 1.5, alerts: { budgetToday: 'abc' } }),
    })
  ).json()
  check('今日预算：非数字归 0', budgetText.alerts && budgetText.alerts.budgetToday === 0, JSON.stringify(budgetText.alerts))
  // 复位成 0，避免影响后续用例
  await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, alerts: { budgetToday: 0 } }),
  })
  // 旧配置迁移：模拟升级用户的文件（只有 DS¥/BM¥ 旧键、没有 moneyAlert），
  // 读出来应是 moneyAlert=deepseekBelow（先设过的那个），旧键不再保留
  const legacyState = JSON.parse(fs.readFileSync(path.join(dataDir, 'widget-state.json'), 'utf8'))
  legacyState.alerts = { planPct: 20, deepseekBelow: 7.5, bigmodelDaily: 3 }
  fs.writeFileSync(path.join(dataDir, 'widget-state.json'), JSON.stringify(legacyState), 'utf8')
  const legacyBack = await getJson(port, '/whale/size.json')
  check(
    '预警旧键迁移（planPct → quotaPct，deepseekBelow/bigmodelDaily → moneyAlert）',
    legacyBack &&
      legacyBack.alerts &&
      legacyBack.alerts.quotaPct === 20 &&
      legacyBack.alerts.moneyAlert === 7.5 &&
      legacyBack.alerts.deepseekBelow === undefined,
    JSON.stringify(legacyBack.alerts)
  )
  // 只设过 cmdgoPct 的用户（v1.7.8 那一格是只写不读的）设置要折进 quotaPct 而不是丢
  legacyState.alerts = { cmdgoPct: 15 }
  fs.writeFileSync(path.join(dataDir, 'widget-state.json'), JSON.stringify(legacyState), 'utf8')
  const cmdgoLegacyBack = await getJson(port, '/whale/size.json')
  check(
    'cmdgoPct 旧值折入 quotaPct（只设过它的用户不丢设置）',
    cmdgoLegacyBack && cmdgoLegacyBack.alerts && cmdgoLegacyBack.alerts.quotaPct === 15,
    JSON.stringify(cmdgoLegacyBack.alerts)
  )

  // 角色气泡配色覆盖（inkOverrides）：形状收敛——十六进制统一小写 6 位（3 位扩位）、
  // 非法色值/非法 roleId/两档全空的条目丢弃；整张映射替换，条目缺失 = 删除
  const inkPut = await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scale: 1.5,
      inkOverrides: {
        fox: { light: '#AABBCC', dark: '#5d8dde' },
        gpt: { light: 'abc' },
        kimi: { light: 'not-a-color', dark: 'rgb(1,2,3)' },
        whale: { light: '', dark: '' },
        ['x'.repeat(41)]: { light: '#112233' },
      },
    }),
  })
  const inkBody = await inkPut.json()
  check(
    '角色配色覆盖写入并收敛（大写归一/3 位扩 6 位/非法条目丢弃）',
    inkPut.ok &&
      inkBody.inkOverrides &&
      inkBody.inkOverrides.fox &&
      inkBody.inkOverrides.fox.light === '#aabbcc' &&
      inkBody.inkOverrides.fox.dark === '#5d8dde' &&
      inkBody.inkOverrides.gpt &&
      inkBody.inkOverrides.gpt.light === '#aabbcc' &&
      inkBody.inkOverrides.kimi === undefined &&
      inkBody.inkOverrides.whale === undefined &&
      inkBody.inkOverrides['x'.repeat(41)] === undefined,
    JSON.stringify(inkBody.inkOverrides)
  )
  const inkBack = await getJson(port, '/whale/size.json')
  check(
    '角色配色覆盖持久化回读',
    inkBack && inkBack.inkOverrides && inkBack.inkOverrides.fox && inkBack.inkOverrides.fox.light === '#aabbcc',
    JSON.stringify(inkBack && inkBack.inkOverrides)
  )
  await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, inkOverrides: {} }),
  })
  const inkClearBack = await getJson(port, '/whale/size.json')
  check(
    '角色配色覆盖整张替换（空映射 = 全部清除）',
    inkClearBack && inkClearBack.inkOverrides && Object.keys(inkClearBack.inkOverrides).length === 0,
    JSON.stringify(inkClearBack && inkClearBack.inkOverrides)
  )

  // 版本更新路由：GET 状态 + POST skip/unskip（状态文件直接写进测试数据目录，
  // 因为「跳过」记的是「当前最新版本」，没有远端检查结果时本就没有可跳过的目标）。
  // 不做 POST check / update：那会真的向镜像发请求与落盘，测试环境已用
  // WHALE_DISABLE_UPDATE_CHECK 关掉自动检查，这里也不主动触发。
  const upGet = await getJson(port, '/whale/update.json')
  check(
    '更新状态路由：GET 返回版本与状态字段（未检查时 available=false）',
    upGet && upGet.ok === true && typeof upGet.version === 'string' && upGet.busy === false &&
      upGet.available === false && upGet.skipped === null && upGet.version === pluginJson.version,
    JSON.stringify(upGet && { version: upGet.version, available: upGet.available, skipped: upGet.skipped })
  )
  fs.writeFileSync(
    path.join(dataDir, 'update-state.json'),
    JSON.stringify({ latest: '9.9.9', available: true, busy: false, phase: null, checkedAt: Date.now(), source: 'test' }),
    'utf8'
  )
  const upAvail = await getJson(port, '/whale/update.json')
  check(
    '更新状态路由：有新版本时 available=true 且带 latest',
    upAvail && upAvail.available === true && upAvail.latest === '9.9.9' && upAvail.skipActive === false,
    JSON.stringify(upAvail && { latest: upAvail.latest, skipActive: upAvail.skipActive })
  )
  const skipRes = await fetch('http://127.0.0.1:' + port + '/whale/update.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'skip' }),
  })
  const skipBody = await skipRes.json()
  const skipState = JSON.parse(fs.readFileSync(path.join(dataDir, 'widget-state.json'), 'utf8'))
  check(
    '更新路由：跳过此版本 → 写入 widget-state.updateSkip 并回报 skipActive',
    skipRes.ok && skipBody.skipActive === true && skipBody.skipped === '9.9.9' && skipState.updateSkip === '9.9.9',
    JSON.stringify({ skipped: skipBody.skipped, skipActive: skipBody.skipActive, state: skipState.updateSkip })
  )
  const unskipRes = await fetch('http://127.0.0.1:' + port + '/whale/update.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'unskip' }),
  })
  const unskipBody = await unskipRes.json()
  const unskipState = JSON.parse(fs.readFileSync(path.join(dataDir, 'widget-state.json'), 'utf8'))
  check(
    '更新路由：取消跳过 → updateSkip 清空、skipActive 归 false',
    unskipRes.ok && unskipBody.skipActive === false && unskipState.updateSkip === null,
    JSON.stringify({ skipActive: unskipBody.skipActive, state: unskipState.updateSkip })
  )
  // 陈旧状态不得回放出「更旧的远端版本」：WorkBuddy 线不自动检查、升级常走市场重装，
  // 状态文件里可能留着升级前的结论（current 1.0.1 / latest 1.1.0 / available true）。
  // 视图必须按**当前运行版本**重判，否则会出现「当前 v1.3.0、最新 v1.1.0、还能立即更新」。
  fs.writeFileSync(
    path.join(dataDir, 'update-state.json'),
    JSON.stringify({ current: '0.0.1', latest: '0.0.1', available: true, appliedVersion: '0.0.1', busy: false, phase: 'done', checkedAt: Date.now(), source: 'test' }),
    'utf8'
  )
  const upStale = await getJson(port, '/whale/update.json')
  check(
    '更新状态路由：状态文件比当前版本旧时，available 归 false 且 latest 显示当前版本',
    upStale && upStale.available === false && upStale.latest === upStale.version && upStale.appliedVersion === null,
    JSON.stringify(upStale && { latest: upStale.latest, version: upStale.version, available: upStale.available, appliedVersion: upStale.appliedVersion })
  )
  const badAction = await fetch('http://127.0.0.1:' + port + '/whale/update.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'nope' }),
  })
  check('更新路由：未知动作 400（不误触发任何流程）', badAction.status === 400, 'status=' + badAction.status)

  // fox-dock 迁移入口路由：offer 由服务端探测落盘（migrationProbe），这里直接种
  // 状态文件驱动各分支。GET 会触发节流探测，但 WHALE_DISABLE_UPDATE_CHECK=1 时
  // maybeProbeMigration 直接短路，不会发真实网络请求。
  const GOOD_MIGRATION_OFFER = {
    product: 'fox-dock',
    version: '2.0.0',
    channel: 'stable',
    notesUrl: 'https://github.com/pigeon189/zcode-fox-widget/releases/download/dock-v2.0.0/release-notes-2.0.0.html',
    downloadUrl: 'https://github.com/pigeon189/zcode-fox-widget/releases/tag/dock-v2.0.0',
    summary: 'fox-dock 2.0 正式版：独立桌宠 + 权限接管 + 旧数据导入',
    highlights: ['独立程序，不再依赖宿主插件运行'],
    costs: ['自定义气泡图片/模板不自动迁移'],
  }
  const migGet0 = await getJson(port, '/whale/update.json')
  check(
    '迁移路由：无 migrationProbe 时 migration.available=false（默认无入口）',
    migGet0 && migGet0.migration && migGet0.migration.available === false,
    JSON.stringify(migGet0 && migGet0.migration)
  )
  fs.writeFileSync(
    path.join(dataDir, 'update-state.json'),
    JSON.stringify({ latest: null, available: false, busy: false, phase: null, checkedAt: Date.now(), source: 'test', migrationProbe: { at: Date.now(), manifestVersion: pluginJson.version, eol: false, offer: GOOD_MIGRATION_OFFER } }),
    'utf8'
  )
  const migGet1 = await getJson(port, '/whale/update.json')
  check(
    '迁移路由：合法 stable offer 且清单版本=当前版本 → available=true 且带 costs',
    migGet1 && migGet1.migration && migGet1.migration.available === true && migGet1.migration.version === '2.0.0' &&
      Array.isArray(migGet1.migration.costs) && migGet1.migration.costs.length === 1 && !!migGet1.migration.notesUrl,
    JSON.stringify(migGet1 && migGet1.migration)
  )
  fs.writeFileSync(
    path.join(dataDir, 'update-state.json'),
    JSON.stringify({ latest: null, available: false, busy: false, phase: null, migrationProbe: { at: Date.now(), manifestVersion: '0.0.9', eol: false, offer: GOOD_MIGRATION_OFFER } }),
    'utf8'
  )
  const migGet2 = await getJson(port, '/whale/update.json')
  check(
    '迁移路由：清单版本比当前旧（镜像滞后）→ 不回放旧 offer',
    migGet2 && migGet2.migration && migGet2.migration.available === false && migGet2.migration.manifestVersion === '0.0.9'
  )
  // 恢复合法 offer，测跳过与预检
  fs.writeFileSync(
    path.join(dataDir, 'update-state.json'),
    JSON.stringify({ latest: null, available: false, busy: false, phase: null, migrationProbe: { at: Date.now(), manifestVersion: pluginJson.version, eol: false, offer: GOOD_MIGRATION_OFFER } }),
    'utf8'
  )
  const migSkipRes = await fetch('http://127.0.0.1:' + port + '/whale/update.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'migrate-skip' }),
  })
  const migSkipBody = await migSkipRes.json()
  const migSkipState = JSON.parse(fs.readFileSync(path.join(dataDir, 'widget-state.json'), 'utf8'))
  check(
    '迁移路由：migrate-skip → 写 widget-state.migrationSkip（与 updateSkip 独立）且入口隐藏',
    migSkipRes.ok && migSkipBody.migration.available === false && migSkipState.migrationSkip === '2.0.0' && migSkipState.updateSkip === null,
    JSON.stringify({ migrationSkip: migSkipState.migrationSkip, updateSkip: migSkipState.updateSkip })
  )
  const migUnskipRes = await fetch('http://127.0.0.1:' + port + '/whale/update.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'migrate-unskip' }),
  })
  const migUnskipBody = await migUnskipRes.json()
  const migUnskipState = JSON.parse(fs.readFileSync(path.join(dataDir, 'widget-state.json'), 'utf8'))
  check(
    '迁移路由：migrate-unskip → migrationSkip 清空、入口恢复',
    migUnskipRes.ok && migUnskipBody.migration.available === true && migUnskipState.migrationSkip === null
  )
  // 409 分支：先把 offer 摘掉（远端撤掉 migration 块后的下一次探测就是这个形状）
  fs.writeFileSync(
    path.join(dataDir, 'update-state.json'),
    JSON.stringify({ latest: null, available: false, busy: false, phase: null, migrationProbe: { at: Date.now(), manifestVersion: pluginJson.version, eol: false, offer: null, reason: '缺 migration 块' } }),
    'utf8'
  )
  const migNoOffer = await fetch('http://127.0.0.1:' + port + '/whale/update.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'migrate' }),
  })
  check('迁移路由：无有效 offer 时 migrate 409（不进入预检）', migNoOffer.status === 409, 'status=' + migNoOffer.status)
  // 恢复合法 offer 后预检：本机可能真装着 fox-dock（含 pre 版本），断言只盯结构
  // 而不盯「dock 未装」——预检必须给出一组可照做的步骤，且不写任何 1.x 状态
  fs.writeFileSync(
    path.join(dataDir, 'update-state.json'),
    JSON.stringify({ latest: null, available: false, busy: false, phase: null, migrationProbe: { at: Date.now(), manifestVersion: pluginJson.version, eol: false, offer: GOOD_MIGRATION_OFFER } }),
    'utf8'
  )
  const migRes = await fetch('http://127.0.0.1:' + port + '/whale/update.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'migrate' }),
  })
  const migBody = await migRes.json()
  check(
    '迁移路由：migrate → 只做只读预检（返回 preflight + guide 步骤）',
    migRes.ok && migBody.ok === true && migBody.preflight && migBody.preflight.checks && migBody.guide &&
      Array.isArray(migBody.guide.steps) && migBody.guide.steps.length > 0 && typeof migBody.guide.dockReady === 'boolean',
    JSON.stringify(migBody.guide)
  )
  check(
    '迁移路由：preflight 只报 config 键名与数量（不泄值）；结构完整',
    typeof migBody.preflight.ok === 'boolean' && Array.isArray(migBody.preflight.config.keys) &&
      typeof migBody.preflight.dock.online === 'boolean' && typeof migBody.preflight.data.bytes === 'number',
    JSON.stringify(migBody.preflight.checks)
  )
  // 注意：watch-uninstall 动作不在这里 POST——测试进程的 APPDATA 是真实启动文件夹，
  // 该动作会撤掉真机的看门启动项；行为由 selftest-migrate 的源码钉覆盖。

  // 版本更新内核单测：独立子进程（隔离 ZCODE_HOME，避免写到真实数据目录）
  {
    const run = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'tools', 'selftest-update.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, ZCODE_HOME: tmpHome, WHALE_DISABLE_UPDATE_CHECK: '1' },
    })
    const m = /更新内核自检：(\d+)\/(\d+) 通过/.exec(String(run.stdout || ''))
    check(
      '版本更新内核单测全绿（版本比较 / 出站守卫 / tar 解包 / 落盘清理 / 检查回退 / 整包更新 / 防重入）',
      run.status === 0 && !!m && m[1] === m[2] && Number(m[2]) >= 28,
      m ? m[0] + '（共 ' + m[2] + ' 项）' : (((run.stderr || '') + (run.stdout || '')).slice(-260) || '无输出')
    )
  }

  // 迁移引导单测：独立子进程（同上；kill switch 只在用例内显式传 env）
  {
    const run = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'tools', 'selftest-migrate.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, ZCODE_HOME: tmpHome, WHALE_DISABLE_UPDATE_CHECK: '1' },
    })
    const m = /迁移引导自检：(\d+)\/(\d+) 通过/.exec(String(run.stdout || ''))
    check(
      '迁移引导单测全绿（offer 校验 / stable-only / URL 白名单 / 多镜像取舍 / 探测节流 / 预检只读 / eol 哨兵 / 普通更新回归）',
      run.status === 0 && !!m && m[1] === m[2] && Number(m[2]) >= 50,
      m ? m[0] + '（共 ' + m[2] + ' 项）' : (((run.stderr || '') + (run.stdout || '')).slice(-260) || '无输出')
    )
  }

  // 模型名 → 内置角色（「按模型自动换角色」）：ZCode 的模型标识是
  // `<provider>/<model>` 拼串，既有网关前缀也有套餐前缀，必须子串匹配
  {
    check(
      'roleIdForModel：六个族各自的代表写法（含网关/套餐前缀）',
      roleIdForModel('deepseek/deepseek-flash') === 'whale' &&
        roleIdForModel('account:zai-start-plan/GLM-5.3-Flash') === 'fox' &&
        roleIdForModel('cmdgo-bridge/claude-sonnet-5-5') === 'xiaoke' &&
        roleIdForModel('cmdgo-bridge/moonshotai/Kimi-K3') === 'kimi' &&
        roleIdForModel('zai-org/GLM-5.3') === 'fox' &&
        roleIdForModel('openai/gpt-5.6-terra') === 'gpt' &&
        roleIdForModel('anthropic/claude-opus-5') === 'xiaoke' &&
        roleIdForModel('google/gemini-4-argon') === 'gemini' &&
        roleIdForModel('gemini-3-pro') === 'gemini',
      [roleIdForModel('deepseek/deepseek-flash'), roleIdForModel('google/gemini-4-argon')].join(',')
    )
    check(
      'roleIdForModel：认不出的模型返回 null（不动当前角色，不乱换人）',
      roleIdForModel('qwen3.8-max') === null &&
        roleIdForModel('MiniMax-M3') === null &&
        roleIdForModel('mimo-v2.6-pro') === null &&
        roleIdForModel('') === null &&
        roleIdForModel(null) === null
    )
    // 前端不引 ESM，映射表在 widget.js 里各存一份——两边关键词必须一致（防漂移）
    const widgetSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'widget.js'), 'utf8')
    const flat = (rules) => JSON.stringify(rules.map((r) => [r.roleId, [...r.keywords].sort()]).sort())
    const frontendRules = (() => {
      const m = /var rules = \[([\s\S]*?)\]\s*\n\s*for \(var i = 0; i < rules\.length/.exec(widgetSrc)
      if (!m) return null
      const rules = []
      const re = /\['([a-z]+)', \[([^\]]*)\]\]/g
      let hit
      while ((hit = re.exec(m[1])) !== null) {
        rules.push({ roleId: hit[1], keywords: hit[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) })
      }
      return rules.length ? rules : null
    })()
    check(
      '按模型换角色：前后端映射表一致（widget.js 的副本与 paths.mjs 的单一来源同口径）',
      !!frontendRules && flat(frontendRules) === flat(MODEL_ROLE_RULES),
      frontendRules ? flat(frontendRules) === flat(MODEL_ROLE_RULES) ? '一致' : '不一致：' + flat(frontendRules) : '未从 widget.js 解析到规则表'
    )
    // 结构一致还不够——把前端那份函数体抠出来实际跑一遍五族代表写法（审查建议：
    // 「前端副本对五族代表写法的行为断言」），防止只改一侧关键词却「结构仍等价」的漂移
    const fnSrc = /function roleForModel\(model\) \{[\s\S]*?\n  \}/.exec(widgetSrc)
    let frontendRole = null
    if (fnSrc) {
      try {
        frontendRole = new Function(fnSrc[0] + '; return roleForModel')()
      } catch (err) {
        frontendRole = null
      }
    }
    const samples = [
      'deepseek/deepseek-flash',
      'account:zai-start-plan/GLM-5.3-Flash',
      'zai-org/GLM-5.3',
      'openai/gpt-5.6-terra',
      'cmdgo-bridge/moonshotai/Kimi-K3',
      'cmdgo-bridge/claude-sonnet-5-5',
      'anthropic/claude-opus-5',
      'google/gemini-4-argon',
      'qwen3.8-max',
      'MiniMax-M3',
      '',
    ]
    check(
      '按模型换角色：前端副本的行为与 paths.mjs 逐项一致（' + samples.length + ' 个样本）',
      !!frontendRole && samples.every((m) => frontendRole(m) === roleIdForModel(m)),
      !!frontendRole ? samples.map((m) => m + '→' + String(frontendRole(m))).join(', ') : '未从 widget.js 解析到 roleForModel'
    )
    // 哈基米（gemini 族）的注册完整性：内置清单有它、立绘文件真实存在
    check(
      '内置角色：gemini（哈基米）在 BUILTIN_ROLES 里且立绘文件存在',
      BUILTIN_ROLES.some((r) => r.id === 'gemini' && r.name === '哈基米') &&
        BUILTIN_ROLES.every((r) => fs.existsSync(r.image)),
      JSON.stringify(BUILTIN_ROLES.map((r) => r.id + ':' + (fs.existsSync(r.image) ? 'ok' : 'missing')))
    )
  }

  // 浮层主进程：外链与新窗口防护（上轮 P2-1 的修复，Electron 里没法在自检中真跑，
  // 按源码钉住——气泡里的链接必须交给系统浏览器，浮层窗口自身不许被导航走）
  {
    const mainSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'desktop', 'main.cjs'), 'utf8')
    check(
      '浮层：外链走系统浏览器 + 拒绝窗口内导航与新开窗口（setWindowOpenHandler / will-navigate）',
      /setWindowOpenHandler/.test(mainSrc) &&
        /shell\.openExternal/.test(mainSrc) &&
        /will-navigate/.test(mainSrc) &&
        /action: 'deny'/.test(mainSrc),
      ''
    )
  }

  // UI 审查 U31：浅色档正文色的对比度下限。正文色由角色墨色按 4.5:1 派生
  //（装饰件仍用原色），这里把 widget.js 里的纯函数抠出来逐个内置角色断言——
  // 小克 #d97757 对白底只有 3.12:1（kimi 旧浅紫 #ad81ff 是 2.85:1、2026-10-16 已换掉），
  // 是这一条要挡住的原状；下面用 #ad81ff 当输入只是取一个低对比度颜色。
  {
    const widgetSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'widget.js'), 'utf8')
    const helperSrc = /function srgbToLinear[\s\S]*?\n  function readableOn\(bg\) \{[\s\S]*?\n  \}/.exec(widgetSrc)
    let H = null
    if (helperSrc) {
      try {
        H = new Function(helperSrc[0] + '; return { ensureContrast: ensureContrast, contrastRatio: contrastRatio, readableOn: readableOn }')()
      } catch (err) {
        H = null
      }
    }
    const lights = {}
    const pairBlock = /var ROLE_INK_PAIR = \{([\s\S]*?)\n  \}/.exec(widgetSrc)
    if (pairBlock) {
      const re = /([a-z]+): \{ light: '(#[0-9a-f]{6})'/g
      let hit
      while ((hit = re.exec(pairBlock[1])) !== null) lights[hit[1]] = hit[2]
    }
    const ids = Object.keys(lights)
    check(
      'U31：能从 widget.js 抠出对比度纯函数与全部内置角色墨色',
      !!H && ids.length === BUILTIN_ROLES.length && BUILTIN_ROLES.every((r) => lights[r.id]),
      JSON.stringify({ helper: !!H, ids })
    )
    if (H && ids.length === BUILTIN_ROLES.length) {
      const bad = ids.filter((id) => H.contrastRatio(H.ensureContrast(lights[id], '#ffffff', 4.5), '#ffffff') < 4.5)
      check(
        'U31：全部内置角色的浅色墨色经处理后正文对比度 ≥4.5:1（AA，白底）',
        bad.length === 0,
        bad.length ? '不达标：' + bad.map((id) => id + ' ' + lights[id] + ' ' + H.contrastRatio(H.ensureContrast(lights[id], '#ffffff', 4.5), '#ffffff').toFixed(2)).join(', ') : ids.map((id) => id + ' ' + H.contrastRatio(H.ensureContrast(lights[id], '#ffffff', 4.5), '#ffffff').toFixed(2)).join(', ')
      )
      check(
        'U31：已是深色的角色不被改动（大肥鱼/嘎啦嘛原值直接达标，观感不变）',
        H.ensureContrast('#203170', '#ffffff', 4.5) === '#203170' && H.ensureContrast('#3d4460', '#ffffff', 4.5) === '#3d4460'
      )
      check(
        'U31：勾选对勾默认白（内置六色都白勾），只有很浅的填充才给深色勾',
        H.readableOn('#ad81ff') === '#ffffff' &&
          H.readableOn('#203170') === '#ffffff' &&
          H.readableOn('#d97757') === '#ffffff' &&
          H.readableOn('#5b7cdd') === '#ffffff' &&
          H.readableOn('#7b6fc4') === '#ffffff' &&
          H.readableOn('#3d4460') === '#ffffff' &&
          // 接近白的填充仍要能看见对勾（亮度阈值 0.7）
          H.readableOn('#fff6cc') === '#000000' &&
          H.readableOn('#ffffff') === '#000000'
      )
      check(
        'U31：派生幂等（对已达标的值再算一次结果不变）',
        H.ensureContrast(H.ensureContrast('#ad81ff', '#ffffff', 4.5), '#ffffff', 4.5) === H.ensureContrast('#ad81ff', '#ffffff', 4.5)
      )
    }
    // 接线钉：正文取派生值、装饰仍取原色、对勾取二选色
    check(
      'U31：CSS 接线（正文取 --zcw-role-ink-text、装饰仍取 --zcw-role-ink、对勾取 --zcw-check-mark）',
      widgetSrc.indexOf('--zcw-ink:var(--zcw-role-ink-text') !== -1 &&
        widgetSrc.indexOf('--zcw-accent:var(--zcw-role-ink)') !== -1 &&
        widgetSrc.indexOf('border:solid var(--zcw-check-mark') !== -1,
      ''
    )
    // 角色彩色渐变（装饰件）：色标要来自角色本身、两档齐全、是真正的渐变；
    // 并且**只有装饰件**吃渐变——正文/描边仍走实色（渐变不能作 color，且正文要
    // 按 4.5:1 派生）。接线按源码钉住（同 U31 的既有做法）。
    {
      const gradBlock = /var ROLE_INK_GRADIENT = \{([\s\S]*?)\n  \}/.exec(widgetSrc)
      const parsed = {}
      if (gradBlock) {
        const re = /([a-z]+): \{\s*light: \[([^\]]*)\],\s*dark: \[([^\]]*)\]/g
        let hit
        while ((hit = re.exec(gradBlock[1])) !== null) {
          const list = (raw) =>
            raw
              .split(',')
              .map((x) => x.trim().replace(/^'|'$/g, ''))
              .filter(Boolean)
          parsed[hit[1]] = { light: list(hit[2]), dark: list(hit[3]) }
        }
      }
      const gIds = Object.keys(parsed)
      const hexOk = (v) => /^#[0-9a-f]{6}$/i.test(v)
      check(
        '角色渐变：色标齐备且合法（≥3 档、两档等长、全是 6 位 hex、确实是渐变不是单色）',
        gIds.length >= 1 &&
          gIds.every((id) => {
            const g = parsed[id]
            return (
              g.light.length >= 3 &&
              g.light.length === g.dark.length &&
              g.light.every(hexOk) &&
              g.dark.every(hexOk) &&
              new Set(g.light).size >= 3
            )
          }),
        JSON.stringify(parsed)
      )
      check(
        '角色渐变：只有内置角色能声明渐变（拼错的 id 会让它静默失效）',
        gIds.every((id) => BUILTIN_ROLES.some((r) => r.id === id)),
        gIds.join(',')
      )
      check(
        '角色渐变：接线只进装饰件（气泡描边走 SVG 渐变 url，装饰件走 --zcw-role-ink-grad；正文不动）',
        widgetSrc.indexOf('url(#zcwInkGrad)') !== -1 &&
          widgetSrc.indexOf('id="zcwInkGrad"') !== -1 &&
          widgetSrc.indexOf('--zcw-role-ink-grad') !== -1 &&
          widgetSrc.indexOf('background-image:var(--zcw-role-ink-grad,none)') !== -1 &&
          // 正文派生仍从实色出发（不能被渐变变量顶掉）
          widgetSrc.indexOf("--zcw-role-ink-text', ensureContrast(ink") !== -1,
        ''
      )
    }
  }

  // UI 审查 U32/U33/U35/U36：四条纯 CSS/创建点的改动，按源码钉住
  {
    const widgetSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'widget.js'), 'utf8')
    check(
      'U32：按钮有禁用态（禁用与可用不再外观一致），且 hover 排除禁用',
      /\.zcwv-sound:disabled,\.zcwv-role-mini:disabled/.test(widgetSrc) &&
        /\.zcwv-sound:hover:not\(:disabled\)/.test(widgetSrc) &&
        /\.zcwv-role-mini:hover:not\(:disabled\)/.test(widgetSrc),
      ''
    )
    check(
      'U33：流光动画纳入 prefers-reduced-motion（名单里显式点名，不靠全局 !important）',
      /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\.zcwv-flow\{animation:none !important\}\}/.test(widgetSrc),
      ''
    )
    check(
      'U35：菜单里的更新状态小字限宽省略（不再把菜单撑宽），并有 tooltip 兜底',
      /\.zcwv-update-state\{[^}]*max-width:76px[^}]*text-overflow:ellipsis/.test(widgetSrc) &&
        /updateStatusEl\.title = lbl/.test(widgetSrc),
      ''
    )
    check(
      'U36：文本输入抽了公共 .zcwv-input 类，三处创建点都已挂上',
      /\.zcwv-input\{/.test(widgetSrc) &&
        /el\('textarea', 'zcwv-input zcwv-textarea'\)/.test(widgetSrc) &&
        /el\('input', 'zcwv-input zcwv-bq-cin'\)/.test(widgetSrc) &&
        /el\('input', 'zcwv-input zcwv-inkhex'\)/.test(widgetSrc),
      ''
    )
    check(
      'P3-1：调色板拖动只改内存预览（松手/色相落定才落盘），不再逐帧 PUT',
      /function setInkOverride\(id, part, hex, opts\)/.test(widgetSrc) &&
        /setInkOverride\(role\.id, st\.part, hex, \{ persist: !!persist \}\)/.test(widgetSrc) &&
        /saveConfig\(\) \/\/ 拖动期间只改内存预览，松手才落盘（P3-1）/.test(widgetSrc),
      ''
    )
    check(
      'P3-4：按模型换角色有迟滞（连续两拍同一目标才切），但手动重开开关立即生效',
      /var AUTO_ROLE_STREAK = 2/.test(widgetSrc) &&
        /function maybeAutoRole\(immediate\)/.test(widgetSrc) &&
        /maybeAutoRole\(true\)/.test(widgetSrc) &&
        /if \(!immediate && autoRoleStreak < AUTO_ROLE_STREAK\) return/.test(widgetSrc),
      ''
    )
  }

  // 钩子接线契约：只挂 SessionStart + 两个低频事件。PreToolUse/PostToolUse 每次
  // 工具调用都要起一个 node（钩子内联执行），会给用户每次调用都加延迟——这条断言
  // 就是把这个取舍钉住，避免以后「顺手」把工具事件加回来。
  {
    const hooksJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'))
    const events = Object.keys((hooksJson.hooks || {}))
    const scripts = []
    for (const ev of events) {
      for (const group of hooksJson.hooks[ev] || []) {
        for (const h of group.hooks || []) {
          const arg = (h.args || [])[0] || ''
          scripts.push(String(arg).replace('${ZCODE_PLUGIN_ROOT}/', ''))
        }
      }
    }
    check(
      '钩子接线：SessionStart + UserPromptSubmit + PermissionRequest（不挂工具事件，避免每次调用加延迟）',
      events.length === 3 &&
        events.indexOf('SessionStart') !== -1 &&
        events.indexOf('UserPromptSubmit') !== -1 &&
        events.indexOf('PermissionRequest') !== -1 &&
        events.indexOf('PreToolUse') === -1 &&
        events.indexOf('PostToolUse') === -1 &&
        events.indexOf('Stop') === -1,
      events.join(',')
    )
    check(
      '钩子接线：脚本都在仓库里（autostart.mjs / hook-event.mjs）',
      scripts.indexOf('lib/autostart.mjs') !== -1 &&
        scripts.indexOf('lib/hook-event.mjs') !== -1 &&
        scripts.every((s) => fs.existsSync(path.join(PLUGIN_ROOT, s))),
      scripts.join(',')
    )
  }

  // hook-event.mjs：真跑一遍（隔离 ZCODE_HOME 的子进程），验状态文件与 waiting 语义
  {
    const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-hook-'))
    const runHook = (payload) =>
      spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'hook-event.mjs')], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, ZCODE_HOME: lab },
      })
    let r = runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1' })
    let st = JSON.parse(fs.readFileSync(path.join(lab, 'whale', 'hook-state.json'), 'utf8'))
    check(
      'hook-event：UserPromptSubmit 写事件名/会话/时间戳，waiting=false，计数累加',
      r.status === 0 && st.event === 'UserPromptSubmit' && st.sessionId === 's1' && st.waiting === false &&
        st.ts > 0 && st.counts.UserPromptSubmit === 1,
      JSON.stringify(st)
    )
    r = runHook({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash' })
    st = JSON.parse(fs.readFileSync(path.join(lab, 'whale', 'hook-state.json'), 'utf8'))
    check(
      'hook-event：PermissionRequest → waiting=true（等确认），计数各自累加',
      r.status === 0 && st.waiting === true && st.counts.PermissionRequest === 1 && st.counts.UserPromptSubmit === 1,
      JSON.stringify({ waiting: st.waiting, counts: st.counts })
    )
    r = runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's2' })
    st = JSON.parse(fs.readFileSync(path.join(lab, 'whale', 'hook-state.json'), 'utf8'))
    check(
      'hook-event：下一轮提问清掉等确认标记（等待已过去）',
      st.waiting === false && st.counts.UserPromptSubmit === 2,
      JSON.stringify({ waiting: st.waiting, counts: st.counts })
    )
    // 坏输入（空 stdin / 非 JSON）不能抛、不能写坏文件、退出码必须 0
    const empty = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'hook-event.mjs')], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, ZCODE_HOME: lab },
    })
    const bad = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'hook-event.mjs')], {
      input: 'not json at all',
      encoding: 'utf8',
      env: { ...process.env, ZCODE_HOME: lab },
    })
    const after = JSON.parse(fs.readFileSync(path.join(lab, 'whale', 'hook-state.json'), 'utf8'))
    check(
      'hook-event：空输入 / 坏 JSON 都以 0 退出且不改坏已有状态（钩子失败绝不能影响 ZCode）',
      empty.status === 0 && bad.status === 0 && after.event === 'UserPromptSubmit' && after.ts > 0,
      JSON.stringify({ empty: empty.status, bad: bad.status, event: after.event })
    )
    fs.rmSync(lab, { recursive: true, force: true })
  }

  // 钩子状态路由 + 新 widget-state 字段
  {
    const hookNotYet = await getJson(port, '/whale/hook.json')
    check(
      '钩子状态路由：没有事件文件时 configured=false（菜单显示「未接入」）',
      hookNotYet && hookNotYet.ok === true && hookNotYet.configured === false && hookNotYet.waiting === false,
      JSON.stringify(hookNotYet)
    )
    const nowSec = Math.floor(Date.now() / 1000)
    fs.writeFileSync(
      path.join(dataDir, 'hook-state.json'),
      JSON.stringify({ event: 'PermissionRequest', tool: 'Bash', sessionId: 's9', ts: nowSec, waiting: true, counts: { PermissionRequest: 3 } }),
      'utf8'
    )
    const hookFresh = await getJson(port, '/whale/hook.json')
    check(
      '钩子状态路由：新鲜事件 → event/tool/ts/waiting 透出，计数保留',
      hookFresh && hookFresh.configured === true && hookFresh.event === 'PermissionRequest' && hookFresh.tool === 'Bash' &&
        hookFresh.fresh === true && hookFresh.waiting === true && hookFresh.counts.PermissionRequest === 3,
      JSON.stringify(hookFresh)
    )
    fs.writeFileSync(
      path.join(dataDir, 'hook-state.json'),
      JSON.stringify({ event: 'PermissionRequest', ts: nowSec - 600, waiting: true, counts: {} }),
      'utf8'
    )
    const hookStale = await getJson(port, '/whale/hook.json')
    check(
      '钩子状态路由：等确认带时效（超过 120 秒未更新 → waiting=false，不会一直提醒）',
      hookStale && hookStale.waiting === false && hookStale.ageSec >= 600,
      JSON.stringify({ waiting: hookStale && hookStale.waiting, age: hookStale && hookStale.ageSec })
    )
    const autoPut = await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 1, autoRole: false, askAlert: true }),
    })
    const autoBody = await autoPut.json()
    check(
      'widget-state：autoRole / askAlert 写入并回读（默认 autoRole=true、askAlert=false）',
      autoBody.autoRole === false && autoBody.askAlert === true &&
        (await getJson(port, '/whale/size.json')).autoRole === false,
      JSON.stringify({ autoRole: autoBody.autoRole, askAlert: autoBody.askAlert })
    )
    const keepPut = await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 1.2 }),
    })
    const keepBody = await keepPut.json()
    check(
      'widget-state：只改别的字段时不丢 autoRole / askAlert（白名单透传）',
      keepBody.autoRole === false && keepBody.askAlert === true,
      JSON.stringify({ autoRole: keepBody.autoRole, askAlert: keepBody.askAlert })
    )
    await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 1, autoRole: true, askAlert: false }),
    })
  }

  // issue #2 修复点（浮层主进程没法在自检里真跑 Electron，这里按源码钉住关键分支，
  // 防止后续重构把修复悄悄改掉）
  //
  // 注：另外两条「暂停」方向的修复（页面侧接管看门狗、周期出帧保险的 moveTop 守卫）
  // 实测未能解决宿主暂停，已在 f69c536 回滚（钉桩一并移除）——别再从别处「顺手加回来」。
  {
    const mainSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'desktop', 'main.cjs'), 'utf8')
    check(
      'issue#2：宿主窗口长时间不存在时浮层自退（空窗看门狗，桌宠模式豁免）',
      mainSrc.indexOf('MISSING_QUIT_MS') !== -1 &&
        /reason === 'window-missing' \|\| reason === 'zcode-identity-changed'/.test(mainSrc) &&
        /if \(petMode\) return/.test(mainSrc) &&
        /log\('quit-window-missing'/.test(mainSrc),
      ''
    )
    check(
      'issue#2：宿主进程更换时立刻交还鼠标并隐身（更新/重启不再留下吃点击的透明窗口）',
      /function applyInteractive\(next, force\)/.test(mainSrc) &&
        /interactive\) applyInteractive\(false, true\)/.test(mainSrc) &&
        /hideOverlay\('zcode-identity-changed'\)/.test(mainSrc),
      ''
    )
    check(
      'issue#13：页面心跳带功能探针，命中未接管连续两拍重建窗口（输入链路断流自愈）',
      mainSrc.indexOf('window.__zcwProbe') !== -1 &&
        mainSrc.indexOf("log('page-probe-stuck'") !== -1 &&
        mainSrc.indexOf("recreateWindow('page-interactive-stuck')") !== -1 &&
        mainSrc.indexOf('if (!overlayShown)') !== -1,
      JSON.stringify({
        probe: mainSrc.indexOf('window.__zcwProbe') !== -1,
        stuckLog: mainSrc.indexOf("log('page-probe-stuck'") !== -1,
        recreate: mainSrc.indexOf("recreateWindow('page-interactive-stuck')") !== -1,
        shownGate: mainSrc.indexOf('if (!overlayShown)') !== -1,
      })
    )
    check(
      'issue#13：浮层页面暴露 __zcwProbe 功能探针（命中测试 + 接管状态）',
      (() => {
        const widgetSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'widget.js'), 'utf8')
        return {
          expose: /window\.__zcwProbe = function \(x, y\)/.test(widgetSrc),
          hit: widgetSrc.indexOf('hit: isWhaleHit({ clientX: x, clientY: y }) || inChrome(node)') !== -1,
        }
      })(),
      ''
    )
    // 两线各有一个「按宿主窗口算浮层边界」的函数，名字不同（ZCode 线是
    // applyZCodeBounds，WorkBuddy 线是 applyHostBounds）。从 main cherry-pick 浮层
    // 补丁时 hunk 能对上、函数名却可能对不上——2026-10-18 真机就弹过
    // 「ReferenceError: applyZCodeBounds is not defined」，每次页面加载都抛。
    // 这里按「调用了就必须定义」兜住这一类，不针对具体名字。
    const boundCalls = new Set()
    for (const m of mainSrc.matchAll(/\b(apply[A-Za-z0-9_]*Bounds)\s*\(/g)) boundCalls.add(m[1])
    const boundMissing = [...boundCalls].filter(
      (name) => !new RegExp('function\\s+' + name + '\\s*\\(').test(mainSrc)
    )
    check(
      'desktop/main.cjs 调用的边界函数都在本文件有定义（' + ([...boundCalls].join(',') || '无') + '）',
      boundMissing.length === 0,
      boundMissing.join(',')
    )
  }

  // 桌宠全屏让路：fs 只在状态变化时下发，所以开启桌宠时必须消费最近一条；
  // 判定还必须排除 ZCode/浮层自身、桌面 shell，并且只认同浮层所在显示器。
  {
    const mainSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'desktop', 'main.cjs'), 'utf8')
    const followSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'desktop', 'follow-window.ps1'), 'utf8')
    check(
      '全屏让路：进入桌宠模式时消费 lastFollowerMsg.fs',
      /lastFollowerMsg && lastFollowerMsg\.fs/.test(mainSrc) &&
        /hideOverlay\('fullscreen-foreground'\)/.test(mainSrc),
      ''
    )
    check(
      '全屏让路：排除 ZCode/浮层自身与桌面 shell，且只认同一显示器',
      /!fgIsTarget && !fgIsOverlay/.test(followSrc) &&
        /Progman/.test(followSrc) &&
        /WorkerW/.test(followSrc) &&
        /Shell_TrayWnd/.test(followSrc) &&
        /MonitorFromWindow\(_overlayHwnd/.test(followSrc) &&
        /mon == overlayMon/.test(followSrc),
      ''
    )
  }

  // issue #8：任务栏自动隐藏时 workArea 等于整屏，浮层必须留出不可见边距，
  // 不能与屏幕严格重合，否则 Windows 会把它当全屏窗口压住任务栏滑出热区。
  {
    const { TASKBAR_REVEAL_INSET, overlayWorkAreaBounds } = requireCjs(
      path.join(PLUGIN_ROOT, 'desktop', 'window-bounds.cjs')
    )
    const full = { x: 0, y: 0, width: 1920, height: 1080 }
    const b = overlayWorkAreaBounds(full)
    check(
      'issue#8：浮层窗口四周留安全边距，不会与整屏严格重合',
      TASKBAR_REVEAL_INSET === 4 &&
        b.x === 4 &&
        b.y === 4 &&
        b.width === full.width - 8 &&
        b.height === full.height - 8 &&
        b.width < full.width &&
        b.height < full.height,
      JSON.stringify(b)
    )
    const tiny = overlayWorkAreaBounds({ x: 0, y: 0, width: 3, height: 3 })
    check('issue#8：极小工作区不会算出 0/负尺寸', tiny.width >= 1 && tiny.height >= 1, JSON.stringify(tiny))
    const mainSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'desktop', 'main.cjs'), 'utf8')
    check(
      'issue#8：主进程创建窗口和兜底矩形都走同一个安全边距函数',
      mainSrc.indexOf("require('./window-bounds.cjs')") !== -1 &&
        /const bounds = overlayWorkAreaBounds\(workArea\)/.test(mainSrc) &&
        /win\.setBounds\(overlayWorkAreaBounds\(wa\)\)/.test(mainSrc) &&
        /win\.setBounds\(overlayWorkAreaBounds\(workArea\)\)/.test(mainSrc),
      ''
    )
  }

  // PR #15：跨显示器跟随。换屏算术与阈值抽在 desktop/display-follow.cjs（双屏硬件
  // 上不了 CI，这里用合成矩形覆盖负坐标副屏、不等宽屏、窄缝与退化矩形），主进程侧
  // 锁住判定顺序、重建前清理、早退分支清理与「没上屏就别等防抖」。
  {
    const { MIN_PENDING_VISIBLE, MIN_PENDING_OVERLAP_RATIO, overlapOf, shouldHideBeforeSwitch } = requireCjs(
      path.join(PLUGIN_ROOT, 'desktop', 'display-follow.cjs')
    )
    const win = { x: 0, y: 0, width: 2560, height: 1440 }
    const rect = (x, y, width, height) => ({ x, y, width, height })
    check(
      'PR#15：副屏在主屏左侧（负坐标）完全移出 → 先隐身',
      shouldHideBeforeSwitch(rect(-2560, 0, 2560, 1440), win) === true &&
        overlapOf(rect(-2560, 0, 2560, 1440), win).ratio === 0
    )
    check(
      'PR#15：还剩 45% 时不隐身，32% 时隐身',
      shouldHideBeforeSwitch(rect(-1408, 0, 2560, 1440), win) === false &&
        shouldHideBeforeSwitch(rect(-1741, 0, 2560, 1440), win) === true
    )
    check(
      'PR#15：只剩 4px 窄缝时隐身（不把鲸鱼钳在缝里）',
      shouldHideBeforeSwitch(rect(-2556, 0, 2560, 1440), win) === true
    )
    check(
      'PR#15：上下堆叠时按高度判窄缝',
      shouldHideBeforeSwitch(rect(0, -1340, 2560, 1440), win) === true
    )
    check(
      'PR#15：退化/零面积矩形不产生 NaN',
      shouldHideBeforeSwitch(rect(0, 0, 0, 0), win) === true &&
        Number.isFinite(overlapOf(rect(0, 0, 0, 0), win).ratio)
    )
    check(
      'PR#15：等待期阈值保持 120 DIP / 35%',
      MIN_PENDING_VISIBLE === 120 && MIN_PENDING_OVERLAP_RATIO === 0.35
    )
    const mainSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'desktop', 'main.cjs'), 'utf8')
    check(
      'PR#15：换屏判定在视口计算之前，阈值不再写死在主进程',
      mainSrc.indexOf('if (maybeSwitchDisplay(rect)) return') !== -1 &&
        mainSrc.indexOf('if (maybeSwitchDisplay(rect)) return') <
          mainSrc.indexOf('const vx0 = Math.round(rect.x - winBounds.x)') &&
        mainSrc.indexOf('MIN_PENDING_OVERLAP_RATIO') === -1,
      ''
    )
    check(
      'PR#15：没上屏时不等 700ms 防抖，直接换屏',
      /const wasShown = overlayShown/.test(mainSrc) &&
        /const switchDelay = wasShown \? DISPLAY_SWITCH_MS : 0/.test(mainSrc) &&
        /setTimeout\(\(\) => \{[\s\S]*?\}, switchDelay\)/.test(mainSrc),
      ''
    )
    check(
      'PR#15：目标屏按 ZCode 窗口中心判定',
      /getDisplayNearestPoint\(center\)/.test(mainSrc) &&
        /Math\.round\(rectDip\.x \+ rectDip\.width \/ 2\)/.test(mainSrc),
      ''
    )
    check(
      'PR#15：早退分支清掉待切换计时器',
      /if \(msg\.gone\) \{\s*clearPendingDisplay\(\)/.test(mainSrc) &&
        /if \(msg\.hide \|\| msg\.show === false\) \{\s*clearPendingDisplay\(\)/.test(mainSrc) &&
        /if \(!uiReady && !refreshUiReady\(\)\) \{\s*clearPendingDisplay\(\)/.test(mainSrc),
      ''
    )
    check(
      'PR#15：重建时清旧跟随消息与视口，指标变化保留当前屏',
      mainSrc.indexOf('clearPendingDisplay()\n  lastFollowerMsg = null') !== -1 &&
        /screen\.getDisplayMatching\(win\.getBounds\(\)\)\.workArea/.test(mainSrc),
      ''
    )
    check(
      'PR#15：跟随脚本起不来时兜底回主屏并复位 overlayWorkArea',
      /const \{ workArea \} = screen\.getPrimaryDisplay\(\)[\s\S]{0,300}?overlayWorkArea = null[\s\S]{0,120}?win\.setBounds\(overlayWorkAreaBounds\(workArea\)\)/.test(
        mainSrc
      ),
      ''
    )
  }

  // 二级面板与气泡：hidePanelsForBubble() 会把六个面板设成 visibility:hidden；
  // 用户主动打开任一面板时必须先让气泡让路，否则面板要等气泡自动关闭才可见。
  // 六个入口统一走 dismissBubbleForPanel()，只修单个面板会让其余入口继续复现。
  {
    const widgetSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'widget.js'), 'utf8')
    const panelToggles = ['toggleBookPanel', 'toggleMorePanel', 'toggleAboutPanel', 'toggleUpdatePanel']
    const missing = panelToggles.filter(function (name) {
      const start = widgetSrc.indexOf('function ' + name + '(')
      if (start === -1) return true
      return !/dismissBubbleForPanel\(\)/.test(widgetSrc.slice(start, start + 600))
    })
    check(
      '打开任一二面板都先收掉当前气泡（气泡会把面板 visibility:hidden）',
      /function dismissBubbleForPanel\(\) \{\s*if \(costBubbleActive\) hideCostBubble\(\)\s*else if \(bubbleShown\) hideBubble\(\)/.test(
        widgetSrc
      ) &&
        missing.length === 0 &&
        /if \(usageOpen\) \{\s*dismissBubbleForPanel\(\)/.test(widgetSrc) &&
        /function toggleBubbleEditor\(\) \{[\s\S]{0,300}?dismissBubbleForPanel\(\)/.test(widgetSrc),
      missing.join(',')
    )
    check(
      '预警气泡被主动收起时一并清 alertBubbleTimer',
      /function hideCostBubble\(\) \{[\s\S]{0,800}?if \(alertBubbleTimer\) \{\s*clearTimeout\(alertBubbleTimer\)\s*alertBubbleTimer = null/.test(
        widgetSrc
      ),
      ''
    )
  }

  // ---------- 宿主更新时的让路（issue #2 后半段：更新 ZCode 时提示「无法关闭 ZCode」） ----------
  // 判定与探测抽在 desktop/update-guard.cjs（纯函数 + 一次「可执行映像是否被占用」探测）。
  // 这里测三层：纯函数三态、真机占用语义、以及**端到端**——用「跟随一个不存在的进程」模拟
  // 宿主消失，断言浮层真的让路（停掉本机服务 + 自己退出）；再测「探测到更新程序在跑」这条
  // 提前让路的分支。
  {
    const requireCjs = createRequire(import.meta.url)
    const guard = requireCjs('../desktop/update-guard.cjs')
    const throwCode = (code) => () => {
      const e = new Error(code)
      e.code = code
      throw e
    }
    check(
      '让路判定：更新程序在跑 → quit-updater；宿主已退出 → quit-hostgone；其余 wait',
      guard.yieldPlan({ updaterRunning: true, hostGone: false }) === 'quit-updater' &&
        guard.yieldPlan({ updaterRunning: false, hostGone: true }) === 'quit-hostgone' &&
        guard.yieldPlan({ updaterRunning: false, hostGone: false }) === 'wait' &&
        guard.yieldPlan() === 'wait'
    )
    check(
      '更新程序路径：默认 %LOCALAPPDATA%\\@zcodedesktop-updater\\installer.exe；可被 WHALE_ZCODE_UPDATER_DIR 覆盖；缺 LOCALAPPDATA 时为空',
      guard.updaterInstallerPath({ LOCALAPPDATA: 'C:\\L' }).replace(/\\/g, '/') === 'C:/L/@zcodedesktop-updater/installer.exe' &&
        guard.updaterInstallerPath({ LOCALAPPDATA: 'C:\\L', WHALE_ZCODE_UPDATER_DIR: 'D:\\u' }).replace(/\\/g, '/') === 'D:/u/installer.exe' &&
        guard.updaterInstallerPath({}) === ''
    )
    check(
      '更新程序探测：可写=没在跑；EBUSY/EPERM=在跑；ENOENT=没在跑；WHALE_FAKE_UPDATER=1 强制为真',
      guard.isUpdaterRunning('x', { openSync: () => 1, closeSync: () => {} }) === false &&
        guard.isUpdaterRunning('x', { openSync: throwCode('EBUSY') }) === true &&
        guard.isUpdaterRunning('x', { openSync: throwCode('EPERM') }) === true &&
        guard.isUpdaterRunning('x', { openSync: throwCode('ENOENT') }) === false &&
        guard.isUpdaterRunning('x', { env: { WHALE_FAKE_UPDATER: '1' } }) === true
    )
    // 真机语义：运行中的可执行映像被内核以「拒绝写入」方式打开 → 探测为「在跑」；结束后恢复。
    // 这条正是 update-guard 赖以判定的机制，用真实进程验一遍（非 Windows 语义不同，跳过）。
    if (process.platform !== 'win32') {
      check('更新程序探测（真机）：跳过——占用语义只在 Windows 成立', true, '跳过')
    } else {
      const t = fs.mkdtempSync(path.join(os.tmpdir(), 'zcw-guard-'))
      const exe = path.join(t, 'probe.exe')
      fs.copyFileSync(process.execPath, exe)
      const before = guard.isUpdaterRunning(exe)
      const child = spawn(exe, ['-e', 'setTimeout(()=>{},6000)'], { stdio: 'ignore', windowsHide: true })
      await new Promise((r) => setTimeout(r, 900))
      const during = guard.isUpdaterRunning(exe)
      try {
        child.kill()
      } catch (err) {}
      await new Promise((r) => setTimeout(r, 1200))
      const after = guard.isUpdaterRunning(exe)
      check(
        '更新程序探测（真机）：运行中被占用 → true；未运行 / 已退出 → false',
        before === false && during === true && after === false,
        JSON.stringify({ before, during, after })
      )
      fs.rmSync(t, { recursive: true, force: true })
    }
    {
      const mainSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'desktop', 'main.cjs'), 'utf8')
      check(
        '让路接线：三条退出路径（宿主 gone / 30 秒空窗 / 探测命中）都走 yieldToHost，且都会停掉本机服务',
        /function yieldToHost\(reason\)/.test(mainSrc) &&
          /function stopLocalService\(\)/.test(mainSrc) &&
          /stopLocalService\(\)\.then/.test(mainSrc) &&
          /yield-service-stop/.test(mainSrc) &&
          (mainSrc.match(/yieldToHost\(/g) || []).length >= 4
      )
      check(
        '让路接线：更新程序探测只在「宿主窗口消失」期间启用（正常态零开销）',
        /startUpdaterProbe\(\)/.test(mainSrc) && /stopUpdaterProbe\(\)/.test(mainSrc) && /UPDATER_PROBE_MS/.test(mainSrc)
      )
    }
    // 端到端：起一个隔离服务 + 一个真的浮层（跟随不存在的进程 → 立刻 hide、5 秒后 gone）
    {
      const ELECTRON = path.join(
        os.homedir(),
        '.zcode',
        'whale',
        'desktop-runtime',
        'node_modules',
        'electron',
        'dist',
        process.platform === 'win32' ? 'electron.exe' : 'electron'
      )
      if (!fs.existsSync(ELECTRON)) {
        check('让路（端到端）：跳过——本机未安装 Electron 运行时', true, '跳过')
      } else {
        const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
        const scenario = async (fakeUpdater, port) => {
          const t = fs.mkdtempSync(path.join(os.tmpdir(), 'zcw-yield-'))
          const data = path.join(t, 'whale')
          fs.mkdirSync(data, { recursive: true })
          fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port }), 'utf8')
          const logFile = path.join(data, 'overlay-debug.log')
          const svc = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'server.mjs')], {
            cwd: PLUGIN_ROOT,
            env: { ...process.env, ZCODE_HOME: t, WHALE_DISABLE_UPDATE_CHECK: '1' },
            stdio: 'ignore',
            windowsHide: true,
          })
          const alive = async () => {
            try {
              const r = await fetch('http://127.0.0.1:' + port + '/whale/health', { signal: AbortSignal.timeout(700) })
              return r.ok
            } catch (err) {
              return false
            }
          }
          let ready = false
          for (let i = 0; i < 30 && !ready; i++) {
            await sleepMs(300)
            ready = await alive()
          }
          const spawnAt = Date.now()
          const ov = spawn(ELECTRON, [path.join(PLUGIN_ROOT, 'desktop'), '--user-data-dir=' + path.join(t, 'profile')], {
            cwd: PLUGIN_ROOT,
            env: {
              ...process.env,
              WHALE_PORT: String(port),
              WHALE_DATA_DIR: data,
              WHALE_TARGET_PROCESS: 'NoSuchProcessZCWTEST',
              WHALE_OVERLAY_LOG: logFile,
              WHALE_DISABLE_UPDATE_CHECK: '1',
              ...(fakeUpdater ? { WHALE_FAKE_UPDATER: '1' } : {}),
            },
            stdio: 'ignore',
            windowsHide: true,
          })
          let exited = false
          let exitAt = 0
          ov.on('exit', () => {
            exited = true
            exitAt = Date.now()
          })
          let serviceStopped = false
          for (let i = 0; i < 60 && !(exited && serviceStopped); i++) {
            await sleepMs(500)
            if (!(await alive())) serviceStopped = true
          }
          const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
          try {
            ov.kill()
          } catch (err) {}
          try {
            svc.kill()
          } catch (err) {}
          await sleepMs(300)
          fs.rmSync(t, { recursive: true, force: true })
          return { ready, exited, serviceStopped, logText, elapsedMs: exitAt ? exitAt - spawnAt : -1 }
        }
        const a = await scenario(false, 39781)
        check(
          '让路（端到端·宿主消失）：浮层自己退出，并把本机挂件服务一起停掉（yield-hostgone + yield-service-stop ok）',
          a.ready && a.exited && a.serviceStopped && /yield-hostgone/.test(a.logText) && /yield-service-stop ok/.test(a.logText),
          JSON.stringify({ ready: a.ready, exited: a.exited, serviceStopped: a.serviceStopped, ms: a.elapsedMs })
        )
        const b = await scenario(true, 39782)
        // 时间断言是这条用例的关键：gone 分支要等跟随脚本满 5 秒才触发，而探测是 2 秒一拍。
        // 若只断言日志里出现 yield-updater，gone 分支也会打出同样的串（FAKE 让探测恒真），
        // 那样「提前让路」就假通过了——所以 A 必须 ≥5 秒、B 必须明显早于 5 秒。
        check(
          '让路时序：宿主消失走满 5 秒宽限才退（≥5s），更新程序在跑则提前退（<5s）',
          a.elapsedMs >= 5000 && b.elapsedMs > 0 && b.elapsedMs < 5000,
          JSON.stringify({ hostGoneMs: a.elapsedMs, updaterMs: b.elapsedMs })
        )
        check(
          '让路（端到端·更新程序在跑）：窗口消失期间探测命中 → 提前让路（yield-updater，早于 gone 的 5 秒）',
          b.ready && b.exited && b.serviceStopped && /yield-updater/.test(b.logText),
          JSON.stringify({ ready: b.ready, exited: b.exited, serviceStopped: b.serviceStopped, ms: b.elapsedMs })
        )
      }
    }
  }

  // 角色库：内置嘎啦嘛（默认）/大肥鱼固定在前，上传件自动启用；未指定时默认嘎啦嘛
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
    '角色列表：内置形象按 BUILTIN_ROLES 顺序在前（' + BUILTIN_ROLES.length + ' 个，含哈基米）+ 上传件，selected 指向上传件',
    roles1 &&
      roles1.ok &&
      roles1.roles.length === BUILTIN_ROLES.length + 1 &&
      BUILTIN_ROLES.every((b, i) => roles1.roles[i].id === b.id && roles1.roles[i].name === b.name) &&
      roles1.selected === upBody.id,
    JSON.stringify(roles1).slice(0, 200)
  )
  // 立绘 ?role= 直取：切角色那一刻 roleId 还没落盘（保存有 300ms 去抖），只按
  // widget-state 取会拿到上一张（2026-10-18 真机：逐张切换时每张都错一位）
  {
    const gptBytes = fs.readFileSync(path.join(PLUGIN_ROOT, 'assets', 'gpt.png'))
    const res = await fetch('http://127.0.0.1:' + port + '/whale/image.png?role=gpt')
    const got = Buffer.from(await res.arrayBuffer())
    check(
      '立绘 ?role= 直取对应角色（不受保存去抖影响）',
      res.ok && got.equals(gptBytes),
      'HTTP ' + res.status + '，' + got.length + ' 字节'
    )
    const unknown = await fetch('http://127.0.0.1:' + port + '/whale/image.png?role=__nope__')
    check('立绘未知 role 参数回落当前角色（不 404）', unknown.ok, 'HTTP ' + unknown.status)
  }
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
  check('未指定角色 = 默认嘎啦嘛（selected=fox）', roles2 && roles2.ok && roles2.selected === 'fox', JSON.stringify(roles2.selected))
  const imgDef = Buffer.from(await (await fetch('http://127.0.0.1:' + port + '/whale/image.png')).arrayBuffer())
  const glmPng = fs.readFileSync(path.join(PLUGIN_ROOT, 'assets', 'GLM.png'))
  check(
    '默认形象图 = 嘎啦嘛 GLM.png（610x610 统一画布）',
    imgDef.equals(glmPng) && imgDef.readUInt32BE(16) === 610 && imgDef.readUInt32BE(20) === 610,
    'len=' + imgDef.length
  )
  // 六张内置立绘的统一几何：画布 610×610、内容高 587、内容右边与底边都贴到画布边。
  // 这条是最容易在换立绘时漏掉的（漏了就会「每切一个角色位置都变」），所以钉进自检。
  {
    const geom = BUILTIN_ROLES.map((r) => ({ id: r.id, g: pngGeom(fs.readFileSync(r.image)) }))
    const bad = geom.filter((it) => it.g.w !== 610 || it.g.h !== 610 || it.g.chh !== 587 || it.g.maxX !== 609 || it.g.maxY !== 609)
    check(
      '六张内置立绘几何统一（610×610 / 内容高 587 / 右边与底边贴齐）',
      bad.length === 0,
      bad.length
        ? JSON.stringify(
            bad.map((it) => it.id + '：画布' + it.g.w + 'x' + it.g.h + ' 内容' + it.g.cw + 'x' + it.g.chh + ' 右边距' + (609 - it.g.maxX) + ' 底边距' + (609 - it.g.maxY))
          )
        : geom.map((it) => it.id + ' ' + it.g.cw + 'x' + it.g.chh).join(' / ')
    )
  }
  await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, roleId: 'whale' }),
  })
  const imgWhale = Buffer.from(await (await fetch('http://127.0.0.1:' + port + '/whale/image.png')).arrayBuffer())
  const whalePng = fs.readFileSync(path.join(PLUGIN_ROOT, 'assets', 'DSniang1.png'))
  check('切换大肥鱼后 image.png 换成 DSniang1.png', imgWhale.equals(whalePng), 'len=' + imgWhale.length)

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
    body: JSON.stringify({ id: 'fox', name: '不许改' }),
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
    '导入角色删除（索引 + 文件 + 选中回落默认嘎啦嘛）',
    delRes.ok &&
      delBody.ok === true &&
      afterIds.indexOf(delUpBody.id) === -1 &&
      delBody.selected === 'fox' &&
      afterIds.length === beforeDel.roles.length - 1,
    JSON.stringify({ selected: delBody.selected, n: afterIds.length })
  )
  const delImgRes = await fetch('http://127.0.0.1:' + port + '/whale/image.png')
  check('删除当前形象后 image.png 仍可用（回落默认图）', delImgRes.ok, 'HTTP ' + delImgRes.status)
  // v1.6.0：内置形象也可以删（包内素材删不掉文件，改为记进 roles.json 的
  // hiddenBuiltins 隐藏；删掉的正好是当前形象时选中项要换一个，否则图片 404）
  const delBuiltin = await fetch('http://127.0.0.1:' + port + '/whale/role-delete.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'whale' }),
  })
  const delBuiltinBody = await delBuiltin.json()
  const builtinIds = (delBuiltinBody.roles || []).filter((r) => r.builtin).map((r) => r.id)
  check(
    '内置形象可删除（从列表隐藏，others 不受影响）',
    delBuiltin.ok && delBuiltinBody.ok === true && builtinIds.indexOf('whale') === -1 && builtinIds.indexOf('fox') !== -1,
    JSON.stringify({ selected: delBuiltinBody.selected, builtins: builtinIds })
  )
  const idxAfterBuiltinDel = JSON.parse(fs.readFileSync(path.join(dataDir, 'roles.json'), 'utf8'))
  check(
    '内置形象删除记进 hiddenBuiltins（可手动找回）',
    Array.isArray(idxAfterBuiltinDel.hiddenBuiltins) && idxAfterBuiltinDel.hiddenBuiltins.indexOf('whale') !== -1,
    JSON.stringify(idxAfterBuiltinDel.hiddenBuiltins || null)
  )
  const delBuiltinSelected = await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roleId: 'fox' }),
  })
  await delBuiltinSelected.json()
  const delBuiltinInUse = await fetch('http://127.0.0.1:' + port + '/whale/role-delete.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'fox' }),
  })
  const delBuiltinInUseBody = await delBuiltinInUse.json()
  const imgAfterBuiltinDel = await fetch('http://127.0.0.1:' + port + '/whale/image.png')
  check(
    '删掉正在用的内置形象 → 选中项换到剩下那个且图片仍可用',
    delBuiltinInUse.ok &&
      delBuiltinInUseBody.ok === true &&
      delBuiltinInUseBody.selected !== 'fox' &&
      delBuiltinInUseBody.roles.some((r) => r.id === delBuiltinInUseBody.selected) &&
      imgAfterBuiltinDel.ok,
    JSON.stringify({ selected: delBuiltinInUseBody.selected, img: imgAfterBuiltinDel.status })
  )
  // 复原：把两个内置形象从 hiddenBuiltins 里拿掉（= 用户在 roles.json 里手动找回）
  const idxRestore = JSON.parse(fs.readFileSync(path.join(dataDir, 'roles.json'), 'utf8'))
  idxRestore.hiddenBuiltins = []
  fs.writeFileSync(path.join(dataDir, 'roles.json'), JSON.stringify(idxRestore, null, 2), 'utf8')
  const rolesRestored = await getJson(port, '/whale/roles.json')
  check(
    '清掉 hiddenBuiltins 后内置形象回来（README 的找回路径可用）',
    rolesRestored.roles.filter((r) => r.builtin).length === BUILTIN_ROLES.length,
    JSON.stringify(rolesRestored.roles.filter((r) => r.builtin).map((r) => r.id))
  )

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
  // 审查回归：泡泡内容路由此前沿用默认 8KB readBody，合法大模板被拒——
  // 上限已是 512KB，这里用 ~30KB 的单步请求体钉死（放在回读用例之后，避免覆盖其配置）
  const bcBig = await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 2,
      tapAdvance: true,
      steps: [{ modules: [{ type: 'text', text: '大模板内容'.repeat(2000), size: 'A' }] }],
    }),
  })
  const bcBigBody = await bcBig.json()
  check(
    '泡泡内容 ~30KB 请求体被接受（路由上限 512KB，非旧 8KB）',
    bcBig.ok && bcBigBody.ok === true && bcBigBody.steps.length === 1,
    JSON.stringify({ status: bcBig.status, ok: bcBigBody.ok })
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
  // 大而合法的定制配置必须能存（回归：写入路由曾走默认 8KB 请求体上限，
  // 编辑器允许的合法配置保存必被 400「body too large」拒掉——审查 P2-1）
  const bigSteps = []
  for (let i = 0; i < 12; i++) {
    bigSteps.push({
      modules: [
        { type: 'rand', size: 'A', lines: Array.from({ length: 12 }, (_, j) => '字'.repeat(199) + j) },
        { type: 'text', size: 'B', text: '文'.repeat(200) },
        { type: 'rand', size: 'C', lines: Array.from({ length: 12 }, () => '词'.repeat(200)) },
      ],
    })
  }
  const bigBc = await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 2, tapAdvance: true, steps: bigSteps }),
  })
  const bigBcBody = await bigBc.json()
  check(
    '按压泡泡大而合法的配置可保存（12 步 × 3 模块 × 12 行 × 200 字 ≈ 200KB）',
    bigBc.ok && bigBcBody.ok === true && bigBcBody.steps.length === 12 &&
      bigBcBody.steps[0].modules.length === 3 &&
      bigBcBody.steps[0].modules[0].type === 'rand' && bigBcBody.steps[0].modules[0].lines.length === 12 &&
      bigBcBody.steps[0].modules[0].lines[0].length === 200 &&
      bigBcBody.steps[0].modules[1].text.length === 200,
    JSON.stringify({ status: bigBc.status, steps: bigBcBody.steps && bigBcBody.steps.length })
  )
  await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 2, tapAdvance: true, steps: [] }),
  })
  // —— v2.1 扩展（DSH 泡泡系统移植）：link / img / randimg / variants / lib ——
  const extPost = await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 2,
      tapAdvance: true,
      steps: [
        { modules: [{ type: 'link', text: '点这里', href: 'https://example.com/a', size: 'A' }] },
        { modules: [{ type: 'link', text: '坏链接', href: 'javascript:alert(1)', size: 'A' }, { type: 'text', text: '兜底', size: 'A' }] },
        {
          variants: [
            { w: 3, modules: [{ type: 'text', text: '甲', size: 'A' }] },
            { w: 1, modules: [{ type: 'text', text: '乙', size: 'A' }] },
          ],
        },
        { modules: [{ type: 'img', img: '../etc/passwd', size: 'A' }, { type: 'img', img: 'rua', size: 'A' }] },
        { modules: [{ type: 'randimg', imgs: ['rua', 'rua', 'x1'], size: 'A' }] },
      ],
      lib: [{ label: '常用句', module: { type: 'text', text: '你好呀', size: 'A' } }],
    }),
  })
  const extBody = await extPost.json()
  check(
    '气泡 v2.1：link 合法保存 / 危险 href 丢弃 / variants 加权保留 / 非法图片 id 丢弃且一步只留一个图片模块 / randimg 去重 / lib 随配置读写',
    extPost.ok &&
      extBody.ok === true &&
      extBody.steps.length === 5 &&
      extBody.steps[0].modules[0].type === 'link' &&
      extBody.steps[0].modules[0].href === 'https://example.com/a' &&
      extBody.steps[1].modules.length === 1 &&
      extBody.steps[1].modules[0].text === '兜底' &&
      Array.isArray(extBody.steps[2].variants) &&
      extBody.steps[2].variants.length === 2 &&
      extBody.steps[2].variants[0].w === 3 &&
      extBody.steps[3].modules.length === 1 &&
      extBody.steps[3].modules[0].img === 'rua' &&
      extBody.steps[4].modules[0].imgs.length === 2 &&
      Array.isArray(extBody.lib) &&
      extBody.lib.length === 1 &&
      extBody.lib[0].label === '常用句',
    JSON.stringify({ n: extBody.steps.length, lib: extBody.lib && extBody.lib.length })
  )
  const extBack = await getJson(port, '/whale/bubble-content.json')
  check(
    '气泡 v2.1 持久化回读一致（variants/lib 落盘）',
    extBack.steps.length === 5 && Array.isArray(extBack.lib) && extBack.lib.length === 1,
    JSON.stringify({ steps: extBack.steps.length, lib: extBack.lib && extBack.lib.length })
  )
  await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 2, tapAdvance: true, steps: [] }),
  })
  // 泡泡模板路由：写 / 读 / 清 / 非法 kind
  const tplPost = await fetch('http://127.0.0.1:' + port + '/whale/bubble-templates.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'turncost', config: { steps: [{ modules: [{ type: 'text', text: '本轮 {cost}', size: 'A' }] }] } }),
  })
  const tplPostBody = await tplPost.json()
  const tplGet = await getJson(port, '/whale/bubble-templates.json')
  check(
    '泡泡模板：turncost 写入并读回（单步 {cost} 文案）',
    tplPost.ok &&
      tplPostBody.ok === true &&
      tplGet.ok === true &&
      tplGet.turnCost &&
      tplGet.turnCost.steps.length === 1 &&
      tplGet.turnCost.steps[0].modules[0].text === '本轮 {cost}',
    JSON.stringify({ ok: tplPostBody.ok, has: !!tplGet.turnCost })
  )
  const tplClear = await fetch('http://127.0.0.1:' + port + '/whale/bubble-templates.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'turncost', config: null }),
  })
  const tplClearBody = await tplClear.json()
  const tplGet2 = await getJson(port, '/whale/bubble-templates.json')
  check(
    '泡泡模板：config=null 恢复内置（清空）',
    tplClear.ok && tplClearBody.ok === true && tplGet2.turnCost === null,
    JSON.stringify({ cleared: tplGet2.turnCost === null })
  )
  const tplBad = await fetch('http://127.0.0.1:' + port + '/whale/bubble-templates.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'nope', config: null }),
  })
  check('泡泡模板：未知 kind 拒绝', tplBad.status === 400, 'status=' + tplBad.status)
  // 契约钉死（审查 P2-A/P2-B/P3-C）：模板容量与按压泡泡同口径、kind 带不带 alert- 前缀都认、
  // 清空内容 ≡ 恢复内置——三条都是「编辑器允许的操作必须存得下」这条教训的不同切面
  const bigTplLines = []
  for (let j = 0; j < 12; j++) bigTplLines.push('第' + (j + 1) + '行 ' + '模'.repeat(180))
  const bigTplModules = [1, 2, 3].map((n) => ({ type: 'rand', lines: bigTplLines.map((t) => n + '·' + t) }))
  const bigTplRaw = JSON.stringify({ kind: 'plan', config: { steps: [{ modules: bigTplModules }] } })
  const bigTpl = await fetch('http://127.0.0.1:' + port + '/whale/bubble-templates.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: bigTplRaw,
  })
  const bigTplBody = await bigTpl.json()
  const bigTplGet = await getJson(port, '/whale/bubble-templates.json')
  check(
    '泡泡模板：8KB 以上的合法模板可存（曾沿用 8KB 默认上限 → 合法内容必败，审查 P2-A）',
    Buffer.byteLength(bigTplRaw) > 8192 &&
      bigTpl.ok &&
      bigTplBody.ok === true &&
      !!(bigTplGet.alerts && bigTplGet.alerts.plan),
    JSON.stringify({ bytes: Buffer.byteLength(bigTplRaw), status: bigTpl.status, ok: bigTplBody.ok })
  )
  const preRestore = await fetch('http://127.0.0.1:' + port + '/whale/bubble-templates.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'alert-plan', config: null }),
  })
  const preRestoreBody = await preRestore.json()
  const preRestoreGet = await getJson(port, '/whale/bubble-templates.json')
  check(
    '泡泡模板：编辑器形态 alert-plan 的「恢复内置」被接受并清空（前缀契约，审查 P2-B）',
    preRestore.ok && preRestoreBody.ok === true && preRestoreGet.alerts.plan === null,
    JSON.stringify({ status: preRestore.status, error: preRestoreBody.error || null })
  )
  await fetch('http://127.0.0.1:' + port + '/whale/bubble-templates.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'plan', config: { steps: [{ modules: [{ type: 'text', text: '预警 {percent}', size: 'A' }] }] } }),
  })
  const tplEmpty = await fetch('http://127.0.0.1:' + port + '/whale/bubble-templates.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'plan', config: { steps: [{ modules: [] }] } }),
  })
  const tplEmptyBody = await tplEmpty.json()
  const tplEmptyGet = await getJson(port, '/whale/bubble-templates.json')
  check(
    '泡泡模板：清空内容保存 ≡ 恢复内置（编辑器提示这么写的就得兑现，审查 P3-C）',
    tplEmpty.ok && tplEmptyBody.ok === true && tplEmptyGet.alerts.plan === null,
    JSON.stringify({ status: tplEmpty.status, error: tplEmptyBody.error || null })
  )
  // 组权重机制已废弃（2026-10-06）：内置第二次点击内容改为普通配置（出厂默认
  // 队列在 widget.js），权重落在变体与逐条语句上。旧配置里的 groupW 被忽略。
  const gwDrop = await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 2, tapAdvance: true, steps: [], groupW: [10, 0, 0, 0, 0, 3] }),
  })
  const gwDropBack = await getJson(port, '/whale/bubble-content.json')
  check('气泡配置：废弃的 groupW 字段被忽略（不再落盘）', gwDrop.ok && gwDropBack.groupW === undefined, JSON.stringify(gwDropBack.groupW))
  // 逐条字号档：随机语句可混合 B/A/C 档（默认队列里「挑经句大字 + 文案中字」同池）
  const szPost = await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 2,
      tapAdvance: true,
      steps: [
        {
          modules: [
            {
              type: 'rand',
              size: 'A',
              lines: [
                { t: '大字', w: 4, size: 'B' },
                { t: '中字带样式', w: 2, st: { bold: true } },
                { t: '欠账', w: 1 },
              ],
            },
          ],
        },
      ],
    }),
  })
  const szBody = await szPost.json()
  const szl = szBody.steps && szBody.steps[0] && szBody.steps[0].modules[0] && szBody.steps[0].modules[0].lines
  check(
    '随机语句逐条字号档：size=B 落对象 / 无样式无档位落字符串（|权重）',
    szPost.ok &&
      Array.isArray(szl) &&
      szl.length === 3 &&
      szl[0].t === '大字' &&
      szl[0].size === 'B' &&
      szl[0].w === 4 &&
      szl[1].st.bold === true &&
      szl[2] === '欠账',
    JSON.stringify(szl)
  )
  // 时段档 / 不换行 / 跟随峰谷色 / 变体只在有峰谷差价的源参与（only:'time'）
  const ext2 = await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 2,
      tapAdvance: true,
      steps: [
        { modules: [{ type: 'rand', size: 'A', lines: [{ t: '单行台词', size: 'P', wrap: false }] }] },
        { modules: [{ type: 'text', text: '{period}', size: 'P', wrap: false, st: { color: 'peak' } }] },
        {
          variants: [
            { w: 50, only: 'time', modules: [{ type: 'text', text: '时段' }] },
            { w: 45, modules: [{ type: 'text', text: '台词' }] },
          ],
        },
      ],
    }),
  })
  const ext2Body = await ext2.json()
  const e2l = ext2Body.steps && ext2Body.steps[0] && ext2Body.steps[0].modules[0].lines
  check(
    '时段档 P / wrap:false（不换行）/ color:peak（跟随峰谷）/ 变体 only:time 往返保留',
    ext2.ok &&
      Array.isArray(e2l) &&
      e2l[0].size === 'P' &&
      e2l[0].wrap === false &&
      ext2Body.steps[1].modules[0].st.color === 'peak' &&
      ext2Body.steps[1].modules[0].wrap === false &&
      ext2Body.steps[2].variants[0].only === 'time' &&
      ext2Body.steps[2].variants[1].only === undefined,
    JSON.stringify({ line: e2l && e2l[0], v0: ext2Body.steps[2].variants[0] })
  )
  // 行级样式（对照 DSH 单句编辑）：样式对象往返 / 「句子|权重」字符串兼容 /
  // 非法样式值（超界字号、非 hex 颜色、未知字体）被丢弃
  const styledPost = await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      v: 2,
      tapAdvance: true,
      steps: [
        {
          modules: [
            {
              type: 'rand',
              size: 'A',
              lines: [
                { t: '好耶', w: 3, st: { px: 18, bold: true, color: '#E0433F', font: 'serif' } },
                '普通一句|5',
                { t: '样式全非法', st: { px: 999, color: 'javascript:alert(1)', font: 'comic' } },
                { t: '只带下划线', st: { ul: true } },
              ],
            },
          ],
        },
        { modules: [{ type: 'text', text: '带样式文本', size: 'A', st: { bold: true, ul: true, bg: '#2b2b2b' } }] },
      ],
    }),
  })
  const styledBody = await styledPost.json()
  const sl = styledBody.steps && styledBody.steps[0] && styledBody.steps[0].modules[0] && styledBody.steps[0].modules[0].lines
  check(
    '气泡行级样式：样式对象往返（含权重）/ 字符串「|权重」保持字符串 / 非法样式值丢弃 / 文本模块样式保留',
    styledPost.ok &&
      Array.isArray(sl) &&
      sl.length === 4 &&
      typeof sl[0] === 'object' &&
      sl[0].t === '好耶' &&
      sl[0].w === 3 &&
      sl[0].st.px === 18 &&
      sl[0].st.bold === true &&
      sl[0].st.color === '#e0433f' &&
      sl[0].st.font === 'serif' &&
      sl[1] === '普通一句|5' &&
      sl[2] === '样式全非法' &&
      sl[3].st.ul === true &&
      sl[3].st.px === undefined &&
      styledBody.steps[1].modules[0].st.bold === true &&
      styledBody.steps[1].modules[0].st.bg === '#2b2b2b',
    JSON.stringify({ n: sl && sl.length, first: sl && sl[0], third: sl && sl[2] })
  )
  await fetch('http://127.0.0.1:' + port + '/whale/bubble-content.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 2, tapAdvance: true, steps: [] }),
  })
  // 泡泡图库路由：上传 → 列表（含内置 rua）→ 取图 → 删除后 404
  const PNG1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const imgPost = await fetch('http://127.0.0.1:' + port + '/whale/bubble-img.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '测试图', dataUrl: PNG1x1 }),
  })
  const imgPostBody = await imgPost.json()
  const imgList = await getJson(port, '/whale/bubble-imgs.json')
  const imgId = imgPostBody.id
  const imgBytes = await fetch('http://127.0.0.1:' + port + '/whale/bubble-img.png?id=' + imgId)
  const imgRua = await fetch('http://127.0.0.1:' + port + '/whale/bubble-img.png?id=rua')
  const imgDel = await fetch('http://127.0.0.1:' + port + '/whale/bubble-img-delete.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: imgId }),
  })
  const imgAfterDel = await fetch('http://127.0.0.1:' + port + '/whale/bubble-img.png?id=' + imgId)
  check(
    '泡泡图库：上传 png → 列表含内置 rua → 取图（png/gif 字节）→ 删除后 404',
    imgPost.ok &&
      imgPostBody.ok === true &&
      imgList.ok === true &&
      imgList.imgs.some((r) => r.id === imgId) &&
      imgList.builtin.some((r) => r.id === 'rua') &&
      imgBytes.ok &&
      (imgBytes.headers.get('content-type') || '').indexOf('image/png') === 0 &&
      imgRua.ok &&
      (imgRua.headers.get('content-type') || '').indexOf('image/gif') === 0 &&
      imgDel.ok &&
      imgAfterDel.status === 404,
    JSON.stringify({ up: imgPostBody.ok, list: imgList.imgs.length, png: imgBytes.status, rua: imgRua.status, del: imgAfterDel.status })
  )

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

  // 同一平台混用：真实数据库 → 服务轮次 → 汇总，订阅声明不能吞掉按量行。
  for (const [providerId, plan] of [['volcengine-ark', false], ['volc-plan-test', true], ['9de0b0cd-43cc-4b9d-867c-32030235e990', true]]) {
    const before = await getJson(port, '/whale/last-turn.json')
    insertTurn('sess_selftest', 'turn_' + providerId, USAGE_B, Date.now(), [{ model: MODEL, providerId, usage: USAGE_B }])
    let turn
    const deadline = Date.now() + 6000
    do {
      await new Promise((r) => setTimeout(r, 400))
      turn = await getJson(port, '/whale/last-turn.json')
    } while (turn.seq <= before.seq && Date.now() < deadline)
    check('火山逐轮计费：' + providerId, turn.seq > before.seq && turn.tokens > 0 &&
      (plan ? turn.amount === 0 && turn.billable === false : turn.amount > 0 && turn.billable === true), JSON.stringify(turn))
  }
  const volcRec = await getJson(port, '/whale/usage-records.json')
  const apiRow = volcRec.today.models.find((m) => m.providerId === 'volcengine-ark')
  const planRow = volcRec.today.models.find((m) => m.providerId === 'volc-plan-test')
  check('火山混用汇总：按量金额保留，订阅为零，平台标签独立',
    apiRow && apiRow.amount > 0 && !apiRow.plan && apiRow.vendorLabel === '火山方舟' &&
    planRow && planRow.amount === 0 && planRow.plan && planRow.tokens > 0 && planRow.vendorLabel === '火山 Coding Plan',
    JSON.stringify({ apiRow, planRow }))
  const volcRoute = await getJson(port, '/whale/volc.json?providerId=volc-plan-test')
  check('火山路由：未配置 IAM 仍返回稳定错误且不泄露凭据', volcRoute.ok === false &&
    volcRoute.reason === 'no-credentials' && !('ak' in volcRoute) && !('sk' in volcRoute))
  const agentRow = volcRec.today.models.find(m => m.providerId === '9de0b0cd-43cc-4b9d-867c-32030235e990')
  check('火山 Agent 汇总：按专用路径归零且标明套餐', agentRow && agentRow.amount === 0 && agentRow.tokens > 0 && agentRow.vendorLabel === '火山 Agent Plan')
  const apiView = await getJson(port, '/whale/volc.json?providerId=volcengine-ark')
  check('火山 API 视图无需 IAM 凭据', apiView.ok && apiView.volcMode === 'api' && !apiView.windows)
  const agentView = await getJson(port, '/whale/volc.json?providerId=9de0b0cd-43cc-4b9d-867c-32030235e990')
  check('火山 Agent 查询失败仍保持接入分类', !agentView.ok && agentView.reason === 'no-credentials' && agentView.volcMode === 'agent' && agentView.source === 'volc')
  const missingView = await getJson(port, '/whale/volc.json?providerId=missing')
  check('火山未知 provider 不猜测套餐', !missingView.ok && missingView.reason === 'no-volc-provider')


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

  await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scale: 1.5, displayMode: 'volc' }),
  })
  const volcMode = await getJson(port, '/whale/size.json')
  check('displayMode 火山写入并持久化回读', volcMode.displayMode === 'volc')

  // 默认位置（issue #11）：四个角写入 / 回读，非法值丢弃；默认仍是右下
  const cornerInitial = await getJson(port, '/whale/size.json')
  check('默认位置默认值：右下（br）', cornerInitial.defaultCorner === 'br', 'corner=' + cornerInitial.defaultCorner)
  const cornerPut = await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, defaultCorner: 'tl' }),
  })
  const cornerGet = await getJson(port, '/whale/size.json')
  check('默认位置写入并持久化回读（左上）', cornerPut.ok && cornerGet.defaultCorner === 'tl', 'corner=' + cornerGet.defaultCorner)
  await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, defaultCorner: 'center' }),
  })
  const cornerBad = await getJson(port, '/whale/size.json')
  check('默认位置非法值被丢弃（保留原值）', cornerBad.defaultCorner === 'tl', 'corner=' + cornerBad.defaultCorner)
  await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, defaultCorner: 'br' }),
  })

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
  // 跨站页面盲触发的凭据型 GET 被拒（审查 U1）；同源/无 Sec-Fetch-* 的正常请求不受影响
  const crossSiteGet = await rawRequest('GET', '/whale/vendors.json', {
    host: '127.0.0.1:' + port,
    'sec-fetch-site': 'cross-site',
  })
  check('跨站来源的凭据型 GET 被 403', crossSiteGet.status === 403, 'HTTP ' + crossSiteGet.status)
  // 判据必须反过来（除白名单外一律拦）：session.json 会带着用户 key 出站到中转站
  // 与厂商，旧写法只手工列了 4 个端点，它漏在名单外（审查 I4/T4）。这条断言就是
  // 当初漏掉它的直接原因——只测了 vendors.json，没测同类路径。
  const crossSiteSession = await rawRequest('GET', '/whale/session.json', {
    host: '127.0.0.1:' + port,
    'sec-fetch-site': 'cross-site',
  })
  check('跨站触发出站型 session.json 被 403（默认拒绝）', crossSiteSession.status === 403, 'HTTP ' + crossSiteSession.status)
  const crossSiteAsset = await rawRequest('GET', '/whale/image.png', {
    host: '127.0.0.1:' + port,
    'sec-fetch-site': 'cross-site',
  })
  check('跨站取静态素材不被拦（本地白名单）', crossSiteAsset.status === 200, 'HTTP ' + crossSiteAsset.status)
  // 写操作只收 JSON（审查 S7）：text/plain 的跨站 simple request 不该进解析
  const plainWrite = await rawRequest(
    'PUT',
    '/whale/size.json',
    { host: '127.0.0.1:' + port, 'content-type': 'text/plain' },
    JSON.stringify({ scale: 2 })
  )
  check('非 JSON 的写请求被 415', plainWrite.status === 415, 'HTTP ' + plainWrite.status)
  const sameSiteGet = await rawRequest('GET', '/whale/vendors.json', {
    host: '127.0.0.1:' + port,
    'sec-fetch-site': 'same-origin',
  })
  check('同源 GET 不被跨站拦截误伤（反向断言）', sameSiteGet.status === 200, 'HTTP ' + sameSiteGet.status)
  // 角色图 Content-Type 跟着真实扩展名走（审查 S2）：上传一张 gif，取图必须是 image/gif
  {
    const gifUp = await fetch('http://127.0.0.1:' + port + '/whale/role-upload.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'gif-selftest',
        dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      }),
    })
    const gifBody = await gifUp.json()
    const gifImg = await fetch('http://127.0.0.1:' + port + '/whale/image.png', {
      method: 'GET',
      headers: {},
    })
    // 先切到 gif 角色再取图，避免依赖默认角色
    await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 1.5, roleId: gifBody.id }),
    })
    const gifRes = await fetch('http://127.0.0.1:' + port + '/whale/image.png')
    const gifType = String(gifRes.headers.get('content-type') || '')
    await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 1.5, roleId: null }),
    })
    check('角色图按真实扩展名给 Content-Type（gif → image/gif）', gifType.indexOf('image/gif') === 0, gifType + ' / ' + String(gifImg.status))
  }

  // 服务重启：seq 必须从持久化值续上——否则重启后已打开的页面对齐在旧计数上，
  // 新服务的每一轮都会被当成"旧轮次"，每轮消耗气泡静默失效
  const seqBeforeRestart = (await getJson(port, '/whale/last-turn.json')).seq
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill()
  })
  child = spawnServer()
  const health2 = await waitReady(port, 30000, child)
  check('重启后服务重新就绪', !!health2, health2 ? 'pid=' + health2.pid : 'exitCode=' + child.exitCode + ' log=' + childLog.slice(-400))
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
  for (const [providerId, expected] of [['volcengine-ark', 'volc-api'], ['volc-plan-test', 'volc'], ['9de0b0cd-43cc-4b9d-867c-32030235e990', 'volc']]) {
    db.prepare('UPDATE session_entry SET data = ?, time_updated = ? WHERE type = ?').run(
      JSON.stringify({ modelSelection: { providerId, modelId: 'GLM-5.3-Flash' } }), Date.now(), 'runtime/model_selection')
    const selected = await getJson(port, '/whale/session.json')
    check('火山自动跟随与消费链同源：' + providerId, selected.source === expected && selected.volcMode === (providerId === 'volcengine-ark' ? 'api' : providerId === 'volc-plan-test' ? 'coding' : 'agent'), JSON.stringify(selected))
  }
  const providersCli = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'lib/cli.mjs'), 'providers'], { env: serverEnv, encoding: 'utf8' })
  const providersList = JSON.parse(providersCli.stdout || '[]')
  check('providers 命令只输出 ID 与来源，不泄露发现凭据', providersCli.status === 0 &&
    providersList.some((p) => p.providerId === 'volc-plan-test' && p.source === 'volc') &&
    providersList.every((p) => Object.keys(p).sort().join(',') === 'providerId,source'))
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

  // ---------- v1.6.0：音效库导入/删除、今日 token 榜、ZCode 主题跟随 ----------
  {
    // 纯逻辑：token 榜按 token 降序（头部常与金额榜不同——便宜的模型 token 巨大）
    const { modelsByTokens } = await import('../lib/usage-records.mjs')
    const row = (model, amount, tokens) => [
      model,
      { model, providerId: 'p', vendorLabel: 'V', currency: 'CNY', amount, tokens },
    ]
    const m = new Map([row('cheap', 0, 9_000_000), row('pricey', 12.5, 100_000), row('mid', 3, 500_000)])
    const byTok = modelsByTokens(m, 12)
    check(
      'token 榜按 token 降序（头部与金额榜不同）',
      byTok.map((x) => x.model).join(',') === 'cheap,mid,pricey',
      byTok.map((x) => x.model + ':' + x.tokens).join(' ')
    )
    check('token 榜尊重 limit（截断后仍是 token 最大的那批）', modelsByTokens(m, 1).length === 1 && modelsByTokens(m, 1)[0].model === 'cheap')
  }

  // 接口：今日用量同时给出两个榜（页面「按金额 / 按 Token」切换用）
  const usageRank = await getJson(port, '/whale/usage-records.json')
  if (usageRank && usageRank.ok) {
    const amtList = usageRank.today.models || []
    const tokList = usageRank.today.modelsByTokens || []
    // 金额榜按「排名值」（等价市值，Plan 行 amount=0 但 market>0）降序；
    // token 榜按 tokens 降序
    const rankOf = (m) => Number(m.market) || Number(m.amount) || 0
    const descRank = (arr) => arr.every((v, i) => i === 0 || rankOf(arr[i - 1]) >= rankOf(v))
    const desc = (arr, key) => arr.every((v, i) => i === 0 || Number(arr[i - 1][key]) >= Number(v[key]))
    const maxTok = Math.max.apply(null, amtList.map((x) => Number(x.tokens) || 0))
    check(
      '用量记录：两个榜各自降序（金额榜按排名值 / token 榜按 tokens）',
      amtList.length > 0 && tokList.length > 0 && descRank(amtList) && desc(tokList, 'tokens'),
      JSON.stringify({ amt: amtList.map(rankOf), tok: tokList.map((x) => x.tokens) })
    )
    check(
      '用量记录：token 榜首位 = 今日 token 最多的模型',
      tokList.length > 0 && Number(tokList[0].tokens) === maxTok,
      'top=' + (tokList[0] && tokList[0].model) + ' tokens=' + (tokList[0] && tokList[0].tokens) + ' max=' + maxTok
    )
  } else {
    check('用量记录：两个榜各自降序（金额榜按排名值 / token 榜按 tokens）', false, '接口不可用')
  }

  // 接口：ZCode 主题（跟随 ZCode 的数据源）
  const zt = await getJson(port, '/whale/zcode-theme.json')
  check(
    'ZCode 主题：读 <ZCODE_HOME>/cli/config.json 的 ui.theme（zai-dark → dark）',
    zt && zt.ok === true && zt.theme === 'dark' && zt.raw === 'zai-dark' && zt.source === 'user-config',
    JSON.stringify(zt)
  )
  // 观测层（v1.7.2）：浮层把 ZCode 窗口的 DWM 暗色标志落盘，接口优先用它——
  // 跟随的是「ZCode 现在实际用的主题」，配置/系统都可能与实况相反
  const obsFile = path.join(dataDir, 'zcode-theme-observed.json')
  fs.writeFileSync(obsFile, JSON.stringify({ dark: 1, at: Date.now(), source: 'dwm' }), 'utf8')
  await new Promise((r) => setTimeout(r, 5200)) // 服务端读取缓存 5s
  const ztObs = await getJson(port, '/whale/zcode-theme.json')
  check(
    'ZCode 主题：观测层生效（DWM 暗色标志 → dark）',
    ztObs && ztObs.ok === true && ztObs.theme === 'dark' && ztObs.source === 'zcode-window' && ztObs.observed && ztObs.observed.dark === 1,
    JSON.stringify(ztObs)
  )
  fs.writeFileSync(obsFile, JSON.stringify({ dark: 0, at: Date.now(), source: 'dwm' }), 'utf8')
  await new Promise((r) => setTimeout(r, 5200))
  const ztObs2 = await getJson(port, '/whale/zcode-theme.json')
  check(
    'ZCode 主题：观测为浅色时不被配置 zai-dark 带偏（跟随实况）',
    ztObs2 && ztObs2.theme === 'light' && ztObs2.source === 'zcode-window',
    JSON.stringify(ztObs2)
  )
  fs.rmSync(obsFile, { force: true })
  await new Promise((r) => setTimeout(r, 5200))
  const ztBack = await getJson(port, '/whale/zcode-theme.json')
  check(
    'ZCode 主题：观测文件消失后回落配置层（zai-dark → dark）',
    ztBack && ztBack.theme === 'dark' && ztBack.source === 'user-config',
    JSON.stringify(ztBack)
  )

  // 接口：音效库（内置三套 + 导入 + 回放 + 删除）
  const snd0 = await getJson(port, '/whale/sounds.json')
  check(
    '音效库：内置三套在列、默认选中小黄鸭',
    snd0 && snd0.ok === true && snd0.sets.filter((s) => s.builtin).map((s) => s.id).join(',') === 'duck,fx1,nya' && snd0.selected === 'duck',
    JSON.stringify(snd0 && snd0.sets)
  )
  const wavBytes = Buffer.from('RIFF0000WAVEfmt ', 'latin1')
  const wavB64 = wavBytes.toString('base64')
  const oggBytes = Buffer.from('OggS-fake-release-bytes', 'latin1')
  const postSound = (url, body) =>
    fetch('http://127.0.0.1:' + port + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  // 单文件导入：按压/松手共用
  const up1Res = await postSound('/whale/sound-upload.json', {
    name: '自测音效1',
    press: { dataUrl: 'data:audio/wav;base64,' + wavB64, name: 'a.wav' },
  })
  const up1 = await up1Res.json()
  check(
    '音效导入：单个文件成功（按压与松手共用），并出现在列表里',
    up1Res.ok && up1.ok === true && up1.id && up1.sets.some((s) => s.id === up1.id && s.builtin === false && s.name === '自测音效1'),
    JSON.stringify({ id: up1.id, sets: (up1.sets || []).map((s) => s.id) })
  )
  const sndP = await fetch('http://127.0.0.1:' + port + '/whale/sound/press.mp3?set=' + up1.id)
  const sndR = await fetch('http://127.0.0.1:' + port + '/whale/sound/release.mp3?set=' + up1.id)
  const sndPBytes = Buffer.from(await sndP.arrayBuffer())
  check(
    '音效回放：导入集按压/松手都拿得到，且单文件时内容一致（wav → audio/wav）',
    sndP.ok && sndR.ok && sndPBytes.equals(wavBytes) && sndP.headers.get('content-type') === 'audio/wav',
    'HTTP ' + sndP.status + ' ct=' + sndP.headers.get('content-type') + ' bytes=' + sndPBytes.length
  )
  // 两个文件导入：按压/松手各自一份
  const up2Res = await postSound('/whale/sound-upload.json', {
    press: { dataUrl: 'data:audio/wav;base64,' + wavB64, name: 'press.wav' },
    release: { dataUrl: 'data:audio/ogg;base64,' + oggBytes.toString('base64'), name: 'release.ogg' },
  })
  const up2 = await up2Res.json()
  const snd2R = await fetch('http://127.0.0.1:' + port + '/whale/sound/release.mp3?set=' + up2.id)
  const snd2RBytes = Buffer.from(await snd2R.arrayBuffer())
  check(
    '音效导入：两个文件时松手音是第二份（名字缺省取第一个文件名）',
    up2Res.ok && up2.ok === true && up2.sets.some((s) => s.id === up2.id && s.name === 'press') && snd2RBytes.equals(oggBytes),
    JSON.stringify({ id: up2.id, name: (up2.sets || []).filter((s) => s.id === up2.id).map((s) => s.name)[0] })
  )
  // 内置集回放不受影响
  const duckRes = await fetch('http://127.0.0.1:' + port + '/whale/sound/press.mp3?set=duck')
  const duckBytes = Buffer.from(await duckRes.arrayBuffer())
  check(
    '音效回放：内置集照旧可用（audio/mpeg）',
    duckRes.ok && duckBytes.length > 100 && duckRes.headers.get('content-type') === 'audio/mpeg',
    'bytes=' + duckBytes.length
  )
  const nyaRes = await fetch('http://127.0.0.1:' + port + '/whale/sound/press.mp3?set=nya')
  const nyaBytes = Buffer.from(await nyaRes.arrayBuffer())
  check(
    '音效回放：内置猫娘 WAV 使用 audio/wav（不能沿用 mp3 的 Content-Type）',
    nyaRes.ok &&
      nyaRes.headers.get('content-type') === 'audio/wav' &&
      nyaBytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
      nyaBytes.subarray(8, 12).toString('latin1') === 'WAVE',
    'HTTP ' + nyaRes.status + ' ct=' + nyaRes.headers.get('content-type') + ' bytes=' + nyaBytes.length
  )
  // 非法输入被拒
  const badSound = await postSound('/whale/sound-upload.json', { press: { dataUrl: 'data:text/plain;base64,aGk=' } })
  const badSoundBody = await badSound.json()
  check('音效导入：非音频 dataUrl 被拒（400）', badSound.status === 400 && badSoundBody.ok === false, JSON.stringify(badSoundBody))
  // 删除正在用的那套：选中项回落内置 duck。
  // 注意 size.json 的写入以 scale 为必填（缺了直接 400）——少了它这条断言会
  // 「因为没写进去」而假通过，所以这里连写入结果一起断言。
  const putSoundSel = await fetch('http://127.0.0.1:' + port + '/whale/size.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scale: 1.5, soundSet: up2.id }),
  })
  const putSoundSelBody = await putSoundSel.json()
  check(
    '音效选择写入 widget-state（PUT size.json 带 scale）',
    putSoundSel.ok && putSoundSelBody.soundSet === up2.id,
    JSON.stringify({ ok: putSoundSelBody.ok, soundSet: putSoundSelBody.soundSet })
  )
  const delSoundRes = await postSound('/whale/sound-delete.json', { id: up2.id })
  const delSound = await delSoundRes.json()
  check(
    '音效删除：从列表消失，正在用则选中项回落小黄鸭',
    delSoundRes.ok && delSound.ok === true && !delSound.sets.some((s) => s.id === up2.id) && delSound.selected === 'duck',
    JSON.stringify({ selected: delSound.selected, sets: (delSound.sets || []).map((s) => s.id) })
  )
  const goneSound = await fetch('http://127.0.0.1:' + port + '/whale/sound/press.mp3?set=' + up2.id)
  check('音效删除：文件也清掉了（回放 404）', goneSound.status === 404, 'HTTP ' + goneSound.status)
  const delBuiltinSound = await postSound('/whale/sound-delete.json', { id: 'duck' })
  check('音效删除：内置集不可删（400）', delBuiltinSound.status === 400, 'HTTP ' + delBuiltinSound.status)
  await postSound('/whale/sound-delete.json', { id: up1.id })

  // ---------- v1.7.0：今日已用主口径 = 本机库，账号口径做对账 + 兜底 ----------
  {
    // 合并逻辑（纯函数）：本机库有记录就用本机，没有就回退账号口径；两个口径
    // 都留在 payload 里，hint/对账行把它们并排放出来（含其它设备的花费只有
    // 账号口径看得到）。
    const a = resolveTodayUsage({ hasRows: true, amount: 45.14, tokens: 1000 }, { amount: 3.27, source: 'ledger' })
    check(
      '今日口径：本机库有记录 → 主显示本机口径，账号口径留作对账',
      a.todayUsage === 45.14 &&
        a.todayUsageSource === 'db' &&
        a.todayUsageDb === 45.14 &&
        a.accountUsage === 3.27 &&
        a.accountUsageSource === 'ledger',
      JSON.stringify(a)
    )
    const b = resolveTodayUsage({ hasRows: false, amount: 0, tokens: 0 }, { amount: 3.27, source: 'ledger' })
    check(
      '今日口径：本机库无记录 → 兜底账号记账口径',
      b.todayUsage === 3.27 && b.todayUsageSource === 'ledger' && b.todayUsageDb === null,
      JSON.stringify(b)
    )
    const c = resolveTodayUsage({ hasRows: false, amount: 0, tokens: 0 }, { amount: 12.5, source: 'token' })
    check(
      '今日口径：兜底来源随对账口径走（实时·令牌）',
      c.todayUsage === 12.5 && c.todayUsageSource === 'token',
      JSON.stringify(c)
    )
    const e = resolveTodayUsage({ hasRows: false, amount: 0, tokens: 0 }, { amount: null, source: 'ledger' })
    check(
      '今日口径：两路都没数据 → 显示层标 --（todayUsage=null）',
      e.todayUsage === null && e.todayUsageSource === null && e.accountUsage === null,
      JSON.stringify(e)
    )
    const f = resolveTodayUsage(null, { amount: 1, source: 'ledger' })
    check('今日口径：db 缺失按「无记录」处理（不抛异常）', f.todayUsage === 1 && f.todayUsageSource === 'ledger', JSON.stringify(f))
  }

  // 接口：today.byVendor 厂商级汇总（主显示与对账行的数字来源），与逐模型明细同源
  const vendorRec = await getJson(port, '/whale/usage-records.json')
  if (vendorRec && vendorRec.ok) {
    const models = vendorRec.today.models || []
    // models 是 Top12 截断列表；截断时 byVendor（全量）只多不少，按不等式断言
    const truncated = models.length >= 12
    const sumBy = (label) => models.filter((m) => m.vendorLabel === label).reduce((s, m) => s + (Number(m.amount) || 0), 0)
    const bv = vendorRec.today.byVendor || {}
    const agree = (label) =>
      bv[label] && (truncated ? bv[label].amount >= sumBy(label) - 1e-6 : Math.abs(bv[label].amount - sumBy(label)) < 1e-6)
    check(
      '厂商汇总 byVendor 与逐模型明细同源（DeepSeek / GLM 各自一致）',
      agree('DeepSeek') && agree('GLM') && bv.DeepSeek.tokens > 0 && bv.GLM.tokens > 0,
      JSON.stringify(bv)
    )
  } else {
    check('厂商汇总 byVendor 与逐模型明细同源（DeepSeek / GLM 各自一致）', false, '接口不可用')
  }

  // ---------- QA 补缺：纯函数直测（余额挑选 / 套餐轮口径 / 校正公式 / 主题 / 镜像白名单） ----------
  {
    // pickBalanceInfo：多币种余额挑选（优先 CNY>0 → 任意非零 → CNY 项 → 首项）
    const pb = (list) => {
      const r = pickBalanceInfo(list)
      return r ? r.currency + ':' + r.total_balance : 'null'
    }
    check(
      'pickBalanceInfo：优先 CNY 且余额 > 0',
      pb([{ currency: 'USD', total_balance: 5 }, { currency: 'CNY', total_balance: 2 }]) === 'CNY:2',
      pb([{ currency: 'USD', total_balance: 5 }, { currency: 'CNY', total_balance: 2 }])
    )
    check(
      'pickBalanceInfo：无 CNY 正数时取任意非零项',
      pb([{ currency: 'USD', total_balance: 5 }, { currency: 'EUR', total_balance: 3 }]) === 'USD:5',
      pb([{ currency: 'USD', total_balance: 5 }, { currency: 'EUR', total_balance: 3 }])
    )
    check(
      'pickBalanceInfo：CNY 为零、USD 为正 → 取 USD',
      pb([{ currency: 'CNY', total_balance: 0 }, { currency: 'USD', total_balance: 5 }]) === 'USD:5',
      pb([{ currency: 'CNY', total_balance: 0 }, { currency: 'USD', total_balance: 5 }])
    )
    check(
      'pickBalanceInfo：全部为零退回 CNY 项',
      pb([{ currency: 'USD', total_balance: 0 }, { currency: 'CNY', total_balance: 0 }]) === 'CNY:0',
      pb([{ currency: 'USD', total_balance: 0 }, { currency: 'CNY', total_balance: 0 }])
    )
    check(
      'pickBalanceInfo：无 CNY 且全零取首项',
      pb([{ currency: 'EUR', total_balance: 0 }, { currency: 'USD', total_balance: 0 }]) === 'EUR:0',
      pb([{ currency: 'EUR', total_balance: 0 }, { currency: 'USD', total_balance: 0 }])
    )
    check('pickBalanceInfo：空/非数组返回 null', pickBalanceInfo([]) === null && pickBalanceInfo(null) === null, 'null')
    // 余额构成（赠金 / 充值）：缺失与 0 必须区分开——0 是"真没有赠金"，null 是
    // "接口没给这个字段"，前端据此决定显示 0.00 还是 --（甚至整行隐藏）
    {
      const full = balanceSplit({ total_balance: '12.30', granted_balance: '2.10', topped_up_balance: '10.20' })
      check(
        'balanceSplit：赠金 / 充值原样取出（字符串转数字）',
        full.grantedBalance === 2.1 && full.toppedBalance === 10.2,
        JSON.stringify(full)
      )
      const zero = balanceSplit({ total_balance: '0', granted_balance: '0', topped_up_balance: '0' })
      check('balanceSplit：真的为 0 时给 0（不是 null）', zero.grantedBalance === 0 && zero.toppedBalance === 0, JSON.stringify(zero))
      const missing = balanceSplit({ total_balance: '5' })
      check(
        'balanceSplit：字段缺失给 null（与 0 区分）',
        missing.grantedBalance === null && missing.toppedBalance === null,
        JSON.stringify(missing)
      )
      const junk = balanceSplit({ granted_balance: 'abc', topped_up_balance: null })
      check('balanceSplit：非法值 / null 一律 null，不抛异常', junk.grantedBalance === null && junk.toppedBalance === null, JSON.stringify(junk))
      check('balanceSplit：空入参不抛异常', JSON.stringify(balanceSplit(undefined)) === '{"grantedBalance":null,"toppedBalance":null}', '')
    }
    check(
      'pickBalanceInfo：缺 total_balance 不当数（跳到下一项）',
      pb([{ currency: 'CNY' }, { currency: 'USD', total_balance: 1 }]) === 'USD:1',
      pb([{ currency: 'CNY' }, { currency: 'USD', total_balance: 1 }])
    )
  }

  {
    // 套餐扣费轮的「余额口径」（plan-balance.turnPlanUsage）：套餐行按 tokens
    // 全行求和、百分比与主显示同基数；混合轮的真金白银只含非套餐行
    const savedBase = process.env.ZCODE_DATA_BASE_DIR
    process.env.ZCODE_DATA_BASE_DIR = tmpHome
    try {
      const plan = readPlanBalance()
      const bucket = quotaBucketForModel(plan, 'GLM-5.3-Flash')
      check(
        'quotaBucketForModel：模型名归一匹配到 100M 桶',
        !!bucket && bucket.totalUnits === 100_000_000 && bucket.remainingUnits === 90_000_000,
        JSON.stringify(bucket)
      )
      check(
        'quotaBucketForModel：对不上的模型返回 null',
        quotaBucketForModel(plan, 'totally-unknown-9000') === null,
        JSON.stringify(quotaBucketForModel(plan, 'totally-unknown-9000'))
      )
      const mixedTurn = {
        models: [
          { model: 'GLM-5.3-Flash', providerId: 'account:zai-start-plan', tokens: 550_000, amount: 4.2, currency: 'CNY', billable: true },
          { model: 'deepseek-flash', providerId: 'deepseek-test', tokens: 330_000, amount: 3.21, currency: 'CNY', billable: true },
        ],
      }
      const pu = turnPlanUsage(mixedTurn)
      check(
        'turnPlanUsage：混合轮只算套餐行 tokens（550k/104M = 0.53%）',
        pu && pu.planTurn === true && pu.tokens === 550_000 && Math.abs(pu.pctOfTotal - 0.53) < 0.005,
        JSON.stringify(pu)
      )
      check(
        'turnPlanUsage：占桶百分比同基数（550k/100M = 0.55%）',
        pu && Math.abs(pu.pctOfBucket - 0.55) < 0.005,
        JSON.stringify(pu && { pctOfBucket: pu.pctOfBucket })
      )
      const ex = extraAmountsOfTurn(mixedTurn)
      check(
        'extraAmountsOfTurn：套餐行被剔除，只留真金白银',
        ex && ex.CNY === 3.21 && Object.keys(ex).length === 1,
        JSON.stringify(ex)
      )
      const onlyPlan = { models: [mixedTurn.models[0]] }
      const pu2 = turnPlanUsage(onlyPlan)
      check(
        'turnPlanUsage：纯套餐轮无混合金额（extraAmounts=null）',
        pu2 && pu2.planTurn === true && extraAmountsOfTurn(onlyPlan) === null,
        JSON.stringify(pu2)
      )
      check(
        'turnPlanUsage：非套餐轮返回 null（不冒充套餐口径）',
        turnPlanUsage({ models: [mixedTurn.models[1]] }) === null,
        'null'
      )
    } finally {
      if (savedBase === undefined) delete process.env.ZCODE_DATA_BASE_DIR
      else process.env.ZCODE_DATA_BASE_DIR = savedBase
    }
  }

  {
    // 余额校正公式（effectiveTodayUsage）：起点 + 到账 − 非调用扣减 − 当前余额。
    // 自检环境没有真实余额观测，先落一本带 dayOpening/lastBalance 的账本再走真实 POST
    const ledgerFile = path.join(dataDir, 'usage-ledger.json')
    fs.writeFileSync(
      ledgerFile,
      JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        lastBalance: 80,
        lastCurrency: 'CNY',
        todayUsage: 0,
        history: {},
        keyFingerprint: 'fixture-ledger',
        dayOpening: 100,
        credits: 0,
        otherDebits: 0,
        correctedAt: null,
        pendingCredit: 5,
        needsReview: true,
        previousBooks: [],
      }),
      'utf8'
    )
    const post = (body) =>
      fetch('http://127.0.0.1:' + port + '/whale/balance-adjustments.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json())
    const fix1 = await post({ credits: 5, otherDebits: 3 })
    check(
      '余额校正公式：起点 100 + 到账 5 − 扣减 3 − 当前 80 = 22',
      fix1 && fix1.ok === true && fix1.todayUsage === 22 && fix1.needsReview === false,
      JSON.stringify(fix1)
    )
    const fix2 = await post({ credits: 1, otherDebits: 0 })
    check(
      '余额校正公式：重复校正按新参数重算（100 + 1 − 0 − 80 = 21）',
      fix2 && fix2.ok === true && fix2.todayUsage === 21,
      JSON.stringify(fix2)
    )
  }

  {
    // 账本状态机（审查 P2-3：recordLedgerUsage / freshDay / effectiveTodayUsage 此前
    // 零覆盖）。这几个函数把 LEDGER_FILE 绑死在 ZCODE_HOME 上、findApiKey 又会读
    // 真实配置——所以用 spawnSync 起一个 ZCODE_HOME 指向独立目录的子进程，在里面
    // 按顺序跑完整场景（开户 → 降 → 升 → 校正 → 校正后再消费 → 跨天 → 换币种 →
    // 换 key），把每步的账本快照吐回来断言。
    const lab = path.join(tmpHome, 'ledger-lab')
    fs.mkdirSync(path.join(lab, 'whale'), { recursive: true })
    const balUrl = 'file:///' + path.join(PLUGIN_ROOT, 'lib', 'balance.mjs').replace(/\\/g, '/')
    const labScript = [
      "import fs from 'node:fs'",
      "import path from 'node:path'",
      "import { recordLedgerUsage, applyBalanceCorrection, balanceAdjustmentSummary } from '" + balUrl + "'",
      "const file = path.join(process.env.ZCODE_HOME, 'whale', 'usage-ledger.json')",
      "const cfg = path.join(process.env.ZCODE_HOME, 'whale', 'config.json')",
      "const snap = () => { const l = JSON.parse(fs.readFileSync(file, 'utf8')); return { lastBalance: l.lastBalance, todayUsage: l.todayUsage, dayOpening: l.dayOpening, pendingCredit: l.pendingCredit, needsReview: l.needsReview === true, lastCurrency: l.lastCurrency, history: l.history, books: (l.previousBooks || []).length } }",
      "const out = []",
      "fs.writeFileSync(cfg, JSON.stringify({ apiKey: 'key-a' }))",
      "recordLedgerUsage(50, 'CNY'); out.push({ step: 'open', ...snap() })",
      "recordLedgerUsage(45, 'CNY'); out.push({ step: 'down', ...snap() })",
      "recordLedgerUsage(55, 'CNY'); out.push({ step: 'up', ...snap() })",
      "out.push({ step: 'correct', todayUsage: applyBalanceCorrection(10, 0).todayUsage })",
      "recordLedgerUsage(40, 'CNY'); out.push({ step: 'spend-after-correct', ...snap(), formula: balanceAdjustmentSummary().todayUsage })",
      "const led = JSON.parse(fs.readFileSync(file, 'utf8'))",
      "led.date = '2000-01-01'; led.todayUsage = 33; led.credits = 0; led.correctedAt = null",
      "fs.writeFileSync(file, JSON.stringify(led, null, 2))",
      "recordLedgerUsage(35, 'CNY'); out.push({ step: 'day-roll', ...snap() })",
      "recordLedgerUsage(30, 'USD'); out.push({ step: 'currency', ...snap() })",
      "fs.writeFileSync(cfg, JSON.stringify({ apiKey: 'key-b' }))",
      "recordLedgerUsage(28, 'CNY'); out.push({ step: 'key-change', ...snap() })",
      "console.log('LEDGER_LAB:' + JSON.stringify(out))",
    ].join('\n')
    const scriptFile = path.join(lab, 'lab.mjs')
    fs.writeFileSync(scriptFile, labScript, 'utf8')
    const run = spawnSync(process.execPath, [scriptFile], {
      encoding: 'utf8',
      env: { ...process.env, ZCODE_HOME: lab, DEEPSEEK_API_KEY: '' },
    })
    let steps = []
    try {
      steps = JSON.parse(((run.stdout || '').split('LEDGER_LAB:').pop() || '[]').trim())
    } catch (err) {}
    const by = (s) => steps.find((x) => x.step === s) || {}
    check(
      '账本状态机：开户建本（dayOpening=50）→ 降计消费（todayUsage=5）→ 升记待核对（pendingCredit=55−45=10，不冲减）',
      by('open').dayOpening === 50 && by('open').todayUsage === 0 &&
        by('down').todayUsage === 5 && by('down').lastBalance === 45 &&
        by('up').pendingCredit === 10 && by('up').needsReview === true && by('up').todayUsage === 5,
      JSON.stringify({ steps, err: (run.stderr || '').slice(0, 300) })
    )
    check(
      '账本状态机：校正公式（50 + 10 − 0 − 55 = 5）→ 校正后当日再消费按公式重算（50 + 10 − 0 − 40 = 20）',
      by('correct').todayUsage === 5 && by('spend-after-correct').formula === 20 && by('spend-after-correct').lastBalance === 40,
      JSON.stringify({ steps })
    )
    check(
      '账本状态机：跨天把旧日余额归档进 history、新本从新基准起算；换币种只重置基准不记差值',
      by('day-roll').history && by('day-roll').history['2000-01-01'] === 33 && by('day-roll').todayUsage === 0 && by('day-roll').dayOpening === 35 &&
        by('currency').lastCurrency === 'USD' && by('currency').lastBalance === 30 && by('currency').todayUsage === 0,
      JSON.stringify({ steps })
    )
    check(
      '账本状态机：换 key 整本归档（previousBooks +1）并另起新本',
      by('key-change').books === 1 && by('key-change').todayUsage === 0 && by('key-change').lastBalance === 28 && by('key-change').dayOpening === 28,
      JSON.stringify({ steps })
    )
  }

  {
    // ZCode 主题映射（纯函数）：zai 皮肤 → 浅/深，system/auto/缺失 → system
    check(
      'mapZcodeTheme：zai-light/zai-dark 映射浅/深',
      mapZcodeTheme('zai-light') === 'light' && mapZcodeTheme('zai-dark') === 'dark' && mapZcodeTheme('LIGHT') === 'light',
      mapZcodeTheme('zai-dark')
    )
    check(
      'mapZcodeTheme：system/auto/缺失/垃圾值回 system',
      mapZcodeTheme('system') === 'system' && mapZcodeTheme('auto') === 'system' && mapZcodeTheme(null) === 'system' && mapZcodeTheme('hacker') === 'system',
      'system'
    )
    check(
      'themeOfConfig：只认 ui.theme 字符串',
      themeOfConfig({ ui: { theme: 'dark' } }) === 'dark' && themeOfConfig({}) === null && themeOfConfig({ ui: { theme: '  ' } }) === null,
      JSON.stringify(themeOfConfig({ ui: { theme: 'dark' } }))
    )
    // 三层判定（v1.7.2）：观测（ZCode 窗口 DWM 暗色标志）> 配置 > 系统
    const tnow = Date.now()
    check(
      'resolveZcodeTheme：新鲜观测压过配置（ZCode 实际暗色 + 配置写浅色 → dark）',
      resolveZcodeTheme({ dark: 1, at: tnow }, 'light') === 'dark' && resolveZcodeTheme({ dark: 0, at: tnow }, 'dark') === 'light',
      resolveZcodeTheme({ dark: 1, at: tnow }, 'light')
    )
    check(
      'resolveZcodeTheme：过期观测不算数（回落配置映射）',
      resolveZcodeTheme({ dark: 1, at: tnow - 48 * 3600_000 }, 'zai-light') === 'light',
      resolveZcodeTheme({ dark: 1, at: tnow - 48 * 3600_000 }, 'zai-light')
    )
    check(
      'resolveZcodeTheme：无观测走配置、配置缺失回 system',
      resolveZcodeTheme(null, 'zai-dark') === 'dark' && resolveZcodeTheme(undefined, null) === 'system',
      'dark / system'
    )
    check(
      'resolveZcodeTheme：观测缺 at 视为新鲜（跟随脚本只在变化时写）',
      resolveZcodeTheme({ dark: 0 }, 'dark') === 'light',
      resolveZcodeTheme({ dark: 0 }, 'dark')
    )
  }

  {
    // 镜像地址白名单（safeMirrorUrl）：形态 + 主机双重校验，不干净一律回落默认。
    // 这是「拉工具时会去请求的 URL」，与出站硬约束同口径拒环回/私有/保留地址。
    const FB = 'FALLBACK'
    check(
      '镜像白名单：规范 https 地址放行（含路径/端口）',
      safeMirrorUrl('https://registry.npmmirror.com', FB) === 'https://registry.npmmirror.com' &&
        safeMirrorUrl('https://npmmirror.com/mirrors/electron/', FB) === 'https://npmmirror.com/mirrors/electron/' &&
        safeMirrorUrl('http://1.2.3.4:4873/mirror/', FB) === 'http://1.2.3.4:4873/mirror/',
      safeMirrorUrl('https://registry.npmmirror.com', FB)
    )
    check(
      '镜像白名单：shell 元字符/引号/空白被拒',
      safeMirrorUrl('https://registry.npmmirror.com&calc.exe', FB) === FB &&
        safeMirrorUrl('https://registry.npmmirror.com/x";calc', FB) === FB &&
        safeMirrorUrl('https://registry.npmmirror.com/x y', FB) === FB &&
        safeMirrorUrl('file:///etc/passwd', FB) === FB &&
        safeMirrorUrl('', FB) === FB,
      'FALLBACK'
    )
    check(
      '镜像白名单：环回/私有/localhost 主机被拒（与出站硬约束同口径）',
      safeMirrorUrl('http://127.0.0.1:4873', FB) === FB &&
        safeMirrorUrl('http://10.0.0.1:4873', FB) === FB &&
        safeMirrorUrl('http://192.168.1.5/npm', FB) === FB &&
        safeMirrorUrl('http://localhost:4873', FB) === FB,
      'FALLBACK'
    )
  }

  {
    // ---------- 跨产品线浮层互杀回归（2026-10-14 真机事故） ----------
    // 事故：单例判定用插件名子串 `*zcode-fox-widget*`，而 WorkBuddy 版的浮层若从
    // worktree 启动，路径里正好含这个子串（...\Worktrees\zcode-fox-widget\main-<sha>\desktop）
    // → 我们把对方的浮层当重复实例杀掉（对方用 `fox-widget` 标记时是同一个坑的镜像）。
    // 现在的判据是「命令行是否含本插件运行时的 electron dist 目录」。
    // 完整证据链见仓库根 BUGREPORT-CROSS-LINE-OVERLAY-KILL.md。
    const markerDir = path.join(runtimePaths().runtimeDir, 'node_modules', 'electron', 'dist')
    const exe = path.join(markerDir, process.platform === 'win32' ? 'electron.exe' : 'electron')
    const ownRuntime = exe
    const ownCache = exe + ' C:\\Users\\u\\.zcode\\cli\\plugins\\cache\\zcode-fox-local\\zcode-fox-widget\\1.0.0\\desktop'
    const ownRepo = exe + ' C:\\Users\\u\\.zcode\\cli\\plugins\\marketplaces\\zcode-fox-widget\\desktop'
    // WorkBuddy 版的运行时在它自己的插件数据目录下，与我们的绝不相交
    const wbExe =
      'C:\\Users\\u\\.workbuddy\\plugins\\data\\fox-widget-fox-local\\desktop-runtime\\node_modules\\electron\\dist\\electron.exe'
    const wbCache = wbExe + ' C:\\Users\\u\\.workbuddy\\plugins\\cache\\fox-local\\fox-widget\\2.0.0\\desktop'
    const wbWorktree = wbExe + ' C:\\Users\\u\\WorkBuddy\\Worktrees\\zcode-fox-widget\\main-56fc9dd2\\desktop'
    check(
      '浮层亲缘判定：认自己的运行时（仓库副本 / cache 快照都算同一个）',
      isOwnOverlayCommandLine(ownRuntime) &&
        isOwnOverlayCommandLine(ownCache) &&
        isOwnOverlayCommandLine(ownRepo),
      markerDir
    )
    check(
      '浮层亲缘判定：不认 WorkBuddy 的浮层（cache 形态）',
      !isOwnOverlayCommandLine(wbCache),
      wbCache.slice(0, 60)
    )
    check(
      '浮层亲缘判定：不认 WorkBuddy 的浮层（worktree 形态——旧子串判据正是在这里误杀）',
      !isOwnOverlayCommandLine(wbWorktree) && wbWorktree.indexOf('zcode-fox-widget') !== -1,
      '旧判据会误杀：命令行含 zcode-fox-widget 子串=' + (wbWorktree.indexOf('zcode-fox-widget') !== -1)
    )
    check(
      '浮层亲缘判定：空/无命令行不误判（PowerShell 失败时宁可不识别也不盲杀）',
      !isOwnOverlayCommandLine('') && !isOwnOverlayCommandLine(null) && !isOwnOverlayCommandLine('electron.exe --type=gpu-process')
    )
    check(
      '浮层亲缘判定：Windows 忽略路径大小写，POSIX 保持大小写敏感',
      isOwnOverlayCommandLine(exe.replace(/\\/g, '/').toUpperCase()) === (process.platform === 'win32'),
      process.platform
    )
  }

  {
    // 台词包/rua 的角色边界（源码级：台词包和出厂队列都在 widget.js 的 IIFE 里，
    // 没有模块导出；行为侧由 smoke-ui 的「大肥鱼默认队列」用例覆盖）。
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'widget.js'), 'utf8')
    const count = (needle) => (src.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
    check(
      '台词池：三条新鲸鱼台词在 quotes 与 pool 各一份',
      count('dsv4.1-1017已发布，亿万鲸子必须崛起...') === 2 &&
        count('我要吃白饭！我要吃——白——饭——！') === 2 &&
        count('鲸鱼的斩杀线已经到达了极限') === 2,
      JSON.stringify({
        dsv: count('dsv4.1-1017已发布，亿万鲸子必须崛起...'),
        rice: count('我要吃白饭！我要吃——白——饭——！'),
        slay: count('鲸鱼的斩杀线已经到达了极限'),
      })
    )
    check(
      '台词池：哦鲸鲸只留大肥鱼，其余五个角色 ohh 为空',
      count("ohh: ''") === 5 && count("ohh: '哦鲸鲸... '") === 1 && count("var ohh = String(pack.ohh || '').trim()") === 1,
      JSON.stringify({ empty: count("ohh: ''"), whale: count("ohh: '哦鲸鲸... '") })
    )
    check(
      '台词池：嘎啦嘛的免费鸡蛋换词（quotes / pool 各一份，旧句不再出现）',
      count('免费鸡蛋，刚出炉的免费鸡蛋有人要吗') === 2 && count('你说免费鸡蛋啊...最近卖完了...') === 0,
      JSON.stringify({
        next: count('免费鸡蛋，刚出炉的免费鸡蛋有人要吗'),
        old: count('你说免费鸡蛋啊...最近卖完了...'),
      })
    )
    check(
      '台词池：kimi 换 K3.1 句并新增两句（只进 quotes，pool 自动派生）',
      count('科研K3.1中...') === 0 &&
        count('零地址指令，你的索塔通用语言模型5.5还未释放，英雄联盟') === 1 &&
        count('我坐好了，谁能告诉我10月24日0时发生了什么') === 1 &&
        count('正在生成3D建模中...') === 1,
      JSON.stringify({
        old: count('科研K3.1中...'),
        zero: count('零地址指令，你的索塔通用语言模型5.5还未释放，英雄联盟'),
        sit: count('我坐好了，谁能告诉我10月24日0时发生了什么'),
        model3d: count('正在生成3D建模中...'),
      })
    )
    check(
      '菜单顺序：浮层里「位置与行为」排在跟随延迟下方、用量记录上方',
      src.indexOf('else rows.push(rPet, r10, rMore)') !== -1 &&
        src.indexOf('rows.push(rUsage, sep2, rBook)') !== -1,
      JSON.stringify({
        afterFollow: src.indexOf('else rows.push(rPet, r10, rMore)') !== -1,
        beforeUsage: src.indexOf('rows.push(rUsage, sep2, rBook)') !== -1,
      })
    )
    check(
      '默认位置：配置角落与本域记忆不同时按跨域变更处理（issue #11 回归绊线）',
      src.indexOf('cornerChangedFromConfig = incomingCorner !== defaultCorner') !== -1 &&
        src.indexOf('if (cornerChangedFromConfig && !layoutTouched)') !== -1,
      JSON.stringify({
        detect: src.indexOf('cornerChangedFromConfig = incomingCorner !== defaultCorner') !== -1,
        apply: src.indexOf('if (cornerChangedFromConfig && !layoutTouched)') !== -1,
      })
    )
    check(
      '位置记忆：恢复之前不落盘（浮层隐身期重载不会用初始摆位覆盖 POS_KEY，issue #11 回归绊线）',
      src.indexOf('if (!positionRestored) return') !== -1 &&
        src.indexOf('if (!positionRestored) return') < src.indexOf('v:2 = 净距离格式'),
      JSON.stringify({
        guard: src.indexOf('if (!positionRestored) return') !== -1,
      })
    )
    check(
      'rua：角色门控只留大肥鱼/小克，出厂队列按角色增删 C 变体',
      /roleId === 'whale' \|\| roleId === 'xiaoke'/.test(src) &&
        /if \(allowRua\) variants\.push\(\{ w: 5, modules: \[\{ type: 'img', img: 'rua', size: 'A' \}\] \}\)/.test(src) &&
        /variants\.splice\(ruaIdx, 1\)/.test(src) &&
        /w: allowRua \? 45 : 50/.test(src) &&
        /randVar\.w = 50/.test(src),
      'allowRua/同步片段=' + [/allowRuaForRole/.test(src), /variants\.splice\(ruaIdx, 1\)/.test(src)].join(',')
    )
  }

  {
    // 平台用量接口 URL（纯函数）：start=当日零点（秒）、end=+24h、tz=偏移秒数
    check(
      '平台用量 URL：start/end/tz 拼装正确',
      platformUsageUrl(1790000000, 1790086400, 28800) ===
        'https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=1790000000&end=1790086400&tz=28800',
      platformUsageUrl(1790000000, 1790086400, 28800)
    )
    check(
      '平台用量 URL：小数参数向下取整（floor 语义，接口只认整数秒）',
      platformUsageUrl(1790000000.9, 1790086400.2, -18000.5).endsWith('?start=1790000000&end=1790086400&tz=-18001'),
      platformUsageUrl(1790000000.9, 1790086400.2, -18000.5)
    )
  }

  {
    // ZCode 启动看门进程的纯逻辑 / 安装器：不碰真实 Startup 文件夹
    const watchDir = fs.mkdtempSync(path.join(tmpHome, 'watch-startup-'))
    try {
      const vbs = buildWatchVbs('C:\\Program Files\\node.exe', 'C:\\A B\\zcode-watch.mjs')
      check('watch VBS：路径含空格时引号正确双写', vbs.includes('""C:\\Program Files\\node.exe"" ""C:\\A B\\zcode-watch.mjs"" --daemon'), vbs)
      const a = installWatch({ startupDir: watchDir, nodeExe: 'C:\\Program Files\\node.exe', script: 'C:\\A B\\zcode-watch.mjs' })
      check('watch 安装：写 Startup VBS', !!(a.ok && a.changed && fs.existsSync(a.file)), JSON.stringify(a))
      const b = installWatch({ startupDir: watchDir, nodeExe: 'C:\\Program Files\\node.exe', script: 'C:\\A B\\zcode-watch.mjs' })
      check('watch 安装：内容相同时不重复写', !!(b.ok && !b.changed), JSON.stringify(b))
      const st = watchStatus({ startupDir: watchDir })
      check('watch 状态：识别到已安装', st.installed === true, JSON.stringify(st))
      const u = uninstallWatch({ startupDir: watchDir, stopWatcher: false })
      check('watch 卸载：删除 Startup VBS', !!(u.removed && !fs.existsSync(a.file)), JSON.stringify(u))

      const envFile = path.join(watchDir, 'runtime-env.json')
      fs.writeFileSync(envFile, JSON.stringify({ ZCODE_DATA_BASE_DIR: 'E:\\ZCodeData' }))
      const env = {}
      const loaded = loadRuntimeEnv(env, envFile)
      check('watch 环境：登录时恢复 ZCODE_DATA_BASE_DIR', loaded.loaded && env.ZCODE_DATA_BASE_DIR === 'E:\\ZCodeData', JSON.stringify({ loaded, env }))
      const keep = { ZCODE_DATA_BASE_DIR: 'X' }
      loadRuntimeEnv(keep, envFile)
      check('watch 环境：已有变量优先，不覆盖', keep.ZCODE_DATA_BASE_DIR === 'X', JSON.stringify(keep))

      const { parseTasklistOutput } = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'zcode-watch.mjs')).href)
      check('watch 探测：tasklist 无任务是 absent', parseTasklistOutput('INFO: No tasks are running which match the specified criteria.') === false)
      check('watch 探测：tasklist 有 ZCode.exe 是 present', parseTasklistOutput('ZCode.exe 1234 Console 1 100,000 K') === true)

      const dry = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'zcode-watch.mjs'), '--dry-run'], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        env: { ...process.env, ZCODE_HOME: tmpHome, ZCODE_DATA_BASE_DIR: tmpHome },
      })
      let dryJson = null
      try {
        dryJson = JSON.parse(dry.stdout)
      } catch (err) {}
      check(
        'watch --dry-run：只探测不启动，返回 JSON',
        dry.status === 0 && dryJson && typeof dryJson.zcodeRunning === 'boolean',
        JSON.stringify({ status: dry.status, stdout: String(dry.stdout || '').slice(0, 200), stderr: String(dry.stderr || '').slice(0, 200) })
      )
    } finally {
      try {
        fs.rmSync(watchDir, { recursive: true, force: true })
      } catch (err) {}
    }
  }

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

