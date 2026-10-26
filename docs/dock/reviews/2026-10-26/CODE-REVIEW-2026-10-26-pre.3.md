# 代码审查报告：dock-pre / pre.3 工作树（2026-10-26）

## 审查范围与方法

- 工作树：`E:\WorkSpace\fox-dock`，分支 `dock-pre`，基线提交 `211c27e`（HEAD），未提交改动 90 项（78 修改 + 12 新增），与派发说明一致（约 88 个 pre.3 主体文件 + 两份审查提示词 + 发布说明）。
- 改动落点核对：全部在 `dock/`、`docs/dock/` 与根 `AGENTS.md`。根 `AGENTS.md` 仅更新分支状态描述（与基线提交 `211c27e` 同一性质，非 1.x 产品代码）；排除清单（`lib/`、`desktop/`、`hooks/`、`skills/`、`.zcode-plugin/`、根 README/CHANGELOG）零改动。`docs/dock/update.json` 未动；`dock/package.json` 版本 2.0.0-pre.3 未在工作树中再改；tag 止于 `dock-v2.0.0-pre.2`。
- 审查路径：先读 AGENTS / DECISIONS（D001–D056）/ ADAPTERS / TESTING / PLAN §0 / UI-SPEC / CHANGELOG / release-notes-pre.3.html / package.json，再按「安全边界 → 凭据 → 权限中介 → 状态口径 → 计价 → 并发/资源 → 测试质量 → 变更卫生」顺序审阅 `dock/daemon/src/`（actions / risk / risk-rules / ingest / v1 / sounds / lock / settings / live-tracker / usage-breakdown）、`dock/hooks/dock-hook.mjs`、`dock/shared/`（session-model / live-reduce / redact / cache-index / tail）、`dock/adapters/zcode/`（sessions / prepaid）、`dock/adapters/workbuddy/sessions.mjs`、`dock/engines/`（副本一致性 + credentials 出站校验 + usage-records/turn-cost 口径）、`dock/overlay/`（main/preload/pet.js）、`dock/console/main.cjs`、`dock/tools/pack-release.mjs`、`dock/ui/`（console.mjs / format / export / perm 相关）。
- 动态验证：临时数据目录真 daemon（`%TEMP%\fox-dock-review-code`、`%TEMP%\fox-dock-review-code2`，均只连 127.0.0.1:lock 端口），两轮共 40+ 条 HTTP/SSE 负例与行为断言（脚本在仓库外 `%TEMP%`，已删除）。本机 39401 端口有**用户真实 daemon** 常驻，全部测试只打临时实例端口（39402），未触碰真实实例与真实数据目录。
- 清理确认：两个临时数据目录、临时脚本、临时大 body 文件均已删除；`git status --porcelain` 仍为 90 项（与审查开始时一致，仅新增本报告文件）。

## 结论

**APPROVE**

未发现 P1 / P2 问题。pre.3 主体（M5 权限接管、M6 向导/增量索引/便携包/语音库、D053/D054/D056）与文档契约一致；三个门禁全绿；高风险路径的安全负例全部按预期拒绝。仅有 2 条 P3 级观察项（均非 pre.3 新增或未被 pre.3 升级），不阻塞放行。

## 门禁结果

| 命令 | 退出码 | 关键输出 | 备注 |
|---|---|---|---|
| `npm run ci` | 0 | check:sync 通过；单元 **564/564**；lint 通过（465 文件：危险 DOM 通道 / toolbar 守卫 / Electron 安全配置 / 凭据扫描）；engines parity 通过（价目 6 组、计费源 7 组、平台用量 1 组） | 首次与门禁批运行合计跑过两遍，结果一致 |
| `npm run test:e2e:pages` | 0 | **37/37**（含权限横幅「允许一次」双开关、静音不回落、向导自启失败不写 settings、刷新重载 settings、2000 条分页等 pre.3 用例） | Playwright + 夹具，一次通过，未复现已知偶发 |
| `npm run test:electron:console` | 0 | 控制台真窗口冒烟通过（页面加载 / 无 JS 异常 / 关键文本 / 截图） | |

