import { h } from '../vendor/preact.module.js'
import { useEffect, useState } from '../vendor/hooks.module.js'
import htm from '../vendor/htm.module.js'
import { Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, IconButton, Input, SearchBox, Segmented } from '../components/base.mjs'

const html = htm.bind(h)

const FILTERS = [
  { value: 'configured', label: '已配置' },
  { value: 'all', label: '全部' },
  { value: 'relay', label: '中转站' },
]

function kindLabel(v) {
  if (v.kind === 'relay') return '中转'
  if (v.kind === 'local-log') return '订阅'
  if (v.kind === 'cmdgo') return '中转套餐'
  // volc = 火山方舟 Coding/Agent 订阅窗口（IAM AK/SK 查官方 OpenAPI）
  if (v.kind === 'volc') return '订阅'
  // tokens = 官方无公开余额接口，只有凭据 + 本机 token 计价；不要让人以为能查余额。
  if (v.kind === 'tokens') return '仅计价'
  return '官方'
}

function kindHint(v) {
  if (v.kind === 'tokens') return '官方没有公开的 API-key 余额接口；配置后只用于凭据状态与本机 token 计价'
  if (v.kind === 'volc') return '订阅窗口需火山 IAM AK/SK（环境变量或保险库 volc-access-key-id / volc-access-key-secret）；模型调用的 ark- key 不适用'
  return v.note || ''
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
  // null = 还没决定：数据到达后按「有已配置项」选默认筛选。
  const [filter, setFilter] = useState(null)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [key, setKey] = useState('')
  // 火山方舟订阅配额的凭据是 IAM AK/SK 对（两个独立保险库条目），单独一组状态。
  const [volcAk, setVolcAk] = useState('')
  const [volcSk, setVolcSk] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const [candidates, setCandidates] = useState([])
  const [selected, setSelected] = useState([])

  function reload(force = false) {
    app
      .api('/v1/vendors' + (force ? '?force=1' : ''))
      .then((d) => setVendors(d.vendors || []))
      .catch((e) => app.toast(String(e.message || e), 'bad'))
  }
  useEffect(reload, [app.refreshAt])

  // 默认「已配置」；一个都没有时回落到「全部」，避免新装用户看到空列表。
  useEffect(() => {
    if (!vendors || filter != null) return
    setFilter(vendors.some((v) => v.configured) ? 'configured' : 'all')
  }, [vendors, filter])

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

  const activeFilter = filter || 'all'
  const list = (vendors || [])
    .filter((v) => {
      if (activeFilter === 'configured' && !v.configured) return false
      if (activeFilter === 'relay' && !['relay', 'cmdgo'].includes(v.kind)) return false
      const q = search.trim().toLowerCase()
      if (q && !(String(v.name) + ' ' + v.id + ' ' + (v.note || '')).toLowerCase().includes(q)) return false
      return true
    })
    // 已配置优先；同一档按名称稳定排序，新增模板不需要改这里。
    .sort((a, b) => {
      if (!!b.configured !== !!a.configured) return b.configured ? 1 : -1
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
    })

  async function save() {
    if (!editing) return
    setBusy(true)
    try {
      if (editing.kind === 'volc') {
        // AK/SK 成对保存到两个保险库条目（volc-plan.mjs 按同名键读回）；缺一个
        // 就不保存——半对凭据只会换来回 401。
        if (!volcAk.trim() || !volcSk.trim()) {
          app.toast('Access Key ID 与 Secret 需成对填写', 'bad')
          return
        }
        await app.api('/v1/vendors/volc-access-key-id/credential', { method: 'POST', body: { key: volcAk.trim() } })
        await app.api('/v1/vendors/volc-access-key-secret/credential', { method: 'POST', body: { key: volcSk.trim() } })
        app.toast('已保存火山 IAM AK/SK（配额查询用，不出现在日志）')
        setEditing(null)
        setVolcAk('')
        setVolcSk('')
        reload(true)
        return
      }
      if (!key.trim()) return
      const r = await app.api('/v1/vendors/' + encodeURIComponent(editing.id) + '/credential', { method: 'POST', body: { key: key.trim() } })
      app.toast('已保存 ' + editing.name + ' 的密钥（' + (r.maskedKey || '') + '）')
      setEditing(null)
      setKey('')
      reload(true)
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!editing) return
    setBusy(true)
    try {
      if (editing.kind === 'volc') {
        // 两个条目一起删，避免残留半对凭据
        await app.api('/v1/vendors/volc-access-key-id/credential', { method: 'DELETE' })
        await app.api('/v1/vendors/volc-access-key-secret/credential', { method: 'DELETE' })
      } else {
        await app.api('/v1/vendors/' + encodeURIComponent(editing.id) + '/credential', { method: 'DELETE' })
      }
      app.toast('已删除密钥')
      setConfirming(false)
      setEditing(null)
      reload(true)
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
      reload(true)
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
    } finally {
      setBusy(false)
    }
  }

  return html`<div data-testid="page.vendors">
    <div class="small muted" style=${{ marginBottom: 12 }}>
      这里保存厂商 API Key。有余额 / 额度接口的厂商用于直接查询；标为「仅计价」的模板官方没有公开余额接口，
      配置后只用于确认凭据并按本机 token 用量匹配价目，不会伪造余额。不导入也能查看本机会话、Token 与成本；
      宿主里已有的凭据可从下方「导入」，或直接使用环境变量。
    </div>
    ${candidates.length ? html`<div class="alert-bar" style=${{ background: 'var(--surface-2)', color: 'var(--text-2)' }}>
      <span>发现宿主里已配置的厂商凭据，可导入到 fox-dock 的加密保险库。</span>
      <span class="spacer"></span>
      <${Button} variant="primary" onClick=${openImport}>查看并导入</${Button}>
    </div>` : null}

    <div class="row wrap" style=${{ marginBottom: 16 }}>
      <${SearchBox} value=${search} onInput=${setSearch} placeholder="搜索厂商" />
      <${Segmented} value=${activeFilter} options=${FILTERS} onChange=${setFilter} />
      <span class="spacer"></span>
      <span class="small muted">${list.length} / ${vendors ? vendors.length : 0}</span>
      <${IconButton} icon="refresh" label="刷新" onClick=${() => reload(true)} />
    </div>

    <${Card}>
      ${!vendors
        ? html`<div class="skeleton" style=${{ height: 260 }}></div>`
        : list.length
          ? html`<table class="table vendors-table">
              <thead><tr><th style=${{ width: 260 }}>厂商</th><th style=${{ width: 80 }}>类型</th><th>密钥状态</th><th style=${{ width: 88 }}>状态</th><th style=${{ width: 90 }}><span class="sr-only">操作</span></th></tr></thead>
              <tbody>
                ${list.map((v) => {
                  const ks = keyStatus(v)
                  const tokens = v.kind === 'tokens'
                  // tokens 模板没有余额接口：不要说「未取到」，只说凭据是否就绪。
                  const statusText = tokens ? (v.configured ? '仅凭据' : '未配置') : v.available ? '可用' : '未取到'
                  const statusTone = tokens ? (v.configured ? 'info' : 'neutral') : v.available ? 'ok' : 'neutral'
                  return html`<tr data-testid=${'vendors.row.' + v.id}>
                    <td><div class="row vendors-name">
                      <span class="vendors-name-text" style=${{ fontWeight: 600 }} title=${kindHint(v) || v.name}>${v.name}</span>
                      <span class="small muted mono truncate">${v.id}</span>
                    </div></td>
                    <td><${Badge} tone=${['relay', 'cmdgo'].includes(v.kind) ? 'info' : 'neutral'} title=${kindHint(v) || undefined}>${kindLabel(v)}</${Badge}></td>
                    <td class="mono" title=${ks.text}><${Badge} tone=${ks.tone}>${ks.text}</${Badge}></td>
                    <td><${Badge} tone=${statusTone}>${statusText}</${Badge}></td>
                    <td class="right"><${Button} onClick=${() => { setEditing(v); setConfirming(false); setKey(''); setVolcAk(''); setVolcSk(''); setShow(false); setTest(null) }}>配置</${Button}></td>
                  </tr>`
                })}
              </tbody>
            </table>`
          : html`<${EmptyState} title="没有匹配的厂商" hint="切换到「全部」查看未配置的模板" />`}
    </${Card}>

    ${editing && !confirming
      ? html`<${Dialog} title=${'配置 ' + editing.name} onClose=${() => setEditing(null)}
          actions=${html`<${Button} onClick=${() => setEditing(null)}>取消</${Button}>
            ${editing.configured ? html`<${Button} variant="danger" onClick=${() => setConfirming(true)} loading=${busy}>删除密钥</${Button}>` : null}
            <${Button} onClick=${runTest} loading=${busy}>测试连接</${Button}>
            <${Button} variant="primary" onClick=${save} loading=${busy}>保存</${Button}>`}>
          <div style=${{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            ${editing.kind === 'volc'
              ? html`<${Field} label="火山 IAM Access Key ID" hint="AKLT 开头的 IAM 密钥对；模型调用的 ark- key 查不了配额。DPAPI 加密保存在本机">
                  <input class="input" aria-label="火山 Access Key ID" style=${{ flex: 1 }} type="text" value=${volcAk}
                    placeholder=${editing.keyMasked || 'AKLT…'} onInput=${(e) => setVolcAk(e.currentTarget.value)} autocomplete="off" data-testid="vendors.volc.ak" />
                </${Field}>
                  <${Field} label="火山 IAM Access Key Secret">
                    <div class="row">
                      <input class="input" aria-label="火山 Access Key Secret" style=${{ flex: 1 }} type=${show ? 'text' : 'password'} value=${volcSk}
                        placeholder="成对填写，缺一不保存" onInput=${(e) => setVolcSk(e.currentTarget.value)} autocomplete="off" data-testid="vendors.volc.sk" />
                      <${IconButton} icon=${show ? 'eyeOff' : 'eye'} label=${show ? '隐藏密钥' : '显示密钥'} onClick=${() => setShow(!show)} />
                    </div>
                  </${Field}>`
              : html`<${Field} label="API Key" hint="密钥用 Windows DPAPI 加密保存在本机，不会写入日志或诊断包">
                  <div class="row">
                    <input class="input" aria-label="API Key" style=${{ flex: 1 }} type=${show ? 'text' : 'password'} value=${key}
                      placeholder=${editing.keyMasked || '粘贴密钥'} onInput=${(e) => setKey(e.currentTarget.value)} autocomplete="off" />
                    <${IconButton} icon=${show ? 'eyeOff' : 'eye'} label=${show ? '隐藏密钥' : '显示密钥'} onClick=${() => setShow(!show)} />
                  </div>
                </${Field}>`}
            <div class="small muted">
              类型：${kindLabel(editing)} · 状态：${editing.kind === 'tokens'
                ? (editing.configured ? '凭据已配置，无余额接口' : '未配置凭据，无余额接口')
                : editing.available
                  ? '接口可用'
                  : editing.reason || '暂无数据'}
            </div>
            ${kindHint(editing) ? html`<div class="small muted vendor-hint">${kindHint(editing)}</div>` : null}
            ${test ? html`<div class=${'alert-bar ' + (test.ok ? (test.skipped ? 'info' : 'ok') : 'bad')}>${test.ok ? (test.skipped ? (test.note || '凭据已存在（未发起网络测试）') : '连接成功') : '连接失败：' + (test.reason || '未知原因')}</div>` : null}
          </div>
        </${Dialog}>`
      : null}

    ${editing && confirming
      ? html`<${Dialog} title="删除密钥" onClose=${() => setConfirming(false)}
          actions=${html`<${Button} onClick=${() => setConfirming(false)}>取消</${Button}><${Button} variant="danger" onClick=${remove} loading=${busy}>删除</${Button}>`}>
          <div class="small">确定删除 <b>${editing.name}</b> 在本机保险库里的密钥？删除后只能用环境变量或宿主凭据。</div>
        </${Dialog}>`
      : null}

    ${importOpen
      ? html`<${Dialog} title="从宿主导入凭据" onClose=${() => setImportOpen(false)}
          actions=${html`<${Button} onClick=${() => setImportOpen(false)}>取消</${Button}><${Button} variant="primary" onClick=${doImport} loading=${busy}>导入选中项</${Button}>`}>
          ${candidates.length === 0
            ? html`<${EmptyState} title="没有发现可导入的凭据" hint="先在 ZCode 里配置 provider，或使用环境变量" />`
            : html`<div style=${{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                ${candidates.map(
                  (c) => html`<div class="row" style=${{ gap: 10 }}>
                    <${Checkbox} checked=${selected.includes(c.templateId)}
                      onChange=${(v) => setSelected(v ? [...selected, c.templateId] : selected.filter((id) => id !== c.templateId))}>
                      <span>${c.name}</span>
                    </${Checkbox}>
                    <span class="spacer"></span>
                    <span class="mono small">${c.masked}</span>
                    <${Badge} tone="neutral">${c.source}</${Badge}>
                  </div>`
                )}
              </div>`}
        </${Dialog}>`
      : null}
  </div>`
}
