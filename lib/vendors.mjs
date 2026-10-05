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
import { assertSafeUpstream } from './credentials.mjs'
import { readPlanBalance } from './plan-balance.mjs'
import { getBalance } from './balance.mjs'
import { maskKey } from './credentials.mjs'
import { readCmdgoQuota } from './cmdgo.mjs'

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
    note: '套餐三重额度：月度池 + 5 小时/周窗口（凭据现读自 cmdgo 反代本地配置）',
    envKeys: ['COMMANDCODE_API_KEY'],
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
    note: '订阅窗口：读官方额度接口的已用百分比（仅 Coding Plan 账号有效）',
    envKeys: ['ZHIPU_API_KEY'],
    quota: {
      url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      host: 'open.bigmodel.cn',
      auth: '{key}',
      pick(data) {
        // 形状（上游 DSH 版同款）：data.limits[].TOKENS_LIMIT.percentage
        const limits = getPath(data, 'data.limits')
        if (!Array.isArray(limits) || !limits.length) return null
        const windows = []
        for (const l of limits) {
          const pct = num(getPath(l, 'TOKENS_LIMIT.percentage'))
          if (pct === null) continue
          windows.push({ label: 'Coding Plan', percentUsed: pct })
          break
        }
        return windows.length ? windows : null
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
    name: 'Google Gemini',
    kind: 'tokens',
    currency: 'USD',
    note: '配额只在 AI Studio / Cloud 控制台；按本机 token 用量计价',
    envKeys: ['GEMINI_API_KEY'],
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
    name: '火山方舟 Ark',
    kind: 'tokens',
    currency: 'CNY',
    note: '余额/用量需火山引擎 AK/SK 签名的 OpenAPI（或控制台），API key 查不到；按本机 token 用量计价',
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
}

// ---------- 凭据解析 ----------

// discover.mjs 在加载时注册「模板 → 本机配置文件字段引用」；这里按
// 环境变量 → 插件配置 → 发现的文件引用 的顺序取 key。只返回掩码与来源，
// 完整 key 只进 Authorization 头。
import { readPluginConfig } from './credentials.mjs'
import { findDiscoveredKey } from './discover.mjs'

export function resolveTemplateKey(templateId) {
  const tpl = TEMPLATES[templateId]
  if (!tpl) return { key: '', source: 'none' }
  for (const envName of tpl.envKeys || []) {
    const v = String(process.env[envName] || '').trim()
    if (v) return { key: v, source: 'env:' + envName }
  }
  const cfg = readPluginConfig()
  const vendorKeys = cfg && typeof cfg.vendorKeys === 'object' ? cfg.vendorKeys : null
  const fromConfig = vendorKeys && typeof vendorKeys[templateId] === 'string' ? vendorKeys[templateId].trim() : ''
  if (fromConfig) return { key: fromConfig, source: 'plugin-config' }
  const found = findDiscoveredKey(templateId)
  if (found && found.key) return { key: found.key, source: found.source }
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

async function vendorStatus(templateId, force) {
  const tpl = TEMPLATES[templateId]
  const base = { id: templateId, name: tpl.name, kind: tpl.kind, currency: tpl.currency, note: tpl.note }
  if (tpl.kind === 'local-log') {
    const plan = readPlanBalance()
    return {
      ...base,
      available: !!plan.ok,
      reason: plan.ok ? undefined : plan.reason,
      percentRemaining: plan.ok ? plan.percentRemaining : undefined,
      remaining: plan.ok ? plan.remaining : undefined,
      total: plan.ok ? plan.total : undefined,
      nextResetAt: plan.ok ? plan.nextResetAt : undefined,
      stale: plan.ok ? plan.stale : undefined,
    }
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
  if (tpl.kind === 'tokens') {
    // 按量计费：余额概念不存在，key 只决定「逐轮计价是否有凭据可用」
    const { key, source } = resolveTemplateKey(templateId)
    return { ...base, available: !!key, keySource: source, keyMasked: maskKey(key), balance: undefined }
  }
  if (tpl.kind === 'balance' && templateId === 'deepseek') {
    // DeepSeek 走 balance.mjs 的既有实现（重试/25s 缓存/瞬时失败回退）
    const payload = await getBalance()
    return {
      ...base,
      available: !!payload.ok,
      reason: payload.ok ? undefined : payload.error,
      keySource: payload.keySource,
      balance: payload.ok ? payload.totalBalance : undefined,
      todayUsage: payload.ok ? payload.todayUsage : undefined,
      stale: payload.stale,
    }
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

export async function listVendorStatus(force) {
  const out = []
  for (const id of Object.keys(TEMPLATES)) {
    try {
      out.push(await vendorStatus(id, force))
    } catch (err) {
      out.push({ id, name: TEMPLATES[id].name, kind: TEMPLATES[id].kind, available: false, reason: String((err && err.message) || err) })
    }
  }
  return { ok: true, vendors: out }
}
