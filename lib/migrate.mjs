// fox-dock 2.0 迁移引导（阶段 A：转正前就能随 1.x 版本发出的能力）。
//
// 方案全文见 MIGRATE-TO-FOX-DOCK-2.md（§3 入口设计 / §8 红线 / §9 零侵入边界）。
// 本模块只做四类**只读**事情，绝不触碰 1.x 的更新核心路径：
//   1) parseRemoteManifest：从远端 plugin.json 文本里解析 { version, migration, eol }；
//   2) validateMigrationOffer：migration 块的硬校验（只认 2.0.0 stable + GitHub
//      Releases 白名单 URL）；预发布（2.0.0-pre.* / rc）与任何坏字段一律拒绝；
//   3) probeMigrationOffer：一次性只读探测（SessionStart 或打开更新面板时触发，
//      24 小时最多一次、总预算 8 秒、失败静默），结果写进 update-state.json 的
//      migrationProbe 字段供 updateView 读取——不下载、不替换、不写安装目录；
//   4) migrationPreflight：迁移预检（config 键名 / 凭据只报数量 / dock 在线性 /
//      数据体积 / 启动文件夹 / 上次更新是否未完成），绝不写任何文件。
//
// 红线（§8）：notesUrl / downloadUrl 的白名单**硬编码在本文件**，不由远端清单
// 任意指定；2.0 迁移不走 1.x 的下载/替换路径；对 dock 只访问 127.0.0.1:<lockport>。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildVersionEndpoints,
  compareVersions,
  discoverInstallRoots,
  fetchVersionText,
  isValidVersion,
  readUpdateState,
  writeUpdateState,
} from './update.mjs'
import { CONFIG_FILE, DATA_DIR, PLUGIN_ROOT, pluginVersion } from './paths.mjs'
import { dockHealth, readDockLock } from './dock-shim.mjs'
import { defaultStartupDir, watchVbsFile } from './watch-install.mjs'

// 迁移 offer 的唯一合法目标。后续 2.0.1 / 2.1 的迁移不在本版范围；要放开必须
// 显式改这里的常量并重新评审（§3.1：不能因为版本号更大就自动复用 2.0.0 的入口）。
export const MIGRATE_PRODUCT = 'fox-dock'
export const MIGRATE_VERSION = '2.0.0'
export const MIGRATE_CHANNEL = 'stable'
// 版本号必须是无后缀的三段式：2.0.0-pre.3 / rc / beta 一律按非法处理
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/

// 说明页 / 下载页只允许本仓库的 GitHub Releases。新增域名必须硬编码进这里并随
// 1.x 版本发布——远端清单指定的其它域名一律拒绝（§3.2：否则被篡改的清单可以把
// 用户引到钓鱼页）。GitHub release 资产会重定向到 objects / release-assets 两个域。
export const MIGRATION_URL_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]
export const MIGRATION_URL_PREFIX = '/pigeon189/zcode-fox-widget/releases/'

const PROBE_INTERVAL_MS = 24 * 3600 * 1000
const PROBE_BUDGET_MS = 8000
const PROBE_MIN_TIMEOUT_MS = 1500

// ---------- 清单解析 ----------

// 从 plugin.json 文本里同时取 version / migration / eol。version 沿用 1.x 更新器
// 的口径（isValidVersion）；migration 只判形状，合法性由 validateMigrationOffer 把关；
// eol 是终点哨兵（可选），只有显式 true 才生效。
export function parseRemoteManifest(text) {
  let raw = null
  try {
    raw = JSON.parse(String(text))
  } catch (err) {
    return { version: null, migration: null, eol: false }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: null, migration: null, eol: false }
  }
  const version = isValidVersion(raw.version) ? String(raw.version).trim() : null
  const migration =
    raw.migration && typeof raw.migration === 'object' && !Array.isArray(raw.migration) ? raw.migration : null
  return { version, migration, eol: raw.eol === true }
}

// ---------- offer 校验 ----------

