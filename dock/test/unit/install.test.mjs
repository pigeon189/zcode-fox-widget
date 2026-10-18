import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCmd, buildVbs, installLauncher, launcherPaths, uninstallLauncher } from '../../daemon/src/install.mjs'

const sample = {
  nodePath: 'C:\\node\\node.exe',
  watchdogPath: 'C:\\app\\daemon\\watchdog.mjs',
  dataDir: 'C:\\Users\\me\\AppData\\Local\\fox-dock',
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fox-dock-install-'))
}

test('launcher: VBS 把命令包成一个字符串，内部引号翻倍', () => {
  const vbs = buildVbs(sample)
  assert.match(vbs, /CreateObject\("WScript.Shell"\)/)
  // 路径两侧的引号应变成 ""，整条命令处于一对引号内
  assert.ok(vbs.includes('""C:\\node\\node.exe""'))
  assert.ok(vbs.includes('""C:\\app\\daemon\\watchdog.mjs""'))
  assert.ok(vbs.includes(', 0, False'))
})

test('launcher: CMD 版本带 start，路径加引号', () => {
  const cmd = buildCmd(sample)
  assert.ok(cmd.startsWith('@echo off'))
  assert.ok(cmd.includes('start "" "C:\\node\\node.exe" "C:\\app\\daemon\\watchdog.mjs"'))
})

test('launcher: 路径里有引号/换行 → 直接拒绝，不生成半坏脚本', () => {
  assert.throws(() => buildVbs({ ...sample, nodePath: 'C:\\a"b\\node.exe' }), /quote or newline/)
  assert.throws(() => buildCmd({ ...sample, dataDir: 'C:\\a\nb' }), /quote or newline/)
  assert.throws(() => buildVbs({ ...sample, nodePath: '' }), /required/)
})

test('install: 写入启动器，重复安装幂等', () => {
  const dir = tempDir()
  const r1 = installLauncher({ ...sample, startupDir: dir })
  assert.equal(r1.file, launcherPaths(dir).vbs)
  assert.ok(fs.existsSync(r1.file))
  const before = fs.readFileSync(r1.file, 'utf8')
  installLauncher({ ...sample, startupDir: dir })
  assert.equal(fs.readFileSync(r1.file, 'utf8'), before)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('install: 切换格式时删掉另一种，避免登录起两个', () => {
  const dir = tempDir()
  installLauncher({ ...sample, startupDir: dir })
  assert.ok(fs.existsSync(launcherPaths(dir).vbs))
  installLauncher({ ...sample, startupDir: dir, format: 'cmd' })
  assert.ok(fs.existsSync(launcherPaths(dir).cmd))
  assert.equal(fs.existsSync(launcherPaths(dir).vbs), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('uninstall: 删除两种启动器；目录为空时不报错', () => {
  const dir = tempDir()
  installLauncher({ ...sample, startupDir: dir })
  const r = uninstallLauncher({ startupDir: dir })
  assert.equal(r.removed.length, 1)
  assert.equal(fs.existsSync(launcherPaths(dir).vbs), false)
  const again = uninstallLauncher({ startupDir: dir })
  assert.deepEqual(again.removed, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('launcher: command 会写进命令行（登录时跑 start）', () => {
  const vbs = buildVbs({
    nodePath: 'C:////node////node.exe',
    scriptPath: 'C:////dock////tools////fox-dock.mjs',
    command: 'start',
    dataDir: 'C:////data',
  })
  assert.match(vbs, /fox-dock\.mjs"" start --data-dir/)
})

test('launcher: command 里出现奇怪字符 → 拒绝', () => {
  assert.throws(
    () => buildVbs({ nodePath: 'n', scriptPath: 's', command: 'start & calc', dataDir: 'd' }),
    /illegal characters/
  )
})
