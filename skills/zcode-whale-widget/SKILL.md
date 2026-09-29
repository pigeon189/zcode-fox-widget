---
name: zcode-whale-widget
description: 操作与排查 ZCode 版 DeepSeek 余额小鲸鱼挂件。适用于：查询 DeepSeek 账户余额、今日已用金额、当前峰谷时段或上一轮对话消耗；启动/停止鲸鱼挂件，把鲸鱼作为桌面浮层显示在 ZCode 界面之上（安装 Electron 运行时、浮层点不动或不显示、浮层关闭）；配置 DeepSeek API Key、用量统计模式（小鲸鱼记账 / 实时·令牌）、挂件端口或会话自启；以及界面看不到挂件、余额获取失败、今日已用为 0、每轮消耗不弹窗、峰谷判定不对等问题。
---

# ZCode 版 DeepSeek 余额小鲸鱼挂件

把 DSH 版网页挂件（[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，MIT）移植到 ZCode：同一只鲸鱼、同一套交互，换成 ZCode 能提供的扩展点。

## 架构（先读这段再动手排查）

| 组件 | 文件 | 职责 |
|---|---|---|
| 挂件服务 | `lib/server.mjs` | 本地 HTTP 服务（默认 `127.0.0.1:39321`），提供页面、图片、音效、全部 JSON 接口 |
| 前端挂件 | `lib/widget.js` | 原生 JS，拖拽/吸附/翻转/Q 弹/菜单/气泡/音效/数字滚动，以及浮层穿透切换 |
| 桌面浮层 | `desktop/main.cjs`、`desktop/preload.cjs` | 透明置顶无边框窗口承载挂件页面，默认鼠标穿透，只加载本机 127.0.0.1 |
| 浮层管理 | `lib/overlay.mjs` | 浮层单例检查、启停，以及 Electron 运行时的按需安装 |
| 余额与账本 | `lib/balance.mjs` | 拉余额、记账模式累计、平台用量换算、25 秒缓存与瞬时失败回退 |
| 定价 | `lib/pricing.mjs` | 峰谷时段判定与 token→金额换算（改价目只改这里） |
| 每轮消耗 | `lib/turn-cost.mjs` | 读 ZCode 的 `turn_usage` 表，换算每轮金额 |
| 凭据与出站校验 | `lib/credentials.mjs` | 找 API Key、出站主机白名单校验 |
| MCP 工具 | `lib/mcp-server.mjs` | 会话内查询余额/启停挂件与浮层/改配置 |
| 命令行 | `lib/cli.mjs` | `status` / `turn` / `start` / `stop` / `window` / `desktop install` / `key` / `mode` / `json` |
| 会话自启 | `lib/autostart.mjs` | SessionStart hook 幂等拉起服务（以及已装运行时的浮层） |

上游是「宿主插件 + 注入进 DSH 网页的脚本」。**ZCode 客户端不提供界面注入点**（插件清单里没有 view/panel/webview 之类字段），所以挂件有两种呈现方式，排查时先确认用户指的是哪一种：

1. **桌面浮层**：独立的 Electron 透明置顶窗口，覆盖整个工作区但默认鼠标穿透，指针压到鲸鱼/气泡/菜单时才接管鼠标。这是「浮在 ZCode 界面上」的实现方式。
2. **网页版**：浏览器打开 `http://127.0.0.1:<port>/`，零依赖。

两者共用同一个挂件服务与同一个 `lib/widget.js`；`widget.js` 通过 preload 暴露的 `window.whaleDesktop` 判断自己是否跑在浮层里，跑在普通浏览器里时这段逻辑自动失效。

## 数据从哪来

- **余额**：`GET https://api.deepseek.com/user/balance`，从 `balance_infos` 里优先选 CNY 且大于 0 的项（多币种数组顺序不固定，不能取 `[0]`）。
- **今日已用（小鲸鱼记账，默认）**：每次观测余额，余额下降的差值累加进账本（`~/.zcode/whale/usage-ledger.json`）。币种切换只重置基准不记差值；跨天归档保留 30 天。**不需要额外令牌，但 ZCode 关闭期间的消耗会漏记**。
- **今日已用（实时·令牌）**：需要 `DEEPSEEK_PLATFORM_TOKEN`，调平台用量接口拿 token 分桶，按峰谷定价自行换算（该接口不返回金额）。令牌缺失或失效会自动回落记账模式并在界面上标注。
- **每轮对话消耗**：读 ZCode 自己的会话库 `~/.zcode/cli/db/db.sqlite` 的 `turn_usage` 表（上游监听进程内 `session/event`，ZCode 拿不到该事件流，但落库数据语义等价）。数据库读不到时回退解析 `~/.zcode/cli/rollout/model-io-*.jsonl`。

  **计价口径的坑（改这段代码前务必读）**：ZCode 记录的 `input_tokens` 是**含缓存的总输入**——实测 `computed_total_tokens = input + output` 且 `input ≥ cache_read`（DeepSeek/OpenAI 风格）。计价前必须用 `splitInputTokens()` 减掉命中部分，否则缓存那 99% 会被按未命中价重复计费，实测单轮会从 ¥3.05 虚高到 ¥76.95（约 25 倍）。该函数同时用总量字段自动识别 Anthropic 风格（`input` 不含缓存、`total = input + cacheRead + cacheCreation + output`）。`tools/selftest.mjs` 里有针对这两种口径的回归断言，改动计价逻辑后必须跑一遍。

## 凭据优先级

1. 环境变量 `DEEPSEEK_API_KEY`
2. `~/.zcode/whale/config.json` 的 `apiKey`
3. **ZCode 客户端里已配置的 DeepSeek provider**（`~/.zcode/v2/config.json` 中 `baseURL` 指向 `api.deepseek.com` 的那一项）

第 3 条是 ZCode 版的关键适配：上游从 DSH 凭据服务读 key，ZCode 没有等价服务，但用户通常已经配好了 DeepSeek 接入点，因此可以零配置直接可用。密钥只在内存中使用、只发往白名单主机，不落盘日志、不打印明文（对外只给 `sk-04…994` 这类掩码）。

## 常用操作

优先用 MCP 工具（`whale_balance`、`whale_widget`、`whale_last_turn`、`whale_config`），MCP 不可用时用命令行：

```bash
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" status          # 余额 + 今日已用 + 服务与浮层状态
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" turn            # 上一轮对话消耗
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" start           # 启动挂件服务（返回地址）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" stop            # 停止挂件服务
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" json            # 结构化输出，便于程序消费
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" key sk-xxxx     # 写入 API Key
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" mode token      # 切换用量统计模式
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" window start    # 桌面浮层（浮在 ZCode 界面上）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" window stop     # 关闭浮层
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" desktop install # 安装 Electron 运行时（浮层前置，一次性）
```

服务接口（排查时可直接 curl）：`/whale/health`、`/whale/balance.json`、`/whale/last-turn.json`、`/whale/size.json`（GET/PUT）、`/whale/image.png`、`/whale/rua.gif`、`/whale/sound/press.mp3?set=duck|fx1`、`/whale/widget.js`。

## 配置字段（`~/.zcode/whale/config.json`）

| 字段 | 含义 |
|---|---|
| `apiKey` | DeepSeek API Key |
| `platformToken` | 平台会话令牌（实时·令牌模式用） |
| `usageMode` | `ledger`（默认）或 `token`，仅作为挂件状态未初始化时的初值 |
| `port` | 固定端口，留空则用默认 39321，占用时自动顺延 |
| `autoStartWidget` | 默认 `true`，SessionStart 是否自动拉起服务 |
| `autoStartOverlay` | 默认 `true`，会话启动时是否顺带拉起桌面浮层（Electron 运行时未安装时静默跳过） |
| `followIntervalMs` | 跟随探测间隔（毫秒），默认 40；越小鲸鱼跟得越紧。挂件菜单里的「跟随延迟」会覆盖它 |

挂件自身的外观与开关（大小、音效、音量、气泡、每轮消耗提示与自动关闭秒数、避让滚动条）在 `~/.zcode/whale/widget-state.json`，由挂件菜单直接写入。

## 故障排查

| 现象 | 原因与动作 |
|---|---|
| **界面上看不到挂件** | 插件无法注入 ZCode 客户端界面，必须走桌面浮层：先 `desktop install` 装运行时，再 `window start`。装好后会话启动会自动拉起 |
| **打开 ZCode 没有自动出现鲸鱼** | 自启由 SessionStart hook（`lib/autostart.mjs`）负责，先看 `~/.zcode/whale/autostart.log` 最后一行：`server=... overlay=...`。没有新行说明 hook 没被加载（插件未启用，或改完配置后还没重启会话）；`overlay=skipped:no-runtime` 说明 Electron 运行时没装（`desktop install`）；`overlay=failed:...` 看括号里的原因。也可以直接 `node lib/autostart.mjs` 手动跑一次验证 |
| **鲸鱼不跟着 ZCode 走** | 跟随由 `desktop/follow-window.ps1` 常驻探测（默认每 40ms 读一次 ZCode 主窗口矩形与前台状态）。完全不动时先确认该 PowerShell 子进程是否还活着（`window stop` 后 `window start` 重建）；跟进脚本的输出与判断依据会写进 `~/.zcode/whale/overlay-debug.log`（仅在 `WHALE_DEBUG_PORT` 开启时记录） |
| 跟得不跟手 / 想更省资源 | 挂件菜单「跟随延迟」可即时切换 16/25/40/60/100/250ms（改完不需重启浮层），也可写进 `config.json` 的 `followIntervalMs`。默认 40ms 实测端到端延迟约 13ms、稳态 CPU 约 0.16% 单核；调大间隔只减少探测次数，收益有限 |
| 探测脚本秒退 / 浮层跟着消失 | 多为 `follow-window.ps1` 里的 C# 编译失败或脚本被写成非 ASCII。`overlay-debug.log` 里搜 `csharp-compile-failed` / `follow-loop-error`；该文件必须保持纯 ASCII（PS 5.1 按 ANSI 代码页读） |
| 鲸鱼位置错乱 / 跑到窗口外 | 透明窗口的合成层错位，通常是有人重新打开了定位过渡或改回 `setBounds` 贴窗口。见 README「与上游的差异」里的两条踩坑记录 |
| 浮层起来了但点不动鲸鱼 | 浮层默认鼠标穿透，指针必须先停在鲸鱼上（此时光标变 `grab`、右上角出现菜单按钮）才能点。若整块区域都点不动，检查是否被其它置顶窗口压住 |
| 浮层里菜单的数字框打不了字 | 透明浮层窗口默认不抢键盘焦点，用上下箭头或滑块调整；或改用网页版直接键入 |
| 浮层启动失败 | `node lib/cli.mjs window status` 看运行时是否已安装；未安装则 `desktop install`。Electron 约 150MB，装到 `~/.zcode/whale/desktop-runtime` |
| 改完 follow-window.ps1 后行为没变 | 该脚本是常驻子进程，改完要 `window stop` + `window start` 才会重新加载 |
| 余额显示「未找到 DeepSeek API Key」 | 三条凭据来源都没有。用 `key` 子命令写入，或在 ZCode 里加 DeepSeek provider |
| 余额显示旧值并带 `stale` | 接口瞬时失败（网络/5xx），服务在回退缓存。4xx 不会回退，会直接报错 |
| 今日已用一直 0 | 记账模式只统计「观测到的余额下降」：还没产生消费，或期间的消耗发生在服务未运行时。要精确数字改用 `mode token` |
| **每轮消耗金额离谱（虚高十几倍）** | 多半是计价口径又踩了「input 含缓存」这个坑：缓存命中的 token 被按未命中价重复算了一遍。核对 `lib/pricing.mjs` 的 `splitInputTokens()` 是否被 `costOfUsage()` 使用，并跑 `node tools/selftest.mjs`（内含两种口径的回归断言）。用 `node lib/cli.mjs turn` 看逐档明细即可判断 |
| 每轮消耗不弹窗 | 需要 ZCode 至少完成过一轮对话（`turn_usage` 有 `completed` 行）；另外菜单里「每轮消耗提示」必须开着 |
| 挂件服务打不开 | `node lib/cli.mjs status` 看是否运行；未运行则 `start`。端口被占用会自动顺延，以 `status` 输出的地址为准 |
| Plan 配额不显示 / 提示「Plan 日志未找到」 | 数据目录迁移后的机器在普通终端手动跑 `node lib/cli.mjs status/vendors` 时没有 `ZCODE_DATA_BASE_DIR`，只会探 `~/.zcode/v2/logs`（可能只剩迁移前残留）。终端调试先 `set ZCODE_DATA_BASE_DIR=<数据盘根目录>`；`/whale/plan.json` 的 `no-plan-log` 带 `probedDirs` 可看实际探测结果 |
| 峰谷判定不对 | 检查 `lib/pricing.mjs` 的 `PEAK_HOURS` / `BASE_PRICE` / `PRO_PRICE`；北京时间工作日上午 9–12、下午 14–18 为高峰，2026-08-23 起周末全天谷价 |
| 换了图片/音效不生效 | 资产路由每次读盘且 `no-store`，浏览器强刷即可；同时确认替换的是 `assets/` 下的同名文件 |

排查浮层联动时有个前提：`desktop/follow-window.ps1` **必须保持纯 ASCII**。Windows PowerShell 5.1 会用系统 ANSI 代码页读取无 BOM 的 .ps1，中文注释会被解码成破坏语法的字节，脚本会直接退出（表现为跟随失效）。

## 出站安全约束

服务端只向白名单主机发请求（`api.deepseek.com`、`platform.deepseek.com`），发请求前校验协议为 http/https、主机名匹配白名单、拒绝环回/私有/保留地址的字面量 IP。改 `lib/credentials.mjs` 的 `ALLOWED_HOSTS` 才能扩展目标。

本地服务本身还有三层防护：只监听 `127.0.0.1`、校验 `Host` 头防 DNS rebinding、写操作校验 `Origin` 防跨站伪造；停止服务需要 `~/.zcode/whale/server.json` 里的随机令牌。

## 想改挂件本身

- 视觉与交互规格（气泡几何、字号档、动画时长、台词组权重）在 `lib/widget.js` 里，与上游逐项对应。
- 台词文案已把指向 DSH 的句子改成 ZCode（`.zcode` 目录、平台令牌说明）。
- 类名前缀是 `zcwv-`、路由前缀是 `/whale/`（上游分别为 `dshwv-` 与 `/dsh-whale/`）；从上游搬代码时注意改这两处，以及 localStorage 键 `zcw-pos`。
