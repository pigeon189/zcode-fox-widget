# 代码审查报告（第二轮）：feat/dock 修复提交复审 2026-10-19

## 审查范围与方法

- 仓库根目录：`E:\WorkSpace\fox-dock`
- 审查工作树：`E:\WorkSpace\fox-dock`（HEAD `0ab989c`；修复提交 `9d4fb92`，CI 提交 `0ab989c`；工作树只有两份审查报告未跟踪）
- 上一轮报告：`CODE-REVIEW-2026-10-19.md`（`146adb4` 时的 10 个提交 + 工作树）
- 旧线 shim：`E:\WorkSpace\zcode-fox-widget`（`workbuddy/main-56fc9dd2`，HEAD `88b6039`）；`C:\Users\paper\.zcode\cli\plugins\marketplaces\zcode-fox-widget`（`main`，HEAD `52eeaa3`）。两处只读，未修改。
- 运行环境：Windows 11 `10.0.26200` x64，Node `v24.18.1`，npm `12.0.2`，本机 Edge（Playwright `channel:'msedge'`）。

### 实际运行的命令与结果

| 命令 | 结果 |
|---|---|
| `npm run ci` | **通过（exit 0）**。语法 145 文件 0 失败；价目同步一致；单元测试 213/213；lint 228 文件通过；engines parity 通过。 |
| `npm run test:all` | **失败（exit 1）**。297 个测试中 296 通过、1 失败：`reanchor: 宿主窗口移动后狐狸跟随（500ms 轮询）` 超时。 |
| 单测重跑：`node --test --test-concurrency=1 --test-name-pattern "reanchor" test/integration/overlay.itest.mjs` | **3 次全部失败（3/3）**，均为 `timeout: fox re-anchored`。 |
| `npm run test:ui` | **通过（exit 0）**。输出：`UI 自检通过：8 页 × 2 主题 × 2 视口（布局 / 可访问名称 / axe）`。 |
| `npm run visual` | **通过（exit 0）**。输出：`✅ 视觉回归通过：32 张（阈值 0.1%）`。 |
| 附加探针（均在仓库外临时目录） | 遗留路由安全、开机自启、导入明文密钥、WB hook 转发、Dialog Esc/焦点、overlay 1s 设置轮询、token 暴露、hideMoney、打包内容。 |

### 未覆盖或无法验证

- 真实 ZCode/WorkBuddy/Kimi/dsh 数据对账、真实更新下载/落盘、8 小时 soak、真机 125%/150% DPI、多显示器：与上一轮相同，未运行（隔离/环境约束）。
- 旧线 shim 在真实宿主中的 hook 执行未验证；WB 用合成 stdin + 本机 mock dock 验证。
- 浮层 `type:'toolbar'` 真机冻结 A/B 未复现。
- `reanchor` 失败的根因未做“去掉轮询”的隔离 A/B；但该用例上一轮通过、本轮 3/3 失败，且本轮唯一影响 follow 时序的改动是新增 1 秒设置轮询。

## 结论

REQUEST_CHANGES

按本轮复审判定的未解决数量：P1 = 1（跟随/reanchor 回归）；P2 = 3（P2-4 部分修复，新 P2-1 面板输入、新 P2-2 token 暴露）；P3 = 9（上一轮 P3-3/P3-5/P3-11 仍为部分修复，加上本轮 P3-1～P3-6）。

## 与上一轮报告的对应关系

### P1

| 编号 | 状态 | 证据 |
|---|---|---|
| P1-1 遗留路由绕过 `/v1` 令牌/Host | **FIXED** | `dock/daemon/src/daemon.mjs:125-135` 新增 `legacyHostAllowed`；`:279-291` 对全部遗留路由校验 Host、对 `/settings` 与 `/bind` 写路由校验 `x-fox-token`。实测：无 token `PUT /settings` → 403 `bad-token`；无 token `POST /bind` → 403；`Host: evil.example` 的 `GET /settings` → 403 `bad-host`；带 token 的 `PUT /settings`/`POST /bind` → 200。 |
| P1-2 旧挂件导入写明文密钥 | **FIXED** | `dock/daemon/src/import-old.mjs` 删除 `vendorConfig` 类别与 `importVendorConfig`；`dock/test/unit/import-old.test.mjs:64-84` 改为断言不生成 `vendor-config.json`。实测该单测 3/3 通过。残留观察（不阻断）：`engines/paths.mjs:42` 仍把 `vendor-config.json` 作为读取源，`engines/credentials.mjs:132-152` 的 `writePluginConfig` 仍能写明文 key，但已无调用方；属于既有代码而非本次导入路径回归。 |

