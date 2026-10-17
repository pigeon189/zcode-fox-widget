# 代码审查报告：WorkBuddy 狐娘小挂件（fox-widget）移植版

> **状态**：已闭环（2026-10-14）· 仅作历史参考，不再更新
> **结论去向**：P0-1/P0-2、P1-1…P1-5 均已修，逐条对应 `wb-v1.0.0` 条目；后续代码审查
> （I/S/X/P/C）与 UI 审查（P0–P2）又各修了一批，见 `CHANGELOG.md` 的「未发布」。
> **原文**：本次未改正文，仅前置本段


**审查对象**：`workbuddy/main-56fc9dd2` 分支工作区（含未提交改动：`desktop/main.cjs`、`lib/{cli,overlay,server,turn-cost,usage-records,watchdog-cli,widget}.js|mjs`、`lib/host-models.mjs`（未跟踪）等 12 个文件）
**审查方式**：静态审查 + 隔离环境复现 + 真实宿主数据实测（宿主库一律复制后只读）
**测试实况**：`tools/selftest.mjs` 311/311 ✅、`tools/selftest-update.mjs` 50/50 ✅、`tools/smoke-ui.mjs` 103/103 ✅（三套全绿，但下述缺陷均在这三套的覆盖盲区里）

> **基线声明（重要）**：本审查开始时（20:32）工作区处于「有未提交改动」状态；审查过程中该工作区被**并发修改**——
> `lib/widget.js` 20:35:39、`lib/watchdog.mjs` 20:42:51（328→336 行，新增「服务常暖」「版本哨兵」）、
> `tools/selftest.mjs` 20:43:25（自检条数已增至 313+），而审查用的 311/311 是 20:34 时刻的文件跑出来的。
> **本报告的全部结论已在 20:47 对当前文件逐条重新核对过**（行号即为当前行号），下面标注「已复核」的条目不受该并发修改影响；
> 但请注意结论对应的**不是**某个固定 commit，交付给实施者时应以复查时的文件内容为准。

**结论**：**REQUEST_CHANGES**

---

## 一、阻断问题（P0，修完再审）

### P0-1 看门狗把「宿主退出」当成「宿主启动」，退出语义整体反转

| 项 | 内容 |
|---|---|
| 级别 | **阻断** |
| 文件:行 | `lib/watchdog.mjs:223-257`（`watchHostLog`）、`:259-262`（`startWatchers`，关键在 `:260`）、`:55`（`APP_SHUTDOWN_LOG`） |
| 相关 | 文档声明在 `lib/watchdog.mjs:17`（「监听 AppShutdown.log 的追加 → wbUp 置假」） |
| 复核 | 已复核：20:47 读当前文件，`watchHostLog` 仍然**只比文件大小、不解析内容** |

**证据（两条，互相独立）**

1. **磁盘事实**：宿主的退出行写的是 `AppStartup.log`，不是 `AppShutdown.log`。
   - `grep -c AppShutdown ~/.workbuddy/logs/AppStartup.log` → **30**
   - 样例：`2026-10-13T19:02:22 [AppShutdown] ... reason=before_quit`
   - `find ~/.workbuddy/logs -iname "*shutdown*"` → **空**（全盘没有 AppShutdown.log）
   - 今日（10-14）AppStartup.log 里 `[AppShutdown]` 行 **20 条**（12:54 起至 19:45）

2. **隔离环境实验**（临时 home + 独立端口，看门狗真实运行）：往 `AppStartup.log` 追加一条 `[AppShutdown] ... reason=before_quit` 后，日志出现：

```
host-down: AppShutdown.log append          ← 我先人为造出该文件才触发的「正确路径」
ensure[AppStartup.log append] server started on port 39781   ← 第 4 步（退出行）反而拉起服务
host-up: AppStartup.log append             ← 把宿主退出的那行判成"宿主启动"
host-down: AppShutdown.log append          ← 再次证明 wbUp 已被置回 true
```

（实验脚本要点：临时 `CODEBUDDY_HOME` + `FOX_WIDGET_DATA_DIR` + 独立端口，`autoStartOverlay:false` 避免拉起 Electron。若需复现，注意第 3、5 步是**人为创建** AppShutdown.log 才能走到的对照路径。）

