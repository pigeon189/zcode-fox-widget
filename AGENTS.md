# AGENTS.md

面向在本仓库工作的 ZCode agent。先读本文件，再按任务读 `docs/dock/` 下的专项文档。

## 仓库结构：两条独立产品线

| 路径 | 产品 | 当前分支 | 约束 |
|---|---|---|---|
| 仓库根（`lib/`、`desktop/`、`hooks/`、`skills/`、`.zcode-plugin/`） | ZCode 狐娘小挂件 1.x | `main` / `workbuddy` | `dock-pre` 分支上**不要改** |
| `dock/` | fox-dock 2.0 通用桌宠（独立程序） | `dock-pre`（同源长分支 `feat/dock`） | 本线主体 |
| `docs/dock/` | 2.0 方案、决策、测试、UI 规格 | `dock-pre` | 与 `dock/` 同步更新 |

`dock-pre` 上的所有改动只落在 `dock/` 与 `docs/dock/`（`docs/dock/PLAN-pre.2-truth-layer.md` §0）；
价目是唯一跨线例外（源头 `lib/pricing.mjs`，见下）。
1.x 的版本号来源是根 `.zcode-plugin/plugin.json`；2.0 的版本号来源是 `dock/package.json`，两者互不影响。
当前状态：pre.2 **已于 2026-10-24 发布**（`dock-v2.0.0-pre.2`）；**pre.3 已于 2026-10-27 发布**
（`dock-v2.0.0-pre.3`，GitHub prerelease，资产 = tar.gz + 图文说明 `release-notes-pre.3.html`，
签名清单提交 `e8fc578`；此前 14 个提交 `172eee8..e8fc578` 含三线复审修复与 1.x busy timeout 迁移）。
pre.3 = M5 权限接管（ActionBroker / dock-hook / 集成插件 / 权限卡 / 热键 / 通知）+ M6 接入向导、
WB 增量索引持久化、便携包 + 1.x v1.16.3 语音库迁移（小黄鸭/嘀嘟/猫娘 + 自定义导入）。
发版验证：soak 4h 健康（p50 12ms / p95 19ms）、bench 200k/1M、ci（593 单测）/ test:ui /
e2e / electron 冒烟 / test:pet 全绿；`test:it` 87/90 为已知 `restore.itest` 环境级偶发（非回归）。
**发版后仍欠**：Edge 155 固定环境补跑视觉基线（本机 Edge 156，基线未更新）、真机 DPI / 热键 /
通知复核。**P-2 探针已真机定案（2026-10-25）**：钩子 stdout
只有 `{"continue":true,"decision":"approve"}` 能表达允许，拒绝走 exit 2（stderr 透传给 agent），
原生确认卡片阻塞等待钩子；结论已回填 ADAPTERS / D050 修订，分支 A 为默认。

## 常用命令

所有命令在 `dock/` 下执行。要求 Windows 10/11 + Node.js ≥22.5；无运行时 npm 依赖、无构建步骤，
改完 `.mjs/.css/.html` 重启对应进程即可。测试依赖只在 `dock/test/package.json`。

```bat
npm start                    :: 启动 daemon + 宠物层（也可 node tools/fox-dock.mjs start）
npm stop / npm status        :: 停止 / 查看状态
npm run doctor               :: 当前窗口识别与适配器命中，排障先跑这个
npm run fixture              :: 夹具 daemon，页面截图 / E2E 用

npm run ci                   :: 语法 + 价目副本同步 + 单元 + 静态守卫 + engines parity（提交前必跑）
npm test                     :: 单元测试
npm run test:it              :: 集成测试（真窗口 / 真 Electron）
npm run test:all             :: 单元 + 集成
npm run test:ui              :: 9 页 × 双主题布局 / 可访问名称 / axe
npm run test:e2e:pages       :: Playwright 页面 E2E
npm run test:electron:console :: 真 Electron 控制台冒烟 + CDP 断言
npm run visual               :: 128 张视觉基线比对
npm run visual:update        :: 仅在固定机器与固定 Edge 版本上更新基线
npm run test:pet             :: 宠物层 80 张状态截图
npm run bench / npm run soak :: 性能基准 / 长跑稳定性（发版前）
node tools/pack-release.mjs --version <ver> --url <直链> [--sign] [--portable]
                             :: 打包；--portable 产出解压即用包（校验 launch/ 启动件 + PORTABLE-README.txt）
node tools/probe-zcode-hook.mjs :: 生成 P-2 探针插件（模式切换式：allow 候选 / exit2 deny / slow 阻塞判定）
```

