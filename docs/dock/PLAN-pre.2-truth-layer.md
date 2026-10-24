# fox-dock 2.0.0-pre.2 / pre.3 实施方案：成本与额度「真相层」+ 会话实时层

> 读者：负责编码的 AI。作者：规划 AI（只出方案，不写代码）。
> 基线：分支 `dock-pre`，HEAD `7052369`。所有改动只落在 `dock/` 与 `docs/dock/`。
> 本文**取代**仓库里其它开发方向文档（`PLAN.md` 等只当历史参考）；与 `DECISIONS.md` 冲突时以本文为准，并按 §13 补写决策记录。
> 方向来源：上一位编码 AI 的调研结论——不再堆角色/动画，把 fox-dock 收紧成
> **「本地优先的多 agent 成本/额度真相层 + 桌宠入口」**。

---

## 0. 一页纸结论（先读这里）

| 项 | 决策 |
|---|---|
| 版本切分 | **pre.2** = M0 验证 + M1 可信度标签 + M2 会话实时层 + M3 会话页/总览重排 + M4 统计深化；**pre.3** = M5 权限气泡与自定义 agent 接入 + M6 增量缓存与接入向导。P2（角色包/WSL/只读看板）只写设计占位，不实现 |
| 最大技术风险 | ZCode `PermissionRequest` 钩子**能否回「允许」**未经验证。必须先做 M0 探针；探针失败则权限气泡降级为「通知 + 拒绝 + 跳转」，不得硬做 |
| 控制台页面数 | **保持 9 页**：新增「会话」页，把「上下文」页并进「会话」详情的一个标签（`#context` 保留为重定向）。不再加页 |
| 动画红线 | **不做 idle 呼吸**（D031）。只允许「某状态存续期间」的状态动画；空闲场景 `document.getAnimations()` 必须为 0（有自动化测试守住，见 §9） |
| 数字可信度 | 每个金额/token/百分比携带 `provenance`（4 类标签：官方接口 / 本地日志 / 估算 / 不可得），**缺失不补 0**（延续 D010/D029） |
| 不可碰的文件 | `dock/engines/{pricing,cmdgo,relays}.mjs` 是挂件线 `lib/` 的**逐字节副本**（D007，`npm run check:sync` 守着）。来源标签的包装逻辑必须写在新文件里，**不得改这三个文件** |
| 宿主配置 | 默认只读；**不自动写宿主配置**（Kimi OAuth 刷新写回仍是唯一例外）。ZCode 钩子通过随包提供的「集成插件目录」由用户自行安装 |
| 安全 | 本机 127.0.0.1、`x-fox-token`、Host 环回校验、预览文本脱敏、权限「永不提供 always-allow」、超时一律回落到宿主原生弹窗（fail-open to host） |

---

## 1. 两个项目的架构与介绍

仓库 `pigeon189/zcode-fox-widget` 采用**同仓库三分支**维护：

| 分支 | 产品 | tag 规则 | 备注 |
|---|---|---|---|
| `main` | ZCode 狐娘小挂件（1.x，ZCode 插件，`lib/` + `hooks/` + `desktop/`） | `vX.Y.Z` | 当前 1.15.1；**本任务不得改动** |
| `workbuddy` | WorkBuddy 挂件线 | `wb-vX.Y.Z` | **不得改动** |
| `dock-pre`（长分支 `feat/dock` 同源） | **fox-dock 2.0**（独立桌宠，`dock/` 子目录） | `dock-vX.Y.Z`，全部 GitHub prerelease | 1.0 之前不合回 main（D001/D021/D002）；更新只读 `docs/dock/update.json`（Ed25519 验签） |

### 1.1 旧挂件线（背景，只需知道边界）

- 形态：ZCode 插件（`.zcode-plugin/plugin.json`、`hooks/hooks.json`、`commands/`、`skills/`、MCP `whale`）+ Node 本地服务（`lib/server.mjs`）+ Electron 浮层（`desktop/`）。
- 价目/计价内核：`lib/pricing.mjs`、`lib/cmdgo.mjs`、`lib/relays.mjs` 等。**dock 里 `engines/` 复制了其中三份**，`tools/check-pricing-sync.mjs` 逐字节比对，`tools/parity-engines.mjs` 做口径一致性比对。
- 钩子：`hooks/hooks.json` 只挂 `SessionStart/UserPromptSubmit/PermissionRequest`；`lib/hook-event.mjs` 只写 `hook-state.json`。设计取舍（文件内注释）：ZCode 钩子**始终内联执行**，每挂一个高频事件就让每次工具调用多一次 node 冷启动（约 40–80ms），所以**只挂低频事件**。本方案沿用这条纪律。
- 共存：dock 在线时旧挂件让出浮层并（在外部分支）转发 `Notification/PermissionRequest` 到 dock 的 `POST /v1/events`；**该兼容入口必须保留**。

### 1.2 fox-dock 2.0（本任务主体）

零依赖 Node ≥22.5（`node:sqlite`）+ Electron 44 双窗口 + 手写 Win32 桥。

```
                    ┌────────────────────── daemon（Node，常驻，127.0.0.1:39401+）──────────────────────┐
 宿主数据源（只读）  │ watcher(3s 窗口发现) → bindings/state-machine(idle|attached|floating)               │
 ZCode  sqlite ─────►│ adapters/*  (zcode|workbuddy|kimi|dsh|generic)  ← contracts.mjs 归一化              │
 WB     jsonl  ─────►│ billing(3s TTL) | context-service(3s) + scheduler(1s tick) | stats-service(60s)     │
 dsh    zstd   ─────►│ engines/* 计价（峰谷/预付/中转）  vault(DPAPI)  settings(schema 2)  ledger          │
 Kimi   HTTP   ─────►│ v1.mjs  /v1/* REST  +  sse.mjs  /v1/stream（state/context/event/agent-*）          │
                    └───────────────┬───────────────────────────────┬────────────────────────────────────┘
                                    │ 本机 HTTP + x-fox-token        │ SSE
                          ┌─────────▼─────────┐            ┌─────────▼──────────┐
                          │ overlay（Electron）│            │ console（Electron） │
                          │ 全屏透明置顶穿透窗  │            │ 960×680 可聚焦窗口   │
                          │ 角色/胶囊/气泡/     │            │ Preact+htm 无构建   │
                          │ 快览卡/菜单         │            │ 9 页 + 手写 SVG 图表 │
                          └───────────────────┘            └────────────────────┘
          Win32 桥：daemon/win32/bridge.ps1（长驻 PowerShell + 内嵌 C#，stdin 一行一条命令：snapshot/cursor/ping/hit/rect/quit）
```

**要点（编码前必须记住）**

1. **适配器契约**：`adapters/contracts.mjs`。`validateAdapter` 只强校验 `id/name/match/capabilities.billing/createBilling`；`getStats/getContext/listSessions` 只靠 `capabilities` 声明，**没有强校验**。快照经 `normalizeSnapshot`，上下文经 `normalizeContext`，统计由 `adapters/stats.mjs#buildStats` 生成。`unit ∈ money|credit|percent`，金额按 `byCurrency` 分组，**从不跨币种/单位求和**。
2. **四个宿主的数据源与能力**（已核实）：

| 宿主 | 数据源 | session | turn | tool | 错误 | 耗时 | 实时信号 |
|---|---|---|---|---|---|---|---|
| ZCode | `~/.zcode/cli/db/db.sqlite`：`model_usage/turn_usage/tool_usage/session/session_entry`；`session.parent_id`（子会话） | ✅ | ✅ `turn_usage` | ✅ `tool_usage.status/duration_ms` | ✅ `status='error'` | ✅ | 钩子（低频）+ 库轮询（逐次调用即落库） |
| WorkBuddy | `~/.workbuddy/workbuddy.db` + `projects/**/*.jsonl` | ✅ | ✅ `conversationRequestId` | ✅ `function_call/_result` | ✅ result.status | ✅ 差值 | transcript 增量尾随 |
| dsh | `~/.dsh/sessions/**/session*.jsonl(.zstd)` 多帧 zstd | ✅ | ✅ `turn/start|end` | ✅ `tool/call|result` | ✅ | ✅ | 会话文件增量尾随（按帧） |
| Kimi Code | 本机 HTTP（`~/.kimi-code/server/instances/*.json` 发现端口+token）`/sessions`、`/sessions/:id/status`；额度 `/coding/v1/usages` | ✅ | ❌ | ❌ | ❌ | ❌ | 仅 status 轮询；**无历史** |

3. **现状缺口（本方案要补的）**：
   - 无 `provenance`：`snapshot.source` 只是个字符串，统计金额一律是「价目表折算」却没有标出是估算。
   - 无会话实时状态：`POST /v1/events` 只记 200 条并广播，**不驱动任何状态机**；前端仅 `console.mjs:258` 对 `permission-request` 弹 Toast。
   - 无会话列表/详情/下钻：`listSessions` 只给「上下文页」的 8 条（id/title/model/used/limit/pct/requests/updatedAt）。
   - 统计无自定义范围/环比/预测；用量页下钻只有「按 Agent」。
   - 全量扫描：ZCode 每次全量 SQL 聚合；WB 按 `path|size|mtime` 缓存但仍扫全部文件；dsh 每次重扫目录。
   - Win32 桥**没有「聚焦窗口」命令**（仅 snapshot/cursor/hit/rect），「跳转宿主窗口」需新增。
4. **宠物层现状**（`overlay/`）：全屏 workArea 透明置顶窗，默认鼠标穿透，命中角色/胶囊/气泡/快览卡/菜单才 `set-interactive`；`#fox` z20、气泡 z22、快览卡 z30（宽 320、圆角 16、padding 16）、菜单 z40（宽 224）、拖拽提示 z50；胶囊高 32；**无 `@keyframes`**，仅按压变形（`scaleY(.88) scaleX(1.05)`，回弹 `.22s cubic-bezier(.34,1.56,.64,1)`）。
5. **控制台现状**：侧栏 208px（<860px 折成 56px）、页头 72px、12 栏栅格 gap 16、卡片圆角 12/padding 16、字号仅允许 `12/13/14/16/20/24/32/40`、图标 Lucide 风格 `viewBox 24` `stroke-width 1.75`、自绘 `Select/Checkbox`（禁原生 `<select>`）、页面 `data-testid="page.<name>"`。设计令牌在 `ui/tokens.css`（深色以文件后段「ZCode 深色参考」为准：`--bg #1e1e1e / --surface #252526 / --surface-2 #2b2b2b / --border #3c3c3c`）。

---

## 2. 开发目标与优先级总表

| 优先级 | 里程碑 | 内容 | 版本 | 估时(人天) |
|---|---|---|---|---|
| P0-0 | **M0 探针与契约冻结** | 4 个真机/真库探针 + 3 份 schema 文档 | pre.2 | 1.5 |
| P0-1 | **M1 可信度标签（provenance）** | 契约扩展、各适配器标注、UI `SourceTag` | pre.2 | 3 |
| P0-2 | **M2 会话实时层（后端）** | 会话模型、LiveTracker、`/v1/sessions*`、SSE `session`、增量读取、`/v1/ingest` | pre.2 | 6 |
| P0-3 | **M3 会话页 + 总览任务化 + 宠物状态** | 前端大头 | pre.2 | 6 |
| P0-4 | **M4 统计深化** | 自定义范围/环比/预测/下钻/导出、额度矩阵与重置倒计时 | pre.2 | 5 |
| P1-1 | **M5 权限气泡 + 自定义 agent 接入** | 动作中介、热键、通知、跳转宿主窗口、HTTP 接入协议 | pre.3 | 6 |
| P1-2 | **M6 接入向导 + 增量缓存持久化 + 便携包** | 首启向导、WB/dsh 增量索引、便携版打包 | pre.3 | 5 |
| P2 | 角色包签名、WSL、只读移动看板 | 仅 §11 设计占位 | — | 不排期 |

执行顺序必须是 **M0 → M1 → M2 → (M3 ∥ M4) → M5 → M6**。M1 是 M2–M4 的数据前提（所有新结构都要带 provenance），M0 的探针结论决定 M2/M5 的实现分支。

**每个里程碑的完成定义（DoD）**：功能 + 单测 + 集成测试 + 页面自检（`test:ui`）+ 视觉基线（人工过目后 `visual:update`）+ 文档（ADAPTERS/UI-SPEC/TESTING/DECISIONS/CHANGELOG 对应条目）+ `npm run ci` 全绿 + `npm run test:all` 全绿。

---

## 3. M0：探针与契约冻结（先做，约 1.5 人天）

目标：把「推断」变成「事实」，把结论写进 `docs/dock/ADAPTERS.md` 的新章节「实时信号矩阵」。**探针脚本放 `dock/tools/probe-*.mjs`，只读、不入 CI，输出 JSON 供贴进文档。**

| 探针 | 做什么 | 判定与分支 |
|---|---|---|
| P-1 ZCode 库结构 | `PRAGMA table_info` 对 `turn_usage/model_usage/tool_usage/session`；`SELECT DISTINCT status` 三张表；是否存在 `running/pending/in_progress` 之类**进行中**取值；`session.parent_id` 样例 | 有进行中状态 → `working` 由库直接判；没有 → 用「最近 N 秒内有 `model_usage/tool_usage` 新行且 `turn_usage` 未 completed」推断，标 `statusSource:'inferred'` |
| P-2 ZCode 钩子契约 | 用最小插件（只挂 `PermissionRequest`，process 类型）实测：①stdin JSON 字段（`tool_name/tool_input/session_id/cwd`？）②stdout JSON 能否表达 allow（注意「严格 schema，多余键即校验失败」）③exit 2 = deny ④钩子运行期间宿主原生弹窗是**阻塞等待钩子**还是**并行出现** ⑤钩子超时后的行为 | 能回 allow → M5 全功能；仅能 deny → 气泡只给「拒绝」「去宿主处理」；④为并行 → 接管等待时长可更长；为阻塞 → 默认 8s |
| P-3 Kimi status | 真机 `GET /sessions/:id/status` 全字段 dump（含是否有 `state/busy/running`） | 有忙闲字段 → Kimi 支持 `working/idle`；没有 → `status:'unknown'` + provenance `unavailable` |
| P-4 Win32 聚焦 | 在 `bridge.ps1` 原型 `focus <hwnd>`：`IsIconic→ShowWindow(SW_RESTORE)`、`AttachThreadInput`+`SetForegroundWindow`+`BringWindowToTop`；在「前台被别的程序占用」时的成功率 | 成功率 <90% → 回落为「闪烁任务栏 + 系统通知」，UI 文案相应改为「提醒宿主窗口」 |

