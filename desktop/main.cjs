// ZCode狐娘小挂件（zcode-fox-widget）的桌面浮层窗口。
//
// ZCode 插件无法往客户端界面注入内容，所以这里用独立 Electron 窗口把挂件页面
// 「浮」在 ZCode 上。为了让它表现得像界面的一部分：
//   - 窗口矩形始终对齐 ZCode 主窗口（由 desktop/follow-window.ps1 常驻探测位置）
//   - 通过 owner 关系让系统处理联动：ZCode 最小化 → 浮层跟着隐藏；
//     ZCode 退出 → 浮层跟着销毁
//   - 透明、无边框、不进任务栏、始终置顶
//   - **默认鼠标穿透**：不在鲸鱼/气泡/菜单上时点击落到下面的 ZCode，不挡操作
//
// 非 Windows 平台拿不到窗口信息，退回「覆盖整个工作区（四周留安全边距）」的静态浮层。
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { evaluateBootState, readNewestLogTail } = require('./ui-ready.cjs')
const { isUpdaterRunning, yieldPlan } = require('./update-guard.cjs')
const { overlayWorkAreaBounds } = require('./window-bounds.cjs')
const { shouldHideBeforeSwitch } = require('./display-follow.cjs')

const PORT = Number(process.env.WHALE_PORT) || 39321
const TARGET_URL = 'http://127.0.0.1:' + PORT + '/'
// 插件数据目录（与 lib/paths.mjs 的 DATA_DIR 同源：<ZCODE_HOME>/whale，默认 ~/.zcode/whale）。
// ZCODE_HOME 认宿主环境变量（与 lib/paths.mjs 同口径），WHALE_DATA_DIR 供 lib/overlay.mjs 把
// 解析结果显式传下来——两侧各自解析会在「设了 ZCODE_HOME 却没导出给子进程」时静默分叉，
// 表现是「让路时停不掉本机服务」「跟随 ZCode 主题失效」（审查 I2）。
const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
const DATA_DIR = process.env.WHALE_DATA_DIR || path.join(ZCODE_HOME, 'whale')

// 按压/松手音效走 HTMLAudio 播放。Electron 默认 autoplay 策略在部分环境会拦
// 非手势起播（表现为「点击有时没声音」），显式放开（须在 app ready 前设置）。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 透明置顶窗口被全屏应用（游戏/视频）完全覆盖后，Chromium 的原生窗口遮挡
// 计算可能把「被完全遮挡 → 停止向屏幕出帧」的判定卡死：遮挡消失后页面逻辑
// 照常运行，但画面永远停在旧帧（实测表现为挂件冻结，重建窗口才能恢复）。
// 关掉这条计算——代价只是被覆盖期间也照常出帧，而浮层本来就常年被 ZCode
// 透过来看，这份开销是设计内的。（须在 app ready 前设置）
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// 第二道保险（2026-10-04 真机实锤）：即便遮挡计算被禁，特定窗口环境（另一块
// 同区域置顶透明窗叠加、或第三方置顶悬浮窗压在挂件上方）仍会把渲染帧调度
// 节流到 1–4fps——页面 visibilityState 仍是 visible、backgroundThrottling:false
// 也拦不住这条原生路径。节流期间 CSS 过渡拿不到起始帧（getAnimations 里
// startTime=null），菜单/角色/峰谷「开了但停在透明态」，用户看到的就是点了
// 没反应。这三个开关按 Chromium 经典口径逐层关掉后台化/节流；页面侧另有
// 帧调度逃生门（widget.js 的 zcwv-anim-off）兜最后一道。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

// 排查用日志：常开。这是冻结/点击取证的黑匣子，必须覆盖 hook 自启的日常
// 实例（v1.4.2 及以前只在 WHALE_DEBUG_PORT 实例写入，日常冻结拿不到第一
// 现场）。设 WHALE_OVERLAY_LOG=0 可显式关闭；CDP 调试口仍只按
// WHALE_DEBUG_PORT 开（见下方 DEBUG_PORT）。启动时超过 5MB 轮转成 .1，
// 防长期写爆。
const DEBUG_LOG = process.env.WHALE_OVERLAY_LOG === '0'
  ? null
  : path.join(DATA_DIR, 'overlay-debug.log')
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
  return Math.min(2000, Math.max(5, Math.round(n)))
}
let followIntervalMs = clampFollowInterval(process.env.WHALE_FOLLOW_INTERVAL_MS || FOLLOW_INTERVAL_DEFAULT)

// 桌宠模式（页面经 whale:pet-mode 设置）：挂件一直浮在所有窗口最上层，
// ZCode 失焦、被别的应用盖住时**不隐身**（普通模式会隐身，见 applyZCodeBounds）。
// 另外周期性重申置顶层级——别的应用（任务管理器、部分安装器/游戏）也会把自己
// 设成 topmost 抢到前面，重申一次就能拉回来；频率 3s，开销可忽略。
const PET_TOPMOST_MS = 3000
let petMode = false
let petTopmostTimer = null
function setPetMode(value) {
  petMode = !!value
  if (petTopmostTimer) {
    clearInterval(petTopmostTimer)
    petTopmostTimer = null
  }
  if (petMode) {
    petTopmostTimer = setInterval(() => {
      if (!win || win.isDestroyed()) return
      try {
        // 只在丢了置顶时才重申：对已是 screen-saver 级置顶的窗口反复调
        // setAlwaysOnTop 会反复打 SetWindowPos，实测参与触发了冻结自愈循环
        if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver')
      } catch (err) {}
    }, PET_TOPMOST_MS)
    if (petTopmostTimer.unref) petTopmostTimer.unref()
  }
  // 立即切换视口，不等下一拍跟随消息（页面 settle 按新视口重钳位置记忆）。
  // 关桌宠时直接按最后一条跟随消息重算常规视口（ZCode 正好失焦会立刻隐身，
  // 那就是普通模式的正确行为）；还没有跟随消息时等下一拍即可。
  if (win && !win.isDestroyed()) {
    if (petMode) {
      // 进入桌宠模式时也消费最近一次 fs：follower 只在状态变化时发消息，
      // 全屏应用已经在前台时不会再补一条，直接 applyFrame 会把鲸鱼盖回去。
      if (lastFollowerMsg && lastFollowerMsg.fs) {
        hideOverlay('fullscreen-foreground')
      } else {
        const b = win.getBounds()
        applyFrame({ x: 0, y: 0, width: b.width, height: b.height, pet: 1 })
      }
    } else if (lastFollowerMsg) {
      applyZCodeBounds(lastFollowerMsg)
    }
  }
  log('pet-mode', petMode ? 'on' : 'off')
}

