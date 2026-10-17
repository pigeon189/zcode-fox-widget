// 挂件服务的发现、拉起与关闭。
// 被 MCP 工具和 SessionStart 自启 hook 共用：两者都只关心"服务是否已经在跑"，
// 不在跑就拉起来，跑着就复用，避免重复监听端口。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, SERVER_INFO_FILE, DATA_DIR, CLOSE_PAUSE_FILE } from './paths.mjs'
import { HOST_NODE_BIN, HOST_APP_ID } from './host.mjs'
import { readPluginConfig } from './credentials.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ENTRY = path.join(HERE, 'server.mjs')

// 启动互斥锁：与 server.json 同目录，进程崩溃留下的陈旧锁按「持锁 pid 已死 /
// 超过 TTL」自动失效（见 acquireStartLock）。
const START_LOCK_FILE = path.join(path.dirname(SERVER_INFO_FILE), 'server.start.lock')
const START_LOCK_TTL_MS = 30_000

// 宿主自带 node，直接用 PATH 里的 node 拉起独立进程；允许环境变量覆盖。
// 【实测】WorkBuddy 钩子的 command 就是 `node ...`（内置插件 subscription-gate
// 也这么写），说明钩子/子进程 PATH 里有 node；WorkBuddy 自带的是 v22.22.2。
function nodeBin() {
  return process.env[HOST_NODE_BIN] || 'node'
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

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

// spawn 之前先确认 node 真的能起：PATH 里没有 node（或被组策略拦掉）时，
// spawn 只会在子进程上**异步** emit 'error'——没有监听就是未捕获异常，直接
// 带走调用方进程（SessionStart 钩子会以非零退出结束，浮层主进程会直接崩）。
// 同步探一次，失败返回结构化错误，让调用方降级。
function probeNodeBin() {
  try {
    const r = spawnSync(nodeBin(), ['-v'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    if (r && !r.error && r.status === 0) return { ok: true, version: String(r.stdout || '').trim() }
    const why = r && r.error ? String(r.error.message || r.error) : '退出码 ' + (r ? r.status : '未知')
    return { ok: false, error: '找不到可用的 node 运行时（' + nodeBin() + '）：' + why }
  } catch (err) {
    return { ok: false, error: '找不到可用的 node 运行时（' + nodeBin() + '）：' + String((err && err.message) || err) }
  }
}

// ---------- 跨进程启动锁 ----------
//
// 【为什么必须有】三条路径可以同时到达 ensureServer：SessionStart 钩子、MCP 的
// start 工具、浮层启动时的自举（WorkBuddy 线还多一个看门狗）。没有互斥时它们都会
// find→空→spawn；多个实例各自 listen（端口顺延），后启动的 writeServerInfo()
// 覆盖同一个 server.json，于是 stop / close / 重启只认最后那个端口，另一个实例
// 成了每秒轮询数据库的孤儿进程。用 O_EXCL 建锁文件做互斥；锁里记 pid + 时间，
// 持锁进程已死或超 TTL 视为陈旧锁。
function readStartLock() {
  try {
    return JSON.parse(fs.readFileSync(START_LOCK_FILE, 'utf8'))
  } catch (err) {
    return null
  }
}

function acquireStartLock(depth = 0) {
  try {
    fs.mkdirSync(path.dirname(START_LOCK_FILE), { recursive: true })
    const fd = fs.openSync(START_LOCK_FILE, 'wx')
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    fs.closeSync(fd)
    return true
  } catch (err) {
    if (!err || err.code !== 'EEXIST') return false
    if (depth > 0) return false
    const holder = readStartLock()
    const age = Date.now() - (Number(holder && holder.at) || 0)
    // 持锁进程还活着且没超时：让别人先起，调用方去等它的结果
    if (holder && isPidAlive(holder.pid) && age >= 0 && age < START_LOCK_TTL_MS) return false
    try {
      fs.unlinkSync(START_LOCK_FILE)
    } catch (e) {}
    return acquireStartLock(depth + 1)
  }
}

function releaseStartLock() {
  try {
    const holder = readStartLock()
    if (!holder || holder.pid === process.pid) fs.unlinkSync(START_LOCK_FILE)
  } catch (err) {}
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
    // 认 app 标识，避免误认别的本地服务（与 server.mjs /whale/health 的 app 字段
    // 必须完全一致——两处不一致会让 findRunningServer 永远找不到在跑的服务）
    return data && data.app === HOST_APP_ID ? data : null
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

// 同一进程内的并发调用合并成一次（钩子、看门狗、浮层自举都可能同时到达）。
let ensureInFlight = null

export function ensureServer(opts = {}) {
  if (!ensureInFlight) {
    ensureInFlight = ensureServerOnce(opts).finally(() => {
      ensureInFlight = null
    })
  }
  return ensureInFlight
}

async function ensureServerOnce({ waitReadyMs = 6000 } = {}) {
  const running = await findRunningServer()
  if (running) {
    return { running: true, started: false, port: running.port, health: running.health }
  }
  const port = readPluginConfig().port || DEFAULT_PORT

  // 环境不可用就别 spawn：异步 emit 的 'error' 会直接终止调用方进程
  const node = probeNodeBin()
  if (!node.ok) return { running: false, started: false, port, error: node.error }

  if (!acquireStartLock()) {
    // 别人正在启动：等它把服务拉起来即可，绝不再起第二个
    const deadline = Date.now() + waitReadyMs
    while (Date.now() < deadline) {
      await sleep(200)
      const other = await findRunningServer()
      if (other) return { running: true, started: false, port: other.port, health: other.health }
    }
    return {
      running: false,
      started: false,
      port,
      error: '另一个启动流程正在进行，但挂件服务未在超时前就绪',
    }
  }

  try {
    // 等锁期间别人可能已经把服务起好了，拿到锁后再探一次
    const again = await findRunningServer()
    if (again) return { running: true, started: false, port: again.port, health: again.health }
    return await spawnServer(port, waitReadyMs)
  } finally {
    releaseStartLock()
  }
}

function spawnServer(port, waitReadyMs) {
  let spawnError = null
  const child = spawn(nodeBin(), [SERVER_ENTRY], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  // 必须监听：'error'（ENOENT/EPERM/EACCES）在没有监听器时会以未捕获异常的形式
  // 终止当前进程，把「启动失败」变成「整个进程崩掉」
  child.on('error', (err) => {
    spawnError = err
  })
  child.unref()

  return (async () => {
    const deadline = Date.now() + waitReadyMs
    while (Date.now() < deadline) {
      await sleep(250)
      if (spawnError) {
        return {
          running: false,
          started: false,
          port,
          error: '挂件服务进程启动失败：' + String((spawnError && spawnError.message) || spawnError),
        }
      }
      const started = await findRunningServer()
      if (started) {
        // server.json 里记的是**另一个** pid：说明我们 spawn 的这个是多余的
        // （锁失效/端口顺延的竞态）。收掉它，复用已经在跑的那个，避免孤儿。
        if (started.info && started.info.pid && child.pid && started.info.pid !== child.pid) {
          try {
            child.kill()
          } catch (err) {}
          return { running: true, started: false, port: started.port, health: started.health, deduped: true }
        }
        return { running: true, started: true, port: started.port, health: started.health }
      }
    }
    return {
      running: false,
      started: false,
      port,
      error: '挂件服务未能在超时前就绪（可用 node lib/server.mjs 前台运行查看报错）',
    }
  })()
}

// 等端口真的不再应答。收到 /whale/shutdown 的 200 只说明「已受理」，进程还要过
// 几十到上百毫秒才退出（响应先回、再关连接、最后 process.exit）。不等这一下，
// 紧接着的 start 会探到尚未退出的旧进程并拿到 200，于是判定「复用已在运行的
// 服务」直接返回——旧进程随后退出，结果是重启完一个服务都不剩（实测确定性复现）。
export async function waitServerStopped(port, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const health = await probeHealth(port, 500)
    if (!health) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 100))
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
    if (!data || !data.ok) return { ok: false, error: '关闭请求被拒绝' }
    // 受理 ≠ 停止：必须等端口真的停止应答，否则 restart 的「停→起」之间会撞上
    // 还没退干净的旧进程（见 waitServerStopped 注释）
    const stopped = await waitServerStopped(running.port)
    return stopped ? { ok: true } : { ok: false, error: '服务未在超时内停止（pid=' + (info.pid || '未知') + '）' }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

export function widgetUrl(port) {
  return 'http://127.0.0.1:' + (port || readPluginConfig().port || DEFAULT_PORT) + '/'
}

// ---------- 「本次关闭」标记（菜单「关闭插件」用） ----------
// 只活在「本次」：标记存在期间看门狗停手（它会每 15 秒补活，不拦就白关了）；一旦
// 宿主重启（看门狗走 noteHostUp）或挂件被别的路径拉回来（钩子 / 显式启动 / 看门狗
// 发现服务已活），标记即失效。刻意不放进 config.json——那是用户配置，这不是设置。
export function writeClosePause() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(CLOSE_PAUSE_FILE, JSON.stringify({ at: Date.now() }), 'utf8')
    return true
  } catch (err) {
    return false
  }
}

export function readClosePause() {
  try {
    const d = JSON.parse(fs.readFileSync(CLOSE_PAUSE_FILE, 'utf8'))
    return { at: Number(d && d.at) || 0 }
  } catch (err) {
    return null
  }
}

export function clearClosePause() {
  try {
    fs.unlinkSync(CLOSE_PAUSE_FILE)
  } catch (err) {}
}
