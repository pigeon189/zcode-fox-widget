# 代码审查报告：feat/dock 最近 10 个提交 + 工作树 2026-10-19

## 审查范围与方法

- 仓库根目录：`E:\WorkSpace\fox-dock`
- 审查工作树：`E:\WorkSpace\fox-dock`（审查开始与结束时 `git status --porcelain` 均为空；本报告是唯一新增文件）
- 分支：`feat/dock`，HEAD `146adb4`
- 提交范围：`a2d0f4e..146adb4`（10 个提交：`3d5ee13`、`3dd4b86`、`7f75b68`、`59c5e46`、`5edd0f3`、`64cbb0d`、`6007f44`、`f32db5f`、`a550148`、`146adb4`）加当前工作树
- 旧线 shim 核对：
  - `C:\Users\paper\.zcode\cli\plugins\marketplaces\zcode-fox-widget`（`main`，HEAD `52eeaa3`；shim 提交 `2bf1c16`、`53a84b0`、`52eeaa3`）
  - `E:\WorkSpace\zcode-fox-widget`（`workbuddy/main-56fc9dd2`，HEAD `1149aa7`；shim 提交 `1d5607d`、`1149aa7`）
  - 两处只读，未修改；两处 `git status` 仅有与本次审查无关的未跟踪文件。
- 运行环境：Windows 11 `10.0.26200` x64，Node `v24.18.1`，npm `12.0.2`，本机 Edge（Playwright `channel:'msedge'`）。

### 实际运行的命令与结果

| 命令 | 结果 |
|---|---|
| `npm run ci` | **通过（exit 0）**。语法检查 145 个文件、0 失败；价目内核与 `lib/pricing.mjs` 逐字节一致（33008 字节）；单元测试 213/213 通过；lint 223 个文件通过；engines parity 通过（价目 6 组、计费源 7 组、平台用量 1 组）。 |
| `npm run test:all` | **通过（exit 0）**。297 个测试全部通过，0 失败、0 skipped、0 todo，耗时 66.1s。 |
| `npm run test:ui` | **通过（exit 0）**。输出：`UI 自检通过：8 页 × 2 主题（布局 / 可访问名称 / axe）`。 |
| `npm run test:electron:console` | **通过（exit 0）**。输出：`✅ 控制台真窗口冒烟通过（页面加载 / 无 JS 异常 / 关键文本 / 截图）`。 |
| `npm run visual` | **通过（exit 0）**。输出：`✅ 视觉回归通过：32 张（阈值 0.2%）`。 |
| 附加：临时 daemon 安全探针（仓库外脚本） | 复现了遗留路由绕令牌/Host 校验、`/vendors` 无旧挂件服务时降级、`/v1/diag/bundle` 未脱敏绑定路径。 |
| 附加：WorkBuddy shim 探针（仓库外合成环境） | 复现了 `postDockEvent` 未定义导致事件不转发（exit 0 静默）。 |
| 附加：UI 探针（fixture daemon + Edge） | 复现了 Dialog 不能 Esc 关闭；`hideMoney=true` 时控制台仍显示完整金额。 |

### 未覆盖或无法验证的部分

- `npm run verify:zcode`、`npm run verify:workbuddy`、`npm run verify:context` 未运行：这些工具读取真实宿主库/凭据，违反本次“不使用真实用户数据、不向外部网络请求”的隔离约束。四宿主真实数据对账因此未由本轮审查复核。
- 8 小时 soak、真实 kill -9 恢复、真实重启自启未运行（时间/环境约束）。
- 真实更新下载与 `update --apply` 未运行（需要真实签名清单与网络；本审查不向外部网络发请求）。
- 真机 125%/150% DPI、多显示器、Kimi Code/dsh 真实宿主窗口未验证（本机环境无法在不接触真实宿主数据的前提下复现）。
- 旧线 shim 在真实 ZCode/WorkBuddy 宿主中的 hook 执行未验证；对 WorkBuddy shim 使用了合成 stdin + 本机 mock daemon。
- Electron 浮层的 `type:'toolbar'` 冻结修复只做了代码/静态守卫核对；未做真机流式输出下的 A/B 冻结复现。
- 视觉回归只覆盖 960×680 与 760×560、DPR 1 的 Edge 渲染；未覆盖 Electron 真窗口和 150% 缩放。

## 结论

REQUEST_CHANGES

## 问题

### [P1-1] 遗留路由绕过 `/v1` 的写令牌与 Host 校验，可被网页/浏览器改写设置与绑定

- 位置：`dock/daemon/src/daemon.mjs:496-506`（`PUT /settings`）、`dock/daemon/src/daemon.mjs:513-583`（`POST/DELETE /bind`）；读写遗留路由统一在 `dock/daemon/src/daemon.mjs:250-613`；对照 `dock/daemon/src/v1.mjs:252-262`。
- 期望：`docs/dock/DECISIONS.md:216-221`（D028）要求写接口需 `x-fox-token`，读接口校验环回 Host；`docs/dock/PLAN.md:67` 明确“写操作要 token；读操作限制同站”。旧路由只承诺“保留一个小版本并加 `X-Fox-Deprecated: 1`”，没有豁免这两条。
- 实际：`/settings` PUT、`/bind` POST/DELETE 既不校验 `x-fox-token`，也不校验 Host；`/settings` GET、`/bindings`、`/billing`、`/summary`、`/diag.json` 同样不校验 Host。`/v1` 对错误 token/Host 均返回 403，但遗留路由直接执行。
- 复现：
  1. 用临时数据目录启动 daemon：`node dock/daemon/src/daemon.mjs --data-dir <temp> --port 0 --no-bridge`。
  2. 读取 `daemon.lock` 的端口，发送不带 token 的 `PUT /settings`，带 `Origin: http://evil.example`、`Content-Type: text/plain`、body `{"theme":"dark"}`。
  3. 再发送 `GET /settings` 带 `Host: evil.example`，以及 `POST /bind` 不带 token（同样带 `Origin`、`text/plain`）。