产出：
- `docs/dock/ADAPTERS.md` 新增「实时信号矩阵」表（宿主 × {working, waiting_input, waiting_permission, error, done} × 信号来源 × 延迟 × 可信度）。
- `docs/dock/schemas/session.v1.json`、`ingest.v1.json`、`provenance.v1.json`（JSON Schema 草案，供测试与自定义 agent 作者引用）。
- 探针结论若与本方案假设冲突，**先改本文对应章节再继续开发**（在 PR 描述里写明）。

> **实施记录（2026-10-22）**：
> - 探针脚本已落地：`dock/tools/probe-zcode-db.mjs`、`probe-zcode-hook.mjs`、
>   `probe-kimi-status.mjs`、`probe-win32-focus.mjs`。
> - **P-1 已实测**（本机 `~/.zcode/cli/db/db.sqlite`）：`tool_usage.status` 含
>   `running`，因此 ZCode 的 `working` 可先由库直接判定，再退回 20s 活跃度推断；
>   与本文 §5.2 假设一致，无需改方案。
> - **P-2 本地链路已实测**（stdin 字段到达、exit 0、stdout 可写）；allow 的严格 schema
>   仍需真机安装探针插件。**P-4 已真机执行**：foreground 3/3（100%），保留 flash 回落。
> - **P-3 未取到**：本机 Kimi 本地服务未运行，探针 `fetch failed`；Kimi 维持
>   `status:'unknown'` + `unavailable/host-unsupported`，不伪造 working。
> - Schema 已写入 `docs/dock/schemas/{session,ingest,provenance}.v1.json`。

---

## 4. M1：可信度标签 provenance（约 3 人天）

### 4.1 数据模型（新文件 `dock/shared/provenance.mjs`，零依赖）

```js
// kind：数值本身的可信等级；origin：数值从哪来
export const PROV_KINDS   = ['exact', 'estimated', 'unavailable']
export const PROV_ORIGINS = ['api', 'local-db', 'local-log', 'pricing-table', 'user', 'unknown']

// Prov = { kind, origin, source, asOf, note?, reason? }
//   source  例 'zcode:db.sqlite#model_usage' | 'kimi:/coding/v1/usages' | 'pricing:2026-10 deepseek peak'
//   asOf    数据读取时刻（ms）
//   reason  仅 unavailable：'not-running'|'no-session'|'no-data'|'auth'|'schema'|'host-unsupported'
export function prov(kind, origin, source, extra) {}        // 构造并校验
export function normalizeProv(raw) {}                        // 非法输入 → {kind:'unavailable',origin:'unknown',reason:'schema'}
export function worstOf(...provs) {}                         // 合并规则：unavailable > estimated > exact；origin 取最弱
export function uiLabelOf(p) {}                              // → 'official'|'local'|'estimate'|'unavailable'
```

**UI 四标签映射（`uiLabelOf`）**

| 条件 | 标签 | 中文 |
|---|---|---|
| `exact` 且 `origin==='api'` | `official` | 官方接口 |
| `exact` 且 `origin ∈ {local-db, local-log}` | `local` | 本地日志 |
| `estimated`（任何 origin） | `estimate` | 估算 |
| `unavailable` | `unavailable` | 不可得 |

> `user`（余额校正等手工值）→ `estimated`，`note:'用户校正'`。

### 4.2 契约改动（只加字段，不破坏现有消费者）

- `normalizeSnapshot` 新增 `provenance: { today, turn, balance, quota, usage }`（每个值是 `Prov`；缺省按「数据存在但适配器未声明」处理为 `estimated/unknown`，**并在单测里强制所有内置适配器显式声明**，见 §9.1）。
- `normalizeContext`：`used` 与 `limit` **分别标注**，输出 `provenance:{used, limit}`。`used` 由现有 `confidence` 派生（`exact→exact`，`derived→estimated`，`unavailable→unavailable`，origin 取适配器数据源）；`limit` 由 `limitSource` 派生（`host→exact`；`config→exact/user`；`builtin-table→estimated/unknown`，note「内置窗口表」；`unknown→unavailable`）。
- `buildStats` 输出新增 `provenance:{ tokens, cost, credits, models, tools, turns }`。规则见下表。
- `usage-records`/ledger 行新增 `prov`。

**各适配器标注规则（实现者照此表逐项落地）**

| 字段 | ZCode | WorkBuddy | dsh | Kimi |
|---|---|---|---|---|
| token 计数 | exact/local-db（`model_usage`） | exact/local-log（`rawUsage`） | exact/local-log | 不可得 `host-unsupported`（无历史） |
| 金额 `today/turn` | **estimated**/pricing-table（token×价目）；预付/套餐行 `amount=0` 且 note「预付/订阅，等价市值见 market」 | 积分口径 exact/local-log（`unit:'credit'`，无换算） | estimated/pricing-table；回落旧账本 `.dshw-usage.json` 时 estimated/user | 套餐窗口 exact/api；金额不可得 |
| 余额 | exact/api（DeepSeek/GLM/CMD 等厂商接口）；失败 → unavailable `auth/no-data`；叠加余额校正 → estimated/user | 积分余额 exact/local-db（若有）否则不可得 | exact/api（`api.deepseek.com/user/balance`） | exact/api（`/coding/v1/usages`） |
| 配额窗口 `quota/quotaCard.windows` | exact/api | 不可得 | exact/api（DeepSeek 无窗口则不显示） | exact/api |
| 上下文 `used` | 沿用 `confidence` | 同 | 同 | 同 |
| 工具调用/错误/耗时 | exact/local-db | exact/local-log（耗时=调用到结果差值，标 note「差值推算」→ estimated） | exact/local-log | 不可得 |

**实现位置约束**：`dock/engines/pricing.mjs` 等三份副本**不许改**。在 `dock/daemon/src/cost-prov.mjs` 新增
`withCostProv(costResult, ctx)`：包装 `costOfUsage()` 的返回，附 `prov = prov('estimated','pricing-table', 'pricing:'+vendorLabel+(peak?' 峰':' 谷')+(tier?'/'+tier:''), {asOf, note:'价目快照 '+SNAPSHOT_DATE})`。价目快照日期来自 `pricing.mjs` 已导出的常量（先 grep 确认名称，没有就在包装层写常量并加单测提醒复核）。

### 4.3 前端（M1 仅做组件与页面接入点，页面重排在 M3）

见 §7.1 `SourceTag` 规格。**接入点**：总览主数字、用量/统计所有数字、额度卡、上下文页、会话页。API 里没有 `provenance` 的旧数据 → `SourceTag` 显示「不可得」并 `console.warn`（测试环境下直接抛错，防止漏标）。

---

## 5. M2：会话实时层后端（约 6 人天）

### 5.1 会话模型（`dock/shared/session-model.mjs`）

```js
// normalizeSession(raw) → Session，所有数值 number|null，禁止 NaN/字符串数字
Session = {
  key: 'zcode:ses_abc',            // `${agentId}:${sessionId}`，全局唯一
  agentId, sessionId, parentKey: null | string,   // 子任务/子会话
  title, cwd,                      // cwd 仅保留，API 返回前 redactHome()
  model, provider,
  status: 'working'|'waiting_input'|'waiting_permission'|'error'|'done'|'idle'|'unknown',
  statusSince, statusSource: 'hook'|'db'|'log'|'http'|'inferred'|'ingest',
  startedAt, updatedAt, endedAt: null,
  turns: { count, current: { id, index, startedAt } | null, avgDurationMs },
  tokens: { total, input, output, cacheRead, cacheWrite, reasoning },
  cost:   { amount, currency, unit } | null,
  tools:  { calls, errors, running: [{ name, since }] },
  errors: { model, tool, last: null | { at, kind:'model'|'tool', message /* ≤200 字，已脱敏 */ } },
  pending: PendingAction[],        // 仅 M5 之后非空
  provenance: { tokens, cost, status, tools }   // 都是 Prov
}
```

状态含义（UI 文案固定，见 §7）：`working` 工作中｜`waiting_input` 等待输入｜`waiting_permission` 等待确认｜`error` 出错｜`done` 已完成｜`idle` 空闲｜`unknown` 状态未知。

### 5.2 适配器契约扩展（**可选方法 + capabilities 声明**，向后兼容）

在 `contracts.mjs` 新增：

```js
// capabilities.sessions: true | { list:true, detail:true, live:true, actions:['permission'] }
adapter.getSessions({ range, limit, cursor, now }) → { ok, supported, reason?, items: Session[], nextCursor }
adapter.getSessionDetail(sessionId, { now })        → { ok, session, turns: Turn[], tools: ToolRow[], models: ModelRow[] }
adapter.getLiveStatus({ now, sinceMs })              → { ok, supported, items: Session[] /* 仅近 10 分钟有活动者 */ }
adapter.readUsageRows({ since, until })              → AsyncIterable<UsageRow> | { aggregated }   // 供下钻
```

- `validateAdapter` 增加**软校验**：声明了 `capabilities.sessions` 就必须实现 `getSessions`；`live` 必须实现 `getLiveStatus`；不满足则拒绝注册。
- `listSessions`（上下文页用）**保留**，内部改为 `getSessions` 的薄封装，不改返回形状。
- `Turn = { id, index, startedAt, endedAt, durationMs, tokens, cost, status:'completed'|'error'|'running', model }`
- `ToolRow = { name, calls, errors, avgDurationMs, lastAt }`

**四个适配器的实现要点**

- **ZCode**（`adapters/zcode/sessions.mjs` 新文件）：
  - 列表：`session LEFT JOIN` 聚合子查询（`model_usage` 按 `session_id` 汇总 token/次数；`tool_usage` 汇总调用/错误；`turn_usage` 汇总回合）。**用只读连接 + 预编译语句**，沿用 `store.mjs` 的连接缓存。
  - 子任务：`session.parent_id` → `parentKey`。
  - 增量：`model_usage/tool_usage/turn_usage` 记录各自 `MAX(rowid)` 水位，live 轮询只查 `rowid > watermark` 的新行并合入内存会话表；每 60s 做一次全量校准以修正漂移。
  - `working` 判定（以 M0 P-1 为准）：钩子 `UserPromptSubmit` 触发 `working`（`statusSource:'hook'`）→ 库内新增 `model_usage/tool_usage` 保持 `working` → `turn_usage` 出现 `completed` 或钩子 `Stop` → `done`（4 秒后降为 `idle`）。无钩子时纯库推断：最近 20s 内有新行 → `working`；回合 `completed` → `done`；`model_usage.status='error'` 且之后无新行 → `error`。
- **WorkBuddy**（`adapters/workbuddy/live.mjs`）：对每个近期活跃 transcript 用 `TailReader`（§5.4）增量读；`function_call` 无对应 `function_call_result` → `tools.running` 非空且 `working`；result.status ≠ completed → `error`；无新事件超过 90s → `idle`。
- **dsh**（`adapters/dsh/live.mjs`）：按帧增量读（§5.4）；`turn/start` 后无 `turn/end` → `working`；`turn/end.reason.kind==='completed'` → `done`；`tool/result.error!=null` 计入工具错误；`compaction/*` 事件记入 `errors`？**不记**，压缩只进上下文页。
- **Kimi**：`getSessions` 返回会话列表（来自 `/sessions`），**没有 turn/tool/历史**，字段全 `null` 且 provenance `unavailable/host-unsupported`；`status` 由 M0 P-3 结果决定，缺省 `unknown`。**不得伪造 `working`。**

### 5.3 LiveTracker（`daemon/src/live-tracker.mjs`）

职责：合并「适配器轮询结果」与「事件注入」，维护统一的会话表，向 SSE 发增量。

```
 sources:  adapter.getLiveStatus() (scheduler) ──┐
           POST /v1/ingest (hook / 自定义 agent) ─┼─► reduce(session, event) ─► sessions Map<key, Session>
           POST /v1/events (旧兼容) ──映射──────┘                         │
                                                                         ├─► SSE 'session'  {op:'upsert'|'remove', session}   // 仅变化时
                                                                         ├─► SSE 'sessions' {items:[summary…]}                // 每 15s + 新订阅者连入时全量
                                                                         └─► 节流写盘 live-sessions.json（≤200 条摘要，2s 去抖，原子写）
```

**状态归约规则（表驱动，必须写成纯函数 `reduce(prev, evt, now) → next` 便于随机序列测试）**

| 当前 \\ 事件 | turn_start | tool_start | permission_request | waiting_input | tool_error / model_error | turn_end(ok) | permission_resolved | 超时 |
|---|---|---|---|---|---|---|---|---|
| idle/done/unknown | working | working | waiting_permission | waiting_input | error | done | — | — |
| working | working | working | waiting_permission | waiting_input | error | done | — | 90s 无活动 → idle |
| waiting_permission | working | working | waiting_permission(叠加) | — | error | done | working（若无其他 pending） | 10 分钟 → idle 并清 pending |
| waiting_input | working | working | waiting_permission | waiting_input | error | done | — | 30 分钟 → idle |
| error | working | working | waiting_permission | waiting_input | error | done | — | 5 分钟 → idle |

不变量（单测断言）：①`pending.length>0` ⇔ `status==='waiting_permission'`；②`done` 只由 `turn_end` 产生且 4s 后自动降 `idle`；③`statusSince` 只在 `status` 改变时更新；④同一 `key` 永不出现两条；⑤`parentKey` 指向的会话被移除时子会话 `parentKey` 置空；⑥时间倒退事件（`at` < 当前 `updatedAt`）被丢弃但计数。

