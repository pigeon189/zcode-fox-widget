# 代码审查报告：feat/dock 5f61716..f6fb683（2.0.0-pre.1 发布前） 2026-10-20

## 审查范围与方法

- 仓库根目录：`E:\WorkSpace\fox-dock`
- 审查工作树：`E:\WorkSpace\fox-dock`
- 分支：`feat/dock`
- 提交范围：`5f61716..HEAD`（HEAD `f6fb683`，共 6 个提交）
- 审查日期：2026-10-20；审查时间上限 45 分钟
- 旧线 shim：本轮范围不包含 `main` / `workbuddy` 分支的 shim 改动，未审查。
- 范围例外：按派发者补充参数，本轮允许根级 `lib/pricing.mjs`、`lib/cmdgo.mjs`、`lib/relays.mjs` 与根 `CHANGELOG.md` 的价目同步改动；其余改动应只在 `dock/`、`docs/dock/`、CI。已核对：`git diff --name-only 5f61716..HEAD` 除上述例外外没有其它越界文件。
- 隔离：只读取仓库文件、当前分支历史、`docs/` 与命令输出；未读取实现者对话、阶段报告或提交说明中的自我评价；未修改被审代码、未提交、未切换分支、未打 tag/release。临时探针只使用系统临时目录。

### 实际运行的命令与结果

| 命令 | 结果 |
|---|---|
| `cd dock && npm run ci` | **exit 0**。语法检查通过；价目同步一致（`✅ 价目内核与挂件线一致（33656 字节）`）；单元测试 **218/218 pass**；`lint 通过：232 个文件`；engines parity 通过（价目 6 组、计费源 7 组、平台用量 1 组）。 |
| `npm run test:all` | **exit 0**。`tests 284 / pass 284 / fail 0 / skipped 0`，duration 87.5s（含 Win32、daemon、v1、overlay Electron 集成测试）。 |
| `npm run test:ui` | **exit 0**。`UI 自检通过：8 页 × 2 主题 × 2 视口（布局 / 可访问名称 / axe）`。 |
| `npm run visual` | **exit 0**。`✅ 视觉回归通过：32 张（阈值 0.1%）`。 |
| `npm run test:pet` | **exit 0**。`已生成 40 张宠物层截图`。 |
| `npm run test:electron:console` | **exit 0**。`✅ 控制台真窗口冒烟通过（页面加载 / 无 JS 异常 / 关键文本 / 截图）`。 |
| 附加探针（仓库外临时目录） | 角色导入持久化、CommandCode GOAT 塑形、`zcodeDataBase` 路径、GIF 校验负例；结果见问题条目。 |

### 未覆盖或无法验证

- 真实 ZCode / WorkBuddy / Kimi Code / dsh 窗口上的四宿主吸附与最上层窗口行为：测试使用 `--allow-generic` 并忽略其它窗口，未在真实重叠窗口桌面复现。
- 真实 CommandCode `/alpha/billing/subscriptions` 响应是否包含 `createdAt`：按隔离要求未向外部网络发请求，无法确认真实字段。
- 真实 GIF 在 Electron 中的动画渲染与 alpha 掩码：未做真机截图/点击穿透探针。
- 真实更新清单下载、Ed25519 验签、替换与回滚：未运行。
- 旧线 shim、真实宿主导入、125%/150% DPI、多显示器、8 小时 soak：未运行。
- `test:all` 只完整运行 1 次（284/284）；未做多次重复以评估外部窗口干扰。

## 结论

**REQUEST_CHANGES**

P1 = 0；P2 = 3；P3 = 8。P2 集中在角色导入的持久化、CommandCode GOAT 新老账户判定、以及 daemon 自身 runtime-env 兜底路径；其余为文档、测试与 CI 守卫问题。

## 问题

### [P2-1] 导入角色无法保存到任何档案或全局设置，选择后会被下一轮同步改回

