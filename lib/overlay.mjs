// 桌面浮层窗口的管理：单例检查、启动、停止，以及 Electron 运行时的按需安装。
//
// 浮层用独立 Electron 进程承载（WorkBuddy 客户端同样不提供界面注入点【实测：
// 在 app.asar 里没搜到 panel/view 类注入契约】）。Electron 运行时体积较大，所以装在
// 插件数据目录 <${CODEBUDDY_PLUGIN_DATA}>/desktop-runtime 下，插件包里只放几 KB
// 的窗口代码。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, DEFAULT_PORT, PLUGIN_ROOT } from './paths.mjs'
import { HOST_PROCESS_NAME } from './host.mjs'
import { isBlockedHost, readPluginConfig } from './credentials.mjs'
import { ensureServer } from './service.mjs'

const RUNTIME_DIR = path.join(DATA_DIR, 'desktop-runtime')
const ELECTRON_DIST = path.join(RUNTIME_DIR, 'node_modules', 'electron', 'dist')

// Electron 二进制的**平台相对路径**。macOS 在 .app 里（dist/Electron.app/
// Contents/MacOS/Electron），旧版按 win32/其它二分只拼了 dist/electron，
// 在 macOS 上恒不存在 → isRuntimeInstalled() 永远 false、window start 永远失败
//（审查 I6）。
function electronExeCandidates() {
  if (process.platform === 'win32') return [path.join(ELECTRON_DIST, 'electron.exe')]
  if (process.platform === 'darwin') {
    return [path.join(ELECTRON_DIST, 'Electron.app', 'Contents', 'MacOS', 'Electron')]
  }
  return [path.join(ELECTRON_DIST, 'electron')]
}
const ELECTRON_EXE = electronExeCandidates()[0]

// 实际可用的二进制（第一个存在的候选）；未安装返回 null
export function resolveElectronExe() {
  for (const p of electronExeCandidates()) {
    try {
      if (fs.statSync(p).isFile()) return p
    } catch (err) {}
  }
  return null
}
// 单例判定的"亲缘"目录：electron 可执行文件所在的 dist 目录。
// 它在 RUNTIME_DIR 之下，所以同一条产品线的多个安装副本（cache 快照 / worktree）
// 共享同一个目录 → 依然互相识别、依然去重；而 ZCode 版的运行时在
// ~/.zcode/whale/desktop-runtime，绝不相交 → 跨产品线互不干涉。
// 不直接用 RUNTIME_DIR：运行时安装器的 node 进程（install.js）也在它之下，
// 用 dist 目录可以顺手排除掉，避免安装期间被误当成浮层。
const OVERLAY_MARKER_DIR = path.join(RUNTIME_DIR, 'node_modules', 'electron', 'dist')
const OVERLAY_INFO_FILE = path.join(DATA_DIR, 'overlay.json')
const OVERLAY_ENTRY_DIR = path.join(PLUGIN_ROOT, 'desktop')
// 镜像地址先做形态校验再进命令行/下载：这些值来自环境变量，Windows 下起 npm
// 要走 shell（.cmd 不能裸 spawn），未经校验的元字符会被拼进命令行；下载地址
// 同理不该带出 shell/引号面。形态不干净一律回落内置默认。
const ELECTRON_MIRROR = safeMirrorUrl(process.env.ELECTRON_MIRROR, 'https://npmmirror.com/mirrors/electron/')
const NPM_REGISTRY = safeMirrorUrl(process.env.WHALE_NPM_REGISTRY, 'https://registry.npmmirror.com')

// 只放行「http(s)://主机[:端口][/路径]」形态：字符集里没有 shell 元字符
// （& | ; " ' ` $ ( ) < > 空格），拼进命令行也不会改写命令结构；主机再过
// isBlockedHost——镜像地址属于「拉工具时会去请求的 URL」，环回/私有/保留地址
// 与出站硬约束同口径拒绝（需要内网 npm 镜像的场景请用可解析的公网域名或代理）。
export function safeMirrorUrl(raw, fallback) {
  const v = String(raw || '').trim()
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%/-]*)?$/.test(v)) return fallback
  try {
    const u = new URL(v)
    if (isBlockedHost(u.hostname)) return fallback
    return v
  } catch (err) {
    return fallback
  }
}

