#!/usr/bin/env node
// M0 P-2 探针：ZCode PermissionRequest 钩子契约（只读探针，不入 CI）。
//
// 用法：
//   node tools/probe-zcode-hook.mjs --emit <payload.json>
//      把一份最小集成插件写到临时目录，并打印安装路径与验证步骤。
//   node tools/probe-zcode-hook.mjs --payload '<json>'
//      直接把 stdin 形状的 JSON 交给临时 hooks/hooks.json 里的命令跑一遍，
//      观察 stdout / exit code（默认命令是 dock/hooks/dock-hook.mjs，M5 提供）。
//
// 结论只需要回答四件事：
//   ① stdin JSON 的字段名 ② stdout JSON 能否表达 allow ③ exit 2 = deny
//   ④ 原生弹窗与钩子并行还是阻塞 ⑤ 超时后的行为
// 本探针不写宿主配置；插件目录由用户自己经「插件管理 → 本地市场」安装。

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
  version: '0.0.1',
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
            timeoutMs: 5000,
          },
        ],
      },
    ],
  },
}
const hookScript = `// fox-dock M0 probe hook: echo stdin, exit 0. Never blocks the host.
const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', () => {
  let raw = ''
  try { raw = Buffer.concat(chunks).toString('utf8') } catch (e) {}
  let parsed = null
  try { parsed = raw ? JSON.parse(raw) : null } catch (e) {}
  const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).sort() : []
  process.stdout.write(JSON.stringify({ probe: 'p2', keys, sample: parsed }) + '\\n')
  process.exit(0)
})
process.stdin.resume()
`

fs.mkdirSync(path.join(outDir, 'hooks'), { recursive: true })
fs.writeFileSync(path.join(outDir, 'plugin.json'), JSON.stringify(plugin, null, 2))
fs.writeFileSync(path.join(outDir, 'hooks', 'hooks.json'), JSON.stringify(hooks, null, 2))
fs.writeFileSync(path.join(outDir, 'hooks', 'probe-hook.mjs'), hookScript)

console.log('# ZCode 钩子探针（P-2）')
console.log('临时集成插件：' + outDir)
console.log('安装：ZCode → 插件管理 → 本地市场 → 添加该目录，然后触发一次权限确认。')
console.log('观察：钩子 stdout 是否出现 keys/sample；原生弹窗是否与钩子并行出现。')
console.log('待验证：stdout 是否能表达 allow（严格 schema，多余键会导致校验失败）；exit 2 是否等于 deny。')

if (payload) {
  const r = spawnSync(process.execPath, [path.join(outDir, 'hooks', 'probe-hook.mjs')], {
    input: Buffer.from(payload, 'utf8'),
    encoding: 'utf8',
    timeout: 8000,
  })
  console.log('\n--payload 运行结果 --')
  console.log('exit=' + (r.status == null ? 'null' : r.status))
  console.log('stdout=' + String(r.stdout || '').trim())
  console.log('stderr=' + String(r.stderr || '').trim())
}

if (fs.existsSync(path.join(ROOT, 'hooks', 'dock-hook.mjs'))) {
  console.log('\n检测到 dock/hooks/dock-hook.mjs：可用它替换 probe-hook.mjs 做真实链路验证。')
}
