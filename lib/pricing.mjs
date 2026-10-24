// 多厂商计价内核：把「某轮模型调用的 token 分桶」换算成金额。
//
// 供应商识别（resolveVendor）优先看 model_id：openai 兼容生态里 provider_id 常是
// 网关/中转名（如 cmdgo-bridge），模型名才指向真正被调用的厂商；provider_id 作补充。
// 识别不出或没有维护价目的模型一律「仅统计 tokens、不折算金额」——宁可少算也不虚报
// （此前 GLM 轮次会被兜底按 DeepSeek 价折算出看似精确实则失真的金额；DeepSeek 价
// 只在模型名含 deepseek 时使用，仅 provider 名字沾边的不再套 DeepSeek 价）。
//
// 各家口径（2026-10-10 全量复核；2026-10-20 复核 CommandCode 套餐与
// Anthropic/Kimi/DeepSeek 在售清单，单价未变；2026-10-24 全量复核：Kimi 新增
// K3.1 Pro(+highspeed)（发布当日官方价）、MiniMax 新增 M3.1-Flash、GLM 新增
// 5.3-FlashX-Legal、OpenAI 新增 Rosalind 研究系，DeepSeek/GLM/Claude/Qwen/
// MiMo 现值全部一致；Gemini 官方页本次不可达，LiteLLM 交叉一致、沿用
// 2026-10-15 快照。单位均为「每百万 token」）：
// - DeepSeek：峰谷价。工作日北京时间 9–12、14–18 为高峰，其余空闲；
//   2026-08-23 起周末全天谷价。在售收敛为 deepseek-flash（V4.1-Flash）与
//   deepseek-v4-pro 两个名字，旧名 v4-flash / v4-flash-vision-exp 退役、由
//   V4.1-Flash 承接并按 Flash 价计费；chat / reasoner 已不在官方在售清单，
//   条目保留按 Flash 价兜底（实际计费以官方账单为准）。价目在 PRICING。
//   2026-10-24 复核（api-docs.deepseek.com 中文定价页）：flash / v4-pro 峰谷
//   现值逐项一致；官方同时明确法定节假日全天谷价（节假日表未实现、属已知
//   简化，价目无变化）。
// - GLM/BigModel：平价（无峰谷），部分模型按输入长度（32K）或输出长度（0.2K）分档。
//   价目来源 docs.bigmodel.cn/cn/guide/start/pricing，thinking/reasoning tokens
//   计入输出价，缓存存储限时免费（cacheWrite 记 0）。2026-10-10 复核与现表一致。
//   2026-10-24 复核：5.3 / 5.2 / 5.1 / 5-turbo / 5 现值全部一致，无 5.4；官方页
//   另列 GLM-5.3-FlashX-Legal（与 FlashX 同价），已收录。
// - OpenAI（USD）：GPT-5.x/GPT-6 系按「单次请求输入是否超过 272K」整单取档——超过后
//   输入/缓存读/缓存写 ×2、输出 ×1.5。缓存命中 = 输入价 10%（例外：gpt-6.1-sol 与
//   gpt-6-luna 为 5%）、缓存写 = 输入价 125%。GPT-6 系列 2026-10-03 抓取
//   developers.openai.com/api/docs/pricing 官方原文，并经 LiteLLM 注册表逐项交叉
//   验证一致（astra/6.1-sol/luna 四价全对齐；LiteLLM 里的 gpt-6-sol 为 6.0 旗舰
//   历史条目，官方页已归并进 gpt-6.1-sol，不再单列）。GPT-5.6 及更早为
//   community.openai.com 官方员工帖 + LiteLLM 交叉验证（platform.openai.com 反爬 403）。
//   2026-10-10 增补 gpt-5.3 / gpt-5.5-pro / gpt-5.5-cyber / gpt-6-sol（LiteLLM
//   注册表 + 官方页搜索摘要双源一致）。2026-10-24 复核：官方页仍 403，
//   LiteLLM 注册表逐项一致、无 6.2；新增 Rosalind 研究系（官方页搜索摘要 +
//   LiteLLM 双源一致 $5/$25/缓存读 $0.50，缓存写价官方不适用记 0）。
// - Claude（USD）：平价，缓存写 1.25×输入、缓存读各家显式公布。来源：claude.com/pricing。
//   2026-10-10 复核：新增 haiku-5-5（>100K 输入整单取第二档）与 mythos 系
//   （官方页未列 API 价，LiteLLM 与 fable 同价），修正 sonnet-5-5 缓存读 0.1。
//   2026-10-24 复核：claude.com/pricing 全表逐项一致（Mythos 官方并入 Fable
//   系列计价的口径不变），无更新模型。
// - Qwen（CNY）：按输入 token 总量分档整单取档（官方口径 K=1,000）；缓存命中按
//   隐式命中价 20% 输入（保守偏高）、缓存写 125% 输入。来源：
//   help.aliyun.com/zh/model-studio/billing-for-model-studio（华北2北京价）。
//   2026-10-10 复核：现值全部一致；新增 qwen3.6-plus / qwen3.6-flash / qwen3.5-flash；
//   qwen3-max 已不在官方价目页（3.5–3.8 系接替），条目按旧快照保留。
//   2026-10-24 复核：现值全部一致（3.7-plus 页面标示的限时折扣不影响表列原价），
//   无 qwen4；qwen3.8-max-prime 已不在官方价目页，条目按旧快照保留。
// - MiniMax（CNY）：M3 以 512K 输入为界整单取档；缓存读/写显式公布（M3 写价未
//   公布记 0）。2026-10-10 复核与现表一致（另有 M3 priority 档 = 标准价 1.5×，
//   未单列）。2026-10-24 复核（页面已 302 至 platform.minimax.cn）：M3 现值
//   一致；官方页新增 M3.1-Flash（1/4/缓存读 0.1，写价未公布记 0）已收录；
//   M2.x 系已不在官方按量页、无下线公告，按旧快照保留。
// - MiMo（CNY）：按量平价（mimo.mi.com/docs/zh-CN/pricing，即 api 平台文档）。
//   缓存写官方标注「限时免费」记 0；Token Plan 夜间 0.8x 是订阅额度消耗系数、
//   不改 API 单价，只影响展示层（source.mjs）。2026-10-10 复核：v2.6 系现值
//   一致（pro 3/6、flash 1/2、ultraspeed ×10）；2026-10-24 复核（官方页渲染
//   表）：现值一致，无 v2.7，v2.5 聊天系已不在页（仅 v2.5-asr 音频在列）。
// - Kimi（CNY）：平价无峰谷；缓存写按 TTL 计价（5min/1h 两档），usage 里拿不到
//   TTL 时按默认 5min 档。来源：platform.kimi.com/docs/pricing/chat。
//   2026-10-24 复核（官方渲染表，发布当日）：新增 kimi-k3.1-pro（输入 13 /
//   输出 68 / 缓存命中 1.3 / 缓存写 5min 13、1h 26）与 kimi-k3.1-pro-highspeed
//   （26 / 136 / 1.3 / 5min 26、1h 52）；k3 / k2.7-code(+highspeed) / k2.6
//   现值一致。K2 系列 2026-10-31 起停止向新用户开放、12 月底下线（官方公告）。
//   旧名（kimi-latest、kimi-k2.5、moonshot-v1 系）维持移除。
// - Gemini（USD）：平价（无峰谷），仅「Context caching price」= 缓存读价（隐式
//   缓存自动生效），缓存写官方无按 token 的价目（显式缓存按小时收存储费，与本
//   插件的逐轮口径无关）记 0。2026-10-15 抓取 ai.google.dev/gemini-api/docs/pricing
//   官方原文（Standard 档）：gemini-4-argon 促销价 $2/$10、缓存读 $0.10
//  （2026-11-30 起恢复 $4/$20、$0.20，按快照记促销价并注释）；3.8/3.6 Flash
//   同价 $0.75/$3.75（3.8 为 2026-12-31 前促销价）；3.5/3.1 Flash-Lite、
//   3.1 Pro（200K 整单取档）、3 Flash preview、2.5 系全量收录。图像 / TTS /
//   视频 / 嵌入等非文本族与「每轮 token 分桶」口径不符，不收录（宁可少算）。
//   2026-10-24 复核：官方页本次不可达（多次超时），LiteLLM 注册表逐项交叉
//   一致、无 Gemini 4 新型号，沿用本快照。
//
// 输入口径拆分见 splitInputTokens：DeepSeek 与 GLM 实测同为「input 含缓存命中」
// （computed_total = input + output），Anthropic 风格（input 不含缓存）也能识别。

