const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, shell, screen } = require('electron')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const dataDir = arg('--data-dir', process.env.FOX_DOCK_DATA || '')
const daemonPort = arg('--daemon-port', process.env.FOX_DOCK_PORT || '')
const initialPage = arg('--page', '')
const UI_DIR = path.join(__dirname, '..', 'ui')
const APP_ICON = path.join(__dirname, '..', 'assets', 'app-icon.png')

// 透明/置顶窗口的同类问题（挂件线 issue #2）：Chromium 的原生遮挡计算会把
// 长时间被盖住的控制台判定为「不需要出帧」，再显示时只剩一块白底。
// 控制台是普通窗口，但关闭按钮只是 hide()，重新打开走的是同一个渲染进程，
// 一旦画面被冻结就会一直白屏。这里把三条后台化/节流开关全部关掉，并在
// 渲染进程崩溃/无响应时自动重载。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.foxdock.console')
  } catch (err) {}
}

// 每个数据目录一个 userData：测试实例与正式实例的缓存/单实例锁互不干扰。
if (dataDir) {
  try {
    app.setPath('userData', path.join(dataDir, 'console'))
  } catch (err) {}
}

function lockInfo() {
  if (!dataDir) return null
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.lock'), 'utf8'))
  } catch (err) {
    return null
  }
}

function windowStateFile() {
  return dataDir ? path.join(dataDir, 'console-window.json') : ''
}

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'))
  } catch (err) {
    return null
  }
}

function saveWindowState(win) {
  const file = windowStateFile()
  if (!file) return
  try {
    const b = win.getBounds()
    fs.writeFileSync(file, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }))
  } catch (err) {}
}

let win = null
let sseTimer = null
let sseAbort = null
let streamFails = 0
let lastRecoveryAt = 0

// 渲染进程崩溃/无响应时自动重载；10 秒内只做一次，避免持续故障时刷新循环。
function recoverRenderer() {
  const now = Date.now()
  if (now - lastRecoveryAt < 10000) return
  lastRecoveryAt = now
  try {
    if (win && !win.isDestroyed()) win.reload()
  } catch (err) {}
}

async function apiRequest(pathname, options = {}) {
  const lock = lockInfo()
  const port = daemonPort || (lock && lock.port)
  if (!port) return { status: 503, ok: false, data: { ok: false, error: 'daemon-not-running' } }
  const headers = { 'Content-Type': 'application/json' }
  if (lock && lock.token) headers['x-fox-token'] = lock.token
  const method = options.method || 'GET'
  const transient = (err) =>
    /fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up/i.test(
      String((err && err.message) || err) + ' ' + String((err && err.cause && err.cause.code) || '')
    )
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + pathname, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs || 15000),
      })
      let data = null
      try {
        data = await res.json()
      } catch (err) {}
      return { status: res.status, ok: res.ok, data }
    } catch (err) {
      // daemon 被 watchdog 重启的窗口通常 <2s：连接类错误重试，超时不重试。
      if (method !== 'GET' || !transient(err) || attempt === 2) {
        return { status: 0, ok: false, data: { ok: false, error: String((err && err.message) || err) } }
      }
      await new Promise((r) => setTimeout(r, 250 * Math.pow(3, attempt)))
    }
  }
  return { status: 0, ok: false, data: { ok: false, error: 'fetch failed' } }
}

async function streamLoop() {
  if (sseAbort) sseAbort.abort()
  sseAbort = new AbortController()
  const lock = lockInfo()
  const port = daemonPort || (lock && lock.port)
  if (!port) {
    scheduleStream(2000)
    return
  }
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/v1/stream', { signal: sseAbort.signal })
    if (!res.ok || !res.body) throw new Error('stream ' + res.status)
    streamFails = 0
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        let event = 'message'
        let data = ''
        for (const line of chunk.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (data) {
          try {
            if (win && !win.isDestroyed()) win.webContents.send('dock-event', { event, data: JSON.parse(data) })
          } catch (err) {}
        }
      }
    }
    // 服务端正常关闭（daemon 重启/升级）也必须重连；原逻辑只在异常时重连，
    // 正常 EOF 后 SSE 永久断开，界面就会一直停在「连接中断，重试中」。
    scheduleStream(1000)
  } catch (err) {
    if (String(err && err.name) === 'AbortError') return
    streamFails += 1
    // daemon 已经彻底不在了：不要留下一个永远连不上的后台窗口。
    if (streamFails >= 6 && !lockInfo()) {
      app.quit()
      return
    }
    scheduleStream(2500)
  }
}

function scheduleStream(ms) {
  if (sseTimer) clearTimeout(sseTimer)
  sseTimer = setTimeout(() => {
    sseTimer = null
    streamLoop()
  }, ms)
}