- 证据（临时探针实际输出，值为合成值）：
  - `PUT /settings` → `200 {"ok":true}`；随后 `GET /settings` 的 `theme` 由 `auto` 变为 `dark`，`budgetMoney` 被改为 `999`。
  - `GET /settings` 带 `Host: evil.example` → `200`（`/v1/settings` 同样请求 → `403 bad-host`）。
  - `POST /bind`（无 token、`Origin: http://evil.example`）→ `200 ok:true`，并写入绑定。
- 频率：确定（每次请求均可复现）。
- 影响：在浏览器允许页面访问环回地址或 DNS rebinding 成功的条件下，网页可通过简单请求 `POST /bind`（`text/plain` 不触发 CORS 预检）污染绑定/宠物状态；通过 DNS rebinding 可进一步调用 `PUT /settings` 改写主题、预算、更新清单地址等设置，并读取 `/billing`、`/summary`、`/diag.json` 等数据。这正是 `/v1` 的 Host/令牌边界要防的场景。
- 建议（非强制）：对遗留路由统一加 Host 白名单，写路由再校验 `x-fox-token`；或者先让浮层迁移到 `/v1` 后删除遗留路由。补一条负例集成测试（无 token `/settings` PUT 必须 403、错误 Host 必须 403）。

### [P1-2] 旧挂件“厂商配置”导入把 API Key/中转站令牌明文写入 `vendor-config.json`，绕过 DPAPI 保险库

- 位置：`dock/daemon/src/import-old.mjs:190-205`、`:229`；消费方 `dock/engines/paths.mjs:41-42`、`dock/engines/credentials.mjs:94-104`、`:124-127`、`dock/engines/vendors.mjs:546-561`、`dock/engines/relays.mjs:591`；测试 `dock/test/unit/import-old.test.mjs:81-84`。
- 期望：`docs/dock/DECISIONS.md:202-207`（D026）规定“`vault.json` 存 DPAPI 密文”“明文 key 落盘不可接受”；`dock/README.md:53-55` 说明凭据优先级为环境变量 → DPAPI 保险库 → 宿主发现 → 旧挂件配置（只读导入），并称旧 `vendorKeys` 应在控制台导入保险库；`dock/ui/pages/settings.mjs:292` 也提示“API Key 请用「厂商与密钥」导入保险库”。
- 实际：用户选择“厂商 key 引用与中转站令牌”后，`importVendorConfig` 把旧 `config.json` 的 `vendorKeys`（实际是各厂商 API Key）和 `relayAuth`（New API 系统访问令牌 + userId）原样合并到 `%LOCALAPPDATA%\fox-dock\vendor-config.json`。该文件是明文 JSON（仅 `mode: 0o600`，未经过 DPAPI），并且 `engines` 会从该文件读取 `vendorKeys` 作为真实请求凭据。仓库内单元测试明确断言 `cfg.vendorKeys.openai === 'k'`、`cfg.relayAuth.packycode.token === 't'`，即把明文复制当成预期行为。
- 复现：
  1. 临时目录构造旧挂件数据：`config.json` 写入 `{"vendorKeys":{"openrouter":"<合成值>"},"relayAuth":{"packycode":{"token":"<合成值>","userId":"u"}}}`。
  2. 调用 `importCategories({ source, categories:['vendorConfig'], paths, env })`。
  3. 读取 `<dock>/vendor-config.json`，可见 `vendorKeys` 与 `relayAuth.token` 明文。
  4. 或直接运行 `node --test test/unit/import-old.test.mjs`，第 82-83 行断言通过。
- 证据：上述测试断言；`engines/vendors.mjs:558-559` 用 `vendorKeys[templateId]` 作为请求 key；`engines/relays.mjs:591` 直接使用 `cfg.vendorKeys[...]`。
- 频率：确定（选择该导入类别时必然发生）。
- 影响：密钥/令牌被复制到 DPAPI 保险库之外，违背 D026 的硬约束；备份、云同步、杀软/诊断包扫描可能暴露明文凭据。界面提示“只导入 key 引用”与实际导入真实 key 不符。
- 建议（非强制）：导入时只接受“引用/来源”，真实 key 走 `vault.set(templateId, key)`；或者删除 `vendorKeys`/`relayAuth` 导入项并更新 UI 文案。为“导入后文件不含明文密钥”补负例测试。

### [P2-1] WorkBuddy 旧线 `hook-event.mjs` 调用未导入的 `postDockEvent`，事件转发永远不发出

- 位置：`E:\WorkSpace\zcode-fox-widget\lib\hook-event.mjs:231-237`（调用）；同文件 `:42-45`（仅导入 `fs`、`path`、`spawn`、`paths.mjs`，没有 `dock-shim.mjs`）。对应 hook 配置 `E:\WorkSpace\zcode-fox-widget\hooks\hooks.json:15-36`（`UserPromptSubmit`、`Notification`）。
- 期望：M7 的“事件转发”（`docs/dock/PLAN.md:299`、`dock/CHANGELOG.md:27`）以及 `hooks.json` 描述要求把 `UserPromptSubmit`/`Notification` 转发到 dock 的 `/v1/events`（带 `x-fox-token`）；提交信息也把“事件转发”列为能力（仅作定位线索）。
- 实际：`postDockEvent` 在文件中既未导入也未定义。执行到 `await postDockEvent({...})` 时抛出 `ReferenceError`，被最外层 `try { ... } catch (err) {}` 静默吞掉；hook 以 0 退出，状态文件照常写入，但 dock 永远收不到事件。
- 复现：
  1. 在仓库外临时目录设置 `FOX_WIDGET_DATA_DIR`、`CODEBUDDY_HOME`、`FOX_DOCK_DATA`，并写一个 `daemon.lock` 指向本机 mock HTTP 服务（token 为合成值）。
  2. 向 `node E:/WorkSpace/zcode-fox-widget/lib/hook-event.mjs` 的 stdin 传入 `{"hook_event_name":"Notification","session_id":"sess-1"}`。
  3. 观察 mock 服务收到的请求与退出码。
