// ZCode 鲸鱼挂件的桌面浮层窗口。
//
// ZCode 插件无法往客户端界面注入内容，所以这里用独立 Electron 窗口把挂件页面
// 「浮」在 ZCode 上。为了让它表现得像界面的一部分：
//   - 窗口矩形始终对齐 ZCode 主窗口（由 desktop/follow-window.ps1 常驻探测位置）
//   - 通过 owner 关系让系统处理联动：ZCode 最小化 → 浮层跟着隐藏；
//     ZCode 退出 → 浮层跟着销毁
//   - 透明、无边框、不进任务栏、始终置顶
//   - **默认鼠标穿透**：不在鲸鱼/气泡/菜单上时点击落到下面的 ZCode，不挡操作
//
// 非 Windows 平台拿不到窗口信息，退回「覆盖整个工作区」的静态浮层。
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const PORT = Number(process.env.WHALE_PORT) || 39321
const TARGET_URL = 'http://127.0.0.1:' + PORT + '/'

// 按压/松手音效走 HTMLAudio 播放。Electron 默认 autoplay 策略在部分环境会拦
// 非手势起播（表现为「点击有时没声音」），显式放开（须在 app ready 前设置）。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 排查用日志：只有开启调试端口时才写，平时零开销。
const DEBUG_LOG = process.env.WHALE_DEBUG_PORT
  ? path.join(os.homedir(), '.zcode', 'whale', 'overlay-debug.log')
  : null
function log(...parts) {
  if (!DEBUG_LOG) return
  try {
    fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + parts.join(' ') + '\n')
  } catch (err) {}
}

// 注意：这里刻意**不**调用 app.disableHardwareAcceleration()。
// 关掉硬件加速会让透明窗口走 CPU 合成，实测内容会被画到偏离窗口的位置
// （页面 (0,0) 的方块出现在窗口外的屏幕左上角），必须保留 GPU 合成。

// 排查用：设置 WHALE_DEBUG_PORT 后可以用 Chrome DevTools 协议连进这个浮层页面
// （查看 DOM、派发输入事件）。默认关闭，不对外暴露。
const DEBUG_PORT = Number(process.env.WHALE_DEBUG_PORT) || 0
if (DEBUG_PORT > 0) {
  app.commandLine.appendSwitch('remote-debugging-port', String(DEBUG_PORT))
}

let win = null
let interactive = false
let follower = null

// 跟随探测间隔（毫秒）。越小越跟手，代价是探测脚本醒来更频繁——它每次只做
// 几个微秒级的 Win32 调用，所以即使是 16ms 也不构成负担。默认 40ms（约 25 次/秒）。
const FOLLOW_INTERVAL_DEFAULT = 40
function clampFollowInterval(value) {
  const n = Number(value)
  if (!isFinite(n) || n <= 0) return FOLLOW_INTERVAL_DEFAULT
  return Math.min(2000, Math.max(16, Math.round(n)))
}
let followIntervalMs = clampFollowInterval(process.env.WHALE_FOLLOW_INTERVAL_MS || FOLLOW_INTERVAL_DEFAULT)

function createWindow() {
  // 先在主显示器工作区里把窗口建出来（尺寸马上会被 ZCode 窗口矩形覆盖），
  // 但不显示——等拿到 ZCode 窗口位置后再 show，避免鲸鱼先在别处闪一下。
  const { workArea } = screen.getPrimaryDisplay()
  win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    transparent: true,
    frame: false,
    // 保持 resizable:true：Electron 对 resizable:false 的窗口会把 min/max 尺寸
    // 锁成创建时的大小，之后 setBounds 改尺寸会被拒绝，页面视口就不再跟随。
    // 窗口无边框且被跟随脚本每 250ms 校正，用户手动拖到边缘也不会跑偏。
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Windows 上必须不可激活：可激活的浮层被点一下就会把前台从 ZCode 抢走，
    // 而 ZCode 失去前台后画面会停止更新——实测点完挂件后 GetForegroundWindow
    // 变成浮层、WM_MOUSEACTIVATE 返回 MA_ACTIVATE，症状是「和挂件互动后 ZCode
    // 像卡住一样，再点一下 ZCode 才恢复」。菜单里的文本框需要键盘时，由页面
    // 通过 whale:keyboard-focus 临时打开（见下方 ipcMain 处理）。
    focusable: process.platform !== 'win32',
    show: false,
    alwaysOnTop: true,
    title: 'DeepSeek 余额小鲸鱼',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  // screen-saver 级别才能稳稳浮在其它应用之上
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })

  win.loadURL(TARGET_URL)

  // 页面加载完成后补发一次视口，避免启动早期的 rect 消息丢失
  win.webContents.on('did-finish-load', () => {
    if (!lastViewport) return
    try {
      win.webContents.send('whale:viewport', lastViewport)
    } catch (err) {}
  })

  // 页面加载失败（多为挂件服务未启动）：稍后重试，避免留下空白窗口
  win.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.loadURL(TARGET_URL)
    }, 2000)
  })

  win.on('closed', () => {
    win = null
  })

  if (process.platform === 'win32') {
    startFollower()
  } else {
    // 其它平台没有窗口跟随，直接铺满工作区
    win.once('ready-to-show', () => {
      win.show()
      win.setIgnoreMouseEvents(true, { forward: true })
    })
  }
}

