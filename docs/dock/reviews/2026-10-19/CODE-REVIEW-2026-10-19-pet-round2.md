# 代码审查报告（第二轮）：feat/dock 宠物层增量复审 2026-10-19

## 审查范围与方法

- 仓库根目录：`E:\WorkSpace\fox-dock`
- 审查工作树：`E:\WorkSpace\fox-dock`（HEAD `28fcf0a`；上一轮基线 `02b2481`）
- 上轮报告：`docs/dock/reviews/2026-10-19/CODE-REVIEW-2026-10-19-pet.md`
- 变更范围：`dock/overlay/pet.js`、`pet.css`、`index.html`、`daemon/src/v1.mjs`、`test/integration/overlay.itest.mjs`、`tools/pet-shots.mjs`、`package.json`。
- 运行环境：Windows 11 `10.0.26200` x64，Node `v24.18.1`，npm `12.0.2`，本机 Edge/Electron。

### 实际运行的命令与结果

| 命令 | 结果 |
|---|---|
| `cd /d "E:\WorkSpace\fox-dock\dock" && npm run ci` | **通过（exit 0）**。213/213 单测、lint 229 文件、价目同步、engines parity 通过。 |
| `npm run test:all` | **通过（exit 0）**。278/278 测试通过（含新增宠物层用例）。 |
| `npm run test:pet` | **通过（exit 0）**。`tools/pet-shots.mjs --theme light,dark --viewport 1280x720,960x680` 生成 40 张截图；新增 pageerror/越界断言通过。 |
| 真实 daemon + 真实 Electron overlay 探针 | alpha 掩码、`/v1/pet/attach` → `/v1/bindings`、petMode；结果见下。 |
| fixture + Playwright 探针 | 已吸附拖拽、follow 定时器、chatter。 |

### 未覆盖或无法验证

- 真实 ZCode/WorkBuddy/Kimi/dsh 宿主下的长期拖拽/透明窗穿透、125%/150% DPI、多显示器：未运行（当前桌面有外部窗口，避免误判）。
- `markRestored` 已用真实 daemon 探针验证（`data-restored:'1'`、`boundKey` 正确）；真实拖拽后的端到端 dataset 未在集成测试中断言。
- `pet-shots` 40 张截图未逐张人工过目；只做自动 pageerror/越界断言，且无逐像素基线。
- 8 小时 soak、真实宿主数据对账未运行。

## 结论

APPROVE

未解决数量：P1 = 0；P2 = 0；P3 = 4（均为不阻断项）。

## 与上一轮报告的对应关系

### P1 / P2

| 编号 | 状态 | 证据 |
|---|---|---|
| P1-1 已吸附拖拽被 follow/refreshState 拉回 | **FIXED** | `overlay/pet.js:391-392` `refreshState` 在 `dragging || pressing` 时直接返回；`:442-443` `refreshRect` 同样守卫；`:940-948` follow interval 含 `dragging || pressing || settings.petMode` 守卫。Playwright 探针：已吸附后拖到 `(200,200)`，1.2s 后仍为 `x:99,y:99,dragging:true`（上一轮同一探针为 `x:1078.39,y:518.39`）。`test:all` 的“拖到桌面”新增落点断言通过。 |
| P2-1 默认角色 alpha 掩码未加载 | **FIXED** | `overlay/pet.js:186-195` 将 `loadAlphaMask` 从 `changed` 分支移出，按 `alphaRole !== role.id` 加载；真实 Electron 探针：`alphaMaskNull:false, alphaRole:'fox', roleId:'fox'`。新集成测试断言 `window.__pet.alphaMaskLoaded()===true`。 |
| P2-2 attach 不写绑定表 | **FIXED** | `daemon/src/v1.mjs:535-547` 在 `drop-on-agent` 后 `upsertBinding`；`overlay/pet.js:856-865` 传 `anchor`；`:877` `bindTo` 后调用 `markRestored`。真实 daemon 探针：attach 后 `/v1/state` 为 attached，`/v1/bindings` `bindingCount:1`（上一轮为 0）；调用 `markRestored('0x1234')` 后 `data-restored:'1'`、`data-bound-key:'c:/x/fake.exe|123|1|1234'`。新集成测试断言 bindings 至少 1 条。残留 P3：anchor 时序/浮动后清理见 P3-1。 |
| P2-3 `followMs`/`petMode` 不即时生效 | **FIXED** | `overlay/pet.js:207` 在 `followMs` 变化时 `restartFollowTimer`，`:940-948` 重建 interval；`:209-214` 在 `petMode && attached` 时调 `floatAt()`。真实 daemon 探针：attach 后 `PUT /v1/settings {petMode:true}`，3s 后 `/v1/state` 为 `floating`、`bound:''`；`test:all` 断言 `window.__pet.followEvery===250` 且 petMode 转 floating。 |
| P3-1 chatter 设置无消费方 | **FIXED** | `overlay/pet.js:208` 按 `chatterMs` 变化重启；`:950-959` 新增 `restartChatter`（30s 下限、dnd/拖拽/quick/menu/bubble 守卫）。fixture 探针：`chatterMs=30000` 下 31.5s 后 `speak` 计数 1。 |
| P3-2 测试覆盖 | **PARTIAL** | 新增 alpha、bindings、token、拖拽落点、petMode/followMs、无 token 403 断言（`test/integration/overlay.itest.mjs:246-368`）。仍：四象限用 `debugAttach`（`:271-284`）、重置直接调 API（`:366-377`）、拖拽目标仍用 `fakeWin.rect` 物理像素未按 DPR 换算（`:246-247`），无 chatter/hit 节流/`markRestored` 的直接断言。 |
| P3-3 定时器/IPC 资源治理 | **PARTIAL** | `setInteractive` 已去重（`pet.js:931-938`）、`hitAt` 已加 30ms/在途合并（`:833-854`）；但 `refreshState` 仍每 1.5s 调 `applySettings()+renderChip()+refreshRect()`，`applySettings` 可能 `renderQuick`（`:198-218`）；`setInterval` 组仍为 1.5/2/3/15s + follow（`:1102-1106`），未做 in-flight 合并或卸载清理。 |
| P3-4 pet-shots 无基线/断言 | **PARTIAL** | `tools/pet-shots.mjs:88-120` 已增加 pageerror 与 fox/quick/menu 越界断言，`test:pet` 40 张通过；仍无逐像素基线、未纳入 `npm run visual`/CI。 |
| P3-（上轮）随机台词丢失 | **FIXED** | 同上 P3-1；`speak` 计数探针通过。 |

