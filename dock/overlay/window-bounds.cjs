// 浮层窗口的初始矩形：正常情况下与工作区严格重合——兜底角落要能贴住
// 工作区的角落（2026-10-24 定稿：不留观感缝隙，任务栏常驻时窗口右下即
// 工作区右下角）。唯一例外：Windows 任务栏「自动隐藏」时 workArea 等于
// 整块屏幕，精确铺满的置顶窗口会被系统当作全屏窗口、压制任务栏的滑出
// 热区（1.x v1.16.2 issue #8）。此时留 1 DIP 不可见缝破坏「严格重合」
// 即可；拿不到屏幕 bounds 时也保守留缝。
const TASKBAR_REVEAL_INSET = 1

function overlayWorkAreaBounds(workArea, screenBounds) {
  const wa = workArea && typeof workArea === 'object' ? workArea : { x: 0, y: 0, width: 1, height: 1 }
  const sb = screenBounds && typeof screenBounds === 'object' ? screenBounds : null
  const sameAsScreen =
    !!sb &&
    Number(wa.x) === Number(sb.x) &&
    Number(wa.y) === Number(sb.y) &&
    Number(wa.width) === Number(sb.width) &&
    Number(wa.height) === Number(sb.height)
  // 只有「确认工作区小于屏幕（任务栏常驻）」才允许精确重合，其余保守留缝。
  const n = sb && !sameAsScreen ? 0 : TASKBAR_REVEAL_INSET
  return {
    x: Number(wa.x) + n,
    y: Number(wa.y) + n,
    width: Math.max(1, Number(wa.width) - n * 2),
    height: Math.max(1, Number(wa.height) - n * 2),
  }
}

module.exports = { TASKBAR_REVEAL_INSET, overlayWorkAreaBounds }