// 与依赖安装时的 electron 版本保持一致；升级这里即可换运行时。
const ELECTRON_RANGE = '^44.3.0'

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

// shell 只在必须起 .cmd（npm）时打开；裸 node 路径含空格时经 shell 会被拆词，
// 所以带路径的调用显式 shell:false（默认也是 false）。
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, shell: opts.shell === true })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    child.on('error', (err) => resolve({ ok: false, out: out + String(err.message) }))
    child.on('close', (code) => resolve({ ok: code === 0, code, out }))
  })
}

// 只看可执行体会被「装了一半」的运行时骗过：npm install 被中断后 dist 可能缺
// icudtl.dat / v8_context_snapshot.bin，浮层每次启动都死在 ICU 上，桌面永远无挂件
//（2026-10-15 真机：1.0.0 重装后 desktop install 中断，overlay-spawn.log 全是
// "Invalid file descriptor to ICU data received"）。用哨兵文件兜住：可执行体 +
// ICU 数据 + v8 快照，缺任一即视为未装，让 desktop install 走修复路径。
// 哨兵只在 Windows/Linux 的 dist 平铺布局里存在；macOS 的在
// Electron.app/Contents/Frameworks 下，用同一份名单会误判「未安装」。
const RUNTIME_SENTINELS = ['icudtl.dat', 'v8_context_snapshot.bin']
export function isRuntimeInstalled() {
  if (!resolveElectronExe()) return false
  if (process.platform === 'darwin') {
    try {
      return fs.statSync(path.join(ELECTRON_DIST, 'Electron.app', 'Contents', 'Frameworks')).isDirectory()
    } catch (err) {
      return false
    }
  }
  for (const name of RUNTIME_SENTINELS) {
    try {
      if (!fs.statSync(path.join(ELECTRON_DIST, name)).isFile()) return false
    } catch (err) {
      return false
    }
  }
  return true
}

export function runtimePaths() {
  return { runtimeDir: RUNTIME_DIR, electronExe: resolveElectronExe() || ELECTRON_EXE, overlayEntry: OVERLAY_ENTRY_DIR }
}

// 按需安装：npm 装 electron 包，再触发它自带的脚本下载二进制（走国内镜像）。
export async function installRuntime() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  const pkgFile = path.join(RUNTIME_DIR, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(
      pkgFile,
      JSON.stringify(
        {
          name: 'fox-widget-desktop-runtime',
          version: '1.0.0',
          private: true,
          dependencies: { electron: ELECTRON_RANGE },
        },
        null,
        2
      ),
      'utf8'
    )
  }

  // npm.cmd 在 Windows 下必须经 shell 才能起（Node 不允许裸 spawn .cmd）；
  // 参数全是常量 + 形态校验过的 registry（见 safeMirrorUrl），无拼接注入面
  const install = await run(npmBin(), ['install', '--no-audit', '--no-fund', '--registry=' + NPM_REGISTRY], {
    cwd: RUNTIME_DIR,
    shell: process.platform === 'win32',
  })
  if (!install.ok) {
    return { ok: false, step: 'npm install', output: install.out.slice(-1200) }
  }

  if (!isRuntimeInstalled()) {
    // electron 包的 postinstall 在新版 npm 下不一定会跑，这里显式触发
    const installer = path.join(RUNTIME_DIR, 'node_modules', 'electron', 'install.js')
    if (!fs.existsSync(installer)) {
      return { ok: false, step: 'electron install.js 缺失', output: install.out.slice(-800) }
    }
    const fetched = await run(process.execPath, [installer], {
      cwd: RUNTIME_DIR,
      env: { ...process.env, ELECTRON_MIRROR },
    })
    if (!fetched.ok || !isRuntimeInstalled()) {
      return {
        ok: false,
        step: '下载 Electron 二进制',
        output: (fetched.out || '').slice(-1200) + '\n可手动重试：cd ' + RUNTIME_DIR + ' && npm install',
      }
    }
  }
  // 装完必须自检（2026-10-15 真机：npm install 被中断后 dist 缺 icudtl.dat，
  // electron.exe 却在 —— 不校验就会把「装了一半」当成可用运行时）
  if (!isRuntimeInstalled()) {
    return {
      ok: false,
      error:
        '运行时安装不完整（缺 icudtl.dat / v8_context_snapshot.bin 等），多半是下载被中断；请重跑 node lib/cli.mjs desktop install',
    }
  }
  return { ok: true, electronExe: resolveElectronExe() || ELECTRON_EXE }
}

function isProcessAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

// pid 复用兜底：POSIX 上按进程名确认这个 pid 确实是 Electron。Windows 的命令行
// 亲缘判定在 listOverlayPids 里做，这里只在枚举拿不到结果（PowerShell 被组策略
// 禁用 / pgrep 缺失）时才会被调用。
function looksLikeElectron(pid) {
  if (process.platform === 'win32') return true
  try {
    const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 })
    if (!r || r.status !== 0) return false
    return /electron/i.test(String(r.stdout || ''))
  } catch (err) {
    return false
  }
}

// 身份判定结果缓存：枚举进程（Windows 上是同步 PowerShell CIM 查询）不便宜，
// 而 overlayStatus 会被看门狗按 tick 调用。同一个 pid 10 秒内复用结论，避免
// 「判活」变成一个新的常驻开销。
let pidVerdict = { pid: null, at: 0, ok: false }
// 这个 pid 是否真的是**我们**的浮层：优先按命令行亲缘全集判定（同一套判据启停
// 都用）；枚举失败时退化为「进程活着 + 名字像 electron」。
export async function isOwnOverlayPid(pid) {
  if (!isProcessAlive(pid)) return false
  if (pidVerdict.pid === pid && Date.now() - pidVerdict.at < 10_000) return pidVerdict.ok
  const own = await listOverlayPids()
  const ok = own.length ? own.indexOf(pid) !== -1 : looksLikeElectron(pid)
  pidVerdict = { pid, at: Date.now(), ok }
  return ok
}

// 找出本插件的**所有**浮层主进程（不止 overlay.json 里记的那一个）。
//
// 为什么要这样找：浮层可能被多条路径启动——会话自启走的是客户端里的插件副本、
// 命令行手动 start 走的是仓库副本，两边的入口目录不同、却都是「我们的浮层」。
// 只按 overlay.json 里的单个 pid 启停，会让另一个实例变成孤儿：桌面上出现两个
// 嘎啦嘛，且 stop 只收掉一个。这里按命令行特征（入口目录 + 排除 --type= 子进程）
// 枚举，启停都覆盖全集。
// ---------- 有界执行外部命令 ----------
//
// 【2026-10-14 真机】看门狗进程曾被发现「活着却完全不干活」（进程在、15s 的 tick
// 全停，错失多次补活时机）。最可疑的卡点就是 spawnSync：事件循环被同步子进程按住。
// 所以看门狗/服务路径上的外部调用一律走这里——**异步 spawn + 硬超时强杀**，
// 无论子进程发生什么，最迟 timeoutMs 后必定返回，事件循环不会被按住。
export function runBoundedOutput(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    let killer = null
    let child = null
    const done = (v) => {
      if (settled) return
      settled = true
      if (killer) clearTimeout(killer)
      resolve(v)
    }
    killer = setTimeout(() => {
      try {
        if (child) child.kill()
      } catch (e) {}
      done(out)
    }, timeoutMs)
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c) => (out += c))
      child.on('error', () => done(out))
      child.on('close', () => done(out))
    } catch (err) {
      done(out)
    }
  })
}