浏览器用本机 Edge（`channel:'msedge'`），不要下载 Chromium。

## 架构边界

- `dock/adapters/<id>/`：只读宿主数据，按 `docs/dock/ADAPTERS.md` 实现并在
  `adapters/registry.mjs` 注册。认不出就落 `generic`，读不到就报错或 `null + unavailable`，
  **绝不编 0**。唯一写回宿主的是 Kimi OAuth token 的原子刷新。
  ZCode 会话的 `model/provider` 取**最近一次真实调用**（按 `lastAt`），不要退回
  `models.find(...)` 的第一个历史模型；会话分页按根会话，子会话随父返回。
- `dock/daemon/`：常驻服务，负责窗口发现/绑定、`/v1` REST、SSE、设置、保险库、账本、调度、
  权限中介（`actions.mjs` ActionBroker：幂等/上限 5+20/一次性 resolve/长轮询/审计不含预览；
  `risk.mjs` + `risk-rules.mjs` 高风险表；`sounds.mjs` 音效库；`cache-index` 的消费者）。
  UI 不得直接读宿主文件，所有数据走本机 HTTP（`x-fox-token`）。会话 `counts` 与胶囊状态
  按**根会话**统计，子任务状态归并到父会话，不能把子会话重复计数。
  展示状态统一由 `shared/session-model#displayStatusOf` 派生（D056）：`doneAt` 撑 5 分钟
  「已完成」，`turnActive`（钩子回合边界，15 分钟上限）与 `workflowBusy`
  （`dwf_run`/`workflow_run` 仍在跑）压制 done/idle；筛选、计数、SSE 摘要同源。
  ZCode 手动停止落 `turn_usage.status='cancelled'`：适配器按「回合结束」清 `turnActive`
  但不记 `doneAt`，停止后回空闲而不是「工作中/已完成」；`permission_resolved` 等回合内
  事件也要续命 `turnActive`（否则长回合第 15 分钟被误判空闲）。
  `POST /v1/maintenance/bridge-restart` 仅供浮层在显示缩放变化后重建 Win32 桥（写接口，
  需令牌），不要拿它当通用重启开关。
  `POST /v1/ingest` 是公开协议（内置 shim 与自定义 agent）；`permission_request` 在 takeover
  开启时一律登记进 broker，带 `wait` 的客户端再走 `broker.wait` 长轮询；`/v1/actions` +
  `POST /v1/actions/:id/resolve` + SSE `action` 是权限卡的数据源。
- `dock/hooks/dock-hook.mjs` + `dock/integrations/zcode-plugin/`：宿主钩子与随包集成插件。
  钩子零依赖单文件、任何异常/超时都 `exit 0`（fail-open）；只挂 4 个低频事件，不挂
  Pre/PostToolUse（D035）。`integrations/.../hooks/dock-hook.mjs` 是**副本**，必须与源头
  逐字节一致（`hook-sync.test.mjs` 守卫）；插件目录必须同时有 `.zcode-plugin/plugin.json`
  与根级 `marketplace.json`（自引用 `source: "."`），否则 ZCode 本地市场识别不到。
- `dock/shared/`：daemon 与 UI 共用的纯模块（`session-model`（含 `displayStatusOf` /
  `DONE_DISPLAY_MS`）、`live-reduce`（含 `turnActive` / `TURN_ACTIVE_MAX_MS`）、`provenance`、
  `redact`、`tail`、`cache-index` 等）。新增跨层逻辑放这里，不要把宿主读取塞进 UI。
