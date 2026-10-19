# 代码审查报告：feat/dock 02b2481 宠物层 2.0（2026-10-19）

## 审查范围与方法

- 仓库根目录：`E:\WorkSpace\fox-dock`
- 审查工作树：`E:\WorkSpace\fox-dock`（HEAD `02b2481`；范围 `02b2481^..02b2481` 加当前工作树）
- 变更范围：新增 `dock/overlay/pet.js`、`pet.css`、重写 `index.html`；删除旧 `renderer.js`/`styles.css`；`overlay/main.cjs`、`preload.cjs` IPC；`daemon/src/v1.mjs` 的 `/v1/bindings`；重写 `test/integration/overlay.itest.mjs`（9 项）；新增 `tools/pet-shots.mjs` 与 fixture `/rect`、`/hit`。
- 运行环境：Windows 11 `10.0.26200` x64，Node `v24.18.1`，npm `12.0.2`，本机 Edge（Playwright `channel:'msedge'`），本机 Electron 运行时用于真实 overlay 探针。
- 上一轮报告：`CODE-REVIEW-2026-10-19-round3.md`（APPROVE）。本报告只针对宠物层替换增量，不重复 round3 结论。

### 实际运行的命令与结果

| 命令 | 结果 |
|---|---|
| `cd /d "E:\WorkSpace\fox-dock\dock" && npm run ci` | **通过（exit 0）**。语法 145 文件 0 失败；单元测试 213/213；lint 229 文件通过；engines parity 通过。 |
| `npm run test:all` | **通过（exit 0）**。277 个测试全部通过（277 pass / 0 fail / 0 skipped，66.4s）。 |
| `npm run shots:pet` | **通过（exit 0）**。生成 20 张宠物层截图（四象限/悬浮/快览卡/菜单/气泡/台词/隐藏金额 × 双主题）。 |
| 附加探针（仓库外临时目录） | 真实 daemon + 真实 Electron overlay：alpha 掩码初始状态、`/v1/pet/attach` 与 `/v1/bindings`、`petMode` 生效；fixture + Playwright：已吸附状态下拖拽、follow 定时器行为。 |

### 未覆盖或无法验证

- 真实宿主窗口下的长时间拖拽/吸附/悬浮、真机 125%/150% DPI、多显示器：未运行（当前桌面存在旧线浮层与外部 Edge 窗口，无法保证稳定复现；本报告用 fixture/真实 overlay 探针）。
- 真实 Electron 透明窗的鼠标穿透与 alpha 命中效果只做了状态探针（`alphaMask` 是否为 null），未在真实宿主上做点击穿透 A/B。
- `npm run test:ui`、`npm run visual` 未重跑：它们只覆盖控制台 `dock/ui/`，本次未改控制台；宠物层未纳入 ui-check/visual。
- 8 小时 soak、真实宿主数据对账：未运行。

## 结论

REQUEST_CHANGES

未解决数量：P1 = 1；P2 = 3；P3 = 4。

## 问题

### [P1-1] 已吸附状态下拖拽会被 follow 定时器/状态刷新拉回，核心拖拽交互失效

- 位置：`dock/overlay/pet.js:417-429`（`refreshRect` → `placeAnchored`）、`:1028-1031`（follow interval 直接 `refreshRect()`）、`:367-415`（`refreshState` 每 1.5s 在 attached 状态调用 `refreshRect()`）；`pointermove` 的拖拽落点 `:893-929`。
- 期望：`dock/README.md:147-148` 要求“拖动到宿主窗口上松开即吸附，拖到桌面空白进入悬浮”；已吸附状态也应允许再次拖拽切换/悬浮。旧浮层在 follow timer 中有 `dragging || pressing` 守卫（新 `pet.js` 未保留）。
- 实际：探针在 fixture + Playwright 下，把已吸附的狐狸从锚点拖到 `(200,200)`：拖拽中 `style.left=99`；等待 1.2s 后、鼠标仍按下（`dragging:true`）时，狐狸被拉回 `x=1078.390625, y=518.390625`（原吸附锚点）。指针释放后 `floatAt()` 会使用被拉回后的位置，而不是用户落点。
- 复现：
  1. 启动 fixture daemon 与 Playwright 渲染 `overlay/index.html?port=<port>&pid=999999&ct=0`，注入 fake `foxOverlay`。
  2. `window.__pet.debugAttach('zcode','0x1',{x:100,y:100,w:500,h:400},{h:'right',v:'bottom'})`。
  3. 在角色中心 `mouse.down()`，移动到 `(200,200)`，保持按下 1.2s，读取 `#fox` 的 rect。
