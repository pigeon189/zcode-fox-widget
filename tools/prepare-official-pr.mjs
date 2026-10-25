#!/usr/bin/env node
// 把 dist/official-submission 应用到官方套件市场仓库，生成一个可直接提 PR 的提交（B 线）。
//
//   node tools/prepare-official-pr.mjs --repo https://cnb.cool/codebuddy/marketplace.git --dry-run
//       在临时克隆里完整演练一遍（不改远端），打印 diff 统计
//
//   CNB_TOKEN=<令牌> node tools/prepare-official-pr.mjs --repo https://cnb.cool/<你的账号>/marketplace
//       往自己的 fork 推一个分支，然后在 CNB 网页上点「新建合并请求」
//
// 做三件事（与官方仓库现有约定对齐）：
//   1. 把插件放进 external_plugins/fox-widget/（第三方插件都在这里，plugins/ 是官方自有）
//   2. 在 .codebuddy-plugin/marketplace.json 的 plugins 数组末尾追加一条（只动这一处）
//   3. 提交并推送分支，打印 PR 地址
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUBMISSION = path.join(ROOT, 'dist', 'official-submission')
const PLUGIN_NAME = 'fox-widget'

const argv = process.argv.slice(2)
const getArg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : ''
}
const repo = getArg('--repo')
const branch = getArg('--branch') || 'feat/fox-widget'
const dryRun = argv.includes('--dry-run')
const keepTemp = argv.includes('--keep-temp')
if (!repo) {
  console.error('用法：node tools/prepare-official-pr.mjs --repo https://cnb.cool/<你的账号>/marketplace [--dry-run]')
  process.exit(2)
}
if (/^git@/i.test(repo)) {
  console.error(
    'CNB 不支持 SSH（官方文档明确只支持 HTTPS + 访问令牌）。\n' +
      '请改用：--repo https://cnb.cool/<你的账号>/marketplace'
  )
  process.exit(2)
}

// CNB 的认证是「用户名固定 cnb + 访问令牌」，与 GitHub CLI 的 gh token 完全无关。
// 令牌来源优先级：CNB_TOKEN > --token-file > 已登录的 cnb CLI。
const tokenFile = getArg('--token-file')
const cnbToken = (process.env.CNB_TOKEN || (tokenFile ? fs.readFileSync(tokenFile, 'utf8') : '')).trim()
let hasCnbCli = false
try {
  execFileSync('cnb', ['--version'], { stdio: 'ignore' })
  hasCnbCli = true
} catch {}

if (!dryRun && !cnbToken && !hasCnbCli) {
  console.error(
    [
      '需要 CNB 访问令牌（gh 的 GitHub 登录在这里用不上，CNB 是独立账号体系）：',
      '  1) 微信扫码登录 https://cnb.cool，按提示完成实名认证',
      '  2) 打开 https://cnb.cool/profile/token → 添加访问令牌（勾上仓库写权限）',
      '  3) 设进环境变量后重跑：',
      '     CNB_TOKEN=<令牌> node tools/prepare-official-pr.mjs --repo https://cnb.cool/<你的账号>/marketplace',
      '',
      '  令牌不会写进任何文件；脚本只在 git 子进程的环境里用它。',
    ].join('\n')
  )
  process.exit(2)
}

// 用 credential helper 从环境变量取令牌，避免令牌出现在命令行参数里
const AUTH_ARGS = cnbToken
  ? ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo username=cnb; echo "password=$CNB_TOKEN"; }; f']
  : ['-c', 'credential.helper=', '-c', 'credential.helper=!cnb git-credential']
const CHILD_ENV = { ...process.env, ...(cnbToken ? { CNB_TOKEN: cnbToken } : {}) }

function git(cwd, ...args) {
  return execFileSync('git', [...AUTH_ARGS, ...args], {
    cwd,
    env: CHILD_ENV,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, env: CHILD_ENV, encoding: 'utf8', stdio: 'pipe' })
}

