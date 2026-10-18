#!/usr/bin/env node
// 测试调度器：Node 的 `--test <dir>` 在 22.x 会把目录当文件跑，所以这里自己
// 收集文件再交给 node --test。零依赖，Windows/mac 都能用。
//
//   node tools/run-tests.mjs --suite unit
//   node tools/run-tests.mjs --suite integration
//   node tools/run-tests.mjs --suite all

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUITES = {
  unit: { dir: 'test/unit', suffix: '.test.mjs' },
  integration: { dir: 'test/integration', suffix: '.itest.mjs' },
  e2e: { dir: 'test/e2e', suffix: '.e2e.mjs' },
}

function walk(dir) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

function collect(suite) {
  const spec = SUITES[suite]
  if (!spec) throw new Error('unknown suite: ' + suite)
  return walk(path.join(ROOT, spec.dir)).filter((f) => f.endsWith(spec.suffix))
}

const args = process.argv.slice(2)
const suiteArg = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : 'unit'
const suites = suiteArg === 'all' ? ['unit', 'integration'] : [suiteArg]
const files = suites.flatMap((s) => collect(s))

if (!files.length) {
  console.error('no test files for suite: ' + suiteArg)
  process.exit(1)
}

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: ROOT })
child.on('exit', (code) => process.exit(code == null ? 1 : code))
