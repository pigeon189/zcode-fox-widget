import { h } from '../vendor/preact.module.js'
import { useEffect, useRef, useState } from '../vendor/hooks.module.js'
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
  const [queue, setQueue] = useState([])
  const [queueDialog, setQueueDialog] = useState(false)
  const [queueJson, setQueueJson] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [pending, setPending] = useState(null)
  const [roleName, setRoleName] = useState('')
  const [roleId, setRoleId] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)
  // 按压音效（M-S 语音库）：列表 / 音量 / 导入 / 两步删除
  const [sounds, setSounds] = useState(null)
  const [soundVolume, setSoundVolume] = useState(null)
  const [soundSet, setSoundSet] = useState('duck')
  const [soundDelId, setSoundDelId] = useState('')
  const soundFileRef = useRef(null)

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
    app
      .api('/v1/bubbles/queue')
      .then((d) => alive && setQueue(d.queue || []))
      .catch(() => {})
    app
      .api('/v1/sounds')
      .then((d) => alive && setSounds(d.sets || []))
      .catch(() => {})
    app
      .api('/v1/settings')
      .then((d) => {
        if (!alive) return
        setSoundVolume(Math.round((Number(d.settings && d.settings.soundVolume) || 0.5) * 100) / 100)
        setSoundSet(String((d.settings && d.settings.soundSet) || 'duck'))
      })
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
      return true
    } catch (e) {
      app.toast(String(e.message || e), 'bad')
      return false
    }
  }

  async function pick(id) {
    // 手动选角 = 明确覆盖：同时关闭「按模型换角色」，与宠物菜单保持一致。
    // 否则 autoRoleByModel 开启时模型族角色会覆盖这里选的角色。
    if (!(await save({ roleId: id }))) return
    try {
      await app.api('/v1/settings', { method: 'PUT', body: { autoRoleByModel: false } })
    } catch (e) {
      app.toast('已选角色，但关闭「按模型换角色」失败：' + String(e.message || e), 'bad')
    }
    await app.reloadState()
    app.refresh()
  }

  // ---- 按压音效（M-S 语音库） ----
  async function reloadSounds() {
    try {
      const d = await app.api('/v1/sounds', { force: true })
      setSounds(d.sets || [])
      setSoundSet(String(d.selected || 'duck'))
    } catch (e) {}
  }
  async function pickSound(id) {
    try {
      await app.api('/v1/settings', { method: 'PUT', body: { soundSet: id } })
      setSoundSet(id)
      app.toast('音效已切换')
    } catch (e) {
      app.toast('切换失败：' + String(e.message || e), 'bad')
    }
  }
  async function pickVolume(v) {
    setSoundVolume(Number(v))
    try {
      await app.api('/v1/settings', { method: 'PUT', body: { soundVolume: Number(v) } })
    } catch (e) {
      app.toast('保存失败：' + String(e.message || e), 'bad')
    }
  }
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result || ''))
      r.onerror = () => reject(new Error('读取失败'))
      r.readAsDataURL(file)
    })
  }
  async function onSoundFiles(e) {
    const files = Array.from((e.currentTarget.files || [])).slice(0, 2)
    e.currentTarget.value = ''
    if (!files.length) return
    if (files.length > 2) app.toast('最多选 2 个文件（第 1 个按压音，第 2 个松手音）', 'bad')
    try {
      const body = { press: { name: files[0].name, dataUrl: await fileToDataUrl(files[0]) } }
      if (files[1]) body.release = { name: files[1].name, dataUrl: await fileToDataUrl(files[1]) }
      const d = await app.api('/v1/sounds/import', { method: 'POST', body })
      if (d && d.ok) {
        setSounds(d.sets || [])
        setSoundSet(String(d.selected || d.id))
        app.toast('音效已导入并切换')
      } else {
        app.toast(String((d && d.error) || '导入失败'), 'bad')
      }
    } catch (err) {
      app.toast('导入失败：' + String(err.message || err), 'bad')
    }
  }
  async function deleteSound(id) {
    if (soundDelId !== id) {
      setSoundDelId(id)
      setTimeout(() => setSoundDelId((cur) => (cur === id ? '' : cur)), 4000)
      return
    }
    setSoundDelId('')
    try {
      const d = await app.api('/v1/sounds/' + encodeURIComponent(id), { method: 'DELETE' })
      if (d && d.ok) {
        setSounds(d.sets || [])
        setSoundSet(String(d.selected || 'duck'))
        app.toast('音效已删除')
      } else {
        app.toast(String((d && d.error) || '删除失败'), 'bad')
      }
    } catch (err) {
      app.toast('删除失败：' + String(err.message || err), 'bad')
    }
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

  function slugOf(name) {
    return (
      String(name || 'role')
        .toLowerCase()
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 18) || 'role'
    )
  }

  async function onFile(e) {
    const file = e.currentTarget.files && e.currentTarget.files[0]
    e.currentTarget.value = ''
    if (!file) return
    if (file.size > 3 * 1024 * 1024) return app.toast('图片超过 3MB', 'bad')
    const isGif = /^image\/gif$/i.test(file.type) || /\.gif$/i.test(file.name)
    if (!isGif && !/^image\/(png|jpeg|webp)$/i.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
      return app.toast('只支持 PNG / JPEG / WebP / GIF 图片', 'bad')
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('读取文件失败'))
      reader.readAsDataURL(file)
    })
    const dims = await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, img })
      img.onerror = () => resolve(null)
      img.src = dataUrl
    })
    if (!dims) return app.toast('图片解码失败', 'bad')
    if (dims.width > 2048 || dims.height > 2048) return app.toast('图片尺寸超过 2048×2048', 'bad')
    // GIF 原样保留动画；其余格式统一转成 PNG（daemon 不引入图片解码依赖）。
    let payloadUrl = dataUrl
    if (!isGif) {
      const canvas = document.createElement('canvas')
      canvas.width = dims.width
      canvas.height = dims.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return app.toast('浏览器无法处理这张图片', 'bad')
      ctx.drawImage(dims.img, 0, 0)
      payloadUrl = canvas.toDataURL('image/png')
    }
    const base64 = payloadUrl.split(',')[1] || ''
    if (base64.length * 0.75 > 3 * 1024 * 1024) return app.toast('转换后的图片超过 3MB', 'bad')
    const name = file.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 24)
    setPending({ dataUrl, base64, width: dims.width, height: dims.height, format: isGif ? 'gif' : 'png' })
    setRoleName(name)
    setRoleId(slugOf(name))
    setImportOpen(true)
  }

  async function doImport() {
    if (!pending) return
    setBusy(true)
    try {
      const d = await app.api('/v1/roles/import', {
        method: 'POST',
        body: { id: roleId, name: roleName, dataBase64: pending.base64 },
      })
      app.toast('已导入角色 ' + d.role.name)
      setImportOpen(false)
      setPending(null)
      await app.reloadRoles()
      await pick(d.role.id)
    } catch (e) {
      app.toast('导入失败：' + String(e.message || e), 'bad')
    } finally {
      setBusy(false)
    }
  }

  async function removeRole(r) {
    if (!window.confirm('删除角色「' + r.name + '」？')) return
    try {
      await app.api('/v1/roles/' + encodeURIComponent(r.id), { method: 'DELETE' })
      app.toast('已删除角色')
      await app.reloadRoles()
      if (current === r.id) await pick('fox')
    } catch (e) {
      app.toast('删除失败：' + String(e.message || e), 'bad')
    }
  }

  async function saveQueue() {
    try {
      const parsed = JSON.parse(queueJson)
      if (!Array.isArray(parsed)) throw new Error('队列必须是数组')
      const d = await app.api('/v1/bubbles/queue', { method: 'POST', body: { queue: parsed.slice(0, 12) } })
      setQueue(d.queue || [])
      setQueueDialog(false)
      app.toast('按压泡泡队列已保存')
    } catch (e) {
      app.toast('队列无效：' + String(e.message || e), 'bad')
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
              (r) => html`<div class="role-wrap">
                <button type="button" role="radio" aria-checked=${current === r.id}
                  class=${'role-card ' + (current === r.id ? 'selected' : '')} onClick=${() => pick(r.id)}>
                  ${app.roleImageUrl(r.id) ? html`<img src=${app.roleImageUrl(r.id)} alt="" />` : html`<div class="avatar" style=${{ width: 96, height: 96 }}>${r.name.slice(0, 1)}</div>`}
                  <span style=${{ fontWeight: 600 }}>${r.name}</span>
                  ${r.builtin ? null : html`<${Badge} tone="info">导入</${Badge}>`}
                </button>
                ${r.builtin ? null : html`<button type="button" class="role-del" aria-label=${'删除角色 ' + r.name} title="删除角色" onClick=${() => removeRole(r)}>×</button>`}
              </div>`
            )}
            <button type="button" class="role-card role-add" onClick=${() => fileRef.current && fileRef.current.click()}>
              <span style=${{ fontSize: 28, color: 'var(--text-3)' }}>+</span>
              <span class="small muted">导入角色</span>
            </button>
          </div>
          <input ref=${fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" hidden onChange=${onFile} aria-label="选择角色图片（PNG/JPEG/WebP/GIF）" />
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
        <${Card} title="按压音效" class="group" testid="sounds.card">
          <div style=${{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div class="row"><span>音效集</span><span class="spacer"></span>
              <${Select} aria-label="音效集" data-testid="sounds.select" value=${soundSet}
                options=${(sounds || [{ id: 'duck', name: '小黄鸭' }, { id: 'fx1', name: '嘀嘟' }, { id: 'nya', name: '猫娘' }]).map((s) => ({ value: s.id, label: s.name }))}
                onChange=${pickSound} />
            </div>
            <div class="row"><span>音量</span><span class="spacer"></span>
              <${Select} aria-label="音量" data-testid="sounds.volume" value=${soundVolume == null ? 0.5 : soundVolume}
                options=${[0, 0.25, 0.5, 0.75, 1].map((v) => ({ value: v, label: v === 0 ? '静音' : Math.round(v * 100) + '%' }))}
                onChange=${pickVolume} />
            </div>
            <div class="row">
              <span class="small muted" style=${{ flex: 1, minWidth: 0 }}>
                导入 1～2 个音频文件（第 1 个按压音、第 2 个松手音；单文件 ≤2MB，支持 mp3/wav/ogg/m4a/aac），文件名即音效名。
              </span>
              <${Button} data-testid="sounds.import" onClick=${() => soundFileRef.current && soundFileRef.current.click()}>导入…</${Button}>
            </div>
            ${(sounds || []).filter((s) => !s.builtin).map((s) => html`
              <div class="row" key=${s.id} data-testid="sounds.row">
                <span style=${{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>${s.name}</span>
                <${Button} variant="ghost" onClick=${() => pickSound(s.id)}>${soundSet === s.id ? '使用中' : '使用'}</${Button}>
                <${Button} variant=${soundDelId === s.id ? 'danger' : 'secondary'} onClick=${() => deleteSound(s.id)} data-testid="sounds.delete">
                  ${soundDelId === s.id ? '确认删除' : '删除'}
                </${Button}>
              </div>`)}
          </div>
          <input ref=${soundFileRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac" multiple hidden onChange=${onSoundFiles} aria-label="选择音效音频文件（最多 2 个）" />
        </${Card}>
        <${Card} title="气泡模板" class="group">
          <div class="row">
            <span class="small muted">${templates == null ? '加载中…' : (templates.length ? templates.length + ' 个模板' : '未导入模板')}</span>
            <span class="spacer"></span>
            <${Button} onClick=${() => { setJson(JSON.stringify(templates || [], null, 2)); setDialog(true) }}>编辑 JSON</${Button}>
          </div>
        </${Card}>
        <${Card} title="按压泡泡队列" class="group">
          <div class="row">
            <span class="small muted">${queue.length ? queue.length + ' 步（点击气泡推进）' : '未设置队列'}</span>
            <span class="spacer"></span>
            <${Button} onClick=${() => { setQueueJson(JSON.stringify(queue || [], null, 2)); setQueueDialog(true) }}>编辑队列</${Button}>
          </div>
        </${Card}>
      </div>
    </div>

    ${dialog
      ? html`<${Dialog} title="气泡模板 JSON" onClose=${() => setDialog(false)}
          actions=${html`<${Button} onClick=${() => setDialog(false)}>取消</${Button}><${Button} variant="primary" onClick=${saveTemplates}>保存</${Button}>`}>
          <textarea class="textarea" aria-label="气泡模板 JSON" rows="16" style=${{ width: '100%' }} value=${json} onInput=${(e) => setJson(e.currentTarget.value)}></textarea>
          <div class="small muted">格式与旧挂件兼容；保存后由控制台与宠物层共同使用。</div>
        </${Dialog}>`
      : null}

    ${queueDialog
      ? html`<${Dialog} title="按压泡泡队列" onClose=${() => setQueueDialog(false)}
          actions=${html`<${Button} onClick=${() => setQueueDialog(false)}>取消</${Button}><${Button} variant="primary" onClick=${saveQueue}>保存</${Button}>`}>
          <textarea class="textarea" rows="12" style=${{ width: '100%' }} aria-label="泡泡队列 JSON" value=${queueJson} onInput=${(e) => setQueueJson(e.currentTarget.value)}></textarea>
          <div class="small muted">最多 12 步；每项可以是字符串，或 {"text":"…","sub":"…"}。点击宠物气泡按顺序推进。</div>
        </${Dialog}>`
      : null}

    ${importOpen && pending
      ? html`<${Dialog} title="导入角色" onClose=${() => setImportOpen(false)}
          actions=${html`<${Button} onClick=${() => setImportOpen(false)}>取消</${Button}><${Button} variant="primary" onClick=${doImport} loading=${busy}>导入</${Button}>`}>
          <div class="row" style=${{ gap: 16, alignItems: 'flex-start' }}>
            <img src=${pending.dataUrl} alt="预览" style=${{ width: 120, height: 120, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 12 }} />
            <div style=${{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <${Field} label="显示名" hint="最多 24 个字符">
                <${Input} value=${roleName} onInput=${setRoleName} aria-label="角色显示名" />
              </${Field}>
              <${Field} label="角色 id" hint="小写字母/数字/连字符，2–24 位；用作文件名">
                <${Input} value=${roleId} onInput=${setRoleId} aria-label="角色 id" />
              </${Field}>
              <div class="small muted">${pending.width} × ${pending.height} · ${pending.format === 'gif' ? 'GIF 动画' : 'PNG'} · ${(pending.base64.length * 0.75 / 1024).toFixed(0)} KB</div>
            </div>
          </div>
        </${Dialog}>`
      : null}
  </div>`
}
