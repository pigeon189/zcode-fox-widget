# 增量核对附录：round3 后的两个提交（2026-10-19）

## 核对范围

- `3b2ca9f`：`dock/daemon/src/host-vendors.mjs` 的 `pool` 增加 `kind` 字段；`dock/overlay/renderer.js` 厂商卡在 `kind='single'` 且 `total<=1` 时不再显示“账号池”。
- `9810001`：`dock/test/unit/host-vendors.test.mjs` 为 `pool.kind` 补断言。
- 基线：round3 APPROVE 的 `bde4dd6`；当前 HEAD `9810001`。

## 实际运行的命令与结果

- `cd /d "E:\WorkSpace\fox-dock\dock" && npm run ci`：**exit 0**。语法检查 145 文件 0 失败；单元测试 213/213 通过；lint 228 文件通过；engines parity 通过。
- `npm run test:all`：**exit 0**。297 个测试全部通过（297 pass / 0 fail / 0 skipped，65.8s）。

## 结论

APPROVE

## 未解决数量

- 本次增量：P1 0 / P2 0 / P3 0。
- 说明：round3 报告中已列出的 4 个既有 P3（死 state/import、`hideMoney` 下浮层积分数值、近 7/30 天按已记录天求和、`test:all` 多外部浮层隔离）不在本次增量范围，状态不变；本次两个提交未引入新的 P1/P2/P3。

## 证据

- `dock/daemon/src/host-vendors.mjs:86`：`pool.kind` 仅接受字符串并截断到 12 字符。
- `dock/overlay/renderer.js:1398-1401`：仅 `kind='pool'` 或（非 `single` 且 `total>1`）时显示账号池文案。
- `dock/test/unit/host-vendors.test.mjs:88`：断言 `pool` 含 `kind: ''`。
- 命令输出摘要：`npm run ci` → `CI:OK`（213/213、lint 228、parity 通过）；`npm run test:all` → `EXIT:0`、`tests 297 / pass 297 / fail 0`。
