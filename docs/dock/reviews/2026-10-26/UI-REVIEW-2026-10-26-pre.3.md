# UI/UX 审查报告：fox-dock 2.0 pre.3（2026-10-26）

## 环境与取证

- 审查对象：`dock-pre`，基线 `211c27e` + 审查时工作树；未切分支、未提交、未修改被审代码。
- 环境：Windows / Node.js `22.22.2` / npm `12.0.2` / Edge `156.0.4314.42`。
- 页面：控制台 9 页，light + dark；`1280×800`、`960×680`、`760×560`；DPR 1 全量，DPR 1.25 / 1.5 抽查。另覆盖宠物层权限、快览、菜单、拖拽取消、显示原点与失焦兜底。
- 独立渲染矩阵：69 个“页面 × 主题 × 视口/DPR”组合；axe `critical/serious = 0`，`pageerror = 0`，document 横向溢出与纵向滚动均为 0。
- 夹具：`zcode-normal`、`sessions-live` 及 E2E 自带合成场景；另以 Playwright 路由和 `window.__pet` 注入合成响应、窗口矩形、权限、额度与事件。未使用真实账号、密钥或用户数据。
- 临时证据目录：`E:/WorkSpace/fox-dock-review-ux-20261026/`（仓库外）。主要证据：`matrix-results.json`、`console-state-results.json`、`console-interaction-results.json`、`context-switch-results.json`、`pet-results.json`、`live-reduce-results.json`、`misc-results.json`、`final-probes-results.json` 及原尺寸 PNG。

| 命令 | 退出码 | 原始结果摘要 |
|---|---:|---|
| `npm run test:ui` | 0 | `UI 自检通过：9 页 × 2 主题 × 3 视口（布局 / 可访问名称 / axe）` |
| `npm run test:e2e:pages` | 0 | 33/33 通过；含会话状态、宠物权限、快览晚到内容 |
| `npm run test:electron:console` | 0 | 真窗口页面加载、无 JS 异常、关键文本与截图通过 |
| `npm run test:pet` | 0 | 生成并校验 80 张宠物层状态截图 |
| `npm run visual` | 1 | 仅 `ENV-MISMATCH`：基线 Edge `155.0.4283.62`，当前 `156.0.4314.42`；未执行基线比较，未更新基线 |
| `npm run lint` | 0 | 465 个文件；危险 DOM、toolbar、Electron 安全配置与凭据扫描通过 |
| `npm run check:sync` | 0 | pricing / CommandCode / relays 三份副本均与源头逐字节一致 |
| D056 定向单测（3 文件） | 0 | 37/37 通过，0 skipped；另有下述未覆盖事件探针 |

`visual` 原文：`ENV-MISMATCH：基线环境 {"platform":"win32","arch":"x64","edge":"155.0.4283.62","dpr":1,...}；当前 {"platform":"win32","arch":"x64","edge":"156.0.4314.42","dpr":1,...}`。

## 结论

REQUEST_CHANGES

共确认 **3 个 P1、25 个 P2、3 个 P3**。既有自动化大部分通过，但补充渲染与交互探针发现其未覆盖的状态、失败时序和键盘边界。视觉基线未完成比较是环境限制，不计为产品缺陷。

## 状态矩阵

| 场景 | 会话列表 | 计数 | 胶囊 | 快览卡 | 结论 | 证据 |
|---|---|---|---|---|---|---|
| `doneAt` 在 5 分钟内 | 已完成 | done=1 | 已完成 | 已完成 | 通过；总览另有 P1-1 | `live-reduce-results.json#doneWindow`；E2E 7；`pet-results.json#quickLate` |
| `doneAt` 恰好到 5 分钟 | 回落空闲 | done=0 / idle=1 | 未单测边界 | 未单测边界 | 派生与列表通过 | `live-reduce-results.json#doneWindow`；E2E 8 |
| 机器 `working`，服务端 `displayStatus=idle` | 空闲 | idle=1 | 未单测 | 未单测 | **总览失败：仍显示工作中** | `console-state-results.json#overview_idle`；E2E 7 |
| 机器 `working`，服务端 `displayStatus=done` | 已完成 | done=1 | 未单测 | 未单测 | **总览失败：仍显示工作中** | `console-state-results.json#overview_done` |
| `turnActive` 覆盖工具结束至首字空窗 | 工作中 | working | 未单测 | 未单测 | 已有边界通过 | D056 单测 23–28；`live-reduce-results.json#workflow` |
| `workflowBusy=true` | 工作中 | working | 未单测 | 未单测 | 服务端派生通过 | D056 单测 29–37 |
| 新 `turn_start` | 工作中，旧 doneAt 清零 | working | 未单测 | 未单测 | 通过 | `live-reduce-results.json#newTurnReset` |
| 第 14 分钟 `permission_resolved` 后继续回合 | 第 16 分钟误回空闲 | idle | 未单测 | 未单测 | **失败：事件未续命（P1-3）** | `live-reduce-results.json#permissionResolvedExpiry` |
| 唯一会话 `waiting_input` | 等待输入 | waiting_input=1 | **等待确认** | 未单测 | 胶囊文案失败（P2-1） | `pet-results.json#waitingInput` |
| CommandCode：3 窗口 + 3 桶 + 3 会话，内容晚到 1.8 秒，DPR 1.25 | 工作/完成/空闲 | 同源 | 不打开快览时显示 | 三个状态正确；无滚动条 | 通过 | `pet-results.json#quickLate`：`clientH=scrollH=423`、`clientW=scrollW=318` |
| 高风险权限卡 | 不提供允许 | 不进入会话计数 | 高风险徽标；无“允许一次”；焦点不在允许 | 同权限卡 | 通过 | `pet-results.json#permissionHigh`；E2E 1–2 |

