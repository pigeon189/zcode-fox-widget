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
        if (msg.ok === false) item.reject(new BridgeError(msg.error || 'bridge error'))
        else item.resolve(msg)
      })

      child.on('exit', (code) => {
        this.#closed = true
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
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err)
        }
      })
    })
    return this.#started
  }

  #request(command) {
    if (!this.running) return Promise.reject(new BridgeError('bridge not running'))
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

  async rect(hwnd) {
    const res = await this.#request('rect ' + String(hwnd).replace(/^0x/, ''))
    return res.rect
  }

  async cursor() {
    const res = await this.#request('cursor')
    return { x: res.x, y: res.y }
  }

  async ping() {
    await this.#request('ping')
    return true
  }

  stop() {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#child.stdin.end()
    } catch (err) {}
    try {
      this.#child.kill()
    } catch (err) {}
    try {
      this.#rl && this.#rl.close()
    } catch (err) {}
  }
}
