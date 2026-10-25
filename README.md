# WorkBuddy狐娘小挂件（fox-widget）

<div align="center"><img src="assets/wb.png" width="420" alt="WorkBuddy狐娘小挂件"></div>

> 常驻 WorkBuddy 右下角的桌宠：**今日积分**（订阅积分主口径）、**上下文余量**、**每轮消耗 credit**（附一个 `≈` 等价金额参考值），可选的 DeepSeek 余额与 35 家厂商模板。
>
> 浮层跟着 WorkBuddy 窗口移动、最小化、关闭，指针不在它身上时点击直接穿透；开「桌宠模式」后以整个工作区为家，切应用也不隐身。
>
> **本仓库是 `workbuddy` 分支**：与 `main`（ZCode 线，按量余额口径）同源双分支，共享页面 / 服务 / 定价 / 记账 / 浮层 / 测试框架，宿主差异收敛在 `lib/host.mjs`。分支与发版纪律见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

---

## 快速开始

**前置**：WorkBuddy 客户端；`node -v` 可用（自带 v22.22.2）；Windows（浮层依赖 Win32，macOS / Linux 只能用本地页面）。

1. **加市场源**：左栏「专家·技能·连接器」→「技能」→「套件」→ 右上角「新增市场」，市场源填：

   ```text
   pigeon189/fox-widget-marketplace
   ```

   WorkBuddy 线专用的市场仓库（默认分支 `main`，只放市场清单与插件副本）。加一次就够，以后升级也走它，不受源码仓库 `main`（ZCode 线）影响。

2. **安装并启用** `fox-widget`，范围选 **user**（清单默认启用）。
3. **重启会话**（或重开 WorkBuddy），让 MCP 与 hooks 生效。

4. **要桌面浮层再装运行时**（约 150MB 下载 / 370MB 占用，一次性）：

   ```bash
   node lib/cli.mjs desktop install
   ```

<details>
<summary>备用安装方式（不常用，点开）</summary>

- **分支 ZIP**：同一入口填 `https://github.com/pigeon189/zcode-fox-widget/archive/refs/heads/workbuddy.zip`。宿主不认 `owner/repo#分支`，直接填源码仓库名会拉默认分支 `main`（ZCode 线，没有 `.codebuddy-plugin/`），市场里不会出现 `fox-widget`。
- **本地目录（要改代码时用）**：`git clone -b workbuddy …` 后，把**仓库绝对路径**填进市场源（要指向含 `.codebuddy-plugin/marketplace.json` 的仓库根）。
- 同时装 ZCode 版时，两边各克隆一份——两个宿主盯同一个工作区，任一端重抓都会覆盖另一端。

</details>

### 更新

本分支**默认关闭挂件内自更新**（原地覆盖会和宿主插件管理打架）。升级 = 市场页「刷新」+ 重装 + 重启客户端；`git pull` 只对本地目录安装有效。数据在插件数据目录，配置不丢。

想开自更新：`FOX_WIDGET_ENABLE_UPDATE_CHECK=1`（6 小时自检、镜像链、验签、先备份再替换），风险自负。发版口径见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

---

## 功能

- **今日积分（主口径）**：读 `workbuddy.db` 与会话 transcript 里每次模型调用带的 `credit`，按日聚合。
- **上下文余量**：读宿主的 `used / size`，显示「上下文 22%」。
- **每轮消耗**：一轮结束弹气泡，报本轮积分、模型调用次数，以及 `≈` 等价金额参考值。
- **可选：厂商余额**：DeepSeek 余额与 35 个厂商模板（含订阅窗口与无接口厂商）；**默认全部「未配置」是预期**，WorkBuddy 不存用户自带凭据。
- **记账二级页**：用量记录（今日 / 近 7 天 / 逐轮，支持按模型名或日期搜索）、额度预警、余额预警、今日预算（积分）、余额校正；配了 DeepSeek key 时余额卡同时显示赠金 / 充值构成。
- **角色**：六套内置，按模型自动换角色、配色自定义、可导入自己的图。
- **桌宠模式**：整屏工作区漫游，锁在最上层，失焦不隐身。

## 与 ZCode 线的差异

| 维度 | `main`（ZCode 线） | 本分支 |
|---|---|---|
| 主显示 | DeepSeek 余额 + 今日已用 | 今日积分 / 本轮 credit / 上下文余量 |
| 数据源 | 按量余额接口 + ZCode 本机库 | 宿主 `workbuddy.db` + 会话 transcript |
| 窗口 | 自建透明置顶浮层 | 同左（跟随 WorkBuddy） |
| GLM Plan 配额 | 有 | 已砍（宿主无对应数据源） |
| 厂商卡 | 核心功能 | 可选附加（宿主默认无 key） |
| 发布 | `main` · `v*` tag | `workbuddy` · `wb-v*` tag |

---

## 使用

### 挂件菜单

悬停角色 → 右上角三点按钮：

