// 厂商凭据自动发现：从 ZCode 客户端已有的配置里找出「哪家厂商的 key 在哪个文件」，
// 供厂商模板（vendors.mjs）与 DeepSeek 余额（credentials.mjs）在请求时即时读取。
// 密钥**不复制**进挂件配置——注册表只存「来源文件 + providerId」，key 每次现读，
// 配置变更即时生效，也不会把密钥写进挂件。
//
// 数据源（按顺序，全部现读）：
//   1. $ZCODE_DATA_BASE_DIR/.zcode/v2/provider_config.json   （数据目录迁移后）
//   2. $ZCODE_HOME/v2/provider_config.json                   （迁移前默认位置）
//      结构：config.providerConfigRules.providerRules[] = { providerId, templateId,
//            providerName, config: { access: { type, apiKey }, api: { baseUrl }, modelOrder } }
//   3. 同目录的 config.json 旧式结构 provider.<id>.options（baseURL + apiKey）
//   4. $ZCODE_HOME/cli/config.json 的 provider.<id>.options（baseURL + apiKey）
//
// **有效 baseURL**：规则自带 config.api.baseUrl 时用它；缺失时按 templateId 从
// zcode-builtin.json 的 templateRules 继承（ZCode 内置模板里 deepseek 的
// api.deepseek.com、xiaomi-mimo 的 api.xiaomimimo.com 都只在模板里声明，
// 用户的 provider 规则往往不重复写 baseUrl——不继承就会漏配）。
//
// 明确跳过本地网关：baseURL 指向环回/私有地址的 provider（如 cmdgo-bridge），
// 它的 apiKey 是网关鉴权用，不是厂商 key，拿去查余额必然 401。
// enc:v1: 加密凭据无法解密，标记 keyEncrypted 跳过，不猜、不当明文用。
import fs from 'node:fs'
import path from 'node:path'
import { v2DataDirCandidates, ZCODE_HOME } from './paths.mjs'
import { isBlockedHost } from './blocked-host.mjs'

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}

// 本地/私有网关判定：这些地址背后的 key 不是厂商 key。与出站黑名单共用同一份
// 口径（lib/blocked-host.mjs，审查 P3-2）——link-local / CGNAT / 0.0.0.0/8 现在
// 也按本地网关跳过，不再把这类 provider 的 key 当厂商 key 发往真实 API。
const isLocalHost = (hostname) => isBlockedHost(hostname)

