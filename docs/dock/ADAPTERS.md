# 写一个 fox-dock 适配器

适配器负责两件事：**认出窗口属于哪个 agent**，以及**把这个 agent 的今日消耗读出来**。
两者都不允许猜——认不出就落到 `generic`，读不到就报错，绝不编一个 0 或一个金额。

## 目录约定

```
dock/adapters/<id>/
  index.mjs      适配器定义（match / capabilities / createBilling）
  store.mjs      数据读取（只读宿主的东西，不写）
  ...            其它纯函数模块
```

在 `dock/adapters/registry.mjs` 的 `builtinAdapters` 里注册。**不加载第三方代码**（D006）：
适配器随包发布，匹配规则是声明式的。

## 最小例子

```js
export const myAdapter = {
  id: 'myagent',              // /^[a-z][a-z0-9-]{1,30}$/
  name: 'MyAgent',
  priority: 20,               // 同分时大的优先
  roleDefault: 'fox',         // 绑定后默认换成的角色（fox/whale/gpt/kimi/xiaoke/gemini）
  accent: '#f0a04b',          // 卡片强调色
  match: { exeBasenames: ['myagent.exe'] },
  capabilities: { billing: true, follow: true },

  createBilling(ctx) {
    const now = ctx.now || (() => Date.now())
    return {
      async snapshot() {
        return {
          supported: true,
          unit: 'money',                 // money | credit | percent
          today: { amount: 1.23, currency: 'CNY', byCurrency: { CNY: 1.23 } },
          turn: { amount: 0.28, currency: 'CNY' },
          quota: null,                   // 或 { usedPct, remainingPct }
          balance: null,                 // 或 { amount, currency }
          // 2.0：给面板的通用额度卡（可选）
          quotaCard: {
            kind: 'balance',             // windows | balance | plan | error
            title: 'MyAgent',
            subtitle: '按量付费',
            plan: '',
            account: '',
            windows: [],                 // windows 卡：{ key,label,usedPct,remainingPct,resetAt }
            // 按模型分桶（可选，D053）：同一套餐内按模型分开记账的配额，
            // 与时间窗口不同，不带 resetAt；{ key,label,usedPct,remainingPct,remaining,total }
            buckets: [],
            balance: { amount: 1.23, currency: 'CNY' },
            note: '余额来自官方接口',
          },
          details: [{ label: '今日 tokens', value: '1.2K' }],
          usage: { todayTokens: 1200, turnTokens: 300 },
          plan: '按量',
          account: 'MyAgent',
          source: 'myagent:https',       // 给人看的来源说明
        }
      },
    }
  },
}
```

## 匹配规则

`match` 支持五个维度，**维度之间是 AND，维度内部是 OR**：

| 维度 | 含义 | 例 |
|---|---|---|
| `exeBasenames` | 可执行文件名（大小写不敏感） | `['zcode.exe']` |
| `exeIncludes` | 完整路径的子串（正斜杠、小写） | `['/zcode/']` |
| `titleIncludes` | 标题子串（不敏感） | `['zcode']` |
| `titlePatterns` | 标题正则（RegExp 数组，仅内置适配器） | `[/^ZCode\b/]` |
| `classes` | 窗口类名精确匹配 | `['Chrome_WidgetWin_1']` |

规则：

- **没有任何维度的 `match` 永不命中**——写错的适配器不会变成吞噬所有窗口的兜底。
- 排序是「得分高 → priority 大 → id 字典序」，与数组顺序无关。
- 优先用 `exeBasenames`，别用标题：标题里有项目名，用户一改就抖。

## 返回值契约

所有返回值都会过 `adapters/contracts.mjs` 的 `normalizeSnapshot`：

- `unit` 只能是 `money` / `credit` / `percent`，否则 `ok:false`
- 金额必须是有限数字；`byCurrency` 用来保留多币种，**不做汇率换算**
- 百分比夹到 `0..100`
- `supported:false` 时所有数值清空（`generic` 用）
- 抛异常会被兜住并记成 `ok:false` + `error`，不影响 daemon

## 缓存与频率

