# 提交与 PR 规范

> **本仓库是同仓双分支**：`main` = ZCode 产品线，`workbuddy` = WorkBuddy 产品线。
> 本文的通用规范两边都适用；**分支专属约定**见文末「双分支协作」一节。

本仓库自 `435efb5`（2026-09-29，QA 审查修复）起采用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/)；其前的 14 个提交为过渡格式（无类型前缀），按「不改写已推送历史」的原则保留原样，不追溯重写。

## Commit 格式

```
<type>(<scope>): <subject>

<body>
```

### type（限定集合）

只用这 11 个：`feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`。

- 不使用自定义类型（此前的 `debug` 属临时诊断入库，后续不再出现）。
- 临时诊断代码不入库：调试探针放 `%TEMP%`，需要长期保留的诊断设施走 `feat`/`chore` 并在 body 说明用途与开关。

### scope

- 取改动的**主体模块名**，小写：`pricing` `widget` `server` `overlay` `desktop` `balance` `usage-records` `plan-balance` `source` `vendors` `discover` `theme` `bubble` `watcher` `release`…；WorkBuddy 分支另有 `port`（移植）与 `host`（宿主适配）。
- 一个提交跨多个模块时：选主体模块，其余在 body 列出；或拆成多个提交。**不用** `+` 连接的复合 scope（如 `billing+security`），**不用版本号当 scope**（如 `fix(v1.4.2)`）。
- release 提交固定用 `chore(release)`。

### subject

- 祈使句、结尾不加句号。
- **显示宽度 ≤72 列**（CJK 全角字符按 2 列计）。超长的根因解释、证据链移入 body——subject 塞不下解释，正说明该有 body。提交前自检：
  ```bash
  git log --format='%s' 435efb5.. | awk '{ w=0; for(i=1;i<=length($0);i++){ c=substr($0,i,1); w += (c ~ /[\x80-\xFF]/) ? 2 : 1 } if (w > 72) print w, $0 }'
  ```
  （按 UTF-8 字节近似 CJK×2；输出非空即超宽。）
- 结论进 subject，**为什么进 body**：动机、根因、实测证据、验证方式。

### body

- 多问题批量修复至少写一句总述并列出各项；空 body 只允许极小改动（单行、自解释）。
- `revert` 必须在 body 注明被回退的 commit 与原因。

### 版本号（release 纪律）

- 版本变更必须独立成 `chore(release): vX.Y.Z`，body 列变更清单。**禁止把版本号变更悄悄夹带进 feat/fix**（v1.6.0–v1.7.2 曾四次这样夹带，本条即为教训成文）。
- 版本号单一来源：`.codebuddy-plugin/plugin.json`（`lib/paths.mjs` 的 `pluginVersion()` 供 server 的 health 与 MCP 动态读取）。release commit 仍需同步改 `.codebuddy-plugin/marketplace.json` 的版本；selftest 有「health = 清单 = marketplace」一致性断言兜底。`desktop/package.json` 是浮层入口包，版本独立，不在此列。
- （ZCode 线 `main` 上的对应文件是 `.zcode-plugin/plugin.json` + 根 `marketplace.json`，两分支各自的清单互不混用。）

### 版本说明的写法（2026-10-18 统一）

- **版本标题**：`## vX.Y.Z <动词>：<一句话>`，动词只用 **新增 / 修复 / 变更**；并入多个小版本的写「（并入 …）」。
- **条目**：平铺列表，每条**一句话、≤150 字**，只写「现象 → 影响」；实现细节、调查过程、字段名不进 CHANGELOG。
- **数量**：每版聚焦重点（一般 ≤10 条）；批次大或并入多个小版本时可放宽，但不再逐条罗列实现。
- **层级**：正文不出现 `###`；跨版本的回撤/补全说明用 `>` 引用块。
- **Release 正文**：首行一句总述并指回 CHANGELOG 小节；分节标题用 `##`；**不逐字复制 CHANGELOG**，只挑 3–6 条用户最关心的；末尾固定「升级」（ZCode 线）/「安装 / 升级」（WorkBuddy 线）。
- **两条线同批修复**用同一段文字，只替换宿主名词（ZCode↔WorkBuddy、余额↔积分）。
- **历史 Release**：全部版本已于 2026-10-18 按上述格式重建（同一骨架、每条 ≤5 条提要）；已发布正文不再逐条回改，只有格式错乱时才修。

