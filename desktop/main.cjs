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

// 透明置顶窗口被全屏应用（游戏/视频）完全覆盖后，Chromium 的原生窗口遮挡
// 计算可能把「被完全遮挡 → 停止向屏幕出帧」的判定卡死：遮挡消失后页面逻辑
// 照常运行，但画面永远停在旧帧（实测表现为挂件冻结，重建窗口才能恢复）。
// 关掉这条计算——代价只是被覆盖期间也照常出帧，而浮层本来就常年被 ZCode
// 透过来看，这份开销是设计内的。（须在 app ready 前设置）
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// 排查用日志：常开。这是冻结/点击取证的黑匣子，必须覆盖 hook 自启的日常
// 实例（v1.4.2 及以前只在 WHALE_DEBUG_PORT 实例写入，日常冻结拿不到第一
// 现场）。设 WHALE_OVERLAY_LOG=0 可显式关闭；CDP 调试口仍只按
// WHALE_DEBUG_PORT 开（见下方 DEBUG_PORT）。启动时超过 5MB 轮转成 .1，
// 防长期写爆。
const DEBUG_LOG = process.env.WHALE_OVERLAY_LOG === '0'
  ? null
  : path.join(os.homedir(), '.zcode', 'whale', 'overlay-debug.log')
try {
  if (DEBUG_LOG && fs.statSync(DEBUG_LOG).size > 5 * 1024 * 1024) {
    fs.rmSync(DEBUG_LOG + '.1', { force: true })
    fs.renameSync(DEBUG_LOG, DEBUG_LOG + '.1')
  }
} catch (err) {}
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
// 浮层「应显示」状态：true=透明度 1 跟随中，false=透明度 0 隐身。
// 隐身/重现刻意**不做** win.hide()/showInactive()——窗口生命周期切换会把
// 原生输入管线卡死（重现后物理点击到不了渲染器，2026-10-01 实测），而
// 透明度切换不触碰窗口生命周期。首次显示仍是真正的 showInactive（每条
// 窗口生命周期只有一次，实测无此问题）。
let overlayShown = false
let follower = null
let pageReady = false // 页面已加载出真实内容（此前上屏只会是一帧空透明画面）

