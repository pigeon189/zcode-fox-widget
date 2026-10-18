// Kimi Code 适配器：凭据刷新、额度窗口、Free 降级、错误态。
// 全部走注入的 fetch，不碰真实网络与用户凭据。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { kimiAdapter } from '../../adapters/kimi/index.mjs'
import { readKimiCredentials } from '../../adapters/kimi/credentials.mjs'
import { _resetKimiUsageCache, parseKimiUsage, parseKimiWallet, ratioToPct, readKimiStatus } from '../../adapters/kimi/usage.mjs'
import { _resetKimiRefreshState } from '../../adapters/kimi/credentials.mjs'
import { resolveAdapter } from '../../adapters/registry.mjs'
import { genericAdapter } from '../../adapters/generic.mjs'
import { normalizeSnapshot } from '../../adapters/contracts.mjs'

function tempHome(creds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-kimi-'))
  fs.mkdirSync(path.join(dir, 'credentials'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'credentials', 'kimi-code.json'), JSON.stringify(creds))
  return dir
}

function cleanup(dir) {
  _resetKimiUsageCache()
  _resetKimiRefreshState()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const CREDS = {
  access_token: 'old-token',
  refresh_token: 'old-refresh',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  scope: 'kimi-code',
  token_type: 'Bearer',
  expires_in: 900,
}

const USAGE = {
  usages: {
    limit_5h: { used_ratio: 0.42, reset_time: '2026-10-19T05:00:00Z' },
    limit_7d: { used_ratio: 0.18 },
    limit_month_total: { used_ratio: 0.31 },
  },
  boosterWallet: {
    balance: { type: 'BOOSTER', amount: 500000000, amountLeft: 250000000 },
    monthlyChargeLimit: { priceInCents: 2000, currency: 'USD' },
    monthlyUsed: { priceInCents: 500, currency: 'USD' },
    monthlyChargeLimitEnabled: true,
  },
}

test('kimi: ratioToPct 同时接受 0..1 与百分数', () => {
  assert.equal(ratioToPct(0.42), 42)
  assert.equal(ratioToPct(1), 100)
  assert.equal(ratioToPct(42), 42)
  assert.equal(ratioToPct(140), 100)
  assert.equal(ratioToPct('0.125'), 12.5)
  assert.equal(ratioToPct(null), null)
})

test('kimi: parseKimiUsage 解析四个窗口与 booster 钱包', () => {
  const parsed = parseKimiUsage({
    usages: {
      ...USAGE.usages,
      limit_month_code: { used_ratio: 0.07, reset_time: '2026-11-01T00:00:00Z' },
    },
    boosterWallet: USAGE.boosterWallet,
  })
  assert.equal(parsed.windows.length, 4)
  assert.deepEqual(parsed.windows[0], {
    key: 'limit_5h',
    label: '5 小时',
    usedPct: 42,
    remainingPct: 58,
    resetAt: '2026-10-19T05:00:00Z',
  })
  assert.equal(parsed.wallet.amount, 2.5)
  assert.equal(parsed.wallet.total, 5)
  assert.equal(parsed.wallet.currency, 'USD')
  assert.equal(parsed.wallet.monthlyLimitEnabled, true)
})

test('kimi: 钱包缺 amountLeft 时用 amount，仍按 1e6 定点转元', () => {
  const w = parseKimiWallet({ balance: { type: 'BOOSTER', amount: 300000000 } })
  assert.equal(w.amount, 3)
  assert.equal(w.total, 3)
})

test('kimi: 新鲜 token → 直接读 usages/me，不刷新', async () => {
  const home = tempHome(CREDS)
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), auth: opts.headers.authorization })
    if (String(url).endsWith('/usages')) return jsonResponse(USAGE)
    if (String(url).endsWith('/me')) return jsonResponse({ nickname: '登月者', user_level_name: 'Pro', region: 'REGION_CN' })
    return jsonResponse({ error: 'not found' }, 404)
  }
  try {
    const r = await readKimiStatus({ home, now: () => Date.now(), fetchImpl })
    assert.equal(r.ok, true)
    assert.equal(r.windows.length, 3)
    assert.equal(r.plan, 'Pro')
    assert.equal(r.account, '登月者')
    assert.equal(r.region, 'REGION_CN')
    assert.equal(calls.length, 2)
    assert.ok(calls.every((c) => c.auth === 'Bearer old-token'))
  } finally {
    cleanup(home)
  }
})

