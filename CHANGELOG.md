# 更新日志（Changelog）

本文件只记 **WorkBuddy 线**（`fox-widget`）的用户可见变更，供速查；每条一句话，细节不在
这里展开（规则见 [CONTRIBUTING](./CONTRIBUTING.md) 的「文档归属」）。

- 「为什么这么写 / 踩过的坑」→ [`docs/DECISIONS.md`](./docs/DECISIONS.md)（按主题）
- ZCode 线（`main`）v1.1.0–v1.11.1 的完整历史 → [`docs/CHANGELOG-ARCHIVE.md`](./docs/CHANGELOG-ARCHIVE.md)
- 移植期的实测档案 → [`docs/porting/`](./docs/porting/)

---

## 未发布

**代码审查修复（I/S/X/P/C 编号见报告）**

- spawn 失败不再掀桌：服务 / 浮层 / 更新重启全部补 `error` 监听 + node 可用性预检。
- 自启预算收到钩子超时以内（最坏 15.8s → 约 9.2s）；钩子超时 15s → 20s。
- 启动加互斥锁；端口被自己占用时认亲退出，不再产生收不掉的孤儿服务。
- 跨站防护改为「白名单外默认拒绝」，`/whale/session.json` 不再漏网。
- 设置保存失败会提示（此前 500 被当成成功、重启后静默回滚）；保存去抖 + 串行化。
- macOS 浮层可用（Electron 路径按平台）；`focusable:false` 全平台生效。
- 完整性清单外的文件运行时忽略（不再因一次漏签名卡住全体更新）；发布自检仍严格。
- 性能：每轮积分轮询 1s → 2.5s（故障 30s 退避）、厂商余额 60s 缓存、去掉全表扫。

**UI 审查修复（P0–P2 编号见 `docs/reviews/2026-10-17-ui-review.md`）**

- P0：「跟随 WorkBuddy」主题真正生效（判定函数读错变量，整条承诺此前失效）。
- P0：深色档复选框可见（此前未勾选态与面板底 1.09:1，三个开关等于消失）。
- P1：滑块/复选框两套主题统一形态；菜单行高统一 28px；记账页按钮行对齐。
- P1：金额「¥12.34」/「$12.34」单一口径；面板 tokens 全列千分位；积分到亿级走量纲。
- P1：消耗气泡标题统一为「本轮…」+ 全角冒号；超长数字可折行；长模型名省略 + title。
- P1：点角色只续时会有一次轻弹反馈（与 README 描述一致）。
- P2：点击目标 ≥24px；气泡小字对比度 ≥4.5:1；菜单补 `color`；面板改 border-box；
  字体栈统一；菜单按钮/复选框补读屏名称与焦点可见。

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
