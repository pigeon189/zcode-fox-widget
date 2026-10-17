// 发布物完整性清单的生成与签名（发布流程的一部分，见 CONTRIBUTING「发布纪律」）。
//
//   node tools/sign-release.mjs --gen-key <私钥路径>            # 一次性：生成密钥对
//   node tools/sign-release.mjs --key <私钥路径> [--rev <rev>]  # 生成清单 + 签名
//   node tools/sign-release.mjs --check [--rev <rev>]           # 校验仓库里的清单是否与当前树一致、签名是否有效
//
// 为什么要走 `git archive` 取字节：仓库有 .gitattributes（`* text=auto eol=lf`、`*.ps1 eol=crlf`），
// 工作区与 blob 的换行符可能不同，而更新器校验的是**下载包里的字节**。直接解析 `git archive`
// 的 tar，与更新器看到的完全一致（更新内核的 parseTar 也是同一套）。
//
// 生成的 `.release-hashes.json` 与 `.release-hashes.json.sig` 必须**在打 tag 之前提交**；
// 私钥留在仓库外，绝不入库。公钥存成仓库根的 `.release-pubkey.pem` 并提交——它是更新器的信任锚。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseTar, normalizeArchivePaths, verifyReleaseFiles, RELEASE_HASH_MANIFEST, RELEASE_HASH_SIG, RELEASE_PUBKEY_FILE } from '../lib/update.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = RELEASE_HASH_MANIFEST
const SIG = RELEASE_HASH_SIG
const PUBKEY = RELEASE_PUBKEY_FILE

function argValue(name) {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return null
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

// 取某个 revision 的打包字节（= 更新器下载到的那份内容）
function archiveFiles(rev) {
  const r = spawnSync('git', ['-C', ROOT, 'archive', '--format=tar', rev || 'HEAD'], { maxBuffer: 512 * 1024 * 1024 })
  if (r.status !== 0) throw new Error('git archive 失败：' + String(r.stderr || '').slice(0, 200))
  return normalizeArchivePaths(parseTar(r.stdout))
}

function manifestOf(files, version) {
  const out = {}
  for (const [rel, body] of files) {
    if (rel === MANIFEST || rel === SIG) continue
    out[rel] = crypto.createHash('sha256').update(body).digest('hex')
  }
  const sorted = {}
  for (const k of Object.keys(out).sort()) sorted[k] = out[k]
  const bytes = Buffer.from(JSON.stringify({ version, files: sorted }, null, 2) + '\n', 'utf8')
  return { bytes, count: Object.keys(sorted).length }
}

function pluginVersionInTree(files) {
  try {
    const rel = files.has('.zcode-plugin/plugin.json') ? '.zcode-plugin/plugin.json' : '.codebuddy-plugin/plugin.json'
    return JSON.parse(String(files.get(rel))).version
  } catch (err) {
    return null
  }
}

const genKey = argValue('gen-key')
if (genKey) {
  const target = path.resolve(String(genKey === true ? 'fox-release-key.pem' : genKey))
  if (fs.existsSync(target)) {
    console.error('私钥已存在，未覆盖：' + target)
    process.exit(1)
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const pub = publicKey.export({ type: 'spki', format: 'pem' })
  fs.writeFileSync(target + '.pub', pub)
  const pubTarget = path.join(ROOT, PUBKEY)
  if (!fs.existsSync(pubTarget)) fs.writeFileSync(pubTarget, pub)
  console.log('私钥：' + target + '（留在仓库外，别提交）')
  console.log('公钥：' + target + '.pub → 已写入 ' + pubTarget + '（提交它，它是更新器的信任锚）')
  console.log('下一步：每次发布前跑一次 `node tools/sign-release.mjs --key ' + target + '`，把生成的两份文件一起提交。')
  process.exit(0)
}

const keyPath = argValue('key')
const check = !!argValue('check')
const rev = argValue('rev')
const files = archiveFiles(rev === true ? 'HEAD' : rev || 'HEAD')
const version = pluginVersionInTree(files)
if (!version) {
  console.error('取不到包内版本号（.zcode-plugin/plugin.json 或 .codebuddy-plugin/plugin.json）')
  process.exit(1)
}
const { bytes, count } = manifestOf(files, version)
// 公钥必须**在清单里**：它随包分发，而更新器会把「清单里没有的文件」判成篡改而拒装。
// 更要紧的是它同时是信任锚——换钥时必须由旧私钥签的清单覆盖新公钥，链才成立。
if (!Object.keys(JSON.parse(bytes.toString('utf8')).files).includes(PUBKEY)) {
  console.error(
    '公钥 ' + PUBKEY + ' 还没进清单（多半是没提交它就先签名了）。先把 ' + PUBKEY +
      ' 提交，再跑签名：否则更新器会把包里的公钥当成「清单外的文件」拒装。'
  )
  process.exit(1)
}

if (check) {
  const onDisk = {
    [MANIFEST]: fs.existsSync(path.join(ROOT, MANIFEST)) ? fs.readFileSync(path.join(ROOT, MANIFEST)) : null,
    [SIG]: fs.existsSync(path.join(ROOT, SIG)) ? fs.readFileSync(path.join(ROOT, SIG)) : null,
  }
  if (!onDisk[MANIFEST] || !onDisk[SIG]) {
    console.error('仓库里缺少 ' + MANIFEST + ' 或 ' + SIG + '（发布前必须生成并提交）')
    process.exit(1)
  }
  const m = new Map(files)
  m.set(MANIFEST, onDisk[MANIFEST])
  m.set(SIG, onDisk[SIG])
  const pub = path.join(ROOT, PUBKEY)
  // 发布自检用**严格**模式：清单外的文件说明有人改了树却没重签名，发布前必须
  // 拦下来（运行时是宽松模式：只忽略未签名文件，不会卡住存量用户）。审查 I7。
  const r = verifyReleaseFiles(m, version, {
    publicKey: fs.existsSync(pub) ? fs.readFileSync(pub, 'utf8') : null,
    strictExtraFiles: true,
  })
  if (!r.ok) {
    console.error('校验未通过：' + r.error)
    process.exit(1)
  }
  const drift = onDisk[MANIFEST].equals(bytes) ? null : '清单内容与当前树不一致（改过代码后没重新签名）'
  if (drift) {
    console.error('校验未通过：' + drift + ' —— 重跑 `node tools/sign-release.mjs --key <私钥>` 并提交')
    process.exit(1)
  }
  console.log('校验通过：v' + version + '，' + count + ' 个文件，签名有效且清单与当前树一致')
  process.exit(0)
}

if (!keyPath || keyPath === true) {
  console.error('需要 --key <私钥路径>（或先跑 --gen-key），详见文件头用法')
  process.exit(1)
}
const priv = crypto.createPrivateKey(fs.readFileSync(path.resolve(String(keyPath)), 'utf8'))
const sig = crypto.sign(null, bytes, priv).toString('base64')
fs.writeFileSync(path.join(ROOT, MANIFEST), bytes)
fs.writeFileSync(path.join(ROOT, SIG), sig + '\n')
console.log('已写出 v' + version + '：' + MANIFEST + '（' + count + ' 个文件）+ ' + SIG)
console.log('记得一起提交，然后才打 tag。')
