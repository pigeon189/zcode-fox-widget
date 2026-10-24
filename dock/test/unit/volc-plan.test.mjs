// 火山方舟 Ark 分流（P1-Ark分流，迁移自 1.x v1.16.1）：
//   ① volc-plan.mjs：IAM AK/SK V4 签名查询 Coding / Agent Plan 订阅窗口
//   ② source.mjs：ark 官方 Base URL 路径区分订阅（volc）/ 按量（volc-api）
//   ③ vendors.mjs：volc-plan 模板挂载 + 按量模板（volcengine-ark）口径说明
// 失败语义硬约束：查不到就是 null/undefined + reason，绝不编 0 或虚假满额。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatXDate,
  normQuery,
  volcengineSign,
  classifyVolcError,
  volcWindowMeta,
  shapeVolcCoding,
  shapeVolcAfp,
  readVolcCredentials,
  readVolcPlanQuota,
  volcVendorStatus,
  volcReasonText,
  VOLC_CRED_HINT,
} from '../../engines/volc-plan.mjs'
import { resolveBillingSource, volcModeByUrl } from '../../engines/source.mjs'
import { TEMPLATES } from '../../engines/vendors.mjs'

const FIXED_NOW = Date.UTC(2026, 9, 19, 8, 9, 5) // 2026-10-19T08:09:05Z

// ---------- 签名（结构与确定性；算法在 1.x 线已与官方 V4 参考实现对照实测） ----------

test('volc: V4 签名头结构 + 固定时钟确定性', () => {
  const q = { Action: 'GetCodingPlanUsage', Version: '2024-01-01' }
  const a = volcengineSign('AKLT-test-ak', 'test-sk', 'POST', '/', q, '{}', FIXED_NOW)
  const b = volcengineSign('AKLT-test-ak', 'test-sk', 'POST', '/', q, '{}', new Date(FIXED_NOW))
  assert.equal(a['X-Date'], '20261019T080905Z')
  assert.equal(formatXDate(new Date(FIXED_NOW)), '20261019T080905Z')
  // 必签头全小写排序；body hash 参与签名
  assert.match(a.Authorization, /^HMAC-SHA256 Credential=AKLT-test-ak\/20261019\/cn-beijing\/ark\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/)
  // 同输入同时钟 → 同签名（now 注入，不依赖真时钟）
  assert.equal(a.Authorization, b.Authorization)
  // 换 body → 签名必须变（X-Content-Sha256 参与派生）
  const c = volcengineSign('AKLT-test-ak', 'test-sk', 'POST', '/', q, '{"x":1}', FIXED_NOW)
  assert.notEqual(a.Authorization, c.Authorization)
})

test('volc: normQuery 按参数名排序并组件编码', () => {
  assert.equal(normQuery({ Version: '2024-01-01', Action: 'GetAFPUsage' }), 'Action=GetAFPUsage&Version=2024-01-01')
})

// ---------- 塑形：成功有窗口 → 窗口；字段缺失 → 跳过；全缺 → null（不编满额） ----------

test('volc: Coding Plan 塑形（Level→窗口名，Percent 已用，ResetTimestamp 秒→毫秒）', () => {
  const shaped = shapeVolcCoding({
    QuotaUsage: [
      { Level: 'monthly', Percent: 37.5, ResetTimestamp: 1795000000 },
      { Level: '5h', Percent: 82, ResetTimestamp: 1794900000 },
      { Level: 'weekly', Percent: null, ResetTimestamp: 1794800000 }, // Percent 缺失：跳过，不补 0
    ],
  })
  assert.equal(shaped.planType, 'coding')
  assert.equal(shaped.windows.length, 2)
  // 塑形层保持响应顺序（monthly 在前）；窗口排序（5h→daily→week→month）发生在
  // readVolcPlanQuotaOnce 的 sortWindows，与 1.x 同款分工
  assert.deepEqual(
    shaped.windows.map((w) => w.name),
    ['month', '5h']
  )
  const five = shaped.windows[1]
  assert.equal(five.label, '5小时')
  assert.equal(five.usedPct, 82)
  assert.equal(five.remainingPct, 18)
  assert.equal(five.resetAt, 1794900000 * 1000)
  const month = shaped.windows[0]
  assert.equal(month.usedPct, 37.5)
  assert.equal(month.remainingPct, 62.5)
})

test('volc: Coding 塑形空响应 → null（no-data，不显示虚假满额）', () => {
  assert.equal(shapeVolcCoding({}), null)
  assert.equal(shapeVolcCoding({ QuotaUsage: [] }), null)
  assert.equal(shapeVolcCoding({ QuotaUsage: [{ Level: '5h', Percent: null }] }), null)
})

