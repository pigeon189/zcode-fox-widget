// 设置层新增字段：budgetCredit（积分预算）与 autoRoleByModel（按模型自动换角色）
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS, normalizeSettings, readSettings, writeSettings } from '../../daemon/src/settings.mjs'

test('settings: budgetCredit 默认 0（关闭），夹取 0..1000000 并保留两位', () => {
  assert.equal(DEFAULTS.budgetCredit, 0)
  assert.equal(normalizeSettings({}).budgetCredit, 0)
  assert.equal(normalizeSettings({ budgetCredit: 0 }).budgetCredit, 0, '0 = 关闭')
  assert.equal(normalizeSettings({ budgetCredit: 12.345 }).budgetCredit, 12.35)
  assert.equal(normalizeSettings({ budgetCredit: -5 }).budgetCredit, 0, '负数夹回 0（关闭）')
  assert.equal(normalizeSettings({ budgetCredit: 1e9 }).budgetCredit, 1_000_000)
  assert.equal(normalizeSettings({ budgetCredit: 'abc' }).budgetCredit, 0)
  assert.equal(normalizeSettings({ budgetCredit: '25.5' }).budgetCredit, 25.5)
})

test('settings: autoRoleByModel 默认 true，显式 false 保留，非布尔回落默认', () => {
  assert.equal(DEFAULTS.autoRoleByModel, true)
  assert.equal(normalizeSettings({}).autoRoleByModel, true)
  assert.equal(normalizeSettings({ autoRoleByModel: false }).autoRoleByModel, false)
  assert.equal(normalizeSettings({ autoRoleByModel: 'false' }).autoRoleByModel, false)
  assert.equal(normalizeSettings({ autoRoleByModel: 'nope' }).autoRoleByModel, true)
  // 与宿主级 autoRole 互不影响（一个是按适配器默认、一个是按模型族）
  assert.equal(normalizeSettings({ autoRole: false }).autoRoleByModel, true)
  // 升级迁移：旧文件没有 autoRoleByModel、但已有手动 profile 选角 → false，
  // 避免升级后模型族角色覆盖用户原来的手动选择。
  assert.equal(normalizeSettings({ profiles: { zcode: { roleId: 'whale' } } }).autoRoleByModel, false)
  assert.equal(
    normalizeSettings({ profiles: { zcode: { roleId: 'whale' } }, autoRoleByModel: true }).autoRoleByModel,
    true,
    '显式开启不能被迁移覆盖'
  )
})

test('settings: 旧设置文件没有 autoRoleByModel 时按 profile 手动选角迁移', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-set-migrate-'))
  try {
    const withProfile = path.join(dir, 'with-profile.json')
    fs.writeFileSync(withProfile, JSON.stringify({ schema: 2, profiles: { zcode: { roleId: 'whale' } } }))
    assert.equal(readSettings(withProfile).autoRoleByModel, false, '升级前的手动选角不能被自动角色覆盖')

    const noProfile = path.join(dir, 'no-profile.json')
    fs.writeFileSync(noProfile, JSON.stringify({ schema: 2, profiles: {} }))
    assert.equal(readSettings(noProfile).autoRoleByModel, true, '没有手动选角的历史配置保持默认开')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('settings: 预算/自动换角色写入后读回一致，部分写不清掉另一个', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-set-budget-'))
  try {
    const file = path.join(dir, 'settings.json')
    const first = writeSettings(file, { budgetCredit: 250.5, autoRoleByModel: false })
    // schema 不因新增字段变化（仍是 3）
    assert.equal(first.schema, 3)
    assert.equal(first.budgetCredit, 250.5)
    assert.equal(first.autoRoleByModel, false)
    assert.equal('mystery' in first, false)

    const second = writeSettings(file, { budgetCredit: 0 })
    assert.equal(second.budgetCredit, 0)
    assert.equal(second.autoRoleByModel, false, '部分写不能把自动换角色重置回默认')

    const back = readSettings(file)
    assert.equal(back.schema, 3)
    assert.equal(back.budgetCredit, 0)
    assert.equal(back.autoRoleByModel, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