**期望 / 实际**

- 期望：退出信号 → `noteHostDown()` → 启动宽限期倒计时 → 宽限后停服务，浮层随之退出。
- 实际：`watchHostLog(APP_STARTUP_LOG, () => noteHostUp(...))` 只看**文件是否变大**、不解析内容，退出行照样走 `noteHostUp()` → `wbUp=true`、`hostGoneAt=0`（`lib/watchdog.mjs:183-190`）→ 宽限期**永不启动**，并且主动 `scheduleEnsure()` 去拉起服务与浮层。

**影响**：① 「服务随应用存在」的语义失效（退出后服务常驻）；② 宿主退出后每 15s 尝试重建一个注定会立刻退出的 Electron（跟随脚本发现目标进程没了 → 浮层自杀 → 下个 tick 再拉起），形成空转重建循环；③ 唯一真实的 host-down 通道（`AppShutdown.log`）在这台机器上从未存在 → 全机的 host-down 只来自 `overlayFails>=3` 这条启发式（看门狗日志里也确实只有 `host-down: overlay-fails-3` 一条）。

**修复建议**

1. `watchHostLog` 的回调把「新增的字节」传出来，按行分流：
   `if (/\[AppShutdown\]/.test(newText)) noteHostDown(...) else noteHostUp(...)`（读增量而不是只比 size）；
2. `AppShutdown.log` 的监听保留，但在注释与文档里如实标注「宿主实测不写该文件，属兜底」；
3. 补一条「AppStartup.log 里出现 `[AppShutdown]` 行 → 不得置 wbUp=true」的测试。

---

### P0-2 主显示「今日积分」系统性低估（实测 −16%），且接口自报覆盖率掩盖了截断

| 项 | 内容 |
|---|---|
| 级别 | **阻断**（产品主指标错误） |
| 文件:行 | `lib/usage-records.mjs:26`（`TAIL_BYTES = 2MB`）、`:195`（`readTranscriptTurns(f.file, TAIL_BYTES)`）、`:305-306`（`scannedTranscripts/totalTranscripts`） |

**证据（真实宿主数据，复制后只读）**

在同一 14 个 transcript 的目录上，对比「挂件实际展示口径」与「整文件全量口径」：

```
挂件实际展示（usage-records，2MB 尾部窗口）：今日积分 = 2001.52 ，调用 554 次；扫描范围 14/14
全量口径（整文件，无截断）：                  今日积分 = 2377.04 ，调用 1552 次
低估量 = 375.52（16%）                        ← 调用次数低估 64%
```

单文件对照（本机最大会话，17.1MB）：

```
窗口  2MB → 轮数= 7，今日合计=347.90
窗口  4MB → 轮数= 8，今日合计=363.31
窗口  8MB → 轮数=12，今日合计=434.60
窗口 40MB → 轮数=19，今日合计=611.97
```

本机 14 个 transcript 中 **3 个 > 2MB**（最大 17.1MB）；单轮 agent 循环（实测有 50 次模型调用的轮次）就能吃掉整个窗口的大半。

**期望 / 实际**

- 期望：标称「今日积分」= 今天的真实积分合计；标注的扫描范围（`14/14`）等于实际覆盖范围。
- 实际：按文件尾部 2MB 截断，整轮整轮地丢失；而 `scannedTranscripts/totalTranscripts` **只反映文件数、不反映字节截断**，界面与 `SKILL.md`（「如实暴露范围」）会让人以为统计是完整的。

**修复建议**

1. 至少把截断事实暴露出来：每个文件返回 `bytesScanned/bytesTotal`（或 `truncated:true`），界面注明「仅统计最近 N MB，可能偏低」；
2. 提高/取消尾部上限，或让「今日」改走宿主的 `credit_json`（它有全量历史，见建议 A）；
3. 解析结果按 `(path, mtime, size)` 缓存，避免「为了准确就必须全量重读」的取舍。

---

## 二、重要问题（P1）

### P1-1 新加的「免费模型」气泡分支双重不可达（功能实际不生效）

