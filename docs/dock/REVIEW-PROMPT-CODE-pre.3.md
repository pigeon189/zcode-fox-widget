# 独立后端代码审查提示词 · fox-dock 2.0 pre.3

> 派发者注意：把本文件**全文**作为审查 AI 的第一条消息。不要附上实现者的总结、对话记录、
> 上一轮审查结论或「已知问题清单」。工作区必须设为仓库根 `E:\WorkSpace\fox-dock`，否则读不到
> `docs/dock/` 与根 `AGENTS.md`。审查对象是**工作树当前内容（未提交）**，不是 HEAD。

## 1. 审查参数（已填好）

- 仓库根：`E:\WorkSpace\fox-dock`
- 分支：`dock-pre`
- 基线提交：`211c27e`；当前工作树有约 88 个未提交修改（pre.3 主体），这是预期状态
- 审查对象：工作树中的 dock 2.0 全部服务端与宿主集成代码，重点是 pre.3 的 M5（权限接管）
  与 M6（接入向导 / WB 增量索引持久化 / 便携包 / 语音库迁移），以及 D053/D054/D056 相关改动
- 审查范围：`dock/daemon/`、`dock/adapters/`、`dock/shared/`、`dock/hooks/`、
  `dock/integrations/`、`dock/engines/`（只查副本一致性）、`dock/console/`、`dock/overlay/`
  （主进程/preload 与 Electron 安全）、`dock/tools/`、`dock/test/`
- 明确排除：仓库根的 1.x 线（`lib/`、`desktop/`、`hooks/`、`skills/`、`.zcode-plugin/`、
  根 README/CHANGELOG）。不要审查，也不要修
- 报告路径：`docs/dock/reviews/2026-10-26/CODE-REVIEW-2026-10-26-pre.3.md`
- 时间上限：无。但先做高风险路径（安全边界、凭据、权限中介、状态口径、计价），再做广度

## 2. 角色与隔离

你是独立代码审查员。任务是根据代码、文档契约和可执行验证，判断实现是否满足约束并找出缺陷。

1. 只读取：仓库文件、当前分支历史、`docs/`、测试/命令输出。
2. 不读取、不引用实现者的对话、阶段报告、提交说明中的自我评价。提交说明只能作定位线索。
3. 审查期间不修改被审代码、不提交、不切分支、不清工作树。只允许写一份报告和仓库外的临时
   脚本/数据目录。需要验证「删掉某逻辑测试会不会红」时，把代码复制到仓库外再改。
4. 不使用真实用户凭据、不读取真实数据目录、不粘贴真实 key/路径/命令。需要宿主数据时，
   用 `test/fixtures/` 夹具或在 `%TEMP%` 下合成 SQLite；需要本地服务时只连 `127.0.0.1`。
5. 不因为作者声称「已测试」「已知问题」「按文档要求」而跳过验证；也不因代码风格、命名、
   目录偏好判定缺陷。
6. 先独立完成报告；需要澄清的事实写成「未验证」，不要先与实现者讨论再下结论。

## 3. 事实来源与判定原则

优先级：**可复现运行结果 > 代码路径 > 文档**。

- 文档是「应然」。文档与代码冲突时两边都要报：实现漏了，或文档漂移了（写明方向）。
- 注释、提交说明、测试名称都不是证据；必须找到代码路径 + 测试 + 实际运行结果的对应。
- 「路径存在」不等于「边界成立」；安全与错误路径必须用负例验证。
- 不要把「未提交」本身当缺陷；审查的是内容。发布纪律由发版流程负责。

## 4. 开工前必读（按顺序）

1. `AGENTS.md`（仓库结构、架构边界、硬性约束、已知坑、发版纪律）
2. `docs/dock/DECISIONS.md`（D001–D056；冲突时以决策记录为准）
3. `docs/dock/ADAPTERS.md`（适配器契约、失败语义、实时信号矩阵、P-2 真机结论）
4. `docs/dock/TESTING.md`（分层测试、夹具、已知偶发失败、pre.3 增量）
5. `docs/dock/PLAN-pre.2-truth-layer.md` §0（本分支不可碰清单）
6. `docs/dock/UI-SPEC.md`（只读与后端契约相关的状态/额度/权限卡口径）
7. `dock/CHANGELOG.md`、`docs/dock/release-notes-pre.3.html`（对外的功能声明，逐条核对）
8. `dock/package.json`、`dock/tools/run-tests.mjs`、`dock/tools/*.mjs`

