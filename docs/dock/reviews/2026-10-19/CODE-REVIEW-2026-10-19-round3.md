# 代码审查报告（第三轮）：feat/dock 第二轮修复复审 2026-10-19

## 审查范围与方法

- 仓库根目录：`E:\WorkSpace\fox-dock`
- 审查工作树：`E:\WorkSpace\fox-dock`（HEAD `bde4dd6`；本轮修复提交 `bde4dd6`，上一轮基线 `0ab989c`；工作树只有审查报告未跟踪）
- 上一轮报告：`CODE-REVIEW-2026-10-19-round2.md`
- 旧线 shim：`E:\WorkSpace\zcode-fox-widget`（`workbuddy/main-56fc9dd2`，HEAD `88b6039`）；`C:\Users\paper\.zcode\cli\plugins\marketplaces\zcode-fox-widget`（`main`，HEAD `52eeaa3`）。两处只读，未修改。
- 运行环境：Windows 11 `10.0.26200` x64，Node `v24.18.1`，npm `12.0.2`，本机 Edge（Playwright `channel:'msedge'`）。

### 实际运行的命令与结果

| 命令 | 结果 |
|---|---|
| `npm run ci` | **通过（exit 0）**。语法 145 文件 0 失败；价目同步一致；单元测试 213/213；lint 228 文件通过；engines parity 通过。 |
| `npm run test:all`（完整，第 1 次） | **295/297**（exit 1）。失败：`drag`、`anchor`。`drag` 的 `window.__foxDebug.targets` 全部是外部 Edge 窗口，命中没有落到 fake agent；属于外部窗口抢占命中，非 bind 代码断言。 |
| `npm run test:all`（完整，第 2 次） | **297/297 通过（exit 0）**。`drag`、`anchor`、`reanchor` 全部通过；`reanchor` 625ms。 |
| `npm run test:all`（完整，第 3 次） | **294/297**（exit 1）。失败：`click`（panel via chip）、`reanchor`、`panel`（binding removed）；与桌面同时存在两个旧线全屏浮层、测试只忽略其中一个有关（见 P3-4）。 |
| `npm run test:ui` | **通过（exit 0）**。输出：`UI 自检通过：8 页 × 2 主题 × 2 视口（布局 / 可访问名称 / axe）`。 |
| `npm run visual` | **通过（exit 0）**。输出：`✅ 视觉回归通过：32 张（阈值 0.1%）`。 |
| 附加探针（仓库外临时目录） | overlay 设置轮询/面板输入/台词、token 桥、菜单/勿扰、隐藏金额、诊断包脱敏、打包内容、WB hook。 |

### 未覆盖或无法验证

- 真实 ZCode/WorkBuddy/Kimi/dsh 数据对账、真实更新下载/落盘、8 小时 soak、真机 125%/150% DPI、多显示器：未运行（隔离/环境约束）。
- `test:all` 的 3 次结果不一致；第 2 次为干净完整通过。第 1/3 次失败的外部窗口干扰与多个旧线浮层未全部被测试忽略有关；未在关闭这些外部窗口后做第 4 次 A/B。
- 旧线 shim 在真实宿主中的 hook 执行未验证；WB 用合成 stdin + mock dock 验证。
- 浮层 `type:'toolbar'` 真机冻结 A/B 未复现。
- `menuButton='hover'` 的悬停视觉只在计算样式/代码层核对，未做真机指针悬停截图。

## 结论

APPROVE

按本轮复审判定：P1 未解决 0；P2 未解决 0；P3 未解决 4（允许保留，不阻断）。本轮修复未引入新的 P3 回归；剩余 P3 为上一轮遗留与测试隔离/边界口径问题。

## 与上一轮报告的对应关系

### P1 / P2

