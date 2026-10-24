// 高风险规则表（D036 / PLAN §6.4）。只影响 UI 保护措施（高风险不给热键允许、
// 「允许一次」不设为默认焦点），不替代宿主权限系统。
//
// 规则保持「一条一行」的表驱动形态：risk.test.mjs 用它做正反例审计，
// 改规则先改表再补用例。

// 命令执行类工具：命令文本命中任一模式即 high。
export const RISKY_SHELL_TOOLS = ['bash', 'sh', 'shell', 'zsh', 'powershell', 'pwsh', 'cmd', 'terminal']

// 大小写不敏感；逐条对应 PLAN §6.4 的清单。
export const RISKY_COMMAND_PATTERNS = [
  { id: 'rm-rf', re: /\brm\s+(?:-[a-z]+\s+)*-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/i, why: '递归强制删除' },
  { id: 'rm-r-f', re: /\brm\s+(?:[^;\n|]*\s)?-[a-z]*r\b[^;\n|]*\s+-[a-z]*f\b|\brm\s+(?:[^;\n|]*\s)?-[a-z]*f\b[^;\n|]*\s+-[a-z]*r\b/i, why: '递归强制删除' },
  { id: 'rmdir-s', re: /\brmdir\s+\/s/i, why: 'Windows 递归删目录' },
  { id: 'del-f', re: /\bdel\s+\/[fqs]/i, why: 'Windows 强制删除' },
  { id: 'format', re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { id: 'mkfs', re: /\bmkfs\b/i, why: '格式化文件系统' },
  { id: 'dd', re: /\bdd\s+if=/i, why: '裸设备写入' },
  { id: 'push-force', re: /\bgit\s+push\b[^|;&]*(?:--force(?![-\w])|\s-f\b)/i, why: '强制推送远端' },
  { id: 'reset-hard', re: /\bgit\s+reset\s+--hard\b/i, why: '丢弃本地改动' },
  { id: 'curl-sh', re: /\bcurl\b[^]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i, why: '下载并执行脚本' },
  { id: 'iwr-iex', re: /\biwr\b[^]*\|\s*iex\b|\binvoke-restmethod\b[^]*\|\s*iex\b/i, why: '下载并执行脚本' },
  { id: 'invoke-expression', re: /\binvoke-expression\b|\biex\b/i, why: '动态执行字符串' },
  { id: 'reg-write', re: /\breg\s+(?:add|delete)\b/i, why: '写注册表' },
  { id: 'net-user', re: /\bnet\s+user\b/i, why: '账户管理' },
  { id: 'sudo', re: /\bsudo\s+-?\w/i, why: '提权执行' },
  { id: 'chmod-777', re: /\bchmod\s+(?:-[a-z]+\s+)*777\b/i, why: '全开放权限' },
]

// 文件写/编辑类工具：目标路径出 cwd 或命中敏感路径即 high。
export const WRITER_TOOLS = ['write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'applypatch', 'filesystem']

// 敏感路径：写到这里无论是否出 cwd 都算 high。
export const SENSITIVE_PATH_PATTERNS = [
  { id: 'ssh', re: /\.ssh\b/i, why: 'SSH 配置/私钥目录' },
  { id: 'aws', re: /\.aws\b/i, why: '云凭据目录' },
  { id: 'env-file', re: /\.env(?!\.example\b)/i, why: '环境变量密钥文件' },
  { id: 'credentials', re: /credentials/i, why: '凭据文件' },
  { id: 'id-rsa', re: /id_rsa/i, why: '私钥文件' },
]

// 绝对路径形态（Windows 盘符 / POSIX 绝对 / ~ 开头）。
export const ABS_PATH_RE = /(?:[a-z]:[\\/][^\s"']*|(?<![\w.])[\\/][^\s"']+|~[\\/][^\s"']*)/gi

// 兜底名单之外的「未知工具」：预览为空时按 high 处理（fail-safe）。
export const KNOWN_SAFE_TOOLS = [
  'read', 'glob', 'grep', 'list', 'ls', 'search', 'fetch', 'webfetch', 'websearch',
  'todo', 'todowrite', 'todoread', 'task', 'taskoutput', 'taskcreate', 'taskupdate',
  'tasklist', 'taskstop', 'agent', 'memory', 'browser', 'computer', 'use',
  'notebook', 'notebookread', 'report', 'askuser', 'askuserquestion', 'exitingplan',
  'localtoolsearch', 'deferredtoolcall', 'skill', 'workflow', 'saveworkflow',
  'listmodels', 'listsavedworkflows', 'listworkflowruns', 'readsessioncontext',
  'offpeakcreate', 'offpeaklist', 'croncreate', 'crondelete', 'cronlist', 'cronupdate',
  'sendmessage', 'getworkflowrun', 'resumeworkflowrun', 'amendworkflow',
  'enterplanmode', 'exitplanmode', 'fillworkflowhole', 'resolveworkflowquestion',
  'mcp', 'visualize', 'excalidraw', 'mitm', 'securityscan',
]
