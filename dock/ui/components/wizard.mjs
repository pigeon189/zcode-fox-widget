// 首次接入向导（M6 / PLAN §7.12）：三步（检测宿主 → 接入方式 → 完成）。
// 只做发现与导入入口，不自动写宿主配置；集成插件由用户经 ZCode
// 「插件管理 → 本地市场」手动添加。可在「关于与诊断」重新打开。
import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Button, Dialog, Toggle } from './base.mjs'
import { Icon } from './icons.mjs'

const html = htm.bind(h)

export function Wizard({ app, onClose }) {
  const [step, setStep] = useState(0)
  const [info, setInfo] = useState(null)
  const [autoStart, setAutoStart] = useState(!!(app.settings && app.settings.autoStart))
  const [busy, setBusy] = useState(false)
  const [imported, setImported] = useState(null)

  useEffect(() => {
    let alive = true
    load(alive)
    return () => {
      alive = false
    }
  }, [])

  // daemon 刚起时 Win32 桥可能还没完成首次窗口枚举，宿主会被误判「未发现」；
  // 回到第一步或手动点「重新检测」都要重查一遍。
  async function load(alive) {
    try {
      const d = await app.api('/v1/onboarding', { force: true })
      if (alive !== false) setInfo(d)
    } catch (err) {
      if (alive !== false) setInfo({ ok: false })
    }
  }

  async function redetect() {
    setInfo(null)
    await load(true)
  }

  async function runImport(source) {
    setBusy(true)
    try {
      const d = await app.api('/v1/import', {
        method: 'POST',
        body: { source, categories: ['roles', 'bubbleTemplates', 'bubbleContent', 'ledger', 'widgetState'] },
      })
      setImported(d || { ok: false })
      app.toast('导入完成')
      app.reloadRoles && app.reloadRoles()
    } catch (e) {
      app.toast('导入失败：' + String((e && e.message) || e), 'bad')
    }
    setBusy(false)
  }

  async function finish() {
    try {
      await app.api('/v1/onboarding/complete', { method: 'POST', body: { autoStart } })
      app.refresh && app.refresh()
    } catch (e) {}
    onClose()
  }

  const hosts = (info && info.hosts) || []
  const legacySources = (info && info.legacy && info.legacy.sources) || []

  return html`<${Dialog}
    title="欢迎使用 fox-dock"
    onClose=${onClose}
    style=${{ width: '560px', minHeight: '360px' }}
  >
    <div class="small muted" style=${{ marginBottom: 12 }}>${step + 1}/3 · ${['检测宿主', '接入方式', '完成'][step]}</div>
    ${step === 0
      ? html`<div style=${{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          ${hosts.length === 0 && !info
            ? html`<div class="skeleton" style=${{ height: 120 }}></div>`
            : hosts.length === 0
              ? html`<div class="small muted">没有发现受支持的宿主窗口。先启动 ZCode / WorkBuddy / Kimi Code / DeepSeek Harness 中的任意一个，再点「重新检测」。</div>`
              : hosts.map((a) => html`<div class="row" key=${a.id}>
                  <${Icon} name="plug" size=${24} />
                  <span style=${{ fontSize: '14px', fontWeight: 600 }}>${a.name}</span>
                  <span class="spacer"></span>
                  ${a.running ? html`<${Badge} tone="ok">运行中</${Badge}>` : html`<${Badge} tone="neutral">未发现</${Badge}>`}
                </div>`)}
          <div class="row" style=${{ marginTop: 4 }}>
            <${Button} variant="ghost" onClick=${redetect} data-testid="wizard.redetect">重新检测</${Button}>
            <span class="small muted">刚启动 daemon 时窗口枚举可能慢半拍，漏检就点一下。</span>
          </div>
          ${legacySources.length
            ? html`<div class="row" style=${{ marginTop: 8 }}>
                <span class="small muted" style=${{ flex: 1, minWidth: 0 }}>
                  发现旧挂件数据（${legacySources.map((s) => s.label).join('、')}），可导入角色/账本/外观与音效。
                </span>
                <${Button} variant="primary" disabled=${busy} onClick=${() => runImport(legacySources[0].id)} data-testid="wizard.import">
                  ${busy ? '导入中…' : '导入'}
                </${Button}>
              </div>`
            : null}
        </div>`
      : null}
    ${step === 1
      ? html`<div style=${{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          ${hosts
            .filter((a) => a.running)
            .map((a) => html`<div class="card compact" key=${a.id} style=${{ padding: '12px 16px' }}>
              <div style=${{ fontSize: '14px', fontWeight: 600 }}>${a.name}</div>
              <div class="small muted">
                ${a.id === 'zcode'
                  ? '实时通道：安装集成插件后可获得权限提醒与状态推送（默认不接管权限）。'
                  : '自动读取本地日志，无需安装任何东西。'}
              </div>
              ${a.id === 'zcode' && info && info.integrationDir
                ? html`<div class="row" style=${{ marginTop: 8 }}>
                    <${Button}
                      variant="ghost"
                      data-testid="wizard.copy-integration"
                      onClick=${() => {
                        navigator.clipboard.writeText(info.integrationDir).then(
                          () => app.toast('集成目录路径已复制'),
                          () => app.toast('复制失败：' + info.integrationDir, 'bad')
                        )
                      }}
                    >复制集成目录路径</${Button}>
                    <span class="small muted">ZCode → 插件管理 → 本地市场 → 添加该目录</span>
                  </div>`
                : null}
            </div>`)}
        </div>`
      : null}
    ${step === 2
      ? html`<div style=${{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div class="small">检测到 ${hosts.filter((a) => a.running).length} 个宿主运行中${imported && imported.ok ? '；旧数据已导入' : ''}。</div>
          <div class="row">
            <span>开机自启</span>
            <span class="spacer"></span>
            <${Toggle} ariaLabel="开机自启" checked=${autoStart} onChange=${setAutoStart} data-testid="wizard.autostart" />
          </div>
          <div class="small muted">数据全部留在本机；金额与 Token 都带来源标注，缺失显示「不可得」而不是编 0。</div>
        </div>`
      : null}
    <div class="row" style=${{ marginTop: 16, justifyContent: 'flex-end' }} role="group" aria-label="向导操作">
      <${Button} variant="ghost" onClick=${finish}>跳过</${Button}>
      ${step > 0 ? html`<${Button} variant="secondary" onClick=${() => { setStep(step - 1); if (step - 1 === 0) redetect() }}>上一步</${Button}>` : null}
      ${step < 2
        ? html`<${Button} variant="primary" disabled=${!info} onClick=${() => setStep(step + 1)} data-testid="wizard.next">下一步</${Button}>`
        : html`<${Button} variant="primary" onClick=${finish} data-testid="wizard.finish">完成</${Button}>`}
    </div>
  <//>`
}
