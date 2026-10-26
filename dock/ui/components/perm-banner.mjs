// 权限待办横幅（M5 / D036）：总览与会话页顶部展示 daemon 登记的 pending 权限请求。
// 决策只有「允许一次 / 拒绝」；未确认分支 A（allowOnce）或高风险时没有「允许一次」。
import { h } from '../vendor/preact.module.js'
import { useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Button, Dialog } from './base.mjs'
import { Icon } from './icons.mjs'
import { agentName } from '../lib/format.mjs'

const html = htm.bind(h)

function previewOf(a) {
  return String(a.preview || '').replace(/\s+/g, ' ').trim()
}

function ActionRow({ a, app, allowOnceOn }) {
  function resolve(e) {
    e.stopPropagation()
    app.resolveAction(a.id, e.currentTarget.dataset.decision)
  }
  function focus(e) {
    e.stopPropagation()
    app.api('/v1/sessions/' + encodeURIComponent(a.sessionKey) + '/focus', { method: 'POST' }).catch(() => {})
  }
  return html`<div class="perm-row" data-testid="perm.row" style=${{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', padding: '4px 0', flex: '1 1 auto', minWidth: 0 }}>
    ${a.risk === 'high' ? html`<${Badge} tone="bad">高风险</${Badge}>` : null}
    <span class="num" style=${{ fontSize: '12px', color: 'var(--text-2)', flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${agentName(a.agentId)} · ${a.tool || '工具'}</span>
    <span style=${{ flex: '1 1 140px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', color: 'var(--text-2)' }}>${previewOf(a) || '（无预览）'}</span>
    <span style=${{ display: 'inline-flex', alignItems: 'center', gap: '8px', flex: '0 0 auto', marginLeft: 'auto' }}>
      <${Button} variant="ghost" onClick=${focus}>去宿主处理<//>
      <${Button} variant="secondary" data-decision="deny" onClick=${resolve}>拒绝<//>
      ${allowOnceOn && a.risk !== 'high' ? html`<${Button} variant="primary" data-decision="allow" onClick=${resolve}>允许一次<//>` : null}
    </span>
  </div>`
}

export function PermBanner({ app }) {
  const actions = app.permActions || []
  const [showAll, setShowAll] = useState(false)
  if (!actions.length) return null
  const first = actions[0]
  // 「允许一次」与宠物层权限卡（pet.js permAllowable）和权限热键同口径：
  // takeover 与 allowOnce 都开启才算分支 A。关闭接管后 broker 里的 pending
  // 还有 TTL（最长约 30s）、横幅仍会显示，但不能在这里提供 allow。
  const perm = (app.settings && app.settings.permission) || {}
  const allowOnceOn = perm.takeover === true && perm.allowOnce === true
  return html`<div
    class="col-12"
    data-testid="perm.banner"
    role="alert"
    style=${{
      borderLeft: '3px solid var(--warn)',
      background: 'color-mix(in srgb, var(--warn) 10%, var(--surface))',
      display: 'flex',
      // 会话页里横幅不在 .grid 内（不会拿到 grid 的 column 布局），单行 flex 会把
      // 决策按钮挤出 .content 的 overflow-x:hidden；允许换行，按钮组整组落到下一行。
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      rowGap: '8px',
      gap: '12px',
      padding: '8px 16px',
      borderRadius: '12px',
      border: '1px solid var(--border)',
      borderLeft: '3px solid var(--warn)',
    }}
  >
    <span style=${{ color: 'var(--warn)', flex: '0 0 auto', display: 'inline-flex' }} aria-hidden="true"><${Icon} name="alert" size=${18} /></span>
    <div style=${{ flex: '0 1 auto', minWidth: 0 }}>
      <div style=${{ fontSize: '14px', fontWeight: 600 }}>
        ${actions.length > 1 ? actions.length + ' 个权限请求等待处理' : agentName(first.agentId) + ' · ' + (first.tool || '工具') + ' 等待确认'}
      </div>
    </div>
    <${ActionRow} a=${first} app=${app} allowOnceOn=${allowOnceOn} />
    ${actions.length > 1
      ? html`<span style=${{ flex: '0 0 auto', display: 'inline-flex' }}><${Button} variant="ghost" onClick=${() => setShowAll(true)}>查看全部<//></span>`
      : null}
    ${showAll
      // 内容区不要再写死 minWidth：Dialog 固定 440px（内容约 400px），560px 的行
      // 会把「拒绝 / 允许一次」推到可见右缘之外。ActionRow 自己会换行，宽度交给 Dialog。
      ? html`<${Dialog} title="待处理的权限请求" onClose=${() => setShowAll(false)}>
          <div style=${{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            ${actions.map((a) => html`<${ActionRow} key=${a.id} a=${a} app=${app} allowOnceOn=${allowOnceOn} />`)}
          </div>
        <//>`
      : null}
  </div>`
}
