// 预付池判定：这些行「不花该厂商的按量账单」，金额记 0、tokens 照算。
//
// 口径来自 ZCode 挂件线的 lib/source.mjs（其注释记录了 2026-10-15 的真实误报：
// 同一天先走 CommandCode 再转官方 API，官方 ¥1.48 被 credit 折算的 ¥4.26 抬高成
// ¥5.73）。这里只保留「预付」这一条判据，厂商识别交给 pricing.mjs。
//
// 没搬过来的：GLM 订阅修正（要读账号套餐事实）。它需要访问 GLM API，属于宿主侧
// 的能力；没有它时 GLM 订阅用量会按按量价显示金额——已知偏差，记录在
// docs/dock/DECISIONS.md（D008）。

import { findProviderBaseUrl } from '../../engines/discover.mjs'
import { resolveBillingSource } from '../../engines/source.mjs'

export function isPrepaidRow(providerId) {
  const pid = String(providerId == null ? '' : providerId).toLowerCase()
  if (!pid) return false
  if (pid.includes('start-plan') || pid.includes('coding-plan') || pid.includes('zcode-plan')) return true
  if (pid.includes('cmdgo') || pid.includes('commandcode')) return true
  return false
}

// 与 usage-records / turn-cost 完全一致的口径链（D054 同日审计）：
// providerId 关键词 + 有效 Base URL 路径（火山 /api/coding、/api/plan 是订阅池，
// /api/v3 是按量真金白银），再叠加 GLM 订阅修正。会话列表/回合明细过去只用
// isPrepaidRow 的名字规则，且完全没做归零——GLM start plan 的 token 被按 GLM
// 按量价算成了「真金白银」（实测一个会话 ¥317.09 里 ¥280 是套餐池）。
export function isPrepaidBilling(providerId, modelId) {
  if (isPrepaidRow(providerId)) return true
  try {
    const src = resolveBillingSource(providerId, modelId, findProviderBaseUrl(providerId)).source
    return src === 'plan' || src === 'cmdgo' || src === 'volc'
  } catch (err) {
    return false
  }
}