### P2

| 编号 | 状态 | 证据 |
|---|---|---|
| P2-1 WB hook 事件不转发 | **FIXED** | `E:\WorkSpace\zcode-fox-widget\lib\hook-event.mjs:46` 已 `import { postDockEvent }`；`:233` 调用。复跑 WB 探针（mock dock）：`Notification`/`PermissionRequest` 均收到 `POST /v1/events`，带 token，body 正确，exit 0。 |
| P2-2 浮层厂商页依赖旧挂件服务 | **FIXED（核心）** | `dock/overlay/renderer.js:1443` 改为 `/v1/vendors`。在 `FOX_DOCK_VENDOR_PORTS=39991,39992`（旧服务不存在）下，`/v1/vendors` 返回 `source:'engines', vendors:45`。新残留 P3：浮层厂商页的“数据源”下拉仍写 ZCode/WorkBuddy 挂件、`adapter` 参数被 `/v1/vendors` 忽略；`renderer.js:1578-1580` 仍按 `vendorState.source.app/version/port` 取值，而真实响应 `source` 是字符串 `'engines'`，会显示 `来自 undefined v? · 端口 undefined`。见本轮 P3-2。 |
| P2-3 控制台/托盘改设置后浮层不重读 | **FIXED（原问题）** | `dock/overlay/renderer.js:2783-2785` 每 1 秒 `loadSettings()`；`loadSettings` → `applySettings` 会重新读取并应用。原问题已消除，但该 1 秒轮询引入新的 P1/P2 回归（见本轮 P1-1、P2-1）。 |
| P2-4 多个设置项无消费方 | **PARTIAL** | 已修复：`hideMoney` 在控制台 `ui/lib/format.mjs:4-26` 与浮层 `overlay/renderer.js:458/584` 生效；`dnd` 在 `overlay/renderer.js:252/370` 抑制台词/气泡；`menuButton` 在 `:459-464` 处理 hidden/always；周/月预算、余额预警、成本异常在 `ui/pages/overview.mjs:80-101` 接入。仍未完全满足：<br>1) 浮层“全部 agent（今日）”仍直接输出金额：`overlay/renderer.js:766-775` 的 `groupLabel` 不检查 `hideMoney`；实测 `settings.hideMoney=true` 时面板仍显示 `¥12.34`/`¥1.08`。<br>2) `menuButton='hover'` 仍保留 CSS 默认 `opacity:.5`（`overlay/styles.css:173-193`），不是“悬停才显示”。<br>3) `dnd` 下 `alertOnce` 先写 localStorage 再调用被抑制的 `showBubble`，当天提醒会被消耗（`overlay/renderer.js:490-498`）。<br>4) 周/月预算按滚动 7/30 天求和却显示“本周/本月”，成本异常用当前 agent 今日对比全部 agent 均值（见本轮 P3-3）。 |
| P2-5 开机自启只写布尔值 | **FIXED** | `dock/daemon/src/v1.mjs:578-594` 新增 `/v1/maintenance/autostart`；`daemon.mjs:246-252` 调用 `installLauncher`/`uninstallLauncher`；`ui/pages/settings.mjs:205-210` 调用该接口。临时 `APPDATA` 探针：开启 → `fox-dock.vbs` 存在且 GET `installed:true`；关闭 → 文件删除且 `installed:false`。 |
| P2-6 用量页分组筛选无效果 | **FIXED（功能移除）** | `ui/pages/usage.mjs` 删除“按 Agent/厂商/模型”控件；`README.md` 与 `UI-SPEC.md` 改为只按 Agent。残留 P3：`groupBy` state 仍进入请求/JSON 导出但无 UI；服务端仍返回 `models:[]`。 |
| P2-7 上下文页范围筛选无效果 | **FIXED（功能移除）** | `ui/pages/context.mjs` 删除范围 Segmented；`UI-SPEC.md` 删除“范围”。残留 P3：`range` state 仍进入请求，且 `Segmented` 导入已未使用。 |
| P2-8 Dialog 不能 Esc 关闭/焦点不恢复 | **FIXED** | `dock/ui/components/base.mjs:91-126` 增加 Esc、Tab 焦点陷阱与卸载时 `previous.focus()`。实测：打开“编辑 JSON”后 Esc → dialog 数量 0；焦点恢复为“编辑 JSON”按钮。 |

