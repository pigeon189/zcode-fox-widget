// SessionStart 自启：对应上游「每次打开界面自动启用（常驻自启）」。
//
// 作为 WorkBuddy 的 SessionStart hook 运行。hook 的 stdout 会被当作 JSON 严格
// 校验，所以这里全程静默——任何成功/失败都不输出内容，只保证：
//   1. 挂件服务被拉起（默认开启，config.autoStartWidget=false 可关）
//   2. Electron 运行时已装的情况下，顺便把桌面浮层也拉到桌面上
//      （config.autoStartOverlay=false 可关）
//
// 每次运行都会往 <插件数据目录>/autostart.log 追加一行结果，方便确认
// 「打开 WorkBuddy 时鲸鱼有没有被自动拉起」。**这也是 Phase 0 里验证
// 「WorkBuddy 的 command 型钩子到底有没有被触发」的第一手证据**
//（比 hook-state.json 更早：钩子一跑就有日志，不依赖会话是否有活动）。
import fs from 'node:fs'
import path from 'node:path'
import { readPluginConfig } from './credentials.mjs'
import { ensureServer } from './service.mjs'
import { dockOnline, ensureDock } from './dock-shim.mjs'
import { isRuntimeInstalled, startOverlay } from './overlay.mjs'
import { DATA_DIR } from './paths.mjs'

const LOG_FILE = path.join(DATA_DIR, 'autostart.log')
const LOG_KEEP_LINES = 200

function record(text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + text + '\n', 'utf8')
    // 只留最近若干行，避免长期运行后无限增长
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    if (lines.length > LOG_KEEP_LINES) {
      fs.writeFileSync(LOG_FILE, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n', 'utf8')
    }
  } catch (err) {}
}

// 钩子总预算（毫秒）：hooks.json 里 timeout 是 20 秒，这里按 15s 给自己设上限
// ——服务 5s + 浮层 3s 等旧实例 + 1.2s 观察窗口 ≈ 9.2s，留足余量给钩子框架本身。
// 超过预算就跳过浮层这一步（服务已经起来了，下次会话/手动 window start 都能补），
// 绝不让钩子被上游超时杀掉、把浮层留在「已 spawn 但状态未落盘」的中间态
// （审查 I2：旧预算 5+6+3+1.8 ≈ 15.8s，本来就超过 15s 超时）。
const HOOK_BUDGET_MS = 15000
const startedAt = Date.now()

try {
  const cfg = readPluginConfig()
  if (!cfg.autoStartWidget) {
    record('skip: autoStartWidget=false')
  } else {
    const dock = await dockOnline({ timeoutMs: 80 })
    let dockNote = dock ? 'online' : ''
    let dockHandled = !!dock
    if (!dock) {
      const r = ensureDock()
      dockNote = r.ok ? 'ensuring' : 'skip:' + r.reason
      dockHandled = r.ok
    }
    const svc = await ensureServer({ waitReadyMs: 5000 })
    let overlayNote = 'skipped'
    if (svc.running && cfg.autoStartOverlay) {
      if (dockHandled) {
        overlayNote = 'skipped:dock-online'
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
    record(
      'server=' + (svc.running ? (svc.started ? 'started' : 'reused') : 'failed:' + (svc.error || 'unknown')) +
        ' overlay=' + overlayNote +
        ' dock=' + dockNote +
        ' elapsed=' + (Date.now() - startedAt) + 'ms'
    )
  }
} catch (err) {
  // 自启失败不能影响会话启动；需要排查时看 autostart.log 的上一行
  record('error: ' + String((err && err.message) || err))
}
