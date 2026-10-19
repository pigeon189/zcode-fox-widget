import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  const buf = Buffer.alloc(14)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  buf[13] = 0x3b
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