- `dock/ui/`：Preact + htm（vendored）无构建渲染层；数据入口是 `ui/console.mjs`；
  图表是 `ui/charts/svg.mjs` 手写 SVG。不要引入打包器、Chart.js、React。
- `dock/console/` 与 `dock/overlay/`：两个 Electron 入口（控制台 / 透明宠物层）。
  `overlay/main.cjs` 里的 `type:'toolbar'` 是宿主冻结事故的守卫，**不得删除**。
  宠物层渲染层（`overlay/pet.js`）**禁止任何 `fetch`**：daemon 交互一律走 preload IPC
  （`window.foxOverlay.read/write/hit/readSound` + `onPermActions` 推送，主进程
  `daemon-read`/`daemon-write`/`read-sound` 处理器持令牌、仅 127.0.0.1:lock 端口）。
  渲染层 fetch 会被 Mimosa Git 门禁判 SSRR/SSRF 高危**强制拦截提交**，
  且拖拽期间渲染进程网络被挂起会卡轮询。SSE 也走主进程代理：`main.cjs` 持令牌订阅
  `/v1/stream`，经 preload `onStream` 推送；渲染层只有纯浏览器测试（无 preload）才回退
  `EventSource`。`test:pet`（纯浏览器、无 preload）靠
  `window.__pet.setSnapshot/setSettings/debugAttach` 注入数据。显示缩放/分辨率/工作区
  变化由主进程监听 `display-metrics-changed`（含 added/removed）重设窗口；缩放变化时
  调用 `/v1/maintenance/bridge-restart` 重建 PowerShell 桥，再执行 `window.__pet.refit()`
  让渲染层立刻重读 `/rect`（同时重读窗口原点，不能沿用首次缓存）。改显示缩放不需要
  重启 fox-dock。主进程每 30 秒用光标位置调用 `__pet.probeInput` 做一次 DOM 命中探测，
  输入穿透卡死时直接纠正 `setIgnoreMouseEvents`；连续两拍无响应才重载渲染进程
  （移植 1.x issue #13）。
- `dock/engines/`：厂商模板与计价。`pricing.mjs`、`cmdgo.mjs`、`relays.mjs` 是
  `../lib/` 同名文件的**逐字节副本**，禁止手改；`npm run check:sync` 会失败。
  需要改价目时，源头在 `lib/`（会影响 1.x 线，先与维护者确认），再用
  `node tools/check-pricing-sync.mjs --fix` 同步副本。GLM Plan / 赠送额度走
  `engines/plan-balance.mjs` + `engines/glm-plan-api.mjs`，不要另起一套套餐配额。
  赠送池按模型分桶（日志里的 `balances[]` × `plans[].entitlements[].capabilities` →
  `byModel`），额度页厂商卡与顶部额度卡按桶画进度条、快览卡追加最多 3 条桶行（D053）；
  汇总数不得掩盖单模型告急。GLM 账号同时有赠送池与
  订阅时：直连接口（需 bigmodel key）给订阅窗口，日志兜底给赠送池——两个来源不互相冒充。

## 硬性约束

- **不自动写宿主配置**；权限接管默认关闭，**永不提供 always-allow**，只允许「允许一次 / 拒绝」，
  超时或任何失败都 fail-open 回宿主原生弹窗。分支 A 成立后可以「允许」，但高风险命令
  （`bash`/`shell` 类命中危险模式、写路径出 cwd、敏感凭据路径）**不注册热键允许**、
  「允许一次」不设默认焦点、卡片挂「高风险」徽标。
- 权限钩子时序红线：非权限事件 300ms 预算；权限事件等待 `min(settings.permission.waitMs,
  30s 总预算扣掉已用时间后的剩余)`（stdin 兜底与读设置都算在内，总时长不越过宿主 30s）；
  `pending` 不持久化，daemon 重启即全部 fail-open；审计只记
  id/tool/decision/via，绝不记预览原文；通知文案脱敏且 ≤60 字。
- 凭据顺序：环境变量 → DPAPI 保险库 → 宿主只读发现 → 旧配置导入。密钥只显示掩码；
  日志、诊断包、导出、通知里不得出现完整 key、完整命令或用户路径。
