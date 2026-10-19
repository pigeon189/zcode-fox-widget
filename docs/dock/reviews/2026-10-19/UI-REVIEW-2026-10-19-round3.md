# UI/UX 审查报告（第三轮）：控制台（8 页）+ 宠物层 2026-10-19

## 环境

- 分支/工作树：`feat/dock`，HEAD `bde4dd6`（`fix(dock): 第二轮审查修复（轮询副作用、令牌代理、UI 溢出）`）。工作树无已跟踪文件修改；未跟踪文件为两份既有 CODE/UI 审查报告及第二轮 UI 报告，本轮只新增本报告与 gitignored 截图。
- 规格：当前 `docs/dock/UI-SPEC.md`（本轮把 Skeleton 1.2s 列为加载态例外）。
- 页面：overview、context、usage、quota、vendors、roles、settings、about
- 主题：浅色、深色
- 视口：960×680、760×560
- DPR：1
- 浏览器：Microsoft Edge 155.0.0.0（Playwright `channel:'msedge'`，headless）
- 夹具：`test/fixtures/scenes/zcode-normal.json`，夹具 daemon 端口 39571
- 实际运行命令与结果：
  - `cd /d "E:\WorkSpace\fox-dock\dock" && npm run test:ui` → **通过**：`8 页 × 2 主题 × 2 视口（布局 / 可访问名称 / axe）`
  - `cd /d "E:\WorkSpace\fox-dock\dock" && npm run visual` → **失败**：`差异 0.11%：console-about-light-960x680-dpr1.png`、`差异 0.12%：console-about-dark-960x680-dpr1.png`，`视觉回归失败：2 / 32 张`
  - `node tools/shots.mjs --page console --console-pages overview,context,usage,quota,vendors,roles,settings,about --theme light,dark --viewport 960x680,760x560 --base http://127.0.0.1:39571 --out test/visual/__shots__/round3`
- 截图目录：`E:\WorkSpace\fox-dock\dock\test\visual\__shots__\round3`（32 张矩阵 + 本轮专项截图）；视觉差异图：`E:\WorkSpace\fox-dock\dock\test\visual\__diff__\console-about-{light,dark}-960x680-dpr1.png`
- 测量脚本（仓库外）：`C:\Users\paper\AppData\Local\Temp\fox-ux-review-2026-10-19-round3\`（`measure.mjs`、`verify2.mjs`、`firstscreen.mjs`、`sidebar.mjs`、`bubble.mjs`、`tokens.mjs`、`swatch.mjs`）
- 宠物层：仍以浏览器渲染 `overlay/index.html` 审查；夹具缺少 `/bindings`、`/billing`，绑定/账单端点用 Playwright 路由合成（快照数据来自夹具）。真实 Electron 透明窗、鼠标穿透、高 DPI 未验证。

## 结论

REQUEST_CHANGES

未解决：P1 = 0，P2 = 1，P3 = 4。

说明：上一轮 P1 两项、P2 十项全部通过本轮探针；P2-2 的溢出已修复。但本轮修复把总览上下文卡改为竖直排列，导致 760×560 首屏不再显示三格指标（P2-R1，新回归）。P3 剩余：P3-1、P3-2、P3-14 三项未完全修复，以及本轮视觉基线更新引入的视觉门禁失败 P3-R1。

## 问题（逐条复审）

### [P2-R1] 本轮修复引入：760×560 总览首屏不再显示三格指标，上下文卡被首屏裁掉

- 位置：总览 / `.content` 与 `.col-4` 指标卡 / `dock/ui/pages/overview.mjs:134-141`
- 规格依据：UI-SPEC §6「总览首屏可见主数字/上下文/三格指标」
- 环境：浅色/深色，760×560，DPR 1
- 实际：`.content` 的 rect 为 `[56,112,704,448]`，首屏底边 560；三张 `.col-4` 指标卡的 y=614、高 103，`statsVisible=[false,false,false]`；上下文卡 y=338、高 260，底边 598，已超出首屏。截图：`E:\WorkSpace\fox-dock\dock\test\visual\__shots__\round3\console-overview-light-760x560-dpr1.png`、`console-overview-dark-760x560-dpr1.png`。960×680 下指标卡 y=468–571，仍在首屏内（三张均可见）。
- 复现：
  1. 以 760×560 打开 `http://127.0.0.1:39571/ui/console.html#overview`；
  2. 不滚动，观察首屏只有主数字卡和上下文卡（上下文卡下半部被裁）；
  3. 读取 `.col-4` 的 y 与 `.content` 的可视底边。
