// 厂商余额/配额模板框架。
//
// 移植自上游 DSH 版的 API_TEMPLATES 思路（MIT）：每个模板声明「从哪个接口、
// 用什么鉴权、按什么字段路径取数」，框架负责凭据解析、出站校验、缓存与归一化。
// 与上游的差异：ZCode 版的模板里**不放密钥**，凭据按 discover.mjs 给出的
// 「来源文件 + 字段引用」在请求时即时读取（掩码输出），也不做面板内上传。
//
// 模板清单（见 TEMPLATES）：
//   deepseek    内置余额接口（实际取数走 balance.mjs 的既有实现，带重试/回退）
//   zcode-plan  GLM Plan 套餐配额（kind:local-log，走 plan-balance.mjs 日志尾随；
//               template id 保留 zcode-plan，界面名 v1.7.8 起为 GLM Plan）
//   commandcode CommandCode 三重额度（kind:cmdgo，凭据现读反代本地配置）
//   bigmodel-glm 按量计费账户（kind:tokens）：无公开余额接口（已验证），逐轮按
//               GLM 价目从 token 用量计价；key 仅用于可用性判定（无探活，官方无可用接口）
//   openrouter  余额 = total_credits - total_usage（USD）
//   moonshot-cn / moonshot-intl  Kimi 余额（人民币/美元，两套独立账号）
//   zhipu-quota 智谱 Coding Plan 订阅窗口（kind:quota，读百分比与重置时间）
// v1.8.0 起与上游 DSH 版的 API_TEMPLATES 对齐补齐（上游有条目、本插件缺的那些）：
//   stepfun / novita                    可读余额
//   kimi-coding / minimax-coding / minimax-coding-intl / opencode-go / zhipu-coding-intl
//                                       可读订阅窗口
//   openai / anthropic / gemini / xai / groq / mistral / together / fireworks /
//   deepinfra / cerebras / siliconflow-cn / siliconflow-en / volcengine-ark /
//   dashscope / qianfan / hunyuan / spark / modelscope / ollama
//                                       kind:tokens（官方无 API key 查余额的口子，
//                                       只报凭据状态，金额走本机 token 用量）
//   gemini-plan               Google AI 订阅（Pro/Ultra）：连内部配额端点都已对个人
//                             订阅停服，kind:tokens + statusNote 说明「额度在官网看」
// 2026-10-23 厂商覆盖评估：补 17 家主流云/推理平台与国产厂商（azure-openai /
// aws-bedrock / google-vertex / cloudflare-workers-ai / cohere / perplexity /
// replicate / huggingface / nvidia-nim / sambanova / lambda / nebius / sensetime /
// baichuan / yi / minicpm / kunlun），统一 kind:tokens + pricing:'model'：
// 官方无公开 API-key 余额接口，只报凭据状态，金额按本机 token 匹配已有价目。
import { assertSafeUpstream } from './credentials.mjs'
import { readPlanBalance, readPlanQuota } from './plan-balance.mjs'
import { shapeQuotaPayload } from './glm-plan-api.mjs'
import { getBalance } from './balance.mjs'
import { maskKey } from './credentials.mjs'
import { readCmdgoQuota } from './cmdgo.mjs'
import { RELAYS, readRelayQuota, quotaCardOf } from './relays.mjs'
import { readVolcCredentials, readVolcPlanQuota, volcVendorStatus } from './volc-plan.mjs'

// 按字段路径取值：支持 a.b[0].c 形式；取不到返回 undefined
export function getPath(obj, dotPath) {
  if (typeof dotPath !== 'string' || !dotPath.trim()) return undefined
  const parts = dotPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let cur = obj
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = cur[p]
  }
  return cur
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// MiniMax Coding Plan 的窗口形状（国内/国际同形）：接口给的是**剩余百分比**，
// 两个 label 分别对应 5 小时窗口与本周窗口；缺哪个就只出哪个，都缺返回 null
// （返回 null 会被 fetchFromTemplate 判为「响应结构不符合模板」）。

// 从厂商模板状态列表里挑「第一个抓到余额」的模板（source→模板按优先级传入）。
// list 兼容两种形态：status 数组本身，或 listVendorStatus 的 {ok, vendors:[...]} 包装。
// 只认 ok === true 且 balance 为数字的条目（available:false / 读失败的跳过）。
export function pickVendorBalance(list, templateIds) {
  const arr = Array.isArray(list) ? list : list && Array.isArray(list.vendors) ? list.vendors : []
  for (const id of Array.isArray(templateIds) ? templateIds : []) {
    const v = arr.find((x) => x && x.id === id)
    if (v && v.ok === true && typeof v.balance === 'number') {
      return { id: v.id, amount: v.balance, currency: v.currency || 'CNY' }
    }
  }
  return null
}

// DeepSeek 余额构成（赠金 / 充值余额）：只把 payload 里真实存在的有限非负数
// 带到 vendor 状态；缺失/非法一律 null（不补 0），前端据此隐藏构成行。
// 其它厂商的 payload 没有这两个字段，因此天然不会伪造构成。
export function splitFieldsOfBalance(payload) {
  if (!payload || payload.ok !== true) {
    return { grantedBalance: null, toppedBalance: null, currency: null }
  }
  const amount = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  return {
    grantedBalance: amount(payload.grantedBalance),
    toppedBalance: amount(payload.toppedBalance),
    currency: /^[A-Z]{3,8}$/.test(String(payload.currency || '')) ? String(payload.currency) : null,
  }
}