// ---------- 单例判定的"亲缘"谓词（纯函数，可直接单测） ----------
//
// 【2026-10-14 真机事故】以前用插件名子串匹配命令行（'fox-widget' 与
// 'zcode-fox-widget' 两个标记），但 'fox-widget' 正好是 'zcode-fox-widget' 的
// **子串**，于是本插件的去重会把 ZCode 版的浮层当"重复实例"杀掉——ZCode 版的
// 角色在 WB 侧任何一次 ensure/start/stop 之后从桌面消失（服务还在跑，用户看到
// 的是"插件没了"）。完整证据链见 BUGREPORT-CROSS-LINE-OVERLAY-KILL.md。
//
// 现在的判据 = 命令行是否包含**本插件数据目录的运行时**（OVERLAY_MARKER_DIR，
// 即 electron 可执行文件所在的 dist 目录）：
//   - 同一条产品线的多个安装副本（cache 快照 / worktree 形态）：electron.exe 都
//     来自同一个运行时 → 依然互相识别、依然去重（防"双角色同屏"的初衷不回归）；
//   - 跨产品线（ZCode 版运行时在 ~/.zcode/whale/desktop-runtime）：绝不相交 →
//     互不干涉，各跟各的宿主。
export function isOwnOverlayCommandLine(commandLine, markerDir) {
  const cl = String(commandLine || '')
  const dir = String(markerDir || OVERLAY_MARKER_DIR)
  if (!cl || !dir) return false
  if (process.platform === 'win32') {
    // Windows 路径大小写不敏感、/ 与 \ 等价
    const norm = (s) => s.toLowerCase().replace(/\//g, '\\')
    return norm(cl).indexOf(norm(dir)) !== -1
  }
  return cl.indexOf(dir) !== -1
}

export async function listOverlayPids() {
  const pids = []
  try {
    if (process.platform === 'win32') {
      // 只取 (pid, 命令行)，**在 JS 侧**用 isOwnOverlayCommandLine 过滤——
      // 亲缘判据因此可以脱离 PowerShell 直接单测（见 selftest 的跨线互杀回归）。
      const out = await runBoundedOutput(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
            "Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*--type=*' } | " +
            'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        8000
      )
      let rows = []
      try {
        const parsed = JSON.parse(String(out || '') || '{}')
        rows = Array.isArray(parsed) ? parsed : parsed && parsed.ProcessId ? [parsed] : []
      } catch (err) {
        rows = [] // PowerShell 失败/输出为空：宁可不识别，也不盲杀
      }
      for (const row of rows) {
        const n = Number(row && row.ProcessId)
        if (Number.isInteger(n) && n > 0 && isOwnOverlayCommandLine(row.CommandLine) && pids.indexOf(n) === -1) {
          pids.push(n)
        }
      }
    } else {
      // POSIX：与 Windows 同口径，按运行时的 electron dist 目录认亲
      //（旧写法用插件根目录 OVERLAY_ENTRY_DIR，按副本区分、跨副本不去重）
      const out = await runBoundedOutput('pgrep', ['-f', OVERLAY_MARKER_DIR], 8000)
      for (const line of String(out || '').split(/\r?\n/)) {
        const n = Number(String(line).trim())
        if (Number.isInteger(n) && n > 0 && n !== process.pid && pids.indexOf(n) === -1) pids.push(n)
      }
    }
  } catch (err) {}
  return pids
}

function killPidTree(pid) {
  try {
    if (process.platform === 'win32') {
      // Electron 会派生渲染/GPU 子进程，用 /T 一并收拾。
      // 退出码必须看：权限不足时 taskkill 会失败，调用方（stopOverlay /
      // startOverlay 去重）要据此如实上报，而不是宣称成功。
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 })
      if (r && r.error) return false
      // 128 = 进程不存在：对「收拾掉它」这个目标而言同样算达成；
      // 其余非零（典型是权限不足 1/5）按失败处理，由调用方复验兜底。
      return !!r && (r.status === 0 || r.status === 128)
    }
    process.kill(pid)
    return true
  } catch (err) {
    return err && err.code === 'ESRCH' // 已不存在 = 已达成；其余（EPERM 等）算失败
  }
}

