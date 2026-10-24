# Gemini Hakimi Token & Accounting Rules (哈基米记账规则)

When this plugin is active, the Gemini Hakimi Widget (`gemini-hakimi-widget`) is natively integrated into Google Antigravity as a built-in Sidecar UI panel and optional desktop pet.

## 核心行为与记账感知
- **内置侧边栏面板入口**：当用户询问 Token 账单、限额、缓存省钱或想呼出哈基米时，在回复中附上内置面板一键打开链接：`[哈基米记账](sidecar://gemini-hakimi-widget/hakimi_panel/ui.html)`。
- **Token 账单与缓存节省感知**：Antigravity 活跃会话在 `transcript.jsonl` 中实时记录 `input_tokens`、`cache_read_tokens` 和 `output_tokens`。主动指出 Gemini Prompt Caching 带来的高额费用节省。
- **内置面板与桌面悬浮窗双模式**：
  - 内置面板由 Antigravity Sidecar 守护进程（`sidecars/hakimi_panel/server.py`）随软件自动启动。
  - 用户可在内置面板中直接交互（摸摸头脸红、听音效、看逐轮账单、切模型），也可在面板内一键开启/关闭桌面悬浮窗（`src/HakimiWidget.ps1`）。