export function matchTemplateId(parts) {
  const hay = parts.filter(Boolean).join(' ').toLowerCase()
  if (!hay) return null
  if (hay.indexOf('deepseek') !== -1) return 'deepseek'
  if (hay.indexOf('openrouter') !== -1) return 'openrouter'
  // Kimi Coding 订阅用的是另一套凭据（KIMI_CODING_KEY ≠ 平台 key），凡带 coding
  // 的 kimi 先归它，剩下才是平台的 moonshot-cn/intl
  if (hay.indexOf('kimi') !== -1 && hay.indexOf('coding') !== -1) return 'kimi-coding'
  if (hay.indexOf('moonshot') !== -1 || hay.indexOf('kimi') !== -1) {
    return hay.indexOf('intl') !== -1 || hay.indexOf('international') !== -1 ? 'moonshot-intl' : 'moonshot-cn'
  }
  if (
    hay.indexOf('bigmodel') !== -1 ||
    hay.indexOf('zhipu') !== -1 ||
    hay.indexOf('zai') !== -1 ||
    hay.indexOf('z.ai') !== -1 ||
    hay.indexOf('glm') !== -1
  ) {
    // 国际站（z.ai）另有账号体系与凭据名；其余（含智谱 Coding Plan 大陆站）仍归
    // 按量的 bigmodel-glm——保持 v1.3 起的既有判定，避免凭据绑错模板
    if (hay.indexOf('intl') !== -1 || hay.indexOf('z.ai') !== -1) return 'zhipu-coding-intl'
    return 'bigmodel-glm'
  }
  // —— 与上游 DSH 版对齐补齐的厂商（vendors.mjs 同名模板）——
  if (hay.indexOf('minimax') !== -1) {
    return hay.indexOf('intl') !== -1 || hay.indexOf('international') !== -1 ? 'minimax-coding-intl' : 'minimax-coding'
  }
  if (hay.indexOf('opencode') !== -1) return 'opencode-go'
  if (hay.indexOf('stepfun') !== -1 || hay.indexOf('step-') !== -1) return 'stepfun'
  if (hay.indexOf('novita') !== -1) return 'novita'
  if (hay.indexOf('siliconflow') !== -1) {
    return hay.indexOf('intl') !== -1 || hay.indexOf('international') !== -1 ? 'siliconflow-en' : 'siliconflow-cn'
  }
  // 火山方舟只认明确关键词：`ark` 太短，'dark' 一类字符串会误命中
  if (hay.indexOf('volcengine') !== -1 || hay.indexOf('doubao') !== -1 || hay.indexOf('ark.cn-beijing') !== -1) return 'volcengine-ark'
  if (hay.indexOf('dashscope') !== -1 || hay.indexOf('qwen') !== -1 || hay.indexOf('tongyi') !== -1) return 'dashscope'
  if (hay.indexOf('qianfan') !== -1 || hay.indexOf('ernie') !== -1) return 'qianfan'
  if (hay.indexOf('hunyuan') !== -1) return 'hunyuan'
  if (hay.indexOf('spark') !== -1 || hay.indexOf('xfyun') !== -1) return 'spark'
  if (hay.indexOf('modelscope') !== -1) return 'modelscope'
  if (hay.indexOf('anthropic') !== -1 || hay.indexOf('claude') !== -1) return 'anthropic'
  if (hay.indexOf('gemini') !== -1 || hay.indexOf('google') !== -1) return 'gemini'
  if (hay.indexOf('grok') !== -1 || hay.indexOf('xai') !== -1) return 'xai'
  if (hay.indexOf('groq') !== -1) return 'groq'
  if (hay.indexOf('mistral') !== -1 || hay.indexOf('codestral') !== -1) return 'mistral'
  if (hay.indexOf('together') !== -1) return 'together'
  if (hay.indexOf('fireworks') !== -1) return 'fireworks'
  if (hay.indexOf('deepinfra') !== -1) return 'deepinfra'
  if (hay.indexOf('cerebras') !== -1) return 'cerebras'
  if (hay.indexOf('ollama') !== -1 || hay.indexOf('lmstudio') !== -1 || hay.indexOf('lm-studio') !== -1) return 'ollama'
  if (hay.indexOf('openai') !== -1) return 'openai'
  return null
}

function v2Candidates() {
  // 与 Plan 日志同一套候选（ZCODE_DATA_BASE_DIR 优先，退回 ~/.zcode/v2）
  return v2DataDirCandidates()
}

// ---------- ZCode 内置模板（templateId → 有效 baseURL） ----------
//
// <v2dir>/runtime/provider/<platform>/<version>/endpoint-*/zcode-builtin.json
// 结构：config.providerConfigRules.templateRules[] = { templateId, config: { api, access } }。
// 多版本并存时取 revision 最大的一份；revision 并列时保留先扫到的（DFS 顺序
// 不保证确定性，同版本若让后者覆盖，同一目录集合会得出不同模板）。
function loadBuiltinTemplates(v2Dirs) {
  const templates = {}
  for (const dir of v2Dirs) {
    const stack = [path.join(dir, 'runtime', 'provider')]
    while (stack.length) {
      const d = stack.pop()
      let entries
      try {
        entries = fs.readdirSync(d, { withFileTypes: true })
      } catch (err) {
        continue
      }
      for (const e of entries) {
        const fp = path.join(d, e.name)
        if (e.isDirectory()) {
          stack.push(fp)
          continue
        }
        if (e.name !== 'zcode-builtin.json') continue
        const j = readJson(fp)
        const rules =
          j && j.config && j.config.providerConfigRules && Array.isArray(j.config.providerConfigRules.templateRules)
            ? j.config.providerConfigRules.templateRules
            : []
        const rev = (j && Number(j.revision)) || 0
        for (const t of rules) {
          if (!t || typeof t.templateId !== 'string' || !t.templateId) continue
          const api = (t.config && t.config.api) || {}
          const cur = templates[t.templateId]
          if (!cur || rev > cur.rev) {
            templates[t.templateId] = {
              baseUrl: typeof api.baseUrl === 'string' ? api.baseUrl.trim() : '',
              apiType: typeof api.type === 'string' ? api.type : '',
              rev,
            }
          }
        }
      }
    }
  }
  return templates
}