- 证据：探针实际输出：`{"before":{"x":1078.39,"y":518.39},"during":99,"after":{"x":1078.39,"y":518.39,"dragging":true}}`。`refreshRect` 与 follow interval 都没有 `dragging || pressing` 判断。
- 频率：确定（探针 1/1；代码路径对任意 attached 窗口成立）。
- 影响：用户一旦吸附，再次拖拽去重新绑定或拖到桌面悬浮时，狐狸每 250–1000ms 被拉回旧锚点；核心拖拽/悬浮流程不可用。集成测试的“拖到桌面”用例在 attached 后仍能通过，是因为它只断言 `state.pet.mode==='floating'`，没有断言落点位置（见 P3-2）。
- 建议（非强制）：`refreshRect`/follow interval 在 `dragging || pressing` 时直接返回；或在 pointerdown 时暂停 follow，pointerup 后恢复。

### [P2-1] 默认角色启动时没有加载 alpha 掩码，透明边会拦截鼠标

- 位置：`dock/overlay/pet.js:170-180`：`applyRole` 只有在 `changed`（roleId 或 src 变化）时才调用 `loadAlphaMask`；初始 `roleId='fox'`、`#fox-img` 的 `src='assets/roles/fox.png'` 与 `FOX_ROLES.fox.image` 相同，`changed=false`，因此 `alphaMask` 保持 `null`。`isOverFox` 在 `:862-870` 对 null mask 回退到整个包围盒。
- 期望：`docs/dock/PLAN.md:292` 已把 alpha 命中列为 M1 底座能力；UI 审查提示词也要求“角色透明边点击穿透”。默认角色应从一开始就有 alpha 掩码。
- 实际：真实 daemon + 真实 Electron overlay 启动后探针返回 `{"alphaMaskNull":true,"alphaRole":"","roleId":"fox","src":"assets/roles/fox.png"}`。只有切换到另一个角色（或重新设置角色）后才会加载掩码。
- 复现：
  1. 临时数据目录启动 `daemon/src/daemon.mjs` 与 `overlay`（`--data-dir=<temp>`）。
  2. CDP 评估 `alphaMask === null`、`alphaRole`、`roleId`。
- 证据：实际输出 `alphaMaskNull:true, alphaRole:''`；`isOverFox` 在 mask 为空时返回包围盒命中。
- 频率：确定（默认 fox 角色每次启动）。
- 影响：角色 250px 方框内的透明区域也会把指针当作“压在角色上”，阻断宿主点击；这是旧浮层已修复过的透明边问题回归。
- 建议（非强制）：`applyRole` 无条件调用一次 `loadAlphaMask(role.id)`（或 boot 后显式加载当前角色掩码），失败时保留重试。

### [P2-2] 新宠物层吸附不写绑定表，`/v1/bindings` 永远为空，`markRestored` 失效

- 位置：`dock/overlay/pet.js:806-827`：`bindTo` 调用 `/v1/pet/attach`，但 `daemon/src/v1.mjs:532-533` 的 `attach` 只做 `petEvent` 状态转换，没有 `upsertBinding`；`/v1/bindings` 在 `v1.mjs:461-464` 只读 `bindings.json`；`pet.js:352-365` 的 `markRestored` 依赖该接口设置 `data-restored`/`boundKey`。
- 期望：`docs/dock/DECISIONS.md` D004/D025 的绑定持久化/绑定表语义；本次新增 `/v1/bindings` 并加入 `markRestored`，应能让吸附产生一条绑定记录（含 key/hwnd/anchor），供控制台“绑定”页和恢复标记使用。
- 实际：真实 daemon 探针通过主进程 `daemon-write` 调用 `/v1/pet/attach` 后，`/v1/state` 为 `attached`、`agentId=generic`，但 `/v1/bindings` 返回 `{"ok":true,"bindings":[]}`（`bindingCount:0`）。因此 `markRestored` 每 1.5s 重新读取一次 `/v1/bindings`，`data-restored` 永远不会被设置；控制台“绑定”列表也不会显示这次吸附。
- 复现：
  1. 临时 daemon + 真实 overlay（`--data-dir=<temp>`）。
  2. 通过 `window.foxOverlay.write('/v1/pet/attach','POST',{exe:'C:/x/Fake.exe',title:'FakeAgent',cls:'X',pid:123,startMs:1,hwnd:'0x1234',rect:{...}})`。
  3. 读取 `/v1/state` 与 `/v1/bindings`。
