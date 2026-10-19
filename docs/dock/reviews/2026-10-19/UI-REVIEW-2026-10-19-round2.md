# UI/UX 审查报告（第二轮）：控制台（8 页）+ 宠物层 2026-10-19

## 环境

- 分支/工作树：`feat/dock`；实测 `git rev-parse HEAD` 为 `0ab989c`（修复提交 `9d4fb92` 之后仅 `0ab989c ci(dock): 运行 engines parity`，`dock/ui` 无额外提交）。派发信息中的 HEAD `9d4fb92` 对应本轮修复内容。
- 工作树状态：无已跟踪文件修改；未跟踪文件为两份既有审查报告（`CODE-REVIEW-2026-10-19.md`、`UI-REVIEW-2026-10-19.md`）。本轮只新增本报告与 gitignored 截图。
- 规格：当前 `docs/dock/UI-SPEC.md`（已把用量页改为「范围/指标两个筛选 + 按 Agent 排名」，上下文页移除范围分段；本轮按当前规格判定）。
- 页面：overview、context、usage、quota、vendors、roles、settings、about
- 主题：浅色、深色
- 视口：960×680、760×560
- DPR：1
- 浏览器：Microsoft Edge 155.0.0.0（Playwright `channel:'msedge'`，headless）
- 夹具：`test/fixtures/scenes/zcode-normal.json`，夹具 daemon 端口 39561
- 实际运行命令与结果：
  - `cd /d "E:\WorkSpace\fox-dock\dock" && npm run test:ui` → 通过：`8 页 × 2 主题 × 2 视口（布局 / 可访问名称 / axe）`
  - `cd /d "E:\WorkSpace\fox-dock\dock" && npm run visual` → 通过：`32 张（阈值 0.1%）`
  - `node tools/shots.mjs --page console --console-pages overview,context,usage,quota,vendors,roles,settings,about --theme light,dark --viewport 960x680,760x560 --base http://127.0.0.1:39561 --out test/visual/__shots__/round2`
