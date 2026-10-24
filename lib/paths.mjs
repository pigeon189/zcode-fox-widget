// 插件内的所有路径解析。集中在这里，方便迁移与调试。
//
// 宿主差异（数据目录、db、主题、进程名、单例特征）**全部**从 ./host.mjs 取，
// 本文件只负责「插件自己的路径 + 与宿主无关的常量」。这样 merge main 时本文件
// 基本不冲突（见 host.mjs 开头的说明）。
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HOST_HOME, ENV, PLUGIN_DATA_DIR } from './host.mjs'

// lib/paths.mjs -> 插件根目录
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const ASSETS_DIR = path.join(PLUGIN_ROOT, 'assets')

// 版本号单一来源：插件清单 .codebuddy-plugin/plugin.json。/whale/health、MCP 握手、
// 插件页展示的是同一个版本；marketplace.json 的副本由 selftest 的三处一致性
// 断言兜底（审查 P2-2：server.mjs 曾硬编码 VERSION，与清单存在漂移风险）。
export function pluginVersion() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, '.codebuddy-plugin', 'plugin.json'), 'utf8')
    const v = JSON.parse(raw).version
    if (typeof v === 'string' && v.trim()) return v.trim()
  } catch (err) {}
  return '0.0.0'
}

// 宿主用户目录（~/.workbuddy）。环境变量可覆盖，便于测试与多 profile 隔离。
export { HOST_HOME }

// 插件自己的数据目录：配置、账本、挂件状态、运行信息都写这里。
// 默认 = <HOST_HOME>/plugins/data/<插件名>-<市场名>（宿主自己也是这么算的），
// MCP 进程里宿主会把它作为 CODEBUDDY_PLUGIN_DATA 注入，优先级更高。
export const DATA_DIR = PLUGIN_DATA_DIR

// 用户配置（apiKey / platformToken / port / usageMode 等）
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
// 挂件外观与开关（等价于上游的 .dshw-size.json）
export const WIDGET_STATE_FILE = path.join(DATA_DIR, 'widget-state.json')
// 记账模式账本（等价于上游的 .dshw-usage.json）
export const LEDGER_FILE = path.join(DATA_DIR, 'usage-ledger.json')
// 挂件服务运行信息（pid / port / url），供命令与 MCP 复用同一个服务
export const SERVER_INFO_FILE = path.join(DATA_DIR, 'server.json')
// 服务日志（启动失败时排查用）
export const SERVER_LOG_FILE = path.join(DATA_DIR, 'server.log')
// 每轮消耗气泡的 seq 计数（服务重启后续号，前端靠它区分"新的一轮"）
export const TURN_SEQ_FILE = path.join(DATA_DIR, 'turn-seq.json')
// 自定义角色：图片目录 + 索引（角色上传/选择，见 server.mjs 的 roles 路由）
export const ROLES_DIR = path.join(DATA_DIR, 'roles')
export const ROLES_INDEX_FILE = path.join(DATA_DIR, 'roles.json')
// 导入的音效集：音频文件目录 + 索引（内置集在 SOUND_SETS，导入集在这里）
export const SOUNDS_DIR = path.join(DATA_DIR, 'sounds')
export const SOUNDS_INDEX_FILE = path.join(DATA_DIR, 'sounds.json')
// 按压泡泡队列（对应上游的 .dshw-bubble.json；v1.3.0 为文字队列，v1.5.0 起 v2 点击队列）
export const BUBBLE_CONTENT_FILE = path.join(DATA_DIR, 'bubble-content.json')
// 泡泡模板：每轮消耗 / 预警的可编辑内容（null = 内置默认文案）
export const BUBBLE_TEMPLATES_FILE = path.join(DATA_DIR, 'bubble-templates.json')
// 泡泡图库：图片/随机图片模块的素材目录 + 索引（内置 rua 用包内素材）
export const BUBBLE_IMGS_DIR = path.join(DATA_DIR, 'bubble-imgs')
export const BUBBLE_IMGS_INDEX_FILE = path.join(DATA_DIR, 'bubble-imgs.json')
// 钩子状态：最近一次钩子事件 + 当前会话身份（sessionId / transcriptPath）。
// 「每轮消耗」「当前模型」「等确认提醒」全靠它把挂件服务对到正确的会话上。
export const HOOK_STATE_FILE = path.join(DATA_DIR, 'hook-state.json')

// 「本次关闭」标记（菜单里的「关闭插件」写下，见 service.mjs）：本线的看门狗会常暖服务、
// 宿主在跑就每 15 秒补活，用户点过关闭后它会立刻把挂件拉回来——所以关掉时要留个标记
// 让看门狗停手。标记只活到「下一次宿主启动」或「挂件被别的路径（钩子 / 显式启动）拉回来」，
// 与「只是本次关闭」的语义一致，不是「以后都别自启」。
export const CLOSE_PAUSE_FILE = path.join(DATA_DIR, 'close-pause.json')

// 宿主侧的会话数据库与 transcript（只读；测试一律先 copy 再读）。真正的解析在
// lib/turn-cost.mjs，这里只暴露路径来源，避免别处再拼一遍宿主目录。
export { HOST_DB_FILE as DB_FILE, HOST_PROJECTS_DIR as PROJECTS_DIR, hostPreferenceFiles } from './host.mjs'

