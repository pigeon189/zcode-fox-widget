#!/usr/bin/env node
// 生成并签名 dock 的更新清单（docs/dock/update.json）。
//
// 用法：
//   node tools/sign-manifest.mjs --version 0.2.0-pre.1 --package dist/dock.tar.gz \
//        --url https://example.com/dock.tar.gz [--notes "…"] [--key <私钥>] [--out <清单路径>]
//
// 不传 --package 时保留清单里已有的 sha256（适合只改 notes 后重签）。
// 私钥默认读 %USERPROFILE%\fox-dock-release-key.pem（tools/dock-keygen.mjs 生成）。

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalManifest, signManifest, verifyManifest } from '../shared/manifest.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = path.join(HERE, '..', '..', 'docs', 'dock', 'update.json')
const DEFAULT_PUB = path.join(HERE, '..', 'keys', 'update-pub.pem')

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const version = argValue('--version', '')
const url = argValue('--url', '')
const pkg = argValue('--package', '')
const notes = argValue('--notes', '')
const keyPath = argValue('--key', path.join(os.homedir(), 'fox-dock-release-key.pem'))
const outPath = argValue('--out', DEFAULT_OUT)

if (!version) {
  console.error('缺少 --version（例如 0.2.0-pre.1）')
  process.exit(1)
}
if (!url) {
  console.error('缺少 --url（用于下载 tar.gz 的地址）')
  process.exit(1)
}
if (!fs.existsSync(keyPath)) {
  console.error('找不到私钥：' + keyPath)
  console.error('先生成：node tools/dock-keygen.mjs')
  process.exit(1)
}

let sha = argValue('--sha256', '')
if (pkg) {
  sha = crypto.createHash('sha256').update(fs.readFileSync(pkg)).digest('hex')
} else if (!sha) {
  try {
    sha = JSON.parse(fs.readFileSync(outPath, 'utf8')).sha256 || ''
  } catch (err) {}
}
if (!/^[0-9a-f]{64}$/i.test(sha)) {
  console.error('缺少有效 sha256：用 --package 指一个包，或 --sha256 显式给')
  process.exit(1)
}

const manifest = signManifest({ version, url, sha256: sha, notes }, fs.readFileSync(keyPath, 'utf8'))

// 出包前先自己验一遍：公钥在仓库里，验不过说明私钥和公钥不是一对
if (fs.existsSync(DEFAULT_PUB)) {
  const v = verifyManifest(manifest, fs.readFileSync(DEFAULT_PUB, 'utf8'))
  if (!v.ok) {
    console.error('自检失败：' + v.reason)
    console.error('私钥与仓库公钥不匹配——检查 ' + keyPath + ' 与 ' + DEFAULT_PUB)
    process.exit(1)
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('清单已写入：' + outPath)
console.log('  version ' + manifest.version)
console.log('  sha256  ' + manifest.sha256)
console.log('  signed  ' + canonicalManifest(manifest).length + ' bytes payload')
