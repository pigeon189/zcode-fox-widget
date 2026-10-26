# fox-dock 决策记录

> 一条决策一个条目：背景 → 选择 → 代价。后续推翻要新增条目，不直接改旧条目。

## D001 独立分支 + 独立 worktree

- 背景：新产品的代码、依赖、发布节奏都与现有挂件不同，但共享同一仓库历史。
- 选择：长分支 `feat/dock`，工作区 `E:\WorkSpace\fox-dock`（第三个 worktree）；现有 `main` / `workbuddy` 不动。
- 代价：三条线并存，cherry-pick 时要小心（已踩过「同名函数不存在」的坑）；1.0 前不合并。

## D002 1.0 之前全部 pre-release

- 背景：早期接口、数据格式、适配器契约都会变。
- 选择：tag `dock-v<version>`，`gh release create --prerelease`；1.0.0 才发正式版。
- 代价：用户装到的是预发布；更新器默认只跟随 `dock-v*` 通道。

## D003 核心零依赖

- 背景：常驻进程要小、启动快、审计简单；现有挂件也是零依赖。
- 选择：`daemon/` 与 `shared/` 只用 Node 标准库；UI 层（overlay）按需引入，且锁定版本。
- 代价：路由、日志、测试框架都要手写一点；换来的是没有供应链风险。

## D004 绑定身份键 = exe|pid|startMs|hwnd

- 背景：验证 3 实测同一进程两个窗口标题完全相同；重启后 pid 可能复用。
- 选择：四段键。hwnd 消失但进程在时，用 `exe|pid|startMs` 兜底重绑。
- 代价：进程重建窗口（同一进程换 hwnd）会触发一次重绑提示。

## D005 数据与端口独立

- 背景：不能污染宿主的配置/数据库，也不能和现有挂件抢端口。
- 选择：数据目录 `%LOCALAPPDATA%\fox-dock`，端口 39401 起，只监听 127.0.0.1。
- 代价：用户多一个目录要清理；卸载脚本必须删干净。

## D006 适配器内置，不做第三方 JS 插件

- 背景：任意 JS 插件会带来沙箱、签名、杀软误报三重成本。
- 选择：适配器随包发布；第三方接入走声明式配置（进程名/库路径/价目），由内置 generic 适配器解释。
- 代价：新厂商要等我们发版；换来的是可控的攻击面。

## D007 ZCode 价目内核逐字节复制 + 漂移检查

- 背景：dock 需要与挂件线算出**同一个金额**，但两者必须能各自独立运行（将来可能分仓）。
- 选择：把 `lib/pricing.mjs` 原样复制到 `dock/adapters/zcode/pricing.mjs`，不改一个字节；
  `tools/check-pricing-sync.mjs` 在能找到源文件时做字节比较，漂移即失败（`--fix` 同步）。
- 代价：价目改动要同步两处（脚本会拦住）；换来的是 dock 可脱离挂件线独立运行。

## D008 GLM 订阅修正没有移植（已知偏差）

- 背景：挂件线会用账号的 GLM Coding Plan 套餐事实，把 GLM 用量从「按量价」改成「配额口径」。
  这需要访问 GLM API 与凭据，属于宿主侧能力。
- 选择：dock 只做「provider 名含 coding-plan/start-plan → 预付，金额记 0」这一层；
  识别不出订阅时，GLM 用量按按量价显示。
- 代价：GLM 订阅用户会看到偏高的等价金额。这是**明确记录**的偏差，不假装精确。
  后续若要做，应把「账号套餐事实」做成适配器可选输入，而不是在 dock 里再存一份凭据。

## D009 WorkBuddy 按「轮的首个事件」归日

- 背景：一轮 agent 循环会横跨午夜；按事件时间归日会把同一轮劈成两半。
  实测跨 0 点的那一轮让两天各差 0.82 积分，与挂件线对不上。
- 选择：先按 `conversationRequestId` 归并成轮（credit 求和、ts 取最早事件），再按轮的 ts 归日。
- 代价：午夜前后正在跑的轮要等结束才落入「今天」，数字会比「逐事件」晚一点——
  但这是宿主与挂件线的一致口径，对账优先。

## D010 账本只认累计值，单位/币种各自成组

- 背景：适配器给的是「今日累计」，不是增量；元、积分、百分比没有可加性。
- 选择：`ledger.json` 按 (日期, 适配器) 覆盖写入；汇总时 `unit|currency` 分组求和各适配器，
  **绝不做跨单位/跨币种求和**；失败与不支持不写（不留假 0）。
- 代价：账本是「观察到才算」的记录，没打开过的 agent 当天没有记录；界面必须如实说明。

## D011 暂不支持多显示器

- 背景：浮层窗口铺满主显示器工作区；跨屏时 `devicePixelRatio` 与各屏缩放都不同。
- 选择：R8 先只保证主显示器 + 当前缩放下的几何正确（e2e 在 125% 真机跑通），
  多屏留到后续：要么每屏一个窗口，要么把窗口铺到所有屏的并集并按屏换算。
- 代价：狐狸拖不到副屏；这是已知限制，不假装支持。

## D012 更新包先只做 sha256，签名留到 1.0 前

- 背景：更新器要能从网络下载并替换本机文件，这是攻击面最大的一段。
- 选择：清单必须带 sha256，下载后逐字节校验；HTML 走 HTTPS。
  **暂不做签名**——签名要管密钥、轮换、发布流程，早期版本号会频繁变。
- 代价：清单与包同源（都在 GitHub），若仓库/账号被攻破，sha256 拦不住。
  因此 1.0 之前必须补签名（与现有挂件线同款 `sign-release` + 公钥入库）。
  在此之前 `update --apply` 只建议在开发机用，不面向普通用户。

## D013 签名已落地：Ed25519 + 固定字段规范串

- 背景：D012 说「签名留到 1.0 前」，但 sha256 单独用等于没防住「清单和包一起被换」。
- 选择：Ed25519（Node 内置，密钥短、签验都快）。签的是 `{version,url,sha256,notes}`
  的**规范串**（固定顺序、只取这四个字段），所以清单重新格式化不影响验签；
  反过来，任何被更新器使用的字段都在签名覆盖内。
