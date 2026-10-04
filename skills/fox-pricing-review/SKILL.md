---
name: fox-pricing-review
description: 手动复核并更新 ZCode狐娘小挂件（zcode-fox-widget）的多厂商价目（lib/pricing.mjs）。当用户说「复核价目」「更新价目」「价目快照过期了」「核对某家厂商的价格」「DeepSeek/GLM/OpenAI/Claude/Qwen/MiniMax/MiMo/Kimi 调价了」时使用。本项目没有自动价目更新机制，所有价目更新都由用户发起、按本技能流程人工复核后写入仓库。
---

# ZCode狐娘小挂件 价目复核与更新

价目全部在 `lib/pricing.mjs`，文件头注释记录每家的**口径与来源及快照日期**。
复核 = 用权威来源核对现值 → 把有出入的条目改掉 → 同步断言与文档 → 走部署管道。
本项目**没有**定时任务/自动更新，一切以用户发起为准。

## 一、价目文件结构速览（lib/pricing.mjs）

- **文件头注释**：每家一行——计价口径、来源站点、快照日期。改价必须同步更新这里的日期与来源。
- **DeepSeek（CNY，峰谷）**：`PEAK_HOURS`（工作日北京时间 9–12、14–18 高峰）、`BASE_PRICE`/`PRO_PRICE`（`[空闲, 高峰]` 两档数组）、`PRICING` 模型注册表（模型名包含匹配 + `_default` 兜底）。周末全天谷价的生效日期在 `WEEKEND_VALLEY_FROM_SEC`。
- **GLM/BigModel（CNY，平价）**：`GLM_PRICE`，键为 normalize 后的精确模型名，值是 `(inTokens, outTokens) => {hit, miss, out}` 分档函数（输入 32K 档 / 输出 0.2K 档）。
- **其余六家**：`VENDOR_TABLES[vendor] = {currency, label, models}`，模型条目是**档位数组**，数据字典：
  - `maxIn`：该档输入 token 上限（省略 = 末档无上限）；**整单取档**——单次请求输入总量落哪档，整单按该档结算（`pickTier`）。
  - `hit`/`miss`/`out`：缓存读 / 未命中输入 / 输出价。
  - `cw`：缓存写价（省略 = 与 miss 同价；Kimi 按 TTL 分两档）。
  - `name`：档位名（展示用）。
- 模型匹配：`matchTableEntry` 精确名优先、最长前缀兜底（覆盖带日期后缀的模型 id）。
- **红线**：`splitInputTokens()` 的「input 含缓存」口径**绝不能动**——ZCode 的 input_tokens 是含缓存总输入，拆错会让金额虚高约 25 倍。

## 二、逐厂商复核清单

对每一家：① 打开官方价目页 → ② 与 LiteLLM 注册表交叉验证 → ③ 按下面核对点比对 → ④ 有出入才动手改。

| 厂商 | 官方来源 | 特别核对点 |
|---|---|---|
| DeepSeek | api-docs.deepseek.com（定价页） | 峰谷时段/周末谷价是否变化；缓存命中 0.1×输入、缓存写是否仍缺省 |
| GLM/BigModel | docs.bigmodel.cn/cn/guide/start/pricing | 输入 32K / 输出 0.2K 分档边界；thinking 计入输出价；缓存存储费 |
| OpenAI | platform.openai.com 反爬 403 → 用 community.openai.com 官方员工帖 + LiteLLM 交叉 | 272K 整单取档边界与倍率（×2 / ×1.5）；缓存命中 10% / 写 125% 的估算标注 |
| Claude | claude.com/pricing | 缓存写 1.25×输入；各家缓存读价的显式公布值 |
| Qwen | help.aliyun.com/zh/model-studio/billing-for-model-studio（华北2北京价，不做地域差价） | 输入分档边界（官方 K=1,000）；隐式缓存命中 20% 输入的保守口径 |
| MiniMax | platform.minimaxi.com/docs/guides/pricing-paygo | 512K 整单取档；缓存写未公布记 0 的条目是否有官方价了 |
| MiMo | platform.xiaomimimo.com / mimo.mi.com | 平价是否变化；夜间 0.8x 是订阅系数、不改 API 单价（只影响展示层） |
| Kimi | platform.kimi.com/docs/pricing/chat | 缓存写 TTL 两档（5min/1h）；TTL 缺省按 5min 档的口径 |

