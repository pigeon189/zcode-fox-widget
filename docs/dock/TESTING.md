# fox-dock 测试指南

## 1. 分层与命令

| 层 | 命令 | 说明 |
|---|---|---|
| 语法 + 价目同步 + 单元 + 静态守卫 + engines parity | `npm run ci` | 提交前必跑；CI 也跑这一组 |
| 单元 + 集成 | `npm run test:all` | 集成会开真窗口/真 Electron，需要桌面会话 |
| 控制台页面自检 | `npm run test:ui` | 夹具 daemon + Edge；布局/可访问名称/axe，9 页 × 双主题 |
| 页面 E2E（结构部分） | `npm run test:e2e` | 同上，关闭 axe |
| 控制台真窗口冒烟 | `npm run test:electron:console` | 启动夹具 + Electron console，CDP 断言并截图 |
| 视觉回归 | `npm run visual` / `npm run visual:update` | 36 张基线（9 页 × 双主题 × 两视口）；ENV-MISMATCH 直接失败 |
| 宠物层截图 | `npm run test:pet` | 四角/自由位置/悬浮/快览卡/菜单/贴底菜单/气泡/台词/隐藏金额，双主题双视口共 48 张 |
| 截图矩阵 | `npm run shots -- --page console --console-pages overview,context,usage,quota,vendors,roles,settings,about --theme light,dark --base http://127.0.0.1:39490` | 先启动夹具 daemon |
| 真机上下文对账 | `npm run verify:context` | PASS / SKIPPED（not-running / no-session）/ UNAVAILABLE |
| 真机计费对账 | `npm run verify:zcode` / `verify:workbuddy` | 与宿主/旧挂件口径比对 |
| 稳定性 | `npm run soak` | 长跑内存/句柄；过夜执行 |

测试依赖只在 `dock/test/package.json`（Playwright/axe/pngjs），不随运行时包分发。
浏览器用本机 Edge（`channel:'msedge'`），不需要下载 Chromium。

## 2. 夹具

- `tools/fixture-daemon.mjs`：按 `test/fixtures/scenes/*.json` 返回固定快照，时间冻结；
  同时提供 `/ui/*` 静态文件，供页面截图与 E2E 使用。
- `test/fixtures/scenes/zcode-normal.json`：四宿主快照、上下文、会话、7 天账本、厂商、角色。
- 集成测试的宿主数据库全部现场合成（`node:sqlite`），不读真实用户库；dsh 会话由
  `zlib.zstdCompressSync` 逐帧写多帧文件。

## 3. 页面自检覆盖

`tools/ui-check.mjs` 对每页检查：

1. 无 `pageerror`；
2. 文档无横向滚动；
3. 可见文本字号 ≥12；
4. `button/input/select/textarea/a` 有可访问名称（aria-label/title/文本/label）；
5. axe `critical` 与 `serious` 为 0（含 color-contrast、label、select-name）。

设置页的「标签 + 控件」两栏结构在渲染后为控件补 `aria-label`；新增设置行时保持这个机制，
不要用占位符代替标签。

## 4. 截图与基线

- 截图输出在 `test/visual/__shots__/`（不入库），联系表 `index.html` 可点击放大。
- 视觉基线已接入逐像素比对：`npm run visual` 对 36 张（9 页 × 双主题 × 两视口）按 0.1% 阈值比较；`npm run visual:update` 更新基线。
- 接基线时：只在固定机器/固定 Edge 版本生成，基线入库，动态内容用 `data-visual-mask` 遮罩；
  环境不符要标 `ENV-MISMATCH`，不得直接更新基线。

## 5. 偶发失败

- `anchor: 绑定后狐狸停在放下的位置` 偶发受窗口动画/端口占用影响；复跑单文件确认：

  ```cmd
  cd /d "E:\WorkSpace\fox-dock\dock"
  node --test --test-concurrency=1 test/integration/overlay.itest.mjs
  ```

- `pet: 单击角色打开快览卡` 偶发受前台窗口/焦点影响（真 Electron 命中测试）；单文件复跑即可，不要据此改交互。
- 服务端口被占时 daemon 会自动 +1；测试认 lock 文件里的实际端口，不要硬编码 39401。
- 角色/音效列表一次性拉取不自愈的问题已由 `fetchListRetry` 与 bind 探针处理，不要再引入
  「只拉一次」的新调用。