- 代价：私钥成为唯一信任根。私钥在本机 `%USERPROFILE%\fox-dock-release-key.pem`，
  公钥 `dock/keys/update-pub.pem` 入库；换密钥要重签全部在途清单（D012 的告警仍然成立）。
- 补充：`update --check` 默认必须验签；`--no-verify` 仅本地调试，输出会明确警告。

## D014 移植边界：只搬「看板能自己用上」的能力

- 背景：挂件线有十几个菜单项，但 dock 是多 agent 成本看板，不是单宿主桌宠。
- 选择：移植大小、跟随间隔、每轮气泡、今日预算、额度预警、滚动条避让、用量搜索、关于自检；
  **不移植**音效、角色、桌宠模式、对账口径、余额校正。
- 理由：前三项缺素材（或用户已撤回），桌宠模式 dock 本身已具备（全屏浮层），
  对账口径由计价内核处理，余额校正需要厂商 key（属于挂件线的宿主能力）。
- 代价：dock 比挂件线「安静」——没有声音、没有换装。这是有意的。
  完整对照与理由见 `docs/dock/MIGRATION.md`。

## D015 2.0：四个宿主、一套通用额度卡

- 背景：2.0 要把 ZCode / WorkBuddy / Kimi Code / DeepSeek Harness 统一到一只桌宠上。
  四家的口径完全不同：元、积分、百分比窗口、现金余额。
- 选择：契约增加 `quotaCard`（`windows | balance | plan | error`）、`details`、`usage`、
  `plan`、`account`；适配器只给结构化数据，UI 只消费这一套。角色默认值也放进适配器
  （`roleDefault` / `accent`），绑定后由服务端判定，前端不能伪造。
- 代价：适配器作者要多写一点声明；换来的是面板/卡片/告警不需要为每家写分支。

## D016 Kimi Code 的 OAuth 刷新要写回宿主凭据

- 背景：Kimi Code managed OAuth 的 access token 只有 15 分钟，refresh token 会轮换。
  只读不写会让宿主下次启动掉登录。
- 选择：**唯一允许写宿主文件的地方**。过期时用宿主同款 client_id 与
  `POST /api/oauth/token` 刷新，临时文件 + rename 原子写回原文件，保留其它字段；
  同一凭据的并发刷新合并成一次。错误信息只带 HTTP 状态与错误码，不带 token。
- 代价：如果宿主正在运行且同时刷新，仍可能有一方读到旧 token；下一次 401 会自愈。

## D017 dsh 会话是多帧 zstd，必须逐帧解

- 背景：`~/.dsh/sessions/**/session.v*.jsonl.zstd` 一个文件里每个事件批次一帧；
  Node 的 `zstdDecompressSync` 只解第一帧（3.7MB 文件只出 251 字节）。
- 选择：按 zstd 帧头/块头切帧，逐帧解压；坏帧跳过后继续找下一个 magic。
  今日总额包含主会话与 subagent；「上一轮」优先主会话（`delegationDepth=0` 且无 `origin`），
  避免更晚的 subagent 冒充用户眼前这一轮。
- 代价：解析器要自己维护帧格式；zstd 帧格式升级或换压缩器时要同步。

## D018 浮层窗口：toolbar + 端口标题 + 单实例

- 背景：透明全屏置顶窗在 Windows 上容易被宿主遮挡判定影响；多个实例叠加会
  出现「角色时有时无」。另外同一台机器可能同时跑测试实例与正式实例。
- 选择：Windows 用 `type:'toolbar'`、`focusable:false`、`resizable:true`、
  构造时 `alwaysOnTop`；默认硬件合成（`FOX_DOCK_SOFTWARE_RENDER=1` 才回退）。
  标题带 daemon 端口（`fox-dock overlay <port>`），stop/start 只接管同端口实例；
  不按「小挂件」匹配，避免误杀 ZCode/WorkBuddy 的浮层。
- 代价：端口变化后旧的 pid 文件/窗口需要一次 stop 清理；标题会出现在任务栏/诊断里。

## D019 全厂商页复用挂件线服务，不重写 35 家厂商

- 背景：原挂件线的 `vendors.mjs` 已经有 45 个模板（DeepSeek/GLM Plan/CommandCode/
  Kimi/MiniMax/OpenCode/OpenRouter/Moonshot + 26 家无余额接口）。把这套搬进 dock
  会多出约 2 万行、并且要和 ZCode 的凭据发现强耦合。
- 选择：dock 只做本机服务发现（39321–39330 → `/whale/health` → `/whale/vendors.json`），
  把结果收敛成展示字段；凭据不离开原挂件进程，dock 不存 key。
- 代价：厂商页依赖原挂件在跑；原挂件没启动时只显示四个宿主自己的卡。这是明确的降级，
  不是静默失败。
- 已被 D022 取代。

## D020 角色尺寸与桌宠/更新入口

- 背景：2.0 曾把角色固定为 128px，而原挂件在 2560×1600/150% 下是 250px 基准，
  观感上直接小一半；另外只有拖拽/吸附，没有菜单和自由摆放。
- 选择：沿用挂件线公式 `clamp(122, min(250, min(vw,vh)*0.28)*scale, 625)`；
  角色右上角加菜单按钮；设置加「桌宠模式」（不吸附/不跟随）；
  设置/关于接入更新清单检查（只检查，不自动落盘）。
- 代价：250px 下浮层几何/面板定位要重新算（已改为按上下可用空间限高并滚动）；
  更新检查在未发布 `dock-v*` 清单时只能提示「未配置更新源」。

## D021 整合分支沿用 feat/dock

- 背景：需要把 2.0 的四个适配器、绑定/账本/更新器与新的 UI 放到同一个可验收的底座上。
- 选择：以 `feat/dock` 为唯一整合分支，继续在 `E:\WorkSpace\fox-dock` 工作树开发；
  不新建第二条整合分支，也不在 1.0 前合并回 main/workbuddy。
- 代价：与旧两线的共享文件（README/CHANGELOG/lib/）保持零改动，合并前只做 cherry-pick。

## D022 厂商引擎内置（取代 D019）

- 背景：D019 的「厂商页复用挂件线服务」让 dock 在没装挂件线时没有厂商数据，
  与「脱离宿主存活」直接冲突。
