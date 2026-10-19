# fox-dock 控制台 UI 规格

> 2.0 控制台（`dock/ui/`）的最小维护规格。数值以 `ui/tokens.css` 为准；
> 页面验收用 `npm run test:ui`（布局 + 可访问名称 + axe）。

## 1. 两层结构

| 层 | 载体 | 内容 |
|---|---|---|
| 宠物层 | `overlay` 透明全屏置顶窗，穿透 | 角色、胶囊、气泡、快览卡、菜单；吸附（四角/边缘/窗口内自由位置）/镜像 |
| 控制台 | `console` 独立可聚焦窗口 | 总览、上下文、用量、额度与余额、厂商与密钥、角色与气泡、设置、关于 |

控制台下拉与复选框使用自绘控件（`components/base.mjs` 的 `Select` / `Checkbox`），不使用原生
`<select>` 弹出层；设置页不因打开控件产生横向滚动或整页位移。

控制台窗口 960×680 起、最小 760×560；关闭收进后台，托盘/热键再次打开走第二实例显示已有窗口。
渲染层不接触 Node 与 daemon 令牌：所有请求经 preload → 主进程 IPC。

## 2. 设计令牌

- 颜色：`--bg/--surface/--surface-2/--border/--text/--text-2/--text-3`；状态 `--ok/--warn/--bad/--info`；
  强调色 `--accent/--accent-strong`（浅色 `#f0a04b` / `#8a5316`）；焦点 `--focus`。
- 对比度：正文 ≥4.5:1；徽标文字使用 `--ok-strong` 等深色变体，避免 12% 底色下不达标。
- 图表色：`--c1..--c5` 固定顺序（缓存命中/未缓存输入/缓存写入/输出/推理），阈值另用虚线 + 百分比文字作第二通道。
- 字号只允许 `12/13/14/16/20/24/32/40`；正文 13，页面标题 20/700，卡片标题 14/600，最小 12。
- 间距 4/8/12/16/24/32；卡片内边距 16、卡片间距 16、页面左右 24；圆角 6/8/12/16/999。
- 动画 120–200ms（Skeleton 扫描 1.2s 为加载态例外），`prefers-reduced-motion` 下全部关闭。

## 3. 语义结构

- 侧栏 208px（<860px 收成 56px 图标栏）；分组「监控 / 管理」，底部状态 + 关于。
- 页头 72px：H1、视角分段（跟随吸附 + 四个 agent）、刷新；<1100px 隐藏「上次更新」。
- 内容区 12 栏栅格、可键盘聚焦滚动；所有页面无横向滚动、无元素溢出。
- 每个页面有 `data-testid="page.<name>"`，导航有 `nav.<name>`，图表/关键卡片有稳定 testid。

## 4. 组件约定

Button（primary/secondary/ghost/danger，32 高）、IconButton（32×32，必须有 `aria-label`）、
Card、Badge（ok/warn/bad/info/neutral）、Toggle（绑定 label 或 `ariaLabel`）、
Input/Select（必须有可访问名称）、Segmented（`role=tablist`）、ProgressBar（`role=progressbar`）、
Gauge、StackedBar、AreaChart、ColumnChart、EmptyState、Toast、Dialog、Skeleton。

图表必须有 `role="img"` 与 `aria-label`；纯装饰图标 `aria-hidden`。

## 5. 页面要点

- **总览**：主数字 + 上下文环 + 三格指标 + 7 天柱图 + 额度窗口 + 全部 agent 表；预警条在页头下方。
- **上下文**：会话选择、占用环、构成条（缺项不补）、触顶估算（样本不足隐藏）、压缩标记、趋势图、会话表。
- **用量**：范围/指标两个筛选 + 单位币种切换（不混算）+ 按 Agent 排名 + 明细 + CSV/JSON 导出。厂商/模型维度暂未提供。
- **额度与余额**：单窗口大字百分比、多窗口进度条、余额卡、套餐卡；厂商卡支持余额校正。
- **厂商与密钥**：掩码状态、配置/测试/删除、从宿主导入；密钥框默认 password，可显隐。
- **角色与气泡**：六内置 + 导入（PNG 校验、删除）、强调色、气泡开关/停留/台词间隔、模板 JSON。
- **设置**：搜索 + 分组；改动立即 PUT，失败回滚并 Toast；每行标签在左、控件在右。
- **关于**：版本/运行信息/适配器/绑定、检查更新、复制/导出诊断包（均要有 Toast 反馈）。

## 6. 验收清单

- 8 页 × 浅/深主题：无 JS 异常、无横向滚动、字号 ≥12、交互元素有可访问名称、axe 严重/致命 0。
- 总览首屏可见主数字/上下文/三格指标；上下文不可得时显示 EmptyState 而不是空白。
- 所有弹窗可用键盘关闭（Esc），焦点有可见环；关闭后回到触发按钮。
- 数字列右对齐、单位紧贴数字；多币种/积分不混算。
- 截图矩阵：`npm run shots -- --page console --console-pages <pages> --theme light,dark --base <fixture>`。