## 5. 已定案事项（不得作为缺陷重开）

可以验证实现是否符合，但不要重新讨论「该不该这样」：

- **权限钩子分支 A（P-2 真机定案）**：钩子 stdout 只有 `{"continue":true,"decision":"approve"}`
  能表达允许；拒绝走 `exit 2`（stderr 透传给 agent）；原生确认卡片阻塞等待钩子。
- **权限模型**：接管默认关闭；永不提供 always-allow；只有「允许一次 / 拒绝」；
  超时或任何失败 fail-open 回宿主原生弹窗；高风险命令不注册热键允许、不设默认焦点。
- **状态口径（D056）**：`displayStatusOf` 是唯一派生函数；`done` 只是回合结束后 4 秒；
  `doneAt` 撑 5 分钟「已完成」；`turnActive`（15 分钟上限）与 `workflowBusy`
  （`dwf_run`/`workflow_run` 在跑）压制 done/idle；计数/筛选/SSE 同源；按根会话合并。
- **额度（D053）**：赠送池按模型分桶（`byModel`）；汇总不得掩盖单池；快览卡最多 3 条桶行。
- **成本口径（D054）**：会话/回合成本按「模型 + provider + 整点桶」分段计价；
  预付/套餐行金额记 0、token 照算；真实支出与等价市值不混。
- **火山方舟（D047）**：订阅口径由官方 Base URL 路径裁定（`/api/coding`、`/api/plan`），
  providerId 字样不作数。
- **百分比（D046）**：厂商状态统一 0–100 口径，引擎输出的 0–1 比例只在组装边界换算。
- **控制台兜底（D055）**：`console-crash.log` + 主进程 0/1/3/10/30s 退避重载 + ErrorBoundary。
- **浮层（D043/D044）**：失焦不隐身；落 `fallbackCorner`；窗口与工作区重合（任务栏自动隐藏
  留 1 DIP）；避让滚动条只右侧；显示缩放变化由 `display-metrics-changed` 自愈。
- **`dock/engines/{pricing,cmdgo,relays}.mjs`** 是 `../lib/` 同名文件的逐字节副本：
  内容正确性不在本线判断，只查是否漂移/被手改（`npm run check:sync`、`npm run parity:engines`）。
- **零运行时依赖、无构建步骤**；`node:sqlite` 要求 Node ≥22.5。
- **视觉基线**固定 Edge 155；本机 Edge 156 报 `ENV-MISMATCH` 属环境限制，不是缺陷，
  且绝不能 `--update`。

## 6. 已知低危/已接受项（不要当新发现）

以下问题已知、已评估为低危或环境限制。若要报，必须证明 pre.3 的改动把它**升级**了，
并给出新增攻击路径或稳定复现：

- `ActionBroker` 的 pending Map 在长期不 resolve 的请求下会增长（未持久化，重启即清）。
- 快览卡在一次打开过程中可能多次上移（已限制 1.5 秒内最多一次，极端内容仍可能两次）。
- daemon 崩溃后 lock 文件可能短暂残留旧端口，客户端靠重读 lock/重试兜底。
- 诊断包中窗口标题可能含用户路径（已部分脱敏）。
- 匿名读接口会返回会话标题/cwd/model/token/成本（设计如此，文档已如实描述）。
- 需要真机/固定环境才能验证的项：`test:it`（真桌面）、视觉基线（Edge 155）、
  soak/bench、真实指针/热键/通知。
- 已知偶发失败：`anchor`、`pet: 单击角色打开快览卡`、`大浮窗打开时气泡避开浮窗`、
  `restore.itest` 的恢复绑定用例。稳定复现 3 次以上才算缺陷。

## 7. 架构地图（用于定位，不作为事实）

