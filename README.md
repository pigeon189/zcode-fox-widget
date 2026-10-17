# WorkBuddy狐娘小挂件（fox-widget）

<div align="center"><img src="assets/wb.png" width="420" alt="WorkBuddy狐娘小挂件"></div>

> 产品名 **WorkBuddy狐娘小挂件**（英文名 Fox Widget）。在 WorkBuddy 里常驻一位嘎啦嘛（可一键切回原版大肥鱼，或上传任意形象）：
>
> - **今日积分**（主口径）——WorkBuddy 是订阅积分制，模型由宿主托管，每轮对话消耗多少 credit 由宿主算好
> - **当前会话上下文余量**（`已用 x / 总量`，如「上下文 22%」）
> - **上一轮消耗**——每轮对话结束弹一个气泡告诉你这一轮花了多少积分、多少次模型调用、以及一个按公开价目折算的**等价金额参考值**
> - 可选：**DeepSeek 余额**与 35 家厂商模板（需自己配 key；WorkBuddy 默认不需要）
>
> 它浮在 WorkBuddy 窗口的右下角，跟着窗口移动/最小化/关闭，指针不在它身上时点击直接穿透到下面的应用——**不挡任何操作**；开「桌宠模式」后以整个屏幕工作区为家，切应用也不隐身，一直浮在最上层。

> **本仓库是 `workbuddy` 分支**，与 `main` 分支（ZCode 版）同源双分支。共享内核（页面、本地服务、定价、厂商模板、记账、浮层、测试框架）约占全仓七成；宿主差异集中在 `lib/host.mjs` 一个文件里。
> 分支策略、发版口径与同步纪律见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)；移植的实测结论与决策记录见 [`docs/porting/`](./docs/porting/) 与 [`HANDOFF-WORKBUDDY-PORT.md`](./HANDOFF-WORKBUDDY-PORT.md)。

---

## 移植关系与协议

**本项目不是原创，是「移植的移植」。** 视觉与交互设计、鲸鱼素材、音效、台词、峰谷定价表和计费口径来自上游项目：

