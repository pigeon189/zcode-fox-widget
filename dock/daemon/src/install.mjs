// 登录自启：在启动文件夹放一个隐藏启动器（VBS），由它执行 `fox-dock start`
// （start 会拉起 watchdog + 浮层；只想要后台服务就传 command: 'start --no-overlay'）。
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

// 子命令只允许字母和连字符：启动器内容会进 VBS 字符串，不能留注入面
function assertCommand(value) {
  const s = String(value || '').trim()
  if (!s) return ''
  if (!/^[a-z0-9 -]{0,80}$/.test(s)) throw new Error('command contains illegal characters')
  return s
}

// VBS 字符串里用两个双引号表示一个双引号
export function buildVbs({ nodePath, scriptPath, watchdogPath, dataDir, command }) {
  const node = assertPlain(nodePath, 'nodePath')
  const script = assertPlain(scriptPath || watchdogPath, 'scriptPath')
  const dir = assertPlain(dataDir, 'dataDir')
  const cmd0 = assertCommand(command)
  const cmd = '"' + node + '" "' + script + '"' + (cmd0 ? ' ' + cmd0 : '') + ' --data-dir "' + dir + '"'
  const literal = '"' + cmd.replace(/"/g, '""') + '"'
  return [
    "' fox-dock launcher (generated)",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run ' + literal + ', 0, False',
    '',
  ].join('\r\n')
}

export function buildCmd({ nodePath, scriptPath, watchdogPath, dataDir, command }) {
  const node = assertPlain(nodePath, 'nodePath')
  const script = assertPlain(scriptPath || watchdogPath, 'scriptPath')
  const dir = assertPlain(dataDir, 'dataDir')
  const cmd0 = assertCommand(command)
  return [
    '@echo off',
    'start "" "' + node + '" "' + script + '"' + (cmd0 ? ' ' + cmd0 : '') + ' --data-dir "' + dir + '"',
    '',
  ].join('\r\n')
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
  const args = {
    nodePath: options.nodePath,
    scriptPath: options.scriptPath,
    watchdogPath: options.watchdogPath,
    dataDir: options.dataDir,
    command: options.command,
  }
  const text = format === 'cmd' ? buildCmd(args) : buildVbs(args)
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
