// Electron 运行时定位（R10）：dock 不带 Electron，复用它已经装好的那份。
//
// 优先级：显式环境变量 → ZCode 挂件的运行时 → WorkBuddy 挂件的运行时。
// 都找不到时返回空串，由调用方给出可读的错误（不要静默失败）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function electronCandidates() {
  const home = os.homedir()
  return [
    process.env.FOX_DOCK_ELECTRON || '',
    path.join(home, '.zcode', 'whale', 'desktop-runtime', 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(
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
  ].filter(Boolean)
}

export function resolveElectron(candidates = electronCandidates()) {
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p
    } catch (err) {}
  }
  return ''
}

// 从任务栏窗口里认出「别的挂件浮层」：它们是全屏置顶，会把命中全吃掉。
export function overlayPidsOf(windows) {
  return (windows || [])
    .filter((w) => w && /小挂件/.test(w.title || '') && /electron\.exe$/i.test(w.exe || ''))
    .map((w) => w.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}