## 问题

### [P1-1] 总览“当前会话”绕过 `displayStatus`，陈旧 working 覆盖空闲/已完成
- 位置：总览 / `overview.current-session`；`dock/ui/pages/overview.mjs:312-316,349-353`。
- 规格依据：D056；`UI-SPEC.md` §5「会话」及审查清单 D——总览也必须读服务端展示状态。
- 环境：浅色，1280×800，DPR 1，合成 `/v1/sessions` 响应。
- 实际：`status=working, displayStatus=idle` 与 `status=working, displayStatus=done` 两种响应下，卡片徽标都为“工作中”；服务端计数分别只有 idle=1 或 done=1。证据：`console-state-results.json#overview_idle/overview_done`，截图 `overview-stale-idle.png`、`overview-stale-done.png`。
- 复现：
  1. 让 `/v1/sessions` 返回上述任一合成会话，不返回其它活跃会话。
  2. 打开 `#overview`，读取“当前会话”徽标并与服务端 `displayStatus` 对比。
- 频率：确定。
- 影响：用户会把已空闲或已完成任务误判为仍在运行，属于 D056 明确要避免的状态误导。
- 建议（非强制）：选择当前会话及徽标时统一使用 `displayStatus || status`，不要再用原始 working 选择活跃会话。

### [P1-2] 上下文读取失败可显示上一会话数据；初次失败则永久 Skeleton
- 位置：会话详情 / 上下文；`dock/ui/pages/context.mjs:39-55,67-70`。
- 规格依据：`UI-SPEC.md` §5「会话」及审查清单 C/D/G——错误要有反馈，数据归属必须正确，加载失败不能伪装成永久加载。
- 环境：浅色，1280×800，DPR 1；A 返回成功，B 返回合成 500。
- 实际：从 `#sessions?select=zcode%3AA&tab=context` 切到 B 后，仍显示 A 的 `model-A`、`400 / 1,000`、40% 和 A 趋势，错误提示为 0；通过普通行点击切到读取失败的 B 时，800ms 后仍为 Skeleton、无错误卡。证据：`context-switch-results.json`、`console-state-results.json#contextStale`，截图 `sessions-context-hash-stale.png`。
- 复现：
  1. 在 A 的上下文标签确认 `model-A` 已显示。
  2. 保持 `tab=context`，通过 hash/前进后退切换到 B，并让 B 请求失败。
  3. 对比当前详情会话与上下文模型；再通过普通行点击切到读取失败的 B，观察加载态。
- 频率：确定。
- 影响：用户会把 A 的上下文占用当成 B 的，属于关键数据错归属；失败也没有下一步操作提示。
- 建议（非强制）：切换 id/sessionId 时清空或 keyed 隔离旧数据，保留明确 loading/error 状态，失败时显示重试而非旧数据或永久 Skeleton。

### [P1-3] `permission_resolved` 不刷新回合活跃时钟，进行中的回合提前显示空闲
- 位置：`dock/shared/live-reduce.mjs:76-79,195-203,320-345`。
- 规格依据：D056——“回合内任意事件续命”，整段静默超过 15 分钟才放开 `turnActive`。
- 环境：Node.js 纯合成事件；`turn_start@0`、`permission_request@1min`、`permission_resolved@14min`。
- 实际：resolved 后 `turnActiveSince` 仍是 1 分钟而非 14 分钟；在 16 分钟 + 1 秒执行 `expire` 后，`turnActive=false,status=idle,displayStatusOf=idle`。若按规格续命，应仍工作至约 29 分钟静默上限。证据：`live-reduce-results.json#permissionResolvedExpiry`。
- 复现：
  1. 依次归约上述三个事件。
  2. 检查 resolved 前后的 `turnActiveSince`，再在 16 分钟 + 1 秒调用 `expire` 与 `displayStatusOf`。
- 频率：确定。
- 影响：长回合在权限处理完成后仍继续运行时，会被误判为空闲；既有 37 个定向单测未覆盖此事件序列。
- 建议（非强制）：明确哪些回合内事件应调用 `touchTurn`，至少覆盖 resolution/error 等仍在回合内的事件，并补 14/15/29 分钟边界测试。

### [P2-1] 宠物胶囊把 `waiting_input` 显示为“等待确认”
- 位置：`dock/overlay/pet.js:1084-1091,1155-1160`。
- 规格依据：D056 状态文案；`session-model.mjs` / `format.mjs` 中 `waiting_input=等待输入`、`waiting_permission=等待确认`。
- 环境：WorkBuddy，960×680，DPR 1；唯一会话 `waiting_input=1, waiting_permission=0`。
- 实际：胶囊文本为 `WorkBuddy · 等待确认`，尽管响应同时明确给出 `waiting_input:1`。证据：`pet-results.json#waitingInput`、`pet-waiting-input.png`。
- 复现：注入上述 `state.live.byAgent.workbuddy`，绑定 WorkBuddy 并显示胶囊。
- 频率：确定。
- 影响：提示用户去确认权限，而实际应继续输入，操作指引错误；`waiting` 合并计数也会盖过 error 优先级。
- 建议（非强制）：优先消费拆分后的 `waiting_permission/waiting_input`，只有旧服务端缺少拆分时才使用兼容回退。