test('kimi: token 过期 → 刷新并原子写回，使用新 token 读额度', async () => {
  const home = tempHome({ ...CREDS, expires_at: Math.floor(Date.now() / 1000) - 10 })
  const calls = []
  const fetchImpl = async (url, opts) => {
    const u = String(url)
    calls.push({ url: u, auth: opts.headers.authorization, body: opts.body })
    if (u.includes('/api/oauth/token')) {
      return jsonResponse({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 900, scope: 'kimi-code', token_type: 'Bearer' })
    }
    if (u.endsWith('/usages')) return jsonResponse(USAGE)
    if (u.endsWith('/me')) return jsonResponse({ nickname: '登月者', user_level_name: 'Pro' })
    return jsonResponse({}, 404)
  }
  try {
    const r = await readKimiStatus({ home, now: () => Date.now(), fetchImpl })
    assert.equal(r.ok, true)
    const saved = readKimiCredentials(path.join(home, 'credentials', 'kimi-code.json'))
    assert.equal(saved.access_token, 'new-token')
    assert.equal(saved.refresh_token, 'new-refresh')
    assert.ok(saved.expires_at > Math.floor(Date.now() / 1000))
    const usageCall = calls.find((c) => c.url.endsWith('/usages'))
    assert.equal(usageCall.auth, 'Bearer new-token')
    // 刷新请求是 form，不含明文 token 以外的日志；至少字段正确
    assert.match(String(calls[0].body), /grant_type=refresh_token/)
  } finally {
    cleanup(home)
  }
})

test('kimi: 并发过期读取只刷新一次', async () => {
  const home = tempHome({ ...CREDS, expires_at: Math.floor(Date.now() / 1000) - 10 })
  let refreshCount = 0
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.includes('/api/oauth/token')) {
      refreshCount += 1
      await new Promise((r) => setTimeout(r, 30))
      return jsonResponse({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 900 })
    }
    if (u.endsWith('/usages')) return jsonResponse(USAGE)
    if (u.endsWith('/me')) return jsonResponse({ nickname: 'x', user_level_name: 'Pro' })
    return jsonResponse({}, 404)
  }
  try {
    _resetKimiUsageCache()
    await Promise.all([
      readKimiStatus({ home, now: () => Date.now(), fetchImpl }),
      readKimiStatus({ home: home + '-other', now: () => Date.now(), fetchImpl }).catch(() => null),
    ])
    assert.equal(refreshCount, 1)
  } finally {
    cleanup(home)
  }
})

test('kimi: access_token 被宿主换掉（首次 401）→ 强制刷新一次再重试', async () => {
  const home = tempHome(CREDS)
  let usageCalls = 0
  let refreshCalls = 0
  let token = 'old-token'
  const fetchImpl = async (url) => {
    const u = String(url)
    if (u.includes('/api/oauth/token')) {
      refreshCalls += 1
      token = 'fresh-token'
      return jsonResponse({ access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 900 })
    }
    if (u.endsWith('/usages')) {
      usageCalls += 1
      if (token === 'old-token') return jsonResponse({ error: { message: 'expired' } }, 401)
      return jsonResponse(USAGE)
    }
    if (u.endsWith('/me')) return jsonResponse({ nickname: 'x', user_level_name: 'Pro' })
    return jsonResponse({}, 404)
  }
  try {
    const r = await readKimiStatus({ home, now: () => Date.now(), fetchImpl })
    assert.equal(r.ok, true)
    assert.equal(usageCalls, 2)
    assert.ok(refreshCalls >= 1)
  } finally {
    cleanup(home)
  }
})