function createWindow() {
  const saved = readWindowState()
  const work = screen.getPrimaryDisplay().workArea
  const width = Math.min(Math.max(760, Number(saved && saved.width) || 960), work.width)
  const height = Math.min(Math.max(560, Number(saved && saved.height) || 680), work.height)
  const x = Number.isFinite(saved && saved.x) ? saved.x : Math.round(work.x + (work.width - width) / 2)
  const y = Number.isFinite(saved && saved.y) ? saved.y : Math.round(work.y + (work.height - height) / 2)

  win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 760,
    minHeight: 560,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: 40, color: '#FFFFFF', symbolColor: '#172033' },
    backgroundColor: '#F6F7F9',
    icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!String(url).startsWith('file://')) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    if (fs.existsSync(APP_ICON)) win.setIcon(APP_ICON)
  } catch (err) {}
  // 渲染进程崩了/卡死：自动重载，别把白屏留给用户。
  win.webContents.on('render-process-gone', () => recoverRenderer())
  win.webContents.on('unresponsive', () => recoverRenderer())
  win.on('show', () => {
    try {
      win.webContents.invalidate()
    } catch (err) {}
  })
  win.loadFile(path.join(UI_DIR, 'console.html'), {
    query: { port: String(daemonPort || ''), dataDirPresent: dataDir ? '1' : '0', ...(initialPage ? { page: initialPage } : {}) },
  })
  win.once('ready-to-show', () => {
    if (saved && saved.maximized) win.maximize()
    win.show()
  })
  win.on('close', (event) => {
    saveWindowState(win)
    // 关闭按钮收进后台：托盘/热键再次打开会走第二实例，把已有窗口显示出来。
    if (!app.isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    win = null
  })

  ipcMain.handle('api', (_e, payload) => apiRequest(String(payload && payload.path), payload || {}))
  ipcMain.handle('bootstrap', () => ({
    app: 'fox-dock-console',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    dataDir,
    daemonPort: (lockInfo() && lockInfo().port) || Number(daemonPort) || 0,
    version: (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
      } catch (err) {
        return '0.0.0'
      }
    })(),
  }))
  ipcMain.on('window-control', (_e, action) => {
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') win.hide()
  })
  // 右上角系统按钮区跟随页面主题，避免原生层与 titlebar 背景出现色差。
  ipcMain.on('titlebar-theme', (_e, payload) => {
    if (!win || win.isDestroyed()) return
    const color = String((payload && payload.color) || '')
    const symbolColor = String((payload && payload.symbolColor) || '')
    if (!/^#[0-9a-fA-F]{3,8}$/.test(color) || !/^#[0-9a-fA-F]{3,8}$/.test(symbolColor)) return
    try {
      win.setTitleBarOverlay({ color, symbolColor })
    } catch (err) {}
  })
  ipcMain.handle('open-data-dir', () => (dataDir ? shell.openPath(dataDir) : Promise.resolve('')))
  ipcMain.handle('open-external', (_e, url) => {
    const s = String(url || '')
    if (!/^https?:\/\//i.test(s)) return false
    return shell.openExternal(s).then(() => true).catch(() => false)
  })
  ipcMain.handle('read-role-image', (_e, roleId) => {
    const id = String(roleId || '')
    if (!/^[a-z0-9-]{2,24}$/i.test(id)) return ''
    const MIME = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
    const dirs = [path.join(dataDir || '', 'roles'), path.join(UI_DIR, '..', 'overlay', 'assets', 'roles')]
    for (const dir of dirs) {
      for (const ext of ['png', 'gif', 'jpg', 'jpeg', 'webp']) {
        try {
          const buf = fs.readFileSync(path.join(dir, id + '.' + ext))
          return 'data:' + MIME[ext] + ';base64,' + buf.toString('base64')
        } catch (err) {}
      }
    }
    return ''
  })

  streamLoop()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (win) {
      try {
        if (win.webContents.isCrashed()) win.reload()
      } catch (err) {}
      if (!win.isVisible()) win.show()
      if (win.isMinimized()) win.restore()
      const pageArg = (argv || []).find((a) => String(a).startsWith('--page='))
      const page = pageArg ? String(pageArg).slice('--page='.length) : ''
      if (/^(sessions|overview|usage|stats|quota|vendors|roles|settings|about)(\?[A-Za-z0-9%&=_.:-]*)?$/.test(page)) {
        try {
          win.webContents.executeJavaScript('location.hash=' + JSON.stringify('#' + page))
        } catch (err) {}
      }
      win.focus()
    }
  })
  app.whenReady().then(createWindow)
}

app.on('before-quit', () => {
  app.isQuitting = true
  if (sseAbort) sseAbort.abort()
  if (sseTimer) clearTimeout(sseTimer)
})
app.on('window-all-closed', () => app.quit())
