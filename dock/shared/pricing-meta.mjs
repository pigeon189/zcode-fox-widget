// 价目快照日期（D033）。engines/pricing.mjs 没有导出常量；改价目时必须同步改这里，
// provenance 单测会提醒复核。放在 shared/ 是为了让 adapters 与 daemon 都能引用，
// 不产生 adapters → daemon 的反向依赖。

export const PRICING_SNAPSHOT_DATE = '2026-10'
