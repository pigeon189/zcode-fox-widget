import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULTS, normalizeSettings, readSettings, writeSettings } from '../../daemon/src/settings.mjs'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-set-'))
}

test('settings: 空文件/坏 JSON 都回默认值', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'settings.json')
    assert.deepEqual(readSettings(file), DEFAULTS)
    fs.writeFileSync(file, '{ not json')
    assert.deepEqual(readSettings(file), DEFAULTS)
    fs.writeFileSync(file, '[1,2,3]')
    assert.deepEqual(readSettings(file), DEFAULTS)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('settings: 未知字段被丢弃（设置文件不是任意数据通道）', () => {
  const s = normalizeSettings({ scale: 1.5, evil: '<script>', __proto__: { polluted: true } })
  assert.equal(s.scale, 1.5)
  assert.equal('evil' in s, false)
  assert.equal(Object.keys(s).sort().join(','), Object.keys(DEFAULTS).sort().join(','))
})

test('settings: 缩放和跟随间隔取最接近的档位', () => {
  assert.equal(normalizeSettings({ scale: 1.13 }).scale, 1.25)
  assert.equal(normalizeSettings({ scale: 0.7 }).scale, 0.75)
  assert.equal(normalizeSettings({ scale: 99 }).scale, 1.5)
  assert.equal(normalizeSettings({ followMs: 380 }).followMs, 500)
  assert.equal(normalizeSettings({ followMs: 1 }).followMs, 250)
  assert.equal(normalizeSettings({ followMs: 99999 }).followMs, 1000)
})

test('settings: 数值越界夹回，布尔接受字符串', () => {
  const s = normalizeSettings({
    scrollGap: -5,
    turnBubbleMs: 99999,
    budgetMoney: -1,
    quotaWarnPct: 130,
    showChip: 'false',
    alertBubble: 'true',
  })
  assert.equal(s.scrollGap, 0)
  assert.equal(s.turnBubbleMs, 15000)
  assert.equal(s.budgetMoney, 0)
  assert.equal(s.quotaWarnPct, 100)
  assert.equal(s.showChip, false)
  assert.equal(s.alertBubble, true)
})

test('settings: 角色只认内置 id，未知值回落 fox', () => {
  assert.equal(normalizeSettings({ roleId: 'kimi' }).roleId, 'kimi')
  assert.equal(normalizeSettings({ roleId: 'evil' }).roleId, 'fox')
  assert.equal(normalizeSettings({ roleId: null }).roleId, 'fox')
  // 随机台词间隔只留 0 / 3 / 5 / 10 分钟四档
  assert.equal(normalizeSettings({ chatterMs: 0 }).chatterMs, 0)
  assert.equal(normalizeSettings({ chatterMs: 170000 }).chatterMs, 180000)
  assert.equal(normalizeSettings({ chatterMs: 999999 }).chatterMs, 600000)
})

test('settings: 预算保留两位小数，NaN 当非法值', () => {
  assert.equal(normalizeSettings({ budgetMoney: 12.3456 }).budgetMoney, 12.35)
  assert.equal(normalizeSettings({ budgetMoney: 'abc' }).budgetMoney, 0)
  assert.equal(normalizeSettings({ budgetMoney: Infinity }).budgetMoney, 0)
})

test('settings: 写入是合并，不会清掉没改的字段', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'settings.json')
    let s = writeSettings(file, { scale: 1.25, budgetMoney: 20 })
    assert.equal(s.scale, 1.25)
    assert.equal(s.budgetMoney, 20)

    s = writeSettings(file, { showChip: false })
    assert.equal(s.scale, 1.25, '未提交的字段必须保留')
    assert.equal(s.budgetMoney, 20)
    assert.equal(s.showChip, false)
    assert.deepEqual(readSettings(file), s)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('settings: 主题 / 主数字 / 自动换角色 / 7 天开关只认枚举', () => {
  assert.equal(normalizeSettings({ theme: 'dark' }).theme, 'dark')
  assert.equal(normalizeSettings({ theme: 'purple' }).theme, 'auto')
  assert.equal(normalizeSettings({ displayMode: 'balance' }).displayMode, 'balance')
  assert.equal(normalizeSettings({ displayMode: 'nope' }).displayMode, 'auto')
  assert.equal(normalizeSettings({ autoRole: false }).autoRole, false)
  assert.equal(normalizeSettings({ autoRole: 'false' }).autoRole, false)
  assert.equal(normalizeSettings({ showWeek: false }).showWeek, false)
})

test('settings: rolesByAdapter 只接受已知宿主与已知角色', () => {
  const s = normalizeSettings({
    rolesByAdapter: {
      zcode: 'whale',
      kimi: 'kimi',
      workbuddy: 'evil',
      dsh: 'fox',
      unknown: 'fox',
      __proto__: 'x',
    },
  })
  assert.deepEqual(s.rolesByAdapter, { zcode: 'whale', kimi: 'kimi', dsh: 'fox' })
  assert.deepEqual(normalizeSettings({ rolesByAdapter: 'bad' }).rolesByAdapter, {})
  assert.deepEqual(normalizeSettings({ rolesByAdapter: [1, 2] }).rolesByAdapter, {})
})

test('settings: 2.0 字段写回后仍然合并保留', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'settings.json')
    let s = writeSettings(file, { theme: 'dark', rolesByAdapter: { kimi: 'whale' }, displayMode: 'quota' })
    assert.equal(s.theme, 'dark')
    assert.equal(s.displayMode, 'quota')
    assert.deepEqual(s.rolesByAdapter, { kimi: 'whale' })
    s = writeSettings(file, { scale: 1.25 })
    assert.equal(s.theme, 'dark')
    assert.deepEqual(s.rolesByAdapter, { kimi: 'whale' })
    assert.equal(readSettings(file).displayMode, 'quota')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
