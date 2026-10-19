# UI/UX 审查报告（第四轮）：控制台（8 页）+ 宠物层 2026-10-19

## 环境

- 分支/工作树：`feat/dock`，HEAD `8facb51`（`fix(dock/ui): 760 总览首屏恢复三格指标；视觉截图遮罩动态值`）。工作树无已跟踪文件修改；未跟踪文件为既有 CODE/UI 审查报告（含本轮新增本报告）。
- 本轮修复内容（实测 diff）：`@media (max-width:859px)` 移除 `.col-7/.col-5 span 12`（760px 恢复两栏）；`shots.mjs` 截图前隐藏 `[data-visual-mask]`；`about.mjs` 给 daemon/pid、运行时长、生成时间加 `data-visual-mask`；`overlay/renderer.js` 账号池文案条件改为 `pool.total > 1`；相应 760px 视觉基线更新。
- 页面：overview、context、usage、quota、vendors、roles、settings、about
- 主题：浅色、深色
- 视口：960×680、760×560
- DPR：1
- 浏览器：Microsoft Edge 155.0.0.0（Playwright `channel:'msedge'`，headless）
- 夹具：`test/fixtures/scenes/zcode-normal.json`，夹具 daemon 端口 39581
- 实际运行命令与结果：
  - `cd /d "E:\WorkSpace\fox-dock\dock" && npm run test:ui` → **通过**：`8 页 × 2 主题 × 2 视口（布局 / 可访问名称 / axe）`
  - `cd /d "E:\WorkSpace\fox-dock\dock" && npm run visual` 连续两次 → **均通过**：`32 张（阈值 0.1%）`
  - `node tools/shots.mjs --page console --console-pages overview,context,usage,quota,vendors,roles,settings,about --theme light,dark --viewport 960x680,760x560 --base http://127.0.0.1:39581 --out test/visual/__shots__/round4`
