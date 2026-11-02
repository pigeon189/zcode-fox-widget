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
//   bigmodel-glm 智谱按量账户（kind:balance）：现金余额读账户报表接口
//               data.availableBalance（issue #18 实测 Bearer key 可用；接口非公开
//               文档，失败时展示层退回按 token 用量计价）；套餐账户仍走 plan 百分比卡
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
import { assertSafeUpstream } from './credentials.mjs'
import { readPlanBalance, readPlanQuota } from './plan-balance.mjs'
import { shapeQuotaPayload } from './glm-plan-api.mjs'
import { getBalance } from './balance.mjs'
import { maskKey } from './credentials.mjs'
import { readCmdgoQuota } from './cmdgo.mjs'
import { readVolcPlanQuota, readVolcCredentials } from './volc-plan.mjs'
import { RELAYS, readRelayQuota, quotaCardOf } from './relays.mjs'

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
// stale / refreshReason 随条目透传（事件驱动刷新失败后缓存里是「旧值 + 标记」，
// 前端小字据此注明「余额为缓存值」——与 GLM Plan 卡的「数据截至」同一口径）。
export function pickVendorBalance(list, templateIds) {
  const arr = Array.isArray(list) ? list : list && Array.isArray(list.vendors) ? list.vendors : []
  for (const id of Array.isArray(templateIds) ? templateIds : []) {
    const v = arr.find((x) => x && x.id === id)
    if (v && v.ok === true && typeof v.balance === 'number') {
      const out = { id: v.id, amount: v.balance, currency: v.currency || 'CNY' }
      if (v.stale) out.stale = true
      if (v.refreshReason) out.refreshReason = v.refreshReason
      return out
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
    note: '套餐三重额度：月度池 + 5 小时/周窗口（凭据现读自宿主 CommandCode provider 或 cmdgo 反代本地配置）',
    envKeys: ['COMMANDCODE_API_KEY'],
  },
  'volc-plan': {
    name: '火山方舟',
    kind: 'volc',
    currency: '%',
    note: '个人版 Coding / Agent 配额分别查询（IAM AK/SK，模型调用 key 不适用）',
    envKeys: [],
  },
  'bigmodel-glm': {
    name: 'GLM（BigModel 按量）',
    // kind 从 tokens 改为 balance（issue #18）：按量账户读现金余额，套餐账户在
    // 展示层仍走 plan 百分比卡（source.mjs 在有套餐时把 GLM 源修正为 plan）。
    // 余额接口失败时 fetchFromTemplate 返回不可用，气泡退回「今日已用」口径，
    // 不冒错、不挡使用；今日已用仍按本地 token 用量 × GLM 价目计价（与 tokens 期一致）。
    kind: 'balance',
    currency: 'CNY',
    note: '现金余额（data.availableBalance，CNY）；接口不可用时按本机 token 用量计价',
    envKeys: ['BIGMODEL_API_KEY', 'ZHIPU_API_KEY'],
    balance: {
      // 账户报表接口（issue #18 实测：Bearer API key 可用；无鉴权时 HTTP 200 +
      // {code:1001}，所以必须先判 success/code 再取字段，不能只看 HTTP 状态）。
      // 该接口不在 docs.bigmodel.cn 的公开文档里（console 口径），形状可能变化：
      // 取不到就按「响应结构不符合模板」处理，由上层降级。
      url: 'https://www.bigmodel.cn/api/biz/account/query-customer-account-report',
      host: 'www.bigmodel.cn',
      auth: 'Bearer {key}',
      pick(data) {
        const d = data && data.data
        if (!data || data.success === false) return null
        if (data.code !== undefined && Number(data.code) !== 200) return null
        const amount = num(d && d.availableBalance)
        if (amount === null) return null
        return { amount, currency: 'CNY' }
      },
    },
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

async function fetchJson(url, headers, timeoutMs = 15000, fetchImpl) {
  // redirect:'error'（同 relays.mjs getJson）：模板 host 白名单只覆盖首跳，
  // 跟随重定向会跳进未校验的主机
  const doFetch = fetchImpl || fetch
  const res = await doFetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
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
// opts.fetchImpl：selftest 注入桩用（生产调用不带），与 glm-plan-api 的注入口径一致。
export async function fetchFromTemplate(tpl, key, opts = {}) {
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
    const data = await fetchJson(url, headers, opts.timeoutMs || 15000, opts.fetchImpl)
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
    const msg = String((err && err.message) || err)
    // 瞬时/确定分类（issue #18 讨论）：网络抖动、超时、5xx、429 是瞬时的，走
    // 「保留旧值 + stale」回退；4xx（鉴权/参数）与「结构不符」是确定失败，照旧
    // 计入缓存（面板在 TTL 内看到同一个原因，不每个轮询周期都打一次上游）
    const transient = !/HTTP \d{3}/.test(msg) || /HTTP (5\d\d|429)/.test(msg)
    return { ok: false, reason: msg, transient }
  }
}

// ---------- 状态汇总（/whale/vendors.json） ----------

const remoteCache = new Map() // templateId -> { at, payload }
const REMOTE_TTL_MS = 5 * 60_000
// 同一模板的并发去重（对照 balance.mjs 的 balanceInFlight）：菜单打开、/whale/vendors.json
// 轮询、cli vendors 可能同时打进来，缓存 TTL 只挡得住「先完成再来的」，挡不住并发
const remotePending = new Map() // templateId -> Promise

async function computeVendorStatus(templateId, force, opts = {}) {
  const tpl = TEMPLATES[templateId]
  const base = { id: templateId, name: tpl.name, kind: tpl.kind, currency: tpl.currency, note: tpl.note }
  if (tpl.kind === 'local-log') {
    // GLM Plan 订阅配额：与面板走同一条取源链（新鲜日志 > 直连套餐用量接口 > 过期日志）
    const plan = await readPlanQuota()
    return {
      ...base,
      available: !!plan.ok,
      reason: plan.ok ? undefined : plan.reason,
      percentRemaining: plan.ok ? plan.percentRemaining : undefined,
      remaining: plan.ok ? plan.remaining : undefined,
      total: plan.ok ? plan.total : undefined,
      nextResetAt: plan.ok ? plan.nextResetAt : undefined,
      stale: plan.ok ? plan.stale : undefined,
      source: plan.ok ? plan.source : undefined,
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
  if (tpl.kind === 'volc') {
    // 火山方舟 Coding / Agent Plan 分别查询：volc-plan.mjs 自带 45s TTL（失败同样计入）。
    // 凭据是 AK/SK 对（不走 resolveTemplateKey 的单 key 机制），只回来源与掩码
    const cred = readVolcCredentials()
    const [coding, agent] = await Promise.all([
      readVolcPlanQuota(force, 'coding'), readVolcPlanQuota(force, 'agent'),
    ])
    return {
      ...base,
      available: coding.ok || agent.ok,
      reason: coding.ok || agent.ok ? undefined : coding.reason,
      plans: { coding, agent },
      keySource: cred ? cred.source : 'none',
      keyMasked: cred ? maskKey(cred.ak) : undefined,
    }
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
  // 其余远程模板：带缓存取数。WHALE_DISABLE_VENDOR_FETCH=1 是测试与研究用的
  // 出网闸（selftest 的服务器子进程用）：此时不解缓存、不落缓存，只回键来源与
  // 「已禁用」原因，保证测试绝不把占位 key 发到真实厂商。
  const disabled = String(process.env.WHALE_DISABLE_VENDOR_FETCH || '') === '1'
  // opts.cacheStore 只给 selftest 注入桩用：测「TTL 重置 / 失败保留旧值」这类缓存
  // 行为需要带着取数桩走缓存路径（否则 useCache=false，缓存逻辑是测不到的分支），
  // 注入独立 Map 也避免污染进程内全局缓存。
  const store = opts.cacheStore || remoteCache
  const useCache = !disabled && (!opts.fetchImpl || !!opts.cacheStore)
  const cached = useCache ? store.get(templateId) : null
  // ttlMs：条目可自带更短的缓存窗（瞬时失败且无旧值时的失败载荷只押 45s，
  // 避免把「查询失败」钉死 5 分钟，重试节奏回到分钟级）；缺省用 5 分钟
  if (useCache && !force && cached && Date.now() - cached.at < (cached.ttlMs || REMOTE_TTL_MS)) {
    return { ...base, ...cached.payload, cached: true }
  }
  // opts.key 只给 selftest 的注入桩用：不给的话用例会依赖开发机上是否配过这把 key，
  // 干净的 CI（临时 ZCODE_HOME、无 vendorKeys）必然落到「未配置凭据」分支，
  // 于是同一条用例在本机能过、在 CI 必挂。
  const { key, source } = opts.key ? { key: opts.key, source: 'selftest' } : resolveTemplateKey(templateId)
  // 取数起点：写缓存时用它判断「有没有别的请求已经写入比我更新的结果」（见下）
  const startedAt = Date.now()
  let payload
  if (!key) payload = { available: false, reason: '未配置凭据（环境变量或 ~/.zcode/whale/config.json 的 vendorKeys）' }
  else if (disabled) payload = { available: false, reason: '测试环境禁用出网（WHALE_DISABLE_VENDOR_FETCH=1）' }
  else payload = await fetchFromTemplate(tpl, key, opts)
  payload.keySource = key ? source : 'none'
  payload.keyMasked = maskKey(key)
  // 归一：模板取数成功时 payload 只有 ok（pickVendorBalance 按 ok 判定），而对外
  // 视图（cli vendors / 面板）按 available 判断——不补这一笔，余额拉取成功的厂商
  // 会被显示成「不可用」。以取数结果为准，缺省时由 ok 推出 available。
  if (payload.available === undefined && payload.ok !== undefined) payload.available = !!payload.ok
  // 取数没成（available=false）分两类（issue #18 讨论，回退口径对齐 balance.mjs）：
  //   瞬时失败（网络抖动 / 超时 / 5xx / 429，fetchFromTemplate 标 transient）：
  //   不落失败载荷——调用方拿到「旧值 + stale 标记」；缓存里的现值若可用也改写为
  //   同一份带标记的载荷（at 保持该现值的原值，TTL 窗口不变）。两个不变式：
  //   回落取缓存**现值**而非函数开头的快照（取数期间普通轮询可能已写入更新的
  //   结果）；改写不得把条目 at 拉回更旧（cur.at 更新时只回传不改写，别让旧的
  //   成功值盖掉并发刚写入的确定失败原因）。
  //   确定失败（鉴权 4xx、结构不符、未配置凭据）：维持原行为——失败计入缓存，
  //   面板在 TTL 内看到同一个原因，不每个轮询周期都打一次上游。成功与确定失败
  //   的写缓存都受 startedAt 写序守卫约束：别的请求已写入更新条目时不覆盖。
  const settled = payload.available !== false
  if (useCache && !settled && payload.transient === true) {
    const cur = store.get(templateId)
    const fallback = cur && cur.payload && cur.payload.available
      ? cur
      : cached && cached.payload && cached.payload.available ? cached : null
    if (fallback) {
      const marked = { ...fallback.payload, stale: true, refreshReason: payload.reason }
      if (!cur || fallback.at >= cur.at) store.set(templateId, { at: fallback.at, payload: marked })
      return { ...base, ...marked, cached: true }
    }
    // 没有可用旧值：失败原因照常给调用方，但只押 45s 短 TTL 而不是 5 分钟——
    // 持续故障的重试节奏回到分钟级，也不会把「查询失败」钉死在缓存里
    store.set(templateId, { at: Date.now(), ttlMs: 45_000, payload })
    return { ...base, ...payload }
  }
  if (useCache) {
    const cur = store.get(templateId)
    if (!cur || cur.at <= startedAt) store.set(templateId, { at: Date.now(), payload })
  }
  return { ...base, ...payload }
}

// 单个模板的状态（带并发去重）。force=true 时跳过缓存与去重，用于菜单里的手动刷新。
// opts.fetchImpl 只给 selftest 注入桩用（有注入时不走全局并发去重，避免桩结果串到真实调用）。
function vendorStatus(templateId, force, opts = {}) {
  if (force || opts.fetchImpl) return computeVendorStatus(templateId, !!force, opts)
  const pending = remotePending.get(templateId)
  if (pending) return pending
  const task = computeVendorStatus(templateId, false).finally(() => {
    if (remotePending.get(templateId) === task) remotePending.delete(templateId)
  })
  remotePending.set(templateId, task)
  return task
}

// 事件驱动的单模板强制刷新（issue #18 讨论）：回合结束时可对 GLM 按量钱包做一次
// 直连上游的刷新，绕过 5 分钟缓存，但同一模板同一时刻只允许一个在途（forcedPending
// 与普通读取的 remotePending 相互独立——force 语义本来就不与缓存读取合流）。
// 失败语义与普通路径一致（computeVendorStatus 内统一处理）：瞬时失败回落「旧值 +
// stale」且不落失败载荷，确定失败照旧计入缓存。
// 备注：单飞合并时第二个调用者的 opts 会被忽略（返回第一个的结果）——当前唯一
// 调用方（回合触发器）的 opts 恒定相同，若未来出现不同 opts 的调用方需先收口。
const forcedPending = new Map()
export function refreshVendorStatus(templateId, opts = {}) {
  if (!TEMPLATES[templateId]) {
    return Promise.resolve({ ok: false, available: false, reason: '未知模板: ' + templateId })
  }
  const pending = forcedPending.get(templateId)
  if (pending) return pending
  const task = computeVendorStatus(templateId, true, opts).finally(() => {
    if (forcedPending.get(templateId) === task) forcedPending.delete(templateId)
  })
  forcedPending.set(templateId, task)
  return task
}

// 汇总全部模板。并发取数（原先串行 await 26 个模板，最慢的那个决定整体耗时），
// 并把整批汇总本身做 in-flight 合并。
let listInFlight = null
export async function listVendorStatus(force, opts = {}) {
  if (!force && !opts.fetchImpl && listInFlight) return listInFlight
  const task = (async () => {
    const out = await Promise.all(
      Object.keys(TEMPLATES).map(async (id) => {
        try {
          return await vendorStatus(id, force, opts)
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