- 频率：确定（浅/深两套主题）
- 影响：最小窗口下三格指标完全在首屏之外，上下文卡也被截断；用户必须滚动才能看到主数字/上下文/三格指标，违反 §6 首屏要求。这是本轮为修 P2-2 溢出而把上下文卡从横排改为竖排引入的回归。
- 建议（非强制）：上下文卡在宽卡片（760px 全宽 656px）保持横排，仅在窄列（960px 的 284px）竖排；或用 `flex-wrap`/容器查询，避免 760px 首屏被撑高。

### [P3-R1] 本轮视觉基线更新引入：`npm run visual` 2/32 失败（about 960 动态运行信息未遮罩）

- 位置：视觉门禁 / `console-about-{light,dark}-960x680-dpr1.png` / `dock/tools/visual-test.mjs`、`dock/ui/pages/about.mjs:91-99`
- 规格依据：TESTING.md「视觉基线：动态文本用 `data-visual-mask` 遮罩」；本轮结论规则「本次修复引入的 P3 回归需 REQUEST_CHANGES」
- 环境：960×680，视觉测试固定 Edge 155，DPR 1
- 实际：`npm run visual` 报 about light 0.11%、about dark 0.12%，超过 0.1% 阈值；diff 图 `__diff__\console-about-light-960x680-dpr1.png` 的红色差异只落在「daemon :39571 · pid …」「运行时长 …」「生成于 …」等动态文本，布局/颜色/尺寸无差异。基线已按新样式更新，但 about 页的运行信息没有遮罩，每次夹具 PID/uptime/生成时间变化都会导致误报。
- 复现：
  1. `cd /d "E:\WorkSpace\fox-dock\dock" && npm run visual`；
  2. 观察 about light/dark 960 两张失败；
  3. 查看 `test/visual/__diff__` 的差异图，差异集中在运行信息数字。
- 频率：确定（本轮运行 2/32；取决于夹具 PID/uptime）
- 影响：视觉回归门禁变红，后续每次修复都会被动态值误报；不是用户可见的 UI 回归，但属于本轮基线更新引入的 P3 门禁回归。
- 建议（非强制）：给 about 的运行信息/生成时间加 `data-visual-mask`，或在视觉测试中固定 pid/uptime/时间。

### [P1-1] 760px 导航按钮失去可访问名称 — FIXED

- 位置：`.sidebar button.nav-item` / `dock/ui/console.mjs:432`
- 规格依据：UI-SPEC §3、§6；检查清单 A/F
- 环境：760×560，浅/深，DPR 1
- 证据：8 个 `.nav-item` 均有 `aria-label`/`title`；760px axe 只剩 `region`（moderate），无 `button-name`；截图 `round3\round3-overview-760-nav.png`。
- 判定：FIXED。

### [P1-2] 宠物层厂商页百分比错误 — FIXED

- 位置：`dock/overlay/renderer.js:1323-1329`
- 规格依据：UI-SPEC §5；检查清单 D/H
- 环境：宠物层，浅色，960×680，DPR 1
- 证据：面板文本为 GLM「72%剩余 / 已用 28% · 余 72%」、CommandCode「42%/18%/30%」；截图 `round3\round3-overlay-vendors.png`，控制台额度页同夹具显示「72% 剩余」。
- 判定：FIXED。

### [P2-1] 对话框 Esc / 焦点陷阱 / 焦点恢复 — FIXED

- 位置：`dock/ui/components/base.mjs:90-132`
- 规格依据：UI-SPEC §6；检查清单 C
- 环境：760×560，DPR 1
- 证据：初始焦点为 dialog 内 `SELECT`「校正类型」；Esc 后 dialog 数为 0、焦点回「校正」；Tab 8 次始终在 dialog 内并回环；取消后焦点回「校正」；对话框 440×400 在视口内。
- 判定：FIXED。

### [P2-2] 总览上下文数字折行/溢出 — FIXED

- 位置：`dock/ui/pages/overview.mjs:134-141`、`dock/ui/console.css`
- 规格依据：检查清单 B「数字不换行」及「无横向滚动/无元素溢出」
- 环境：960×680 与 760×560，浅/深，DPR 1
- 证据：上下文卡改为竖排后 `.mono.nowrap` 不再被挤压；960 下 `.content` `scrollWidth=752=clientWidth`，760 下 `704=704`；`clipped` 列表为空，无横向滚动。截图 `round3\console-overview-light-960x680-dpr1.png`。
- 判定：FIXED（本轮 P2-2 的具体溢出条件已满足；首屏回归另见 P2-R1）。

