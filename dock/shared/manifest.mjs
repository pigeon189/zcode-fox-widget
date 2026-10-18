// 更新清单签名 / 验签（R9 补强，D012）。
//
// 之前只有 sha256：清单和包同源，仓库被攻破时 sha256 拦不住（攻击者可以同时改包和哈希）。
// 现在清单带 Ed25519 签名，公钥在仓库里，私钥只在发布机上——改清单必须拿到私钥。
//
// 签的内容是**固定字段的规范串**（不是原始文件字节）：JSON 的键顺序、空格、
// 换行都不影响验签，避免「重新格式化一下清单就失效」。

import crypto from 'node:crypto'

// 只签这几个字段：其它字段（如 generatedAt、notes 之外的元数据）改了不影响有效性，
// 但也意味着它们**不受保护**——所以凡是被 updateFromManifest 使用的字段必须在这里。
export const SIGNED_FIELDS = ['version', 'url', 'sha256', 'notes']

export function canonicalManifest(m) {
  const src = m && typeof m === 'object' ? m : {}
  const out = {}
  for (const k of SIGNED_FIELDS) out[k] = typeof src[k] === 'string' ? src[k] : ''
  return JSON.stringify(out)
}

export function signManifest(manifest, privateKeyPem) {
  if (!privateKeyPem) throw new Error('private key required')
  const sig = crypto.sign(null, Buffer.from(canonicalManifest(manifest), 'utf8'), privateKeyPem)
  return { ...manifest, signature: sig.toString('base64') }
}

export function verifyManifest(manifest, publicKeyPem) {
  if (!publicKeyPem) return { ok: false, reason: 'no-public-key' }
  const sig = manifest && manifest.signature
  if (typeof sig !== 'string' || !sig) return { ok: false, reason: 'missing-signature' }
  let buf = null
  try {
    buf = Buffer.from(sig, 'base64')
  } catch (err) {
    return { ok: false, reason: 'bad-signature-encoding' }
  }
  if (!buf || !buf.length) return { ok: false, reason: 'bad-signature-encoding' }
  try {
    const ok = crypto.verify(null, Buffer.from(canonicalManifest(manifest), 'utf8'), publicKeyPem, buf)
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' }
  } catch (err) {
    return { ok: false, reason: 'verify-error: ' + String((err && err.message) || err) }
  }
}

export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
}