- 截图目录：`E:\WorkSpace\fox-dock\dock\test\visual\__shots__\round2`（32 张矩阵 + 本轮专项截图）
- 测量脚本（仓库外）：`C:\Users\paper\AppData\Local\Temp\fox-ux-review-2026-10-19-round2\`（`measure.mjs`、`verify2.mjs`、`verify3.mjs`、`overflow.mjs`、`hits.mjs`、`tokens.mjs`）
- 宠物层说明：仍以浏览器渲染 `overlay/index.html` 审查；夹具缺少 `/bindings`、`/billing`、`/diag.json`，绑定/账单端点用 Playwright 路由合成（快照数据仍来自夹具）。真实 Electron 透明窗、鼠标穿透、高 DPI 未验证。

## 结论

REQUEST_CHANGES

未解决：P1 = 0，P2 = 1，P3 = 4。

说明：P1 两项均已修复；上一轮 10 项 P2 中 9 项 FIXED，P2-2 为 PARTIAL（折行已修，但 960px 下出现文本溢出与内容区横向滚动）。P3 中 12 项 FIXED，P3-1、P3-2、P3-13、P3-14 为 PARTIAL。因仍有 1 项未解决 P2，按派发规则给 REQUEST_CHANGES。

## 问题（逐条复审）

### [P1-1] 760px 下 8 个导航按钮失去可访问名称 — FIXED

- 位置：`.sidebar button.nav-item` / `dock/ui/console.mjs:429-431`
- 规格依据：UI-SPEC §3、§6；检查清单 A/F
- 环境：760×560，浅色/深色，DPR 1
- 证据：8 个 `.nav-item` 均有 `aria-label` 与 `title`（总览/上下文/用量/额度与余额/厂商与密钥/角色与气泡/设置/关于与诊断）；760px 下 axe 只剩 `region`（moderate，1 node），无 `button-name`；`getComputedStyle(span).display` 仍为 `none`，但可访问名称已由 aria-label 提供。截图：`E:\WorkSpace\fox-dock\dock\test\visual\__shots__\round2\round2-overview-760-nav.png`、`console-overview-light-760x560-dpr1.png`。
- 判定：FIXED。

### [P1-2] 宠物层厂商页百分比错误 — FIXED

- 位置：宠物层面板 → 厂商 / `dock/overlay/renderer.js:1323-1329`
- 规格依据：UI-SPEC §5；检查清单 D/H
- 环境：宠物层，浅色，960×680，DPR 1
- 证据：面板文本现为 GLM Plan「72%剩余 / 已用 28% · 余 72% / 720 / 1000 tokens」；CommandCode「本月 已用 42% · 余 58%」「5 小时 已用 18% · 余 82%」「本周 已用 30% · 余 70%」；与控制台额度页「72% 剩余」一致。截图：`round2\round2-overlay-vendors.png`、`round2\console-quota-light-960x680-dpr1.png`。
- 判定：FIXED。

### [P2-1] 对话框 Esc / 焦点陷阱 / 焦点恢复 — FIXED

- 位置：`dock/ui/components/base.mjs:90-132`（`Dialog`）
- 规格依据：UI-SPEC §6；检查清单 C
- 环境：浅色，760×560，DPR 1
- 证据：打开额度校正对话框后初始焦点为 `SELECT`「校正类型」，位于 dialog 内；按 Esc 后 `dialogCount=0`，焦点回到「校正」按钮；连续 Tab 8 次始终在 dialog 内并在「记录→校正类型」处回环；点击「取消」后焦点回到「校正」。对话框 rect 440×410，在 760×560 内完整可见。
- 判定：FIXED。

### [P2-2] 总览上下文数字折行 — PARTIAL

- 位置：总览 → 上下文 / `[data-testid="overview.context"] .mono.nowrap` / `dock/ui/pages/overview.mjs:137`
- 规格依据：检查清单 B「数字不换行」及「所有页面无横向滚动、无元素溢出」
- 环境：浅色/深色，960×680 与 760×560，DPR 1
- 证据：`white-space` 已为 `nowrap`，不再折成两行；但 960×680 下该元素 `getBoundingClientRect()` 为 `82×18`，`scrollWidth=134`、`clientWidth=82`，没有 `title`；文本「475,318 / 1,000,000」溢出卡片右边缘（卡片右边界 936，文本约到 972），`.content` 的 `scrollWidth=763` > `clientWidth=752`，内容区出现横向滚动。760px 下 `scrollWidth=134` > `clientWidth=107`，但内容区 `704=704` 无横向滚动。截图：`round2\overview-960-overflow.png`、`round2\console-overview-light-960x680-dpr1.png`。
- 剩余问题：折行已消除，但 960px 下数字被截断/溢出且无 tooltip，并引入内容区横向滚动。这是未解决的 P2。
- 判定：PARTIAL。

### [P2-3] 用量 CSV/JSON 导出忽略币种筛选 — FIXED

- 位置：`dock/ui/pages/usage.mjs:137-138`
- 规格依据：检查清单 E；UI-SPEC §5
- 环境：浅色，960×680，DPR 1
- 证据：默认 CNY 选中时表格 8 行；下载 CSV 共 9 行（表头 + 8 条），全部为 CNY，未再包含 WorkBuddy 的 `credit/CREDIT` 行；JSON 使用 `rows: rowsCur`。
- 判定：FIXED。

### [P2-4] 设置页多控件同名标签 — FIXED

- 位置：`dock/ui/pages/settings.mjs:145-147, 163-165, 205-207`
- 规格依据：检查清单 C
- 环境：浅色，960×680，DPR 1
- 证据：`aria-label` 现分别为「每轮消耗气泡」/「气泡停留秒数」、「周预算」/「月预算」、「显示或隐藏角色热键」/「打开控制台热键」/「隐藏金额热键」；「按压音效」与「音效音量」也可区分。
- 判定：FIXED。

### [P2-5] 隐藏金额与勿扰不生效 — FIXED

- 位置：`dock/ui/lib/format.mjs:4-27`、`dock/ui/console.mjs:262-265`、`dock/overlay/renderer.js:455-462, 581-590, 249-252, 364-367`
- 规格依据：检查清单 E/H
- 环境：控制台与宠物层，960×680，DPR 1
- 证据：`hideMoney=true` 时控制台 hero 为 `•••`、全部 Agent 表金额为 `•••`，`hasBullets=true`；宠物层胶囊为「今日 ••• · 上一轮 •••」。`dnd=true` 时 `showBubble` 后 `#bubble.hidden=true`，`sayRandom()` 后 `#say.hidden=true`。数据未改动。
- 判定：FIXED。