// 渲染进程"假活"兜底：窗口还在（IsWindowVisible=1、rect 正常），但**渲染进程已经死了**
// 时，桌面看到的是一块空白透明层——所有"它还活着吗"的判据（overlay.json 的 pid 活着、
// kill(pid,0) 成功、看门狗与钩子的补活逻辑）全都通过，于是这个僵尸态可以无限期留着。
// 用**主进程侧**心跳兜住它：定时让页面吐一个值，超时或报错两次就重载页面。不依赖页面
// 配合（页面已经死了，没法自证），也不依赖外部判活。与 WorkBuddy 线同口径。
const PAGE_BEAT_MS = 30000
const PAGE_BEAT_TIMEOUT_MS = 5000
// 功能探针（issue #13）：页面活着（1+1 能答）但输入链路断流——interactive 永远
// 停在 false，悬停/点击全部穿透，只能手动重启。健康页面里「光标压在鲸鱼/面板上
// 却未接管」是不可能态（页面轮询 200ms 内就会把接管翻上来），连续两拍观测到即
// 判定断流，重建窗口恢复。只在浮层可见时探测（隐身期光标位置无意义，防误报）。
const PROBE_STUCK_LIMIT = 2
let pageBeatTimer = null
let pageBeatFails = 0
let pageBeatOk = 0
let probeStuckStreak = 0

function startPageHeartbeat() {
  if (pageBeatTimer) return
  pageBeatTimer = setInterval(probePage, PAGE_BEAT_MS)
  if (pageBeatTimer.unref) pageBeatTimer.unref()
}

async function probePage() {
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return
  if (wc.isLoading()) return // 正在加载/重载：这一拍放过
  if (!overlayShown) {
    probeStuckStreak = 0 // 隐身期不做功能探测：接管本来就为 false
    return
  }
  try {
    const v = await Promise.race([
      wc.executeJavaScript('1+1'),
      new Promise((_res, rej) => setTimeout(() => rej(new Error('page-timeout')), PAGE_BEAT_TIMEOUT_MS)),
    ])
    if (Number(v) !== 2) throw new Error('page-beat-bad:' + String(v))
    if (pageBeatFails) log('page-beat-recovered', String(pageBeatFails) + ' fail(s) before')
    pageBeatFails = 0
    pageBeatOk++
  } catch (err) {
    probeStuckStreak = 0
    pageBeatFails++
    log('page-beat-fail', '(' + pageBeatFails + '/2) ' + String((err && err.message) || err) + ' ok=' + pageBeatOk)
    if (pageBeatFails < 2) return
    pageBeatFails = 0
    log('page-reload', '页面无响应，重载以恢复挂件')
    try {
      wc.reload()
    } catch (e) {}
    return
  }
  // 功能探针：1+1 正常只说明 JS 线程活着，输入链路（onCursor → trackPointerAt →
  // 接管）仍可能已断流。让页面用主进程自己算的光标页面坐标做命中测试——光标
  // 压在鲸鱼/面板上而 interactive 为 false，连续两拍即重建。
  try {
    const cpt = screen.getCursorScreenPoint()
    const cb = win.getContentBounds()
    const px = Math.round(cpt.x - cb.x)
    const py = Math.round(cpt.y - cb.y)
    const probe = await Promise.race([
      wc.executeJavaScript(
        '(window.__zcwProbe ? window.__zcwProbe(' + px + ',' + py + ') : null)'
      ),
      new Promise((res) => setTimeout(() => res(null), PAGE_BEAT_TIMEOUT_MS)),
    ])
    if (!probe || typeof probe.hit !== 'boolean' || typeof probe.interactive !== 'boolean') return
    if (probe.hit && !probe.interactive) {
      probeStuckStreak++
      log('page-probe-stuck', '(' + probeStuckStreak + '/' + PROBE_STUCK_LIMIT + ') hit=true interactive=false @ ' + px + ',' + py)
      if (probeStuckStreak >= PROBE_STUCK_LIMIT) {
        probeStuckStreak = 0
        log('page-recreate', '输入链路断流（命中未接管连续 ' + PROBE_STUCK_LIMIT + ' 拍），重建窗口恢复')
        recreateWindow('page-interactive-stuck')
      }
      return
    }
    if (probeStuckStreak) log('page-probe-recovered', String(probeStuckStreak) + ' stuck beat(s) before')
    probeStuckStreak = 0
  } catch (err) {}
}