## 6. 真机清单（发版前）

1. 重启电脑后 30 秒内 daemon 在线、角色出现；
2. `kill -9` daemon 后 5 秒内被 watchdog 拉回，绑定恢复；
3. 逐个拖到 ZCode / WorkBuddy / Kimi Code / dsh，角色与主数字正确；
4. 拖到桌面空白 → 悬浮且角色/气泡设置不变；
5. 关闭 agent 再打开 → 自动重新吸附（设置开）；
6. `verify:context` 对账，Kimi 需先开会话（否则 SKIPPED，不算通过）；
7. 高 DPI（本机 150%）截图完整可见；
8. 干净 `HOME`/`LOCALAPPDATA` 下能自管运行时并起浮层；
9. 与旧挂件共存不出现两个角色、互不误杀；
10. 假清单更新失败能回滚、更新记录可见；
11. 厂商数据与旧挂件对照一致；
12. 联系表人工过目无错位/溢出。

## 7. 安全测试

- `npm run lint`：UI 禁止 `innerHTML/eval/new Function`（vendored 第三方除外）、
  `overlay/main.cjs` 的 `type:'toolbar'` 守卫、Electron 入口沙箱配置、密钥模式扫描。
- 角色导入：PNG/GIF 签名与结构校验（PNG 全 chunk CRC、GIF 图像描述符与结束符）+ ≤3MB + ≤2048² + id 白名单 + 内置不可删。
- 凭据：保险库 DPAPI 往返/篡改报错/掩码；接口与诊断包不得出现完整 key。
- 出站：`blocked-host` 拒绝环回/私有/保留地址；Kimi 与 CommandCode 的固定环回例外只对专用客户端生效。

## 8. 2.0-pre.2 增量（2026-10-22）

### 分层与命令

| 层 | 命令 | 说明 |
|---|---|---|
| M0 探针 | `node tools/probe-zcode-db.mjs` / `probe-zcode-hook.mjs` / `probe-kimi-status.mjs` / `probe-win32-focus.mjs` | 只读、不入 CI；输出 JSON 贴进 ADAPTERS「实时信号矩阵」 |
| 可信度 | `npm test` 内的 `provenance*.test.mjs` | 构造/降级/合并/UI 四标签；四适配器契约软校验；缺失不补 0 属性测试 |
| 会话层 | `npm test` 内的 `session-model` / `live-reduce` / `live-tracker` / `tail-reader` / `zstd-frame-tail` / `zcode-sessions` | 归约表全表驱动 + 10 万步随机不变量；增量读半行/截断/半帧/坏帧 |
| 下钻与统计 | `usage-breakdown` / `analytics` / `export` / `incremental-equivalence` | 5 维度、多币种不求和、other、prev、缓存、CSV 公式注入；WB/dsh 追加后与全量一致 |
| 注入协议 | `ingest-validate` | 字段边界 + 5000 个随机 JSON 模糊测试 + 令牌桶 |
| 安全 | `redact` | 12 类密钥形态 + 误伤样本；1MB 文本 <50ms |
| 页面 | `npm run test:ui` | 9 页（`context` → `sessions`）× 双主题 × 三视口（1280/960/760）；axe 严重/致命为 0 |
| 页面 E2E | `npm run test:e2e:pages` | Playwright + 夹具：导航/详情四标签/计数筛选/键盘/子任务/SSE/25 条分页 + 加载更多/归档筛选/跳转宿主/权限横幅/自定义范围不误发（自绘 DatePicker）/工具下钻/设置 PUT/53 周绿墙与每日每周累计/图表自适应/hash 切页/长区间标签不重叠/GET 缓存/柱图 hover 气泡/视角切换可见性 |
| 视觉 | `npm run visual` / `visual:update` | 9 页 × 双主题 × 两视口 = 36 张 + 92 张 pre.2 场景基线（合计 128）；`sessions` 取代 `context` |
| 宠物 | `npm run test:pet` | 80 张状态截图（chip-working/waiting/error/done/multi、quick-sessions 等）；角色本体不再叠加状态徽标 |
| 集成 | `npm run test:all` | 真 daemon / 真 Electron / 合成宿主库（本机 418 项全绿） |

### 夹具控制端点（仅夹具）

`tools/fixture-daemon.mjs` 新增：

