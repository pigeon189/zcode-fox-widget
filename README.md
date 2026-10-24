# Antigravity-Gemini-Wight (反重力哈基米 / Gemini 记账桌宠)

<div align="center">
  <img src="assets/gemini_normal.png" width="180" alt="Antigravity Gemini Hakimi">
  <p><strong>专为 Google Antigravity 打造的原生二次元记账桌宠与配额监控插件</strong></p>
  <p>
    <a href="https://github.com/KKKomeijiSatori/Antigravity-Gemini-Wight"><img src="https://img.shields.io/badge/GitHub-Antigravity--Gemini--Wight-blue?logo=github" alt="GitHub Repo"></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT"></a>
    <img src="https://img.shields.io/badge/version-2.3-pink.svg" alt="Version 2.3">
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Antigravity-purple.svg" alt="Platform: Windows / Antigravity">
    <img src="https://img.shields.io/badge/RPC-LanguageServer%20Live-emerald.svg" alt="ConnectRPC Live">
  </p>
</div>

> **项目仓库**：[KKKomeijiSatori/Antigravity-Gemini-Wight: 一个适配Antigravity的桌宠/余额小挂件，移植自dsh小鲸鱼和zcode小狐狸挂件。使用 MIT 协议，源自 MeteorNOX 原版与pigeon189的zode版本。](https://github.com/KKKomeijiSatori/Antigravity-Gemini-Wight)
>
> 专为 **Google Antigravity** 平台深度定制开发：融合 **Sidecar 原生内置面板** 与 **Win32 零延迟物理吸附桌面独立桌宠** 双形态，直连反重力官方 `language_server.exe` ConnectRPC 配额接口，秒级同步 **5 小时 / 每周滚动限额与重置时间**，提供 **WPF 硬件加速 60FPS Q 弹物理果冻回弹摸头动画**、Token 逐轮账单与 Prompt Cache 节省审计。

---

## 📜 渊源与致谢 (Lineage & Acknowledgements)

本项目遵循 **MIT 协议** 开源，其灵感、核心交互与部分视觉/音效资产承袭自前代优秀桌宠小挂件的持续演进：

| 版本 | 仓库 / 来源 | 贡献与定位 | 协议 |
| :--- | :--- | :--- | :---: |
| **原版** | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | DSH 大肥鱼记账挂件首创者。奠定了摸头按压/回弹双音效、摸头形变、气泡队列交互与 Prompt 缓存记账理念。 | MIT |
| **ZCode 移植版** | [pigeon189/zcode-fox-widget](https://github.com/pigeon189/zcode-fox-widget)<br>*(基线源自 nb10yyds/zcode-whale-widget)* | ZCode 狐娘小挂件。引入了 Windows 桌面浮层模式、多模型与本地账本管理，持续迭代了音效与台词包。 | MIT |
| **本反重力版** | [KKKomeijiSatori/Antigravity-Gemini-Wight](https://github.com/KKKomeijiSatori/Antigravity-Gemini-Wight) | **Google Antigravity 深度重构版**。重写为 ConnectRPC 直连、60FPS 硬件加速弹性回弹动画、沙盒桌面突围、四象限物理像素吸附。 | MIT |

---

## 🎵 资产来源说明 (Asset Provenance)

本项目在保留上游 MIT 许可证的前提下，沿用并精调了部分经典资产，具体来源如下（详见 [`NOTICE`](./NOTICE)）：

1. **音效素材（`assets/sounds/`）**：
   - 沿用自 MeteorNOX 原版（DeepSeek-Balance-Whale-Widget）与 pigeon189（zcode-fox-widget）的开源音效：
     - `press.wav` / `D1.mp3`：摸头按下音效
     - `release.wav` / `D2.mp3`：摸头释放/回弹音效
     - `approve-default.wav`, `coin.wav`, `chime.wav`, `pop.wav`, `sparkle.wav`, `task-end-a.wav`：操作、金币掉落、缓存命中提示音
     - `cost-default.wav`：轮次计费结算提示音
     - `Ya1.mp3`, `Ya2.mp3`：警告与提醒音效
     - `minecraft-exp-orb.wav`：经验球拾取音效
   - 音效加载采用 Win32 `PlaySoundW` 内存锁（`GCHandle.Alloc` Pinned）与 DirectSound 极速回放，0 延迟无卡顿。
2. **立绘与图像素材（`assets/`）**：
   - `gemini_normal.png`, `gemini_blush.png`, `gemini_full_normal.png`：Gemini 哈基米专属形象素材（二次元粉发小狐狸 / Gemini 娘形象）。
   - `rua.gif`, `bubble-petpet.gif`：沿用自 DSH / zcode 上游摸头表情包素材。
   - `icon.ico`, `icon.png`, `logo.png`：托盘图标与 Antigravity 插件 Logo。
3. **台词文案（`assets/quotes.json`）**：
   - 承袭原版大肥鱼的呼噜呼噜摸头声与互动趣味，针对 Google Antigravity 百万上下文、Prompt Caching 缓存机制、四大真实模型量身定制了数百句二次元互动台词。

---

## ✨ 核心特性

### 1. 直连 Antigravity 官方 ConnectRPC (`GetUserStatus`)
- **100% 真实云端额度**：无需手动输入 API Key，自动发现本地 `language_server.exe` 的 CSRF Token 与端口。
- **5 小时与每周滚动双窗口**：精确捕获每个模型的 `quotaInfo.remainingFraction` 与 `quotaInfo.resetTime`，自动转换为本地时间倒计时。
- **零值省略精确判定**：当模型额度用尽（`0%`）时，Protobuf3 JSON 仅返回 `resetTime`，插件精准识别为 `0%`（杜绝旧版误判为 `100%` 的问题）。

### 2. 严格锁定反重力四大真实可用模型
彻底剥离所有非反重力环境的虚构/失效模型，专注服务反重力四大核心生产力模型：
- 🌟 **Gemini 4 Argon** (`gemini-4-argon` / `MODEL_PLACEHOLDER_M417~M419`)：反重力旗舰深度推理模型（周滚动配额）。
- ⚡ **Gemini 3.8 Flash** (`gemini-3.8-flash` / `MODEL_PLACEHOLDER_M318~M320`)：极速高频主力模型（5h 滚动配额）。
- 🧠 **Claude Opus 5.5** (`claude-opus-5-5` / `MODEL_PLACEHOLDER_M400~M402/M26`)：Anthropic 深度思考模型（5h 滚动配额）。
- 💻 **Claude Sonnet 5.5** (`claude-sonnet-5-5` / `MODEL_PLACEHOLDER_M403~M405`)：Anthropic 编程高阶模型（5h 滚动配额）。
- **切模型 100% 防炸加固**：在客户端与 Sidecar 服务层均加入了完整的兜底字典，无论是手动切换还是 Antigravity 内部自动路由，永不触发 `KeyError`。

### 3. 硬件加速 60FPS Q 弹物理果冻回弹摸头动画
- **按下下潜（MouseDown, 95ms）**：`CubicEase` 平滑下压形变（`ScaleX: 1.14, ScaleY: 0.84`），头顶爱心气泡轻盈上浮。
- **松手回弹（MouseUp, 480ms）**：基于 WPF `DoubleAnimationUsingKeyFrames` 实现四级阻尼弹性果冻回弹：
  - `120ms`：向上拉伸过冲（`ScaleX: 0.91, ScaleY: 1.13`）
  - `240ms`：二次下压反弹（`ScaleX: 1.055, ScaleY: 0.955`）
  - `360ms`：微阻尼收敛（`ScaleX: 0.986, ScaleY: 1.014`）
  - `480ms`：自然静止（`ScaleX: 1.0, ScaleY: 1.0`）
- 由 WPF GPU 渲染线程驱动，连续戳摸头丝滑流畅，彻底告别旧版定格抽帧卡顿感。

### 4. 彻底解决 Win32 / WPF 桌面悬浮痛点
- **跨桌面突围启动 (`WinSta0\Default`)**：使用 Win32 `CreateProcessW` 强制指定目标桌面为用户交互桌面，彻底解决 Antigravity 沙盒虚拟桌面（`WinSta0\exebox-*`）导致桌宠“在后台跑但屏幕看不见”的系统级问题。
- **防止最小化坐标飞出屏幕**：在宿主探测中过滤 `IsIconic` 最小化状态，强制施加 `[-1200, 600]` 物理坐标钳制，彻底消灭 `corner_offset_x: 33930` 飞出屏幕的问题。
- **100% 物理像素驱动**：贴边吸附与四象限自适应全程使用 Win32 物理像素（`GetWindowRect` + `SetWindowPos`），气泡显隐使用 `Opacity + IsHitTestVisible`，点击彻底不再乱飞。

### 5. 交互手势与免打扰设计
- **单击桌宠**：触发大肥鱼原版摸头音效（`press.wav` + `release.wav`）+ 脸红 Q 弹 + 随机元气台词。
- **单击两次桌宠（270ms ~ 950ms）或点击气泡右上角 `×`**：独立开关头顶基础配额气泡。
- **快速双击桌宠（<= 270ms）或点击底部 `📊`**：展开或收起四象限自适应详情面板。
- **独立音效开关**：摸头音效与缓存命中提示音均可独立开启/静音。

### 6. 伴随 Antigravity 窗口最小化隐藏与关闭联动
- **最小化联动隐藏**：在开启吸附状态下，当 Antigravity 主窗口最小化或按下 Win+D 返回桌面时，桌宠主窗口与详情面板自动隐形（Visibility = Collapsed），杜绝遮挡屏幕。
- **恢复联动展示与 0ms 复位**：当 Antigravity 窗口从任务栏还原时，桌宠立即重现并自动贴边复位至所选吸附角。
- **关闭联动伴随退出**：当 Antigravity 窗口关闭或主进程结束时，桌宠自动识别退出信号并优雅关闭退出。
- **全端开关自由掌控**：可在桌宠右键菜单（🙈 伴随 Antigravity 最小化隐藏与关闭联动）或内置 WebUI 侧边栏中随时一键开关。

---

## 🚀 安装与使用指南

### 方法一：作为 Antigravity 官方扩展插件安装（推荐）

1. 将本仓库内容克隆或解压至 Antigravity 插件目录：
   ```powershell
   # 默认 Antigravity 插件路径：
   C:\Users\<用户名>\.gemini\config\plugins\gemini-hakimi-widget
   ```
2. 重启 Antigravity，插件随软件自动激活。
3. 在 Antigravity 中点击侧边栏面板入口或输入指令呼出：
   - 内置面板：`[哈基米记账](sidecar://gemini-hakimi-widget/hakimi_panel/ui.html)`
   - 面板内可一键开关“桌面悬浮宠物”，也可勾选“每次启动 Antigravity 自动弹出悬浮宠物”。

---

### 方法二：独立运行桌面悬浮桌宠模式

如果你希望不依赖侧边栏面板、作为独立轻量桌宠挂件运行：

1. **直接启动**：双击根目录下的 `scripts/Launch-Hakimi.vbs` 或运行 `scripts/Start-Widget.bat`。
2. **退出桌宠**：右键点击桌宠托盘图标或桌宠身体右键菜单 → **退出哈基米桌宠**（或运行 `scripts/Stop-Widget.bat`）。
3. **开机自启动**：运行 `scripts/Enable-AutoStart.bat` 写入开机自启（运行 `scripts/Disable-AutoStart.bat` 可随时移除）。
4. **创建桌面快捷方式**：运行 `scripts/Create-Desktop-Shortcut.ps1` 即可在桌面生成一键启动快捷方式。

---

## 📂 项目结构

```text
Gemini-Hakimi-Widget/
├── assets/                       # 角色立绘、原版音效与台词包
│   ├── gemini_normal.png         # 正常状态立绘
│   ├── gemini_blush.png          # 摸头害羞立绘
│   ├── quotes.json               # 专属台词库
│   └── sounds/                   # 大肥鱼原版摸头音效 (press/release/task/cost...)
├── config/                       # 用户配置与状态持久化
│   └── config.json               # 坐标、音效、活动模型配置
├── rules/                        # Antigravity 规则提示词 (AGENTS.md)
├── scripts/                      # 启动、退出与开机自启管理脚本
│   ├── Launch-Hakimi.vbs         # 无黑框静默启动器 (STA 保护)
│   ├── Start-Widget.bat          # 启动批处理
│   ├── Stop-Widget.bat           # 终止挂件批处理
│   ├── Enable-AutoStart.bat      # 写入开机自启
│   └── Create-Desktop-Shortcut.ps1
├── sidecars/                     # Antigravity 内置 Sidecar 面板
│   └── hakimi_panel/
│       ├── server.py             # HTTP 守护进程 + 跨桌面突围启动器
│       ├── sidecar.json          # Sidecar 注册清单
│       └── ui.html               # 现代化手账 WebUI (GPT-Niang 限额矩阵)
├── skills/                       # Antigravity Skill 技能定义
├── src/                          # 核心业务逻辑
│   ├── AntigravityMonitor.ps1    # ConnectRPC 官方限额引擎与日志审计
│   ├── HakimiWidget.ps1          # WPF 硬件加速 60FPS 悬浮窗宿主
│   ├── Pricing.json              # 反重力四大模型定价与限额规格表
│   └── WidgetWindow.xaml         # XAML 视觉模板 (物理吸附与四象限自适应)
├── CHANGELOG_AND_FIXES.md        # 完整问题排查与技术演化复盘文档
├── NOTICE                        # 完整开源沿革与资产致谢说明
├── hooks.json                    # Antigravity SessionStart 钩子配置
├── plugin.json                   # Antigravity 插件清单配置
└── README.md                     # 项目介绍文档
```

---

## 🛠️ 技术演进与踩坑复盘

详细的底层 Win32 API 交互、DPI 物理像素坐标系映射、ConnectRPC 协议逆向以及沙盒虚拟桌面突围等技术细节，请参阅：
👉 [CHANGELOG_AND_FIXES.md](./CHANGELOG_AND_FIXES.md)

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 开源，请遵守相关衍生作品版权声明。
