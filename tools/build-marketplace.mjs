#!/usr/bin/env node
// 生成两套「市场分发包」，只读当前工作树，不改仓库里其他文件：
//
//   dist/marketplace/            自建套件市场（A 线）
//                                用户在「技能 → 套件 → 新增市场」里填 pigeon189/fox-widget-marketplace
//   dist/official-submission/    官方套件市场 PR 素材（B 线）
//                                cnb.cool/codebuddy/marketplace（README 明确「欢迎提交 PR」）
//
// 用法：
//   node tools/build-marketplace.mjs             # 两套都生成
//   node tools/build-marketplace.mjs --only=a    # 只生成自建市场
//   node tools/build-marketplace.mjs --only=b    # 只生成官方投稿素材
//
// 打包口径（与「本地目录安装」保持一致，避免出现两份不一样的包）：
//   · 只打 git 跟踪的文件——未跟踪的草稿（如 MIGRATE-TO-FOX-DOCK-2.md）不会漏进包里
//   · 排除 .release-hashes.json / .sig：这是给「挂件内自更新」用的签名清单，
//     而市场安装的升级路径是「刷新市场 + 重装」。带上一份过期清单只会让
//     自更新报「包体可能被镜像篡改」，误导用户；不带时更新器会给出
//     「请改用市场重新抓取」的正确提示（见 lib/update.mjs）
//   · 仓库根的 .codebuddy-plugin/marketplace.json **保留**：本地目录安装
//     （source "./"）实测就带着它，包内三处版本一致性断言也依赖它；
//     它在插件目录里只是一份普通 JSON，宿主不会把它当成嵌套市场
//
// 产物是纯静态文件，可重复生成；dist/ 已在 .gitignore 里。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')

const MARKETPLACE_NAME = 'fox-widget-marketplace'
const MARKETPLACE_REPO = 'pigeon189/fox-widget-marketplace'
const SOURCE_REPO = 'pigeon189/zcode-fox-widget'
const SOURCE_BRANCH = 'workbuddy'

// 打包时剔除的文件（相对仓库根）
const EXCLUDE = new Set([
  '.release-hashes.json',
  '.release-hashes.json.sig',
])

// 官方投稿包再剔一层开发文件：审核看的是插件，不是仓库历史与 CI
const DEV_EXCLUDE = [
  '.github/',
  'docs/',
  '.gitignore',
  '.gitattributes',
  '.zcodeignore',
  '.codebuddy-plugin/marketplace.json',
]
const isDevFile = (rel) => DEV_EXCLUDE.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p))

const SHORT_DESC =
  'WorkBuddy 桌宠挂件：常驻右下角显示今日积分、本轮消耗 credit 与上下文余量，另有用量账本、六套角色、按压泡泡、桌宠模式与桌面浮层。'

const plugin = readJson(path.join(ROOT, '.codebuddy-plugin', 'plugin.json'))
const version = String(plugin.version || '').trim()
if (!version) throw new Error('.codebuddy-plugin/plugin.json 缺 version')

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()

const commit = git('rev-parse', '--short', 'HEAD')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean)
  .filter((rel) => !EXCLUDE.has(rel))

const filesFor = (variant) => tracked.filter((rel) => variant === 'a' || !isDevFile(rel))

function makeEntry(source) {
  return {
    name: 'fox-widget',
    description: SHORT_DESC,
    description_en:
      "A WorkBuddy desktop-pet widget showing today's credits, this turn's credit spend and context headroom, with a usage ledger, six characters, press bubbles, desktop-pet mode and a transparent always-on-top overlay.",
    version,
    source,
    category: 'productivity',
    author: { name: 'pigeon189', url: 'https://github.com/pigeon189' },
    homepage: `https://github.com/${SOURCE_REPO}/tree/${SOURCE_BRANCH}`,
    repository: `https://github.com/${MARKETPLACE_REPO}`,
    license: 'MIT',
    keywords: Array.isArray(plugin.keywords) ? plugin.keywords : ['workbuddy', 'widget'],
  }
}

const entryA = makeEntry('./plugins/fox-widget')
const entryB = makeEntry('./external_plugins/fox-widget')

