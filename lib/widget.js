/* ZCode 版 DeepSeek 余额小鲸鱼挂件（前端）
 *
 * 移植自 MeteorNOX/DeepSeek-Balance-Whale-Widget（MIT）的 DSH 网页挂件，
 * 适配点：
 *   - 路由前缀 /dsh-whale/ -> /whale/
 *   - 类名前缀 dshwv- -> zcwv-，localStorage 键 dshw-pos -> zcw-pos
 *   - 台词里指向 dsh 的文案改为 ZCode
 * 其余交互（拖拽、四分之一吸附、左吸附镜像、按压 Q 弹、数字滚动、随机台词、
 * 每轮消耗泡泡、60 秒刷新）与上游一致。
 */
(function () {
  if (window.__zcodeWhaleWidget) return
  window.__zcodeWhaleWidget = true

  var MIN_SCALE = 0.6
  var MAX_SCALE = 2.5
  var CLICK_SQ = 9
  var REFRESH_MS = 60000
  var CHANGE_MS = 900
  var ANIM_MS = 700
  var BUBBLE_MS = 5000
  var FETCH_TIMEOUT_MS = 25000
  var BALANCE_URL = '/whale/balance.json'
  var SIZE_URL = '/whale/size.json'
  var IMG_URL = '/whale/image.png?v=2'
  var GIF_URL = '/whale/rua.gif'
  var LAST_TURN_URL = '/whale/last-turn.json'
  var PLAN_URL = '/whale/plan.json'
  var USAGE_URL = '/whale/usage-records.json'
  var ROLES_URL = '/whale/roles.json'
  var ROLE_UPLOAD_URL = '/whale/role-upload.json'
  var ADJUST_URL = '/whale/balance-adjustments.json'
  var SESSION_URL = '/whale/session.json'
  var POS_KEY = 'zcw-pos'

  // 浮层（桌面置顶窗口）里 preload 会暴露 whaleDesktop；普通浏览器里没有。
  // 这里必须尽早确定：菜单构建时就要据此决定是否显示「跟随延迟」那一行。
  var overlayBridge = typeof window !== 'undefined' && window.whaleDesktop ? window.whaleDesktop : null

  var css = [
    '.zcwv-root{position:fixed;right:0;bottom:0;--zcw-scale:1;--zcw-base:clamp(122px,calc(min(250px,min(100vw,100vh) * 0.28) * var(--zcw-scale)),625px);width:var(--zcw-base);height:var(--zcw-base);pointer-events:none;user-select:none;-webkit-user-select:none;z-index:9999;font-family:inherit;transition:left .16s ease,top .16s ease,transform .3s ease}',
    '.zcwv-root.zcwv-left{transform:scaleX(-1)}',
    // 浮层模式下必须关掉定位过渡：透明窗口一旦对 left/top 做 CSS 过渡，
    // Chromium 会把内容画到偏离窗口的位置（实测鲸鱼会跑到窗口外）。
    // 代价是吸附时少了滑动动画，换来位置绝对正确。
    '.zcwv-root.zcwv-overlay{transition:none}',
    '.zcwv-root.zcwv-dragging{cursor:grabbing;transition:none}',
    '.zcwv-body{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:50% 100%;transition:transform .22s cubic-bezier(.34,1.56,.64,1)}',
    '.zcwv-img{position:absolute;right:0;bottom:0;width:59.45%;height:59.45%;display:block;pointer-events:none;-webkit-user-drag:none;user-select:none}',
    '.zcwv-bubble{position:absolute;left:0;top:0;width:100%;aspect-ratio:1026/700;pointer-events:none;z-index:1;--zcw-u:calc(var(--zcw-base) / 1026)}',
    '.zcwv-bubble svg{display:block;width:100%;height:100%;pointer-events:none}',
    '.zcwv-bubble svg path,.zcwv-bubble svg ellipse{pointer-events:none;cursor:pointer}',
    '.zcwv-bubble.zcwv-bubble-open svg path,.zcwv-bubble.zcwv-bubble-open svg ellipse{pointer-events:visiblePainted}',
    '.zcwv-bubble .zcwv-bshape,.zcwv-bubble .zcwv-b1,.zcwv-bubble .zcwv-b2{opacity:0;transform:scale(.7);transform-box:fill-box;transform-origin:50% 50%;transition:opacity .2s ease,transform .2s ease}',
    '.zcwv-bubble.zcwv-bubble-open .zcwv-bshape,.zcwv-bubble.zcwv-bubble-open .zcwv-b1,.zcwv-bubble.zcwv-bubble-open .zcwv-b2{opacity:1;transform:none}',
    '.zcwv-gif{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);max-width:calc(var(--zcw-u) * 560);max-height:calc(var(--zcw-u) * 400);display:none;opacity:0;transition:opacity .2s ease;pointer-events:none;-webkit-user-drag:none;user-select:none;object-fit:contain}',
    '.zcwv-root.zcwv-left .zcwv-gif{transform:translate(-50%,-50%) scaleX(-1)}',
    '.zcwv-bubble.zcwv-bubble-open .zcwv-gif{opacity:1}',
    '.zcwv-bubble.zcwv-bubble-open .zcwv-b2{transition-delay:0s}',
    '.zcwv-bubble.zcwv-bubble-open .zcwv-b1{transition-delay:.13s}',
    '.zcwv-bubble.zcwv-bubble-open .zcwv-bshape{transition-delay:.26s}',
    '.zcwv-bubble .zcwv-bshape{transition-delay:.1s}',
    '.zcwv-bubble .zcwv-b1{transition-delay:.2s}',
    '.zcwv-bubble .zcwv-b2{transition-delay:.3s}',
    // 气泡本体颜色走主题变量（CSS 规则覆盖 SVG 的 fill/stroke 属性）
    '.zcwv-bubble .zcwv-bshape,.zcwv-bubble .zcwv-b1,.zcwv-bubble .zcwv-b2{fill:var(--zcw-bubble-fill);stroke:var(--zcw-ink)}',
    '.zcwv-text{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);text-align:center;color:var(--zcw-text);line-height:1.15;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .16s ease,transform .3s ease}',
    '.zcwv-bubble.zcwv-bubble-open .zcwv-text{opacity:1;transition:opacity .16s ease .36s,transform .3s ease}',
    '.zcwv-root.zcwv-left .zcwv-text{transform:translate(-50%,-50%) scaleX(-1)}',
    '.zcwv-label{font-size:calc(var(--zcw-u) * 66);font-weight:600;letter-spacing:.06em}',
    '.zcwv-amount{font-size:calc(var(--zcw-u) * 128);font-weight:800;line-height:1.05}',
    '.zcwv-period{font-size:calc(var(--zcw-u) * 104);font-weight:800;line-height:1.05}',
    '.zcwv-wrap{white-space:normal;max-width:calc(var(--zcw-u) * 560);line-height:1.2}',
    '.zcwv-hint{font-size:calc(var(--zcw-u) * 56);color:var(--zcw-text-dim);letter-spacing:.02em;margin-top:calc(var(--zcw-u) * 9);min-height:calc(var(--zcw-u) * 64);line-height:1.15}',
    '.zcwv-menu-btn{position:absolute;top:calc(40.55% + 4px);right:4px;width:26px;height:26px;border:none;border-radius:6px;background:var(--zcw-btn-bg);cursor:pointer;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:0;z-index:2;opacity:0;transition:opacity .15s ease}',
    '.zcwv-menu-btn.zcwv-menu-btn-visible{opacity:1;pointer-events:auto}',
    '.zcwv-menu-btn span{display:block;width:14px;height:2px;background:#fff;border-radius:1px}',
    '.zcwv-menu-btn:hover{background:var(--zcw-btn-bg-hover)}',
    '.zcwv-menu{position:fixed;min-width:196px;background:var(--zcw-panel);border:1px solid var(--zcw-ink-soft);border-radius:10px;padding:10px 12px;opacity:0;transform:scale(.92) translateY(-4px);transform-origin:top right;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);pointer-events:none;z-index:10000;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:var(--zcw-cs)}',
    '.zcwv-menu.zcwv-menu-open{opacity:1;transform:scale(1) translateY(0);pointer-events:auto}',
    '.zcwv-menu-row{display:flex;align-items:center;gap:8px;margin:5px 0;color:var(--zcw-ink);font-size:12px;white-space:nowrap}',
    '.zcwv-range{flex:1;min-width:0;accent-color:var(--zcw-accent)}',
    '.zcwv-number{width:44px;border:1px solid var(--zcw-ink-input);border-radius:6px;padding:2px 4px;font-size:12px;color:var(--zcw-ink);background:var(--zcw-card);box-sizing:border-box}',
    '.zcwv-number:disabled{opacity:.4;background:var(--zcw-ink-faint);cursor:not-allowed}',
    '.zcwv-sound{flex:1;border:1px solid var(--zcw-ink-input);border-radius:6px;background:var(--zcw-ink-faint);color:var(--zcw-ink);font-size:12px;padding:3px 0;cursor:pointer}',
    '.zcwv-sound:hover{background:var(--zcw-ink-soft)}',
    '.zcwv-check{width:16px;height:16px;accent-color:var(--zcw-accent);cursor:pointer;flex:0 0 auto}',
    '.zcwv-menu-sep{height:1px;background:var(--zcw-ink-sep);margin:6px 0}',
    '.zcwv-volpct{width:44px;text-align:right;color:var(--zcw-ink);font-size:12px}',
    // ---------- 主题变量：浅色 = 原版蓝系；深色 = ZCode zai-dark 实测 token ----------
    ':root{--zcw-cs:light;--zcw-text:#536ba9;--zcw-text-dim:#9fb0d9;--zcw-ink:#203170;--zcw-ink-hover:#2f4488;--zcw-ink-soft:rgba(32,49,112,.35);--zcw-ink-faint:rgba(32,49,112,.08);--zcw-ink-sep:rgba(32,49,112,.25);--zcw-ink-input:rgba(32,49,112,.4);--zcw-btn-bg:rgba(32,49,112,.85);--zcw-btn-bg-hover:#203170;--zcw-panel:rgba(255,255,255,.92);--zcw-card:#fff;--zcw-bubble-fill:#fff;--zcw-red:#e0433f;--zcw-green:#2fa24c;--zcw-accent:#203170}',
    ':root.zcw-theme-dark{--zcw-cs:dark;--zcw-text:#d4d4d4;--zcw-text-dim:rgba(212,212,212,.6);--zcw-ink:#d4d4d4;--zcw-ink-hover:#fff;--zcw-ink-soft:rgba(255,255,255,.16);--zcw-ink-faint:rgba(255,255,255,.08);--zcw-ink-sep:rgba(255,255,255,.12);--zcw-ink-input:rgba(255,255,255,.2);--zcw-btn-bg:rgba(64,153,255,.9);--zcw-btn-bg-hover:#4099ff;--zcw-panel:rgba(43,43,43,.96);--zcw-card:#2b2b2b;--zcw-bubble-fill:#2b2b2b;--zcw-red:#ff5c5c;--zcw-green:#46bf72;--zcw-accent:#4099ff}',
    // ---------- 用量记录面板 ----------
    '.zcw-panel{position:fixed;width:320px;max-width:92vw;max-height:72vh;overflow:auto;background:var(--zcw-panel);border:1px solid var(--zcw-ink-soft);border-radius:10px;padding:10px 12px;z-index:10001;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:var(--zcw-cs);font-size:12px;color:var(--zcw-ink);opacity:0;transform:scale(.96);transform-origin:top right;transition:opacity .15s ease,transform .15s ease;pointer-events:none}',
    '.zcw-panel.zcw-panel-open{opacity:1;transform:none;pointer-events:auto}',
    '.zcw-panel h4{margin:8px 0 4px;font-size:12px;font-weight:600}',
    '.zcw-panel h4:first-child{margin-top:0}',
    '.zcw-bar{height:8px;border-radius:4px;background:var(--zcw-ink-faint);overflow:hidden;margin:2px 0 6px}',
    '.zcw-bar > i{display:block;height:100%;background:var(--zcw-accent)}',
    '.zcw-row{display:flex;justify-content:space-between;gap:8px;margin:2px 0;white-space:nowrap;align-items:center}',
    '.zcw-dim{color:var(--zcw-text-dim)}',
    '.zcw-red{color:var(--zcw-red)}',
    '.zcw-events{max-height:170px;overflow:auto;border-top:1px solid var(--zcw-ink-soft);margin-top:6px;padding-top:4px}',
    '.zcw-panel-close{border:1px solid var(--zcw-ink-soft);background:var(--zcw-card);border-radius:6px;color:var(--zcw-ink);cursor:pointer;font-size:11px;padding:2px 8px}',
  ].join('\n')

  var styleEl = document.createElement('style')
  styleEl.textContent = css
  document.head.appendChild(styleEl)

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = text
    return n
  }

  var root = el('div', 'zcwv-root')

  var img = el('img', 'zcwv-img')
  img.src = IMG_URL
  img.alt = 'DeepSeek 余额'
  img.draggable = false

  var menuBtn = el('button', 'zcwv-menu-btn')
  menuBtn.type = 'button'
  menuBtn.title = '菜单'
  menuBtn.innerHTML = '<span></span><span></span><span></span>'
  menuBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    toggleMenu()
  })

  // ---------- 菜单 ----------
  var menuBox = el('div', 'zcwv-menu')
  function menuLabel(text) {
    return el('span', '', text)
  }
  function menuRow() {
    return el('div', 'zcwv-menu-row')
  }

  var scaleInput = el('input', 'zcwv-range')
  scaleInput.type = 'range'
  scaleInput.min = String(MIN_SCALE)
  scaleInput.max = String(MAX_SCALE)
  scaleInput.step = '0.1'
  scaleInput.value = '1.5'
  var scaleNumber = el('input', 'zcwv-number')
  scaleNumber.type = 'number'
  scaleNumber.min = '1'
  scaleNumber.max = '20'
  scaleNumber.step = '1'
  scaleNumber.value = '10'
  // 拖动滑块期间必须禁用过渡：CSS 过渡在 JS 块之后求值，否则会以错误的
  // 中心缩放而抖动。
  scaleInput.addEventListener('pointerdown', function () {
    root.style.transition = 'none'
  })
  scaleInput.addEventListener('input', function () {
    setScale(scaleInput.value)
  })
  scaleInput.addEventListener('change', function () {
    root.style.transition = ''
  })
  scaleNumber.addEventListener('focus', function () {
    root.style.transition = 'none'
  })
  scaleNumber.addEventListener('blur', function () {
    root.style.transition = ''
  })
  function scaleNumberToScale(v) {
    var n = Math.round(Number(v))
    return MIN_SCALE + Math.max(0, Math.min(20, n) - 1) * (MAX_SCALE - MIN_SCALE) / 19
  }
  scaleNumber.addEventListener('input', function () {
    setScale(scaleNumberToScale(scaleNumber.value))
  })
  scaleNumber.addEventListener('change', function () {
    setScale(scaleNumberToScale(scaleNumber.value))
    root.style.transition = ''
  })

  function soundOpt(value, label) {
    var o = document.createElement('option')
    o.value = value
    o.textContent = label
    return o
  }
  var soundSelect = el('select', 'zcwv-sound')
  soundSelect.appendChild(soundOpt('duck', '小黄鸭'))
  soundSelect.appendChild(soundOpt('fx1', '音效1'))
  soundSelect.addEventListener('change', function () {
    setSoundSet(soundSelect.value)
  })
  var usageSelect = el('select', 'zcwv-sound')
  usageSelect.appendChild(soundOpt('ledger', '小鲸鱼记账 (推荐)'))
  usageSelect.appendChild(soundOpt('token', '实时·令牌 (需平台令牌)'))
  usageSelect.addEventListener('change', function () {
    setUsageMode(usageSelect.value)
  })
  var peakSelect = el('select', 'zcwv-sound')
  peakSelect.appendChild(soundOpt('default', '默认'))
  peakSelect.appendChild(soundOpt('liangwen', '梁文峰谷'))
  peakSelect.appendChild(soundOpt('qiangqiang', '!?强强?!'))
  peakSelect.addEventListener('change', function () {
    setPeakMode(peakSelect.value)
  })
  var themeSelect = el('select', 'zcwv-sound')
  themeSelect.appendChild(soundOpt('light', '浅色（原版）'))
  themeSelect.appendChild(soundOpt('dark', '深色（ZCode）'))
  themeSelect.addEventListener('change', function () {
    setTheme(themeSelect.value)
  })
  function setTheme(v) {
    themeMode = v === 'dark' ? 'dark' : 'light'
    themeSelect.value = themeMode
    try {
      document.documentElement.classList.toggle('zcw-theme-dark', themeMode === 'dark')
    } catch (err) {}
    saveConfig()
  }
  var displaySelect = el('select', 'zcwv-sound')
  displaySelect.appendChild(soundOpt('auto', '自动跟随'))
  displaySelect.appendChild(soundOpt('plan', 'Plan 配额'))
  displaySelect.appendChild(soundOpt('glm', 'GLM 按量'))
  displaySelect.appendChild(soundOpt('ds', 'DeepSeek'))
  displaySelect.addEventListener('change', function () {
    setDisplayMode(displaySelect.value)
  })
  function setDisplayMode(v) {
    displayMode = ['auto', 'plan', 'glm', 'ds'].indexOf(v) !== -1 ? v : 'auto'
    displaySelect.value = displayMode
    saveConfig()
    render()
  }

  // 跟随延迟（只在浮层模式下有意义）：探测 ZCode 窗口位置的间隔。
  // 越短鲸鱼跟得越紧；每次探测只有几个微秒级的系统调用，所以「极快」也不会
  // 给系统带来可见负担。
  var FOLLOW_KEY = 'zcw-follow-ms'
  var followSelect = el('select', 'zcwv-sound')
  ;[
    ['16', '极快 · 16ms'],
    ['25', '很快 · 25ms'],
    ['40', '默认 · 40ms'],
    ['60', '较快 · 60ms'],
    ['100', '省电 · 100ms'],
    ['250', '很省电 · 250ms'],
  ].forEach(function (o) {
    followSelect.appendChild(soundOpt(o[0], o[1]))
  })
  function setFollowInterval(ms) {
    var n = Math.max(16, Math.min(2000, Math.round(Number(ms) || 40)))
    followSelect.value = String(n)
    try {
      localStorage.setItem(FOLLOW_KEY, String(n))
    } catch (err) {}
    if (overlayBridge && typeof overlayBridge.setFollowInterval === 'function') {
      try {
        overlayBridge.setFollowInterval(n)
      } catch (err) {}
    }
  }
  followSelect.addEventListener('change', function () {
    setFollowInterval(followSelect.value)
  })
  function initFollowInterval() {
    var saved = 40
    try {
      var raw = localStorage.getItem(FOLLOW_KEY)
      if (raw) saved = Number(raw)
    } catch (err) {}
    followSelect.value = String(saved)
    if (overlayBridge && typeof overlayBridge.setFollowInterval === 'function') {
      try {
        overlayBridge.setFollowInterval(saved)
      } catch (err) {}
    }
  }

  var bubbleToggle = el('input', 'zcwv-check')
  bubbleToggle.type = 'checkbox'
  bubbleToggle.checked = true
  bubbleToggle.title = '开启/关闭思考气泡'
  bubbleToggle.addEventListener('change', function () {
    setBubbleOn(bubbleToggle.checked)
  })
  var turnCostToggle = el('input', 'zcwv-check')
  turnCostToggle.type = 'checkbox'
  turnCostToggle.checked = true
  turnCostToggle.title = '每轮对话结束后自动显示本轮消耗金额'
  turnCostToggle.addEventListener('change', function () {
    setTurnCostOn(turnCostToggle.checked)
  })
  var turnCostCloseInput = el('input', 'zcwv-number')
  turnCostCloseInput.type = 'number'
  turnCostCloseInput.min = '0'
  turnCostCloseInput.step = '1'
  turnCostCloseInput.value = '5'
  turnCostCloseInput.title = '填 0 表示不自动关闭，需手动点击关闭'
  turnCostCloseInput.addEventListener('input', function () {
    setTurnCostClose(turnCostCloseInput.value)
  })
  turnCostCloseInput.addEventListener('change', function () {
    setTurnCostClose(turnCostCloseInput.value)
  })

  var scrollGapToggle = el('input', 'zcwv-check')
  scrollGapToggle.type = 'checkbox'
  scrollGapToggle.checked = false
  scrollGapToggle.title = '开启后挂件右侧按设定像素避开滚动条；关闭则贴边'
  scrollGapToggle.addEventListener('change', function () {
    setScrollGapOn(scrollGapToggle.checked)
  })

  // 预警阈值输入（0/空 = 关闭）：Plan 剩余% / DeepSeek 余额¥ / BigModel 按量今日¥
  function makeAlertInput(title, max) {
    var n = el('input', 'zcwv-number')
    n.type = 'number'
    n.min = '0'
    if (max) n.max = String(max)
    n.step = '1'
    n.value = '0'
    n.title = title
    return n
  }
  var alertPlanInput = makeAlertInput('Plan 剩余低于该百分比时提醒，0 关闭', 100)
  var alertDsInput = makeAlertInput('DeepSeek 余额低于该值（元）时提醒，0 关闭')
  var alertBmInput = makeAlertInput('GLM 按量今日已用超过该值（元）时提醒，0 关闭')
  function wireAlertInput(input, key) {
    var apply = function () {
      alerts[key] = Math.max(0, Number(input.value) || 0)
      saveConfig()
    }
    input.addEventListener('input', apply)
    input.addEventListener('change', apply)
  }
  wireAlertInput(alertPlanInput, 'planPct')
  wireAlertInput(alertDsInput, 'deepseekBelow')
  wireAlertInput(alertBmInput, 'bigmodelDaily')

  // 自定义角色：上传本地图片为鲸鱼形象（选择持久化到服务端 widget-state.roleId）
  var roleSelect = el('select', 'zcwv-sound')
  roleSelect.title = '选择鲸鱼形象'
  roleSelect.appendChild(soundOpt('', '默认'))
  var roleFile = el('input')
  roleFile.type = 'file'
  roleFile.accept = 'image/png,image/gif,image/jpeg'
  roleFile.style.display = 'none'
  var roleImportBtn = el('button', 'zcwv-sound', '导入图片…')
  roleImportBtn.type = 'button'
  roleImportBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    roleFile.click()
  })
  roleFile.addEventListener('change', function () {
    var f = roleFile.files && roleFile.files[0]
    roleFile.value = ''
    if (!f) return
    // >1.5MB 的位图先在前端等比缩到最长边 1200px（GIF 缩放会丢动画，保持原样）：
    // 既保证传得动，也避免拿截图当头像直接被 3MB 上限拒掉。
    var isGif = /gif$/i.test(f.type || '')
    if (f.size > 1.5 * 1024 * 1024 && !isGif) {
      var big = new Image()
      big.onload = function () {
        try {
          var maxSide = 1200
          var ratio = Math.min(1, maxSide / Math.max(big.naturalWidth, big.naturalHeight))
          var canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(big.naturalWidth * ratio))
          canvas.height = Math.max(1, Math.round(big.naturalHeight * ratio))
          canvas.getContext('2d').drawImage(big, 0, 0, canvas.width, canvas.height)
          uploadRole(canvas.toDataURL('image/png'), f.name)
        } catch (err) {
          showAlertBubble('角色上传失败', '图片处理失败')
        }
      }
      big.onerror = function () {
        showAlertBubble('角色上传失败', '图片无法读取')
      }
      big.src = URL.createObjectURL(f)
      return
    }
    var reader = new FileReader()
    reader.onload = function () {
      uploadRole(String(reader.result), f.name)
    }
    reader.onerror = function () {
      showAlertBubble('角色上传失败', '文件读取失败')
    }
    reader.readAsDataURL(f)
  })
  function uploadRole(dataUrl, name) {
    try {
      fetch(ROLE_UPLOAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, dataUrl: dataUrl }),
      })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (d && d.ok) {
            setRoleId(d.id)
            loadRoles()
          } else {
            // 失败必须可见：之前静默吞掉，用户只会看到「没有反应」
            showAlertBubble('角色上传失败', (d && d.error) || '未知错误')
          }
        })
        .catch(function () {
          showAlertBubble('角色上传失败', '请求未送达（挂件服务未运行？）')
        })
    } catch (err) {}
  }
  function loadRoles() {
    try {
      fetch(ROLES_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok) return
          while (roleSelect.firstChild) roleSelect.removeChild(roleSelect.firstChild)
          roleSelect.appendChild(soundOpt('', '默认'))
          ;(d.roles || []).forEach(function (r) {
            roleSelect.appendChild(soundOpt(r.id, r.name || r.id))
          })
          roleSelect.value = d.selected || ''
        })
        .catch(function () {})
    } catch (err) {}
  }
  roleSelect.addEventListener('change', function () {
    setRoleId(roleSelect.value)
  })
  function setRoleId(id) {
    roleId = id || null
    roleSelect.value = roleId || ''
    saveConfig()
    img.src = IMG_URL + '&t=' + Date.now() // 强刷图片缓存
  }

  // 余额校正（DeepSeek 观测账本）：把充值等余额调整折算进当日消费
  var corrCredits = el('input', 'zcwv-number')
  corrCredits.type = 'number'
  corrCredits.min = '0'
  corrCredits.step = '0.01'
  corrCredits.value = '0'
  corrCredits.title = '本统计区间累计到账金额（元），未充值填 0'
  var corrOther = el('input', 'zcwv-number')
  corrOther.type = 'number'
  corrOther.min = '0'
  corrOther.step = '0.01'
  corrOther.value = '0'
  corrOther.title = '非调用扣减（元），如转账/退款'
  var corrBtn = el('button', 'zcwv-sound', '余额校正')
  corrBtn.type = 'button'
  corrBtn.title = '按「当日起点 + 累计到账 − 非调用扣减 − 当前余额」重算今日已用'
  corrBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    try {
      fetch(ADJUST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credits: Number(corrCredits.value) || 0, otherDebits: Number(corrOther.value) || 0 }),
      })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (d && d.ok) showAlertBubble('余额校正已生效', '今日已用 ' + fmtMoney(d.todayUsage))
          else showAlertBubble('余额校正失败', (d && d.error) || '未知错误')
          refresh(false)
        })
        .catch(function () {})
    } catch (err) {}
  })
  var scrollGapInput = el('input', 'zcwv-number')
  scrollGapInput.type = 'number'
  scrollGapInput.min = '0'
  scrollGapInput.step = '1'
  scrollGapInput.value = '17'
  scrollGapInput.disabled = true
  scrollGapInput.title = '避让滚动条的像素宽度，填 0 表示贴边'
  scrollGapInput.addEventListener('input', function () {
    setScrollGapPx(scrollGapInput.value)
  })
  scrollGapInput.addEventListener('change', function () {
    setScrollGapPx(scrollGapInput.value)
  })

  var volInput = el('input', 'zcwv-range')
  volInput.type = 'range'
  volInput.min = '0'
  volInput.max = '1'
  volInput.step = '0.05'
  volInput.value = '0.9'
  var volPct = el('span', 'zcwv-volpct', '90%')
  volInput.addEventListener('input', function () {
    setVol(volInput.value)
  })

  function buildMenu() {
    var r1 = menuRow()
    r1.appendChild(menuLabel('大小'))
    r1.appendChild(scaleInput)
    r1.appendChild(scaleNumber)
    var r2 = menuRow()
    r2.appendChild(menuLabel('音效'))
    r2.appendChild(soundSelect)
    var r3 = menuRow()
    r3.appendChild(menuLabel('音量'))
    r3.appendChild(volInput)
    r3.appendChild(volPct)
    var r4 = menuRow()
    r4.appendChild(menuLabel('用量'))
    r4.appendChild(usageSelect)
    var r5 = menuRow()
    r5.appendChild(menuLabel('峰谷'))
    r5.appendChild(peakSelect)
    var rTheme = menuRow()
    rTheme.appendChild(menuLabel('主题'))
    rTheme.appendChild(themeSelect)
    var rDisplay = menuRow()
    rDisplay.appendChild(menuLabel('显示'))
    rDisplay.appendChild(displaySelect)
    var r6 = menuRow()
    r6.appendChild(menuLabel('气泡'))
    r6.appendChild(bubbleToggle)
    var r7 = menuRow()
    r7.appendChild(menuLabel('每轮消耗提示'))
    r7.appendChild(turnCostToggle)
    r7.appendChild(menuLabel('自动关闭'))
    r7.appendChild(turnCostCloseInput)
    r7.appendChild(menuLabel('秒'))
    var sep = el('div', 'zcwv-menu-sep')
    var r9 = menuRow()
    r9.appendChild(menuLabel('避让滚动条'))
    r9.appendChild(scrollGapToggle)
    r9.appendChild(menuLabel('宽度'))
    r9.appendChild(scrollGapInput)
    r9.appendChild(menuLabel('px'))
    var rUsage = menuRow()
    var usageBtn = el('button', 'zcwv-sound', '用量记录…')
    usageBtn.type = 'button'
    usageBtn.title = '今日 / 近 7 天 / 逐条明细'
    usageBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleUsagePanel()
    })
    rUsage.appendChild(usageBtn)
    var rAlert1 = menuRow()
    rAlert1.appendChild(menuLabel('预警 Plan%'))
    rAlert1.appendChild(alertPlanInput)
    var rAlert2 = menuRow()
    rAlert2.appendChild(menuLabel('DS¥'))
    rAlert2.appendChild(alertDsInput)
    rAlert2.appendChild(menuLabel('BM¥'))
    rAlert2.appendChild(alertBmInput)
    var rRole = menuRow()
    rRole.appendChild(menuLabel('角色'))
    rRole.appendChild(roleSelect)
    rRole.appendChild(roleImportBtn)
    var rCorr1 = menuRow()
    rCorr1.appendChild(corrBtn)
    var rCorr2 = menuRow()
    rCorr2.appendChild(menuLabel('到账¥'))
    rCorr2.appendChild(corrCredits)
    rCorr2.appendChild(menuLabel('扣减¥'))
    rCorr2.appendChild(corrOther)
    // 跟随延迟只对浮层生效，浏览器模式整行不显示
    var r10 = menuRow()
    r10.appendChild(menuLabel('跟随延迟'))
    r10.appendChild(followSelect)
    var rows = [r1, r2, r3, r4, r5, rTheme, rDisplay, r6, r7, sep]
    if (!overlayBridge) rows.push(r9)
    else rows.push(r9, r10)
    rows.push(rUsage, sep, rAlert1, rAlert2, rRole, rCorr1, rCorr2)
    rows.forEach(function (n) {
      menuBox.appendChild(n)
    })
  }
  buildMenu()

  // ---------- 气泡与文字 ----------
  var textBox = el('div', 'zcwv-text')
  var labelEl = el('div', 'zcwv-label', 'DeepSeek 余额')
  var amountEl = el('div', 'zcwv-amount')
  var hintEl = el('div', 'zcwv-hint')
  textBox.appendChild(labelEl)
  textBox.appendChild(amountEl)
  textBox.appendChild(hintEl)

  var bubbleBox = el('div', 'zcwv-bubble')
  // 气泡几何与上游一致：viewBox 1026x700，大椭圆 + 尾巴半椭圆 + 两个小气泡
  bubbleBox.innerHTML =
    '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
    '<path class="zcwv-bshape" fill="#FFFFFF" stroke="#203170" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
    '<ellipse class="zcwv-b1" cx="352" cy="561" rx="37.5" ry="26" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '<ellipse class="zcwv-b2" cx="442" cy="646" rx="24.5" ry="18" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '</svg>'
  var gifEl = el('img', 'zcwv-gif')
  gifEl.src = GIF_URL
  gifEl.alt = ''
  gifEl.draggable = false
  var gifFailed = false
  gifEl.onerror = function () {
    gifFailed = true
  }
  bubbleBox.appendChild(gifEl)
  bubbleBox.appendChild(textBox)

  var body = el('div', 'zcwv-body')
  body.appendChild(img)
  body.appendChild(bubbleBox)
  root.appendChild(body)
  root.appendChild(menuBtn)
  document.body.appendChild(root)
  document.body.appendChild(menuBox)

  // 定位模型：位置一律用 left/top 像素表达，这样贴边吸附两轴都能走 CSS 过渡
  // （换成 left:auto/right:0 无法在 auto 与数值间插值，右侧吸附会闪现）。
  // 吸附锚点 (h/v + 偏移) 存在 state 里，settle() 在窗口 resize 与缩放时
  // 按锚点重算，让已吸附的挂件保持贴边。
  var state = {
    scale: 1.5,
    h: 'right',
    hOff: 0,
    v: 'bottom',
    vOff: 0,
    left: 0,
    top: 0,
    balance: null,
    currency: null,
    todayUsage: null,
    isPeak: false,
    status: 'loading',
    message: '',
  }
  var busy = false
  var settleTimer = null
  var animDelayTimer = null
  var drag = null
  var shown = null
  var planState = null // ZCode Plan 配额（/whale/plan.json），见底部 pollPlan
  var animId = null
  var bubbleShown = false
  var bubbleTimer = null
  var bubbleRandomActive = false
  var bubbleRandomLines = null
  var bubbleSwapTimer = null
  var hintFadeTimer = null
  var gifFadeTimer = null
  var lastHintText = null
  var BUBBLE_STYLE_CLASS = { A: 'zcwv-label', B: 'zcwv-amount', P: 'zcwv-period', C: 'zcwv-hint' }

  function pickOne(arr) {
    return arr[Math.floor(Math.random() * arr.length)]
  }
  function singleCenter(style, text, color, wrap) {
    return [null, { t: text, s: style, c: color || '', w: !!wrap }, null]
  }

  // 台词组一：当前峰谷时段 + 今日已用
  function buildGroup1() {
    var peak = !!state.isPeak
    var offText = '空闲时段'
    var peakText = '高峰时段'
    if (peakMode === 'liangwen') {
      offText = '梁文谷'
      peakText = '梁文峰'
    } else if (peakMode === 'qiangqiang') {
      offText = '!?谷谷?!'
      peakText = '!?峰峰?!'
    }
    return [
      { t: '当前时间段为:', s: 'A', c: '' },
      { t: peak ? peakText : offText, s: 'P', c: peak ? 'var(--zcw-red)' : 'var(--zcw-green)' },
      { t: '今日已用 ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' },
    ]
  }
  var RANDOM_GROUPS = [
    { w: 45, lines: buildGroup1 },
    {
      w: 7,
      lines: function () {
        return singleCenter('B', pickOne(['好模型... ↓', '好女孩...↓']))
      },
    },
    {
      w: 7,
      lines: function () {
        return singleCenter(
          'A',
          pickOne([
            '不知道用户有什么用，先赶走吧~',
            '我...我...我也要挣钱吗？',
            '我去吃饭啦，测完叫我',
            '压力一只蓝色大肥鱼？！',
            'DeepSleep...',
            '坏了...用户彻底怒了！',
          ]),
          '',
          true
        )
      },
    },
    { w: 10, lines: function () { return { gif: true } } },
    {
      w: 3,
      lines: function () {
        return singleCenter(
          'A',
          pickOne([
            '你目录里的 .zcode 是什么...大烧货吗...?',
            '恭喜你实现token自由！token全跑了！',
            '真当我是便宜货啊...',
          ]),
          '',
          true
        )
      },
    },
    { w: 1, lines: function () { return singleCenter('B', '哦鲸鲸... ') } },
  ]
  function pickRandomLines() {
    var total = 0
    var i
    for (i = 0; i < RANDOM_GROUPS.length; i++) total += RANDOM_GROUPS[i].w
    var r = Math.random() * total
    for (i = 0; i < RANDOM_GROUPS.length; i++) {
      r -= RANDOM_GROUPS[i].w
      if (r < 0) return RANDOM_GROUPS[i].lines()
    }
    return RANDOM_GROUPS[RANDOM_GROUPS.length - 1].lines()
  }

  function applyBubbleLines(lines) {
    if (lines && lines.gif) {
      // gif 台词组：只显示 gif，三行文字隐藏（display 必须显式覆盖 CSS 的 none）
      if (gifFailed) {
        // gif 缺失时降级成文字，避免出现空白气泡
        lines = singleCenter(
          'A',
          pickOne(['gif 加载失败了...', '今天没有动图给你看~', '呜呜 动图不见了...']),
          '',
          true
        )
      } else {
        if (gifFadeTimer) {
          clearTimeout(gifFadeTimer)
          gifFadeTimer = null
        }
        gifEl.style.display = 'block'
        gifEl.style.opacity = ''
        labelEl.style.display = 'none'
        amountEl.style.display = 'none'
        hintEl.style.display = 'none'
        return
      }
    }
    if (gifFadeTimer) {
      clearTimeout(gifFadeTimer)
      gifFadeTimer = null
    }
    gifEl.style.display = 'none'
    gifEl.style.opacity = ''
    var els = [labelEl, amountEl, hintEl]
    for (var i = 0; i < 3; i++) {
      var node = els[i]
      var ln = lines && lines[i]
      if (ln) {
        node.style.display = ''
        node.className = (BUBBLE_STYLE_CLASS[ln.s] || 'zcwv-label') + (ln.w ? ' zcwv-wrap' : '')
        node.textContent = ln.t
        node.style.color = ln.c || ''
      } else {
        node.style.display = 'none'
        node.textContent = ''
        node.style.color = ''
      }
    }
  }

  // 首次（含恢复）直接写文本、不做淡出淡入，否则气泡打开或按压重开时会
  // 先淡出再淡入，看起来像"消失一下又出现"。只有气泡打开期间的内容变化
  // （加载中→今日已用）才走动画。
  function setHint(text) {
    if (text === lastHintText) return
    var first = lastHintText === null
    lastHintText = text
    if (first || !bubbleShown) {
      hintEl.textContent = text
      return
    }
    hintEl.style.transition = 'opacity .18s ease'
    hintEl.style.opacity = '0'
    hintFadeTimer = setTimeout(function () {
      hintFadeTimer = null
      hintEl.textContent = text
      hintEl.style.opacity = '1'
      setTimeout(function () {
        hintEl.style.transition = ''
        hintEl.style.opacity = ''
      }, 220)
    }, 190)
  }

  function swapBubbleContent(applyFn) {
    if (bubbleSwapTimer) {
      clearTimeout(bubbleSwapTimer)
      bubbleSwapTimer = null
    }
    textBox.style.transition = 'opacity .18s ease'
    textBox.style.opacity = '0'
    bubbleSwapTimer = setTimeout(function () {
      bubbleSwapTimer = null
      applyFn()
      textBox.style.opacity = '1'
      setTimeout(function () {
        textBox.style.transition = ''
        textBox.style.opacity = ''
      }, 220)
    }, 190)
  }

  function restoreBubbleLines() {
    if (bubbleSwapTimer) {
      clearTimeout(bubbleSwapTimer)
      bubbleSwapTimer = null
    }
    if (hintFadeTimer) {
      clearTimeout(hintFadeTimer)
      hintFadeTimer = null
    }
    if (gifFadeTimer) {
      clearTimeout(gifFadeTimer)
      gifFadeTimer = null
    }
    lastHintText = null
    textBox.style.transition = ''
    textBox.style.opacity = ''
    gifEl.style.display = 'none'
    gifEl.style.opacity = ''
    labelEl.style.display = ''
    labelEl.className = 'zcwv-label'
    labelEl.textContent = 'DeepSeek 余额'
    labelEl.style.color = ''
    amountEl.style.display = ''
    amountEl.className = 'zcwv-amount'
    amountEl.style.color = ''
    hintEl.style.display = ''
    hintEl.className = 'zcwv-hint'
    hintEl.style.color = ''
    render()
  }

  function showBubble() {
    if (!bubbleOn) return
    // 消耗金额泡泡显示期间，余额变动不再弹普通泡泡
    if (costBubbleActive) return
    if (bubbleTimer) {
      clearTimeout(bubbleTimer)
      bubbleTimer = null
    }
    if (gifFadeTimer) {
      clearTimeout(gifFadeTimer)
      gifFadeTimer = null
    }
    bubbleShown = true
    bubbleRandomActive = false
    restoreBubbleLines()
    bubbleBox.classList.add('zcwv-bubble-open')
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  }

  function hideBubble() {
    if (bubbleTimer) {
      clearTimeout(bubbleTimer)
      bubbleTimer = null
    }
    if (bubbleSwapTimer) {
      clearTimeout(bubbleSwapTimer)
      bubbleSwapTimer = null
    }
    if (hintFadeTimer) {
      clearTimeout(hintFadeTimer)
      hintFadeTimer = null
    }
    textBox.style.transition = ''
    textBox.style.opacity = ''
    hintEl.style.transition = ''
    hintEl.style.opacity = ''
    bubbleRandomActive = false
    bubbleRandomLines = null
    bubbleShown = false
    // 三行文字保持现状让气泡自然淡出（关闭瞬间恢复余额内容会让随机台词
    // 界面闪现余额），恢复交给下次 showBubble() 的 restoreBubbleLines()。
    bubbleBox.classList.remove('zcwv-bubble-open')
    // gif 靠 CSS opacity 淡出；display:none 会跳过过渡，须等淡出完成
    gifFadeTimer = setTimeout(function () {
      gifFadeTimer = null
      gifEl.style.display = 'none'
    }, 240)
    syncOverlayInteractive()
  }

  bubbleBox.addEventListener('click', function (e) {
    e.stopPropagation()
    if (!bubbleShown) return
    if (costBubbleActive) {
      hideCostBubble()
      return
    }
    if (bubbleRandomActive) {
      hideBubble()
      return
    }
    // 首次点击切到随机台词段，并重置自动关闭计时——保证第二段台词有完整
    // 停留时间（否则第 4 秒点击只看得到 0.5 秒）。
    bubbleRandomActive = true
    bubbleRandomLines = pickRandomLines()
    swapBubbleContent(function () {
      applyBubbleLines(bubbleRandomLines)
    })
    if (bubbleTimer) {
      clearTimeout(bubbleTimer)
      bubbleTimer = null
    }
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  })

  // ---------- 每轮对话消耗金额泡泡 ----------
  var costBubbleTimer = null
  function formatTokens(n) {
    var v = Number(n) || 0
    if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿'
    if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万'
    return v.toLocaleString('en-US')
  }
  function showCostBubble(turn) {
    if (!bubbleOn || !turnCostOn) return
    if (costBubbleTimer) {
      clearTimeout(costBubbleTimer)
      costBubbleTimer = null
    }
    if (bubbleTimer) {
      clearTimeout(bubbleTimer)
      bubbleTimer = null
    }
    if (gifFadeTimer) {
      clearTimeout(gifFadeTimer)
      gifFadeTimer = null
    }
    // 取消进行中的余额滚动与延迟计时器，避免竞态覆盖成本金额
    if (animId) {
      cancelAnimationFrame(animId)
      animId = null
    }
    if (animDelayTimer) {
      clearTimeout(animDelayTimer)
      animDelayTimer = null
    }
    if (settleTimer) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    costBubbleActive = true
    bubbleRandomActive = false
    bubbleShown = true
    lastHintText = null
    gifEl.style.display = 'none'
    gifEl.style.opacity = ''
    labelEl.style.display = ''
    labelEl.className = 'zcwv-label'
    amountEl.style.display = ''
    amountEl.className = 'zcwv-amount'
    if (turn && turn.billable === false) {
      // 该轮供应商没有价目（订阅套餐/网关等）：金额是虚构的，改按 tokens 口径
      labelEl.textContent = '本轮 tokens:'
      labelEl.style.color = ''
      amountEl.textContent = formatTokens(turn.tokens)
      amountEl.style.color = 'var(--zcw-red)'
      if (turn.quotaPct != null) {
        // 计划扣费：附「占当前配额百分比」（来自客户端日志的最近配额观测）
        hintEl.style.display = ''
        hintEl.textContent = '占当前配额 ' + turn.quotaPct + '%'
        hintEl.style.color = ''
      } else {
        hintEl.style.display = 'none'
        hintEl.textContent = ''
        hintEl.style.color = ''
      }
    } else {
      labelEl.textContent = '上一轮对话消耗:'
      labelEl.style.color = ''
      amountEl.textContent = '¥ ' + (turn && isFinite(turn.amount) ? Number(turn.amount).toFixed(2) : '--')
      amountEl.style.color = 'var(--zcw-red)'
      hintEl.style.display = 'none'
      hintEl.textContent = ''
      hintEl.style.color = ''
    }
    hintEl.style.display = 'none'
    hintEl.textContent = ''
    hintEl.style.color = ''
    textBox.style.transition = ''
    textBox.style.opacity = ''
    bubbleBox.classList.add('zcwv-bubble-open')
    if (turnCostCloseMs > 0) {
      costBubbleTimer = setTimeout(hideCostBubble, turnCostCloseMs)
    }
  }
  function hideCostBubble() {
    if (costBubbleTimer) {
      clearTimeout(costBubbleTimer)
      costBubbleTimer = null
    }
    costBubbleActive = false
    hideBubble()
  }

  // ---------- 定位 ----------
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v
  }
  function pageViewport() {
    // position:fixed 元素的参照系永远是页面自身视口。浮层里这个视口是铺满
    // 整个工作区的浮层窗口，跟 viewport() 返回的「ZCode 窗口矩形」不是一回事，
    // 两者混用会把菜单之类的 fixed 元素定位到屏幕外（窗口化时必现）。
    return {
      w: window.innerWidth || document.documentElement.clientWidth || 1280,
      h: window.innerHeight || document.documentElement.clientHeight || 800,
    }
  }
  function viewport() {
    // 浮层里「视口」= ZCode 窗口矩形，而不是整个屏幕
    if (externalViewport) return { w: externalViewport.w, h: externalViewport.h }
    return pageViewport()
  }
  function rightGap() {
    if (!scrollGapOn) return 0
    return scrollGapPx > 0 ? scrollGapPx : 0
  }
  function fmt(balance, currency) {
    var num = Number(balance)
    var fixed = isFinite(num) ? num.toFixed(2) : '--'
    return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency
  }
  function animateAmount(from, to, currency, duration) {
    if (costBubbleActive) return
    if (animId) cancelAnimationFrame(animId)
    if (from === null || !isFinite(from)) from = to
    if (from === to) {
      shown = to
      amountEl.textContent = fmt(to, currency)
      return
    }
    var startTime = null
    function step(ts) {
      // 帧级保护：成本泡泡出现后立即停止滚动，避免后续帧把余额写进金额行
      if (costBubbleActive) {
        animId = null
        return
      }
      if (startTime === null) startTime = ts
      var t = Math.min(1, (ts - startTime) / duration)
      var eased = 1 - Math.pow(1 - t, 3)
      amountEl.textContent = fmt(from + (to - from) * eased, currency)
      if (t < 1) {
        animId = requestAnimationFrame(step)
      } else {
        animId = null
        shown = to
        amountEl.textContent = fmt(to, currency)
      }
    }
    animId = requestAnimationFrame(step)
  }
  function resolveDisplaySource() {
    if (displayMode !== 'auto') return displayMode
    var pid = sessionState && sessionState.providerId ? String(sessionState.providerId).toLowerCase() : ''
    if (!pid) return 'ds' // 读不到会话选择时维持旧行为（DeepSeek 余额口径）
    if (pid.indexOf('bigmodel') !== -1) return 'glm'
    if (pid.indexOf('deepseek') !== -1) return 'ds'
    // account:*（start-plan 套餐）与网关都按配额/tokens 口径展示
    return 'plan'
  }

  function render() {
    // 消耗金额泡泡显示期间，余额渲染不覆盖其内容
    if (costBubbleActive) return
    var amount, hint
    // planState 来自 /whale/plan.json（ZCode Plan 套餐配额），见底部 pollPlan
    if (state.status === 'error') {
      amount = shown !== null ? fmt(shown, state.currency) : '--'
      hint = state.message ? state.message.slice(0, 14) : '获取失败 · 点击重试'
    } else if (state.balance === null) {
      amount = shown !== null ? fmt(shown, state.currency) : '…'
      hint = '加载中…'
    } else {
      amount = shown !== null ? fmt(shown, state.currency) : fmt(state.balance, state.currency)
      var source = resolveDisplaySource()
      if (source === 'plan' && planState && typeof planState.percentRemaining === 'number' && !planState.stale) {
        // ZCode Plan（套餐）配额口径：剩余百分比 + 到期日
        var pct = Math.round(planState.percentRemaining * 1000) / 10
        hint = 'Plan 剩余 ' + pct + '%'
        if (planState.nextResetAt) {
          var d = new Date(planState.nextResetAt)
          hint +=
            ' · ' +
            ('0' + (d.getMonth() + 1)).slice(-2) +
            '-' +
            ('0' + d.getDate()).slice(-2) +
            ' 到期'
        }
      } else if (source === 'glm') {
        hint = 'GLM 按量 · 今日 ' + (glmTodaySum != null ? fmtMoney(glmTodaySum) : '…')
      } else {
        hint =
          '今日已用 ' +
          (state.todayUsage !== null && state.todayUsage !== undefined
            ? fmt(state.todayUsage, state.currency)
            : '--')
      }
    }
    amountEl.textContent = amount
    if (bubbleRandomActive && bubbleRandomLines) {
      applyBubbleLines(bubbleRandomLines)
    } else {
      setHint(hint)
    }
  }
  function express() {
    // root 是相对浮层窗口定位的，而 state.left/top 是相对「ZCode 窗口」的坐标，
    // 所以这里要加上 ZCode 窗口在浮层窗口内的偏移。
    var ox = externalViewport ? externalViewport.x : 0
    var oy = externalViewport ? externalViewport.y : 0
    root.style.right = 'auto'
    root.style.bottom = 'auto'
    root.style.left = ox + state.left + 'px'
    root.style.top = oy + state.top + 'px'
    root.classList.toggle('zcwv-left', state.h === 'left')
  }
  function settle() {
    var vp = viewport()
    var w = root.offsetWidth || root.getBoundingClientRect().width || 0
    var h = root.offsetHeight || root.getBoundingClientRect().height || 0
    if (drag && drag.active) {
      // 拖拽中窗口变化：保持跟手位置，只做视口钳制
      state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()))
      state.top = clamp(state.top, 0, Math.max(0, vp.h - h))
      express()
      if (menuOpen) positionMenu()
      return
    }
    if (state.h === 'right') {
      state.left = Math.max(0, vp.w - w - state.hOff - rightGap())
    } else if (state.h === 'left') {
      state.left = state.hOff
    } else {
      state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()))
    }
    if (state.v === 'bottom') {
      state.top = Math.max(0, vp.h - h - state.vOff)
    } else if (state.v === 'top') {
      state.top = state.vOff
    } else {
      state.top = clamp(state.top, 0, Math.max(0, vp.h - h))
    }
    express()
    // 菜单是 body 上的 fixed 元素，不会跟着 root 走；窗口移动/缩放会让它留在
    // 原地（浮层里尤其明显），所以每次重排都跟着按钮重新定位一次。
    if (menuOpen) positionMenu()
  }

  // ---------- 余额刷新 ----------
  function refresh(manual) {
    if (busy) return
    busy = true
    if (animDelayTimer) {
      clearTimeout(animDelayTimer)
      animDelayTimer = null
    }
    if (manual || state.balance === null) {
      state.status = 'loading'
      render()
    }
    var ctrl = null
    var timer = null
    try {
      ctrl = new AbortController()
      timer = setTimeout(function () {
        try {
          ctrl.abort()
        } catch (err) {}
      }, FETCH_TIMEOUT_MS)
    } catch (err) {}
    fetch(BALANCE_URL, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        if (data && data.ok) {
          var nb = Number(data.totalBalance)
          var nc = String(data.currency || 'CNY')
          var changed = state.balance !== null && (nb !== state.balance || nc !== state.currency)
          var currencyChanged = state.currency !== null && nc !== state.currency
          state.balance = nb
          state.currency = nc
          state.message = ''
          state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null
          state.isPeak = !!data.isPeak
          checkAlerts('deepseek')
          if (changed && !currencyChanged) {
            if (!manual) {
              showBubble()
              state.status = 'changing'
              // 余额变化：等气泡浮出 0.3 秒后再滚动数字
              if (animDelayTimer) clearTimeout(animDelayTimer)
              animDelayTimer = setTimeout(function () {
                animDelayTimer = null
                animateAmount(shown, nb, nc, ANIM_MS)
              }, 300)
              if (settleTimer) clearTimeout(settleTimer)
              settleTimer = setTimeout(function () {
                settleTimer = null
                if (state.status === 'changing') {
                  state.status = 'ok'
                  render()
                }
              }, CHANGE_MS + 300)
            } else {
              animateAmount(shown, nb, nc, ANIM_MS)
              state.status = 'ok'
              render()
            }
          } else {
            if (animId === null) shown = nb
            state.status = 'ok'
            render()
          }
        } else {
          state.status = 'error'
          state.message = data && data.error ? String(data.error) : '获取失败'
          render()
        }
      })
      .catch(function () {
        state.status = 'error'
        state.message = '获取失败'
        render()
      })
      .finally(function () {
        busy = false
        if (timer) clearTimeout(timer)
      })
  }

  // ---------- 配置与音效 ----------
  var soundOn = true
  var soundVol = 0.9
  var soundSet = 'duck'
  var usageMode = 'ledger'
  var peakMode = 'default'
  var bubbleOn = true
  var turnCostOn = true
  var turnCostCloseMs = 5000
  var costBubbleActive = false
  var scrollGapOn = false
  var scrollGapPx = 17
  // 预警阈值（0/空 = 关闭）：Plan 剩余百分比、DeepSeek 余额、BigModel 按量今日已用
  var alerts = { planPct: 0, deepseekBelow: 0, bigmodelDaily: 0 }
  var roleId = null // 自定义角色 id（null = 默认形象）
  var themeMode = 'light' // 'light' | 'dark'（深色 = ZCode zai-dark token）
  var displayMode = 'auto' // 'auto' | 'plan' | 'glm' | 'ds'：气泡 hint 跟随哪个计费源
  var sessionState = null // 输入框当前供应商选择（/whale/session.json）
  var glmTodaySum = null // GLM 按量今日已用（元，来自用量记录接口）

  function saveConfig() {
    try {
      fetch(SIZE_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scale: state.scale,
          sound: soundOn,
          vol: soundVol,
          soundSet: soundSet,
          usageMode: usageMode,
          peakMode: peakMode,
          bubbleOn: bubbleOn,
          turnCostOn: turnCostOn,
          turnCostCloseMs: turnCostCloseMs,
          scrollGapOn: scrollGapOn,
          scrollGapPx: scrollGapPx,
          alerts: alerts,
          roleId: roleId,
          theme: themeMode,
          displayMode: displayMode,
        }),
      })
      // 位置记忆：记录相对边框的净距离，窗口 resize 后保持。
      // v:2 = 净距离格式（剥离避让距离），旧格式恢复时废弃。
      var vp = viewport()
      var w = root.offsetWidth || root.getBoundingClientRect().width || 0
      var h = root.offsetHeight || root.getBoundingClientRect().height || 0
      var leftDist = state.left
      var rightDist = vp.w - state.left - w
      var topDist = state.top
      var bottomDist = vp.h - state.top - h
      var hAnchor = leftDist <= rightDist ? 'left' : 'right'
      var hDistRaw = Math.round(Math.min(leftDist, rightDist))
      var hDist = hAnchor === 'right' && scrollGapOn ? Math.max(0, hDistRaw - rightGap()) : hDistRaw
      localStorage.setItem(
        POS_KEY,
        JSON.stringify({
          v: 2,
          hAnchor: hAnchor,
          hDist: hDist,
          vAnchor: topDist <= bottomDist ? 'top' : 'bottom',
          vDist: Math.round(Math.min(topDist, bottomDist)),
        })
      )
    } catch (err) {}
  }
  function setUsageMode(v) {
    usageMode = v === 'token' ? 'token' : 'ledger'
    usageSelect.value = usageMode
    saveConfig()
    refresh(false)
  }
  function setPeakMode(v) {
    peakMode = v === 'liangwen' || v === 'qiangqiang' ? v : 'default'
    peakSelect.value = peakMode
    saveConfig()
  }
  function setBubbleOn(v) {
    bubbleOn = !!v
    bubbleToggle.checked = bubbleOn
    saveConfig()
    // 必须走 hideCostBubble：残留的 costBubbleActive 会让 render()/showBubble()
    // 永久早退
    if (!bubbleOn) hideCostBubble()
  }
  function setTurnCostOn(v) {
    turnCostOn = !!v
    turnCostToggle.checked = turnCostOn
    turnCostCloseInput.disabled = !turnCostOn
    saveConfig()
    if (!turnCostOn) hideCostBubble()
  }
  function setTurnCostClose(v) {
    if (!turnCostOn) return
    var n = Math.max(0, Math.round(Number(v) || 0))
    turnCostCloseMs = n * 1000
    turnCostCloseInput.value = String(n)
    saveConfig()
  }
  function setScrollGapOn(v) {
    scrollGapOn = !!v
    scrollGapToggle.checked = scrollGapOn
    scrollGapInput.disabled = !scrollGapOn
    saveConfig()
    settle()
  }
  function setScrollGapPx(v) {
    if (!scrollGapOn) return
    var n = Math.max(0, Math.round(Number(v) || 0))
    scrollGapPx = n
    scrollGapInput.value = String(n)
    saveConfig()
    settle()
  }
  function scaleToDisplay(s) {
    return Math.round((s - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / 19)) + 1
  }
  function setScale(v) {
    var next = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v))) * 10) / 10
    // 缩放测量需要 left/top 立即到位：临时禁用过渡，否则测到的是过渡起点，
    // 会把挂件锚到错误的位置。
    var prevTrans = root.style.transition
    root.style.transition = 'none'
    var rect = root.getBoundingClientRect()
    // 固定点取鲸鱼所在的角：未翻转=右下角，翻转=左下角。放大时挂件从该角
    // 向上（左/右）展开，缩小时收回该角，鲸鱼始终贴着自己的角。
    var fx = state.h === 'left' ? rect.left : rect.right
    var fy = rect.bottom
    state.scale = next
    root.style.setProperty('--zcw-scale', String(next))
    scaleInput.value = String(next)
    scaleNumber.value = String(scaleToDisplay(next))
    saveConfig()
    var r2 = root.getBoundingClientRect()
    var vp = viewport()
    if (state.h === 'left') {
      state.left = Math.min(Math.max(fx, 0), Math.max(0, vp.w - r2.width))
    } else {
      state.left = Math.min(Math.max(fx - r2.width, 0), Math.max(0, vp.w - r2.width))
    }
    state.top = Math.min(Math.max(fy - r2.height, 0), Math.max(0, vp.h - r2.height))
    express()
    // 恢复过渡必须延到下一帧：本帧 left/top 已在 none 下提交，立即恢复会让
    // 浏览器对刚改过的 left/top 重新求值并播放过渡，表现为抽搐。
    requestAnimationFrame(function () {
      root.style.transition = prevTrans
    })
  }
  function setVol(v) {
    var next = Math.round(Math.min(1, Math.max(0, Number(v))) * 100) / 100
    soundVol = next
    soundOn = next > 0
    volInput.value = String(next)
    volPct.textContent = Math.round(next * 100) + '%'
    try {
      if (pressAudio) pressAudio.volume = next
      if (releaseAudio) releaseAudio.volume = next
    } catch (err) {}
    saveConfig()
  }
  function setSoundSet(v) {
    soundSet = v === 'fx1' ? 'fx1' : 'duck'
    soundSelect.value = soundSet
    applySoundSet()
    saveConfig()
  }

  var SQUISH = 'scaleY(0.88) scaleX(1.05)'
  var pressAudio = null
  var releaseAudio = null
  var pressing = false
  var pressEnded = false
  var releasePlayed = false
  var releaseTimer = null
  function applySoundSet() {
    try {
      pressAudio = new Audio('/whale/sound/press.mp3?set=' + soundSet)
      pressAudio.preload = 'auto'
      pressAudio.volume = soundVol
      releaseAudio = new Audio('/whale/sound/release.mp3?set=' + soundSet)
      releaseAudio.preload = 'auto'
      releaseAudio.volume = soundVol
    } catch (err) {}
  }
  function playPress() {
    if (!pressAudio || !soundOn) return
    try {
      if (releaseTimer) {
        clearTimeout(releaseTimer)
        releaseTimer = null
      }
      if (releaseAudio) {
        releaseAudio.pause()
        releaseAudio.currentTime = 0
      }
      pressEnded = false
      releasePlayed = false
      pressAudio.onended = function () {
        pressEnded = true
        // 时长未知时的兜底：短按 → Ya1 播完立刻接 Ya2
        if (!pressing && !releasePlayed) playRelease()
        // 长按：仍按着 → 等 pressUp() 再播 Ya2
      }
      pressAudio.currentTime = 0
      var p = pressAudio.play()
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch (err) {}
  }
  function playRelease() {
    if (releasePlayed || !releaseAudio || !soundOn) return
    releasePlayed = true
    try {
      releaseAudio.currentTime = 0
      var p = releaseAudio.play()
      if (p && typeof p.catch === 'function') p.catch(function () {})
    } catch (err) {}
  }
  function pressDown() {
    body.style.transform = SQUISH
    pressing = true
    playPress()
  }
  function pressUp() {
    body.style.transform = 'scaleY(1) scaleX(1)'
    pressing = false
    if (pressEnded) {
      // 长按（或 Ya1 已播完才松手）→ 现在补 Ya2
      playRelease()
      return
    }
    // 短按：让 Ya2 在 Ya1 结尾前 100ms 起播，避免同文件抢占
    var durKnown = false
    var remainMs = 0
    try {
      var dur = pressAudio ? pressAudio.duration : 0
      if (isFinite(dur) && dur > 0) {
        durKnown = true
        remainMs = (dur - pressAudio.currentTime) * 1000
      }
    } catch (err) {}
    if (durKnown) {
      releaseTimer = setTimeout(function () {
        releaseTimer = null
        playRelease()
      }, Math.max(0, remainMs - 100))
    }
  }

  // ---------- 菜单开关与定位 ----------
  var menuOpen = false
  function toggleMenu() {
    menuOpen = !menuOpen
    if (menuOpen) positionMenu()
    menuBox.classList.toggle('zcwv-menu-open', menuOpen)
    if (menuOpen) menuBtn.classList.add('zcwv-menu-btn-visible')
  }
  function closeMenu() {
    menuOpen = false
    menuBox.classList.remove('zcwv-menu-open')
    root.style.transition = ''
    snapCheck()
    syncOverlayInteractive()
  }
  function snapCheck() {
    var rect = root.getBoundingClientRect()
    var vp = viewport()
    var w = rect.width
    var h = rect.height
    // rect.left/top 是页面坐标；锚点判定与 state 一律按视口坐标，先扣掉偏移
    var left = rect.left - (externalViewport ? externalViewport.x : 0)
    var top = rect.top - (externalViewport ? externalViewport.y : 0)
    var centerX = left + w / 2
    var centerY = top + h / 2
    var moved = false
    if (centerX < vp.w / 4) {
      state.h = 'left'
      state.hOff = 0
      left = 0
      moved = true
    } else if (centerX > (vp.w * 3) / 4) {
      state.h = 'right'
      state.hOff = 0
      left = vp.w - w - rightGap()
      moved = true
    } else {
      state.h = null
      state.hOff = left
    }
    if (centerY < vp.h / 4) {
      state.v = 'top'
      state.vOff = 0
      top = 0
      moved = true
    } else {
      state.v = 'bottom'
      state.vOff = Math.max(0, vp.h - top - h)
    }
    if (moved) {
      state.left = left
      state.top = top
      settle()
    }
  }
  function positionMenu() {
    try {
      var r = root.getBoundingClientRect()
      var b = menuBtn.getBoundingClientRect()
      // 菜单挂在 body 上、position:fixed，所以它的 left/right/top/bottom 一律按
      // 页面视口算；b 也是同一个坐标系（root 只是被 express() 加了浮层内偏移）。
      var fv = pageViewport()
      // 判断「鲸鱼在左半还是右半」要按 ZCode 窗口算，浮层里那才是用户看到的窗口
      var vp = viewport()
      var ox = externalViewport ? externalViewport.x : 0
      var oy = externalViewport ? externalViewport.y : 0
      var gap = 4
      var mw = menuBox.offsetWidth || 196
      var mh = menuBox.offsetHeight || 0
      var onLeft = r.left + r.width / 2 < ox + vp.w / 2
      // 菜单在按钮上方并按按钮侧边对齐：右侧 → 菜单右下角贴按钮右上角；
      // 左侧 → 菜单左下角贴按钮左上角。贴边后再钳一次，避免窄窗口里出界。
      if (onLeft) {
        menuBox.style.left = clamp(b.left, 0, Math.max(0, fv.w - mw - gap)) + 'px'
        menuBox.style.right = 'auto'
        menuBox.style.transformOrigin = 'bottom left'
      } else {
        menuBox.style.right = clamp(fv.w - b.right, 0, Math.max(0, fv.w - mw - gap)) + 'px'
        menuBox.style.left = 'auto'
        menuBox.style.transformOrigin = 'bottom right'
      }
      // 上方空间不够（鲸鱼被拖到窗口顶部）就翻到按钮下方，别让菜单顶出 ZCode 窗口
      var aboveOk = b.top - oy >= mh + gap
      var belowOk = b.bottom + gap + mh <= oy + vp.h
      if (aboveOk || !belowOk) {
        menuBox.style.bottom = fv.h - b.top + 'px'
        menuBox.style.top = 'auto'
      } else {
        menuBox.style.top = b.bottom + gap + 'px'
        menuBox.style.bottom = 'auto'
      }
    } catch (err) {}
  }

  // ---------- 命中检测（按图片 alpha 通道，透明区可穿透） ----------
  var hitCanvas = null
  var hitReady = false
  function setupHitTest() {
    try {
      hitCanvas = document.createElement('canvas')
      hitCanvas.width = 610
      hitCanvas.height = 610
      var probe = new Image()
      probe.onload = function () {
        try {
          // 拉伸到 610x610 与 isWhaleHit 的坐标映射对齐；不指定尺寸会按原图
          // 尺寸绘制，换成非 610x610 素材时命中区域会错位。
          hitCanvas.getContext('2d').drawImage(probe, 0, 0, 610, 610)
          hitReady = true
        } catch (err) {}
      }
      probe.onerror = function () {}
      probe.src = IMG_URL
    } catch (err) {}
  }
  function isWhaleHit(e) {
    if (!hitCanvas || !hitReady) return true
    try {
      var r = img.getBoundingClientRect()
      if (!r || r.width <= 0 || r.height <= 0) return false
      var lx = ((e.clientX - r.left) / r.width) * 610
      var ly = ((e.clientY - r.top) / r.height) * 610
      if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false
      if (state.h === 'left') lx = 610 - lx
      var data = hitCanvas.getContext('2d').getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data
      return data[3] > 10
    } catch (err) {
      return true
    }
  }

  function onDocPointerDown(e) {
    if (e.target && e.target.closest) {
      if (
        e.target.closest('.zcwv-bubble') ||
        e.target.closest('.zcwv-menu') ||
        e.target.closest('.zcwv-menu-btn') ||
        e.target.closest('.zcwv-panel')
      ) {
        return
      }
    }
    if (menuOpen) {
      closeMenu()
      return
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (!isWhaleHit(e)) return
    try {
      e.preventDefault()
      e.stopPropagation()
    } catch (err) {}
    var vp = viewport()
    var rect = root.getBoundingClientRect()
    // rect 是页面坐标（含 ZCode 窗口在浮层内的偏移），而 state.left/top 与
    // drag.vp 都是视口坐标；不扣掉偏移，窗口化时一拖鲸鱼就会跳 (ox, oy)。
    var ox = externalViewport ? externalViewport.x : 0
    var oy = externalViewport ? externalViewport.y : 0
    drag = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left - ox,
      origTop: rect.top - oy,
      w: rect.width,
      h: rect.height,
      moved: false,
      vp: vp,
    }
    root.classList.add('zcwv-dragging')
    pressDown()
    setWidgetCursor('grabbing')
    document.addEventListener('pointermove', onDocPointerMove, true)
    document.addEventListener('pointerup', onDocPointerUp, true)
    document.addEventListener('pointercancel', onDocPointerCancel, true)
  }
  function onDocPointerMove(e) {
    if (!drag || !drag.active) return
    var dx = e.clientX - drag.startX
    var dy = e.clientY - drag.startY
    if (dx * dx + dy * dy >= CLICK_SQ) drag.moved = true
    // 拖拽期间保持拖前的翻转形态（state.h/v 不变），松手后 endDrag() 重算
    // 锚点并让 settle() 带过渡地切换翻转，而不是瞬间回弹。
    state.left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w))
    state.top = clamp(drag.origTop + dy, 0, Math.max(0, drag.vp.h - drag.h))
    express()
  }
  function onDocPointerUp(e) {
    // 拦截鲸鱼区域内的 pointerup，避免下层元素监听 pointerup 被穿透误触发
    try {
      if (isWhaleHit(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    } catch (err) {}
    endDrag(e, true)
  }
  function onDocPointerCancel(e) {
    endDrag(e, false)
  }
  function onDocClickStopper(e) {
    // 只在鲸鱼命中区域拦截 click（保持透明区穿透）。持久注册不随 endDrag
    // 移除——click 在 pointerup 之后派发，若那时才移除会穿透到下层元素。
    if (!isWhaleHit(e)) return
    try {
      e.preventDefault()
      e.stopPropagation()
    } catch (err) {}
  }
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('click', onDocClickStopper, true)

  // —— 桌面浮层（Electron 透明置顶窗口）适配 ——
  // 浮层窗口铺满整个工作区但默认鼠标穿透：只有指针落在鲸鱼、气泡或菜单上时
  // 才让窗口接管鼠标，这样鲸鱼浮在 ZCode 上面却完全不挡操作。
  //
  // 窗口尺寸刻意保持不变，跟随 ZCode 窗口靠的是 externalViewport：主进程把
  // ZCode 窗口矩形发进来，页面把它当作自己的"视口"——吸附边界、居中判定、
  // 位置恢复全部基于这个矩形，于是鲸鱼看起来就待在 ZCode 窗口里。之所以不
  // 直接改窗口大小，是因为透明窗口在 Windows 上改变尺寸后渲染视口会不跟随
  // （窗口已经是 1200x800 了，页面 innerWidth 还停在旧值），画面会错位。
  //
  // 普通浏览器里 window.whaleDesktop 不存在，这段逻辑自动失效。
  var overlayInteractive = false
  var lastPointer = null
  var externalViewport = null // {x, y, w, h}：ZCode 窗口在浮层窗口内的相对矩形
  var positionRestored = false
  if (overlayBridge) {
    // 浮层里禁用定位过渡，避免透明窗口的合成层错位（见 CSS 里的说明）
    root.classList.add('zcwv-overlay')
  }
  function setOverlayInteractive(v) {
    if (!overlayBridge || overlayInteractive === !!v) return
    overlayInteractive = !!v
    try {
      overlayBridge.setInteractive(overlayInteractive)
    } catch (err) {}
  }
  if (overlayBridge && typeof overlayBridge.onViewport === 'function') {
    try {
      overlayBridge.onViewport(function (rect) {
        if (!rect || typeof rect.width !== 'number' || rect.width <= 0) return
        var first = externalViewport === null
        externalViewport = { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
        // 位置记忆必须等拿到真实坐标系之后再恢复：之前按屏幕尺寸算出的
        // 锚点会把鲸鱼放到错误的位置（启动时先恢复、后收到视口就会错位）。
        if (first) restoreSavedPos()
        settle()
      })
    } catch (err) {}
  }
  // 菜单按钮所在矩形。按钮平时 pointer-events:none（为了浮层穿透），因此
  // elementFromPoint 不会返回它；而它又恰好压在鲸鱼图片的透明像素上，光靠
  // alpha 命中会判成「不在鲸鱼上」→ 切回穿透 → 按钮永远点不到。
  // 所以这一小块矩形单独算作可交互区域。
  function pointerInMenuBtnRect() {
    if (!lastPointer) return false
    try {
      var b = menuBtn.getBoundingClientRect()
      return (
        lastPointer.x >= b.left &&
        lastPointer.x <= b.right &&
        lastPointer.y >= b.top &&
        lastPointer.y <= b.bottom
      )
    } catch (err) {
      return false
    }
  }

  // 按「最后已知指针位置」重算是否该接管鼠标。关菜单/关气泡/松手之后也要调用，
  // 否则鼠标不动时窗口会一直保持接管，后续点击会被吃掉。
  function overlayShouldInteract() {
    if (drag && drag.active) return true
    if (menuOpen) return true
    if (pointerInMenuBtnRect()) return true
    if (!lastPointer) return false
    try {
      var node = document.elementFromPoint(lastPointer.x, lastPointer.y)
      if (
        node &&
        node.closest &&
        (node.closest('.zcwv-bubble') ||
          node.closest('.zcwv-menu') ||
          node.closest('.zcwv-menu-btn') ||
          node.closest('.zcw-panel'))
      ) {
        return true
      }
    } catch (err) {}
    return isWhaleHit({ clientX: lastPointer.x, clientY: lastPointer.y })
  }
  function syncOverlayInteractive() {
    setOverlayInteractive(overlayShouldInteract())
  }

  var widgetCursor = ''
  function setWidgetCursor(v) {
    if (v !== widgetCursor) {
      widgetCursor = v
      try {
        document.body.style.cursor = v
      } catch (err) {}
    }
  }
  function onDocPointerMoveCursor(e) {
    lastPointer = { x: e.clientX, y: e.clientY }
    var node = null
    try {
      node = document.elementFromPoint(e.clientX, e.clientY)
    } catch (err) {}
    var onChrome = !!(
      node &&
      node.closest &&
      (node.closest('.zcwv-bubble') ||
        node.closest('.zcwv-menu') ||
        node.closest('.zcwv-menu-btn') ||
        node.closest('.zcw-panel'))
    )
    var dragging = !!(drag && drag.active)
    var onBtnRect = pointerInMenuBtnRect()
    var over = dragging || onChrome || onBtnRect ? false : isWhaleHit(e)
    if (dragging) setWidgetCursor('grabbing')
    else if (onChrome) setWidgetCursor('')
    else setWidgetCursor(over ? 'grab' : '')
    menuBtn.classList.toggle(
      'zcwv-menu-btn-visible',
      dragging || onChrome || onBtnRect || over || menuOpen
    )
    syncOverlayInteractive()
  }
  document.addEventListener('pointermove', onDocPointerMoveCursor, true)

  function endDrag(e, clickAllowed) {
    if (!drag || !drag.active) return
    drag.active = false
    document.removeEventListener('pointermove', onDocPointerMove, true)
    document.removeEventListener('pointerup', onDocPointerUp, true)
    document.removeEventListener('pointercancel', onDocPointerCancel, true)
    pressUp()
    root.classList.remove('zcwv-dragging')
    setWidgetCursor(isWhaleHit(e) ? 'grab' : '')
    if (clickAllowed && !drag.moved) {
      showBubble()
      refresh(true)
      return
    }
    var dx = e.clientX - drag.startX
    var dy = e.clientY - drag.startY
    var left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w))
    var top = clamp(drag.origTop + dy, 0, Math.max(0, drag.vp.h - drag.h))
    var centerX = left + drag.w / 2
    var centerY = top + drag.h / 2
    // 四分吸附：横、纵两轴独立判定，可自由组合成角落
    if (centerX < drag.vp.w / 4) {
      state.h = 'left'
      state.hOff = 0
    } else if (centerX > (drag.vp.w * 3) / 4) {
      state.h = 'right'
      state.hOff = 0
    } else {
      state.h = null
      state.hOff = left
    }
    if (centerY < drag.vp.h / 4) {
      state.v = 'top'
      state.vOff = 0
    } else if (centerY > (drag.vp.h * 3) / 4) {
      state.v = 'bottom'
      state.vOff = 0
    } else {
      state.v = null
      state.vOff = top
    }
    state.left = left
    state.top = top
    settle()
    // 拖拽结束立即保存锚点（否则刷新后位置会退回上次改菜单时的状态）
    saveConfig()
    syncOverlayInteractive()
  }

  // 窗口尺寸变化：自由位置的挂件按相对边框的锚点重算（保持离边距离，窗口
  // 恢复原状即回原位）；贴边吸附的挂件走 settle() 保持贴边。
  function applyAnchorPos() {
    try {
      var a = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (
        !a ||
        a.v !== 2 ||
        (a.hAnchor !== 'left' && a.hAnchor !== 'right') ||
        typeof a.hDist !== 'number' ||
        (a.vAnchor !== 'top' && a.vAnchor !== 'bottom') ||
        typeof a.vDist !== 'number'
      ) {
        return false
      }
      var vp = viewport()
      var w = root.offsetWidth || root.getBoundingClientRect().width || 0
      var h = root.offsetHeight || root.getBoundingClientRect().height || 0
      var effectiveRightDist = a.hAnchor === 'right' ? a.hDist + (scrollGapOn ? rightGap() : 0) : a.hDist
      var l = a.hAnchor === 'left' ? a.hDist : vp.w - effectiveRightDist - w
      var t = a.vAnchor === 'top' ? a.vDist : vp.h - a.vDist - h
      state.left = clamp(l, 0, Math.max(0, vp.w - w))
      state.top = clamp(t, 0, Math.max(0, vp.h - h))
      state.h = a.hAnchor
      state.hOff = 0
      state.v = a.vAnchor
      state.vOff = 0
      express()
      return true
    } catch (err) {
      return false
    }
  }
  window.addEventListener('resize', function () {
    if (state.h === null && state.v === null && applyAnchorPos()) return
    settle()
  })

  // ---------- 启动 ----------
  var rect0 = root.getBoundingClientRect()
  state.left = rect0.left
  state.top = rect0.top
  express()
  render()
  applySoundSet()
  setupHitTest()
  // 浮层模式下先确保窗口是穿透的，等指针真正压到鲸鱼上再接管
  setOverlayInteractive(false)
  // 把上次选的跟随延迟同步给主进程
  initFollowInterval()

  function applyConfig(d) {
    if (!d) return
    if (typeof d.scale === 'number' && d.scale >= MIN_SCALE - 0.1 && d.scale <= MAX_SCALE + 0.1) {
      state.scale = d.scale
      root.style.setProperty('--zcw-scale', String(d.scale))
      scaleInput.value = String(d.scale)
      scaleNumber.value = String(scaleToDisplay(d.scale))
      settle()
    }
    if (typeof d.vol === 'number') {
      soundVol = d.vol
      soundOn = soundVol > 0
      volInput.value = String(soundVol)
      volPct.textContent = Math.round(soundVol * 100) + '%'
      try {
        if (pressAudio) pressAudio.volume = soundVol
        if (releaseAudio) releaseAudio.volume = soundVol
      } catch (err) {}
    }
    if (typeof d.soundSet === 'string') {
      soundSet = d.soundSet === 'fx1' ? 'fx1' : 'duck'
      soundSelect.value = soundSet
      applySoundSet()
    }
    if (typeof d.usageMode === 'string') {
      usageMode = d.usageMode === 'token' ? 'token' : 'ledger'
      usageSelect.value = usageMode
    }
    if (typeof d.peakMode === 'string') {
      peakMode = d.peakMode === 'liangwen' || d.peakMode === 'qiangqiang' ? d.peakMode : 'default'
      peakSelect.value = peakMode
    }
    if (typeof d.bubbleOn === 'boolean') {
      bubbleOn = d.bubbleOn
      bubbleToggle.checked = bubbleOn
    }
    if (typeof d.turnCostOn === 'boolean') {
      turnCostOn = d.turnCostOn
      turnCostToggle.checked = turnCostOn
      turnCostCloseInput.disabled = !turnCostOn
    }
    if (typeof d.turnCostCloseMs === 'number') {
      turnCostCloseMs = d.turnCostCloseMs > 0 ? d.turnCostCloseMs : 0
      turnCostCloseInput.value = String(Math.round(turnCostCloseMs / 1000))
    }
    if (typeof d.scrollGapOn === 'boolean') {
      scrollGapOn = d.scrollGapOn
      scrollGapToggle.checked = scrollGapOn
      scrollGapInput.disabled = !scrollGapOn
    }
    if (typeof d.scrollGapPx === 'number') {
      scrollGapPx = d.scrollGapPx > 0 ? Math.round(d.scrollGapPx) : 0
      scrollGapInput.value = String(scrollGapPx)
    }
    if (d.alerts && typeof d.alerts === 'object') {
      alerts.planPct = Number(d.alerts.planPct) > 0 ? Number(d.alerts.planPct) : 0
      alerts.deepseekBelow = Number(d.alerts.deepseekBelow) > 0 ? Number(d.alerts.deepseekBelow) : 0
      alerts.bigmodelDaily = Number(d.alerts.bigmodelDaily) > 0 ? Number(d.alerts.bigmodelDaily) : 0
      alertPlanInput.value = String(alerts.planPct)
      alertDsInput.value = String(alerts.deepseekBelow)
      alertBmInput.value = String(alerts.bigmodelDaily)
    }
    roleId = typeof d.roleId === 'string' && d.roleId ? d.roleId : null
    loadRoles()
    if (d.theme === 'dark' || d.theme === 'light') setTheme(d.theme)
    if (typeof d.displayMode === 'string' && ['auto', 'plan', 'glm', 'ds'].indexOf(d.displayMode) !== -1) {
      displayMode = d.displayMode
      displaySelect.value = displayMode
    }
    // 位置记忆恢复：浏览器里坐标系已知，直接恢复；浮层里坐标系来自主进程，
    // 交给首次收到视口时的 restoreSavedPos()，避免用屏幕尺寸算出错误锚点。
    if (!overlayBridge) restoreSavedPos()
  }

  // 恢复上次的落点（相对边框的净距离）。锚点是按 viewport() 存的，所以必须
  // 在坐标系确定之后调用——浮层模式下就是首次拿到 ZCode 窗口矩形的时候。
  function restoreSavedPos() {
    if (positionRestored) return
    positionRestored = true
    try {
      var a = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (
        a &&
        a.v === 2 &&
        (a.hAnchor === 'left' || a.hAnchor === 'right') &&
        typeof a.hDist === 'number' &&
        (a.vAnchor === 'top' || a.vAnchor === 'bottom') &&
        typeof a.vDist === 'number'
      ) {
        var vpA = viewport()
        var wA = root.offsetWidth || root.getBoundingClientRect().width || 0
        var hA = root.offsetHeight || root.getBoundingClientRect().height || 0
        var effectiveRightDist = a.hAnchor === 'right' ? a.hDist + (scrollGapOn ? rightGap() : 0) : a.hDist
        var lA = a.hAnchor === 'left' ? a.hDist : vpA.w - effectiveRightDist - wA
        var tA = a.vAnchor === 'top' ? a.vDist : vpA.h - a.vDist - hA
        state.left = clamp(lA, 0, Math.max(0, vpA.w - wA))
        state.top = clamp(tA, 0, Math.max(0, vpA.h - hA))
        state.h = a.hAnchor
        state.hOff = 0
        state.v = a.vAnchor
        state.vOff = 0
        settle()
      }
    } catch (err) {}
  }

  // ---------- 用量记录面板 ----------
  var panelBox = el('div', 'zcw-panel')
  document.body.appendChild(panelBox)
  var usageOpen = false
  var usageTimer = null
  function fmtMoney(n) {
    return '¥' + (Number(n) || 0).toFixed(2)
  }
  function positionPanel() {
    var mr = menuBtn.getBoundingClientRect()
    var pw = panelBox.offsetWidth || 320
    var ph = panelBox.offsetHeight || 200
    var left = Math.max(8, mr.right - pw)
    var top = mr.top - ph - 8
    if (top < 8) top = Math.min(mr.bottom + 8, (window.innerHeight || 800) - ph - 8)
    panelBox.style.left = left + 'px'
    panelBox.style.top = Math.max(8, top) + 'px'
  }
  function renderUsage(d) {
    while (panelBox.firstChild) panelBox.removeChild(panelBox.firstChild)
    var head = el('div', 'zcw-row')
    head.appendChild(el('h4', '', '用量记录'))
    var closeBtn = el('button', 'zcw-panel-close', '关闭')
    closeBtn.type = 'button'
    closeBtn.addEventListener('click', function () {
      toggleUsagePanel()
    })
    head.appendChild(closeBtn)
    panelBox.appendChild(head)
    if (!d) {
      panelBox.appendChild(el('div', 'zcw-dim', '加载中…'))
      positionPanel()
      return
    }
    panelBox.appendChild(el('h4', '', '今日'))
    panelBox.appendChild(
      el('div', 'zcw-row', fmtMoney(d.today.total) + ' · ' + formatTokens(d.today.tokens) + ' tokens')
    )
    var todayTotal = d.today.total > 0 ? d.today.total : 0
    d.today.models.forEach(function (m) {
      var row = el('div', 'zcw-row')
      row.appendChild(el('span', '', m.model))
      row.appendChild(el('span', 'zcw-dim', fmtMoney(m.amount) + ' · ' + formatTokens(m.tokens)))
      panelBox.appendChild(row)
      var bar = el('div', 'zcw-bar')
      var fill = el('i')
      fill.style.width = Math.max(2, Math.round((todayTotal > 0 ? m.amount / todayTotal : 0) * 100)) + '%'
      bar.appendChild(fill)
      panelBox.appendChild(bar)
    })
    if (!d.today.models.length) panelBox.appendChild(el('div', 'zcw-dim', '今天还没有用量'))
    panelBox.appendChild(
      el('h4', '', '近 7 天：' + fmtMoney(d.days7.total) + ' · ' + formatTokens(d.days7.tokens) + ' tokens')
    )
    d.days7.byDay.slice(-7).forEach(function (day) {
      var row = el('div', 'zcw-row')
      row.appendChild(el('span', '', day.date))
      row.appendChild(el('span', 'zcw-dim', fmtMoney(day.total) + ' · ' + formatTokens(day.tokens)))
      panelBox.appendChild(row)
    })
    var ev = el('div', 'zcw-events')
    d.events.slice(0, 50).forEach(function (e2) {
      var t = new Date(e2.ts)
      var hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2)
      var row = el('div', 'zcw-row')
      row.appendChild(el('span', '', hh + ' ' + e2.model))
      row.appendChild(
        el('span', 'zcw-dim', (e2.billable ? fmtMoney(e2.amount) : '套餐/网关') + ' · ' + formatTokens(e2.tokens))
      )
      ev.appendChild(row)
    })
    if (d.events.length) panelBox.appendChild(el('h4', '', '最近明细'))
    panelBox.appendChild(ev)
    positionPanel()
  }
  function fetchUsage() {
    try {
      fetch(USAGE_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (d && d.ok && usageOpen) renderUsage(d)
        })
        .catch(function () {})
    } catch (err) {}
  }
  function toggleUsagePanel() {
    usageOpen = !usageOpen
    panelBox.classList.toggle('zcw-panel-open', usageOpen)
    if (usageOpen) {
      closeMenu()
      renderUsage(null)
      fetchUsage()
      if (usageTimer) clearInterval(usageTimer)
      usageTimer = setInterval(function () {
        if (usageOpen) fetchUsage()
      }, 30000)
    } else if (usageTimer) {
      clearInterval(usageTimer)
      usageTimer = null
    }
  }

  // ---------- 预警（每日一次去重；恢复到阈值之上自动重新武装） ----------
  var alertBubbleTimer = null
  function alertDayKey() {
    var d = new Date()
    var p = function (n) {
      return ('0' + n).slice(-2)
    }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }
  function showAlertBubble(title, text) {
    if (!bubbleOn) return
    if (alertBubbleTimer) clearTimeout(alertBubbleTimer)
    if (costBubbleActive) hideCostBubble()
    if (bubbleTimer) clearTimeout(bubbleTimer)
    if (gifFadeTimer) clearTimeout(gifFadeTimer)
    costBubbleActive = true
    bubbleRandomActive = false
    bubbleShown = true
    lastHintText = null
    gifEl.style.display = 'none'
    labelEl.style.display = ''
    labelEl.className = 'zcwv-label'
    labelEl.textContent = title
    labelEl.style.color = ''
    amountEl.style.display = ''
    amountEl.className = 'zcwv-period'
    amountEl.textContent = text
    amountEl.style.color = ''
    hintEl.style.display = 'none'
    hintEl.textContent = ''
    textBox.style.transition = ''
    textBox.style.opacity = ''
    bubbleBox.classList.add('zcwv-bubble-open')
    if (turnCostCloseMs > 0) {
      alertBubbleTimer = setTimeout(function () {
        alertBubbleTimer = null
        costBubbleActive = false
        hideBubble()
      }, Math.max(4000, turnCostCloseMs))
    }
  }
  function fireAlert(type, thr, title, text) {
    var key = 'zcw-alert-' + type + '-' + alertDayKey() + '-' + thr
    try {
      if (localStorage.getItem(key)) return
      localStorage.setItem(key, '1')
    } catch (err) {}
    showAlertBubble(title, text)
  }
  function checkAlerts(kind) {
    if (kind === 'plan' && planState && typeof planState.percentRemaining === 'number' && alerts.planPct > 0) {
      var pct = planState.percentRemaining * 100
      if (pct <= alerts.planPct) {
        fireAlert('plan', alerts.planPct, '配额预警', 'Plan 剩余 ' + pct.toFixed(1) + '%，低于 ' + alerts.planPct + '%')
      }
    }
    if (
      kind === 'deepseek' &&
      state.status === 'ok' &&
      typeof state.balance === 'number' &&
      alerts.deepseekBelow > 0 &&
      state.balance <= alerts.deepseekBelow
    ) {
      fireAlert('ds', alerts.deepseekBelow, '余额预警', 'DeepSeek 余额 ¥' + state.balance.toFixed(2) + '，低于 ¥' + alerts.deepseekBelow)
    }
    if (kind === 'bigmodel' && alerts.bigmodelDaily > 0 && glmTodaySum != null) {
      if (glmTodaySum >= alerts.bigmodelDaily) {
        fireAlert('bm', alerts.bigmodelDaily, '预算提醒', 'GLM 按量今日已用 ¥' + glmTodaySum.toFixed(2) + '，达到 ¥' + alerts.bigmodelDaily)
      }
    }
  }

  fetch(SIZE_URL, { cache: 'no-store' })
    .then(function (r) {
      return r.json()
    })
    .then(function (d) {
      applyConfig(d)
      refresh(false)
    })
    .catch(function () {
      refresh(false)
    })

  setInterval(function () {
    refresh(false)
  }, REFRESH_MS)

  // 每轮对话消耗：轮询 last-turn.json，出现新的一轮时弹消耗金额泡泡。
  // 首次拿到数据只对齐 seq（不弹旧轮次），此后 seq 变大即"新的一轮"。
  var lastCostSeq = 0
  var lastCostAligned = false
  function pollLastTurn() {
    try {
      fetch(LAST_TURN_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok || typeof d.seq !== 'number') return
          if (!lastCostAligned) {
            lastCostSeq = d.seq
            lastCostAligned = true
            return
          }
          if (d.seq > lastCostSeq) {
            lastCostSeq = d.seq
            if (d.turn !== null && (d.billable === false || d.amount !== null)) showCostBubble(d)
          }
        })
        .catch(function () {})
    } catch (err) {}
  }
  setInterval(pollLastTurn, 1000)
  pollLastTurn()

  // ZCode Plan 配额：60 秒轮询一次（客户端自身约每分钟刷新日志），有变化就重绘 hint
  function pollPlan() {
    try {
      fetch(PLAN_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          var next = d && d.ok ? d : null
          var changed = JSON.stringify(next) !== JSON.stringify(planState)
          planState = next
          if (changed && !costBubbleActive) render()
          checkAlerts('plan')
        })
        .catch(function () {})
    } catch (err) {}
  }
  setInterval(pollPlan, 60000)
  pollPlan()

  // GLM 按量今日已用：60 秒刷新一次（供显示与预算预警共用）
  function refreshUsageSummary() {
    try {
      fetch(USAGE_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok) return
          var sum = 0
          d.today.models.forEach(function (m) {
            if (m.vendorLabel === 'GLM' && m.amount > 0) sum += m.amount
          })
          glmTodaySum = sum
          checkAlerts('bigmodel')
          if (!costBubbleActive) render()
        })
        .catch(function () {})
    } catch (err) {}
  }
  setTimeout(refreshUsageSummary, 8000)
  setInterval(refreshUsageSummary, 60000)

  // 智能切换：轮询输入框的供应商选择（选定当下即更新，无需发起对话）
  function pollSession() {
    try {
      fetch(SESSION_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          var next = d && d.ok ? d : null
          var changed = JSON.stringify(next) !== JSON.stringify(sessionState)
          sessionState = next
          if (changed && !costBubbleActive) render()
        })
        .catch(function () {})
    } catch (err) {}
  }
  setInterval(pollSession, 3000)
  pollSession()
})()
