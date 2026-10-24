// schema 3：会话与权限设置
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS, normalizeSettings, readSettings, writeSettings } from '../../daemon/src/settings.mjs'

test('settings v3: 默认值（接管关闭、等待 15s、通知 whenHidden、保留 30 天）', () => {
  const s = normalizeSettings({})
  assert.equal(s.schema, 3)
  assert.deepEqual(s.live, { enabled: true })
  assert.deepEqual(s.permission, {
    takeover: false,
    waitMs: 15000,
    notify: 'whenHidden',
    hotkeys: { allow: 'Ctrl+Alt+Y', deny: 'Ctrl+Alt+N' },
  })
  assert.deepEqual(s.ingest, { enabled: true })
  assert.equal(s.retentionDays, 30)
})

test('settings v3: 未知字段丢弃、枚举夹取、等待时长取最近档', () => {
  const s = normalizeSettings({
    permission: { takeover: 'yes', waitMs: 16000, notify: 'nope', hotkeys: { allow: 'Win+Shift+F24', deny: 'bad' } },
    retentionDays: 500,
    live: { enabled: 'false', extra: 1 },
    ingest: { enabled: false },
    mystery: 1,
  })
  assert.equal(s.permission.takeover, false)
  assert.equal(s.permission.waitMs, 15000)
  assert.equal(s.permission.notify, 'whenHidden')
  assert.equal(s.permission.hotkeys.allow, 'Super+Shift+F24')
  assert.equal(s.permission.hotkeys.deny, DEFAULTS.permission.hotkeys.deny)
  assert.equal(s.retentionDays, 90)
  assert.equal(s.live.enabled, false)
  assert.equal('extra' in s.live, false)
  assert.equal(s.ingest.enabled, false)
  assert.equal('mystery' in s, false)
})

test('settings v3: 热键白名单（F1-F24 / 字母 / 拒绝中文与多余键）', () => {
  const s = normalizeSettings({
    hotkeys: { toggle: 'Ctrl+Alt+F13', console: 'Ctrl+Alt+YZ', hideMoney: 'Ctrl+Alt+中' },
    permission: { hotkeys: { allow: 'Shift+F24', deny: 'Alt+F25' } },
  })
  assert.equal(s.hotkeys.toggle, 'Ctrl+Alt+F13')
  assert.equal(s.hotkeys.console, DEFAULTS.hotkeys.console)
  // 中文/双字母热键在 Electron 里不可靠，回落默认
  assert.equal(s.hotkeys.hideMoney, DEFAULTS.hotkeys.hideMoney)
  assert.equal(s.permission.hotkeys.allow, 'Shift+F24')
  assert.equal(s.permission.hotkeys.deny, DEFAULTS.permission.hotkeys.deny)
})

test('settings v3: 部分写 permission 不会清掉 hotkeys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-set3-'))
  try {
    const file = path.join(dir, 'settings.json')
    writeSettings(file, { permission: { hotkeys: { allow: 'Ctrl+Alt+A' } } })
    const s = writeSettings(file, { permission: { takeover: true } })
    assert.equal(s.permission.takeover, true)
    assert.equal(s.permission.hotkeys.allow, 'Ctrl+Alt+A')
    assert.equal(s.permission.hotkeys.deny, 'Ctrl+Alt+N')
    assert.deepEqual(readSettings(file), s)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