- 位置：
  - `dock/daemon/src/settings.mjs:17`（`ROLES` 只含六个内置 id）
  - `dock/daemon/src/settings.mjs:142`、`:188`、`:248`、`:332`（档案、补丁、全局、按适配器映射都用 `ROLES` 白名单）
  - `dock/overlay/pet.js:996-1003`（`pickRole` 直接把导入角色 id 写入 `/v1/profiles/:id`）
  - `dock/ui/pages/roles.mjs:59-62`（控制台 `pick` 同样写档案）
- 期望：无明确规范，属实现缺陷。角色库/浮层菜单已经允许点击导入角色，至少应能把该 id 持久化到档案或全局设置；否则“导入角色”功能不可用。
- 实际：`writeProfile()` 最终走 `writeSettings()` → `normalizeSettings()`，`normalizeProfilePatch()` 只接受 `ROLES` 内的六个内置 id，导入角色 id 被静默丢弃（存储里的覆盖记录为空对象，读回的 `profile.roleId` 为空）。控制台仍提示“已保存”；浮层 `pickRole` 当前帧能显示导入角色，但下一次 `refreshState()` → `applySettings()` → `syncRole()`（约 1.5s 内）会回落到内置角色。
- 复现：
  1. 在临时目录调用 daemon 的 `writeProfile(file,'zcode',{roleId:'my-gif'})`，或启动 daemon 后 `PUT /v1/profiles/zcode {"roleId":"my-gif"}`。
  2. 读取返回的 `profile` / `GET /v1/profiles/zcode`。
  3. 或在控制台导入一个角色，点击该角色卡片，再等待浮层刷新。
- 证据：
  ```text
  cd dock && node -e "const fs=require('fs'),os=require('os'),path=require('path');const d=fs.mkdtempSync(path.join(os.tmpdir(),'fox-set-'));const f=path.join(d,'settings.json');import('./daemon/src/settings.mjs').then(m=>console.log(JSON.stringify(m.writeProfile(f,'zcode',{roleId:'my-gif'}).profiles.zcode)))"
  {}
  ```
  代码路径：`normalizeProfilePatch` 的 `if (ROLES.includes(role) || role === '')`；`normalizeSettings` 的 `ROLES.includes(roleRaw) ? roleRaw : DEFAULTS.roleId`。
- 频率：确定。
- 影响：本轮新增的 PNG/GIF 导入只能“看到”，不能真正启用；控制台给出误导性成功提示；浮层选择后 1.5s 内回退，用户会认为角色切换失效。该白名单不是本轮新增，但本轮的角色目录/导入路径仍受它限制。
- 建议（非强制）：把角色 id 校验从固定 `ROLES` 扩展到“内置 id + 角色库中存在的 id”（例如在 daemon 侧注入 `listRoleLibrary` 或使用安全正则 + 文件存在性校验）；补一条“导入角色 → 写入档案 → 重读设置仍保留”的集成测试；控制台在返回 profile 未包含目标 id 时不要提示成功。

### [P2-2] CommandCode GOAT 新账户在缺少 `createdAt` 或走本地账号池时仍按老账户 $70 计算

- 位置：
  - `dock/engines/cmdgo.mjs:62-70`（`isLegacyGoat` 只认字符串 `createdAt`，缺失时用 14/35 帽对兜底）
  - `dock/engines/cmdgo.mjs:124-129`（官方订阅路径）
  - `dock/engines/cmdgo.mjs:362-365`（本地池路径传 `null`，必然走帽对兜底）
  - `dock/test/unit/cmdgo.test.mjs:20-25`（只测试了人造的 `createdAt`，未覆盖真实订阅形状/新池账户）