`daemon/src/billing.mjs` 统一做 **3 秒 TTL + 并发合并**。所以：

- 适配器会被每 3 秒调一次（浮层与面板同时问也只读一次盘）
- 失败**不缓存**，下一次立刻重试
- 网络接口应做**短 TTL 的内部缓存**，否则每 3 秒打一次官方接口：
  Kimi 额度 60s、DeepSeek 余额 30s、dsh 会话扫描 15s。
- 读大文件（如 transcript / 多帧 zstd）在适配器内部按 mtime 或当天记忆化。

## 凭据与写入边界

- **默认只读宿主**：ZCode sqlite 用 `readOnly: true`，WorkBuddy/dsh 的会话日志只读。
- **Kimi Code 是唯一例外**：它的 OAuth access token 只有 15 分钟，适配器必须在过期时
  用宿主自己的 refresh_token 刷新，并**原子写回同一个凭据文件**（否则 refresh token
  轮换后宿主会掉登录）。刷新只写 `~/.kimi-code/credentials/kimi-code.json`，
  不复制到 dock 配置、不打印 token。
- **不要在 dock 里另存密钥**：dsh 适配器只从 `~/.dsh/.credentials.yaml` 或
  `DEEPSEEK_API_KEY` 环境变量读取；需要授权的能力（如 GLM 套餐查询）宁可不做（D008）。

## 测试要求

一个适配器至少要有：

1. `test/unit/<id>-adapter.test.mjs`：用**临时合成的数据源**（sqlite / jsonl / zstd）验证
   - 今日聚合（含边界：昨天、零 token、非 completed、跨午夜）
   - 预付/订阅行的处理
   - 上一轮/配额口径（多窗口、单窗口、余额、Free 降级）
   - 数据源缺失 / 网络失败 / 坏数据时返回可读错误
   - 凭据过期/刷新/并发刷新（Kimi）
   - 多帧 zstd 与 subagent 会话（dsh）
2. `test/integration/billing.itest.mjs` 里加一条：HTTP 链路能拿到该口径
3. 浮层：`test/integration/overlay.itest.mjs` 覆盖额度卡、角色映射、主题、未绑定识别列表
4. 真实数据对账工具（强烈建议）：`tools/verify-<id>.mjs`，用宿主自己的实现或接口当基准，
   逐日比较金额与 tokens，容差写死在脚本里。

## 全厂商页与适配器的边界

「厂商」页**不是**一个新的适配器：它复用同机挂件线已经跑着的服务。

- dock 在 39321–39330（可用 `FOX_DOCK_VENDOR_PORTS` 覆盖）里探测 `/whale/health`；
  `app=zcode-fox-widget` 映射到 zcode，`app=fox-widget` 映射到 workbuddy。
- 读对应服务的 `/whale/vendors.json`，只保留 id/name/kind/currency/available/balance/
  percentRemaining/monthly/fiveHour/weekly 等展示字段，**丢掉 keySource/keyMasked**。
- 只连 127.0.0.1，端口来自白名单；30 秒缓存，健康探测 10 秒缓存。
- 这样不需要把 35 家厂商的密钥发现、接口差异、签名校验在 dock 里重写一遍；
  挂件线更新厂商模板，dock 自动跟上。挂件线没运行时，厂商页明确降级为「未找到服务」。

适配器仍然负责「这个窗口是谁、它自己的今日/余额是多少」；厂商页负责「这台机器上
已经配置的所有厂商余额/套餐」。两者在 UI 上分开，不混算。

## 已知的两个坑（都踩过）

- **跨午夜**：一轮 agent 循环可能从前一天跑过 0 点。按事件归日会把一轮劈成两半，
  必须**按轮归并、按轮首事件归日**（D009）。
- **尾部截断**：大 transcript 只读尾部会系统性低估。默认窗口 32MB，
  并在结果里如实标记截断条数，不要假装完整。

## 上下文契约（2.0）

适配器在 `capabilities` 里声明 `context: true`，并实现：

```js
getContext({ now, session, range })   // → ContextSnapshot | Promise<ContextSnapshot>
listSessions({ limit })               // → SessionSummary[]
```

