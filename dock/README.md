# fox-dock 2.0 · 通用桌宠

一只常驻桌面的角色，认识 ZCode、WorkBuddy、Kimi Code 与 DeepSeek Harness（dsh）四个 agent。
把它拖到某个 agent 窗口上松手：自动识别宿主、吸附到窗口边缘、换成该宿主的角色，并把数字切成
该宿主的余额 / 额度 / 今日消耗口径。

**状态：2.0.0-pre.1。** 已有：Win32 窗口桥 + doctor、常驻服务（单实例 / 健康检查 / 令牌停止）、
watchdog、登录启动器、`fox-dock ensure` 幂等拉起、透明浮层「拖动 → 命中 → 绑定 → 吸附 → 跟随」、
声明式适配器框架（不跑第三方 JS）、四宿主真实计费与**上下文统计**、统一账本与跨 agent 汇总、
内置厂商引擎（45 个模板）与 DPAPI 凭据保险库、`/v1` API + SSE、独立控制台窗口、六个内置角色。

### 控制台

托盘菜单「打开控制台」、全局热键 `Ctrl+Alt+D`，或命令行 `node tools/fox-dock.mjs` 之后从托盘打开。
控制台是与宠物层分开的可聚焦窗口：

- **总览**：当前 agent 的主数字、上下文环、上一轮、今日 tokens、7 天用量、额度窗口、全部 agent 对比。
- **上下文**：会话选择、占用环、最近一次请求构成、触顶估算、压缩记录、趋势图、最近会话。
- **用量**：今日 / 7 天 / 30 天 × 按 Agent/厂商/模型 × 金额/Token，排名、搜索、CSV/JSON 导出。
- **额度与余额**：单窗口大字百分比、多窗口进度条、余额卡、套餐卡；全部厂商卡片与筛选排序。
- **厂商与密钥**：45 个内置模板、掩码密钥状态、配置/测试/删除、从宿主导入。
- **角色与气泡**：六个内置角色、强调色、气泡开关与停留、台词间隔、气泡模板 JSON。
- **设置**：主题、吸附、气泡与提醒、主数字口径、启动与更新、数据与隐私。
- **关于与诊断**：版本、运行信息、适配器能力、绑定、更新检查、复制/导出诊断包。

控制台只通过主进程访问 daemon（`contextIsolation` + `sandbox`），令牌不会进入渲染层。

## 适配器

| id | 识别 | 主数字 | 数据源 |
|---|---|---|---|
| `zcode` | `ZCode.exe` | 今日金额（多币种不混加）、上一轮 | `~/.zcode/cli/db/db.sqlite` 的 `model_usage` |
| `workbuddy` | `WorkBuddy.exe` | 今日积分、上一轮 | `~/.workbuddy/projects/**/*.jsonl` 的 `rawUsage.credit` |
| `kimi` | `Kimi Code.exe` | 套餐窗口剩余百分比；Free 账号显示套餐卡；有加油包时显示余额 | `~/.kimi-code/credentials/kimi-code.json` + `/coding/v1/usages`、`/me` |
| `dsh` | `DeepSeek Harness.exe` | DeepSeek 余额 + 今日/上一轮 token 用量 | `~/.dsh/.credentials.yaml` + `~/.dsh/sessions/**/*.jsonl.zstd` |
| `generic` | 兜底 | 不支持（只吸附与跟随，不猜数字） | — |

口径与两条挂件线**逐日对齐**，用 `npm run verify:zcode` / `npm run verify:workbuddy` 现场对账
（ZCode 用挂件线源码算基准；WorkBuddy 用新进程重算，避开运行中服务的 30s 缓存）。
上下文统计用 `npm run verify:context` 对账；读不到就显示「暂无」，绝不补 0：

| 宿主 | used 口径 | 上限来源 |
|---|---|---|
| ZCode | 主会话最后一条 completed 的 `computed_total_tokens` | `zcode-builtin.json` → `cc-models.txt` → `litellm.json` → 200k |
| WorkBuddy | `session_usage.used`（最后请求的 prompt_tokens） | `session_usage.size`，缺失回落 `sessions.context_window` |
| Kimi Code | 本地服务 `/sessions/:id/status` 的 `context_tokens` | `max_context_tokens`，兜底 `config.toml` |
| dsh | 最近一次 usage 的 `totalTokens` | `request/context.contextWindow`，兜底 `cordis.patch.yml` |

Kimi Code 的 OAuth access token 只有 15 分钟；挂件会在过期时按宿主同款流程刷新并原子写回
凭据文件，不额外保存密钥。dsh 的会话日志是多帧 zstd，挂件逐帧解压；上一轮优先主会话，
今日总额包含 subagent 调用。

厂商引擎已内置（`dock/engines/`），不再依赖挂件线服务在跑；凭据优先级是
环境变量 → DPAPI 保险库 → 宿主发现 → 旧挂件配置（只读导入）。密钥只以掩码出现在界面、
日志与诊断包里。旧挂件的 `vendorKeys` 可在控制台「厂商与密钥 → 查看并导入」一次性复制进保险库。


## 与现有挂件的关系

