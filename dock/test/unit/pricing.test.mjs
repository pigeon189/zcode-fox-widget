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