### [P2-6] 气泡点击关闭/队列推进不可用 — FIXED

- 位置：`dock/overlay/styles.css:1224`、`dock/overlay/renderer.js:2538-2542`
- 规格依据：检查清单 H
- 环境：宠物层，浅色，960×680，DPR 1
- 证据：`#bubble.open` 的 `pointer-events` 现为 `auto`；在气泡中心 `mouse.click` 后 300ms，`#bubble.hidden=true`。
- 判定：FIXED。

### [P2-7] 交互控件点击区小于 32×32 — FIXED

- 位置：`.segmented button`、`.toggle`、`.role-del` / `dock/ui/console.css:446-482, 865-877`
- 规格依据：检查清单 C
- 环境：浅色，960×680，DPR 1
- 证据：`.segmented button` 82×32；`.toggle` 36×32（track 36×20，但 label 点击区 36×32）；导入角色后的 `.role-del` 32×32。`smallTargets` 列表为空。
- 判定：FIXED。

### [P2-8] 可见文本字号低于 12px 或超出允许档位 — FIXED

- 位置：`dock/ui/charts/svg.mjs:26, 93-104, 122-130`、`dock/ui/console.css` 窄屏 H1
- 规格依据：UI-SPEC §2；检查清单 B
- 环境：浅色/深色，960×680 与 760×560，DPR 1
- 证据：图表 SVG 文本全部为 `12px`；上下文 Gauge 中心为 `32px`，总览 Gauge 为 `24px`；760px 下 H1 仍为 `20px`；`npm run test:ui`（已包含 SVG 文本）通过。角色页导入按钮的 `+` 仍为 `28px`，归入 P3-2 的剩余令牌偏差。
- 判定：FIXED（上轮列出的图表/Gauge/H1 均已修复）。

### [P2-9] 设置分组链接改写 hash 导致刷新回总览 — FIXED

- 位置：`dock/ui/pages/settings.mjs:85-92`
- 规格依据：检查清单 A
- 环境：浅色，960×680，DPR 1
- 证据：点击「气泡与提醒」后 `location.hash` 仍为 `#settings`，`.content.scrollTop=734`，H1 仍为「设置」；刷新后 hash 仍为 `#settings`，H1「设置」，`[data-testid="page.settings"]` 存在。
- 判定：FIXED。

### [P2-10] 角色 JSON 对话框 textarea 无可访问名称 — FIXED

- 位置：`dock/ui/pages/roles.mjs:239`
- 规格依据：检查清单 C/F；UI-SPEC §6
- 环境：浅色，760×560，DPR 1
- 证据：textarea `aria-label="气泡模板 JSON"`，打开对话框时获得焦点；对 `.overlay` 运行 axe，violations 为空（无 `label` critical）。
- 判定：FIXED。

### [P3-1] 同一行卡片高度不一致 — PARTIAL

- 位置：总览/上下文/用量/角色/关于的 `.grid` 行
- 规格依据：检查清单 B
- 环境：浅色，960×680，DPR 1
- 证据：总览 hero/上下文均为 190；上下文两卡均为 324；用量排名/缓存命中率均为 234（FIXED 部分）。角色页 960px 下角色库 731 vs 档案设置 380；关于页 960px 下版本 150 vs 运行信息 298（未修复）。截图：`round2\console-roles-light-960x680-dpr1.png`、`round2\console-about-light-960x680-dpr1.png`。
- 剩余问题：含多张卡片的列（角色 col-5、关于 col-5）仍无法与同行单卡等高；`flex:1` 只是把列高分摊给列内多张卡。
- 判定：PARTIAL。

### [P3-2] 设计令牌偏离 — PARTIAL

