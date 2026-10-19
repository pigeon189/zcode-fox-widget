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
const UI_DIR = path.join(__dirname, '..', 'ui')

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

async function apiRequest(pathname, options = {}) {
  const lock = lockInfo()
  const port = daemonPort || (lock && lock.port)
  if (!port) return { status: 503, ok: false, data: { ok: false, error: 'daemon-not-running' } }
  const headers = { 'Content-Type': 'application/json' }
  if (lock && lock.token) headers['x-fox-token'] = lock.token
  try {
    const res = await fetch('http://127.0.0.1:' + port + pathname, {
      method: options.method || 'GET',
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
    return { status: 0, ok: false, data: { ok: false, error: String((err && err.message) || err) } }
  }
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
    titleBarOverlay: { height: 40, color: '#F6F7F9', symbolColor: '#172033' },
    backgroundColor: '#F6F7F9',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.loadFile(path.join(UI_DIR, 'console.html'), {
    query: { port: String(daemonPort || ''), dataDirPresent: dataDir ? '1' : '0' },
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
  ipcMain.handle('open-data-dir', () => (dataDir ? shell.openPath(dataDir) : Promise.resolve('')))
  ipcMain.handle('open-external', (_e, url) => {
    const s = String(url || '')
    if (!/^https?:\/\//i.test(s)) return false
    return shell.openExternal(s).then(() => true).catch(() => false)
  })
  ipcMain.handle('read-role-image', (_e, roleId) => {
    const id = String(roleId || '')
    if (!/^[a-z0-9-]{2,24}$/i.test(id)) return ''
    const candidates = [
      path.join(dataDir || '', 'roles', id + '.png'),
      path.join(UI_DIR, '..', 'overlay', 'assets', 'roles', id + '.png'),
    ]
    for (const file of candidates) {
      try {
        const buf = fs.readFileSync(file)
        return 'data:image/png;base64,' + buf.toString('base64')
      } catch (err) {}
    }
    return ''
  })

  streamLoop()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show()
      if (win.isMinimized()) win.restore()
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
