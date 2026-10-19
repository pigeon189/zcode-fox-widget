import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { crc32, extractZip, listZipEntries } from '../../shared/zip.mjs'

// 最小 ZIP 写入器：只用于测试（store 与 deflate 两种）。
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.from(e.data)
    const method = e.deflate ? 8 : 0
    const comp = e.deflate ? zlib.deflateRawSync(data) : data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, comp)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + comp.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

test('zip: store/deflate 往返，目录结构保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zip-'))
  try {
    const zip = makeZip([
      { name: 'electron.exe', data: Buffer.from('binary') },
      { name: 'resources/app.asar', data: Buffer.from('x'.repeat(1000)), deflate: true },
    ])
    const entries = listZipEntries(zip)
    assert.equal(entries.length, 2)
    const written = extractZip(zip, dir)
    assert.equal(written.length, 2)
    assert.equal(fs.readFileSync(path.join(dir, 'electron.exe'), 'utf8'), 'binary')
    assert.equal(fs.readFileSync(path.join(dir, 'resources', 'app.asar'), 'utf8').length, 1000)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('zip: 拒绝路径穿越与绝对路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zip-'))
  try {
    assert.throws(() => extractZip(makeZip([{ name: '../evil.exe', data: Buffer.from('x') }]), dir), /path traversal|absolute/)
    assert.throws(() => extractZip(makeZip([{ name: 'C:/evil.exe', data: Buffer.from('x') }]), dir), /absolute/)
    assert.throws(() => extractZip(makeZip([{ name: '/evil.exe', data: Buffer.from('x') }]), dir), /absolute/)
    assert.equal(fs.existsSync(path.join(dir, '..', 'evil.exe')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('zip: CRC 不符或截断的包被拒绝（不写出半个运行时）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-zip-'))
  try {
    const good = makeZip([{ name: 'electron.exe', data: Buffer.from('hello') }])
    const bad = Buffer.from(good)
    // 改掉数据区的第一个字节（local header 30 + name 12）
    bad[30 + 'electron.exe'.length] ^= 0xff
    assert.throws(() => extractZip(bad, dir), /crc mismatch|size mismatch|truncated/)
    assert.equal(fs.existsSync(path.join(dir, 'electron.exe')), false)
    assert.throws(() => extractZip(good.slice(0, 20), dir), /central directory/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
