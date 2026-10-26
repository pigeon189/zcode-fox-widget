# ZCode狐娘小挂件（zcode-fox-widget）

<div align="center"><img src="assets/fox.png" width="420" alt="ZCode狐娘小挂件"></div>

> 常驻 ZCode 右下角的桌宠：显示 **DeepSeek 余额**、**GLM Plan 剩余配额**、**CommandCode 三重额度**、**各厂商今日已用**与**当前峰谷时段**，每轮对话结束弹气泡报告本轮花费。
>
> 浮层跟着 ZCode 窗口移动、最小化、关闭，指针不在它身上时点击直接穿透；开「桌宠模式」后以整个工作区为家，切应用也不隐身。ZCode 移到另一块显示器时，浮层会在窗口停稳约 0.7 秒后跟到那块屏（桌宠模式仍以启动时所在屏为家）。
>
> 同仓双分支：本分支 `main` 是 ZCode 线（按量余额口径），`workbuddy` 分支是 [WorkBuddy 线](https://github.com/pigeon189/zcode-fox-widget/tree/workbuddy)（订阅积分口径）。

---

## 快速开始

**前置**：ZCode 客户端；`node -v` 可用（`node:sqlite` 需 ≥ 22.5，缺了「每轮消耗/用量记录」会退化）；Windows（浮层依赖 Win32，macOS / Linux 只能用本地页面）。

1. **加市场源（二选一）**

   **A. GitHub 源（推荐）**：设置 → 插件管理 → **发现** → 右上角 `+` → 市场源填
   `pigeon189/zcode-fox-widget`。宿主认 `owner/repo`，拉的就是默认分支 `main`；升级 = 对市场点「重新抓取」。

   **B. 本地目录（要改代码时用）**：克隆后在同一入口点 `+`，把**仓库绝对路径**填进市场源（指向含 `marketplace.json` 的仓库根）。

   > 同时装 WorkBuddy 版时，两边各克隆一份——两个宿主盯同一个工作区，任一端重抓都会覆盖另一端。

2. **安装并启用** `zcode-fox-widget`（清单默认启用）。
3. **重启会话**（或重开 ZCode），让 MCP 与 hooks 生效。
4. **要桌面浮层再装运行时**（约 150MB 下载 / 370MB 占用，一次性）：

   ```bash
   node lib/cli.mjs desktop install
   ```

装好后打开 ZCode，鲸鱼会自己出现。

### 更新

- **市场刷新**：对 `zcode-fox-local` 点「重新抓取」→ 重装 → 重启客户端（宿主按版本号建新目录，最干净）。
- **挂件内更新**：菜单「检查更新…」→ 有新版时「立即更新」→ 完成后「重启挂件」。走镜像候选链，落盘前校验发布签名清单；也可以完全关掉（`WHALE_DISABLE_UPDATE_CHECK=1`）。
- **迁到 fox-dock 2.0（独立桌宠程序）**：fox-dock 2.0 正式版发布后，「检查更新…」面板会出现迁移入口——先点「查看说明后升级」在系统浏览器里看功能与升级代价，确认后按钮变「立即升级」，点击只做本机只读预检并给出安装引导（不代下载、不停服务、不动现有数据）。跳过迁移不影响普通更新；`node lib/cli.mjs migrate --check` 可随时只读预检；`FOX_WIDGET_DISABLE_MIGRATION=1` 可整体关闭迁移入口。

数据（key、账本、角色、泡泡、Electron 运行时）都在 `~/.zcode/whale/`，两种方式都不丢配置。完整性与发布流程见 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 的「发布物完整性」。

---

## 功能

- **余额与今日已用**：DeepSeek 余额（需自带 key）、本机库口径的今日已用、当前峰谷时段；另有记账/实时令牌两种对账口径兜底。
- **GLM Plan 配额**：客户端日志与直连套餐接口双源，显示窗口剩余额度与重置时间。
- **CommandCode 三重额度**：月度池 + 5 小时 / 周窗口，支持本地账号池。
- **厂商卡**：46 个模板（含 Kimi / MiniMax / Gemini 订阅窗口，以及 21 家无余额接口、只报凭据状态的厂商）。
- **每轮消耗**：气泡报金额或配额百分比，`cli.mjs turn` 可逐档核对 token 分桶。
- **记账二级页**：用量记录（今日 / 近 7 天 / 逐轮，支持按模型名或日期搜索）、额度预警、余额预警、今日预算、余额校正；余额卡同时显示赠金 / 充值构成。
- **角色**：六套内置（嘎啦嘛 / 大肥鱼 / GPT娘 / kimi娘 / 小克 / 哈基米），按模型自动换角色、配色自定义、可导入自己的图。
- **桌宠模式**：整屏工作区漫游，锁在最上层，失焦不隐身。

---

## 使用

### 挂件菜单

悬停鲸鱼 → 右上角三点按钮：

| 分组 | 内容 |
|---|---|
| 外观 | 大小 0.6–2.5×（只缩放角色与气泡，菜单尺寸恒定）；主题：浅色 / 深色 / 跟随 ZCode |
| 声音 | 音效组与音量，可导入自定义音效；音量 0 即静音 |
| 角色 | 选内置形象或导入图片（可改名 / 删除，内置形象也能隐藏）；「按模型换角色」默认开，手选后自动关 |
| 显示与口径 | 对账口径（记账 / 实时·令牌）、峰谷播报风格、气泡主显示跟随哪个计费源 |
| 气泡 | 思考气泡开关、按压泡泡编辑器（含每轮消耗文案）、等确认提醒 |
| 位置与行为 | 「位置与行为…」二级页：默认位置（右下 / 左下 / 右上 / 左上）、避让滚动条、隐藏菜单按钮、每轮消耗提示与自动关闭秒数 |
| 浮层 | 桌宠模式、跟随延迟（16 / 40 / 100 / 250ms） |
| 更新与关闭 | 「检查更新…」面板（含「重启挂件」「关闭插件」）；关闭只停当前这一份，下次会话照常拉起 |

### 命令行

```bash
node lib/cli.mjs status           # 余额 + 今日已用 + 服务与浮层状态
node lib/cli.mjs turn             # 上一轮消耗与逐档明细
node lib/cli.mjs start / stop     # 启停挂件服务（页面与浮层共用）
node lib/cli.mjs window start|stop|status|restart
node lib/cli.mjs desktop install  # 安装 Electron 运行时（仅浮层需要）
node lib/cli.mjs restart-all      # 服务 + 浮层一起重启
node lib/cli.mjs close            # 本次关闭（不写自启开关）
echo 'sk-...' | node lib/cli.mjs key   # 写 Key（走 stdin，不留命令行痕迹）
node lib/cli.mjs mode ledger|token     # 对账口径
node lib/cli.mjs json             # 结构化输出
```

自动启动：插件带 SessionStart hook，每次会话启动幂等拉起；同时默认在 Windows 启动文件夹放一个隐藏的看门进程，**ZCode.exe 一出现就拉起挂件，不用先选会话**。排查看 `~/.zcode/whale/autostart.log` 与 `~/.zcode/whale/zcode-watch.log`。

```bash
node lib/cli.mjs watch status      # 看门进程与 Startup 项状态
node lib/cli.mjs watch install     # 立即安装并启动（SessionStart 也会自动确保）
node lib/cli.mjs watch uninstall   # 卸载 Startup 项并停掉看门进程
node lib/cli.mjs watch once        # 只探测一次并拉起（排障）
```

### 在对话里用

输入 `/fox`（或 `/fox turn`、`/fox window start`），或直接问「我还有多少余额」——ZCode 会调 MCP：

| 工具 | 作用 |
|---|---|
| `whale_balance` | 余额、今日已用、峰谷时段 |
| `whale_last_turn` | 上一轮消耗与明细 |
| `whale_widget` | 服务与浮层的启停 / 状态 |
| `whale_config` | 查看或修改配置（Key、口径、端口、自启、跟随间隔） |

### 浮层交互

- 角色可拖到窗口内任意位置，靠边吸附，贴左缘时整体镜像。
- **指针要先落在角色上，点击才被浮层接管**——穿透设计的必然代价，换来不误触。
- 普通交互不抢 ZCode 前台；菜单里的输入控件按上去才临时接管键盘，离开即交还。

---

## 首次配置

**API Key 只服务于 DeepSeek 余额卡；不配也能用**（余额卡显示「未找到 Key」是正常状态）。

查找顺序：环境变量 `DEEPSEEK_API_KEY` → `~/.zcode/whale/config.json` 的 `apiKey` / `vendorKeys.<模板 id>` → ZCode provider 配置。

```bash
echo 'sk-xxxxxxxx' | node lib/cli.mjs key
```

`~/.zcode/whale/config.json` 常用字段：

| 字段 | 默认 | 作用 |
|---|---|---|
| `autoStartWidget` | `true` | 会话启动时拉起服务 |
| `autoStartOverlay` | `true` | 顺便拉起浮层 |
| `autoStartWithZcode` | `true` | 登录后看门进程随 ZCode 启动拉起（不等 SessionStart） |
| `followIntervalMs` | `40` | 跟随探测间隔（菜单选择会覆盖） |
| `port` | 自动（39322） | 固定端口，占用时顺延 |

**火山方舟 Coding Plan 配额卡（可选）**：菜单「显示」选「火山 Coding Plan」或厂商列表里的 `volc-plan` 模板。凭据必须用火山 **IAM Access Key（`AKLT…`）** 做 V4 签名——模型调用用的 Coding Plan Key（`ark-…`）不适用。IAM AK/SK 在火山控制台 → 右上角头像 → 访问控制 → 新建用户（通过用户名创建，访问方式选**编程访问**），授权时搜索并勾选系统策略 `ArkReadOnlyAccess` + `BillingCenterReadOnlyAccess`，创建后生成 AK/SK；它与 `ark-` key 是两套体系，互不通用（追求最小授权也可只授自定义策略 `ark:GetCodingPlanUsage`）。接口只给 5 小时/周/月三个窗口的已用百分比，没有调用次数也没有金额；未订阅/无数据会如实显示，不会补 0%。凭据两个来源（现读、不落盘日志）：环境变量（支持 `VOLC_ACCESS_KEY_ID` / `VOLC_ACCESS_KEY_SECRET` 及 `VOLC_ARK_*`、`VOLC_ACCESS_KEY` / `VOLC_SECRET_KEY`、`ARK_ACCESS_KEY_*` 别名，与 dsh-volcark-quota 对齐），或 `config.json`：

```json
{ "vendorKeys": { "volc-access-key-id": "AKLT…", "volc-access-key-secret": "…" } }
```

（AK/SK 是成对的两个键，不走其它厂商 `vendorKeys.<模板 id>` 的单键模式；未配置时火山卡会显示「未配置火山 IAM 凭据（AK/SK）」提示。）

**自动识别接入类型**：先按当前模型的 providerId 查找有效 Base URL，再根据官方域名与完整路径区分 API、Coding Plan 和 Agent Plan。providerId 可以是 UUID，不要求包含厂商名称。

官方直连域名为 `ark.cn-beijing.volces.com`，使用 HTTPS、默认端口，无查询参数或片段：

| Base URL 路径（兼容末尾 `/`） | 统计与显示 |
| --- | --- |
| `/api/v3` | 火山 API 本地按量估算 |
| `/api/coding`、`/api/coding/v3` | Coding Plan 订阅配额 |
| `/api/plan`、`/api/plan/v3` | Agent Plan 订阅配额 |

菜单「显示」统一提供 **火山方舟**：按当前火山接入选择金额或对应套餐卡；切到其它厂商时保留最近的火山接入，重开页面仍保留该接入 ID。尚未识别过火山接入时提示先在 ZCode 选择；已删除的接入也会提示重新选择。API 金额为所有火山按量记录的今日合计，不是单个 provider 的金额。自动跟随模式继续跟随当前厂商。

显示选择不修改计费分类。配额查询失败也不改变分类；Coding 与 Agent 各自查询、缓存，不跨套餐回退。API 估算无需 IAM 凭据，个人版配额查询仍需 IAM AK/SK。请确认配置的 IAM 凭据与模型接入属于同一账号；插件不自动验证账号绑定。企业版席位配额暂不支持。

旧的 `volcBillingByProvider` 声明不再参与判断，可从配置中移除；旧的 `displayMode: "volc"` 自动沿用为「火山方舟」。未知火山路径不自动判为订阅，统计保留估算，固定视图提示路径未识别；自定义代理不通过名称或 key 形态猜套餐。缺模型价目时沿用 tokens 兜底，不虚构金额。

分类按当前 provider 配置解释本机历史记录；改变同一个 provider 的 Base URL 可能重新归类其历史用量，建议按量与订阅使用不同 provider。金额是本地估算，不是官方账单。

排查时可运行 `node lib/cli.mjs providers` 查看接入 ID 与来源（不输出密钥）；或请求 `/whale/volc.json?providerId=<经过 URL 编码的 ID>&refresh=1` 查看该接入的模式和查询结果。

本机时间偏差超过 15 分钟会返回 `InvalidTimestamp`（界面提示「时间偏差过大」），校准时钟即可。

---

## 数据与计价口径

- **今日已用 = 本机库（主口径）**：读 ZCode 落库的每轮用量，按各厂商价目折算；按模型可见、不受充值干扰。
- **预付池不计真金白银**：GLM Plan 与 CommandCode credit 的钱在买额度时就付了，只按配额 / tokens 报，不并进「今日已用」。
- **对账口径兜底**：记账（观测余额下降）覆盖该账号全部花费但会漏记停机期间；实时·令牌需要 `DEEPSEEK_PLATFORM_TOKEN`，过期自动回落。两口径不一致时并排展示。
- **每轮消耗**：按缓存命中 / 未命中 / 缓存写入 / 输出分档计价，DeepSeek 再按峰谷取价；输入 token **含缓存**，折价前必须减掉（否则虚高十几倍）。
- **等价金额（`≈`）不代表真实扣费**，只用于横向比较。

`node lib/cli.mjs turn` 可逐档核对；价目在 `lib/pricing.mjs` 顶部，核对流程见 `skills/zcode-fox-widget/`。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 界面上看不到挂件 | ZCode 没有界面注入点，必须走桌面浮层：`desktop install` 后 `window start` |
| 打开 ZCode 没自动出现 | 看 `~/.zcode/whale/autostart.log` 最后一行：无新行 = hook 没加载；`skip: autoStartWidget=false` = 配置关了自启；`overlay=skipped:no-runtime` = 运行时没装 |
| 打开 ZCode 停在首页、挂件要等选会话才出现 | 看门进程没在跑：`node lib/cli.mjs watch status`；`watch install` 后重开 ZCode，日志在 `~/.zcode/whale/zcode-watch.log` |
| 点桌面 / 任务栏后挂件消失 | 普通模式在 ZCode 失焦时按设计隐身；菜单开「桌宠模式」后会一直悬浮（实测可压在浏览器/桌面上）。开了桌宠模式仍消失，再发版本号与 `overlay-debug.log` |
| 要反馈问题 | 菜单 →「关于 / 自检…」→「全选复制」，把那段 JSON 一起发出来（不含密钥，路径已脱敏） |
| 和挂件互动后 ZCode 画面卡住 | 确认浮层是新版（`window status` / `/whale/health` 的 version）。浮层的 `focusable:false` 与 `type:'toolbar'` 都不能删，否则会抢宿主前台或触发停帧 |
| 余额显示「未找到 DeepSeek API Key」 | 预期：三条来源都没命中。逐条看 `/whale/health` 的 `keyProbe` |
| 今日已用一直是 0 | 本机库今天还没记录；`cli.mjs status` 看双口径与来源 |
| 每轮消耗不弹 | 需要至少完成一轮对话（`turn_usage` 有 `completed`），且菜单里开关是开的 |
| 鲸鱼不跟着 ZCode 走 | `window stop` → `window start` 重建；`WHALE_DEBUG_PORT` 启动可看 `overlay-debug.log` |
| 浮层里点不动 | 指针要先落在角色上（光标变 `grab`）；整块都点不动时检查是否有别的置顶窗口压着 |
| 菜单数字框打不了字 | 指针按上去就会临时接管键盘；仍不行说明浮层是旧版 |
| Plan 配额不显示 | 日志与接口都没数据；`/whale/plan.json` 的 `apiReason` / `probedDirs` 说明原因 |
| CommandCode 读不到 | 只支持本机反代：`~/.cmdgo-bridge/credentials.json` 不存在或反代没跑 |
| 换了图片 / 音效不生效 | 资产路由 `no-store`，强刷即可；确认替换的是 `assets/` 下的同名文件 |

---

## 已知限制

- 浮层仅 **Windows**（依赖 Win32 与 PowerShell）；macOS / Linux 只有本地页面。
- 跟随靠轮询，拖动时理论上有约一个探测间隔的滞后（默认 40ms，实测约 13ms）。
- 浮层内吸附无滑动动画（避免透明窗口合成层错位）；本地页面里动画完整。
- 穿透的代价：点击前指针得先落在角色上。
- 每轮消耗只统计 ZCode 记录的轮次，宿主外直接调用的 API 不计入。

---

## 安全

- **出站白名单**：业务请求只发往 `api.deepseek.com` / `platform.deepseek.com`；更新链路是另一份白名单（GitHub 与转发镜像）。两者都拒绝环回 / 私有地址。
- **本地服务**：只监听 `127.0.0.1`，校验 `Host` 与写操作 `Origin`；停止服务要 `server.json` 里的随机令牌。
- **更新**：下载整包在内存中解压、逐条校验路径，并核对发布签名清单（`.release-hashes.json` + ed25519）；清单外文件忽略不落盘。
- **浮层**：只加载本机页面，`contextIsolation` 下仅暴露必要 IPC；外链交给系统浏览器。
- **凭据**：只在内存中使用，不写日志、只显示掩码。

---

## 移植与许可

| | |
|---|---|
| 原版 | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT）——DSH 的 Web 插件 |
| ZCode 移植 | [nb10yyds/zcode-whale-widget](https://github.com/nb10yyds/zcode-whale-widget)——宿主适配层重写 |
| 本仓库 | fork 自上址（v1.1.0 起延续开发，v1.8.5 起用现名） |

视觉、鲸鱼素材、音效、台词与定价表来自上游；`GLM.png` / `gpt.png` / `kimi.png` / `gemini.png` 为自有素材，`xiaoke.png` 取自 [aklnaaw/dsh-xiaoke-widget](https://github.com/aklnaaw/dsh-xiaoke-widget)（MIT，已获授权）。逐条清单见 [`NOTICE`](./NOTICE)，许可见 [`LICENSE`](./LICENSE)。

## 文档地图

| 想找 | 去哪 |
|---|---|
| 安装 / 使用 / 排障 | 本文件 |
| 这版改了什么 | [CHANGELOG.md](./CHANGELOG.md) |
| 发布流程与发布物完整性 | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| 给 ZCode 内助手读的使用说明 | [skills/zcode-fox-widget/SKILL.md](./skills/zcode-fox-widget/SKILL.md) |
| 贡献规范 | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| 一次性调查 / 交接档案 | [docs/INDEX.md](./docs/INDEX.md) |

