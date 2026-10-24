const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, globalShortcut, nativeImage, Notification } = require('electron')
const { overlayWorkAreaBounds } = require('./window-bounds.cjs')

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
// 测试用：允许绑定任意普通窗口（fake-agent 不是四个内置宿主之一）。
const allowGeneric = process.argv.includes('--allow-generic')

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
let overlayShown = true
let manuallyHidden = false
let petBusy = false
let rendererInteractive = false
let zOrderTimer = null

// 浮层的鼠标策略：渲染层只在指针压到角色/菜单/气泡上时要求交互。
// 全屏视频/无边框全屏应用上方仍保留角色：指针不在角色上时点击穿透给应用，
// 压在角色上时正常点击/拖动（不能因为「下方全屏」就永久忽略鼠标）。
function applyMousePolicy() {
  if (!win || win.isDestroyed() || noClickThrough) return
  try {
    win.setIgnoreMouseEvents(!rendererInteractive || !overlayShown, { forward: true })
  } catch (err) {}
}

function setOverlayShown(show) {
  const v = !!show
  if (v && manuallyHidden) return
  if (process.env.FOX_DOCK_ZORDER_DEBUG) console.log('[zorder] setOverlayShown', v, 'current', overlayShown)
  if (v === overlayShown) return
  overlayShown = v
  try {
    win.setOpacity(v ? 1 : 0)
  } catch (err) {}
  if (!v) {
    try {
      win.webContents.send('overlay-hidden')
    } catch (err) {}
  } else {
    try {
      win.showInactive()
    } catch (err) {}
  }
  applyMousePolicy()
}

async function syncZOrder() {
  if (!win || win.isDestroyed()) return
  // 不再按 z-order 隐身。之前的实现用宿主窗口中心做命中，只要该点被
  // 输入法辅助窗（TabTip/TextInputHost）、QQ、全屏播放器等盖住，就把
  // 整个浮层设为 opacity 0；用户把角色吸附到 ZCode 后立刻“消失”。
  // 角色层本身点外穿透，保留显示才是桌宠的预期；手动隐藏仍由
  // manuallyHidden / toggleVisible 负责。
  setOverlayShown(true)
  applyMousePolicy()
}

function startZOrderPoll() {
  // 测试/调试实例用 --no-click-through（窗口始终可交互），不参与生产的前台/全屏策略。
  if (noClickThrough) return
  if (zOrderTimer) clearInterval(zOrderTimer)
  zOrderTimer = setInterval(() => {
    syncZOrder().catch(() => {})
  }, 300)
  if (zOrderTimer.unref) zOrderTimer.unref()
  syncZOrder().catch(() => {})
}

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
    if (win.isVisible()) {
      manuallyHidden = true
      win.hide()
    } else {
      manuallyHidden = false
      overlayShown = true
      win.setOpacity(1)
      win.showInactive()
      syncZOrder().catch(() => {})
    }
  } catch (err) {}
  refreshTray()
}

