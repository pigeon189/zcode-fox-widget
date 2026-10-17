// WorkBuddy狐娘小挂件的本地 HTTP 服务。
//
// 对应上游 DSH 版的 webServer 路由表，但 ZCode 插件没有「往界面注入脚本」的
// 能力，所以改为自带一个独立页面：浏览器打开 http://127.0.0.1:<port>/ 就是
// 同一只鲸鱼挂件。
//
// 安全边界（本地服务容易被任意网页探测）：
//   - 只监听 127.0.0.1，不对外暴露
//   - 校验 Host 头，防 DNS rebinding
//   - 写操作校验 Origin + 只收 JSON body，拒绝浏览器跨站伪造
//   - server.json 含关机令牌，落盘按 0600（POSIX；Windows 靠用户目录 ACL 兜底）
//   - 不返回通配 CORS 头（页面与接口同源，不需要跨域）
//   - 出站请求一律过 assertSafeUpstream（协议白名单 + 主机白名单 + 拒环回/私有）
//
// 本地威胁模型（有意取舍，勿当遗漏）：
//   浏览器侧的攻击面已由 Host/Origin/JSON body 三重挡住。**同一用户的本机进程
//   在信任边界之内**——它们本来就能直接读写插件数据目录下的数据文件（记账
//   账本、widget-state 等），给写接口加 HTTP 令牌不构成屏障：写接口的合法调用方
//   是同源页面，令牌必须能被页面取到，就必然也能被本机进程取到，防不住有心者，
//   只是给每个写路径增加仪式感。因此「改挂件状态 / 上传图片与音效 / 余额校正
//   落账」等写操作对本机进程免令牌，是显式选择而非疏漏。
//   唯一的例外是 /whale/shutdown：页面从不调用它，令牌只存在 server.json 里、
//   从不下发给渲染器——这是唯一一处令牌真正抬高门槛的地方（挡误触与顺手调用）。
//   这就是「关机要令牌、写数据不要」这一不对称的由来。
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyBalanceCorrection,
  balanceAdjustmentSummary,
  getBalance,
  invalidateBalanceCache,
  readWidgetState,
  writeWidgetState,
} from './balance.mjs'
import { findApiKey, maskKey, readPluginConfig, describeKeyProbe } from './credentials.mjs'
import {
  BUBBLE_CONTENT_FILE,
  BUBBLE_TEMPLATES_FILE,
  BUBBLE_IMGS_DIR,
  BUBBLE_IMGS_INDEX_FILE,
  BUILTIN_ROLES,
  BUILTIN_ROLE_RENAMES,
  BUILTIN_SOUND_NAMES,
  DATA_DIR,
  DEFAULT_PORT,
  DEFAULT_ROLE_ID,
  GIF_CANDIDATES,
  IMAGE_CANDIDATES,
  pluginVersion,
  ROLES_DIR,
  ROLES_INDEX_FILE,
  SERVER_INFO_FILE,
  SOUND_SETS,
  SOUNDS_DIR,
  SOUNDS_INDEX_FILE,
  TURN_SEQ_FILE,
  WIDGET_STATE_FILE,
} from './paths.mjs'
import { readLatestTurn, turnIdentity, readActiveSelection, readLatestUsageModel, readContextUsage } from './turn-cost.mjs'
import { resolveHostBillingSource } from './source.mjs'
import { readPlanBalance, turnPlanUsage } from './plan-balance.mjs'
import { readCmdgoQuota } from './cmdgo.mjs'
import { listVendorStatus, pickVendorBalance } from './vendors.mjs'
import { usageRecords } from './usage-records.mjs'
import { HOST_APP_ID } from './host.mjs'
import { readHostTheme } from './host-theme.mjs'
import { checkForUpdate, compareVersions, readUpdateState, runUpdate, spawnClose, spawnRestart, startAutoCheck } from './update.mjs'
import { probeHealth } from './service.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET_JS = path.join(HERE, 'widget.js')
const VERSION = pluginVersion()
const MAX_BODY = 8192
const TOKEN = crypto.randomBytes(16).toString('hex')

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// 只读一次的资产缓存（图片/音效每次请求读盘、no-store，避免换素材后浏览器
// 仍用旧字节——这点沿用了上游的结论）。
function readFirst(candidates) {
  for (const p of candidates) {
    try {
      const bytes = fs.readFileSync(p)
      if (bytes && bytes.length > 0) return bytes
    } catch (err) {}
  }
  return null
}

// ---------- 自定义角色 ----------
const ROLE_MAX_BYTES = 3 * 1024 * 1024

// 索引结构：{ roles:[导入件], hiddenBuiltins:[被删掉的内置形象 id] }
// 内置形象是包内素材，删不掉文件，所以「删除内置形象」= 记进 hiddenBuiltins
// 隐藏起来（想找回来：清掉这个数组里对应 id 即可，README 有写）。
function readRolesIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ROLES_INDEX_FILE, 'utf8'))
    if (parsed && Array.isArray(parsed.roles)) {
      if (!Array.isArray(parsed.hiddenBuiltins)) parsed.hiddenBuiltins = []
      // 内置角色 id 曾用名（xiaohuniang→fox）：旧索引里记的隐藏项读取时归一
      else parsed.hiddenBuiltins = parsed.hiddenBuiltins.map((id) => BUILTIN_ROLE_RENAMES[id] || id)
      return parsed
    }
  } catch (err) {}
  return { roles: [], hiddenBuiltins: [] }
}

function isBuiltinRole(id) {
  return BUILTIN_ROLES.some((r) => r.id === id)
}

// 可见的内置形象（按 BUILTIN_ROLES 顺序，过滤掉被删的）
function visibleBuiltins(idx) {
  const hidden = Array.isArray(idx.hiddenBuiltins) ? idx.hiddenBuiltins : []
  return BUILTIN_ROLES.filter((r) => hidden.indexOf(r.id) === -1)
}

// 角色图：返回 { bytes, ext }（上传允许 png/gif/jpeg，取图要按真实扩展名给
// Content-Type，不能一律 image/png —— 否则 GIF/JPEG 角色图靠浏览器嗅探才不破图）。
function readRoleImageEntry() {
  const stateRoleId = readWidgetState().roleId
  // 未指定（null）= 默认角色嘎啦嘛；旧「默认」鲸鱼改为显式 id 'whale'
  const roleId = stateRoleId || DEFAULT_ROLE_ID
  const idx = readRolesIndex()
  const builtin = visibleBuiltins(idx).find((r) => r.id === roleId)
  if (builtin) {
    const bytes = readFirst([builtin.image])
    return bytes ? { bytes, ext: path.extname(builtin.image).slice(1).toLowerCase() } : null
  }
  const entry = idx.roles.find((r) => r && r.id === roleId)
  if (!entry || typeof entry.file !== 'string') return null
  // basename 夹住文件名：索引被手改也不会越出角色目录
  const full = path.join(ROLES_DIR, path.basename(entry.file))
  try {
    const bytes = fs.readFileSync(full)
    return bytes && bytes.length ? { bytes, ext: path.extname(entry.file).slice(1).toLowerCase() } : null
  } catch (err) {
    return null
  }
}
function readRoleImage() {
  const hit = readRoleImageEntry()
  return hit ? hit.bytes : null
}

function listRoles() {
  const idx = readRolesIndex()
  // 内置形象固定在前（嘎啦嘛=默认、大肥鱼=原「默认」），用户上传件在后；
  // 被删掉的内置形象不再出现。
  const roles = visibleBuiltins(idx)
    .map((r) => ({ id: r.id, name: r.name, builtin: true }))
    .concat(idx.roles)
  const selected = readWidgetState().roleId || DEFAULT_ROLE_ID
  // 选中的正好是被删掉的内置形象（或已不存在的 id）时如实回落，别让页面拿着
  // 一个列表里没有的选中项
  const alive = roles.some((r) => r.id === selected)
  return { ok: true, roles, selected: alive ? selected : roles.length ? roles[0].id : '' }
}

function saveRole(parsed) {
  const name = parsed && typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 40) : ''
  const dataUrl = parsed && typeof parsed.dataUrl === 'string' ? parsed.dataUrl : ''
  const m = /^data:image\/(png|gif|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) return { ok: false, error: 'dataUrl 不是受支持的图片（png/gif/jpeg）' }
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
  let buf
  try {
    buf = Buffer.from(m[2], 'base64')
  } catch (err) {
    return { ok: false, error: 'base64 解码失败' }
  }
  if (!buf.length || buf.length > ROLE_MAX_BYTES) return { ok: false, error: '图片为空或超过 3MB' }
  fs.mkdirSync(ROLES_DIR, { recursive: true })
  const idx = readRolesIndex()
  // 随机 id 且与现有角色不撞（撞了文件会互相覆盖）
  let id
  do {
    id = 'r' + crypto.randomBytes(6).toString('hex')
  } while (idx.roles.some((r) => r && r.id === id))
  const file = id + '.' + ext
  fs.writeFileSync(path.join(ROLES_DIR, file), buf)
  idx.roles.push({ id, name: name || id, file, addedAt: Date.now() })
  while (idx.roles.length > 20) {
    const removed = idx.roles.shift()
    try {
      fs.rmSync(path.join(ROLES_DIR, path.basename(removed.file)), { force: true })
    } catch (err) {}
  }
  // 索引写失败必须回滚：图片已落盘而索引没有它时，listRoles/readRoleImage
  // 都找不到这个角色——前端却提示「成功」，实际是孤儿文件 + 上传不生效。
  if (!writeRolesIndex(idx)) {
    try {
      fs.rmSync(path.join(ROLES_DIR, file), { force: true })
    } catch (err) {}
    return { ok: false, error: '写入角色索引失败' }
  }
  writeWidgetState({ roleId: id }) // 上传后直接启用
  return { ok: true, id, name: name || id }
}

