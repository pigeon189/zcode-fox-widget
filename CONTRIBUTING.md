# 提交与 PR 规范

本仓库自 `435efb5`（2026-09-29，QA 审查修复）起采用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/)；其前的 10 个提交为过渡格式（无类型前缀），按「不改写已推送历史」的原则保留原样，不追溯重写。

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

- 取改动的**主体模块名**，小写：`pricing` `widget` `server` `overlay` `desktop` `balance` `usage-records` `plan-balance` `source` `vendors` `discover` `theme` `bubble` `watcher` `release`…
- 一个提交跨多个模块时：选主体模块，其余在 body 列出；或拆成多个提交。**不用** `+` 连接的复合 scope（如 `billing+security`），**不用版本号当 scope**（如 `fix(v1.4.2)`）。
- release 提交固定用 `chore(release)`。

### subject

- 祈使句、结尾不加句号。
- **显示宽度 ≤72 列**（CJK 全角字符按 2 列计）。超长的根因解释、证据链移入 body——subject 塞不下解释，正说明该有 body。
- 结论进 subject，**为什么进 body**：动机、根因、实测证据、验证方式。

### body

- 多问题批量修复至少写一句总述并列出各项；空 body 只允许极小改动（单行、自解释）。
- `revert` 必须在 body 注明被回退的 commit 与原因。

### 版本号（release 纪律）

- 版本变更必须独立成 `chore(release): vX.Y.Z`，body 列变更清单。**禁止把版本号变更悄悄夹带进 feat/fix**（v1.6.0–v1.7.2 曾四次这样夹带，本条即为教训成文）。
- 版本号三处同步，release commit 一并改齐：`.zcode-plugin/plugin.json`、`marketplace.json`、`lib/server.mjs` 的 `VERSION`。`desktop/package.json` 是浮层入口包，版本独立，不在三处之列。

## 提交纪律

- **不改写已推送历史**：不 force-push 已推送分支、不 rebase 已进入 PR 的提交；修错用新提交。
- 提交前自检：`node tools/selftest.mjs` 全绿；改了前端交互再跑 `node tools/smoke-ui.mjs`。
- **`desktop/*.ps1` 必须纯 ASCII**（`follow-window.ps1`、`dxgi-watch.ps1`）：提交前跑 `grep -nP '[^\x00-\x7F]' desktop/*.ps1`，必须零输出。Windows PowerShell 5.1 按 ANSI 代码页读取无 BOM 的 `.ps1`，非 ASCII 注释会解码成破坏语法的字节，脚本直接退出、跟随失效。
- 源码、示例与测试中不得出现可用凭据字面量；日志与 CLI 只输出掩码（如 `sk-8a…8c5`）。
- SQL 一律参数绑定；出站请求走 `assertSafeUpstream` 白名单（扩展目标改 `lib/credentials.mjs`，厂商模板须显式声明 `host`）。

## 文档风格

README / SKILL / commands 的标点与空格漂移是反复出现的问题，这里成文，评审按此核对。

- **引号**：中文用「」『』，不用直引号 `"…"`。代码、路径、标识符例外（写在反引号里）。
- **中英/数字间距**：中文与拉丁字母、数字之间加半角空格（「5 小时」「GLM Plan 配额」「204/204」）；中文标点前后不加。
- **计量词**：一律「5 小时」「7 天」「60 秒」，不写「5小时」（界面上的紧凑标签如额度卡的「5小时」行名除外，那是版式需要）。
- **版本小节标题**：`## vX.Y.Z <动词>：<一句话>`，动词只用三种——新能力用「新增」、缺陷用「修复」、行为或口径调整用「变更」；标题动词要与该版本的主提交类型一致（`feat` → 新增）。小节内用平铺列表，不写 `###` 子节。
- **代码块语言标注**：命令与输出用 ```bash / ```text；ASCII 架构图可不标。
- **术语表**（同一概念只用一种说法）：

  | 用法 | 不写 |
  | --- | --- |
  | GLM Plan（v1.7.8 起；template id 仍是 `zcode-plan`） | ZCode Plan |
  | 对账口径（v1.7.0 起；值仍是 `ledger` / `token`） | 用量模式 / 用量统计模式 |
  | CommandCode 三重额度 | CommandCode 限额 / 周限额套餐 |
  | 本机库口径 · 账号口径 | 本机数据 / 云端口径 |
  | 记账二级页（=角色名记账=） | 记账面板（那是用量记录面板） |

## PR 规范

- 一个 PR 一个主题；描述包含：摘要、背景动机、改动分组（按模块）、兼容性与迁移、测试结果（真实运行的数字）、安全影响、已知限制。
- 正文措辞与事实一致：测试数字用最近一次真实运行的输出；对历史的描述不夸大（如提交格式、版本轨迹）。
- 不引入 lint 配置（项目约定）；风格靠本文件与代码评审维持。
