// 集成插件里的 dock-hook.mjs 副本必须与源头逐字节一致（模式同价目副本同步）。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CANONICAL = path.join(ROOT, 'hooks', 'dock-hook.mjs')
const COPY = path.join(ROOT, 'integrations', 'zcode-plugin', 'hooks', 'dock-hook.mjs')

test('hook-sync: integrations 副本与 dock/hooks 源头逐字节一致', () => {
  const a = fs.readFileSync(CANONICAL)
  const b = fs.readFileSync(COPY)
  assert.ok(a.length > 0)
  assert.ok(a.equals(b), '副本漂移：用 node -e 或 cp 重新复制 dock/hooks/dock-hook.mjs 到 integrations/zcode-plugin/hooks/')
})

test('hook-sync: plugin.json 与 hooks.json 形态', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'zcode-plugin', '.zcode-plugin', 'plugin.json'), 'utf8'))
  assert.equal(plugin.hooks, 'hooks/hooks.json')
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'zcode-plugin', 'hooks', 'hooks.json'), 'utf8'))
  const names = Object.keys(hooks.hooks)
  assert.deepEqual(names.sort(), ['PermissionRequest', 'PostToolUseFailure', 'Stop', 'UserPromptSubmit'])
  assert.ok(!names.includes('PreToolUse'), '不得挂 PreToolUse（D035）')
  assert.ok(!names.includes('PostToolUse'), '不得挂 PostToolUse（D035）')
  const permTimeout = hooks.hooks.PermissionRequest[0].hooks[0].timeoutMs
  assert.equal(permTimeout, 30000)
  for (const name of ['UserPromptSubmit', 'Stop', 'PostToolUseFailure']) {
    assert.equal(hooks.hooks[name][0].hooks[0].timeoutMs, 5000)
  }
  // 本地市场入口：ZCode「添加本地目录」找的是根目录 marketplace.json
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, 'integrations', 'zcode-plugin', 'marketplace.json'), 'utf8'))
  assert.equal(market.plugins[0].source.path, '.')
  assert.equal(market.plugins[0].name, 'fox-dock-integration')
  // 钩子脚本自身声明的超时常量必须与 hooks.json 一致
  const src = fs.readFileSync(CANONICAL, 'utf8')
  assert.ok(src.includes('const HOOK_TIMEOUT_MS = 30000'))
})
