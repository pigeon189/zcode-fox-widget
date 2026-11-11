// 拉起挂件服务 + 浮层的共用逻辑。
//
// 调用方有两个：
//   · autostart.mjs —— ZCode SessionStart 钩子（会话启动/恢复时）
//   · zcode-watch.mjs —— 登录后常驻的看门进程（ZCode 进程一出现就拉起）
//
// 这里只做「幂等启动 + 预算控制」，不写日志、不输出 stdout；调用方自己记录。

import { readPluginConfig } from './credentials.mjs'
import { ensureServer } from './service.mjs'
import { isRuntimeInstalled, startOverlay } from './overlay.mjs'
import { dockOnline, ensureDock, dockQuitForThisBoot } from './dock-shim.mjs'

// 与 hooks/hooks.json 的 20s 超时对齐：服务 5s + 浮层 3s 等旧实例 + 观察窗口。
export const HOOK_BUDGET_MS = 15000

// dock 拉起后等它真的在线，再把自己的浮层让掉。ensure 只是 spawn：dock 自身可能
// 起不来（2026-11-12 真机：陈旧 watchdog 锁里是已被系统回收的 pid，watchdog 每次
// 都判「已在运行」直接退出，daemon 永远不启动）。老挂件这时若已经把浮层让掉，
// 桌面上两边都没有角色——比「两只角色」更糟，而且日志还写着 dock-online。
// probe / sleep 可注入，便于自检用假时钟验证「等不到就返回 false」。
export async function waitDockOnline(opts = {}) {
  const raw = Number(opts.timeoutMs)
  const timeoutMs = Number.isFinite(raw) && raw >= 0 ? raw : 6000
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 250
  const probe = typeof opts.probe === 'function' ? opts.probe : () => dockOnline({ timeoutMs: 250 })
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms))
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const deadline = now() + timeoutMs
  for (;;) {
    if (await probe()) return true
    if (now() >= deadline) return false
    await sleep(intervalMs)
    if (now() >= deadline) return false
  }
}

export async function ensureWidgetStarted(opts = {}) {
  const startedAt = Number(opts.startedAt) || Date.now()
  const cfg = opts.cfg || readPluginConfig()
  if (!cfg.autoStartWidget) {
    return { skipped: 'autoStartWidget=false', server: 'skipped', overlay: 'skipped', dock: 'skipped', elapsed: 0 }
  }

  // dock 在线时旧挂件让出浮层（避免两只角色），但服务仍可拉起给 MCP/老页面用。
  const dock = await dockOnline({ timeoutMs: Number(opts.dockTimeoutMs) || 80 })
  let dockNote = dock ? 'online' : ''
  let dockHandled = !!dock
  if (!dock && opts.ensureDock !== false) {
    const r = ensureDock()
    if (!r.ok) {
      dockNote = 'skip:' + r.reason
    } else if (opts.waitDock === false || (await waitDockOnline({ timeoutMs: opts.dockWaitMs }))) {
      dockNote = 'online'
      dockHandled = true
    } else if (dockQuitForThisBoot()) {
      // 用户本次开机主动退出过 dock（D073）：照旧不显示，别塞一只角色回来
      dockNote = 'offline:quit'
      dockHandled = true
    } else {
      // 拉不起来：回落自己的浮层，总比桌面上什么都没有强
      dockNote = 'offline-fallback'
    }
  }

  const svc = await ensureServer({ waitReadyMs: Number(opts.waitReadyMs) || 5000 })
  let overlayNote = 'skipped'
  if (svc.running && cfg.autoStartOverlay) {
    if (dockHandled) {
      overlayNote = dockNote === 'offline:quit' ? 'skipped:dock-quit' : 'skipped:dock-online'
    } else if (!isRuntimeInstalled()) {
      overlayNote = 'skipped:no-runtime'
    } else if (Date.now() - startedAt > HOOK_BUDGET_MS) {
      overlayNote = 'skipped:budget'
    } else {
      // 复用上面那次 ensureServer 的结果：startOverlay 内部再跑一遍会把最坏
      // 耗时推到 15.8s（超出钩子超时）
      const r = await startOverlay({ svc })
      overlayNote = r.running ? (r.started ? 'started' : 'reused') : 'failed:' + (r.error || 'unknown')
    }
  }

  return {
    server: svc.running ? (svc.started ? 'started' : 'reused') : 'failed:' + (svc.error || 'unknown'),
    overlay: overlayNote,
    dock: dockNote || 'offline',
    elapsed: Date.now() - startedAt,
  }
}
