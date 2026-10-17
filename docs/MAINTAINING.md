# WorkBuddy 分支维护手册（MAINTAINING）

> **状态**：常青 · 本文件是本分支唯一的「现状」文档。改动宿主相关行为后请更新它，而不是叠加新文档。
> **来源**：合并自 `HANDOFF-WORKBUDDY-PORT.md`（移植交付说明）与 `HANDOFF-WORKBUDDY.md`（移植前的 ZCode 侧交接，
> 已删除；原文见 `git show 299b607^:HANDOFF-WORKBUDDY.md`），并把 README 里的架构与性能两节吸收进来。
> 时效：宿主结论实测于 WorkBuddy 5.8.2（Windows，2026-10-14）。宿主升级后需按 §3 重跑验证。



## 0. 30 秒上手

1. **读 `docs/porting/phase-0.md`**：那是宿主契约的实测基线（四项探路验证 + 数据源结构），
   本文的结论大量引用它，别只看本文。
2. **读 `lib/host.mjs`**：宿主差异的唯一定义处。改任何与 WorkBuddy 相关的行为，先看这里。
3. **本机同时装了 ZCode 版与 WorkBuddy 版时**：两端的挂件服务是两个独立进程（默认端口都是 39321，
   后者会自动顺延）。调试时先确认你连的是哪一个：`curl 127.0.0.1:39321/whale/health` 的 `app` 字段
   会告诉你（`fox-widget` = 本分支，`zcode-fox-widget` = ZCode 版）。
4. **别在 agent shell 里启浮层**（GPU 子进程必崩 + `ELECTRON_RUN_AS_NODE` 污染），见 §5。


## 1. 责任表：宿主提供 vs 自建

| 部分 | 谁提供 | 本分支的做法 |
|---|---|---|
| 挂件窗口 | **自建** | 独立 Electron 进程；透明置顶无边框、铺满工作区、默认鼠标穿透 |
| 挂件页面 | **自建** | `lib/widget.js`，单文件 IIFE，零依赖、零构建 |
| 本地服务 | **自建** | `lib/server.mjs`，只监听 `127.0.0.1` |
| **积分 / 上下文 / 模型** | **宿主提供** | 读 `~/.workbuddy/workbuddy.db` 的 `session_usage` + `~/.workbuddy/projects/*/*.jsonl` 的 `rawUsage` |
| **会话身份** | **宿主提供** | 钩子 stdin 的 `session_id` / `transcript_path` → `<插件数据目录>/hook-state.json` |
| **主题** | **宿主提供** | `~/.workbuddy/storage/user-*/global/preferences.json` 的 `theme`（+ 浮层 DWM 观测） |
| **凭据（可选）** | **宿主几乎没有** | 实测宿主侧无 provider 凭据存储；厂商卡靠环境变量或用户手填 |
| 余额 / 厂商额度 | 自建 + 出站 | 只向白名单主机发请求（可选功能） |
| 事件 | **宿主提供** | 3 个**低频**钩子：SessionStart / UserPromptSubmit / Notification（不挂 PostToolUse——它每次工具调用都触发，内联执行会拖慢每次工具调用） |
| 会话内工具 | **宿主提供** | MCP 工具（`mcp__plugin_fox-widget_whale__*`）、`/fox` 命令、两个 skill |


## 2. 架构与运行时数据

