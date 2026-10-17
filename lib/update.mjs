// 版本更新内核：探测新版本 → 走国内可达镜像下载源码包 → 替换安装目录 → 清理旧文件。
//
// 设计约束与取舍：
// 1) **不依赖 git 与 GitHub 直连**。国内网络对 github.com / raw.githubusercontent.com
//    经常不可达，因此探测与下载都以「镜像优先 + 直连兜底」的候选链进行，并把最近一次
//    成功的源记进状态文件，下次优先使用（命中缓存可减少无效请求）。
// 2) **出站严格校验**：所有候选 URL 都过 assertSafeUpstream（https + 主机白名单 +
//    拒绝环回/私有/保留地址），镜像名不在白名单内一律不请求。
// 3) **零依赖**：.tar.gz 用 node:zlib 解压 + 自带最小 tar 解析器（ustar + GNU 长名 +
//    pax path 记录），不调用系统 tar、不引入第三方包。
// 4) **只动代码，不动用户数据**：数据目录（widget-state / 账本 / 角色 / 素材）在
//    宿主的插件数据目录下（${CODEBUDDY_PLUGIN_DATA}），与安装目录分离，更新流程完全不触碰。
// 5) **删除限定在「上一个版本的文件清单」内**：清理旧文件靠安装时写下的 manifest；
//    没有 manifest 时，git 工作区用 git ls-files 兜底，非 git 的缓存目录整目录扫描，
//    两者都拿不到就只覆盖不删除（宁可留残留文件，也不误删用户文件）。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'
import { assertSafeUpstream } from './credentials.mjs'
import { DATA_DIR, PLUGIN_ROOT, pluginVersion } from './paths.mjs'
import { HOST_HOME } from './host.mjs'

export const REPO = 'pigeon189/zcode-fox-widget'

// ---------- 发布物完整性（供应链） ----------
//
// 下载链路会经过第三方镜像（ghproxy / jsdelivr 等），而落盘会直接覆盖 lib/*.mjs 并在
// 重启后执行——只校验「包内版本号 == 目标版本」是不够的：版本号与包体来自同一批镜像，
// 被劫持的镜像可以同时伪造两者，那个检查必然通过。
//
// 所以补一道**与来源无关**的校验：发布时随版本提交两份文件（由 tools/sign-release.mjs 生成）
//   .release-hashes.json      —— 逐个文件的 sha256（不含这两个文件自身）
//   .release-hashes.json.sig  —— 对该文件字节的 Ed25519 分离签名（base64）
// 信任锚是**已安装副本自带的公钥** `.release-pubkey.pem`：镜像无法伪造签名，包体即使来自
// 被劫持的镜像也会被拒。公钥自身随更新一起被替换，但替换后的那一版必须由**旧公钥对应的
// 私钥**签过名，链才成立（与 minisign 的 trusted comment 同型；换钥见 CONTRIBUTING）。
const HASH_MANIFEST = '.release-hashes.json'
const HASH_SIG = '.release-hashes.json.sig'
const PUBKEY_FILE = '.release-pubkey.pem'
const SHA256_RE = /^[0-9a-f]{64}$/

export const RELEASE_HASH_MANIFEST = HASH_MANIFEST
export const RELEASE_HASH_SIG = HASH_SIG
export const RELEASE_PUBKEY_FILE = PUBKEY_FILE

export function releasePublicKey(from) {
  try {
    return fs.readFileSync(path.join(from || PLUGIN_ROOT, PUBKEY_FILE), 'utf8')
  } catch (err) {
    return null
  }
}

// 校验下载内容（files: Map<相对路径, Buffer>）。不碰网络、不落盘，纯函数便于直接测。
export function verifyReleaseFiles(files, version, opts = {}) {
  const raw = files.get(HASH_MANIFEST)
  const sig = files.get(HASH_SIG)
  if (!raw || !sig) {
    return {
      ok: false,
      error:
        '该版本没有完整性清单（缺 ' +
        HASH_MANIFEST +
        '）：已拒绝安装。请改用市场「重新抓取」或手动安装最新版',
    }
  }
  const pub = opts.publicKey || releasePublicKey(opts.pluginRoot)
  if (!pub) {
    return { ok: false, error: '本副本没有内置发布公钥（缺 ' + PUBKEY_FILE + '），无法校验完整性' }
  }
  let verified = false
  try {
    const key = crypto.createPublicKey(pub)
    verified = crypto.verify(null, raw, key, Buffer.from(String(sig.toString('utf8')).trim(), 'base64'))
  } catch (err) {
    return { ok: false, error: '清单签名校验出错：' + String((err && err.message) || err) }
  }
  if (!verified) return { ok: false, error: '清单签名无效：包体可能被镜像篡改，已拒绝安装' }
  let manifest = null
  try {
    manifest = JSON.parse(raw.toString('utf8'))
  } catch (err) {
    return { ok: false, error: '完整性清单不是合法 JSON' }
  }
  if (!manifest || !manifest.files || typeof manifest.files !== 'object') {
    return { ok: false, error: '完整性清单结构不对（缺 files）' }
  }
  if (version && manifest.version && String(manifest.version) !== String(version)) {
    return { ok: false, error: '清单版本不符（清单 v' + manifest.version + '，目标 v' + version + '）' }
  }
  const allowed = new Set([HASH_MANIFEST, HASH_SIG])
  const problems = []
  for (const rel of Object.keys(manifest.files)) {
    const want = String(manifest.files[rel])
    if (!SHA256_RE.test(want)) {
      problems.push(rel + '：清单里不是合法 sha256')
      continue
    }
    const buf = files.get(rel)
    if (!buf) {
      problems.push(rel + '：包内缺失')
      continue
    }
    const got = crypto.createHash('sha256').update(buf).digest('hex')
    if (got !== want) problems.push(rel + '：内容与清单不符')
    allowed.add(rel)
  }
  // 清单之外的文件：运行时**宽松**处理（忽略 + 警告），发布自检走严格模式。
  // 旧行为是「多一个文件即拒装」——只要有人提交了新文件却忘了重跑签名，所有
  // 存量用户的挂件内更新都会失败，错误文案还是「包体可能被镜像篡改」，把一次
  // 漏签名放大成全体更新中断（审查 I7）。内容安全性由「清单内每个文件必须
  // 命中 sha256」保证，多出来的文件不写盘即可。
  const strictExtraFiles = opts.strictExtraFiles === true
  const extras = []
  for (const rel of files.keys()) {
    if (!allowed.has(rel)) extras.push(rel)
  }
  if (strictExtraFiles) {
    for (const rel of extras) problems.push(rel + '：清单里没有这个文件')
  }
  if (problems.length) {
    return { ok: false, error: '完整性校验未通过：' + problems.slice(0, 3).join('；') }
  }
  return {
    ok: true,
    manifest,
    fileCount: Object.keys(manifest.files).length,
    // 未签名、也因此不会写盘的多余文件（宽松模式下只告警）
    extras,
    warnings: extras.length ? ['已忽略清单外的文件（未签名，不写盘）：' + extras.slice(0, 5).join('、')] : [],
  }
}

