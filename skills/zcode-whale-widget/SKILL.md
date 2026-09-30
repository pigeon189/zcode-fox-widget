---
name: zcode-whale-widget
description: 操作与排查 ZCode 版 DeepSeek 余额小鲸鱼挂件。适用于：查询 DeepSeek 账户余额、今日已用金额、当前峰谷时段或上一轮对话消耗；启动/停止鲸鱼挂件，把鲸鱼作为桌面浮层显示在 ZCode 界面之上（安装 Electron 运行时、浮层点不动或不显示、浮层关闭）；配置 DeepSeek API Key、用量统计模式（小鲸鱼记账 / 实时·令牌）、挂件端口或会话自启；调整主题（浅色/深色/跟随系统）、角色（导入图片、改名、删除）、预警阈值（Plan 剩余% 与余额）、自定义气泡文字；以及界面看不到挂件、余额获取失败、今日已用为 0、每轮消耗不弹窗、峰谷判定不对、和挂件互动后 ZCode 画面卡住等问题。
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

服务接口（排查时可直接 curl）：`/whale/health`、`/whale/balance.json`、`/whale/last-turn.json`、`/whale/size.json`（GET/PUT）、`/whale/session.json`、`/whale/plan.json`、`/whale/usage-records.json`、`/whale/roles.json`、`/whale/role-upload.json`、`/whale/role-rename.json`（POST）、`/whale/role-delete.json`（POST）、`/whale/bubble-content.json`（GET/POST）、`/whale/balance-adjustments.json`（GET/POST）、`/whale/image.png`、`/whale/rua.gif`、`/whale/sound/press.mp3?set=duck|fx1`、`/whale/widget.js`。

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

挂件自身的外观与开关（大小、音效、音量、主题、气泡、每轮消耗提示与自动关闭秒数、避让滚动条、预警阈值、角色选择、显示跟随）在 `~/.zcode/whale/widget-state.json`，由挂件菜单直接写入：
- `theme`：`light` / `dark` / `system`（跟随系统偏好）。
- `alerts`：`planPct`（Plan 剩余% 阈值）与 `moneyAlert`（金额阈值，对所有按金额结算的源生效；旧键 `deepseekBelow` / `bigmodelDaily` 读取时自动迁移）。阈值单位是人民币：余额型源看「低于」，消费型源看「达到」；美元厂商（OpenAI / Claude）的金额按 `¥7.1/$` 近似汇率折算后再比较，文案里同时给出原币与折算值（汇率只用于这一处判断，不参与记账与计价）。每个来源每天只提醒一次，去重键含阈值。
- `roleId`：当前形象（内置 `xiaohuniang` 小狐娘 / `whale` 小鲸鱼，或导入件 id；导入件的索引与图片在 `roles.json` + `roles/`），未指定即小狐娘。
- 自定义气泡文字在 `~/.zcode/whale/bubble-content.json`：`{v, first:{text,size}|null, items:[{text,size}]}`（`size`：B 大字 / A 中字 / C 小字；`first` 留空显示默认余额视图，`items` 留空用内置随机台词）。

## 故障排查

