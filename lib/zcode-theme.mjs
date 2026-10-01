// ZCode 自己用的主题（配置项 ui.theme）读取与归一。
//
// 背景（2026-10-01）：挂件主题里的「跟随 ZCode」必须跟随 **ZCode 当前主题**，
// 而不是操作系统深浅色——在 ZCode 里手动选了浅色/深色时，浮层跟着系统走就是错的。
//
// ZCode 的存储（3.14.4 实测，从客户端 bundle 里核对）：
//   - 用户级配置：<ZCODE_HOME>/cli/config.json，形如 { "ui": { "theme": "..." } }
//   - 取值只认 light | dark | zai-light | zai-dark | system，缺省是 "auto"
//     （bundle 里的校验函数与默认配置：ui:{locale,theme:"auto"}）
//   - 项目级配置（<project>/zcode.json 或 <project>/.zcode/config.json）优先级高于
//     用户级；浮层服务拿不到"用户当前打开的项目"这一事实，因此只读用户级——
//     项目级覆盖了主题时挂件会跟随用户级，属已知取舍（见 README）。
//
// 归一到挂件的三态：'light' | 'dark' | 'system'。
// zai-light/zai-dark 是 ZCode 的两种配色皮肤（浅/深底），映射到挂件的浅/深；
// system/auto/缺失/读不到 → 'system'（挂件再退回系统深浅色，与 ZCode 的
// 「跟随系统」语义一致）。
import fs from 'node:fs'
import path from 'node:path'
import { ZCODE_HOME } from './paths.mjs'

const CACHE_TTL_MS = 5000

export const USER_CONFIG_FILE = path.join(ZCODE_HOME, 'cli', 'config.json')

// 纯函数：配置里的原始值 → 挂件三态（可测）
export function mapZcodeTheme(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase()
  if (v === 'dark' || v === 'zai-dark') return 'dark'
  if (v === 'light' || v === 'zai-light') return 'light'
  return 'system'
}

// 从一份解析好的配置对象里取 ui.theme（原始值）
export function themeOfConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null
  const ui = cfg.ui
  if (!ui || typeof ui !== 'object') return null
  const v = ui.theme
  if (typeof v !== 'string') return null
  return v.trim() || null
}

// 读用户级配置并归一。返回 { theme, raw, source, file }
//   theme  ∈ light | dark | system
//   raw    配置里的原始值（诊断用）
//   source 'user-config'（读到了）/ 'missing'（文件不存在）/ 'unreadable'（坏文件）
// 5 秒缓存：页面按 10 秒轮询，够实时又不至于每次请求都摸磁盘。
export function readZcodeTheme() {
  const cached = readZcodeTheme.cache
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload
  let payload = { theme: 'system', raw: null, source: 'missing', file: USER_CONFIG_FILE }
  try {
    const text = fs.readFileSync(USER_CONFIG_FILE, 'utf8')
    const cfg = JSON.parse(text)
    const raw = themeOfConfig(cfg)
    payload = raw
      ? { theme: mapZcodeTheme(raw), raw, source: 'user-config', file: USER_CONFIG_FILE }
      : { theme: 'system', raw: null, source: 'user-config', file: USER_CONFIG_FILE }
  } catch (err) {
    payload.source = err && err.code === 'ENOENT' ? 'missing' : 'unreadable'
  }
  readZcodeTheme.cache = { at: Date.now(), payload }
  return payload
}

export function invalidateZcodeThemeCache() {
  readZcodeTheme.cache = null
}
