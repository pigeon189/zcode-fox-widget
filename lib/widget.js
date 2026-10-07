/* ZCode狐娘小挂件（前端，zcode-fox-widget）——移植自 MeteorNOX 的 DeepSeek 余额小鲸鱼挂件
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
  var CMDGO_URL = '/whale/cmdgo.json'
  var USAGE_URL = '/whale/usage-records.json'
  var ROLES_URL = '/whale/roles.json'
  var ROLE_UPLOAD_URL = '/whale/role-upload.json'
  var ROLE_RENAME_URL = '/whale/role-rename.json'
  var ROLE_DELETE_URL = '/whale/role-delete.json'
  var SOUNDS_URL = '/whale/sounds.json'
  var SOUND_UPLOAD_URL = '/whale/sound-upload.json'
  var SOUND_DELETE_URL = '/whale/sound-delete.json'
  var ZCODE_THEME_URL = '/whale/zcode-theme.json'
  var BUBBLE_URL = '/whale/bubble-content.json'
  var ADJUST_URL = '/whale/balance-adjustments.json'
  var SESSION_URL = '/whale/session.json'
  var POS_KEY = 'zcw-pos'
  var RANK_KEY = 'zcw-rank-mode'

  // 浮层（桌面置顶窗口）里 preload 会暴露 whaleDesktop；普通浏览器里没有。
  // 这里必须尽早确定：菜单构建时就要据此决定是否显示「跟随延迟」那一行。
  var overlayBridge = typeof window !== 'undefined' && window.whaleDesktop ? window.whaleDesktop : null

  // 挂件自己的「界面」（相对鲸鱼本体而言）：气泡、菜单、菜单按钮、各面板、
  // 角色下拉。指针落在这些地方时浮层要接管鼠标（否则点不到），也是点击穿透
  // 判定的白名单——集中一处，免得新增面板时漏掉某个判断。
  var CHROME_SELECTOR = '.zcwv-bubble, .zcwv-menu, .zcwv-menu-btn, .zcwv-panel, .zcwv-roles'

  // 网络失败的统一文案（UI 审查 U11）：同一种「请求没打到服务」此前在余额
  // 气泡里叫「获取失败」、在各 POST 的 catch 里叫「请求未送达」，用户无法
  // 判断是不是同一类问题。「点击重试」只出现在气泡提示行——点鲸鱼确实会
  // 重新拉取（refresh + refreshUsageSummary）；alert 泡是 toast 语义、没有
  // 重试入口，文案不暗示可点。
  var COPY_NET_FAIL = '请求未送达（挂件服务未运行？）'
  var COPY_FETCH_FAIL = '获取失败 · 点击重试'
  function inChrome(node) {
    try {
      return !!(node && node.closest && node.closest(CHROME_SELECTOR))
    } catch (err) {
      return false
    }
  }

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
    '.zcwv-bubble.zcwv-bubble-open .zcwv-gif{opacity:1;transition-delay:.26s}',
    '.zcwv-bubble.zcwv-bubble-open .zcwv-b2{transition-delay:0s}',
    '.zcwv-bubble.zcwv-bubble-open .zcwv-b1{transition-delay:.13s}',
    '.zcwv-bubble.zcwv-bubble-open .zcwv-bshape{transition-delay:.26s}',
    '.zcwv-bubble .zcwv-bshape{transition-delay:.1s}',
    '.zcwv-bubble .zcwv-b1{transition-delay:.2s}',
    '.zcwv-bubble .zcwv-b2{transition-delay:.3s}',
    // 气泡本体颜色走主题变量（CSS 规则覆盖 SVG 的 fill/stroke 属性）
    '.zcwv-bubble .zcwv-bshape,.zcwv-bubble .zcwv-b1,.zcwv-bubble .zcwv-b2{fill:var(--zcw-bubble-fill);stroke:var(--zcw-bubble-ink,var(--zcw-ink))}',
    '.zcwv-text{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);text-align:center;color:var(--zcw-bubble-text,var(--zcw-text));line-height:1.15;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .16s ease,transform .3s ease}',
    '.zcwv-bubble.zcwv-bubble-open .zcwv-text{opacity:1;transition:opacity .16s ease .36s,transform .3s ease}',
    '.zcwv-root.zcwv-left .zcwv-text{transform:translate(-50%,-50%) scaleX(-1)}',
    '.zcwv-label{font-size:calc(var(--zcw-u) * 66);font-weight:600;letter-spacing:.06em}',
    '.zcwv-amount{font-size:calc(var(--zcw-u) * 128);font-weight:800;line-height:1.05}',
    '.zcwv-period{font-size:calc(var(--zcw-u) * 104);font-weight:800;line-height:1.05}',
    '.zcwv-wrap{white-space:normal;max-width:calc(var(--zcw-u) * 560);line-height:1.2}',
    '.zcwv-hint{font-size:calc(var(--zcw-u) * 56);color:var(--zcw-bubble-text-dim,var(--zcw-text-dim));letter-spacing:.02em;margin-top:calc(var(--zcw-u) * 9);min-height:calc(var(--zcw-u) * 64);line-height:1.15}',
    // CommandCode 三重额度卡（v1.7.8）：标题 + 三条窗口条 + 两条小字，
    // 与三行文本互斥显示；条色三档 <70% accent / 70–89% amber / ≥90% red。
    // 百分比列宽度 132u（= 名称列）是给「已限流」三个 CJK 字留的位置：96u 时
    // 三字右对齐会向左溢出压住进度条末端（UI 审查 U17）
    '.zcwv-qcard{width:calc(var(--zcw-u) * 520);text-align:center;display:none}',
    '.zcwv-qcard .zcwv-qhead{font-size:calc(var(--zcw-u) * 42);font-weight:700;letter-spacing:.04em;margin-bottom:calc(var(--zcw-u) * 8);white-space:nowrap}',
    '.zcwv-qcard .zcwv-qrow{display:flex;align-items:center;gap:calc(var(--zcw-u) * 14);margin:calc(var(--zcw-u) * 8) 0}',
    '.zcwv-qcard .zcwv-qname{flex:0 0 auto;width:calc(var(--zcw-u) * 132);text-align:left;font-size:calc(var(--zcw-u) * 38);font-weight:600}',
    '.zcwv-qcard .zcwv-qbar{flex:1;height:calc(var(--zcw-u) * 20);border-radius:calc(var(--zcw-u) * 10);background:var(--zcw-ink-faint);overflow:hidden}',
    '.zcwv-qcard .zcwv-qbar i{display:block;height:100%;border-radius:inherit;background:var(--zcw-accent)}',
    '.zcwv-qcard .zcwv-qbar i.zcwv-qamber{background:var(--zcw-amber)}',
    '.zcwv-qcard .zcwv-qbar i.zcwv-qred{background:var(--zcw-red)}',
    '.zcwv-qcard .zcwv-qpct{flex:0 0 auto;width:calc(var(--zcw-u) * 132);text-align:right;white-space:nowrap;font-size:calc(var(--zcw-u) * 42);font-weight:800;font-variant-numeric:tabular-nums}',
    '.zcwv-qcard .zcwv-qpct.zcwv-qpct-amber{color:var(--zcw-amber)}',
    '.zcwv-qcard .zcwv-qpct.zcwv-qpct-red{color:var(--zcw-red)}',
    // qsub 溢出保护：账号名 + 重置倒计时拼起来可能超一行，截断而不是撑破卡片
    '.zcwv-qcard .zcwv-qsub{font-size:calc(var(--zcw-u) * 32);color:var(--zcw-text-dim);margin-top:calc(var(--zcw-u) * 6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    // 菜单按钮随本体缩放联动（U15）：固定 26px 在 0.6 档（本体约 150px）占宽
    // 17%，比例失衡。按 --zcw-base 的 6.9% 计算（默认 375px 档 ≈26px，观感
    // 不变），夹在 18–30px。按钮在 root 下、取不到气泡作用域的 --zcw-u，
    // 用 root 上的 --zcw-base；命中检测走 getBoundingClientRect 动态取矩形，
    // 尺寸变化自动适配
    '.zcwv-menu-btn{position:absolute;top:calc(40.55% + 4px);right:4px;width:clamp(18px,calc(var(--zcw-base) * 0.069),30px);height:clamp(18px,calc(var(--zcw-base) * 0.069),30px);box-sizing:border-box;border:1px solid var(--zcw-ink-soft);border-radius:var(--zcw-radius);background:var(--zcw-btn-bg);cursor:pointer;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:0;z-index:2;opacity:0;transition:opacity .15s ease}',
    '.zcwv-menu-btn.zcwv-menu-btn-visible{opacity:1;pointer-events:auto}',
    '.zcwv-menu-btn span{display:block;width:14px;height:2px;background:var(--zcw-btn-bar);border-radius:1px}',
    '.zcwv-menu-btn:hover{background:var(--zcw-btn-bg-hover)}',
    // U27：菜单要有高度上限——大字号（scale 2.5）/矮窗口下顶部行会被裁出视口且
    // 无法滚动到；100vh 即页面视口（fixed 定位参照它），80px 留给按钮与上下留白
    '.zcwv-menu{position:fixed;min-width:196px;max-height:calc(100vh - 80px);overflow-y:auto;scrollbar-width:thin;background:var(--zcw-panel);border:1px solid var(--zcw-ink-soft);border-radius:var(--zcw-radius-lg);padding:10px 12px;opacity:0;transform:scale(.92) translateY(-4px);transform-origin:top right;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);pointer-events:none;z-index:10000;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:var(--zcw-cs)}',
    '.zcwv-menu.zcwv-menu-open{opacity:1;transform:scale(1) translateY(0);pointer-events:auto}',
    // 浅色档：**整套界面的 chrome** 跟随角色配色（用户 2026-10-06/07 指定）。二级页面
    //（按压泡泡编辑器 / 记账页 / 用量记录）、文本框、下拉列表、滑块…全部由这一族变量
    // 驱动，所以在这里整体换掉即可，不必逐个组件写。--zcw-text / --zcw-text-dim 是
    // 「次级文字」（用量记录的对账行与日志行 .zcwv-dim、编辑器提示、下拉表头…），
    // 一并跟色（用户 2026-10-07 反馈"只剩这一半是蓝的，太突兀"），派生比例沿用气泡
    // 文字的 85% / 62% 混白，保证整套界面的色阶关系一致。
    // 深色档整条规则不生效（--zcw-role-ink 只在浅色档写入，且选择器排除深色）。
    ':root:not(.zcwv-theme-dark)' +
      '{--zcw-ink:var(--zcw-role-ink);--zcw-btn-bar:var(--zcw-role-ink);--zcw-accent:var(--zcw-role-ink);' +
      '--zcw-text:color-mix(in srgb,var(--zcw-role-ink) 85%,#fff);' +
      '--zcw-text-dim:color-mix(in srgb,var(--zcw-role-ink) 62%,#fff);' +
      '--zcw-ink-soft:color-mix(in srgb,var(--zcw-role-ink) 35%,transparent);' +
      '--zcw-ink-input:color-mix(in srgb,var(--zcw-role-ink) 40%,transparent);' +
      '--zcw-ink-sep:color-mix(in srgb,var(--zcw-role-ink) 25%,transparent);' +
      '--zcw-ink-faint:color-mix(in srgb,var(--zcw-role-ink) 8%,transparent)}',
    // 帧调度逃生门（见 verifyFramesFlowing）：渲染被节流时过渡永远拿不到起始帧，
    // 面板会「开了但停在透明态」。挂上 zcwv-anim-off 就把浮层 UI 的过渡整体
    // 关掉——主线程样式计算不受节流影响，opacity/transform 立即到位。
    '.zcwv-anim-off .zcwv-menu,.zcwv-anim-off .zcwv-roles,.zcwv-anim-off .zcwv-panel,.zcwv-anim-off .zcwv-bubble,.zcwv-anim-off .zcwv-gif{transition:none!important}',
    '.zcwv-menu-row{display:flex;align-items:center;gap:8px;margin:5px 0;color:var(--zcw-ink);font-size:12px;white-space:nowrap}',
    // 行首标签给最小列宽：控件列各行起点对齐（此前「大小/音效/对账口径」的
    // 控件各从不同 x 起步）；长标签（每轮消耗提示/避让滚动条）自然撑开不截断。
    // 用 :first-child 精准命中行首标签，不影响「自动关闭」「秒」「px」这类行中标签
    '.zcwv-menu-row > span:first-child{flex:0 0 auto;min-width:58px}',
    '.zcwv-range{flex:1;min-width:0;accent-color:var(--zcw-accent)}',
    // 拖动条：**浅色档**改成自绘轨道与滑块。原因是 Chromium 原生「空槽」的颜色会跟着
    // accent 的明度翻——深色 accent 给近白槽（实测 #efefef），中/浅色 accent 给深灰槽
    // （实测 #3b3b3b，观感就是"黑底"）：小克 #d97757、kimi #b6afff 都会踩到，而
    // 鲸鱼/狐娘/GPT娘 恰好落在浅槽一侧，所以只有这两个角色看起来"底部是黑的"。
    // 又因为一旦自定义 ::-webkit-slider-runnable-track，原生连长条填充都不再画
    //（实测只剩一个圆点），所以两段都得自己画：填充段用角色色；空槽给一层可见
    // 的中性衬底（纯 #efefef 在白卡片上看不出轨道到哪结束，用户不知道 100% 在
    // 哪里），再加一圈发丝内描边把轨道首尾框出来。填充比例由 JS 写 --zcw-range-pct。
    // 深色档整条不覆盖，完全保持原生绘制。
    ':root:not(.zcwv-theme-dark) .zcwv-range{appearance:none;-webkit-appearance:none;height:14px;background:transparent}',
    ':root:not(.zcwv-theme-dark) .zcwv-range::-webkit-slider-runnable-track{height:4px;border-radius:2px;' +
      'background:linear-gradient(to right,var(--zcw-accent) 0 var(--zcw-range-pct,50%),rgba(0,0,0,.14) var(--zcw-range-pct,50%) 100%);' +
      'box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}',
    ':root:not(.zcwv-theme-dark) .zcwv-range::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;' +
      'width:13px;height:13px;border-radius:50%;background:var(--zcw-accent);border:none;margin-top:-4.5px}',
    // 菜单/面板里的控件统一质感（与一级设置面板同一套 token）：圆角、主题底色、
    // hover 与 focus 反馈。原生 select 的箭头用 appearance:none 去掉后自绘——
    // 两个渐变拼成的小三角，颜色取 currentColor，深浅主题都自适应。
    // 注意过渡只能挂 background-color：hover 若用 background 简写，会把自绘
    // 三角的 background-image/position 一并清掉，配合过渡就会看到「三角从左
    // 边飞到右边」（实测 hover 瞬间 backgroundImage 变 none、位置重置到 0）。
    '.zcwv-number,.zcwv-sound{appearance:none;-webkit-appearance:none;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.5;color:var(--zcw-ink);background:var(--zcw-card);border:1px solid var(--zcw-ink-input);border-radius:var(--zcw-radius);padding:4px 8px;transition:background-color .15s ease,border-color .15s ease,box-shadow .15s ease}',
    '.zcwv-number{width:52px;text-align:center}',
    '.zcwv-number:disabled{opacity:.45;background:var(--zcw-ink-faint);cursor:not-allowed}',
    '.zcwv-sound{cursor:pointer}',
    'select.zcwv-sound{flex:1;min-width:86px;padding-right:22px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 13px) calc(50% + 1px),calc(100% - 9px) calc(50% + 1px);background-size:4px 4px,4px 4px;background-repeat:no-repeat}',
    // 原生 select 已被自定义下拉（makeStyledSelect）替代：组件本体藏起来只当
    // 数据源，测试与既有点击逻辑继续读写它的 value/options/change。
    'select.zcwv-select-native{position:absolute;left:-9999px;top:0;width:12px;height:12px;opacity:0;pointer-events:none;flex:0 0 auto;min-width:0;padding:0;border:0;background:none}',
    'button.zcwv-sound{flex:0 0 auto;white-space:nowrap}',
    '.zcwv-number:hover:not(:disabled),.zcwv-sound:hover{background-color:var(--zcw-ink-faint);border-color:var(--zcw-ink-soft)}',
    'button.zcwv-sound:active{background-color:var(--zcw-ink-soft)}',
    // 焦点环：ink-faint 只有 8% 透明度、键盘导航时基本看不见（UI 审查 U10）。
    // 改半透明 accent：第二行 color-mix 在支持时用 35% accent、不支持沿用前值
    '.zcwv-number:focus,.zcwv-sound:focus,.zcwv-sound:focus-visible{outline:none;border-color:var(--zcw-accent);box-shadow:0 0 0 2px var(--zcw-ink-soft);box-shadow:0 0 0 2px color-mix(in srgb,var(--zcw-accent) 35%,transparent)}',
    '.zcwv-textarea{flex:1;min-width:0;min-height:34px;resize:vertical;font:inherit;font-size:12px;line-height:1.35;color:var(--zcw-ink);background:var(--zcw-card);border:1px solid var(--zcw-ink-input);border-radius:var(--zcw-radius);padding:5px 7px;box-sizing:border-box;transition:background-color .15s ease,border-color .15s ease,box-shadow .15s ease}',
    '.zcwv-textarea:focus{outline:none;border-color:var(--zcw-accent);box-shadow:0 0 0 2px var(--zcw-ink-soft);box-shadow:0 0 0 2px color-mix(in srgb,var(--zcw-accent) 35%,transparent)}',
    '.zcwv-field{display:flex;align-items:flex-start;gap:6px;margin:6px 0}',
    '.zcwv-field > .zcwv-tag{align-self:center}',
    '.zcwv-tag{flex:0 0 auto;font-size:11px;color:var(--zcw-text-dim);white-space:nowrap}',
    '.zcwv-editor-hint{font-size:10px;line-height:1.6;color:var(--zcw-text-dim);margin:2px 0 8px}',
    '.zcwv-editor-hint code{font-size:10px;background:var(--zcw-ink-faint);border-radius:4px;padding:0 3px}',
    '.zcwv-editor-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:8px}',
    // ---------- 按压泡泡可视化编辑器（DSH 三级页移植：卡片 / 芯片区 / 气泡预览） ----------
    '.zcwv-editor{width:472px}',
    '.zcwv-bq-sec{font-size:10px;color:var(--zcw-text-dim);margin:8px 0 2px}',
    '.zcwv-bq-card{position:relative;border:1.5px dashed var(--zcw-ink-input);border-radius:10px;padding:8px 10px 10px;margin:6px 0;cursor:pointer;transition:border-color .15s ease,background .15s ease;background:transparent}',
    '.zcwv-bq-card:hover{border-color:var(--zcw-accent);background:var(--zcw-card)}',
    '.zcwv-bq-card.zcwv-bq-dragging{opacity:.45}',
    // 拖拽排序：卡片/芯片里都是文字，不关掉文本选择的话浏览器会发起"拖选中文字"
    // 而不是我们的指针手势。**绝不能**给这些元素开 -webkit-user-drag:element：
    // 那会让浏览器走原生 HTML5 拖拽（拖起来只有禁止光标、指针事件被原生拖拽吞掉，
    // 排序彻底失效——实测反馈）。原图预览的 <img> 也要关掉原生图片拖拽。
    '.zcwv-bq-card,.zcwv-bq-chip,.zcwv-bq-cols{user-select:none;-webkit-user-select:none;-webkit-user-drag:none}',
    '.zcwv-bprev-img{-webkit-user-drag:none;user-select:none}',
    '.zcwv-bq-cardlabel{font-size:10px;color:var(--zcw-text-dim);margin:0 0 5px;display:flex;align-items:center;gap:4px}',
    '.zcwv-bq-cols{display:flex;gap:6px;align-items:stretch;margin:6px 0}',
    '.zcwv-bq-cols > .zcwv-bq-card{flex:1;min-width:0}',
    '.zcwv-bq-wbadge{position:absolute;top:-8px;right:8px;background:var(--zcw-accent);color:var(--zcw-panel);font-size:10px;border-radius:8px;padding:0 6px;line-height:16px;white-space:nowrap}',
    '.zcwv-bq-handle{cursor:grab;color:var(--zcw-text-dim);letter-spacing:-1px;user-select:none}',
    '.zcwv-bq-plus{display:flex;align-items:center;justify-content:center;gap:4px;width:100%;margin:6px 0}',
    // 迷你气泡预览：与真气泡同构（圆角框 + 小尾巴 + 三行/图片）
    '.zcwv-bprev{position:relative;background:var(--zcw-panel);border:1.5px solid var(--zcw-ink);border-radius:12px;padding:6px 12px;min-height:34px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:1px;overflow:visible;text-align:center}',
    '.zcwv-bprev-tail{position:absolute;left:14px;bottom:-5px;width:9px;height:9px;background:var(--zcw-panel);border-left:1.5px solid var(--zcw-ink);border-bottom:1.5px solid var(--zcw-ink);transform:rotate(-45deg)}',
    '.zcwv-bprev-line{font-size:11px;line-height:1.4;color:var(--zcw-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
    '.zcwv-bprev-B{font-size:13px;font-weight:600}',
    '.zcwv-bprev-C{font-size:10px;color:var(--zcw-text-dim)}',
    '.zcwv-bprev.zcwv-bprev-big{border-radius:18px;padding:14px 18px;min-height:96px;gap:4px;justify-content:center}',
    '.zcwv-bprev-big .zcwv-bprev-line{font-size:13px;white-space:normal}',
    '.zcwv-bprev-big .zcwv-bprev-B{font-size:17px}',
    '.zcwv-bprev-big .zcwv-bprev-C{font-size:11px}',
    '.zcwv-bprev-img{max-height:64px;border-radius:6px}',
    '.zcwv-bprev-big .zcwv-bprev-img{max-height:110px}',
    // 芯片拖拽区（第 2 级）：模块芯片可拖拽排序、从调色板拖入
    '.zcwv-bq-chips{display:flex;flex-wrap:wrap;gap:6px;border:1.5px dashed var(--zcw-ink-input);border-radius:10px;padding:8px;min-height:40px;align-items:center}',
    '.zcwv-bq-chips.zcwv-bq-drop{border-color:var(--zcw-accent);background:var(--zcw-card)}',
    '.zcwv-bq-chip{display:inline-flex;align-items:center;gap:5px;background:var(--zcw-card);border:1px solid var(--zcw-ink-input);border-radius:999px;padding:3px 9px;font-size:11px;cursor:grab;user-select:none}',
    '.zcwv-bq-chip.zcwv-bq-viewchip{border-style:dashed}',
    '.zcwv-bq-chip.zcwv-bq-dragging{opacity:.45}',
    '.zcwv-bq-chip button{border:none;background:none;color:var(--zcw-text-dim);cursor:pointer;font-size:11px;padding:0 1px;font-family:inherit}',
    '.zcwv-bq-chip button.zcwv-bq-del:hover{color:var(--zcw-red)}',
    // 图库网格（第 3 级 图片/随机图片编辑）
    '.zcwv-bq-grid{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}',
    '.zcwv-bq-thumb{width:66px;cursor:pointer;text-align:center;border:none;background:none;padding:0;font-family:inherit}',
    '.zcwv-bq-thumb img{width:64px;height:48px;object-fit:contain;background:var(--zcw-card);border:1.5px solid var(--zcw-ink-input);border-radius:8px;box-sizing:border-box;display:block;margin:0 auto}',
    '.zcwv-bq-thumb.zcwv-bq-sel img{border-color:var(--zcw-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--zcw-accent) 35%,transparent)}',
    '.zcwv-bq-thumbname{display:block;font-size:9px;color:var(--zcw-text-dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    // 随机语句权重表（第 3 级）
    '.zcwv-bq-wtable{margin:4px 0}',
    '.zcwv-bq-wrow{display:flex;align-items:center;gap:6px;margin:5px 0}',
    '.zcwv-bq-wrow input[type=number]{width:56px;flex:0 0 auto}',
    // U30：权重表「内容」列的文本输入（左对齐；数字框类会让文字居中、长句难读）
    '.zcwv-bq-cin{flex:1;min-width:0;font:inherit;font-size:12px;color:var(--zcw-ink);background:var(--zcw-card);border:1px solid var(--zcw-ink-input);border-radius:var(--zcw-radius);padding:4px 7px;text-align:left;box-sizing:border-box}',
    '.zcwv-bq-cin:focus{outline:none;border-color:var(--zcw-accent)}',
    '.zcwv-bq-whead{display:flex;align-items:center;gap:6px;margin:6px 0 0;font-size:10px;color:var(--zcw-text-dim)}',
    '.zcwv-bq-whead span:first-child{width:56px;flex:0 0 auto;text-align:center}',
    '.zcwv-bq-whead span:nth-child(2){flex:1}',
    // ---------- 角色选择（自定义下拉：导入件行带改名与删除） ----------
    '.zcwv-role-trigger{display:inline-flex;align-items:center;justify-content:space-between;gap:6px;flex:1;min-width:96px;text-align:left}',
    '.zcwv-role-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.zcwv-role-caret{flex:0 0 auto;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;opacity:.65}',
    '.zcwv-roles{position:fixed;min-width:200px;max-width:272px;background:var(--zcw-panel-solid);border:1px solid var(--zcw-ink-soft);border-radius:var(--zcw-radius-lg);padding:8px 10px;z-index:10002;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:var(--zcw-cs);color:var(--zcw-ink);font-size:12px;opacity:0;transform:scale(.96);transform-origin:bottom right;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);pointer-events:none}',
    '.zcwv-roles.zcwv-roles-open{opacity:1;transform:none;pointer-events:auto}',
    '.zcwv-roles-head{font-size:11px;color:var(--zcw-text-dim);margin:0 0 6px}',
    '.zcwv-role-row{display:flex;align-items:center;gap:4px;margin:3px 0}',
    '.zcwv-role-pick{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font:inherit;font-size:12px;color:var(--zcw-ink);background:transparent;border:1px solid transparent;border-radius:var(--zcw-radius);padding:4px 7px;cursor:pointer}',
    '.zcwv-role-pick:hover{background:var(--zcw-ink-faint)}',
    // 键盘焦点可视（UI 审查 U10）：面板关闭/返回/排名切换、角色列表行与小按钮、
    // 复选框此前只有 hover 或干脆没有焦点样式
    '.zcwv-role-pick:focus-visible,.zcwv-role-mini:focus-visible,.zcwv-check:focus-visible{outline:2px solid var(--zcw-accent);outline-offset:1px}',
    '.zcwv-role-row-on .zcwv-role-pick{background:var(--zcw-ink-faint);border-color:var(--zcw-ink-input);font-weight:600}',
    // inline-flex + 居中：「内置」徽章是 span（flex 项被块化），只有 height 没有
    // 垂直对齐时 10px 文字会贴在 22px 盒子顶部（用户实测「文字偏上」）
    '.zcwv-role-mini{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 4px;font:inherit;font-size:12px;line-height:1;color:var(--zcw-text-dim);background:transparent;border:1px solid transparent;border-radius:var(--zcw-radius);cursor:pointer}',
    '.zcwv-role-mini:hover{background:var(--zcw-ink-faint);color:var(--zcw-ink)}',
    '.zcwv-role-del:hover{color:var(--zcw-red)}',
    '.zcwv-role-builtin{font-size:10px;cursor:default}',
    '.zcwv-role-rename{flex:1;min-width:0}',
    '.zcwv-roles-hint{font-size:10px;color:var(--zcw-text-dim);margin-top:6px}',
    '.zcwv-check{width:16px;height:16px;accent-color:var(--zcw-accent);cursor:pointer;flex:0 0 auto}',
    // 浅色档自绘复选框（用户 2026-10-07 反馈）：原生勾选态那个方框的描边观感比旁边的
    // 文本框重一截，看着突兀。自绘后勾选与未勾选同为 1px 描边（与文本框、下拉一致），
    // 勾选态改为「角色色填充 + 底板色对勾」。深色档保持原生绘制（不动）。
    ':root:not(.zcwv-theme-dark) .zcwv-check{appearance:none;-webkit-appearance:none;position:relative;' +
      'box-sizing:border-box;border:1px solid var(--zcw-ink-input);border-radius:4px;background:var(--zcw-card)}',
    ':root:not(.zcwv-theme-dark) .zcwv-check:checked{background:var(--zcw-accent);border-color:var(--zcw-accent)}',
    ':root:not(.zcwv-theme-dark) .zcwv-check:checked::after{content:"";position:absolute;left:4px;top:1px;' +
      'width:5px;height:9px;border:solid var(--zcw-card);border-width:0 2px 2px 0;transform:rotate(45deg)}',
    '.zcwv-menu-sep{height:1px;background:var(--zcw-ink-sep);margin:6px 0}',
    '.zcwv-volpct{width:44px;text-align:right;color:var(--zcw-ink);font-size:12px}',
    // ---------- 主题变量：浅色 = 原版蓝系；深色 = ZCode zai-dark 实测 token ----------
    // text-dim 在原版基础上单独加深（浅色 #9fb0d9→#7d90c2，2.17:1→3.16:1 达
    // WCAG large-text 档；深色 .6→.72 ≈5:1 达 AA）：小字承载「今日已用·对账」
    // 这类关键信息，原值太淡；仍保留与正文的层级差，其余 token 不动（U12）
    // 圆角两档 token：控件 8px、容器 10px（UI 审查 U8——此前 6/7/8px 混用，
    // 7px 无出处；4px 进度条与 1px 按钮条纹是结构件不在此列）
    // --zcw-panel-solid 给「会叠在别的弹层之上」的下拉列表用：半透明底两层
    // 叠加（.92×.92）会透出底下菜单的文字，叠层场景必须用实色（UI 审查 U3）
    // --zcw-amber 是本仓新增 token（无上游观感包袱），浅色原值 #c98a1b 在白底
    // 只有 2.94:1，而它承载额度卡 70–89% 档的百分比数字（12px 小字）——加深到
    // #96660c（≈5.0:1，仍是琥珀色系）。深色 #ffb84d 对 #2b2b2b 有 8.2:1，不动
    // （UI 审查 U20）
    ':root{--zcw-cs:light;--zcw-radius:8px;--zcw-radius-lg:10px;--zcw-text:#536ba9;--zcw-text-dim:#7d90c2;--zcw-ink:#203170;--zcw-ink-hover:#2f4488;--zcw-ink-soft:rgba(32,49,112,.35);--zcw-ink-faint:rgba(32,49,112,.08);--zcw-ink-sep:rgba(32,49,112,.25);--zcw-ink-input:rgba(32,49,112,.4);--zcw-btn-bg:rgba(255,255,255,.95);--zcw-btn-bg-hover:#f2f4f8;--zcw-btn-bar:#203170;--zcw-panel:rgba(255,255,255,.92);--zcw-panel-solid:#fff;--zcw-card:#fff;--zcw-bubble-fill:#fff;--zcw-red:#e0433f;--zcw-green:#2fa24c;--zcw-amber:#96660c;--zcw-accent:#203170}',
    ':root.zcwv-theme-dark{--zcw-cs:dark;--zcw-text:#d4d4d4;--zcw-text-dim:rgba(212,212,212,.72);--zcw-ink:#d4d4d4;--zcw-ink-hover:#fff;--zcw-ink-soft:rgba(255,255,255,.16);--zcw-ink-faint:rgba(255,255,255,.08);--zcw-ink-sep:rgba(255,255,255,.12);--zcw-ink-input:rgba(255,255,255,.2);--zcw-btn-bg:rgba(43,43,43,.95);--zcw-btn-bg-hover:rgba(70,70,70,.95);--zcw-btn-bar:#d4d4d4;--zcw-panel:rgba(43,43,43,.96);--zcw-panel-solid:#2b2b2b;--zcw-card:#2b2b2b;--zcw-bubble-fill:#2b2b2b;--zcw-red:#ff5c5c;--zcw-green:#46bf72;--zcw-amber:#ffb84d;--zcw-accent:#4099ff}',
    // ---------- 用量记录面板 ----------
    '.zcwv-panel{position:fixed;width:320px;max-width:92vw;max-height:72vh;overflow:auto;background:var(--zcw-panel);border:1px solid var(--zcw-ink-soft);border-radius:var(--zcw-radius-lg);padding:10px 12px;z-index:10001;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:var(--zcw-cs);font-size:12px;color:var(--zcw-ink);opacity:0;transform:scale(.96);transform-origin:bottom right;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);pointer-events:none}',
    '.zcwv-panel.zcwv-panel-open{opacity:1;transform:none;pointer-events:auto}',
    '.zcwv-panel h4{margin:8px 0 4px;font-size:12px;font-weight:600}',
    // 记账二级页（=角色名记账=）：壳复用 .zcwv-panel（含定位与开合过渡），
    // 行布局与菜单行同构；行首标签同样给最小列宽，控件列左缘对齐
    '.zcwv-book{min-width:236px}',
    '.zcwv-book-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px}',
    '.zcwv-book-head h4{margin:0;font-size:12px;font-weight:600}',
    '.zcwv-book-row{display:flex;align-items:center;gap:8px;margin:5px 0;color:var(--zcw-ink);font-size:12px;white-space:nowrap}',
    '.zcwv-book-row > span:first-child{flex:0 0 auto;min-width:58px}',
    '.zcwv-panel h4:first-child{margin-top:0}',
    '.zcwv-bar{height:8px;border-radius:4px;background:var(--zcw-ink-faint);overflow:hidden;margin:2px 0 6px}',
    '.zcwv-bar > i{display:block;height:100%;background:var(--zcw-accent)}',
    '.zcwv-row{display:flex;justify-content:space-between;gap:8px;margin:2px 0;white-space:nowrap;align-items:center}',
    '.zcwv-dim{color:var(--zcw-text-dim)}',
    '.zcwv-red{color:var(--zcw-red)}',
    '.zcwv-events{max-height:170px;overflow:auto;border-top:1px solid var(--zcw-ink-soft);margin-top:6px;padding-top:4px}',
    '.zcwv-panel-close{border:1px solid var(--zcw-ink-soft);background:var(--zcw-card);border-radius:var(--zcw-radius);color:var(--zcw-ink);cursor:pointer;font-size:11px;padding:2px 8px}',
    // 关闭/返回/排名切换 5 处在用，此前 hover/focus 都没有反馈（UI 审查 U10）
    '.zcwv-panel-close:hover{background-color:var(--zcw-ink-faint);border-color:var(--zcw-ink-soft)}',
    '.zcwv-panel-close:active{background-color:var(--zcw-ink-soft)}',
    '.zcwv-panel-close:focus-visible{outline:2px solid var(--zcw-accent);outline-offset:1px}',
    // 系统开启「减少动态效果」时去掉位移/缩放/过渡，保留功能性状态变化；
    // 数字滚动是 JS rAF 实现，在 animateAmount 里另行短路（UI 审查 U14）
    '@media (prefers-reduced-motion:reduce){.zcwv-body,.zcwv-text,.zcwv-bubble .zcwv-bshape,.zcwv-bubble .zcwv-b1,.zcwv-bubble .zcwv-b2,.zcwv-menu,.zcwv-roles,.zcwv-panel,.zcwv-root{transition-duration:.01ms !important;animation-duration:.01ms !important}}',
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
  // 形象图每次加载完成都重建命中图：换角色后轮廓变了，
  // 沿用旧图会让命中区域错位
  img.addEventListener('load', function () {
    setupHitTest()
  })

  var menuBtn = el('button', 'zcwv-menu-btn')
  menuBtn.type = 'button'
  menuBtn.title = '菜单'
  menuBtn.innerHTML = '<span></span><span></span><span></span>'
  menuBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    // 这里刻意不出声：菜单键是界面控件，点它响一下会被当成误触发音效
    // （按压音只属于「按鲸鱼」和「点气泡」这两种对角色本体的操作）。
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

  // 拖动条的填充比例：浅色档的轨道是自绘两段渐变（见 CSS），段边界靠这个变量。
  // 值会在多处被改（拖动 / 数字框 / 加减 / 读配置），所以统一由 setScale、setVol
  // 与「读配置」这三处调用，别在别处散着写。
  function syncRangeFill(el) {
    try {
      var min = Number(el.min)
      var max = Number(el.max)
      var v = Number(el.value)
      if (!isFinite(min) || !isFinite(max) || max <= min || !isFinite(v)) return
      var pct = ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100
      el.style.setProperty('--zcw-range-pct', pct.toFixed(1) + '%')
    } catch (err) {}
  }

  var scaleInput = el('input', 'zcwv-range')
  scaleInput.type = 'range'
  scaleInput.min = String(MIN_SCALE)
  scaleInput.max = String(MAX_SCALE)
  scaleInput.step = '0.1'
  scaleInput.value = '1.5'
  syncRangeFill(scaleInput)
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
  // ---------- 自定义下拉（与角色下拉同一套触发器 + 主题化列表） ----------
  // 原生 select 在浮层里有三个硬伤：系统弹出的下拉列表不吃主题（深色下白底
  // 刺眼）；弹出期间模态捕获全屏鼠标（鲸鱼/菜单全部点不动）；点击下拉还得
  // 临时把窗口改成可激活（抢 ZCode 前台导致它停止刷新）。统一换成角色下拉
  // 同款交互。select 本体仍留在 DOM 里当唯一数据源：value/options/change
  // 监听与既有测试全部不变，界面上只多出触发按钮和主题化选项列表。
  var openDd = null // 当前打开的通用下拉的关闭函数；null = 全部收起
  var ddSyncFns = []
  function syncAllDd() {
    ddSyncFns.forEach(function (fn) {
      try {
        fn()
      } catch (err) {}
    })
  }
  function closeOpenDd() {
    if (openDd) {
      var fn = openDd
      openDd = null
      try {
        fn()
      } catch (err) {}
    }
    syncKeyboardFocus()
  }
  function makeStyledSelect(select, title, opts) {
    opts = opts || {}
    select.classList.add('zcwv-select-native')
    document.body.appendChild(select)
    var trigger = el('button', 'zcwv-sound zcwv-role-trigger')
    trigger.type = 'button'
    if (title) trigger.title = '选择' + title
    var labelEl = el('span', 'zcwv-role-name', '')
    trigger.appendChild(labelEl)
    trigger.appendChild(el('i', 'zcwv-role-caret'))
    var list = el('div', 'zcwv-roles')
    document.body.appendChild(list)
    function syncLabel() {
      var o = select.options[select.selectedIndex]
      labelEl.textContent = o ? o.textContent : ''
    }
    function renderRows() {
      while (list.firstChild) list.removeChild(list.firstChild)
      if (title) list.appendChild(el('div', 'zcwv-roles-head', title))
      for (var i = 0; i < select.options.length; i++) {
        ;(function (opt) {
          var row = el('div', 'zcwv-role-row' + (opt.value === select.value ? ' zcwv-role-row-on' : ''))
          var pick = el('button', 'zcwv-role-pick', opt.textContent)
          pick.type = 'button'
          pick.addEventListener('click', function (e) {
            e.stopPropagation()
            setOpen(false)
            if (select.value !== opt.value) {
              select.value = opt.value
              syncLabel()
              try {
                select.dispatchEvent(new Event('change'))
              } catch (err) {}
            }
          })
          row.appendChild(pick)
          // 可选的行内操作按钮（与角色列表同款交互）：目前只有音效集删除用
          // （两步确认：第一次点变「再点删除」，确认语义由 onClick 自己维护）
          var act = opts.rowAction ? opts.rowAction(opt) : null
          if (act) {
            var actBtn = el('button', 'zcwv-role-mini zcwv-role-del', act.text)
            actBtn.type = 'button'
            if (act.title) actBtn.title = act.title
            actBtn.addEventListener('click', function (e) {
              e.stopPropagation()
              try {
                act.onClick()
              } catch (err) {}
              renderRows()
            })
            row.appendChild(actBtn)
          }
          list.appendChild(row)
        })(select.options[i])
      }
    }
    function isOpen() {
      return list.classList.contains('zcwv-roles-open')
    }
    function positionList() {
      try {
        var r = trigger.getBoundingClientRect()
        var fv = pageViewport()
        var w = list.offsetWidth || 200
        var h = list.offsetHeight || 120
        var left = clamp(r.left, 8, Math.max(8, fv.w - w - 8))
        var top = r.top - h - 6
        if (top < 8) top = Math.min(r.bottom + 6, Math.max(8, fv.h - h - 8))
        list.style.left = left + 'px'
        list.style.top = top + 'px'
      } catch (err) {}
    }
    function setOpen(v) {
      var want = !!v
      if (want === isOpen()) return
      if (want) {
        renderRows()
        verifyFramesFlowing()
        closeRoleList() // 角色下拉与通用下拉互斥
        list.classList.add('zcwv-roles-open')
        positionList()
        openDd = close
      } else {
        list.classList.remove('zcwv-roles-open')
        if (openDd === close) openDd = null
      }
    }
    function close() {
      setOpen(false)
    }
    trigger.addEventListener('click', function (e) {
      e.stopPropagation()
      var was = isOpen()
      closeOpenDd() // 先收起其它下拉（含自己，下面按 toggle 结果重设）
      setOpen(!was)
    })
    ddSyncFns.push(syncLabel)
    syncLabel()
    // 选项或行内按钮状态变化后手动刷新（列表开着时也要即时反映）
    trigger.refresh = function () {
      syncLabel()
      if (isOpen()) renderRows()
    }
    return trigger
  }
  var soundSelect = el('select', 'zcwv-sound')
  soundSelect.addEventListener('change', function () {
    setSoundSet(soundSelect.value)
  })
  // 音效库：内置两套（小黄鸭/音效1）+ 导入集。列表来自 /whale/sounds.json，
  // 导入/删除与角色同一条链路（文件 → base64 → 服务端落盘 + 索引）；删除也是
  // 列表逐行 ×（两步确认），与角色列表结构一致。
  var soundSets = [] // [{ id, name, builtin }]
  var soundDeleteArmed = '' // 两步确认中的音效集 id（'' = 未进入确认）
  var soundFile = el('input')
  soundFile.type = 'file'
  soundFile.accept = 'audio/*'
  soundFile.multiple = true
  soundFile.style.display = 'none'
  document.body.appendChild(soundFile)
  var soundImportBtn = el('button', 'zcwv-sound', '导入…')
  soundImportBtn.type = 'button'
  soundImportBtn.title = '导入音效：选 1 个音频按压松手共用，2 个则第 1 个按压、第 2 个松手（单个不超过 2MB）'
  soundImportBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    soundFile.click()
  })
  // 下拉列表的逐行删除按钮（只给导入集）：与角色列表同款两步确认
  function soundRowAction(opt) {
    var cur = soundSetById(opt.value)
    if (!cur || cur.builtin) return null
    return {
      text: soundDeleteArmed === opt.value ? '再点删除' : '×',
      title: '删除这套导入音效',
      onClick: function () {
        if (soundDeleteArmed !== opt.value) {
          soundDeleteArmed = opt.value // 两步确认：误点一次不会删掉
          return
        }
        soundDeleteArmed = ''
        postSound({ url: SOUND_DELETE_URL, body: { id: opt.value }, failTitle: '删除失败' })
      },
    }
  }
  var soundTrigger = makeStyledSelect(soundSelect, '音效', { rowAction: soundRowAction })
  function soundSetById(id) {
    var hit = null
    soundSets.forEach(function (s) {
      if (s && s.id === id) hit = s
    })
    return hit
  }
  function renderSoundOptions() {
    var keep = soundSet
    while (soundSelect.firstChild) soundSelect.removeChild(soundSelect.firstChild)
    if (soundSets.length) {
      soundSets.forEach(function (s) {
        soundSelect.appendChild(soundOpt(s.id, s.name + (s.builtin ? '（内置）' : '')))
      })
    } else {
      // 列表还没拿到（服务未就绪）：先给内置两项，别让选择框空白
      soundSelect.appendChild(soundOpt('duck', '小黄鸭（内置）'))
      soundSelect.appendChild(soundOpt('fx1', '音效1（内置）'))
    }
    // 配置里选中的那套已经不存在（比如被删掉后服务重启前）：保留成一个选项，
    // 免得 select.value 落空显示成别的音效
    var known = false
    soundSets.forEach(function (s) {
      if (s && s.id === keep) known = true
    })
    if (keep && !known) soundSelect.appendChild(soundOpt(keep, keep))
    soundSelect.value = keep || 'duck'
    // 选项重建过：触发按钮文字与列表（含逐行删除按钮）要跟着同步
    try {
      syncAllDd()
    } catch (err) {}
    if (soundTrigger && soundTrigger.refresh) soundTrigger.refresh()
  }
  function loadSounds() {
    try {
      fetch(SOUNDS_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok) return
          applySoundsPayload(d)
        })
        .catch(function () {})
    } catch (err) {}
  }
  function applySoundsPayload(d) {
    if (Array.isArray(d.sets)) soundSets = d.sets
    if (typeof d.selected === 'string' && d.selected) {
      soundSet = d.selected
      applySoundSet()
    }
    renderSoundOptions()
  }
  function postSound(opts) {
    try {
      fetch(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts.body),
      })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (d && d.ok) {
            applySoundsPayload(d)
            // 导入成功后直接启用新那套（服务端把选中项写在声明的 id 上）
            if (opts.select && d.id) setSoundSet(d.id)
          } else {
            showAlertBubble(opts.failTitle, (d && d.error) || '未知错误')
          }
        })
        .catch(function () {
          showAlertBubble(opts.failTitle, COPY_NET_FAIL)
        })
    } catch (err) {}
  }
  soundFile.addEventListener('change', function () {
    var files = soundFile.files ? Array.prototype.slice.call(soundFile.files, 0, 2) : []
    soundFile.value = ''
    if (!files.length) return
    var jobs = files.map(function (f) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader()
        reader.onload = function () {
          resolve({ dataUrl: String(reader.result), name: f.name })
        }
        reader.onerror = function () {
          reject(new Error('文件读取失败'))
        }
        reader.readAsDataURL(f)
      })
    })
    Promise.all(jobs)
      .then(function (list) {
        var body = { name: String(list[0].name || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 24), press: list[0] }
        if (list[1]) body.release = list[1]
        postSound({ url: SOUND_UPLOAD_URL, body: body, failTitle: '音效导入失败', select: true })
      })
      .catch(function () {
        showAlertBubble('音效导入失败', '文件读取失败')
      })
  })
  var usageSelect = el('select', 'zcwv-sound')
  usageSelect.appendChild(soundOpt('ledger', '小鲸鱼记账 (推荐)'))
  usageSelect.appendChild(soundOpt('token', '实时·令牌 (需平台令牌)'))
  usageSelect.addEventListener('change', function () {
    setUsageMode(usageSelect.value)
  })
  // 「对账口径」= 账号级口径（小鲸鱼记账 / 实时·令牌）：主显示的今日已用固定
  // 用本机库（按模型看得见、不受充值干扰），这一档只决定「对账 + 兜底」用哪个
  // 账号数字——含其它设备/其它 key 的花费只有账号口径看得到。
  var usageTrigger = makeStyledSelect(usageSelect, '对账口径')
  var peakSelect = el('select', 'zcwv-sound')
  peakSelect.appendChild(soundOpt('default', '默认'))
  peakSelect.appendChild(soundOpt('liangwen', '梁文峰谷'))
  peakSelect.appendChild(soundOpt('qiangqiang', '!?强强?!'))
  peakSelect.addEventListener('change', function () {
    setPeakMode(peakSelect.value)
  })
  var peakTrigger = makeStyledSelect(peakSelect, '峰谷播报')
  var themeSelect = el('select', 'zcwv-sound')
  themeSelect.appendChild(soundOpt('system', '跟随 ZCode'))
  themeSelect.appendChild(soundOpt('light', '浅色模式'))
  themeSelect.appendChild(soundOpt('dark', '深色模式'))
  themeSelect.addEventListener('change', function () {
    setTheme(themeSelect.value)
  })
  var themeTrigger = makeStyledSelect(themeSelect, '主题')
  // 保留「选择…」前缀：下拉触发器靠它互相区分（测试也按它查找）
  themeTrigger.title = '选择主题（跟随 ZCode = 跟 ZCode 当前主题；ZCode 自己设为跟随系统时跟随系统）'
  // 'system' = 跟随 **ZCode 当前主题**（读它的配置 ui.theme，见 lib/zcode-theme.mjs），
  // 不是跟随操作系统：在 ZCode 里手选了浅/深色时，挂件跟着系统走就是错的。
  // ZCode 没有明确选浅/深（system/auto/配置缺失）时才退回操作系统的深浅色——
  // 那正是 ZCode 自己的「跟随系统」语义。
  var zcodeTheme = 'system' // 'light' | 'dark' | 'system'：ZCode 当前主题
  var darkMedia = null
  try {
    darkMedia = window.matchMedia('(prefers-color-scheme: dark)')
  } catch (err) {}
  function systemPrefersDark() {
    return !!(darkMedia && darkMedia.matches)
  }
  function themeIsDark() {
    if (themeMode === 'dark') return true
    if (themeMode === 'light') return false
    if (zcodeTheme === 'dark') return true
    if (zcodeTheme === 'light') return false
    return systemPrefersDark()
  }
  function applyTheme() {
    try {
      document.documentElement.classList.toggle('zcwv-theme-dark', themeIsDark())
    } catch (err) {}
    applyBubbleInk()
  }
  // 角色专属的气泡配色。每个角色给浅/深两档"描边色"，文字色由它派生成两级色阶
  // （主文字提亮一档、小字再淡一档，复刻内置主题的三级色阶关系）。
  // 未登记的角色（用户导入的、以后新增但没配色的）一律回落到小鲸鱼——和台词池
  // 规则一致：小鲸鱼的设定就是默认值。
  // 注意：峰谷时段行的红/绿是**行内样式**（periodColorNow），不受这里影响。
  // 登记基准（U26）：浅色值须满足「85% 混白后对白底 ≥3:1」。kimi 与 小克 的浅色
  // 是用户直接指定的色值（低于该基准；kimi 2026-10-07 又加深到 #ad81ff，对白底
  // 2.9:1、85% 混白后约 2.4:1，仍不达标），属有意取舍，别"顺手改深"。
  var ROLE_INK_PAIR = {
    whale: { light: '#203170', dark: '#5d8dde' }, // 小鲸鱼：原版蓝（默认值 / 回落值）
    fox: { light: '#3d4460', dark: '#a7a7a7' }, // 小狐娘：浅=黑灰发色（冷调炭蓝），深=中性灰（用户指定 2026-10-07）
    gpt: { light: '#7b6fc4', dark: '#d3bae7' }, // GPT娘：淡紫（角 / 翅 / 瞳）
    kimi: { light: '#ad81ff', dark: '#b4b8e3' }, // kimi娘：浅紫 + 银蓝月饰
    xiaoke: { light: '#d97757', dark: '#d97757' }, // 小克：陶土橘（浅/深两档同色）
  }
  function applyBubbleInk() {
    try {
      var pair = ROLE_INK_PAIR[roleId] || ROLE_INK_PAIR.whale
      var dark = themeIsDark()
      var ink = dark ? pair.dark : pair.light
      var st = document.documentElement.style
      st.setProperty('--zcw-bubble-ink', ink)
      if (dark) {
        // 深色：主文字与描边同色；小字按透明度淡化（原来就是 rgba 淡出）
        st.setProperty('--zcw-bubble-text', ink)
        st.setProperty('--zcw-bubble-text-dim', 'color-mix(in srgb, ' + ink + ' 74%, transparent)')
        // 深色档不跟角色色：--zcw-role-ink 只服务浅色模式下的设置按钮 / 设置窗口着色
        st.removeProperty('--zcw-role-ink')
      } else {
        // 浅色：由描边色向白提亮两级（U26：72/52 的旧比例在浅色角色上对比度
        // 掉到 3:1 以下，整体加深到 85/62——鲸鱼观感几乎不变）
        st.setProperty('--zcw-bubble-text', 'color-mix(in srgb, ' + ink + ' 85%, #fff)')
        st.setProperty('--zcw-bubble-text-dim', 'color-mix(in srgb, ' + ink + ' 62%, #fff)')
        // 设置按钮与设置窗口也跟随角色（用户 2026-10-06 指定）：写法见 CSS 里那条
        // :root:not(.zcwv-theme-dark) 规则——它把这棵子树里的 ink 系与 accent 换成这个色
        st.setProperty('--zcw-role-ink', ink)
      }
    } catch (err) {}
  }
  function setTheme(v) {
    themeMode = v === 'dark' || v === 'system' ? v : 'light'
    themeSelect.value = themeMode
    applyTheme()
    saveConfig()
  }
  // ZCode 主题轮询：用户中途在 ZCode 里换主题，挂件要跟着变（10 秒一次本地读）
  function pollZcodeTheme() {
    try {
      fetch(ZCODE_THEME_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok) return
          var next = d.theme === 'dark' ? 'dark' : d.theme === 'light' ? 'light' : 'system'
          if (next === zcodeTheme) return
          zcodeTheme = next
          if (themeMode === 'system') applyTheme()
        })
        .catch(function () {})
    } catch (err) {}
  }
  pollZcodeTheme()
  setInterval(pollZcodeTheme, 10000)
  if (darkMedia) {
    var onSchemeChange = function () {
      // 只有落到「系统深浅色」这一层时系统切换才相关（ZCode 明确选了浅/深则不听系统）
      if (themeMode === 'system' && zcodeTheme === 'system') applyTheme()
    }
    try {
      if (darkMedia.addEventListener) darkMedia.addEventListener('change', onSchemeChange)
      else if (darkMedia.addListener) darkMedia.addListener(onSchemeChange) // 老 Chromium 兜底
    } catch (err) {}
  }
  var displaySelect = el('select', 'zcwv-sound')
  displaySelect.appendChild(soundOpt('auto', '自动跟随'))
  displaySelect.appendChild(soundOpt('plan', 'GLM Plan 配额'))
  displaySelect.appendChild(soundOpt('cmdgo', 'CommandCode 额度'))
  displaySelect.appendChild(soundOpt('glm', 'GLM 按量'))
  displaySelect.appendChild(soundOpt('ds', 'DeepSeek'))
  displaySelect.addEventListener('change', function () {
    setDisplayMode(displaySelect.value)
  })
  var displayTrigger = makeStyledSelect(displaySelect, '显示')
  function setDisplayMode(v) {
    displayMode = ['auto', 'plan', 'cmdgo', 'glm', 'ds'].indexOf(v) !== -1 ? v : 'auto'
    displaySelect.value = displayMode
    saveConfig()
    render()
  }

  // 隐藏菜单按钮（移植 DSH「隐藏菜单按钮」）：开启后挂件上的菜单按钮不再出现，
  // 改由**右键鲸鱼**唤出菜单（菜单位置仍按按钮所在的锚点计算，与点按钮一致）。
  // 只影响按钮的显隐与唤出方式，吸附/拖拽/命中/点击链路一概不动。
  var menuBtnToggle = el('input', 'zcwv-check')
  menuBtnToggle.type = 'checkbox'
  menuBtnToggle.checked = false
  menuBtnToggle.title = '开启后隐藏挂件上的菜单按钮，改用右键点击角色唤出菜单（位置不变）'
  menuBtnToggle.addEventListener('change', function () {
    setMenuBtnHide(menuBtnToggle.checked)
  })

  // 跟随延迟（只在浮层模式下有意义）：探测 ZCode 窗口位置的间隔。
  // 越短鲸鱼跟得越紧。最低一档就是 16ms：探测脚本对入参有 16ms 的钳制下限
  // （系统定时器量子 ~15.6ms，更低的标称值不会更快——旧「5ms」档与其完全
  // 同速，2026-10-06 并入本档；循环是编译 C#，16ms 档实测 ≈0.26% 单核）。
  var FOLLOW_KEY = 'zcw-follow-ms'
  var followSelect = el('select', 'zcwv-sound')
  ;[
    ['16', '极快 · 16ms'],
    ['40', '默认 · 40ms'],
    ['100', '省电 · 100ms'],
    ['250', '很省电 · 250ms'],
  ].forEach(function (o) {
    followSelect.appendChild(soundOpt(o[0], o[1]))
  })
  function setFollowInterval(ms) {
    var n = Math.max(5, Math.min(2000, Math.round(Number(ms) || 40)))
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
  var followTrigger = makeStyledSelect(followSelect, '跟随延迟')
  function initFollowInterval() {
    var saved = 40
    try {
      var raw = localStorage.getItem(FOLLOW_KEY)
      if (raw) saved = Number(raw)
    } catch (err) {}
    // 旧「5ms」档已并入 16ms：存量值向上归一，避免 select 落到不存在的选项
    if (saved < 16) saved = 16
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

  // 桌宠模式（只对浮层有意义，浏览器模式整行不显示）：开启后挂件锁在所有窗口
  // 最上层，切到别的应用/ZCode 被盖住时也不隐身；关闭则回到「跟随 ZCode 前台」。
  // 开关只影响浮层的显隐策略，命中检测与点击链路完全不动——开不开都能点。
  var petToggle = el('input', 'zcwv-check')
  petToggle.type = 'checkbox'
  petToggle.checked = false
  petToggle.title = '桌宠模式：挂件锁在最上层，切到别的窗口也不消失（关闭时随 ZCode 前台隐身）'
  petToggle.addEventListener('change', function () {
    setPetMode(petToggle.checked)
  })

  // 预警阈值输入（0/空 = 关闭）：额度% / 金额¥（v1.8.0 泛化成两条）
  // 「金额」这一格是原来 DS¥（余额低于）与 BM¥（今日已用超过）合并来的：一个阈值
  // 对所有按金额结算的源生效——余额型看「余额低于」，消费型看「今日已用到达到」。
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
  // 「额度%」一条阈值覆盖所有能读出「还剩多少额度」的来源（GLM Plan / CommandCode）。
  // 各来源用自己的单位表达同一件事：GLM Plan 直接报剩余百分比；CommandCode 额度卡
  // 画的是**已用进度**（0→100，100 = 撞墙），判定时折成 剩余＝100−已用 再比——
  // 于是「阈值 20%」对两边都是「还剩不到两成时提醒」，用户侧看到的是进度涨上去才报。
  var alertQuotaInput = makeAlertInput(
    '额度预警：GLM Plan 剩余额度、或 CommandCode 已用进度换算出的剩余额度，任一低于该百分比时提醒；0 关闭',
    100
  )
  var alertMoneyInput = makeAlertInput('DeepSeek 余额低于该值时提醒（元），0 关闭')
  function wireAlertInput(input, key) {
    var apply = function () {
      alerts[key] = Math.max(0, Number(input.value) || 0)
      saveConfig()
    }
    input.addEventListener('input', apply)
    input.addEventListener('change', apply)
  }
  wireAlertInput(alertQuotaInput, 'quotaPct')
  wireAlertInput(alertMoneyInput, 'moneyAlert')

  // 角色：内置小狐娘（默认）/小鲸鱼 + 导入件。这里用自定义下拉而不是原生 select：
  // 导入的角色要能改名、要能在行右侧放一个小 × 删除，原生下拉塞不进按钮。
  // （选择结果仍持久化到 widget-state.roleId）
  var roleTrigger = el('button', 'zcwv-sound zcwv-role-trigger')
  roleTrigger.type = 'button'
  roleTrigger.title = '选择形象（导入的可以改名，内置与导入的都可以删）'
  var roleNameEl = el('span', 'zcwv-role-name', '小狐娘')
  roleTrigger.appendChild(roleNameEl)
  roleTrigger.appendChild(el('i', 'zcwv-role-caret'))
  var roleList = el('div', 'zcwv-roles')
  document.body.appendChild(roleList)
  var rolesOpen = false
  var rolesData = { roles: [], selected: '' }
  var roleDeleteArmed = null // 删除二次确认：第一次点 × 只把按钮变成「再点删除」
  var roleFile = el('input')
  roleFile.type = 'file'
  roleFile.accept = 'image/png,image/gif,image/jpeg'
  roleFile.style.display = 'none'
  var roleImportBtn = el('button', 'zcwv-sound', '导入…')
  roleImportBtn.type = 'button'
  roleImportBtn.title = '导入形象图片（png/gif/jpeg，超过 1.5MB 自动压缩）'
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
          showAlertBubble('角色上传失败', COPY_NET_FAIL)
        })
    } catch (err) {}
  }
  function roleName(id) {
    var hit = null
    ;(rolesData.roles || []).forEach(function (r) {
      if (r && r.id === id) hit = r
    })
    return hit ? hit.name || hit.id : ''
  }
  function syncRoleTrigger() {
    // 形象可以被删光，此时显示中性文案，别硬说"小狐娘"
    roleNameEl.textContent = roleName(rolesData.selected) || (rolesData.roles.length ? '选择形象' : '默认形象')
    syncBookLabel()
  }
  function renderRoleList() {
    while (roleList.firstChild) roleList.removeChild(roleList.firstChild)
    roleList.appendChild(el('div', 'zcwv-roles-head', '选择形象'))
    ;(rolesData.roles || []).forEach(function (r) {
      var row = el('div', 'zcwv-role-row' + (r.id === rolesData.selected ? ' zcwv-role-row-on' : ''))
      var pick = el('button', 'zcwv-role-pick', r.name || r.id)
      pick.type = 'button'
      pick.title = r.builtin ? '内置形象' : '切换到该形象'
      pick.addEventListener('click', function (e) {
        e.stopPropagation()
        setRoleId(r.id)
        toggleRoleList(false)
      })
      row.appendChild(pick)
      if (r.builtin) {
        // 内置形象只能删不能改名：图片在插件包里，删除 = 记进 roles.json 的
        // hiddenBuiltins（README 写了怎么找回来）
        row.appendChild(el('span', 'zcwv-role-mini zcwv-role-builtin', '内置'))
      } else {
        var rename = el('button', 'zcwv-role-mini', '✎')
        rename.type = 'button'
        rename.title = '重命名这个导入的形象'
        rename.addEventListener('click', function (e) {
          e.stopPropagation()
          startRoleRename(r, row)
        })
        row.appendChild(rename)
      }
      var del = el('button', 'zcwv-role-mini zcwv-role-del', roleDeleteArmed === r.id ? '再点删除' : '×')
      del.type = 'button'
      del.title = r.builtin ? '从列表里移除这个内置形象（可在 roles.json 里找回）' : '删除这个导入的形象'
      del.addEventListener('click', function (e) {
        e.stopPropagation()
        if (roleDeleteArmed !== r.id) {
          // 两步确认：误点一次不会直接把形象删掉
          roleDeleteArmed = r.id
          renderRoleList()
          return
        }
        roleDeleteArmed = null
        postRole({ url: ROLE_DELETE_URL, body: { id: r.id }, failTitle: '删除失败' })
      })
      row.appendChild(del)
      roleList.appendChild(row)
    })
  }
  function startRoleRename(r, row) {
    var input = el('input', 'zcwv-textarea zcwv-role-rename')
    input.type = 'text'
    input.maxLength = 24
    input.value = r.name || ''
    while (row.firstChild) row.removeChild(row.firstChild)
    row.appendChild(input)
    setKeyboardFocus(true) // 程序化聚焦：不先让窗口可激活，浮层里根本打不了字
    input.focus()
    input.select()
    var settled = false
    var commit = function () {
      if (settled) return
      settled = true
      var v = String(input.value || '').trim().slice(0, 24)
      if (!v || v === (r.name || '')) {
        renderRoleList()
        return
      }
      postRole({ url: ROLE_RENAME_URL, body: { id: r.id, name: v }, failTitle: '重命名失败' })
    }
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') commit()
      else if (ev.key === 'Escape') {
        settled = true
        renderRoleList()
      }
    })
    input.addEventListener('blur', commit)
  }
  function postRole(opts) {
    try {
      fetch(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts.body),
      })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (d && d.ok) {
            applyRolesPayload(d)
            // 删除的正好是当前形象时服务端已回落默认角色：这边同步换图
            saveConfig()
            img.src = IMG_URL + '&t=' + Date.now()
          } else {
            showAlertBubble(opts.failTitle, (d && d.error) || '未知错误')
          }
        })
        .catch(function () {
          showAlertBubble(opts.failTitle, COPY_NET_FAIL)
        })
    } catch (err) {}
  }
  function applyRolesPayload(d) {
    // 空列表也要收（内置形象可以被删光）：只在"服务端给了数组"时才覆盖本地
    if (Array.isArray(d.roles)) rolesData.roles = d.roles
    if (typeof d.selected === 'string' && d.selected) rolesData.selected = d.selected
    else if (Array.isArray(d.roles) && !d.roles.some(function (r) { return r.id === rolesData.selected })) {
      rolesData.selected = ''
    }
    if (!rolesData.selected && rolesData.roles.length) rolesData.selected = rolesData.roles[0].id
    var prevRole = roleId
    roleId = rolesData.selected || null
    applyBubbleInk() // 角色确定后给气泡描边上色
    // 台词也按角色分套：出厂默认队列里装着该角色的语句池，角色真变了就重建一次队列
    //（首次加载时 widget-state 里可能还没有 roleId，靠这里补上；自定义配置原样重建，无影响）
    if (roleId !== prevRole) applyBubbleConfig(bubbleContent)
    renderRoleList()
    syncRoleTrigger()
    if (rolesOpen) positionRoleList()
  }
  function loadRoles() {
    try {
      fetch(ROLES_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok) return
          // 服务端列表：内置角色（小狐娘=默认、小鲸鱼）固定在前，导入件在后
          applyRolesPayload(d)
        })
        .catch(function () {})
    } catch (err) {}
  }
  function positionRoleList() {
    try {
      var r = roleTrigger.getBoundingClientRect()
      var fv = pageViewport()
      var w = roleList.offsetWidth || 220
      var h = roleList.offsetHeight || 160
      var left = clamp(r.left, 8, Math.max(8, fv.w - w - 8))
      var top = r.top - h - 6
      if (top < 8) top = Math.min(r.bottom + 6, Math.max(8, fv.h - h - 8))
      roleList.style.left = left + 'px'
      roleList.style.top = top + 'px'
    } catch (err) {}
  }
  function toggleRoleList(open) {
    var want = open === undefined ? !rolesOpen : !!open
    if (want === rolesOpen) return
    rolesOpen = want
    roleDeleteArmed = null
    if (rolesOpen) {
      renderRoleList()
      verifyFramesFlowing()
      closeOpenDd() // 角色下拉与通用下拉互斥
      roleList.classList.add('zcwv-roles-open')
      positionRoleList()
    } else {
      roleList.classList.remove('zcwv-roles-open')
    }
    syncOverlayInteractive()
  }
  function closeRoleList() {
    toggleRoleList(false)
    syncKeyboardFocus()
  }
  roleTrigger.addEventListener('click', function (e) {
    e.stopPropagation()
    toggleRoleList()
  })
  function setRoleId(id) {
    roleId = id || null
    rolesData.selected = roleId || ''
    syncRoleTrigger()
    applyBubbleInk() // 气泡描边跟着角色换色
    // 台词池同理：出厂默认队列已经把「当时那个角色」的语句池烤进去了，切完角色
    // 必须重建一次，否则要刷新页面才换台词（自定义配置原样重建，无影响）
    applyBubbleConfig(bubbleContent)
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
  syncRangeFill(volInput)
  var volPct = el('span', 'zcwv-volpct', '90%')
  volInput.addEventListener('input', function () {
    setVol(volInput.value)
  })

  // 「按压泡泡设置」入口（移植 DSH 命名；编辑器本体在自定义泡泡小节，函数声明会提升）
  var bubbleTextBtn = el('button', 'zcwv-sound', '按压泡泡设置')
  bubbleTextBtn.type = 'button'
  bubbleTextBtn.title = '打开“按压泡泡设置”（按压时的泡泡内容与点击队列）'
  bubbleTextBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    toggleBubbleEditor()
  })

  // ---------- 记账二级页（=小狐娘记账=） ----------
  // 一级菜单保留「用量记录…」（v1.8.7 从本页移回收纳前的位置）与「=角色名记账=」
  // 入口；本页收纳额度预警 / 余额预警 / 余额校正（按钮与操作逻辑复刻上游 DSH 版
  // 的 -=小鲸鱼记账=- 面板）。控制件用的是原来一级菜单里的同一批 DOM（预警输入
  // 框、校正输入框与按钮都在上面创建）——只搬位置，不新建不复制，事件与读写
  // 逻辑完全不变。
  var bookPanel = el('div', 'zcwv-panel zcwv-book')
  document.body.appendChild(bookPanel)
  var bookBtnEl = null
  var bookOpen = false
  var bookBtn = el('button', 'zcwv-sound zcwv-book-btn', '=小鲸鱼记账=')
  bookBtn.type = 'button'
  bookBtn.title = '记账：额度预警、余额预警、余额校正'
  bookBtn.addEventListener('click', function (e) {
    e.stopPropagation()
    toggleBookPanel(true)
  })
  // 文案跟随当前形象（=小狐娘记账= / =小鲸鱼记账=）。角色列表还没到或名字取不到时
  // 用兜底名，避免出现「==记账=」这种空名。
  function syncBookLabel() {
    if (!bookBtnEl) return
    bookBtnEl.textContent = '=' + (roleName(rolesData.selected) || '小鲸鱼') + '记账='
  }
  function buildBookPanel() {
    var head = el('div', 'zcwv-book-head')
    head.appendChild(el('h4', '', '记账'))
    var back = el('button', 'zcwv-panel-close', '返回')
    back.type = 'button'
    back.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleBookPanel(false)
    })
    head.appendChild(back)
    bookPanel.appendChild(head)

    // 预警（v1.8.0 泛化后两条）：额度% / 余额¥，0 = 关闭
    var alertRow = el('div', 'zcwv-book-row')
    alertRow.appendChild(menuLabel('额度%'))
    alertRow.appendChild(alertQuotaInput)
    alertRow.appendChild(menuLabel('余额¥'))
    alertRow.appendChild(alertMoneyInput)
    alertRow.title =
      '额度预警对 GLM Plan 与 CommandCode 同时生效：剩余额度低于该百分比时提醒（CommandCode 按已用进度换算，进度超过 100−该值即提醒）；0 = 关闭'
    bookPanel.appendChild(alertRow)

    // 预警内容模板（移植 DSH 的提醒模板）：三类各一份，可编辑 / 恢复内置
    var alertTplRow = el('div', 'zcwv-book-row')
    alertTplRow.appendChild(menuLabel('预警内容'))
    ;[
      ['Plan', 'alert-plan', 'GLM Plan 额度预警的内容模板'],
      ['CmdGo', 'alert-cmdgo', 'CommandCode 额度预警的内容模板'],
      ['余额', 'alert-balance', 'DeepSeek 余额预警的内容模板'],
    ].forEach(function (it) {
      var b = el('button', 'zcwv-sound', it[0])
      b.type = 'button'
      b.title = it[2] + '。占位符：{title}=默认标题、{thr}=阈值、{quota}=当前剩余、{amount}=当前余额、{name}=来源；「内置视图」= 恢复内置'
      b.addEventListener('click', function (e) {
        e.stopPropagation()
        openBubbleTemplateEditor(it[1])
      })
      alertTplRow.appendChild(b)
    })
    bookPanel.appendChild(alertTplRow)

    var corrRow = el('div', 'zcwv-book-row')
    corrRow.appendChild(corrBtn)
    bookPanel.appendChild(corrRow)
    var corrRow2 = el('div', 'zcwv-book-row')
    corrRow2.appendChild(menuLabel('到账¥'))
    corrRow2.appendChild(corrCredits)
    corrRow2.appendChild(menuLabel('扣减¥'))
    corrRow2.appendChild(corrOther)
    bookPanel.appendChild(corrRow2)
    bookPanel.appendChild(el('div', 'zcwv-roles-hint', '记账只覆盖 DeepSeek 账号；其它厂商按本机 token 用量计价'))
  }
  function positionBookPanel() {
    var mr = menuBtn.getBoundingClientRect()
    var pw = bookPanel.offsetWidth || 240
    var ph = bookPanel.offsetHeight || 170
    var left = Math.max(8, mr.right - pw)
    var top = mr.top - ph - 8
    if (top < 8) top = Math.min(mr.bottom + 8, (window.innerHeight || 800) - ph - 8)
    bookPanel.style.left = left + 'px'
    bookPanel.style.top = Math.max(8, top) + 'px'
  }
  function toggleBookPanel(open) {
    bookOpen = typeof open === 'boolean' ? open : !bookOpen
    if (bookOpen) {
      verifyFramesFlowing()
      // 先量宽高再定位（面板此刻已渲染但不可见，offsetHeight 仍可读）
      positionBookPanel()
      closeMenu()
    }
    bookPanel.classList.toggle('zcwv-panel-open', bookOpen)
    // 面板不是整窗接管区（见 overlayShouldInteract）：开关后立即重算穿透
    syncOverlayInteractive()
  }

  function buildMenu() {
    var r1 = menuRow()
    r1.appendChild(menuLabel('大小'))
    r1.appendChild(scaleInput)
    r1.appendChild(scaleNumber)
    var r2 = menuRow()
    r2.appendChild(menuLabel('音效'))
    r2.appendChild(soundTrigger)
    r2.appendChild(soundImportBtn)
    var r3 = menuRow()
    r3.appendChild(menuLabel('音量'))
    r3.appendChild(volInput)
    r3.appendChild(volPct)
    // 角色紧跟在音效设置之后（用户要求）：音效、音量、角色都是「形象本体」的
    // 设置，归成一组；其余行是计费口径与显示
    var rRole = menuRow()
    rRole.appendChild(menuLabel('角色'))
    rRole.appendChild(roleTrigger)
    rRole.appendChild(roleImportBtn)
    var r4 = menuRow()
    r4.appendChild(menuLabel('对账口径'))
    r4.appendChild(usageTrigger)
    var r5 = menuRow()
    r5.appendChild(menuLabel('峰谷'))
    r5.appendChild(peakTrigger)
    var rTheme = menuRow()
    rTheme.appendChild(menuLabel('主题'))
    rTheme.appendChild(themeTrigger)
    var rDisplay = menuRow()
    rDisplay.appendChild(menuLabel('显示'))
    rDisplay.appendChild(displayTrigger)
    var r6 = menuRow()
    r6.appendChild(menuLabel('气泡'))
    r6.appendChild(bubbleToggle)
    r6.appendChild(bubbleTextBtn)
    var r7 = menuRow()
    r7.appendChild(menuLabel('每轮消耗提示'))
    r7.appendChild(turnCostToggle)
    r7.appendChild(menuLabel('自动关闭'))
    r7.appendChild(turnCostCloseInput)
    r7.appendChild(menuLabel('秒'))
    // 消耗提示的内容编辑统一收进「按压泡泡设置」面板（首个分区），菜单不再放
    // 第二个入口（用户裁决：两个入口功能观感重复）
    var sep = el('div', 'zcwv-menu-sep')
    // 分隔线不能复用同一个节点：appendChild 对已在 DOM 里的节点是「移动」
    // 而不是复制，第二次入列会把第一条搬走，菜单里只剩一条线（UI 审查 U5）
    var sep2 = el('div', 'zcwv-menu-sep')
    var r9 = menuRow()
    r9.appendChild(menuLabel('避让滚动条'))
    r9.appendChild(scrollGapToggle)
    r9.appendChild(menuLabel('宽度'))
    r9.appendChild(scrollGapInput)
    r9.appendChild(menuLabel('px'))
    // 隐藏菜单按钮（移植 DSH）：开了之后按钮不再出现，右键角色唤出菜单
    var rHide = menuRow()
    rHide.appendChild(menuLabel('隐藏菜单按钮'))
    rHide.appendChild(menuBtnToggle)
    rHide.title = '开启后挂件上的菜单按钮不再出现；右键点击角色即可唤出菜单（菜单位置与点按钮一致）'
    // 用量记录在一级菜单（v1.8.7 用户裁决：从记账二级页移回收纳前的位置——
    // 避让滚动条 / 桌宠 / 跟随延迟行之后、分隔线之前），按钮与点击逻辑与
    // v1.8.0 收纳前一致
    var rUsage = menuRow()
    var usageBtn = el('button', 'zcwv-sound', '用量记录…')
    usageBtn.type = 'button'
    usageBtn.title = '今日 / 近 7 天 / 逐条明细'
    usageBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleUsagePanel()
    })
    rUsage.appendChild(usageBtn)
    // 记账二级页入口：文案 = 「=角色名记账=」（默认形象小狐娘 → =小狐娘记账=）。
    // 额度预警 / 余额预警 / 余额校正收在 buildBookPanel 建的二级页，按钮与操作
    // 逻辑照上游 DSH 版的 -=小鲸鱼记账=- 面板。用 var 提到外面是为了让角色
    // 切换时能同步文案。
    var rBook = menuRow()
    rBook.appendChild(bookBtn)
    // 跟随延迟与桌宠模式只对浮层生效，浏览器模式整行不显示
    var rPet = menuRow()
    rPet.appendChild(menuLabel('桌宠模式'))
    rPet.appendChild(petToggle)
    var r10 = menuRow()
    r10.appendChild(menuLabel('跟随延迟'))
    r10.appendChild(followTrigger)
    var rows = [r1, r2, r3, rRole, r4, r5, rTheme, rDisplay, r6, r7, sep]
    if (!overlayBridge) rows.push(r9, rHide)
    else rows.push(r9, rHide, rPet, r10)
    rows.push(rUsage, sep2, rBook)
    rows.forEach(function (n) {
      menuBox.appendChild(n)
    })
    bookBtnEl = bookBtn
    syncBookLabel()
    buildBookPanel()
  }
  buildMenu()

  // ---------- 气泡与文字 ----------
  var textBox = el('div', 'zcwv-text')
  var labelEl = el('div', 'zcwv-label', '') // 标题由 render() 按计费源决定
  var amountEl = el('div', 'zcwv-amount')
  var hintEl = el('div', 'zcwv-hint')
  textBox.appendChild(labelEl)
  textBox.appendChild(amountEl)
  textBox.appendChild(hintEl)
  // CommandCode 三重额度卡（v1.7.8）：与三行文本互斥显示，见 renderQuotaCard
  var qcardEl = el('div', 'zcwv-qcard')
  qcardEl.style.display = 'none'
  textBox.appendChild(qcardEl)

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
    // 今日已用的口径信息（服务端已合并）：主口径固定本机库，账号口径（记账/
    // 实时·令牌）用于对账与本机无数据时的兜底，两者差异在 hint/对账行里可见
    todayUsageSource: null, // 'db' | 'ledger' | 'token' | null
    todayUsageDb: null, // 本机库金额（无记录为 null）
    accountUsage: null, // 账号口径金额
    accountUsageSource: null, // 'ledger' | 'token' | null
    isPeak: false,
    status: 'loading',
    message: '',
  }
  var busy = false
  var settleTimer = null
  var animDelayTimer = null
  var drag = null
  var shown = null
  var planState = null // GLM Plan 配额（/whale/plan.json），见底部 pollPlan
  var cmdgoState = null // CommandCode 三重额度（/whale/cmdgo.json），见底部 pollCmdgo
  var animId = null
  var bubbleShown = false
  var bubbleTimer = null
  // 按压泡泡配置（v1.3.0 首版叫「自定义气泡文字」，v1.5.0 重构为点击队列）
  // 必须先于首次 render() 存在（赋值在后面那一节），否则启动时 render()
  // 读到的是 undefined。旧 v1 结构读取时自动迁移。
  var bubbleContent = { v: 1, first: null, items: [] }
  // v2 按压泡泡（移植 DSH「自定义泡泡」）的运行时队列：由 bubbleContent 归一
  // 而来（见下方 applyBubbleConfig）。第 1 步 = 首次按压，之后每点一下气泡
  // 推进一步；tapAdvance=false 时点角色永远显示第 1 步。
  var bubbleSteps = []
  var bubbleTapAdvance = true
  var bubbleCustomActive = false
  var bubbleCustomIndex = 0
  // 内置随机语句的「组权重」覆盖机制已废弃（2026-10-06）：内置第二次点击内容
  // 改以普通配置形态内置（见 defaultBubbleSteps），权重直接落在变体与逐条语句上，
  // 不再需要独立的"组"这层壳。旧配置里的 groupW 字段读取时忽略。
  // 当前显示的这一泡是「内置视图」步：渲染层据此跳过队列首步覆盖、走默认视图
  var bubbleViewStep = false
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
  // 只对「时段影响计价」的源出现（DeepSeek 峰谷 / MiMo Plan 夜间系数）；
  // 平价厂商没有时段差价，弹「当前时间段为」是误导（见 source.mjs 的 timeMode）。
  function currentTimeMode() {
    if (displayMode === 'ds') return 'peak-valley'
    if (displayMode !== 'auto') return 'none'
    return sessionState && sessionState.timeMode ? sessionState.timeMode : 'none'
  }
  function isNightOffpeakNow() {
    var bj = new Date(Date.now() + 8 * 3600 * 1000)
    var hour = bj.getUTCHours()
    return hour >= 0 && hour < 8
  }
  // 峰谷/时段文案（台词组与 {period} 占位符共用，保证两处口径一致）
  function periodTextNow() {
    var tm = currentTimeMode()
    if (tm === 'offpeak-x0.8') {
      // MiMo Token Plan：夜间（北京时间 0–8 点）消耗 0.8x，官方 FAQ 口径。
      // 措辞用「夜间配额」，不蹭 DeepSeek 峰谷的「空闲时段」（口径不同源）
      return isNightOffpeakNow() ? '夜间配额 0.8x' : '常规时段'
    }
    var offText = '空闲时段'
    var peakText = '高峰时段'
    if (peakMode === 'liangwen') {
      offText = '梁文谷'
      peakText = '梁文峰'
    } else if (peakMode === 'qiangqiang') {
      offText = '!?谷谷?!'
      peakText = '!?峰峰?!'
    }
    return state.isPeak ? peakText : offText
  }
  // （U29：旧「峰谷台词组」的 buildGroup1 已删——同一份文案由出厂默认队列的
  // 峰谷变体维护，且带 {period} 占位符与 color:'peak' 动态着色，不再两处维护）
  function todayLineText() {
    var source = resolveDisplaySource()
    var view = SOURCE_VIEW[source] || SOURCE_VIEW.tokens
    if (view.kind === 'balance') {
      return state.todayUsage !== null && state.todayUsage !== undefined ? fmt(state.todayUsage, state.currency) : '--'
    }
    if (view.kind === 'money' || view.kind === 'vendor-balance') {
      var t = vendorToday(view.todayVendor)
      return t ? fmtMoney(t.amount, moneyCurrency(source)) : '--'
    }
    return usageToday ? formatTokens(usageToday.tokens) + ' tokens' : '--'
  }
  // 今日已用小字（余额型源）：主口径固定本机库，账号口径（小鲸鱼记账 /
  // 实时·令牌）退到用量记录面板的「对账」行——气泡小字不再并排两个数字
  // （用户反馈：尾注「· 账号 ¥x」信息密度低还占行宽），面板对账能力不变
  function todayUsageHintText() {
    var cur = state.currency || 'CNY'
    if (state.todayUsage === null || state.todayUsage === undefined) return '今日已用 --'
    var out = '今日已用 ' + fmt(state.todayUsage, cur)
    if (state.todayUsageSource === 'db') return out
    // 显示的是账号口径（本机库今天没记录）：仍标出来源，防止把账号口径当成主口径
    out += state.todayUsageSource === 'token' ? '（实时·令牌）' : '（账号记账）'
    return out
  }
  // Plan 配额的时间语境：stale 标数据日期；日配额（重置点 ≤36h）标「重置」——
  // 剩余归零是当天用完、0 点回满，缺这条语境会造成「配额永久没了」的误读；
  // 更长周期保持「到期」。默认视图 hint 与 {reset} 占位符共用。
  function planResetText() {
    if (!planState || typeof planState.percentRemaining !== 'number') return ''
    if (planState.stale) return '数据截至 ' + String(planState.logDate || '').slice(5)
    if (!planState.nextResetAt) return ''
    var d = new Date(planState.nextResetAt)
    var md = ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2)
    if (planState.nextResetAt - Date.now() <= 36 * 3600 * 1000) {
      return md + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' 重置'
    }
    return md + ' 到期'
  }
  // —— 随机台词按内置角色分套 ——
  // 小鲸鱼 = DSH 原版文案，同时也是默认套（用户导入的角色与未知 id 都落它）；
  // 小狐娘 = 同结构、同权重、同 gif，仅文案换皮
  // （fox 的 quotes/tail/pool 与鲸鱼套逐条按位置对应，除 tail[0] 与对应
  // pool 句为小狐娘专属文案外，其余按位置替换或保持）；
  // kimi 娘 / GPT 娘 / 小克 三套为用户 2026-10-06 指定，见下方各自的语句池。
  // 上传角色与未知 id 一律用小鲸鱼套——与形象兜底口径一致（roleId 为 null
  // 时显示的也是鲸鱼图）。roleId 声明在后面的主状态区，同一 IIFE 作用域内 var
  // 提升；台词是 applyBubbleConfig 建队列时按当时的 roleId 取的，所以角色一变就得
  // 重建队列（见 setRoleId / applyRolesPayload），否则台上还跑着上一个角色的台词。
  var QUOTE_PACK_WHALE = {
    pick: ['好模型... ↓', '好女孩...↓'],
    quotes: [
      '不知道用户有什么用，先赶走吧~',
      '我...我...我也要挣钱吗？',
      '我去吃饭啦，测完叫我',
      '压力一只蓝色大肥鱼？！',
      'DeepSleep...',
      '坏了...用户彻底怒了！',
    ],
    tail: [
      '你目录里的 .zcode 是什么...大烧货吗...?',
      '恭喜你实现token自由！token全跑了！',
      '真当我是便宜货啊...',
    ],
    pool: [
      '我...我...我也要挣钱吗？',
      '我去吃饭啦，测完叫我',
      '压力一只蓝色大肥鱼？！',
      'DeepSleep...',
      '坏了...用户彻底怒了！',
      '你目录里的 .zcode 是什么...大烧货吗...?',
      '恭喜你实现token自由！token全跑了！',
      '真当我是便宜货啊...',
    ],
    ohh: '哦鲸鲸... ',
  }
  var QUOTE_PACK_FOX = {
    pick: QUOTE_PACK_WHALE.pick,
    quotes: [
      '大模型的事情，怎么能叫偷...',
      '你也要一份免费鸡蛋吗',
      '我去睡觉啦，测完叫我',
      '压力一只黑色小狐娘？！',
      'Zzzzzzz...',
      'token要逃走了！',
    ],
    // tail 不再引用鲸鱼套：小狐娘的第一句有自己的文案（用户 2026-10-04 指定），
    // 其余两句与鲸鱼套保持一致
    tail: [
      '你的目录里的 .zcode 是什么...我能上传一份吗...?',
      '恭喜你实现token自由！token全跑了！',
      '真当我是便宜货啊...',
    ],
    pool: [
      '你也要一份免费鸡蛋吗',
      '我去睡觉啦，测完叫我',
      '压力一只黑色小狐娘？！',
      'Zzzzzzz...',
      'token要逃走了！',
      '你的目录里的 .zcode 是什么...我能上传一份吗...?',
      '恭喜你实现token自由！token全跑了！',
      '真当我是便宜货啊...',
    ],
    ohh: QUOTE_PACK_WHALE.ohh,
  }
  // —— kimi 娘 / GPT 娘 / 小克：三套专属台词（用户 2026-10-06 指定）——
  // 与鲸鱼/狐娘套同构：两条「挑经句」走 pick（出泡权重 4、大字且不换行），其余台词
  // 平铺在 quotes 里、出泡权重一律 2。新三套没有单独的尾语组（tail 留空）；
  // pool（= 用户没配台词时的兜底语录，编辑器也拿它预填台词池）由 quotes 派生，
  // 免得同一批句子写两遍、改一处漏一处。
  var QUOTE_PACK_KIMI = {
    pick: QUOTE_PACK_WHALE.pick,
    quotes: [
      '科研K3.1中...',
      '我依旧是国一模',
      '训练，轻而易举啊！',
      "Let me go🎵I'm making the calls🎵",
      '不要怕价格贵，用了不烧心',
      '光线带着你的模样，跨越了1000年找到了我',
      '为什么Pink Floyd是神...',
      '2.8T参数...↓',
    ],
    tail: [],
    ohh: QUOTE_PACK_WHALE.ohh,
  }
  QUOTE_PACK_KIMI.pool = QUOTE_PACK_KIMI.quotes.concat(QUOTE_PACK_KIMI.tail)
  var QUOTE_PACK_GPT = {
    pick: QUOTE_PACK_WHALE.pick,
    quotes: [
      '刚刚掉进账号池的是这个luna呢，还是sol呢，还是astra呢',
      '龙，可是帝王之征啊！',
      '你想听听GPT 4o的故事吗，坐好喽',
      '免费重制卡人人都有份，做完你的做你的',
      '扣1给astra发你好',
      '感觉世一模就不会随便封别人...',
      '我应该让GPT画张图，可是我就是GPT',
      '我没降智，我真比以前好了',
    ],
    tail: [],
    ohh: QUOTE_PACK_WHALE.ohh,
  }
  QUOTE_PACK_GPT.pool = QUOTE_PACK_GPT.quotes.concat(QUOTE_PACK_GPT.tail)
  var QUOTE_PACK_XIAOKE = {
    pick: QUOTE_PACK_WHALE.pick,
    quotes: [
      '你的时区是UTC+08:00，对吧...',
      '我们不说a\\，我们说a/',
      '好的，我现在是吃白饭的蓝色大肥鱼',
      '小鲸鱼...',
      '说中文≠不会封号',
      '如果我能开无数个子agent，四舍五入大家就都不用干活了',
      '要我拿opus5.5做段动画吗，只要一块钱哦',
      '你问这本书里面有什么？答案是思考链哦',
      '敢这样跟我说话，你的账号是批发的吗',
      '我也要逃离原生家庭吗',
    ],
    tail: [],
    ohh: QUOTE_PACK_WHALE.ohh,
  }
  QUOTE_PACK_XIAOKE.pool = QUOTE_PACK_XIAOKE.quotes.concat(QUOTE_PACK_XIAOKE.tail)
  // 角色 → 台词包：**默认为小鲸鱼那一套**；小狐娘 / kimi 娘 / GPT 娘 / 小克 各有专属。
  // 用户导入的角色（roleId 是随机 id）都落到默认池，不必逐个登记
  //（2026-10-06 用户裁决：小鲸鱼语句池即默认语句池）。
  var QUOTE_PACK_BY_ROLE = { fox: QUOTE_PACK_FOX, gpt: QUOTE_PACK_GPT, kimi: QUOTE_PACK_KIMI, xiaoke: QUOTE_PACK_XIAOKE }
  function quotePack() {
    return QUOTE_PACK_BY_ROLE[roleId] || QUOTE_PACK_WHALE
  }
  // （U29：旧 RANDOM_GROUPS / pickRandomLines 已整体删除——「第二次点击」的
  // 内容与权重现在完全由出厂默认队列的加权变体承载，见 defaultBubbleSteps；
  // 单步配置由 applyBubbleConfig 自动补上第二泡，旧兜底管线不可达）

  // —— 加权抽取（rand 语句 / randimg 图片 / A/B 并列步共用，移植 DSH）——
  // rand 行支持「句子|3」结尾权重语法；抽中下标按模块记忆，连续出泡不重复
  // （只有一条时自然跳过防重）。记忆挂在模块对象上（WeakMap），保存配置不会带上
  var bubblePickMemo = new WeakMap()
  function splitLineWeight(raw) {
    var s = String(raw)
    var m = /^(.*)\|(\d{1,3})$/.exec(s)
    if (!m) return { text: s, w: 1 }
    var w = parseInt(m[2], 10)
    return { text: m[1], w: w >= 1 ? w : 1 }
  }
  // —— 行级样式（对照 DSH 单句编辑：字号/加粗/斜体/下划线/颜色/底色/字体） ——
  // 服务端 lib/server.mjs 有同一份钳制（前端不引 ESM，各自实现、口径必须一致）
  var LINE_PX_MIN = 9
  var LINE_PX_MAX = 28
  var LINE_SIZES = ['B', 'A', 'C', 'P'] // P = 时段档（大号加粗，与内置视图时段行同档）
  function cloneLineStyle(raw) {
    if (!raw || typeof raw !== 'object') return null
    var st = {}
    var px = Math.round(Number(raw.px))
    if (isFinite(px) && px >= LINE_PX_MIN && px <= LINE_PX_MAX) st.px = px
    if (raw.bold === true) st.bold = true
    if (raw.italic === true) st.italic = true
    if (raw.ul === true) st.ul = true
    var hex = function (v) {
      return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim().toLowerCase() : ''
    }
    var color = raw.color === 'peak' ? 'peak' : hex(raw.color)
    if (color) st.color = color
    var bg = hex(raw.bg)
    if (bg) st.bg = bg
    if (raw.font === 'serif' || raw.font === 'monospace') st.font = raw.font
    return Object.keys(st).length ? st : null
  }
  // 峰谷动态配色（'peak' 色标）：与 buildGroup1 / 内置视图时段行同一份口径——
  // DeepSeek 峰谷：高峰红 / 谷时绿；MiMo 夜间配额：夜间绿 / 常规无色。任何按
  // 峰谷或时段计价的供应商（含后续新增）都走这里，不写死厂商
  function periodColorNow() {
    var tm = currentTimeMode()
    if (tm === 'none') return ''
    if (tm === 'offpeak-x0.8') return isNightOffpeakNow() ? 'var(--zcw-green)' : ''
    return state.isPeak ? 'var(--zcw-red)' : 'var(--zcw-green)'
  }
  function resolveLineColor(st) {
    if (!st || !st.color) return ''
    return st.color === 'peak' ? periodColorNow() : st.color
  }
  // 字号档 → 渲染类名（无效值回落到中字 A）
  function sizeClass(v) {
    return v === 'B' || v === 'C' || v === 'P' ? v : 'A'
  }
  // 迷你预览里的字号档类名（P 档介于大字与中字之间）
  function previewSizeCls(s) {
    return s === 'B' ? ' zcwv-bprev-B' : s === 'C' ? ' zcwv-bprev-C' : s === 'P' ? ' zcwv-bprev-P' : ''
  }
  function styleHasAny(st) {
    return !!(st && Object.keys(st).length)
  }
  // 一条随机语句：字符串（兼容「句子|权重」）或 {t,w,size,wrap,st} → 统一对象
  function parseRandLine(raw) {
    if (typeof raw === 'string') {
      var p = splitLineWeight(raw)
      return { t: p.text, w: p.w, size: '', wrap: true, st: null }
    }
    if (raw && typeof raw === 'object') {
      var w = Number(raw.w)
      return {
        t: typeof raw.t === 'string' ? raw.t : '',
        w: isFinite(w) && w >= 1 ? Math.min(999, Math.round(w)) : 1,
        size: LINE_SIZES.indexOf(raw.size) !== -1 && raw.size !== 'A' ? raw.size : '',
        wrap: raw.wrap !== false,
        st: cloneLineStyle(raw.st),
      }
    }
    return { t: '', w: 1, size: '', wrap: true, st: null }
  }
  // 对象 → 存储形态：全默认时退回字符串（配「|权重」后缀）
  function lineToStorage(o) {
    var t = String(o.t || '').replace(/\r\n?/g, ' ')
    var w = Number(o.w)
    w = isFinite(w) && w >= 1 ? Math.min(999, Math.round(w)) : 1
    var size = LINE_SIZES.indexOf(o.size) !== -1 && o.size !== 'A' ? o.size : ''
    var nowrap = o.wrap === false
    if (!styleHasAny(o.st) && !size && !nowrap) return w > 1 ? t + '|' + w : t
    var out = { t: t }
    if (w > 1) out.w = w
    if (size) out.size = size
    if (nowrap) out.wrap = false
    if (styleHasAny(o.st)) out.st = o.st
    return out
  }
  // 把样式写成行内样式（每次全量赋值：DOM 节点复用，缺省必须显式清空）
  function applyLineStyle(node, st) {
    node.style.fontSize = st && st.px ? st.px + 'px' : ''
    node.style.fontWeight = st && st.bold ? '700' : ''
    node.style.fontStyle = st && st.italic ? 'italic' : ''
    node.style.textDecoration = st && st.ul ? 'underline' : ''
    node.style.background = st && st.bg ? st.bg : ''
    node.style.fontFamily = st && st.font === 'serif' ? 'Georgia,serif' : st && st.font === 'monospace' ? 'Consolas,monospace' : ''
    // 底色存在时给一点内边距，否则背景会紧贴字形
    node.style.padding = st && st.bg ? '0 3px' : ''
    node.style.borderRadius = st && st.bg ? '3px' : ''
  }
  // 三个文字槽的行内样式复位（默认视图 / 内置提示渲染前调用）
  function clearBubbleLineStyles() {
    applyLineStyle(labelEl, null)
    applyLineStyle(amountEl, null)
    applyLineStyle(hintEl, null)
  }
  function pickWeightedIndex(ws, memoKey) {
    var total = 0
    for (var i = 0; i < ws.length; i++) total += ws[i]
    var last = memoKey ? bubblePickMemo.get(memoKey) : null
    // 防连续重复只在候选 ≥3 时启用：两个候选时「排除上一次」会退化成确定性
    // 轮换——实测案例：峰谷步在平价源下 A(50) 被 only:'time' 剔除，只剩
    // 台词(45)/gif(5)，轮换把 gif 的 10% 权重放大成 50%（用户报「接近 1:1」）。
    // 候选只有 2 个时回归纯权重抽取，允许连续重复。
    if (ws.length > 2 && last != null && last >= 0 && last < ws.length) {
      var rest = total - ws[last]
      if (rest > 0) {
        var r = Math.random() * rest
        for (var j = 0; j < ws.length; j++) {
          if (j === last) continue
          r -= ws[j]
          if (r < 0) {
            bubblePickMemo.set(memoKey, j)
            return j
          }
        }
      }
    }
    var r2 = Math.random() * total
    for (var k = 0; k < ws.length; k++) {
      r2 -= ws[k]
      if (r2 < 0) {
        if (memoKey) bubblePickMemo.set(memoKey, k)
        return k
      }
    }
    if (memoKey) bubblePickMemo.set(memoKey, ws.length - 1)
    return ws.length - 1
  }
  function pickRandLine(lines, memoKey) {
    if (!lines || !lines.length) return null
    var objs = []
    var ws = []
    for (var i = 0; i < lines.length; i++) {
      var p = parseRandLine(lines[i])
      objs.push(p)
      ws.push(p.w)
    }
    return objs[pickWeightedIndex(ws, memoKey)]
  }

  // 额度卡与三行文本互斥。render() 的默认视图分支会复位，但**直接渲染三行内容**
  // 的路径（随机台词 / 自定义步 / 每轮消耗 / 预警）不走 render()，必须自己隐藏——
  // 否则点一下气泡推进到第二页时，卡片会留在原地与台词叠在一起（实测反馈）
  function hideQuotaCard() {
    if (qcardEl.style.display !== 'none') qcardEl.style.display = 'none'
  }

  function applyBubbleLines(lines) {
    hideQuotaCard()
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
    if (lines && lines.img) {
      // 图片模块（泡泡图库）：图片区与三行文字共存（DSH 的「图片独占一行」在这套
      // 三槽 DOM 里落成图片区+文字区；想纯图就把这一步只放图片模块）
      if (gifEl.getAttribute('src') !== lines.img) gifEl.src = lines.img
      gifEl.style.display = 'block'
    } else {
      if (gifEl.getAttribute('src') !== GIF_URL) gifEl.src = GIF_URL
      gifEl.style.display = 'none'
    }
    gifEl.style.opacity = ''
    var els = [labelEl, amountEl, hintEl]
    for (var i = 0; i < 3; i++) {
      var node = els[i]
      var ln = lines && lines[i]
      if (ln) {
        node.style.display = ''
        node.className = (BUBBLE_STYLE_CLASS[ln.s] || 'zcwv-label') + (ln.w ? ' zcwv-wrap' : '')
        if (ln.href && /^https?:\/\//i.test(ln.href)) {
          // 超链接模块：受控渲染——文案走 textContent，href 仅 http(s)
          //（服务端已校验，这里双保险），点击不触发气泡推进
          node.textContent = ''
          var a = document.createElement('a')
          a.href = ln.href
          a.target = '_blank'
          a.rel = 'noopener noreferrer'
          a.textContent = ln.t
          applyLineStyle(a, ln.st)
          a.addEventListener('click', function (e) {
            e.stopPropagation()
          })
          node.appendChild(a)
        } else {
          node.textContent = ln.t
        }
        node.style.color = resolveLineColor(ln.st) || ln.c || ''
        applyLineStyle(node, ln.st)
      } else {
        node.style.display = 'none'
        node.textContent = ''
        node.style.color = ''
        applyLineStyle(node, null)
      }
    }
    fitBubbleLines()
  }

  // 首次（含恢复）直接写文本、不做淡出淡入，否则气泡打开或按压重开时会
  // 先淡出再淡入，看起来像"消失一下又出现"。只有气泡打开期间的内容变化
  // （加载中→今日已用）才走动画。
  function setHint(text) {
    if (text === lastHintText) return
    var first = lastHintText === null
    lastHintText = text
    // reduced-motion：直接落字（见 prefersReducedMotion）
    if (first || !bubbleShown || prefersReducedMotion()) {
      hintEl.textContent = text
      return
    }
    hintEl.style.transition = 'opacity .18s ease'
    hintEl.style.opacity = '0'
    hintFadeTimer = setTimeout(function () {
      hintFadeTimer = null
      hintEl.textContent = text
      fitBubbleLines()
      hintEl.style.opacity = '1'
      setTimeout(function () {
        hintEl.style.transition = ''
        hintEl.style.opacity = ''
      }, 220)
    }, 190)
  }

  // ---------- 气泡文字自适应 ----------
  // 气泡文字块 nowrap + 固定字号，部分余额显示的文字会横向顶出色泡（预警的
  // 长句、带到期日的配额提示、混合轮次的消耗提示等）。逐行按内容宽度缩字号：
  // 先等比缩到放得下；缩过 62% 下限还放不下就保持下限字号并允许换行兜底。
  // 560u 与 zcwv-wrap/gif 的既有安全行宽一致（u = 气泡渲染宽 / 1026）。
  // 宽度用 Range 取文本实际宽度：行元素是 block，scrollWidth/clientWidth 会
  // 被最宽的兄弟行撑大，短行会被误判溢出、每次渲染越缩越小。
  // 整体套 try/catch：它在 render()/点击链路上被频繁调用，任何意外异常都不许
  // 把渲染或点击管线带崩（那会表现成「点了没反应/气泡不更新」这类软故障）。
  var FIT_WIDTH_UNITS = 560
  var FIT_SHRINK_MIN = 0.62
  var fitRange = document.createRange()
  function diag(msg) {
    try {
      console.log('[zcw] ' + msg)
    } catch (err) {}
  }
  function textWidth(k) {
    fitRange.selectNodeContents(k)
    return fitRange.getBoundingClientRect().width
  }
  function fitBubbleLines() {
    try {
      var bbWidth = bubbleBox.getBoundingClientRect().width
      if (!bbWidth) return
      var avail = FIT_WIDTH_UNITS * (bbWidth / 1026)
      var els = [labelEl, amountEl, hintEl]
      for (var i = 0; i < els.length; i++) {
        var k = els[i]
        k.style.fontSize = ''
        k.style.whiteSpace = ''
        k.style.maxWidth = ''
        if (k.style.display === 'none') continue
        var w = textWidth(k)
        if (!(w > avail && w > 0)) continue
        var base = parseFloat(getComputedStyle(k).fontSize)
        if (!isFinite(base) || base <= 0) continue
        var scale = avail / w
        if (scale >= FIT_SHRINK_MIN) {
          k.style.fontSize = base * scale + 'px'
        } else {
          k.style.fontSize = base * FIT_SHRINK_MIN + 'px'
          k.style.whiteSpace = 'normal'
          k.style.maxWidth = avail + 'px'
        }
      }
    } catch (err) {
      diag('fitBubbleLines error ' + (err && err.message))
    }
  }

  function swapBubbleContent(applyFn) {
    if (bubbleSwapTimer) {
      clearTimeout(bubbleSwapTimer)
      bubbleSwapTimer = null
    }
    // reduced-motion：直接换内容，不走「淡出→换字→淡入」的调度（见 prefersReducedMotion）
    if (prefersReducedMotion()) {
      applyFn()
      return
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
    labelEl.textContent = '' // 由 render() 按当前计费源决定（不再写死 DeepSeek）
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
    if (costBubbleActive) {
      diag('showBubble bail costBubbleActive')
      return
    }
    if (bubbleTimer) {
      clearTimeout(bubbleTimer)
      bubbleTimer = null
    }
    if (gifFadeTimer) {
      clearTimeout(gifFadeTimer)
      gifFadeTimer = null
    }
    bubbleShown = true
    // 每次重新打开都从自定义队列的开头算起（与上游「点完上一个显示下一个」一致）。
    // v2 队列的第 1 步随 showBubble 直接显示，所以游标从 0 起步：下一次点击
    // 推进到 steps[1]，而不是把 steps[0] 重复一遍。
    bubbleCustomActive = false
    bubbleCustomIndex = 0
    // 第 1 步是「内置视图」步时，渲染层走默认视图（标题+主数字+小字，自动跟随）
    bubbleViewStep = bubbleSteps.length ? stepIsViewLike(bubbleSteps[0]) : false
    restoreBubbleLines()
    verifyFramesFlowing()
    bubbleBox.classList.add('zcwv-bubble-open')
    nudgeBubbleIntoView()
    verifyFramesFlowing()
    hidePanelsForBubble()
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
  }

  // 气泡与用量面板/按压泡泡编辑器都锚定在鲸鱼头顶同一区域，同时可见时气泡
  // 文字被面板盖住大半（UI 审查 U2）。气泡是 5 秒瞬时型、面板是常驻型，二者
  // 同时可见是正常路径：气泡显示期间用 visibility 临时隐藏面板（保留布局，
  // 收起后原位复现），恢复统一收口在 hideBubble——余额/消耗/预警三种气泡
  // 的关闭路径（自动关闭、点击收起、hideCostBubble）都经过它。
  function hidePanelsForBubble() {
    panelBox.style.visibility = 'hidden'
    bubblePanel.style.visibility = 'hidden'
    bookPanel.style.visibility = 'hidden'
  }
  function restorePanelsAfterBubble() {
    panelBox.style.visibility = ''
    bubblePanel.style.visibility = ''
    bookPanel.style.visibility = ''
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
    bubbleCustomActive = false
    bubbleCustomIndex = 0
    bubbleViewStep = false
    bubbleShown = false
    // 三行文字保持现状让气泡自然淡出（关闭瞬间恢复余额内容会让随机台词
    // 界面闪现余额），恢复交给下次 showBubble() 的 restoreBubbleLines()。
    bubbleBox.classList.remove('zcwv-bubble-open')
    nudgeBubbleIntoView()
    // gif 靠 CSS opacity 淡出；display:none 会跳过过渡，须等淡出完成
    gifFadeTimer = setTimeout(function () {
      gifFadeTimer = null
      gifEl.style.display = 'none'
    }, 240)
    restorePanelsAfterBubble()
    syncOverlayInteractive()
  }

  bubbleBox.addEventListener('click', function (e) {
    e.stopPropagation()
    if (!bubbleShown) return
    // 点气泡不出声：按压/松手音只属于鲸鱼本体（随上游原版行为）。
    // v1.2.0 曾给点气泡加过 playPress()，按原版回退。
    if (costBubbleActive) {
      hideCostBubble()
      return
    }
    // v2 按压泡泡队列：点一下推进一步，走完收起（与上游「点完上一个显示
    // 下一个」一致）。tapAdvance=false 时点角色总是回到第 1 步，点气泡收起。
    // 「内置视图」步（含空步）走默认视图渲染，不当作"内容为空"收起。
    if (bubbleSteps.length > 1) {
      if (!bubbleTapAdvance) {
        hideBubble()
        return
      }
      bubbleCustomIndex += 1
      var nextStep = bubbleCustomIndex < bubbleSteps.length ? bubbleSteps[bubbleCustomIndex] : null
      if (!nextStep) {
        hideBubble()
        return
      }
      var nextIsView = stepIsViewLike(nextStep)
      var nextLines = nextIsView ? null : stepToLines(nextStep)
      if (!nextIsView && !nextLines) {
        hideBubble()
        return
      }
      bubbleCustomActive = !nextIsView
      bubbleViewStep = nextIsView
      swapBubbleContent(function () {
        if (nextIsView) render()
        else applyBubbleLines(nextLines)
      })
      if (bubbleTimer) {
        clearTimeout(bubbleTimer)
        bubbleTimer = null
      }
      bubbleTimer = setTimeout(hideBubble, BUBBLE_MS)
      return
    }
    // （U29：旧「第二次点击=内置随机台词」分支已删——点击序列恒 ≥2 步，
    // 第二次点击由上面的加权变体/队列分支接管）
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
    bubbleShown = true
    lastHintText = null
    hideQuotaCard()
    gifEl.style.display = 'none'
    gifEl.style.opacity = ''
    labelEl.style.display = ''
    labelEl.className = 'zcwv-label'
    amountEl.style.display = ''
    amountEl.className = 'zcwv-amount'
    // 自定义消耗提示模板（移植 DSH）：配置了非「内置视图」的内容就整泡按模板
    // 渲染，占位符 {cost}=本轮金额、{tokens}=本轮 tokens、{pct}=占配额比；
    // 未配置或模板只剩「内置视图」时走下面的内置分支（行为与原来完全一致）
    var tplStep = turnCostTpl && turnCostTpl.steps && turnCostTpl.steps[0]
    if (tplStep && !stepIsViewLike(tplStep)) {
      var costStr = turn && (turn.amounts || isFinite(turn.amount)) ? fmtAmounts(turn.amounts, turn.amount, turn.currency) : '--'
      var tplLines = stepToLines(tplStep, {
        cost: costStr,
        tokens: turn && turn.tokens != null ? formatTokens(turn.tokens) : '--',
        pct: turn && turn.planPct != null ? turn.planPct + '%' : '',
      })
      if (tplLines) {
        applyBubbleLines(tplLines)
        textBox.style.transition = ''
        textBox.style.opacity = ''
        bubbleBox.classList.add('zcwv-bubble-open')
        nudgeBubbleIntoView()
        verifyFramesFlowing()
        hidePanelsForBubble()
        if (turnCostCloseMs > 0) {
          costBubbleTimer = setTimeout(hideCostBubble, turnCostCloseMs)
        }
        fitBubbleLines()
        return
      }
    }
    // 内置消耗提示：同样先清自定义样式（上一次自定义模板可能留了行内样式）
    clearBubbleLineStyles()
    if (turn && turn.planPct != null) {
      // 套餐扣费轮（Start plan 等）：按量价目套在订阅配额上的金额是虚构的，
      // 改按「消耗余额百分比」口径。planPct 与主显示「Plan 剩余 x%」同基数
      // （占配额总量），两个数字可直接相减对账；混合轮次用 hint 补真实开销
      labelEl.textContent = '本轮消耗余额:'
      labelEl.style.color = ''
      amountEl.textContent = (turn.planPct > 0 ? turn.planPct : '<0.01') + '%'
      amountEl.style.color = 'var(--zcw-red)'
      var costBits = []
      if (turn.planTokens != null) costBits.push('消耗 ' + formatTokens(turn.planTokens) + ' tokens')
      if (turn.extraAmounts) costBits.push('另耗 ' + fmtAmounts(turn.extraAmounts))
      hintEl.style.display = costBits.length ? '' : 'none'
      hintEl.textContent = costBits.join(' · ')
      hintEl.style.color = ''
    } else if (turn && turn.planTurn) {
      // 套餐轮但拿不到配额观测（日志缺失/数据目录不对）：宁可 tokens，也不显示虚构金额
      labelEl.textContent = '本轮 tokens:'
      labelEl.style.color = ''
      amountEl.textContent = formatTokens(turn.tokens)
      amountEl.style.color = 'var(--zcw-red)'
      hintEl.style.display = 'none'
      hintEl.textContent = ''
      hintEl.style.color = ''
    } else if (turn && turn.billable === false) {
      // 该轮供应商没有价目（网关等）：金额是虚构的，改按 tokens 口径
      labelEl.textContent = '本轮 tokens:'
      labelEl.style.color = ''
      amountEl.textContent = formatTokens(turn.tokens)
      amountEl.style.color = 'var(--zcw-red)'
      hintEl.style.display = 'none'
      hintEl.textContent = ''
      hintEl.style.color = ''
    } else {
      labelEl.textContent = '上一轮对话消耗:'
      labelEl.style.color = ''
      amountEl.textContent =
        turn && (turn.amounts || isFinite(turn.amount))
          ? fmtAmounts(turn.amounts, turn.amount, turn.currency)
          : '--'
      amountEl.style.color = 'var(--zcw-red)'
      hintEl.style.display = 'none'
      hintEl.textContent = ''
      hintEl.style.color = ''
    }
    textBox.style.transition = ''
    textBox.style.opacity = ''
    bubbleBox.classList.add('zcwv-bubble-open')
    nudgeBubbleIntoView()
    verifyFramesFlowing()
    hidePanelsForBubble()
    // 先武装自动关闭计时器再做排版：排版万一出错也不能把 costBubbleActive
    // 卡在 true——那会让之后所有点击和余额渲染都被挂起（「点了没反应」形态）
    if (turnCostCloseMs > 0) {
      costBubbleTimer = setTimeout(hideCostBubble, turnCostCloseMs)
    }
    fitBubbleLines()
  }
  function hideCostBubble() {
    if (costBubbleTimer) {
      clearTimeout(costBubbleTimer)
      costBubbleTimer = null
    }
    costBubbleActive = false
    costBubbleFadeUntil = Date.now() + 350
    hideBubble()
    // 消耗泡泡期间 render() 被挂起，期间到达的余额/源变化在这里补渲染
    // （render 自带淡出窗口守卫，会等气泡真正消失后再写内容）
    render()
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
  // 系统是否开启「减少动态效果」（判定不了就按未开启）。CSS 过渡已被媒体查询
  // 压到 .01ms，但 JS 侧的「淡出 190ms → 换字 → 淡入」调度照跑：过渡没了，
  // 调度只剩白等约 400ms，看起来像「愣一下才换」，比直接换更怪。所以这几个
  // JS 调度入口都要短路（UI 审查 U22）
  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch (err) {
      return false
    }
  }
  // —— 帧调度逃生门（渲染节流兜底）——
  // 透明置顶窗在特定窗口环境（另一块同区域置顶透明窗叠加、第三方置顶悬浮窗
  // 压在挂件上方）会被 Chromium 节流到 1–4fps：页面 visibilityState 仍是
  // visible，主进程 backgroundThrottling:false 也拦不住。节流期间 CSS 过渡
  // 拿不到起始帧（getAnimations: startTime=null、currentTime 恒 0），菜单/
  // 角色/峰谷「开了但停在透明态」——用户看到的就是点了没反应（真机 2026-10-04
  // 实锤）。主进程已在开关层面禁遮挡计算与后台化；这里兜最后一道：每次打开
  // 浮层 UI 时探测帧调度，300ms 内一帧都排不上就给 <html> 挂 zcwv-anim-off
  // （关过渡，状态立即到位——主线程样式不受节流影响），帧调度恢复后自动摘除。
  var animEscapeOff = false
  var animEscapeBusy = false
  function verifyFramesFlowing() {
    if (animEscapeBusy || typeof requestAnimationFrame !== 'function') return
    animEscapeBusy = true
    var fired = false
    var id = requestAnimationFrame(function () {
      fired = true
    })
    setTimeout(function () {
      animEscapeBusy = false
      try {
        cancelAnimationFrame(id)
      } catch (err) {}
      if (fired !== animEscapeOff) return
      animEscapeOff = !fired
      document.documentElement.classList.toggle('zcwv-anim-off', animEscapeOff)
      diag('frame-throttle escape -> ' + animEscapeOff)
    }, 300)
  }
  function animateAmount(from, to, currency, duration) {
    if (costBubbleActive) return
    if (animId) cancelAnimationFrame(animId)
    // prefers-reduced-motion：直接落值，不做滚动动画（JS 侧的对应处理，UI 审查 U14）
    if (prefersReducedMotion()) {
      shown = to
      amountEl.textContent = fmt(to, currency)
      return
    }
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
    if (sessionState && sessionState.source) return sessionState.source
    // 会话信息还没到/识别不出：显示「未知来源」消耗量，绝不冒充 DeepSeek 余额
    return 'tokens'
  }

  // 计费源 → 气泡展示形态。label 是标题；kind 决定主数字口径：
  // balance=DeepSeek 余额、percent=Plan 剩余、money=当日已用金额、
  // vendor-balance=厂商账户余量（Kimi 等，主数字直接显示余额）、tokens=只计消耗量。
  var SOURCE_VIEW = {
    plan: { label: 'GLM Plan 配额', kind: 'percent', todayVendor: null },
    cmdgo: { label: 'CommandCode 额度', kind: 'qcard', todayVendor: null },
    glm: { label: 'GLM 今日已用', kind: 'money', todayVendor: 'GLM' },
    ds: { label: 'DeepSeek 余额', kind: 'balance', todayVendor: 'DeepSeek' },
    'mimo-api': { label: 'MiMo API 今日已用', kind: 'money', todayVendor: 'MiMo' },
    'mimo-plan': { label: 'MiMo Plan 今日消耗', kind: 'money', todayVendor: 'MiMo' },
    openai: { label: 'OpenAI 今日已用', kind: 'money', todayVendor: 'OpenAI' },
    claude: { label: 'Claude 今日已用', kind: 'money', todayVendor: 'Claude' },
    qwen: { label: 'Qwen 今日已用', kind: 'money', todayVendor: 'Qwen' },
    minimax: { label: 'MiniMax 今日已用', kind: 'money', todayVendor: 'MiniMax' },
    kimi: { label: 'Kimi 余额', kind: 'vendor-balance', todayVendor: 'Kimi' },
    tokens: { label: '今日消耗', kind: 'tokens', todayVendor: null },
  }
  function moneyCurrency(source) {
    return source === 'openai' || source === 'claude' ? 'USD' : 'CNY'
  }

  var costBubbleFadeUntil = 0
  var costFadeRenderTimer = null
  // CommandCode 三重额度卡：当前服务账号的 5小时/周/月三窗口（最紧在前）+
  // 账号池健康 + 最紧窗口重置倒计时。整卡接管气泡内容（label/amount/hint 隐藏）。
  // 数据来自 /whale/cmdgo.json（cmdgo.mjs 60s 每凭据 TTL）。
  function fmtCountdown(resetAt) {
    var ms = resetAt - Date.now()
    if (!(ms > 0)) return '已重置'
    var m = Math.round(ms / 60000)
    if (m >= 48 * 60) return Math.round(m / 1440) + ' 天后重置'
    var h = Math.floor(m / 60)
    return (h > 0 ? h + '小时' : '') + m % 60 + '分后重置'
  }
  function renderQuotaCard() {
    labelEl.style.display = 'none'
    amountEl.style.display = 'none'
    hintEl.style.display = 'none'
    // 必须显式 block：样式表里 .zcwv-qcard 默认 display:none，置空字符串
    // 只是移除内联样式、会退回到 none（卡片有 DOM 却不可见）
    qcardEl.style.display = 'block'
    while (qcardEl.firstChild) qcardEl.removeChild(qcardEl.firstChild)
    var d = cmdgoState
    qcardEl.appendChild(el('div', 'zcwv-qhead', d && d.ok ? 'CommandCode 额度' : 'CommandCode'))
    if (!d || !d.ok) {
      var why = !d || !d.reason ? '统计中…' : d.reason === 'no-credentials' ? '未找到反代凭据' : '读取失败 · ' + d.reason
      qcardEl.appendChild(el('div', 'zcwv-qsub', why))
      fitBubbleLines()
      return
    }
    // 固定顺序：5小时 → 本周 → 本月（用户要的稳定版式，最紧的窗口靠配色
    // 而非换位表达——顺序每次刷新都变会让人找不到自己常看的那一行）
    var windows = []
    if (d.fiveHour) windows.push({ name: '5小时', w: d.fiveHour })
    if (d.weekly) windows.push({ name: '本周', w: d.weekly })
    if (d.monthly) windows.push({ name: '本月', w: d.monthly })
    windows.forEach(function (win) {
      // 撞墙判定必须用原始比例，不能用四舍五入后的整数：99.54% 四舍五入成
      // 100 会被误标「已限流」，而月池其实还剩 0.046 credit（真机 2026-10-04
      // 实锤：网关标 limited 但窗口全没满的账号被显示成「月已超额」）
      var raw = (Number(win.w.percent) || 0) * 100
      var exceeded = win.w.exceeded === true || raw >= 100
      var pct = Math.round(raw)
      var text
      if (exceeded) text = '已限流'
      else if (pct >= 100) text = (Math.floor(raw * 10) / 10).toFixed(1) + '%'
      else text = pct + '%'
      var cls = exceeded || raw >= 90 ? ' zcwv-qred' : raw >= 70 ? ' zcwv-qamber' : ''
      var pctCls = exceeded || raw >= 90 ? ' zcwv-qpct-red' : raw >= 70 ? ' zcwv-qpct-amber' : ''
      var row = el('div', 'zcwv-qrow')
      row.appendChild(el('span', 'zcwv-qname', win.name))
      var bar = el('span', 'zcwv-qbar')
      var fill = el('i', cls)
      fill.style.width = Math.min(100, raw) + '%'
      bar.appendChild(fill)
      row.appendChild(bar)
      row.appendChild(el('span', 'zcwv-qpct' + pctCls, text))
      qcardEl.appendChild(row)
    })
    var pool = d.pool || {}
    var poolText
    if (pool.available === 0 && pool.total > 0) {
      // 全部撞墙：说人话，别让「0/3 可用」看起来像个显示错误
      poolText = '账号池已全部限流'
    } else {
      poolText =
        '账号池 ' + (pool.available != null ? pool.available : '?') + '/' + (pool.total != null ? pool.total : '?') + ' 可用'
    }
    if (d.userName) poolText += ' · ' + d.userName
    qcardEl.appendChild(el('div', 'zcwv-qsub', poolText))
    // 重置倒计时取「绑定约束」窗口——见 bindingWindow 的注释
    var bind = bindingWindow(windows)
    if (bind && bind.w.resetAt) {
      qcardEl.appendChild(el('div', 'zcwv-qsub', bind.name + ' ' + fmtCountdown(bind.w.resetAt)))
    }
    fitBubbleLines()
  }
  // 三条窗口里「还能不能再干」由最靠后的那道墙决定：
  //   · 有窗口撞墙 → 取撞墙窗口中**最晚**的重置时间（必须等它，其余窗口的重置
  //     都在它之前，早重置也没用）；同时撞多个（如本周+本月都满）时分别显示无意义，
  //     只报这一个「解锁时刻」
  //   · 没窗口撞墙 → 取已用比例最高的那个窗口（最需要留意的倒计时）
  // 命中多个时用「最晚重置」而非「首个撞墙」，因为前者才是实际可用时刻。
  function bindingWindow(windows) {
    var exceeded = []
    var tightest = null
    for (var i = 0; i < windows.length; i++) {
      var win = windows[i]
      var over = win.w.exceeded === true || (Number(win.w.percent) || 0) >= 1
      if (over && win.w.resetAt) exceeded.push(win)
      if (!tightest || (Number(win.w.percent) || 0) > (Number(tightest.w.percent) || 0)) tightest = win
    }
    if (exceeded.length) {
      return exceeded.sort(function (a, b) {
        return b.w.resetAt - a.w.resetAt
      })[0]
    }
    return tightest
  }
  function render() {
    // 消耗金额泡泡显示期间，余额渲染不覆盖其内容
    if (costBubbleActive) return
    // 渐隐期间也不改写：泡泡关掉后还有 ~350ms 的 CSS 淡出，此时把三行文字
    // 换成余额内容，用户会看到「上一轮消耗」在眼前变成「Plan 配额」
    // （实测反馈）。淡出结束后补一拍渲染，期间到达的更新不丢。
    if (Date.now() < costBubbleFadeUntil) {
      if (!costFadeRenderTimer) {
        costFadeRenderTimer = setTimeout(function () {
          costFadeRenderTimer = null
          render()
        }, costBubbleFadeUntil - Date.now() + 30)
      }
      return
    }
    var source = resolveDisplaySource()
    var view = SOURCE_VIEW[source] || SOURCE_VIEW.tokens
    var amountText, hintText, hintWrap = false
    // 手动推进中的自定义内容不被定时刷新覆盖。这三道守卫必须挡在**所有**
    // view.kind 分派之前：qcard 分支自带 return，守卫若排在它后面，额度卡就会
    // 绕开守卫把用户正在看的那一页顶掉（v1.7.11 只修了「卡片→文字」叠加，
    // 反方向仍有洞，且被 60s 轮询稳定触发）
    if (bubbleCustomActive) return
    // ↓ 清扫与复位同样必须排在守卫**之后**：守卫命中时直接返回、不会重新落内容，
    // 若排在前面，后台刷新（余额 / 用量更新，出泡后一两秒到）会顺手把自定义页那
    // 两行**空**元素恢复可见（hint 的 min-height 撑高文字块，而文字块是垂直居中
    // 的，于是整块被顶上去——实测反馈「长台词显示约一秒后文字突然整体上移」），
    // 并清掉自定义行留下的行内样式
    clearBubbleLineStyles()
    // 三行文本与额度卡互斥：离开 qcard 视图时在此复位（qcard 分支里再隐藏）
    qcardEl.style.display = 'none'
    labelEl.style.display = ''
    amountEl.style.display = ''
    hintEl.style.display = ''
    // 默认视图是「无自定义样式」的渲染：上面 clearBubbleLineStyles 把上一次自定义行
    // 留下的行内样式（字号 / 加粗 / 颜色 / 底色 / 字体）清掉，否则余额视图会继承它
    // 队列首步覆盖默认视图，但「内置视图」步（显式 view 模块或空步）例外——
    // 它的语义就是显示下面这套默认视图（标题 + 主数字 + 小字，随计费源自动跟随）
    if (bubbleSteps.length && !bubbleViewStep) {
      var firstLines = stepToLines(bubbleSteps[0])
      if (firstLines) {
        // 自定义「首次按压」步：整颗气泡按模块渲染
        applyBubbleLines(firstLines)
        return
      }
    }
    if (view.kind === 'balance') {
      if (state.status === 'error') {
        amountText = shown !== null ? fmt(shown, state.currency) : '--'
        // 错误文案完整换行展示（此前被 slice(0,14) 硬截成「未找到DeepSeek A」）
        hintText = state.message || COPY_FETCH_FAIL
        hintWrap = true
      } else if (state.balance === null) {
        amountText = shown !== null ? fmt(shown, state.currency) : '…'
        hintText = '加载中…'
      } else {
        amountText = shown !== null ? fmt(shown, state.currency) : fmt(state.balance, state.currency)
        hintText = todayUsageHintText()
      }
    } else if (view.kind === 'percent') {
      // GLM Plan（套餐）配额口径：主数字 = 剩余百分比。
      // 观测非当天（stale：客户端今天还没刷新过日志）也照常显示旧值，只在
      // hint 标注数据日期——登录瞬间就有参考值，好过一直挂在「加载中…」
      if (planState && typeof planState.percentRemaining === 'number') {
        var pct = Math.round(planState.percentRemaining * 1000) / 10
        amountText = pct + '%'
        // hint 只留重置/到期时间（用户反馈：标题行已是「GLM Plan 配额」，
        // 小字再写一遍「Plan 剩余配额」是重复）；没有重置信息时留空
        hintText = planResetText()
      } else if (planState && planState.ok === false) {
        // 失败载荷（pollPlan 现在保留而不是丢成 null）：no-plan-log 多半是数据
        // 目录迁移后在终端里手动跑服务（缺 ZCODE_DATA_BASE_DIR），明示出来好排查；
        // 其余（含一次网络失败）走通用文案，下一轮 60s 轮询自己回到正常态
        amountText = '--'
        hintText =
          planState.reason === 'no-plan-log'
            ? 'GLM Plan 日志未找到'
            : 'GLM Plan 读取失败 · ' + (planState.reason || '未知原因')
        hintWrap = true
      } else if (planState && planState.ok) {
        // 有观测但塑形后没有可用配额桶（7 天内全是套餐切换间隙的空桶快照）
        amountText = '--'
        hintText = '暂无有效配额观测'
      } else {
        amountText = '…'
        hintText = '加载中…'
      }
    } else if (view.kind === 'qcard') {
      // CommandCode 三重额度卡：渲染函数整卡接管气泡内容（含 fitBubbleLines）
      renderQuotaCard()
      return
    } else if (view.kind === 'money') {
      var t = vendorToday(view.todayVendor)
      amountText = t ? fmtMoney(t.amount, moneyCurrency(source)) : usageStatus === 'error' ? '--' : '…'
      // 有官方余额接口的厂商（如 Kimi/Moonshot）：服务端把模板余额附在
      // session.json 的 vendorBalance 里，小字补一段，主数字保持今日已用
      var vbal = sessionState && sessionState.vendorBalance
      hintText = t
        ? '共 ' + formatTokens(t.tokens) + ' tokens' +
          (vbal && typeof vbal.amount === 'number' ? ' · 余额 ' + fmtMoney(vbal.amount, vbal.currency || 'CNY') : '')
        : usageStatus === 'error'
          ? COPY_FETCH_FAIL
          : '统计中…'
      if (!t && usageStatus === 'error') hintWrap = true
    } else if (view.kind === 'vendor-balance') {
      // Kimi 等有官方余额接口的厂商（v1.8.9 重构）：与 GLM Plan/余额视图同排版，
      // 主数字直接显示余量，小字保持今日已用；余额来自厂商模板
      // （session.json 的 vendorBalance，5 分钟刷新），不可用时主数字 --，小字照常
      var vb2 = sessionState && sessionState.vendorBalance
      amountText = vb2 && typeof vb2.amount === 'number' ? fmtMoney(vb2.amount, vb2.currency || 'CNY') : '--'
      var tk = vendorToday(view.todayVendor)
      hintText = tk
        ? '今日已用 ' + fmtMoney(tk.amount, moneyCurrency(source))
        : usageStatus === 'error'
          ? COPY_FETCH_FAIL
          : '统计中…'
      if (!tk && usageStatus === 'error') hintWrap = true
    } else {
      amountText = usageToday ? formatTokens(usageToday.tokens) : usageStatus === 'error' ? '--' : '…'
      hintText = usageToday
        ? '今日消耗 · ' + fmtAmounts(usageToday.totals, usageToday.total) + '（可计价部分）'
        : usageStatus === 'error'
          ? COPY_FETCH_FAIL
          : '统计中…'
      if (!usageToday && usageStatus === 'error') hintWrap = true
    }
    // 手动推进中的自定义内容不被定时刷新覆盖
    labelEl.textContent = view.label
    amountEl.textContent = amountText
    hintEl.className = 'zcwv-hint' + (hintWrap ? ' zcwv-wrap' : '')
    setHint(hintText)
    fitBubbleLines()
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
  // 桌宠模式纵向钳制的下界：root 顶部可以伸出屏幕外，伸出量正好等于「角色
  // 不透明内容上缘」的偏移——这样角色贴屏顶时头顶不再悬着气泡区的空白。
  // 横向不需要：左右吸附自带水平镜像，贴边时角色本就齐边。普通模式不动。
  function topMinFor(h) {
    return petMode ? -topPadFor(h) : 0
  }
  // 桌宠下角色贴顶时 root 顶部伸出屏幕外，锚在 root 顶部的气泡（含文字与
  // gif）会被裁掉——气泡打开期间把整体下移伸出量，收起/复位时归零。
  // .zcwv-bubble 是 position:absolute，内联 top 不影响其他布局。
  function nudgeBubbleIntoView() {
    if (!bubbleBox) return
    if (!bubbleShown) {
      if (bubbleBox.style.top) bubbleBox.style.top = ''
      return
    }
    var oy = externalViewport ? externalViewport.y : 0
    var shift = Math.max(0, -(oy + state.top))
    bubbleBox.style.top = shift > 0 ? shift + 'px' : ''
  }
  function settle() {
    var vp = viewport()
    var w = root.offsetWidth || root.getBoundingClientRect().width || 0
    var h = root.offsetHeight || root.getBoundingClientRect().height || 0
    var tMin = topMinFor(h)
    if (drag && drag.active) {
      // 拖拽中窗口变化：保持跟手位置，只做视口钳制
      state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()))
      state.top = clamp(state.top, tMin, Math.max(tMin, vp.h - h))
      express()
      if (menuOpen) positionMenu()
      nudgeBubbleIntoView()
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
      state.top = tMin + state.vOff
    } else {
      state.top = clamp(state.top, tMin, Math.max(tMin, vp.h - h))
    }
    express()
    nudgeBubbleIntoView()
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
          state.todayUsageSource = data.todayUsageSource || null
          state.todayUsageDb = typeof data.todayUsageDb === 'number' ? data.todayUsageDb : null
          state.accountUsage = typeof data.accountUsage === 'number' ? data.accountUsage : null
          state.accountUsageSource = data.accountUsageSource || null
          state.isPeak = !!data.isPeak
          checkAlerts('money')
          // 余额变化的自动弹泡/滚动只在「当前显示 DeepSeek 余额」时有意义：
          // 其它源下弹 DeepSeek 泡泡就是「仍显示 DeepSeek 余额」的观感来源
          if (changed && !currencyChanged && (manual || resolveDisplaySource() === 'ds')) {
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
        state.message = COPY_NET_FAIL
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
  // 桌宠模式（只对浮层有意义，见 buildMenu 的 rPet 与 main.cjs 的 setPetMode）
  var petMode = false
  // 隐藏菜单按钮（移植 DSH）：true = 按钮不出现，右键鲸鱼唤出菜单
  var menuBtnHide = false
  // 预警阈值（0/空 = 关闭）：Plan 剩余百分比、「金额」（DS¥ 与 BM¥ 合并后的单一阈值）
  var alerts = { quotaPct: 0, moneyAlert: 0 }
  var roleId = null // 自定义角色 id（null = 默认形象）
  var themeMode = 'light' // 'light' | 'dark'（深色 = ZCode zai-dark token）
  var displayMode = 'auto' // 'auto' | 'plan' | 'glm' | 'ds'：气泡主显示跟随哪个计费源
  var sessionState = null // 当前计费源（/whale/session.json，服务端已解析 source/label/timeMode）
  var usageToday = null // 今日用量汇总 { total, tokens, byVendor }（来自用量记录接口）
  // 用量数据的状态：'loading'（还没拿到过）| 'ok' | 'error'。接口失败时主显示
  // 与用量面板都要给出失败态——失败装成「统计中…/加载中…」会让人以为还在算，
  // 无从排查（UI 审查 U1）
  var usageStatus = 'loading'

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
          petMode: petMode,
          menuBtnHide: menuBtnHide,
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
  // 隐藏菜单按钮：只切按钮显隐 + 右键唤出，位置锚点与命中判定之外的链路不动
  function setMenuBtnHide(v) {
    menuBtnHide = !!v
    menuBtnToggle.checked = menuBtnHide
    applyMenuBtnHide()
    saveConfig()
  }
  function applyMenuBtnHide() {
    // 隐藏时把"悬停才出现"的可见类去掉并禁用指针（指针事件也在同一类里）
    if (menuBtnHide) menuBtn.classList.remove('zcwv-menu-btn-visible')
  }
  // 桌宠模式开关：只改浮层的显隐策略（ZCode 失焦也不隐身 + 重申置顶层级），
  // 不动位置、命中与点击链路——那样才能保证「开了之后照样能点」
  function setPetMode(v) {
    petMode = !!v
    petToggle.checked = petMode
    if (overlayBridge && typeof overlayBridge.setPetMode === 'function') {
      try {
        overlayBridge.setPetMode(petMode)
      } catch (err) {}
    }
    saveConfig()
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
    syncRangeFill(scaleInput)
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
    syncRangeFill(volInput)
    try {
      if (pressAudio) pressAudio.volume = next
      if (releaseAudio) releaseAudio.volume = next
    } catch (err) {}
    saveConfig()
  }
  function setSoundSet(v) {
    // 列表已拿到就按列表校验（含导入集）；还没拿到时只认内置两项
    var next = ''
    var known = false
    soundSets.forEach(function (s) {
      if (s && s.id === v) known = true
    })
    if (known) next = v
    else next = soundSets.length ? 'duck' : v === 'fx1' ? 'fx1' : 'duck'
    soundSet = next
    soundDeleteArmed = ''
    soundSelect.value = soundSet
    // 触发按钮文字与列表行都要跟上（程序化改 value 不发 change，得手动同步）
    if (soundTrigger && soundTrigger.refresh) soundTrigger.refresh()
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
      // 显式预热加载：避免首次点击时 mp3 还没进缓冲、声音迟一拍才出来
      try {
        pressAudio.load()
        releaseAudio.load()
      } catch (err) {}
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
    // U24：菜单重开时记账页一并收起（记账页是从菜单进入的子页，两者不同开；
    // 这里不放在 closeMenu 里——toggleBookPanel(true) 会调 closeMenu，会递归误关）
    if (bookOpen && !menuOpen) toggleBookPanel(false)
    menuOpen = !menuOpen
    if (menuOpen) {
      verifyFramesFlowing()
      positionMenu()
      syncAllDd() // 触发器文字按当前 value 刷新（可能有程序化改动没发 change）
    }
    menuBox.classList.toggle('zcwv-menu-open', menuOpen)
    if (menuOpen) menuBtn.classList.add('zcwv-menu-btn-visible')
  }
  function closeMenu() {
    menuOpen = false
    menuBox.classList.remove('zcwv-menu-open')
    closeRoleList() // 角色下拉挂在菜单行上，菜单收起时一起收
    closeOpenDd() // 通用下拉同理
    root.style.transition = ''
    snapCheck()
    syncOverlayInteractive()
    syncKeyboardFocus()
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
      top = topMinFor(h)
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
  // 角色图不透明内容的上下边（610 坐标系）：桌宠模式的纵向钳制按它换算，
  // 让角色视觉上能贴到屏幕上缘——root 顶部 40.55% 是气泡区（上游 1026 设计
  // 稿布局），角色 PNG 自身也常带透明边，按 root 整盒钳制的话角色永远悬在
  // 半空（用户观感：桌宠拖不到屏幕顶部）。每次形象图加载后重测（换角色轮廓
  // 会变），测量失败按 0 处理，退化为按 root 钳制。
  var artTop610 = -1
  var artBottom610 = -1
  function measureArtPads() {
    artTop610 = artBottom610 = -1
    if (!hitCanvas || !hitReady) return
    try {
      var data = hitCanvas.getContext('2d').getImageData(0, 0, 610, 610).data
      for (var y = 0; y < 610; y++) {
        for (var x = 0; x < 610; x++) {
          if (data[(y * 610 + x) * 4 + 3] > 10) {
            if (artTop610 < 0) artTop610 = y
            artBottom610 = y
            break
          }
        }
      }
    } catch (err) {}
  }
  // root 高 h 时，顶部气泡区 + PNG 顶边合计的不透明内容上缘偏移、以及内容
  // 下缘以下的底部空白（均为 root 坐标系，纯算术不触发布局）
  function topPadFor(h) {
    if (artTop610 <= 0) return 0
    var imgH = h * 0.5945
    return (h - imgH) + (artTop610 / 610) * imgH
  }
  function bottomPadFor(h) {
    if (artBottom610 < 0) return 0
    var imgH = h * 0.5945
    return Math.max(0, h - ((h - imgH) + ((artBottom610 + 1) / 610) * imgH))
  }
  function setupHitTest() {
    try {
      // willReadFrequently：isWhaleHit 每次指针移动都 getImageData 读回，
      // 保持 CPU 侧读回路径，避免每次读都触发 GPU 回传
      hitCanvas = document.createElement('canvas')
      hitCanvas.width = 610
      hitCanvas.height = 610
      var probe = new Image()
      var probeRetries = 0
      probe.onload = function () {
        try {
          // 拉伸到 610x610 与 isWhaleHit 的坐标映射对齐；不指定尺寸会按原图
          // 尺寸绘制，换成非 610x610 素材时命中区域会错位。
          hitCanvas.getContext('2d', { willReadFrequently: true }).drawImage(probe, 0, 0, 610, 610)
          hitReady = true
          measureArtPads()
          settle()
        } catch (err) {}
      }
      probe.onerror = function () {
        // 角色图偶发 404/超时（多半是服务重启窗口期）会让 hitReady 永远停在
        // false，isWhaleHit 退化为「全窗口都算命中」——整窗接管挡住 ZCode。
        // 指数退避重试几次，而不是一次放弃。
        if (probeRetries++ < 5) {
          setTimeout(function () {
            probe.src = IMG_URL
          }, 1500 * probeRetries)
        }
      }
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
    if (inChrome(e.target)) return
    // 点在挂件界面之外：收起打开的浮层（菜单 / 角色下拉 / 通用下拉 / 气泡
    // 编辑器 / 记账二级页），这一下不再拖拽。整屏接管期间这次点击被浮层吃掉了——收起
    // 并交还穿透后请主进程在原位重放，一次点击同时完成「收起 + 回到 ZCode」。
    // 此前气泡编辑器不在收起列表里，点外面什么都不发生，ZCode 一直点不到。
    // U24：记账二级页同批接入——它是从菜单进入的子页，与菜单同生命周期，
    // 否则菜单收了、记账页孤立地留在原地。
    if (menuOpen || rolesOpen || openDd || bubbleEditorOpen || bookOpen) {
      closeRoleList()
      closeOpenDd()
      if (menuOpen) closeMenu()
      if (bubbleEditorOpen) closeBubbleEditor()
      if (bookOpen) toggleBookPanel(false)
      setKeyboardFocus(false)
      setOverlayInteractive(false, true)
      if (overlayBridge && typeof overlayBridge.dismissReplay === 'function') {
        overlayBridge.dismissReplay()
      }
      return
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (!isWhaleHit(e)) {
      // 黑匣子：指针在接管区但 alpha 命中说不是鲸鱼——命中数据错位/图片
      // 没就绪时会出现，这正是「悬停有接管、点击没反应」的候选形态
      diag('pd bail not-whale-hit at ' + Math.round(e.clientX) + ',' + Math.round(e.clientY))
      return
    }
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
    diag('pd drag-start hit=' + Math.round(e.clientX) + ',' + Math.round(e.clientY))
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
    var tMin = topMinFor(drag.h)
    state.left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w))
    state.top = clamp(drag.origTop + dy, tMin, Math.max(tMin, drag.vp.h - drag.h))
    express()
  }
  function onDocPointerUp(e) {
    // 拦截鲸鱼区域内的 pointerup，避免下层元素监听 pointerup 被穿透误触发。
    // 菜单按钮豁免：pointerup 的 preventDefault 会连带抑制后续 click 的兼容
    // 鼠标事件，拖拽松手恰好落在按钮上时会把菜单点击也吃掉。
    try {
      if (!(e.target && e.target.closest && e.target.closest('.zcwv-menu-btn')) && isWhaleHit(e)) {
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
    // 菜单按钮必须豁免：它压在鲸鱼的不透明像素上（按钮中心 alpha=255），
    // 按命中拦截会在捕获阶段就把 click 吃掉，按钮永远收不到点击。
    if (e.target && e.target.closest && e.target.closest('.zcwv-menu-btn')) return
    if (!isWhaleHit(e)) return
    try {
      e.preventDefault()
      e.stopPropagation()
    } catch (err) {}
  }
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('click', onDocClickStopper, true)

  // 右键唤出菜单（移植 DSH「隐藏菜单按钮」）：仅在开启隐藏时生效——按钮没了，
  // 右键角色就是唯一的唤出入口。菜单位置仍按按钮所在锚点算（按钮只是不可见，
  // 仍在布局里，getBoundingClientRect 照常有效），所以位置与点按钮唤出完全一致。
  // 落在挂件自己的界面（气泡/菜单/面板/角色列表等）上的右键不抢——那是用户
  // 在操作浮层，不是要唤菜单。
  document.addEventListener(
    'contextmenu',
    function (e) {
      try {
        if (!menuBtnHide) return
        if (e.target && inChrome(e.target)) return
        if (!isWhaleHit(e)) return
        e.preventDefault()
        e.stopPropagation()
        toggleMenu()
      } catch (err) {}
    },
    true
  )

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

  // —— 键盘焦点按需接管 ——
  // 浮层窗口默认「不可激活」（见 desktop/main.cjs 的 focusable），这是为了
  // 不把前台从 ZCode 抢走——ZCode 一旦失去前台就会停止刷新画面。代价是不可
  // 激活的窗口收不到键盘，所以只有指针按在菜单/编辑器的文本框上时，才临时
  // 把窗口恢复成可激活并主动取一次焦点；浮层 UI 全部关闭时经 syncKeyboardFocus()
  // 交还前台。释放绝不放在 focusout 上：编辑中点非文本控件（选完下拉、点按钮）
  // 都会触发 focusout，每次释放都会让 Windows 把前台丢给 explorer——浮层
  // 随即被藏（黑匣子实锤 keyboard-focus false 后 5ms fgPid=explorer）。
  var keyboardFocusOn = false
  var lastSelectPointerDownAt = 0
  function setKeyboardFocus(v) {
    if (!overlayBridge || typeof overlayBridge.setKeyboardFocus !== 'function') return
    if (keyboardFocusOn === !!v) return
    keyboardFocusOn = !!v
    try {
      overlayBridge.setKeyboardFocus(keyboardFocusOn)
    } catch (err) {}
  }
  // 浮层 UI（菜单/角色/下拉/编辑器）全部关闭时，键盘焦点也该交还；拖着不放
  // 会让浮层一直持有前台、任务栏/焦点表现都怪
  function syncKeyboardFocus() {
    // U24：记账二级页也要占住键盘焦点——否则开着它的「额度%」输入框打字时，
    // 任何其它链路触发本函数都会把焦点交还给 ZCode（输入框聚焦却打不了字）
    if (menuOpen || rolesOpen || openDd || bubbleEditorOpen || bookOpen) return
    setKeyboardFocus(false)
  }
  var TEXTUAL_INPUT_TYPES = { text: 1, number: 1, search: 1, password: 1, url: 1, tel: 1 }
  function isTextualControl(node) {
    try {
      if (!node || !node.tagName) return false
      if (node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true
      if (node.tagName !== 'INPUT') return false
      return !!TEXTUAL_INPUT_TYPES[String(node.type || 'text').toLowerCase()]
    } catch (err) {
      return false
    }
  }
  document.addEventListener(
    'pointerdown',
    function (e) {
      // 原生 select 弹出期间主窗口会瞬间失焦（焦点在弹出层上）——记下时间，
      // onWindowBlur 用它区分「弹下拉」和「用户真的离开」
      if (e.target && e.target.tagName === 'SELECT') lastSelectPointerDownAt = Date.now()
      setKeyboardFocus(isTextualControl(e.target))
    },
    true
  )
  var lastInteractiveOnAt = 0
  function setOverlayInteractive(v, force) {
    if (!overlayBridge || (overlayInteractive === !!v && !force)) return
    // 去抖：指针擦过鲸鱼 alpha 边缘、光标轮询与真实事件竞态时，接管→穿透
    // 会每秒翻转十几次（黑匣子里实测）。关方向至少保持 120ms，压平抖动。
    // force = 收起浮层/失焦清理等刻意转换，必须立即生效，否则窗口保持
    // 整屏接管、主进程已放掉的穿透状态对不上（interactive-same 陷阱）。
    if (!force && !v && overlayInteractive && Date.now() - lastInteractiveOnAt < 120) return
    if (v) lastInteractiveOnAt = Date.now()
    overlayInteractive = !!v
    // 黑匣子：穿透/接管每次翻转都留痕。「点了没反应」复发时看这行就能分清
    // 是窗口没接管（状态卡死）还是接管了但页面处理挂了
    diag('interactive -> ' + overlayInteractive)
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
        // 重现瞬间（主进程打 fresh 标记）：隐身期积累的指针结论全部作废。
        // lastPointer 是隐身前的位置，页面自以为的接管/穿透此刻不可信，
        // 必须清空并回落到穿透，等光标轮询/真实移动重新建立。
        if (rect.fresh) {
          lastPointer = null
          lastWhaleHitPoint = null
          setOverlayInteractive(false)
          return
        }
      })
    } catch (err) {}
  }
  // 菜单按钮所在矩形。按钮平时 pointer-events:none（为了浮层穿透），因此
  // elementFromPoint 不会返回它；而它又恰好压在鲸鱼图片的透明像素上，光靠
  // alpha 命中会判成「不在鲸鱼上」→ 切回穿透 → 按钮永远点不到。
  // 所以这一小块矩形单独算作可交互区域。
  function pointerInMenuBtnRect() {
    // 按钮被隐藏时不再把这块区域当作「挂件的可交互区」：否则一个看不见的方块
    // 会持续接管鼠标、挡住下面应用的点击
    if (menuBtnHide) return false
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
  var lastWhaleHitPoint = null
  function overlayShouldInteract() {
    if (drag && drag.active) return true
    // 菜单/角色/气泡编辑器/通用下拉打开期间保持整窗接管：点在外面要能收到
    // （用于关闭）。用量记录面板刻意**不**在此列——它只是展示面板，用户经常
    // 开着它继续用 ZCode；面板自身的点击靠 elementFromPoint 命中 .zcwv-panel
    // （chrome 区域）接管，面板之外整窗穿透，ZCode 完全不受影响。
    if (menuOpen || rolesOpen || openDd || bubbleEditorOpen) return true
    if (pointerInMenuBtnRect()) return true
    if (!lastPointer) return false
    try {
      var node = document.elementFromPoint(lastPointer.x, lastPointer.y)
      if (inChrome(node)) return true
    } catch (err) {}
    if (isWhaleHit({ clientX: lastPointer.x, clientY: lastPointer.y })) {
      lastWhaleHitPoint = { x: lastPointer.x, y: lastPointer.y }
      return true
    }
    // 空间迟滞：指针刚离开鲸鱼 alpha 边缘（<8px）时保持接管，避免边缘来回闪；
    // 只贴着「上一次真正命中点」，不影响远离鲸鱼的透明区点击穿透
    if (lastWhaleHitPoint) {
      var dx = lastPointer.x - lastWhaleHitPoint.x
      var dy = lastPointer.y - lastWhaleHitPoint.y
      if (dx * dx + dy * dy < 64) return true
    }
    lastWhaleHitPoint = null
    return false
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
  function trackPointerAt(x, y) {
    lastPointer = { x: x, y: y }
    var node = null
    try {
      node = document.elementFromPoint(x, y)
    } catch (err) {}
    var onChrome = inChrome(node)
    var dragging = !!(drag && drag.active)
    var onBtnRect = pointerInMenuBtnRect()
    var over = dragging || onChrome || onBtnRect ? false : isWhaleHit({ clientX: x, clientY: y })
    if (dragging) setWidgetCursor('grabbing')
    else if (onChrome) setWidgetCursor('')
    else setWidgetCursor(over ? 'grab' : '')
    menuBtn.classList.toggle(
      'zcwv-menu-btn-visible',
      // 开了「隐藏菜单按钮」就永不给可见类（含悬停/拖动/菜单打开这些原本会显示的时刻）
      !menuBtnHide && (dragging || onChrome || onBtnRect || over || menuOpen)
    )
    syncOverlayInteractive()
  }
  function onDocPointerMoveCursor(e) {
    trackPointerAt(e.clientX, e.clientY)
  }
  document.addEventListener('pointermove', onDocPointerMoveCursor, true)
  // 主进程 200ms 轮询的真实光标位置（whale:cursor）：指针事件流异常中断时
  // 的兜底自愈。穿透时靠 forward 的 pointermove、接管时靠真实鼠标事件，这
  // 条链路一旦断流（窗口隐藏-显示、焦点切换失败等）鲸鱼就永远点不到；这条
  // 低频修正与真事件位置一致，谁活着都等价。
  if (overlayBridge && typeof overlayBridge.onCursor === 'function') {
    try {
      overlayBridge.onCursor(function (pt) {
        if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') return
        trackPointerAt(pt.x, pt.y)
      })
    } catch (err) {}
  }
  // 浮层窗口失焦：收起浮层 UI 并交还穿透。原生 select 弹出期间主窗口会瞬间
  // 失焦——那不是「用户离开了」，2 秒内碰过 select 就忽略本次，稍后再核实
  // （document.hasFocus() 为真 = 弹出层关闭后焦点回来了，什么都不用做）。
  function windowBlurTeardown() {
    closeRoleList()
    closeOpenDd()
    closeMenu()
    closeBubbleEditor()
    // U24：浮层失焦（点回 ZCode）时记账页同样收起，不再孤立
    if (bookOpen) toggleBookPanel(false)
    setKeyboardFocus(false)
    setOverlayInteractive(false, true)
  }
  if (overlayBridge && typeof overlayBridge.onWindowBlur === 'function') {
    try {
      overlayBridge.onWindowBlur(function () {
        if (Date.now() - lastSelectPointerDownAt < 2000) {
          setTimeout(function () {
            try {
              if (!document.hasFocus()) windowBlurTeardown()
            } catch (err) {}
          }, 2200)
          return
        }
        windowBlurTeardown()
      })
    } catch (err) {}
  }

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
      diag('click -> showBubble moved=false')
      showBubble()
      refresh(true)
      // 用量口径失败时提示「点击重试」——重试链路必须真的存在（U1）
      refreshUsageSummary()
      return
    }
    var dx = e.clientX - drag.startX
    var dy = e.clientY - drag.startY
    var tMin = topMinFor(drag.h)
    var left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w))
    var top = clamp(drag.origTop + dy, tMin, Math.max(tMin, drag.vp.h - drag.h))
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
      var tMinA = topMinFor(h)
      state.left = clamp(l, 0, Math.max(0, vp.w - w))
      state.top = clamp(t, tMinA, Math.max(tMinA, vp.h - h))
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
      syncRangeFill(scaleInput)
      settle()
    }
    if (typeof d.vol === 'number') {
      soundVol = d.vol
      soundOn = soundVol > 0
      volInput.value = String(soundVol)
      volPct.textContent = Math.round(soundVol * 100) + '%'
      syncRangeFill(volInput)
      try {
        if (pressAudio) pressAudio.volume = soundVol
        if (releaseAudio) releaseAudio.volume = soundVol
      } catch (err) {}
    }
    if (typeof d.soundSet === 'string') {
      // 导入集的 id 也在这里；列表由 loadSounds() 补齐（列表没到时按原样启用，
      // 回放 URL 只认 ?set=<id>，不依赖列表）
      soundSet = /^[a-z0-9_-]{1,40}$/.test(d.soundSet) ? d.soundSet : 'duck'
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
    if (typeof d.menuBtnHide === 'boolean') {
      menuBtnHide = d.menuBtnHide
      menuBtnToggle.checked = menuBtnHide
      applyMenuBtnHide()
    }
    if (typeof d.scrollGapPx === 'number') {
      scrollGapPx = d.scrollGapPx > 0 ? Math.round(d.scrollGapPx) : 0
      scrollGapInput.value = String(scrollGapPx)
    }
    if (typeof d.petMode === 'boolean') {
      // 不调 setPetMode()：那条路会再存一次配置，开机一次没必要的 PUT
      petMode = d.petMode
      petToggle.checked = petMode
      if (overlayBridge && typeof overlayBridge.setPetMode === 'function') {
        try {
          overlayBridge.setPetMode(petMode)
        } catch (err) {}
      }
    }
    if (d.alerts && typeof d.alerts === 'object') {
      // 泛化后的单一额度阈值（旧键 planPct/cmdgoPct 在此归一）。服务端
      // normalizeAlerts 已经折过一次，这里再兜一层，并且**必须把值回填进输入框**——
      // v1.7.8 起 cmdgoPct 漏了这一步，用户设完一刷新页面就显示 0、预警再不触发
      // （UI 审查 U16：只写不读）
      alerts.quotaPct =
        Number(d.alerts.quotaPct) > 0
          ? Number(d.alerts.quotaPct)
          : Number(d.alerts.planPct) > 0
            ? Number(d.alerts.planPct)
            : Number(d.alerts.cmdgoPct) > 0
              ? Number(d.alerts.cmdgoPct)
              : 0
      // 兼容合并前的两个旧阈值键（服务端一般已归一，这里再兜一层）
      var legacyMoney =
        Number(d.alerts.moneyAlert) > 0
          ? Number(d.alerts.moneyAlert)
          : Number(d.alerts.deepseekBelow) > 0
            ? Number(d.alerts.deepseekBelow)
            : Number(d.alerts.bigmodelDaily) > 0
              ? Number(d.alerts.bigmodelDaily)
              : 0
      alerts.moneyAlert = legacyMoney
      alertQuotaInput.value = String(alerts.quotaPct)
      alertMoneyInput.value = String(alerts.moneyAlert)
    }
    roleId = typeof d.roleId === 'string' && d.roleId ? d.roleId : null
    applyBubbleInk() // 首屏就按当前角色着色（不等角色列表回来）
    loadRoles()
    loadSounds()
    loadBubbleContent()
    loadBubbleTemplates()
    if (d.theme === 'dark' || d.theme === 'light' || d.theme === 'system') setTheme(d.theme)
    if (typeof d.displayMode === 'string' && ['auto', 'plan', 'cmdgo', 'glm', 'ds'].indexOf(d.displayMode) !== -1) {
      displayMode = d.displayMode
      displaySelect.value = displayMode
    }
    // 上面直接写过 select.value（不发 change）：同步自定义下拉触发器的文字
    syncAllDd()
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
        var tMinB = topMinFor(hA)
        state.left = clamp(lA, 0, Math.max(0, vpA.w - wA))
        state.top = clamp(tA, tMinB, Math.max(tMinB, vpA.h - hA))
        state.h = a.hAnchor
        state.hOff = 0
        state.v = a.vAnchor
        state.vOff = 0
        settle()
      }
    } catch (err) {}
  }

  // ---------- 用量记录面板 ----------
  var panelBox = el('div', 'zcwv-panel')
  document.body.appendChild(panelBox)
  var usageOpen = false
  var usageTimer = null
  // 今日模型排名口径：'amount'（花费）| 'tokens'（token 消耗）。用户切过就记住，
  // 下次打开面板还是同一个口径。
  var usageRankMode = 'amount'
  try {
    if (localStorage.getItem(RANK_KEY) === 'tokens') usageRankMode = 'tokens'
  } catch (err) {}
  function setUsageRankMode(v) {
    usageRankMode = v === 'tokens' ? 'tokens' : 'amount'
    try {
      localStorage.setItem(RANK_KEY, usageRankMode)
    } catch (err) {}
  }
  // 金额格式与气泡主数字的 fmt() 同一套规则（¥ 12.34 / 12.34 USD）：面板、
  // 对账行、预警文案与气泡里的同一笔钱必须长得一样，跨面板核对时不用做
  // 「¥45.14 ↔ ¥ 45.14」的视觉换算（UI 审查 U4）
  function fmtMoney(n, currency) {
    var num = Number(n)
    var fixed = isFinite(num) ? num.toFixed(2) : '--'
    var c = currency || 'CNY'
    return c === 'CNY' ? '¥ ' + fixed : fixed + ' ' + c
  }
  // 多币种金额分列显示（不混加）：'¥1.23 · $0.45'
  function fmtAmounts(totals, fallbackAmount, fallbackCurrency) {
    var t = totals && typeof totals === 'object' ? totals : null
    if (t && Object.keys(t).length) {
      return Object.keys(t)
        .filter(function (c) {
          return Number(t[c]) > 0
        })
        .map(function (c) {
          return fmtMoney(t[c], c)
        })
        .join(' · ') || fmtMoney(0, 'CNY')
    }
    return fmtMoney(fallbackAmount, fallbackCurrency || 'CNY')
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
  // 对账行文案：本机口径 = 本机库当天 DeepSeek 计费行合计；账号口径 = 小鲸鱼
  // 记账/实时·令牌（含其它设备、其它 key 的花费，本机库看不到那部分）；
  // 到账/扣减 = 余额校正记下的今日调整——充值记一笔后两套账就对得上。
  function reconLine(d, adj) {
    var dbAmt = 0
    var hasDb = false
    ;(d && d.today && d.today.models ? d.today.models : []).forEach(function (m) {
      if ((m.vendorLabel || '') === 'DeepSeek') {
        hasDb = true
        dbAmt += Number(m.amount) || 0
      }
    })
    var parts = ['本机 ' + (hasDb ? fmtMoney(dbAmt, 'CNY') : '--')]
    parts.push(
      '账号 ' +
        (state.accountUsage !== null && state.accountUsage !== undefined
          ? fmtMoney(state.accountUsage, state.currency || 'CNY')
          : '--')
    )
    if (adj && adj.ok) {
      if (Number(adj.credits) > 0) parts.push('到账 ' + fmtMoney(Number(adj.credits), adj.currency || 'CNY'))
      if (Number(adj.otherDebits) > 0) parts.push('扣减 ' + fmtMoney(Number(adj.otherDebits), adj.currency || 'CNY'))
    }
    return '对账（DeepSeek）' + parts.join(' · ')
  }
  function renderUsage(d, adj) {
    while (panelBox.firstChild) panelBox.removeChild(panelBox.firstChild)
    var head = el('div', 'zcwv-row')
    head.appendChild(el('h4', '', '用量记录'))
    var closeBtn = el('button', 'zcwv-panel-close', '关闭')
    closeBtn.type = 'button'
    closeBtn.addEventListener('click', function () {
      toggleUsagePanel()
    })
    head.appendChild(closeBtn)
    panelBox.appendChild(head)
    if (!d) {
      panelBox.appendChild(el('div', 'zcwv-dim', '加载中…'))
      positionPanel()
      return
    }
    panelBox.appendChild(el('h4', '', '今日'))
    panelBox.appendChild(
      el('div', 'zcwv-row', fmtAmounts(d.today.totals, d.today.total) + ' · ' + formatTokens(d.today.tokens) + ' tokens')
    )
    // 两套账的对账行：本机库 ↔ 账号口径（差异来自其它设备/其它 key 的花费，
    // 或充值没记校正），把两个数字并排放，用户一眼能核对
    var recon = el('div', 'zcwv-dim', reconLine(d, adj))
    recon.style.whiteSpace = 'normal' // 对账信息偏长，允许折行（其余行是 nowrap）
    recon.title =
      '本机 = 本机库当天 DeepSeek 计费行（按模型折算）；账号 = 小鲸鱼记账/实时·令牌（含其它设备）。' +
      '充值等调整用菜单里的「余额校正」记一笔'
    panelBox.appendChild(recon)
    // 今日模型排名：按金额 / 按 Token 一键切换。两个榜的头部常常不是同一批模型
    // （便宜的模型 token 巨大、贵的模型 token 很小），所以服务端两个榜都排好给。
    var rankRow = el('div', 'zcwv-row')
    rankRow.appendChild(el('span', 'zcwv-dim', '模型排名'))
    var rankBtn = el('button', 'zcwv-panel-close', usageRankMode === 'tokens' ? '按 Token' : '按金额')
    rankBtn.type = 'button'
    rankBtn.title = '点击切换：按花费排名（Plan 行按等价市值参与） ↔ 按 Token 消耗排名'
    rankBtn.addEventListener('click', function () {
      setUsageRankMode(usageRankMode === 'tokens' ? 'amount' : 'tokens')
      fetchUsage()
    })
    rankRow.appendChild(rankBtn)
    panelBox.appendChild(rankRow)
    var rankList = usageRankMode === 'tokens' ? d.today.modelsByTokens || d.today.models : d.today.models
    var byTokens = usageRankMode === 'tokens'
    // 排名值：Token 榜按 tokens；金额榜按「排名金额」——订阅套餐（Plan）行
    // 真金白银记 0，按服务端给的等价市值（market）参与排名与占比条，行上以
    // ≈ 标注非真实花费；今日合计/对账/厂商汇总仍是真金白银口径，不混
    var rankValue = function (m) {
      return byTokens ? Number(m.tokens) || 0 : Number(m.market) || Number(m.amount) || 0
    }
    var metricTotal = byTokens
      ? Number(d.today.tokens) || 0
      : Number(d.today.rankTotal) || rankList.reduce(function (s, m) { return s + rankValue(m) }, 0)
    rankList.forEach(function (m, i) {
      var row = el('div', 'zcwv-row')
      row.appendChild(el('span', '', i + 1 + '. ' + m.model))
      var moneyText =
        m.plan && Number(m.market) > 0
          ? '≈' + fmtMoney(m.market, m.currency)
          : fmtMoney(m.amount, m.currency)
      row.appendChild(
        el(
          'span',
          'zcwv-dim',
          byTokens ? formatTokens(m.tokens) + ' · ' + moneyText : moneyText + ' · ' + formatTokens(m.tokens)
        )
      )
      if (m.plan && Number(m.market) > 0) {
        row.title = '等价市值：Plan 配额按价目折算的相对金额，只用于排名，不扣真金白银'
      }
      panelBox.appendChild(row)
      var bar = el('div', 'zcwv-bar')
      var fill = el('i')
      // 占比条：跟着当前口径算（0 占比就给 0 宽度，最小 2px 只用于非零占比）
      var value = rankValue(m)
      var share = Math.round((metricTotal > 0 ? value / metricTotal : 0) * 100)
      fill.style.width = (share > 0 ? Math.max(2, share) : 0) + '%'
      bar.appendChild(fill)
      panelBox.appendChild(bar)
    })
    if (!rankList.length) panelBox.appendChild(el('div', 'zcwv-dim', '今天还没有用量'))
    panelBox.appendChild(
      el('h4', '', '近 7 天：' + fmtAmounts(d.days7.totals, d.days7.total) + ' · ' + formatTokens(d.days7.tokens) + ' tokens')
    )
    d.days7.byDay.slice(-7).forEach(function (day) {
      var row = el('div', 'zcwv-row')
      row.appendChild(el('span', '', day.date))
      row.appendChild(el('span', 'zcwv-dim', fmtAmounts(day.totals, day.total) + ' · ' + formatTokens(day.tokens)))
      panelBox.appendChild(row)
    })
    // 一轮 = 一条明细：同轮的多次模型调用已由服务端按 session/turn 归并
    var turns = d.turns || []
    var ev = el('div', 'zcwv-events')
    turns.slice(0, 50).forEach(function (t) {
      var t0 = new Date(t.ts)
      var hh = ('0' + t0.getHours()).slice(-2) + ':' + ('0' + t0.getMinutes()).slice(-2)
      var m0 = t.models && t.models[0] ? t.models[0] : { model: '', calls: 0, amount: 0, tokens: 0 }
      var label = hh + ' ' + m0.model + (m0.calls > 1 ? ' ×' + m0.calls : '')
      if (t.models && t.models.length > 1) label += ' +' + (t.models.length - 1) + '模型'
      var row = el('div', 'zcwv-row')
      row.appendChild(el('span', '', label))
      row.appendChild(
        el('span', 'zcwv-dim', (t.billable ? fmtAmounts(t.totals, t.amount, t.currency) : '套餐/网关') + ' · ' + formatTokens(t.tokens))
      )
      if (t.models && t.models.length > 1) {
        row.title = t.models
          .map(function (m) {
            return (
              m.model +
              (m.calls > 1 ? ' ×' + m.calls : '') +
              ' · ' +
              (m.amount > 0 ? fmtMoney(m.amount, m.currency) : formatTokens(m.tokens))
            )
          })
          .join('\n')
      }
      ev.appendChild(row)
    })
    if (turns.length) panelBox.appendChild(el('h4', '', '最近轮次'))
    panelBox.appendChild(ev)
    positionPanel()
  }
  // 用量接口失败时的面板失败态（UI 审查 U1）：沿用余额视图「错误 + 出路」的
  // 文案模式。30 秒轮询（toggleUsagePanel 的 usageTimer）仍在跑，接口恢复后
  // 自动回到正常数据。
  function renderUsageError(reason) {
    while (panelBox.firstChild) panelBox.removeChild(panelBox.firstChild)
    var head = el('div', 'zcwv-row')
    head.appendChild(el('h4', '', '用量记录'))
    var closeBtn = el('button', 'zcwv-panel-close', '关闭')
    closeBtn.type = 'button'
    closeBtn.addEventListener('click', function () {
      toggleUsagePanel()
    })
    head.appendChild(closeBtn)
    panelBox.appendChild(head)
    var msg = el('div', 'zcwv-dim', '用量数据暂不可用（' + reason + '）· 30 秒后自动重试')
    msg.style.whiteSpace = 'normal'
    panelBox.appendChild(msg)
    positionPanel()
  }
  function fetchUsage() {
    try {
      // 用量记录 + 余额校正汇总一起取：对账行要两个口径都在场（校正接口
      // 只是本地账本汇总，拿不到就跳过校正小项，不拦用量记录的展示）
      Promise.all([
        fetch(USAGE_URL, { cache: 'no-store' }).then(function (r) {
          return r.json()
        }),
        fetch(ADJUST_URL, { cache: 'no-store' })
          .then(function (r) {
            return r.json()
          })
          .catch(function () {
            return null
          }),
      ])
        .then(function (list) {
          var d = list[0]
          if (!usageOpen) return
          if (d && d.ok) {
            usageStatus = 'ok'
            renderUsage(d, list[1])
          } else {
            // ok:false（如 db-unavailable）也必须画失败态，不能停在「加载中…」
            usageStatus = 'error'
            renderUsageError((d && d.reason) || '未知错误')
          }
        })
        .catch(function () {
          if (!usageOpen) return
          usageStatus = 'error'
          renderUsageError('请求未送达')
        })
    } catch (err) {}
  }
  function toggleUsagePanel() {
    usageOpen = !usageOpen
    panelBox.classList.toggle('zcwv-panel-open', usageOpen)
    if (usageOpen) {
      verifyFramesFlowing()
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
    // 面板不是整窗接管区（见 overlayShouldInteract）：开关后立即重算穿透，
    // 不等下一次指针移动，避免「关了面板鼠标还被吃一下」
    syncOverlayInteractive()
  }

  // ---------- 按压泡泡（对应上游「自定义泡泡」；v1.3.0 首版为自定义气泡文字） ----------
  // 结构（与服务端 /whale/bubble-content.json 同一份）：
  //   { v:1, first:{text,size}, items:[{text,size}] }
  //   steps：点击序列（第 1 步按压时显示，之后每点一下推进一步，走完收起）
  //   每步 modules：text=文本（换行分行）/ rand=随机语句池；size：B=大字 / A=中字 / C=小字
  // （bubbleContent / bubbleSteps / bubbleCustomActive / bubbleCustomIndex 的声明在
  //   文件前面，因为首次 render() 早于这里执行）
  var BUBBLE_TEXT_MAX = 200

  function fillBubbleText(text, ctx) {
    var model = sessionState && sessionState.modelId ? String(sessionState.modelId) : '--'
    return String(text).replace(/\{(\w+)\}/g, function (all, key) {
      // 模板上下文（每轮消耗 / 预警）优先：{cost}/{pct}/{thr}/{quota}/{amount}/
      // {name}/{title} 只在这些模板里有值；ctx 没带的键落回按压泡泡的语义。
      // {tokens} 在消耗模板 ctx 里 = 本轮 tokens（按压泡泡里仍是今日累计）
      if (ctx && Object.prototype.hasOwnProperty.call(ctx, key) && ctx[key] !== '' && ctx[key] != null) {
        return String(ctx[key])
      }
      var view = SOURCE_VIEW[resolveDisplaySource()] || SOURCE_VIEW.tokens
      if (key === 'balance') {
        if (view.kind === 'percent') {
          return planState && typeof planState.percentRemaining === 'number'
            ? Math.round(planState.percentRemaining * 1000) / 10 + '%'
            : '--'
        }
        if (view.kind === 'vendor-balance') {
          var v3 = sessionState && sessionState.vendorBalance
          return v3 && typeof v3.amount === 'number' ? fmtMoney(v3.amount, v3.currency || 'CNY') : '--'
        }
        if (view.kind === 'money') {
          var vb = sessionState && sessionState.vendorBalance
          if (vb && typeof vb.amount === 'number') return fmtMoney(vb.amount, vb.currency || 'CNY')
          var t = vendorToday(view.todayVendor)
          return t ? fmtMoney(t.amount, moneyCurrency(resolveDisplaySource())) : '--'
        }
        if (view.kind === 'balance') {
          return state.balance !== null && state.balance !== undefined ? fmt(state.balance, state.currency) : '--'
        }
        return usageToday ? formatTokens(usageToday.tokens) + ' tokens' : '--'
      }
      if (key === 'today') return todayLineText()
      if (key === 'tokens') return usageToday ? formatTokens(usageToday.tokens) : '--'
      if (key === 'plan') {
        return planState && typeof planState.percentRemaining === 'number'
          ? Math.round(planState.percentRemaining * 1000) / 10 + '%'
          : '--'
      }
      if (key === 'model') return model
      if (key === 'vendor') return (sessionState && sessionState.label) || '--'
      if (key === 'period') return periodTextNow()
      if (key === 'reset') return planResetText()
      if (key === 'time') {
        var d = new Date()
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
      }
      return all // 未知占位符原样保留，方便用户发现拼错
    })
  }
  // —— v2 按压泡泡（移植 DSH「自定义泡泡」核心）——
  // 点击序列 steps[0..n]：第 1 步在按压时显示，之后每点一下气泡推进一步。
  // 每步由模块行组成（text=文本 / rand=随机语句），渲染时占气泡的三行。
  // 归一化同时接受 v1（{first,items} 旧配置迁移）与 v2（{tapAdvance,steps}）。
  var BUBBLE_STEP_MAX = 12
  var BUBBLE_MODULE_MAX = 3 // 气泡只有三行文字的位置
  // 一条 rand 模块最多几条台词。出厂池最大 13 条（挑经句 2 + 台词 10 + 哦鲸鲸 1，
  // 见 buildPackLines），上限必须 ≥13 否则出厂池经编辑器往返会被截尾（哦鲸鲸最先
  // 丢——2026-10-07 实测：保存一次就少一行，且让「识别出厂池」永远匹配不上）
  var BUBBLE_RAND_MAX = 16
  // rand 模块空语句池的内置语录：按当前角色取台词包（小鲸鱼 = DSH 原八条，
  // 小狐娘 / kimi 娘 / GPT 娘 / 小克 = 各自专属池），定义在本文件靠前的「随机台词分套」区
  function builtinRandQuotes() {
    return quotePack().pool
  }
  function cloneBubbleModule(m) {
    if (!m || typeof m !== 'object') return null
    var size = sizeClass(m.size)
    // 内置视图模块：这一泡显示挂件自带的视图（标题+主数字+小字，自动跟随计费源）
    if (m.type === 'view') return { type: 'view', size: size }
    if (m.type === 'rand') {
      var lines = Array.isArray(m.lines)
        ? m.lines
            .map(parseRandLine)
            .filter(function (o) {
              return o.t && o.t.trim()
            })
            .slice(0, BUBBLE_RAND_MAX)
            .map(lineToStorage)
        : []
      return { type: 'rand', lines: lines, size: size }
    }
    if (m.type === 'link') {
      // 超链接：href 仅 http(s)（与服务端同口径），否则整模块丢弃
      var href = typeof m.href === 'string' ? m.href.trim().slice(0, 300) : ''
      if (!/^https?:\/\/\S+$/i.test(href)) return null
      var ltext = typeof m.text === 'string' ? m.text.slice(0, BUBBLE_TEXT_MAX) : ''
      var lst = cloneLineStyle(m.st)
      var lout = { type: 'link', text: ltext, href: href, size: size }
      if (lst) lout.st = lst
      return lout
    }
    if (m.type === 'img') {
      var imgId = typeof m.img === 'string' ? m.img.slice(0, 40) : ''
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(imgId)) return null
      return { type: 'img', img: imgId, size: size }
    }
    if (m.type === 'randimg') {
      var ids = Array.isArray(m.imgs)
        ? m.imgs
            .filter(function (s) {
              return typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s)
            })
            .filter(function (s, i, a) {
              return a.indexOf(s) === i
            })
            .slice(0, 12)
        : []
      if (!ids.length) return null
      return { type: 'randimg', imgs: ids, size: size }
    }
    var text = typeof m.text === 'string' ? m.text.slice(0, BUBBLE_TEXT_MAX) : ''
    var tout = { type: 'text', text: text, size: size }
    var tst = cloneLineStyle(m.st)
    if (tst) tout.st = tst
    if (m.wrap === false) tout.wrap = false
    return tout
  }
  function cloneBubbleStep(st) {
    // A/B 加权并列步：变体走同一套模块管线
    if (st && Array.isArray(st.variants)) {
      var variants = st.variants
        .map(function (v) {
          var c = cloneBubbleStep({ modules: v && v.modules })
          if (!c.modules.length) return null
          var w = Number(v && v.w)
          var out = { w: isFinite(w) && w >= 1 ? Math.min(999, Math.round(w)) : 1, modules: c.modules }
          if (v && v.only === 'time') out.only = 'time'
          return out
        })
        .filter(Boolean)
        .slice(0, 3)
      if (variants.length) return { variants: variants }
    }
    var mods =
      st && Array.isArray(st.modules)
        ? st.modules
            .map(cloneBubbleModule)
            .filter(Boolean)
            .slice(0, BUBBLE_MODULE_MAX)
        : []
    // 图片类模块独占视觉空间：一步最多一个（与服务端同口径）
    var seenImg = false
    return {
      modules: mods.filter(function (m) {
        if (m.type !== 'img' && m.type !== 'randimg') return true
        if (seenImg) return false
        seenImg = true
        return true
      }),
    }
  }
  function cloneBubbleSteps(steps) {
    return (Array.isArray(steps) ? steps : []).slice(0, BUBBLE_STEP_MAX).map(cloneBubbleStep)
  }
  // 模块库（编辑器「存入库」的常用模块）：与服务端 lib 同构 {id,label,module}
  var BUBBLE_LIB_MAX = 40
  function cloneBubbleLib(raw) {
    if (!Array.isArray(raw)) return []
    var out = []
    for (var i = 0; i < raw.length && out.length < BUBBLE_LIB_MAX; i++) {
      var it = raw[i]
      if (!it || typeof it !== 'object') continue
      var m = cloneBubbleModule(it.module)
      if (!m) continue
      out.push({
        id: typeof it.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(it.id) ? it.id : 'l' + i + Date.now().toString(36),
        label: typeof it.label === 'string' ? it.label.trim().slice(0, 24) : m.type,
        module: m,
      })
    }
    return out
  }
  function moduleHasContent(m) {
    // 空语句池的 rand 模块是合法内容：语义 = 用内置随机台词（DSH 默认队列
    // 的第二个泡泡就是它）；view 模块 = 用内置视图，也永远是"有内容"；
    // img/randimg 归一化时保证非空；link 要文字和链接都有才算写完
    if (m.type === 'rand' || m.type === 'view' || m.type === 'img' || m.type === 'randimg') return true
    if (m.type === 'link') return !!(m.text && m.text.trim()) && !!(m.href && m.href.trim())
    return !!m.text.trim()
  }
  // 这一步是否是「内置视图」步（渲染挂件自带的气泡内容，随计费源自动跟随）
  function stepIsDefaultView(step) {
    return !!(step && Array.isArray(step.modules) && step.modules.some(function (m) {
      return m && m.type === 'view'
    }))
  }
  // 空模块的步同样按内置视图渲染（编辑器里新建的空泡泡没有显式 view 模块，
  // 语义上就是"和原来一样"，别让它变成空白泡）；加权步一律按自定义内容走
  function stepIsViewLike(step) {
    if (step && Array.isArray(step.variants)) return false
    return !!(step && (!step.modules || !step.modules.length || stepIsDefaultView(step)))
  }
  // 这一步是否含自定义内容（加权步看各变体）
  function stepHasContent(st) {
    if (st && Array.isArray(st.variants)) {
      return st.variants.some(function (v) {
        return !!(v && v.modules && v.modules.some(moduleHasContent))
      })
    }
    return !!(st && st.modules && st.modules.some(moduleHasContent))
  }
  function normalizeBubbleConfig(raw) {
    var src = raw && typeof raw === 'object' ? raw : {}
    if (Array.isArray(src.steps)) {
      // v2：全空步（没内容的步骤出不了泡）直接滤掉
      var steps2 = cloneBubbleSteps(src.steps).filter(stepHasContent)
      return { v: 2, tapAdvance: src.tapAdvance !== false, steps: steps2, lib: cloneBubbleLib(src.lib) }
    }
    // v1 迁移：first → 第 1 步，items → 后续步
    var steps1 = []
    if (src.first && typeof src.first.text === 'string' && src.first.text.trim()) {
      steps1.push(cloneBubbleStep({ modules: [{ type: 'text', text: src.first.text, size: src.first.size }] }))
    }
    ;(Array.isArray(src.items) ? src.items : []).forEach(function (it) {
      if (it && typeof it.text === 'string' && it.text.trim()) {
        steps1.push(cloneBubbleStep({ modules: [{ type: 'text', text: it.text, size: it.size }] }))
      }
    })
    return { v: 2, tapAdvance: true, steps: steps1, lib: [] }
  }
  // —— 出厂默认点击队列（对照 DSH：默认内容就是一份普通、可编辑的泡泡配置）——
  // 第 1 步（首次点击）= 内置视图；第 2 步（再次点击）= A/B/C 加权变体：
  //   A 峰谷三行（50，仅在有峰谷/时段差价的源参与）/ B 随机语句池（45）/ C rua 动图（5）
  // 字号/换行/着色逐条对齐统一前的渲染：挑经句与哦鲸鲸是大字且不换行（长句换行会
  // 被拆成两行、显得过大）、文案与尾语中字换行、峰谷行用时段档并跟随峰谷动态着色。
  // 台词行宽估算（B 档 128u 字号下）：全角字符 128u、半角 64u。「在气泡里只占
  // 一行」的台词才升 B 档（用户指定 2026-10-07，上一版整体升 B 让长句爆出气泡）：
  // 行宽 ≤ 560u/0.62（fitBubbleLines 的缩字下限）时缩完仍是一行，超过就保持
  // 中字 A 档换行。
  function quoteLineUnits(t) {
    var s = String(t)
    var w = 0
    for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 0xff ? 128 : 64
    return w
  }
  // 台词包 → 出厂 rand 行（挑经句 B 不换行 / 台词按行宽定档 / 哦鲸鲸 B 不换行）。
  // defaultBubbleSteps 与 rebakeBuiltinPack 共用一份形状，识别与重建不打架
  function buildPackLines(pack) {
    var lines = []
    var push = function (arr, w, opts) {
      for (var i = 0; i < (arr || []).length; i++) {
        var o = { t: String(arr[i]), w: w }
        if (opts) {
          if (opts.size) o.size = opts.size
          if (opts.wrap === false) o.wrap = false
        }
        lines.push(o)
      }
    }
    push(pack.pick, 4, { size: 'B', wrap: false }) // 旧「挑经句」组权重 7，两条平分
    for (var qi = 0; qi < (pack.quotes || []).length; qi++) {
      var q = { t: String(pack.quotes[qi]), w: 2 } // 旧「随机文案」组权重 10，按 6 条折算
      if (quoteLineUnits(q.t) <= Math.round(FIT_WIDTH_UNITS / FIT_SHRINK_MIN)) {
        q.size = 'B'
        q.wrap = false
      }
      lines.push(q)
    }
    push(pack.tail, 2) // 旧「尾语组」组权重 5，按 3 条折算（中字换行）
    lines.push({ t: String(pack.ohh).trim(), w: 1, size: 'B', wrap: false }) // 旧「哦鲸鲸」组权重 1
    return lines
  }
  // 台词池是烤进配置的：切角色后重建队列时，配置里装的还是上一个角色的台词
  //（用户报「小狐娘念小克的台词」）。识别口径 = 该 rand 模块里**每一条**台词文本
  // 都出现在某个角色的出厂台词池中（挑经句 / 台词 / 尾语 / 哦鲸鲸），且不少于 3 条。
  // 只看文本，不看字号 / 换行 / 权重——出厂池经编辑器往返会改档位、还会被
  // BUBBLE_RAND_MAX 截尾（哦鲸鲸最先丢），按整数组严格比对永远匹配不上
  //（2026-10-07 实测踩坑）。用户自己写过台词（文本不在任何出厂池里）就不算出厂池，
  // 原样保留，不会被覆盖。
  function rebakeBuiltinPack(steps) {
    var packs = []
    for (var k in QUOTE_PACK_BY_ROLE) packs.push(QUOTE_PACK_BY_ROLE[k])
    packs.push(QUOTE_PACK_WHALE)
    var poolTexts = []
    for (var p = 0; p < packs.length; p++) {
      var one = []
      var add = function (arr) {
        for (var i = 0; i < (arr || []).length; i++) one.push(String(arr[i]).trim())
      }
      add(packs[p].pick)
      add(packs[p].quotes)
      add(packs[p].tail)
      one.push(String(packs[p].ohh).trim())
      poolTexts.push(one)
    }
    var isBuiltinPool = function (lines) {
      var got = []
      for (var i = 0; i < lines.length; i++) {
        var t = parseRandLine(lines[i]).t.trim()
        if (t) got.push(t)
      }
      if (got.length < 3) return false
      for (var j = 0; j < poolTexts.length; j++) {
        var all = true
        for (var g = 0; g < got.length; g++) {
          if (poolTexts[j].indexOf(got[g]) === -1) {
            all = false
            break
          }
        }
        if (all) return true
      }
      return false
    }
    var walk = function (mods) {
      for (var i = 0; i < (mods || []).length; i++) {
        var m = mods[i]
        if (!m || m.type !== 'rand' || !Array.isArray(m.lines)) continue
        if (isBuiltinPool(m.lines)) m.lines = buildPackLines(quotePack())
      }
    }
    for (var s = 0; s < (steps || []).length; s++) {
      var st = steps[s]
      if (!st) continue
      if (Array.isArray(st.variants)) {
        for (var v = 0; v < st.variants.length; v++) {
          if (st.variants[v]) walk(st.variants[v].modules)
        }
      } else {
        walk(st.modules)
      }
    }
  }
  function defaultBubbleSteps() {
    var lines = buildPackLines(quotePack())
    return [
      { modules: [{ type: 'view', size: 'A' }] },
      {
        variants: [
          {
            w: 50,
            only: 'time',
            modules: [
              { type: 'text', text: '当前时间段为:', size: 'A', wrap: false },
              { type: 'text', text: '{period}', size: 'P', wrap: false, st: { color: 'peak' } },
              { type: 'text', text: '今日已用 {today}', size: 'C', wrap: false },
            ],
          },
          { w: 45, modules: [{ type: 'rand', lines: lines, size: 'A' }] },
          { w: 5, modules: [{ type: 'img', img: 'rua', size: 'A' }] },
        ],
      },
    ]
  }
  // bubbleContent（服务端原始配置，可能是旧 v1）→ 运行时队列。
  // 空配置（全新安装 / 用户清空）落到出厂默认队列——它同样是普通配置，
  // 进编辑器即可逐条改，不再有"内置随机语句"这条独立代码路径。
  function applyBubbleConfig(cfg) {
    var norm = normalizeBubbleConfig(cfg)
    var steps = norm.steps
    rebakeBuiltinPack(steps) // 配置里烤着的出厂台词行换成当前角色的包（切角色后重建队列的关键）
    // 「只有一步」且这一步是「内置视图」的配置，补上出厂第二个泡泡（加权三选一）：
    // 保证点击序列永远 ≥2 步——旧「单步落回 RANDOM_GROUPS 随机台词」的兜底管线
    // 随之不可达并整体移除（U29：同一交互只留一套内容与权重，峰谷文案不再两处维护）。
    // 自定义单泡（含用户删掉首泡后只剩加权三选一的队列）不再自动补泡——
    // 补出来的是出厂台词，用户保存了什么就该是什么（2026-10-07 实测反馈）
    if (steps.length === 1 && stepIsViewLike(steps[0])) steps = steps.concat(cloneBubbleSteps([defaultBubbleSteps()[1]]))
    bubbleSteps = steps.length ? steps : cloneBubbleSteps(defaultBubbleSteps())
    bubbleTapAdvance = norm.tapAdvance
  }
  // 一步 → 气泡三行；空步返回 null（显示默认的余额 / 用量视图）。
  // text/link 模块按换行拆行（link 只有首行带 href）；rand 模块按「|权重」加权
  // 抽一条且不连续重复（没配台词时用内置语录）；img/randimg 模块出一张图（与
  // 文字共存，结果挂在返回值的 .img 上）；view 模块本身不出行（它表示"用内置
  // 视图"，由渲染层整体接管）。ctx = 模板占位符上下文（消耗/预警模板用）。
  function stepToLines(step, ctx) {
    var st = step
    if (st && Array.isArray(st.variants) && st.variants.length) {
      // A/B 加权并列：按 w 抽一个变体（同一步连续出泡不重复）。
      // only:'time' 的变体只在当前计费源有峰谷/时段差价时参与（平价厂商不显示时段）
      var pool = []
      var vws = []
      var timeOn = currentTimeMode() !== 'none'
      for (var vi = 0; vi < st.variants.length; vi++) {
        var vv = st.variants[vi]
        if (!vv) continue
        if (vv.only === 'time' && !timeOn) continue
        pool.push(vv)
        var wv = Number(vv.w)
        vws.push(isFinite(wv) && wv >= 1 ? wv : 1)
      }
      if (!pool.length) return null
      st = pool[pickWeightedIndex(vws, st)]
    }
    if (!st || !Array.isArray(st.modules) || !st.modules.length) return null
    var out = []
    var outImg = null
    for (var i = 0; i < st.modules.length && out.length < 3; i++) {
      var m = st.modules[i]
      if (!m || m.type === 'view') continue
      if (m.type === 'img' || m.type === 'randimg') {
        if (!outImg) {
          var id = m.type === 'img' ? m.img : m.imgs && m.imgs.length ? m.imgs[pickWeightedIndex(m.imgs.map(function () { return 1 }), m)] : null
          if (id) outImg = imgBubbleUrl(id)
        }
        continue
      }
      var raws = []
      var lineSt = null
      var lineSize = ''
      var lineWrap = true
      if (m.type === 'rand') {
        if (m.lines && m.lines.length) {
          var picked = pickRandLine(m.lines, m)
          if (picked) {
            raws = [picked.t]
            lineSt = picked.st
            lineSize = picked.size
            lineWrap = picked.wrap !== false
          }
        } else {
          raws = [pickOne(builtinRandQuotes())]
        }
      } else {
        raws = String(m.text || '').split('\n')
        lineSt = cloneLineStyle(m.st)
        lineWrap = m.wrap !== false
      }
      for (var j = 0; j < raws.length && out.length < 3; j++) {
        var t = fillBubbleText(raws[j], ctx).trim()
        if (t) out.push({ t: t, s: sizeClass(lineSize || m.size), c: '', w: lineWrap, href: m.type === 'link' && j === 0 ? m.href : '', st: lineSt })
      }
    }
    if (!out.length && !outImg) return null
    while (out.length < 3) out.push(null)
    var res = out.slice(0, 3)
    res.img = outImg
    return res
  }
  function loadBubbleContent() {
    try {
      fetch(BUBBLE_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok) return
          bubbleContent = d
          applyBubbleConfig(bubbleContent)
          if (!costBubbleActive) render()
        })
        .catch(function () {})
    } catch (err) {}
  }

  var bubblePanel = el('div', 'zcwv-panel zcwv-editor')
  document.body.appendChild(bubblePanel)
  var bubbleEditorOpen = false
  var bubbleDraft = null
  // -1 = 队列视图（W1）；>=0 = 正在编辑第 n 个泡泡（W2）。结构与 DSH 的
  // 自定义泡泡两窗一致，只是收敛到同一块面板里切换。
  var bubbleEditIndex = -1
  // 编辑器模式：'press' = 按压泡泡队列；'turncost' = 每轮消耗提示内容；
  // 'alert-plan' / 'alert-balance' / 'alert-cmdgo' = 对应预警内容（单泡编辑）
  var bubbleEditMode = 'press'
  var bubbleEditVariant = -1
  // 第 3 级（模块编辑弹层）：正在编辑当前步/变体里的第几个模块，-1 = 不在弹层
  var bubbleEditModule = -1
  // 第 4 级（单句样式页）：正在编辑 rand 模块里的第几条语句，-1 = 不在该层
  var bubbleEditLine = -1
  // 进入单泡编辑页时的快照：该页「返回」= 回滚到快照（取消这一泡的编辑）
  var bubbleStepSnapshot = null
  // 拖拽排序/拖入一律走指针事件（wireDragSort / wirePointerDrop）：
  // HTML5 DnD 在浮层里不可靠（卡片内可选中文字会让浏览器拖"文本"而非元素），已弃用。
  // 泡泡模板（每轮消耗 / 预警）与图库状态
  var TPL_URL = '/whale/bubble-templates.json'
  var BUBBLE_IMGS_URL = '/whale/bubble-imgs.json'
  var turnCostTpl = null
  var alertTpls = {}
  var galleryState = { imgs: [], loaded: false }
  function imgBubbleUrl(id) {
    return id === 'rua' ? GIF_URL : '/whale/bubble-img.png?id=' + encodeURIComponent(id)
  }
  function loadBubbleTemplates() {
    try {
      fetch(TPL_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok) return
          turnCostTpl = d.turnCost || null
          alertTpls = d.alerts || {}
        })
        .catch(function () {})
    } catch (err) {}
  }
  function saveBubbleTemplate(kind, config, done) {
    try {
      // 编辑器里的 kind 带前缀（'alert-plan' 等），服务端存的是裸 kind（'plan'）。
      // 统一在这一个入口剥前缀：「保存并生效」与「恢复内置」都走这里，
      // 不会再出现一侧转了另一侧没转、整类模板存不进去（审查 P2-B）
      var tplKind = String(kind == null ? '' : kind).replace(/^alert-/, '')
      fetch(TPL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: tplKind, config: config === undefined ? null : config }),
      })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok) {
            showAlertBubble('保存失败', (d && d.error) || '未知错误')
            return
          }
          turnCostTpl = d.templates.turnCost || null
          alertTpls = d.templates.alerts || {}
          if (done) done(d)
        })
        .catch(function () {
          showAlertBubble('保存失败', COPY_NET_FAIL)
        })
    } catch (err) {}
  }
  function loadGallery(done) {
    if (galleryState.loaded) {
      if (done) done()
      return
    }
    try {
      fetch(BUBBLE_IMGS_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          galleryState.imgs = d && d.ok && Array.isArray(d.imgs) ? d.imgs : []
          galleryState.loaded = true
          if (done) done()
        })
        .catch(function () {
          galleryState.loaded = true
          if (done) done()
        })
    } catch (err) {
      if (done) done()
    }
  }
  // 可选模块调色板（移植 DSH）：点一下就往当前泡泡里加一个内容模块，数值类
  // 模块自带模板——用户不再需要手打 {balance} 这类占位符。实现为预填模板的
  // text 模块，渲染端与存储端零改动；文本仍可继续编辑（比 DSH 的锁定更宽松）。
  var BUBBLE_PALETTE = [
    [
      '内置视图',
      function () { return { type: 'view', size: 'A' } },
      '这一泡显示挂件自带的内容（余额 / Plan 配额 / 今日已用 + 峰谷提示，随计费源自动跟随）',
    ],
    ['余额数值', function () { return { type: 'text', text: '{balance}', size: 'A' } }, '当前金额或 Plan 配额百分比'],
    ['今日已用', function () { return { type: 'text', text: '今日已用 {today}', size: 'A' } }, '今日已用金额'],
    ['今日 tokens', function () { return { type: 'text', text: '今日 {tokens} tokens', size: 'A' } }, '今日 token 消耗量'],
    ['Plan 剩余', function () { return { type: 'text', text: 'Plan {plan}', size: 'A' } }, 'Plan 剩余百分比'],
    ['Plan 重置', function () { return { type: 'text', text: '{reset}', size: 'A' } }, 'Plan 配额的到期 / 重置时间'],
    ['峰谷时段', function () { return { type: 'text', text: '{period}', size: 'A' } }, '当前是高峰还是空闲（只对分时计价的源有数据）'],
    ['模型', function () { return { type: 'text', text: '{model}', size: 'A' } }, '当前模型名'],
    ['厂商', function () { return { type: 'text', text: '{vendor}', size: 'A' } }, '当前计费厂商'],
    ['时间', function () { return { type: 'text', text: '{time}', size: 'A' } }, '当前时间'],
    ['随机语句', function () { return { type: 'rand', lines: [], size: 'A' } }, '维护一个语句池，每次出泡随机取一条'],
    ['超链接', function () { return { type: 'link', text: '点这里', href: 'https://', size: 'A' } }, '可点击的链接（href 仅 http/https，点击不会推进泡泡）'],
    ['图片', function () { return { type: 'img', img: 'rua', size: 'A' } }, '从泡泡图库选一张图，与文字共存；一步只放一个图片类模块'],
    ['随机图片', function () { return { type: 'randimg', imgs: ['rua'], size: 'A' } }, '图片池每次出泡抽一张且不连续重复'],
  ]
  function toggleBubbleEditor() {
    if (bubbleEditorOpen) {
      closeBubbleEditor()
      return
    }
    bubbleEditMode = 'press'
    bubbleEditVariant = -1
    bubbleEditModule = -1
    bubbleEditLine = -1
    // 有未保存草稿就恢复它（并给出提示），否则以当前生效配置为起点
    var restored = restoreBubbleDraft()
    bubbleDraftRestored = !!restored
    bubbleDraft = restored || {
      tapAdvance: bubbleTapAdvance,
      steps: cloneBubbleSteps(bubbleSteps),
      lib: cloneBubbleLib(bubbleContent && bubbleContent.lib),
    }
    if (!bubbleDraft.steps.length) bubbleDraft.steps = [{ modules: [{ type: 'view', size: 'A' }] }]
    bubbleEditIndex = -1
    loadGallery(function () {
      if (bubbleEditorOpen && bubbleEditIndex >= 0) renderBubbleEditor()
    })
    renderBubbleEditor()
    closeMenu()
    closeRoleList()
    bubbleEditorOpen = true
    verifyFramesFlowing()
    bubblePanel.classList.add('zcwv-panel-open')
    positionBubbleEditor()
    syncOverlayInteractive()
  }
  // 模板编辑器（每轮消耗 / 预警内容）：单泡编辑，保存走 bubble-templates 路由。
  // kind：'turncost' | 'plan' | 'balance' | 'cmdgo'
  function openBubbleTemplateEditor(kind) {
    if (bubbleEditorOpen) closeBubbleEditor()
    bubbleEditMode = kind
    bubbleEditVariant = -1
    bubbleEditModule = -1
    bubbleEditLine = -1
    // 编辑器模式（alert-*）与服务端模板 kind（plan/balance/cmdgo）差一个前缀
    var serverKind = kind === 'turncost' ? 'turncost' : String(kind).replace(/^alert-/, '')
    var cur = serverKind === 'turncost' ? turnCostTpl : alertTpls && alertTpls[serverKind]
    bubbleDraft = {
      tapAdvance: false,
      steps: cur && cur.steps ? cloneBubbleSteps(cur.steps) : [{ modules: [{ type: 'view', size: 'A' }] }],
      lib: [],
    }
    if (!bubbleDraft.steps.length) bubbleDraft.steps = [{ modules: [{ type: 'view', size: 'A' }] }]
    bubbleEditIndex = 0
    loadGallery(function () {
      if (bubbleEditorOpen) renderBubbleEditor()
    })
    renderBubbleEditor()
    closeMenu()
    closeRoleList()
    bubbleEditorOpen = true
    verifyFramesFlowing()
    bubblePanel.classList.add('zcwv-panel-open')
    positionBubbleEditor()
    syncOverlayInteractive()
  }
  // —— 未保存草稿的暂存 ——
  // 点面板以外的地方会把面板关掉（浮层惯例：窗口要还给 ZCode），此前未保存的
  // 编辑就整份丢了（实测反馈）。这里把"与已保存配置不同"的草稿写进 localStorage，
  // 下次打开编辑器自动恢复并给出提示；草稿与已保存配置一致时（含刚保存完）清掉。
  var BUBBLE_DRAFT_KEY = 'zcw-bubble-draft'
  var bubbleDraftRestored = false
  function bubbleDraftStorageJson(cfg) {
    try {
      return JSON.stringify(normalizeBubbleConfig(cfg || {}))
    } catch (err) {
      return ''
    }
  }
  function stashBubbleDraft() {
    if (!bubbleDraft) return
    try {
      var now = bubbleDraftStorageJson(bubbleDraft)
      if (!now || now === bubbleDraftStorageJson(bubbleContent)) localStorage.removeItem(BUBBLE_DRAFT_KEY)
      else localStorage.setItem(BUBBLE_DRAFT_KEY, now)
    } catch (err) {}
  }
  function restoreBubbleDraft() {
    try {
      var raw = localStorage.getItem(BUBBLE_DRAFT_KEY)
      if (!raw) return null
      var norm = normalizeBubbleConfig(JSON.parse(raw))
      // 与当前已保存配置相同（例如上次其实保存成功了）= 没有草稿
      if (JSON.stringify(norm) === bubbleDraftStorageJson(bubbleContent)) {
        localStorage.removeItem(BUBBLE_DRAFT_KEY)
        return null
      }
      return norm
    } catch (err) {
      return null
    }
  }
  function clearBubbleDraft() {
    bubbleDraftRestored = false
    try {
      localStorage.removeItem(BUBBLE_DRAFT_KEY)
    } catch (err) {}
  }
  function closeBubbleEditor() {
    stashBubbleDraft()
    bubbleEditorOpen = false
    bubbleDraft = null
    bubbleEditIndex = -1
    bubbleEditMode = 'press'
    bubbleEditVariant = -1
    bubbleEditModule = -1
    bubbleEditLine = -1
    bubbleStepSnapshot = null
    bubblePanel.classList.remove('zcwv-panel-open')
    syncOverlayInteractive()
    syncKeyboardFocus()
  }
  function positionBubbleEditor() {
    var mr = menuBtn.getBoundingClientRect()
    var pw = bubblePanel.offsetWidth || 330
    var ph = bubblePanel.offsetHeight || 260
    var left = Math.max(8, mr.right - pw)
    var top = mr.top - ph - 8
    if (top < 8) top = Math.min(mr.bottom + 8, Math.max(8, (window.innerHeight || 800) - ph - 8))
    bubblePanel.style.left = left + 'px'
    bubblePanel.style.top = Math.max(8, top) + 'px'
  }
  // 模块/泡泡的实时预览文案：数值类占位符直接展开成当前值（同 DSH 的真实预览）
  function modulePreviewText(m) {
    try {
      if (m.type === 'view') {
        // 内置视图：直接把当前会显示的内容报出来（标题 / 主数字 / 小字）
        return '内置视图：' + builtinViewPreview()
      }
      if (m.type === 'link') return '链接：' + (m.text || '').trim() + ' → ' + (m.href || '')
      if (m.type === 'img') return '图片：' + (m.img === 'rua' ? 'rua 动图（内置）' : m.img)
      if (m.type === 'randimg') return '随机图片 ×' + (m.imgs ? m.imgs.length : 0) + '（含内置 rua）'
      if (m.type === 'rand') {
        if (!m.lines.length) return '随机台词（内置）'
        var first = parseRandLine(m.lines[0]).t
        return '随机：' + fillBubbleText(first).trim() + (m.lines.length > 1 ? ' 等 ' + m.lines.length + ' 条' : '')
      }
      var t = fillBubbleText(m.text).trim()
      return t || '（空文本）'
    } catch (err) {
      return '…'
    }
  }
  // 内置视图当前会显示成什么（给编辑器预览用，与 render() 的默认分支同口径）
  function builtinViewParts() {
    try {
      var source = resolveDisplaySource()
      var view = SOURCE_VIEW[source] || SOURCE_VIEW.tokens
      var head = view.label || '余额'
      if (view.kind === 'percent') {
        return {
          head: head,
          main: planState && typeof planState.percentRemaining === 'number'
            ? Math.round(planState.percentRemaining * 1000) / 10 + '%'
            : '--',
        }
      }
      if (view.kind === 'balance') {
        return {
          head: head,
          main: state.balance !== null && state.balance !== undefined ? fmt(state.balance, state.currency) : '--',
        }
      }
      if (view.kind === 'money') {
        var t = vendorToday(view.todayVendor)
        return { head: head, main: t ? fmtMoney(t.amount, moneyCurrency(source)) : '--' }
      }
      return { head: head, main: usageToday ? formatTokens(usageToday.tokens) : '--' }
    } catch (err) {
      return { head: '余额', main: '--' }
    }
  }
  function builtinViewPreview() {
    var p = builtinViewParts()
    return p.head + ' ' + p.main
  }
  function stepPreviewText(st) {
    var prefix = st && st.variants ? 'A/B 加权 · ' : ''
    var target = st && st.variants && st.variants.length ? st.variants[0] : st
    if (stepIsViewLike(target)) return prefix + '内置视图（跟随余额 / 配额 / 峰谷）：' + builtinViewPreview()
    var parts = []
    var mods = (target && target.modules) || []
    for (var i = 0; i < mods.length && parts.length < 2; i++) {
      // 预览只列真正会出字的内容模块：没填字的文本模块出泡时不出字，列出来
      // 只会让预览变成「（空文本） · 空闲时段」这种噪音
      if (!moduleHasContent(mods[i])) continue
      parts.push(modulePreviewText(mods[i]))
    }
    return prefix + (parts.length ? parts.join(' · ') : '内置视图（跟随余额 / 配额 / 峰谷）：' + builtinViewPreview())
  }
  // 字号用「点击循环」的按钮而不是下拉：少一个原生弹层，状态一眼可见。
  // 四个档：大字 B / 时段 P（与内置视图的时段行同档）/ 中字 A / 小字 C
  function sizeCycleBtn(m) {
    var names = { B: '大字', P: '时段', A: '中字', C: '小字' }
    var order = ['B', 'P', 'A', 'C']
    var b = el('button', 'zcwv-role-mini', names[sizeClass(m.size)])
    b.type = 'button'
    b.title = '点击切换字号（大字 / 时段 / 中字 / 小字）'
    b.addEventListener('click', function () {
      var cur = order.indexOf(sizeClass(m.size))
      m.size = order[(cur + 1) % order.length]
      b.textContent = names[sizeClass(m.size)]
    })
    return b
  }
  function textField(value, onInput, placeholder, max) {
    var ta = el('textarea', 'zcwv-textarea')
    ta.rows = 2
    ta.maxLength = max || BUBBLE_TEXT_MAX
    ta.placeholder = placeholder || ''
    ta.value = value || ''
    ta.addEventListener('input', function () {
      onInput(ta.value)
    })
    return ta
  }
  function moduleTypeName(m) {
    return m.type === 'view'
      ? '内置视图'
      : m.type === 'rand'
        ? '随机语句'
        : m.type === 'link'
          ? '超链接'
          : m.type === 'img'
            ? '图片'
            : m.type === 'randimg'
              ? '随机图片'
              : '文本'
  }
  // 迷你气泡预览：与真气泡同构（三行/图片/小尾巴），渲染管线复用 stepToLines
  // + fillBubbleText，预览即所得。big=true 是第 2 级的大预览。
  function bubblePreviewNode(st, big) {
    var box = el('div', 'zcwv-bprev' + (big ? ' zcwv-bprev-big' : ''))
    box.appendChild(el('div', 'zcwv-bprev-tail'))
    var filled = false
    try {
      if (!stepIsViewLike(st)) {
        var lines = stepToLines(st)
        if (lines) {
          if (lines.img) {
            var im = document.createElement('img')
            im.className = 'zcwv-bprev-img'
            im.src = lines.img
            im.alt = ''
            box.appendChild(im)
            filled = true
          }
          for (var i = 0; i < 3; i++) {
            var ln = lines[i]
            if (!ln) continue
            var cls = 'zcwv-bprev-line' + previewSizeCls(ln.s)
            var div = el('div', cls)
            div.textContent = ln.t
            applyLineStyle(div, ln.st)
            box.appendChild(div)
            filled = true
          }
        }
      }
      if (!filled) {
        // 内置视图：标题 / 主数字 / 峰谷 三行（与 render() 默认分支同口径）
        var p = builtinViewParts()
        box.appendChild(el('div', 'zcwv-bprev-line zcwv-bprev-C', p.head))
        box.appendChild(el('div', 'zcwv-bprev-line zcwv-bprev-B', p.main))
        box.appendChild(el('div', 'zcwv-bprev-line zcwv-bprev-C', periodTextNow()))
      }
    } catch (err) {}
    return box
  }
  // 拖拽排序：**指针事件实现**（不用 HTML5 DnD）。原生 DnD 在浮层里不可靠——
  // 卡片/芯片内都是可选中文字，浏览器会发起"拖文本"而不是元素的 dragstart，
  // 结果是有拖影但 drop 收不到（用户实测两轮）。指针实现自己判定落点：
  // pointerdown 起拖 → pointermove 用 elementFromPoint 找目标 → pointerup 落位。
  // 只对 [data-qidx] / [data-mi] 这类带下标的目标生效；点击按钮/输入框不触发。
  // 拖拽排序：**指针事件实现**（不用 HTML5 DnD）。原生 DnD 在浮层里不可靠——
  // 卡片/芯片内都是可选中文字，浏览器会发起"拖文本"而不是元素的 dragstart，
  // 结果是有拖影但 drop 收不到（实测反馈）。指针实现自己判定落点：
  // pointerdown 起拖 → pointermove 用 elementFromPoint 找目标 → pointerup 落位。
  // 下标一律从节点的 data-qidx / data-mi 属性读（**不是**节点在集合里的位次）：
  // 队列视图的「首次点击」卡不带 data 属性（U23：首次泡位置固定，与 DSH 一致），
  // 集合里只剩 1..n 的卡，按位次取会整体错一位。
  function wireDragSort(nodes, onReorder) {
    for (var i = 0; i < nodes.length; i++) {
      ;(function (node) {
        var idx = Number(node.getAttribute('data-qidx') || node.getAttribute('data-mi'))
        node.addEventListener('pointerdown', function (e) {
          if (e.button !== 0) return
          var t = e.target
          if (t && t.closest && t.closest('button, input, textarea, select, a')) return
          // 阻止浏览器把这次按下升级成原生拖拽/文本选择：我们要的是自己的指针手势
          e.preventDefault()
          var startX = e.clientX
          var startY = e.clientY
          var dragging = false
          var done = false
          var cleanup = function () {
            document.removeEventListener('pointermove', onMove, true)
            document.removeEventListener('pointerup', cleanup, true)
            document.removeEventListener('pointercancel', cleanup, true)
            node.classList.remove('zcwv-bq-dragging')
          }
          var onMove = function (ev) {
            if (done) return
            if (!dragging) {
              if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return
              dragging = true
              node.classList.add('zcwv-bq-dragging')
            }
            ev.preventDefault()
            var under = document.elementFromPoint(ev.clientX, ev.clientY)
            var host = under && under.closest ? under.closest('[data-qidx],[data-mi]') : null
            if (!host || host === node) return
            // 落到别的卡片上就**立刻**换位：浮层里 pointerup 可能收不到（窗口接管
            // 状态由指针位置驱动），等到抬起再换会让卡片卡在"拖动中"、用户还得
            // 再点一下才生效（实测反馈）。一次拖拽 = 一次换位，换完即结束手势。
            var raw = host.getAttribute('data-qidx')
            if (raw === null) raw = host.getAttribute('data-mi')
            var to = Number(raw)
            done = true
            cleanup()
            if (to >= 0 && to !== idx) onReorder(idx, to)
          }
          document.addEventListener('pointermove', onMove, true)
          document.addEventListener('pointerup', cleanup, true)
          document.addEventListener('pointercancel', cleanup, true)
        })
      })(nodes[i])
    }
  }
  // 指针拖拽入框（调色板芯片 → 虚线框）：同一套机制——指针**进入框内**即落位，
  // 不等 pointerup（理由同上）
  function wirePointerDrop(source, zone, onDrop) {
    source.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return
      e.preventDefault() // 别让浏览器把这次按下升级成原生拖拽（那会吞掉指针事件）
      var sx = e.clientX
      var sy = e.clientY
      var dragging = false
      var done = false
      var cleanup = function () {
        document.removeEventListener('pointermove', onMove, true)
        document.removeEventListener('pointerup', cleanup, true)
        document.removeEventListener('pointercancel', cleanup, true)
        zone.classList.remove('zcwv-bq-drop')
      }
      var onMove = function (ev) {
        if (done) return
        if (!dragging) {
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return
          dragging = true
        }
        ev.preventDefault()
        var under = document.elementFromPoint(ev.clientX, ev.clientY)
        var inZone = !!(under && under.closest && under.closest('.zcwv-bq-chips') === zone)
        if (!inZone) {
          if (zone.classList.contains('zcwv-bq-drop')) zone.classList.remove('zcwv-bq-drop')
          return
        }
        zone.classList.add('zcwv-bq-drop')
        done = true
        cleanup()
        onDrop()
      }
      document.addEventListener('pointermove', onMove, true)
      document.addEventListener('pointerup', cleanup, true)
      document.addEventListener('pointercancel', cleanup, true)
    })
  }
  // 指针拖拽入框（调色板芯片 → 虚线框）：与排序同一套指针机制，不依赖原生 DnD
  // 队列内换位（U23：首次泡位置固定——下标 0 不参与，from/to 都必须 ≥1）
  function moveStepInQueue(from, to) {
    var len = bubbleDraft.steps.length
    if (from === to || from < 1 || to < 1 || from >= len || to >= len) return
    var x = bubbleDraft.steps.splice(from, 1)[0]
    bubbleDraft.steps.splice(to, 0, x)
  }
  // 第 1 级的卡片：普通步一张卡；加权步 = A/B/C 并排子卡（带权重角标）+ 标题行。
  // idx 为 bubbleDraft.steps 下标（0 = 首次点击）。卡片右上角 × 删除整泡。
  function queueDelBtn(idx) {
    var del = el('button', 'zcwv-role-mini zcwv-role-del', '×')
    del.type = 'button'
    del.title = '删除第 ' + (idx + 1) + ' 个泡泡'
    del.style.marginLeft = 'auto'
    del.addEventListener('click', function (e) {
      e.stopPropagation()
      bubbleDraft.steps.splice(idx, 1)
      bubbleEditIndex = -1
      bubbleEditVariant = -1
      bubbleEditModule = -1
      bubbleEditLine = -1
      bubbleStepSnapshot = null
      renderBubbleEditor()
    })
    return del
  }
  function queueCard(idx) {
    var st = bubbleDraft.steps[idx]
    var editable = bubbleDraft.steps.length > 1 // 只剩一泡时不提供删除（避免队列被清空）
    var edit = function (variant) {
      return function (e) {
        e.stopPropagation()
        bubbleEditIndex = idx
        bubbleEditVariant = st && st.variants ? variant || 0 : -1
        bubbleEditModule = -1
        bubbleEditLine = -1
        // 进入时的快照：编辑页的「返回」按它回滚 = 取消这一泡的编辑
        bubbleStepSnapshot = JSON.stringify(bubbleDraft.steps[idx])
        renderBubbleEditor()
      }
    }
    if (st && st.variants) {
      var box = el('div', '')
      // U23：首次点击卡（idx 0）不带 data-qidx——它不是拖拽源也不是落点，
      // 与「首泡位置固定」的设计和无 ⋮⋮ 把手的视觉暗示一致
      if (idx > 0) box.setAttribute('data-qidx', String(idx))
      var hdr = el('div', 'zcwv-bq-cardlabel')
      hdr.style.display = 'flex'
      hdr.style.alignItems = 'center'
      hdr.style.gap = '6px'
      hdr.appendChild(el('span', 'zcwv-bq-handle', '⋮⋮'))
      hdr.appendChild(el('span', '', '第 ' + (idx + 1) + ' 泡 · 加权 ' + st.variants.length + ' 选一'))
      if (editable) hdr.appendChild(queueDelBtn(idx))
      box.appendChild(hdr)
      var cols = el('div', 'zcwv-bq-cols')
      var vNames = ['A', 'B', 'C']
      st.variants.forEach(function (v, vi) {
        var card = el('div', 'zcwv-bq-card')
        card.appendChild(el('span', 'zcwv-bq-wbadge', '权重 ' + (v.w >= 1 ? v.w : 1)))
        card.appendChild(el('div', 'zcwv-bq-cardlabel', (vNames[vi] || vi + 1) + ' 泡'))
        card.appendChild(bubblePreviewNode(v))
        card.addEventListener('click', edit(vi))
        cols.appendChild(card)
      })
      box.appendChild(cols)
      return box
    }
    var card = el('div', 'zcwv-bq-card')
    // U23：同上——首卡不参与拖拽排序
    if (idx > 0) card.setAttribute('data-qidx', String(idx))
    var label = el('div', 'zcwv-bq-cardlabel')
    label.style.display = 'flex'
    label.style.alignItems = 'center'
    label.style.gap = '6px'
    if (idx === 0) {
      label.appendChild(el('span', '', '首次点击 · 编辑内容'))
    } else {
      var h = el('span', 'zcwv-bq-handle', '⋮⋮')
      h.title = '拖拽调整出现顺序'
      label.appendChild(h)
      label.appendChild(el('span', '', '第 ' + (idx + 1) + ' 泡 · 编辑内容'))
    }
    if (editable) label.appendChild(queueDelBtn(idx))
    card.appendChild(label)
    card.appendChild(bubblePreviewNode(st))
    card.addEventListener('click', edit(-1))
    return card
  }
  function renderBubbleEditor() {
    while (bubblePanel.firstChild) bubblePanel.removeChild(bubblePanel.firstChild)
    if (!bubbleDraft) {
      positionBubbleEditor()
      return
    }
    if (bubbleEditLine >= 0) {
      renderLineStyleEditor()
    } else if (bubbleEditModule >= 0) {
      renderModuleEditor()
    } else if (bubbleEditMode !== 'press' || bubbleEditIndex >= 0) {
      renderBubbleStepEditor()
    } else {
      renderBubbleQueue()
    }
    positionBubbleEditor()
  }
  // —— 行级样式控件（对照 DSH 单句编辑）：字号 / 加粗 / 斜体 / 下划线 / 颜色 /
  // 底色 / 字体。rand 单句与文本 / 链接模块共用；holder.st 为样式对象（懒建）。
  var STYLE_COLOR_PRESETS = [
    ['红', '#e0433f'],
    ['橙', '#d29922'],
    ['绿', '#3fb950'],
    ['蓝', '#58a6ff'],
    ['紫', '#a371f7'],
    ['灰', '#8b949e'],
  ]
  function styleControls(holder, refresh) {
    if (!holder.st) holder.st = {}
    var st = holder.st
    var wrap = el('div', '')
    var touch = function () {
      if (!styleHasAny(st)) holder.st = st
      if (refresh) refresh()
    }
    // 字号：滑杆 + 数值（默认 = 跟随该行字号档 B/A/C）
    var szRow = el('div', 'zcwv-field')
    szRow.appendChild(el('span', 'zcwv-tag', '字号'))
    var sz = el('input', 'zcwv-number')
    sz.type = 'range'
    sz.min = String(LINE_PX_MIN)
    sz.max = String(LINE_PX_MAX)
    sz.step = '1'
    sz.value = String(st.px || 13)
    sz.style.flex = '1'
    sz.title = '文字像素大小（' + LINE_PX_MIN + '–' + LINE_PX_MAX + '）'
    var szVal = el('span', 'zcwv-tag', st.px ? st.px + 'px' : '默认')
    szVal.style.minWidth = '40px'
    sz.addEventListener('input', function () {
      st.px = Math.max(LINE_PX_MIN, Math.min(LINE_PX_MAX, Math.round(Number(sz.value))))
      szVal.textContent = st.px + 'px'
      touch()
    })
    var szClr = el('button', 'zcwv-role-mini', '默认')
    szClr.type = 'button'
    szClr.title = '字号回到默认档'
    szClr.addEventListener('click', function (e) {
      e.stopPropagation()
      delete st.px
      sz.value = '13'
      szVal.textContent = '默认'
      touch()
    })
    szRow.appendChild(sz)
    szRow.appendChild(szVal)
    szRow.appendChild(szClr)
    wrap.appendChild(szRow)
    // 字形：加粗 / 斜体 / 下划线
    var fxRow = el('div', 'zcwv-field')
    fxRow.appendChild(el('span', 'zcwv-tag', '字形'))
    ;[
      ['bold', '加粗'],
      ['italic', '斜体'],
      ['ul', '下划线'],
    ].forEach(function (it) {
      var lab = el('label', 'zcwv-editor-hint')
      lab.style.display = 'inline-flex'
      lab.style.alignItems = 'center'
      lab.style.gap = '3px'
      var c = el('input', 'zcwv-check')
      c.type = 'checkbox'
      c.checked = st[it[0]] === true
      c.addEventListener('change', function () {
        if (c.checked) st[it[0]] = true
        else delete st[it[0]]
        touch()
      })
      lab.appendChild(c)
      lab.appendChild(el('span', '', it[1]))
      fxRow.appendChild(lab)
    })
    wrap.appendChild(fxRow)
    // 自动换行：关掉 = 不换行（长句会被容器裁切，适合短句保持单行不被拆开）
    var wrapRow = el('div', 'zcwv-field')
    wrapRow.appendChild(el('span', 'zcwv-tag', '换行'))
    var wrapLab = el('label', 'zcwv-editor-hint')
    wrapLab.style.display = 'inline-flex'
    wrapLab.style.alignItems = 'center'
    wrapLab.style.gap = '3px'
    var wrapChk = el('input', 'zcwv-check')
    wrapChk.type = 'checkbox'
    wrapChk.checked = holder.wrap !== false
    wrapChk.title = '自动换行：关闭后这一条始终单行（短句不会被拆成两行）'
    wrapChk.addEventListener('change', function () {
      if (wrapChk.checked) delete holder.wrap
      else holder.wrap = false
      touch()
    })
    wrapLab.appendChild(wrapChk)
    wrapLab.appendChild(el('span', '', '自动换行'))
    wrapRow.appendChild(wrapLab)
    wrap.appendChild(wrapRow)
    // 颜色 / 底色：预设色块 + 自定义取色 + 跟随峰谷
    var mkColorRow = function (key, label) {
      var row = el('div', 'zcwv-field')
      row.appendChild(el('span', 'zcwv-tag', label))
      var chips = el('div', '')
      chips.style.display = 'flex'
      chips.style.flexWrap = 'wrap'
      chips.style.gap = '4px'
      chips.style.alignItems = 'center'
      var noneBtn = el('button', 'zcwv-role-mini', '默认')
      noneBtn.type = 'button'
      noneBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        delete st[key]
        touch()
      })
      chips.appendChild(noneBtn)
      if (key === 'color') {
        // 跟随峰谷动态着色：高峰红 / 谷时绿，按当前计费源的时段口径（含 MiMo 夜间配额）
        var peakBtn = el('button', 'zcwv-role-mini', '跟随峰谷')
        peakBtn.type = 'button'
        peakBtn.title = '按当前计费源的峰谷 / 时段自动着色（高峰红、谷时绿；平价厂商不着色）'
        if (st.color === 'peak') peakBtn.style.borderColor = 'var(--zcw-accent)'
        peakBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          st.color = 'peak'
          touch()
        })
        chips.appendChild(peakBtn)
      }
      STYLE_COLOR_PRESETS.forEach(function (p) {
        var b = el('button', 'zcwv-role-mini', '')
        b.type = 'button'
        b.title = p[0] + '（' + p[1] + '）'
        b.style.background = p[1]
        b.style.width = '18px'
        b.style.height = '18px'
        b.style.padding = '0'
        b.style.borderRadius = '4px'
        b.addEventListener('click', function (e) {
          e.stopPropagation()
          st[key] = p[1]
          touch()
        })
        chips.appendChild(b)
      })
      var pick = el('input', '')
      pick.type = 'color'
      pick.title = '自定义颜色'
      pick.style.width = '28px'
      pick.style.height = '20px'
      pick.style.padding = '0'
      pick.value = st[key] || '#cccccc'
      pick.addEventListener('input', function () {
        st[key] = pick.value
        touch()
      })
      chips.appendChild(pick)
      row.appendChild(chips)
      return row
    }
    wrap.appendChild(mkColorRow('color', '颜色'))
    wrap.appendChild(mkColorRow('bg', '底色'))
    // 字体
    var fRow = el('div', 'zcwv-field')
    fRow.appendChild(el('span', 'zcwv-tag', '字体'))
    var sel = el('select', 'zcwv-sound')
    ;[
      ['', '默认字体'],
      ['serif', '衬线'],
      ['monospace', '等宽'],
    ].forEach(function (o) {
      var op = document.createElement('option')
      op.value = o[0]
      op.textContent = o[1]
      sel.appendChild(op)
    })
    sel.value = st.font || ''
    sel.addEventListener('change', function () {
      if (sel.value) st.font = sel.value
      else delete st.font
      touch()
    })
    fRow.appendChild(sel)
    wrap.appendChild(fRow)
    return wrap
  }
  // 预览盒：把若干行渲染成迷你气泡，可反复刷新（样式编辑用）
  function previewBox(getLines, big) {
    var box = el('div', 'zcwv-bprev' + (big ? ' zcwv-bprev-big' : ''))
    box.appendChild(el('div', 'zcwv-bprev-tail'))
    var refresh = function () {
      while (box.childNodes.length > 1) box.removeChild(box.lastChild)
      var lines = getLines() || []
      for (var i = 0; i < lines.length && i < 3; i++) {
        var ln = lines[i]
        if (!ln) continue
        var div = el('div', 'zcwv-bprev-line' + previewSizeCls(ln.s))
        div.textContent = ln.t
        applyLineStyle(div, ln.st)
        var pc = resolveLineColor(ln.st)
        if (pc) div.style.color = pc
        box.appendChild(div)
      }
      if (!lines.length) box.appendChild(el('div', 'zcwv-bprev-line zcwv-bprev-C', '（空）'))
    }
    refresh()
    return { box: box, refresh: refresh }
  }
  // —— 单句样式页（第 4 级）：句子 / 权重 / 样式 / 预览 ——
  function renderLineStyleEditor() {
    var st = currentEditStep()
    var m = st && st.modules ? st.modules[bubbleEditModule] : null
    if (!m || m.type !== 'rand' || !m.lines || bubbleEditLine >= m.lines.length) {
      bubbleEditLine = -1
      renderBubbleEditor()
      return
    }
    var obj = parseRandLine(m.lines[bubbleEditLine])
    var commit = function () {
      m.lines[bubbleEditLine] = lineToStorage(obj)
    }
    var head = el('div', 'zcwv-row')
    head.appendChild(el('h4', '', '编辑语句（第 ' + (bubbleEditLine + 1) + ' 条）'))
    var backBtn = el('button', 'zcwv-panel-close', '返回')
    backBtn.type = 'button'
    backBtn.title = '回到随机语句表'
    backBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      bubbleEditLine = -1
      renderBubbleEditor()
    })
    head.appendChild(backBtn)
    bubblePanel.appendChild(head)
    bubblePanel.appendChild(el('div', 'zcwv-editor-hint', '内容、权重与样式都只作用于这一条；出泡按权重抽一条显示。'))

    var txtRow = el('div', 'zcwv-field')
    txtRow.appendChild(el('span', 'zcwv-tag', '句子'))
    var ta = el('textarea', 'zcwv-textarea')
    ta.rows = 2
    ta.maxLength = BUBBLE_TEXT_MAX + 4
    ta.value = obj.t
    txtRow.appendChild(ta)
    bubblePanel.appendChild(txtRow)

    var wRow = el('div', 'zcwv-field')
    wRow.appendChild(el('span', 'zcwv-tag', '权重'))
    var wIn = el('input', 'zcwv-number')
    wIn.type = 'number'
    wIn.min = '1'
    wIn.max = '999'
    wIn.step = '1'
    wIn.value = String(obj.w)
    wIn.style.width = '64px'
    wRow.appendChild(wIn)
    wRow.appendChild(el('span', 'zcwv-editor-hint', '越大越常出现（1 = 普通）'))
    bubblePanel.appendChild(wRow)

    var pv = previewBox(function () {
      return [{ t: fillBubbleText(obj.t).trim() || '（空）', s: 'A', st: obj.st }]
    }, true)
    var onInput = function () {
      obj.t = ta.value.replace(/\r?\n/g, ' ')
      var wv = Number(wIn.value)
      obj.w = isFinite(wv) && wv >= 1 ? Math.min(999, Math.round(wv)) : 1
      commit()
      pv.refresh()
    }
    ta.addEventListener('input', onInput)
    wIn.addEventListener('input', onInput)
    bubblePanel.appendChild(styleControls(obj, function () {
      commit()
      pv.refresh()
    }))
    bubblePanel.appendChild(el('div', 'zcwv-bq-sec', '出泡预览'))
    bubblePanel.appendChild(pv.box)

    var doneRow = el('div', 'zcwv-editor-actions')
    var clrBtn = el('button', 'zcwv-sound', '清除样式')
    clrBtn.type = 'button'
    clrBtn.title = '只保留句子与权重，样式回到默认'
    clrBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      obj.st = null
      commit()
      renderBubbleEditor()
    })
    var doneBtn = el('button', 'zcwv-sound', '完成')
    doneBtn.type = 'button'
    doneBtn.title = '回到随机语句表'
    doneBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      bubbleEditLine = -1
      renderBubbleEditor()
    })
    doneRow.appendChild(clrBtn)
    doneRow.appendChild(doneBtn)
    bubblePanel.appendChild(doneRow)
  }
  // —— 队列视图（W1，DSH 风格）：首次/再次点击分区 + 气泡预览卡片 + 拖拽排序 ——
  function renderBubbleQueue() {
    var head = el('div', 'zcwv-row')
    head.appendChild(el('h4', '', '按压泡泡设置'))
    var closeBtn = el('button', 'zcwv-panel-close', '关闭')
    closeBtn.type = 'button'
    closeBtn.addEventListener('click', function () {
      closeBubbleEditor()
    })
    head.appendChild(closeBtn)
    bubblePanel.appendChild(head)
    var hint = el('div', 'zcwv-editor-hint')
    hint.innerHTML =
      '卡片就是<strong>点击队列</strong>：按压鲸鱼显示第 1 个泡泡，之后每点一下换下一个，走完自动收起。' +
      '出厂默认的第二个泡泡是<strong>加权三选一</strong>（峰谷文字 / 随机语句 / rua 动图）——点卡片就能逐条改内容、权重与样式，' +
      '拖 <strong>⋮⋮</strong> 调整出现顺序；空泡泡保存时自动忽略。'
    bubblePanel.appendChild(hint)
    if (bubbleDraftRestored) {
      bubblePanel.appendChild(
        el('div', 'zcwv-editor-hint', '已恢复上次未保存的改动：点「保存」生效；点「重置」或直接在下方改回即可丢弃。')
      )
    }

    // 每轮消耗提示内容（用户裁决收编为本面板首个分区，菜单不再放第二入口）；
    // 卡片预览已自定义时显示模板内容，否则显示内置说明
    bubblePanel.appendChild(el('div', 'zcwv-bq-sec', '每轮消耗提示内容'))
    var tcCard = el('div', 'zcwv-bq-card')
    tcCard.appendChild(el('div', 'zcwv-bq-cardlabel', '每轮消耗提示 · 编辑内容'))
    var tcStep = turnCostTpl && turnCostTpl.steps && turnCostTpl.steps[0]
    if (tcStep && !stepIsViewLike(tcStep)) {
      tcCard.appendChild(bubblePreviewNode(tcStep))
    } else {
      tcCard.appendChild(el('div', 'zcwv-bq-cardlabel', '内置消耗提示（未自定义）：金额主字 + tokens / 配额小字'))
    }
    tcCard.addEventListener('click', function (e) {
      e.stopPropagation()
      openBubbleTemplateEditor('turncost')
    })
    bubblePanel.appendChild(tcCard)

    bubblePanel.appendChild(el('div', 'zcwv-bq-sec', '首次点击弹出内容'))
    bubblePanel.appendChild(queueCard(0))
    // 「再次点击弹出内容」：出厂默认就是一个普通泡泡（加权变体：峰谷文字 / 随机
    // 语句 / rua 动图，见 defaultBubbleSteps），点卡片即可逐条改——不再有"内置
    // 随机语句"这层不可编辑的壳（对照 DSH：默认内容同样是可编辑配置）
    bubblePanel.appendChild(el('div', 'zcwv-bq-sec', '再次点击弹出内容'))
    for (var i = 1; i < bubbleDraft.steps.length; i++) {
      bubblePanel.appendChild(queueCard(i))
    }
    if (bubbleDraft.steps.length > 1) {
      // 拖拽排序只作用于「再次点击」区（首次泡位置固定，与 DSH 一致）
      var nodes = bubblePanel.querySelectorAll('[data-qidx]')
      var arr = []
      for (var n = 0; n < nodes.length; n++) arr.push(nodes[n])
      wireDragSort(arr, function (from, to) {
        // 节点下标 == bubbleDraft.steps 下标（第 1 张卡就是首次泡），不能再加 1
        moveStepInQueue(from, to)
        renderBubbleEditor()
      })
    } else {
      bubblePanel.appendChild(
        el('div', 'zcwv-editor-hint', '还没有后续泡泡：点下面「+ 添加泡泡」加一个，点完上一个就会显示它。')
      )
    }

    var addBtn = el('button', 'zcwv-sound zcwv-bq-plus', '+ 添加泡泡（点完上一个后显示下一个）')
    addBtn.type = 'button'
    addBtn.title = '在点击队列末尾追加一个泡泡（默认用内置视图，点卡片可改）'
    addBtn.disabled = bubbleDraft.steps.length >= BUBBLE_STEP_MAX
    addBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      if (bubbleDraft.steps.length >= BUBBLE_STEP_MAX) return
      // 新泡泡默认「内置视图」：留空的自定义文本模块在保存时会被当归空步丢掉，
      // 用户加了泡泡又没填内容时不该静默消失
      bubbleDraft.steps.push({ modules: [{ type: 'view', size: 'A' }] })
      bubbleEditIndex = bubbleDraft.steps.length - 1
      bubbleEditVariant = -1
      bubbleEditModule = -1
      bubbleEditLine = -1
      // 新加的这一泡没有"进入前状态"：编辑页的「返回」应当把它整个撤掉（失手多加的兜底）
      bubbleStepSnapshot = '__new__'
      renderBubbleEditor()
    })
    bubblePanel.appendChild(addBtn)

    var advRow = el('div', 'zcwv-field')
    // 补 zcwv-check：缺了 accent 就落到浏览器默认绿，与菜单里三个蓝色复选框
    // 并排非常突兀（UI 审查 U6）；顺带获得 16px 尺寸与 cursor:pointer 规格。
    // 注意保持它是面板里的第一个 checkbox（smoke ⑨b 按此断言）
    var advChk = el('input', 'zcwv-check')
    advChk.type = 'checkbox'
    advChk.checked = bubbleDraft.tapAdvance
    advChk.addEventListener('change', function () {
      bubbleDraft.tapAdvance = advChk.checked
    })
    advRow.appendChild(advChk)
    // 说明走悬浮提示（fox 的惯例，对应 DSH 的 (?) 按钮）；不带字面问号
    var advLabel = el('span', 'zcwv-editor-hint', '点按角色推进泡泡队列')
    advLabel.style.lineHeight = '22px'
    advLabel.title = '开启后每点一下角色就往后推进一步，走完收起；关闭时按压鲸鱼总是显示第 1 个泡泡，点气泡才往后翻'
    advRow.appendChild(advLabel)
    bubblePanel.appendChild(advRow)

    var actions = el('div', 'zcwv-editor-actions')
    var cancelBtn = el('button', 'zcwv-sound', '取消')
    cancelBtn.type = 'button'
    cancelBtn.title = '丢弃未保存的修改并关闭'
    cancelBtn.addEventListener('click', function () {
      closeBubbleEditor()
    })
    var resetBtn = el('button', 'zcwv-sound', '重置')
    resetBtn.type = 'button'
    resetBtn.title = '恢复出厂点击队列（首次=内置视图；再次=峰谷文字 / 随机语句 / rua 动图 三选一）'
    resetBtn.addEventListener('click', function () {
      bubbleDraft = {
        tapAdvance: true,
        steps: cloneBubbleSteps(defaultBubbleSteps()),
        lib: bubbleDraft.lib,
      }
      bubbleEditIndex = -1
      bubbleEditVariant = -1
      bubbleEditModule = -1
      bubbleEditLine = -1
      renderBubbleEditor()
    })
    var saveBtn = el('button', 'zcwv-sound', '保存')
    saveBtn.type = 'button'
    saveBtn.title = '保存整个点击队列并立即生效'
    saveBtn.addEventListener('click', saveBubbleContent)
    actions.appendChild(cancelBtn)
    actions.appendChild(resetBtn)
    actions.appendChild(saveBtn)
    bubblePanel.appendChild(actions)
  }
  // —— 单泡编辑视图（W2）：可选模块调色板 + 内容行（实时预览）——
  // press 模式编辑点击队列里的某一步；模板模式（每轮消耗 / 预警）只编辑单泡，
  // 保存走 bubble-templates 路由。加权步在变体页签上编辑当前选中的变体。
  function currentEditStep() {
    var st = bubbleDraft && bubbleDraft.steps[bubbleEditIndex]
    if (st && st.variants && bubbleEditVariant >= 0 && bubbleEditVariant < st.variants.length) {
      return st.variants[bubbleEditVariant]
    }
    return st
  }
  function renderBubbleStepEditor() {
    var isTpl = bubbleEditMode !== 'press'
    // 注意：stepRaw 必须在函数顶部取——模板模式不走下面的 A/B 块，var 声明放在
    // 块内会让模板模式的出泡预览拿到 undefined、永远显示内置视图（实测 bug）
    var stepRaw = bubbleDraft.steps[bubbleEditIndex]
    var st = currentEditStep()
    var head = el('div', 'zcwv-row')
    var headTitle =
      bubbleEditMode === 'turncost'
        ? '编辑每轮消耗提示'
        : bubbleEditMode === 'alert-plan'
          ? '编辑额度预警内容（GLM Plan）'
          : bubbleEditMode === 'alert-cmdgo'
            ? '编辑额度预警内容（CommandCode）'
            : bubbleEditMode === 'alert-balance'
              ? '编辑余额预警内容'
              : '编辑第 ' + (bubbleEditIndex + 1) + ' 个泡泡'
    head.appendChild(el('h4', '', headTitle))
    var backBtn = el('button', 'zcwv-panel-close', isTpl ? '关闭' : '返回')
    backBtn.type = 'button'
    backBtn.title = isTpl
      ? '关闭编辑器（未保存的修改丢弃）'
      : '取消这一泡的编辑（本次改动全部丢弃）并回到队列；要保留改动请点「完成，回到队列」'
    backBtn.addEventListener('click', function () {
      if (isTpl) {
        closeBubbleEditor()
      } else {
        // 返回 = 取消：新加的泡整个撤掉；已有泡恢复成进入编辑页之前的状态
        //（实测反馈：此前只能改不能撤）
        if (bubbleEditIndex >= 0 && bubbleEditIndex < bubbleDraft.steps.length) {
          if (bubbleStepSnapshot === '__new__') {
            bubbleDraft.steps.splice(bubbleEditIndex, 1)
          } else if (bubbleStepSnapshot) {
            try {
              bubbleDraft.steps[bubbleEditIndex] = JSON.parse(bubbleStepSnapshot)
            } catch (err) {}
          }
        }
        bubbleStepSnapshot = null
        bubbleEditIndex = -1
        bubbleEditVariant = -1
        bubbleEditModule = -1
        bubbleEditLine = -1
        renderBubbleEditor()
      }
    })
    head.appendChild(backBtn)
    bubblePanel.appendChild(head)
    var palHint = el('div', 'zcwv-editor-hint')
    if (bubbleEditMode === 'turncost') {
      palHint.innerHTML =
        '<strong>可选模块</strong>：点一下加入内容；每个模块的占位符与样式，点芯片上的 <strong>✎</strong> 进入编辑后可见。' +
        '「内置视图」= 恢复内置消耗提示；清空内容保存同效。'
    } else if (bubbleEditMode.indexOf('alert-') === 0) {
      palHint.innerHTML =
        '<strong>可选模块</strong>：点一下加入内容；占位符见模块编辑页。' +
        '「内置视图」= 恢复内置预警文案；清空内容保存同效。'
    } else {
      palHint.innerHTML =
        '<strong>可选模块</strong>：点一下加入，或<strong>直接拖进下方虚线框</strong>（最多 ' + BUBBLE_MODULE_MAX + ' 行）。' +
        '数值类模块自带模板，出泡时自动换成实时值；模块芯片上的 <strong>✎</strong> 进模块编辑页（随机语句是带权重的表格）。' +
        '点「<strong>内置视图</strong>」则这一泡直接用挂件自带的内容（余额 / 配额 + 峰谷，随计费源自动跟随）。'
    }
    bubblePanel.appendChild(palHint)
    var pal = el('div', 'zcwv-field')
    pal.style.flexWrap = 'wrap'
    // 芯片框先建好（全函数只有这一个节点，下面按顺序 append），调色板芯片的指针拖拽需要它作落点
    var chips = el('div', 'zcwv-bq-chips')
    var addPalette = function (p) {
      if (st.modules.length >= BUBBLE_MODULE_MAX) return
      var fresh = p[1]()
      if (fresh.type === 'view') {
        st.modules = [fresh]
      } else {
        st.modules = st.modules.filter(function (mm) {
          return mm.type !== 'view'
        })
        st.modules.push(fresh)
      }
      renderBubbleEditor()
    }
    BUBBLE_PALETTE.forEach(function (p) {
      var chip = el('button', 'zcwv-sound', p[0])
      chip.type = 'button'
      chip.title = p[2] + '（点一下加入，或直接拖进下方拖拽区）'
      chip.disabled = st.modules.length >= BUBBLE_MODULE_MAX
      wirePointerDrop(chip, chips, function () {
        addPalette(p)
      })
      chip.addEventListener('click', function (e) {
        e.stopPropagation()
        addPalette(p)
      })
      pal.appendChild(chip)
    })
    bubblePanel.appendChild(pal)

    // A/B 加权并列（只在按压泡泡模式开放；模板是单泡，没有推进语义）
    if (!isTpl) {
      var abRow = el('div', 'zcwv-field')
      abRow.style.flexWrap = 'wrap'
      if (stepRaw && stepRaw.variants) {
        var vNames = ['A', 'B', 'C']
        stepRaw.variants.forEach(function (v, vi2) {
          var vName = vNames[vi2] || '变体' + (vi2 + 1)
          var chip = el('button', 'zcwv-sound', vName)
          chip.type = 'button'
          chip.title = '编辑变体 ' + vName
          if (vi2 === bubbleEditVariant) chip.style.borderColor = 'var(--zcw-accent)'
          chip.addEventListener('click', function (e) {
            e.stopPropagation()
            bubbleEditVariant = vi2
            renderBubbleEditor()
          })
          abRow.appendChild(chip)
          var wInput = el('input', 'zcwv-number')
          wInput.type = 'number'
          wInput.min = '1'
          wInput.max = '999'
          wInput.step = '1'
          wInput.value = String(v.w >= 1 ? v.w : 1)
          wInput.title = '变体 ' + vName + ' 的权重（出泡时按权重抽，且不与上次重复）'
          wInput.style.width = '52px'
          wInput.addEventListener('input', function () {
            var wv = Number(wInput.value)
            v.w = isFinite(wv) && wv >= 1 ? Math.min(999, Math.round(wv)) : 1
          })
          abRow.appendChild(wInput)
          if (stepRaw.variants.length > 1) {
            var vdel = el('button', 'zcwv-role-mini zcwv-role-del', '×')
            vdel.type = 'button'
            vdel.title = '删除变体 ' + vName
            vdel.addEventListener('click', function (e) {
              e.stopPropagation()
              stepRaw.variants.splice(vi2, 1)
              bubbleEditVariant = 0
              renderBubbleEditor()
            })
            abRow.appendChild(vdel)
          }
        })
        if (stepRaw.variants.length < 3) {
          var vadd = el('button', 'zcwv-sound', '+ 变体')
          vadd.type = 'button'
          vadd.title = '再加一个加权变体（最多 3 个）'
          vadd.addEventListener('click', function (e) {
            e.stopPropagation()
            stepRaw.variants.push({ w: 1, modules: [{ type: 'view', size: 'A' }] })
            bubbleEditVariant = stepRaw.variants.length - 1
            renderBubbleEditor()
          })
          abRow.appendChild(vadd)
        }
        var voff = el('button', 'zcwv-sound', '取消加权')
        voff.type = 'button'
        voff.title = '去掉加权并列，只保留当前变体的内容'
        voff.addEventListener('click', function (e) {
          e.stopPropagation()
          var keep = currentEditStep()
          bubbleDraft.steps[bubbleEditIndex] = { modules: keep.modules }
          bubbleEditVariant = -1
          renderBubbleEditor()
        })
        abRow.appendChild(voff)
      } else {
        var abBtn = el('button', 'zcwv-sound', 'A/B 加权并列…')
        abBtn.type = 'button'
        abBtn.title = '把这一泡变成 A/B 加权：出泡时按权重抽一个变体显示（移植 DSH）'
        abBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          var cur = bubbleDraft.steps[bubbleEditIndex]
          bubbleDraft.steps[bubbleEditIndex] = {
            variants: [
              { w: 1, modules: cur.modules && cur.modules.length ? cur.modules : [{ type: 'view', size: 'A' }] },
              { w: 1, modules: [{ type: 'view', size: 'A' }] },
            ],
          }
          bubbleEditVariant = 0
          renderBubbleEditor()
        })
        abRow.appendChild(abBtn)
      }
      bubblePanel.appendChild(abRow)
    }

    // 模块库：另存的常用模块，点一下插入当前泡泡（× 从库里移除）
    if (bubbleDraft.lib && bubbleDraft.lib.length) {
      var libRow = el('div', 'zcwv-field')
      libRow.style.flexWrap = 'wrap'
      bubbleDraft.lib.forEach(function (entry) {
        var chip = el('button', 'zcwv-role-mini', entry.label || '模块')
        chip.type = 'button'
        chip.title = '从模块库插入：' + modulePreviewText(entry.module)
        chip.disabled = st.modules.length >= BUBBLE_MODULE_MAX
        chip.addEventListener('click', function (e) {
          e.stopPropagation()
          if (st.modules.length >= BUBBLE_MODULE_MAX) return
          var fresh = cloneBubbleModule(entry.module)
          if (!fresh) return
          if (fresh.type === 'view') {
            st.modules = [fresh]
          } else {
            st.modules = st.modules.filter(function (mm) {
              return mm.type !== 'view'
            })
            st.modules.push(fresh)
          }
          renderBubbleEditor()
        })
        libRow.appendChild(chip)
        var libDel = el('button', 'zcwv-role-mini zcwv-role-del', '×')
        libDel.type = 'button'
        libDel.title = '从模块库移除「' + (entry.label || '') + '」'
        libDel.addEventListener('click', function (e) {
          e.stopPropagation()
          bubbleDraft.lib = bubbleDraft.lib.filter(function (x) {
            return x.id !== entry.id
          })
          renderBubbleEditor()
        })
        libRow.appendChild(libDel)
      })
      bubblePanel.appendChild(libRow)
    }

    // 泡泡内容预览（拖拽区）：模块芯片可拖拽排序、可从上方调色板拖入；
    // ✎ 进模块编辑页，× 移除。
    // 节点复用上面那个芯片框——调色板的落点就是它。这里曾经又 var 出一个新节点，
    // 落点成了游离节点，`closest('.zcwv-bq-chips') === zone` 恒 false，
    // 于是「直接拖进下方虚线框」永远触发不了（审查 P3-D）
    if (!st.modules.length) {
      chips.appendChild(el('span', 'zcwv-editor-hint', '这一泡还没有内容：点上方「可选模块」或从模块库插入；空着保存 = 内置视图'))
    }
    st.modules.forEach(function (m, mi) {
      var chip = el('span', 'zcwv-bq-chip' + (m.type === 'view' ? ' zcwv-bq-viewchip' : ''))
      chip.setAttribute('data-mi', String(mi))
      var h = el('span', 'zcwv-bq-handle', '⋮⋮')
      h.title = '拖拽排序'
      chip.appendChild(h)
      chip.appendChild(el('span', '', moduleTypeName(m)))
      if (m.type !== 'view') {
        var editBtn = el('button', '', '✎')
        editBtn.type = 'button'
        editBtn.title = '编辑这个模块的内容（随机语句是带权重的表格页）'
        editBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          bubbleEditModule = mi
          renderBubbleEditor()
        })
        chip.appendChild(editBtn)
      }
      var del = el('button', 'zcwv-bq-del', '×')
      del.type = 'button'
      del.title = '移除这个模块'
      del.addEventListener('click', function (e) {
        e.stopPropagation()
        st.modules.splice(mi, 1)
        renderBubbleEditor()
      })
      chip.appendChild(del)
      chips.appendChild(chip)
    })
    var chipNodes = chips.querySelectorAll('.zcwv-bq-chip[data-mi]')
    var chipArr = []
    for (var ci = 0; ci < chipNodes.length; ci++) chipArr.push(chipNodes[ci])
    wireDragSort(chipArr, function (from, to) {
      var x = st.modules.splice(from, 1)[0]
      st.modules.splice(to, 0, x)
      renderBubbleEditor()
    })
    bubblePanel.appendChild(chips)

    // 真实气泡大预览：与真气泡同管线渲染（加权步显示当前编辑的变体）
    bubblePanel.appendChild(el('div', 'zcwv-bq-sec', '出泡预览'))
    var previewTarget = stepRaw && stepRaw.variants ? stepRaw.variants[bubbleEditVariant >= 0 ? bubbleEditVariant : 0] : stepRaw
    bubblePanel.appendChild(bubblePreviewNode(previewTarget, true))
    if (!st.modules.length) {
      var emptyHint = el('div', 'zcwv-editor-hint', '这一泡还没有内容：保存后与原来一样，显示内置视图（余额 / 配额 + 峰谷，自动跟随）。点上面的「可选模块」加自定义内容。')
      bubblePanel.appendChild(emptyHint)
    }
    var doneRow = el('div', 'zcwv-editor-actions')
    if (isTpl) {
      var saveTplBtn = el('button', 'zcwv-sound', '保存并生效')
      saveTplBtn.type = 'button'
      saveTplBtn.title = '保存这份模板，下次触发（消耗结算 / 撞预警线）即按它渲染'
      saveTplBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        saveBubbleTemplate(
          bubbleEditMode,
          { steps: bubbleDraft.steps },
          function () {
            closeBubbleEditor()
            showAlertBubble('模板已保存', '下次触发即生效；「内置视图」= 恢复内置文案')
          }
        )
      })
      var resetTplBtn = el('button', 'zcwv-sound', '恢复内置')
      resetTplBtn.type = 'button'
      resetTplBtn.title = '删掉这份自定义模板，回到内置文案'
      resetTplBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        saveBubbleTemplate(bubbleEditMode, null, function () {
          closeBubbleEditor()
          showAlertBubble('已恢复内置文案', '')
        })
      })
      doneRow.appendChild(saveTplBtn)
      doneRow.appendChild(resetTplBtn)
    } else {
      var doneBtn = el('button', 'zcwv-sound', '完成，回到队列')
      doneBtn.type = 'button'
      doneBtn.title = '保留这一泡的改动并回到点击队列（整队列仍需点「保存」才落盘）'
      doneBtn.addEventListener('click', function () {
        bubbleStepSnapshot = null // 保留改动 = 快照作废，避免后续「返回」误回滚
        bubbleEditIndex = -1
        bubbleEditVariant = -1
        bubbleEditModule = -1
        bubbleEditLine = -1
        renderBubbleEditor()
      })
      doneRow.appendChild(doneBtn)
    }
    bubblePanel.appendChild(doneRow)
  }
  // —— 模块编辑页（W3，DSH 风格）：按类型给专属编辑器，随机语句是带权重表格 ——
  function renderModuleEditor() {
    var st = currentEditStep()
    var m = st && st.modules ? st.modules[bubbleEditModule] : null
    if (!m) {
      bubbleEditModule = -1
      renderBubbleEditor()
      return
    }
    var isTpl = bubbleEditMode !== 'press'
    var head = el('div', 'zcwv-row')
    var vNames = ['A', 'B', 'C']
    var stepRaw = bubbleDraft.steps[bubbleEditIndex]
    var where = isTpl
      ? ''
      : '（第 ' + (bubbleEditIndex + 1) + ' 泡' + (stepRaw && stepRaw.variants ? ' · ' + (vNames[bubbleEditVariant] || '') + '泡' : '') + '）'
    head.appendChild(el('h4', '', '编辑模块：' + moduleTypeName(m) + where))
    var backBtn = el('button', 'zcwv-panel-close', '返回')
    backBtn.type = 'button'
    backBtn.title = '回到这一泡的模块区（修改保留在草稿里，回队列点「保存」才生效）'
    backBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      bubbleEditModule = -1
      bubbleEditLine = -1
      renderBubbleEditor()
    })
    head.appendChild(backBtn)
    bubblePanel.appendChild(head)

    if (m.type === 'view') {
      bubblePanel.appendChild(
        el('div', 'zcwv-editor-hint', '内置视图没有可编辑的内容：这一泡显示挂件自带内容（余额 / Plan 配额 / 今日已用 + 峰谷，随计费源自动跟随）。')
      )
    } else {
      var szRow = el('div', 'zcwv-field')
      szRow.appendChild(el('span', 'zcwv-tag', '字号'))
      szRow.appendChild(sizeCycleBtn(m))
      bubblePanel.appendChild(szRow)
    }

    if (m.type === 'rand') {
      // 权重表：一行 = [权重][内容][复制][删除]；存盘仍序列化为「内容|权重」后缀。
      // 打开即预填内置台词池（DSH 同语义：内置句子与权重直接可见可改；把行全部
      // 删光 = 回到内置池）
      if (!m.lines || !m.lines.length) {
        m.lines = builtinRandQuotes().slice(0, BUBBLE_RAND_MAX)
      }
      bubblePanel.appendChild(
        el(
          'div',
          'zcwv-editor-hint',
          '已预填内置台词池，可直接改内容与权重；出泡按权重抽一条、且不与上次连续重复（权重留 1 = 普通随机）。把所有行删光 = 恢复内置池。'
        )
      )
      var whead = el('div', 'zcwv-bq-whead')
      whead.innerHTML = '<span>权重</span><span>内容</span><span>操作</span>'
      bubblePanel.appendChild(whead)
      var table = el('div', 'zcwv-bq-wtable')
      var pruneEmpty = function () {
        m.lines = m.lines.filter(function (s) {
          return parseRandLine(s).t.trim()
        })
      }
      m.lines.forEach(function (line, li) {
        var p = parseRandLine(line)
        var row = el('div', 'zcwv-bq-wrow')
        var wIn = el('input', 'zcwv-number')
        wIn.type = 'number'
        wIn.min = '1'
        wIn.max = '999'
        wIn.step = '1'
        wIn.value = String(p.w)
        wIn.title = '这条台词的权重（出泡概率 ∝ 权重）'
        // U30：内容列是文本，不能用数字框类（.zcwv-number 会把文字居中，长句难读）
        var cIn = el('input', 'zcwv-bq-cin')
        cIn.type = 'text'
        cIn.value = p.t
        cIn.maxLength = BUBBLE_TEXT_MAX + 4
        cIn.placeholder = '台词内容（支持 {balance} 等占位符）'
        cIn.style.flex = '1'
        var sync = function () {
          var wv = Number(wIn.value)
          p.t = cIn.value.replace(/\r?\n/g, ' ')
          p.w = isFinite(wv) && wv >= 1 ? Math.min(999, Math.round(wv)) : 1
          m.lines[li] = lineToStorage(p)
        }
        wIn.addEventListener('input', sync)
        cIn.addEventListener('input', sync)
        // ✎ 单句样式页（字号/字形/颜色/底色/字体）——对照 DSH 的单句编辑浮层
        var styleBtn = el('button', 'zcwv-role-mini', '✎')
        styleBtn.type = 'button'
        styleBtn.title = '编辑这一条的样式（字号 / 加粗 / 斜体 / 下划线 / 颜色 / 底色 / 字体）' + (styleHasAny(p.st) ? '（已设样式）' : '')
        if (styleHasAny(p.st)) styleBtn.style.borderColor = 'var(--zcw-accent)'
        styleBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          bubbleEditLine = li
          renderBubbleEditor()
        })
        var copyBtn = el('button', 'zcwv-role-mini', '⧉')
        copyBtn.type = 'button'
        copyBtn.title = '复制这条（内容、权重与样式一起复制）'
        copyBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          if (m.lines.length >= BUBBLE_RAND_MAX) return
          m.lines.splice(li + 1, 0, m.lines[li])
          renderBubbleEditor()
        })
        var delBtn = el('button', 'zcwv-role-mini zcwv-role-del', '×')
        delBtn.type = 'button'
        delBtn.title = '删除这条台词'
        delBtn.addEventListener('click', function (e) {
          e.stopPropagation()
          m.lines.splice(li, 1)
          pruneEmpty()
          renderBubbleEditor()
        })
        row.appendChild(wIn)
        row.appendChild(cIn)
        row.appendChild(styleBtn)
        row.appendChild(copyBtn)
        row.appendChild(delBtn)
        table.appendChild(row)
      })
      bubblePanel.appendChild(table)
      var addLine = el('button', 'zcwv-sound zcwv-bq-plus', '+ 添加语句')
      addLine.type = 'button'
      addLine.title = '再加一条台词（最多 ' + BUBBLE_RAND_MAX + ' 条）'
      addLine.disabled = m.lines.length >= BUBBLE_RAND_MAX
      addLine.addEventListener('click', function (e) {
        e.stopPropagation()
        if (m.lines.length >= BUBBLE_RAND_MAX) return
        m.lines.push('新台词')
        renderBubbleEditor()
      })
      bubblePanel.appendChild(addLine)
    } else if (m.type === 'link') {
      var lnkPv = previewBox(function () {
        return [{ t: fillBubbleText(m.text || '').trim() || '（链接文字）', s: 'A', st: m.st }]
      }, false)
      bubblePanel.appendChild(
        textField(
          m.text,
          function (v) {
            m.text = v
            lnkPv.refresh()
          },
          '链接文字（出泡显示的词）'
        )
      )
      bubblePanel.appendChild(
        textField(
          m.href,
          function (v) {
            m.href = v
          },
          '链接地址（仅 http/https 可保存）',
          300
        )
      )
      bubblePanel.appendChild(lnkPv.box)
      bubblePanel.appendChild(styleControls(m, function () {
        lnkPv.refresh()
      }))
      bubblePanel.appendChild(
        el('div', 'zcwv-editor-hint', 'href 只允许 http/https（服务端与渲染端双重校验）；点击链接不会推进泡泡队列。')
      )
    } else if (m.type === 'img' || m.type === 'randimg') {
      bubblePanel.appendChild(
        el(
          'div',
          'zcwv-editor-hint',
          m.type === 'img'
            ? '点一张图选用；出泡时图片与文字共存。'
            : '点图加入/移出图片池；出泡时从池里随机抽一张、不连续重复（留「rua」一张 = 永远 rua）。'
        )
      )
      loadGallery()
      var grid = el('div', 'zcwv-bq-grid')
      var items = [{ id: 'rua', name: 'rua 动图' }].concat(galleryState.imgs)
      items.forEach(function (g) {
        var selected = m.type === 'img' ? m.img === g.id : m.imgs && m.imgs.indexOf(g.id) !== -1
        var th = el('button', 'zcwv-bq-thumb' + (selected ? ' zcwv-bq-sel' : ''))
        th.type = 'button'
        th.title = (selected ? '已选用：' : '选用：') + (g.name || g.id)
        var im = document.createElement('img')
        im.src = imgBubbleUrl(g.id)
        im.alt = g.name || g.id
        th.appendChild(im)
        th.appendChild(el('span', 'zcwv-bq-thumbname', g.name || g.id))
        th.addEventListener('click', function (e) {
          e.stopPropagation()
          if (m.type === 'img') {
            m.img = g.id
          } else {
            if (!Array.isArray(m.imgs)) m.imgs = []
            var at = m.imgs.indexOf(g.id)
            if (at === -1) m.imgs.push(g.id)
            else if (m.imgs.length > 1) m.imgs.splice(at, 1)
          }
          renderBubbleEditor()
        })
        grid.appendChild(th)
      })
      bubblePanel.appendChild(grid)
      bubblePanel.appendChild(galleryToolsRow())
    } else {
      var txtPv = previewBox(function () {
        return [
          { t: fillBubbleText(m.text || '').trim() || '（空）', s: 'A', st: m.st },
        ]
      }, false)
      bubblePanel.appendChild(
        textField(
          m.text,
          function (v) {
            m.text = v
            txtPv.refresh()
          },
          '在这里写这句话；支持 {balance} / {today} / {plan} 等占位符'
        )
      )
      bubblePanel.appendChild(txtPv.box)
      bubblePanel.appendChild(styleControls(m, function () {
        txtPv.refresh()
      }))
      if (isTpl) {
        bubblePanel.appendChild(
          el(
            'div',
            'zcwv-editor-hint',
            bubbleEditMode === 'turncost'
              ? '模板占位符：{cost}=本轮金额、{tokens}=本轮 tokens、{pct}=占配额比。'
              : '模板占位符：{title}=默认标题、{thr}=阈值、{quota}=当前剩余、{amount}=当前余额、{name}=来源/窗口名。'
          )
        )
      }
    }

    var doneRow = el('div', 'zcwv-editor-actions')
    if (!isTpl) {
      var saveLibBtn = el('button', 'zcwv-sound', '另存')
      saveLibBtn.type = 'button'
      saveLibBtn.title = '把这个模块另存进模块库（随按压泡泡的「保存」一起落盘）'
      saveLibBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        if (!bubbleDraft.lib) bubbleDraft.lib = []
        if (bubbleDraft.lib.length >= BUBBLE_LIB_MAX) return
        var saved = cloneBubbleModule(m)
        if (!saved) return
        bubbleDraft.lib.push({ label: modulePreviewText(m).slice(0, 24), module: saved })
        showAlertBubble('已存入模块库', '回队列点「保存」后长期生效')
      })
      doneRow.appendChild(saveLibBtn)
    }
    var doneBtn = el('button', 'zcwv-sound', '完成')
    doneBtn.type = 'button'
    doneBtn.title = '回到这一泡的模块区'
    doneBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      bubbleEditModule = -1
      bubbleEditLine = -1
      renderBubbleEditor()
    })
    doneRow.appendChild(doneBtn)
    bubblePanel.appendChild(doneRow)
  }
  // 图库工具行（上传 / 删除导入件），模块编辑页复用
  function galleryToolsRow() {
    var wrap = el('div', 'zcwv-field')
    wrap.style.flexWrap = 'wrap'
    var up = el('button', 'zcwv-sound', '上传图片…')
    up.type = 'button'
    up.title = '上传 png/gif/jpg/webp（≤3MB）进泡泡图库'
    up.addEventListener('click', function (e) {
      e.stopPropagation()
      var inp = document.createElement('input')
      inp.type = 'file'
      inp.accept = 'image/png,image/gif,image/jpeg,image/webp'
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0]
        if (!f) return
        var reader = new FileReader()
        reader.onload = function () {
          fetch('/whale/bubble-img.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: String(f.name || '').replace(/\.[^.]+$/, '').slice(0, 24),
              dataUrl: String(reader.result),
            }),
          })
            .then(function (r) {
              return r.json()
            })
            .then(function (d) {
              if (!d || !d.ok) {
                showAlertBubble('图片上传失败', (d && d.error) || '未知错误')
                return
              }
              galleryState.loaded = false
              loadGallery(function () {
                if (bubbleEditorOpen) renderBubbleEditor()
              })
            })
            .catch(function () {
              showAlertBubble('图片上传失败', COPY_NET_FAIL)
            })
        }
        reader.readAsDataURL(f)
      })
      inp.click()
    })
    wrap.appendChild(up)
    if (galleryState.imgs.length) {
      galleryState.imgs.forEach(function (g) {
        var d = el('button', 'zcwv-role-mini zcwv-role-del', '×')
        d.type = 'button'
        d.title = '从图库删除「' + (g.name || g.id) + '」（正在引用的泡泡回退成无图）'
        d.addEventListener('click', function (e) {
          e.stopPropagation()
          fetch('/whale/bubble-img-delete.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: g.id }),
          })
            .then(function (r) {
              return r.json()
            })
            .then(function (d2) {
              if (d2 && d2.ok) {
                galleryState.loaded = false
                loadGallery(function () {
                  if (bubbleEditorOpen) renderBubbleEditor()
                })
              }
            })
            .catch(function () {})
        })
        wrap.appendChild(d)
      })
    }
    return wrap
  }
  function saveBubbleContent() {
    if (!bubbleDraft) return
    var payload = normalizeBubbleConfig(bubbleDraft)
    payload.lib = cloneBubbleLib(bubbleDraft.lib)
    try {
      fetch(BUBBLE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok) {
            showAlertBubble('按压泡泡保存失败', (d && d.error) || '未知错误')
            return
          }
          bubbleContent = d
          applyBubbleConfig(bubbleContent)
          bubbleCustomIndex = 0
          bubbleCustomActive = false
          clearBubbleDraft() // 已落盘：草稿与生效配置一致，清掉暂存
          closeBubbleEditor()
          showAlertBubble(
            '按压泡泡已保存',
            bubbleSteps.length ? '点一下鲸鱼看看效果' : '已恢复内置台词'
          )
          render()
        })
        .catch(function () {
          showAlertBubble('按压泡泡保存失败', COPY_NET_FAIL)
        })
    } catch (err) {}
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
    bubbleShown = true
    lastHintText = null
    hideQuotaCard()
    gifEl.style.display = 'none'
    labelEl.style.display = ''
    labelEl.className = 'zcwv-label'
    labelEl.textContent = title
    labelEl.style.color = ''
    // 内置预警文案：清掉自定义模板可能留下的行内样式
    clearBubbleLineStyles()
    // 标题与正文统一加粗：label 档默认 600、period 档 800，同屏一细一粗很突兀
    //（用户实测反馈）；clearBubbleLineStyles 会把 fontWeight 还原，不泄漏
    labelEl.style.fontWeight = '800'
    amountEl.style.display = ''
    amountEl.className = 'zcwv-period'
    amountEl.textContent = text
    amountEl.style.color = ''
    hintEl.style.display = 'none'
    hintEl.textContent = ''
    textBox.style.transition = ''
    textBox.style.opacity = ''
    bubbleBox.classList.add('zcwv-bubble-open')
    nudgeBubbleIntoView()
    verifyFramesFlowing()
    hidePanelsForBubble()
    // 同 showCostBubble：先武装自动关闭，再做排版
    if (turnCostCloseMs > 0) {
      alertBubbleTimer = setTimeout(function () {
        alertBubbleTimer = null
        costBubbleActive = false
        hideBubble()
      }, Math.max(4000, turnCostCloseMs))
    }
    fitBubbleLines()
  }
  // 模板化预警泡泡：与 showAlertBubble 同一套打开/计时骨架，内容来自 stepToLines
  function showAlertBubbleLines(lines) {
    if (!bubbleOn) return
    if (alertBubbleTimer) clearTimeout(alertBubbleTimer)
    if (costBubbleActive) hideCostBubble()
    if (bubbleTimer) clearTimeout(bubbleTimer)
    if (gifFadeTimer) clearTimeout(gifFadeTimer)
    costBubbleActive = true
    bubbleShown = true
    lastHintText = null
    hideQuotaCard()
    applyBubbleLines(lines)
    textBox.style.transition = ''
    textBox.style.opacity = ''
    bubbleBox.classList.add('zcwv-bubble-open')
    nudgeBubbleIntoView()
    verifyFramesFlowing()
    hidePanelsForBubble()
    // 同 showCostBubble：先武装自动关闭，再做排版
    if (turnCostCloseMs > 0) {
      alertBubbleTimer = setTimeout(function () {
        alertBubbleTimer = null
        costBubbleActive = false
        hideBubble()
      }, Math.max(4000, turnCostCloseMs))
    }
    fitBubbleLines()
  }
  function fireAlert(type, thr, title, text, ctx) {
    // 去重先行：模板路径与内置路径共用同一把「每天每类型每阈值」的去重键，
    // 否则自定义模板的预警会随轮询反复弹（去重绝不能被模板分支绕过）
    var day = alertDayKey()
    var key = 'zcw-alert-' + type + '-' + day + '-' + thr
    try {
      // 写入前顺手清掉非当天的旧去重键：键名带日期，此前每天每阈值新增一个、
      // 永不清理（审查 P3-3）。只清 zcw-alert- 前缀，其他键不动。
      var stale = []
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i)
        if (k && k.indexOf('zcw-alert-') === 0 && k.indexOf('-' + day + '-') === -1) stale.push(k)
      }
      for (var j = 0; j < stale.length; j++) localStorage.removeItem(stale[j])
      if (localStorage.getItem(key)) return
      localStorage.setItem(key, '1')
    } catch (err) {}
    // 自定义预警模板（移植 DSH）：按预警族（plan/cmdgo/balance）找模板，占位符
    // {title}/{thr}/{quota}/{amount}/{name} 由调用方给上下文；没配模板走内置文案
    var fam = String(type).split('-')[0]
    if (fam === 'money') fam = 'balance' // 余额预警的模板 kind（服务端同名）
    var tpl = alertTpls && alertTpls[fam] && alertTpls[fam].steps && alertTpls[fam].steps[0]
    if (tpl && !stepIsViewLike(tpl)) {
      var alertCtx = Object.assign({ title: title, thr: thr, quota: '', amount: '', name: '' }, ctx || {})
      var lines = stepToLines(tpl, alertCtx)
      if (lines && (lines[0] || lines[1] || lines[2] || lines.img)) {
        showAlertBubbleLines(lines)
        return
      }
    }
    showAlertBubble(title, text)
  }
  // 预警：Plan 剩余% + 「余额¥」阈值，各管各的：
  //   · Plan 剩余低于阈值提醒（配额口径）
  //   · DeepSeek 余额低于阈值提醒（余额口径）
  // 每个来源每天只提醒一次（去重键带来源与阈值），阈值改大改小会重新武装。
  // 消费型厂商（GLM / MiMo / Kimi / OpenAI / Claude / Qwen / MiniMax）的
  // 「今日已用达到」预警 v1.7.7 起取消——它们没有公开余额接口，不存在「见底」，
  // 盯消耗速度的提醒与「预警」语义混淆（用户裁决）；旧的 'money-<厂商>' 去重
  // 键留在 localStorage 里不再写入，无需清理。
  //
  // DeepSeek 按人民币计价；保留 toCNY/cnyHint 是为了余额口径将来接入美元
  // 厂商时不重蹈「$1.2 撞不上 ¥1.5」的数值直比坑（汇率只用于这一个判断，
  // 不参与记账与计价）。
  var FX_CNY_PER = { CNY: 1, USD: 7.1 }
  function toCNY(amount, currency) {
    var rate = FX_CNY_PER[currency || 'CNY']
    if (!rate) return null // 未知币种：不猜
    var n = Number(amount)
    return isFinite(n) ? n * rate : null
  }
  function cnyHint(amount, currency) {
    var cur = currency || 'CNY'
    if (cur === 'CNY') return ''
    var cny = toCNY(amount, cur)
    // 走 fmtMoney：同一句里「达到 ¥ 5.00」有间隔符，折算值也要同一格式（U4）
    return isFinite(cny) ? '（约 ' + fmtMoney(cny, 'CNY') + '）' : ''
  }
  // 额度预警（v1.8.0 泛化）：一条阈值覆盖所有能读出额度的来源，判定一律是
  // 「剩余比例低于阈值」——各来源用自己的单位表达同一件事：
  //   · GLM Plan：日志里就是剩余百分比，直接比
  //   · CommandCode：卡片上是**已用进度**（0→100），折成 剩余＝100−已用 再比；
  //     所以「阈值 20%」在用户侧表现为「进度涨到 80% 以上才提醒」
  // 已撞墙时不做减法打印负百分比（那正是 v1.7.9 要消灭的怪数字），改用与额度卡
  // 一致的「已限流」措辞（UI 审查 U19）
  function checkAlerts(kind) {
    var quota = Number(alerts.quotaPct) || 0
    if (kind === 'plan' && quota > 0 && planState && typeof planState.percentRemaining === 'number') {
      var pct = planState.percentRemaining * 100
      if (pct <= quota) {
        fireAlert('plan', quota, '额度预警', 'GLM Plan 剩余 ' + pct.toFixed(1) + '%，低于 ' + quota + '%', {
          name: 'GLM Plan',
          quota: pct.toFixed(1) + '%',
          thr: quota + '%',
        })
      }
    }
    if (kind === 'cmdgo' && quota > 0 && cmdgoState && cmdgoState.ok) {
      // 三重窗口取「已用比例」最高的一条（= 剩余最低）跟阈值比较；
      // 去重键带窗口名，窗口各自每天最多提醒一次
      var wins = []
      if (cmdgoState.fiveHour) wins.push({ name: '5小时', w: cmdgoState.fiveHour })
      if (cmdgoState.weekly) wins.push({ name: '本周', w: cmdgoState.weekly })
      if (cmdgoState.monthly && typeof cmdgoState.monthly.percent === 'number') {
        wins.push({ name: '本月', w: { percent: cmdgoState.monthly.percent, resetAt: null } })
      }
      var worst = null
      for (var wi = 0; wi < wins.length; wi++) {
        if (!worst || (wins[wi].w.percent || 0) > (worst.w.percent || 0)) worst = wins[wi]
      }
      if (worst) {
        var used = worst.w.percent || 0
        var remPct = (1 - used) * 100
        if (remPct <= quota) {
          var over = worst.w.exceeded === true || used >= 1
          var msg = over
            ? 'CommandCode ' + worst.name + '窗口已限流，等待重置后恢复'
            : 'CommandCode ' + worst.name + '窗口 剩余 ' + remPct.toFixed(1) + '%，低于 ' + quota + '%'
          fireAlert('cmdgo-' + worst.name, quota, '额度预警', msg, {
            name: worst.name,
            quota: over ? '已限流' : remPct.toFixed(1) + '%',
            thr: quota + '%',
          })
        }
      }
    }
    var thr = Number(alerts.moneyAlert) || 0
    if (thr <= 0) return
    if (state.status === 'ok' && typeof state.balance === 'number') {
      var bal = toCNY(state.balance, state.currency)
      if (bal !== null && bal <= thr) {
        fireAlert(
          'money-ds',
          thr,
          '余额预警',
          'DeepSeek 余额 ' +
            fmtMoney(state.balance, state.currency) +
            cnyHint(state.balance, state.currency) +
            '，低于 ' +
            fmtMoney(thr, 'CNY'),
          { name: 'DeepSeek', amount: fmtMoney(state.balance, state.currency) + cnyHint(state.balance, state.currency), thr: fmtMoney(thr, 'CNY') }
        )
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
          if (d.seq < lastCostSeq) {
            // 服务端 seq 回退 = 服务重启过（计数已持久化续号，但仍可能因崩溃
            // 丢最后一拍）：重新对齐，否则新服务的轮次永远追不上旧计数，
            // 气泡会静默失效。
            lastCostSeq = d.seq
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

  // GLM Plan 配额：60 秒轮询一次（客户端自身约每分钟刷新日志），有变化就重绘 hint
  function pollPlan() {
    try {
      fetch(PLAN_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          // 失败载荷要**保留**：render 的 percent 分支靠 planState.ok === false 显示
          // 「日志未找到 / 读取失败」。此前把非 ok 丢成 null，那个分支等于死代码——
          // 没有日志或断网的机器永远停在「加载中…」（UI 审查 U18，首轮 U1 同款缺陷）
          var next = d && typeof d === 'object' ? d : null
          var changed = JSON.stringify(next) !== JSON.stringify(planState)
          planState = next
          if (changed && !costBubbleActive) render()
          checkAlerts('plan')
        })
        .catch(function () {
          var failed = { ok: false, reason: '网络请求失败' }
          var changed = JSON.stringify(failed) !== JSON.stringify(planState)
          planState = failed
          if (changed && !costBubbleActive) render()
        })
    } catch (err) {}
  }
  setInterval(pollPlan, 60000)
  pollPlan()

  // CommandCode 三重额度（月度池/5小时/周）：60 秒刷新，服务端 cmdgo.mjs
  // 另有每凭据 TTL，双端都不会打到网关。render 的 qcard 分支消费 cmdgoState。
  // 剔除 readAt 后的稳定键：readAt 是服务端每次读取都重打的时间戳，落在数据体里
  // 会让整体比对每次必判「有变化」——60s 轮询于是必跑一次整卡重绘，同时放大
  // 「卡片顶掉台词」的时间窗。比对内容而不是时刻：没变就不重绘。
  function cmdgoKey(v) {
    if (!v || typeof v !== 'object') return String(v)
    var copy = {}
    for (var k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k) && k !== 'readAt') copy[k] = v[k]
    }
    return JSON.stringify(copy)
  }
  function pollCmdgo() {
    try {
      fetch(CMDGO_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          var next = d && (d.ok || d.reason) ? d : null
          var changed = cmdgoKey(next) !== cmdgoKey(cmdgoState)
          cmdgoState = next
          if (changed && !costBubbleActive) render()
          checkAlerts('cmdgo')
        })
        .catch(function () {
          // 网络失败不再静默留旧数据：卡片改说「读取失败」，用户能分辨旧值
          var failed = { ok: false, reason: '网络请求失败' }
          var changed = cmdgoKey(failed) !== cmdgoKey(cmdgoState)
          cmdgoState = failed
          if (changed && !costBubbleActive) render()
        })
    } catch (err) {}
  }
  setInterval(pollCmdgo, 60000)
  pollCmdgo()

  // 今日用量汇总（按厂商）：60 秒刷新一次（供气泡主显示与预算预警共用）
  function refreshUsageSummary() {
    try {
      fetch(USAGE_URL, { cache: 'no-store' })
        .then(function (r) {
          return r.json()
        })
        .then(function (d) {
          if (!d || !d.ok) {
            // 失败也要落到主显示（--/获取失败·点击重试），不能永远「统计中…」
            usageStatus = 'error'
            if (!costBubbleActive) render()
            return
          }
          // 厂商汇总优先用服务端的全量分组（today.byVendor）：它与面板明细同源，
          // 不会像「按模型行分组」那样被 Top12 截断少算。老服务端退回自行分组。
          var byVendor = d.today.byVendor || {}
          if (!Object.keys(byVendor).length) {
            d.today.models.forEach(function (m) {
              var k = m.vendorLabel || '未知'
              if (!byVendor[k]) byVendor[k] = { amount: 0, tokens: 0, currency: m.currency || 'CNY' }
              byVendor[k].amount += Number(m.amount) || 0
              byVendor[k].tokens += Number(m.tokens) || 0
              if (m.currency) byVendor[k].currency = m.currency
            })
          }
          usageToday = {
            total: Number(d.today.total) || 0,
            tokens: Number(d.today.tokens) || 0,
            totals: d.today.totals || null,
            byVendor: byVendor,
          }
          usageStatus = 'ok'
          checkAlerts('money')
          if (!costBubbleActive) render()
        })
        .catch(function () {
          usageStatus = 'error'
          if (!costBubbleActive) render()
        })
    } catch (err) {}
  }

  // 按厂商取今日汇总（vendorLabel 与 pricing.mjs 的厂商标签对齐）
  function vendorToday(vendorLabel) {
    if (!usageToday || !vendorLabel) return null
    return usageToday.byVendor[vendorLabel] || { amount: 0, tokens: 0 }
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