function writeRolesIndex(idx) {
  try {
    fs.writeFileSync(ROLES_INDEX_FILE, JSON.stringify(idx, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

// 重命名导入的角色（内置形象是包内素材，没有名字可改）
function renameRole(parsed) {
  const id = parsed && typeof parsed.id === 'string' ? parsed.id : ''
  const name = parsed && typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 24) : ''
  if (!id || !name) return { ok: false, error: '缺少角色 id 或名称' }
  const idx = readRolesIndex()
  const entry = idx.roles.find((r) => r && r.id === id)
  if (!entry) return { ok: false, error: '只能重命名导入的角色' }
  entry.name = name
  if (!writeRolesIndex(idx)) return { ok: false, error: '无法写入角色索引' }
  return Object.assign({ ok: true }, listRoles())
}

// 删除角色：导入件连图片一起清；内置形象是包内素材，改为记进 hiddenBuiltins
// 隐藏（列表里不再出现，想找回就在 roles.json 里删掉那个 id）。
// 删掉的正好是当前选中形象时必须换一个：否则 /whale/image.png 会 404，鲸鱼整个消失。
function deleteRole(parsed) {
  const id = parsed && typeof parsed.id === 'string' ? parsed.id : ''
  if (!id) return { ok: false, error: '缺少角色 id' }
  const idx = readRolesIndex()
  if (isBuiltinRole(id)) {
    if (idx.hiddenBuiltins.indexOf(id) === -1) idx.hiddenBuiltins.push(id)
    if (!writeRolesIndex(idx)) return { ok: false, error: '无法写入角色索引' }
  } else {
    const at = idx.roles.findIndex((r) => r && r.id === id)
    if (at === -1) return { ok: false, error: '找不到这个角色' }
    const entry = idx.roles.splice(at, 1)[0]
    if (!writeRolesIndex(idx)) return { ok: false, error: '无法写入角色索引' }
    try {
      if (entry && typeof entry.file === 'string' && entry.file) {
        fs.rmSync(path.join(ROLES_DIR, path.basename(entry.file)), { force: true })
      }
    } catch (err) {}
  }
  if (readWidgetState().roleId === id) {
    const next = listRoles()
    writeWidgetState({ roleId: next.selected || '' })
  }
  return Object.assign({ ok: true, deleted: id }, listRoles())
}

// ---------- 音效集（内置 duck/fx1 + 导入）----------
// 一个「音效集」= 按压音 + 松手音（上游语义）。内置集是包内素材（SOUND_SETS），
// 导入集落在 DATA_DIR/sounds 下，名字与文件名记在 sounds.json。
// 导入时给 1 个文件就按压/松手共用，给 2 个则第 1 个按压、第 2 个松手。
const SOUND_MAX_BYTES = 2 * 1024 * 1024
const SOUND_SETS_MAX = 20
// data:audio/<mime>;base64,... → 存盘扩展名 + 回放 Content-Type
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

function readSoundsIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SOUNDS_INDEX_FILE, 'utf8'))
    if (parsed && Array.isArray(parsed.sets)) return parsed
  } catch (err) {}
  return { sets: [] }
}

