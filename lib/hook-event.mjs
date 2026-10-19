// WorkBuddy 钩子事件 → 挂件状态文件（借鉴 CrossPet 的接入方式，做了两点取舍）。
//
// 为什么只挂低频事件：WorkBuddy 的钩子**始终内联执行**，每挂一个事件就是每次触发
// 都要起一个 node 进程（冷启动 ~40–80ms）。PreToolUse / PostToolUse 每次工具调用
// 各来一发，会给用户每次工具调用都加延迟——不可接受。所以当前只挂三个：
//   SessionStart     —— 幂等拉起服务（在 autostart.mjs，不在这里）
//   UserPromptSubmit —— 用户新一轮提问（=「开始干活」），**同时刷新会话身份**
//   Notification     —— 宿主发通知（=「在等你确认」的候选事件源）
//
// `hook_event_name` 的处理**额外兼容** PreToolUse / PostToolUse / Stop / SessionEnd：
// 它们当前没挂，但将来做「姿势状态机」时 PostToolUse 是主要数据面（见
// MIGRATION-PLAN §4.1.3）。届时记得那里的前置依赖是**噪音过滤**
//（用 sessions.is_background_automation 跳过后台轮次），否则角色会被后台任务带得乱动。
//
// **会话身份是本文件最重要的产出**：每轮消耗、上下文余量、当前模型全都要知道
// 「现在这个会话是哪个」。宿主在钩子 stdin 里给了 session_id 与 transcript_path，
// 把它们落进 hook-state.json，挂件服务就能用 lib/turn-cost.mjs 直接定位数据。
//
// 事件表差异（承 HANDOFF §5.3）：WorkBuddy **没有 PermissionRequest 事件**，
// 所以「等确认提醒」改挂 Notification——它是唯一语义接近的候选，但它也会在
// 别的通知上触发，属于**已知的过度触发**（前端默认关闭该提醒，开启时另做去重）。
//
// 只写一个小文件：<数据目录>/hook-state.json。失败一律静默退出 0——
// 钩子出错绝不能影响 WorkBuddy 本身的行为（非零退出码会被当成钩子失败）。
//
// **为什么这里还顺手做一次「补拉起」（v2.0.1 新增）**：WorkBuddy **启动客户端本身
// 不触发 SessionStart**。实测（`--` 与宿主日志对齐）：两个存活 14s / 21s 的应用实例里
// SessionStart 一次都没跑；其余实例的延迟从 +19s 到 +736s 毫无规律 → 它是**用户动作
// 驱动**的（source=resume：真正进入/恢复一个会话，例如点「对话回退」），不是启动定时器。
// 我们的自启原先**只**挂在 SessionStart 上，于是「启动客户端后一动不动 = 桌面上没有挂件，
// 一动会话才冒出来」。
//
// 所以这里加一个**极廉价**的兜底：处理完事件后瞄一眼 overlay.json / server.json 的 pid
// 是否还活着（一次文件读 + 一次 kill(pid,0)），不活才**后台 detached** 拉起 autostart.mjs，
// **不等待**、不阻塞用户这一轮。挂在 UserPromptSubmit / Notification 上意味着「用户做的
// 第一件事」就会把挂件带出来。
//
// 注意两条硬约束：
//   1. **不许在这个文件里 import overlay.mjs / service.mjs**——它们会连带拉起一串模块，
//      而钩子是内联执行的，每轮都要付这份冷启动成本。这里只用 node: 内置 + paths.mjs。
//   2. 必须有**节流**：挂件起来要几秒，节流窗口内不重复 spawn，避免连发消息时拉出一堆 Electron。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DATA_DIR, HOOK_STATE_FILE, PLUGIN_ROOT } from './paths.mjs'
import { postDockEvent } from './dock-shim.mjs'

