# 价目复核报告（2026-10-24）

全量复核九家厂商 API 价目，重点核对月之暗面今日发布的 **Kimi K3.1 Pro**。
价目源头 `lib/pricing.mjs`（本次经用户授权修改），`dock/engines/pricing.mjs`
为同步后的逐字节副本。单位均为「每百万 token」，币种随厂商官方口径（CNY/USD）。

**核对方法**：官方定价页直接比对；官方页为客户端渲染（Kimi、MiMo）或反爬
（OpenAI 403、Gemini 超时）时，用本机浏览器真实渲染官方页读取表格原文，或以
LiteLLM 官方注册表（`model_prices_and_context_window.json`，经 ghproxy 镜像拉取，
本机时间 2026-10-24）交叉验证。凡双源不一致或单源无法确认的数字一律不收录。

## 结论一览

| 厂商 | 结论 | 官方来源 | 核对日期 |
|---|---|---|---|
| Kimi/月之暗面 | **新增 K3.1 Pro(+highspeed)**，既有条目无变化 | platform.kimi.com/docs/pricing/chat | 2026-10-24 |
| DeepSeek | 无变化 | api-docs.deepseek.com/zh-cn/quick_start/pricing | 2026-10-24 |
| GLM/智谱 | 无变化；新增 FlashX-Legal 同价变体 | docs.bigmodel.cn/cn/guide/start/pricing | 2026-10-24 |
| OpenAI | 无变化；新增 Rosalind 研究系 | developers.openai.com/api/docs/pricing（403，搜索摘要+LiteLLM 双源） | 2026-10-24 |
| Anthropic/Claude | 无变化 | claude.com/pricing | 2026-10-24 |
| Qwen/阿里云 | 无变化 | help.aliyun.com/zh/model-studio/billing-for-model-studio | 2026-10-24 |
| MiniMax | **新增 M3.1-Flash**，M3 无变化 | platform.minimax.cn/docs/guides/pricing-paygo | 2026-10-24 |
| MiMo/小米 | 无变化 | mimo.mi.com/docs/zh-CN/pricing | 2026-10-24 |
| Gemini/Google | **未能直接核实**（官方页多次超时）；LiteLLM 交叉全部一致，沿用 2026-10-15 官方快照 | ai.google.dev/gemini-api/docs/pricing（本次不可达） | 2026-10-24 |

## Kimi K3.1 Pro（2026-10-24 发布当日收录）

官方渲染表原文（platform.kimi.com/docs/pricing/chat，本机浏览器当日读取）：

| 模型 | 输入 | 输出 | 缓存命中 | 缓存写 5min | 缓存写 1h |
|---|---|---|---|---|---|
| kimi-k3.1-pro | ¥13 | ¥68 | ¥1.30 | ¥13 | ¥26 |
| kimi-k3.1-pro-highspeed | ¥26 | ¥136 | ¥1.30 | ¥26 | ¥52 |

- 高速版与标准版同等智能、2~3 倍速，价格翻倍；**两档缓存命中价同为 ¥1.30**
  （第三方转述曾出现「标准版 ¥0.65」的说法，与官方表不符，已弃用）。
- 表内 `cw` 记 5min 档（TTL 缺省口径），1h 档价格留注释；另收 `k3.1-pro(-highspeed)`
  短名别名，防裸名被既有 `k3` 前缀匹配误套旧 K3 价（¥20/¥100）。
- 同页公告：K2 系列 2026-10-31 起停止向新用户开放、12 月底下线；kimi-k3（20/100/2/cw20）、
  kimi-k2.7-code（6.5/27/1.3）、k2.7-code-highspeed（13/54/2.6）、k2.6（6.5/27/1.1）
  现值与快照一致，条目保留。

## 各厂商明细

### DeepSeek（CNY，峰谷）——无变化
中文定价页核对：deepseek-flash（V4.1-Flash）输入 1/2、输出 4/8、缓存命中
0.02/0.04（空闲/高峰）；deepseek-v4-pro 输入 4.5/9、输出 13.5/27、缓存命中
0.15/0.3——与现表逐项一致。峰谷时段（工作日北京时间 9–12、14–18）与周末谷价
规则不变。注：官方同时明确**法定节假日全天谷价**，现实现仅处理周末（无节假日
表，已知简化，价目本身无变化，建议另立决策处理）。

### GLM/智谱（CNY）——无变化，新增 FlashX-Legal
5.3（8/28/2）、5.3-Flash（0.8/2.8/0.23）、5.3-FlashX（2/7/0.57）、5.2、5.1、
5-Turbo、5 各档与现表一致；无 5.4。官方页另列 **GLM-5.3-FlashX-Legal**
（与 FlashX 同价 2/7/0.57），按同价收录（此前该变体名精确匹配不到会漏计价）。
缓存存储仍为限时免费（cacheWrite 记 0）。

