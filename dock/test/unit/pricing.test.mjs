import test from 'node:test'
import assert from 'node:assert/strict'

import { costOfUsage, periodFor, resolvePricing } from '../../engines/pricing.mjs'

test('pricing: Daybreak / mythos preview 别名可计价', () => {
  const blue = resolvePricing({ providerId: 'openai', model: 'gpt-daybreak-blue-latest', inTokens: 1000 })
  assert.equal(blue.vendor, 'openai')
  assert.equal(blue.miss[0], 4)
  assert.equal(blue.out[0], 20)

  const red = resolvePricing({ providerId: 'openai', model: 'gpt-daybreak-red', inTokens: 1000 })
  assert.equal(red.vendor, 'openai')
  assert.equal(red.miss[0], 12.5)
  assert.equal(red.out[0], 75)

  const mythos = resolvePricing({ providerId: 'anthropic', model: 'claude-mythos-preview', inTokens: 1000 })
  assert.equal(mythos.vendor, 'anthropic')
  assert.equal(mythos.miss[0], 10)
  assert.equal(mythos.out[0], 50)
})

test('pricing: CommandCode 的 DeepSeek v4.1 走峰谷两档', () => {
  const model = 'deepseek/deepseek-v4.1-flash-fast'
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000 }
  const peak = Date.UTC(2026, 9, 20, 2, 0, 0) // 北京时间 10:00
  const valley = Date.UTC(2026, 9, 20, 14, 0, 0) // 北京时间 22:00
  const a = costOfUsage(model, usage, peak, 'commandcode')
  const b = costOfUsage(model, usage, valley, 'commandcode')
  assert.equal(a.peak, true)
  assert.equal(b.peak, false)
  assert.equal(a.amount, 10) // 1M miss @2 + 1M out @8
  assert.equal(b.amount, 5) // 谷价减半

  const period = periodFor(model, 'commandcode', peak)
  assert.equal(period.isPeak, true)
  assert.ok(period.nextChangeAt > peak)
})

test('pricing: 平价模型不显示峰谷', () => {
  assert.equal(periodFor('gpt-6-sol', 'openai'), null)
})

test('pricing: Kimi K3.1 Pro 发布当日官方价（2026-10-24 快照）', () => {
  const p = resolvePricing({ providerId: 'moonshot', model: 'kimi-k3.1-pro', inTokens: 1000 })
  assert.equal(p.vendor, 'kimi')
  assert.equal(p.currency, 'CNY')
  assert.equal(p.miss[0], 13)
  assert.equal(p.out[0], 68)
  assert.equal(p.hit[0], 1.3)
  assert.equal(p.cw[0], 13) // 缓存写按默认 5min TTL 档

  const hs = resolvePricing({ providerId: 'moonshot', model: 'kimi-k3.1-pro-highspeed', inTokens: 1000 })
  assert.equal(hs.miss[0], 26)
  assert.equal(hs.out[0], 136)
  assert.equal(hs.hit[0], 1.3)
  assert.equal(hs.cw[0], 26)

  // 裸短名（含日期后缀）不被 'k3' 前缀误匹配成旧 K3 价
  const bare = resolvePricing({ providerId: 'moonshot', model: 'k3.1-pro-20261024', inTokens: 1000 })
  assert.equal(bare.miss[0], 13)
  assert.equal(bare.out[0], 68)

  // 金额：1M 未命中输入 + 1M 输出 = 13 + 68
  const u = costOfUsage('kimi-k3.1-pro', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, 0, 'moonshot')
  assert.equal(u.amount, 81)
  assert.equal(u.billable, true)
})

test('pricing: 2026-10-24 复核新增的 MiniMax / GLM / OpenAI 条目', () => {
  const mm = resolvePricing({ providerId: 'minimax', model: 'minimax-m3.1-flash', inTokens: 1000 })
  assert.equal(mm.currency, 'CNY')
  assert.equal(mm.miss[0], 1)
  assert.equal(mm.out[0], 4)
  assert.equal(mm.hit[0], 0.1)
  assert.equal(mm.cw[0], 0) // 缓存写未公布记 0

  const legal = resolvePricing({ providerId: 'bigmodel', model: 'glm-5.3-flashx-legal', inTokens: 1000 })
  assert.equal(legal.vendor, 'glm')
  assert.equal(legal.miss[0], 2) // 与 FlashX 同价
  assert.equal(legal.out[0], 7)
  assert.equal(legal.hit[0], 0.57)

  const ros = resolvePricing({ providerId: 'openai', model: 'gpt-rosalind-research', inTokens: 1000 })
  assert.equal(ros.currency, 'USD')
  assert.equal(ros.miss[0], 5)
  assert.equal(ros.out[0], 25)
  assert.equal(ros.hit[0], 0.5)
  assert.equal(ros.cw[0], 0) // 缓存写价官方不适用记 0
})
