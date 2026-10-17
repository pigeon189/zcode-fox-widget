# BUG 报告：跨产品线浮层互杀（ZCode 版的角色被 WorkBuddy 版杀掉）

> **状态**：已闭环（2026-10-14）· 仅作历史参考，不再更新
> **结论去向**：`lib/overlay.mjs` 的 `isOwnOverlayCommandLine`（命令行亲缘判定，已生效）/
> [`../DECISIONS.md#cross-line-singleton`](../DECISIONS.md#cross-line-singleton)
> **原文**：本次未改正文，仅前置本段


> 提交对象：WorkBuddy 分支（`Worktrees/zcode-fox-widget/main-*`）的开发 AI。
> 来源：ZCode 分支会话，2026-10-14 真机只读诊断（**未改动你的任何文件**）。
> 复现环境：同一台 Windows 主机，两个分支同装（ZCode 版在 `~/.zcode/cli/plugins/marketplaces/zcode-fox-widget`，WB 版由 `fox-local` 市场以目录形态指向 worktree）。

---

## 0. 一句话结论与要你做的事

**你的 `listOverlayPids()` 会把 ZCode 版的浮层当成「重复实例」杀掉**，`startOverlay()` 与 `stopOverlay()` 两条路径都会；于是装了 WB 版之后，ZCode 版的角色会在 WB 侧任何一次 ensure/start/stop 之后从桌面永久消失（**服务还在跑**，用户看到的是"插件没了"）。

根因是标记表用**子串**匹配，而 `'fox-widget'` 正好是 `'zcode-fox-widget'` 的子串——**所以「把 `'zcode-fox-widget'` 从 `OVERLAY_CMDLINE_MARKERS` 里删掉」这个直觉改法是无效的**。

要你做的三件事：
1. 把单例判定从「插件名子串」改成「**本插件自己的运行时目录**」（`RUNTIME_DIR = path.join(DATA_DIR,'desktop-runtime')`，你的 `lib/overlay.mjs:15` 已经定义好了）；
2. 补一条回归测试（给过滤逻辑喂两条构造命令行，断言只选中自己那条）；
3. 按 §6 验收。

---

## 1. 现象

用户视角：装了 WB 版之后，ZCode 版的挂件"消失"，桌面只剩 WB 版的角色。

实测状态（本报告生成时）：

| 项 | ZCode 版 | WorkBuddy 版 |
|---|---|---|
| 服务进程 | **活着**（pid 28232，端口 **39322**） | 活着（pid 32448，端口 39321） |
| 浮层进程 | **不存在** | 活着（pid 10316） |
| `overlay.json` | 记着已死的 pid 18268（陈旧记录） | pid 10316 |

也就是说：ZCode 版的服务、`/whale/*` 接口、MCP 工具、钩子全部正常，**只有承载角色的浮层窗口被杀了**。而且因为 `overlay.json` 还指着死 pid，`window status` 之类会给出误导性结论。

> 端口说明：两侧默认端口都是 39321，WB 先占，ZCode 的服务按既有逻辑顺延到 39322（这本身无害，各自的浮层由 `WHALE_PORT` 指向各自的服务）。

---

## 2. 根因

### 2.1 判定表用了子串

`lib/host.mjs:104-111`：

```js
export const HOST_PROCESS_NAME = 'WorkBuddy'
export const OVERLAY_WINDOW_TITLE = 'WorkBuddy狐娘小挂件'

// 浮层单例判定要匹配的命令行特征。**必须同时含旧名**：用户可能 ZCode 版与
// WorkBuddy 版同装，两条产品线的浮层进程若互不识别就会「双角色同屏」（ZCode 侧
// 修过一次同类问题）。
export const OVERLAY_CMDLINE_MARKERS = ['fox-widget', 'zcode-fox-widget']
```

`listOverlayPids()`（`lib/overlay.mjs:148-178`）把它拼成 PowerShell 的 `-like '*标记*'` 过滤 `electron.exe`。**关键点**：

```
'zcode-fox-widget'.includes('fox-widget') === true
```

所以 `'fox-widget'` 这一个标记就足够匹配到 ZCode 版的浮层。实测两条命令行：

```
ZCode 版：C:\Users\<用户>\.zcode\whale\desktop-runtime\node_modules\electron\dist\electron.exe
          C:\Users\<用户>\.zcode\cli\plugins\cache\zcode-fox-local\zcode-fox-widget\1.0.0\desktop
WB 版  ：C:\Users\<用户>\.workbuddy\plugins\data\fox-widget-fox-local\desktop-runtime\node_modules\electron\dist\electron.exe
          C:\Users\<用户>\.workbuddy\plugins\cache\fox-local\fox-widget\2.0.0\desktop
```

第二条虽然只含 `fox-widget`，但两条**都**含 `fox-widget`（第一条含在 `zcode-fox-widget` 里）。**删掉 `'zcode-fox-widget'` 无法解决**。

### 2.2 两条路径都会杀，而且 `startOverlay` 是无条件先跑

`lib/overlay.mjs:275-293`（`startOverlay()` 开头）：

```js
const live = listOverlayPids().filter((pid) => isProcessAlive(pid))
if (live.length) {
  const status = await overlayStatus()
  const keep = status.pid && live.indexOf(status.pid) !== -1 ? status.pid : live[live.length - 1]
  let killed = 0
  for (const pid of live) {
    if (pid === keep) continue
    if (killPidTree(pid)) killed++
  }
  ...
  return { running: true, started: false, pid: keep, ..., deduped: killed }
}
```

因为 WB 侧 `overlay.json` 记的是**自己**的 pid（10316）且它活着，所以 `keep` 永远是自己 → **其余全杀**，其中就包括 ZCode 版的浮层。而且这段在任何「已经在跑」的短路判断**之前**，所以每次 `startOverlay()` 都会执行一次。

`stopOverlay()` 同样：

```js
// lib/overlay.mjs:357-368
const pids = listOverlayPids().filter((pid) => isProcessAlive(pid))
if (info && isProcessAlive(info.pid) && pids.indexOf(info.pid) === -1) pids.push(info.pid)
...
for (const pid of pids) killPidTree(pid)
```

→ WB 侧的 `window stop` / `restart-all` / 更新后的重启，也会把 ZCode 版浮层带走。

而 WB 侧调 `startOverlay()` 的时机很密：会话启动自启（`autostart.mjs`）、看门狗 tick（`watchdog.log` 里 `tick=15000ms`）、`window start`、任何更新后的重启。**结论：只要 WB 版装着并在跑，ZCode 版的浮层活不过 WB 侧的下一次 ensure。**

---

## 3. 证据

### 3.1 时间线（本机，本地时间 UTC+8；日志内是 UTC）

| 时间 | 事件 |
|---|---|
| 20:11:55 | WB 侧浮层启动（pid 10316，`~/.workbuddy/plugins/data/fox-widget-fox-local/overlay.json` 的 `startedAt`） |
| 20:18:48 | ZCode 侧服务启动（pid 28232，顺延到 39322） |
| 20:18:50 | ZCode 侧浮层启动（pid 18268，`~/.zcode/whale/overlay.json`） |
| 20:31:14 | ZCode 侧浮层日志**最后一行**（`hidden zcode-not-foreground`、`minimized=true`） |
| 20:32:15 | WB 侧 autostart 写入 `server=reused overlay=reused` |
| 20:32:21 | WB 侧浮层日志出现真实交互（`interactive -> true` / `click -> showBubble`）——此时桌面上只剩它 |
| 20:39 | 实测 `electron.exe` 进程只剩 WB 版一条 |

`overlay=reused` 这个返回值形状与上面 `startOverlay()` 的去重分支一致（该分支 `return { running:true, started:false }`）——即 **20:32:15 那一刻 WB 侧跑了去重分支**，时间点紧接 ZCode 浮层的日志断点。

### 3.2 为什么**不是**其他原因（都已排除）

| 候选原因 | 排除依据 |
|---|---|
| ZCode 版插件被卸载/删除 | 市场目录、`known_marketplaces.json`、`installed_plugins.json`、安装副本全部完好 |
| 两侧抢同一个 Electron `user-data-dir` → GPUCache 连环崩 | 两侧 app 名不同：`desktop/package.json` 分别是 `zcode-fox-overlay` 与 `fox-widget-overlay`，实测 `%APPDATA%` 下是两个独立目录。你 `desktop/main.cjs:160-172` 注释里那个连环崩溃场景是**同一条产品线的两个副本**，与本次无关 |
| ZCode 侧自己的「宿主窗口消失 30 秒自退」 | 那条路径**一定**会写 `quit-window-missing 30000ms`（历史日志里有 10-13、10-14 多条，自检也钉着），本次日志在 20:31:14 直接断掉、无任何退出行——只有被外部 `taskkill /F` 才会一个字都不留 |
| ZCode 窗口最小化导致主动隐身 | 日志末尾确有 `hidden zcode-not-foreground`，但那是**设计内**的隐身（不是退出），且发生在被杀之前 10 秒 |

### 3.3 反向风险（同一个 bug 的镜像，请一并处理）

ZCode 侧的枚举是 `lib/overlay.mjs:156`：`$_.CommandLine -like '*zcode-fox-widget*'`。

- WB 版从 **cache** 启动时，命令行里是 `...\cache\fox-local\fox-widget\2.0.0\desktop` → 不含 `zcode-fox-widget` → 我们**不会**误杀它（当前状态）。
- 但 WB 版若从 **worktree** 启动（dev / `desktop install` 之外的路径），命令行含 `...\Worktrees\zcode-fox-widget\main-56fc9dd2\desktop` → **含 `zcode-fox-widget`** → ZCode 侧就会把它当重复实例杀掉。

所以这是个**双向的坑**：两边都必须按「自己的运行时目录」认亲，否则谁先启动谁活、另一个被另一边杀，永远不稳定。（ZCode 侧存在同样的问题、需要同样口径的改动；本报告抄送 ZCode 分支由那边处理。）

---

## 4. 为什么「跨产品线互斥」这个目标本身是错的

你注释里的动机是「避免桌面出现两个角色」。这个动机对**同一条产品线的多个安装副本**成立（例如 cache 快照与 worktree 副本同时起，确实是两个角色同屏），但对**跨产品线**不成立：

1. 两个挂件**各跟一个宿主窗口**：ZCode 版的跟随脚本认 `ZCode`，你的认 `WorkBuddy`（两侧日志里的 `fgIsZCode` / `fgIsWorkBuddy` 判定都正常）。用户同时开着两个宿主时，本该各显示一个：一个贴在 ZCode 上、一个贴在 WorkBuddy 上。
2. 两侧的运行时与数据目录天然隔离：`~/.zcode/whale/…` vs `~/.workbuddy/plugins/data/fox-widget-fox-local/…`。
3. 互斥的实际后果不是"只留一个"，而是**"每次 WB 侧动作都杀掉 ZCode 侧的浮层"**——因为 keeper 规则（`overlay.json` 记的 pid 优先）永远选中 WB 自己。ZCode 侧没有任何反制手段：它一启动就会被下一个 WB tick 杀掉，用户看到的是随机消失。

---

## 5. 修复方案

### 5.1 推荐：用「自己的运行时目录」当亲缘判据

`RUNTIME_DIR` 已经存在于 `lib/overlay.mjs:15`：

```js
const RUNTIME_DIR = path.join(DATA_DIR, 'desktop-runtime')
```

它天然满足两个需求：

- **同一条产品线的多个副本**：不论从 cache 快照还是从 worktree 启动，`electron.exe` 永远来自同一个 `RUNTIME_DIR`（`overlaySpawnEnv` / `spawn(ELECTRON_EXE, …)` 里用的是它）→ 依然互相识别、依然去重 ✓（你原注释要防的场景不会回归）；
- **跨产品线**：ZCode 版的 `RUNTIME_DIR` 是 `~/.zcode/whale/desktop-runtime`，绝不相同 → 互不干涉 ✓。

实现（`lib/overlay.mjs` 的 `listOverlayPids()`，win32 分支）：

```js
// 只认「本插件数据目录下的运行时」启动的浮层。
// 为什么不能用插件名子串：'fox-widget' 是 'zcode-fox-widget' 的子串，
// 会把 ZCode 版的浮层当重复实例杀掉（2026-10-14 真机事故）。
const marker = RUNTIME_DIR.replace(/'/g, "''") // PS 单引号转义
const r = spawnSync('powershell', ['-NoProfile', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
  "Where-Object { $_.CommandLine -like '*" + marker + "*' -and $_.CommandLine -notlike '*--type=*' } | " +
  'Select-Object -ExpandProperty ProcessId'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
```

然后把 `OVERLAY_CMDLINE_MARKERS` 从 `host.mjs` 移除（或保留常量并加注释说明**不再用于单例判定**，避免下一个人再踩）。注意 PowerShell 的 `-like` 里 `\` 是普通字符，Windows 路径直接用没问题；但要引号转义。

### 5.2 更保守的替代：先粗筛再排除另一条产品线

若你不想动枚举口径，最小改动版是在粗筛后加一层排除：候选命令行里**含 `\.zcode\` 或 `zcode-fox-local`** 的一律跳过（那是 ZCode 版的运行时/市场路径）。缺点是需要枚举另一条线的特征、以后对方改名就失效；不如 5.1 稳。

### 5.3 已知边界（如实记下，别当成"完全解决"）

- **同插件装在不同 marketplace** 时 `DATA_DIR` 不同（`data/<插件>-<市场>/`），5.1 的口径下它们不再互斥 → 理论上又可能两个角色。要堵这个洞，可在 marker 之外再加一条：命令行含 `<宿主数据根>\plugins\data\` 且插件目录名相同。现实中用户极少这么装，按需处理。
- **POSIX 分支**（`pgrep -f OVERLAY_ENTRY_DIR`）用的是插件根目录，天然按副本区分，不存在跨线问题；但同时它也**不会**在新旧两个副本之间去重——与 Windows 口径不一致，建议一并统一到 `RUNTIME_DIR`。
- ZCode 侧（`lib/overlay.mjs:156` 的 `*zcode-fox-widget*`）存在**同一个**问题，需要同一口径的改动，否则 §3.3 那个反向风险仍在。**两边都改完，才是稳定的"各跟各的宿主、各自一个角色"。**

---

## 6. 验收与回归测试

### 6.1 手工验收（在真机上）

```bash
# 1) 两侧各起一个浮层
node <zcode分支>/lib/cli.mjs window start
node <wb分支>/lib/cli.mjs    window start

# 2) 等过 WB 看门狗的一整拍（tick=15000ms）+ 余量，再等一次会话级 ensure
sleep 40

# 3) 断言：两个 electron 主进程都在（各自 --type= 之外的 main）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" |
  Where-Object { \$_.CommandLine -notlike '*--type=*' } | Select-Object ProcessId,CommandLine | Format-List"
```

**通过标准**：输出里**同时**出现 `<你的 RUNTIME_DIR>…electron.exe …\desktop` 与 `…\.zcode\whale\desktop-runtime\…electron.exe …zcode-fox-widget\1.0.0\desktop`，并且在 60 秒之后仍然两个都在、桌面上同时看到一个贴 ZCode 的角色与一个贴 WorkBuddy 的角色。

**再验一遍反向**：从 worktree 形态起你的浮层，跑 ZCode 侧的 `window start`——ZCode 侧修好后同样不该杀掉你的。

### 6.2 建议补的回归测试

给「候选命令行 → 选中 pid」的过滤逻辑抽一个纯函数（或把构造命令行的部分参数化），用两条**字面量**命令行断言：

```js
const mine  = 'C:\\Users\\u\\.workbuddy\\plugins\\data\\fox-widget-fox-local\\desktop-runtime\\node_modules\\electron\\dist\\electron.exe C:\\Users\\u\\.workbuddy\\plugins\\cache\\fox-local\\fox-widget\\2.0.0\\desktop'
const other = 'C:\\Users\\u\\.zcode\\whale\\desktop-runtime\\node_modules\\electron\\dist\\electron.exe C:\\Users\\u\\.zcode\\cli\\plugins\\cache\\zcode-fox-local\\zcode-fox-widget\\1.0.0\\desktop'
// 期望：只选中 mine
```

这条断言的价值在于：**它就是本次事故的最小复现**（旧实现在 `other` 上也返回 true）。顺带建议加一条「worktree 形态的自己的副本仍被识别为同一条产品线」（命令行走 `Worktrees\...\desktop`、但 `electron.exe` 来自同一个 `RUNTIME_DIR`）。

---

## 7. 明确不要做的事

1. **不要**简单把 `'zcode-fox-widget'` 从 `OVERLAY_CMDLINE_MARKERS` 删掉就收工——`'fox-widget'` 是它的子串，问题依旧（见 §2.1）。这是本次报告最容易被误判成"已修"的地方。
2. **不要**让 ZCode 侧也去杀 WB 的浮层来「对称」——那会变成谁后启动谁赢的拉锯，用户看到的是随机消失，更糟。
3. **不要**靠"谁后启动谁赢"或"按启动时间挑 keeper"——只要判据还是跨产品线的，就会周期性互相杀。
4. **不要**顺手把 `DATA_DIR`/`RUNTIME_DIR` 改成按安装副本区分（那会把「同一条产品线的两个副本」这个**真实**的去重需求一起废掉，回到你注释里要防的"两个角色同屏"）。

---

## 8. 附：现场快照（供你复现对比）

```
# 浮层进程（只剩 WB 版）
PID 10316  C:\Users\<用户>\.workbuddy\plugins\data\fox-widget-fox-local\desktop-runtime\node_modules\electron\dist\electron.exe
           C:\Users\<用户>\.workbuddy\plugins\cache\fox-local\fox-widget\2.0.0\desktop

# 服务
PID 32448  node C:\Users\<用户>\.workbuddy\plugins\cache\fox-local\fox-widget\2.0.0\lib\server.mjs   → 39321
PID 28232  node …\zcode-fox-widget\1.0.0\lib\server.mjs（ZCode 版）                                 → 39322

# 记录文件
~/.workbuddy/plugins/data/fox-widget-fox-local/overlay.json  → { pid: 10316, port: 39321, startedAt: 20:11:55 }
~/.zcode/whale/overlay.json                                  → { pid: 18268, port: 39322, startedAt: 20:18:50 }   ← 已死，陈旧

# ZCode 侧浮层日志尾部（~/.zcode/whale/overlay-debug.log，UTC）
2026-10-14T12:31:14.929Z hidden zcode-not-foreground
2026-10-14T12:31:14.930Z follower-stderr state show=false minimized=true fgPid=7784 fgIsZCode=false pid=7344 pidStart=1791980318168
（之后无任何行）
```

---

## 9. 一句话总结

你的单例去重想防的是「同一条产品线的两个副本同屏」，但判据用了插件名子串，而 `fox-widget` ⊂ `zcode-fox-widget`，于是变成了**跨产品线互杀**：ZCode 版浮层活不过 WB 侧的下一次 `startOverlay()`。改成按各自 `RUNTIME_DIR` 认亲即可同时满足两个目标；两边都要改。