### P3

| 编号 | 状态 | 证据 |
|---|---|---|
| P3-1 视觉阈值 0.2% 与文档 | **FIXED** | `dock/tools/visual-test.mjs:131` 改为 0.001；`TESTING.md:45` 改为已接入 0.1%。实测 `npm run visual` 输出“阈值 0.1%”，32 张通过。 |
| P3-2 CI 缺 engines parity | **FIXED** | `.github/workflows/dock-ci.yml` 新增 `npm run parity:engines` 步骤。 |
| P3-3 `/v1/diag/bundle` 路径未脱敏 | **PARTIAL** | `v1.mjs:727-730` 只对 `window.exe`/`window.title` 调 `redactHome`；`key` 仍是完整规范化路径。实测绑定 exe 为 `C:/Users/<user>/...` 时，诊断包返回 `key: "c:/users/<user>/...|123|..."`，且 `window.exe` 因正斜杠与 `USERPROFILE` 反斜杠不匹配也未替换。 |
| P3-4 normalizeContext 缺 used 补 0 | **FIXED** | `adapters/contracts.mjs:286` 改为 `finiteOrNull(r.used)`。实测 `normalizeContext({supported:true,limit:1000})` → `used:null, pct:null`。 |
| P3-5 30 天 UI 与 14 天保留期 | **PARTIAL** | 代码 `ledger.mjs:16` 已改为 `KEEP_DAYS=30`，`ledger.test` 已更新；但 `dock/CHANGELOG.md:151` 与 `docs/dock/MIGRATION.md:47` 仍写“保留 14 天”。 |
| P3-6 版本号 2.0.0 vs 2.0.0-pre.1 | **FIXED** | `dock/package.json:3` 已改为 `2.0.0-pre.1`；CLI/daemon 版本输出同步；`compareVersions('2.0.0-pre.1','2.0.0-pre.1')=0`、`('2.0.0-pre.2','2.0.0-pre.1')=1`。 |
| P3-7 浮层“标准档 123px”旧文案 | **FIXED** | `overlay/renderer.js:1913` 改为“标准档约 250px（小屏自动回落到 122px）”。 |
| P3-8 图表 10px/缺 role/18px | **FIXED** | `ui/charts/svg.mjs` 轴文字改为 12px；StackedBar/MiniBar 增加 `role="img"`/`aria-label`；`console.css` 不再有 18px 标题。`npm run test:ui` 现在检查 SVG 字体并通过。 |
| P3-9 浮层无 CSP/无导航拦截 | **FIXED** | `overlay/index.html:6` 增加 CSP；`overlay/main.cjs:337-340`、`console/main.cjs:165-169` 增加 `will-navigate` 与 `setWindowOpenHandler`。新回归见本轮 P2-2（token 暴露）。 |
| P3-10 测试连接假成功 | **FIXED** | `engines/index.mjs:83` 返回 `skipped:true` 与“未发起网络测试”；`ui/pages/vendors.mjs:193` 显示“凭据已存在（未发起网络测试）”。 |
| P3-11 打包包含本机产物 | **PARTIAL** | `tools/pack-release.mjs:26` 已跳过 `__shots__`/`__diff__` 等；但未跳过 `launch/last-*.log`。实测打包内容仍含 `dock-2.0.0-pre.1/launch/last-start.log` 与 `last-stop.log`。 |
| P3-12 改动超出规定目录 | **FIXED** | 根 `NOTICE` 的 dock 归属已移到 `dock/NOTICE`；`docs/INDEX.md` 已还原。相对上一轮基线 `a2d0f4e`，`dock/`/`docs/dock/` 之外的净改动只剩 CI 文件与 M0 已有的 `.gitignore`（非本次修复引入）。 |
| P3-13 控制台忽略适配器默认角色 | **FIXED** | `ui/console.mjs:358-363` 现在优先使用 `state.agents[].roleDefault`；`v1.mjs:613-619` 为 `/v1/roles` 计算 `defaultFor`。 |
| P3-14 `/v1/pet/attach` 信任客户端 agentId | **FIXED** | `v1.mjs:518-527` 始终调用 `resolveAdapter` 并以其 `id` 写入；测试改为传 exe/title。 |