// 高峰时段：工作日 9:00–12:00 与 14:00–18:00（北京时间）
export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

// DeepSeek V4.1-Flash（2026-10-10 官网调价）：输入 1/2（原 1.5/3）、输出 4/8
//（原 4.5/9）、缓存命中 0.02/0.04（原 0.05/0.1），空闲/高峰两档
const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

// DeepSeek 模型名 → 价目表。匹配方式是「模型名包含键名」，_default 为兜底。
// 注意 priceFor 只服务 DeepSeek 平台数据（实时·令牌模式），数据源本身就是
// DeepSeek，兜底可以接受；多厂商入口一律走 resolvePricing。
export const PRICING = {
  'deepseek-flash': BASE_PRICE, // V4.1-Flash（现役主名）
  'deepseek-v4-flash-vision-exp': BASE_PRICE, // 旧名退役，由 V4.1-Flash 承接按 Flash 价计费
  'deepseek-v4-flash': BASE_PRICE, // 同上
  'deepseek-v4-pro': PRO_PRICE,
  // chat / reasoner 已不在官方在售清单（V3.2 系退役）；条目保留按 Flash 价兜底，
  // 实际计费以官方账单为准
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
  // 法律行业版与 FlashX 同价（2026-10-24 官方定价页）
  'glm-5.3-flashx-legal': () => ({ hit: 0.57, miss: 2, out: 7 }),
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

// ---------- 其余厂商价目表（2026-09-29 官网口径） ----------
//
// 条目 = 档位数组（整单取档：档位由单次请求输入 token 总量决定，全部 token 按
// 该档单价结算，与 OpenAI/阿里云/MiniMax 官方口径一致）。每档：
//   maxIn  该档输入上限（含）；省略 = 最后一档无上限
//   hit/miss/out  缓存命中 / 未命中输入 / 输出（含思考）单价
//   cw     缓存写入价；省略 = 与 miss 同价（DeepSeek 口径）
//   name   档位名（展示/自检用）
const T = (list) => list

const VENDOR_TABLES = {
  openai: {
    currency: 'USD',
    label: 'OpenAI',
    models: {
      // GPT-6 / GPT-6.1 系列（2026-10-03 抓取 developers.openai.com/api/docs/pricing
      // 官方原文，LiteLLM 注册表逐项交叉验证一致）。命名沿用
      // astra=旗舰之上 / sol=旗舰 / luna=迷你，272K 分档规则与 GPT-5.6 相同
      'gpt-6-astra': T([
        { maxIn: 272000, name: '<=272K', hit: 1, miss: 10, out: 50, cw: 12.5 },
        { name: '>272K', hit: 2, miss: 20, out: 75, cw: 25 },
      ]),
      // gpt-6-sol：6.0 旗舰（$2/$10，促销至少延续到 2026-11-21；LiteLLM 与官方
      // 页搜索摘要一致）。gpt-6.1-sol 缓存读为 5% 档（0.1），6.0 为 10% 档（0.2）
      'gpt-6-sol': T([
        { maxIn: 272000, name: '<=272K', hit: 0.2, miss: 2, out: 10, cw: 2.5 },
        { name: '>272K', hit: 0.4, miss: 4, out: 15, cw: 5 },
      ]),
      'gpt-6.1-sol': T([
        { maxIn: 272000, name: '<=272K', hit: 0.1, miss: 2, out: 10, cw: 2.5 },
        { name: '>272K', hit: 0.2, miss: 4, out: 15, cw: 5 },
      ]),
      // Rosalind 研究系（2026-10-24 收录）：官方页搜索摘要与 LiteLLM 注册表
      // 双源一致 $5/$25/缓存读 $0.50；缓存写价官方不适用/未公布记 0（research
      // 自 2026-10-05 起计费）
      'gpt-rosalind-discovery': T([{ hit: 0.5, miss: 5, out: 25, cw: 0 }]),
      'gpt-rosalind-research': T([{ hit: 0.5, miss: 5, out: 25, cw: 0 }]),
      // Daybreak 别名（LiteLLM 2026-10-20）：blue 与 gpt-5.6 同价、red 与
      // gpt-5.6-cyber 同价；官方页未单独列出，按同价别名收录
      'gpt-daybreak-blue': T([{ hit: 0.4, miss: 4, out: 20, cw: 5 }]),
      'gpt-daybreak-red': T([{ hit: 1.25, miss: 12.5, out: 75, cw: 15.625 }]),
      'gpt-6-luna': T([
        { maxIn: 272000, name: '<=272K', hit: 0.01, miss: 0.1, out: 0.5, cw: 0.125 },
        { name: '>272K', hit: 0.02, miss: 0.2, out: 0.75, cw: 0.25 },
      ]),
      // GPT-5.6 系列：272K 输入整单分档（>272K 输入×2 / 输出×1.5 / 缓存×2）
      'gpt-5.6-sol': T([
        { maxIn: 272000, name: '<=272K', hit: 0.4, miss: 4, out: 20, cw: 5 },
        { name: '>272K', hit: 0.8, miss: 8, out: 30, cw: 10 },
      ]),
      'gpt-5.6-terra': T([
        { maxIn: 272000, name: '<=272K', hit: 0.2, miss: 2, out: 12, cw: 2.5 },
        { name: '>272K', hit: 0.4, miss: 4, out: 18, cw: 5 },
      ]),
      'gpt-5.6-luna': T([
        { maxIn: 272000, name: '<=272K', hit: 0.02, miss: 0.2, out: 1.2, cw: 0.25 },
        { name: '>272K', hit: 0.04, miss: 0.4, out: 1.8, cw: 0.5 },
      ]),
      'gpt-5.6': T([
        { maxIn: 272000, name: '<=272K', hit: 0.4, miss: 4, out: 20, cw: 5 },
        { name: '>272K', hit: 0.8, miss: 8, out: 30, cw: 10 },
      ]),
      'gpt-5.5': T([
        // 缓存写未公布 → 按通行折扣 125% 输入估算
        { maxIn: 272000, name: '<=272K', hit: 0.5, miss: 5, out: 30, cw: 6.25 },
        { name: '>272K', hit: 1, miss: 10, out: 45, cw: 12.5 },
      ]),
      // gpt-5.5-pro / -cyber（2026-10-10 LiteLLM 注册表，社区价目页一致）：
      // pro 对齐 5.4-pro 的 $30/$180；cyber 为 5.5 系 astra 位 $12.5/$75
      'gpt-5.5-pro': T([{ hit: 3, miss: 30, out: 180 }]),
      'gpt-5.5-cyber': T([
        { maxIn: 272000, name: '<=272K', hit: 1.25, miss: 12.5, out: 75, cw: 15.625 },
        { name: '>272K', hit: 2.5, miss: 25, out: 112.5, cw: 31.25 },
      ]),
      // gpt-5.3（chat-latest / codex，2026-10-10 LiteLLM）：与 5.2 同价 $1.75/$14，
      // 前缀匹配覆盖带后缀的名字
      'gpt-5.3': T([{ hit: 0.175, miss: 1.75, out: 14 }]),
      // GPT-5.6-cyber：5.6 系的 astra 位（旗舰之上，2026-10-03 官网价，LiteLLM 一致）
      'gpt-5.6-cyber': T([
        { maxIn: 272000, name: '<=272K', hit: 1.25, miss: 12.5, out: 75, cw: 15.625 },
        { name: '>272K', hit: 2.5, miss: 25, out: 112.5, cw: 31.25 },
      ]),
      'gpt-5.4-pro': T([
        { maxIn: 272000, name: '<=272K', hit: 3, miss: 30, out: 180, cw: 37.5 },
        { name: '>272K', hit: 6, miss: 60, out: 270, cw: 75 },
      ]),
      'gpt-5.4-mini': T([{ hit: 0.075, miss: 0.75, out: 4.5, cw: 0.94 }]),
      'gpt-5.4-nano': T([{ hit: 0.02, miss: 0.2, out: 1.25, cw: 0.25 }]),
      'gpt-5.4': T([
        { maxIn: 272000, name: '<=272K', hit: 0.25, miss: 2.5, out: 15, cw: 3.125 },
        { name: '>272K', hit: 0.5, miss: 5, out: 22.5, cw: 6.25 },
      ]),
      'gpt-5.2-pro': T([{ hit: 2.1, miss: 21, out: 168 }]),
      'gpt-5.2': T([{ hit: 0.175, miss: 1.75, out: 14 }]),
      'gpt-4.1': T([{ hit: 0.5, miss: 2, out: 8 }]),
      'gpt-4o': T([{ hit: 1.25, miss: 2.5, out: 10 }]),
      o3: T([{ hit: 0.5, miss: 2, out: 8 }]),
      'o4-mini': T([{ hit: 0.275, miss: 1.1, out: 4.4 }]),
    },
  },
  anthropic: {
    currency: 'USD',
    label: 'Claude',
    models: {
      // 缓存写 = 1.25×输入（官方口径，5 分钟 TTL 档）；缓存读各家显式公布
      'claude-fable-5-1': T([{ hit: 0.25, miss: 10, out: 50, cw: 12.5 }]),
      'claude-fable-5': T([{ hit: 1, miss: 10, out: 50, cw: 12.5 }]),
      // mythos 系（2026-10-10）：官方价目页未列 API 价，LiteLLM 注册表与 fable
      // 同价（fable-5-1/fable-5 各自对齐）
      'claude-mythos-5-1': T([{ hit: 0.25, miss: 10, out: 50, cw: 12.5 }]),
      'claude-mythos-5': T([{ hit: 1, miss: 10, out: 50, cw: 12.5 }]),
      // preview 别名（LiteLLM 2026-10-20）：与 mythos-5 同价
      'claude-mythos-preview': T([{ hit: 1, miss: 10, out: 50, cw: 12.5 }]),
      'claude-opus-5-5': T([{ hit: 0.2, miss: 4, out: 20, cw: 5 }]),
      'claude-opus-5': T([{ hit: 0.5, miss: 5, out: 25, cw: 6.25 }]),
      'claude-opus-4-8': T([{ hit: 0.5, miss: 5, out: 25, cw: 6.25 }]),
      'claude-opus-4-7': T([{ hit: 0.5, miss: 5, out: 25, cw: 6.25 }]),
      'claude-opus-4-6': T([{ hit: 0.5, miss: 5, out: 25, cw: 6.25 }]),
      'claude-opus-4-5': T([{ hit: 0.5, miss: 5, out: 25, cw: 6.25 }]),
      'claude-sonnet-5-5': T([{ hit: 0.1, miss: 2, out: 10, cw: 2.5 }]),
      'claude-sonnet-5': T([{ hit: 0.2, miss: 2, out: 10, cw: 2.5 }]),
      'claude-sonnet-4-6': T([{ hit: 0.3, miss: 3, out: 15, cw: 3.75 }]),
      'claude-sonnet-4-5': T([{ hit: 0.3, miss: 3, out: 15, cw: 3.75 }]),
      // haiku-5-5（2026-10-10 官网）：按「单次请求输入是否超过 100K」整单取档，
      // >100K 档 ×5
      'claude-haiku-5-5': T([
        { maxIn: 100000, name: '<=100K', hit: 0.01, miss: 0.1, out: 0.5, cw: 0.125 },
        { name: '>100K', hit: 0.05, miss: 0.5, out: 2.5, cw: 0.625 },
      ]),
      'claude-haiku-4-5': T([{ hit: 0.1, miss: 1, out: 5, cw: 1.25 }]),
    },
  },
  qwen: {
    currency: 'CNY',
    label: 'Qwen',
    models: {
      // 档位按输入 token 总量整单取档（官方 K=1,000）；缓存命中按隐式命中价
      // 20% 输入（保守偏高）、缓存写 125% 输入（官方显式缓存写价）
      'qwen3.8-max-prime': T([{ hit: 4.8, miss: 24, out: 72, cw: 30 }]),
      'qwen3.8-max': T([{ hit: 2.4, miss: 12, out: 36, cw: 15 }]),
      'qwen3.7-max': T([{ hit: 2.4, miss: 12, out: 36, cw: 15 }]),
      // qwen3-max 已不在官方价目页（2026-10-10 复核，3.5–3.8 系接替）；模型仍可
      // 调用时按 2026-09-29 快照保留
      'qwen3-max': T([
        { maxIn: 32000, name: '<=32K', hit: 0.5, miss: 2.5, out: 10, cw: 3.125 },
        { maxIn: 128000, name: '32K-128K', hit: 0.8, miss: 4, out: 16, cw: 5 },
        { maxIn: 256000, name: '128K-256K', hit: 1.4, miss: 7, out: 28, cw: 8.75 },
      ]),
      // qwen3.7-plus：官方现价即限时 8 折价（原价 2.5/10、7.5/30），促销结束后
      // 如恢复原价再改表
      'qwen3.7-plus': T([
        { maxIn: 256000, name: '<=256K', hit: 0.4, miss: 2, out: 8, cw: 2.5 },
        { name: '256K-1M', hit: 1.2, miss: 6, out: 24, cw: 7.5 },
      ]),
      // qwen3.6-plus / qwen3.6-flash / qwen3.5-flash（2026-10-10 官网补齐；
      // 缓存命中 20% 输入、缓存写 125% 输入的表内口径）
      'qwen3.6-plus': T([
        { maxIn: 256000, name: '<=256K', hit: 0.4, miss: 2, out: 12, cw: 2.5 },
        { name: '256K-1M', hit: 1.6, miss: 8, out: 48, cw: 10 },
      ]),
      'qwen3.6-flash': T([
        { maxIn: 256000, name: '<=256K', hit: 0.24, miss: 1.2, out: 7.2, cw: 1.5 },
        { name: '256K-1M', hit: 0.96, miss: 4.8, out: 28.8, cw: 6 },
      ]),
      'qwen3.5-flash': T([
        { maxIn: 128000, name: '<=128K', hit: 0.04, miss: 0.2, out: 2, cw: 0.25 },
        { maxIn: 256000, name: '128K-256K', hit: 0.16, miss: 0.8, out: 8, cw: 1 },
        { name: '256K-1M', hit: 0.24, miss: 1.2, out: 12, cw: 1.5 },
      ]),
      'qwen3.8-flash': T([{ hit: 0.16, miss: 0.8, out: 2.7, cw: 1 }]),
      'qwen3.7-flash': T([
        { maxIn: 32000, name: '<=32K', hit: 0.04, miss: 0.2, out: 0.8, cw: 0.25 },
        { maxIn: 256000, name: '32K-256K', hit: 0.12, miss: 0.6, out: 2.4, cw: 0.75 },
        { name: '256K-1M', hit: 0.24, miss: 1.2, out: 4.8, cw: 1.5 },
      ]),
      'qwen3.5-plus': T([
        { maxIn: 128000, name: '<=128K', hit: 0.16, miss: 0.8, out: 4.8, cw: 1 },
        { maxIn: 256000, name: '128K-256K', hit: 0.4, miss: 2, out: 12, cw: 2.5 },
        { name: '256K-1M', hit: 0.8, miss: 4, out: 24, cw: 5 },
      ]),
      'qwen-max': T([{ hit: 0.48, miss: 2.4, out: 9.6, cw: 3 }]),
    },
  },
  minimax: {
    currency: 'CNY',
    label: 'MiniMax',
    models: {
      // M3：512K 输入整单分档（当前为划线价永久 5 折后的价格）；缓存写未公布记 0
      'minimax-m3': T([
        { maxIn: 512000, name: '<=512K', hit: 0.42, miss: 2.1, out: 8.4, cw: 0 },
        { name: '>512K', hit: 0.84, miss: 4.2, out: 16.8, cw: 0 },
      ]),
      // M3.1-Flash（2026-10-24 官方按量页新增）：缓存写未公布记 0（与 M3 同口径）
      'minimax-m3.1-flash': T([{ hit: 0.1, miss: 1, out: 4, cw: 0 }]),
      // M2.x 系 2026-10-24 已不在官方按量价目页（无下线公告），按旧快照保留
      'minimax-m2.7-highspeed': T([{ hit: 0.42, miss: 4.2, out: 16.8, cw: 2.625 }]),
      'minimax-m2.7': T([{ hit: 0.42, miss: 2.1, out: 8.4, cw: 2.625 }]),
      'minimax-m2.5': T([{ hit: 0.21, miss: 2.1, out: 8.4, cw: 2.625 }]),
      'minimax-m2.1': T([{ hit: 0.21, miss: 2.1, out: 8.4, cw: 2.625 }]),
      'minimax-m2': T([{ hit: 0.21, miss: 2.1, out: 8.4, cw: 2.625 }]),
    },
  },
  mimo: {
    currency: 'CNY',
    label: 'MiMo',
    models: {
      // 按量平价（mimo.mi.com/docs/zh-CN/pricing）；缓存写官方标注「限时免费」记 0
      'mimo-v2.6-pro-ultraspeed': T([{ hit: 0.25, miss: 30, out: 60, cw: 0 }]),
      'mimo-v2.6-pro': T([{ hit: 0.025, miss: 3, out: 6, cw: 0 }]),
      'mimo-v2.6-flash': T([{ hit: 0.02, miss: 1, out: 2, cw: 0 }]),
      // v2.5 系列 2026-10-21 下线，过渡期保留
      'mimo-v2.5-pro': T([{ hit: 0.025, miss: 3, out: 6, cw: 0 }]),
      'mimo-v2.5': T([{ hit: 0.02, miss: 1, out: 2, cw: 0 }]),
    },
  },
  kimi: {
    currency: 'CNY',
    label: 'Kimi',
    models: {
      // 缓存写按 TTL 计价；usage 拿不到 TTL 时按默认 5min 档
      // 2026-10-24 复核（platform.kimi.com/docs/pricing/chat 官方渲染表，发布
      // 当日）：K3.1 Pro 全家价见图；k3 / k2.7-code(+highspeed) / k2.6 现值一致。
      // K2 系列 2026-10-31 起停止向新用户开放、12 月底下线（官方公告）。旧名
      //（kimi-latest、kimi-k2.5、moonshot-v1 系）已下线，调用按「无价目、仅
      // 统计 tokens」处理
      // Kimi K3.1 Pro（2026-10-24 发布）：输入 13 / 输出 68 / 缓存命中 1.3 /
      // 缓存写 5min 13、1h 26
      'kimi-k3.1-pro': T([{ hit: 1.3, miss: 13, out: 68, cw: 13 }]),
      // 高速版（2~3 倍速、同等智能）：输入 26 / 输出 136 / 缓存命中同为 1.3 /
      // 缓存写 5min 26、1h 52
      'kimi-k3.1-pro-highspeed': T([{ hit: 1.3, miss: 26, out: 136, cw: 26 }]),
      // 短名别名：防裸名 k3.1-pro 系被下方 'k3' 前缀误匹配成旧 K3 价
      'k3.1-pro': T([{ hit: 1.3, miss: 13, out: 68, cw: 13 }]),
      'k3.1-pro-highspeed': T([{ hit: 1.3, miss: 26, out: 136, cw: 26 }]),
      'kimi-k3': T([{ hit: 2, miss: 20, out: 100, cw: 20 }]),
      k3: T([{ hit: 2, miss: 20, out: 100, cw: 20 }]),
      'kimi-k2.7-code-highspeed': T([{ hit: 2.6, miss: 13, out: 54 }]),
      'kimi-k2.7-code': T([{ hit: 1.3, miss: 6.5, out: 27 }]),
      'kimi-k2.6': T([{ hit: 1.1, miss: 6.5, out: 27 }]),
    },
  },
  gemini: {
    currency: 'USD',
    label: 'Gemini',
    models: {
      // Gemini 4 Argon（2026-10-15 官方价，Standard 档）：$2/$10 为促销价
      //（至少到 2026-11-30，之后 $4/$20、缓存读 $0.20）；gemini-4-ar 是同一
      // 型号的短名（用户侧简写），前缀匹配也能罩住带日期后缀的变体
      'gemini-4-argon': T([{ hit: 0.1, miss: 2, out: 10, cw: 0 }]),
      'gemini-4-ar': T([{ hit: 0.1, miss: 2, out: 10, cw: 0 }]),
      // Gemini 3.8 Flash：$0.75/$3.75 为促销价（2026-12-31 前，之后 $1.50/$7.50）
      'gemini-3.8-flash': T([{ hit: 0.075, miss: 0.75, out: 3.75, cw: 0 }]),
      // Gemini 3.6 Flash：与 3.8 同价
      'gemini-3.6-flash': T([{ hit: 0.075, miss: 0.75, out: 3.75, cw: 0 }]),
      'gemini-3.5-flash-lite': T([{ hit: 0.03, miss: 0.3, out: 2.5, cw: 0 }]),
      'gemini-3.1-flash-lite': T([{ hit: 0.025, miss: 0.25, out: 1.5, cw: 0 }]),
      // Gemini 3.1 Pro（preview）：按「单次请求输入是否超过 200K」整单取档
      'gemini-3.1-pro': T([
        { maxIn: 200000, name: '<=200K', hit: 0.2, miss: 2, out: 12, cw: 0 },
        { name: '>200K', hit: 0.4, miss: 4, out: 18, cw: 0 },
      ]),
      'gemini-3-flash-preview': T([{ hit: 0.05, miss: 0.5, out: 3, cw: 0 }]),
      // Gemini 2.5 系（仍在售）：2.5 Pro 同样按 200K 整单取档
      'gemini-2.5-pro': T([
        { maxIn: 200000, name: '<=200K', hit: 0.125, miss: 1.25, out: 10, cw: 0 },
        { name: '>200K', hit: 0.25, miss: 2.5, out: 15, cw: 0 },
      ]),
      'gemini-2.5-flash': T([{ hit: 0.03, miss: 0.3, out: 2.5, cw: 0 }]),
      'gemini-2.5-flash-lite': T([{ hit: 0.01, miss: 0.1, out: 0.4, cw: 0 }]),
    },
  },
}

// 规范化模型名：去掉网关前缀（zai-org/、deepseek/ 等）并转小写
export function normalizeModelId(model) {
  const m = String(model || '').trim().toLowerCase()
  const slash = m.lastIndexOf('/')
  return slash === -1 ? m : m.slice(slash + 1)
}

// 供应商识别。返回 'deepseek' | 'glm' | 'mimo' | 'openai' | 'anthropic' | 'qwen' |
// 'minimax' | 'kimi' | 'gemini' | null（null = 不可计价，仅统计 tokens）。model 优先，provider 补充。
export function resolveVendor(providerId, modelId) {
  const m = normalizeModelId(modelId)
  if (m.indexOf('deepseek') !== -1) return 'deepseek'
  if (m.indexOf('glm') === 0) return 'glm'
  if (m.indexOf('mimo') !== -1) return 'mimo'
  if (m.indexOf('gpt') === 0 || /^o[134]([-.]|$)/.test(m) || m.indexOf('codex') !== -1) return 'openai'
  if (m.indexOf('claude') !== -1 || m.indexOf('fable') === 0) return 'anthropic'
  if (m.indexOf('qwen') !== -1) return 'qwen'
  if (m.indexOf('minimax') !== -1) return 'minimax'
  if (m.indexOf('kimi') === 0 || m.indexOf('moonshot') === 0 || /^k[23]([-.]|$)/.test(m)) return 'kimi'
  if (m.indexOf('gemini') !== -1) return 'gemini'
  const p = String(providerId || '').toLowerCase()
  if (p.indexOf('deepseek') !== -1) return 'deepseek'
  if (p.indexOf('bigmodel') !== -1 || p.indexOf('zhipu') !== -1 || p.indexOf('zai') !== -1 || p.indexOf('glm') !== -1) return 'glm'
  if (p.indexOf('mimo') !== -1 || p.indexOf('xiaomi') !== -1) return 'mimo'
  if (p.indexOf('openai') !== -1 || p.indexOf('gpt') !== -1) return 'openai'
  if (p.indexOf('anthropic') !== -1 || p.indexOf('claude') !== -1) return 'anthropic'
  if (p.indexOf('qwen') !== -1 || p.indexOf('dashscope') !== -1 || p.indexOf('bailian') !== -1) return 'qwen'
  if (p.indexOf('minimax') !== -1) return 'minimax'
  if (p.indexOf('kimi') !== -1 || p.indexOf('moonshot') !== -1) return 'kimi'
  if (p.indexOf('gemini') !== -1 || p.indexOf('google') !== -1) return 'gemini'
  return null
}

// 档位表匹配：精确名优先，其次最长前缀（覆盖带日期后缀的模型 id）。
function matchTableEntry(models, normalized) {
  if (!normalized) return null
  if (models[normalized]) return models[normalized]
  let best = ''
  for (const key of Object.keys(models)) {
    if (normalized.startsWith(key) && key.length > best.length) best = key
  }
  return best ? models[best] : null
}

function pickTier(entry, inTokens) {
  for (const tier of entry) {
    if (tier.maxIn === undefined || inTokens <= tier.maxIn) return tier
  }
  return entry[entry.length - 1]
}

function none(vendor, label, currency) {
  return { vendor, kind: 'none', hit: null, miss: null, out: null, cw: null, tier: 'none', label, currency }
}

// 统一定价解析。返回：
//   { vendor, kind, hit, miss, out, cw, tier, label, currency }
//   kind: 'peak-valley'（DeepSeek，分峰谷两档）| 'flat' | 'free' | 'none'（不可计价）
//   hit/miss/out/cw: [空闲, 高峰] 两档数组（flat/free 两档相同），none 时为 null
//   cw: 缓存写入价（省略档位默认与 miss 同价）
export function resolvePricing(opts) {
  const providerId = opts && opts.providerId
  const model = opts && opts.model
  const inTokens = Number((opts && opts.inTokens) || 0)
  const outTokens = Number((opts && opts.outTokens) || 0)
  const vendor = resolveVendor(providerId, model)
  if (!vendor) return none(null, '未知来源', null)
  if (vendor === 'deepseek') {
    // DeepSeek 价只对「模型名就是 DeepSeek」生效：仅 provider 名沾边而模型
    // 不可识别的不再套 DeepSeek 价（防止网关下的其它模型被错误计价）
    if (normalizeModelId(model).indexOf('deepseek') === -1) return none('deepseek', 'DeepSeek', 'CNY')
    const p = priceFor(model)
    return {
      vendor,
      kind: 'peak-valley',
      hit: p.hit,
      miss: p.miss,
      out: p.out,
      cw: p.miss, // 缓存写入与未命中同价（官方口径）
      tier: p === PRO_PRICE ? 'pro' : 'base',
      label: 'DeepSeek',
      currency: 'CNY',
    }
  }
  if (vendor === 'glm') {
    const fn = GLM_PRICE[normalizeModelId(model)]
    if (!fn) return none('glm', 'GLM', 'CNY')
    const v = fn(inTokens, outTokens)
    const free = v.hit === 0 && v.miss === 0 && v.out === 0
    return {
      vendor,
      kind: free ? 'free' : 'flat',
      hit: [v.hit, v.hit],
      miss: [v.miss, v.miss],
      out: [v.out, v.out],
      cw: [0, 0], // GLM 缓存存储限时免费，cacheWrite 记 0
      tier: 'flat',
      label: 'GLM',
      currency: 'CNY',
    }
  }
  const table = VENDOR_TABLES[vendor]
  const entry = matchTableEntry(table.models, normalizeModelId(model))
  if (!entry) return none(vendor, table.label, table.currency)
  const tier = pickTier(entry, inTokens)
  const hit = tier.hit || 0
  const miss = tier.miss || 0
  const out = tier.out || 0
  const cw = tier.cw !== undefined ? tier.cw : miss
  const free = hit === 0 && miss === 0 && out === 0
  return {
    vendor,
    kind: free ? 'free' : 'flat',
    hit: [hit, hit],
    miss: [miss, miss],
    out: [out, out],
    cw: [cw, cw],
    tier: tier.name || 'flat',
    label: table.label,
    currency: table.currency,
  }
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

// 下一个峰/谷切换点（epoch 秒）：从当天起最多扫 12 天的小时边界，取第一个
// 与当前状态相反的时刻。扫描与判定都走 isPeakTime，口径单一（含周末规则与
// 生效分界）；扫不到（理论不可达）兜底 +1 天，避免倒计时卡在 00:00:00。
// 小时边界从 PEAK_HOURS 展开（每段的起点与终点都是切换点），不再手写一份
// [0,9,12,14,18]：否则改时段必须同时改两处，忘了就会让倒计时与 isPeak 打架
// （审查 S2）。0 点始终是边界（跨日）。
const PEAK_EDGES = Array.from(new Set([0].concat(PEAK_HOURS.flatMap(([start, end]) => [start, end])))).sort(
  (a, b) => a - b
)

export function nextPeakChange(timeSec) {
  const sec = Math.floor(Number(timeSec))
  if (!isFinite(sec)) return null
  const cur = isPeakTime(sec)
  const day0 = Math.floor((sec + 8 * 3600) / 86400) * 86400
  for (let d = 0; d <= 12; d++) {
    const dayStartBj = day0 + d * 86400
    for (const edge of PEAK_EDGES) {
      const cand = dayStartBj + edge * 3600 - 8 * 3600
      if (cand <= sec + 1) continue
      if (isPeakTime(cand) !== cur) return cand
    }
  }
  return sec + 86400
}

// 某个模型此刻是否处于峰谷计价，以及下一次切换的时刻（毫秒）。
// 只对价目表里 kind=peak-valley 的模型返回；平价厂商返回 null，避免 UI
// 对不区分时段的模型显示「峰谷」误导用户。
export function periodFor(model, providerId, atMs = Date.now()) {
  const pricing = resolvePricing({ providerId, model })
  if (pricing.kind !== 'peak-valley') return null
  const t = isFinite(Number(atMs)) ? Number(atMs) : Date.now()
  const sec = Math.floor(t / 1000)
  const next = nextPeakChange(sec)
  return {
    isPeak: isPeakTime(sec),
    nextChangeAt: next == null ? null : next * 1000,
  }
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
// 分档：缓存读取→hit 价；未命中输入→miss 价；缓存写入→cw 价；输出与思考→out 价。
// DeepSeek 按该轮所处时段选高峰或谷价；其余厂商平价不受时段影响；不可计价供应商
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
      currency: pricing.currency,
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
  const rates = { hit: pricing.hit[idx], miss: pricing.miss[idx], out: pricing.out[idx], cw: pricing.cw[idx] }
  const amount = billable
    ? (parts.hit / 1e6) * rates.hit +
      (parts.miss / 1e6) * rates.miss +
      (parts.cacheWrite / 1e6) * rates.cw +
      ((t.output + t.reasoning) / 1e6) * rates.out
    : 0
  return {
    amount,
    currency: pricing.currency,
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
