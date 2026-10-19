#!/usr/bin/env node
// 打包发布：把 dock/ 打成 dist/dock-<version>.tar.gz（顶层目录 dock-<version>/），
// 并给出 sha256。加 --sign 时顺带生成并签名 docs/dock/update.json（需要私钥）。
//
// 两条硬规则：
//   · 包内出现任何私钥内容 → 直接失败（宁可打不出包，也不能把私钥发出去）
//   · 顶层目录带版本号 → stripTopDir 剥掉后就是 dock/ 的内容
//
// 用法：node tools/pack-release.mjs --version 0.2.0-pre.1 [--url <下载地址>] [--sign] [--notes "…"]

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { writeTar } from '../shared/tar.mjs'
import { signManifest, verifyManifest } from '../shared/manifest.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCK = path.join(HERE, '..')
const DIST = path.join(DOCK, 'dist')
const PUB = path.join(DOCK, 'keys', 'update-pub.pem')
const MANIFEST = path.join(DOCK, '..', 'docs', 'dock', 'update.json')

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.backup', '__shots__', '__diff__', 'test-results', 'playwright-report'])
const SKIP_EXT = new Set(['.tgz', '.gz', '.zip'])

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const version = argValue('--version', '')
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('缺少或非法的 --version（例：0.2.0-pre.1）')
  process.exit(1)
}

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), path.join(base, e.name), out)
      continue
    }
    if (!e.isFile()) continue
    const ext = path.extname(e.name).toLowerCase()
    if (SKIP_EXT.has(ext)) continue
    const full = path.join(dir, e.name)
    const data = fs.readFileSync(full)
    // 私钥体检：任何形似私钥的文件都不许进包
    // 只匹配 PEM 头，避免把「说明文字里提到 PRIVATE KEY」误判成私钥
    if (data.length < 64 * 1024 && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(data.toString('utf8'))) {
      console.error('❌ 包内出现私钥内容：' + path.relative(DOCK, full))
      console.error('   私钥必须放在仓库外，拒绝打包。')
      process.exit(1)
    }
    out.set(path.join(base, e.name).replace(/\\/g, '/'), data)
  }
}

const files = new Map()
walk(DOCK, 'dock-' + version, files)
if (!files.size) {
  console.error('没有可打包的文件')
  process.exit(1)
}

const tar = writeTar(files)
const gz = gzipSync(tar, { level: 9 })
fs.mkdirSync(DIST, { recursive: true })
const outFile = path.join(DIST, 'dock-' + version + '.tar.gz')
fs.writeFileSync(outFile, gz)
const sha = crypto.createHash('sha256').update(gz).digest('hex')

console.log('包：' + outFile)
console.log('文件数：' + files.size + '，大小：' + (gz.length / 1024).toFixed(1) + ' KB')
console.log('sha256：' + sha)

const url = argValue('--url', '')
if (process.argv.includes('--sign')) {
  if (!url) {
    console.error('--sign 需要 --url（包的下载地址）')
    process.exit(1)
  }
  const keyPath = argValue('--key', path.join(os.homedir(), 'fox-dock-release-key.pem'))
  if (!fs.existsSync(keyPath)) {
    console.error('找不到私钥：' + keyPath + '（先 npm run keygen）')
    process.exit(1)
  }
  const manifest = signManifest(
    { version, url, sha256: sha, notes: argValue('--notes', '') },
    fs.readFileSync(keyPath, 'utf8')
  )
  if (fs.existsSync(PUB)) {
    const v = verifyManifest(manifest, fs.readFileSync(PUB, 'utf8'))
    if (!v.ok) {
      console.error('自检失败：' + v.reason)
      process.exit(1)
    }
  }
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true })
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  console.log('清单：' + MANIFEST + '（已签名）')
} else if (url) {
  console.log('提示：加 --sign 生成并签名清单（需要私钥）')
}
