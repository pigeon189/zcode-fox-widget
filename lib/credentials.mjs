// 凭据发现 + 出站 URL 安全校验。
//
// 出站校验是硬约束：服务端只会向白名单内的 DeepSeek 域名发请求，且拒绝
// 环回/私有/保留地址的字面量 IP，避免被配置文件或环境变量诱导去访问内网。
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_FILE, DATA_DIR, ZCODE_CLIENT_CONFIG } from './paths.mjs'

// 允许出站的主机白名单。用「等于或点号结尾的后缀」匹配，避免 evil-deepseek.com
// 这类伪装域名通过 includes 判定。
const ALLOWED_HOSTS = ['api.deepseek.com', 'platform.deepseek.com']

export const BALANCE_URL = 'https://api.deepseek.com/user/balance'
export const USAGE_URL_BASE = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (Number(m[1]) > 255 || Number(m[2]) > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // 组播/保留
  return false
}

function isReservedIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h.includes(':')) return false
  if (h === '::' || h === '::1') return true
  if (/^f[cd]/.test(h)) return true // fc00::/7 ULA
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 link-local
  return false
}

// 校验一个出站 URL 是否可以请求。不通过时抛错，调用方无需再判断。
export function assertSafeUpstream(rawUrl, allowedHosts = ALLOWED_HOSTS) {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch (err) {
    throw new Error('出站地址无法解析: ' + String(rawUrl).slice(0, 120))
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('出站地址协议不被允许: ' + url.protocol)
  }
  if (url.username || url.password) {
    throw new Error('出站地址不允许携带用户名/密码')
  }
  const host = url.hostname.toLowerCase()
  if (!host) throw new Error('出站地址缺少主机名')
  const allowed = allowedHosts.some((h) => host === h || host.endsWith('.' + h))
  if (!allowed) {
    throw new Error('出站主机不在白名单内: ' + host)
  }
  if (isPrivateIPv4(host) || isReservedIPv6(host)) {
    throw new Error('出站主机为环回/私有/保留地址: ' + host)
  }
  if (url.protocol === 'http:' && !url.hostname.endsWith('.deepseek.com')) {
    throw new Error('非白名单主机必须使用 https')
  }
  return url
}

// ---------- 插件配置 ----------

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    return null
  }
}

// 跟随探测间隔的合法范围：低于 16ms 没有可见收益，高于 2s 鲸鱼会明显跟不上窗口
export function normalizeFollowInterval(value) {
  const n = Number(value)
  if (!isFinite(n) || n <= 0) return null
  return Math.min(2000, Math.max(16, Math.round(n)))
}

// 普通配置（不含密钥）与密钥同文件：写入时尽量收紧权限。
export function readPluginConfig() {
  const c = readJson(CONFIG_FILE) || {}
  return {
    apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
    platformToken: typeof c.platformToken === 'string' ? c.platformToken : '',
    usageMode: c.usageMode === 'token' ? 'token' : 'ledger',
    port: Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : null,
    // 默认开启：对应上游「每次打开界面自动启用」的常驻自启体验，
    // 置 false 可让 SessionStart 不再自动拉起挂件服务。
    autoStartWidget: c.autoStartWidget !== false,
    // 会话启动时是否顺便把桌面浮层也拉起来。默认开启，前提是 Electron
    // 运行时已安装（未安装时静默跳过，不会打断会话启动）。
    autoStartOverlay: c.autoStartOverlay !== false,
    // 跟随探测间隔（毫秒）：越小鲸鱼跟得越紧。留空用浮层默认值 40ms，
    // 也可以在挂件菜单里即时调整。
    followIntervalMs: normalizeFollowInterval(c.followIntervalMs),
    // 各厂商模板的手动凭据（如 vendorKeys.openrouter）。自动发现（discover.mjs）
    // 覆盖不到的厂商在这里填；优先级低于环境变量、高于自动发现。
    vendorKeys: c.vendorKeys && typeof c.vendorKeys === 'object' ? c.vendorKeys : {},
  }
}

// 只更新传入的字段，其余保持原值。
export function writePluginConfig(patch) {
  const current = readJson(CONFIG_FILE) || {}
  const next = { ...current }
  for (const key of ['apiKey', 'platformToken', 'usageMode', 'port', 'autoStartWidget', 'autoStartOverlay', 'followIntervalMs']) {
    if (patch && patch[key] !== undefined) next[key] = patch[key]
  }
  if (patch && patch.vendorKeys && typeof patch.vendorKeys === 'object') {
    next.vendorKeys = {
      ...(current.vendorKeys && typeof current.vendorKeys === 'object' ? current.vendorKeys : {}),
      ...patch.vendorKeys,
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  return readPluginConfig()
}

// ---------- 凭据发现 ----------
//
// 优先级：
//   1. 环境变量 DEEPSEEK_API_KEY
//   2. 本插件配置 ~/.zcode/whale/config.json 的 apiKey
//   3. ZCode 客户端里已配置的 DeepSeek provider（baseURL 指向 api.deepseek.com）
//
// 第 3 条是 ZCode 版相对上游的关键适配：上游从 DSH 凭据服务读 key，而 ZCode
// 没有等价服务，但用户通常已经在 ZCode 里配好了 DeepSeek 接入点，直接复用即可
// 零配置可用。密钥只在本进程内存中使用，只发往白名单主机，不落盘、不打印。

function apiKeyFromZcodeProviders() {
  const cfg = readJson(ZCODE_CLIENT_CONFIG)
  const providers = cfg && cfg.provider && typeof cfg.provider === 'object' ? cfg.provider : null
  if (!providers) return ''
  for (const id of Object.keys(providers)) {
    const p = providers[id]
    const opts = p && p.options && typeof p.options === 'object' ? p.options : null
    if (!opts) continue
    const baseURL = typeof opts.baseURL === 'string' ? opts.baseURL : ''
    const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : ''
    if (!apiKey || !baseURL) continue
    let host = ''
    try {
      host = new URL(baseURL).hostname.toLowerCase()
    } catch (err) {
      continue
    }
    if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return apiKey
  }
  return ''
}

export function findApiKey() {
  const env = String(process.env.DEEPSEEK_API_KEY || '').trim()
  if (env) return { key: env, source: 'env:DEEPSEEK_API_KEY' }
  const cfg = readPluginConfig().apiKey.trim()
  if (cfg) return { key: cfg, source: 'plugin-config' }
  const fromClient = apiKeyFromZcodeProviders()
  if (fromClient) return { key: fromClient, source: 'zcode-provider' }
  return { key: '', source: 'none' }
}

export function findPlatformToken() {
  const env = String(process.env.DEEPSEEK_PLATFORM_TOKEN || '').trim()
  if (env) return { token: env, source: 'env:DEEPSEEK_PLATFORM_TOKEN' }
  const cfg = readPluginConfig().platformToken.trim()
  if (cfg) return { token: cfg, source: 'plugin-config' }
  return { token: '', source: 'none' }
}

// 仅用于展示的掩码，绝不返回完整密钥。
export function maskKey(key) {
  const k = String(key || '')
  if (!k) return ''
  if (k.length <= 12) return '****'
  return k.slice(0, 5) + '…' + k.slice(-3)
}

export { ALLOWED_HOSTS }