function createWindow() {
  // 先在目标显示器工作区里把窗口建出来（跨屏跟随时换成 ZCode 所在屏，缺省主显示器），
  // 但不显示——等拿到 ZCode 窗口位置后再 show，避免鲸鱼先在别处闪一下。
  // 工作区四周留 4 DIP：任务栏自动隐藏时 workArea 等于整屏，精确铺满会被
  // Windows 当成全屏窗口，压制任务栏滑出热区（issue #8）。
  const workArea = overlayWorkArea || screen.getPrimaryDisplay().workArea
  const bounds = overlayWorkAreaBounds(workArea)
  log('window-bounds', JSON.stringify(bounds))
  win = new BrowserWindow({
    ...bounds,
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
    // Windows 上用 toolbar 型窗口：创建即带 WS_EX_TOOLWINDOW 且全程保留。
    // 关键在「宿主冻结」问题（issue #2 症状一，2026-10-14 真机 A/B 实锤）：
    // 点击角色时页面会让本窗口 setIgnoreMouseEvents(false) 接管鼠标，那一瞬
    // 间 Electron 会摘掉 WS_EX_TRANSPARENT|WS_EX_LAYERED——覆盖工作区的置顶
    // 窗口于是被宿主 ZCode 自己的 Chromium 遮挡判定（IsWindowVisibleAndFullyOpaque）
    // 计为「完全不透明遮挡源」，宿主判定自己被完全遮挡后停止出帧（画面停在
    // 旧帧）。带 WS_EX_TOOLWINDOW 的窗口被该判定直接排除。Electron 44 的
    // skipTaskbar 走 ITaskbarList、不再落这个样式位，所以必须显式给。
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
    // **所有平台都必须不可激活**：可激活的浮层被点一下就会把前台从宿主抢走，
    // Windows 上 ZCode 失去前台后画面停止更新（实测点完挂件后 GetForegroundWindow
    // 变成浮层、WM_MOUSEACTIVATE 返回 MA_ACTIVATE，症状是「和挂件互动后 ZCode
    // 像卡住一样」）；macOS/Linux 上同样会把焦点从宿主切走。旧写法只在 win32 关，
    // 非 Windows 点挂件会抢前台（审查 C1/I6）。菜单里的文本框需要键盘时，由页面
    // 通过 whale:keyboard-focus 临时打开（见下方 ipcMain 处理）。
    focusable: false,
    show: false,
    alwaysOnTop: true,
    title: 'ZCode狐娘小挂件',
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
  try {
    // DPI 缩放下 Electron 会对无边框 toolbar 窗口做约 4 物理像素的尺寸取整；
    // 留档实际矩形，issue #8 这类「是否仍与整屏重合」的排查不用再猜。
    log('window-bounds-actual', JSON.stringify(win.getBounds()))
  } catch (err) {}

  win.loadURL(TARGET_URL)

  // 气泡 link 模块是 target="_blank"（widget.js 受控渲染，href 仅 http/https）。
  // Electron 未注册 setWindowOpenHandler 时，_blank 的默认行为是新建一个同
  // webPreferences 的裸 BrowserWindow——无边框控制、不受 overlay.json 管理、
  // 浮层退出后残留。外链一律交给系统浏览器，其余 scheme 直接拒绝；
  // will-navigate 阻断主窗口自身被导航离开挂件页面。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (/^https?:\/\//i.test(url) && url !== TARGET_URL) {
      shell.openExternal(url).catch(() => {})
    }
  })

  // 页面加载完成后按最后一次跟随消息重新走一遍：启动早期到达的消息会在
  // applyFrame 里因 pageReady=false 被丢弃，而跟随脚本只在状态变化时发消息，
  // ZCode 窗口静止时不会再有第二条来补上屏（曾因此整窗停在隐藏态）。
  // 重走 applyZCodeBounds 同时兼顾隐藏、最小化与桌宠视口，不只是补发视口。
  win.webContents.on('did-finish-load', () => {
    pageReady = true
    startPageHeartbeat()
    if (lastFollowerMsg) {
      applyZCodeBounds(lastFollowerMsg)
      return
    }
    if (!lastViewport) return
    try {
      win.webContents.send('whale:viewport', lastViewport)
    } catch (err) {}
  })

  // 渲染进程直接崩掉（GPU 被打死、OOM、页面异常）时立刻重载：Electron 不一定会把窗口
  // 收掉，而是留一块空白窗口（见心跳那段注释）。
  try {
    win.webContents.on('render-process-gone', (_e, details) => {
      log('render-gone', JSON.stringify(details || {}))
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          try {
            win.webContents.reload()
          } catch (err) {}
        }
      }, 1500)
    })
  } catch (err) {}

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

  // blur 只是「通知页面」用的：非 Windows 上临时打开的可激活态同样需要在失焦
  // 时让页面收起编辑器（旧写法只在 win32 挂，非 Windows 会卡在可激活态）。
  win.on('blur', releaseKeyboardFocusOnBlur)

  if (process.platform === 'win32') {
    startFollower()
  } else {
    // 其它平台没有窗口跟随，覆盖**指针所在显示器**的工作区（按主显示器铺会被
    // 多显示器用户看成「挂件跑到另一块屏去了」，审查 C1），并且用
    // showInactive 避免把宿主的前台抢过来
    win.once('ready-to-show', () => {
      try {
        const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
        win.setBounds(overlayWorkAreaBounds(wa))
      } catch (err) {}
      win.showInactive()
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
      // 记下最后一条跟随消息：启动加载门控就绪后要靠它补一次显示
      lastFollowerMsg = msg
      // 身份先于判定处理：换了 ZCode 进程就把门控归零，紧随其后的这次
      // applyZCodeBounds 才会去做「这一次启动」的判定（顺序不能反）
      noteZCodeIdentity(msg)
      noteZcodeTheme(msg)
      applyZCodeBounds(msg)
    }
  })
  child.stderr.on('data', (chunk) => log('follower-stderr', chunk.toString('utf8').slice(0, 200)))
  // spawn 失败（PowerShell 被组策略禁用 / PATH 里没有）只会异步 emit 'error'：
  // 不监听就是未捕获异常，浮层主进程当场崩掉（审查 I1/C3）。降级为「静态浮层」：
  // 覆盖主显示器工作区（四周留安全边距）但不跟随，总比桌面上什么都没有好。
  child.on('error', (err) => {
    if (follower !== child) return
    follower = null
    log('follower-spawn-failed', String((err && err.message) || err))
    try {
      if (!win || win.isDestroyed()) return
      const { workArea } = screen.getPrimaryDisplay()
      // 兜底窗口在主屏，建窗依据也要一起复位，否则之后任何一次重建
      // 都会把它送到上次换屏的副屏，而那边没有跟随脚本
      overlayWorkArea = null
      win.setBounds(overlayWorkAreaBounds(workArea))
      if (!win.isVisible()) {
        win.showInactive()
        overlayShown = true
      }
    } catch (e) {}
  })
  child.on('exit', (code, signal) => {
    // 被主动替换掉的旧实例：这里不再做什么，否则会误退出整个浮层
    if (follower !== child) return
    follower = null
    log('follower-exit', code === null ? 'signal:' + signal : String(code))
    if (app.isQuitting) return
    // 被信号杀掉（code === null）= 脚本异常终止，不是「宿主退出」。此时窗口还在、
    // overlay.json 仍记 pid 存活，而跟随/主题观测/前台判定全部停更、上层还认为浮层健康
    // （假活）。重挂一次跟随脚本；宿主真没了的话，新脚本会立刻退出并走 app.quit()。
    if (code === null) {
      restartFollower('follower-signal')
      return
    }
    // 跟随脚本自己退了（多半是 ZCode 已退出）：浮层也没有存在意义了
    app.quit()
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
// 这里刻意不改浮层窗口自己的位置与尺寸（它始终覆盖工作区，四周留安全边距）：Windows 上
// 透明窗口一旦 setBounds 改变尺寸/位置，合成层不会跟着重排，页面内容会被
// 画到偏离窗口的地方（实测页面 (0,0) 的方块跑到窗口外的屏幕左上角）。
let lastViewport = null

// ---------- 跨显示器跟随 ----------
// 浮层窗口固定覆盖一块显示器的工作区；透明窗口 setBounds 会错位（见上方注释），
// 所以换屏只能整窗重建。判定看 ZCode 窗口中心落在哪块显示器，且稳定一小段时间，
// 避免拖拽经过边界时来回重建。
const DISPLAY_SWITCH_MS = 700
// 等待换屏期间「当前屏还剩多少、要不要先隐身」的判据抽在 desktop/display-follow.cjs
// （纯函数；selftest 用合成矩形覆盖负坐标副屏、不等宽屏与窄缝，不依赖双屏硬件）。
let overlayWorkArea = null // 本次建窗使用的工作区（DIP）；null = 主显示器
let pendingDisplay = null // { id, workArea, timer }

// ---------- ZCode 启动就绪门控 ----------
// ZCode 启动时主窗口先显示加载动画、约 6 秒后主界面才就绪（实测 3.14.4：
// 创建主窗口 10:00:26.9 → database-startup ready 10:00:32.7 → listTaskList OK
// 10:00:33.3）。浮层只跟随窗口矩形，所以加载动画期间就把鲸鱼画了出来。用客户端
// 日志里的启动标记判定：最近一次启动有 boot 标记但还没有 ready 标记 = 加载中，
// 此时不显示（沿用透明度隐身），就绪后自动补一次显示。
//
// 判定必须认「这一次启动」：日志是当天累积的，上一次运行的标记还在里面，浮层
// 跟随脚本报上来的目标窗口 pid（+ 进程启动时间）就是归属依据——身份一变，
// 门控立刻归零重判（2026-10-01 实测：不归零时重开 ZCode，鲸鱼在加载动画里
// 照样出现，因为上一次的「启动→就绪」序列被判成了本次已就绪）。
// 兜底：没有 boot 标记（老版本/日志缺失）一律放行；锚点时间超过 30 秒仍没有
// ready 标记也放行——标记改名绝不能变成"鲸鱼永远不出现"。
const UI_READY_TIMEOUT_MS = 30000
const UI_READY_POLL_MS = 600
// 初值 false：第一条跟随消息就去做一次判定（读取失败/无标记一律放行，见
// refreshUiReady），否则初值 true 会把首次检查整个跳过、加载动画期间照样显示
let uiReady = false
let uiReadyPoll = null
let lastFollowerMsg = null
// 当前跟随的 ZCode 进程身份（跟随脚本上报）
let zcodePid = 0
let zcodePidStart = 0

// 跟随消息里的进程身份变了 = 换了一次 ZCode 运行（重启/退出重开/跟随目标换窗口）。
// 门控必须回到「未就绪」，否则上一次运行留下的 uiReady=true 会把整个加载期放行。
function noteZCodeIdentity(msg) {
  const pid = Number(msg && msg.pid) || 0
  if (!pid) return
  const start = Number(msg && msg.pidStart) || 0
  if (pid === zcodePid && (!start || start === zcodePidStart)) return
  const hadPrev = zcodePid > 0 // 首次识别不算「换了进程」（否则白白多一次隐身与空窗计时）
  log('zcode-identity', 'pid=' + pid + ' start=' + (start || 0) + ' prev=' + zcodePid + '/' + (zcodePidStart || 0))
  zcodePid = pid
  zcodePidStart = start
  uiReady = false
  // 换了宿主进程（ZCode 重启 / 更新）：立刻交还鼠标并隐身。留着接管态会让
  // 透明置顶窗口继续盖在新起来的宿主（或其安装程序）上吃点击——issue #2
  // 的「更新程序无法关闭 ZCode」正是这个形态。
  if (!hadPrev) return
  try {
    if (interactive) applyInteractive(false, true)
  } catch (err) {}
  try {
    if (win && !win.isDestroyed()) hideOverlay('zcode-identity-changed')
  } catch (err) {}
}

// ---------- ZCode 当前主题的观测 ----------
// 跟随脚本顺手读目标窗口的 DWM 沉浸式暗色标志（ZCode 壳层按自己的主题设置
// nativeTheme，见其 app 包），这就是「ZCode 目前用的什么主题」。落盘给挂件
// 服务的 /whale/zcode-theme.json 用（lib/zcode-theme.mjs 合并：观测 > 配置 > 系统）。
const ZCODE_THEME_OBS_FILE = path.join(DATA_DIR, 'zcode-theme-observed.json')
let zcodeThemeObserved = -1
let zcodeThemeObsWrittenAt = 0

function writeZcodeThemeObserved(force) {
  const dark = zcodeThemeObserved
  if (dark !== 0 && dark !== 1) return
  const now = Date.now()
  // 观测没变时按 30s 节流写盘（只为保鲜时间戳），变了立刻写
  if (!force && now - zcodeThemeObsWrittenAt < 30000) return
  zcodeThemeObsWrittenAt = now
  try {
    fs.mkdirSync(path.dirname(ZCODE_THEME_OBS_FILE), { recursive: true })
    fs.writeFileSync(ZCODE_THEME_OBS_FILE, JSON.stringify({ dark, at: now, source: 'dwm' }))
  } catch (err) {}
}

function noteZcodeTheme(msg) {
  const dark = Number(msg && msg.dark)
  if (dark !== 0 && dark !== 1) return
  const changed = dark !== zcodeThemeObserved
  zcodeThemeObserved = dark
  writeZcodeThemeObserved(changed)
  if (changed) log('zcode-theme-observed', String(dark))
}

// 观测文件保鲜：跟随消息只在状态变化时到来，长时间不变也要刷时间戳，免得读取端
// 把仍然有效的观测当过期（TTL 见 lib/zcode-theme.mjs）。每 60s 内部还有 30s 节流。
setInterval(() => writeZcodeThemeObserved(false), 60000)

function refreshUiReady() {
  try {
    const tail = readNewestLogTail(262144)
    if (!tail) {
      uiReady = true
    } else {
      const r = evaluateBootState(tail.text, { pid: zcodePid, processStartAt: zcodePidStart })
      if (r.state === 'loading' && r.anchorAt && Date.now() - r.anchorAt > UI_READY_TIMEOUT_MS) {
        uiReady = true // 标记缺失/改名：超时放行
      } else {
        uiReady = r.state !== 'loading'
      }
      log('ui-gate', r.state + ' reason=' + r.reason + ' pid=' + (zcodePid || 0) + ' anchor=' + (r.anchorAt || 0))
    }
  } catch (err) {
    uiReady = true
  }
  return uiReady
}

// 空窗看门狗：宿主窗口消失超过 MISSING_QUIT_MS 就一起退出，别赖在桌面上。
// 只统计「窗口不存在」这一段（window-missing / 宿主换了进程），被盖住与加载中都不算。
const MISSING_QUIT_MS = 30000
let missingSince = 0
// ---------- 宿主更新时的让路（issue #2 后半段） ----------
// 判定与探测在 desktop/update-guard.cjs；这里只负责动作与节流：
//   交还鼠标 → 让本机挂件服务也退出 → 退出浮层。
// 触发时机：宿主进程已退出（msg.gone），或窗口消失期间探测到宿主更新程序正在跑。
let yielding = false
let updaterProbe = null
const UPDATER_PROBE_MS = 2000

// 让本机挂件服务退出：读 server.json 的令牌打 /whale/shutdown（与 cli.mjs stop 同一条路径）。
// 失败不阻塞退出——浮层必须先让开，最多等 2 秒。
function stopLocalService() {
  return new Promise((resolve) => {
    let info = null
    try {
      info = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'server.json'), 'utf8'))
    } catch (err) {}
    if (!info || typeof info.token !== 'string' || !info.port) return resolve(false)
    let done = false
    const fin = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    setTimeout(() => fin(false), 2000)
    Promise.resolve()
      .then(() =>
        fetch('http://127.0.0.1:' + info.port + '/whale/shutdown', {
          method: 'POST',
          headers: { 'x-whale-token': info.token },
          signal: AbortSignal.timeout(1500),
        })
      )
      .then((res) => res.json())
      .then((d) => fin(!!(d && d.ok)))
      .catch(() => fin(false))
  })
}

