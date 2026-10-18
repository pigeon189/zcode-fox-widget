# fox-dock（工作名）· `feat/dock`

桌面常驻的多 agent 成本看板：把挂件拖到 agent 窗口上，自动识别、吸附、切到对应计费口径。

**状态：R2 完成。** 已有：Win32 窗口桥 + doctor、常驻服务（单实例 / 健康检查 / 令牌停止）、watchdog 自动拉起、登录启动器安装。

## 与现有挂件的关系

- 同一个 git 仓库，独立分支 `feat/dock` 与独立 worktree（`E:\WorkSpace\fox-dock`）。
- 现有 `lib/`、`desktop/`、`hooks/` 在本分支上**不改动**；新代码全部在 `dock/`。
- 发布通道独立：tag `dock-v*`，1.0 之前全部是 pre-release。

## 目录

```
dock/
  shared/      身份键等纯函数（无 Windows 依赖，可在任意平台跑）
  daemon/      常驻服务（R1 起：Win32 桥 / 绑定 / 适配器 / 账本）
  adapters/    zcode / workbuddy / generic
  overlay/     Electron 浮层
  test/
    unit/      纯函数测试（CI 必跑）
    integration/ 真 HTTP + 假 agent
    e2e/       Playwright（Electron）
    visual/    截图基线 + 像素对比
docs/dock/     决策记录与计划
```

## 本地命令

```bash
cd dock
npm run check    # 语法检查
npm test         # 单元测试
npm run test:it  # 集成测试（真实窗口 + 真服务 + watchdog，需要桌面会话）
npm run test:all # 全部

npm run doctor   # 打印当前桌面窗口与光标命中（不启动服务）
npm start        # 启动 watchdog（后台常驻）
npm run status
npm run stop
npm run install-app  # 写登录启动项（默认到真实启动文件夹，可用 --startup-dir 覆盖）
```

集成测试不进 CI：它需要真实的桌面会话（GitHub runner 的交互桌面行为不稳定），
CI 只跑单元测试；集成在本地/真机上跑。
