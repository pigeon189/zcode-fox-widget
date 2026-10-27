// 浮层窗口的初始/兜底矩形：工作区四周留出不可见的安全边距，避免窗口
// 与整块屏幕严格重合。Windows 任务栏设为「自动隐藏」时，workArea 会等于
// 整个屏幕；此时精确铺满的置顶窗口会被系统当作全屏窗口，压制任务栏的
// 滑出热区（main 线 issue #8 同形态——该修复当年未随移植保留，跨线审查补齐）。
// 透明窗这条缝不可见，4 DIP 也远小于任何正常布局需要的边距。
const TASKBAR_REVEAL_INSET = 4

function overlayWorkAreaBounds(workArea, inset) {
  const wa = workArea && typeof workArea === 'object' ? workArea : { x: 0, y: 0, width: 1, height: 1 }
  const raw = Number(inset)
  const n = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : TASKBAR_REVEAL_INSET
  const width = Math.max(1, Number(wa.width) - n * 2)
  const height = Math.max(1, Number(wa.height) - n * 2)
  return {
    x: Number(wa.x) + n,
    y: Number(wa.y) + n,
    width: Math.max(1, width),
    height: Math.max(1, height),
  }
}

module.exports = { TASKBAR_REVEAL_INSET, overlayWorkAreaBounds }
