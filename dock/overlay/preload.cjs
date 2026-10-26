const { contextBridge, ipcRenderer } = require('electron')

// 只暴露「要不要接收鼠标」这一个能力；渲染层拿不到 Node。
contextBridge.exposeInMainWorld('foxOverlay', {
  setInteractive(on) {
    ipcRenderer.send('set-interactive', !!on)
  },
  setBusy(on) {
    ipcRenderer.send('set-busy', !!on)
  },
  // 主进程判定吸附宿主不在前台时会把浮层整体隐掉；页面同步收起菜单/快览。
  onHidden(cb) {
    ipcRenderer.on('overlay-hidden', () => cb())
  },
  // 屏幕坐标（DIP）；渲染层用它判断光标是否压在狐狸上
  getCursor() {
    return ipcRenderer.invoke('cursor')
  },
  getBounds() {
    return ipcRenderer.invoke('bounds')
  },
  write(path, method, body) {
    return ipcRenderer.invoke('daemon-write', { path: String(path), method: String(method || 'POST'), body })
  },
  read(path) {
    return ipcRenderer.invoke('daemon-read', { path: String(path) })
  },
  // 音效集音频字节（M-S）：主进程持令牌取回，渲染层转 Blob 播放（禁 fetch）。
  readSound(setId, slot) {
    return ipcRenderer.invoke('read-sound', { setId: String(setId), slot: String(slot) })
  },
  // SSE 事件（主进程持令牌代理 /v1/stream，渲染层不再直接连网）。
  onStream(cb) {
    const handler = (_e, payload) => {
      try {
        cb(payload && typeof payload === 'object' ? payload : { event: 'message', data: payload })
      } catch (err) {}
    }
    ipcRenderer.on('stream-event', handler)
    return () => ipcRenderer.removeListener('stream-event', handler)
  },
  // 权限待办推送（M5）：主进程 2s 轮询 /v1/actions 后转发给宠物权限卡。
  onPermActions(cb) {
    ipcRenderer.on('perm-actions', (_e, actions) => {
      try {
        cb(Array.isArray(actions) ? actions : [])
      } catch (err) {}
    })
  },
  openConsole(page) {
    ipcRenderer.send('open-console', String(page || ''))
  },
  hideOverlay() {
    ipcRenderer.send('hide-overlay')
  },
  quitDock() {
    ipcRenderer.send('quit-dock')
  },
  // 命中查询走主进程：拖拽期间渲染进程的网络会被挂起
  hit(x, y, exclude) {
    return ipcRenderer.invoke('hit', { x, y, exclude })
  },
  // 角色透明边的 64×64 alpha 掩码；渲染层用它判断指针是否真的压在角色上。
  getAlphaMask(roleId) {
    return ipcRenderer.invoke('alpha-mask', roleId)
  },
  // 导入角色（PNG/GIF）读成 data URL；内置角色仍走相对路径。
  getRoleImage(roleId) {
    return ipcRenderer.invoke('role-image', roleId)
  },
})