- 出站请求只允许 http/https，并校验 host；拒绝 localhost / 环回 / 私有 / 保留地址。
  仅 Kimi 与 CommandCode 的专用客户端有固定环回例外。
- Electron 入口必须保持 `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`。
- `ui/` 内禁止 `innerHTML`、`outerHTML`、`document.write`、`eval`、`new Function`、
  `insertAdjacentHTML`（vendored 第三方除外）。`npm run lint` 会检查。
- 金额 / Token / 百分比必须带 provenance（官方接口 / 本地日志 / 估算 / 不可得）；
  缺失就是 `null + unavailable`。多币种、积分、Token 不做跨单位求和或汇率换算。
  厂商状态里的百分比统一 0–100 口径、来自同一条目的剩余/总额，引擎输出的 0–1
  比例只在厂商状态组装边界换算（D046）。
- 预付/套餐行（provider 名含 `start-plan` / `coding-plan` / `zcode-plan` / `cmdgo` /
  `commandcode`）金额记 0，token 照算；真实支出与等价市值不要混。火山方舟的订阅
  口径由官方 Base URL 路径裁定（`/api/coding`、`/api/plan`），providerId 字样不作数
  （D047）。总览 7 天图与用量页
  共用 `/v1/usage/breakdown` 的 `daily`，预付日按等价市值并在 tooltip 标注「含预付等价」。
  会话列表/回合明细/用量下钻同一判据（`adapters/zcode/prepaid.mjs#isPrepaidBilling`），
  整段预付用量的成本显示「≈等价市值」；会话与回合成本按「模型 + provider + 整点桶」
  分段计价（换模型、峰谷/周末、混合模型回合各算各的，D054）。
- 运行时零 npm 依赖。不要在 `dock/package.json` 加依赖；确需测试工具时只加到
  `dock/test/package.json`。

## UI 约定

- 颜色、间距、字号只取 `ui/tokens.css`：字号仅 12/13/14/16/20/24/32/40，间距 4/8/12/16/24/32，
  图表序列色用 `--c1..--c7`。正文 13px，最小 12px。
- 固定 9 页：总览、会话、用量、统计、额度与余额、厂商与密钥、角色与气泡、设置、关于。
  上下文是「会话」详情的标签，不是独立页。
- 交互元素必须有可访问名称；图表必须有 `role="img"` + `aria-label`；装饰图标
  `aria-hidden`。新增页面/关键控件要带稳定 `data-testid`。
- 控制台壳层定高：document 不得纵向滚动，滚动只在 `.content` / `.sidebar` 内。
  `.content` 必须保持 `min-height: 0` + `position: relative`（滚动容器同时是定位祖先），
  否则绝对定位控件锚到初始包含块会把 document 撑高，聚焦控件（如「避让滚动条」开关）
  时整页被滚上去。`npm run test:ui` 有 document 纵向滚动断言。
- 动画红线（D039）：只允许状态存续期间的功能性动画（`fd-spin`、一次性 `fd-nudge`）；
  空闲场景不得有无限动画，`prefers-reduced-motion` 下全部关闭。
- 宠物层交互：隐藏金额时隐藏整个小胶囊（不是把金额改成 `•••`）；快览卡不放
  「打开会话页」页脚；刷新键用控制台同款 SVG 并绝对定位右上角；台词/消耗气泡不得压
  快览卡或越出视口；宿主最小化/关闭/失前台（0.5 秒防抖，D044 修订）后角色落到
  「失焦兜底位置」（`fallbackCorner` 四角可选，默认右下）、**直接贴住工作区角落并面向
  屏幕内侧**、回前台自动恢复吸附；浮层窗口与工作区精确重合，仅任务栏自动隐藏时留
  1 DIP 不可见缝防压滑出热区（D043 修订）；不要恢复「宿主不在最上层就整体 opacity 0」
  的 z-order 隐身。「避让滚动条」（`scrollGapOn`/`scrollGap`）只作用于右边：吸附时按
  宿主窗口右缘留缝，桌面悬浮时按屏幕（工作区）右缘留缝（最大化窗口的滚动条就在
  屏幕右缘）；底/顶/左边必须贴死（1.x `lib/widget.js` 同款；在底边也扣会让角色悬空）。
  角色名跟 `overlay/roles.js`（嘎啦嘛/大肥鱼/GPT娘/kimi娘/小克/哈基米），
  文档与提示不要用「狐狸/大鱼」等代称。
