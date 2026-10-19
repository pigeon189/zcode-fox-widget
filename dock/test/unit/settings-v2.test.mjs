import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULTS,
  getProfile,
  migrateSettingsFile,
  normalizePet,
  normalizeSettings,
  readSettings,
  writeProfile,
  writeSettings,
} from '../../daemon/src/settings.mjs'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-set2-'))
}

test('settings v2: 默认 schema=2，档案与宠物状态都有默认值', () => {
  const s = normalizeSettings({})
  assert.equal(s.schema, 2)
  assert.deepEqual(s.profiles, {})
  assert.deepEqual(s.pet, DEFAULTS.pet)
  assert.equal(s.hotkeys.toggle, 'Ctrl+Alt+F')
})

test('settings v2: v1 文件迁移会备份原文件并补 schema/档案/宠物', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ roleId: 'kimi', scale: 1.25, mystery: 1 }))
    const s = readSettings(file)
    assert.equal(s.schema, 2)
    assert.equal(s.roleId, 'kimi')
    assert.equal(s.scale, 1.25)
    assert.equal('mystery' in s, false)
    assert.ok(fs.existsSync(file + '.v1.bak'), '迁移前必须留一份备份')
    const backup = JSON.parse(fs.readFileSync(file + '.v1.bak', 'utf8'))
    assert.equal(backup.roleId, 'kimi', '备份必须是原文件内容')
    const again = readSettings(file)
    assert.deepEqual(again, s)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('settings v2: schema=2 的文件不会被再次迁移', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, JSON.stringify(normalizeSettings({ roleId: 'gpt' })))
    assert.equal(migrateSettingsFile(file), false)
    assert.equal(fs.existsSync(file + '.v1.bak'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('settings v2: 档案缺省继承全局，覆盖只影响该 agent', () => {
  const s = normalizeSettings({
    roleId: 'fox',
    displayMode: 'today',
    turnBubbleMs: 7000,
    profiles: {
      zcode: { roleId: 'whale', turnBubbleMs: 9000 },
      workbuddy: { roleId: 'evil' },
      unknown: { roleId: 'kimi' },
    },
  })
  const z = getProfile(s, 'zcode')
  assert.equal(z.roleId, 'whale')
  assert.equal(z.displayMode, 'today', '未覆盖字段继承全局')
  assert.equal(z.turnBubbleMs, 9000)
  const w = getProfile(s, 'workbuddy')
  assert.equal(w.roleId, 'fox', '非法角色回落全局')
  assert.equal(getProfile(s, 'unknown').roleId, 'fox')
  assert.equal(getProfile(s, 'kimi').roleId, 'fox')
})

test('settings v2: 写档案按 agent 深合并，不动其它 agent', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'settings.json')
    writeProfile(file, 'zcode', { roleId: 'whale', turnBubble: false })
    writeProfile(file, 'kimi', { roleId: 'kimi' })
    writeProfile(file, 'zcode', { turnBubbleMs: 8000 })
    const s = readSettings(file)
    assert.equal(s.profiles.zcode.roleId, 'whale')
    assert.equal(s.profiles.zcode.turnBubble, false)
    assert.equal(s.profiles.zcode.turnBubbleMs, 8000)
    assert.equal(s.profiles.kimi.roleId, 'kimi')
    assert.throws(() => writeProfile(file, 'unknown', {}), /unknown agent/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('settings v2: pet 归一化（attached 清 agentId 之外的模式、floating 补 profileOf）', () => {
  const a = normalizePet({ mode: 'attached', agentId: 'zcode', hwnd: '0x1' })
  assert.equal(a.mode, 'attached')
  assert.equal(a.agentId, 'zcode')
  const bad = normalizePet({ mode: 'attached', agentId: 'evil', hwnd: '0x1' })
  assert.equal(bad.agentId, '')
  const f = normalizePet({ mode: 'floating', lastAgentId: 'kimi' })
  assert.equal(f.profileOf, 'kimi')
  const i = normalizePet({ mode: 'idle', profileOf: 'zcode' })
  assert.equal(i.profileOf, '')
})

test('settings v2: 热键空串=关闭，非法值回落默认', () => {
  const s = normalizeSettings({ hotkeys: { toggle: '', console: 'Ctrl+Shift+K', hideMoney: 'bad' } })
  assert.equal(s.hotkeys.toggle, '')
  assert.equal(s.hotkeys.console, 'Ctrl+Shift+K')
  assert.equal(s.hotkeys.hideMoney, DEFAULTS.hotkeys.hideMoney)
})

test('settings v2: 新旧字段一起写回仍然稳定', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'settings.json')
    writeSettings(file, { theme: 'dark', profiles: { dsh: { roleId: 'whale' } } })
    const s = writeSettings(file, { scale: 1.5, pet: { mode: 'floating', lastAgentId: 'dsh' } })
    assert.equal(s.theme, 'dark')
    assert.equal(s.scale, 1.5)
    assert.equal(s.profiles.dsh.roleId, 'whale')
    assert.equal(s.pet.mode, 'floating')
    assert.equal(s.pet.profileOf, 'dsh')
    assert.deepEqual(readSettings(file), s)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