- 选择：把 `vendors/relays/balance/plan-balance/glm-plan-api/cmdgo/credentials/source/blocked-host`
  搬进 `dock/engines/`；凭据走环境变量 → 保险库 → 宿主只读发现 → 旧配置导入。
  挂件线服务只保留为「导入源」。
- 代价：搬迁量约 3.6k 行，必须有 engines parity 测试兜底；搬运不改逻辑。

## D023 宠物层 / 控制台双窗口

- 背景：浮层 `focusable:false`，设置页的输入框根本打不了字；复杂页面也不该塞进常驻透明窗。
- 选择：宠物层只放角色、胶囊、气泡、快览卡、菜单；其余页面放进独立可聚焦的控制台窗口。
- 代价：两个 Electron 窗口的资源占用要纳入 soak 门禁；控制台关闭时销毁渲染进程。

## D024 Preact + htm（vendored，无构建）+ 手写 SVG 图表

- 背景：旧 `renderer.js` 每 5 秒 `clearNode` 重绘，滚动与展开状态全丢。
- 选择：vendored Preact 10 + htm 3（MIT/Apache-2.0），图表用约 500 行自维护 SVG 模块；
  不引入打包器、Chart.js、React。
- 代价：要维护 vendor 版本与校验和；图表交互只做 hover tooltip。

## D025 三态状态机

- 背景：旧行为「拖到空白 = 解绑」，会把角色和气泡设置一起重置。
- 选择：`idle / attached / floating`；拖到桌面进入 floating，保留上一个 agent 的档案；
  关闭 agent 窗口也是 floating 而不是 idle。明确「解除吸附并重置」才回 idle。
- 代价：`bindings` 与旧 `/bind` 语义要同步；三态用表驱动 + 随机序列测试守住不变量。

## D026 凭据保险库（Windows DPAPI）

- 背景：脱离宿主后密钥来源必须自管；明文 key 落盘不可接受。
- 选择：`%LOCALAPPDATA%\fox-dock\vault.json` 存 DPAPI 密文，键为厂商模板 id；
  API 只回掩码，日志/诊断包全局扫描密钥模式。非 Windows 拒绝存储，只认环境变量。
- 代价：保险库绑定当前 Windows 用户；换用户/换机器要重新导入。

## D027 首个对外包版本 2.0.0-pre.1

- 背景：2.0.0 从未发布，没有历史包袱。
- 选择：首个 tag `dock-v2.0.0-pre.1`；CHANGELOG 的 2.0.0 条目允许按最终内容重写；
  1.0 之前全部预发布。
- 代价：更新器只认 `dock-v*`，默认预发布通道。
- 注：早期预发布迭代（吸附辅助窗、菜单贴底、音效、厂商切换、气泡关闭等）已全部
  整合进单一的 `dock-v2.0.0-pre.1`；pre.2/pre.3 不再单独保留。

## D028 /v1 API 与 SSE

- 背景：旧路由是 2.0 的临时接口，轮询把面板打成整体重绘。
- 选择：新增 `/v1/*` 与 `/v1/stream`（SSE，15s 心跳）；旧路由保留一个小版本并加
  `X-Fox-Deprecated: 1`。写接口需 `x-fox-token`，读接口校验环回 Host 防 DNS rebinding。
- 代价：旧浮层切换完成前要维护两套入口；M5 后删除旧路由。

## D029 上下文口径与「不补零」置信度模型

- 背景：四宿主能拿到的上下文信息不同，缺失被当成 0 会直接误导。
- 选择：`supported/confidence/reason` 三件套；`pct` 只能由统一函数计算；
  缺项不补 0；趋势点由 daemon 采样并保留 240 点；压缩事件区分实测与推测。
- 代价：UI 要为「不可得」写完整文案与空态，不能只画一根空进度条。

## D030 恢复挂件线被砍项

- 背景：D014 以「文件加载通道/宿主能力」为由砍掉了若干有价值的能力。
- 选择：恢复角色导入（PNG 魔数、≤3MB、≤2048²、id 白名单、内置不可删）、气泡队列与模板、
  配色覆盖（含 HSV 调色板）、余额校正；撤销 D014 中与这些条目冲突的部分。
- 代价：角色导入与模板导入必须过安全测试；音效恢复为默认开，事件音不做（原「默认关」已由 D031 取代：音效不再单独开关，随勿扰静音）。

## D031 2.0 交互收口（2026-10-19）

- 背景：首轮真机反馈里，吸附被拆成「已吸附/解除吸附/桌宠模式」多个入口，
  拖拽提示会横跳，气泡撞边后二次移动；设置页的原生下拉还会让内容区漂移。
- 选择：
  - 吸附只保留一个「吸附到 agent 窗口」总开关（内部仍是 `petMode`，UI 取反）；
    拖到窗口四角/边缘才吸边，窗口中间保留相对窗口的自由位置；避让滚动条改为显式开关。
  - 气泡先算空间再一次性定位，箭头单独指向角色；`hideMoney` 直接不弹消耗气泡。
  - 音效不再单独开关，随「勿扰」静音；快速连击先停旧音轨。
  - 控制台下拉/复选框自绘；控制台渲染进程崩溃或无响应时自动重载。
  - 角色导入支持 PNG/GIF；JPEG/WebP 在控制台转 PNG，GIF 保留动画。
  - 100% 角色大小 = 旧挂件默认档；去掉呼吸缩放。
- 代价：`scrollGapOn` 成为新设置字段（旧 `scrollGap:17` 在未开启时不再产生缝隙）；
  自定义下拉需要自己维护键盘与 outside-click 行为；GIF 的 alpha 掩码只能退回矩形命中。

## D032 当前厂商以最新模型调用为准（2026-10-20）

- 背景：ZCode 的 `turn_usage` 只在回合结束时写 completed 行，而 `model_usage` 在每次
  调用完成后就落库。若当前厂商取「最近 completed 回合」，用户切到 DeepSeek 后整个回合
  都会沿用上一个 CommandCode 回合的标题与三重额度，回合结束才切换。
- 选择：`readUsage` 新增 `latestModel` 查询，当前厂商/模型优先取最近一次
  `status='completed'` 且 tokens > 0 的调用；读不到再退回最近回合，最后退回今日最后一行。
  `lastTurn` 仍保持「上一轮」语义，用于上一轮消耗对比。
