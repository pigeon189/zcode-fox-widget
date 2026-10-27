# 旧版挂件升级到 fox-dock 2.0 的前置准备（写给本仓库的 coding AI）

> 读者：在本仓库（zcode-fox-widget 1.x 线）工作的 AI/维护者。
> 背景：fox-dock 2.0（独立程序，仓库 `E:\WorkSpace\fox-dock` 的 `dock/` 线，同源分支）目前发
> `dock-v*` GitHub prerelease；**2.0.0 正式版（stable）发布后**，本插件要引导存量用户平滑迁到 2.0。
> 写作时间：2026-10-24；2026-10-26 修订：加入 2.0.0 正式版的「查看说明后升级」二次确认，
> 并重新审查了数据迁移、旧文件清理与失败回滚的完整性。
> 核对过的事实都带文件引用；没核实的明确标注「待核对」。

## 0. 本轮先看结论

1. **2.0.0 正式版的升级入口不是 1.x 的普通自更新。** 1.x 只负责「让用户看懂再确认」，
   真正的 2.0 安装、签名校验与失败回滚由 fox-dock 自己的更新器负责。迁移入口必须是
   「查看说明后升级」→（打开说明页、按钮变为「立即升级」）→「立即升级」两步。
2. **只在 2.0.0 stable 生效。** 任何 `2.0.0-pre.*` / `rc` / 带 `-` 后缀的版本一律忽略；
   远端清单没有显式、合法的 `migration` 块时，1.x 的升级行为必须与现在逐字节一致。
3. **数据迁移比 2026-10-24 版记录的多，但真正可用的没有想象中多。** dock pre.3 的
   `/v1/import`（`dock/daemon/src/import-old.mjs`）会扫描角色、气泡模板、按压队列、账本、
   部分外观设置与自定义音效；其中**只有角色（限 PNG）与自定义音效真正落库**，
   气泡模板 / 按压队列 / 账本因 1.x 与 dock 的 JSON 结构不同，当前是「类别存在、实际导入 0 条」。
   另外缺 WorkBuddy 线凭据、`defaultCorner`、主题/角色选择、气泡图库等。详见 §5。
4. **清理与回滚需要补成事务。** 现有 1.x 自更新的回滚只覆盖「写入过程中报错」，不覆盖
   备份失败、进程被杀、多安装副本只回滚失败副本这几种情况；迁移清理必须自己实现
   预检 → 停止 → 归档 → 校验 → 导入 → 验证 → 可选清理的状态机，任何一步失败都能回到
   1.x 可用态。详见 §6。
5. **不要改动 1.x 普通更新的核心路径。** 迁移代码是外挂分支；普通清单（没有 `migration`）
   的检查、下载、校验、替换、回滚行为必须保持不变。详见 §8/§9。

## 1. 结论：现在还不能「一键升级」

三个缺口仍然存在，但第 2 条的边界已按当前代码修正：

1. **分发通道不同**。本插件经宿主市场/插件目录分发；fox-dock 2.0 是独立程序，用自己的签名更新
   清单（`docs/dock/update.json` + `updateManifestUrl`，通道 stable/prerelease）自更新。两边更新器
   （本仓 `lib/update.mjs`、dock 的 updater）都只认自己，中间没有桥。
2. **数据迁移只覆盖一部分，且两条产品线不同**：
   - ZCode 线：dock 的 `dock/engines/credentials.mjs` 会读本插件的
     `~/.zcode/whale/config.json`（`LEGACY_CONFIG_FILE`，见 fox-dock `dock/engines/paths.mjs`），
     按 D022 优先级（环境变量 → DPAPI 保险库 → 宿主发现 → 旧配置导入）拿 `vendorKeys` /
     `relayAuth` / `apiKey` / `platformToken`。
   - WorkBuddy 线：dock 的 `/v1/import` 会扫描
     `~/.workbuddy/plugins/data/fox-widget-fox-local`，但真正可用的只有
     **角色（限 `*.png`）与自定义音效**，以及 `widget-state.json` 里的少数键；
     气泡模板 / 按压队列 / 账本虽然出现在类别列表里，读取形状不匹配，实际复制 0 条。
     它**也不会导入 `config.json` 里的 `vendorKeys` / `relayAuth` / `apiKey` /
     `platformToken` / `usageMode`**。
   - 仍有缺口：`defaultCorner`（1.x 已通过 `/whale/size.json` 落进 `widget-state.json`，
     但 dock 的 `importWidgetState` 白名单没有它）、`roleId` / `theme` / `displayMode` /
     `followIntervalMs` 等外观键、`bubble-imgs/` 图库、**气泡模板 / 按压队列 / 账本的结构
     转换**、自定义角色的显示名与 GIF/JPEG 格式（dock 导入器只认 `<id>.png`，且 1.x 的
     `roles.json` 是数组、dock 期望对象，名字会退化成 id）。
3. **旧文件清理没有编排**。`lib/update.mjs` 的删除只限「上一个版本的 manifest 清单」，没有
   「迁移完成 → 归档 → 自清理」的流程；dock 也不会去动本插件的目录（红线：它只写自己的数据目录）。
   迁移清理必须新增独立编排，且**不能复用 1.x 的更新删除逻辑**。

## 2. 已有的地基（不要重做）

- `lib/dock-shim.mjs`（WorkBuddy 线 M7）：读 dock 的 `daemon.lock`（端口/令牌）、`/health` 探活、
  SessionStart 时 `fox-dock ensure`、把 UserPromptSubmit / Notification 转发到 dock `/v1/events`、
  dock 在线时不再拉起自家浮层。迁移引导可以直接复用 `dockHealth()` / `readDockLock()` /
  `ensureDock()`。
- dock 的 `/v1/events` 兼容入口、`/v1/vendors`（验证凭据导入结果）、`/health` 都在本机 HTTP 上，
  带 `x-fox-token`。
- dock 的旧数据导入已经存在：`dock/daemon/src/import-old.mjs`（`CATEGORIES`、`inspectSources`、
  `importCategories`）、`dock/daemon/src/v1.mjs` 的 `GET /v1/import/sources` 与
  `POST /v1/import`、控制台向导 `dock/ui/components/wizard.mjs`。它只读源目录，写只发生在 dock
  数据目录；角色/外观键/自定义音效的复制是「缺失才复制」或「合并」，可以重复执行。
  **气泡模板、按压队列、账本只是预留类别，当前结构不匹配、实际复制 0 条**（见 §5），
  不要把「类别存在」当成「已支持」。
- 1.x 没有全局热键（已核对 `lib/` 与 `desktop/` 无 globalShortcut/registerHotkey），不存在热键
  冲突；冲突点只剩**开机自启**（1.x 看门狗 VBS 与 dock 自己的启动器 VBS 都在启动文件夹）和
  **浮层共存**（shim 已处理）。

## 3. 2.0.0 正式版的升级入口（本次新增的核心）

### 3.1 只在 stable 生效

触发条件必须同时满足，缺一不可：