// 等确认的触发事件（WorkBuddy 没有 PermissionRequest，用 Notification 顶）
const ASKING_EVENTS = ['Notification', 'PermissionRequest']
// 提问类工具名兜底（PreToolUse 挂着的时候才有用，当前未挂，留作将来）
const ASKING_TOOLS = ['askuserquestion', 'ask_user_question', 'request_user_input', 'clarify']
// 明确表示「上一轮已经过去」的事件
const CLEARING_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionEnd']

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function readState() {
  try {
    const v = JSON.parse(fs.readFileSync(HOOK_STATE_FILE, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch (err) {
    return {}
  }
}

function writeState(next) {
  const tmp = HOOK_STATE_FILE + '.' + process.pid + '.tmp'
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    // 临时名带进程号 + rename：多个事件同时到达时不互相截断
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8')
    fs.renameSync(tmp, HOOK_STATE_FILE)
  } catch (err) {
    // 【不能静默】（2026-10-14 审查 P2-C：现场残留过 hook-state.json.<pid>.tmp，
    // rename 失败过一次且无任何日志）状态写失败 = 会话身份停更 → 每轮消耗、
    // 上下文余量、当前模型全部静默失效。落一行诊断 + 清掉本轮残留的 tmp；
    // 钩子本身仍以 0 退出（钩子失败绝不能影响宿主）。
    try {
      fs.appendFileSync(
        DATA_DIR + '/hook-state.error.log',
        new Date().toISOString() + ' writeState failed: ' + String((err && err.message) || err) + '\n'
      )
    } catch (e) {}
    try {
      fs.unlinkSync(tmp)
    } catch (e) {}
  }
}

// ---------- 补拉起（见文件头「为什么这里还顺手做一次补拉起」）----------

// 需要「确保挂件在跑」的事件：都是**用户主动做了一件明显的事**的低频事件。
// 不加 SessionStart——那条路走 autostart.mjs，这里再插一脚只会重复 spawn。
const ENSURE_EVENTS = ['UserPromptSubmit', 'Notification']
// 节流窗口：挂件从 spawn 到能显示要几秒（Electron 冷启动 + 跟随脚本首轮探测），
// 窗口内不再重复 spawn。20s 足够覆盖启动过程，又不会让「真的挂了」等太久。
const ENSURE_THROTTLE_MS = 20000

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

function readJsonSafe(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? v : null
  } catch (err) {
    return null
  }
}

// 挂件此刻是否「服务 + 浮层都在」？只用两个小文件，不碰进程表
//（`listOverlayPids()` 要起一次 PowerShell，约 1.8s，不能放在每轮的钩子里）。
function widgetFullyUp() {
  const svc = readJsonSafe(path.join(DATA_DIR, 'server.json'))
  if (!svc || !pidAlive(svc.pid)) return false
  const ov = readJsonSafe(path.join(DATA_DIR, 'overlay.json'))
  if (!ov || !pidAlive(ov.pid)) return false
  return true
}

// 返回要写进状态文件的 ensureSpawnAt（没 spawn 就返回上一次的值，保持节流窗口连续）
function maybeEnsureRunning(state) {
  if (ENSURE_EVENTS.indexOf(String(state.event || '')) === -1) return undefined
  if (process.env.FOX_WIDGET_NO_ENSURE === '1') return undefined // 排障开关：关掉补拉起
  try {
    if (widgetFullyUp()) return undefined

    const last = Number(state.lastEnsureSpawnAt) || 0
    if (last && Date.now() - last < ENSURE_THROTTLE_MS) return last

    // 后台 detached 拉起：**不 await**。钩子必须立刻退出——它在用户的这一轮之前
    // 同步执行，等它就把「发消息」的体感拖慢了。
    const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'autostart.mjs')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    debugLog('ensure-spawn pid=' + child.pid)
    return Date.now()
  } catch (err) {
    debugLog('ensure-spawn failed: ' + String((err && err.message) || err))
    return undefined
  }
}

// 排查用（默认关）：FOX_WIDGET_HOOK_DEBUG=1 时把每次事件追加到 hook.log。
// 这是「钩子到底有没有被触发」的第一手证据——项目历史上最大的时间浪费之一
// 就是「以为钩子生效了」（HANDOFF §9.2）。
function debugLog(line) {
  if (process.env.FOX_WIDGET_HOOK_DEBUG !== '1') return
  try {
    const file = path.join(DATA_DIR, 'hook.log')
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n', 'utf8')
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    if (lines.length > 300) fs.writeFileSync(file, lines.slice(-300).join('\n') + '\n', 'utf8')
  } catch (err) {}
}

function readStdin() {
  try {
    const buf = fs.readFileSync(0) // fd 0 = stdin；没有输入时返回空
    const text = buf.toString('utf8')
    if (!text.trim()) return null
    return JSON.parse(text)
  } catch (err) {
    return null
  }
}

try {
  const event = readStdin() || {}
  const name = String(event.hook_event_name || '')
  // 没解析出事件名 = 空输入或坏 JSON（或宿主改了字段名）：直接退出，**不写文件**——
  // 否则会把上一次的真实状态覆盖成空，连带清掉「等确认」标记与会话身份。
  debugLog('event=' + (name || '(none)') + ' parsed=' + (event && event.session_id ? 'yes' : 'no'))
  if (!name) process.exit(0)

  const tool = String(event.tool_name || '')
  const state = readState()
  const counts = state.counts && typeof state.counts === 'object' ? state.counts : {}
  counts[name] = (Number(counts[name]) || 0) + 1

  // 会话身份：有就给，没有就保留上一次的（Stop/Notification 等事件都带）
  const sid = String(event.session_id || '') || String(state.sessionId || '')
  const transcript = String(event.transcript_path || '') || String(state.transcriptPath || '')
  const cwd = String(event.cwd || '') || String(state.cwd || '')
  const permissionMode = String(event.permission_mode || '') || String(state.permissionMode || '')

  let waiting = false
  if (ASKING_EVENTS.indexOf(name) !== -1) waiting = true
  if (name === 'PreToolUse' && ASKING_TOOLS.indexOf(tool.toLowerCase()) !== -1) waiting = true
  if (CLEARING_EVENTS.indexOf(name) !== -1) waiting = false
  // waiting 的清除靠「用户提交了新一轮」（说明上一轮已经过去了）与前端的超时兜底

  // Notification 的原始载荷留一份（掩掉可能含密钥的长文本），方便核实
  // 「Notification 到底是不是只在等确认时才发」——这是 §三.3 的待验证项。
  let noteKind = ''
  if (name === 'Notification') {
    const raw = event.message || event.notification || event.notification_type || ''
    noteKind = String(raw).slice(0, 200)
  }

  const next = {
    event: name,
    tool: tool,
    sessionId: sid,
    transcriptPath: transcript,
    cwd,
    permissionMode,
    ts: nowSec(),
    waiting,
    notification: noteKind || undefined,
    counts,
    // 补拉起的节流锚点：沿用上一次的值，真正 spawn 时才刷新
    lastEnsureSpawnAt: Number(state.lastEnsureSpawnAt) || undefined,
  }
  const ensureAt = maybeEnsureRunning(next)
  if (ensureAt) next.lastEnsureSpawnAt = ensureAt
  writeState(next)
  if (name === 'UserPromptSubmit' || name === 'Notification' || name === 'PermissionRequest') {
    await postDockEvent({
      type: name === 'UserPromptSubmit' ? 'turn-start' : 'permission-request',
      agentId: 'workbuddy',
      sessionId: sid,
    })
  }
} catch (err) {}

process.exit(0)
