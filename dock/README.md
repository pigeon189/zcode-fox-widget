# fox-dock 2.0 · 通用桌宠

一只常驻桌面的角色，认识 **ZCode / WorkBuddy / Kimi Code / DeepSeek Harness（dsh）** 四个 agent。
把它拖到宿主窗口上松手，角色会吸附到窗口边缘、换成该宿主的形象，并把数字切换成对应的
余额 / 额度 / 今日消耗口径。

> **当前版本：2.0.0-pre.1（预发布）**
> 发布 tag 为 `dock-v*`，只走 GitHub prerelease + 独立分支 `dock-pre`。
> 与 ZCode / WorkBuddy 两条旧挂件线完全隔离：旧挂件只读 `main` 的 `plugin.json`
> 和 `v*` 正式 release，**不会收到这个版本**。不要把本包覆盖安装到旧挂件目录。

## 安装

需要 Windows 10/11、Node.js 22.5+；Electron 运行时可复用已安装的挂件运行时。

1. 从 [Releases](https://github.com/pigeon189/zcode-fox-widget/releases) 下载
   `dock-2.0.0-pre.1.tar.gz` 并解压。
2. 进入解压后的目录，双击 `launch\启动 fox-dock.vbs`；
   或执行：

   ```bat
   node tools\fox-dock.mjs start
   ```

3. 托盘菜单 / `Ctrl+Alt+D` 打开控制台；`Ctrl+Alt+F` 显示或隐藏角色。

首次启动会在 `%LOCALAPPDATA%\fox-dock` 建立数据目录。停止用
`launch\停止 fox-dock.vbs` 或 `node tools\fox-dock.mjs stop`。

## 能做什么

- **四宿主吸附**：只识别四个 agent 窗口；拖到桌面、QQ 或其它应用上会留在桌面，不会误绑。
  支持窗口四角/边缘吸附和窗口内自由位置，贴左侧自动镜像。
- **角色与气泡**：六个内置角色、导入 PNG / JPEG / WebP / GIF；单击角色打开快览卡，
  右键打开菜单；气泡、台词、按压队列、隐藏金额、勿扰都可在控制台调整。
- **控制台八页**：总览、上下文、用量、额度与余额、厂商与密钥、角色与气泡、设置、关于与诊断。
- **多厂商余额**：内置 45 个厂商/订阅/中转站模板。当前 provider 的余额、CommandCode
  月度/5 小时/周窗口、GLM Plan、DeepSeek、Kimi 等都能读取；旧账户的 GOAT 额度会标注「老账户」。
- **上下文统计**：四宿主读取当前会话占用、上限、请求构成、压缩记录与趋势；读不到就显示
  「暂无」，不补 0。
- **安全**：API Key 存 Windows DPAPI 保险库，只显示掩码；宿主数据默认只读；`/v1` 写接口
  需要本机令牌；角色导入有签名/结构/尺寸校验；更新清单必须通过 Ed25519 验签。
- **与旧挂件共存**：ZCode / WorkBuddy 插件在 dock 在线时让出浮层并转发轮事件；可从旧挂件
  导入角色、气泡、账本、外观与厂商凭据。
- **独立更新**：只跟随 `dock-pre` 分支的签名清单，校验 sha256，落盘失败自动回滚；
  旧挂件不会读取这个清单。

## 四个宿主

| 宿主 | 识别 | 主数字 | 数据源 |
|---|---|---|---|
| ZCode | `ZCode.exe` | 今日金额 / 当前 provider 余额 | `~/.zcode/cli/db/db.sqlite` 的 `model_usage` |
| WorkBuddy | `WorkBuddy.exe` | 今日积分 | `~/.workbuddy/projects/**/*.jsonl` |
| Kimi Code | `Kimi Code.exe` | 套餐窗口 / 余额 | `~/.kimi-code` OAuth + `/coding/v1/usages` |
| DeepSeek Harness | `DeepSeek Harness.exe` | DeepSeek 余额 + token 用量 | `~/.dsh` 凭据 + 多帧 zstd 会话 |

Kimi Code 的 access token 只有 15 分钟，过期时按宿主同款流程刷新并原子写回；
这是唯一会写回宿主数据的例外。

## 宠物层怎么用

- **拖动**到宿主窗口：吸附到最近的四角/边缘；窗口中间松手则保留相对位置。
- **拖到桌面空白**：进入悬浮，保留上一个 agent 的角色和余额口径。
- **单击角色**：说一句并打开快览卡；再点角色不会关掉卡片，点外部关闭。
- **右键角色 / 右上角「⋯」**：打开菜单，只有一个「吸附到 agent 窗口」总开关。
- 小胶囊显示宿主名与主数字；打开快览卡时胶囊收起，快览卡灰色副标题显示当前厂商。

只支持一块屏（默认光标所在屏幕）；跨屏拖动尚未支持。

## 更新

本线只跟随 `dock-pre` 分支的签名清单：

```text
https://raw.githubusercontent.com/pigeon189/zcode-fox-widget/dock-pre/docs/dock/update.json
```

```bat
node tools\fox-dock.mjs update --check
node tools\fox-dock.mjs update --apply
node tools\fox-dock.mjs update --history
```

默认验签（`keys/update-pub.pem`），校验 sha256，落盘失败自动回滚。旧挂件不会读这个清单。

## 开发与测试

```bat
cd dock
npm run check          :: 语法检查
npm run check:sync     :: 引擎副本与挂件线逐字节一致
npm test               :: 单元测试
npm run test:it        :: 集成测试（真窗口 + daemon + Electron）
npm run test:all       :: 全部
npm run test:ui        :: 控制台布局 / 可访问名称 / axe
npm run visual         :: 32 张控制台视觉基线
npm run test:pet       :: 48 张宠物层截图
npm run test:electron:console
npm run doctor         :: 查看当前窗口与适配器命中
npm run start / stop / status / install-app
```

目录：`daemon/` 常驻服务；`adapters/` 四宿主；`overlay/` 宠物层；`ui/` + `console/`
控制台；`engines/` 厂商/计价；`test/` 单测、集成、视觉基线。

## 文档

- [变更记录](./CHANGELOG.md)
- [决策记录](../docs/dock/DECISIONS.md)
- [适配器契约](../docs/dock/ADAPTERS.md)
- [测试说明](../docs/dock/TESTING.md)
- [UI 规格](../docs/dock/UI-SPEC.md)
- [迁移说明](../docs/dock/MIGRATION.md)