**聚合状态**（驱动宠物层与胶囊）：`aggregate = 优先级(waiting_permission > error > waiting_input > working > done > idle)`，并输出 `counts:{working, waiting, error, done}`。通过现有 `state` 事件增量携带 `live:{aggregate,counts,byAgent}`，**不要**让宠物层自己拉会话表。

### 5.4 增量读取 `TailReader`（`dock/shared/tail.mjs`）

```js
createTailReader(file, { maxChunk: 1<<20, onLine }) → { poll(): {lines, reset}, state:{offset, size, ino, mtimeMs} }
```
- 记录 `offset`；`size < offset`（截断/轮转）或 `ino` 变化 → `reset:true` 从头重读；
- 只消费到最后一个 `\n`，残行保留到下次（防半行解析）；容忍 `\r\n`；单次最多读 `maxChunk`，剩余留给下次 tick（避免主循环阻塞）；
- **zstd 变体** `createZstdFrameTail(file)`：多帧文件追加写入时，按**帧边界**（魔数 `28 B5 2F FD`）记录「最后一个成功解码帧的结束偏移」；半帧解码失败 → 不推进偏移，下次重试；复用 `adapters/dsh/sessions.mjs#decodeZstdFrames` 的逐帧解码逻辑，不要另写。
- 全部读取包 `try/catch`，任何异常 → `{ok:false, reason}`，由 tracker 记退避，**不得抛出到事件循环**。

### 5.5 REST / SSE（`daemon/src/v1.mjs` 新增路由；全部走现有 Host 校验，写操作需 `x-fox-token`）

| 方法 路径 | 说明 | 返回 |
|---|---|---|
| `GET /v1/sessions?agent=&status=&q=&sort=updated\|tokens\|cost\|duration&limit=50&cursor=` | 跨 agent 会话列表（内存表 + 适配器历史合并） | `{ok, items:Session[], nextCursor, counts, aggregate}` |
| `GET /v1/sessions/:key` | 详情（含 turns/tools/models；`key` 需 URL 编码） | `{ok, session, turns, tools, models}` |
| `GET /v1/sessions/:key/context` | 复用现有 context 服务按 sessionId 取 | 同 `/v1/agents/:id/context` |
| `POST /v1/sessions/:key/focus` 🔒 | 聚焦宿主窗口（M5；见 §6.3） | `{ok, method:'foreground'\|'flash'}` |
| `GET /v1/usage/breakdown?by=agent\|model\|vendor\|tool\|session&range=&from=&to=&agent=&currency=` | 下钻聚合（M4） | §8.1 |
| `POST /v1/ingest` 🔒 | 事件注入（M5 扩展为公开协议，M2 先内部使用） | §6.2 |
| `POST /v1/events` 🔒 | **保留**，映射到 `ingest`：`permission-request→permission_request`、`user-prompt→turn_start`、其他类型原样记录 | 同前 |
| SSE `session` / `sessions` | §5.3 | — |

分页游标：`base64url(JSON.stringify({u:updatedAt,k:key}))`，**禁止直接 offset**（会话表是活的）。`limit` 夹在 1..200。所有响应字符串字段经 `redactHome()`；`cwd` 只回 `~` 起头的相对写法。

### 5.6 调度与性能预算

- `LiveTracker` 轮询：有 SSE 订阅者或桌宠可见 → 每 2s；否则 15s；失败指数退避上限 60s（复用 scheduler 思路，**别另写第二套**，把 `createContextScheduler` 抽成通用 `createPollScheduler` 再给两者用，旧行为单测必须全绿）。
- 预算：空闲（无活动会话）CPU 占用 <0.5%，daemon RSS 增量 <30MB；单次增量轮询 p95 <30ms（ZCode 水位查询）、<50ms（WB/dsh 追加 1 行）。soak 里加断言（§9.1）。

---

## 6. M5：权限/提问处理与自定义 agent 接入（pre.3，约 6 人天）

### 6.1 总体原则（硬约束）

1. **默认关闭**：`settings.permission.takeover=false`。关闭时只「通知 + 跳转宿主」，**不阻塞宿主**。
2. **永不提供 always-allow / 本会话都允许**。只有「允许一次」「拒绝」。
3. **fail-open to host**：任何失败（daemon 不在、超时、解析失败、探针证明不支持 allow）→ 钩子 `exit 0` 且不输出决策，由宿主原生弹窗兜底。**绝不能因为 fox-dock 故障让宿主卡死或误放行。**
4. 高风险工具/命令（见 §6.4 规则）：**不支持热键允许**，按钮「允许一次」不是默认焦点，卡片显示 `高风险` 徽标。
5. 预览文本**服务端脱敏**后才下发给 UI/通知（§6.5）。日志里不写预览原文。

### 6.2 `POST /v1/ingest` 协议 v1（公开，可给自定义 agent 使用）

```jsonc
// 请求头：x-fox-token: <从 daemon.lock 读取>；Content-Type: application/json；体积上限 16KB
{
  "v": 1,
  "agent": "zcode",                 // 内置 id，或 /^[a-z][a-z0-9-]{1,23}$/ 的自定义 id（最多 8 个自定义 agent，超出 429）
  "event": "turn_start",            // session_start|turn_start|tool_start|tool_end|waiting_input|permission_request|permission_resolved|turn_end|error|usage
  "sessionId": "ses_abc",           // ≤80 字符，[A-Za-z0-9._:-]
  "turnId": "t_12",                 // 可选
  "at": 1760000000000,              // 可选，默认服务端时间；与服务端相差 >5 分钟将被忽略并记 skew 计数
  "title": "…",  "cwd": "D:\\proj", "model": "deepseek-v4", "provider": "deepseek",
  "tool": "Bash", "toolInput": "rm -rf build/",       // permission_request/tool_*：仅文本预览，服务端截断 400 字并脱敏
  "requestId": "pr_9f2c…",          // permission_request 必填；客户端生成 16–40 字符随机串
  "wait": { "mode": "decision", "timeoutMs": 15000 }, // 仅 permission_request：长轮询等待用户决策（上限 30000）
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0 },   // event=usage
  "cost":  { "amount": 0.0123, "currency": "CNY" }
}
// 响应 200 {ok:true, eventId}；permission_request + wait 时：{ok:true, decision:'allow'|'deny'|'timeout'|'ignored', requestId}
// 错误：400 {ok:false,error:'bad-field:<name>'} | 401 | 403(host) | 413 | 429
```

校验规则（逐条写单测）：未知字段丢弃；字符串先 `slice` 再正则；数字必须 `Number.isFinite` 且 ≥0；`__proto__/constructor/prototype` 键直接丢弃（用 `Object.create(null)` 解析）；`agent` 是内置 id 时 `provenance.origin` 记 `'local-log'`，自定义 agent 一律 `origin:'unknown'`、`kind:'estimated'`（它的数是自己报的，无法验证）；自定义 agent 的金额**不参与跨 agent 汇总**，只在其独立分组展示。限流：令牌桶 50 req/s、突发 100。

随包提供：
- `dock/hooks/dock-hook.mjs`：**零依赖**、单文件；读 stdin JSON、按 `hook_event_name` 映射为 `ingest` 请求；读取 `daemon.lock` 获得端口与令牌；**总耗时硬上限**：非权限事件 300ms 超时放弃（`exit 0`）；权限事件等待 `min(settings 等待时长, 钩子 timeout-3s)`；任何异常 `exit 0`。
- `dock/integrations/zcode-plugin/`：`.zcode-plugin/plugin.json` + `hooks/hooks.json`，只挂 **`UserPromptSubmit`、`PermissionRequest`、`Stop`、`PostToolUseFailure`** 四个低频事件，`timeoutMs`：普通事件 5000、`PermissionRequest` 30000。**不挂 `PreToolUse/PostToolUse`**。用户经 ZCode「插件管理 → 本地市场」安装；向导/关于页提供「复制集成目录路径」。
- `tools/fox-dock.mjs emit --agent <id> --event <name> [--session <id>] [--tool …]`：给自定义 agent 的最小接入示范（等价于 `curl` + 令牌）。

### 6.3 动作中介 `ActionBroker`（`daemon/src/actions.mjs`）与窗口聚焦

```js
PendingAction = { id /*requestId*/, kind:'permission', agentId, sessionKey, tool, preview /*已脱敏*/, risk:'normal'|'high',
                  createdAt, expiresAt, state:'pending'|'allowed'|'denied'|'timeout'|'ignored' }
```
- `create()`：幂等（相同 `requestId` 返回同一对象）；同会话最多 5 个 pending，同 agent 最多 20；超限 → 直接 `ignored`（钩子 fail-open）。
- `resolve(id, decision, via)`：仅 `pending→allowed|denied` 一次；重复 resolve 返回 409；`via ∈ {pet,console,hotkey,notification,timeout}` 写入审计日志（只记 id/tool/decision/via，不记预览）。
- 到期（`expiresAt`）→ `timeout`，SSE `action` 通知 UI 收起卡片并提示「已超时，请在宿主窗口处理」。
- daemon 重启：pending **不持久化**（钩子侧会因连接断开 fail-open）。
- 路由：`GET /v1/actions`（当前 pending）、`POST /v1/actions/:id/resolve {decision}` 🔒、SSE `action {op:'add'|'update'|'remove', action}`。
- 钩子长轮询：`POST /v1/ingest(wait)` 内部 `await broker.wait(id, timeoutMs)`；连接断开要 `AbortSignal` 清理。

**钩子输出（以 M0 P-2 结论为准，两条分支都要写好并测）**
- 分支 A（支持 allow）：`allow` → stdout 输出探针确认的 JSON；`deny` → `exit 2` + stderr「被 fox-dock 拒绝」。
- 分支 B（仅 deny）：`allow` → `exit 0` 不输出（交宿主弹窗；宠物卡片文案变为「已交回宿主确认」且 UI 不显示「允许一次」，只显示「拒绝」「去宿主处理」）。

**窗口聚焦（Win32 桥新命令）**：`bridge.ps1` 增加 `focus <hwndHex>`；C# 内 `Focus(string)`：`IsIconic→ShowWindow(SW_RESTORE=9)`；`GetWindowThreadProcessId` + `AttachThreadInput(当前前台线程, 目标线程, true)` → `SetForegroundWindow` → `BringWindowToTop` → 解除 attach；失败再 `FlashWindowEx`（`FLASHW_ALL|FLASHW_TIMERNOFG`）。返回 `{"ok":true,"method":"foreground|flash"}`。`win32.mjs` 加 `focus(hwnd)`。**安全**：daemon 只允许聚焦「当前已发现的宿主窗口列表」里的 hwnd（`watcher` 最近快照），不接受 UI 传来的任意 hwnd 字符串——路由接收 `sessionKey`，由 daemon 反查窗口：①绑定中的该 agent 窗口里标题包含 `cwd` 末级目录名者优先 ②否则该 agent 的绑定窗口 ③否则该 agent 任一窗口 ④都没有 → `404 {error:'host-window-not-found'}`。注意 `bridge.ps1` 注释约束：**C# 源码区用 ASCII 注释**（PS 5.1 按 ANSI 读无 BOM 脚本）。

### 6.4 高风险判定（`daemon/src/risk.mjs`，纯函数 + 表驱动单测）

`risk='high'` 当：工具名 ∈ {`Bash`,`Shell`,`PowerShell`,`Terminal`} 且命令匹配（大小写不敏感）任一：`rm -rf|rmdir /s|del /f|format |mkfs|dd if=|git push --force|git reset --hard|curl .*\|\s*(sh|bash)|iwr .*\|\s*iex|Invoke-Expression|reg (add|delete)|net user|sudo |chmod -R 777`；或 写/编辑类工具的目标路径位于 `cwd` 之外、或匹配 `~/.ssh|~/.aws|\.env|credentials|id_rsa`；或工具名未知且预览为空。其余 `normal`。规则表放 `risk-rules.mjs`，测试用 ≥60 条正反例。**该判定仅影响 UI 保护措施，不替代宿主权限系统。**

### 6.5 脱敏（`shared/redact.mjs`，M2 起所有预览/错误信息都过它）

按序处理：`sk-[A-Za-z0-9_-]{16,}`、`(?i)bearer\s+[A-Za-z0-9._-]{12,}`、`(?i)(api[_-]?key|token|secret|password|passwd)\s*[=:]\s*\S+`、`AKIA[0-9A-Z]{16}`、`ghp_[A-Za-z0-9]{20,}`、`-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?(-----END|$)`、用户主目录 → `~`。替换为 `「已隐藏」`；最后再截断。单测含 40 条夹带密钥的真实形态样本 + 「不应误伤」样本（普通 hash、UUID）。

### 6.6 全局热键与通知（Electron，`overlay/main.cjs`）

- 现有 `setupHotkeys()` 里的 `globalShortcut.register` 基础上，**仅当存在 pending 时**注册 `permission.hotkeys.allow`（默认 `Ctrl+Alt+Y`）与 `deny`（默认 `Ctrl+Alt+N`），pending 清空即 `unregister`；高风险 pending 时 **不注册 allow**；注册失败（被占用）→ 卡片提示「热键被占用，请点按钮」。
- 桌面通知：`new Notification({title:'ZCode 正在等待确认', body:'Bash · rm -rf build/ …（已脱敏，≤60 字）', silent:false})`；点击 → `focus`。触发条件由 `settings.permission.notify`：`always | whenHidden(默认) | off`；`whenHidden` = 宠物被隐藏（`Ctrl+Alt+F`）或宿主窗口不在前台时。通知文案**不含**完整命令。

---

## 7. 前端规格（M1 组件 + M3 页面 + M5 宠物权限卡）

