#!/usr/bin/env node
// M0 P-4 探针：Win32 聚焦成功率（只读，不入 CI；需要桌面会话）。
//
//   node tools/probe-win32-focus.mjs [--hwnd <hex>] [--repeat 5]
//
// 不指定 hwnd 时，挑一个当前可见、非本进程的顶层窗口尝试聚焦。
// 输出每次 method（foreground / flash）与成功率。成功率 <90% → 回落为
// 「闪烁任务栏 + 系统通知」，UI 文案改为「提醒宿主窗口」。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Win32Bridge } from '../daemon/src/win32.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1] || fallback
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const hwndArg = arg('--hwnd', '')
const repeat = Math.max(1, Math.min(20, Number(arg('--repeat', '5')) || 5))

const bridge = new Win32Bridge({ script: path.join(ROOT, 'daemon', 'win32', 'bridge.ps1') })
let report = { probe: 'P-4-win32-focus', ok: false, attempts: [], foreground: 0, flash: 0, failed: 0, conclusion: '' }
try {
  await bridge.start()
  const windows = await bridge.snapshot()
  const pick =
    hwndArg ||
    (windows.find((w) => w.hwnd && w.pid !== process.pid && !/fox-dock/i.test(w.title || '')) || {}).hwnd
  if (!pick) {
    report.conclusion = '没有可测试的窗口'
  } else {
    report.hwnd = pick
    for (let i = 0; i < repeat; i++) {
      const r = await bridge.focus(pick)
      report.attempts.push(r)
      if (r.ok && r.method === 'foreground') report.foreground++
      else if (r.ok && r.method === 'flash') report.flash++
      else report.failed++
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const rate = report.foreground / repeat
    report.ok = true
    report.conclusion =
      rate >= 0.9
        ? '前台聚焦成功率 ' + Math.round(rate * 100) + '% → 可直接「跳转到宿主窗口」'
        : '前台聚焦成功率 ' + Math.round(rate * 100) + '% → UI 文案改为「提醒宿主窗口」，允许 flash 回落'
  }
} catch (err) {
  report.error = String((err && err.message) || err)
  report.conclusion = '桥不可用：' + report.error
} finally {
  bridge.stop()
}
console.log(JSON.stringify(report, null, 2))