## 问题（本轮新发现）

### [R2-P1-1] 新增的 1 秒设置轮询打断了跟随：`reanchor` 集成测试 3/3 失败

- 位置：`dock/overlay/renderer.js:2783-2785`（每 1 秒 `loadSettings`）、`:424-436`（`loadSettings` → `applySettings`）、`:457-474`（`applySettings` 每次 `restartFollowTimer()` 并 `placeByAnchor(lastBoundRect)`）；相关测试 `dock/test/integration/overlay.itest.mjs:505-530`。
- 期望：绑定后宿主窗口移动，狐狸在跟随间隔内重新贴回窗口（上一轮该用例通过；`docs/dock/TESTING.md:53` 只把 `anchor` 列为偶发，未列 `reanchor`）。
- 实际：`npm run test:all` 297 个测试中该用例失败；单独重跑 3 次全部失败（3/3），错误均为 `timeout: fox re-anchored`。
- 复现：
  1. `cd dock && npm run test:all` → `tests 297 / pass 296 / fail 1`。
  2. `node --test --test-concurrency=1 --test-name-pattern "reanchor" test/integration/overlay.itest.mjs` 连续 3 次 → 均 fail。
- 证据：`r2-test-all.log` 与 3 次单跑输出；本轮唯一影响 follow 时序的改动是 1 秒 `loadSettings` 轮询（`applySettings` 每次重启 follow timer 并重放 `lastBoundRect`）。未做“去掉轮询”的隔离 A/B，因此“轮询为唯一根因”标注为推断；但“上一轮通过、本轮 3/3 失败”是确定事实。
- 频率：确定（3/3）。
- 影响：窗口移动后狐狸不再跟随，属于核心吸附跟随流程回归；`npm run test:all` 门禁变红。
- 建议（非强制）：轮询只在设置内容变化时调用 `applySettings`；不要每秒 `restartFollowTimer`/`placeByAnchor`；跟随位置只在 follow timer 或真实设置变化时更新。

### [R2-P2-1] 1 秒轮询在面板打开时每秒重建面板，输入框被销毁、焦点丢失

- 位置：`dock/overlay/renderer.js:2783-2785`（轮询）、`:424-436`（每次都 `applySettings`）、`:474`（`if (panelOpen) renderPanel(...)`）；面板输入见 `:1030-1044`（搜索框）、`:1854-2125`（设置项）。
- 期望：面板打开时用户可以连续输入/选择；上一轮 `refreshSummary` 特意有 `typing` 守卫避免 5 秒刷新丢焦点（`overlay/renderer.js:2277-2292` 一带）。
- 实际：每秒 `loadSettings` → `applySettings` → `renderPanel` → `clearNode(panelBody)`，输入框被删除。实测：聚焦设置页文本框并填入 `abc` 后 1.6 秒，`document.activeElement` 从 `INPUT` 变为 `BODY`，输入框不再连接；面板仍为打开状态。
- 复现：
  1. 启动 fixture daemon 与 overlay（`--no-click-through --data-dir=<temp>`）。
  2. CDP：`togglePanel(true); setActiveTab('settings'); renderPanel(null,[])`。
  3. 聚焦 `#panel input[type=text]`，填入 `abc`，等待 1.6 秒。