> 通用约束：只用 `tokens.css` 变量；字号仅 `12/13/14/16/20/24/32/40`；间距 4/8/12/16/24/32；圆角 6/8/12/16/999；过渡 120–200ms；所有交互元素要有可访问名称；`prefers-reduced-motion` 下全部动画关闭；**没有任何 idle 动画**；数字用 `font-variant-numeric: tabular-nums`（`.num` 类，Display 字体族）；中文文案风格：短标签 + 解释型提示，技术词保留英文（Token、Cache、CSV、JSON、API Key、Agent）。

### 7.0 令牌新增（追加到 `tokens.css` 末尾，浅/深共用，只引用已有变量）

```css
:root {
  --st-working: var(--info);
  --st-waiting: var(--warn);
  --st-error:   var(--bad);
  --st-done:    var(--ok);
  --st-idle:    var(--text-3);
  --prov-official-fg: var(--ok-strong);   --prov-official-bg: color-mix(in srgb, var(--ok) 14%, transparent);
  --prov-local-fg:    var(--info-strong); --prov-local-bg:    color-mix(in srgb, var(--info) 14%, transparent);
  --prov-estimate-fg: var(--warn-strong); --prov-estimate-bg: color-mix(in srgb, var(--warn) 16%, transparent);
  --prov-unavail-fg:  var(--text-3);      --prov-unavail-bg:  var(--surface-2);
  --row-h: 48px;
}
@keyframes fd-spin { to { transform: rotate(360deg); } }          /* 仅 working 状态存续期间使用 */
@keyframes fd-nudge { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-4px)} 40%{transform:translateX(4px)} 60%{transform:translateX(-3px)} 80%{transform:translateX(3px)} }
```
> 深色下 `--ok-strong` 等已被重定义为亮色，文字对比度自然满足；仍需 axe 验证。

### 7.1 组件：`SourceTag`（`ui/components/base.mjs` 新增导出）

```
<SourceTag kind="official|local|estimate|unavailable" source="zcode:db.sqlite#model_usage" asOf={ms} note="…" variant="full|dot"/>
```
- **full**：高 20px，padding `0 8px 0 6px`，圆角 999，`gap:4px`，字号 12/500，行高 20px；图标 12×12 `stroke-width:1.75`；底色/字色见 7.0（`--prov-*`）；`unavailable` 额外 `border:1px dashed var(--border)`（不仅靠颜色区分）。
- **dot**：16×16 圆形，仅图标（12px），用于数字旁；`aria-label="数据来源：本地日志"`（完整中文标签），`role="img"`。
- 文案：官方接口 / 本地日志 / 估算 / 不可得；图标：`shieldCheck` / `fileText` / `calculator` / `ban`（需新增，见 7.2）。
- **悬停/聚焦弹出 Popover**（`role="tooltip"`，宽 `min(280px, 100vw-16px)`，padding `8px 12px`，圆角 8，`--shadow-pop`，12px 文本，延迟 150ms，Esc 关闭）：三行「来源：{source}」「读取：{HH:mm:ss}」「说明：{note 或 估算依据}」。键盘 Tab 到 tag 即显示。
- 在 `Stat/Card` 里：`Stat` 新增 `prov` 属性，渲染在 label 同行右端。

### 7.2 图标新增（`ui/components/icons.mjs`，沿用 Lucide 路径、`viewBox 24`、`stroke-width 1.75`、圆头）

`sessions`（Lucide `messages-square`）、`externalLink`（`external-link`）、`shieldCheck`（`shield-check`）、`shield`（`shield`）、`fileText`（`file-text`）、`calculator`（`calculator`）、`ban`（`ban`）、`loader`（`loader-circle`）、`calendar`（`calendar`）、`trendUp`（`trending-up`）、`trendDown`（`trending-down`）、`keyboard`（`keyboard`）、`list`（`list`）、`subtask`（`corner-down-right`）。宠物层不引入 icons.mjs，需要的 4 个状态图标（loader/bell/alert/check）以内联 SVG 字符串写在 `pet.js`（`stroke:currentColor` 同参数）。

### 7.3 图表新增（`ui/charts/svg.mjs`）

- `StackedColumnChart({labels, series:[{key,label,values,color}], height=220, valueLabel, details})`：用于下钻；柱宽 = `min(28, 可用宽/labels.length*0.6)`，柱间圆角 4（仅顶部）；颜色按 `--c1..--c5` 循环，第 6 个起并入「其他」；悬停 tooltip 显示各系列值与合计；`role="img"` + 汇总 `aria-label`。
- `StatusTimeline({segments:[{status,from,to}], height=24})`：横条，段色取 `--st-*`，圆角 6，悬停显示「状态 · 起止 · 时长」。
- `Sparkline({values, width=96, height=28, tone})`：用于统计磁贴与总览。
- `CompareColumnChart`：在现有 `ColumnChart` 上加 `prev` 数组（上周期），以 2px 虚线折线叠加（`stroke:var(--c5); stroke-dasharray:4 3`），图例「本周期 / 上周期」。

### 7.4 导航与路由（`ui/console.mjs`）

最终导航（图标 18px，顺序固定）：

| 组 | 项 | 图标 | testid | 热键 |
|---|---|---|---|---|
| 监控 | 总览 | `dashboard` | `nav.overview` | Ctrl+1 |
| 监控 | **会话（新）** | `sessions` | `nav.sessions` | Ctrl+2 |
| 监控 | 用量 | `chart` | `nav.usage` | Ctrl+3 |
| 监控 | 统计 | `activity` | `nav.stats` | Ctrl+4 |
| 监控 | 额度与余额 | `gauge` | `nav.quota` | Ctrl+5 |
| 管理 | 厂商与密钥 | `plug` | `nav.vendors` | Ctrl+6 |
| 管理 | 角色与气泡 | `smile` | `nav.roles` | Ctrl+7 |
| 管理 | 设置 | `settings` | `nav.settings` | — |
| 底部 | 关于与诊断 | `info` | `nav.about` | — |

- 「上下文」页**移除导航**；`#context` 与 `localStorage['fox-dock.console.page']==='context'` 一律重定向为 `#sessions?tab=context`。`pages/context.mjs` 的内容抽成可复用组件 `ContextPanel`（保留其 testid `context.*`），由会话详情的「上下文」标签挂载。
- 导航项在有待处理事项时右侧显示 16×16 计数徽标（`会话` 项：`waiting_permission + error` 数；`bg:var(--bad)` 当含 error，否则 `var(--warn)`；文字 12/700 白色/`--on-accent`；`aria-label="N 个待处理"`）。
- hash 查询串：`#sessions?select=<key>&tab=overview|turns|tools|context&status=…`；页面内改状态要 `history.replaceState`，刷新可还原。

### 7.5「会话」页（`ui/pages/sessions.mjs`，`data-testid="page.sessions"`）

**页头（72px，沿用 `.page-head`）**：H1「会话」；视角分段（沿用「跟随角色 / ZCode / WorkBuddy / Kimi Code / DeepSeek Harness」）；右侧 `Button secondary`「刷新」(icon `refresh`)。

**内容区（`padding:8px 24px 24px`，12 栏栅格，gap 16）**

```
┌ 待处理横幅（有 pending 才显示；col-12；M5）───────────────────────────────────────────┐
│ ⚠  1 个权限请求等待处理 · ZCode · Bash                         [去宿主处理] [拒绝] [允许一次] │
├ 状态计数条（col-12）────────────────────────────────────────────────────────────────┤
│ ● 工作中 2   ● 等待确认 1   ● 出错 0   ● 今日完成 14                                  │
├ 会话列表（col-7）──────────────────────────────┬ 会话详情（col-5）────────────────────┤
│ [搜索会话…] [状态: 全部▾] [排序: 最近更新▾]      │ 标题 16/600  ● 工作中                 │
│ 状态│会话│回合│Token│成本│耗时│更新                │ [概览][回合][工具][上下文]             │
│ …行高 48px…                                     │ …                                    │
└─────────────────────────────────────────────────┴───────────────────────────────────────┘
```

1. **待处理横幅**：`Card` 变体 `.banner-warn`——`border-left:3px solid var(--warn)`，`background:color-mix(in srgb,var(--warn) 10%,var(--surface))`，高 56，padding `0 16px`，图标 `alert` 18px 色 `--warn-strong`；文本 14/600 +「ZCode · Bash」13 `--text-2`；右侧三按钮（均 32 高）：`ghost`「去宿主处理」(icon `externalLink`)、`secondary`「拒绝」(danger 描边)、`primary`「允许一次」。无 takeover 能力（探针分支 B 或开关关闭）时只显示「去宿主处理」。多个 pending 时文案「N 个权限请求等待处理」，按钮作用于最早一个，后附 `ghost`「查看全部」展开成列表（Dialog，行高 48）。
2. **状态计数条**（`.live-strip`，`Card` 无标题，padding `12px 16px`）：4 个等宽按钮式磁贴（`role="button"`，`aria-pressed` 表示筛选）；每个：高 56；左侧 8×8 圆点（色 `--st-*`）+ 标签 13 `--text-2` + 右侧数字 24/700（`.num`）；选中态 `background:var(--surface-2)` + `border:1px solid var(--accent)`；磁贴间 `gap:8px`。`working` 圆点外加 14px 旋转弧线（`.spin`，`animation:fd-spin .9s linear infinite`，**仅当该状态计数>0**）。
3. **会话列表 Card（col-7）**
   - 标题「会话」+ 副标题计数 12 `--text-3`（「共 38 个 · 显示 12 个」）。
   - 工具条（高 40，`gap:8px`）：`SearchBox` 宽 220，占位「搜索标题 / 路径 / 模型」；`Select` 状态（全部 / 工作中 / 等待确认 / 等待输入 / 出错 / 已完成 / 空闲）宽 136；`Select` 排序（最近更新 / 消耗最高 / 耗时最长）宽 136。
   - 表格列（`table-layout:fixed`，表头高 36，12/600 `--text-3`，sticky 在卡片内滚动区顶部）：

     | 列 | 宽 | 对齐 | 内容 |
     |---|---|---|---|
     | 状态 | 96px | 左 | 圆点 8px + 文案 13；`working` 圆点替换为 14px 旋转弧 |
     | 会话 | 弹性（最小 200px） | 左 | 上行标题 14/600 单行省略；下行 12 `--text-3`：`{Agent} · {model} · {cwd 末两级}` 单行省略 |
     | 回合 | 56px | 右 | 数字 |
     | Token | 88px | 右 | `1.2M` 简写，`title` 给精确值 |
     | 成本 | 96px | 右 | `¥0.43` + 尾随 `SourceTag dot`；多币种只显示主币种 + `+1`；不可得显示「—」+ dot |
     | 耗时 | 72px | 右 | `mm:ss` / `h:mm` |
     | 更新 | 72px | 右 | 相对时间（刚刚 / 3 分钟前 / 昨天） |
   - 行高 `var(--row-h)=48px`，hover `background:var(--surface-2)`，选中 `background:color-mix(in srgb,var(--accent) 12%,transparent)` + 左 3×24 橙条（同侧栏激活样式）；整行 `role="row"` 可聚焦，`↑/↓` 移动、`Enter` 选中、`Home/End`。
   - 子任务：父行左侧 16px chevron（`chevron`，展开旋转 90°）；子行缩进 24px，前缀图标 `subtask` 14px，行高 40，字号同上。默认折叠；有子任务出错时父行右端显示 `Badge bad`「1 个子任务出错」。
   - 滚动区 `max-height:calc(100vh - 360px)`，`min-height:240px`；行数 >100 启用**固定行高虚拟滚动**（上下各预渲染 6 行）。
   - 空态：`EmptyState(icon=sessions, title="还没有会话记录", hint="打开任意受支持的 agent 并发起一次对话后，这里会实时出现。")`；Kimi 视角：`title="Kimi Code 没有会话历史"`, `hint="Kimi Code 只提供套餐窗口和上下文占用，不提供会话历史。"`, `action=「查看套餐额度」`（跳 `#quota`）。过滤后无结果：`title="没有符合条件的会话"`，`action=「清除筛选」`。
4. **会话详情 Card（col-5，sticky：`position:sticky; top:8px; max-height:calc(100vh - 120px); overflow:auto`）**
   - 头：标题 16/600（2 行省略）；下行 `Badge`（状态）+ 12 文本「{Agent} · {model}」；右上 `IconButton`（32×32）`copy` aria-label「复制会话 ID」。
   - `Segmented`：概览 / 回合 / 工具 / 上下文（`role=tablist`，宽 100%，等分）。
   - **概览**：2×2 `Stat`（总 Token / 成本 / 回合数 / 总耗时，`gap:12`，各带 `SourceTag dot`）→ 「状态时间线」小标题 13/600 + `StatusTimeline`（宽 100%）+ 时间轴端点时间 12 → 「最近错误」块（有才显示：`Badge bad` 类型 + 脱敏消息 ≤200 字，12 mono，`surface-2` 底 radius 8 padding 8 12）。
   - **回合**：表（序号 40 / 开始 80 / 耗时 72 / Token 88 / 成本 88 / 状态 64），最多 50 行 + 「加载更多」`ghost` 按钮；错误行状态列 `Badge bad`。
   - **工具**：表（工具 弹性 / 调用 64 / 错误率 72 / 平均耗时 88）+ 每行下方 4px 高占比条（宽 = 调用占比，色 `--c1`）。
   - **上下文**：挂 `ContextPanel`（现有占用环/构成条/趋势图），Gauge 尺寸 120；该会话无上下文数据时 `EmptyState`（沿用 D029 文案）。
   - **底栏**（sticky bottom，上 1px 分隔线，padding 12 0 0）：`Button primary`「跳转到宿主窗口」(icon `externalLink`，宽 100%，高 32)；找不到窗口时 `disabled` + `title="宿主窗口未运行或未被发现"`；成功后 Toast「已切换到 ZCode」；仅闪烁时 Toast「已提醒 ZCode 窗口（系统限制，未能直接切换）」。
5. **响应式**：<1100px：计数条保持 4 列但磁贴高 48、数字 20；列表与详情改为上下堆叠（`col-12`），详情不再 sticky；<860px：表格隐藏「回合」「耗时」两列；<640px 隐藏「Token」。