- 权限卡（`#perm`，宠物层）：`alertdialog`，只有「允许一次 / 拒绝 / 去宿主处理」；
  高风险无「允许一次」；`allowOnce` 关闭或分支 B 时只剩拒绝与跳转；超时显示
  「已超时，请在宿主窗口处理」4 秒后收起。控制台横幅（`perm-banner`）同口径。
- 音效（1.x v1.16.3 迁移）：内置三套 duck/fx1（显示名「嘀嘟」）/nya（猫娘，CC0 出处见
  `dock/NOTICE`）；按压时序不改（release 在 press 结尾前 100ms 起播，猫娘定稿依赖此时序）；
  导入集播放经主进程二进制 IPC 转 Blob，渲染层仍零 fetch。`soundSet` 在 daemon settings。
- 接入向导（`ui/components/wizard.mjs`）：只在未完成 onboarding 且发现宿主/旧数据时首启，
  「关于与诊断」可重开；**不自动写宿主配置**，集成插件由用户手动添加；daemon 刚起时窗口
  枚举可能慢半拍，向导有「重新检测」。
- UI 文案与文档用中文，术语沿用 `docs/dock/UI-SPEC.md`，不要临时造同义词。

## 测试与基线

- 提交前跑 `npm run ci`。改 UI/交互再跑 `npm run test:ui`、`npm run test:e2e:pages`、
  `npm run test:electron:console`、`npm run visual`、`npm run test:pet`。
- 视觉基线共 128 张，动态内容用 `data-visual-mask` 遮罩；环境不符（`ENV-MISMATCH`）
  时**不得**更新基线。基线只在固定机器 / 固定 Edge 版本生成。**本机 Edge 已自动从 155
  升到 156**，pre.3 的视觉基线需回 155 固定环境补跑。
- pre.3 新增测试：`risk`（73 条表驱动正反例）、`actions`（broker 单测 + 真 daemon 集成）、
  `hook-script`（子进程六断言：fail-open、deny exit 2、分支 A 严格 JSON、开关降级）、
  `hook-sync`（副本逐字节 + 市场清单形态）、`sounds`（内置三套/导入/魔数/回落/旧集复制）、
  `cache-index`（版本失配丢弃/LRU/原子写/tail restore/删缓存等价性）。
  D056 相关：`session-display-status`（5 分钟窗口边界、turnActive 上限、db done/idle 合并、
  `permission_resolved` 续命、计数同源）、`zcode-workflow-status`（`dwf_run` 在跑/结束起算、
  无 workflow 表的老库）、`zcode-cancelled-status`（手动停止 = idle、不落 doneAt、筛选口径），
  以及 e2e `sessions-status`（已完成行/计数/筛选、UI 不信陈旧 working）与
  `pet-status`（快览卡 displayStatus、胶囊计数回落、CommandCode 无滚动条、1.8s 晚到内容、
  贴角气泡不被快览卡挤飞、refit 重读原点、失焦兜底贴角、pointercancel、preload onStream）。
  `ui-regressions` 另覆盖：总览读 displayStatus、上下文切换失败不残留旧数据、预算逐键
  输入、积分图、日期键盘焦点、诊断导出禁用、待处理全局计数。
- 已知偶发失败：`anchor: 绑定后狐狸停在放下的位置`、`pet: 单击角色打开快览卡`、
  `大浮窗打开时气泡避开浮窗`、`restore.itest` 的恢复绑定用例受窗口动画/前台焦点影响；
  `npm run test:all` 首跑与机器高负载时的整跑也可能级联命中更多焦点类用例。
  定责方法：单文件/单用例复跑；仍可疑时用 `git stash push -- <文件>` 做对照实验，
  不要据此改交互：

  ```bat
  node --test --test-concurrency=1 test/integration/overlay.itest.mjs
  ```

