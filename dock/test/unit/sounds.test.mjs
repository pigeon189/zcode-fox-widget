// M-S 音效库：导入/删除/回放/回落/旧集复制（对齐 1.x selftest 语义）
import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-sounds-'))
process.env.FOX_DOCK_DATA = path.join(dir, 'data')
const settingsFile = path.join(dir, 'data', 'settings.json')

const { sniffAudio, listSounds, saveSoundSet, deleteSoundSet, resolveSoundBytes, importLegacySounds } = await import(
  '../../daemon/src/sounds.mjs'
)
const { writeSettings } = await import('../../daemon/src/settings.mjs')

function wavBytes(ms = 50) {
  const rate = 8000
  const n = Math.max(1, Math.round((rate * ms) / 1000))
  const data = Buffer.alloc(n * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const dataUrl = (buf, type = 'wav') => 'data:audio/' + type + ';base64,' + buf.toString('base64')

before(() => {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  writeSettings(settingsFile, {})
})

after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {}
})

test('sounds: 内置三套齐全且默认 duck', () => {
  const r = listSounds(settingsFile)
  assert.deepEqual(
    r.sets.filter((s) => s.builtin).map((s) => s.id),
    ['duck', 'fx1', 'nya']
  )
  assert.equal(r.selected, 'duck')
  assert.equal(r.sets.find((s) => s.id === 'nya').name, '猫娘')
  assert.equal(r.sets.find((s) => s.id === 'fx1').name, '嘀嘟')
})

test('sounds: sniffAudio 认 wav/mp3/ogg 头，拒垃圾', () => {
  assert.equal(sniffAudio(wavBytes()), 'wav')
  const mp3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(64)])
  assert.equal(sniffAudio(mp3), 'mp3')
  const ogg = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(64)])
  assert.equal(sniffAudio(ogg), 'ogg')
  assert.equal(sniffAudio(Buffer.from('not audio at all!!')), null)
  assert.equal(sniffAudio(Buffer.alloc(4)), null)
})

test('sounds: 导入（单文件松手=按压同名）→ 列表 + 回放', () => {
  const r = saveSoundSet(settingsFile, { press: { name: '我的喵.wav', dataUrl: dataUrl(wavBytes()) } })
  assert.equal(r.ok, true, r.error || '')
  assert.match(r.id, /^s[0-9a-f]{8,}$/)
  assert.equal(r.sets.some((s) => s.id === r.id), true)
  const press = resolveSoundBytes(r.id, 'press')
  const release = resolveSoundBytes(r.id, 'release')
  assert.equal(press.type, 'audio/wav')
  assert.ok(press.bytes.length > 44)
  assert.ok(release.bytes.equals(press.bytes), '松手音缺省与按压同文件')
})

test('sounds: 双文件导入（第 2 个为松手音）', () => {
  const r = saveSoundSet(settingsFile, {
    press: { name: 'a.wav', dataUrl: dataUrl(wavBytes(80)) },
    release: { name: 'b.wav', dataUrl: dataUrl(wavBytes(30)) },
  })
  assert.equal(r.ok, true, r.error || '')
  const press = resolveSoundBytes(r.id, 'press')
  const release = resolveSoundBytes(r.id, 'release')
  assert.ok(!release.bytes.equals(press.bytes))
})

test('sounds: 魔数不符 / 超限 / 非 dataURL 全部拒绝', () => {
  const junk = dataUrl(Buffer.from('this is not audio').subarray(0, 64))
  assert.equal(saveSoundSet(settingsFile, { press: { name: 'j', dataUrl: junk } }).ok, false)
  const big = dataUrl(Buffer.concat([wavBytes().subarray(0, 12), Buffer.alloc(3 * 1024 * 1024)]))
  const r = saveSoundSet(settingsFile, { press: { name: 'big.wav', dataUrl: big } })
  assert.equal(r.ok, false)
  assert.ok((r.error || '').includes('2MB'))
  assert.equal(saveSoundSet(settingsFile, { press: { name: 'x', data: 'zzz' } }).ok, false)
  assert.equal(saveSoundSet(settingsFile, {}).ok, false)
})

test('sounds: 内置不可删；删除选中集回落 duck', () => {
  assert.equal(deleteSoundSet(settingsFile, 'nya').ok, false)
  const made = saveSoundSet(settingsFile, { press: { name: 'del.wav', dataUrl: dataUrl(wavBytes()) } })
  writeSettings(settingsFile, { soundSet: made.id })
  assert.equal(listSounds(settingsFile).selected, made.id)
  const del = deleteSoundSet(settingsFile, made.id)
  assert.equal(del.ok, true)
  assert.equal(del.selected, 'duck')
  assert.equal(resolveSoundBytes(made.id, 'press'), null)
})

test('sounds: 内置 nya 回放 audio/wav（1.x 88f75e2 的 Content-Type 语义）', () => {
  const hit = resolveSoundBytes('nya', 'press')
  assert.ok(hit, '内置 nya 音频应可回放')
  assert.equal(hit.type, 'audio/wav')
  assert.ok(hit.bytes.length > 1000)
  const silent = resolveSoundBytes('nya', 'release')
  assert.ok(silent && silent.bytes.length > 0)
})

test('sounds: importLegacySounds 复制旧自定义集并去重', () => {
  const legacy = path.join(dir, 'whale', 'sounds')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'sabc1234_p.wav'), wavBytes(60))
  fs.writeFileSync(path.join(legacy, 'sabc1234_r.wav'), wavBytes(20))
  fs.writeFileSync(
    path.join(legacy, 'sounds.json'),
    JSON.stringify({ sets: [{ id: 'sabc1234', name: '猫娘nya', press: 'sabc1234_p.wav', release: 'sabc1234_r.wav' }] })
  )
  const r1 = importLegacySounds(settingsFile, legacy)
  assert.equal(r1.copied, 1)
  const r2 = importLegacySounds(settingsFile, legacy)
  assert.equal(r2.copied, 0, '重复导入去重')
  const hit = resolveSoundBytes('sabc1234', 'press')
  assert.ok(hit && hit.type === 'audio/wav')
  const r3 = importLegacySounds(settingsFile, path.join(dir, 'whale', 'missing'))
  assert.equal(r3.copied, 0)
})