## 提交纪律

- **不改写已推送历史**：不 force-push 已推送分支、不 rebase 已进入 PR 的提交；修错用新提交。
- **已发布 tag / Release 的删除与重指向是破坏性元数据变更**，必须有 commit 记录删除范围与原因（先例：9cd7b81 重指向、959b14e 按合并策略删 16 个 tag），且 commit 历史本身一律保留。
- 提交前自检：`node tools/selftest.mjs` 全绿；改了前端交互再跑 `node tools/smoke-ui.mjs`。
- **`desktop/*.ps1` 必须纯 ASCII**（`follow-window.ps1`）：提交前跑 `grep -nP '[^\x00-\x7F]' desktop/*.ps1`，必须零输出。Windows PowerShell 5.1 按 ANSI 代码页读取无 BOM 的 `.ps1`，非 ASCII 注释会解码成破坏语法的字节，脚本直接退出、跟随失效。
- 源码、示例与测试中不得出现可用凭据字面量；日志与 CLI 只输出掩码（如 `sk-8a…8c5`）。
- SQL 一律参数绑定；出站请求走 `assertSafeUpstream` 白名单（扩展目标改 `lib/credentials.mjs`，厂商模板须显式声明 `host`）。

## 文档风格

README / SKILL / commands 的标点与空格漂移是反复出现的问题，这里成文，评审按此核对。

- **引号**：中文用「」『』，不用直引号 `"…"`。代码、路径、标识符例外（写在反引号里）。
- **中英/数字间距**：中文与拉丁字母、数字之间加半角空格（「5 小时」「GLM Plan 配额」「204/204」）；中文标点前后不加。
- **计量词**：一律「5 小时」「7 天」「60 秒」，不写「5小时」（界面上的紧凑标签如额度卡的「5小时」行名除外，那是版式需要）。
- **版本小节标题**：`## wb-vX.Y.Z <动词>：<一句话>`（ZCode 线是 `## vX.Y.Z`），动词只用三种——新能力用「新增」、缺陷用「修复」、行为或口径调整用「变更」；标题动词要与该版本的主提交类型一致（`feat` → 新增）。小节内用平铺列表，不写 `###` 子节。
- **release 正文的标题层级**：分组标题用 `##`（不用 `###`：GitHub 会渲染成小一号，同一页上就与相邻版本的正文大小不一致）；首行一句总述并指向 CHANGELOG 小节，末尾给升级方式小节（WorkBuddy 线是「安装 / 升级」）。
- **代码块语言标注**：命令与输出用 ```bash / ```text；ASCII 架构图可不标。
- **术语表**（同一概念只用一种说法）：

  | 用法 | 不写 |
  | --- | --- |
  | WorkBuddy狐娘小挂件（`workbuddy` 分支的产品名；标题/描述/窗口名统一用它） | ZCode狐娘小挂件（那是 `main` 分支的产品名） |
  | ZCode狐娘小挂件（`main` 分支的产品名） | WorkBuddy狐娘小挂件（本分支名，别混用） |
  | 订阅积分 · 今日积分 · 本轮 credit（WorkBuddy 主口径） | 余额（本分支里那只是可选厂商卡） |
  | 上下文余量 | 上下文占用率 / context 使用率 |
  | 宿主适配层（`lib/host.mjs`） | 宿主差异、平台适配代码 |
  | 对账口径（值仍是 `ledger` / `token`） | 用量模式 / 用量统计模式 |
  | CommandCode 三重额度 | CommandCode 限额 / 周限额套餐 |
  | 本机口径 · 账号口径 | 本机数据 / 云端口径 |
  | 记账二级页（=角色名记账=） | 记账面板（那是用量记录面板） |

  > ZCode 线的 `main` 分支另有 `GLM Plan` 与「对账口径（本机库/账号）」等术语；本分支已砍掉 GLM Plan，
  > 且主口径换成积分，两边的术语表**刻意不完全对齐**——别为了「统一」把本分支的叙事改回余额口径。