- 期望：`dock/CHANGELOG.md:33` 明确“GOAT 月度 credits 新账户为 $80；2026-10-20 前创建的订阅保留 $70，额度卡会标注「老账户」”。新账户应显示 $80 并在百分比上以 80 为分母。
- 实际：本文件头部对 `/alpha/billing/subscriptions` 的说明只有 `planId / currentPeriodEnd`（best effort），没有 `createdAt`。当响应缺少 `createdAt` 时，`isLegacyGoat` 退回帽对判断；而 `CMDGO_PLANS` 中 GOAT 的新旧账户帽对都是 14/35，因此任何 GOAT 账户都会得到 `legacy=true`、`total=70`。本地池路径更是直接传 `null`，不存在区分新老账户的可能。
- 复现：
  1. 用本模块声明的订阅字段构造响应：`{planId:'individual-goat', currentPeriodEnd:'2026-11-20T00:00:00Z'}`。
  2. 按 `shapeCmdgoUsage(credits, subscription)` 计算，`credits.monthlyCredits=40`、5h/周窗口存在。
  3. 观察 `monthly.total` 与 `monthly.legacy`。
- 证据：
  ```text
  cd dock && node -e "import('./engines/cmdgo.mjs').then(m=>{const c={credits:{monthlyCredits:40},windowLimits:{fiveHour:{used:1,cap:14},weekly:{used:2,cap:35}}};const r=m.shapeCmdgoUsage(c,{success:true,data:{planId:'individual-goat',currentPeriodEnd:'2026-11-20T00:00:00Z'}});console.log(JSON.stringify({total:r.monthly.total,legacy:r.monthly.legacy,percent:r.monthly.percent}))})"
  {"total":70,"legacy":true,"percent":0.42857142857142855}
  ```
  若真实接口提供 `createdAt` 且为新账户，结果才会是 80；该字段是否存在未验证（见“未验证”）。
- 频率：确定（当订阅响应缺少 `createdAt`，或使用本地池时）；真实 API 是否总返回 `createdAt`：UNVERIFIED。
- 影响：2026-10-20 后新订阅的 GOAT 用户会看到 $70 月度池和偏高的已用百分比（例如剩余 40、总额 80 时实际已用 40/80 = 50%，被按 40/70 = 57.1% 显示），并被错误标注“老账户”。
- 建议（非强制）：以官方实际返回字段为准做新老判定（`createdAt` / `startDate` / `currentPeriodStart` 等，需真实响应确认）；无法判定时不要把“缺少字段”当成老账户，可显示“账户类型未识别”并给出 80/70 的说明；本地池若 `/health` 提供套餐或创建时间则透传，否则不要静默按 70；补充真实响应形状的单元夹具，并覆盖 2026-10-20 的时区边界（当前用 `Date.UTC`，与“本地日期”口径需明确）。

### [P2-3] daemon 自己持久化的 runtime-env 兜底文件写到 engines 读取路径的上一层，开机自启时仍找不到

- 位置：
  - `dock/daemon/src/daemon.mjs:183-195`（把 `runtime-env.json` 写到 `paths.dir`，随后才 `process.env.FOX_DOCK_DATA = paths.dir`）
  - `dock/engines/paths.mjs:4`（注释称数据目录是 `%LOCALAPPDATA%\fox-dock` 或 `FOX_DOCK_DATA`）
  - `dock/engines/paths.mjs:30-39`（`DATA_DIR = path.join(FOX_DOCK_DATA || LOCALAPPDATA, 'fox-dock')`）
  - `dock/engines/paths.mjs:79-90`（`zcodeDataBase` 读取 `DATA_DIR/runtime-env.json`）
  - `dock/daemon/src/v1.mjs:20` → `dock/daemon/src/roles.mjs:14`（静态导入 `engines/paths.mjs`，在 daemon 设置环境变量之前就冻结了 `DATA_DIR`）
