const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, globalShortcut, nativeImage } = require('electron')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const daemonPort = arg('--daemon-port', process.env.FOX_DOCK_PORT || '')
const dataDir = arg('--data-dir', process.env.FOX_DOCK_DATA || '')
const nodePath = arg('--node-path', '')
const cliPath = arg('--cli-path', '')
const noClickThrough = process.argv.includes('--no-click-through')
const ignorePids = arg('--ignore-pids', '')
// 多显示器：浮层只铺**一块**屏幕。默认选光标所在的那块（大概率就是用户正在用的），
// 也可以 --display=primary 固定主屏。跨屏拖动暂不支持（见 DECISIONS D011）。
const displayMode = arg('--display', process.env.FOX_DOCK_DISPLAY || 'cursor')

// 透明 + 置顶 + 不抢焦点。透明窗口在部分驱动上会把整窗当成可命中，所以默认
// 全窗穿透，只有指针压在狐狸上时由 renderer 通过 IPC 打开交互。
//
// 2.0：默认硬件合成。Windows 上「透明 + 软件合成」会只重绘部分脏区——
// DOM 截图里有角色，桌面上却看不见（实测）。排障/低配机器可设
// FOX_DOCK_SOFTWARE_RENDER=1 回退。
if (process.env.FOX_DOCK_SOFTWARE_RENDER === '1') app.disableHardwareAcceleration()
// 全屏透明窗会被 Chromium 的遮挡判定认为「被别的窗口盖住」，进而把渲染进程
// 降优先级/节流：实测拖拽期间所有请求都卡到松手后才返回，拖拽直接失效。
// 这条开关必须加在浮层自己进程上（宿主进程的开关管不到这里）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

// ---------- daemon API（托盘/热键要能改设置、能退出） ----------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return null
  }
}

function lockInfo() {
  if (!dataDir) return null
  return readJson(path.join(dataDir, 'daemon.lock'))
}

function readSettings() {
  if (!dataDir) return {}
  return readJson(path.join(dataDir, 'settings.json')) || {}
}

async function daemonApi(p, method = 'GET', body) {
  const lock = lockInfo()
  if (!lock || !lock.port) throw new Error('daemon-not-running')
  const headers = { 'Content-Type': 'application/json' }
  if (lock.token) headers['x-fox-token'] = lock.token
  const res = await fetch('http://127.0.0.1:' + lock.port + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  })
  return res.json()
}

async function patchSettings(patch) {
  try {
    return await daemonApi('/v1/settings', 'PUT', patch)
  } catch (err) {
    console.warn('[fox-dock] settings patch failed: ' + (err && err.message ? err.message : err))
    return null
  }
}

// ---------- 角色 alpha 掩码（治「透明边挡住下面窗口点击」） ----------

const maskCache = new Map()

function rolePath(roleId) {
  const id = String(roleId || '')
  if (!/^[a-z0-9-]{2,24}$/i.test(id)) return ''
  const dirs = [path.join(__dirname, 'assets', 'roles')]
  if (dataDir) dirs.push(path.join(dataDir, 'roles'))
  for (const dir of dirs) {
    for (const ext of ['png', 'gif', 'jpg', 'jpeg', 'webp']) {
      const file = path.join(dir, id + '.' + ext)
      if (fs.existsSync(file)) return file
    }
  }
  return ''
}

function roleImageData(roleId) {
  const file = rolePath(roleId)
  if (!file) return ''
  const mime = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
  const ext = path.extname(file).slice(1).toLowerCase()
  try {
    return 'data:' + (mime[ext] || 'image/png') + ';base64,' + fs.readFileSync(file).toString('base64')
  } catch (err) {
    return ''
  }
}