### [P2-3] 用量导出忽略币种筛选 — FIXED

- 位置：`dock/ui/pages/usage.mjs:137-138`
- 规格依据：检查清单 E；UI-SPEC §5
- 环境：960×680，DPR 1
- 证据：CNY 选中时表格 8 行；CSV 9 行（表头 + 8 条），全部 CNY，无 WorkBuddy `credit/CREDIT` 行。
- 判定：FIXED。

### [P2-4] 设置页多控件同名标签 — FIXED

- 位置：`dock/ui/pages/settings.mjs:145-147, 163-165, 205-207`
- 规格依据：检查清单 C
- 环境：960×680，DPR 1
- 证据：aria-label 为「气泡停留秒数」「周预算」「月预算」「显示或隐藏角色热键」「打开控制台热键」「隐藏金额热键」。
- 判定：FIXED。

### [P2-5] 隐藏金额与勿扰不生效 — FIXED

- 位置：`dock/ui/lib/format.mjs:4-27`、`dock/overlay/renderer.js:492-494, 581-590`
- 规格依据：检查清单 E/H
- 环境：控制台/宠物层，960×680，DPR 1
- 证据：`hideMoney=true` 时控制台 hero/表格金额均为 `•••`，宠物层胶囊为「今日 ••• · 上一轮 •••」；`dnd=true` 时 `showBubble`/`sayRandom` 后 `#bubble.hidden`/`#say.hidden` 均为 true。
- 判定：FIXED。

### [P2-6] 气泡点击关闭/队列推进不可用 — FIXED

- 位置：`dock/overlay/styles.css:1224`
- 规格依据：检查清单 H
- 环境：宠物层，960×680，DPR 1
- 证据：`#bubble.open` 的 `pointer-events` 为 `auto`；点击气泡中心后 `#bubble.hidden=true`。
- 判定：FIXED。

### [P2-7] 点击区小于 32×32 — FIXED

- 位置：`.segmented button`、`.toggle`、`.role-del`
- 规格依据：检查清单 C
- 环境：960×680，DPR 1
- 证据：Segmented 82×32、Toggle 36×32、角色删除 32×32；`smallTargets` 为空。
- 判定：FIXED。

### [P2-8] 可见文本字号低于 12px/超出允许档位 — FIXED

- 位置：`dock/ui/charts/svg.mjs`、窄屏 H1
- 规格依据：UI-SPEC §2；检查清单 B
- 环境：960/760，浅/深，DPR 1
- 证据：图表 SVG 文本全部 12px；Gauge 24/32px；760px H1 20px；`npm run test:ui` 通过。角色页 `+` 仍为 28px，归入 P3-2。
- 判定：FIXED（上轮列出的图表/Gauge/H1 均已修复）。

### [P2-9] 设置分组链接改写 hash 导致刷新回总览 — FIXED

- 位置：`dock/ui/pages/settings.mjs:85-92`
- 规格依据：检查清单 A
- 环境：960×680，DPR 1
- 证据：点击「气泡与提醒」后 hash 仍为 `#settings`，`scrollTop=734`；刷新后 H1「设置」，`page.settings` 存在。
- 判定：FIXED。

### [P2-10] 角色 JSON 对话框 textarea 无可访问名称 — FIXED

- 位置：`dock/ui/pages/roles.mjs:239`
- 规格依据：检查清单 C/F
- 环境：760×560，DPR 1
- 证据：`aria-label="气泡模板 JSON"`；对 `.overlay` 的 axe 无违规。
- 判定：FIXED。

### [P3-1] 同一行卡片高度不一致 — PARTIAL

- 位置：角色页/关于页 `.grid` 行
- 规格依据：检查清单 B
- 环境：960×680，DPR 1
- 证据：总览/上下文/用量已等高；角色页角色库 731 vs 档案设置 376，关于页版本 150 vs 运行信息 298。截图 `round3\console-roles-light-960x680-dpr1.png`、`console-about-light-960x680-dpr1.png`。
- 剩余：含多张卡片的列仍无法与同行单卡等高。
- 判定：PARTIAL。

### [P3-2] 设计令牌偏离 — PARTIAL