// ---------- 跟随 ZCode 主窗口 ----------
function startFollower() {
  let hwnd = ''
  try {
    hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString()
  } catch (err) {
    log('hwnd-failed', String((err && err.message) || err))
    return
  }
  const script = path.join(__dirname, 'follow-window.ps1')
  const child = spawn(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-OverlayHwnd',
      hwnd,
      '-IntervalMs',
      String(followIntervalMs),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  follower = child
  log('follower-started', 'interval=' + followIntervalMs + 'ms')
  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg = null
      try {
        msg = JSON.parse(line)
      } catch (err) {
        log('follower-bad-line', line.slice(0, 120))
        continue
      }
      applyZCodeBounds(msg)
    }
  })
  child.stderr.on('data', (chunk) => log('follower-stderr', chunk.toString('utf8').slice(0, 200)))
  child.on('exit', (code) => {
    // 被主动替换掉的旧实例：这里不再做什么，否则会误退出整个浮层
    if (follower !== child) return
    follower = null
    log('follower-exit', String(code))
    // 跟随脚本自己退了（多半是 ZCode 已退出）：浮层也没有存在意义了
    if (code !== null && !app.isQuitting) app.quit()
  })
}

// 改探测间隔：替换探测脚本即可，不需要重启窗口，页面状态不丢
function restartFollower(reason) {
  if (!win || win.isDestroyed()) return
  log('follower-restart', reason + ' interval=' + followIntervalMs)
  const old = follower
  follower = null
  if (old) {
    try {
      old.kill()
    } catch (err) {}
  }
  startFollower()
}

// 把 ZCode 窗口矩形换算成浮层窗口内的相对矩形后发给页面。
// 页面把它当作自己的「视口」：吸附边界、位置记忆、菜单定位全部以它为准，
// 于是鲸鱼看起来就待在 ZCode 窗口里，并跟着窗口移动、缩放。
//
// 这里刻意不改浮层窗口自己的位置与尺寸（它始终铺满工作区）：Windows 上
// 透明窗口一旦 setBounds 改变尺寸/位置，合成层不会跟着重排，页面内容会被
// 画到偏离窗口的地方（实测页面 (0,0) 的方块跑到窗口外的屏幕左上角）。
let lastViewport = null

function applyZCodeBounds(msg) {
  if (!win || win.isDestroyed()) return
  if (msg.gone) {
    log('zcode-gone')
    app.quit()
    return
  }
  // show=false：ZCode 最小化、被别的应用盖住，或窗口暂时找不到
  if (msg.hide || msg.show === false) {
    if (win.isVisible()) win.hide()
    log('hidden', msg.hide ? 'window-missing' : 'zcode-not-foreground')
    return
  }

  let rect = { x: msg.x, y: msg.y, width: msg.w, height: msg.h }
  // ZCode 给的是物理像素，Electron 的坐标是 DIP
  try {
    if (screen.screenToDipRect) {
      const dip = screen.screenToDipRect(null, rect)
      if (dip && dip.width > 0 && dip.height > 0) rect = dip
    }
  } catch (err) {}

  const winBounds = win.getBounds()
  lastViewport = {
    x: Math.round(rect.x - winBounds.x),
    y: Math.round(rect.y - winBounds.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }

  if (!win.isVisible()) {
    win.showInactive()
    if (!interactive) win.setIgnoreMouseEvents(true, { forward: true })
    log('shown-at', JSON.stringify(lastViewport))
  }

  try {
    win.webContents.send('whale:viewport', lastViewport)
  } catch (err) {}
}

// ---------- 鼠标接管切换 ----------
function applyInteractive(next) {
  if (!win || win.isDestroyed()) {
    log('interactive-ignored', String(next))
    return
  }
  const want = !!next
  if (want === interactive) {
    log('interactive-same', String(want))
    return
  }
  interactive = want
  if (want) {
    win.setIgnoreMouseEvents(false)
  } else {
    win.setIgnoreMouseEvents(true, { forward: true })
  }
  log('interactive-applied', String(want))
}

ipcMain.on('whale:interactive', (_event, value) => {
  log('ipc-interactive', String(value))
  applyInteractive(value)
})
// 挂件菜单里改「跟随延迟」走这里：即时生效，不需要重启浮层
ipcMain.on('whale:follow-interval', (_event, value) => {
  const next = clampFollowInterval(value)
  if (next === followIntervalMs) return
  followIntervalMs = next
  restartFollower('interval-changed')
})
ipcMain.handle('whale:follow-interval-get', () => followIntervalMs)
ipcMain.on('whale:quit', () => app.quit())
ipcMain.handle('whale:workarea', () => screen.getPrimaryDisplay().workArea)

// 不可激活的窗口拿不到键盘输入。页面在指针按到菜单里的文本框/下拉时才请求
// 临时恢复可激活并主动取一次焦点，离开后立刻交还前台（回到不可激活），
// 这样「点鲸鱼 / 拖拽 / 开菜单 / 点气泡」都不会打断 ZCode 的前台状态。
let keyboardFocus = false
ipcMain.on('whale:keyboard-focus', (_event, value) => {
  if (!win || win.isDestroyed()) return
  const want = !!value
  if (want === keyboardFocus) return
  keyboardFocus = want
  try {
    if (want) {
      win.setFocusable(true)
      win.focus()
    } else {
      win.setFocusable(false)
      win.blur()
    }
  } catch (err) {
    log('keyboard-focus-failed', String((err && err.message) || err))
  }
  log('keyboard-focus', String(want))
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  app.isQuitting = true
  if (follower) {
    try {
      follower.kill()
    } catch (err) {}
    follower = null
  }
})

app.whenReady().then(createWindow)
