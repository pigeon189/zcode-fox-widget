# UI/UX 审查报告：宠物层复审（round 3） 2026-10-19

## 环境

- 审查对象：`feat/dock` 提交 `87bf829`（修复 round 2 的 P2-4 与 P2-R2-1）
- 视口：1280×720、960×680；DPR 1；浅色 / 深色
- 浏览器：本机 Edge `155.0.4283.62`（Playwright `channel: 'msedge'`，headless）
- 夹具：`test/fixtures/scenes/zcode-normal.json`，端口 39631；overlay URL `http://127.0.0.1:39631/overlay/index.html?port=39631&pid=999999&ct=0`
- 页面桩：`window.foxOverlay` = `setInteractive/getCursor/getBounds/getAlphaMask/hit/write`（+ `openConsole/hideOverlay/quitDock`）
- 实际运行：
  - `FOX_DOCK_PET_PORT=39631 npm run shots:pet -- --theme light,dark --viewport 1280x720,960x680` → 40 张通过（内置 pageerror / 视口越界 / 快览卡遮挡断言）
  - Playwright 复审探针：dsh 对比度、快览卡与 fox/chip 交集、气泡箭头回归
- 截图/证据：
  - 仓库内：`dock/test/visual/__shots__/pet-*-{light,dark}-{1280x720,960x680}.png`（40 张）
  - 仓库外：`C:\Users\paper\AppData\Local\Temp\ux-review-pet\r3\`（`r3-*.png`、探针输出）
- 工作树：干净，HEAD = `87bf829`。

## 结论

APPROVE

未解决：P1 = 0，P2 = 0，P3 = 0。

## 复核结果

### [P2-4] dsh 主按钮文字对比度 — FIXED

- 位置：`dock/overlay/pet.js:178-183`（`applyAccent` 统一设置 `--on-accent: #000000`）；`dock/overlay/pet.css:377-379`（`.btn.primary`）
- 环境：1280×720，浅/深，DPR 1
- 实际（吸附 dsh、打开快览卡后读取 `#quick-console` 计算样式）：
  - `background-color: rgb(77, 107, 254)`、`color: rgb(0, 0, 0)`、13px/600
  - 对比度 **4.85:1**（浅色与深色一致），`--on-accent = #000000`
  - 满足检查清单 B「正文 ≥4.5:1」
- 证据：`C:\Users\paper\AppData\Local\Temp\ux-review-pet\r3\r3-dsh-light-1280.png`、`r3-dsh-dark-1280.png`
- 频率：确定；无 pageerror。

### [P2-R2-1] 快览卡遮挡角色/胶囊 — FIXED

- 位置：`dock/overlay/pet.js:565-580`（`positionQuick()` 已删除误用的箭头位移；箭头对齐仅保留在 `positionSay()`/`positionBubble()`）
- 环境：1280×720 与 960×680，浅/深，DPR 1；右侧吸附（默认 right-bottom）
- 实际（`getBoundingClientRect` 求交集）：
  - 1280×720：`#quick` `[746, 494, 320×217.9]`（right 1066），`#fox` `[1078.4, 518.4, 201.6×201.6]` → 交集宽 **0**、面积 **0**、与角色间隙 **12.4px**；`#chip` `[1166, 676, 108.1×32]` → 交集 **0**、间隙 **100px**；快览卡完整在屏内（bottom 711.9）。
  - 960×680：`#quick` `[438, 454, 320×217.9]`（right 758），`#fox` `[769.6, 489.6, 190.4×190.4]` → 交集 **0**、间隙 **11.6px**；`#chip` `[846, 636, 108.1×32]` → 交集 **0**、间隙 **88px**；快览卡完整在屏内（bottom 671.9）。
  - 浅/深两套数值完全一致；无 pageerror。
- 证据：`dock/test/visual/__shots__/pet-quick-light-1280x720.png`、`pet-quick-light-960x680.png`（深色同名）；`C:\Users\paper\AppData\Local\Temp\ux-review-pet\r3\r3-quick-*.png`
- 左侧吸附对照：快览卡在角色右外侧，交集 0（间隙 12.4px），未受影响。

## 回归核对（本轮改动相关）

- **气泡/台词箭头**：右侧贴边气泡 `[524, 445, …]`，`--arrow-left` 计算后箭头中心 **638.0** vs 角色中心 **637.8**；气泡完整在屏内。箭头对齐逻辑未被本次删除波及。
- **内置门禁**：`shots:pet` 40 张全部通过，新增的“快览卡不得与 `#fox`/`#chip` 重叠”断言在 1280×720/960×680 × 浅/深下均未触发；pageerror 与视口越界断言同样通过。
- **P2-1/P2-2/P2-3 与 P3-1/P3-2/P3-3**：本轮代码未回退相关修复（`positionMenu`、`role=group`、32×32 点击区、字号 12/20/32、环 `brightness(0.72)` 仍在）；round 2 已逐项实测通过。

## 未验证 / 无法验证

- **Electron 真机**：未在真实 Electron 窗口中操作；托盘/键盘替代路径仅静态核对。
- **DPI 1.5 / 2**：按要求只测 DPR 1。
- **音效 / alpha 掩码**：headless 无音频；`getAlphaMask` 使用桩返回 `ok:false`，未验证真实掩码命中。