function yieldToHost(reason) {
  if (yielding) return
  yielding = true
  stopUpdaterProbe()
  log('yield-' + reason, 'updater=' + (isUpdaterRunning() ? 1 : 0))
  try {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true) // 先交还鼠标
  } catch (err) {}
  stopLocalService().then((ok) => {
    log('yield-service-stop', ok ? 'ok' : 'failed')
    app.quit()
  })
}

// 更新程序探测：只在「宿主窗口消失」期间启用（正常态零开销），2 秒一次。
function startUpdaterProbe() {
  if (updaterProbe || yielding) return
  updaterProbe = setInterval(() => {
    if (yieldPlan({ updaterRunning: isUpdaterRunning(), hostGone: false }) === 'quit-updater') yieldToHost('updater')
  }, UPDATER_PROBE_MS)
}
function stopUpdaterProbe() {
  if (updaterProbe) {
    clearInterval(updaterProbe)
    updaterProbe = null
  }
}

function hideOverlay(reason) {
  if (overlayShown) {
    overlayShown = false
    interactive = false
    win.setIgnoreMouseEvents(true) // 无 forward：隐身期间页面不许再驱动接管
    win.setOpacity(0)
  }
  // 宿主窗口「不存在了」（不是被盖住、也不是在加载）超过一段时间就退出：
  // 更新 ZCode 时旧进程退、新进程还没起来，会出现一段「目标进程还在、窗口没了」
  // 的空窗；此时浮层是一块不该存在的透明置顶窗口，盖在安装程序上会吃点击
  //（issue #2「无法关闭 ZCode」）。被盖住 / 加载中都不算（那是正常状态）。
  if (reason === 'window-missing' || reason === 'zcode-identity-changed') {
    if (!missingSince) missingSince = Date.now()
    // 这一段里宿主可能正被更新程序替换：低频看一眼更新程序在不在跑，在跑就整体让路
    startUpdaterProbe()
  }
  log('hidden', reason)
}

