# UI/UX 审查报告：宠物层（overlay 2.0） 2026-10-19

## 环境

- 审查对象：`feat/dock` 提交 `02b2481`（宠物层 2.0：`dock/overlay/pet.js`、`pet.css`、`index.html`）
- 视口：1280×720、960×680；DPR 1；浅色 / 深色两套
- 浏览器：本机 Edge `155.0.4283.62`（Playwright `channel: 'msedge'`，headless）
- 夹具：`test/fixtures/scenes/zcode-normal.json`，端口 39611；overlay 以 `?port=39611&pid=999999&ct=0` 打开
- 页面桩：`window.foxOverlay` = `setInteractive / getCursor / getBounds / getAlphaMask / hit / write`（+ `openConsole/hideOverlay/quitDock`），与 `tools/pet-shots.mjs:74-86` 一致
- 实际运行：
  - `node tools/fixture-daemon.mjs --scene test/fixtures/scenes/zcode-normal.json --port 39611`
  - `npm run shots:pet -- --theme light,dark --viewport 1280x720`（20 张）
  - Playwright 探针（仓库外）：四象限/快览/菜单/气泡/台词/队列/隐藏金额/极值/Kimi 双窗口/dsh 余额/axe/960×680
  - `node --test --test-concurrency=1 test/integration/overlay.itest.mjs`（辅助，见「未验证」）
- 截图目录（权威证据集，均按 HEAD 内容渲染）：
  - `C:\Users\paper\AppData\Local\Temp\ux-review-pet\head-shots\pet-*.png`（26 张：1280×720 浅/深 10 态 + 960×680 四象限/快览/菜单）
  - `C:\Users\paper\AppData\Local\Temp\ux-review-pet\head\head-*.png`（复测：quick/menu/bubble/dsh/menu-960）
  - `C:\Users\paper\AppData\Local\Temp\ux-review-pet\probe-*.png`（长台词/顶部翻转/极值/Kimi/dsh/hover/悬浮等）
- 环境说明：审查期间有**另一个会话在并发修改工作树**（`dock/overlay/pet.js`、`dock/daemon/src/v1.mjs`、`dock/package.json`、测试与截图脚本；pet.js mtime 20:52 仍在变化）。本报告只针对 HEAD `02b2481`：所有测量通过 Playwright 请求拦截，将 `/overlay/pet.js` 替换为 `git show 02b2481:dock/overlay/pet.js` 的内容后复测；`index.html` / `pet.css` / `roles.js` 工作树干净。仓库内 `dock/test/visual/__shots__/pet-*` 在 20:51 被并发进程部分覆写，不作为本报告证据；`npm run shots:pet` 首次运行（20:40–20:41，干净 HEAD）的其余截图仅用于初步目视，结论以上述 HEAD 复测截图与测量为准。

## 结论

REQUEST_CHANGES

未解决：P1 = 0，P2 = 4，P3 = 3。

## 问题

### [P2-1] 菜单打开期间每 500ms 抛 `ReferenceError: positionMenu is not defined`

- 位置：`dock/overlay/pet.js:318`（`placeAll()` 内 `if (menuOpen) positionMenu()`）；`positionMenu` 在全文件只有调用、没有定义
- 规格依据：REVIEW-PROMPT-UX §5 验收规则「无 JS 异常」；UI-SPEC §6「无 JS 异常」；设置应立即生效
- 环境：1280×720 与 960×680，浅/深，DPR 1
- 实际：打开菜单后 250ms 内出现 `ReferenceError`，2.5s 内累计 11 次。HEAD 复现栈：
  ```
  ReferenceError: positionMenu is not defined
      at placeAll (http://127.0.0.1:39611/overlay/pet.js:318:17)
      at applySettings (http://127.0.0.1:39611/overlay/pet.js:191:3)
      at refreshState (http://127.0.0.1:39611/overlay/pet.js:413:3)
  ```
  `placeAll()` 在抛错处中止，后续 `positionBubble() / positionSay()` 不再执行；`applySettings()` 在 `placeAll()` 后中止，`renderChip()/renderQuick()` 被跳过。菜单仍可点击使用，但菜单打开期间来自托盘/控制台的设置变更不会刷新到胶囊，气泡/台词也不再跟随重定位。
