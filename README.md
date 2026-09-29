# ZCode 版 DeepSeek 余额小鲸鱼挂件

> 在 ZCode 里常驻一只小鲸鱼：显示 **DeepSeek 余额**、**今日已用**、**当前峰谷时段**，每轮对话结束还会弹一个气泡告诉你 **上一轮花了多少钱**。
>
> 它浮在 ZCode 窗口的右下角，跟着窗口移动/最小化/关闭，指针不在它身上时点击直接穿透到下面的应用——**不挡任何操作**。

---

## 关于参考项目（请先读这一段）

**本项目不是原创，是移植版。** 所有的视觉与交互设计、鲸鱼素材、音效、台词、峰谷定价表和计费口径，都来自下面这个项目：

| | |
|---|---|
| **项目** | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) |
| **作者** | MeteorNOX |
| **许可** | MIT（Copyright (c) 2026 MeteorNOX） |
| **原始形态** | DSH（DeepSeek Harness）的 Web 插件 |

上游是一个挂在 **DSH 网页界面**右下角的挂件：它由宿主插件（`lib/index.js`）通过 `webServer` 注册路由，并用 `tapIndex` 把 `widget.js` 注入进 DSH 的页面。它监听宿主进程内的 `session/event` 事件流来统计每轮消耗，从 DSH 的凭据服务读 `DEEPSEEK_API_KEY`。

**ZCode 没有这些扩展点**（客户端不支持往界面注入脚本，插件也没有凭据服务、拿不到进程内事件流），所以宿主适配层是重写的，但**挂件本身的观感与算法追求与上游一致**。

### 具体哪些沿用、哪些重写

**沿用自上游（保持一致，含数值）**

- `assets/` 下全部素材：鲸鱼形象 `DSniang1.png` / `DSniang02.png`、`rua.gif`、两套音效（`Ya1/Ya2`、`D1/D2`），原样复制。
- 气泡 SVG 几何（1026×700 画布上的大椭圆、尾巴半椭圆、两个小气泡）、描边色与线宽。
- 字号档（A/B/P/C 四档与 `--zcw-u` 联动变量）、金额格式、文字块定位。
- 动画参数：数字滚动 700ms ease-out、按压 `scaleY(0.88) scaleX(1.05)` 与 `cubic-bezier(.34,1.56,.64,1)`、气泡 5 秒自动收起、60 秒自动刷新。
- 交互：拖拽移动、四分之一区域吸附（四边可组合成角落）、吸附左缘时整体水平镜像、按图片 alpha 通道做命中检测（透明区穿透）。
- 随机台词六组的文案与权重、"每轮消耗"金额气泡的两行样式与自动关闭秒数。
- 峰谷定价表与时段规则（工作日北京时间 9–12、14–18 为高峰；2026-08-23 起周末全天谷价），以及"缓存读取按命中价、未命中输入与缓存写入按未命中价、输出与思考按输出价"的分档思路。
- 记账模式语义：按观测到的余额下降累计、充值不扣减、币种切换只重置基准、跨天归档保留 30 天。
- 余额接口的取项规则：多币种数组顺序不固定，优先 CNY 且大于 0；以及 25 秒缓存、in-flight 去重、瞬时失败回退旧值并标记 `stale`。

**为 ZCode 重写**

- **呈现层**：上游注入 DSH 网页；这里改为自带本地服务 + 独立页面，并额外提供一个透明置顶的桌面浮层窗口。
- **凭据发现**：上游从 DSH 凭据服务读；这里做成环境变量 → 插件配置 → 复用 ZCode 客户端里已配的 DeepSeek provider 三级查找。
- **每轮消耗数据源**：上游监听 `session/event`；这里读 ZCode 落库的 `turn_usage` 表（并支持回退到模型 I/O 日志）。
- **平台集成**：MCP 服务、SessionStart 自启 hook、skill、`/whale` 命令、命令行工具。
- **安全加固**：出站主机白名单与地址校验、本地服务的 Host/Origin 校验与关闭令牌。

上游的 `LICENSE` 原样保留在本仓库中，另有 [`NOTICE`](./NOTICE) 逐条列出沿用与新增的部分。

---

## 功能