1. 本机 1.x 版本 ≥ 本迁移能力首次发布的版本（建议在 §12 的验收里把该版本记为
   `MIGRATION_UI_MIN_VERSION`，例如 `1.3.5`）。旧版 1.x 没有这段 UI，只能先走普通升级。
2. 远端 `workbuddy` 分支的 `.codebuddy-plugin/plugin.json` 带显式 `migration` 块。
3. `migration.product === 'fox-dock'`。
4. `migration.channel === 'stable'`。
5. `migration.version === '2.0.0'`，且 **不允许任何 `-pre` / `-rc` / `-beta` 后缀**
   （用 `^\d+\.\d+\.\d+$` 校验后还要与常量 `'2.0.0'` 精确相等）。
6. 本机版本 ≥ `migration.minPluginVersion`（若清单给了该字段）。

任何一条不满足：**完全按现在的 1.x 更新逻辑走**，不显示迁移入口、不改按钮文案、不发迁移提醒。
`2.0.0-pre.3` 这类预发布清单即使带 `migration` 块也必须被忽略；不要用「版本号 ≥ 2.0.0」来推断
stable，必须看显式字段。

> 注意：1.x 的 `TAG_PREFIX` 是 `wb-v`（`lib/update.mjs`），不会把 `dock-v2.0.0` 当成可下载的
> 1.x 包。**不要为了触发迁移去发 `wb-v2.0.0` tag，也不要把 2.0 的文件放进 1.x 的下载包**——
> 那会绕过跨线校验并破坏 1.x 更新。迁移 offer 只来自 `plugin.json` 的 `migration` 块。

> 后续 2.0.1/2.1 的迁移不在本次范围。若将来需要，必须重新评审并显式改常量/清单，不能因为
> 版本号更大就自动复用 2.0.0 的说明页。

### 3.2 远端清单契约

在 `workbuddy` 分支的 `.codebuddy-plugin/plugin.json` 顶层增加可选字段（下面是片段，
不是完整文件；**预期**宿主会忽略未知字段，但必须真机核对：确认 WorkBuddy 5.x 能正常
加载带扩展字段的清单）：

```json
"migration": {
  "product": "fox-dock",
  "version": "2.0.0",
  "channel": "stable",
  "minPluginVersion": "1.3.5",
  "publishedAt": "2026-11-xx",
  "notesUrl": "https://github.com/pigeon189/zcode-fox-widget/releases/download/dock-v2.0.0/release-notes-2.0.0.html",
  "downloadUrl": "https://github.com/pigeon189/zcode-fox-widget/releases/tag/dock-v2.0.0",
  "summary": "fox-dock 2.0 正式版：独立桌宠 + 权限接管 + 旧数据导入",
  "highlights": ["独立程序，不再依赖宿主插件运行", "旧角色/音效可导入", "权限接管默认关闭"],
  "costs": ["自定义气泡图片/模板不自动迁移", "默认角落语义由「出生角」变为「失焦兜底角」", "旧账本不迁移，归档保留"]
}
```

约束：

- `notesUrl`、`downloadUrl` 只允许 `https:`，主机只允许
  `github.com`（以及 GitHub release 资产重定向到的 `objects.githubusercontent.com` /
  `release-assets.githubusercontent.com`），路径必须以 `/pigeon189/zcode-fox-widget/releases/`
  开头；拒绝 userinfo、`localhost`、环回/私有地址、非 443 端口、开放跳转。
  说明页优先用 **release 资产**（tag 固定），不要用 `raw.githubusercontent.com` 的可变分支内容。
  如果正式版要换成别的 HTML 域名，必须把该域名**硬编码进 1.x 的白名单并随版本发布**，
  不能由远端清单任意指定（否则被镜像篡改的清单可以指向钓鱼页）。
- `summary` / `highlights` / `costs` 是纯文本，不含 HTML；`summary` ≤ 80 字，
  `highlights` / `costs` 各最多 3 条、每条 ≤ 40 字。它们是「说明页打不开时也能看到的代价」，
  不能省略。
- 清单解析必须复用现有探测链（`buildVersionEndpoints`），不要新拉一个未签名的远端 JSON。
  多镜像可能返回不同新鲜度的 `plugin.json`：取**版本最高**的那份；同版本时取
  **带合法 `migration`** 的那份。旧镜像没有 `migration` 时不能把新镜像的入口覆盖掉。
- 具体收集规则：`fetchVersionText` 之后用 `parseRemoteManifest(text)` 同时拿
  `{ version, migration }`；`checkForUpdate` 维护 `best`（版本最高）与 `bestManifest`
  （版本最高且带合法 migration）。`manifest.version < 当前版本`（开发副本/旧镜像）时
  忽略 offer；`manifest.version > 当前版本` 时先走普通 1.x 更新，offer 暂存到升级后；
  `manifest.version === 当前版本` 且 offer 合法时才显示迁移入口。
- `migration` 块不参与 1.x 的 `available` / `latest` 计算；它只是附加信息。
- 发布顺序：先发一个**不带 `migration` 块**的 1.x 能力版本（含解析与 UI 代码），
  等 2.0.0 stable 的安装包、`update.json` 签名、说明页都实际上线并通过 §3.6 的 URL 检查后，
  再往 `workbuddy` 分支加 `migration` 块。撤掉 `migration` 块即可立即关闭迁移入口，
  不需要再发版。

### 3.3 按钮行为与状态机

改动集中在 `lib/widget.js` 的更新面板（`buildUpdatePanel` / `renderUpdatePanel` /
`updateActionLabel` / `updateBtnEl` 的点击处理 / `maybeNotifyUpdate`），以及
`lib/server.mjs` 的 `updateView` 与 `/whale/update.json` 的 `migrate` 动作。

状态机（只存在内存，不持久化「已武装」）：

```
idle
  └─ 点击「查看说明后升级」
       ├─ 说明页打开成功 → armed（按钮文案改为「立即升级」，提示已打开说明）
       └─ 说明页打开失败 → idle（提示打开失败，按钮文案保持「查看说明后升级」）
armed
  └─ 点击「立即升级」→ migrating（调用 migrate 动作）
  └─ 关闭面板 / 远端版本变化 / 跳过 / 面板重新打开 → idle（重新要求看说明）
```

具体行为：

1. 当 `migration` 合法、未完成、未被跳过，且**没有可用的普通 1.x 更新**时：
   - 主按钮文案 = `查看说明后升级`（替换原来的「立即更新」/「检查更新」）。
   - 第二次点击后的文案 = `立即升级`（现有代码里普通更新的按钮是「立即更新」；
     同一次流程里不要混用两套词，实现时以本流程为准，或把普通更新也统一成「立即升级」）。
   - 次要按钮「跳过此版本」保留，但跳过的存储必须与普通更新的 `updateSkip` **分开**
     （例如 `widget-state.migrationSkip = '2.0.0'`），不能因为用户跳过某个 1.x 版本而
     连带隐藏迁移入口，也不能因为跳过迁移而阻止 1.x 更新。
   - 面板内直接显示 `summary` + `costs`（最多 3 条），让用户不打开浏览器也能看到代价。