// 空窗看门狗：宿主窗口消失超过 MISSING_QUIT_MS 就一起退出，别赖在桌面上
setInterval(() => {
  if (!missingSince) return
  if (petMode) return // 桌宠模式只关心宿主进程存活（msg.gone 才退）
  if (Date.now() - missingSince < MISSING_QUIT_MS) return
  missingSince = 0
  log('quit-window-missing', String(MISSING_QUIT_MS) + 'ms')
  yieldToHost('window-missing')
}, 10000)

// 加载期挂一个轻量轮询：就绪后立刻补一次显示（跟随脚本只在状态变化时发消息，
// 加载期间不会有新的 show 消息到来）
function ensureUiReadyPoll() {
  if (uiReadyPoll) return
  uiReadyPoll = setInterval(() => {
    if (refreshUiReady()) {
      clearInterval(uiReadyPoll)
      uiReadyPoll = null
      log('ui-ready')
      if (lastFollowerMsg) applyZCodeBounds(lastFollowerMsg)
    }
  }, UI_READY_POLL_MS)
}

function applyZCodeBounds(msg) {
  if (!win || win.isDestroyed()) return
  if (msg.gone) {
    clearPendingDisplay()
    log('zcode-gone')
    const plan = yieldPlan({ hostGone: true, updaterRunning: isUpdaterRunning() })
    yieldToHost(plan === 'quit-updater' ? 'updater' : 'hostgone')
    return
  }
  const winBounds = win.getBounds()

  // 桌宠模式：视口 = 整个浮层窗口（= 主显示器工作区减去安全边距，自动排除任务栏——任务栏在
  // 哪条边都成立，workArea 已按其位置收缩）。鲸鱼在其中自由漫游，与 ZCode 窗口
  // 的位置/大小解耦：失焦、被盖住、最小化、启动加载中都不影响桌宠显示，唯一
  // 关心的是 ZCode 进程存活（msg.gone → 一起退出）。
  if (petMode) {
    // 桌宠模式不参与换屏：别留一个到点还会重建窗口的计时器
    clearPendingDisplay()
    // 全屏应用前台（borderless 游戏/视频/演示，follower 按「矩形覆盖整屏且非
    // 最大化且非 cloaked」判定）：桌宠让路，透明度隐身；退出全屏时 follower 的
    // 状态变化消息走回本函数，applyFrame 自带重现过渡。
    if (msg.fs) {
      hideOverlay('fullscreen-foreground')
      return
    }
    applyFrame({ x: 0, y: 0, width: winBounds.width, height: winBounds.height, pet: 1 })
    return
  }

  // show=false：ZCode 最小化、被别的应用盖住，或窗口暂时找不到。
  // 透明度隐身（而非 win.hide()），原因见 overlayShown 处的注释。
  if (msg.hide || msg.show === false) {
    clearPendingDisplay()
    hideOverlay(msg.hide ? 'window-missing' : 'zcode-not-foreground')
    return
  }
  // ZCode 还在启动加载中：先隐身等着，就绪后由轮询补显示
  if (!uiReady && !refreshUiReady()) {
    clearPendingDisplay()
    hideOverlay('zcode-loading')
    ensureUiReadyPoll()
    return
  }

  let rect = { x: msg.x, y: msg.y, width: msg.w, height: msg.h }
  // 哨兵矩形兜底：最小化窗口的矩形是假的（Windows 报 -32000 一类坐标 + 159x27
  // 的假尺寸），拿它定位会把视口甩出窗口——鲸鱼被画到不可见处。
  if (rect.x < -10000 || rect.y < -10000) {
    // 桌宠模式在上面已提前 return，这里只剩跟随模式：哨兵矩形一律按窗口丢失隐身
    clearPendingDisplay()
    hideOverlay('window-missing')
    return
  }
  // ZCode 给的是物理像素，Electron 的坐标是 DIP
  try {
    if (screen.screenToDipRect) {
      const dip = screen.screenToDipRect(null, rect)
      if (dip && dip.width > 0 && dip.height > 0) rect = dip
    }
  } catch (err) {}

  // 跨屏：ZCode 已稳定落在另一块显示器时，整窗重建到那块屏的工作区。
  // 当前屏上已经看不到 ZCode 就先隐身等切换；还能看到大部分时照常跟随可见部分。
  if (maybeSwitchDisplay(rect)) return

  // 视口 = ZCode 矩形 ∩ 浮层窗口（窗口相对坐标）。ZCode 最大化时会向四周各越界
  // 7px（边框过扫），窗口本身只覆盖工作区（减去安全边距）——不裁交集的话，页面可以把鲸鱼摆进
  // 窗口外的那 7px 里，位置记忆/吸附按溢出矩形计算会把角色锚在「窗口外」。
  // 历史背景：这里曾因冻结检测活性点落在窗外引发「每 5 秒消失再出现」的自愈
  // 循环（真机 2026-10-03 实锤，v1.8.1 修复）；该检测已于 v1.8.6 移除，但交集
  // 钳制保留——空交集（ZCode 完全在窗口外，如整窗移到了另一块显示器）仍视作
  // 窗口丢失，走隐身。
  const vx0 = Math.round(rect.x - winBounds.x)
  const vy0 = Math.round(rect.y - winBounds.y)
  const frame = {
    x: Math.max(0, vx0),
    y: Math.max(0, vy0),
    width: Math.min(winBounds.width, vx0 + Math.round(rect.width)) - Math.max(0, vx0),
    height: Math.min(winBounds.height, vy0 + Math.round(rect.height)) - Math.max(0, vy0),
  }
  if (frame.width <= 0 || frame.height <= 0) {
    hideOverlay('window-missing')
    return
  }
  applyFrame(frame)
}

