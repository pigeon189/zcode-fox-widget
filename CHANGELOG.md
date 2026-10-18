# 更新日志（Changelog）

本文件只记 **WorkBuddy 线**（`fox-widget`）的用户可见变更，供速查；每条一句话，细节不在
这里展开（规则见 [CONTRIBUTING](./CONTRIBUTING.md) 的「文档归属」）。

> **2026-10-18 整理**：条目统一为「一句话、≤150 字」，版本标题统一 `## wb-vX.Y.Z <动词>：…`。

- 「为什么这么写 / 踩过的坑」→ [`docs/DECISIONS.md`](./docs/DECISIONS.md)（按主题）
- ZCode 线（`main`）v1.1.0–v1.11.1 的完整历史 → [`docs/CHANGELOG-ARCHIVE.md`](./docs/CHANGELOG-ARCHIVE.md)
- 移植期的实测档案 → [`docs/porting/`](./docs/porting/)

---

## 未发布

- **今日预算**：记账二级页新增「预算」，当日累计消耗达到该积分值时提醒一次（0 关闭）；与「余额¥」方向相反——一个盯账户见底、一个盯当天用超，两条各自去重。
- **余额构成**：配置了 DeepSeek key 时，余额接口返回的赠金 / 充值余额一并显示在记账页；字段缺失时整行隐藏。
- **用量搜索**：用量记录面板可按模型名 / 日期 / 时间过滤「近 7 天」与「最近轮次」，无命中时给提示；打字期间跳过 30 秒轮询重绘。

---

## wb-v1.3.2 修复：浮层主进程每次加载都弹 ReferenceError

- **浮层主进程弹「A JavaScript error occurred in the main process」**：上一版把 ZCode 线的浮层补丁 cherry-pick 过来时，函数名没跟着换（本线叫 `applyHostBounds`，补丁里写的是 `applyZCodeBounds`），`did-finish-load` 每次触发都抛 `ReferenceError`。改用本线的函数名，并加一条静态自检：`desktop/main.cjs` 里调用的 `apply*Bounds` 必须在本文件有定义。

---

## wb-v1.3.1 修复：浮层冷启动上屏、角色图错位、更新面板显示陈旧版本

- **浮层冷启动不上屏（#4，感谢 [@Edritc](https://github.com/Edritc)）**：跟随脚本的第一条消息常早于页面就绪（实测 0.3s vs 1–3s），被 `pageReady` 门控丢弃后没有补发的机会，宿主窗口静止时鲸鱼一直隐身。现在 `did-finish-l…
- **切换角色时立绘错一位**：保存有 300ms 去抖，换图却立刻发起，服务端按 `widget-state.roleId` 取到的是上一个角色。`/whale/image.png` 新增 `?role=<id>`，前端换图时带上 id。
- **更新面板显示「最新版本」比当前还旧**：状态文件可能是旧版本留下的，视图原样回放会出现「当前更新、最新更旧、还能立即更新」。现在按当前运行版本重判 `available` / `latest`。
- **哈基米换新版立绘**：白底按颜色重建边缘 alpha（发丝镂空保留、白衣服不被抠穿），内容 607×587、画布 610×610、右下贴齐，右耳与发尾不再被削。

---

## wb-v1.3.0 修复：主题跟随、深色档控件与启动健壮性

> 代码审查（I/S/X/P/C）与界面审查（P0–P2）两轮的修复；界面逐条结论见
> [`docs/reviews/2026-10-17-ui-review.md`](./docs/reviews/2026-10-17-ui-review.md)。

- 主题：「跟随 WorkBuddy」真正生效（判定函数读错变量，此前等于跟随系统）。
- 深色档控件：复选框可见（此前与面板底 1.09:1）、滑块与浅色档同构；菜单行高统一。
- 启动与平台：spawn 失败不再掀桌（补 `error` 监听 + node 预检）；macOS 浮层路径按平台，`focusable:false` 全平台生效。
- 自启预算收到钩子超时以内（最坏 15.8s → 约 9.2s）；钩子超时 15s → 20s。
- 启动加互斥锁；端口被自己占用时认亲退出，不再留下收不掉的孤儿服务。
- 安全：跨站 GET「白名单外默认拒绝」，`/whale/session.json` 不再漏网。
- 设置：保存失败会提示（此前 500 当成成功、重启后静默回滚）；保存去抖 + 串行化。
- 更新与性能：清单外文件运行时忽略；积分轮询 2.5s、故障 30s 退避、厂商余额 60s 缓存。
- 界面：金额「¥12.34」单一口径、tokens 千分位、气泡标题统一；点击目标 ≥24px、读屏名称。

