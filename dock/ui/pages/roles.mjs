import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Toggle } from '../components/base.mjs'

const html = htm.bind(h)

const CHATTER = [
  { value: 0, label: '关' },
  { value: 180000, label: '3 分钟' },
  { value: 300000, label: '5 分钟' },
  { value: 600000, label: '10 分钟' },
]

export function RolesPage({ app }) {
  const [profile, setProfile] = useState(null)
  const [templates, setTemplates] = useState(null)
  const [dialog, setDialog] = useState(false)
  const [json, setJson] = useState('')

  useEffect(() => {
    let alive = true
    app
      .api('/v1/profiles/' + encodeURIComponent(app.viewAgent))
      .then((d) => alive && setProfile(d.profile))
      .catch(() => {})
    app
      .api('/v1/bubbles/templates')
      .then((d) => alive && setTemplates(d.templates || []))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [app.viewAgent, app.refreshAt])

  async function save(patch) {
    try {
      const d = await app.api('/v1/profiles/' + encodeURIComponent(app.viewAgent), { method: 'PUT', body: patch })
      setProfile(d.profile)
      app.toast('已保存')
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
    }
  }

  async function pick(id) {
    await save({ roleId: id })
    await app.reloadState()
  }

  async function saveTemplates() {
    try {
      const parsed = JSON.parse(json)
      if (!Array.isArray(parsed)) throw new Error('模板必须是数组')
      const d = await app.api('/v1/bubbles/templates', { method: 'POST', body: { templates: parsed } })
      setTemplates(d.templates || [])
      setDialog(false)
      app.toast('气泡模板已保存')
    } catch (e) {
      app.toast('模板无效：' + String(e.message || e), 'bad')
    }
  }

  const roles = app.roles || []
  const current = (profile && profile.roleId) || ''

  return html`<div data-testid="page.roles">
    <div class="grid">
      <div class="col-7">
        <${Card} title="角色库" actions=${html`<span class="small muted">${app.agentName(app.viewAgent)} 的档案</span>`}>
          <div class="role-grid">
            ${roles.map(
              (r) => html`<button type="button" role="radio" aria-checked=${current === r.id}
                class=${'role-card ' + (current === r.id ? 'selected' : '')} onClick=${() => pick(r.id)}>
                ${app.roleImageUrl(r.id) ? html`<img src=${app.roleImageUrl(r.id)} alt=${r.name} />` : html`<div class="avatar" style=${{ width: 96, height: 96 }}>${r.name.slice(0, 1)}</div>`}
                <span style=${{ fontWeight: 600 }}>${r.name}</span>
                ${r.builtin ? null : html`<${Badge} tone="info">导入</${Badge}>`}
              </button>`
            )}
          </div>
        </${Card}>
      </div>
      <div class="col-5">
        <${Card} title="档案设置">
          ${!profile
            ? html`<div class="skeleton" style=${{ height: 180 }}></div>`
            : html`<div style=${{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <${Field} label="强调色">
                  <div class="row">
                    <input type="color" aria-label="强调色" value=${profile.accent || '#f0a04b'} onInput=${(e) => save({ accent: e.currentTarget.value })} style=${{ width: 44, height: 32, border: 0, background: 'transparent' }} />
                    <span class="mono">${profile.accent || '跟随角色'}</span>
                    <span class="spacer"></span>
                    <${Button} variant="ghost" onClick=${() => save({ accent: '' })}>恢复默认</${Button}>
                  </div>
                </${Field}>
                <${Field} label="主数字口径">
                  <${Select} aria-label="主数字口径" value=${profile.displayMode || 'auto'} options=${[
                    { value: 'auto', label: '自动（按宿主）' },
                    { value: 'today', label: '今日' },
                    { value: 'balance', label: '余额' },
                    { value: 'quota', label: '额度剩余' },
                  ]} onChange=${(v) => save({ displayMode: v })} />
                </${Field}>
                <div class="row"><span>每轮消耗气泡</span><span class="spacer"></span><${Toggle} ariaLabel="每轮消耗气泡" checked=${profile.turnBubble} onChange=${(v) => save({ turnBubble: v })} /></div>
                <div class="row"><span>气泡停留</span><span class="spacer"></span>
                  <${Select} aria-label="气泡停留时间" value=${profile.turnBubbleMs || 5000} options=${[2000, 3000, 5000, 8000, 15000].map((v) => ({ value: v, label: v / 1000 + ' 秒' }))} onChange=${(v) => save({ turnBubbleMs: Number(v) })} />
                </div>
                <div class="row"><span>随机台词</span><span class="spacer"></span>
                  <${Select} aria-label="随机台词间隔" value=${profile.chatterMs || 0} options=${CHATTER.map((c) => ({ value: c.value, label: c.label }))} onChange=${(v) => save({ chatterMs: Number(v) })} />
                </div>
                <div class="row"><span>勿扰</span><span class="spacer"></span><${Toggle} ariaLabel="勿扰" checked=${profile.dnd} onChange=${(v) => save({ dnd: v })} /></div>
              </div>`}
        </${Card}>
        <${Card} title="气泡模板" class="group">
          <div class="row">
            <span class="small muted">${templates == null ? '加载中…' : (templates.length ? templates.length + ' 个模板' : '未导入模板')}</span>
            <span class="spacer"></span>
            <${Button} onClick=${() => { setJson(JSON.stringify(templates || [], null, 2)); setDialog(true) }}>编辑 JSON</${Button}>
          </div>
        </${Card}>
      </div>
    </div>

    ${dialog
      ? html`<${Dialog} title="气泡模板 JSON" onClose=${() => setDialog(false)}
          actions=${html`<${Button} onClick=${() => setDialog(false)}>取消</${Button}><${Button} variant="primary" onClick=${saveTemplates}>保存</${Button}>`}>
          <textarea class="textarea" rows="16" style=${{ width: '100%' }} value=${json} onInput=${(e) => setJson(e.currentTarget.value)}></textarea>
          <div class="small muted">格式与旧挂件兼容；保存后由控制台与宠物层共同使用。</div>
        </${Dialog}>`
      : null}
  </div>`
}