| 现象 | 原因与动作 |
|---|---|
| **界面上看不到挂件** | 插件无法注入 ZCode 客户端界面，必须走桌面浮层：先 `desktop install` 装运行时，再 `window start`。装好后会话启动会自动拉起 |
| **打开 ZCode 没有自动出现鲸鱼** | 自启由 SessionStart hook（`lib/autostart.mjs`）负责，先看 `~/.zcode/whale/autostart.log` 最后一行：`server=... overlay=...`。没有新行说明 hook 没被加载（插件未启用，或改完配置后还没重启会话）；`overlay=skipped:no-runtime` 说明 Electron 运行时没装（`desktop install`）；`overlay=failed:...` 看括号里的原因。也可以直接 `node lib/autostart.mjs` 手动跑一次验证 |
| **鲸鱼不跟着 ZCode 走** | 跟随由 `desktop/follow-window.ps1` 常驻探测（默认每 40ms 读一次 ZCode 主窗口矩形与前台状态）。完全不动时先确认该 PowerShell 子进程是否还活着（`window stop` 后 `window start` 重建）；跟进脚本的输出与判断依据会写进 `~/.zcode/whale/overlay-debug.log`（仅在 `WHALE_DEBUG_PORT` 开启时记录） |
| 跟得不跟手 / 想更省资源 | 挂件菜单「跟随延迟」可即时切换 16/25/40/60/100/250ms（改完不需重启浮层），也可写进 `config.json` 的 `followIntervalMs`。默认 40ms 实测端到端延迟约 13ms、稳态 CPU 约 0.16% 单核；调大间隔只减少探测次数，收益有限 |
| 探测脚本秒退 / 浮层跟着消失 | 多为 `follow-window.ps1` 里的 C# 编译失败或脚本被写成非 ASCII。`overlay-debug.log` 里搜 `csharp-compile-failed` / `follow-loop-error`；该文件必须保持纯 ASCII（PS 5.1 按 ANSI 代码页读） |
| 鲸鱼位置错乱 / 跑到窗口外 | 透明窗口的合成层错位，通常是有人重新打开了定位过渡或改回 `setBounds` 贴窗口。见 README「与上游的差异」里的两条踩坑记录 |
| 挂件画面冻结（鲸鱼在但不动/点了没反应），进程却活着 | v1.3.3 已加自愈：透明置顶窗口被全屏应用覆盖后，Chromium 的原生遮挡计算可能卡死在「被遮挡」而停止出帧（页面逻辑照常跑，画面停在旧帧）。现在已禁用该计算（`disable-features=CalculateNativeWinOcclusion`）、页面加载完成才上屏、重显与每 60 秒强制重送一帧（`kickPresentation`）。等 60 秒自愈，或立刻 `node lib/cli.mjs window restart` 一键重建窗口。**注意**：GDI 截屏（CopyFromScreen/GetPixel）拍不到这个透明窗口的合成表面，诊断画面问题以 CDP 截图和肉眼为准 |
| 浮层起来了但点不动鲸鱼 | 浮层默认鼠标穿透，指针必须先停在鲸鱼上（此时光标变 `grab`、右上角出现菜单按钮）才能点。若整块区域都点不动，检查是否被其它置顶窗口压住 |
| 浮层里菜单的数字框打不了字 | v1.3.0 起指针按到文本框就能打字（浮层在文本类控件上临时接管键盘焦点，离开即交还；v1.3.2 起下拉也换成自定义组件，不再走系统弹窗、不再需要这条路）。还不行就确认浮层版本与插件一致（`window status` 或 `/whale/health` 的 `version`），或改用网页版直接键入 |
| **和挂件互动后 ZCode 画面卡住（点一下 ZCode 才恢复）** | v1.3.0 已修：浮层窗口设为不可激活（Windows `focusable:false` → Electron 带 `WS_EX_NOACTIVATE`），普通交互不再把前台从 ZCode 抢走；ZCode 失去前台会停止刷新自身画面，这就是「卡住」的来源。复查手法：`GetForegroundWindow` 不该是浮层；浮层的 ex-style 应含 `WS_EX_NOACTIVATE`、`WM_MOUSEACTIVATE` 返回 4（MA_NOACTIVATEANDEAT）。改动 `desktop/main.cjs` 的窗口选项后必须 `window stop` + `window start` 才生效 |
| **开着「用量记录」时 ZCode 点不动 / 下拉展开后鲸鱼全点不动** | v1.3.2 已修的两个整窗接管缺陷：用量记录面板打开时曾让浮层整窗吞掉 ZCode 的鼠标（画面像停住，关掉面板才恢复）；原生 `<select>` 的系统下拉弹出期间会模态捕获全屏鼠标、焦点滞留（`WS_EX_NOACTIVATE` 不恢复），表现为点击挂件和菜单完全没响应。现在面板只是普通区域（指针压上才接管，面板外 ZCode 随便用）、下拉全部换成角色下拉同款的自定义列表。若复发，带 `WHALE_DEBUG_PORT` 重启浮层，在面板外查 ex-style 的 `WS_EX_TRANSPARENT` 位是否被错误清掉 |
| 菜单下拉的箭头会「从左边飞到右边」或消失 | v1.3.2 已修：hover 样式用了 `background:` 简写，把手绘箭头的 `background-image/position` 一并清掉，配合 `transition:background` 出现飞动。现在过渡只挂 `background-color`，且下拉整体换成自定义组件（没有原生箭头可飞）。以后给带自绘箭头的控件写 hover，只准用 `background-color` |
| 浮层启动失败 | `node lib/cli.mjs window status` 看运行时是否已安装；未安装则 `desktop install`。Electron 约 150MB，装到 `~/.zcode/whale/desktop-runtime` |
| **ZCode 被别的窗口盖住，鲸鱼却还置顶显示** | v1.3.1 已修：跟随脚本原来靠 `GetProcessesByName("electron")` 认「前台是浮层自己」，任何 Electron 应用在前台都会被误判。现在由 `main.cjs` 传入浮层主进程 pid（`-OverlayPid`），只认这一个进程。改动后要 `window stop` + `window start` 才生效 |
| 改完 follow-window.ps1 后行为没变 | 该脚本是常驻子进程，改完要 `window stop` + `window start` 才会重新加载 |
| 余额显示「未找到 DeepSeek API Key」 | 三条凭据来源都没命中：环境变量 `DEEPSEEK_API_KEY`、`~/.zcode/whale/config.json`、ZCode provider 配置（含数据目录迁移后的 `$ZCODE_DATA_BASE_DIR/.zcode/v2/provider_config.json`，规则没写 baseUrl 时端点从 zcode-builtin 模板继承）。错误文案带探测摘要，逐条明细看 `/whale/health` 的 `keyProbe`（标明本地网关/加密凭据为何被跳过）。也可用 `key` 子命令写入 |
| 切了模型气泡还是旧源 / 一直显示 DeepSeek 余额 | v1.2.0 起主显示随计费源切换（3 秒轮询输入框选择，读不到时回落最近一次真实模型调用）。MiMo 按端点区分：`api.xiaomimimo.com` 计量、`token-plan-cn.xiaomimimo.com` 订阅额度。手动锁定用菜单「显示」 |
| 点击挂件/气泡没声音 | 检查菜单音量是否为 0、音效组是否已选；音频页面加载时预热，输出设备切换后若无声重启浮层。按压/松手音只属于鲸鱼本体；点气泡不出声（随上游原版行为，v1.3.2 起回退） |
| 点设置键却有音效（v1.3.0 起不应出现） | 菜单按钮的 click 里不该有 `playPress()`；按压音只属于角色本体（鲸鱼/气泡）两种操作 |
| 余额显示旧值并带 `stale` | 接口瞬时失败（网络/5xx），服务在回退缓存。4xx 不会回退，会直接报错 |
| 今日已用一直 0 | 记账模式只统计「观测到的余额下降」：还没产生消费，或期间的消耗发生在服务未运行时。要精确数字改用 `mode token` |
| **CLI/MCP 里的每轮消耗金额币种不对** | v1.3.1 起 `cli.mjs` / `mcp-server.mjs` 按轮次和逐行携带的 `currency` 输出（美元轮次显示 `$`）。若还看到人民币符号出现在 OpenAI/Claude 轮次上，说明这两个文本出口又把 `'CNY'` 写死在格式化里了；`tools/selftest.mjs` 里有「美元轮次经 CLI/MCP 路径」的回归断言 |
| **每轮消耗金额离谱（虚高十几倍）** | 多半是计价口径又踩了「input 含缓存」这个坑：缓存命中的 token 被按未命中价重复算了一遍。核对 `lib/pricing.mjs` 的 `splitInputTokens()` 是否被 `costOfUsage()` 使用，并跑 `node tools/selftest.mjs`（内含两种口径的回归断言）。用 `node lib/cli.mjs turn` 看逐档明细即可判断 |
| 每轮消耗不弹窗 | 需要 ZCode 至少完成过一轮对话（`turn_usage` 有 `completed` 行）；另外菜单里「每轮消耗提示」必须开着 |
| **套餐轮（Start plan 等）每轮消耗显示了 ¥ 金额** | v1.4.0 起按「本轮消耗余额: x%」口径（与主显示 Plan 剩余同基数，占配额总量），混合轮次 hint 补「另耗 ¥」；CLI `turn` 同口径。若又看到金额：查 `lib/plan-balance.mjs` 的 `turnPlanUsage()` 是否被 `server.mjs` 的 `pollTurnCost` 调用、`widget.js` 的 `showCostBubble` 是否先判 `planPct` 再判 `billable`。读不到配额观测时按 tokens 口径显示，属预期 |
| **气泡文字顶出色泡** | v1.4.0 起 `widget.js` 的 `fitBubbleLines()` 在每次气泡内容变化后逐行缩字（等比缩放，下限 62%）+ 换行兜底，覆盖余额视图/每轮消耗/预警/自定义台词。宽度测量用 Range（行元素是 block，`scrollWidth` 会被最宽兄弟行撑大导致短行越缩越小）——改这段别换回 `scrollWidth`；安全行宽常数 560u 与 `.zcwv-wrap`/gif 上限同源 |
| **每轮消耗显示旧套餐的残值%（如 2.4%）** | v1.4.2 前的形态：会话高峰期 host-log 刷屏把余额标记挤出 512KB 尾窗 → 今天文件被误判无观测 → 回退读到旧套餐期末残值。修复 = `plan-balance.mjs` 的 `TAIL_STEPS` 逐级扩窗（512KB→4MB→32MB）+ `shapePlanPayload` 只统计 active 套餐名下的桶 + 日期外层循环。若复发先看 `/whale/plan.json` 的 `logDate` |
| **每轮消耗的 % 明显偏小** | v1.4.2 前取「最大单行」；`model_usage` 一行是一次请求，长 agent 轮几十行。`turnPlanUsage()` 必须 `reduce` 全行求和（selftest 有「多行套餐轮求和」断言） |
| **消耗气泡渐隐中内容闪变成余额** | `hideCostBubble()` 设 `costBubbleFadeUntil = now+350ms`，`render()` 在此窗口内只登记补渲染不改写文字。若复发查这两处守卫是否还在 |
| **浮层整窗冻住但点击有响应**（页面活、屏幕停旧帧） | v1.4.2 起自动检测自愈：页面活性点（`#__zcwLive`，黑白翻转）+ `desktop/dxgi-watch.ps1` 桌面复制采样像素哈希，页面在翻而像素 4s 不变即判冻结，阶梯自愈 = 最小化+还原 → 重建窗口。传感器 stdout 是 `pix <hash>` 行，`blind` 开头 = 桌面复制不可用（检测自动失效）；黑匣子看 `freeze-detected` / `freeze-heal` / `watcher-*` 行 |
| 挂件服务打不开 | `node lib/cli.mjs status` 看是否运行；未运行则 `start`。端口被占用会自动顺延，以 `status` 输出的地址为准 |
| Plan 配额不显示 / 提示「Plan 日志未找到」 | 数据目录迁移后的机器在普通终端手动跑 `node lib/cli.mjs status/vendors` 时没有 `ZCODE_DATA_BASE_DIR`，只会探 `~/.zcode/v2/logs`（可能只剩迁移前残留）。终端调试先 `set ZCODE_DATA_BASE_DIR=<数据盘根目录>`；`/whale/plan.json` 的 `no-plan-log` 带 `probedDirs` 可看实际探测结果 |
| 峰谷判定不对 | 检查 `lib/pricing.mjs` 的 `PEAK_HOURS` / `BASE_PRICE` / `PRO_PRICE`；北京时间工作日上午 9–12、下午 14–18 为高峰，2026-08-23 起周末全天谷价 |
| 换了图片/音效不生效 | 资产路由每次读盘且 `no-store`，浏览器强刷即可；同时确认替换的是 `assets/` 下的同名文件 |

