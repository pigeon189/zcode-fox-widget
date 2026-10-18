// 自检：在不触碰用户真实数据的前提下，端到端验证「每轮对话消耗」链路。
//
// 做法是把 CODEBUDDY_HOME / FOX_WIDGET_DATA_DIR 指向临时目录，在里面伪造一个
// 最小化的 WorkBuddy 会话库（workbuddy.db 的 sessions / session_usage 两张表 +
// projects/<slug>/<sid>.jsonl 的 transcript），再拉起一个挂件服务实例，然后往
// transcript 里追加新的已完成轮次，观察 /whale/last-turn.json 的 seq 是否递增、
// credit 是否与宿主记的 credit_json 一致。顺带验证 health、主题、钩子、角色、
// 泡泡等接口。
//
// 【弹泡时机】WB 的积分是**逐次模型调用就预先落账**的，所以服务端只在「轮次
// 推进」时弹**上一轮**（刚开跑的这轮先不弹，否则气泡会在回复刚出首字时就弹、
// 数字也只是第一笔）。每个被断言的轮次后面都跟一个 credit=0 的触发轮，把它
// 推成"上一轮"；断言改为认 `turn === 'turn_X'` 而不是具体 seq 值。
//
// 口径红线（承 HANDOFF §7.2.2）：WorkBuddy 的 rawUsage.prompt_tokens **包含**
// 缓存命中、completion_tokens **包含**思考；自算等价市值必须复用 usageFromRawUsage
// 的映射（交给 pricing 的 splitInputTokens 拆分），否则缓存那 99% 会被按未命中价
// 重复计费，金额虚高十几倍。
//
//   node tools/selftest.mjs
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 浮层的 desktop/*.cjs 是 CommonJS（Electron 主进程），从 ESM 自检里 require 进来测
const requireCjs = createRequire(import.meta.url)

// —— 隔离必须在 import 任何 lib/*.mjs 之前完成 ——
// lib/host.mjs 的 HOST_HOME / PLUGIN_DATA_DIR 在 import 时求值，晚一步就会写到
// 用户真实数据目录（~/.workbuddy 有正在跑的 WAL 库）。所以这里先设环境变量，
// 再动态 import lib 模块（与 selftest-update.mjs 同法）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-selftest-'))
const dataDir = path.join(tmpHome, 'plugin-data')
fs.mkdirSync(dataDir, { recursive: true })
process.env.CODEBUDDY_HOME = tmpHome
process.env.FOX_WIDGET_DATA_DIR = dataDir
// 版本自检会向镜像发真实请求：测试环境整个关掉（见 lib/update.mjs 的 startAutoCheck）
process.env.WHALE_DISABLE_UPDATE_CHECK = '1'

const { DatabaseSync } = await import('node:sqlite')
const { costOfUsage, priceFor, isPeakTime, nextPeakChange, resolveVendor, resolvePricing, normalizeModelId } = await import('../lib/pricing.mjs')
// plan-balance 在 WorkBuddy 分支已冻结：只保留两个出口（readPlanBalance/turnPlanUsage），
// 恒返回「宿主无此项」。GLM Plan 日志解析相关的断言在本文件里已按迁移要求删除。
const { readPlanBalance, turnPlanUsage } = await import('../lib/plan-balance.mjs')
const { getPath, TEMPLATES, fetchFromTemplate, pickVendorBalance, listVendorStatus } = await import('../lib/vendors.mjs')
const { isBlockedHost } = await import('../lib/blocked-host.mjs')
const { matchTemplateId, buildProviderEntries, invalidateDiscoverCache } = await import('../lib/discover.mjs')
const { balanceSplit, computeTodayUsage, resolveTodayUsage, pickBalanceInfo, platformUsageUrl } = await import('../lib/balance.mjs')
const { mapHostTheme, themeOfPreferences, resolveHostTheme } = await import('../lib/host-theme.mjs')
const { safeMirrorUrl, overlaySpawnEnv, overlayStopOutcome, stopOverlay } = await import('../lib/overlay.mjs')
const { MODEL_ROLE_RULES, roleIdForModel, BUILTIN_ROLES } = await import('../lib/paths.mjs')
const { findApiKey, readPluginConfig } = await import('../lib/credentials.mjs')
const { resolveBillingSource, isNightOffpeak, resolveHostBillingSource } = await import('../lib/source.mjs')
const { readLatestTurn, resolveSession, readContextUsage, usageFromRawUsage, CREDIT_CURRENCY } = await import('../lib/turn-cost.mjs')

// ---------- 宿主侧凭据候选位 fixture（discover.mjs 扫描的地方） ----------
// WorkBuddy 没有 ZCode 的 provider_config.json / zcode-builtin.json 模板继承；
// discover 改为扫 settings.json 的 env / pluginConfigs 与 plugins/data/*/config.json。
fs.writeFileSync(
  path.join(tmpHome, 'settings.json'),
  JSON.stringify({
    env: {},
    pluginConfigs: {
      'bigmodel-connector': {
        options: {
          apiKey: 'selftest-fake-bigmodel-key',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          providerId: 'bigmodel-standard-api',
        },
      },
    },
  }),
  'utf8'
)
fs.mkdirSync(path.join(tmpHome, 'plugins', 'data', 'enc-plugin'), { recursive: true })
fs.writeFileSync(
  path.join(tmpHome, 'plugins', 'data', 'enc-plugin', 'config.json'),
  JSON.stringify({ apiKey: 'enc:v1:selftest-ciphertext-not-a-key', baseUrl: 'https://api.deepseek.com/anthropic' }),
  'utf8'
)

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

// ---------- WorkBuddy 会话库 fixture ----------
// workbuddy.db：sessions（当前会话/模型）+ session_usage（上下文占用 + 每请求积分）。
const db = new DatabaseSync(path.join(tmpHome, 'workbuddy.db'))
db.exec(`
  CREATE TABLE sessions (
    id text primary key,
    cwd text,
    model text,
    title text,
    custom_title text,
    updated_at integer,
    last_activity_at integer,
    is_background_automation integer default 0,
    deleted_at integer
  );
  CREATE TABLE session_usage (
    session_id text primary key,
    used integer,
    size integer,
    updated_at integer,
    credit_json text
  );
`)