// 0) 素材不存在就先构建
if (!fs.existsSync(path.join(SUBMISSION, 'marketplace-entry.json'))) {
  console.log('· 生成 dist/official-submission …')
  run(process.execPath, [path.join(ROOT, 'tools', 'build-marketplace.mjs'), '--only=b'], ROOT)
}

const entry = JSON.parse(fs.readFileSync(path.join(SUBMISSION, 'marketplace-entry.json'), 'utf8'))
const payloadDir = path.join(SUBMISSION, 'external_plugins', PLUGIN_NAME)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-official-pr-'))
const clone = path.join(tmp, 'repo')
console.log(`· 克隆 ${repo} …`)
run('git', [...AUTH_ARGS, 'clone', '--depth', '1', repo, clone], tmp)

// 1) 确认目标确实是官方市场仓库
const manifestPath = path.join(clone, '.codebuddy-plugin', 'marketplace.json')
if (!fs.existsSync(manifestPath)) throw new Error('目标仓库没有 .codebuddy-plugin/marketplace.json')
const manifestText = fs.readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(manifestText)
if (!Array.isArray(manifest.plugins)) throw new Error('目标 marketplace.json 结构不对')
if (manifest.plugins.some((p) => p.name === entry.name)) throw new Error(`目标市场里已经有 ${entry.name}，无需重复提交`)

// 2) 放插件
const targetPlugin = path.join(clone, 'external_plugins', PLUGIN_NAME)
if (fs.existsSync(targetPlugin)) throw new Error(`目标仓库已有 external_plugins/${PLUGIN_NAME}`)
fs.mkdirSync(path.dirname(targetPlugin), { recursive: true })
fs.cpSync(payloadDir, targetPlugin, { recursive: true })

// 3) 只在数组末尾追加一条，保留原有格式与换行风格（官方文件是 CRLF 也没有末尾换行）
const eol = manifestText.includes('\r\n') ? '\r\n' : '\n'
const tail = /\r?\n( +)\]\s*\}\s*$/.exec(manifestText)
if (!tail) throw new Error('marketplace.json 的 plugins 数组结尾格式不符合预期（找不到 "\\n  ]\\n}"）')
const entryText = JSON.stringify(entry, null, 2).split('\n').join(eol + '    ')
const nextText =
  manifestText.slice(0, tail.index) + ',' + eol + '    ' + entryText + manifestText.slice(tail.index)
JSON.parse(nextText) // 写盘前先确认还是合法 JSON
fs.writeFileSync(manifestPath, nextText, 'utf8')

// 4) 提交
git(clone, 'checkout', '-q', '-b', branch)
git(clone, 'add', '-A')
const message = `feat(plugin): add ${PLUGIN_NAME}（WorkBuddy 狐娘小挂件 · 桌宠 + 积分账本）`
git(clone, '-c', 'user.name=pigeon189', '-c', 'user.email=pigeon189@users.noreply.github.com', 'commit', '-q', '-m', message)
console.log(`· 已提交：${message}`)
console.log(git(clone, 'show', '--stat', '--oneline', 'HEAD').split('\n').slice(0, 6).join('\n'))

if (dryRun) {
  console.log('\n· --dry-run：不推送。完整 diff 统计：')
  console.log(git(clone, 'diff', '--stat', 'HEAD~1', 'HEAD').split('\n').slice(-3).join('\n'))
} else {
  console.log(`· 推送分支 ${branch} …`)
  git(clone, 'push', '-u', 'origin', branch)
  const web = repo.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '').replace(/^https:\/\/[^/]+\//, 'https://cnb.cool/')
  console.log(`\n✓ 分支已推送。打开 ${web} 新建合并请求（源分支 ${branch} → 目标 main）`)
}

if (keepTemp) console.log(`\n· 临时克隆保留在：${clone}`)
else fs.rmSync(tmp, { recursive: true, force: true })
