#!/usr/bin/env node
// 常驻服务入口（窗口发现 / 绑定 / 适配器 / 账本）。
// 版本号只从 dock/package.json 读，避免 daemon/CLI/浮层各写一份。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch (err) {
    return '0.0.0'
  }
}

export const VERSION = readVersion()

export function banner() {
  return 'fox-dock daemon ' + VERSION
}

function isEntry() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  } catch (err) {
    return false
  }
}

if (isEntry()) {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    console.log(VERSION)
  } else {
    console.log(banner())
  }
}
