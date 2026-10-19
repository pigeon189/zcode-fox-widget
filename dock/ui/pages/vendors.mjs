import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Button, Card, Dialog, EmptyState, Field, IconButton, Input, SearchBox, Segmented } from '../components/base.mjs'

const html = htm.bind(h)

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'configured', label: '已配置' },
  { value: 'relay', label: '中转站' },
]

function kindLabel(v) {
  if (v.kind === 'relay') return '中转'
  if (v.kind === 'local-log') return '订阅'
  if (v.kind === 'cmdgo') return '预付'
  return '官方'
}

function keyStatus(v) {
  if (!v.configured) return { text: '未配置', tone: 'neutral' }
  if (v.keySource === 'env') return { text: '来自环境变量', tone: 'info' }
  if (v.keySource === 'vault') return { text: '已配置 ' + (v.keyMasked || ''), tone: 'ok' }
  if (v.keySource === 'zcode-provider') return { text: '来自 ZCode（只读）', tone: 'info' }
  if (v.keySource === 'legacy-config') return { text: '来自旧挂件配置', tone: 'neutral' }
  return { text: '已配置 ' + (v.keyMasked || ''), tone: 'ok' }
}

export function VendorsPage({ app }) {
  const [vendors, setVendors] = useState(null)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const [candidates, setCandidates] = useState([])
  const [selected, setSelected] = useState([])

  function reload() {
    app
      .api('/v1/vendors')
      .then((d) => setVendors(d.vendors || []))
      .catch((e) => app.toast(String(e.message || e), 'bad'))
  }
  useEffect(reload, [app.refreshAt])

  useEffect(() => {
    let alive = true
    app
      .api('/v1/vendors/import/candidates')
      .then((d) => alive && setCandidates(d.candidates || []))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [app.refreshAt])

  const list = (vendors || []).filter((v) => {
    if (filter === 'configured' && !v.configured) return false
    if (filter === 'relay' && v.kind !== 'relay') return false
    const q = search.trim().toLowerCase()
    if (q && !(String(v.name) + ' ' + v.id).toLowerCase().includes(q)) return false
    return true
  })

  async function save() {
    if (!editing || !key.trim()) return
    setBusy(true)
    try {
      const r = await app.api('/v1/vendors/' + encodeURIComponent(editing.id) + '/credential', { method: 'POST', body: { key: key.trim() } })
      app.toast('已保存 ' + editing.name + ' 的密钥（' + (r.maskedKey || '') + '）')
      setEditing(null)
      setKey('')
      reload()
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!editing) return
    if (!window.confirm('删除 ' + editing.name + ' 在本机保险库里的密钥？')) return
    setBusy(true)
    try {
      await app.api('/v1/vendors/' + encodeURIComponent(editing.id) + '/credential', { method: 'DELETE' })
      app.toast('已删除密钥')
      setEditing(null)
      reload()
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
    } finally {
      setBusy(false)
    }
  }

  async function runTest() {
    if (!editing) return
    setBusy(true)
    setTest(null)
    try {
      const r = await app.api('/v1/vendors/' + encodeURIComponent(editing.id) + '/test', { method: 'POST' })
      setTest(r)
    } catch (e) {
      setTest({ ok: false, reason: String(e.message || e) })
    } finally {
      setBusy(false)
    }
  }

  async function openImport() {
    try {
      const r = await app.api('/v1/vendors/import/candidates')
      setCandidates(r.candidates || [])
      setSelected((r.candidates || []).map((c) => c.templateId))
      setImportOpen(true)
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
    }
  }

  async function doImport() {
    setBusy(true)
    try {
      const r = await app.api('/v1/vendors/import', { method: 'POST', body: { ids: selected } })
      app.toast('已导入 ' + r.imported.length + ' 个厂商凭据')
      setImportOpen(false)
      reload()
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
    } finally {
      setBusy(false)
    }
  }

  return html`<div data-testid="page.vendors">
    ${candidates.length ? html`<div class="alert-bar" style=${{ background: 'var(--surface-2)', color: 'var(--text-2)' }}>
      <span>发现宿主里已配置的厂商凭据，可导入到 fox-dock 的加密保险库。</span>
      <span class="spacer"></span>
      <${Button} variant="primary" onClick=${openImport}>查看并导入</${Button}>
    </div>` : null}

    <div class="row" style=${{ marginBottom: 16 }}>
      <${SearchBox} value=${search} onInput=${setSearch} placeholder="搜索厂商" />
      <${Segmented} value=${filter} options=${FILTERS} onChange=${setFilter} />
      <span class="spacer"></span>
      <span class="small muted">${list.length} / ${vendors ? vendors.length : 0}</span>
      <${IconButton} icon="refresh" label="刷新" onClick=${reload} />
    </div>

    <${Card}>
      ${!vendors
        ? html`<div class="skeleton" style=${{ height: 260 }}></div>`
        : list.length
          ? html`<table class="table">
              <thead><tr><th style=${{ width: 260 }}>厂商</th><th style=${{ width: 80 }}>类型</th><th>密钥状态</th><th style=${{ width: 80 }}>状态</th><th style=${{ width: 90 }}><span class="sr-only">操作</span></th></tr></thead>
              <tbody>
                ${list.map((v) => {
                  const ks = keyStatus(v)
                  return html`<tr>
                    <td><div class="row"><span style=${{ fontWeight: 600 }}>${v.name}</span><span class="small muted mono">${v.id}</span></div></td>
                    <td><${Badge} tone=${v.kind === 'relay' ? 'info' : 'neutral'}>${kindLabel(v)}</${Badge}></td>
                    <td class="mono" title=${ks.text}><${Badge} tone=${ks.tone}>${ks.text}</${Badge}></td>
                    <td><${Badge} tone=${v.available ? 'ok' : 'neutral'}>${v.available ? '可用' : '未取到'}</${Badge}></td>
                    <td class="right"><${Button} onClick=${() => { setEditing(v); setKey(''); setShow(false); setTest(null) }}>配置</${Button}></td>
                  </tr>`
                })}
              </tbody>
            </table>`
          : html`<${EmptyState} title="没有匹配的厂商" />`}
    </${Card}>

    ${editing
      ? html`<${Dialog} title=${'配置 ' + editing.name} onClose=${() => setEditing(null)}
          actions=${html`<${Button} onClick=${() => setEditing(null)}>取消</${Button}>
            ${editing.configured ? html`<${Button} variant="danger" onClick=${remove} loading=${busy}>删除密钥</${Button}>` : null}
            <${Button} onClick=${runTest} loading=${busy}>测试连接</${Button}>
            <${Button} variant="primary" onClick=${save} loading=${busy}>保存</${Button}>`}>
          <div style=${{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <${Field} label="API Key" hint="密钥用 Windows DPAPI 加密保存在本机，不会写入日志或诊断包">
              <div class="row">
                <input class="input" aria-label="API Key" style=${{ flex: 1 }} type=${show ? 'text' : 'password'} value=${key}
                  placeholder=${editing.keyMasked || '粘贴密钥'} onInput=${(e) => setKey(e.currentTarget.value)} autocomplete="off" />
                <${IconButton} icon=${show ? 'eyeOff' : 'eye'} label=${show ? '隐藏密钥' : '显示密钥'} onClick=${() => setShow(!show)} />
              </div>
            </${Field}>
            <div class="small muted">类型：${kindLabel(editing)} · 状态：${editing.available ? '接口可用' : (editing.reason || '暂无数据')}</div>
            ${test ? html`<div class=${'alert-bar ' + (test.ok ? '' : 'bad')}>${test.ok ? (test.skipped ? '凭据已存在（未发起网络测试）' : '连接成功') : '连接失败：' + (test.reason || '未知原因')}</div>` : null}
          </div>
        </${Dialog}>`
      : null}

    ${importOpen
      ? html`<${Dialog} title="从宿主导入凭据" onClose=${() => setImportOpen(false)}
          actions=${html`<${Button} onClick=${() => setImportOpen(false)}>取消</${Button}><${Button} variant="primary" onClick=${doImport} loading=${busy}>导入选中项</${Button}>`}>
          ${candidates.length === 0
            ? html`<${EmptyState} title="没有发现可导入的凭据" hint="先在 ZCode 里配置 provider，或使用环境变量" />`
            : html`<div style=${{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                ${candidates.map(
                  (c) => html`<label class="row" style=${{ gap: 10, cursor: 'pointer' }}>
                    <input type="checkbox" checked=${selected.includes(c.templateId)}
                      onChange=${(e) => setSelected(e.currentTarget.checked ? [...selected, c.templateId] : selected.filter((id) => id !== c.templateId))} />
                    <span style=${{ flex: 1 }}>${c.name}</span>
                    <span class="mono small">${c.masked}</span>
                    <${Badge} tone="neutral">${c.source}</${Badge}>
                  </label>`
                )}
              </div>`}
        </${Dialog}>`
      : null}
  </div>`
}
