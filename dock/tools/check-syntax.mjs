#!/usr/bin/env node
// 语法检查：遍历 dock/ 下的 JS 源文件，逐个 `node --check`。
//
// 之前的命令把所有文件写死在 package.json 里，新增文件很容易漏检；
// 这里改成动态收集，排除依赖、截图产物与用户数据。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '__shots__', '__diff__', 'test-results', 'playwright-report', 'dist'])

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out)
    } else if (/\.(mjs|cjs|js)$/.test(e.name)) {
      out.push(p)
    }
  }
}

const files = []
walk(ROOT, files)
files.sort()

let failed = 0
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (r.status !== 0) {
    failed++
    console.error('语法错误：' + path.relative(ROOT, file))
    console.error((r.stderr || '').trim())
  }
}
console.log('已检查 ' + files.length + ' 个文件，失败 ' + failed + ' 个')
if (failed) process.exit(1)