test('volc: Agent Plan（AFP）塑形：Quota/Used → 已用百分比，秒与毫秒重置时间都认', () => {
  const shaped = shapeVolcAfp({
    AFPFiveHour: { Quota: 100, Used: 40, ResetTime: 1794900000 }, // 秒
    AFPDaily: { Quota: 0, Used: 0, ResetTime: 1794900000 }, // quota<=0：跳过
    AFPWeekly: { Quota: 500, Used: 250, ResetTime: 1794900000000 }, // 毫秒
    AFPMonthly: { Quota: null, Used: 10 }, // quota 缺失：跳过
  })
  assert.equal(shaped.planType, 'agent')
  assert.equal(shaped.windows.length, 2)
  assert.equal(shaped.windows[0].label, '5小时')
  assert.equal(shaped.windows[0].usedPct, 40)
  assert.equal(shaped.windows[0].resetAt, 1794900000 * 1000)
  assert.equal(shaped.windows[1].label, '近一周')
  assert.equal(shaped.windows[1].usedPct, 50)
  assert.equal(shaped.windows[1].resetAt, 1794900000000)
  assert.equal(shapeVolcAfp({}), null)
})

test('volc: 窗口 Level 未知取值原样保留', () => {
  const meta = volcWindowMeta('Quarterly')
  assert.equal(meta.name, 'quarterly')
  assert.equal(meta.label, 'quarterly')
  assert.deepEqual(volcWindowMeta('session'), { name: '5h', label: '5小时' })
  assert.deepEqual(volcWindowMeta('WEEKLY'), { name: 'week', label: '本周' })
  assert.deepEqual(volcWindowMeta('daily'), { name: 'daily', label: '今日' })
})

test('volc: 网关错误分类（时钟偏差 / 凭据 / 未订阅 / 原样透传）', () => {
  assert.equal(classifyVolcError({ status: 400, code: 'InvalidTimestamp' }).reason, 'clock-skew')
  assert.equal(classifyVolcError({ status: 401, code: 'SignatureDoesNotMatch' }).reason, 'invalid-credentials')
  assert.equal(classifyVolcError({ status: 403, code: '' }).reason, 'invalid-credentials')
  assert.equal(classifyVolcError({ status: 404, code: 'NotFound' }).reason, 'not-subscribed')
  assert.equal(classifyVolcError({ status: 500, code: 'InternalError' }).reason, 'InternalError')
  assert.equal(classifyVolcError({ status: 0, code: '', message: 'boom' }).reason, 'HTTP ?')
})

// ---------- 凭据链：env 整套配对 > 保险库/旧配置；AK/SK 不跨别名拼对 ----------

const NO_VOLC_ENV = {}
const EMPTY_CONFIG = () => ({ vendorKeys: {} })

test('volc: 凭据按整套别名对读取，AK 与 SK 来自不同别名组不拼对', () => {
  const cred = readVolcCredentials(
    { VOLC_ACCESS_KEY_ID: 'ak1', VOLC_ACCESS_KEY_SECRET: 'sk1' },
    EMPTY_CONFIG
  )
  assert.deepEqual(cred, { ak: 'ak1', sk: 'sk1', source: 'env:VOLC_ACCESS_KEY_ID' })

  // 残缺对（只有 ID 没有 SECRET）不算配置，也不拿别的别名的 SK 来拼
  const broken = readVolcCredentials({ VOLC_ACCESS_KEY_ID: 'ak1', ARK_ACCESS_KEY_SECRET: 'sk2' }, EMPTY_CONFIG)
  assert.equal(broken, null)

  // 第二套别名整对可用
  const alt = readVolcCredentials({ ARK_ACCESS_KEY_ID: 'ak2', ARK_ACCESS_KEY_SECRET: 'sk2' }, EMPTY_CONFIG)
  assert.deepEqual(alt, { ak: 'ak2', sk: 'sk2', source: 'env:ARK_ACCESS_KEY_ID' })
})

test('volc: env 缺失时回落旧挂件配置 vendorKeys（1.x 同名键）', () => {
  const cred = readVolcCredentials(NO_VOLC_ENV, () => ({
    vendorKeys: { 'volc-access-key-id': 'cfg-ak', 'volc-access-key-secret': 'cfg-sk' },
  }))
  assert.deepEqual(cred, { ak: 'cfg-ak', sk: 'cfg-sk', source: 'legacy-config' })
  // 半对不算
  assert.equal(
    readVolcCredentials(NO_VOLC_ENV, () => ({ vendorKeys: { 'volc-access-key-id': 'cfg-ak' } })),
    null
  )
})

test('volc: 未知套餐类型直接拒绝（不猜、不发请求）', async () => {
  const r = await readVolcPlanQuota(false, 'seat')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unknown-plan')
})