| 项 | 内容 |
|---|---|
| 级别 | 重要 |
| 文件:行 | `lib/widget.js:3440`（新分支） ← 被 `lib/widget.js:3431`（`turn.billable === false`）遮蔽；`lib/server.mjs:836-869`（`lastTurnPayload` 未透传 `free/freeLabel`，`:858` 只透传 `billable`）；`lib/turn-cost.mjs:488`（`billable: credit > 0`） |
| 复核 | 已复核（`widget.js` 在审查期间被改过，行号已按当前文件校正：`3431` / `3440`）；`lib/server.mjs` 全文 **grep 不到 `free`/`freeLabel` 字段** |
| 文档承诺 | `skills/fox-widget/SKILL.md`、`README`、`plugin.json` 描述均称「这一轮不扣积分时直接说免费（宿主促销文案）」 |

**证据（端到端：真实 `lib/server.mjs` + headless Edge + CDP）**

构造宿主商品配置 `step-5-preview: credits "x0.00"` + 促销 `badge.label="独家限免"`、`discount.factor=0`，推进轮次后读真实气泡 DOM：

```json
{ "label": "本轮 tokens:", "amount": "12.3 万", "hint": "" }
```

期望 `{ "label": "上一轮消耗:", "amount": "独家限免" }`。同时抓取服务端载荷：

```
推进后弹的载荷: turn=turn_free credit=0 billable=false free=undefined freeLabel=undefined
```

**两处独立成因**（任一即可致该分支失效，两处都中）：

1. **分支顺序**：`lib/turn-cost.mjs:488` 把 `billable` 定义为 `credit > 0`；免费轮 credit=0 → `billable=false` → `lib/widget.js:3431` 的「本轮 tokens」分支先命中，`:3440` 的免费分支永远到不了；
2. **字段未透传**：`lib/server.mjs` 的 `pollTurnCost` 组装 `lastTurnPayload` 时**没有** `free`/`freeLabel` 两个字段（实测载荷里是 `undefined`），`lib/turn-cost.mjs:489-490` 算出来的值在气泡这条链路上被丢掉（用量记录面板那条链路有传，所以面板是好的）。

**修复建议**

1. `lastTurnPayload` 补 `free` / `freeLabel`；
2. 把免费分支移到 `billable === false` 之前（或让 `billable` 在 `free` 时为 true，语义上「不扣钱」≠「没有价目」）；
3. 加一条端到端断言（当前零覆盖，见「缺失测试」）。

---

### P1-2 自更新在 WorkBuddy 线永远不可用：tag 前缀不一致

| 项 | 内容 |
|---|---|
| 级别 | 重要 |
| 文件:行 | `lib/update.mjs:281`、`:286`（写死 `'v' + version`） vs `lib/update.mjs:31`（`TAG_PREFIX='wb-v'`）、`:167`、`:191`（都用 `TAG_PREFIX`） |

**证据（注入 fetch 实测）**

```
TAG_PREFIX = wb-v
tarball tag = wb-v2.0.1                       ← 下载用 wb-v
verifyReleaseTag 探测的 URL：
  https://ghproxy.net/https://raw.githubusercontent.com/.../v2.0.1/.codebuddy-plugin/plugin.json   ← 复核用 v
  https://gh-proxy.com/https://raw.githubusercontent.com/.../v2.0.1/.codebuddy-plugin/plugin.json
  https://api.github.com/repos/.../git/ref/tags/v2.0.1
返回值 = false （false = 判定「尚未发布」→ 永不提示可更新）
```

仓库现有 23 个 tag，**`wb-v*` 数量为 0**（ZCode 线用 `v`，WorkBuddy 线约定 `wb-v`，见 `CHANGELOG.md`）。因此 `checkForUpdate` 在 `:811-817` 会稳定地把可用更新改判成 `available:false` + 「尚未发布可下载包（发版中），稍后再试」。

**期望 / 实际**：期望按发版约定复核 `wb-v<版本>`；实际复核的是 ZCode 线的 `v<版本>`，恒 404。