- 证据：临时探针实际输出：`before {"tag":"INPUT","value":"abc","connected":true}` → `after {"tag":"BODY","connected":true,"panelOpen":true}`。
- 频率：确定。
- 影响：浮层设置页/搜索框无法正常输入；用户每敲一个字都可能被重建，属于可用性回归。
- 建议（非强制）：轮询只更新 `settings`，仅在内容 diff 时调用 `applySettings`；`applySettings` 中 `renderPanel` 增加与 `refreshSummary` 相同的输入焦点守卫。

### [R2-P2-2] 浮层渲染层现在可以直接取得 daemon 写令牌，违反 UI-SPEC 的令牌隔离

- 位置：`dock/overlay/main.cjs:388-392`（`ipcMain.handle('daemon-token', ...)` 返回 lock token）、`dock/overlay/preload.cjs:15-17`（`getToken`）、`dock/overlay/renderer.js:420-423`（`writeHeaders` 把 token 放进 fetch）、`:2769-2773`（启动时取 token）；规范 `docs/dock/UI-SPEC.md:14`：“渲染层不接触 Node 与 daemon 令牌：所有请求经 preload → 主进程 IPC。”
- 期望：渲染层不持有 daemon token；写操作由主进程代理（控制台已经这样实现）。
- 实际：overlay 渲染层调用 `window.foxOverlay.getToken()` 即可取得完整 32 字符 token；实测 `getToken()` 返回值与 `daemon.lock` 的 token 完全一致。
- 复现：
  1. 启动真实 daemon（临时数据目录）与 overlay（`--data-dir=<temp>`）。
  2. CDP 在 overlay 页面执行 `await window.foxOverlay.getToken()`。
  3. 与 `daemon.lock` 的 token 比较。
- 证据：探针输出 `{"tokenMatches":true,"tokenLength":32}`。
- 频率：确定。
- 影响：任何 overlay 渲染层代码/注入都能读取写令牌并调用 `/shutdown`、`/bind`、`/v1/settings` 等；与 UI-SPEC 的隔离约定直接冲突。当前 overlay 无远程内容且有 CSP/导航拦截，风险被降低，但边界已失效。
- 建议（非强制）：不要在 preload 暴露 token；在 main 进程增加 `daemon-write` IPC，由 main 读取 `daemon.lock` 后代理请求（与控制台 `api` 一致），渲染层只传 path/body。

### [R2-P3-1] 1 秒轮询每秒重置随机台词计时器，随机台词永远不会触发

- 位置：`dock/overlay/renderer.js:337-346`（`restartChatter` 清掉并重建 30 秒以上 interval）、`:469`（每次 `applySettings` 都调用 `restartChatter`）、`:2783-2785`（每秒调用 `applySettings`）。
- 期望：设置 `chatterMs=30000` 时约 30 秒后角色说一句（`docs/dock/CHANGELOG.md:21` 的随机台词功能）。
- 实际：每 1 秒重建 interval，30 秒计时永远不到。实测把 `sayRandom` 替换为计数器、`settings.chatterMs=30000`、关闭面板后等待 31.5 秒，计数为 0，`chatterTimer` 仍存在。
- 复现：overlay CDP：`sayRandom=()=>window.__r2chatter++`；`settings.chatterMs=30000; restartChatter();`；关闭面板；31.5 秒后读取计数。
- 证据：探针输出 `{"chatterBefore":{"timer":true},"chatterAfter":{"count":0,"timer":true}}`。
- 频率：确定。
- 影响：随机台词功能被静默禁用；用户不会收到任何错误。
- 建议（非强制）：仅在 `chatterMs` 变化时重启 chatter timer，或在 `applySettings` 中比较旧值。

### [R2-P3-2] 浮层厂商页切换到 engines 后，数据源说明和下拉框仍是旧挂件语义