// 本产品线（WorkBuddy）的代码住在同一个仓库的 `workbuddy` 分支上（同仓双分支，
// 见 MIGRATION-PLAN-WORKBUDDY §1.1）；发版 tag 用 `wb-v*` 前缀与 ZCode 线区分。
export const UPDATE_BRANCH = 'workbuddy'
export const TAG_PREFIX = 'wb-v'

// 插件缓存可能落在两处基址下：宿主的插件根 <HOST_HOME>/plugins（目录市场安装的
// 副本写在 plugins/cache/<市场>/<插件>/<版本>/），以及开发时的仓库副本。两个都扫
//（宁可多扫一处，也不要漏掉真实安装副本）。
function candidateBases() {
  const out = []
  const push = (b) => {
    try {
      const v = String(b || '').trim()
      if (!v) return
      const resolved = path.resolve(v)
      if (!out.some((x) => path.resolve(x) === resolved)) out.push(resolved)
    } catch (err) {}
  }
  push(path.join(HOST_HOME, 'plugins'))
  return out
}

// ---------- 常量 ----------

// 允许出站的主机（探测 + 下载共用）。均为 https；镜像只做「原样转发」，不引入
// 第三方账号或 token。
const UPDATE_HOSTS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'ghproxy.net',
  'gh-proxy.com',
  'mirror.ghproxy.com',
  'cdn.jsdelivr.net',
  'data.jsdelivr.com',
  'raw.gitmirror.com',
]

const CHECK_TIMEOUT_MS = 12000
// 整包下载超时：国内镜像实测 60–240 秒（同一镜像随网络波动很大），给足余量，
// 免得慢镜像被判失败后一路回退（回退一轮的代价比多等一会儿更大）
const DOWNLOAD_TIMEOUT_MS = 300000
const MAX_TARBALL_BYTES = 80 * 1024 * 1024
const MAX_FILES = 4000
const MAX_FILE_BYTES = 40 * 1024 * 1024
const MAX_TOTAL_BYTES = 300 * 1024 * 1024
const CHECK_INTERVAL_MS = 6 * 3600 * 1000 // 后台自动检查间隔
const FIRST_CHECK_DELAY_MS = 20 * 1000

const STATE_FILE = path.join(DATA_DIR, 'update-state.json')
// 每个安装 root 各占一条记录（单文件内按 root 分桶）：多 root 共用一条会在后写
// 覆盖先写，导致先写的那个 root 下次更新读不到自己的旧文件清单
const MANIFEST_FILE = path.join(DATA_DIR, 'update-files.json')
const WORK_DIR = path.join(DATA_DIR, 'update')
const BACKUP_DIR = path.join(WORK_DIR, 'backup')

export { UPDATE_HOSTS }

// ---------- 小工具 ----------

function readJsonFile(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? v : null
  } catch (err) {
    return null
  }
}

function writeJsonFile(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

// 版本号比较：只按数字段比大小（v1.10.0 / 1.10 / 1.10.0-beta 都收）。
// 返回 1 / 0 / -1。
export function compareVersions(a, b) {
  const norm = (v) =>
    String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((x) => (/^\d+$/.test(x) ? Number(x) : 0))
  const x = norm(a)
  const y = norm(b)
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const p = x[i] || 0
    const q = y[i] || 0
    if (p > q) return 1
    if (p < q) return -1
  }
  return 0
}

export function isValidVersion(v) {
  return typeof v === 'string' && /^\d+\.\d+(\.\d+)?$/.test(v.trim())
}

// 从 plugin.json 文本里取 version（下载校验与 jsdelivr 探测共用）
export function parsePluginJsonVersion(text) {
  try {
    const v = JSON.parse(String(text))
    return isValidVersion(v && v.version) ? String(v.version).trim() : null
  } catch (err) {
    return null
  }
}

// ---------- 候选地址 ----------

