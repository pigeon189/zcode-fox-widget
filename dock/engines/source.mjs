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
//   6. GLM 订阅修正：账号有 GLM Coding Plan 套餐配额时，GLM 源按 Plan 口径算
//      （名称区分不出订阅与按量，账号事实分得出；见 resolveBillingSource 第 6 步）
import { glmSubscriptionActive } from './glm-plan-api.mjs'

const SOURCE_DEFS = {
  plan: { source: 'plan', vendor: 'zcode-plan', label: 'GLM Plan 配额', currency: 'CNY', timeMode: 'none' },
  // CommandCode 套餐（月度池 + 5小时/周窗口；反代或官方 API provider 接入）：
  // 主显示走三重额度卡片；行级计价仍按模型名走 pricing（per-call 真金白银口径另议）
  cmdgo: { source: 'cmdgo', vendor: 'commandcode', label: 'CommandCode', currency: 'USD', timeMode: 'none' },
  // 已确认专用接入路径的火山 Plan（订阅窗口 5小时/周/月）：与 cmdgo 同款
  // 预付池口径——托管模型名（deepseek-v3 / glm-4…）不指向真实按量账单，金额必须归零
  //（1.x v1.16.1 同款分流：按官方 Base URL 路径区分订阅与按量，迁移于 dock 2.0）
  volc: { source: 'volc', vendor: 'volc', label: '火山 Plan', currency: 'CNY', timeMode: 'none' },
  // 火山方舟按量（ark.*.volces.com /api/v3）：平台域名只证明平台，不证明订阅；
  // 保留 Ark 平台身份，避免托管模型被按模型名归到原厂的按量账单
  'volc-api': { source: 'volc-api', vendor: 'volc', label: '火山方舟', currency: 'CNY', timeMode: 'none' },
  glm: { source: 'glm', vendor: 'glm', label: 'GLM 按量', currency: 'CNY', timeMode: 'none' },
  ds: { source: 'ds', vendor: 'deepseek', label: 'DeepSeek 余额', currency: 'CNY', timeMode: 'peak-valley' },
  'mimo-api': { source: 'mimo-api', vendor: 'mimo', label: 'MiMo API', currency: 'CNY', timeMode: 'none' },
  // Token Plan（token-plan-cn.xiaomimimo.com）：订阅额度，夜间 0.8x 消耗系数
  'mimo-plan': { source: 'mimo-plan', vendor: 'mimo', label: 'MiMo Plan', currency: 'CNY', timeMode: 'offpeak-x0.8' },
  openai: { source: 'openai', vendor: 'openai', label: 'OpenAI', currency: 'USD', timeMode: 'none' },
  claude: { source: 'claude', vendor: 'anthropic', label: 'Claude', currency: 'USD', timeMode: 'none' },
  gemini: { source: 'gemini', vendor: 'gemini', label: 'Gemini', currency: 'USD', timeMode: 'none' },
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

function isVolcHost(host) {
  return ['volces.com', 'volcengineapi.com'].some((domain) => host === domain || host.endsWith('.' + domain))
}

// 只信任已核实的官方直连地址；域名家族只证明平台，不能证明套餐。
// 不接受 query/hash/userinfo/非默认端口，避免代理参数或非标准入口误判订阅。
export function volcModeByUrl(baseUrl) {
  try {
    const u = new URL(String(baseUrl || '').trim())
    if (u.protocol !== 'https:' || u.hostname !== 'ark.cn-beijing.volces.com' ||
        u.port || u.username || u.password || u.search || u.hash) return 'unknown'
    const pathname = u.pathname.replace(/\/+$/, '')
    if (pathname === '/api/v3') return 'api'
    if (pathname === '/api/coding' || pathname === '/api/coding/v3') return 'coding'
    if (pathname === '/api/plan' || pathname === '/api/plan/v3') return 'agent'
  } catch (err) {}
  return 'unknown'
}

function isGlmPlanProvider(pid) {
  // 火山套餐由官方 URL 路径判定（volcModeByUrl）；providerId 里的 coding-plan
  // 不再作为 GLM 套餐证据排除火山（如 volc-engineering 供应商命名会误吞）。
  return pid.includes('start-plan') || pid.includes('zcode-plan') ||
    (pid.includes('coding-plan') && !pid.includes('volc'))
}

function sourceByHost(host) {
  if (!host) return null
  // MiMo 双端点：Token Plan 与按量 API 是两个不同域名，先精确后模糊
  if (host === 'token-plan-cn.xiaomimimo.com' || host.startsWith('token-plan')) return 'mimo-plan'
  if (host.endsWith('xiaomimimo.com') || host === 'mimo.mi.com' || host.endsWith('.mimo.mi.com')) return 'mimo-api'
  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return 'ds'
  // 平台域名不证明订阅；先保留 Ark 平台身份，避免托管模型被归到原厂。
  if (isVolcHost(host)) return 'volc-api'
  if (host === 'open.bigmodel.cn' || host.endsWith('.bigmodel.cn') || host === 'api.z.ai' || host.endsWith('.z.ai')) return 'glm'
  if (host === 'api.openai.com' || host.endsWith('.openai.com')) return 'openai'
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com') || host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude'
  // Gemini API 与 Vertex AI 两个官方端点（OpenAI 兼容层也挂在 generativelanguage 下）
  if (host === 'generativelanguage.googleapis.com' || host.endsWith('.generativelanguage.googleapis.com')) return 'gemini'
  if (host === 'aiplatform.googleapis.com' || host.endsWith('.aiplatform.googleapis.com')) return 'gemini'
  if (host.indexOf('dashscope') !== -1) return 'qwen'
  if (host.endsWith('minimaxi.com') || host.endsWith('minimax.io')) return 'minimax'
  if (host === 'api.moonshot.cn' || host.endsWith('.moonshot.cn') || host.endsWith('.moonshot.ai') || host === 'kimi.com' || host.endsWith('.kimi.com')) return 'kimi'
  return null
}

function sourceByProviderId(pid) {
  if (!pid) return null
  if (isGlmPlanProvider(pid)) return 'plan'
  if (pid.indexOf('bigmodel') !== -1 || pid.indexOf('zhipu') !== -1 || pid.indexOf('glm') !== -1 || pid.indexOf('zai') !== -1) return 'glm'
  if (pid.indexOf('deepseek') !== -1) return 'ds'
  if (pid.indexOf('mimo') !== -1 || pid.indexOf('xiaomi') !== -1) return 'mimo-api'
  if (pid.indexOf('openai') !== -1 || pid.indexOf('gpt') !== -1) return 'openai'
  if (pid.indexOf('anthropic') !== -1 || pid.indexOf('claude') !== -1) return 'claude'
  if (pid.indexOf('qwen') !== -1 || pid.indexOf('dashscope') !== -1 || pid.indexOf('bailian') !== -1) return 'qwen'
  if (pid.indexOf('minimax') !== -1) return 'minimax'
  if (pid.indexOf('kimi') !== -1 || pid.indexOf('moonshot') !== -1) return 'kimi'
  if (pid.indexOf('gemini') !== -1 || pid.indexOf('google') !== -1) return 'gemini'
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
  if (m.indexOf('gemini') !== -1) return 'gemini'
  return null
}

// 主入口。返回 { source, vendor, label, currency, timeMode }。
// opts.glmSubscription 可显式指定「本次 GLM 用量走订阅配额」（自检用）；不给就按
// glm-plan-api 记下的账号事实走（见下面的 glue 与 lib/glm-plan-api.mjs）。
export function resolveBillingSource(providerId, modelId, baseUrl, opts) {
  const pid = String(providerId || '').trim().toLowerCase()
  let source = null
  // 0) 火山平台订阅/按量分流（1.x v1.16.1 同款）：ark 官方 Base URL 的路径能
  //    证明套餐——/api/coding、/api/plan 是订阅窗口（金额记 0、配额看 volc-plan
  //    卡），/api/v3 与其余路径是按量（真金白银）。域名家族命中时 providerId 不再
  //    参与猜测（仅用于查配置）：接入的 providerId 可能是无关键词的 UUID，也可能
  //    恰好带 coding-plan 字样，都不能推翻官方路径的事实。
  const hostSource0 = sourceByHost(hostnameOf(baseUrl))
  if (hostSource0 === 'volc-api') {
    const volcMode = volcModeByUrl(baseUrl)
    const plan = volcMode === 'coding' || volcMode === 'agent'
    return {
      ...sourceDef(plan ? 'volc' : 'volc-api'),
      volcMode,
      ...(plan ? { planType: volcMode, label: volcMode === 'coding' ? '火山 Coding Plan' : '火山 Agent Plan' } : {}),
    }
  }
  // 1) 订阅/套餐型 provider 优先：走配额口径，不看它挂什么域名
  //    （isGlmPlanProvider 排除 volc：火山套餐由上面的官方 URL 路径判定）
  if (pid && isGlmPlanProvider(pid)) source = 'plan'
  // 1.5) CommandCode 套餐（反代或官方 API provider）：额度口径，但不改行级计价
  //      （仍按模型）。官方 API 的 providerId 形如 `commandcode-goat-1`，不含
  //      `cmdgo`，必须单独认，否则会按模型名被算成 OpenAI/DeepSeek 的真金白银。
  if (
    !source &&
    (pid.indexOf('cmdgo') !== -1 || pid.indexOf('commandcode') !== -1 || hostnameOf(baseUrl).indexOf('commandcode') !== -1)
  )
    source = 'cmdgo'
  // 2) 有效 baseURL 域名（MiMo api/plan 双端点靠这里区分）
  if (!source) source = sourceByHost(hostnameOf(baseUrl))
  // 3) providerId 关键词
  if (!source) source = sourceByProviderId(pid)
  // 4) model_id 兜底（网关转发：只有模型名指向真正厂商）
  if (!source) source = sourceByModel(modelId)
  // 5) 全未知：只报消耗量，不冒充任何厂商
  if (!source) source = 'tokens'
  // 6) GLM 订阅修正：大模型的 provider/host 名称区分不出「订阅」与「按量」（同一个
  //    open.bigmodel.cn、同一把 key 形状），但**账号事实**分得出——有 GLM Coding Plan
  //    套餐配额时，这次 GLM 用量扣的是订阅额度，按量价目算出来的金额是虚构的（与
  //    「预付池不计真金白银」同一条口径），所以按 Plan 口径显示与计价。
  const glmSub = opts && typeof opts.glmSubscription === 'boolean' ? opts.glmSubscription : glmSubscriptionActive()
  if (source === 'glm' && glmSub) source = 'plan'
  return sourceDef(source)
}

// MiMo Token Plan 夜间系数时段：北京时间 00:00–08:00（官方 FAQ，消耗 0.8x）
export function isNightOffpeak(atMs) {
  const t = Number.isFinite(Number(atMs)) ? Number(atMs) : Date.now()
  const bj = new Date(t + 8 * 3600 * 1000)
  const hour = bj.getUTCHours()
  return hour >= 0 && hour < 8
}