- 证据：探针实际输出 `attach.ok:true`、`state.pet.mode:'attached'`、`bindingCount:0`、`bindings:[]`。
- 频率：确定。
- 影响：绑定表/控制台绑定管理为空；`markRestored` 与新增 `/v1/bindings` 端点实际未被有效使用；四象限 corner 只存在 `localStorage`（`pet.js:820`），后端没有 anchor 记录。属于状态/后端契约不一致。
- 建议（非强制）：在 `/v1/pet/attach` 成功时 `upsertBinding`（key 由 exe/pid/startMs/hwnd 生成，anchor 由客户端传入），或在 `bindTo` 改走 `/bind`；补一条“attach 后 bindings 至少 1 条”的集成测试。

### [P2-3] 设置轮询不能让 `followMs` 与“桌宠模式”即时生效

- 位置：`dock/overlay/pet.js:1028-1031`：follow interval 在 `boot()` 时用当时的 `settings.followMs` 创建一次；`applySettings()`（`:182-194`）与 `refreshSettings()`（`:343-350`）只更新状态/位置，不重建 follow interval。`petMode` 只在拖拽分支读取（`:912`、`:946`），`applySettings`/`refreshState` 不会在“已吸附 → petMode=true”时解绑/转悬浮；菜单切换在 `:705`。
- 期望：`dock/README.md:86` 要求“桌宠模式 → 不再吸附/跟随，角色可以随意摆在屏幕上”；`ui/pages/settings.mjs:133-134` 的“跟随间隔”应即时生效（旧浮层在设置变化时 `restartFollowTimer`）。
- 实际：
  - `followMs` 在启动后修改只改变 settings 值，interval 仍按启动时的值运行；控制台改 250/1000ms 不会改变跟随频率。
  - 真实 daemon/overlay 探针：先 attach，再 `PUT /v1/settings {petMode:true}`，等待 3s 后 `/v1/state` 仍为 `attached`、`agentId=generic`，页面内 `settings.petMode:true` 且 `bound.hwnd:'0x1234'`；不会进入悬浮，follow 仍继续。
- 复现：真实 daemon + overlay，attach 后通过主进程 `write('/v1/settings','PUT',{petMode:true})`，3s 后读 `/v1/state` 与 `window.__pet`。
- 证据：探针输出 `{"stateAfterPetMode":{"mode":"attached","agent":"generic"},"afterInfo":{"pet":"attached","petMode":true,"bound":"0x1234"}}`；`pet.js` 中 `followMs` 只在 `:1031` 出现一次。
- 频率：确定。
- 影响：两项公开设置看起来保存成功但不生效；用户打开桌宠模式后仍被窗口吸附/跟随，必须手动拖拽或重置才能脱离。
- 建议（非强制）：设置变化时重建 follow interval；`petMode` 变为 true 时对 attached 状态执行 `floatAt()`（或后端 `drop-on-desktop`），并在 `refreshState` 中尊重 petMode。

## P3（不阻断，但应记录）

### [P3-1] 随机台词设置在宠物层没有消费方

- 位置：`ui/pages/settings.mjs:149-155` 仍暴露“随机台词间隔”；`docs/dock/MIGRATION.md:11` 声称“点击 / 随机说话”；`overlay/pet.js` 中 `chatterMs` 出现 0 次（`grep -c chatterMs overlay/pet.js` → 0）。新宠物层只有点击/菜单的 `speak()`，没有周期性台词 timer。
- 影响：用户修改随机台词间隔无任何效果；旧浮层已有的随机台词功能在替换后丢失。
- 建议：恢复 `chatterMs` 定时器，或从设置页/MIGRATION 移除该承诺。

### [P3-2] 新集成测试没有覆盖关键交互与安全边界