### 其他上轮 P3

- 上轮 P3 的“UI 字号/菜单角色/芯片可读性”已在本轮 `pet.css`/`index.html` 调整（`#pet-menu` 32/20、`#chip-adapter` 12、`quick-value` 32、menu role `group`）；未见新问题。
- 上轮 P3 的“hit/IPC”已按上表 P3-3 部分修复。

## 问题（剩余 P3，不阻断）

### [P3-1] 绑定记录 anchor 使用旧值；浮动/重置后绑定记录不清理

- 位置：`dock/overlay/pet.js:856-865`：`bindTo` 先把 `anchor: corner` 发给 daemon，随后 `:870` 才根据本次落点计算新的 `corner`；`daemon/src/v1.mjs:538-541` 直接把请求里的 `anchor` 写入绑定表。`floatAt`（`pet.js:882-892`）和 `resetPet`（`:894-904`）只改宠物状态，不调用 `/bind DELETE` 或清理当前绑定。
- 期望：绑定表里的 anchor 应与本次四象限落点一致；解除吸附/浮动后，当前绑定不应继续作为“当前绑定”存在（历史记录可另行保留）。
- 实际：首次拖到左侧/顶部时，绑定表保存的是默认/上一次的 `{h:'right',v:'bottom'}`；localStorage 里的新 corner 与 `/v1/bindings` 的 anchor 不一致。attach 后拖到桌面或重置，`/v1/bindings` 仍保留该 hwnd 的记录。
- 复现：
  1. 真实 daemon + overlay，先拖到窗口左侧/顶部（或调用 `bindTo` 前将 `corner` 设为默认）。
  2. 读取 `/v1/bindings` 的 `anchor`，与 `localStorage['fox-dock:corner:<hwnd>']` 对比。
  3. 再拖到桌面空白或点“解除吸附并重置”，`/v1/bindings` 仍返回该记录。
- 证据：`bindTo` 的 `write(..., { anchor: corner })` 在 `corner = anchorFromRect(...)` 之前；`floatAt`/`resetPet` 无绑定删除调用。新测试只断言 attach 后 bindings 长度，不检查 anchor/清理。
- 频率：确定（左侧/顶部落点；浮动/重置必现）。
- 影响：绑定表的 anchor 不是当前落点；控制台/后续恢复若使用 binding anchor 会得到错误的象限；浮动/重置后绑定管理会显示过期记录。当前宠物层位置实际依赖 localStorage，所以用户可见影响有限，列为 P3。
- 建议：先计算 `corner` 再 POST；`floatAt`/`resetPet` 调用 `/bind DELETE` 或提供 v1 清理接口；补 anchor/清理断言。

### [P3-2] 测试仍有交互/边界缺口

- 位置：`dock/test/integration/overlay.itest.mjs:271-284` 的四象限用 `window.__pet.debugAttach` 直接改本地状态，不经过真实拖拽/后端；`:366-377` 的“解除吸附”直接 POST `/v1/pet/reset`，没有点击菜单/快览按钮；`:246-247` 的拖拽目标使用 `fakeWin.rect` 物理像素，未按 `devicePixelRatio` 换算；无 chatter、`hitAt` 节流、`markRestored` dataset 的直接断言。
- 期望：新测试应真实覆盖拖拽/菜单/四象限/恢复标记。
- 实际：`test:all` 278 全绿，但这些路径仍可能回归而不被发现；四象限测试无法证明真实拖拽产生的 corner。
- 频率：确定（代码覆盖缺口）。
- 影响：测试可信度不足；P1-1 上一轮就是“测试名称覆盖但实际未断言落点”才漏出。
- 建议：用真实 drag 覆盖四象限并断言 `/v1/bindings` anchor/localStorage；用 UI 按钮覆盖 reset；拖拽坐标按 DPR 换算；补 chatter/节流断言。