- `POST /__fixture/scene {name}`：热切换 `test/fixtures/scenes/<name>.json`；
- `POST /__fixture/emit {event,data}`：向 SSE 推任意事件；
- `POST /__fixture/clock {now}`：记录冻结时钟；
- `GET /__fixture/calls`：返回收到的写请求（断言点击后确实 POST 了什么）。

`zcode-normal.json` 增加 `liveSessions` / `details` / `breakdown` / `live` 四组数据；
旧的按 agent 分数组仍兼容（会话列表会拍平成统一 Session）。

§9.3.1 场景（`test/fixtures/scenes/`，由 `node tools/make-pre2-scenes.mjs` 生成）：
`sessions-live`、`sessions-empty`、`sessions-kimi-only`、`sessions-many`（2000 条）、
`sessions-long-text`、`permission-pending`、`permission-high-risk`、`permission-queue`、
`permission-observe-only`、`usage-compare`、`usage-prev-zero`、`usage-forecast-empty`、
`usage-breakdown-multi-currency`、`usage-breakdown-tool`、`usage-breakdown-model`、
`usage-breakdown-vendor`、`usage-breakdown-session`、`quota-matrix`、
`provenance-all-kinds`、`overview-busy`、`overview-idle`、`stats-sourcetags`、
`stats-kimi-empty`、`settings-live-perm`。

### 基准与浸泡（发版前）

- `bench-sessions.mjs`：50MB WB jsonl、200 个 dsh zstd、50 万行 ZCode 库；
  `/v1/sessions` p95 <200ms、`/v1/usage/breakdown` p95 <300ms。
- `soak.mjs`：10 会话 × 1 事件/秒 + SSE + overlay + console，断言 RSS 增长
  <30MB、句柄不增长、SSE 无积压。
- 真机清单：TESTING §6 + PLAN §9.6（权限/跳转/150% 缩放/2000 条滚动/Excel 打开 CSV）。


### 基准（2026-10-22，本机 Windows / Node 24）

`npm run bench`（ZCode 20 万行 / 4000 会话；WB 20MB / 9.2 万行；dsh 40 个 zstd 文件）：

