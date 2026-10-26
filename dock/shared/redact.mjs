// 脱敏（D036）：任何会发给 UI / 通知 / 日志的预览文本都先过这里。
//
// 顺序：已知密钥形态 → 主目录 → 「已隐藏」→ 截断。日志里永远不写原文。
// 目标是「宁可多藏一个普通 hash，也不漏一个密钥」；单测同时守住不误伤 UUID。

import os from 'node:os'

export const MASK = '「已隐藏」'

// 主目录统一替换成 ~：HTTP 会话响应、SSE、诊断包、窗口标题都走同一套规则，
// 避免某个读面漏掉完整用户名/主目录（review 2026-10-26 P3-1）。
// 用与 redact() 相同的转义正则 + 'gi' 替换（复审 R2-4）：split/join 只覆盖手工
// 变体，混合大小写形态（Windows 路径大小写不敏感，如 c:\USERS\x）会漏替。
export function redactHome(value) {
  let out = String(value == null ? '' : value)
  for (const home of homeVariants()) {
    const re = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    out = out.replace(re, '~')
  }
  return out
}

// JSON 凭据字段的键名（大小写不敏感）。单独抽出来是因为「完整键值对」与
// 「值被截断」两条规则共用同一张表。
const CREDENTIAL_KEY =
  '(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|credentials?|password|passwd|pwd|token|secret)'
const JSON_CRED_PAIR_RE = new RegExp('"' + CREDENTIAL_KEY + '"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"', 'gi')
const JSON_CRED_TRUNC_RE = new RegExp('"' + CREDENTIAL_KEY + '"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*$', 'i')

const RULES = [
  // OpenAI / DeepSeek / 通用 sk- key
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // Authorization: Bearer xxx
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
  // api_key = / token: / password= ...
  /\b(api[_-]?key|access[_-]?key|token|secret|password|passwd)\s*[=:]\s*["']?\S+/gi,
  // 命令行凭据参数：`--password <值>` / `--token=<值>` / `--api-key "<值>"`，以及
  // 空格分隔的复合长选项 `--access-token X` / `--auth-token X` / `--refresh-token X` /
  // `--client-secret X` / `--session-token X`（复审 R2-1：裸名规则只认 `--` 后紧跟
  // 裸名，`-token` 前是 `-` 不是空白，复合名整条漏出）。允许任意字母数字前缀 +
  // `-_` 分隔再接裸名；值约束保持不变（不吞 shell 语法/引号/重定向）。
  /(?<!\S)--?(?:[a-z0-9]+[-_])?(?:password|passwd|pwd|pass|token|secret|api[_-]?key)(?:\s*=\s*|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
  // 短选项紧贴值（mysql -pS3cr3t）：只认 `-p` 后紧跟「像凭据」的紧凑值——
  // 至少含一个非字母字符（数字/符号）。两条边界必须守住：
  //   ① 不能吞 shell 语法/引号/重定向：`bash -p<<<"rm -rf /"` 若整段被替换，
  //      后续风险判定就看不到 rm 了；
  //   ② 不能把 `find . -print` / `-pretty` / `-path` 这类纯字母长选项当凭据。
  // 代价是纯小写字母的口令（-pcorrecthorse）不会在这条规则里遮蔽，交给
  // --password/--token 等显式形式；含数字或符号的常见口令仍会命中。
  /(?<!\S)-p[A-Za-z0-9._~!@%^*+=:,\/@#-]*[0-9._~!@%^*+=:,\/@#-][A-Za-z0-9._~!@%^*+=:,\/@#-]*/g,
  // JSON 形态的凭据字段（钩子用 JSON.stringify 序列化 tool_input）：
  // {"token":"…"} / {"password": "…"}，值里允许转义引号。上面几条都要求键后
  // 直接是 `=`/`:`/空白，JSON 的 `"token":` 会整条漏过。
  JSON_CRED_PAIR_RE,
  // 值被截断在半截时（找不到收尾引号）：遮蔽到字符串末尾为止。
  JSON_CRED_TRUNC_RE,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]+PRIVATE KEY-----|$)/g,
]

function homeVariants() {
  // 统一来源顺序（复审 R2-4）：USERPROFILE → HOME → os.homedir()，与 redactHome
  // 旧实现一致；redact() 曾只读 USERPROFILE，两套矩阵不一致。
  const home = String(process.env.USERPROFILE || process.env.HOME || os.homedir() || '').trim()
  if (!home) return []
  return [...new Set([home, home.replace(/\\/g, '/'), home.toLowerCase(), home.replace(/\\/g, '/').toLowerCase()])].filter(Boolean)
}

export function redact(value, max = 400) {
  let s = String(value == null ? '' : value)
  for (const rule of RULES) {
    rule.lastIndex = 0
    s = s.replace(rule, MASK)
  }
  for (const home of homeVariants()) {
    // 大小写不敏感地替换主目录（Windows 路径与 POSIX 路径都覆盖）
    const re = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    s = s.replace(re, '~')
  }
  const cap = Number.isFinite(max) && max > 0 ? max : 400
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s
}

// 会话标题/错误消息用这个：保留可读性，但统一长度上限。
export function redactText(value, max = 200) {
  return redact(value, max)
}
