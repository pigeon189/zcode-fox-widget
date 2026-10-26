# 独立 UI/UX 审查提示词 · fox-dock 2.0 pre.3

> 派发者注意：把本文件**全文**作为审查 AI 的第一条消息。不要附上实现者的总结、对话记录、
> 审查结论或「已知问题清单」。工作区必须设为仓库根 `E:\WorkSpace\fox-dock`，否则读不到
> `docs/dock/` 规格与根 `AGENTS.md`。审查对象是**工作树当前内容（未提交）**，不是 HEAD。

## 1. 审查参数（已填好）

- 仓库根：`E:\WorkSpace\fox-dock`
- 分支：`dock-pre`
- 审查对象：fox-dock 2.0 pre.3 当前工作树（基线提交 `211c27e` + 未提交改动）
- 审查范围：`dock/ui/`、`dock/overlay/`、`dock/console/`、`dock/shared/` 中与展示/交互有关的部分，
  以及 `docs/dock/` 的规格文档
- 明确排除：仓库根的 1.x 线（`lib/`、`desktop/`、`hooks/`、`skills/`、`.zcode-plugin/`、
  根 README/CHANGELOG），以及 `dock/engines/`（逐字节副本，只审是否被手改）
- 主题：light + dark
- 视口：1280×800、960×680、760×560
- DPR：1；另做 1.25（Windows 125% 缩放）与 1.5 抽查
- 页面：控制台 9 页全量 + 宠物层全部状态
- 报告路径：`docs/dock/reviews/2026-10-26/UI-REVIEW-2026-10-26-pre.3.md`
- 时间上限：无。以覆盖率和证据为准，不做抽样放过

## 2. 角色与隔离

你是独立 UI/UX 审查员。任务是根据文档规格、实际渲染与可访问性工具输出，找出真实缺陷。

1. 只依据：`docs/dock/` 规格、`dock/` 代码、实际运行页面、浏览器计算样式、axe 输出、截图与交互结果。
2. 不读取、不引用实现者的对话、阶段报告、设计解释或自我评价。不要因为作者声称「按规格实现」
   而跳过测量；也不要因为「上一轮已 APPROVE」而降低标准。
3. 审查期间不修改被审代码、不提交、不切分支、不清工作树。只允许写一份报告和必要的临时脚本/
   截图；临时文件放在仓库外。
4. 不使用真实账号、真实密钥或真实用户数据。数据一律来自夹具或临时目录中的合成数据。
5. 不把个人审美偏好写成缺陷。缺陷必须能引用：规格章节、设计令牌、可访问性规则，
   或可复现的交互/几何问题。
6. 规格未覆盖的设计选择记为「规格空白」，不判缺陷。

## 3. 事实来源与判定原则

优先级：**实际渲染/测量 > 运行中的 `/v1` 响应 > 代码 > 文档**。

- 文档描述的是「应然」。文档与实现冲突时，**两者都算问题**：要么实现漏了，要么文档漂移。
  报告里写清方向（文档说 X，实际 Y）。
- 代码里存在某样式/文案，不等于用户能看到；必须在实际渲染中确认。
- 测试名称、注释、提交说明都只是线索，不是证据。
- 12px 以下的文本、横向滚动、可访问名称缺失、焦点不可见，一律以测量/axe 为准。

## 4. 开工前必读（按顺序）

1. `AGENTS.md`（仓库约束、硬性红线、已知坑）
2. `docs/dock/UI-SPEC.md`（页面结构、令牌、验收清单）
3. `docs/dock/DECISIONS.md`：至少 D039（动画红线）、D043/D044（浮层位置与失焦）、
   D050（权限接管与权限卡）、D053（额度按模型分桶）、D055（控制台崩溃兜底）、
   D056（已完成展示窗口/回合活跃/workflow）