- **余额**：来自 `https://api.deepseek.com/user/balance`。
- **今日已用**，两种模式（菜单切换）：
  - **小鲸鱼记账**（默认，免令牌）：观测余额下降自动累计，跨天归档保留 30 天，币种切换不会记成消费。
  - **实时·令牌**：用平台令牌调用量接口取 token 分桶，按峰谷定价换算（该接口只返回 token 数，不返回金额）。令牌缺失时自动回落记账模式并标注。
- **每轮对话消耗**：读取 ZCode 记录的每轮真实 token 用量，换算金额后弹出红色金额气泡（自动关闭秒数可设，填 0 表示手动关闭）。可逐档核对明细。
- **挂件交互**：拖拽、四边四分之一吸附、左吸附水平镜像（文字保持可读）、按压 Q 弹 + 音效、余额变化数字滚动、点击鲸鱼弹气泡、再点切随机台词（含 rua 动图）。
- **汉堡菜单**：大小 0.6–2.5×、音效、音量、用量模式、峰谷文案风格、气泡开关、每轮消耗提示与自动关闭秒数、避让滚动条，浮层下还有「跟随延迟」。
- **会话自启**：打开 ZCode（新会话）时自动拉起，不用手动开。
- **随窗口联动**：ZCode 移动/缩放时跟着走，最小化或被别的应用盖住时隐藏，ZCode 退出时一起退出。

---

## v1.1.0 新增：多厂商计费与 ZCode 深度集成

- **多厂商计价**：按模型/供应商自动识别 DeepSeek（峰谷价）与 GLM（平价，按输入 32K / 输出 0.2K 分档，价目取自 docs.bigmodel.cn 2026-09-29 版）；识别不出或无价目的供应商只统计 tokens，不虚报金额。每轮消耗按 `model_usage` **逐模型行**聚合计价。
- **ZCode Plan 配额（零密钥）**：尾随客户端日志读取套餐余额（剩余 tokens、百分比、到期时间），套餐扣费的轮次气泡显示「本轮 tokens · 占当前配额 Y%」。
- **厂商模板**：`node lib/cli.mjs vendors` 或 `/whale/vendors.json` 查看 7 家模板状态（DeepSeek / ZCode Plan / GLM 按量 / OpenRouter / Kimi 国内国际 / 智谱 Coding Plan 配额窗口）。凭据自动发现自 `v2/provider_config.json` 与 `cli/config.json`（本地网关自动跳过、密钥不复制进挂件配置），也可在 `~/.zcode/whale/config.json` 的 `vendorKeys` 手动填写。
- **用量记录**：菜单「用量记录」打开面板——今日金额与模型占比条、近 7 天逐日、最近 50 条明细。
- **预警**：菜单三阈值（0 关闭）——Plan 剩余%、DeepSeek 余额¥、GLM 按量今日¥；每日一次去重，恢复后自动重新武装。
- **余额校正与充值检测**：余额上升不冲减消费并提示「待核对余额调整」；菜单「余额校正」按「当日起点 + 累计到账 − 非调用扣减 − 当前余额」重算；换 key 自动分本（旧账归档不混算）。
- **自定义角色**：菜单「角色」可上传本地图片（png/gif/jpeg ≤3MB）或切换形象，「恢复默认」随时回退。
- **主题**：菜单「主题」切换浅色（原版蓝系）/ 深色（取自 ZCode 客户端 zai-dark 的实测配色 token）。
- **智能切换**：菜单「显示」默认「自动跟随」——轮询输入框当前供应商选择（选定当下即更新，无需发起对话），气泡口径随之切换为 Plan 配额 / GLM 金额 / DeepSeek 今日已用。
- **新增路由**：`/whale/plan.json`、`/whale/session.json`、`/whale/usage-records.json`、`/whale/vendors.json`、`/whale/roles.json`、`/whale/role-upload.json`、`/whale/balance-adjustments.json`。

---

## 两种显示方式

### 1. 桌面浮层（推荐）

一个独立的 Electron 窗口：透明、无边框、不进任务栏、始终置顶，**覆盖 ZCode 窗口范围但默认鼠标穿透**——只有指针压到鲸鱼、气泡或菜单上时才接管鼠标，其余位置的点击照常落到下面的 ZCode。

### 2. 网页版（零依赖）

挂件服务本身就是个本地网页，浏览器打开地址即可看到同一只鲸鱼：

