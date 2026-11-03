// 凭据发现 + 出站 URL 安全校验。
//
// 出站校验是硬约束：服务端只会向白名单内的 DeepSeek 域名发请求，且拒绝
// 环回/私有/保留地址的字面量 IP，避免被配置文件或环境变量诱导去访问内网。
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_FILE, DATA_DIR } from './paths.mjs'
import { HOST_SETTINGS_FILE } from './host.mjs'
import { listHostProviders } from './discover.mjs'
import { isBlockedHost } from './blocked-host.mjs'

// 允许出站的主机白名单。用「等于或点号结尾的后缀」匹配，避免 evil-deepseek.com
// 这类伪装域名通过 includes 判定。
const ALLOWED_HOSTS = ['api.deepseek.com', 'platform.deepseek.com']

export const BALANCE_URL = 'https://api.deepseek.com/user/balance'
export const USAGE_URL_BASE = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'

// 「环回/私有/保留地址」判定已抽到 lib/blocked-host.mjs（审查 P3-2：与
// discover.mjs 的本地网关判定共用一份口径），这里 re-export 保持 overlay.mjs
// 等既有 import 不变。
export { isBlockedHost }

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
  if (isBlockedHost(host)) {
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

// GLM 按量钱包「回合结束刷新」的最小间隔（issue #18 讨论）：下限固定 2 分钟——
// 顾虑不是 RPM，而是避免余额查询与对话请求在瞬时并发上竞争；只能调大。
// 上限 1 小时防手滑（写成 999999999 等于把功能关掉）。留空 / 非法值返回 null，
// 由调用方回落默认 2 分钟。
export function normalizeBalanceRefreshInterval(value) {
  const n = Number(value)
  if (!isFinite(n) || n <= 0) return null
  return Math.min(3_600_000, Math.max(120_000, Math.round(n)))
}

// 普通配置（不含密钥）与密钥同文件：写入时尽量收紧权限。
//
// 刻意**不做**缓存：config.json 还会被外部进程改（`node lib/cli.mjs key/mode`、
// 手工编辑），而账本靠「读到的 apiKey 与上次不同」判定换 key 并归档整本账——
// 加一层 TTL 缓存会让这种外部改动在窗口期内不可见，直接破坏换 key 语义
//（实测：加了 1s 缓存后账本状态机的「换 key」用例立刻失败）。读取成本是本地
// 小文件的一次 read+parse，不值得用它换正确性。
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
    // 跟随探测间隔（毫秒）：越大肥鱼跟得越紧。留空用浮层默认值 40ms，
    // 也可以在挂件菜单里即时调整。
    followIntervalMs: normalizeFollowInterval(c.followIntervalMs),
    // 回合结束时强制刷新一次 GLM 按量钱包余额（issue #18 讨论）。默认关闭：
    // 余额接口的限流/并发策略与配额接口不同，高频查询可能挤占对话请求。
    refreshBalanceOnTurnComplete: c.refreshBalanceOnTurnComplete === true,
    // 上一项两次刷新的最小间隔；下限固定 2 分钟（只能调大），留空用默认 2 分钟。
    minBalanceRefreshIntervalMs:
      normalizeBalanceRefreshInterval(c.minBalanceRefreshIntervalMs) ?? 120_000,
    // 各厂商模板的手动凭据（如 vendorKeys.openrouter）。自动发现（discover.mjs）
    // 覆盖不到的厂商在这里填；优先级低于环境变量、高于自动发现。
    vendorKeys: c.vendorKeys && typeof c.vendorKeys === 'object' ? c.vendorKeys : {},
    // 中转站的系统访问令牌 + 用户 ID（New API 的 /api/user/self 用；与调模型的
    // API Key 是两把不同凭证）。形状：{ packycode: { token, userId } }。
    relayAuth: c.relayAuth && typeof c.relayAuth === 'object' ? c.relayAuth : {},
  }
}

