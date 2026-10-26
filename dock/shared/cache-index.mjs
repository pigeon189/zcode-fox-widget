// 适配器级增量索引持久化（M6 / PLAN §10.2）。
//
// 形态：`{agent}-index-v1.json`，含 schemaVersion + appVersion；版本不符或
// 解析失败直接丢弃重建；写入原子 + 去抖；单文件 ≤8MB，超出按最久未用淘汰。
// 缓存只保存「可重建」的派生状态（尾随水位 + 已解析事件），删除缓存后
// 全量重算的结果必须与带缓存完全一致（incremental-equivalence 测试守卫）。

import fs from 'node:fs'
import path from 'node:path'

export const SCHEMA_VERSION = 1
export const MAX_INDEX_BYTES = 8 * 1024 * 1024

export function createCacheIndex({
  file,
  appVersion,
  schemaVersion = SCHEMA_VERSION,
  maxBytes = MAX_INDEX_BYTES,
  debounceMs = 2000,
} = {}) {
  let entries = new Map() // key -> { value, at }
  let dirty = false
  let timer = null
  let discarded = 0

  function load() {
    entries = new Map()
    let raw = null
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err && err.code !== 'ENOENT') discarded += 1
      return
    }
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      discarded += 1
      return
    }
    try {
      const parsed = JSON.parse(raw)
      if (
        !parsed ||
        parsed.schemaVersion !== schemaVersion ||
        parsed.appVersion !== appVersion ||
        !parsed.entries ||
        typeof parsed.entries !== 'object' ||
        Array.isArray(parsed.entries)
      ) {
        discarded += 1
        return
      }
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (typeof k !== 'string' || !k || !v || typeof v !== 'object') continue
        entries.set(k, { value: v.value, at: Number(v.at) || 0 })
      }
    } catch (err) {
      discarded += 1
    }
  }

  function estimateBytes() {
    let n = 64
    for (const [k, v] of entries) n += k.length + JSON.stringify(v.value || null).length + 24
    return n
  }

  function evictIfNeeded() {
    while (entries.size > 0 && estimateBytes() > maxBytes) {
      // 最久未用淘汰
      let oldestKey = null
      let oldestAt = Infinity
      for (const [k, v] of entries) {
        if (v.at < oldestAt) {
          oldestAt = v.at
          oldestKey = k
        }
      }
      if (!oldestKey) break
      entries.delete(oldestKey)
    }
  }

  function flushSync() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!dirty) return true
    const tmp = file + '.' + process.pid + '.tmp'
    try {
      evictIfNeeded()
      const payload = JSON.stringify({
        schemaVersion,
        appVersion,
        savedAt: Date.now(),
        entries: Object.fromEntries(entries),
      })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, payload)
      fs.renameSync(tmp, file)
      dirty = false
      return true
    } catch (err) {
      // 写盘失败（Windows 文件锁 EPERM / 磁盘满 / 目标路径被占）绝不能让去抖
      // 定时器把未捕获异常抛进事件循环——那会直接杀死 daemon，且在条件持续
      // 存在时形成 watchdog 重启循环。保留 dirty，下次 schedule 再试。
      try {
        fs.rmSync(tmp, { force: true })
      } catch (e) {}
      return false
    }
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      // 失败后保留 dirty 并重新排队；单次失败不影响进程。
      if (!flushSync()) schedule()
    }, Math.max(200, Number(debounceMs) || 2000))
    timer.unref?.()
  }

  load()
  process.on?.('exit', () => {
    try {
      flushSync()
    } catch (err) {}
  })

  return {
    get(key) {
      const hit = entries.get(String(key || ''))
      if (!hit) return null
      hit.at = Date.now()
      return hit.value
    },
    set(key, value) {
      entries.set(String(key || ''), { value, at: Date.now() })
      dirty = true
    },
    delete(key) {
      if (entries.delete(String(key || ''))) dirty = true
    },
    get size() {
      return entries.size
    },
    get discardedCount() {
      return discarded
    },
    schedule,
    flushSync,
    reset() {
      entries = new Map()
      dirty = false
      discarded = 0
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