- 期望：`dock/CHANGELOG.md:13` 与本轮代码注释都声称“dock 自己也持久化一份”ZCode 数据目录，开机自启/普通终端拉起 daemon 时没有 `ZCODE_DATA_BASE_DIR` 也能从自身记录恢复，避免 CommandCode / GLM Plan 凭据整体消失。
- 实际：daemon 写入 `<data-dir>/runtime-env.json`；engines 的 `DATA_DIR` 在 `FOX_DOCK_DATA=<data-dir>` 时是 `<data-dir>/fox-dock`，`zcodeDataBase` 去读 `<data-dir>/fox-dock/runtime-env.json`，永远读不到 daemon 写的那份。默认安装（`%LOCALAPPDATA%\fox-dock`）同样命中这个嵌套路径。`zcodeDataBase` 只剩旧挂件的 `~/.zcode/whale/runtime-env.json` 可能兜底；干净安装（没有旧挂件）时“自身记录”失效。
- 复现：
  1. 临时目录 `T` 作为 data dir，写入 `T/runtime-env.json`（内容 `{"ZCODE_DATA_BASE_DIR":"C:/host-base"}`）。
  2. 设置 `FOX_DOCK_DATA=T`、`ZCODE_HOME=<空的临时目录>`，导入 `engines/paths.mjs`。
  3. 调用 `zcodeDataBase({})`，并检查 `DATA_DIR` 下是否存在 `runtime-env.json`。
- 证据：
  ```text
  DATA_DIR C:\Users\<user>\AppData\Local\Temp\fox-env-...\fox-dock\fox-dock
  zcodeDataBase ""
  runtime exists at DATA_DIR? false
  ```
  静态导入链：`daemon.mjs` → `v1.mjs:20` → `roles.mjs:14` → `engines/paths.mjs`；`process.env.FOX_DOCK_DATA` 在 `daemon.mjs:195` 才设置，无法影响已求值的 `DATA_DIR`。这同时说明 `--data-dir` 自定义目录不会被 engines 的 `DATA_DIR` 采用（既有路径语义问题）。
- 频率：确定。
- 影响：无旧挂件的新用户重启后仍可能丢失 CommandCode / GLM Plan 等由 provider 配置发现的凭据；本轮宣称的“自身记录”兜底实际不生效。该路径还会让 engines 的 `CONFIG_FILE` 等数据落在 `<data-dir>/fox-dock`，与 daemon 的 `paths`（`<data-dir>`）分裂。
- 建议（非强制）：统一 `FOX_DOCK_DATA` 语义（把它当作完整数据目录，或让 daemon 写入 engines 的 `DATA_DIR`）；避免在设置环境变量前静态导入 `engines/paths.mjs`（例如把 `BUILTIN_ROLES` 移到无路径依赖的模块，或改为惰性读取）；补一条使用临时目录的 `zcodeDataBase` 测试，覆盖默认目录与 `--data-dir` 两种启动方式。

### [P3-1] 角色库轮询定时器被注册了两次，30 秒一次变成 30 秒两次

- 位置：`dock/overlay/pet.js:1294-1295`
- 期望：每个轮询只注册一次，避免重复请求/重复 IPC。
- 实际：连续两行 `setInterval(loadRoleCatalog, 30000)`；每次触发都会请求 `/v1/roles`，并对每个导入角色调用 `getRoleImage` IPC。
- 复现：`grep -n "setInterval(loadRoleCatalog" dock/overlay/pet.js`。
- 证据：两行相同调用；`loadRoleCatalog` 在 `:226-255` 会重建整个角色目录并 `syncRole`。
- 频率：确定。
- 影响：导入角色较多或 GIF 较大时，IPC/内存开销翻倍；属于明显的复制粘贴残留。
- 建议（非强制）：删除其中一行；如需要并行刷新，改为单一节流函数。

### [P3-2] GIF 导入只校验签名/尺寸，13 字节的残缺文件也会被接受；测试 GIF 本身不是可解码文件

- 位置：
  - `dock/daemon/src/roles.mjs:72-84`（`inspectGif` 只读逻辑屏幕宽高）
  - `dock/daemon/src/roles.mjs:86-91`（`inspectImage` 分流）
  - `dock/test/unit/roles.test.mjs:43-50`（`makeGif` 仅 14 字节，没有图像描述符/数据/结束符）
