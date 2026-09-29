// 余额、今日已用、挂件配置状态。
// 上游 DSH 版把这些放在宿主插件的闭包里并通过 webServer 路由暴露；ZCode 版
// 放在独立进程的服务里，逻辑保持一致：25 秒缓存、瞬时失败回退旧值、
// 记账模式币种感知、跨天归档。
import fs from 'node:fs'
import path from 'node:path'
import {
  BALANCE_URL,
  USAGE_URL_BASE,
  assertSafeUpstream,
  findApiKey,
  findPlatformToken,
  readPluginConfig,
} from './credentials.mjs'
import { LEDGER_FILE, WIDGET_STATE_FILE } from './paths.mjs'
import { costOfUsage, isPeakTime, priceFor } from './pricing.mjs'

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
    return {
      ok: false,
      code: 'NO_KEY',
      error: '未找到 DeepSeek API Key：请设置环境变量 DEEPSEEK_API_KEY，或在 ZCode 里配置 DeepSeek provider，或用 /whale 命令写入插件配置。',
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
    return led
  }
  return { date: todayKey(), lastBalance: null, lastCurrency: '', todayUsage: 0, history: {} }
}

// 每次观测到余额后调用：余额下降即视为消费，充值不扣减。
// 币种切换时只重置基准不记差值——数值跳变来自币种切换，不是真实消费。
function recordLedgerUsage(currentBalance, currency) {
  const t = todayKey()
  const led = readLedger()
  const cur = String(currency || '')
  const currencyChanged =
    typeof led.lastCurrency === 'string' && led.lastCurrency !== '' && cur !== '' && led.lastCurrency !== cur

  if (led.date !== t) {
    if (led.date && typeof led.todayUsage === 'number') {
      led.history[led.date] = led.todayUsage
    }
    led.date = t
    led.lastBalance = currentBalance
    led.lastCurrency = cur
    led.todayUsage = 0
  } else if (currencyChanged) {
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  } else {
    const prev = typeof led.lastBalance === 'number' ? led.lastBalance : currentBalance
    if (typeof prev === 'number' && typeof currentBalance === 'number' && currentBalance < prev) {
      led.todayUsage = (typeof led.todayUsage === 'number' ? led.todayUsage : 0) + (prev - currentBalance)
    }
    led.lastBalance = currentBalance
    led.lastCurrency = cur
  }
  const keys = Object.keys(led.history).sort()
  while (keys.length > LEDGER_HISTORY_KEEP) delete led.history[keys.shift()]
  writeJsonFile(LEDGER_FILE, led)
  return led
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

async function fetchPlatformUsage() {
  const { token, source } = findPlatformToken()
  if (!token) return { error: 'no platform token', source }
  const now = new Date()
  const tz = -now.getTimezoneOffset() * 60
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
  const end = start + 86400
  const raw = USAGE_URL_BASE + '?start=' + start + '&end=' + end + '&tz=' + tz
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
  alerts: { planPct: 0, deepseekBelow: 0, bigmodelDaily: 0 },
}

function normalizeAlerts(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const pick = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0)
  return {
    planPct: Math.min(100, pick(src.planPct)),
    deepseekBelow: pick(src.deepseekBelow),
    bigmodelDaily: pick(src.bigmodelDaily),
  }
}

function normalizeUsageMode(m) {
  return m === 'token' ? 'token' : 'ledger'
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
    soundSet: raw.soundSet === 'fx1' ? 'fx1' : 'duck',
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
    alerts: normalizeAlerts(raw.alerts),
  }
}

export function writeWidgetState(patch) {
  const current = readWidgetState()
  const next = { ...current }
  if (typeof patch.scale === 'number') next.scale = Math.min(2.5, Math.max(0.6, patch.scale))
  if (typeof patch.sound === 'boolean') next.sound = patch.sound
  if (typeof patch.vol === 'number') next.vol = Math.min(1, Math.max(0, patch.vol))
  if (patch.soundSet === 'fx1' || patch.soundSet === 'duck') next.soundSet = patch.soundSet
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
  if (patch.alerts && typeof patch.alerts === 'object') {
    next.alerts = normalizeAlerts({ ...next.alerts, ...patch.alerts })
  }
  next.updatedAt = new Date().toISOString()
  const ok = writeJsonFile(WIDGET_STATE_FILE, next)
  return ok ? next : { ...next, persistError: '无法持久化挂件状态' }
}

// ---------- 组合载荷（带缓存与瞬时失败回退） ----------

let balanceCache = null
let balanceInFlight = null

async function getBalancePayload() {
  const payload = await fetchBalance()
  if (!payload.ok) return payload

  // 不论哪种用量模式，都先把这次余额观测记进账本，记账数据持续累积
  const led = recordLedgerUsage(Number(payload.totalBalance), payload.currency)
  const mode = readWidgetState().usageMode
  const full = { ...payload, isPeak: isPeakTime(Math.floor(Date.now() / 1000)) }

  if (mode === 'token') {
    const u = await fetchPlatformUsage()
    if (u && u.amount !== undefined) {
      full.todayUsage = u.amount
      full.usageMode = 'token'
      return full
    }
    // 无令牌或令牌失效：回落记账模式，并说明原因
    full.usageMode = 'ledger'
    full.usageFallback = u && u.error ? u.error : 'platform token unavailable'
    full.todayUsage = led.todayUsage
    return full
  }
  full.todayUsage = led.todayUsage
  full.usageMode = 'ledger'
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
