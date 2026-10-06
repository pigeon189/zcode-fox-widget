// 余额、今日已用、挂件配置状态。
// 上游 DSH 版把这些放在宿主插件的闭包里并通过 webServer 路由暴露；ZCode 版
// 放在独立进程的服务里，逻辑保持一致：25 秒缓存、瞬时失败回退旧值、
// 记账模式币种感知、跨天归档。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  BALANCE_URL,
  USAGE_URL_BASE,
  assertSafeUpstream,
  findApiKey,
  describeKeyProbe,
  findPlatformToken,
  readPluginConfig,
} from './credentials.mjs'
import { BUILTIN_ROLE_RENAMES, LEDGER_FILE, WIDGET_STATE_FILE } from './paths.mjs'
import { costOfUsage, isPeakTime, priceFor } from './pricing.mjs'
import { todayVendorUsage } from './usage-records.mjs'

const BALANCE_TTL_MS = 25000
const LEDGER_HISTORY_KEEP = 30

function readJsonFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    // 内容损坏（写入被截断等）：把原文件隔离改名，避免每次读到坏数据，
    // 也保住现场供手工恢复——而不是静默重置丢掉历史。
    try {
      fs.renameSync(file, file + '.corrupt-' + Date.now())
    } catch (err2) {}
    return null
  }
}

function writeJsonFile(file, obj) {
  let tmp = ''
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 原子写：先写临时文件再 rename，进程被杀时不会留下半个 JSON
    tmp = file + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    try {
      if (tmp) fs.rmSync(tmp, { force: true })
    } catch (err2) {}
    return false
  }
}

// 接口返回的多币种数组顺序不固定，不能直接取 [0]：优先 CNY 且余额 > 0，
// 其次任意非零项，再退回 CNY 项，最后才取第一项。
export function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null
  const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
  return (
    infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
    infos.find((x) => num(x) > 0) ||
    infos.find((x) => x && x.currency === 'CNY') ||
    infos[0]
  )
}

export async function fetchBalance() {
  const { key, source } = findApiKey()
  if (!key) {
    // 文案保持一屏内可读；逐条探测明细放 probe 字段（health/CLI 排查用）
    const probe = describeKeyProbe()
    const enc = probe.entries.filter((e) => e.keyEncrypted).length
    const local = probe.entries.filter((e) => e.isLocal).length
    return {
      ok: false,
      code: 'NO_KEY',
      error:
        '未找到 DeepSeek API Key。已探测环境变量、插件配置与 ZCode provider 配置' +
        (probe.entries.length ? '（发现 ' + probe.entries.length + ' 个 provider' + (local ? '，' + local + ' 个本地网关已跳过' : '') + (enc ? '，' + enc + ' 个加密凭据无法解密' : '') + '）' : '（未发现任何 provider）') +
        '。请在 ZCode 里配置 baseURL 指向 api.deepseek.com 的 DeepSeek provider，或用 /whale 命令写入插件配置。',
      probe,
    }
  }
  // 出站地址先过白名单校验，失败直接返回结构化错误（不发请求）。
  try {
    assertSafeUpstream(BALANCE_URL)
  } catch (err) {
    return { ok: false, code: 'UNSAFE_URL', error: String((err && err.message) || err) }
  }

  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(20000),
      })
    } catch (err) {
      lastErr = err
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
      continue
    }
    if (!res.ok) {
      lastErr = new Error('HTTP ' + res.status)
      if (res.status < 500) break // 4xx 不重试（多为 key 无效/权限问题）
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
      continue
    }
    let data
    try {
      data = await res.json()
    } catch (err) {
      return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
    }
    const info = pickBalanceInfo(data && data.balance_infos)
    if (!info || info.total_balance === undefined) {
      return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
    }
    return {
      ok: true,
      totalBalance: Number(info.total_balance),
      currency: String(info.currency || 'CNY'),
      keySource: source,
      updatedAt: new Date().toISOString(),
    }
  }
  const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
  return {
    ok: false,
    code: 'HTTP',
    transient,
    error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
  }
}