- 期望：`docs/dock/TESTING.md:82` 的角色导入安全要求至少包括签名、大小、尺寸、id 白名单和原子写；GIF 作为新格式也应保证文件可解码，或明确记录这是仅签名校验的降级。
- 实际：一个仅含 `GIF89a` + 宽高的 13 字节文件被 `importRole` 接受并写成 `bad-gif.gif`；浏览器无法显示，导入接口仍返回 `ok:true`。没有帧数/结构/结束符校验，也没有端到端“导入后能显示”的测试。
- 复现：
  1. 构造 13 字节 `GIF89a` 头（宽 4、高 6）。
  2. 调用 `importRole({rolesDir,indexFile,id:'bad-gif',name:'bad',buffer})`。
- 证据：
  ```text
  ACCEPTED {"id":"bad-gif","name":"bad","width":4,"height":6,"format":"gif"} bytes 13
  ```
- 频率：确定。
- 影响：用户导入损坏/伪造 GIF 后得到空白角色；测试无法证明 GIF 路径真正可用；仅签名校验对解压炸弹/异常帧没有上限（风险未实测）。
- 建议（非强制）：至少校验 GIF trailer（`0x3B`）/是否含图像描述符，限制帧数；补一个真实可解码的小 GIF 作为端到端夹具，并断言导入后 `<img>` 能加载。

### [P3-3] UI-SPEC 新增的“控制台不使用原生 `<select>`”与事实不符；角色导入文档仍写 PNG-only

- 位置：
  - `docs/dock/UI-SPEC.md:13-14`（声明控制台下拉都用自绘 `Select`）
  - `dock/ui/pages/context.mjs:77`（仍使用原生 `<select class="select">`）
  - `docs/dock/UI-SPEC.md:52`（“导入（PNG 校验、删除）”）
  - `docs/dock/TESTING.md:82`（安全测试仍写“PNG 签名 + 全 chunk CRC”）
- 期望：文档描述与实现一致；本轮新增 GIF 导入后，角色导入的安全/验收口径应更新。
- 实际：上下文页的会话选择仍是原生 `<select>`；角色导入文档只写 PNG，没有 GIF 的签名/尺寸/测试要求。
- 复现：`grep -n "<select" dock/ui/pages/context.mjs`；查看上述文档行。
- 证据：代码与文档行如上。
- 频率：确定。
- 影响：维护者按 UI-SPEC 验收会误判；安全测试清单遗漏 GIF 路径。
- 建议（非强制）：要么把上下文页也换成 `Select`，要么把 UI-SPEC 改成“设置页/导入向导使用自绘控件”；同步 UI-SPEC/TESTING 的 PNG/GIF 描述。

### [P3-4] `test:pet` 文档命令只生成 20 张却写 40 张，并列出并不存在的“自由位置”截图状态

- 位置：`docs/dock/TESTING.md:13`；`dock/tools/pet-shots.mjs:43-55`；`dock/package.json:39`
- 期望：文档中的命令、状态列表与张数与实际门禁一致。
- 实际：文档命令是 `npm run shots:pet -- --theme light,dark --viewport 1280x720`（10 个状态 × 2 主题 = 20 张），文字却写“共 40 张”；`STATES` 只有四角、悬浮、快览、菜单、气泡、台词、隐藏金额，没有“自由位置”状态。实际 40 张来自 `test:pet` 的 `--viewport 1280x720,960x680` 双视口。
- 复现：按文档命令运行会输出 20 张；`grep -n "const STATES" -A 12 dock/tools/pet-shots.mjs`。
- 证据：代码状态列表与 `test:pet` 脚本参数。
- 频率：确定。
- 影响：文档命令不能复现 40 张基线；验收清单与截图状态不一致。
- 建议（非强制）：把文档命令改为 `npm run test:pet`（或加双视口参数）；增加自由位置状态或从文字中移除。

### [P3-5] dock CI 的路径过滤不包含本轮允许改动的根 `lib/` 文件，价目/engines 漂移守卫可被绕过

