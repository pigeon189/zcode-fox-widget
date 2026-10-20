import test from 'node:test'
import assert from 'node:assert/strict'

import { resolvePricing } from '../../engines/pricing.mjs'

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