// 有效 baseURL：规则自带优先，缺失时按 templateId 从内置模板继承。
export function effectiveBaseUrl(rule, templates) {
  const own = rule && rule.config && rule.config.api && rule.config.api.baseUrl
  if (typeof own === 'string' && own.trim()) return own.trim()
  const tid = rule && typeof rule.templateId === 'string' ? rule.templateId : ''
  if (tid && templates[tid] && templates[tid].baseUrl) return templates[tid].baseUrl
  return ''
}

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).hostname.toLowerCase()
  } catch (err) {
    return ''
  }
}

function normalizeKey(raw) {
  const k = typeof raw === 'string' ? raw.trim() : ''
  if (!k) return { apiKey: '', keyEncrypted: false }
  // enc:v1: 密文无法解密，不能当明文用，也不能当"没配"
  if (k.startsWith('enc:')) return { apiKey: '', keyEncrypted: true }
  return { apiKey: k, keyEncrypted: false }
}

function pushProvider(out, o) {
  const { apiKey, keyEncrypted } = normalizeKey(o.rawKey)
  out.push({
    providerId: String(o.providerId || ''),
    templateId: typeof o.templateId === 'string' ? o.templateId : '',
    providerName: typeof o.providerName === 'string' ? o.providerName : '',
    baseUrl: o.baseUrl || '',
    host: hostOf(o.baseUrl),
    apiKey,
    keyEncrypted,
    isLocal: isLocalHost(hostOf(o.baseUrl)),
    matchParts: (o.matchParts || []).filter(Boolean).map(String),
    source: o.source,
  })
}

// 枚举全部 ZCode provider 条目（key 现读；调用方负责掩码与用途过滤）。
// 参数可注入路径（测试用），默认扫描本机全部数据源。
//
// 默认路径带短 TTL 缓存：前端每 3 秒轮询 /whale/session.json，每次都要判计费源，
// 而一次全量扫描要读 2 个 provider_config.json + 2 个 config.json + cli/config.json，
// 并递归遍历 runtime/provider 目录树。这些文件只在用户改配置时变，5 秒缓存足够
// 新鲜（改配置后最迟 5 秒生效）。注入了路径的调用（测试/诊断）永远现读。
const CACHE_TTL_MS = 5000
let cacheEntries = null
let cacheAt = 0

export function invalidateDiscoverCache() {
  cacheEntries = null
  cacheAt = 0
}

export function buildProviderEntries(opts = {}) {
  const injected = !!(opts.v2Dirs || opts.templates || opts.cliConfigFile)
  if (!injected) {
    const now = Date.now()
    if (cacheEntries && now - cacheAt < CACHE_TTL_MS) return cacheEntries.slice()
  }
  const out = collectProviderEntries(opts)
  if (!injected) {
    cacheEntries = out
    cacheAt = Date.now()
    return out.slice() // 恒返回副本：调用方（含测试）改不动缓存
  }
  return out
}