function alphaMask(roleId) {
  const file = rolePath(roleId)
  if (!file) return { ok: false, error: 'role-not-found' }
  let stat
  try {
    stat = fs.statSync(file)
  } catch (err) {
    return { ok: false, error: 'role-not-found' }
  }
  const key = file + '|' + stat.mtimeMs
  const hit = maskCache.get(key)
  if (hit) return hit
  try {
    const img = nativeImage.createFromPath(file)
    if (img.isEmpty()) return { ok: false, error: 'image-empty' }
    const small = img.resize({ width: 64, height: 64, quality: 'good' })
    const bmp = small.toBitmap()
    const data = []
    for (let i = 0; i < 64 * 64; i++) data.push(bmp[i * 4 + 3] || 0)
    const value = { ok: true, width: 64, height: 64, data }
    maskCache.set(key, value)
    return value
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

// ---------- 托盘 / 热键 ----------

let tray = null
let win = null
let consoleProcess = null

function startupLauncherFile() {
  const appData = process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming')
  const dir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
  for (const name of ['fox-dock.vbs', 'fox-dock.cmd']) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return file
  }
  return ''
}

async function toggleAutoStart(enable) {
  if (!dataDir || !nodePath || !cliPath) return false
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'daemon', 'src', 'install.mjs')).href)
    if (enable) {
      mod.installLauncher({
        dataDir,
        nodePath,
        scriptPath: cliPath,
        command: 'start',
        format: 'vbs',
      })
    } else {
      mod.uninstallLauncher()
    }
    await patchSettings({ autoStart: !!enable })
    return true
  } catch (err) {
    console.warn('[fox-dock] autostart toggle failed: ' + (err && err.message ? err.message : err))
    return false
  }
}

function toggleVisible() {
  if (!win) return
  try {
    if (win.isVisible()) win.hide()
    else win.showInactive()
  } catch (err) {}
  refreshTray()
}

function openConsole() {
  const consoleDir = path.join(__dirname, '..', 'console')
  if (!fs.existsSync(path.join(consoleDir, 'main.cjs'))) {
    console.warn('[fox-dock] console not built yet')
    return
  }
  // 每次都尝试启动：控制台自己是单实例，已存在时第二实例会把窗口显示出来。
  // 不在这里判断 consoleProcess —— 窗口被关闭到后台时它仍然存活，跳过就再也打不开。
  try {
    const { spawn } = require('node:child_process')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const args = [consoleDir, '--daemon-port=' + daemonPort]
    if (dataDir) args.push('--data-dir=' + dataDir)
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env })
    child.unref()
    consoleProcess = child
    child.on('exit', () => {
      consoleProcess = null
    })
  } catch (err) {
    console.warn('[fox-dock] open console failed: ' + (err && err.message ? err.message : err))
  }
}

async function quitDock() {
  try {
    await daemonApi('/shutdown', 'POST')
  } catch (err) {}
  app.quit()
}

function buildMenu() {
  const s = readSettings()
  return Menu.buildFromTemplate([
    { label: '打开控制台', accelerator: 'Ctrl+Alt+D', click: openConsole },
    { label: win && win.isVisible() ? '隐藏角色' : '显示角色', accelerator: 'Ctrl+Alt+F', click: toggleVisible },
    { type: 'separator' },
    {
      label: '吸附到 agent 窗口',
      type: 'checkbox',
      checked: !s.petMode,
      click: (item) => patchSettings({ petMode: !item.checked }).then(refreshTray),
    },
    {
      label: '隐藏金额',
      type: 'checkbox',
      checked: !!s.hideMoney,
      click: (item) => patchSettings({ hideMoney: item.checked }).then(refreshTray),
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!startupLauncherFile(),
      click: (item) => toggleAutoStart(item.checked).then(refreshTray),
    },
    { type: 'separator' },
    { label: '退出 fox-dock', click: quitDock },
  ])
}

function refreshTray() {
  if (!tray) return
  try {
    tray.setContextMenu(buildMenu())
  } catch (err) {}
}

function setupTray() {
  const s = readSettings()
  const roleId = (s.profiles && s.profiles.zcode && s.profiles.zcode.roleId) || s.roleId || 'fox'
  let icon = nativeImage.createEmpty()
  try {
    const file = rolePath(roleId)
    if (file) icon = nativeImage.createFromPath(file).resize({ width: 16, height: 16, quality: 'best' })
  } catch (err) {}
  try {
    tray = new Tray(icon)
    tray.setToolTip('fox-dock')
    tray.setContextMenu(buildMenu())
    tray.on('right-click', () => {
      try {
        tray.popUpContextMenu(buildMenu())
      } catch (err) {}
    })
    tray.on('double-click', openConsole)
  } catch (err) {
    console.warn('[fox-dock] tray unavailable: ' + (err && err.message ? err.message : err))
  }
}

