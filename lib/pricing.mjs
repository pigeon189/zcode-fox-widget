// 多厂商计价内核：把「某轮模型调用的 token 分桶」换算成金额。
//
// 供应商识别（resolveVendor）优先看 model_id：openai 兼容生态里 provider_id 常是
// 网关/中转名（如 cmdgo-bridge），模型名才指向真正被调用的厂商；provider_id 作补充。
// 识别不出或没有维护价目的模型一律「仅统计 tokens、不折算金额」——宁可少算也不虚报
// （此前 GLM 轮次会被兜底按 DeepSeek 价折算出看似精确实则失真的金额）。
//
// - DeepSeek：峰谷价。工作日北京时间 9–12、14–18 为高峰，其余空闲；
//   2026-08-23 起周末全天谷价。价目在 PRICING，官方调价改这里。
// - GLM/BigModel：平价（无峰谷），部分模型按输入长度（32K）或输出长度（0.2K）分档。
//   价目来源 docs.bigmodel.cn/cn/guide/start/pricing（2026-09-29 抓取），
//   thinking/reasoning tokens 计入输出价，缓存存储限时免费（cacheWrite 记 0）。
// - 输入口径拆分见 splitInputTokens：DeepSeek 与 GLM 实测同为「input 含缓存命中」
//   （computed_total = input + output），Anthropic 风格（input 不含缓存）也能识别。

// 高峰时段：工作日 9:00–12:00 与 14:00–18:00（北京时间）
export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

// DeepSeek 模型名 → 价目表。匹配方式是「模型名包含键名」，_default 为兜底。
export const PRICING = {
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}

export function priceFor(model) {
  const m = String(model || '').toLowerCase()
  if (!m) return PRICING._default
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  // ZCode 里 provider 常把模型直接命名为 deepseek-flash / deepseek-pro：
  // 这些名字不含 v4 前缀，按「含 pro 走 pro 价，其余走基础价」兜底。
  if (m.indexOf('pro') !== -1) return PRO_PRICE
  return PRICING._default
}

const K = 1024
// GLM 平价表（元/百万 token）：hit=缓存命中，miss=未命中输入，out=输出（含思考）。
// 键是 normalizeModelId 之后的精确模型名；分档函数按输入/输出长度返回档位。
// 没有维护条目的 GLM 模型（网关私有变体等）查不到 → 仅统计 tokens。
const GLM_PRICE = {
  'glm-5.3': () => ({ hit: 2, miss: 8, out: 28 }),
  'glm-5.3-flash': () => ({ hit: 0.23, miss: 0.8, out: 2.8 }),
  'glm-5.3-flashx': () => ({ hit: 0.57, miss: 2, out: 7 }),
  'glm-5.2': () => ({ hit: 2, miss: 8, out: 28 }),
  'glm-5.1': (i) => (i < 32 * K ? { hit: 1.3, miss: 6, out: 24 } : { hit: 2, miss: 8, out: 28 }),
  'glm-5-turbo': (i) => (i < 32 * K ? { hit: 1.2, miss: 5, out: 22 } : { hit: 1.8, miss: 7, out: 26 }),
  'glm-5': (i) => (i < 32 * K ? { hit: 1, miss: 4, out: 18 } : { hit: 1.5, miss: 6, out: 22 }),
  'glm-5v-turbo': (i) => (i < 32 * K ? { hit: 1.2, miss: 5, out: 22 } : { hit: 1.8, miss: 7, out: 26 }),
  // GLM-4.7：输入 <32K 时按输出是否到 0.2K 分两档；输入 32K–200K 一档
  // （官方价目只列到 200K，超过部分沿用该档，官方补档后再改）
  'glm-4.7': (i, o) =>
    i < 32 * K
      ? o < 0.2 * K
        ? { hit: 0.4, miss: 2, out: 8 }
        : { hit: 0.6, miss: 3, out: 14 }
      : { hit: 0.8, miss: 4, out: 16 },
  'glm-4.7-flashx': () => ({ hit: 0.1, miss: 0.5, out: 3 }),
  'glm-4.7-flash': () => ({ hit: 0, miss: 0, out: 0 }),
  'glm-4.5-air': (i, o) =>
    i < 32 * K
      ? o < 0.2 * K
        ? { hit: 0.16, miss: 0.8, out: 2 }
        : { hit: 0.16, miss: 0.8, out: 6 }
      : { hit: 0.24, miss: 1.2, out: 8 },
  'glm-4.6v': (i) => (i < 32 * K ? { hit: 0.2, miss: 1, out: 3 } : { hit: 0.4, miss: 2, out: 6 }),
  'glm-4.6v-flashx': (i) => (i < 32 * K ? { hit: 0.03, miss: 0.15, out: 1.5 } : { hit: 0.03, miss: 0.3, out: 3 }),
  'glm-4.6v-flash': () => ({ hit: 0, miss: 0, out: 0 }),
}

