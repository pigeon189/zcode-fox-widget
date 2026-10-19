import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { electronVersion, mirrorUrls, ownElectronPath, resolveRuntime, runtimeCandidates } from '../../daemon/src/runtime.mjs'

test('runtime: 版本钉在 package.json 的 foxDock.electron', () => {
  assert.match(electronVersion(), /^\d+\.\d+\.\d+$/)
})

test('runtime: 自带运行时优先于挂件线候选', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rt-'))
  try {
    const env = { ...process.env, FOX_DOCK_RUNTIME_DIR: dir, FOX_DOCK_ELECTRON: '' }
    const own = ownElectronPath(electronVersion(), env)
    fs.mkdirSync(path.dirname(own), { recursive: true })
    fs.writeFileSync(own, '')
    const r = resolveRuntime(env)
    assert.equal(r.source, 'own')
    assert.equal(r.path, own)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runtime: FOX_DOCK_ELECTRON 最高优先级', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rt-'))
  try {
    const explicit = path.join(dir, 'custom-electron.exe')
    fs.writeFileSync(explicit, '')
    const env = { ...process.env, FOX_DOCK_RUNTIME_DIR: path.join(dir, 'runtime'), FOX_DOCK_ELECTRON: explicit }
    assert.equal(resolveRuntime(env).path, explicit)
    assert.equal(runtimeCandidates(env)[0].path, explicit)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runtime: 找不到时返回空路径而不是抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-rt-'))
  try {
    const env = { ...process.env, FOX_DOCK_RUNTIME_DIR: path.join(dir, 'none'), FOX_DOCK_ELECTRON: '' }
    const r = resolveRuntime(env)
    if (r.path) {
      // 本机可能确实装着挂件线运行时；只要不是来自我们临时目录即可
      assert.notEqual(r.source, 'own')
    } else {
      assert.equal(r.source, '')
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runtime: 镜像链指向版本化 zip 与 SHASUMS', () => {
  const urls = mirrorUrls('44.4.5', 'win32', 'x64')
  assert.equal(urls.length, 2)
  assert.match(urls[0].base, /npmmirror\.com\/mirrors\/electron\/44\.4\.5\//)
  assert.match(urls[1].base, /github\.com\/electron\/electron\/releases\/download\/v44\.4\.5\//)
  assert.equal(urls[0].file, 'electron-v44.4.5-win32-x64.zip')
})