**可达性**：用户可从挂件菜单点「检查更新」（`lib/widget.js:2155`、`:2022`）→ `POST /whale/update.json {action:"check"}` → `lib/server.mjs:1503`（未传 `verifyTag:false`），因此这是**用户可见**的失败路径。

**修复建议**：`verifyReleaseTag` 用 `TAG_PREFIX + version` 拼 raw 与 git-ref 两处；补一条不传 `verifyTag:false` 的测试。

---

### P1-3 jsdelivr 兜底下载路径必然失败（tag 前缀与路径两处都错）

| 项 | 内容 |
|---|---|
| 级别 | 重要 |
| 文件:行 | `lib/update.mjs:465`、`:481`（jsdelivr 引用用 `@v<version>`，而本线 tag 是 `wb-v<version>`）、`:473`（`walk()` 里 `paths.push(n.name)`）、`:485`（`files.set(p, body)`） |
| 复核 | 已复核：20:47 三个位置均在当前文件中（未受并发修改影响） |

**证据**

(a) **引用前缀错**：`:465` 请求清单 `https://data.jsdelivr.com/v1/packages/gh/<repo>@v<version>`、`:481` 拼 `https://cdn.jsdelivr.net/gh/<repo>@v<version>/<path>` —— 用的是 **ZCode 线**的 tag 前缀 `v`，而本线约定 `wb-v`（`lib/update.mjs:31`）。检查清单这一步就会 404。
更麻烦的是：**若 ZCode 线存在同号 tag**（`v2.0.1`），这里会拿回**另一条产品线**的文件树；而落地前的校验只比版本号、**不校验插件名**（`lib/update.mjs:868-870`：`下载内容版本不符（期望 v… ，包内 v… ）`），于是 ZCode 线的代码会被装进 WorkBuddy 副本（两条线的 `.codebuddy-plugin` / 宿主适配层完全不同，属跨线污染）。

(b) **路径拼装错**：jsdelivr 清单是**嵌套树**，节点的 `name` 是自身名，目录信息在 `files` 子节点里：

```
GET https://data.jsdelivr.com/v1/packages/gh/jquery/jquery@3.6.0
{ "type":"gh", "name":"jquery/jquery", "files":[
    { "type":"directory", "name":".github", "files":[ {"type":"file","name":"ISSUE_TEMPLATE.md", ...} ] } ...] }
```

本仓库有 `lib/`、`desktop/`、`tools/` 等目录，因此 `paths` 得到的是 `cli.mjs`、`main.cjs`… 这类**扁平 basename** → 拼出的 URL 缺目录段（`.../fox-widget@v…/cli.mjs`）→ 404，整个兜底函数抛错，表现为「全部下载源失败：cli.mjs HTTP 404」；即便某个 URL 侥幸 200，`files` 的键也全错 → `planApply`/`applyToRoot` 会把文件写到错误位置。

而该函数被注释声明为「tarball 镜像全挂时的**最后兜底**」（`lib/update.mjs:462`），等于这条兜底事实上不存在。

**修复建议**：① 三处 jsdelivr 引用统一用 `TAG_PREFIX + version`；② `walk(nodes, prefix)` 递归时拼接父路径，返回前再走一次 `normalizeArchivePaths` 收敛；③ 落地前除版本外再校验包内 `plugin.json` 的 `name === 'fox-widget'`（防跨线污染）。

---

### P1-4 `startOverlay` 的去重仍是「杀不掉当成功」，与刚修好的 `stopOverlay` 不对称

| 项 | 内容 |
|---|---|
| 级别 | 重要 |
| 文件:行 | `lib/overlay.mjs:277-291`（`:284` 判杀、`:291` 回报 `deduped: killed`） vs `:357-399`（同一文件里刚改对的版本，`:371` 复验、`:385` 纯函数）、`:182-201`（`killPidTree`，`:194` 判退出码） |
| 复核 | 已复核：20:47 行号与内容一致（`overlay.mjs` mtime 19:31，未被并发修改） |

**证据**

```js
for (const pid of live) { if (pid === keep) continue; if (killPidTree(pid)) killed++ }
writeOverlayInfo({ pid: keep, ... })
return { running: true, started: false, pid: keep, ..., deduped: killed }
```

