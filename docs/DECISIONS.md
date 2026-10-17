# 决策日志（按主题）

> 本文件回答「为什么这么写」。CHANGELOG 只记「改了什么」，这里记结论、依据与**别踩的坑**。
> 每节格式固定：**结论 → 依据 → 别踩**。引用代码位置是写作时的快照，函数名比行号可靠。
> 新增一节时，在 [`INDEX.md`](./INDEX.md) 不必登记（它是长期文档，不随版本变化）。

---

## host-contract · 宿主契约：清单 / 钩子 / 路径变量 {#host-contract}

**结论**：WorkBuddy 的五处接入点与 ZCode 完全不同，且都集中写在 `lib/host.mjs`，其它模块只
从这里取常量。

| 项 | ZCode | WorkBuddy |
| --- | --- | --- |
| 清单 | `.zcode-plugin/plugin.json` | `.codebuddy-plugin/plugin.json` + `marketplace.json`（`source: "./"`） |
| MCP | 清单内联 | `.mcp.json` |
| 钩子 | `type:"process"` + `args` + `timeoutMs`（毫秒） | `type:"command"` + bash 字符串 + `timeout`（**秒**） |
| 路径变量 | `${ZCODE_PLUGIN_ROOT}` | `${CODEBUDDY_PLUGIN_ROOT}` / `${CODEBUDDY_PLUGIN_DATA}` |
| 插件名 | `zcode-fox-widget` | `fox-widget`（MCP 工具全名随之变 `mcp__plugin_fox-widget_whale__*`） |

**依据**：`docs/porting/phase-0.md`（宿主实现层验证 `source: "./"` 合法）、`docs/porting/phase-1.md`。
钩子事件表：SessionStart / UserPromptSubmit / Notification；WorkBuddy **没有** `PermissionRequest`。

**别踩**：
- `/whale/health` 的 `app` 标识在 `server.mjs` 写、`service.mjs` 校验，两处必须同源（现由
  `host.mjs` 的 `HOST_APP_ID` 提供）。不一致 → 永远找不到在跑的服务 → 每次新起一个、端口顺延。
- 钩子 `timeout` 单位是秒，不是毫秒；写成 15000 会等两小时。
- 不挂 `PostToolUse`：它每次工具调用都触发，内联执行会拖慢每次调用。

## overlay-window · 浮层窗口形态（不 setBounds / setOpacity 隐身 / focusable:false） {#overlay-window}

**结论**：浮层窗口创建即铺满工作区，之后**只移动不改尺寸**；隐身用 `setOpacity(0)`；全平台
`focusable:false`（需要键盘时由页面通过 `whale:keyboard-focus` 临时打开）。

**依据**（真机实测）：
- 对透明窗口 `setBounds` 改尺寸会让合成层错位——鲸鱼被画到窗口外。
- `hide()/show()` 会卡死原生输入管线；透明度归零只是不画，窗口仍在、输入路径不断。
- 可激活浮层被点一下会把前台从宿主抢走；Windows 上宿主失去前台后停止出帧，表现为
  「和挂件互动后宿主像卡住，再点一下才恢复」。

**别踩**：
- 别给浮层设 owner 窗口（宿主最小化时浮层会跟着一起没了）。
- 别给 `resizable:false`：Electron 会把 min/max 锁成创建时尺寸，后续 `setBounds` 被拒绝，
  页面视口不再跟随。
- 每个实例用**独立 Electron profile**（`overlayProfileDir(port)`）：共用 `%APPDATA%\<productName>`
  时第二个实例会抢 GPUCache 文件锁，两边 GPU 进程连环崩、正在用的渲染进程被打死。

## host-freeze · `type:'toolbar'` 与宿主停帧 {#host-freeze}

**结论**：Windows 上窗口必须带 `WS_EX_TOOLWINDOW`（`new BrowserWindow({ type: 'toolbar' })`），
创建即设、全程保留。**不要删这个参数。**

**依据**：点击角色时页面 `setIgnoreMouseEvents(false)`，Electron 会摘掉
`WS_EX_TRANSPARENT|WS_EX_LAYERED`；一个铺满工作区、置顶、无 TOOLWINDOW 位的窗口于是被宿主
Chromium 的遮挡判定（`IsWindowVisibleAndFullyOpaque`）计为「完全不透明遮挡源」，宿主判定自己
被完全遮挡后停止出帧。真机 A/B：无该位时点击后 113 帧只有 8 帧不同（冻结约 8.5s）；有该位时
113/113 帧全变。样式变化不会触发遮挡重算，所以交还鼠标后也不会自动恢复——点一下宿主才恢复。