- 位置：`dock/ui/console.css:148, 362, 436, 452, 464, 684, 708`；`dock/ui/console.mjs:373`；`dock/ui/pages/roles.mjs:195`
- 规格依据：UI-SPEC §2（间距 4/8/12/16/24/32；圆角 6/8/12/16/999；动画 120–200ms；字号 8 档）
- 环境：浅色，960×680，DPR 1
- 证据：上轮指出的 10px/4px 圆角、10px gap、厂商硬编码色已修复；但仍有 `.segmented gap:2px`、`.segmented button/.btn gap:6px`、导航选中指示条 `border-radius:2px`、图例色块 `border-radius:3px`；skeleton `animation: shimmer 1.2s`；角色导入 `+` 为 `28px`；`console.mjs:373` 与 `roles.mjs:195` 仍有 `#f0a04b` 回退值。重复的 `.nowrap/.sr-only/.grid > div` 块与 `tokens.css:70` 重复 `--on-vendor` 为代码卫生问题，未单独计为 UI 缺陷。
- 判定：PARTIAL。

### [P3-3] 用户界面开发者/里程碑文本 — FIXED

- 位置：用量缓存空态、设置语言提示、宠物层大小提示
- 规格依据：检查清单 G
- 环境：960×680；宠物层 960×680；DPR 1
- 证据：旧文本「M8 接入」「英文在 P3 提供」「128px 容器…587」已移除；现为「暂不支持逐请求缓存明细，后续版本提供」「界面目前提供简体中文」「标准档约 250px（小屏自动回落到 122px）」。
- 判定：FIXED。

### [P3-4] 关于页版本号折行 — FIXED

- 位置：`dock/ui/pages/about.mjs:47`
- 规格依据：检查清单 B
- 环境：960×680 与 760×560，DPR 1
- 证据：`span.num` 的 rect 高度为 36px，`line-height` 36px，文本「fox-dock 2.0.0」单行；截图 `round2\console-about-light-960x680-dpr1.png`。
- 判定：FIXED。

### [P3-5] 厂商表空表头 — FIXED

- 位置：`dock/ui/pages/vendors.mjs:161`
- 规格依据：检查清单 F
- 环境：960×680 与 760×560，DPR 1
- 证据：第 5 个表头现含 `<span class="sr-only">操作</span>`；axe 不再报 `empty-table-header`，仅剩 `region` moderate。
- 判定：FIXED。

### [P3-6] 角色图片 alt 与相邻名称重复 — FIXED

- 位置：`dock/ui/pages/roles.mjs:173`
- 规格依据：检查清单 F
- 环境：960×680，DPR 1
- 证据：角色卡图片改为 `alt=""`；axe 不再报 `image-redundant-alt`。
- 判定：FIXED。

### [P3-7] StackedBar 缺少图表语义；AreaChart 无悬停提示 — FIXED

- 位置：`dock/ui/charts/svg.mjs:50-67, 69-106`
- 规格依据：UI-SPEC §4；检查清单 D
- 环境：960×680，DPR 1
- 证据：构成条根节点 `role="img"`、`aria-label="请求构成：缓存命中 292,100，未缓存输入 147,000，…"`；AreaChart 的每个采样点有 `<circle><title>`，例如「12:26 · 120,000 / 1,000,000」。
- 判定：FIXED。

### [P3-8] Toast 缺 role=status；宠物层气泡无 aria-live — FIXED

- 位置：`dock/ui/components/base.mjs:135-137`、`dock/overlay/index.html:10-17`
- 规格依据：检查清单 C/F
- 环境：960×680；宠物层 960×680；DPR 1
- 证据：`.toast-wrap` 现为 `role="status"` + `aria-live="polite"`；`#say` 与 `#bubble` 均为 `role="status"` + `aria-live="polite"`。
- 判定：FIXED。

### [P3-9] 搜索框只有 placeholder — FIXED

- 位置：`dock/ui/components/base.mjs:152-155`
- 规格依据：检查清单 C
- 环境：960×680，DPR 1
- 证据：设置搜索框 `aria-label="搜索设置项"`（用量/厂商同样使用 placeholder 作为 aria-label），`labels=0` 但已有固定可访问名称。
- 判定：FIXED。

