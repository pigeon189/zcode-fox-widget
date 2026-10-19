// fox-dock 共存 shim（WorkBuddy 线，M7）：
//   · dock 在线时，本挂件不再拉起自己的浮层
//   · SessionStart / UserPromptSubmit 顺手 `fox-dock ensure`（找不到 dock 静默跳过）
//   · UserPromptSubmit / Notification 转发到 dock 的 /v1/events
//
// 所有调用短超时、失败静默：不能因为 dock 不在或异常拖慢宿主。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PLUGIN_ROOT } from './paths.mjs'

export function dockDataDir(env = process.env) {
  const base =
    env.FOX_DOCK_DATA ||
    (process.platform === 'win32' && env.LOCALAPPDATA ? env.LOCALAPPDATA : path.join(os.homedir(), '.local', 'share'))
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
