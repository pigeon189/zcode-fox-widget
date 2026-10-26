// 高风险判定（D036 / PLAN §6.4）：纯函数，只看「工具名 + 判定文本 + cwd」。
// 判定文本应是 daemon 内存里的命令原文（见 ingest.mjs 的 riskText）：脱敏会
// 整段替换凭据参数，用脱敏后的 preview 判定会把可执行高危命令降成 normal。
// 结论只影响 fox-dock 自己的 UI 保护措施（不给热键允许、「允许一次」不设默认
// 焦点、卡片挂「高风险」徽标），不替代宿主权限系统——宿主该弹的窗照弹。

import os from 'node:os'
import {
  KNOWN_SAFE_TOOLS,
  RISKY_COMMAND_PATTERNS,
  RISKY_SHELL_TOOLS,
  SHELL_TOOL_VERBS,
  SENSITIVE_PATH_PATTERNS,
  WRITER_TOOLS,
  WRITER_TOOL_PREFIXES,
} from './risk-rules.mjs'

// 预览里的主目录已被 redact 换成 `~`，cwd 仍是真实路径。判定前先还原，
// 否则主目录下用正斜杠/`~/` 写的 in-cwd 目标会被误判成 outside-cwd。
function homeDir() {
  return process.env.USERPROFILE || os.homedir() || ''
}

function expandHome(p) {
  const s = String(p || '')
  const home = homeDir()
  if (!home) return s
  if (s === '~') return home
  if (s.startsWith('~/') || s.startsWith('~\\')) return home + s.slice(1)
  return s
}

function normSlash(p) {
  // JSON 预览里的 Windows 路径是双反斜杠（"D:\\\\proj"），先归一成单斜杠，
  // 否则 cwd 之内的合法写入会被误判成 outside-cwd。
  return String(p || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase()
}

// 写/编辑类工具只检查「目标路径」，不再把整段 tool_input（含写入内容）当路径
// 扫描：内容里的 `//` 注释、URL、`/api/v1` 这类绝对路径样文本会让 cwd 内的
// 普通编辑被判成 outside-cwd（PLAN §6.4 只约束目标路径）。
//
// 键名识别不能只靠白名单：MCP/自定义写工具的字段名千变万化（destination_file、
// dest_path、writePath、savePath、localPath、pathToSave …），漏掉一个就等于
// 「出 cwd 的写」完全失去保护。所以按「驼峰/分隔符切词 + 词表」判定：
//   · 任一 token 是 path/file/dir/destination/target/output/source 等 → 路径键；
//   · 末尾 token 是 content/text/body/data… 的一律当内容，不当路径。
const PATH_KEY_EXACT = /^(?:file_?path|filepath|file|files|filename|file_?name|path|paths|target|target_?path|target_?file|abs_?path|absolute_?path|destination|dest|dir|directory|old_?path|new_?path|notebook_?path|source|src|from|to|output|output_?path)$/i
const PATH_TOKENS = new Set([
  'path', 'paths', 'file', 'files', 'filename', 'filepath',
  'dir', 'dirs', 'directory', 'folder',
  'destination', 'dest', 'target', 'targets', 'notebook',
  'source', 'src', 'from', 'to', 'output',
])
const NON_PATH_TAIL_TOKENS = new Set([
  'content', 'contents', 'text', 'body', 'data', 'buffer', 'bytes', 'payload',
  'json', 'string', 'html', 'markdown', 'snippet', 'code', 'script', 'command', 'cmd',
])

function keyTokens(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function isPathKey(key) {
  const k = String(key || '').trim()
  if (!k) return false
  if (PATH_KEY_EXACT.test(k)) return true
  const tokens = keyTokens(k)
  if (!tokens.length) return false
  if (NON_PATH_TAIL_TOKENS.has(tokens[tokens.length - 1])) return false
  return tokens.some((t) => PATH_TOKENS.has(t))
}

// 截断的 JSON 也要能捞到路径键，所以键名不写死，命中 isPathKey 才算。
const KEYED_VALUE_RE = /"([A-Za-z_][A-Za-z0-9_-]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g
// 值可能停在半截：取键后的剩余片段（不跨引号）。
const KEYED_TRUNC_RE = /"([A-Za-z_][A-Za-z0-9_-]*)"\s*:\s*"([^"]*)$/

// 绝对路径形态（排除 `//` 开头的 URL/协议相对路径与协议串）。
function isAbsLike(p) {
  const s = String(p || '').trim()
  if (!s) return false
  if (/^[a-z]:[\\/]/i.test(s)) return true
  if (/^~[\\/]/.test(s)) return true
  if (s.startsWith('\\\\')) return true // Windows UNC
  return /^[\\/](?![\\/])/.test(s) // POSIX 绝对路径
}

