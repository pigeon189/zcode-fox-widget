---
name: fox-widget
description: 操作与排查 WorkBuddy狐娘小挂件（fox-widget）。适用于：查询订阅积分消耗（今日积分、当前会话上下文余量、上一轮消耗的 credit）、可选厂商余额（DeepSeek 等，需自己配 key）、启动/停止挂件，把鲸鱼作为桌面浮层显示在 WorkBuddy 界面之上（安装 Electron 运行时、浮层点不动或不显示、浮层关闭、**桌宠模式**：界面扩展为整个屏幕工作区、可拖出 WorkBuddy 窗口、失焦也不隐身、锁在最上层）；配置对账口径（大肥鱼记账 / 实时·令牌）、挂件端口或会话自启；调整主题（浅色/深色/跟随 WorkBuddy）、角色（导入图片、改名、删除，内置形象可隐藏找回）、**角色配色**（每个角色的浅/深两档气泡墨色，内嵌调色板 + HEX/RGB，含「恢复默认」与恢复手段）、音效（导入/删除）、预警阈值、按压泡泡（自定义点击队列）、**用量记录**（一级菜单入口，今日/7 天/逐轮明细，积分口径）与**记账二级页**（「=角色名记账=」入口，内含额度/余额预警与余额校正）、按模型自动换角色（默认开；手动选过形象即自动关闭）、「等确认提醒」（WorkBuddy 弹通知时提醒，与按压泡泡设置同一行）、今日排名口径（按积分/按 Token）；以及界面看不到挂件、积分读不到、上下文余量不对、钩子没触发、厂商余额读不到、每轮消耗不弹窗、更新失败、配色改坏了怎么恢复、和挂件互动后 WorkBuddy 画面卡住、挂件周期性消失重现等问题。
---

# WorkBuddy狐娘小挂件（fox-widget）

把 ZCode 版挂件（`zcode-fox-widget`）移植到 WorkBuddy。血缘链：MeteorNOX 的 DSH 版网页挂件（MIT）→ ZCode 版 → 本分支，署名见 NOTICE。

**移植最要紧的一句话**：WorkBuddy 是**订阅积分制**（模型由宿主托管、按 request 记 credit），ZCode 版讲的「DeepSeek 余额 + 峰谷计价」是自带 key 的按量场景——所以这里主口径换成**积分**，余额与厂商额度降级为可选的附加卡。两文冲突时以本文件的实测结论为准。

> 时效声明：本文的宿主相关结论截至 **2026-10-14 实测于 WorkBuddy 5.8.2**（macOS/Linux 未验证）。宿主升级后请重跑 `docs/porting/phase-0.md` 里的验证项。

## 架构（先读这段再动手排查）

| 组件 | 文件 | 职责 |
|---|---|---|
| 挂件服务 | `lib/server.mjs` | 本地 HTTP 服务（默认 `127.0.0.1:39321`），提供页面、图片、音效、全部 JSON 接口 |
| 前端挂件 | `lib/widget.js` | 原生 JS，拖拽/吸附/翻转/Q 弹/菜单/气泡/音效/数字滚动，以及浮层穿透切换 |
| 桌面浮层 | `desktop/main.cjs`、`desktop/preload.cjs` | 透明置顶无边框窗口承载挂件页面，默认鼠标穿透，只加载本机 127.0.0.1 |
| 浮层管理 | `lib/overlay.mjs` | 浮层单例检查、启停，以及 Electron 运行时的按需安装 |
| **宿主适配层** | `lib/host.mjs` | **本插件与 WorkBuddy 之间所有宿主差异的唯一落点**（数据目录、db、主题、进程名、单例特征、事件表）。改宿主相关的行为**先看这里** |
| 每轮消耗 / 上下文 | `lib/turn-cost.mjs` | 读 `workbuddy.db` 的 `session_usage` + transcript 的 `rawUsage`，出宿主 credit |
| 用量记录 | `lib/usage-records.mjs` | 扫 transcript 按日/按模型聚合（积分口径） |
| 余额与账本 | `lib/balance.mjs` | 拉厂商余额、记账模式累计、25 秒缓存与瞬时失败回退（可选功能） |
| 定价 | `lib/pricing.mjs` | 峰谷时段判定与 token→金额换算（**只用于等价金额参考值**；改价目只改这里） |
| 凭据发现 | `lib/discover.mjs` | 找厂商 Key（WorkBuddy 侧默认找不到，属预期） |
| 主题跟随 | `lib/host-theme.mjs` | 三层判定：浮层观测宿主窗口 DWM 暗色标志 > `preferences.json` > 操作系统 |
| MCP 工具 | `lib/mcp-server.mjs` | 会话内查询积分/启停挂件与浮层/改配置 |
| 命令行 | `lib/cli.mjs` | `status` / `turn` / `start` / `stop` / `window` / `desktop install` / `key` / `mode` / `json` |
| 会话自启 | `lib/autostart.mjs` | SessionStart hook 幂等拉起服务（以及已装运行时的浮层） |