// DeepSeek 的 vendor 状态组装（纯函数，便于单测构成透传）：
// grantedBalance/toppedBalance 缺失保持 null；currency 跟随余额接口，取不到回落模板币种。
export function deepseekVendorStatus(base, payload) {
  const split = splitFieldsOfBalance(payload)
  return {
    ...base,
    available: !!payload.ok,
    reason: payload.ok ? undefined : payload.error,
    keySource: payload.keySource,
    balance: payload.ok ? payload.totalBalance : undefined,
    ...split,
    currency: split.currency || base.currency,
    todayUsage: payload.ok ? payload.todayUsage : undefined,
    stale: payload.stale,
  }
}

function codingPlanWindows(data, intervalLabel, weeklyLabel) {
  const rows = getPath(data, 'model_remains')
  const first = Array.isArray(rows) ? rows[0] : null
  if (!first) return null
  const out = []
  const interval = num(getPath(first, 'current_interval_remaining_percent'))
  if (interval !== null) out.push({ label: intervalLabel, percentUsed: Math.round((100 - interval) * 10) / 10 })
  const weekly = num(getPath(first, 'current_weekly_remaining_percent'))
  if (weekly !== null) out.push({ label: weeklyLabel, percentUsed: Math.round((100 - weekly) * 10) / 10 })
  return out.length ? out : null
}

// ---------- 模板表 ----------

