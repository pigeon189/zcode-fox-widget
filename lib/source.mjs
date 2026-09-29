// 计费源解析：把「providerId / modelId / 有效 baseURL」映射到统一计费口径。
// 智能跟随（/whale/session.json）、气泡主显示、每轮消耗展示都走这一套判据，
// 保证「对话栏选了什么」与「气泡显示哪个源」永远一致。
//
// 判据优先级：
//   1. 订阅/套餐型 providerId（account:*plan* / *coding-plan*）→ Plan 配额口径
//   2. 有效 baseURL 域名（能区分 MiMo 的 api/plan 双端点）
//   3. providerId 关键词
//   4. model_id 前缀（网关转发时只有模型名指向真正厂商）
//   5. 全未知 → 'tokens'（只显示消耗量，**不冒充任何厂商的余额**）

const SOURCE_DEFS = {
  plan: { source: 'plan', vendor: 'zcode-plan', label: 'Plan 配额', currency: 'CNY', timeMode: 'none' },
  glm: { source: 'glm', vendor: 'glm', label: 'GLM 按量', currency: 'CNY', timeMode: 'none' },
  ds: { source: 'ds', vendor: 'deepseek', label: 'DeepSeek 余额', currency: 'CNY', timeMode: 'peak-valley' },
  'mimo-api': { source: 'mimo-api', vendor: 'mimo', label: 'MiMo API', currency: 'CNY', timeMode: 'none' },
  // Token Plan（token-plan-cn.xiaomimimo.com）：订阅额度，夜间 0.8x 消耗系数
  'mimo-plan': { source: 'mimo-plan', vendor: 'mimo', label: 'MiMo Plan', currency: 'CNY', timeMode: 'offpeak-x0.8' },
  openai: { source: 'openai', vendor: 'openai', label: 'OpenAI', currency: 'USD', timeMode: 'none' },
  claude: { source: 'claude', vendor: 'anthropic', label: 'Claude', currency: 'USD', timeMode: 'none' },
  qwen: { source: 'qwen', vendor: 'qwen', label: 'Qwen', currency: 'CNY', timeMode: 'none' },
  minimax: { source: 'minimax', vendor: 'minimax', label: 'MiniMax', currency: 'CNY', timeMode: 'none' },
  kimi: { source: 'kimi', vendor: 'kimi', label: 'Kimi', currency: 'CNY', timeMode: 'none' },
  tokens: { source: 'tokens', vendor: null, label: '未知来源', currency: null, timeMode: 'none' },
}

export function sourceDef(source) {
  return SOURCE_DEFS[source] || SOURCE_DEFS.tokens
}

function hostnameOf(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).hostname.toLowerCase()
  } catch (err) {
    return ''
  }
}

function modelBasename(modelId) {
  const m = String(modelId || '').trim().toLowerCase()
  const slash = m.lastIndexOf('/')
  return slash === -1 ? m : m.slice(slash + 1)
}

function sourceByHost(host) {
  if (!host) return null
  // MiMo 双端点：Token Plan 与按量 API 是两个不同域名，先精确后模糊
  if (host === 'token-plan-cn.xiaomimimo.com' || host.startsWith('token-plan')) return 'mimo-plan'
  if (host.endsWith('xiaomimimo.com') || host === 'mimo.mi.com' || host.endsWith('.mimo.mi.com')) return 'mimo-api'
  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return 'ds'
  if (host === 'open.bigmodel.cn' || host.endsWith('.bigmodel.cn') || host === 'api.z.ai' || host.endsWith('.z.ai')) return 'glm'
  if (host === 'api.openai.com' || host.endsWith('.openai.com')) return 'openai'
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com') || host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude'
  if (host.indexOf('dashscope') !== -1) return 'qwen'
  if (host.endsWith('minimaxi.com') || host.endsWith('minimax.io')) return 'minimax'
  if (host === 'api.moonshot.cn' || host.endsWith('.moonshot.cn') || host.endsWith('.moonshot.ai') || host === 'kimi.com' || host.endsWith('.kimi.com')) return 'kimi'
  return null
}

function sourceByProviderId(pid) {
  if (!pid) return null
  if (pid.indexOf('start-plan') !== -1 || pid.indexOf('coding-plan') !== -1 || pid.indexOf('zcode-plan') !== -1) return 'plan'
  if (pid.indexOf('bigmodel') !== -1 || pid.indexOf('zhipu') !== -1 || pid.indexOf('glm') !== -1 || pid.indexOf('zai') !== -1) return 'glm'
  if (pid.indexOf('deepseek') !== -1) return 'ds'
  if (pid.indexOf('mimo') !== -1 || pid.indexOf('xiaomi') !== -1) return 'mimo-api'
  if (pid.indexOf('openai') !== -1 || pid.indexOf('gpt') !== -1) return 'openai'
  if (pid.indexOf('anthropic') !== -1 || pid.indexOf('claude') !== -1) return 'claude'
  if (pid.indexOf('qwen') !== -1 || pid.indexOf('dashscope') !== -1 || pid.indexOf('bailian') !== -1) return 'qwen'
  if (pid.indexOf('minimax') !== -1) return 'minimax'
  if (pid.indexOf('kimi') !== -1 || pid.indexOf('moonshot') !== -1) return 'kimi'
  return null
}

function sourceByModel(modelId) {
  const m = modelBasename(modelId)
  if (!m) return null
  if (m.indexOf('deepseek') !== -1) return 'ds'
  if (m.indexOf('glm') === 0) return 'glm'
  if (m.indexOf('mimo') !== -1) return 'mimo-api'
  if (m.indexOf('gpt') === 0 || m.indexOf('o1') === 0 || m.indexOf('o3') === 0 || m.indexOf('o4') === 0 || m.indexOf('codex') !== -1) return 'openai'
  if (m.indexOf('claude') !== -1 || m.indexOf('fable') === 0) return 'claude'
  if (m.indexOf('qwen') !== -1) return 'qwen'
  if (m.indexOf('minimax') !== -1) return 'minimax'
  if (m.indexOf('kimi') === 0 || m.indexOf('moonshot') === 0 || m.indexOf('k2') === 0 || m.indexOf('k3') === 0) return 'kimi'
  return null
}

// 主入口。返回 { source, vendor, label, currency, timeMode }。
export function resolveBillingSource(providerId, modelId, baseUrl) {
  const pid = String(providerId || '').trim().toLowerCase()
  let source = null
  // 1) 订阅/套餐型 provider 优先：走配额口径，不看它挂什么域名
  if (pid && (pid.indexOf('start-plan') !== -1 || pid.indexOf('coding-plan') !== -1)) source = 'plan'
  // 2) 有效 baseURL 域名（MiMo api/plan 双端点靠这里区分）
  if (!source) source = sourceByHost(hostnameOf(baseUrl))
  // 3) providerId 关键词
  if (!source) source = sourceByProviderId(pid)
  // 4) model_id 兜底（网关转发：只有模型名指向真正厂商）
  if (!source) source = sourceByModel(modelId)
  // 5) 全未知：只报消耗量，不冒充任何厂商
  if (!source) source = 'tokens'
  return sourceDef(source)
}

// MiMo Token Plan 夜间系数时段：北京时间 00:00–08:00（官方 FAQ，消耗 0.8x）
export function isNightOffpeak(atMs) {
  const t = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now()
  const bj = new Date(t + 8 * 3600 * 1000)
  const hour = bj.getUTCHours()
  return hour >= 0 && hour < 8
}