- 同一个 git 仓库，独立分支 `feat/dock` 与独立 worktree（`E:\WorkSpace\fox-dock`）。
- 现有 `lib/`、`desktop/`、`hooks/` 在本分支上**不改动**；新代码全部在 `dock/`。
- 2.0 是通用桌宠线，发布 tag `dock-v*`，与 ZCode/WB 两条挂件线互不影响。

## 直接试（不用命令行）

打开 `dock\launch\`：

| 文件 | 作用 |
|---|---|
| **启动 fox-dock.vbs** | 双击：后台服务 + 浮层一起起来，不闪黑框 |
| **停止 fox-dock.vbs** | 双击：两个一起收掉 |
| status.cmd | 看是否在跑（端口、浮层 pid） |

启动失败会弹一个框，日志在 `launch\last-start.log`。

刚开始的 10 秒可以这么试：

1. 桌面上出现角色（默认嘎啦嘛，右下角）；右上角会提示「检测到 N 个 agent」
2. 把角色拖到 WorkBuddy 窗口上松手 → 吸到窗口边缘，角色换成小克，显示「今日 xxx 积分」
3. 拖到 ZCode → 换成嘎啦嘛，显示「今日 ¥x.xx」；拖到 Kimi Code → kimi 娘 + 套餐卡；
   拖到 DeepSeek Harness → 大肥鱼 + DeepSeek 余额
4. 单击角色或右上角「⋯」→ 说一句话并打开面板。七个页签：
   - **总览**：宿主、今日 / 上一轮 / 余额、额度卡、账户、明细、7 天汇总、搜索、解绑
   - **额度**：单窗口数字百分比 / 多窗口进度条 / 余额卡 / Free 套餐说明
   - **厂商**：复用同机 ZCode / WorkBuddy 挂件线的全厂商余额与套餐（DeepSeek、GLM Plan、
     CommandCode、Kimi/MiniMax/OpenCode 订阅、OpenRouter 等），未配置模板可展开
   - **用量**：跨 agent 的今日与 7 天记录、绑定管理
   - **角色**：六个立绘、点一下换角色、按宿主单独指定、让角色说一句
   - **设置**：主题、主数字口径、大小、跟随间隔、台词、气泡、预算/额度预警、桌宠模式、更新清单
   - **关于**：版本、数据目录、最近日志、复制诊断信息、检查更新
5. 设置里打开「桌宠模式」→ 不再吸附/跟随，角色可以随意摆在屏幕上
6. 关掉再启动 → 角色自己回到上次绑定的窗口（窗口还在的话）
7. 双击「停止」→ 角色消失，任务管理器里没有残留

> 只支持一块屏（默认光标所在那块）。跨屏拖动还没做，见 D011。

## 目录

```
dock/
  shared/      身份键等纯函数（无 Windows 依赖，可在任意平台跑）
  daemon/      常驻服务（Win32 桥 / 绑定 / 适配器 / 账本 / 窗口生命周期）
  adapters/    zcode / workbuddy / kimi / dsh / generic
  overlay/     Electron 浮层（六页签面板 + 角色 + 气泡）
  test/
    unit/      纯函数、适配器、设置、契约
    integration/ 真 HTTP + 假 agent + 真 Electron 拖拽
    e2e/       Playwright（Electron）
    visual/    截图基线 + 像素对比
docs/dock/     决策记录与计划（仓库根）
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
npm start        # 启动 watchdog + 浮层（加 --no-overlay 只起后台服务）
npm run status
npm run stop
npm run install-app  # 写登录启动项（默认到真实启动文件夹，可用 --startup-dir 覆盖）

node tools/fox-dock.mjs update --check    # 检查更新（默认清单在 feat/dock 分支的 docs/dock/update.json）
node tools/fox-dock.mjs update --apply    # 下载 + 校验 sha256 + 落盘（失败自动回滚）
node tools/fox-dock.mjs update --history  # 最近的更新记录

npm run keygen   # 生成发布密钥：私钥写到 %USERPROFILE%\fox-dock-release-key.pem，公钥入库
npm run pack -- --version 0.2.0-pre.1 --url <下载地址> --sign --notes "…"
                 # 打包 dist/dock-<version>.tar.gz 并生成、签名 docs/dock/update.json
npm run sign -- --version 0.2.0-pre.1 --package dist/dock-0.2.0-pre.1.tar.gz --url <下载地址>
                 # 只签名（包已经打好时用）
```

更新清单必须带 Ed25519 签名（`keys/update-pub.pem` 是公钥，私钥只在发布机上）。
`update --check` 默认验签，验不过直接拒绝；`--no-verify` 只给本地调试。

浮层「设置 → 更新清单地址」与「关于 → 检查更新」共用同一个 `/update/check`：
默认清单为空（还没发布 `dock-v*`），会明确提示「未配置更新源」；填入签名清单地址后
可以检查版本，真正落盘仍走 `update --apply`。自动检查只检查，不会自动替换文件。

浮层用法：**单击**狐狸打开明细面板（当前窗口数字 + 全部 agent 今日汇总 + 最近几天），
**拖动**狐狸到宿主窗口上松开即绑定；绑定后每 500ms 跟随窗口位置。

集成测试不进 CI：它需要真实的桌面会话（GitHub runner 的交互桌面行为不稳定），
CI 只跑单元测试；集成在本地/真机上跑。