### [P2-2] 显示工作区原点变化后仍使用首次缓存 origin，吸附与命中坐标偏移
- 位置：`dock/overlay/pet.js:640-660,778-782,2491-2492`；主进程重设窗口在 `dock/overlay/main.cjs:555-577`。
- 规格依据：D043/D044 与审查清单 H/J——工作区/DPI 变化后浮层与宿主矩形偏差不得超过 2px。
- 环境：960×680，DPR 1；模拟工作区从 `(0,0)` 变为 `(40,20)`，宿主物理矩形不变。
- 实际：调用 `__pet.refit()` 和 resize 后，角色仍为 `left=790.163,top=510.163`，origin 仍为 `(0,0)`；正确的新本地坐标应为 `(750.163,490.163)`，横/纵偏差分别 40/20px。证据：`pet-results.json#originRefit`。
- 复现：先吸附并记录位置，再改变 `getBounds` 返回的工作区原点，保持 `/rect` 不变，触发 refit/resize。
- 频率：确定。
- 影响：任务栏位置变化、跨屏或工作区变化后角色偏离宿主；同一旧 origin 也用于拖拽 `/hit` 与指针本地坐标。
- 建议（非强制）：display refit 时失效并重新读取 origin，再重算宿主矩形和指针坐标。

### [P2-3] 开启滚动条避让后，失焦右下兜底被额外内移 17px
- 位置：`dock/overlay/pet.js:662-673,698-703,727-732`。
- 规格依据：D044 修订——失焦兜底直接贴住工作区角落；右侧避让不应使兜底角色悬空。
- 环境：960×680，`scrollGapOn=true,scrollGap=17,fallbackCorner=br`。
- 实际：宿主丢失后角色 `left=773`，右下贴角应约为 `790.172`；实测横向偏差 17px，纵向贴底正确。证据：`pet-results.json#fallbackGap`、`pet-fallback-gap.png`。
- 复现：开启上述设置并吸附，再调用与宿主丢失相同的 `debugHostLost` 路径。
- 频率：确定。
- 影响：违反已定案的贴角行为；attached→floating 状态切换时可能出现二次跳动。
- 建议（非强制）：瞬时 fallback 摆位绕过滚动条 clamp，仅对正常桌面悬浮位置应用右侧缝。

### [P2-4] `pointercancel` 后角色保持压扁和拖拽视觉态
- 位置：`dock/overlay/pet.js:2219-2227,2269-2319`。
- 规格依据：审查清单 C/H/I——组件状态与按压时序应一致，取消不能留下拖拽状态。
- 环境：960×680，合成 pointerdown → pointermove → pointercancel。
- 实际：内部 `dragging=false`，但 `fox.className='dragging'`、`transform='scaleY(0.88) scaleX(1.05)'`、`drag-hint.hidden=false`；未走 `pressUp/releaseAfterPress`，也未清 `currentTarget/armed/hint`。证据：`pet-results.json#pointerCancel`、`pet-pointer-cancel.png`。
- 复现：按下角色并拖过 5px 阈值，再派发 `pointercancel`，检查 DOM 与样式。
- 频率：确定。
- 影响：系统取消触摸/指针后角色视觉状态残留，后续移动可继续沿用异常按压路径。
- 建议（非强制）：取消路径复用统一的 press/drag 清理逻辑，但不执行吸附或落点提交。

### [P2-5] 宠物渲染进程直接使用 EventSource，绕过“全部 daemon 交互走 IPC”的约束
- 位置：`dock/overlay/pet.js:2413-2439`。
- 规格依据：审查清单 K 与架构边界——宠物层 daemon 交互一律经 preload IPC；文档与实现冲突时需修实现或修订规格。
- 环境：纯浏览器宠物层，preload mock 已提供 `read/write`。
- 实际：渲染进程直接发起 `resourceType=eventsource` 的 `http://127.0.0.1:39490/v1/stream`；preload `read` 路径只有 settings/roles/state/bubbles 等，没有 stream。证据：`misc-results.json#petStreamChannel`。
- 复现：打开 `overlay/index.html?port=39490`，监听 renderer request 与 `foxOverlay.read` 调用。
- 频率：确定。
- 影响：SSE 不享受主进程持令牌及拖拽期间网络挂起的规避设计，且与声明的 IPC 边界不一致。
- 建议（非强制）：由主进程代理流事件，或在架构规格中明确 SSE 例外及其拖拽/令牌约束。

### [P2-6] 积分日图读取 `amount` 而非 `credits`，非零积分被画成空图
- 位置：`dock/ui/pages/usage.mjs:235-243,326-329,350-353`。
- 规格依据：`UI-SPEC.md` §5「用量」——金额/Token/积分按各自单位展示，不得把有数据画成零。
- 环境：合成 `unit=credit`，总积分 120，byDay 仅 `credits=50/70`、`amount=null`。
- 实际：首磁贴和排名均为 `120 积分`，每日图非透明柱形数量为 0，Y 轴仅 `1 积分/0`。证据：`console-state-results.json#creditChart`、`usage-credit-chart.png`。
- 复现：打开用量页并注入上述响应，比较磁贴、排名和柱图。
- 频率：确定。
- 影响：图表与总计相互矛盾，积分用户无法从日图判断用量。
- 建议（非强制）：当前周期和上一周期都按 unit 选择 `credits` 或 `amount`，并补仅有 credits 的 byDay 渲染断言。

