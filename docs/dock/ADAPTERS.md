# 写一个 fox-dock 适配器

适配器负责两件事：**认出窗口属于哪个 agent**，以及**把这个 agent 的今日消耗读出来**。
两者都不允许猜——认不出就落到 `generic`，读不到就报错，绝不编一个 0 或一个金额。

## 目录约定

```
dock/adapters/<id>/
  index.mjs      适配器定义（match / capabilities / createBilling）
  store.mjs      数据读取（只读宿主的东西，不写）
  ...            其它纯函数模块
```

在 `dock/adapters/registry.mjs` 的 `builtinAdapters` 里注册。**不加载第三方代码**（D006）：
适配器随包发布，匹配规则是声明式的。

## 最小例子

```js
export const myAdapter = {
  id: 'myagent',              // /^[a-z][a-z0-9-]{1,30}$/
  name: 'MyAgent',
  priority: 20,               // 同分时大的优先
  match: { exeBasenames: ['myagent.exe'] },
  capabilities: { billing: true, follow: true },

  createBilling(ctx) {
    const now = ctx.now || (() => Date.now())
    return {
      async snapshot() {
        return {
          supported: true,
          unit: 'money',                 // money | credit | percent
          today: { amount: 1.23, currency: 'CNY', byCurrency: { CNY: 1.23 } },
          turn: { amount: 0.28, currency: 'CNY' },
          quota: null,                   // 或 { usedPct, remainingPct }
          balance: null,                 // 或 { amount, currency }
          source: 'myagent:https',       // 给人看的来源说明
        }
      },
    }
  },
}
```

## 匹配规则

`match` 支持五个维度，**维度之间是 AND，维度内部是 OR**：

| 维度 | 含义 | 例 |
|---|---|---|
| `exeBasenames` | 可执行文件名（大小写不敏感） | `['zcode.exe']` |
| `exeIncludes` | 完整路径的子串（正斜杠、小写） | `['/zcode/']` |
| `titleIncludes` | 标题子串（不敏感） | `['zcode']` |
| `titlePatterns` | 标题正则（RegExp 数组，仅内置适配器） | `[/^ZCode\b/]` |
| `classes` | 窗口类名精确匹配 | `['Chrome_WidgetWin_1']` |

规则：

- **没有任何维度的 `match` 永不命中**——写错的适配器不会变成吞噬所有窗口的兜底。
- 排序是「得分高 → priority 大 → id 字典序」，与数组顺序无关。
- 优先用 `exeBasenames`，别用标题：标题里有项目名，用户一改就抖。

## 返回值契约

所有返回值都会过 `adapters/contracts.mjs` 的 `normalizeSnapshot`：

- `unit` 只能是 `money` / `credit` / `percent`，否则 `ok:false`
- 金额必须是有限数字；`byCurrency` 用来保留多币种，**不做汇率换算**
- 百分比夹到 `0..100`
- `supported:false` 时所有数值清空（`generic` 用）
- 抛异常会被兜住并记成 `ok:false` + `error`，不影响 daemon

## 缓存与频率

`daemon/src/billing.mjs` 统一做 **3 秒 TTL + 并发合并**。所以：

- 适配器会被每 3 秒调一次（浮层与面板同时问也只读一次盘）
- 失败**不缓存**，下一次立刻重试
- 不要自己再做长缓存；读大文件（如 transcript）可以在适配器内部按 mtime 记忆化

## 禁止事项

- **不要写宿主的文件/库**：一律只读打开（ZCode 的 sqlite 用 `readOnly: true`）。
- **不要猜金额**：识别不出厂商/模型就 `unit:'credit'` 或 `supported:false`，
  绝不套一个「差不多」的价目。ZCode 线的价目表是逐字节副本（D007）。
- **不要存密钥**：dock 不保存任何凭据；需要授权的能力（如 GLM 套餐查询）宁可不做（D008）。

## 测试要求

一个适配器至少要有：

1. `test/unit/<id>-adapter.test.mjs`：用**临时合成的数据源**（sqlite / jsonl）验证
   - 今日聚合（含边界：昨天、零 token、非 completed）
   - 预付/订阅行的处理
   - 上一轮/配额口径
   - 数据源缺失时返回可读错误
2. `test/integration/billing.itest.mjs` 里加一条：HTTP 链路能拿到该口径
3. 真实数据对账工具（强烈建议）：`tools/verify-<id>.mjs`，用宿主自己的实现或接口当基准，
   逐日比较金额与 tokens，容差写死在脚本里。

## 已知的两个坑（都踩过）

- **跨午夜**：一轮 agent 循环可能从前一天跑过 0 点。按事件归日会把一轮劈成两半，
  必须**按轮归并、按轮首事件归日**（D009）。
- **尾部截断**：大 transcript 只读尾部会系统性低估。默认窗口 32MB，
  并在结果里如实标记截断条数，不要假装完整。
