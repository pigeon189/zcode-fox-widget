// 兜底适配器：窗口能绑定、能跟随，但计费「暂不支持」。
//
// 这是产品态度问题：没接入的 agent 就老实说不知道，绝不猜数字。
// R5/R6 会加入真正的 ZCode / WorkBuddy 适配器；其余一律落到这里。

export const genericAdapter = {
  id: 'generic',
  name: '通用窗口',
  priority: 0,
  // 兜底适配器不参与匹配，由 registry 显式返回
  fallback: true,
  match: { exeBasenames: [] },
  capabilities: { billing: false, follow: true },
}