## 文档归属

根目录只放三份 md：`README.md`（用户）、`CHANGELOG.md`（速查）、`CONTRIBUTING.md`（贡献者）。
其余按下面分目录，并在 [`docs/INDEX.md`](./docs/INDEX.md) 登记一行。

| 内容 | 放哪 | 命名 |
| --- | --- | --- |
| 用户能看见的行为 | `README.md` | — |
| 本分支的版本变更（速查） | `CHANGELOG.md` | `## wb-vX.Y.Z <动词>：<一句话>`，每版 ≤ 8 条、每条 ≤ 60 字 |
| 当前契约 / 责任表 / 别改清单 | `docs/MAINTAINING.md` | — |
| 「为什么这么写」与实测依据 | `docs/DECISIONS.md` | 一主题一节，锚点供 CHANGELOG 链接 |
| 一次性评审 / 事故记录 | `docs/reviews/`、`docs/incidents/` | `YYYY-MM-<slug>.md` |
| 移植期阶段档案 | `docs/porting/` | 只增不改 |

- 一次性文档必须有 `> **状态**：` 头（已闭环 / 待实施 / 常青），并在 `docs/INDEX.md` 写同一状态。
- 移动或改名文档时，**同一次提交**内 `grep` 修掉所有引用；CHANGELOG 里「当时的路径」只保留在
  `docs/CHANGELOG-ARCHIVE.md`。
- CHANGELOG 的「为什么」不写在版本条里：一句话结论 + 指向 `docs/DECISIONS.md#slug`。

## PR 规范

- 一个 PR 一个主题；描述包含：摘要、背景动机、改动分组（按模块）、兼容性与迁移、测试结果（真实运行的数字）、安全影响、已知限制。
- 正文措辞与事实一致：测试数字用最近一次真实运行的输出；对历史的描述不夸大（如提交格式、版本轨迹）。
- 不引入 lint 配置（项目约定）；风格靠本文件与代码评审维持。

## 双分支协作

`main`（ZCode）与 `workbuddy`（WorkBuddy）是**同仓双长寿命分支**：共享内核占全仓七成以上，
宿主差异集中在 `lib/host.mjs`（WorkBuddy 侧独有）。规矩如下。

### 合并方向与频率

- **`main` 是共享内核的上游**：`widget.js` / `server.mjs` / `pricing.mjs` / `vendors.mjs` /
  `balance.mjs` / `desktop/` / `tools/` 的修复一律**先落 `main`**，再 `git merge main` 进 `workbuddy`。
- **`workbuddy` 独有变更**（数据源、清单、钩子、宿主适配层）**只存在于 `workbuddy`**，
  **禁止反向 merge**（防止 ZCode 清单/钩子被 WorkBuddy 格式污染）。
- 频率：ZCode 侧每次发版后必同步一次；两次发版之间共享代码有 fix 也单独同步。
  **长期不同步是最大风险源**——超过 3 个版本未 merge 时，停下来先做同步再继续开发。
- merge 纪律：每次 `merge main` 后**必须全量跑三套测试**再推送；冲突解决不了时
  以 `main` 版本为准 + 在 `workbuddy` 侧重新应用适配，**不要手工「揉」出第三种写法**。

### 分支规则

- `workbuddy` **禁止 rebase / force push**，只允许 merge。
- **不要**把同一个工作目录同时注册给两个宿主当市场——任一端「重新抓取」都会覆盖另一端的认知。
  WorkBuddy 侧用单独克隆的开发副本（`git clone -b workbuddy <repo> ~/.workbuddy/dev/fox-widget`）。

### 版本号与发版