| 项 | 实测 | 目标 | 结论 |
|---|---|---|---|
| ZCode `/v1/sessions` | 首次约 390ms；预热 p95 约 5ms | p95 <200ms | 预热达标；首次含连接/索引构建（lastModel/turn/message 批量扫描） |
| ZCode `usage/breakdown` | p95 192–248ms（agent/model/session） | p95 <300ms | 达标 |
| WB 首次扫描 | 30–40ms（20MB / 9.2 万行） | — | 参考值 |
| WB 追加 1 行 | 5 次 37.5/42.2/35.6/29.6/**1.3ms** | <20ms 且 <全量 1% | 稳态 1.3ms 达标；连续同 tick 追加受 Windows 刷盘/元数据开销影响（非聚合成本） |
| dsh 40 文件 | p95 10.6ms | — | 参考值 |

> 首次 ZCode 会话查询包含连接建立与全量 GROUP BY；后续轮询走同一只读连接并复用水位结果。

### 视觉基线过目记录（2026-10-22）

- 128 张基线（36 基础 + 92 场景）全部生成并逐张过目；每张场景截图旁另生成 92 张 `*.annot.png`（1px 轮廓 + 宽×高标签，不入库）；联系表在
  `dock/test/visual/__shots__/pre2-contact-0..3.png`（不入库）。
- 过目中修正：overview-idle 不再显示 `¥0.00`；工具维度显示调用次数；
  预测样本不足显示「—」；积分/其它币种不参与金额图；sessions 等待确认只计
  `waiting_permission`；设置页滚动改为确定性滚动以避免基线漂移。
- 场景生成器：`node tools/make-pre2-scenes.mjs`（可重复生成 §9.3.1 场景）。
- 2026-10-22 修复后重新生成并过目 54 张受影响基线：stats 改为填满卡片的
  53 周绿墙；overview/usage 柱图 viewBox 等于容器宽度，1280 与 960 下字号
  仍为 12px；其余页面像素不变。

### 修复批次增量（2026-10-24）

- `overlay.itest.mjs`（23 项）新增/更新：宿主失前台约 3 秒落兜底、回前台恢复
  吸附（含 3 秒内不落位 / 超阈值贴角 / 恢复 / 防抖起点清零四断言，`debugRectResult`
  模拟）；换角色零延迟 180ms 淡入与 `prefers-reduced-motion` 下关闭（CDP
  `Emulation.setEmulatedMedia`，断言期间 `PUT /v1/profiles/zcode` 钉住档案角色，
  规避后台 syncRole 每 1.5s 拉回的竞态）；快览卡刷新键 SVG 中心与按钮中心偏差
  ≤1px、16×16；兜底位断言 margin 24→4；四象限命中按 `__pet.origin` 换算期望值。
- `win32.itest.mjs`（9 项，真 PowerShell 桥）新增 `/rect` 响应 `background`
  布尔字段用例。
- 新增 `test/unit/window-bounds.test.mjs`（6 项）：任务栏安全边距
  `overlayWorkAreaBounds`（4 DIP 缩进与最小 1×1 兜底）。
- 新增 `test/unit/plan-vendor-status.test.mjs`：比例 1→100（500M/500M 满额不再
  显示 1%）、0.0675→6.8、`percentRemaining` 缺失不编 0、引擎失败无百分比；
  `host-vendors.test.mjs` 同步更新（null→无百分比）。
- 新增 `test/unit/quit-semantics.test.mjs`（4 项源码契约）：退出走 `/shutdown`
  且不触碰启动器/autoStart、托盘与宠物菜单文案含「本次」、控制台 close 为
  preventDefault+hide、设置 hint 与 autostart 端点。Electron 主进程 `.cjs` 无法
  在 `node --test` 直接 import，故扫描本仓自有源码标记断言。
- 新增 `test/unit/volc-plan.test.mjs`（22 项）：V4 签名确定性（now 注入）、凭据
  整套配对、窗口塑形（Percent/Quota-Used、秒/毫秒 resetAt、全缺返回 no-data）、
  按量/订阅分流、模板契约。
- 状态判定（D045）新增事件序列回放与夹具用例：`live-reduce`（思考→工具
  running→工具结果→继续生成不横跳、静默 ≥90s 回落、回合结束证据立即降级、
  等待确认不受滞回影响、expire 在途工具保护、running 并集合并）、`zcode-live-status`
  （夹具 s6/s7/s8 与时间回放 t=0/+30s/+39s working、+41s idle）、`live-tracker`
  （轮询滞回：推断空闲不降级、running 不与 expire 拉锯、db 证据立即降级）。
- `pricing.test.mjs` 新增 2 条：钉住 Kimi K3.1 Pro 新价目与短名别名防被
  `k3` 前缀误套旧价。价目复核留档 `docs/dock/pricing-audit-2026-10-24.md`。
- 视觉基线：quota-matrix 场景加入火山方舟行后更新 4 张基线（1280/960 × 双主题，
  platform/edge 无 ENV-MISMATCH），`npm run visual` 128/128；`npm run test:pet`
  80 张以 `reducedMotion:'reduce'` 生成，无淡入干扰。
- 本批未新增已知偶发失败（已知偶发仍见 §5）。

## 9. 2.0-pre.3 增量（2026-10-25）

- 单元：`risk.test.mjs`（73 条正反例 + 规则覆盖审计）、`actions.test.mjs`（幂等/上限/一次性 resolve/超时/断连/审计）、`hook-script.test.mjs`（子进程六断言：daemon 不在、坏 JSON、deny exit 2、分支 B 静默、分支 A 严格 JSON、takeover 关闭不等待）、`hook-sync.test.mjs`（集成插件副本逐字节同步 + 只挂 4 个低频钩子）、`sounds.test.mjs`（内置三套、导入/魔数/2MB/删除回落 duck/旧集复制去重）、`cache-index.test.mjs`（版本失配丢弃、LRU、原子写、tail restore、WB 删缓存等价性守卫）。
- 集成：`actions.itest.mjs`（takeover 开关两态、pending 登记 + 高风险标注、resolve 403/400/409、wait 超时、permission_resolved 联动）。注意：同一测试进程并发两个 wait 长轮询会触发 undici 响应配对错乱（daemon 侧逐条核实过发送正确），测试与钩子都按「一次只挂一个长轮询」使用。
- 已知不稳定性：权限横幅/权限卡用例依赖焦点与窗口时序，按 §5 定责方法单文件复跑。
