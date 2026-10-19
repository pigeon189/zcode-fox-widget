// 最小 ZIP 解包器（零依赖）：只支持 store(0) 与 deflate(8)，足够解 Electron 的
// Windows 发行包。校验：
//   · 拒绝 ../ 或绝对路径（zip slip）
//   · 只写普通文件与目录，忽略符号链接
//   · 解压后逐文件比对 CRC32（截断/损坏的包不会写出半个运行时）

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

function safeJoin(root, name) {
  const normalized = String(name).replace(/\\/g, '/')
  if (!normalized || normalized.endsWith('/')) return null
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error('zip: absolute path')
  const out = path.resolve(root, normalized)
  const rel = path.relative(root, out)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('zip: path traversal')
  return out
}

export function listZipEntries(buf) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('zip: end of central directory not found')
  const count = buf.readUInt16LE(eocd + 10)
  const size = buf.readUInt32LE(eocd + 12)
  const offset = buf.readUInt32LE(eocd + 16)
  if (offset + size > buf.length) throw new Error('zip: central directory out of range')
  const entries = []
  let p = offset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('zip: bad central directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    if (flags & 0x1) throw new Error('zip: encrypted entries are not supported')
    entries.push({ name, method, crc, compSize, rawSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export function extractZip(buf, destDir) {
  const entries = listZipEntries(buf)
  const written = []
  for (const entry of entries) {
    const out = safeJoin(destDir, entry.name)
    if (!out) continue
    const lh = entry.localOffset
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== LOC_SIG) throw new Error('zip: bad local header')
    const nameLen = buf.readUInt16LE(lh + 26)
    const extraLen = buf.readUInt16LE(lh + 28)
    const start = lh + 30 + nameLen + extraLen
    const comp = buf.slice(start, start + entry.compSize)
    if (comp.length !== entry.compSize) throw new Error('zip: truncated entry ' + entry.name)
    let data
    if (entry.method === 0) data = comp
    else if (entry.method === 8) data = zlib.inflateRawSync(comp)
    else throw new Error('zip: unsupported method ' + entry.method)
    if (data.length !== entry.rawSize) throw new Error('zip: size mismatch ' + entry.name)
    if (crc32(data) !== entry.crc) throw new Error('zip: crc mismatch ' + entry.name)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, data)
    written.push(out)
  }
  return written
}

export { crc32 }