### 7.6 总览重排（`ui/pages/overview.mjs`，任务导向）

页头沿用。内容区自上而下：

1. **预警条**（保留现有逻辑 `overview.mjs:143-190`，位置不变，在页头下方）。
2. **四块任务卡**（`.grid`，各 `col-3`；`@media (max-width:1279px){ .col-3{grid-column:span 6} }`，即默认 960 宽窗口为 2×2）。每卡 `Card`，最小高 148：
   - **今日成本**：标题行「今日成本」+ `SourceTag dot`；主数字 32/700 `.num`（主币种；多币种在下方 12 文本逐行列出，不求和）；行 2：环比 `Badge`（`trendUp/trendDown` 12px + 「较昨日 +12%」；成本上升 `bad`、下降 `ok`、无上一日数据显示「昨日无数据」neutral）；行 3：`Sparkline`（近 7 天，宽 100%，高 28）。积分口径显示「积分」后缀，**不显示 ¥**。
   - **当前会话**：标题行「当前会话」+ 右侧状态 `Badge`；主文 14/600 会话标题（2 行省略）；12 `--text-3`「{model} · 已运行 12:03」；上下文 `ProgressBar`（高 6，色按占用阈值 `ok/warn/bad`，70/85）+ 右侧 12 `--text-2`「63%」；底部 `ghost` 按钮「查看会话」→ `#sessions?select=`。无活跃会话：`EmptyState compact`（图标 `sessions` 24px，文案「当前没有进行中的会话」）。
   - **待处理**：标题行「待处理」+ 数量；最多 3 行（行高 40）：左图标（`shield`/`alert`）+ 文本 13 单行省略 +（M5 有 takeover 时）右侧两个 28 高小按钮「拒绝」「允许一次」；超过 3 条底部 `ghost`「查看全部 N 条」。空：`EmptyState compact`（图标 `check`，文案「没有待处理事项」）。
   - **预警**：标题行「预警」+ 数量；最多 4 行（行高 36）：图标（`alert` 色按级别）+ 文本 13 +「去处理」链接式按钮 12/500；空：「一切正常」。
3. **近 7 天成本**（`col-7`，柱图高 220，开启「对比上周期」时叠加虚线）+ **额度窗口**（`col-5`，沿用进度条行；每行右端 `SourceTag dot`，并显示「X 小时后重置」）。
4. **厂商余额**（`col-12`，沿用 `vendor-mini-grid`）。
5. **全部 Agent 今日**（`col-12`，沿用表格；新增「状态」列用会话聚合状态，替换原「状态」在线点）。

删除：旧 Hero（96px 头像 + 主数字）、「上下文」卡、三张 `col-4` 指标卡（内容已并入四块任务卡/会话页）。**首屏必须可见：今日成本主数字、当前会话状态、待处理数、预警数。**

### 7.7 用量页深化（`ui/pages/usage.mjs`）

- 工具条（一行，`gap:8px`，窄屏换行）：区间 `Segmented`「今日｜近 7 天｜近 30 天｜自定义」；口径（金额/积分｜Token）；币种 Segmented（沿用）；`Toggle`「对比上一周期」（`aria-label`）；`Button ghost`「CSV」「JSON」（icon `download`）。
- 选中「自定义」时在工具条下方出现一行 `.range-row`（高 48，`gap:8px`）：`<input type="date">`×2（宽 144，高 32，`aria-label`「开始日期」「结束日期」，`max=今天`，`min=今天-365`），「至」，`Button secondary`「应用」。校验：`start>end` 或跨度>366 天 → 输入框 `border-color:var(--bad)` + 下方 12 `--bad` 文本「开始日期不能晚于结束日期」/「范围最长 366 天」，**不发请求**。
- **统计磁贴行**（4 个 `col-3`，窄屏 2×2）：`总成本`、`总 Token`、`日均成本`、`本月预测`（带 `SourceTag`=估算；样本不足显示「—」并 12 文本「样本不足（需 ≥3 个有数据的日子）」）；开启对比时每个磁贴底部显示 delta Badge（规则见 §8.2）。
- 图表卡「每日用量」：开启对比用 `CompareColumnChart`。
- **下钻卡**：标题行 `Segmented`「按 Agent｜按模型｜按厂商｜按工具｜按会话」；其下左 `StackedColumnChart`（col-7）右排名条形榜（col-5，每行：名称 13 省略 / 数值 13 右对齐 / 占比条高 6）；再下「明细」表（沿用，新增列「模型」「厂商」，`来源` 列放 `SourceTag dot`）。「按会话」行点击 → `#sessions?select=`。
- 导出：见 §8.3。导出前如果当前数据含 `estimated` 数值，文件头注释/元数据写明。

### 7.8 统计页（`ui/pages/stats.mjs`）与额度页（`ui/pages/quota.mjs`）

- 统计页：5 个 `.stat-tile` 与 `quality-chip` 全部加 `SourceTag dot`；区间 Segmented 增加「自定义」（复用 7.7 的 `.range-row`）；Kimi / 不支持的宿主：`EmptyState` 文案「Kimi Code 只提供套餐窗口，没有历史用量。」+ 「查看套餐额度」；**禁止用空图伪装**。
- 额度页：工具条末尾新增 `Segmented`「卡片｜矩阵」（默认卡片）。**矩阵视图**：一张全宽表（行=厂商，高 48；表头 36 sticky）：厂商(弹性,图标 20 + 名称) | 余额(112 右) | 5 小时窗(120) | 周窗(120) | 月窗(120) | 重置于(112) | 来源(88)。窗口格内：6px 进度条 + 12 文本「63%」；无该窗口显示「—」（`aria-label="无此窗口"`）；「重置于」：未来 24h 内显示倒计时「3 小时 12 分后」，否则日期「10-25 09:00」；「来源」列 `SourceTag full`。窄屏（<1100）改为横向可滚动**容器内**滚动（页面本身仍不得出现横向滚动）。

### 7.9 设置页新增分组「会话与权限」（`ui/pages/settings.mjs`，锚点列表在「气泡与提醒」后插入）

行布局沿用「标签在左、控件在右」；每行 `min-height:48`；改动立即 PUT，失败回滚并 Toast。

| 行标签 | 控件 | 默认 | 说明文字（12 `--text-3`） |
|---|---|---|---|
| 显示会话状态 | Toggle | 开 | 在宠物与胶囊上显示工作 / 等待 / 出错 / 完成 |
| 接管权限请求 | Toggle | **关** | 开启后权限请求先在宠物上询问；超时自动交回宿主弹窗。仅在已安装集成插件时生效 |
| 接管等待时长 | Select（8 / 15 / 30 秒） | 15 秒 | 超时后由宿主原生弹窗处理 |
| 权限通知 | Select（总是 / 仅宠物隐藏时 / 关闭） | 仅宠物隐藏时 | 桌面通知不包含完整命令 |
| 允许热键 | Input（只读键帽样式，点击后录入） | Ctrl+Alt+Y | 仅在有待处理请求时临时注册；高风险请求不响应 |
| 拒绝热键 | 同上 | Ctrl+Alt+N | |
| 本地事件接入 | Toggle | 开 | 允许本机程序通过 /v1/ingest 上报状态 |
| 接入地址 | 只读文本 + `IconButton copy` | `http://127.0.0.1:{port}/v1/ingest` | 令牌不显示，客户端从 daemon.lock 读取 |
| 会话保留天数 | Select（7 / 30 / 90 天） | 30 | 仅影响 fox-dock 自己的缓存，不删除宿主数据 |

`settings.mjs`（daemon 侧）schema 升到 **3**：新增 `live:{enabled}`、`permission:{takeover,waitMs,notify,hotkeys:{allow,deny}}`、`ingest:{enabled}`、`retentionDays`；`migrate(2→3)` 写默认值；白名单枚举与夹取沿用现有风格；老 schema 文件必须能无损升级（单测）。

### 7.10「关于与诊断」新增表「接入诊断」

列：Agent｜数据源｜实时通道｜最后事件｜状态。「实时通道」取值：`钩子 / 日志尾随 / 本机 HTTP / 无`；「状态」`Badge`：`正常 ok` / `未接入 neutral` / `延迟 warn`（>30s 无事件但有活跃会话）。含「复制集成目录路径」按钮（ghost，icon `copy`）。

### 7.11 宠物层（`overlay/index.html|pet.css|pet.js`）

**红线**：角色立绘**保持静态**。禁止 idle 呼吸/摇摆；状态用「徽标 + 胶囊」表达，唯一允许对角色本体的动效是 `waiting_permission` 到达瞬间的**一次性** `fd-nudge`（`.36s ease-in-out 1 both`，结束后移除 class）和既有按压变形。

1. **胶囊**（`#chip`，高 32、圆角 999 不变）：
   - 左侧点 `8×8` → 按聚合状态：`idle` 灰 `--st-idle`；`working` **替换为 14×14 旋转弧**（`border:2px solid color-mix(in srgb,var(--st-working) 30%,transparent); border-top-color:var(--st-working); border-radius:50%; animation:fd-spin .9s linear infinite`）；`waiting` 点色 `--st-waiting`（静态，不脉动）；`error` 点色 `--st-error`；`done` 点色 `--st-done`（4s 后回 idle）。
   - 两行文案：第 1 行宿主名 12/600；第 2 行主数字 13（沿用）。**状态文字**仅在非 idle 时追加在宿主名后：「ZCode · 工作中」「ZCode · 等待确认」「ZCode · 出错」，12/500，色 `--text-2`；max-width 仍 220，超出省略。
   - **多会话角标**：活跃（working+waiting）≥2 时，胶囊右上角 `16×16` 圆（`top:-6px; right:-6px`），`background:var(--accent); color:var(--on-accent); border:2px solid var(--surface)`，文字 12/700，>9 显示「9+」，`aria-label="N 个活跃会话"`。
2. **角色状态徽标**（`#fox-state`，新元素，`position:absolute; top:6px; left:6px; width:22px; height:22px; border-radius:50%; z-index:21`）：背景 `--st-*`，内联 SVG 图标 14px 白色：`working`=loader（随 `fd-spin`），`waiting`=bell，`error`=alert，`done`=check（4s 后淡出 160ms）。镜像（贴左侧）时徽标换到右上角避开「⋯」按钮：规则 `body[data-mirror="1"] #fox-state{left:auto; right:44px}`（菜单钮占 right:6 宽 32，故右偏移 44）。`idle` 不显示。
3. **快览卡**（`#quick`，宽 320 不变）：在「上下文条」下新增「会话」区：标题 12/600 `--text-3`「会话」；最多 3 行，行高 28，`gap:0`：圆点 8 + 标题 13 单行省略 + 右侧状态 12 `--text-3`；行可点（`role=button`）→ `open-console('#sessions?select=…')`；底部链接式按钮 12/500「打开会话页」。无会话则整块不渲染（不放占位）。
4. **权限卡 `#perm`（M5）**：`position:fixed`，宽 **320**，圆角 16，padding 16，`border:1px solid var(--border)`，`border-left:3px solid var(--warn)`，玻璃背景同 `#quick`，`box-shadow:var(--shadow-pop)`，**z-index 35**（高于 quick 30，低于 menu 40）。定位与 `#quick` 同一套算法（角色侧边居中，放不下翻转，距屏幕边 ≥ 8px），**并避让胶囊与角色**（沿用 `pet-shots` 现有「快览卡不遮挡 fox/chip」断言）。DOM 与排版（flex column，`gap:12px`）：

   ```
   ┌────────────────────────────────────────────┐
   │ 🛡 ZCode 请求权限                    14 秒    │  ← 头：高 24；图标 shield 18px 色 --warn；标题 14/600；右端倒计时 12 --text-3 tabular；多条时倒计时左侧显示 “1/3”
   │ [Bash]  工作区 fox-dock           高风险     │  ← 工具标签：mono 12，surface-2，圆角 6，padding 2px 8px；工作区 12 --text-3；高风险 Badge bad（仅 risk=high）
   │ ┌────────────────────────────────────────┐ │
   │ │ rm -rf build/                           │ │  ← 预览：mono 12/1.5，surface-2，圆角 8，padding 8px 12px，max-height 72（3 行，溢出渐隐），已脱敏
   │ └────────────────────────────────────────┘ │
   │ 去宿主处理            [ 拒绝 ] [ 允许一次 ]   │  ← 底栏：高 32；左侧链接式按钮 12/500 --text-2；右侧两个 32 高按钮，gap 8
   └────────────────────────────────────────────┘
   ```
   - 按钮：「拒绝」`min-width:64`，`border:1px solid var(--bad)`，文字 `--bad-strong`，背景透明，hover `color-mix(var(--bad) 10%)`；「允许一次」`min-width:96`，`background:var(--accent)`，文字 `--on-accent`，600；高风险时「允许一次」改为描边样式（非主按钮），**不默认聚焦**，且热键不可用。点击热区 ≥ 32×32。
   - 预览区右上 `展开`（12/500 链接）→ 展开到 `max-height:200px` 内部滚动；再点收起。
   - 探针分支 B / takeover 关闭：底栏只有「去宿主处理」+「知道了」（`ghost`，点击仅本地收起，不影响宿主）。
   - 倒计时用 `setInterval(1000)` 更新文本（**不用动画**）；归零 → 卡片内容替换为一行 13 文案「已超时，请在宿主窗口处理」，1.5s 后收起（opacity 160ms）。
   - 决策后：卡片收起（opacity+translateY 6px，160ms），胶囊处气泡 2s：「已允许」/「已拒绝」。
   - `role="alertdialog"` `aria-labelledby`（标题）`aria-describedby`（预览）；`aria-live="assertive"` 的隐藏区播报「ZCode 请求权限：Bash」。overlay 窗口不可聚焦，键盘仅靠全局热键。
   - **点击命中**：`#perm` 必须登记进现有命中区域列表（`set-interactive`），卡片外保持穿透——对应测试见 §9.3。