// 出帧保险：强制合成器重新送一帧 + 把窗口顶回最上层。零视觉变化，
// 用于对抗「合成视觉脱钩后画面停在旧帧」的偶发状态（见上面的 disable-features）。
function kickPresentation(reason) {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.invalidate()
    win.moveTop()
    log('kick', reason)
  } catch (err) {}
}

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
    pageReady = true
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

  // 页面侧黑匣子：把页面 console（含 [zcw] 埋点与未捕获异常）转进调试日志。
  // 「点击没反应」「画面冻结」这类状态性问题复发时，这里是第一现场。
  // 只有调试模式下才挂（DEBUG_LOG 为 null 时零开销）。
  if (DEBUG_LOG) {
    win.webContents.on('console-message', (...args) => {
      try {
        const d = args[0]
        if (d && typeof d === 'object' && 'message' in d) {
          log('page-l' + (d.level != null ? d.level : '?'), String(d.message).slice(0, 300))
        } else {
          log('page-l' + args[1], String(args[2]).slice(0, 300))
        }
      } catch (err) {}
    })
  }

  win.on('closed', () => {
    win = null
  })

  if (process.platform === 'win32') {
    win.on('blur', releaseKeyboardFocusOnBlur)
  }

  if (process.platform === 'win32') {
    startFollower()
  } else {
    // 其它平台没有窗口跟随，直接铺满工作区
    win.once('ready-to-show', () => {
      win.show()
      overlayShown = true
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
      // 浮层窗口由本进程（Electron 主进程）持有，跟随脚本据此判断「前台是不是
      // 浮层自己」，不必按进程名枚举 electron（其它 Electron 应用在前台时会误判）。
      '-OverlayPid',
      String(process.pid),
    ],
    // stdin 保持管道：跟随脚本用它做常驻命令通道（replay-click / handback，
    // 见 follow-window.ps1 的 CommandReader），避免每次都冷启动一个 PowerShell
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  follower = child
  if (child.stdin) {
    child.stdin.on('error', () => {}) // 跟随进程退出时管道会断，静默即可
  }
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

// 跟随进程的常驻命令通道（stdin，一行一条）：click 重放与前台归还都由它做，
// 它是本进程的子进程且已持 DPI/原生上下文，比临时起 PowerShell 又快又稳
function followerCommand(cmd) {
  const child = follower
  if (!child || !child.stdin || child.stdin.destroyed) return
  try {
    child.stdin.write(cmd + '\n')
  } catch (err) {}
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
  // show=false：ZCode 最小化、被别的应用盖住，或窗口暂时找不到。
  // 透明度隐身（而非 win.hide()），原因见 overlayShown 处的注释。
  if (msg.hide || msg.show === false) {
    if (overlayShown) {
      overlayShown = false
      interactive = false
      win.setIgnoreMouseEvents(true) // 无 forward：隐身期间页面不许再驱动接管
      win.setOpacity(0)
    }
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

  let reshowTransition = false
  if (!win.isVisible()) {
    // 页面没加载完就上屏，只会把一帧空透明画面交给合成器——首帧必须是
    // 真实内容，宁可晚几毫秒出现（did-finish-load 后下一拍跟随消息自然放行）。
    // 这是窗口生命周期里唯一一次真正的 show 过渡，实测无输入问题。
    if (!pageReady) return
    win.showInactive()
    overlayShown = true
    win.setOpacity(1)
    win.setIgnoreMouseEvents(!interactive, { forward: !interactive })
    kickPresentation('reshow')
    resetDetectorWindow()
    log('shown-at', JSON.stringify(lastViewport))
  } else if (!overlayShown) {
    // 透明度隐身后的重现：只恢复透明度与输入状态，不做任何 show 过渡
    reshowTransition = true
    overlayShown = true
    win.setOpacity(1)
    win.setIgnoreMouseEvents(!interactive, { forward: !interactive })
    kickPresentation('reshow')
    resetDetectorWindow()
    log('reshown-at', JSON.stringify(lastViewport))
  }

  try {
    // fresh 标记：重现瞬间页面的指针结论（lastPointer/迟滞残留）全部作废，
    // 页面据此清空并强制重算，避免隐藏期陈旧状态维持错误的接管/穿透
    win.webContents.send(
      'whale:viewport',
      reshowTransition ? Object.assign({ fresh: 1 }, lastViewport) : lastViewport
    )
  } catch (err) {}
}

// ---------- 鼠标接管切换 ----------
function applyInteractive(next) {
  if (!win || win.isDestroyed()) {
    log('interactive-ignored', String(next))
    return
  }
  // 隐身期间页面不许驱动接管：invisible 窗口一旦接管会把本该落到 ZCode
  // 的点击整个吃掉（页面在透明度 0 下照常运行，会拿陈旧指针位置翻状态）
  if (!overlayShown) {
    log('interactive-ignored-hidden', String(next))
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
      // 不调用 win.blur()：它把前台交给 shell（explorer）而不是 ZCode，
      // ZCode 继续冻着、跟随脚本看到 explorer 前台还会把浮层藏掉。
      // 此时若浮层仍是前台窗口，让跟随进程把前台还给 ZCode 的主窗口
      // （子进程由前台进程启动，Windows 允许它 SetForegroundWindow）。
      if (win.isFocused()) followerCommand('handback')
    }
  } catch (err) {
    log('keyboard-focus-failed', String((err && err.message) || err))
  }
  log('keyboard-focus', String(want))
})

// 浮层失去前台（用户点回 ZCode / Alt-Tab）：键盘焦点状态就地作废，并通知
// 页面收起菜单/编辑器。此前这一步靠 focusout 兜底，但窗口失活时
// document.activeElement 不变，编辑器和接管状态会一直挂着（实测表现为
// 「ZCode 冻住、必须手动关掉气泡设置才恢复」）。
function releaseKeyboardFocusOnBlur() {
  if (!keyboardFocus) return
  keyboardFocus = false
  try {
    if (win && !win.isDestroyed()) {
      win.setFocusable(false)
      win.webContents.send('whale:window-blur')
    }
  } catch (err) {}
  log('keyboard-focus-blur')
}

// 点在挂件界面之外：页面已收起菜单/编辑器并交还穿透，这里把被浮层吃掉的
// 那一次点击在原位置重放给 ZCode（一次点击 = 收起浮层 + 落进 ZCode）
ipcMain.on('whale:dismiss-replay', () => {
  if (!win || win.isDestroyed()) return
  if (interactive) applyInteractive(false)
  followerCommand('replay-click')
  log('dismiss-replay')
})

// 页面的指针跟踪依赖「穿透时 forward 的 pointermove」与「接管时的真实鼠标事件」，
// 这条事件流在个别场景会断：系统原生下拉弹出期间模态捕获全屏鼠标、窗口
// 隐藏-显示、焦点切换失败等。事件流一断，页面就再也感知不到指针移动，
// 鲸鱼会永远点不到（表现为「点击完全没有响应」）。主进程按 200ms 轮询一次
// 真实光标位置兜底发给页面：页面把它当低频位置修正，真事件仍占主导。
setInterval(() => {
  if (!overlayShown || !win || win.isDestroyed()) return
  try {
    const p = screen.getCursorScreenPoint()
    const b = win.getContentBounds()
    win.webContents.send('whale:cursor', { x: Math.round(p.x - b.x), y: Math.round(p.y - b.y) })
  } catch (err) {}
}, 200)

// 兜底自愈：对可见中的窗口定期做一次出帧保险。若画面真的冻结在旧帧，
// 最迟 60 秒内被踢回正常，不需要手动 window stop/start。
setInterval(() => {
  if (!overlayShown || !win || win.isDestroyed()) return
  kickPresentation('periodic')
}, 60000)

// ---------- 冻结检测：活性点像素对账 ----------
//
// 合成器级冻结的页面侧永远发现不了（rAF/事件/气泡全活着，只有屏幕停在
// 旧帧），唯一真相是合成后的桌面像素。页面在鲸鱼身体上放了一个 6px 活性
// 点（黑白交替翻转，见 widget.js），并把物理矩形经 whale:live-rect 报上来；
// dxgi-watch.ps1 用桌面复制采样该处像素输出哈希。判定：页面在翻（phase
// 推进）而采样哈希持续不变 = 冻结。解冻阶梯：先透明度闪烁（逼迫合成器重
// 推一帧），无效再整窗重建。曾经的 min/restore 已废弃——窗口生命周期过渡
// 会把原生输入管线卡死（见 overlayShown 处注释）。
let liveRect = null
let liveRectAt = 0
let lastSeenPhase = null
let healthySince = 0
let lastHealAt = 0
let healLevel = 0
const pixSamples = []
const LIVE_RECT_FILE = path.join(os.homedir(), '.zcode', 'whale', 'live-rect.json')

// 重现/自愈后重置检测观测窗：隐藏期的样本是「浮层不在场」的静态哈希，
// healthySince/lastSeenPhase 也停留在隐藏前——不清掉，重现后的第一拍就会
// 被过期数据判成冻结。真冻结最多晚 4 秒发现，可接受。
function resetDetectorWindow() {
  pixSamples.length = 0
  healthySince = Date.now()
  lastSeenPhase = null
}

ipcMain.on('whale:live-rect', (_event, rect) => {
  if (!rect || typeof rect.x !== 'number' || !(rect.w > 0)) return
  // 隐藏期间页面的 visibilityState 不会变 hidden（Electron 怪癖，实测活性点
  // 相位在隐藏期照常推进），上报会一直来。但此时浮层根本不在屏幕上，采样
  // 的是它身后的静态背景——拿这些报告刷新 liveRectAt，会让重现瞬间检测器
  // 踩着「隐藏期恒定哈希」误判冻结（2026-09-30/10-01 黑匣子两度实锤，且
  // 60s 内两次会升级成整窗重建）。隐藏期一律不收。
  if (!overlayShown || !win || win.isDestroyed()) return
  liveRect = rect
  liveRectAt = Date.now()
  try {
    fs.mkdirSync(path.dirname(LIVE_RECT_FILE), { recursive: true })
    fs.writeFileSync(LIVE_RECT_FILE, JSON.stringify({ x: rect.x, y: rect.y, w: rect.w, h: rect.h }))
  } catch (err) {}
})

let watcher = null
let watcherRespawnAt = 0
let watcherBlindLogged = 0
function startFreezeWatcher() {
  if (process.platform !== 'win32' || watcher) return
  try {
    watcher = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'dxgi-watch.ps1'), '-RectFile', LIVE_RECT_FILE],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (err) {
    watcher = null
    watcherRespawnAt = Date.now() + 60000
    return
  }
  let buf = ''
  watcher.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line.indexOf('pix ') === 0) {
        pixSamples.push({ h: line.slice(4, 12), t: Date.now() })
      } else if (line.indexOf('blind ') === 0) {
        // 传感器不可用（无 D3D/被占用等）：检测自动失效，只在调试日志留痕
        if (watcherBlindLogged < 3 || watcherBlindLogged % 100 === 0) log('watcher-blind', line.slice(0, 80))
        watcherBlindLogged += 1
      }
    }
  })
  watcher.stderr.on('data', (chunk) => log('watcher-stderr', chunk.toString('utf8').slice(0, 200)))
  watcher.on('exit', (code) => {
    watcher = null
    watcherRespawnAt = Date.now() + 15000
    log('watcher-exit', String(code))
  })
}