- 截图目录：`E:\WorkSpace\fox-dock\dock\test\visual\__shots__\round4`
- 测量脚本（仓库外）：`C:\Users\paper\AppData\Local\Temp\fox-ux-review-2026-10-19-round4\`（`measure.mjs`、`verify2.mjs`、`firstscreen.mjs`、`statvis.mjs`、`sidebar.mjs`、`tokens.mjs`、`swatch.mjs`、`mask.mjs`）
- 宠物层：仍以浏览器渲染 `overlay/index.html` 审查；夹具缺少 `/bindings`、`/billing`，绑定/账单端点用 Playwright 路由合成。真实 Electron 透明窗、鼠标穿透、高 DPI 未验证。

## 结论

APPROVE

未解决：P1 = 0，P2 = 0，P3 = 3（P3-1、P3-2、P3-14；均为上一轮遗留的 PARTIAL，本轮无新增回归）。

## 问题（逐条复审，对照 UI-REVIEW-2026-10-19-round3.md）

### [P2-R1] 760×560 总览首屏缺三格指标、上下文卡被裁 — FIXED

- 位置：总览 / `.col-7 + .col-5`、`.col-4` 指标卡 / `dock/ui/console.css`（移除 760px 下的 `span 12`）、`dock/ui/pages/overview.mjs:134-141`
- 规格依据：UI-SPEC §6「总览首屏可见主数字/上下文/三格指标」
- 环境：浅色/深色，760×560，DPR 1
- 证据：
  - `.content` rect `[56,112,704,448]`，首屏底边 560；
  - hero `[80,192,376,260]` 与上下文卡 `[472,192,264,260]` 并排，上下文卡底边 452，完整在屏；
  - 三张 `.col-4` 卡 `[80/304/528,468,208,103]`；
  - 逐文本 rect：三张卡的 `.stat-label` bottom=503、`.stat-value` bottom=534、`.stat-sub` bottom=554，均 ≤560，全部在首屏内（第三格副标题「余额/套餐取决于当前 provider。」可读）；
  - `.content` `scrollWidth=704=clientWidth`，无横向滚动。
  截图：`E:\WorkSpace\fox-dock\dock\test\visual\__shots__\round4\console-overview-light-760x560-dpr1.png`（深色同）。
- 判定：FIXED。

### [P3-R1] 视觉回归 2/32 因动态运行信息误报 — FIXED

- 位置：视觉门禁 / `dock/tools/shots.mjs:91-92`、`dock/ui/pages/about.mjs:93-94, 115`
- 规格依据：TESTING.md「动态文本用 `data-visual-mask` 遮罩」
- 环境：960×680 与 760×560，视觉测试固定 Edge 155，DPR 1
- 证据：
  - `npm run visual` 连续两次运行均通过（32/32，阈值 0.1%）；
  - about 页 DOM 有 3 个 `[data-visual-mask]`（daemon/pid、运行时长、生成时间），真实界面 `visibility=visible`；按 `shots.mjs` 逻辑置为 `hidden` 后三者 `visibility=hidden`；
  - 截图 `round4\console-about-light-960x680-dpr1.png` 中 daemon/运行时长取值与「生成于 …」行已不再参与比对（取值区为空），布局与其余内容不变。
- 判定：FIXED。

### [P3-1] 同一行卡片高度不一致 — PARTIAL（维持）

- 位置：角色页/关于页 `.grid` 行
- 规格依据：检查清单 B
- 环境：960×680 与 760×560，DPR 1
- 证据：总览/上下文/用量已等高；角色页角色库 731 vs 档案设置 376（960 与 760 相同）；关于页版本 150 vs 运行信息 298。截图 `round4\console-roles-light-960x680-dpr1.png`、`console-about-light-960x680-dpr1.png`。
- 判定：PARTIAL（未阻断）。

### [P3-2] 设计令牌偏离 — PARTIAL（维持）

- 位置：`dock/ui/console.css:642`（图例色块 4px）、角色导入 `+` 28px、`dock/ui/console.mjs:373`/`roles.mjs:195`（`#f0a04b` 回退）
- 规格依据：UI-SPEC §2（圆角 6/8/12/16/999；字号 8 档）
- 环境：960×680，DPR 1
- 证据：本轮 diff 未触及；计算值不变：`.legend .swatch` `border-radius:4px`、`role-add` `+` `font-size:28px`；`.segmented` gap 0、`.segmented button`/`.btn` gap 4 与导航指示条 6px 已在允许体系；Skeleton 1.2s 已被规格例外覆盖。
- 判定：PARTIAL（未阻断）。

### [P3-14] 侧栏关于未贴底 / 窄侧栏状态 — PARTIAL（维持）

- 位置：`dock/ui/console.mjs:435-442`、`dock/ui/console.css:856`
- 规格依据：UI-SPEC §3「底部状态 + 关于」
- 环境：960×680 与 760×560，DPR 1
- 证据：关于入口贴底不变（760：`nav.about` y=508，footer y=503）；760px 下 `.sidebar-status .status-text` 仍为 `none`，状态点 rect `[10,548,0,0]`、背景 `rgba(0,0,0,0)`，即状态点不可见；截图 `round4\round4-sidebar-760.png` 底部无在线状态。
- 判定：PARTIAL（未阻断；标题栏仍有「已连接」）。

### 其余上一轮 P1/P2 与已修复 P3 — 全部维持 FIXED

