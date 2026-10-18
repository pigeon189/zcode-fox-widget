#!/usr/bin/env node
// 价目内核同步检查：dock 里的 pricing.mjs 是挂件线 lib/pricing.mjs 的**逐字节副本**。
//
// 为什么复制：dock 要能脱离挂件线独立运行（换目录/单独发版都不能 import 到别处）。
// 为什么检查：两套价目一旦漂移，同一个模型在两个产品里会算出两个金额，用户第一眼
// 就会发现。这个脚本在仓库里能找到源文件时做字节比较，找不到就明确跳过——dock 将来
// 独立成仓时不会因此失败。
//
// 用法：node tools/check-pricing-sync.mjs [--fix]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TARGET = path.join(HERE, '..', 'adapters', 'zcode', 'pricing.mjs')
const SOURCE = path.join(HERE, '..', '..', 'lib', 'pricing.mjs')

if (!fs.existsSync(TARGET)) {
  console.error('缺少 dock 的价目内核：' + TARGET)
  process.exit(1)
}
if (!fs.existsSync(SOURCE)) {
  console.log('跳过：找不到挂件线源文件 ' + SOURCE)
  process.exit(0)
}

const a = fs.readFileSync(SOURCE)
const b = fs.readFileSync(TARGET)

if (a.equals(b)) {
  console.log('✅ 价目内核与挂件线一致（' + a.length + ' 字节）')
  process.exit(0)
}

if (process.argv.includes('--fix')) {
  fs.copyFileSync(SOURCE, TARGET)
  console.log('已同步：' + TARGET + ' ← ' + SOURCE)
  process.exit(0)
}

const count = (buf) => buf.toString('utf8').split('\n').length
console.error('❌ 价目内核已漂移')
console.error('   源：' + SOURCE + '（' + count(a) + ' 行）')
console.error('   副本：' + TARGET + '（' + count(b) + ' 行）')
console.error('   dock 与挂件线会用不同价目算出不同金额。确认哪边是对的之后：')
console.error('   · 以挂件线为准：node tools/check-pricing-sync.mjs --fix')
console.error('   · 以 dock 为准：先把改动回灌到 lib/pricing.mjs，再 --fix')
process.exit(1)