排查浮层联动时有个前提：`desktop/follow-window.ps1` **必须保持纯 ASCII**。Windows PowerShell 5.1 会用系统 ANSI 代码页读取无 BOM 的 .ps1，中文注释会被解码成破坏语法的字节，脚本会直接退出（表现为跟随失效）。

## 出站安全约束

服务端只向白名单主机发请求（`api.deepseek.com`、`platform.deepseek.com`），发请求前校验协议为 http/https、主机名匹配白名单、拒绝环回/私有/保留地址的字面量 IP。改 `lib/credentials.mjs` 的 `ALLOWED_HOSTS` 才能扩展目标。

厂商模板（`lib/vendors.mjs` 的 `TEMPLATES`）另有一层：每个带 `url` 的余额/配额段必须**显式声明 `host`**，与 URL 的 hostname 不一致或缺声明就直接拒绝取数。别图省事传 `new URL(section.url).hostname`——那等于让地址自证清白，白名单校验会退化成只查协议与私有 IP。

本地服务本身还有三层防护：只监听 `127.0.0.1`、校验 `Host` 头防 DNS rebinding、写操作校验 `Origin` 防跨站伪造；停止服务需要 `~/.zcode/whale/server.json` 里的随机令牌。

## 想改挂件本身

- 视觉与交互规格（气泡几何、字号档、动画时长、台词组权重）在 `lib/widget.js` 里，与上游逐项对应。
- 台词文案已把指向 DSH 的句子改成 ZCode（`.zcode` 目录、平台令牌说明）。
- 类名前缀是 `zcwv-`、路由前缀是 `/whale/`（上游分别为 `dshwv-` 与 `/dsh-whale/`）；从上游搬代码时注意改这两处，以及 localStorage 键 `zcw-pos`。