- 复现：
  1. 打开 `http://127.0.0.1:39611/overlay/index.html?port=39611&pid=999999&ct=0`；
  2. 点击角色右上角 `⋯` 或右键打开菜单；
  3. 监听 `pageerror`，等待 ≥500ms，可见持续抛错。
- 频率：确定（100%，浅/深、两个视口）
- 影响：运行时 JS 异常；菜单打开期间外部设置不同步、气泡定位失效；不导致崩溃。
- 建议（非强制）：补 `positionMenu()` 边界钳制实现，或在调用处加 `typeof positionMenu === 'function'` 守卫。

### [P2-2] 菜单 `role="menu"` 触发 axe critical（`aria-required-children`）

- 位置：`dock/overlay/index.html:57`（`<div id="menu" role="menu" …>`）；子项由 `pet.js:670-760` 动态生成，均为普通 `button` / `div`，没有 `role="menuitem"`
- 规格依据：REVIEW-PROMPT-UX 检查清单 F「@axe-core/playwright，critical/serious 必须为 0」；UI-SPEC §4
- 环境：1280×720，浅色（深色同）
- 实际：打开菜单后 `axe.run(document)` 输出：
  ```
  { id: 'aria-required-children', impact: 'critical', nodes: ['#menu'] }
  ```
  其余为 `region`（moderate）。快览卡状态只有 `region`（moderate），无 critical/serious。
- 复现：
  1. 打开 overlay，`window.__pet.openMenu(700,220)`；
  2. 注入 axe-core 并 `axe.run(document)`；
  3. 见 `#menu` 的 critical 违规。
- 频率：确定
- 影响：屏幕阅读器无法把菜单项识别为 menu item；违反 critical=0 验收规则。叠加层窗口本身 `focusable:false`，键盘主路径为托盘菜单（`main.cjs:203-232`），故有绕行方式。
- 建议（非强制）：去掉 `role="menu"` 改用普通容器，或给菜单项加 `role="menuitem"` 并补齐 roving tabindex。

### [P2-3] 两个交互元素点击区小于 32×32

- 位置：`dock/overlay/pet.css:81-82`（`#pet-menu` `width/height: 28px`）；`dock/overlay/pet.css:469-470`（`.menu-size` `min-width: 44px; height: 28px`，4 个 75%/100%/125%/150% 按钮）
- 规格依据：REVIEW-PROMPT-UX 检查清单 C「所有交互元素…≥32×32 点击区」
- 环境：1280×720 / 960×680，浅/深
- 实际（`getBoundingClientRect`）：`#pet-menu` = 28×28；`.menu-size` 四个均为 44×28。对照：`.menu-item` 214×36、`.menu-role` 40×40、快览卡按钮高度 32（`#quick-console` 156×32、`#quick-refresh` 32×32、`#quick-reset` 82×32、`#quick-more` 32×32）。
- 复现：打开菜单，量取上述元素 rect。
- 频率：确定
- 影响：菜单入口与字号档位按钮的命中面积偏小，未达到 32×32 硬性要求。
- 建议（非强制）：`#pet-menu` 提到 32×32；`.menu-size` 高度提到 32。

### [P2-4] DeepSeek Harness 主按钮文字对比度 4.36:1（< 4.5:1）

- 位置：`dock/overlay/pet.css:377-379`（`.btn.primary { background: var(--pet-accent); color: var(--on-accent) }`）；`dock/ui/tokens.css:23`（`--on-accent: #111111`）；`adapters/dsh/index.mjs:30`（accent `#4d6bfe`）；`pet.js:492` 把 `--pet-accent` 设为 agent 强调色
- 规格依据：REVIEW-PROMPT-UX 检查清单 B「正文 ≥4.5:1」；UI-SPEC §2
- 环境：1280×720，浅/深（按钮配色与主题无关），DPR 1
- 实际：吸附 dsh 打开快览卡，`#quick-console` 计算样式 `background-color: rgb(77, 107, 254)`、`color: rgb(17, 17, 17)`、13px/600 → 对比度 **4.36:1**。同法实测其他角色的主按钮：fox 8.84、gpt 5.91、xiaoke 6.05、gemini 5.30、workbuddy（生产 accent `#7db6ff`）9.00、kimi（生产 accent `#b07cff`）6.45；夹具把 kimi accent 写成 `#8b5cf6` 时为 4.46，属夹具与适配器色值不一致，生产不触发。
- 复现：
  1. `window.__pet.debugAttach('dsh','0x1',{x:520,y:180,w:960,h:620},{h:'right',v:'bottom'})`；
  2. 等 3.6s 让快照刷新后 `window.__pet.openQuick()`；
  3. 读取 `#quick-console` 的 `backgroundColor/color/fontSize/fontWeight` 计算对比度。