// ---------- 记账模式 ----------

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function readLedger() {
  const led = readJsonFile(LEDGER_FILE)
  if (led && typeof led.date === 'string') {
    if (typeof led.lastCurrency !== 'string') led.lastCurrency = ''
    if (!led.history || typeof led.history !== 'object') led.history = {}
    if (!Array.isArray(led.previousBooks)) led.previousBooks = []
    if (typeof led.credits !== 'number') led.credits = 0
    if (typeof led.otherDebits !== 'number') led.otherDebits = 0
    if (typeof led.pendingCredit !== 'number') led.pendingCredit = 0
    led.needsReview = led.needsReview === true
    return led
  }
  return {
    date: todayKey(),
    lastBalance: null,
    lastCurrency: '',
    todayUsage: 0,
    history: {},
    keyFingerprint: '',
    dayOpening: null,
    credits: 0,
    otherDebits: 0,
    correctedAt: null,
    pendingCredit: 0,
    needsReview: false,
    previousBooks: [],
  }
}

// 当日消费口径：做过余额校正用「起点 + 累计到账 − 非调用扣减 − 当前余额」，
// 否则用观测累计值。与上游 DSH 版的校正公式一致。
function effectiveTodayUsage(led) {
  if (
    Number(led.correctedAt) > 0 &&
    typeof led.dayOpening === 'number' &&
    typeof led.lastBalance === 'number'
  ) {
    return Math.max(0, led.dayOpening + (Number(led.credits) || 0) - (Number(led.otherDebits) || 0) - led.lastBalance)
  }
  return typeof led.todayUsage === 'number' ? led.todayUsage : 0
}

// 当前 key 的指纹（sha256 前 12 位）：换 key 等于换账户，账本要分本
function keyFingerprint() {
  const { key } = findApiKey()
  if (!key) return ''
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)
}

function freshDay(led, currentBalance, cur) {
  led.date = todayKey()
  led.lastBalance = currentBalance
  led.lastCurrency = cur
  led.todayUsage = 0
  led.dayOpening = currentBalance
  led.credits = 0
  led.otherDebits = 0
  led.correctedAt = null
  led.pendingCredit = 0
  led.needsReview = false
}

// 每次观测到余额后调用：余额下降即视为消费；上升（充值/赠金）不冲减消费、
// 标记「待核对余额调整」，等用户用余额校正把实际到账金额补进来。
// 币种切换/换 key 都只重置基准不记差值——数值跳变不是真实消费。
function recordLedgerUsage(currentBalance, currency) {
  const t = todayKey()
  const led = readLedger()
  const cur = String(currency || '')
  const fp = keyFingerprint()
  const currencyChanged =
    typeof led.lastCurrency === 'string' && led.lastCurrency !== '' && cur !== '' && led.lastCurrency !== cur
  const keyChanged =
    typeof led.keyFingerprint === 'string' && led.keyFingerprint !== '' && fp !== '' && led.keyFingerprint !== fp

  // 换 key：旧账整本归档（数据不丢、不与新账户混算），新起一本
  if (keyChanged) {
    led.previousBooks.push({ fingerprint: led.keyFingerprint, history: led.history || {}, archivedAt: Date.now() })
    while (led.previousBooks.length > 5) led.previousBooks.shift()
    led.history = {}
    freshDay(led, currentBalance, cur)
    led.keyFingerprint = fp
    writeJsonFile(LEDGER_FILE, led)
    return led
  }
  if (fp) led.keyFingerprint = fp

  if (led.date !== t) {
    if (led.date && typeof led.todayUsage === 'number') {
      led.history[led.date] = effectiveTodayUsage(led)
    }
    freshDay(led, currentBalance, cur)
  } else if (currencyChanged) {
    led.lastBalance = currentBalance
    led.lastCurrency = cur
    led.dayOpening = currentBalance
  } else {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
    if (typeof prev === 'number' && typeof currentBalance === 'number') {
      if (currentBalance < prev) {
        led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
      } else if (currentBalance > prev) {
        led.pendingCredit = (typeof led.pendingCredit === 'number' ? led.pendingCredit : 0) + (currentBalance - prev)
        led.needsReview = true
      }
    }
    led.lastBalance = currentBalance
    led.lastCurrency = cur
    if (typeof led.dayOpening !== 'number') led.dayOpening = currentBalance
  }
  const keys = Object.keys(led.history).sort()
  while (keys.length > LEDGER_HISTORY_KEEP) delete led.history[keys.shift()]
  writeJsonFile(LEDGER_FILE, led)
  return led
}

