// 全厂商余额/套餐：复用同机挂件线已经在跑的服务，而不是在 dock 里再实现
// 35 家厂商的密钥发现、接口差异、缓存和签名校验。
//
// 挂件线的 /whale/vendors.json 已经是成熟数据源：它包含 DeepSeek 余额、
// GLM Plan 配额、CommandCode 三重额度、Kimi/MiniMax/OpenCode 订阅窗口、
// OpenRouter/Moonshot 余额，以及 26 家「官方没有余额接口」的模板。
//
// 这里只做三件事：
//   1. 在固定端口范围里找 app=zcode-fox-widget / fox-widget 的本机服务；
//   2. 读 /whale/vendors.json；
//   3. 把响应收敛成前端能安全消费的字段（去掉 keySource/keyMasked 等本机路径）。
//
// 只连 127.0.0.1/::1，端口来自白名单；不接受任意 URL。

const DEFAULT_PORTS = Array.from({ length: 10 }, (_, i) => 39321 + i)
const APP_TO_ADAPTER = {
  'zcode-fox-widget': 'zcode',
  'fox-widget': 'workbuddy',
}
const PROBE_TTL_MS = 10_000
const VENDOR_TTL_MS = 30_000
const probeCache = new Map() // port -> { at, value }
const vendorCache = new Map() // adapter -> { at, value }

export function _resetHostVendorCache() {
  probeCache.clear()
  vendorCache.clear()
}

export function vendorPorts(env = process.env) {
  const raw = String(env.FOX_DOCK_VENDOR_PORTS || '').trim()
  if (!raw) return DEFAULT_PORTS
  const list = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536)
  return list.length ? list : DEFAULT_PORTS
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function sanitizeWindow(w) {
  if (!w || typeof w !== 'object') return undefined
  const out = {
    used: num(w.used),
    cap: num(w.cap),
    remaining: num(w.remaining),
    percent: num(w.percent),
    resetAt: num(w.resetAt),
  }
  if (typeof w.exceeded === 'boolean') out.exceeded = w.exceeded
  return Object.values(out).some((x) => x !== undefined) ? out : undefined
}

function sanitizeVendor(v) {
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id) return null
  const out = {
    id: v.id.slice(0, 40),
    name: String(v.name || v.id).slice(0, 60),
    kind: String(v.kind || '').slice(0, 24),
    currency: String(v.currency || '').slice(0, 8),
    note: String(v.note || '').slice(0, 240),
    available: v.available === true,
    reason: String(v.reason || '').slice(0, 300),
    balance: num(v.balance),
    todayUsage: num(v.todayUsage),
    percentRemaining: num(v.percentRemaining),
    remaining: num(v.remaining),
    total: num(v.total),
    nextResetAt: num(v.nextResetAt),
    planName: String(v.planName || '').slice(0, 40),
    account: String(v.account || '').slice(0, 60),
    limited: v.limited === true,
    monthly: sanitizeWindow(v.monthly),
    fiveHour: sanitizeWindow(v.fiveHour),
    weekly: sanitizeWindow(v.weekly),
  }
  if (v.pool && typeof v.pool === 'object') {
    out.pool = {
      available: num(v.pool.available),
      total: num(v.pool.total),
      cooldownFree: num(v.pool.cooldownFree),
      kind: typeof v.pool.kind === 'string' ? v.pool.kind.slice(0, 12) : '',
    }
  }
  return out
}

async function probePort(port, { fetchImpl, nowMs, force }) {
  const hit = probeCache.get(port)
  if (!force && hit && nowMs - hit.at < PROBE_TTL_MS) return hit.value
  let value = null
  try {
    const res = await fetchImpl('http://127.0.0.1:' + port + '/whale/health', {
      signal: AbortSignal.timeout(1500),
    })
    if (res.ok) {
      const body = await res.json()
      const adapter = APP_TO_ADAPTER[String(body && body.app)]
      if (adapter) {
        value = {
          adapter,
          app: String(body.app),
          version: String(body.version || ''),
          port: Number(body.port) || port,
        }
      }
    }
  } catch (err) {}
  probeCache.set(port, { at: nowMs, value })
  return value
}

export async function listVendorServices(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch
  const nowMs = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const ports = opts.ports || vendorPorts(opts.env)
  const services = await Promise.all(ports.map((p) => probePort(p, { fetchImpl, nowMs, force: opts.force })))
  const out = []
  const seen = new Set()
  for (const s of services) {
    if (!s || seen.has(s.adapter)) continue
    seen.add(s.adapter)
    out.push(s)
  }
  return out.sort((a, b) => (a.adapter === 'zcode' ? -1 : b.adapter === 'zcode' ? 1 : 0))
}

// 返回 { ok, adapter, source, vendors, services } 或 { ok:false, reason, services }
export async function readHostVendors(adapter, opts = {}) {
  const wanted = String(adapter || '').slice(0, 20)
  const nowMs = typeof opts.now === 'function' ? opts.now() : Number(opts.now) || Date.now()
  const services = await listVendorServices(opts)
  const service = services.find((s) => s.adapter === wanted) || (wanted ? null : services[0])
  if (!service) {
    return {
      ok: false,
      adapter: wanted,
      reason: 'service-unavailable',
      error: wanted
        ? '没有找到 ' + wanted + ' 对应的挂件线服务（对应挂件未运行或端口不在白名单）'
        : '没有找到运行中的挂件线服务',
      services,
    }
  }

  const cacheKey = service.adapter + '|' + service.port
  const hit = vendorCache.get(cacheKey)
  if (!opts.force && hit && nowMs - hit.at < VENDOR_TTL_MS) return { ...hit.value, cached: true }

  let value
  try {
    const res = await (opts.fetchImpl || fetch)('http://127.0.0.1:' + service.port + '/whale/vendors.json', {
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) {
      value = {
        ok: false,
        adapter: service.adapter,
        source: service,
        services,
        reason: 'http',
        error: '挂件线厂商接口失败（HTTP ' + res.status + '）',
      }
    } else {
      const payload = await res.json()
      const vendors = Array.isArray(payload && payload.vendors)
        ? payload.vendors.map(sanitizeVendor).filter(Boolean)
        : []
      value = {
        ok: true,
        adapter: service.adapter,
        source: service,
        services,
        vendors,
      }
    }
  } catch (err) {
    value = {
      ok: false,
      adapter: service.adapter,
      source: service,
      services,
      reason: 'network',
      error: '读取挂件线厂商接口失败：' + String((err && err.message) || err).slice(0, 160),
    }
  }
  vendorCache.set(cacheKey, { at: nowMs, value })
  return value
}