// 探测新版本：镜像优先，直连兜底。每项返回 {url, pick(body)->version|null}。
// 顺序按实测可达性排（2026-10-11 本机实测：ghproxy/gh-proxy 代理 raw 均 1s 内可达；
// GitHub API 直连可用；raw 直连、jsdelivr、gitmirror 在部分网络不可达 → 排最后；
// ghproxy 不代理 api.github.com（403）故不放该项）。
//
// 另加时间戳查询参数防缓存：这是**必须**的——实测刚发布 v1.11.0 后，ghproxy 代理
// 的 raw 仍在返回缓存里的旧版本（1.10.0），会让用户错过更新。GitHub raw 与各镜像
// 都会忽略未知查询参数，时间戳只用来让 CDN 的缓存键不命中。
export function buildVersionEndpoints() {
  const bust = '?t=' + Date.now()
  const rawMain = 'https://raw.githubusercontent.com/' + REPO + '/' + UPDATE_BRANCH + '/.codebuddy-plugin/plugin.json'
  // 两条产品线共用一个仓库，所以**不能**用 releases/latest（它只会返回「整体最新」，
  // 可能命中 ZCode 线的 v* tag）。列出 releases 后只挑 wb-v* 前缀里的最高版本。
  const api = 'https://api.github.com/repos/' + REPO + '/releases?per_page=30'
  const pickTag = (body) => {
    try {
      const list = JSON.parse(String(body))
      if (!Array.isArray(list)) return null
      let best = null
      for (const rel of list) {
        const tag = String((rel && rel.tag_name) || '').trim()
        if (!tag.startsWith(TAG_PREFIX)) continue
        const bare = tag.slice(TAG_PREFIX.length)
        if (!isValidVersion(bare)) continue
        if (best === null || compareVersions(bare, best) > 0) best = bare
      }
      return best
    } catch (err) {
      return null
    }
  }
  return [
    { name: 'ghproxy-raw', url: 'https://ghproxy.net/' + rawMain + bust, pick: parsePluginJsonVersion },
    { name: 'gh-proxy-raw', url: 'https://gh-proxy.com/' + rawMain + bust, pick: parsePluginJsonVersion },
    { name: 'github-api', url: api + bust, pick: pickTag },
    { name: 'raw-direct', url: rawMain + bust, pick: parsePluginJsonVersion },
    { name: 'jsdelivr', url: 'https://cdn.jsdelivr.net/gh/' + REPO + '@' + UPDATE_BRANCH + '/.codebuddy-plugin/plugin.json' + bust, pick: parsePluginJsonVersion },
    { name: 'gitmirror-raw', url: 'https://raw.gitmirror.com/' + REPO + '/' + UPDATE_BRANCH + '/.codebuddy-plugin/plugin.json' + bust, pick: parsePluginJsonVersion },
  ]
}

// 下载整包：镜像优先（单请求），jsdelivr 逐文件兜底（见 fetchViaJsdelivr）。
// 顺序同样按实测（gh-proxy 首块最快，其次 ghproxy，codeload 直连可用，
// mirror.ghproxy 实测超时 → 放最后）。
export function buildTarballUrls(version) {
  const tag = TAG_PREFIX + version
  const gh = 'https://github.com/' + REPO + '/archive/refs/tags/' + tag + '.tar.gz'
  return [
    // 直连优先（codeload 是 GitHub 自己的下载域，最可信），镜像只做兜底：内容完整性
    // 现在由发布签名保证（见文件头），镜像只影响「能不能下到」，不该影响「信不信」。
    { name: 'codeload', url: 'https://codeload.github.com/' + REPO + '/tar.gz/refs/tags/' + tag },
    { name: 'gh-proxy', url: 'https://gh-proxy.com/' + gh },
    { name: 'ghproxy', url: 'https://ghproxy.net/' + gh },
    { name: 'ghproxy-mirror', url: 'https://mirror.ghproxy.com/' + gh },
    { name: 'jsdelivr', url: null }, // 逐文件兜底：URL 由 fetchViaJsdelivr 现场拼
  ]
}

export function assertUpdateUrl(raw) {
  return assertSafeUpstream(raw, UPDATE_HOSTS)
}

// ---------- 网络 ----------

const MAX_REDIRECTS = 5

// 手动跟随重定向：`redirect:'follow'` 会把跳转后的 host 直接交给底层实现，
// 每一跳都不再过 assertUpdateUrl。镜像若被改成一个开放跳转，后面的跳转就出了
// 白名单（审查 X4）。这里自己跟，**每一跳**都过白名单；跳不出去就当作这个候选
// 失败，交给镜像链的下一项。
async function fetchWithTimeout(url, timeoutMs, opts = {}) {
  assertUpdateUrl(url)
  const doFetch = opts.fetchImpl || fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => {
    try {
      ctrl.abort()
    } catch (err) {}
  }, timeoutMs)
  try {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertUpdateUrl(current)
      // 带 UA：部分镜像/CDN 对无 UA 的请求会拒绝或降速
      const res = await doFetch(current, {
        redirect: 'manual',
        cache: 'no-store',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'fox-widget-update/' + pluginVersion() },
      })
      const status = Number(res && res.status) || 0
      if (status < 300 || status >= 400) return res
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null
      if (!loc) return res
      // 释放这一跳的响应体，别让连接挂着
      try {
        if (res.body && typeof res.body.cancel === 'function') await res.body.cancel()
      } catch (err) {}
      current = new URL(String(loc), current).toString()
    }
    throw new Error('更新下载重定向次数超过 ' + MAX_REDIRECTS + ' 次')
  } finally {
    clearTimeout(timer)
  }
}

// 读响应体的**有上限**版本：先看 Content-Length，再流式累计，超限立刻中止并释放
// 连接。只设超时是不够的——一个慢速但持续吐字节的响应可以在 5 分钟里把进程内存
// 撑爆（res.arrayBuffer() 先整包进内存，之后的大小检查已经晚了）。
export async function readBodyLimited(res, maxBytes, label) {
  const lenHeader = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN)
  const over = () => new Error((label || '响应') + '超过 ' + Math.round(maxBytes / 1048576) + 'MB 上限')
  if (Number.isFinite(lenHeader) && lenHeader > maxBytes) throw over()
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw over()
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.length
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch (err) {}
        throw over()
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    try {
      reader.releaseLock()
    } catch (err) {}
  }
  return Buffer.concat(chunks, total)
}

export async function fetchVersionText(url, opts = {}) {
  const res = await fetchWithTimeout(url, CHECK_TIMEOUT_MS, opts)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const buf = await readBodyLimited(res, 256 * 1024, '版本响应')
  return buf.toString('utf8')
}