// 只更新传入的字段，其余保持原值。
export function writePluginConfig(patch) {
  const current = readJson(CONFIG_FILE) || {}
  const next = { ...current }
  for (const key of ['apiKey', 'platformToken', 'usageMode', 'port', 'autoStartWidget', 'autoStartOverlay', 'autoStartWithZcode', 'followIntervalMs', 'refreshBalanceOnTurnComplete', 'minBalanceRefreshIntervalMs']) {
    if (patch && patch[key] !== undefined) next[key] = patch[key]
  }
  if (patch && patch.vendorKeys && typeof patch.vendorKeys === 'object') {
    next.vendorKeys = {
      ...(current.vendorKeys && typeof current.vendorKeys === 'object' ? current.vendorKeys : {}),
      ...patch.vendorKeys,
    }
  }
  if (patch && patch.relayAuth && typeof patch.relayAuth === 'object') {
    next.relayAuth = {
      ...(current.relayAuth && typeof current.relayAuth === 'object' ? current.relayAuth : {}),
      ...patch.relayAuth,
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
//   2. 本插件配置 <CODEBUDDY_PLUGIN_DATA>/config.json 的 apiKey
//   3. 宿主侧发现的 DeepSeek 凭据（见 discover.mjs）
//
// ⚠️ 第 3 条在 WorkBuddy 上**大概率落空**：ZCode 版能「零配置复用客户端里配好的
// DeepSeek provider」，是因为 ZCode 有 provider_config.json；WorkBuddy 的模型由
// 宿主托管（订阅积分制），用户不需要填 key，本机实测 pluginConfigs 为空、
// models.json 为 `[]`（docs/porting/phase-0.md）。所以余额类功能在 WorkBuddy 上
// 属于**可选项**：用户想用就自己配（环境变量或 `node lib/cli.mjs key sk-...`），
// 不配则主口径照常走积分（/whale/last-turn.json 与 /whale/usage-records.json）。
// 密钥只在本进程内存中使用，只发往白名单主机，不落盘、不打印。

function isDeepseekEntry(e) {
  if (e.isLocal || e.keyEncrypted || !e.apiKey) return false
  if (e.host === 'api.deepseek.com' || e.host.endsWith('.deepseek.com')) return true
  // 有效 baseURL 解析不出来的兜底：显式 deepseek 模板的非本地 provider
  return !e.host && e.templateId === 'deepseek'
}

function apiKeyFromHostProviders() {
  for (const e of listHostProviders()) {
    if (isDeepseekEntry(e)) return e.apiKey
  }
  return ''
}

export function findApiKey() {
  const env = String(process.env.DEEPSEEK_API_KEY || '').trim()
  if (env) return { key: env, source: 'env:DEEPSEEK_API_KEY' }
  const cfg = readPluginConfig().apiKey.trim()
  if (cfg) return { key: cfg, source: 'plugin-config' }
  const fromHost = apiKeyFromHostProviders()
  if (fromHost) return { key: fromHost, source: 'host-provider' }
  return { key: '', source: 'none' }
}

// 排查用：找 key 失败时把「探过哪些地方、各自看到什么」如实报出来（不含密钥内容）。
export function describeKeyProbe() {
  const entries = listHostProviders().map((e) => ({
    providerId: e.providerId,
    templateId: e.templateId,
    host: e.host,
    isLocal: e.isLocal,
    hasKey: !!e.apiKey,
    keyEncrypted: e.keyEncrypted,
    source: e.source.split(':')[0],
    file: e.source.slice(e.source.indexOf(':') + 1),
  }))
  return {
    checked: ['env:DEEPSEEK_API_KEY', 'plugin-config:' + CONFIG_FILE, 'host-settings:' + HOST_SETTINGS_FILE],
    // WorkBuddy 侧没有 ZCode 那种「客户端 provider 配置」，见本文件头部说明
    hostSettingsFile: HOST_SETTINGS_FILE,
    note: 'WorkBuddy 的模型由宿主托管（订阅积分制），默认没有用户自带 key；厂商卡按需自行配置。',
    entries,
  }
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