```
                                    ╭──────────────────────╮
                                    │    DeepSeek 余额     │
                                    │      ¥ 3.85          │
                                  Ⓐ│   今日已用 ¥ 0.09    │
                                    ╰───────────────╮──────╯
                                              ○     ○
                                            🐳  （鲸鱼本体）
```

两种方式共用同一个服务与同一份挂件代码；浮层只是多了一个承载窗口。

---

## 安装

### 前置条件

- ZCode 客户端（插件系统）
- Node.js（用于运行插件自带的脚本）——ZCode 通常已自带，命令行里 `node -v` 能跑即可
- Windows（桌面浮层依赖 Win32 窗口 API；网页版跨平台）

### 步骤

1. **把仓库克隆到一个固定位置**（不要放在会被清理的临时目录）：

   ```bash
   git clone https://github.com/nb10yyds/zcode-whale-widget.git ~/.zcode/plugins/zcode-whale-widget
   ```

   后面的命令都假设你在仓库根目录下执行。

2. **注册为本地插件市场**，二选一：

   **方式 A：客户端界面**
   设置 → 插件管理 → **发现** → 右上角 `+` → 选择**本地目录**，指向仓库根目录（内含 `marketplace.json`）。

   **方式 B：手工写配置**
   在 `~/.zcode/cli/plugins/known_marketplaces.json` 的 `marketplaces` 数组里追加：

   ```json
   {
     "id": "zcode-whale-local",
     "source": { "source": "directory", "path": "<仓库绝对路径>" },
     "name": "zcode-whale-local",
     "description": "Local marketplace for the ZCode DeepSeek balance whale widget.",
     "pluginCount": 1
   }
   ```

   > 想把这份插件分享给别人从 GitHub 安装，把 `source` 换成仓库形式即可：
   > `"source": { "source": "github", "repo": "nb10yyds/zcode-whale-widget" }`

3. **安装并启用插件**：在插件管理里安装 `zcode-whale-widget`。手工方式则在 `~/.zcode/cli/config.json` 里写：

   ```json
   {
     "plugins": {
       "enabledPlugins": {
         "zcode-whale-widget@zcode-whale-local": true
       }
     }
   }
   ```

4. **重启会话**（或重开 ZCode），让 MCP 服务与 hook 生效。

5. **想用桌面浮层的话，再装一次它的运行时**（约 150MB，一次性；只装到数据目录，不进仓库）：

   ```bash
   node lib/cli.mjs desktop install
   ```

装好后打开 ZCode，鲸鱼会自己出现。

---

## 首次配置

### API Key（通常不用配）

余额接口需要一个 DeepSeek API Key。按以下顺序自动查找，**大多数情况第一条或第三条就能命中，无需配置**：

1. 环境变量 `DEEPSEEK_API_KEY`
2. 插件配置 `~/.zcode/whale/config.json` 的 `apiKey`
3. **ZCode 客户端里已配置的 DeepSeek provider**（`baseURL` 指向 `api.deepseek.com` 的那一项）

写入方式（任选其一）：

```bash
node lib/cli.mjs key sk-xxxxxxxxxxxxxxxx     # 写进插件配置
```

或让 ZCode 里的模型直接调 MCP 工具 `whale_config`（`action=set`, `apiKey=...`）。

密钥只在本机内存中使用，只发往 `api.deepseek.com` / `platform.deepseek.com`，不写日志、不打印明文（对外只显示 `sk-04…994` 这样的掩码）。

### 关掉不想要的自动化

`~/.zcode/whale/config.json`：

| 字段 | 默认 | 作用 |
|---|---|---|
| `autoStartWidget` | `true` | 会话启动时自动拉起挂件服务 |
| `autoStartOverlay` | `true` | 会话启动时顺便拉起桌面浮层 |
| `followIntervalMs` | `40` | 跟随探测间隔（毫秒），菜单里的选择会覆盖它 |
| `port` | 自动（39321） | 固定端口，被占用时自动顺延 |

改完重启会话生效。

---

## 使用指南

### 打开 ZCode 就自动出现

插件自带 SessionStart hook，**每次会话启动都会幂等拉起**（已在跑就复用，不会重复开）。确认方法：

```bash
cat ~/.zcode/whale/autostart.log      # 每次启动追加一行，如 server=started overlay=reused
```

