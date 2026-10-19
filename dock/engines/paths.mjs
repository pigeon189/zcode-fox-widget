// 引擎层的路径解析。
//
// 与挂件线 lib/paths.mjs 的区别（D022）：
//   · dock 自己的数据目录是 %LOCALAPPDATA%\fox-dock（或 FOX_DOCK_DATA）；
//   · 宿主 ZCode 的路径只读（DB / rollout / 客户端配置），不写；
//   · 旧挂件配置只作为**导入源**读取，写配置永远写 dock 自己的文件。
//
// 引擎默认在 daemon 里运行；daemon 会把实际 --data-dir 写进 FOX_DOCK_DATA，
// 保证 CLI 传了自定义目录时这里也跟着走。

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ASSETS_DIR = path.join(PLUGIN_ROOT, 'assets')

export function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch (err) {
    return '0.0.0'
  }
}

export const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')

function defaultDataDir() {
  const base =
    process.env.FOX_DOCK_DATA ||
    (process.platform === 'win32' && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : path.join(os.homedir(), '.local', 'share'))
  return path.join(base, 'fox-dock')
}

export const DATA_DIR = path.resolve(defaultDataDir())

// dock 自己维护的厂商配置（导入后的 vendorKeys / relayAuth 等）
export const CONFIG_FILE = path.join(DATA_DIR, 'vendor-config.json')
// 旧挂件的配置：只读，作为一次性导入源
export const LEGACY_CONFIG_FILE = path.join(ZCODE_HOME, 'whale', 'config.json')
// 旧挂件状态/账本：dock 的余额校正沿用同名结构，但写到自己的目录
export const WIDGET_STATE_FILE = path.join(DATA_DIR, 'widget-state.json')
export const LEDGER_FILE = path.join(DATA_DIR, 'usage-ledger.json')
export const SERVER_INFO_FILE = path.join(DATA_DIR, 'server.json')
export const SERVER_LOG_FILE = path.join(DATA_DIR, 'server.log')
export const TURN_SEQ_FILE = path.join(DATA_DIR, 'turn-seq.json')
export const ROLES_DIR = path.join(DATA_DIR, 'roles')
export const ROLES_INDEX_FILE = path.join(DATA_DIR, 'roles.json')
export const SOUNDS_DIR = path.join(DATA_DIR, 'sounds')
export const SOUNDS_INDEX_FILE = path.join(DATA_DIR, 'sounds.json')
export const BUBBLE_CONTENT_FILE = path.join(DATA_DIR, 'bubble-content.json')
export const BUBBLE_TEMPLATES_FILE = path.join(DATA_DIR, 'bubble-templates.json')
export const BUBBLE_IMGS_DIR = path.join(DATA_DIR, 'bubble-imgs')
export const BUBBLE_IMGS_INDEX_FILE = path.join(DATA_DIR, 'bubble-imgs.json')

export const DB_FILE = path.join(ZCODE_HOME, 'cli', 'db', 'db.sqlite')
export const ROLLOUT_DIR = path.join(ZCODE_HOME, 'cli', 'rollout')
export const ZCODE_CLIENT_CONFIG = path.join(ZCODE_HOME, 'v2', 'config.json')

function readRuntimeEnv(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const value = raw && typeof raw.ZCODE_DATA_BASE_DIR === 'string' ? raw.ZCODE_DATA_BASE_DIR.trim() : ''
    return value
  } catch (err) {
    return ''
  }
}

// ZCode 数据目录迁移后，只有 ZCode 进程内拉起的插件才拿得到
// ZCODE_DATA_BASE_DIR；开机自启/普通终端拉起的 daemon 没有这个变量。
// 旧挂件会把实际值写进 ~/.zcode/whale/runtime-env.json，dock 自己也
// 持久化一份，按顺序现读——否则 CommandCode / GLM Plan 等由 provider
// 配置发现的凭据会整体消失（表现为「用着 CommandCode 却没有余额」）。
export function zcodeDataBase(env = process.env) {
  const direct = String(env.ZCODE_DATA_BASE_DIR || '').trim()
  if (direct) return direct
  for (const file of [
    path.join(DATA_DIR, 'runtime-env.json'),
    path.join(ZCODE_HOME, 'whale', 'runtime-env.json'),
    path.join(ZCODE_HOME, 'v2', 'runtime-env.json'),
  ]) {
    const value = readRuntimeEnv(file)
    if (value) return value
  }
  return ''
}

export function v2DataDirCandidates() {
  const dirs = []
  const base = zcodeDataBase()
  if (base) dirs.push(path.join(base, '.zcode', 'v2'))
  dirs.push(path.join(ZCODE_HOME, 'v2'))
  return dirs
}

export const BUILTIN_ROLES = [
  { id: 'fox', name: '嘎啦嘛', image: path.join(ASSETS_DIR, 'roles', 'fox.png') },
  { id: 'whale', name: '大肥鱼', image: path.join(ASSETS_DIR, 'roles', 'whale.png') },
  { id: 'gpt', name: 'GPT娘', image: path.join(ASSETS_DIR, 'roles', 'gpt.png') },
  { id: 'kimi', name: 'kimi娘', image: path.join(ASSETS_DIR, 'roles', 'kimi.png') },
  { id: 'xiaoke', name: '小克', image: path.join(ASSETS_DIR, 'roles', 'xiaoke.png') },
  { id: 'gemini', name: '哈基米', image: path.join(ASSETS_DIR, 'roles', 'gemini.png') },
]
export const DEFAULT_ROLE_ID = 'fox'
export const BUILTIN_ROLE_RENAMES = { xiaohuniang: 'fox' }

export const MODEL_ROLE_RULES = [
  { roleId: 'fox', keywords: ['glm', 'zhipu', 'chatglm', 'z.ai', 'zai-', 'bigmodel'] },
  { roleId: 'whale', keywords: ['deepseek'] },
  { roleId: 'gpt', keywords: ['gpt', 'openai', 'chatgpt', 'o1-', 'o3-', 'o4-', 'codex'] },
  { roleId: 'kimi', keywords: ['kimi', 'moonshot'] },
  { roleId: 'xiaoke', keywords: ['claude', 'anthropic'] },
  { roleId: 'gemini', keywords: ['gemini'] },
]

export function roleIdForModel(model) {
  const m = String(model || '').toLowerCase()
  if (!m) return null
  for (const rule of MODEL_ROLE_RULES) {
    for (const kw of rule.keywords) {
      if (m.indexOf(kw) !== -1) return rule.roleId
    }
  }
  return null
}

export const IMAGE_CANDIDATES = [path.join(ASSETS_DIR, 'roles', 'whale.png')]
export const GIF_CANDIDATES = []
export const SOUND_SETS = { duck: { press: [], release: [] }, fx1: { press: [], release: [] } }
export const BUILTIN_SOUND_NAMES = { duck: '小黄鸭', fx1: '音效1' }
export const DEFAULT_PORT = Number(process.env.FOX_DOCK_PORT) || 39401
