// 角色与台词（从挂件线移植，台词原样保留）。
//
// 每个角色 = 立绘 + 名字 + 自己的语句池。dock 不导入第三方角色：
// 只有内置的六个，避免把「角色」变成任意资源加载通道。
//
// `pick` 是切换到这个角色时说的第一句（原挂件叫「挑经句」，大字显示）；
// `lines` 是点击 / 随机说的时候抽的池子。

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
      '你说免费鸡蛋啊...最近卖完了...',
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
      '科研K3.1中...',
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
