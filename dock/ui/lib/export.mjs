// M4 导出：CSV（BOM + CRLF + 公式注入防护）与 JSON。
//
// 文件名与内容都不含主目录路径：session 列只放会话标题或 id 前 8 位。

export const CSV_COLUMNS = [
  'date',
  'agent',
  'session',
  'model',
  'vendor',
  'tool',
  'unit',
  'currency',
  'amount',
  'credits',
  'tokens',
  'calls',
  'errors',
  'provenance_kind',
  'provenance_origin',
  'provenance_source',
]

const FORMULA_PREFIX = /^[=+\-@\t\r]/

function cell(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  let s = String(value)
  // 公式注入：文本单元以 = + - @ 制表符/回车开头时前缀单引号。
  if (FORMULA_PREFIX.test(s)) s = "'" + s
  return s
}

function quote(s) {
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function amountText(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return (Math.round(n * 10000) / 10000).toFixed(4)
}

function sessionLabel(row) {
  const title = String(row.sessionTitle || row.title || '').trim()
  if (title) return title.slice(0, 80)
  const id = String(row.sessionId || row.session || '')
  return id.slice(0, 8)
}

export function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')]
  for (const r of Array.isArray(rows) ? rows : []) {
    const prov = r.prov || r.provenance || {}
    const values = [
      cell(r.date || r.day || ''),
      cell(r.agent || r.agentId || ''),
      cell(sessionLabel(r)),
      cell(r.model || ''),
      cell(r.vendorLabel || r.vendor || ''),
      cell(r.tool || ''),
      cell(r.unit || ''),
      cell(r.currency || ''),
      amountText(r.amount),
      cell(r.credits == null ? '' : r.credits),
      cell(r.tokens == null ? '' : r.tokens),
      cell(r.calls == null ? '' : r.calls),
      cell(r.errors == null ? '' : r.errors),
      cell(prov.kind || ''),
      cell(prov.origin || ''),
      cell(prov.source || ''),
    ]
    lines.push(values.map(quote).join(','))
  }
  return '\ufeff' + lines.join('\r\n') + '\r\n'
}

export function toJson({ meta = {}, rows = [], total = null, provenance = null } = {}) {
  return JSON.stringify(
    {
      meta: {
        generatedAt: new Date().toISOString(),
        tz: (() => {
          try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
          } catch (err) {
            return 'local'
          }
        })(),
        appVersion: meta.appVersion || '',
        notes: [
          'estimated 行是按价目表折算的估算值，不是厂商账单。',
          ...(Array.isArray(meta.notes) ? meta.notes : []),
        ],
        ...meta,
      },
      rows: Array.isArray(rows) ? rows : [],
      total,
      provenance,
    },
    null,
    2
  )
}

export function filenameFor({ from = '', to = '', by = 'agent', ext = 'csv' } = {}) {
  const clean = (s) => String(s || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 24)
  const f = clean(from) || 'all'
  const t = clean(to) || 'now'
  const b = ['agent', 'model', 'vendor', 'tool', 'session'].includes(by) ? by : 'agent'
  const e = ext === 'json' ? 'json' : 'csv'
  return 'fox-dock-usage_' + f + '_' + t + '_' + b + '.' + e
}