| | |
|---|---|
| **原版** | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（MIT，Copyright (c) 2026 MeteorNOX）——DSH（DeepSeek Harness）的 Web 插件 |
| **ZCode 移植** | [nb10yyds/zcode-whale-widget](https://github.com/nb10yyds/zcode-whale-widget) → 本仓库 `main` 分支的 `zcode-fox-widget`（ZCode狐娘小挂件） |
| **本分支** | 自 `zcode-fox-widget` v1.11.1 移植到 WorkBuddy，版本号另起序列（tag 前缀 `wb-v`） |

**沿用自上游**：`assets/` 下上游素材（鲸鱼形象、`rua.gif`、两套音效）、气泡 SVG 几何、字号档、动画参数、拖拽/四分吸附/左吸附镜像/alpha 命中检测、随机台词六组的文案与权重、峰谷定价表与时段规则、记账模式语义、余额接口取项规则。

**新增素材（非上游）**：`GLM.png`（嘎啦嘛）、`gpt.png`（GPT娘）、`kimi.png`（kimi娘）、`gemini.png`（哈基米）、README 头图 `wb.png`（WorkBuddy 版形象） —— 均为项目自有素材；`xiaoke.png`（小克）取自 [aklnaaw/dsh-xiaoke-widget](https://github.com/aklnaaw/dsh-xiaoke-widget)（MIT），**已获原作者授权**。六张内置立绘统一到同一画布规格：**610×610 画布、内容高 587、内容右边与底边都贴到画布边**（右下对齐是刚需——挂件贴屏幕右缘，右对齐才能做到切换角色时角色不横向跳），视觉上六个角色的身高与离右边框的距离一致。

**ZCode 版移植期重写**：本地服务 + 独立页面 + 桌面浮层的呈现层；三级凭据发现链；每轮消耗改读 ZCode 落库的 `turn_usage`；MCP 服务、SessionStart 自启 hook、skill、`/fox` 命令与 CLI；出站白名单与本地服务加固。

**本分支（WorkBuddy）在此基础上重写**：插件清单/钩子/市场声明（`.codebuddy-plugin/` + `.mcp.json` + `command` 型钩子）；**数据源整体换掉**——每轮消耗与今日合计改读宿主 `workbuddy.db` 的 `session_usage` 与会话 transcript 的 `rawUsage`（积分由宿主算好），顺手做出了「上下文余量」；主题跟随改读宿主 `preferences.json`；凭据发现改扫宿主 `settings.json`；浮层跟随目标换 `WorkBuddy` 并去掉「宿主启动就绪」门控；自更新默认关闭。宿主差异全部收敛到 `lib/host.mjs`。

逐条清单见 [`NOTICE`](./NOTICE)；MIT 许可全文见 [`LICENSE`](./LICENSE)。fork 之后新增了什么，见下一节与 [CHANGELOG](./CHANGELOG.md)。

---

## 功能总览（基础功能）

- **今日积分（主口径）**：读宿主 `workbuddy.db` 的会话用量与会话 transcript 里每次模型调用带的
  `credit`（**宿主算好的积分**），按日聚合。这是 WorkBuddy 版的头号数字。
- **上下文余量**：读宿主会话的 `used / size`，显示「上下文 xx%」——ZCode 版没有的能力。
- **每轮对话消耗**：一轮对话结束弹一个红色气泡，显示这一轮消耗多少**积分**（多少次模型调用）、
  外加一个按公开价目折算的**等价金额参考值**（界面标 `≈`），可逐档核对 token 分桶明细。
- **可选：余额与额度**：DeepSeek 走内置余额接口（需自己配 key）；**CommandCode 三重额度**保留在厂商卡层；
  另有 **35 个厂商模板**（含 Kimi Coding / MiniMax Coding / OpenCode Go 等订阅窗口与 **Gemini 订阅（AI Pro/Ultra）**，以及 OpenAI / Anthropic /
  Gemini / 硅基流动 / 火山方舟 等「官方没有 API key 查余额」的厂商——这类只报凭据状态）。
  **WorkBuddy 默认没有用户自带凭据，所以这些卡默认全部「未配置」——这是预期，不是故障**。
  **GLM Plan 配额在本分支已砍**（唯一数据源是 ZCode 客户端日志，宿主无对应物）。
- **记账二级页**：一级菜单有「**用量记录…**」（今日 / 近 7 天 / 逐轮明细，积分口径）与「**=角色名记账=**」入口；额度预警、余额预警、余额校正收进记账页。
- **预警**：一条「额度%」阈值对 GLM Plan 与 CommandCode 同时生效，加一条「余额¥」管 DeepSeek 余额见底；每源每天最多提醒一次，恢复后自动重新武装。
- **桌宠模式**（浮层专属）：开启后挂件以**整个屏幕（工作区，自动排除任务栏）**为界面，可拖出 WorkBuddy 窗口放到屏幕任何角落，且锁在所有窗口最上层——切到别的应用、WorkBuddy 被盖住或最小化也不隐身；关闭后回到「跟随 WorkBuddy 窗口」的原有行为。
- **挂件交互**：拖拽、四边四分之一吸附、左吸附水平镜像（文字保持可读）、按压 Q 弹 + 音效、余额变化数字滚动、点击角色弹气泡、再点切随机台词（含 rua 动图；台词按内置角色分套——大肥鱼 = 原版文案也是默认套，嘎啦嘛 / GPT娘 / kimi娘 / 小克 各有一套专属台词，用户导入的角色用鲸鱼套；切角色当场换台词，不用刷新页面）。
- **汉堡菜单**：大小 0.6–2.5×、音效、音量、角色、对账口径、峰谷播报、主题（跟随 WorkBuddy / 浅色 / 深色）、显示、气泡开关、按压泡泡、每轮消耗提示与自动关闭秒数、避让滚动条，浮层下还有「桌宠模式」与「跟随延迟」。
- **会话自启**：打开 WorkBuddy（新会话）时自动拉起，不用手动开。
- **随窗口联动**：WorkBuddy 移动/缩放时跟着走，最小化或被别的应用盖住时隐藏（除非开了桌宠模式），WorkBuddy 退出时一起退出。

---

## 相对原项目的新增与优化

以上是「一只挂件」的基础能力；下面是 fork 之后（v1.1.0 – v1.8.5）在移植版基础上重点建设的部分，逐版本的完整说明见 [CHANGELOG](./CHANGELOG.md)。

### 计费与额度体系

- **多厂商计价内核**（v1.1.0/v1.2.0）：从上游仅 DeepSeek 峰谷扩展为八家价目（DeepSeek/GLM/OpenAI/Claude/Qwen/MiniMax/MiMo/Kimi，含 272K 整单取档等各家官方口径；Gemini 全家桶价目于后续版本补齐，现为九家），并立下「未知模型只计 tokens、不套别家价」的红线；后续持续补齐 GPT-6 系列、GPT-5.6-cyber 与 Kimi 全系条目（v1.7.6/v1.7.7）。
- **GLM Plan 套餐配额**（v1.1.0 引入，零密钥）：尾随客户端日志读套餐剩余，配套一整套鲁棒性修复——空桶快照跳过（v1.7.8）、日志尾窗逐级扩读与死套餐残值过滤（v1.4.2）、stale 观测标注（v1.4.1）。
- **CommandCode 三重额度 + 多账号池**（v1.7.8–v1.7.10，v1.8.3/v1.8.4 打磨）：月度 credit 池 + 5 小时/周滚动窗口，直读网关 API；反代凭据现读不落盘、兼容两种凭据形状；多账号「最近使用优先、全撞墙时最早解锁兜底」；额度气泡卡（三窗口条 + 绑定约束窗口倒计时 + 账号池健康度）；对网关 `limited` 粘滞标志的正确解读（需佐证才采信，升级套餐后健康账号不再被误判限流）。
- **今日已用口径重排**（v1.7.0）：主口径改本机库，充值当天不再归零；记账/实时·令牌退居「对账 + 兜底」；用量记录的模型排名给订阅套餐行按等价市值参与排序（v1.7.5，`≈¥` 标注、不虚报真金白银）。
- **预警体系演进**（v1.3.0 → v1.7.7 → v1.8.0）：余额预警合并 → 取消消费型预警（语义回归「见底」）→ 泛化为「额度% + 余额¥」每源一条，旧配置键自动迁移。
- **35 个厂商模板**（v1.1.0 首批 7 家 → v1.8.0 对齐上游 34 家 → 后续补 Gemini 订阅条目）：订阅窗口类 + 20 家无余额接口厂商只报凭据状态；模板必须显式声明 `host`，白名单 fail-closed。
- **价目复核纪律**（v1.4.3 起）：`fox-pricing-review` 技能把「官方页核对 + LiteLLM 交叉验证 → 改表 → 改钉死断言 → 发版」固化为手动流程，本项目没有自动价目更新。

### 桌宠与窗口行为

- **桌宠模式**（v1.8.0 引入 → v1.8.1 重定义 → v1.8.2 贴顶）：视口 = 整个工作区、失焦不隐身、丢了置顶才重申；纵向钳制按命中画布**实测的角色不透明内容**计算，角色能真正拖到屏幕顶（气泡自动避让）。
- **冻结防线**（v1.3.3 → v1.8.1，v1.8.6 精简）：禁用原生遮挡计算、首帧上屏、60 秒出帧保险、DPI 变更自动重建、显隐走透明度切换、视口钳到窗口交集——这套**被动防线**保留；主动的「活性点 + DXGI 桌面像素对账」检测（v1.4.2–v1.8.5）于 v1.8.6 移除：窗口拖动时采样链路时序错位会误报冻结（可见的闪烁）、检测点本身在拖动中滞后可见，而它能覆盖的场景被动防线已兜住（真冻结最迟 60 秒自愈，或 `node lib/cli.mjs window restart` 一键重建）。
- **跟随引擎**（v1.3.1 → v1.5.3 → v1.8.1）：探测循环编译成 C#（40ms 档端到端 13ms、稳态 CPU ≈0.16% 单核），16/40/100/250ms 挡位实测表（曾有的 5ms 档已移除——实际周期受系统定时器量子约束只能到 ≈11ms，名不副实）；跟随目标选目标进程**面积最大的可见窗口**（绕开 MainWindowHandle 陷阱）；pid 身份门控，重开 WorkBuddy 不再在加载动画里冒头。
- **点击无响应根除**（v1.3.2/v1.4.3）：隐藏→重现改透明度切换，不再拆原生输入管线；输入复活改纯样式翻转。
- **不可激活窗口**（v1.3.0）：与挂件互动不抢 ZCode 前台（`WS_EX_NOACTIVATE`）；指针按到输入类控件才临时接管键盘焦点，离开即交还。
- **渲染节流三重防线**（v1.8.2）：三个 Chromium 后台化开关 + 页面侧帧调度逃生门（300ms 排不上一帧就整体关过渡）——二级面板在任何遮挡/节流环境下必然可见。

### 交互与个性化

- **按压泡泡**（v1.5.0–v1.5.3）：移植 DSH 自定义泡泡——点击队列 + 可选模块（文本占位符 / 随机语句 / 内置视图）+ 实时预览的两窗编辑器；点文本框冻结 ZCode、任务栏幽灵按钮两个深水 bug 根治。
- **内置形象库**（v1.2.0 起默认嘎啦嘛；v1.7.4 台词分套；v1.8.2 台词修订）：内置 **嘎啦嘛 / 大肥鱼 / GPT娘 / kimi娘 / 小克 / 哈基米** 六个形象，台词按角色分套（嘎啦嘛 / GPT娘 / kimi娘 / 小克 / 哈基米 各有一套专属台词，大肥鱼那套是默认套、用户导入的角色也用它）；角色可导入、改名、删除，内置形象可隐藏找回（v1.3.0/v1.6.0）。
- **音效库**（v1.6.0）：导入 1–2 个自定义音效（按压/松手）、逐行删除、回落内置。
- **隐藏菜单按钮**（移植自 DSH）：菜单里可开「隐藏菜单按钮」——开启后挂件上的菜单按钮不再出现（悬停也不显形），改用**右键点击角色**唤出菜单，菜单位置与点按钮时完全一致（按钮仍在布局里作锚点）；关闭即恢复。设置随 `widget-state` 持久化。
- **主题**（v1.2.0/v1.6.0/v1.7.2）：深色沿用 ZCode 版的实测 token；「跟随 WorkBuddy」三层判定（DWM 暗色标志观测 > 配置 > 系统），WorkBuddy 里换主题 10 秒内跟变。**角色专属配色**：气泡的描边与文字按角色换色（浅/深两档）；**浅色模式下一整套界面**——设置按钮与菜单、二级页面（按压泡泡设置 / 记账 / 用量记录，含次级文字）、文本框、下拉列表、复选框、拖动条——都跟随该角色的浅色档色值（深色档不跟，保持主题中性）。
- **气泡体验**：额度卡与台词互斥收口（v1.7.11/v1.8.0）、逐行缩字自适应（v1.4.0）、峰谷/重置芯片（v1.5.2）、99.5% 一位小数与「已限流」准确表达（v1.8.3）。

### 平台集成与工程质量

- **UI/UX 专项**（v1.7.3 + v1.8.0）：15 项 + 22 项审查清零——失败态状态机、遮挡叠层、格式与圆角/动效 token 化、对比度达标、焦点环、`prefers-reduced-motion`。
- **接口诚实化**（v1.3.1）：CLI/MCP 金额按真实币种输出；MCP 版本号单一来源；发现缓存 TTL。
- **可观测性**：浮层黑匣子日志常开（v1.4.3，超 5MB 轮转）、`/whale/health` 带凭据探测明细。
- **质量面**：`tools/selftest.mjs` 端到端自检（计价口径/账本/账号池/降级路径）、`tools/smoke-ui.mjs` CDP 真机回归（headless 浏览器驱动真实页面）；Conventional Commits 与版本发布纪律成文（[CONTRIBUTING](./CONTRIBUTING.md)）。
- **安全**：出站主机白名单与地址校验、厂商模板显式 `host` 声明、本地服务 Host/Origin 校验与关闭令牌、本地威胁模型显式化（v1.7.1）、子进程 `shell:false` 加固。

---

## 显示方式：桌面浮层（推荐）

一个独立的 Electron 窗口：透明、无边框、不进任务栏、始终置顶，**覆盖 WorkBuddy 窗口范围但默认鼠标穿透**——只有指针压到鲸鱼、气泡或菜单上时才接管鼠标，其余位置的点击照常落到下面的 WorkBuddy。装好运行时后打开 WorkBuddy 就会自己出现，**不用浏览器、不用手动开任何东西**。

长这样：

![挂件气泡与角色](assets/example.png)

### 本地页面地址（备用 / 排障入口）

浮层加载的本来就是一个网页——同一个服务把同一个页面也挂在 `http://127.0.0.1:<port>/`，浏览器打开它看到的是**同一只鲸鱼、同一份 `lib/widget.js`、同一份配置**，不是第二套实现。平时不用关心它：服务随会话自启，浮层的显示与交互走的就是这个地址。

会用到它的只有两种情况：

- **排障**：浮层里输入框打不了字、或浮层行为可疑时，用浏览器打开这个地址直接操作，快速区分「页面逻辑的问题」还是「浮层窗口层的问题」（排查表见 skill 的「故障排查」一节）。
- **非 Windows**：浮层依赖 Win32 窗口 API，macOS / Linux 上只有这个页面形态可用。

`<port>` 默认 39321（被占用会顺延），以 `node lib/cli.mjs start` 的输出或 `${CODEBUDDY_PLUGIN_DATA}/server.json` 里的 `url` 为准；服务只监听 `127.0.0.1`，本机之外访问不到。

---

## 安装

### 前置条件

- WorkBuddy 客户端（插件系统）
- Node.js（用于运行插件自带的脚本）——WorkBuddy 自带 v22.22.2，命令行里 `node -v` 能跑即可
- Windows（桌面浮层依赖 Win32 窗口 API；macOS / Linux 只能用本地页面）

### 步骤

1. **选安装来源（二选一）**：

   **A. 直接填 GitHub 源（推荐，最省事）**

   左栏 **「专家·技能·连接器」** → **「技能」** → 子分页 **「插件」** → 右上角 `＋` →
   在「市场源」里填 workbuddy 分支的 ZIP 地址：

   ```text
   https://github.com/pigeon189/zcode-fox-widget/archive/refs/heads/workbuddy.zip
   ```

   WorkBuddy 的「添加市场」会把 `http` 开头的源按 ZIP 下载；它**不认 `owner/repo#分支`**，
   直接填 `pigeon189/zcode-fox-widget` 会拉默认分支 `main`（ZCode 线，没有 `.codebuddy-plugin/`），
   市场里不会出现 `fox-widget`。装完后升级 = 在市场里点「刷新」。

   **B. 克隆到本地目录**（想改代码、或想跟某个本地工作副本同步时用）

   1. **把仓库克隆到一个固定位置**（不要放在会被清理的临时目录；本分支是 `workbuddy` 分支）：

      ```bash
      git clone -b workbuddy https://github.com/pigeon189/zcode-fox-widget.git ~/.workbuddy/dev/fox-widget
      ```

      后面的命令都假设你在仓库根目录下执行。

      > **别把这份仓库直接注册成 WorkBuddy 的市场，同时又让 ZCode 盯着它**——两个宿主同时盯一个工作区，任一端「重新抓取」都会覆盖另一端的认知。本机同时装两端时，用上面这种**单独克隆一份**的开发副本。

   2. **注册为本地插件市场**，二选一：

      **客户端界面（推荐）**

      1. 左栏点 **「专家·技能·连接器」** → 选 **「技能」** 分栏。
      2. 进「技能」页后，再选它的**子分页「插件」**。
         该页的子分页是：推荐 / 技能库 / **插件** / 结绳 / 企业（对应宿主路由 `/plugins`、组件 `PluginsPage`）。
      3. 点页头右上角的圆形 **`＋`**（悬浮提示「添加市场」）。
         ⚠️ **它不是一个文件夹选择框**：弹出的「添加市场」对话框里只有一个**「市场源」文本框**。
      4. 在「市场源」里粘贴**仓库的绝对路径**（就是你克隆出来的那份目录，例如
         `D:\code\fox-widget`），然后点「提交」。
      5. 市场 `fox-local` 出现后，在它下面安装 `fox-widget`（会让你选安装范围，选 **user** 即可）。

      > 别走「技能」页的「**导入技能**」——那条路只接受 `.skill` 技能包，
      > 选插件仓库目录会报「没有 .skill」。插件必须走「插件」分页的「添加市场」。

      > **这一步最容易踩坑**，记一下宿主的判定逻辑（`pluginManager.parseSource()`）：
      > 它先把输入按工作目录解析成路径，**路径真实存在**就当成「本地目录市场」；
      > 路径不存在才依次试 GitHub 简写 `owner/repo`、`git@…`（SSH）、URL、ZIP。
      > 所以**填市场名、插件名或目录名都不会生效，必须填一个真实存在的路径**，且路径要指向
      > 含 `.codebuddy-plugin/marketplace.json` 的目录（= 本仓库根目录）。
      > 宿主自带的输入提示原文：`owner/repo（GitHub）、git@…（SSH）、https://….zip（ZIP）、./path/to/marketplace（本地）`。

      **手工写配置**（宿主在运行时可能把这两个文件写回，导致手改被覆盖，仅作备用）
      先完全退出 WorkBuddy，再在 `~/.workbuddy/plugins/known_marketplaces.json` 里追加一条（key 就是市场名）：

      ```json
      {
        "fox-local": {
          "manifestName": "fox-local",
          "type": "directory",
          "source": { "source": "directory", "path": "<仓库绝对路径>" },
          "installLocation": "<仓库绝对路径>",
          "description": "Local marketplace for WorkBuddy狐娘小挂件 (fox-widget).",
          "autoUpdate": false
        }
      }
      ```

2. **安装并启用插件**：在刚添加的市场下安装 `fox-widget`（会问安装范围，选 **user**）。
   手工方式则先退出 WorkBuddy，再在 `~/.workbuddy/settings.json` 的顶层加：

   ```json
   {
     "enabledPlugins": {
       "fox-widget@fox-local": true
     }
   }
   ```

   （插件清单里已写 `defaultEnabled: true`，正常情况下装完即启用。）

4. **重启会话**（或重开 WorkBuddy），让 MCP 服务与钩子生效。

5. **想用桌面浮层的话，再装一次它的运行时**（下载约 150MB，一次性；只装到插件数据目录，不进仓库，解压后占用约 370MB）：

   ```bash
   node lib/cli.mjs desktop install
   ```

装好后打开 WorkBuddy，鲸鱼会自己出现。

### 更新

> **本分支默认关闭「挂件内自更新」**，与 ZCode 版不同。原因是它会和宿主的插件管理打架：
> ZCode 版的自更新把新文件**原地覆盖**到每个安装目录（包括客户端的 cache 快照），
> 而 WorkBuddy 的版本账本由 `installed_plugins.json` 记录、**目录名里带版本号**——
> 原地覆盖会让「cache 里的文件」与「注册表记的版本」对不上。推荐走下面的手动方式。

**推荐：手动拉取（本地目录安装）**

如果安装时选的是本地目录，更新 = 拉新代码 + 让客户端重抓一遍；GitHub 源安装则直接在市场里点「刷新」，不需要 `git pull`。

1. 在仓库目录里 `git pull` 拿到最新版（每次发版 `.codebuddy-plugin/plugin.json` 与 `.codebuddy-plugin/marketplace.json` 的版本号都会同步递增，这是客户端判断「有新版本」的依据）。
2. 在技能市场页选中 `fox-local` 市场，点「**刷新**」（或先「删除」再按上面的方式 B 重新添加），新版本会装进独立的缓存目录（`cache/fox-local/fox-widget/<版本>/`）。
3. 重启客户端生效。

说明：挂件的全部数据（API key、账本、角色、泡泡配置、Electron 运行时）都在 `<插件数据目录>`（默认 `~/.workbuddy/plugins/data/fox-widget-fox-local/`），与插件目录无关，更新不丢配置。

**可选：打开挂件内自更新**

想用的话，给服务进程设 `FOX_WIDGET_ENABLE_UPDATE_CHECK=1`（并接受上面的混用风险）。打开后的行为与 ZCode 版一致：定时自检远端版本（启动 20 秒后首查，之后每 6 小时一次），发现新版弹一次气泡提醒，菜单「更新」里可手动检查；下载走镜像候选链、校验包内版本号、先备份再替换（备份到 `<插件数据目录>/update/backup/`，只留最近两份）。

发版口径（本分支）：tag 用 **`wb-v*`** 前缀与 ZCode 线区分；探测读的是 `workbuddy` 分支的 `.codebuddy-plugin/plugin.json`；GitHub API 那条源会从 releases 里挑 `wb-v*` 的最高版本（不能直接用 `releases/latest`——两条产品线共用一个仓库，它可能返回 ZCode 线的 tag）。

**出站与安全**：更新链路的每个地址都过统一白名单校验（仅 https，且拒绝环回 / 私有 / 保留地址），镜像只做原样转发（不引入第三方账号或 token）；下载的整包在 `node:zlib` 内解压并自带最小 tar 解析（不调用系统 tar），解包后逐条校验路径（绝对路径 / `..` / 驱动器号一律丢弃）。下载**没有签名或哈希校验**：完整性只依赖 HTTPS 与「包内 `plugin.json` 的版本号 == 目标版本」这一条一致性检查——这是本插件「镜像半可信」取舍的一部分，在意这一点的用户请走手动方式（`git pull` 自行核对）。响应体与解压输出都有大小上限（整包 80MB、解压总量 300MB），超限即中止。

---

## 首次配置

### API Key（可选功能，一般不用配）

> **主口径的积分显示完全不需要配任何 Key。** 下面这套只服务于「可选的厂商余额卡」。
> WorkBuddy 是订阅积分制、模型由宿主托管，所以**默认找不到任何用户自带的厂商凭据**——
> 这是预期行为，不是故障。想用余额卡再按下面的顺序配。

余额接口需要一个 DeepSeek API Key。按以下顺序自动查找：

1. 环境变量 `DEEPSEEK_API_KEY`
2. 插件配置 `${CODEBUDDY_PLUGIN_DATA}/config.json` 的 `apiKey`（或 `vendorKeys.<模板 id>`）
3. 宿主配置里能发现的凭据：`~/.workbuddy/settings.json` 的 `env` 块 /
   `pluginConfigs.<插件>.options`，以及 `~/.workbuddy/plugins/data/*/config.json`
   （**实测本机这三处都是空的**，所以第 3 条通常落空）

写入方式（任选其一）：

```bash
echo 'sk-xxxxxxxxxxxxxxxx' | node lib/cli.mjs key   # 从 stdin 读（密钥不进 shell 历史与进程列表）
```

或让会话里的模型直接调 MCP 工具 `whale_config`（`action=set`, `apiKey=...`）。

密钥只在本机内存中使用，只发往 `api.deepseek.com` / `platform.deepseek.com`，不写日志、不打印明文（对外只显示 `sk-04…994` 这样的掩码）。

### 关掉不想要的自动化

`${CODEBUDDY_PLUGIN_DATA}/config.json`：

| 字段 | 默认 | 作用 |
|---|---|---|
| `autoStartWidget` | `true` | 会话启动时自动拉起挂件服务（看门狗也照它怠速） |
| `autoStartOverlay` | `true` | 会话启动时顺便拉起桌面浮层 |
| `followIntervalMs` | `40` | 跟随探测间隔（毫秒），菜单里的选择会覆盖它 |
| `port` | 自动（39321） | 固定端口，被占用时自动顺延 |

改完重启会话生效。

---

## 使用指南

### 打开 WorkBuddy 就自动出现

插件自带 SessionStart hook，**每次会话启动都会幂等拉起**（已在跑就复用，不会重复开）。确认方法：

```bash
cat ${CODEBUDDY_PLUGIN_DATA}/autostart.log      # 每次启动追加一行，如 server=started overlay=reused
```

> SessionStart 是在**会话启动**时触发的。正常情况下打开 WorkBuddy 会恢复/创建会话，所以碰不到边界情况。

#### 冷启动死角与看门狗（推荐补装）

实测 WorkBuddy **应用启动本身不触发任何插件钩子**（钩子与插件 MCP 都随「会话动作」——回退对话 / 新对话 / 发消息——而来），而钩子拉起的服务与浮层长在宿主进程树上，应用退出即被收走。于是存在一个死角：**启动 WorkBuddy 后一动不动 = 桌面上没有挂件**。

看门狗（`lib/watchdog.mjs`）补这个缺口：一个登录自启的独立小进程，监听宿主 `logs/AppStartup.log` / `AppShutdown.log`，WorkBuddy 一启动就把「服务 + 浮层」拉起来，运行期每 15s 自检补活（服务被会话切换连带杀掉也会被拉回），宿主退出后宽限 5 分钟再停服务。

装一次即可（**每台机器一次，不是每次开机**）：

```bash
node lib/cli.mjs desktop install     # 装 Electron 运行时的同时**顺手装好看门狗**（推荐路径）
node lib/cli.mjs watchdog install    # 也可以单独装（只装看门狗，跳过运行时）
node lib/cli.mjs watchdog status     # 查看自启项与进程状态
node lib/cli.mjs watchdog uninstall  # 移除
```

启动项写在启动文件夹（`fox-widget-watchdog.vbs`，用户级、免管理员、删文件即卸载），登录时它会自动挑最新的插件副本与可用的 node，所以**插件升级后不需要重装**。日志在 `${CODEBUDDY_PLUGIN_DATA}/watchdog.log`。`autoStartWidget=false` 时看门狗怠速（不拉起任何东西）；排障可临时 `FOX_WIDGET_NO_WATCHDOG=1`。菜单里的「关闭插件」会让看门狗**在本次**停手（它每 15 秒补活，不拦就白关了；见「使用指南」的「挂件菜单」末行）。

### 命令行

```bash
node lib/cli.mjs status          # 今日积分 + 上下文余量 + 近 7 天 + 挂件服务与桌面浮层状态
node lib/cli.mjs turn            # 上一轮对话消耗（积分 + 等价金额 + 逐档明细）
node lib/cli.mjs start / stop    # 启停挂件服务（浮层与本地页面共用同一个）
node lib/cli.mjs close           # 关闭插件：停浮层与服务（本次关闭，看门狗本次也停手；下次启动照常拉起）
node lib/cli.mjs window start    # 启动桌面浮层（浮在 WorkBuddy 界面上）
node lib/cli.mjs window stop     # 关闭浮层
node lib/cli.mjs window status   # 浮层与运行时状态
node lib/cli.mjs desktop install # 安装 Electron 运行时（仅浮层需要，一次性）
node lib/cli.mjs watchdog install # 装看门狗：WorkBuddy 一启动挂件就位（见上节）
echo 'sk-...' | node lib/cli.mjs key   # 写入 API Key（走 stdin，不留命令行痕迹）
node lib/cli.mjs mode ledger|token  # 切换对账口径（大肥鱼记账 / 实时·令牌）
node lib/cli.mjs json            # 结构化输出，便于脚本消费
```

### 在对话里直接用

- 输入 `/fox`（或 `/fox turn`、`/fox window start`；写 Key 建议用上面的 stdin 方式，避免密钥留在对话与命令行历史里）
- 或者直接问「我还有多少余额」「上一轮花了多少」，WorkBuddy 会调用 MCP 工具：

| MCP 工具 | 作用 |
|---|---|
| `whale_balance` | 余额、今日已用、当前峰谷时段 |
| `whale_last_turn` | 上一轮消耗金额与逐档明细 |
| `whale_widget` | `start` / `stop` / `status` / `url` / `close`（关闭插件），以及浮层的 `overlay_start` / `overlay_stop` / `overlay_status` |
| `whale_config` | 查看或修改配置（API Key、对账口径、端口、自启、跟随间隔） |

### 挂件菜单

悬停鲸鱼 → 右上角出现三点按钮 → 点击打开菜单：

| 项 | 说明 |
|---|---|
| 大小 | 0.6–2.5×，滑块或数字（1–20） |
| 音效 / 音量 | 内置小黄鸭/音效1，可导入自定义音效（1 个=按压松手共用，2 个=按压+松手）；音量 0 即静音 |
| 角色 | 选择形象（内置：嘎啦嘛 / 大肥鱼 / GPT娘 / kimi娘 / 小克 / 哈基米）；导入的图片可改名（✎）或删除（×）；内置形象也可删（隐藏记在 roles.json 的 hiddenBuiltins，清掉即找回）。在角色菜单里手动选过形象会自动关掉「按模型换角色」，尊重手动选择 |
| 按模型换角色 | 默认开：按当前模型的厂商族自动切换内置形象（GLM 系→嘎啦嘛、DeepSeek→大肥鱼、GPT 系→GPT娘、Kimi→kimi娘、Claude→小克、Gemini→哈基米），连带该角色的配色与台词池一起换；认不出的模型（Qwen / MiniMax / MiMo / 混元 / 阶跃…）保持当前形象不动 |
| 气泡 | 左侧开关控制思考气泡显隐，右侧「按压泡泡设置」打开自定义队列；同一行末尾的「等确认提醒」默认关：打开后 WorkBuddy 弹出通知（含权限确认 / 提问）时，挂件提醒一次（同一件事只提醒一次） |
| 对账口径 | 大肥鱼记账 / 实时·令牌（v1.7.0 起决定「对账 + 兜底」用哪个账号数字，主显示固定本机库） |
| 峰谷播报 | 台词里峰谷文案的风格（默认 / 梁文峰谷 / !?强强?!） |
| 主题 | 浅色模式 / 深色模式 / 跟随 WorkBuddy（三层判定：浮层观测 WorkBuddy 窗口的 DWM 暗色标志 > 配置 ui.theme > 操作系统深浅色） |
| 显示 | 气泡主显示跟随哪个计费源（自动 / Plan / CommandCode / GLM / DeepSeek） |
| 气泡 | 是否允许自动弹出气泡 |
| 按压泡泡 | 自定义按压泡泡队列（DSH 式可视化编辑器：加权变体 / 随机语句带权重与样式 / 内置视图 / 图片与随机图片 / 超链接 / 模块库）；首分区「每轮消耗提示内容」同面板编辑 |
| 每轮消耗提示 | 是否在每轮结束后弹消耗气泡；自动关闭秒数（0 = 手动关）。提示内容在「按压泡泡设置」首分区编辑 |
| 避让滚动条 | 让挂件右侧避开滚动条的像素宽度（默认关） |
| 隐藏菜单按钮 | 开启后挂件上的菜单按钮不再出现，改用右键点击角色唤出菜单（位置不变） |
| 桌宠模式 | **仅浮层**：锁在最上层、切应用不隐身 |
| 跟随延迟 | **仅浮层**：探测 WorkBuddy 窗口位置的间隔，16 / 40 / 100 / 250ms（16ms 为系统定时器粒度下的实际下限） |
| 用量记录 | 今日金额与模型占比、近 7 天逐日、最近 50 条明细（一级菜单；v1.8.0–v1.8.6 曾收进记账页） |
| =角色名记账= | 记账二级页：额度预警 / 余额预警 / 预警内容模板 / 余额校正（原「预警」「余额校正」两行已收编于此） |
| 关闭插件 | 在记账二级页的「检查更新…」面板最右侧、「重启挂件」旁边：把**当前这一份**停掉——桌面浮层与挂件服务都退出，看门狗本次也停手（否则它 15 秒内就会把挂件拉回来）。它只是本次关闭：下次启动 WorkBuddy 照常拉起，跟手动关掉一个窗口一个意思。要连点两次才知道你是认真的（第二次按钮变成「确认关闭？」，面板里有提示），关掉之后界面上没有可点回来的入口；想立刻回来就在终端跑 `node lib/cli.mjs start`（要浮层再 `window start`），或在会话里让助手调 `whale_widget` 的 `start`。更新正在写文件时这个按钮不可用 |

### 浮层里的交互要点

- 鲸鱼可以拖到窗口内任意位置，靠边会吸附，贴左缘时整体左右镜像。
- **指针要先落在鲸鱼上，点击才会被浮层接管**——这是穿透设计的必然代价，好处是不会误触。
- 普通交互（按鲸鱼、拖拽、开菜单、点气泡）不会抢走 WorkBuddy 的前台，WorkBuddy 不会因为挂件而停止刷新。
- 菜单里的文本框/下拉**按上去就能打字**：指针按到输入类控件时浮层才临时接管键盘焦点，离开即交还。

---

## 跟随延迟与性能

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

## 数据与计价口径

> **本分支的主口径是「订阅积分」，不是「余额」。** WorkBuddy 是订阅/积分制，模型全部由宿主托管，
> 每一轮对话扣多少 credit **由宿主算好并落库**，不需要（也没有）用户自带的按量 API Key。
> 所以 ZCode 版那套「DeepSeek 余额 + 峰谷计价」在这里降级为**可选的附加卡**：
> 你若自己配了某家厂商的 key，那张卡才有数据；不配也完全不影响主显示。

### 今日积分（主口径）

- 数据源：会话 transcript（`~/.workbuddy/projects/<slug>/<sessionId>.jsonl`）里每次模型调用带的
  `providerData.rawUsage.credit` —— **积分是宿主算好的**，挂件只做聚合。
- 聚合方式：扫最近 60 个会话文件的各 2MB 尾部（性能取舍，见下），按 `conversationRequestId`
  归「轮」、按日期汇总。`/whale/usage-records.json` 的 `scannedTranscripts` / `totalTranscripts`
  如实暴露扫描范围。
- **已知局限**：会话数或单会话长度超过上限时，「今日合计」会偏低。这是刻意的取舍——
  服务每秒轮询、页面几十秒轮询，全量读几十个 jsonl 太贵。

### 上下文余量（本分支新增）

- 数据源：`~/.workbuddy/workbuddy.db` 的 `session_usage` 表（`used` / `size` / `updated_at`）。
- 显示为「上下文 22%」，10 秒刷新一次。这是 ZCode 版没有的能力（那边没有等价的宿主接口）。

### 每轮消耗

- **积分（主数字）**：一轮 = 一个 `conversationRequestId`。一轮 agent 循环会对同一个 requestId
  落几十次模型调用（实测有一轮 50 次），必须归并成一条，否则气泡会连弹几十次。
  积分优先取宿主 `session_usage.credit_json` 里的权威值；transcript 已出现该请求但宿主还没记账时，
  按 `rawUsage.credit` 求和兜底并标注「结算中」。
- **等价金额（附注）**：同时按公开价目折算一个参考金额，界面上标 `≈`，**不代表真实扣费**。
- 逐模型明细与 token 分桶（缓存命中 / 未命中 / 缓存写入 / 输出）照旧可用。

> **一个必须注意的口径**：transcript 的 `prompt_tokens` 是**含缓存命中的总输入**
> （实测 `total_tokens = prompt_tokens + completion_tokens`、
> `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`）。
> 折算等价金额前必须减掉命中部分，否则缓存那大部分会被按未命中价重复计费，金额虚高十几倍。
> 代码用 `lib/pricing.mjs` 的 `splitInputTokens()` 统一处理；`lib/turn-cost.mjs` 的
> `usageFromRawUsage()` 负责字段映射。另外 `completion_tokens` **含思考**
> （`completion_thinking_tokens`），映射时要减掉再单列思考，别重复计。
> `tools/selftest.mjs` 里有针对这个陷阱的回归断言。

想核对细节，用 `node lib/cli.mjs turn`：

```
上一轮对话消耗   14.88 积分（50 次模型调用）
模型             deepseek-v4.1-flash  Deepseek-V4.1-Flash  (订阅积分)
等价金额         ≈ ¥ 1.0297  （按公开价目折算，非真实扣费）
   缓存命中输入  6,966,528 tokens
   未命中输入    166,827 tokens
   输出          52,174 tokens
总处理 token     7,185,529  （含每一步重复携带的上下文）
```

### 可选：厂商余额与额度

- **DeepSeek 余额**：`GET https://api.deepseek.com/user/balance`，需要 `DEEPSEEK_API_KEY`
  （环境变量或插件配置）。WorkBuddy 默认没有这个 key。
- **35 家厂商模板**（余额 / 配额 / 订阅窗口 / 无接口）：与 ZCode 版共用同一套实现（「智谱 Coding Plan」卡读官方套餐用量接口的窗口百分比与**剩余额度**，两种接口形状都收），凭据发现路径换成
  宿主侧（见 `lib/discover.mjs`）。**默认不可用是预期**——WorkBuddy 没有用户自带凭据的存储
  （实测 `settings.json` 的 `pluginConfigs` 为空、`models.json` 为 `[]`）。
- **GLM Plan 配额：本分支已砍**。它唯一的数据源是 ZCode 客户端日志，WorkBuddy 没有对应物；
  接口 `/whale/plan.json` 恒返回 `not-supported-on-workbuddy`。
- **CommandCode 三重额度**：保留（走 HTTP，与宿主无关），但移出主显示、留在厂商卡层。

### 改价目

价目只影响「等价金额」这一层（积分不受影响）。DeepSeek 调价时改 `lib/pricing.mjs` 顶部的
`PEAK_HOURS` / `BASE_PRICE` / `PRO_PRICE`。流程见 `skills/fox-pricing-review/SKILL.md`。

---

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 界面上看不到挂件 | WorkBuddy 客户端不提供界面注入点，必须走桌面浮层：`desktop install` 装运行时，再 `window start` |
| 打开 WorkBuddy 没有自动出现 | 看 `${CODEBUDDY_PLUGIN_DATA}/autostart.log` 最后一行。**没有新行说明钩子没被触发**（插件未启用，或改完 `hooks/hooks.json` 后没重启客户端，或钩子里的 `node` 不在 PATH）；`skip: autoStartWidget=false` 说明配置里关掉了自启（菜单里的「关闭插件」不写配置，它只停当前这一份）；`overlay=skipped:no-runtime` 说明运行时没装；`overlay=failed:...` 看括号里的原因。想看钩子到底有没有跑：设 `FOX_WIDGET_HOOK_DEBUG=1`，每次事件会写进 `${CODEBUDDY_PLUGIN_DATA}/hook.log` |
| 点过菜单里的「关闭插件」，想立刻让它回来 | 启动一次即可：`node lib/cli.mjs start`（要浮层再加 `window start`），或在会话里让助手调 `whale_widget` 的 `start`。它只是本次关闭，什么都不用恢复——下次启动 WorkBuddy 本来就会照常拉起 |
| 积分 / 上下文一直读不到 | 先看 `/whale/hook.json` 有没有 `sessionId`（没有 = `UserPromptSubmit` 钩子没跑到，`hook-state.json` 没写）；再看 `/whale/context.json` 的 `reason`：`db-unavailable` = 宿主 `workbuddy.db` 读不到或自带 node 不支持 `node:sqlite`（需 ≥ 22.5，实测 22.22.2 可用） |
| 余额显示「未找到 DeepSeek API Key」 | **这是预期**：WorkBuddy 是订阅积分制，默认没有用户自带的厂商 key（模型由宿主托管），所以厂商卡默认全都不可用。想用就自己配：环境变量 `DEEPSEEK_API_KEY`，或 `${CODEBUDDY_PLUGIN_DATA}/config.json` 的 `apiKey`，或 `echo 'sk-...' | node lib/cli.mjs key`（走 stdin，密钥不留命令行痕迹）。逐条明细看 `/whale/health` 的 `keyProbe` |
| 今日积分比客户端显示的小 | 面板扫的是 `~/.workbuddy/projects/*/*.jsonl`，只取最近 60 个会话、每个只读尾部 2MB（性能取舍）。老会话或超长会话的早期轮次可能没算进去——`/whale/usage-records.json` 的 `scannedTranscripts` / `totalTranscripts` 能看出来 |
| 点击挂件/气泡没声音 | 检查菜单音量是否为 0、音效组是否已选；音频在页面加载时预热，系统输出设备切换后若无声，重启浮层即可。按压音只对「按鲸鱼」和「点气泡」发声，菜单按钮刻意不出声 |
| 点设置键却有音效 / 点挂件没音效 | v1.3.0 起菜单按钮不再出声；鲸鱼与气泡的按压音依旧。若点鲸鱼完全没声音，先确认菜单音量不为 0 |
| **和挂件互动后 WorkBuddy 画面卡住，点一下 WorkBuddy 才恢复** | 浮层窗口已设为不可激活（`focusable: false` → `WS_EX_NOACTIVATE`），普通交互不再抢走宿主前台（宿主失去前台会停止刷新自身画面）。另有 `desktop/main.cjs` 的 `type: 'toolbar'`（让浮层不进宿主 Chromium 的遮挡判定）**不能删**。若仍复现，检查浮层是否为旧版本（`window status` / `/whale/health` 的 version），并 `window stop` + `window start`（窗口选项改动必须重建才生效） |
| 浮层里菜单的数字框打不了字 | 浮层在指针落到输入类控件时临时接管键盘焦点，离开即交还；下拉也已换成自定义组件、不走系统弹窗。若仍不行，检查是否在用旧版浮层，或改用本地页面（浏览器打开 `http://127.0.0.1:<port>/`）直接键入 |
| 切了模型气泡还是旧源 | 自动跟随 3 秒轮询一次输入框选择；选择读不到时回落最近一次真实模型调用。菜单「显示」手动锁定可立即切换 |
| 余额显示旧值并带 `stale` | 接口瞬时失败（网络/5xx），服务在回退缓存；4xx 不会回退，会直接报错 |
| 今日积分一直是 0 | 说明扫描范围内没有模型调用记录：确认宿主已经跑过至少一轮对话，且 `~/.workbuddy/projects/` 下有对应会话的 `.jsonl`。`/whale/usage-records.json` 的 `scannedTranscripts` / `totalTranscripts` 能看出扫了哪些文件 |
| 每轮消耗不弹窗 | 需要宿主至少完成过一轮对话（transcript 里有 `rawUsage`）；另外菜单里「每轮消耗提示」必须开着。`/whale/last-turn.json` 的 `partial:true` 表示该轮宿主还没结算积分 |
| **每轮消耗的等价金额离谱（虚高十几倍）** | 等价金额折价踩了「input 含缓存」的坑。核对 `splitInputTokens()` 是否被 `costOfUsage()` 使用、`usageFromRawUsage()` 的字段映射是否正确，并跑 `node tools/selftest.mjs`；用 `cli.mjs turn` 看逐档明细即可判断。（注意积分主数字不受影响——它是宿主算好的） |
| 鲸鱼不跟着 WorkBuddy 走 | 探测脚本可能挂了：`window stop` 后 `window start` 重建。目标进程名是 `WorkBuddy`（可用环境变量 `WHALE_TARGET_PROCESS` 覆盖）；开 `WHALE_DEBUG_PORT` 启动会把判断依据写进 `${CODEBUDDY_PLUGIN_DATA}/overlay-debug.log` |
| 跟得不跟手 / 想更省资源 | 菜单「跟随延迟」即时切换 16/40/100/250ms（改完不需重启浮层），或写 `config.json` 的 `followIntervalMs`。默认 40ms 实测端到端延迟约 13ms、稳态 CPU 约 0.16% 单核（曾有的 5ms 档已移除：实际周期受定时器量子限制只能到 ≈11ms，名不副实） |
| 浮层里点不动鲸鱼 | 指针要先落在鲸鱼上（光标变 `grab`、右上角出现菜单按钮）；若整块区域都点不动，检查是否被其它置顶窗口压住 |
| 浮层启动失败 | `cli.mjs window status` 看运行时是否已装 |
| 峰谷判定不对 | 看 `lib/pricing.mjs` 的 `PEAK_HOURS` 等常量；工作日高峰为北京时间 9–12、14–18，2026-08-23 起周末全天谷价 |
| 换了图片/音效不生效 | 资产路由每次读盘且 `no-store`，强刷即可；确认替换的是 `assets/` 下的同名文件 |
| Plan 剩余配额不显示 | **本分支已砍掉该功能**（`/whale/plan.json` 恒返回 `not-supported-on-workbuddy`）。原因：它唯一的数据源是 ZCode 客户端日志，WorkBuddy 没有对应物。ZCode 分支（`main`）上该功能照常 |
| CommandCode 额度读不到 / 卡片说「未找到反代凭据」 | 凭据是**现读**反代本地配置 `~/.cmdgo-bridge/credentials.json`（只支持本机反代），不在环境变量里；反代没跑或该文件不存在时就是这个提示。v1.7.9 起兼容两种凭据形状（纯字符串与 `{value,source}` 对象）。`cmdgo-bridge` 换过数据目录时用 `CMDGO_DIR` 指过去 |
| CommandCode 额度卡显示「已限流」 | 网关的 `exceeded` 或已用 ≥100%：某一窗口到顶，补满前不可用。卡片最下面那行是**绑定约束**窗口的重置时间（多窗口同时撞墙时报最晚的那个，早重置的不解锁）；「账号池已全部限流」= 所有账号都没额度了 |
| CommandCode 额度卡/气泡里出现 $ 之外的换算疑虑 | credit 池以美元计价，而「今日已用」按各厂商本币价目折算，多币种日是**等价口径**而非账单口径（见「数据与计价口径」） |
| 开了桌宠模式后鲸鱼可以在整个屏幕上拖 | 这就是桌宠模式（v1.8.1）：界面 = 整个工作区（自动排除任务栏，任务栏在哪条边都成立）+ 失焦不隐身 + 锁在最上层。关掉即回到「跟随 WorkBuddy 窗口」 |
| 挂件每隔几秒消失再出现一次 | 旧版冻结检测误判循环（v1.8.1 修过一轮）；v1.8.6 起「活性点 + DXGI」检测整体移除，该类误判不复存在。画面若真冻结（页面活着、屏幕停旧帧），最迟 60 秒出帧保险自愈，或 `node lib/cli.mjs window restart` 立即重建 |
| 想要大肥鱼那张原版脸 | v1.8.1 已回滚「大肥鱼蓝白」主题（与浅色主题重复）；形象仍可在菜单「角色」切换 |

---

## 自助排查工具

> 运行环境：Node >= 22.5（依赖内置 `node:sqlite`）。`server.json` 含关停令牌，POSIX 下以 0600 落盘；Windows 靠用户目录 ACL 限制其他用户读取。

```bash
node tools/selftest.mjs        # 计价口径回归 + 每轮消耗链路端到端自检（不碰真实数据）
node tools/smoke-ui.mjs        # 前端冒烟：headless Edge/Chrome + CDP 跑真实页面（气泡 hint、displayMode 持久化）
node tools/demo.mjs            # 用假数据起一个服务并周期性产生新轮次，用于观察消耗气泡
node tools/debug-overlay.mjs   # 连进浮层页面（需以 WHALE_DEBUG_PORT 启动）排查渲染/交互
```

---

## 架构

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

## 安全说明

- **出站白名单**：只向 `api.deepseek.com`、`platform.deepseek.com` 发请求；发请求前校验协议、主机名，拒绝环回/私有/保留地址的字面量 IP。要扩展目标需改 `lib/credentials.mjs` 的 `ALLOWED_HOSTS`。更新链路是**另一份**白名单（`lib/update.mjs` 的 `UPDATE_HOSTS`：GitHub 与几个转发镜像），同样规则。
- **本地服务**：只监听 `127.0.0.1`；校验 `Host` 头防 DNS rebinding；写操作校验 `Origin` 防跨站伪造；停止服务需要 `server.json` 里的随机令牌；不返回通配 CORS 头。
- **更新接口的信任边界**：`/whale/update.json` 无令牌、同源即可触发，而它的作用是「按镜像内容替换自身代码」——爆炸半径大于其他写接口。可换来的保障只有 HTTPS、出站白名单与「包内版本号 == 目标版本」的一致性检查，**没有签名 / 哈希校验**（见上文「更新」小节的说明）。不愿意接受这一点的用户请用方式二自行 `git pull`。
- **浮层**：只加载本机 `127.0.0.1` 的页面，运行在 `contextIsolation` 下，仅通过 preload 暴露 `setInteractive` / `setViewport` / `quit` / 跟随间隔几个能力，页面没有 Node 权限。气泡里的外链统一交给系统浏览器打开，浮层窗口自身拒绝导航与新开窗口。
- **凭据**：API Key 只在内存中使用，不落日志、不打印明文。
- 排查用的远程调试端口默认关闭，只有显式设置 `WHALE_DEBUG_PORT` 才打开。

---

## 已知限制

- 浮层仅支持 **Windows**（依赖 Win32 窗口 API 与 PowerShell）；macOS / Linux 上只有本地页面形态可用。
- 浮层跟随靠轮询，拖动时理论上存在约一个探测间隔的滞后（默认 40ms，实测 13ms，肉眼几乎看不出）。
- 浮层里**吸附没有滑动动画**（位置直接就位）。这是为了避开透明窗口的合成层错位——详见下面「踩坑记录」；本地页面（浏览器打开）里动画完整。
- 浮层穿透的必然代价：点击某个位置前，指针得先落在鲸鱼上。
- 菜单里的数字输入框在浮层里建议用箭头/滑块，因为透明浮层窗口默认不抢键盘焦点。
- 菜单默认弹在鲸鱼头顶；鲸鱼被拖到窗口顶部、上方放不下时会翻到按钮下方（两种模式都一样）。
- 每轮消耗只统计 ZCode 自己记录的主对话轮次；ZCode 之外调用的 API 不计入。

### 踩坑记录（写给后来改这份代码的人）

1. **透明窗口不能靠 `setBounds` 贴合别的窗口**。一改尺寸/位置，Windows 合成层不重排，页面内容会被画到偏离窗口的地方（实测页面 `(0,0)` 的方块跑到窗口外）。现在的做法是窗口恒定铺满工作区，把 WorkBuddy 窗口矩形作为「视口」发给页面。
2. **浮层模式下必须禁用定位 CSS 过渡**（`.zcwv-root.zcwv-overlay{transition:none}`）。对 `left/top` 做过渡同样会触发合成层错位。
3. **不要给浮层设 owner 窗口关系**。系统会在 Electron 背后直接显示/隐藏窗口，`BrowserWindow.isVisible()` 与实际状态脱节，恢复后不再显示。
4. **`resizable:false` 会锁死窗口尺寸**（Electron 把 min/max 设成创建时大小），之后任何改尺寸的调用都被拒。
5. **位置记忆必须在拿到真实坐标系之后再恢复**，否则会按屏幕尺寸算出错误锚点。
6. **`desktop/follow-window.ps1` 必须保持纯 ASCII**。Windows PowerShell 5.1 按系统 ANSI 代码页读取无 BOM 的 `.ps1`，中文注释会被解码成破坏语法的字节，脚本直接退出、跟随失效。
7. **`$ErrorActionPreference='SilentlyContinue'` 会吞掉 `Add-Type` 的编译错误**，表现成「脚本秒退、浮层跟着退出」。该脚本已改为显式输出编译/运行错误。
8. **C# 内联代码只能用 .NET Framework 的 API**（PS 5.1 的编译目标），例如 `Environment.TickCount64` 不存在，要用 `TickCount`。
9. **浮层里有两套坐标系，不能混用**。`viewport()` 返回的是 WorkBuddy 窗口矩形（鲸鱼的位置、吸附、居中都按它算），而 `position:fixed` 的元素（挂在 `body` 上的挂件菜单）参照的是页面自身视口，也就是铺满整个工作区的浮层窗口。窗口化 ZCode 时两者差着几百像素，拿 `viewport()` 去算 `position:fixed` 的偏移会把菜单整个甩到屏幕外（实测菜单被算到 x=2812，而浮层只有 2560 宽）。这类 fixed 元素一律用 `pageViewport()`。
10. **挂在 `body` 上的 fixed 元素不会跟着 root 走**。浮层里 WorkBuddy 窗口一移动，鲸鱼跟着动、菜单留在原地，所以 `settle()` 里每次都带一次 `positionMenu()`。

---

---

## 版本历史

- 逐版本变更：[CHANGELOG.md](./CHANGELOG.md)（v1.1.0 起；相邻小修复版本按合并策略并入组内最后版本号，现存版本均有 tag 与 GitHub Release）。
- 贡献与提交规范：[CONTRIBUTING.md](./CONTRIBUTING.md)。
- 命名沿革：ZCode 版 DeepSeek 余额小鲸鱼挂件（移植期）→ Widget of ZCode（v1.8.2–v1.8.4）→ **ZCode狐娘小挂件**（v1.8.5 起）。

---

## 许可与致谢

本仓库以 **MIT** 许可发布，见 [`LICENSE`](./LICENSE)。

- 原版挂件的视觉与交互设计、鲸鱼形象、rua 动图与音效来自 **[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)**（Copyright (c) 2026 MeteorNOX，MIT）。
- ZCode 移植版（宿主适配层重写、凭据发现、每轮消耗数据源）由 **[nb10yyds/zcode-whale-widget](https://github.com/nb10yyds/zcode-whale-widget)** 完成，本仓库 fork 自其基线。
- v1.1.0 起的功能与优化（详见 [CHANGELOG](./CHANGELOG.md)）为 fork 后的延续开发；`GLM.png`（嘎啦嘛）、`gpt.png`、`kimi.png` 与 README 头图 `wb.png` 为项目自有素材。
- 内置形象 **小克**（`assets/xiaoke.png`）取自 **[aklnaaw/dsh-xiaoke-widget](https://github.com/aklnaaw/dsh-xiaoke-widget)**（MIT，Copyright (c) 2026 MeteorNOX；该仓库二创自本仓库的上游），**已获原作者授权**在本项目中使用，图片按本仓库角色画布规格做了等比归一化。
- 沿用与新增的逐条清单见 [`NOTICE`](./NOTICE)。如果喜欢这只鲸鱼（或狐娘），请去给上游点个 star。
