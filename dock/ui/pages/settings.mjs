import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Button, Card, Checkbox, Dialog, EmptyState, Input, SearchBox, Segmented, Select, Toggle } from '../components/base.mjs'
import { fmtNum } from '../lib/format.mjs'

const html = htm.bind(h)

function Row({ label, hint, children, hidden = false }) {
  if (hidden) return null
  return html`<div class="setting-row">
    <div class="copy"><div class="label">${label}</div>${hint ? html`<div class="hint">${hint}</div>` : null}</div>
    <div class="control">${children}</div>
  </div>`
}

// 数字输入在编辑期间保留用户正在敲的字符串（1. → 1.2 → 1.25），只在合法
// 数值出现时提交。直接用受控 Number 值会在小数点/光标位置回写，逐键输入
// 1.25 会变成 251（真机实测）。
function NumberField({ value, onCommit, ...rest }) {
  const [draft, setDraft] = useState(null)
  const shown = draft == null ? (value == null || value === 0 ? '' : String(value)) : draft
  return html`<${Input}
    ...${rest}
    type="number"
    value=${shown}
    onInput=${(v) => {
      setDraft(v)
      if (v === '') return onCommit(0)
      const n = Number(v)
      if (Number.isFinite(n)) onCommit(n)
    }}
    onBlur=${() => setDraft(null)}
    onKeyDown=${(e) => {
      if (e.key === 'Enter') e.currentTarget.blur()
    }}
  />`
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
      for (const control of row.querySelectorAll('input, select, textarea, .select-trigger')) {
        const labelText = control.labels && control.labels[0] ? String(control.labels[0].textContent || '').trim() : ''
        if (!control.getAttribute('aria-label') && !labelText) control.setAttribute('aria-label', label.trim())
      }
    }
  })

  function save(patch) {
    app.saveSettings(patch)
  }

  // 热键录入：Ctrl/Alt/Shift/Super + 字母数字 / F1–F24。只接受带修饰键的组合。
  function recordHotkey(e, save) {
    e.preventDefault()
    const key = String(e.key || '')
    if (!key || ['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return
    const upper = key.length === 1 ? key.toUpperCase() : key.toUpperCase()
    const valid = /^[A-Z0-9]$/.test(upper) || /^F([1-9]|1[0-9]|2[0-4])$/.test(upper)
    if (!valid) return
    const parts = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Super')
    if (!parts.length) {
      app.toast('热键需要至少一个修饰键（Ctrl / Alt / Shift / Win）', 'bad')
      return
    }
    save(parts.join('+') + '+' + upper)
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

  // 只滚内容区，绝不调用 scrollIntoView：那会把 document 一起滚上去，
  // 导致标题栏/侧边栏整体漂移（真机截图复现）。
  function jumpToGroup(id) {
    const content = document.getElementById('content')
    const el = document.getElementById(id)
    if (!content || !el) return
    const delta = el.getBoundingClientRect().top - content.getBoundingClientRect().top
    content.scrollTo({ top: Math.max(0, content.scrollTop + delta - 8), behavior: 'smooth' })
  }

  return html`<div data-testid="page.settings">
    <div class="row" style=${{ marginBottom: 12 }}>
      <${SearchBox} value=${search} onInput=${setSearch} placeholder="搜索设置项" />
      <span class="spacer"></span>
      <span class="small muted">改动立即生效</span>
    </div>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分组">
        <button type="button" onClick=${() => jumpToGroup("appearance")}>外观</button>
        <button type="button" onClick=${() => jumpToGroup("attach")}>吸附与位置</button>
        <button type="button" onClick=${() => jumpToGroup("bubbles")}>气泡与提醒</button>
        <button type="button" onClick=${() => jumpToGroup("live")}>会话与权限</button>
        <button type="button" onClick=${() => jumpToGroup("main")}>主数字与口径</button>
        <button type="button" onClick=${() => jumpToGroup("startup")}>启动与更新</button>
        <button type="button" onClick=${() => jumpToGroup("privacy")}>数据与隐私</button>
      </nav>
      <div>
        ${groupVisible(['主题', '语言', '角色大小', '按模型换角色', '显示样式', '菜单按钮', '隐藏金额']) ? html`<div class="group" id="appearance">
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
            <${Row} label="按模型换角色" hint="当前模型族连续两拍确认后自动换角色（GLM→嘎啦嘛、DeepSeek→大肥鱼、GPT→GPT娘等）；在宠物菜单里手动选角会关闭这项" hidden=${!has('按模型换角色')}>
              <span data-testid="settings.autoRoleByModel"><${Toggle} ariaLabel="按模型换角色" checked=${s.autoRoleByModel !== false} onChange=${(v) => save({ autoRoleByModel: v })} /></span>
            </${Row}>
            <${Row} label="菜单按钮" hidden=${!has('菜单按钮')}>
              <${Select} value=${s.menuButton || 'hover'} options=${[
                { value: 'hover', label: '悬停显示' },
                { value: 'always', label: '始终显示' },
                { value: 'hidden', label: '隐藏（右键仍可打开）' },
              ]} onChange=${(v) => save({ menuButton: v })} />
            </${Row}>
            <${Row} label="隐藏金额" hint="录屏/共享屏幕时隐藏金额，并且不再弹出消耗气泡" hidden=${!has('隐藏金额')}>
              <${Toggle} checked=${s.hideMoney} onChange=${(v) => save({ hideMoney: v })} />
            </${Row}>
          </${Card}>
        </div>` : null}

        ${groupVisible(['吸附到 agent 窗口', '自动吸附新启动的 agent', '窗口重现时自动重新吸附', '失焦兜底位置', '跟随间隔', '避让滚动条']) ? html`<div class="group" id="attach">
          <${Card} title="吸附与位置">
            <${Row} label="吸附到 agent 窗口" hint="开启后拖到宿主窗口上会贴边跟随；关闭后不吸附、不跟随，角色留在桌面上" hidden=${!has('吸附到 agent 窗口')}>
              <${Toggle} ariaLabel="吸附到 agent 窗口" checked=${!s.petMode} onChange=${(v) => save({ petMode: !v })} />
            </${Row}>
            <${Row} label="自动吸附新启动的 agent" hidden=${!has('自动吸附新启动的 agent') || !!s.petMode}>
              <${Toggle} checked=${s.autoAttachNewAgent} onChange=${(v) => save({ autoAttachNewAgent: v })} />
            </${Row}>
            <${Row} label="窗口重现时自动重新吸附" hidden=${!has('窗口重现时自动重新吸附') || !!s.petMode}>
              <${Toggle} checked=${s.reattachOnRestart} onChange=${(v) => save({ reattachOnRestart: v })} />
            </${Row}>
            <${Row} label="失焦兜底位置" hint="宿主最小化、失前台或被完全覆盖时，角色移到这个屏幕角并面向屏幕内侧；没有历史位置时也从这里出现" hidden=${!has('失焦兜底位置')}>
              <span data-testid="settings.fallbackCorner"><${Select} ariaLabel="失焦兜底位置" value=${s.fallbackCorner || 'br'} options=${[
                { value: 'br', label: '右下角' },
                { value: 'bl', label: '左下角' },
                { value: 'tr', label: '右上角' },
                { value: 'tl', label: '左上角' },
              ]} onChange=${(v) => save({ fallbackCorner: v })} /></span>
            </${Row}>
            <${Row} label="跟随间隔" hidden=${!has('跟随间隔') || !!s.petMode}>
              <${Segmented} value=${s.followMs || 500} options=${[250, 500, 1000].map((v) => ({ value: v, label: v + ' ms' }))} onChange=${(v) => save({ followMs: Number(v) })} />
            </${Row}>
            <${Row} label="避让滚动条" hint="吸附宿主或桌面悬浮时，右边按设定像素避开纵向滚动条；关闭则紧贴边缘（底边始终贴死）" hidden=${!has('避让滚动条')}>
              <${Toggle} checked=${s.scrollGapOn} onChange=${(v) => save({ scrollGapOn: v })} />
              <${Input} type="number" aria-label="避让滚动条宽度" value=${s.scrollGap} disabled=${!s.scrollGapOn}
                onInput=${(v) => save({ scrollGap: Number(v) })} style=${{ width: 80, opacity: s.scrollGapOn ? 1 : 0.5 }} />
              <span class="small muted">px</span>
            </${Row}>
          </${Card}>
        </div>` : null}

        ${groupVisible(['每轮消耗气泡', '随机台词', '勿扰', '今日预算', '周预算', '月预算', '额度预警', '余额预警', '上下文预警', '成本异常', '等确认提醒']) ? html`<div class="group" id="bubbles">
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
            <${Row} label="勿扰（静音气泡与音效）" hint="关闭气泡与角色音效；不是单独的开关，开启后一并静音" hidden=${!has('勿扰')}>
              <${Toggle} checked=${s.dnd} onChange=${(v) => save({ dnd: v })} />
            </${Row}>
            <${Row} label="今日预算" hint="0 = 关闭。金额按宿主币种；积分仅对按积分计费的宿主（如 WorkBuddy）生效" hidden=${!has('今日预算', '金额预算', '积分预算')}>
              <span class="small muted">金额</span>
              <${NumberField} aria-label="今日金额预算" data-testid="settings.budgetMoney" value=${s.budgetMoney || 0} min="0" step="0.01" placeholder="0"
                onCommit=${(v) => save({ budgetMoney: v })} style=${{ width: 104 }} />
              <span class="small muted">积分</span>
              <${NumberField} aria-label="今日积分预算" data-testid="settings.budgetCredit" value=${s.budgetCredit || 0} min="0" step="0.01" placeholder="0"
                onCommit=${(v) => save({ budgetCredit: v })} style=${{ width: 104 }} />
            </${Row}>
            <${Row} label="周预算 / 月预算" hidden=${!has('周预算', '月预算')}>
              <${NumberField} aria-label="周预算" value=${s.weeklyBudget || 0} onCommit=${(v) => save({ weeklyBudget: v })} style=${{ width: 100 }} />
              <${NumberField} aria-label="月预算" value=${s.monthlyBudget || 0} onCommit=${(v) => save({ monthlyBudget: v })} style=${{ width: 100 }} />
            </${Row}>
            <${Row} label="额度预警（剩余低于）" hidden=${!has('额度预警')}>
              <${NumberField} aria-label="额度预警" value=${s.quotaWarnPct} onCommit=${(v) => save({ quotaWarnPct: v })} style=${{ width: 90 }} /><span class="small muted">%</span>
            </${Row}>
            <${Row} label="余额预警（低于）" hidden=${!has('余额预警')}>
              <${NumberField} aria-label="余额预警" value=${s.balanceWarnMoney || 0} onCommit=${(v) => save({ balanceWarnMoney: v })} style=${{ width: 120 }} />
            </${Row}>
            <${Row} label="上下文预警（占用达到）" hidden=${!has('上下文预警')}>
              <${NumberField} aria-label="上下文预警" value=${s.contextWarnPct} onCommit=${(v) => save({ contextWarnPct: v })} style=${{ width: 90 }} /><span class="small muted">%</span>
            </${Row}>
            <${Row} label="成本异常提醒（今日 > 7 日均值 ×）" hint="0 = 关闭" hidden=${!has('成本异常')}>
              <${NumberField} aria-label="成本异常提醒" value=${s.costAnomalyX || 0} onCommit=${(v) => save({ costAnomalyX: v })} style=${{ width: 90 }} />
            </${Row}>
            <${Row} label="等确认提醒" hint="仅 ZCode 有 PermissionRequest 钩子；WorkBuddy 档案下不生效" hidden=${!has('等确认提醒')}>
              <${Toggle} checked=${s.confirmAlert} onChange=${(v) => save({ confirmAlert: v })} />
            </${Row}>
          </${Card}>
        </div>` : null}

        ${groupVisible(['显示会话状态', '接管权限请求', '接管等待时长', '权限通知', '允许热键', '拒绝热键', '本地事件接入', '接入地址', '会话保留天数']) ? html`<div class="group" id="live">
          <${Card} title="会话与权限">
            <${Row} label="显示会话状态" hint="在宠物与胶囊上显示工作 / 等待 / 出错 / 完成" hidden=${!has('显示会话状态')}>
              <${Toggle} checked=${s.live?.enabled !== false} onChange=${(v) => save({ live: { enabled: v } })} />
            </${Row}>
            <${Row} label="接管权限请求" hint="开启后权限请求先在宠物上询问；超时自动交回宿主弹窗。仅在已安装集成插件时生效" hidden=${!has('接管权限请求')}>
              <${Toggle} checked=${!!(s.permission && s.permission.takeover)} onChange=${(v) => save({ permission: { takeover: v } })} />
            </${Row}>
            <${Row} label="接管等待时长" hint="超时后由宿主原生弹窗处理" hidden=${!has('接管等待时长') || !(s.permission && s.permission.takeover)}>
              <${Select} aria-label="接管等待时长" value=${(s.permission && s.permission.waitMs) || 15000} options=${[{ value: 8000, label: '8 秒' }, { value: 15000, label: '15 秒' }, { value: 30000, label: '30 秒' }]} onChange=${(v) => save({ permission: { waitMs: Number(v) } })} />
            </${Row}>
            <${Row} label="权限通知" hint="桌面通知不包含完整命令" hidden=${!has('权限通知')}>
              <${Select} aria-label="权限通知" value=${(s.permission && s.permission.notify) || 'whenHidden'} options=${[{ value: 'always', label: '总是' }, { value: 'whenHidden', label: '仅宠物隐藏时' }, { value: 'off', label: '关闭' }]} onChange=${(v) => save({ permission: { notify: v } })} />
            </${Row}>
            <${Row} label="允许热键" hint="仅在有待处理请求时临时注册；高风险请求不响应" hidden=${!has('允许热键')}>
              <${Input} aria-label="允许热键" value=${(s.permission && s.permission.hotkeys && s.permission.hotkeys.allow) || ''} title="点击后按下组合键"
                onKeyDown=${(e) => recordHotkey(e, (v) => save({ permission: { hotkeys: { allow: v } } }))} style=${{ width: 140 }} />
            </${Row}>
            <${Row} label="拒绝热键" hidden=${!has('拒绝热键')}>
              <${Input} aria-label="拒绝热键" value=${(s.permission && s.permission.hotkeys && s.permission.hotkeys.deny) || ''} title="点击后按下组合键"
                onKeyDown=${(e) => recordHotkey(e, (v) => save({ permission: { hotkeys: { deny: v } } }))} style=${{ width: 140 }} />
            </${Row}>
            <${Row} label="本地事件接入" hint="允许本机程序通过 /v1/ingest 上报状态" hidden=${!has('本地事件接入')}>
              <${Toggle} checked=${s.ingest?.enabled !== false} onChange=${(v) => save({ ingest: { enabled: v } })} />
            </${Row}>
            <${Row} label="接入地址" hint="令牌不显示，客户端从 daemon.lock 读取" hidden=${!has('接入地址')}>
              <span class="mono small">http://127.0.0.1:${(app.state && app.state.daemon && app.state.daemon.port) || '?'}/v1/ingest</span>
              <${Button} variant="ghost" onClick=${() => navigator.clipboard.writeText('http://127.0.0.1:' + ((app.state && app.state.daemon && app.state.daemon.port) || '') + '/v1/ingest').then(() => app.toast('已复制接入地址')).catch(() => {})}>复制</${Button}>
            </${Row}>
            <${Row} label="会话保留天数" hint="仅影响 fox-dock 自己的缓存，不删除宿主数据" hidden=${!has('会话保留天数')}>
              <${Select} aria-label="会话保留天数" value=${s.retentionDays || 30} options=${[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }, { value: 90, label: '90 天' }]} onChange=${(v) => save({ retentionDays: Number(v) })} />
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
            <${Row} label="开机自启" hint="退出 fox-dock 只是本次退出，不影响本开关；开机是否自动启动只由这里决定（写入启动文件夹的 VBS 启动器，也可在托盘菜单切换）" hidden=${!has('开机自启')}>
              <${Toggle} checked=${s.autoStart} onChange=${(v) => {
                app.api('/v1/maintenance/autostart', { method: 'POST', body: { enabled: v } })
                  .then(() => save({ autoStart: v }))
                  .catch((e) => app.toast('自启设置失败：' + String(e.message || e), 'bad'))
              }} />
            </${Row}>
            <${Row} label="显示或隐藏角色" hint="全局热键，格式如 Ctrl+Alt+F；留空表示关闭。按下后切换桌面角色的显示与隐藏" hidden=${!has('全局热键')}>
              <${Input} aria-label="显示或隐藏角色热键" value=${s.hotkeys?.toggle || ''} onInput=${(v) => save({ hotkeys: { toggle: v } })} style=${{ width: 140 }} />
            </${Row}>
            <${Row} label="打开控制台" hint="全局热键。按下后打开 fox-dock 控制台窗口" hidden=${!has('全局热键')}>
              <${Input} aria-label="打开控制台热键" value=${s.hotkeys?.console || ''} onInput=${(v) => save({ hotkeys: { console: v } })} style=${{ width: 140 }} />
            </${Row}>
            <${Row} label="隐藏金额" hint="全局热键。按下后临时隐藏金额与胶囊（与「隐藏金额」开关同一效果）" hidden=${!has('全局热键')}>
              <${Input} aria-label="隐藏金额热键" value=${s.hotkeys?.hideMoney || ''} onInput=${(v) => save({ hotkeys: { hideMoney: v } })} style=${{ width: 140 }} />
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
                    return html`<div class="row" style=${{ gap: 8, opacity: available ? 1 : 0.5 }}>
                      <${Checkbox} checked=${importCats.includes(c.id)} disabled=${!available}
                        onChange=${(v) => setImportCats(v ? [...importCats, c.id] : importCats.filter((x) => x !== c.id))}>${c.label}</${Checkbox}>
                      <span class="spacer"></span>
                      <span class="small muted">${available ? (typeof available === 'number' ? available + ' 个' : '可导入') : '源里没有'}</span>
                    </div>`
                  })}
                </div>
                <div class="small muted">只读源目录，不会修改旧挂件数据；厂商 API Key 不在本导入范围内，请用「厂商与密钥」导入保险库。</div>
              </div>`}
        </${Dialog}>`
      : null}
  </div>`
}
