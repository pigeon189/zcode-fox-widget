const { contextBridge, ipcRenderer } = require('electron')

// 只暴露「要不要接收鼠标」这一个能力；渲染层拿不到 Node。
contextBridge.exposeInMainWorld('foxOverlay', {
  setInteractive(on) {
    ipcRenderer.send('set-interactive', !!on)
  },
})