- 点击类 overlay 测试必须先等狐狸位置稳定（吸附重绑定 + `#fox` 有 140ms left/top 过渡，
  旧坐标会落空并触发「点外关闭」）。集成测试会在真实桌面弹出测试宠物窗口，跑之前
  提醒用户属正常现象。
- **同一测试进程并发两个 `wait` 长轮询会触发 undici 响应配对错乱**（daemon 侧发送正确）：
  测试与钩子都按「一次只挂一个长轮询」写，响应里用自带 requestId 做身份断言。

- daemon 端口被占会自动 +1；测试与诊断认 lock 文件里的实际端口，不要硬编码 39401。

## 已知坑

- `node:sqlite` 需要 Node ≥22.5；Windows 文件锁会让测试偶发 EPERM，DB 句柄要关，
  测试清理要留重试。
- 浮层 / PowerShell Win32 桥是长生命周期进程，桥退出后 daemon 应能自动重启；
  排障看 `/v1/health` 与 `doctor`，不要只看缓存状态。显示缩放/分辨率/工作区变化
  由浮层监听 `display-metrics-changed`（含 added/removed）自动重设窗口；缩放变化时
  浮层调用 `POST /v1/maintenance/bridge-restart` 重建桥（桥的 DPI 上下文在启动时
  固定，旧缩放会让 `/rect` 偏大 1.5/1.25 倍、角色落到宿主窗口下方），再让渲染层
  立即 `refit()` 重读矩形。不要靠「重启 fox-dock」来修这类问题。
- 会话状态展示统一读服务端 `displayStatus`（D056）：`done` 只是回合结束后 4 秒的机器状态，
  `doneAt` 撑住 5 分钟「已完成」；`turnActive`（钩子回合边界，15 分钟上限）与
  `workflowBusy`（`dwf_run`/`workflow_run` 仍在跑）压制 done/idle；根会话合并子会话与
  workflow 状态。状态筛选、计数、SSE 摘要与控制台/胶囊/快览卡都不得自己按
  `status==='done'` 或旧 `working` 推断。
- 会话模型/厂商显示取最近一次调用；会话计数按根会话。浮层不要用 `/hit` 的
  “宿主不在最上层”来决定整体显隐，否则输入法辅助窗/QQ/全屏播放器会让角色吸附后消失。
  失去吸附时统一落右下角，并写回 `floating.rect`，避免下次轮询把角色拉回宿主坐标。
- SSE 正常 EOF 也必须重连；控制台「连接中断」先查重连循环与 daemon 重启窗口。
- 控制台白屏先看 `<数据目录>/console-crash.log`（渲染进程崩溃原因与近 60s 次数）：
  主进程按 0/1/3/10/30s 退避重载，页面渲染错误由 `ErrorBoundary` 兜成错误卡（D055）。
  改 UI 后必须重开控制台窗口才会加载新 DOM。
- 旧的兼容入口（旧挂件把 `Notification/PermissionRequest` 转发到 `POST /v1/events`）必须保留。
- ZCode 头部给了**双别名**字段（`tool_name`/`toolName`、`tool_input`/`toolInput`、
  `session_id`/`sessionId`、`hook_event_name`/`hookEventName`），还有 `requestId`、
  `riskLevel`、`permission_mode`、`turnId`、`traceId` 可直接用；不要自己猜字段名。
- 本地市场装 directory 插件时「复制进插件缓存」可能**静默失败**（安装记录在、缓存目录空、
  界面回弹无提示）：手动把 marketplace 快照复制进 `~/.zcode/cli/plugins/cache/<market>/<name>/<ver>/`
  后重启客户端；`node E:\ZCode\resources\glm\zcode.cjs plugins list --json` 可验证注册与
  `runnable`。本地目录型市场必须有根级 `marketplace.json`（自引用 `source: "."`）。