- 位置：`test/integration/overlay.itest.mjs:251-264` 的四象限用 `debugAttach` 直接改本地状态，不经过真实拖拽/后端；`:266-278` 的“拖到桌面”在已 attached 后执行，但只断言 `state.pet.mode/profileOf`，没有断言落点（因此 P1-1 的拉回不会被发现）；`:324-335` 的“解除吸附”直接 POST `/v1/pet/reset`，没有点击菜单/快览按钮；`:241` 的拖拽目标使用 `fakeWin.rect` 物理像素，未按 `devicePixelRatio` 换算；没有任何 alpha、`/v1/bindings`、`petMode`、`followMs`、token 不暴露或写接口 403 的用例。
- 影响：9 项测试全绿，但 P1-1/P2-1/P2-2/P2-3 都未被覆盖；测试名称比实际覆盖范围更强。
- 建议：补真实 attached 拖拽并断言落点、alpha mask、attach 后 bindings、petMode/followMs、无 token 写 403。

### [P3-3] 定时器/IPC 节流与资源治理退化

- 位置：`overlay/pet.js:879-883` 的 `setInteractive` 没有去重，`:1004-1013` 每 50ms 调一次 IPC；`:789-804` 的 `hitAt` 没有全局节流/并发上限（旧浮层有 30ms 节流）；`:1025-1032` 同时运行 1.5s/2s/3s/follow/15s 定时器；`:367-415` 每 1.5s `refreshState` 还会 `applySettings()` + `renderChip()` + `refreshRect()`，并可能 `renderQuick()`；`:352-365` 在无绑定记录时每 1.5s 重读 `/v1/bindings`。
- 影响：常驻进程的 IPC/daemon 请求频率升高；拖拽期间 `hit` 请求可能堆积；快速卡片打开时每 1.5s 重建窗口行。未观察到崩溃，但属于资源/性能退化。
- 建议：`setInteractive` 去重、`hitAt` 增加节流/在途合并、follow/refresh 做 in-flight 合并、无绑定记录时缓存一次。

### [P3-4] `pet-shots` 只生成截图，没有基线/断言，也未纳入视觉门禁

- 位置：`tools/pet-shots.mjs:56-113` 生成 20 张截图；`docs/dock/TESTING.md:13` 只把它列为命令；`tools/visual-test.mjs` 不包含宠物层，CI 也不运行 `shots:pet`。
- 实际：`npm run shots:pet` exit 0，生成 20 张；但没有逐像素基线、无页面异常断言，也不在 `npm run visual`/CI 中，回归无法被自动发现。
- 建议：为宠物层建立少量基线或在 `ui-check` 中加入宠物层结构/可访问性检查；至少断言无 `pageerror`。

## 已核对且未发现问题的项

- `npm run ci`：213 单测、语法、价目同步、lint 229 文件、engines parity 全部通过。
- `npm run test:all`：277/277 通过。
- 安全：`overlay/preload.cjs:4-35` 无 `getToken`；CDP 取得的 `window.foxOverlay` 键为 `setInteractive,getCursor,getBounds,write,openConsole,hideOverlay,quitDock,hit,getAlphaMask`，无 token；`daemon-write` 在 `overlay/main.cjs:389-403` 主进程读取 token。写接口 403 由 `daemon/src/v1.mjs:264-267` 的全局 token gate 覆盖（现有 v1 测试断言缺 token 403）；本次未新增绕过。
- CSP/导航：`overlay/index.html:6` 有 CSP；`overlay/main.cjs:337-340` 有 `will-navigate`/`setWindowOpenHandler`。
- `/v1/bindings` 是只在 Host 校验后可达的读接口（`v1.mjs:68-73`、`:461-464`）。
- `pet.js` 未使用 `innerHTML`/`eval`/`new Function`/`insertAdjacentHTML`（grep 无命中）；动态文本使用 `textContent`。
- `npm run shots:pet` 生成 20 张；截图目视未见溢出（快览卡/菜单/角色在 1280×720 下正常显示）。
- `/v1` token 检查：`v1.mjs:264-267`；`pet.js` 所有写操作走 `write()` → preload → 主进程 `daemon-write`。

## 未验证 / 无法验证

- 真实宿主（ZCode/WorkBuddy/Kimi/dsh）下的拖拽/吸附/悬浮/alpha 命中；本报告用 fixture + 真实 overlay 探针，未在真实宿主上做鼠标穿透 A/B。
- 真机 125%/150% DPI、多显示器、最大化窗口；P1-1 的探针在 fixture 浏览器中复现，真实 Electron 下未重复（代码同一份）。
- 长时间 soak、8 小时内存/句柄曲线、真实进程重启；未运行。
- `pet-shots` 的 20 张截图未逐张人工过目；只检查了 quick/menu 两张。
- `test:ui`/`visual` 未运行：本次不涉及控制台；宠物层没有 ui-check 覆盖。
