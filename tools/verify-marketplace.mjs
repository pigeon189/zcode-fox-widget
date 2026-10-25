#!/usr/bin/env node
// 校验 market 发布包（A 线自建市场 + B 线官方投稿素材）。
//
//   node tools/verify-marketplace.mjs              # 静态校验（秒级）
//   node tools/verify-marketplace.mjs --simulate   # 静态校验 + 把包当成「已安装插件」跑一遍自检
//
// 静态校验覆盖：
//   · 市场清单字段 / 插件清单字段 / 版本一致性（外层条目 vs plugin.json vs 目录）
//   · hooks 与 mcpServers 里 ${CODEBUDDY_PLUGIN_ROOT}/x 指向的文件真实存在
//   · skills/<name>/SKILL.md、commands/*.md
//   · 包内文件集合 = git 跟踪文件 - 打包剔除项（防止漏文件 / 混入未跟踪草稿）
//   · 运行时文本里没有绝对路径和疑似密钥
//   · 体积与文件数上限
//
// --simulate 会在临时目录里把包复制一份，按宿主的方式设置
// CODEBUDDY_PLUGIN_ROOT / CODEBUDDY_PLUGIN_DATA，然后：
//   · 对所有 js/mjs/cjs 做 node --check
//   · 跑插件自带 tools/selftest.mjs（隔离数据目录，不碰真实账单）
// 这一步是「包里的文件确实能跑」的证据，而不是只看 JSON。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const EXCLUDE = new Set([
  '.release-hashes.json',
  '.release-hashes.json.sig',
])
const DEV_EXCLUDE = [
  '.github/',
  'docs/',
  '.gitignore',
  '.gitattributes',
  '.zcodeignore',
  '.codebuddy-plugin/marketplace.json',
]
const isDevFile = (rel) => DEV_EXCLUDE.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p))

const args = new Set(process.argv.slice(2))
const SIMULATE = args.has('--simulate')

const problems = []
const notes = []
const fail = (msg) => problems.push(msg)
const note = (msg) => notes.push(msg)

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    fail(`${path.relative(ROOT, file)} 不是合法 JSON：${err.message}`)
    return null
  }
}

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isSymbolicLink()) {
      fail(`${path.relative(ROOT, full)} 是符号链接（包内不允许）`)
      continue
    }
    if (item.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function expectedFiles(variant) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .filter((rel) => !EXCLUDE.has(rel))
    .filter((rel) => variant === 'a' || !isDevFile(rel))
    .sort()
}

const EXPECTED = { a: expectedFiles('a'), b: expectedFiles('b') }

function checkFileSet(pluginDir, label, variant) {
  const actual = walk(pluginDir)
    .map((f) => path.relative(pluginDir, f).replace(/\\/g, '/'))
    .sort()
  const expected = EXPECTED[variant]
  const missing = expected.filter((f) => !actual.includes(f))
  const extra = actual.filter((f) => !expected.includes(f))
  if (missing.length) fail(`${label}：包内缺 ${missing.length} 个文件（例：${missing.slice(0, 3).join('、')}）`)
  if (extra.length) fail(`${label}：包内多出 ${extra.length} 个文件（例：${extra.slice(0, 3).join('、')}）`)
}