5. **台词/气泡冲突**：权限卡出现时暂停「随机台词」与「消耗气泡」弹出（队列保留，权限卡收起后 600ms 再放），避免叠层。
6. **音效**：权限到达不新增音效（D031：音效随勿扰静音、不做事件音）。

### 7.12 首次接入向导（M6，`ui/components/wizard.mjs`，`Dialog` 变体）

宽 560、最小高 360、圆角 16；三步指示器（12 `--text-3`「1/3 检测」）；页脚按钮右对齐：「跳过」ghost、「上一步」secondary、「下一步/完成」primary（均 32 高）。
- 步骤 1「检测宿主」：4 行（图标 24 + 名称 14/600 + 状态 `Badge`：已安装/运行中/未发现；dsh 路径可「手动选择」ghost 按钮，调用 Electron `dialog.showOpenDialog` 仅选目录）。底部：「发现旧挂件数据，可导入角色/账本/凭据」+「导入」primary（调用 `/v1/import`）。
- 步骤 2「接入方式」：每个已发现宿主一张 `Card compact`：实时通道说明（ZCode：「安装集成插件后可获得权限提醒」+「复制集成目录路径」；其余：「自动读取本地日志，无需安装」）。
- 步骤 3「完成」：摘要列表 + `Toggle`「开机自启」；「完成」写入 `settings.onboarded=true`。
- 首次启动仅当 `onboarded!==true` 且至少发现 1 个宿主时弹；可在「关于与诊断」重新打开。

---

## 8. M4：统计深化后端（约 5 人天）

### 8.1 下钻聚合 `GET /v1/usage/breakdown`（`daemon/src/usage-breakdown.mjs`）

- 入参：`by`（agent|model|vendor|tool|session）、`range`（today|7d|30d|custom）、`from/to`（`YYYY-MM-DD`，按本地时区，经现有 `dayIndexOf`），`agent`（可选）、`currency`（可选，防混币）。**`from>to` 或跨度>366 天 → 400**。
- 出参：
  ```json
  { "ok":true, "by":"model", "range":{"from":"2026-10-01","to":"2026-10-21","days":21},
    "unit":"money", "currency":"CNY",
    "series":[{"key":"deepseek-v4","label":"deepseek-v4","tokens":123,"amount":1.23,"credits":null,"calls":45,"errors":1,
               "byDay":[{"d":"2026-10-01","tokens":1,"amount":0.01}], "prov":{...}}],
    "other":{...}, "total":{...}, "prev": null | {...同结构...},
    "provenance":{ "tokens":{...}, "amount":{...} } }
  ```
- **数据来源**：ZCode 用 SQL `GROUP BY`（model_id/provider_id/session_id/tool_name，按日 `CAST((started_at+offset)/86400000 AS INTEGER)`），**不要把明细行拉进内存**；WB/dsh 通过 `readUsageRows` 流式聚合（上限 20 万行，超出返回 `truncated:true` 并在 UI 顶部提示「数据量较大，仅统计最近 20 万条」）；Kimi → `supported:false, reason:'host-unsupported'`。
- 金额：逐行 `costOfUsage()`（经 `withCostProv`）→ 按币种分组，**绝不跨币种/单位相加**；`credit` 与 `money` 不混在同一 `series`。
- 缓存：key = `by|range|from|to|agent|currency|adapterFingerprint`，TTL 30s；`MAX(rowid)` 指纹变化即失效；custom 范围不缓存超过 5 分钟。

### 8.2 环比与预测（`daemon/src/analytics.mjs`，纯函数）

```js
previousPeriod({from,to}) → {from,to}            // 等长、紧邻之前；today→昨天；7d→前 7 天
delta(cur, prev) → { abs, pct: number|null, dir:'up'|'down'|'flat'|'na' }   // prev===0 或 null → pct:null, dir:'na'（UI 显示「上周期无数据」）
forecastMonth({ days:[{d,amount}], now, tz }) → { ok, value, basis:'trailing7', sampleDays, reason? }
```
- 预测规则：取最近 7 个**自然日**（含今天已过部分不计，只用已完整的日子）中「有数据的日子」≥3 才出值：`value = 本月已发生 + 日均(有数据日) × 剩余天数`；否则 `{ok:false, reason:'insufficient-sample'}`。`provenance = estimated/pricing-table`，`note:'按近 7 日日均外推，不含峰谷与周末差异'`。
- 重置倒计时：`resetsIn(resetAt, now)`，`resetAt` 可能是毫秒数、ISO 串或空串（沿用 `normalizeQuotaWindow` 的形态）；解析失败/过去时间 → `null`（UI 不显示，**不得显示负数或 NaN**）。
- delta 颜色语义：成本/Token 上升 = `bad`，下降 = `ok`；**但**「剩余额度」类指标相反（本期不做）。

### 8.3 导出

- CSV：UTF-8 **带 BOM**；换行 `\r\n`；表头固定：`date,agent,session,model,vendor,tool,unit,currency,amount,credits,tokens,calls,errors,provenance_kind,provenance_origin,provenance_source`；金额保留 4 位小数；**公式注入防护**：任何以 `= + - @ \t \r` 开头的文本单元前缀 `'`；字段含 `,"\r\n` 时双引号包裹并转义。
- JSON：`{ meta:{generatedAt, range, by, tz, appVersion, notes:[…含估算声明…]}, rows:[…], total, provenance }`。
- 文件名：`fox-dock-usage_{from}_{to}_{by}.{csv|json}`；导出在渲染进程由 Blob 触发，**文本不含主目录路径**（`session` 列用标题或 id 前 8 位）。

### 8.4 增量缓存（M4 做内存版，M6 做持久化）

- ZCode 统计：`model_usage/turn_usage/tool_usage` 水位 `MAX(rowid)` 不变 → 直接用上次结果；变化时用「按天桶 + 新增行增量加到当日桶」更新（跨日重算当日与前一日）。
- WB：`FileIndex`：`path → {size, mtime, offset, dayBuckets}`，仅对 `size` 增长的文件用 `TailReader` 读追加部分；删除/缩小的文件整体重算。
- dsh：同上按帧增量。
- 以上均需：与全量扫描结果**逐字段一致**的对账测试（见 §9.1「增量等价性」）。

---

## 9. 测试方案（要做厚；每个里程碑 PR 必须带对应测试）

### 9.0 总体策略

| 层 | 工具 | 入口命令 | 何时跑 |
|---|---|---|---|
| 语法/静态/价目同步/引擎 parity | 现有 | `npm run ci` | 每次提交；CI |
| 单元 | `node:test` | `npm test` | 每次提交；CI |
| 契约/Schema/模糊 | `node:test` + 自写零依赖校验器 | `npm test`（归入 unit） | 同上 |
| 集成（真 daemon、真 Electron、合成宿主库） | `node:test` | `npm run test:it` | 里程碑合并前，需桌面会话 |
| 页面自检（布局/可访问性/axe/几何断言） | Playwright + 本机 Edge | `npm run test:ui` | 同上 |
| 交互 E2E（点击/键盘/SSE 驱动） | Playwright | `npm run test:e2e`（本方案**真正落地** `test/e2e/*.e2e.mjs`） | 同上 |
| 视觉回归（逐像素） | `tools/visual-test.mjs` | `npm run visual` | 同上，基线人工过目后 `visual:update` |
| 宠物层截图 + 几何断言 | `tools/pet-shots.mjs` | `npm run test:pet` | 同上 |
| Electron 真窗口冒烟 | `console-smoke.mjs`（扩展） + 新 `overlay-smoke.mjs` | `npm run test:electron:console` / `test:electron:overlay` | 同上 |
| 性能/基准 | 新 `tools/bench-sessions.mjs` | `npm run bench` | M2/M4 合并前，结果入文档 |
| 浸泡 | `tools/soak.mjs`（扩展） | `npm run soak` | 发版前过夜 |
| 真机清单 | 人工 | TESTING.md §6 + 本文 §9.6 | 发版前 |

`.github/workflows/dock-ci.yml` 目前只跑 check / check:sync / lint / unit / parity。本方案新增的**纯 Node 单元测试全部必须能在 CI（windows-latest，无桌面）下通过**；需要桌面的（集成/UI/Electron/聚焦）标 `@desktop`，在 `tools/run-tests.mjs` 里用环境变量 `FOX_DOCK_DESKTOP=1` 才跑，缺省跳过并打印 `SKIPPED(desktop)`（**不得假绿：汇总里必须列出被跳过的数量**）。

### 9.1 后端单元测试（新增文件；每条都要写正反例）

| 文件 | 覆盖点（最少） |
|---|---|
| `test/unit/provenance.test.mjs` | `prov()` 校验；`normalizeProv` 对 null/数字/未知 kind 的降级；`worstOf` 全排列；`uiLabelOf` 映射表 8 种组合；`unavailable` 必须带 reason 否则降级为 `no-data` |
| `test/unit/provenance-adapters.test.mjs` | **强制性对账**：四个内置适配器在 fixture 数据下，快照/统计/上下文中**每个数值字段**都有 provenance（遍历字段白名单）；缺数据时数值为 `null` 且 `unavailable`（属性测试：随机删字段，永不出现 `0` 冒充缺失、永不出现 NaN）；`withCostProv` 不修改入参且 `engines/pricing.mjs` 字节未变（`check:sync` 兜底） |
| `test/unit/session-model.test.mjs` | `normalizeSession` 对异常输入（字符串数字、负数、巨大字符串、循环对象、`__proto__`）的清洗；`key` 唯一性；字符串长度夹取 |
| `test/unit/live-reduce.test.mjs` | §5.3 状态表**全表驱动**（每个格子一条）；不变量 ①–⑥ 的**随机序列测试**（固定种子，10 万步，同 `state-machine.test.mjs` 风格）；时间倒退事件；子会话与父会话移除 |
| `test/unit/live-tracker.test.mjs` | 注入假适配器 + 假时钟：90s 无活动降 idle、done 4s 降 idle、SSE 只在变化时广播、订阅者连入先收全量 `sessions`、`live-sessions.json` 去抖原子写、重启恢复、`retentionDays` 清理 |
| `test/unit/tail-reader.test.mjs` | 半行不消费；CRLF；文件截断/重建（`reset`）；`maxChunk` 分片多轮读完；空文件；超长单行（>1MB 丢弃并计数）；UTF-8 多字节跨分片边界；并发 poll 串行化 |
| `test/unit/zstd-frame-tail.test.mjs` | 合成多帧文件：追加完整帧；追加半帧（偏移不推进，补齐后恢复）；损坏帧（跳过并告警，不卡死）；与 `decodeZstdFrames` 全量结果等价 |
| `test/unit/zcode-sessions.test.mjs` | 用 `node:sqlite` 现场建库（沿用现有集成测试做法）：会话聚合、`parent_id` 子任务、水位增量、`error` 判定、**P-1 探针确认的 running 取值**；旧版缺 `tool_usage` 表时降级不崩 |
| `test/unit/workbuddy-live.test.mjs` / `dsh-live.test.mjs` / `kimi-sessions.test.mjs` | 合成 jsonl/zstd/HTTP 假服务：working→done、工具未返回、error、无新事件 idle；Kimi 无历史时 `unavailable/host-unsupported` 且**永不返回 working**（除非 P-3 证明有忙闲字段） |
| `test/unit/incremental-equivalence.test.mjs` | **增量等价性**：对同一批合成数据，「全量扫描」与「分 N 次追加+增量更新」的 `buildStats` 结果 `deepStrictEqual`（N=1,2,7,50；含跨日、含乱序追加、含文件轮转） |
| `test/unit/analytics.test.mjs` | `previousPeriod`（月初/年初/闰日）；`delta` 的 prev=0/null/负；`forecastMonth` 样本 2/3/7 天、月末、月初第 1 天；`resetsIn` 的毫秒/ISO/空串/过去时间/非法串；时区固定为 `Asia/Shanghai` 与 `UTC` 各跑一遍（通过 `process.env.TZ` 子进程） |
| `test/unit/usage-breakdown.test.mjs` | 5 种 `by`；`other` 合并；多币种分组不求和；`truncated`；`from>to`/跨度超限 400；与手算黄金值（`test/fixtures/golden/breakdown-*.json`）逐字段比对 |
| `test/unit/export.test.mjs` | CSV BOM、CRLF、转义、**公式注入**（`=1+1`、`+cmd|' /C calc'!A0`、`@SUM(A1)`、前导制表符）、中文/emoji、超长字段；JSON 元信息；文件名清洗（`../`、保留字） |
| `test/unit/redact.test.mjs` | 40 条密钥形态 + 误伤样本；截断在脱敏之后；多段混合；超长输入性能（1MB 文本 <50ms） |
| `test/unit/risk.test.mjs` | ≥60 条正反例（含大小写、拼接、别名、`cwd` 之外路径、`..` 绕过、Windows 与 POSIX 路径风格） |
| `test/unit/ingest-validate.test.mjs` | 每个字段的边界；`v` 缺失/未来版本；体积 16KB±1；**模糊测试**：固定种子 5000 个随机 JSON（含 `__proto__`、超深嵌套、巨大数组、Unicode 控制字符、负数/Infinity）→ 只能得到 `ok:true` 或确定的 4xx，**绝不抛出**；自定义 agent 数量上限；限流令牌桶（假时钟） |
| `test/unit/actions.test.mjs` | create 幂等；resolve 仅一次（二次 409）；到期 → timeout；同会话 5/同 agent 20 上限；断连清理；`wait` 的 `AbortSignal`；审计日志不含预览 |
| `test/unit/settings-v3.test.mjs` | schema 2→3 迁移；未知字段丢弃；枚举夹取；热键字符串白名单（只允许 `Ctrl/Alt/Shift/Win + 字母数字/F1-F24`） |
| `test/unit/hook-script.test.mjs` | **以子进程方式**运行 `dock/hooks/dock-hook.mjs`，喂 stdin：①daemon 不在 → 300ms 内 `exit 0`；②坏 JSON → `exit 0`；③权限事件 + 假 daemon 回 `deny` → `exit 2` 且 stderr 含固定文案；④`allow`（按 P-2 分支断言 stdout JSON 或空）；⑤超时 → `exit 0`；⑥stdout 不含多余键（若走 JSON） |
| `test/unit/win32-focus.test.mjs` | 桥命令协议（用假 `bridge` 子进程）：hwnd 白名单、非法 hwnd 字符串拒绝、`unknown-command` 处理 |
| `test/unit/lint-guards.test.mjs` | 新增静态守卫：`ui/` 无 `innerHTML/eval/new Function`；`pet.css`/`console.css` 中**除** `fd-spin/fd-nudge` 外无 `@keyframes`；`pet.css` 里 `animation` 只出现在带状态选择器的规则中（防止有人给 `#fox img` 加 idle 动画）；日志函数调用点不得传入 `preview/toolInput` |

