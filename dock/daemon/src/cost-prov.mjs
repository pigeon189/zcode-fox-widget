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

// 价目表未收录（costOfUsage 对 kind='none' 返回 billable:false + rates:null）。
// 注意：kind='free' 的免费模型也有 billable:false，但它有 rates 数组、金额确实
// 是 0；只有 rates 为 null 才是「算不出来」。这种行不能按 0 元入账。
export function isUnpriced(costResult) {
  return !!(costResult && costResult.billable === false && costResult.rates == null)
}

// 不可计价行的 provenance：金额为 null 时必须带 unavailable + 原因，不能继续
// 标 estimated/pricing-table（D033：缺失不补 0）。
export function pricingUnavailable(ctx = {}) {
  return prov('unavailable', 'pricing-table', 'pricing:' + PRICING_SNAPSHOT_DATE, {
    asOf: ctx.asOf,
    reason: 'no-data',
    note: ctx.note || '价目快照 ' + PRICING_SNAPSHOT_DATE + ' 未收录该模型，金额不可得',
  })
}
