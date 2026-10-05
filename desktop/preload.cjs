// 浮层模式下的桥接：页面用它告诉主进程「现在指针在鲸鱼上，请接管鼠标」，
// 接收 ZCode 窗口矩形（页面把它当作自己的视口），以及调整跟随探测间隔。
// 只暴露这几个能力，不向页面开放任何 Node 权限。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whaleDesktop', {
  isOverlay: true,
  setInteractive: (value) => ipcRenderer.send('whale:interactive', !!value),
  quit: () => ipcRenderer.send('whale:quit'),
  onViewport: (callback) => {
    ipcRenderer.on('whale:viewport', (_event, rect) => {
      try {
        callback(rect)
      } catch (err) {}
    })
  },
  // 主进程低频轮询的真实光标位置（页面坐标）。指针事件流异常中断时用它兜底。
  onCursor: (callback) => {
    ipcRenderer.on('whale:cursor', (_event, pt) => {
      try {
        callback(pt)
      } catch (err) {}
    })
  },
  // 跟随探测间隔（毫秒）：值越小鲸鱼跟得越紧
  setFollowInterval: (ms) => ipcRenderer.send('whale:follow-interval', Number(ms)),
  getFollowInterval: () => ipcRenderer.invoke('whale:follow-interval-get'),
  // 桌宠模式：ZCode 失焦/被别的窗口盖住时也不隐身，并周期性重申置顶层级
  setPetMode: (value) => ipcRenderer.send('whale:pet-mode', !!value),
  // 窗口默认不可激活（否则点挂件会抢走 ZCode 的前台、让它停止刷新）。
  // 菜单里的文本框/下拉需要键盘时才临时打开，用完立刻交还。
  setKeyboardFocus: (value) => ipcRenderer.send('whale:keyboard-focus', !!value),
  // 点在挂件界面之外时：页面收起菜单/编辑器并交还穿透后，请求主进程把被
  // 浮层吃掉的这次点击重放给 ZCode（一次点击 = 收起浮层 + 落进 ZCode）
  dismissReplay: () => ipcRenderer.send('whale:dismiss-replay'),
  // 浮层失去前台（用户点回 ZCode / Alt-Tab）：页面据此收起菜单/编辑器、
  // 释放键盘焦点。此前靠 focusout 兜底，但窗口失活时 activeElement 不变，
  // 编辑器和接管状态会一直挂着（表现为 ZCode 冻住、点不动）。
  onWindowBlur: (callback) => {
    ipcRenderer.on('whale:window-blur', () => {
      try {
        callback()
      } catch (err) {}
    })
  },
})