- 位置：`dock/ui/console.css:642`（图例色块 4px）、`dock/ui/pages/roles.mjs`（`+` 28px）、`dock/ui/console.mjs:373`/`roles.mjs:195`（`#f0a04b` 回退）
- 规格依据：UI-SPEC §2（圆角 6/8/12/16/999；字号 8 档）
- 环境：960×680，DPR 1
- 证据：重复的 `.nowrap/.sr-only/.grid` 块已合并为一份，`tokens.css` 重复 `--on-vendor` 已删除，gap 6/2 改为 4/0，导航指示条圆角改为 6px，Skeleton 1.2s 已被新规格列为例外；但 `.legend .swatch` 计算圆角仍为 `4px`（不在允许档位），角色导入 `+` 为 `28px`，两处 `#f0a04b` 回退值仍在。
- 判定：PARTIAL。

### [P3-3] 用户界面开发者/里程碑文本 — FIXED

- 位置：用量缓存空态、设置语言提示、宠物层大小提示
- 规格依据：检查清单 G
- 证据：旧「M8 接入」「英文在 P3 提供」「128px 容器…587」已移除；现为面向用户的说明。
- 判定：FIXED。

### [P3-4] 关于页版本号折行 — FIXED

- 位置：`dock/ui/pages/about.mjs:47`
- 规格依据：检查清单 B
- 证据：版本 span 高度 36px、line-height 36px，单行。
- 判定：FIXED。

### [P3-5] 厂商表空表头 — FIXED

- 位置：`dock/ui/pages/vendors.mjs:161`
- 规格依据：检查清单 F
- 证据：第 5 列表头含 `.sr-only`「操作」；axe 无 `empty-table-header`。
- 判定：FIXED。

### [P3-6] 角色图片 alt 重复 — FIXED

- 位置：`dock/ui/pages/roles.mjs:173`
- 规格依据：检查清单 F
- 证据：图片 `alt=""`；axe 无 `image-redundant-alt`。
- 判定：FIXED。

### [P3-7] StackedBar 语义/AreaChart 悬停 — FIXED

- 位置：`dock/ui/charts/svg.mjs:50-106`
- 规格依据：UI-SPEC §4；检查清单 D
- 证据：StackedBar `role="img"` + `aria-label`；AreaChart 每个采样点有 `<circle><title>`。
- 判定：FIXED。

### [P3-8] Toast role / 宠物层 aria-live — FIXED

- 位置：`dock/ui/components/base.mjs:135-137`、`dock/overlay/index.html:10-17`
- 规格依据：检查清单 C/F
- 证据：`.toast-wrap` 为 `role="status"` + `aria-live="polite"`；`#say`/`#bubble` 同为 `role="status"` + `aria-live="polite"`。
- 判定：FIXED。

### [P3-9] 搜索框只有 placeholder — FIXED

- 位置：`dock/ui/components/base.mjs:152-155`
- 规格依据：检查清单 C
- 证据：搜索框 `aria-label="搜索设置项"`。
- 判定：FIXED。

### [P3-10] 上下文会话行不可键盘操作 — FIXED

- 位置：`dock/ui/pages/context.mjs:128`
- 规格依据：检查清单 F
- 证据：行 `tabindex="0"`、`role="button"`；聚焦第二行按 Enter 后 select 从 `s1` 变为 `s2`。
- 判定：FIXED。

### [P3-11] 760px 表格截断无 tooltip — FIXED

- 位置：关于/厂商页 `td`
- 规格依据：检查清单 B
- 证据：截断单元格 `title` 与可见文本一致（如「来自 ZCode（只读）」「已配置 sk-••••YtN」）。
- 判定：FIXED。

### [P3-12] 胶囊金额无千分位 — FIXED

- 位置：`dock/overlay/renderer.js:581-590`
- 规格依据：检查清单 G
- 证据：大额文本「今日 ¥12,345,678.90 · 上一轮 ¥1,234.50」。
- 判定：FIXED。

### [P3-13] 气泡左右边缘不翻转 — FIXED

- 位置：`dock/overlay/renderer.js:357-362`
- 规格依据：检查清单 H「按象限翻转」
- 环境：宠物层，960×680，DPR 1
- 证据：右侧长气泡现在 rect `[482,238,280,54]`，位于角色（left=770）左侧；`--arrow-left=266px`，箭头被钳在气泡右缘、指向角色左侧。截图 `round3\round3-bubble-right.png`。水平翻转已实现；箭头不再使用中心偏移。
- 判定：FIXED。

### [P3-14] 侧栏关于未贴底 / 窄侧栏状态 — PARTIAL

