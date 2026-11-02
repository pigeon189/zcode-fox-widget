---
name: zcode-fox-widget
description: 操作与排查 ZCode狐娘小挂件（zcode-fox-widget）。适用于：查询 DeepSeek 账户余额、今日已用金额、当前峰谷时段或上一轮对话消耗；启动/停止挂件，把鲸鱼作为桌面浮层显示在 ZCode 界面之上（安装 Electron 运行时、浮层点不动或不显示、浮层关闭、**桌宠模式**：界面扩展为整个屏幕工作区、可拖出 ZCode 窗口、失焦也不隐身、锁在最上层）；配置 DeepSeek API Key、对账口径（大肥鱼记账 / 实时·令牌）、挂件端口或会话自启；调整主题（浅色/深色/跟随 ZCode）、角色（导入图片、改名、删除，内置形象可隐藏找回）、**角色配色**（每个角色的浅/深两档气泡墨色，内嵌调色板 + HEX/RGB，含「恢复默认」与恢复手段）、音效（导入/删除）、预警阈值（泛化后的「额度%」覆盖 GLM Plan 与 CommandCode + DeepSeek 余额¥）、按压泡泡（自定义点击队列）、**用量记录**（一级菜单入口，v1.8.7 从记账页移回）与**记账二级页**（「=角色名记账=」入口，内含额度/余额预警与余额校正）、**挂件内自动更新**（镜像链检查/下载/替换/备份，跳过某版本，重启挂件生效）、按模型自动换角色（默认开；手动选过形象即自动关闭）、「等确认提醒」（ZCode 弹权限确认时提醒，与按压泡泡设置同一行）、今日排名口径（按金额/按 Token）；以及界面看不到挂件、余额获取失败、CommandCode 三重额度（月度池 + 5 小时/周窗口）读不到、厂商模板余额读不到、今日已用为 0、每轮消耗不弹窗、峰谷判定不对、更新失败 / 镜像不可达 / 版本不符拒装 / 更新后怎么回滚、配色改坏了怎么恢复、和挂件互动后 ZCode 画面卡住、挂件周期性消失重现（冻结自愈误判）等问题。
---

# ZCode狐娘小挂件（zcode-fox-widget）

