const path = require('node:path')
const { app, BrowserWindow, screen, ipcMain } = require('electron')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const daemonPort = arg('--daemon-port', process.env.FOX_DOCK_PORT || '')
const noClickThrough = process.argv.includes('--no-click-through')
const ignorePids = arg('--ignore-pids', '')
// 多显示器：浮层只铺**一块**屏幕。默认选光标所在的那块（大概率就是用户正在用的），
// 也可以 --display=primary 固定主屏。跨屏拖动暂不支持（见 DECISIONS D011）。
const displayMode = arg('--display', process.env.FOX_DOCK_DISPLAY || 'cursor')

// 透明 + 置顶 + 不抢焦点。透明窗口在部分驱动上会把整窗当成可命中，所以默认
// 全窗穿透，只有指针压在狐狸上时由 renderer 通过 IPC 打开交互。
app.disableHardwareAcceleration()
// 全屏透明窗会被 Chromium 的遮挡判定认为「被别的窗口盖住」，进而把渲染进程
// 降优先级/节流：实测拖拽期间所有请求都卡到松手后才返回，拖拽直接失效。
// 这条开关必须加在浮层自己进程上（宿主进程的开关管不到这里）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

app.whenReady().then(() => {
  const primary = screen.getPrimaryDisplay()
  const chosen = displayMode === 'primary' ? primary : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const work = chosen.workArea
  console.log(
    '[fox-dock] overlay display=' + chosen.id + ' ' + work.width + 'x' + work.height + ' @' + chosen.scaleFactor + 'x' + (chosen.id === primary.id ? ' (primary)' : '')
  )
  const win = new BrowserWindow({
    x: work.x,
    y: work.y,
    width: work.width,
    height: work.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (!noClickThrough) win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(path.join(__dirname, 'index.html'), {
    query: { port: String(daemonPort), pid: String(process.pid), ignore: ignorePids, ct: noClickThrough ? '0' : '1' },
  })
  win.once('ready-to-show', () => win.showInactive())

  // daemon 没了就退出：否则桌面上会留一只「点不动的狐狸」，而用户根本不知道
  // 后台已经挂了。8 次 × 1.5s ≈ 12s，足够跨过 watchdog 的重启窗口。
  if (daemonPort) {
    let fails = 0
    const timer = setInterval(async () => {
      try {
        const res = await fetch('http://127.0.0.1:' + daemonPort + '/health', { signal: AbortSignal.timeout(1500) })
        if (res.ok) {
          fails = 0
          return
        }
      } catch (err) {}
      fails++
      if (fails >= 8) {
        clearInterval(timer)
        console.log('[fox-dock] daemon unreachable, overlay quits')
        app.quit()
      }
    }, 1500)
    if (timer.unref) timer.unref()
  }

  // 光标位置由主进程直接问系统：穿透状态下 mousemove 转发不可靠
  //（实测 WorkBuddy 在前台时收不到，狐狸就永远点不到）
  ipcMain.handle('cursor', () => screen.getCursorScreenPoint())
  // 窗口在屏幕上的位置（DIP）。渲染层的 window.screenX 在激活/DPI 校正前后会变，
  // 这里给一份主进程认得的坐标做兜底（第一次指针事件后就用事件自己算的偏移）。
  ipcMain.handle('bounds', () => win.getBounds())

  // 拖拽期间渲染进程的网络会被整体挂起（实测所有 fetch 卡到松手后才返回），
  // 命中采样改成主进程代发：主进程是 Node，不受这个限制。
  ipcMain.handle('hit', async (_e, payload) => {
    const x = Math.round(Number(payload && payload.x) || 0)
    const y = Math.round(Number(payload && payload.y) || 0)
    const exclude = Number(payload && payload.exclude) || 0
    try {
      const res = await fetch(
        'http://127.0.0.1:' + daemonPort + '/hit?x=' + x + '&y=' + y + '&exclude=' + exclude,
        { signal: AbortSignal.timeout(3000) }
      )
      return await res.json()
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })

  ipcMain.on('set-interactive', (_e, on) => {
    try {
      win.setIgnoreMouseEvents(!on, { forward: true })
    } catch (err) {}
  })
})

app.on('window-all-closed', () => app.quit())