- 频率：确定（dsh）
- 影响：主操作文字处于临界不可读；违反 4.5:1 规则。轻/深主题相同。
- 建议（非强制）：按 accent 亮度选择深/浅 `--on-accent`，或为 dsh 使用更深的强调色。

### [P3-1] 三处字号不在允许档位内

- 位置：`dock/overlay/pet.css:161`（`#chip-adapter` 10px）、`:89`（`#pet-menu` 18px）、`:280`（`.quick-value` 28px）
- 规格依据：UI-SPEC §2「字号只允许 12/13/14/16/20/24/32/40」；检查清单 B「可见文本 ≥12px」
- 环境：1280×720，浅/深
- 实际（`getComputedStyle` 去重）：可见文本字号集合 = 10 / 12 / 13 / 14 / 16 / 18 / 28px；其中 10（宿主名）、18（菜单按钮字形）、28（快览主数字）越档，10px 低于 12px 下限。对比度本身达标（10px `--text-3` on `--surface` = 5.87）。
- 复现：打开快览卡/菜单，枚举可见文本元素的 `font-size`。
- 频率：确定
- 影响：字号体系与规格不一致；10px 宿主名偏小。
- 建议（非强制）：10→12、18→16/20、28→24/32。

### [P3-2] 右侧贴边时气泡箭头无法指向角色

- 位置：`dock/overlay/pet.js:654`（`--arrow-left` 夹到 `w-14`），`positionBubble()` 636-655
- 规格依据：检查清单 H「气泡：不出屏、按象限翻转」；无箭头指向规格 → 以可见性/可用性判定
- 环境：1280×720，浅/深；默认吸附角 right-bottom
- 实际：气泡 rect `x=842, w=228.4, right=1070.4`，`--arrow-left=214px`（被夹到 `w-14`），箭头中心 x=**1056**，角色中心 x=**1179.2**，偏差 **123px**；箭头落在角色左侧空处。贴左时箭头中心 842 vs 角色中心 841.8（正确）。顶部翻转正确（`below=true`，箭头 `border-bottom-width:6px`），但水平同样偏移。
- 复现：右侧贴边 → `showBubble('上下文已用 82%，建议压缩会话','ZCode',{ms:0})` → 量气泡 rect 与 `--arrow-left`。
- 频率：确定（右侧贴边 + 气泡宽到被夹）
- 影响：气泡尾指向空白，视觉关联变弱；不影响阅读/操作。
- 建议（非强制）：允许箭头更靠近气泡右缘，或让气泡与角色 x 范围重叠至少 14px。

### [P3-3] 胶囊上下文环在浅色桌面上对比度 2.14:1

- 位置：`dock/overlay/pet.css:172-175`（`#chip-ring { color: var(--pet-accent) }`）；默认 fox accent `#f0a04b`
- 规格依据：WCAG 1.4.11 非文本对比度 3:1（可访问性规则）；该环为补充指示
- 环境：浅色，1280×720 / 960×680
- 实际：`#f0a04b` vs `#ffffff` = **2.14:1**（vs 深色 surface `#171d2b` = 7.89:1）。上下文百分比同时以文字出现在快览卡中，环不是唯一通道。
- 复现：浅色下读取 `#chip-ring` 的 color 与 `--surface` 计算对比度。
- 频率：确定（浅色 + fox 默认角色）
- 影响：浅色桌面上环的轮廓偏淡；信息有文字冗余，不阻断。
- 建议（非强制）：浅色主题下环改用 `--accent-strong` 或加深描边。

## 规格空白（不作为缺陷）

