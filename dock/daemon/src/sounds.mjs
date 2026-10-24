// 音效库（1.x v1.16.3 语音库迁移）：内置三套 + 自定义导入集。
//
// 纪律：
//   · 音频只收 data:audio/...;base64 字段；单文件 ≤2MB；最多 20 套自定义；
//   · 魔数校验（mp3/wav/ogg/m4a/aac），解码失败/超限直接拒绝；
//   · 内置集不可删；删除当前选中集回落 duck；
//   · 文件名一律由服务端生成（id_p.ext / id_r.ext），绝不信客户端路径。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ASSETS_DIR, BUILTIN_SOUND_NAMES, SOUNDS_DIR, SOUNDS_INDEX_FILE, SOUND_SETS } from '../../engines/paths.mjs'
import { readSettings, writeSettings } from './settings.mjs'

export const SOUND_MAX_BYTES = 2 * 1024 * 1024
export const SOUND_SETS_MAX = 20

const AUDIO_TYPES = {
  mpeg: { ext: 'mp3', type: 'audio/mpeg' },
  mp3: { ext: 'mp3', type: 'audio/mpeg' },
  wav: { ext: 'wav', type: 'audio/wav' },
  'x-wav': { ext: 'wav', type: 'audio/wav' },
  wave: { ext: 'wav', type: 'audio/wav' },
  ogg: { ext: 'ogg', type: 'audio/ogg' },
  oga: { ext: 'ogg', type: 'audio/ogg' },
  m4a: { ext: 'm4a', type: 'audio/mp4' },
  'x-m4a': { ext: 'm4a', type: 'audio/mp4' },
  mp4: { ext: 'm4a', type: 'audio/mp4' },
  aac: { ext: 'aac', type: 'audio/aac' },
}
const AUDIO_EXT_TYPE = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac' }

// 魔数嗅探：dataURL 的 MIME 可伪造，落盘前必须核对文件头。
export function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null
  const head = buf.subarray(0, 16)
  if (head.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3'
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'wav'
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg'
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'm4a'
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'aac'
  if (head.subarray(0, 4).toString('latin1') === 'ADIF') return 'aac'
  return null
}

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SOUNDS_INDEX_FILE, 'utf8'))
    if (parsed && Array.isArray(parsed.sets)) return parsed
  } catch (err) {}
  return { sets: [] }
}

function writeIndex(idx) {
  fs.mkdirSync(SOUNDS_DIR, { recursive: true })
  const tmp = SOUNDS_INDEX_FILE + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2))
  fs.renameSync(tmp, SOUNDS_INDEX_FILE)
  return true
}

export function isBuiltinSound(id) {
  return Object.prototype.hasOwnProperty.call(SOUND_SETS, id)
}

export function getSelected(settingsFile) {
  const s = readSettings(settingsFile)
  const selected = String(s.soundSet || 'duck')
  return isBuiltinSound(selected) || readIndex().sets.some((x) => x.id === selected) ? selected : 'duck'
}

export function listSounds(settingsFile) {
  const sets = Object.keys(SOUND_SETS)
    .map((id) => ({ id, name: BUILTIN_SOUND_NAMES[id] || id, builtin: true }))
    .concat(readIndex().sets.map((s) => ({ id: s.id, name: s.name || s.id, builtin: false })))
  const selected = getSelected(settingsFile)
  return { ok: true, sets, selected }
}

function decodeAudioField(value, label) {
  const dataUrl = typeof value === 'string' ? value : value && typeof value.dataUrl === 'string' ? value.dataUrl : ''
  const m = /^data:audio\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl)
  if (!m) return { ok: false, error: label + '不是受支持的音频（mp3/wav/ogg/m4a/aac）' }
  const kind = AUDIO_TYPES[m[1].toLowerCase()]
  if (!kind) return { ok: false, error: label + '的格式不支持（' + m[1] + '）' }
  let buf
  try {
    buf = Buffer.from(m[2], 'base64')
  } catch (err) {
    return { ok: false, error: label + ' base64 解码失败' }
  }
  if (!buf.length) return { ok: false, error: label + '是空文件' }
  if (buf.length > SOUND_MAX_BYTES) return { ok: false, error: label + '超过 2MB' }
  const sniffed = sniffAudio(buf)
  if (!sniffed) return { ok: false, error: label + '的文件内容不是有效音频' }
  const rawName = value && typeof value === 'object' && typeof value.name === 'string' ? value.name : ''
  return { ok: true, buf, ext: kind.ext, type: kind.type, name: rawName }
}