- 位置：
  - `.github/workflows/dock-ci.yml:8-17`（`paths` 只有 `dock/**`、`docs/dock/**`、workflow）
  - `dock/tools/check-pricing-sync.mjs:16-17`（只比较 `lib/pricing.mjs` ↔ `dock/engines/pricing.mjs`）
  - `dock/tools/parity-engines.mjs:26-38`（只加载/比较 pricing、source、balance，不含 cmdgo/relays）
- 期望：D007 要求价目内核漂移即失败；本轮明确允许根 `lib/pricing.mjs`、`lib/cmdgo.mjs`、`lib/relays.mjs` 同步，CI 应在这些文件单独变更时也运行同步检查。
- 实际：如果只改根 `lib/pricing.mjs`（不改 `dock/`），`dock-ci` 不会触发；`lib/cmdgo.mjs`、`lib/relays.mjs` 没有自动字节比较，`parity:engines` 也不覆盖它们。当前三者与 dock 副本逐字节一致（`cmp` 通过），但守卫本身存在触发/覆盖缺口。
- 复现：`git diff --name-only` 只提交 `lib/pricing.mjs` 时，workflow path filter 不匹配；检查 `parity-engines.mjs` 的加载列表。
- 证据：workflow 与脚本行如上；本次 `cmp -s lib/{pricing,cmdgo,relays}.mjs dock/engines/...` 均一致。
- 频率：确定（流程/守卫缺口）。
- 影响：未来根线单方面改价或改 cmdgo/relays 时，dock 可能继续用旧副本且 CI 绿；用户会看到两边算出的金额不同。
- 建议（非强制）：把 `lib/pricing.mjs`、`lib/cmdgo.mjs`、`lib/relays.mjs` 加入 workflow `paths`；把 `check-pricing-sync` 扩展为这三个文件的逐字节比较，或把 cmdgo/relays 纳入 parity 测试。

### [P3-6] “只吸附四宿主/最上层窗口”没有对应测试，现有集成测试用 `--allow-generic` 绕过了新过滤器

- 位置：
  - `dock/overlay/pet.js:20-24`（`AGENT_EXES` / `ALLOW_GENERIC`）
  - `dock/overlay/pet.js:1008-1046`（`isAgentWindow` + 最上层判定）
  - `dock/test/integration/overlay.itest.mjs:189-195`（`--allow-generic`，并忽略除假 agent 外所有 pid）
- 期望：对本轮核心行为至少各有一条正例和负例测试：非宿主窗口在最上层时不吸附；宿主窗口在最上层时吸附；`AGENT_EXES` 以外的进程被拒绝。
- 实际：测试环境把所有其它窗口 pid 加入 `--ignore-pids`，并打开 `--allow-generic`，因此 `hitAt` 永远拿到假 agent，`isAgentWindow` 的拒绝分支和“最上层优先”分支均未被断言；`isAgentWindow` 也没有导出做单元测试。
- 复现：查看测试启动参数与 `before` 中 `ignore` 构造。
- 证据：`overlay.itest.mjs:194` 的参数；`pet.js` 的过滤逻辑。
- 频率：确定（覆盖缺口）。
- 影响：后续改动把宿主白名单或 topmost 逻辑改坏时，`test:all` 仍可能全绿。
- 建议（非强制）：把 `isAgentWindow`/topmost 选择抽成可测试纯函数；增加“非宿主窗口覆盖宿主”的集成用例（不启用 `--allow-generic`）；在测试里保留一个非宿主顶层窗口作为负例。

### [P3-7] 音效实现默认会播放，但仍保留无效的 `soundEnabled` 设置，且与 D030“默认关”冲突