## wb-v1.2.0 新增：中转站额度、7 天模型排名、角色切换收口

- 中转站额度：新增 10 家模板（PackyCode / DuckCoding / 云雾 / H API / UU / APINebula / LinkAI / 88Code / SSSAICode / Cubence）。
- 三种形态：按量站显示余额卡，单窗口站显示剩余百分比，Sub2API 三维度走额度卡。
- CommandCode：官方 API 与本地账号池也能显示额度；同账号两个 provider 按 key 去重。
- 用量记录：模型排名可切「按当天 / 按 7 天」，与「按积分 / 按 Token」互相独立。
- 换角色淡入：新立绘从低透明度浮入，切图不延迟；减少动态效果时不播放。
- GPT 娘立绘恢复原构图，去掉左缘白锯齿。
- 台词收口：「哦鲸鲸」只给大肥鱼；rua 动图只在大肥鱼 / 小克的出厂队列里。

> 取舍与排查：`docs/DECISIONS.md#relay-quota`、`#usage-rank`、`#role-fade`

## wb-v1.1.0 新增：哈基米、立绘规格统一、更新包签名

- 新内置角色「哈基米」（Gemini 族），按模型换角色对 Gemini 系生效，配色为彩色渐变。
- 六张内置立绘统一 610×610 画布（内容高一致、右/下贴边），切角色不再横向跳。
- 浅色主题下勾选对勾统一为白色。
- 菜单「关闭插件」= 本次关闭：看门狗本次不再拉回，下次宿主启动照常自启。
- 浮层更抗崩：每实例独立 Electron profile（不再抢 GPU 缓存锁互杀）；跟随脚本被信号杀掉会自动重挂。
- 自更新内核接入与 ZCode 线同一套签名校验（本线默认关闭）。

> 浮层与 profile：`docs/DECISIONS.md#overlay-window`

## wb-v1.0.1 修复：运行时装残检测与浮层重试闸门

- 运行时改三哨兵判定（可执行体 + ICU + v8 快照）：`desktop install` 中断后不再被当成可用。
- 看门狗去掉「连败 3 次就放弃」：浮层故障时会持续重试并如实上报，不再永久沉默。

> 判定细节：`docs/DECISIONS.md#runtime-sentinels`

## wb-v1.0.0 新增：移植到 WorkBuddy（积分口径 + 上下文余量）

> 基线 = ZCode 线 v1.11.1；本分支版本号另起序列。分阶段实测见 `docs/porting/`。

- 宿主接入换新：`.codebuddy-plugin/*` 清单、`.mcp.json`、`command` 型钩子、`${CODEBUDDY_PLUGIN_ROOT}` / `${CODEBUDDY_PLUGIN_DATA}`、插件名 `fox-widget`。
- 主口径改为订阅积分：每轮与今日合计读 `workbuddy.db` 的 `session_usage.credit_json` 与会话 transcript；余额/厂商卡降为可选附加。
- 新增「上下文余量」：读 `session_usage.used/size`，气泡与消耗气泡显示「上下文 xx%」。
- 每日用量改扫 transcript（按 `conversationRequestId` 归轮、按日汇总；60 文件 / 2MB 尾部上限，范围可诊断）。
- 主题跟随改读宿主 `preferences.json` + 浮层 DWM 观测（`lib/host-theme.mjs`）。
- 凭据发现改扫宿主 settings / 插件数据目录；新增宿主适配层 `lib/host.mjs`（宿主差异唯一落点）。
- 浮层：跟随目标改 `WorkBuddy`；移除「宿主就绪」门控（`desktop/ui-ready.cjs` 删除）；带入 `type:'toolbar'` 与跨线单例判定两项修复。
- 「等确认提醒」事件源换 `Notification`（默认关闭）；自更新默认关闭（推荐 `git pull` + 客户端重抓）；GLM Plan 配额冻结为不支持。

> 宿主契约与「别改清单」：`docs/DECISIONS.md#host-contract`、[`docs/MAINTAINING.md`](./docs/MAINTAINING.md)