**别踩**：
- Electron 44 的 `skipTaskbar:true` 走 ITaskbarList，**不落**这个样式位。
- `setFocusable(true)` 会重写扩展样式、可能冲掉 TOOLWINDOW：键盘焦点分支里通过跟随脚本的
  `toolwindow` 命令补写回来（`desktop/main.cjs` + `follow-window.ps1`）。
- 检测冻结必须**完全被动**：摆动鼠标的悬停重绘会掩盖冻结，产生假阴性。

## cross-line-singleton · 跨产品线浮层互杀 {#cross-line-singleton}

**结论**：浮层单例判定用「命令行是否包含**本插件运行时的 electron dist 目录**」
（`isOwnOverlayCommandLine`），不用插件名子串。

**依据**：2026-10-14 事故——旧判据按 `zcode-fox-widget` 子串匹配，命中了 WorkBuddy 工作树
路径（`...\Worktrees\zcode-fox-widget\...`），导致一端启停会杀掉另一端的浮层。两端的运行时
目录（`~/.zcode/whale/desktop-runtime/...` vs `<插件数据目录>/desktop-runtime/...`）绝不相交，
用它做亲缘判据既保留「同线多副本去重」，又天然跨线互不干涉。

**别踩**：`pid 存活` 不等于「是我们的浮层」——pid 复用会把无关进程判成浮层，`stop` 随之
误杀。现用「命令行亲缘（全量枚举）→ 失败时退化为进程名像 electron」，并带 10s 结论缓存
（枚举在 Windows 上是同步 PowerShell 查询，不适合每次判活都做）。

## coordinate-systems · 页面坐标与视口坐标 {#coordinate-systems}

**结论**：页面内 `getBoundingClientRect()` 给的是**页面坐标**，状态（`state.left/top`）与吸附
判定一律用**视口坐标**：两者相差 `externalViewport.x/y`（浮层铺满工作区时非零）。所有位置
换算集中在 `snapCheck` / `place` 一处，别在业务代码里各自加减。

**依据**：真机「吸附后位置偏一个窗口偏移」「换显示器后贴边错位」都源于混用两套坐标。

**别踩**：`position:fixed` 的菜单/面板参照视口，**不是**参照 root；`positionMenu` 用
`getBoundingClientRect` 后不能再扣 `externalViewport`。

## follow-script-ascii · 跟随脚本必须是纯 ASCII {#follow-script-ascii}

**结论**：`desktop/follow-window.ps1` 保持纯 ASCII（注释也必须是英文）。

**依据**：Windows PowerShell 5.1 按 ANSI 代码页读无 BOM 的 `.ps1`；中文注释会被解成乱码并
破坏语法，脚本秒退 → 浮层不跟随、随后被判定「宿主退出」而退出。

**别踩**：`Add-Type` 编译的 C# 片段同样受编码影响；不要在该文件里用 emoji 或全角标点。

## runtime-sentinels · 运行时「装了一半」判定 {#runtime-sentinels}

**结论**：`isRuntimeInstalled()` 不只看可执行体，还要 ICU 数据与 v8 快照（macOS 用 .app 内
`Contents/Frameworks` 目录）。缺任一即视为未安装，`desktop install` 走修复路径。

**依据**：2026-10-15 真机——`npm install` 被中断后 `electron.exe` 在、`icudtl.dat` 缺失，
浮层每次启动都死在 `Invalid file descriptor to ICU data received`，桌面永远无挂件。

**别踩**：Electron 二进制路径按平台不同（macOS 在 `Electron.app/Contents/MacOS/Electron`），
别用 `dist/electron` 一把梭。

## credit-accounting · 积分口径与 splitInputTokens {#credit-accounting}

**结论**：主显示用宿主算好的 `credit_json`；「今日积分」按 transcript 聚合（`credit_json` 是
按请求覆盖的，只能当最后一轮权威值）。等价金额只作参考，按公开价目折算并标 `≈`。

**依据**：宿主逐次模型调用就预落账，一轮常有多次调用；新轮一出现就弹「上一轮」会弹成刚开跑
的那轮（用户实测）。所以只在**轮次推进**时弹上一轮。

**别踩**：`splitInputTokens()` 必须减掉缓存命中——DeepSeek / GLM / WorkBuddy 的
`prompt_tokens` 都含缓存命中，不减会让金额虚高十几倍。

## update-probe · 更新探测取最高版本 {#update-probe}