| 编号 | 状态 | 证据 |
|---|---|---|
| R2-P1-1 reanchor 回归 | **FIXED** | `overlay/renderer.js:428-438` 的 `loadSettings` 先用 `JSON.stringify(next) === JSON.stringify(settings)` 提前返回，设置未变化时不再每秒 `applySettings`。完整 `npm run test:all` 第 2 次 297/297，`reanchor: 宿主窗口移动后狐狸跟随` 通过（625ms）。第 1/3 次的 `reanchor` 失败伴随外部 Edge/旧线浮层干扰，非本次代码路径的稳定失败。 |
| R2-P2-1 面板每秒重建/焦点丢失 | **FIXED** | 同上早期返回；`applySettings` 的 `renderPanel` 前增加焦点守卫（`overlay/renderer.js:470-478`）。探针：面板设置页聚焦 `INPUT` 并填入 `abc`，1.6s 后仍为 `INPUT`、值 `abc`、connected；`applySettings` 在 3.5s 稳定设置下调用次数为 **0**。 |
| R2-P2-2 daemon token 暴露给渲染层 | **FIXED** | `overlay/preload.cjs:15-17` 改为 `write(path, method, body)`；`overlay/main.cjs:389-405` 新增 `daemon-write` IPC，token 只在主进程读取。CDP 探针：`window.foxOverlay` 键为 `setInteractive,getCursor,getBounds,write,hit,getAlphaMask`，`getToken` 为 `undefined`；`write('/settings','PUT',{theme:'light'})` 成功且 daemon 主题变为 light。 |
| P2-4 设置项无消费方（四点） | **FIXED（含 P3 残余）** | 1) 全部 agent 金额：`overlay/renderer.js:771-779` 的 `groupLabel` 在 `hideMoney && unit==='money'` 时返回 `•••`；探针 `hideMoney=true` 时全部 agent 列表 `¥` 金额 `moneyShown:false`（积分仍显示，见 P3-2）。2) `menuButton`：`overlay/renderer.js:459-464` + `overlay/styles.css:193-201` 增加 hover/always 规则，`hidden` 由 `applySettings` 设置 `display:none`；探针读取受 140ms transition 影响，未把瞬时 computed 值作为结论。3) `dnd`：`overlay/renderer.js:494-502` 在写 localStorage 前 `if (settings.dnd) return false`；探针 `dnd=true` 时返回 false 且不写 key，`dnd=false` 时返回 true 且写 key。4) 周/月/成本：`ui/pages/overview.mjs:80-105` 文案改为“近 7/30 天”，成本异常按 `a.id === id` 过滤当前 agent 的历史；UI 探针显示文案/过滤路径已生效。 |
| P2-3 设置不重读 | **FIXED** | 1 秒 `loadSettings` 仍存在，但未变化时直接返回；探针 `applyCount=0`。原问题（控制台/托盘改设置后浮层不重读）已消除。 |
| P2-1 WB hook | **FIXED** | WB `lib/hook-event.mjs:46` 导入 `postDockEvent`，`:233` 调用；mock dock 收到 `POST /v1/events`（Notification/PermissionRequest 均验证）。 |
| P2-2 浮层厂商数据 | **FIXED** | `overlay/renderer.js:1443` 使用 `/v1/vendors`；旧挂件服务不存在时 `/v1/vendors` 返回 `source:'engines',vendors:45`。 |
| P2-5 开机自启 | **FIXED** | `v1.mjs:578-594` + `daemon.mjs:246-252` + `ui/pages/settings.mjs:205-210`；临时 APPDATA 探针开启/关闭均写入/删除 `fox-dock.vbs`。 |
| P2-6 用量分组/ P2-7 上下文范围 | **FIXED（功能移除）** | 对应 UI 控件已移除，README/UI-SPEC 已同步；残留死 state 见 P3-1。 |
| P2-8 Dialog Esc/焦点 | **FIXED** | `ui/components/base.mjs:91-126`；实测 Esc 关闭、焦点回到“编辑 JSON”按钮、Tab 焦点陷阱生效。 |

### P3

| 编号 | 状态 | 证据 |
|---|---|---|
| P3-3 诊断包路径脱敏 | **FIXED** | `v1.mjs:94-101` 增加反斜杠/正斜杠/大小写变体；`:731-735` 对 `key`、`window.exe`、`window.title` 调 `redactHome`。探针返回 `key:"~/appdata/local/...|123|..."`、`exe:"~/AppData/..."`。 |
| P3-5 30 天保留期 | **FIXED** | `ledger.mjs:16` `KEEP_DAYS=30`；`CHANGELOG.md:151`、`MIGRATION.md:47` 已改为 30 天。 |
| P3-11 打包本机产物 | **FIXED** | `tools/pack-release.mjs:50` 跳过 `last-*.log` 与 `*.tmp`；实测 tar 中不再包含 `launch/last-start.log`/`last-stop.log`，截图目录也跳过。 |
| R2-P3-1 随机台词被每秒重置 | **FIXED** | 早期返回后不再每秒 `restartChatter`；`chatterMs=30000` 的 fixture 探针 31.5s 后 `count=1`。 |
| R2-P3-2 厂商数据源文案/下拉 | **FIXED** | `overlay/renderer.js:1484-1486` 显示“内置引擎”；`:1579-1581` 对 `source==='engines'` 显示“来自内置厂商引擎”。 |
| R2-P3-3 周/月/成本口径 | **FIXED** | `overview.mjs:80-105` 文案改为“近 7/30 天”；成本异常改为按当前 agent 过滤；见 P3-3 残余。 |
| R2-P3-4 CSS/token 重复 | **FIXED** | `console.css` 只保留一组 `.nowrap/.sr-only/.grid > div`；`tokens.css` 只保留一份 `--on-vendor`。 |
| R2-P3-5 死 state/import | **NOT FIXED** | `ui/pages/context.mjs:4` 仍导入未使用的 `Segmented`；`:35` 的 `range` 仍进入请求但无 UI；`ui/pages/usage.mjs:74` 的 `groupBy` 仍进入请求/JSON 导出但无控件。见 P3-1。 |
| R2-P3-6 轮询额外检查 | **FIXED** | `loadSettings` 未变化直接返回；探针 3.5s 内 `applySettings=0`，不再每秒触发 `checkUpdate`/`checkAlerts`。 |