2. 第一次点击：
   - **不下载、不写盘、不启动迁移**。
   - 通过主进程打开 `notesUrl`（系统浏览器）。不要用浮层内嵌 iframe 渲染远程 HTML。
   - Electron 浮层：在 `desktop/preload.cjs` 增加最小 IPC（例如 `whale:openExternal`），
     主进程校验 `http/https` 后调用现有 `shell.openExternal`，返回 `true/false`；
     复用 `desktop/main.cjs` 已有的 `setWindowOpenHandler` / `will-navigate` 白名单口径。
   - 纯浏览器/宿主 webview（没有 `window.whaleDesktop`）：用 `window.open(notesUrl, '_blank',
     'noopener')` 或一个真实的 `<a target="_blank" rel="noopener noreferrer">` 点击；
     拿不到成功信号时，面板里保留一个可点击/可复制的说明页链接，用户点过链接后再把按钮
     切到「立即升级」。不要因为弹窗被拦就静默放行到迁移。
   - 如果产品坚持「应用内弹窗」而不是系统浏览器：只允许打开**随 1.x 打包的本地说明页**
     （`file://` 或自定义协议）到独立的 sandbox `BrowserWindow`；不要用远程 iframe，
     也不要把远程 HTML 直接塞进浮层（避免在浮层里引入远程网络/脚本执行面）。
   - 打开成功后，**同一个按钮**文案立即变为 `立即升级`，状态行提示
     「已打开说明页；确认了解新功能与迁移代价后，再次点击『立即升级』」。
   - 打开失败（IPC 异常、URL 校验失败、浏览器拒绝/弹窗被拦）→ 不进入 armed，按钮文案保持
     「查看说明后升级」，状态行给出可读错误和可点击的说明页链接；不能让用户在没看到说明的
     情况下进入下一步。
3. 第二次点击（armed 状态）：
   - 调用 `POST /whale/update.json` 的 `action: 'migrate'`。
   - 服务端必须重新校验当前 `migration` offer 与状态（版本、product、channel、
     `notesUrl` 白名单、未完成、未被跳过），不信任前端传来的任何版本/URL。
   - **绝不调用 `runUpdate()`**，绝不把 2.0 的包下载到 1.x 安装目录，绝不覆盖 1.x 代码。
     `migrate` 只做：预检（dock 是否在线/版本）、返回安装引导或启动 dock、
     进入 §6.3 的迁移流程。
4. 关闭面板、切换页面、版本变化（`s.latest` 或 `migration.version` 变了）、
   点击「跳过此版本」都要把 armed 复位为 idle；按钮文案恢复为「查看说明后升级」。
   这个复位本身不需要额外确认。
5. `maybeNotifyUpdate`：迁移入口出现时，提醒气泡文案改为
   「fox-dock 2.0 正式版已发布：点『更新』查看说明后再升级」，**不能**出现
   「点一下直接升级」的诱导；每个 offer 版本只提醒一次（键名与普通更新提醒分开）。
6. 无 migration、或 migration 被忽略时，现有按钮逻辑（可用则「立即更新」、不可用则
   「检查更新」）与点击行为保持不变。

### 3.4 普通 1.x 更新与迁移入口的优先级

- 如果远端同时给出「更高的 1.x 版本」和 `migration`：先按普通更新显示「立即更新」，
  迁移入口作为次级提示（「更新到 vX 后可用 2.0 迁移」）。不要用迁移入口挡住 1.x 的安全修复。
- 如果用户跳过某个 1.x 版本，迁移入口仍可出现（两套 skip 独立）。
- 如果用户已经完成迁移（`widget-state.migrationCompleted = '2.0.0'`），不再显示入口，
  但普通 1.x 更新照常可用（用户可能选择留在 1.x）。
- 如果 `migration` 块在 stable 发布后被撤掉，下一次检查应清掉内存/状态里的 offer，
  按钮恢复普通逻辑；不要留下一个指向已撤下说明页的入口。

### 3.4.1 迁移探测不能依赖 1.x 自动更新

WorkBuddy 线的 `startAutoCheck` **默认不启用**（只有 `FOX_WIDGET_ENABLE_UPDATE_CHECK=1`
才打开，见 `lib/update.mjs` 头注释），所以只加 `migration` 块并不会让入口自动出现。
阶段 A 必须补一个**独立、一次性、只读**的迁移探测：

- 触发：SessionStart（`lib/autostart.mjs`）或用户打开更新面板时；24 小时内最多一次。
- 行为：只读远端 `plugin.json`（复用 `buildVersionEndpoints` 的候选链与
  `assertUpdateUrl`），解析 `migration`；不下载、不替换、不写 1.x 安装目录。
- 预算：单次 ≤ 8 秒，失败静默（离线/镜像挂掉不能拖慢宿主启动）。
- 开关：`WHALE_DISABLE_UPDATE_CHECK=1` 与 `FOX_WIDGET_DISABLE_MIGRATION=1` 都能关闭；
  不要为了迁移去打开完整的 1.x 自动更新（那会改变现有更新行为）。
- 结果写进更新状态的 `migration` 字段（或独立的 `migration-probe.json`），
  供面板 GET 读取；探测本身不弹任何东西，弹不弹由面板/提醒决定。

### 3.5 说明页（用户要看到的「功能与代价」）

- 2.0.0 stable 必须新增 `docs/dock/release-notes-2.0.0.html`（命名与现有
  `docs/dock/release-notes-pre.2.html` / `release-notes-pre.3.html` 同风格），并作为
  `dock-v2.0.0` release 的附件上传；`migration.notesUrl` 指向这个附件。
  **可以拿 pre.3 的页面当排版模板，但不能只改版本号复用内容**：stable 的功能、代价、
  系统要求必须重新核对（pre.3 是预发布说明，不能冒充正式版）。
- 页面必须包含：
  1. 2.0 的新功能（独立桌宠、权限接管、通知、向导等）；
  2. **升级代价**：哪些数据会迁移、哪些不会、哪些行为语义变了（尤其 `defaultCorner` →
     `fallbackCorner` 的语义变化、气泡模板/图库/账本不自动迁移、WorkBuddy 订阅积分与
     dock 适配器的差异）；
  3. 回滚路径：保留归档、重装任意 1.x、恢复数据目录；
  4. 系统要求与安装方式（Windows x64；便携包/安装包；Node/Electron 运行时的实际要求）。
- `notesUrl` 必须是已在 release 中可访问的 URL；发布清单加 `migration` 块前，
  用无重定向或只允许 GitHub 重定向的方式实测返回 200。说明页缺失时宁可不开迁移入口。
- 说明页与 `summary` / `costs` 不得只写营销文案；「代价」部分是硬性内容。

### 3.6 迁移入口的验证清单

