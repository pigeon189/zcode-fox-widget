// Kimi Code 凭据：读宿主自己的 OAuth 文件，过期时按宿主同款流程刷新。
//
// Kimi Code 1.x 把 managed OAuth 存在 <KIMI_CODE_HOME>/credentials/kimi-code.json：
//   { access_token, refresh_token, expires_at, scope, token_type, expires_in }
// access_token 只有 15 分钟寿命；过期后宿主会拿 refresh_token 换新的一对。
// 挂件是只读挂件，但**刷新必须写回**：refresh_token 会轮换，只换不写会让宿主
// 下次启动掉登录。写回用同目录临时文件 + rename，保留文件里其它字段。
//
// 这里不记录、不打印任何 token。错误信息只带 HTTP 状态码与错误码。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
export const KIMI_OAUTH_HOST = 'https://auth.kimi.com'
export const KIMI_BASE_URL = 'https://api.kimi.com/coding/v1'

export function defaultKimiHome(env = process.env) {
  const override = String(env.KIMI_CODE_HOME || '').trim()
  if (override) return override
  return path.join(os.homedir(), '.kimi-code')
}

export function credentialsFile(home = defaultKimiHome()) {
  return path.join(home, 'credentials', 'kimi-code.json')
}

export function readKimiCredentials(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || typeof raw.access_token !== 'string' || !raw.access_token) return null
    return raw
  } catch (err) {
    return null
  }
}

export function accessTokenFresh(creds, nowMs, skewSec = 30) {
  if (!creds || typeof creds.access_token !== 'string') return false
  const expiresAt = Number(creds.expires_at)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false
  return Math.floor(nowMs / 1000) < expiresAt - skewSec
}

function writeCredentialsAtomic(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

async function refreshToken({ creds, file, fetchImpl, nowMs, oauthHost, clientId, timeoutMs }) {
  if (!creds || typeof creds.refresh_token !== 'string' || !creds.refresh_token) {
    throw new Error('Kimi Code 登录已过期，且没有 refresh_token')
  }
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
  })
  const res = await fetchImpl(oauthHost.replace(/\/+$/, '') + '/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    let detail = ''
    try {
      const text = await res.text()
      const parsed = JSON.parse(text)
      detail = String(parsed.error_description || parsed.error || '').slice(0, 120)
    } catch (err) {}
    throw new Error('Kimi Code 刷新登录失败（HTTP ' + res.status + (detail ? '：' + detail : '') + '）')
  }
  const data = await res.json()
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('Kimi Code 刷新登录失败：响应里没有 access_token')
  }
  const expiresIn = Number(data.expires_in)
  const next = {
    ...creds,
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : creds.refresh_token,
    expires_at: Math.floor(nowMs / 1000) + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900),
  }
  if (Number.isFinite(expiresIn) && expiresIn > 0) next.expires_in = expiresIn
  if (typeof data.scope === 'string' && data.scope) next.scope = data.scope
  if (typeof data.token_type === 'string' && data.token_type) next.token_type = data.token_type
  writeCredentialsAtomic(file, next)
  return next
}

// 同一个凭据文件的并发刷新合并成一次：多个轮询同时发现过期时，
// 不能拿同一个 refresh_token 换两次（第二次会因轮换失效而报错）。
const refreshing = new Map()

export async function getKimiAccessToken(opts = {}) {
  const home = opts.home || defaultKimiHome(opts.env)
  const file = opts.file || credentialsFile(home)
  const nowMs = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const creds = readKimiCredentials(file)
  if (!creds) throw new Error('找不到 Kimi Code 登录凭据（先打开 Kimi Code 登录一次）')
  if (!opts.forceRefresh && accessTokenFresh(creds, nowMs)) return creds.access_token

  const key = path.resolve(file)
  let p = refreshing.get(key)
  if (!p) {
    p = refreshToken({
      creds,
      file,
      fetchImpl: typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch,
      nowMs,
      oauthHost: opts.oauthHost || KIMI_OAUTH_HOST,
      clientId: opts.clientId || KIMI_CLIENT_ID,
      timeoutMs: Number(opts.timeoutMs) || 15000,
    }).finally(() => refreshing.delete(key))
    refreshing.set(key, p)
  }
  const next = await p
  return next.access_token
}

// 测试用：清掉并发刷新表
export function _resetKimiRefreshState() {
  refreshing.clear()
}
