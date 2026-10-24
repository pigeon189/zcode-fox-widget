# Pull Request: 桌面端与Sidecar全链路架构升级 (v3.0)

## 📌 PR 标题
`feat & fix: add independent scaling, accurate RetrieveUserQuotaSummary RPC, companion lifecycle & round token summary (v3.0)`

---

## 📝 概述 (Overview)
本次 PR 针对反重力哈基米记账桌宠（Gemini Hakimi Widget）进行了全面的体验升级与底层加固：
1. **尺寸调节与视觉表现**：新增本体与气泡双独立滑块缩放、四象限缩放原点动态锚定（解决缩小悬空留白）、文字清晰度提升与排版放大；
2. **额度精准度重构**：全面接入官方原生 `RetrieveUserQuotaSummary` 接口，解决旧版缺失每周限额导致本地错误估算的问题，实现与官方 1:1 绝对一致；
3. **整轮对话结算通知**：新增智能整轮结算气泡，过滤中间思考与工具调用，仅在最终回答完毕时汇总展示消耗与节省 Token；
4. **伴随生命周期闭环**：修复 Sidecar 模块缺失与桌宠最小化误判自杀的问题，去除误导性开机自启，真正做到“随反重力启动而拉起，随反重力关闭而退出”；
5. **系统稳定性与性能优化**：引入全局单实例互斥锁（防多开重叠）、历史日志内存增量缓存（0 磁盘 I/O）、WPF 视觉树懒加载渲染。

---

## 🔍 详细变更 (Detailed Changes)

### 1. 交互与视觉优化
- **本体/气泡独立滑动缩放 (Settings Window)**:
  - 新增 `SettingsWindow.xaml` 独立设置窗口，支持通过滑块在 `0.5x ~ 2.0x` 范围内无级调节本体大小；
  - 新增 `bubble_scale` 配置项与独立滑块，实现头顶气泡与本体尺寸完全解耦。
- **四象限动态缩放原点锚定 (Anti-Void Docking)**:
  - 重构 `Update-QuadrantLayout`，在右下角吸附时动态将 `RenderTransformOrigin` 设为 `(1.0, 1.0)`，彻底消除了桌宠缩小后与屏幕/窗口边框之间的巨大悬空空白。
- **气泡清晰度与文字比例放大**:
  - 解除了气泡与缩放父容器的级联重采样模糊，确保在高分屏下文字边缘锐利；
  - 增大了气泡内标题、正文及副标题的字体字号，使视觉排版更充盈易读。

### 2. 额度精准度与接口重构 (Accuracy & RPC)
- **接入官方原生 `RetrieveUserQuotaSummary` 接口**:
  - 废弃单纯依赖容易缺失周限额字段的 `GetUserStatus`，优先通过 ConnectRPC 调用官方最权威的 `RetrieveUserQuotaSummary` 端点；
  - 完整解析 `gemini-5h`、`gemini-weekly`、`gemini-argon-wtu-weekly`、`3p-5h`、`3p-weekly` 五大真实配额桶，实现 5 小时滚动与每周限额百分比、重置时间与官方菜单 100% 同步；
  - 内置 Sidecar 服务（`server.py`）同步升级该接口，并在重启后端口改变时具备自动重探测与重新桥接能力。

### 3. 整轮对话结算气泡 (Round Finished Notification)
- **智能对话轮次状态机**:
  - 在 `AntigravityMonitor.ps1` 中实现 `ActiveRound` 跟踪，以 `USER_INPUT` 为起点累计整轮所有步骤的输入、生成及缓存 Token；
  - 严格判定“无未完成的 `tool_calls` 且已生成最终内容”为最终回答时刻，仅在此刻触发 1 次结算气泡与完成提示音，彻底告别中间思考和工具调用频繁弹窗打扰。

### 4. 伴随生命周期与防误杀 (Lifecycle & Companion)
- **看门狗模块修复**:
  - 修复 `server.py` 缺少 `import ctypes.wintypes` 导致看门狗检测 Antigravity 主窗口抛异常失效的问题；
