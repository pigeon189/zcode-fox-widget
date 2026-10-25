import { h } from '../vendor/preact.module.js'
import { useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, ProgressBar, Segmented, Select, SourceTag } from '../components/base.mjs'
import { agentName, fmtDateTime, fmtMoney, fmtPct, fmtTokens, pctTone, fmtReset, remainText, usedPctOf } from '../lib/format.mjs'

const html = htm.bind(h)

const FILTERS = [
  { value: 'configured', label: '已配置' },
  { value: 'all', label: '全部' },
  { value: 'error', label: '异常' },
]
const SORTS = [
  { value: 'balance', label: '按余额' },
  { value: 'name', label: '按名称' },
  { value: 'usage', label: '按用量' },
]

function windowsOf(v) {
  if (v.kind === 'cmdgo') {
    const out = []
    // 并列顺序：5 小时 → 本周 → 月度池（与旧挂件一致）。
    if (v.fiveHour) {
      out.push({
        label: '5 小时',
        usedPct: Number(v.fiveHour.percent) * 100,
        remaining: v.fiveHour.remaining,
        total: v.fiveHour.cap,
        resetAt: v.fiveHour.resetAt,
      })
    }
    if (v.weekly) {
      out.push({
        label: '本周',
        usedPct: Number(v.weekly.percent) * 100,
        remaining: v.weekly.remaining,
        total: v.weekly.cap,
        resetAt: v.weekly.resetAt,
      })
    }
    if (v.monthly) {
      out.push({
        label: '月度池',
        usedPct: Number(v.monthly.percent) * 100,
        remaining: v.monthly.remaining,
        total: v.monthly.total,
        resetAt: v.monthly.resetAt,
      })
    }
    return out.filter((w) => Number.isFinite(w.usedPct))
  }
  return (Array.isArray(v.windows) ? v.windows : [])
    .map((w) => {
      const raw = w.percentUsed != null ? Number(w.percentUsed) : w.percent != null ? Number(w.percent) : null
      const usedPct = raw == null ? null : w.percentUsed != null ? raw : usedPctOf(raw)
      return { label: w.label || '窗口', usedPct, remaining: w.remaining, total: w.total, resetAt: w.resetAt }
    })
    .filter((w) => Number.isFinite(w.usedPct))
}

// 本地品牌图（官方 favicon / Simple Icons），没有图时退回首字母。
const VENDOR_LOGOS = {
  deepseek: 'assets/vendors/deepseek.svg',
  'xiaomi-mimo': 'assets/vendors/xiaomi.svg',
  'xiaomi-mimo-plan': 'assets/vendors/xiaomi.svg',
  commandcode: 'assets/vendors/commandcode.ico',
  'zcode-plan': 'assets/vendors/bigmodel.png',
  'bigmodel-glm': 'assets/vendors/bigmodel.png',
  'zhipu-quota': 'assets/vendors/bigmodel.png',
  'zhipu-coding-intl': 'assets/vendors/bigmodel.png',
  'moonshot-cn': 'assets/vendors/moonshot.svg',
  'moonshot-intl': 'assets/vendors/moonshot.svg',
  'kimi-coding': 'assets/vendors/moonshot.svg',
  'minimax-coding': 'assets/vendors/minimax.svg',
  'minimax-coding-intl': 'assets/vendors/minimax.svg',
  'opencode-go': 'assets/vendors/opencode.svg',
  openrouter: 'assets/vendors/openrouter.svg',
  anthropic: 'assets/vendors/anthropic.svg',
  gemini: 'assets/vendors/gemini.svg',
  'gemini-plan': 'assets/vendors/gemini.svg',
  mistral: 'assets/vendors/mistral.svg',
  groq: 'assets/vendors/groq.ico',
  fireworks: 'assets/vendors/fireworks.ico',
  deepinfra: 'assets/vendors/deepinfra.ico',
  'siliconflow-cn': 'assets/vendors/siliconflow.png',
  'siliconflow-en': 'assets/vendors/siliconflow.png',
  'volcengine-ark': '',
  'volc-plan': '',
  dashscope: 'assets/vendors/qwen.svg',
  qianfan: 'assets/vendors/baidu.svg',
  modelscope: 'assets/vendors/modelscope.ico',
  ollama: 'assets/vendors/ollama.svg',
  stepfun: '',
}

