<div align="center">
  <img src="docs/readme/banner.svg" width="980" alt="WorkBuddy狐娘小挂件：常驻 WorkBuddy 的积分账桌宠">
</div>

<p align="center">
  <a href="https://github.com/pigeon189/zcode-fox-widget/releases/tag/wb-v1.3.5"><img src="https://img.shields.io/badge/version-wb--v1.3.5-F0A04B?style=flat-square" alt="版本 wb-v1.3.5"></a>
  <a href="https://github.com/pigeon189/zcode-fox-widget/tree/workbuddy"><img src="https://img.shields.io/badge/branch-workbuddy-576082?style=flat-square" alt="workbuddy 分支"></a>
  <img src="https://img.shields.io/badge/platform-Windows-576082?style=flat-square" alt="Windows">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.5-3F7D58?style=flat-square" alt="Node.js ≥ 22.5">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-6B6660?style=flat-square" alt="MIT License"></a>
  <a href="https://github.com/pigeon189/zcode-fox-widget/stargazers"><img src="https://img.shields.io/github/stars/pigeon189/zcode-fox-widget?style=flat-square&color=F0A04B" alt="GitHub Stars"></a>
</p>

> 显示 **今日积分**、**上下文余量**、**本轮消耗 credit**（附 `≈` 等价金额参考值），另有可选的 **DeepSeek 余额**与 **44 个厂商模板**；每轮对话结束弹一颗气泡，报告本轮积分。
>
> 浮层跟着 WorkBuddy 窗口移动、最小化、关闭，指针不在角色上时点击直接穿透；开「桌宠模式」后以整个工作区为家，切应用也不隐身。WorkBuddy 移到另一块显示器时，浮层会在窗口停稳约 0.7 秒后跟到那块屏（桌宠模式仍以启动时所在屏为家）。
>
> 同仓双分支：本分支 `workbuddy` 是 WorkBuddy 线（**订阅积分**口径）；另一条线是 <a href="https://github.com/pigeon189/zcode-fox-widget/tree/main"><img src="https://img.shields.io/badge/branch-main-D9772E?style=flat-square" alt="main 分支"></a> ZCode狐娘小挂件（按量余额口径）。两条线的版本号与更新通道各自独立、互不包含。

## 30 秒了解

<table>
<tr>
<td width="33%" valign="top">
  <b>🐋 今日积分与上下文</b><br/>
  <sub>读宿主 <code>workbuddy.db</code> 与会话 transcript 里每次模型调用的 <code>credit</code>，按日聚合；上下文余量读 <code>used / size</code>，10 秒刷新。主口径不需要任何 Key。</sub>
</td>
<td width="33%" valign="top">
  <b>🏪 44 个厂商模板</b><br/>
  <sub>DeepSeek 余额、订阅窗口、10 家中转站与 CommandCode；默认全部「未配置」是预期——WorkBuddy 不存用户自带凭据，配了才显示数字，缺的数字绝不补 0。</sub>
</td>
<td width="33%" valign="top">
  <b>🧾 每轮消耗与账本</b><br/>
  <sub>气泡报本轮 credit 与模型调用次数，附 <code>≈</code> 等价金额；账本按今日 / 近 7 天 / 逐轮聚合，用量记录与记账二级页可搜索、可预警。</sub>
</td>
</tr>
<tr>
<td width="33%" valign="top">
  <b>🎭 六套角色与音效</b><br/>
  <sub>嘎啦嘛 / 大肥鱼 / GPT娘 / kimi娘 / 小克 / 哈基米；按模型自动换角色、气泡配色自定义，三套内置音效可导入。</sub>
</td>
<td width="33%" valign="top">
  <b>🐾 浮层与桌宠</b><br/>
  <sub>跟随窗口、贴边镜像、桌宠模式整屏漫游、跨屏 0.7 秒跟随、点击穿透；窗口不压自动隐藏任务栏的热区。</sub>
</td>
<td width="33%" valign="top">
  <b>🔄 自启、更新与迁移</b><br/>
  <sub>会话钩子拉起 + 登录看门狗每 15 秒补活；升级默认走市场刷新，挂件内自更新是可选项；fox-dock 2.0 提供「查看说明后升级」两步迁移。</sub>
</td>
</tr>
</table>