- 证据：实际输出 `{"exitCode":0,"received":[],"state":{"event":"Notification",...}}`；`PermissionRequest` 同样为 `received:[]`。
- 频率：确定（WorkBuddy 线所有挂上的事件类型）。
- 影响：WorkBuddy 的“开始干活/等确认”事件在 M7 声称已接入后实际完全失效；依赖这些事件的提醒/轮开始逻辑静默缺失。
- 建议（非强制）：在 WB `hook-event.mjs` 加 `import { postDockEvent } from './dock-shim.mjs'`，并补一条“hook 向 mock dock 发出 POST”的测试。

### [P2-2] 浮层“厂商”页仍走旧挂件服务，旧挂件不在时 45 个内置模板全部消失

- 位置：`dock/overlay/renderer.js:1418-1437`（`loadVendors` 请求 `/vendors`）、`:1442-1454`（数据源下拉只有 ZCode/WorkBuddy 挂件）；`dock/daemon/src/daemon.mjs:306-318`（遗留 `/vendors` → `readHostVendors`）；`dock/daemon/src/host-vendors.mjs:132-147`（找不到服务即返回 `service-unavailable`）。
- 期望：`docs/dock/DECISIONS.md:173-180`（D022）已用内置 engines 取代 D019，挂件线服务只保留为导入源；`dock/README.md:53-54` 称“厂商引擎已内置，不再依赖挂件线服务在跑”；`dock/CHANGELOG.md:13` 称 45 个模板不再依赖旧挂件服务。
- 实际：控制台“厂商与密钥”走 `/v1/vendors`（engines，返回 45 个模板）；浮层“厂商”页仍走遗留 `/vendors`，在 39321–39330 探测旧挂件服务。旧挂件未运行时返回 `ok:false, reason:'service-unavailable'`，浮层只显示“读取失败/没有返回厂商模板”；同一台机器上控制台正常、宠物层降级。
- 复现：
  1. 临时数据目录启动 daemon，并设置 `FOX_DOCK_VENDOR_PORTS=39991,39992`（确保没有旧挂件服务）。
  2. `GET /vendors?adapter=zcode` 与 `GET /v1/vendors` 对比。
- 证据：实际输出 `legacyVendors: {ok:false, reason:'service-unavailable', services:[], vendors:0}`，`v1Vendors: {ok:true, source:'engines', vendors:45}`。
- 频率：确定（旧挂件未运行或端口不在白名单时）。
- 影响：D022 的核心目标“dock 脱离旧挂件存活”在宠物层未实现；用户从浮层看不到任何厂商余额，只有打开控制台才能看到。
- 建议（非强制）：浮层改用 `/v1/vendors`，或由 daemon 在遗留 `/vendors` 中优先回退到 engines；同步更新浮层的“数据源”文案。

### [P2-3] 控制台/托盘修改设置后，运行中的浮层不会重新加载，设置“立即生效”不成立

- 位置：`dock/overlay/renderer.js:414-425`（`loadSettings`）、`:2751`（只在启动时调用一次）；`dock/overlay/main.cjs:71-78`（托盘 `patchSettings` 只 PUT）、`:204-231`（托盘菜单）；`dock/daemon/src/daemon.mjs:496-501`（遗留 PUT 后广播 state）、`dock/daemon/src/v1.mjs:461-466`（v1 PUT 后广播）。
- 期望：`docs/dock/UI-SPEC.md:50` 要求“设置……改动立即 PUT，失败回滚并 Toast”；托盘菜单的“桌宠模式/隐藏金额/开机自启”应当切换后立即生效。
- 实际：浮层在启动时把 `settings` 读进内存，之后没有 `/v1/stream` 订阅、没有 settings 轮询、也没有接收主进程转发的设置变更。控制台或托盘 PUT 只更新 daemon 文件并广播 `state`，浮层不监听；因此主题、角色大小、桌宠模式、跟随间隔、气泡/提醒等通过控制台/托盘修改后，浮层仍用旧值，直到重启浮层。托盘“桌宠模式”只写设置，浮层本地 `settings.petMode` 不变，拖拽仍会吸附/跟随。
- 复现（代码路径，确定）：
  1. `grep -n "loadSettings" dock/overlay/renderer.js` 仅启动处 `2751` 与函数定义 `414`。
  2. `grep -n "EventSource\|/v1/state\|/settings" dock/overlay/renderer.js` 只有启动读取与浮层自身保存，无订阅/轮询。
  3. 启动浮层后从控制台 PUT `/v1/settings` 修改 `scale`/`petMode`，浮层不变化。
- 证据：上述代码路径；`daemon.mjs:500`、`v1.mjs:464/486/525` 的广播只对 SSE 客户端生效，浮层不在客户端集合中。
- 频率：确定（代码路径；未在真机 UI 上逐项复现，但不存在任何重新读取机制）。
- 影响：设置看起来保存成功，实际不生效；托盘菜单的两个核心开关（桌宠模式/隐藏金额）在浮层上无效。
- 建议（非强制）：浮层订阅 `/v1/stream` 的 `state`，或每秒/变更时重新读取 `/v1/settings`；托盘 `patchSettings` 后通知渲染进程；热键变更也要重新注册。

### [P2-4] 多个公开设置项没有任何消费方，其中“隐藏金额”“勿扰”“周/月预算/余额预警/成本异常”与 CHANGELOG 不符

- 位置：
  - 隐藏金额：`dock/ui/pages/settings.mjs:122-123`、`dock/overlay/main.cjs:218-220`、`:277-280`；`dock/overlay/renderer.js`、`dock/ui/` 无任何消费方。
  - 显示样式/菜单按钮/悬浮数据：`dock/ui/pages/settings.mjs:109-120`、`:139-143`；无消费方。
  - 勿扰：`dock/ui/pages/settings.mjs:169-170`、`dock/ui/pages/roles.mjs:216`；无消费方。
  - 周/月预算：`dock/ui/pages/settings.mjs:175-177`；无消费方（只有 `budgetMoney` 在 `overlay/renderer.js:495-525` 使用）。
  - 余额预警：`dock/ui/pages/settings.mjs:182-183`；无消费方（`overlay/renderer.js:495-525` 只读 `quotaWarnPct` 与 `budgetMoney`）。
  - 成本异常：`dock/ui/pages/settings.mjs:188-189`；无消费方。
  - 更新通道：`dock/ui/pages/settings.mjs:230-235`；daemon/CLI 更新流程不读取 `settings.updateChannel`。