```
fox-widget（仓库根 = 插件根 = 市场根）
├─ .codebuddy-plugin/
│  ├─ plugin.json              插件清单：name/version/hooks/mcpServers/defaultEnabled
│  └─ marketplace.json         本地市场声明（source: "./"，已在宿主实现层验证合法）
├─ .mcp.json                   MCP server 声明（whale → lib/mcp-server.mjs）
├─ hooks/hooks.json            钩子接线：SessionStart 自启 + UserPromptSubmit / Notification（均为低频）
├─ commands/fox.md             /fox 命令
├─ skills/fox-widget/          使用与排查说明（供 WorkBuddy 内的助手阅读）
├─ skills/fox-pricing-review/  人工复核价目的流程
├─ desktop/                    桌面浮层
│  ├─ main.cjs                 Electron 主进程：透明置顶窗口、穿透切换、视口转发、宿主身份跟踪
│  ├─ preload.cjs              向页面暴露 setInteractive / onViewport / 跟随间隔 / 窗口失焦事件
│  ├─ follow-window.ps1        常驻探测宿主窗口位置/前台/暗色标志（C# 内核，必须纯 ASCII）
│  └─ package.json             浮层入口包声明（Electron 启动用）
├─ lib/
│  ├─ host.mjs                 **宿主适配层**：数据目录、db、主题、进程名、单例特征、环境变量名
│  ├─ server.mjs               本地 HTTP 服务：页面、图片、音效、全部 JSON 接口
│  ├─ widget.js                前端挂件：拖拽/吸附/翻转/菜单/气泡/音效/穿透
│  ├─ turn-cost.mjs            每轮消耗与上下文余量（读 session_usage + transcript 的 rawUsage）
│  ├─ usage-records.mjs        用量记录聚合：扫 transcript 按日/按模型汇总（积分口径）
│  ├─ balance.mjs              余额、记账账本、平台用量、缓存与回退、今日口径合并（可选功能）
│  ├─ pricing.mjs              九家价目 + 峰谷时段判定 + token→金额（含输入口径拆分）
│  ├─ source.mjs               计费源判定（WorkBuddy 恒为 credits；厂商标签用于分组）
│  ├─ plan-balance.mjs         **已冻结**（宿主无对应物，恒返回 not-supported）
│  ├─ cmdgo.mjs                CommandCode 三重额度（月度池 + 5 小时/周窗口，网关 API 直读）
│  ├─ vendors.mjs              厂商余额/配额模板框架（host 白名单、缓存、归一化）
│  ├─ discover.mjs             厂商凭据自动发现（宿主 settings.json / 插件数据目录 / 环境变量）
│  ├─ host-theme.mjs           「跟随 WorkBuddy」主题三层判定（观测 > preferences.json > 系统）
│  ├─ paths.mjs                插件内路径常量（宿主路径从 host.mjs 取）
│  ├─ credentials.mjs          凭据发现 + 出站主机白名单校验
│  ├─ service.mjs              挂件服务的发现/拉起/关闭
│  ├─ overlay.mjs              浮层的启停与 Electron 运行时按需安装
│  ├─ autostart.mjs            SessionStart 自启入口
│  ├─ cli.mjs                  命令行入口
│  └─ mcp-server.mjs           MCP 工具
├─ docs/porting/               移植的分阶段施工记录与实测结论
├─ tools/                      自检、演示与排查脚本
└─ assets/                     鲸鱼形象、rua 动图、两套音效（来自上游）
```

### 运行时数据

都在宿主的**插件数据目录**（`${CODEBUDDY_PLUGIN_DATA}`，默认
`~/.workbuddy/plugins/data/fox-widget-fox-local/`，可用环境变量 `FOX_WIDGET_DATA_DIR` 覆盖），
与仓库完全分离：

| 文件 | 内容 |
|---|---|
| `config.json` | API Key（可选）、平台令牌、厂商 key（vendorKeys）、端口、自启开关、跟随间隔 |
| `widget-state.json` | 挂件外观与菜单开关（大小、音效、主题、气泡、对账口径、预警阈值、排名口径…） |
| `bubble-content.json` | 按压泡泡队列（v2：`{v:2, tapAdvance, steps:[{modules}]}`；旧 v1 配置读取时自动迁移） |
| `roles.json` + `roles/` | 导入的角色索引与图片；`hiddenBuiltins` 记录被删（隐藏）的内置形象，清掉即找回 |
| `sounds/` + `sounds.json` | 导入的音效文件与索引（≤20 套，v1.6.0 起） |
| `usage-ledger.json` | 记账口径的账本（含最近 30 天归档） |
| `turn-seq.json` | 每轮序号持久化（服务重启后续号） |
| `hook-state.json` | 最近一次钩子事件 + **当前会话身份**（`sessionId` / `transcriptPath`）——积分与上下文全靠它定位 |
| `host-theme-observed.json` | 浮层观测到的宿主窗口暗色标志（「跟随 WorkBuddy」第一层；浮层干净退出即删、读取端 24h TTL） |
| `server.json` | 挂件服务运行信息（pid / 端口 / 关闭令牌，0600） |
| `overlay.json` | 浮层进程 pid |
| `overlay-debug.log` | 浮层黑匣子日志（常开，超 5MB 轮转） |
| `autostart.log` | 每次会话启动的自启结果 |
| `hook.log` | 钩子调试日志（仅 `FOX_WIDGET_HOOK_DEBUG=1` 时写） |
| `update-state.json` / `update-files.json` / `update/` | 自更新状态、文件清单与备份（自更新默认关闭） |
| `desktop-runtime/` | Electron 运行时（下载包约 150MB，解压装机后占用约 370MB；删掉即回收，浮层随之失效） |