- [ ] 远端清单只有 `2.0.0-pre.3` + `migration`：1.x 完全不显示迁移入口，普通更新照常。
- [ ] 远端清单 `migration.version = "2.0.0"` 但 `channel = "prerelease"`：忽略。
- [ ] 远端清单缺 `notesUrl` / `notesUrl` 非 https / 非 GitHub Releases：忽略，并记录原因。
- [ ] 合法 stable offer：主按钮显示「查看说明后升级」，面板内显示 `costs`。
- [ ] 第一次点击：系统浏览器打开说明页；按钮变「立即升级」；**没有**任何下载/写盘。
- [ ] 说明页打开失败：按钮不变、不进入 armed、给出错误提示。
- [ ] 第二次点击：只触发迁移预检/向导，不调用 1.x 的下载与替换。
- [ ] 关闭面板再打开：按钮回到「查看说明后升级」，需要重新看说明。
- [ ] 普通清单（无 migration）：检查/更新/跳过/回滚行为与改动前一致（回归项）。

## 4. 要做的事

### 阶段 A：转正前就能做（建议尽快，随下一个 1.x 版本发出）

1. **偏好落盘对齐**：先核对 `defaultCorner` 是否已通过 `/whale/size.json` 落进
   `widget-state.json`（当前 1.x 的 `saveConfig` 已经带这个字段，旧文档说「只存在
   localStorage」是过时的）。真正要补的是 dock 侧：在 `importWidgetState` 的白名单里加
   `defaultCorner → fallbackCorner`，并把语义差异写进说明页。
   预算阈值确认已落 `widget-state.alerts`。
   验收：改默认角落后 `widget-state.json` 能读到该键；selftest 补断言；
   dock 导入后 `settings.fallbackCorner` 与 1.x 选择一致（语义按「失焦兜底角」解释）。
2. **迁移预检命令**：CLI 加 `migrate --check`（`node lib/cli.mjs migrate --check`，只读）：
   输出 JSON——config.json 可读性与
   键清单（只报键名与布尔值，不报值）、vault/凭据键数量（只报数量）、dock 是否在线
   （lock + health）、dock 版本、DATA_DIR 体积、启动文件夹 VBS 是否存在
   （`fox-widget-watchdog.vbs` 与 `fox-dock.vbs/.cmd` 分别报）、上次更新是否未完成。
   验收：非零退出码仅表示「检查项失败」，绝不写任何东西。
3. **自启交接**：检测到 dock 自启 VBS 存在（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\fox-dock.vbs`
   或 `.cmd`，见 fox-dock `dock/daemon/src/install.mjs` 的 `LAUNCHER_NAME = 'fox-dock'`）时，
   设置页提示并支持一键撤掉自己的启动项（`node lib/cli.mjs watchdog uninstall`）；不自动撤，先提示。
   1.x 自己的启动项是 `fox-widget-watchdog.vbs`（见 `lib/watchdog-cli.mjs`），不要误删 dock 的。
4. **更新器终点哨兵 + 清单解析 + 一次性探测**：新增独立模块（如 `lib/migrate.mjs`），提供
   `parseRemoteManifest(text)` / `validateMigrationOffer()` / `probeMigrationOffer()`；
   `probeMigrationOffer()` 按 §3.4.1 在 SessionStart 或打开更新面板时只读探测一次，
   24 小时最多一次、8 秒超时、失败静默。
   `lib/update.mjs` 只增加「把每份清单里的 migration 一并带回」的最小解析，不改
   `buildVersionEndpoints`、`buildTarballUrls`、`checkForUpdate` 的版本比较、
   `runUpdate`、`applyUpdateFiles`、`rollbackRoot`、`planApply`、`discoverInstallRoots`
   的现有行为。清单没有 `migration` 时，所有输出与现在一致。
   验收：普通清单回归测试（见 §9）通过；`2.0.0-pre.*` 清单被忽略。
   **EOL 哨兵仍然保留为可选分支**：如果将来决定停止 1.x 更新，在远端清单加
   `eol: true`（或等价字段），更新器在下载前只读拦截并改为迁移公告；没有 `eol` 字段时
   行为必须与现在一致。2.0.0 迁移本身**不要求** `eol: true`——1.x 仍在继续发修复版本，
   不要用迁移入口提前拦截正常的 1.x 更新。
5. **说明页与 stable 发布物**：按 §3.5 新增 `docs/dock/release-notes-2.0.0.html`，
   在 `dock-v2.0.0` release 中上传；`migration.notesUrl` 指向该附件。
   验收：URL 实测 200；页面包含「升级代价」与回滚路径。
6. **「查看说明后升级」UI + 状态机**：按 §3.3 改 `lib/widget.js`；加最小
   `openExternal` IPC（`desktop/preload.cjs` + `desktop/main.cjs`），只放行 http/https；
   服务端 `updateView` 增加 `migration` 字段，`/whale/update.json` 增加 `migrate` 动作
   （只做预检/引导，不做 1.x 自更新）。
   验收：§3.6 全过。
7. **自动化回归**：在 `tools/selftest.mjs` 或新增 `tools/selftest-migrate.mjs` 覆盖：
   清单解析（stable/pre/坏 URL）、按钮状态机（可用 DOM mock 或纯函数拆分）、
   普通更新回归（无 migration 时行为不变）、迁移预检只读（不写文件）。
   注意：不要在每个 `npm test`/CI 里做真实网络请求；用注入的 `fetchImpl`。

### 阶段 B：2.0 转正日（dock stable 发布后）

8. **启用 offer**：确认 2.0.0 stable 的 `update.json`、安装包、说明页都已上线且签名有效，
   再往 `workbuddy` 分支的 `plugin.json` 加 `migration` 块。加之前先跑 §3.6 的 URL 检查。
9. **迁移引导卡/向导**：复用 `dockHealth()`；dock 不在或版本 < 2.0.0 stable 时展示一次性卡片：
   预检结果（阶段 A 的 check 输出）+ 安装引导（GitHub stable 下载或 `FOX_DOCK_ROOT` 安装）+
   「装好后自动交给 dock」说明（shim 的 ensure/转发已在，无需用户配置）。
   卡片必须写清「先看说明、再点立即升级」的两步关系。
10. **数据交接验证**：dock 起来后调 `/v1/vendors`，确认各厂商 `available` 不为 unavailable、
    凭据 source 已迁移；再调 `GET /v1/import/sources` 确认源目录与类别可见。
    预检清单逐项打勾后才允许进入清理步骤。**WorkBuddy 线的凭据不在 `/v1/import` 范围内**，
    必须在向导里单独提示用户到 dock 控制台手动录入，或另开 dock 侧导入能力。
11. **自清理（必须用户确认，先归档后删）**：见 §6，不能只按旧版的三行流程做。
12. **回滚说明**：见 §7；每一步都要有自动/手动回退路径。
13. **迁移后观察**：迁移完成后的第一个会话周期内，1.x 不再启动浮层/服务（shim 让位），
    但要保留「回滚入口」至少一个版本；用户卸载 1.x 后，提供可选的残留清理。

## 5. 数据迁移矩阵（按当前 1.x / dock pre.3 代码核对）

1.x（WorkBuddy 线）数据目录：`%USERPROFILE%\.workbuddy\plugins\data\fox-widget-fox-local`
（见 `lib/host.mjs` 的 `PLUGIN_DATA_DIR`）。ZCode 线对应 `~/.zcode/whale`。
dock 数据目录：`%LOCALAPPDATA%\fox-dock`（`dock/engines/paths.mjs#DATA_DIR`）。