### [P2-7] 不可得的额度/上下文百分比被显示成真实 0%
- 位置：`dock/ui/lib/format.mjs:42-45`；`dock/ui/pages/quota.mjs:329-337`；`dock/ui/pages/overview.mjs:358-361,410-416`；`components/base.mjs:547-550`。
- 规格依据：`AGENTS.md` 数字真相约束、D046、`UI-SPEC.md` §5/6——缺失是 `null + unavailable`，不得编 0；上下文不可用时显示 EmptyState。
- 环境：`remainingPct=null,usedPct=null`，上下文 `supported=false`。
- 实际：额度页显示 `0% 剩余 · 5 小时`，总览额度为 `0%` 且 progressbar `aria-valuenow=0`；当前会话上下文显示“—”但进度同样为 0，EmptyState 数量为 0。证据：`console-state-results.json#nullQuota`、`quota-null-percent.png`、`overview-null-context-quota.png`。
- 复现：注入上述空值快照，分别打开额度页与总览。
- 频率：确定。
- 影响：把“没有数据”误读为额度耗尽或上下文占用 0%，破坏数字可信度。
- 建议（非强制）：格式化与 ProgressBar 调用前保留 null，不渲染 0 值条；按原因显示“暂无/不可得”。

### [P2-8] 上下文全零且没有上限时，面积图生成 NaN 坐标
- 位置：`dock/ui/charts/svg.mjs:95-112`；调用方 `dock/ui/pages/context.mjs:113-115`。
- 规格依据：审查清单 C/F——图表边界状态和可读性；不能因合法零数据破坏图形。
- 环境：两个采样点均 `used=0`，`limit=null`。
- 实际：`maxY=0`，两个 path 分别为 `M48.0 NaN ...` 与 `M48.0 NaN ...`，图中只有坐标文字。证据：`console-state-results.json#areaZero`、`context-area-zero.png`。
- 复现：在会话上下文标签注入上述两个零采样点并检查 path `d`。
- 频率：确定。
- 影响：合法的零占用/零基线场景无法绘图，并产生无效 SVG。
- 建议（非强制）：为 maxY 设置合理最小值，或对全零数据绘制明确零线/空态。

### [P2-9] 用量首次加载被误报为确定空态，且可提前导出空文件
- 位置：`dock/ui/pages/usage.mjs:179-213,398-410,434-438`。
- 规格依据：审查清单 C/E/G——loading、EmptyState、错误反馈和导出应区分“尚未返回”与“确实无数据”。
- 环境：将 `/v1/usage/breakdown` 延迟 1 秒返回。
- 实际：延迟期间已显示“还没有用量记录”，Skeleton 为 0，CSV/JSON 均可点击；此时导出的 JSON 为 `rows:[],total:null,provenance:null`。证据：`console-state-results.json#usageLoading`、`usage-loading-empty.json`。
- 复现：延迟 breakdown 响应，在响应前观察图表卡并点击 JSON。
- 频率：确定。
- 影响：慢请求被当成无用量，用户还可能保存并传播错误的空导出。
- 建议（非强制）：增加首次 loading，未返回前禁用导出；错误与真正空态分开处理。

### [P2-10] 统计 quality chips 数字没有规格要求的 SourceTag
- 位置：`dock/ui/pages/stats.mjs:393-405`。
- 规格依据：`UI-SPEC.md` §5「统计」——5 个磁贴与 quality chips 都带 SourceTag；金额/Token/百分比必须有 provenance。
- 环境：浅色，统计页合成统计响应。
- 实际：quality chips 为 8 个，`.stats-quality .source-tag` 为 0；主磁贴 SourceTag 为 5。仅末尾有 `zcode:db.sqlite` 文本，不能提供每项的四类标签与来源详情。证据：`console-state-results.json#qualityProvenance`、`stats-quality-provenance.png`。
- 复现：打开统计页，对比主磁贴和会话/回合/Cache/错误率等 chips。
- 频率：确定。
- 影响：这些数字无法逐项识别官方/本地/估算/不可得来源，违背真相层展示契约。
- 建议（非强制）：为 chips 接入对应 provenance 或明确合并来源的 SourceTag。

### [P2-11] 总览“待处理”只统计最近 30 个会话，可漏报全局待办
- 位置：`dock/ui/pages/overview.mjs:209-216,317,368-381`。
- 规格依据：`UI-SPEC.md` §5「总览」——首屏待处理数；审查清单 D 要求计数口径一致。
- 环境：`rootTotal=35,waiting_permission=2`，前 30 条中没有 pending（模拟待办落在第 31 条以后）。
- 实际：卡片显示“待处理 0 / 没有待处理事项”，而同一响应计数为 2。证据：`console-state-results.json#pendingCount`、`overview-pending-count.png`。
- 复现：让 `/v1/sessions?limit=30` 返回上述计数和空 pending 列表，打开总览。
- 频率：确定。
- 影响：超过 30 个会话时，用户可能完全看不到仍需处理的权限事项。
- 建议（非强制）：使用服务端全局待办计数/ActionBroker，不从分页内容推导总数。