- **胶囊与角色的相对位置**：规格未定义胶囊应压住角色哪个部位。实测胶囊完整落在角色包围盒内（重叠面积 3458px²），下角压住身体、上角压住头顶发饰，面部始终可见；判为规格空白，非缺陷。
- **叠加层键盘可达性**：`overlay/main.cjs:310` 设置 `focusable:false`，页面上的 `Esc` 关闭（`pet.js:994-1001`）在生产窗口收不到按键；REVIEW-PROMPT-UX §5H 允许「可用键盘替代路径（托盘菜单）」。托盘菜单（`main.cjs:203-232`）覆盖打开控制台/隐藏角色/桌宠模式/隐藏金额/开机自启/退出；换角色、大小、勿扰在控制台页面。判为规格空白，非缺陷。
- **气泡队列点击不关闭**：队列非空时点击始终循环下一条（`pet.js:657-666`），与旧 `renderer.js` 行为一致；规格只要求「点击关闭/推进队列」，未定义队列末尾必须关闭，且 6s 自动关闭存在。判为规格空白。

## 已核对且未发现问题的项

- **四象限与镜像**：1280×720 下 fox 201.6×201.6，right x=1078.4 / left x=537，top y=197 / bottom y=518.4；960×680 下 fox 190.4×190.4，right x=769.6 / left x=537，top y=197 / bottom y=489.6。全部在屏内；左侧 `transform: matrix(-1,0,0,1,0,0)`，右侧 `none`；`body[data-corner-h]` 正确；无横向滚动。
- **快览卡在屏内/无溢出**：1280×720 rect `746,499,320×213.1`（bottom 712）；960×680 rect `438,459,320×213.1`（bottom 672）；960 + Kimi 双窗口 rect `438,407,320×265.1`（bottom 672）；`scrollWidth=clientWidth`，无滚动。
- **菜单在屏内/无裁切**：1280×720 rect `700,123,224×589`（bottom 712）；960×680 rect `620,83,224×589`（bottom 672）；`overflow-y:auto`；角色 6 个、大小 4 档、分隔线均可见。
- **气泡/台词**：气泡与台词均不出屏；顶部贴边正确翻到角色下方（`below=true`，箭头朝上）；`role="status" aria-live="polite"`；队列点击依次显示 3 条（队列第一条→第二条→第三条）；台词长文本 300×142，文字底 495 < 背景底 508，无裁切。
- **隐藏金额**：浅/深两套均只遮蔽金额——胶囊/快览主值 `•••`、副行 `上一轮 •••`，上下文 `47.5%`、`475.3K / 1.00M` 保持不变；积分/百分比不受影响。
- **数字/单位/上下文环**：`¥12.34`、`52.5%`、`193.5 积分`（与 `ui/lib/format.mjs` 同格式）、`475.3K / 1.00M`；环 `stroke-dashoffset` 与 pct 一致（47.5% → 23.09/43.98，99.9% → 0.044），不可得时环隐藏。
- **极值**：`¥12,345,678.90` 在胶囊（scrollW=clientW=100）与快览卡（286）内均未溢出/截断；`¥` 前缀与数字紧贴。
- **悬浮态**：`debugFloat` 后胶囊仍在屏内，显示 `↺` 悬浮标记，沿用 zcode 数据；宽 125.1、高 32。
- **hover**：鼠标进入角色后 `#pet-menu` opacity 0→1；默认 `menuButton:"hover"` 行为符合设置。
- **可访问名称**：快览卡 `role=dialog aria-label=快览`；`#quick-more`（更多）、`#quick-refresh`（刷新）、6 个角色按钮（aria-label=角色名）、菜单按钮（打开菜单）均有名称；装饰图标 `aria-hidden`。
- **深色主题**：几何与浅色一致；`--text-3 #9aa6c0` on `#171d2b` = 6.89:1，正文对比度达标。
- **axe（快览卡）**：仅 `region`（moderate），无 critical/serious。

## 未验证 / 无法验证

- **Electron 真机托盘/键盘路径**：仅静态阅读 `main.cjs:203-232`，未在真机 Electron 中操作托盘菜单。
- **overlay 集成测试**：本环境两次运行均 8/9，但失败项不同（第一次「单击打开快览」超时，第二次「拖到 agent 吸附」超时），呈环境相关抖动；未作为本报告证据。
- **DPI 1.5 / 2**：本次按要求只测 DPR 1；高 DPI 偏移未复测。
- **音效与 alpha 掩码穿透**：headless 无音频；`getAlphaMask` 使用桩返回 `ok:false`，未验证真实 nativeImage 掩码命中。
- **工作树改动**：`dock/overlay/pet.js` 的未提交改动不属 02b2481；本报告结论只针对 HEAD 内容（已用请求拦截复核）。