- P1-1：760 下 8 个 `.nav-item` 均有 `aria-label`/`title`，axe 仅剩 `region` moderate；截图 `round4\round4-overview-760-nav.png`。
- P1-2：宠物层厂商面板 GLM「72%剩余 / 已用 28% · 余 72%」、CommandCode「42%/18%/30%」；控制台额度页同夹具「72% 剩余」。
- P2-1：对话框初始焦点在 `SELECT`「校正类型」，Esc 关闭并回焦「校正」，Tab 8 次不离开 dialog。
- P2-2：`.content` 在 960 为 `752/752`、760 为 `704/704`，无横向滚动；`clipped` 为空。
- P2-3：默认 CNY 时 CSV 9 行（表头 + 8 条）全部 CNY，无 credit 行。
- P2-4：「气泡停留秒数」「周预算」「月预算」「显示或隐藏角色热键」「打开控制台热键」「隐藏金额热键」。
- P2-5：`hideMoney=true` 时控制台 hero/表格与宠物层胶囊均为 `•••`；`dnd=true` 时气泡/台词隐藏。
- P2-6：`#bubble.open` `pointer-events:auto`，点击中心后隐藏。
- P2-7：Segmented 82×32、Toggle 36×32、角色删除 32×32；`smallTargets` 为空。
- P2-8：图表 SVG 文本 12px、Gauge 24/32px、760 H1 20px。
- P2-9：设置分组点击不改 hash（`#settings` 保持），刷新停留设置页。
- P2-10：模板 textarea `aria-label="气泡模板 JSON"`，axe 无违规。
- P3-3…P3-13、P3-15、P3-16：开发者文案、版本折行、空表头、重复 alt、StackedBar/AreaChart 语义、Toast/气泡 aria-live、搜索框标签、会话行键盘、截断 tooltip、胶囊千分位、气泡左右翻转、额度「不可得」、宠物层重复金额，本轮复核均未回退（证据同第三轮报告；`verify2.json` 与 `round4` 截图复核一致）。

## 新回归排查

- 未发现本轮修复引入的新的 UI 回归。
- 说明：`shots.mjs` 的 `[data-visual-mask]` 隐藏只作用于截图测试，不影响真实界面（`mask.mjs` 实测真实界面 `visibility=visible`）。
- 说明：760px 恢复两栏后，about/context 的表格单元格出现截断（如「DeepSeek Harness」「计费 · 上下文 · 跟随」），但均带有与可见文本一致的 `title`，符合检查清单 B「截断并可通过 tooltip 读取」；未计为缺陷。
- 说明：`overlay/renderer.js` 的账号池文案条件（`pool.total > 1`）在本夹具（无 pool）下不改变显示。

## 规格空白（不作为缺陷）

- 宠物层「今日 tokens」指标卡第三行「今日调用」没有数值；UI-SPEC 未定义宠物层面板指标卡构成（详情区仍有「今日调用 38 次」）。
- 宠物层面板不可聚焦（`focusable:false`）与托盘菜单键盘路径：UI-SPEC 未定义宠物层面板键盘操作。
- 气泡水平翻转后箭头被钳在气泡近端边缘（与角色中心相距 117px），检查清单只要求「按象限翻转」，未定义箭头精确落点。

## 已核对且未发现问题的项

- `npm run test:ui` 通过：8 页 × 2 主题 × 2 视口。
- `npm run visual` 连续两次通过：32/32，阈值 0.1%。
- axe（8 页 × 960/760，浅/深）：全部页面仅 `region` moderate，critical/serious = 0。
- 横向滚动：8 页 × 2 视口 × 2 主题的 document 与 `.content` 均无横向溢出。
- 760×560 总览首屏：主数字（¥12.34）、上下文环与占用/模型、三格指标的标签/值/副标题全部在屏内（statvis.mjs 实测 rect）。
- 对比度：浅色/深色抽样 ≥4.5:1（浅色 text-3 5.28–5.87、徽标 5.64–8.72；深色 6.09–10.56）。
- 宠物层：厂商百分比、隐藏金额/勿扰、气泡点击/翻转、胶囊千分位、四象限吸附探针通过。

## 未验证 / 无法验证

- 真实 Electron 宠物层：透明窗、鼠标穿透、alpha 掩码、托盘菜单键盘路径；高 DPI 未测（参数 DPR 1）。
- 夹具成功路径：额度校正提交后数值变化、厂商密钥保存后的掩码、角色导入/删除/切换与宠物层同步、模板/队列保存读回、从旧挂件导入向导（夹具无对应成功路由）。
- 设置持久化：夹具 `PUT /v1/settings` 返回原设置，未验证真实磁盘持久化。
- 上下文内容随会话切换：夹具 context 路由忽略 session，真实同步未验证。
- 视觉基线覆盖：`npm run visual` 仍只比对 32 张 `console-*`；`baseline/console/overlay-*.png` 未纳入该命令。