| 1.x 内容 | dock 目标 | 当前是否自动导入 | 说明 / 缺口 |
|---|---|---|---|
| `config.json` 的 `vendorKeys` / `relayAuth` / `apiKey` / `platformToken` | DPAPI 保险库 / `vendor-config.json` | ZCode 线：是（读 `~/.zcode/whale/config.json`）；WorkBuddy 线：**否** | WorkBuddy 线需要在 dock 控制台手动录入，或另开 dock 侧导入；绝不能把明文密钥复制进 dock 数据目录 |
| `config.json` 的 `usageMode` / `port` / `autoStartWidget` / `autoStartOverlay` / `followIntervalMs` | dock settings | 否 | `usageMode` 口径不同（ledger/token），不要盲目照抄；自启由 dock 自己的启动器管理 |
| `widget-state.json` 的 `scale` / `sound` / `soundEnabled` / `vol` / `soundVolume` / `petMode` / `soundSet` / `scrollGapOn` / `scrollGap`（或 `scrollGapPx`）/ `alerts.*` | dock settings | 是（`importWidgetState` 白名单） | `alerts.quotaPct/moneyAlert/budgetToday` 映射为 `quotaWarnPct/balanceWarnMoney/budgetMoney` |
| `widget-state.json` 的 `defaultCorner` | `fallbackCorner` | **否（dock 白名单未含）** | 1.x 已通过 `/whale/size.json` 落盘；语义不同：1.x 是「没有上次位置时的出生角」，dock 是「失焦/最小化兜底角」；必须在说明页写清 |
| `widget-state.json` 的 `roleId` / `theme` / `displayMode`；`config.json` 的 `followIntervalMs` | dock settings | 否（部分键在白名单外） | 逐键核对；能无损映射的再加，不能的把差异写进说明页 |
| `roles.json` + `roles/*.png` | dock `roles/` + `roles.json` | 是（仅 PNG；名字/GIF 有缺口） | 1.x 是 `{roles:[...]}` 数组、dock 期望 `{roles:{id:{name}}}` 对象 → **显示名会退化成 id**；1.x 允许 GIF/JPEG，dock 导入器只收 `*.png` → GIF/JPEG 角色被跳过。需要在 dock 侧修 |
| `sounds.json` + `sounds/*` | dock `sounds/` + settings | 是（`importLegacySounds`） | 只复制，不动源；内置三套 duck/fx1/nya 同名 |
| `bubble-templates.json` | dock 同名 | **否（类别存在，实际 0 条）** | 1.x 是对象 `{turnCost:{v,steps}, alerts:{plan,balance,cmdgo}}`；dock 的 `mergeTemplates` 只收数组或 `{templates:[]}`，`listBubbleTemplates` 也只要数组 → 当前读不到任何模板。要迁移必须写转换器（或明确不迁移） |
| `bubble-content.json` | dock 同名 | **否（类别存在，实际 0 条）** | 1.x 是 v2 单本 `{v:2,tapAdvance,steps:[...]}`；dock 的 `/v1/bubbles/queue` 只认数组或 `{queue:[]}` → 原样复制后 dock 读到空队列。要迁移必须把 v2 steps 转成 dock 队列项，或明确不迁移 |
| `bubble-imgs/` + `bubble-imgs.json` | dock `bubble-imgs/` | **否** | dock 有这些路径但没有对应导入类别；要么补类别，要么在说明页明确「不迁移」 |
| `usage-ledger.json` | dock `ledger.json` | **否（`mergeLedger` 实际 0 条）** | `mergeLedger` 只认 `{days:{日期:{适配器:行}}}`；1.x 是单本 `{date,lastBalance,todayUsage,history,previousBooks,...}` → 直接返回 `{count:0,skipped:1}`。旧版「账本不导入」的结论是对的；dock 的 `ledger` 类别目前是空壳，不能把它写成迁移能力 |
| `update-state.json` / `update-files.json` / `update/` | 不导入 | 否 | 1.x 更新状态；归档后可作为诊断材料，不要迁移 |
| `hook-state.json` / `turn-seq.json` / `server.json` / `server.log` / `autostart.log` / `overlay-debug.log` | 不导入 | 否 | 运行时状态/日志；归档，不迁移 |
| `overlay.json` / `overlay-profile-*` / `desktop-runtime/` / `close-pause.json` | 不导入 | 否 | 浮层运行时缓存；`desktop-runtime` 是体积大头，归档时默认排除，清理时优先删 |
| `widget-state.updateSkip` | 不迁移 | 否 | 1.x 跳过的版本与 2.0 无关 |
| 宿主 `workbuddy.db` / `projects/` / `settings.json` | 只读 | 否 | dock 自己读宿主；迁移代码绝不写宿主配置 |

## 6. 清理、归档与回滚（本次审查的重点）

### 6.1 1.x 自更新的旧文件清理：保持现状

`lib/update.mjs` 的删除只限「上一个版本的文件清单」（`writeManifest` 写、`planApply` 用），
没有清单时宁可只覆盖不删除。这是正确的保守策略，**迁移 PR 不要改它**，也不要为了
「清理得更干净」而扩大删除范围。普通 1.x 更新在迁移后仍要继续可用。

### 6.2 迁移清理必须覆盖的内容

以 WorkBuddy 线为例，`~/.workbuddy/plugins/data/fox-widget-fox-local/` 下。
**归档范围 = 整个 DATA_DIR**（排除下面三项），不要只按白名单复制——未知文件、`.corrupt-*`
备份、`server.start.lock` 等也应一起进归档；下面是必须核对存在的关键项：

- **关键项**：`config.json`、`widget-state.json`、`roles.json` + `roles/`、`sounds.json` +
  `sounds/`、`bubble-templates.json`、`bubble-content.json`、`bubble-imgs/` +
  `bubble-imgs.json`、`usage-ledger.json`、`hook-state.json`、`turn-seq.json`、
  `update-state.json`、`update-files.json`、`server.log`、`autostart.log`、
  `overlay-debug.log`、`watchdog.json`、`server.start.lock`、`close-pause.json`。
- **默认排除**：`desktop-runtime/`（Electron 运行时，体积大、可重装）、
  `overlay-profile-*`（Chromium profile，可重建）、`update/`（临时工作区）。
- **不归档**：宿主目录（`workbuddy.db`、`projects/`、`settings.json`）、dock 数据目录、
  1.x 安装目录/缓存副本（属于宿主插件管理）。
