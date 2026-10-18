// 登录自启：在启动文件夹放一个隐藏启动器（VBS），由它拉起 watchdog。
//
// 为什么不写注册表 Run：启动文件夹可被用户直接看到/删除，卸载干净，
// 也不会被安全软件当成「隐藏自启」重点关照。
//
// 为什么默认 VBS：wscript 以 0 号窗口方式运行，登录时不闪黑框。
// 路径含非 ASCII 时改用时，VBS 的编码兼容性不稳，降级为 .cmd（会闪一下）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LAUNCHER_NAME = 'fox-dock'

export function startupDir() {
  if (process.platform !== 'win32') return ''
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

function assertPlain(value, what) {
  const s = String(value || '')
  if (!s) throw new Error(what + ' is required')
  if (/["\r\n]/.test(s)) throw new Error(what + ' contains quote or newline')
  return s
}

// VBS 字符串里用两个双引号表示一个双引号
export function buildVbs({ nodePath, watchdogPath, dataDir }) {
  const node = assertPlain(nodePath, 'nodePath')
  const script = assertPlain(watchdogPath, 'watchdogPath')
  const dir = assertPlain(dataDir, 'dataDir')
  const cmd = '"' + node + '" "' + script + '" --data-dir "' + dir + '"'
  const literal = '"' + cmd.replace(/"/g, '""') + '"'
  return [
    "' fox-dock launcher (generated)",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run ' + literal + ', 0, False',
    '',
  ].join('\r\n')
}

export function buildCmd({ nodePath, watchdogPath, dataDir }) {
  const node = assertPlain(nodePath, 'nodePath')
  const script = assertPlain(watchdogPath, 'watchdogPath')
  const dir = assertPlain(dataDir, 'dataDir')
  return ['@echo off', 'start "" "' + node + '" "' + script + '" --data-dir "' + dir + '"', ''].join('\r\n')
}

export function launcherPaths(dir) {
  return {
    vbs: path.join(dir, LAUNCHER_NAME + '.vbs'),
    cmd: path.join(dir, LAUNCHER_NAME + '.cmd'),
  }
}

export function installLauncher(options) {
  const dir = options.startupDir || startupDir()
  if (!dir) throw new Error('startup folder not available on this platform')
  fs.mkdirSync(dir, { recursive: true })
  const paths = launcherPaths(dir)
  const format = options.format === 'cmd' ? 'cmd' : 'vbs'
  const text =
    format === 'cmd'
      ? buildCmd({ nodePath: options.nodePath, watchdogPath: options.watchdogPath, dataDir: options.dataDir })
      : buildVbs({ nodePath: options.nodePath, watchdogPath: options.watchdogPath, dataDir: options.dataDir })
  // 只留一种启动器，避免登录时起两个
  try {
    fs.unlinkSync(format === 'vbs' ? paths.cmd : paths.vbs)
  } catch (err) {}
  const file = format === 'vbs' ? paths.vbs : paths.cmd
  fs.writeFileSync(file, text, 'utf8')
  return { file, format }
}

export function uninstallLauncher(options = {}) {
  const dir = options.startupDir || startupDir()
  if (!dir) return { removed: [] }
  const paths = launcherPaths(dir)
  const removed = []
  for (const file of [paths.vbs, paths.cmd]) {
    try {
      fs.unlinkSync(file)
      removed.push(file)
    } catch (err) {}
  }
  return { removed }
}