// 迁移说明 / 下载地址：https + 主机精确白名单 + 本仓库 Releases 路径前缀，
// 拒绝 userinfo、非 443 端口、路径穿越。镜像是清单的传输通道，不是信任来源——
// URL 校验只认这里的硬编码清单。
export function validateMigrationUrl(raw) {
  let u
  try {
    u = new URL(String(raw || ''))
  } catch (err) {
    return { ok: false, reason: 'URL 无法解析' }
  }
  if (u.protocol !== 'https:') return { ok: false, reason: '只允许 https' }
  if (u.username || u.password) return { ok: false, reason: '不允许携带用户名/密码' }
  const host = u.hostname.toLowerCase()
  if (!host || !MIGRATION_URL_HOSTS.some((h) => host === h)) {
    return { ok: false, reason: '主机不在 GitHub Releases 白名单内: ' + (host || '(空)') }
  }
  if (u.port && u.port !== '443') return { ok: false, reason: '只允许 443 端口' }
  if (!u.pathname.startsWith(MIGRATION_URL_PREFIX)) {
    return { ok: false, reason: '路径必须指向 ' + MIGRATION_URL_PREFIX.slice(1) }
  }
  if (u.pathname.split('/').some((p) => p === '.' || p === '..')) {
    return { ok: false, reason: '路径含可疑段' }
  }
  return { ok: true, url: u.toString() }
}

// 纯文本字段：去首尾空格后有内容、≤maxLen、不含 HTML/控制字符（这些字段会直接
// 显示在面板里，是「说明页打不开时也能看到的代价」，必须纯文本）
function plainText(v, maxLen) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > maxLen) return null
  if (/[<>]/.test(s) || /[\u0000-\u001f\u007f]/.test(s)) return null
  return s
}

function textArray(v, maxItems, maxLen) {
  if (v === undefined) return null
  if (!Array.isArray(v) || v.length > maxItems) return null
  const out = []
  for (const item of v) {
    const s = plainText(item, maxLen)
    if (!s) return null
    out.push(s)
  }
  return out
}

// 校验远端清单的 migration 块。任何一条不满足都返回 { ok:false, reason }，调用方
// 按「没有迁移入口」处理——绝不能因为字段残缺就放行一个半拉的 offer。
export function validateMigrationOffer(migration, opts = {}) {
  const bad = (reason) => ({ ok: false, reason })
  if (!migration || typeof migration !== 'object' || Array.isArray(migration)) {
    return bad('缺 migration 块或形状不对')
  }
  if (migration.product !== MIGRATE_PRODUCT) return bad('product 不是 ' + MIGRATE_PRODUCT)
  if (migration.channel !== MIGRATE_CHANNEL) return bad('channel 不是 ' + MIGRATE_CHANNEL + '（预发布通道一律忽略）')
  if (migration.version !== MIGRATE_VERSION || !EXACT_VERSION_RE.test(String(migration.version))) {
    return bad('version 不是 ' + MIGRATE_VERSION + '（预发布与后续版本一律忽略）')
  }
  const current = opts.current || pluginVersion()
  if (typeof migration.minPluginVersion === 'string' && migration.minPluginVersion) {
    if (!isValidVersion(migration.minPluginVersion)) return bad('minPluginVersion 形状不对')
    if (compareVersions(current, migration.minPluginVersion) < 0) {
      return bad('本机版本低于迁移所需最低版本 v' + migration.minPluginVersion)
    }
  }
  const notes = validateMigrationUrl(migration.notesUrl)
  if (!notes.ok) return bad('notesUrl 不合格：' + notes.reason)
  const download = validateMigrationUrl(migration.downloadUrl)
  if (!download.ok) return bad('downloadUrl 不合格：' + download.reason)
  const summary = plainText(migration.summary, 80)
  if (!summary) return bad('summary 缺失 / 超过 80 字 / 含非纯文本内容')
  const highlights = textArray(migration.highlights, 3, 40)
  if (migration.highlights !== undefined && highlights === null) {
    return bad('highlights 最多 3 条、每条 ≤40 字、纯文本')
  }
  const costs = textArray(migration.costs, 3, 40)
  if (!costs || !costs.length) return bad('costs 缺失（1–3 条、每条 ≤40 字、纯文本）——代价说明不能省略')
  return {
    ok: true,
    offer: {
      product: MIGRATE_PRODUCT,
      version: MIGRATE_VERSION,
      channel: MIGRATE_CHANNEL,
      notesUrl: notes.url,
      downloadUrl: download.url,
      summary,
      highlights: highlights || [],
      costs,
      publishedAt: typeof migration.publishedAt === 'string' ? migration.publishedAt : null,
      minPluginVersion: typeof migration.minPluginVersion === 'string' ? migration.minPluginVersion : null,
    },
  }
}