const marketplace = {
  name: MARKETPLACE_NAME,
  description: 'WorkBuddy狐娘小挂件（fox-widget）自建套件市场：桌宠 + 积分账本，一条市场源装好。',
  owner: { name: 'pigeon189', url: 'https://github.com/pigeon189' },
  metadata: {
    version,
    source: `https://github.com/${SOURCE_REPO}/tree/${SOURCE_BRANCH}`,
    commit,
    branch: SOURCE_BRANCH,
  },
  plugins: [entryA],
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function copyPayload(destRoot, files) {
  let bytes = 0
  for (const rel of files) {
    const src = path.join(ROOT, rel)
    const dst = path.join(destRoot, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    const mode = fs.statSync(src).mode
    if (process.platform !== 'win32' && mode & 0o111) fs.chmodSync(dst, 0o755)
    bytes += fs.statSync(dst).size
  }
  return { files: files.length, bytes }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text.replace(/\r\n/g, '\n'), 'utf8')
}

function buildMarketplace() {
  const out = path.join(DIST, 'marketplace')
  rmrf(out)
  const payload = copyPayload(path.join(out, 'plugins', 'fox-widget'), filesFor('a'))
  writeJson(path.join(out, '.codebuddy-plugin', 'marketplace.json'), marketplace)
  writeText(path.join(out, 'README.md'), marketplaceReadme())
  writeText(path.join(out, '.gitignore'), '*.log\n.DS_Store\nThumbs.db\n')
  fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(out, '.gitattributes'))
  return { out, payload }
}

function buildOfficial() {
  const out = path.join(DIST, 'official-submission')
  rmrf(out)
  const payload = copyPayload(path.join(out, 'external_plugins', 'fox-widget'), filesFor('b'))
  writeJson(path.join(out, 'marketplace-entry.json'), entryB)
  writeText(path.join(out, 'PR.md'), officialPr())
  writeText(path.join(out, 'README.md'), officialReadme())
  return { out, payload }
}

function marketplaceReadme() {
  return `# fox-widget-marketplace

[WorkBuddy狐娘小挂件（fox-widget）](https://github.com/${SOURCE_REPO}/tree/${SOURCE_BRANCH}) 的自建套件市场。
本仓库只有市场清单和插件副本，源码、问题与讨论都在源码仓库。

- 当前版本：**v${version}**
- 同步自：\`${SOURCE_REPO}@${SOURCE_BRANCH}\`（${commit}）
- 平台：Windows（桌面浮层依赖 Win32；其余功能在 macOS / Linux 上只能用本地页面）

## 安装

1. WorkBuddy 左栏「专家 · 技能 · 连接器」→「技能」→「套件」
2. 右上角「添加」→「新增市场」
3. 市场源填：

   \`\`\`text
   ${MARKETPLACE_REPO}
   \`\`\`

4. 市场里出现 \`fox-widget\`，点 + 安装，作用域选 **user**
5. 重启会话（或重开客户端），让 hooks 与 MCP 生效
6. 需要桌面浮层时再装运行时（约 150MB 下载，一次性）：

   \`\`\`bash
   node lib/cli.mjs desktop install
   \`\`\`

> 宿主不认 \`owner/repo#分支\`。本仓库默认分支就是市场内容，所以直接填 \`${MARKETPLACE_REPO}\` 即可；
> 若所在环境禁用「新增市场」，可改用分支 ZIP：
> \`https://github.com/${SOURCE_REPO}/archive/refs/heads/${SOURCE_BRANCH}.zip\`

## 升级

市场页「刷新」→ 重装 → 重启客户端。数据在插件数据目录，配置、账本、导入的角色都不丢。
本市场**不启用**挂件内自更新（原地覆盖会和宿主插件管理打架）。

## 它会做什么

- 读宿主的用量数据（\`workbuddy.db\` 与会话 transcript）汇总今日积分、本轮消耗、上下文余量
- \`SessionStart\` 钩子幂等拉起本地挂件服务；\`UserPromptSubmit\` / \`Notification\` 写低频事件
- 提供 MCP 工具 \`whale_balance\` / \`whale_last_turn\` / \`whale_widget\` / \`whale_config\`
- 可选：读 \`DEEPSEEK_API_KEY\` 或插件数据目录 \`config.json\` 里的 key，显示厂商余额（不配也能用）
- 桌面浮层是一个独立的透明置顶窗口，指针不在角色上时点击穿透

## 许可

MIT。素材与沿革见插件目录内的 \`NOTICE\` 与 \`LICENSE\`。
`
}