- 归档文件放在**用户选择的位置**（默认不要选 `%TEMP%`），命名建议
  `fox-widget-backup-<1.x版本>-<时间戳>.tar.gz`。**不要放在 `DATA_DIR/update/` 下**——
  `cleanupWorkspace()` 会清空该目录，归档会被误删。归档内附 `manifest.json`：
  1.x 版本、创建时间、文件列表、大小、sha256、排除项；**不写任何密钥值**。
- 归档实现建议零依赖：用 Node `zlib.gzipSync` + 一个最小 tar writer（可参考
  `lib/update.mjs` 的 `parseTar` 反向写），写完后用现有 `parseTar` 重新解析校验；
  不要调用系统 `tar`/`Compress-Archive` 作为唯一路径（路径含空格/中文时不可靠）。
- 归档成功后计算整包 sha256，记入 `migration-state.json`；归档失败/校验失败 = 中止，
  绝不先删。

### 6.3 正确顺序（缺一步都可能留下半迁移状态）

1. **预检（只读）**：1.x 版本、DATA_DIR 可写、磁盘剩余空间 ≥ 归档估算 × 2、
   dock 已安装且版本 ≥ 2.0.0 stable、dock 在线、启动文件夹里两只 VBS 的归属。
   dock 未就绪时只显示安装引导，**不停止 1.x、不归档、不删任何东西**。
2. **用户二次确认**（§3.3 的「立即升级」）。
3. **停 1.x 常驻**：先 `node lib/cli.mjs watchdog uninstall`（移除
   `fox-widget-watchdog.vbs` 并结束看门狗），再 `node lib/cli.mjs close`
   （停服 + 停浮层）。校验 `server.json` / `overlay.json` / `watchdog.json` 里的 pid
   都已不存在（文件被正常清理也算已停）；仍活着就报错中止，不要 `taskkill` 无关进程。
4. **归档**：按 §6.2 生成并校验归档。校验通过前，后续步骤一律不执行。
5. **dock 导入**：在 dock 控制台向导里选择旧数据来源与类别（`/v1/import/sources` →
   `POST /v1/import`）。1.x 不直接写 dock 数据目录；导入由 dock 自己的 API 完成。
6. **验证**：`GET /v1/vendors`（凭据可用性）、导入 summary（角色/音效数量；
   气泡模板/按压队列/账本会显示 0，属当前预期）、dock 控制台的「角色与气泡」页能看到
   导入项。WorkBuddy 凭据手工录入的，按用户确认的清单逐项打勾。
7. **提示卸载**：告诉用户到宿主插件管理里卸载本插件（**不自动卸载**——插件管理是宿主
   与用户的域）。卸载前不要删 DATA_DIR：插件仍装着时宿主可能重建目录/覆盖配置。
8. **可选清理**：用户确认已卸载后，再提供「清理 1.x 残留」：删除 `desktop-runtime/`、
   `overlay-profile-*`、`update/`、日志与运行时 JSON；`config.json` / 账本 / 角色 / 音效
   只有在归档校验通过且用户再次确认后才删。清理失败不要回滚已完成的迁移，只报告残留路径。

### 6.4 失败与回滚矩阵

| 失败点 | 1.x 状态 | 自动动作 | 用户可见结果 |
|---|---|---|---|
| 预检失败（dock 未装/版本低/磁盘不足） | 未动 | 不停止、不归档 | 显示缺失项与安装/清理建议 |
| 停止看门狗/服务失败 | 可能部分停止 | 重新 `watchdog install` + `start`（尽力） | 报错并保持 1.x 可用；可重试 |
| 归档失败/校验失败 | 已停止 | 重新 `watchdog install` + `start` | 报错；不删任何文件；可重试 |
| dock 导入失败 | 已停止，归档在手 | 不删；保留归档；提示重试或先恢复 1.x | 角色/音效是「缺失才复制」，可安全重跑；模板/账本当前是 no-op |
| dock 验证失败（凭据/角色缺失） | 已停止，归档在手 | 不进入清理；提示手动补录或回滚 | 迁移未完成，但数据仍在 |
| 用户卸载 1.x 后想回滚 | 插件不在 | 重新从市场安装任意 1.x → 解档到 DATA_DIR → `watchdog install` → `start` | 归档是唯一恢复源；必须提前校验 |
| 清理中途失败 | 插件已卸载 | 不回滚迁移，只报告残留 | 残留文件可手动删；归档仍在 |

**迁移状态文件** `migration-state.json`（放 DATA_DIR，随归档一起备份）：

```json
{
  "version": 1,
  "offerVersion": "2.0.0",
  "phase": "idle|offered|confirmed|stopping|archived|importing|imported|verified|uninstalled|cleaned|done|failed",
  "archivePath": "D:\\...\\fox-widget-backup-1.3.5-....tar.gz",
  "archiveSha256": "...",
  "startedAt": 0,
  "updatedAt": 0,
  "lastError": null,
  "steps": { "watchdogRemoved": false, "serverStopped": false, "overlayStopped": false, "archiveVerified": false, "dockVerified": false }
}
```

要求：

- 只存路径/状态/哈希，不存密钥、不存命令原文、不存用户目录以外的敏感信息。
- 进程被杀后重启：读 `phase`。如果处于 `stopping/archived/importing`，先检查 1.x 进程是否
  还活着；不活且归档已校验，可继续；归档未校验则恢复 1.x（`watchdog install` + `start`）。
- 导入本身幂等：角色缺失才复制、音效只复制；模板/账本当前不导入（不会产生重复）。
  如果将来补了转换器，再按「模板去重、账本按较新 `at` 合并」的规则验证。
  角色名/GIF 的缺口见 §5。
- **不能自动回滚的只有两件事**：宿主插件卸载（用户手动）和用户删除归档。前者可在重装 1.x
  后恢复；后者无法恢复账本/自定义素材。所以「归档校验通过」是进入卸载提示的硬门槛。

### 6.5 对现有 1.x 更新回滚的审查结论（不改，但要记录）

以下都是 1.x **既有**行为，不是迁移引入；迁移 PR 不要顺手改，另开修复 PR 并先加测试：

- **备份失败仍继续写入**：`applyToRoot` 在 `backupFiles` 返回 `null` 时仍会写文件；
  若随后出错，`rollbackRoot` 对「原本存在但没备份成功」的文件会走「原本不存在」分支，
  可能删除既有文件。建议修复：备份失败直接中止 apply（不写任何文件），并补单测。
  在修复前，迁移流程不要依赖 1.x 的这条回滚路径（迁移自己先归档）。
- **多安装副本不是全有或全无**：`applyUpdateFiles` 逐 root 应用，某个 root 成功后另一个
  root 失败，只回滚失败的那个；已成功副本会运行新版本。迁移预检应列出所有 root 并提示，
  不要承诺「全部回滚」。
