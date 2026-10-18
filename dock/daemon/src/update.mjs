// 独立更新（R9）：检查清单 → 下载 → 校验 sha256 → 解包 → 带备份落盘 → 失败回滚。
//
// 设计取舍：
//   · **不覆盖运行中的进程文件**：落盘只写文件内容，新版本在下次重启后生效
//     （Windows 上正在执行的 .mjs 不会被锁，但替换到一半崩溃会更糟，所以统一「重启生效」）。
//   · **每个被覆盖的文件先备份**；任一文件写失败就把整批还原，不留半套。
//   · 清单必须带 sha256，下载后逐字节校验。签名留到 1.0 之前（D012）。
//   · 清单里的 version 必须比当前新，否则直接拒绝——防止「回退到旧包」被当成更新。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { safeRelPath, stripTopDir, untar } from '../../shared/tar.mjs'
import { verifyManifest } from '../../shared/manifest.mjs'

export const DEFAULT_CHANNEL = 'feat/dock'
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function parseVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

// 返回 -1 / 0 / 1；非法版本号抛错（宁可拒绝，也不要「看起来能比」）
export function compareVersions(a, b) {
  const pa = parseVer(a)
  const pb = parseVer(b)
  if (!pa || !pb) throw new Error('bad version: ' + (!pa ? a : b))
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1
  }
  // 预发布 < 正式
  if (!pa.pre.length && !pb.pre.length) return 0
  if (!pa.pre.length) return 1
  if (!pb.pre.length) return -1
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d) return d > 0 ? 1 : -1
      continue
    }
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

// 解包 + 路径校验。任何越界路径都让整包失败（不跳过——跳过等于悄悄少装文件）。
export function extractPackage(gzBuffer) {
  const raw = untar(gunzipSync(gzBuffer))
  const stripped = stripTopDir(raw)
  const files = new Map()
  for (const [name, data] of stripped) {
    const safe = safeRelPath(name)
    if (!safe) throw new Error('unsafe path in package: ' + name)
    if (name.endsWith('/')) continue // 目录项：写入时按需创建
    files.set(safe, data)
  }
  if (!files.size) throw new Error('empty package')
  return files
}

export async function fetchManifest(url, { timeoutMs = 8000, publicKeyPem = '', requireSignature = true } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
  if (!res.ok) throw new Error('manifest http ' + res.status)
  const m = await res.json()
  if (!m || typeof m.version !== 'string') throw new Error('manifest: version required')
  if (typeof m.url !== 'string' || !/^https?:\/\//.test(m.url)) throw new Error('manifest: url required')
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) throw new Error('manifest: sha256 required')

  // 签名：默认必须验。sha256 只能证明「包与清单一致」，证明不了「清单是发布者写的」。
  if (requireSignature) {
    const v = verifyManifest(m, publicKeyPem)
    if (!v.ok) throw new Error('manifest signature invalid: ' + v.reason)
  }
  return m
}