- 代价：切换发生在第一次调用完成之后（而不是点击发送时）；若新回合还没有任何已完成调用，
  仍会短暂显示旧厂商。这是当前数据源能提供的最早信号。

## D033 数据可信度模型（2026-10-22）

- 背景：统计金额一律是「价目表折算」，却在 UI 上与官方余额同权展示；缺失还被补 0。
- 选择：新增 `shared/provenance.mjs`，每个金额/token/百分比携带
  `kind(exact|estimated|unavailable) + origin(api|local-db|local-log|pricing-table|user|unknown)
  + source/asOf/note/reason`；UI 映射 official/local/estimate/unavailable 四标签。
  价目折算通过新建 `daemon/src/cost-prov.mjs#withCostProv()` 包装，不改
  `engines/{pricing,cmdgo,relays}.mjs` 三份逐字节副本。
- 代价：所有新结构都要带 provenance；缺失字段必须是 `null + unavailable`，
  UI 不能再把缺失画成 0。

## D034 会话层与实时状态（2026-10-22）

- 背景：`/v1/events` 只记 200 条，不驱动状态机；四个宿主没有统一会话模型。
- 选择：`shared/session-model.mjs` 统一 Session；`shared/live-reduce.mjs` 用表驱动
  纯函数归约；`daemon/src/live-tracker.mjs` 合并轮询与事件注入；ZCode 用库聚合，
  WorkBuddy/dsh 尾随日志，Kimi 只列会话且不伪造状态。`GET /v1/sessions*` +
  SSE `session/sessions`；增量读取 `shared/tail.mjs`（含多帧 zstd 尾随）。
- 代价：状态是「信号 + 推断」，`working` 可能标 `inferred`；Kimi 永远显示
  「状态未知」。

## D035 钩子纪律（2026-10-22）

- 背景：ZCode 钩子始终内联执行，每次多一个 node 冷启动。
- 选择：只挂低频事件（`UserPromptSubmit` / `PermissionRequest` / `Stop` /
  `PostToolUseFailure`）；钩子永不阻塞宿主，任何异常 `exit 0`；集成插件随包提供，
  由用户自行安装，不自动写宿主配置。
- 代价：没有细粒度工具事件；工具级状态靠库/日志轮询。

## D036 权限接管（2026-10-22）

- 背景：权限确认是唯一需要「主动等人」的场景，但误放行代价高。
- 选择：默认关闭；永不提供 always-allow；只允许「允许一次 / 拒绝」；高风险工具
  降级（热键不响应、主按钮不默认聚焦）；预览服务端脱敏；超时/任何失败回落宿主
  原生弹窗（fail-open to host）；`Origin + 令牌` 双校验。
- 代价：关闭时只做「通知 + 跳转宿主」；需要用户安装集成插件才生效。
- 2026-10-26 终审补强：决策面收紧——`GET /v1/actions` 也要求 `x-fox-token`
  （待办含命令预览与 requestId，不能匿名枚举）；高风险动作在 daemon 侧一律拒绝
  `allow`（`resolve` 与伪造的 `permission_resolved` 事件都拒，审计记
  `refused-high-risk`），只保留「拒绝」与超时 fail-open 回宿主原生弹窗；
  `daemon.lock` 按 0600 写（POSIX 生效）。同一条待办的匿名读面
  （`/v1/sessions`、会话详情、SSE 的 `sessions`/`action` 事件）也只保留工具名/
  风险/截止时间等状态字段，预览与 id 仅持令牌可见；宠物层权限卡经主进程持令牌取
  完整待办，SSE 只当刷新信号。
- 威胁模型（必须明确记录）：令牌存在 `daemon.lock` 里，同一用户下的任意进程都能
  读，因此 daemon **无法**从 HTTP 层区分「用户点的 UI」与「同用户冒充者」。这次
  能守住的不变量是「高危动作绝不代答允许」；普通风险动作的放行仍可能被同用户
  进程冒充（影响面 = UI 上「允许一次」能做的同一集合）。要彻底消除，需要把允许
  动作绑定到同用户进程无法伪造的用户在场证明（例如一律只走宿主原生弹窗，不让
  daemon 代答 allow）——属产品决策，未在本轮实施。

## D037 `ingest` 协议 v1 与自定义 agent（2026-10-22）

- 背景：给本机程序/自定义 agent 一个稳定、可校验的上报入口。
- 选择：`POST /v1/ingest`，16KB 上限、逐字段校验、丢弃未知键、自定义 agent 上限
  8 个、令牌桶 50 req/s（突发 100）；内置 agent 记 local-log，自定义 agent 记
  unknown/estimated，且不参与跨 agent 汇总。
- 代价：自定义 agent 的数据只能作为独立分组展示，不能与其他宿主相加。

## D038 控制台信息架构（2026-10-22）

- 背景：上下文页只是单个会话的一个视图，单独占一页让导航膨胀。
- 选择：保持 9 页，「上下文」并入「会话」详情的标签；`#context` 与旧 localStorage
  页码重定向到 `#sessions?tab=context`；总览改为四块任务卡（今日成本 / 当前会话 /
  待处理 / 预警）。
- 代价：旧链接与现有视觉基线全部更新；导航热键 Ctrl+2 改为「会话」。

## D039 动画红线（2026-10-22）

- 背景：桌宠产品容易滑向 idle 呼吸/摇摆，既耗电又干扰。
- 选择：只允许「状态存续期间」的功能性动画（`fd-spin` 旋转弧、权限到达一次性
  `fd-nudge`）；空闲场景 `document.getAnimations()` 的无限动画为 0；
  `prefers-reduced-motion` 全部关闭。
- 代价：状态只能靠徽标/文案/胶囊表达，不能靠角色本体动效。

## D040 宿主窗口聚焦（2026-10-22）

- 背景：「跳转到宿主窗口」需要 Win32 前台切换，而系统前台锁经常拦截。
- 选择：桥新增 `focus <hwnd>`（`ShowWindow(SW_RESTORE)` → `AttachThreadInput`
  → `SetForegroundWindow`/`BringWindowToTop`，失败回落 `FlashWindowEx`）；daemon
  只聚焦「当前已发现的该 agent 窗口」，路由接收 sessionKey 后自行反查，不接受 UI
  传任意 hwnd；返回 `method:foreground|flash`，UI 文案如实区分。
