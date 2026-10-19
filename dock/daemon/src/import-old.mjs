// 旧挂件数据导入（M7）：只读源目录，按类别复制进 dock 数据目录。
//
// 支持的源：ZCode 线 ~/.zcode/whale、WorkBuddy 线 ~/.workbuddy/plugins/data/fox-widget-fox-local，
// 以及 FOX_DOCK_IMPORT_DIRS（分号分隔）手工指定。所有写操作只发生在 dock 数据目录；
// 源文件 mtime 不变（测试会断言）。
//
// 厂商 API Key 不在本导入范围内：真实密钥必须走控制台「从宿主导入」进 DPAPI
// 保险库，避免在 dock 数据目录产生明文副本。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectPng } from './roles.mjs'

export const CATEGORIES = [
  { id: 'roles', label: '角色立绘与名字' },
  { id: 'bubbleTemplates', label: '气泡模板' },
  { id: 'bubbleContent', label: '按压泡泡队列' },
  { id: 'ledger', label: '用量账本' },
  { id: 'widgetState', label: '外观与提醒' },
]

export function defaultSources(env = process.env) {
  const home = os.homedir()
  const list = [
    { id: 'zcode', label: 'ZCode 挂件', dir: path.join(env.ZCODE_HOME || path.join(home, '.zcode'), 'whale') },
    { id: 'workbuddy', label: 'WorkBuddy 挂件', dir: path.join(home, '.workbuddy', 'plugins', 'data', 'fox-widget-fox-local') },
  ]
  for (const extra of String(env.FOX_DOCK_IMPORT_DIRS || '').split(';')) {
    if (extra.trim()) list.push({ id: 'custom-' + list.length, label: extra.trim(), dir: extra.trim() })
  }
  return list
}

function readJson(file, fallback = null) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? v : fallback
  } catch (err) {
    return fallback
  }
}

export function inspectSources(env = process.env) {
  const out = []
  for (const src of defaultSources(env)) {
    const dir = path.resolve(src.dir)
    const caps = {}
    try {
      if (fs.statSync(dir).isDirectory()) {
        const rolesDir = path.join(dir, 'roles')
        let roles = 0
        try {
          roles = fs.readdirSync(rolesDir).filter((n) => /\.png$/i.test(n)).length
        } catch (err) {}
        if (roles) caps.roles = roles
        for (const [id, file] of [
          ['bubbleTemplates', 'bubble-templates.json'],
          ['bubbleContent', 'bubble-content.json'],
          ['ledger', 'usage-ledger.json'],
          ['widgetState', 'widget-state.json'],
        ]) {
          if (fs.existsSync(path.join(dir, file))) caps[id] = 1
        }
      }
    } catch (err) {}
    if (Object.keys(caps).length) out.push({ ...src, dir, categories: caps })
  }
  return out
}

function copyIfMissing(src, dest) {
  if (fs.existsSync(dest)) return false
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  return true
}

function importRoles(srcDir, paths) {
  const sourceRoles = path.join(srcDir, 'roles')
  const index = readJson(path.join(srcDir, 'roles.json'), { roles: {} })
  let count = 0
  let skipped = 0
  let names = []
  try {
    names = fs.readdirSync(sourceRoles)
  } catch (err) {
    return { count, skipped }
  }
  fs.mkdirSync(paths.rolesDir, { recursive: true })
  const destIndexFile = path.join(paths.dir, 'roles.json')
  const destIndex = readJson(destIndexFile, { version: 1, roles: {} })
  for (const name of names) {
    if (!/^[a-z0-9-]{2,24}\.png$/i.test(name)) {
      skipped++
      continue
    }
    const id = name.replace(/\.png$/i, '')
    if (['fox', 'whale', 'gpt', 'kimi', 'xiaoke', 'gemini'].includes(id)) {
      skipped++
      continue
    }
    const target = path.join(paths.rolesDir, id + '.png')
    if (fs.existsSync(target)) {
      skipped++
      continue
    }
    try {
      const buffer = fs.readFileSync(path.join(sourceRoles, name))
      inspectPng(buffer)
      fs.writeFileSync(target, buffer)
      destIndex.roles[id] = {
        name: String((index.roles && index.roles[id] && index.roles[id].name) || id).slice(0, 24),
        at: Date.now(),
      }
      count++
    } catch (err) {
      skipped++
    }
  }
  if (count) {
    const tmp = destIndexFile + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(destIndex, null, 2))
    fs.renameSync(tmp, destIndexFile)
  }
  return { count, skipped }
}

