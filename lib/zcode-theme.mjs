// ZCode 自己用的主题：三层判定，取值归一到挂件三态 'light' | 'dark' | 'system'。
//
// 背景（2026-10-01 实测）：挂件主题里的「跟随 ZCode」必须跟随 **ZCode 当前主题**，
// 而不是操作系统深浅色——实测这台机器上 OS 是浅色、ZCode 是暗色，只看系统必错。
//
// 三层来源（优先级从高到低）：
//   1. **观测**（~/.zcode/whale/zcode-theme-observed.json，浮层跟随脚本写）：
//      直接读 ZCode 主窗口的 DWM 沉浸式暗色标志（DWMWA_USE_IMMERSIVE_DARK_MODE）。
//      ZCode 壳层把自己的主题设到 Electron nativeTheme（其 app 包：
//      nativeTheme.themeSource = 用户所选），该标志就是「ZCode 实际在用的主题」，
//      且跟随设置实时变化。注意它跟的是应用主题而非 CSS/系统：实测把系统设浅色、
//      ZCode 设暗色，标志 = 1。浮层没跑（浏览器模式）就没有观测，自动降级。
//   2. **配置**：ZCode 用户级配置 <ZCODE_HOME>/cli/config.json 的 ui.theme
//      （取值 light|dark|zai-light|zai-dark|system，缺省 "auto"；zai-* 是两种配色
//      皮肤，映射到挂件的浅/深）。项目级配置（<project>/zcode.json）优先级更高，
//      但浮层拿不到「用户当前打开的项目」，此为已记录取舍（见 README）。
//   3. **系统**：都拿不到时返回 'system'，页面再退回操作系统深浅色。
//
// 观测按时间戳保鲜（TTL 24h；浮层活着时每 60s 刷一次时间戳、干净退出会删文件），
// 防止「浮层早已退出、ZCode 后来改了主题」时用旧观测以新充旧。
import fs from 'node:fs'
import path from 'node:path'
import { ZCODE_HOME } from './paths.mjs'

const CACHE_TTL_MS = 5000
const OBSERVED_TTL_MS = 24 * 3600 * 1000

export const USER_CONFIG_FILE = path.join(ZCODE_HOME, 'cli', 'config.json')
export const OBSERVED_FILE = path.join(ZCODE_HOME, 'whale', 'zcode-theme-observed.json')

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

// 三层合并（纯函数，供测试）：新鲜观测 > 配置 > 系统。
//   observed = { dark: 0|1, at }（at 缺失视为新鲜；过期则忽略）
//   rawConfig = 配置里的 ui.theme 原始值
export function resolveZcodeTheme(observed, rawConfig, now = Date.now()) {
  if (observed && (observed.dark === 0 || observed.dark === 1)) {
    const at = Number(observed.at) || 0
    if (!at || now - at <= OBSERVED_TTL_MS) return observed.dark === 1 ? 'dark' : 'light'
  }
  return mapZcodeTheme(rawConfig)
}

function readObserved() {
  try {
    const o = JSON.parse(fs.readFileSync(OBSERVED_FILE, 'utf8'))
    if (!o || (o.dark !== 0 && o.dark !== 1)) return null
    const at = Number(o.at) || 0
    if (at && Date.now() - at > OBSERVED_TTL_MS) return null // 过期观测不算数
    return o
  } catch (err) {
    return null
  }
}

// 读主题并归一。返回 { theme, raw, source, file, observed }
//   theme  ∈ light | dark | system
//   raw    实际生效那一层的原始值（观测层为 'dark'/'light'）
//   source 'zcode-window'（观测）/ 'user-config'（配置）/ 'missing' / 'unreadable'
export function readZcodeTheme() {
  const cached = readZcodeTheme.cache
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload
  const observed = readObserved()
  let rawCfg = null
  let cfgSource = 'missing'
  try {
    const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_FILE, 'utf8'))
    rawCfg = themeOfConfig(cfg)
    cfgSource = 'user-config'
  } catch (err) {
    cfgSource = err && err.code === 'ENOENT' ? 'missing' : 'unreadable'
  }
  const payload = observed
    ? {
        theme: observed.dark === 1 ? 'dark' : 'light',
        raw: observed.dark === 1 ? 'dark' : 'light',
        source: 'zcode-window',
        file: OBSERVED_FILE,
        observed: { dark: observed.dark, at: Number(observed.at) || null },
      }
    : {
        theme: mapZcodeTheme(rawCfg),
        raw: rawCfg,
        source: rawCfg ? 'user-config' : cfgSource,
        file: USER_CONFIG_FILE,
        observed: null,
      }
  readZcodeTheme.cache = { at: Date.now(), payload }
  return payload
}

export function invalidateZcodeThemeCache() {
  readZcodeTheme.cache = null
}
