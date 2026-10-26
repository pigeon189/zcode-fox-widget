import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 测试脚手架里的 node:sqlite 写连接必须带 busy timeout（{ timeout: 5000 }）：
// 这些连接与 daemon 侧的只读连接（adapters/zcode/store.mjs 等 timeout:2000-5000）
// 抢同一把 Windows 文件锁，不给 timeout 时 CI 慢盘上会偶发 SQLITE_BUSY/EPERM，
// 把一次时序抖动放大成整轮失败（AGENTS.md「已知坑」；1.x 同类修复见
// workbuddy 线 18bcf51 fix(selftest)）。此守卫防止新增测试连接再漏配。
// 确实不需要等待的连接可显式写 { timeout: 0 } 通过守卫。

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['unit', 'integration', 'e2e']
// 守卫自身的源码里有 "DatabaseSync(" 字面量（正则 / 报错文案），跳过不扫。
const SELF = fileURLToPath(import.meta.url)

function* listTestFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* listTestFiles(full)
    else if (entry.isFile() && entry.name.endsWith('.mjs')) yield full
  }
}

function findDatabaseSyncCalls(source) {
  const calls = []
  // 锚点不能只认 `new DatabaseSync(`：别名形式 `new sqlite.DatabaseSync(`
  // （或任何 `xx.DatabaseSync(`）同样要入扫，否则新增连接可以换写法绕过守卫。
  const re = /DatabaseSync\s*\(/g
  let m
  while ((m = re.exec(source))) {
    let depth = 0
    let end = m.index + m[0].length
    for (; end < source.length; end++) {
      const ch = source[end]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          end++
          break
        }
      }
    }
    calls.push({ index: m.index, text: source.slice(m.index, end) })
  }
  return calls
}

test('test db: 所有测试脚手架的 node:sqlite 连接都带 busy timeout', () => {
  let total = 0
  for (const sub of SCAN_DIRS) {
    const dir = path.join(testRoot, sub)
    if (!fs.existsSync(dir)) continue
    for (const file of listTestFiles(dir)) {
      if (path.resolve(file) === SELF) continue
      const source = fs.readFileSync(file, 'utf8')
      for (const call of findDatabaseSyncCalls(source)) {
        total++
        assert.match(
          call.text,
          /timeout\s*:/,
          `${path.relative(testRoot, file)} 的 DatabaseSync(...) 缺 busy timeout：\n${call.text}`
        )
      }
    }
  }
  // 守卫自身失效（比如正则/解析坏了、目录没扫到）时宁可失败，不要静默通过。
  // 现存直写 + 别名形式共 23 处，给少量余量防将来夹具合并时误报。
  assert.ok(total >= 20, `应至少扫描到 20 处 DatabaseSync 连接，实际 ${total} 处`)
})