function mergeTemplates(srcDir, paths) {
  const src = readJson(path.join(srcDir, 'bubble-templates.json'), null)
  if (!src) return { count: 0, skipped: 1 }
  const list = Array.isArray(src) ? src : Array.isArray(src.templates) ? src.templates : []
  const destFile = path.join(paths.dir, 'bubble-templates.json')
  const dest = readJson(destFile, [])
  const existing = new Set((Array.isArray(dest) ? dest : []).map((x) => JSON.stringify(x)))
  let count = 0
  for (const item of list.slice(0, 50)) {
    const key = JSON.stringify(item)
    if (existing.has(key)) continue
    existing.add(key)
    count++
  }
  const merged = [...(Array.isArray(dest) ? dest : []), ...list.filter((x) => !(Array.isArray(dest) ? dest : []).some((d) => JSON.stringify(d) === JSON.stringify(x)))].slice(0, 50)
  if (count) fs.writeFileSync(destFile, JSON.stringify(merged, null, 2))
  return { count, skipped: 0 }
}

function mergeLedger(srcDir, paths) {
  const src = readJson(path.join(srcDir, 'usage-ledger.json'), null)
  if (!src || !src.days) return { count: 0, skipped: 1 }
  const destFile = paths.ledger
  const dest = readJson(destFile, { days: {} })
  if (!dest.days) dest.days = {}
  let count = 0
  for (const [day, rows] of Object.entries(src.days)) {
    if (!dest.days[day]) {
      dest.days[day] = rows
      count++
      continue
    }
    for (const [adapter, row] of Object.entries(rows || {})) {
      const cur = dest.days[day][adapter]
      if (!cur || (Number(row.at) || 0) > (Number(cur.at) || 0)) {
        dest.days[day][adapter] = row
        count++
      }
    }
  }
  if (count) fs.writeFileSync(destFile, JSON.stringify(dest, null, 2))
  return { count, skipped: 0 }
}

function importWidgetState(srcDir) {
  const state = readJson(path.join(srcDir, 'widget-state.json'), null)
  if (!state) return { patch: null, count: 0 }
  const patch = {}
  for (const key of ['scale', 'sound', 'soundEnabled', 'vol', 'soundVolume', 'petMode', 'scrollGapOn', 'scrollGapPx']) {
    if (state[key] !== undefined) patch[key] = state[key]
  }
  if (state.alerts && typeof state.alerts === 'object') {
    patch.quotaWarnPct = Number(state.alerts.quotaPct) || undefined
    patch.balanceWarnMoney = Number(state.alerts.moneyAlert) || undefined
    patch.budgetMoney = Number(state.alerts.budgetToday) || undefined
  }
  return { patch, count: Object.keys(patch).length }
}

// 返回 { summary: { category: {count, skipped} }, settingsPatch }
export function importCategories({ source, categories, paths, env = process.env }) {
  const src = defaultSources(env).find((s) => s.id === source)
  if (!src) throw new Error('未知来源')
  const dir = path.resolve(src.dir)
  if (!fs.existsSync(dir)) throw new Error('来源目录不存在')
  const want = new Set(Array.isArray(categories) ? categories : [])
  const summary = {}
  let settingsPatch = null
  if (want.has('roles')) summary.roles = importRoles(dir, paths)
  if (want.has('bubbleTemplates')) summary.bubbleTemplates = mergeTemplates(dir, paths)
  if (want.has('bubbleContent')) {
    const ok = copyIfMissing(path.join(dir, 'bubble-content.json'), path.join(paths.dir, 'bubble-content.json'))
    summary.bubbleContent = { count: ok ? 1 : 0, skipped: ok ? 0 : 1 }
  }
  if (want.has('ledger')) summary.ledger = mergeLedger(dir, paths)
  if (want.has('widgetState')) {
    const r = importWidgetState(dir)
    settingsPatch = r.patch
    summary.widgetState = { count: r.count, skipped: r.count ? 0 : 1 }
  }
  return { summary, settingsPatch }
}