> SessionStart 是在**会话启动**时触发的。正常情况下打开 ZCode 会恢复/创建会话，所以碰不到边界情况。

### 命令行

```bash
node lib/cli.mjs status          # 余额 + 今日已用 + 挂件服务与桌面浮层状态
node lib/cli.mjs turn            # 上一轮对话消耗（含逐档明细）
node lib/cli.mjs start / stop    # 启停网页版挂件服务
node lib/cli.mjs window start    # 启动桌面浮层（浮在 ZCode 界面上）
node lib/cli.mjs window stop     # 关闭浮层
node lib/cli.mjs window status   # 浮层与运行时状态
node lib/cli.mjs desktop install # 安装 Electron 运行时（仅浮层需要，一次性）
node lib/cli.mjs key sk-...      # 写入 API Key
node lib/cli.mjs mode ledger|token  # 切换用量统计模式
node lib/cli.mjs json            # 结构化输出，便于脚本消费
```

### 在对话里直接用

- 输入 `/whale`（或 `/whale turn`、`/whale window start`、`/whale key sk-...`）
- 或者直接问「我还有多少余额」「上一轮花了多少」，ZCode 会调用 MCP 工具：

| MCP 工具 | 作用 |
|---|---|
| `whale_balance` | 余额、今日已用、当前峰谷时段 |
| `whale_last_turn` | 上一轮消耗金额与逐档明细 |
| `whale_widget` | `start` / `stop` / `status` / `url`，以及浮层的 `overlay_start` / `overlay_stop` / `overlay_status` |
| `whale_config` | 查看或修改配置（API Key、用量模式、端口、自启、跟随间隔） |

### 挂件菜单

悬停鲸鱼 → 右上角出现三点按钮 → 点击打开菜单：

| 项 | 说明 |
|---|---|
| 大小 | 0.6–2.5×，滑块或数字（1–20） |
| 音效 / 音量 | 小黄鸭或音效1；音量 0 即静音 |
| 用量 | 小鲸鱼记账 / 实时·令牌 |
| 峰谷 | 台词里峰谷文案的风格（默认 / 梁文峰谷 / !?强强?!） |
| 气泡 | 是否允许自动弹出气泡 |
| 每轮消耗提示 | 是否在每轮结束后弹消耗气泡；自动关闭秒数（0 = 手动关） |
| 避让滚动条 | 让挂件右侧避开滚动条的像素宽度（默认关） |
| 跟随延迟 | **仅浮层**：探测 ZCode 窗口位置的间隔，16–250ms |

### 浮层里的交互要点

- 鲸鱼可以拖到窗口内任意位置，靠边会吸附，贴左缘时整体左右镜像。
- **指针要先落在鲸鱼上，点击才会被浮层接管**——这是穿透设计的必然代价，好处是不会误触。
- 菜单里的数字输入框建议用上下箭头或滑块，因为透明浮层窗口默认不抢键盘焦点。

---

## 跟随延迟与性能

浮层跟随靠一个常驻探测脚本（`desktop/follow-window.ps1`）读 ZCode 主窗口的位置、大小与前台状态。**默认 40ms 探测一次**，实测端到端跟随延迟约 **13ms**——拖窗口时鲸鱼基本是贴着走的。

之所以能一边跑得勤、一边几乎不吃 CPU，是两点设计：

- **探测循环编译成 C# 运行**（脚本内联 `Add-Type`），不是解释执行的 PowerShell 循环。同样 40ms 间隔，解释执行的循环体本身就吃掉约 3.4% 单核，编译后只剩 **0.16%**。
- **贵的操作单独限频**：枚举进程（`GetProcessesByName`）用来定位窗口句柄与进程列表，按 3 秒预算刷新；每个探测周期只做几个微秒级的 Win32 调用，且**只有状态真的变化才输出**。

实测对照：

| 探测间隔 | 端到端跟随延迟 | 探测进程 CPU（单核占比） |
|---|---|---|
| 40ms（默认） | 13ms | 0.16%（稳态） |
| 250ms | 135ms | 探测次数少 6 倍，只会更低 |

也就是说间隔调小几乎没有性能代价。菜单里改即时生效，不用重启浮层。

---

## 数据与计价口径

### 今日已用