export function readOverlayInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(OVERLAY_INFO_FILE, 'utf8'))
    if (info && typeof info.pid === 'number') return info
  } catch (err) {}
  return null
}

function writeOverlayInfo(info) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(OVERLAY_INFO_FILE, JSON.stringify(info, null, 2), 'utf8')
  } catch (err) {}
}

function clearOverlayInfo() {
  try {
    fs.unlinkSync(OVERLAY_INFO_FILE)
  } catch (err) {}
}

export async function overlayStatus() {
  const info = readOverlayInfo()
  if (!info) return { running: false, installed: isRuntimeInstalled() }
  // 只信 pid 存活会被 pid 复用骗到（Windows 上尤其常见）：把「是不是我们的
  // 浮层」一起判掉，否则 stop 会 taskkill 一个无辜进程（审查 S5）。
  const alive = await isOwnOverlayPid(info.pid)
  if (!alive) clearOverlayInfo()
  return {
    running: alive,
    installed: isRuntimeInstalled(),
    pid: alive ? info.pid : null,
    port: info.port || null,
    startedAt: info.startedAt || null,
  }
}

// ---------- 浮层子进程的环境清理 ----------
//
// 【真机实测 2026-10-14，WorkBuddy 5.8.2】spawn 浮层前**必须**把
// `ELECTRON_RUN_AS_NODE` 从子进程环境里去掉。
//
// 宿主自己把 Electron 二进制当 Node 用，所以它给派生的子进程注入了
// `ELECTRON_RUN_AS_NODE=1`。浮层是**真正的 Electron GUI**，继承该变量后
// electron.exe 会以 Node 模式启动——实测同一个 electron.exe：
//   带该变量 → `--version` 打印 node 版本 `v24.21.0`
//   去掉     → `--version` 打印 Electron 版本 `v44.7.2`
// 此时 `require('electron')` 拿不到 app / BrowserWindow，主进程立刻抛错退出，
// 表现为 `autostart.log` 里的 `overlay=failed:浮层进程启动后立即退出`，桌面上
// 什么都看不到（**服务本身是好的**，`/whale/health` 正常，钩子也正常）。
// 这是 ZCode 分支碰不到的问题（那边没有这个变量），只在 WorkBuddy 上暴露。
//
// 继承来的 `NODE_OPTIONS` 也一并清掉：宿主会塞 `--require=<它的 node shim>`，
// 把宿主的 node 补丁注进我们的 Electron 主进程没有收益、只有串味风险。
// 只影响浮层这一个子进程，父进程（钩子 / MCP / 服务）不受影响。
// 导出供测试直接断言（这条回归真机上丢过一次，必须钉住）。
export function overlaySpawnEnv(svc) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return {
    ...env,
    WHALE_PORT: String(svc.port),
    // 跟随哪个进程：默认 WorkBuddy，可用环境变量覆盖（便于测试或适配改名的构建）
    WHALE_TARGET_PROCESS: process.env.WHALE_TARGET_PROCESS || HOST_PROCESS_NAME,
    // 跟随探测间隔（毫秒）：配置文件里可改，挂件菜单里也能即时调整
    WHALE_FOLLOW_INTERVAL_MS: String(
      readPluginConfig().followIntervalMs || process.env.WHALE_FOLLOW_INTERVAL_MS || 40
    ),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  }
}

// 每个实例用自己的 Electron profile：同线多实例共用 `%APPDATA%\<productName>` 时，第二个
// 实例会抢 GPUCache 文件锁 → 两边 GPU 进程连环崩、正在用的浮层渲染进程被打死（真机事故的
// 根因）。按端口派生 profile 目录，天然互不干扰。
export function overlayProfileDir(port) {
  return path.join(DATA_DIR, 'overlay-profile-' + String(port || overlayPort()))
}

// 等所有浮层实例真正退出（最多 ms 毫秒）。杀进程与 spawn 之间必须留这个窗口。
export async function waitOverlayExit(ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const live = (await listOverlayPids()).filter((pid) => isProcessAlive(pid))
    if (!live.length) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 100))
  }
}

