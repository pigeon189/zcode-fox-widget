// 跨显示器跟随的纯判定：给定宿主窗口矩形与浮层窗口矩形（都是 DIP），
// 算出当前屏还能看到多少，以及是否该先隐身等换屏。
// 抽成纯函数是为了能在 selftest 里用合成矩形覆盖负坐标副屏、不等宽屏、
// 窄缝与退化矩形，不依赖双屏硬件。
const MIN_PENDING_VISIBLE = 120
const MIN_PENDING_OVERLAP_RATIO = 0.35

// 矩形交集：宿主还有多少留在浮层窗口（当前屏）上。
function overlapOf(rect, bounds) {
  const w = Math.max(0, Math.min(rect.x + rect.width, bounds.x + bounds.width) - Math.max(rect.x, bounds.x))
  const h = Math.max(0, Math.min(rect.y + rect.height, bounds.y + bounds.height) - Math.max(rect.y, bounds.y))
  const area = Math.max(1, rect.width * rect.height)
  return { width: w, height: h, ratio: (w * h) / area }
}

// 等待换屏期间：面积不足 35%，或只剩一条窄于角色最小宽度（约 120 DIP）的缝，
// 就认为「已经明显移走」，先隐身；贴着边界小幅晃动时继续显示并跟随可见部分。
function shouldHideBeforeSwitch(rect, bounds) {
  const o = overlapOf(rect, bounds)
  return o.ratio < MIN_PENDING_OVERLAP_RATIO || o.width < MIN_PENDING_VISIBLE || o.height < MIN_PENDING_VISIBLE
}

module.exports = { MIN_PENDING_VISIBLE, MIN_PENDING_OVERLAP_RATIO, overlapOf, shouldHideBeforeSwitch }
