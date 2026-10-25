#!/usr/bin/env node
// M0 P-2 探针：ZCode PermissionRequest 钩子契约（只读探针，不入 CI）。
//
// 用法：
//   node tools/probe-zcode-hook.mjs
//      把一份可切换模式的探针插件写到临时目录，打印安装路径与实验矩阵。
//   node tools/probe-zcode-hook.mjs --payload '<json>'
//      直接把 stdin 形状的 JSON 喂给生成的探针钩子跑一遍（本地冒烟）。
//   node tools/probe-zcode-hook.mjs --out <dir>
//      指定插件输出目录（默认临时目录）。
//
// 本探针不写宿主配置；插件目录由用户自己经「插件管理 → 本地市场」添加。
// 实验矩阵回答 M0 §3 的五问：
//   ① stdin JSON 的字段名 ② stdout JSON 能否表达 allow（严格 schema，多余键即校验失败）
//   ③ exit 2 = deny？ ④ 原生弹窗与钩子并行还是阻塞 ⑤ 超时后的行为

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const outDir = arg('--out', '') || path.join(os.tmpdir(), 'fox-dock-hook-probe-' + process.pid)
const payload = arg('--payload', '')

const plugin = {
  name: 'fox-dock-hook-probe',
  version: '0.0.2',
  description: 'fox-dock M0 probe: PermissionRequest hook contract only',
  author: { name: 'fox-dock' },
  license: 'MIT',
  hooks: 'hooks/hooks.json',
}
const hooks = {
  description: 'fox-dock M0 probe: PermissionRequest only',
  hooks: {
    PermissionRequest: [
      {
        hooks: [
          {
            type: 'process',
            command: 'node',
            args: ['${ZCODE_PLUGIN_ROOT}/hooks/probe-hook.mjs'],
            timeoutMs: 30000,
          },
        ],
      },
    ],
  },
}

// 每次触发都会把 stdin 原文与模式写进 probe-log.jsonl（时序证据）。
// 模式由同目录 mode.txt 控制（改完无需重装插件，下次触发即生效）；
// 存在 slow.txt 时先睡 6 秒再响应——用来判定宿主是「阻塞等钩子」还是「并行弹窗」。
const hookScript = `// fox-dock M0 P-2 probe hook. Never blocks the host beyond its mode.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
function readMode() {
  try { return fs.readFileSync(path.join(here, 'mode.txt'), 'utf8').trim() || 'echo' } catch (e) { return 'echo' }
}
function slow() { try { return fs.existsSync(path.join(here, 'slow.txt')) } catch (e) { return false } }
const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8')
  let parsed = null
  try { parsed = raw ? JSON.parse(raw) : null } catch (e) {}
  const mode = readMode()
  const rec = { at: new Date().toISOString(), mode, slow: slow(), tool: parsed && parsed.tool_name, raw }
  try { fs.appendFileSync(path.join(here, 'probe-log.jsonl'), JSON.stringify(rec) + '\\n') } catch (e) {}
  const out = (obj) => { process.stdout.write(JSON.stringify(obj) + '\\n') }
  const finish = () => {
    if (mode === 'allow-a') return out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'allow' } }) || 0
    if (mode === 'allow-a-denyword') return out({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'deny' } }) || 0
    if (mode === 'allow-b') return out({ permissionDecision: 'allow' }) || 0
    if (mode === 'allow-c') return out({ decision: { behavior: 'allow' } }) || 0
    if (mode === 'allow-d') return out({ continue: true, decision: 'approve' }) || 0
    if (mode === 'deny-2') { process.stderr.write('probe deny\\n'); return 2 }
    if (mode === 'silent') return 0
    const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).sort() : []
    out({ probe: 'p2', keys, sample: parsed })
    return 0
  }
  if (slow()) setTimeout(() => process.exit(finish()), 6000)
  else process.exit(finish())
})
process.stdin.resume()
`