- `dock/adapters/<id>/`：只读宿主数据；`registry.mjs` 注册；认不出落 `generic`；读不到
  `null + unavailable`，绝不编 0；唯一写回是 Kimi OAuth token 的原子刷新。
- `dock/daemon/`：常驻服务；`v1.mjs` REST/SSE；`actions.mjs` ActionBroker；
  `risk.mjs` + `risk-rules.mjs`；`sounds.mjs`；`live-tracker.mjs`；`settings.mjs`；
  `vault.mjs`；Win32 PowerShell 桥（窗口发现/吸附/前台）。
- `dock/shared/`：daemon 与 UI 共用纯模块（`session-model`、`live-reduce`、`provenance`、
  `redact`、`tail`、`cache-index` 等）。
- `dock/hooks/dock-hook.mjs` + `dock/integrations/zcode-plugin/`：宿主钩子与集成插件；
  副本必须逐字节一致。
- `dock/ui/`、`dock/console/`、`dock/overlay/`：渲染层与两个 Electron 入口。
- `dock/engines/`：厂商模板与计价（三份逐字节副本 + `plan-balance.mjs` / `glm-plan-api.mjs`）。
- `dock/tools/`：测试调度、夹具、打包/签名、探针。

## 8. 环境与取证

### 8.1 隔离数据目录

所有真 daemon 实验必须用临时数据目录，禁止读写真实 `%LOCALAPPDATA%\fox-dock`：

```bat
cd /d E:\WorkSpace\fox-dock\dock
node tools\fox-dock.mjs start --data-dir %TEMP%\fox-dock-review-code
```

`FOX_DOCK_DATA` 等价于 `--data-dir`。端口从临时目录里的 `daemon.lock` 读取，**不要硬编码
39401**（被占会自动 +1）。结束时 `stop --data-dir %TEMP%\fox-dock-review-code`。

### 8.2 门禁（先跑，记录原始输出）

```bat
npm run ci
npm run test:e2e:pages
npm run test:electron:console
```

- `npm run ci` = 语法 + 价目副本同步 + 单元 + 静态守卫 + engines parity；这是提交前必跑项。
- `npm run test:it` 需要在真实桌面弹测试宠物窗口，可能受焦点/窗口动画影响；跑之前说明属正常
  现象，结果按已知偶发失败规则判读。
- `npm run soak` / `npm run bench` 可选，时间盒内做；记录时长与数据目录。
- 依赖已装在 `dock/test/node_modules`；**不要新增安装**（会改工作树）。缺依赖记 BLOCKED。
- 不访问外部网络；所有验证只连 `127.0.0.1`。

### 8.3 静态 + 负例方法

- 先建立数据流：入口 → 校验 → 业务 → 持久化/出站 → 响应。
- 每个安全断言都要有负例：不带令牌、错令牌、环回地址、私有地址、重定向、超大 body、
  路径穿越、畸形 JSON、超时、daemon 重启。
- 每个状态断言都要构造边界数据：5 分钟窗口两端、15 分钟上限、`turn_start`/`turn_end`
  之间、`dwf_run` 在跑/结束、老库无 workflow 表、子会话与父会话混合状态。
- 可复现证据：`file:line` + 命令/输入 + 实际输出。偶发问题复现 3 次并记录 N/M；
  不能复现写 `UNVERIFIED`。

## 9. 检查清单

### A. 范围与规范一致性

- 改动是否只落在 `dock/` 与 `docs/dock/`（`dock-pre` 线）；是否误改 1.x 根目录文件。
- `docs/dock/DECISIONS.md`、`ADAPTERS.md`、`TESTING.md`、`UI-SPEC.md`、`CHANGELOG.md`、
  `release-notes-pre.3.html` 中的每个功能/字段/默认值/命令，是否都能在代码中找到对应实现；
  反向也要查：代码里新增的重要行为是否写进文档。
- `D001–D056` 的硬约束是否有被 pre.3 改动破坏的（逐条抽查高风险项）。
- 版本号/tag/签名清单是否被越权改动（`dock/package.json`、`docs/dock/update.json`）。

### B. 安全（最高优先级）

**`/v1` 接口**

