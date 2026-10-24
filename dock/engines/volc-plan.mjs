// 火山方舟个人版 Coding / Agent Plan 配额：按套餐分别查询，不跨套餐回退。
// 迁移自 1.x 线 lib/volc-plan.mjs（v1.16.1，2026-10-19 官方核实），签名与塑形
// 是逐函数移植（含固定向量锁定的 V4 签名）；差异只在凭据链与出站校验按 dock 2.0
// 的边界重做：环境变量 → dock 保险库（DPAPI）→ 旧挂件配置导入（D022）。
//
// Coding 给百分比，Agent 给 AFP 总量与已用量；鉴权必须用 IAM Access Key
//（AKLT…）做 V4 签名，模型调用用的 Coding Plan Key（ark-…）不能用于这里。
// 两条取数路径：
//   Coding Plan（个人版，无需先拿席位）：
//     POST https://ark.cn-beijing.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01
//     body {} -> Result.QuotaUsage[]（Level / Percent / ResetTimestamp 秒）
//   Agent Plan（个人版，GetAFPUsage 官方契约）：
//     POST .../?Action=GetAFPUsage&Version=2024-01-01
//     body {} -> Result.AFPFiveHour / AFPDaily / AFPWeekly / AFPMonthly（Quota / Used / ResetTime）
//   席位版 GetSeatInfoUsage 需先 ListSeatInfos 拿 SeatID（两跳、字段未见实测），暂不覆盖。
//   成功但无有效窗口 -> no-data，绝不把未知用量补成已用 0% / 剩余 100%。
//
// 签名：HMAC-SHA256 V4（region=cn-beijing、service=ark），node:crypto 手写，
// 与火山官方 V4 参考实现及 ZnonEn/dsh-volcark-quota（BSD-3）逐步对照；签名
// 部分导出为纯函数（volcengineSign 接受 now 注入），单测用固定向量锁定。
// 本机时间偏差超过 15 分钟时网关回 InvalidTimestamp，单独映射成可读提示。
//
// 每凭据 45s TTL，失败同样计入 TTL（坏凭据不被轮询打爆）；AK/SK 只进签名，
// 不落盘、不进日志，界面只显示来源与掩码。
import { createHash, createHmac } from 'node:crypto'
import https from 'node:https'
import { assertSafeUpstream, getVaultKey, maskKey, readPluginConfig } from './credentials.mjs'

// 域名：官方文档给本接口家族（GetCodingPlanUsage / GetAFPUsage / GetSeatInfoUsage…）
// 的是 ark 专属域名；open.volcengineapi.com 是火山通用 OpenAPI 网关，同 service=ark
// 也能路由到同一套服务（社区工具实测可用），但 2026-10-19 官方核实建议优先用
// ark 专属域名，签名 Host 头与之一致。
const VOLC_HOST = 'ark.cn-beijing.volcengineapi.com'
const VOLC_REGION = 'cn-beijing'
const VOLC_SERVICE = 'ark'
const VOLC_VERSION = '2024-01-01'
const TTL_MS = 45_000
const TIMEOUT_MS = 10_000

export const VOLC_CRED_HINT =
  '未配置火山 IAM AK/SK（订阅配额查询不能用模型调用的 ark- key）：环境变量 VOLC_ACCESS_KEY_ID / VOLC_ACCESS_KEY_SECRET，或保险库 volc-access-key-id / volc-access-key-secret'

const num = (v) => {
  // 显式 null（JSON 里字段存在但值为 null）不能吞成 0：未知用量不能伪装成剩余 100%
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && !v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 官方要求的 X-Date 格式：yyyyMMdd'T'HHmmss'Z'（UTC，例如 20261019T080905Z）。 */
export function formatXDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    d.getUTCFullYear() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    'T' +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    'Z'
  )
}

/** 查询串按参数名排序 + 组件编码（V4 CanonicalQueryString）。 */
export function normQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&')
}

