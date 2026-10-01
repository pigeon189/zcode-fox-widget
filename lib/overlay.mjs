// 桌面浮层窗口的管理：单例检查、启动、停止，以及 Electron 运行时的按需安装。
//
// 浮层用独立 Electron 进程承载（ZCode 客户端本身不提供界面注入点）。Electron
// 运行时体积较大，所以装在数据目录 ~/.zcode/whale/desktop-runtime 下，插件包
// 里只放几 KB 的窗口代码。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, DEFAULT_PORT, PLUGIN_ROOT } from './paths.mjs'
import { isBlockedHost, readPluginConfig } from './credentials.mjs'
import { ensureServer } from './service.mjs'

const RUNTIME_DIR = path.join(DATA_DIR, 'desktop-runtime')
const ELECTRON_EXE = path.join(
  RUNTIME_DIR,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)
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

export function isRuntimeInstalled() {
  try {
    return fs.statSync(ELECTRON_EXE).isFile()
  } catch (err) {
    return false
  }
}

export function runtimePaths() {
  return { runtimeDir: RUNTIME_DIR, electronExe: ELECTRON_EXE, overlayEntry: OVERLAY_ENTRY_DIR }
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
          name: 'zcode-whale-desktop-runtime',
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
  return { ok: true, electronExe: ELECTRON_EXE }
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
  const alive = isProcessAlive(info.pid)
  if (!alive) clearOverlayInfo()
  return {
    running: alive,
    installed: isRuntimeInstalled(),
    pid: alive ? info.pid : null,
    port: info.port || null,
    startedAt: info.startedAt || null,
  }
}

export async function startOverlay() {
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

  // 浮层要连挂件服务，先把服务确保在跑
  const svc = await ensureServer()
  if (!svc.running) {
    return { running: false, started: false, error: '挂件服务未就绪：' + (svc.error || '未知原因') }
  }

  const child = spawn(ELECTRON_EXE, [OVERLAY_ENTRY_DIR], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: {
      ...process.env,
      WHALE_PORT: String(svc.port),
      // 跟随哪个进程：默认 ZCode，可用环境变量覆盖（便于测试或适配改名的构建）
      WHALE_TARGET_PROCESS: process.env.WHALE_TARGET_PROCESS || 'ZCode',
      // 跟随探测间隔（毫秒）：配置文件里可改，挂件菜单里也能即时调整
      WHALE_FOLLOW_INTERVAL_MS: String(
        readPluginConfig().followIntervalMs || process.env.WHALE_FOLLOW_INTERVAL_MS || 40
      ),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  })
  child.unref()

  writeOverlayInfo({
    pid: child.pid,
    port: svc.port,
    startedAt: new Date().toISOString(),
  })

  // 给窗口一点启动时间，再确认进程仍活着
  await new Promise((r) => setTimeout(r, 1800))
  const alive = isProcessAlive(child.pid)
  if (!alive) clearOverlayInfo()
  return {
    running: alive,
    started: alive,
    pid: alive ? child.pid : null,
    port: svc.port,
    error: alive ? null : '浮层进程启动后立即退出，可用 node lib/cli.mjs desktop install 检查运行时',
  }
}

export async function stopOverlay() {
  const info = readOverlayInfo()
  if (!info || !isProcessAlive(info.pid)) {
    clearOverlayInfo()
    return { ok: false, error: '浮层未在运行' }
  }
  try {
    if (process.platform === 'win32') {
      // Electron 会派生渲染/GPU 子进程，用 /T 一并收拾
      spawnSync('taskkill', ['/PID', String(info.pid), '/T', '/F'], { windowsHide: true })
    } else {
      process.kill(info.pid)
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  clearOverlayInfo()
  return { ok: true }
}

// 让浮层用指定端口（默认跟挂件服务一致）
export function overlayPort() {
  return readPluginConfig().port || DEFAULT_PORT
}