// 多镜像取舍（§3.2）：取版本最高的那份清单；同版本时取「带合法 migration」的那份。
// 旧镜像没有 migration 时不能把新镜像的入口覆盖掉，反之亦然。
// manifests: [{ version, migration, eol }]（已过 parseRemoteManifest）
export function pickBestManifest(manifests, opts = {}) {
  let best = null
  for (const m of manifests || []) {
    if (!m || !m.version) continue
    if (!best || compareVersions(m.version, best.version) > 0) {
      best = m
      continue
    }
    if (compareVersions(m.version, best.version) === 0 && !best.validOffer && m.migration) {
      const cand = validateMigrationOffer(m.migration, opts)
      if (cand.ok) best = m
    }
  }
  if (!best) return null
  const validOffer = best.migration ? validateMigrationOffer(best.migration, opts) : { ok: false, reason: '缺 migration 块' }
  return {
    version: best.version,
    eol: best.eol === true,
    migration: best.migration || null,
    offer: validOffer.ok ? validOffer.offer : null,
    reason: validOffer.ok ? null : validOffer.reason,
    source: best.source || null,
  }
}

// ---------- 一次性只读探测 ----------

function migrationDisabled(env) {
  // FOX_WIDGET_DISABLE_MIGRATION：迁移能力专用 kill switch（支持用，不是必需开关）
  if (String(env.FOX_WIDGET_DISABLE_MIGRATION || '') === '1') return 'disabled-by-migration-env'
  // 更新检查整体关闭时迁移探测也不发：它同样是一次出站请求
  if (String(env.WHALE_DISABLE_UPDATE_CHECK || '') === '1') return 'disabled-by-update-env'
  return null
}

// 探测一次并落 update-state.json 的 migrationProbe 字段。失败静默（不抛异常）；
// 离线 / 镜像全挂时只记录 reason，不拖慢任何调用方（ SessionStart 与 GET 路由都
// 是 fire-and-forget）。总预算 8 秒：逐源递减超时 + 预算用尽即停。
export async function probeMigrationOffer(opts = {}) {
  const env = opts.env || process.env
  const disabled = migrationDisabled(env)
  if (disabled) return { ok: false, skipped: disabled }
  const prev = readUpdateState().migrationProbe || null
  if (!opts.force && prev && prev.at && Date.now() - prev.at < PROBE_INTERVAL_MS) {
    return { ok: true, skipped: 'throttled', probe: prev }
  }
  const started = Date.now()
  const endpoints = opts.endpoints || buildVersionEndpoints()
  const current = opts.current || pluginVersion()
  const errors = []
  const seen = []
  for (const ep of endpoints) {
    if (Date.now() - started > PROBE_BUDGET_MS) {
      errors.push('探测预算（8s）用尽，剩余源跳过')
      break
    }
    try {
      const text = await fetchVersionText(ep.url, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: Math.max(PROBE_MIN_TIMEOUT_MS, PROBE_BUDGET_MS - (Date.now() - started)),
      })
      const m = parseRemoteManifest(text)
      if (!m.version) throw new Error('响应里没有版本号')
      seen.push({ ...m, source: ep.name })
    } catch (err) {
      errors.push(ep.name + ': ' + String((err && err.message) || err))
    }
  }
  const best = seen.length ? pickBestManifest(seen, { current }) : null
  const probe = {
    at: started,
    manifestVersion: best ? best.version : (prev && prev.manifestVersion) || null,
    eol: best ? best.eol : !!(prev && prev.eol),
    offer: best ? best.offer : null,
    // 本轮有错误（含预算用尽）时以本轮原因为准，不回放上一轮的旧结论
    reason: best ? best.reason : errors.length ? '全部探测源失败' : (prev && prev.reason) || '没有可用清单',
    source: best ? best.source || null : null,
  }
  if (errors.length) probe.errors = errors.slice(0, 6)
  writeUpdateState({ migrationProbe: probe })
  return { ok: !!best, probe, errors }
}

