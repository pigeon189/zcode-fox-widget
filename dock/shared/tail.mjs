// 增量读取（D034）：transcript / dsh 会话日志的尾部读取。
//
// 设计要点：
//   · 记录 offset / ino / size；文件截断或轮转（ino 变化）→ reset:true 从头重读；
//   · 只消费到最后一个 '\n'，残行留到下次（防止半行解析）；容忍 \r\n；
//   · 单次最多读 maxChunk，剩余留给下次 tick；
//   · 任何异常都变成 { ok:false, reason }，绝不抛到事件循环。

import crypto from 'node:crypto'
import fs from 'node:fs'
import zlib from 'node:zlib'

export const DEFAULT_MAX_CHUNK = 1 << 20
export const MAX_LINE_BYTES = 1 << 20
// 持久化水位的内容指纹窗口：恢复时对比 offset 前的这些字节，识别「文件被
// 原地截断后重写」——只看 size/ino 发现不了（重写后可能更大、ino 不变）。
const CHECKPOINT_BYTES = 64

function safeStat(file) {
  try {
    return fs.statSync(file)
  } catch (err) {
    return null
  }
}

function inoOf(st) {
  return Number(st && (st.ino || st.birthtimeMs || st.ctimeMs)) || 0
}

// offset 之前最多 CHECKPOINT_BYTES 字节的指纹。文件读不到时返回 ''（恢复方
// 见到空指纹就放弃水位、从头重读，宁可多读也不能混读）。
function checkpointAt(file, end) {
  if (!end || end <= 0) return ''
  const start = Math.max(0, end - CHECKPOINT_BYTES)
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(end - start)
      const read = fs.readSync(fd, buf, 0, buf.length, start)
      if (!read) return ''
      return crypto.createHash('sha1').update(buf.subarray(0, read)).digest('hex')
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    return ''
  }
}

// 普通文本尾随。poll() 返回 { ok, lines, reset, reason? }。
export function createTailReader(file, { maxChunk = DEFAULT_MAX_CHUNK } = {}) {
  let offset = 0
  let partial = Buffer.alloc(0)
  let ino = 0
  let lastLineTooLong = 0

  function reset() {
    offset = 0
    partial = Buffer.alloc(0)
    ino = 0
  }

  // 从持久化索引恢复水位（M6）。**只恢复到最后一个完整行之后**：state.offset
  // 已经把内存里未消费的残行排除在外，恢复后重新读那半行；否则重启会把它
  // 当成「已消费」而永久丢掉一条事件。
  // 同时校验 ino 与 offset 前的内容指纹：文件被原地截断后重写到更大长度时
  // 单看 size 发现不了，直接沿用旧水位会把旧事件和新文件尾部混在一起。
  // 返回 true=已恢复；false=已 reset（调用方必须丢弃落盘的事件一起重读）。
  function restore(state) {
    const off = Number(state && state.offset)
    if (!Number.isFinite(off) || off < 0) {
      reset()
      return false
    }
    const next = Math.floor(off)
    const st = safeStat(file)
    if (!st || st.size < next) {
      reset()
      return false
    }
    const savedIno = Number(state && state.ino) || 0
    const curIno = inoOf(st)
    if (savedIno && curIno && savedIno !== curIno) {
      reset()
      return false
    }
    if (next > 0) {
      const saved = String((state && state.checkpoint) || '')
      if (!saved || checkpointAt(file, next) !== saved) {
        reset()
        return false
      }
    }
    offset = next
    ino = curIno || savedIno
    partial = Buffer.alloc(0)
    lastLineTooLong = 0
    return true
  }

  return {
    get state() {
      // offset = 可安全续读的位置（最后一个完整行之后）；readOffset 才是已经
      // 从文件读到的位置（可能包含半行）。落盘只能用前者。
      const committed = Math.max(0, offset - partial.length)
      return {
        offset: committed,
        readOffset: offset,
        size: safeStat(file)?.size || 0,
        ino,
        droppedLongLines: lastLineTooLong,
        checkpoint: checkpointAt(file, committed),
      }
    },
    reset,
    restore,
    poll() {
      const st = safeStat(file)
      if (!st) return { ok: false, reason: 'missing', lines: [], reset: false }
      const nextIno = inoOf(st)
      let didReset = false
      if ((ino && nextIno && nextIno !== ino) || st.size < offset) {
        reset()
        didReset = true
      }
      ino = nextIno || ino
      if (st.size === offset) return { ok: true, lines: [], reset: didReset }

      const want = Math.min(maxChunk, Math.max(0, st.size - offset))
      let buf = null
      try {
        const fd = fs.openSync(file, 'r')
        try {
          buf = Buffer.alloc(want)
          const read = fs.readSync(fd, buf, 0, want, offset)
          if (read < want) buf = buf.subarray(0, read)
        } finally {
          fs.closeSync(fd)
        }
      } catch (err) {
        return { ok: false, reason: 'read-failed', lines: [], reset: didReset }
      }
      offset += buf.length
      const combined = partial.length ? Buffer.concat([partial, buf]) : buf
      const lastNl = combined.lastIndexOf(0x0a)
      if (lastNl < 0) {
        if (combined.length > MAX_LINE_BYTES) {
          // 超长单行：丢弃并计数，避免内存被一行垃圾撑爆。
          lastLineTooLong += 1
          partial = Buffer.alloc(0)
        } else {
          partial = combined
        }
        return { ok: true, lines: [], reset: didReset }
      }
      partial = combined.subarray(lastNl + 1)
      const text = combined.subarray(0, lastNl).toString('utf8')
      const lines = []
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '')
        if (!line) continue
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
          lastLineTooLong += 1
          continue
        }
        lines.push(line)
      }
      return { ok: true, lines, reset: didReset }
    },
  }
}

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MIN = 0x184d2a50
const SKIPPABLE_MAX = 0x184d2a5f