`killPidTree` 在权限不足时返回 `false`（`:194` 只在 `status === 0` 时返回 true），此处**不复查存活**、照样 `writeOverlayInfo(keep)` 并回报 `running:true`。而同一文件的 `stopOverlay` 已改为「收完复验 + 排不掉就如实报错并保留记录」（`:367-379`，`overlayStopOutcome` 见 `:385`）。

**期望 / 实际**：期望与 `stopOverlay` 同口径（收不掉就不宣称成功）；实际会把「桌面上有两个角色」报告成 `deduped:0 / running:true` 的正常态，上层（钩子/看门狗/自启）全部被骗过。

**修复建议**：复用 `overlayStopOutcome()` 判定，未清掉的 pid 回带 `ok:false + alive[]`。

---

### P1-5 1 秒轮询里做 8MB 同步读 + 逐行 JSON 解析（实测 30ms/次）

| 项 | 内容 |
|---|---|
| 级别 | 重要（性能） |
| 文件:行 | `lib/server.mjs:804`（`pollTurnCost` 里的 `readLatestTurn()`）、`:1618`（`setInterval(pollTurnCost, 1000)`）、`lib/turn-cost.mjs:299-318`（`readTranscriptTurns`：`readFileSync` 全量 + `split` + 逐行 `JSON.parse`） |
| 复核 | 已复核：`server.mjs` mtime 20:17（早于审查读取），行号与内容一致 |

**证据**：真实 17.1MB transcript 上，`readLatestTurn()` 连续 5 次平均 **30.0 ms/次**（本机 node v22.22.2、`node:sqlite`）。即每秒一次 8MB 同步读 + 解析，事件循环被按住约 3% 的时间；期间 `/whale/health`、`/whale/last-turn.json`、`/whale/size.json` 全部排队（浮层页面同时在 1s 轮询其中若干个）。

**修复建议**：按 `(path, mtime, size)` 缓存解析结果（增量：只读新增尾部字节）；或把轮次探测改成「transcript 变更事件 + 低频兜底」。新增的 `readLatestTurn(1)`（同一改动引入）只在轮次推进时多调一次，有界，可不改。

---

## 三、建议（P2/P3，不阻断）