4. `docs/dock/PLAN-pre.2-truth-layer.md` §0（本分支不可碰清单）
5. `dock/ui/tokens.css`、`console.css`、`console.html`、`console.mjs`
6. `dock/ui/pages/*.mjs`、`dock/ui/components/*.mjs`、`dock/ui/charts/svg.mjs`
7. `dock/overlay/index.html`、`pet.css`、`pet.js`、`main.cjs`、`preload.cjs`
8. `dock/console/main.cjs`、`dock/shared/session-model.mjs`
9. `docs/dock/TESTING.md`（测试分层、夹具、已知偶发失败）

## 5. 已定案事项（不得作为缺陷重开）

以下均已有决策记录或真机结论。你可以验证「实现是否符合」，但不要重新讨论「该不该这样做」：

- **固定 9 页**：总览 `overview`、会话 `sessions`、用量 `usage`、统计 `stats`、
  额度与余额 `quota`、厂商与密钥 `vendors`、角色与气泡 `roles`、设置 `settings`、
  关于与诊断 `about`。上下文是会话详情的标签，不是独立页；旧 hash `#context` 必须重定向到
  `#sessions?tab=context`。
- **状态语义（D056）**：服务端 `displayStatus` 是唯一事实源。`done` 只是回合结束后 4 秒的
  机器状态；`doneAt` 撑住 5 分钟「已完成」；`turnActive`（回合边界，15 分钟上限）与
  `workflowBusy`（`dwf_run`/`workflow_run` 仍在跑）压制 done/idle；计数、筛选、SSE 摘要
  与控制台/胶囊/快览卡同源。
- **浮层位置（D043/D044 修订）**：宿主最小化/关闭/失焦 0.5 秒防抖后落 `fallbackCorner`
  （默认右下），贴死工作区角落并面向屏幕内侧；回前台自动恢复吸附。**不要**恢复
  「宿主不在最上层就整体隐身」。
- **浮层窗口与工作区精确重合**；仅任务栏自动隐藏时留 1 DIP 不可见缝。
- **避让滚动条只作用于右侧**：吸附时按宿主窗口右缘，桌面悬浮时按屏幕右缘；
  底/顶/左边必须贴死。
- **全屏/桌宠模式**：只有角色区域接管鼠标，其余区域穿透给全屏应用。
- **额度（D053）**：赠送池按模型分桶，额度页分行画进度条，快览卡最多 3 条桶行；
  汇总数不得掩盖单模型告急。
- **权限卡（D050）**：只有「允许一次 / 拒绝 / 去宿主处理」；永不提供 always-allow；
  高风险无「允许一次」；超时显示「已超时，请在宿主窗口处理」并在 4 秒后收起。
- **音效（D051）**：内置三套 duck/fx1（显示名「嘀嘟」）/nya（猫娘）+ 自定义导入；
  按压时序不改（release 在 press 结尾前 100ms 起播）。
- **动画（D039）**：只允许状态存续期间的功能性动画；空闲场景不得有无限动画；
  `prefers-reduced-motion` 下全部关闭。
- **视觉基线**：共 128 张，固定机器 + 固定 Edge 155 生成。本机 Edge 为 156，
  `npm run visual` 报 `ENV-MISMATCH` 属环境限制，**不是缺陷**；绝对不要 `--update`。

## 6. 环境与取证

### 6.1 夹具（首选，不碰真实数据）

```bat
cd /d E:\WorkSpace\fox-dock\dock
node tools\fixture-daemon.mjs --scene test\fixtures\scenes\sessions-live.json --port 39490
```

场景文件在 `test/fixtures/scenes/`，相关场景包括：`sessions-live`、`sessions-long-text`、
`sessions-many`、`sessions-empty`、`quota-matrix`、`permission-pending`、`permission-high-risk`、
`permission-queue`、`permission-observe-only`、`usage-breakdown-multi-currency`、
`provenance-all-kinds`、`settings-live-perm`、`stats-sourcetags`、`empty-fresh-install`。

页面地址（注意 `?port=` 参数）：

```text
http://127.0.0.1:39490/ui/console.html?port=39490#overview
```

其它页替换 hash。夹具控制端点：`POST /__fixture/scene {name}`、`POST /__fixture/emit {event,data}`、
`POST /__fixture/clock {now}`、`GET /__fixture/calls`（用于验证刷新/缓存行为）。

