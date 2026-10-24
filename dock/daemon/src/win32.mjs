// Win32 bridge client.
//
// The bridge is a long-lived PowerShell process that compiles a small C# helper
// once and then answers one-line commands on stdin. Keeping it alive matters:
// spawning PowerShell per drag sample would cost ~200ms, while a hit test on a
// live bridge costs ~0.2ms (measured in the feasibility spike).
//
// Commands are answered in order, so this client keeps a FIFO of pending
// requests instead of tagging them with ids.

import { spawn } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_BRIDGE_SCRIPT = path.join(HERE, '..', 'win32', 'bridge.ps1')

export class BridgeError extends Error {}

export class Win32Bridge {
  #child = null
  #rl = null
  #pending = []
  #started = null
  #closed = false
  #stderr = ''

  constructor(options = {}) {
    this.script = options.script || DEFAULT_BRIDGE_SCRIPT
    this.powershell = options.powershell || 'powershell.exe'
    this.readyTimeoutMs = options.readyTimeoutMs || 20000
    this.requestTimeoutMs = options.requestTimeoutMs || 5000
  }

  get running() {
    return !!this.#child && !this.#closed
  }

  get stderr() {
    return this.#stderr
  }

  start() {
    if (this.#started) return this.#started
    // 上一次子进程退出后要能重新拉起：清掉 closed 标记与旧 stderr。
    this.#closed = false
    this.#stderr = ''
    this.#started = new Promise((resolve, reject) => {
      let settled = false
      const child = spawn(
        this.powershell,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      this.#child = child
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.stop()
        reject(new BridgeError('bridge ready timeout'))
      }, this.readyTimeoutMs)

      child.stderr.on('data', (d) => {
        this.#stderr += String(d)
        if (this.#stderr.length > 4000) this.#stderr = this.#stderr.slice(-4000)
      })

      this.#rl = readline.createInterface({ input: child.stdout })
      this.#rl.on('line', (line) => {
        let msg
        try {
          msg = JSON.parse(line)
        } catch (err) {
          return // 非 JSON 行（C# 编译警告等）忽略
        }
        if (msg.ready) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve(this)
          }
          return
        }
        const item = this.#pending.shift()
        if (!item) return
        clearTimeout(item.timer)
        if (msg.ok === false) {
          // 把结构化失败挂到错误上：rect 需要区分「最小化」和「真失败」，
          // 不能统一压成 bridge error
          const err = new BridgeError(msg.error || msg.reason || 'bridge error')
          err.payload = msg
          item.reject(err)
        } else {
          item.resolve(msg)
        }
      })

      child.on('exit', (code) => {
        if (this.#child !== child) return
        this.#closed = true
        this.#started = null
        clearTimeout(timer)
        const err = new BridgeError('bridge exited with code ' + code + (this.#stderr ? ': ' + this.#stderr.slice(-300) : ''))
        if (!settled) {
          settled = true
          reject(err)
        }
        while (this.#pending.length) {
          const item = this.#pending.shift()
          clearTimeout(item.timer)
          item.reject(err)
        }
      })
      child.on('error', (err) => {
        if (this.#child === child) {
          this.#closed = true
          this.#started = null
        }
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      })
    })
    return this.#started
  }

  async #request(command) {
    if (!this.running) {
      // PowerShell 桥会因系统/驱动等原因退出；按需重启，而不是让 daemon
      // 从此永远报 bridge not running（表现为无法吸附、看不到 ZCode 窗口）。
      try {
        await this.start()
      } catch (err) {
        throw new BridgeError('bridge start failed: ' + ((err && err.message) || err))
      }
    }
    if (!this.running) throw new BridgeError('bridge not running')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.#pending.findIndex((p) => p.timer === timer)
        if (idx >= 0) this.#pending.splice(idx, 1)
        reject(new BridgeError('bridge request timeout: ' + command))
        this.stop()
      }, this.requestTimeoutMs)
      this.#pending.push({ resolve, reject, timer })
      try {
        this.#child.stdin.write(command + '\n')
      } catch (err) {
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  async snapshot() {
    const res = await this.#request('snapshot')
    return res.windows || []
  }

  async hit(x, y, excludePid = 0) {
    const res = await this.#request('hit ' + Math.round(x) + ' ' + Math.round(y) + ' ' + Math.round(excludePid || 0))
    return res.hits || []
  }

  // 返回 { ok, rect, background } 或 { ok:false, reason }：调用方要能区分
  // minimized / offscreen（原地等）与 rect-failed（解绑）。background=true 表示
  // 窗口活着但不在前台（含被完全覆盖）；浮层据此在持续失前台约 3 秒后落兜底位。
  async rect(hwnd) {
    try {
      const res = await this.#request('rect ' + String(hwnd).replace(/^0x/, ''))
      return res.rect ? { ok: true, rect: res.rect, background: res.bg === true } : { ok: false, reason: 'rect-unavailable' }
    } catch (err) {
      if (err && err.payload && err.payload.ok === false) {
        return { ok: false, reason: err.payload.reason || err.payload.error || 'rect-failed' }
      }
      throw err
    }
  }

  async cursor() {
    const res = await this.#request('cursor')
    return { x: res.x, y: res.y }
  }

  // 聚焦已发现的宿主窗口。返回 { ok, method:'foreground'|'flash' }；
  // 系统前台锁可能只允许闪烁，调用方必须如实展示这个区别。
  async focus(hwnd) {
    const hex = String(hwnd || '').replace(/^0x/, '')
    if (!/^[0-9a-fA-F]+$/.test(hex)) return { ok: false, error: 'bad-hwnd' }
    try {
      const res = await this.#request('focus ' + hex)
      return { ok: res.ok !== false, method: res.method || 'foreground' }
    } catch (err) {
      if (err && err.payload && err.payload.ok === false) return { ok: false, error: err.payload.error || 'focus-failed' }
      return { ok: false, error: String((err && err.message) || err) }
    }
  }

  async ping() {
    await this.#request('ping')
    return true
  }

  stop() {
    if (this.#closed) return
    this.#closed = true
    this.#started = null
    try {
      this.#child.stdin.end()
    } catch (err) {}
    try {
      this.#child.kill()
    } catch (err) {}
    try {
      this.#rl && this.#rl.close()
    } catch (err) {}
    this.#rl = null
    this.#child = null
  }
}
