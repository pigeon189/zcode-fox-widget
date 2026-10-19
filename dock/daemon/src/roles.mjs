// 角色库（D030）：内置六个 + 用户导入。
//
// 导入是「任意文件加载通道」风险最高的一处，校验必须全部通过才落盘：
//   · 只收 PNG（签名 + 完整 chunk 遍历 + 每块 CRC）
//   · ≤3MB、宽高 1..2048
//   · id 白名单 /^[a-z0-9-]{2,24}$/，不能覆盖内置 id
//   · 只写 <data>/roles/<id>.png，文件名由 id 决定，不接受路径/URL
// 显示名存在 roles.json 索引里；内置角色不可改名/删除。

import fs from 'node:fs'
import path from 'node:path'
import { crc32 } from '../../shared/zip.mjs'
import { BUILTIN_ROLES } from '../../engines/paths.mjs'

export const MAX_ROLE_BYTES = 3 * 1024 * 1024
export const MAX_ROLE_DIM = 2048
export const BUILTIN_ROLE_IDS = BUILTIN_ROLES.map((r) => r.id)

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isBuiltinRole(id) {
  return BUILTIN_ROLE_IDS.includes(String(id || ''))
}

export function validRoleId(id) {
  const s = String(id || '')
  return /^[a-z0-9-]{2,24}$/.test(s) && !BUILTIN_ROLE_IDS.includes(s)
}

// 返回 { ok, width, height } 或抛错（错误信息可直接给界面/日志，不含文件内容）。
export function inspectPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) throw new Error('不是 PNG 文件')
  if (buf.length > MAX_ROLE_BYTES) throw new Error('图片超过 3MB')
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 文件（签名不符）')
  let p = 8
  let ihdr = null
  let ended = false
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p)
    if (len > buf.length - p - 12) throw new Error('PNG chunk 越界')
    const type = buf.subarray(p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    const expected = buf.readUInt32BE(p + 8 + len)
    const actual = crc32(Buffer.concat([type, data]))
    if (expected !== actual) throw new Error('PNG chunk 校验失败（文件损坏）')
    const name = type.toString('ascii')
    if (name === 'IHDR') {
      if (len !== 13) throw new Error('PNG IHDR 长度不正确')
      const width = data.readUInt32BE(0)
      const height = data.readUInt32BE(4)
      const bitDepth = data[8]
      const colorType = data[9]
      if (!width || !height) throw new Error('PNG 尺寸无效')
      if (width > MAX_ROLE_DIM || height > MAX_ROLE_DIM) throw new Error('图片尺寸超过 2048×2048')
      if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error('PNG 位深不支持')
      if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error('PNG 颜色类型不支持')
      ihdr = { width, height }
    }
    if (name === 'IEND') {
      ended = true
      break
    }
    p += 12 + len
  }
  if (!ihdr) throw new Error('PNG 缺少 IHDR')
  if (!ended) throw new Error('PNG 不完整（缺少 IEND）')
  return { ok: true, ...ihdr }
}

function indexFile(rolesDir, explicit) {
  return explicit || path.join(path.dirname(rolesDir), 'roles.json')
}

export function readRoleIndex(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object' && raw.roles && typeof raw.roles === 'object') return raw
  } catch (err) {}
  return { version: 1, roles: {} }
}

function writeRoleIndex(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

export function listRoleLibrary({ rolesDir, indexFile: file }) {
  const index = readRoleIndex(indexFile(rolesDir, file))
  const out = BUILTIN_ROLES.map((r) => ({
    id: r.id,
    name: r.name,
    accent: '',
    defaultFor: [],
    image: 'assets/roles/' + r.id + '.png',
    builtin: true,
  }))
  let names = []
  try {
    names = fs.readdirSync(rolesDir)
  } catch (err) {
    names = []
  }
  for (const name of names) {
    if (!/^[a-z0-9-]{2,24}\.png$/i.test(name)) continue
    const id = name.replace(/\.png$/i, '')
    if (BUILTIN_ROLE_IDS.includes(id) || out.some((r) => r.id === id)) continue
    out.push({
      id,
      name: String((index.roles[id] && index.roles[id].name) || id).slice(0, 24),
      accent: '',
      defaultFor: [],
      image: 'roles/' + name,
      builtin: false,
    })
  }
  return out
}

export function importRole({ rolesDir, indexFile: file, id, name, buffer, overwrite = false }) {
  const roleId = String(id || '').trim()
  if (!validRoleId(roleId)) throw new Error('角色 id 只能是小写字母/数字/连字符（2–24 位），且不能占用内置 id')
  const info = inspectPng(buffer)
  fs.mkdirSync(rolesDir, { recursive: true })
  const target = path.join(rolesDir, roleId + '.png')
  if (!overwrite && fs.existsSync(target)) throw new Error('同名角色已存在')
  const tmp = target + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, buffer)
  fs.renameSync(tmp, target)
  const index = readRoleIndex(indexFile(rolesDir, file))
  index.roles[roleId] = {
    name: String(name || roleId).trim().slice(0, 24) || roleId,
    at: Date.now(),
    width: info.width,
    height: info.height,
  }
  writeRoleIndex(indexFile(rolesDir, file), index)
  return { id: roleId, name: index.roles[roleId].name, width: info.width, height: info.height }
}

export function renameRole({ rolesDir, indexFile: file, id, name }) {
  const roleId = String(id || '')
  if (isBuiltinRole(roleId)) throw new Error('内置角色不能改名')
  const target = path.join(rolesDir, roleId + '.png')
  if (!validRoleId(roleId) || !fs.existsSync(target)) throw new Error('角色不存在')
  const clean = String(name || '').trim().slice(0, 24)
  if (!clean) throw new Error('名字不能为空')
  if (/[\u0000-\u001f]/.test(clean)) throw new Error('名字包含控制字符')
  const index = readRoleIndex(indexFile(rolesDir, file))
  index.roles[roleId] = { ...(index.roles[roleId] || {}), name: clean, at: Date.now() }
  writeRoleIndex(indexFile(rolesDir, file), index)
  return { id: roleId, name: clean }
}

export function deleteRole({ rolesDir, indexFile: file, id }) {
  const roleId = String(id || '')
  if (isBuiltinRole(roleId)) throw new Error('内置角色不能删除')
  if (!validRoleId(roleId)) throw new Error('角色不存在')
  const target = path.join(rolesDir, roleId + '.png')
  let removed = false
  try {
    fs.unlinkSync(target)
    removed = true
  } catch (err) {}
  const index = readRoleIndex(indexFile(rolesDir, file))
  if (index.roles[roleId]) {
    delete index.roles[roleId]
    writeRoleIndex(indexFile(rolesDir, file), index)
  }
  if (!removed) throw new Error('角色不存在')
  return { removed }
}

// 生成一个不会与现有角色冲突的 id（导入时界面可改）。
export function suggestRoleId(name, existing = []) {
  const base =
    String(name || 'role')
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 18) || 'role'
  let id = base.length >= 2 ? base : 'role'
  let n = 2
  while (existing.includes(id) || BUILTIN_ROLE_IDS.includes(id)) {
    id = (base.slice(0, 18) + '-' + n++).slice(0, 24)
  }
  return id
}
