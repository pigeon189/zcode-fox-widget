# 更新日志（Changelog）

本文件记录两条产品线的变更（同仓双分支：`main` = ZCode 线，`workbuddy` = WorkBuddy 线）；共享内核的修复两边都记一条。

> 版本小节用 **tag 前缀**区分产品线：`## wb-vX.Y.Z …` = **WorkBuddy狐娘小挂件**（`fox-widget`，本分支），
> `## vX.Y.Z …` = **ZCode狐娘小挂件**（`zcode-fox-widget`，`main` 分支；本节是移植时的基线快照）。

---

## 未发版：代码审查（REQUEST_CHANGES）修复批次

> 对应 2026-10-17 的只读审查报告，编号沿用报告里的 I/S/X/P/C。只改代码与文档，未改版本号、未重签名清单。

- **I1 spawn 失败不再掀桌**：`ensureServer` / `startOverlay` / 更新重启 / 浮层跟随脚本的 spawn 全部补 `error` 监听；`ensureServer` 在 spawn 前用 `spawnSync(node -v)` 探一次可用性，失败返回结构化错误（此前未监听 `error` = 未捕获异常，钩子/看门狗会崩溃）。
- **I2 自启预算**：`startOverlay({svc})` 复用自启里那次 `ensureServer` 的结果，钩子设置 15s 内部预算，`hooks.json` 超时 15s → 20s；最坏耗时从 15.8s 降到 ~9.2s。
- **I3 单例**：新增 `server.start.lock`（O_EXCL + pid/TTL 陈旧锁回收）、进程内 in-flight 合并；`EADDRINUSE` 时先探测占用者，若已有本插件实例则安静退出（不再顺延端口起第二个）；`server.json` 不覆盖另一个存活实例的记录；spawn 后按 pid 校验，多余的那个自收。
- **I4/X2 跨站防护改为默认拒绝**：除页面/脚本/图片/音效/健康检查白名单外，所有 GET 都过 `Sec-Fetch-Site` 校验——`/whale/session.json`（会带用户 key 出站）不再漏网。
- **I5 设置保存失败不再静默**：前端读 `res.ok` 与响应体，`500 + persistError` 走同一条失败提示；保存改为 300ms 去抖 + 串行化。
- **I6 macOS 浮层**：Electron 二进制按平台给候选路径（`Electron.app/Contents/MacOS/Electron`），`isRuntimeInstalled` 取首个存在项并按平台选哨兵；`focusable` 全平台关闭，非 Windows 铺满指针所在显示器并用 `showInactive`。
- **I7 完整性校验**：清单外文件在运行时降级为「忽略 + 不写盘 + 警告」，发布自检用 `strictExtraFiles` 严格模式。
- **安全**：`/whale key` 默认从 stdin 读；`/whale/vendors.json` 的 `keyMasked` 改为带令牌才回；更新下载改 `redirect:'manual'` 并逐跳校验域名白名单；写操作补 `Content-Type: application/json` 校验（415）。
- **性能**：每轮积分轮询 1s → 2.5s，读不到数据时 30s 退避；厂商余额附载加 60s 缓存。
- **健壮性/兼容**：预警阈值按字段存在性取值；余额校正加上界并归一到两位小数；峰谷切换点由 `PEAK_HOURS` 展开；CLI 命令分派只认自有函数；浮层判活加「命令行亲缘 / 进程名」校验与 10s 缓存（pid 复用不再误杀）；`health` 增加 `nodeVersion`，Node < 22.5 启动时给出明确警告。
- **测试**：自检新增「跨站 session.json 被拦」「静态素材白名单放行」「非 JSON 写请求 415」三条断言（400/400 通过）。

---

## wb-v1.2.0 新增：常用中转站额度、7 天模型排名、GPT 娘原构图修复与角色台词收口

- **常用中转站额度**：厂商模板新增 PackyCode、DuckCoding、云雾 API、H API、UU API、APINebula、LinkAI、88Code（New API 系）、SSSAICode（Sub2API）与 Cubence。按量站显示余额卡；只有一个月度/5 小时窗口时按 GLM Plan 的数字百分比显示剩余额度；Sub2API 的 5 小时/本日/本周三窗口走额度卡。凭据优先复用宿主里已配置的 API Key；New API 账户级查询需要系统访问令牌时可在配置里补 `relayAuth`。
- **CommandCode 官方 API 与本地账号池**：除 Go 套餐外，CommandCode 官方 API provider（`api.commandcode.ai`）以及 `commandcode-pool` 这类本地账号池也能显示额度；同一账号的 OpenAI/Anthropic 两个 provider 按 key 去重。
- **用量记录支持近 7 天模型排名**：模型排名旁新增「按当天 / 按7天」按钮，与「按积分 / 按 Token」独立切换；近 7 天榜按模型聚合 token、积分与占比。
- **换角色淡入**：切换角色时新立绘从低透明度轻轻浮入，图片切换本身不延迟响应；关闭动画或系统减少动态效果时不播放。
- **GPT 娘立绘修复**：恢复原立绘构图，左侧翅膀边缘不再贴着画布左缘，并去掉边缘的白色锯齿。
- **台词与 rua 动图按角色收口**：「哦鲸鲸」只保留给大肥鱼；rua 动图只在大肥鱼和小克的出厂点击队列里出现，其他角色是峰谷文字/随机台词二选一。大肥鱼新增三句台词，并调整两句。
- **文档**：安装一节把「直接填 GitHub 源」与「克隆到本地目录」并列为两个入口，更新方式按来源区分。