- 所有写接口是否都要求 `x-fox-token`，比较是否 timing-safe；未授权是否 403。
- 读接口是否有 Host/来源校验；是否泄露超出设计范围的字段（尤其命令预览、完整路径、
  完整 key、token）。
- 请求体大小限制、JSON 解析失败、路径穿越、重复参数、超长字符串是否安全处理。
- `/v1/ingest` 是公开协议：takeover 关闭时 `permission_request` 是否不入 broker；
  带 `wait` 的客户端是否只走 `broker.wait`；`/v1/actions` 与 resolve 是否仍受令牌保护。
- `/v1/maintenance/bridge-restart` 是否仅写接口令牌可用，是否可能被滥用成通用重启开关。

**出站 / SSRF**

- 只允许 http/https；host 校验是否覆盖：`localhost`、`127.0.0.0/8`、`::1`、`0.0.0.0`、
  私有段、链路本地、保留段、IPv4-mapped IPv6、十进制/八进制变形、DNS 重绑定、重定向。
- 固定环回例外是否只存在于 Kimi 与 CommandCode 的专用客户端，且不可被其它厂商配置复用。
- 厂商 Base URL、探针、更新检查、模型列表等所有出站入口是否共用同一校验。

**凭据**

- 顺序是否为 环境变量 → DPAPI 保险库 → 宿主只读发现 → 旧配置导入。
- 日志、诊断包、导出、通知、API 响应、错误信息中是否出现完整 key/完整命令/用户路径。
- 测试夹具/文档/示例中是否出现可用的密钥或 PEM 字面量（假 PEM 必须字符串拼接构造）。
- 密钥展示是否掩码；掩码是否可逆或泄露长度以外的信息。

**宿主写入**

- 是否仍然不自动写宿主配置；Kimi OAuth token 刷新是否仍是唯一写回且原子；
  文件权限/临时文件/失败回滚是否正确。

**权限中介（ActionBroker + dock-hook）**

- 幂等：同一 requestId 重复 ingest 是否只登记一次。
- 上限：5 个 pending + 20 个历史/审计的边界是否真的生效；超限行为是否 fail-open。
- 一次性 resolve：并发 resolve、重复 resolve、已过期 resolve 是否只成功一次。
- 长轮询：超时、客户端断开、daemon 重启、多个 wait 并发是否安全；响应里的 requestId
  是否做身份校验（同一进程并发两个 `wait` 会触发 undici 配对问题）。
- `pending` 是否不持久化；daemon 重启后是否全部 fail-open。
- 审计是否只记 id/tool/decision/via，绝不记预览原文；通知文案是否脱敏且 ≤60 字。
- 时序：非权限事件 300ms 预算；权限事件 `min(settings.permission.waitMs, 30s 剩余预算)`；
  stdin 兜底与读设置是否计入；最坏情况是否越过宿主 30s。
- 钩子任何异常/超时是否 `exit 0`；deny 是否 `exit 2` 且 stderr 透传；allow 是否严格输出
  `{"continue":true,"decision":"approve"}`；takeover 关闭时是否降级为不干预。
- `dock/integrations/.../hooks/dock-hook.mjs` 与源头是否逐字节一致；插件目录是否同时有
  `.zcode-plugin/plugin.json` 与根级 `marketplace.json`（自引用 `source: "."`）。

**Electron**

- 两个入口是否保持 `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`。
- preload 暴露面是否最小；IPC 是否校验参数与来源；是否禁止任意路径读/写。
- 导航、`window.open`、外部协议、`webview` 是否被拦截。
- 浮层渲染层是否零 `fetch`；主进程 IPC 是否只连 `127.0.0.1` 的 lock 端口。
- `overlay/main.cjs` 的 `type:'toolbar'` 是否保留；窗口 `alwaysOnTop`/`focusable`/
  `setIgnoreMouseEvents` 是否可能造成宿主冻结或点击劫持。

**更新/打包**

- 更新清单是否要求 sha256 + Ed25519 签名；降级是否拒绝；tar slip/路径穿越是否防护；
  签名校验失败是否回滚。
