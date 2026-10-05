// 「环回/私有/保留地址」的统一判定口径。
// 审查 P3-2：此前 discover.mjs 的 isLocalHost 与 credentials.mjs 的 isPrivateIPv4
// 各持一份——前者不拦 169.254 链路本地、100.64/10 CGNAT 与 0.0.0.0/8，指向这些
// 地址的 provider 会被误判成真厂商、其 key 被发往真实 API（出站白名单挡住了
// 请求本身，但 key 已被误用）。credentials（出站黑名单 + 镜像校验）与
// discover（本地网关跳过）现在都从这里取。
// 注意：credentials.mjs → discover.mjs 的 import 已存在，discover 不能反向
// import credentials，故抽成独立小模块。

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (Number(m[1]) > 255 || Number(m[2]) > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // 组播/保留
  return false
}

function isReservedIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h.includes(':')) return false
  if (h === '::' || h === '::1') return true
  if (/^f[cd]/.test(h)) return true // fc00::/7 ULA
  if (/^fe[89ab]/.test(h)) return true // fe80::/10 link-local
  return false
}

// 指向本机/内网的目标一律判「本地」：出站黑名单据此拒绝，凭据发现据此按本地
// 网关跳过。localhost 系名字 + 环回/私有/保留的字面量 IP；空值按本地处理
// （fail-closed）。
export function isBlockedHost(host) {
  const h = String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .trim()
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  return isPrivateIPv4(h) || isReservedIPv6(h)
}