- 位置：`dock/overlay/renderer.js:1443`（改用 `/v1/vendors`）、`:1481-1482`（下拉仍写“ZCode 挂件/WorkBuddy 挂件”，`adapter` 参数被 `/v1/vendors` 忽略）、`:1578-1580`（按 `vendorState.source.app/version/port` 生成说明）；真实 `/v1/vendors` 响应 `source:'engines'`（`daemon/src/v1.mjs:153-155`）。
- 期望：数据源应说明“内置 engines/45 模板”，下拉框若不再影响数据，应移除或禁用。
- 实际：真实 daemon 返回 `source:'engines'` 字符串，`vendorState.source.app`/`version`/`port` 都是 undefined，说明会显示“来自 undefined v? · 端口 undefined”；切换下拉框不会改变任何数据。
- 复现：启动临时 daemon，`GET /v1/vendors` 返回 `{source:'engines',vendors:45}`；打开 overlay 厂商页读取说明文本；或直接阅读 `renderer.js:1578-1580`。
- 证据：daemon 探针输出 `v1Vendors: {ok:true, source:'engines', vendors:45}`。
- 频率：确定。
- 影响：误导用户以为数据来自旧挂件；一个无可选项的下拉框仍可点击。
- 建议（非强制）：对 `source==='engines'` 显示“内置厂商引擎”；移除 `adapter` 下拉或改为真正的数据源切换。

### [R2-P3-3] 周/月预算与成本异常提醒的口径不一致（滚动窗口/跨 agent 混用）

- 位置：`dock/ui/pages/overview.mjs:80-101`：`weekTotal` 用 7 天 API 的 `days` 求和、`monthTotal` 用 30 天 API 的 `days` 求和，但文案写“本周/本月”；`costAnomaly` 的 `avg` 是所有 agent 的 7 天金额均值，`today` 是当前 `snap`（当前 agent）的今日金额。
- 期望：预算“周/月”应按自然周/月或明确写“近 7/30 天”；成本异常应按同一 agent/同一范围比较。
- 实际：有记录缺口时“本周”可能跨过 7 个自然日；成本异常会把 ZCode 的今日金额与 ZCode+WorkBuddy+dsh 的历史均值比较，产生误报/漏报。
- 复现：构造账本：昨日/前日只有 WorkBuddy 大额记录、今日只有 ZCode 小额记录；设置 `costAnomalyX` 后打开总览，`avg` 被其它 agent 抬高。或阅读 `overview.mjs:91-101`。
- 证据：上述代码；fixture 场景 `costAnomalyX=2` 时总览实际出现“今日用量是近 7 日均值的 2.2 倍”。
- 频率：确定。
- 影响：预算/异常提醒可能给出错误结论；用户可能据此误判成本。
- 建议（非强制）：明确“近 7/30 天”文案，或按日历周/月聚合；成本异常按当前 agent 的 7 日均值比较。

### [R2-P3-4] 修复提交重复插入了 CSS 规则和 token 变量

- 位置：`dock/ui/console.css:66-83`、`:184-201`、`:238-255`（`.nowrap`/`.sr-only`/`.grid > div` 各重复 3 次）；`dock/ui/tokens.css:69-70`（`--on-vendor` 连续出现两次，其中一行缩进异常）。
- 期望：同一规则只定义一次；`UI-SPEC.md:3` 规定数值以 `ui/tokens.css` 为准。
- 实际：重复定义内容相同，当前不影响渲染，但后续修改容易只改一处；属于本次修复引入的维护性回归。
- 复现：`grep -n "^\.nowrap {\|^\.sr-only {\|^\.grid > div {" dock/ui/console.css` → 3 组；`grep -n -- "--on-vendor" dock/ui/tokens.css` → 3 行（含一处重复）。
- 证据：上述 grep 输出。
- 频率：确定。
- 影响：CSS/tokens 维护风险；不改变当前视觉（视觉回归通过）。
- 建议（非强制）：删除重复块，保留一份。

### [R2-P3-5] 移除筛选控件后残留死状态/死导入

- 位置：`dock/ui/pages/context.mjs:4`（`Segmented` 已未使用）、`:35`（`range` 仍进入请求、无 UI 修改）、`:59-70`；`dock/ui/pages/usage.mjs:74`（`groupBy` 仍进入请求与 JSON 导出、无 UI 控件）、`:85-91`。
- 期望：移除 UI 后清理对应状态/参数，避免后人误以为这些筛选仍可用。
- 实际：`context` 的 `range` 永远为 `session`，`usage` 的 `groupBy` 永远为 `agent`；服务端仍接受参数但无实际效果。
- 复现：`grep -n "range\|groupBy\|Segmented" dock/ui/pages/context.mjs dock/ui/pages/usage.mjs`。
- 证据：上述文件。
- 频率：确定。
- 影响：死代码/误导性 API 参数；不阻断功能。
- 建议（非强制）：删除未使用的 state/导入，或恢复为真正的筛选实现。