// 下载前的 tag 存在性核对。探测链里有一半源读的是 `main` 分支的 plugin.json，
// 而下载一律按 tag 取包：发版窗口（版本号已提交、tag 还没推）里 raw 会报出一个
// 下载不到的新版本，用户点「立即更新」必然失败。
// 只有**明确 404**才判「尚未发布」；网络错误一律按「存在」处理——宁可让下载去
// 试一次，也不要漏报一个真实存在的新版本。
export async function verifyReleaseTag(version, opts = {}) {
  // tag 一律带本线前缀（wb-v*）：ZCode 线用 v*，按 v 复核会恒 404，把可用更新
  // 误判成「尚未发布」（2026-10-14 审查 P1-2 实测：三处探测全打在 v<版本> 上）
  const raw = 'https://raw.githubusercontent.com/' + REPO + '/' + TAG_PREFIX + version + '/.codebuddy-plugin/plugin.json'
  const bust = '?t=' + Date.now()
  const probes = [
    'https://ghproxy.net/' + raw + bust,
    'https://gh-proxy.com/' + raw + bust,
    'https://api.github.com/repos/' + REPO + '/git/ref/tags/' + TAG_PREFIX + version + bust,
  ]
  let saw404 = false
  for (const url of probes) {
    try {
      const res = await fetchWithTimeout(url, CHECK_TIMEOUT_MS, opts)
      if (res.ok) return true
      if (res.status === 404) saw404 = true
    } catch (err) {}
  }
  return saw404 ? false : true
}

// ---------- tar.gz 解包（纯 JS） ----------

function readStr(buf, start, len) {
  return buf.subarray(start, start + len).toString('utf8').replace(/\0+$/, '').trim()
}

function parsePaxRecords(body) {
  // pax 记录格式： "<len> <key>=<value>\n"（len 含自身长度）
  const out = {}
  let off = 0
  while (off < body.length) {
    const sp = body.indexOf(0x20, off)
    if (sp === -1) break
    const len = parseInt(body.subarray(off, sp).toString('utf8'), 10)
    if (!Number.isFinite(len) || len <= 0 || off + len > body.length) break
    const rec = body.subarray(sp + 1, off + len - 1).toString('utf8')
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    off += len
  }
  return out
}

// 返回 Map<相对路径, Buffer>。只收普通文件；目录/符号链接/硬链接跳过。
export function parseTar(buf) {
  const files = new Map()
  let off = 0
  let longName = null
  let paxPath = null
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    let allZero = true
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break
    const nameRaw = readStr(header, 0, 100)
    const prefix = readStr(header, 345, 155) // ustar prefix 字段：偏移 345、长 155
    const size = parseInt(readStr(header, 124, 12).replace(/[^0-7]/g, '') || '0', 8)
    const typeflag = String.fromCharCode(header[156] || 48)
    if (!Number.isFinite(size) || size < 0) throw new Error('tar 头 size 非法')
    const dataStart = off + 512
    const dataEnd = dataStart + size
    if (dataEnd > buf.length) throw new Error('tar 数据越界（包被截断？）')
    const body = buf.subarray(dataStart, dataEnd)
    if (typeflag === 'x' || typeflag === 'g') {
      const rec = parsePaxRecords(body)
      if (rec.path) paxPath = rec.path // 长路径 / 中文名
    } else if (typeflag === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '')
    } else if (typeflag === '0' || typeflag === '\u0000' || typeflag === '') {
      let name = longName || (prefix ? prefix + '/' + nameRaw : nameRaw)
      if (paxPath) name = paxPath
      files.set(name, Buffer.from(body))
      if (files.size > MAX_FILES) throw new Error('文件数超限')
      longName = null
      paxPath = null
    } else {
      // 目录(5) / 符号链接(2) / 硬链接(1) / 其它：跳过，同时清掉未消费的元数据
      longName = null
      paxPath = null
    }
    off = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

// 归档顶层目录（GitHub 的 <repo>-<sha>/）：所有可行条目共同的第一段才算。
// 判定时忽略「没有目录段」与「含 .. / . 段」这类可疑路径——否则归档里混进一条
// ../evil.js 就会让共同顶层判定失败，整包路径少剥一层（解包后找不到 plugin.json）。
export function detectTopDir(files) {
  let top = null
  let seen = 0
  for (const key of files.keys()) {
    const norm = key.replace(/\\/g, '/')
    if (norm.indexOf('/') === -1) return ''
    const parts = norm.split('/')
    if (parts.some((p) => p === '..' || p === '.' || p === '')) continue
    seen++
    if (top === null) top = parts[0]
    else if (top !== parts[0]) return ''
  }
  return seen && top ? top + '/' : ''
}

// 去掉顶层目录，并把路径收敛成安全的相对路径。任何绝对路径 / 含 .. / 含驱动器号
// 的条目直接丢弃。
export function normalizeArchivePaths(files, topPrefix) {
  const top = topPrefix === undefined ? detectTopDir(files) : topPrefix
  const out = new Map()
  for (const [key, body] of files) {
    const norm = key.replace(/\\/g, '/')
    let rel = top && norm.indexOf(top) === 0 ? norm.slice(top.length) : norm
    rel = rel.replace(/^\/+/, '')
    if (!rel) continue
    const parts = rel.split('/')
    if (parts.some((p) => p === '..' || p === '.' || p === '')) continue
    if (/^[a-zA-Z]:/.test(rel)) continue
    out.set(rel, body)
  }
  return out
}

export function extractTarGz(buf) {
  if (!buf || !buf.length) throw new Error('空包')
  if (buf.length > MAX_TARBALL_BYTES) throw new Error('压缩包超过 ' + Math.round(MAX_TARBALL_BYTES / 1048576) + 'MB 上限')
  // maxOutputLength：gzip 的放大比可以到 1000 倍以上（实测 64MB 的全 'A' 数据压成
  // 65KB），不设上限时一个高压缩比的恶意包会在解压阶段先吃满内存再报错
  const raw = zlib.gunzipSync(buf, { maxOutputLength: MAX_TOTAL_BYTES })
  const parsed = parseTar(raw)
  // 顶层目录按「剥掉后能找到 .codebuddy-plugin/plugin.json」为准：GitHub 归档有
  // <repo>-<sha>/ 顶层，git archive 之类没有；两种都收，且不许猜错到把 lib/
  // 当顶层剥掉。
  let files = normalizeArchivePaths(parsed)
  if (!files.has('.codebuddy-plugin/plugin.json')) {
    const alt = normalizeArchivePaths(parsed, '')
    if (alt.has('.codebuddy-plugin/plugin.json')) files = alt
  }
  let total = 0
  for (const [rel, body] of files) {
    if (body.length > MAX_FILE_BYTES) throw new Error('单文件超限: ' + rel)
    total += body.length
    if (total > MAX_TOTAL_BYTES) throw new Error('解包总量超限')
  }
  if (!files.size) throw new Error('包里没有文件')
  return files
}