// 目标显示器与当前浮层所在屏不同时，等位置静止 DISPLAY_SWITCH_MS 再整窗重建。
// 返回 true 表示「这次先别按旧窗口算视口」：ZCode 已明显离开当前屏，浮层已隐身；
// 还能看到大部分时返回 false，照常跟随可见部分。
function maybeSwitchDisplay(rectDip) {
  if (!win || win.isDestroyed()) return false
  let current = null
  let target = null
  let winBounds = null
  try {
    winBounds = win.getBounds()
    current = screen.getDisplayMatching(winBounds)
    // 目标屏按 ZCode 窗口中心判定：getDisplayMatching 取的是「交集面积最大」，
    // 窗口比目标屏宽时，中心已经过屏、多数面积却仍在原屏，会被误判成不用换屏。
    const center = {
      x: Math.round(rectDip.x + rectDip.width / 2),
      y: Math.round(rectDip.y + rectDip.height / 2),
    }
    target = screen.getDisplayNearestPoint
      ? screen.getDisplayNearestPoint(center)
      : screen.getDisplayMatching(rectDip)
  } catch (err) {
    return false
  }
  if (!target || !current || target.id === current.id) {
    clearPendingDisplay()
    return false
  }
  // 当前屏还剩多少 ZCode、要不要先隐身：判据见 desktop/display-follow.cjs
  const wasShown = overlayShown
  const skipFrame = shouldHideBeforeSwitch(rectDip, winBounds)
  if (skipFrame && wasShown) hideOverlay('display-switch-pending')

  // 已经上屏的窗口要等位置静止再切，避免拖拽经过边界时来回重建；还没上屏
  // （冷启动就在副屏、或刚被隐藏）时没有可见画面可闪，直接切，别让首个窗口
  // 白等 700ms、把注定作废的页面加载跑完再丢掉。
  const switchDelay = wasShown ? DISPLAY_SWITCH_MS : 0
  const rectKey = rectDip.x + ',' + rectDip.y + ',' + rectDip.width + ',' + rectDip.height
  if (pendingDisplay && pendingDisplay.id === target.id && pendingDisplay.rectKey === rectKey) return skipFrame
  clearPendingDisplay()
  const wanted = { id: target.id, workArea: target.workArea, rectKey, timer: null }
  wanted.timer = setTimeout(() => {
    if (!pendingDisplay || pendingDisplay.id !== wanted.id) return
    pendingDisplay = null
    if (!win || win.isDestroyed()) return
    // 到点再确认一次：等待期间 ZCode 可能已经移回或移到第三块屏
    let now = null
    try {
      now = screen.getDisplayMatching(win.getBounds())
    } catch (err) {
      return
    }
    if (!now || now.id === wanted.id) return
    log('display-switch', String(wanted.id) + ' ' + JSON.stringify(wanted.workArea))
    overlayWorkArea = wanted.workArea
    recreateWindow('display-switch ' + wanted.id)
  }, switchDelay)
  pendingDisplay = wanted
  return skipFrame
}

