// 零依赖 tar 读取（R9）：只支持 dock 更新包需要的子集。
//
// 支持的：ustar 普通文件 / 目录 / GNU 长文件名（typeflag 'L'）、
// 512 字节块、八进制 size、prefix 字段。
// 不支持（直接跳过，不报错）：符号链接、硬链接、稀疏文件、pax 扩展头。
//
// 安全：解出来的路径必须落在目标目录内——绝对路径、盘符、`..` 一律拒绝。
// 更新包来自网络，这条边界不能省。

const BLOCK = 512

function readString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length)
  const zero = slice.indexOf(0)
  const end = zero >= 0 ? zero : slice.length
  return slice.subarray(0, end).toString('utf8')
}

function readOctal(buf, offset, length) {
  const s = readString(buf, offset, length).trim()
  if (!s) return 0
  const n = parseInt(s, 8)
  return Number.isFinite(n) ? n : 0
}

function isZeroBlock(buf, offset) {
  for (let i = 0; i < BLOCK; i++) if (buf[offset + i] !== 0) return false
  return true
}

// 返回 Map<relativePath, Buffer>（目录不单独出现；空目录会以空 Buffer + 末尾 / 表示）
export function untar(buffer) {
  const files = new Map()
  let offset = 0
  let longName = ''

  while (offset + BLOCK <= buffer.length) {
    if (isZeroBlock(buffer, offset)) break
    const header = buffer.subarray(offset, offset + BLOCK)
    offset += BLOCK

    let name = readString(header, 0, 100)
    const size = readOctal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = readString(header, 345, 155)
    const magic = readString(header, 257, 6)

    // 校验和：把 checksum 字段按空格处理，其余字节求和
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i]
    const want = readOctal(header, 148, 8)
    if (want !== 0 && sum !== want) {
      throw new Error('tar: header checksum mismatch at offset ' + (offset - BLOCK))
    }

    const dataStart = offset
    const dataEnd = Math.min(buffer.length, dataStart + size)
    const data = buffer.subarray(dataStart, dataEnd)
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (type === 'L') {
      // GNU 长文件名：下一块的 name 用它
      longName = data.toString('utf8').replace(/\0+$/, '')
      continue
    }
    if (magic.startsWith('ustar') && prefix) name = prefix + '/' + name
    if (longName) {
      name = longName
      longName = ''
    }

    if (type === '5') {
      if (name && !name.endsWith('/')) name += '/'
      files.set(name, Buffer.alloc(0))
      continue
    }
    if (type !== '0' && type !== '\0' && type !== '') continue

    if (!name) continue
    files.set(name, Buffer.from(data))
  }

  return files
}

// GitHub 的 tarball 有 `<repo>-<ref>/` 前缀。统一剥掉第一层，
// 其余情况（已经打过包、没有统一前缀）保持原样。
export function stripTopDir(files) {
  const names = [...files.keys()]
  if (!names.length) return files
  const first = names[0].split('/')[0]
  if (!first) return files
  const allShare = names.every((n) => n === first || n.startsWith(first + '/'))
  if (!allShare) return files
  const out = new Map()
  for (const [name, data] of files) {
    if (name === first || name === first + '/') continue
    const rel = name.slice(first.length + 1)
    if (!rel) continue
    out.set(rel, data)
  }
  return out
}

export function safeRelPath(rel) {
  const s = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\.\//, '')
  if (!s) return null
  if (s.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(s)) return null
  const parts = s.split('/')
  if (parts.some((p) => p === '..' || p === '')) return null
  return s
}

// ---------- 写 tar（打包发布用） ----------

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0'
}

function headerFor(name, size, mtime, type = '0') {
  const header = Buffer.alloc(BLOCK)
  header.write(name.slice(0, 100), 0, 'utf8')
  header.write(octal(0o644, 8), 100, 'ascii')
  header.write(octal(0, 8), 108, 'ascii')
  header.write(octal(0, 8), 116, 'ascii')
  header.write(octal(size, 12), 124, 'ascii')
  header.write(octal(mtime || Math.floor(Date.now() / 1000), 12), 136, 'ascii')
  header.write('        ', 148, 'ascii') // checksum 先填空格
  header.write(type, 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const b of header) sum += b
  // 校验和字段固定 8 字节：6 位八进制 + NUL + 空格（多写一位会挤进 typeflag）
  header.write(sum.toString(8).padStart(6, '0').slice(-6) + '\0 ', 148, 'ascii')
  return header
}

// files: Map<相对路径, Buffer>；超过 100 字节的名字用 GNU 'L' 扩展头。
export function writeTar(files) {
  const parts = []
  for (const [name, data] of files) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    if (Buffer.byteLength(name, 'utf8') > 100) {
      const nameBuf = Buffer.concat([Buffer.from(name, 'utf8'), Buffer.alloc(1)])
      // typeflag 必须参与校验和，所以要在 headerFor 里一起定
      const lh = headerFor('././@LongLink', nameBuf.length, 0, 'L')
      parts.push(lh, nameBuf, Buffer.alloc((BLOCK - (nameBuf.length % BLOCK)) % BLOCK))
    }
    parts.push(headerFor(name, buf.length, 0), buf, Buffer.alloc((BLOCK - (buf.length % BLOCK)) % BLOCK))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}