// 内置角色：嘎啦嘛为默认形象（安装即选中，替代旧「默认」语义），
// 大肥鱼即原「默认」的鲸鱼形象；GPT 娘 / kimi 娘 / 小克为项目自有素材
//（2026-10-06/07 收录）。五套内置角色各有专属台词包（大肥鱼那套是默认套，
// 用户导入的角色也用它）。roles.json 只存用户上传的角色。
// 嘎啦嘛 id 曾用 xiaohuniang（v1.7.3 及之前）：持久化里出现的旧值按
// BUILTIN_ROLE_RENAMES 在读取侧归一，不要求用户手改配置。
export const BUILTIN_ROLES = [
  { id: 'fox', name: '嘎啦嘛', image: path.join(ASSETS_DIR, 'GLM.png') },
  { id: 'whale', name: '大肥鱼', image: path.join(ASSETS_DIR, 'DSniang1.png') },
  { id: 'gpt', name: 'GPT娘', image: path.join(ASSETS_DIR, 'gpt.png') },
  { id: 'kimi', name: 'kimi娘', image: path.join(ASSETS_DIR, 'kimi.png') },
  { id: 'xiaoke', name: '小克', image: path.join(ASSETS_DIR, 'xiaoke.png') },
  { id: 'gemini', name: '哈基米', image: path.join(ASSETS_DIR, 'gemini.png') },
]
export const DEFAULT_ROLE_ID = 'fox'
export const BUILTIN_ROLE_RENAMES = { xiaohuniang: 'fox' }

// 模型名 → 内置角色（「按模型自动换角色」用，2026-10-13 借鉴 CrossPet 的思路）。
// 匹配方式是**小写子串**：宿主的模型标识既有网关前缀也有套餐前缀（ZCode 侧是
// `<providerId>/<modelId>` 拼串；WorkBuddy 侧就是裸 modelId，如 `deepseek-v4.1-flash`、
// `glm-5.3`），只有子串匹配能同时罩住。认不出的模型一律**不动**当前角色
//（宁可保持现状，也不乱换人）——WorkBuddy 的 `hy4-preview` / `hy3` / `step-5-preview` /
// `space-bunny` / `minimax-m3-pay` / `fast-model` 等目前都属于「认不出」，这是
// 有意为之：没有对应立绘，硬映射反而突兀（见 README「按模型换角色」）。
// 映射依据：fox 的立绘就是 GLM.png（GLM 族）、whale 是原版鲸鱼（DeepSeek 族）、
// gpt / kimi 各自同名，xiaoke 按「小克 ≈ Claude 谐音」归给 Claude 族，
// gemini 即哈基米（Google Gemini 族，id 与代码口径用 gemini）。
export const MODEL_ROLE_RULES = [
  { roleId: 'fox', keywords: ['glm', 'zhipu', 'chatglm', 'z.ai', 'zai-', 'bigmodel'] },
  { roleId: 'whale', keywords: ['deepseek'] },
  { roleId: 'gpt', keywords: ['gpt', 'openai', 'chatgpt', 'o1-', 'o3-', 'o4-', 'codex'] },
  { roleId: 'kimi', keywords: ['kimi', 'moonshot'] },
  { roleId: 'xiaoke', keywords: ['claude', 'anthropic'] },
  { roleId: 'gemini', keywords: ['gemini'] },
]

// 只做纯字符串判定，不碰文件系统（可用性由调用方按角色列表再判一次）
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

// 最终兜底：首选 DSniang1.png，回退 DSniang02.png（与上游一致）
export const IMAGE_CANDIDATES = [
  path.join(ASSETS_DIR, 'DSniang1.png'),
  path.join(ASSETS_DIR, 'DSniang02.png'),
]
export const GIF_CANDIDATES = [path.join(ASSETS_DIR, 'rua.gif')]

// 按压/松手音效，三套可选（duck=小黄鸭，fx1=嘀嘟，nya=猫娘）
export const SOUND_SETS = {
  duck: {
    press: [path.join(ASSETS_DIR, 'Ya1.mp3')],
    release: [path.join(ASSETS_DIR, 'Ya2.mp3')],
  },
  fx1: {
    press: [path.join(ASSETS_DIR, 'D1.mp3')],
    release: [path.join(ASSETS_DIR, 'D2.mp3')],
  },
  nya: {
    // 一声制：按压喵声，松手静音占位（发布用自定义集验过，内置分支需正确 MIME）
    press: [path.join(ASSETS_DIR, 'Nya1.wav')],
    release: [path.join(ASSETS_DIR, 'Nya2.wav')],
  },
}

// 内置音效集在界面上的名字（导入集的名字存在索引里）
export const BUILTIN_SOUND_NAMES = { duck: '小黄鸭', fx1: '嘀嘟', nya: '猫娘' }

// 默认监听端口。环境变量可覆盖：端到端测试要在与真实挂件完全隔离的端口上跑，
// 否则 findRunningServer 会回落到默认端口、探到本机正在运行的那个服务并「复用」它。
export const DEFAULT_PORT = Number(process.env[ENV.port]) || 39321