WorkBuddy 客户端**同样不提供界面注入点**（在 `app.asar` 里没搜到 panel/view 类注入契约），所以挂件自己开窗口呈现。主形态只有一种，排查时先确认用户问的是哪一层：

1. **桌面浮层**（主形态，README 推荐）：独立的 Electron 透明置顶窗口，覆盖整个工作区但默认鼠标穿透，指针压到鲸鱼/气泡/菜单时才接管鼠标。**用户说「挂件」默认指它。**
2. **本地页面**（备用 / 排障入口）：浏览器打开 `http://127.0.0.1:<port>/`，零依赖。浮层加载的正是这个地址，同一份 `lib/widget.js`、同一份配置。

## 数据从哪来

- **订阅积分（主口径）**：
  - `~/.workbuddy/workbuddy.db` 的 `session_usage` 表——`credit_json = {"<conversationRequestId>": <credit>}`，**积分是宿主算好的**，直接用；同一行的 `used` / `size` 给出上下文占用（→「上下文 xx%」）。
  - `~/.workbuddy/projects/<cwd slug>/<sessionId>.jsonl` 的 `providerData.rawUsage`——每次模型调用一条，含 `credit` 与 `prompt_tokens` / `completion_tokens` / `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `prompt_cache_write_tokens` / `completion_thinking_tokens`，以及 `requestModelId` / `conversationRequestId`。用来出逐模型明细与**等价金额**。
  - **会话身份**来自钩子：`lib/hook-event.mjs` 把 stdin 的 `session_id` / `transcript_path` 落进 `<插件数据目录>/hook-state.json`；没有钩子状态时回落到「最近活跃的前台会话」（会跳过 `is_background_automation` 的会话）。
  - **口径的坑**：`rawUsage.prompt_tokens` 是**含缓存命中**的总输入（实测 `total_tokens = prompt_tokens + completion_tokens`、`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`）。自算金额必须走 `splitInputTokens()`，否则缓存那 99% 被按未命中价重复计费，等价金额虚高十几倍。`lib/turn-cost.mjs` 的 `usageFromRawUsage()` 负责把字段映射成 `pricing.mjs` 认得的形状；`completion_tokens` 含思考，映射时减掉 `completion_thinking_tokens` 再单列思考，别重复计。
  - **别做的事**：不要用 `session_usage.credit_json` 做「今日合计」——它是**按 requestId 累积**的键值表、没有时间戳（实测单会话 18 个请求键；2026-10-14 审查 P2-A 推翻了早先「按请求覆盖、只留最后一笔」的判断），无法按天归属。今日合计走 `lib/usage-records.mjs` 扫 transcript 聚合。另注：单文件 transcript 超过统计窗口（32MB，`FOX_WIDGET_TAIL_BYTES` 可调）时只统计尾部并在 `usage-records.json` 的 `truncatedTranscripts` 如实标记，面板会提示「可能偏低」。
- **余额 / 厂商额度（可选）**：`GET https://api.deepseek.com/user/balance` 等，只向白名单主机发请求。WorkBuddy 默认没有用户自带 key（见「凭据优先级」），所以这类卡片通常显示「未配置凭据」——**这是预期行为，不是 bug**。
- **当前模型**：`sessions.model`（宿主当前选择的模型）。WorkBuddy 见过的模型有 `deepseek-v4.1-flash` / `glm-5.3` / `hy4-preview` / `step-5-preview` / `kimi-k*` / `minimax-m3-pay` 等；`hy*`（混元）与 `step*`（阶跃）没有内置立绘，**按模型换角色时有意不动**（见 `lib/paths.mjs` 的 `MODEL_ROLE_RULES`）。
- **宿主模型目录（模型倍率 + 官方促销徽章）**：`~/.workbuddy/storage/user-*/scoped/*/wb-product-config.json` → `product-config-snapshot.data`，取 `savedAt` 最新的一份。里面有
  - `models[]`：每个模型一个**积分倍率**（`credits: "x0.21"`，`x0.00` = 免费）；
  - `modelPromotions[]`：宿主自己的促销（`badge.label` 就是官方文案，如「独家限免」「限时免费」「夜间免费」），带 `modelIds` / `priority` / `schedule`（日期区间 + 可选 `daily` 时段）。
  这是判断「这一轮为什么没扣积分」的**权威依据**，见 `lib/host-models.mjs`。**两个坑**：① 徽章 ≠ 免费——`hy4-preview` 白天也挂着「夜间免费」当广告（倍率仍是 0.29），所以只有**倍率为 0 或该时刻命中的促销 `discount.factor` 为 0** 才算免费；② 判定要按**轮次时间戳**，不是「现在」，否则历史轮次的标注会随时段漂移。