## 快速开始

装插件 → 重启会话 → （要浮层再）装运行时 → 打开 WorkBuddy。

**前置条件**

| 项目 | 要求 |
|---|---|
| WorkBuddy 客户端 | 插件宿主，通过市场源安装 |
| Node.js | `node -v` 可用（宿主自带 v22.22）；`node:sqlite` 需 ≥ 22.5，缺了「今日积分 / 上下文余量」会退化为读不到 |
| 操作系统 | 桌面浮层仅 Windows（依赖 Win32 与 PowerShell）；macOS / Linux 用本地页面：`node lib/cli.mjs start` 后浏览器打开 `http://127.0.0.1:39321/` |
| Electron 运行时 | 仅浮层需要，一次性安装（约 150MB 下载 / 370MB 占用） |

### 安装

1. **加市场源（二选一）**

   **A. 市场仓库（推荐）**：左栏「专家·技能·连接器」→「技能」→「套件」→ 右上角「新增市场」，市场源填
   `pigeon189/fox-widget-marketplace`。这是 WorkBuddy 线专用市场仓库，只放市场清单与插件副本；加一次就够，升级也走它。

   > 宿主认 `owner/repo`，拉的是默认分支 `main`，**不认 `owner/repo#分支`**。直接填源码仓库名会拉到 ZCode 线的 `main`（没有 `.codebuddy-plugin/`），市场里不会出现 `fox-widget`。确实要装分支快照时，市场源填 `https://github.com/pigeon189/zcode-fox-widget/archive/refs/heads/workbuddy.zip`。

   **B. 本地目录（要改代码时用）**：`git clone -b workbuddy` 后，在同一入口点「新增市场」，把**仓库绝对路径**填进市场源（指向含 `.codebuddy-plugin/marketplace.json` 的仓库根）。

   > 同时装 ZCode 版时，两边各克隆一份——两个宿主盯同一个工作区，任一端重抓都会覆盖另一端。

2. **安装并启用** `fox-widget`（范围选 **user**；安装后在套件管理里确认已启用；MCP 默认开启）。
3. **重启会话**（或重开 WorkBuddy），让 MCP 与 hooks 生效。
4. **要桌面浮层再装运行时**：

   ```bash
   node lib/cli.mjs desktop install
   ```

   这一步会顺手装好登录自启的看门狗。装好后打开 WorkBuddy，角色会自己出现。

**不装 Electron 或非 Windows**：`node lib/cli.mjs start`，浏览器打开 `http://127.0.0.1:39321/`（端口被占时会顺延，`status` 会打印实际地址）。本地页面具备除浮层专属项（桌宠模式、跟随延迟）之外的全部功能与面板，只是不能浮在 WorkBuddy 窗口上。

> 以下命令都在**插件根目录**执行（市场安装时在 `.../plugins/cache/fox-local/fox-widget/<版本>/`）。

<p align="center">
  <img src="docs/readme/terminal.svg" width="680" alt="安装、状态检查与浮层启动的常用命令（输出做了省略）">
</p>

日常就这三条命令：装运行时 → 看状态 → 起浮层（服务由会话钩子与看门狗拉起，一般不用手动 `start`）。

