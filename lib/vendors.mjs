// 厂商余额/配额模板框架。
//
// 移植自上游 DSH 版的 API_TEMPLATES 思路（MIT）：每个模板声明「从哪个接口、
// 用什么鉴权、按什么字段路径取数」，框架负责凭据解析、出站校验、缓存与归一化。
// 与上游的差异：ZCode 版的模板里**不放密钥**，凭据按 discover.mjs 给出的
// 「来源文件 + 字段引用」在请求时即时读取（掩码输出），也不做面板内上传。
//
// 首批模板（见 TEMPLATES）：
//   deepseek    内置余额接口（实际取数走 balance.mjs 的既有实现，带重试/回退）
//   zcode-plan  ZCode Plan 套餐配额（kind:local-log，走 plan-balance.mjs 日志尾随）
//   bigmodel-glm 按量计费账户（kind:tokens）：无公开余额接口（已验证），逐轮按
//               GLM 价目从 token 用量计价；key 仅用于可用性判定与探活
//   openrouter  余额 = total_credits - total_usage（USD）
//   moonshot-cn / moonshot-intl  Kimi 余额（人民币/美元，两套独立账号）
//   zhipu-quota 智谱 Coding Plan 订阅窗口（kind:quota，读百分比与重置时间）
import { assertSafeUpstream } from './credentials.mjs'
import { readPlanBalance } from './plan-balance.mjs'
import { getBalance } from './balance.mjs'
import { maskKey } from './credentials.mjs'

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
    name: 'ZCode Plan',
    kind: 'local-log',
    currency: 'tokens',
    note: '套餐配额：尾随客户端日志（零密钥），剩余 tokens / 百分比',
    envKeys: [],
  },
  'bigmodel-glm': {
    name: 'GLM（BigModel 按量）',
    kind: 'tokens',
    currency: 'CNY',
    note: '按量计费：逐轮按 GLM 价目从 token 用量计价；官方无公开余额接口',
    envKeys: ['BIGMODEL_API_KEY', 'ZHIPU_API_KEY'],
    probeUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
  },
  openrouter: {
    name: 'OpenRouter',
    kind: 'balance',
    currency: 'USD',
    note: '余额 = total_credits - total_usage',
    envKeys: ['OPENROUTER_API_KEY'],
    balance: {
      url: 'https://openrouter.ai/api/v1/credits',
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

// 通用余额/配额模板取数。出站地址按模板声明的 host 逐条校验（复用
// assertSafeUpstream 的全部规则：https、拒环回/私有/保留 IP、拒 user:pass）。
async function fetchFromTemplate(tpl, key) {
  const section = tpl.kind === 'quota' ? tpl.quota : tpl.balance
  let url
  try {
    url = assertSafeUpstream(section.url, [new URL(section.url).hostname.toLowerCase()])
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