// ---------- 下载 ----------

export async function downloadTarball(version, opts = {}) {
  const candidates = opts.candidates || buildTarballUrls(version)
  const errors = []
  for (const cand of candidates) {
    if (!cand.url) continue
    try {
      const res = await fetchWithTimeout(cand.url, DOWNLOAD_TIMEOUT_MS, opts)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const buf = await readBodyLimited(res, MAX_TARBALL_BYTES, '整包')
      const files = extractTarGz(buf)
      return { files, source: cand.name, bytes: buf.length }
    } catch (err) {
      errors.push(cand.name + ': ' + String((err && err.message) || err))
    }
  }
  // 兜底：jsdelivr 逐文件（国内可达性最好，代价是请求数多）
  if (opts.candidates === undefined) {
    try {
      const files = await fetchViaJsdelivr(version, opts)
      return { files, source: 'jsdelivr-files', bytes: 0 }
    } catch (err) {
      errors.push('jsdelivr-files: ' + String((err && err.message) || err))
    }
  }
  const e = new Error('全部下载源失败：' + errors.join(' | '))
  e.detail = errors
  throw e
}

// jsdelivr：先取文件清单（data.jsdelivr.com），再逐个文件从 CDN 拉。
// 作为 tarball 镜像全挂时的最后兜底路径。
// jsdelivr 的文件清单是**嵌套树**：节点的 name 只是自身名，目录信息在父子层级里。
// 递归拼出带目录的完整路径（纯函数，可单测 —— 2026-10-14 审查 P1-3：旧实现把
// paths 收成扁平 basename，URL 与落盘位置全错）。
export function jsdelivrTreePaths(tree, maxFiles) {
  const paths = []
  const walk = (nodes, prefix) => {
    for (const n of nodes || []) {
      if (!n || typeof n.name !== 'string') continue
      const p = prefix ? prefix + '/' + n.name : n.name
      if (n.type === 'directory') walk(n.files, p)
      else if (n.type === 'file') paths.push(p)
      if (paths.length > maxFiles) throw new Error('文件数超限')
    }
  }
  walk(tree && tree.files, '')
  return paths
}

export async function fetchViaJsdelivr(version, opts = {}) {
  const maxFiles = opts.maxFiles || MAX_FILES
  // ref 一律带本线前缀（wb-v*）：按 v 拼会 404；更糟的是若 ZCode 线存在同号 v tag，
  // 会拉回**另一条产品线**的文件树装进本副本（跨线污染，2026-10-14 审查 P1-3）
  const ref = TAG_PREFIX + version
  const listRes = await fetchWithTimeout('https://data.jsdelivr.com/v1/packages/gh/' + REPO + '@' + ref, CHECK_TIMEOUT_MS, opts)
  if (!listRes.ok) throw new Error('清单 HTTP ' + listRes.status)
  const tree = await listRes.json()
  const paths = jsdelivrTreePaths(tree, maxFiles)
  if (!paths.length) throw new Error('清单为空')
  const files = new Map()
  for (const p of paths) {
    const url = 'https://cdn.jsdelivr.net/gh/' + REPO + '@' + ref + '/' + p.split('/').map(encodeURIComponent).join('/')
    const res = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, opts)
    if (!res.ok) throw new Error(p + ' HTTP ' + res.status)
    const body = await readBodyLimited(res, MAX_FILE_BYTES, p)
    files.set(p, body)
  }
  return files
}

// ---------- 安装目录与落盘计划 ----------

// 需要更新的安装目录：插件仓库本体（= marketplace 目录）+ 宿主缓存里的安装副本。
export function discoverInstallRoots(opts = {}) {
  const roots = []
  const push = (dir) => {
    try {
      if (!dir) return
      const resolved = path.resolve(dir)
      if (roots.some((r) => path.resolve(r) === resolved)) return
      if (!fs.existsSync(path.join(resolved, '.codebuddy-plugin', 'plugin.json'))) return
      roots.push(resolved)
    } catch (err) {}
  }
  push(opts.pluginRoot || PLUGIN_ROOT)
  const bases = opts.bases || candidateBases()
  // 宿主注册表里的插件 id 形如 `<插件名>@<市场名>`。**同时接受旧名**
  // `zcode-fox-widget`：用户可能两端同装，两条产品线的副本都要照顾到。
  const ID_MARKERS = ['fox-widget']
  for (const base of bases) {
    // 注册表里记录的安装路径（<base>/installed_plugins.json）
    try {
      const reg = readJsonFile(path.join(base, 'installed_plugins.json'))
      const entries = reg && reg.plugins && typeof reg.plugins === 'object' ? Object.values(reg.plugins) : []
      for (const list of entries) {
        // 宿主的 installed_plugins.json 是 { version, plugins: { "<id>@<market>": [ {installPath} ] } }
        const arr = Array.isArray(list) ? list : [list]
        for (const e of arr) {
          if (!e || typeof e !== 'object') continue
          const id = String(e.id || e.pluginId || '')
          if (!ID_MARKERS.some((m) => id.indexOf(m) !== -1)) continue
          push(e.installPath || e.path || e.pluginRoot)
        }
      }
    } catch (err) {}
    // 缓存目录兜底扫描：<base>/cache/<市场>/<插件>/<版本>/
    try {
      const cacheBase = path.join(base, 'cache')
      for (const mp of fs.readdirSync(cacheBase)) {
        for (const marker of ID_MARKERS) {
          const p1 = path.join(cacheBase, mp, marker)
          if (!fs.existsSync(p1)) continue
          for (const ver of fs.readdirSync(p1)) push(path.join(p1, ver))
        }
      }
    } catch (err) {}
  }
  return roots
}