- **拿不到的**：账户级的「剩余积分」。宿主的积分页数据经守护进程方法 `authGetAccountUsage` 从云端取，**不落盘**、本地 API 也没有对应端点（已实测：db / settings.json / storage / `/api/v1/*` / 插件 SDK 全无）。所以挂件不能显示「剩余积分」；别去逆那套内部通道。

## 宿主接入点（实测，2026-10-14）

| 项 | WorkBuddy |
|---|---|
| 插件清单 | `.codebuddy-plugin/plugin.json`（**不再用** ZCode 分支那套清单目录） |
| 市场清单 | `.codebuddy-plugin/marketplace.json`，`plugins[].source: "./"`（**已验证合法**：宿主用 `isPathInside` 校验，路径等于根时返回 true） |
| MCP | `.mcp.json`（清单里写 `"mcpServers": "./.mcp.json"`）；变量 `${CODEBUDDY_PLUGIN_ROOT}` / `${CODEBUDDY_PLUGIN_DATA}`；`cwd` 默认 = 插件根（无需显式写） |
| MCP 工具全名 | `mcp__plugin_<插件名>_<server名>__<工具名>`，如 `mcp__plugin_fox-widget_whale__whale_credits` |
| 钩子 | `hooks/hooks.json`，`{ "hooks": { "<事件>": [{ hooks: [{ type: "command", command: "node \"${CODEBUDDY_PLUGIN_ROOT}/...\"", timeout: 15 }] }] } }`——**只有 `command` / `prompt` 两种类型**（ZCode 的 `type:"process"` 不认），`timeout` 单位是**秒** |
| 钩子事件 | PreToolUse / PostToolUse / Stop / SubagentStop / SessionStart / SessionEnd / UserPromptSubmit / UserPromptExpansion / PreCompact / Notification。**没有 `PermissionRequest`** |
| 插件数据目录 | `~/.workbuddy/plugins/data/<插件名>-<市场名>/`（即 `${CODEBUDDY_PLUGIN_DATA}`，本插件默认 `fox-widget-fox-local`，环境变量 `FOX_WIDGET_DATA_DIR` 可覆盖） |
| 主题 | `~/.workbuddy/storage/user-<uid>-personal/global/preferences.json` 的 `theme` |
| 自带 node | v22.22.2（`node:sqlite` 可用）；钩子里 `node` 可直接用（内置插件 `subscription-gate` 也这么写） |

## 凭据优先级（可选功能）