// Volcengine OpenAPI V4 签名（HMAC-SHA256）。now 接受 Date / 毫秒（测试注入，
// 杜绝测试依赖真时钟）；返回携带 Authorization 的完整请求头。
// 必签头：host、content-type、x- 开头的头（x-date、x-content-sha256），全小写排序。
export function volcengineSign(ak, sk, method, pathName, query, body, now) {
  const d = now instanceof Date ? now : new Date(typeof now === 'number' ? now : Date.now())
  const xDate = formatXDate(d)
  const xDateShort = xDate.slice(0, 8)
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex')
  const rawHeaders = {
    Host: VOLC_HOST,
    'X-Date': xDate,
    'X-Content-Sha256': bodyHash,
    'Content-Type': 'application/json',
  }
  const signed = {}
  for (const [k, v] of Object.entries(rawHeaders)) {
    const lk = k.toLowerCase()
    if (lk === 'content-type' || lk === 'host' || lk.startsWith('x-')) signed[lk] = v
  }
  const shKeys = Object.keys(signed).sort()
  const signedStr = shKeys.map((k) => `${k}:${signed[k]}\n`).join('')
  const sh = shKeys.join(';')

  const canonicalRequest = [method, pathName, normQuery(query), signedStr, sh, bodyHash].join('\n')
  const credentialScope = `${xDateShort}/${VOLC_REGION}/${VOLC_SERVICE}/request`
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n')

  const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest()
  const kDate = hmac(sk, xDateShort)
  const kRegion = hmac(kDate, VOLC_REGION)
  const kService = hmac(kRegion, VOLC_SERVICE)
  const kSigning = hmac(kService, 'request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  return {
    ...rawHeaders,
    Authorization: `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${sh}, Signature=${signature}`,
  }
}

// 网关错误 -> 稳定 reason。InvalidTimestamp（本机偏差 > 15 分钟）单独映射成
// 可读提示；401/403 与签名类错误归 invalid-credentials；404 归 not-subscribed。
export function classifyVolcError({ status, code, message }) {
  const c = String(code || '')
  if (c.indexOf('Timestamp') !== -1) {
    return { reason: 'clock-skew', message: '本机时间偏差超过 15 分钟（InvalidTimestamp），校准系统时钟后重试' }
  }
  if (status === 401 || status === 403 || /Auth|Signature|AccessKey|Forbidden/i.test(c)) {
    return { reason: 'invalid-credentials', message: 'IAM 凭据无效或无权限（' + (c || 'HTTP ' + status) + '）' }
  }
  if (status === 404 || /NotFound|NotSubscribed/i.test(c)) {
    return { reason: 'not-subscribed', message: '未订阅/无数据' }
  }
  return { reason: c || 'HTTP ' + (status || '?'), message: String(message || '') || '火山方舟请求失败' }
}

// Coding Plan 响应的 Level -> 归一窗口名（作者口径 '5h'|'week'|'month'）+ 中文标签。
// 参考实现见过的取值：'5h'/'session'（5 小时）、'weekly'、'monthly'、'daily'、'plan'；
// 未知取值原样保留（显示层用 label 兜底）。
export function volcWindowMeta(level) {
  const key = String(level ?? '').trim().toLowerCase()
  if (key === '5h' || key === 'session') return { name: '5h', label: '5小时' }
  if (key === 'weekly') return { name: 'week', label: '本周' }
  if (key === 'monthly') return { name: 'month', label: '本月' }
  if (key === 'daily') return { name: 'daily', label: '今日' }
  return { name: key || 'plan', label: key || '套餐' }
}

const WINDOW_ORDER = { '5h': 0, daily: 1, week: 2, month: 3 }

function pctWindow(usedPct, resetAtMs) {
  const used = Math.max(0, Math.min(100, num(usedPct) ?? 0))
  return {
    usedPct: used,
    remainingPct: Math.max(0, 100 - used),
    exceeded: used >= 100,
    resetAt: resetAtMs && resetAtMs > 0 ? resetAtMs : null,
  }
}

// Coding Plan 主路径塑形：Result.QuotaUsage[]（Level / Percent / ResetTimestamp 秒）
export function shapeVolcCoding(result) {
  const root = result && typeof result === 'object' ? result : {}
  const list = Array.isArray(root.QuotaUsage) ? root.QuotaUsage : []
  const windows = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const usedPct = num(item.Percent)
    if (usedPct === null) continue
    const meta = volcWindowMeta(item.Level)
    const resetSec = num(item.ResetTimestamp)
    windows.push({ ...meta, ...pctWindow(usedPct, resetSec != null ? resetSec * 1000 : null) })
  }
  return windows.length ? { planType: 'coding', windows } : null
}

