# 文档索引（唯一入口）

> 根目录只放三份 md：[`README`](../README.md)（用户）、[`CHANGELOG`](../CHANGELOG.md)（速查）、
> [`CONTRIBUTING`](../CONTRIBUTING.md)（贡献者）。其余都在这里登记。
> **状态**：常青 = 需要跟着代码更新；已闭环 = 只作历史参考；待实施 = 结论还没落地。

## 长期文档

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [`MAINTAINING.md`](./MAINTAINING.md) | 维护手册：责任表、架构、宿主契约、别改清单、测试与发布、已知限制 | 常青 |
| [`MARKETPLACE.md`](./MARKETPLACE.md) | 市场发布：套件/插件市场的两条线（自建仓库 / 官方 PR）、打包口径与发版检查 | 常青 |
| [`DECISIONS.md`](./DECISIONS.md) | 决策日志：按主题回答「为什么这么写」，每条含依据与别踩的坑 | 常青 |
| [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md) | ZCode 线 v1.1.0–v1.11.1 的变更史（原样归档） | 已归档 |
| [`CATGIRL-SOUND-NOTES.md`](./CATGIRL-SOUND-NOTES.md) | 猫娘按压音效的来源、授权与加工史 | 已内置（2026-10-22 定稿） |

## 评审记录（`reviews/`）

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [`reviews/2026-10-14-port-code-review.md`](./reviews/2026-10-14-port-code-review.md) | 移植完成后的代码评审（P0/P1 已修） | 已闭环 |
| [`reviews/2026-10-17-ui-review.md`](./reviews/2026-10-17-ui-review.md) | UI/UX 设计审查（P0–P2，本轮已按报告修复） | 已闭环 |

## 事故记录（`incidents/`）

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [`incidents/2026-10-overlay-host-freeze.md`](./incidents/2026-10-overlay-host-freeze.md) | 点角色后宿主停帧：证据链与 `type:'toolbar'` 结论 | 已闭环（结论在代码里生效） |
| [`incidents/2026-10-cross-line-overlay-kill.md`](./incidents/2026-10-cross-line-overlay-kill.md) | 两端同装时浮层互杀：根因、修复与发版修复记录 | 已闭环 |

## 移植档案（`porting/`）

| 文档 | 内容 |
| --- | --- |
| [`porting/phase-0.md`](./porting/phase-0.md) | 探路：宿主契约四项验证 + 数据源结构（**至今仍是基线**） |
| [`porting/phase-1.md`](./porting/phase-1.md) | 骨架：清单 / 钩子 / 路径 / 命令 / skill |
| [`porting/phase-2.md`](./porting/phase-2.md) | 数据源：积分主口径 + 上下文余量 |
| [`porting/phase-3.md`](./porting/phase-3.md) | 浮层：跟随目标改名、移除就绪门控 |
| [`porting/phase-5.md`](./porting/phase-5.md) | 收尾：测试、发版与验收清单 |
| [`porting/phase-6-acceptance.md`](./porting/phase-6-acceptance.md) | 移植验收：逐项结果与遗留 |

> `porting/` 是**历史证据**，只增不改（改写会破坏「当时怎么测出来的」）。当前结论以
> `MAINTAINING.md` 与 `DECISIONS.md` 为准。
