// 预付池判定：这些行「不花该厂商的按量账单」，金额记 0、tokens 照算。
//
// 口径来自 ZCode 挂件线的 lib/source.mjs（其注释记录了 2026-10-15 的真实误报：
// 同一天先走 CommandCode 再转官方 API，官方 ¥1.48 被 credit 折算的 ¥4.26 抬高成
// ¥5.73）。这里只保留「预付」这一条判据，厂商识别交给 pricing.mjs。
//
// 没搬过来的：GLM 订阅修正（要读账号套餐事实）。它需要访问 GLM API，属于宿主侧
// 的能力；没有它时 GLM 订阅用量会按按量价显示金额——已知偏差，记录在
// docs/dock/DECISIONS.md（D008）。

export function isPrepaidRow(providerId) {
  const pid = String(providerId == null ? '' : providerId).toLowerCase()
  if (!pid) return false
  if (pid.includes('start-plan') || pid.includes('coding-plan') || pid.includes('zcode-plan')) return true
  if (pid.includes('cmdgo') || pid.includes('commandcode')) return true
  return false
}
