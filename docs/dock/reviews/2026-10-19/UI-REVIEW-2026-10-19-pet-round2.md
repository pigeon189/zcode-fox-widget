# UI/UX 审查报告：宠物层复审（round 2） 2026-10-19

## 环境

- 审查对象：`feat/dock` 提交 `28fcf0a`（修复 `02b2481` 的宠物层 UI 问题）
- 视口：1280×720、960×680；DPR 1；浅色 / 深色
- 浏览器：本机 Edge `155.0.4283.62`（Playwright `channel: 'msedge'`，headless）
- 夹具：`test/fixtures/scenes/zcode-normal.json`，端口 39621；overlay URL `http://127.0.0.1:39621/overlay/index.html?port=39621&pid=999999&ct=0`
- 页面桩：`window.foxOverlay` = `setInteractive/getCursor/getBounds/getAlphaMask/hit/write`（+ `openConsole/hideOverlay/quitDock`）
- 实际运行：
  - `FOX_DOCK_PET_PORT=39621 npm run shots:pet -- --theme light,dark --viewport 1280x720,960x680`（40 张，通过内置 pageerror/越界断言）
  - `npm run test:ui` → `UI 自检通过：8 页 × 2 主题 × 2 视口`
  - `npm run visual` → `✅ 视觉回归通过：32 张（阈值 0.1%）`
  - Playwright 复审探针：pageerror 监听 2.2s、axe、几何/重叠、对比度、字号、像素采样