- 位置：`dock/ui/console.mjs:435-442`、`dock/ui/console.css:856`
- 规格依据：UI-SPEC §3「底部状态 + 关于」
- 环境：960×680 与 760×560，DPR 1
- 证据：关于入口已贴底（960 y=598，footer y=585；760 y=508，footer y=503）。但 760px 下 `.sidebar-status .status-text` 为 `display:none`，状态点 `.sidebar-status .dot` 的 rect 为 `[10,548,0,0]`、背景 `rgba(0,0,0,0)`，即状态点不可见；截图 `round3\round3-sidebar-760.png` 底部只剩关于图标，没有在线状态点。
- 剩余：关于位置已修复；窄侧栏的在线状态仍不可见（标题栏有「已连接」作为替代）。
- 判定：PARTIAL。

### [P3-15] 总览额度指标只显示「—」 — FIXED

- 位置：`dock/ui/pages/overview.mjs:161-162`
- 规格依据：检查清单 D
- 证据：显示「不可得」+「余额/套餐取决于当前 provider。」。
- 判定：FIXED。

### [P3-16] 宠物层重复展示今日金额 — FIXED

- 位置：`dock/overlay/renderer.js:1170-1174`
- 规格依据：检查清单 D
- 证据：hero「¥12.34 / 今日」；指标卡为「今日 tokens / 2.40M / 今日调用」，不再重复金额。
- 判定：FIXED。

## 规格空白（不作为缺陷）

- 宠物层「今日 tokens」指标卡第三行「今日调用」没有数值；UI-SPEC 未定义宠物层面板指标卡构成，详情区仍有「今日调用 38 次」。记录为规格空白。
- 宠物层面板不可聚焦（`focusable:false`）及托盘菜单键盘路径：UI-SPEC 未定义宠物层面板键盘操作，记录为规格空白。
- 气泡箭头在水平翻转后会被钳到气泡边缘，不能同时指向角色中心；检查清单只要求「按象限翻转」，未定义箭头精确落点。

## 已核对且未发现问题的项

- `npm run test:ui` 通过：8 页 × 2 主题 × 2 视口（布局 / 可访问名称 / axe）。
- axe（本轮 8 页 × 960/760，浅/深）：全部页面仅 `region` moderate（`.titlebar` 不在 landmark 内），critical/serious = 0；无 `button-name`、`label`、`empty-table-header`、`image-redundant-alt`。
- 横向滚动：全部 8 页 × 2 视口 × 2 主题的 document 与 `.content` 均无横向溢出；P2-2 的 960/760 条件已满足。
- P1/P2 探针：760 导航名称、宠物层厂商 72%/42%/18%/30%、Dialog Esc/焦点陷阱/焦点恢复、导出币种、多控件标签、隐藏金额/勿扰、气泡点击全部通过。
- 对比度：浅色/深色抽样仍 ≥4.5:1（浅色 text-3 5.28–5.87、徽标 5.64–8.72；深色 6.09–10.56）。
- 弹层：额度校正对话框 440×400，在 760×560 内完整可见；遮罩点击可关闭；Toast `role=status`，约 4.4s 自动消失。
- 宠物层：四象限吸附正确；气泡在右边缘翻到角色左侧；胶囊千分位正确；隐藏金额/勿扰生效。
- 960×680 总览首屏仍可见主数字/上下文/三格指标（三格 y=468–571，`.content` 底边 680）。

## 未验证 / 无法验证

- 真实 Electron 宠物层：透明窗、鼠标穿透、alpha 掩码、托盘菜单键盘路径仍只做浏览器渲染/代码审查；高 DPI 未测（参数 DPR 1）。
- 夹具成功路径：额度校正提交后数值变化、厂商密钥保存后的掩码、角色导入/删除/切换与宠物层同步、模板/队列保存读回、从旧挂件导入向导，因夹具无对应成功路由未验证。
- 设置持久化：夹具 `PUT /v1/settings` 返回原设置；已验证 hideMoney/dnd 显示效果与失败回滚，未验证真实磁盘持久化。
- 上下文内容随会话切换：夹具 context 路由忽略 session；select/行点击与请求参数已变化，但环/构成/趋势真实同步未验证。
- 视觉基线覆盖：`npm run visual` 仍只比对 32 张 `console-*`；`baseline/console/overlay-*.png` 未纳入该命令。about 页动态运行信息未遮罩，导致本轮 2/32 误报（见 P3-R1）。
