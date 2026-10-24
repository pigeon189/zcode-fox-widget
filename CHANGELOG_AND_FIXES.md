# 反重力哈基米记账桌宠 (Gemini Hakimi Widget) — 问题排查与架构更新文档 (v2.2)

> **更新时间**：2026-10-21  
> **适用目录**：
> - 项目源码目录：`e:\Antigravity\Gemini-Hakimi-Widget`
> - Antigravity 插件运行目录：`C:\Users\atri\.gemini\config\plugins\gemini-hakimi-widget`

---

## 一、 核心问题排查与根因定位 (Root Cause Analysis)

在本次深度排查中，针对**“桌面悬浮桌宠打不开/看不见”**、**“点一下桌宠乱飞”**、**“模型列表存在虚构模型”**以及**“5h/周限额百分比与反重力官方不一致”**四大核心问题，定位到了具体的底层系统级根因：

### 1. 为什么之前桌面悬浮桌宠“启动了却看不见”？（四大叠加根因）
1. **根因 A — Windows 沙盒虚拟桌面隔离 (`WinSta0\exebox-...` vs `WinSta0\Default`)**：
   - Antigravity 的 Agent 命令行工具（以及部分后台子进程）运行在沙盒隔离的隐藏 Win32 桌面 `WinSta0\exebox-*` 中，而用户真实肉眼可见的交互式桌面是 `WinSta0\Default`。
   - 如果直接通过普通 `subprocess.Popen` 或命令行启动 WPF 桌宠而不显式指定 `STARTUPINFOW.lpDesktop = "WinSta0\\Default"`，窗口会被创建在隐藏的 `exebox` 桌面上，导致进程虽然存活但屏幕上完全看不见。
2. **根因 B — 宿主窗口最小化时产生 `-32000` 屏幕外坐标污染 (`corner_offset_x: 33930`)**：
   - 当 Antigravity 主窗口最小化时，Windows API `GetWindowRect` 会返回 `(-32000, -32000)`。
   - 旧版 `RecordAnchorFromCurrentPhysicalRect()` 未过滤最小化状态（`IsIconic`）与异常负坐标，导致计算出 `wRect.Left - r.Right = +33930` 并写入 `config/config.json`。此后每次启动都会把桌宠瞬間移动到 `(35850, 34005)`（屏幕右下角三万像素之外）。
3. **根因 C — 旧版 Sidecar 僵尸进程占用端口并缺少 `-STA` 参数**：
   - 旧版 `server.py` 守护进程长期占用了 WebView 缓存端口 `54716`，且其内部调用 `powershell.exe` 启动 `HakimiWidget.ps1` 时遗漏了 WPF 必需的 `-STA`（单线程单元）参数，同时在 `config.json` 中残留了 `"speech_bubble_enabled": false`。
4. **根因 D — 瞬态命令 Job Object 生命周期回收**：
   - 在一次性命令或短生命周期 Hook 中直接启动的子进程，会在命令退出、Job Object 关闭时被操作系统连带终止。

### 2. 为什么限额百分比之前与反重力官方显示不一致？
1. **根因 A — 之前依赖本地 `transcript.jsonl` 估算而非反重力官方 RPC 状态**：
   - 本地 `transcript.jsonl` 只记录了当前机器已落盘的对话 step token，无法获知云端真实的滚动配额池剩余比例（`remainingFraction`）与精确重置时间（`resetTime`）。
2. **根因 B — Protobuf3 JSON 零值省略导致 `0%` 额度被误判为 `100%`**：
   - 当某个模型（如 `Claude Opus 5.5` 或 `Claude Sonnet 5.5`）剩余额度耗尽为 `0%` 时，Protobuf3 JSON 序列化会省略默认零值字段 `remainingFraction: 0`，仅返回 `quotaInfo: { "resetTime": "..." }`。若代码在字段缺失时默认回退到 `1.0`，就会把已耗尽（`0%`）的模型错误显示为 `100%`。
3. **根因 C — 内部模型占位符 (`MODEL_PLACEHOLDER_M*`) 映射偏差**：
   - 通过逆向查询 `language_server.exe` 的 `GetUserStatus` 接口，确认了反重力真实的内部模型占位符映射关系：
     - `Gemini 4 Argon` (`gemini-4-argon`)：`MODEL_PLACEHOLDER_M417` (High) / `M418` (Medium) / `M419` (Low)
     - `Gemini 3.8 Flash` (`gemini-3.8-flash`)：`MODEL_PLACEHOLDER_M318` (High) / `M319` (Medium) / `M320` (Low)
     - `Claude Opus 5.5` (`claude-opus-5-5`)：`MODEL_PLACEHOLDER_M400` (Low) / `M401` (Medium) / `M402` (High) / `M26`
     - `Claude Sonnet 5.5` (`claude-sonnet-5-5`)：`MODEL_PLACEHOLDER_M403` (Low) / `M404` (Medium) / `M405` (High)（此前误将 `M405` 归入 Gemini 4 Argon）