function walkFiles(root, prefix = '') {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
  } catch (err) {
    return out
  }
  for (const e of entries) {
    const rel = prefix ? prefix + '/' + e.name : e.name
    if (e.isDirectory()) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'update') continue
      out.push(...walkFiles(root, rel))
    } else if (e.isFile()) {
      out.push(rel)
    }
  }
  return out
}

// 上一个版本的文件清单：优先用安装时写下的 manifest；其次 git 工作区用 git ls-files；
// 再次（非 git 的缓存副本）整目录扫描。都拿不到就返回 null = 只覆盖不删除。
// 返回 { files, source }（source: 'manifest' | 'git' | 'scan'）——planApply 要靠
// source 区分「权威清单」与「兜底清单」（后者必须收紧删除范围，见 planApply）。
export function readOldFileList(root, opts = {}) {
  const manifest = opts.manifest === undefined ? readManifestFor(root) : opts.manifest
  if (manifest && Array.isArray(manifest.files) && manifest.files.length) {
    return { files: manifest.files.slice(), source: 'manifest' }
  }
  if (fs.existsSync(path.join(root, '.git'))) {
    // git 工作区：列出被跟踪的文件（不含 .git / 未跟踪的本地文件），本机没装 git
    // 或命令失败就返回 null —— 宁可留残留文件也不误删
    try {
      const r = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      if (r && r.status === 0 && typeof r.stdout === 'string') {
        const list = r.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith('.git/'))
        if (list.length) return { files: list, source: 'git' }
      }
    } catch (err) {}
    return null
  }
  const hasPluginJson = fs.existsSync(path.join(root, '.codebuddy-plugin', 'plugin.json'))
  if (hasPluginJson) return { files: walkFiles(root), source: 'scan' }
  return null
}

// 计算落盘计划：写入集（新增/变化）+ 删除集（旧清单里有、新包里没有的）。
export function planApply(root, files, oldList) {
  const list = Array.isArray(oldList) ? oldList : oldList && Array.isArray(oldList.files) ? oldList.files : null
  // 数组入参视为权威清单（保持既有调用口径）；对象入参看 source
  const source = Array.isArray(oldList) ? 'manifest' : (oldList && oldList.source) || null
  const write = []
  const skip = []
  for (const [rel, body] of files) {
    let same = false
    try {
      const abs = path.join(root, rel)
      const st = fs.statSync(abs)
      if (st.isFile() && st.size === body.length) {
        same = Buffer.compare(fs.readFileSync(abs), body) === 0
      }
    } catch (err) {}
    if (same) skip.push(rel)
    else write.push(rel)
  }
  const remove = []
  if (list) {
    const keep = new Set(files.keys())
    // 兜底清单（git ls-files / 整目录扫描）只清理「新包里也存在的顶层目录」下的
    // 条目：git 兜底给的是**当前 HEAD 的全部被跟踪文件**，本地领先目标 tag 的提交
    //（本机常态）若不设限就会被判成「上一版有、这一版没有」而删掉。
    const tops = new Set()
    if (source !== 'manifest') {
      for (const rel of files.keys()) {
        const i = rel.indexOf('/')
        tops.add(i === -1 ? rel : rel.slice(0, i))
      }
    }
    for (const rel of list) {
      if (keep.has(rel)) continue
      if (rel.startsWith('.git/') || rel.startsWith('node_modules/')) continue
      if (source !== 'manifest') {
        const i = rel.indexOf('/')
        if (!tops.has(i === -1 ? rel : rel.slice(0, i))) continue
      }
      try {
        if (!fs.statSync(path.join(root, rel)).isFile()) continue
      } catch (err) {
        continue
      }
      remove.push(rel)
    }
  }
  return { write, skip, remove }
}

// 备份受影响文件到 <data>/update/backup/<ts>/（只留最近一份）
export async function backupFiles(root, rels, stamp) {
  if (!rels.length) return null
  const dir = path.join(BACKUP_DIR, String(stamp))
  try {
    await fsp.mkdir(dir, { recursive: true })
    for (const rel of rels) {
      const src = path.join(root, rel)
      let st
      try {
        st = await fsp.stat(src)
      } catch (err) {
        continue
      }
      if (!st.isFile()) continue
      const dst = path.join(dir, rel)
      await fsp.mkdir(path.dirname(dst), { recursive: true })
      await fsp.copyFile(src, dst)
    }
    writeJsonFile(path.join(dir, 'root.json'), { root })
    return dir
  } catch (err) {
    return null
  }
}

