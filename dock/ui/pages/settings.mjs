import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Button, Card, Dialog, EmptyState, Input, SearchBox, Segmented, Select, Toggle } from '../components/base.mjs'
import { fmtNum } from '../lib/format.mjs'

const html = htm.bind(h)

function Row({ label, hint, children, hidden = false }) {
  if (hidden) return null
  return html`<div class="setting-row">
    <div class="copy"><div class="label">${label}</div>${hint ? html`<div class="hint">${hint}</div>` : null}</div>
    <div class="control">${children}</div>
  </div>`
}

export function SettingsPage({ app }) {
  const s = app.settings || {}
  const [search, setSearch] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importData, setImportData] = useState(null)
  const [importSource, setImportSource] = useState('')
  const [importCats, setImportCats] = useState([])
  const [busy, setBusy] = useState(false)

  // 设置行是「标签 + 控件」两栏结构，<label> 无法直接包住控件；
  // 渲染后按行把标签文字补成控件的 aria-label（axe 的 label 规则要求可访问名称）。
  useEffect(() => {
    for (const row of document.querySelectorAll('.setting-row')) {
      const label = (row.querySelector('.label') || {}).textContent || ''
      if (!label.trim()) continue
      for (const control of row.querySelectorAll('input, select, textarea')) {
        const labelText = control.labels && control.labels[0] ? String(control.labels[0].textContent || '').trim() : ''
        if (!control.getAttribute('aria-label') && !labelText) control.setAttribute('aria-label', label.trim())
      }
    }
  })

  function save(patch) {
    app.saveSettings(patch)
  }

  async function openImport() {
    try {
      const d = await app.api('/v1/import/sources')
      setImportData(d)
      const first = (d.sources || [])[0]
      setImportSource(first ? first.id : '')
      setImportCats(first ? Object.keys(first.categories || {}) : [])
      setImportOpen(true)
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
    }
  }

  async function doImport() {
    setBusy(true)
    try {
      const r = await app.api('/v1/import', { method: 'POST', body: { source: importSource, categories: importCats } })
      const parts = Object.entries(r.summary || {}).map(([k, v]) => k + ' ' + v.count)
      app.toast('导入完成' + (parts.length ? '：' + parts.join('，') : ''))
      setImportOpen(false)
      app.refresh()
    } catch (e) {
      app.toast('导入失败：' + String(e.message || e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  function visible(label, hint = '') {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (label + ' ' + hint).toLowerCase().includes(q)
  }
  const has = (...labels) => labels.some((l) => visible(l))
  const groupVisible = (labels) => labels.some((l) => visible(l))

  return html`<div data-testid="page.settings">
    <div class="row" style=${{ marginBottom: 12 }}>
      <${SearchBox} value=${search} onInput=${setSearch} placeholder="搜索设置项" />
      <span class="spacer"></span>
      <span class="small muted">改动立即生效</span>
    </div>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分组">
        <button type="button" onClick=${() => document.getElementById("appearance")?.scrollIntoView({ block: "start" })}>外观</button>
        <button type="button" onClick=${() => document.getElementById("attach")?.scrollIntoView({ block: "start" })}>吸附与位置</button>
        <button type="button" onClick=${() => document.getElementById("bubbles")?.scrollIntoView({ block: "start" })}>气泡与提醒</button>
        <button type="button" onClick=${() => document.getElementById("main")?.scrollIntoView({ block: "start" })}>主数字与口径</button>
        <button type="button" onClick=${() => document.getElementById("startup")?.scrollIntoView({ block: "start" })}>启动与更新</button>
        <button type="button" onClick=${() => document.getElementById("privacy")?.scrollIntoView({ block: "start" })}>数据与隐私</button>
      </nav>
      <div>
        ${groupVisible(['主题', '语言', '角色大小', '显示样式', '菜单按钮', '隐藏金额']) ? html`<div class="group" id="appearance">
          <${Card} title="外观">
            <${Row} label="主题" hidden=${!has('主题')}>
              <${Segmented} value=${s.theme || 'auto'} options=${[
                { value: 'auto', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]} onChange=${(v) => save({ theme: v })} />
            </${Row}>
            <${Row} label="语言" hint="界面目前提供简体中文" hidden=${!has('语言')}>
              <${Select} value=${s.language || 'zh-CN'} options=${[{ value: 'zh-CN', label: '简体中文' }]} onChange=${() => {}} />
            </${Row}>
            <${Row} label="角色大小" hidden=${!has('角色大小')}>
              <${Select} value=${s.scale || 1} options=${[0.75, 1, 1.25, 1.5].map((v) => ({ value: v, label: Math.round(v * 100) + '%' }))} onChange=${(v) => save({ scale: Number(v) })} />
            </${Row}>
            <${Row} label="菜单按钮" hidden=${!has('菜单按钮')}>
              <${Select} value=${s.menuButton || 'hover'} options=${[
                { value: 'hover', label: '悬停显示' },
                { value: 'always', label: '始终显示' },
                { value: 'hidden', label: '隐藏（右键仍可打开）' },
              ]} onChange=${(v) => save({ menuButton: v })} />
            </${Row}>
            <${Row} label="隐藏金额" hint="录屏/共享屏幕时把所有金额显示为 •••" hidden=${!has('隐藏金额')}>
              <${Toggle} checked=${s.hideMoney} onChange=${(v) => save({ hideMoney: v })} />
            </${Row}>
          </${Card}>
        </div>` : null}

        ${groupVisible(['桌宠模式', '自动吸附新启动的 agent', '窗口重现时自动重新吸附', '悬浮时的数据', '跟随间隔', '避让滚动条']) ? html`<div class="group" id="attach">
          <${Card} title="吸附与位置">
            <${Row} label="桌宠模式" hint="不吸附、不跟随，角色固定在屏幕上" hidden=${!has('桌宠模式')}>
              <${Toggle} checked=${s.petMode} onChange=${(v) => save({ petMode: v })} />
            </${Row}>
            <${Row} label="自动吸附新启动的 agent" hidden=${!has('自动吸附新启动的 agent')}>
              <${Toggle} checked=${s.autoAttachNewAgent} onChange=${(v) => save({ autoAttachNewAgent: v })} />
            </${Row}>
            <${Row} label="窗口重现时自动重新吸附" hidden=${!has('窗口重现时自动重新吸附')}>
              <${Toggle} checked=${s.reattachOnRestart} onChange=${(v) => save({ reattachOnRestart: v })} />
            </${Row}>
            <${Row} label="跟随间隔" hidden=${!has('跟随间隔')}>
              <${Segmented} value=${s.followMs || 500} options=${[250, 500, 1000].map((v) => ({ value: v, label: v + ' ms' }))} onChange=${(v) => save({ followMs: Number(v) })} />
            </${Row}>
            <${Row} label="避让滚动条宽度" hint="贴右/下边时给滚动条留的像素" hidden=${!has('避让滚动条')}>
              <${Input} type="number" value=${s.scrollGap} onInput=${(v) => save({ scrollGap: Number(v) })} style=${{ width: 90 }} />
            </${Row}>
          </${Card}>
        </div>` : null}

        ${groupVisible(['每轮消耗气泡', '随机台词', '勿扰', '今日预算', '周预算', '月预算', '额度预警', '余额预警', '上下文预警', '成本异常', '按压音效', '等确认提醒']) ? html`<div class="group" id="bubbles">
          <${Card} title="气泡与提醒">
            <${Row} label="每轮消耗气泡" hidden=${!has('每轮消耗气泡')}>
              <${Toggle} ariaLabel="每轮消耗气泡" checked=${s.turnBubble} onChange=${(v) => save({ turnBubble: v })} />
              <${Input} type="number" aria-label="气泡停留秒数" value=${s.turnBubbleMs / 1000} onInput=${(v) => save({ turnBubbleMs: Number(v) * 1000 })} style=${{ width: 80 }} />
              <span class="small muted">秒</span>
            </${Row}>
            <${Row} label="随机台词间隔" hidden=${!has('随机台词')}>
              <${Select} value=${s.chatterMs} options=${[
                { value: 0, label: '关' },
                { value: 180000, label: '3 分钟' },
                { value: 300000, label: '5 分钟' },
                { value: 600000, label: '10 分钟' },
              ]} onChange=${(v) => save({ chatterMs: Number(v) })} />
            </${Row}>
            <${Row} label="勿扰（静音气泡）" hidden=${!has('勿扰')}>
              <${Toggle} checked=${s.dnd} onChange=${(v) => save({ dnd: v })} />
            </${Row}>
            <${Row} label="今日预算" hint="留空或 0 = 关闭" hidden=${!has('今日预算')}>
              <${Input} type="number" value=${s.budgetMoney || ''} onInput=${(v) => save({ budgetMoney: Number(v) || 0 })} style=${{ width: 120 }} />
            </${Row}>
            <${Row} label="周预算 / 月预算" hidden=${!has('周预算', '月预算')}>
              <${Input} type="number" aria-label="周预算" value=${s.weeklyBudget || ''} onInput=${(v) => save({ weeklyBudget: Number(v) || 0 })} style=${{ width: 100 }} />
              <${Input} type="number" aria-label="月预算" value=${s.monthlyBudget || ''} onInput=${(v) => save({ monthlyBudget: Number(v) || 0 })} style=${{ width: 100 }} />
            </${Row}>
            <${Row} label="额度预警（剩余低于）" hidden=${!has('额度预警')}>
              <${Input} type="number" value=${s.quotaWarnPct} onInput=${(v) => save({ quotaWarnPct: Number(v) })} style=${{ width: 90 }} /><span class="small muted">%</span>
            </${Row}>
            <${Row} label="余额预警（低于）" hidden=${!has('余额预警')}>
              <${Input} type="number" value=${s.balanceWarnMoney || ''} onInput=${(v) => save({ balanceWarnMoney: Number(v) || 0 })} style=${{ width: 120 }} />
            </${Row}>
            <${Row} label="上下文预警（占用达到）" hidden=${!has('上下文预警')}>
              <${Input} type="number" value=${s.contextWarnPct} onInput=${(v) => save({ contextWarnPct: Number(v) })} style=${{ width: 90 }} /><span class="small muted">%</span>
            </${Row}>
            <${Row} label="成本异常提醒（今日 > 7 日均值 ×）" hint="0 = 关闭" hidden=${!has('成本异常')}>
              <${Input} type="number" value=${s.costAnomalyX || ''} onInput=${(v) => save({ costAnomalyX: Number(v) || 0 })} style=${{ width: 90 }} />
            </${Row}>
            <${Row} label="按压音效" hint="默认关；音量 0–100%" hidden=${!has('按压音效')}>
              <${Toggle} checked=${s.soundEnabled} onChange=${(v) => save({ soundEnabled: v })} />
              <${Input} type="range" aria-label="音效音量" min="0" max="100" value=${Math.round((s.soundVolume || 0.5) * 100)} onInput=${(v) => save({ soundVolume: Number(v) / 100 })} style=${{ width: 110 }} />
            </${Row}>
            <${Row} label="等确认提醒" hint="仅 ZCode 有 PermissionRequest 钩子；WorkBuddy 档案下不生效" hidden=${!has('等确认提醒')}>
              <${Toggle} checked=${s.confirmAlert} onChange=${(v) => save({ confirmAlert: v })} />
            </${Row}>
          </${Card}>
        </div>` : null}

        ${groupVisible(['主数字']) ? html`<div class="group" id="main">
          <${Card} title="主数字与口径">
            <${Row} label="主数字" hidden=${!has('主数字')}>
              <${Segmented} value=${s.displayMode || 'auto'} options=${[
                { value: 'auto', label: '自动' },
                { value: 'today', label: '今日' },
                { value: 'balance', label: '余额' },
                { value: 'quota', label: '额度' },
              ]} onChange=${(v) => save({ displayMode: v })} />
            </${Row}>
          </${Card}>
        </div>` : null}

        ${groupVisible(['开机自启', '全局热键', '检查更新', '更新清单', '更新通道']) ? html`<div class="group" id="startup">
          <${Card} title="启动与更新">
            <${Row} label="开机自启" hint="写入启动文件夹的 VBS 启动器（可在托盘菜单切换）" hidden=${!has('开机自启')}>
              <${Toggle} checked=${s.autoStart} onChange=${(v) => {
                app.api('/v1/maintenance/autostart', { method: 'POST', body: { enabled: v } })
                  .then(() => save({ autoStart: v }))
                  .catch((e) => app.toast('自启设置失败：' + String(e.message || e), 'bad'))
              }} />
            </${Row}>
            <${Row} label="全局热键" hint="格式如 Ctrl+Alt+F；留空表示关闭" hidden=${!has('全局热键')}>
              <${Input} aria-label="显示或隐藏角色热键" value=${s.hotkeys?.toggle || ''} onInput=${(v) => save({ hotkeys: { toggle: v } })} style=${{ width: 120 }} />
              <${Input} aria-label="打开控制台热键" value=${s.hotkeys?.console || ''} onInput=${(v) => save({ hotkeys: { console: v } })} style=${{ width: 120 }} />
              <${Input} aria-label="隐藏金额热键" value=${s.hotkeys?.hideMoney || ''} onInput=${(v) => save({ hotkeys: { hideMoney: v } })} style=${{ width: 120 }} />
            </${Row}>
            <${Row} label="启动时检查更新" hidden=${!has('检查更新')}>
              <${Toggle} checked=${s.autoUpdate} onChange=${(v) => save({ autoUpdate: v })} />
            </${Row}>
            <${Row} label="更新清单地址" hidden=${!has('更新清单')}>
              <${Input} value=${s.updateManifestUrl || ''} placeholder="https://…/update.json" onInput=${(v) => save({ updateManifestUrl: v })} style=${{ width: 260 }} />
            </${Row}>
          </${Card}>
        </div>` : null}

        ${groupVisible(['数据目录', '从旧挂件导入', '清空用量缓存', '重置全部设置', '诊断信息']) ? html`<div class="group" id="privacy">
          <${Card} title="数据与隐私">
            <${Row} label="数据目录" hint="配置、账本、上下文历史与角色都在这里" hidden=${!has('数据目录')}>
              <span class="mono small">${app.boot?.dataDir || ''}</span>
              <${Button} onClick=${() => window.foxDock && window.foxDock.openDataDir()}>打开</${Button}>
            </${Row}>
            <${Row} label="从旧挂件导入…" hint="读取旧挂件的角色/模板/余额校正；只读源目录" hidden=${!has('从旧挂件导入')}>
              <${Button} onClick=${openImport}>打开向导</${Button}>
            </${Row}>
            <${Row} label="清空用量缓存" hidden=${!has('清空用量缓存')}>
              <${Button} variant="danger" onClick=${() => app.clearUsage()}>清空</${Button}>
            </${Row}>
            <${Row} label="重置全部设置" hidden=${!has('重置全部设置')}>
              <${Button} variant="danger" onClick=${() => app.resetSettings()}>重置</${Button}>
            </${Row}>
            <${Row} label="诊断信息脱敏" hint="复制/导出的诊断包不含密钥，用户目录会被替换为 ~" hidden=${!has('诊断信息')}>
              <${Button} onClick=${() => app.copyDiagnostics()}>复制诊断信息</${Button}>
            </${Row}>
          </${Card}>
        </div>` : null}
      </div>
    </div>

    ${importOpen
      ? html`<${Dialog} title="从旧挂件导入" onClose=${() => setImportOpen(false)}
          actions=${html`<${Button} onClick=${() => setImportOpen(false)}>取消</${Button}><${Button} variant="primary" onClick=${doImport} loading=${busy} disabled=${!importSource || !importCats.length}>导入选中项</${Button}>`}>
          ${!importData || !importData.sources || !importData.sources.length
            ? html`<${EmptyState} title="没有找到旧挂件数据" hint="确认旧挂件安装过，或设置 FOX_DOCK_IMPORT_DIRS 指向数据目录" />`
            : html`<div style=${{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div class="field">
                  <label>来源</label>
                  <${Select} aria-label="导入来源" value=${importSource} options=${importData.sources.map((x) => ({ value: x.id, label: x.label }))}
                    onChange=${(id) => {
                      setImportSource(id)
                      const src = importData.sources.find((x) => x.id === id)
                      setImportCats(src ? Object.keys(src.categories || {}) : [])
                    }} />
                  <span class="small muted mono">${(importData.sources.find((x) => x.id === importSource) || {}).dir || ''}</span>
                </div>
                <div class="field">
                  <label>导入内容</label>
                  ${(importData.categories || []).map((c) => {
                    const src = importData.sources.find((x) => x.id === importSource)
                    const available = src && src.categories && src.categories[c.id]
                    return html`<label class="row" style=${{ gap: 8, opacity: available ? 1 : 0.5 }}>
                      <input type="checkbox" checked=${importCats.includes(c.id)} disabled=${!available}
                        onChange=${(e) => setImportCats(e.currentTarget.checked ? [...importCats, c.id] : importCats.filter((x) => x !== c.id))} />
                      <span>${c.label}</span>
                      <span class="spacer"></span>
                      <span class="small muted">${available ? (typeof available === 'number' ? available + ' 个' : '可导入') : '源里没有'}</span>
                    </label>`
                  })}
                </div>
                <div class="small muted">只读源目录，不会修改旧挂件数据；厂商 API Key 不在本导入范围内，请用「厂商与密钥」导入保险库。</div>
              </div>`}
        </${Dialog}>`
      : null}
  </div>`
}