- **小鲸鱼记账**：靠"观测到的余额下降"累计，服务未运行期间产生的消耗会漏记（从下次观测的新基准开始）。不需要额外令牌。
- **实时·令牌**：需要 `DEEPSEEK_PLATFORM_TOKEN`（平台会话令牌，不是 API Key）。令牌会过期，过期后自动回落记账模式。

### 每轮消耗

按 ZCode 记录的 token 分档计价：**缓存命中**走「命中」价、**未命中输入**与**缓存写入**走「未命中」价、**输出与思考**走「输出」价，再按该轮所处时段选高峰或谷价。

> **一个必须注意的口径**：ZCode 记录的 `input_tokens` 是**含缓存的总输入**（实测 `computed_total_tokens = input + output` 且 `input ≥ cache_read`）。计价前必须减掉命中部分，否则缓存那 99% 会被按未命中价重复计费——实测同一轮会从 ¥3.05 虚高到 ¥76.95（约 25 倍）。代码用 `lib/pricing.mjs` 的 `splitInputTokens()` 统一处理，并用总量字段自动识别 Anthropic 那种「input 不含缓存」的口径。`tools/selftest.mjs` 里有针对两种口径的回归断言。

想核对每一分钱，用 `node lib/cli.mjs turn`，它会逐档列出：

```
上一轮对话消耗   ¥ 1.33
模型             deepseek-flash
计价时段         空闲（base 价目）
缓存命中输入     22,637,312 tokens × ¥0.05/M = ¥1.1319
未命中输入       12,049 tokens × ¥1.5/M = ¥0.0181
输出             40,034 tokens × ¥4.5/M = ¥0.1802
```

### 改价目

DeepSeek 调价时改 `lib/pricing.mjs` 顶部的 `PEAK_HOURS` / `BASE_PRICE` / `PRO_PRICE`。`deepseek-v4-pro` 走 3 倍价，其余（含 `deepseek-flash`）走基础价。