`ContextSnapshot` 由 `adapters/contracts.mjs` 的 `normalizeContext()` 统一兜底：

- `supported=false` 时必须带 `reason ∈ not-running | no-session | no-data | auth | schema`；
- `used/limit` 读不到就不给，**不要补 0**；
- `pct` 只能由 `contextPct(used, limit)` 计算，适配器不得自己写 `/ limit * 100`；
- `points` 是宿主能给出的历史（旧→新，≤240 点）；daemon 会再按会话采样补齐；
- `breakdown` 缺项不补；`compaction.derived=true` 表示是推测（宿主只给了时间或启发式）。

取数口径与 schema 见各适配器 `context.mjs` 顶部注释；真机对账用
`npm run verify:context`（Kimi 没有运行中的会话时输出 `SKIPPED`，不算通过）。

## 用量统计契约（2.0）

适配器在 `capabilities` 里声明 `stats: true`，并实现：

```js
getStats({ range, now, since, until, tzOffsetMs, timeZone })
// → StatsSnapshot | Promise<StatsSnapshot>
```

统一结构由 `adapters/stats.mjs` 的 `buildStats()` 产出。各宿主的数据源：

| 宿主 | 数据源 | 能给出的维度 |
|---|---|---|
| ZCode | `cli/db/db.sqlite` 的 `model_usage` / `turn_usage` / `tool_usage` | token、模型、工具、回合、TTFT、错误率、连续天数、热力图 |
| WorkBuddy | `~/.workbuddy/projects/**/*.jsonl` 的 `providerData.rawUsage` 与工具事件 | token、积分、模型、工具、回合 |
| dsh | `~/.dsh/sessions/**/session*.jsonl(.zstd)` 的 usage / turn / tool 事件 | token、按峰谷价折算的金额、模型、工具、回合 |
| Kimi Code | 只有套餐额度窗口，没有本地逐日历史 | 返回 `supported:false`，统计页引导到「额度与余额」 |

硬性约定：

- 日界按本地时区；`range` 只支持 `all | 7d | 30d`，7 日/30 日按“现在往前 N×24h”取区间（首日可能是半天）。
- 读不到的维度不补 0；`supported:false` 时带可读 `reason`/`note`。
- 空数据不要伪造热力图或模型占比；卡片显示空态。
- 统计查询不能拖垮今日/上一轮快照：ZCode 的统计连接与快照连接分开，老库缺 `tool_usage` 时只降级统计。

## 会话契约（2.0-pre.2，D034）

适配器在 `capabilities.sessions` 里声明能力，并实现对应方法：

```js
capabilities.sessions = { list: true, detail: true, live: true, archived: true, actions: [] }

getSessions({ range, limit, cursor, sort, status, q, archived, now })
  // → { ok, supported, reason?, items: Session[], nextCursor: string|null,
  //     keys?: string[], total?, shownRoots?, rootTotal?, truncated? }
  // archived: 'exclude' | 'only' | 'all'（默认 exclude）；归档是父会话属性，
  // 子会话没有自己归档时必须随父；cursor 用 (排序值, key) keyset，不要求
  // 锚点会话的 updatedAt 与游标逐字段相等；total/rootTotal 只计根会话。
  // keys = 过滤后的全部会话 key（含子会话，不受游标/分页影响），供实时层
  // 计算「适配器不认识的 hook-only 会话」，避免 total 重复或漏计。
getArchivedKeys({ now })                    // 可选，需 capabilities.sessions.archived
  // → { ok, supported, keys: string[] }   自身或任一祖先已归档的 key（子会话随父）
  // LiveTracker 用它把内存里归档前的副本按归档处理，避免已归档会话回到「当前」。
getSessionDetail(sessionId, { now })
  // → { ok, session, turns: Turn[], tools: ToolRow[], models: ModelRow[] }
getLiveStatus({ now, sinceMs })
  // → { ok, supported, items: Session[] }   仅近 10 分钟有活动者
readUsageRows({ since, until, timeMinutes, now })
  // → { ok, rows: UsageRow[], truncated }   供 M4 下钻（Kimi 返回 host-unsupported）
  // timeMinutes = 本地 0..1439 分钟；给了就只返回该分钟的行（用于 P0-3 时间过滤）
readToolUsageRows({ since, until, now })
  // → { ok, rows: UsageRow[] }              工具行只贡献 calls/errors
aggregateUsage({ by, since, until, now })   // 可选：ZCode 用 SQL 聚合，不拉明细行
```