## 问题

### [P3-1] SSE `session`/`sessions` 事件的 `cwd`/`title` 未做主目录脱敏（HTTP 面已做）

- 位置：`dock/daemon/src/live-tracker.mjs:304-321`（`sseSummary` 直接 `summarizeSession(session)`，仅剥 pending 的 preview/id）；对照 `dock/daemon/src/v1.mjs:128-165`（`sanitizeSession` 对 `title`/`cwd`/`errors.last.message` 做 `redactHome`，HTTP 列表与详情两处都套用）。
- 期望：`v1.mjs:128` 注释「会话响应统一脱敏：cwd 只保留 ~ 起头的写法」；D036 修订收紧了 SSE 匿名读面的 pending 字段（已实现），但同一条事件里的 `cwd`/`title` 未按同一规则处理。
- 实际：匿名 SSE 订阅者收到完整 `C:\Users\<用户名>\...` 路径，而匿名 `GET /v1/sessions` 收到 `~\...`。
- 复现（临时 daemon，2026-10-26）：
  1. 匿名订阅 `GET /v1/stream`；
  2. 带令牌 `POST /v1/ingest`（`turn_start`，`cwd = <USERPROFILE>\proj\demo`，`title = SSE-REDACT-PROBE`）；
  3. SSE `session` 事件中 `cwd = "C:\Users\paper\proj\demo"`（含原始主目录）；
  4. 同一会话匿名 `GET /v1/sessions` 返回 `cwd = "~\proj\demo"`。
- 证据：上述复现输出（两面对比）；代码路径如上。
- 频率：确定。
- 影响：本机同用户匿名进程可从 SSE 拿到用户名/主目录（HTTP 面已遮蔽的那一份）。与 §6 已知项「匿名读接口会返回会话标题/cwd（设计如此）」相比，增量仅为「主目录未被统一遮蔽」这一不一致；非 pre.3 引入（`sseSummary` 的 cwd/title 行为先于 pre.3），pre.3 也未升级其可达性。
- 建议（非强制）：`sseSummary` 输出前对 `cwd`/`title` 套用与 `sanitizeSession` 相同的 `redactHome`，两个读面同口径。

### [P3-2] `/v1/sounds/:id/file/:slot` 为匿名读面，返回导入音频原始字节