// Agent Plan 个人版塑形：Result.AFPFiveHour / AFPDaily / AFPWeekly / AFPMonthly（Quota / Used / ResetTime）
export function shapeVolcAfp(result) {
  const root = result && typeof result === 'object' ? result : {}
  const keys = [
    ['5h', 'AFPFiveHour'],
    ['daily', 'AFPDaily'],
    ['week', 'AFPWeekly'],
    ['month', 'AFPMonthly'],
  ]
  const windows = []
  for (const [name, key] of keys) {
    const item = root[key]
    if (!item || typeof item !== 'object') continue
    const quota = num(item.Quota)
    const used = num(item.Used)
    if (quota === null || quota <= 0 || used === null || used < 0) continue
    const usedPct = (used / quota) * 100
    const resetMs = num(item.ResetTime)
    windows.push({
      name,
      label: { '5h': '5小时', daily: '近一天', week: '近一周', month: '近一月' }[name],
      ...pctWindow(usedPct, resetMs != null && resetMs > 1e12 ? resetMs : resetMs != null ? resetMs * 1000 : null),
    })
  }
  return windows.length ? { planType: 'agent', windows } : null
}

function sortWindows(windows) {
  return windows.slice().sort((a, b) => (WINDOW_ORDER[a.name] ?? 9) - (WINDOW_ORDER[b.name] ?? 9))
}

function callVolc(ak, sk, action) {
  const query = { Action: action, Version: VOLC_VERSION }
  const body = '{}'
  const headers = volcengineSign(ak, sk, 'POST', '/', query, body)
  // 出站校验：host 是本文件的独立常量白名单（不是从 URL 现算），复用
  // assertSafeUpstream 的全部规则（https、拒环回/私有/保留 IP、拒 user:pass）。
  const url = assertSafeUpstream(`https://${VOLC_HOST}/?${normQuery(query)}`, [VOLC_HOST])
  // node:https.request 而非 fetch：undici 按 WHATWG forbidden header names 剥掉
  // 手动 Host 头，网关重算签名时与 SignedHeaders 不一致 -> 401 SignatureDoesNotMatch
  //（1.x 线 2026-10-19 同凭据对照实测锁定）；https.request 原样发送签名头集合。
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => {
        text += chunk.toString('utf8')
      })
      res.on('end', () => {
        let payload = null
        try {
          payload = JSON.parse(text)
        } catch (err) {}
        const errBody = payload && typeof payload === 'object' ? payload.ResponseMetadata : null
        const errInfo = errBody && typeof errBody.Error === 'object' ? errBody.Error : null
        const status = res.statusCode || 0
        const fail = (cls) => {
          const err = new Error(cls.message)
          err.volcReason = cls.reason
          reject(err)
        }
        if (status < 200 || status >= 300) {
          fail(
            classifyVolcError({
              status,
              code: errInfo ? errInfo.Code : '',
              message: errInfo ? errInfo.Message : text.slice(0, 200),
            })
          )
          return
        }
        if (errInfo) {
          // 2xx 但带错误体（个别网关行为）：同样按分类处理
          fail(classifyVolcError({ status, code: errInfo.Code, message: errInfo.Message }))
          return
        }
        resolve(payload)
      })
    })
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error('火山方舟请求超时（' + Math.round(TIMEOUT_MS / 1000) + 's）'))
    })
    req.on('error', (err) => reject(err))
    req.write(body)
    req.end()
  })
}

// 保险库里两个条目各自为串（vault 只存单串）；AK 与 SK 必须齐 pair 才算配置。
function volcCredFromVault() {
  const ak = String(getVaultKey('volc-access-key-id') || '').trim()
  const sk = String(getVaultKey('volc-access-key-secret') || '').trim()
  return ak && sk ? { ak, sk, source: 'vault' } : null
}

// 凭据现读：环境变量多套命名各按**整套**配对（避免 AK/SK 来自不同别名拼成
// 错配的一对）> dock 保险库 > 旧挂件配置 vendorKeys（1.x 同名键）。别名集与
// dsh-volcark-quota（BSD-3）README 声明的三套对齐。只返回来源与掩码用途，
// AK/SK 只进签名，不落盘日志。
export function readVolcCredentials(env = process.env, readConfig = readPluginConfig) {
  const pairs = [
    ['VOLC_ACCESS_KEY_ID', 'VOLC_ACCESS_KEY_SECRET'],
    ['VOLC_ARK_ACCESS_KEY_ID', 'VOLC_ARK_ACCESS_KEY_SECRET'],
    ['VOLC_ACCESS_KEY', 'VOLC_SECRET_KEY'],
    ['ARK_ACCESS_KEY_ID', 'ARK_ACCESS_KEY_SECRET'],
  ]
  for (const [idEnv, skEnv] of pairs) {
    const ak = String(env[idEnv] || '').trim()
    const sk = String(env[skEnv] || '').trim()
    if (ak && sk) return { ak, sk, source: 'env:' + idEnv }
  }
  const fromVault = volcCredFromVault()
  if (fromVault) return fromVault
  const cfg = readConfig()
  const vendorKeys = cfg && typeof cfg.vendorKeys === 'object' ? cfg.vendorKeys : null
  const cfgAk = vendorKeys && typeof vendorKeys['volc-access-key-id'] === 'string' ? vendorKeys['volc-access-key-id'].trim() : ''
  const cfgSk =
    vendorKeys && typeof vendorKeys['volc-access-key-secret'] === 'string'
      ? vendorKeys['volc-access-key-secret'].trim()
      : ''
  if (cfgAk && cfgSk) return { ak: cfgAk, sk: cfgSk, source: 'legacy-config' }
  return null
}