- 期望：`dock/CHANGELOG.md:21` 声称“角色大小、隐藏金额、勿扰、今日/周/月预算、余额与上下文预警、成本异常提醒”已提供；`UI-SPEC.md:50` 要求设置改动生效；隐藏金额的界面提示为“录屏/共享屏幕时把所有金额显示为 •••”。
- 实际：这些键只出现在 `settings.mjs` 的默认值/归一化、设置页控件和 `v1.state` 透传中，没有任何渲染或业务逻辑读取。实际运行 UI 探针：fixture 的 `settings.hideMoney=true` 时，总览仍显示 `¥12.34`、`¥0.28`，没有任何 `•••`。
- 复现：
  1. 用临时 scene 将 `settings.hideMoney` 设为 `true`，启动 fixture daemon 与 Edge 打开控制台总览。
  2. 读取 `[data-testid="page.overview"]` 文本；或直接 `grep -rn "hideMoney" dock/overlay/renderer.js dock/ui`。
  3. 对 `weeklyBudget`、`monthlyBudget`、`balanceWarnMoney`、`costAnomalyX`、`dnd`、`showStyle`、`menuButton`、`floatingData`、`updateChannel` 做同样的 grep。
- 证据：UI 探针输出 `{"fixtureHideMoney":true,"masked":false,"moneyShown":true,"snippet":"ZCode ... ¥12.34 ..."}`；grep 结果只在设置定义/UI 自身出现。
- 频率：确定。
- 影响：用户修改设置后看不到任何变化；“隐藏金额”在录屏/共享场景下失效，属于隐私/展示承诺未兑现；CHANGELOG 对功能范围的描述失真。
- 建议（非强制）：在统一的格式化函数或渲染层实现 `hideMoney`/`dnd`；补齐预算/异常/余额预警的消费逻辑；未实现的控件先从设置页移除或标注“暂未生效”。

### [P2-5] 控制台“开机自启”开关只保存布尔值，不会安装/移除启动文件夹启动器

- 位置：`dock/ui/pages/settings.mjs:216-218`；`dock/daemon/src/settings.mjs:89`、`:286`（仅默认值与归一化）；实际安装器只在 `dock/overlay/main.cjs:139-160`（托盘）和 `dock/tools/fox-dock.mjs:569-583`（`install-app`）被调用。
- 期望：设置页标签写明“写入启动文件夹的 VBS 启动器（可在托盘菜单切换）”；`dock/README.md:132` 也把 `install-app` 描述为写登录启动项。
- 实际：控制台开关只 `PUT /v1/settings {autoStart:true/false}`，没有任何代码读 `settings.autoStart` 去调用 `installLauncher`/`uninstallLauncher`；因此启动文件夹不会出现/移除 `fox-dock.vbs`。托盘菜单的“开机自启”是另一条路径，确实会安装/移除启动器。
- 复现：
  1. `grep -rn "autoStart" dock`：只得到设置默认值/归一化、设置页、托盘 `toggleAutoStart`；daemon/控制台没有 launcher 调用。
  2. 在控制台切换“开机自启”，检查 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` 无变化。
- 证据：上述 grep；`installLauncher` 的调用点只有 `overlay/main.cjs:144`、`tools/fox-dock.mjs:572`。
- 频率：确定。
- 影响：用户以为已开启自启，实际重启后不会自动运行；设置与真实状态不一致。
- 建议（非强制）：设置页的 autoStart 变更走一个需要 `nodePath`/`scriptPath` 的安装接口（或由 daemon 启动时按 setting 安装/移除），并让设置页读取启动器实际存在状态而不是只读布尔值。

### [P2-6] 用量页“按厂商/按模型”分组筛选无效果；服务端也不返回厂商/模型分组

- 位置：`dock/ui/pages/usage.mjs:25-43`（`flatten(usage, metric)` 忽略 `groupBy`）、`:78-96`（`groupBy` 只进入请求）、`:98-130`（表格/图表/排名始终按 adapter 行）；`dock/daemon/src/v1.mjs:317-338`（只返回 `summary`（按 adapter 的 groups），`models: []`、`modelsByTokens: []`、`rankTotal: null`）。
- 期望：`docs/dock/UI-SPEC.md:46` 要求“用量：范围/分组/指标三个正交筛选”；`dock/README.md:19` 称“今日 / 7 天 / 30 天 × 按 Agent/厂商/模型 × 金额/Token”。
- 实际：切换“按厂商”或“按模型”只改变前端 state 与请求参数；服务端返回的数据结构与“按 Agent”完全相同，前端 `flatten` 也不使用 `groupBy`。用 fixture 对 `groupBy=agent` 与 `groupBy=vendor` 请求，`today` 与 `days` 完全相同。
- 复现：
  1. 启动 `node tools/fixture-daemon.mjs --scene test/fixtures/scenes/zcode-normal.json --port 39551`。
  2. 比较 `GET /v1/usage?range=7d&groupBy=agent` 与 `groupBy=vendor` 的 `today/days`。
  3. 在控制台用量页点击“按厂商/按模型”，观察表格与图表不变。
- 证据：实际输出 `{"sameDays":true,"sameToday":true}`；`v1.mjs:333-335` 固定 `models: []`。
- 频率：确定。
- 影响：三个正交筛选中的两个是空操作，用户会误以为数据缺失；文档承诺的厂商/模型维度不可用。
- 建议（非强制）：在 daemon 用适配器的逐条记录（engines/usage-records）实现 vendor/model 聚合，或先隐藏这两个筛选。

### [P2-7] 上下文页“时间范围（本会话/近 1 小时/今日）”是空操作，适配器不读取 `range`

- 位置：`dock/ui/pages/context.mjs:10-14`（选项）、`:62-75`（把 `range` 放进请求）；`dock/daemon/src/context-service.mjs:20-29` 把 `range` 传给 `adapter.getContext`；四个适配器的 `getContext` 均未读取 `range`（`dock/adapters/zcode/context.mjs:283`、`dock/adapters/workbuddy/context.mjs:174`、`dock/adapters/kimi/context.mjs:142`、`dock/adapters/dsh/context.mjs:184`）。
- 期望：`docs/dock/UI-SPEC.md:45` 要求上下文页有“会话选择 + 范围”；选项本身也向用户承诺可按时间范围查看。
- 实际：`range` 只影响请求 URL 和 3 秒缓存键，不改变取数；三个选项返回同一份当前会话上下文。
- 复现：
  1. `grep -rn "opts.range\|range" dock/adapters`：没有任何适配器读取。
  2. 对同一 fixture/真实会话请求 `/v1/agents/zcode/context?range=session` 与 `?range=1h`，结果相同。
- 证据：上述 grep；`context-service.mjs:22` 只做透传。
- 频率：确定。
- 影响：界面控件误导用户；无法按时间范围查看上下文。
- 建议（非强制）：在适配器/上下文历史层实现范围过滤，或移除该控件。

### [P2-8] 所有 Dialog 不能用 Esc 关闭，也没有焦点恢复，违反 UI-SPEC 验收项

- 位置：`dock/ui/components/base.mjs:90-98`（Dialog 只处理背景点击）；`dock/ui/console.mjs:271-288`（全局键盘只处理 Ctrl+数字与 F5，无 Escape）；没有焦点陷阱/恢复逻辑。
- 期望：`docs/dock/UI-SPEC.md:57`：“所有弹窗可用键盘关闭（Esc），焦点有可见环；关闭后回到触发按钮。”
- 实际：Esc 不关闭弹窗；焦点不回到触发按钮；只有点击背景或按钮才能关闭。
- 复现：
  1. 启动 fixture daemon 与 Edge，打开控制台 `#roles`。
  2. 点击“编辑 JSON”打开 Dialog。
  3. 按 Esc，Dialog 仍可见；点击背景才关闭。
