// 「关闭=本次关闭」（P1-关闭语义，对齐 1.x v1.13）：dock 2.0 的退出与自启语义锁定。
//
// 语义（调查结论，dock 已具备，本测试防回归）：
//   ① 退出 = 本次退出：quitDock 调 daemon /shutdown（daemon 以退出码 0 干净停止，
//      watchdog 不再拉起），且**不触碰开机自启**（不卸载启动器、不改 autoStart 设置）。
//      运行时行为已由集成测试覆盖：daemon.itest.mjs「/shutdown 需要令牌…干净退出」
//      与「watchdog：正常停止后一起退出」。
//   ② 开机自启 = 独立显式开关：设置页 Toggle + 托盘 checkbox 两条入口都只走
//      /v1/maintenance/autostart（装/卸启动文件夹的 VBS），与退出路径互不相干。
//   ③ 控制台关闭按钮 = 收进后台（preventDefault + hide），不是退出。
//
// Electron 主进程（overlay/console 的 .cjs）无法在 node --test 里直接 import，
// 这里用源码契约扫描锁定关键标记；标记都取自本仓库自己写的行，改文案时同步改测试。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('quit: 退出走 /shutdown 干净停止，且不动开机自启（本次退出）', () => {
  const src = read('overlay/main.cjs')
  const quitDock = src.slice(src.indexOf('async function quitDock'), src.indexOf('function buildMenu'))
  assert.ok(quitDock.includes("'/shutdown'"), 'quitDock 必须调 daemon /shutdown（退出码 0，watchdog 不复活）')
  // 退出路径不得触碰自启：不装/卸启动器、不写 autoStart
  assert.equal(quitDock.includes('uninstallLauncher'), false, '退出不得卸载开机自启启动器')
  assert.equal(quitDock.includes('installLauncher'), false, '退出不得安装开机自启启动器')
  assert.equal(/autoStart/i.test(quitDock), false, '退出不得改 autoStart 设置')
  // 托盘文案区分两者：退出项带「本次」，自启是独立 checkbox
  const menu = src.slice(src.indexOf('function buildMenu'), src.indexOf('function refreshTray'))
  assert.ok(menu.includes('退出 fox-dock（本次退出）'), '托盘退出项文案要标明「本次退出」')
  assert.ok(menu.includes("'开机自启'"), '托盘必须保留独立的「开机自启」开关')
})

test('quit: 宠物层菜单退出项同款语义与文案（与托盘一致）', () => {
  const src = read('overlay/pet.js')
  assert.ok(src.includes("'退出 fox-dock（本次退出）'"), '宠物菜单退出项文案要与托盘统一为「（本次退出）」')
})

test('quit: 控制台关闭按钮收进后台，不是退出', () => {
  const src = read('console/main.cjs')
  const close = src.slice(src.indexOf("win.on('close'"), src.indexOf("win.on('closed'"))
  assert.ok(close.includes('preventDefault'), '关闭按钮必须 preventDefault（收进后台）')
  assert.ok(close.includes('win.hide()'), '关闭按钮必须 hide（托盘/热键可再次打开）')
  assert.equal(close.includes('/shutdown'), false, '控制台关闭不得停止 daemon')
})

test('quit: 设置页「开机自启」hint 说清与退出的区别（独立显式开关）', () => {
  const src = read('ui/pages/settings.mjs')
  const hint = '退出 fox-dock 只是本次退出，不影响本开关'
  assert.ok(src.includes(hint), '设置页 hint 必须包含：' + hint)
  // 开关走 autostart 维护端点，与退出路径（/shutdown）分离
  assert.ok(src.includes('/v1/maintenance/autostart'), '自启开关必须走 /v1/maintenance/autostart')
})