function collectPathValue(v, out) {
  if (out.length >= 16 || v == null) return
  if (typeof v === 'string') {
    if (v.trim()) out.push(v)
    return
  }
  if (Array.isArray(v)) for (const x of v) collectPathValue(x, out)
}

function walkJson(value, out, depth = 0) {
  if (out.length >= 16 || value == null || depth > 4 || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const v of value) walkJson(v, out, depth + 1)
    return
  }
  for (const [k, v] of Object.entries(value)) {
    if (isPathKey(k)) collectPathValue(v, out)
    // 路径字段也可能是对象/数组（{target:{path:"…"}}、[{file_path:…}]），继续下钻。
    if (v && typeof v === 'object') walkJson(v, out, depth + 1)
  }
}

function collectKeyedPaths(text, out) {
  KEYED_VALUE_RE.lastIndex = 0
  let m
  while (out.length < 16 && (m = KEYED_VALUE_RE.exec(text)) !== null) {
    if (!isPathKey(m[1])) continue
    let v = m[2]
    try {
      v = JSON.parse('"' + v + '"')
    } catch (err) {}
    if (v) out.push(v)
  }
  if (!out.length) {
    const t = KEYED_TRUNC_RE.exec(text)
    if (t && isPathKey(t[1]) && t[2]) out.push(t[2])
  }
}

// apply_patch / git diff 的目标路径：按行匹配，并兼容「整个 patch 被塞进 JSON
// 字符串」的形态（换行是字面 `\n`、路径里是双反斜杠）。只认文件头，不扫内容。
const PATCH_STAR_LINE_RE = /^\s*\*\*\*\s+(?:(?:Update|Add|Delete)\s+File|Move\s+to):\s*(.+?)\s*$/
const PATCH_DIFF_LINE_RE = /^\s*(?:---|\+\+\+)\s+[ab]\/(\S+)\s*$/

function unescapeIfJson(value) {
  const s = String(value || '')
  if (!s.includes('\\\\')) return s
  try {
    return JSON.parse('"' + s + '"')
  } catch (err) {
    return s
  }
}

function collectPatchPaths(text, out) {
  for (const line of String(text || '').split(/\r?\n|\\n/)) {
    if (out.length >= 16) return
    const star = PATCH_STAR_LINE_RE.exec(line)
    if (star) {
      out.push(unescapeIfJson(star[1]))
      continue
    }
    const diff = PATCH_DIFF_LINE_RE.exec(line)
    if (diff) out.push(unescapeIfJson(diff[1]))
  }
}

// 从 tool_input 预览里挑出「写目标路径」候选。
function writerPaths(tool, preview) {
  const text = String(preview || '')
  const trimmed = text.trim()
  const out = []
  // patch 文件头只在「这确实是 patch 内容」时才当真（工具名带 patch/diff 或
  // tool_input 有 patch/diff 字段）；否则写入正文里的 patch 片段会被误当目标路径。
  const base = baseToolName(tool)
  const patchish = base.includes('patch') || base.includes('diff') || /"(?:patch|diff)"\s*:/.test(text)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed = null
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {}
    if (parsed) walkJson(parsed, out)
    // JSON 被截断或结构不认识时，只认路径键值，不扫写入内容。
    if (!out.length) collectKeyedPaths(text, out)
    if (patchish) collectPatchPaths(text, out)
    return out
  }
  // 纯文本：整段就是一个路径（旧协议的裸路径预览，含带 `..` 的相对路径）；
  // 否则只认路径键 / patch 头。URL 不当路径。
  const looksRelativePath = /[\\/]/.test(trimmed) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  if (!/\s/.test(trimmed) && (isAbsLike(trimmed) || looksRelativePath)) {
    out.push(trimmed)
    return out
  }
  collectKeyedPaths(text, out)
  if (patchish || /^\s*\*\*\*\s+Begin Patch/m.test(text)) collectPatchPaths(text, out)
  return out
}

const DRIVE_ROOT_RE = /^[a-z]:$/

// 消解路径里的 `.` / `..`：D:/proj/demo/../../Windows/x 要归一成
// D:/Windows/x 再比 cwd，否则带 `..` 的越界目标会被判成「在 cwd 内」。
// 盘符/根不能弹栈，相对路径前缀的 `..` 原样保留。
function resolveDots(p) {
  const n = normSlash(p).replace(/\/{2,}/g, '/')
  const abs = n.startsWith('/')
  const out = []
  for (const part of n.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length && !DRIVE_ROOT_RE.test(out[out.length - 1])) out.pop()
      else if (!out.length && !abs) out.push('..')
      continue
    }
    out.push(part)
  }
  return (abs ? '/' : '') + out.join('/')
}