// 余额构成（D2 / P0-4）：赠金与充值余额各自独立，缺失一侧保持隐藏（不补 0）。
// 两侧都为 null 时返回空串，调用方整行不渲染。
function balanceSplitText(granted, topped, currency) {
  const amount = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null)
  const g = amount(granted)
  const t = amount(topped)
  if (g === null && t === null) return ''
  const cur = currency || 'CNY'
  const parts = []
  if (t !== null) parts.push('充值 ' + fmtMoney(t, cur))
  if (g !== null) parts.push('赠送 ' + fmtMoney(g, cur))
  return parts.join(' · ')
}

function VendorCard({ v, onCorrect }) {
  const color =
    v.kind === 'relay'
      ? 'var(--vendor-relay)'
      : v.kind === 'local-log' || v.kind === 'volc'
        ? 'var(--vendor-plan)'
        : v.kind === 'cmdgo'
          ? 'var(--vendor-prepaid)'
          : 'var(--text-3)'
  const logo = VENDOR_LOGOS[v.id] || ''
  // 人工校正会改变总额但不会改赠金/充值拆分，此时隐藏构成行，避免总额与两段对不上。
  const split = v.corrections && v.corrections.count > 0 ? '' : balanceSplitText(v.grantedBalance, v.toppedBalance, v.currency)
  const windows = windowsOf(v)
  const value =
    v.kind === 'tokens'
      ? '—'
      : v.kind === 'volc'
        ? // 订阅卡主数值：取最紧窗口（已用百分比最高）的剩余；两套餐都没窗口时按
          // 不可得显示 '—'（reason 行会解释缺什么，不编满额）
          windows.length
          ? remainText(Math.max(...windows.map((w) => Number(w.usedPct) || 0)))
          : '—'
        : v.kind === 'cmdgo' && v.monthly && v.monthly.remaining != null
          ? fmtMoney(v.monthly.remaining, v.currency || 'USD')
          : v.kind === 'cmdgo' && v.monthly
            ? remainText(Number(v.monthly.percent) * 100)
            : v.percentRemaining != null
              ? fmtPct(v.percentRemaining) + ' 剩余'
              : v.balance != null
                ? fmtMoney(v.balance, v.currency || 'USD')
                : v.available
                  ? '接口可用'
                  : '—'
  const kindText =
    v.kind === 'relay'
      ? '中转站'
      : v.kind === 'local-log'
        ? '订阅套餐'
        : v.kind === 'volc'
          ? '订阅窗口'
          : v.kind === 'cmdgo'
            ? 'CommandCode'
            : v.kind === 'balance'
              ? '余额接口'
              : v.kind === 'quota'
                ? '额度接口'
                : v.kind === 'tokens'
                  ? '仅计价（无余额接口）'
                  : '模板'
  return html`<div class="card vendor-card" data-testid=${'quota.vendor.' + v.id}>
    <div class="vendor-head">
      <div class=${'vendor-avatar' + (logo ? ' has-logo' : '')} style=${{ background: logo ? 'var(--surface)' : color }}>
        ${logo ? html`<img src=${logo} alt="" loading="lazy" />` : String(v.name || '?').slice(0, 1)}
      </div>
      <div style=${{ minWidth: 0, flex: 1 }}>
        <div class="row"><span class="vendor-card-name" style=${{ fontWeight: 600 }} title=${v.name}>${v.name}</span><span class="spacer"></span>
          ${v.configured ? html`<${Badge} tone="ok">已配置</${Badge}>` : html`<${Badge} tone="neutral">未配置</${Badge}>`}
        </div>
        <div class="small muted truncate" title=${kindText}>${kindText}${v.planName || (v.kind === 'local-log' ? v.name : '') ? ' · ' + (v.planName || v.name) : ''}${v.account ? ' · ' + v.account : ''}</div>
      </div>
    </div>
    <div class="row" style=${{ alignItems: 'baseline' }}>
      <span class="num" style=${{ fontSize: 20, fontWeight: 700 }}>${value}</span>
      ${v.prov ? html`<${SourceTag} prov=${v.prov} variant="dot" />` : null}
      ${v.monthly && v.monthly.total != null ? html`<span class="small muted">/ ${fmtMoney(v.monthly.total, v.currency || 'USD')}</span>` : null}
      ${v.todayUsage != null ? html`<span class="small muted">今日 ${fmtMoney(v.todayUsage, v.currency || 'CNY')}</span>` : null}
      ${v.kind === 'cmdgo' && v.pool ? html`<span class="small muted">池 ${v.pool.available}/${v.pool.total} 可用</span>` : null}
    </div>
    ${split ? html`<div class="balance-split" data-testid=${'quota.balanceSplit.' + v.id}>${split}</div>` : null}
    ${Array.isArray(v.byModel) && v.byModel.length
      ? html`<div style=${{ marginTop: 8 }} data-testid=${'quota.byModel.' + v.id}>
          ${v.byModel.map((b) => {
            const pct = Number(b.totalUnits) > 0 ? (Number(b.remainingUnits) / Number(b.totalUnits)) * 100 : null
            return html`<div class="row small" key=${b.model} style=${{ gap: 8 }}>
              <span>${b.showName || b.model}</span>
              <span class="spacer"></span>
              <span class="num">${pct != null ? fmtPct(pct) + ' 剩余' : '—'}</span>
              <span class="small muted num">${fmtTokens(b.remainingUnits)} / ${fmtTokens(b.totalUnits)}</span>
            </div>`
          })}
        </div>`
      : null}
    ${windows.map((w) => html`<div style=${{ marginTop: 6 }}>
      <div class="row small">
        <span>${w.label}</span>
        <span class="spacer"></span>
        <span class="num">${remainText(w.usedPct)}</span>
        <span class="muted" data-visual-mask style=${{ width: 96, textAlign: 'right' }}>${w.resetAt ? fmtReset(w.resetAt) + '重置' : ''}</span>
      </div>
      <${ProgressBar} pct=${w.usedPct} tone=${pctTone(w.usedPct)} label=${w.label + ' 已用'} />
    </div>`)}
    ${v.reason ? html`<div class="small muted truncate" title=${v.reason}>${v.reason}</div>` : null}
    <div class="row small muted">
      <span>${v.keyMasked || (v.keySource && v.keySource !== 'none' ? v.keySource : '')}</span>
      <span class="spacer"></span>
      ${v.balance != null ? html`<${Button} variant="ghost" onClick=${() => onCorrect(v)}>校正</${Button}>` : null}
    </div>
    ${v.corrections ? html`<div class="small muted">已校正 ${v.corrections.count} 次 · 最近 ${fmtDateTime(v.corrections.lastAt)}</div>` : null}
  </div>`
}