// 分套餐、分凭据缓存；强制刷新也复用同一在途查询，避免并发覆盖。
const states = new Map()
export async function readVolcPlanQuota(force = false, planType = 'coding') {
  if (planType !== 'coding' && planType !== 'agent') {
    return { ok: false, reason: 'unknown-plan', readAt: Date.now() }
  }
  const cred = readVolcCredentials()
  if (!cred) {
    states.delete(planType)
    return { ok: false, planType, reason: 'no-credentials', readAt: Date.now() }
  }
  // 摘要仅留在内存，用于凭据变更时失效；不返回或记录凭据及摘要。
  const identity = createHash('sha256').update(JSON.stringify([cred.ak, cred.sk])).digest('hex')
  let state = states.get(planType)
  if (!state || state.identity !== identity) {
    state = { identity, at: 0, payload: null, pending: null }
    states.set(planType, state)
  }
  if (state.pending) return state.pending
  if (!force && state.payload && Date.now() - state.at < TTL_MS) return state.payload
  state.pending = readVolcPlanQuotaOnce(cred, planType).then((payload) => {
    state.at = Date.now()
    state.payload = { ...payload, planType, readAt: state.at }
    return state.payload
  }).finally(() => { state.pending = null })
  return state.pending
}

async function readVolcPlanQuotaOnce(cred, planType) {
  const [action, shape] = planType === 'agent'
    ? ['GetAFPUsage', shapeVolcAfp] : ['GetCodingPlanUsage', shapeVolcCoding]
  try {
    const payload = await callVolc(cred.ak, cred.sk, action)
    const shaped = shape(payload && payload.Result)
    return shaped ? { ok: true, ...shaped, windows: sortWindows(shaped.windows) }
      : { ok: false, reason: 'no-data' }
  } catch (err) {
    return { ok: false, reason: err.volcReason || 'request-failed' }
  }
}

// vendor 状态组装（纯函数，便于单测）：windows 摊平成 dock 的通用窗口契约
// （label + percentUsed 0–100 + resetAt），Coding / Agent 各自加前缀不混窗；
// 两套餐都失败时 available=false 且 reason 取 coding 侧（与 1.x 同：查询失败
// 不会串到另一套餐，也不误报成「未订阅」——reason 原样带出）。
export function volcVendorStatus(base, coding, agent, cred) {
  const planWindows = (plan, prefix) =>
    plan && plan.ok
      ? plan.windows.map((w) => ({ label: prefix + w.label, percentUsed: w.usedPct, resetAt: w.resetAt || undefined }))
      : []
  const windows = [...planWindows(coding, 'Coding · '), ...planWindows(agent, 'Agent · ')]
  return {
    ...base,
    available: !!(coding && coding.ok) || !!(agent && agent.ok),
    reason: coding && coding.ok ? undefined : agent && agent.ok ? undefined : !cred ? VOLC_CRED_HINT : volcReasonText(coding),
    windows: windows.length ? windows : undefined,
    plans: { coding, agent },
    keySource: cred ? cred.source : 'none',
    keyMasked: cred ? maskKey(cred.ak) : undefined,
  }
}

// reason -> 中文说明（只在两套餐都拿不到窗口时展示；单个套餐失败由 plans 细节承载）
export function volcReasonText(plan) {
  const r = plan && plan.reason
  if (r === 'no-credentials') return VOLC_CRED_HINT
  if (r === 'not-subscribed') return '未订阅火山方舟 Coding / Agent Plan（或账号下无数据）'
  if (r === 'invalid-credentials') return '火山 IAM 凭据无效或无权限（AKLT 开头的 Access Key 才能查配额，ark- 模型 key 不适用）'
  if (r === 'clock-skew') return '本机时间偏差超过 15 分钟（InvalidTimestamp），校准系统时钟后重试'
  if (r === 'no-data') return '接口可用但未返回有效配额窗口（不显示虚假满额）'
  return '火山方舟配额查询失败：' + String(r || 'request-failed')
}