// 导入一个音效集：press 必填，release 可选（缺省与 press 同文件）。
export function saveSoundSet(settingsFile, parsed) {
  const name = parsed && typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 24) : ''
  const press = decodeAudioField(parsed && parsed.press, '按压音')
  if (!press.ok) return { ok: false, error: press.error }
  const releaseRaw = parsed && parsed.release
  const release = releaseRaw ? decodeAudioField(releaseRaw, '松手音') : null
  if (release && !release.ok) return { ok: false, error: release.error }
  const idx = readIndex()
  if (idx.sets.length >= SOUND_SETS_MAX) return { ok: false, error: '自定义音效最多 ' + SOUND_SETS_MAX + ' 套' }
  fs.mkdirSync(SOUNDS_DIR, { recursive: true })
  let id
  do {
    id = 's' + crypto.randomBytes(6).toString('hex')
  } while (isBuiltinSound(id) || idx.sets.some((s) => s && s.id === id))
  const pressFile = id + '_p.' + press.ext
  const relFile = id + '_r.' + (release ? release.ext : press.ext)
  try {
    fs.writeFileSync(path.join(SOUNDS_DIR, pressFile), press.buf)
    fs.writeFileSync(path.join(SOUNDS_DIR, relFile), release ? release.buf : press.buf)
  } catch (err) {
    return { ok: false, error: '写入音效文件失败' }
  }
  const fallbackName = String(press.name || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .trim()
    .slice(0, 24)
  idx.sets.push({ id, name: name || fallbackName || '自定义音效', press: pressFile, release: relFile, addedAt: Date.now() })
  try {
    writeIndex(idx)
  } catch (err) {
    return { ok: false, error: '无法写入音效索引' }
  }
  return { ok: true, id, ...listSounds(settingsFile) }
}

export function deleteSoundSet(settingsFile, id) {
  if (isBuiltinSound(id)) return { ok: false, error: '内置音效不可删除' }
  const idx = readIndex()
  const at = idx.sets.findIndex((s) => s && s.id === id)
  if (at === -1) return { ok: false, error: '找不到这个音效' }
  const entry = idx.sets.splice(at, 1)[0]
  try {
    writeIndex(idx)
  } catch (err) {
    return { ok: false, error: '无法写入音效索引' }
  }
  for (const f of [entry && entry.press, entry && entry.release]) {
    try {
      if (typeof f === 'string' && f) fs.rmSync(path.join(SOUNDS_DIR, path.basename(f)), { force: true })
    } catch (err) {}
  }
  // 删掉的正好在用：回落第一套内置，否则前端拿着不存在的 set 会静音。
  if (getSelected(settingsFile) === id) writeSettings(settingsFile, { soundSet: 'duck' })
  return { ok: true, deleted: id, ...listSounds(settingsFile) }
}

// 回放：内置集读包内素材，导入集读数据目录。返回 null → 路由 404。
export function resolveSoundBytes(setId, kind) {
  const want = kind === 'release' ? 'release' : 'press'
  if (isBuiltinSound(setId)) {
    const candidates = SOUND_SETS[setId][want] || []
    for (const file of candidates) {
      try {
        const bytes = fs.readFileSync(file)
        if (bytes && bytes.length) {
          return { bytes, type: AUDIO_EXT_TYPE[path.extname(file).slice(1).toLowerCase()] || 'audio/mpeg' }
        }
      } catch (err) {}
    }
    return null
  }
  const entry = readIndex().sets.find((s) => s && s.id === setId)
  if (!entry) return null
  const file = want === 'release' ? entry.release || entry.press : entry.press
  if (typeof file !== 'string' || !file) return null
  try {
    const bytes = fs.readFileSync(path.join(SOUNDS_DIR, path.basename(file)))
    if (!bytes || !bytes.length) return null
    return { bytes, type: AUDIO_EXT_TYPE[path.extname(file).slice(1).toLowerCase()] || 'audio/mpeg' }
  } catch (err) {
    return null
  }
}

// 旧挂件一次性导入：把 ~/.zcode/whale/sounds/ 的自定义集复制进 dock 数据目录。
// 只复制（不动旧数据）；索引按 id 去重合并；非法/超大文件跳过。
export function importLegacySounds(settingsFile, legacyDir) {
  const legacyIndexFile = path.join(legacyDir, 'sounds.json')
  let legacy = { sets: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyIndexFile, 'utf8'))
    if (parsed && Array.isArray(parsed.sets)) legacy = parsed
  } catch (err) {}
  const idx = readIndex()
  const known = new Set(idx.sets.map((s) => s.id))
  let copied = 0
  for (const entry of legacy.sets) {
    if (!entry || typeof entry.id !== 'string' || !/^s[0-9a-f]{4,38}$/.test(entry.id) || known.has(entry.id)) continue
    const files = {}
    let okAll = true
    for (const slot of ['press', 'release']) {
      const f = entry[slot]
      if (typeof f !== 'string' || !f) continue
      try {
        const bytes = fs.readFileSync(path.join(legacyDir, path.basename(f)))
        if (!bytes.length || bytes.length > SOUND_MAX_BYTES) continue
        const ext = path.extname(f).slice(1).toLowerCase()
        if (!AUDIO_EXT_TYPE[ext]) continue
        if (!sniffAudio(bytes)) continue
        const dest = entry.id + '_' + (slot === 'press' ? 'p' : 'r') + '.' + ext
        fs.mkdirSync(SOUNDS_DIR, { recursive: true })
        fs.writeFileSync(path.join(SOUNDS_DIR, dest), bytes)
        files[slot] = dest
      } catch (err) {
        okAll = false
      }
    }
    if (!files.press || !okAll) continue
    idx.sets.push({ id: entry.id, name: String(entry.name || '导入音效').slice(0, 24), ...files, addedAt: Date.now() })
    known.add(entry.id)
    copied += 1
  }
  if (copied) {
    try {
      writeIndex(idx)
    } catch (err) {
      return { copied: 0 }
    }
  }
  return { copied }
}