export const TEMPLATES = {
  deepseek: {
    name: 'DeepSeek',
    kind: 'balance',
    currency: 'CNY',
    note: '内置：api.deepseek.com 余额接口，带峰谷记账',
    envKeys: ['DEEPSEEK_API_KEY'],
  },
  'xiaomi-mimo': {
    name: '小米 MiMo（API 按量）',
    kind: 'tokens',
    currency: 'CNY',
    note: '小米 MiMo 开放平台按量 API；官方暂无公开余额接口，按 token 用量计价',
    envKeys: ['MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY'],
    statusNote: '官方无公开余额接口；配置 key 后按 token 用量计价',
  },
  'xiaomi-mimo-plan': {
    name: '小米 MiMo Token Plan',
    kind: 'tokens',
    currency: 'CNY',
    note: 'Token Plan 订阅（token-plan-cn.xiaomimimo.com），夜间 0.8x 消耗系数；暂无公开配额接口',
    envKeys: ['MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY'],
    keyFrom: 'xiaomi-mimo',
    statusNote: '套餐额度请在小米 MiMo 官网查看；本地按 token 用量统计',
  },
  'zcode-plan': {
    name: 'GLM Plan',
    kind: 'local-log',
    currency: 'tokens',
    note: '套餐配额：尾随客户端日志（零密钥），剩余 tokens / 百分比',
    envKeys: [],
  },
  commandcode: {
    name: 'CommandCode',
    kind: 'cmdgo',
    currency: 'USD',
    note: '套餐三重额度：月度池 + 5 小时/周窗口（凭据现读自宿主 CommandCode provider 或 cmdgo 反代本地配置）',
    envKeys: ['COMMANDCODE_API_KEY'],
  },
  'volc-plan': {
    name: '火山方舟（Coding/Agent Plan）',
    kind: 'volc',
    currency: '%',
    // 迁移自 1.x v1.16.1：Coding / Agent 两套餐分别查询与缓存，互不回退。
    // 凭据是火山 IAM AK/SK 对（模型调用的 ark- key 查不了配额），不走
    // resolveTemplateKey 的单 key 机制；按量账号看 volcengine-ark 模板。
    note: '订阅窗口：Coding（5小时/周/月百分比）与 Agent（近一天/周/月用量）分别查询官方 OpenAPI（需 IAM AK/SK，模型 key 不适用）',
    envKeys: [],
  },
  'bigmodel-glm': {
    name: 'GLM（BigModel 按量）',
    kind: 'tokens',
    currency: 'CNY',
    note: '按量计费：逐轮按 GLM 价目从 token 用量计价；官方无公开余额接口',
    envKeys: ['BIGMODEL_API_KEY', 'ZHIPU_API_KEY'],
  },
  openrouter: {
    name: 'OpenRouter',
    kind: 'balance',
    currency: 'USD',
    note: '余额 = total_credits - total_usage',
    envKeys: ['OPENROUTER_API_KEY'],
    balance: {
      url: 'https://openrouter.ai/api/v1/credits',
      host: 'openrouter.ai',
      auth: 'Bearer {key}',
      pick(data) {
        const d = data && data.data
        const credits = num(d && d.total_credits)
        const used = num(d && d.total_usage)
        if (credits === null) return null
        return { amount: credits - (used || 0), currency: 'USD' }
      },
    },
  },
  'moonshot-cn': {
    name: 'Kimi / Moonshot（国内）',
    kind: 'balance',
    currency: 'CNY',
    note: 'api.moonshot.cn 余额',
    envKeys: ['MOONSHOT_API_KEY'],
    balance: {
      url: 'https://api.moonshot.cn/v1/users/me/balance',
      host: 'api.moonshot.cn',
      auth: 'Bearer {key}',
      pick(data) {
        const d = data && data.data
        const amount = num(d && (d.available_balance !== undefined ? d.available_balance : d.balance))
        return amount === null ? null : { amount, currency: 'CNY' }
      },
    },
  },
  'moonshot-intl': {
    name: 'Kimi / Moonshot（国际）',
    kind: 'balance',
    currency: 'USD',
    note: 'api.moonshot.ai 余额（独立账号体系）',
    envKeys: ['MOONSHOT_INTL_API_KEY'],
    balance: {
      url: 'https://api.moonshot.ai/v1/users/me/balance',
      host: 'api.moonshot.ai',
      auth: 'Bearer {key}',
      pick(data) {
        const d = data && data.data
        const amount = num(d && (d.available_balance !== undefined ? d.available_balance : d.balance))
        return amount === null ? null : { amount, currency: 'USD' }
      },
    },
  },
  'zhipu-quota': {
    name: '智谱 Coding Plan',
    kind: 'quota',
    currency: '%',
    note: '订阅窗口：读官方套餐用量接口的已用百分比与剩余额度（仅 Coding Plan 账号有效）',
    envKeys: ['ZHIPU_API_KEY'],
    // 凭据走 env / vendorKeys（与既有口径一致）。宿主 provider 里配的 GLM key 由
    // discover.mjs 归到 bigmodel-glm，不在这里跨模板借用——那条链留给面板主显示的
    // 套餐源（glm-plan-api.mjs 自己解析），免得本模板在自检环境里拿 fixture 的假 key
    // 真的出网
    quota: {
      url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      host: 'open.bigmodel.cn',
      auth: '{key}',
      pick(data) {
        // 复用套餐接口的塑形（glm-plan-api.mjs）：一次收两种真实形状——
        //   A) 现役 individual-coding-plan：limits[] 平铺 { type:'CREDIT_LIMIT', unit, number,
        //      usage, currentValue, remaining, percentage, nextResetTime }
        //   B) 上游 DSH 版沿用的老形状：limits[].TOKENS_LIMIT.{percentage,remaining,total}
        // 2026-10-16 前这里只认 B，于是 A 类账号（含本机）一律「响应结构不符合模板」
        const shaped = shapeQuotaPayload(data)
        if (!shaped) return null
        return shaped.windows.map((w) => ({
          label: w.label,
          percentUsed: w.percentUsed,
          remaining: w.remaining === null ? undefined : w.remaining,
          total: w.total === null ? undefined : w.total,
          resetAt: w.resetAt || undefined,
        }))
      },
    },
  },

  // ---------- 与上游 DSH 版（dsh-whale-widget）对齐补齐的模板 ----------
  // 来源：dsh-whale-widget `lib/index.js` 的 API_TEMPLATES。补的是「上游有条目、
  // 本插件没有」的那些，接口地址与字段形状照上游口径。三类：
  //   ① 真能读出余额      → kind:'balance'
  //   ② 真能读出订阅窗口  → kind:'quota'（percentUsed 一律换算成「已用 0–100」）
  //   ③ 官方没有「用 API key 查余额」的接口 → kind:'tokens'：只报凭据是否配好、
  //      可用性看 key，金额走本机 token 用量按价目折算（与 bigmodel-glm 同一条路）。
  //      列为模板而不是干脆不列，是因为凭据发现与「为什么这个厂商没有余额」都
  //      需要它在清单里有个位置（note 会说明原因）。
  stepfun: {
    name: '阶跃星辰 StepFun',
    kind: 'balance',
    currency: 'CNY',
    note: 'api.stepfun.com /v1/accounts 余额',
    envKeys: ['STEPFUN_API_KEY'],
    balance: {
      url: 'https://api.stepfun.com/v1/accounts',
      host: 'api.stepfun.com',
      auth: 'Bearer {key}',
      pick(data) {
        const amount = num(getPath(data, 'balance'))
        return amount === null ? null : { amount, currency: 'CNY' }
      },
    },
  },
  novita: {
    name: 'Novita AI',
    kind: 'balance',
    currency: 'USD',
    note: 'api.novita.ai /v3/user/balance（原始单位为 1e-4 美元，已换算）',
    envKeys: ['NOVITA_API_KEY'],
    balance: {
      url: 'https://api.novita.ai/v3/user/balance',
      host: 'api.novita.ai',
      auth: 'Bearer {key}',
      pick(data) {
        const raw = num(getPath(data, 'availableBalance'))
        return raw === null ? null : { amount: raw / 10000, currency: 'USD' }
      },
    },
  },
  'kimi-coding': {
    name: 'Kimi Coding（订阅）',
    kind: 'quota',
    currency: '%',
    note: '订阅窗口：5 小时 + 周额度两条；接口无公开文档（社区逆向），字段宽容映射，剩余 = limit − used',
    envKeys: ['KIMI_CODING_KEY'],
    quota: {
      url: 'https://api.kimi.com/coding/v1/usages',
      host: 'api.kimi.com',
      auth: 'Bearer {key}',
      pick(data) {
        // 响应结构（2026-10-05 依 eppen/kimi-usage、LaneSun/kimi-code-usage 等社区
        // 解析器核实，字段可能变动）：usage（或 detail）= 周（7 天）窗口；
        // limits[] = 滚动窗口数组，每项 window.duration + timeUnit/unit 折算分钟，
        // 250–360 分钟即 5 小时会话窗口，明细在 row.detail（或 row 本身）。
        // 接口给 used/limit（没有稳定 remaining 字段），剩余用 limit − used 兜底。
        const firstOf = (obj, keys) => {
          for (const k of keys) {
            const v = num(obj[k])
            if (v !== null) return v
          }
          return null
        }
        const meter = (d, label) => {
          if (!d || typeof d !== 'object') return null
          const used = firstOf(d, ['used', 'usage', 'consumed'])
          const limit = firstOf(d, ['limit', 'total', 'quota'])
          let remaining = firstOf(d, ['remaining', 'left', 'remain'])
          if (remaining === null && used !== null && limit !== null) remaining = limit - used
          if (remaining === null || !limit) return null
          const usedPct = Math.max(0, Math.min(1, (limit - remaining) / limit))
          let resetAt = null
          for (const k of ['resetTime', 'reset_time', 'resetAt', 'nextResetTime']) {
            if (typeof d[k] === 'string' && d[k]) {
              resetAt = d[k]
              break
            }
          }
          return { label, percentUsed: Math.round(usedPct * 1000) / 10, resetAt }
        }
        const out = []
        const weekly = meter(data.usage || data.detail, '周额度')
        if (weekly) out.push(weekly)
        const limits = Array.isArray(data.limits) ? data.limits : []
        for (const row of limits) {
          const w = row && row.window ? row.window : null
          const dur = w ? num(w.duration) : null
          if (dur === null) continue
          const unit = String(w.timeUnit || w.unit || 'minute').toUpperCase()
          const mins =
            unit.indexOf('HOUR') !== -1 ? dur * 60 : unit.indexOf('DAY') !== -1 ? dur * 1440 : unit.indexOf('SECOND') !== -1 ? dur / 60 : dur
          if (mins >= 250 && mins <= 360) {
            const m = meter(row.detail || row, '5 小时')
            if (m) {
              out.push(m)
              break
            }
          }
        }
        return out.length ? out : null
      },
    },
  },
  'minimax-coding': {
    name: 'MiniMax Coding（订阅）',
    kind: 'quota',
    currency: '%',
    note: '订阅窗口：5 小时与本周两条（接口给的是剩余百分比，已换算成已用）',
    envKeys: ['MINIMAX_API_KEY'],
    quota: {
      url: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
      host: 'api.minimaxi.com',
      auth: 'Bearer {key}',
      pick(data) {
        return codingPlanWindows(data, '5 小时', '本周')
      },
    },
  },
  'minimax-coding-intl': {
    name: 'MiniMax Coding（国际）',
    kind: 'quota',
    currency: '%',
    note: '同国内站，独立账号体系（api.minimax.io）',
    envKeys: ['MINIMAX_INTL_API_KEY'],
    quota: {
      url: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
      host: 'api.minimax.io',
      auth: 'Bearer {key}',
      pick(data) {
        return codingPlanWindows(data, '5 小时', '本周')
      },
    },
  },
  'opencode-go': {
    name: 'OpenCode Go（订阅）',
    kind: 'quota',
    currency: '%',
    note: '订阅窗口：rolling / weekly / monthly 三条，接口直接给已用百分比',
    envKeys: ['OPENCODE_GO_API_KEY'],
    quota: {
      url: 'https://opencode.ai/zen/go/v1/usage',
      host: 'opencode.ai',
      auth: 'Bearer {key}',
      pick(data) {
        const defs = [
          ['rolling', '5 小时'],
          ['weekly', '本周'],
          ['monthly', '本月'],
        ]
        const out = []
        for (const [key, label] of defs) {
          const pct = num(getPath(data, 'usage.' + key + '.percent'))
          if (pct === null) continue
          out.push({ label, percentUsed: pct, resetAt: getPath(data, 'usage.' + key + '.resetsAt') })
        }
        return out.length ? out : null
      },
    },
  },
  'zhipu-coding-intl': {
    name: '智谱 Coding Plan（国际 z.ai）',
    kind: 'quota',
    currency: '%',
    note: '与国内站同形，域名与账号体系独立（api.z.ai）',
    envKeys: ['ZHIPU_INTL_API_KEY'],
    quota: {
      url: 'https://api.z.ai/api/monitor/usage/quota/limit',
      host: 'api.z.ai',
      auth: '{key}',
      pick(data) {
        const limits = getPath(data, 'data.limits')
        if (!Array.isArray(limits) || !limits.length) return null
        const pct = num(getPath(limits[0], 'TOKENS_LIMIT.percentage'))
        return pct === null ? null : [{ label: 'Coding Plan', percentUsed: pct }]
      },
    },
  },

  // —— ③ 官方无「用 API key 查余额」接口的厂商（kind: tokens，只报凭据状态） ——
  openai: {
    name: 'OpenAI',
    kind: 'tokens',
    currency: 'USD',
    note: '官方已下线 billing 接口，没有可用的余额查询（只能看控制台）；按本机 token 用量计价',
    envKeys: ['OPENAI_API_KEY'],
  },
  anthropic: {
    name: 'Anthropic Claude',
    kind: 'tokens',
    currency: 'USD',
    note: '官方无余额接口，用量要 Admin API（admin key）或控制台；按本机 token 用量计价',
    envKeys: ['ANTHROPIC_API_KEY'],
  },
  gemini: {
    name: 'Google Gemini（API）',
    kind: 'tokens',
    currency: 'USD',
    note: 'API key 按量计费：官方无余额接口（配额只在 AI Studio / Cloud 控制台）；按本机 token 用量计价',
    envKeys: ['GEMINI_API_KEY'],
  },
  'gemini-plan': {
    name: 'Gemini 订阅（AI Pro/Ultra）',
    kind: 'tokens',
    currency: 'USD',
    // 订阅额度没有任何公开查询接口（Gemini CLI 用的 cloudcode-pa 内部端点已从
    // 2026-06 起停止对个人订阅服务，见 developers.google.com 的 deprecations）。
    // 列为模板与 openai 同理：凭据发现需要它在清单里有位置；额度只能去
    // gemini.google.com 账户页看，本插件的卡片只承载本机用量折算。
    statusNote:
      '官方无公开的订阅余额接口（Google AI Pro / Ultra 的额度在 gemini.google.com 账户页看），无法显示订阅余量；本行只提供本机用量折算的挂载点',
    envKeys: [],
  },
  xai: {
    name: 'xAI Grok',
    kind: 'tokens',
    currency: 'USD',
    note: '官方无公开余额接口（额度在 console.x.ai）；按本机 token 用量计价',
    envKeys: ['XAI_API_KEY'],
  },
  groq: {
    name: 'Groq',
    kind: 'tokens',
    currency: 'USD',
    note: '官方无余额接口（免费额度/速率在控制台看）；按本机 token 用量计价',
    envKeys: ['GROQ_API_KEY'],
  },
  mistral: {
    name: 'Mistral AI',
    kind: 'tokens',
    currency: 'USD',
    note: '官方无余额接口；按本机 token 用量计价',
    envKeys: ['MISTRAL_API_KEY'],
  },
  together: {
    name: 'Together AI',
    kind: 'tokens',
    currency: 'USD',
    note: '官方无余额接口；按本机 token 用量计价',
    envKeys: ['TOGETHER_API_KEY'],
  },
  fireworks: {
    name: 'Fireworks AI',
    kind: 'tokens',
    currency: 'USD',
    note: '官方无余额接口；按本机 token 用量计价',
    envKeys: ['FIREWORKS_API_KEY'],
  },
  deepinfra: {
    name: 'DeepInfra',
    kind: 'tokens',
    currency: 'USD',
    note: '官方无余额接口；按本机 token 用量计价',
    envKeys: ['DEEPINFRA_API_KEY'],
  },
  cerebras: {
    name: 'Cerebras',
    kind: 'tokens',
    currency: 'USD',
    note: '官方无余额接口；按本机 token 用量计价',
    envKeys: ['CEREBRAS_API_KEY'],
  },
  'siliconflow-cn': {
    name: '硅基流动（CN）',
    kind: 'tokens',
    currency: 'CNY',
    note: '官方已于 2026-08-14 停止 /user/info 余额接口（公告称后续提供替代 API，暂未上线）；按本机 token 用量计价',
    envKeys: ['SILICONFLOW_API_KEY'],
  },
  'siliconflow-en': {
    name: '硅基流动（EN）',
    kind: 'tokens',
    currency: 'USD',
    note: '同国内站：余额接口已停止服务（国际站文档尚未同步）；按本机 token 用量计价',
    envKeys: ['SILICONFLOW_API_KEY'],
  },
  'volcengine-ark': {
    name: '火山方舟 Ark（按量）',
    kind: 'tokens',
    currency: 'CNY',
    // 与 volc-plan（订阅窗口）分流：本卡只承载按量口径——余额/账单需火山引擎
    // AK/SK 签名的 OpenAPI（或控制台），模型 key 查不到，金额按本机 token 用量
    // 计价（/api/v3 接入）；订阅接入（/api/coding、/api/plan）的金额在计费层
    // 记 0（见 engines/source.mjs），配额看「火山方舟（Coding/Agent Plan）」卡。
    note: '按量计费：余额需火山引擎 AK/SK 签名的 OpenAPI（或控制台），API key 查不到；按本机 token 用量计价。订阅额度看「火山方舟（Coding/Agent Plan）」卡',
    envKeys: ['ARK_API_KEY'],
  },
  dashscope: {
    name: '阿里云百炼（通义千问）',
    kind: 'tokens',
    currency: 'CNY',
    note: '云厂商：余额/账单走阿里云 AK/SK OpenAPI（或控制台）；按本机 token 用量计价',
    envKeys: ['DASHSCOPE_API_KEY'],
  },
  qianfan: {
    name: '百度千帆（文心）',
    kind: 'tokens',
    currency: 'CNY',
    note: '云厂商：余额/账单走百度云 AK/SK（或控制台）；按本机 token 用量计价',
    envKeys: ['QIANFAN_API_KEY'],
  },
  hunyuan: {
    name: '腾讯混元',
    kind: 'tokens',
    currency: 'CNY',
    note: '云厂商：余额/账单走腾讯云 SecretId/Key（或控制台）；按本机 token 用量计价',
    envKeys: ['HUNYUAN_API_KEY'],
  },
  spark: {
    name: '讯飞星火',
    kind: 'tokens',
    currency: 'CNY',
    note: '官方无余额接口（额度在控制台）；按本机 token 用量计价',
    envKeys: ['SPARK_API_KEY'],
  },
  modelscope: {
    name: '魔搭 ModelScope',
    kind: 'tokens',
    currency: 'CNY',
    note: '官方无余额接口；按本机 token 用量计价',
    envKeys: ['MODELSCOPE_API_KEY'],
  },
  ollama: {
    name: '本地模型（Ollama / LM Studio）',
    kind: 'tokens',
    currency: 'CNY',
    note: '本地推理，无余额概念（不计价，只统计 token）',
    envKeys: [],
  },

  // —— ④ 厂商覆盖评估（2026-10-23）：主流云/推理平台与国产厂商 ——
  // 这些厂商官方都没有「用 API key 查余额」的公开接口，统一 kind:'tokens'：
  // 只报凭据是否配置，金额按本机 token 用量匹配既有价目折算；模型不在价目表
  // 时计价层给 null + unavailable，不补 0。模板不声明 balance/quota/relay 段，
  // 因此不会产生任何出站请求。
  // pricing:'model' = 仅当模型名能匹配已有价目家族时才计价（见 engines/pricing.mjs），
  // 不新增价目、不做汇率换算。
  'azure-openai': {
    name: 'Azure OpenAI',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（账单在 Azure Portal）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；仅用于凭据状态与本机 token 计价',
    envKeys: ['AZURE_OPENAI_API_KEY'],
  },
  'aws-bedrock': {
    name: 'AWS Bedrock',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（Cost Explorer/账单需 AWS 签名）；按本机 token 用量计价',
    statusNote:
      '官方无公开 API-key 余额接口；可用 Bedrock API Key（AWS_BEARER_TOKEN_BEDROCK）判断凭据，仅用于凭据状态与本机 token 计价；标准 AWS_ACCESS_KEY_ID/SECRET 不当作单个 API key',
    // 只认真正的 API key/token。AWS_ACCESS_KEY_ID / SECRET 不是单一密钥，
    // 拿来判「已配置」会把只需 AWS CLI 凭据的机器误标，且掩码会显示密钥片段。
    envKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  'google-vertex': {
    name: 'Google Vertex AI',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（配额/账单在 Google Cloud 控制台）；按本机 token 用量计价',
    statusNote:
      '官方无公开 API-key 余额接口；支持 API key（GOOGLE_VERTEX_API_KEY）判断凭据，仅用于凭据状态与本机 token 计价；服务账号文件路径不当作 API key',
    // GOOGLE_APPLICATION_CREDENTIALS 是凭据文件路径，不是 key；显示它的掩码
    // 既会误报「已配置」，也会暴露路径片段。
    envKeys: ['GOOGLE_VERTEX_API_KEY'],
  },
  'cloudflare-workers-ai': {
    name: 'Cloudflare Workers AI',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（用量在 Cloudflare 控制台）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；需 API Token（CLOUDFLARE_API_TOKEN）判断凭据，账户 ID 不当作 API key，仅用于凭据状态与本机 token 计价',
    // CLOUDFLARE_ACCOUNT_ID 是账户标识，不是令牌。
    envKeys: ['CLOUDFLARE_API_TOKEN'],
  },
  cohere: {
    name: 'Cohere',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（用量在 Cohere Dashboard）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；仅用于凭据状态与本机 token 计价',
    envKeys: ['COHERE_API_KEY'],
  },
  perplexity: {
    name: 'Perplexity',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（用量在 Perplexity Dashboard）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；仅用于凭据状态与本机 token 计价',
    envKeys: ['PERPLEXITY_API_KEY'],
  },
  replicate: {
    name: 'Replicate',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（账单在 Replicate Dashboard）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；仅用于凭据状态与本机 token 计价',
    envKeys: ['REPLICATE_API_TOKEN'],
  },
  huggingface: {
    name: 'Hugging Face',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（额度/账单在 Hugging Face 账户页）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；HF_TOKEN / HUGGING_FACE_HUB_TOKEN 仅用于凭据状态与本机 token 计价',
    envKeys: ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'],
  },
  'nvidia-nim': {
    name: 'NVIDIA NIM',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（额度在 build.nvidia.com）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；仅用于凭据状态与本机 token 计价',
    envKeys: ['NVIDIA_API_KEY'],
  },
  sambanova: {
    name: 'SambaNova',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（用量在 SambaNova Cloud）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；仅用于凭据状态与本机 token 计价',
    envKeys: ['SAMBANOVA_API_KEY'],
  },
  lambda: {
    name: 'Lambda',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（账单在 Lambda 控制台）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；仅用于凭据状态与本机 token 计价',
    envKeys: ['LAMBDA_API_KEY'],
  },
  nebius: {
    name: 'Nebius AI Studio',
    kind: 'tokens',
    currency: 'USD',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（用量在 Nebius 控制台）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；仅用于凭据状态与本机 token 计价',
    envKeys: ['NEBIUS_API_KEY'],
  },
  sensetime: {
    name: '商汤日日新 SenseNova',
    kind: 'tokens',
    currency: 'CNY',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（额度在商汤控制台）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；环境变量按官方 SDK 习惯取 SENSENOVA_API_KEY（兼容 SENSETIME_API_KEY），仅用于凭据状态与本机 token 计价',
    envKeys: ['SENSENOVA_API_KEY', 'SENSETIME_API_KEY'],
  },
  baichuan: {
    name: '百川智能 Baichuan',
    kind: 'tokens',
    currency: 'CNY',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（额度在百川控制台）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；仅用于凭据状态与本机 token 计价',
    envKeys: ['BAICHUAN_API_KEY'],
  },
  yi: {
    name: '零一万物 Yi',
    kind: 'tokens',
    currency: 'CNY',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（额度在零一万物控制台）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；YI_API_KEY（兼容 LINGYIWANWU_API_KEY）仅用于凭据状态与本机 token 计价',
    envKeys: ['YI_API_KEY', 'LINGYIWANWU_API_KEY'],
  },
  minicpm: {
    name: '面壁智能 MiniCPM',
    kind: 'tokens',
    currency: 'CNY',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（额度在面壁 ModelBest 控制台）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；MODELBEST_API_KEY（兼容 MINICPM_API_KEY）仅用于凭据状态与本机 token 计价',
    envKeys: ['MODELBEST_API_KEY', 'MINICPM_API_KEY'],
  },
  kunlun: {
    name: '昆仑万维天工',
    kind: 'tokens',
    currency: 'CNY',
    pricing: 'model',
    note: '官方无公开 API-key 余额接口（额度在天工控制台）；按本机 token 用量计价',
    statusNote: '官方无公开 API-key 余额接口；KUNLUN_API_KEY（兼容 SKYWORK_API_KEY）仅用于凭据状态与本机 token 计价',
    envKeys: ['KUNLUN_API_KEY', 'SKYWORK_API_KEY'],
  },
}

// 中转站模板：每个站点一个（kind:'relay'），额度取数与展示形状由 relays.mjs
// 按平台决定（New API 余额 / Sub2API 窗口 / Cubence 余额+5 小时）。
for (const relay of RELAYS) {
  TEMPLATES['relay-' + relay.id] = {
    name: relay.name,
    kind: 'relay',
    currency: 'USD',
    note: relay.note,
    envKeys: [],
    relay,
  }
}

// 凭据优先级（D022）：环境变量 → dock 保险库 → 宿主发现 → 旧配置导入。
// 只返回掩码与来源，完整 key 只进 Authorization 头。
import { getVaultKey, readPluginConfig } from './credentials.mjs'
import { findDiscoveredKey } from './discover.mjs'

export function resolveTemplateKey(templateId) {
  const tpl = TEMPLATES[templateId]
  if (!tpl) return { key: '', source: 'none' }
  const keyId = tpl.keyFrom || templateId
  for (const envName of tpl.envKeys || []) {
    const v = String(process.env[envName] || '').trim()
    if (v) return { key: v, source: 'env:' + envName }
  }
  const fromVault = getVaultKey(keyId)
  if (fromVault) return { key: fromVault, source: 'vault' }
  const found = findDiscoveredKey(keyId)
  if (found && found.key) return { key: found.key, source: found.source }
  const cfg = readPluginConfig()
  const vendorKeys = cfg && typeof cfg.vendorKeys === 'object' ? cfg.vendorKeys : null
  const fromConfig = vendorKeys && typeof vendorKeys[keyId] === 'string' ? vendorKeys[keyId].trim() : ''
  if (fromConfig) return { key: fromConfig, source: 'legacy-config' }
  return { key: '', source: 'none' }
}

// ---------- 取数 ----------

async function fetchJson(url, headers, timeoutMs = 15000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error('响应不是合法 JSON')
  }
}