### [P3-10] 上下文会话行可点击但不可键盘操作 — FIXED

- 位置：`dock/ui/pages/context.mjs:128`
- 规格依据：检查清单 F
- 环境：960×680，DPR 1
- 证据：行有 `tabindex="0"`、`role="button"` 与 `onKeyDown`（Enter/Space）；聚焦第二行按 Enter 后选择会话从 `s1` 变为 `s2`。
- 判定：FIXED。

### [P3-11] 760px 下表格长文本截断无可用 tooltip — FIXED

- 位置：关于页适配器表 `td`；厂商页密钥状态 `td.mono`
- 规格依据：检查清单 B
- 环境：760×560，DPR 1
- 证据：关于页「DeepSeek Harness」「计费 · 上下文 · 跟随」均有与可见文本一致的 `title`；厂商页截断单元格 `title` 现为完整「来自 ZCode（只读）」「已配置 sk-••••YtN」。截图：`round2\console-about-light-760x560-dpr1.png`、`round2\console-vendors-light-760x560-dpr1.png`。
- 判定：FIXED。

### [P3-12] 宠物层胶囊金额无千分位 — FIXED

- 位置：`dock/overlay/renderer.js:581-590`
- 规格依据：检查清单 G
- 环境：宠物层，浅色，960×680，DPR 1
- 证据：大额快照下胶囊文本为「今日 ¥12,345,678.90 · 上一轮 ¥1,234.50」，千分位与控制台一致。
- 判定：FIXED。

### [P3-13] 气泡左右边缘不按象限翻转，箭头偏离角色中心 — PARTIAL

- 位置：`dock/overlay/renderer.js:348-364`、`dock/overlay/styles.css:1237`
- 规格依据：检查清单 H「按象限翻转」
- 环境：宠物层，浅色，960×680，DPR 1
- 证据：右侧长气泡仍被钳到 `x=672`（rect 672,238,280,54），但 `--arrow-left=193px`，箭头 x=865，与角色中心 865 对齐（delta=0）；`::after left` 改用变量后不再偏 59px。气泡仍位于角色上方，没有水平翻到角色左侧。
- 剩余问题：箭头对齐已修复；左右边缘的水平象限翻转仍未实现。
- 判定：PARTIAL。

### [P3-14] 侧栏「关于与诊断」未在底部；窄窗口隐藏底部状态 — PARTIAL

- 位置：`dock/ui/console.mjs:435-442`、`dock/ui/console.css:919-924`
- 规格依据：UI-SPEC §3「底部状态 + 关于」
- 环境：960×680 与 760×560，DPR 1
- 证据：960px 下 `nav.about` y=598，`.sidebar-footer` y=585（已贴底）；760px 下 `nav.about` y=508，footer y=503（已贴底）。但 760px 下 `.sidebar-status` 的 `display` 仍为 `none`，底部状态仍被隐藏（标题栏仍有「已连接」）。
- 剩余问题：关于入口已贴底；窄窗口状态文字仍缺失。
- 判定：PARTIAL。

### [P3-15] 总览额度指标只显示「—」 — FIXED

- 位置：`dock/ui/pages/overview.mjs:161-162`
- 规格依据：检查清单 D
- 环境：960×680 与 760×560，DPR 1
- 证据：ZCode 无额度时该卡显示「不可得」，副标题为「余额/套餐取决于当前 provider。」；截图 `round2\console-overview-light-960x680-dpr1.png`。
- 判定：FIXED。

### [P3-16] 宠物层总览重复展示今日金额 — FIXED

- 位置：`dock/overlay/renderer.js:1170-1174`
- 规格依据：检查清单 D
- 环境：宠物层，浅色，960×680，DPR 1
- 证据：hero 仍为「¥12.34 / 今日」；指标网格第一格改为「今日 tokens / 2.40M / 今日调用」，不再重复「今日 ¥12.34」。截图 `round2\round2-overlay-detail.png`。
- 判定：FIXED（指标卡第三行「今日调用」无数值的文案观察见「规格空白」）。

