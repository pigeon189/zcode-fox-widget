import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { crc32 } from '../../shared/zip.mjs'
import { importCategories, inspectSources } from '../../daemon/src/import-old.mjs'

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function makePng(w = 2, h = 2) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 4 + 1) * h))), chunk('IEND', Buffer.alloc(0))])
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-import-'))
const oldDir = path.join(base, 'old')
const dataDir = path.join(base, 'dock')
const paths = { dir: dataDir, rolesDir: path.join(dataDir, 'roles'), ledger: path.join(dataDir, 'ledger.json') }

function setup() {
  fs.mkdirSync(path.join(oldDir, 'roles'), { recursive: true })
  fs.writeFileSync(path.join(oldDir, 'roles', 'my-role.png'), makePng(8, 8))
  fs.writeFileSync(path.join(oldDir, 'roles.json'), JSON.stringify({ roles: { 'my-role': { name: '旧角色' } } }))
  fs.writeFileSync(path.join(oldDir, 'bubble-templates.json'), JSON.stringify([{ name: 't1', steps: ['a'] }]))
  fs.writeFileSync(path.join(oldDir, 'bubble-content.json'), JSON.stringify({ queue: ['a'] }))
  fs.writeFileSync(
    path.join(oldDir, 'usage-ledger.json'),
    JSON.stringify({ days: { '2026-10-18': { zcode: { name: 'ZCode', unit: 'money', amounts: { CNY: 3 }, at: 1 } } } })
  )
  fs.writeFileSync(path.join(oldDir, 'widget-state.json'), JSON.stringify({ scale: 1.5, sound: true, petMode: true, alerts: { quotaPct: 15 } }))
  fs.writeFileSync(
    path.join(oldDir, 'config.json'),
    JSON.stringify({ apiKey: 'should-not-copy', vendorKeys: { openai: 'k' }, relayAuth: { packycode: { token: 't', userId: 'u' } } })
  )
  return fs.statSync(path.join(oldDir, 'roles', 'my-role.png')).mtimeMs
}

const oldMtime = setup()
after(() => fs.rmSync(base, { recursive: true, force: true }))

test('import-old: 检查来源列出可用类别', () => {
  const sources = inspectSources({ ZCODE_HOME: base, FOX_DOCK_IMPORT_DIRS: oldDir })
  const src = sources.find((s) => s.id === 'custom-2') || sources.find((s) => s.dir === path.resolve(oldDir))
  assert.ok(src)
  assert.equal(src.categories.roles, 1)
  assert.equal(src.categories.bubbleTemplates, 1)
  assert.equal(src.categories.widgetState, 1)
})

test('import-old: 按类别导入，源目录只读，配置不复制 apiKey', () => {
  const src = inspectSources({ ZCODE_HOME: base, FOX_DOCK_IMPORT_DIRS: oldDir }).find((s) => s.dir === path.resolve(oldDir))
  const r = importCategories({
    source: src.id,
    categories: ['roles', 'bubbleTemplates', 'bubbleContent', 'ledger', 'widgetState'],
    paths,
    env: { ZCODE_HOME: base, FOX_DOCK_IMPORT_DIRS: oldDir },
  })
  assert.equal(r.summary.roles.count, 1)
  assert.equal(r.summary.bubbleTemplates.count, 1)
  assert.equal(r.summary.ledger.count, 1)
  assert.equal(r.summary.widgetState.count > 0, true)
  assert.equal(r.settingsPatch.scale, 1.5)
  assert.equal(fs.statSync(path.join(oldDir, 'roles', 'my-role.png')).mtimeMs, oldMtime, '源文件 mtime 不能变')
  assert.ok(fs.existsSync(path.join(paths.rolesDir, 'my-role.png')))
  const idx = JSON.parse(fs.readFileSync(path.join(dataDir, 'roles.json'), 'utf8'))
  assert.equal(idx.roles['my-role'].name, '旧角色')
  assert.equal(fs.existsSync(path.join(dataDir, 'vendor-config.json')), false, '导入不能生成明文厂商配置')
})

test('import-old: 未知来源/不存在目录报可读错误', () => {
  assert.throws(() => importCategories({ source: 'nope', categories: ['roles'], paths, env: {} }), /未知来源/)
})
