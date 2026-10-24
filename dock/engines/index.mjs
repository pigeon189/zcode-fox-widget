// engines 的统一出口：厂商模板、余额、Plan、CommandCode、中转站、凭据链。
// daemon 只从这里 import，避免直接依赖内部文件布局。

import { maskKey, readPluginConfig, setCredentialProvider } from './credentials.mjs'
import { listZcodeProviders } from './discover.mjs'
import { TEMPLATES, fetchFromTemplate, listVendorStatus, resolveTemplateKey } from './vendors.mjs'
import { getBalance } from './balance.mjs'
import { readVolcCredentials } from './volc-plan.mjs'

export { maskKey, readPluginConfig, setCredentialProvider }
export { listZcodeProviders }
export { TEMPLATES, fetchFromTemplate, listVendorStatus, resolveTemplateKey }

export function configureEngineCredentials(provider) {
  setCredentialProvider(provider)
}

// 导入向导的候选：宿主里发现到的 key + 旧挂件配置里的 vendorKeys。
// 返回值含完整 key 供服务端复制进保险库；**路由层必须剥掉 key 再下发**。
export function discoverCandidates() {
  const out = []
  const seen = new Set()
  for (const e of listZcodeProviders()) {
    if (!e || !e.templateId || !e.apiKey) continue
    const id = String(e.templateId)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      templateId: id,
      providerId: String(e.providerId || ''),
      name: String((TEMPLATES[id] && TEMPLATES[id].name) || id),
      host: String(e.host || ''),
      source: String(e.source || '').split(':')[0],
      isLocal: !!e.isLocal,
      keyEncrypted: !!e.keyEncrypted,
      key: String(e.apiKey),
      masked: maskKey(e.apiKey),
    })
  }
  const cfg = readPluginConfig()
  for (const [templateId, key] of Object.entries(cfg.vendorKeys || {})) {
    if (!templateId || seen.has(templateId) || typeof key !== 'string' || !key.trim()) continue
    seen.add(templateId)
    out.push({
      templateId,
      providerId: '',
      name: String((TEMPLATES[templateId] && TEMPLATES[templateId].name) || templateId),
      host: '',
      source: 'legacy-config',
      isLocal: false,
      keyEncrypted: false,
      key: key.trim(),
      masked: maskKey(key.trim()),
    })
  }
  return out
}

// 把选中的候选复制进保险库。返回 { imported, skipped, errors }。
export function importCandidates(ids, vault) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String))
  const result = { imported: [], skipped: [], errors: [] }
  for (const c of discoverCandidates()) {
    if (!want.has(c.templateId)) continue
    try {
      vault.set(c.templateId, c.key)
      result.imported.push(c.templateId)
    } catch (err) {
      result.errors.push(c.templateId + ': ' + String((err && err.message) || err))
    }
  }
  for (const id of want) if (!result.imported.includes(id) && !result.errors.some((e) => e.startsWith(id + ':'))) result.skipped.push(id)
  return result
}

// 测试连接：先看凭据是否存在，再按模板声明做一次真实取数（不伪造成功）。
export async function testTemplate(templateId) {
  const id = String(templateId || '')
  const tpl = TEMPLATES[id]
  if (!tpl) return { ok: false, reason: 'unknown-template' }
  if (tpl.kind === 'cmdgo') {
    // CommandCode 的额度来自宿主 provider / 本地 cmdgo 池，不需要 API Key。
    return { ok: true, reason: 'local-quota', source: 'host-local', skipped: true, note: '使用宿主 CommandCode 本地池额度，无需 API Key' }
  }
  if (tpl.kind === 'local-log') {
    return { ok: true, reason: 'local-log', source: 'host-log', skipped: true, note: '来自宿主本地日志，无需 API Key' }
  }
  if (tpl.kind === 'volc') {
    // 火山方舟订阅配额的凭据是 IAM AK/SK 对（不是单 key），测试只探凭据在不在，
    // 不出网；真实取数走 volc-plan.mjs 的双套餐查询（厂商页刷新可见）。
    const cred = readVolcCredentials()
    return cred
      ? { ok: true, reason: 'credential-present', source: cred.source, skipped: true, note: '已检测到火山 IAM AK/SK；配额由厂商页刷新时查询，未单独发起测试' }
      : { ok: false, reason: 'no-credential', source: 'none' }
  }
  if (id === 'deepseek') {
    // DeepSeek 走 balance.mjs（重试/缓存/回退），不能按普通模板的 balance 段取数。
    const p = await getBalance()
    return p.ok
      ? { ok: true, source: p.keySource || 'host', result: { balance: p.totalBalance, currency: p.currency } }
      : { ok: false, reason: p.error || p.reason || 'request-failed', source: p.keySource || 'none' }
  }
  const { key, source } = resolveTemplateKey(id)
  if (!key) return { ok: false, reason: 'no-credential', source }
  if (tpl.kind === 'relay') {
    return { ok: true, reason: 'credential-present', source, skipped: true, note: '已检测到凭据；中转站额度由厂商取数器刷新，未单独发起测试' }
  }
  if (tpl.kind === 'tokens') return { ok: true, reason: 'credential-present', source }
  const r = await fetchFromTemplate(tpl, key)
  return r.ok ? { ok: true, source, result: r } : { ok: false, reason: r.reason || 'request-failed', source }
}