- 代价：前台锁下只能闪烁提醒；测试与真机都要容忍 `flash`。

## D041 吸附后不按 z-order 隐身（2026-10-24）

- 背景：浮层曾用「宿主窗口中心是否在最上层」决定显示，但该点经常被
  TabTip/TextInputHost 等输入法辅助窗、QQ 或全屏播放器盖住，导致角色拖到
  宿主上吸附后立刻变成 opacity 0，看起来像消失。
- 选择：吸附/悬浮都保持角色显示；不再用 `/hit` 决定整体可见性。点外仍由
  渲染层的鼠标策略穿透，只有手动隐藏、退出或 daemon 长时不可达才收起。
- 代价：其它窗口盖住宿主时角色仍在最上层；这是桌宠的预期，也是全屏视频
  下仍能操作角色的前提。

## D042 总览 7 天图与用量页共用日汇总（2026-10-24）

- 背景：账本只记录「观察到」的金额，预付/套餐日按规则记 0；用量页按
  `model_usage` 逐行计价，同一天有金额。两套口径直接并排会让用户看到
  「总览 0 元、用量有数据」。
- 选择：`/v1/usage/breakdown` 增加按日汇总 `daily`（所有 series，不只 top 8），
  总览 7 天图直接消费它；预付/套餐日按等价市值显示，tooltip 与卡片动作区
  标注「含预付等价」。今日成本卡仍用账本的实际金额，并保留“预付日显示
  token 而不是 ¥0.00”的行为。
- 代价：总览 7 天图不是纯「实际支出」；需要看实际支出时以今日卡/账本为准。
  多币种按 series 主币种分组，不跨币种相加。

## D043 浮层任务栏安全边距（2026-10-24）

- 背景：任务栏设为自动隐藏时显示器工作区等于整屏，铺满工作区的置顶浮层与
  整屏重合，会被系统当作全屏窗口压住任务栏的滑出热区，任务栏弹不出来
  （1.x v1.16.2 issue #8 同款问题）。
- 选择：浮层窗口创建时对所选显示器工作区四周统一缩进 4 DIP
  （`overlay/window-bounds.cjs`，1.x v1.16.2 方案迁移），不做自动隐藏状态探测——
  常驻任务栏下工作区本就排除任务栏（兜底位自然停在工作区角落即任务栏上方），
  自动隐藏下缩进防止窗口与整屏重合、留出滑出热区。
- 代价：角色坐标系整体偏移 4 DIP（由既有 origin 机制消化）；极小工作区时
  窗口最小 1×1。

## D044 宿主失前台兜底（2026-10-24）

- 背景：此前只有宿主最小化/关闭才落右下角兜底，宿主切到后台或被完全覆盖时
  角色仍贴在不可见宿主的坐标上；但直接按「宿主不在前台」判定又会因频繁切窗
  抖动。
- 选择：`/rect` 成功响应附带 `background` 布尔（桥内 `GetForegroundWindow`
  判定，前台窗口与宿主同进程视为仍在使用，如宿主设置对话框）；浮层持续失前台
  ≥3 秒（`HOST_BACKGROUND_FALLBACK_MS=3000` 防抖）落右下角兜底，回前台由
  follow 轮询自动恢复吸附；只挪位置、不改 daemon 三态、不做 z-order 隐身
  （D041）。用 `ok + background` 字段而不是 `ok:false` reason：矩形可用性与
  焦点状态是两个语义，失败语义会让既有 rect 测试随前台窗口不确定挂掉。
- 代价：前台但被 topmost 窗口完全盖住的极端场景不触发（视为仍在使用）。
- 修订（2026-10-24 第二批）：防抖 3000ms → 500ms（用户定稿：切走要立刻有反馈，0.5 秒仍能
  吸收 Alt+Tab 瞬间往返）；兜底角落从固定右下改为 `fallbackCorner` 四角可选（右下/左下/
  右上/左上，默认右下，迁移 1.x defaultCorner）；落角期间显式覆盖朝向面向屏幕内侧（兜底时
  mode 仍是 attached，吸附分支的镜像判定会算出朝外），恢复吸附/用户拖动/服务端还原位置后
  清除。同批定稿：兜底位直接贴住工作区角落——浮层窗口与工作区精确重合（window-bounds.cjs），
  仅「工作区==整屏」（任务栏自动隐藏）时留 1 DIP 不可见缝防压任务栏滑出热区（v1.16.2 的
  最小化版本）。
- 修订（2026-10-24 第三批，迁移 1.x v1.16.6 issue #11）：兜底摆位是瞬时显示状态，
  **不写回 floating.rect**——机器摆的角落坐标一旦落盘，改 fallbackCorner 或浮层重载都会
  把角色恢复到旧角落而不是当前设置；daemon 的 floating.rect 只属于用户亲手拖出的位置
  （agent-window-gone 本就清空 rect，恢复路径自然按当时设置重新落角）。

## D045 会话状态判定：回合内保持与静默阈值（2026-10-24）

- 背景：ZCode 库内 `model_usage`/`turn_usage` 只有终态行（进行中的调用/回合
  不落行），适配器靠 20 秒新鲜度窗口推断；回合内一次调用完成 20 秒后、下一次
  落行前被推断成空闲，叠加归并无滞回与 expire/轮询拉锯，胶囊在「工作中/空闲」
  间 1–2 秒一跳。
- 选择：回合内保持 working——最新模型调用晚于最新回合结束即视为回合内证据，
  自其开始/完成时间的较大者起保持 90 秒；仅接受两类降级：① 明确回合结束证据
  （终态回合行，立即降级不吃宽限）② 距上次宿主证据 ≥90 秒的静默——适配器
  保持、`mergeSnapshot` 滞回、expire 超时三层同用 90 秒阈值与宿主证据时钟，
  静默推断的 idle 标 `statusSource='inferred'` 以区分。`tool_usage` 的 running
  行 10 分钟内不算静默（在途证据），超过视为宿主崩溃残留；pending（等待确认）
  语义优先于上述一切滞回。
- 代价：回合实际结束但终态行迟迟不落库时，状态最多多保持 90 秒；90 秒取自
  D034 既有 expire 阈值，三层共用同一时钟正是为了互不拉锯。

## D046 厂商状态百分比口径（2026-10-24）