// opts.svc：调用方（SessionStart 自启）刚刚 ensureServer 过时可以直接传进来，
// 避免在钩子的时间预算里再跑一遍 ensureServer（最坏 5s + 6s 会越过 hook 超时）。
// opts.settleMs：spawn 后等窗口起来再判活的时长，默认 1200ms。
export async function startOverlay(opts = {}) {
  // 先归一去重：历史上可能由不同副本/不同路径起了不止一个浮层（桌面出现两个
  // 嘎啦嘛）。保留一个（overlay.json 记的优先，其次最后一个），其余收掉。
  // 【与 stopOverlay 同口径】收完必须复验：杀不掉（多半是对方以更高权限运行）
  // 不能当成功报出去——否则「桌面上有两个角色」会被上层当成正常态。
  const live = (await listOverlayPids()).filter((pid) => isProcessAlive(pid))
  if (live.length) {
    const status = await overlayStatus()
    const keep = status.pid && live.indexOf(status.pid) !== -1 ? status.pid : live[live.length - 1]
    for (const pid of live) {
      if (pid === keep) continue
      killPidTree(pid)
    }
    // 复验：还活着的（不含保留的 keep）如实回报
    const alive = live.filter((pid) => pid !== keep && isProcessAlive(pid))
    writeOverlayInfo({
      pid: keep,
      port: status.port || overlayPort(),
      startedAt: status.startedAt || new Date().toISOString(),
    })
    return {
      running: true,
      started: false,
      pid: keep,
      port: status.port || overlayPort(),
      deduped: live.length - 1 - alive.length,
      // 去重没做干净（有自己家的浮层收不掉）：调用方（看门狗/自启日志）据此上报
      dedupFailed: alive.length ? alive : null,
    }
  }
  const status = await overlayStatus()
  if (status.running) {
    return { running: true, started: false, pid: status.pid, port: status.port }
  }
  if (!isRuntimeInstalled()) {
    return {
      running: false,
      started: false,
      installed: false,
      error: '尚未安装 Electron 运行时',
      hint: '运行：node lib/cli.mjs desktop install（约 150MB，一次性）',
    }
  }

  // 浮层要连挂件服务：外部已经确保过就直接复用（钩子路径的时间预算）
  const svc = opts.svc && opts.svc.running ? opts.svc : await ensureServer()
  if (!svc.running) {
    return { running: false, started: false, error: '挂件服务未就绪：' + (svc.error || '未知原因') }
  }

  // Electron 的 stderr 落到文件：主进程起不来时这是**唯一**的现场。
  // 以前是 stdio:'ignore'，结果真机上连续两次「浮层秒退」完全查不出原因
  // （父进程是钩子/MCP，退出后管道就断了，不能把 stderr 交给它）。
  let errFd = 'ignore'
  try {
    errFd = fs.openSync(path.join(DATA_DIR, 'overlay-spawn.log'), 'a')
  } catch (err) {}

  // 等旧实例真正退干净再起新的：杀完立刻 spawn 会撞上它还没释放的 profile/GPU 文件锁，
  // 那正是真机上「两边 GPU 连环崩 + 渲染进程被打死留下僵尸态」的触发路径。
  await waitOverlayExit(3000)
  const exe = resolveElectronExe()
  if (!exe) {
    return {
      running: false,
      started: false,
      installed: false,
      error: 'Electron 运行时缺少可执行体，请重跑 node lib/cli.mjs desktop install',
    }
  }
  let spawnError = null
  const child = spawn(exe, ['--user-data-dir=' + overlayProfileDir(svc.port), OVERLAY_ENTRY_DIR], {
    detached: true,
    stdio: ['ignore', 'ignore', errFd],
    windowsHide: false,
    env: overlaySpawnEnv(svc),
  })
  // 未监听 'error' 时，spawn 失败会以未捕获异常终止整个进程（MCP 工具 / 钩子）
  child.on('error', (err) => {
    spawnError = err
  })
  if (typeof errFd === 'number') {
    try {
      fs.closeSync(errFd)
    } catch (err) {}
  }
  child.unref()

  writeOverlayInfo({
    pid: child.pid,
    port: svc.port,
    startedAt: new Date().toISOString(),
  })

  // 给窗口一点启动时间，再确认进程仍活着
  await new Promise((r) => setTimeout(r, Number(opts.settleMs) || 1200))
  if (spawnError) {
    clearOverlayInfo()
    return {
      running: false,
      started: false,
      port: svc.port,
      error: '浮层进程启动失败：' + String((spawnError && spawnError.message) || spawnError),
    }
  }
  const alive = isProcessAlive(child.pid)
  if (!alive) clearOverlayInfo()
  return {
    running: alive,
    started: alive,
    pid: alive ? child.pid : null,
    port: svc.port,
    error: alive
      ? null
      : '浮层进程启动后立即退出；先看 ' +
        path.join(DATA_DIR, 'overlay-spawn.log') +
        ' 的报错，再确认运行时（node lib/cli.mjs desktop install）',
  }
}