软校验：声明了 `sessions` 就必须有 `getSessions()`；`detail:true` 必须有
`getSessionDetail()`；`live:true` 必须有 `getLiveStatus()`，否则拒绝注册。
旧的 `listSessions({limit})` 保留，只服务「上下文」面板。

`Session` / `Turn` / `ToolRow` 的完整字段与 JSON Schema 见
[`schemas/session.v1.json`](./schemas/session.v1.json)。硬规则：

- 所有数值 `number|null`，禁止 NaN / 字符串数字 / 负数；
- `key = ${agentId}:${sessionId}`，全局唯一；`parentKey` 只用于子任务；
- 缺失不补 0：Kimi 没有历史时 token/cost 全 `null`，provenance 为
  `unavailable/host-unsupported`，**不得伪造 working**；
- `statusSource ∈ hook|db|log|http|inferred|ingest`；推断出来的状态在 UI 上
  标「推断」。

## 可信度标签（2.0-pre.2，D033）

每个金额 / token / 百分比携带 `provenance`：

```js
{ kind: 'exact'|'estimated'|'unavailable',
  origin: 'api'|'local-db'|'local-log'|'pricing-table'|'user'|'unknown',
  source, asOf, note?, reason? }
```

- 快照：`normalizeSnapshot` 输出 `provenance:{today,turn,balance,quota,usage}`；
- 上下文：`normalizeContext` 输出 `provenance:{used,limit}`（`builtin-table`
  → estimated/unknown，note「内置窗口表」）；
- 统计：`buildStats` 输出 `provenance:{tokens,cost,credits,models,tools,turns}`；
- 账本行：`summarize` 的 `adapters[]` 带 `prov`；
- 价目折算：新建 `daemon/src/cost-prov.mjs#withCostProv()` 包装
  `costOfUsage()`，**不改 `engines/{pricing,cmdgo,relays}.mjs`**。

UI 四标签：official / local / estimate / unavailable，映射规则在
`shared/provenance.mjs#uiLabelOf()`。

## 实时信号矩阵（2.0-pre.2）

> 探针脚本：`tools/probe-zcode-db.mjs`、`probe-zcode-hook.mjs`、
> `probe-kimi-status.mjs`、`probe-win32-focus.mjs`（只读、不入 CI）。
> 2026-10-22 在本机 ZCode 库实测结论列在表后。
>
> **P-2 真机结论（2026-10-25，模式切换探针 + 用户真机实测）**：
> ① stdin 双别名（tool_name/toolName、tool_input/toolInput、session_id/sessionId、
> hook_event_name/hookEventName），另带 requestId/riskLevel/permission_mode/turnId/
> traceId/toolCallId/cwd/reason；② stdout 表达 allow 只有 `{"continue":true,"decision":"approve"}`
> 被采信（hookSpecificOutput / 扁平 permissionDecision / decision.behavior 均无效，
> 严格 schema 多余键作废）；③ deny 走 exit 2 + stderr（文案透传给 agent），
> stdout deny 不被采信；④ 原生确认卡片阻塞等待钩子（非并行）；⑤ exit 0 无输出
> → 原生弹窗照常出现（fail-open 兜底成立）。dock-hook.mjs 已按此实现（分支 A
> 为默认，FOX_DOCK_HOOK_ALLOW=0 可降级），`settings.permission.allowOnce` 默认 true。
> ⑥ 高风险判定（D036）用「宿主 riskLevel（只升级、不降级）∪ 本地规则表」，且输入是
> 更长的脱敏文本而非展示用的 400 字预览（长前缀不能掩盖危险命令尾）；MCP 工具按
> 最后一段归一：`mcp__<server>__write_file` 等按写工具检查路径，`run_command` /
> `execute_shell` / `shell:bash` / camelCase 的 `runCommand` 等按 shell 规则检查命令
> 文本（保留原始大小写切词，不在判定前整体小写）；写工具的路径字段按
> 「驼峰/分隔符切词」识别（`file_path`/`destination_file`/`dest_path`/`writePath`/
> `savePath`/`localPath`/`pathToSave` 等都算目标路径），写入正文（content/text/…）
> 不当路径；绝对路径直接消解 `.`/`..` 再比 cwd，相对路径先按 cwd 解析再消解
> （`..\..\Windows\hosts` 这类可判定的越界目标不能漏判，cwd 内的普通相对路径
> 保持 normal）；钩子侧 `PermissionRequest` 的 tool_input 按「8000 字符 + 15KB」
> 预算上报，长前缀不能掩盖危险尾命令。
> 钩子上报 PermissionRequest 时按「8000 字符 + 序列化后 15KB」双上限携带 tool_input
> （ingest 仍有 16KB body 上限），不再先截到 2000 字——否则长前缀后的危险命令在
> daemon 判定前就被切掉。