function healFreeze() {
  const now = Date.now()
  // 60 秒内反复冻结才升级；隔久了从头来（新触发因素从最轻的一档试起）
  if (now - lastHealAt > 60000) healLevel = 0
  lastHealAt = now
  pixSamples.length = 0
  healthySince = now
  if (healLevel === 0) {
    healLevel = 1
    log('freeze-heal', 'opacity-flicker')
    try {
      // 透明度 0→1 闪烁逼迫合成器重推一帧；刻意不做 min/restore——窗口
      // 生命周期过渡会把原生输入管线卡死（本文件 overlayShown 处注释）
      win.setOpacity(0)
      setTimeout(() => {
        try {
          if (win && !win.isDestroyed()) {
            win.setOpacity(1)
            kickPresentation('heal')
          }
        } catch (err) {}
      }, 120)
    } catch (err) {
      log('freeze-heal-failed', String((err && err.message) || err))
    }
  } else {
    healLevel = 0
    log('freeze-heal', 'recreate')
    recreateWindow('freeze-detected')
  }
}

setInterval(() => {
  if (!watcher && Date.now() > watcherRespawnAt) startFreezeWatcher()
  if (!overlayShown || !win || win.isDestroyed()) return
  if (!liveRect || Date.now() - liveRectAt > 5000) return // 页面没在报（未加载/被覆盖/隐藏）
  const now = Date.now()
  while (pixSamples.length && now - pixSamples[0].t > 10000) pixSamples.shift()
  const recent = pixSamples.filter((s) => now - s.t <= 4000)
  if (recent.length < 5) return
  // 页面活性：phase 在推进（页面活着）；phase 也停了说明是页面挂死，不是合成器冻结
  const pageAlive = liveRect.phase !== lastSeenPhase
  lastSeenPhase = liveRect.phase
  if (!pageAlive) return
  const allSame = recent.every((s) => s.h === recent[0].h)
  if (!allSame) {
    healthySince = now
    return
  }
  // 连续 4 秒以上：页面在翻、屏幕像素纹丝不动
  if (now - healthySince < 4000) return
  log('freeze-detected', 'samples=' + recent.length + ' phase=' + liveRect.phase)
  healFreeze()
}, 1000)