### [P2-12] 金额预算逐键 Number 化并受控回写，`1.25` 实际保存成 `251`
- 位置：`dock/ui/pages/settings.mjs:205-227`；保存路径 `dock/ui/console.mjs:496-507`。
- 规格依据：`UI-SPEC.md` §5「设置」——改动立即生效并持久化；输入应保留用户正在编辑的合法中间态。
- 环境：设置页“今日预算”，逐键输入，不粘贴。
- 实际：按键序列值为 `1 → 1 → 21 → 251`，最终输入框和服务端 `budgetMoney` 都是 `251`；PUT 序列为 `0,1,1,21,251`。证据：`console-interaction-results.json#budgetDecimal`、`settings-budget-decimal.png`。
- 复现：清空金额输入，依次按 `1 . 2 5`，每步读取 input 和 PUT body。
- 频率：确定。
- 影响：预算数值被静默放大且立即落盘，可能使预算预警完全失效；粘贴完整值虽可绕行，但正常逐键输入不可用。
- 建议（非强制）：编辑期间保留字符串， blur/Enter 或合法完整值时再数值化并保存，避免受控回写改变光标与小数点。

### [P2-13] 并发设置保存中，较早请求失败会把较新成功状态整份回滚
- 位置：`dock/ui/console.mjs:496-507`。
- 规格依据：`UI-SPEC.md` §5「设置」——失败回滚不能覆盖其它已成功改动。
- 环境：第一次 `hideMoney=true` 延迟 400ms 并失败，20ms 后 `dnd=true` 延迟 50ms 并成功。
- 实际：最终服务端为 `hideMoney=false,dnd=true`，界面两项却都为 false；只有第一次失败 Toast。两次 PUT 时间相差约 21ms。证据：`console-interaction-results.json#settingsConcurrentFailure`（含 `actualServer`）。
- 复现：按上述顺序快速点击两个开关，使后一次先成功、前一次最后失败。
- 频率：确定。
- 影响：用户看到失败提示后，另一项本已成功的设置也被悄悄撤销，刷新前界面与服务端不一致。
- 建议（非强制）：保存串行化或使用请求序号，并按字段回滚，而不是用旧整份 settings 覆盖。

### [P2-14] DatePicker 方向键移动后，活动日期没有可见焦点
- 位置：`dock/ui/components/base.mjs:372-374,487-529`；`dock/ui/console.css:530-543,603-634`。
- 规格依据：`UI-SPEC.md` §4/6 与审查清单 C/F——键盘可选日期，焦点必须可见。
- 环境：760×560，键盘打开开始日期并按 ArrowRight。
- 实际：`aria-activedescendant` 从 10-20 移到 10-21，但真实焦点仍在 `.dp-pop`；活动日 class 仅 `dp-day`，背景透明、outline none、box-shadow none，用户看不出 Enter 将选哪天。证据：`console-interaction-results.json#datePickerKeyboard`、`usage-datepicker-keyboard.png`。
- 复现：只用键盘打开日期弹层，按方向键并观察活动日样式。
- 频率：确定。
- 影响：屏幕阅读器有活动项信息，视觉键盘用户却无法判断当前选择。
- 建议（非强制）：给 active descendant 对应的日期设置与焦点环等价的可见 active 样式。

### [P2-15] Dialog 内的 Select 按 Esc 会同时关闭整个 Dialog
- 位置：`dock/ui/components/base.mjs:145-150,668-712`。
- 规格依据：审查清单 C——弹层/Dialog 的 Esc 行为应一致，嵌套弹层不能只关闭最外层。
- 环境：760×560，额度余额校正 Dialog。
- 实际：打开“校正类型”下拉后按 Esc，`.select-pop=0` 且 `.dialog=0`，焦点回到“校正”按钮，未保存内容所在 Dialog 一并消失。证据：`console-interaction-results.json#dialogNestedEscape` 及前后截图。
- 复现：打开任一余额校正，展开类型下拉，按一次 Esc。
- 频率：确定。
- 影响：用户只想收起下拉却丢失整个表单上下文。
- 建议（非强制）：内层 Select 处理 Esc 时停止事件传播，外层 Dialog 仅在没有内层弹层时关闭。

### [P2-16] 长 Select 越出视口、键盘活动项不可见，选中后焦点丢到 body
- 位置：`dock/ui/components/base.mjs:123-132,157-173,200-235`；`console.css:444-474`。
- 规格依据：`UI-SPEC.md` §4/6 与审查清单 C/E/F——弹层不得裁切，键盘操作和焦点保持必须可用。
- 环境：760×560，12 个合成音效选项。
- 实际：弹层 `top=276,bottom=576`，超出 560 视口 16px；方向键到最后一项时该项位于 `611–641`，完全不可见且 `scrollTop=0`；Enter 后焦点为 BODY，未回到触发器。证据：`console-interaction-results.json#selectLongAndFocus`、`roles-select-long-keyboard.png`。
- 复现：把音效触发器置于约 y=240，打开下拉，按 11 次 ArrowDown，再按 Enter。
- 频率：确定。
- 影响：长列表选项不可见、键盘选择缺乏可见反馈，后续 Tab 流程失去位置。
- 建议（非强制）：对弹层 top/bottom 做最终 clamp，活动项 scrollIntoView，并在 choose/Tab 后合理恢复焦点。

