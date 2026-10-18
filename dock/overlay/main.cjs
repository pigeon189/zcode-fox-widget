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

// 透明 + 置顶 + 不抢焦点。透明窗口在部分驱动上会把整窗当成可命中，所以默认
// 全窗穿透，只有指针压在狐狸上时由 renderer 通过 IPC 打开交互。
app.disableHardwareAcceleration()

app.whenReady().then(() => {
  const work = screen.getPrimaryDisplay().workArea
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
    query: { port: String(daemonPort), pid: String(process.pid), ignore: ignorePids },
  })
  win.once('ready-to-show', () => win.showInactive())

  ipcMain.on('set-interactive', (_e, on) => {
    try {
      win.setIgnoreMouseEvents(!on, { forward: true })
    } catch (err) {}
  })
})

app.on('window-all-closed', () => app.quit())
