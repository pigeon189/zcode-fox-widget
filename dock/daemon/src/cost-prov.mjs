// 计价结果的 provenance 包装（D033）。
//
// engines/pricing.mjs 是挂件线 lib/ 的逐字节副本（D007），不许改。所以来源
// 标签只能在这里加：调用 costOfUsage() 后包一层，附 estimated/pricing-table，
// 并带上价目快照日期。包装层不改入参（单测断言）。

import { prov } from '../../shared/provenance.mjs'
import { PRICING_SNAPSHOT_DATE } from '../../shared/pricing-meta.mjs'

// 价目快照日期：pricing.mjs 没有导出常量（只有 PRICING 表）。改动价目时必须
// 同步改 shared/pricing-meta.mjs；provenance 单测会提醒复核。
export { PRICING_SNAPSHOT_DATE }

export function pricingProv(ctx = {}) {
  const peak = ctx.peak === true
  const tier = ctx.tier && ctx.tier !== 'none' && ctx.tier !== 'free' ? '/' + ctx.tier : ''
  const vendor = ctx.vendorLabel || ctx.vendor || 'unknown'
  return prov(
    'estimated',
    'pricing-table',
    'pricing:' + PRICING_SNAPSHOT_DATE + ' ' + vendor + (peak ? ' 峰' : ' 谷') + tier,
    {
      asOf: ctx.asOf,
      note: '价目快照 ' + PRICING_SNAPSHOT_DATE + (ctx.note ? ' · ' + ctx.note : ''),
    }
  )
}

// 返回**新对象**；不修改 costOfUsage 的返回值。
export function withCostProv(costResult, ctx = {}) {
  if (!costResult || typeof costResult !== 'object') return null
  const provValue = pricingProv({
    peak: costResult.peak,
    tier: costResult.tier,
    vendor: costResult.vendor,
    vendorLabel: costResult.vendorLabel,
    asOf: ctx.asOf,
    note: ctx.note,
  })
  return { ...costResult, prov: provValue }
}
