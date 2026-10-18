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

// 从任务栏窗口里认出「浮层」：它们是全屏置顶，会把命中全吃掉。
// 包括别的挂件（标题含「小挂件」）和可能残留的 fox-dock 浮层。
export function overlayPidsOf(windows) {
  return (windows || [])
    .filter((w) => {
      const title = (w && w.title) || ''
      return (/小挂件/.test(title) || /^fox-dock overlay/i.test(title)) && /electron\.exe$/i.test((w && w.exe) || '')
    })
    .map((w) => w.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}