- 便携包是否校验 `launch/` 启动件，是否会把密钥/数据目录打进包。

### C. 正确性与数据口径

- 适配器是否只读宿主；认不出是否落 `generic`；读不到是否 `null + unavailable`；
  是否有任何「补 0」或伪造状态。
- ZCode 会话的 `model/provider` 是否取最近一次真实调用（按 `lastAt`），没有退回
  `models.find(...)` 的第一个历史模型；分页是否按根会话，子会话随父返回。
- 状态：`displayStatusOf` 的优先级是否与 D056 一致；`doneAt`/`turnActive`/`workflowBusy`
  的合并、过期、清除是否正确；`expire()` 是否会把活跃回合误降为 idle/done；
  根会话合并是否不重复计数；筛选/计数/SSE/detail 是否全部走同一派生。
- `dwf_run`/`workflow_run` 的关联是否用 `parent_session_id`；status 是否只认运行中；
  老库没有 workflow 表时是否安全降级；`session_task_link.link.status` 是否被误当权威。
- 金额/Token/百分比是否带 provenance；是否跨币种/跨单位求和；缺失是否 `null`。
- 预付/套餐：provider 判定是否含 `start-plan`/`coding-plan`/`zcode-plan`/`cmdgo`/
  `commandcode`；金额是否记 0、token 是否照算；等价市值与真实支出是否分开。
- 分段计价：换模型、峰谷/周末、混合模型回合是否按「模型 + provider + 整点桶」分别计价；
  会话、回合明细、用量下钻是否同一判据。
- GLM：直连接口（需 bigmodel key）与日志兜底的来源是否不互相冒充；`byModel` 是否正确
  由 `balances[]` × `entitlements[].capabilities` 生成；百分比是否在组装边界换算一次。
- 账本是否只认累计值、按日覆盖、失败不写；7 天窗口边界与本地时区处理是否正确。
- `cache-index`：版本失配是否丢弃；LRU 是否生效；写入是否原子；tail restore 与删缓存后
  的等价性是否有测试覆盖。
- 设置、宠物状态、档案、旧配置导入的 schema 迁移与回滚是否正确；旧入口
  （旧挂件把 `Notification/PermissionRequest` 转发到 `/v1/events`）是否仍保留。

### D. 并发、资源与健壮性

- 单实例锁、端口递增、lock 文件读写、watchdog 60s、overlay 90s、桥按需重启是否互相兼容。
- daemon 重启/崩溃后：SSE 客户端是否重连；pending 权限是否 fail-open；孤儿进程/浮层是否清理。
- 显示缩放/分辨率/工作区变化：主进程监听是否防抖、是否清理监听器、是否可能循环触发；
  `/v1/maintenance/bridge-restart` 失败是否被吞掉并留下错误状态。
- 文件写是否原子；进程被杀是否留下半文件；临时文件/日志是否无限增长。
- `node:sqlite`：版本要求、句柄关闭、Windows 文件锁 EPERM 重试、测试清理隔离。
- SSE 慢客户端、断线重连、心跳、背压是否阻塞或泄漏。
- 大库/大文件/多帧 zstd：是否有上限、截断标记、性能退化；是否可能 OOM。
- 路径大小写、空格、非 ASCII、超长路径、Windows 分隔符是否正确处理。

### E. 测试质量

- 是否真的断言目标行为；是否存在只断言「不抛错」「快照存在」「函数被调用」的用例。
- 安全负例、失败路径、超时路径是否都有测试（不仅是 happy path）。
- 新增测试是否覆盖：`risk` 正反例、`actions` 幂等/上限/一次性/超时、`hook-script` 六断言、
  `hook-sync` 逐字节、`sounds` 回落、`cache-index` 版本失配/LRU/原子写、
  `session-display-status` 窗口边界、`zcode-workflow-status` 老库降级。
- 夹具是否合成；是否依赖真实用户数据、本机固定路径/端口/DPI。
- 测试隔离与清理：临时目录、端口、进程、DB 句柄、日志。
- 是否存在被跳过（skip/todo）的核心用例；是否有把偶发失败重试到通过的逻辑。
- 可选：把关键模块复制到仓库外，删掉一段保护逻辑，确认对应测试会红（验证断言强度）。