- 截图/证据：
  - 仓库内：`dock/test/visual/__shots__/pet-*-{light,dark}-{1280x720,960x680}.png`（40 张）
  - 仓库外：[`C:\Users\paper\AppData\Local\Temp\ux-review-pet\r2\`](file:///C:/Users/paper/AppData/Local/Temp/ux-review-pet/r2)（`r2-*.png`、`r2.json`、环像素采样）
- 工作树：审查时干净，HEAD = `28fcf0a`。

## 结论

REQUEST_CHANGES

未解决：P1 = 0，P2 = 2，P3 = 0。

逐条复审结果：P2-1 FIXED、P2-2 FIXED、P2-3 FIXED、**P2-4 未通过（4.33:1）**；P3-1/P3-2/P3-3 均 FIXED。另发现本轮修复引入 1 项新的 P2 回归（快览卡遮挡角色/胶囊）。

## 问题

### [P2-4（复审未通过）] DeepSeek Harness 主按钮文字对比度仍为 4.33:1（< 4.5:1）

- 位置：`dock/overlay/pet.js:179-184`（`WHITE_TEXT_ACCENTS = new Set(['#4d6bfe'])` → `--on-accent: #ffffff`）；`dock/overlay/pet.css:377-379`（`.btn.primary` 背景 `--pet-accent`、文字 `--on-accent`）
- 规格依据：REVIEW-PROMPT-UX 检查清单 B「正文 ≥4.5:1」；UI-SPEC §2
- 环境：1280×720，浅/深，DPR 1
- 实际：吸附 dsh 打开快览卡后实测计算样式 `background-color: rgb(77, 107, 254)`、`color: rgb(255, 255, 255)`、13px/600 → **4.33:1**，仍低于 4.5。上一版的 `#111111` 文字为 4.36:1；改成白字后反而略降。两种文字色都无法在 `#4d6bfe` 上达到 4.5（纯黑 `#000000` 才能到 4.85:1）。其他角色实测：fox 8.84、workbuddy（夹具 `#22b8a0`）7.58、kimi（夹具 `#8b5cf6`）4.46；生产 kimi 适配器色 `#b07cff` 为 6.45，不触发。
- 复现：
  1. `window.__pet.debugAttach('dsh','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'})`；
  2. 等 3.6s 让快照刷新，`window.__pet.openQuick()`；
  3. 读取 `#quick-console` 的 `backgroundColor/color/fontSize/fontWeight` 计算对比度。
- 频率：确定（dsh）
- 影响：主操作文字仍不满足 4.5:1；违反检查清单 B。
- 建议（非强制）：dsh 强调色本身过亮，改用纯黑文字（4.85）或把强调色调深（如 `#3b55d9`，白字约 6.0），不要继续用白字 `#4d6bfe`。

### [P2-R2-1（本轮修复引入）] 快览卡被“气泡箭头”位移逻辑误用于无箭头的卡片，遮挡角色与胶囊

- 位置：`dock/overlay/pet.js:574-576`（`positionQuick()` 中新增的“气泡被钳到角色左侧时……”位移），同段逻辑只应属于 `positionSay()`/`positionBubble()`（`pet.js:682-684`）
- 规格依据：REVIEW-PROMPT-UX 检查清单 H「快览卡/菜单：是否完整在屏内」与 B「溢出/遮挡」；快览卡没有箭头，不需要为箭头对齐而位移
- 环境：1280×720、960×680，浅/深；右侧吸附（默认 right-bottom）
- 实际（`getBoundingClientRect`）：
  - 1280×720：快览卡 `[879, 494, 320×217.9]`（right 1199），fox `[1078.4, 518.4, 201.6×201.6]`（right 1280）→ 重叠 `120.6×193.5 = 23,336px²`；胶囊 `[1166, 676, 108.1×32]` → 重叠 `33×32 = 1,056px²`。上一版快览卡为 `[746, 499, 320×213.1]`（right 1066），与角色有 12.4px 间隙，无重叠。
  - 960×680：快览卡 `[565, 454, 320×217.9]`（right 885），fox `[769.6, 489.6, 190.4×190.4]`（right 960）→ 重叠 `115.4×182.3 = 21,037px²`；胶囊 `[846, 636, 108.1×32]` → 重叠 `39×32 = 1,248px²`。
  - 截图可见：`dock/test/visual/__shots__/pet-quick-light-1280x720.png`、`pet-quick-light-960x680.png`（深色同）——卡片盖住角色左侧脸/发与胶囊左半，胶囊只能看到右半（“Code / 12.34”）。
- 复现：
  1. 右侧吸附后点击角色打开快览卡（或 `window.__pet.openQuick()`）；
  2. 读取 `#quick` 与 `#fox`/`#chip` 的 rect 求交集；
  3. 1280 与 960 均复现。
- 频率：确定（右侧吸附；左侧吸附不触发）
- 影响：快览卡遮挡宠物本体与状态胶囊，视觉上像是卡片“压”在角色身上；卡片本身仍可读、可操作，但违反“卡片/胶囊不遮挡角色”的预期。`shots:pet` 新增的几何断言只检查视口边界，不检查重叠，因此 40 张门禁未拦住。
- 建议（非强制）：从 `positionQuick()` 删除这段箭头对齐位移（保留在 `positionSay()`/`positionBubble()`）；或给快览卡也留出与角色的 12px 间隙。

## 已核对且通过的原问题

### [P2-1] 菜单 `positionMenu` ReferenceError — FIXED

- 位置：`dock/overlay/pet.js:796-804` 新增 `positionMenu()`；`placeAll()` 的调用保留。
- 证据：打开菜单后监听 `pageerror` 2.2s，`count = 0`；同时 `shots:pet` 40 张（含 menu 状态）内置 pageerror 断言通过。菜单保持可操作，`placeAll()` 不再中止（快览/气泡/台词定位正常）。
- 频率：连续验证 1 次 2.2s + 40 张矩阵，未见异常。

### [P2-2] `#menu` 的 axe critical — FIXED

- 位置：`dock/overlay/index.html:57` 改为 `role="group"`；实测 `menuRole = "group"`。
- 证据：`axe.run(document)`（菜单打开）输出仅 3 条 moderate：`landmark-one-main`、`page-has-heading-one`、`region`；**无 critical/serious**。原 `aria-required-children`（critical）消失。

### [P2-3] 点击区 — FIXED

- 位置：`dock/overlay/pet.css:81-82`（`#pet-menu` 32×32）、`:476-478`（`.menu-size` 44×32）。
- 证据：实测 `#pet-menu` = **32×32**；四个 `.menu-size` = **44×32**；`.menu-item` 214×36、`.menu-role` 40×40 不变，均 ≥32×32。

### [P3-1] 字号档位 — FIXED

- 位置：`pet.css:161`（`#chip-adapter` 12px）、`:89`（`#pet-menu` 20px）、`:288`（`.quick-value` 32px）。
- 证据：浅/深两套可见文本字号集合均为 **12 / 13 / 14 / 16 / 20 / 32px**，全部落在 UI-SPEC §2 允许档位内；无 10px/18px/28px。

### [P3-2] 右侧气泡箭头 — FIXED

- 位置：`pet.js:682-684`（钳制后保持箭头落在角色中心附近）。
- 证据：1280×720 右侧吸附，气泡 `[971, 445, 228.4×63]`、`--arrow-left=208px` → **箭头中心 1179.0**，角色中心 **1179.2**（偏差 0.2px）；气泡完整在屏内。顶部贴边翻转：`below=true`，箭头中心 1179.0 vs 1179.2，箭头朝上（`border-bottom-width: 6px`），气泡仍在屏内。

### [P3-3] 浅色胶囊上下文环对比度 — FIXED

- 位置：`pet.css:172-183`（浅色 `filter: brightness(0.72)`）。
- 证据：浅色采样环最暗像素 `rgb(173,115,54)`，对白底 **3.98:1**（≥3:1 非文本要求）；深色 `filter: none`，`#f0a04b` 对 `#171d2b` = **7.89:1**。环与百分比文字双通道仍在。

## 已核对且未发现问题的项

- **菜单在屏内**：1280×720 `[700,119,224×593]`（bottom 712）；960×680 `[700,79,224×593]`（bottom 672）；`scrollHeight = clientHeight`，无裁剪。
- **快览卡在屏内（但存在上述遮挡）**：1280 `[879,494,320×217.9]`（bottom 711.9）；960 `[565,454,320×217.9]`（bottom 671.9）；Kimi 双窗口 960 `[332,402,320×269.9]`（bottom 671.9），两行窗口无溢出。
- **四象限/镜像**：1280 与 960 下四个角位角色与胶囊均在屏内；右侧 `mirror=false`，左侧 `mirror=true`；坐标与上一轮一致。
- **隐藏金额**：浅/深两套胶囊与快览卡金额均为 `•••`，副行 `上一轮 •••`，上下文 `47.5%` 与 `475.3K / 1.00M` 不变。
- **队列点击**：3 次点击依次显示「队列第一条/第二条/第三条」。
- **辅助门禁**：`test:ui`（8 页×2 主题×2 视口）通过；`visual` 32 张 0.1% 通过；`shots:pet` 40 张含 pageerror/视口越界断言通过。

## 未验证 / 无法验证

- **Electron 真机**：未在真实 Electron 窗口中操作；托盘/键盘替代路径仅静态核对。
- **DPI 1.5 / 2**：按要求只测 DPR 1。
- **音效 / alpha 掩码**：headless 无音频；`getAlphaMask` 使用桩返回 `ok:false`，未验证真实掩码命中。
- **夹具与生产强调色差异**：夹具 kimi accent 为 `#8b5cf6`（4.46:1），生产适配器为 `#b07cff`（6.45:1）；本报告将 kimi 视为夹具色值差异，不计入未解决 P2，但 dsh 在生产与夹具均为 `#4d6bfe`，4.33:1 的失败成立。