function clearPendingDisplay() {
  if (!pendingDisplay) return
  if (pendingDisplay.timer) clearTimeout(pendingDisplay.timer)
  pendingDisplay = null
}

// 计算视口并推送（含显示/重现过渡）。frame 是窗口相对坐标；pet:1 标记桌宠
// 视口（页面端 settle 会自动按新视口重钳位置记忆，锚点语义无需迁移）。
function applyFrame(frame) {
  lastViewport = frame
  missingSince = 0 // 有可用视口 = 宿主窗口在（空窗看门狗据此复位）
  stopUpdaterProbe()

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
    log('shown-at', JSON.stringify(lastViewport))
  } else if (!overlayShown) {
    // 透明度隐身后的重现：只恢复透明度与输入状态，不做任何 show 过渡
    reshowTransition = true
    overlayShown = true
    win.setOpacity(1)
    win.setIgnoreMouseEvents(!interactive, { forward: !interactive })
    kickPresentation('reshow')
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
// 注意 `force`：页面的接管去抖（120ms）会把「刚接管就要收」压平；宿主重启、
// 窗口丢失这类必须立刻交还的场合要能跳过它（issue #2 的点击被吃掉正是这个形态）。
function applyInteractive(next, force) {
  if (!win || win.isDestroyed()) {
    log('interactive-ignored', String(next))
    return
  }
  // 隐身期间页面不许驱动接管：invisible 窗口一旦接管会把本该落到 ZCode
  // 的点击整个吃掉（页面在透明度 0 下照常运行，会拿陈旧指针位置翻状态）
  if (!overlayShown && next) {
    log('interactive-ignored-hidden', String(next))
    return
  }
  const want = !!next
  if (want === interactive && !force) {
    log('interactive-same', String(want))
    return
  }
  interactive = want
  if (want) {
    win.setIgnoreMouseEvents(false)
  } else {
    win.setIgnoreMouseEvents(true, { forward: true })
  }
  log('interactive-applied', String(want) + (force ? ' force' : ''))
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
ipcMain.on('whale:pet-mode', (_event, value) => setPetMode(value))
ipcMain.on('whale:quit', () => app.quit())
ipcMain.handle('whale:workarea', () => screen.getPrimaryDisplay().workArea)

// 迁移说明页外开（lib/widget.js 的「查看说明后升级」）。白名单与 lib/migrate.mjs
// 的 validateMigrationUrl 同口径（main 进程是 CJS，引不了 ESM，这里按同一份清单
// 硬编码；改白名单两处必须同步）：https + 本仓库 GitHub Releases 域 + 路径前缀。
// 页面拿到的 URL 虽然来自服务端校验过的 offer，这里仍按纵深防御再校验一遍——
// 主进程 openExternal 一旦放开就是任意协议/任意域，不能只靠渲染层把关。
ipcMain.handle('whale:open-external', async (_event, url) => {
  try {
    const u = new URL(String(url || ''))
    if (u.protocol !== 'https:') return false
    if (u.username || u.password) return false
    const host = u.hostname.toLowerCase()
    const okHost =
      host === 'github.com' || host === 'objects.githubusercontent.com' || host === 'release-assets.githubusercontent.com'
    if (!okHost) return false
    if (u.port && u.port !== '443') return false
    if (!u.pathname.startsWith('/pigeon189/zcode-fox-widget/releases/')) return false
    await shell.openExternal(u.toString())
    return true
  } catch (err) {
    return false
  }
})

// 不可激活的窗口拿不到键盘输入。页面在指针按到菜单里的文本框/下拉时才请求
// 临时恢复可激活并主动取一次焦点，浮层 UI 全部关闭时再交还前台（回到不可
// 激活），这样「点鲸鱼 / 拖拽 / 开菜单 / 点气泡」都不会打断 ZCode 的前台状态。
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
      // setFocusable(true) 会重写窗口扩展样式，可能把 WS_EX_TOOLWINDOW 冲掉
      // （历史实测：点文本框的瞬间浮层出现在任务栏，一下午攒了七个幽灵按钮；
      // 该位又是宿主遮挡判定排除浮层的关键，见 createWindow 的 type:'toolbar'
      // 注释）。Electron 的 setSkipTaskbar 走 ITaskbarList 补不回样式位，
      // 让跟随进程直接把它写回去（它持有浮层 HWND）。
      followerCommand('toolwindow')
    } else {
      // 顺序不能反：先把前台还给 ZCode，再拆可激活态。setFocusable(false)
      // 会让 Windows 立刻把前台丢给 explorer（黑匣子实测 5ms 内
      // fgPid=explorer、浮层随即被藏），那时 follower 已不满足「由前台进程
      // 启动」的 SetForegroundWindow 许可，之后再 handback 就晚了。
      // handback 本身有 AttachThreadInput 重试兜底，这里再延迟 120ms 拆样式
      // 给它抢跑窗口（follower 的 SetForegroundWindow 命中在前台易主前）。
      const wasFocused = win.isFocused()
      if (wasFocused) followerCommand('handback')
      setTimeout(() => {
        try {
          if (!win || win.isDestroyed()) return
          win.setFocusable(false)
          followerCommand('toolwindow')
        } catch (err) {}
      }, 120)
    }
  } catch (err) {
    log('keyboard-focus-failed', String((err && err.message) || err))
  }
  log('keyboard-focus', String(want))
})