function openConsole(page) {
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
    const safePage = String(page || '')
    if (/^(sessions|overview|usage|stats|quota|vendors|roles|settings|about)(\?[A-Za-z0-9%&=_.:-]*)?$/.test(safePage)) args.push('--page=' + safePage)
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
    // 「本次退出」：只停本次的守护进程与浮层，不动上面的「开机自启」开关——
    // 下次开机（自启开时）或手动 npm start 照常拉起（语义见设置页「开机自启」说明）。
    { label: '退出 fox-dock（本次退出）', click: quitDock },
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

// ---------- M5 权限待办：动态热键 + 桌面通知 + 推送权限卡（D036） ----------
// 热键只在存在 pending 时注册、pending 清空即注销；高风险 pending 不注册
// 「允许」（D036：高风险不支持热键允许）。通知文案 ≤60 字且已脱敏。

const permHotkeys = new Map() // accelerator -> true
const notifiedActions = new Set()

function resolveAction(id, decision, via) {
  return daemonApi('/v1/actions/' + encodeURIComponent(id) + '/resolve', 'POST', { decision, via }).catch(() => null)
}

function focusHostWindow(sessionKey) {
  return daemonApi('/v1/sessions/' + encodeURIComponent(sessionKey) + '/focus', 'POST').catch(() => null)
}

function syncPermHotkeys(pending) {
  const s = readSettings()
  const hot = (s.permission && s.permission.hotkeys) || {}
  const first = pending[0] || null
  const allowAcc = first && first.risk !== 'high' ? String(hot.allow || '') : ''
  const denyAcc = first ? String(hot.deny || '') : ''
  for (const acc of [...permHotkeys.keys()]) {
    if (acc !== allowAcc && acc !== denyAcc) {
      try {
        globalShortcut.unregister(acc)
      } catch (err) {}
      permHotkeys.delete(acc)
    }
  }
  const bind = (acc, fn, label) => {
    if (!acc || permHotkeys.has(acc)) return
    try {
      if (globalShortcut.register(acc, fn)) permHotkeys.set(acc, true)
      else console.warn('[fox-dock] 权限热键被占用：' + acc + '（' + label + '）')
    } catch (err) {
      console.warn('[fox-dock] 权限热键注册失败：' + acc + ' ' + (err && err.message ? err.message : err))
    }
  }
  bind(allowAcc, () => first && resolveAction(first.id, 'allow', 'hotkey'), '允许一次')
  bind(denyAcc, () => first && resolveAction(first.id, 'deny', 'hotkey'), '拒绝')
}

function maybeNotify(pending) {
  const s = readSettings()
  const mode = (s.permission && s.permission.notify) || 'whenHidden'
  if (mode === 'off' || !pending.length) return
  const petHidden = !overlayShown || !win || win.isDestroyed() || !win.isVisible()
  if (mode === 'whenHidden' && !petHidden) return
  for (const a of pending) {
    if (notifiedActions.has(a.id)) continue
    notifiedActions.add(a.id)
    if (notifiedActions.size > 100) {
      const firstKey = notifiedActions.values().next().value
      notifiedActions.delete(firstKey)
    }
    const tool = String(a.tool || '工具').slice(0, 24)
    const body = String(a.preview || '').slice(0, 60) || tool
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: tool + ' · 正在等待确认（' + String(a.agentId || 'agent') + '）', body, silent: false })
        n.on('click', () => focusHostWindow(a.sessionKey))
        n.show()
      }
    } catch (err) {
      console.warn('[fox-dock] 权限通知失败: ' + (err && err.message ? err.message : err))
    }
  }
}

function setupPermissionWatch() {
  if (!daemonPort) return
  const tick = async () => {
    let pending = []
    try {
      const s = readSettings()
      if (s.permission && s.permission.takeover === true) {
        const r = await daemonApi('/v1/actions')
        if (r && r.ok && Array.isArray(r.actions)) pending = r.actions
      }
    } catch (err) {}
    try {
      if (win && !win.isDestroyed()) win.webContents.send('perm-actions', pending)
    } catch (err) {}
    syncPermHotkeys(pending)
    maybeNotify(pending)
  }
  const timer = setInterval(tick, 2000)
  if (timer.unref) timer.unref()
}