function writeSoundsIndex(idx) {
  try {
    fs.writeFileSync(SOUNDS_INDEX_FILE, JSON.stringify(idx, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

function isBuiltinSound(id) {
  return Object.prototype.hasOwnProperty.call(SOUND_SETS, id)
}

function listSounds() {
  const idx = readSoundsIndex()
  const sets = Object.keys(SOUND_SETS)
    .map((id) => ({ id, name: BUILTIN_SOUND_NAMES[id] || id, builtin: true }))
    .concat(idx.sets.map((s) => ({ id: s.id, name: s.name || s.id, builtin: false })))
  const selected = readWidgetState().soundSet || 'duck'
  const alive = sets.some((s) => s.id === selected)
  return { ok: true, sets, selected: alive ? selected : 'duck' }
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
  const rawName = value && typeof value === 'object' && typeof value.name === 'string' ? value.name : ''
  return { ok: true, buf, ext: kind.ext, type: kind.type, name: rawName }
}

// 导入一个音效集：press 必填，release 可选（缺省与 press 同文件）
function saveSoundSet(parsed) {
  const name = parsed && typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 24) : ''
  const press = decodeAudioField(parsed && parsed.press, '按压音')
  if (!press.ok) return { ok: false, error: press.error }
  const releaseRaw = parsed && parsed.release
  const release = releaseRaw ? decodeAudioField(releaseRaw, '松手音') : null
  if (release && !release.ok) return { ok: false, error: release.error }
  const idx = readSoundsIndex()
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
  // 名字优先取上传者填写的，其次取第一个文件名（去掉扩展名）
  const fallbackName = String(press.name || (parsed && parsed.pressName) || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .trim()
    .slice(0, 24)
  idx.sets.push({ id, name: name || fallbackName || '自定义音效', press: pressFile, release: relFile, addedAt: Date.now() })
  if (!writeSoundsIndex(idx)) return { ok: false, error: '无法写入音效索引' }
  return Object.assign({ ok: true, id }, listSounds())
}

function deleteSoundSet(parsed) {
  const id = parsed && typeof parsed.id === 'string' ? parsed.id : ''
  if (!id) return { ok: false, error: '缺少音效 id' }
  if (isBuiltinSound(id)) return { ok: false, error: '内置音效不可删除' }
  const idx = readSoundsIndex()
  const at = idx.sets.findIndex((s) => s && s.id === id)
  if (at === -1) return { ok: false, error: '找不到这个音效' }
  const entry = idx.sets.splice(at, 1)[0]
  if (!writeSoundsIndex(idx)) return { ok: false, error: '无法写入音效索引' }
  for (const f of [entry && entry.press, entry && entry.release]) {
    try {
      if (typeof f === 'string' && f) fs.rmSync(path.join(SOUNDS_DIR, path.basename(f)), { force: true })
    } catch (err) {}
  }
  // 删掉的正好在用：回落内置第一套，否则页面拿着一个不存在的 set 会静音
  if (readWidgetState().soundSet === id) writeWidgetState({ soundSet: 'duck' })
  return Object.assign({ ok: true, deleted: id }, listSounds())
}

// 回放：内置集读包内素材，导入集读数据目录。找不到返回 null（路由回 404）。
function resolveSoundBytes(setId, kind) {
  const want = kind === 'release' ? 'release' : 'press'
  if (isBuiltinSound(setId)) {
    const bytes = readFirst(SOUND_SETS[setId][want])
    return bytes ? { bytes, type: 'audio/mpeg' } : null
  }
  const entry = readSoundsIndex().sets.find((s) => s && s.id === setId)
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

// ---------- 按压泡泡（自定义泡泡）----------
// 结构 v2：{ v:2, tapAdvance:bool, steps:[{ modules:[module] }] }
//   steps[0] 在按压时显示，之后每点一下气泡推进一步，走完收起；
//   tapAdvance=false 时点角色总是显示第 1 步（点气泡收起）。
//   module：{ type:'text', text, size } 文本（换行分行）
//         | { type:'rand', lines:[..], size } 随机语句池（出泡时随机取一条）
//   size：B=大字 / A=中字 / C=小字；渲染最多占气泡的 3 行。
// 兼容：旧 v1（{ v:1, first:{text,size}|null, items:[{text,size}] }）读取时
// 迁移为 v2（first → 第 1 步，items → 后续步）；文字只在前端 textContent
// 里渲染（不进 innerHTML），所以这里不做转义处理，只做长度与条数收敛。
const BUBBLE_STEP_MAX = 12
const BUBBLE_MODULE_MAX = 3
const BUBBLE_RAND_MAX = 16
const BUBBLE_TEXT_MAX = 200
// v2.1 扩展（对照 DSH 泡泡系统移植，2026-10-06）：
//   link     超链接（href 仅 http/https，渲染端同样校验后才可点）
//   img      图片模块（bubble-imgs 图库或内置 rua，一步最多一个图片类模块）
//   randimg  随机图片（图片 id 池，出泡抽 1 张）
//   variants 步级 A/B 加权并列（出泡按 w 抽一个变体）
//   lib      模块库（编辑器另存的常用模块，随配置一起存取）
//   rand 的「句子|权重」后缀语法在渲染端解析，存储保持原样
const BUBBLE_IMG_MAX = 12
const BUBBLE_VARIANT_MAX = 3
const BUBBLE_LIB_MAX = 40
const BUBBLE_HREF_MAX = 300
const BUBBLE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const BUBBLE_HREF_RE = /^https?:\/\/\S+$/i
// 气泡配置写入的请求体上限：按上面四个收敛参数推算合法最大值——12 步 × 3 模块 ×
// 12 行 × 200 字，UTF-8 按 4 字节/字留裕量 + JSON 结构开销 ≈ 350KB，取 512KB。
// 此前该路由走默认 MAX_BODY=8KB，编辑器允许的合法配置保存必被 400 拒掉
// （审查 P2-1，2026-10-06 复现：23KB 合法配置 → "body too large"）。
const BUBBLE_BODY_LIMIT = 512 * 1024

// 行/模块级样式（对照 DSH 单句编辑：字号 / 加粗 / 斜体 / 下划线 / 颜色 / 底色 /
// 字体）。只存非默认项，空对象归一成 null（配置保持精简、旧配置零影响）。
// 前端 lib/widget.js 有同一份钳制逻辑（浏览器端不引 ESM，各自实现、口径一致）。
const LINE_PX_MIN = 9
const LINE_PX_MAX = 28
const LINE_SIZES = ['B', 'A', 'C', 'P'] // P = 时段档（大号加粗，与内置视图的时段行同档）
function normalizeLineStyle(raw) {
  if (!raw || typeof raw !== 'object') return null
  const st = {}
  const px = Math.round(Number(raw.px))
  if (Number.isFinite(px) && px >= LINE_PX_MIN && px <= LINE_PX_MAX) st.px = px
  if (raw.bold === true) st.bold = true
  if (raw.italic === true) st.italic = true
  if (raw.ul === true) st.ul = true
  const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim().toLowerCase() : '')
  // 'peak' = 跟随峰谷动态着色（高峰红 / 谷时绿，按当前计费源的时段口径；
  // DeepSeek 峰谷与 MiMo 夜间配额都走这一支，见 widget.js 的 periodColorNow）
  const color = raw.color === 'peak' ? 'peak' : hex(raw.color)
  if (color) st.color = color
  const bg = hex(raw.bg)
  if (bg) st.bg = bg
  if (raw.font === 'serif' || raw.font === 'monospace') st.font = raw.font
  return Object.keys(st).length ? st : null
}
// 随机语句的一条：字符串（兼容旧配置与「句子|权重」写法）或 {t,w,size,wrap,st}
// size = 该条的字号档（B 大字 / P 时段档 / A 中字 / C 小字）：模块级 size 是所有条
// 的默认，逐条 size 用于混合档位（如「挑经句大字 + 文案中字」同在一个模块里）。
// 用字号档而不是像素：气泡文字尺寸走 --zcw-u 相对单位，像素会脱离挂件缩放。
// wrap = false 表示这一条不换行（默认换行；长句靠换行收敛，短句不换行才不会被拆行）
function normalizeRandLine(raw) {
  let t = ''
  let w = 0
  let size = ''
  let nowrap = false
  let st = null
  if (typeof raw === 'string') {
    t = raw
  } else if (raw && typeof raw === 'object') {
    t = typeof raw.t === 'string' ? raw.t : ''
    const wn = Number(raw.w)
    w = Number.isFinite(wn) && wn >= 1 ? Math.min(999, Math.round(wn)) : 0
    if (LINE_SIZES.indexOf(raw.size) !== -1 && raw.size !== 'A') size = raw.size
    nowrap = raw.wrap === false
    st = normalizeLineStyle(raw.st)
  }
  t = t.replace(/\r\n?/g, '\n').slice(0, BUBBLE_TEXT_MAX)
  if (!t.trim()) return null
  // 无样式、无逐条字号档、默认换行时保持字符串形态（含「|权重」后缀），配置更精简
  if (!st && !size && !nowrap) return w > 1 ? t + '|' + w : t
  const out = { t }
  if (w > 1) out.w = w
  if (size) out.size = size
  if (nowrap) out.wrap = false
  if (st) out.st = st
  return out
}
function normalizeBubbleModule(raw) {
  if (!raw || typeof raw !== 'object') return null
  const size = LINE_SIZES.indexOf(raw.size) !== -1 ? raw.size : 'A'
  // 内置视图：这一泡显示挂件自带的气泡内容（标题 + 主数字 + 小字，随计费源
  // 自动跟随：余额 / Plan 配额 / 今日已用 / 峰谷）。空模块列表 = 内置视图，
  // 但显式声明能存进配置、在编辑器里一目了然。
  if (raw.type === 'view') return { type: 'view', size }
  if (raw.type === 'rand') {
    const lines = (Array.isArray(raw.lines) ? raw.lines : [])
      .map(normalizeRandLine)
      .filter(Boolean)
      .slice(0, BUBBLE_RAND_MAX)
    return { type: 'rand', lines, size }
  }
  if (raw.type === 'link') {
    const href = typeof raw.href === 'string' ? raw.href.trim().slice(0, BUBBLE_HREF_MAX) : ''
    // href 必须是 http(s)：链接在气泡里可点击，javascript: 等一律拒绝
    if (!BUBBLE_HREF_RE.test(href)) return null
    const text = typeof raw.text === 'string' ? raw.text.replace(/\r\n?/g, '\n').slice(0, BUBBLE_TEXT_MAX) : ''
    const out = { type: 'link', text, href, size }
    const st = normalizeLineStyle(raw.st)
    if (st) out.st = st
    return out
  }
  if (raw.type === 'img') {
    const img = typeof raw.img === 'string' && BUBBLE_ID_RE.test(raw.img) ? raw.img : ''
    if (!img) return null
    return { type: 'img', img, size }
  }
  if (raw.type === 'randimg') {
    const imgs = Array.isArray(raw.imgs)
      ? raw.imgs
          .filter((s) => typeof s === 'string' && BUBBLE_ID_RE.test(s))
          .filter((s, i, a) => a.indexOf(s) === i)
          .slice(0, BUBBLE_IMG_MAX)
      : []
    if (!imgs.length) return null
    return { type: 'randimg', imgs, size }
  }
  const text = typeof raw.text === 'string' ? raw.text.replace(/\r\n?/g, '\n').slice(0, BUBBLE_TEXT_MAX) : ''
  const out = { type: 'text', text, size }
  const st = normalizeLineStyle(raw.st)
  if (st) out.st = st
  if (raw.wrap === false) out.wrap = false
  return out
}

function normalizeBubbleStep(raw) {
  // A/B 加权并列：出泡时按 w 抽一个变体；变体内部走同一套模块管线。
  // only:'time' = 该变体只在「当前计费源有峰谷/时段差价」时参与抽取
  //（旧 RANDOM_GROUPS 峰谷组的 avail 条件在新模型里的等价物；平价厂商不显示时段）
  if (raw && Array.isArray(raw.variants)) {
    const variants = raw.variants
      .map((v) => {
        const st = normalizeBubbleStep({ modules: Array.isArray(v && v.modules) ? v.modules : [] })
        if (!st.modules.length) return null
        let w = Number(v && v.w)
        if (!Number.isFinite(w) || w < 1) w = 1
        const out = { w: Math.min(999, Math.round(w)), modules: st.modules }
        if (v && v.only === 'time') out.only = 'time'
        return out
      })
      .filter(Boolean)
      .slice(0, BUBBLE_VARIANT_MAX)
    if (variants.length) return { variants }
  }
  const modules = (Array.isArray(raw && raw.modules) ? raw.modules : [])
    .map(normalizeBubbleModule)
    .filter(Boolean)
    // 空语句池的 rand 与 view 模块都是合法内容（前者 = 用内置随机台词，
    // 后者 = 用内置气泡视图），不当空模块过滤；link/img/randimg 归一化时
    // 已保证非空字段
    .filter((m) => (m.type === 'view' || m.type === 'rand' || m.type === 'link' || m.type === 'img' || m.type === 'randimg' ? true : m.text.trim()))
    .slice(0, BUBBLE_MODULE_MAX)
  // 图片类模块独占视觉空间：一步最多保留一个（DSH 同款约束）
  let seenImg = false
  const modules1 = modules.filter((m) => {
    if (m.type !== 'img' && m.type !== 'randimg') return true
    if (seenImg) return false
    seenImg = true
    return true
  })
  return { modules: modules1 }
}

// 模块库：编辑器「另存入库」的常用模块，随配置一起存取（DSH 的 lib 同款语义）
function normalizeBubbleLib(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const module = normalizeBubbleModule(it.module)
    if (!module) continue
    const label = typeof it.label === 'string' ? it.label.trim().slice(0, 24) : ''
    const id = typeof it.id === 'string' && BUBBLE_ID_RE.test(it.id) ? it.id : 'l' + crypto.randomBytes(4).toString('hex')
    if (out.some((x) => x.id === id)) continue
    out.push({ id, label: label || module.type, module })
    if (out.length >= BUBBLE_LIB_MAX) break
  }
  return out
}

// 内置随机语句的「组权重」覆盖机制已废弃（2026-10-06）：内置第二次点击内容
// 现以普通配置形态（加权变体 + 随机语句模块）内置在 widget.js 里，权重直接落在
// 变体与逐条语句上，不再需要独立的组概念。旧配置里的 groupW 字段读取时忽略。

function normalizeBubbleContent(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  if (Array.isArray(src.steps)) {
    const steps = src.steps
      .slice(0, BUBBLE_STEP_MAX)
      .map(normalizeBubbleStep)
      .filter((st) => (st.modules ? st.modules.length : st.variants.length))
    return {
      v: 2,
      tapAdvance: src.tapAdvance !== false,
      steps,
      lib: normalizeBubbleLib(src.lib),
    }
  }
  // v1 迁移：first → 第 1 步，items → 后续步（空内容条目丢弃）
  const normalizeV1Item = (raw) => {
    if (!raw || typeof raw !== 'object') return null
    const text = typeof raw.text === 'string' ? raw.text.replace(/\r\n?/g, '\n').slice(0, BUBBLE_TEXT_MAX) : ''
    if (!text.trim()) return null
    const size = raw.size === 'B' || raw.size === 'C' ? raw.size : 'A'
    return { text, size }
  }
  const steps = []
  const first = normalizeV1Item(src.first)
  if (first) steps.push({ modules: [{ type: 'text', text: first.text, size: first.size }] })
  for (const it of Array.isArray(src.items) ? src.items : []) {
    const item = normalizeV1Item(it)
    if (item && steps.length < BUBBLE_STEP_MAX) {
      steps.push({ modules: [{ type: 'text', text: item.text, size: item.size }] })
    }
  }
  return { v: 2, tapAdvance: true, steps, lib: [] }
}

function readBubbleContent() {
  try {
    return normalizeBubbleContent(JSON.parse(fs.readFileSync(BUBBLE_CONTENT_FILE, 'utf8')))
  } catch (err) {
    return { v: 2, tapAdvance: true, steps: [] }
  }
}

function writeBubbleContent(raw) {
  const next = normalizeBubbleContent(raw)
  try {
    fs.mkdirSync(path.dirname(BUBBLE_CONTENT_FILE), { recursive: true })
    const tmp = BUBBLE_CONTENT_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, BUBBLE_CONTENT_FILE)
    return Object.assign({ ok: true }, next)
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 200) }
  }
}