export function pruneBackups(keep = 2) {
  try {
    const dirs = fs
      .readdirSync(BACKUP_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    while (dirs.length > keep) {
      const victim = dirs.shift()
      fs.rmSync(path.join(BACKUP_DIR, victim), { recursive: true, force: true })
    }
  } catch (err) {}
}

// 执行落盘：写入 → 删除（全程异步：同步写满 MAX_FILES 个文件会把服务的事件循环
// 按住好几秒，那期间 /whale/health、/whale/balance.json 全部无响应）
export async function applyToRoot(root, files, plan, stamp) {
  const result = { root, written: 0, removed: 0, backup: null, errors: [] }
  result.backup = await backupFiles(root, [...plan.write, ...plan.remove], stamp)
  for (const rel of plan.write) {
    try {
      const abs = path.join(root, rel)
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      await fsp.writeFile(abs, files.get(rel))
      result.written++
    } catch (err) {
      result.errors.push(rel + ': ' + String((err && err.message) || err))
    }
  }
  for (const rel of plan.remove) {
    try {
      await fsp.rm(path.join(root, rel), { force: true })
      result.removed++
    } catch (err) {
      result.errors.push(rel + ': ' + String((err && err.message) || err))
    }
  }
  return result
}

// 读整个清单文件（分桶：每个 root 一条）。兼容旧格式（单条 { root, files }）。
function readManifestStore() {
  const raw = readJsonFile(MANIFEST_FILE)
  if (!raw || typeof raw !== 'object') return {}
  if (raw.root && Array.isArray(raw.files)) {
    return { [path.resolve(raw.root)]: { version: raw.version || null, files: raw.files, at: raw.at || null } }
  }
  const roots = raw.roots && typeof raw.roots === 'object' ? raw.roots : {}
  const out = {}
  for (const [k, v] of Object.entries(roots)) {
    if (v && Array.isArray(v.files)) out[path.resolve(k)] = { version: v.version || null, files: v.files, at: v.at || null }
  }
  return out
}

export function readManifestFor(root) {
  return readManifestStore()[path.resolve(root)] || null
}

export function writeManifest(root, files, version) {
  const store = readManifestStore()
  store[path.resolve(root)] = {
    version: version || null,
    files: Array.from(files.keys()).sort(),
    at: new Date().toISOString(),
  }
  // 上限只为防「反复换缓存目录」把文件撑大；正常 root 数是个位数
  const keys = Object.keys(store)
  if (keys.length > 8) {
    keys.sort((a, b) => String(store[a].at || '').localeCompare(String(store[b].at || '')))
    for (const k of keys.slice(0, keys.length - 8)) delete store[k]
  }
  writeJsonFile(MANIFEST_FILE, { roots: store })
}

// 清理更新工作区里的临时文件与过期备份
export function cleanupWorkspace() {
  try {
    for (const name of fs.readdirSync(WORK_DIR)) {
      if (name === 'backup') continue
      fs.rmSync(path.join(WORK_DIR, name), { recursive: true, force: true })
    }
  } catch (err) {}
  pruneBackups(2)
}

// ---------- 状态 ----------

const DEFAULT_STATE = {
  checkedAt: null,
  current: null,
  latest: null,
  available: false,
  source: null,
  error: null,
  busy: false,
  phase: null, // checking | downloading | applying | done | error
  progress: 0,
  message: null,
  appliedVersion: null,
  appliedAt: null,
  notified: null, // 已提醒过的版本
}

export function readUpdateState() {
  const s = readJsonFile(STATE_FILE) || {}
  return { ...DEFAULT_STATE, ...s }
}

export function writeUpdateState(patch) {
  const next = { ...readUpdateState(), ...patch }
  writeJsonFile(STATE_FILE, next)
  return next
}

// ---------- 编排 ----------

export async function checkForUpdate(opts = {}) {
  const current = opts.current || pluginVersion()
  const state = readUpdateState()
  const endpoints = opts.endpoints || buildVersionEndpoints()
  // 上次成功的源优先（少一次无效请求）；但**不**因为它就先信它——见下面多源取最大
  const ordered = state.source ? [...endpoints].sort((a, b) => (a.name === state.source ? -1 : b.name === state.source ? 1 : 0)) : endpoints
  const errors = []
  let best = null // 所有候选里见过的最高版本
  for (const ep of ordered) {
    try {
      const text = await fetchVersionText(ep.url, opts)
      const latest = ep.pick(text)
      if (!latest) throw new Error('响应里没有版本号')
      if (!best || compareVersions(latest, best.version) > 0) best = { version: latest, source: ep.name }
      // 比当前版本还新 = 权威的新版本信号（缓存只会让镜像停留在旧值，不会凭空
      // 造出更高的版本），可以立刻采纳，不必再问其余源
      if (compareVersions(latest, current) > 0) break
    } catch (err) {
      errors.push(ep.name + ': ' + String((err && err.message) || err))
    }
  }
  if (best) {
    // 全部候选都没给出「更新」时取最大值：镜像缓存可能停留在旧版本（实测
    // 刚发版后 ghproxy 代理的 raw 仍返回上一版），所以不能只看第一个响应
    let available = compareVersions(best.version, current) > 0
    let message = null
    // 探测有半数读 main 分支、下载一律按 tag：发版窗口里 raw 会报出一个下载不到
    // 的版本。核对 tag，不存在时按「暂无更新」处理并说明原因，避免用户点下去
    // 一路 404。github-api 本身就是 tag 来源，不用再核。
    if (available && opts.verifyTag !== false && best.source !== 'github-api') {
      const exists = await verifyReleaseTag(best.version, opts)
      if (!exists) {
        available = false
        message = 'v' + best.version + ' 尚未发布可下载包（发版中），稍后再试'
      }
    }
    const patch = {
      checkedAt: Date.now(),
      current,
      latest: best.version,
      available,
      source: best.source,
      error: null,
      message, // 每次检查都覆盖，避免上一次的说明残留
    }
    if (!patch.available) patch.notified = null
    writeUpdateState(patch)
    return readUpdateState()
  }
  const patch = { checkedAt: Date.now(), current, error: '检查失败：' + errors.join(' | '), busy: false, phase: 'error' }
  writeUpdateState(patch)
  return readUpdateState()
}

// 把已下载的整包落到安装目录（网络之外的全部工作，独立导出便于测试）。
export async function applyUpdateFiles(files, version, roots, opts = {}) {
  const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, '-')
  const results = []
  for (const root of roots) {
    const oldList = readOldFileList(root)
    const plan = planApply(root, files, oldList)
    results.push(await applyToRoot(root, files, plan, stamp))
    // 每个 root 各写自己那条清单：多 root 共用一条会被后写覆盖
    writeManifest(root, files, version)
  }
  cleanupWorkspace()
  return results
}