### OpenAI（USD）——无变化，新增 Rosalind 研究系
官方定价页仍 403（反爬）。LiteLLM 注册表逐项交叉：gpt-6-astra（10/50/读1/写12.5）、
gpt-6-sol、gpt-6.1-sol、gpt-6-luna、gpt-5.6 全系、daybreak 别名、gpt-5.5(-pro/-cyber)、
gpt-5.3 全部与现表一致，无 GPT-6.2。新增官方页已列的 **gpt-rosalind-discovery /
gpt-rosalind-research**：$5 / $25 / 缓存读 $0.50（官方页搜索摘要与 LiteLLM 双源
一致）；缓存写价官方标注不适用（research 档原文），记 0（宁可少算）；research
自 2026-10-05 起计费。

### Anthropic/Claude（USD）——无变化
claude.com/pricing 全表逐项一致：opus-5-5（4/20/读0.20/写5）、sonnet-5-5（2/10/
读0.10/写2.5）、haiku-5-5 两档（≤100K 0.1/0.5；>100K ×5）、fable-5-1（10/50/读
0.25/写12.5）、fable-5（读 1）、opus-5 与 4.x（5/25/读0.5/写6.25）、sonnet-5/4.x、
haiku-4-5。Mythos 官方并入 Fable 系列计价的口径不变；无更新模型。

### Qwen/阿里云（CNY）——无变化
华北2-北京按量原价全表核对：3.8-max（12/36）、3.7-max、3.7-plus（2/8、6/24）、
3.6-plus（2/12、8/48）、3.6-flash（1.2/7.2、4.8/28.8）、3.5-flash、3.8-flash
（0.8/2.7）、3.7-flash、3.5-plus、qwen-max（2.4/9.6）与现表一致；无 qwen4。
注：qwen3.8-max-prime 已不在官方价目页（条目按旧快照保留）；qwen3.7-plus 页面
标示限时 8 折，表列原价与现表一致（沿用偏高口径，不改）。缓存命中仍按隐式
命中价 20% 输入的保守口径（官方表格未列具体缓存单价）。

### MiniMax（CNY）——新增 M3.1-Flash
官方按量页（.com 已 302 至 minimax.cn）：M3 两档（2.1/8.4/读0.42 与 4.2/16.8/
读0.84）与现表一致。**新增 MiniMax-M3.1-Flash：输入 1 / 输出 4 / 缓存读 0.1**，
无长上下文分档；缓存写未公布记 0（与 M3 同口径）。M2.x 系（m2.7/m2.7-highspeed/
m2.5 及更早）已不在官方按量页、无下线公告，条目按旧快照保留。

### MiMo/小米（CNY）——无变化
官方定价页（mimo.mi.com/docs/zh-CN/pricing，跳转按量页）渲染表：mimo-v2.6-pro
（读0.025/3/6）、v2.6-flash（读0.02/1/2）、v2.6-pro-ultraspeed（读0.25/30/60）
与现表逐项一致；无 v2.7；v2.5 聊天系已不在页（仅 v2.5-asr 音频在列，与 10-21
下线注记相符，过渡期条目保留）。**缓存写官方原文「限时免费」**——记 0 由
「未公布」升级为有官方依据。

### Gemini/Google（USD）——未能直接核实，沿用快照
ai.google.dev/gemini-api/docs/pricing 本次三路尝试（抓取×3、渲染×1）全部超时
不可达。LiteLLM 注册表逐项交叉：gemini-4-argon（$2/$10/读$0.10 促销价）、
3.8/3.6-flash（$0.75/$3.75）、3.5/3.1-flash-lite、3.1-pro、3-flash-preview、
2.5 系全部与 2026-10-15 官方快照一致，无 Gemini 4 新型号。按规程沿用快照，
下次复核优先补官方页直核。

### cmdgo / relays（不涉及本次价目）
`lib/cmdgo.mjs` 只含 CommandCode 套餐 credit 额度与滚动窗口（非逐 token 价），
`lib/relays.mjs` 价格口径明确走 pricing.mjs 厂商价目——两者本次无需改动
（副本同步检查均通过）。

## 改动清单与验证

- `lib/pricing.mjs`：新增 kimi-k3.1-pro(+highspeed,+短名别名)、minimax-m3.1-flash、
  glm-5.3-flashx-legal、gpt-rosalind-discovery/research；文件头各家快照注记更新
  至 2026-10-24；既有条目分文未动。
- `dock/engines/pricing.mjs`：`node tools/check-pricing-sync.mjs --fix` 同步
  （复检输出「价目内核与挂件线一致（37802 字节）」）。
- `dock/test/unit/pricing.test.mjs`：新增 2 条测试钉死新价目（K3.1 Pro 四价 +
  短名防误匹配 + 金额 81 元/M+M；M3.1-Flash / FlashX-Legal / Rosalind），
  单文件 `node --test test/unit/pricing.test.mjs` 5/5 通过。
- 完成标准门禁：`cd dock && npm run ci` 全绿（412 单测 + lint + engines parity +
  check:sync）。
- 1.x 线 `tools/selftest.mjs` 未在本工作流内执行（属后续统一门禁）；静态核对：
  其钉死的价目断言（kimi-k3=20、glm-5.3-flash、mimo-v2.6-pro、gpt 各条、
  qwen3-max、claude 后缀名）全部是本次未改动的条目，且无遍历价目表的断言，
  新增键不影响其结果。