- 位置：`dock/overlay/pet.js:121-122`（只检查 `settings.dnd`）；`dock/daemon/src/settings.mjs:87-89`（`soundEnabled:false` / `soundVolume` 仍保留）；`docs/dock/DECISIONS.md:235`（D030“音效恢复为默认关”）、`:245`（D031“音效不再单独开关，随勿扰静音”）
- 期望：文档之间应明确最终默认行为；若保持“默认关”，代码应消费 `soundEnabled`；若改成“随勿扰”，应删除或迁移失效字段并在文档中说明默认开。
- 实际：`playSound` 在 `dnd=false`（默认）时直接播放；设置 API 仍暴露 `soundEnabled`，但没有任何消费方，控制台也没有对应开关/音量控件。
- 复现：查看 `playSound` 与 `settings` 默认值；在浮层点击角色会走 `playSound('press')`/`('release')`。
- 证据：代码行如上；`settings.mjs:286` 仍 normalize `soundEnabled`。
- 频率：确定（代码路径；未做音频捕获）。
- 影响：升级后默认出现提示音，与 D030 的既有决策不一致；`soundEnabled` 成为无效配置，用户无法单独关闭声音。
- 建议（非强制）：明确默认值并同步 D030/D031/CHANGELOG；若保留“随勿扰”，删除 `soundEnabled` 或在启动迁移时忽略它；若保留音量能力，补回控制台入口消费 `soundVolume`。

### [P3-8] 总览厂商迷你卡的数值与进度条使用不同窗口（月度池 vs 周窗口）

- 位置：`dock/ui/pages/overview.mjs:11-13`（CommandCode 迷你条取 `v.weekly || v.fiveHour || v.monthly`）；`:23-27`（数值优先取 `v.monthly.remaining`）
- 期望：同一卡片内的主数字与进度条应表达同一指标，或明确标注进度条对应哪个窗口。
- 实际：数值显示月度池剩余（例如 `$40.6`），进度条显示周窗口已用百分比（例如 30%）；两者没有标签区分，用户容易把条理解为月度使用率。
- 复现：用包含 `monthly.remaining`、`weekly.percent` 的 CommandCode 厂商数据渲染总览，读取迷你卡的数值与条宽。
- 证据：上述代码路径；`fixture` 的 commandcode 数据同时含 monthly/weekly。
- 频率：确定。
- 影响：概览页的厂商余额可读性/准确性下降；不是数据计算错误，但会误导。
- 建议（非强制）：迷你条与数值统一使用月度池（或把条改为展示月度 `percent`）；若必须展示周窗口，增加“周”标签。

## 已核对且未发现问题的项

- **范围**：`git diff --name-only 5f61716..HEAD` 仅包含 `dock/`、`docs/dock/` 及允许的根 `lib/{pricing,cmdgo,relays}.mjs`、根 `CHANGELOG.md`；无 `desktop/`、`hooks/`、根 README/CONTRIBUTING 或其它根文件改动。
- **版本/发布隔离**：HEAD `f6fb683` 无 tag；`dock/package.json` 版本 `2.0.0-pre.1`；仓库无 `docs/dock/update.json`、无 `dock/dist`、无 `*.pem` 私钥；`pack-release.mjs` 有私钥内容检测。
- **价目同步**：`npm run check:sync` 通过（33656 字节）；`cmp -s` 确认 `lib/{pricing,cmdgo,relays}.mjs` 与 `dock/engines/` 逐字节一致；新增 Daybreak / mythos preview 别名测试通过。
- **Electron 安全**：`dock/overlay/main.cjs:324` 保留 Windows `type:'toolbar'`；两个窗口均 `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`；`will-navigate`/`setWindowOpenHandler` 拒绝导航；CSP 存在；`lint` 的门禁通过。
- **凭据/密钥**：本轮未新增密钥写入；`v1` 只回掩码；测试探针未发现渲染层可获取 daemon token（`test:all` 中 overlay 测试断言 `typeof getToken === 'undefined'` 通过）；仓库扫描无 `BEGIN ... PRIVATE KEY`。
- **更新路径**：`/update/check` 只读清单并比较版本，无落盘；`fetchManifest` 默认 `requireSignature:true`；`update --apply` 仍走 CLI；未发现未授权 tag/release。
- **角色导入的 PNG 旧路径**：PNG 签名/块 CRC/≤3MB/≤2048²/id 白名单/内置保护/临时文件 rename 的既有单测仍通过；GIF 也执行签名、体积、逻辑尺寸与 id 校验（结构性缺口见 P3-2）。
- **数据口径**：本轮未引入跨单位/跨币种求和；`fmtMoney`/`fmtCredit` 在 `hideMoney` 下掩码；CommandCode 三窗口顺序为 5 小时 → 本周 → 月度池（`windowsOfVendor` 与 `overlay renderQuick` 一致）；额度 `remainingPct`/`usedPct` 由现有契约归一化。
- **交互/UI 门禁**：`npm run test:ui` 8 页 × 2 主题 × 2 视口通过，axe critical/serious 为 0；`npm run visual` 32 张通过；`test:pet` 40 张；`test:electron:console` 真窗口冒烟通过。设置页 `jumpToGroup` 只滚 `#content`，`html/body/#root` 禁止整页滚动，ui-check 的漂移断言通过。
- **吸附/胶囊/快览卡**：`anchorFromDrop` 只在窗口四分之一内吸边，中间保留相对偏移；`placeAnchored` 夹回宿主矩形；默认 `scrollGapOn=false` 时紧贴边缘；快览卡 `slice(0,3)` 与三档顺序有集成测试通过。
- **测试隔离**：`run-tests.mjs` 设置 `FOX_DOCK_VENDOR_BALANCES=0`；overlay/billing 集成使用临时目录；本次外部网络未发起请求。

