#!/usr/bin/env node
// 静态守卫：把「评审时反复要人肉检查」的几条硬约束变成可执行检查。
//
//   1. ui/ 内禁止 innerHTML / outerHTML / document.write / eval / new Function / insertAdjacentHTML
//   2. overlay/main.cjs 必须保留 type:'toolbar'（删掉会复发宿主冻结事故）
//   3. 两个 Electron 入口必须 contextIsolation:true / sandbox:true / nodeIntegration:false
//   4. 源码、示例、夹具、文档里不得出现可用的 sk- 密钥或 Bearer token
//
// 退出码 0 = 全部通过。

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
    } else {
      out.push(p)
    }
  }
}

const files = []
walk(ROOT, files)

const problems = []
const rel = (f) => path.relative(ROOT, f)

// 1. UI 禁用危险 DOM 通道
const FORBIDDEN_UI = [
  { re: /\binnerHTML\b/, name: 'innerHTML' },
  { re: /\bouterHTML\b/, name: 'outerHTML' },
  { re: /\bdocument\.write\b/, name: 'document.write' },
  { re: /\beval\s*\(/, name: 'eval()' },
  { re: /\bnew\s+Function\b/, name: 'new Function' },
  { re: /\binsertAdjacentHTML\b/, name: 'insertAdjacentHTML' },
]
for (const file of files) {
  if (!file.includes(path.sep + 'ui' + path.sep)) continue
  if (!/\.(mjs|cjs|js|html)$/.test(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  for (const rule of FORBIDDEN_UI) {
    if (rule.re.test(text)) problems.push(rel(file) + ' 使用了被禁止的 ' + rule.name)
  }
}

// 2. toolbar 守卫
const overlayMain = path.join(ROOT, 'overlay', 'main.cjs')
if (fs.existsSync(overlayMain)) {
  const text = fs.readFileSync(overlayMain, 'utf8')
  if (!/type:\s*'toolbar'/.test(text)) {
    problems.push('overlay/main.cjs 缺少 type:\'toolbar\'（宿主冻结事故的守卫，不得删除）')
  }
}

// 3. Electron 安全配置
for (const entry of ['overlay/main.cjs', 'console/main.cjs']) {
  const file = path.join(ROOT, entry)
  if (!fs.existsSync(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  if (/nodeIntegration\s*:\s*true/.test(text)) problems.push(entry + ' 打开了 nodeIntegration')
  if (/contextIsolation\s*:\s*false/.test(text)) problems.push(entry + ' 关闭了 contextIsolation')
  if (/sandbox\s*:\s*false/.test(text)) problems.push(entry + ' 关闭了 sandbox')
}

// 4. 凭据扫描（只认「看起来可用」的长密钥；文档里的 sk-•••• 掩码不算）
const SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, name: 'sk- 密钥' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g, name: 'Bearer token' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/g, name: 'GitHub token' },
]
for (const file of files) {
  if (!/\.(mjs|cjs|js|json|md|txt|yml|yaml|ps1|vbs)$/.test(file)) continue
  const text = fs.readFileSync(file, 'utf8')
  for (const rule of SECRET_PATTERNS) {
    rule.re.lastIndex = 0
    const m = rule.re.exec(text)
    if (m) problems.push(rel(file) + ' 疑似包含' + rule.name + '（' + m[0].slice(0, 8) + '…）')
  }
}

if (problems.length) {
  for (const p of problems) console.error('✗ ' + p)
  console.error('lint 失败：' + problems.length + ' 项')
  process.exit(1)
}
console.log('lint 通过：' + files.length + ' 个文件（危险 DOM 通道 / toolbar 守卫 / Electron 安全配置 / 凭据扫描）')
