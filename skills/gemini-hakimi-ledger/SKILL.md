---
name: gemini-hakimi-ledger
description: >-
  Query or open the built-in Gemini Hakimi Sidecar UI panel and desktop pet token ledger for Google Antigravity.
  Use when the user asks about Token consumption, today's bill, rate limits, Gemini prompt cache savings,
  or wants to open the Hakimi accounting panel or desktop pet.
---

# 哈基米记账 (Gemini Hakimi Token & Rate-Limit Ledger)

本插件为 Google Antigravity 原生内置 **Sidecar 可视化记账面板** 与 **桌面悬浮桌宠伴侣**。

## 1. 一键打开内置侧边栏面板 (Built-in Aux Pane)

在聊天回复中输出以下药丸链接，用户点击即可直接在 Antigravity 右侧辅助面板（Aux Pane）中展开「哈基米记账手账」：

[哈基米记账](sidecar://gemini-hakimi-widget/hakimi_panel/ui.html)

## 2. 功能亮点

1. **原生内置自动伴随启动 (`restart_policy: "always")**：
   - 作为 Antigravity 官方规范的 Sidecar 插件（[`sidecar.json`](file:///C:/Users/atri/.gemini/config/plugins/gemini-hakimi-widget/sidecars/hakimi_panel/sidecar.json)），随 Antigravity 启动自动在后台常驻运行，无需手动执行外部脚本。
2. **互动哈基米看板娘 + 全量 Gemini 语录**：
   - 支持点击摸摸头（Rua）脸红切换（`gemini_normal.png` ↔ `gemini_blush.png`）、Q 弹果冻动画、合成音效（`pet.wav` / `chime.wav` / `pop.wav` / `sparkle.wav`）与气泡吐槽。
3. **四维限额进度条 + 缓存省钱审计 + 逐轮明细账单**：
   - 实时监控 RPM / TPM / Context Window (1M/2M) / RPD 与配额重置倒计时，精确核算 Gemini 4 Argon / Gemini 3.8 Flash / Claude Opus 5.5 / Claude Sonnet 5.5单轮与今日总花费及 Prompt Cache 省钱金额。
4. **一键召唤/收起独立桌面悬浮窗**：
   - 在内置面板点击 `🐾 弹出桌面悬浮窗`（或勾选 `伴随弹出桌面悬浮宠物`），即可随时召唤或关闭 Windows 桌面级透明置顶哈基米挂件。