fs.mkdirSync(path.join(outDir, 'hooks'), { recursive: true })
// ZCode 本地市场要求清单在 .zcode-plugin/plugin.json（与 dock/integrations 同构）；
// 「添加本地目录」找的是 marketplace.json（参照 zcode-auto-resume 的真实布局），
// 所以两个都写：插件根 + 自引用市场清单。
fs.mkdirSync(path.join(outDir, '.zcode-plugin'), { recursive: true })
fs.writeFileSync(path.join(outDir, '.zcode-plugin', 'plugin.json'), JSON.stringify(plugin, null, 2))
fs.writeFileSync(
  path.join(outDir, 'marketplace.json'),
  JSON.stringify(
    {
      name: 'fox-dock-probe-market',
      description: 'fox-dock P-2 探针市场（临时，测完删）',
      owner: { name: 'fox-dock' },
      plugins: [
        {
          name: 'fox-dock-hook-probe',
          source: { source: 'directory', path: '.' },
          description: 'fox-dock M0 probe: PermissionRequest hook contract only',
          version: '0.0.2',
          author: { name: 'fox-dock' },
          category: 'productivity',
        },
      ],
    },
    null,
    2
  )
)
fs.writeFileSync(path.join(outDir, 'hooks', 'hooks.json'), JSON.stringify(hooks, null, 2))
fs.writeFileSync(path.join(outDir, 'hooks', 'probe-hook.mjs'), hookScript)
fs.writeFileSync(path.join(outDir, 'hooks', 'mode.txt'), 'echo\n')

const matrix = [
  ['echo', '（基线）回显 keys/sample，exit 0 —— 验证字段名与链路'],
  ['allow-a', '输出 {"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"allow"}}'],
  ['allow-a-denyword', '同 a 但 permissionDecision:"deny" —— 验证 deny 字是否也走 stdout'],
  ['allow-b', '输出 {"permissionDecision":"allow"}（扁平候选）'],
  ['allow-c', '输出 {"decision":{"behavior":"allow"}}（Claude Code 风格候选）'],
  ['allow-d', '输出 {"continue":true,"decision":"approve"}（旧候选）'],
  ['deny-2', '不输出，exit 2 + stderr —— 验证 exit 2 = deny'],
  ['silent', '不输出，exit 0 —— 验证超时/静默时宿主是否弹原生窗'],
]

console.log('# ZCode 钩子探针（P-2）')
console.log('探针插件目录：' + outDir)
console.log('')
console.log('安装（不自动写宿主配置）：')
console.log('  1. ZCode → 插件管理 → 本地市场 → 添加上面目录 → 启用。')
console.log('  2. 让 ZCode 执行一条会触发权限确认的命令（例如让它跑一个未白名单的命令）。')
console.log('')
console.log('实验矩阵（每步：把插件目录 hooks/mode.txt 改成对应模式 → 重新触发权限请求 → 记录现象）：')
for (const [m, d] of matrix) console.log('  - ' + m.padEnd(18) + d)
console.log('')
console.log('每个模式记录四件事：')
console.log('  A. 工具是否直接放行（无原生弹窗）→ 该模式 = 支持 allow / deny 的证据')
console.log('  B. 原生弹窗是否仍出现 → stdout 未被采信')
console.log('  C. 弹窗是否等探针结束后才出现（配合 slow.txt：存在时先睡 6s）→ 阻塞 vs 并行')
console.log('  D. probe-log.jsonl 里的 stdin 字段名（① 的答案）')
console.log('')
console.log('结论回填：docs/dock/ADAPTERS.md 实时信号矩阵 + PLAN-pre.2-truth-layer.md §3 附注。')
console.log('注意：allow-a* 四个候选都失败时，M5 走分支 B（仅「拒绝」+「去宿主处理」）。')

if (payload) {
  const r = spawnSync(process.execPath, [path.join(outDir, 'hooks', 'probe-hook.mjs')], {
    input: Buffer.from(payload, 'utf8'),
    encoding: 'utf8',
    timeout: 12000,
  })
  console.log('\n--payload 本地冒烟（mode=echo） --')
  console.log('exit=' + (r.status == null ? 'null' : r.status))
  console.log('stdout=' + String(r.stdout || '').trim())
  console.log('stderr=' + String(r.stderr || '').trim())
}