### 9.2 后端集成测试（`test/integration/*.itest.mjs`，`@desktop`，串行）

1. `sessions-live.itest.mjs`：合成 ZCode 库 + 真 daemon + SSE 订阅；脚本化「插入 model_usage 行 → 插入 tool_usage → turn_usage completed」，断言 SSE `session` 事件**顺序与内容**、`/v1/sessions` 列表与详情、`counts/aggregate`、`retention` 清理。对 WB（追加 jsonl）、dsh（追加 zstd 帧）各一套。
2. `ingest.itest.mjs`：真 daemon：无令牌 401；错 Host 403；超大体 413；限流 429；自定义 agent 出现在 `/v1/sessions`；`/v1/events` 兼容映射；重复 `eventId` 幂等。
3. `permission-flow.itest.mjs`：**真 `dock-hook.mjs` 子进程 ↔ 真 daemon**：allow / deny / 超时 / daemon 中途重启 / 并发 5 个请求 / 同 `requestId` 重放；SSE `action` 事件序列；`ActionBroker` 状态；高风险请求不能经热键通道 resolve（API 仍可，但 `via:'hotkey'` 被拒 403）。
4. `usage-breakdown.itest.mjs`：HTTP 层 5 种 `by`、`custom` 范围、错误码、缓存命中（`X-Fox-Cache: hit|miss` 调试头仅测试环境）。
5. `host-focus.itest.mjs`（`@desktop`，**可能因前台锁偶发失败**，失败时必须输出 `method` 并按 `flash` 回落断言）：用 PowerShell 建一个标题为 `fox-dock-test-host` 的 WinForms 窗口并最小化，调用 `/v1/sessions/:key/focus`，断言 `GetForegroundWindow` 或 `flash`；窗口不存在 → 404。
6. `settings-migrate.itest.mjs`：用 pre.1 产出的 `settings.json` 夹具启动新 daemon，设置无损、接口兼容。
7. `legacy-forward.itest.mjs`：模拟旧挂件向 `/v1/events` 发 `permission-request`，断言映射为 `waiting_permission` 且前端 Toast 事件仍可收到。
8. `overlay-perm.itest.mjs`（真 Electron 浮层 + 夹具 daemon）：pending 到来 → `#perm` 出现；`globalShortcut.isRegistered(allow)` 为真（经 `FOX_DOCK_TEST=1` 暴露的测试 IPC `test:shortcuts` 查询）；resolve 后为假；高风险时 allow 未注册；`#perm` 内点击经真实鼠标事件触发 resolve 请求（夹具记录 POST）；`#perm` 外区域保持穿透（`set-interactive` 状态断言）。

### 9.3 前端测试（重点：可视化验证排版）

#### 9.3.1 夹具与驱动（先做，所有前端测试依赖它）

- `tools/fixture-daemon.mjs` 增加**测试控制端点**（仅夹具使用，不进正式 daemon）：
  `POST /__fixture/scene {name}`（热切换场景）、`POST /__fixture/emit {event,data}`（向 SSE 推任意事件）、`POST /__fixture/clock {now}`（冻结/推进时钟，所有相对时间与倒计时基于它）、`GET /__fixture/calls`（返回收到的写请求，供断言「点击后确实 POST 了什么」）。
- 新增场景 JSON（`test/fixtures/scenes/`）：

| 场景 | 内容 |
|---|---|
| `sessions-live` | 6 个会话覆盖全部 7 种状态；含 1 个有 3 个子任务（其中 1 个 error）的父会话；两个宿主；成本含 `exact/estimate/unavailable` 各种 provenance |
| `sessions-empty` | 无会话（新装） |
| `sessions-kimi-only` | Kimi 视角：无历史 |
| `sessions-many` | 2000 个会话（验证虚拟滚动与性能） |
| `sessions-long-text` | 超长标题（200 字）、超长路径、emoji/CJK 混排、99+ 计数、极大数字（`1.23B` tokens）、0 与 `null` 混合 |
| `permission-pending` | 1 个普通权限请求 |
| `permission-high-risk` | 高风险请求（`rm -rf`），含 3 行以上预览 |
| `permission-queue` | 3 个排队 |
| `permission-observe-only` | 探针分支 B / takeover 关闭 |
| `usage-compare` | 有上周期数据、上周期为 0、预测样本不足三种子场景 |
| `usage-breakdown-multi-currency` | CNY + USD + 积分并存 |
| `quota-matrix` | 8 个厂商：窗口齐全/缺失/错误/已重置/24h 内重置 |
| `provenance-all-kinds` | 四种标签各出现，含 `note` 与超长 `source` |
| `overview-busy` / `overview-idle` | 总览四块任务卡的满载与空载 |

#### 9.3.2 页面自检 `tools/ui-check.mjs`（扩展）

- `PAGES` 增加 `sessions`；移除独立 `context`（保留 `#context` 重定向用例）。视口矩阵由现有 2 个扩为 **3 个**：`1280×800`、`960×680`、`760×560`（最小窗口）。
- 新增**几何断言**（用 `getBoundingClientRect`/`getComputedStyle`，容差 ±1px），失败信息打印选择器与实测值：
  - `SourceTag.full` 高 20、`dot` 16×16；字号 12；
  - 会话行 `.sess-row` 高 48（子行 40）；表头高 36；计数磁贴高 56（<1100 时 48）；
  - 详情卡 `position:sticky`，`top=8`；
  - 总览四块任务卡：≥1280 同行 4 个且等高；<1280 为 2×2；最小高 148；
  - 用量页 `.range-row` 高 48、日期输入 144×32；
  - 权限卡宽 320、按钮高 32、`border-left` 3px、`z-index` 35；
  - **文本不溢出**：对带 `.ellipsis` 的节点断言 `scrollWidth>clientWidth` 时必有 `text-overflow:ellipsis`；对非省略节点断言 `scrollWidth<=clientWidth+1`（抓溢出）；
  - **页面无横向滚动**（`documentElement.scrollWidth<=clientWidth`），矩阵表的横向滚动只允许发生在其自身容器内；
  - **字体**：所有可见文本 `font-family` 解析首项 ∈ `Segoe UI Variable Text|Display|Cascadia Mono`，字号 ∈ 允许集；
  - 数字列 `font-variant-numeric` 含 `tabular-nums`，右对齐。
- **无 idle 动画守卫**：在 `overview-idle`、`sessions-empty`、宠物 `idle` 场景下，`document.getAnimations().filter(a=>a.effect.getTiming().iterations===Infinity).length === 0`；在 `sessions-live` 场景下，无限动画**仅**来自 `.spin` 元素（数量 = 状态为 working 的元素数）；`prefers-reduced-motion: reduce`（Playwright `emulateMedia`）下无限动画数为 0。
- axe：新页面与全部新 Dialog 的 critical/serious 为 0；`SourceTag` 的 Popover 在聚焦时可见（键盘 Tab）。
- `aria-live`：状态变化时 `role="status"` 区域文本更新（SSE 注入后断言）。

#### 9.3.3 交互 E2E（`test/e2e/*.e2e.mjs`，Playwright）

| 用例 | 步骤与断言 |
|---|---|
| 导航与重定向 | 点击 `nav.sessions`；`#context` 直达 → 落在会话页「上下文」标签；Ctrl+2 切页；刷新后 hash 查询串还原选中会话/标签 |
| 列表键盘操作 | 焦点进入表格 → ↑↓ 移动、Enter 选中、Home/End；Tab 顺序合理（搜索→筛选→表格→详情标签→底栏按钮）；Esc 关闭 Dialog 后焦点回到触发按钮 |
| 筛选 | 点击计数磁贴筛选 `aria-pressed`；搜索防抖；筛选无结果的空态与「清除筛选」 |
| 子任务 | 展开/折叠；父行「子任务出错」徽标 |
| SSE 实时 | `/__fixture/emit` 推 `session upsert`：状态点与计数即时变化、详情时间线追加；断线重连（关闭 SSE 再恢复）后列表与服务端一致 |
| 虚拟滚动 | `sessions-many`：DOM 中 `.sess-row` ≤ 可视行数+12；滚动到底再回顶不丢选中；快速滚动无白屏（截图对比） |
| 跳转宿主 | 点击「跳转到宿主窗口」→ `__fixture/calls` 里出现 `POST /v1/sessions/:key/focus`；返回 404 时 Toast 文案正确且按钮恢复 |
| 权限横幅 | 点击允许/拒绝 → 对应 POST；高风险时无「允许一次」主按钮样式；takeover 关闭时只有「去宿主处理」 |
| 用量自定义范围 | 反例：`start>end`、跨度 367 天 → 输入框红框 + 错误文字，**无请求发出**；正例 → 请求参数正确；对比开关改变图表（虚线系列存在） |
| 下钻 | 5 个维度切换，URL/状态保持；按会话行点击跳会话页并选中 |
| 导出 | 拦截下载：CSV 首 3 字节为 BOM，表头与列数匹配，公式注入单元被前缀 `'`；JSON 通过 schema 校验 |
| 设置 | 新分组每一行：改动立即 PUT（断言 `__fixture/calls`）、失败回滚+Toast（夹具返回 500）、热键录入冲突提示 |
| 向导（M6） | 三步流程、跳过、上一步保留状态、完成后不再弹 |
| 双主题 | 以上关键用例各在浅/深色跑一遍（参数化） |

#### 9.3.4 视觉回归（`tools/visual-test.mjs`，核心验收手段）

- 基线矩阵（**入库**，`test/visual/baseline/console/`）：
  - 现有 9 页×2 主题×2 视口 = 36 张（`context` 页并入会话后，用 `sessions` 取代，其 `-context` 标签另拍）。
  - **新增**（每项均 ×浅/深 ×视口 `1280×800`、`960×680`、`760×560` 中指定者）：

| 新基线 | 场景 | 视口 | 张数 |
|---|---|---|---|
| `sessions-live` | 默认选中第 1 条、概览标签 | 3 个 | 6 |
| `sessions-tab-turns/tools/context` | 同上切标签 | 960×680 | 6 |
| `sessions-empty` / `sessions-kimi-only` | 空态 | 960×680 | 4 |
| `sessions-long-text` | 溢出压力 | 960×680、760×560 | 4 |
| `sessions-banner-permission` | 待处理横幅（正常/高风险/仅宿主） | 960×680 | 6 |
| `overview-busy` / `overview-idle` | 总览四块卡 | 3 个 | 12 |
| `usage-compare` / `usage-custom-range-error` / `usage-breakdown-*` | 用量深化 | 1280×800、960×680 | 12 |
| `stats-sourcetags` / `stats-kimi-empty` | 统计页 | 960×680 | 4 |
| `quota-matrix` | 矩阵视图 | 1280×800、960×680 | 4 |
| `settings-live-perm` | 新分组 | 960×680 | 2 |
| `about-ingest-diag` | 接入诊断 | 960×680 | 2 |
| `sourcetag-gallery` | 四种标签×full/dot×亮/暗 + Popover 展开（用 `ui/gallery.html` 扩成**真正的组件画廊**：全部新组件 × 状态 × 双主题） | 1280×800 | 2 |
| `wizard-step1/2/3`（M6） | 向导 | 960×680 | 6 |

  合计新增约 **70 张**；全部基线总数 ≈ 110。
- 比对算法沿用：逐像素 RGBA 绝对差和 >24 计为差异像素，差异比例 >0.1% 失败；尺寸不同直接失败；环境不符 `ENV-MISMATCH` 失败；`data-visual-mask` 遮罩时间/倒计时/相对时间/动画弧（`.spin` 一律加遮罩，且测试前注入 `animation-play-state:paused`）。
- **新增「语义标注截图」**：每张新页面截图旁生成 `*.annot.png`——在页面里用脚本给被几何断言覆盖的关键元素叠加 1px 彩色轮廓 + 尺寸标签（宽×高），供人工/AI 复核「按钮是不是 32 高、卡片是不是 320 宽」。输出到 `test/visual/__shots__/`（不入库），并在 `index.html` 联系表中与基线并排显示。
- **验收流程（编码 AI 必须照做）**：
  1. 先跑 `npm run visual`，预期新增页面基线缺失 → 标记 `NEW`；
  2. 用 Read 工具**逐张打开**新截图，对照 §7 的排版自检（对齐、留白、溢出、深色对比、中文换行）；有偏差先改代码再拍；
  3. 全部满意后才 `npm run visual:update`，并在 PR 描述里贴联系表路径与「已逐张过目」声明；
  4. 对已有页面的任何像素变化必须在 PR 里逐条解释（总览重排属预期）。

#### 9.3.5 宠物层截图与几何（`tools/pet-shots.mjs`，现 14 状态 ×2 主题 ×2 视口 = 48 张）