### [P3-3] 定时器/刷新频率仍偏高

- 位置：`dock/overlay/pet.js:1102-1106`：`refreshState` 1.5s、`refreshSettings` 2s、`refreshAgentData` 3s、`loadQueue` 15s，另有 follow 250–1000ms、cursor 50ms；`refreshState` 每 1.5s 调 `applySettings`/`renderChip`/`refreshRect`，`applySettings` 在 quickOpen 时还会 `renderQuick`（`:198-218`）。
- 期望：常驻进程的轮询应按需/按变化，避免每秒级 UI 重建和无变化请求。
- 实际：即使设置不变，`refreshState` 每 1.5s 仍完整 apply/render；quick 卡打开时每 1.5s 重建窗口行。`setInteractive`/`hitAt` 已修复节流，剩余主要是刷新频率。
- 频率：确定。
- 影响：IPC/daemon 调用与 DOM 重建频率偏高；长时间运行 CPU/功耗风险。未观察到崩溃。
- 建议：`refreshState` 只在 state 变化时 apply/render；合并 in-flight 请求；quick 卡刷新独立节流。

### [P3-4] `test:pet` 截图数与文档不一致，且仍无逐像素基线

- 位置：`dock/package.json:39` `test:pet` 使用 `--theme light,dark --viewport 1280x720,960x680`；`tools/pet-shots.mjs` 有 10 个状态 → 40 张。`docs/dock/TESTING.md:13` 与 `docs/dock/PLAN.md:297` 仍写“20 张截图”。
- 期望：文档与实际门禁一致；宠物层视觉回归有稳定基线。
- 实际：`npm run test:pet` 实际输出“已生成 40 张”；没有基线/差异图，未接入 `npm run visual` 或 CI。自动断言只有 pageerror/越界，不能发现颜色、层级、文字遮挡。
- 频率：确定。
- 影响：文档误导；宠物层视觉回归仍依赖人工过目。
- 建议：更新文档为 40（或把 `test:pet` 视口收敛到 1 个）；建立少量宠物层基线并纳入视觉门禁。

## 已核对且未发现问题的项

- `npm run ci`：213/213 单测、lint 229 文件、价目同步、engines parity 全部通过。
- `npm run test:all`：278/278 通过。
- `npm run test:pet`：40 张截图，pageerror/越界断言通过。
- P1-1：已吸附拖拽 1.2s 后仍停在落点（探针 `x:99,y:99,dragging:true`）；follow/refreshState/refreshRect 均有拖拽守卫。
- P2-1：真实 Electron 探针 `alphaMaskNull:false, alphaRole:'fox'`；默认 fox 启动即加载掩码。
- P2-2：真实 daemon 探针 attach 后 `/v1/bindings` 至少 1 条；`markRestored` 在 `bindTo` 后调用；`/v1/bindings` 读路由有 Host 校验。
- P2-3：`followMs=250` 后 `window.__pet.followEvery===250`；`petMode=true` 后状态转 floating、bound 清空。
- P3-1：`chatterMs=30000` 的 fixture 探针 31.5s 后 `speak` 计数 1；dnd/拖拽/quick/menu 守卫存在。
- 安全：渲染层 `window.foxOverlay` 无 `getToken`（探针 keys 仅 `setInteractive,getCursor,getBounds,write,openConsole,hideOverlay,quitDock,hit,getAlphaMask`）；写操作走主进程 `daemon-write`（`overlay/main.cjs:389-403`）；无 token 的 `POST /v1/pet/reset` 返回 403（新测试断言）。
- CSP/导航：`overlay/index.html:6` CSP；`overlay/main.cjs:337-340` `will-navigate`/`setWindowOpenHandler`。
- `pet.js` 无 `innerHTML/eval/new Function/insertAdjacentHTML`；动态文本用 `textContent`。
- UI 尺寸调整（`#pet-menu` 32/20、`#chip-adapter` 12、`quick-value` 32、menu role `group`）未导致 `test:pet` 越界/pageerror。

## 未验证 / 无法验证

- 真实 ZCode/WorkBuddy/Kimi/dsh 宿主下的长期拖拽、透明窗 alpha 点击穿透、125%/150% DPI、多显示器：未运行（当前桌面有外部窗口，避免误判）。
- `markRestored` 已用真实 daemon 探针验证（`restored:'1'`、`boundKey` 正确）；未做真实拖拽后的端到端 dataset 断言。
- P3-1 的 anchor 时序未做真实拖拽截图/绑定对比实验；由代码路径确定。
- `pet-shots` 40 张未逐张人工过目；无逐像素基线。
- 8 小时 soak、真实更新/宿主数据未运行。
