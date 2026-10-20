import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { defaultDataDir, pathsFor } from '../../daemon/src/paths.mjs'

test('paths: FOX_DOCK_DATA 是完整数据目录，不再嵌套 fox-dock', () => {
  const prev = process.env.FOX_DOCK_DATA
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-paths-'))
  try {
    process.env.FOX_DOCK_DATA = dir
    assert.equal(defaultDataDir(), path.resolve(dir))
    assert.equal(pathsFor('').dir, path.resolve(dir))
  } finally {
    if (prev === undefined) delete process.env.FOX_DOCK_DATA
    else process.env.FOX_DOCK_DATA = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('paths: engines 能读到同一数据目录下的 runtime-env.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-env-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-home-'))
  try {
    fs.writeFileSync(path.join(dir, 'runtime-env.json'), JSON.stringify({ ZCODE_DATA_BASE_DIR: 'C:/host-base' }))
    const moduleUrl = pathToFileURL(path.resolve('engines', 'paths.mjs')).href
    const script =
      'import { DATA_DIR, zcodeDataBase } from ' + JSON.stringify(moduleUrl) + ';' +
      'console.log(JSON.stringify({ dataDir: DATA_DIR, base: zcodeDataBase({}) }))'
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, FOX_DOCK_DATA: dir, ZCODE_HOME: home, ZCODE_DATA_BASE_DIR: '' },
    })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop())
    assert.equal(path.resolve(out.dataDir), path.resolve(dir))
    assert.equal(out.base, 'C:/host-base')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  }
})
