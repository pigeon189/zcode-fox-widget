# fox-dock 2.0 · 通用桌宠（预发布）

一只常驻桌面的角色，认识 **ZCode / WorkBuddy / Kimi Code / DeepSeek Harness（dsh）** 四个 agent。
把它拖到宿主窗口上松手，角色会吸附到窗口边缘、换成该宿主的形象，并把数字切换成对应的
余额 / 额度 / 今日消耗口径。

> 当前分支 `dock-pre` 是 2.0 预发布线，不是 `main` 的 1.x 挂件线。
> 发布只走 `dock-v*` GitHub prerelease，旧挂件不会收到这个版本。
> 完整的安装、功能与开发说明见 [dock/README.md](dock/README.md)。

## 快速开始

1. 从 [Releases](https://github.com/pigeon189/zcode-fox-widget/releases) 下载
   `dock-2.0.0-pre.1.tar.gz`，解压到独立目录（不要覆盖旧挂件目录）。
2. 双击 `launch\启动 fox-dock.vbs`，或执行：

   ```bat
   node tools\fox-dock.mjs start
   ```

3. 托盘菜单 / `Ctrl+Alt+D` 打开控制台；`Ctrl+Alt+F` 显示或隐藏角色。

## 文档

- [dock/README.md](dock/README.md)：安装、四宿主、宠物层与控制台
- [dock/CHANGELOG.md](dock/CHANGELOG.md)：2.0 变更记录
- [docs/dock/](docs/dock/)：适配器契约、决策记录、测试与 UI 规格