function resetCell(v, now) {
  if (!v) return '—'
  const ms = typeof v === 'number' ? v : Date.parse(String(v))
  if (!Number.isFinite(ms) || ms <= now) return '—'
  const diff = ms - now
  if (diff <= 24 * 3600_000) {
    const h = Math.floor(diff / 3600_000)
    const m = Math.ceil((diff % 3600_000) / 60000)
    return h ? h + ' 小时 ' + m + ' 分后' : m + ' 分后'
  }
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function windowOfLabel(windows, re) {
  return (windows || []).find((w) => re.test(String(w.label || ''))) || null
}

export function QuotaPage({ app }) {
  const vendors = app.vendors
  const [view, setView] = useState('cards')
  const [filter, setFilter] = useState('configured')
  const [sort, setSort] = useState('balance')
  const [correcting, setCorrecting] = useState(null)
  const [type, setType] = useState('add')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const snap = app.snapshots[app.viewAgent]
  const card = snap && snap.quotaCard
  const windows = (card && card.windows) || []
  // 快照里的余额构成只用于顶部余额卡；被人工校正过的厂商不再展示拆分。
  const splitOwner = (vendors || []).find((v) => v.id === (card && card.source))
  const snapshotSplit =
    snap && snap.balanceSplit && !(splitOwner && splitOwner.corrections && splitOwner.corrections.count > 0)
      ? balanceSplitText(
          snap.balanceSplit.granted,
          snap.balanceSplit.topped,
          snap.balanceSplit.currency || (card && card.balance && card.balance.currency)
        )
      : ''
  const balanceProv = snap && snap.provenance && snap.provenance.balance
  const list = (vendors || [])
    .filter((v) => (filter === 'all' ? true : filter === 'configured' ? v.configured : !v.available && v.configured))
    .sort((a, b) => {
      if (sort === 'name') return String(a.name).localeCompare(String(b.name), 'zh-CN')
      if (sort === 'usage') return (b.todayUsage || 0) - (a.todayUsage || 0)
      const av = a.kind === 'cmdgo' && a.monthly ? a.monthly.remaining : a.balance || a.remaining || 0
      const bv = b.kind === 'cmdgo' && b.monthly ? b.monthly.remaining : b.balance || b.remaining || 0
      return (bv || 0) - (av || 0)
    })
  const unconfigured = (vendors || []).filter((v) => !v.configured)

  async function submitCorrection() {
    if (!correcting) return
    const n = Number(amount)
    if (!Number.isFinite(n) || n < 0) return app.toast('金额不合法', 'bad')
    setBusy(true)
    try {
      await app.api('/v1/vendors/' + encodeURIComponent(correcting.id) + '/corrections', {
        method: 'POST',
        body: { type, amount: n, currency: correcting.currency || 'CNY', note },
      })
      app.toast('已记录余额校正')
      setCorrecting(null)
      setAmount('')
      setNote('')
      await app.reloadVendors(true)
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
    } finally {
      setBusy(false)
    }
  }

  return html`<div data-testid="page.quota">
    <div class="card" style=${{ marginBottom: 16 }}>
      <div class="card-head"><span class="card-title">${agentName(app.viewAgent)} 的额度</span><span class="spacer"></span>
        ${snap ? html`<span class="small muted">${snap.capturedAt ? fmtDateTime(snap.capturedAt) : ''}</span>` : null}
      </div>
      ${!card
        ? html`<${EmptyState} icon="gauge" title="该宿主没有额度数据" hint="适配器未提供 quotaCard" />`
        : card.kind === 'windows'
          ? windows.length === 1
            ? html`<div class="row" style=${{ alignItems: 'baseline', gap: 12 }}>
                <span class="num" style=${{ fontSize: 40, fontWeight: 700 }}>${fmtPct(windows[0].remainingPct)}</span>
                <span class="muted">剩余 · ${windows[0].label}${windows[0].resetAt ? ' · ' + fmtReset(windows[0].resetAt) + '重置' : ''}</span>
              </div>`
            : windows.map(
                (w) => html`<div style=${{ marginBottom: 14 }}>
                  <div class="row"><span>${w.label}</span><span class="spacer"></span><span class="num">${fmtPct(w.remainingPct)} 剩余</span><span class="small muted" style=${{ width: 120, textAlign: 'right' }}>${fmtReset(w.resetAt)}</span></div>
                  <${ProgressBar} pct=${w.usedPct} tone=${pctTone(w.usedPct)} label=${w.label + ' 已用'} />
                </div>`
              )
          : card.kind === 'balance'
            ? html`<div>
                <div class="row" style=${{ alignItems: 'baseline', gap: 12 }}>
                  <span class="num" style=${{ fontSize: 32, fontWeight: 700 }}>${card.balance ? fmtMoney(card.balance.amount, card.balance.currency) : '—'}</span>
                  <span class="muted">余额</span>
                  ${balanceProv ? html`<${SourceTag} prov=${balanceProv} variant="full" />` : null}
                </div>
                ${snapshotSplit ? html`<div class="balance-split" data-testid="quota.balanceSplit">${snapshotSplit}</div>` : null}
              </div>`
            : card.kind === 'error'
              ? html`<div class="alert-bar bad">${card.message || '额度读取失败'}</div>`
              : html`<div class="row" style=${{ gap: 12 }}>
                  <${Badge} tone="neutral">${card.plan || '套餐'}</${Badge}>
                  <span class="muted">${card.note || '没有可读的套餐额度窗口'}</span>
                </div>`}
      ${card && card.note && card.kind !== 'plan' ? html`<div class="small muted" style=${{ marginTop: 8 }}>${card.note}</div>` : null}
    </div>

    <div class="row wrap" style=${{ marginBottom: 12 }}>
      <${Segmented} value=${filter} options=${FILTERS} onChange=${setFilter} />
      <${Segmented} value=${view} options=${[{ value: 'cards', label: '卡片' }, { value: 'matrix', label: '矩阵' }]} onChange=${setView} label="视图" />
      <${Select} aria-label="排序" value=${sort} options=${SORTS} onChange=${setSort} />
      <span class="spacer"></span>
      <span class="small muted">未配置模板 ${unconfigured.length} 个</span>
    </div>

    ${!vendors
      ? html`<div class="card"><div class="skeleton" style=${{ height: 200 }}></div></div>`
      : view === 'matrix'
        ? html`<div class="matrix-wrap"><table class="quota-matrix">
            <thead><tr><th>厂商</th><th class="right" style=${{ width: 112 }}>余额</th><th style=${{ width: 120 }}>5 小时窗</th><th style=${{ width: 120 }}>周窗</th><th style=${{ width: 120 }}>月窗</th><th style=${{ width: 112 }}>重置于</th><th style=${{ width: 88 }}>来源</th></tr></thead>
            <tbody>
              ${list.map((v) => {
                const windows = windowsOf(v)
                const base = (label, re) => {
                  const w = windowOfLabel(windows, re)
                  if (!w) return html`<td class="win-cell" aria-label="无此窗口"><span class="small muted">—</span></td>`
                  return html`<td class="win-cell"><div class="row small"><span class="num">${Math.round((Number(w.usedPct) || 0))}%</span></div>
                    <${ProgressBar} pct=${w.usedPct} tone=${pctTone(w.usedPct)} label=${w.label + ' 已用'} /></td>`
                }
                const five = base('5h', /5\s*小时|five|5h/i)
                const week = base('week', /周|week/i)
                const month = base('month', /月|month/i)
                const win = windowOfLabel(windows, /5\s*小时|five|5h/i) || windowOfLabel(windows, /周|week/i) || windowOfLabel(windows, /月|month/i) || {}
                // 来源只认 daemon 给的 v.prov（按 kind 真实映射）；老 daemon / 夹具
                // 没带 prov 时显示「未声明」，不按 available 布尔编造 exact/api，
                // 也不用渲染时刻冒充读取时间。
                return html`<tr>
                  <td><div class="row"><span class="vendor-mini-dot" style=${{ background: v.available ? 'var(--ok)' : 'var(--text-3)' }}></span>${v.name}</div></td>
                  <td class="right num">${v.balance != null ? fmtMoney(v.balance, v.currency || 'CNY') : v.percentRemaining != null ? fmtPct(v.percentRemaining) + ' 剩余' : v.kind === 'cmdgo' && v.monthly && v.monthly.remaining != null ? fmtMoney(v.monthly.remaining, v.currency || 'USD') : '—'}</td>
                  ${five}${week}${month}
                  <td class="small muted" data-visual-mask>${resetCell(win.resetAt, Date.now())}</td>
                  <td>${v.prov ? html`<${SourceTag} prov=${v.prov} variant="full" />` : html`<span class="small muted">未声明</span>`}</td>
                </tr>`
              })}
            </tbody>
          </table></div>`
        : list.length
          ? html`<div class="vendor-grid">${list.map((v) => html`<${VendorCard} v=${v} onCorrect=${(x) => { setCorrecting(x); setType('add'); setAmount(''); setNote('') }} />`)}</div>`
          : html`<${Card}><${EmptyState} title="没有符合筛选的厂商" hint="切换到「全部」查看所有模板" /></${Card}>`}

    ${correcting
      ? html`<${Dialog} title=${'余额校正 · ' + correcting.name} onClose=${() => setCorrecting(null)}
          actions=${html`<${Button} onClick=${() => setCorrecting(null)}>取消</${Button}><${Button} variant="primary" onClick=${submitCorrection} loading=${busy}>记录</${Button}>`}>
          <div style=${{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <${Field} label="类型">
              <${Select} aria-label="校正类型" value=${type} options=${[
                { value: 'add', label: '充值 / 赠金入账（加）' },
                { value: 'subtract', label: '到账扣减（减）' },
                { value: 'set', label: '设为指定余额' },
              ]} onChange=${setType} />
            </${Field}>
            <${Field} label="金额" hint=${'币种：' + (correcting.currency || 'CNY')}>
              <${Input} type="number" aria-label="校正金额" value=${amount} onInput=${setAmount} />
            </${Field}>
            <${Field} label="备注" hint="可选，最多 120 字">
              <${Input} aria-label="校正备注" value=${note} onInput=${setNote} />
            </${Field}>
            <div class="small muted">只记录人工修正，不改宿主数据；展示时按时间顺序作用在当前余额上。</div>
          </div>
        </${Dialog}>`
      : null}
  </div>`
}