---

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 界面上看不到挂件 | ZCode 客户端不提供界面注入点，必须走桌面浮层：`desktop install` 装运行时，再 `window start` |
| 打开 ZCode 没有自动出现 | 看 `~/.zcode/whale/autostart.log` 最后一行。没有新行说明 hook 没加载（插件未启用，或改完配置后没重启会话）；`overlay=skipped:no-runtime` 说明运行时没装；`overlay=failed:...` 看括号里的原因 |
| 余额显示「未找到 DeepSeek API Key」 | 三条凭据来源都没命中。用 `key` 子命令写入，或在 ZCode 里加 DeepSeek provider |
| 余额显示旧值并带 `stale` | 接口瞬时失败（网络/5xx），服务在回退缓存；4xx 不会回退，会直接报错 |
| 今日已用一直是 0 | 记账模式只统计观测到的余额下降：还没产生消费，或消耗发生在服务未运行时。要精确数字改用 `mode token` |
| 每轮消耗不弹窗 | 需要 ZCode 至少完成过一轮对话（`turn_usage` 有 `completed` 行）；另外菜单里「每轮消耗提示」必须开着 |
| **每轮消耗金额离谱（虚高十几倍）** | 计价口径踩了「input 含缓存」的坑。核对 `splitInputTokens()` 是否被 `costOfUsage()` 使用，并跑 `node tools/selftest.mjs`；用 `cli.mjs turn` 看逐档明细即可判断 |
| 鲸鱼不跟着 ZCode 走 | 探测脚本可能挂了：`window stop` 后 `window start` 重建。开 `WHALE_DEBUG_PORT` 启动会把判断依据写进 `~/.zcode/whale/overlay-debug.log` |
| 跟得不跟手 / 想更省资源 | 菜单「跟随延迟」即时切换 16–250ms，或写 `config.json` 的 `followIntervalMs` |
| 浮层里点不动鲸鱼 | 指针要先落在鲸鱼上（光标变 `grab`、右上角出现菜单按钮）；若整块区域都点不动，检查是否被其它置顶窗口压住 |
| 浮层启动失败 | `cli.mjs window status` 看运行时是否已装 |
| 峰谷判定不对 | 看 `lib/pricing.mjs` 的 `PEAK_HOURS` 等常量；工作日高峰为北京时间 9–12、14–18，2026-08-23 起周末全天谷价 |
| 换了图片/音效不生效 | 资产路由每次读盘且 `no-store`，强刷即可；确认替换的是 `assets/` 下的同名文件 |
| Plan 剩余配额不显示 / 提示「Plan 日志未找到」 | 多半是数据目录迁移后的机器在**普通终端**里手动跑服务：没有 `ZCODE_DATA_BASE_DIR`，只会在 `~/.zcode/v2/logs` 下找日志（旧目录可能只剩迁移前的残留）。由 ZCode 进程拉起的服务不受影响；终端调试请先设置该变量。`/whale/plan.json` 的 `no-plan-log` 响应带 `probedDirs`（实际探测了哪些目录、各目录最新日志是哪天），照着看即可 |

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
zcode-whale-widget/
├─ .zcode-plugin/plugin.json   插件清单：commands / skills / hooks / mcpServers
├─ marketplace.json            本地市场声明，便于在客户端添加
├─ hooks/hooks.json            SessionStart 自启
├─ commands/whale.md           /whale 命令
├─ skills/zcode-whale-widget/  使用与排查说明（供 ZCode 内的助手阅读）
├─ desktop/                    桌面浮层
│  ├─ main.cjs                 Electron 主进程：透明置顶窗口、穿透切换、视口转发
│  ├─ preload.cjs              向页面暴露 setInteractive / onViewport / 跟随间隔
│  └─ follow-window.ps1        常驻探测 ZCode 窗口位置与前台状态（C# 内核）
├─ lib/
│  ├─ server.mjs               本地 HTTP 服务：页面、图片、音效、全部 JSON 接口
│  ├─ widget.js                前端挂件：拖拽/吸附/翻转/菜单/气泡/音效/穿透
│  ├─ balance.mjs              余额、记账账本、平台用量、缓存与回退
│  ├─ turn-cost.mjs            每轮消耗（读 turn_usage，回退模型 I/O 日志）
│  ├─ pricing.mjs              峰谷时段判定 + token→金额（含输入口径拆分）
│  ├─ credentials.mjs          凭据发现 + 出站主机白名单校验
│  ├─ service.mjs              挂件服务的发现/拉起/关闭
│  ├─ overlay.mjs              浮层的启停与 Electron 运行时按需安装
│  ├─ autostart.mjs            SessionStart 自启入口
│  ├─ cli.mjs                  命令行入口
│  └─ mcp-server.mjs           MCP 工具
├─ tools/                      自检、演示与排查脚本
└─ assets/                     鲸鱼形象、rua 动图、两套音效（来自上游）
```

### 运行时数据

都在 `~/.zcode/whale/`，与仓库完全分离：

| 文件 | 内容 |
|---|---|
| `config.json` | API Key、平台令牌、端口、自启开关、跟随间隔 |
| `widget-state.json` | 挂件外观与菜单开关（大小、音效、气泡…） |
| `usage-ledger.json` | 记账模式的账本（含最近 30 天归档） |
| `server.json` | 挂件服务运行信息（pid / 端口 / 关闭令牌） |
| `overlay.json` | 浮层进程 pid |
| `autostart.log` | 每次会话启动的自启结果 |
| `desktop-runtime/` | Electron 运行时（约 370MB，删掉即回收，浮层随之失效） |

服务接口（排查时可直接 curl）：`/whale/health`、`/whale/balance.json`、`/whale/last-turn.json`、`/whale/size.json`（GET/PUT）、`/whale/image.png`、`/whale/rua.gif`、`/whale/sound/press.mp3?set=duck|fx1`、`/whale/widget.js`。

---

## 安全说明

- **出站白名单**：只向 `api.deepseek.com`、`platform.deepseek.com` 发请求；发请求前校验协议、主机名，拒绝环回/私有/保留地址的字面量 IP。要扩展目标需改 `lib/credentials.mjs` 的 `ALLOWED_HOSTS`。
- **本地服务**：只监听 `127.0.0.1`；校验 `Host` 头防 DNS rebinding；写操作校验 `Origin` 防跨站伪造；停止服务需要 `server.json` 里的随机令牌；不返回通配 CORS 头。
- **浮层**：只加载本机 `127.0.0.1` 的页面，运行在 `contextIsolation` 下，仅通过 preload 暴露 `setInteractive` / `setViewport` / `quit` / 跟随间隔几个能力，页面没有 Node 权限。
- **凭据**：API Key 只在内存中使用，不落日志、不打印明文。
- 排查用的远程调试端口默认关闭，只有显式设置 `WHALE_DEBUG_PORT` 才打开。

---

## 已知限制

- 浮层仅支持 **Windows**（依赖 Win32 窗口 API 与 PowerShell）；网页版跨平台。
- 浮层跟随靠轮询，拖动时理论上存在约一个探测间隔的滞后（默认 40ms，实测 13ms，肉眼几乎看不出）。
- 浮层里**吸附没有滑动动画**（位置直接就位）。这是为了避开透明窗口的合成层错位——详见下面「踩坑记录」；网页版动画完整。
- 浮层穿透的必然代价：点击某个位置前，指针得先落在鲸鱼上。
- 菜单里的数字输入框在浮层里建议用箭头/滑块，因为透明浮层窗口默认不抢键盘焦点。
- 菜单默认弹在鲸鱼头顶；鲸鱼被拖到窗口顶部、上方放不下时会翻到按钮下方（两种模式都一样）。
- 每轮消耗只统计 ZCode 自己记录的主对话轮次；ZCode 之外调用的 API 不计入。

### 踩坑记录（写给后来改这份代码的人）

1. **透明窗口不能靠 `setBounds` 贴合别的窗口**。一改尺寸/位置，Windows 合成层不重排，页面内容会被画到偏离窗口的地方（实测页面 `(0,0)` 的方块跑到窗口外）。现在的做法是窗口恒定铺满工作区，把 ZCode 窗口矩形作为「视口」发给页面。
2. **浮层模式下必须禁用定位 CSS 过渡**（`.zcwv-root.zcwv-overlay{transition:none}`）。对 `left/top` 做过渡同样会触发合成层错位。
3. **不要给浮层设 owner 窗口关系**。系统会在 Electron 背后直接显示/隐藏窗口，`BrowserWindow.isVisible()` 与实际状态脱节，恢复后不再显示。
4. **`resizable:false` 会锁死窗口尺寸**（Electron 把 min/max 设成创建时大小），之后任何改尺寸的调用都被拒。
5. **位置记忆必须在拿到真实坐标系之后再恢复**，否则会按屏幕尺寸算出错误锚点。
6. **`desktop/follow-window.ps1` 必须保持纯 ASCII**。Windows PowerShell 5.1 按系统 ANSI 代码页读取无 BOM 的 `.ps1`，中文注释会被解码成破坏语法的字节，脚本直接退出、跟随失效。
7. **`$ErrorActionPreference='SilentlyContinue'` 会吞掉 `Add-Type` 的编译错误**，表现成"脚本秒退、浮层跟着退出"。该脚本已改为显式输出编译/运行错误。
8. **C# 内联代码只能用 .NET Framework 的 API**（PS 5.1 的编译目标），例如 `Environment.TickCount64` 不存在，要用 `TickCount`。
9. **浮层里有两套坐标系，不能混用**。`viewport()` 返回的是 ZCode 窗口矩形（鲸鱼的位置、吸附、居中都按它算），而 `position:fixed` 的元素（挂在 `body` 上的挂件菜单）参照的是页面自身视口，也就是铺满整个工作区的浮层窗口。窗口化 ZCode 时两者差着几百像素，拿 `viewport()` 去算 `position:fixed` 的偏移会把菜单整个甩到屏幕外（实测菜单被算到 x=2812，而浮层只有 2560 宽）。这类 fixed 元素一律用 `pageViewport()`。
10. **挂在 `body` 上的 fixed 元素不会跟着 root 走**。浮层里 ZCode 窗口一移动，鲸鱼跟着动、菜单留在原地，所以 `settle()` 里每次都带一次 `positionMenu()`。

---

## 许可与致谢

本仓库以 **MIT** 许可发布，见 [`LICENSE`](./LICENSE)。

鲸鱼形象、rua 动图、音效，以及挂件的整体视觉与交互设计来自
**[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)**（Copyright (c) 2026 MeteorNOX，MIT）。
本项目是它在 ZCode 上的移植版，沿用与新增的部分逐条列在 [`NOTICE`](./NOTICE) 里。如果喜欢这只鲸鱼，请去给上游点个 star。
