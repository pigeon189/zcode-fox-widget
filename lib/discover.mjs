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

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}

// 本地/私有网关判定：这些地址背后的 key 不是厂商 key
function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || h === '::') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

export function matchTemplateId(parts) {
  const hay = parts.filter(Boolean).join(' ').toLowerCase()
  if (!hay) return null
  if (hay.indexOf('deepseek') !== -1) return 'deepseek'
  if (hay.indexOf('openrouter') !== -1) return 'openrouter'
  if (hay.indexOf('moonshot') !== -1 || hay.indexOf('kimi') !== -1) {
    return hay.indexOf('intl') !== -1 || hay.indexOf('international') !== -1 ? 'moonshot-intl' : 'moonshot-cn'
  }
  if (hay.indexOf('bigmodel') !== -1 || hay.indexOf('zhipu') !== -1 || hay.indexOf('zai') !== -1 || hay.indexOf('glm') !== -1) {
    return 'bigmodel-glm'
  }
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
// 多版本并存时取 revision 最大的一份。
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
          if (!cur || rev >= cur.rev) {
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
export function buildProviderEntries(opts = {}) {
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