test('kimi: Free 账号（usages 为空）→ plan 卡，不编 0%', async () => {
  const home = tempHome(CREDS)
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/usages')) return jsonResponse({})
    if (String(url).endsWith('/me')) return jsonResponse({ nickname: '登月者', user_level_name: 'Free', region: 'REGION_CN' })
    return jsonResponse({}, 404)
  }
  try {
    const r = await readKimiStatus({ home, now: () => Date.now(), fetchImpl })
    assert.equal(r.ok, true)
    assert.equal(r.windows.length, 0)
    assert.equal(r.plan, 'Free')
    const raw = await kimiAdapter.createBilling({ now: () => Date.now(), kimiHome: home, fetchImpl }).snapshot({})
    const snap = normalizeSnapshot(raw, { adapterId: 'kimi', adapterName: 'Kimi Code' })
    assert.equal(snap.ok, true)
    assert.equal(snap.supported, true)
    assert.equal(snap.quotaCard.kind, 'plan')
    assert.equal(snap.quotaCard.plan, 'Free')
    assert.equal(snap.quota, null)
  } finally {
    cleanup(home)
  }
})

test('kimi: 有窗口 → 百分比口径 + windows 卡（剩余取最小）', async () => {
  const home = tempHome(CREDS)
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/usages')) return jsonResponse(USAGE)
    if (String(url).endsWith('/me')) return jsonResponse({ nickname: '登月者', user_level_name: 'Pro', region: 'REGION_CN' })
    return jsonResponse({}, 404)
  }
  try {
    const raw = await kimiAdapter.createBilling({ now: () => Date.now(), kimiHome: home, fetchImpl }).snapshot({})
    const snap = normalizeSnapshot(raw, { adapterId: 'kimi', adapterName: 'Kimi Code' })
    assert.equal(snap.unit, 'percent')
    assert.equal(snap.quota.usedPct, 42)
    assert.equal(snap.quota.remainingPct, 58)
    assert.equal(snap.quotaCard.kind, 'windows')
    assert.equal(snap.quotaCard.windows.length, 3)
    assert.equal(snap.quotaCard.plan, 'Pro')
    assert.ok(snap.details.some((d) => d.label === '账号' && d.value === '登月者'))
  } finally {
    cleanup(home)
  }
})

test('kimi: 只有钱包没有窗口 → 金额口径 + balance 卡', async () => {
  const home = tempHome(CREDS)
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/usages')) return jsonResponse({ boosterWallet: USAGE.boosterWallet })
    if (String(url).endsWith('/me')) return jsonResponse({ nickname: 'x', user_level_name: 'Pro' })
    return jsonResponse({}, 404)
  }
  try {
    const raw = await kimiAdapter.createBilling({ now: () => Date.now(), kimiHome: home, fetchImpl }).snapshot({})
    const snap = normalizeSnapshot(raw, { adapterId: 'kimi', adapterName: 'Kimi Code' })
    assert.equal(snap.unit, 'money')
    assert.equal(snap.balance.amount, 2.5)
    assert.equal(snap.balance.currency, 'USD')
    assert.equal(snap.quotaCard.kind, 'balance')
  } finally {
    cleanup(home)
  }
})

test('kimi: 没有凭据 / 网络失败 → 可读错误，不抛异常', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-kimi-empty-'))
  try {
    const r = await readKimiStatus({ home, now: () => Date.now(), fetchImpl: async () => jsonResponse({}, 500) })
    assert.equal(r.ok, false)
    assert.match(r.error, /凭据|登录/)
    const raw = await kimiAdapter.createBilling({ now: () => Date.now(), kimiHome: home, fetchImpl: async () => jsonResponse({}, 500) }).snapshot({})
    const snap = normalizeSnapshot(raw, { adapterId: 'kimi', adapterName: 'Kimi Code' })
    assert.equal(snap.ok, false)
    assert.ok(snap.error)
  } finally {
    cleanup(home)
  }
})

test('kimi: 窗口识别只认 Kimi Code.exe', () => {
  const hit = resolveAdapter(
    { exe: 'E:\\KimiCode\\Kimi Code\\Kimi Code.exe', title: 'Kimi Code' },
    [genericAdapter, kimiAdapter]
  )
  assert.equal(hit.id, 'kimi')
  const miss = resolveAdapter({ exe: 'C:\\Apps\\electron.exe', title: 'Kimi Code' }, [genericAdapter, kimiAdapter])
  assert.equal(miss.id, 'generic')
})