// ---------- 泡泡模板（每轮消耗 / 预警内容可编辑，移植 DSH 的提醒模板）----------
// 每类模板就是一个单步 v2 泡泡（{v:2, steps:[step]}）；null = 用内置默认文案。
// 存放于 bubble-templates.json，与按压泡泡配置分开，避免编辑器互相干扰。
const BUBBLE_TEMPLATE_KINDS = ['turncost', 'plan', 'balance', 'cmdgo']
function validTemplateSteps(raw) {
  if (!raw) return null
  const norm = normalizeBubbleContent(raw)
  const step = Array.isArray(norm.steps) && norm.steps.length ? norm.steps[0] : null
  return step ? { v: 2, steps: [step] } : null
}
function readBubbleTemplates() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BUBBLE_TEMPLATES_FILE, 'utf8'))
    const out = { turnCost: null, alerts: {} }
    for (const kind of BUBBLE_TEMPLATE_KINDS) {
      if (kind === 'turncost') out.turnCost = validTemplateSteps(parsed.turnCost)
      else out.alerts[kind] = validTemplateSteps(parsed.alerts && parsed.alerts[kind])
    }
    return out
  } catch (err) {
    return { turnCost: null, alerts: {} }
  }
}
function writeBubbleTemplate(kind, config) {
  // 编辑器发的是带前缀的形态（'alert-plan'），落盘一律用裸 kind：两种写法都收，
  // 免得某一侧忘了转换就整类模板存不进去（审查 P2-B）
  const k = String(kind == null ? '' : kind).replace(/^alert-/, '')
  if (BUBBLE_TEMPLATE_KINDS.indexOf(k) === -1) return { ok: false, error: '未知模板类型: ' + String(kind) }
  const cur = readBubbleTemplates()
  // 空内容 ≡ 恢复内置：编辑器提示「清空内容保存同效」，这里兑现它（审查 P3-C）
  const step = config == null ? null : validTemplateSteps(config)
  if (k === 'turncost') cur.turnCost = step
  else cur.alerts[k] = step
  try {
    fs.mkdirSync(path.dirname(BUBBLE_TEMPLATES_FILE), { recursive: true })
    const tmp = BUBBLE_TEMPLATES_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2), 'utf8')
    fs.renameSync(tmp, BUBBLE_TEMPLATES_FILE)
    return { ok: true, templates: cur }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 200) }
  }
}

// ---------- 泡泡图库（图片/随机图片模块的素材源，移植 DSH 泡泡图库）----------
// 内置 'rua' = 包内 rua.gif；导入件落 DATA_DIR/bubble-imgs/，索引在 bubble-imgs.json
const BUBBLE_IMG_MAX_BYTES = 3 * 1024 * 1024
const BUBBLE_IMGS_MAX = 30
const BUBBLE_IMG_TYPES = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', webp: 'image/webp' }
function readBubbleImgsIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BUBBLE_IMGS_INDEX_FILE, 'utf8'))
    if (parsed && Array.isArray(parsed.imgs)) return parsed
  } catch (err) {}
  return { imgs: [] }
}
function writeBubbleImgsIndex(idx) {
  try {
    fs.writeFileSync(BUBBLE_IMGS_INDEX_FILE, JSON.stringify(idx, null, 2), 'utf8')
    return true
  } catch (err) {
    return false
  }
}
function listBubbleImgs() {
  return { ok: true, imgs: readBubbleImgsIndex().imgs, builtin: [{ id: 'rua', name: 'rua 动图（内置）' }] }
}
function saveBubbleImg(parsed) {
  const name = parsed && typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 24) : ''
  const dataUrl = parsed && typeof parsed.dataUrl === 'string' ? parsed.dataUrl : ''
  const m = /^data:image\/(png|gif|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) return { ok: false, error: 'dataUrl 不是受支持的图片（png/gif/jpeg/webp）' }
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
  let buf
  try {
    buf = Buffer.from(m[2], 'base64')
  } catch (err) {
    return { ok: false, error: 'base64 解码失败' }
  }
  if (!buf.length || buf.length > BUBBLE_IMG_MAX_BYTES) return { ok: false, error: '图片为空或超过 3MB' }
  fs.mkdirSync(BUBBLE_IMGS_DIR, { recursive: true })
  const idx = readBubbleImgsIndex()
  let id
  do {
    id = 'b' + crypto.randomBytes(6).toString('hex')
  } while (idx.imgs.some((r) => r && r.id === id))
  const file = id + '.' + ext
  fs.writeFileSync(path.join(BUBBLE_IMGS_DIR, file), buf)
  idx.imgs.push({ id, name: name || id, file, addedAt: Date.now() })
  while (idx.imgs.length > BUBBLE_IMGS_MAX) {
    const removed = idx.imgs.shift()
    try {
      fs.rmSync(path.join(BUBBLE_IMGS_DIR, path.basename(removed.file)), { force: true })
    } catch (err) {}
  }
  writeBubbleImgsIndex(idx)
  return { ok: true, id, name: name || id }
}
function deleteBubbleImg(parsed) {
  const id = parsed && typeof parsed.id === 'string' ? parsed.id : ''
  if (!id) return { ok: false, error: '缺少图片 id' }
  const idx = readBubbleImgsIndex()
  const at = idx.imgs.findIndex((r) => r && r.id === id)
  if (at === -1) return { ok: false, error: '找不到这张图片' }
  const entry = idx.imgs.splice(at, 1)[0]
  try {
    if (entry && entry.file) fs.rmSync(path.join(BUBBLE_IMGS_DIR, path.basename(entry.file)), { force: true })
  } catch (err) {}
  writeBubbleImgsIndex(idx)
  return { ok: true, deleted: id }
}
function readBubbleImgBytes(id) {
  if (id === 'rua') {
    const bytes = readFirst(GIF_CANDIDATES)
    return bytes ? { bytes, type: 'image/gif' } : null
  }
  if (!BUBBLE_ID_RE.test(id)) return null
  const entry = readBubbleImgsIndex().imgs.find((r) => r && r.id === id)
  if (!entry || typeof entry.file !== 'string') return null
  const ext = path.extname(entry.file).slice(1)
  try {
    const bytes = fs.readFileSync(path.join(BUBBLE_IMGS_DIR, path.basename(entry.file)))
    return bytes && bytes.length ? { bytes, type: BUBBLE_IMG_TYPES[ext] || 'application/octet-stream' } : null
  } catch (err) {
    return null
  }
}

// ---------- 每轮消耗：把 turn 变化翻译成前端能识别的递增 seq ----------
// seq 必须跨服务重启保持单调：浮层页面是常驻的，重启后若 seq 从 0 重新计数，
// 页面上已对齐的 lastCostSeq 会把新服务的每一轮都判成"旧轮次"，气泡永久失效。
// 所以每次递增都落盘（原子替换），启动时续上。
let lastTurnPayload = { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }
let currentIdentity = null
let seq = 0

function readPersistedSeq() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TURN_SEQ_FILE, 'utf8'))
    const n = parsed && typeof parsed.seq === 'number' ? Math.floor(parsed.seq) : 0
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch (err) {
    return 0
  }
}