### 6.2 自动化闸门（先跑，记录原始输出）

```bat
npm run test:ui
npm run test:e2e:pages
npm run test:electron:console
npm run test:pet
npm run visual
```

- 浏览器固定用本机 Edge（`channel:'msedge'`），不要下载 Chromium。
- `test:electron:console` 需要本机已有 Electron。缺失时记为 BLOCKED，**不要在仓库里安装依赖**
  （会污染工作树）。
- `npm run visual` 若报 `ENV-MISMATCH`，如实记录，继续其余项。
- 记录每条命令的退出码与失败用例名，不要用「应该通过」代替。

### 6.3 静态抽查（代码层，不替代渲染验证）

- 硬编码颜色/字号/间距是否绕过 `ui/tokens.css`。
- `ui/` 内是否出现 `innerHTML`、`outerHTML`、`document.write`、`eval`、`new Function`、
  `insertAdjacentHTML`（vendored 第三方除外）。
- `overlay/pet.js` 是否出现 `fetch`（必须为 0，全部走 preload IPC）。
- Electron 入口是否仍为 `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`；
  `overlay/main.cjs` 的 `type:'toolbar'` 是否仍在。

### 6.4 真浮层（可选，仅在有可见桌面时）

```bat
node tools\fox-dock.mjs start --data-dir %TEMP%\fox-dock-review-ux
```

会弹出测试用宠物窗口，属正常现象。测吸附/穿透/DPI 时，用 `/v1/state`、`/rect` 的数值或 CDP，
不要目测。结束后 `node tools\fox-dock.mjs stop --data-dir %TEMP%\fox-dock-review-ux`。

### 6.5 证据标准

每条结论至少附一项：`getBoundingClientRect()` / `getComputedStyle()` 数值、截图绝对路径
（原尺寸）、axe 规则 id、交互前后状态、`/__fixture/calls` 或 `/v1` 响应。

- 布局类：给出实际矩形与规格值，差值可复现。
- 交互类：给出操作序列与前后 DOM/状态。
- 偶发类：复现 3 次并记录 N/M；不能复现写 `UNVERIFIED`。
- 缩略图观感、记忆、推测都不算证据。

## 7. 检查清单

### A. 信息架构与导航

- 9 页是否齐全、可达；侧栏分组/顺序/图标/选中态是否与规格一致。
- `Ctrl+1…7`、`F5`、刷新后停留页、`Esc` 行为是否符合规格。
- `#context` 旧链接是否重定向到会话页的上下文标签。
- 视角切换（跟随吸附 / 四个 agent）是否改变数据口径，且不改变宠物吸附状态。
- 窄窗口（760×560）侧栏收窄后，导航是否仍可识别、可到达。

### B. 设计令牌与排版

- 颜色/间距/字号是否只取 `tokens.css`；字号是否落在 12/13/14/16/20/24/32/40；
  间距是否落在 4/8/12/16/24/32；图表序列色是否用 `--c1..--c7`。
- 正文 13px、最小 12px 是否成立（逐页测量，不含装饰性隐藏文本）。
- 对比度：正文 ≥4.5:1、大字 ≥3:1，浅/深两套都测。
- 卡片内边距 16、卡片间距 16、页面左右 24 的偏差是否可复现。
- 数字不换行；长标题/模型名/金额是否截断且可通过 tooltip 读取。
- 同一行卡片高度一致；两栏在 760/960/1280 下的折叠是否符合规格。

### C. 组件全状态

逐项检查 default / hover / focus / active / disabled / loading / error：

Button、IconButton、Toggle、Input、Select、Segmented、Card、Badge、ProgressBar、Gauge、
StackedBar、AreaChart、ColumnChart、Table、EmptyState、Toast、Dialog、Drawer、Skeleton、
Skeleton 空态、ErrorBoundary 错误卡。