// 规范化模型名：去掉网关前缀（zai-org/、deepseek/ 等）并转小写
export function normalizeModelId(model) {
  const m = String(model || '').trim().toLowerCase()
  const slash = m.lastIndexOf('/')
  return slash === -1 ? m : m.slice(slash + 1)
}

// 供应商识别。返回 'deepseek' | 'glm' | null（null = 不可计价，仅统计 tokens）。
export function resolveVendor(providerId, modelId) {
  const m = normalizeModelId(modelId)
  if (m.indexOf('deepseek') !== -1) return 'deepseek'
  if (m.indexOf('glm') === 0) return 'glm'
  const p = String(providerId || '').toLowerCase()
  if (p.indexOf('deepseek') !== -1) return 'deepseek'
  if (p.indexOf('bigmodel') !== -1 || p.indexOf('zhipu') !== -1 || p.indexOf('zai') !== -1 || p.indexOf('glm') !== -1) return 'glm'
  return null
}

// 统一定价解析。返回：
//   { vendor, kind, hit, miss, out, tier, label }
//   kind: 'peak-valley'（DeepSeek，分峰谷两档）| 'flat'（GLM 平价）| 'free' | 'none'（不可计价）
//   hit/miss/out: [空闲, 高峰] 两档数组（flat/free 两档相同），none 时为 null
export function resolvePricing(opts) {
  const providerId = opts && opts.providerId
  const model = opts && opts.model
  const inTokens = Number((opts && opts.inTokens) || 0)
  const outTokens = Number((opts && opts.outTokens) || 0)
  const vendor = resolveVendor(providerId, model)
  if (vendor === 'deepseek') {
    const p = priceFor(model)
    return {
      vendor,
      kind: 'peak-valley',
      hit: p.hit,
      miss: p.miss,
      out: p.out,
      tier: p === PRO_PRICE ? 'pro' : 'base',
      label: 'DeepSeek',
    }
  }
  if (vendor === 'glm') {
    const fn = GLM_PRICE[normalizeModelId(model)]
    if (fn) {
      const v = fn(inTokens, outTokens)
      const free = v.hit === 0 && v.miss === 0 && v.out === 0
      return {
        vendor,
        kind: free ? 'free' : 'flat',
        hit: [v.hit, v.hit],
        miss: [v.miss, v.miss],
        out: [v.out, v.out],
        tier: 'flat',
        label: 'GLM',
      }
    }
    return { vendor, kind: 'none', hit: null, miss: null, out: null, tier: 'none', label: 'GLM（未维护价目）' }
  }
  return { vendor: null, kind: 'none', hit: null, miss: null, out: null, tier: 'none', label: '不可计价供应商' }
}

// 2026-08-23 00:00（北京时间）起，周末全天按谷价。生效时刻之前的历史分桶
// 仍按旧规则计价，所以周末判定带生效分界。
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

// timeSec 为 epoch 秒；按北京时间（UTC+8）判定高峰/谷时
export function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay() // bj 按 UTC 读取即为北京日历日；0=周日 6=周六
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

