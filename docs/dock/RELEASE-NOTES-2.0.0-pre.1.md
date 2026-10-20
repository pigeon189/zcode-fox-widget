# dock-v2.0.0-pre.1

**预发布**：通用桌宠 fox-dock 的首个可安装测试版。整合了本地 pre.1 → pre.3 的迭代内容，
对外只保留这一个预发布版本；独立于 ZCode / WorkBuddy 两条旧挂件线。本次验证四宿主吸附、
余额与上下文，以及独立控制台和宠物层；不要把本包覆盖安装到旧挂件目录。

## 修复

- **吸附恢复**：最上层判定跳过 TabTip / Windows 输入体验 / NVIDIA 等输入法与驱动辅助窗，
  不再被它们挡住宿主；只吸附四个宿主 exe（ZCode / WorkBuddy / Kimi Code / DeepSeek Harness）。
- **菜单贴底自适应**：右键菜单按最终高度限高并重排，角色在屏幕下方时菜单项不再越出屏幕。
- **按压/松开音效**：两条音轨分工；短按松手时松开音等按下音播到剩 100ms 再起播，
  长按松手立刻补播，既不会两个音从头叠在一起，也不会快按时只剩按下音。
- **对话中切换厂商**：ZCode 当前厂商按最近一次已完成的模型调用判定。回合进行中
  `turn_usage` 还没有 completed 行，但新厂商的首次调用已经写入 `model_usage`；
  余额卡不再等到回合结束才从 CommandCode 切到 DeepSeek 等新厂商。
- **本轮花费气泡**：只在新回合完成时弹一次，不再随今日金额变化反复重弹；
  点击气泡直接关闭，不再被按压队列截走；5 秒自动收起。
- **上下文页会话选择**改用自绘下拉；用量页零值不再画 1px 假柱，并为预付池金额 0 增加口径提示。
- **审查 P2**：导入角色可持久化到档案；GOAT 新账户默认 $80、老账户按 createdAt/priceId 保留 $70；
  `FOX_DOCK_DATA` 统一为完整数据目录，自身 runtime-env 兜底生效。

## 主要变更

- **通用桌宠**：一只角色认识四个 agent。拖到宿主窗口上吸附，窗口四角/边缘/中间自由位置都与
  旧挂件一致；拖到桌面进入悬浮并保留上一个 agent 的档案。
- **宠物层 2.0**：状态胶囊、320px 快览卡、右键菜单、四象限镜像；小胶囊与角色底边齐平，
  打开快览卡时收起；快览卡灰色副标题显示当前厂商（如 `CommandCode · GOAT`），
  5 小时 / 本周 / 月度池三档并列。
- **控制台八页**：总览、上下文、用量、额度与余额、厂商与密钥、角色与气泡、设置、关于与诊断。
  自绘下拉与复选框，设置分组导航只滚内容区；窗口图标与标题栏按钮区跟随主题。
- **当前厂商余额**：按最近一次真实调用（回合进行中也生效）的 provider 选择余额/套餐；
  CommandCode 月度池、5 小时/周窗口、DeepSeek/GLM Plan/Kimi 等并列展示；
  旧 GOAT 账户保留 $70 并标注「老账户」。
- **角色导入**：PNG / JPEG / WebP / GIF；JPEG/WebP 在控制台转 PNG，GIF 保留动画；
  导入后的角色可以保存到档案并立即在浮层生效。
- **安全与更新**：DPAPI 凭据保险库、`/v1` 写接口令牌与 Host 校验、角色签名/结构/尺寸校验、
  更新清单 Ed25519 验签 + sha256 + 失败回滚；只读宿主数据（Kimi OAuth 刷新写回为唯一例外）。
- **隔离**：tag `dock-v*`、prerelease、`--latest=false`；更新清单在独立分支 `dock-pre`。
  旧挂件只读 `main` 的 `plugin.json` 与 `v*` 正式 release，且显式跳过 prerelease，
  **不会收到这个版本**。

## 安装 / 升级

1. 下载 `dock-2.0.0-pre.1.tar.gz` 并解压到独立目录（不要解压到旧挂件目录）。
2. 双击 `launch\启动 fox-dock.vbs`，或执行 `node tools\fox-dock.mjs start`。
3. 托盘菜单 / `Ctrl+Alt+D` 打开控制台。

从本地 dock 预发布升级：`node tools\fox-dock.mjs update --check` →
`node tools\fox-dock.mjs update --apply`，重启后生效；失败会自动回滚。

## 验证

- 单元 223/223、集成 66/66、旧线 selftest 408/408。
- 控制台 UI 自检 8 页 × 双主题 × 双视口（布局 / 可访问名称 / axe）。
- 控制台视觉基线 32/32、宠物层截图 48 张、Electron 控制台冒烟通过。
- 独立代码审查提出的 3 个 P2（导入角色持久化、GOAT 新老账户、runtime-env 路径）已修复并复测；
  按维护者要求，本轮不再发子审查。

完整变更见 [dock/CHANGELOG.md](https://github.com/pigeon189/zcode-fox-widget/blob/dock-v2.0.0-pre.1/dock/CHANGELOG.md)。