// 余额校正：GET 的汇总与 POST 的落账共用（仅 DeepSeek 观测账本有意义）。
export function balanceAdjustmentSummary() {
  const led = readLedger()
  return {
    ok: true,
    date: led.date,
    currency: led.lastCurrency || 'CNY',
    dayOpening: typeof led.dayOpening === 'number' ? led.dayOpening : null,
    lastBalance: typeof led.lastBalance === 'number' ? led.lastBalance : null,
    observedDecrease:
      typeof led.dayOpening === 'number' && typeof led.lastBalance === 'number'
        ? Math.max(0, led.dayOpening - led.lastBalance)
        : null,
    credits: Number(led.credits) || 0,
    otherDebits: Number(led.otherDebits) || 0,
    pendingCredit: Number(led.pendingCredit) || 0,
    needsReview: led.needsReview === true,
    hasBook: led.keyFingerprint !== '' || led.lastBalance !== null,
    todayUsage: effectiveTodayUsage(led),
  }
}

export function applyBalanceCorrection(credits, otherDebits) {
  const c = Number(credits)
  const od = Number(otherDebits)
  if (!Number.isFinite(c) || c < 0 || !Number.isFinite(od) || od < 0) {
    return { ok: false, error: '金额须为非负数' }
  }
  const led = readLedger()
  led.credits = c
  led.otherDebits = od
  led.correctedAt = Date.now()
  led.pendingCredit = 0
  led.needsReview = false
  led.todayUsage = effectiveTodayUsage(led)
  writeJsonFile(LEDGER_FILE, led)
  return balanceAdjustmentSummary()
}

// ---------- 实时·令牌模式的平台用量 ----------

// 平台用量接口只返回 token 分桶、不返回金额，需要按峰谷定价自行换算。
// 响应结构：data.biz_data.series[] = { model, buckets: [{ time, usage: {...} }] }
export function computeTodayUsage(data) {
  let d = data
  if (d && d.data && d.data.biz_data && Array.isArray(d.data.biz_data.series)) d = d.data.biz_data
  else if (d && d.data && Array.isArray(d.data.series)) d = d.data
  const series = Array.isArray(d && d.series) ? d.series : null
  if (!series || series.length === 0) return null

  let cost = 0
  let tokens = 0
  let found = false
  for (const s of series) {
    if (!s || typeof s !== 'object') continue
    const p = priceFor(s.model)
    const buckets = Array.isArray(s.buckets) ? s.buckets : []
    for (const b of buckets) {
      const u = b && b.usage
      if (!u || typeof u !== 'object') continue
      const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0
      const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0
      const out = Number(u.RESPONSE_TOKEN) || 0
      if (hit + miss + out === 0) continue
      found = true
      tokens += hit + miss + out
      const idx = isPeakTime(b.time) ? 1 : 0
      cost += (hit / 1e6) * p.hit[idx] + (miss / 1e6) * p.miss[idx] + (out / 1e6) * p.out[idx]
    }
  }
  return found ? { amount: cost, tokens } : null
}

// 平台用量接口的 URL（纯函数，供测试钉住 start/end/tz 语义）：start=当日零点
// （秒）、end=次日零点、tz=时区偏移秒数（东八区 +28800）。
export function platformUsageUrl(startSec, endSec, tzSec) {
  return USAGE_URL_BASE + '?start=' + Math.floor(startSec) + '&end=' + Math.floor(endSec) + '&tz=' + Math.floor(tzSec)
}