function checkManifest(pluginDir, entry, label) {
  const file = path.join(pluginDir, '.codebuddy-plugin', 'plugin.json')
  if (!fs.existsSync(file)) return fail(`${label}：缺 .codebuddy-plugin/plugin.json`)
  const p = readJson(file)
  if (!p) return
  for (const key of ['name', 'version', 'description']) {
    if (typeof p[key] !== 'string' || !p[key].trim()) fail(`${label}：plugin.json 缺 ${key}`)
  }
  if (p.name !== entry.name) fail(`${label}：plugin.json name=${p.name} 与市场条目 name=${entry.name} 不一致`)
  if (String(p.version) !== String(entry.version)) {
    fail(`${label}：plugin.json version=${p.version} 与市场条目 version=${entry.version} 不一致`)
  }
  if (!fs.existsSync(path.join(pluginDir, 'README.md'))) fail(`${label}：缺 README.md`)
  if (!fs.existsSync(path.join(pluginDir, 'LICENSE'))) fail(`${label}：缺 LICENSE`)

  // hooks
  const hooksRel = p.hooks
  if (hooksRel) {
    const hooksFile = path.join(pluginDir, String(hooksRel).replace(/^\.\//, ''))
    if (!fs.existsSync(hooksFile)) fail(`${label}：hooks 指向的 ${hooksRel} 不存在`)
    else {
      const hooks = readJson(hooksFile)
      for (const [event, groups] of Object.entries((hooks && hooks.hooks) || {})) {
        for (const group of Array.isArray(groups) ? groups : []) {
          for (const h of (group && group.hooks) || []) {
            const cmd = String(h.command || '')
            for (const m of cmd.matchAll(/\$\{CODEBUDDY_PLUGIN_ROOT\}\/([^"'\s]+)/g)) {
              const rel = m[1]
              if (!fs.existsSync(path.join(pluginDir, rel))) fail(`${label}：hook ${event} 引用的 ${rel} 不存在`)
            }
            if (cmd && !cmd.includes('${CODEBUDDY_PLUGIN_ROOT}')) {
              note(`${label}：hook ${event} 的命令没有用 \${CODEBUDDY_PLUGIN_ROOT}（安装后会指到别处）：${cmd.slice(0, 60)}`)
            }
          }
        }
      }
    }
  }

  // mcpServers
  const mcpRel = p.mcpServers
  if (typeof mcpRel === 'string') {
    const mcpFile = path.join(pluginDir, mcpRel.replace(/^\.\//, ''))
    if (!fs.existsSync(mcpFile)) fail(`${label}：mcpServers 指向的 ${mcpRel} 不存在`)
    else {
      const mcp = readJson(mcpFile)
      for (const [name, server] of Object.entries((mcp && mcp.mcpServers) || {})) {
        for (const arg of (server && server.args) || []) {
          const m = String(arg).match(/\$\{CODEBUDDY_PLUGIN_ROOT\}\/(.+)$/)
          if (m && !fs.existsSync(path.join(pluginDir, m[1]))) {
            fail(`${label}：mcp ${name} 引用的 ${m[1]} 不存在`)
          }
        }
      }
    }
  }

  // skills / commands
  const skillsDir = path.join(pluginDir, 'skills')
  if (fs.existsSync(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      if (!fs.existsSync(path.join(skillsDir, d.name, 'SKILL.md'))) fail(`${label}：skills/${d.name} 缺 SKILL.md`)
    }
  }
  const commandsDir = path.join(pluginDir, 'commands')
  if (fs.existsSync(commandsDir)) {
    for (const f of fs.readdirSync(commandsDir)) {
      if (!f.endsWith('.md')) continue
      if (!fs.readFileSync(path.join(commandsDir, f), 'utf8').trim()) fail(`${label}：commands/${f} 是空文件`)
    }
  }
}

function checkTextSafety(pluginDir, label) {
  const runtimeDirs = ['lib', 'desktop', 'hooks', 'commands', 'skills', '.codebuddy-plugin']
  const files = []
  for (const d of runtimeDirs) {
    const full = path.join(pluginDir, d)
    if (fs.existsSync(full)) files.push(...walk(full))
  }
  const mcp = path.join(pluginDir, '.mcp.json')
  if (fs.existsSync(mcp)) files.push(mcp)

  const absolute = [/[A-Za-z]:\\\\Users\\\\/i, /\/Users\//, /\/home\/[a-z0-9_.-]+\//i, /E:\\\\WorkSpace/i]
  const secrets = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-[A-Za-z0-9]{16,}\b/, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, /\bAKID[A-Za-z0-9]{13,}\b/]
  let scanned = 0
  for (const file of files) {
    const st = fs.statSync(file)
    if (st.size > 2 * 1024 * 1024) continue
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue
    scanned++
    for (const re of absolute) {
      if (re.test(text)) fail(`${label}：${path.relative(pluginDir, file)} 含绝对路径（${re}）`)
    }
    for (const re of secrets) {
      if (re.test(text)) fail(`${label}：${path.relative(pluginDir, file)} 疑似含密钥（${re}）`)
    }
  }
  note(`${label}：安全扫描 ${scanned} 个文本文件`)
}

function checkSize(pluginDir, label) {
  const files = walk(pluginDir)
  const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0)
  const mb = bytes / 1024 / 1024
  if (mb > 30) fail(`${label}：体积 ${mb.toFixed(2)} MB 超过 30 MB 上限`)
  if (files.length > 600) fail(`${label}：文件数 ${files.length} 超过 600`)
  note(`${label}：${files.length} 个文件 / ${mb.toFixed(2)} MB`)
  return { files: files.length, mb }
}

function checkMarketplace() {
  const dir = path.join(DIST, 'marketplace')
  const manifestFile = path.join(dir, '.codebuddy-plugin', 'marketplace.json')
  if (!fs.existsSync(manifestFile)) return fail('A 线：dist/marketplace 不存在，请先 node tools/build-marketplace.mjs')
  const m = readJson(manifestFile)
  if (!m) return
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(m.name || ''))) fail(`A 线：market name 不合法（${m.name}）`)
  if (!m.owner || !m.owner.name) fail('A 线：market 缺 owner.name')
  if (!Array.isArray(m.plugins) || m.plugins.length === 0) return fail('A 线：plugins 为空')

  const names = new Set()
  for (const entry of m.plugins) {
    if (names.has(entry.name)) fail(`A 线：插件重名 ${entry.name}`)
    names.add(entry.name)
    if (!/^\d+\.\d+\.\d+/.test(String(entry.version || ''))) fail(`A 线：${entry.name} version 不是 semver`)
    if (!String(entry.source || '').startsWith('./')) fail(`A 线：${entry.name} source 必须是 ./ 相对路径`)
    if (String(entry.source).includes('..')) fail(`A 线：${entry.name} source 不能跳出市场根目录`)
    const pluginDir = path.resolve(dir, entry.source)
    if (!pluginDir.startsWith(path.resolve(dir) + path.sep)) return fail(`A 线：${entry.name} source 指向市场外`)
    if (!fs.existsSync(pluginDir)) return fail(`A 线：${entry.name} source 目录不存在`)
    checkManifest(pluginDir, entry, `A/${entry.name}`)
    checkFileSet(pluginDir, `A/${entry.name}`, 'a')
    checkTextSafety(pluginDir, `A/${entry.name}`)
    checkSize(pluginDir, `A/${entry.name}`)
    if (fs.existsSync(path.join(pluginDir, '.release-hashes.json'))) fail(`A 线：包内不应带 .release-hashes.json`)
  }
  note(`A 线：market=${m.name} v${(m.metadata && m.metadata.version) || '?'}`)
  return dir
}

function checkOfficial() {
  const dir = path.join(DIST, 'official-submission')
  const entryFile = path.join(dir, 'marketplace-entry.json')
  if (!fs.existsSync(entryFile)) return fail('B 线：dist/official-submission 不存在，请先 node tools/build-marketplace.mjs')
  const entry = readJson(entryFile)
  if (!entry) return
  for (const key of ['name', 'version', 'description', 'source', 'license']) {
    if (!entry[key]) fail(`B 线：marketplace-entry.json 缺 ${key}`)
  }
  if (entry.source !== './external_plugins/fox-widget') {
    fail(`B 线：source 应为 ./external_plugins/fox-widget（当前 ${entry.source}）`)
  }
  const pluginDir = path.join(dir, 'external_plugins', 'fox-widget')
  if (!fs.existsSync(pluginDir)) return fail('B 线：external_plugins/fox-widget 不存在')
  checkManifest(pluginDir, entry, 'B/fox-widget')
  checkFileSet(pluginDir, 'B/fox-widget', 'b')
  checkTextSafety(pluginDir, 'B/fox-widget')
  checkSize(pluginDir, 'B/fox-widget')
  for (const f of ['PR.md', 'README.md']) {
    if (!fs.existsSync(path.join(dir, f))) fail(`B 线：缺 ${f}`)
  }
  return { dir, entry }
}

function simulateInstall(pluginDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-market-install-'))
  const target = path.join(tmp, 'plugins', 'fox-widget')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(pluginDir, target, { recursive: true })
  const dataDir = path.join(tmp, 'plugin-data')
  fs.mkdirSync(dataDir, { recursive: true })

  // 1) 语法检查（宿主最终也是用 node 跑这些文件）
  const codeFiles = walk(target).filter((f) => /\.(mjs|cjs|js)$/.test(f))
  let checked = 0
  for (const file of codeFiles) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (r.status !== 0) fail(`模拟安装：node --check 失败 ${path.relative(target, file)}：${(r.stderr || '').slice(0, 200)}`)
    checked++
  }
  note(`模拟安装：node --check ${checked} 个文件`)

  // 2) 在「已安装副本」里跑插件自检（隔离宿主数据与 dock）
  const env = { ...process.env, CODEBUDDY_PLUGIN_ROOT: target, CODEBUDDY_PLUGIN_DATA: dataDir }
  env.FOX_WIDGET_DATA_DIR = dataDir
  env.WHALE_DISABLE_UPDATE_CHECK = '1'
  env.FOX_DOCK_DATA = path.join(tmp, 'no-dock')
  delete env.FOX_DOCK_ROOT
  const run = spawnSync(process.execPath, [path.join(target, 'tools', 'selftest.mjs')], {
    cwd: target,
    env,
    encoding: 'utf8',
    timeout: 8 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const tail = (run.stdout || '').trim().split(/\r?\n/).slice(-1)[0] || ''
  if (run.status !== 0) {
    fail(`模拟安装：包内自检未通过（exit=${run.status}）${tail ? '：' + tail : ''}`)
    const failed = (run.stdout || '').split(/\r?\n/).filter((l) => l.includes('❌')).slice(0, 5)
    for (const line of failed) note(line.trim())
  } else {
    note(`模拟安装：包内自检通过（${tail || 'exit=0'}）`)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

const market = checkMarketplace()
const official = checkOfficial()

if (SIMULATE) {
  const pluginDir = market ? path.join(market, 'plugins', 'fox-widget') : null
  if (pluginDir && fs.existsSync(pluginDir)) simulateInstall(pluginDir)
  else fail('模拟安装：A 线包不存在，跳过不了')
}

for (const n of notes) console.log('  · ' + n)
if (problems.length) {
  console.error(`\n✗ 校验失败 ${problems.length} 项：`)
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('\n✓ 全部通过（市场清单 / 插件清单 / 引用文件 / 文件集合 / 安全扫描 / 体积）')