// 通用余额/配额模板取数。出站地址按模板**显式声明**的 host 逐条校验（复用
// assertSafeUpstream 的全部规则：https、拒环回/私有/保留 IP、拒 user:pass）。
//
// host 必须是模板里的独立常量，不能从 url 现算——传 `new URL(section.url).hostname`
// 等于让 URL 自证清白，白名单校验会退化成只查协议/私有 IP，将来放开自定义 URL
// 即成 SSRF 通道（v1.3.0 复审 S2）。缺 host 视为模板不合格，直接拒绝取数。
// 导出供 selftest 校验白名单行为（不触发真实出站：白名单不过就没有 fetch）。
export async function fetchFromTemplate(tpl, key) {
  const section = tpl.kind === 'quota' ? tpl.quota : tpl.balance
  const host = typeof section.host === 'string' ? section.host.trim().toLowerCase() : ''
  if (!host) return { ok: false, reason: '模板未声明 host 白名单' }
  let url
  try {
    url = assertSafeUpstream(section.url, [host])
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
  let headers = {}
  if (key && section.auth) {
    headers = { Authorization: section.auth.replace('{key}', key) }
  }
  try {
    const data = await fetchJson(url, headers)
    if (tpl.kind === 'quota') {
      const windows = section.pick(data)
      if (!windows) return { ok: false, reason: '响应结构不符合模板' }
      return { ok: true, kind: 'quota', windows }
    }
    const picked = section.pick(data)
    if (!picked || !Number.isFinite(Number(picked.amount))) {
      return { ok: false, reason: '响应结构不符合模板' }
    }
    return { ok: true, kind: 'balance', balance: Number(picked.amount), currency: picked.currency }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

// ---------- 状态汇总（/whale/vendors.json） ----------

const remoteCache = new Map() // templateId -> { at, payload }
const REMOTE_TTL_MS = 5 * 60_000
// 同一模板的并发去重（对照 balance.mjs 的 balanceInFlight）：菜单打开、/whale/vendors.json
// 轮询、cli vendors 可能同时打进来，缓存 TTL 只挡得住「先完成再来的」，挡不住并发
const remotePending = new Map() // templateId -> Promise

// GLM Plan（local-log 模板）的 vendor 状态组装（纯函数，便于单测）。
// 口径换算：plan 引擎（plan-balance / glm-plan-api）的 percentRemaining 是 0–1 的
// **比例**（与 1.x 线 lib/glm-plan-api.mjs 的文档口径一致，1.x 面板在展示层 ×100），
// 而 vendor 状态 / UI 的契约是 **0–100 百分数**——quota/overview 页
// （fmtPct(v.percentRemaining)、100−v.percentRemaining）、zcode 快照
// （adapters/zcode/index.mjs 的 remainingPct/usedPct）与夹具场景
// （test/fixtures/scenes/*.json 的 percentRemaining:72/88）都按百分数消费。
// 漏掉这步换算时 500M/500M 的满额度会显示成「1% 剩余」（比例 1.0 被当成 1%）。
// percentRemaining 缺失（total 不可得等）保持 undefined，绝不编 0。
export function planVendorStatus(base, plan) {
  const ok = !!(plan && plan.ok)
  const ratio = ok && plan.percentRemaining != null ? Number(plan.percentRemaining) : NaN
  const percentRemaining = Number.isFinite(ratio) ? Math.round(ratio * 1000) / 10 : undefined
  return {
    ...base,
    available: ok,
    reason: ok ? undefined : plan.reason,
    percentRemaining: ok ? percentRemaining : undefined,
    remaining: ok ? plan.remaining : undefined,
    total: ok ? plan.total : undefined,
    nextResetAt: ok ? plan.nextResetAt : undefined,
    stale: ok ? plan.stale : undefined,
    source: ok ? plan.source : undefined,
    // 逐模型配额桶（日志源才有）：GLM 赠送池按模型分开记账（如 GLM-5.3 2 亿 +
    // GLM-5.3-Flash 3 亿），汇总数会掩盖单模型的告急，原样透出给额度页分行展示。
    byModel:
      ok && Array.isArray(plan.byModel) && plan.byModel.length
        ? plan.byModel.map((b) => ({
            model: b.model,
            showName: b.showName || b.model,
            remainingUnits: b.remainingUnits,
            totalUnits: b.totalUnits,
            usedUnits: b.usedUnits,
          }))
        : undefined,
  }
}

async function computeVendorStatus(templateId, force) {
  const tpl = TEMPLATES[templateId]
  const base = { id: templateId, name: tpl.name, kind: tpl.kind, currency: tpl.currency, note: tpl.note }
  if (tpl.kind === 'local-log') {
    // GLM Plan 订阅配额：与面板走同一条取源链（新鲜日志 > 直连套餐用量接口 > 过期日志）
    return planVendorStatus(base, await readPlanQuota())
  }
  if (tpl.kind === 'cmdgo') {
    // CommandCode 三重额度：cmdgo.mjs 自带每凭据 60s TTL，这里不另做缓存
    const q = await readCmdgoQuota(force)
    return {
      ...base,
      available: !!q.ok,
      reason: q.ok ? undefined : q.reason,
      account: q.ok ? q.userName : undefined,
      pool: q.pool,
      planName: q.ok ? q.plan : undefined,
      monthly: q.ok ? q.monthly : undefined,
      fiveHour: q.ok ? q.fiveHour : undefined,
      weekly: q.ok ? q.weekly : undefined,
      limited: q.ok ? q.limited : undefined,
    }
  }
  if (tpl.kind === 'volc') {
    // 火山方舟 Coding / Agent Plan 分别查询：volc-plan.mjs 自带 45s TTL（失败同样
    // 计入）。凭据是 IAM AK/SK 对（不走 resolveTemplateKey 的单 key 机制），只回
    // 来源与掩码；两套餐查询失败互不串台。
    const cred = readVolcCredentials()
    const [coding, agent] = await Promise.all([readVolcPlanQuota(force, 'coding'), readVolcPlanQuota(force, 'agent')])
    return volcVendorStatus(base, coding, agent, cred)
  }
  if (tpl.kind === 'relay') {
    // 中转站：relays.mjs 自带 45s TTL 与并发合并；这里只把归一化结果摊给菜单。
    const q = await readRelayQuota(tpl.relay)
    return {
      ...base,
      available: !!q.ok,
      reason: q.ok ? undefined : q.reason,
      balance: q.ok && q.balance ? q.balance.remaining : undefined,
      currency: q.ok ? q.currency : undefined,
      windows: q.ok ? q.windows : undefined,
      card: quotaCardOf(q),
      source: q.ok ? q.source : undefined,
    }
  }
  if (tpl.kind === 'tokens') {
    // 按量计费：余额概念不存在，key 只决定「逐轮计价是否有凭据可用」。
    // statusNote：模板声明了「无凭据也可解释清楚」的固定状态文案时用它
    //（如 Gemini 订阅——官方压根没有查询接口，「未配置凭据」不是故障）
    const { key, source } = resolveTemplateKey(templateId)
    return {
      ...base,
      available: !!key,
      keySource: source,
      keyMasked: maskKey(key),
      balance: undefined,
      reason: !key && tpl.statusNote ? tpl.statusNote : undefined,
    }
  }
  if (tpl.kind === 'balance' && templateId === 'deepseek') {
    // DeepSeek 走 balance.mjs 的既有实现（重试/25s 缓存/瞬时失败回退）
    return deepseekVendorStatus(base, await getBalance())
  }
  // 其余远程模板：带缓存取数
  const cached = remoteCache.get(templateId)
  if (!force && cached && Date.now() - cached.at < REMOTE_TTL_MS) {
    return { ...base, ...cached.payload, cached: true }
  }
  const { key, source } = resolveTemplateKey(templateId)
  let payload
  if (!key) payload = { available: false, reason: '未配置凭据（环境变量或 ~/.zcode/whale/config.json 的 vendorKeys）' }
  else payload = await fetchFromTemplate(tpl, key)
  payload.keySource = key ? source : 'none'
  payload.keyMasked = maskKey(key)
  remoteCache.set(templateId, { at: Date.now(), payload })
  return { ...base, ...payload }
}

// 单个模板的状态（带并发去重）。force=true 时跳过缓存与去重，用于菜单里的手动刷新。
function vendorStatus(templateId, force) {
  if (force) return computeVendorStatus(templateId, true)
  const pending = remotePending.get(templateId)
  if (pending) return pending
  const task = computeVendorStatus(templateId, false).finally(() => {
    if (remotePending.get(templateId) === task) remotePending.delete(templateId)
  })
  remotePending.set(templateId, task)
  return task
}

// 汇总全部模板。并发取数（原先串行 await 26 个模板，最慢的那个决定整体耗时），
// 并把整批汇总本身做 in-flight 合并。
let listInFlight = null
export async function listVendorStatus(force) {
  if (!force && listInFlight) return listInFlight
  const task = (async () => {
    const out = await Promise.all(
      Object.keys(TEMPLATES).map(async (id) => {
        try {
          return await vendorStatus(id, force)
        } catch (err) {
          return { id, name: TEMPLATES[id].name, kind: TEMPLATES[id].kind, available: false, reason: String((err && err.message) || err) }
        }
      })
    )
    return { ok: true, vendors: out }
  })().finally(() => {
    if (listInFlight === task) listInFlight = null
  })
  listInFlight = task
  return task
}