const SESSION = 'sess_selftest'
const MODEL = 'deepseek-flash'
const USAGE_B = {
  input_tokens: 1_000_000,
  output_tokens: 100_000,
  reasoning_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

// transcript：<CODEBUDDY_HOME>/projects/<slug>/<sessionId>.jsonl
const transcriptDir = path.join(tmpHome, 'projects', 'workbuddy-selftest')
fs.mkdirSync(transcriptDir, { recursive: true })
const transcriptFile = path.join(transcriptDir, SESSION + '.jsonl')

function writeSession(modelId, atMs) {
  const t = atMs || Date.now()
  db.prepare(
    'INSERT OR REPLACE INTO sessions (id, cwd, model, title, custom_title, updated_at, last_activity_at, is_background_automation, deleted_at) VALUES (?,?,?,?,?,?,?,0,NULL)'
  ).run(SESSION, 'C:/work', modelId, '自检会话', null, t, t)
}
const hostCredits = {}
function writeUsage(used, size, atMs) {
  const t = atMs || Date.now()
  db.prepare('INSERT OR REPLACE INTO session_usage (session_id, used, size, updated_at, credit_json) VALUES (?,?,?,?,?)').run(
    SESSION,
    used,
    size,
    t,
    JSON.stringify(hostCredits)
  )
}
// 一条模型调用（rawUsage 用 WorkBuddy 口径：prompt_tokens 含缓存命中、
// completion_tokens 含思考）。同一个 conversationRequestId 的多条行归并为「一轮」。
function appendCall(requestId, modelId, modelName, raw, atMs) {
  const rawUsage = {
    prompt_tokens: raw.prompt_tokens || 0,
    completion_tokens: raw.completion_tokens || 0,
    total_tokens: (raw.prompt_tokens || 0) + (raw.completion_tokens || 0),
    prompt_cache_hit_tokens: raw.prompt_cache_hit_tokens || 0,
    prompt_cache_miss_tokens:
      raw.prompt_cache_miss_tokens != null
        ? raw.prompt_cache_miss_tokens
        : Math.max(0, (raw.prompt_tokens || 0) - (raw.prompt_cache_hit_tokens || 0)),
    prompt_cache_write_tokens: raw.prompt_cache_write_tokens || 0,
    completion_thinking_tokens: raw.completion_thinking_tokens || 0,
    credit: raw.credit || 0,
  }
  const line = JSON.stringify({
    timestamp: atMs,
    type: 'function_call',
    providerData: {
      conversationRequestId: requestId,
      model: modelId,
      requestModelId: modelId,
      requestModelName: modelName || '',
      rawUsage,
    },
  })
  fs.appendFileSync(transcriptFile, line + '\n')
}
// 一轮 = 一条或多条模型调用。modelRows: [{ model, modelName, usage, credit }]；
// credit 为该轮的宿主积分合计（写进 credit_json，供 readLatestTurn 取权威值）。
function insertTurn(requestId, usage, atMs, modelRows, credit) {
  const rows = modelRows || [{ model: MODEL, modelName: 'DeepSeek-V4.1-Flash', usage, credit }]
  for (const r of rows) {
    const u = r.usage || usage
    appendCall(
      requestId,
      r.model,
      r.modelName,
      {
        prompt_tokens: u.input_tokens || 0,
        prompt_cache_hit_tokens: u.cache_read_input_tokens || 0,
        prompt_cache_miss_tokens: Math.max(0, (u.input_tokens || 0) - (u.cache_read_input_tokens || 0)),
        prompt_cache_write_tokens: u.cache_creation_input_tokens || 0,
        completion_tokens: u.output_tokens || 0,
        completion_thinking_tokens: u.reasoning_tokens || 0,
        credit: r.credit != null ? r.credit : 0,
      },
      atMs
    )
  }
  if (credit != null) {
    hostCredits[requestId] = credit
    writeUsage(50_000, 200_000, atMs)
  }
}

writeSession(MODEL, Date.now() - 120_000)
writeUsage(50_000, 200_000, Date.now() - 120_000)

// 轮次 A：服务启动时应当只做对齐，不当作"新的一轮"
const atA = Date.now() - 60_000
insertTurn('turn_A', { ...USAGE_B, input_tokens: 1, output_tokens: 1 }, atA, null, 0.5)

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

// 数据源 fixture：WorkBuddy rawUsage → pricing 形状的映射（usageFromRawUsage）。
// rawUsage 的 prompt_tokens **含**缓存命中、completion_tokens **含**思考；
// 缓存命中不得被按未命中价重复计费（「金额虚高」回归）。
{
  const at = Date.now()
  const raw = {
    prompt_tokens: 1_000_000,
    completion_tokens: 100_000,
    total_tokens: 1_100_000,
    prompt_cache_hit_tokens: 999_000,
    prompt_cache_miss_tokens: 1_000,
    prompt_cache_write_tokens: 0,
    completion_thinking_tokens: 20_000,
    credit: 7,
  }
  const usage = usageFromRawUsage(raw)
  check(
    'usageFromRawUsage：prompt 含命中（input=prompt）/ 输出扣思考 / 命中单列',
    usage.input_tokens === 1_000_000 &&
      usage.cache_read_input_tokens === 999_000 &&
      usage.output_tokens === 80_000 &&
      usage.reasoning_tokens === 20_000,
    JSON.stringify(usage)
  )
  const got = costOfUsage('deepseek-flash', usage, at)
  const p = priceFor('deepseek-flash')
  const idx = isPeakTime(Math.floor(at / 1000)) ? 1 : 0
  // 输出档要按 **completion_tokens 全额**（100_000）计：思考（20_000）也走输出价，
  // 这是 pricing.mjs 的既定口径（costOfUsage 用 t.output + t.reasoning 乘以 out 价）。
  // usageFromRawUsage 把 completion 拆成 output(80_000) + reasoning(20_000) 两栏，
  // 两者相加必须还原成 completion；断言若只算 80_000 就会少 0.02 × out。
  const expect2 = (999_000 / 1e6) * p.hit[idx] + (1_000 / 1e6) * p.miss[idx] + (100_000 / 1e6) * p.out[idx]
  const wrong = (999_000 / 1e6) * p.hit[idx] + (1_000_000 / 1e6) * p.miss[idx] + (100_000 / 1e6) * p.out[idx]
  check(
    'rawUsage → 等价市值不重复计费（缓存命中按命中价，未命中只算 miss 部分）',
    Math.abs(got.amount - expect2) < 1e-9 && Math.abs(got.amount - wrong) > 1e-6,
    '期望 ¥' + expect2.toFixed(6) + '，实际 ¥' + got.amount.toFixed(6) + '（重复计费会得到 ¥' + wrong.toFixed(6) + '）'
  )
  check(
    'rawUsage → 输出档把思考一起算进 output（completion = output + reasoning）',
    got.breakdown.output === 100_000,
    JSON.stringify(got.breakdown)
  )
  check(
    'usageFromRawUsage → breakdown 的 hit/miss 与 rawUsage 字段一致',
    got.breakdown.hit === 999_000 && got.breakdown.miss === 1_000,
    JSON.stringify(got.breakdown)
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
  // Kimi：缓存写按 TTL 计价，无 TTL 信息按默认 5min 档（k3 写价 20）
  const kimi = costOfUsage(
    'kimi-k3',
    { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000, output_tokens: 0 },
    at
  )
  check('Kimi 缓存写按默认 5min TTL 档计价', kimi.billable && Math.abs(kimi.amount - 20) < 1e-9, 'amount=' + kimi.amount)
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

// （迁移删除）GLM Plan 日志解析（shapePlanPayload 系列）与 ZCode 启动就绪判定
// （desktop/ui-ready.cjs 的 evaluateBootState）在 WorkBuddy 上没有对应物：
//   - plan-balance.mjs 已冻结，readPlanBalance() 恒返回 not-supported-on-workbuddy；
//   - desktop/ui-ready.cjs 已删除，浮层不再有「等宿主界面就绪」这道门（不再有 ZCode
//     客户端日志可尾随解析）。
// 对应覆盖改为：readPlanBalance/turnPlanUsage 的「宿主无此项」契约断言（见文件末尾），
// 以及 /whale/plan.json 端到端的 ok:false 断言。
{
  check(
    'plan-balance 冻结：readPlanBalance 恒返回 not-supported-on-workbuddy',
    (() => {
      const r = readPlanBalance()
      return r && r.ok === false && r.reason === 'not-supported-on-workbuddy' && typeof r.hint === 'string'
    })(),
    JSON.stringify(readPlanBalance())
  )
  check(
    'plan-balance 冻结：turnPlanUsage 恒返回 null（调用方走普通积分口径）',
    turnPlanUsage({ models: [{ model: 'glm-5.3', tokens: 1000, amount: 1, currency: 'CNY' }] }) === null
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
    '额度卡形状：窗口卡带 rows，余额卡带 amount，错误卡带 reason',
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

// 凭据发现：WorkBuddy 侧的候选位（settings.json env / pluginConfigs、插件数据目录
// config.json 的 apiKey / vendorKeys）。ZCode 的 provider_config.json 模板继承已不存在。
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cred-fx-'))
  const settingsFile = path.join(fx, 'settings.json')
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      env: { DEEPSEEK_API_KEY: 'selftest-fake-key-env' },
      pluginConfigs: {
        'bigmodel-connector': {
          options: { apiKey: 'selftest-fake-key-bigmodel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
        },
        'local-gw': { options: { apiKey: 'selftest-fake-key-cccc', baseUrl: 'http://127.0.0.1:11435/v1' } },
      },
    }),
    'utf8'
  )
  const pluginDataDir = path.join(fx, 'plugins-data')
  fs.mkdirSync(path.join(pluginDataDir, 'deepseek-enc'), { recursive: true })
  fs.writeFileSync(
    path.join(pluginDataDir, 'deepseek-enc', 'config.json'),
    JSON.stringify({ apiKey: 'enc:v1:selftest-ciphertext', baseUrl: 'https://api.deepseek.com/anthropic' }),
    'utf8'
  )
  fs.mkdirSync(path.join(pluginDataDir, 'mimo'), { recursive: true })
  fs.writeFileSync(
    path.join(pluginDataDir, 'mimo', 'config.json'),
    JSON.stringify({ baseUrl: 'https://token-plan-cn.xiaomimimo.com', vendorKeys: { 'xiaomi-mimo': 'selftest-fake-key-bbbb' } }),
    'utf8'
  )
  const entries = buildProviderEntries({ settingsFile, pluginDataDir, envOverride: {} })
  const byId = {}
  for (const e of entries) byId[e.providerId] = e
  check(
    '凭据发现：settings.json 的 env 块命中 DEEPSEEK_API_KEY',
    !!byId['settings-env:DEEPSEEK_API_KEY'] &&
      byId['settings-env:DEEPSEEK_API_KEY'].apiKey === 'selftest-fake-key-env' &&
      byId['settings-env:DEEPSEEK_API_KEY'].host === 'api.deepseek.com',
    JSON.stringify(Object.keys(byId))
  )
  check(
    '凭据发现：pluginConfigs.<插件>.options 的 apiKey/baseUrl 被识别',
    byId['bigmodel-connector'] &&
      byId['bigmodel-connector'].host === 'open.bigmodel.cn' &&
      byId['bigmodel-connector'].apiKey === 'selftest-fake-key-bigmodel'
  )
  check(
    '凭据发现：enc:v1: 密文跳过（不当明文 key）',
    byId['deepseek-enc'] && byId['deepseek-enc'].keyEncrypted === true && byId['deepseek-enc'].apiKey === ''
  )
  check(
    '凭据发现：插件数据目录 vendorKeys 映射模板 id（xiaomi-mimo）',
    entries.some((e) => e.templateId === 'xiaomi-mimo' && e.apiKey === 'selftest-fake-key-bbbb'),
    JSON.stringify(entries.map((e) => e.providerId))
  )
  check('凭据发现：本地网关标记 isLocal', byId['local-gw'] && byId['local-gw'].isLocal === true && byId['local-gw'].host === '127.0.0.1')

  // findApiKey：env > 插件配置 > 宿主发现的优先级。这里用环境变量做确定性断言
  //（默认路径的宿主扫描由服务段的 health.keyProbe 覆盖）。
  const savedEnvKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  try {
    check('findApiKey：环境变量优先（env:DEEPSEEK_API_KEY）', (() => {
      process.env.DEEPSEEK_API_KEY = 'sk-selftest-env'
      const r = findApiKey()
      delete process.env.DEEPSEEK_API_KEY
      return r.source === 'env:DEEPSEEK_API_KEY' && r.key === 'sk-selftest-env'
    })())
    if (readPluginConfig().apiKey) {
      check('findApiKey：插件配置 apiKey 次之（跳过：已配置）', true, 'source=plugin-config')
    } else {
      check('findApiKey：无 env/配置时回落到宿主发现或 none', (() => {
        const r = findApiKey()
        return r.source === 'host-provider' || r.source === 'none'
      })(), 'source=' + findApiKey().source)
    }
  } finally {
    if (savedEnvKey !== undefined) process.env.DEEPSEEK_API_KEY = savedEnvKey
    else delete process.env.DEEPSEEK_API_KEY
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
  // GLM 套餐用量接口（宿主无关，与 ZCode 线同源）：形状 / 窗口名 / 出站白名单。
  // 本分支的「智谱 Coding Plan」厂商卡用它当 pick —— 此前只认嵌套形状，
  // 现役 individual-coding-plan 账号一律「响应结构不符合模板」。
  {
    const { shapeQuotaPayload, windowLabel, GLM_PLAN_QUOTA_URL, GLM_PLAN_QUOTA_HOSTS } = await import('../lib/glm-plan-api.mjs')
    const { assertSafeUpstream } = await import('../lib/credentials.mjs')
    const flat = shapeQuotaPayload({
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
      !!flat &&
        flat.ok &&
        flat.source === 'glm-plan-api' &&
        flat.unit === 'credits' &&
        flat.level === 'lite' &&
        flat.windows.length === 2 &&
        flat.windows[0].label === '5 小时' &&
        flat.windows[1].label === '本周' &&
        flat.primaryWindow === '本周' &&
        flat.remaining === 158 &&
        flat.total === 2000 &&
        Math.abs(flat.percentRemaining - 0.079) < 1e-9 &&
        Math.abs(flat.percentUsed - 0.92) < 1e-9 &&
        flat.nextResetAt === 1792656212983,
      JSON.stringify(flat && { w: flat.windows, primary: flat.primaryWindow, pct: flat.percentRemaining })
    )
    const nested = shapeQuotaPayload({ data: { limits: [{ name: 'GLM-5.3', TOKENS_LIMIT: { percentage: 37.5, remaining: 62500000, total: 100000000 } }] } })
    check(
      'GLM 套餐接口：嵌套形状（TOKENS_LIMIT）照样收；认不出的响应不硬猜',
      !!nested &&
        nested.windows.length === 1 &&
        nested.windows[0].label === 'GLM-5.3' &&
        Math.abs(nested.percentRemaining - 0.625) < 1e-9 &&
        shapeQuotaPayload({ data: { limits: [] } }) === null &&
        shapeQuotaPayload(null) === null,
      JSON.stringify(nested && nested.windows)
    )
    check(
      'GLM 套餐接口：窗口名按 unit×number 归纳；出站地址过白名单（仅 https + 显式 host）',
      windowLabel(3, 5) === '5 小时' &&
        windowLabel(6, 1) === '本周' &&
        windowLabel(9, 3) === 'unit9×3' &&
        (() => {
          try {
            assertSafeUpstream(GLM_PLAN_QUOTA_URL, GLM_PLAN_QUOTA_HOSTS)
            return true
          } catch (err) {
            return false
          }
        })() &&
        (() => {
          try {
            assertSafeUpstream('http://open.bigmodel.cn/api/monitor/usage/quota/limit', GLM_PLAN_QUOTA_HOSTS)
            return false
          } catch (err) {
            return true
          }
        })(),
      GLM_PLAN_QUOTA_URL
    )
    // 厂商卡：模板直接吃同一份塑形（不出网，纯函数）
    const card = TEMPLATES['zhipu-quota'].quota.pick({
      data: { limits: [{ type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 2000, currentValue: 1841, remaining: 158, percentage: 92 }] },
    })
    check(
      '智谱 Coding Plan 卡片：窗口带剩余额度（吃平铺形状）',
      Array.isArray(card) && card.length === 1 && card[0].label === '本周' && card[0].percentUsed === 92 && card[0].remaining === 158 && card[0].total === 2000,
      JSON.stringify(card)
    )
  }
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
// 凭据发现的短 TTL 缓存（复审 N3）：默认路径 5 秒内复用，显式失效后重扫
{
  const probeDir = path.join(tmpHome, 'plugins', 'data', 'n3-cache-probe')
  fs.mkdirSync(probeDir, { recursive: true })
  const probeFile = path.join(probeDir, 'config.json')
  try {
    invalidateDiscoverCache()
    const before = buildProviderEntries()
    check('发现缓存：首次调用即全量扫描', Array.isArray(before) && !before.some((e) => e.providerId === 'n3-cache-probe'))
    fs.writeFileSync(probeFile, JSON.stringify({ baseUrl: 'https://probe.example/v1', apiKey: 'probe-key' }), 'utf8')
    const cached = buildProviderEntries()
    check(
      '发现缓存：TTL 内新增配置不重扫（前端 3 秒轮询不再全量扫描）',
      !cached.some((e) => e.providerId === 'n3-cache-probe'),
      'entries=' + cached.length
    )
    check('发现缓存：命中时返回副本（调用方改不动缓存）', cached !== buildProviderEntries() && cached.length === buildProviderEntries().length)
    invalidateDiscoverCache()
    const fresh = buildProviderEntries()
    check(
      '发现缓存：显式失效后重扫并看到新配置',
      fresh.some((e) => e.providerId === 'n3-cache-probe' && e.baseUrl === 'https://probe.example/v1'),
      'entries=' + fresh.length
    )
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true })
    invalidateDiscoverCache()
  }
}

// 用 node:http 直连（每次新建连接，不走 undici 连接池）：自检里夹着长耗时的
// spawnSync（更新内核单测 ~15s）与大段 sleep，全局 fetch 的连接池会拿到被服务端
// keepAliveTimeout 关掉的死连接而报 ECONNRESET（服务其实活着）。
function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: 5000, headers: { connection: 'close' } },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf))
          } catch (err) {
            reject(err)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
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
      if (health && health.app === 'fox-widget') return health
    } catch (err) {}
    // 子进程已经退了就别再空等：早退多半是端口占用或启动即崩，日志里有原因
    if (child && child.exitCode !== null) return null
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

