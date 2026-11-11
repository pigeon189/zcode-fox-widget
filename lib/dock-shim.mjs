// fox-dock 共存 shim（M7）：
//   · dock 在线时，旧挂件不再拉起自己的浮层（避免桌面出现两只角色）
//   · SessionStart 顺手 `fox-dock ensure`（找不到 dock 就静默跳过）
//   · UserPromptSubmit / PermissionRequest 转发到 dock 的 /v1/events
//
// 所有调用都短超时、失败静默：宿主的会话启动/提交不能因为 dock 不在或异常而变慢。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PLUGIN_ROOT } from './paths.mjs'

export function dockDataDir(env = process.env) {
  const base = env.FOX_DOCK_DATA || (process.platform === 'win32' && env.LOCALAPPDATA ? env.LOCALAPPDATA : path.join(os.homedir(), '.local', 'share'))
  return path.join(base, 'fox-dock')
}

export function dockRoot(env = process.env) {
  const candidates = [env.FOX_DOCK_ROOT || '', path.join(PLUGIN_ROOT, 'dock')].filter(Boolean)
  for (const root of candidates) {
    try {
      if (fs.existsSync(path.join(root, 'tools', 'fox-dock.mjs'))) return root
    } catch (err) {}
  }
  return ''
}

export function readDockLock(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dockDataDir(env), 'daemon.lock'), 'utf8'))
    return raw && Number(raw.port) > 0 ? raw : null
  } catch (err) {
    return null
  }
}

export async function dockHealth({ env = process.env, timeoutMs = 250 } = {}) {
  const lock = readDockLock(env)
  if (!lock) return null
  try {
    const res = await fetch('http://127.0.0.1:' + lock.port + '/health', { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const data = await res.json()
    return data && data.app === 'fox-dock' ? { ...data, token: lock.token || '' } : null
  } catch (err) {
    return null
  }
}

export async function dockOnline(opts = {}) {
  return !!(await dockHealth(opts))
}

// 「用户本次开机内主动退出了 dock」（dock 的 D073 口径）：标记记的是**开机时刻**
// 而不是过期时间（休眠唤醒不算重启），容差 5 分钟。这里只读不写，只用于决定
// 「dock 没起来时要不要回落成自己的浮层」——用户明确退出过就别再塞一只角色回来。
const QUIT_FLAG_DRIFT_MS = 5 * 60_000
export function dockQuitForThisBoot(env = process.env, opts = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dockDataDir(env), 'quit-until-boot.json'), 'utf8'))
    const bootAt = Number(raw && raw.bootAt)
    if (!Number.isFinite(bootAt) || bootAt <= 0) return false
    const now = Number(opts.now) || Date.now()
    const uptimeSec = Number(opts.uptimeSec) || os.uptime()
    const mine = Math.round(now - uptimeSec * 1000)
    if (!Number.isFinite(mine) || mine <= 0) return false
    return Math.abs(mine - bootAt) <= QUIT_FLAG_DRIFT_MS
  } catch (err) {
    return false
  }
}

// 幂等拉起：只 spawn，不等待（会话钩子有预算；下一次会话/托盘都能补）。
export function ensureDock({ env = process.env } = {}) {
  const root = dockRoot(env)
  if (!root) return { ok: false, reason: 'dock-not-installed' }
  try {
    const child = spawn(process.execPath, [path.join(root, 'tools', 'fox-dock.mjs'), 'ensure'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
    child.unref()
    return { ok: true, root }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

export async function postDockEvent(event, { env = process.env, timeoutMs = 300 } = {}) {
  const lock = readDockLock(env)
  if (!lock) return false
  try {
    const res = await fetch('http://127.0.0.1:' + lock.port + '/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fox-token': lock.token || '' },
      body: JSON.stringify(event || {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch (err) {
    return false
  }
}