- 证据：UI 探针实际输出 `{"dialogBefore":1,"dialogAfterEsc":1,"stillVisibleAfterEsc":true,"closedByBackdrop":true}`。
- 频率：确定。
- 影响：键盘用户无法按规格关闭弹窗；可访问性验收项未满足。
- 建议（非强制）：在 Dialog 挂载时监听 `Escape`，记录触发元素并在关闭时恢复焦点。

### [P3-1] 视觉回归阈值 0.2% 与 PLAN 的 0.1% 不一致，TESTING 仍称未接入像素比对

- 位置：`dock/tools/visual-test.mjs:130-132`（`ratio > 0.002`）；`docs/dock/PLAN.md:119`（差异 ≤0.1%）；`docs/dock/TESTING.md:45`（“视觉基线尚未接入逐像素比对”）。
- 期望：PLAN 的视觉门禁为 ≤0.1%；TESTING 应与当前实现一致（已接入 32 张逐像素比对）。
- 实际：脚本按 0.2% 判定；输出为“阈值 0.2%”；TESTING 的说明已过期。
- 复现：`npm run visual` 查看最后一行；阅读 `visual-test.mjs:131`。
- 证据：实际输出 `✅ 视觉回归通过：32 张（阈值 0.2%）`。
- 频率：确定。
- 影响：回归门槛比计划宽松一倍；文档对门禁的描述不一致。
- 建议（非强制）：改成 0.001 或更新 PLAN；同步 TESTING 第 4 节。

### [P3-2] CI 没有运行 `parity:engines`，与 TESTING 的“CI 也跑这一组”不符

- 位置：`.github/workflows/dock-ci.yml`（仅 `npm run check`、`check:sync`、`lint`、`npm test`）；`docs/dock/TESTING.md:7`（`npm run ci` 包含 engines parity，且“CI 也跑这一组”）。
- 期望：CI 执行 `npm run ci` 或显式加入 `npm run parity:engines`。
- 实际：CI 不运行 parity，engines 搬运代码的逐字段一致性检查只在本地 `npm run ci` 中执行。
- 复现：阅读 workflow；或推送一个只改 `dock/engines` 的提交，观察 CI 步骤。
- 证据：workflow 文件步骤列表；本地 `npm run ci` 才出现 `✅ engines parity 通过`。
- 频率：确定。
- 影响：CI 可能放过 engines 与旧线口径漂移。
- 建议（非强制）：CI 改为 `npm run ci`，或在步骤中补 `npm run parity:engines`。

### [P3-3] `/v1/diag/bundle` 未脱敏绑定记录里的 exe 路径，与 TESTING 的“路径替换为 ~”不符

- 位置：`dock/daemon/src/v1.mjs:679-709`，其中 `:706` 直接返回 `readBindings(paths.bindings).slice(0, 20)`；对照遗留 `/diag.json` 的脱敏 `dock/daemon/src/daemon.mjs:466-470`；文档承诺见 `dock/CHANGELOG.md:109`、`:155`（“路径已脱敏/家目录脱敏”）。
- 期望：诊断包中的用户目录应替换为 `~`（CHANGELOG 对“复制诊断信息/`/diag.json`”的承诺）。
- 实际：`bindings[].window.exe` 保留完整路径；实际探针返回 `C:/Users/paper/AppData/Local/Programs/ZCode/ZCode.exe`，而 `paths.dataDir` 已脱敏为 `~\AppData\Local\Temp\...`。
- 复现：启动 daemon，`POST /bind` 写入带 `C:\Users\<user>\...` 的 exe，再 `GET /v1/diag/bundle`，检查 `bindings`。
- 证据：临时探针输出中的 `bindings[0].window.exe`（本报告不粘贴真实用户名，已在此处用 `<user>` 表示）。
- 频率：确定。
- 影响：用户把诊断包发给维护者时泄露本机用户名/安装路径；与文档承诺不一致。
- 建议（非强制）：对 `bindings[].window.exe`、`title` 等路径字段复用 `redactHome`。

### [P3-4] `normalizeContext` 在 `used` 缺失时补 0，违反“不补零”契约

