import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PORT = 39401
export const MAX_PORT_TRIES = 10

// 数据目录与两个挂件（~/.zcode、~/.workbuddy）完全分开：卸载/清理时互不影响。
export function defaultDataDir() {
  const base =
    process.env.FOX_DOCK_DATA ||
    (process.platform === 'win32' && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : path.join(os.homedir(), '.local', 'share'))
  return path.join(base, 'fox-dock')
}

export function pathsFor(dataDir) {
  const dir = path.resolve(dataDir || defaultDataDir())
  return {
    dir,
    lock: path.join(dir, 'daemon.lock'),
    heartbeat: path.join(dir, 'heartbeat.json'),
    watchdogLock: path.join(dir, 'watchdog.lock'),
    bindings: path.join(dir, 'bindings.json'),
    ledger: path.join(dir, 'ledger.json'),
    settings: path.join(dir, 'settings.json'),
    logs: path.join(dir, 'logs'),
    // 2.0 新增：上下文历史、气泡模板、导入的角色、凭据保险库
    contextHistory: path.join(dir, 'context-history.json'),
    bubbleTemplates: path.join(dir, 'bubble-templates.json'),
    rolesDir: path.join(dir, 'roles'),
    soundsDir: path.join(dir, 'sounds'),
    vault: path.join(dir, 'vault.json'),
  }
}