- 背景：GLM Plan 引擎输出的 `percentRemaining` 是 0–1 比例（与 1.x lib 契约
  一致），而 dock 全部消费方按 0–100 百分数处理，满额度 500M/500M 被显示成
  「1% 剩余」、总览还误报「额度剩余 1%」。
- 选择：vendor 状态里所有 `percentRemaining`/`usedPct`/`remainingPct` 统一为
  0–100 百分数（一位小数）；换算只发生在 `engines/vendors.mjs` 的状态组装边界
  （`planVendorStatus`）与 `daemon/src/host-vendors.mjs` 的 legacy 收敛处，
  引擎内部 payload 保留 0–1 比例；百分比必须来自同一条目内 remaining/total
  （同单位），total 不可得时字段缺失（undefined），禁止补 0。
- 代价：两个换算边界之外新增消费方必须自行换算；1.x 线展示层 ×100 的旧契约
  保持不动。

## D047 火山方舟计费分流与订阅配额（2026-10-24）

- 背景：火山方舟接入的 Base URL 常是无关键词 UUID，providerId 里的
  volc/coding-plan 字样不能证明平台身份；订阅（Coding/Agent Plan）与按量混在
  同一路径下，经方舟出网的托管模型（deepseek-v3 等）会被误算进原厂按量账单。
- 选择：计费口径由官方 Base URL 路径唯一裁定——ark.cn-beijing.volces.com 的
  /api/coding、/api/plan 视为订阅预付池（与 start-plan/cmdgo 同款：金额记 0、
  token 照算、等价市值另行标注），/api/v3 与域名家族其余路径视为按量真金白银。
  订阅配额卡凭据只认火山 IAM AK/SK 对（env 四套别名整套配对 → DPAPI 保险库
  两个条目 → 旧挂件 vendorKeys），模型 key（ark-）查不了配额也不得冒充。
- 代价：席位版 GetSeatInfoUsage 暂不覆盖（官方需两跳且字段未实测），该范围
  配额显示不可得。

## D048 关闭语义：退出 = 本次退出（2026-10-24）

- 背景：托盘/宠物菜单的「退出」容易被理解成连开机自启一起关掉，控制台窗口
  关闭按钮也常被当成退出；行为本身已是目标语义，缺的是契约与文案钉死。
- 选择：退出 = 本次关闭——托盘/宠物菜单退出调 daemon `/shutdown`（退出码 0，
  watchdog 不再拉起）且不触碰启动器/autoStart；「开机自启」是设置页与托盘的
  独立显式开关，只经 `/v1/maintenance/autostart` 装卸启动文件夹的 VBS 启动器；
  控制台窗口关闭按钮一律收进后台（preventDefault + hide），不视为退出。菜单与
  设置文案显式标注「（本次退出）」。
- 代价：想退出并取消自启的用户要分两步操作（退出 + 关自启开关）。

## D049 价目快照沿用与下架条目口径（2026-10-24）

- 背景：厂商价目页会下架旧条目、反爬或超时；直接删条目或收录单源数字都有
  计价出错的风险。
- 选择：官方价目页已下架但无下线公告的条目（MiniMax M2.x、Qwen
  3.8-max-prime）按旧快照保留，待官方确认下线再移除；官方定价页不可达时
  （反爬/超时），以 LiteLLM 注册表逐项交叉一致作为沿用既有快照的依据，
  单源不一致的数字不收录。
- 代价：已下架未公告的条目仍参与计价；DeepSeek 法定节假日全天谷价为官方
  口径，现实现仅覆盖周末（无节假日表），属多算方向的已知简化，是否补表待定。

## D050 权限接管实现与分支开关（2026-10-25）

- 背景：P-2 探针只验证了本地链路（stdin 字段、exit 0/2、stdout 可写），
  「stdout 能否表达 allow」的严格 schema 还没在真机确认。
- 选择：两条分支都实现。钩子侧 `SUPPORTS_ALLOW` 默认 false（分支 B：allow
  一律静默 exit 0 交回宿主弹窗），探针确认后改常量并同步 `settings.permission.
  allowOnce`（默认 false）——权限卡的「允许一次」按钮只在两者都为真时出现，
  高风险永远不出现。daemon 侧不做能力探测，结论以 ADAPTERS.md 实时信号矩阵为准。
- 审计只记 id/tool/decision/via（via ∈ pet/console/hotkey/notification/timeout/
  host），绝不记预览原文；pending 不持久化，daemon 重启即全部 fail-open。

## D051 语音库迁移：三套内置 + 自定义导入（2026-10-25）

- 背景：1.x v1.16.3 的猫娘音效集与语音库（切换/导入/删除）未随 pre.1–pre.2
  迁移；dock 播放骨架（双音轨、100ms 衔接、勿扰静音）已在。
- 选择：内置三套 duck/fx1/nya（fx1 显示名对齐 1.x 更名「嘀嘟」）；猫娘用
  定稿素材（CC0，一声制：Nya1.wav 按压 + Nya2.wav 100ms 静音松手，出处留档
  dock/NOTICE 第 4 条）；按压时序不改（定稿听感依赖现有时序）。自定义集走
  daemon `/v1/sounds`（dataURL + base64、魔数校验、单文件 ≤2MB、≤20 套），
  宠物层播放导入集经主进程二进制 IPC 转 Blob——渲染层仍零 fetch（Mimosa 红线）。
  `soundSet` 进 daemon settings（非 widget-state），旧集由 import-old 复制迁移。

## D052 接入向导、增量索引持久化与便携包（2026-10-25）

- 向导只做「发现 + 导入入口 + 复制集成目录路径」，不自动写宿主配置；
  `onboarded` 标志已有，向导仅在未完成且发现宿主/旧数据时首启。
- 增量索引只持久化「可删除重建」的派生状态（WB 尾随水位 + 已解析事件），
  版本不符/损坏/超 8MB 一律丢弃；「删除缓存后结果不变」由等价性测试守卫，
  不做增量与全量漂移的自动校准（漂移风险由等价性测试 + 缓存可删兜底）。