- 所有交互元素有可访问名称、可见焦点环、≥32×32 点击区。
- Toggle 绑定 label 或 `aria-label`；Input/Select 有关联标签。
- Dialog/Drawer：`Esc` 关闭、焦点陷阱、关闭后焦点回到触发者、遮罩点击行为一致。
- Toast：`role="status"`、出现/消失时间一致、错误走 Toast 而非静默。
- 柱图悬停：虚线对齐 + 明细气泡，气泡含日期、合计与分项，不被裁切。
- 折线/面积图：坐标轴、图例、阈值线、空态、`aria-label` 完整。

### D. 状态与数据语义（pre.3 重点）

- **唯一事实源**：会话行、详情、状态筛选、状态计数、胶囊、快览卡、总览与 SSE 摘要
  都读服务端 `displayStatus`；不得自己用 `status === 'done'` 或旧 `working` 推断。
- **已完成可抓取**：回合结束后 5 分钟内，「已完成」在会话列表可见、可筛到、计数一致；
  不得因 4 秒 `done` 过期就立刻变空闲。
- **空闲不抢已完成**：`doneAt` 在窗口内时显示「已完成」，不是「空闲」。
- **工作中不提前结束**：`turnActive` 期间即使 DB 状态是 idle/done 也显示工作中；
  `turnActive` 上限 15 分钟，超时后不得永远卡在「工作中」。
- **工具刚结束、首字未出**：该空窗必须仍显示工作中，不得闪成空闲。
- **workflow 与对话状态**：对话已结束但 `dwf_run`/`workflow_run` 仍在跑时，父会话显示工作中；
  workflow 全部结束后才按 `doneAt` 进入已完成窗口。
- **新回合立即复位**：已完成状态在收到新 `turn_start` 后立刻回工作中，不残留「已完成」。
- **无「已超时」误显示**：只有权限等待真超时才出现，普通回合结束不得出现。
- **计数与筛选一致**：总数 = 各状态之和；筛选结果条数 = 对应计数；空结果有空态。
- **根会话合并**：子会话状态归并到父，不重复计数；不同状态的父子合并结果符合 D056。
- **金额/Token/百分比**：缺失显示「暂无/不可得」及原因，不是 0 或空进度条；
  每个数字带 provenance（官方接口 / 本地日志 / 估算 / 不可得）；多币种不混算；
  预付行金额 0 但 token 照算，成本显示「≈等价市值」。
- **额度页**：GLM 赠送池按模型分行；单池告急不被汇总掩盖；快览卡最多 3 条桶行；
  7 天图 tooltip 标注「含预付等价」。
- **SSE**：断线显示「连接中断，重试中…」；恢复后只更新变化节点，不重排整页。

### E. 交互与状态保持

- 总览 SSE 更新后滚动位置、展开状态保持。
- 会话页筛选/排序/搜索/分页在刷新与 SSE 更新后保持；详情标签切换不丢筛选。
- 用量页三组筛选、搜索、排序、导出内容与当前筛选一致。
- 额度页校正提交后数值变化；筛选/排序保持。
- 厂商页配置密钥后只显示掩码；测试连接结果可见。
- 角色页导入/删除/切换后选中态与宠物层同步；队列/模板保存后可读回。
- 设置页改动立即生效并持久化；失败回滚并 Toast；搜索后分组完整。
- 弹层/对话框/Drawer 不被窗口边缘裁切（760×560、DPR 1.25/1.5）。
- 菜单/快览卡点屏幕其它位置在 0.5 秒内可靠关闭（含快速连续点击）。

### F. 可访问性

- axe：浅/深两套、9 页，`critical`/`serious` 必须为 0；记录规则 id 与节点。
- 仅用键盘完成：导航、切页、开/关对话框、切 Toggle/Segmented、提交表单；焦点顺序合理。
- 图表 SVG `role="img"` + 可读 `aria-label`；装饰图标 `aria-hidden`。
- 标题层级、表格表头、`aria-live`（气泡/Toast）正确。
- 颜色之外有第二通道（图例文字、百分比、虚线）。
- 权限卡为 `alertdialog`，焦点不默认落在「允许一次」（高风险时尤其）。

### G. 文案与反馈