// DPI/显示缩放变更后，透明置顶窗口的交换链可能整体死掉：页面活着、渲染器
// 照常出帧（CDP 截图正常），但屏幕停在旧帧，invalidate/moveTop 的出帧保险
// 也救不回来（实测 2026-09-30：缩放 125%→150% 后冻结复发，kick periodic
// 每 60s 都在打但画面不动）。唯一可靠的恢复是重建窗口——与其等用户发现
// 卡住再手动 window restart，不如在指标变更的当下自动重建一次，把状态性
// 冻结压成一次无感重启。
let recreating = false
function recreateWindow(reason) {
  if (recreating) return
  recreating = true
  log('recreate-window', reason)
  const old = follower
  follower = null
  if (old) {
    try {
      old.kill()
    } catch (err) {}
  }
  try {
    if (win && !win.isDestroyed()) win.destroy()
  } catch (err) {}
  win = null
  pageReady = false
  // 状态归零：新页面 boot 会自己发 setOverlayInteractive(false)，但若那条
  // 初始化 IPC 丢失，主进程残留的 interactive=true 会吞掉页面的同值请求
  // （interactive-same 陷阱，黑匣子出现过一次），窗口永远穿透。重建时把
  // 交互与检测状态全部回到与「全新窗口」一致的起点。
  interactive = false
  keyboardFocus = false
  overlayShown = false
  liveRect = null
  liveRectAt = 0
  lastSeenPhase = null
  healthySince = Date.now()
  healLevel = 0
  pixSamples.length = 0
  createWindow()
  recreating = false
}

app.whenReady().then(() => {
  createWindow()
  startFreezeWatcher()
  screen.on('display-metrics-changed', (_event, _display, metrics) => {
    // 稍等一拍再动手，让系统先把显示器拓扑稳定下来
    setTimeout(() => recreateWindow('display-metrics-changed ' + JSON.stringify(metrics || [])), 500)
  })
})
app.on('window-all-closed', () => {
  // recreateWindow 会先 destroy 再 createWindow，中间窗口数为零——这一拍
  // 绝不能退出（2026-10-01 实测：重建路径首秀被这条竞态整锅端掉，浮层直接
  // 消失）。只有主动退出或非重建状态才允许 quit。
  if (!app.isQuitting && !recreating) app.quit()
})
app.on('before-quit', () => {
  app.isQuitting = true
  if (watcher) {
    try {
      watcher.kill()
    } catch (err) {}
    watcher = null
  }
  if (follower) {
    try {
      follower.kill()
    } catch (err) {}
    follower = null
  }
})