- 临时探针插件（`fox-dock-hook-probe@fox-dock-probe-market`）测完应从用户的 ZCode 插件管理
  卸载；`node tools/probe-zcode-hook.mjs` 生成的 Temp 目录可删。
- 本机同时运行着 1.x 线的 WorkBuddy 挂件（`.workbuddy\plugins\data\fox-widget-fox-local`），
  桌面上可能出现第二只「狐狸」——那是旧线浮层，不是 2.0 的孤儿进程，2.0 浮层会按窗口标题
  把它识别为另一条线并忽略。

## 发版纪律（务必遵守）

- 未经明确人工批准，**不要**改版本号、打 tag、签名或修改 `docs/dock/update.json`。
- `docs/dock/release-notes-pre.3.html` 是本版对外的图文更新说明，不是一次性产物：
  任何用户可感知的新功能、行为变化或修复，都要判断是否补进去（改文案、加修复条目、
  必要时补图），不要只在 `CHANGELOG.md` 记录而忽略该文件；只改说明，不因此改版本号或发版。
  更新说明页的图示红线见 `docs/dock/release-notes-*.html` 的既有样式与
  `release-notes-html-diagram-rules` 记忆（wobble 不上文字组、箭头贴边、角色名跟 roles.js）。
- 2.0 只发 `dock-v*` GitHub prerelease（`dock-pre` 线）；1.x 的 `v*` / `wb-v*` 不在本线。
- 版本号按 `chore(release)` 独立提交；tag 打在「版本号已更新」的提交链上（pre.2 实操：
  tag 最终落在含签名清单的最后一个提交）。
- 发版实操（在 `dock/` 下）：
  `node tools/pack-release.mjs --version <ver> --url <release 下载直链> --sign --notes "…"`
  打出 `dist/dock-<ver>.tar.gz` 并签名 `docs/dock/update.json`（私钥默认
  `%USERPROFILE%\fox-dock-release-key.pem`），提交清单后 push 分支 + tag，
  `gh release create` 挂 tar.gz 与图文更新说明 HTML（`docs/dock/release-notes-*.html`）。
  加 `--portable` 额外产出 `dock-<ver>-portable.tar.gz`（解压即用，校验 `launch/` 启动件并
  附 `PORTABLE-README.txt`；签名机制不变）。
- pack 私钥体检会拦**任何**连续的 `-----BEGIN … PRIVATE KEY-----` 字面量：测试里的
  假 PEM 必须用字符串拼接构造（`redact.test.mjs` 是范例）。
- 更新清单必须带 sha256 与 Ed25519 签名；签名后不要再改任何被跟踪文件。
- 提交信息用 Conventional Commits（见根 `CONTRIBUTING.md`），subject ≤72 显示列。
  Mimosa Git 门禁在提交前做安全扫描：被拦时先自查渲染层 fetch / 私钥字面量，不要绕过。

## 动手前建议阅读

- `docs/dock/PLAN-pre.2-truth-layer.md`：当前方案与不可碰清单
- `docs/dock/DECISIONS.md`：D001–D057，冲突时以决策记录为准（D050 权限接管与分支 A 结论、
  D051 语音库迁移、D052 向导/增量缓存/便携包、D053 套餐按模型分桶进度条、
  D054 会话成本口径与分段计价、D055 控制台渲染错误兜底与崩溃自愈、
  D056 已完成展示窗口/回合活跃/workflow 父会话与手动停止修订、
  D057 宠物层零网络 SSE 代理与输入链路自愈）
- `docs/dock/ADAPTERS.md`：适配器契约、失败语义与实时信号矩阵（含 P-2 真机结论）
- `docs/dock/TESTING.md`：分层测试、夹具、已知偶发失败、pre.3 增量
- `docs/dock/UI-SPEC.md`：页面结构、设计令牌、验收清单
- `dock/README.md`：安装、启动、四宿主与宠物层行为
- `E:\WorkSpace\zcode-fox-widget\MIGRATE-TO-FOX-DOCK-2.md`：1.x → 2.0 迁移方案（硬边界：
  不得影响 1.x 现有升级系统，每步可回滚；尚未在该仓库提交/实施）