// 浮层窗口失焦：只通知页面，不动焦点/样式状态。原因有二：①原生 select
// 弹出期间主窗口会瞬间失焦（焦点在弹出层上），此时 setFocusable(false)
// 会把弹出层一起拆掉；②真正释放走页面的 setKeyboardFocus(false) IPC——
// 是否「用户离开了」由页面判断（它知道用户刚碰过哪个控件）。
function releaseKeyboardFocusOnBlur() {
  if (!keyboardFocus) return
  try {
    if (win && !win.isDestroyed()) win.webContents.send('whale:window-blur')
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
  // 启动门控一并归零：重建后的窗口要走「先判定再显示」的原路，别继承旧结论
  uiReady = false
  zcodePid = 0
  zcodePidStart = 0
  // 旧跟随消息属于旧窗口坐标：重建后先等新跟随进程的消息，否则会拿旧屏的
  // 矩形再触发一次换屏，来回重建
  clearPendingDisplay()
  lastFollowerMsg = null
  lastViewport = null
  createWindow()
  recreating = false
}

app.whenReady().then(() => {
  createWindow()
  screen.on('display-metrics-changed', (_event, _display, metrics) => {
    // 稍等一拍再动手，让系统先把显示器拓扑稳定下来
    setTimeout(() => {
      // 重建要留在浮层当前所在的显示器上（跨屏跟随过的用户不能被拽回主屏）；
      // 窗口已经没了就回主显示器
      try {
        if (win && !win.isDestroyed()) overlayWorkArea = screen.getDisplayMatching(win.getBounds()).workArea
        else overlayWorkArea = null
      } catch (err) {
        overlayWorkArea = null
      }
      recreateWindow('display-metrics-changed ' + JSON.stringify(metrics || []))
    }, 500)
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
  // 主题观测是「浮层活着时的现值」：退出就删掉，免得下次以旧充新
  // （读取端另有 24h TTL 兜底，见 lib/zcode-theme.mjs）
  try {
    fs.rmSync(ZCODE_THEME_OBS_FILE, { force: true })
  } catch (err) {}
  if (follower) {
    try {
      follower.kill()
    } catch (err) {}
    follower = null
  }
})