| | `main`（ZCode 线） | `workbuddy`（WorkBuddy 线） |
|---|---|---|
| 版本序列 | `1.x.y` 延续 | 独立序列 `1.x.y`（首个正式版 `1.0.0`） |
| tag | `v*` | **`wb-v*`** |
| 清单 | `.zcode-plugin/plugin.json` + 根 `marketplace.json` | `.codebuddy-plugin/plugin.json` + `.codebuddy-plugin/marketplace.json` |
| 自更新 | 保留镜像链 | **默认关闭**（宿主插件管理与原地覆盖冲突；更新走 `git pull` + 客户端重抓） |
| CHANGELOG | 单文件，版本小节用 tag 前缀区分产品线（`## wb-vX.Y.Z` / `## vX.Y.Z`），共享修复两边都记 | 同左 |

> 注意：GitHub 的 `releases/latest` 对两条产品线是**歧义**的（会返回整体最新，可能是 ZCode 线的 tag），
> 所以 WorkBuddy 线的更新探测会列出 releases 后只挑 `wb-v*` 前缀里的最高版本。
>
> 由此还有一条发版纪律：本线的 release 一律 `gh release create … --latest=false`，把 `Latest` 徽章
> 留给 `v*` 那条线。2026-10-18 发 `wb-v1.3.1` 时漏了这个参数，徽章落到 wb 版本上，仓库首页的
> 「Latest」与 `/releases/latest` 都指向了 WorkBuddy 线（已用 `gh release edit v1.15.1 --latest` 改回）。

### 宿主升级监控

WorkBuddy 客户端大版本升级可能改钩子事件表 / db schema / 沙箱策略，
这会让 `docs/porting/phase-*.md` 里的【实测】结论过期。**每次客户端大版本升级后，
重跑 `docs/porting/phase-0.md` 的四项验证 + 三套测试**，结论失效的更新那份文档
（按「时效声明」改写，不要叠加）。

### 谁对什么负责

- 共享内核 bug → 在 ZCode 侧（`main`）修。
- WorkBuddy 数据源 / 宿主适配 → 在 WorkBuddy 侧（`workbuddy`）修。
- 两侧都改不动的（如 Electron 版本级行为）→ 写调查报告升级给用户决策。

### 发布物完整性（发布前必须做）

更新内核会从镜像下载整包并**直接覆盖 `lib/*.mjs`**，所以只校验「包内版本号 == 目标版本」不够
（版本号与包体来自同一批镜像）。现在下载后还会校验一份**发布签名**：

- 信任锚：仓库根 `.release-pubkey.pem`（随包分发，安装副本自带；镜像伪造不了签名）。
- 每次发布前跑一次签名工具，把生成的两份文件**一起提交**，然后才打 tag：

  ```bash
  # 一次性：生成密钥对（私钥留在仓库外，别提交）
  node tools/sign-release.mjs --gen-key ../fox-release-key.pem
  # 每次发版：生成清单 + 签名，然后 git add 两个文件并提交
  node tools/sign-release.mjs --key ../fox-release-key.pem
  # 提交前自检：清单与当前树是否一致、签名是否有效
  node tools/sign-release.mjs --check
  ```

清单按 `git archive` 的**打包字节**计算 sha256（仓库有 `.gitattributes` 的 eol 规则，工作区与
打包字节未必相同），逐个文件覆盖；签名覆盖清单本身。

**换钥**：私钥丢了或要轮换时，先用**旧私钥**签一个把新公钥提交进去的版本（`--gen-key` 会写新的
`.release-pubkey.pem`，再用旧私钥 `--key` 签），之后用新私钥签后续版本——否则已装副本会拒收新版本。

**顺序很重要**：清单按 `git archive` 的**打包字节**算，所以必须
「先把要发的改动全部提交 → 再签名 → 提交清单与签名 → 打 tag 之前再跑一次 `--check`」。
签名之后又改了任何被跟踪的文件，都会让清单与包体对不上，更新器会拒装（这正是它该做的事）。

**没有清单的旧版本会被拒装**（fail-closed），提示用户改用市场「重新抓取」或手动安装。
