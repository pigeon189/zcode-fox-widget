#!/usr/bin/env node
// 把 dist/marketplace 同步到自建市场仓库（A 线）。
//
//   node tools/publish-marketplace.mjs                      # 生成 + 同步 + 提交 + 推送
//   node tools/publish-marketplace.mjs --dry-run            # 只生成并在临时目录里演练，不推送
//   node tools/publish-marketplace.mjs --repo <git-url>     # 指定仓库（默认读下面的常量）
//
// 做法：把远端仓库浅克隆到临时目录，用新产物整体替换工作树，有差异才提交。
// 这样不需要 force push，也不会把本地 dist/ 的 .git 弄脏。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist', 'marketplace')
const DEFAULT_REPO = 'git@github.com:pigeon189/fox-widget-marketplace.git'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const repoIndex = argv.indexOf('--repo')
const repo = repoIndex >= 0 ? argv[repoIndex + 1] : DEFAULT_REPO
if (!repo) throw new Error('--repo 后面要跟仓库地址')

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

// 1) 先构建（构建脚本自己会清理旧产物）
console.log('· 生成 dist/marketplace …')
run(process.execPath, [path.join(ROOT, 'tools', 'build-marketplace.mjs'), '--only=a'], ROOT)

const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.codebuddy-plugin', 'plugin.json'), 'utf8'))
const version = plugin.version
const sourceCommit = git(ROOT, 'rev-parse', '--short', 'HEAD')

// 2) 浅克隆远端到临时目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-market-publish-'))
const clone = path.join(tmp, 'repo')
console.log(`· 克隆 ${repo} …`)
run('git', ['clone', '--depth', '1', repo, clone], tmp)

// 3) 用新产物整体替换工作树（保留 .git）
for (const item of fs.readdirSync(clone)) {
  if (item === '.git') continue
  fs.rmSync(path.join(clone, item), { recursive: true, force: true })
}
fs.cpSync(DIST, clone, { recursive: true })

// 4) 有差异才提交
const dirty = git(clone, 'status', '--porcelain')
if (!dirty) {
  console.log('· 远端内容与本地产物一致，无需提交')
} else {
  git(clone, 'add', '-A')
  const message = `chore: publish fox-widget v${version} (source ${sourceCommit})`
  git(clone, '-c', 'user.name=pigeon189', '-c', 'user.email=pigeon189@users.noreply.github.com', 'commit', '-m', message)
  console.log(`· 提交：${message}`)
  if (dryRun) {
    console.log('· --dry-run：跳过推送；差异如下')
    console.log(git(clone, 'show', '--stat', '--oneline', 'HEAD'))
  } else {
    git(clone, 'push', 'origin', 'HEAD')
    console.log('· 已推送')
  }
}

const remote = repo.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '')
console.log(`\n✓ 市场源：${remote}`)
console.log('  用户在「技能 → 套件 → 新增市场」里填 owner/repo（如 pigeon189/fox-widget-marketplace）')

if (dryRun) fs.rmSync(tmp, { recursive: true, force: true })
else fs.rmSync(tmp, { recursive: true, force: true })
