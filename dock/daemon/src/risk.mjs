// 高风险判定（D036 / PLAN §6.4）：纯函数，只看「工具名 + 已脱敏预览 + cwd」。
// 结论只影响 fox-dock 自己的 UI 保护措施（不给热键允许、「允许一次」不设默认
// 焦点、卡片挂「高风险」徽标），不替代宿主权限系统——宿主该弹的窗照弹。

import {
  ABS_PATH_RE,
  KNOWN_SAFE_TOOLS,
  RISKY_COMMAND_PATTERNS,
  RISKY_SHELL_TOOLS,
  SENSITIVE_PATH_PATTERNS,
  WRITER_TOOLS,
} from './risk-rules.mjs'

function normSlash(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function extractPaths(preview) {
  const text = String(preview || '')
  const out = []
  ABS_PATH_RE.lastIndex = 0
  let m
  while ((m = ABS_PATH_RE.exec(text)) !== null) {
    const p = m[0].replace(/["'),.;:]+$/, '')
    if (p) out.push(p)
    if (out.length >= 16) break
  }
  return out
}

function insideCwd(p, cwd) {
  const c = normSlash(cwd)
  if (!c) return true
  const n = normSlash(p)
  return n === c || n.startsWith(c + '/')
}

export function assessRisk(input) {
  const src = input && typeof input === 'object' ? input : {}
  const tool = String(src.tool || '').trim().toLowerCase()
  const preview = String(src.preview || '')
  const cwd = String(src.cwd || '')
  const reasons = []

  const isShell = RISKY_SHELL_TOOLS.includes(tool)
  const isWriter = WRITER_TOOLS.includes(tool)

  if (isShell) {
    for (const rule of RISKY_COMMAND_PATTERNS) {
      if (rule.re.test(preview)) reasons.push('command:' + rule.id)
    }
  }

  if (isWriter) {
    const paths = extractPaths(preview)
    for (const p of paths) {
      if (!insideCwd(p, cwd)) reasons.push('outside-cwd')
      for (const rule of SENSITIVE_PATH_PATTERNS) {
        if (rule.re.test(p)) reasons.push('path:' + rule.id)
      }
    }
  } else if (tool) {
    // 非写工具的命令/参数里出现的敏感路径也提示（如 Bash 里的 ~/.ssh）。
    for (const rule of SENSITIVE_PATH_PATTERNS) {
      if (rule.re.test(preview)) reasons.push('path:' + rule.id)
    }
  }

  const known = isShell || isWriter || KNOWN_SAFE_TOOLS.includes(tool)
  if (tool && !known && !preview.trim()) reasons.push('unknown-tool-empty-preview')

  return { level: reasons.length ? 'high' : 'normal', reasons: [...new Set(reasons)] }
}

export function isHighRisk(input) {
  return assessRisk(input).level === 'high'
}