- 便携包 = 现有 tar.gz + 启动件校验 + PORTABLE-README.txt；签名机制不变。
- **修订（2026-10-25，探针真机实测后）**：分支 A 成立——stdout 只有
  `{"continue":true,"decision":"approve"}` 被采信；deny 走 exit 2（stderr 文案透传
  给 agent）；stdout 的 deny 不被采信。dock-hook `SUPPORTS_ALLOW` 默认 true、
  `allowOnce` 默认 true（takeover 仍默认关）；原生确认卡片阻塞等待钩子，等待上限
  维持 30s。探针插件测完即从宿主卸载，不入任何发布物。

## D053 套餐按模型分桶的进度条展示（2026-10-25）

- 背景：GLM start plan 的赠送池按模型分开记账（实测 2026-10-25：GLM-5.3-Flash
  0/3 亿已用尽、GLM-5.3 还剩 767206/2 亿），汇总后总桶显示 0.2% 剩余。额度页
  此前只有一行文字列出各桶的百分比，快览卡与额度页顶部卡更是只拿汇总百分比，
  用户看不出是哪个池子见底。
- 选择：把「按模型分桶」做成与 CommandCode 三重窗口同款的进度条。
  - 数据：`engines/vendors.mjs#planVendorStatus` 给 `byModel` 每桶补
    `percentRemaining` / `percentUsed`（0–100，一位小数，同桶 remaining/total，
    total 不可得保持 undefined，不补 0；D046）；`adapters/zcode/index.mjs`
    `bucketsOfVendor()` 把它压成 `quotaCard.buckets`（`{key,label,usedPct,
    remainingPct,remaining,total}`，最多 8 个）；`adapters/contracts.mjs`
    `normalizeQuotaBucket()` 按契约净化，总额不可得/负数/空名的桶整条丢弃。
  - 展示：控制台额度页的厂商卡把原来的文字行换成进度条（`BucketBars`），
    顶部「当前宿主额度」卡在 `kind='plan'` 时也按桶画条；宠物层快览卡在窗口行之后
    追加最多 3 条桶行（标签列放宽到 80px 并省略，完整名走 title，尾列显示
    「剩余/总量」tokens）。进度条填充统一是**已用**比例，与既有窗口行同口径。
  - 汇总百分比保留作参考，不删除（口径仍是 remaining/total），但 plan 卡 note
    明示「总剩余只作参考；下方按模型分桶」。
- 代价：`quotaCard` 契约多一个 `buckets` 字段（旧 daemon/夹具没有时归一化成空数组，
  UI 按无桶渲染）；快览卡最多多 3 行，视口内滚动兜底不变。

## D054 会话成本口径：真金白银 + 等价市值 + 分段计价（2026-10-25）

- 背景（用户提的计费审查）：会话页成本列直接拿 `costOfUsage` 按「模型+provider」
  分组乘价，**没有** `resolveBillingSource` 的预付池归零。实测同一会话
  `session_875a`（1300.1M tokens）显示 ¥317.09，其中 GLM start plan 订阅池
  ¥279.97、CommandCode credit 池 ¥25.74，真实按量只有 ¥12.31。另外两处偏差：
  组内用「最后一笔调用时间」计价，DeepSeek 峰谷/周末档位会整体算错（实测差 ~3%）；
  回合明细用 `MAX(model_id)` 把整轮 token 压给一个模型，混合模型回合整体乘错价。
- 选择：
  - 归零判据统一到 `adapters/zcode/prepaid.mjs#isPrepaidBilling(providerId, modelId)`
    （名字规则 + 官方 Base URL 路径 + GLM 订阅修正），会话列表、回合明细、
    `aggregateUsage`（用量页下钻）、`readUsage`（今日/上一轮）同一口径；
    金额记 0、tokens 照算（与 usage-records 完全一致）。
  - 分段计价：`model_usage` 按「模型 + provider + 整点桶」聚合（`started_at` 是
    epoch ms，`CAST(started_at/3600000 AS INTEGER)`）。DeepSeek 峰谷边界与周末
    生效分界都落在整点，所以桶内档位恒定——既逐笔精确，又不退化成逐行开销。
    每桶用桶内最早时间计价；换模型后的 token 只按新模型的价算。
  - 回合明细：`turnsFallback` 改为按 (回合, 模型, provider, 整点桶) 返回分组行，
    逐组计价后按回合汇总；回合主模型按 token 最多的组展示（原来取 `MAX(model_id)`）。
  - 等价市值：`costMarket` 与 `cost` 分开输出（多币种只取主币种），只在
    「真实支出为 0 但确实有预付用量」时，成本列显示「≈¥x」并挂 tooltip
    「预付池/套餐用量：tokens 照算、不计按量金额」——避免整列 ¥0.00 被当成计价坏了。
    等价市值不参与任何真金白银合计（与用量记录模型排名的 «≈» 同款）。
  - 缓存新鲜度：`live-tracker` 重启后恢复的 `live-sessions.json` 带着上次进程算出的
    tokens/cost；适配器同一 `updatedAt` 的结果过去被丢弃，导致改价目后空闲会话永远显示
    旧值。现在时间戳相等时累计量以适配器为准，实时状态（status/pending）仍用内存。
- 代价：会话列表的金额会明显变小（预付池会话为 ¥0 / `≈市值`），与「今日已用」一致；
  `session-model` 与 `live-tracker` 的合并规则多一条「等时间戳取适配器累计量」。

## D055 控制台渲染错误兜底与崩溃自愈（2026-10-25）

- 背景（用户报告）：点设置页「启动时检查更新」后控制台白屏且无法操作。用当前代码
  在夹具与真机（不同会话状态、daemon 重启后再点）都没能复现渲染异常，但暴露了两个
  真实的兜底缺陷：① 页面渲染抛错没有边界，整窗会白；② `recoverRenderer` 是
  「10 秒内只重载一次，否则直接 return」——渲染进程在 10 秒内崩第二次就永久白屏。
- 选择：
  - `ui/components/base.mjs#ErrorBoundary`（Preact 类组件 + `getDerivedStateFromError`
    / `componentDidCatch`）：页面内容按页 key 包一层，App 外层再包一层；出错显示
    「重新渲染 / 重新加载控制台 / 复制错误」卡片，侧栏与其它页面继续可用；错误进
    `window.__foxRenderErrors` 环形缓冲（最多 20 条）便于诊断。
  - 主进程 `console/main.cjs#recoverRenderer(reason)`：滑动 60s 计数 + 退避
    `0/1/3/10/30s` 重载，永不放弃；同时监听 `render-process-gone`、`unresponsive`、
    `did-fail-load`（排除 -3 ERR_ABORTED）。每次崩溃追加一行到
    `<数据目录>/console-crash.log`（时间 + 原因 + 近 60s 次数）。
