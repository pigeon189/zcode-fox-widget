// 余额校正（D030）：赠金充值 / 到账扣减 / 手动设为某值。
//
// 只记录「人对余额的修正」，不改宿主数据。展示时把修正按时间顺序作用在
// 宿主读到的余额上：add / subtract / set。单位与币种不混算，只对同币种生效。
//
// 文件：{ version: 1, items: [{ id, vendorId, type, amount, currency, note, at }] }

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ADJUSTMENT_TYPES = ['add', 'subtract', 'set']
const MAX_ITEMS = 500

function read(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object' && Array.isArray(raw.items)) return raw
  } catch (err) {}
  return { version: 1, items: [] }
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

export function listAdjustments(file, vendorId = '') {
  const data = read(file)
  const items = vendorId ? data.items.filter((x) => x.vendorId === vendorId) : data.items
  return items.slice().sort((a, b) => b.at - a.at)
}

export function addAdjustment(file, { vendorId, type, amount, currency, note }) {
  const id = String(vendorId || '').trim()
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error('vendorId 不合法')
  if (!ADJUSTMENT_TYPES.includes(String(type))) throw new Error('校正类型不合法')
  const n = Number(amount)
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new Error('金额不合法')
  const cur = /^[A-Z]{3,8}$/.test(String(currency || '')) ? String(currency) : 'CNY'
  const item = {
    id: crypto.randomUUID(),
    vendorId: id,
    type: String(type),
    amount: Math.round(n * 10000) / 10000,
    currency: cur,
    note: String(note || '').slice(0, 120),
    at: Date.now(),
  }
  const data = read(file)
  data.items.push(item)
  if (data.items.length > MAX_ITEMS) data.items = data.items.slice(-MAX_ITEMS)
  write(file, data)
  return item
}

export function removeAdjustment(file, id) {
  const data = read(file)
  const before = data.items.length
  data.items = data.items.filter((x) => x.id !== String(id || ''))
  if (data.items.length === before) return { removed: false }
  write(file, data)
  return { removed: true }
}

// 把修正作用到宿主余额上。只处理同币种；没有修正时原样返回。
export function applyAdjustments(base, items, currency) {
  if (base === null || base === undefined || !Number.isFinite(Number(base))) return base
  let value = Number(base)
  const cur = String(currency || 'CNY')
  const sorted = (items || []).slice().sort((a, b) => a.at - b.at)
  for (const item of sorted) {
    if (item.currency !== cur) continue
    if (item.type === 'add') value += Number(item.amount) || 0
    else if (item.type === 'subtract') value -= Number(item.amount) || 0
    else if (item.type === 'set') value = Number(item.amount) || 0
  }
  return Math.round(value * 10000) / 10000
}

export function adjustmentSummary(items, currency) {
  const list = (items || []).filter((x) => x.currency === currency)
  if (!list.length) return null
  return {
    count: list.length,
    lastAt: Math.max(...list.map((x) => Number(x.at) || 0)),
    items: list.slice(0, 20),
  }
}