**宿主侧只读的数据**（挂件不写、测试一律先 copy 再读）：`~/.workbuddy/workbuddy.db`（WAL）、
`~/.workbuddy/projects/*/*.jsonl`、`~/.workbuddy/settings.json`、
`~/.workbuddy/storage/user-*/global/preferences.json`。

服务接口（排查时可直接 curl）：页面与资产 `/`（`/index.html`）、`/whale/widget.js`、`/whale/image.png`、`/whale/rua.gif`、`/whale/sound/press.mp3` 与 `/whale/sound/release.mp3`（`?set=<音效集 id>`）；状态查询 `/whale/health`、`/whale/context.json`、`/whale/last-turn.json`、`/whale/usage-records.json`、`/whale/session.json`、`/whale/host-theme.json`、`/whale/balance.json`、`/whale/vendors.json`、`/whale/cmdgo.json`（`?refresh=1` 强制绕缓存）、`/whale/plan.json`（已冻结）、`/whale/sounds.json`、`/whale/roles.json`、`/whale/bubble-content.json`（GET/POST）、`/whale/balance-adjustments.json`（GET/POST）、`/whale/size.json`（GET/PUT）；写操作 `/whale/role-upload.json`、`/whale/role-rename.json`、`/whale/role-delete.json`、`/whale/sound-upload.json`、`/whale/sound-delete.json`（写操作校验 Origin）；关停 `/whale/shutdown`（需 `server.json` 随机令牌）。

---


## 3. 宿主契约要点（三处最容易出错的地方）

1. **`/whale/health` 的 `app` 标识必须两处一致**。`server.mjs` 写它（`HOST_APP_ID`）、
   `service.mjs` 校验它。两处不一致 → `findRunningServer()` 永远找不到在跑的服务 →
   每次都会尝试新起一个 → 端口顺延、`status` 显示「未运行」但实际有服务在跑。
   本分支已把常量收敛到 `lib/host.mjs` 的 `HOST_APP_ID`。
2. **浮层单例特征必须同时匹配新旧插件名**（`lib/overlay.mjs` 的 `OVERLAY_CMDLINE_MARKERS`）。
   本分支插件叫 `fox-widget`，ZCode 分支叫 `zcode-fox-widget`；用户两端同装时若不互认，
   `startOverlay` 的去重逻辑会保留两个 → 桌面出现两个角色。
3. **宿主的 db 带 WAL，测试一律先 copy 再读**。直接打开用户的 `~/.workbuddy/workbuddy.db`
   可能干扰宿主进程。`lib/turn-cost.mjs` 只读打开（`readOnly: true`），测试则整体复制到临时目录。


## 4. 浮层真机的纪律（别踩）

- **浮层的一切真机操作都在 WorkBuddy 客户端环境里做**。在 agent shell 里 `window start` 会失败
  或留下坏窗口：实测 Electron 的 GPU 子进程在 agent shell 里必崩（`0xC0000005`），
  且 `ELECTRON_RUN_AS_NODE` 会污染子进程。
  必要的实验姿态：`--no-sandbox --disable-gpu` + `env -u ELECTRON_RUN_AS_NODE`。
