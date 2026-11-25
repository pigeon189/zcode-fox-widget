// 本插件在 ZCode 里是否还启用着。
//
// 为什么需要：在 ZCode 里禁用插件（「取消使用」）只改 <ZCODE_HOME>/cli/config.json
// 的 plugins.enabledPlugins，并把插件从下一次加载里摘掉——**不通知已经跑起来的
// 进程**。挂件服务、桌面浮层、看门进程都是我们自己拉起的常驻进程，没人收就会
// 一直挂在桌面上（issue #24：禁用后挂件仍然显示，只能任务管理器手杀一串进程）。
// 看门进程与 MCP server 都靠这个模块判断「该不该继续活着」。
//
// 判定边界（宁可不动，也不误杀）：
//   · 只认 <ZCODE_HOME>/cli/config.json 的 plugins.enabledPlugins 对象。文件读不到、
//     JSON 坏了、结构不是对象——一律「未知」，调用方按「什么都不做」处理。
//   · 键名格式是 <插件名>@<市场名>。按 @ 前半段**精确等于**插件清单的 name 匹配，
//     所以 workbuddy 线的 fox-widget@fox-local（fox-widget 确实是 zcode-fox-widget
//     的子串）与 dsh 侧的 dsh-whale-widget 都不会被误命中。
//   · 同一插件可能在多个市场各装一份：任意一条为 true 就算启用；只有全部条目
//     都**显式写成 false** 才算禁用；一条都没有算未知（手装副本、老配置等）。
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_ROOT, ZCODE_HOME } from './paths.mjs'

export const PLUGIN_NAME_FALLBACK = 'zcode-fox-widget'
export const USER_CONFIG_FILE = path.join(ZCODE_HOME, 'cli', 'config.json')

// 插件清单里的 name（唯一来源）。读不到就退回包名。
export function pluginName() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.zcode-plugin', 'plugin.json'), 'utf8'))
    const n = j && typeof j.name === 'string' ? j.name.trim() : ''
    if (n) return n
  } catch (err) {}
  return PLUGIN_NAME_FALLBACK
}

// '<插件名>@<市场名>' → 插件名部分。用 lastIndexOf：插件名和市场名里都不会出现 @。
export function pluginNameOfKey(key) {
  const k = String(key == null ? '' : key)
  const at = k.lastIndexOf('@')
  return at > 0 ? k.slice(0, at) : ''
}

// 从 ZCode 用户配置里取出 enabledPlugins；结构不符返回 null（= 无法判断）
export function enabledPluginsOf(cliConfig) {
  if (!cliConfig || typeof cliConfig !== 'object') return null
  const plugins = cliConfig.plugins
  if (!plugins || typeof plugins !== 'object') return null
  const entries = plugins.enabledPlugins
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null
  return entries
}

// 纯函数：enabledPlugins → { state: 'enabled' | 'disabled' | 'unknown', matched }
// 只有**值显式是 false** 才记为关闭；undefined/其它异常值一律按启用算，避免误杀。
export function pluginEnabledState(entries, name = PLUGIN_NAME_FALLBACK) {
  if (!entries || typeof entries !== 'object') return { state: 'unknown', matched: [] }
  const matched = []
  for (const [key, value] of Object.entries(entries)) {
    if (pluginNameOfKey(key) !== name) continue
    matched.push({ key, enabled: value !== false })
  }
  if (!matched.length) return { state: 'unknown', matched }
  return { state: matched.some((m) => m.enabled) ? 'enabled' : 'disabled', matched }
}

export function readEnabledPlugins(file = USER_CONFIG_FILE) {
  try {
    return enabledPluginsOf(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch (err) {
    return null
  }
}

// file / name 可注入：自检在临时目录里造配置，绝不读真实用户配置。
export function pluginEnabledStateNow(opts = {}) {
  const file = opts.file || USER_CONFIG_FILE
  const name = opts.name || pluginName()
  const result = pluginEnabledState(readEnabledPlugins(file), name)
  return { ...result, file, name }
}
