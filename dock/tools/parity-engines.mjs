#!/usr/bin/env node
// engines parity：同一批输入分别喂给挂件线 lib/*.mjs 与 dock/engines/*，
// 逐字段比对。任何不一致都失败——这是「内置厂商引擎不改变口径」的硬证据。
//
// 找不到挂件线源码时明确跳过（dock 独立成仓后仍可跑）。
//
//   node tools/parity-engines.mjs

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const LEGACY = path.join(ROOT, '..', 'lib')

async function load(rel, base) {
  return import(pathToFileURL(path.join(base, rel)).href)
}

function diff(label, a, b, out) {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa !== sb) out.push(label + '\n  legacy: ' + sa + '\n  dock:   ' + sb)
}

async function main() {
  let legacyPricing, legacySource, legacyBalance
  try {
    legacyPricing = await load('pricing.mjs', LEGACY)
    legacySource = await load('source.mjs', LEGACY)
    legacyBalance = await load('balance.mjs', LEGACY)
  } catch (err) {
    console.log('跳过：找不到挂件线引擎源码（' + LEGACY + '）')
    return
  }
  const dockPricing = await load('pricing.mjs', path.join(ROOT, 'engines'))
  const dockSource = await load('source.mjs', path.join(ROOT, 'engines'))
  const dockBalance = await load('balance.mjs', path.join(ROOT, 'engines'))

  const problems = []

  // 1. 价目：四个模型 × 峰/谷 × 有/无缓存
  const cases = [
    ['deepseek-v4.1', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, Date.UTC(2026, 9, 19, 4, 0, 0), 'deepseek'],
    ['deepseek-v4.1', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, Date.UTC(2026, 9, 19, 12, 0, 0), 'deepseek'],
    ['GLM-5.3', { input_tokens: 12345, output_tokens: 678, cache_read_input_tokens: 9000 }, Date.UTC(2026, 9, 19, 12, 0, 0), 'bigmodel'],
    ['gpt-6-astra', { input_tokens: 5000, output_tokens: 600 }, Date.UTC(2026, 9, 19, 12, 0, 0), 'openai'],
    ['claude-sonnet-5-5', { input_tokens: 5000, output_tokens: 600, cache_creation_input_tokens: 100 }, Date.UTC(2026, 9, 19, 12, 0, 0), 'anthropic'],
    ['gemini-4-argon', { input_tokens: 5000, output_tokens: 600 }, Date.UTC(2026, 9, 19, 12, 0, 0), 'google'],
  ]
  for (const [model, usage, at, provider] of cases) {
    let a, b
    try {
      a = legacyPricing.costOfUsage(model, usage, at, provider)
      b = dockPricing.costOfUsage(model, usage, at, provider)
    } catch (err) {
      problems.push('pricing threw for ' + model + ': ' + (err && err.message))
      continue
    }
    diff('pricing ' + model, a, b, problems)
  }

  // 2. 计费源判定
  const sourceCases = [
    ['account:zai-start-plan', 'GLM-5.3', ''],
    ['cmdgo-bridge', 'claude-sonnet-5-5', ''],
    ['commandcode-goat-1', 'gpt-6-astra', ''],
    ['deepseek', 'deepseek-v4.1', 'https://api.deepseek.com'],
    ['', 'gemini-4-argon', 'https://generativelanguage.googleapis.com'],
    ['mimo', 'mimo-v2', 'https://token-plan-cn.xiaomimimo.com'],
    ['unknown', 'unknown-model', ''],
  ]
  for (const [pid, model, baseUrl] of sourceCases) {
    const a = legacySource.resolveBillingSource(pid, model, baseUrl, { glmSubscription: false })
    const b = dockSource.resolveBillingSource(pid, model, baseUrl, { glmSubscription: false })
    diff('source ' + [pid, model, baseUrl].join('|'), a, b, problems)
  }

  // 3. 平台用量折算
  const usage = {
    data: {
      biz_data: {
        series: [
          {
            model: 'deepseek-v4.1',
            buckets: [
              { time: Date.UTC(2026, 9, 19, 4, 0, 0), usage: { PROMPT_CACHE_HIT_TOKEN: 1000, PROMPT_CACHE_MISS_TOKEN: 2000, RESPONSE_TOKEN: 300 } },
              { time: Date.UTC(2026, 9, 19, 12, 0, 0), usage: { PROMPT_CACHE_HIT_TOKEN: 4000, PROMPT_CACHE_MISS_TOKEN: 5000, RESPONSE_TOKEN: 600 } },
            ],
          },
        ],
      },
    },
  }
  diff('balance.computeTodayUsage', legacyBalance.computeTodayUsage(usage), dockBalance.computeTodayUsage(usage), problems)

  if (problems.length) {
    for (const p of problems) console.error('✗ ' + p)
    console.error('engines parity 失败：' + problems.length + ' 项不一致')
    process.exit(1)
  }
  console.log('✅ engines parity 通过（价目 ' + cases.length + ' 组、计费源 ' + sourceCases.length + ' 组、平台用量 1 组）')
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