- 位置：`dock/adapters/contracts.mjs:286`：`const used = supported ? Math.max(0, Math.round(finiteOrNull(r.used) || 0)) : null`。
- 期望：`docs/dock/ADAPTERS.md:162-164` 要求“`used/limit` 读不到就不给，不要补 0”；`supported=false` 时应带 reason。
- 实际：`normalizeContext({ supported: true, limit: 1000 })` 返回 `used: 0, pct: 0, confidence: 'derived'`；缺失的 used 被当成 0。当前四个内置适配器都会在 used 缺失时返回 `supported:false`，所以还没有用户可见路径；但这是契约层的兜底错误。
- 复现：`node -e "import('./adapters/contracts.mjs').then(m=>console.log(m.normalizeContext({supported:true,limit:1000})))"`。
- 证据：实际输出 `{"used":0,"limit":1000,"pct":0,"confidence":"derived"}`。
- 频率：确定（调用即复现）。
- 影响：未来新增/改动的适配器一旦返回 `supported:true` 但漏了 used，UI 会显示“0% 已用”而不是不可得，直接误导。
- 建议（非强制）：把缺失 used 视为 `supported:false + reason`，或保持 `used:null` 并让 `pct` 为 null。

### [P3-5] 用量页提供“近 30 天”，但账本只保留 14 天且没有截断提示

- 位置：`dock/ui/pages/usage.mjs:10-14`（`30d` 选项）、`:90`（range 透传）；`dock/daemon/src/ledger.mjs:16`（`KEEP_DAYS = 14`）、`:41-46`（prune）；`dock/CHANGELOG.md:20`（“今日/7 天/30 天”）。
- 期望：用户选择“近 30 天”时应看到 30 天数据，或明确提示“账本仅保留 14 天”。
- 实际：`recordSnapshot` 每次写入都按 14 天裁剪；`summarize` 只返回账本里存在的天，30 天选项最多返回 14 天，界面没有任何说明。
- 复现：向账本写入 20 天记录，调用 `/v1/usage?range=30d`，只返回最近 14 天。
- 证据：`KEEP_DAYS=14` 与 `usage.mjs` 的 30d 选项。
- 频率：确定。
- 影响：30 天视图静默少 16 天，用户可能据此误判用量趋势。
- 建议（非强制）：把保留期调到 ≥30 天，或在 UI 标注实际保留窗口。

### [P3-6] `package.json` 版本 `2.0.0` 与文档/首个 tag `2.0.0-pre.1` 不一致；更新比较会把首个预发布清单判为“不比当前新”

- 位置：`dock/package.json:3`（`"version": "2.0.0"`）；`dock/README.md:7`、`dock/CHANGELOG.md:5`、`docs/dock/DECISIONS.md:209-214`（D027 首个 tag `dock-v2.0.0-pre.1`）；`dock/daemon/src/update.mjs:38-41`（预发布 < 正式）。
- 期望：首个对外包/清单版本为 `2.0.0-pre.1`，当前运行版本与清单版本可正确比较。
- 实际：daemon/CLI 报告的 `VERSION` 是 `2.0.0`（正式版语义）；`compareVersions('2.0.0-pre.1','2.0.0')` 返回 -1，`update --apply` 会以 `not-newer` 拒绝首个预发布清单。
- 复现：`node -e "import('./daemon/src/update.mjs').then(m=>console.log(m.compareVersions('2.0.0-pre.1','2.0.0')))"`。
- 证据：`package.json` 版本；D027；比较函数。
- 频率：确定。
- 影响：版本展示、tag、更新通道与清单版本可能对不上；首次预发布更新路径自相矛盾。
- 建议（非强制）：把 `package.json` 版本改为 `2.0.0-pre.1`（或让发布脚本/清单使用同一版本源）。

### [P3-7] 浮层设置里“标准档约 123px”是旧文案，与当前响应式 122–250px 公式不符

- 位置：`dock/overlay/renderer.js:1893`；实现 `dock/overlay/renderer.js:162-165`；`docs/dock/DECISIONS.md:158-164`（D020）。
- 期望：标准档在 2560×1600/150% 下约为 250px 基准，按 `clamp(122, min(250, min(vw,vh)*0.28)*scale, 625)` 计算。
- 实际：设置提示仍写“标准档约 123px 高（128px 容器）”；实际 `foxSize()` 在常见视口下返回 250。
- 复现：打开浮层设置页看“大小”提示；或在 1080p 下读取 `--fox-size` 计算值。
- 证据：上述行号。
- 频率：确定。
- 影响：用户对角色大小预期错误；文档/UI 与实现不一致。
- 建议（非强制）：改成“标准档约 250px（小屏自动回落至 122px）”。

### [P3-8] 图表轴文字 10px、部分图表缺少 `role="img"`/`aria-label`，且 18px 字号不在 UI-SPEC 允许列表

- 位置：`dock/ui/charts/svg.mjs:93`、`:99`、`:103-104`、`:122`、`:130`（`font-size="10"`）；`dock/ui/charts/svg.mjs:50-67`（StackedBar 无 role/aria-label）、`:136-140`（MiniBar 无 role）；`dock/ui/console.css:835`（18px）；`docs/dock/UI-SPEC.md:22`（字号只允许 12/13/14/16/20/24/32/40，最小 12）、`:40`（图表必须有 `role="img"` 与 `aria-label`）。
- 期望：字号 ≥12；所有图表有可访问名称。
- 实际：坐标轴/阈值文字为 10px；`ui-check` 在字体检查里跳过 `svg`（`dock/tools/ui-check.mjs:87`），所以门禁没有捕获；窄窗口页面标题为 18px，不在允许列表。
- 复现：`npm run test:ui` 通过，但 `grep -n "font-size=\"10\"" ui/charts/svg.mjs` 可复现；用读屏/axe 检查 StackedBar 无 img role。
- 证据：上述行号与 `ui-check.mjs:87` 的 SVG 跳过。
- 频率：确定。
- 影响：违反 UI 规格与可访问性要求；自动化门禁存在盲区。
- 建议（非强制）：轴文字提升到 12px（或更新规格）；给 StackedBar/MiniBar 补 `role="img"`/`aria-label`；把 SVG 纳入字号检查；18px 改为 20px 或加入规格。

### [P3-9] 浮层页面没有 CSP，两个 Electron 窗口都没有导航拦截/新窗口策略