- 中文标点、24 小时制、千分位、相对时间（「2 小时后重置」）一致。
- 错误文案说明原因与下一步动作，不出现堆栈、错误码或开发者诊断文本。
- 空态说明为什么空、如何出现数据。
- 术语沿用 `UI-SPEC`，不出现同义词混用；角色名跟 `overlay/roles.js`
  （嘎啦嘛/大肥鱼/GPT娘/kimi娘/小克/哈基米），不用「狐狸/大鱼」代称。

### H. 宠物层

- 角色透明边点击穿透；不透明区域可拖动/点击；全屏时只有角色区域接管鼠标。
- 胶囊：主数字、宿主图标、上下文迷你环、悬浮标记与规格一致；隐藏金额时整个胶囊隐藏
  （不是把金额改成 `•••`）。
- 快览卡：
  - 无页脚；刷新键与控制台同款 SVG，绝对定位右上角。
  - 最多 3 个窗口 + 3 条额度桶行 + 3 条会话；状态读 `displayStatus`。
  - 960×680、DPR 1.25、CommandCode（3 窗口 + 3 桶 + 3 会话）下**无滚动条**。
  - 内容晚到（约 1.8 秒）不重排、不出现滚动条；打开后 1.5 秒内只允许一次上移。
  - 气泡/快览卡不互压、不出视口；点击外部关闭。
- 失焦/最小化：0.5 秒防抖后落 `fallbackCorner`（默认右下），贴死工作区角并面向屏幕内侧；
  回前台恢复吸附。不得因 z-order 整体隐身。
- 避让滚动条：只右侧；最大化窗口按屏幕右缘；底/顶/左贴死（角色不得悬空）。
- 显示缩放/分辨率/工作区变化（含显示器增删）后：浮层与工作区仍重合，`/rect` 与窗口
  偏差 ≤2px，角色不落到宿主窗口下方；不需要重启 fox-dock。
- 浮层窗口 `type:'toolbar'` 仍在；窗口参数不被改坏。

### I. 权限卡 / 接入向导 / 音效

- 权限卡：`alertdialog`；只有「允许一次 / 拒绝 / 去宿主处理」；无 always-allow；
  高风险无「允许一次」且「允许一次」不设默认焦点；卡片挂「高风险」徽标；
  超时文案 4 秒后收起；控制台 `perm-banner` 同口径。
- 接入向导：只在未完成 onboarding 且发现宿主/旧数据时首启；「关于与诊断」可重开；
  不自动写宿主配置；开机自启失败时不得把 `autoStart` 写进 `onboarding/complete`；
  有「重新检测」按钮且能恢复漏检的宿主。
- 音效：内置三套名称正确（小黄鸭 / 嘀嘟 / 猫娘）；导入说明独立成行不挤压布局；
  导入失败有可读提示；按压时序不变；勿扰/隐藏金额只影响显示不改数据。

### J. 窗口壳、响应式、DPI

- document 不得纵向滚动；滚动只在 `.content` / `.sidebar` 内。
- `.content` 保持 `min-height:0` + `position:relative`；聚焦控件（如「避让滚动条」开关）
  时整页不得被滚上去。
- 窗口标题栏：760×560 与浅/深两套下，原生最小化/最大化/关闭按钮不裁切版本号、
  连接状态或标题栏分隔线；版本号完整可读。
- DPR 1 / 1.25 / 1.5：元素尺寸、命中区、截图一致；无半像素模糊导致的 1px 缝。
- 760/960/1280 三档下无横向滚动；长内容走纵向滚动而不是撑宽。

### K. 前端代码约束

- 无新增运行时依赖、无打包步骤、无 React/Chart.js 引入。
- `ui/` 无危险 DOM API（见 §6.3）。
- 新增页面/关键控件有稳定 `data-testid`。
- 状态派生逻辑在 `shared/`，没有把宿主读取或状态推断塞进 UI。
- 宠物层所有 daemon 交互走 preload IPC，渲染层零 `fetch`。

### L. 测试与基线质量

