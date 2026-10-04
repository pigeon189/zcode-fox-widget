// 挂件服务的发现、拉起与关闭。
// 被 MCP 工具和 SessionStart 自启 hook 共用：两者都只关心"服务是否已经在跑"，
// 不在跑就拉起来，跑着就复用，避免重复监听端口。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, SERVER_INFO_FILE } from './paths.mjs'
import { readPluginConfig } from './credentials.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(HERE, 'server.mjs')

// ZCode 自带 node，直接用 PATH 里的 node 拉起独立进程；允许环境变量覆盖。
function nodeBin() {
  return process.env.ZCODE_WHALE_NODE || 'node'
}

export function readServerInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(SERVER_INFO_FILE, 'utf8'))
    if (info && typeof info.port === 'number' && typeof info.token === 'string') return info
  } catch (err) {}
  return null
}

// 只有健康检查通过才算"在跑"：server.json 可能是崩溃进程留下的。
export async function probeHealth(port, timeoutMs = 800) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/whale/health', {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data && data.app === 'zcode-fox-widget' ? data : null
  } catch (err) {
    return null
  }
}

// 先看记录里的端口，再看默认端口，最后线性扫一段端口范围。
export async function findRunningServer() {
  const candidates = []
  const info = readServerInfo()
  if (info) candidates.push(info.port)
  const cfgPort = readPluginConfig().port
  if (cfgPort) candidates.push(cfgPort)
  candidates.push(DEFAULT_PORT)
  const seen = new Set()
  for (const port of candidates) {
    if (!port || seen.has(port)) continue
    seen.add(port)
    const health = await probeHealth(port)
    if (health) return { port, health, info: info && info.port === port ? info : null }
  }
  return null
}

export async function ensureServer({ waitReadyMs = 6000 } = {}) {
  const running = await findRunningServer()
  if (running) {
    return { running: true, started: false, port: running.port, health: running.health }
  }
  const port = readPluginConfig().port || DEFAULT_PORT
  const child = spawn(nodeBin(), [SERVER_ENTRY], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  const deadline = Date.now() + waitReadyMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    const started = await findRunningServer()
    if (started) {
      return { running: true, started: true, port: started.port, health: started.health }
    }
  }
  return {
    running: false,
    started: false,
    port,
    error: '挂件服务未能在超时前就绪（可用 node lib/server.mjs 前台运行查看报错）',
  }
}

export async function stopServer() {
  const running = await findRunningServer()
  if (!running) return { ok: false, error: '挂件服务未在运行' }
  const info = running.info || readServerInfo()
  if (!info || typeof info.token !== 'string') {
    return { ok: false, error: '缺少关闭令牌，请手动结束进程 pid=' + (info ? info.pid : '未知') }
  }
  try {
    const res = await fetch('http://127.0.0.1:' + running.port + '/whale/shutdown', {
      method: 'POST',
      headers: { 'x-whale-token': info.token },
      signal: AbortSignal.timeout(2000),
    })
    const data = await res.json()
    return data && data.ok ? { ok: true } : { ok: false, error: '关闭请求被拒绝' }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

export function widgetUrl(port) {
  return 'http://127.0.0.1:' + (port || readPluginConfig().port || DEFAULT_PORT) + '/'
}
