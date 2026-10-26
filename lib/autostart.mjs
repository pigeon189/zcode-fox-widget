// SessionStart 自启：拉起挂件服务/浮层，并确保「ZCode 启动即自启」的看门进程在位。
//
// 作为 ZCode 的 SessionStart hook 运行。hook 的 stdout 会被当作 JSON 严格校验，
// 所以这里全程静默——任何成功/失败都不输出内容，只写 ~/.zcode/whale/autostart.log。
//
// 为什么还要装看门进程：SessionStart 要等到会话启动/恢复才触发，用户打开 ZCode
// 停在首页、还没选会话时挂件不会出现。zcode-watch 是登录后的常驻小进程，发现
// ZCode.exe 就拉起同一套服务/浮层，不再依赖“先选一个对话”。

import fs from 'node:fs'
import path from 'node:path'
import { readPluginConfig } from './credentials.mjs'
import { ensureWidgetStarted } from './boot-widget.mjs'
import { installWatch, uninstallWatch, startWatcher, persistRuntimeEnv } from './watch-install.mjs'
import { spawnMigrationProbe } from './migrate.mjs'
import { DATA_DIR } from './paths.mjs'

const LOG_FILE = path.join(DATA_DIR, 'autostart.log')
const LOG_KEEP_LINES = 200

function record(text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + text + '\n', 'utf8')
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    if (lines.length > LOG_KEEP_LINES) {
      fs.writeFileSync(LOG_FILE, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n', 'utf8')
    }
  } catch (err) {}
}

const startedAt = Date.now()

try {
  const cfg = readPluginConfig()
  persistRuntimeEnv()

  if (!cfg.autoStartWidget) {
    const u = uninstallWatch()
    record('skip: autoStartWidget=false watch=' + (u.removed ? 'removed' : 'absent'))
  } else {
    const r = await ensureWidgetStarted({ cfg, startedAt })
    let watchNote = 'disabled'
    if (cfg.autoStartWithZcode !== false) {
      const i = installWatch()
      const w = startWatcher()
      watchNote = !i.ok
        ? 'install-failed:' + (i.reason || 'unknown')
        : w.ok
          ? (w.started ? 'started' : 'reused')
          : 'start-failed:' + (w.reason || 'unknown')
    } else {
      uninstallWatch()
    }
    record(
      'server=' + r.server +
        ' overlay=' + r.overlay +
        ' dock=' + r.dock +
        ' watch=' + watchNote +
        ' migrateProbe=' + (spawnMigrationProbe() ? 'spawned' : 'skipped') +
        ' elapsed=' + (Date.now() - startedAt) + 'ms'
    )
  }
} catch (err) {
  // 自启失败不能影响会话启动；需要排查时看 autostart.log 的上一行
  record('error: ' + String((err && err.message) || err))
}
