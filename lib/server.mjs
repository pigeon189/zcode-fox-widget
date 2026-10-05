// ZCode 版鲸鱼挂件的本地 HTTP 服务。
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
//   在信任边界之内**——它们本来就能直接读写 ~/.zcode/whale/ 下的数据文件（记账
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
  BUILTIN_ROLES,
  BUILTIN_ROLE_RENAMES,
  BUILTIN_SOUND_NAMES,
  DEFAULT_PORT,
  DEFAULT_ROLE_ID,
  GIF_CANDIDATES,
  IMAGE_CANDIDATES,
  ROLES_DIR,
  ROLES_INDEX_FILE,
  SERVER_INFO_FILE,
  SOUND_SETS,
  SOUNDS_DIR,
  SOUNDS_INDEX_FILE,
  TURN_SEQ_FILE,
  WIDGET_STATE_FILE,
} from './paths.mjs'
import { readLatestTurn, turnIdentity, readActiveSelection, readLatestUsageModel } from './turn-cost.mjs'
import { findProviderBaseUrl } from './discover.mjs'
import { resolveBillingSource } from './source.mjs'
import { readPlanBalance, turnPlanUsage } from './plan-balance.mjs'
import { readCmdgoQuota } from './cmdgo.mjs'
import { listVendorStatus, pickVendorBalance } from './vendors.mjs'
import { usageRecords } from './usage-records.mjs'
import { readZcodeTheme } from './zcode-theme.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET_JS = path.join(HERE, 'widget.js')
const VERSION = '1.8.9'
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

function readRoleImage() {
  const stateRoleId = readWidgetState().roleId
  // 未指定（null）= 默认角色小狐娘；旧「默认」鲸鱼改为显式 id 'whale'
  const roleId = stateRoleId || DEFAULT_ROLE_ID
  const idx = readRolesIndex()
  const builtin = visibleBuiltins(idx).find((r) => r.id === roleId)
  if (builtin) return readFirst([builtin.image])
  const entry = idx.roles.find((r) => r && r.id === roleId)
  if (!entry || typeof entry.file !== 'string') return null
  // basename 夹住文件名：索引被手改也不会越出角色目录
  const full = path.join(ROLES_DIR, path.basename(entry.file))
  try {
    const bytes = fs.readFileSync(full)
    return bytes && bytes.length ? bytes : null
  } catch (err) {
    return null
  }
}

