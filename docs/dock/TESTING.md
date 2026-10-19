# fox-dock 测试指南

## 1. 分层与命令

| 层 | 命令 | 说明 |
|---|---|---|
| 语法 + 价目同步 + 单元 + 静态守卫 + engines parity | `npm run ci` | 提交前必跑；CI 也跑这一组 |
| 单元 + 集成 | `npm run test:all` | 集成会开真窗口/真 Electron，需要桌面会话 |
| 控制台页面自检 | `npm run test:ui` | 夹具 daemon + Edge；布局/可访问名称/axe，8 页 × 双主题 |
| 页面 E2E（结构部分） | `npm run test:e2e` | 同上，关闭 axe |
| 截图矩阵 | `npm run shots -- --page console --console-pages overview,context,usage,quota,vendors,roles,settings,about --theme light,dark --base http://127.0.0.1:39490` | 先启动夹具 daemon |
| 真机上下文对账 | `npm run verify:context` | PASS / SKIPPED（not-running / no-session）/ UNAVAILABLE |
| 真机计费对账 | `npm run verify:zcode` / `verify:workbuddy` | 与宿主/旧挂件口径比对 |
| 稳定性 | `npm run soak` | 长跑内存/句柄；过夜执行 |

测试依赖只在 `dock/test/package.json`（Playwright/axe/pngjs），不随运行时包分发。
浏览器用本机 Edge（`channel:'msedge'`），不需要下载 Chromium。

## 2. 夹具

- `tools/fixture-daemon.mjs`：按 `test/fixtures/scenes/*.json` 返回固定快照，时间冻结；
  同时提供 `/ui/*` 静态文件，供页面截图与 E2E 使用。
- `test/fixtures/scenes/zcode-normal.json`：四宿主快照、上下文、会话、7 天账本、厂商、角色。
- 集成测试的宿主数据库全部现场合成（`node:sqlite`），不读真实用户库；dsh 会话由
  `zlib.zstdCompressSync` 逐帧写多帧文件。

## 3. 页面自检覆盖

`tools/ui-check.mjs` 对每页检查：

1. 无 `pageerror`；
2. 文档无横向滚动；
3. 可见文本字号 ≥12；
4. `button/input/select/textarea/a` 有可访问名称（aria-label/title/文本/label）；
5. axe `critical` 与 `serious` 为 0（含 color-contrast、label、select-name）。

设置页的「标签 + 控件」两栏结构在渲染后为控件补 `aria-label`；新增设置行时保持这个机制，
不要用占位符代替标签。

## 4. 截图与基线

- 截图输出在 `test/visual/__shots__/`（不入库），联系表 `index.html` 可点击放大。
- 视觉基线尚未接入逐像素比对；当前以「截图人工过目 + ui-check 结构断言」为门禁。
- 接基线时：只在固定机器/固定 Edge 版本生成，基线入库，动态内容用 `data-visual-mask` 遮罩；
  环境不符要标 `ENV-MISMATCH`，不得直接更新基线。

## 5. 偶发失败

- `anchor: 绑定后狐狸停在放下的位置` 偶发受窗口动画/端口占用影响；复跑单文件确认：

  ```cmd
  cd /d "E:\WorkSpace\fox-dock\dock"
  node --test --test-concurrency=1 test/integration/overlay.itest.mjs
  ```

- 服务端口被占时 daemon 会自动 +1；测试认 lock 文件里的实际端口，不要硬编码 39401。
- 角色/音效列表一次性拉取不自愈的问题已由 `fetchListRetry` 与 bind 探针处理，不要再引入
  「只拉一次」的新调用。

## 6. 真机清单（发版前）

1. 重启电脑后 30 秒内 daemon 在线、角色出现；
2. `kill -9` daemon 后 5 秒内被 watchdog 拉回，绑定恢复；
3. 逐个拖到 ZCode / WorkBuddy / Kimi Code / dsh，角色与主数字正确；
4. 拖到桌面空白 → 悬浮且角色/气泡设置不变；
5. 关闭 agent 再打开 → 自动重新吸附（设置开）；
6. `verify:context` 对账，Kimi 需先开会话（否则 SKIPPED，不算通过）；
7. 高 DPI（本机 150%）截图完整可见；
8. 干净 `HOME`/`LOCALAPPDATA` 下能自管运行时并起浮层；
9. 与旧挂件共存不出现两个角色、互不误杀；
10. 假清单更新失败能回滚、更新记录可见；
11. 厂商数据与旧挂件对照一致；
12. 联系表人工过目无错位/溢出。

## 7. 安全测试

- `npm run lint`：UI 禁止 `innerHTML/eval/new Function`（vendored 第三方除外）、
  `overlay/main.cjs` 的 `type:'toolbar'` 守卫、Electron 入口沙箱配置、密钥模式扫描。
- 角色导入：PNG 签名 + 全 chunk CRC + ≤3MB + ≤2048² + id 白名单 + 内置不可删。
- 凭据：保险库 DPAPI 往返/篡改报错/掩码；接口与诊断包不得出现完整 key。
- 出站：`blocked-host` 拒绝环回/私有/保留地址；Kimi 与 CommandCode 的固定环回例外只对专用客户端生效。