function officialPr() {
  return `# 提交说明（官方套件市场）

目标仓库：\`https://cnb.cool/codebuddy/marketplace\`（CodeBuddy 官方插件市场，README 写明「欢迎提交 PR」）

本目录由 \`node tools/build-marketplace.mjs --only=b\` 生成。推荐直接落到自己的 fork（登录 CNB 后）：

\`\`\`bash
CNB_TOKEN=<令牌> node tools/prepare-official-pr.mjs --repo https://cnb.cool/<你的账号>/marketplace
\`\`\`

脚本会克隆 fork、放插件、只在清单末尾追加一条、提交并推送分支；下面是想手动操作时的步骤与 PR 文案。

## 一、要改的两处（手动做法）

1. 把 \`external_plugins/fox-widget/\` 整个目录拷进官方仓库的 \`external_plugins/fox-widget/\`
2. 在官方仓库根的 \`.codebuddy-plugin/marketplace.json\` 的 \`plugins\` 数组里追加一条
   （内容见本目录的 \`marketplace-entry.json\`，追加后保持原有的字段顺序风格）

## 二、PR 标题与正文

**标题**

\`\`\`text
feat(plugin): add fox-widget（WorkBuddy 狐娘小挂件 · 桌宠 + 积分账本）
\`\`\`

**正文**

\`\`\`markdown
## 插件简介

WorkBuddy 桌面桌宠挂件：常驻窗口右下角，显示今日积分、本轮消耗 credit 与上下文余量；
另有用量账本（今日 / 近 7 天 / 逐轮）、六套内置角色、按压泡泡、桌宠模式与透明置顶浮层。

- 作者：pigeon189
- 源码：https://github.com/${SOURCE_REPO}/tree/${SOURCE_BRANCH}
- 许可：MIT（沿革与素材授权见插件内 NOTICE）

## 组件

| 组件 | 内容 |
| --- | --- |
| hooks | \`SessionStart\` 幂等拉起本地挂件服务；\`UserPromptSubmit\` / \`Notification\` 写低频事件（均为本地进程，5–20s 超时） |
| MCP | \`whale_balance\` / \`whale_last_turn\` / \`whale_widget\` / \`whale_config\` |
| skills | \`fox-widget\`（用法问答）、\`fox-pricing-review\`（维护者价目复核） |
| commands | \`/fox\` |

## 数据与网络

- 读取：宿主 \`workbuddy.db\`、会话 transcript、\`settings.json\`（只读）
- 写入：仅插件数据目录 \`\${CODEBUDDY_PLUGIN_DATA}\`（配置、账本、日志）
- 出站：默认**不联网**；仅当用户配置了厂商 key 时，向对应厂商的余额接口发请求
  （DeepSeek 等，可在设置里留空即完全不出网）
- 无遥测、无上报、无自动更新（市场安装版关闭挂件内自更新，升级走市场刷新）

## 自检

\`\`\`bash
node tools/selftest.mjs          # 430/430 通过
node tools/selftest-update.mjs   # 更新内核用例通过
node tools/smoke-ui.mjs          # 页面冒烟（无头浏览器）
\`\`\`

包内不含密钥、不含绝对路径、不含 node_modules；插件清单见
\`external_plugins/fox-widget/.codebuddy-plugin/plugin.json\`，README 见 \`external_plugins/fox-widget/README.md\`。

## 截图

\`external_plugins/fox-widget/assets/example.png\`、\`assets/wb.png\`
\`\`\`

## 三、提交前核对

- [ ] 官方仓库 \`marketplace.json\` 里 \`name\` 不与既有插件重名（当前无 \`fox-widget\`）
- [ ] \`external_plugins/fox-widget/.codebuddy-plugin/plugin.json\` 完整（\`name\` / \`version\` / \`description\` / \`license\` / \`author\`）
- [ ] 目录内含 \`README.md\` 与 \`LICENSE\`
- [ ] 不含 \`.release-hashes.json*\`（本次已剔除）、不含私钥
- [ ] 若官方要求英文描述，\`description_en\` 已随条目提供

## 四、说明

官方市场是**人工审核**渠道，没有自助上传入口；能不能过取决于审核对
「SessionStart 自动拉起常驻进程 + 桌面浮层」的接受度。若被拒，A 线的自建市场不受影响。
`
}

function officialReadme() {
  return `# 官方套件市场投稿素材（fox-widget v${version}）

本目录不是可直接运行的项目，只是给 \`cnb.cool/codebuddy/marketplace\` 提 PR 用的材料：

- \`external_plugins/fox-widget/\` —— 原样拷进官方仓库的同名目录（第三方插件都放这里）
- \`marketplace-entry.json\` —— 追加到官方 \`.codebuddy-plugin/marketplace.json\` 的 \`plugins\` 数组
- \`PR.md\` —— PR 标题、正文与提交前核对清单

来源：\`${SOURCE_REPO}@${SOURCE_BRANCH}\`（${commit}）。
`
}

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'both'

let result = {}
if (only === 'a' || only === 'both') result.marketplace = buildMarketplace()
if (only === 'b' || only === 'both') result.official = buildOfficial()

for (const [key, value] of Object.entries(result)) {
  const mb = (value.payload.bytes / 1024 / 1024).toFixed(2)
  console.log(`✓ ${key}: ${path.relative(ROOT, value.out)}（${value.payload.files} 个文件，${mb} MB）`)
}
console.log(`  版本 v${version} · ${SOURCE_BRANCH}@${commit}`)
