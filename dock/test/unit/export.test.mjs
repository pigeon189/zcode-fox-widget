// M4 导出：BOM / CRLF / 转义 / 公式注入 / JSON / 文件名
import assert from 'node:assert/strict'
import test from 'node:test'
import { CSV_COLUMNS, filenameFor, toCsv, toJson } from '../../ui/lib/export.mjs'

const row = (over = {}) => ({
  date: '2026-10-21',
  agentId: 'zcode',
  sessionId: 'abcdef123456',
  model: 'deepseek-flash',
  vendorLabel: 'DeepSeek',
  tool: '',
  unit: 'money',
  currency: 'CNY',
  amount: 1.23456,
  credits: null,
  tokens: 100,
  calls: 1,
  errors: 0,
  prov: { kind: 'estimated', origin: 'pricing-table', source: 'pricing:2026-10 deepseek' },
  ...over,
})

test('export: CSV 带 BOM、CRLF、固定表头与 4 位小数', () => {
  const csv = toCsv([row()])
  assert.equal(csv.charCodeAt(0), 0xfeff)
  assert.ok(csv.includes('\r\n'))
  const lines = csv.replace(/^\ufeff/, '').split('\r\n')
  assert.equal(lines[0], CSV_COLUMNS.join(','))
  assert.ok(lines[1].includes('1.2346'))
  assert.ok(lines[1].includes('"2026-10-21"') || lines[1].startsWith('2026-10-21,'))
})

test('export: 公式注入被前缀单引号', () => {
  const csv = toCsv([
    row({ model: '=1+1' }),
    row({ model: '+cmd|\' /C calc\'!A0' }),
    row({ model: '@SUM(A1)' }),
    row({ model: '\tTAB' }),
    row({ model: '-2+3' }),
  ])
  const lines = csv.replace(/^\ufeff/, '').split('\r\n')
  for (const line of lines.slice(1, 6)) {
    assert.ok(line.includes("'=") || line.includes("'+") || line.includes("'@") || line.includes("'\t") || line.includes("'-"), line)
  }
})

test('export: 含逗号/引号/换行的字段被正确包裹与转义', () => {
  const csv = toCsv([row({ vendorLabel: 'a,b', model: 'x"y', tool: 'line1\nline2' })])
  assert.ok(csv.includes('"a,b"'))
  assert.ok(csv.includes('"x""y"'))
  assert.ok(csv.includes('"line1\nline2"'))
})

test('export: 中文/emoji/超长字段/空值', () => {
  const csv = toCsv([row({ vendorLabel: '深度求索🚀', model: 'm'.repeat(500), tokens: null })])
  assert.ok(csv.includes('深度求索🚀'))
  assert.ok(csv.includes('m'.repeat(500)))
})

test('export: JSON 元信息含估算声明与固定结构', () => {
  const text = toJson({ meta: { range: { from: '2026-10-01', to: '2026-10-21' }, by: 'model' }, rows: [row()], total: { amount: 1.2346 }, provenance: { amount: { kind: 'estimated' } } })
  const json = JSON.parse(text)
  assert.equal(json.meta.by, 'model')
  assert.ok(json.meta.generatedAt)
  assert.ok(json.meta.notes.some((n) => n.includes('估算')))
  assert.equal(json.rows.length, 1)
  assert.equal(json.total.amount, 1.2346)
})

test('export: 文件名清洗路径穿越与非法字符', () => {
  assert.equal(filenameFor({ from: '../../etc', to: '2026-10-21', by: 'model', ext: 'csv' }), 'fox-dock-usage_etc_2026-10-21_model.csv')
  assert.equal(filenameFor({ from: '2026-10-01', to: '2026-10-21', by: 'nope', ext: 'exe' }), 'fox-dock-usage_2026-10-01_2026-10-21_agent.csv')
  assert.ok(!filenameFor({ from: '../a/b', to: 'x' }).includes('/'))
})
