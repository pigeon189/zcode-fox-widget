// 单实例锁：文件里存 { pid, startMs, port, token, version, at }。
// 判定「还活着」用 process.kill(pid, 0)：EPERM 也算活着（别的用户/更高权限的进程）。
// 陈旧锁（进程已死或文件损坏）允许接管，接管用临时文件 + rename，避免半写。

import fs from 'node:fs'
import path from 'node:path'

export function isProcessAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

export function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    if (!Number.isInteger(Number(obj.pid)) || Number(obj.pid) <= 0) return null
    return obj
  } catch (err) {
    return null
  }
}

export function acquireLock(file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload = JSON.stringify({ at: Date.now(), ...info })
  try {
    fs.writeFileSync(file, payload, { flag: 'wx' })
    return { ok: true, tookOver: false }
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err
  }
  const cur = readLock(file)
  if (cur && cur.pid !== process.pid && isProcessAlive(cur.pid)) {
    return { ok: false, holder: cur }
  }
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, payload)
  fs.renameSync(tmp, file)
  return { ok: true, tookOver: true }
}

export function updateLock(file, patch) {
  const cur = readLock(file) || {}
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ ...cur, ...patch, at: Date.now() }))
  fs.renameSync(tmp, file)
}

export function releaseLock(file, pid) {
  const cur = readLock(file)
  if (cur && Number(cur.pid) !== Number(pid)) return false
  try {
    fs.unlinkSync(file)
    return true
  } catch (err) {
    return false
  }
}