// 与 adapters/dsh/sessions.mjs 相同的帧边界解析（保持一处实现，避免漂移）。
export function frameEnd(buf, start) {
  if (start + 4 > buf.length) return -1
  const magic = buf.readUInt32LE(start)
  if (magic >= SKIPPABLE_MIN && magic <= SKIPPABLE_MAX) {
    if (start + 8 > buf.length) return -1
    const size = buf.readUInt32LE(start + 4)
    const end = start + 8 + size
    return end <= buf.length ? end : -1
  }
  if (magic !== ZSTD_MAGIC) return -1
  let p = start + 4
  if (p >= buf.length) return -1
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const single = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (!single) {
    if (p >= buf.length) return -1
    p += 1
  }
  p += dictFlag === 0 ? 0 : dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : 4
  p += fcsFlag === 0 ? (single ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  if (p > buf.length) return -1
  for (;;) {
    if (p + 3 > buf.length) return -1
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = bh & 1
    const type = (bh >> 1) & 3
    const size = bh >>> 3
    if (type === 3) return -1
    p += type === 1 ? 1 : size
    if (p > buf.length) return -1
    if (last) break
  }
  if (checksum) p += 4
  return p <= buf.length ? p : -1
}

// 多帧 zstd 尾随：只推进「最后一个成功解码帧的结束偏移」。半帧不解码，
// 下次补齐后继续；坏帧跳过并计数，不卡死。
export function createZstdFrameTail(file, { maxChunk = 32 * 1024 * 1024 } = {}) {
  let offset = 0
  let ino = 0
  let partialLine = ''
  let badFrames = 0

  function reset() {
    offset = 0
    ino = 0
    partialLine = ''
  }

  // 从持久化索引恢复水位（M6）；非法输入一律从头重读。
  function restore(state) {
    const off = Number(state && state.offset)
    if (!Number.isFinite(off) || off < 0) return reset()
    offset = Math.floor(off)
    ino = Number(state && state.ino) || 0
    partialLine = ''
  }

  return {
    get state() {
      return { offset, size: safeStat(file)?.size || 0, ino, badFrames }
    },
    reset,
    restore,
    poll() {
      const st = safeStat(file)
      if (!st) return { ok: false, reason: 'missing', lines: [], reset: false, frames: 0 }
      const nextIno = inoOf(st)
      let didReset = false
      if ((ino && nextIno && nextIno !== ino) || st.size < offset) {
        reset()
        didReset = true
      }
      ino = nextIno || ino
      if (st.size === offset) return { ok: true, lines: [], reset: didReset, frames: 0 }
      const want = Math.min(maxChunk, Math.max(0, st.size - offset))
      let buf = null
      try {
        const fd = fs.openSync(file, 'r')
        try {
          buf = Buffer.alloc(want)
          const read = fs.readSync(fd, buf, 0, want, offset)
          if (read < want) buf = buf.subarray(0, read)
        } finally {
          fs.closeSync(fd)
        }
      } catch (err) {
        return { ok: false, reason: 'read-failed', lines: [], reset: didReset, frames: 0 }
      }

      let start = 0
      let consumed = 0
      let frames = 0
      const chunks = []
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
      while (start < buf.length) {
        const end = frameEnd(buf, start)
        if (end <= start) {
          // 帧头看起来是 zstd magic 但帧不完整：先看后面还有没有下一个 magic。
          // 有 → 当前是坏帧，跳过；没有 → 半帧，停在原地等下次补齐。
          if (start + 4 <= buf.length && buf.readUInt32LE(start) === ZSTD_MAGIC) {
            const nextMagic = buf.indexOf(magic, start + 4)
            if (nextMagic > start) {
              badFrames += 1
              start = nextMagic
              consumed = Math.max(consumed, nextMagic)
              continue
            }
            break
          }
          const next = buf.indexOf(magic, start + 1)
          if (next < 0) {
            // 尾部垃圾：保留最后 3 字节（可能是半个 magic），其余丢弃。
            consumed = Math.max(start, buf.length - 3)
            break
          }
          badFrames += 1
          start = next
          continue
        }
        if (typeof zlib.zstdDecompressSync !== 'function') {
          return { ok: false, reason: 'zstd-unavailable', lines: [], reset: didReset, frames }
        }
        try {
          const out = zlib.zstdDecompressSync(buf.subarray(start, end))
          chunks.push(out)
          frames += 1
        } catch (err) {
          // 坏帧：跳过（按帧边界推进），计数。
          badFrames += 1
        }
        start = end
        consumed = end
      }
      // 只把完整帧（或明确跳过的垃圾）写回 offset，半帧留给下次。
      offset += consumed
      const text = partialLine + Buffer.concat(chunks).toString('utf8')
      const lastNl = text.lastIndexOf('\n')
      if (lastNl < 0) {
        partialLine = text.slice(0, MAX_LINE_BYTES)
        return { ok: true, lines: [], reset: didReset, frames }
      }
      partialLine = text.slice(lastNl + 1)
      const lines = text
        .slice(0, lastNl)
        .split('\n')
        .map((s) => s.replace(/\r$/, ''))
        .filter((s) => s.length > 0)
      return { ok: true, lines, reset: didReset, frames }
    },
  }
}