function persistSeq() {
  try {
    fs.mkdirSync(path.dirname(TURN_SEQ_FILE), { recursive: true })
    // 原子写：临时名带 pid（与 balance.mjs 的 writeJsonFile 同风格），
    // 端口顺延导致双实例时不会互踩同一个临时文件
    const tmp = TURN_SEQ_FILE + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify({ seq, updatedAt: new Date().toISOString() }))
    fs.renameSync(tmp, TURN_SEQ_FILE)
  } catch (err) {}
}

seq = readPersistedSeq()
lastTurnPayload.seq = seq

// 轮询节奏：2.5s（原先 1s）。DB 只读连接建不了索引，每拍都要排序/扫描；库不可用时
// 还会退化成逐文件 statSync + 读尾部 + JSON.parse。2.5s 对「气泡在回复结束后弹出」
// 的观感没有可见差别，但把常驻 IO 降到 40%。故障时另加 30s 退避，不再每秒重扫
// 一遍宿主库/transcript（审查 P1）。
const TURN_POLL_MS = 2500
const TURN_POLL_BACKOFF_MS = 30_000
let turnPollBackoffUntil = 0

function pollTurnCost() {
  if (Date.now() < turnPollBackoffUntil) return
  let t
  try {
    t = readLatestTurn()
  } catch (err) {
    turnPollBackoffUntil = Date.now() + TURN_POLL_BACKOFF_MS
    return
  }
  const id = turnIdentity(t)
  if (!t || !t.ok || !id) {
    if (t && t.degraded) turnPollBackoffUntil = Date.now() + TURN_POLL_BACKOFF_MS
    return
  }
  if (currentIdentity === null) {
    // 服务刚起来：对齐当前轮次，不把历史最后一条当成"新的一轮"
    currentIdentity = id
    return
  }
  if (id !== currentIdentity) {
    // 【WB 的积分是逐次模型调用就预先落账的】新 rid 一出现（往往就是本轮第一次
    // 模型调用、回复刚吐首字），credit_json 里就有了它的积分；而一轮常有多次
    // 调用（agent 循环），真实总消耗要等轮末才齐。若此刻立刻弹「上一轮消耗」，
    // 弹的其实是**刚开跑这一轮**的钱 —— 用户实测（2026-10-14）：气泡在刚出首字
    // 时就弹了，数字也对不上最后的总账。
    // 所以改为：新轮出现时，弹**上一轮**（必然已完结、数据完整）；刚开跑的这轮
    // 先记下身份，等它的下一轮出现时再弹。
    let prev = null
    try {
      prev = readLatestTurn(1)
    } catch (err) {
      prev = null
    }
    const prevId = prev && prev.ok ? turnIdentity(prev) : null
    currentIdentity = id
    // prevId 取不到（transcript 被裁剪/换会话）时宁可这轮不弹，也不弹一个没跑完的轮
    if (prevId && prevId !== id) {
      seq += 1
      persistSeq()
      const planInfo = turnPlanUsage(prev)
      lastTurnPayload = {
        ok: true,
        seq,
        turn: prev.turnId,
        amount: prev.amount,
        currency: prev.currency,
        amounts: prev.amounts,
        tokens: prev.tokens,
        model: prev.model,
        peak: prev.peak,
        ts: prev.ts,
        // **WorkBuddy 主口径**：credit 为本轮真实扣的订阅积分（宿主算好）；
        // amount/currency 与它同值、currency='CREDIT'，前端见到 CREDIT 不加货币符号。
        // marketAmount/marketCurrency 是按公开价目折算的「等价市值」，仅供对账参考。
        credit: prev.credit != null ? prev.credit : null,
        marketAmount: prev.marketAmount != null ? prev.marketAmount : null,
        marketCurrency: prev.marketCurrency || null,
        calls: prev.calls || null,
        // 该轮已完结（见上：只在轮次推进时弹，弹的必然是跑完的上一轮）
        partial: !!prev.partial,
        // billable=false 表示该轮拿不到积分（例如 transcript 缺字段），前端应显示
        // tokens 而不是 0；models 为逐模型明细。
        billable: prev.billable !== false,
        // 免费模型标注（宿主促销，如 step-5-preview 的「独家限免」）。2026-10-14
        // 审查 P1-1：这里漏传 free/freeLabel，导致气泡的「免费」分支拿不到字段
        // 永远走 tokens 口径 —— 文档承诺的功能实际不生效。
        free: !!prev.free,
        freeLabel: prev.freeLabel || null,
        providerId: prev.providerId,
        vendor: prev.vendor,
        vendorLabel: prev.vendorLabel,
        breakdown: prev.breakdown,
        models: prev.models,
        quotaPct: planInfo ? planInfo.pctOfBucket : null,
        planPct: planInfo ? planInfo.pctOfTotal : null,
        planTurn: !!(planInfo && planInfo.planTurn),
        planTokens: planInfo ? planInfo.tokens : null,
        extraAmounts: planInfo ? planInfo.extraAmounts : null,
      }
    }
  }
}

// 计划扣费轮的余额口径换算在 plan-balance.mjs 的 turnPlanUsage 里（selftest
// 直接对它做单元断言，这里只取结果）。

// ---------- 智能跟随：当前计费源 ----------
//
// **WorkBuddy 侧的口径与 ZCode 侧不同**：WorkBuddy 是订阅积分制，模型全部由宿主
// 托管，每一轮都只扣积分——不存在「这一轮走的是用户自带的某家 key」这种情况。
// 所以主计费源**恒定是 credits**，气泡的主显示是「今日积分 / 本轮 credit / 上下文余量」。
// 模型归属（glm / deepseek / kimi / 混元 …）只作为标签附带，用来给用量记录分组、
// 给气泡加一行小字；厂商卡（34 家模板）退居「用户自己配了 key 才有意义」的附加项。
//
// 有官方余额接口的按量厂商：把模板余额附进会话载荷，气泡小字显示「· 余额 ¥ x」。
// 键 = source.mjs 的 modelVendor，值 = vendors.mjs 模板 id（按优先级排序，取第一个
// 抓到余额的）。vendors 层自带 5 分钟远程缓存，session.json 的 3 秒轮询不会放大
// 上游请求。
const MODEL_VENDOR_BALANCE_TEMPLATES = {
  kimi: ['moonshot-cn', 'moonshot-intl'],
  deepseek: ['deepseek'],
}
// session.json 是 3s 一次的轮询：直接调 listVendorStatus 每次都会重建 45 个模板
// 对象（含远程模板）——各自虽有缓存，重建本身仍是纯浪费。这里再压一层 60s 的
// 结果缓存（审查 P4）。缓存 null 也有意义：别为了提高命中率去反复重算。
const VENDOR_BALANCE_TTL_MS = 60_000
const vendorBalanceCache = new Map()
async function attachVendorBalance(payload) {
  const ids = MODEL_VENDOR_BALANCE_TEMPLATES[payload.modelVendor]
  if (!ids) return payload
  try {
    const key = payload.modelVendor
    let hit = vendorBalanceCache.get(key)
    if (!hit || Date.now() - hit.at >= VENDOR_BALANCE_TTL_MS) {
      hit = { at: Date.now(), value: pickVendorBalance(await listVendorStatus(false), ids) }
      vendorBalanceCache.set(key, hit)
    }
    if (hit.value) payload.vendorBalance = hit.value
  } catch (err) {}
  return payload
}

function readSessionSource() {
  // selection 优先（宿主 sessions.model = 当前选择的模型），缺失时回落最近一次
  // 真实模型调用（transcript 的 requestModelId）——「对话发起时识别对话模型」。
  const sel = readActiveSelection()
  const modelId = sel.ok ? sel.modelId : ''
  if (sel.ok) {
    const r = resolveHostBillingSource(modelId)
    return attachVendorBalance({
      ok: true,
      providerId: '',
      modelId,
      from: 'selection',
      updatedAt: sel.updatedAt || 0,
      source: r.source,
      vendor: r.modelVendor,
      label: r.label,
      modelVendor: r.modelVendor,
      modelVendorLabel: r.modelVendorLabel,
      currency: r.currency,
      timeMode: r.timeMode,
    })
  }
  const mu = readLatestUsageModel()
  if (mu.ok) {
    const r = resolveHostBillingSource(mu.modelId)
    return attachVendorBalance({
      ok: true,
      providerId: '',
      modelId: mu.modelId,
      from: 'transcript',
      updatedAt: mu.ts || 0,
      source: r.source,
      vendor: r.modelVendor,
      label: r.label,
      modelVendor: r.modelVendor,
      modelVendorLabel: r.modelVendorLabel,
      currency: r.currency,
      timeMode: r.timeMode,
    })
  }
  // 既没有 selection 也没有调用记录：如实返回原因，前端显示「未知来源」
  return { ok: false, reason: sel.reason || 'no-selection', source: 'credits' }
}

