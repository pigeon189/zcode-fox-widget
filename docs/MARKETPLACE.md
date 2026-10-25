# 市场发布（套件 / 插件市场）

> 状态：常青。A 线已上线；B 线已提交 PR [#45](https://cnb.cool/codebuddy/marketplace/-/pulls/45)（待审核）。
> 相关脚本：`tools/build-marketplace.mjs`、`tools/verify-marketplace.mjs`、`tools/publish-marketplace.mjs`、`tools/prepare-official-pr.mjs`。

## 一、两条线是什么

WorkBuddy 的「技能」页签下有三个市场分区：**推荐**、**SkillHub**、**套件**。
其中「套件」就是**插件市场**（客户端文案里 `skills.tab.plugins` 的中文是「套件」，`skills.tab.knot` 才是 Knot），
它读的是 `.codebuddy-plugin/marketplace.json` + 插件目录。本挂件只能是插件，不能是 Skill：

| 通道 | 容器 | 分发方式 | 审核 |
| --- | --- | --- | --- |
| A 自建市场 | 独立 GitHub 仓库 `pigeon189/fox-widget-marketplace` | 用户「新增市场」填 `owner/repo` | 无 |
| B 官方市场 | `cnb.cool/codebuddy/marketplace` | 提 PR，合并后随客户端市场自动更新 | 人工 |

Skill（SkillHub）那条路走不通：skill 只在会话里被模型调用，起不了常驻服务、挂不上 hooks，也开不了桌面浮层。

## 二、产物

```bash
node tools/build-marketplace.mjs          # 两套都生成到 dist/（已被 .gitignore 忽略）
node tools/build-marketplace.mjs --only=a # 只生成自建市场
node tools/build-marketplace.mjs --only=b # 只生成官方投稿素材
```

```
dist/marketplace/                      A 线：直接推成一个独立仓库
├── .codebuddy-plugin/marketplace.json 市场清单（source: ./plugins/fox-widget）
├── plugins/fox-widget/                插件本体（= git 跟踪文件 - 2 个签名清单）
├── .gitattributes / .gitignore
└── README.md                          给市场仓库首页看的安装说明

dist/official-submission/              B 线：官方仓库的补丁素材
├── external_plugins/fox-widget/       第三方插件都放 external_plugins/（plugins/ 是官方自有）
├── marketplace-entry.json             追加到官方 marketplace.json 的那一条
├── PR.md                              PR 标题、正文、提交前核对
└── README.md
```

### 打包口径

- **只打 `git ls-files` 跟踪的文件**：未跟踪的草稿不会漏进包里。
- **两个包都不带** `.release-hashes.json` / `.sig`：那是挂件内自更新的签名清单，而市场安装的升级路径是「刷新 + 重装」。带一份过期清单只会让自更新报「包体可能被镜像篡改」；不带时更新器会明确提示改用市场重抓（`lib/update.mjs`）。
- **B 包额外剔除开发文件**：`.github/`、`docs/`、`.gitignore`、`.gitattributes`、`.zcodeignore`、仓库根那份 `marketplace.json`。审核看的是插件，不是仓库历史。
- 插件目录里的 `.codebuddy-plugin/marketplace.json` 在 A 包里保留（本地目录安装就带着它，三处版本一致性断言也依赖它）。

## 三、A 线：自建市场

发布（改完代码、版本号已提交后）：

```bash
node tools/build-marketplace.mjs --only=a
node tools/verify-marketplace.mjs            # 静态校验
node tools/publish-marketplace.mjs           # 浅克隆远端 → 覆盖 → 有差异才提交 → 推送
```

`publish-marketplace.mjs` 默认推到 `git@github.com:pigeon189/fox-widget-marketplace.git`，
可在末尾加 `--dry-run` 演练、`--repo <url>` 换仓库。它不用 force push。

用户侧：

1. 技能 → 套件 → 新增市场 → `pigeon189/fox-widget-marketplace`
2. 市场里出现 `fox-widget` → 安装（作用域 user）→ 重启会话

> 宿主对 `owner/repo` 走 git clone；没有 git 时退化为下载 `main.zip`（GitHub）/`master.zip`（Gitee）。
> 所以**默认分支必须是 `main`，且 marketplace.json 在仓库根**。仓库名后面不能带分支。

## 四、B 线：官方市场

已提交：<https://cnb.cool/codebuddy/marketplace/-/pulls/45>（`feat/fox-widget` → `main`，73 个文件，只改 `marketplace.json` 一处 +23 行）。
提 PR 的 fork 是 `PigeonWorkspace/marketplace`，后续更新直接往这个 fork 推同一条分支即可，PR 会自动带上新提交。

官方仓库：`https://cnb.cool/codebuddy/marketplace`（README 写明「欢迎提交 PR」，现有 207 条里 150 条是 `external_plugins/` 第三方插件）。

**账号体系**：CNB 是独立平台，微信扫码登录并实名认证；`gh` 的 GitHub 登录只对 github.com 有效，拿不到 CNB 的权限。
**协议**：CNB 不支持 SSH，只支持 `HTTPS + 访问令牌`（用户名固定 `cnb`，密码填令牌）。

流程：

1. 微信扫码登录 <https://cnb.cool> 并完成实名认证；fork `codebuddy/marketplace`
2. 打开 <https://cnb.cool/profile/token> 新建访问令牌（勾上仓库写权限）
3. 在本仓库跑：

   ```bash
   CNB_TOKEN=<令牌> node tools/prepare-official-pr.mjs --repo https://cnb.cool/<你的账号>/marketplace
   ```

   它会：克隆 fork → 校验目标确为官方市场 → 放 `external_plugins/fox-widget/` → 只往 `marketplace.json` 数组末尾追加一条（保留原文件的 CRLF 与无末尾换行）→ 提交 → 推送分支。
   令牌只通过子进程环境变量传给 git，不写文件、不进命令行参数。
4. 打开 fork 页面新建合并请求（源分支 `feat/fox-widget` → 目标 `main`），正文用 `dist/official-submission/PR.md`。

不推远端时可以演练（公开仓库匿名可克隆，不需要令牌）：

```bash
node tools/prepare-official-pr.mjs --repo https://cnb.cool/codebuddy/marketplace --dry-run
```

### 官方仓库约定（照抄，别自创）

- 第三方插件放 `external_plugins/<name>/`，`source` 写 `./external_plugins/<name>`
- `strict` 字段默认 `true`（要求目录里有 `plugin.json`）；我们有清单，所以**不写**
- 条目字段顺序：`name, description, description_en, version, source, author, homepage, repository, license, keywords, category`
- 插件目录：`.codebuddy-plugin/plugin.json`、`hooks/`、`skills/`、`commands/`、`.mcp.json`、`README.md`、`LICENSE`
- SKILL.md frontmatter 只保留 `name` 与 `description`

## 五、发版时别漏

1. `.codebuddy-plugin/plugin.json` 的 `version`
2. `.codebuddy-plugin/marketplace.json` 的 `metadata.version` 与插件条目 `version`
3. `CHANGELOG.md` 加一条 `## wb-vX.Y.Z`
4. 跑 `node tools/verify-marketplace.mjs --simulate`（会把包当已安装插件跑一遍 430 项自检）
5. 重新 `publish-marketplace.mjs`；需要时再对官方仓库提一次 PR

> `--simulate` 会在临时目录里设置 `CODEBUDDY_PLUGIN_ROOT` / `CODEBUDDY_PLUGIN_DATA` 并跑 `tools/selftest.mjs`，
> 不碰真实账单。若本机跑着 fox-dock，验证脚本会自动把 dock 数据目录指到临时目录，避免自检走到「让位给 dock」的分支。

## 六、踩过的坑

- **`owner/repo` 拉的是默认分支**：源码仓库默认分支是 `main`（ZCode 线），所以不能直接填源码仓库名，必须有独立的 A 仓库。
- **`owner/repo#分支` 不被识别**：只支持 `owner/repo`、git URL、本地目录、`marketplace.json` URL、zip URL。要指定分支只能给 zip URL。
- **市场升级不会动用户数据**：插件数据在 `CODEBUDDY_PLUGIN_DATA`，重装只替换代码目录。
- **审核关注点**：`SessionStart` 自动拉起常驻进程、桌面浮层的窗口行为、可选出站请求（厂商余额）。PR 正文已按这三点写清数据与网络边界。
