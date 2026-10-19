// 凭据保险库（D026）：Windows DPAPI 加密，只在当前 Windows 用户下可解。
//
// 文件形状：{ "version": 1, "items": { "<templateId>": "<base64 ciphertext>" } }
// 明文只经过 stdin/stdout 与 DPAPI 子进程交互，**不出现在命令行参数、日志、
// 诊断包或 API 响应里**。API 只回掩码。
//
// 非 Windows：抛 vault-unsupported，UI 提示改用环境变量。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PS_PROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$plain = [Console]::In.ReadToEnd()',
  '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
  '$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($enc))',
].join('; ')

const PS_UNPROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b64 = [Console]::In.ReadToEnd()',
  '$enc = [Convert]::FromBase64String($b64)',
  '$dec = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))',
].join('; ')

export function maskSecret(secret) {
  const s = String(secret || '')
  if (!s) return ''
  if (s.length < 8) return '****'
  return s.slice(0, 3) + '••••' + s.slice(-4)
}

function dpapi(script, input) {
  if (process.platform !== 'win32') throw new Error('vault-unsupported')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (r.error) throw new Error('vault-dpapi: ' + r.error.message)
  // 不把 PowerShell 的原始错误拼进异常：里面可能带本机路径与乱码。
  if (r.status !== 0) throw new Error('vault-dpapi: DPAPI 调用失败（密文损坏或不属于当前用户）')
  return String(r.stdout || '').trim()
}

export function protectSecret(secret) {
  return dpapi(PS_PROTECT, String(secret))
}

export function unprotectSecret(cipher) {
  return dpapi(PS_UNPROTECT, String(cipher))
}

export function createVault({ file, protect = protectSecret, unprotect = unprotectSecret } = {}) {
  const cache = new Map() // templateId -> { value, at }
  const CACHE_TTL_MS = 60_000

  function readFile() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object' && raw.items && typeof raw.items === 'object') return raw
    } catch (err) {}
    return { version: 1, items: {} }
  }

  function writeFile(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  function checkId(id) {
    const s = String(id || '')
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(s)) throw new Error('vault-bad-id')
    return s
  }

  return {
    supported: process.platform === 'win32',

    set(id, secret) {
      const key = checkId(id)
      const plain = String(secret || '').trim()
      if (!plain) throw new Error('vault-empty-secret')
      const data = readFile()
      // 密文旁存明文摘要：DPAPI 在部分情况下能「解出」被篡改的字节，
      // 不比对摘要就会把垃圾当成密钥。"check" 是单向摘要，不泄露明文。
      data.items[key] = {
        v: 1,
        data: protect(plain),
        check: crypto.createHash('sha256').update(plain).digest('hex').slice(0, 32),
      }
      writeFile(data)
      cache.set(key, { value: plain, at: Date.now() })
      return { ok: true, id: key, masked: maskSecret(plain) }
    },

    get(id) {
      const key = checkId(id)
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
      const data = readFile()
      const item = data.items[key]
      if (!item) return ''
      const cipher = typeof item === 'string' ? item : item.data
      const value = unprotect(cipher)
      if (item && typeof item === 'object' && item.check) {
        const check = crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)
        if (check !== item.check) throw new Error('vault-corrupt')
      }
      cache.set(key, { value, at: Date.now() })
      return value
    },

    delete(id) {
      const key = checkId(id)
      const data = readFile()
      const had = Object.prototype.hasOwnProperty.call(data.items, key)
      if (had) {
        delete data.items[key]
        writeFile(data)
      }
      cache.delete(key)
      return { ok: true, removed: had }
    },

    has(id) {
      const key = checkId(id)
      return Object.prototype.hasOwnProperty.call(readFile().items, key)
    },

    masked(id) {
      try {
        const value = this.get(id)
        return value ? maskSecret(value) : ''
      } catch (err) {
        return ''
      }
    },

    list() {
      const data = readFile()
      return Object.keys(data.items).map((id) => ({ id, masked: this.masked(id) }))
    },

    // 供 engines/credentials 注入
    provider() {
      return {
        get: (id) => {
          try {
            return this.get(id)
          } catch (err) {
            return ''
          }
        },
        list: () => this.list(),
      }
    },

    _file: file,
  }
}
