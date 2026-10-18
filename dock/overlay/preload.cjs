const { contextBridge, ipcRenderer } = require('electron')

// 只暴露「要不要接收鼠标」这一个能力；渲染层拿不到 Node。
contextBridge.exposeInMainWorld('foxOverlay', {
  setInteractive(on) {
    ipcRenderer.send('set-interactive', !!on)
  },
  // 屏幕坐标（DIP）；渲染层用它判断光标是否压在狐狸上
  getCursor() {
    return ipcRenderer.invoke('cursor')
  },
  getBounds() {
    return ipcRenderer.invoke('bounds')
  },
  // 命中查询走主进程：拖拽期间渲染进程的网络会被挂起
  hit(x, y, exclude) {
    return ipcRenderer.invoke('hit', { x, y, exclude })
  },
})
