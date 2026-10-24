# 猫娘按压音效（已内置）

定稿：**一声制**——按下播 `Nya1.wav`（喵声 0.810s），松手播 `Nya2.wav`（100ms 纯静音，即松手无声）。2026-10-22 于浮层多轮试听后定稿（试听比对记录见下方迭代链），定稿版评语「最干净最可爱」。素材字节与 GPT 交付完全一致，未做修改。

## 来源与授权

- 出处：Cici Fyre / *Free Catgirl Fighting Voice Pack*，`Meow/002_meow.wav`（GPT 加工线 `test8/03_playful_fall.wav` 切分）。
- 授权：作者页面标注 **CC0 1.0 Universal**（https://cicifyre.itch.io/free-catgirl-fighting-voice-pack ），商业/非商业可用，署名非强制；出处留档即为本文件。
- **授权二次核实（2026-10-22）**：对作者发布页做过一轮独立逐项核对，明确允许个人/商业使用、**随 GitHub 仓库公开发布**、剪辑变调格式转换等加工，署名非强制（作者欢迎）；无需另行联系作者取得许可。本文件与 NOTICE 的出处段是主动保留的署名。
- NOTICE 文本（正式内置化时采用）：

> Catgirl sound effects derived from `Meow/002_meow.wav` in *Free Catgirl Fighting Voice Pack* by Cici Fyre. Original asset: https://cicifyre.itch.io/free-catgirl-fighting-voice-pack . License: CC0 1.0 Universal. `Nya1` is the 0–0.810s onset segment (test9 `press_nya`, unchanged); `Nya2` is 100ms of digital silence used as a silent release.

## 素材规格与加工史

- `Nya1.wav`：44.1kHz / 16-bit / mono / 0.810s，峰值 -9.2 dBFS、平均 -21.3 dB（已用 -4.5 dB 增益与 duck/fx1 的 -9.4 / -9.9 dBFS 峰值、约 -21 dB 平均电平对齐）。= test8 `03_playful_fall.wav` 的 0–0.810s（含唯一一次 Nya 起音），test9 切分后仅做电平归一。
- `Nya2.wav`：44.1kHz / 16-bit / mono / 0.100s，样本全零，用作松手静音。
- 迭代链（GPT 音频迭代，每轮实机听感裁决）：test1 降调喵（两连声机械感）→ test9 衰减尾 -10dB（基本无声）→ test11 局部柔化 5 尖峰（毛刺除、孤立元音「a」突显）→ test11f 整段渐隐（余韵路线）→ test12 直切短尾 + 40ms 静音（定稿基础）→ **release 换纯静音（最终定稿）**。过程产物仅存于 `~/.zcode/whale/sounds/` 运行时与 Downloads 测试包，不入库。

## 接入要点（已内置）

- 定稿听感 = 仓库现有按压时序（`pressUp()` 短按在 press 结尾前约 100ms 起播 release）+ 本素材。GPT test12 README 建议改为「press 播完才起播」，但**定稿实测基于现有时序，内置化不改代码**；若上游将来调整时序，需重听确认。
- 最小改动清单（对 v1.16.2 谱系）：`lib/paths.mjs` `SOUND_SETS` 加 `nya` 条目（press `assets/Nya1.wav` / release `assets/Nya2.wav`）、内置音效名单加名字；无其它代码改动。
- 当前运行时部署：`~/.zcode/whale/sounds/` 自定义集「猫娘nya」（id `s2ae84f73c956`）+ selected 指向它——升级/重装插件不受影响，内置化前一直以自定义集形态使用。
