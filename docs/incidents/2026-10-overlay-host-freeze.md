# 浮层点击后宿主画面冻结 —— 调查记录

> **状态**：已闭环（2026-10-14）· 仅作历史参考，不再更新
> **结论去向**：`desktop/main.cjs` 的 `type:'toolbar'`（已生效）/
> [`../DECISIONS.md#host-freeze`](../DECISIONS.md#host-freeze)
> **原文**：本次未改正文，仅前置本段；末尾追加 ZCode 侧修复报告原文


> 本文只记录**问题现象、复现方式、已尝试且无效的做法、以及现有可观测证据**。
> **刻意不提供任何解决方向**，请接手的人自行判断与设计。
> 下面出现的机制描述都只是**未确证的线索**，不是结论，也不代表可用。

- 记录时间：2026-10-13
- 相关提交：`2b4e692`（本批功能 + 曾加入两处针对性修复）→ `f69c536`（那两处修复已回滚）
- 状态：**未解决**。桌面浮层形态下仍可复现。

---

## 一、问题现象

在 **桌面浮层**（Electron 透明置顶窗口）形态下，**指针压到角色（或角色头顶的气泡）并点击之后，ZCode 自己的界面停止刷新**：画面停在旧帧，但 ZCode 进程与页面都正常（鼠标移过去、点一下 ZCode 就能恢复继续刷新）。角色、气泡、挂件菜单自身照常工作。

补充要点：

- 只在**浮层**形态出现；浏览器页面形态（直接打开 `http://127.0.0.1:<port>/`）不可能出现——那里没有独立窗口。
- 与「挂件自己的画面冻结」不是一回事。历史上处理过的是**浮层自身**停在旧帧（`desktop/main.cjs` 的 `kickPresentation`、`recreateWindow`，以及 v1.8.6 移除的「活性点 + DXGI」冻结检测都属这一族），重建浮层窗口即可恢复。**本问题里冻结的是宿主 ZCode**，恢复方式是让 ZCode 重新前台/点一下它。
- 第三方报告（issue #2）称该现象在 2026-10-10 的 ZCode 客户端更新**之前**出现，更新后「好像问题消失了」；但仓库维护者在当前版本上**仍然能复现**。所以复现前请先确认：ZCode 版本、是否浮层形态、是否把指针停在角色上。

## 二、issue #2 原文与状态

仓库：`pigeon189/zcode-fox-widget`，issue #2，**当前 OPEN**（维护者尚未回复）。

标题：`点角色后宿主出现 ZCode 停止刷新画面（偶发）；更新程序无法关闭 ZCode`

正文（原文照录）：

> 安魂曲大佬好我又来提issue了（
>
> 环境
> Windows · ZCode 3.14.5（Electron 41.0.3）· zcode-fox-widget 1.10.0（桌面浮层形态）
>
> 现象
> 指针压到角色上点击后，ZCode 自身画面停止刷新，点一下 ZCode 才恢复。（10月10日版本之前出现，可能是偶发的卡死）
> 更新ZCode 10月10日版本时重启程序但挂件未消失，更新程序提示「无法关闭 ZCode」。
>
> （issue内容修改了一下，点角色后宿主出现 ZCode 停止刷新画面的问题是更新zcode前遇到的，更新后使用好像问题消失了）

注意：这个 issue 其实是**两个症状**。第二个（更新 ZCode 时挂件不退出 / 更新程序提示无法关闭 ZCode）已按「更新场景」单独处理（宿主进程更换时交还鼠标并隐身、宿主窗口长时间不存在时浮层自退，见 `desktop/main.cjs` 的 `noteZCodeIdentity`、`MISSING_QUIT_MS` 分支）。**本文只讨论第一个症状（宿主画面冻结）**。

## 三、如何复现

环境：Windows 11（本机 `10.0.26200`）；ZCode 桌面客户端；插件为桌面浮层形态（`node lib/cli.mjs window start`）。

步骤（本机可稳定复现）：

1. 确认浮层在跑，且只有**一个**实例：
   `node -e "import('./lib/overlay.mjs').then(m=>console.log(m.listOverlayPids()))"`
   —— 若返回多个 pid，先 `node lib/cli.mjs window stop` 再 `window start`（历史上出现过两个浮层，会让现象混乱）。
2. 让 ZCode 处于前台、有内容在动的地方（例如让它持续输出、或滚动会话列表），便于肉眼判断「是否停止刷新」。
3. 把鼠标移到角色上（此时浮层会接管鼠标），**保持指针压在角色上并点击一次**。
4. 观察宿主 ZCode：画面停在旧帧；再去点一下 ZCode 才继续刷新。

可观测信号（用于确认「确实是这个现象」而不是别的问题）：

- 浮层调试日志（默认写在 `~/.zcode/whale/overlay-debug.log`，设 `WHALE_OVERLAY_LOG=0` 可关，5MB 轮转）。点击前后应能看到这一组行：

  ```
  page-linfo [zcw] click -> showBubble moved=false
  page-linfo [zcw] interactive -> false      ← 页面向主进程请求「交还穿透」
  ipc-interactive false
  interactive-applied false
  ```

- 关键观察（本机实测）：**这三行在点击后约 100ms 内就完成**，也就是说「窗口一直霸占鼠标」并不成立，而宿主画面**依然**冻结。这一点很重要——它排除了「接管没交还」这一类解释（见第四节第 1 条）。

## 四、已尝试且无效的做法

以下都是针对本问题做过的尝试，**都无效**，且其中一条还有副作用，已全部回滚（`f69c536`）。列出来是为了避免重复。

1. **页面侧「接管看门狗」**（接管中 6 秒没有任何真实指针活动 → 强制交还穿透）
   - 期望：若指针事件流中断导致窗口一直保持接管，兜底把它放掉。
   - 实测：宿主冻结**照旧**；而上文日志证据显示点击后接管本来就在 100ms 内交还了——说明这条路径不是原因。
   - 副作用：指针停在角色上超过 6 秒后接管被强制放掉，**角色随之变得点不到**（用户点上去的其实是下面的宿主/空白）。
   - 处置：连同对应的自检钉桩与冒烟用例一起回滚（原 `lib/widget.js` 的 `notePointerActivity`/`capture watchdog`、`tools/smoke-ui.mjs` 的第 ⑮ 组用例）。

2. **周期性出帧保险不再调用 `moveTop()`**（只在窗口真的丢了置顶时才重申层级）
   - 期望：减少 z 序扰动，避免把宿主推入「被遮挡」状态。
   - 实测：宿主冻结**照旧**；真机日志里能看到新分支（`kick periodic no-movetop`）确实在跑，但现象不变。
   - 处置：回滚 `desktop/main.cjs` 的 `kickPresentation`（恢复为每次都 `invalidate()` + `moveTop()`）。

3. （历史，非本问题）浮层自身的冻结自愈：`kickPresentation` 周期兜底、`recreateWindow` 在显示器指标变化时重建窗口、以及 v1.8.6 移除的「活性点 + DXGI」主动冻结检测——这些解决的是**浮层自己停在旧帧**，与本问题（宿主冻结）无关，别把它们的效果混进来判断。

## 五、现有可观测证据与代码索引

证据（本机，浮层调试日志 `~/.zcode/whale/overlay-debug.log`）：

- 有一批 `kick periodic` 行，说明周期出帧保险在跑；回滚前能看到带 `no-movetop` 后缀的新分支。
- 点击那一刻的时序（见第三节）：`click -> showBubble` → `interactive -> false` → `ipc-interactive false` → `interactive-applied false`，都在 100ms 内；宿主仍然冻结。
- 浮层启动时会打印 `zcode-identity pid=… start=…`、`zcode-theme-observed`、`shown-at {…}`，可用于确认跟随链路正常。

代码索引（当前 main 上的实现）：

| 位置 | 作用 |
|---|---|
| `desktop/main.cjs` | 浮层主进程：创建透明置顶窗口、跟随宿主矩形、鼠标接管切换、出帧保险 |
| `desktop/main.cjs` 的 `applyInteractive()` | 接管/交还的落点：接管时 `win.setIgnoreMouseEvents(false)`，交还时 `setIgnoreMouseEvents(true, { forward: true })` |
| `desktop/main.cjs` 的 `app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion')` 等四行 | 只作用于**浮层自己**这个 Electron 进程（让它被遮挡时也照常出帧）；**管不到宿主的 Chromium** |
| `desktop/follow-window.ps1` | 常驻的 C# 轮询脚本：找宿主窗口、报矩形/可见性/进程身份/暗色标志；也提供 `replay-click` 与前台归还通道 |
| `lib/overlay.mjs` | 浮层启停、Electron 运行时安装、浮层实例枚举（`listOverlayPids`） |
| `lib/widget.js` 的 `overlayShouldInteract()` / `setOverlayInteractive()` | 页面侧判定「什么时候要接管鼠标」：拖拽中、菜单/角色列表/气泡编辑器打开时、指针落在菜单按钮或 chrome（气泡/面板）上、指针命中角色 alpha 轮廓（含 8px 迟滞） |

排查工具（现成的，不必重造）：

- 调试日志：`WHALE_OVERLAY_LOG`（默认开，写 `~/.zcode/whale/overlay-debug.log`）。
- CDP 连进浮层页面：`WHALE_DEBUG_PORT=<port>`（默认关）。
- 跟随间隔：`WHALE_FOLLOW_INTERVAL_MS`（默认 40ms，本机现为 16ms）。
- 无头复现/回归：`node tools/smoke-ui.mjs`（headless Edge + CDP），可以用注入的「假浮层桥」让页面以为自己跑在浮层里——本次回滚掉的 ⑮ 组用例就是这么做接管状态的断言的（可参考 git 历史 `2b4e692`）。

## 六、约束与已知事实（不是解法，但会影响可行方案）

- 浮层是**独立窗口**：ZCode 插件的能力清单只有 `skills / commands / hooks / mcpServers`（见官方 `plugin-creator` 技能的 manifest 规范），**没有页面内注入**这一项。
- 对照组：DSH 的小鲸鱼是**注入到宿主页面里**的客户端插件（其仓库根的 `cordis.patch.yml` 把它挂进 web profile 配置树），因此不存在独立窗口、也不存在鼠标接管切换——它结构上就不会出现这类冻结。**这条差异不能直接照搬**，因为 ZCode 侧没有对应能力（见上一条）。
- 浮层的窗口形态是刻意的：透明、置顶（`setAlwaysOnTop(true, 'screen-saver')`）、`showInactive()` 不抢前台、隐身靠透明度而非 `hide()`、只在需要打字时临时 `setFocusable(true)`。改动这些行为会牵动「点鲸鱼/拖拽/开菜单不打断 ZCode 前台」等既有约定。
- 指针接管由**页面**决定（`overlayShouldInteract()`），主进程只是执行；接管范围是**整个浮层窗口**（窗口始终铺满工作区，刻意不 `setBounds`——历史上改尺寸会让透明窗口的合成层错位，页面内容被画到窗口外）。

---

**再次说明：本文不给出任何解决方向。** 上面所有机制描述都只是记录当时的观察与推断，请独立复现、独立验证、独立设计修复方案。

---

## 附录：闭环（2026-10-14，真机 A/B 实锤，未发版）

> 上文第四节所列的三次失败尝试之后，2026-10-13 晚曾落过一版 `type:'toolbar'` 修复并报「真机无效」，后按要求回滚。次日上午重查发现「无效」另有原因，修复重新落地。以下是完整结论。

### 一、为什么 2026-10-13 晚会误判「真机无效」

- **运行副本错位**：插件实际注册运行的是 `~/.zcode/cli/plugins/cache/zcode-fox-local/zcode-fox-widget/1.0.0`（directory 安装时拷贝的快照），hook 的 `${ZCODE_PLUGIN_ROOT}` 与 autostart 都指向它；而修复当时只写进了 `~/.zcode/cli/plugins/marketplaces/zcode-fox-widget`，**从未同步到 cache 副本**。用户重启 ZCode 后测的浮层跑的是无修复代码。
- **复现方法缺陷**：当时的「隔离实验」用同应用的宿主替身有效，但真机验证缺了受控对照。次日用真机受控实验补齐后发现还有两个方法学坑：
  1. **触发场景**：冻结只在 ZCode 有内容持续输出（流式）时出现——宿主空闲时点击不触发（宿主本来就没有要刷新的内容，被遮挡判定也看不出来）。
  2. **检测方式**：冻结检测必须**完全被动**（鼠标停住不给输入）。检测期间摆动鼠标会用悬停高亮的重绘掩盖冻结，得出「未冻结」的假阴性——第一批实验因此全数误判。

### 二、真机 A/B 验证（2026-10-14 09:08–09:10）

环境：ZCode 3.15.3.8237（exe 内嵌 UA：Electron 41.0.3 / Chromium 146.0.7680.80）；浮层 Electron 44.4.5；同一台真机、同一流式任务。探针：GDI 全窗截图 blake2b 哈希，88ms 一帧，完全被动采样；唯一干预变量是跨进程 `SetWindowLongW` 增删浮层的 `WS_EX_TOOLWINDOW`。

| 轮次 | 浮层 TOOLWINDOW 位 | 基线（点击前 3s） | 点击角色后 10s | 结果 |
|---|---|---|---|---|
| 对照 | 无（原生形态） | 34/34 帧变化 | 113 帧仅 8 个不同，最长静止 57 帧（≈8.5s） | **冻结** |
| 验证 | 有（跨进程补上） | 34/34 帧变化 | 113/113 帧全变，静止 0 | **不冻结** |

细节：点击后画面并非立即停住，还持续变化了约 5 秒才静止——与宿主遮挡重算由 WinEvent 触发、非瞬时一致（样式变化本身不触发重算，要等前台/位置类事件）。

### 三、机制总结（闭环）

1. Electron 44 的 `skipTaskbar:true` 走 ITaskbarList，**不再**给窗口设 `WS_EX_TOOLWINDOW`（Electron 44 实测；更早版本会设）。
2. 点击角色 → 页面请求接管 → `setIgnoreMouseEvents(false)` 摘掉 `WS_EX_TRANSPARENT|WS_EX_LAYERED`。
3. 此刻浮层 = 铺满工作区 + 置顶 + 无 TOOLWINDOW + 无前两位透明样式 → 满足宿主 Chromium 遮挡判定 `IsWindowVisibleAndFullyOpaque` 的「完全不透明遮挡源」谓词（ZCode 所用 Chromium 146 与 134 谓词一致，实测确认）。
4. 宿主判定自己被完全遮挡 → 停止向屏幕出帧（画面停在旧帧）。浮层交还穿透后**不会自动恢复**：样式变化不触发遮挡重算，要等一次前台变化/位置事件（用户「点一下 ZCode 才恢复」）。
5. 修复：`new BrowserWindow({ type: 'toolbar' })`（仅 win32）让窗口创建即带 `WS_EX_TOOLWINDOW` 且全程保留（含 `setFocusable` 键盘焦点路径）→ 任何模式下都不进宿主的遮挡判定。隔离实验（同应用宿主替身）与真机 A/B 均验证有效。

### 四、遗留

- 排查时的方法学教训与可复用探针（被动采样、流式触发、跨进程样式位干预、窗口栈快照）记录于项目记忆 2026-10-14；实验脚本在 `C:/Users/<用户>/AppData/Local/Temp/zcw-live/`。
- 插件存在多副本（marketplaces 源目录 / cache 安装快照），改动必须**两处同步**，否则运行的是旧代码——这次误判的根源。

---

## 附：修复报告原文（ZCode 线，2026-10-14）

> 写给主项目 AI（发版负责人）。2026-10-14 由桌面浮层排查会话生成。
> 按仓库惯例本报告不入库（untracked），发版时连同 `OVERLAY-PAUSE-FINDINGS.md` 一并定夺。
> **本修复已提交，但按用户要求未发版**：版本号保持 v1.11.1、未打 tag、未发 Release，等你一起发。

## 30 秒摘要

- **解决了什么**：桌面浮层形态下，agent 流式输出进行中把指针压到角色上点击 → **宿主 ZCode 画面停在旧帧**（点一下 ZCode 才恢复）。即 issue #2 的第一个症状，`OVERLAY-PAUSE-FINDINGS.md` 调查的问题。已真机 A/B 实锤修复，用户实测通过。
- **怎么解决的**：一行修复——浮层窗口创建加 `type: 'toolbar'`（仅 win32），让窗口从创建起常驻 `WS_EX_TOOLWINDOW`，从而**永远不进宿主 Chromium 的遮挡判定**。
- **你要做的**：下次发版时把这版带上（版本号建议 v1.11.2，`CHANGELOG.md` 已备好「未发布」条目，改个标题即可），tag/Release/cache 同步照常流程。**绝对不要删掉 `type: 'toolbar'`**（原因见下）。

## 问题机制（闭环链路，全部实测确证）

1. 点击角色 → 页面请求接管鼠标 → Electron `setIgnoreMouseEvents(false)` 会**摘掉**窗口的 `WS_EX_TRANSPARENT|WS_EX_LAYERED`。
2. 此刻浮层 = 铺满工作区 + screen-saver 级置顶 + **没有 `WS_EX_TOOLWINDOW`**（实测 Electron 44.4.5 的 `skipTaskbar:true` 走 ITaskbarList，不再落这个样式位）。
3. → 满足宿主 ZCode 自己的 Chromium 遮挡判定 `IsWindowVisibleAndFullyOpaque` 的「完全不透明遮挡源」谓词（ZCode 3.15.3 = Electron 41.0.3 / Chromium 146.0.7680.80，谓词与 134 逐条核对一致）。
4. → 宿主判定自己「被完全遮挡」→ **停止向屏幕出帧**。浮层进程里的 `disable-features=CalculateNativeWinOcclusion` 只作用于浮层自己，管不到宿主——这就是此前在本浮层进程里怎么加开关都没用的原因。
5. 交还穿透后**不会自动恢复**：样式变化不触发遮挡重算，要等一次前台/位置类 WinEvent——对应「点一下 ZCode 才恢复」。

## 修复

`desktop/main.cjs` 窗口创建处：

```js
...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
```

Electron 对 `type:'toolbar'` 的窗口**创建即设 `WS_EX_TOOLWINDOW`，且穿透/接管/`setFocusable` 键盘焦点各态全程保留**（真机逐态采样验证）。该样式位在 Chromium 遮挡谓词里被直接排除 → 浮层任何模式下都不构成宿主的遮挡源。

附带收益：历史上「点菜单文本框后浮层在任务栏冒幽灵按钮」（`setFocusable(true)` 重写样式冲掉 TOOLWINDOW）也从源头修掉；`follow-window.ps1` 的 `EnsureToolWindow` 跨进程补写保留为安全网。

## 验证证据

- **真机 A/B**（2026-10-14 09:08–09:10，同机同流式任务，唯一变量=跨进程 `SetWindowLongW` 增删该样式位；探针=GDI 全窗截图 blake2b 哈希，88ms/帧，**完全被动采样**）：
  - 无 TOOLWINDOW：基线 34/34 帧变化 → 点击后 113 帧仅 8 个不同、最长静止 ≈8.5s（**冻结**）
  - 有 TOOLWINDOW：基线 34/34 → 点击后 113/113 帧全变（**不冻结**）
- **修复上机核验**：用户重启浮层后，穿透态样式实测 `NOACTIVATE|TOPMOST|TRANSPARENT|LAYERED|TOOLWINDOW`（0x082800A8）。
- **用户验收**：日常使用（含流式输出中点击角色）测试完毕，一切正常。
- **自检**：干净 HEAD + 本修复 = `tools/selftest.mjs` 285/285 全绿。

## 复现方法学的两个坑（后来者别再踩）

1. **触发场景**：冻结只在宿主有内容持续输出（流式）时出现；宿主空闲时点击不触发。
2. **检测方式**：冻结检测必须完全被动（鼠标停住不给输入）。检测期间摆动鼠标会用悬停高亮的重绘掩盖冻结 → 假阴性。

## 历史包袱澄清（重要）

- 2026-10-13 晚曾落过同一修复并报「真机无效」后回滚——**那是误判**：插件实际注册运行的是 `~/.zcode/cli/plugins/cache/zcode-fox-local/zcode-fox-widget/1.0.0`（directory 安装快照，hook 的 `${ZCODE_PLUGIN_ROOT}` 与 autostart 都指向它），当时修复只写进了 marketplaces 源目录，**从未同步到 cache**，用户测的是无修复代码。我已手动把 `desktop/main.cjs`/`CHANGELOG.md`/`OVERLAY-PAUSE-FINDINGS.md` 同步到 cache 副本（diff 核验一致），你发版后记得走标准 `git archive` 同步流程覆盖。
- 更早两次无效尝试（接管看门狗、周期出帧去 moveTop）确实无效，与本次修复不冲突，详见 `OVERLAY-PAUSE-FINDINGS.md` 第四节。
- `lib/cli.mjs`、`lib/server.mjs`、`lib/service.mjs`、`lib/update.mjs` 当前工作区的未提交改动**属于你的会话（更新/重启逻辑加固），我没有动它们**，也未包含在本提交里。注意：当前工作区跑 `tools/selftest.mjs` 会挂 1 项「账本状态机：换 key 整本归档」——已在干净 HEAD 验证过，那是 WIP lib 改动引入的，与本修复无关，你收尾时处理。

## 提交信息

- 提交内容：`desktop/main.cjs`（修复+注释）、`CHANGELOG.md`（「未发布」条目）。
- 未提交（按惯例 untracked，发版时定夺）：本报告、`OVERLAY-PAUSE-FINDINGS.md`（含闭环附录）、`HANDOFF.md` 等既有报告。
- 发版清单（你来做）：三处版本号 →（决定是否入库 FINDINGS/本报告）→ tag → Release → `git archive HEAD | tar -x -C <cache 副本>` → 重启服务/浮层。