function setupHotkeys() {
  const s = readSettings()
  const hot = s.hotkeys || {}
  const bind = (accelerator, fn, label) => {
    if (!accelerator) return
    try {
      const ok = globalShortcut.register(accelerator, fn)
      if (!ok) console.warn('[fox-dock] 热键被占用：' + accelerator + '（' + label + '）')
    } catch (err) {
      console.warn('[fox-dock] 热键注册失败：' + accelerator + ' ' + (err && err.message ? err.message : err))
    }
  }
  bind(hot.toggle, toggleVisible, '显示/隐藏')
  bind(hot.console, openConsole, '控制台')
  bind(hot.hideMoney, () => {
    const cur = readSettings()
    patchSettings({ hideMoney: !cur.hideMoney }).then(refreshTray)
  }, '隐藏金额')
}

app.whenReady().then(() => {
  const primary = screen.getPrimaryDisplay()
  const chosen = displayMode === 'primary' ? primary : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const work = chosen.workArea
  console.log(
    '[fox-dock] overlay display=' + chosen.id + ' ' + work.width + 'x' + work.height + ' @' + chosen.scaleFactor + 'x' + (chosen.id === primary.id ? ' (primary)' : '')
  )
  win = new BrowserWindow({
    x: work.x,
    y: work.y,
    width: work.width,
    height: work.height,
    transparent: true,
    frame: false,
    // 与挂件线同款：resizable:false 会让 Electron 把 min/max 锁在创建尺寸，
    // 之后任何 setBounds 都会被拒绝；保持 true，尺寸只由创建参数决定。
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Windows 上 toolbar 型窗口常驻 WS_EX_TOOLWINDOW：宿主 Chromium 的遮挡判定
    // 会直接排除它，避免「点一下浮层后宿主停止出帧」（挂件线 issue #2 的结论）。
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
    // 浮层永远不抢前台：点它不能把宿主从 active 状态顶掉。
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  // 标题带 daemon 端口：同一台机器上可能有多个测试实例/两条产品线，
  // stop/start 只能接管「服务于本 daemon 端口」的浮层。
  const overlayTitle = 'fox-dock overlay ' + (daemonPort || '?')
  win.setTitle(overlayTitle)
  win.webContents.on('page-title-updated', (event) => {
    event.preventDefault()
    try {
      win.setTitle(overlayTitle)
    } catch (err) {}
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } catch (err) {}
  if (!noClickThrough) win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.on('will-navigate', (event, url) => {
    if (!String(url).startsWith('file://')) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadFile(path.join(__dirname, 'index.html'), {
    query: { port: String(daemonPort), pid: String(process.pid), ignore: ignorePids, ct: noClickThrough ? '0' : '1' },
  })
  // 透明窗口首帧：等页面完成加载再显示，并在显示后补一次整窗失效，
  // 避免 Windows 只合成部分脏区（真机：DOM 有、桌面上只有背景）。
  win.webContents.once('did-finish-load', () => {
    win.showInactive()
    try {
      win.setOpacity(0.999)
      win.setOpacity(1)
    } catch (err) {}
  })
  // 页面加载失败/极慢时也别让浮层永远藏着；3 秒后无条件显示。
  setTimeout(() => {
    try {
      if (!win.isVisible()) win.showInactive()
    } catch (err) {}
  }, 3000).unref?.()

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
  // 遗留写路由需要令牌；渲染层只传 path/method/body，token 留在主进程。
  ipcMain.handle('daemon-write', async (_e, payload) => {
    const lock = lockInfo()
    if (!lock || !lock.port) return { ok: false, error: 'daemon-not-running' }
    try {
      const res = await fetch('http://127.0.0.1:' + lock.port + String(payload.path || ''), {
        method: String(payload.method || 'POST'),
        headers: { 'Content-Type': 'application/json', 'x-fox-token': lock.token || '' },
        body: payload.body === undefined ? undefined : JSON.stringify(payload.body),
        signal: AbortSignal.timeout(3000),
      })
      return await res.json()
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })
  ipcMain.handle('alpha-mask', (_e, roleId) => alphaMask(roleId))
  ipcMain.handle('role-image', (_e, roleId) => roleImageData(roleId))

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

  ipcMain.on('open-console', () => openConsole())
  ipcMain.on('hide-overlay', () => {
    try {
      win.hide()
    } catch (err) {}
  })
  ipcMain.on('quit-dock', () => quitDock())

  ipcMain.on('set-interactive', (_e, on) => {
    try {
      win.setIgnoreMouseEvents(!on, { forward: true })
    } catch (err) {}
  })

  setupTray()
  setupHotkeys()
})

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll()
  } catch (err) {}
  try {
    if (tray) tray.destroy()
  } catch (err) {}
})