- 新增状态（命名 `pet-<state>-<theme>-<viewport>.png`）：`chip-working`、`chip-waiting`、`chip-error`、`chip-done`、`chip-multi`（角标 2 / 12→`9+`）、`fox-badge-working/waiting/error/done`、`fox-badge-mirrored`（贴左侧镜像）、`quick-sessions`（快览卡含会话区 3 行 + 超长标题）、`perm-normal`、`perm-high-risk`、`perm-queue`、`perm-preview-expanded`、`perm-timeout`、`perm-observe-only`、`perm-near-edge`（角色贴右下角，卡片需翻转）、`perm-with-quick`（同时打开快览卡，验证不重叠）。合计新增 ≥ 17 状态 × 2 主题 × 2 视口 = 68 张。
- **新增 DPR 维度**：每个新状态额外在 `deviceScaleFactor=1.5` 拍一遍（对应开发机 150% 缩放），共 +34 张；仅做**几何断言 + 截图归档**，不入像素基线（避免跨机漂移），但联系表必须呈现。
- 几何断言（沿用并扩展现有「快览卡不遮挡 fox/chip、fox/quick/menu 不越界」）：
  - `#perm` 不与 `#fox`、`#chip` 相交（容差 0）；与 `#quick`/`#menu` 同时出现时彼此不相交；
  - 所有可交互元素在视口内，距边 ≥ 8px；
  - 宽 320±0；按钮高 32；热区 ≥ 32×32；预览区 `max-height` 72（折叠态）；
  - `#fox-state` 22×22，镜像时不与 `⋯` 菜单钮相交；
  - 胶囊角标 16×16，位于胶囊右上并不裁切；
  - **z-index 序**：`#perm(35) > #quick(30) > bubble(22) > #fox(20)`，`#menu(40)` 最高；
  - **命中区域**：通过浮层暴露的测试函数枚举 hit rects，断言包含 `#perm` 矩形且**不包含**其外部透明区。
- 同样产出 `*.annot.png` 与 `pet-index.html` 联系表。

#### 9.3.6 Electron 真窗口冒烟

- `console-smoke.mjs`：增加会话页与用量自定义范围的文本断言 + 截图 `console-sessions-electron.png`；断言无 JS 异常、`titleBarOverlay` 下内容不被遮挡（页头首元素 `top>=40`）。
- 新 `overlay-smoke.mjs`（`@desktop`）：起夹具 + 真 overlay；驱动状态序列 `idle→working→waiting→permission→done`，每步截屏（用 CDP `Page.captureScreenshot`），断言胶囊文案、徽标存在、穿透/交互切换、**窗口始终在最上层且 `focusable:false` 未被破坏**（点击 `#perm` 按钮后，宿主窗口仍保持前台——用测试宿主窗口检查 `GetForegroundWindow` 未被抢走）。

### 9.4 性能与浸泡

- `bench-sessions.mjs`：①合成 50MB WB jsonl：首次全量扫描耗时、追加 1 行后增量耗时（目标：增量 <20ms，且 <全量的 1%）；②合成 dsh 200 个 zstd 文件；③ZCode 库 50 万行 `model_usage`：`/v1/sessions` p95 <200ms、`usage/breakdown` p95 <300ms；结果写入 `docs/dock/TESTING.md` 的「基准」小节，之后回归 >1.5× 视为失败。
- `soak.mjs` 扩展：模拟 10 个会话每秒各 1 个事件 + 1 个 SSE 订阅者 + overlay + console 同开，跑 10 分钟（过夜 8 小时），断言 RSS 增长 <30MB、句柄数不增长、SSE 无积压（`writableLength` 上界）、无未捕获异常。

### 9.5 安全测试清单（并入 `npm run lint` 与单元/集成）

- 令牌：缺失/错误令牌对所有 🔒 路由 401；`timingSafeEqual`；DNS rebinding（`Host: evil.com`）403；`Origin` 非本地的浏览器请求 403（对 `/v1/ingest`、`/v1/actions/*` 额外校验 `Origin`，防止网页 CSRF 触发允许）。
- **CSRF 专项**：从 `http://evil.example` 用 `fetch(..., {mode:'no-cors'})` 向 `POST /v1/actions/:id/resolve` 发请求 → 必须失败（缺令牌 + Origin 拒绝）。
- 注入：会话标题/错误消息含 `<script>`、`"onload=`、`${}`、RLM/零宽字符 → 页面按文本渲染（Preact 默认转义），E2E 断言 DOM 无该标签；`lint` 守卫 `innerHTML`。
- 路径：`cwd` 返回前缀 `~` 替换；日志/诊断包/导出不含用户名（扫描 `C:\Users\<name>`）。
- 资源：16KB 请求体上限、会话表上限 5000（LRU 淘汰最旧 `idle`）、自定义 agent 8 个、pending 上限；超限行为有测试。
- 权限：「永不 always-allow」——在路由/UI/设置里**没有**该选项（`lint-guards` 搜索字符串 `always` 于 `permission` 相关文件应为 0）。

### 9.6 真机清单增量（并入 TESTING.md §6，发版前人工执行）

1. ZCode 发起一个会触发权限的操作：宠物出现权限卡；点「允许一次」/「拒绝」/热键，宿主行为与预期一致；**超时后宿主原生弹窗仍可操作**；
2. 关闭 daemon 时再触发权限：宿主弹窗**不受影响、无明显延迟**（<300ms 额外开销）；
3. 工作中/等待/出错/完成 四状态在 ZCode、WorkBuddy、dsh 真实对话中各观察一次；Kimi 显示「状态未知」而不是假「工作中」；
4. 「跳转到宿主窗口」在宿主最小化/被遮挡/多显示器（若有）下的表现；
5. 150% 缩放下权限卡与快览卡不越界、不被任务栏遮挡；
6. 与旧挂件共存：旧挂件转发权限事件只出现**一张**卡；
7. 自定义 agent：`tools/fox-dock.mjs emit` 演示脚本能让「custom」会话出现在列表；
8. 会话页 2000 条滚动流畅（肉眼无卡顿）；
9. CSV 用 Excel 打开中文不乱码、公式单元不执行；
10. `verify:context` / `verify:zcode` / `verify:workbuddy` 对账仍通过。

---

## 10. M6：接入向导、增量持久化与便携包（pre.3）

1. **向导**：§7.12；后端 `GET /v1/onboarding`（发现宿主、旧挂件数据、集成插件状态）、`POST /v1/onboarding/complete`。
2. **增量索引持久化**：`%LOCALAPPDATA%\fox-dock\cache\{agent}-index-v1.json`，带 `schemaVersion` 与 `appVersion`；版本不符或校验失败直接丢弃重建；写入原子 + 去抖；单文件 ≤8MB，超出按最久未用淘汰。必须有「删除缓存后结果不变」的测试。
3. **便携包**：在 `tools/pack-release.mjs` 增加 `--portable`：解压即用，包含 `launch\启动 fox-dock.vbs` 与 **内置 Node 运行时检测**（缺 Node 时给出明确提示与官方下载链接，**不静默下载二进制**）；Electron 运行时仍复用现有自管逻辑。沿用 Ed25519 清单签名与 sha256；**不改 `update.json` 的签名机制**。
4. **自动发现与导入**：沿用 `import-old.mjs`，向导里一键触发；导入前后展示条目数；失败可回滚（导入是复制，不动旧数据）。

---

## 11. P2 设计占位（不实现，仅防止现在的设计堵死将来）

- **角色包/气泡包**：本地 zip（`manifest.json` + 资源），Ed25519 签名可选；导入校验沿用 D030（PNG/GIF 魔数、CRC、≤3MB、≤2048²、id 白名单）；**不做在线市场**。
- **跨平台**：先 Windows + WSL（WSL 里的 agent 数据路径经 `\\wsl$\` 只读读取；窗口吸附仍仅 Windows 侧宿主）；macOS 评估期不动 Win32 能力。`ingest` 协议与 provenance 已与平台无关，可直接复用。
- **只读移动看板**：必须**显式开启**、仅 `/v1/*` 只读子集、独立只读令牌、默认仍绑 127.0.0.1（局域网绑定需二次确认）、**服务端 URL 请求只允许 http/https 且拒绝环回/私有/保留目标**（沿用 `blocked-host` 逻辑，Mimosa 约束）、不经过云端。本期不做。

---

## 12. 不要做的事（编码 AI 自查）

1. 不追 20+ agent 数量；自定义 agent 只走 `ingest` 协议，不新增内置适配器。
2. 不做云账号、远程控制、团队协作；不做 AI 陪聊。
3. 不加 idle 呼吸/摇摆/浮动等动画；不加新角色或新台词包。
4. 不改 `dock/engines/{pricing,cmdgo,relays}.mjs`；不改 `main`/`workbuddy` 分支与 `lib/`、`hooks/`、`desktop/`。
5. 不自动写宿主配置；不挂 `PreToolUse/PostToolUse` 钩子；不提供 always-allow。
6. 统计口径未统一前不改版面装饰（M1 必须先于 M3/M4）。
7. 不在日志/诊断/导出/通知里写完整命令、密钥或用户名路径。
8. 不让假数据冒充真数据：缺失即 `null` + `unavailable`，空态必须有文案，禁止空图。

---

## 13. 文档与决策记录（每个里程碑同步提交）

在 `docs/dock/DECISIONS.md` 追加（编号接 D032）：

- **D033** 数据可信度模型：`exact/estimated/unavailable` + `origin` + UI 四标签；包装层在 `daemon/src/cost-prov.mjs`，不动 `engines/` 副本。
- **D034** 会话层与实时状态：统一 `Session` 模型、`LiveTracker` 归约表、增量读取；Kimi 不伪造状态。
- **D035** 钩子纪律：只挂低频事件；钩子永不阻塞宿主（fail-open）；随包集成插件，不自动写宿主配置。
- **D036** 权限接管：默认关、无 always-allow、高风险降级、预览脱敏、Origin+令牌双校验。
- **D037** `ingest` 协议 v1 与自定义 agent（上限、限流、不参与跨 agent 汇总）。
- **D038** 控制台信息架构：保持 9 页，「上下文」并入「会话」；总览任务化。
- **D039** 动画红线：仅状态存续期间的功能性动画；`getAnimations()` 守卫测试。
- **D040** 宿主窗口聚焦：桥新增 `focus`；仅聚焦已发现窗口；失败回落闪烁提醒。

同步更新：`ADAPTERS.md`（契约扩展 + 实时信号矩阵）、`UI-SPEC.md`（§2 令牌/§3 导航/§5 页面要点/新组件）、`TESTING.md`（新命令、新基线数量、桌面/非桌面分层、基准）、`dock/CHANGELOG.md`（2.0.0-pre.2、pre.3 条目）、`dock/README.md`（页面数说明与新能力）、`docs/dock/schemas/*.json`。版本号：`dock/package.json` 与 `RELEASE-NOTES-*.md` 在发版提交里统一改；tag `dock-v2.0.0-pre.2`、`dock-v2.0.0-pre.3`（GitHub prerelease）；`docs/dock/update.json` 的签名由发布流程（`npm run pack` → `npm run sign`）产出，**编码 AI 不得手改签名字段**。

---

## 14. 风险登记与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| ZCode `PermissionRequest` 钩子不能回 allow / 钩子阻塞宿主弹窗 | 中 | 高 | M0 P-2 探针；分支 B 降级；默认关闭；文档如实标注能力边界 |
| ZCode 库没有「进行中」状态 | 中 | 中 | 用「新行活跃度 + 钩子」推断，`statusSource:'inferred'` 并在 UI 悬浮提示「推断」 |
| `SetForegroundWindow` 被系统前台锁拦截 | 高 | 低 | 回落 `FlashWindowEx`，文案如实；集成测试容忍 `flash` |
| 增量读取与全量结果漂移 | 中 | 高 | 增量等价性测试 + 每 60s 校准；任何不一致以全量为准并记 `drift` 计数进诊断 |
| 视觉基线跨机漂移 | 中 | 中 | 沿用 `ENV-MISMATCH` 机制；DPR1.5 不入像素基线；基线只在固定机器生成 |
| 总览重排引起老用户困惑 | 低 | 低 | CHANGELOG 明示；「查看会话」「去处理」入口保留 |
| 会话表过大占内存 | 低 | 中 | 上限 5000 + LRU；`retentionDays`；soak 守卫 |
| 误放行（用户误点允许） | 低 | 高 | 仅「允许一次」；高风险降级；审计日志；默认关闭 |

---

## 15. 给编码 AI 的执行清单（照此顺序推进，每步一个 PR/提交）

1. `M0`：写 4 个探针脚本 → 填 `ADAPTERS.md` 信号矩阵与 3 份 schema → 回头校对本文（有冲突先改文）。
2. `M1`：`provenance.mjs`、`cost-prov.mjs`、契约扩展、四适配器标注、`SourceTag` + 图标 + 画廊 → 单测 `provenance*.test.mjs` → 视觉 `sourcetag-gallery`。
3. `M2`：`session-model` → `TailReader`/zstd 帧尾随 → 各适配器 `getSessions/getLiveStatus` → `LiveTracker`（先抽 `createPollScheduler`）→ 路由与 SSE → 集成测试 → bench。
4. `M3` 与 `M4` 可并行（不同人/不同分支再合并）：
   - M3：夹具控制端点与新场景 → 会话页 → 总览重排 → 宠物状态层 → 导航/路由重定向 → 全套 UI/E2E/视觉/pet-shots。
   - M4：`analytics.mjs`、`usage-breakdown.mjs`、导出 → 用量/统计/额度页改造 → 对应测试与基线。
5. **pre.2 发版闸门**：`npm run ci` + `test:all` + `test:ui` + `test:e2e` + `visual` + `test:pet` + `test:electron:console` + `bench` + 真机清单 1–3、5、8–10 → 打包签名 → 预发布。
6. `M5`（先看 M0 结论决定分支 A/B）：`ingest` 公开化 → `ActionBroker` → `dock-hook.mjs` + 集成插件目录 → 桥 `focus` → 权限卡/热键/通知 → 安全专项测试 → 真机清单全部。
7. `M6`：向导 → 增量索引持久化 → 便携包 → soak 过夜 → **pre.3 发版闸门**（同上 + soak + 清单全部）。

> 所有 UI 数值以 §7 为准；实现中若发现与现有 CSS 冲突（例如已有同名类），**优先沿用现有类名并以 `fd-` 前缀新增类**，不要大面积重命名已有选择器（会让 36 张现有基线无谓失效）。任何偏离本方案的决定，必须写进 PR 描述并回填本文。
