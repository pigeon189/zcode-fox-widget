#!/usr/bin/env node
// 生成 dock 更新清单的签名密钥对（Ed25519）。
//
// **私钥写到仓库外面**（默认 %USERPROFILE%\fox-dock-release-key.pem），公钥入库。
// 私钥一旦进了 git 历史就等于公开——这条和挂件线的签名密钥是同一个纪律。
//
// 用法：node tools/dock-keygen.mjs [--key <path>] [--force]

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPair } from '../shared/manifest.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUB = path.join(HERE, '..', 'keys', 'update-pub.pem')

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}

const privPath = argValue('--key', path.join(os.homedir(), 'fox-dock-release-key.pem'))
const force = process.argv.includes('--force')

if (fs.existsSync(privPath) && !force) {
  console.error('私钥已存在：' + privPath)
  console.error('要换密钥请加 --force（旧签名会全部失效，必须重新签名并发布）')
  process.exit(1)
}

const { publicKeyPem, privateKeyPem } = generateKeyPair()
fs.mkdirSync(path.dirname(privPath), { recursive: true })
fs.writeFileSync(privPath, privateKeyPem, { mode: 0o600 })
fs.mkdirSync(path.dirname(PUB), { recursive: true })
fs.writeFileSync(PUB, publicKeyPem)

const fingerprint = crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)
console.log('私钥：' + privPath + '  （不要提交、不要外传）')
console.log('公钥：' + PUB)
console.log('指纹：' + fingerprint)
