import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Button, Card, EmptyState } from '../components/base.mjs'
import { Wizard } from '../components/wizard.mjs'
import { fmtDateTime, fmtNum, fmtRelativeShort } from '../lib/format.mjs'

const html = htm.bind(h)

export function AboutPage({ app }) {
  const [diag, setDiag] = useState(null)
  const [diagLoading, setDiagLoading] = useState(true)
  const [diagError, setDiagError] = useState('')
  const [update, setUpdate] = useState(null)
  const [checking, setChecking] = useState(false)
  const [wizard, setWizard] = useState(false)

  useEffect(() => {
    let alive = true
    setDiagLoading(true)
    setDiagError('')
    app
      .api('/v1/diag/bundle')
      .then((d) => alive && setDiag(d))
      .catch((e) => {
        if (!alive) return
        // 失败时清掉旧诊断：不能让导出按钮拿上一份数据冒充当前状态。
        setDiag(null)
        setDiagError(String((e && e.message) || e || '诊断读取失败'))
      })
      .finally(() => alive && setDiagLoading(false))
    return () => {
      alive = false
    }
  }, [app.refreshAt])

  async function checkUpdate() {
    setChecking(true)
    try {
      const r = await app.api('/update/check?force=1')
      setUpdate(r)
      app.toast(r.ok ? (r.hasUpdate ? '发现新版本 ' + r.latest : '已是最新版本') : '检查失败：' + (r.error || r.reason), r.ok ? '' : 'bad')
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
    } finally {
      setChecking(false)
    }
  }

  const boot = app.boot || {}
  const runtime = (diag && diag.runtime) || {}
  const adapters = (diag && diag.adapters) || []
  const bindings = (diag && diag.bindings) || []

  return html`<div class="grid" data-testid="page.about">
    <div class="col-7">
      <${Card} title="版本">
        <div class="row wrap" style=${{ alignItems: 'baseline', gap: 10 }}>
          <span class="num nowrap" style=${{ fontSize: 24, fontWeight: 700 }}>fox-dock ${boot.version || ''}</span>
          <${Badge} tone="info">pre-release</${Badge}>
          <${Button} onClick=${() => setWizard(true)} data-testid="about.wizard">接入向导</${Button}>
          <${Button} onClick=${checkUpdate} loading=${checking} icon="refresh" style=${{ marginLeft: 'auto' }}>检查更新</${Button}>
        </div>
        <div class="small muted" style=${{ marginTop: 8 }}>
          ${update
            ? update.ok
              ? update.hasUpdate
                ? '发现 ' + update.latest + (update.notes ? '：' + update.notes : '')
                : '已是最新版本'
              : '检查失败：' + (update.error || update.reason)
            : '更新通道 dock-v*；默认不自动落盘'}
        </div>
        <div class="small muted">最近更新记录：${(diag && diag.update && diag.update.history && diag.update.history.length) || 0} 条</div>
      </${Card}>

      <${Card} title="适配器" class="group">
        <table class="table">
          <thead><tr><th>宿主</th><th>能力</th><th class="right">状态</th></tr></thead>
          <tbody>
            ${adapters.map(
              (a) => html`<tr>
                <td class="truncate" title=${a.name}>${a.name}</td>
                <td class="small muted" title=${[a.billing ? '计费' : '', a.context ? '上下文' : '', a.follow ? '跟随' : ''].filter(Boolean).join(' · ')}>
                  ${[a.billing ? '计费' : '', a.context ? '上下文' : '', a.follow ? '跟随' : ''].filter(Boolean).join(' · ')}
                </td>
                <td class="right"><${Badge} tone=${a.context ? 'ok' : 'neutral'}>${a.context ? '已接入' : '仅计费'}</${Badge}></td>
              </tr>`
            )}
          </tbody>
        </table>
      </${Card}>

      <${Card} title="接入诊断" class="group" actions=${html`<${Button} variant="ghost" icon="copy" onClick=${() => {
        const dir = diag && diag.ingest && diag.ingest.integrationDir
        if (!dir) return app.toast('没有找到集成目录', 'bad')
        navigator.clipboard.writeText(dir).then(() => app.toast('已复制集成目录路径')).catch(() => app.toast('复制失败', 'bad'))
      }}>复制集成目录路径</${Button}>`}>
        <table class="table">
          <thead><tr><th>Agent</th><th>数据源</th><th>实时通道</th><th class="right">最后事件</th><th class="right">状态</th></tr></thead>
          <tbody>
            ${adapters.filter((a) => a.id !== 'generic').map((a) => {
              const by = (app.live && app.live.byAgent && app.live.byAgent[a.id]) || null
              const lastAt = by && by.lastAt ? by.lastAt : 0
              const channel = a.id === 'zcode' ? '钩子' : a.id === 'workbuddy' || a.id === 'dsh' ? '日志尾随' : a.id === 'kimi' ? '本机 HTTP' : '无'
              const source = a.id === 'zcode' ? 'db.sqlite' : a.id === 'workbuddy' ? 'transcripts' : a.id === 'dsh' ? 'sessions (zstd)' : a.id === 'kimi' ? '/coding/v1/usages' : '—'
              const active = by && (by.working > 0 || by.waiting > 0)
              const stale = active && (!lastAt || Date.now() - lastAt > 30000)
              const status = !diag ? ['neutral', '未知'] : stale ? ['warn', '延迟'] : lastAt ? ['ok', '正常'] : ['neutral', '未接入']
              return html`<tr>
                <td>${a.name}</td>
                <td class="small muted mono">${source}</td>
                <td class="small">${channel}</td>
                <td class="right small muted" data-visual-mask>${lastAt ? fmtRelativeShort(lastAt) : '—'}</td>
                <td class="right"><${Badge} tone=${status[0]}>${status[1]}</${Badge}></td>
              </tr>`
            })}
          </tbody>
        </table>
      </${Card}>

      <${Card} title="绑定" class="group">
        ${bindings.length
          ? html`<table class="table"><thead><tr><th>适配器</th><th>窗口</th><th>时间</th></tr></thead>
              <tbody>${bindings.map((b) => html`<tr><td>${b.adapterId}</td><td class="ellipsis" title=${b.window?.title || ''}>${b.window?.title || '—'}</td><td class="small muted">${b.at ? fmtDateTime(b.at) : '—'}</td></tr>`)}</tbody>
            </table>`
          : html`<${EmptyState} title="还没有绑定记录" hint="把角色拖到 agent 窗口上" />`}
      </${Card}>
    </div>

    <div class="col-5">
      <${Card} title="运行信息">
        <div style=${{ display: 'flex', flexDirection: 'column', gap: 8 }} class="small">
          <div class="row"><span class="muted">daemon</span><span class="spacer"></span><span class="mono" data-visual-mask>:${runtime.port || '—'} · pid ${runtime.pid || '—'}</span></div>
          <div class="row"><span class="muted">运行时长</span><span class="spacer"></span><span class="mono" data-visual-mask>${runtime.uptimeSec != null ? fmtNum(runtime.uptimeSec) + 's' : '—'}</span></div>
          <div class="row"><span class="muted">Node</span><span class="spacer"></span><span class="mono">${runtime.node || boot.node || '—'}</span></div>
          <div class="row"><span class="muted">Electron</span><span class="spacer"></span><span class="mono">${boot.electron || '—'}</span></div>
          <div class="row"><span class="muted">平台</span><span class="spacer"></span><span class="mono">${runtime.platform || boot.platform || '—'}</span></div>
          <div class="row"><span class="muted">数据目录</span><span class="spacer"></span><span class="mono truncate" title=${diag?.paths?.dataDir || boot.dataDir}>${diag?.paths?.dataDir || boot.dataDir || '—'}</span></div>
        </div>
      </${Card}>

      <${Card} title="诊断" class="group">
        <div class="row">
          <${Button} onClick=${() => app.copyDiagnostics()}>复制诊断信息</${Button}>
          <${Button} disabled=${diagLoading || !diag || !!diagError} onClick=${() => {
            const blob = new Blob([JSON.stringify(diag, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = 'fox-dock-diagnostics.json'
            a.click()
            setTimeout(() => URL.revokeObjectURL(url), 2000)
            app.toast('已导出诊断包')
          }}>导出诊断包</${Button}>
        </div>
        ${diagError ? html`<div class="small" style=${{ marginTop: 8, color: 'var(--bad)' }}>诊断读取失败：${diagError}</div>` : null}
        <div class="small muted" data-visual-mask style=${{ marginTop: 8 }}>不含密钥；用户目录已替换为 ~。生成于 ${diag ? fmtDateTime(Date.parse(diag.generatedAt)) : diagLoading ? '读取中…' : '—'}</div>
      </${Card}>
    </div>
    ${wizard ? html`<${Wizard} app=${app} onClose=${() => setWizard(false)} />` : null}
  </div>`
}