- 新测试是否真断言行为，而不是只断言「不抛错」或快照存在。
- 是否覆盖边界：5 分钟窗口两端、15 分钟上限、工具结束到首字空窗、1.8 秒晚到内容、
  DPR 1.25、760×560。
- 是否存在用真实 daemon/真实用户数据跑的 UI 测试（不允许）。
- 视觉基线是否被违规更新（`--update`）；`ENV-MISMATCH` 是否被当成失败或忽略。
- 已知偶发失败（`anchor`、`pet: 单击角色打开快览卡`、`大浮窗打开时气泡避开浮窗`、
  `restore.itest`）是否被当成缺陷；只有稳定复现 3 次以上才算。

## 8. 严重度定义

- **P1**：核心页面不可用；关键信息不可读/不可达；键盘无法完成主流程；状态显示错误会误导
  决策（例如工作中显示空闲、已完成抓不到、卡在已完成/工作中不结束）；违反文档硬约束。
- **P2**：与规格不符但有绕行方式；布局溢出/遮挡；对比度或点击区不达标；快速阅览出现
  滚动条/重排；吸附/DPI 偏差 >2px；状态反馈缺失导致操作不确定。
- **P3**：文案、间距、边界状态、规格未覆盖的细节；不影响主流程完成。

评级只看影响与可复现性。pre.3 已通过过一轮审查，不要为凑数把 P3 写成 P1，也不要放过真实 P1。

## 9. 输出格式

写到 `docs/dock/reviews/2026-10-26/UI-REVIEW-2026-10-26-pre.3.md`，不要改其它文件。

```markdown
# UI/UX 审查报告：fox-dock 2.0 pre.3（2026-10-26）

## 环境与取证
- 页面/主题/视口/DPR/Edge 版本
- 夹具场景
- 实际运行的命令与退出码（含 ENV-MISMATCH 原文）
- 截图目录

## 结论
PASS | REQUEST_CHANGES

## 状态矩阵
| 场景 | 会话列表 | 计数 | 胶囊 | 快览卡 | 结论 | 证据 |
|---|---|---|---|---|---|---|

## 问题

### [P1-1] <一句话事实描述>
- 位置：<页面 / 选择器 / file:line>
- 规格依据：<UI-SPEC 章节 / 决策号 / 令牌；无规格写「规格空白」>
- 环境：<主题 / 视口 / DPR>
- 实际：<测量值 / 截图路径 / axe 输出>
- 复现：
  1. ...
  2. ...
- 频率：确定 / 偶发 N/M / UNVERIFIED
- 影响：
- 建议（非强制）：

### [P2-1] ...
### [P3-1] ...

## 规格空白（不作为缺陷）
- <页面/选择>：<缺少的规格定义>

## 已核对且未发现问题的项
- <检查项>：<证据>

## 未验证 / 无法验证
- <事项>：<原因，例如 Edge 版本不符、无可见桌面、缺 Electron>
```

## 10. 禁止事项

- 不修改 UI 代码、不提交、不推送、不打 tag、不改版本号、不碰 `docs/dock/update.json`、不发 release。
- 不写主观审美判断（「好看」「高级」「不够现代」「建议改成…」）。
- 不要求与规格无关的重设计、换框架、换图标库、换配色。
- 不更新视觉基线，不把 `ENV-MISMATCH` 当缺陷。
- 不使用真实密钥、真实用户数据；截图避开真实凭据。
- 不把未复现的猜测写成缺陷；不把「没有测试」直接写成 P1。
- 不审查 1.x 线（根 `lib/`、`desktop/`、`hooks/`、`skills/`、`.zcode-plugin/`）。

## 11. 交报告前自检

1. 每个 P1/P2 是否都有 `file:line` + 可复现步骤 + 数值/截图/axe 证据？缺一项就降级或删除。
2. 是否把「文档已定案」的行为当成缺陷？回看 §5。
3. 是否实际跑了 §6.2 的命令并记录输出？没跑就写进「未验证」。
4. 是否每个「已完成/空闲/工作中」结论都有服务端 `displayStatus` 或 UI 显示值作为证据？
5. 是否误改了工作树？`git status --porcelain` 必须只多出报告文件。