// ---------- 请求校验 ----------
function hostAllowed(req, port) {
  const host = String(req.headers.host || '')
  const allowed = ['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]
  return allowed.indexOf(host) !== -1
}

function originAllowed(req, port) {
  const origin = req.headers.origin
  if (!origin) return true // 非浏览器请求（curl 等）没有 Origin
  const allowed = ['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://[::1]:' + port]
  return allowed.indexOf(String(origin)) !== -1
}

// 关闭令牌的比较：恒定时间。本机进程在信任边界内（见文件头的威胁模型），收益有限，
// 但既然要挡「别的本地程序随手关掉」，就别用会随前缀提前返回的短路比较。
function tokenMatches(given) {
  const a = Buffer.from(String(given || ''), 'utf8')
  const b = Buffer.from(String(TOKEN || ''), 'utf8')
  if (!b.length || a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch (err) {
    return false
  }
}

// 「会出站/有成本」的 GET 的来源校验。写方法已经过 originAllowed；GET 只校验 Origin
// 不够——任意网页可以用 `fetch('http://127.0.0.1:<port>/whale/vendors.json',
// {mode:'no-cors'})` 盲触发：读不到响应（没有 CORS 头），但**副作用已经发生**（凭据被
// 发往上游、上游请求被放大）。这类请求浏览器一定会带 `Sec-Fetch-Site: cross-site`，
// 按它拦即可；同源页面（挂件自己）、地址栏直访（none）、curl（不带该头）都不受影响。
function crossSiteRequest(req, port) {
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site') return false
  const origin = req.headers.origin
  return !origin || !originAllowed(req, port)
}

// 纯本地读取的 GET 白名单：只发同源静态资源与健康检查，不出站、不花成本。
// **判据是反过来的**——除这些之外的 GET 一律受 crossSiteRequest 保护。旧写法是
// 手工列举「会出站的 GET」，新增端点忘了加名单就等于没有防护（审查 I4：/whale/
// session.json 会带着用户 key 出站到中转站与厂商，却漏在名单外）。反过来写之后，
// 新端点默认是安全的，忘了登记最多是多拦一个纯本地读取。
const LOCAL_GET_WHITELIST = new Set([
  '/',
  '/index.html',
  '/whale/widget.js',
  '/whale/image.png',
  '/whale/bubble-img.png',
  '/whale/rua.gif',
  '/whale/sound/press.mp3',
  '/whale/sound/release.mp3',
  '/whale/health',
])

function readBody(req, limit) {
  const maxBytes = Number(limit) || MAX_BODY
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (c) => {
      if (settled) return
      size += c.length
      if (size > maxBytes) {
        settled = true
        // 丢弃剩余数据但保持连接可写，让调用方能收到明确的 400，
        // 而不是被 destroy 后只看到连接中断。报错用中文并带上限数值，
        // 用户在界面里能看懂、知道该怎么办（审查 P2-1）。
        req.resume()
        reject(new Error('请求体超过 ' + maxBytes + ' 字节上限，请缩减内容后重试'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

// 更新状态的对外视图：叠加「当前版本」与「跳过此版本」标记（跳过存在 widget-state）
function updateView(state) {
  let skip = null
  try {
    skip = readWidgetState().updateSkip || null
  } catch (err) {}
  // 状态文件可能是**旧版本**留下的：WorkBuddy 线默认不自动检查，升级又常走市场重装
  // 或手工覆盖，状态文件不会跟着刷新。此时若直接回放 available / latest，就会出现
  // 「当前 v1.3.0、最新版本 v1.1.0、还能立即更新」这种自相矛盾的显示（2026-10-17
  // 真机反馈）。判据一律用**当前运行版本**重算，不看状态里记录的 current。
  const latestRaw = state.latest || null
  const latestNewer = !!(latestRaw && compareVersions(latestRaw, VERSION) > 0)
  const appliedRaw = state.appliedVersion || null
  // 「已更新待重启」只在包比进程新时成立；等于或小于当前，说明早就生效了
  const pendingRestart = !!(appliedRaw && compareVersions(appliedRaw, VERSION) > 0)
  return {
    version: VERSION,
    // 没有更新的版本时把「最新」显示成当前版本，而不是回放一个更旧的远端版本号
    latest: latestNewer ? latestRaw : VERSION,
    available: !!(state.available && latestNewer),
    skipped: skip,
    skipActive: !!(skip && latestRaw && skip === latestRaw),
    checkedAt: state.checkedAt,
    source: state.source,
    error: state.error,
    busy: !!state.busy,
    phase: state.phase,
    progress: state.progress || 0,
    message: state.message,
    appliedVersion: pendingRestart ? appliedRaw : null,
  }
}

// 钩子事件状态的对外视图（lib/hook-event.mjs 写、这里读）。
// 「等确认」带时效：只挂了 UserPromptSubmit / PermissionRequest 两个低频事件
// （给每次工具调用加钩子会拖慢用户，见 hook-event.mjs 的取舍说明），所以权限
// 确认答完后没有「已恢复」事件可清标记——按时间兜底：超过 TVL 未再收到事件就当
// 已经不等了。计数与最近事件时间供菜单里的诊断行用。
const HOOK_STATE_FILE = path.join(DATA_DIR, 'hook-state.json')
const HOOK_WAITING_TTL_SEC = 120
function hookStateView() {
  let s = null
  try {
    const v = JSON.parse(fs.readFileSync(HOOK_STATE_FILE, 'utf8'))
    if (v && typeof v === 'object') s = v
  } catch (err) {}
  if (!s) return { configured: false, event: null, tool: null, ts: null, waiting: false, counts: null }
  const ts = Number(s.ts) || 0
  const ageSec = ts ? Math.floor(Date.now() / 1000) - ts : null
  const fresh = ageSec !== null && ageSec < 12 * 3600
  return {
    configured: true,
    event: s.event || null,
    tool: s.tool || null,
    ts: ts || null,
    ageSec,
    fresh,
    waiting: !!s.waiting && ageSec !== null && ageSec < HOOK_WAITING_TTL_SEC,
    counts: s.counts && typeof s.counts === 'object' ? s.counts : null,
  }
}

// 厂商掩码（前 5 + 后 3）是凭据诊断信息：与 /whale/health 同口径，只在带令牌时
// 下发（审查 S8/X3）。未鉴权时返回浅拷贝并摘掉 keyMasked——绝不改动 vendors.mjs
// 的缓存对象，否则掩码会被"永久删掉"直到缓存过期。
function redactVendorKeys(payload, authed) {
  if (authed || !payload || !Array.isArray(payload.vendors)) return payload
  return {
    ...payload,
    vendors: payload.vendors.map((v) => {
      if (!v || typeof v !== 'object' || v.keyMasked === undefined) return v
      const copy = { ...v }
      delete copy.keyMasked
      return copy
    }),
  }
}

function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (err) {
    body = JSON.stringify({ ok: false, error: '序列化失败' })
  }
  res.writeHead(status, JSON_HEADERS)
  res.end(body)
}

function sendBytes(res, contentType, bytes) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': String(bytes.length),
  })
  res.end(bytes)
}

// ---------- 独立页面 ----------
// 背景默认透明：桌面挂件容器/OBS 这类支持透明窗口的宿主里，鲸鱼直接浮在桌面上；
// 普通浏览器不透明，透明背景呈现为浏览器默认的白色画布。
function pageHtml(dark) {
  const bg = dark ? '#12161f' : 'transparent'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- CSP：把「动态文本走 textContent、href 仅 http(s)」的 XSS 防线升级为浏览器
     强制。页面资源全部同源（widget.js / 角色图 / 泡泡图库 / 音效），内联的
     只有 <style> 与行内 style（style-src 'unsafe-inline'），无任何内联脚本。 -->
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self'">
<!-- 空的 data URI favicon：不声明的话浏览器会隐式请求 /favicon.ico，本地服务只回 404 -->
<link rel="icon" href="data:,">
<title>WorkBuddy狐娘小挂件</title>
<style>
  /* 字体栈与 lib/widget.js 的 --zcw-font 保持一致（UI 审查 P2-6）：此前页面没有任何
     font-family，观感完全取决于系统默认（不同 Chromium 默认中文字体不同）。只声明
     字体族、不打包字体，靠系统已有字体收敛。 */
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:${bg};
    font-family:"Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",system-ui,sans-serif}
</style>
</head>
<body>
<script defer src="/whale/widget.js"></script>
</body>
</html>
`
}

// ---------- 路由 ----------
function createRequestHandler(port) {
  return async function handle(req, res) {
    if (!hostAllowed(req, port)) {
      sendJson(res, 403, { ok: false, error: 'host not allowed' })
      return
    }
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1:' + port)
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'bad request' })
      return
    }
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()
    const isWrite = method === 'PUT' || method === 'POST' || method === 'DELETE'
    if (isWrite && !originAllowed(req, port)) {
      sendJson(res, 403, { ok: false, error: 'origin not allowed' })
      return
    }
    // 写操作只收 JSON body：跨站的 text/plain「simple request」不带 preflight，
    // 只有 Origin 一道门；补上 Content-Type 校验后，这类请求连解析都进不去
    //（审查 S7）。空 body 的写操作（如 /whale/shutdown）不受影响。
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding']
    if (isWrite && hasBody && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      sendJson(res, 415, { ok: false, error: '写操作只接受 application/json' })
      return
    }
    // 会出站/有成本的 GET：拒绝跨站页面盲触发（见 crossSiteRequest 与白名单注释）
    if (!isWrite && !LOCAL_GET_WHITELIST.has(pathname) && crossSiteRequest(req, port)) {
      sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
      return
    }

    // 页面
    if (pathname === '/' || pathname === '/index.html') {
      const html = pageHtml(url.searchParams.get('bg') === 'dark')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // 与页面内 <meta http-equiv="Content-Security-Policy"> 同一策略：header
        // 优先于 meta 且对前置拦截更可靠，两处并存是双保险（review P3-3）
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self'",
      })
      res.end(html)
      return
    }

    // 前端脚本
    if (pathname === '/whale/widget.js') {
      try {
        const js = fs.readFileSync(WIDGET_JS)
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(js.length),
        })
        res.end(js)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('widget.js unavailable')
      }
      return
    }

    // 鲸鱼形象：优先自定义角色（widget-state.roleId），否则包内素材
    if (pathname === '/whale/image.png') {
      const hit = readRoleImageEntry()
      const bytes = hit ? hit.bytes : readFirst(IMAGE_CANDIDATES)
      if (!bytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('whale image unavailable')
        return
      }
      sendBytes(res, (hit && BUBBLE_IMG_TYPES[hit.ext]) || 'image/png', bytes)
      return
    }

    // 自定义角色：列表 + 上传（选择走 size.json 的 roleId 字段）
    if (pathname === '/whale/roles.json') {
      sendJson(res, 200, listRoles())
      return
    }
    if (pathname === '/whale/role-upload.json' && isWrite) {
      try {
        // dataUrl 是 base64（体积 ×1.37）再包一层 JSON：3MB 图片约 4.2MB，上限放宽到 6MB
        const parsed = JSON.parse(await readBody(req, 6 * 1024 * 1024))
        const result = saveRole(parsed)
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }

    // 角色改名 / 删除（只针对导入的角色，内置形象是包内素材）
    if (pathname === '/whale/role-rename.json' && isWrite) {
      try {
        const parsed = JSON.parse(await readBody(req))
        const result = renameRole(parsed)
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }
    if (pathname === '/whale/role-delete.json' && isWrite) {
      try {
        const parsed = JSON.parse(await readBody(req))
        const result = deleteRole(parsed)
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }

    // 按压泡泡（自定义泡泡）：GET 读 / POST 写（点击序列 + 模块行，v1 旧配置读取时自动迁移）
    if (pathname === '/whale/bubble-content.json') {
      if (isWrite) {
        try {
          const parsed = JSON.parse(await readBody(req, BUBBLE_BODY_LIMIT))
          const result = writeBubbleContent(parsed)
          sendJson(res, result.ok ? 200 : 400, result)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
        return
      }
      sendJson(res, 200, Object.assign({ ok: true }, readBubbleContent()))
      return
    }

    // 泡泡模板：每轮消耗 / 预警内容的自定义（GET 读全部 / POST 写一类，config=null 恢复内置）
    if (pathname === '/whale/bubble-templates.json') {
      if (isWrite) {
        try {
          // 与按压泡泡同口径（512KB）：编辑器允许存的内容就得存得下。这里曾沿用
          // 8KB 默认上限，合法模板保存必败还让用户"缩减内容"（审查 P2-A，P2-1 同型）
          const parsed = JSON.parse(await readBody(req, BUBBLE_BODY_LIMIT))
          const result = writeBubbleTemplate(parsed && parsed.kind, parsed ? parsed.config : undefined)
          sendJson(res, result.ok ? 200 : 400, result)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
        return
      }
      sendJson(res, 200, Object.assign({ ok: true }, readBubbleTemplates()))
      return
    }

    // 泡泡图库：列表 / 上传 / 删除 / 取图（图片/随机图片模块的素材源）
    if (pathname === '/whale/bubble-imgs.json') {
      sendJson(res, 200, listBubbleImgs())
      return
    }
    if (pathname === '/whale/bubble-img.json' && isWrite) {
      try {
        // dataUrl 是 base64（体积 ×1.37）：3MB 图片约 4.2MB，与 role-upload 同放宽到 6MB
        const parsed = JSON.parse(await readBody(req, 6 * 1024 * 1024))
        const result = saveBubbleImg(parsed)
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }
    if (pathname === '/whale/bubble-img-delete.json' && isWrite) {
      try {
        const parsed = JSON.parse(await readBody(req))
        const result = deleteBubbleImg(parsed)
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }
    if (pathname === '/whale/bubble-img.png') {
      const hit = readBubbleImgBytes(url.searchParams.get('id') || '')
      if (!hit) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('bubble image unavailable')
        return
      }
      sendBytes(res, hit.type, hit.bytes)
      return
    }

    // 余额校正（DeepSeek 观测账本）：GET 汇总 / POST 落账
    if (pathname === '/whale/balance-adjustments.json') {
      if (isWrite) {
        try {
          const parsed = JSON.parse(await readBody(req))
          sendJson(res, 200, applyBalanceCorrection(parsed.credits, parsed.otherDebits))
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
        return
      }
      sendJson(res, 200, balanceAdjustmentSummary())
      return
    }

    // 随机台词用的动图
    if (pathname === '/whale/rua.gif') {
      const bytes = readFirst(GIF_CANDIDATES)
      if (!bytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('rua gif unavailable')
        return
      }
      sendBytes(res, 'image/gif', bytes)
      return
    }

    // 音效：?set=<id>（内置 duck/fx1 或导入集）
    if (pathname === '/whale/sound/press.mp3' || pathname === '/whale/sound/release.mp3') {
      const setName = url.searchParams.get('set') || 'duck'
      const hit = resolveSoundBytes(setName, pathname.endsWith('press.mp3') ? 'press' : 'release')
      if (!hit) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('sound unavailable')
        return
      }
      sendBytes(res, hit.type, hit.bytes)
      return
    }

    // 音效集：列表 / 导入 / 删除（选择结果由页面写进 widget-state.soundSet）
    if (pathname === '/whale/sounds.json') {
      sendJson(res, 200, listSounds())
      return
    }
    if (pathname === '/whale/sound-upload.json' && isWrite) {
      try {
        // 两个音频文件各 2MB → base64 后 ≈5.4MB，上限放宽到 8MB
        const parsed = JSON.parse(await readBody(req, 8 * 1024 * 1024))
        const result = saveSoundSet(parsed)
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }
    if (pathname === '/whale/sound-delete.json' && isWrite) {
      try {
        const parsed = JSON.parse(await readBody(req))
        const result = deleteSoundSet(parsed)
        sendJson(res, result.ok ? 200 : 400, result)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
      }
      return
    }

    // 宿主自己的主题（WorkBuddy preferences 的 theme）：挂件「跟随 WorkBuddy」用它，
    // 宿主没明确选浅/深时回 system（挂件再退回系统深浅色）。
    if (pathname === '/whale/host-theme.json') {
      try {
        sendJson(res, 200, Object.assign({ ok: true }, readHostTheme()))
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 上下文余量（session_usage.used / size）：WorkBuddy 侧的新能力，ZCode 版没有
    if (pathname === '/whale/context.json') {
      try {
        sendJson(res, 200, readContextUsage())
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 余额：任何情况下都回 200 + JSON，绝不悬挂
    if (pathname === '/whale/balance.json') {
      try {
        sendJson(res, 200, await getBalance())
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          code: 'ERROR',
          error: String((err && err.message) || err).slice(0, 200),
        })
      }
      return
    }

    // GLM Plan（套餐）剩余配额：零密钥，来自客户端日志的最近一次余额观测
    if (pathname === '/whale/plan.json') {
      try {
        sendJson(res, 200, readPlanBalance())
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // CommandCode 套餐三重额度（月度池 + 5小时/周窗口）：cmdgo.mjs 自带 45s
    // 每凭据 / 每池 TTL，?refresh=1 强制绕过
    if (pathname === '/whale/cmdgo.json') {
      try {
        const force = url.searchParams.get('refresh') === '1'
        sendJson(res, 200, await readCmdgoQuota(force))
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 厂商模板状态：余额/配额/可用性（?refresh=1 强制绕过缓存取数）
    if (pathname === '/whale/vendors.json') {
      try {
        const force = url.searchParams.get('refresh') === '1'
        const status = await listVendorStatus(force)
        sendJson(res, 200, redactVendorKeys(status, tokenMatches(req.headers['x-whale-token'])))
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 用量记录：今日 / 近 7 天 / 最近轮次（扫 transcript 的 rawUsage，积分口径）
    if (pathname === '/whale/usage-records.json') {
      try {
        sendJson(res, 200, usageRecords())
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 当前会话的供应商/模型选择（输入框选定即更新，供「智能切换」跟随）。
    // 服务端直接把计费源解析好：selection 缺失/不可识别时回落最近一次真实
    // 模型调用（model_usage），即「对话发起时识别对话模型，再自动跟随」。
    if (pathname === '/whale/session.json') {
      try {
        sendJson(res, 200, await readSessionSource())
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 最近一轮消耗
    if (pathname === '/whale/last-turn.json') {
      sendJson(res, 200, lastTurnPayload)
      return
    }

    // 挂件配置：GET 读、PUT/POST 写
    if (pathname === '/whale/size.json') {
      if (isWrite) {
        try {
          const parsed = JSON.parse(await readBody(req))
          if (typeof parsed.scale !== 'number') {
            sendJson(res, 400, { ok: false, error: 'missing scale' })
            return
          }
          const before = readWidgetState()
          const result = writeWidgetState(parsed)
          // 用量模式变化时让余额缓存失效，下次请求立即按新模式计算
          if (parsed.usageMode && parsed.usageMode !== before.usageMode) invalidateBalanceCache()
          sendJson(res, result.persistError ? 500 : 200, result)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
        return
      }
      sendJson(res, 200, readWidgetState())
      return
    }

    // 健康检查：给命令、MCP、hook 用来判断服务是否已在跑
    if (pathname === '/whale/health') {
      const cfg = readPluginConfig()
      const found = findApiKey()
      // 凭据诊断（掩码 key、候选凭据文件路径、状态文件路径）只在带令牌时回：这个端口
      // 本机任意进程都能读，而「关机都要令牌」的项目没理由免鉴权暴露这些。未鉴权时
      // 只回 keySource —— 前端与文档都不依赖其余字段。
      const authed = tokenMatches(req.headers['x-whale-token'])
      sendJson(res, 200, {
        ok: true,
        app: HOST_APP_ID,
        version: VERSION,
        pid: process.pid,
        port,
        // 老 Node 上「每轮消耗」会静默退化（node:sqlite 需 ≥22.5）：把版本摆出来，
        // 排查时第一眼就能判断是不是环境问题（审查 C2）
        nodeVersion: process.version,
        usageMode: readWidgetState().usageMode,
        keySource: found.source,
        keyMasked: authed ? maskKey(found.key) : undefined,
        keyProbe: authed && !found.key ? describeKeyProbe() : undefined,
        stateFile: authed ? WIDGET_STATE_FILE : undefined,
        portPinned: cfg.port,
      })
      return
    }

    // 关闭服务（需要 server.json 里的令牌，防止别的本地程序随手关掉）
    if (pathname === '/whale/shutdown' && isWrite) {
      if (!tokenMatches(req.headers['x-whale-token'])) {
        sendJson(res, 403, { ok: false, error: 'bad token' })
        return
      }
      sendJson(res, 200, { ok: true, stopping: true })
      setTimeout(() => stop(0), 50)
      return
    }

    // 钩子事件状态（只读）：菜单的「钩子」状态行与「等确认」提醒用
    if (pathname === '/whale/hook.json') {
      sendJson(res, 200, { ok: true, ...hookStateView() })
      return
    }

    // 版本更新：GET 看状态（含进度），POST 执行动作。
    // 探测与下载都走镜像候选链（见 lib/update.mjs），国内网络下不依赖 GitHub 直连。
    if (pathname === '/whale/update.json') {
      if (isWrite) {
        let action = ''
        try {
          const parsed = JSON.parse(await readBody(req))
          action = String((parsed && parsed.action) || '')
        } catch (err) {}
        if (action === 'check') {
          const state = await checkForUpdate({ current: VERSION })
          sendJson(res, 200, { ok: true, ...updateView(state) })
          return
        }
        if (action === 'skip' || action === 'unskip') {
          const state = readUpdateState()
          const v = action === 'skip' ? state.latest : null
          writeWidgetState({ updateSkip: v })
          sendJson(res, 200, { ok: true, ...updateView(readUpdateState()) })
          return
        }
        if (action === 'update') {
          // 不 await：下载可能几十秒，前端靠 GET 轮询进度
          runUpdate({}).catch(() => {})
          sendJson(res, 202, { ok: true, started: true, ...updateView(readUpdateState()) })
          return
        }
        if (action === 'restart') {
          sendJson(res, 200, { ok: true, restarting: spawnRestart() })
          return
        }
        if (action === 'close') {
          // 关闭插件：先回包再让子进程停掉本服务（同 restart 的理由——不能在自己
          // 的响应还没发出去时先把自己关了）
          sendJson(res, 200, { ok: true, closing: spawnClose() })
          return
        }
        sendJson(res, 400, { ok: false, error: '未知动作' })
        return
      }
      sendJson(res, 200, { ok: true, ...updateView(readUpdateState()) })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }
}

// ---------- 生命周期 ----------
let server = null
let turnTimer = null
let boundPort = null

function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

function writeServerInfo(port) {
  try {
    fs.mkdirSync(path.dirname(SERVER_INFO_FILE), { recursive: true })
    // 不覆盖另一个**还活着**的实例的记录：端口顺延竞态下两个实例会互相盖同一条
    // server.json，于是 stop / close / 重启只认最后写的那一个端口，另一个成了
    // 每秒轮询数据库的孤儿（审查 I3）。自己的记录照常刷新。
    try {
      const prev = JSON.parse(fs.readFileSync(SERVER_INFO_FILE, 'utf8'))
      if (prev && prev.pid && prev.pid !== process.pid && isPidAlive(prev.pid)) {
        // 已经有一个活着的实例在记 server.json：本次不再注册（否则会把它顶掉，
        // 上层就只能看见最后一个端口）。直接退出，让调用方复用那个实例。
        console.log('[fox-widget] 另一个实例已登记 server.json（pid ' + prev.pid + '），本次启动退出')
        process.exit(0)
      }
    } catch (err) {}
    // 0600：文件里有关停令牌。仅 POSIX 生效（Windows 忽略 mode，靠
    // %USERPROFILE% 目录的 ACL 限制其他用户读取）。
    fs.writeFileSync(
      SERVER_INFO_FILE,
      JSON.stringify(
        {
          pid: process.pid,
          port,
          url: 'http://127.0.0.1:' + port + '/',
          token: TOKEN,
          version: VERSION,
          startedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      { encoding: 'utf8', mode: 0o600 }
    )
  } catch (err) {}
}

function clearServerInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(SERVER_INFO_FILE, 'utf8'))
    // 只清理自己写下的记录，避免误删新进程的信息
    if (info && info.pid === process.pid) fs.unlinkSync(SERVER_INFO_FILE)
  } catch (err) {}
}

function stop(code) {
  try {
    if (turnTimer) clearInterval(turnTimer)
  } catch (err) {}
  clearServerInfo()
  let exited = false
  const finish = () => {
    if (exited) return
    exited = true
    process.exit(code)
  }
  // 先掐断存活连接再等 close 回调：keep-alive 连接会让 server.close() 的回调
  // 一直不触发；而在连接仍在收尾时直接 process.exit 会撞 Windows 上的 libuv
  // 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）。
  try {
    if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections()
  } catch (err) {}
  try {
    if (server) server.close(finish)
  } catch (err) {
    finish()
  }
  // 兜底：close 回调万一不触发也要退出（正常路径下 closeAllConnections 后回调
  // 随即触发，不会走到这里）
  setTimeout(finish, 1500)
}

// 端口占用时向后顺延，避免和其它本地服务抢端口
function listen(port, attemptsLeft) {
  server = http.createServer(createRequestHandler(port))
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      // 占用者可能是**我们自己**（同一插件的另一个实例）。这种情况绝不能顺延
      // 端口再起一个：两个实例各自轮询宿主库、各自写 server.json，stop 只能停掉
      // 最后一个（审查 I3）。确认是本插件实例就安静退出，让调用方复用那个。
      probeHealth(port, 600)
        .then((health) => {
          if (health && health.pid && health.pid !== process.pid) {
            console.log(
              '[fox-widget] 已有挂件服务在运行（pid ' + health.pid + ' → http://127.0.0.1:' + port + '/），本次启动退出'
            )
            process.exit(0)
          }
          if (attemptsLeft > 0) {
            try {
              server.close()
            } catch (e) {}
            listen(port + 1, attemptsLeft - 1)
            return
          }
          console.error('[fox-widget] 无法启动挂件服务:', String((err && err.message) || err))
          process.exit(1)
        })
        .catch(() => {
          if (attemptsLeft > 0) {
            try {
              server.close()
            } catch (e) {}
            listen(port + 1, attemptsLeft - 1)
            return
          }
          console.error('[fox-widget] 无法启动挂件服务:', String((err && err.message) || err))
          process.exit(1)
        })
      return
    }
    // 日志前缀用插件名（与 MCP 服务、浮层的 stderr 前缀一致，方便在一堆日志里认出来）
    console.error('[fox-widget] 无法启动挂件服务:', String((err && err.message) || err))
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    boundPort = port
    writeServerInfo(port)
    pollTurnCost()
    turnTimer = setInterval(pollTurnCost, TURN_POLL_MS)
    // 版本自检：启动 20 秒后首查，之后每 6 小时一次（走镜像候选链，见 update.mjs）
    startAutoCheck()
    console.log('🐳 WorkBuddy狐娘小挂件 已就绪: http://127.0.0.1:' + port + '/')
    console.log('   数据目录: ' + path.dirname(WIDGET_STATE_FILE))
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

// node:sqlite 需要 Node ≥ 22.5（每轮积分 / 用量记录依赖它）。缺了不会崩，但数据
// 会静默退化：把原因写到 stderr，别让用户猜（审查 C2）。
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number)
if (NODE_MAJOR < 22 || (NODE_MAJOR === 22 && NODE_MINOR < 5)) {
  console.warn(
    '[fox-widget] 当前 Node ' + process.version + ' 缺少 node:sqlite（需 ≥ 22.5）：每轮积分 / 用量记录将不可用'
  )
}

const configPort = readPluginConfig().port
listen(configPort || DEFAULT_PORT, 20)

export { boundPort, stop }