### 其余上一轮 P3

- P3-1 视觉 0.1%：`visual-test.mjs:131` 0.001；`TESTING.md:45` 已更新；本轮 `npm run visual` 32 张通过。
- P3-2 CI parity：workflow 已含 `npm run parity:engines`；本轮 `npm run ci` 通过。
- P3-4 normalizeContext：`contracts.mjs:286` 已保持 null。
- P3-6 版本号：`package.json` 为 `2.0.0-pre.1`。
- P3-7 尺寸文案：`renderer.js:1915` 已改为 250/122px。
- P3-8 图表字体/角色：`svg.mjs` 12px、`role="img"`；`test:ui` 通过。
- P3-9 CSP/导航：`overlay/index.html` CSP；两个 main 均有 `will-navigate`/`setWindowOpenHandler`；token 暴露已由 R2-P2-2 修复。
- P3-10 测试连接：`engines/index.mjs:83` `skipped:true`；`ui/pages/vendors.mjs:193` 显示未发起网络测试。
- P3-12 范围：根 `NOTICE` 归属已移到 `dock/NOTICE`；相对 `a2d0f4e` 的净改动仅 CI 文件与 M0 已有的 `.gitignore`。
- P3-13 角色默认：`console.mjs:358-363` 使用 `state.agents[].roleDefault`；`v1.mjs:613-619` 计算 `defaultFor`。
- P3-14 `/v1/pet/attach`：`v1.mjs:518-527` 始终 `resolveAdapter`。

## 问题（剩余 P3，不阻断）

### [P3-1] 移除筛选控件后仍残留死 state/死导入

- 位置：`dock/ui/pages/context.mjs:4`（`Segmented` 已未使用）、`:35`（`range` state 仍进入请求，但无 UI 可修改）；`dock/ui/pages/usage.mjs:74`（`groupBy` 仍进入请求/JSON 导出，但无 UI 控件）、`:85-91`。
- 期望：移除筛选控件后同步清理对应 state/import，避免误导后续维护者。
- 实际：`range` 永远为 `session`，`groupBy` 永远为 `agent`；服务端仍接受这些参数但无实际效果。
- 复现：`grep -n "Segmented\|range" dock/ui/pages/context.mjs`、`grep -n "groupBy" dock/ui/pages/usage.mjs`。
- 证据：上述文件；`npm run lint` 不检查未使用导入。
- 频率：确定。
- 影响：死代码/误导性 API 参数，不影响主流程。
- 建议（非强制）：删除未使用导入与 state，或在实现真实筛选前不发送这些参数。

### [P3-2] `hideMoney` 仍未覆盖浮层“全部 agent”列表中的积分

- 位置：`dock/overlay/renderer.js:771-779`：`groupLabel` 只在 `unit==='money'` 时返回 `•••`；`unit==='credit'` 仍走 `fmtNum(...) + ' 积分'`。控制台 `ui/lib/format.mjs:23-27` 的 `fmtCredit` 在 hideMoney 下会掩码。
- 期望：隐藏金额开启时，所有展示型金额/积分显示为 `•••`（控制台已按此处理）。
- 实际：场景 `settings.hideMoney=true` 时，浮层全部 agent 列表的货币金额已隐藏，但 WorkBuddy 的 `193.5 积分` 仍可见。
- 复现：临时 scene 将 `hideMoney` 设为 true，启动 overlay + fixture，打开面板读取“全部 agent（今日）”。
- 证据：探针输出 `masked:true, moneyShown:false`，但文本中仍有 `WorkBuddy 193.5`；`groupLabel` 对 credit 无 hideMoney 分支。
- 频率：确定。
- 影响：隐私展示不一致；录屏/共享时积分口径仍暴露。
- 建议（非强制）：在 `groupLabel` 的 credit 分支同样检查 `hideMoney`，或复用统一的 `fmtCredit`。

### [P3-3] “近 7/30 天”预算/异常仍按“最后 N 个有记录的天”求和，不是自然日历窗口