1. 环境变量（`DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `ZHIPU_API_KEY` …，见 `lib/discover.mjs` 的 `ENV_KEY_TABLE`）
2. `<插件数据目录>/config.json` 的 `apiKey`
3. `~/.workbuddy/settings.json` 的 `env` 块或 `pluginConfigs.<插件>.options`
4. `<插件数据目录>/config.json` 的 `vendorKeys`

⚠️ **WorkBuddy 上第 3/4 条通常是空的**：本机实测 `settings.json` 的 `pluginConfigs` 为空对象、`models.json` 为 `[]`——用户不需要填 key（模型由宿主托管）。所以厂商卡在 WorkBuddy 上默认「无凭据 → 不可用」，**这是预期**；想用就让用户配环境变量或用 `echo 'sk-...' | node lib/cli.mjs key`（走 stdin，不留 shell 历史/进程列表痕迹）。密钥只在内存中使用、只发往白名单主机，不落盘日志、不打印明文。

## 常用操作

优先用 MCP 工具（`whale_credits`、`whale_balance`、`whale_widget`、`whale_last_turn`、`whale_config`），MCP 不可用时用命令行：

```bash
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" status          # 今日积分 + 上下文余量 + 服务与浮层状态（+ 可选余额）
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" turn            # 上一轮消耗积分 + 等价金额 + 逐模型明细
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" start           # 启动挂件服务（返回地址）
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" stop            # 停止挂件服务
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" close           # 关闭插件（停浮层 + 停服务；看门狗本次停手，下次启动照常拉起）
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" json            # 结构化输出，便于程序消费
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" key sk-xxxx     # 写入厂商 API Key（可选功能）
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" mode token      # 切换对账/兜底口径（主显示固定积分，此项只决定账号口径）
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" window start    # 桌面浮层（浮在 WorkBuddy 界面上）
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" window stop     # 关闭浮层
node "${CODEBUDDY_PLUGIN_ROOT}/lib/cli.mjs" desktop install # 安装 Electron 运行时（浮层前置，一次性）
```

服务接口（排查时可直接 curl）：`/whale/health`、`/whale/context.json`（上下文余量）、`/whale/last-turn.json`、`/whale/usage-records.json`、`/whale/session.json`、`/whale/host-theme.json`、`/whale/balance.json`、`/whale/vendors.json`、`/whale/cmdgo.json`（`?refresh=1` 强制绕缓存）、`/whale/plan.json`（**已冻结，恒返回 not-supported-on-workbuddy**）、`/whale/hook.json`（等确认标记与会话身份）、`/whale/update.json`、`/whale/size.json`（GET/PUT）、`/whale/roles.json`、`/whale/role-upload.json`、`/whale/role-rename.json`、`/whale/role-delete.json`、`/whale/bubble-content.json`、`/whale/balance-adjustments.json`、`/whale/sounds.json`、`/whale/sound-upload.json`、`/whale/sound-delete.json`、`/whale/image.png`、`/whale/rua.gif`、`/whale/sound/press.mp3` 与 `/whale/sound/release.mp3`（`?set=<音效集 id>`）、`/whale/widget.js`、`/whale/shutdown`（POST，需令牌）。

## 更新（与 ZCode 版不同）

**本分支默认关闭自更新**（`lib/update.mjs` 的 `startAutoCheck()` 需显式 `FOX_WIDGET_ENABLE_UPDATE_CHECK=1` 才启用）。理由：ZCode 版的自更新会把文件**原地覆盖**到客户端 cache 快照，而 WorkBuddy 的版本账本由 `installed_plugins.json` 记录、目录名带版本号，原地覆盖会让二者对不上，和宿主的插件管理打架。

推荐更新方式：`git pull` → 在 WorkBuddy 的**技能市场页**选中 `fox-local` 市场点「刷新」。发版口径见 `CONTRIBUTING.md`（tag 前缀 `wb-v`）。

挂件菜单最下面那行末尾的「检查更新…」打开更新面板（显示当前 / 最新版本；自更新关闭时以「已是最新 / 未启用」的状态呈现），面板右侧是「重启挂件」与「关闭插件」——后者把当前这一份停掉（服务 + 浮层），并让看门狗本次停手，见「配置字段」下的说明。

> 装插件时注意：宿主的「添加市场」是**填「市场源」的文本框**（不是文件夹选择框），
> 必须填**真实存在的路径**（仓库根绝对路径）；填市场名/目录名会被判成 `Unsupported source format`。

## 角色配色（继承 ZCode 版）

角色下拉里每一行末尾的小圆点是配色入口，点开是「气泡配色 · <角色名>」弹层：浅色 / 深色两档各有一个内嵌 HSV 调色板、一个 HEX/RGB 文本框、五个预设色块与「恢复默认」。

- **持久化**：`<插件数据目录>/widget-state.json` 的 `inkOverrides[角色 id] = { light, dark }`。
- **浅色档整套界面跟随角色**：正文取按 4.5:1 派生的达标色（`--zcw-role-ink-text`），装饰件用角色原色——别把两者合并（kimi娘原值对白底仅 2.85:1）。
- 实现：`lib/widget.js` 的 `ROLE_INK_PAIR` / `applyBubbleInk()` / `ensureContrast()`。

## 配置字段

`<插件数据目录>/config.json`（即默认的 `~/.workbuddy/plugins/data/fox-widget-fox-local/config.json`）：

| 字段 | 含义 |
|---|---|
| `apiKey` | 第三方厂商 API Key（可选功能；WorkBuddy 默认不需要） |
| `platformToken` | 平台会话令牌（实时·令牌模式用，ZCode 遗留能力） |
| `usageMode` | `ledger`（默认）或 `token` |
| `port` | 固定端口，留空则用默认 39321，占用时自动顺延（环境变量 `FOX_WIDGET_PORT` 亦可） |
| `autoStartWidget` | 默认 `true`，SessionStart 是否自动拉起服务 |
| `autoStartOverlay` | 默认 `true`，会话启动时是否顺带拉起桌面浮层（运行时未装时静默跳过） |
| `followIntervalMs` | 跟随探测间隔（毫秒），默认 40 |
| `vendorKeys` | `{ <模板 id>: <key> }`，手工给厂商卡填凭据 |

另外有一个**不是配置**的状态文件：`<插件数据目录>/close-pause.json`——菜单里点过「关闭插件」时写下，看门狗见到它就停手（本线看门狗每 15 秒补活，不拦就会把刚关掉的挂件拉回来）。它只活到「下次宿主启动」或「挂件被钩子 / 显式启动拉回来」，然后自动删掉；想立刻恢复就 `node lib/cli.mjs start`。

挂件自身的外观与开关（大小、音效、音量、角色、主题、气泡、每轮消耗提示与自动关闭秒数、避让滚动条、桌宠模式、跟随延迟、预警阈值、显示跟随）在 `<插件数据目录>/widget-state.json`：
- `theme`：`light` / `dark` / `system`——`system` 即「跟随 WorkBuddy」（三层判定：浮层观测宿主窗口 DWM 暗色标志 > `preferences.json` 的 `theme` > 操作系统，见 `lib/host-theme.mjs`）。
- `petMode`：桌宠模式（浮层专属，默认 false）。开着时**视口 = 整个浮层窗口（主显示器工作区）**，鲸鱼可拖出 WorkBuddy 窗口，失焦/被盖住/最小化都不隐身。
- `alerts`：`quotaPct`（额度不足提醒）/ `moneyAlert`（DeepSeek 余额低于提醒）。
- `roleId`：当前形象（内置 `fox` 嘎啦嘛 / `whale` 大肥鱼 / `gpt` / `kimi` / `xiaoke`，或导入件 id），未指定即嘎啦嘛。
- `displayMode`：`auto`（= 积分）/ `credits` / 以及 `plan`/`cmdgo`/`glm`/`ds` 等厂商视图的手动覆盖。
- 按压泡泡队列在 `<插件数据目录>/bubble-content.json`：v2 格式 `{v:2, tapAdvance, steps:[{modules:[…]}]}`，模块三种 `text`（占位符 `{balance}` `{today}` `{tokens}` `{plan}` `{model}` `{vendor}` `{time}` `{period}` `{reset}`）/ `rand` / `view`。

## 故障排查

| 现象 | 原因与动作 |
|---|---|
| **界面上看不到挂件** | 插件无法注入 WorkBuddy 客户端界面，必须走桌面浮层：先 `desktop install` 装运行时，再 `window start`。**先分两层定位**：`curl 127.0.0.1:39321/whale/health` 有响应（服务是好的）但桌面没窗口 → 问题在浮层，看 `autostart.log` 最后一行与下面的「浮层秒退」两条 |
| **启动 WorkBuddy 后桌面上没有挂件，随便动一下会话（比如点「对话回退」）才冒出来** | **这是宿主语义，不是故障**：WorkBuddy **启动客户端本身不触发 `SessionStart`**。实测（宿主日志 `executeSessionStartHooks` 对齐 `AppStartup.log`）：存活 14s / 21s 的两个应用实例里 SessionStart **一次都没跑**；其余实例内它出现的延迟从 **+19s 到 +736s 毫无规律** → 由**用户动作**驱动（`source=resume`＝真正进入/恢复一个会话），不是启动定时器。所以自启只挂 SessionStart 的话，冷启动后「一动不动」就没有挂件。**v2.0.1 起已在 `hook-event.mjs` 里加了廉价兜底**：`UserPromptSubmit` / `Notification` 时瞄一眼 `server.json` / `overlay.json` 的 pid，不活着就后台 detached 拉起 `autostart.mjs`（不阻塞这一轮，20s 节流）。排查时看 `<插件数据目录>/hook-state.json` 的 `lastEnsureSpawnAt` 与 `autostart.log`；要关掉这个行为设 `FOX_WIDGET_NO_ENSURE=1` |
| **点过「关闭插件」，现在想让它回来** | 启动一次即可：`node lib/cli.mjs start`（要浮层就 `window start`），或让助手调用 `whale_widget` 的 `start`。它只是本次关闭——`<插件数据目录>/close-pause.json` 这个标记只活到下次宿主启动、或挂件被别的路径拉回来，看门狗日志会记 `skip: close-pause (idle until next host start)`；不需要手动恢复任何配置 |
| **浮层进程在跑、但你就是看不见它** | 十有八九**不是故障，是设计行为**：浮层默认**只跟随 WorkBuddy 前台**，你切到别的窗口（浏览器 / 游戏 / 另一个 IDE / 图片查看器）它就会隐身。要它常驻就开挂件菜单里的**桌宠模式**。确认它此刻到底显没显示：看 `<插件数据目录>/overlay-debug.log` 最后几行 —— `hidden host-not-foreground` = **正常隐身**，`shown-at {…}` / `reshown-at {…}` = 已经显示。**问用户之前先问一句「你是不是在别的窗口上」**（本机实测：用户连续三次报「消失了」，每次查下来最顶层窗口都不是 WorkBuddy —— 分别是 War Thunder / 图片查看器 / WorkBuddy 被最小化）。重启后的头几十秒也常是这种情况（那时 WorkBuddy 还没拿到前台）。判定规则就一句：`show = 未最小化 && (前台是 WorkBuddy 或前台是浮层本身)`，且**只在状态变化时上报**，所以「一直没消息」= 状态没变过 = 一直该隐身。**但有一个例外**：主进程活着、页面已死的**僵尸态**——见下面「凡是都活着、桌面却什么都没有」一行 |
| **凡是都活着、桌面却什么都没有**（僵尸浮层） | **2026-10-14 真机实测的最难缠形态**：Electron 主进程活着、窗口可见（`IsWindowVisible=1`、标题对、rect 对），但**渲染进程已死** → 窗口是一块空白透明层。此时 `overlay.json` 的 pid 活着、`kill(pid,0)` 成功、看门狗与钩子的补活逻辑**全都认为它健康**，于是僵尸态可以无限期留着，用户反复重启宿主也修不好（浮层不在宿主进程树里，不随宿主退出）。**怎么确认**：① `netstat -ano \| grep :39321` 采样 15 秒 —— 页面每 1 秒轮询 `last-turn.json`，**连接数零变化 = 页面死了**（这是最可靠的一条）；② `overlay-debug.log` 里最后一条 `page-linfo` 是很久以前；③ 事件日志有 `page-beat-fail (2/2)` + `page-reload`（v2.0.1 起的自愈）。**怎么触发**：同一条产品线的两个副本同时用 `%APPDATA%\fox-widget-overlay`（重复拉起一个实例，例如在 agent shell 里跑 `window restart`）→ 抢 GPUCache 文件锁 → 连环 GPU 崩溃（`exit_code=-1073741819`）→ 正在用的那个浮层的渲染进程被打死。**怎么修**：结束那个浮层进程（若它以管理员权限运行，普通权限收不掉，必须管理员终端 `taskkill /F /T /PID <pid>`），或完全退出宿主等它按 `gone` 自行退出后重开。**代码侧已加的兜底**：`desktop/main.cjs` 的页面心跳（30s 一次，连续 2 次失败即 reload）+ `render-process-gone → reload`；`lib/overlay.mjs` 的 `stopOverlay` 收完**复验**（杀不掉就如实报错、保留记录）；`lib/cli.mjs` 的 `window restart` / `restart-all` 在收不掉时**中止**，不再叠加新实例 |
| **`window stop` / `window restart` 说「已关闭」但其实没关掉** | 浮层以**更高权限**（管理员）运行，普通权限的 `taskkill` 收不掉。判据：`tasklist` 里还能看到 electron 进程；或直接查完整性级别（管理员/System 进程的 token 连打开都拒绝）。当前实现会如实报错（`浮层进程未能结束（pid …）`）并中止启动，不再假装成功。根因通常在**看门狗被从管理员终端安装过**——看门狗是常驻进程，它和它的后代（服务、浮层）都继承管理员权限。修法：在**普通**终端重跑 `node lib/cli.mjs watchdog install`（或在管理员终端先 `taskkill /F /T /PID <看门狗 pid>`），让看门狗回到普通权限 |
| **用户说「挂件随对话出现/消失」，但那不是本挂件** | **WorkBuddy 自带一个桌宠**（资源名 `miao`，`renderer/assets/default-miao-*.png`，灰白猫耳 + 耳机 + 深色面罩的机器头、带倒影，由 `HomePetActivityBubble` 渲染）。它**带活动气泡**，助手干活时冒出来、干完收回去，所以看着就像「发消息就出现、跑完就消失」。本挂件的角色全是 chibi **少女**（嘎啦嘛 / 大肥鱼 / GPT娘 / kimi娘 / 小克 / 哈基米），**没有机器头**。分辨与取证见 `docs/porting/phase-6-acceptance.md` §5.9。两者默认都落右下角、会重叠，**别把宿主桌宠当成我们的角色** |
| **打开 WorkBuddy 没有自动出现鲸鱼** | 自启由 SessionStart hook（`lib/autostart.mjs`）负责，先看 `<插件数据目录>/autostart.log` 最后一行。**没有新行 = 钩子没触发**（插件未启用 / 改完 hooks.json 没重启客户端 / `command` 里 `node` 不在 PATH）。排查钩子：设 `FOX_WIDGET_HOOK_DEBUG=1`，钩子会把每次事件写进 `<插件数据目录>/hook.log`。也可 `node lib/autostart.mjs` 手动跑一次 |
| **积分/上下文一直读不到** | 看 `/whale/hook.json` 有没有 `sessionId`：没有说明 UserPromptSubmit 钩子没跑到（`hook-state.json` 没写）。有 `sessionId` 再看 `/whale/context.json` 的 `reason`；`db-unavailable` = `~/.workbuddy/workbuddy.db` 读不到或 `node:sqlite` 不可用（自带 node 需 ≥ 22.5，实测 22.22.2 可用） |
| **今日积分比客户端显示的小** | 面板扫的是 `~/.workbuddy/projects/*/*.jsonl`，只取最近 60 个会话、每个只读尾部 2MB。老会话或超长会话的早期轮次可能没算进去（`usage-records.json` 的 `scannedTranscripts` / `totalTranscripts` 可以看出来）。这是刻意的性能取舍 |
| **每轮消耗不弹窗** | 需要宿主至少完成过一轮对话（transcript 里有 `rawUsage`）；另外菜单里「每轮消耗提示」必须开着。`/whale/last-turn.json` 的 `partial:true` 表示该轮还没被宿主结算 |
| 厂商余额读不到 / 显示「未配置凭据」 | **WorkBuddy 默认如此**（模型由宿主托管，用户没有自带 key）。要看到余额得自己配：环境变量或 `echo 'sk-...' | node lib/cli.mjs key`（stdin，不留命令行痕迹）。逐条明细看 `/whale/health` 的 `keyProbe` |
| **鲸鱼不跟着 WorkBuddy 走** | 跟随由 `desktop/follow-window.ps1` 常驻探测（默认每 40ms 读宿主动窗口矩形与前台状态）。先确认该 PowerShell 子进程还活着（`window stop` 后 `window start` 重建）；目标进程名由 `lib/host.mjs` 的 `HOST_PROCESS_NAME`（`WorkBuddy`）决定，可用 `WHALE_TARGET_PROCESS` 覆盖 |
| 探测脚本秒退 / 浮层跟着消失 | 多为 `follow-window.ps1` 里的 C# 编译失败或脚本被写成非 ASCII。**该文件必须保持纯 ASCII**（PS 5.1 按 ANSI 代码页读） |
| 浮层里菜单的数字框打不了字 | 换成自定义下拉的路径已处理；还不行就确认浮层版本与插件一致（`/whale/health` 的 `version`），或改用本地页面（浏览器打开 `http://127.0.0.1:<port>/`）直接键入 |
| **和挂件互动后 WorkBuddy 画面卡住（点一下才恢复）** | 浮层窗口设为不可激活（`focusable:false` → `WS_EX_NOACTIVATE`）解决；另有 `desktop/main.cjs` 的 `type: 'toolbar'`（让浮层不进宿主 Chromium 的遮挡判定）**不能删**——删掉会复发「点角色后宿主停帧」（ZCode 侧 issue #2 的真机 A/B 实锤，WorkBuddy 同为 Electron，同源风险存在）。改动窗口选项后必须 `window stop` + `window start` |
| **登录时弹「Windows Script Host … 行:1 字符:1 错误: 无效字符 代码: 800A0408」** | 启动项 VBS 的**编码**写错了：`fox-widget-watchdog.vbs` 以 **UTF-8 BOM**（`EF BB BF`）开头，而 Windows Script Host **只认 ANSI 与 UTF-16 的 BOM**，于是按 ANSI 读、头三字节非法、**编译期失败（一句都不执行）** → 登录自启等于没装。修：`node lib/cli.mjs watchdog install` 重写一遍（v2.0.1 起会写**无 BOM 的纯 ASCII**；含非 ASCII 路径才写 UTF-16LE + BOM）。字节级自查：`head -c 4 <vbs> \| od -An -tx1` 应为 `27 20`（撇号+空格），且文件里没有 `ef bb bf`。注意这个故障**是静默的**——自启从没成功过，机器上的看门狗其实是手动起的，而手动那次若落在管理员终端里，会把看门狗 + 服务 + 浮层一起带成管理员权限（见下一行） |
| 浮层启动失败 | `node lib/cli.mjs window status` 看运行时是否已安装；未安装则 `desktop install`（Electron 约 150MB，装到 `<插件数据目录>/desktop-runtime`） |
| **浮层「启动后立即退出」**（`autostart.log` 记 `overlay=failed:浮层进程启动后立即退出`） | **先看 `<插件数据目录>/overlay-spawn.log`** —— Electron 的 stderr 落在这里。若日志为空/进程秒退，十有八九是下一条 |
| **浮层继承了宿主注入的 `ELECTRON_RUN_AS_NODE=1`**（真机实锤，WorkBuddy 专有） | WorkBuddy 自己把 Electron 二进制当 Node 用，会给派生子进程设 `ELECTRON_RUN_AS_NODE=1`（还有 `NODE_OPTIONS=--require=<宿主 shim>`）。浮层是**真 Electron GUI**，继承它后 electron.exe 以 **Node 模式**启动，`require('electron')` 拿不到 `app`/`BrowserWindow`，主进程立刻退出 → 服务明明是好的、桌面却什么都没有。**自检**：同一个 electron.exe 跑 `--version` —— 带该变量打印 **node 版本**（如 `v24.21.0`），去掉才打印 **Electron 版本**（如 `v44.7.2`）。**代码已修**（`lib/overlay.mjs` 的 `overlaySpawnEnv()` 在 spawn 前清掉这两个变量，已有回归断言）。临时绕过：在**普通终端**里 `node lib/cli.mjs window start`（别用 WorkBuddy 派生的 shell）。**注意必须换新进程才生效**：已在跑的 MCP 服务 / 服务进程内存里缓存着旧模块，重启客户端或重新起进程即可 |
| 改完 follow-window.ps1 后行为没变 | 该脚本是常驻子进程，改完要 `window stop` + `window start` 才重新加载 |
| **开了「等确认提醒」但不弹 / 弹太频繁** | 事件源是 `Notification`（WorkBuddy **没有 PermissionRequest**）。先确认改完 hooks.json 后**重启过客户端**（钩子在客户端启动时加载）；再 `curl http://127.0.0.1:39321/whale/hook.json` 看 `waiting`/`ts`/`notification`。**已知局限**：`Notification` 会伴随所有宿主通知触发，比 ZCode 版更容易多提醒几次，所以默认关闭。若确有必要换成更精确的源，候选只剩 `PreToolUse` 返回 `permissionDecision:"ask"` 的自诉时机 |
| 主题不跟随 | 看 `/whale/host-theme.json` 的 `source`：`host-window` = 浮层观测到宿主窗口暗色标志（最准）；`preferences` = 读 `preferences.json`；`missing` = 都没读到，回落系统。**注意**：宿主设为「跟随系统」时这里会返回 `system`，属正确行为 |
| 峰谷判定不对 | 只影响**等价金额**（积分不受影响）。检查 `lib/pricing.mjs` 的 `PEAK_HOURS` / `BASE_PRICE` / `PRO_PRICE`；北京时间工作日 9–12、14–18 为高峰 |
| 换了图片/音效不生效 | 资产路由每次读盘且 `no-store`，浏览器强刷即可；确认替换的是 `assets/` 下的同名文件 |
| **更新相关** | 本分支默认**关闭自更新**（见上）。用户报「检查更新没反应」属预期；要开就设 `FOX_WIDGET_ENABLE_UPDATE_CHECK=1`（且注意与宿主插件管理打架的风险） |
| 配色弹层里拖动色板没反应 / HEX 输了没生效 | HEX 支持 `#1A2B3C` / `26,43,60` / `rgb(26,43,60)`，需回车或失焦才应用；拖动是实时预览、松手才落盘进 `inkOverrides` |
| 挂件颜色怪怪的 / 整套界面被染成某个色 | 浅色档「整套界面跟随角色配色」。改回去：角色下拉 → 该行末尾圆点 → 「恢复默认」；或编辑 `widget-state.json` 清掉 `inkOverrides` |

排查浮层联动时有个前提：`desktop/follow-window.ps1` **必须保持纯 ASCII**。Windows PowerShell 5.1 会用系统 ANSI 代码页读取无 BOM 的 .ps1，中文注释会被解码成破坏语法的字节，脚本会直接退出（表现为跟随失效）。

## 出站安全约束

服务端只向白名单主机发请求（`api.deepseek.com`、`platform.deepseek.com`），发请求前校验协议为 http/https、主机名匹配白名单、拒绝环回/私有/保留地址的字面量 IP。改 `lib/credentials.mjs` 的 `ALLOWED_HOSTS` 才能扩展目标。

厂商模板（`lib/vendors.mjs` 的 `TEMPLATES`）另有一层：每个带 `url` 的余额/配额段必须**显式声明 `host`**，与 URL 的 hostname 不一致或缺声明就直接拒绝取数。

> 沙箱提示：`~/.workbuddy/settings.json` 里有 `sandbox.networkDenyAllMigrated: true`，但**实测**本机从 shell 与 node 子进程都能正常出站（`curl https://api.deepseek.com/...` 返回 401 = 可达）。若某台机器上出站被拦，症状是余额/厂商卡/更新全部静默失败；此时把积分口径当作唯一主口径即可（它本来不出站）。

本地服务本身还有三层防护：只监听 `127.0.0.1`、校验 `Host` 头防 DNS rebinding、写操作校验 `Origin` 防跨站伪造；停止服务需要 `<插件数据目录>/server.json` 里的随机令牌。

## 想改挂件本身

- 视觉与交互规格（气泡几何、字号档、动画时长、台词组权重）在 `lib/widget.js` 里。
- **改宿主相关行为先改 `lib/host.mjs`**：这个仓库是同仓双分支（`main`=ZCode，`workbuddy`=本分支），把宿主差异收在一个文件里，`git merge main` 的冲突面才收得住。
- **有意保留的旧标识**（改它们要动持久化状态与 2500 行冒烟测试，收益为零风险不小）：类名前缀 `zcwv-`、localStorage 键 `zcw-pos`、路由前缀 `/whale/`、环境变量 `WHALE_*`。注释里「ZCode」字样也多处保留——它们描述的是历史来源，不影响行为。
- 台词文案已把指向 ZCode 的句子改成 WorkBuddy（`.zcode` 目录、平台令牌说明）。
- 几处**不要动**的地方（都有实测理由）：`desktop/main.cjs` 的 `type:'toolbar'`、`lib/credentials.mjs` 的 `readPluginConfig()` 不加缓存、`lib/service.mjs` 的 `waitServerStopped`、`lib/pricing.mjs` 的 `splitInputTokens`、`lib/widget.js` 的 `--zcw-ink` 4.5:1 派生色、前端不引 ESM。