// 从不同来源的 usage 结构里取出各类 token 计数。
// 兼容 ZCode 的 turn_usage/model_usage 列名（snake_case）与模型返回的 camelCase 字段。
export function normalizeTokens(usage) {
  const u = usage || {}
  return {
    input: num(u.input_tokens !== undefined ? u.input_tokens : u.inputTokens),
    cacheRead: num(u.cache_read_input_tokens !== undefined ? u.cache_read_input_tokens : u.cacheReadTokens),
    cacheCreation: num(u.cache_creation_input_tokens !== undefined ? u.cache_creation_input_tokens : u.cacheWriteTokens),
    output: num(u.output_tokens !== undefined ? u.output_tokens : u.outputTokens),
    reasoning: num(u.reasoning_tokens !== undefined ? u.reasoning_tokens : u.reasoningTokens),
    total: num(
      u.computed_total_tokens !== undefined
        ? u.computed_total_tokens
        : u.total_tokens !== undefined
          ? u.total_tokens
          : u.totalTokens
    ),
  }
}

// 把「输入」拆成缓存命中与未命中两部分。
//
// 这两种口径的存在是个真实的坑：DeepSeek / OpenAI 风格里 input 是**总输入**，
// 已经包含缓存命中的部分（ZCode 实测 computed_total_tokens = input + output，
// 且 input >= cacheRead；GLM 同口径）；Anthropic 风格则是 input 不含缓存，总量要
// 再加 cacheRead + cacheCreation。若把 input 整份按未命中价计价，缓存那 99% 会被
// 重复计费——实测同一轮会从 3.05 元虚高到 76.95 元。
export function splitInputTokens(t) {
  if (t.total > 0) {
    const asIncluded = Math.abs(t.total - (t.input + t.output + t.reasoning))
    const asExcluded = Math.abs(
      t.total - (t.input + t.cacheRead + t.cacheCreation + t.output + t.reasoning)
    )
    if (asExcluded < asIncluded) {
      // Anthropic 风格：input 只是「未缓存的新输入」
      return { hit: t.cacheRead, miss: t.input, cacheWrite: t.cacheCreation }
    }
  }
  // 默认（也是 ZCode + DeepSeek/GLM 的实测口径）：input 是总输入
  return {
    hit: t.cacheRead,
    miss: Math.max(0, t.input - t.cacheRead),
    cacheWrite: t.cacheCreation,
  }
}

// 按价目换算一笔 usage 的金额。
// 分档：缓存读取→hit 价；未命中输入与缓存写入→miss 价；输出与思考→out 价。
// DeepSeek 按该轮所处时段选高峰或谷价；GLM 平价不受时段影响；不可计价供应商
// 金额恒为 0 并带 billable:false，由展示层决定口径（tokens/配额）。
export function costOfUsage(model, usage, atMs, providerId) {
  const t = normalizeTokens(usage)
  const pricing = resolvePricing({
    providerId,
    model,
    inTokens: t.input,
    outTokens: t.output + t.reasoning,
  })
  const parts = splitInputTokens(t)
  const tokens = parts.hit + parts.miss + parts.cacheWrite + t.output + t.reasoning
  const breakdown = {
    hit: parts.hit,
    miss: parts.miss,
    cacheWrite: parts.cacheWrite,
    output: t.output + t.reasoning,
  }
  if (pricing.kind === 'none') {
    return {
      amount: 0,
      tokens,
      peak: false,
      tier: 'none',
      billable: false,
      vendor: pricing.vendor,
      vendorLabel: pricing.label,
      breakdown,
      rates: null,
    }
  }
  const billable = pricing.kind !== 'free'
  const peak = pricing.kind === 'peak-valley' ? isPeakTime(Math.floor((isFinite(atMs) ? atMs : Date.now()) / 1000)) : false
  const idx = peak ? 1 : 0
  const rates = { hit: pricing.hit[idx], miss: pricing.miss[idx], out: pricing.out[idx] }
  const amount = billable
    ? (parts.hit / 1e6) * rates.hit +
      (parts.miss / 1e6) * rates.miss +
      (parts.cacheWrite / 1e6) * rates.miss +
      ((t.output + t.reasoning) / 1e6) * rates.out
    : 0
  return {
    amount,
    tokens,
    peak,
    tier: pricing.tier,
    billable,
    vendor: pricing.vendor,
    vendorLabel: pricing.label,
    breakdown,
    rates,
  }
}