### [P2-17] 会话 Enter 打开详情后把键盘焦点行重置到第一行
- 位置：`dock/ui/pages/sessions.mjs:358-362,396-414`。
- 规格依据：`UI-SPEC.md` §5「会话」——↑↓/Enter/Home/End 连续键盘导航。
- 环境：会话列表，焦点先向下移动两行。
- 实际：第三行 `workbuddy:wb_live1` 按 Enter，再按 ArrowDown，焦点落到第二行 `zcode:ses_live2`，而不是第四行；原因是 `select()` 调用 `setFocusIndex(0)`。证据：`console-interaction-results.json#sessionKeyboardAndSearch`。
- 复现：聚焦列表，ArrowDown 两次，Enter，再 ArrowDown，比较 focused row。
- 频率：确定。
- 影响：键盘连续浏览会话时每次打开详情都跳回顶部附近。
- 建议（非强制）：Enter 保持当前 focusIndex，仅鼠标另选行时同步对应索引。

### [P2-18] 会话搜索没有写入 hash，刷新后筛选丢失
- 位置：`dock/ui/pages/sessions.mjs:143,178-198,349-356`。
- 规格依据：审查清单 E——搜索/筛选/排序/分页在刷新与 SSE 后保持。
- 环境：会话页搜索 `billing`。
- 实际：刷新前 input=`billing`、hash=`#sessions?tab=overview`；刷新后 input 为空，hash 只有 tab/select，没有 q。证据：`console-interaction-results.json#sessionKeyboardAndSearch`。
- 复现：输入搜索词，等待 220ms 防抖，记录 hash 并刷新。
- 频率：确定。
- 影响：刷新或分享链接无法恢复同一筛选视图，也与代码已支持的 q 初始化不对称。
- 建议（非强制）：将 debouncedQ/q 纳入 hash 回写及依赖，并保留其它筛选状态。

### [P2-19] 总览预警条和用量会话行只能鼠标激活
- 位置：`dock/ui/pages/overview.mjs:331`；`dock/ui/pages/usage.mjs:522-525`。
- 规格依据：审查清单 F——仅用键盘完成导航和主流程；交互元素需有键盘语义。
- 环境：960×680，存在成本预警；用量切到“按会话”。
- 实际：预警为带 `onClick` 的 div，`role=null,tabIndex=-1`；会话明细为可点击 tr，`tabIndex=-1` 且内部 button/a 数量为 0。两者都只有 pointer 样式。证据：`misc-results.json#mouseOnlyNavigation`。
- 复现：渲染预警与会话下钻，检查可聚焦元素并尝试键盘激活。
- 频率：确定。
- 影响：键盘用户无法使用这两条跳转路径，只能绕行其它导航。
- 建议（非强制）：改用 button/link，或补正确 role、tabIndex 与 Enter/Space 行为。

### [P2-20] 普通关键词筛选后，导出仍包含未筛选维度
- 位置：`dock/ui/pages/usage.mjs:248-288,356-396`。
- 规格依据：审查清单 E——导出内容与当前筛选一致；若全量导出是既定设计，则规格需明确普通关键词也例外，而非只写“时间过滤”例外。
- 环境：两个维度 alpha/beta，搜索 `alpha` 后导出 JSON。
- 实际：排名只显示 alpha，但导出包含 alpha 和 beta，共 4 行。证据：`misc-results.json#usageSearchExport`、`usage-search-alpha-export.json`。
- 复现：在用量下钻输入 alpha，观察排名，再导出 JSON 并比较 agentId。
- 频率：确定。
- 影响：界面所见与导出数据口径不同；实现注释与审查清单也存在方向冲突，需要明确其一。
- 建议（非强制）：按当前普通关键词过滤导出，或在 UI/规格中明确“导出始终全量”。

### [P2-21] `prefers-reduced-motion` 下 Skeleton 仍保留 infinite 动画
- 位置：`dock/ui/console.css:950-959,1590-1596`；`dock/ui/tokens.css:95-102`。
- 规格依据：D039——`prefers-reduced-motion` 下全部关闭。
- 环境：浏览器 `reducedMotion=reduce`，延迟厂商响应使 Skeleton 可见。
- 实际：computed style 为 `animation-name:shimmer,duration:1e-06s,iteration-count:infinite`，`document.getAnimations()` 仍有 running 动画。仅缩短时长，没有取消动画。证据：`console-interaction-results.json#skeletonReducedMotion`。
- 复现：在 reduce 模式打开延迟加载页面，读取 Skeleton 动画与 Web Animations。
- 频率：确定。
- 影响：不符合减少动态效果的无动画契约，超高频 infinite 动画也不是静态替代。
- 建议（非强制）：reduce 下对 Skeleton 和其它动画显式 `animation:none`，而非只改 duration。

