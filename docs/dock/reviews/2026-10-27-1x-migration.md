# 1.x → 2.0 迁移报告（2026-10-27）

来源批次：1.x / WB 线（`origin/workbuddy` 等）修复与能力的迁移评估，本轮送审 2 条候选，
1 条判 `migrate`（已实施），1 条判 `manual`（未实施，留人工决策）。
基线：`dock-pre` @ `65d405b` 工作树（含属性测试写手刚加的 2 个未跟踪 fuzz 文件，未触碰）。

## 候选 1：测试写连接补 busy timeout —— migrate（已实施）

- **来源**：`origin/workbuddy` `18bcf51`「fix(selftest): 写连接补 busy timeout，修 CI 偶发
  database is locked」（改动 `tools/selftest.mjs` 等 3 处，给 `new DatabaseSync(..., { timeout: 5000 })`）。
- **做法**：2.0 测试侧同类风险已核实（初查 `grep -rn "new DatabaseSync(" dock/` 命中 7 处测试连接
  均未传 timeout，而运行时侧 `adapters/zcode/store.mjs:87`/`:287`、`adapters/zcode/context.mjs:213`、
  `adapters/workbuddy/context.mjs:56` 均为 `timeout: 2000–5000`；AGENTS.md「已知坑」亦记录
  Windows 文件锁偶发 EPERM）。**【2026-10-27 复审更正】**初查的 grep 模式 `new DatabaseSync(`
  有盲区：别名形式 `new sqlite.DatabaseSync(`（及任何 `xx.DatabaseSync(`）不含该子串、整体
  逃过扫描，测试目录内另有 16 处同类无 timeout 写连接。两批共 23 处全部补 `{ timeout: 5000 }`，
  与源提交取值一致：
  - `dock/test/integration/billing.itest.mjs:36`
  - `dock/test/integration/v1.itest.mjs:40`
  - `dock/test/integration/sessions-live.itest.mjs:41`
  - `dock/test/unit/context-zcode.test.mjs:16`
  - `dock/test/unit/context-workbuddy.test.mjs:16`
  - `dock/test/unit/zcode-adapter.test.mjs:27`、`:229`
  - （复审补充的 16 处别名形式）`dock/test/unit/zcode-sessions.test.mjs` ×5、
    `zcode-workflow-status.test.mjs` ×3、`context-zcode-compaction.test.mjs` ×2、
    `engines-unpriced.test.mjs`、`incremental-equivalence.test.mjs`、`provenance-adapters.test.mjs`、
    `zcode-live-status.test.mjs`、`zcode-cancelled-status.test.mjs`、`zcode-display-status-fuzz.test.mjs`；
    另 `dock/tools/bench-sessions.mjs:50` 不在守卫扫描目录，也顺带补齐
- **取舍**：运行时侧不改（已配 timeout，非漏配）；不引入重试循环（治标掩盖时序问题），
  用 busy timeout 让 SQLite 自己等锁。同时新增守卫
  `dock/test/unit/test-db-busy-timeout.test.mjs`：扫描 `test/{unit,integration,e2e}` 全部
  `.mjs`，断言每个 `DatabaseSync(` 调用（按 `DatabaseSync\s*\(` 锚点，别名形式同样入扫；
  括号配对解析、支持跨行）都带 `timeout`；
  守卫自身文件跳过（源码含字面量）；并断言总数 ≥20 防解析失效静默通过。确实不需要等待的
  连接可显式写 `{ timeout: 0 }` 通行。该守卫经正反两向验证：
  - 正向：`node --test test/unit/test-db-busy-timeout.test.mjs` → 1 pass；
  - 反向：临时放一个无 timeout 连接进 `test/unit/`，守卫立即失败并指出文件（已删临时文件）。
- **测试**：被改 6 个测试文件全量复跑——`node --test` 单元 3 文件 **26/26 pass**、
  集成 3 文件（`billing.itest` / `v1.itest` / `sessions-live.itest`）**23/23 pass**，
  无行为变化（timeout 只影响抢锁等待上限）。文档同步：`dock/CHANGELOG.md` pre.3 修复节
  加一条（注明仅测试基础设施、不影响运行时）；`docs/dock/TESTING.md` §5 偶发失败加
  定责说明、§9 增量记录迁移条目。
- **未做**：`docs/dock/release-notes-pre.3.html` 未动——本条对用户不可感知（纯测试脚手架），
  不满足更新说明页「用户可感知的新功能/行为变化/修复」判据；`DECISIONS.md` 未新增决策——
  不涉产品/架构取舍，属工程卫生，留档于本报告与 TESTING.md 即可。

## 候选 2：浮层跟随 ZCode 所在显示器（换屏跟随）—— manual（未实施）

- **来源**：`main` `60e0c1c` + `0a1d7e5`（合并 `b255a7c`，PR #15）；WB 移植 `b853d45`。
  按宿主窗口中心判目标显示器，静止 700ms 防抖后整窗迁屏，期间按可见面积隐身，拖拽重置计时。
- **不实施原因**：2.0 缺口核实为真——`dock/overlay/main.cjs:624`、`:704` 只在启动/
  `display-metrics-changed` 时按光标 `getDisplayNearestPoint` 选屏，`:737-739` 只挂
  `display-metrics-changed`/`added`/`removed` 做 refit，全 `dock/` 无「宿主中心换屏→整窗
  跟随」逻辑。但 `docs/dock/DECISIONS.md` D011 明确记录「暂不支持多显示器」（狐狸拖不到
  副屏是已知限制），且 DECISIONS.md 头部规定推翻旧决策必须新增条目而非直接修改。落地还要
  与 D044 失焦兜底、D043 贴角、拖拽写回 `floating.rect` 的既有语义对齐（拖拽期间不切屏），
  属产品/范围决策而非纯技术移植，按流程留给维护者拍板。
- **给维护者的落点参考**：窗口 `resizable:true`（`main.cjs:639-641` 注释）使 `setBounds`
  可用，无需 1.x 的整窗重建；D057 的 refit 重读原点链路（`main.cjs:733` 附近）可复用；
  判定函数可仿 `0a1d7e5` 抽成纯模块补单测；换屏判定需挂在浮层主进程既有轮询上，并处理
  「拖拽中不切屏」。

## 本轮改动清单

| 文件 | 改动 |
|---|---|
| `dock/test/integration/billing.itest.mjs` | 写连接补 `{ timeout: 5000 }` |
| `dock/test/integration/v1.itest.mjs` | 同上 |
| `dock/test/integration/sessions-live.itest.mjs` | 同上 |
| `dock/test/unit/context-zcode.test.mjs` | 同上 |
| `dock/test/unit/context-workbuddy.test.mjs` | 同上 |
| `dock/test/unit/zcode-adapter.test.mjs` | 同上（2 处） |
| `dock/test/unit/test-db-busy-timeout.test.mjs` | 新增守卫测试 |
| `dock/CHANGELOG.md` | pre.3 修复节加一条 |
| `docs/dock/TESTING.md` | §5 偶发失败定责 + §9 增量记录 |

未提交、未 push（遵守分支纪律）。`npm run ci` 由维护者复跑。