| 宿主 | working | waiting_permission | waiting_input | error | done | 信号来源 | 延迟 | 可信度 |
|---|---|---|---|---|---|---|---|---|
| ZCode | `tool_usage.status='running'`；或最近 20s 有新行且回合未完成 | 钩子 `PermissionRequest` / `/v1/ingest` | 钩子 / ingest | 最新 `model_usage.status='error'` 且之后无新行 | `turn_usage.status='completed'`；4s 内 done，之后 idle | 库轮询 + 低频钩子 | 2s（有订阅）/15s（空闲） | 库：exact；无钩子时的 working：inferred |
| WorkBuddy | `function_call` 无对应 `function_call_result`；或 90s 内有新事件 | 钩子 / ingest | 钩子 / ingest | 最后一个 result.status ≠ completed | 4s 内的最后事件 | transcript 尾随 | 2s/15s | log（状态为 estimated/inferred） |
| dsh | `turn/start` 后无 `turn/end` | 钩子 / ingest | 钩子 / ingest | `tool/result.error != null` | `turn/end.reason.kind='completed'` | zstd 帧尾随 | 2s/15s | log（状态为 estimated） |
| Kimi Code | **不提供**（固定 unknown） | 不提供 | 不提供 | 不提供 | 不提供 | 本机 HTTP `/sessions` | 轮询 | unavailable/host-unsupported |

### P-1 实测（2026-10-22，本机 `~/.zcode/cli/db/db.sqlite`）

- `session` 有 `parent_id` / `directory` / `time_created` / `time_updated`；
- `model_usage.status`：`error | completed | cancelled`；
- `turn_usage.status`：`error | completed | cancelled`；
- `tool_usage.status`：`completed | error | running` → **working 可直接由库判定**；
- 结论：ZCode 的 `working` 优先用 `tool_usage.status='running'`，没有时再退回
  「最近 20s 有活动 + 回合未完成」的 inferred，与本方案假设一致。

### P-2 / P-3 / P-4 状态

- **P-2（ZCode 钩子能否回 allow）**：脚本与最小集成插件示例已就绪；
  `--payload` 本地链路已实测（stdin JSON 完整到达、`exit 0`、stdout 可写）。
  ZCode 安装包内可检索到权限决策 schema（`decision: allow|deny|escalate|modify`），
  但 `PermissionRequest` 钩子的 stdout 是否采用它仍需真机安装 `fox-dock-hook-probe`
  验证；M5 按 allow / 仅 deny 两条分支实现，默认 fail-open to host。
- **P-3（Kimi 忙闲字段）**：本机 Kimi 本地服务未运行，探针返回 `fetch failed`；
  当前实现固定 `status:'unknown'`（host-unsupported），不伪造 working。
- **P-4（Win32 聚焦成功率）**：`bridge.ps1` 已新增 `focus <hwnd>`（前台失败回落
  `FlashWindowEx`）。2026-10-22 真机执行 `probe-win32-focus.mjs --repeat 3`：
  **foreground 3/3（100%）**，无需默认降级；仍保留 flash 回落。
