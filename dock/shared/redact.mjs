// 脱敏（D036）：任何会发给 UI / 通知 / 日志的预览文本都先过这里。
//
// 顺序：已知密钥形态 → 主目录 → 「已隐藏」→ 截断。日志里永远不写原文。
// 目标是「宁可多藏一个普通 hash，也不漏一个密钥」；单测同时守住不误伤 UUID。

import os from 'node:os'

export const MASK = '「已隐藏」'

const RULES = [
  // OpenAI / DeepSeek / 通用 sk- key
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // Authorization: Bearer xxx
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
  // api_key = / token: / password= ...
  /\b(api[_-]?key|access[_-]?key|token|secret|password|passwd)\s*[=:]\s*["']?\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]+PRIVATE KEY-----|$)/g,
]

function homeVariants() {
  const home = process.env.USERPROFILE || os.homedir() || ''
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