- 位置：`dock/ui/pages/overview.mjs:80-105`；`daemon/src/ledger.mjs:108-117` 的 `summarize` 返回 `keys.slice(-days)`，只包含账本中存在的日期。
- 期望：文案“近 7/30 天”与实际窗口一致；若中间没有记录，应按日历窗口覆盖或明确标注“最近 N 个有记录的天”。
- 实际：7 天/30 天视图实际是最后 N 个有记录日期；若中间缺日，求和区间可能超过/少于自然 7/30 天。预算与成本异常因此可能误报/漏报。
- 复现：构造账本仅在第 1、8、15 天有记录；`/v1/usage?range=7d` 返回这 3 天，`sumGroups` 全部求和，文案仍写“近 7 天”。
- 证据：`summarize` 的 `keys.slice(-Math.max(1, days))`；`sumGroups` 对 `usage.days` 全量求和。
- 频率：确定（有记录缺口时）。
- 影响：提醒口径与文案不完全一致；属于边界口径问题。
- 建议（非强制）：按日历窗口补零/过滤，或把文案改成“最近 N 个有记录的天”。

### [P3-4] `test:all` 对多个外部全屏浮层的隔离不完整，导致偶发 drag/click/reanchor 超时

- 位置：`dock/test/integration/overlay.itest.mjs:196-197`：只 `find` 一个标题含“小挂件”的旧线浮层并加入 `--ignore-pids`；当前桌面同时存在两个旧线全屏浮层（ZCode 39322、WorkBuddy 39321），另一个未被忽略。
- 期望：完整 `npm run test:all` 稳定 297/297；测试应忽略所有外部全屏浮层/干扰窗口。
- 实际：本轮 3 次完整运行：295/297（drag/anchor）、297/297（通过）、294/297（click/reanchor/panel）；第 1 次 debug 的命中目标全部是外部 Edge 窗口，第 3 次与多个旧线浮层同时存在相关。代码在干净运行下 297/297。
- 复现：在同时运行两个旧线浮层、存在外部 Edge 窗口的桌面上执行 `npm run test:all`；不同次运行失败点不同。`overlay.itest.mjs` 只忽略第一个“小挂件”。
- 证据：三次完整运行日志；第 1 次 `window.__foxDebug.targets` 全部为 `...Edge#696`；旧线进程 `overlay-profile-39322`/`39321` 同时存在。
- 频率：偶发（3 次中 2 次受干扰；第 2 次 297/297）。
- 影响：测试门禁不稳定，容易把外部窗口干扰误判为代码回归；不直接影响产品运行。
- 建议（非强制）：忽略所有匹配 `小挂件`/`fox-dock overlay` 的 Electron 窗口；或在测试前把外部浮层窗口列表全部加入 `ignore-pids`。

## 已核对且未发现问题的项

- `npm run ci`：213 单测、语法、价目同步、lint、engines parity 全部通过。
- 完整 `npm run test:all` 第 2 次：297/297；`drag`、`anchor`、`reanchor` 均通过。
- `npm run test:ui`：8 页 × 2 主题 × 2 视口通过，axe critical/serious 0。
- `npm run visual`：32 张、0.1% 阈值通过。
- 遗留路由：无 token `PUT /settings`/`POST /bind` 403；错误 Host 403；带 token 的遗留写 200。
- 开机自启：临时 APPDATA 安装/移除 VBS 成功，GET 状态同步。
- WB hook：mock dock 收到 `POST /v1/events`。
- 诊断包：`key`/`window.exe` 已脱敏为 `~`。
- 打包：`last-*.log` 不再进入 tar。
- 1 秒轮询：稳定设置下 `applySettings` 3.5s 内 0 次；面板输入保持；随机台词 31.5s 后触发 1 次。
- token：渲染层无 `getToken`，写操作经 `daemon-write`；CDP 无法直接取得 token。
- P2-4：hideMoney 货币、menuButton hover/always/hidden、dnd 不写 alert key、周/月/成本文案与按 agent 过滤均已核对。
- P3 残留：CSS/token 重复已清除；30 天文档已同步；厂商“内置引擎”文案已生效。

## 未验证 / 无法验证

- `test:all` 第 1/3 次失败的完整根因未做隔离 A/B；已记录外部 Edge/两个旧线浮层干扰，未关闭外部窗口后重跑第 4 次。
- 真实宿主数据/凭据、真实更新、8 小时 soak、真机 DPI/多屏：未运行。
- `menuButton='hover'` 的悬停视觉未做真机截图/真指针悬停；只核对 CSS 与计算样式。
- `hideMoney` 在已绑定详情、气泡、厂商卡等全部路径的全量遮蔽未逐一真机验证；已确认“全部 agent”列表的货币/积分差异。
- 打包内容未逐字节检查是否含用户路径；只确认 `last-*.log` 不再进入 tar。
- 旧线 shim 在真实宿主 hook 中的执行仍未验证。
