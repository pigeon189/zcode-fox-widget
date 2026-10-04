---
description: 查看 DeepSeek 余额、今日已用与上一轮消耗，或启停 ZCode狐娘小挂件（网页版 / 桌面浮层）
argument-hint: "[status|start|stop|turn|url|window start|window stop|key <sk-...>|mode ledger|token]"
allowed-tools: Bash, mcp__whale__whale_balance, mcp__whale__whale_widget, mcp__whale__whale_last_turn, mcp__whale__whale_config
---

用户请求操作 ZCode狐娘小挂件（zcode-fox-widget）。参数：`$ARGUMENTS`

按参数分派：

- 空 / `status`：调用 MCP 工具 `whale_balance`，用中文报告余额、今日已用、当前峰谷时段；再调用 `whale_widget`（`action=status`）报告挂件服务是否在运行、地址是什么。
- `start`：调用 `whale_widget`（`action=start`），把返回的地址告诉用户，并提示用浏览器打开即可看到小鲸鱼。
- `stop`：调用 `whale_widget`（`action=stop`）。
- `url`：调用 `whale_widget`（`action=url`），只回地址。
- `turn`：调用 `whale_last_turn`，报告上一轮对话消耗的金额、模型、token 数与计价时段。
- `window start`：调用 `whale_widget`（`action=overlay_start`），把鲸鱼作为**桌面浮层**显示在 ZCode 界面之上（透明置顶、默认鼠标穿透，不挡操作）。若返回「需要运行 Electron 运行时」，就让用户在终端执行 `node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" desktop install`（一次性，约 150MB）后重试。
- `window stop`：调用 `whale_widget`（`action=overlay_stop`）。
- `window status`：调用 `whale_widget`（`action=overlay_status`）。
- `key <sk-...>`：调用 `whale_config`（`action=set`，`apiKey=<值>`）写入 DeepSeek API Key。
- `mode ledger|token`：调用 `whale_config`（`action=set`，`usageMode=...`）切换对账口径（小鲸鱼记账 / 实时·令牌）。

若 MCP 工具不可用（例如插件刚装好还没重启会话），退回命令行：

```bash
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" status          # 或 turn / start / stop / url / json
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" window start    # 桌面浮层（浮在 ZCode 上）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" desktop install # 首次使用浮层前安装 Electron 运行时
```

输出要求：中文，先给结论（余额多少、是否正常），再补充峰谷时段与数据来源。余额获取失败时，明确说出失败原因，并给出可执行的修复动作（配置 API Key 或检查网络），不要只贴原始错误。用户问「为什么界面上看不到」时，说明 ZCode 客户端不提供界面注入点，所以用桌面浮层窗口实现，并给出 `window start` 或 `desktop install` 的确切命令。