---

## 二、 核心修复与架构升级清单 (Changelog)

### 1. 接入反重力官方 `language_server.exe` ConnectRPC 实时配额引擎
- **涉及文件**：
  - [`src/AntigravityMonitor.ps1`](file:///e:/Antigravity/Gemini-Hakimi-Widget/src/AntigravityMonitor.ps1)
  - [`sidecars/hakimi_panel/server.py`](file:///e:/Antigravity/Gemini-Hakimi-Widget/sidecars/hakimi_panel/server.py)
- **实现机制**：
  - 自动发现本地运行的 `language_server.exe` 进程命令行中的 `--csrf_token` 与监听端口，并将可用端点缓存至 `config/ls_bridge.json`（避免重复进程扫描开销）。
  - 通过 `POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/GetUserStatus`（携带 `Connect-Protocol-Version: 1` 与 `x-codeium-csrf-token`）实时拉取 `userStatus.cascadeModelConfigData.clientModelConfigs`。
  - 精确解析每个模型的 `quotaInfo.remainingFraction` 与 `quotaInfo.resetTime`：
    - 当存在 `resetTime` 但省略 `remainingFraction` 时，严格判定为 **`0%` 剩余额度**。
    - 根据 `resetTime` 距离当前时间的跨度（`> 24h` 为 7 天周限额窗口，`<= 24h` 为 5 小时滚动限额窗口）自动归类并格式化本地重置时间（如 `重置 10-28 20:26`、`重置 03:29`）。

### 2. 跨桌面突围启动 (`WinSta0\Default`) 与坐标防飞保护
- **涉及文件**：
  - [`sidecars/hakimi_panel/server.py`](file:///e:/Antigravity/Gemini-Hakimi-Widget/sidecars/hakimi_panel/server.py)
  - [`src/HakimiWidget.ps1`](file:///e:/Antigravity/Gemini-Hakimi-Widget/src/HakimiWidget.ps1)
- **实现机制**：
  - 在 `server.py` 的 `start_desktop_pet()` 中使用 `ctypes.windll.kernel32.CreateProcessW` 并显式指定 `STARTUPINFOW.lpDesktop = "WinSta0\\Default"`，确保无论 Sidecar 守护进程运行在何种沙盒桌面下，WPF 桌宠永远直接呈现在用户的真实主桌面上。
  - 在 `HakimiWidget.ps1` 顶部加入 **STA 线程模式自检与自动重拉起**逻辑，杜绝因缺少 `-STA` 导致的 WPF 静默崩溃。
  - 在 `HakimiHostFollower.TryGetBounds()` 中过滤 `IsIconic(hwnd)` 与 `< -10000` 的最小化坐标，并在配置加载与锚点记录时对 `corner_offset_x/y` 强制施加 `[-1200, 600]` 边界钳制（Clamp），彻底根除最小化后桌宠飞出屏幕的问题。
  - 拖拽、贴边吸附与四象限翻转全程使用 **100% 物理像素 (`GetWindowRect` + `SetWindowPos`)**，气泡显隐采用 `Opacity + IsHitTestVisible` 零重排切换，彻底消除点击瞬间因 WPF DIP 与物理像素混用导致的乱跳。

### 3. 严格锁定反重力四大真实可用模型
- **涉及文件**：
  - [`src/Pricing.json`](file:///e:/Antigravity/Gemini-Hakimi-Widget/src/Pricing.json)
  - [`src/AntigravityMonitor.ps1`](file:///e:/Antigravity/Gemini-Hakimi-Widget/src/AntigravityMonitor.ps1)
  - [`sidecars/hakimi_panel/server.py`](file:///e:/Antigravity/Gemini-Hakimi-Widget/sidecars/hakimi_panel/server.py)
  - [`sidecars/hakimi_panel/ui.html`](file:///e:/Antigravity/Gemini-Hakimi-Widget/sidecars/hakimi_panel/ui.html)
- **模型清单**：
  1. **Gemini 4 Argon** (`gemini-4-argon`)
  2. **Gemini 3.8 Flash** (`gemini-3.8-flash`)
  3. **Claude Opus 5.5** (`claude-opus-5-5`)
  4. **Claude Sonnet 5.5** (`claude-sonnet-5-5`)
- 彻底移除了所有非反重力环境的虚构/旧版模型条目。

### 4. 交互手势分级、气泡美化与音效独立开关
- **涉及文件**：
  - [`src/WidgetWindow.xaml`](file:///e:/Antigravity/Gemini-Hakimi-Widget/src/WidgetWindow.xaml)
  - [`src/HakimiWidget.ps1`](file:///e:/Antigravity/Gemini-Hakimi-Widget/src/HakimiWidget.ps1)
  - [`sidecars/hakimi_panel/ui.html`](file:///e:/Antigravity/Gemini-Hakimi-Widget/sidecars/hakimi_panel/ui.html)
- **手势与音效优化**：
  - **单击桌宠**：触发大肥鱼原版摸头音效（`press.wav` + `release.wav`）+ 脸红 Q 弹形变 + 随机台词。
  - **单击两次桌宠（270ms ~ 950ms）或点击气泡右上角 `×` / 底部 `💬`**：独立开关头顶基础气泡。
  - **快速双击桌宠（`<= 270ms`）或点击底部 `📊` / 气泡底栏 `详情 ↗`**：展开或收起四象限自适应详情面板。
  - **缓存命中提示音独立开关 (`cache_sound_enabled`)**：默认静音免打扰，可在详情面板、右键菜单及内置 WebUI 面板中随时单独开启或关闭。


### 5. 摸头动画全面流畅化与切模型容错加固 (v2.3)
- **卡顿根因**：
  - 旧版摸头交互仅在 `MouseDown` 时瞬时写入 `ScaleX=1.06, ScaleY=0.88`，`MouseUp` 时写入 `0.96, 1.04`，随后依赖 450ms 定时器瞬间跳回 `1.0, 1.0`。全过程仅有 3 次无补间的离散阶跃（0fps 抽帧定格），导致视觉感知严重卡顿、僵硬。
- **流畅重构**：
  - 在 [`src/HakimiWidget.ps1`](file:///e:/Antigravity/Gemini-Hakimi-Widget/src/HakimiWidget.ps1) 中重构为 **WPF 原生硬件加速 60FPS Q弹物理果冻回弹引擎**（基于 `DoubleAnimationUsingKeyFrames` + `CubicEase` / `SineEase` 样条插值）：
    - **按下 (MouseDown, 95ms)**：平滑下压形变（`ScaleX: 1.0 -> 1.14`, `ScaleY: 1.0 -> 0.84`），头顶爱心气泡轻盈上浮。
    - **松开 (MouseUp, 480ms)**：4 关键帧连续弹性多级回弹（拉伸过冲 `0.91, 1.13` -> 二级压缩 `1.055, 0.955` -> 微阻尼收敛 `0.986, 1.014` -> 完美静止 `1.0, 1.0`），全程由 WPF GPU 合成器渲染，丝滑无停顿。
  - **切模型防炸加固**：
    - 加固 [`sidecars/hakimi_panel/server.py`](file:///e:/Antigravity/Gemini-Hakimi-Widget/sidecars/hakimi_panel/server.py) 中的模型索引与默认定价表，当用户切换至 `Gemini 3.8 Flash` 等任意模型时，提供完整的默认回退兜底，杜绝 `KeyError`。

### 6. 伴随 Antigravity 宿主窗口最小化隐藏与关闭联动 (v2.4)
- **核心功能**：
  - **伴随最小化隐藏**：当 Antigravity 主窗口最小化或按下 Win+D 显示桌面时，桌宠主窗口与详情面板自动无感隐藏（`Visibility = Collapsed`），不遮挡桌面。
  - **伴随还原无缝复位**：当用户从任务栏还原或点击 Antigravity 窗口时，桌宠立即同步重现，并通过 0ms `SyncNow()` 精确复位到 Antigravity 吸附角，无缝贴合。
  - **伴随关闭自动退出**：当 Antigravity 窗口关闭或主进程退出后，桌宠自动识别宿主销毁事件，在短暂确认后优雅退出并清理所有钩子与 PID 锁文件。
  - **全端开关与托盘增强**：
    - 桌宠右键菜单：`🙈 伴随 Antigravity 最小化隐藏与关闭联动`
    - 内置侧边栏 WebUI：`🙈 伴随最小化隐藏与退出` 复选框
    - 系统托盘图标支持右键呼出菜单与左键唤醒隐藏状态下的桌宠。

### 7. 轮次完成提示音彻底独立静音与关闭再开自启闭环 (v2.5)
- **轮次提示音独立开关修复**：
  - 排查发现 `sidecars/hakimi_panel/ui.html` 在每轮对话结束（`lastSeenStepIndex` 增长）时无条件执行了 `playSound('chime')`，且在 `playSound` 过滤条件中仅检查了 `['task', 'cost']` 而遗漏了 `chime`。导致用户在保留“摸头音效”而关闭“轮次提示音”时，每轮仍会收到响铃打扰。
  - 修复后：在 `ui.html` 与 [`src/HakimiWidget.ps1`](file:///e:/Antigravity/Gemini-Hakimi-Widget/src/HakimiWidget.ps1) 中将所有自动提示音（`chime`, `task`, `cost`, `coin`）完全受控于 `cache_sound_enabled`，摸头音效仅响应用户主动 Rua 头的 `press`/`release`。
- **关闭再开自启闭环 (Companion Auto-Revive)**：
  - **伴随退出更迅速**：在 `HakimiWidget.ps1` 中将宿主关闭判定容错时间缩短至 750ms / 300ms，宿主窗口关闭后桌宠快速随同退出。
  - **伴随再开自动拉起**：在 [`sidecars/hakimi_panel/server.py`](file:///e:/Antigravity/Gemini-Hakimi-Widget/sidecars/hakimi_panel/server.py) 中新增后台宿主伴随守护线程 `_companion_watcher_loop`，当用户重新打开 Antigravity 时，守护线程检测到 Antigravity 窗口打开且桌宠未在运行时，自动跨桌面在 `WinSta0\Default` 重新拉起桌宠，彻底形成“打开自启 -> 最小化隐形 -> 还原复位 -> 关闭退出 -> 再开重连”的全生命周期伴随闭环！


### 8. 伴随生命周期与 Win32 状态机隔离升级 (v2.6)
- **最小化与关闭状态混淆根治**：
  - 排查发现 Win32 中最小化（`IsIconic(hwnd)`）仍保持窗口可见性，而 Electron 窗口关闭时会先执行 `ShowWindow(SW_HIDE)`（使 `IsWindowVisible == 0` 但 `IsIconic == 0`）。旧版代码将非可见窗口误判为最小化，导致窗口关闭时桌宠误陷入“睡眠折叠”等待还原状态。
  - 重构后严格区分状态机：`IsHostMinimized()` 仅在 `IsIconic` 时判定；`IsHostWindowAlive()` 必须满足 `IsWindowVisible || IsIconic`。宿主关闭后 500ms 内确定性退出。
  - 窗口标题模糊匹配增强：通过 `IndexOf("Antigrav", ...)` 兼容带前缀或被截断的窗口标题（如 `Antigrav...`）。
  - 用户手动退出标志（`USER_MANUALLY_STOPPED`）：区分用户在 UI 上的主动关闭操作，避免误自动重新唤醒，直到下一次 Antigravity 会话重启。

### 9. 台词哈基米更名为 Gemini、专属定制台词与摸头台词池修复 (v2.7)
- **台词库全量更新**：
  - 在 [`assets/quotes.json`](file:///e:/Antigravity/Gemini-Hakimi-Widget/assets/quotes.json) 中将所有“哈基米”全部统一更名为“Gemini”。
  - 新增定制专属台词：
    - `"本猫有权对任何人哈气 哈！"`
    - `"我将用最深邃的话告诉你极其极其极其极其极其极其"`
  - 将定制台词同步纳入闲置（`idle`）与摸头互动（`pet`）台词库。
- **摸头随机台词池修复**：
  - 排查发现 [`src/HakimiWidget.ps1`](file:///e:/Antigravity/Gemini-Hakimi-Widget/src/HakimiWidget.ps1) 中原本引用了 `$Quotes.headpat`（而 JSON 中键名为 `pet`），导致摸头时台词池为空。
  - 修复后将 `$Quotes.pet` 与 `$Quotes.idle` 联合并集构建随机池，每次摸头点击均能 100% 随机触发台词气泡展示（持续 4 秒）。
  - 同步更新内置 WebUI 面板（[`sidecars/hakimi_panel/ui.html`](file:///e:/Antigravity/Gemini-Hakimi-Widget/sidecars/hakimi_panel/ui.html)）摸头点击台词池。