---

## wb-v1.1.0 新增：内置角色「哈基米」、六张立绘统一规格、更新包签名校验

- **新内置角色「哈基米」（Gemini 族）**：「按模型换角色」里 Gemini 系模型会切到它；配色是彩色渐变。
- **六张内置立绘统一画布规格**（610×610、内容高一致、内容右边与底边贴齐）：切换角色时角色的身高与离右边框的距离不再变。GPT娘回到原立绘、kimi娘换新立绘、哈基米发间残留的白底清掉、小克 / 嘎啦嘛 / 大肥鱼按同一规格重排。
- **浅色主题下勾选对勾统一为白色**。
- **菜单里的「关闭插件」是本次关闭**：停掉之后看门狗本次不再把它拉回来，下一次宿主启动照常拉起。
- **浮层更抗崩**：每个浮层实例用自己独立的 Electron profile——此前同线多实例共用一份，第二个实例起来会抢 GPU 缓存的文件锁、把正在用的浮层渲染进程打死（窗口还在但桌面什么都不显示）；跟随脚本被异常终止时会自动重挂，不再留下「窗口在、跟随已停」的假活状态。
- **自更新内核与 ZCode 线同一套签名校验**（本线自更新默认关闭，装了才用得到）。
- **文档**：安装一节补上「市场源填 GitHub 源」的写法（并注明本线的代码在 \`workbuddy\` 分支）。

---

## wb-v1.0.1 修复：运行时装残检测与浮层重试闸门

- **运行时存在性改三哨兵判定**：`desktop install` 被中断会留下「装了一半」的运行时（electron.exe 在、icudtl.dat / v8_context_snapshot.bin / locales 等缺失），浮层每次启动都死在 `Invalid file descriptor to ICU data received`，桌面永远无挂件 —— 此前只查 electron.exe 存在，装残被当成可用。现在缺任一哨兵即视为未安装，`desktop install` 走修复路径，且装完自检、不完整直接报「下载被中断请重试」。
- **看门狗去掉「连败 3 次就放弃」闸门**：浮层连续启动失败会把 15s 自检打成永久沉默（实测卡在 5/3 后 9 分钟无动作），表现为「挂件再也不出现」。现在宿主在跑就持续重试并如实上报；宿主真不在的情况由退出日志的分流检测兜底（转怠速）。

---

## wb-v1.0.0 新增：移植到 WorkBuddy（积分口径 + 上下文余量）

> 移植规划见 `MIGRATION-PLAN-WORKBUDDY.md`，分阶段实测与决策记录见 `docs/porting/`，
> 宿主契约的实测结论见 `docs/porting/phase-0.md`，交接说明见 `HANDOFF-WORKBUDDY-PORT.md`。
> 基线 = ZCode 线 v1.11.1；本分支版本号另起序列。

- **宿主接入全部换新**：清单 `.zcode-plugin/plugin.json` → `.codebuddy-plugin/plugin.json` + `.codebuddy-plugin/marketplace.json`（`source: "./"`，已在宿主实现层验证合法）；MCP 由清单内联改 `.mcp.json`；钩子由 `type:"process"`+`args`+`timeoutMs` 改 `type:"command"`+bash 字符串+`timeout`（秒）；路径变量 `${ZCODE_PLUGIN_ROOT}` → `${CODEBUDDY_PLUGIN_ROOT}`；数据目录 → 宿主插件数据目录 `${CODEBUDDY_PLUGIN_DATA}`；插件名 `zcode-fox-widget` → `fox-widget`（MCP 工具全名随之变为 `mcp__plugin_fox-widget_whale__*`）。
- **数据源整体替换（主口径改为订阅积分）**：每轮消耗与今日合计改读宿主 `workbuddy.db` 的 `session_usage`（`credit_json` 是宿主算好的积分）与会话 transcript 的 `providerData.rawUsage`；余额与 34 家厂商模板降级为**可选**附加卡（WorkBuddy 默认没有用户自带凭据——实测 `pluginConfigs` 为空、`models.json` 为 `[]`，这是预期而非故障）。
- **新增「上下文余量」**：读 `session_usage.used/size`，气泡小字与每轮消耗气泡显示「上下文 xx%」（ZCode 侧没有的能力）。
- **每日用量聚合改为扫 transcript**：`lib/usage-records.mjs` 重写（按 `conversationRequestId` 归轮、按日汇总宿主 credit；受 60 文件 / 2MB 尾部上限约束，`scannedTranscripts`/`totalTranscripts` 如实暴露范围）。
- **主题跟随改读宿主**：`lib/zcode-theme.mjs` → `lib/host-theme.mjs`，第二层数据源换成 `~/.workbuddy/storage/user-*/global/preferences.json` 的 `theme`；路由 `/whale/zcode-theme.json` → `/whale/host-theme.json`；「跟随 ZCode」→「跟随 WorkBuddy」。
- **凭据发现改扫宿主**：`lib/discover.mjs` 重写（环境变量表 / 宿主 `settings.json` 的 `env` 与 `pluginConfigs` / 插件数据目录的 `apiKey` 与 `vendorKeys`）；`provider_config.json` 与 `zcode-builtin.json` 模板继承路径删除。
- **新增宿主适配层 `lib/host.mjs`**：数据目录、db、主题、进程名、浮层单例特征、环境变量名、事件表差异全部收在一个文件里，把 `git merge main` 的冲突面从「十几个文件散落硬编码」缩到「1 个文件」。
- **浮层适配**：跟随目标换 `WorkBuddy`（`follow-window.ps1` 默认目标进程改名，文件仍保持纯 ASCII）；**移除「宿主启动就绪」门控**（WorkBuddy 的启动标记未实测到可用锚点，而门控失效方向是「鲸鱼永不出现」，比加载期早出现严重得多）——`desktop/ui-ready.cjs` 删除；**随本版带上 ZCode 线 v1.12.0 的两项浮层修复**——窗口加 `type: 'toolbar'`（治「点角色后宿主停止刷新画面」，机制与真机 A/B 见 `OVERLAY-PAUSE-FINDINGS.md`）与单例判定改为只认「本插件运行时的 electron 目录」（治跨产品线互杀，见 `BUGREPORT-CROSS-LINE-OVERLAY-KILL.md`；此前按插件名子串匹配，两端同装时本线角色会在对方启停后被收掉、桌面只剩服务不见角色）。
- **「等确认提醒」换事件源**：WorkBuddy **没有 `PermissionRequest` 事件**，改挂 `Notification`（已知会伴随所有宿主通知触发，故默认关闭，并把原始通知文本记入 `hook-state.json` 便于核实）。
- **自更新默认关闭**：ZCode 式的「原地覆盖所有安装目录」会与宿主的插件管理打架（宿主用目录名 + `installed_plugins.json` 记版本），本分支改为显式设 `FOX_WIDGET_ENABLE_UPDATE_CHECK=1` 才启用；推荐更新方式 = `git pull` + 客户端重抓市场。发版 tag 前缀 `wb-v`，探测读 `workbuddy` 分支并只挑 `wb-v*` 的 release（避免命中 ZCode 线的 tag）。
- **砍掉 GLM Plan 配额**：唯一数据源是 ZCode 客户端日志，宿主无对应物；`lib/plan-balance.mjs` 冻结（导出接口保留，恒返回 `not-supported-on-workbuddy`），`lib/vendors.mjs` 的 `zcode-plan` 模板删除，`/whale/plan.json` 保留但恒返回不支持。
- **保留不动**：34 家厂商模板、记账账本与预警、CommandCode 三重额度（移出主显示留在厂商卡层）、角色与配色、按压泡泡、桌宠模式、出站白名单与本地服务加固。

---

> 以下条目是 `main` 分支的历史记录（移植基线快照）。产品名 **ZCode狐娘小挂件**（`zcode-fox-widget`）。
> 本文件自 fork 以来（v1.1.0 起）每个版本的变更都记在这里；各版本在仓库中均有对应的 tag 与 GitHub Release。相邻的小修复版本按合并策略并入组内最后一个版本号（v1.8.7–v1.8.10 并入 v1.8.9；v1.3.1–v1.3.2 并入 v1.3.3、v1.4.1–v1.4.2 并入 v1.4.3、v1.5.1–v1.5.3 并入 v1.5.4、v1.7.1–v1.7.2 并入 v1.7.3、v1.7.5–v1.7.6 并入 v1.7.7、v1.7.8–v1.7.10 并入 v1.7.11、v1.8.3 并入 v1.8.4、v1.9.0-preview 并入 v1.9.0），中间版本号不再单独发版。

> 命名说明：v1.8.4 及更早的版本发布时，产品曾使用「ZCode 版 DeepSeek 余额小鲸鱼挂件」「Widget of ZCode」等名称；v1.8.5 起统一为 **ZCode狐娘小挂件**（zcode-fox-widget）。下文条目中的产品名一律按新名称书写，功能与修复的描述保持发布当时的原文。

---

> ZCode 线（`main`）v1.1.0–v1.11.1 的历史见 [`docs/CHANGELOG-ARCHIVE.md`](./docs/CHANGELOG-ARCHIVE.md)（原样归档，含移植前的全部变更）。