app.whenReady().then(() => {
  const primary = screen.getPrimaryDisplay()
  const chosen = displayMode === 'primary' ? primary : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  // 窗口与工作区精确重合（兜底角落要贴住工作区角）；仅当工作区==整屏
  // （任务栏自动隐藏）时留 1 DIP 不可见缝，避免被当作全屏窗口压住任务栏
  // 滑出热区（1.x v1.16.2 issue #8；见 window-bounds.cjs）。
  const work = overlayWorkAreaBounds(chosen.workArea, chosen.bounds)
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
  try {
    // DPI 缩放下 Electron 会对无边框 toolbar 窗口做尺寸取整；留档实际矩形，
    // 「是否仍与整屏重合（任务栏热区）」这类排查不用再猜（与 1.x v1.16.2 同款）。
    console.log('[fox-dock] window-bounds-actual ' + JSON.stringify(win.getBounds()))
  } catch (err) {}
  win.webContents.on('will-navigate', (event, url) => {
    if (!String(url).startsWith('file://')) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadFile(path.join(__dirname, 'index.html'), {
    query: { port: String(daemonPort), pid: String(process.pid), ignore: ignorePids, ct: noClickThrough ? '0' : '1', allowGeneric: allowGeneric ? '1' : '0' },
  })
  startZOrderPoll()
  // 透明窗口首帧：等页面完成加载再显示，并在显示后补一次整窗失效，
  // 避免 Windows 只合成部分脏区（真机：DOM 有、桌面上只有背景）。
  win.webContents.once('did-finish-load', () => {
    win.showInactive()
    // 首帧补合成不能把 z-order 轮询刚设好的「吸附宿主不在前台 → 隐身」覆盖掉。
    if (!overlayShown) {
      try {
        win.setOpacity(0)
      } catch (err) {}
      return
    }
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

  // daemon 连续不可达才退出：否则桌面上会留一只「点不动的狐狸」，而用户根本
  // 不知道后台已经挂了。60 次 × 1.5s ≈ 90s，要能跨过 daemon 卡死后 watchdog
  // 自动重启的窗口；短时探活失败（GC、磁盘抖动、首次统计）不再让桌宠突然消失。
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
      if (fails >= 60) {
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
  // 读路由同样只走主进程：渲染层不持有令牌、不直连网络（拖拽期间渲染进程
  // 网络会被挂起，主进程转发也一并解决了这一点）。
  ipcMain.handle('daemon-read', async (_e, payload) => {
    const lock = lockInfo()
    if (!lock || !lock.port) return null
    try {
      const res = await fetch('http://127.0.0.1:' + lock.port + String(payload.path || ''), {
        method: 'GET',
        headers: { 'x-fox-token': lock.token || '' },
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      })
      return await res.json()
    } catch (err) {
      return null
    }
  })
  // 音效集音频（M-S）：只允许 /v1/sounds/<id>/file/<slot> 的只读回放；
  // setId/slot 服务端白名单校验，字节经主进程转发，渲染层不持令牌不直连。
  ipcMain.handle('read-sound', async (_e, payload) => {
    const setId = String((payload && payload.setId) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 44)
    const slot = payload && payload.slot === 'release' ? 'release' : 'press'
    if (!setId) return null
    const lock = lockInfo()
    if (!lock || !lock.port) return null
    try {
      const res = await fetch('http://127.0.0.1:' + lock.port + '/v1/sounds/' + encodeURIComponent(setId) + '/file/' + slot, {
        headers: { 'x-fox-token': lock.token || '' },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      const mime = String(res.headers.get('content-type') || 'audio/mpeg').split(';')[0]
      return { mime, bytes: await res.arrayBuffer() }
    } catch (err) {
      return null
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

  ipcMain.on('open-console', (_event, page) => openConsole(page))
  ipcMain.on('hide-overlay', () => {
    manuallyHidden = true
    try {
      win.hide()
    } catch (err) {}
  })
  ipcMain.on('quit-dock', () => quitDock())

  ipcMain.on('set-interactive', (_e, on) => {
    rendererInteractive = !!on
    applyMousePolicy()
  })
  ipcMain.on('set-busy', (_e, on) => {
    petBusy = !!on
    if (petBusy) setOverlayShown(true)
    applyMousePolicy()
  })

  setupTray()
  setupHotkeys()
  setupPermissionWatch()
})

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  try {
    if (zOrderTimer) clearInterval(zOrderTimer)
  } catch (err) {}
  try {
    globalShortcut.unregisterAll()
  } catch (err) {}
  try {
    if (tray) tray.destroy()
  } catch (err) {}
})
