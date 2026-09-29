// 厂商凭据自动发现：从 ZCode 客户端已有的配置里找出「哪家厂商的 key 在哪个文件」，
// 供厂商模板（vendors.mjs）在请求时即时读取。密钥**不复制**进挂件配置——注册表只存
// 「来源文件 + providerId」，key 每次现读，配置变更即时生效，也不会把密钥写进挂件。
//
// 数据源（按顺序）：
//   1. $ZCODE_DATA_BASE_DIR/.zcode/v2/provider_config.json   （数据目录迁移后）
//   2. $ZCODE_HOME/v2/provider_config.json                   （迁移前默认位置）
//      结构：config.providerConfigRules.providerRules[] = { providerId, templateId,
//            providerName, config: { access: { type, apiKey }, api: { baseUrl }, modelOrder } }
//   3. $ZCODE_HOME/cli/config.json 的 provider.<id>.options（baseURL + apiKey）
//
// 匹配规则：providerId/templateId/providerName/modelOrder 拼起来做关键词匹配
// （deepseek / openrouter / moonshot|kimi / bigmodel|zhipu|glm|zai）。
// 明确跳过本地网关：baseURL 指向环回/私有地址的 provider（如 cmdgo-bridge），
// 它的 apiKey 是网关鉴权用，不是厂商 key，拿去查余额必然 401。
import fs from 'node:fs'
import path from 'node:path'
import { v2DataDirCandidates, ZCODE_HOME } from './paths.mjs'

const CACHE_TTL_MS = 10_000
let cache = { at: 0, map: null }

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

// 扫描各来源，产出 { templateId: { kind, file, providerId, baseUrl } }。
// 同一模板只记录第一个命中（后发现的来源不覆盖）。
function buildDiscoveredMap() {
  const map = {}
  const put = (templateId, entry) => {
    if (templateId && !map[templateId]) map[templateId] = entry
  }

  for (const dir of v2Candidates()) {
    const file = path.join(dir, 'provider_config.json')
    const cfg = readJson(file)
    const rules =
      cfg && cfg.config && cfg.config.providerConfigRules && Array.isArray(cfg.config.providerConfigRules.providerRules)
        ? cfg.config.providerConfigRules.providerRules
        : []
    for (const rule of rules) {
      if (!rule || rule.providerId === undefined) continue
      const access = rule.config && rule.config.access
      if (!access || access.type !== 'api-key' || typeof access.apiKey !== 'string' || !access.apiKey.trim()) continue
      const baseUrl = (rule.config && rule.config.api && rule.config.api.baseUrl) || ''
      if (baseUrl) {
        try {
          if (isLocalHost(new URL(baseUrl).hostname)) continue
        } catch (err) {}
      }
      const templateId = matchTemplateId([rule.providerId, rule.templateId, rule.providerName].concat((rule.config && rule.config.modelOrder) || []))
      if (templateId) put(templateId, { kind: 'v2-provider-config', file, providerId: rule.providerId })
    }
  }

  const cliFile = path.join(ZCODE_HOME, 'cli', 'config.json')
  const cliCfg = readJson(cliFile)
  const providers = cliCfg && cliCfg.provider && typeof cliCfg.provider === 'object' ? cliCfg.provider : null
  for (const id of Object.keys(providers || {})) {
    const p = providers[id]
    const opts = p && p.options && typeof p.options === 'object' ? p.options : null
    if (!opts || typeof opts.apiKey !== 'string' || !opts.apiKey.trim()) continue
    let host = ''
    try {
      host = new URL(String(opts.baseURL || '')).hostname.toLowerCase()
    } catch (err) {
      continue
    }
    if (!host || isLocalHost(host)) continue
    const templateId = matchTemplateId([id, host])
    if (templateId) put(templateId, { kind: 'cli-provider', file: cliFile, providerId: id })
  }

  return map
}

function discoveredMap() {
  if (cache.map && Date.now() - cache.at < CACHE_TTL_MS) return cache.map
  cache = { at: Date.now(), map: buildDiscoveredMap() }
  return cache.map
}

// 供 vendors.mjs 调用：返回 { key, source } 或 null。key 每次现读，掩码由调用方负责。
export function findDiscoveredKey(templateId) {
  const entry = discoveredMap()[templateId]
  if (!entry) return null
  let key = ''
  if (entry.kind === 'v2-provider-config') {
    const cfg = readJson(entry.file)
    const rules =
      cfg && cfg.config && cfg.config.providerConfigRules && Array.isArray(cfg.config.providerConfigRules.providerRules)
        ? cfg.config.providerConfigRules.providerRules
        : []
    const rule = rules.find((r) => r && r.providerId === entry.providerId)
    key = rule && rule.config && rule.config.access ? String(rule.config.access.apiKey || '').trim() : ''
  } else if (entry.kind === 'cli-provider') {
    const cfg = readJson(entry.file)
    const p = cfg && cfg.provider && cfg.provider[entry.providerId]
    key = p && p.options ? String(p.options.apiKey || '').trim() : ''
  }
  if (!key) return null
  return { key, source: entry.kind + ':' + entry.providerId }
}

// 排查用：列出发现结果（不含任何密钥内容）
export function listDiscoveries() {
  const map = discoveredMap()
  return Object.keys(map).map((templateId) => ({ templateId, ...map[templateId], kind: map[templateId].kind }))
}
