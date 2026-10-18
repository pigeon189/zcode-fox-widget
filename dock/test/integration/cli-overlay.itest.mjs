// CLI 启停（R10）：验证「一条命令把服务 + 浮层都拉起来，再一起收掉」
// 这条就是启动器（launch/*.cmd / *.vbs）实际走的路。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DOCK = path.join(HERE, '..', '..')
const CLI = path.join(DOCK, 'tools', 'fox-dock.mjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-cli-overlay-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(args) {
  return new Promise((resolve) => {
    const env = { ...process.env }
    // agent 会话/容器里 GPU 子进程起不来会直接崩；正常桌面双击不需要这个
    env.FOX_DOCK_NO_SANDBOX = '1'
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('exit', (code) => resolve({ code, out, err }))
  })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return false
  }
}

test('CLI start → 服务 + 浮层都在；stop → 两个都收掉', async (t) => {
  if (process.platform !== 'win32') return t.skip('windows only')
  let overlayPid = 0
  try {
    const started = await run(['start', '--data-dir', dir, '--debug-port', '9413'])
    assert.equal(started.code, 0, started.err || started.out)
    assert.match(started.out, /started pid=\d+/)
    assert.match(started.out, /overlay pid=\d+/, started.out)

    const info = JSON.parse(fs.readFileSync(path.join(dir, 'overlay.pid'), 'utf8'))
    overlayPid = info.pid
    await sleep(800)
    assert.ok(alive(overlayPid), 'overlay process should be alive')

    const status = await run(['status', '--data-dir', dir])
    assert.match(status.out, /overlay pid=/)

    const stopped = await run(['stop', '--data-dir', dir])
    assert.equal(stopped.code, 0, stopped.err || stopped.out)
    assert.match(stopped.out, /stopped/)
    await sleep(500)
    assert.equal(alive(overlayPid), false, 'overlay should be gone after stop')
    assert.equal(fs.existsSync(path.join(dir, 'overlay.pid')), false)
    assert.equal(fs.existsSync(path.join(dir, 'daemon.lock')), false)
  } finally {
    if (overlayPid && alive(overlayPid)) {
      try {
        process.kill(overlayPid, 'SIGKILL')
      } catch (err) {}
    }
    await run(['stop', '--data-dir', dir]).catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