**结论**：镜像链的多个候选里取**最高版本**，不取第一个成功响应；并核对目标 tag 是否真的
存在（版本号已提交但 tag 未推时不要报「有更新」）。

**依据**：镜像 CDN 会缓存上一版；只看第一个成功响应会漏报新版本（v1.11.1 修复）。
发布物完整性另外由签名清单保证（`verifyReleaseFiles`），镜像只影响「能不能下到」。

**别踩**：清单外的文件在运行时忽略（不写盘）、在发布自检里报错；别把两者混成一个开关。

## relay-quota · 中转站额度卡的三种形态 {#relay-quota}

**结论**：按量站 → 余额卡；只有一个月度/5 小时窗口 → 显示剩余百分比；Sub2API 这类三维度
（5 小时 / 本日 / 本周）→ 额度卡。凭据优先复用宿主已配置的 Key；需要系统访问令牌的
（New API 账户级查询）由配置里的 `relayAuth` 提供。

**依据**：各站返回结构不同，强行统一成「余额」会把「剩余 42%」误读成「42 元」。

**别踩**：额度卡的百分比是**剩余**，进度条按已用画；两者换算集中在 `quotaCardOf`。

## usage-rank · 用量记录「按当天 / 按 7 天」 {#usage-rank}

**结论**：模型排名的两个维度互相独立——时间范围（当天 / 7 天）与口径（积分 / Token）。
聚合在服务端完成，前端只切视图。

**依据**：7 天榜要按模型跨天聚合，前端逐日相加会与「近 7 天」总计对不上。

**别踩**：面板 tokens 列统一千分位（`formatTokensExact`），气泡里才用「万/亿」
（`formatTokens`）——同列混量纲会让扫读成本陡增（UI 审查 P1-4）。

## role-ink · 角色配色与 4.5:1 派生 {#role-ink}

**结论**：浅色档「整套 chrome 跟随角色色」，深色档保持中性。正文色取
`ensureContrast(ink, bg, 4.5)` 的派生值，装饰件（描边 / 填充 / 焦点环）用角色原色。勾选对勾
默认白，只有填充亮度 > 0.7 时改用黑。

**依据**：kimi 娘原色对白底只有 2.85:1；直接拿原色当正文不可读。深色染角色色会打乱
「深色 = 中性」的语义。

**别踩**：深色档 `applyBubbleInk` 会 `removeProperty('--zcw-check-mark')`，自绘复选框的白勾
必须由深色 token 兜底，否则勾选态没有对勾（UI 审查 P0-2）。

## render-throttle · 渲染节流三重防线 {#render-throttle}

**结论**：浮层被 Chromium 判定「不可见」时会停掉 rAF/过渡，面板会「开了但停在透明态」。
三道防线：① `verifyFramesFlowing()` 在开面板前验证帧是否在走，不走就给 root 挂
`zcwv-anim-off`（关掉过渡，样式计算不受节流影响）；② 页面心跳（`page-beat`）连续失败即
`webContents.reload()`；③ 主进程的跟随/主题观测独立于渲染进程，页面死了也能自救。

**依据**：2026-10 真机多次出现「页面活着、画面停在旧帧」，日志见 `overlay-debug.log`。

**别踩**：别用「全局 `animation:none !important`」代替 `zcwv-anim-off`——那会连功能性状态
变化一起停掉；减少动态效果用媒体查询精确点名（见 `widget.js` 的 `@media` 段）。

## role-fade · 换角色淡入 {#role-fade}

**结论**：换角色时 `src` 立刻换（不推迟响应），只让新图从低透明度浮入；`prefers-reduced-motion`
下不播放。

**依据**：延迟切图会让点击显得迟钝；纯 crossfade 需要两张图同时在场，成本更高。

**别踩**：动画挂在 `img` 的 `transition` 上，别给容器加 `transform` 过渡——会与吸附位移打架。

## runtime-layout · 面板尺寸与缩放 {#runtime-layout}

**结论**：`--zcw-scale` 只缩放角色本体与气泡，菜单/面板尺寸恒定（字号 12px 保可读性）。
面板用 `box-sizing:border-box`，声明宽度即实际宽度。

**依据**：0.6 档菜单是鲸鱼宽的 2.5 倍、2.5 档被钳到视口顶并压住脸——两端都失衡，但阅读性
优先。content-box 下声明 320 实际渲染 346，后续按 320 设计布局会持续被骗（UI 审查 P2-7）。

**别踩**：改面板宽度时同步检查 `positionPanel` / `positionBookPanel`（它们用 `offsetWidth`
反推位置），只改 CSS 不改逻辑会导致贴边偏移。