- **多 root 的备份目录会互相覆盖**：`applyUpdateFiles` 对每个 root 用同一个 `stamp`，
  `backupFiles` 都写到 `update/backup/<stamp>/`，相同相对路径的文件会被后一个 root 覆盖，
  `root.json` 也只留最后一个。自动回滚是在每个 root 的 `applyToRoot` 之后立即执行的，
  所以失败 root 用的还是刚写的自己那份备份；但**事后手动回滚/审计只能看到最后一个 root
  的备份**，前一个副本的旧文件已经不在备份里。若要修，备份目录按 root 路径哈希分桶，
  并补多 root 备份/回滚单测。迁移流程自己归档，不要依赖它。
- **进程被杀/断电没有启动恢复**：`readUpdateState` 只会在 30 分钟后复位 `busy`，
  不会自动从 `update/backup/<stamp>` 还原。迁移状态机必须自己处理崩溃恢复（§6.4）。
- **清单缺失时只覆盖不删除**：安全，但会留残留；`migrate --check` 应报告
  「上次更新未完成/旧清单缺失」，不要把它误报成迁移失败。
- **`writeManifest` 失败被忽略**：下次会退回 scan/git 兜底，删除范围更保守；可接受。

## 7. 回滚方案（每一步都可退）

- **装了 dock 但想留在 1.x**：什么都不用做——两者数据目录独立，1.x 照常运行（shim 只在 dock
  在线时让出浮层，退法是把 dock 停掉或 `npm stop`）。
- **已完成迁移但没卸载 1.x**：dock 在线时 1.x 浮层让位；想回 1.x 就停掉 dock
  （`npm stop` 或 dock 的托盘退出），1.x 的 `start` / 看门狗会恢复。
- **已完成自清理**：解档 DATA_DIR 归档回 `~/.workbuddy/plugins/data/fox-widget-fox-local/`
  （或 ZCode 的 `~/.zcode/whale/`），重装任意 1.x 版本，`node lib/cli.mjs watchdog install`，
  `node lib/cli.mjs start`；config/账本/角色/音效都在归档里。
- **dock 侧出问题**：dock 自己的更新器带签名校验与失败回滚，卸载 dock 不影响 1.x 数据
  （前提是 1.x 数据目录还没被清理）。
- **归档丢失**：凭据可重新配置；账本与自定义素材无法恢复——所以清理步骤强制
  「归档成功且校验通过才继续」，且归档位置让用户自己选（默认不选系统盘临时目录）。

## 8. 红线（迁移代码必须遵守）

- **不自动卸载宿主插件**；**1.x 不直接写 fox-dock 的任何目录**（导数据只能走 dock 自己的
  `/v1/import`，由 dock 写它自己的数据目录）；**只允许在 1.x 数据目录内做「归档校验通过后」
  的可选清理**，该目录之外的任何文件（含 dock 目录、宿主目录、启动文件夹里 dock 的启动器）
  都不删。ZCode 线与 WorkBuddy 线分别对应各自的数据目录。
- **2.0 迁移不走 1.x 的下载/替换路径**：不调用 `runUpdate`、不把 2.0 包写进 1.x 安装目录、
  不自动执行下载的安装包。1.x 只打开说明页/下载页、调用 dock 的本地 HTTP、生成归档、
  停止自己。
- **不信任远端清单里的 URL**：`notesUrl` / `downloadUrl` 只允许 https + GitHub Releases
  白名单；打开前校验；不把 URL 当文件路径，不用 `file://`。
- 密钥永不落明文日志/归档清单文本（归档里的 `config.json` 本身按现状保留，但要提示用户
  妥善保管）；`migration-state.json`、通知、诊断包不得出现完整 key、完整命令或用户路径。
- 清理前必须完成归档与 `/v1/vendors` 验证；任何一步失败 = 停下来报错，不部分清理。
- 所有网络调用仍走既有出站白名单；对 dock 只访问 `127.0.0.1:<lockport>`。
- 迁移入口只对 `2.0.0` stable 打开；`pre`/`rc`/未知版本一律按普通 1.x 更新处理。

## 9. 硬边界：不得影响现有升级系统

1.x 仍在正常发布升级（含本迁移引导版本自身的分发），迁移方案对它必须是**零侵入**：

- `lib/update.mjs` 的现有路径（清单拉取、sha256/Ed25519 校验、文件替换、失败自动回滚、
  manifest 限定删除）一行不改；新增的只是「把 `migration` 字段一并解析出来」的只读旁路。
- 迁移引导卡、`migrate --check`、自启交接、归档/清理全部挂在**独立模块**
  （如 `lib/migrate.mjs`）+ 明确的状态后面；默认关闭的条件是「远端清单没有合法
  `migration` offer」。不要用环境变量作为 2.0 stable 的必需开关（用户不会设），
  但保留一个支持用的 kill switch（如 `FOX_WIDGET_DISABLE_MIGRATION=1`）。
- 老版本用户（不升级 1.x、不重启宿主）不受任何影响：没有新模块加载路径就没有行为变化。
- 自测必须包含「回归项」：正常清单（无 `migration` 字段）在带迁移代码的版本上照常升级成功、
  失败回滚照常工作；`2.0.0-pre.*` 清单不触发迁移 UI——这是迁移 PR 合并的硬性验收，不是可选项。
- **不要新增 `wb-v2.0.0` tag 或把 2.0 包塞进 1.x 发布物**：2.0 只发 `dock-v*`，1.x 只发
  `wb-v*`；跨线包会被 `runUpdate` 的包名校验拒绝，也会让存量用户的普通更新失败。
- **两条 1.x 产品线的清单彼此独立**：本仓库的 `workbuddy` 分支给 WorkBuddy 线发
  `wb-v*`，`main` 分支给 ZCode 线发 `v*`，两边的 `plugin.json`、数据目录、更新探测都不同。
  `workbuddy` 分支的 `migration` 块不会让 ZCode 线用户看到迁移入口；如果 ZCode 线也要引导，
  必须在 `main` 上单独实现并单独评审，不要假设一套改动覆盖两线。

## 10. 附录 A：字段映射（1.x → fox-dock 2.0 settings）

| 1.x | fox-dock 2.0 | 备注 |
|---|---|---|
| `alerts.quotaPct` | `quotaWarnPct` | 0–100，0=关 |
| `alerts.moneyAlert` | `balanceWarnMoney` | 元 |
| `alerts.budgetToday` | `budgetMoney` | 元；dock 另有积分口径 `budgetCredit` |
| `defaultCorner`（已由 `/whale/size.json` 落进 widget-state） | `fallbackCorner` | br/bl/tr/tl；语义不同：dock = 失焦/最小化兜底角，不是出生角；dock 导入器当前未映射 |
| `vendorKeys` / `relayAuth` / `apiKey` / `platformToken` | DPAPI 保险库（经 D022 导入链） | ZCode 线自动读旧 config.json；WorkBuddy 线需手动/另开导入 |
| `usageMode` | dock 的记账口径 | 不要直接照抄；dock 用宿主日志 + 账本校正 |
| `scrollGapOn` / `scrollGap` / `scrollGapPx` | `scrollGapOn` / `scrollGap` | 1.x 的 `scrollGapPx` 已由 `importWidgetState` 改名 |
| 内置六角色（嘎啦嘛/大肥鱼/GPT娘/kimi娘/小克/哈基米） | 同名内置 | 台词已移植；自定义角色见 §5 |
| `usage-ledger.json` 账本 | 不迁移（结构不同） | 1.x 是单本 `{date,lastBalance,todayUsage,history,...}`；dock 的 `mergeLedger` 只认 `{days}`，实际 0 条。归档保留，不当作 2.0 统计 |
| `bubble-templates.json` / `bubble-content.json` | 不迁移（结构不同） | 1.x 是对象/单本 v2 泡泡；dock 是数组/队列。需要转换器才能迁移，当前不要承诺 |
| `bubble-imgs/` 图库 | 无自动导入 | 在说明页明确「不迁移」或补 dock 导入类别 |
| `updateSkip` | 不迁移 | 与迁移跳过分开存储 |