// ---------- vendor 状态：窗口摊平 + 双套餐互不串台 + 缺失不编 0 ----------

const VENDOR_BASE = { id: 'volc-plan', name: '火山方舟（Coding/Agent Plan）', kind: 'volc', currency: '%' }

test('volc: vendor 状态摊平 Coding/Agent 窗口（前缀区分，契约=percentUsed 0–100）', () => {
  const coding = {
    ok: true,
    planType: 'coding',
    windows: [
      { name: '5h', label: '5小时', usedPct: 82, remainingPct: 18, resetAt: 1794900000000 },
      { name: 'month', label: '本月', usedPct: 37.5, remainingPct: 62.5, resetAt: null },
    ],
  }
  const agent = {
    ok: true,
    planType: 'agent',
    windows: [{ name: 'daily', label: '近一天', usedPct: 60, remainingPct: 40, resetAt: 1794950000000 }],
  }
  const v = volcVendorStatus(VENDOR_BASE, coding, agent, { ak: 'AKLT-example-access-key', sk: 'sk', source: 'vault' })
  assert.equal(v.available, true)
  assert.equal(v.keySource, 'vault')
  assert.match(v.keyMasked, /^AKLT-…key$/)
  assert.deepEqual(
    v.windows.map((w) => w.label),
    ['Coding · 5小时', 'Coding · 本月', 'Agent · 近一天']
  )
  assert.equal(v.windows[0].percentUsed, 82)
  assert.equal(v.windows[0].resetAt, 1794900000000)
  assert.equal(v.windows[2].percentUsed, 60)
  // plans 细节原样携带（单套餐失败时 UI 仍能区分是哪一个）
  assert.equal(v.plans.coding.planType, 'coding')
  assert.equal(v.plans.agent.planType, 'agent')
})

test('volc: 一个套餐失败不拖垮另一个（查询失败不串台、不误报未订阅）', () => {
  const agent = { ok: false, reason: 'not-subscribed' }
  const coding = { ok: true, planType: 'coding', windows: [{ name: '5h', label: '5小时', usedPct: 10, remainingPct: 90 }] }
  const v = volcVendorStatus(VENDOR_BASE, coding, agent, { ak: 'a', sk: 'b', source: 'vault' })
  assert.equal(v.available, true)
  assert.equal(v.reason, undefined)
  assert.deepEqual(v.windows.map((w) => w.label), ['Coding · 5小时'])
})

test('volc: 两套餐都拿不到 + 无凭据 → available=false，reason 给配置指引（不编 0）', () => {
  const v = volcVendorStatus(VENDOR_BASE, { ok: false, reason: 'no-credentials' }, { ok: false, reason: 'no-credentials' }, null)
  assert.equal(v.available, false)
  assert.equal(v.windows, undefined)
  assert.equal(v.reason, VOLC_CRED_HINT)
  assert.match(VOLC_CRED_HINT, /VOLC_ACCESS_KEY_ID/)
  assert.match(VOLC_CRED_HINT, /ark-/)
})

test('volc: 有凭据但接口无数据 → reason 说明「不显示虚假满额」', () => {
  const v = volcVendorStatus(
    VENDOR_BASE,
    { ok: false, reason: 'no-data' },
    { ok: false, reason: 'not-subscribed' },
    { ak: 'a', sk: 'b', source: 'vault' }
  )
  assert.equal(v.available, false)
  assert.match(v.reason, /不显示虚假满额|未返回有效配额窗口/)
})

test('volc: reason 文案映射（凭据无效 / 时钟偏差）', () => {
  assert.match(volcReasonText({ reason: 'invalid-credentials' }), /AKLT/)
  assert.match(volcReasonText({ reason: 'clock-skew' }), /15 分钟/)
})

// ---------- source.mjs：按官方 Base URL 路径分流订阅与按量 ----------

test('volc: volcModeByUrl 只认官方直连路径（拒 query/端口/http/他域）', () => {
  assert.equal(volcModeByUrl('https://ark.cn-beijing.volces.com/api/v3'), 'api')
  assert.equal(volcModeByUrl('https://ark.cn-beijing.volces.com/api/v3/'), 'api')
  assert.equal(volcModeByUrl('https://ark.cn-beijing.volces.com/api/coding'), 'coding')
  assert.equal(volcModeByUrl('https://ark.cn-beijing.volces.com/api/coding/v3'), 'coding')
  assert.equal(volcModeByUrl('https://ark.cn-beijing.volces.com/api/plan'), 'agent')
  assert.equal(volcModeByUrl('https://ark.cn-beijing.volces.com/api/plan/v3'), 'agent')
  // 非 https / 带端口 / 带 query / 其他域名：不能证明套餐
  assert.equal(volcModeByUrl('http://ark.cn-beijing.volces.com/api/coding'), 'unknown')
  assert.equal(volcModeByUrl('https://ark.cn-beijing.volces.com:8443/api/coding'), 'unknown')
  assert.equal(volcModeByUrl('https://ark.cn-beijing.volces.com/api/coding?x=1'), 'unknown')
  assert.equal(volcModeByUrl('https://ark.ap-southeast.volces.com/api/coding'), 'unknown')
  assert.equal(volcModeByUrl(''), 'unknown')
})