| 编号 | 级别 | 位置 | 问题与证据 | 建议 |
|---|---|---|---|---|
| A | P2 | `lib/turn-cost.mjs:532-535`、`skills/fox-widget/SKILL.md` | 文档称 `credit_json`「按请求覆盖，一个会话只留最后一笔」，据此否定了它做「今日合计」的资格。**实测推翻**：单会话 `credit_json` 有 **18** 个请求键（另有 4/7 键的会话）。由此 ① 兜底函数 `todayCreditFromUsage()` 只取最后一笔，恒低估；② 「今日合计」（transcript 口径）与「上一轮」（credit_json 口径）在同一轮上会互相矛盾——实测同尾窗 12 轮中 9 轮两口径完全一致，2 轮不同（`+6.52` / `−7.97`），净 `+2.4%` | 修正注释与文档；统一权威口径，或把差异作为「对账项」显式展示 |
| B | P2 | `lib/watchdog-cli.mjs:83` | `cacheBase = path.dirname(PLUGIN_ROOT)` 只在 `cache/<市场>/<插件>/<版本>` 布局下成立。本机装出的 VBS 指向 `.../plugins/cache/fox-local/fox-widget`（正确，且字节头 `27 20`、无 BOM，P0 级的历史编码问题已确证修好）；但当插件以**仓库根/本地市场**形态存在时（`marketplace.json` 的 `source:"./"` 就是该形态，README 也指导在仓库里跑 `watchdog install`），`dirname` 会变成仓库的父目录（本机为 `Worktrees/zcode-fox-widget/`），循环将扫描兄弟目录挑"最新副本" | 显式区分两种布局：cache 布局才扫版本目录，否则直接用当前副本路径作 base |
| C | P2 | `lib/hook-event.mjs:67-75` | 原子写失败被 `catch {}` 全吞。现场残留 `hook-state.json.29760.tmp`（19:14）证明 rename 至少失败过一次；失败无任何日志，后果是会话身份静默停更 → 每轮消耗/上下文余量/当前模型全部失效 | 失败时落一行诊断并清理陈旧 tmp；必要时重试 |
| D | P2 | `.codebuddy-plugin/plugin.json:3`、`marketplace.json`（均 `2.0.0`） vs README/SKILL/CHANGELOG 里的 "v2.0.1" | 代码里已含多项标注 "v2.0.1" 的修复，但清单版本仍是 2.0.0，且仓库 **0 个 `wb-v*` tag**。即使修好 P1-2，也已安装的 2.0.0 用户检测不到/下载不到这些修复 | 发版时同步 bump 三处版本并打 `wb-v2.0.1` tag |
| E | P3 | `lib/overlay.mjs:193-194` | 注释写「退出码非 0（128）也算『已达成』」，实现是 `return !!r && r.status === 0`，与注释相反。当前无害（调用方已不看返回值），但这类注释正是本项目历史上误导后续改动的来源 | 改注释，或按注释实现 || F | P3 | `lib/update.mjs:220`（`redirect:'follow'`）、`lib/credentials.mjs:25-51` | 出站只校验**首跳**主机，跟随重定向后不再复核。风险低（需白名单主机作恶/被劫持），但与「出站一律过 `assertSafeUpstream`」的声明不完全对齐 | 改 `redirect:'manual'` 或逐跳复验 |
| G | P3 | `lib/mcp-server.mjs:308-317` | `initialize` 原样回显客户端请求的 `protocolVersion`（而非服务端支持的版本） | 回自己的 `PROTOCOL_FALLBACK`，或做一次版本协商 |
| H | P3 | `lib/watchdog.mjs:229-241` | `fs.watch` 失败/目录被替换后不再重挂（仅一条日志），此后只剩 5 分钟探测兜底 | 失败后定时重试挂载 |
| I | P3 | `lib/watchdog.mjs:266-272` | 「连续 3 次拉不起浮层 → 判定宿主不在」把**浮层系统性故障**误判为宿主退出（09:34 日志实测发生过：`overlay-fails-3`，当时宿主明明在跑，根因是 `ELECTRON_RUN_AS_NODE`） | 区分「宿主不在」与「浮层自身起不来」，后者应继续按 15s 重试并上报 |

---

## 四、缺失测试（与缺陷一一对应）

| 缺失的测试 | 本该拦住 |
|---|---|
| **免费模型端到端**：没有任何断言覆盖 `readLatestTurn().free/freeLabel → /whale/last-turn.json → 气泡文案`。后端 `hostModelInfo` 有 15 条单测（`tools/selftest.mjs:2321-2406`），前端一条都没有 | P1-1 |
| **更新链路 tag 复核**：`checkForUpdate` 的 tag 复核分支只以 `verifyTag:false` 被调用（`tools/selftest-update.mjs:317`）；冒烟里的更新面板把 `/whale/update.json` **整条接口桩掉**（`tools/smoke-ui.mjs:2171`，另 `:1339-1350` 桩掉 session/usage），`verifyReleaseTag` 的 404 场景永远构造不出来 | P1-2 |
| **jsdelivr 路径拼装与 ref 前缀**：只有源码正则钉（`tools/selftest-update.mjs:554-558`），不检验 `paths` 的目录段是否保留、也不检查 `@v` 与 `wb-v` 是否一致 | P1-3 |
| **长 transcript 截断**：所有 fixture 的 transcript 都是 KB 级，没有「单会话 > TAIL_BYTES」的用例 | P0-2 |
| **宿主日志分流**：没有任何测试覆盖「`[AppShutdown]` 行走 `AppStartup.log`」这一真实形态；`watchHostLog` 只有 size 比较逻辑被间接跑到 | P0-1 |
| **overlay 启停集成**：`overlayStopOutcome` 有纯函数单测，但 `stopOverlay` 本体的「记录还原/清理」分支、`startOverlay` 的去重（P1-4）无集成测试 | P1-4 |
| 权限场景（管理员浮层收不掉）无法在 CI 复现，可接受；至少应加一条「`killPidTree` 返回 false 时上层行为」的断言 | P1-4 |

