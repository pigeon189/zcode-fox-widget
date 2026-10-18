// DeepSeek Harness（dsh）凭据：从 dsh 自己的凭据仓库取 DeepSeek API Key。
//
// dsh 把 refs 放在 <DSH_HOME>/.credentials.yaml，形如：
//   refs:
//     DEEPSEEK_API_KEY: sk-...
// 挂件只读、不写、不记录密钥；错误信息里也不会带 key。
//
// 余额接口：GET https://api.deepseek.com/user/balance
//   { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

export function defaultDshHome(env = process.env) {
  const override = String(env.DSH_HOME || '').trim()
  if (override) return override
  return path.join(os.homedir(), '.dsh')
}

export function credentialsFile(home = defaultDshHome()) {
  return path.join(home, '.credentials.yaml')
}

function unquote(v) {
  const s = String(v || '').trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

// 返回 { key, source } 或 null。环境变量优先：用户可以在不改 dsh 文件的情况下覆盖。
export function readDeepSeekKey(opts = {}) {
  const env = opts.env || process.env
  const fromEnv = unquote(env.DEEPSEEK_API_KEY || '')
  if (fromEnv) return { key: fromEnv, source: 'env:DEEPSEEK_API_KEY' }
  const file = opts.file || credentialsFile(opts.home || defaultDshHome(env))
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return null
  }
  const m = /^\s*DEEPSEEK_API_KEY\s*:\s*(\S.*?)\s*$/m.exec(text)
  if (!m) return null
  const key = unquote(m[1])
  if (!key) return null
  return { key, source: 'dsh:.credentials.yaml' }
}

function pickBalanceInfo(payload) {
  if (!payload || typeof payload !== 'object') return null
  const list = Array.isArray(payload.balance_infos) ? payload.balance_infos : []
  if (!list.length) return null
  const cny = list.find((b) => b && b.currency === 'CNY')
  return cny || list[0]
}

export function parseDeepSeekBalance(payload) {
  const info = pickBalanceInfo(payload)
  if (!info) return null
  const amount = Number(info.total_balance)
  if (!Number.isFinite(amount)) return null
  return {
    amount: Math.round(amount * 10000) / 10000,
    currency: /^[A-Z]{3}$/.test(String(info.currency || '')) ? String(info.currency) : 'CNY',
    granted: Number(info.granted_balance) || 0,
    toppedUp: Number(info.topped_up_balance) || 0,
    available: payload.is_available === true,
  }
}

const CACHE_TTL_MS = 30_000
const cache = new Map()

export function _resetDeepSeekBalanceCache() {
  cache.clear()
}

export async function readDeepSeekBalance(opts = {}) {
  const cred = readDeepSeekKey(opts)
  if (!cred) return { ok: false, reason: 'no-key', error: '没有找到 dsh 的 DeepSeek 凭据（API Key）' }
  const nowMs = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const hit = cache.get(cred.key)
  if (hit && nowMs - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true }
  try {
    const res = await (opts.fetchImpl || fetch)(opts.url || DEEPSEEK_BALANCE_URL, {
      headers: { authorization: 'Bearer ' + cred.key, accept: 'application/json' },
      signal: AbortSignal.timeout(Number(opts.timeoutMs) || 12000),
    })
    if (!res.ok) {
      const value = { ok: false, reason: 'http', error: 'DeepSeek 余额接口失败（HTTP ' + res.status + '）' }
      cache.set(cred.key, { at: nowMs, value })
      return value
    }
    const payload = await res.json()
    const parsed = parseDeepSeekBalance(payload)
    if (!parsed) {
      const value = { ok: false, reason: 'shape', error: 'DeepSeek 余额响应里没有 balance_infos' }
      cache.set(cred.key, { at: nowMs, value })
      return value
    }
    const value = { ok: true, ...parsed, source: cred.source }
    cache.set(cred.key, { at: nowMs, value })
    return value
  } catch (err) {
    const value = { ok: false, reason: 'network', error: 'DeepSeek 余额读取失败：' + String((err && err.message) || err).slice(0, 120) }
    cache.set(cred.key, { at: nowMs, value })
    return value
  }
}
