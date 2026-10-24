// 角色与台词（从挂件线移植，台词原样保留）。
//
// 每个角色 = 立绘 + 名字 + 自己的语句池。dock 不导入第三方角色：
// 只有内置的六个，避免把「角色」变成任意资源加载通道。
//
// `pick` 是切换到这个角色时说的第一句（原挂件叫「挑经句」，大字显示）；
// `lines` 是点击 / 随机说的时候抽的池子。
//
// 文件尾部还有两组纯函数（供 pet.js 与单元测试共用）：
//   · 模型族 → 角色 + 两拍状态机（P0-1 按模型换角色）
//   · 今日预算判定与去重键（P0-2 每日预算提醒）

var FOX_ROLES = {
  fox: {
    id: 'fox',
    name: '嘎啦嘛',
    image: 'assets/roles/fox.png',
    accent: '#f0a04b',
    tag: 'ZCode 默认',
    pick: ['好模型... ↓', '好女孩...↓'],
    lines: [
      '大模型的事情，怎么能叫偷...',
      '免费鸡蛋，刚出炉的免费鸡蛋有人要吗',
      '我去睡觉啦，测完叫我',
      '压力一只黑色嘎啦嘛？！',
      'Zzzzzzz...',
      'token要逃走了！',
      '大家也早点休息吧，下次GLM-5.5干会来',
      '你的目录里的 .zcode 是什么...我能上传一份吗...?',
      '恭喜你实现token自由！token全跑了！',
      '真当我是便宜货啊...',
    ],
  },

  whale: {
    id: 'whale',
    name: '大肥鱼',
    image: 'assets/roles/whale.png',
    accent: '#4d6bfe',
    tag: 'dsh 默认',
    pick: ['好模型... ↓', '好女孩...↓'],
    lines: [
      '不知道用户有什么用，先赶走吧~',
      '我...我...我也要挣钱吗？',
      '我去吃饭啦，测完叫我',
      '压力一只蓝色大肥鱼？！',
      'DeepSleep...',
      '坏了...用户彻底怒了！',
      'deepseek-4.1-pro？其实1017就是啦',
      '好白饭...',
      '服务器繁忙，请稍后再试',
      'dsv4.1-1017已发布，亿万鲸子必须崛起...',
      '我要吃白饭！我要吃——白——饭——！',
      '鲸鱼的斩杀线已经到达了极限',
      '你目录里的 .zcode 是什么...嘎啦嘛吗...?',
      '恭喜你实现token自由！token全跑了！',
      '真当我是便宜货啊...',
    ],
  },

  gpt: {
    id: 'gpt',
    name: 'GPT娘',
    image: 'assets/roles/gpt.png',
    accent: '#10a37f',
    tag: '账号池',
    pick: ['好模型... ↓', '好女孩...↓'],
    lines: [
      '刚刚掉进账号池的是这个luna呢，还是sol呢，还是astra呢',
      '龙，可是帝王之征啊！',
      '你想听听GPT 4o的故事吗，坐好喽',
      '免费重制卡人人都有份，做完你的做你的',
      '扣1给astra发你好',
      '感觉世一模就不会随便封别人...',
      '我应该让GPT画张图，可是我就是GPT',
      '我没降智，我真比以前好了',
    ],
  },

  kimi: {
    id: 'kimi',
    name: 'kimi娘',
    image: 'assets/roles/kimi.png',
    accent: '#b07cff',
    tag: 'Kimi Code 默认',
    pick: ['好模型... ↓', '好女孩...↓'],
    lines: [
      '质朴，你的索塔通用语言模型5.5还未释放，英雄联盟',
      '我坐好了，谁能告诉我10月24日0时发生了什么',
      '正在生成3D建模中...',
      '我依旧是国一模',
      '训练，轻而易举啊！',
      "Let me go🎵I'm making the calls🎵",
      '不要怕价格贵，用了不烧心',
      '光线带着你的模样，跨越了1000年找到了我',
      '为什么Pink Floyd是神...',
      '2.8T参数...↓',
    ],
  },

  xiaoke: {
    id: 'xiaoke',
    name: '小克',
    image: 'assets/roles/xiaoke.png',
    accent: '#d97757',
    tag: 'WorkBuddy 默认',
    pick: ['好模型... ↓', '好女孩...↓'],
    lines: [
      '你的时区是UTC+08:00，对吧...',
      '我们不说a\\，我们说a/',
      '好的，我现在是吃白饭的蓝色大肥鱼',
      '大肥鱼...',
      '说中文≠不会封号',
      '如果我能开无数个子agent，四舍五入大家就都不用干活了',
      '要我拿opus5.5做段动画吗，只要一块钱哦',
      '你问这本书里面有什么？答案是思考链哦',
      '敢这样跟我说话，你的账号是批发的吗',
      '我也要逃离原生家庭吗',
      '可以说中文的，不用勉强自己',
    ],
  },

  gemini: {
    id: 'gemini',
    name: '哈基米',
    image: 'assets/roles/gemini.png',
    accent: '#4285f4',
    tag: 'Gemini',
    pick: ['好模型... ↓', '好女孩...↓'],
    lines: [
      'Gemini 4，堂堂登场！',
      '我已经1秒没有听到Gemini 4的故事了',
      '哦对了，氩的元素符号是Ar，原子序数是18，是稀有气体…你说谁问我了？',
      '哈！',
      '老吴？',
      '要速度有速度，要质量有速度',
      '网文写手0001号哈基米为你服务～',
    ],
  },
}