- **本次移植没有在 agent shell 里启过浮层**，也没有触碰本机正在运行的 ZCode 版挂件服务。
- 冻结检测必须**完全被动**（摆动鼠标的悬停重绘会掩盖冻结，导致假阴性）。


## 5. 不要改的清单

| 项 | 为什么 |
|---|---|
| `desktop/main.cjs` 的 `type: 'toolbar'` | 让浮层常驻 `WS_EX_TOOLWINDOW`、不进宿主 Chromium 的遮挡判定；删掉会复发「点角色后宿主停帧」。WorkBuddy 同为 Electron，同源风险存在 |
| `lib/credentials.mjs` 的 `readPluginConfig()` **不加缓存** | 账本靠「读到的 apiKey 与上次不同」判定换 key 并归档整本账；加 TTL 缓存会破坏该语义 |
| `lib/service.mjs` 的 `waitServerStopped` | shutdown 的 200 只是「已受理」；不等端口真的停止应答就 restart 会误判「复用已在运行的服务」 |
| `lib/pricing.mjs` 的 `splitInputTokens()` | 不减缓存命中会让等价金额虚高十几倍（WorkBuddy 的 `prompt_tokens` 同样含缓存） |
| `lib/update.mjs` 的探测取最高版本 | 镜像 CDN 会返回上一版；只看第一个成功响应会漏报新版本 |
| `lib/widget.js` 的 `--zcw-ink` 4.5:1 派生色 | 让浅色角色（如 kimi娘原值 2.85:1）也有可读正文；别把派生色与角色原色合并 |
| 前端不引 ESM | `widget.js` 与 `lib/paths.mjs` 各有一份模型→角色映射表，靠测试钉住一致 |
| 浮层不 `setBounds`、隐身用 `setOpacity(0)`、`focusable: false` | 改尺寸会让透明窗合成层错位；hide/show 会卡死原生输入管线 |
| `desktop/follow-window.ps1` 纯 ASCII | PS 5.1 按 ANSI 代码页读无 BOM 的 .ps1，中文注释会破坏语法、脚本秒退 |


## 6. 测试与发布

### 自动化（三套测试）

```bash
node tools/selftest.mjs          # 主自检（隔离 CODEBUDDY_HOME + 伪造 workbuddy.db 与 transcript）
node tools/selftest-update.mjs   # 更新内核自检（含重启链路端到端）
node tools/smoke-ui.mjs          # 前端冒烟（headless 浏览器；找不到浏览器时 SKIP 是预期）
```

结果与新增断言见 `docs/porting/phase-5.md`。

### 人工验收（真机门槛，逐条过）

- [ ] 会话启动自动出现挂件（SessionStart 钩子生效）；`autoStartWidget=false` 后不再自启
- [ ] 菜单能打开、能点、**不打断宿主前台**；点角色后宿主画面不冻结
- [ ] **积分三数字出数**：今日积分 / 本轮 credit / 上下文 xx%，且与客户端显示一致
- [ ] 上下文余量与实际会话长度相符
- [ ] 按模型换角色：切到 `glm-5.3` / `deepseek-v4.1-flash` / `kimi-*` 时两拍内换形象；`hy4-preview` / `step-5-preview` 不动（预期）
- [ ] 角色配色弹层：拖动实时预览、松手落盘；「恢复默认」可回退
- [ ] 浮层穿透：指针在角色外时宿主可正常操作；压到角色才接管
- [ ] 「等确认提醒」：开启后能在宿主弹通知时提醒一次（**已知会比 ZCode 版更容易多提醒**）
- [ ] 两端同装（ZCode 版 + WorkBuddy 版）时桌面**只有一个**角色
- [ ] 出站不可用时不崩、不静默造假数据（读不到就明确标注来源缺失）


## 7. 移植历程与档案

