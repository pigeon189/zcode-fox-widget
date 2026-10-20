**新增**：独立桌宠 fox-dock 2.0，一只角色同时认识 ZCode、WorkBuddy、Kimi Code 与 DeepSeek Harness。

## 主要变更

- 四宿主吸附：拖到宿主窗口四角/边缘或窗口内自由位置，角色与余额口径随宿主切换；拖到桌面进入悬浮并保留上一个 agent 的档案
- 宠物层 2.0：角色 + 状态胶囊 + 320px 快览卡 + 右键菜单，贴左镜像，吸附统一为一个总开关
- 独立控制台：总览、上下文、用量、额度与余额、厂商与密钥、角色与气泡、设置、关于与诊断八页；下拉与复选框改为自绘
- 多厂商余额：45 个厂商/订阅/中转站模板内置，不再依赖旧挂件服务；CommandCode 三重额度、GLM Plan、DeepSeek、Kimi 等直接读取
- 上下文统计：四宿主当前会话占用、上限、请求构成、压缩记录与趋势；读不到显示「暂无」，不补 0
- 角色导入：PNG / JPEG / WebP / GIF，JPEG/WebP 在控制台转 PNG，GIF 保留动画；导入角色可保存到档案
- 安全与接口：API Key 走 Windows DPAPI 保险库，只显示掩码；`/v1` API + SSE，写接口需要本机令牌，读接口校验环回 Host
- 共存与隔离：旧挂件在 dock 在线时让出浮层并转发轮事件；本线只走 `dock-pre` 分支的签名清单与 `dock-v*` 预发布，旧挂件不会收到
- 其他：托盘与全局热键、开机自启、自管 Electron 运行时、按 agent 的 schema 2 设置、用量 7/30 天与 CSV/JSON 导出、预算与余额/上下文预警

## 升级

- 下载 `dock-2.0.0-pre.1.tar.gz`，解压到独立目录（不要覆盖旧挂件安装目录）
- 双击 `launch\启动 fox-dock.vbs`，或执行 `node tools\fox-dock.mjs start`；托盘菜单 / `Ctrl+Alt+D` 打开控制台
- 之后更新：`node tools\fox-dock.mjs update --check` → `node tools\fox-dock.mjs update --apply`，重启后生效，失败自动回滚
- 旧挂件线仍留在 `main` 与 `v*` 正式 release；本版为 prerelease，`--latest=false`，不会被旧挂件读取

完整更新日志见 [CHANGELOG](https://github.com/pigeon189/zcode-fox-widget/blob/dock-v2.0.0-pre.1/dock/CHANGELOG.md)。