---

## 五、安全 / 性能 / 兼容性小结

**安全（未发现阻断项，边界扎实）**
- 只绑 `127.0.0.1`（`lib/server.mjs:1614`）；Host 校验（`:948-952`）+ 写操作 Origin 校验（`:954-959`）+ 仅收 JSON body（`:961-992`）
- 页面 CSP 以 header + meta 双份下发（`lib/server.mjs:1078-1079`、`:1124-1125`），无内联脚本
- 浮层：`contextIsolation:true` + `nodeIntegration:false`（`desktop/main.cjs:253-258`）、`setWindowOpenHandler` 拒绝新窗口且外链只走 `shell.openExternal` 的 http(s)（`:273-284`）、preload 只暴露白名单方法
- 路径处理一律 `path.basename` 夹住（`lib/server.mjs:134`、`:762`、`:383`）；tar 解包丢弃含 `..`/绝对路径/盘符的条目（`lib/update.mjs:389-403`）；解压有 `maxOutputLength`/文件数/总量上限（`:405-428`）
- 出站白名单 + 拒环回/私有/保留地址（`lib/credentials.mjs:25-51`、`lib/blocked-host.mjs`）
- **本文件头已声明**的显式取舍：写接口不加令牌（本机进程在信任边界内），仅 `/whale/shutdown` 用令牌（`:1478`）。**不视为缺陷**。
- 余项：P3-F（重定向不复核）、P2-C（静默失败）与固定 `TOKEN`/`windowsHide` 之类无异议项。

**性能**
- P1-5 为主（1s × 30ms 同步阻塞）。其余取舍合理：`listOverlayPids()` 的 PowerShell（~1.8s）已从钩子路径移除（钩子只用 `pid + kill(pid,0)`，`lib/hook-event.mjs:106-114`）；`hostModelInfo` 60s TTL 缓存；`persistSeq` 与 `applyToRoot` 的原子/异步落盘；`host-models` 只在缓存失效时读盘。

**兼容性**
- P2-D（版本/发版 tag）、P3-G（`initialize` 回显）。
- 硬约束现已满足：`desktop/follow-window.ps1` 非 ASCII 字节数 **0**（此前唯一必须纯 ASCII 的文件）；启动项 VBS 落盘首字节 `27 20`、无 UTF-8 BOM（WSH `800A0408` 那个历史故障已确证修好）。
- 看门狗仅 Windows 是显式设计（README 已写）。

---

### 三套测试的实测结论

- `tools/selftest.mjs` → **311/311 通过**（20:34 时刻的文件；该文件 20:43 被再次修改，现已增至 313+ 条）
- `tools/selftest-update.mjs` → **50/50 通过**
- `tools/smoke-ui.mjs` → **103/103 通过**（headless Edge + CDP，真实页面）

三套全绿，但本报告的两个 P0 与 P1-1 **全部落在它们的覆盖盲区**里（见「缺失测试」）——这正是本次审查的价值所在：绿灯不等于主指标正确。

同时确认了几项此前修复**确实已落地**（不是纸面声明）：
- 启动项 VBS 编码：本机装出的 `%APPDATA%\...\Startup\fox-widget-watchdog.vbs` 首字节 `27 20`、无 `EF BB BF`，指向 `...\plugins\cache\fox-local\fox-widget`（`WSH 800A0408` 那个静默失效已修好）；
- `desktop/follow-window.ps1` 非 ASCII 字节数 **0**（硬约束保持）；
- 浮层已能被看门狗/自启正常拉起（`autostart.log` 记 `overlay=started`、`overlay.json` 有实时 pid）。

---

## 六、结语

三套既有测试全绿（311/50/103），但 P0-1、P0-2、P1-1 恰好都落在「fixture 太小 / 只做源码正则 / 没有端到端断言」的盲区里；P1-2、P1-3 则落在「只测 happy path 的桩」里。建议在修 P0/P1 的同时补上对应的测试，否则同类问题会以同样方式再次溜过。

**判定：REQUEST_CHANGES**