### F. 变更卫生

- 调试代码、临时日志、硬编码本机路径、注释掉的代码、未使用导入/变量。
- 构建产物、截图、依赖目录是否被误加入版本库。
- 是否新增运行时依赖（禁止）；vendored 代码是否有许可证/来源说明。
- 文档中的命令/路径/环境变量是否与实际一致（例如夹具示例路径是否已过期）。

## 10. 严重度定义

- **P1**：安全边界失效（未授权写、SSRF、凭据泄露、更新签名绕过）、数据丢失/损坏、
  宿主被写坏、权限卡可在用户未操作时放行、always-allow、fail-open 被破坏导致宿主卡死、
  核心流程不可用/无法启动、违反文档硬约束。
- **P2**：行为与文档/契约不符但有绕行；错误路径给出误导性结果；常见使用下可触发的竞态/
  资源泄漏；状态/计价口径错误会误导决策；令牌或路径脱敏不完整但可达性受限。
- **P3**：测试、文档、错误文案、边界处理、可维护性问题；不影响主流程正确性。

评级只看影响与可复现性，不看代码风格或个人偏好。

## 11. 输出格式

写到 `docs/dock/reviews/2026-10-26/CODE-REVIEW-2026-10-26-pre.3.md`，不要改其它文件。

```markdown
# 代码审查报告：dock-pre / pre.3 工作树（2026-10-26）

## 审查范围与方法
- 工作树 / 分支 / 基线提交 / 未提交文件数
- 实际运行的命令与退出码
- 数据目录（临时）与清理情况
- 未覆盖或无法验证的部分及原因

## 结论
APPROVE | REQUEST_CHANGES | BLOCKED

## 门禁结果
| 命令 | 退出码 | 关键输出 | 备注 |
|---|---|---|---|

## 问题

### [P1-1] <一句话事实描述>
- 位置：<file:line>
- 期望：<引用文档章节/决策号/契约；无依据写「无明确规范，属实现缺陷」>
- 实际：
- 复现：
  1. ...
  2. ...
- 证据：<命令输出 / 测试输出 / 代码片段 / 请求响应 / 复现频率>
- 频率：确定 / 偶发 N/M / UNVERIFIED
- 影响：
- 建议（非强制）：

### [P2-1] ...
### [P3-1] ...

## 安全负例结果
| 入口 | 负例 | 期望 | 实际 | 结论 |
|---|---|---|---|---|

## 已核对且未发现问题的项
- <检查项>：<用的证据>

## 未验证 / 无法验证
- <事项>：<原因，例如无可见桌面、Edge 版本不符、缺 Electron>

## 与已知低危项的关系
- <项>：未变化 / 已改善 / 升级为 P?，证据
```

## 12. 禁止事项

- 不修改代码、不提交、不推送、不打 tag、不改版本号、不改 `docs/dock/update.json`、不发 release。
- 不新增 npm 依赖、不 `npm install`、不下载浏览器。
- 不读取或粘贴真实密钥、token、用户数据、真实宿主数据库内容。
- 不向外部网络发请求；所有服务只连 `127.0.0.1`。
- 不写主观评价（「优雅」「丑陋」「感觉」）；不要求与文档无关的重构/改名/框架替换。
- 不把未复现的猜测写成缺陷；不把「没有测试」直接写成 P1（安全/数据完整性路径除外）。
- 不审查 1.x 线，不评价 `dock/engines/` 里三份副本的内容正确性（只看是否漂移）。

## 13. 交报告前自检

1. 每个 P1/P2 是否都有 `file:line` + 复现 + 实际输出？缺一项就降级或删除。
2. 安全项是否都做了负例，而不是只读代码推断？
3. 状态/计价结论是否用构造数据跑过边界，而不是只看函数名？
4. 是否把 §5 已定案或 §6 已知低危项当成新发现？若仍要报，是否给出了升级证据？
5. 门禁是否实际跑过并记录退出码？没跑就写进「未验证」。
6. `git status --porcelain` 是否只多出报告文件？临时目录是否已清理？