## 11. 附录 B：迁移相关文件与路径速查

**1.x（WorkBuddy 线）**
- 数据目录：`%USERPROFILE%\.workbuddy\plugins\data\fox-widget-fox-local`
- 启动项：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\fox-widget-watchdog.vbs`
- 运行时 pid：`server.json`、`overlay.json`、`watchdog.json`
- 更新状态：`update-state.json`、`update-files.json`、`update/`、备份 `update/backup/<stamp>/`
- 归档排除：`desktop-runtime/`、`overlay-profile-*`、`update/`

**fox-dock 2.0**
- 数据目录：`%LOCALAPPDATA%\fox-dock`（或 `FOX_DOCK_DATA`）
- 锁/端口/令牌：`daemon.lock`
- 更新清单：`docs/dock/update.json`（sha256 + Ed25519 签名）
- 旧数据导入源：`~/.zcode/whale`、`~/.workbuddy/plugins/data/fox-widget-fox-local`、
  `FOX_DOCK_IMPORT_DIRS`（分号分隔）
- 启动项：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\fox-dock.vbs`
  或 `fox-dock.cmd`（`dock/daemon/src/install.mjs`）
- 说明页：`docs/dock/release-notes-2.0.0.html`（stable 新增，作为 release 附件）

## 12. 验收清单（阶段 B 完成时逐项自测）

- [ ] 全新机器：装 1.x → 配凭据 → 装 dock stable → `/v1/vendors` 凭据可用，全程无需手抄 key。
- [ ] 老用户：1.x 在跑 → dock 起来 → 1.x 浮层自动让位、事件照常转发（shim 回归）。
- [ ] 普通 1.x 更新回归：远端无 `migration` 时，检查/下载/校验/替换/回滚/跳过全部与改动前一致。
- [ ] 预发布清单：`2.0.0-pre.*` 带 `migration` 也不显示迁移入口。
- [ ] stable offer：按钮「查看说明后升级」；首点只开说明页并把按钮改为「立即升级」；
      二次点击才进入迁移；面板关闭后复位。
- [ ] 说明页失败：不武装、不进入下一步；URL 白名单拒绝非 GitHub 地址。
- [ ] 迁移完成：归档可解包且 sha256 匹配、自启只剩 dock 的、1.x 常驻全停、
      宿主插件目录仍在（等用户手动卸）。
- [ ] 数据矩阵：角色（PNG 成功；名字/GIF 在 dock 修复后才算通过，未修复前在说明页标注）、
      音效、`widget-state` 已覆盖键按 §5 逐项可见；气泡模板/按压队列/账本当前不迁移，
      归档保留并在说明页写明；WorkBuddy 凭据按向导提示手动补录。
- [ ] 断网/装不了 dock：引导卡可关、1.x 一切如常、下次条件满足再提示。
- [ ] 回滚：解档 + 重装 1.x + `watchdog install` + `start` 后余额/配置恢复。
- [ ] 幂等：导入重复执行不产生重复角色/音效（模板/账本当前为 no-op）；中途被杀后按
      `migration-state.json` 能恢复或安全重试。
- [ ] 清理只在归档校验通过且用户确认卸载后执行；失败只报告残留，不破坏已完成的迁移。

## 13. 本轮审查发现（给维护者的清单）

**已修正文档中的过时结论**
- 旧版写「账本 dock 不导入」——这个结论**是对的**。dock 虽然列了 `ledger` 导入类别，
  但 `mergeLedger` 只认 `{days}`，1.x 的 `usage-ledger.json` 是单本结构，实际返回
  `{count:0,skipped:1}`。文档已改为「有类别但不迁移」。
- 旧版把「数据迁移只覆盖凭据」写死了——dock 的 `/v1/import` 实际上还覆盖角色与自定义
  音效（有名字/GIF 缺口）；但气泡模板/按压队列/账本只是「有类别」，结构不匹配，实际 0 条。
  文档已按 §5 的真实能力重写，避免把空壳类别写成迁移能力。

**仍需 dock 侧配合（不在本仓库）**
- `importWidgetState` 白名单加 `defaultCorner → fallbackCorner`，并决定是否映射
  `roleId` / `theme` / `display` / `followIntervalMs`。
- 角色导入兼容 1.x 的 `roles.json` 数组结构（否则显示名丢失）与 `.gif`/`.jpg` 文件。
- 气泡模板 / 按压队列 / 账本：要么写真正的转换器（1.x 对象 → dock 数组/队列/`days`），
  要么把这三个类别从「可导入」里去掉，避免用户勾选后看到 0 条。**当前不能声称已迁移**。
- 决定 `bubble-imgs` 是否新增导入类别；不迁移就在说明页写明。
- WorkBuddy 线 `config.json` 的凭据导入路径（或明确只支持控制台手动录入）。
- 在 `/v1/import` 的 summary 里返回足够信息，便于 1.x 侧做「导入后验证」。

**1.x 侧待做**
- `parseRemoteManifest` / `validateMigrationOffer` / `probeMigrationOffer`（复用现有探测链）。
- `lib/widget.js` 的两步按钮与状态机；`openExternal` IPC。
- `updateView` 增加 `migration` 字段；`/whale/update.json` 增加只做预检/引导的 `migrate`。
- `migrate --check` 只读预检；`migration-state.json` 事务状态机；归档/校验/清理。
- 说明页 `docs/dock/release-notes-2.0.0.html` 与 release 附件。

**待真机核对**
- WorkBuddy 5.x 能否正常加载带 `migration` 扩展字段的 `plugin.json`（宿主 schema 是否严格）。
- `shell.openExternal` 的 IPC 在浮层窗口（不可激活、置顶、穿透）上的实际行为与返回值。
- 1.x 升级面板在窄宽度下显示 `costs` 三条后的高度/滚动；说明页在系统浏览器中的可达性。
- SessionStart 的一次性迁移探测在 WorkBuddy 真机上的时序（不能拖慢宿主启动；
  与 `autostart.mjs` 的 15s 预算共存）。