const serverEnv = {
  ...process.env,
  CODEBUDDY_HOME: tmpHome,
  FOX_WIDGET_DATA_DIR: dataDir,
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

// 【免费模型端到端的夹具】（2026-10-14 审查 P1-1：免费轮的气泡链路此前零覆盖，
// 且字段在服务端被丢、分支被 billable===false 遮蔽，功能实际不生效）
// 在服务启动**前**写入宿主商品配置快照：step-5-preview 倍率 x0.00 + 官方促销
// 「独家限免」。savedAt 故意取很早 —— 后面 hostModelInfo 的用例会写入自己的
// 快照（savedAt=now），host-models 取**最新**快照，届时以它为准；它删掉快照后
// 又回落到这份。两边断言互不干扰。
{
  const scoped = path.join(tmpHome, 'storage', 'user-e2e-free', 'scoped', 's1')
  fs.mkdirSync(scoped, { recursive: true })
  fs.writeFileSync(
    path.join(scoped, 'wb-product-config.json'),
    JSON.stringify({
      'product-config-snapshot': {
        savedAt: Date.UTC(2026, 0, 1),
        data: {
          models: [{ id: 'step-5-preview', credits: 'x0.00' }],
          modelPromotions: [
            {
              id: 'free-e2e',
              kind: 'discount',
              enabled: true,
              priority: 100,
              modelIds: ['step-5-preview'],
              badge: { label: '独家限免' },
              discount: { factor: 0 },
            },
          ],
        },
      },
    })
  )
}
let child = spawnServer()

try {
  console.log('🐳 挂件自检（临时 CODEBUDDY_HOME=' + tmpHome + '）\n')

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
  check(
    'health：app 标识为 fox-widget（WorkBuddy 插件名）',
    health.app === 'fox-widget',
    'app=' + health.app
  )
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
      authedHealth.keyProbe.entries.some((e) => e.providerId === 'enc-plugin' && e.keyEncrypted === true),
    'keySource=' + authedHealth.keySource + ' entries=' + ((authedHealth.keyProbe && authedHealth.keyProbe.entries) || []).length
  )
  // 关于 / 自检（v1.3.3）：脱敏诊断快照
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
  // 浮层 spawn：环境清理 + profile 按端口隔离（审查 I1·U4）。行为断言，直接调真函数。
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
  // .codebuddy-plugin/marketplace.json 副本三者一致，漂移即发版漏改
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codebuddy-plugin', 'plugin.json'), 'utf8'))
  const marketplaceManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codebuddy-plugin', 'marketplace.json'), 'utf8'))
  check(
    '版本号单一来源：health = plugin.json = marketplace.json',
    health.version === pluginManifest.version && marketplaceManifest.plugins[0].version === pluginManifest.version,
    JSON.stringify({ health: health.version, plugin: pluginManifest.version, market: marketplaceManifest.plugins[0].version })
  )

  // 迁移契约（manifest）：插件名 / 钩子路径 / MCP 路径 / 市场副本 source
  check(
    'manifest 契约：.codebuddy-plugin/plugin.json 的 name/hooks/mcpServers 正确',
    pluginManifest.name === 'fox-widget' &&
      pluginManifest.hooks === './hooks/hooks.json' &&
      pluginManifest.mcpServers === './.mcp.json',
    JSON.stringify({ name: pluginManifest.name, hooks: pluginManifest.hooks, mcpServers: pluginManifest.mcpServers })
  )
  check(
    'manifest 契约：marketplace.json 的插件条目 name/source 正确（fox-widget / ./）',
    marketplaceManifest.name === 'fox-local' &&
      marketplaceManifest.plugins[0].name === 'fox-widget' &&
      marketplaceManifest.plugins[0].source === './',
    JSON.stringify({ market: marketplaceManifest.name, plugin: marketplaceManifest.plugins[0].name, source: marketplaceManifest.plugins[0].source })
  )
  // .mcp.json：MCP server 名 whale，命令 node，参数指向 ${CODEBUDDY_PLUGIN_ROOT}/lib/mcp-server.mjs
  {
    const mcpCfg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.mcp.json'), 'utf8'))
    const whale = (mcpCfg.mcpServers || {}).whale
    check(
      '.mcp.json 契约：server「whale」command=node，args 含 ${CODEBUDDY_PLUGIN_ROOT}/lib/mcp-server.mjs',
      !!whale &&
        whale.command === 'node' &&
        Array.isArray(whale.args) &&
        whale.args.some((a) => String(a).indexOf('${CODEBUDDY_PLUGIN_ROOT}/lib/mcp-server.mjs') !== -1),
      JSON.stringify(whale)
    )
  }

  // 迁移红线：lib/hooks/commands/skills/desktop/.codebuddy-plugin/.mcp.json 的**代码**
  // 里不得再出现 ZCode 的路径/环境变量字面量（注释里提到 ZCode 无所谓，所以先剥注释）。
  {
    const dirs = ['lib', 'hooks', 'commands', 'skills', 'desktop', '.codebuddy-plugin']
    const files = [path.join(PLUGIN_ROOT, '.mcp.json')]
    const walk = (dir) => {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (err) {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(full)
        } else if (e.isFile()) {
          files.push(full)
        }
      }
    }
    for (const d of dirs) walk(path.join(PLUGIN_ROOT, d))
    const stripComments = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
        .join('\n')
    const bad = []
    for (const f of files) {
      let text = ''
      try {
        text = fs.readFileSync(f, 'utf8')
      } catch (err) {
        continue
      }
      const code = stripComments(text)
      if (code.indexOf('~/.zcode') !== -1 || code.indexOf('${ZCODE_PLUGIN_ROOT}') !== -1) bad.push(path.relative(PLUGIN_ROOT, f))
    }
    check(
      '迁移红线：源码（代码部分）无 ~/.zcode 或 ${ZCODE_PLUGIN_ROOT} 字面量',
      bad.length === 0,
      bad.length ? '违规文件：' + bad.join(', ') : files.length + ' 个文件已扫描'
    )
  }
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
  // （迁移删除）Plan 日志尾窗逐级扩读测试：数据源（ZCode 客户端 billing/balance
  // 日志）在 WorkBuddy 上不存在，readLogFile 已随 plan-balance 冻结一并移除。
  // 覆盖改由上面的 readPlanBalance 冻结契约 + /whale/plan.json 端到端断言承担。

  const first = await getJson(port, '/whale/last-turn.json')
  check('启动时对齐历史轮次（seq=0，不弹旧轮次）', first.seq === 0 && first.turn === null, JSON.stringify(first))

  // —— B：单模型 DeepSeek 轮次，积分取宿主 credit_json 的权威值 ——
  // 【弹泡时机】WB 的积分逐次模型调用就落账，服务只在「轮次推进」时弹**上一轮**
  // （见 server.mjs 的 pollTurnCost：否则气泡会在本轮刚吐首字时就弹，数字也只是
  // 第一笔）。所以每个被断言的轮次后面紧跟一个 credit=0 的**触发轮**，把它推成
  // "上一轮"。触发轮 credit=0，不影响"今日积分 = 各轮之和"的总量断言。
  const atB = Date.now()
  insertTurn('turn_B', USAGE_B, atB, null, 12)
  insertTurn('turn_B_adv', USAGE_B, atB + 1500, null, 0)
  let second = null
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400))
    second = await getJson(port, '/whale/last-turn.json')
    if (second && second.turn === 'turn_B') break
  }
  check('新轮次被识别（推进到触发轮时弹出 turn_B，seq 递增）', second && second.turn === 'turn_B' && second.seq > 0, JSON.stringify(second))
  check(
    '本轮 credit 取宿主 credit_json 的权威值（currency=CREDIT，partial=false）',
    second && second.credit === 12 && second.amount === 12 && second.currency === 'CREDIT' && second.partial === false,
    'credit=' + (second && second.credit) + ' currency=' + (second && second.currency) + ' partial=' + (second && second.partial)
  )
  const expectedMarket = costOfUsage(MODEL, USAGE_B, atB).amount
  check(
    '等价市值按公开价目折算（与 usageFromRawUsage 拆分口径一致，缓存不重复计费）',
    second && Math.abs(second.marketAmount - expectedMarket) < 1e-9,
    '期望 ≈ ¥' + expectedMarket.toFixed(6) + '，实际 ' + Number(second && second.marketAmount).toFixed(6)
  )
  check('credit 明显大于 0', second && second.credit > 0, 'credit=' + (second && second.credit))
  check(
    '轮次标识与模型被带上',
    !!(second && second.turn === 'turn_B' && second.model === MODEL),
    JSON.stringify({ turn: second && second.turn, model: second && second.model })
  )
  check(
    'token 分桶正确（输出=completion，未命中=input−命中）',
    second && second.breakdown && second.breakdown.output === 100_000 && second.breakdown.hit === 0 && second.breakdown.miss === 1_000_000,
    JSON.stringify(second && second.breakdown)
  )

  // —— C：多模型轮次（同一 requestId 的两条模型调用）——逐模型明细 + 市值按行加总 ——
  const atC = Date.now()
  insertTurn(
    'turn_C',
    USAGE_B,
    atC,
    [
      { model: 'GLM-5.3-Flash', modelName: 'GLM-5.3-Flash', usage: { input_tokens: 500_000, cache_read_input_tokens: 450_000, output_tokens: 50_000 }, credit: 7 },
      { model: 'deepseek-flash', modelName: 'DeepSeek-V4.1-Flash', usage: { input_tokens: 300_000, cache_read_input_tokens: 0, output_tokens: 30_000 }, credit: 3 },
    ],
    10
  )
  insertTurn('turn_C_adv', USAGE_B, atC + 1500, null, 0)
  let third = null
  const deadlineC = Date.now() + 8000
  while (Date.now() < deadlineC) {
    await new Promise((r) => setTimeout(r, 400))
    third = await getJson(port, '/whale/last-turn.json')
    if (third && third.turn === 'turn_C') break
  }
  const glmPart = costOfUsage('GLM-5.3-Flash', { input_tokens: 500_000, cache_read_input_tokens: 450_000, output_tokens: 50_000 }, atC).amount
  const dsPart = costOfUsage('deepseek-flash', { input_tokens: 300_000, cache_read_input_tokens: 0, output_tokens: 30_000 }, atC).amount
  check(
    '多模型轮次带逐模型明细且 credit = 宿主整轮积分（10）',
    third && third.turn === 'turn_C' && third.seq > 1 && Array.isArray(third.models) && third.models.length === 2 && third.credit === 10 && third.amount === 10,
    'credit=' + (third && third.credit) + ' models=' + (third && third.models ? third.models.length : '无')
  )
  check(
    '多模型轮的等价市值按行加总（GLM + DeepSeek）',
    third && Math.abs(third.marketAmount - (glmPart + dsPart)) < 1e-9,
    '期望 ≈ ¥' + (glmPart + dsPart).toFixed(6) + '，实际 ' + Number(third && third.marketAmount).toFixed(6)
  )
  check('混合轮次的市值构成两种厂商', glmPart > 0 && dsPart > 0, 'GLM ¥' + glmPart.toFixed(4) + ' + DeepSeek ¥' + dsPart.toFixed(4))
  check(
    '缓存命中不重复计费：多模型轮 breakdown 命中单列、未命中不含缓存读',
    third && third.breakdown && third.breakdown.hit === 450_000 && third.breakdown.miss === 350_000,
    JSON.stringify(third && third.breakdown)
  )

  // —— G：GLM 单模型轮次（保证今日模型榜里有 GLM 一整轮）——
  const atG = Date.now()
  insertTurn('turn_G', { input_tokens: 200_000, output_tokens: 20_000 }, atG, [
    { model: 'GLM-5.3-Flash', modelName: 'GLM-5.3-Flash', usage: { input_tokens: 200_000, output_tokens: 20_000 }, credit: 8 },
  ], 8)
  insertTurn('turn_G_adv', { input_tokens: 50_000, output_tokens: 5_000 }, atG + 1500, null, 0)
  let thirdG = null
  const deadlineG = Date.now() + 8000
  while (Date.now() < deadlineG) {
    await new Promise((r) => setTimeout(r, 400))
    thirdG = await getJson(port, '/whale/last-turn.json')
    if (thirdG && thirdG.turn === 'turn_G') break
  }
  check(
    'GLM 单模型轮次被识别（推进后弹出 turn_G，vendor=glm）',
    thirdG && thirdG.turn === 'turn_G' && thirdG.seq > 2 && thirdG.vendor === 'glm',
    JSON.stringify({ seq: thirdG && thirdG.seq, vendor: thirdG && thirdG.vendor })
  )

  // Plan 配额端到端：WorkBuddy 无此能力，接口如实返回 ok:false（不冒充套餐口径）
  const plan = await getJson(port, '/whale/plan.json')
  check(
    'Plan 配额接口：WorkBuddy 无此项 → ok:false',
    plan && plan.ok === false && plan.reason === 'not-supported-on-workbuddy',
    JSON.stringify(plan).slice(0, 160)
  )
  check(
    '每轮消耗不带套餐口径（planTurn=false / quotaPct/planPct/extraAmounts 均为 null）',
    third && third.planTurn === false && third.quotaPct === null && third.planPct === null && third.extraAmounts === null,
    JSON.stringify({ planTurn: third && third.planTurn, quotaPct: third && third.quotaPct, extraAmounts: third && third.extraAmounts })
  )

  // 上下文余量：WorkBuddy 侧新能力（session_usage.used / size）
  const ctx = await getJson(port, '/whale/context.json')
  check(
    '上下文余量接口：used/size/pct/remaining 均正确',
    ctx && ctx.ok === true && ctx.used === 50_000 && ctx.size === 200_000 && ctx.pct === 25 && ctx.remaining === 150_000,
    JSON.stringify(ctx)
  )

  // 厂商模板端到端：自动发现命中 bigmodel 规则、跳过本地网关；无 key 的模板不可用
  const vendors = await getJson(port, '/whale/vendors.json')
  const byId = {}
  for (const v of (vendors && vendors.vendors) || []) byId[v.id] = v
  check(
    '厂商模板清单完整（原 8 家 + v1.8.0 补齐的 26 条 + gemini-plan 都在 vendors.json 里）',
    vendors &&
      vendors.ok &&
      [
        'deepseek',
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
        'gemini-plan',
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
    '自动发现命中 bigmodel 规则（key 来自 settings.json 的 pluginConfigs）',
    byId['bigmodel-glm'] && byId['bigmodel-glm'].available === true && String(byId['bigmodel-glm'].keySource || '').indexOf('plugin-config:') === 0,
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
  // （迁移删除）「Plan 模板走日志源」：zcode-plan 模板已随 plan-balance 冻结一并从
  // vendors.mjs 删除，WorkBuddy 侧无对应物。已在清单完整性断言里去掉该 id。

  // 用量记录：今日按模型聚合（积分口径）与逐轮事件。先补一轮 2 天前的历史
  // 用量，用来区分「按当天 / 按 7 天」两个模型榜：old-model 只在 7 天榜里出现，
  // 且 token 足够大，必然占据 7 天 token 榜首位。
  const atOld = Date.now() - 2 * 86400_000
  insertTurn(
    'turn_week_old',
    { input_tokens: 4_000_000, output_tokens: 1_000_000 },
    atOld,
    [
      {
        model: 'old-model',
        modelName: 'Old Model',
        usage: { input_tokens: 4_000_000, output_tokens: 1_000_000 },
        credit: 0,
      },
    ],
    0
  )
  insertTurn(
    'turn_week_old2',
    { input_tokens: 100_000, output_tokens: 50_000 },
    atOld + 1000,
    [
      {
        model: 'deepseek-flash',
        modelName: 'DeepSeek Flash',
        usage: { input_tokens: 100_000, output_tokens: 50_000 },
        credit: 2,
      },
    ],
    2
  )
  const usage = await getJson(port, '/whale/usage-records.json')
  const usageModels = usage && usage.ok ? usage.today.models.map((m) => m.model) : []
  check(
    '用量记录：今日含两个模型的聚合（GLM / DeepSeek 各一整轮）',
    usage && usage.ok && usageModels.indexOf('GLM-5.3-Flash') !== -1 && usageModels.indexOf('deepseek-flash') !== -1,
    'models=' + usageModels.join(',')
  )
  check('用量记录：口径声明为积分（unit=credit）', usage && usage.ok && usage.unit === 'credit', 'unit=' + (usage && usage.unit))
  if (usage && usage.ok) {
    // 今日积分 = turn_A + B + C + G 的宿主 credit 之和（积分是唯一主口径）
    const expectedTodayCredit = 0.5 + 12 + 10 + 8
    check(
      '用量记录：今日积分 = 各轮宿主 credit 之和',
      Math.abs(usage.today.credit - expectedTodayCredit) < 1e-9 && Math.abs(usage.today.total - expectedTodayCredit) < 1e-9,
      '期望 ' + expectedTodayCredit + ' 积分，实际 ' + usage.today.credit + '（total=' + usage.today.total + '）'
    )
    check(
      '用量记录：等价市值单列（marketAmount 与积分口径分离）',
      Number(usage.today.marketAmount) > 0 && Math.abs(Number(usage.today.marketAmount) - usage.today.credit) > 1e-9,
      'marketAmount≈¥' + Number(usage.today.marketAmount).toFixed(4) + ' credit=' + usage.today.credit
    )
    check(
      '用量记录：rankTotal（排名值合计）= 各行积分之和',
      Math.abs(Number(usage.today.rankTotal) - expectedTodayCredit) < 1e-6,
      'rankTotal=' + usage.today.rankTotal
    )
    check(
      '用量记录：逐模型行币种为 CREDIT 且 credit>0',
      usage.today.models.length > 0 && usage.today.models.every((m) => m.currency === 'CREDIT' && Number(m.credit) > 0),
      JSON.stringify(usage.today.models.map((m) => m.model + ':' + m.credit))
    )
    check(
      '用量记录：厂商汇总 byVendor（DeepSeek / GLM 各自有积分与 tokens）',
      usage.today.byVendor &&
        usage.today.byVendor.DeepSeek &&
        usage.today.byVendor.DeepSeek.tokens > 0 &&
        usage.today.byVendor.DeepSeek.credit > 0 &&
        usage.today.byVendor.GLM &&
        usage.today.byVendor.GLM.tokens > 0 &&
        usage.today.byVendor.GLM.credit > 0,
      JSON.stringify(usage.today.byVendor)
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
      '用量记录：7 天同一模型的积分大于当天（聚合了更早的用量）',
      !!weekDeep && !!todayDeep && Number(weekDeep.credit) > Number(todayDeep.credit),
      JSON.stringify({ week: weekDeep && weekDeep.credit, today: todayDeep && todayDeep.credit })
    )
    const rankOfWeek = (m) => Number(m.credit) || Number(m.market) || Number(m.amount) || 0
    const descByCredit = weekModels.every((m, i) => i === 0 || rankOfWeek(weekModels[i - 1]) >= rankOfWeek(m))
    const descByTokens = weekTokens.every((m, i) => i === 0 || Number(weekTokens[i - 1].tokens) >= Number(m.tokens))
    check(
      '用量记录：7 天两个榜各自降序，rankTotal 与积分口径同源',
      weekModels.length > 0 &&
        weekTokens.length > 0 &&
        descByCredit &&
        descByTokens &&
        Math.abs(Number(usage.days7.rankTotal) - Number(usage.days7.total)) < 1e-6,
      JSON.stringify({
        credit: weekModels.map(rankOfWeek),
        tok: weekTokens.map((m) => m.tokens),
        rankTotal: usage.days7.rankTotal,
        total: usage.days7.total,
      })
    )
  }
  check(
    '用量记录：带最近轮次列表（按轮聚合）',
    usage && usage.ok && Array.isArray(usage.turns) && usage.turns.length >= 4,
    'turns=' + (usage && usage.turns ? usage.turns.length : '无')
  )
  if (usage && usage.ok && Array.isArray(usage.turns)) {
    const turnC = usage.turns.find(
      (t) => (t.models || []).some((m) => m.model === 'GLM-5.3-Flash') && (t.models || []).some((m) => m.model === 'deepseek-flash')
    )
    check(
      '用量记录：多模型轮次归并为一条（calls=2 / models=2 / credit=10）',
      turnC && turnC.calls === 2 && turnC.models.length === 2 && Math.abs(turnC.credit - 10) < 1e-9,
      turnC ? 'calls=' + turnC.calls + ' models=' + turnC.models.length + ' credit=' + turnC.credit : '未找到含 GLM+DeepSeek 的轮次'
    )
  }

  // N1 等价回归（WorkBuddy 版）：主显示是积分（CREDIT），**不再把任何轮的金额
  // 写成货币**；同时「等价金额」附注要随模型的真实币种（OpenAI/Claude 是 USD）。
  // 插一条 OpenAI 模型轮次，走真实 CLI 与 MCP 文本路径核对，并核对 MCP 握手版本。
  const atH = Date.now()
  const H_USAGE = { input_tokens: 120_000, cache_read_input_tokens: 20_000, output_tokens: 8_000 }
  insertTurn('turn_H', H_USAGE, atH, [{ model: 'gpt-5.6-terra', modelName: 'GPT-5.6', usage: H_USAGE, credit: 5 }], 5)
  // 触发轮也用 OpenAI 模型（credit=0）：后面 CLI / MCP 的断言走 readLatestTurn()
  // 读**最新**一轮，得让最新轮仍然是 $ 计价的模型
  insertTurn('turn_H_adv', H_USAGE, atH + 1500, [{ model: 'gpt-5.6-terra', modelName: 'GPT-5.6', usage: H_USAGE, credit: 0 }], 0)
  let lastTurn = null
  const deadlineH = Date.now() + 8000
  while (Date.now() < deadlineH) {
    await new Promise((r) => setTimeout(r, 400))
    lastTurn = await getJson(port, '/whale/last-turn.json')
    if (lastTurn && lastTurn.turn === 'turn_H') break
  }
  check(
    '模型换上 OpenAI 时主口径仍是积分（currency=CREDIT，vendor=openai）',
    lastTurn && lastTurn.turn === 'turn_H' && lastTurn.seq > 3 && lastTurn.currency === 'CREDIT' && lastTurn.credit === 5 && lastTurn.vendor === 'openai',
    lastTurn ? 'seq=' + lastTurn.seq + ' currency=' + lastTurn.currency + ' vendor=' + lastTurn.vendor : '无'
  )
  const cliEnv = { ...serverEnv }
  const cliTurn = await runCli(['turn'], cliEnv)
  check(
    'CLI 每轮消耗主显示按积分（headline 出现「积分」，无货币符号）',
    cliTurn.code === 0 && /积分/.test(cliTurn.stdout) && !/[¥$]/.test(cliTurn.stdout.split('\n')[0]),
    cliTurn.stdout.split('\n').slice(0, 2).join(' | ') + (cliTurn.stderr ? ' [stderr] ' + cliTurn.stderr.slice(0, 120) : '')
  )
  check(
    'CLI 等价金额以「≈」附注（非真实扣费），且逐档单价随模型币种（$ x/M）',
    cliTurn.stdout.indexOf('等价金额') !== -1 &&
      cliTurn.stdout.indexOf('≈') !== -1 &&
      cliTurn.stdout.indexOf('缓存命中输入') !== -1 &&
      cliTurn.stdout.indexOf('× $') !== -1,
    cliTurn.stdout.split('\n').filter((l) => l.indexOf('≈') !== -1 || l.indexOf('× $') !== -1).join(' | ').slice(0, 200)
  )
  const mcpOut = await runMcp(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whale_last_turn', arguments: {} } },
    ],
    cliEnv
  )
  const mcpInit = mcpOut.find((m) => m.id === 1)
  const mcpTurn = mcpOut.find((m) => m.id === 2)
  const mcpText = mcpTurn && mcpTurn.result && mcpTurn.result.content && mcpTurn.result.content[0] ? mcpTurn.result.content[0].text : ''
  check('MCP whale_last_turn 按积分显示（出现「积分」）', mcpText && mcpText.indexOf('积分') !== -1, mcpText.split('\n').slice(0, 2).join(' | '))
  const pluginJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codebuddy-plugin', 'plugin.json'), 'utf8'))
  const mcpVersion = mcpInit && mcpInit.result && mcpInit.result.serverInfo ? mcpInit.result.serverInfo.version : null
  check(
    'MCP 握手版本号与 plugin.json 一致（单一来源）',
    mcpVersion === pluginJson.version,
    'mcp=' + mcpVersion + ' plugin.json=' + pluginJson.version
  )

  // —— F：免费模型轮（宿主促销 x0.00 + 独家限免）——
  // 端到端断言（2026-10-14 审查 P1-1：此前气泡链路零覆盖，且字段在服务端被丢、
  // 分支被 billable===false 遮蔽，功能实际不生效）。夹具见 spawnServer 之前。
  // 触发轮同模型 credit=0：把 turn_F 推成"上一轮"弹出。
  const atF = Date.now()
  const F_USAGE = { input_tokens: 60_000, cache_read_input_tokens: 50_000, output_tokens: 6_000 }
  insertTurn('turn_F', F_USAGE, atF, [{ model: 'step-5-preview', modelName: 'Step-5', usage: F_USAGE, credit: 0 }], 0)
  insertTurn('turn_F_adv', F_USAGE, atF + 1500, [{ model: 'step-5-preview', modelName: 'Step-5', usage: F_USAGE, credit: 0 }], 0)
  let freeTurn = null
  const deadlineF = Date.now() + 8000
  while (Date.now() < deadlineF) {
    await new Promise((r) => setTimeout(r, 400))
    freeTurn = await getJson(port, '/whale/last-turn.json')
    if (freeTurn && freeTurn.turn === 'turn_F') break
  }
  check(
    '免费模型轮：载荷带 free/freeLabel（宿主促销文案），credit=0 但不再退 tokens',
    freeTurn &&
      freeTurn.turn === 'turn_F' &&
      freeTurn.free === true &&
      freeTurn.freeLabel === '独家限免' &&
      freeTurn.credit === 0 &&
      freeTurn.billable === false,
    JSON.stringify(freeTurn ? { turn: freeTurn.turn, free: freeTurn.free, freeLabel: freeTurn.freeLabel, credit: freeTurn.credit } : freeTurn)
  )
  check(
    '免费模型轮：气泡分支顺序（free 分支必须在 billable===false 之前，否则永远轮不到）',
    (() => {
      const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'widget.js'), 'utf8')
      const freeAt = src.indexOf('turn.free && !(Number(turn.credit')
      const billableAt = src.indexOf('turn.billable === false')
      return freeAt !== -1 && billableAt !== -1 && freeAt < billableAt
    })(),
    '顺序=' + 'free 应在前'
  )

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
  // 今日预算（v1.3.3）：单位是积分；负数/非法归 0，超大值封顶 1e6
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

  // 版本更新内核单测：独立子进程（隔离 CODEBUDDY_HOME，避免写到真实数据目录）
  {
    const run = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'tools', 'selftest-update.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, CODEBUDDY_HOME: tmpHome, FOX_WIDGET_DATA_DIR: dataDir, WHALE_DISABLE_UPDATE_CHECK: '1' },
    })
    const m = /更新内核自检：(\d+)\/(\d+) 通过/.exec(String(run.stdout || ''))
    check(
      '版本更新内核单测全绿（版本比较 / 出站守卫 / tar 解包 / 落盘清理 / 检查回退 / 整包更新 / 防重入）',
      run.status === 0 && !!m && m[1] === m[2] && Number(m[2]) >= 28,
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

  // 钩子接线契约（WorkBuddy 版）：四个事件（SessionStart / UserPromptSubmit /
  // PostToolUse / Notification）全部是 type:"command" + bash 字符串命令（无 args、
  // 无 timeoutMs），命令里用 ${CODEBUDDY_PLUGIN_ROOT}，timeout 是**秒**数。
  {
    const hooksJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'))
    const events = Object.keys((hooksJson.hooks || {}))
    const commands = []
    let allCommandType = true
    let allNumericTimeout = true
    let allHaveRoot = true
    for (const ev of events) {
      for (const group of hooksJson.hooks[ev] || []) {
        for (const h of group.hooks || []) {
          if (h.type !== 'command' || typeof h.command !== 'string') allCommandType = false
          if (typeof h.timeout !== 'number') allNumericTimeout = false
          if (String(h.command || '').indexOf('${CODEBUDDY_PLUGIN_ROOT}') === -1) allHaveRoot = false
          commands.push(String(h.command || '').replace('node "${CODEBUDDY_PLUGIN_ROOT}/', '').replace('"', ''))
        }
      }
    }
    check(
      '钩子接线：SessionStart + 两个低频事件 UserPromptSubmit / Notification（不挂工具事件，避免每次调用加延迟）',
      events.length === 3 &&
        events.indexOf('SessionStart') !== -1 &&
        events.indexOf('UserPromptSubmit') !== -1 &&
        events.indexOf('Notification') !== -1 &&
        events.indexOf('PreToolUse') === -1 &&
        events.indexOf('PostToolUse') === -1 &&
        events.indexOf('Stop') === -1,
      events.join(',')
    )
    // 注：hooks.json 当前只挂 3 个事件（SessionStart + UserPromptSubmit + Notification）。
    // hook-event.mjs 仍然**处理** PostToolUse（见下面真跑一遍的断言），将来若把它挂上
    // 也无需改这里的事件类型断言。task 描述里的「四事件」与仓库当前 hooks.json 不一致，
    // 以 hooks/（不可改）为准。
    check(
      '钩子接线：全部 type:"command" + 字符串 command 含 ${CODEBUDDY_PLUGIN_ROOT} + 数值 timeout（秒；非 ZCode 的 type:"process"+args+timeoutMs）',
      allCommandType && allHaveRoot && allNumericTimeout,
      JSON.stringify({ allCommandType, allHaveRoot, allNumericTimeout })
    )
    check(
      '钩子接线：脚本都在仓库里（autostart.mjs / hook-event.mjs）',
      commands.some((c) => c.indexOf('lib/autostart.mjs') !== -1) &&
        commands.some((c) => c.indexOf('lib/hook-event.mjs') !== -1) &&
        commands.every((c) => fs.existsSync(path.join(PLUGIN_ROOT, c))),
      commands.join(' | ')
    )
  }

  // hook-event.mjs：真跑一遍（隔离数据目录的子进程），验状态文件与 waiting 语义。
  // WorkBuddy 没有 PermissionRequest 事件，「等确认」改由 Notification 触发。
  {
    const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-hook-'))
    // 关掉「补拉起」：这一块只验状态文件语义，不该在测试里顺手起一个真服务
    //（补拉起本身另有一块专门的断言，见下面 fox-ensure-*）。
    const hookEnv = { ...process.env, CODEBUDDY_HOME: lab, FOX_WIDGET_DATA_DIR: lab, FOX_WIDGET_NO_ENSURE: '1' }
    const stateFile = path.join(lab, 'hook-state.json')
    const runHook = (payload) =>
      spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'hook-event.mjs')], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: hookEnv,
      })
    let r = runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', transcript_path: '/tmp/s1.jsonl' })
    let st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    check(
      'hook-event：UserPromptSubmit 写事件名/会话/transcript，waiting=false，计数累加',
      r.status === 0 &&
        st.event === 'UserPromptSubmit' &&
        st.sessionId === 's1' &&
        st.transcriptPath === '/tmp/s1.jsonl' &&
        st.waiting === false &&
        st.ts > 0 &&
        st.counts.UserPromptSubmit === 1,
      JSON.stringify(st)
    )
    r = runHook({ hook_event_name: 'Notification', session_id: 's1', message: '等待确认' })
    st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    check(
      'hook-event：Notification → waiting=true（等确认），计数各自累加',
      r.status === 0 && st.waiting === true && st.notification === '等待确认' && st.counts.Notification === 1 && st.counts.UserPromptSubmit === 1,
      JSON.stringify({ waiting: st.waiting, notification: st.notification, counts: st.counts })
    )
    r = runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's2' })
    st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    check(
      'hook-event：下一轮提问清掉等确认标记（等待已过去）',
      st.waiting === false && st.counts.UserPromptSubmit === 2,
      JSON.stringify({ waiting: st.waiting, counts: st.counts })
    )
    r = runHook({ hook_event_name: 'PostToolUse', session_id: 's2', tool_name: 'Bash' })
    st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    check(
      'hook-event：PostToolUse 记录工具名且不误置等确认',
      r.status === 0 && st.tool === 'Bash' && st.waiting === false && st.counts.PostToolUse === 1,
      JSON.stringify({ tool: st.tool, waiting: st.waiting })
    )
    // 坏输入（空 stdin / 非 JSON）不能抛、不能写坏文件、退出码必须 0
    const empty = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'hook-event.mjs')], {
      input: '',
      encoding: 'utf8',
      env: hookEnv,
    })
    const bad = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'hook-event.mjs')], {
      input: 'not json at all',
      encoding: 'utf8',
      env: hookEnv,
    })
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    check(
      'hook-event：空输入 / 坏 JSON 都以 0 退出且不改坏已有状态（钩子失败绝不能影响宿主）',
      empty.status === 0 && bad.status === 0 && after.event === 'PostToolUse' && after.ts > 0,
      JSON.stringify({ empty: empty.status, bad: bad.status, event: after.event })
    )
    fs.rmSync(lab, { recursive: true, force: true })
  }

  // 补拉起（v2.0.1）：**WorkBuddy 启动客户端本身不触发 SessionStart**。实测（宿主日志
  // `executeSessionStartHooks` 与 AppStartup.log 对齐）：存活 14s / 21s 的两个应用实例里
  // SessionStart 一次都没跑；其余实例内的延迟从 +19s 到 +736s 毫无规律 → 由用户动作驱动
  //（source=resume：真正进入/恢复一个会话），不是启动定时器。所以 hook-event 在
  // UserPromptSubmit / Notification 上做一次廉价兜底：服务或浮层不活着就后台拉起 autostart.mjs。
  // 这块会真的起一个服务，因此用独立数据目录 + 独立端口，测完收掉。
  {
    const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ensure-'))
    const port2 = 39700 + (process.pid % 200)
    const env2 = { ...process.env, CODEBUDDY_HOME: lab, FOX_WIDGET_DATA_DIR: lab, FOX_WIDGET_PORT: String(port2) }
    const autoLog = path.join(lab, 'autostart.log')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const fire = (dir, payload) =>
      spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'hook-event.mjs')], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...env2, CODEBUDDY_HOME: dir, FOX_WIDGET_DATA_DIR: dir },
      })
    const readLog = (dir) => {
      try {
        return fs.readFileSync(path.join(dir, 'autostart.log'), 'utf8')
      } catch (err) {
        return ''
      }
    }

    // 1) 服务与浮层都没在跑 → 应触发后台补拉起
    fire(lab, { hook_event_name: 'UserPromptSubmit', session_id: 'e1' })
    let waited = 0
    while (!readLog(lab) && waited < 12000) {
      await sleep(300)
      waited += 300
    }
    const logText = readLog(lab)
    check(
      '补拉起：UserPromptSubmit 发现服务不在 → 后台拉起 autostart（不必等 SessionStart）',
      /server=started/.test(logText),
      JSON.stringify(logText.trim().slice(0, 90))
    )
    check(
      '补拉起：测试环境没有 Electron 运行时 → 浮层如实 skip（不会真起 Electron）',
      /overlay=skipped:no-runtime/.test(logText),
      JSON.stringify(logText.trim().slice(0, 90))
    )
    let stEnsure = JSON.parse(fs.readFileSync(path.join(lab, 'hook-state.json'), 'utf8'))
    check(
      '补拉起：节流锚点落盘，会话身份照常写入',
      Number(stEnsure.lastEnsureSpawnAt) > 0 && stEnsure.sessionId === 'e1',
      JSON.stringify({ at: stEnsure.lastEnsureSpawnAt, sid: stEnsure.sessionId })
    )

    // 2) 紧接着再来一次 → 节流窗口内不重复 spawn
    const beforeN = readLog(lab).split('\n').filter(Boolean).length
    fire(lab, { hook_event_name: 'UserPromptSubmit', session_id: 'e2' })
    await sleep(2500)
    const afterN = readLog(lab).split('\n').filter(Boolean).length
    check(
      '补拉起：节流窗口内不重复拉起（连发消息不会拉出一堆 Electron）',
      afterN === beforeN,
      beforeN + ' -> ' + afterN
    )

    // 3) 非补拉起事件不触发
    const lab3 = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ensure-other-'))
    fire(lab3, { hook_event_name: 'Stop', session_id: 'e3' })
    await sleep(2500)
    check('补拉起：Stop 这类事件不触发补拉起', !fs.existsSync(path.join(lab3, 'autostart.log')), '')

    // 4) 服务与浮层都活着 → 一次都不该 spawn（这是常态路径，必须零开销）
    const lab4 = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-ensure-up-'))
    fs.writeFileSync(path.join(lab4, 'server.json'), JSON.stringify({ pid: process.pid, port: port2 }))
    fs.writeFileSync(path.join(lab4, 'overlay.json'), JSON.stringify({ pid: process.pid, port: port2 }))
    fire(lab4, { hook_event_name: 'UserPromptSubmit', session_id: 'e4' })
    await sleep(3000)
    const stUp = JSON.parse(fs.readFileSync(path.join(lab4, 'hook-state.json'), 'utf8'))
    check(
      '补拉起：服务+浮层都在时不动手（不 spawn、不写节流锚点）',
      !fs.existsSync(path.join(lab4, 'autostart.log')) && !stUp.lastEnsureSpawnAt,
      JSON.stringify({ at: stUp.lastEnsureSpawnAt })
    )

    // 收掉测试起的服务（否则会留一个占端口的孤儿）
    try {
      const svc = JSON.parse(fs.readFileSync(path.join(lab, 'server.json'), 'utf8'))
      spawnSync('taskkill', ['/PID', String(svc.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 })
    } catch (err) {}
    for (const d of [lab, lab3, lab4]) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch (err) {}
    }
  }

  // 宿主模型目录（免费 / 限时促销标注）：**读宿主自己的商品配置**，不靠猜。
  // 之前在用量面板里，一切不扣积分的轮次都被笼统写成「套餐/网关」——把
  // 「订阅/网关口径」和「免费模型」混成了一类（真机实例：step-5-preview 倍率 x0.00、
  // 宿主徽章「独家限免」，却被标成「套餐/网关」）。这里在隔离 HOST_HOME 下伪造一份
  // 快照，验倍率判定、促销优先级与时段门控。
  {
    const { hostModelInfo, invalidateHostModelsCache } = await import('../lib/host-models.mjs')
    const scoped = path.join(tmpHome, 'storage', 'user-selftest', 'scoped', 's1')
    fs.mkdirSync(scoped, { recursive: true })
    const past = new Date(Date.now() - 86400000 * 30).toISOString()
    fs.writeFileSync(
      path.join(scoped, 'wb-product-config.json'),
      JSON.stringify({
        'product-config-snapshot': {
          savedAt: Date.now(),
          data: {
            models: [
              { id: 'step-5-preview', credits: 'x0.00' },
              { id: 'glm-5.3', credits: 'x0.79' },
              { id: 'hy4-preview', credits: 'x0.29' },
            ],
            modelPromotions: [
              {
                id: 'free-a',
                kind: 'discount',
                enabled: true,
                priority: 200,
                modelIds: ['step-5-preview'],
                badge: { label: '独家限免' },
                discount: { factor: 0 },
              },
              {
                id: 'lower-prio',
                kind: 'discount',
                enabled: true,
                priority: 10,
                modelIds: ['step-5-preview'],
                badge: { label: '限时折扣' },
              },
              {
                id: 'expired-free',
                kind: 'discount',
                enabled: true,
                priority: 999,
                modelIds: ['glm-5.3'],
                badge: { label: '不该命中（已过期）' },
                discount: { factor: 0 },
                schedule: { validUntil: past },
              },
              {
                id: 'night-free',
                kind: 'discount',
                enabled: true,
                priority: 50,
                modelIds: ['hy4-preview'],
                badge: { label: '夜间免费' },
                discount: { factor: 0 },
                schedule: { daily: [{ start: '23:00', end: '8:00' }] },
              },
            ],
          },
        },
      })
    )
    invalidateHostModelsCache()
    const at = Date.now()
    let info = hostModelInfo('step-5-preview', at)
    check(
      '宿主模型目录：倍率 x0.00 → 判为免费，并用宿主自己的促销徽章当文案',
      info.known && info.free === true && info.freeLabel === '独家限免',
      JSON.stringify(info)
    )
    check('宿主模型目录：同模型多条促销 → 取优先级最高的那条', info.promoId === 'free-a', String(info.promoId))
    info = hostModelInfo('glm-5.3', at)
    check(
      '宿主模型目录：已过期的促销不命中（写了 factor 0 也不能算免费）',
      info.known && info.free === false && info.freeLabel === null,
      JSON.stringify(info)
    )
    check('宿主模型目录：在售模型倍率非 0 → 不算免费', info.multiplier === 0.79, String(info.multiplier))
    const night = new Date(at)
    night.setHours(23, 30, 0, 0)
    const day = new Date(at)
    day.setHours(14, 0, 0, 0)
    const infoNight = hostModelInfo('hy4-preview', night.getTime())
    const infoDay = hostModelInfo('hy4-preview', day.getTime())
    check(
      '宿主模型目录：每日窗口按轮次时刻判定（夜免只在夜里成立，白天不能标）',
      infoNight.free === true && infoNight.freeLabel === '夜间免费' && infoDay.free === false,
      'night=' + infoNight.free + '/' + infoNight.freeLabel + ' day=' + infoDay.free
    )
    check('宿主模型目录：快照里没有的模型不猜（known=false，交给调用方定口径）', hostModelInfo('my-custom-model', at).known === false, '')
    fs.rmSync(path.join(tmpHome, 'storage', 'user-selftest'), { recursive: true, force: true })
    invalidateHostModelsCache()
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
  // 实测没有解决宿主暂停，已按用户要求回滚，钉桩一并移除——别再从别处「顺手加回来」。
  {
    const mainSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'desktop', 'main.cjs'), 'utf8')
    check(
      'issue#2：宿主窗口长时间不存在时浮层自退（空窗看门狗，桌宠模式豁免）',
      mainSrc.indexOf('MISSING_QUIT_MS') !== -1 &&
        /reason === 'window-missing' \|\| reason === 'host-identity-changed'/.test(mainSrc) &&
        /if \(petMode\) return/.test(mainSrc) &&
        /log\('quit-window-missing'/.test(mainSrc),
      ''
    )
    check(
      'issue#2：宿主进程更换时立刻交还鼠标并隐身（更新/重启不再留下吃点击的透明窗口）',
      /function applyInteractive\(next, force\)/.test(mainSrc) &&
        /interactive\) applyInteractive\(false, true\)/.test(mainSrc) &&
        /hideOverlay\('host-identity-changed'\)/.test(mainSrc),
      ''
    )
    // 两线各有一个「按宿主窗口算浮层边界」的函数，名字不同（本线是
    // applyHostBounds，ZCode 线是 applyZCodeBounds）。从 main cherry-pick 浮层补丁时
    // hunk 能对上、函数名却可能对不上——2026-10-18 真机就弹过
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
  // 跨站防护的判据是「默认拒绝」：除静态白名单外的 GET 一律拦（审查 I4/T4）。
  // session.json 会带着用户 key 出站到中转站与厂商，旧的手工名单漏了它。
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
  insertTurn('turn_D', USAGE_B, Date.now(), null, 6)
  insertTurn('turn_D_adv', USAGE_B, Date.now(), null, 0)
  let fourth = null
  const deadlineD = Date.now() + 8000
  while (Date.now() < deadlineD) {
    await new Promise((r) => setTimeout(r, 400))
    fourth = await getJson(port, '/whale/last-turn.json')
    if (fourth && fourth.turn === 'turn_D') break
  }
  check(
    '重启后新一轮 seq 继续单调递增',
    fourth && fourth.seq === seqBeforeRestart + 1 && fourth.turn === 'turn_D',
    JSON.stringify(fourth ? { seq: fourth.seq, turn: fourth.turn } : fourth)
  )

  // 多行轮求和（WorkBuddy 版）：一个 agent 轮会对同一个 conversationRequestId 落
  // 多条模型调用，逐模型明细要按行合并、tokens/积分全行求和。
  const atE = Date.now()
  const multiRows = [
    { model: 'GLM-5.3-Flash', modelName: 'GLM-5.3-Flash', usage: { input_tokens: 400_000, cache_read_input_tokens: 350_000, output_tokens: 50_000 }, credit: 3 },
    { model: 'GLM-5.3-Flash', modelName: 'GLM-5.3-Flash', usage: { input_tokens: 300_000, cache_read_input_tokens: 250_000, output_tokens: 50_000 }, credit: 3 },
    { model: 'GLM-5.3-Flash', modelName: 'GLM-5.3-Flash', usage: { input_tokens: 250_000, cache_read_input_tokens: 200_000, output_tokens: 50_000 }, credit: 3 },
  ]
  insertTurn('turn_E', USAGE_B, atE, multiRows, 9)
  insertTurn('turn_E_adv', USAGE_B, atE + 1500, null, 0)
  let fifth = null
  const deadlineE = Date.now() + 8000
  while (Date.now() < deadlineE) {
    await new Promise((r) => setTimeout(r, 400))
    fifth = await getJson(port, '/whale/last-turn.json')
    if (fifth && fifth.turn === 'turn_E') break
  }
  // 行 tokens 口径 = 命中+未命中+缓存写+输出：三行 450k/350k/300k = 1.1M
  const sumTokens = 1_100_000
  check(
    '多行轮按全行求和（calls=3，tokens=1.1M，credit=9；逐模型合并为一行）',
    fifth && fifth.turn === 'turn_E' && fifth.calls === 3 && fifth.tokens === sumTokens && fifth.credit === 9 && fifth.models.length === 1,
    '实际 calls=' + (fifth && fifth.calls) + ' tokens=' + (fifth && fifth.tokens) + ' credit=' + (fifth && fifth.credit) + ' models=' + (fifth && fifth.models && fifth.models.length)
  )

  // 智能跟随：当前模型取宿主 sessions.model（输入框选定即更新），缺失时回落
  // transcript 的最近一次真实模型调用。WorkBuddy 主计费源恒为 credits。
  writeSession('GLM-5.3-Flash', Date.now())
  const sel1 = await getJson(port, '/whale/session.json')
  check(
    'session.json：会话模型生效（GLM → source=credits，vendor=glm）',
    sel1 &&
      sel1.ok &&
      sel1.from === 'selection' &&
      sel1.source === 'credits' &&
      sel1.modelVendor === 'glm' &&
      sel1.modelId === 'GLM-5.3-Flash',
    JSON.stringify(sel1).slice(0, 180)
  )
  writeSession('mimo-v2.6-pro', Date.now() + 1)
  const sel2 = await getJson(port, '/whale/session.json')
  check(
    'session.json：换了模型族（mimo → vendor=mimo，主显示仍 credits）',
    sel2 && sel2.ok && sel2.source === 'credits' && sel2.modelVendor === 'mimo',
    JSON.stringify(sel2).slice(0, 180)
  )
  // 会话模型为空时回落 transcript 最近一次调用（kimi-k3）。
  // 注：readSessionSource 把 readActiveSelection 的回落也标为 from:'selection'
  // （sel.ok 为真即走 selection 分支），所以这里只钉「取到了 transcript 的模型」。
  insertTurn('turn_sel', { input_tokens: 1000, output_tokens: 100 }, Date.now() + 10, [
    { model: 'kimi-k3', modelName: 'Kimi-K3', usage: { input_tokens: 1000, output_tokens: 100 }, credit: 1 },
  ], 1)
  writeSession('', Date.now() + 2)
  const sel3 = await getJson(port, '/whale/session.json')
  check(
    'session.json：会话模型缺失时回落 transcript 最近一次调用（kimi-k3 → vendor=kimi）',
    sel3 && sel3.ok && sel3.modelVendor === 'kimi' && sel3.modelId === 'kimi-k3' && sel3.source === 'credits',
    JSON.stringify(sel3).slice(0, 180)
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
    // 「金额榜」在 WorkBuddy 分支按**积分**降序（服务端 modelsList 的 rankByCredit，
    // 逐模型行以 credit 为主键、tokens 为次键）；token 榜按 tokens 降序。
    //
    // 注意：**不要**拿等价市值（market）来验这一条。market 是按公开价目折算的参考值，
    // 会随峰谷时段变化（PEAK_HOURS = [9,12],[14,18]），而 fixture 的时间戳是
    // `Date.now()` —— 用它做断言会在高峰时段排序上翻车。2026-10-14 真机就踩到：
    // 14:00 前 off-peak 时「积分序」与「市值序」恰好同向，所以这条断言看起来一直是绿的，
    // 15:16（peak）复跑才暴露（[5.6, 0.94, 1.1235…] 里 0.94 与 1.1235 反序）。
    const rankOf = (m) => Number(m.credit) || 0
    const descRank = (arr) => arr.every((v, i) => i === 0 || rankOf(arr[i - 1]) >= rankOf(v))
    const desc = (arr, key) => arr.every((v, i) => i === 0 || Number(arr[i - 1][key]) >= Number(v[key]))
    const maxTok = Math.max.apply(null, amtList.map((x) => Number(x.tokens) || 0))
    check(
      '用量记录：两个榜各自降序（金额榜按积分 / token 榜按 tokens）',
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

  // 接口：宿主主题（跟随 WorkBuddy 的数据源：观测 > preferences > system）
  fs.mkdirSync(path.join(tmpHome, 'storage', 'user-1-personal', 'global'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpHome, 'storage', 'user-1-personal', 'global', 'preferences.json'),
    JSON.stringify({ theme: 'dark' }),
    'utf8'
  )
  const zt = await getJson(port, '/whale/host-theme.json')
  check(
    '宿主主题：读 <CODEBUDDY_HOME>/storage/user-*/global/preferences.json 的 theme（dark）',
    zt && zt.ok === true && zt.theme === 'dark' && zt.raw === 'dark' && zt.source === 'preferences',
    JSON.stringify(zt)
  )
  // 观测层：浮层把 WorkBuddy 窗口的 DWM 暗色标志落盘，接口优先用它——
  // 跟随的是「WorkBuddy 现在实际用的主题」，配置/系统都可能与实况相反
  const obsFile = path.join(dataDir, 'host-theme-observed.json')
  fs.writeFileSync(obsFile, JSON.stringify({ dark: 1, at: Date.now() }), 'utf8')
  await new Promise((r) => setTimeout(r, 5200)) // 服务端读取缓存 5s
  const ztObs = await getJson(port, '/whale/host-theme.json')
  check(
    '宿主主题：观测层生效（DWM 暗色标志 → dark，source=host-window）',
    ztObs && ztObs.ok === true && ztObs.theme === 'dark' && ztObs.source === 'host-window' && ztObs.observed && ztObs.observed.dark === 1,
    JSON.stringify(ztObs)
  )
  fs.writeFileSync(obsFile, JSON.stringify({ dark: 0, at: Date.now() }), 'utf8')
  await new Promise((r) => setTimeout(r, 5200))
  const ztObs2 = await getJson(port, '/whale/host-theme.json')
  check(
    '宿主主题：观测为浅色时不被 preferences 的 dark 带偏（跟随实况）',
    ztObs2 && ztObs2.theme === 'light' && ztObs2.source === 'host-window',
    JSON.stringify(ztObs2)
  )
  fs.rmSync(obsFile, { force: true })
  await new Promise((r) => setTimeout(r, 5200))
  const ztBack = await getJson(port, '/whale/host-theme.json')
  check(
    '宿主主题：观测文件消失后回落 preferences 层（dark）',
    ztBack && ztBack.theme === 'dark' && ztBack.source === 'preferences',
    JSON.stringify(ztBack)
  )

  // 接口：音效库（内置两套 + 导入 + 回放 + 删除）
  const snd0 = await getJson(port, '/whale/sounds.json')
  check(
    '音效库：内置两套在列、默认选中小黄鸭',
    snd0 && snd0.ok === true && snd0.sets.filter((s) => s.builtin).map((s) => s.id).join(',') === 'duck,fx1' && snd0.selected === 'duck',
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
    check(
      'pickBalanceInfo：缺 total_balance 不当数（跳到下一项）',
      pb([{ currency: 'CNY' }, { currency: 'USD', total_balance: 1 }]) === 'USD:1',
      pb([{ currency: 'CNY' }, { currency: 'USD', total_balance: 1 }])
    )
    // 余额构成（赠金 / 充值）：缺失与 0 必须区分——0 是"真没有"，null 是"接口没给"
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
  }

  // （迁移删除）套餐扣费轮的「余额口径」纯函数测试（quotaBucketForModel /
  // turnPlanUsage / extraAmountsOfTurn）：这几个出口在 WorkBuddy 分支已随
  // plan-balance 冻结移除，服务端 turnPlanUsage 恒返回 null。对应覆盖见上面的
  // 「每轮消耗不带套餐口径」断言与文件较前的 readPlanBalance/turnPlanUsage 冻结契约。

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
    // 零覆盖）。这几个函数把 LEDGER_FILE 绑死在插件数据目录上、findApiKey 又会读
    // 真实配置——所以用 spawnSync 起一个 FOX_WIDGET_DATA_DIR 指向独立目录的子进程，
    // 在里面按顺序跑完整场景（开户 → 降 → 升 → 校正 → 校正后再消费 → 跨天 →
    // 换币种 → 换 key），把每步的账本快照吐回来断言。
    const lab = path.join(tmpHome, 'ledger-lab')
    const labData = path.join(lab, 'plugin-data')
    fs.mkdirSync(labData, { recursive: true })
    const balUrl = 'file:///' + path.join(PLUGIN_ROOT, 'lib', 'balance.mjs').replace(/\\/g, '/')
    const labScript = [
      "import fs from 'node:fs'",
      "import path from 'node:path'",
      "import { recordLedgerUsage, applyBalanceCorrection, balanceAdjustmentSummary } from '" + balUrl + "'",
      "const file = path.join(process.env.FOX_WIDGET_DATA_DIR, 'usage-ledger.json')",
      "const cfg = path.join(process.env.FOX_WIDGET_DATA_DIR, 'config.json')",
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
      env: { ...process.env, CODEBUDDY_HOME: lab, FOX_WIDGET_DATA_DIR: labData, DEEPSEEK_API_KEY: '' },
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
    // 宿主主题映射（纯函数）：dark/light 归一到挂件三态，其余（含 zai-* 旧值）回 system
    check(
      'mapHostTheme：dark/light 映射，zai-* 旧值兼容',
      mapHostTheme('dark') === 'dark' &&
        mapHostTheme('light') === 'light' &&
        mapHostTheme('zai-dark') === 'dark' &&
        mapHostTheme('zai-light') === 'light' &&
        mapHostTheme('DARK') === 'dark',
      mapHostTheme('dark')
    )
    check(
      'mapHostTheme：system/缺失/垃圾值回 system',
      mapHostTheme('system') === 'system' && mapHostTheme(null) === 'system' && mapHostTheme('hacker') === 'system',
      'system'
    )
    check(
      'themeOfPreferences：优先 prefs.theme，其次 appearance.themeSelection.resourceKey',
      themeOfPreferences({ theme: 'dark' }) === 'dark' &&
        themeOfPreferences({ 'appearance.themeSelection': { resourceKey: 'light' } }) === 'light' &&
        themeOfPreferences({ theme: '  ', 'appearance.themeSelection': { resourceKey: 'dark' } }) === 'dark' &&
        themeOfPreferences({}) === null &&
        themeOfPreferences(null) === null,
      JSON.stringify(themeOfPreferences({ 'appearance.themeSelection': { resourceKey: 'light' } }))
    )
    // 三层判定：观测（宿主窗口 DWM 暗色标志）> preferences > system
    const tnow = Date.now()
    check(
      'resolveHostTheme：新鲜观测压过配置（宿主实际暗色 + 配置写浅色 → dark）',
      resolveHostTheme({ dark: 1, at: tnow }, 'light') === 'dark' && resolveHostTheme({ dark: 0, at: tnow }, 'dark') === 'light',
      resolveHostTheme({ dark: 1, at: tnow }, 'light')
    )
    check(
      'resolveHostTheme：过期观测不算数（回落配置映射）',
      resolveHostTheme({ dark: 1, at: tnow - 48 * 3600_000 }, 'light') === 'light',
      resolveHostTheme({ dark: 1, at: tnow - 48 * 3600_000 }, 'light')
    )
    check(
      'resolveHostTheme：无观测走配置、配置缺失回 system',
      resolveHostTheme(null, 'dark') === 'dark' && resolveHostTheme(undefined, null) === 'system',
      'dark / system'
    )
    check(
      'resolveHostTheme：观测缺 at 视为新鲜（跟随脚本只在变化时写）',
      resolveHostTheme({ dark: 0 }, 'dark') === 'light',
      resolveHostTheme({ dark: 0 }, 'dark')
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
    // ---------- 浮层 spawn 环境（2026-10-14 真机回归） ----------
    //
    // 真机现象：装了插件、服务也起来了（/whale/health 正常），但桌面就是没有挂件，
    // autostart.log 只留一句 `overlay=failed:浮层进程启动后立即退出`。
    // 根因：WorkBuddy 把 Electron 二进制当 Node 用，给子进程注入了
    // `ELECTRON_RUN_AS_NODE=1`；浮层继承它后 electron.exe 以 Node 模式启动
    // （实测同一 exe：带该变量 `--version` 打印 node v24.21.0、去掉后打印
    // Electron v44.7.2），主进程拿不到 app/BrowserWindow，立刻退出。
    // 把「spawn 前清掉污染变量、其余环境照旧、父进程不受影响」钉死。
    const prevRunAsNode = process.env.ELECTRON_RUN_AS_NODE
    const prevNodeOptions = process.env.NODE_OPTIONS
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.NODE_OPTIONS = '--require="…/node-language-shim.cjs"'
    let ovEnv = null
    try {
      ovEnv = overlaySpawnEnv({ port: 45678 })
    } finally {
      if (prevRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = prevRunAsNode
      if (prevNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = prevNodeOptions
    }
    check(
      '浮层 spawn env：清掉 ELECTRON_RUN_AS_NODE（否则 Electron 以 Node 模式秒退）',
      !!ovEnv && ovEnv.ELECTRON_RUN_AS_NODE === undefined,
      String(ovEnv && ovEnv.ELECTRON_RUN_AS_NODE)
    )
    check(
      '浮层 spawn env：清掉继承的 NODE_OPTIONS（不把宿主 node shim 注进 Electron 主进程）',
      !!ovEnv && ovEnv.NODE_OPTIONS === undefined,
      String(ovEnv && ovEnv.NODE_OPTIONS)
    )
    check(
      '浮层 spawn env：WHALE_PORT / 跟随目标 / 跟随间隔仍就位',
      !!ovEnv &&
        ovEnv.WHALE_PORT === '45678' &&
        !!ovEnv.WHALE_TARGET_PROCESS &&
        /^\d+$/.test(String(ovEnv.WHALE_FOLLOW_INTERVAL_MS)),
      ovEnv && [ovEnv.WHALE_PORT, ovEnv.WHALE_TARGET_PROCESS, ovEnv.WHALE_FOLLOW_INTERVAL_MS].join(' / ')
    )
    check(
      '浮层 spawn env：不是空环境（PATH 等基础变量仍继承）',
      // Windows 的环境变量名大小写不固定：本机 bash 给的是 PATH，GitHub runner 上
      // 可能是 Path，所以按键名不区分大小写找（2026-10-18 CI 实测）
      !!ovEnv &&
        (() => {
          const k = Object.keys(ovEnv).find((n) => n.toLowerCase() === 'path')
          return typeof ovEnv[k] === 'string' && ovEnv[k].length > 0 && Object.keys(ovEnv).length > 5
        })(),
      ovEnv && Object.keys(ovEnv).length + ' 个变量'
    )
    check(
      '浮层 spawn env：不改动父进程环境（进程自身仍带宿主变量）',
      process.env.ELECTRON_RUN_AS_NODE === prevRunAsNode,
      String(process.env.ELECTRON_RUN_AS_NODE)
    )
  }

  {
    // 浮层收尾判定（纯函数）。2026-10-14 真机缺陷：浮层以管理员权限运行，
    // 普通权限 taskkill 收不掉，而旧实现**无条件**返回 ok 并删掉 overlay.json，
    // 于是上层接着起第二个实例 → 两个 Electron 抢同一个 user-data-dir
    //（GPUCache 文件锁）→ 把正在用的浮层弄成「主进程活着、页面空白」的僵尸态。
    // 判定逻辑抽成纯函数就是为了能在不碰真实进程的前提下钉住它。
    const bad = overlayStopOutcome([4], [4])
    check(
      'stopOverlay 判定：收完还活着 → ok=false 且回带 pid',
      bad.ok === false && Array.isArray(bad.alive) && bad.alive.join(',') === '4',
      JSON.stringify(bad)
    )
    check(
      'stopOverlay 判定：错误文案说清「权限不足」与替代做法',
      typeof bad.error === 'string' && /权限/.test(bad.error) && /管理员|退出宿主/.test(bad.error),
      String(bad.error)
    )
    const good = overlayStopOutcome([11, 12], [])
    check(
      'stopOverlay 判定：全部收掉 → ok=true 且 killed 计数正确',
      good.ok === true && good.killed === 2,
      JSON.stringify(good)
    )

    // CLI 的浮层重启路径：收不掉时必须**中止**，不能叠加新实例
    const cliSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'cli.mjs'), 'utf8')
    check(
      'CLI 浮层重启：stopOverlay 失败时中止（restart / restart-all 两处都有守卫）',
      (cliSrc.match(/if \(!s\.ok\)/g) || []).length >= 2 &&
        cliSrc.indexOf('已中止（不起新实例') !== -1,
      '守卫数=' + (cliSrc.match(/if \(!s\.ok\)/g) || []).length
    )

    // 浮层主进程的页面自愈：主进程活着 + 页面死掉的自愈兜底（无法在自检里起
    // Electron，只能静态钉住这几处关键接线）
    const mainSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'desktop', 'main.cjs'), 'utf8')
    check(
      '浮层自愈：挂上 render-process-gone → reload',
      /render-process-gone/.test(mainSrc) && /webContents\.reload\(\)/.test(mainSrc),
      'render-process-gone=' + /render-process-gone/.test(mainSrc)
    )
    check(
      '浮层自愈：页面心跳（超时/报错 → 重载），且由 did-finish-load 启动',
      /function startPageHeartbeat/.test(mainSrc) &&
        /function probePage/.test(mainSrc) &&
        /page-beat-fail/.test(mainSrc) &&
        /did-finish-load'[\s\S]{0,200}startPageHeartbeat\(\)/.test(mainSrc),
      'heartbeat=' + /function startPageHeartbeat/.test(mainSrc)
    )
  }

  {
    // 启动项 VBS 的编码。2026-10-14 真机缺陷：写成 UTF-8 BOM 时 Windows Script
    // Host 解析第 1 行就报「无效字符 800A0408」并**一句都不执行** → 登录时弹窗、
    // 自启静默失效（机器上那个看门狗其实是手动起的，还落在管理员终端里）。
    const { vbsFileEncoding } = await import('../lib/watchdog-cli.mjs')
    const ascii = vbsFileEncoding("Set fso = CreateObject(\"Scripting.FileSystemObject\")\r\n")
    check(
      '启动项 VBS 编码：全 ASCII → 无 BOM 的 ANSI（WSH 不认 UTF-8 BOM）',
      ascii.encoding === 'latin1' && ascii.bom === '',
      JSON.stringify(ascii)
    )
    const uni = vbsFileEncoding("' 中文路径 C:\\Users\\张三\r\n")
    check(
      '启动项 VBS 编码：含非 ASCII → UTF-16LE + BOM（这个 BOM 它是认的）',
      uni.encoding === 'utf16le' && uni.bom === '\ufeff',
      JSON.stringify({ encoding: uni.encoding, bom: uni.bom.charCodeAt(0).toString(16) })
    )
    const wdSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'watchdog-cli.mjs'), 'utf8')
    check(
      '启动项 VBS 编码：落盘再也别用 utf8（否则又是 EF BB BF → 800A0408）',
      /writeFileSync\(vbsFile\(\), enc\.bom \+ body, enc\.encoding\)/.test(wdSrc) &&
        !/writeFileSync\(vbsFile\(\)[^\n]*'utf8'/.test(wdSrc),
      'guard=' + /enc\.encoding/.test(wdSrc)
    )
    // 服务常暖（2026-10-14）：服务冷启动的 3–8s 是「启动 WB 后要等十来秒」的大头，
    // 看门狗改为登录即暖、应用退出也不停；同时要有版本哨兵（升级后换血，不跑旧代码）
    const wdMain = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'watchdog.mjs'), 'utf8')
    check(
      '看门狗：服务常暖（init 必然调度、怠速期不再停服务、宿主不在时不起浮层）',
      /scheduleEnsure\('init'\)/.test(wdMain) &&
        wdMain.indexOf('server stopped after grace') === -1 &&
        /if \(!wbUp\) return/.test(wdMain),
      'warm-standby guards=' + [/scheduleEnsure\('init'\)/.test(wdMain), wdMain.indexOf('server stopped after grace') === -1, /if \(!wbUp\) return/.test(wdMain)].join('/')
    )
    check(
      '看门狗：常暖服务的版本哨兵（health.version 不一致就换血）',
      /version mismatch/.test(wdMain) && /tick-server-stale/.test(wdMain) && /pluginVersion\(\)/.test(wdMain),
      'sentinel=' + /version mismatch/.test(wdMain)
    )
  }

  {
    // 跨产品线浮层互杀回归（2026-10-14 真机事故，BUGREPORT-CROSS-LINE-OVERLAY-KILL.md）：
    // 旧判据用插件名子串（'fox-widget' ⊂ 'zcode-fox-widget'），WB 版的去重把 ZCode 版
    // 浮层当重复实例杀掉。新判据 = 命令行是否含**本插件运行时的 electron dist 目录**。
    const { isOwnOverlayCommandLine } = await import('../lib/overlay.mjs')
    // 与真机同形的两条字面量命令行（报告 §6.2）
    const mine =
      'C:\\Users\\u\\.workbuddy\\plugins\\data\\fox-widget-fox-local\\desktop-runtime\\node_modules\\electron\\dist\\electron.exe ' +
      'C:\\Users\\u\\.workbuddy\\plugins\\cache\\fox-local\\fox-widget\\2.0.0\\desktop'
    const other =
      'C:\\Users\\u\\.zcode\\whale\\desktop-runtime\\node_modules\\electron\\dist\\electron.exe ' +
      'C:\\Users\\u\\.zcode\\cli\\plugins\\cache\\zcode-fox-local\\zcode-fox-widget\\1.0.0\\desktop'
    const marker = 'C:\\Users\\u\\.workbuddy\\plugins\\data\\fox-widget-fox-local\\desktop-runtime\\node_modules\\electron\\dist'
    check(
      '跨线互杀回归：自己的运行时拉起的浮层被识别',
      isOwnOverlayCommandLine(mine, marker) === true,
      String(isOwnOverlayCommandLine(mine, marker))
    )
    check(
      '跨线互杀回归：ZCode 版的浮层不再被当成重复实例（亲缘按运行时目录，不按插件名）',
      isOwnOverlayCommandLine(other, marker) === false,
      String(isOwnOverlayCommandLine(other, marker))
    )
    check(
      '跨线互杀回归：worktree 形态的自己（entry 在 Worktrees 下、electron 来自同一运行时）仍被识别',
      isOwnOverlayCommandLine(
        marker + '\\electron.exe C:\\Users\\u\\WorkBuddy\\Worktrees\\zcode-fox-widget\\main-56fc9dd2\\desktop',
        marker
      ) === true,
      'worktree 形态应命中'
    )
    check(
      '跨线互杀回归：路径大小写与 / \\ 混用不影响判定（win32）',
      isOwnOverlayCommandLine(
        'c:/users/u/.workbuddy/plugins/data/fox-widget-fox-local/desktop-runtime/node_modules/electron/dist/electron.exe',
        marker
      ) === true,
      '斜杠归一化应命中'
    )
    check(
      '跨线互杀回归：别人家的 electron 不被当成自己的浮层',
      isOwnOverlayCommandLine('C:\\other\\app\\electron.exe C:\\other\\app\\ui', marker) === false &&
        isOwnOverlayCommandLine('', marker) === false &&
        isOwnOverlayCommandLine(null, marker) === false,
      '应全部为 false'
    )
    check(
      '事故最小复现成立：other 含子串 fox-widget —— 旧判据必然误杀，这条钉住动机',
      other.toLowerCase().indexOf('fox-widget') !== -1,
      '若这里为 false，说明报告里的子串关系假设变了，回归断言需重审'
    )
    // 源级守卫：插件名子串判据不允许复活
    const hostSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'host.mjs'), 'utf8')
    const ovSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'overlay.mjs'), 'utf8')
    check(
      '跨线互杀回归：OVERLAY_CMDLINE_MARKERS 不再存在（防再被捡起来用）',
      hostSrc.indexOf('OVERLAY_CMDLINE_MARKERS') === -1 && ovSrc.indexOf('OVERLAY_CMDLINE_MARKERS') === -1,
      'host=' + hostSrc.indexOf('OVERLAY_CMDLINE_MARKERS') + ' overlay=' + ovSrc.indexOf('OVERLAY_CMDLINE_MARKERS')
    )
    // 【2026-10-14 21:36 真机】listOverlayPids 改异步后漏了两处 await：
    // `listOverlayPids().filter is not a function` → 浮层永远起不来（看门狗日志
    // 每 15s 报一次 error）。行为级回归：stopOverlay 必须能正常走完（沙箱里没有
    // 浮层 → ok:false + '浮层未在运行'），而不是抛 TypeError。
    const stopRes = await stopOverlay()
    check(
      '浮层启停回归：listOverlayPids 异步化后 stopOverlay 正常收敛（不抛 TypeError）',
      stopRes && stopRes.ok === false && /浮层未在运行/.test(String(stopRes.error)),
      JSON.stringify(stopRes)
    )
    check(
      '浮层启停回归：startOverlay/stopOverlay 都 await listOverlayPids（源级）',
      /await listOverlayPids\(\)/.test(ovSrc) && (ovSrc.match(/listOverlayPids\(\)/g) || []).length >= 2,
      'await 处数=' + (ovSrc.match(/await listOverlayPids\(\)/g) || []).length
    )
  }

  {
    // 宿主日志分流（2026-10-14 审查 P0-1）：宿主把 [AppShutdown] 退出行**也写进
    // AppStartup.log**，只比文件大小会把「宿主退出」当成「宿主启动」——退出语义
    // 整体反转（宽限期永不启动 + 每 15s 重建注定退出的浮层）。
    const { classifyHostLogAppend } = await import('../lib/host.mjs')
    const down = '2026-10-13T19:02:22 [AppShutdown] appName=WorkBuddy reason=before_quit'
    const up = '2026-10-14T11:18:51 [AppStartup] appName=WorkBuddy platform=win32'
    check(
      '宿主日志分流：AppStartup.log 里的 [AppShutdown] 行 → 判「宿主退出」',
      classifyHostLogAppend(down) === 'down',
      String(classifyHostLogAppend(down))
    )
    check(
      '宿主日志分流：活动行 → 判「宿主在跑」',
      classifyHostLogAppend(up) === 'up' && classifyHostLogAppend('[Perf] ...') === 'up',
      String(classifyHostLogAppend(up))
    )
    check(
      '宿主日志分流：成串追加以最后一行可判别行为准（退出后重启 → up）',
      classifyHostLogAppend(down + '\n' + up) === 'up' && classifyHostLogAppend(up + '\n' + down) === 'down',
      'down+up=' + classifyHostLogAppend(down + '\n' + up) + ' up+down=' + classifyHostLogAppend(up + '\n' + down)
    )
    check(
      '宿主日志分流：判别不了按活动处理（宽进，与旧行为一致）',
      classifyHostLogAppend('') === 'up' && classifyHostLogAppend('随机文本') === 'up',
      ''
    )
    const wdSrc2 = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'watchdog.mjs'), 'utf8')
    check(
      '宿主日志分流：watchHostLog 读增量字节并按内容分流（不是只比大小）',
      /onAppend\(text\)/.test(wdSrc2) && /classifyHostLogAppend\(text\)/.test(wdSrc2) && /openSync\(file, 'r'\)/.test(wdSrc2),
      'guards=' + [/onAppend\(text\)/.test(wdSrc2), /classifyHostLogAppend\(text\)/.test(wdSrc2)].join('/')
    )
  }

  {
    // 更新链路的 tag 前缀与 jsdelivr 路径（2026-10-14 审查 P1-2 / P1-3）
    const updSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'update.mjs'), 'utf8')
    check(
      '更新链路：verifyReleaseTag 按 TAG_PREFIX 复核（wb-v*），不再打 ZCode 线的 v*',
      /'\/git\/ref\/tags\/' \+ TAG_PREFIX \+ version/.test(updSrc) &&
        updSrc.indexOf("REPO + '/v' + version") === -1,
      'TAG_PREFIX 探测=' + /TAG_PREFIX \+ version/.test(updSrc)
    )
    check(
      '更新链路：jsdelivr 的 ref 带 TAG_PREFIX（否则 404 或拉到另一条产品线的树）',
      /'@' \+ ref/.test(updSrc) && /const ref = TAG_PREFIX \+ version/.test(updSrc),
      'ref guard=' + /const ref = TAG_PREFIX \+ version/.test(updSrc)
    )
    check(
      '更新链路：落地前校验包内 plugin.json 的插件名（防跨产品线污染）',
      /下载内容不是本插件/.test(updSrc) && /manifestName !== selfName/.test(updSrc),
      'name guard=' + /manifestName !== selfName/.test(updSrc)
    )
    const { jsdelivrTreePaths } = await import('../lib/update.mjs')
    const tree = {
      files: [
        { type: 'file', name: 'README.md' },
        {
          type: 'directory',
          name: 'lib',
          files: [
            { type: 'file', name: 'cli.mjs' },
            { type: 'directory', name: 'deep', files: [{ type: 'file', name: 'x.mjs' }] },
          ],
        },
      ],
    }
    const paths = jsdelivrTreePaths(tree, 100)
    check(
      '更新链路：jsdelivr 嵌套树递归拼出带目录的完整路径（旧实现是扁平 basename）',
      paths.indexOf('README.md') !== -1 &&
        paths.indexOf('lib/cli.mjs') !== -1 &&
        paths.indexOf('lib/deep/x.mjs') !== -1 &&
        paths.indexOf('cli.mjs') === -1,
      JSON.stringify(paths)
    )
    const upd2 = await import('../lib/overlay.mjs')
    check(
      '浮层去重：startOverlay 收完复验（收不掉如实回报 dedupFailed，不假装成功）',
      /dedupFailed: alive\.length \? alive : null/.test(upd2 && 'src' in {} ? '' : fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'overlay.mjs'), 'utf8')),
      'guard=' + /dedupFailed/.test(fs.readFileSync(path.join(PLUGIN_ROOT, 'lib', 'overlay.mjs'), 'utf8'))
    )
    void upd2
  }

  {
    // P0-2 截断暴露：单会话超过 TAIL_BYTES 时只统计尾部，并**如实标记**。
    //（2026-10-14 审查 P0-2：2MB 窗口实测「今日积分」低估 16%、调用次数低估 64%，
    // 而 scannedTranscripts 只报文件数，掩盖了截断。）TAIL_BYTES 在 import 时求值，
    // 主套件不能改它 → 用独立子进程、小窗口构造截断场景。
    const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-tail-'))
    const proj = path.join(lab, 'projects', 'p1')
    fs.mkdirSync(proj, { recursive: true })
    const lines = []
    let ts = Date.now() - 3600_000
    for (let i = 0; i < 40; i++) {
      ts += 60_000
      lines.push(
        JSON.stringify({
          timestamp: ts,
          type: 'function_call',
          providerData: {
            conversationRequestId: 'tail_r' + i,
            requestModelId: 'deepseek-flash',
            rawUsage: {
              prompt_tokens: 500,
              prompt_cache_hit_tokens: 0,
              prompt_cache_miss_tokens: 500,
              completion_tokens: 100,
              total_tokens: 600,
              credit: 1,
            },
          },
        })
      )
    }
    fs.writeFileSync(path.join(proj, 's1.jsonl'), lines.join('\n') + '\n')
    const fullCredit = 40
    // 子进程跑：TAIL_BYTES 在 import 时求值，环境变量要用 spawn 的 env 传（且
    // Windows 下 ESM 动态导入必须用 file:// URL，裸盘符路径会 ERR_UNSUPPORTED）
    const childFile = path.join(lab, 'run-tail.mjs')
    fs.writeFileSync(
      childFile,
      'const { usageRecords } = await import(' +
        JSON.stringify('file:///' + path.join(PLUGIN_ROOT, 'lib', 'usage-records.mjs').replace(/\\/g, '/')) +
        ');\n' +
        'const r = usageRecords();\n' +
        'console.log(JSON.stringify({ credit: r.today.credit, truncated: r.truncatedTranscripts, scan: r.scanBytes, turns: (r.turns || []).length }))\n'
    )
    const out = spawnSync(process.execPath, [childFile], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, CODEBUDDY_HOME: lab, FOX_WIDGET_DATA_DIR: lab, FOX_WIDGET_TAIL_BYTES: '2000' },
    })
    let got = null
    try {
      got = JSON.parse(String(out.stdout || '').trim().split(/\r?\n/).pop())
    } catch (err) {
      got = null
    }
    check(
      '截断暴露：超窗会话被如实标记（truncatedTranscripts ≥ 1）',
      !!got && got.truncated >= 1,
      JSON.stringify(got) + (out.stderr ? ' stderr=' + String(out.stderr).slice(0, 160) : '')
    )
    check(
      '截断暴露：截断后今日积分偏低（< 全量 40）且扫描字节 ≤ 窗口',
      !!got && got.credit > 0 && got.credit < fullCredit && Number(got.scan && got.scan.scanned) <= 2000 && Number(got.scan && got.scan.total) > 5000,
      JSON.stringify(got)
    )
    try {
      fs.rmSync(lab, { recursive: true, force: true })
    } catch (err) {}
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
