import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'

import { crc32 } from '../../shared/zip.mjs'
import {
  MAX_ROLE_BYTES,
  deleteRole,
  importRole,
  inspectGif,
  inspectImage,
  inspectPng,
  listRoleLibrary,
  renameRole,
  suggestRoleId,
  validRoleId,
} from '../../daemon/src/roles.mjs'

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

function makePng(width = 2, height = 2) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function makeGif(width = 4, height = 6) {
  const buf = Buffer.alloc(28)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  // 逻辑屏幕描述符之后至少一个图像描述符和结束符；inspectGif 会检查这两项。
  buf[13] = 0x2c
  buf.writeUInt16LE(width, 18)
  buf.writeUInt16LE(height, 20)
  buf[22] = 0x02
  buf[23] = 0x02
  buf[24] = 0x44
  buf[25] = 0x01
  buf[26] = 0x00
  buf[27] = 0x3b
  return buf
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-roles-'))
const rolesDir = path.join(dir, 'roles')
const indexFile = path.join(dir, 'roles.json')

after(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

test('roles: PNG 校验只接受完整、尺寸合规的文件', () => {
  const png = makePng(16, 24)
  assert.deepEqual(inspectPng(png), { ok: true, width: 16, height: 24 })
  assert.throws(() => inspectPng(Buffer.from('not a png')), /不是 PNG/)
  const big = makePng(2049, 10)
  assert.throws(() => inspectPng(big), /2048/)
  const broken = Buffer.from(png)
  broken[20] ^= 0xff
  assert.throws(() => inspectPng(broken), /校验失败/)
  const noEnd = png.subarray(0, png.length - 12)
  assert.throws(() => inspectPng(noEnd), /不完整/)
  assert.throws(() => inspectPng(Buffer.alloc(MAX_ROLE_BYTES + 1)), /3MB/)
})

test('roles: id 白名单，内置 id 不可占用', () => {
  assert.equal(validRoleId('my-role'), true)
  assert.equal(validRoleId('fox'), false)
  assert.equal(validRoleId('A'), false)
  assert.equal(validRoleId('../evil'), false)
  assert.equal(validRoleId('a'.repeat(25)), false)
})

test('roles: 导入 / 列表 / 改名 / 删除', () => {
  const png = makePng(10, 12)
  const r = importRole({ rolesDir, indexFile, id: 'my-role', name: '我的角色', buffer: png })
  assert.equal(r.name, '我的角色')
  assert.ok(fs.existsSync(path.join(rolesDir, 'my-role.png')))
  const list = listRoleLibrary({ rolesDir, indexFile })
  assert.equal(list.filter((x) => x.builtin).length, 6)
  const imported = list.find((x) => x.id === 'my-role')
  assert.equal(imported.name, '我的角色')
  assert.equal(imported.builtin, false)

  assert.throws(() => importRole({ rolesDir, indexFile, id: 'my-role', name: 'x', buffer: png }), /已存在/)
  const renamed = renameRole({ rolesDir, indexFile, id: 'my-role', name: '新名字' })
  assert.equal(renamed.name, '新名字')
  assert.equal(listRoleLibrary({ rolesDir, indexFile }).find((x) => x.id === 'my-role').name, '新名字')

  assert.throws(() => deleteRole({ rolesDir, indexFile, id: 'fox' }), /内置/)
  assert.deepEqual(deleteRole({ rolesDir, indexFile, id: 'my-role' }), { removed: true })
  assert.equal(fs.existsSync(path.join(rolesDir, 'my-role.png')), false)
})

test('roles: GIF 导入保留动画格式，列表/删除按扩展名找到', () => {
  const gif = makeGif(32, 48)
  assert.deepEqual(inspectGif(gif), { ok: true, format: 'gif', width: 32, height: 48 })
  assert.equal(inspectImage(gif).format, 'gif')
  assert.equal(inspectImage(makePng()).format, 'png')
  assert.throws(() => inspectImage(Buffer.from('RIFF....WEBP')), /PNG \/ GIF/)
  // 只有文件头、没有图像描述符/结束符的 13 字节文件不能当成可显示 GIF
  const headerOnly = Buffer.alloc(13)
  headerOnly.write('GIF89a', 0, 'ascii')
  headerOnly.writeUInt16LE(4, 6)
  headerOnly.writeUInt16LE(6, 8)
  assert.throws(() => inspectGif(headerOnly), /图像数据|结束符/)
  const r = importRole({ rolesDir, indexFile, id: 'my-gif', name: '动图角色', buffer: gif })
  assert.equal(r.format, 'gif')
  assert.ok(fs.existsSync(path.join(rolesDir, 'my-gif.gif')))
  const listed = listRoleLibrary({ rolesDir, indexFile }).find((x) => x.id === 'my-gif')
  assert.equal(listed.image, 'roles/my-gif.gif')
  assert.equal(renameRole({ rolesDir, indexFile, id: 'my-gif', name: '新动图' }).name, '新动图')
  assert.deepEqual(deleteRole({ rolesDir, indexFile, id: 'my-gif' }), { removed: true })
  assert.equal(fs.existsSync(path.join(rolesDir, 'my-gif.gif')), false)
})

test('roles: 文件名由 id 决定，路径穿越 id 直接拒绝', () => {
  assert.throws(
    () => importRole({ rolesDir, indexFile, id: '../../evil', name: 'x', buffer: makePng() }),
    /角色 id/
  )
  assert.equal(fs.existsSync(path.join(dir, 'evil.png')), false)
})

test('roles: 建议 id 避开内置与已存在', () => {
  assert.equal(suggestRoleId('Fox'), 'fox-2')
  assert.equal(suggestRoleId('My Role!', ['my-role']), 'my-role-2')
})

// ---------- 宠物层 roles.js（浏览器全局脚本，用 vm 载入） ----------
//
// 这两组纯函数是 P0-1（按模型换角色）与 P0-2（每日预算）的判定核心，
// 不依赖 DOM，直接按浏览器里的全局作用域执行。

const petRoles = (() => {
  const source = fs.readFileSync(new URL('../../overlay/roles.js', import.meta.url), 'utf8')
  // 用当前 realm 执行：vm.createContext 会产生跨 realm 的对象原型，
  // deepStrictEqual 会把「结构相同」判成不同。脚本本身不碰 DOM，可以直接跑。
  vm.runInThisContext(source, { filename: 'overlay/roles.js' })
  return {
    foxRoleForModel: globalThis.foxRoleForModel,
    nextAutoRole: globalThis.nextAutoRole,
    budgetAlertOf: globalThis.budgetAlertOf,
    budgetAlertKey: globalThis.budgetAlertKey,
    localDateKey: globalThis.localDateKey,
    BUDGET_KEY_PREFIX: globalThis.BUDGET_KEY_PREFIX,
  }
})()

test('pet roles: 模型/厂商 → 角色族（模型优先、provider 兜底、大小写不敏感）', () => {
  const { foxRoleForModel } = petRoles
  assert.equal(foxRoleForModel('glm-4.7', ''), 'fox')
  assert.equal(foxRoleForModel('GLM-4.6V-Flash', ''), 'fox')
  assert.equal(foxRoleForModel('', 'zhipu'), 'fox')
  assert.equal(foxRoleForModel('deepseek-chat', ''), 'whale')
  assert.equal(foxRoleForModel('', 'dsh'), 'whale')
  assert.equal(foxRoleForModel('gpt-5.1', ''), 'gpt')
  assert.equal(foxRoleForModel('o3-mini', ''), 'gpt')
  assert.equal(foxRoleForModel('', 'openai'), 'gpt')
  assert.equal(foxRoleForModel('kimi-k2-0905-preview', ''), 'kimi')
  assert.equal(foxRoleForModel('', 'moonshot'), 'kimi')
  assert.equal(foxRoleForModel('claude-sonnet-4-5', ''), 'xiaoke')
  assert.equal(foxRoleForModel('', 'anthropic'), 'xiaoke')
  assert.equal(foxRoleForModel('gemini-3-pro', ''), 'gemini')
  assert.equal(foxRoleForModel('', 'google'), 'gemini')
  // 模型命中时不被 provider 改写
  assert.equal(foxRoleForModel('glm-4.7', 'anthropic'), 'fox')
  // 认不出就是 null，不猜
  assert.equal(foxRoleForModel('mystery-model', 'mystery'), null)
  assert.equal(foxRoleForModel('', ''), null)
  assert.equal(foxRoleForModel(null, undefined), null)
  // 短词不能被普通单词误伤（amazing 里没有独立 token 的 zai）
  assert.equal(foxRoleForModel('amazing-model', ''), null)
  assert.equal(foxRoleForModel('mistral-large', ''), null)
})

test('pet roles: 连续两拍才切；同一 capturedAt 不重复计数；族变化保留旧角色', () => {
  const { nextAutoRole } = petRoles
  const empty = { family: '', streak: 0, capturedAt: null, roleId: null }
  assert.deepEqual(nextAutoRole(empty, { model: 'glm-4.7', capturedAt: 1 }, true), {
    family: 'glm',
    streak: 1,
    capturedAt: 1,
    roleId: null,
  })
  const two = nextAutoRole({ family: 'glm', streak: 1, capturedAt: 1, roleId: null }, { model: 'glm-4.7', capturedAt: 2 }, true)
  assert.equal(two.roleId, 'fox')
  assert.equal(two.streak, 2)
  // 同一拍重复调用（多处渲染）不能把下一族提前切
  assert.deepEqual(nextAutoRole(two, { model: 'deepseek-chat', capturedAt: 2 }, true), two)
  // 族变化的第一拍：streak 归 1，仍显示旧角色
  const first = nextAutoRole(two, { model: 'deepseek-chat', capturedAt: 3 }, true)
  assert.equal(first.family, 'deepseek')
  assert.equal(first.streak, 1)
  assert.equal(first.roleId, 'fox')
  // 第二拍才真正切
  const switched = nextAutoRole(first, { model: 'deepseek-chat', capturedAt: 4 }, true)
  assert.equal(switched.roleId, 'whale')
  assert.equal(switched.streak, 2)
  // 认不出 → 清零回落到手动/档案角色
  const cleared = nextAutoRole(switched, { model: 'mystery', capturedAt: 5 }, true)
  assert.deepEqual(cleared, { family: '', streak: 0, capturedAt: 5, roleId: null })
})

test('pet roles: provider 兜底也能累计两拍；关闭开关立即清空', () => {
  const { nextAutoRole } = petRoles
  let s = nextAutoRole(null, { model: '', provider: 'anthropic', capturedAt: 10 }, true)
  assert.equal(s.streak, 1)
  s = nextAutoRole(s, { model: '', provider: 'anthropic', capturedAt: 11 }, true)
  assert.equal(s.roleId, 'xiaoke')
  // enabled=false：立即清空，重新开启必须重新累计两拍
  assert.deepEqual(nextAutoRole(s, { model: '', provider: 'anthropic', capturedAt: 12 }, false), {
    family: '',
    streak: 0,
    capturedAt: null,
    roleId: null,
  })
  const again = nextAutoRole(null, { model: '', provider: 'anthropic', capturedAt: 13 }, true)
  assert.equal(again.streak, 1)
  assert.equal(again.roleId, null)
})

test('pet roles: 预算阈值只认 ok+supported+未过期，金额/积分互不串门', () => {
  const { budgetAlertOf } = petRoles
  const money = { ok: true, supported: true, unit: 'money', today: { amount: 12, currency: 'CNY' } }
  assert.deepEqual(budgetAlertOf(money, { budgetMoney: 10 }), {
    kind: 'money',
    threshold: 10,
    amount: 12,
    currency: 'CNY',
  })
  assert.equal(budgetAlertOf({ ...money, today: { amount: 9.99, currency: 'CNY' } }, { budgetMoney: 10 }), null)
  assert.equal(budgetAlertOf(money, { budgetMoney: 0 }), null)
  assert.equal(budgetAlertOf({ ...money, ok: false }, { budgetMoney: 10 }), null)
  assert.equal(budgetAlertOf({ ...money, supported: false }, { budgetMoney: 10 }), null)
  assert.equal(budgetAlertOf({ ...money, stale: true }, { budgetMoney: 10 }), null)
  // 积分宿主只吃 budgetCredit；金额预算再低也不弹
  const credit = { ok: true, supported: true, unit: 'credit', today: { amount: 100, currency: 'CREDIT' } }
  assert.deepEqual(budgetAlertOf(credit, { budgetMoney: 1, budgetCredit: 100 }), {
    kind: 'credit',
    threshold: 100,
    amount: 100,
    currency: 'CREDIT',
  })
  assert.equal(budgetAlertOf(credit, { budgetMoney: 1, budgetCredit: 0 }), null)
  assert.equal(budgetAlertOf(money, { budgetMoney: 0, budgetCredit: 1 }), null, '金额宿主不弹积分预算')
})

test('pet roles: 预算去重键带日期/宿主/类型/阈值，旧日期键可识别', () => {
  const { budgetAlertKey, localDateKey, BUDGET_KEY_PREFIX } = petRoles
  assert.equal(localDateKey(new Date(2026, 9, 4, 12, 30).getTime()), '2026-10-04')
  assert.equal(localDateKey(new Date(2026, 0, 9, 0, 0).getTime()), '2026-01-09')
  assert.equal(BUDGET_KEY_PREFIX, 'fox-dock.budget.v1.')
  const key = budgetAlertKey('2026-10-04', 'zcode', 'money', 10)
  assert.equal(key, 'fox-dock.budget.v1.2026-10-04.zcode.money.10')
  assert.notEqual(
    key,
    budgetAlertKey('2026-10-04', 'zcode', 'money', 20),
    '改阈值必须生成新键才能再次提醒'
  )
  assert.notEqual(key, budgetAlertKey('2026-10-05', 'zcode', 'money', 10), '跨天必须重置')
  assert.equal(budgetAlertKey('2026-10-04', '', 'credit', 5), 'fox-dock.budget.v1.2026-10-04.-.credit.5')
})