- 位置：`dock/overlay/index.html`（无 CSP meta；对照 `dock/ui/console.html:5` 有 CSP）；`dock/overlay/main.cjs`、`dock/console/main.cjs` 均未设置 `webContents.on('will-navigate')` 或 `setWindowOpenHandler`。
- 期望：审查清单 B 要求检查 Electron 的 CSP 与导航拦截；`docs/incidents/2026-10-overlay-host-freeze.md` 也强调浮层安全形态。
- 实际：控制台有 CSP；浮层没有。两个窗口都允许默认导航/`window.open`（虽然当前 UI 不渲染外部链接）。
- 复现：阅读 `overlay/index.html` 与两个 `main.cjs`；搜索 `will-navigate`/`setWindowOpenHandler` 无结果。
- 证据：文件内容；`npm run lint` 只检查 toolbar/contextIsolation/sandbox/nodeIntegration，不检查 CSP/导航。
- 频率：确定。
- 影响：纵深防御缺口；若未来渲染不可信文本或发生导航，preload 暴露的桥会随页面进入远程源。
- 建议（非强制）：给浮层加与 console 同等 CSP；两个窗口都加 `will-navigate` 拦截和 `setWindowOpenHandler(() => ({action:'deny'}))`。

### [P3-10] “测试连接”对 relay/cmdgo/local-log 只检查凭据存在，却向用户显示“连接成功”

- 位置：`dock/engines/index.mjs:74-88`（`relay`/`cmdgo`/`local-log` 直接返回 `{ok:true, reason:'credential-present'}`，不发请求）；`dock/ui/pages/vendors.mjs:102-113`、`:193`（`test.ok` 显示“连接成功”）；同文件注释 `:74-75` 声称“按模板声明做一次真实取数（不伪造成功）”。
- 期望：`testTemplate` 的注释契约是真实取数；用户点击“测试连接”应得到真实连通性结果。
- 实际：这三类模板只要本地有凭据就返回 ok，不验证服务可达/凭据有效；UI 显示“连接成功”。
- 复现：配置一个 relay 的 `vendorKeys`（合成值），调用 `POST /v1/vendors/<relay-id>/test`，无网络请求也会得到 `ok:true`。
- 证据：`engines/index.mjs:81-85` 的提前返回。
- 频率：确定。
- 影响：用户被误导为已连通；排障时得到假阳性。
- 建议（非强制）：让 relay/cmdgo 真正调用其取数器（可设置短超时），local-log 明确返回“无需网络/仅本地”。

### [P3-11] 打包脚本会把被 git 忽略的截图/日志一起打进发布包

- 位置：`dock/tools/pack-release.mjs:26-27`（`SKIP_DIRS` 只有 `node_modules`、`dist`、`.git`、`.backup`）、`:42-63`（按文件系统遍历并读入所有文件）；`.gitignore:20`（`dock/test/visual/__shots__/`）、`dock/.gitignore:7`（`launch/last-*.log`）。
- 期望：发布包只包含源码/资源/基线等应发布内容；本机测试产物不应分发。
- 实际：`walk(DOCK, ...)` 会包含 `dock/test/visual/__shots__/*.png`、`dock/test/visual/__diff__`、`dock/launch/last-start.log` 等本机产物；`last-*.log` 还可能包含本机路径/错误信息。
- 复现：运行 `node tools/pack-release.mjs --version 2.0.0-pre.1`，解包查看 `dock-2.0.0-pre.1/test/visual/__shots__` 与 `launch/last-start.log`。
- 证据：`SKIP_DIRS` 与 ignore 规则。
- 频率：确定（当前工作树存在这些文件时）。
- 影响：发布包体积膨胀并携带本机测试/日志数据；与“只打包仓库内容”的预期不符。
- 建议（非强制）：改为按 `git ls-files` 收集，或把 `__shots__`/`__diff__`/`launch/last-*.log`/`.backup*` 加入跳过列表。

### [P3-12] 提交范围改动了 `dock/`、`docs/dock/` 之外的文件（根 `NOTICE` 与 `docs/INDEX.md`）

- 位置：`a2d0f4e..HEAD` 的非 `dock/`/`docs/dock/` 改动：`NOTICE`（+22 行，`5edd0f3`）、`docs/INDEX.md`（+6 行）。
- 期望：审查提示词 A 要求改动只落在 `feat/dock` 的 `dock/`、`docs/dock/`、CI 文件；`docs/dock/DECISIONS.md:169-171`（D021）还要求与旧线共享的 README/CHANGELOG/lib 零改动。
- 实际：`NOTICE` 增加了 Preact/htm/Lucide 的许可归属；`docs/INDEX.md` 增加了 dock 文档入口。`lib/`、`desktop/`、`hooks/`、根 README/CHANGELOG/CONTRIBUTING 未被改动。
- 复现：`git diff --name-only a2d0f4e..HEAD | grep -v '^dock/' | grep -v '^docs/dock/'`。
- 证据：上述命令输出 `NOTICE`、`docs/INDEX.md`。
- 频率：确定。
- 影响：不符合“只允许写规定目录”的范围约束；`NOTICE` 的第三方归属本身是必要的，但放在共享根文件会增加与旧线合并时的冲突面。
- 建议（非强制）：把 dock 的第三方归属移到 `dock/NOTICE`（或与维护者确认根 `NOTICE` 属于允许修改项）；`docs/INDEX.md` 的入口若必须保留，应在审查参数中明确。

### [P3-13] 控制台角色显示忽略适配器 `roleDefault`，WorkBuddy 视图仍显示全局角色