- 验证：CDP `Page.crash` 连续崩两次，两次都自动重载回可用页面，日志两条
  （旧实现第二次会被 10s 窗口静默跳过）。
- 代价：持续确定性崩溃时窗口会周期性重载（而不是静默白屏）；崩溃日志是纯追加文本，
  不参与诊断包导出（后续可按需并入）。

## D056 「已完成」展示窗口、回合活跃与 workflow 父会话（2026-10-26）

- 背景（用户反馈）：任务结束后列表/胶囊/快览卡永远显示「空闲」，「已完成」几乎抓不到；
  原因是 `done` 只由 `turn_end`/`session_end` 产生，4 秒后被 `expire` 降成 `idle`。
  另有两个误判：编排回合结束但 workflow 还在跑时父会话显示空闲；工具刚结束、首字未到
  的空档里库内没有新行，90 秒后也会被推断成空闲。
- 选择：
  - `doneAt`：进入 `done` 时记录时刻，4 秒降级不清除；展示层
    `shared/session-model.mjs#displayStatusOf` 在 5 分钟（`DONE_DISPLAY_MS`）内继续给出
    `done`。活跃状态（working/waiting/error）始终优先。
  - `turnActive`：钩子 `turn_start`（UserPromptSubmit）/`turn_end`（Stop）维护；回合内任意
    事件续命，整段静默超过 15 分钟（`TURN_ACTIVE_MAX_MS`）自动放开，避免 Stop 丢失后
    「工作中」永不结束。`db done`（`statusSource='db'` 且时间晚于 turnActiveSince）是可靠的
    回合结束证据，会清掉活跃标记；`db idle` 不会。
  - `workflowBusy`：ZCode 适配器按 `parent_session_id` 查 `dwf_run` / `workflow_run` 的
    running/pending 行；在跑时父会话按 working 计，结束后用 run 的 `time_updated` 起算
    5 分钟已完成。`session_task_link.status` 可能是陈旧的，不作为权威。
  - 根会话合并（`live-tracker#rootStatusOf`）取根 + 子会话 + workflow 的展示状态；`/v1/sessions`
    的筛选、计数、SSE 摘要与控制台/胶囊/快览卡全部读 `displayStatus`，UI 不再自行按
    `status==='done'` 推断。
- 验证：`session-display-status` / `zcode-workflow-status` 单测（窗口边界、turnActive 上限、
  合并优先级、workflow 结束起算）；`sessions-status` / `pet-status` E2E（已完成抓取、计数与
  筛选同源、UI 不信陈旧 working、无「已超时」串台）。
- 代价：会话结束后 5 分钟内不再显示空闲（文案可带「刚完成」区分）；无钩子的宿主在长工具
  结束后最多多显示 10 分钟 working（`statusSource='inferred'`），换取不再闪成空闲。

### D056 修订（2026-10-26 独立审查后）

- **手动停止不是完成**：ZCode 手动停止会落 `turn_usage.status='cancelled'`（实测
  `completed_at` 有值、`duration_ms` 有值）。适配器把「最后一次回合已结束」作为
  `incoming.endedAt`，`mergeSnapshot` 在 `statusSource='db'` 且 `endedAt >= turnActiveSince`
  时清掉钩子留下的 `turnActive`；同时 `cancelled` 不生成 `doneAt`，展示立刻回 idle。
  旧实现只认 `db done`，导致停止后一直显示「工作中」直到 15 分钟上限。
- **`permission_resolved` 续命**：等待确认也是回合内事件，处理完权限后回合会继续跑；
  `live-reduce` 现在对它调用 `touchTurn`，否则长回合在第 15 分钟被 `expire` 误判空闲。
- 验证：`session-display-status`（14/15/16/29 分钟边界、cancelled 合并）与
  `zcode-cancelled-status`（真实 SQLite 夹具：idle、无 doneAt、筛选口径）。
- 代价：停止后的会话立即回空闲，不再保留「已完成」5 分钟窗口；这是用户明确期望。

## D057 宠物层零网络：SSE 主进程代理与输入链路自愈（2026-10-26）

- 背景：独立审查指出 `overlay/pet.js` 仍直接 `new EventSource`，与「宠物层 daemon 交互
  一律走 preload IPC」的边界不一致；拖拽期间渲染进程网络会被挂起，SSE 可能断流。
  同时 1.x 线 issue #13 的真机结论是：页面 JS 活着也可能出现输入链路断流（
  `setIgnoreMouseEvents` 停在旧值，悬停/点击全部穿透），只能重启浮层。
- 选择：
  - `overlay/main.cjs` 持 daemon 令牌订阅 `/v1/stream`，按 SSE 分帧解析后经
    `stream-event` IPC 转发；preload 暴露 `onStream`；daemon 重启后 2 秒重连。
    渲染层只有纯浏览器测试（无 preload）才回退 `EventSource`。
  - 主进程每 30 秒取一次光标页面坐标，调用 `__pet.probeInput(x,y)` 做 DOM 命中测试，
    直接按结果纠正 `setIgnoreMouseEvents`（不再依赖渲染层反向 IPC 是否还通）。
    探针的 race 超时必须是显式失败（`overlay/input-probe.cjs#probeOnce`），不能把
    超时返回的 `null` 当成「页面还没准备好」跳过；超时/异常/取不到 `probeInput`
    连续两拍才重载渲染进程。永久 pending 是最需要自愈的场景，必须有测试。
  - `__pet.refit()` 先强制重读窗口原点再读 `/rect`：工作区原点变化后不能沿用首次缓存。
- 验证：`pet-status` E2E（有 `onStream` 时 `EventSource` 必须为零次构造、probeInput 可调用、
  refit 后 origin 更新）；`input-probe` 单测（正常返回、永久 pending 超时、异常透传、
  连续两拍触发/成功清零）；真机缩放/输入探针需在发版前人工复核。
- 代价：主进程多一条长连接与每 30 秒一次 `executeJavaScript`；SSE 不再受渲染进程网络
  挂起影响。纯浏览器测试路径仍保留 `EventSource`，不进入生产。