function collectProviderEntries(opts = {}) {
  const v2Dirs = opts.v2Dirs || v2Candidates()
  const templates = opts.templates || loadBuiltinTemplates(v2Dirs)
  const out = []

  for (const dir of v2Dirs) {
    // 新式 provider_config.json
    const file = path.join(dir, 'provider_config.json')
    const cfg = readJson(file)
    const rules =
      cfg && cfg.config && cfg.config.providerConfigRules && Array.isArray(cfg.config.providerConfigRules.providerRules)
        ? cfg.config.providerConfigRules.providerRules
        : []
    for (const rule of rules) {
      if (!rule || rule.providerId === undefined) continue
      const access = (rule.config && rule.config.access) || {}
      pushProvider(out, {
        providerId: rule.providerId,
        templateId: rule.templateId,
        providerName: rule.providerName,
        baseUrl: effectiveBaseUrl(rule, templates),
        rawKey: access.apiKey,
        matchParts: [rule.providerId, rule.templateId, rule.providerName].concat((rule.config && rule.config.modelOrder) || []),
        source: 'v2-provider-config:' + file,
      })
    }

    // 旧式 config.json：provider.<id>.options.{baseURL, apiKey}
    const legacyFile = path.join(dir, 'config.json')
    for (const [id, opts2] of Object.entries((readJson(legacyFile) || {}).provider || {})) {
      const o = (opts2 && opts2.options) || {}
      pushProvider(out, {
        providerId: id,
        baseUrl: typeof o.baseURL === 'string' ? o.baseURL : '',
        rawKey: o.apiKey,
        matchParts: [id, hostOf(o.baseURL)],
        source: 'v2-config:' + legacyFile,
      })
    }
  }

  // cli/config.json：provider.<id>.options.{baseURL, apiKey}
  const cliFile = typeof opts.cliConfigFile === 'string' ? opts.cliConfigFile : path.join(ZCODE_HOME, 'cli', 'config.json')
  for (const [id, opts3] of Object.entries((readJson(cliFile) || {}).provider || {})) {
    const o = (opts3 && opts3.options) || {}
    pushProvider(out, {
      providerId: id,
      baseUrl: typeof o.baseURL === 'string' ? o.baseURL : '',
      rawKey: o.apiKey,
      matchParts: [id, hostOf(o.baseURL)],
      source: 'cli-provider:' + cliFile,
    })
  }

  return out
}

export function listZcodeProviders() {
  return buildProviderEntries()
}

// 按 providerId 找有效 baseURL（计费源判据用）。优先非本地条目：
// 同名 provider 既可能出现在 provider_config 也可能出现在 cli/config。
export function findProviderBaseUrl(providerId) {
  const pid = String(providerId || '')
  if (!pid) return ''
  let fallback = ''
  for (const e of buildProviderEntries()) {
    if (e.providerId !== pid) continue
    if (!e.isLocal && e.baseUrl) return e.baseUrl
    if (!fallback && e.baseUrl) fallback = e.baseUrl
  }
  return fallback
}

// 供 vendors.mjs 调用：返回 { key, source } 或 null。key 每次现读，掩码由调用方负责。
// 跳过本地网关与加密凭据——它们都不是可直接使用的厂商 key。
export function findDiscoveredKey(templateId) {
  for (const e of buildProviderEntries()) {
    if (e.isLocal || e.keyEncrypted || !e.apiKey) continue
    if (matchTemplateId(e.matchParts) === templateId) {
      return { key: e.apiKey, source: e.source + ':' + e.providerId }
    }
  }
  return null
}

// 排查用：列出发现结果（不含任何密钥内容）
export function listDiscoveries() {
  return buildProviderEntries().map((e) => ({
    templateId: matchTemplateId(e.matchParts),
    providerId: e.providerId,
    providerName: e.providerName,
    host: e.host,
    kind: e.source.split(':')[0],
    file: e.source.slice(e.source.indexOf(':') + 1),
    hasKey: !!e.apiKey,
    keyEncrypted: e.keyEncrypted,
    isLocal: e.isLocal,
  }))
}