- 位置：`dock/ui/console.mjs:354-360`（`roleIdForAgent` 使用 `roles.find(r => r.defaultFor.includes(id))`，但 `dock/daemon/src/roles.mjs:89-98` 的 `listRoleLibrary` 对所有内置角色固定返回 `defaultFor: []`）；适配器默认值在 `dock/adapters/registry.mjs:72-89`/各 `index.mjs` 的 `roleDefault`，`/v1/state` 的 `agents[].roleDefault` 也有。
- 期望：`docs/dock/DECISIONS.md:108-115`（D015）要求角色默认值由适配器提供、服务端判定；浮层按宿主换角色（ZCode→fox、WB→xiaoke、Kimi→kimi、dsh→whale）。
- 实际：控制台总览对 WorkBuddy 视图使用全局 `settings.roleId`（默认 fox），不会使用 `state.agents[].roleDefault`；浮层则使用 `ADAPTER_DEFAULT_ROLE` 正确换角色。`ui/pages/roles.mjs` 的“当前角色”也基于 profile（空 = 继承）而不是适配器默认。
- 复现：打开控制台总览，视角切到 WorkBuddy；角色头像仍是 fox，而不是 xiaoke（除非用户在 profile 里显式指定）。
- 证据：上述代码路径；`/v1/state` 中的 `roleDefault` 未被控制台消费。
- 频率：确定。
- 影响：控制台与宠物层显示不一致；D015 的“默认值由适配器提供”在控制台侧未落实。
- 建议（非强制）：`roleIdForAgent` 优先读 `state.agents.find(a=>a.id===id).roleDefault`，并让 `/v1/roles` 的 `defaultFor` 反映适配器默认。

### [P3-14] `/v1/pet/attach` 在客户端提供 `agentId` 时不再服务端判定适配器

- 位置：`dock/daemon/src/v1.mjs:516-524`：`const agentId = body.agentId || resolveAdapter({...}).id`；同段注释声称“服务端判定适配器，不信任客户端自报”。
- 期望：`docs/dock/DECISIONS.md:113-115`（D015）要求“绑定后由服务端判定，前端不能伪造”。
- 实际：只要 POST body 带 `agentId` 和 `hwnd`，daemon 就直接采用该 `agentId` 写入宠物状态，不校验窗口 exe/title 是否真的属于该适配器。
- 复现：带有效 token 调用 `POST /v1/pet/attach`，body `{"agentId":"kimi","hwnd":"0x1"}`，随后 `GET /v1/state` 的 `pet.agentId` 为 `kimi`，与窗口无关。
- 证据：上述代码路径。
- 频率：确定（需要 token，当前调用方均为本机可信 UI）。
- 影响：前端 bug/被篡改时会写入错误的档案属主；违反服务端判定契约。
- 建议（非强制）：始终用 `resolveAdapter` 从窗口描述判定；`body.agentId` 只作为提示或校验失败时报错。

## 已核对且未发现问题的项

- `/v1` 安全边界（本身）：`PUT /v1/settings` 无 token → 403；`Host: evil.example` → 403 `bad-host`；带正确 token/Host 的读写正常。证据：临时 daemon 探针、`test/integration/v1.itest.mjs`。
- 凭据保险库：DPAPI 往返、密文篡改报错、掩码、非法 id/空密钥拒绝均通过单元测试（`test/unit/vault.test.mjs`）；`/v1/vendors` 响应不含完整 key（`test/integration/v1.itest.mjs` 的断言）。
- 角色导入：PNG 签名、逐 chunk CRC、尺寸/大小/id 白名单、内置不可删；相关单元/集成测试通过。
- 更新器：Ed25519 签名/验签往返、篡改字段拒绝、sha256 不匹配不落盘、失败整批回滚、版本降级拒绝；单元测试通过。
- 账本口径：`unit|currency` 分组、不跨单位/币种求和、失败/不支持不写假 0；单元测试通过。
- 适配器契约：`normalizeSnapshot` 拒绝非法单位、金额/百分比夹紧、`supported:false` 清空数值；匹配规则无维度不命中、同分排序确定；单元测试通过。
- 状态机：随机 10000 条事件序列不变量成立；启动恢复/窗口消失/重现用例通过。
- 浮层核心交互：拖拽绑定、四分吸附、跟随、解绑、桌宠模式、右键不误触、最小化矩形保护、角色切换与台词、额度卡/Free 卡、主题；`test/integration/overlay.itest.mjs` 32 个用例通过（`npm run test:all`）。
- Electron 入口安全配置：`contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`；`overlay/main.cjs` 保留 `type:'toolbar'`；`npm run lint` 通过。
- 静态守卫：UI 禁止 `innerHTML/outerHTML/document.write/eval/new Function/insertAdjacentHTML`；凭据模式扫描通过（223 个文件）。
- 旧线 shim 的提交范围：main 与 workbuddy 两处只改了 `lib/autostart.mjs`、`lib/dock-shim.mjs`、`lib/hook-event.mjs`，未触碰 WB 的 `host.mjs`、`watchdog*.mjs`、登录启动项、`follow-window.ps1`、`.codebuddy-plugin`；两处工作树无 shim 未提交改动。
- 主 line `hook-event.mjs` 正确导入 `postDockEvent`，事件转发路径与 WB 线的缺陷不同（WB 线问题见 P2-1）。

## 未验证 / 无法验证

- 真实 ZCode/WorkBuddy/Kimi/dsh 数据的逐日金额/上下文对账（`verify:zcode`、`verify:workbuddy`、`verify:context`）：会读取真实宿主库/凭据，未运行。
- 8 小时 soak、真实重启自启、kill -9 自动恢复：未运行。
- 真实更新清单下载、签名验证、`update --apply` 落盘/回滚：未运行（无网络请求、无在途签名清单）。
- 真机 125%/150% DPI、多显示器、最大化窗口跟随：未验证（D011 仍为已知限制）。
- Kimi Code 本地服务真实响应形状、dsh 真实多帧 zstd 文件：只用合成夹具/单元测试验证，未接真实宿主。
- 旧线 shim 在真实 ZCode/WorkBuddy 中的 hook 调用：只用合成 stdin + mock dock 验证了 WB 缺陷；主 line 真实转发未执行。
- 浮层 `type:'toolbar'` 在真实流式输出下的冻结 A/B：未做真机复现。
- 视觉回归只覆盖 DPR 1 的 Edge 960×680/760×560，未覆盖 Electron 真窗口与 150% 缩放。

## 与上一轮报告的对应关系（如有）

- 未在 `feat/dock` 分支或仓库根找到上一轮代码审查报告，无法逐条核对修复状态；本报告不适用“上一轮对应关系”。
- 说明：提交说明/阶段报告未作为事实依据；所有结论均由当前代码、测试或临时探针输出支持。提交说明中提到的“已知遗留（设置里的开机自启只写配置）”与本报告 P2-5 独立复现一致，但 P2-4/P2-3 等其它设置问题不是从提交说明推导的。
