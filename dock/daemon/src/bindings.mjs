// 绑定持久化：一个窗口一条，按绑定键去重。
//
// 记录里存 key + 窗口快照（title/exe/pid/hwnd/rect）+ 吸附锚点。
// 窗口重启后 key 变化，旧记录保留（最多 50 条）作为历史，不自动迁移——
// 避免「重启后串窗」，宁可让用户重新拖一次。

import fs from 'node:fs'
import path from 'node:path'

export const MAX_BINDINGS = 50

export function readBindings(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((b) => b && typeof b.key === 'string')
  } catch (err) {
    return []
  }
}

export function writeBindings(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(list.slice(0, MAX_BINDINGS), null, 2))
  fs.renameSync(tmp, file)
}

export function upsertBinding(file, binding) {
  if (!binding || typeof binding.key !== 'string' || !binding.key) {
    throw new Error('binding.key required')
  }
  const list = readBindings(file).filter((b) => b.key !== binding.key)
  const next = [
    {
      key: binding.key,
      adapterId: binding.adapterId || 'generic',
      // 客户端自称的适配器只留作排障线索，真正生效的是 adapterId
      adapterHint: String(binding.adapterHint || ''),
      anchor: binding.anchor || { corner: 'top-right' },
      window: binding.window || null,
      at: Date.now(),
    },
    ...list,
  ]
  writeBindings(file, next)
  return next[0]
}

export function removeBinding(file, key) {
  const list = readBindings(file)
  const next = list.filter((b) => b.key !== key)
  if (next.length === list.length) return { removed: false, bindings: list }
  writeBindings(file, next)
  return { removed: true, bindings: next }
}

export function findBinding(file, key) {
  return readBindings(file).find((b) => b.key === key) || null
}