## 未验证 / 无法验证

- CommandCode 真实订阅响应是否包含 `createdAt`（或其它创建时间字段）；本地池 `/health` 是否提供可区分的套餐元数据。无外部网络/真实凭据，无法确认。
- 真实四宿主窗口上的吸附、最上层判定与 `--allow-generic` 关闭时的行为；测试仍以假 agent 和 `--allow-generic` 运行。
- 真实 GIF 的动画、Electron `nativeImage` alpha 掩码与矩形命中降级；未做真实 Electron 截图。
- 真实更新清单下载/验签/替换/回滚；未运行。
- 旧线 shim（`main`/`workbuddy`）、真实宿主凭据、真实 dsh/Kimi 数据、125%/150% DPI、多显示器、8 小时 soak：未运行。
- `test:all` 仅完整运行 1 次（284/284）；未做 3 次以上重复以确认外部窗口干扰下的稳定性。

## 与上一轮报告的对应关系（如有）

- `CODE-REVIEW-2026-10-19-round3.md` **P3-1（移除筛选控件后残留死 state/import）**：本轮未处理；`ui/pages/context.mjs` 仍有未使用的 `Segmented`/`range`，`ui/pages/usage.mjs` 仍有 `groupBy`。状态不变，未作为本轮新问题重复计入。
- `CODE-REVIEW-2026-10-19-round3.md` **P3-2（hideMoney 下浮层积分未掩码）**：当前 `dock/overlay/pet.js` 的 `moneyText` 对 `unit === 'credit'` 也返回 `•••`，视为已修复；`test:electron:console`/`test:all` 通过。
- `CODE-REVIEW-2026-10-19-pet-round2.md` **P3-1（anchor 使用旧值）**：`bindTo` 现在先 `anchorFromDrop` 再 POST（`dock/overlay/pet.js:1050-1068`），旧值问题已修复；浮动/重置后不清理绑定记录的旧 P3 仍存在（未在本轮重复报告）。
- `CODE-REVIEW-2026-10-19-pet-round2.md` **P3-4（test:pet 文档 20/40 不一致）**：本轮把文档改为 40，但文档命令仍只产生 20，且列出不存在的“自由位置”状态；见 P3-4。
- 上一轮报告的 P2（token 隔离、hideMoney、设置轮询、绑定 anchor 顺序）在当前代码/`test:all` 中未见复发；本轮未逐条重跑上一轮全部探针。

---

**最终判定：REQUEST_CHANGES**（P1 = 0，P2 = 3，P3 = 8）。