| 分组 | 内容 |
|---|---|
| 外观 | 大小 0.6–2.5×（只缩放角色与气泡，菜单尺寸恒定）；主题：浅色 / 深色 / 跟随 WorkBuddy |
| 声音 | 音效组与音量，可导入自定义音效；音量 0 即静音 |
| 角色 | 选内置形象或导入图片（可改名 / 删除，内置形象也能隐藏）；「按模型换角色」默认开，手选后自动关 |
| 显示与口径 | 气泡主显示跟随哪个计费源；峰谷播报风格（仅 DeepSeek 卡相关） |
| 气泡 | 思考气泡开关、按压泡泡编辑器（含每轮消耗文案）、等确认提醒 |
| 位置与行为 | 「位置与行为…」二级页：默认位置（右下 / 左下 / 右上 / 左上）、避让滚动条、隐藏菜单按钮、每轮消耗提示与自动关闭秒数 |
| 浮层 | 桌宠模式、跟随延迟（16 / 40 / 100 / 250ms） |
| 更新与关闭 | 「检查更新…」面板（含「重启挂件」「关闭插件」）；关闭只停当前这一份，下次启动照常拉起 |

### 命令行

```bash
node lib/cli.mjs status           # 今日积分 + 上下文余量 + 近 7 天 + 服务与浮层状态
node lib/cli.mjs turn             # 上一轮消耗（积分 + 等价金额 + 逐档明细）
node lib/cli.mjs start / stop     # 启停挂件服务（页面与浮层共用）
node lib/cli.mjs window start|stop|status
node lib/cli.mjs desktop install  # 安装 Electron 运行时（仅浮层需要）
node lib/cli.mjs watchdog install|status|uninstall   # 看门狗（见下）
echo 'sk-...' | node lib/cli.mjs key   # 写 Key（走 stdin，不留命令行痕迹）
node lib/cli.mjs mode ledger|token     # DeepSeek 卡的对账口径
node lib/cli.mjs json             # 结构化输出
```

### 冷启动与看门狗

WorkBuddy 应用启动本身不触发插件钩子（钩子跟「会话动作」走），所以「开机后一动不动 = 桌面上没挂件」。看门狗补这个缺口：登录自启的独立进程，监听宿主启停日志，一启动就把服务与浮层拉起来，运行期每 15s 补活。

```bash
node lib/cli.mjs desktop install    # 装运行时同时顺手装看门狗（推荐）
node lib/cli.mjs watchdog status    # 查看自启项与进程
```

启动项写在用户启动文件夹，删文件即卸载；插件升级后不需要重装。`autoStartWidget=false` 时看门狗怠速。日志在 `${CODEBUDDY_PLUGIN_DATA}/watchdog.log`。

### 在对话里用

输入 `/fox`，或直接问「我还有多少积分」「上一轮花了多少」，WorkBuddy 会调 MCP：

| 工具 | 作用 |
|---|---|
| `whale_balance` | 余额与今日已用（可选卡） |
| `whale_last_turn` | 上一轮积分与明细 |
| `whale_widget` | 服务与浮层的启停 / 状态 |
| `whale_config` | 查看或修改配置 |

### 浮层交互

- 角色可拖到窗口内任意位置，靠边吸附，贴左缘时整体镜像。
- **指针要先落在角色上，点击才被浮层接管**——穿透设计的必然代价，换来不误触。
- 普通交互不抢 WorkBuddy 前台；菜单里的输入控件按上去才临时接管键盘，离开即交还。

---

## 首次配置

**主口径不需要任何 Key**；下面只服务可选的厂商余额卡。

查找顺序：环境变量 `DEEPSEEK_API_KEY` → 插件数据目录 `config.json` 的 `apiKey` / `vendorKeys.<模板 id>` → 宿主 `settings.json`（实测通常为空）。

```bash
echo 'sk-xxxxxxxx' | node lib/cli.mjs key
```

`config.json` 常用字段：

| 字段 | 默认 | 作用 |
|---|---|---|
| `autoStartWidget` | `true` | 会话启动时拉起服务（看门狗也照它怠速） |
| `autoStartOverlay` | `true` | 顺便拉起浮层 |
| `followIntervalMs` | `40` | 跟随探测间隔（菜单选择会覆盖） |
| `port` | 自动（39321） | 固定端口，占用时顺延 |

---

## 数据与计价口径

- **今日积分 = 宿主算好的 credit**：挂件只做聚合，扫最近 60 个会话的各 2MB 尾部；会话极多或极长时合计会偏低，`scannedTranscripts` / `totalTranscripts` 暴露实际范围。
- **上下文余量**：`workbuddy.db` 的 `session_usage`（`used / size`），10 秒刷新。
- **每轮消耗**：一轮 = 一个 `conversationRequestId`；优先取 `session_usage.credit_json`，宿主未结算时按 `rawUsage.credit` 兜底并标「结算中」。
- **等价金额是参考值**：按公开价目折算、标 `≈`，不代表真实扣费；积分不受价目影响。

