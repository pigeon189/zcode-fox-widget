// Kimi Code 没有本地逐日用量库：宿主只提供套餐额度窗口（/coding/v1/usages），
// 磁盘上的 cache/query-store 是宿主内部索引，不是可稳定解析的用量历史。
// 这里明确返回 unsupported，由统计页引导到「额度与余额」，不伪造 0 或历史曲线。

export function readKimiStats(opts = {}) {
  const range = ['all', '7d', '30d'].includes(opts.range) ? opts.range : 'all'
  return {
    supported: false,
    range,
    reason: 'no-local-history',
    note: 'Kimi Code 只提供套餐额度窗口，没有本地逐日用量历史；额度与重置时间请看「额度与余额」。',
  }
}
