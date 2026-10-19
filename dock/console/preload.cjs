const { contextBridge, ipcRenderer } = require('electron')

// 控制台只通过主进程访问 daemon：token 不出现在渲染层，SSE 也由主进程代收。
contextBridge.exposeInMainWorld('foxDock', {
  api(pathname, options) {
    return ipcRenderer.invoke('api', { path: String(pathname), ...(options || {}) })
  },
  bootstrap() {
    return ipcRenderer.invoke('bootstrap')
  },
  onEvent(cb) {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('dock-event', handler)
    return () => ipcRenderer.removeListener('dock-event', handler)
  },
  windowControl(action) {
    ipcRenderer.send('window-control', String(action))
  },
  // 标题栏右上角系统按钮区跟随主题（Electron 的 titleBarOverlay 是原生层）。
  setTitleBarTheme(color, symbolColor) {
    ipcRenderer.send('titlebar-theme', { color: String(color || ''), symbolColor: String(symbolColor || '') })
  },
  openDataDir() {
    return ipcRenderer.invoke('open-data-dir')
  },
  openExternal(url) {
    return ipcRenderer.invoke('open-external', String(url))
  },
  readRoleImage(roleId) {
    return ipcRenderer.invoke('read-role-image', String(roleId))
  },
})
