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
  roleDefault: 'fox',         // 绑定后默认换成的角色（fox/whale/gpt/kimi/xiaoke/gemini）
  accent: '#f0a04b',          // 卡片强调色
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
          // 2.0：给面板的通用额度卡（可选）
          quotaCard: {
            kind: 'balance',             // windows | balance | plan | error
            title: 'MyAgent',
            subtitle: '按量付费',
            plan: '',
            account: '',
            windows: [],                 // windows 卡：{ key,label,usedPct,remainingPct,resetAt }
            balance: { amount: 1.23, currency: 'CNY' },
            note: '余额来自官方接口',
          },
          details: [{ label: '今日 tokens', value: '1.2K' }],
          usage: { todayTokens: 1200, turnTokens: 300 },
          plan: '按量',
          account: 'MyAgent',
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
- 网络接口应做**短 TTL 的内部缓存**，否则每 3 秒打一次官方接口：
  Kimi 额度 60s、DeepSeek 余额 30s、dsh 会话扫描 15s。
- 读大文件（如 transcript / 多帧 zstd）在适配器内部按 mtime 或当天记忆化。

## 凭据与写入边界

- **默认只读宿主**：ZCode sqlite 用 `readOnly: true`，WorkBuddy/dsh 的会话日志只读。
- **Kimi Code 是唯一例外**：它的 OAuth access token 只有 15 分钟，适配器必须在过期时
  用宿主自己的 refresh_token 刷新，并**原子写回同一个凭据文件**（否则 refresh token
  轮换后宿主会掉登录）。刷新只写 `~/.kimi-code/credentials/kimi-code.json`，
  不复制到 dock 配置、不打印 token。
- **不要在 dock 里另存密钥**：dsh 适配器只从 `~/.dsh/.credentials.yaml` 或
  `DEEPSEEK_API_KEY` 环境变量读取；需要授权的能力（如 GLM 套餐查询）宁可不做（D008）。

## 测试要求

一个适配器至少要有：

1. `test/unit/<id>-adapter.test.mjs`：用**临时合成的数据源**（sqlite / jsonl / zstd）验证
   - 今日聚合（含边界：昨天、零 token、非 completed、跨午夜）
   - 预付/订阅行的处理
   - 上一轮/配额口径（多窗口、单窗口、余额、Free 降级）
   - 数据源缺失 / 网络失败 / 坏数据时返回可读错误
   - 凭据过期/刷新/并发刷新（Kimi）
   - 多帧 zstd 与 subagent 会话（dsh）
2. `test/integration/billing.itest.mjs` 里加一条：HTTP 链路能拿到该口径
3. 浮层：`test/integration/overlay.itest.mjs` 覆盖额度卡、角色映射、主题、未绑定识别列表
4. 真实数据对账工具（强烈建议）：`tools/verify-<id>.mjs`，用宿主自己的实现或接口当基准，
   逐日比较金额与 tokens，容差写死在脚本里。

## 全厂商页与适配器的边界

「厂商」页**不是**一个新的适配器：它复用同机挂件线已经跑着的服务。

- dock 在 39321–39330（可用 `FOX_DOCK_VENDOR_PORTS` 覆盖）里探测 `/whale/health`；
  `app=zcode-fox-widget` 映射到 zcode，`app=fox-widget` 映射到 workbuddy。
- 读对应服务的 `/whale/vendors.json`，只保留 id/name/kind/currency/available/balance/
  percentRemaining/monthly/fiveHour/weekly 等展示字段，**丢掉 keySource/keyMasked**。
- 只连 127.0.0.1，端口来自白名单；30 秒缓存，健康探测 10 秒缓存。
- 这样不需要把 35 家厂商的密钥发现、接口差异、签名校验在 dock 里重写一遍；
  挂件线更新厂商模板，dock 自动跟上。挂件线没运行时，厂商页明确降级为「未找到服务」。

适配器仍然负责「这个窗口是谁、它自己的今日/余额是多少」；厂商页负责「这台机器上
已经配置的所有厂商余额/套餐」。两者在 UI 上分开，不混算。

## 已知的两个坑（都踩过）

- **跨午夜**：一轮 agent 循环可能从前一天跑过 0 点。按事件归日会把一轮劈成两半，
  必须**按轮归并、按轮首事件归日**（D009）。
- **尾部截断**：大 transcript 只读尾部会系统性低估。默认窗口 32MB，
  并在结果里如实标记截断条数，不要假装完整。