// 给服务端 GET /whale/update.json 用的 fire-and-forget 入口：节流已过期才真正探测。
// 永不抛异常；本回合响应先带旧结果，探测完成后下一轮询可见。
export function maybeProbeMigration(opts = {}) {
  if (migrationDisabled(opts.env || process.env)) return false
  const prev = readUpdateState().migrationProbe || null
  if (prev && prev.at && Date.now() - prev.at < PROBE_INTERVAL_MS) return false
  probeMigrationOffer(opts).catch(() => {})
  return true
}

// 给 SessionStart（lib/autostart.mjs）用的入口：探测要发网络请求（最长 8s），不能
// 拖慢宿主钩子，所以脱离本进程跑（detached 子进程执行 cli 的 migrate-probe）。
// 环境不满足（kill switch / 24h 内已探测）时连子进程都不起。
export function spawnMigrationProbe(opts = {}) {
  if (migrationDisabled(opts.env || process.env)) return false
  const prev = readUpdateState().migrationProbe || null
  if (prev && prev.at && Date.now() - prev.at < PROBE_INTERVAL_MS) return false
  try {
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'cli.mjs'), 'migrate-probe'], {
      cwd: PLUGIN_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: opts.env || process.env,
    })
    // spawn 失败只会异步 emit 'error'（与 lib/update.mjs 的 spawnDetachedCli 同理），
    // 不监听就是未捕获异常
    child.on('error', () => {})
    child.unref()
    return true
  } catch (err) {
    return false
  }
}

// ---------- 迁移预检（只读） ----------

// 归档时默认排除的大头（可重建 / 可重装项，见 MIGRATE-TO-FOX-DOCK-2.md §6.2）
const PREFLIGHT_SKIP_DIRS = ['desktop-runtime', 'update']
const PREFLIGHT_SKIP_PREFIX = 'overlay-profile-'

function dirStats(dir, depth = 0) {
  let bytes = 0
  let files = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth === 0 && (PREFLIGHT_SKIP_DIRS.indexOf(e.name) !== -1 || e.name.indexOf(PREFLIGHT_SKIP_PREFIX) === 0)) {
          continue
        }
        const sub = dirStats(path.join(dir, e.name), depth + 1)
        bytes += sub.bytes
        files += sub.files
      } else if (e.isFile()) {
        try {
          bytes += fs.statSync(path.join(dir, e.name)).size
          files++
        } catch (err) {}
      }
    }
  } catch (err) {}
  return { bytes, files }
}

function redactHomeText(text) {
  try {
    const home = os.homedir()
    return home ? String(text).split(home).join('~') : String(text)
  } catch (err) {
    return String(text)
  }
}