完整字段与坑（`prompt_tokens` 含缓存、`completion_tokens` 含思考）见 [`docs/DECISIONS.md`](./docs/DECISIONS.md)。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 要反馈问题 | 菜单 →「关于 / 自检…」→「全选复制」，把那段 JSON 一起发出来（不含密钥，路径已脱敏） |
| 界面上看不到挂件 | WorkBuddy 不提供界面注入点，必须走桌面浮层：`desktop install` 后 `window start` |
| 打开 WorkBuddy 没自动出现 | 看 `${CODEBUDDY_PLUGIN_DATA}/autostart.log` 最后一行：无新行 = hook 没加载；`skip: autoStartWidget=false` = 配置关了；`overlay=skipped:no-runtime` = 运行时没装 |
| 点过「关闭插件」想立刻回来 | `node lib/cli.mjs start`（要浮层再加 `window start`）；它只是本次关闭，下次启动照常拉起 |
| 积分 / 上下文一直读不到 | 看 `/whale/hook.json` 有没有 `sessionId`；再看 `/whale/context.json` 的 `reason`（`db-unavailable` = 库读不到或 Node < 22.5） |
| 今日积分比客户端小 | 只扫最近 60 个会话、每个读尾部 2MB 的性能取舍；看 `usage-records.json` 的扫描范围 |
| 每轮消耗不弹 | 需要宿主完成过一轮对话（transcript 有 `rawUsage`），且菜单开关是开的 |
| 等价金额虚高十几倍 | 折价踩了「input 含缓存」的坑；积分主数字不受影响，`cli.mjs turn` 看逐档 |
| 鲸鱼不跟着 WorkBuddy 走 | `window stop` → `window start` 重建；`WHALE_DEBUG_PORT` 启动可看 `overlay-debug.log` |
| 浮层里点不动 / 数字框打不了字 | 指针先落在角色上；输入控件按上去才接管键盘（旧版浮层可能没有） |
| 背景图 / 音效改了不生效 | 资产路由 `no-store`，强刷即可；确认替换的是 `assets/` 下的同名文件 |
| 余额卡说「未找到 DeepSeek API Key」 | 预期：宿主默认没有用户自带凭据，想用就自己配 |
| Plan 配额没了 | 本分支已砍（唯一数据源是 ZCode 客户端日志） |

---

## 已知限制

- 浮层仅 **Windows**；macOS / Linux 只有本地页面。
- 跟随靠轮询，理论上有约一个探测间隔的滞后（默认 40ms，实测约 13ms）。
- 浮层内吸附无滑动动画（避免透明窗口合成层错位）。
- 穿透的代价：点击前指针得先落在角色上。
- 每轮消耗只统计 WorkBuddy 记录的会话轮次，宿主外直接调用的 API 不计入。

---

## 安全

- **出站白名单**：业务请求只发往 `api.deepseek.com` / `platform.deepseek.com`；更新链路是另一份白名单（GitHub 与转发镜像）。两者都拒绝环回 / 私有地址。
- **本地服务**：只监听 `127.0.0.1`，校验 `Host` 与写操作 `Origin`；停止服务要 `server.json` 里的随机令牌。
- **浮层**：只加载本机页面，`contextIsolation` 下仅暴露必要 IPC；外链交给系统浏览器。
- **凭据**：只在内存中使用，不写日志、只显示掩码。

---

## 移植与许可

| | |
|---|---|
| 原版 | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）——DSH 的 Web 插件 |
| ZCode 移植 | [nb10yyds/zcode-whale-widget](https://github.com/nb10yyds/zcode-whale-widget) → 本仓库 `main` |
| 本分支 | 自 `zcode-fox-widget` v1.11.1 移植到 WorkBuddy，版本号另起（`wb-v*`） |

视觉、鲸鱼素材、音效、台词与定价表来自上游；`GLM.png` / `gpt.png` / `kimi.png` / `gemini.png` 为自有素材；`xiaoke.png` 取自 [aklnaaw/dsh-xiaoke-widget](https://github.com/aklnaaw/dsh-xiaoke-widget)（MIT，**已获原作者授权**）。六张立绘统一规格：610×610 画布、内容高 587、右边与底边贴齐。逐条见 [`NOTICE`](./NOTICE)，许可见 [`LICENSE`](./LICENSE)。

## 文档地图

| 想找 | 去哪 |
|---|---|
| 安装 / 使用 / 排障 | 本文件 |
| 这版改了什么 | [CHANGELOG.md](./CHANGELOG.md)（ZCode 线历史：[归档](./docs/CHANGELOG-ARCHIVE.md)） |
| 维护者手册（架构、宿主契约、发布流程） | [docs/MAINTAINING.md](./docs/MAINTAINING.md) |
| 为什么这么写（按主题） | [docs/DECISIONS.md](./docs/DECISIONS.md) |
| 全部文档 | [docs/INDEX.md](./docs/INDEX.md) |
| 贡献规范 | [CONTRIBUTING.md](./CONTRIBUTING.md) |