// 下载 + 落盘（供 POST /whale/update.json?action=update 调用）。全过程写状态，
// 前端轮询 GET 看进度。
export async function runUpdate(opts = {}) {
  const state = readUpdateState()
  if (state.busy) return { ok: false, error: '已有更新任务在进行' }
  const current = pluginVersion()
  let latest = state.latest
  writeUpdateState({ busy: true, phase: 'downloading', progress: 0, message: '正在下载 v' + (latest || '?'), error: null })
  try {
    if (!latest || compareVersions(latest, current) <= 0) {
      const s = await checkForUpdate({ current, fetchImpl: opts.fetchImpl })
      if (!s.available) throw new Error('没有可用的新版本')
      latest = s.latest
    }
    const dl = opts.files
      ? { files: opts.files, source: opts.source || 'injected' }
      : await downloadTarball(latest, opts)
    const manifestBuf = dl.files.get('.codebuddy-plugin/plugin.json') || Buffer.from('')
    const manifestText = manifestBuf.toString('utf8')
    const manifestVersion = parsePluginJsonVersion(manifestText)
    if (!manifestVersion || manifestVersion !== latest) {
      throw new Error('下载内容版本不符（期望 v' + latest + '，包内 v' + (manifestVersion || '未知') + '）')
    }
    // 跨线污染防线（2026-10-14 审查 P1-3）：除版本外再校验包内清单的插件名 ——
    // 若 ref 拉到的是另一条产品线的包（名字不同），拒绝安装
    let manifestName = ''
    try {
      manifestName = String(JSON.parse(manifestText).name || '')
    } catch (err) {}
    let selfName = ''
    try {
      selfName = String(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codebuddy-plugin', 'plugin.json'), 'utf8')).name || '')
    } catch (err) {}
    if (selfName && manifestName && manifestName !== selfName) {
      throw new Error('下载内容不是本插件（包内 name=' + manifestName + '，本插件 ' + selfName + '）——疑似跨产品线的包，拒绝安装')
    }
    // 与来源无关的完整性校验：逐个文件比对发布时签名的 sha256 清单（见文件头的说明）。
    // 不通过就到此为止，绝不落盘。
    const integ = verifyReleaseFiles(dl.files, latest, opts)
    if (!integ.ok) throw new Error(integ.error)
    // 清单外的文件只忽略、不落盘（宽松模式）：否则「提交了新文件但忘了重签名」
    // 会让所有用户卡在这条更新上（审查 I7）。清单内的文件已逐个校验 sha256。
    let applyFiles = dl.files
    if (integ.extras && integ.extras.length) {
      applyFiles = new Map(dl.files)
      for (const rel of integ.extras) applyFiles.delete(rel)
    }
    writeUpdateState({
      phase: 'applying',
      progress: 80,
      message: '正在替换文件（完整性校验已通过' + (integ.extras && integ.extras.length ? '，已忽略 ' + integ.extras.length + ' 个未签名文件' : '') + '）',
    })
    const roots = opts.roots || discoverInstallRoots()
    const results = await applyUpdateFiles(applyFiles, latest, roots)
    const failed = results.filter((r) => r.errors.length)
    const patch = {
      busy: false,
      phase: failed.length ? 'error' : 'done',
      progress: 100,
      message: failed.length
        ? '部分文件写入失败：' + failed[0].errors[0]
        : '已更新到 v' + latest + '（重启挂件后生效）',
      error: failed.length ? '写入失败' : null,
      appliedVersion: latest,
      appliedAt: Date.now(),
      available: false,
      latest,
      current: latest,
      notified: null,
      source: dl.source,
    }
    writeUpdateState(patch)
    return { ok: !failed.length, state: readUpdateState(), roots: results }
  } catch (err) {
    const message = String((err && err.message) || err)
    writeUpdateState({ busy: false, phase: 'error', message: '更新失败：' + message, error: message })
    return { ok: false, error: message }
  }
}

// 后台定时检查（首次延迟 20s，避免与会话启动抢资源）。
//
// **WorkBuddy 分支默认关闭自更新**（MIGRATION-PLAN-WORKBUDDY §3.6 / §7.3 的决策）：
//   ZCode 版的自更新会把新版本文件**原地覆盖**到每个安装目录，其中包括客户端 cache
//   快照。而 WorkBuddy 的版本账本由 `installed_plugins.json` 记录、目录名里带版本号，
//   原地覆盖会让「cache 里的文件」与「注册表记的版本」对不上，和宿主的插件管理打架。
//   所以这里改成：**必须显式打开**才启用（FOX_WIDGET_ENABLE_UPDATE_CHECK=1），
//   推荐做法是 `git pull` + 客户端重抓市场（见 README「更新」一节）。
// WHALE_DISABLE_UPDATE_CHECK=1 仍然有效（显式关闭，优先级最高）。
export function startAutoCheck() {
  if (String(process.env.WHALE_DISABLE_UPDATE_CHECK || '') === '1') return false
  if (String(process.env.FOX_WIDGET_ENABLE_UPDATE_CHECK || '') !== '1') return false
  const tick = () => {
    checkForUpdate({}).catch(() => {})
  }
  setTimeout(tick, FIRST_CHECK_DELAY_MS)
  setInterval(tick, CHECK_INTERVAL_MS)
  return true
}

// 重启挂件（服务 + 桌面浮层）。脱离父进程执行，避免「停自己」把重启流程一起带走。
export function spawnRestart() {
  return spawnDetachedCli('restart-all')
}

// 关闭插件（服务 + 桌面浮层 + 记下「用户关过」）。同样必须脱离父进程——这个流程
// 的第一步就是把当前服务停掉，留在父进程里会被自己一起带走（与重启同理）。
export function spawnClose() {
  return spawnDetachedCli('close')
}

function spawnDetachedCli(command) {
  try {
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'cli.mjs'), command], {
      cwd: PLUGIN_ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    // spawn 失败（execPath 不可执行等）只会异步 emit 'error'：不监听就是未捕获
    // 异常，会把服务进程一起带走（审查 I1 的同型问题）。这里的语义只是「尽力
    // 起一个后台流程」，失败记 false 即可。
    child.on('error', () => {})
    child.unref()
    return true
  } catch (err) {
    return false
  }
}