export async function stopOverlay() {
  const info = readOverlayInfo()
  // 收全集：除了记录在案的实例，还按命令行特征扫出其它副本起的浮层（否则桌面
  // 上会留下一个收不掉的孤儿窗口）
  const pids = (await listOverlayPids()).filter((pid) => isProcessAlive(pid))
  // 枚举不到时才退回记录里的 pid，且必须过「名字像 electron」的校验：pid 复用
  // 会让旧记录指向一个无关进程，taskkill 它属于误伤（审查 S5）。
  if (info && isProcessAlive(info.pid) && pids.indexOf(info.pid) === -1 && looksLikeElectron(info.pid)) {
    pids.push(info.pid)
  }
  if (!pids.length) {
    clearOverlayInfo()
    return { ok: false, error: '浮层未在运行' }
  }
  // 杀的结果不当判据：成不成以「收完是否还活着」为准（见下面的复验）
  for (const pid of pids) killPidTree(pid)
  // 复验前先给进程一点时间真正退掉：taskkill 返回 ≠ 进程已消失。同时这也让紧随其后的
  // startOverlay 不会撞上一个还没释放 profile/GPU 文件锁的旧实例（真机上表现为两边 GPU
  // 连环崩 → 正在用的浮层渲染进程被打死）。
  await waitOverlayExit(2000)
  // **收完必须复验**：taskkill 报成功不等于进程真没了（权限不足时它会失败，
  // 而以前这里无条件清掉 overlay.json，于是「还活着」这件事再也无人知晓）。
  const outcome = overlayStopOutcome(pids, pids.filter((pid) => isProcessAlive(pid)))
  if (!outcome.ok) {
    // 还原记录：进程还活着，overlay.json 必须继续指向它，否则看门狗/钩子会
    // 以为浮层没了而起第二个实例（正是上面 killPidTree 注释里那条连锁）。
    if (info) writeOverlayInfo(info)
    return outcome
  }
  clearOverlayInfo()
  return outcome
}

// 收尾判定（纯函数，抽出来是为了能直接测——stopOverlay 本体要 spawn taskkill，
// 测试里不能碰真实浮层进程）。beforePids = 本次尝试收拾的 pid；stillAlive = 收完
// 仍活着的 pid。
export function overlayStopOutcome(beforePids, stillAlive) {
  const alive = (stillAlive || []).slice()
  if (alive.length) {
    return {
      ok: false,
      alive,
      error:
        '浮层进程未能结束（pid ' +
        alive.join(', ') +
        '）：多半是它以管理员/更高权限运行，普通权限无法结束。' +
        '请用管理员权限结束它，或完全退出宿主等它自行退出后再重开。',
    }
  }
  return { ok: true, killed: (beforePids || []).length }
}

// 让浮层用指定端口（默认跟挂件服务一致）
export function overlayPort() {
  return readPluginConfig().port || DEFAULT_PORT
}