## 规格空白（不作为缺陷）

- 宠物层「今日 tokens」指标卡的第三行显示「今日调用」但没有数值；UI-SPEC 未定义宠物层面板的指标卡构成，且详情区仍有「今日调用 38 次」。记录为规格空白，不判缺陷。
- 用量页/上下文页在本轮规格更新后移除了「按厂商/按模型」分组与上下文时间范围分段；这是规格同步调整，不判缺陷。
- 宠物层左右边缘气泡是否必须水平翻转，只在检查清单 H 出现，UI-SPEC 未给出具体几何定义；本轮按「箭头指向角色」判为部分修复。
- 宠物层面板不可聚焦（`focusable:false`）与托盘菜单键盘路径：UI-SPEC 未定义宠物层面板键盘操作，记录为规格空白。

## 已核对且未发现问题的项

- `npm run test:ui` 通过：8 页 × 2 主题 × 2 视口（布局 / 可访问名称 / axe）；`npm run visual` 通过：32 张，阈值 0.1%。
- axe（本轮 8 页 × 960/760）：全部页面仅 `region` moderate（`.titlebar` 不在 landmark 内），critical/serious = 0；无 `button-name`、`label`、`empty-table-header`、`image-redundant-alt`。
- 横向滚动：除 overview 在 960px（浅/深）出现 `.content` `763>752` 外，其余页面/视口/主题组合的 document 与 `.content` 均无横向溢出（760：760/704，960：960/752）。
- 对比度：浅色/深色抽样仍全部 ≥4.5:1（如浅色 `--text-3` 5.28–5.87、徽标 5.64–8.72；深色 6.09–10.56）。
- 键盘：导航、Segmented、刷新按钮、`.content` 均有 `2px solid rgb(37,99,235)` 焦点环；对话框焦点陷阱/Esc/焦点恢复见 P2-1；上下文行 Enter 可选会话见 P3-10。
- 离线：杀掉夹具后标题栏显示「连接中断，重试中…」，圆点变红。
- 弹层尺寸：额度校正对话框 440×410，在 760×560 内完整显示；面板在四个角落位置均未出屏。
- 宠物层：四象限吸附仍正确；气泡自动关闭正常；胶囊大额千分位正常；隐藏金额/勿扰已生效。

## 未验证 / 无法验证

- 真实 Electron 宠物层：透明窗、鼠标穿透、alpha 掩码命中、托盘菜单键盘路径仍只做代码/浏览器渲染审查；高 DPI 未测（参数 DPR 1）。
- 夹具成功路径：额度校正提交后数值变化、厂商密钥保存后的掩码、角色导入/删除/切换与宠物层同步、模板/队列保存读回、从旧挂件导入向导，均因夹具无对应成功路由而未验证。
- 设置持久化：夹具 `PUT /v1/settings` 返回原设置；本轮验证了 hideMoney/dnd 的渲染效果与 500 失败回滚，未验证真实磁盘持久化。
- 控制台会话内容随会话切换：夹具 context 路由忽略 session 参数；select/行点击与请求参数已变化，但环/构成/趋势是否真实同步未验证。
- 视觉基线覆盖：`npm run visual` 只比对 32 张 `console-*`；`baseline/console/overlay-*.png` 虽已入库，但 `visual-test.mjs` 的命名循环只构造 `console-*`，宠物层截图未纳入该命令的逐像素比对。
- 宠物层「今日调用」副标题观察：见规格空白，不阻塞。

## 其他观察（不计 UI 缺陷）

- `dock/ui/console.css` 中 `.nowrap`、`.sr-only`、`.grid > div`、`.grid > div > .card` 各重复了三份；`dock/ui/tokens.css:70` 的 `--on-vendor` 重复一行。三者不影响渲染，属于代码卫生问题，未计入 P1/P2/P3。
- 本轮修复把 960px 下多卡列的高度用 `flex:1` 分摊，角色/关于页仍不满足同行卡片等高（P3-1），且宠物层指标卡的「今日调用」文案缺少数值（规格空白）。