### [P2-22] 火山 IAM AK/SK 第二步失败会留下半对凭据
- 位置：`dock/ui/pages/vendors.mjs:98-128,131-150`。
- 规格依据：`UI-SPEC.md` §5「厂商与密钥」——AK/SK 成对保存/删除。
- 环境：第一条 AK POST 成功，第二条 SK POST 返回合成失败。
- 实际：请求序列只有两条 POST，没有补偿 DELETE 或回滚；第一条已成功，第二条失败 Toast 后仍停留表单，形成半对状态。证据：`console-interaction-results.json#volcPartialPair`。
- 复现：填入合成 AK/SK，令第二个 credential 端点失败并观察请求序列。
- 频率：确定。
- 影响：后续配额查询会在不完整凭据下失败，与界面声称的成对约束不一致。
- 建议（非强制）：由 daemon 提供成对原子写入，或在前端/服务端执行补偿并清楚报告最终状态。

### [P2-23] 关于页可在诊断未返回时导出 `{}`，且导出没有 Toast
- 位置：`dock/ui/pages/about.mjs:16-25,132-145`。
- 规格依据：`UI-SPEC.md` §5「关于」——复制/导出诊断包均要有 Toast；加载与错误反馈应明确。
- 环境：延迟 `/v1/diag/bundle`，在返回前点击导出。
- 实际：下载内容为 `{}`，Toast 文本为空；导出代码始终使用 `diag || {}`。证据：`console-interaction-results.json#aboutExportFeedback`、`about-early-diagnostics.json`。
- 复现：延迟诊断接口并立即导出，检查文件和 Toast。
- 频率：确定。
- 影响：用户得到没有诊断价值却看似成功的文件，无法判断导出是否有效。
- 建议（非强制）：数据未就绪时禁用导出或明确提示，成功后补 Toast，失败说明原因。

### [P2-24] loading 被展开的 disabled 属性覆盖，导入期间可重复提交
- 位置：`dock/ui/components/base.mjs:67-71`；触发处 `dock/ui/pages/settings.mjs:333-335`。
- 规格依据：审查清单 C/E——loading/disabled 状态必须可靠，避免重复操作。
- 环境：旧数据导入 POST 延迟 500ms，按钮初始 `disabled=false`。
- 实际：第一次点击后按钮仍 `disabled=false`，第二次点击产生第二个 POST；实测 writes=2。原因是 `disabled=${rest.disabled || loading} ...${rest}` 后展开的属性覆盖前者。证据：`console-interaction-results.json#importLoadingDuplicate`。
- 复现：打开从旧挂件导入 Dialog，连续点击“导入选中项”两次并统计 POST。
- 频率：确定。
- 影响：慢请求下可重复导入，造成重复写入与不确定反馈；同模式也可能影响其它按钮。
- 建议（非强制）：先展开 rest，再统一设置最终 disabled，并补 loading 时不可重复提交断言。

### [P2-25] 多类交互控件实际点击区小于规格 32×32
- 位置：`dock/ui/console.css:458-471,558-570,603-634,1439-1448,1789,1805-1806`。
- 规格依据：审查清单 C——所有交互元素点击区 ≥32×32；`SourceTag.dot` 按既有明确规格 16×16，未计入本问题。
- 环境：双主题、三档视口及 DPR 抽查的实际 `getBoundingClientRect()`。
- 实际：子任务展开按钮 `16×16`；详情标签高 `28`；日期日格高 `28`、月份按钮 `28×28`；Select option 最小高 `30`；总览 link button 高 `18`。证据：`matrix-results.json/matrix-summary.json`，另见 `datePickerKeyboard` 实测日格 `31.72×28`。
- 复现：分别打开会话详情、日期弹层、长 Select 和总览链接，测量可见控件矩形。
- 频率：确定。
- 影响：窄窗口和高 DPR 下命中难度增加；这是通用组件尺寸的系统性偏差，不是审美偏好。
- 建议（非强制）：扩大实际按钮或伪元素命中区至 32×32，保持视觉密度而不压缩命中区域。

### [P3-1] 侧栏和视角分段的状态点实际为 0×0
- 位置：`dock/ui/console.mjs:613-616,641-645`；标题栏专用样式 `dock/ui/console.css:55-63`。
- 规格依据：`UI-SPEC.md` §3——侧栏状态与视角状态点；缺失样式属于细节反馈问题。
- 环境：会话页，浅色/深色均可复现。
- 实际：侧栏 `.sidebar-status .dot` 和 5 个 `.segmented .dot` 的矩形均为 `0×0`，背景透明；文本“在线/离线”仍可读。证据：`console-interaction-results.json#statusDots`。
- 复现：打开会话页并测量这些空 span 的矩形。
- 频率：确定。
- 影响：预期状态视觉标记不可见，但尚有文字通道，不影响主流程。
- 建议（非强制）：为这些用途补通用 dot 尺寸/颜色，或删除无效占位并保持规格一致。

### [P3-2] 两处可见数据文字使用令牌外的 18px
- 位置：`dock/ui/console.css:1410-1413`；`dock/ui/charts/svg.mjs:270-294`。
- 规格依据：`UI-SPEC.md` §2——字号仅允许 12/13/14/16/20/24/32/40。
- 环境：双主题、三档视口和 DPR 抽查。
- 实际：总览厂商余额 `.vendor-mini-value` 为 18px；统计 Donut 中心总量也为 18px。实测示例 `$40.60`、`22.37亿`。证据：`matrix-summary.json#badFonts`。
- 复现：打开总览与统计页，读取上述节点的 computed font-size。
- 频率：确定。
- 影响：违反令牌一致性；没有低于 12px 的可读性问题，因此定为 P3。
- 建议（非强制）：归入最近的允许字号并复核卡片几何。

