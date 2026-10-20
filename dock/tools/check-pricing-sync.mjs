#!/usr/bin/env node
// 引擎副本同步检查：dock 里的 engines/{pricing,cmdgo,relays}.mjs 是挂件线
// lib/ 同名文件的**逐字节副本**。
//
// 为什么复制：dock 要能脱离挂件线独立运行（换目录/单独发版都不能 import 到别处）。
// 为什么检查：两套价目/套餐一旦漂移，同一个模型在两个产品里会算出两个金额，用户
// 第一眼就会发现。这个脚本在仓库里能找到源文件时做字节比较，找不到就明确跳过——
// dock 将来独立成仓时不会因此失败。
//
// 用法：node tools/check-pricing-sync.mjs [--fix]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAIRS = [
  { label: '价目内核', source: path.join(HERE, '..', '..', 'lib', 'pricing.mjs'), target: path.join(HERE, '..', 'engines', 'pricing.mjs') },
  { label: 'CommandCode 引擎', source: path.join(HERE, '..', '..', 'lib', 'cmdgo.mjs'), target: path.join(HERE, '..', 'engines', 'cmdgo.mjs') },
  { label: '中转站引擎', source: path.join(HERE, '..', '..', 'lib', 'relays.mjs'), target: path.join(HERE, '..', 'engines', 'relays.mjs') },
]

const fix = process.argv.includes('--fix')
const count = (buf) => buf.toString('utf8').split('\n').length
let failed = 0

for (const pair of PAIRS) {
  if (!fs.existsSync(pair.target)) {
    console.error('缺少 dock 的' + pair.label + '：' + pair.target)
    failed++
    continue
  }
  if (!fs.existsSync(pair.source)) {
    console.log('跳过：找不到挂件线源文件 ' + pair.source)
    continue
  }
  const a = fs.readFileSync(pair.source)
  const b = fs.readFileSync(pair.target)
  if (a.equals(b)) {
    console.log('✅ ' + pair.label + '与挂件线一致（' + a.length + ' 字节）')
    continue
  }
  if (fix) {
    fs.copyFileSync(pair.source, pair.target)
    console.log('已同步：' + pair.target + ' ← ' + pair.source)
    continue
  }
  console.error('❌ ' + pair.label + '已漂移')
  console.error('   源：' + pair.source + '（' + count(a) + ' 行）')
  console.error('   副本：' + pair.target + '（' + count(b) + ' 行）')
  failed++
}

if (failed) {
  console.error('   dock 与挂件线会用不同价目/套餐算出不同金额。确认哪边是对的之后：')
  console.error('   · 以挂件线为准：node tools/check-pricing-sync.mjs --fix')
  console.error('   · 以 dock 为准：先把改动回灌到 lib/，再 --fix')
  process.exit(1)
}
console.log('✅ 引擎副本同步检查通过')