test('volc: coding/agent 路径 → 订阅口径（label 带 Coding/Agent），/api/v3 → 按量', () => {
  const coding = resolveBillingSource('new-provider-uuid', 'deepseek-v3', 'https://ark.cn-beijing.volces.com/api/coding')
  assert.equal(coding.source, 'volc')
  assert.equal(coding.planType, 'coding')
  assert.equal(coding.label, '火山 Coding Plan')
  const agent = resolveBillingSource('new-provider-uuid', 'glm-4.6', 'https://ark.cn-beijing.volces.com/api/plan')
  assert.equal(agent.source, 'volc')
  assert.equal(agent.planType, 'agent')
  assert.equal(agent.label, '火山 Agent Plan')
  const api = resolveBillingSource('new-provider-uuid', 'doubao-seed-1.6', 'https://ark.cn-beijing.volces.com/api/v3')
  assert.equal(api.source, 'volc-api')
  assert.equal(api.label, '火山方舟')
  assert.equal(api.planType, undefined)
})

test('volc: ark 按量不再被托管模型名抢认成原厂账单', () => {
  // providerId 是无关键词 UUID、模型是托管的 deepseek：平台身份优先，不归 DeepSeek
  const a = resolveBillingSource('8a7b6c5d', 'deepseek-v3', 'https://ark.cn-beijing.volces.com/api/v3')
  assert.equal(a.source, 'volc-api')
  assert.equal(a.vendor, 'volc')
  // 火山域名家族的其他子域同样只是平台身份
  const b = resolveBillingSource('8a7b6c5d', 'glm-4.6', 'https://ark.ap-southeast.volces.com/api/v3')
  assert.equal(b.source, 'volc-api')
})

test('volc: volc 域名的官方路径权威，providerId 带 coding-plan 字样也不冒充 GLM Plan', () => {
  const a = resolveBillingSource('volc-coding-plan-x', 'glm-4.6', 'https://ark.cn-beijing.volces.com/api/coding')
  assert.equal(a.source, 'volc')
  // 非 volc 的 coding-plan 仍按 GLM 套餐口径（individual-coding-plan 不回退）
  const b = resolveBillingSource('account:zai-individual-coding-plan', 'GLM-5.3', 'https://open.bigmodel.cn/api')
  assert.equal(b.source, 'plan')
  const c = resolveBillingSource('account:zai-start-plan', 'GLM-5.3', '')
  assert.equal(c.source, 'plan')
})

test('volc: 既有口径不受影响（deepseek / mimo plan / commandcode）', () => {
  assert.equal(resolveBillingSource('deepseek', 'deepseek-v4.1', 'https://api.deepseek.com', { glmSubscription: false }).source, 'ds')
  assert.equal(resolveBillingSource('mimo', 'mimo-v2', 'https://token-plan-cn.xiaomimimo.com', { glmSubscription: false }).source, 'mimo-plan')
  assert.equal(resolveBillingSource('commandcode-goat-1', 'gpt-6-astra', '', { glmSubscription: false }).source, 'cmdgo')
})

// ---------- vendors.mjs：模板挂载 ----------

test('volc: volc-plan 模板存在、kind=volc、无通用出站段（取数走 volc-plan.mjs）', () => {
  const tpl = TEMPLATES['volc-plan']
  assert.ok(tpl, 'missing volc-plan template')
  assert.equal(tpl.kind, 'volc')
  assert.equal(tpl.currency, '%')
  assert.match(tpl.name, /Coding\/Agent Plan/)
  assert.match(tpl.note, /IAM AK\/SK/)
  // 不允许通用 balance/quota 段：出站只在 volc-plan.mjs 里按独立 host 白名单发生
  for (const key of ['balance', 'quota', 'relay']) {
    assert.equal(key in tpl, false, 'volc-plan 不应声明 ' + key + ' 段')
  }
})

test('volc: 按量模板（volcengine-ark）保留且 note 指向订阅卡（分流不丢按量）', () => {
  const tpl = TEMPLATES['volcengine-ark']
  assert.ok(tpl)
  assert.equal(tpl.kind, 'tokens')
  assert.match(tpl.name, /按量/)
  assert.match(tpl.note, /Coding\/Agent Plan/)
  assert.match(tpl.note, /按本机 token 用量计价/)
})