### [P3-3] 选择 3 个音效文件时静默丢弃第 3 个
- 位置：`dock/ui/pages/roles.mjs:128-146`。
- 规格依据：`UI-SPEC.md` §5「角色与气泡」及审查清单 I——导入 1–2 个文件，失败/限制要有可读提示。
- 环境：合成 `one.mp3/two.mp3/three.mp3`。
- 实际：代码先 `.slice(0,2)`，所以 `files.length>2` 的警告分支不可达；实际导入 press=one、release=two，Toast 只有“音效已导入并切换”，没有第 3 个被忽略的信息。证据：`console-interaction-results.json#soundThreeFiles`。
- 复现：一次选择 3 个音频，观察 Toast 与 import body。
- 频率：确定。
- 影响：用户不知道有文件被忽略，但仍可完成前两个文件的导入。
- 建议（非强制）：先判断原始文件数量，再截取或拒绝，并明确提示。

## 规格空白（不作为缺陷）

- **StatusTimeline**：规格要求当前行/详情状态读 `displayStatus`，但未明确历史时间线是否也必须把机器 idle 改写成展示 done；本报告不据此判缺陷。
- **Drawer**：清单要求检查 Drawer，但当前规格和实现没有独立 Drawer 组件，无法定义其验收行为。
- **SourceTag.dot 与 32px 命中区**：既有验收又明确 `SourceTag.dot=16×16`；本报告按该具体尺寸豁免，不把 dot 混入 P2-25。
- **快览上移时间窗**：审查清单写“1.5 秒内只允许一次上移”，而当前 `UI-SPEC.md` §1 与 E2E 写“晚到内容不再受 1.5 秒限制、只向上移动”。按后者实测未判缺陷，建议统一文档。
- **普通关键词导出口径**：实现注释倾向“搜索只影响展示”，审查清单要求导出与当前筛选一致；P2-20 已按“实现/规格方向冲突”记录，需产品定稿。

## 已核对且未发现问题的项

- **导航与壳层**：9 页可达；`Ctrl+1/2/7` 分别到 overview/sessions/roles；F5 不重建页面且停留 hash，刷新后仍在 roles；旧 `#context` 重定向由 E2E 通过。
- **响应式与 axe**：69 个组合中，axe critical/serious 0、pageerror 0、document 横向溢出 0、document 纵向滚动 0；`.content` 为 `min-height:0 + position:relative`。
- **快览卡**：DPR 1.25 下 1.8 秒晚到内容后 `clientH=scrollH=423`、`clientW=scrollW=318`；状态依次“工作中/已完成/空闲”，无纵横滚动条。
- **点外关闭与隐私**：快览和菜单合成点外关闭分别约 21.9ms、38.1ms；`hideMoney=true` 时整个 chip `hidden=true`，不是金额掩码。
- **高风险权限**：`role=alertdialog`，高风险徽标可见，允许按钮隐藏，焦点未落在允许；权限 E2E 的未到期处理/真实超时路径均通过。
- **SSE 与视角**：切换 WorkBuddy 视角前后宠物均为 `attached/zcode`；SSE 更新保留 `scrollTop=80` 和原 DOM 标记；停止夹具后显示“连接中断，重试中…”，恢复后“已连接”。证据：`final-probes-results.json`。
- **向导自启失败契约**：`/v1/maintenance/autostart` 失败时，`/v1/onboarding/complete` body 为 `{}`，没有把 autoStart 写入 complete；有明确失败 Toast。
- **D056 已覆盖边界**：37 个定向单测全过，包括 5 分钟窗口两端、turnActive 上限、工具结束至首字、workflow 起止、新回合复位和根会话计数。
- **静态硬约束**：未命中危险 DOM API；`overlay/pet.js` 无 `fetch(`；两 Electron 入口保持 contextIsolation/sandbox/nodeIntegration 配置，overlay `type:'toolbar'` 仍在；`lint` 与三份引擎副本同步检查通过。
- **视觉基线保护**：没有执行 `visual:update`，没有修改任何基线 PNG。

## 未验证 / 无法验证

- **128 张视觉基线**：当前 Edge 156 与固定基线 Edge 155 不符，`visual` 在环境检查阶段退出；需在固定环境补跑，不代表通过或失败。
- **真浮层系统行为**：未改变真实显示缩放、分辨率、任务栏位置或显示器增删；透明边穿透、全屏接管、真实最小化/失焦和原生 DPI 几何未做真机验收。P2-2/P2-3 的证据来自同一渲染路径的合成矩形，不等价于物理桌面验收。
- **原生窗口壳抽查**：真 Electron 冒烟通过，但原生标题栏在 DPR 1.25/1.5、760×560 双主题下的系统按钮裁切未逐张测量；浏览器 DPR 矩阵不替代原生 Windows 缩放。
- **真实外部服务**：按隔离要求未使用真实账号/密钥，因此厂商实网连接与真实凭据状态未验证；所有失败均由合成端点构造。
- **向导漏检恢复**：验证了自启失败写入契约，但没有构造“首次漏检、重新检测后新增宿主”的状态变化。
- **已知偶发浮层用例**：未把 anchor、单击角色、气泡避让等已知偶发项当成缺陷；本报告未对其进行 3 次真机复现，相关结论为未验证。
