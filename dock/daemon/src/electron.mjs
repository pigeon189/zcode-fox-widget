// Electron 运行时定位（R10）：dock 优先用自己的运行时，其次复用已装好的挂件线。
// 实际的候选顺序与安装逻辑在 runtime.mjs（T1.4），这里保留旧导出。

import fs from 'node:fs'
import { resolveRuntime, runtimeCandidates } from './runtime.mjs'

export function electronCandidates(env = process.env) {
  return runtimeCandidates(env).map((c) => c.path)
}

export function resolveElectron(candidates) {
  if (Array.isArray(candidates)) {
    for (const p of candidates) {
      try {
        if (fs.statSync(p).isFile()) return p
      } catch (err) {}
    }
    return ''
  }
  return resolveRuntime().path
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

// 只认自己的浮层：标题是 fox-dock overlay <daemonPort>。
// 不能复用 overlayPidsOf —— 它为了命中排除也包含 ZCode/WorkBuddy 的「小挂件」，
// stop 时按它杀会把别的挂件一起收掉。端口用来区分同一台机器上的多个测试实例。
export function foxDockOverlayPidsOf(windows, port) {
  const want = Number(port) > 0 ? String(Number(port)) : ''
  return (windows || [])
    .filter((w) => {
      const title = String((w && w.title) || '')
      const m = /^fox-dock overlay(?:\s+(\d+))?$/i.exec(title)
      if (!m) return false
      if (want && m[1] !== want) return false
      return /electron\.exe$/i.test((w && w.exe) || '')
    })
    .map((w) => w.pid)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}