更新与迁移的完整说明见 [功能详解 · 更新与迁移](#更新与迁移)。

## 首次配置

**主口径不需要任何 Key**：「今日积分」「上下文余量」「每轮消耗」都是读宿主自己的库与 transcript，装完就有数。只有可选的厂商余额卡才需要配 Key（没配时余额卡显示「未找到 DeepSeek API Key」是正常状态）。

查找顺序（`lib/credentials.mjs`）：

1. 环境变量 `DEEPSEEK_API_KEY`
2. 插件数据目录 `config.json` 的 `apiKey`（或按模板写的 `vendorKeys.<模板 id>`）
3. 宿主 `settings.json` 里的凭据候选

<p align="center">
  <img src="docs/readme/credentials.svg" width="980" alt="可选的 DeepSeek API Key 三步查找顺序：环境变量 → 插件配置 → 宿主 settings.json">
</p>

命中即停；三条都没命中时，只有余额卡受影响，其余功能照常。

```bash
echo 'sk-xxxxxxxx' | node lib/cli.mjs key   # 走 stdin，不留命令行痕迹
```

`config.json` 常用字段：

| 字段 | 默认 | 作用 |
|---|---|---|
| `apiKey` | — | DeepSeek API Key（可选；也可用 `key` 命令写入） |
| `usageMode` | `ledger` | 对账口径的兜底初值；挂件初始化后的实际口径存在 `widget-state.json`，以菜单 / MCP 修改为准（`mode` 命令只写这里，菜单保存过设置后不再生效） |
| `autoStartWidget` | `true` | 会话启动时拉起服务（看门狗也照它怠速） |
| `autoStartOverlay` | `true` | 顺便拉起浮层（运行时未安装时静默跳过） |
| `followIntervalMs` | `40` | 跟随探测间隔（16–2000ms；菜单可选 16 / 40 / 100 / 250，选择存在本地并即时生效） |
| `port` | 自动（默认 39321） | 固定端口，占用时顺延 |

厂商凭据写在 `vendorKeys.<模板 id>`；中转站另有一类**账户级**查询（系统访问令牌 + 用户 ID），写在 `relayAuth.<站点 id> = { token, userId }`——只有 `vendorKeys` 时能查 token 额度，账户余额需要 `relayAuth`。挂件自身的外观与开关（大小、音效、音量、角色、主题、气泡、默认位置、桌宠模式、预警阈值等）在 `widget-state.json`（由挂件菜单写入）；按压泡泡队列与模板单独存 `bubble-content.json` / `bubble-templates.json`。

## 功能详解

### 每轮消耗与账本

<p align="center">
  <img src="docs/readme/turn-pipeline.svg" width="980" alt="每轮消耗的产生流程：对话完成 → 读取本轮 → 折算参考 → 气泡与账本">
</p>

一轮对话结束后，宿主把这一轮的 credit 与上下文用量写进 `session_usage` 与会话 transcript；挂件按 `conversationRequestId` 取出本轮，优先用宿主结算后的 `credit_json`，宿主还没结算时按 `rawUsage.credit` 兜底并标「结算中」。结果分成两路：气泡报本轮 credit（以及模型调用次数），账本按今日 / 近 7 天 / 逐轮聚合、可搜索；`≈` 金额是参考值，由公开价目折出来，积分主数字不受价目影响。逐档核对用 `node lib/cli.mjs turn`，口径细节见 [数据与计价口径](#数据与计价口径)。

### 浮层与桌宠

<p align="center">
  <img src="docs/readme/overlay-modes.svg" width="980" alt="跟随模式与桌宠模式的对比">
</p>

- 角色可拖到窗口内任意位置，靠边吸附，贴左缘时整体镜像。
- **指针要先落在角色上，点击才被浮层接管**——穿透设计的必然代价，换来不误触。
- 普通交互不抢 WorkBuddy 前台；菜单里的输入控件按上去才临时接管键盘，离开即交还。
- 浮层窗口四边各内缩 4 DIP 安全边距，不压制自动隐藏任务栏的滑出热区。
- **桌宠模式**（菜单可开关）：角色以整个工作区为家，可以拖出 WorkBuddy 窗口；锁在最上层、失焦也不隐身，适合把角色放在桌面角落常驻。唯一例外是全屏应用（游戏 / 全屏视频）在前台时会自动让路，退出全屏后恢复。
- 宿主换到另一块显示器时，浮层在窗口停稳约 0.7 秒后整窗跟过去（桌宠模式仍以启动时所在屏为家）。

### 角色与音效

<table align="center">
<tr>
<td align="center"><img src="assets/GLM.png" width="96" alt="嘎啦嘛"><br/><sub><b>嘎啦嘛</b><br/>glm / zhipu / chatglm / z.ai / zai- / bigmodel</sub></td>
<td align="center"><img src="assets/DSniang1.png" width="96" alt="大肥鱼"><br/><sub><b>大肥鱼</b><br/>deepseek</sub></td>
<td align="center"><img src="assets/gpt.png" width="96" alt="GPT娘"><br/><sub><b>GPT娘</b><br/>gpt / openai / chatgpt / o1- / o3- / o4- / codex</sub></td>
</tr>
<tr>
<td align="center"><img src="assets/kimi.png" width="96" alt="kimi娘"><br/><sub><b>kimi娘</b><br/>kimi / moonshot</sub></td>
<td align="center"><img src="assets/xiaoke.png" width="96" alt="小克"><br/><sub><b>小克</b><br/>claude / anthropic</sub></td>
<td align="center"><img src="assets/gemini.png" width="96" alt="哈基米"><br/><sub><b>哈基米</b><br/>gemini</sub></td>
</tr>
</table>

「按模型换角色」按模型标识的**小写子串**匹配上表关键词（宿主给的标识形如 `<provider>/<model>`，只有子串匹配能罩住各家写法）；认不出的模型不动当前角色，手选形象后自动关闭换角。每套角色有专属台词池；角色可导入、改名、删除，内置形象也能隐藏；每个角色还能单独改浅色 / 深色两档气泡配色（内嵌调色板 + HEX/RGB 输入）。

**音效**：内置三套——小黄鸭（`duck`）、嘀嘟（`fx1`）、猫娘（`nya`，按压喵声、松手静音；素材 CC0，出处见 [`NOTICE`](./NOTICE) 与 [`docs/CATGIRL-SOUND-NOTES.md`](./docs/CATGIRL-SOUND-NOTES.md)）；支持导入自定义音效集，音量可调、0 即静音。

### 自启与看门狗

WorkBuddy 启动本身不触发插件钩子（钩子跟「会话动作」走），所以光有钩子会出现「开机后一动不动 = 桌面上没挂件」。看门狗补这个缺口：登录自启的独立进程，监听宿主启停日志，宿主一启动就把服务与浮层拉起来，运行期每 15 秒补活。不碰注册表、不需要管理员、不存密钥；启动项写在用户启动文件夹，删文件即卸载，插件升级后不需要重装。

```bash
node lib/cli.mjs watchdog status      # 自启项与进程状态
node lib/cli.mjs watchdog install     # 立即安装并启动（desktop install 也会顺手装）
node lib/cli.mjs watchdog uninstall   # 删除启动项并停掉进程
node lib/cli.mjs watchdog run         # 守护进程本体（由启动项拉起，不用手跑）
```

`autoStartWidget=false` 时看门狗怠速；日志在插件数据目录的 `watchdog.log`（会话钩子那一侧写 `autostart.log`）。点过菜单里的「关闭插件」后，看门狗本次停手，只到下次宿主启动——这正是「只关这一次」的语义。

### 在对话里用（MCP 与 `/fox`）

输入 `/fox`，或直接问「我还有多少积分」「上一轮花了多少」，WorkBuddy 会调 MCP：

| 工具 | 作用 |
|---|---|
| `whale_credits` | 今日积分与上下文余量（主口径） |
| `whale_balance` | 余额与今日已用（可选卡） |
| `whale_last_turn` | 上一轮积分与明细 |
| `whale_widget` | 服务与浮层的启停 / 状态 |
| `whale_config` | 查看或修改配置 |

### 更新与迁移

<p align="center">
  <img src="docs/readme/update-flow.svg" width="980" alt="挂件内自更新的三步流程（默认关闭）">
</p>

- **市场刷新（默认升级路径）**：本分支**默认关闭挂件内自更新**（原地覆盖会和宿主插件管理打架），升级 = 市场页「刷新」+ 重装 + 重启客户端；`git pull` 只对本地目录安装有效。数据在插件数据目录，配置不丢。
- **挂件内自更新（默认关）**：想开就设 `FOX_WIDGET_ENABLE_UPDATE_CHECK=1`（6 小时自检、镜像链、验签、先备份再替换），风险自负；`WHALE_DISABLE_UPDATE_CHECK=1` 在本分支仍最高优先、可显式关掉（main 分支默认开）。
- **迁到 fox-dock 2.0（独立桌宠程序）**：正式版发布后（远端清单带迁移公告），开自更新的用户会在「检查更新…」面板看到迁移入口——先点「查看说明后升级」在系统浏览器里看功能与升级代价，确认后按钮变「立即升级」，点击只做本机只读预检并给出安装引导（不代下载、不停服务、不动现有数据）。WorkBuddy 线的凭据不在 dock 的自动导入链里，需在 dock 控制台手动录入。`node lib/cli.mjs migrate --check` 可随时只读预检（不开自更新也能用）；`FOX_WIDGET_DISABLE_MIGRATION=1` 可整体关闭迁移入口。

## 数据与计价口径

- **今日积分 = 宿主算好的 credit**：挂件只做聚合，扫最近 60 个会话，单文件只读 transcript 尾部（默认 32 MB，`FOX_WIDGET_TAIL_BYTES` 可调）；会话极多或极长时合计会偏低，`scannedTranscripts` / `totalTranscripts` 暴露实际范围，被截断的文件在 `truncatedTranscripts` 里如实标记。
- **上下文余量**：`workbuddy.db` 的 `session_usage`（`used / size`），10 秒刷新。
- **每轮消耗**：一轮 = 一个 `conversationRequestId`；优先取 `session_usage.credit_json`，宿主未结算时按 `rawUsage.credit` 兜底并标「结算中」。
- **等价金额（`≈`）是参考值**：按公开价目折算，不代表真实扣费；积分不受价目影响。
- **可选厂商余额**：只有自己配了 Key 才会有数字；没配、没接口、数据缺失都如实显示「未配置」或具体原因，绝不补 0。

完整字段与坑（`prompt_tokens` 含缓存、`completion_tokens` 含思考）见 [`docs/DECISIONS.md`](./docs/DECISIONS.md)。

## 架构

<p align="center">
  <img src="docs/readme/architecture.svg" width="980" alt="架构：WorkBuddy 宿主 → 插件（内核 / 服务 / 页面 / 浮层）→ 外部接口（仅白名单）">
</p>

- **宿主只读**：`workbuddy.db`（WAL）、`projects/*/*.jsonl`、`settings.json`、`preferences.json`——挂件不写宿主配置。
- **本地服务**：`lib/server.mjs` 只监听 `127.0.0.1`，页面、立绘、音效与 JSON 接口都走它；写操作校验 `Origin`，关停需 `server.json` 里的随机令牌。
- **两种形态**：桌面浮层（主形态）加载同一份本机页面；浏览器打开 `http://127.0.0.1:<port>/` 是备用 / 排障入口。
- **宿主差异唯一落点**：`lib/host.mjs`；其余模块只认这一层提供的路径、库与事件定义。

| 组件 | 文件 | 职责 |
|---|---|---|
| 挂件服务 | `lib/server.mjs` | 本地 HTTP 服务（默认 `127.0.0.1:39321`），页面、立绘、音效与全部 JSON 接口 |
| 前端挂件 | `lib/widget.js` | 原生 JS，拖拽 / 吸附 / 翻转 / 气泡 / 菜单 / 音效，以及浮层穿透切换 |
| 桌面浮层 | `desktop/main.cjs`、`desktop/preload.cjs` | 透明置顶无边框窗口承载挂件页面，默认鼠标穿透，只加载本机 127.0.0.1 |
| 浮层管理 | `lib/overlay.mjs` | 浮层单例检查、启停，以及 Electron 运行时的按需安装 |
| 今日积分聚合 | `lib/usage-records.mjs` | 扫 transcript 做按日 / 按模型统计（积分主口径） |
| 每轮消耗 | `lib/turn-cost.mjs` | 读 `session_usage` 与 transcript 的 credit，换算每轮积分、上下文与逐档明细 |
| 余额与账本 | `lib/balance.mjs` | DeepSeek 余额卡、记账模式累计、25 秒缓存与瞬时失败回退 |
| 厂商模板 | `lib/vendors.mjs` | 44 个厂商模板的凭据解析、出站校验、缓存与归一化 |
| 定价 | `lib/pricing.mjs` | 峰谷时段判定与 token→金额换算（与 main 分支共享） |
| 凭据与出站校验 | `lib/credentials.mjs`、`lib/blocked-host.mjs` | 找 API Key、出站白名单与环回 / 私有 / 保留地址判定 |
| 宿主适配层 | `lib/host.mjs` | 与 WorkBuddy 之间所有宿主差异的唯一落点 |
| 宿主主题 | `lib/host-theme.mjs` | 「跟随 WorkBuddy」的三层判定（观测 / 配置 / 系统） |
| 会话自启 | `lib/autostart.mjs` | SessionStart 钩子幂等拉起服务 |
| 看门狗 | `lib/watchdog.mjs` | 独立常驻进程：监听宿主启停日志、每 15 秒补活 |
| 挂件服务管理 | `lib/service.mjs` | 服务发现 / 拉起 / 关闭，跨进程启动锁与端口顺延 |
| 更新与迁移 | `lib/update.mjs`、`lib/migrate.mjs` | 镜像链探测、整包验签、失败回滚；fox-dock 2.0 迁移探测与只读预检 |
| MCP 工具 | `lib/mcp-server.mjs` | `whale_*` 五个工具 |
| 命令行 | `lib/cli.mjs` | `status` / `turn` / `start` / `stop` / `window` / `desktop install` / `watchdog` / `key` / `mode` / `migrate --check` / `vendors` / `url` / `json` |
| 跟随脚本 | `desktop/follow-window.ps1`、`desktop/window-bounds.cjs`、`desktop/display-follow.cjs` | Win32 窗口位置探测、工作区边界与跨屏切换判定 |

**44 个厂商模板的构成**（`lib/vendors.mjs` 的 `TEMPLATES`）：

| 类型 | 数量 | 说明 |
|---|---|---|
| 余额接口（`kind: balance`） | 7 | DeepSeek、GLM 按量、OpenRouter、Kimi 国内 / 国际、StepFun、Novita |
| 订阅窗口（`kind: quota`） | 6 | 智谱 Coding Plan（国内 / 国际）、Kimi Coding、MiniMax Coding（国内 / 国际）、OpenCode Go |
| 本地套餐（`kind: cmdgo`） | 1 | CommandCode（官方 API 与本地账号池） |
| 按量计价（`kind: tokens`） | 20 | OpenAI、Claude、Gemini、Qwen、Grok、Mistral 等；官方无余额接口，只报凭据状态，金额走本机 token 用量 |
| 中转站（`kind: relay`） | 10 | 见 [`lib/relays.mjs`](./lib/relays.mjs) |
| **合计** | **44** | |

### 与 ZCode 线（main 分支）的差异

| 维度 | `main`（ZCode 线） | 本分支 |
|---|---|---|
| 主显示 | DeepSeek 余额 + 今日已用 | 今日积分 / 本轮 credit / 上下文余量 |
| 数据源 | 按量余额接口 + ZCode 本机库 | 宿主 `workbuddy.db` + 会话 transcript |
| 窗口 | 自建透明置顶浮层 | 同左（跟随 WorkBuddy） |
| GLM Plan 配额 | 有 | 已砍（宿主无对应数据源） |
| 厂商卡 | 核心功能 | 可选附加（宿主默认无 Key） |
| 自启 | 会话钩子 + 登录看门进程 | 会话钩子 + 登录看门狗（每 15 秒补活） |
| 更新 | 挂件内自更新默认开 | 挂件内自更新默认关，走市场刷新 |
| 发布 | `main` · `v*` tag | `workbuddy` · `wb-v*` tag |

## 命令行

```bash
node lib/cli.mjs status            # 今日积分 + 近 7 天 + 上下文余量 + 服务与浮层状态（credits 同义）
node lib/cli.mjs turn              # 上一轮消耗（积分 + 等价金额 + 逐档明细）
node lib/cli.mjs start / stop      # 启停挂件服务（页面与浮层共用）
node lib/cli.mjs restart-all       # 服务 + 浮层一起重启
node lib/cli.mjs close             # 本次关闭（不写自启开关，看门狗本次停手）
node lib/cli.mjs window start|stop|status|restart
node lib/cli.mjs desktop install   # 安装 Electron 运行时（仅浮层需要，顺手装看门狗）
echo 'sk-...' | node lib/cli.mjs key   # 写 Key（走 stdin，不留命令行痕迹）
node lib/cli.mjs mode ledger|token     # 写兜底口径（菜单未保存过时生效）
node lib/cli.mjs watchdog status|install|uninstall|run   # 看门狗（见上）
node lib/cli.mjs migrate --check       # fox-dock 2.0 迁移只读预检（输出 JSON）
node lib/cli.mjs vendors           # 全部厂商余额 / 额度与不可用原因（不输出密钥）
node lib/cli.mjs url               # 打印当前挂件地址
node lib/cli.mjs json              # 结构化输出
```

## 数据目录与故障排查

数据都在 WorkBuddy 的插件数据目录 `${CODEBUDDY_PLUGIN_DATA}`：

| 文件 / 目录 | 内容 |
|---|---|
| `config.json` | 配置（Key、口径、端口、自启、跟随间隔、厂商凭据 `vendorKeys` / 中转站 `relayAuth`） |
| `widget-state.json` | 外观与开关（大小、音效、角色、主题、气泡、默认位置、桌宠模式、预警阈值） |
| `usage-ledger.json` | 记账账本（记账口径的累计） |
| `roles.json` + `roles/`、`sounds.json` + `sounds/`、`bubble-imgs.json` + `bubble-imgs/` | 自定义角色、音效集、泡泡图库 |
| `bubble-content.json`、`bubble-templates.json` | 按压泡泡队列与模板 |
| `hook-state.json` | 最近一次钩子事件（会话身份、当前模型、等确认状态） |
| `close-pause.json` | 「本次关闭」标记（看门狗据此停手，下次宿主启动失效） |
| `server.json` | 本地服务的随机令牌（停止服务要用） |
| `update/`、`update-state.json`、`update-files.json` | 更新下载与备份工作区（可删）、更新与迁移预检状态 |
| `watchdog.json`、`watchdog.log`、`autostart.log`、`overlay-debug.log` | 看门狗状态与日志、会话自启日志、浮层调试日志 |
| `desktop-runtime/` | Electron 运行时（仅浮层用，可重装） |

市场重装与 `git pull` 都不动这里，配置不丢。

排障入口：先跑 `node lib/cli.mjs status` 看主口径与服务；反馈问题时菜单 → 「关于 / 自检…」→「全选复制」，把那段脱敏 JSON 一起发出来（不含密钥，路径已脱敏）；服务健康看 `/whale/health`。

<details>
<summary>常见现象对照表（点开）</summary>

| 现象 | 处理 |
|---|---|
| 界面上看不到挂件 | WorkBuddy 不提供界面注入点，必须走桌面浮层：`desktop install` 后 `window start` |
| 打开 WorkBuddy 没自动出现 | 看 `autostart.log` 最后一行：无新行 = 钩子没加载；`skip: autoStartWidget=false` = 配置关了；`overlay=skipped:no-runtime` = 运行时没装；再看 `watchdog.log` 看门狗是否在跑 |
| 点过「关闭插件」想立刻回来 | `node lib/cli.mjs start`（要浮层再加 `window start`）；它只是本次关闭，下次启动照常拉起 |
| 积分 / 上下文一直读不到 | 看 `/whale/hook.json` 有没有 `sessionId`；再看 `/whale/context.json` 的 `reason`（`db-unavailable` = 库读不到或 Node < 22.5） |
| 今日积分比客户端小 | 只扫最近 60 个会话、每个只读尾部窗口的性能取舍；看 `scannedTranscripts` / `truncatedTranscripts` 判断扫描范围 |
| 每轮消耗不弹 | 需要宿主完成过一轮对话（transcript 有 `rawUsage`），且菜单开关是开的 |
| 等价金额虚高十几倍 | 折价踩了「input 含缓存」的坑；积分主数字不受影响，`cli.mjs turn` 看逐档 |
| 角色不跟着 WorkBuddy 走 | `window stop` → `window start` 重建；`WHALE_DEBUG_PORT` 启动可看 `overlay-debug.log` |
| 浮层里点不动 / 数字框打不了字 | 指针先落在角色上；输入控件按上去才接管键盘（旧版浮层可能没有） |
| 背景图 / 音效改了不生效 | 资产路由 `no-store`，强刷即可；确认替换的是 `assets/` 下的同名文件 |
| 余额卡说「未找到 DeepSeek API Key」 | 预期：宿主默认没有用户自带凭据，想用就自己配 |
| Plan 配额没了 | 本分支已砍（唯一数据源是 ZCode 客户端日志） |

</details>

### 已知限制

- 浮层仅 **Windows**；macOS / Linux 只有本地页面。
- 跟随靠轮询，理论上有约一个探测间隔的滞后（默认 40ms，实测约 13ms）。
- 浮层内吸附无滑动动画（避免透明窗口合成层错位）；本地页面里动画完整。
- 穿透的代价：点击前指针得先落在角色上。
- 每轮消耗只统计 WorkBuddy 记录的会话轮次，宿主外直接调用的 API 不计入。

## 卸载

按「先停进程 → 再移除自启 → 最后删数据」的顺序：

1. **停掉挂件**：`node lib/cli.mjs close`（等价于 `window stop` + `stop`）。
2. **移除看门狗**：`node lib/cli.mjs watchdog uninstall`。它会删除用户启动文件夹里的启动项并停掉进程；插件已卸载、CLI 不可用时，手动删启动文件夹里的 `fox-widget-watchdog.vbs` 即可。
3. **卸载插件**：在 WorkBuddy 套件管理里卸载或停用 `fox-widget`。
4. **删除数据目录（可选）**：里面有 Key、账本、角色、音效、配置、更新备份与 Electron 运行时（`desktop-runtime/`）；**删除后不可恢复**，需要保留就先备份。运行时只服务于浮层，删掉后本地页面仍可用。

挂件不写宿主配置；除了插件缓存与这个启动项，没有别的系统级残留。

## 安全

- **出站白名单**：余额 / 额度请求只发往各模板声明并登记过的官方域名（如 `api.deepseek.com` / `platform.deepseek.com`），每条请求仍过出站白名单校验（拒绝环回 / 私有 / 保留地址）；更新链路是另一份白名单（GitHub 与转发镜像）。
- **本地服务**：只监听 `127.0.0.1`，校验 `Host` 与写操作 `Origin`；停止服务要 `server.json` 里的随机令牌。
- **更新**：下载整包在内存中解压、逐条校验路径，并核对发布签名清单（`.release-hashes.json` + ed25519）；清单外文件忽略不落盘。
- **浮层**：只加载本机页面，`contextIsolation` 下仅暴露必要 IPC；外链交给系统浏览器。
- **凭据**：来自环境变量或 0600 权限的 `config.json`，请求时现读；不写日志、界面只显示掩码，不复制到其它文件。
- **看门狗**：只用当前用户启动文件夹里的一个隐藏 VBS，不碰注册表、不需要管理员、不存密钥；它只探测宿主进程与启停日志，`watchdog uninstall` 可随时移除。

## 文档索引

| 想找 | 去哪 |
|---|---|
| 安装 / 使用 / 排障 | 本文件 |
| 这版改了什么 | [CHANGELOG.md](./CHANGELOG.md)（ZCode 线历史：[归档](./docs/CHANGELOG-ARCHIVE.md)） |
| 维护者手册（架构、宿主契约、发布流程） | [docs/MAINTAINING.md](./docs/MAINTAINING.md) |
| 为什么这么写（按主题） | [docs/DECISIONS.md](./docs/DECISIONS.md) |
| 全部文档 | [docs/INDEX.md](./docs/INDEX.md) |
| 1.x → fox-dock 2.0 迁移的准备方案（维护者向） | [MIGRATE-TO-FOX-DOCK-2.md](./MIGRATE-TO-FOX-DOCK-2.md) |
| 贡献规范（含文档风格与术语表） | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| 素材出处与授权 | [NOTICE](./NOTICE) |

## 鸣谢与许可证

| 来源 | 说明 |
|---|---|
| 原版 | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）—— DSH 的 Web 插件 |
| ZCode 移植 | [nb10yyds/zcode-whale-widget](https://github.com/nb10yyds/zcode-whale-widget) → 本仓库 `main` |
| 本分支 | 自 `zcode-fox-widget` v1.11.1 移植到 WorkBuddy，版本号另起（`wb-v*`） |

视觉、鲸鱼素材、音效、台词与定价表来自上游；`GLM.png` / `gpt.png` / `kimi.png` / `gemini.png` 为本项目自有素材，`xiaoke.png` 取自 [aklnaaw/dsh-xiaoke-widget](https://github.com/aklnaaw/dsh-xiaoke-widget)（MIT，已获原作者授权）；猫娘音效来自 Cici Fyre 的 *Free Catgirl Fighting Voice Pack*（CC0 1.0 Universal）。逐条清单见 [NOTICE](./NOTICE)。

### 许可证

[MIT](./LICENSE)。

```text
MIT License · 上游 © 2026 MeteorNOX，本仓库 © 2026 pigeon189
```
