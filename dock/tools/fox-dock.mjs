#!/usr/bin/env node
// fox-dock CLI (R1): doctor / version.
// daemon 的 start/stop/install 在 R2 接入。

import { Win32Bridge } from '../daemon/src/win32.mjs'
import { VERSION } from '../daemon/src/main.mjs'

function pad(s, n) {
  s = String(s == null ? '' : s)
  let w = 0
  for (const ch of s) w += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1
  return s + ' '.repeat(Math.max(0, n - w))
}

async function doctor(args) {
  const asJson = args.includes('--json')
  const bridge = new Win32Bridge()
  const t0 = Date.now()
  await bridge.start()
  const readyMs = Date.now() - t0
  const t1 = Date.now()
  const windows = await bridge.snapshot()
  const snapMs = Date.now() - t1
  const cursor = await bridge.cursor()
  const hits = await bridge.hit(cursor.x, cursor.y, process.pid)
  bridge.stop()

  if (asJson) {
    console.log(JSON.stringify({ ok: true, version: VERSION, readyMs, snapMs, cursor, windows, hits }, null, 2))
    return
  }

  console.log('fox-dock ' + VERSION + '  doctor')
  console.log('bridge ready in ' + readyMs + 'ms, snapshot ' + windows.length + ' windows in ' + snapMs + 'ms')
  console.log('')
  console.log(pad('Z', 4) + pad('PID', 7) + pad('DPI', 5) + pad('RECT', 21) + pad('EXE', 30) + 'TITLE')
  for (const w of windows.slice(0, 40)) {
    const exe = w.exe ? w.exe.split(/[\\/]/).pop() : '(unknown)'
    const rect = w.rect.x + ',' + w.rect.y + ' ' + w.rect.w + 'x' + w.rect.h
    console.log(pad(w.z, 4) + pad(w.pid, 7) + pad(w.dpi, 5) + pad(rect, 21) + pad(exe, 30) + w.title)
  }
  console.log('')
  console.log('cursor ' + cursor.x + ',' + cursor.y + ' (own pid ' + process.pid + ' excluded)')
  if (!hits.length) console.log('  no window under cursor')
  for (const h of hits) {
    const exe = h.exe ? h.exe.split(/[\\/]/).pop() : '(unknown)'
    console.log('  z=' + h.z + ' pid=' + h.pid + ' ' + exe + '  ' + JSON.stringify(h.title))
  }
}

const [, , cmd, ...rest] = process.argv
try {
  if (cmd === 'doctor') await doctor(rest)
  else if (cmd === 'version' || cmd === '--version' || cmd === '-v') console.log(VERSION)
  else {
    console.log('usage: fox-dock <doctor|version>')
    process.exitCode = cmd ? 1 : 0
  }
} catch (err) {
  console.error('fox-dock: ' + (err && err.message ? err.message : err))
  process.exitCode = 1
}