function listRoles() {
  const idx = readRolesIndex()
  // 内置形象固定在前（小狐娘=默认、小鲸鱼=原「默认」），用户上传件在后；
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
  try {
    fs.writeFileSync(ROLES_INDEX_FILE, JSON.stringify(idx, null, 2), 'utf8')
  } catch (err) {}
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
  // 名字优先取用户给的，其次取第一个文件名（去掉扩展名）
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
const BUBBLE_RAND_MAX = 12
const BUBBLE_TEXT_MAX = 200

function normalizeBubbleModule(raw) {
  if (!raw || typeof raw !== 'object') return null
  const size = raw.size === 'B' || raw.size === 'C' ? raw.size : 'A'
  // 内置视图：这一泡显示挂件自带的气泡内容（标题 + 主数字 + 小字，随计费源
  // 自动跟随：余额 / Plan 配额 / 今日已用 / 峰谷）。空模块列表 = 内置视图，
  // 但显式声明能存进配置、在编辑器里一目了然。
  if (raw.type === 'view') return { type: 'view', size }
  if (raw.type === 'rand') {
    const lines = Array.isArray(raw.lines)
      ? raw.lines
          .map((s) => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n').slice(0, BUBBLE_TEXT_MAX) : ''))
          .filter((s) => s.trim())
          .slice(0, BUBBLE_RAND_MAX)
      : []
    return { type: 'rand', lines, size }
  }
  const text = typeof raw.text === 'string' ? raw.text.replace(/\r\n?/g, '\n').slice(0, BUBBLE_TEXT_MAX) : ''
  return { type: 'text', text, size }
}

function normalizeBubbleStep(raw) {
  const modules = Array.isArray(raw && raw.modules)
    ? raw.modules
        .map(normalizeBubbleModule)
        .filter(Boolean)
        // 空语句池的 rand 与 view 模块都是合法内容（前者 = 用内置随机台词，
        // 后者 = 用内置气泡视图），不当空模块过滤
        .filter((m) => (m.type === 'view' || m.type === 'rand' ? true : m.text.trim()))
        .slice(0, BUBBLE_MODULE_MAX)
    : []
  return { modules }
}

function normalizeBubbleContent(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  if (Array.isArray(src.steps)) {
    const steps = src.steps
      .slice(0, BUBBLE_STEP_MAX)
      .map(normalizeBubbleStep)
      .filter((st) => st.modules.length)
    return { v: 2, tapAdvance: src.tapAdvance !== false, steps }
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
  return { v: 2, tapAdvance: true, steps }
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

function pollTurnCost() {
  let t
  try {
    t = readLatestTurn()
  } catch (err) {
    return
  }
  const id = turnIdentity(t)
  if (!t || !t.ok || !id) return
  if (currentIdentity === null) {
    // 服务刚起来：对齐当前轮次，不把历史最后一条当成"新的一轮"
    currentIdentity = id
    return
  }
  if (id !== currentIdentity) {
    currentIdentity = id
    seq += 1
    persistSeq()
    const planInfo = turnPlanUsage(t)
    lastTurnPayload = {
      ok: true,
      seq,
      turn: t.turnId,
      amount: t.amount,
      currency: t.currency,
      amounts: t.amounts,
      tokens: t.tokens,
      model: t.model,
      peak: t.peak,
      ts: t.ts,
      // 多厂商计价扩展：billable=false 表示该轮供应商无价目（如订阅套餐/网关），
      // 前端应按 tokens/配额口径展示而不是 ¥0.00；models 为逐模型明细。
      // 套餐轮（Start plan 等）另带余额口径：planPct 占配额总量百分比（与主显示
      // 「Plan 剩余 x%」同基数）、planTokens 套餐行 tokens、extraAmounts 混合轮次
      // 里非套餐行的金额；quotaPct 保留旧字段（占模型桶百分比，兼容旧前端）。
      billable: t.billable !== false,
      providerId: t.providerId,
      vendor: t.vendor,
      vendorLabel: t.vendorLabel,
      breakdown: t.breakdown,
      models: t.models,
      quotaPct: planInfo ? planInfo.pctOfBucket : null,
      planPct: planInfo ? planInfo.pctOfTotal : null,
      planTurn: !!(planInfo && planInfo.planTurn),
      planTokens: planInfo ? planInfo.tokens : null,
      extraAmounts: planInfo ? planInfo.extraAmounts : null,
    }
  }
}

// 计划扣费轮的余额口径换算在 plan-balance.mjs 的 turnPlanUsage 里（selftest
// 直接对它做单元断言，这里只取结果）。

// ---------- 智能跟随：当前计费源 ----------
//
// 输入框 selection 优先（选定当下即生效）；selection 缺失或不可识别时回落
// 最近一次真实模型调用（model_usage）——「对话发起时识别对话模型」。两路都
// 识别不出时 source='tokens'（只显示消耗量），绝不冒充 DeepSeek 余额。
// 有官方余额接口的按量厂商：把模板余额附进会话载荷，气泡小字显示「· 余额 ¥ x」。
// 键 = source.mjs 的 source id，值 = vendors.mjs 模板 id（按优先级排序，取第一个
// 抓到余额的）。vendors 层自带 5 分钟远程缓存，session.json 的 3 秒轮询不会放大
// 上游请求。
const SOURCE_BALANCE_TEMPLATES = {
  kimi: ['moonshot-cn', 'moonshot-intl'],
}
async function attachVendorBalance(payload) {
  const ids = SOURCE_BALANCE_TEMPLATES[payload.source]
  if (!ids) return payload
  try {
    const vb = pickVendorBalance(await listVendorStatus(false), ids)
    if (vb) payload.vendorBalance = vb
  } catch (err) {}
  return payload
}

function readSessionSource() {
  const sel = readActiveSelection()
  const resolve = (providerId, modelId) => resolveBillingSource(providerId, modelId, findProviderBaseUrl(providerId))
  if (sel.ok) {
    const r = resolve(sel.providerId, sel.modelId)
    if (r.source !== 'tokens') {
      return attachVendorBalance({
        ok: true,
        providerId: sel.providerId,
        modelId: sel.modelId,
        from: 'selection',
        updatedAt: sel.updatedAt || 0,
        source: r.source,
        vendor: r.vendor,
        label: r.label,
        currency: r.currency,
        timeMode: r.timeMode,
      })
    }
  }
  const mu = readLatestUsageModel()
  if (mu.ok) {
    const r = resolve(mu.providerId, mu.modelId)
    return attachVendorBalance({
      ok: true,
      providerId: mu.providerId,
      modelId: mu.modelId,
      from: 'model-usage',
      updatedAt: mu.ts || 0,
      source: r.source,
      vendor: r.vendor,
      label: r.label,
      currency: r.currency,
      timeMode: r.timeMode,
    })
  }
  // 既没有 selection 也没有调用记录：如实返回原因，前端显示「未知来源」
  return { ok: false, reason: sel.ok ? 'unrecognized' : sel.reason || 'no-selection', source: 'tokens' }
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
        // 而不是被 destroy 后只看到连接中断。
        req.resume()
        reject(new Error('body too large'))
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
<!-- 空的 data URI favicon：不声明的话浏览器会隐式请求 /favicon.ico，本地服务只回 404 -->
<link rel="icon" href="data:,">
<title>ZCode狐娘小挂件</title>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:${bg}}
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

    // 页面
    if (pathname === '/' || pathname === '/index.html') {
      const html = pageHtml(url.searchParams.get('bg') === 'dark')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
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
      const bytes = readRoleImage() || readFirst(IMAGE_CANDIDATES)
      if (!bytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('whale image unavailable')
        return
      }
      sendBytes(res, 'image/png', bytes)
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
          const parsed = JSON.parse(await readBody(req))
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

    // ZCode 自己的主题（ui.theme）：挂件「跟随 ZCode」用它，ZCode 没明确选浅/深
    // 时回 system（挂件再退回系统深浅色）。
    if (pathname === '/whale/zcode-theme.json') {
      try {
        sendJson(res, 200, Object.assign({ ok: true }, readZcodeTheme()))
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

    // CommandCode 套餐三重额度（月度池 + 5小时/周窗口）：cmdgo.mjs 自带 60s
    // 每凭据 TTL，?refresh=1 强制绕过
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
        sendJson(res, 200, await listVendorStatus(force))
      } catch (err) {
        sendJson(res, 200, { ok: false, reason: String((err && err.message) || err).slice(0, 200) })
      }
      return
    }

    // 用量记录：今日 / 近 7 天 / 最近事件（直读 model_usage）
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
      sendJson(res, 200, {
        ok: true,
        app: 'zcode-fox-widget',
        version: VERSION,
        pid: process.pid,
        port,
        usageMode: readWidgetState().usageMode,
        keySource: found.source,
        keyMasked: maskKey(found.key),
        keyProbe: found.key ? undefined : describeKeyProbe(),
        stateFile: WIDGET_STATE_FILE,
        portPinned: cfg.port,
      })
      return
    }

    // 关闭服务（需要 server.json 里的令牌，防止别的本地程序随手关掉）
    if (pathname === '/whale/shutdown' && isWrite) {
      if (String(req.headers['x-whale-token'] || '') !== TOKEN) {
        sendJson(res, 403, { ok: false, error: 'bad token' })
        return
      }
      sendJson(res, 200, { ok: true, stopping: true })
      setTimeout(() => stop(0), 50)
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }
}

// ---------- 生命周期 ----------
let server = null
let turnTimer = null
let boundPort = null

function writeServerInfo(port) {
  try {
    fs.mkdirSync(path.dirname(SERVER_INFO_FILE), { recursive: true })
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
  try {
    if (server) server.close()
  } catch (err) {}
  // 给 in-flight 响应一点时间落地
  setTimeout(() => process.exit(code), 60)
}

// 端口占用时向后顺延，避免和其它本地服务抢端口
function listen(port, attemptsLeft) {
  server = http.createServer(createRequestHandler(port))
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      try {
        server.close()
      } catch (e) {}
      listen(port + 1, attemptsLeft - 1)
      return
    }
    console.error('[zcode-whale] 无法启动挂件服务:', String((err && err.message) || err))
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    boundPort = port
    writeServerInfo(port)
    pollTurnCost()
    turnTimer = setInterval(pollTurnCost, 1000)
    console.log('🐳 ZCode狐娘小挂件 已就绪: http://127.0.0.1:' + port + '/')
    console.log('   数据目录: ' + path.dirname(WIDGET_STATE_FILE))
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

const configPort = readPluginConfig().port
listen(configPort || DEFAULT_PORT, 20)

export { boundPort, stop }