- **防自杀与无宿主退出**:
  - 修复 `HakimiWidget.ps1` 在宿主启动加载或最小化时因找不到句柄误判自杀的问题，加入 `IsHostProcessAlive()` 进程级保活守护；
  - 移除 Windows Startup 开机自启快捷方式，改为由 Sidecar 伴随拉起，并在未检测到宿主进程时自动退出，严格实现伴随生命周期。

### 5. 性能与单实例防多开 (Performance & Guard)
- **全局单实例互斥锁 (`SingleInstanceMutex`)**:
  - 在 `HakimiWidget.ps1` 启动入口增加系统级命名 Mutex `Global\GeminiHakimiWidgetSingleInstance`，并在 `Launch-Hakimi.vbs` 增加 WMI 进程预检，彻底防止开机或双击重复多开“双胞胎”桌宠；
- **历史日志增量缓存 (`TranscriptFileCache`)**:
  - 在 `AntigravityMonitor.ps1` 中建立文件修改时间与大小的轻量增量缓存，未变更的历史会话文件免除磁盘读取与 JSON 解析，挂机 CPU 与磁盘 I/O 降为接近 0；
- **WPF 视觉树懒加载**:
  - 当详情窗口处于隐藏折叠状态时，跳过每 1.5 秒一次的模型列表视觉树清空与控件重建，大幅降低 GC 与内存波动。

---

## 📊 修改前后对比 (Before vs After)

| 场景 / 功能 | 修改前 (Before) | 修改后 (After) |
| :--- | :--- | :--- |
| **整体大小调节** | 仅能右键固定档位或手动改配置 | 新增可视化滑动条，0.5x ~ 2.0x 实时平滑拖拽 |
| **缩小后贴边** | 越缩小悬空留白越大，无法贴合边缘 | 动态变换原点锚定，缩小依然死死贴紧宿主边角 |
| **气泡大小与清晰度** | 随本体缩放且发虚模糊，字体偏小 | 独立缩放滑块控制，矢量文字放大锐利清晰 |
| **额度百分比准确度** | 因缺字段退化为本地估算（如错误显示79%） | 官方 `RetrieveUserQuotaSummary` 1:1 精确同步 |
| **对话完成结算** | 无汇总或每步思考/工具调用频繁刷屏 | 仅在整段回答最终完成时弹出 1 次结算气泡 |
| **启动与伴随机制** | 伴随看门狗报错失效；最小化易误自杀 | 进程级保活，开 Antigravity 自动出，关则自动退 |
| **防多开保护** | 重复点击会叠加产生多个桌宠重叠 | 全局命名互斥锁拦截，多开静默退出，全局唯一 |
| **后台运行资源消耗** | 每 15 秒全量重读所有历史日志并重构 DOM | 增量缓存 + 详情窗懒渲染，0 磁盘颠簸，极低内存 |

---

## 📁 涉及修改文件 (Changed Files)
- `src/HakimiWidget.ps1` (单实例锁、双独立缩放、四象限锚定、进程保活、懒加载)
- `src/AntigravityMonitor.ps1` (`RetrieveUserQuotaSummary` RPC 接入、整轮状态机、增量缓存)
- `src/SettingsWindow.xaml` (全新大小调节设置窗口)
- `src/WidgetWindow.xaml` (气泡样式、文字排版与字号层级放大)
- `sidecars/hakimi_panel/server.py` (`wintypes` 补齐、配额接口升级、失效重连、伴随拉起)
- `scripts/Launch-Hakimi.vbs` (启动前 WMI 多开预检)
- `config/config.json` (新增 `bubble_scale` 等参数持久化)

---

## ✅ 验证记录 (Verification)
- [x] `-CheckOnly` 启动自检 100% 通过（识别 `gemini-4-argon` / `gemini-3.8-flash` 等四大模型并精确获取 5h 与周限额）；
- [x] 重复触发 `Launch-Hakimi.vbs` 两次，活跃桌宠进程严格保持 1 个；
- [x] 拖动大小滑块，桌宠及气泡实时无级缩放且贴边无偏移；
- [x] AI 回答完毕后，仅在最终回答生成时触发一次结算气泡，中间思考与工具调用 0 干扰；
- [x] 退出 Antigravity 宿主后，桌宠在 0.5 秒内自动随之退出。
