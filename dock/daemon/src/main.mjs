#!/usr/bin/env node
// R0 骨架：真正的常驻服务（窗口发现 / 绑定 / 适配器 / 账本）在 R1–R2 落地。
// 现在只保证进程能起来、版本号可读，给 CI 与 install 脚本一个稳定入口。
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.1.0-pre.0'

export function banner() {
  return 'fox-dock daemon ' + VERSION + ' (skeleton)'
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
