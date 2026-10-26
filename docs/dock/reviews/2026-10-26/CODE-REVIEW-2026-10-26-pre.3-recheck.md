# 复审报告：pre.3 整改核对（2026-10-26 晚）

对应整改记录：`FIXES-2026-10-26.md`（§2 代码审查两条 P3、§3 用户补充问题的后端部分、以及 UI 整改中触及共享层/主进程的项）。
基线：`dock-pre` @ `211c27e` + 整改后工作树（99 项未提交，较上轮审查 +9）。

## 结论

**APPROVE**（整改确认）

上轮两条 P3 均已修复并在真 daemon 上复测通过；整改中新触及后端/共享层/主进程的逻辑（`permission_resolved` 续命、cancelled 回合口径、D057 输入探针与 SSE 代理、GLM 0% 补试订阅）实现正确、有测试与决策记录支撑；三个门禁复跑全绿，数字与整改记录声称一致。本轮新增 1 条 P3（单元测试临时目录泄漏，非本轮引入，不阻塞放行）。

## 门禁结果（复跑）

| 命令 | 退出码 | 关键输出 | 与整改记录比对 |
|---|---|---|---|
| `npm run ci` | 0 | 价目副本同步 ✅；单元 **569/569**；lint；engines parity ✅ | 一致（569） |
| `npm run test:e2e:pages` | 0 | **50/50** | 一致（50） |
| `npm run test:electron:console` | 0 | 冒烟通过 | 一致 |

## 逐项核对

### 上轮 P3

| 项 | 代码 | 运行时复测 | 结论 |
|---|---|---|---|
| P3-1 SSE cwd/title 未脱敏 | `live-tracker.mjs#sseSummary` 对 title/cwd 套 `redactHome`；`redactHome` 抽到 `shared/redact.mjs`（v1.mjs 改为 import，两个读面同一实现） | 匿名 SSE 注入 `cwd=<USERPROFILE>\proj\demo`、title 含主目录：事件里 `cwd="~\proj\demo"`、title 为 `t-~\secret`，全事件无原始主目录 | ✅ 修复确认 |
| P3-2 sounds 匿名读面 | `v1.mjs` sounds file 路由先 `timingSafeEqual` 令牌校验（与 `/v1/actions` 同口径） | 匿名 403 `bad-token`；错令牌 403；带令牌 + 不存在 id 404 `sound-not-found`；带令牌 + 内置 duck/press 200（6370B, audio/mpeg） | ✅ 修复确认 |

### 整改中触及后端/共享层的项

| 项 | 代码核对 | 测试 | 结论 |
|---|---|---|---|
| permission_resolved 续命 turnActive（UI 审 P1-3） | `live-reduce.mjs:195-208` resolution 先 `touchTurn` 再清 pending | `session-display-status.test.mjs:175`「第 16 分钟仍工作中、静默 15 分钟才回落」边界用例 | ✅ |
| 手动停止一直「工作中」（用户问题 3） | 适配器：cancelled + 有结束时刻 → 直接 idle（db），不再被 holdModel 撑 10 分钟；doneAt 仅 completed 回合记录（cancelled/error 落 null）。合并层：`mergeSnapshot` 新增 `dbTurnEnded`（`statusSource='db'` 且 `endedAt ≥ turnActiveSince`）清 `turnActive`，cancelled 与 completed 都覆盖 | 新增 `zcode-cancelled-status.test.mjs`（合成 SQLite，3 条）：idle + doneAt=null + endedAt 供清 turnActive + 1 分钟后仍非「已完成」+ 筛选只在空闲；含「最后一笔 model 行晚于 completed_at」的 holdModel 陷阱场景 | ✅ |
| D057 SSE 主进程代理 + 输入探针（用户问题 1 / UI 审 P2-2/P2-5） | `overlay/main.cjs` 持令牌订阅 `/v1/stream`、分帧解析、`stream-event` IPC 转发、断线重连；preload `onStream`（可解绑）；`pet.js` 生产路径零 EventSource（仅无 preload 的浏览器测试回退）；30s `probeInput` DOM 命中纠正 `setIgnoreMouseEvents`，5s 竞速超时，连续两拍失败才 reload；决策记录 D057 已落 | `pet-status` E2E 在 50/50 内；真机探针留发版前人工项（与整改记录一致） | ✅ |
| GLM 0% 补试订阅接口（1.x issue #14 迁移） | `plan-balance.mjs`：仅当日志源新鲜且 `percentRemaining<=0` 时补试一次直连接口（自带 TTL 缓存），**接口有剩余才改用**，两边都空保留日志 0%；出站仍走 `assertSafeUpstream` 白名单；byModel 丢失的代价已在注释与决策口径内 | ci 内 engines 相关单测通过 | ✅（保守取向，不造假数） |

### 回归抽查（真 daemon，临时数据目录）

`GET /v1/actions` 匿名 403 ✅；`PUT /v1/settings` 匿名 403 ✅；高风险 `resolve allow`（via=pet）仍 403 `high-risk-host-only` ✅（审计日志同时记录 `refused-high-risk` 与后续 TTL `timeout`）；裸 TCP 恶意 Host 仍 403 ✅。

## 问题

### [P3-3]（新发现）多个单元测试泄漏临时目录到 %TEMP%，无上限累积

- 位置：`dock/test/unit/bindings.test.mjs:9`、`dock/test/unit/lock.test.mjs:10`（零清理）；`cache-index`、`tail-reader`、workbuddy 等部分用例为部分清理。
- 期望：TESTING §8「测试隔离与清理：临时目录…」。
- 实际：本机 %TEMP% 累计 `fox-dock-lock-*` 2100 个、`fox-dock-bind-*` 1715 个、`fox-cache-*` 513 个等约 4700 个残留目录（10-18 起）；仅今天（10-26，两轮 ci + 整改方验证）就新增 140 个 bind 目录。单个目录很小（KB 级），但每次 `npm test`/`npm run ci` 无条件增长。
- 复现：`ls $TEMP | grep -c fox-dock-bind` → 1715；`stat` 抽样可见 2026-10-26 当日 140 个。
- 频率：确定。
- 影响：P3（测试卫生，不影响主流程正确性；长期跑 CI 的机器 %TEMP% 会缓慢膨胀）。
- 说明：**非本轮整改引入**（bindings/lock 测试文件均不在本轮 diff 内），属既有问题首次被发现。
- 建议（非强制）：`bindings.test.mjs` / `lock.test.mjs` 补 `after()` 递归清理（其余部分清理的文件顺手对齐）；或在 run-tests.mjs 里做套件级清扫。

## 未验证 / 无法验证

- 视觉基线：本机 Edge 156，`ENV-MISMATCH`，未比较未更新（与整改记录 §4 一致）。
- `test:it`、soak、真机输入探针/缩放/失焦兜底/气泡贴角：发版前人工项（整改记录 §5 已列）。
- UI 整改的视觉/交互细节（25 条 P2 等）：属 UI 审查线，本次仅核对其触达后端契约的部分（displayStatus 消费、waiting 计数拆分的服务端字段、P2-5 SSE 代理）。

## 现场清理

- 复核用临时 daemon（`%TEMP%\fox-dock-recheck`，端口 39402）已停止、数据目录已删除；watchdog 后台任务已终止；39402 端口已释放。
- 本机 39401 为用户真实 daemon，全程未触碰。
- 工作树与本轮审查开始时一致（仅新增本报告文件）；未修改任何被审代码、未提交、未切分支。