async function fetchPlatformUsage() {
  const { token, source } = findPlatformToken()
  if (!token) return { error: 'no platform token', source }
  const now = new Date()
  const tz = -now.getTimezoneOffset() * 60
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
  const end = start + 86400
  const raw = platformUsageUrl(start, end, tz)
  try {
    assertSafeUpstream(raw)
  } catch (err) {
    return { error: String((err && err.message) || err), source }
  }
  try {
    const res = await fetch(raw, {
      headers: { Authorization: 'Bearer ' + token.replace(/^Bearer\s+/i, '') },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { error: 'http ' + res.status, source }
    const u = computeTodayUsage(await res.json())
    if (u && isFinite(u.amount)) return { amount: u.amount, tokens: u.tokens, source }
    return { error: 'no usage', source }
  } catch (err) {
    return { error: String((err && err.message) || err), source }
  }
}

// ---------- 挂件状态（尺寸/音效/菜单开关） ----------

const WIDGET_DEFAULTS = {
  scale: 1.5,
  sound: true,
  vol: 0.9,
  soundSet: 'duck',
  peakMode: 'default',
  bubbleOn: true,
  turnCostOn: true,
  turnCostCloseMs: 5000,
  scrollGapOn: false,
  scrollGapPx: 17,
  petMode: false,
  alerts: { quotaPct: 0, moneyAlert: 0 },
}

// 预警阈值：**额度** 与 **金额** 两条泛化规则（v1.8.0 起）。
//   · quotaPct ——「额度预警」：对每个能读出「还剩多少额度」的来源生效（GLM Plan
//     剩余% / CommandCode 三重窗口），判定一律是「剩余比例低于该值」；各来源用
//     自己的单位表达同一件事（CommandCode 卡片上的已用进度 → 换算成剩余）。
//     取代 v1.7.8 的 planPct + cmdgoPct 两条专用阈值：旧配置里若只设过其中一条，
//     读取时原样折入（两者语义本就相同），只设过 cmdgoPct 的用户也因此不再丢设置。
//   · moneyAlert —— 原 DS（deepseekBelow）/ BM（bigmodelDaily）两个阈值合并而来，
//     对所有按金额结算的源生效（余额型看「低于」，消费型看「达到」）。
function normalizeAlerts(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const pick = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0)
  return {
    quotaPct: Math.min(100, pick(src.quotaPct) || pick(src.planPct) || pick(src.cmdgoPct)),
    moneyAlert: pick(src.moneyAlert) || pick(src.deepseekBelow) || pick(src.bigmodelDaily),
  }
}

function normalizeUsageMode(m) {
  return m === 'token' ? 'token' : 'ledger'
}

// 内置角色 id 形状收敛 + 曾用名归一（见 paths.mjs BUILTIN_ROLE_RENAMES）
function normalizeRoleId(v) {
  if (typeof v !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(v)) return null
  return BUILTIN_ROLE_RENAMES[v] || v
}

export function readWidgetState() {
  const raw = readJsonFile(WIDGET_STATE_FILE) || {}
  const fallbackMode = normalizeUsageMode(readPluginConfig().usageMode)
  const peakMode =
    raw.peakMode === 'liangwen' || raw.peakMode === 'qiangqiang' ? raw.peakMode : 'default'
  return {
    scale: typeof raw.scale === 'number' ? Math.min(2.5, Math.max(0.6, raw.scale)) : WIDGET_DEFAULTS.scale,
    sound: raw.sound !== false,
    vol: typeof raw.vol === 'number' ? Math.min(1, Math.max(0, raw.vol)) : WIDGET_DEFAULTS.vol,
    // 音效集 id：内置 duck/fx1，或导入集（s+hex）；统一按 id 形状收敛，
    // 别把未知值写成选中项（否则回放 404、挂件静音）
    soundSet:
      typeof raw.soundSet === 'string' && /^[a-z0-9_-]{1,40}$/.test(raw.soundSet) ? raw.soundSet : 'duck',
    usageMode: typeof raw.usageMode === 'string' ? normalizeUsageMode(raw.usageMode) : fallbackMode,
    peakMode,
    bubbleOn: raw.bubbleOn !== false,
    turnCostOn: raw.turnCostOn !== false,
    turnCostCloseMs:
      typeof raw.turnCostCloseMs === 'number' && raw.turnCostCloseMs >= 0
        ? raw.turnCostCloseMs
        : WIDGET_DEFAULTS.turnCostCloseMs,
    scrollGapOn: raw.scrollGapOn === true,
    scrollGapPx:
      typeof raw.scrollGapPx === 'number' && raw.scrollGapPx > 0
        ? Math.round(raw.scrollGapPx)
        : WIDGET_DEFAULTS.scrollGapPx,
    // 桌宠模式（浮层显隐策略：失焦不隐身 + 重申置顶），默认关
    petMode: raw.petMode === true,
    // 隐藏菜单按钮（移植 DSH：按钮不出现，右键角色唤出菜单），默认关
    menuBtnHide: raw.menuBtnHide === true,
    alerts: normalizeAlerts(raw.alerts),
    // 内置角色 id 曾用名（xiaohuniang→fox）：旧 widget-state 读取时归一，
    // 写回时自然是新 id，不需要一次性迁移文件
    roleId: normalizeRoleId(raw.roleId),
    theme: raw.theme === 'dark' || raw.theme === 'system' ? raw.theme : 'light',
    // 气泡 hint 跟随哪个计费源（智能切换的手动覆盖；'auto' = 跟随会话选择）
    displayMode: ['auto', 'plan', 'cmdgo', 'glm', 'ds'].indexOf(raw.displayMode) !== -1 ? raw.displayMode : 'auto',
  }
}

export function writeWidgetState(patch) {
  const current = readWidgetState()
  const next = { ...current }
  if (typeof patch.scale === 'number') next.scale = Math.min(2.5, Math.max(0.6, patch.scale))
  if (typeof patch.sound === 'boolean') next.sound = patch.sound
  if (typeof patch.vol === 'number') next.vol = Math.min(1, Math.max(0, patch.vol))
  // 音效集 id：内置或导入集，按 id 形状收（与 soundSet 读取口径一致）
  if (typeof patch.soundSet === 'string' && /^[a-z0-9_-]{1,40}$/.test(patch.soundSet)) {
    next.soundSet = patch.soundSet
  }
  if (typeof patch.usageMode === 'string') next.usageMode = normalizeUsageMode(patch.usageMode)
  if (patch.peakMode === 'liangwen' || patch.peakMode === 'qiangqiang' || patch.peakMode === 'default') {
    next.peakMode = patch.peakMode
  }
  if (typeof patch.bubbleOn === 'boolean') next.bubbleOn = patch.bubbleOn
  if (typeof patch.turnCostOn === 'boolean') next.turnCostOn = patch.turnCostOn
  if (typeof patch.turnCostCloseMs === 'number' && patch.turnCostCloseMs >= 0) {
    next.turnCostCloseMs = Math.round(patch.turnCostCloseMs)
  }
  if (typeof patch.scrollGapOn === 'boolean') next.scrollGapOn = patch.scrollGapOn
  if (typeof patch.scrollGapPx === 'number' && patch.scrollGapPx >= 0) {
    next.scrollGapPx = Math.round(patch.scrollGapPx)
  }
  if (typeof patch.petMode === 'boolean') next.petMode = patch.petMode
  if (patch.alerts && typeof patch.alerts === 'object') {
    next.alerts = normalizeAlerts({ ...next.alerts, ...patch.alerts })
  }
  if (patch.roleId === null) next.roleId = null
  else if (typeof patch.roleId === 'string' && /^[a-z0-9_-]{1,40}$/.test(patch.roleId)) next.roleId = patch.roleId
  if (patch.theme === 'dark' || patch.theme === 'light' || patch.theme === 'system') next.theme = patch.theme
  if (['auto', 'plan', 'cmdgo', 'glm', 'ds'].indexOf(patch.displayMode) !== -1) next.displayMode = patch.displayMode
  // 隐藏菜单按钮（移植 DSH）：开启后挂件上的菜单按钮不再出现，改由右键鲸鱼唤出菜单
  if (typeof patch.menuBtnHide === 'boolean') next.menuBtnHide = patch.menuBtnHide
  next.updatedAt = new Date().toISOString()
  const ok = writeJsonFile(WIDGET_STATE_FILE, next)
  return ok ? next : { ...next, persistError: '无法持久化挂件状态' }
}

// ---------- 组合载荷（带缓存与瞬时失败回退） ----------

let balanceCache = null
let balanceInFlight = null

// ---------- 今日已用的口径合并 ----------
//
// 主口径 = **本机库**（ZCode model_usage 按模型/厂商价目折算，见 usage-records）：
// 它按模型看得见、不受充值干扰；账号口径（小鲸鱼记账 / 实时·令牌）退居两件事——
//   1. 对账：两个数字都显示，差异一眼可见（含其它设备/其它 key 的花费只有它看得到）；
//   2. 兜底：本机库今天没有记录时（别的设备在花、或库里没数据）显示账号口径。
// 纯函数抽出供测试直接断言，getBalancePayload 只负责取数后调它。
//
//   db     本机口径 { hasRows, amount, tokens, currency }（todayVendorUsage 的结果）
//   account 账号口径 { amount, source }（source: 'ledger' | 'token'）
export function resolveTodayUsage(db, account) {
  const accAmount = account && typeof account.amount === 'number' && isFinite(account.amount) ? account.amount : null
  const accSource = account && account.source === 'token' ? 'token' : 'ledger'
  const dbHasRows = !!(db && db.hasRows && typeof db.amount === 'number' && isFinite(db.amount))
  const out = {
    todayUsage: dbHasRows ? db.amount : accAmount,
    todayUsageSource: dbHasRows ? 'db' : accAmount === null ? null : accSource,
    todayUsageDb: dbHasRows ? db.amount : null,
    todayUsageDbTokens: dbHasRows ? (db.tokens || 0) : null,
    accountUsage: accAmount,
    accountUsageSource: accAmount === null ? null : accSource,
  }
  return out
}

async function getBalancePayload() {
  const payload = await fetchBalance()
  if (!payload.ok) return payload

  // 不论哪种用量模式，都先把这次余额观测记进账本，记账数据持续累积
  const led = recordLedgerUsage(Number(payload.totalBalance), payload.currency)
  const mode = readWidgetState().usageMode
  const full = { ...payload, isPeak: isPeakTime(Math.floor(Date.now() / 1000)) }

  // 账号口径（对账 + 兜底）：usageMode 选「实时·令牌」就走平台用量接口，
  // 拿不到就回落小鲸鱼记账；「小鲸鱼记账」直接用账本。
  let accountAmount = effectiveTodayUsage(led)
  let accountSource = 'ledger'
  if (mode === 'token') {
    const u = await fetchPlatformUsage()
    if (u && u.amount !== undefined) {
      accountAmount = u.amount
      accountSource = 'token'
    } else {
      // 无令牌或令牌失效：回落记账模式，并说明原因
      full.usageFallback = u && u.error ? u.error : 'platform token unavailable'
    }
  }

  // 本机口径（主口径）：本机库当天 DeepSeek 计费行的合计
  const db = todayVendorUsage('DeepSeek')
  Object.assign(full, resolveTodayUsage(db, { amount: accountAmount, source: accountSource }))
  full.usageMode = mode === 'token' ? 'token' : 'ledger'
  return full
}

export function getBalance() {
  const now = Date.now()
  if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) {
    return Promise.resolve(balanceCache.payload)
  }
  if (balanceInFlight) return balanceInFlight
  balanceInFlight = getBalancePayload()
    .then((payload) => {
      if (payload.ok) {
        balanceCache = { at: Date.now(), payload }
        return payload
      }
      // 网络抖动/5xx：继续返回上一次成功的余额，挂件不闪错误
      if (payload.transient && balanceCache) {
        return { ...balanceCache.payload, stale: true, error: payload.error }
      }
      return payload
    })
    .catch((err) => ({
      ok: false,
      code: 'ERROR',
      error: '余额服务异常: ' + String((err && err.message) || err).slice(0, 200),
    }))
    .finally(() => {
      balanceInFlight = null
    })
  return balanceInFlight
}

// 切用量模式时让缓存立即失效，下一次请求按新模式计算
export function invalidateBalanceCache() {
  balanceCache = null
}

export { costOfUsage }
