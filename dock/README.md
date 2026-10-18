# fox-dock（工作名）· `feat/dock`

桌面常驻的多 agent 成本看板：把挂件拖到 agent 窗口上，自动识别、吸附、切到对应计费口径。

**状态：R8 完成。** 已有：Win32 窗口桥 + doctor、常驻服务（单实例 / 健康检查 / 令牌停止）、watchdog、登录启动器、透明浮层「拖动 → 命中 → 绑定 → 吸附 → 跟随」、适配器框架（声明式匹配，不跑第三方 JS）、ZCode（元）与 WorkBuddy（积分）两个真实计费适配器、统一账本与跨 agent 汇总、点狐狸打开明细面板。

## 适配器

| id | 识别 | 计费 | 数据源 |
|---|---|---|---|
| `zcode` | `ZCode.exe` | 今日金额（多币种不混加）、上一轮 | `~/.zcode/cli/db/db.sqlite` 的 `model_usage` |
| `workbuddy` | `WorkBuddy.exe` | 今日积分、上一轮 | `~/.workbuddy/projects/**/*.jsonl` 的 `rawUsage.credit` |
| `generic` | 兜底 | 不支持（只吸附与跟随，不猜数字） | — |

口径与两条挂件线**逐日对齐**，用 `npm run verify:zcode` / `npm run verify:workbuddy` 现场对账
（ZCode 用挂件线源码算基准；WorkBuddy 用新进程重算，避开运行中服务的 30s 缓存）。

已知差异：GLM 订阅修正（要读账号套餐事实）没有移植，GLM 订阅用量会按按量价显示金额，
见 `docs/dock/DECISIONS.md` 的 D008。


## 与现有挂件的关系

- 同一个 git 仓库，独立分支 `feat/dock` 与独立 worktree（`E:\WorkSpace\fox-dock`）。
- 现有 `lib/`、`desktop/`、`hooks/` 在本分支上**不改动**；新代码全部在 `dock/`。
- 发布通道独立：tag `dock-v*`，1.0 之前全部是 pre-release。

## 目录

```
dock/
  shared/      身份键等纯函数（无 Windows 依赖，可在任意平台跑）
  daemon/      常驻服务（R1 起：Win32 桥 / 绑定 / 适配器 / 账本）
  adapters/    zcode / workbuddy / generic
  overlay/     Electron 浮层
  test/
    unit/      纯函数测试（CI 必跑）
    integration/ 真 HTTP + 假 agent
    e2e/       Playwright（Electron）
    visual/    截图基线 + 像素对比
docs/dock/     决策记录与计划
```

## 本地命令

```bash
cd dock
npm run check          # 语法检查
npm run check:sync     # 价目内核与挂件线是否逐字节一致
npm test               # 单元测试
npm run test:it        # 集成测试（真实窗口 + 真服务 + watchdog + 浮层拖拽，需要桌面会话与 Electron）
npm run test:all       # 全部

npm run verify:zcode      # 与 ZCode 挂件线源码逐日对账（今日 + 近 7 天）
npm run verify:workbuddy  # 与 WorkBuddy 挂件线逐日对账（新进程重算，避开缓存）
npm run e2e:real          # 真机端到端：把狐狸拖到真正的 ZCode / WorkBuddy 窗口上（不代替人工）

npm run doctor   # 打印当前桌面窗口、命中的窗口与识别到的适配器（不启动服务）
npm run adapters # 列出内置适配器与匹配规则
npm start        # 启动 watchdog（后台常驻）
npm run status
npm run stop
npm run install-app  # 写登录启动项（默认到真实启动文件夹，可用 --startup-dir 覆盖）

node tools/fox-dock.mjs update --check    # 检查更新（默认清单在 feat/dock 分支的 docs/dock/update.json）
node tools/fox-dock.mjs update --apply    # 下载 + 校验 sha256 + 落盘（失败自动回滚）
node tools/fox-dock.mjs update --history  # 最近的更新记录
```

浮层用法：**单击**狐狸打开明细面板（当前窗口数字 + 全部 agent 今日汇总 + 最近几天），
**拖动**狐狸到宿主窗口上松开即绑定；绑定后每 500ms 跟随窗口位置。

集成测试不进 CI：它需要真实的桌面会话（GitHub runner 的交互桌面行为不稳定），
CI 只跑单元测试；集成在本地/真机上跑。