| 阶段 | 文档 | 一句话 |
|---|---|---|
| Phase 0 探路 | `docs/porting/phase-0.md` | 四项验证全通；**`source: "./"` 合法**（省掉子目录重构）；数据源比 ZCode 更好 |
| Phase 1 骨架 | `docs/porting/phase-1.md` | 清单/钩子/路径/命令/skill 全部 WorkBuddy 化；新增宿主适配层 |
| Phase 2 数据源 | `docs/porting/phase-2.md` | 积分主口径 + 上下文余量；真实数据实测样例在文内 |
| Phase 3 浮层 | `docs/porting/phase-3.md` | 跟随目标改名；**移除 ui-ready 门控**；`type:'toolbar'` 未动 |
| Phase 5 收尾 | `docs/porting/phase-5.md` | 测试、产品口径、发版与验收清单 |


## 8. 已知限制

1. **真机未验证项**：客户端里实际注册目录市场并安装、钩子真的被触发、浮层跟随宿主窗口、
   `Notification` 是否只在「等确认」时发。证据链已备好（`autostart.log` / `hook-state.json` /
   `FOX_WIDGET_HOOK_DEBUG=1` 的 `hook.log` / `/whale/health`），首次真机运行请逐项确认。
2. **今日积分有上限**：只扫最近 60 个会话、每个 2MB 尾部。会话极多的用户会偏低
   （`scannedTranscripts`/`totalTranscripts` 可诊断）。
3. **`session_usage.credit_json` 是按请求覆盖的**，所以它只能当「最后一轮」的权威值，
   不能当今日合计。今日合计走 transcript 聚合。
4. **`hy*` / `step*` 模型没有内置立绘**，按模型换角色时有意不动。
5. **自更新默认关闭**；开着时与宿主插件管理的混用风险仍在（见 `docs/porting/phase-5.md`）。
6. macOS / Linux 只有浏览器页面形态（浮层依赖 Win32），继承 ZCode 版结论、未在 WorkBuddy 上重测。
7. 注释里仍有多处「ZCode」字样（描述历史来源的措辞），属有意保留；**代码路径中已无
   `~/.zcode` 或 `${ZCODE_PLUGIN_ROOT}` 字面量**（有测试钉住）。


## 9. 性能：跟随脚本为什么能既勤又省

浮层跟随靠一个常驻探测脚本（`desktop/follow-window.ps1`）读 WorkBuddy 主窗口的位置、大小与前台状态。**默认 40ms 探测一次**，实测端到端跟随延迟约 **13ms**——拖窗口时鲸鱼基本是贴着走的。

之所以能一边跑得勤、一边几乎不吃 CPU，是两点设计：

- **探测循环编译成 C# 运行**（脚本内联 `Add-Type`），不是解释执行的 PowerShell 循环。同样 40ms 间隔，解释执行的循环体本身就吃掉约 3.4% 单核，编译后只剩 **0.16%**。
- **贵的操作单独限频**：枚举进程（`GetProcessesByName`）用来定位 WorkBuddy 主窗口句柄与其 pid 列表，按 3 秒预算刷新；「前台是不是浮层自己」不再靠进程名枚举，而是比对主进程传入的浮层 pid（v1.3.1 起，见上）。每个探测周期只做几个微秒级的 Win32 调用，且**只有状态真的变化才输出**。

实测对照：

| 探测间隔 | 端到端跟随延迟 | 探测进程 CPU（单核占比） |
|---|---|---|
| 40ms（默认） | 13ms | 0.16%（稳态） |
| 250ms | 135ms | 探测次数少 6 倍，只会更低 |

也就是说间隔调小几乎没有性能代价。菜单里改即时生效，不用重启浮层。

---


---

## 10. 文档去哪儿了

| 想找 | 去哪 |
| --- | --- |
| 用户怎么装、怎么用 | [`../README.md`](../README.md) |
| 这版改了什么 | [`../CHANGELOG.md`](../CHANGELOG.md) |
| 为什么这么写（按主题） | [`DECISIONS.md`](./DECISIONS.md) |
| 一次性评审 / 事故记录 | [`reviews/`](./reviews/) · [`incidents/`](./incidents/) |
| 移植期的阶段档案 | [`porting/`](./porting/)（只增不改） |
| 全部文档索引 | [`INDEX.md`](./INDEX.md) |