- 位置：`dock/daemon/src/v1.mjs:978-988`（GET、无令牌要求）；数据落在 `%LOCALAPPDATA%\fox-dock\sounds\`（`dock/daemon/src/sounds.mjs:178-183`）。
- 期望：无明确规范；UI-SPEC 描述的播放路径是「主进程持令牌经 IPC 转 Blob」，未承诺该路由对匿名开放或关闭。
- 实际：不带 `x-fox-token` 也可 GET 导入集音频字节。缓解因素：自定义集 id 为 `s` + 12 hex（48 bit 随机，不可枚举）；内置三套为公开素材；同用户进程本可直接读数据目录磁盘文件，未跨权限边界。
- 复现：代码路径 + 路由表（GET 不要求令牌）；未逐字节拉取（依据代码即可判定）。
- 频率：确定（可达性受限）。
- 影响：低。与匿名会话读面同一威胁模型内的一个小口子。
- 建议（非强制）：与 `/v1/actions` 一致要求令牌，或保持现状并在文档标注该路由属匿名读面。

## 安全负例结果

| 入口 | 负例 | 期望 | 实际 | 结论 |
|---|---|---|---|---|
| `GET /v1/state`（裸 TCP） | Host: `evil.example.com:39402` | 403 | `403 bad-host` | ✅（undici 不透传自定义 Host，须裸 socket 才能真正测到） |
| `GET /v1/state`（裸 TCP） | Host: `localhost` / `[::1]` | 200 | 200 | ✅ |
| `PUT /v1/settings` | 无令牌 / 错令牌 | 403 | `403 bad-token`（两种都拒） | ✅ timing-safe 比较（`v1.mjs:78-87,356`） |
| `GET /v1/actions` | 无令牌 | 403 | `403 bad-token` | ✅（D036 修订：读面也要令牌） |
| `POST /v1/actions/:id/resolve` | 无令牌 | 403 | `403 bad-token` | ✅ |
| `POST /v1/maintenance/bridge-restart` | 无令牌 | 403 | `403 bad-token`；带令牌 200 | ✅ |
| `POST /v1/pet/move` | 无令牌 | 403 | `403 bad-token` | ✅ |
| `POST /v1/ingest` | body >16KB | 413 | `413 body-too-large` | ✅ |
| `POST /v1/ingest` | 畸形 JSON | 400 | 400 | ✅ |
| `POST /v1/ingest` | `v:2` / `agent:"x!"` / 短 requestId | 400 | `bad-field:v` / `bad-field:agent` / `bad-field:requestId` | ✅ |
| `POST /v1/ingest` | `wait.mode:"bogus"` | 400 | 400 | ✅ |
| `POST /v1/ingest` | 连发 108 个（令牌桶 100 突发 + 50/s） | 超限 429 | `200×105 → 429` | ✅ |
| `permission_request + wait`（takeover 关） | 应不阻塞、不入 broker | `ignored` + broker 空 | `{"decision":"ignored"}`；`/v1/actions` 空数组 | ✅ fail-open |
| 同 requestId 两次 ingest | 只登记一个 pending | 1 条 | 1 条 | ✅ 幂等 |
| `resolve deny` → 再 `resolve` | 200 → 409 | 一次性 | `200 denied` → `409 conflict`；未知 id `404` | ✅ |
| `resolve`（decision=`explode`） | 400 | 400 | `400 bad-decision` | ✅ |
| `resolve`（via=`timeout`） | 400（不能伪造超时通道） | 400 | `400 bad-via` | ✅ |
| 高风险（`rm -rf`）pending | 登记 `risk=high` | high | `risk:"high"` | ✅ |
| 高风险 `resolve allow`（via=pet） | 403 | 403 | `403 high-risk-host-only` | ✅ daemon 侧拒绝（D036 修订） |
| 高风险 `resolve deny` | 200 | 200 | 200 | ✅ |
| 伪造 `permission_resolved allow`（高风险） | 不产生 allowed | 收起但非 allowed | pending 消失且状态非 `allowed` | ✅ |
| pending 上限 | 同会话第 6 个 | ignored | 同会话恰 5 条 | ✅ |
| pending 上限 | 同 agent 第 21 个 | ignored | 同 agent 恰 20 条；带 wait 的请求返回 `ignored + reason:agent-limit` | ✅ 超限 fail-open |
| 匿名 `GET /v1/sessions` | pending 无 preview/id | 状态字段 only | `pending` 仅 kind/agentId/sessionKey/tool/risk/createdAt/expiresAt/state | ✅（D036 修订） |
| 持令牌 `GET /v1/sessions` | pending 有 preview/id | 有 | `{"id":"...","preview":"echo SECRET_COMMAND_VALUE"}` | ✅ |
| 匿名会话详情 | 同上 | 同上 | 同上 | ✅ |
| SSE `action` 事件（匿名） | 无 preview/id | 仅状态 | add/update/remove 三事件均无 `preview`/`id` 字段 | ✅ |
| `wait` 长轮询 | 1.2s 后 resolve allow | 等待后返回 allow | `decision:"allow"`，dt=1206ms | ✅ |
| `wait` 长轮询 | 无人决策，timeoutMs=1200 | timeout | `decision:"timeout"`，dt=1208ms | ✅ |
| `wait.timeoutMs=600000` | 上限 30s 封顶、不挂死 | 200 受控返回 | 200 | ✅ |
| daemon 设置恢复 | 收尾 takeover=false | 落盘 | `takeover:false` | ✅ |

## 已核对且未发现问题的项

- **钩子纪律与分支 A（D050/D052 修订）**：`dock/hooks/dock-hook.mjs` 任何异常 `exit 0`（`HookExit` + `main().catch`）；deny `exit 2` + stderr；allow 严格输出 `{"continue":true,"decision":"approve"}`；`FOX_DOCK_HOOK_ALLOW=0` 降级；只挂 4 个低频事件（integrations/hooks.json 与 HOOK_TIMEOUT_MS=30000 一致）。时序红线：权限等待 `min(waitMs, 30s − 2s 收尾 − 已用时间)`，stdin 5s 兜底计入总时长（`HOOK_STARTED_AT` 从进程启动起算），最坏路径（stdin 5s + 设置 0.3s + 等待 22.7s）≈ 28.5s < 30s。非权限事件 300ms 预算。`hook-script.test.mjs` 12 条子进程断言（daemon 不在 / 坏 JSON / deny / 分支 A 严格 JSON / 分支 B / takeover 关不等待 / riskLevel 透传 / 8000 字 + 15KB 双预算 / 多字节安全截断）在 `ci` 中全绿。
- **副本逐字节一致**：`cmp dock/hooks/dock-hook.mjs dock/integrations/zcode-plugin/hooks/dock-hook.mjs` 相同；`npm run check:sync` + parity 通过；`dock/engines/{pricing,cmdgo,relays}.mjs` 无手改痕迹。插件目录同时有 `.zcode-plugin/plugin.json` 与根级 `marketplace.json`（`source: "."` directory 自引用），均在 git 跟踪中。
- **高风险判定（risk.mjs / risk-rules.mjs）**：宿主 riskLevel 只升级不降级；MCP 工具按最后一段归一 + 驼峰切词；写工具只查目标路径（键名切词表 + 内容键排除）；相对路径按 cwd 解析后再判越界（`..\..\Windows\hosts` 可判）；rm-rf 分写形态的正则有回溯上界（8000 字输入不爆炸）；判定用未脱敏 riskText（不写库不进 UI，`reduce`/`normalizeSession` 均不透传该字段）。73 条正反例单测在 `ci` 中通过。
- **凭据与脱敏（redact.mjs）**：JSON 凭据键值对（含截断半截值）、`--password x`、`-pS3cret`（含边界：不吞 shell 语法、不误伤 `-print`）、PEM、AKIA/ghp/sk- 全覆盖；主目录四变体替换；会话/详情/诊断包（`v1.mjs:1245-1266` 对 paths/bindings/window/integrationDir 做 `redactHome`）；通知正文只含工具名 + 处理提示（`overlay/main.cjs:441-448`），无 preview/命令原文。测试夹具未发现可用密钥或 PEM 字面量。
- **宿主写入边界**：仅 Kimi OAuth 原子刷新写回（适配器层，本轮 diff 未触及该路径）；向导只读探测 + 复制路径（`/v1/onboarding` 对匿名调用方 `redactHome(integrationDir)`）；`importCategories` 只复制旧数据；音效导入文件名一律服务端生成（`sounds.mjs:7` 纪律），删除用 `path.basename` 防穿越，legacy 导入 id 白名单 `^s[0-9a-f]{4,38}$`。
- **ActionBroker 不变量**：pending 不持久化（`live-sessions.json` 只存会话摘要，重启即 fail-open——单测 + 代码路径）；审计只记 id/tool/decision/via（含 `refused-high-risk`），cap 200；sweep 500ms 定时器 unref、空闲自停；`reset()` 等价重启语义。
- **Electron 双入口**：两处均 `contextIsolation:true / sandbox:true / nodeIntegration:false`；`will-navigate` 拒绝非 file://；`setWindowOpenHandler` 全拒；`overlay/main.cjs` 保留 `type:'toolbar'`（win32）；preload 暴露面最小（setInteractive/setBusy/onHidden/getCursor/getBounds/write/read/readSound/onPermActions/openConsole/hideOverlay/quitDock/hit）；渲染层零 fetch（`pet.js` 无 fetch；`console.mjs` 的 fetch 仅是无 preload 时的浏览器回退，不带令牌，Electron 内恒走 `window.foxDock.api` IPC）；`read-sound` IPC 白名单 setId/slot；权限热键动态注册（`syncPermHotkeys` 每轮换闭包，allow 仅 takeover+allowOnce+非高风险，deny 有 pending 即注册），通知去重 cap 100。
- **显示缩放自愈**：`display-metrics-changed/added/removed` → 500ms 防抖 → 重设窗口 bounds + 缩放变化时 `POST /v1/maintenance/bridge-restart`（持令牌）→ 成功后 `__pet.refit()`，失败 warn 不吞状态；监听器随进程退出释放。
- **控制台崩溃自愈（D055）**：`recoverRenderer` 滑动 60s 计数 + `0/1/3/10/30s` 退避、永不放弃；`render-process-gone`/`unresponsive`/`did-fail-load`（排除 -3）三源触发；`console-crash.log` 追加写；SSE 正常 EOF 也重连；daemon 消失 6 次失败且 lock 不在才退进程。
- **状态口径（D056）**：`displayStatusOf` 优先级（活跃 > workflowBusy > turnActive > done > doneAt 5 分钟窗口 > idle）与决策一致；`doneAt` 由 `setStatus` 在进 done 时记录、回活跃即清；`turnActive` 15 分钟上限由 `expire` 兜底、`db done` 晚于 `turnActiveSince` 才清标记；`workflowBusy` 按 `parent_session_id` 查 `dwf_run`/`workflow_run` 的 running/pending、结束用 `time_updated` 起 5 分钟窗口、`session_task_link` 不作权威、老库无表时 `conn.tables.has` 守卫安全降级；根会话合并（`rootStatusOf`）与计数/筛选/SSE 摘要/详情全部走 `displayStatus`；zcode 会话 `model/provider` 取桶组 `lastAt` 最大者（非 `models.find` 首个）。边界用例（4 分钟/5 分钟±1ms、turnActive 上限、合并优先级）在 `session-display-status`（13 条）与 `zcode-workflow-status`（4 条，含 doneAt 取 workflow 结束时间）中逐一断言。
- **计价口径（D054）**：会话/回合/明细按「模型 + provider + 整点桶」（`CAST(started_at/3600000 AS INTEGER)`）分组、桶内 `MIN(started_at)` 计价；预付判据统一 `isPrepaidBilling`（名字规则 + `resolveBillingSource` Base URL 路径）用于会话列表、回合明细、`aggregateUsage`、`readUsage`；预付行金额记 0、tokens 照算、`costMarket` 单独输出且仅在有差异时给；未收录模型 `null + unavailable` 不补 0（`priceGroups` 的 `unpriced` 分支 + `fmtMoney(null)→"—"` + CSV 空单元格 + `usage-breakdown` 的 priced/unpriced 分桶 + 无币种不冒充）；回合主模型按 token 最大组；混合模型/峰谷边界有 `usage-breakdown.test.mjs`（103 行新增）与 `zcode-sessions.test.mjs`（257 行新增）覆盖。
- **额度分桶（D053）**：`normalizeQuotaBucket` 丢弃总额不可得/负数/空名桶、cap 8；`ui` 快览卡 ≤3 条桶行；汇总百分比保留仅作参考。
- **增量索引（D052/M6）**：`cache-index` 版本/体积失配丢弃、LRU、原子写、写失败保留 dirty 重试且不抛事件循环；WB 消费侧「事件截断 → `eventsComplete:false` → 全量重读」、残行从水位排除、截断重写用 64 字节内容指纹 + ino 识别；`workbuddy-cache-restart.test.mjs`（4 条）+ `incremental-equivalence` 守卫在 `ci` 全绿。
- **出站安全**：所有出站 fetch 站点（balance/plan-balance/glm-plan-api/relays/volc-plan/cmdgo/vendors）统一过 `assertSafeUpstream`（协议白名单、禁 userinfo、主机白名单点号后缀匹配、`isBlockedHost` 环回/私有/保留、重定向 `redirect:'error'`）；Kimi/CommandCode 环回例外仅在各自专用客户端。
- **打包/更新**：`pack-release.mjs` 私钥 PEM 检测拒打包、`.mimosa/.zcode/__shots__` 等整目录跳过（git 侧 `.mimosa/` 亦在 .gitignore）、`--portable` 校验 `launch/` 启动件 + PORTABLE-README（不静默下载 Node）；清单签名沿用 D013 机制，`update.json` 本轮未动。
- **测试质量**：skip 仅环境门控（`node:sqlite` / win32），本机 564 项 0 skip 0 todo；新测试断言到具体值与窗口边界（非「不抛错」型）；夹具合成（临时 sqlite/zstd/jsonl）；e2e 37/37 一次通过。
- **变更卫生**：diff 中无调试残留（唯一新增 `console.log` 为 overlay refit 诊断行，与既有 `window-bounds-actual` 同款、有环境开关语义）；无硬编码本机路径；`dock/package.json` 无新增运行时依赖；版本号、tag、`update.json` 未越权改动。

## 未验证 / 无法验证

- `npm run test:it`（真窗口/真 Electron 集成 80 项）：不在本次要求门禁内，未执行（按 TESTING §5 其用例有已知偶发，判读规则不适用于本次未跑状态）。
- `npm run test:ui`（9 页 × 双主题 axe）：同上未执行；document 无纵向滚动断言已核对进 `ui-check.mjs`（本批新增）。
- 视觉基线 `npm run visual`：本机 Edge 156 与基线环境 Edge 155 不符，按 §5 属环境限制，未跑（绝不 `--update`）。
- `npm run soak` / `npm run bench`：发版前项，时间盒内未执行。
- Kimi OAuth token 原子刷新写回、`update --apply` 签名链路回滚、真实指针/热键/通知：需真实凭据/私钥/真机交互，未触发。
- 「删掉保护逻辑测试会不会红」的变异验证未做：ActionBroker/risk/hook 的关键不变量已用真 daemon 行为负例直接验证（见上表），证据强度等价或更高。
- daemon 重启后 pending 全部 fail-open：以代码路径 + `broker.reset()` 单测佐证，未做真 kill -9 实验（watchdog 拉起会干扰桌面）。

## 与已知低危项的关系

- **ActionBroker pending Map 增长**：未变化。上限 5+20 + TTL sweep + audit cap 200 均实测生效（超限请求返回 `ignored`）。
- **快览卡一次打开多次上移**：未验证（UI 行为，E2E/截图层）；未见 pre.3 改动使其恶化（本批只改了锚点高度计算与「只上不下」规则，方向是收敛）。
- **daemon 崩溃后 lock 残留旧端口**：未变化（本轮 lock.mjs diff 仅注释与 0600 mode，`acquireLock` 接管逻辑未动）。
- **诊断包窗口标题含用户路径**：已改善——`diag/bundle` 的 bindings/window/paths/integrationDir 均套 `redactHome`。
- **匿名读接口返回会话标题/cwd/model/token/成本**：未变化（设计如此）；pre.3 按终审要求收紧了 pending 的 preview/id（HTTP + SSE 两面均验证）。SSE 面的 cwd/title 主目录未脱敏见 P3-1。
- **已知偶发失败**（anchor / 单击角色 / 气泡避让 / restore.itest）：本次 `e2e:pages` 37/37 一次通过，未复现，不构成新发现。