export async function downloadPackage(url, { timeoutMs = 30000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('package http ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_PACKAGE_BYTES) throw new Error('package too large: ' + buf.length)
  return buf
}

// 覆盖写入。每个已存在的文件先备份；任一失败即回滚整批。
export function applyFiles(root, files, { backupDir }) {
  const applied = []
  const backups = []
  const errors = []
  const stamp = backupDir || path.join(root, '.backup-' + Date.now())

  for (const [rel, data] of files) {
    const dst = path.join(root, rel)
    try {
      if (fs.existsSync(dst) && fs.statSync(dst).isFile()) {
        const bak = path.join(stamp, rel)
        fs.mkdirSync(path.dirname(bak), { recursive: true })
        fs.copyFileSync(dst, bak)
        backups.push(rel)
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.writeFileSync(dst, data)
      applied.push(rel)
    } catch (err) {
      errors.push(rel + ': ' + String((err && err.message) || err))
      break
    }
  }

  if (errors.length) {
    const rb = rollbackFiles(root, applied, backups, stamp)
    return { ok: false, applied, errors, backupDir: stamp, rollback: rb }
  }
  return { ok: true, applied, errors: [], backupDir: stamp, rollback: null }
}

// 只还原「本批写过」的文件：备份里有 → 拷回；备份里没有 → 原本不存在，删掉。
export function rollbackFiles(root, applied, backups, backupDir) {
  const set = new Set(backups)
  const out = { ok: true, restored: 0, removed: 0, errors: [] }
  for (const rel of applied.slice().reverse()) {
    const dst = path.join(root, rel)
    try {
      if (set.has(rel)) {
        const bak = path.join(backupDir, rel)
        fs.copyFileSync(bak, dst)
        out.restored++
      } else {
        let st = null
        try {
          st = fs.lstatSync(dst)
        } catch (err) {}
        if (st && st.isFile()) {
          fs.rmSync(dst, { force: true })
          out.removed++
        }
      }
    } catch (err) {
      out.ok = false
      out.errors.push(rel + ': ' + String((err && err.message) || err))
    }
  }
  return out
}

// ---------- 状态与历史 ----------

export function readUpdateState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return { history: [] }
    return { ...raw, history: Array.isArray(raw.history) ? raw.history : [] }
  } catch (err) {
    return { history: [] }
  }
}

export function writeUpdateState(file, patch) {
  const cur = readUpdateState(file)
  const next = { ...cur, ...patch }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
  return next
}

// 备份目录只留最近几份：每次更新一份完整备份，长期不清理会吃掉几百 MB。
export function pruneBackups(dir, keep = 3) {
  let names = []
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch (err) {
    return { removed: 0 }
  }
  const drop = names.slice(0, Math.max(0, names.length - keep))
  let removed = 0
  for (const name of drop) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true })
      removed++
    } catch (err) {}
  }
  return { removed }
}

export function appendHistory(file, entry) {
  const st = readUpdateState(file)
  const hist = (st.history || []).slice(-9)
  hist.push({ at: Date.now(), ...entry })
  writeUpdateState(file, { history: hist })
  return hist
}

// 一步到位：清单 → 下载 → 校验 → 解包 → 落盘 → 记历史
export async function updateFromManifest(manifest, { root, dataDir, currentVersion }) {
  const stateFile = path.join(dataDir, 'update-state.json')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.join(dataDir, 'backups', stamp)

  if (compareVersions(manifest.version, currentVersion) <= 0) {
    return { ok: false, reason: 'not-newer', current: currentVersion, latest: manifest.version }
  }

  let buf
  try {
    buf = await downloadPackage(manifest.url)
  } catch (err) {
    appendHistory(stateFile, { from: currentVersion, to: manifest.version, result: 'failed', error: 'download: ' + err.message })
    return { ok: false, reason: 'download-failed', error: err.message }
  }

  const digest = sha256(buf)
  if (digest.toLowerCase() !== manifest.sha256.toLowerCase()) {
    appendHistory(stateFile, { from: currentVersion, to: manifest.version, result: 'failed', error: 'sha256 mismatch' })
    return { ok: false, reason: 'sha256-mismatch', expected: manifest.sha256, got: digest }
  }

  let files
  try {
    files = extractPackage(buf)
  } catch (err) {
    appendHistory(stateFile, { from: currentVersion, to: manifest.version, result: 'failed', error: 'extract: ' + err.message })
    return { ok: false, reason: 'bad-package', error: err.message }
  }

  const res = applyFiles(root, files, { backupDir })
  if (!res.ok) {
    appendHistory(stateFile, {
      from: currentVersion,
      to: manifest.version,
      result: res.rollback && res.rollback.ok ? 'rolledback' : 'failed',
      error: res.errors[0],
    })
    return { ok: false, reason: 'apply-failed', ...res }
  }

  appendHistory(stateFile, { from: currentVersion, to: manifest.version, result: 'ok' })
  pruneBackups(path.join(dataDir, 'backups'))
  writeUpdateState(stateFile, {
    current: currentVersion,
    latest: manifest.version,
    checkedAt: Date.now(),
    appliedVersion: manifest.version,
    appliedAt: Date.now(),
  })
  return { ok: true, version: manifest.version, files: res.applied.length, backupDir }
}