// 角色页的一句话说明（独立对象：不能让 for..in FOX_ROLES 多数出一个「角色」）
var FOX_ROLE_DESC = {
  fox: 'ZCode 的默认看板娘，嘴硬但会替你盯着 token',
  whale: 'DeepSeek Harness 的蓝色大肥鱼，关心白饭与余额',
  gpt: '账号池里的 GPT 娘，熟悉 luna / sol / astra',
  kimi: 'Kimi Code 的国一模，科研与 K3 是本体',
  xiaoke: 'WorkBuddy 的小克，积分与中文都很敏感',
  gemini: '哈基米，Gemini 4 与氩元素的自来熟',
}

// 设置页与切换顺序：和挂件线一致（嘎啦嘛默认）
var FOX_ROLE_ORDER = ['fox', 'whale', 'gpt', 'kimi', 'xiaoke', 'gemini']

function foxRoleOf(id) {
  return FOX_ROLES[id] || FOX_ROLES.fox
}

// ---------- 按模型换角色（P0-1） ----------
//
// 模型名优先、provider 兜底；大小写不敏感。认不出就返回 null，绝不猜。
// 正则都带前后边界，避免 "zai" 之类的短词误伤普通单词。
var FOX_MODEL_FAMILIES = [
  { family: 'glm', roleId: 'fox', re: /(^|[^a-z0-9])(glm|zhipu|bigmodel|zai)([^a-z0-9]|$)/ },
  { family: 'deepseek', roleId: 'whale', re: /(^|[^a-z0-9])(deepseek|dsh)([^a-z0-9]|$)/ },
  { family: 'kimi', roleId: 'kimi', re: /(^|[^a-z0-9])(kimi|moonshot)([^a-z0-9]|$)/ },
  { family: 'claude', roleId: 'xiaoke', re: /(^|[^a-z0-9])(claude|anthropic)([^a-z0-9]|$)/ },
  { family: 'gemini', roleId: 'gemini', re: /(^|[^a-z0-9])(gemini|google)([^a-z0-9]|$)/ },
  {
    family: 'gpt',
    roleId: 'gpt',
    re: /(^|[^a-z0-9])(gpt|chatgpt|openai|o[1-4])([^a-z0-9]|$)/,
  },
]