// 写目标是否越出 cwd。相对路径按 cwd 解析后再判：`..\..\Windows\hosts` 这类
// 带 `..` 的相对目标同样能判定越界；普通相对路径（src/a.mjs）解析后仍在 cwd
// 内，保持 normal。没有 cwd 时无法判定，维持既有「不升级」。
function outsideCwd(p, cwd) {
  const base = resolveDots(expandHome(cwd))
  if (!base) return false
  const target = isAbsLike(p)
    ? resolveDots(expandHome(p))
    : resolveDots(base + '/' + expandHome(p))
  return !(target === base || target.startsWith(base + '/'))
}

// 工具名归一：MCP 形如 mcp__filesystem__write_file 或 server:write_file，
// 取最后一段（保留原始大小写，供驼峰切词）。
function rawBaseToolName(tool) {
  const segs = String(tool || '').split('__')
  let base = segs[segs.length - 1] || ''
  if (base.includes(':')) base = base.split(':').pop()
  return base.trim()
}

function baseToolName(tool) {
  return rawBaseToolName(tool).toLowerCase().replace(/[-.\s]/g, '')
}

// 按驼峰与分隔符切词：runCommand / run_command / run.command → ['run','command']。
function toolTokens(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase())
}

// 命令执行工具判定：精确名之外，MCP/自定义工具名里的动词也算（run_command、
// execute_shell、shell:bash…）。用整词匹配，runtime_info / show_output 不会
// 因为前缀像 run/sh 被误判。
export function isShellTool(tool) {
  const raw = String(tool || '').trim()
  const t = raw.toLowerCase()
  if (!t) return false
  if (RISKY_SHELL_TOOLS.includes(t)) return true
  const base = baseToolName(t)
  if (!base) return false
  if (RISKY_SHELL_TOOLS.includes(base)) return true
  // 用原始大小写切词，runCommand 才会拆成 run + Command。
  return toolTokens(rawBaseToolName(raw)).some((tok) => RISKY_SHELL_TOOLS.includes(tok) || SHELL_TOOL_VERBS.includes(tok))
}

// 写工具判定：精确名单之外，MCP/自定义工具的写动词前缀也算写工具。
// 读类工具（read_file、list_directory）不命中前缀，保持 normal。
export function isWriterTool(tool) {
  const t = String(tool || '').trim().toLowerCase()
  if (!t) return false
  if (WRITER_TOOLS.includes(t)) return true
  const base = baseToolName(t)
  if (!base) return false
  if (WRITER_TOOLS.includes(base)) return true
  return WRITER_TOOL_PREFIXES.some((p) => base.startsWith(p))
}

export function assessRisk(input) {
  const src = input && typeof input === 'object' ? input : {}
  // 保留原始大小写：isShellTool 的驼峰切词（runCommand → run + Command）依赖它，
  // 先 toLowerCase 会把驼峰粘成一个词，camelCase 的命令执行工具就漏判了。
  const toolRaw = String(src.tool || '').trim()
  const tool = toolRaw.toLowerCase()
  const preview = String(src.preview || '')
  const cwd = String(src.cwd || '')
  const reasons = []

  const isShell = isShellTool(toolRaw)
  const isWriter = isWriterTool(tool)

  // 宿主自报的高风险（P-2 实测 stdin 带 riskLevel）只用来升级、从不降级：
  // 本仓库规则表认不出时也不能把宿主的结论抹成 normal。
  if (String(src.hostRisk || '').trim().toLowerCase() === 'high') reasons.push('host-high')

  if (isShell) {
    for (const rule of RISKY_COMMAND_PATTERNS) {
      if (rule.re.test(preview)) reasons.push('command:' + rule.id)
    }
  }

  if (isWriter) {
    // 只看目标路径（file_path/path/apply_patch 头），不扫写入内容。
    const paths = writerPaths(tool, preview)
    for (const p of paths) {
      if (outsideCwd(p, cwd)) reasons.push('outside-cwd')
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

  // 兜底仍按「精确名单」算已知工具：isShell 现在是启发式，若拿它算 known，
  // mcp__x__run_command 这类带空预览的权限请求会从 fail-safe 的 high 掉成 normal。
  const known = RISKY_SHELL_TOOLS.includes(tool) || isWriter || KNOWN_SAFE_TOOLS.includes(tool)
  if (tool && !known && !preview.trim()) reasons.push('unknown-tool-empty-preview')

  return { level: reasons.length ? 'high' : 'normal', reasons: [...new Set(reasons)] }
}

export function isHighRisk(input) {
  return assessRisk(input).level === 'high'
}