**LiteLLM 交叉验证**：拉取
`https://ghproxy.net/https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
（本机直连 github.com 超时，必须走 ghproxy 前缀），按 `model_name`/`litellm_provider` 找对应条目，核对 `input_cost_per_token`/`output_cost_per_token`/`cache_read_input_token_cost`/`cache_creation_input_token_cost`——LiteLLM 单位是**每 token**，本仓库是**每百万 token**，相差 10⁶。

**核对点（全厂商通用）**：单位（每百万 token）；币种（USD 条目挂在 `currency: "usd"` 表、CNY 挂 CNY 表，不混算）；分档边界是「单次请求输入总量」；缓存读写价；模型名前缀是否覆盖新发布的带日期后缀模型。

## 三、更新流程（有出入时）

1. **改 `lib/pricing.mjs`**：只改对应厂商的表；同步文件头该家的快照日期与来源注释；估算值保留行内注释惯例（如「缓存写未公布 → 按通行折扣 125% 输入估算」「cw 未公布记 0」）。
2. **改 `tools/selftest.mjs` 钉死断言**（数值全部写死，改价必改断言）：计价断言集中在「计价口径」段（GLM 系、DeepSeek 峰谷、GPT/Claude/Qwen/MiniMax/Kimi/MiMo 各一条）；另有若干**间接依赖价目的断言**（余额/今日已用、last-turn 金额、USD 折算）——按改动的厂商全数核对，跑 selftest 看哪条红改哪条。
3. **CHANGELOG.md**：新增 `## vX.Y.Z 调价：…` 小节，写明哪几家、什么口径变了、快照日期。
4. **版本号**：`lib/server.mjs` 的 `VERSION`、`.zcode-plugin/plugin.json`、`marketplace.json` 三处同步 +1。
5. **提交与部署**（仓库工作目录执行）：
   ```bash
   git add lib/pricing.mjs tools/selftest.mjs CHANGELOG.md .zcode-plugin/plugin.json marketplace.json lib/server.mjs
   git commit -m "pricing(vX.Y.Z): <厂商> 价目复核更新（快照 YYYY-MM-DD）"
   git --git-dir="<本仓库根目录>/.git" archive HEAD | tar -x -C "<本机插件缓存目录>"
   node lib/cli.mjs window restart && node lib/cli.mjs stop && node lib/cli.mjs start
   ```
6. **验证**：`node tools/selftest.mjs` 全绿 → `curl -s http://127.0.0.1:39321/whale/health` 版本正确 → `node lib/cli.mjs turn` 看上一轮逐档明细与改动一致 → 需要看气泡效果用 `node tools/demo.mjs`（假数据，不碰真实账单）。

## 四、只改展示、不改单价的情况

MiMo Token Plan 夜间 0.8x 这类「订阅额度系数」不进 `pricing.mjs` 的单价，它们在 `lib/source.mjs` 的展示层。复核时先分清「API 单价变了」还是「套餐系数变了」，改错文件会让金额口径错乱。

## 五、安全与纪律

- 价目是公开数据，可以入库；**任何凭据字面量不得写入源码/示例/测试**。
- 出站请求仅 http/https；抓 LiteLLM 走 ghproxy 镜像，官方站点用 WebFetch/WebSearch。
- 改仓库文件用 Write/Edit 工具（Bash 写源码会被安全门拦截）。
- 只复核用户点名的厂商即可，不必每次全量过一遍；全量复核建议每季度或用户主动要求时。