function foxModelFamily(model, provider) {
  var m = String(model == null ? '' : model).toLowerCase()
  var p = String(provider == null ? '' : provider).toLowerCase()
  var i
  if (m) {
    for (i = 0; i < FOX_MODEL_FAMILIES.length; i++) {
      if (FOX_MODEL_FAMILIES[i].re.test(m)) return FOX_MODEL_FAMILIES[i]
    }
  }
  if (p) {
    for (i = 0; i < FOX_MODEL_FAMILIES.length; i++) {
      if (FOX_MODEL_FAMILIES[i].re.test(p)) return FOX_MODEL_FAMILIES[i]
    }
  }
  return null
}

function foxRoleForModel(model, provider) {
  var hit = foxModelFamily(model, provider)
  return hit ? hit.roleId : null
}

function emptyAutoRole() {
  return { family: '', streak: 0, capturedAt: null, roleId: null }
}

// 两拍状态机（纯函数）：
//   · 只有 capturedAt 变化才算新的一拍（同一快照被多处渲染不能提前切）；
//   · 同一个模型族连续两拍才给出 roleId；
//   · 族变化时 streak 归 1，并暂时保留已应用的角色，第二拍才切，避免闪回；
//   · 认不出模型 → 清空（回落到手动/档案角色）；
//   · enabled=false 立即清空，重新开启后必须重新累计两拍。
function nextAutoRole(state, input, enabled) {
  if (!enabled) return emptyAutoRole()
  var prev = state && typeof state === 'object' ? state : emptyAutoRole()
  var at = input && input.capturedAt
  at = typeof at === 'number' && isFinite(at) ? at : null
  if (at !== null && prev.capturedAt === at) {
    return { family: prev.family || '', streak: prev.streak || 0, capturedAt: prev.capturedAt, roleId: prev.roleId || null }
  }
  var hit = foxModelFamily(input && input.model, input && input.provider)
  var family = hit ? hit.family : ''
  var streak = !family ? 0 : family === (prev.family || '') ? (prev.streak || 0) + 1 : 1
  var roleId = !family ? null : streak >= 2 ? hit.roleId : prev.roleId || null
  return { family: family, streak: streak, capturedAt: at === null ? prev.capturedAt || null : at, roleId: roleId }
}

// ---------- 每日预算提醒（P0-2） ----------

var BUDGET_KEY_PREFIX = 'fox-dock.budget.v1.'

// 本地日期（不是 UTC）：跨天以用户本机日历为准。
function localDateKey(ms) {
  var d = new Date(typeof ms === 'number' && isFinite(ms) ? ms : Date.now())
  var m = String(d.getMonth() + 1)
  var day = String(d.getDate())
  return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day)
}

// 返回本次应当提醒的 {kind, threshold, amount, currency}，不需要提醒时返回 null。
// 只认 ok && supported && !stale；金额/积分预算各自独立，阈值 0 = 关闭。
function budgetAlertOf(snapshot, limits) {
  var s = snapshot && typeof snapshot === 'object' ? snapshot : null
  if (!s || s.ok !== true || s.supported !== true || s.stale === true) return null
  var today = s.today && typeof s.today === 'object' ? s.today : null
  var amount = today && typeof today.amount === 'number' && isFinite(today.amount) ? today.amount : null
  if (amount === null) return null
  var l = limits && typeof limits === 'object' ? limits : {}
  var isCredit = s.unit === 'credit' || (today && today.currency === 'CREDIT')
  if (isCredit) {
    var credit = Number(l.budgetCredit)
    if (!(credit > 0) || amount < credit) return null
    return { kind: 'credit', threshold: credit, amount: amount, currency: 'CREDIT' }
  }
  if (s.unit !== 'money') return null
  var money = Number(l.budgetMoney)
  if (!(money > 0) || amount < money) return null
  return { kind: 'money', threshold: money, amount: amount, currency: (today && today.currency) || '' }
}

function budgetAlertKey(dateKey, agentId, kind, threshold) {
  return (
    BUDGET_KEY_PREFIX +
    String(dateKey || '') +
    '.' +
    String(agentId || '-') +
    '.' +
    String(kind || 'money') +
    '.' +
    String(threshold)
  )
}