把 DSH 版网页挂件（[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，MIT）移植到 ZCode，并在移植版基础上持续开发（署名链见 NOTICE）：同一套交互，换成 ZCode 能提供的扩展点。

## 架构（先读这段再动手排查）

| 组件 | 文件 | 职责 |
|---|---|---|
| 挂件服务 | `lib/server.mjs` | 本地 HTTP 服务（默认 `127.0.0.1:39321`），提供页面、图片、音效、全部 JSON 接口 |
| 前端挂件 | `lib/widget.js` | 原生 JS，拖拽/吸附/翻转/Q 弹/菜单/气泡/音效/数字滚动，以及浮层穿透切换 |
| 桌面浮层 | `desktop/main.cjs`、`desktop/preload.cjs` | 透明置顶无边框窗口承载挂件页面，默认鼠标穿透，只加载本机 127.0.0.1 |
| 浮层管理 | `lib/overlay.mjs` | 浮层单例检查、启停，以及 Electron 运行时的按需安装 |
| 余额与账本 | `lib/balance.mjs` | 拉余额、记账模式累计、平台用量换算、25 秒缓存与瞬时失败回退 |
| 厂商配额 | `lib/vendors.mjs`、`lib/volc-plan.mjs` | 厂商余额/配额模板框架（46 个模板）；火山方舟 Coding / Agent Plan 订阅窗口（V4 签名，45s TTL + in-flight 单飞） |
| 定价 | `lib/pricing.mjs` | 峰谷时段判定与 token→金额换算（改价目只改这里） |
| 每轮消耗 | `lib/turn-cost.mjs` | 读 ZCode 的 `turn_usage` 表，换算每轮金额 |
| 凭据与出站校验 | `lib/credentials.mjs` | 找 API Key、出站主机白名单校验 |
| MCP 工具 | `lib/mcp-server.mjs` | 会话内查询余额/启停挂件与浮层/改配置 |
| 命令行 | `lib/cli.mjs` | `status` / `turn` / `start` / `stop` / `window` / `desktop install` / `key` / `mode` / `json` |
| 会话自启 | `lib/autostart.mjs` | SessionStart hook 幂等拉起服务（以及已装运行时的浮层） |

上游是「宿主插件 + 注入进 DSH 网页的脚本」。**ZCode 客户端不提供界面注入点**（插件清单里没有 view/panel/webview 之类字段），所以挂件自己开窗口呈现。主形态只有一种，排查时先确认用户问的是哪一层：

1. **桌面浮层**（主形态，README 推荐）：独立的 Electron 透明置顶窗口，覆盖整个工作区但默认鼠标穿透，指针压到鲸鱼/气泡/菜单时才接管鼠标。这是「浮在 ZCode 界面上」的实现方式。**用户说「挂件」默认指它。**
2. **本地页面**（备用 / 排障入口）：浏览器打开 `http://127.0.0.1:<port>/`，零依赖。它不是第二套实现——浮层加载的正是这个地址，同一份 `lib/widget.js`、同一份配置。只在两种情况下需要主动用它：排障（例如浮层里输入框打不了字，用它区分页面逻辑问题与浮层窗口层问题），或非 Windows（浮层依赖 Win32 窗口 API，macOS / Linux 只有这个形态）。

两者共用同一个挂件服务；`widget.js` 通过 preload 暴露的 `window.whaleDesktop` 判断自己是否跑在浮层里，跑在普通浏览器里时这段逻辑自动失效。

## 数据从哪来

- **余额**：`GET https://api.deepseek.com/user/balance`，从 `balance_infos` 里优先选 CNY 且大于 0 的项（多币种数组顺序不固定，不能取 `[0]`）。
- **今日已用（主口径 = 本机库，v1.7.0 起）**：读 ZCode 落库的模型用量按价目折算（`lib/usage-records.mjs` 的 `todayVendorUsage()`，与用量面板同一次聚合），按模型看得见、不受充值干扰；套餐/网关行按配额或 tokens 表达。**大肥鱼记账**（每次观测余额，余额下降的差值累加进 `~/.zcode/whale/usage-ledger.json`，跨天归档保留 30 天，免令牌但 ZCode 关闭期间会漏记）与**实时·令牌**退居「对账 + 兜底」：两口径数字不一致时并排展示（气泡小字 / 面板「对账（DeepSeek）」行），本机库当天无记录时兜底为主显示并标注来源。
- **实时·令牌（对账 + 兜底口径之一）**：需要 `DEEPSEEK_PLATFORM_TOKEN`，调平台用量接口拿 token 分桶，按峰谷定价自行换算（该接口不返回金额）。令牌缺失或失效会自动回落记账口径并在界面上标注。
- **每轮对话消耗**：读 ZCode 自己的会话库 `~/.zcode/cli/db/db.sqlite` 的 `turn_usage` 表（上游监听进程内 `session/event`，ZCode 拿不到该事件流，但落库数据语义等价）。数据库读不到时回退解析 `~/.zcode/cli/rollout/model-io-*.jsonl`。
- **火山方舟**：按 provider 的有效 Base URL 区分 API、Coding Plan 与 Agent Plan；菜单只保留“火山方舟”。两种 Plan 分别查询并缓存，API 保留本机用量估算；显示偏好和配额查询结果不参与计费分类。

  **计价口径的坑（改这段代码前务必读）**：ZCode 记录的 `input_tokens` 是**含缓存的总输入**——实测 `computed_total_tokens = input + output` 且 `input ≥ cache_read`（DeepSeek/OpenAI 风格）。计价前必须用 `splitInputTokens()` 减掉命中部分，否则缓存那 99% 会被按未命中价重复计费，实测单轮会从 ¥3.05 虚高到 ¥76.95（约 25 倍）。该函数同时用总量字段自动识别 Anthropic 风格（`input` 不含缓存、`total = input + cacheRead + cacheCreation + output`）。`tools/selftest.mjs` 里有针对这两种口径的回归断言，改动计价逻辑后必须跑一遍。

## 凭据优先级

1. 环境变量 `DEEPSEEK_API_KEY`
2. `~/.zcode/whale/config.json` 的 `apiKey`
3. **ZCode 客户端里已配置的 DeepSeek provider**（`~/.zcode/v2/config.json` 中 `baseURL` 指向 `api.deepseek.com` 的那一项）

第 3 条是 ZCode 版的关键适配：上游从 DSH 凭据服务读 key，ZCode 没有等价服务，但用户通常已经配好了 DeepSeek 接入点，因此可以零配置直接可用。密钥只在内存中使用、只发往白名单主机，不落盘日志、不打印明文（对外只给 `sk-04…994` 这类掩码）。

火山 Plan 配额查询使用**另一套凭据**：查配额必须用 IAM AK/SK（`AKLT…`），模型调用的 `ark-` key 不适用，两套互不通用。读取顺序 = 环境变量（`VOLC_ACCESS_KEY_ID`/`SECRET` 及 `VOLC_ARK_*`、`VOLC_ACCESS_KEY`/`VOLC_SECRET_KEY`、`ARK_ACCESS_KEY_*` 别名，四套各按整套配对，避免 AK/SK 拼错对）> `config.json` 的 `vendorKeys.volc-access-key-id` / `volc-access-key-secret` **双键**（不走其它厂商 `vendorKeys.<模板 id>` 单键模式）。创建路径见 README「首次配置」的火山段。

## 常用操作

优先用 MCP 工具（`whale_balance`、`whale_widget`、`whale_last_turn`、`whale_config`），MCP 不可用时用命令行：

```bash
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" status          # 余额 + 今日已用 + 服务与浮层状态
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" turn            # 上一轮对话消耗
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" start           # 启动挂件服务（返回地址）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" stop            # 停止挂件服务
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" close           # 关闭插件（停浮层 + 停服务；只是本次关闭，下次会话照常自启）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" json            # 结构化输出，便于程序消费
echo 'sk-xxxx' | node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" key   # 写入 API Key（走 stdin，避免留在 shell 历史/进程列表）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" mode token      # 切换对账/兜底口径（v1.7.0 起主显示固定本机库，此项只决定账号口径）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" window start    # 桌面浮层（浮在 ZCode 界面上）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" window stop     # 关闭浮层
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" desktop install # 安装 Electron 运行时（浮层前置，一次性）
```

服务接口（排查时可直接 curl）：`/whale/health`、`/whale/balance.json`、`/whale/last-turn.json`、`/whale/size.json`（GET/PUT）、`/whale/session.json`、`/whale/plan.json`（GLM Plan 配额：`source` = `plan-log` / `glm-plan-api`）、`/whale/cmdgo.json`（CommandCode 三重额度，`?refresh=1` 强制绕缓存）、`/whale/volc.json`（火山按 `providerId` 对应 Base URL 选择 API / Coding / Agent，45s TTL，`?refresh=1` 强制刷新）、`/whale/vendors.json`、`/whale/usage-records.json`、`/whale/hook.json`（等确认标记与最近事件，**菜单里已不再显示这行诊断**）、`/whale/update.json`（GET 看状态，POST `action=check|update|skip|unskip|restart|close`）、`/whale/roles.json`、`/whale/role-upload.json`、`/whale/role-rename.json`（POST）、`/whale/role-delete.json`（POST）、`/whale/bubble-content.json`（GET/POST）、`/whale/balance-adjustments.json`（GET/POST）、`/whale/sounds.json`、`/whale/sound-upload.json`（POST）、`/whale/sound-delete.json`（POST）、`/whale/zcode-theme.json`、`/whale/image.png`、`/whale/rua.gif`、`/whale/sound/press.mp3` 与 `/whale/sound/release.mp3`（`?set=<音效集 id>`）、`/whale/widget.js`、`/whale/shutdown`（POST，需 `server.json` 令牌）。

## 挂件内自动更新（v1.11.0 起）

菜单最下面一行是「=角色名记账= + 检查更新… + 状态小字」：点「检查更新…」打开更新面板，里面能看到当前版本 / 最新版本，主按钮在「检查更新」「立即更新」之间切换，另有「跳过此版本」（跳过之后出现更新版本会自动失效）、「重启挂件」和最右侧的「关闭插件」。

- **关闭插件**：把当前这一份停掉——桌面浮层与挂件服务都退出。**只是本次关闭**，不写任何「别再自启」的标记：下次会话启动（SessionStart 钩子）或收到提问时照常拉起。按钮要连点两次才生效（关掉就没有界面可点回来了）；想立刻回来：`node lib/cli.mjs start` 或让助手调用 `whale_widget` 的 `start`。`node lib/cli.mjs close` 是它的命令行等价入口。更新正在写文件时该按钮不可用。

- **出站与镜像**：检查与下载都走国内可达的镜像链（ghproxy / gh-proxy / codeload / jsdelivr），单源失败自动换下一个；所有候选地址过 `lib/update.mjs` 的白名单校验（https + 主机白名单 + 拒绝环回/私有/保留地址）。代理地址由 `lib/update.mjs` 的 `UPDATE_HOSTS` / `buildVersionEndpoints` / `buildTarballUrls` 维护。
- **不做签名校验**：完整性只依赖 HTTPS 与「包内 `plugin.json` 的版本号 == 目标版本」，下载内容没有哈希/签名校验（半可信镜像内的既有取舍）。
- **落盘范围**：只替换代码文件，不动 `~/.zcode/whale` 下的用户数据。受影响文件先备份到 `~/.zcode/whale/update/backup/<时间戳>/`（只留最近两份），旧文件的清理依据是**上一个版本的文件清单**（`~/.zcode/whale/update-files.json`，按安装目录分条记录）。
- **装到哪**：会同时覆盖发现到的每个安装目录（仓库本体 + ZCode 插件缓存副本），缓存目录是**原地覆盖**，目录名不会随内容改名（可能看到「目录名 1.0.0 / 内容 1.11.1」）。想让客户端按版本重装，可在插件管理里重新抓取。
- **生效**：更新完必须重启挂件（面板里的「重启挂件」，或 `node lib/cli.mjs restart-all`）——`lib/server.mjs` / `lib/paths.mjs` 在进程启动时定版，只有 `lib/widget.js` 是每次请求现读。
- **完全关掉出站检查**：环境变量 `WHALE_DISABLE_UPDATE_CHECK=1`（后台每 6 小时一次的自动检查不再启动；面板里的手动检查仍可用）。
- 后端状态文件：`~/.zcode/whale/update-state.json`（phase / progress / latest / source / error）。

## 角色配色（v1.10.0 起）

角色下拉里每一行末尾的小圆点是配色入口，点开是「气泡配色 · <角色名>」弹层：浅色 / 深色两档各有一个内嵌 HSV 调色板（色相条 + 饱和度明度面，拖动实时预览、松手才落盘）、一个 HEX/RGB 文本框（收 `#1A2B3C` / `26,43,60` / `rgb(26,43,60)` 三种写法，回车或失焦应用），下面五个预设色块可一键套用某个内置角色的整套配色，「恢复默认」清掉本角色的覆盖。

- **持久化**：写进挂件状态的 `inkOverrides`（`~/.zcode/whale/widget-state.json` 的 `inkOverrides[角色 id] = { light, dark }`）。清掉某个角色的键，或点「恢复默认」，即回到内置配色。
- **浅色档整套界面跟随角色**：浅色主题下菜单 / 二级页面 / 文本框 / 下拉 / 拖动条都取角色墨色（深色档刻意不跟，保持主题中性）。其中**正文**取的是按 4.5:1 派生出来的达标色（`--zcw-role-ink-text`），**装饰件**（描边 / 填充 / 进度条 / 激活态 / 焦点环）用角色原色，勾选对勾**默认白色**（只有填充浅到白勾看不清时才给深色勾）——所以像 小克 `#d97757`（对白底仅 3.12:1）也能有达标的正文，同时保住角色色彩特征。
- **改坏了怎么回**：菜单角色下拉 → 该行圆点 → 「恢复默认」；或直接编辑 `~/.zcode/whale/widget-state.json` 把 `inkOverrides` 清空 / 删掉该角色键。
- 实现位置：`lib/widget.js` 的 `ROLE_INK_PAIR`（内置两档色值）、`applyBubbleInk()`（写 CSS 变量）、`ensureContrast()`/`readableOn()`（对比度派生，纯函数，`tools/selftest.mjs` 逐个内置角色断言）、以及 CSS 里那条 `:root:not(.zcwv-theme-dark)` 覆盖规则。

## 配置字段（`~/.zcode/whale/config.json`）

| 字段 | 含义 |
|---|---|
| `apiKey` | DeepSeek API Key |
| `platformToken` | 平台会话令牌（实时·令牌模式用） |
| `usageMode` | `ledger`（默认）或 `token`，仅作为挂件状态未初始化时的初值 |
| `port` | 固定端口，留空则用默认 39321，占用时自动顺延 |
| `autoStartWidget` | 默认 `true`，SessionStart 是否自动拉起服务 |
| `autoStartOverlay` | 默认 `true`，会话启动时是否顺带拉起桌面浮层（Electron 运行时未安装时静默跳过） |
| `followIntervalMs` | 跟随探测间隔（毫秒），默认 40；**越小**跟得越紧（16ms 已到系统定时器粒度的实际下限）。挂件菜单里的「跟随延迟」会覆盖它 |
| `refreshBalanceOnTurnComplete` | 默认 `false`。开启后每个完成的 GLM 按量回合延迟 8 秒强制刷新一次 GLM 现金钱包（只刷这一个模板；瞬时失败保留旧值，不弹气泡） |
| `minBalanceRefreshIntervalMs` | 上一项的最小间隔毫秒数，默认 120000；下限固定 2 分钟、只能调大（读取时钳在 120000–3600000） |

挂件自身的外观与开关（大小、音效、音量、角色、主题、气泡、默认位置、每轮消耗提示与自动关闭秒数、避让滚动条、隐藏菜单按钮、桌宠模式、跟随延迟、预警阈值、显示跟随）在 `~/.zcode/whale/widget-state.json`，由挂件菜单直接写入：
- `theme`：`light` / `dark` / `system`——`system` 即「跟随 ZCode」（三层判定：浮层观测 ZCode 窗口的 DWM 暗色标志 > 用户级配置 `ui.theme` > 操作系统深浅色，实现见 `lib/zcode-theme.mjs`）。（v1.8.0 曾有第四态 `whale` 蓝白主题，v1.8.1 回滚；旧值读取时归一为 `light`。）
- `defaultCorner`：没有上次拖动位置时的启动角落（`br` 右下 / `bl` 左下 / `tr` 右上 / `tl` 左上，默认 `br`）。菜单「位置与行为…」里选择后立即搬过去，并把该位置记为下次起点；拖动过之后仍以拖动位置为准。
- `petMode`：桌宠模式（浮层专属，默认 false）。开着时**视口 = 整个浮层窗口（主显示器工作区，自动排除任务栏）**——鲸鱼可以拖出 ZCode 窗口放到屏幕任何角落，且失焦/被盖住/最小化都不隐身，每 3 秒检查一次置顶（丢了才重申）；关掉即回到「视口 = ZCode 窗口 ∩ 浮层窗口、随 ZCode 前台隐身」的原有行为。
- `alerts`：v1.8.0 泛化后**两条阈值**——`quotaPct`（额度不足提醒，对 GLM Plan 剩余% 与 CommandCode 三重窗口同时生效：各来源用自己的单位表达「剩余比例低于阈值」，CommandCode 卡片画的是已用进度，折算 `剩余 = 100 − 已用` 再比，于是「阈值 20%」在它那边表现为「进度涨过 80% 才提醒」）/ `moneyAlert`（DeepSeek 余额低于提醒；旧键 `deepseekBelow` / `bigmodelDaily` 读取时自动迁移）。旧键 `planPct` / `cmdgoPct` 读取时折入 `quotaPct`（只设过其中一条的用户设置不会丢）。阈值单位是人民币。消费型厂商（GLM / MiMo / Kimi / OpenAI / Claude / Qwen / MiniMax）的「今日已用达到」预警 v1.7.7 起取消（余额口径只留 DeepSeek 余额见底一条；Kimi / 智谱的余额只作展示，不参与该预警）。每个来源每天只提醒一次，去重键含阈值与窗口名。
- `roleId`：当前形象（内置 `fox` 嘎啦嘛 / `whale` 大肥鱼，或导入件 id；导入件的索引与图片在 `roles.json` + `roles/`），未指定即嘎啦嘛。`fox` 在 v1.7.3 及之前叫 `xiaohuniang`，持久化里的旧值读取时自动归一。
- 按压泡泡队列在 `~/.zcode/whale/bubble-content.json`：**v2 格式** `{v:2, tapAdvance, steps:[{modules:[…]}]}`——每步一组模块，模块三种：`text`（支持 `{balance}` `{today}` `{tokens}` `{plan}` `{model}` `{vendor}` `{time}` `{period}` `{reset}` 占位符，按换行分行）、`rand`（语句池随机取一，留空用内置随机台词）、`view`（内置视图 = 跟随计费源的默认余额/配额内容）。第 1 步按压时显示，之后每点一下气泡推进一步，走完收起；`tapAdvance:false` 时点气泡直接收起。旧 v1 配置（`{v, first, items}`）读写时自动迁移，无感升级。

## 故障排查

| 现象 | 原因与动作 |
|---|---|
| **界面上看不到挂件** | 插件无法注入 ZCode 客户端界面，必须走桌面浮层：先 `desktop install` 装运行时，再 `window start`。装好后会话启动会自动拉起 |
| **打开 ZCode 没有自动出现鲸鱼** | 自启由 SessionStart hook（`lib/autostart.mjs`）负责，先看 `~/.zcode/whale/autostart.log` 最后一行：`server=... overlay=...`。没有新行说明 hook 没被加载（插件未启用，或改完配置后还没重启会话）；`skip: autoStartWidget=false` 说明配置里关掉了自启（菜单里的「关闭插件」**不**写这个标记：它只是把当前这一份停掉）；`overlay=skipped:no-runtime` 说明 Electron 运行时没装（`desktop install`）；`overlay=failed:...` 看括号里的原因。也可以直接 `node lib/autostart.mjs` 手动跑一次验证 |
| **点过「关闭插件」，现在想让它回来** | 启动一次即可：`node lib/cli.mjs start`（要浮层就 `window start`），或让助手调用 `whale_widget` 的 `start`。它只是本次关闭、不落任何状态，所以没有「恢复」这一步——下次会话启动时钩子本来就会照常拉起 |
| **鲸鱼不跟着 ZCode 走** | 跟随由 `desktop/follow-window.ps1` 常驻探测（默认每 40ms 读一次 ZCode 主窗口矩形与前台状态）。完全不动时先确认该 PowerShell 子进程是否还活着（`window stop` 后 `window start` 重建）；跟进脚本的输出与判断依据会写进 `~/.zcode/whale/overlay-debug.log`（仅在 `WHALE_DEBUG_PORT` 开启时记录） |
| 跟得不跟手 / 想更省资源 | 挂件菜单「跟随延迟」可即时切换 16/40/100/250ms（改完不需重启浮层），也可写进 `config.json` 的 `followIntervalMs`。默认 40ms 实测端到端延迟约 13ms、稳态 CPU 约 0.16% 单核（曾有的 5ms 档已移除：实际周期受系统定时器量子约束只能到 ≈11ms，名不副实） |
| 探测脚本秒退 / 浮层跟着消失 | 多为 `follow-window.ps1` 里的 C# 编译失败或脚本被写成非 ASCII。`overlay-debug.log` 里搜 `csharp-compile-failed` / `follow-loop-error`；该文件必须保持纯 ASCII（PS 5.1 按 ANSI 代码页读） |
| 鲸鱼位置错乱 / 跑到窗口外 | 透明窗口的合成层错位，通常是有人重新打开了定位过渡或改回 `setBounds` 贴窗口。见 README「已知限制」的踩坑记录 |
| 挂件画面冻结（鲸鱼在但不动/点了没反应），进程却活着 | v1.3.3 已加自愈：透明置顶窗口被全屏应用覆盖后，Chromium 的原生遮挡计算可能卡死在「被遮挡」而停止出帧（页面逻辑照常跑，画面停在旧帧）。现在已禁用该计算（`disable-features=CalculateNativeWinOcclusion`）、页面加载完成才上屏、重显与每 60 秒强制重送一帧（`kickPresentation`）。等 60 秒自愈，或立刻 `node lib/cli.mjs window restart` 一键重建窗口。**注意**：GDI 截屏（CopyFromScreen/GetPixel）拍不到这个透明窗口的合成表面，诊断画面问题以 CDP 截图和肉眼为准 |
| 浮层起来了但点不动鲸鱼 | 浮层默认鼠标穿透，指针必须先停在鲸鱼上（此时光标变 `grab`、右上角出现菜单按钮）才能点。若整块区域都点不动，检查是否被其它置顶窗口压住 |
| 浮层里菜单的数字框打不了字 | v1.3.0 起指针按到文本框就能打字（浮层在文本类控件上临时接管键盘焦点，离开即交还；v1.3.2 起下拉也换成自定义组件，不再走系统弹窗、不再需要这条路）。还不行就确认浮层版本与插件一致（`window status` 或 `/whale/health` 的 `version`），或改用本地页面（浏览器打开 `http://127.0.0.1:<port>/`）直接键入——这条路径与浮层共用同一份页面代码，能敲进去就说明是浮层窗口层的问题，不是页面本身 |
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
| 今日已用一直 0 | 主口径是本机库：ZCode 今天还没有模型用量记录（或数据库读不到）时才兜底显示账号口径并标注来源；账号口径（大肥鱼记账）只统计「观测到的余额下降」。`node lib/cli.mjs status` 看双口径、`/whale/health` 看数据来源 |
| **CLI/MCP 里的每轮消耗金额币种不对** | v1.3.1 起 `cli.mjs` / `mcp-server.mjs` 按轮次和逐行携带的 `currency` 输出（美元轮次显示 `$`）。若还看到人民币符号出现在 OpenAI/Claude 轮次上，说明这两个文本出口又把 `'CNY'` 写死在格式化里了；`tools/selftest.mjs` 里有「美元轮次经 CLI/MCP 路径」的回归断言 |
| **每轮消耗金额离谱（虚高十几倍）** | 多半是计价口径又踩了「input 含缓存」这个坑：缓存命中的 token 被按未命中价重复算了一遍。核对 `lib/pricing.mjs` 的 `splitInputTokens()` 是否被 `costOfUsage()` 使用，并跑 `node tools/selftest.mjs`（内含两种口径的回归断言）。用 `node lib/cli.mjs turn` 看逐档明细即可判断 |
| 每轮消耗不弹窗 | 需要 ZCode 至少完成过一轮对话（`turn_usage` 有 `completed` 行）；另外菜单里「每轮消耗提示」必须开着 |
| **套餐轮（Start plan 等）每轮消耗显示了 ¥ 金额** | v1.4.0 起按「本轮消耗余额: x%」口径（与主显示 Plan 剩余同基数，占配额总量），混合轮次 hint 补「另耗 ¥」；CLI `turn` 同口径。若又看到金额：查 `lib/plan-balance.mjs` 的 `turnPlanUsage()` 是否被 `server.mjs` 的 `pollTurnCost` 调用、`widget.js` 的 `showCostBubble` 是否先判 `planPct` 再判 `billable`。读不到配额观测时按 tokens 口径显示，属预期 |
| **气泡文字顶出色泡** | v1.4.0 起 `widget.js` 的 `fitBubbleLines()` 在每次气泡内容变化后逐行缩字（等比缩放，下限 62%）+ 换行兜底，覆盖余额视图/每轮消耗/预警/自定义台词。宽度测量用 Range（行元素是 block，`scrollWidth` 会被最宽兄弟行撑大导致短行越缩越小）——改这段别换回 `scrollWidth`；安全行宽常数 560u 与 `.zcwv-wrap`/gif 上限同源 |
| **订阅切到 individual-coding-plan 后配额一直 stale（issue #3）** | 客户端只在 `start-plan` 计费体系里轮询余额，`individual-coding-plan` 不在其中 → 日志里 `billing/balance` 恒为空桶，只剩过期套餐的残留快照。现在直连 `open.bigmodel.cn/api/monitor/usage/quota/limit`（`lib/glm-plan-api.mjs`，60s 缓存、10s 超时、失败静默回落日志）取实时值；`/whale/plan.json` 的 `source` 会显示 `glm-plan-api`。**注意订阅 ≠ 按量**：这个接口只给订阅窗口配额，按量账户余额没有公开接口 |
| **每轮消耗显示旧套餐的残值%（如 2.4%）** | v1.4.2 前的形态：会话高峰期 host-log 刷屏把余额标记挤出 512KB 尾窗 → 今天文件被误判无观测 → 回退读到旧套餐期末残值。修复 = `plan-balance.mjs` 的 `TAIL_STEPS` 逐级扩窗（512KB→4MB→32MB）+ `shapePlanPayload` 只统计 active 套餐名下的桶 + 日期外层循环。若复发先看 `/whale/plan.json` 的 `logDate` |
| **每轮消耗的 % 明显偏小** | v1.4.2 前取「最大单行」；`model_usage` 一行是一次请求，长 agent 轮几十行。`turnPlanUsage()` 必须 `reduce` 全行求和（selftest 有「多行套餐轮求和」断言） |
| **消耗气泡渐隐中内容闪变成余额** | `hideCostBubble()` 设 `costBubbleFadeUntil = now+350ms`，`render()` 在此窗口内只登记补渲染不改写文字。若复发查这两处守卫是否还在 |
| **浮层整窗冻住但点击有响应**（页面活、屏幕停旧帧） | v1.8.6 起「活性点 + DXGI 桌面复制」的主动冻结检测已整体移除（拖动窗口时采样链路时序错位会误报闪烁、检测点滞后可见）。兜底是被动防线：60 秒出帧保险（`kickPresentation`）最迟一分钟自愈、DPI 变更自动重建、`node lib/cli.mjs window restart` 立即重建。浮层隐身/重现为透明度切换（不触发 hide/show），黑匣子看 `reshown-at` 行 |
| 挂件服务打不开 | `node lib/cli.mjs status` 看是否运行；未运行则 `start`。端口被占用会自动顺延，以 `status` 输出的地址为准 |
| Plan 配额不显示 / 提示「Plan 日志未找到」 | GLM Plan 配额有**两个**源（`plan-balance.mjs` 的取源链）：新鲜日志 > 直连套餐用量接口（`glm-plan-api.mjs`，要一把 GLM key）> 过期日志。`no-plan-log` = 两个源都没数据且**没配 GLM 凭据**（数据目录迁移后的机器在普通终端跑 `node lib/cli.mjs status/vendors` 时没有 `ZCODE_DATA_BASE_DIR`，只会探 `~/.zcode/v2/logs`，可能只剩迁移前残留；终端调试先 `set ZCODE_DATA_BASE_DIR=<数据盘根目录>`）；`no-plan-source` = 两源都没数据但**凭据配了**。两者都看 `/whale/plan.json` 的 `probedDirs` + `apiReason` + `keySource` |
| 火山卡显示「未配置火山 IAM 凭据（AK/SK）」 | 最常见原因：用户把模型调用的 `ark-` key 当凭据配了——查配额必须用 IAM AK/SK（`AKLT…`），两套不通用。创建路径见 README「首次配置」；配好后 45s TTL 过后自动刷新，或 `curl '/whale/volc.json?refresh=1'` |
| 火山卡显示无数据或查询失败 | `/whale/volc.json?providerId=<URL 编码的 ID>&refresh=1` 返回接入模式与对应套餐结果。Coding 用 GetCodingPlanUsage，Agent 用 GetAFPUsage，各自查询且不跨套餐回退；成功空窗口为 no-data，网络失败为 request-failed。确认 IAM 与模型接入同账号，企业版席位配额暂不支持。 |
| 火山卡显示「时间偏差过大」 | 网关 `InvalidTimestamp`：本机时间偏差超 15 分钟，校准系统时钟即可，无需改配置 |
| 火山卡显示「IAM 凭据无效或无权限」 | `invalid-credentials`：AK/SK 输错、已禁用，或 IAM 用户没勾 `ArkReadOnlyAccess` 策略。核对 `config.json` 的 vendorKeys 双键是否成对、无多余空格（接口报 `InvalidAccessKey` / `SignatureDoesNotMatch` 都归这一类） |
| 会话用火山但计费分类不对 | 用 `node lib/cli.mjs providers` 查精确 providerId，再核对有效 Base URL：官方 HTTPS `ark.cn-beijing.volces.com` 下 `/api/v3` 为 API、`/api/coding[/v3]` 为 Coding、`/api/plan[/v3]` 为 Agent。旧 `volcBillingByProvider` 已停用；显示偏好和配额查询结果不参与分类。 |
| 峰谷判定不对 | 检查 `lib/pricing.mjs` 的 `PEAK_HOURS` / `BASE_PRICE` / `PRO_PRICE`；北京时间工作日上午 9–12、下午 14–18 为高峰，2026-08-23 起周末全天谷价 |
| 换了图片/音效不生效 | 资产路由每次读盘且 `no-store`，浏览器强刷即可；同时确认替换的是 `assets/` 下的同名文件 |
| **更新失败 / 镜像全不可达** | 面板的错误详情里有逐源失败原因。全部源失败多为网络问题：稍后重试，或设 `WHALE_DISABLE_UPDATE_CHECK=1` 关掉后台自动检查（不再出站）。也可从 `~/.zcode/whale/update-state.json` 的 `error` / `source` 看最后一次结果，`update/backup/` 看备份 |
| **提示「有新版」但点了必然失败 / 版本号比 release 还新** | 探测链里有一半源读 `main` 分支的 `plugin.json`，而下载一律按 tag 取包。发版窗口（版本号已提交、tag 还没推）会出现这种错配——代码已做 tag 核对：核对不到就报「尚未发布可下载包（发版中）」并按「暂无更新」处理。若仍失败，确认目标 tag 的 release 是否真的已发布 |
| **更新被拒：「下载内容版本不符」** | 包内 `.zcode-plugin/plugin.json` 的版本号 != 目标版本，属拒装保护（镜像可能返回了别的分支/别的包）。核对仓库 tag 与 `plugin.json` 里的 `version` 是否一致 |
| **更新后怎么回滚** | 受影响文件在 `~/.zcode/whale/update/backup/<时间戳>/`（只留最近两份，内含 `root.json` 标明安装目录），把里面的文件拷回对应安装目录即可；再 `node lib/cli.mjs restart-all` 生效。安装目录清单看 `~/.zcode/whale/update-files.json` 的 `roots` 键 |
| **更新完挂件消失了** | 更新只替换代码文件、不动服务；若重启后打不开，先 `node lib/cli.mjs status`。历史上「重启挂件」有过「停掉不拉起」的缺陷（旧进程还没退干净，紧跟的 start 被误判为「复用已在运行的服务」），现已等端口真正停止应答才返回；复发时手动 `node lib/cli.mjs start` 并回报 |
| **更新后还是旧版本 / 改了 `server.mjs` 不生效** | `lib/server.mjs`、`lib/paths.mjs` 在服务进程启动时定版，必须重启挂件（面板「重启挂件」或 `node lib/cli.mjs restart-all`）；只有 `lib/widget.js` 每次请求现读，前端改动刷新页面即可 |
| **挂件颜色怪怪的 / 整套界面被染成某个色** | 那是浅色档「整套界面跟随角色配色」。改回去：角色下拉 → 该行末尾圆点 → 「恢复默认」；或编辑 `~/.zcode/whale/widget-state.json` 清掉 `inkOverrides`（删掉某角色的键 = 该角色回内置配色）。正文色是按 4.5:1 派生的达标变体、装饰件才是角色原色，两者本来就不完全相同 |
| 配色弹层里拖动色板没反应 / HEX 输了没生效 | HEX 支持 `#1A2B3C` / `26,43,60` / `rgb(26,43,60)`，需要回车或失焦才应用；拖动是实时预览、松手才落盘进 `inkOverrides`，所以松手前去别处看仍是旧值属预期 |
| **开了「等确认提醒」但不弹** | 提醒由插件的 `PermissionRequest` 钩子驱动：先确认是新版插件且**改完 hooks.json 之后重启过 ZCode 客户端**（钩子在客户端启动时加载）。再 `curl http://127.0.0.1:39321/whale/hook.json` 看 `waiting`/`ts`：`configured:false` = 还没收到过任何钩子事件；`waiting:true` 但没弹，说明开启开关之前事件就到了（去重按事件时间戳，同一件事只弹一次）。菜单里已不显示钩子状态行，诊断只看这个接口 |

排查浮层联动时有个前提：`desktop/follow-window.ps1` **必须保持纯 ASCII**。Windows PowerShell 5.1 会用系统 ANSI 代码页读取无 BOM 的 .ps1，中文注释会被解码成破坏语法的字节，脚本会直接退出（表现为跟随失效）。

## 出站安全约束

服务端只向白名单主机发请求（`api.deepseek.com`、`platform.deepseek.com`），发请求前校验协议为 http/https、主机名匹配白名单、拒绝环回/私有/保留地址的字面量 IP。改 `lib/credentials.mjs` 的 `ALLOWED_HOSTS` 才能扩展目标。

厂商模板（`lib/vendors.mjs` 的 `TEMPLATES`）另有一层：每个带 `url` 的余额/配额段必须**显式声明 `host`**，与 URL 的 hostname 不一致或缺声明就直接拒绝取数。别图省事传 `new URL(section.url).hostname`——那等于让地址自证清白，白名单校验会退化成只查协议与私有 IP。

本地服务本身还有三层防护：只监听 `127.0.0.1`、校验 `Host` 头防 DNS rebinding、写操作校验 `Origin` 防跨站伪造；停止服务需要 `~/.zcode/whale/server.json` 里的随机令牌。

## 想改挂件本身

- 视觉与交互规格（气泡几何、字号档、动画时长、台词组权重）在 `lib/widget.js` 里，与上游逐项对应。
- 台词文案已把指向 DSH 的句子改成 ZCode（`.zcode` 目录、平台令牌说明）。
- 类名前缀是 `zcwv-`、路由前缀是 `/whale/`（上游分别为 `dshwv-` 与 `/dsh-whale/`）；从上游搬代码时注意改这两处，以及 localStorage 键 `zcw-pos`。

