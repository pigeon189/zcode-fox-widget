# fox-dock 变更记录

> 0.x 全部是预发布（tag `dock-v*`，`--prerelease`）。接口、数据格式、适配器契约都可能变。

## 0.1.0-pre.0（未发布）

第一版：从零到「拖到 agent 窗口上就能看到今日消耗」。

### 核心

- 常驻服务（`daemon/`）：单实例锁、令牌停止、只监听 127.0.0.1、数据目录 `%LOCALAPPDATA%\fox-dock`
- Win32 桥：常驻 PowerShell 助手，编译一次 C#，之后逐行收命令（snapshot / hit / cursor / rect / ping）；
  命中采样 0.13–0.19ms，200 次连续命中 95ms
- watchdog：异常退出 1s→30s 退避重启；正常停止一起退出；连续 8 次强杀都能拉起且绑定不丢
- 登录启动：启动文件夹 VBS（隐藏窗口），`install/uninstall`
- 浮层（Electron）：透明 + 置顶 + 全窗穿透，只有指针压在狐狸上才可交互

### 交互

- 拖动狐狸 → 高亮目标窗口 → 松手绑定 → 吸附到窗口右上角 → 500ms 跟随
- 单击狐狸 → 明细面板：当前窗口数字、窗口标题、全部 agent 今日汇总、最近几天、解绑
- 深色模式跟随系统

### 适配器

- 框架：声明式匹配（exe 基名 / 路径片段 / 标题片段 / 窗口类），不加载第三方 JS；
  返回值统一过 `normalizeSnapshot`（单位、币种、百分比、错误）
- `zcode`：读 `~/.zcode/cli/db/db.sqlite`，逐行按价目折算；价目内核与挂件线逐字节一致（`check:sync` 守护）
- `workbuddy`：扫 `~/.workbuddy/projects/**/*.jsonl` 的 `rawUsage.credit`；按请求归轮、按轮首事件归日
- `generic`：能绑定、能跟随，但明确显示「暂不支持计费」，不猜数字
- 对账工具：`verify:zcode` / `verify:workbuddy` 逐日比较金额/积分与 tokens

### 账本

- `ledger.json` 按 (日期, 适配器) 记今日累计；`unit|currency` 分组汇总，元/积分/币种绝不混算
- 保留 14 天；`GET /summary`

### 维护

- `GET /diag.json` + `fox-dock diag --out`：版本/适配器/绑定/账本/更新历史/最近日志，家目录脱敏
- 更新：清单 Ed25519 签名 + 包 sha256 + 逐文件备份 + 失败整批回滚；`update --check/--apply/--history`
- 打包：`npm run pack` 产出 `dist/dock-<version>.tar.gz` 并签名清单
- 测试：116 条（单测 86 + 集成 30）；真机 e2e 可把狐狸拖到真正的 ZCode / WorkBuddy 窗口上

### 已知限制

- 只支持一块屏（默认光标所在屏）；跨屏拖动不支持（D011）
- GLM 订阅用量按按量价显示（没移植账号套餐判定，D008）
- 更新包签名密钥在本机 `%USERPROFILE%\fox-dock-release-key.pem`，换密钥需重签
