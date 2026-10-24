# AGENTS.md

面向在本仓库工作的 ZCode agent。先读本文件，再按任务读 `docs/dock/` 下的专项文档。

## 仓库结构：两条独立产品线

| 路径 | 产品 | 当前分支 | 约束 |
|---|---|---|---|
| 仓库根（`lib/`、`desktop/`、`hooks/`、`skills/`、`.zcode-plugin/`） | ZCode 狐娘小挂件 1.x | `main` / `workbuddy` | `dock-pre` 分支上**不要改** |
| `dock/` | fox-dock 2.0 通用桌宠（独立程序） | `dock-pre`（同源长分支 `feat/dock`） | 本线主体 |
| `docs/dock/` | 2.0 方案、决策、测试、UI 规格 | `dock-pre` | 与 `dock/` 同步更新 |

`dock-pre` 上的所有改动只落在 `dock/` 与 `docs/dock/`（`docs/dock/PLAN-pre.2-truth-layer.md` §0）。
1.x 的版本号来源是根 `.zcode-plugin/plugin.json`；2.0 的版本号来源是 `dock/package.json`，两者互不影响。
当前 `dock-pre` 的 pre.2 主体已完成但**未发版**；pre.3（权限接管 / 自定义 agent）尚未完成。发版等人工放行。

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
```

浏览器用本机 Edge（`channel:'msedge'`），不要下载 Chromium。

## 架构边界

- `dock/adapters/<id>/`：只读宿主数据，按 `docs/dock/ADAPTERS.md` 实现并在
  `adapters/registry.mjs` 注册。认不出就落 `generic`，读不到就报错或 `null + unavailable`，
  **绝不编 0**。唯一写回宿主的是 Kimi OAuth token 的原子刷新。
  ZCode 会话的 `model/provider` 取**最近一次真实调用**（按 `lastAt`），不要退回
  `models.find(...)` 的第一个历史模型；会话分页按根会话，子会话随父返回。
- `dock/daemon/`：常驻服务，负责窗口发现/绑定、`/v1` REST、SSE、设置、保险库、账本、调度。
  UI 不得直接读宿主文件，所有数据走本机 HTTP（`x-fox-token`）。会话 `counts` 与胶囊状态
  按**根会话**统计，子任务状态归并到父会话，不能把子会话重复计数。
- `dock/shared/`：daemon 与 UI 共用的纯模块（`session-model`、`live-reduce`、`provenance`、
  `redact`、`tail` 等）。新增跨层逻辑放这里，不要把宿主读取塞进 UI。
- `dock/ui/`：Preact + htm（vendored）无构建渲染层；数据入口是 `ui/console.mjs`；
  图表是 `ui/charts/svg.mjs` 手写 SVG。不要引入打包器、Chart.js、React。
- `dock/console/` 与 `dock/overlay/`：两个 Electron 入口（控制台 / 透明宠物层）。
  `overlay/main.cjs` 里的 `type:'toolbar'` 是宿主冻结事故的守卫，**不得删除**。
- `dock/engines/`：厂商模板与计价。`pricing.mjs`、`cmdgo.mjs`、`relays.mjs` 是
  `../lib/` 同名文件的**逐字节副本**，禁止手改；`npm run check:sync` 会失败。
  需要改价目时，源头在 `lib/`（会影响 1.x 线，先与维护者确认），再用
  `node tools/check-pricing-sync.mjs --fix` 同步副本。GLM Plan / 赠送额度走
  `engines/plan-balance.mjs` + `engines/glm-plan-api.mjs`，不要另起一套套餐配额。

## 硬性约束

- **不自动写宿主配置**；权限接管默认关闭，**永不提供 always-allow**，只允许「允许一次 / 拒绝」，
  超时或任何失败都 fail-open 回宿主原生弹窗。
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
- 运行时零 npm 依赖。不要在 `dock/package.json` 加依赖；确需测试工具时只加到
  `dock/test/package.json`。

## UI 约定

- 颜色、间距、字号只取 `ui/tokens.css`：字号仅 12/13/14/16/20/24/32/40，间距 4/8/12/16/24/32，
  图表序列色用 `--c1..--c7`。正文 13px，最小 12px。
- 固定 9 页：总览、会话、用量、统计、额度与余额、厂商与密钥、角色与气泡、设置、关于。
  上下文是「会话」详情的标签，不是独立页。
- 交互元素必须有可访问名称；图表必须有 `role="img"` + `aria-label`；装饰图标
  `aria-hidden`。新增页面/关键控件要带稳定 `data-testid`。
- 动画红线（D039）：只允许状态存续期间的功能性动画（`fd-spin`、一次性 `fd-nudge`）；
  空闲场景不得有无限动画，`prefers-reduced-motion` 下全部关闭。
- 宠物层交互：隐藏金额时隐藏整个小胶囊（不是把金额改成 `•••`）；快览卡不放
  「打开会话页」页脚；刷新键用控制台同款 SVG 并绝对定位右上角；台词/消耗气泡不得压
  快览卡或越出视口；宿主最小化/关闭/失前台（约 3 秒防抖，D044）后角色回落到
  屏幕右下角、回前台自动恢复吸附，不要恢复
  「宿主不在最上层就整体 opacity 0」的 z-order 隐身；浮层窗口四周留 4 DIP
  任务栏安全边距（D043），兜底位贴紧工作区角落。
- UI 文案与文档用中文，术语沿用 `docs/dock/UI-SPEC.md`，不要临时造同义词。

## 测试与基线

- 提交前跑 `npm run ci`。改 UI/交互再跑 `npm run test:ui`、`npm run test:e2e:pages`、
  `npm run test:electron:console`、`npm run visual`、`npm run test:pet`。
- 视觉基线共 128 张，动态内容用 `data-visual-mask` 遮罩；环境不符（`ENV-MISMATCH`）
  时**不得**更新基线。基线只在固定机器 / 固定 Edge 版本生成。
- 已知偶发失败：`anchor: 绑定后狐狸停在放下的位置`、`pet: 单击角色打开快览卡`、
  `大浮窗打开时气泡避开浮窗` 受窗口动画/前台焦点影响；`npm run test:all` 首跑也可能
  命中。用单文件复跑确认，不要据此改交互：

  ```bat
  node --test --test-concurrency=1 test/integration/overlay.itest.mjs
  ```

- daemon 端口被占会自动 +1；测试与诊断认 lock 文件里的实际端口，不要硬编码 39401。

## 已知坑

- `node:sqlite` 需要 Node ≥22.5；Windows 文件锁会让测试偶发 EPERM，DB 句柄要关，
  测试清理要留重试。
- 浮层 / PowerShell Win32 桥是长生命周期进程，桥退出后 daemon 应能自动重启；
  排障看 `/v1/health` 与 `doctor`，不要只看缓存状态。
- 会话模型/厂商显示取最近一次调用；会话计数按根会话。浮层不要用 `/hit` 的
  “宿主不在最上层”来决定整体显隐，否则输入法辅助窗/QQ/全屏播放器会让角色吸附后消失。
  失去吸附时统一落右下角，并写回 `floating.rect`，避免下次轮询把角色拉回宿主坐标。
- SSE 正常 EOF 也必须重连；控制台「连接中断」先查重连循环与 daemon 重启窗口。
- 旧的兼容入口（旧挂件把 `Notification/PermissionRequest` 转发到 `POST /v1/events`）必须保留。

## 发版纪律（务必遵守）

- 未经明确人工批准，**不要**改版本号、打 tag、签名或修改 `docs/dock/update.json`。
- 2.0 只发 `dock-v*` GitHub prerelease（`dock-pre` 线）；1.x 的 `v*` / `wb-v*` 不在本线。
- 版本号按 `chore(release)` 独立提交；tag 必须打在版本号已更新的提交上。
- 更新清单必须带 sha256 与 Ed25519 签名；签名后不要再改任何被跟踪文件。
- 提交信息用 Conventional Commits（见根 `CONTRIBUTING.md`），subject ≤72 显示列。

## 动手前建议阅读

- `docs/dock/PLAN-pre.2-truth-layer.md`：当前方案与不可碰清单
- `docs/dock/DECISIONS.md`：D001–D042，冲突时以决策记录为准
- `docs/dock/ADAPTERS.md`：适配器契约与失败语义
- `docs/dock/TESTING.md`：分层测试、夹具、已知偶发失败
- `docs/dock/UI-SPEC.md`：页面结构、设计令牌、验收清单
- `dock/README.md`：安装、启动、四宿主与宠物层行为
