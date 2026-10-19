// Electron 运行时自管（T1.4）。
//
// 优先级：
//   1. FOX_DOCK_ELECTRON（显式指定，排障/测试用）
//   2. %LOCALAPPDATA%\fox-dock\runtime\electron\<version>\electron.exe（自己装的）
//   3. ZCode 挂件线的 desktop-runtime
//   4. WorkBuddy 挂件线的 desktop-runtime
//
// 缺失时 `install` 从镜像链下载：
//   npmmirror → 官方 GitHub Releases，逐个比对 SHASUMS256.txt 的 sha256。
// 解压用零依赖 shared/zip.mjs；下载上限 300MB，防止被错误 URL 拖爆内存。

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractZip } from '../../shared/zip.mjs'

export const DEFAULT_ELECTRON_VERSION = '44.4.5'
export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024

export function electronVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return String((pkg.foxDock && pkg.foxDock.electron) || DEFAULT_ELECTRON_VERSION)
  } catch (err) {
    return DEFAULT_ELECTRON_VERSION
  }
}

export function runtimeRoot(env = process.env) {
  const base = env.FOX_DOCK_RUNTIME_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fox-dock', 'runtime')
  return path.resolve(base)
}

export function ownElectronPath(version = electronVersion(), env = process.env) {
  return path.join(runtimeRoot(env), 'electron', version, 'electron.exe')
}

export function runtimeCandidates(env = process.env) {
  const home = os.homedir()
  return [
    { source: 'env', path: env.FOX_DOCK_ELECTRON || '' },
    { source: 'own', path: ownElectronPath(electronVersion(), env) },
    {
      source: 'zcode',
      path: path.join(home, '.zcode', 'whale', 'desktop-runtime', 'node_modules', 'electron', 'dist', 'electron.exe'),
    },
    {
      source: 'workbuddy',
      path: path.join(
        home,
        '.workbuddy',
        'plugins',
        'cache',
        'fox-local',
        'fox-widget',
        '2.0.0',
        'desktop-runtime',
        'node_modules',
        'electron',
        'dist',
        'electron.exe'
      ),
    },
  ].filter((c) => c.path)
}

export function resolveRuntime(env = process.env) {
  for (const c of runtimeCandidates(env)) {
    try {
      if (fs.statSync(c.path).isFile()) {
        return { path: c.path, source: c.source, version: versionOfPath(c.path) }
      }
    } catch (err) {}
  }
  return { path: '', source: '', version: '' }
}

function versionOfPath(electronExe) {
  try {
    const pkg = path.join(path.dirname(path.dirname(electronExe)), 'package.json')
    return String(JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '')
  } catch (err) {
    return ''
  }
}

function blockedHost(hostname) {
  const h = String(hostname || '').toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number)
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true
    if (p[0] === 169 && p[1] === 254) return true
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
    if (p[0] === 192 && p[1] === 168) return true
  }
  if (h === '[::1]' || h === '::1') return true
  return false
}

export function mirrorUrls(version = electronVersion(), platform = process.platform, arch = process.arch) {
  const plat = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
  const archName = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch
  const file = 'electron-v' + version + '-' + plat + '-' + archName + '.zip'
  return [
    { name: 'npmmirror', base: 'https://npmmirror.com/mirrors/electron/' + version + '/', file },
    { name: 'github', base: 'https://github.com/electron/electron/releases/download/v' + version + '/', file },
  ]
}

async function fetchBuffer(url, { fetchImpl = fetch, maxBytes = MAX_DOWNLOAD_BYTES, timeoutMs = 120000 } = {}) {
  const u = new URL(url)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('runtime: 只允许 http/https')
  if (blockedHost(u.hostname)) throw new Error('runtime: 拒绝环回/私有地址 ' + u.hostname)
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('runtime: HTTP ' + res.status + ' ' + url)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > maxBytes) throw new Error('runtime: 文件过大 ' + len)
  const chunks = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > maxBytes) throw new Error('runtime: 超过下载上限')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export async function installRuntime({ version = electronVersion(), env = process.env, fetchImpl = fetch, log = () => {} } = {}) {
  const target = ownElectronPath(version, env)
  if (fs.existsSync(target)) return { ok: true, path: target, already: true, version }
  if (process.platform !== 'win32') {
    return { ok: false, error: '自动安装目前只支持 Windows；请用 FOX_DOCK_ELECTRON 指定运行时' }
  }
  const errors = []
  for (const mirror of mirrorUrls(version, process.platform, process.arch)) {
    try {
      log('下载 Electron ' + version + '（' + mirror.name + '）…')
      const sumsBuf = await fetchBuffer(mirror.base + 'SHASUMS256.txt', { fetchImpl, maxBytes: 1024 * 1024 })
      const line = sumsBuf
        .toString('utf8')
        .split(/\r?\n/)
        .find((l) => l.trim().endsWith('  ' + mirror.file) || l.trim().endsWith(' *' + mirror.file))
      if (!line) throw new Error('SHASUMS256.txt 里没有 ' + mirror.file)
      const expected = line.trim().split(/\s+/)[0].toLowerCase()
      const buf = await fetchBuffer(mirror.base + mirror.file, { fetchImpl })
      const actual = sha256(buf)
      if (actual !== expected) throw new Error('sha256 不符（期望 ' + expected.slice(0, 12) + '…，实际 ' + actual.slice(0, 12) + '…）')
      const dir = path.dirname(target)
      fs.mkdirSync(dir, { recursive: true })
      const tmp = dir + '.tmp-' + process.pid
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.mkdirSync(tmp, { recursive: true })
      extractZip(buf, tmp)
      const unpacked = path.join(tmp, 'electron.exe')
      if (!fs.existsSync(unpacked)) throw new Error('包内没有 electron.exe')
      // 先整体搬到目标目录，再报告成功；中途失败不会留下「看起来装好了」的目录。
      const finalDir = path.dirname(target)
      fs.mkdirSync(path.dirname(finalDir), { recursive: true })
      fs.rmSync(finalDir, { recursive: true, force: true })
      fs.renameSync(tmp, finalDir)
      log('Electron 运行时已安装：' + target)
      return { ok: true, path: target, version, source: mirror.name }
    } catch (err) {
      errors.push(mirror.name + ': ' + (err && err.message ? err.message : err))
      log('镜像失败：' + errors[errors.length - 1])
    }
  }
  return { ok: false, error: '所有镜像都失败：' + errors.join('; ') }
}

export function runtimeInfo(env = process.env) {
  return {
    version: electronVersion(),
    root: runtimeRoot(env),
    candidates: runtimeCandidates(env).map((c) => ({ source: c.source, path: c.path, exists: fs.existsSync(c.path) })),
    resolved: resolveRuntime(env),
  }
}