### [R2-P3-6] 1 秒轮询还会每秒触发更新检查/提醒检查，增加无谓的 daemon 调用

- 位置：`dock/overlay/renderer.js:424-436`（`loadSettings` 中 `checkUpdate(false)`）、`:471-473`（`restartAlertTimer` → `checkAlerts` 立即执行）、`:512-541`（`checkAlerts` 在有预算时请求 `/summary?days=1`）、`:2783-2785`（每秒轮询）。
- 期望：设置变更时检查一次；提醒按 30 秒节流（原实现）。
- 实际：若 `autoUpdate`/`updateManifestUrl` 已配置，每秒触发一次更新检查；若设置今日预算，每秒请求一次 `/summary`（`alertOnce` 只抑制气泡，不抑制网络/计算）。
- 复现：配置 `budgetMoney>0` 或 `autoUpdate=true`，观察 daemon 请求日志/计数；或阅读上述代码。
- 证据：代码路径；`checkAlerts` 在 `restartAlertTimer` 中无条件先调用，而 `restartAlertTimer` 每秒被 `applySettings` 调用。
- 频率：确定（配置相关项时）。
- 影响：常驻进程每秒额外网络/JSON/账本读取；属于性能回归。
- 建议（非强制）：只在设置实际变化时执行依赖设置的副作用；或把 `checkAlerts` 保持 30 秒独立定时器，不被 `applySettings` 重置。

## 已核对且未发现问题的项

- `npm run ci`：语法 145 文件、价目同步、213 单测、lint 228 文件、engines parity 全部通过。
- `npm run test:ui`：8 页 × 2 主题 × 2 视口通过，axe critical/serious 0；SVG 字体检查已纳入，未再出现 10px 轴文字。
- `npm run visual`：32 张、0.1% 阈值通过，基线更新与环境匹配。
- 遗留路由安全（P1-1）：无 token 的 `/settings` PUT、`/bind` POST 均 403；错误 Host 的 `GET /settings` 403；带 token 的遗留写仍可用，测试已补 token。
- 开机自启（P2-5）：临时 `APPDATA` 下安装/删除 `fox-dock.vbs` 成功，GET 状态同步。
- 导入（P1-2）：`vendorConfig` 类别已删除；单测断言导入后无 `vendor-config.json`。
- WB shim（P2-1）：`postDockEvent` 已导入；mock dock 收到 `POST /v1/events`。
- Dialog（P2-8）：Esc 关闭、焦点恢复、Tab 焦点陷阱均实测通过。
- 版本（P3-6）：`2.0.0-pre.1` 与文档一致；预发布比较行为正确。
- `normalizeContext`（P3-4）：缺失 used 保持 null。
- 角色默认（P3-13）：`/v1/roles` 的 `defaultFor` 与控制台 `roleDefault` 已接入。
- `/v1/pet/attach`（P3-14）：服务端从 exe/title 重新判定适配器。

## 未验证 / 无法验证

- `reanchor` 回归的隔离 A/B：未在临时副本中移除 1 秒轮询重跑；因此“轮询是唯一根因”是代码推断，3/3 测试失败是确定事实。
- 真实宿主数据/凭据、真实更新、8 小时 soak、真机 DPI/多屏：未运行。
- overlay 的 `hideMoney` 在已绑定详情页、vendor 卡、气泡等所有路径的全量遮蔽未逐一真机验证；已确认“全部 agent（今日）”列表仍泄露金额。
- `dnd` 与 `alertOnce` 的交互、菜单按钮 hover 的视觉行为只做了代码核对，未做像素级/交互级验证。
- `menuButton='hover'` 的预期视觉未在 UI-SPEC 中给出明确 opacity 值，本报告按“悬停才显示”的字面语义判断。
- 打包包含 `launch/last-*.log` 的实际内容未逐字节检查（只确认路径进入 tar）；未验证是否含用户路径。
- 旧线 shim 在真实宿主 hook 中的执行仍未验证。