// 迁移预检：config.json 可读性与键名（只报名，不报值）、凭据数量（只报数量）、
// dock 在线性与版本、数据体积与磁盘余量、启动文件夹两只 VBS 的归属、上次更新
// 是否未完成。绝不写任何文件；结果里的路径都做了家目录脱敏。
export async function migrationPreflight(opts = {}) {
  const env = opts.env || process.env
  const dataDir = opts.dataDir || DATA_DIR
  const configFile = opts.configFile || CONFIG_FILE

  let cfg = null
  let cfgError = null
  try {
    cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch (err) {
    cfgError = String((err && err.code) || err.message || err)
  }
  const cfgKeys = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? Object.keys(cfg).sort() : []
  const objCount = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).length : 0)
  const credentials = {
    vendorKeys: objCount(cfg && cfg.vendorKeys),
    relayAuth: objCount(cfg && cfg.relayAuth),
    hasApiKey: !!(cfg && typeof cfg.apiKey === 'string' && cfg.apiKey),
    hasPlatformToken: !!(cfg && typeof cfg.platformToken === 'string' && cfg.platformToken),
  }

  const lock = readDockLock(env)
  const health = await dockHealth({ env, timeoutMs: opts.dockTimeoutMs || 1500 })
  const dockVersion = health && health.version ? String(health.version).replace(/^v/, '') : null
  const dock = {
    lockFound: !!lock,
    online: !!health,
    version: dockVersion,
    // 只认无后缀的 stable 三段式：compareVersions 会把 '2.0.0-pre.3' 折成更高的
    // 数字段，必须先用形状校验挡掉预发布（与迁移入口的 stable-only 同口径）
    versionOk: !!(dockVersion && EXACT_VERSION_RE.test(dockVersion) && compareVersions(dockVersion, MIGRATE_VERSION) >= 0),
  }

  const stats = dirStats(dataDir)
  let diskFree = null
  try {
    const st = fs.statfsSync(dataDir)
    diskFree = Number(st.bavail) * Number(st.bsize)
  } catch (err) {}
  const needBytes = Math.max(1, stats.bytes) * 2 // 归档估算 × 2 的安全余量（§6.3 预检）
  const disk = {
    freeBytes: diskFree,
    enough: typeof diskFree === 'number' ? diskFree >= needBytes : null,
  }

  const startupDir = defaultStartupDir(env)
  const ownVbs = watchVbsFile(startupDir)
  const dockCandidates = ['fox-dock.vbs', 'fox-dock.cmd']
    .map((name) => (startupDir ? path.join(startupDir, name) : ''))
    .filter(Boolean)
  const dockStartupFile = dockCandidates.find((p) => {
    try {
      return fs.existsSync(p)
    } catch (err) {
      return false
    }
  })
  const startup = {
    dir: redactHomeText(startupDir || ''),
    own: !!(ownVbs && fs.existsSync(ownVbs)),
    ownFile: ownVbs ? path.basename(ownVbs) : null,
    dock: !!dockStartupFile,
    dockFile: dockStartupFile ? path.basename(dockStartupFile) : null,
  }

  const up = readUpdateState()
  const current = opts.current || pluginVersion()
  const update = {
    // busy 挂着或「已更新待重启」都算上次更新未完成：迁移开始前必须先收敛
    pending: !!(up.busy || (up.appliedVersion && compareVersions(up.appliedVersion, current) > 0)),
    busy: !!up.busy,
    phase: up.phase || null,
  }

  const roots = discoverInstallRoots(opts.rootsOpts)
  const installs = { count: roots.length }

  const checks = {
    configReadable: !cfgError,
    dataDirExists: (() => {
      try {
        return fs.statSync(dataDir).isDirectory()
      } catch (err) {
        return false
      }
    })(),
    dataDirWritable: (() => {
      try {
        fs.accessSync(dataDir, fs.constants.W_OK)
        return true
      } catch (err) {
        return false
      }
    })(),
    diskEnough: disk.enough !== false,
    dockReady: dock.online && dock.versionOk,
    updateClean: !update.pending,
  }
  return {
    ok: checks.configReadable && checks.dataDirExists && checks.dataDirWritable && checks.diskEnough && checks.dockReady && checks.updateClean,
    checkedAt: new Date().toISOString(),
    target: { product: MIGRATE_PRODUCT, version: MIGRATE_VERSION, channel: MIGRATE_CHANNEL },
    checks,
    config: { readable: !cfgError, error: cfgError, keys: cfgKeys, credentials },
    data: { bytes: stats.bytes, files: stats.files, skippedDirs: PREFLIGHT_SKIP_DIRS.concat([PREFLIGHT_SKIP_PREFIX + '*']) },
    disk,
    dock,
    startup,
    update,
    installs,
  }
}
