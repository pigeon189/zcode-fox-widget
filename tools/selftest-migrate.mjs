// fox-dock 2.0 迁移引导自测（独立进程 + 隔离 ZCODE_HOME）。
//
// 为什么独立文件：lib/migrate.mjs / lib/update.mjs / lib/balance.mjs 的路径常量在
// import 时就从 ZCODE_HOME 求值，直接在主 selftest 进程里 import 会写到真实数据
// 目录（与 tools/selftest-update.mjs 同法）。
//
// 与 ZCode 线（main）版本的差异：启动项用例通过 opts.startupDir 注入临时目录
// （本线 watchdog-cli 的 startupDir() 直读进程环境）、VBS 名是
// fox-widget-watchdog.vbs、服务端自启交接动作名是 watchdog-uninstall。
//
// 覆盖（MIGRATE-TO-FOX-DOCK-2.md §4-7 的自动化回归清单）：
//   · parseRemoteManifest：形状 / 坏 JSON / eol；
//   · validateMigrationUrl：GitHub Releases 白名单（http / 坏主机 / userinfo /
//     非 443 端口 / 路径穿越 / 三个资产域）；
//   · validateMigrationOffer：stable-only（2.0.0-pre.* 一律拒）/ 字段上限 /
//     纯文本 / minPluginVersion 门槛 / costs 不可省略；
//   · pickBestManifest：多镜像取版本最高、同版本取带合法 migration 的那份；
//   · probeMigrationOffer（注入 fetchImpl，不出网）：offer 落状态 / 24h 节流 /
//     kill switch / 全失败静默 / eol 捕获 / force 绕过节流；
//   · migrationPreflight：config 只报键名不报值 / 凭据只报数量 / dock 在线与版本
//     （本机 127.0.0.1 桩）/ 数据体积排除可重建目录 / 启动项归属 / **只读**（前后
//     目录快照逐字节一致）；
//   · runUpdate 的 eol 哨兵：eol:true 拦下载；无 eol 字段时普通更新照常
//     （注入整包 + 测试密钥签名，与 selftest-update 同法）；
//   · 普通更新回归：checkForUpdate 对带 migration 块的清单行为不变（版本比较
//     只看 version 字段）；
//   · widget-state：migrationSkip / migrationCompleted 与 updateSkip 独立；
//   · 偏好落盘核对：defaultCorner / alerts 已入 widget-state（§4-1 验收）；
//   · 源码钉：前端两步按钮 / 服务端 migrate 动作 / 主进程 openExternal 白名单。
//
//   node tools/selftest-migrate.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-migrate-test-'))
// 路径常量在 import 时就从 CODEBUDDY_HOME / FOX_WIDGET_DATA_DIR 求值（与
// selftest-update.mjs 同法）；宿主注入的数据目录指针一并删掉，保证完全隔离
process.env.CODEBUDDY_HOME = TMP
process.env.FOX_WIDGET_DATA_DIR = path.join(TMP, 'plugin-data')
fs.mkdirSync(process.env.FOX_WIDGET_DATA_DIR, { recursive: true })
delete process.env.CODEBUDDY_PLUGIN_DATA
// 探测用例需要「更新检查未被禁用」的默认环境；kill switch 只在单条用例里显式传 env
delete process.env.WHALE_DISABLE_UPDATE_CHECK
delete process.env.FOX_WIDGET_DISABLE_MIGRATION

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail !== undefined ? '  — ' + detail : ''))
}

const M = await import('../lib/migrate.mjs')
const U = await import('../lib/update.mjs')
const B = await import('../lib/balance.mjs')

function fakeRes(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : String(headers[String(k).toLowerCase()])) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    },
  }
}

// 合法 offer 的样板：各字段都过 validateMigrationOffer
const GOOD_OFFER = {
  product: 'fox-dock',
  version: '2.0.0',
  channel: 'stable',
  notesUrl: 'https://github.com/pigeon189/zcode-fox-widget/releases/download/dock-v2.0.0/release-notes-2.0.0.html',
  downloadUrl: 'https://github.com/pigeon189/zcode-fox-widget/releases/tag/dock-v2.0.0',
  summary: 'fox-dock 2.0 正式版：独立桌宠 + 权限接管 + 旧数据导入',
  highlights: ['独立程序，不再依赖宿主插件运行', '旧角色/音效可导入'],
  costs: ['自定义气泡图片/模板不自动迁移', '默认角落语义由「出生角」变为「失焦兜底角」'],
}

// ---------- 1. parseRemoteManifest ----------
{
  const ok = M.parseRemoteManifest(JSON.stringify({ version: '1.3.4', migration: GOOD_OFFER, eol: true }))
  check(
    'parseRemoteManifest：version / migration / eol 都带出',
    ok.version === '1.3.4' && ok.eol === true && ok.migration && ok.migration.version === '2.0.0',
    JSON.stringify(ok && { version: ok.version, eol: ok.eol })
  )
  const noMig = M.parseRemoteManifest('{"version":"1.3.4"}')
  check('parseRemoteManifest：没有 migration 时为 null（1.x 行为不变的前提）', noMig.version === '1.3.4' && noMig.migration === null && noMig.eol === false)
  const badJson = M.parseRemoteManifest('not json')
  check('parseRemoteManifest：坏 JSON → 全 null（不抛异常）', badJson.version === null && badJson.migration === null)
  const arr = M.parseRemoteManifest('[1,2]')
  const noVer = M.parseRemoteManifest('{"migration":{}}')
  check(
    'parseRemoteManifest：非对象 / 缺版本都判不出',
    arr.version === null && noVer.version === null && noVer.migration !== null,
    JSON.stringify({ arr: arr.version, noVer: noVer.version })
  )
  check(
    'parseRemoteManifest：eol 只认显式 true（缺字段 = false）',
    M.parseRemoteManifest('{"version":"1.0.0","eol":"yes"}').eol === false
  )
}

// ---------- 2. validateMigrationUrl ----------
{
  const good = (u) => {
    const r = M.validateMigrationUrl(u)
    return r.ok ? r.url : null
  }
  const bad = (u) => !M.validateMigrationUrl(u).ok
  check(
    'URL 白名单：github.com 与两个 release 资产域可过',
    !!good('https://github.com/pigeon189/zcode-fox-widget/releases/tag/dock-v2.0.0') &&
      !!good('https://objects.githubusercontent.com/pigeon189/zcode-fox-widget/releases/download/dock-v2.0.0/x.html') &&
      !!good('https://release-assets.githubusercontent.com/pigeon189/zcode-fox-widget/releases/download/dock-v2.0.0/x.html')
  )
  check(
    'URL 白名单：http / 坏主机 / userinfo / 非 443 端口 / 路径穿越 / 错路径前缀全拒',
    bad('http://github.com/pigeon189/zcode-fox-widget/releases/tag/dock-v2.0.0') &&
      bad('https://evil.com/pigeon189/zcode-fox-widget/releases/tag/dock-v2.0.0') &&
      bad('https://raw.githubusercontent.com/pigeon189/zcode-fox-widget/main/README.md') &&
      bad('https://user:pass@github.com/pigeon189/zcode-fox-widget/releases/tag/dock-v2.0.0') &&
      bad('https://github.com:8443/pigeon189/zcode-fox-widget/releases/tag/dock-v2.0.0') &&
      bad('https://github.com/pigeon189/zcode-fox-widget/releases/../other') &&
      bad('https://github.com/other/repo/releases/tag/dock-v2.0.0')
  )
  check('URL 白名单：https 默认（无端口）可过', !!good(GOOD_OFFER.notesUrl))
}

// ---------- 3. validateMigrationOffer ----------
{
  const ok = M.validateMigrationOffer(GOOD_OFFER, { current: '1.3.4' })
  check(
    'offer 校验：合法 stable 全过，返回归一化 offer',
    ok.ok === true && ok.offer.version === '2.0.0' && ok.offer.channel === 'stable' &&
      ok.offer.notesUrl === GOOD_OFFER.notesUrl && ok.offer.costs.length === 2,
    JSON.stringify(ok && ok.ok)
  )
  const bad = (mutate, label, current) => {
    const o = { ...GOOD_OFFER }
    mutate(o)
    return check('offer 校验：' + label, M.validateMigrationOffer(o, { current: current || '1.3.4' }).ok === false)
  }
  bad((o) => (o.version = '2.0.0-pre.3'), '2.0.0-pre.* 预发布被拒')
  bad((o) => (o.version = '2.0.0-rc.1'), '2.0.0-rc.* 被拒')
  bad((o) => (o.version = '2.0.1'), '后续版本 2.0.1 被拒（要显式改常量并重新评审）')
  bad((o) => (o.channel = 'prerelease'), 'channel=prerelease 被拒')
  bad((o) => (o.product = 'other'), 'product 不是 fox-dock 被拒')
  bad((o) => delete o.notesUrl, '缺 notesUrl 被拒')
  bad((o) => (o.downloadUrl = 'http://github.com/pigeon189/zcode-fox-widget/releases/tag/dock-v2.0.0'), 'downloadUrl 非 https 被拒')
  bad((o) => (o.summary = 'x'.repeat(81)), 'summary 超 80 字被拒')
  bad((o) => (o.summary = '<b>促销</b>'), 'summary 含 HTML 被拒')
  bad((o) => delete o.costs, 'costs 缺失被拒（代价说明不能省略）')
  bad((o) => (o.costs = ['1', '2', '3', '4']), 'costs 超 3 条被拒')
  bad((o) => (o.costs = ['x'.repeat(41)]), 'costs 单条超 40 字被拒')
  bad((o) => (o.highlights = ['1', '2', '3', '4']), 'highlights 超 3 条被拒')
  bad((o) => (o.minPluginVersion = '99.0.0'), '本机版本低于 minPluginVersion 被拒')
  bad((o) => (o.minPluginVersion = 'not-a-version'), 'minPluginVersion 形状坏被拒')
  check(
    'offer 校验：minPluginVersion 门槛按当前版本放行',
    M.validateMigrationOffer({ ...GOOD_OFFER, minPluginVersion: '1.3.5' }, { current: '1.3.4' }).ok === false
  )
  check(
    'offer 校验：highlights 可省略（costs 不可）',
    (() => {
      const o = { ...GOOD_OFFER }
      delete o.highlights
      return M.validateMigrationOffer(o, { current: '1.3.4' }).ok === true
    })()
  )
  check('offer 校验：migration 块非对象直接拒', M.validateMigrationOffer('x', { current: '1.3.4' }).ok === false && M.validateMigrationOffer(null).ok === false)
}

// ---------- 4. pickBestManifest（多镜像取舍） ----------
{
  const pre = {
    product: 'fox-dock',
    version: '2.0.0-pre.3',
    channel: 'stable',
    notesUrl: GOOD_OFFER.notesUrl,
    downloadUrl: GOOD_OFFER.downloadUrl,
    summary: '预发布',
    costs: ['代价'],
  }
  const best = M.pickBestManifest(
    [
      { version: '1.3.4', migration: null },
      { version: '1.3.4', migration: GOOD_OFFER },
      { version: '1.3.0', migration: GOOD_OFFER },
    ],
    { current: '1.3.4' }
  )
  check(
    '多镜像取舍：取版本最高；同版本取带合法 migration 的那份',
    best && best.version === '1.3.4' && best.offer && best.offer.version === '2.0.0',
    JSON.stringify(best && { version: best.version, hasOffer: !!best.offer })
  )
  const staleMirror = M.pickBestManifest(
    [
      { version: '1.3.0', migration: GOOD_OFFER },
      { version: '1.3.0', migration: null },
    ],
    { current: '1.3.4' }
  )
  check(
    '多镜像取舍：旧镜像没有 migration 时不会把新镜像的 offer 覆盖掉',
    staleMirror && staleMirror.version === '1.3.0' && !!staleMirror.offer
  )
  const onlyPre = M.pickBestManifest([{ version: '1.3.4', migration: pre }], { current: '1.3.4' })
  check(
    '多镜像取舍：只有 pre 清单时 offer 为 null 且给出原因',
    onlyPre && onlyPre.offer === null && /stable|version/.test(String(onlyPre.reason)),
    JSON.stringify(onlyPre && onlyPre.reason)
  )
  check('多镜像取舍：空列表 → null', M.pickBestManifest([]) === null && M.pickBestManifest(null) === null)
  check(
    '多镜像取舍：eol 哨兵与合法 offer 绑定（裸 eol 清单不点亮）',
    (() => {
      const withOffer = M.pickBestManifest([{ version: '1.3.4', migration: GOOD_OFFER, eol: true }], { current: '1.3.4' })
      const bareEol = M.pickBestManifest([{ version: '1.3.4', migration: null, eol: true }], { current: '1.3.4' })
      const plain = M.pickBestManifest([{ version: '1.3.4', migration: GOOD_OFFER }], { current: '1.3.4' })
      return withOffer.eol === true && bareEol.eol === false && plain.eol === false
    })()
  )
}

// ---------- 5. probeMigrationOffer（注入 fetch，不出网） ----------
{
  // 环境干净（文件头已 delete 两个 kill switch）；状态目录是 TMP 派生的数据目录
  const manifest = (version, migration, eol) => JSON.stringify({ version, migration, eol })
  const endpoints = [
    { name: 'stale', url: 'https://ghproxy.net/stale' },
    { name: 'fresh', url: 'https://api.github.com/fresh' },
  ]
  let calls = 0
  const fetchImpl = async (url) => {
    calls++
    if (String(url).includes('ghproxy.net')) return fakeRes(manifest('1.3.0', GOOD_OFFER))
    return fakeRes(manifest('1.3.4', GOOD_OFFER, false))
  }
  const r1 = await M.probeMigrationOffer({ endpoints, fetchImpl, current: '1.3.4' })
  const probe1 = U.readUpdateState().migrationProbe
  check(
    '探测：offer 落进 update-state 的 migrationProbe（陈旧镜像不影响结论）',
    r1.ok === true && !!probe1 && probe1.manifestVersion === '1.3.4' && probe1.offer && probe1.offer.version === '2.0.0' && probe1.eol === false,
    JSON.stringify(probe1 && { v: probe1.manifestVersion, offer: !!probe1.offer })
  )
  check('探测：带探测源名', probe1.source === 'fresh', String(probe1.source))

  // 24h 节流：第二次调用不复发请求
  calls = 0
  const r2 = await M.probeMigrationOffer({ endpoints, fetchImpl })
  check(
    '探测：24h 内最多一次（节流生效且不重复写）',
    calls === 0 && r2.skipped === 'throttled' && U.readUpdateState().migrationProbe.at === probe1.at
  )
  // force 绕过节流（预检/调试用）
  calls = 0
  const r2f = await M.probeMigrationOffer({ endpoints, fetchImpl, force: true, current: '1.3.4' })
  check('探测：force=true 可绕过 24h 节流', calls === 2 && r2f.ok === true)

  // kill switch：两个环境变量都要能关
  const off1 = await M.probeMigrationOffer({ endpoints, fetchImpl, force: true, env: { FOX_WIDGET_DISABLE_MIGRATION: '1' } })
  const off2 = await M.probeMigrationOffer({ endpoints, fetchImpl, force: true, env: { WHALE_DISABLE_UPDATE_CHECK: '1' } })
  check(
    '探测：FOX_WIDGET_DISABLE_MIGRATION / WHALE_DISABLE_UPDATE_CHECK 都能关闭',
    off1.skipped === 'disabled-by-migration-env' && off2.skipped === 'disabled-by-update-env',
    JSON.stringify([off1.skipped, off2.skipped])
  )

  // eol 哨兵捕获：只认「同一份清单带合法 migration offer」的宣告（安全审查 P2-1）
  await U.writeUpdateState({ migrationProbe: null })
  const eolNoOffer = await M.probeMigrationOffer({
    endpoints,
    force: true,
    current: '1.3.4',
    fetchImpl: async () => fakeRes(manifest('1.3.4', null, true)),
  })
  check(
    '探测：裸 eol:true（无合法 migration 块）不点亮哨兵',
    eolNoOffer.ok === true && U.readUpdateState().migrationProbe.eol === false
  )
  const eolProbe = await M.probeMigrationOffer({
    endpoints,
    force: true,
    current: '1.3.4',
    fetchImpl: async () => fakeRes(manifest('1.3.4', GOOD_OFFER, true)),
  })
  check('探测：eol 与合法 offer 同清单 → 哨兵点亮', eolProbe.ok === true && U.readUpdateState().migrationProbe.eol === true)

  // 去粘滞：点亮后下一轮探测失败 → eol 立即回落 false（不再沿用旧值）
  const failProbe2 = await M.probeMigrationOffer({
    endpoints,
    force: true,
    current: '1.3.4',
    fetchImpl: async () => {
      throw new Error('connect timeout')
    },
  })
  check(
    '探测：eol 无粘滞——下一轮全失败即解除',
    failProbe2.ok === false && U.readUpdateState().migrationProbe.eol === false
  )

  // 全部源失败：静默（不抛）、记原因、无 offer
  const failProbe = await M.probeMigrationOffer({
    endpoints,
    force: true,
    current: '1.3.4',
    fetchImpl: async () => {
      throw new Error('connect timeout')
    },
  })
  const failState = U.readUpdateState().migrationProbe
  check(
    '探测：全部源失败静默（不抛异常）、offer 为空、原因落状态',
    failProbe.ok === false && failState.offer === null && /失败|没有/.test(String(failState.reason)),
    JSON.stringify(failState && failState.reason)
  )

  // 探测预算：每个源的超时按剩余预算递减（源码钉：不传 timeoutMs 时维持原超时）
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'update.mjs'), 'utf8')
  check('探测预算：fetchVersionText 支持 timeoutMs 注入且缺省不变', /opts\.timeoutMs \|\| CHECK_TIMEOUT_MS/.test(src))
  const migSrc = fs.readFileSync(path.join(process.cwd(), 'lib', 'migrate.mjs'), 'utf8')
  check('探测预算：逐源递减到 8s 总预算内', migSrc.includes('PROBE_BUDGET_MS - (Date.now() - started)'))

  // 节流门控不 spawn：新鲜的 probe 状态下 spawnMigrationProbe 必须直接跳过
  //（真 spawn 会带真实网络，测试只盯门控逻辑本身）
  await U.writeUpdateState({ migrationProbe: { ...probe1, at: Date.now() } })
  check(
    'SessionStart 探测：24h 内已探测时不 spawn 子进程',
    M.spawnMigrationProbe({ env: {} }) === false
  )
  check(
    'SessionStart 探测：kill switch 时不 spawn 子进程',
    M.spawnMigrationProbe({ env: { FOX_WIDGET_DISABLE_MIGRATION: '1' } }) === false
  )
}

// ---------- 6. migrationPreflight（只读 + 不泄密） ----------
function walkMap(root, prefix = '') {
  const out = new Map()
  let entries = []
  try {
    entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
  } catch (err) {
    return out
  }
  for (const e of entries) {
    const rel = prefix ? prefix + '/' + e.name : e.name
    const abs = path.join(root, rel)
    if (e.isDirectory()) {
      out.set(rel + '/', null)
      for (const [k, v] of walkMap(root, rel)) out.set(k, v)
    } else if (e.isFile()) {
      out.set(rel, String(fs.readFileSync(abs)))
    }
  }
  return out
}

{
  const dataDir = path.join(TMP, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  // config.json：带一个假密钥形状的值，验收「只报键名与数量、绝不回值」。
  // 这是测试桩值（不是可用凭据），但仍不进任何断言输出。
  const fakeKey = 'sk-test-' + 'x'.repeat(20)
  const cfgFile = path.join(dataDir, 'config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ vendorKeys: { deepseek: fakeKey, glm: fakeKey }, relayAuth: { packy: fakeKey }, apiKey: fakeKey, platformToken: fakeKey, usageMode: 'ledger' }), 'utf8')
  fs.writeFileSync(path.join(dataDir, 'widget-state.json'), JSON.stringify({ scale: 1.1, defaultCorner: 'tl' }), 'utf8')
  fs.mkdirSync(path.join(dataDir, 'roles'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'roles', 'a.png'), Buffer.alloc(2048, 7))
  // 可重建大头：desktop-runtime/ 不计体积；overlay-profile-* 与 update/ 同理
  fs.mkdirSync(path.join(dataDir, 'desktop-runtime'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'desktop-runtime', 'electron.exe'), Buffer.alloc(4096, 1))
  fs.mkdirSync(path.join(dataDir, 'overlay-profile-xyz'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'overlay-profile-xyz', 'p'), Buffer.alloc(4096, 1))

  // 启动项用临时目录注入（本线 startupDir() 直读进程环境，不能用 env 覆盖）
  const startupDirTmp = path.join(TMP, 'startup')
  fs.mkdirSync(startupDirTmp, { recursive: true })
  fs.writeFileSync(path.join(startupDirTmp, 'fox-widget-watchdog.vbs'), "'x", 'utf8')
  fs.writeFileSync(path.join(startupDirTmp, 'fox-dock.vbs'), "'x", 'utf8')

  const before = walkMap(TMP)
  const pre = await M.migrationPreflight({ dataDir, configFile: cfgFile, env: {}, startupDir: startupDirTmp, dockTimeoutMs: 300 })
  const after = walkMap(TMP)

  check(
    '预检：config 只报键名与布尔值，密钥值绝不出现',
    pre.config.readable === true &&
      pre.config.keys.join(',') === 'apiKey,platformToken,relayAuth,usageMode,vendorKeys' &&
      pre.config.credentials.vendorKeys === 2 &&
      pre.config.credentials.relayAuth === 1 &&
      pre.config.credentials.hasApiKey === true,
    JSON.stringify(pre.config.keys)
  )
  check('预检：结果文本里搜不到密钥值（连掩码都不给）', !JSON.stringify(pre).includes(fakeKey))
  check(
    '预检：dock 未装 → online=false、versionOk=false、checks.dockReady=false、整体 ok=false',
    pre.dock.online === false && pre.dock.versionOk === false && pre.checks.dockReady === false && pre.ok === false,
    JSON.stringify(pre.dock)
  )
  check(
    '预检：数据体积只数归档范围（排除 desktop-runtime / overlay-profile-*）',
    (() => {
      // 专建一个目录做口径核对：只有一个 2048 字节的计费文件 + 一个 8192 字节的
      // 可重建目录，期望体积恰好等于前者
      const sized = path.join(TMP, 'sizedata')
      fs.mkdirSync(path.join(sized, 'desktop-runtime'), { recursive: true })
      fs.writeFileSync(path.join(sized, 'a.png'), Buffer.alloc(2048, 7))
      fs.writeFileSync(path.join(sized, 'desktop-runtime', 'electron.exe'), Buffer.alloc(8192, 1))
      return M.migrationPreflight({ dataDir: sized, configFile: cfgFile, env: {}, startupDir: startupDirTmp, dockTimeoutMs: 300 }).then((p) => {
        fs.rmSync(sized, { recursive: true, force: true })
        return p.data.bytes === 2048 && p.data.files === 1
      })
    })()
  )
  check('预检：磁盘余量有数且判定为足够', typeof pre.disk.freeBytes === 'number' && pre.disk.enough === true)
  check('预检：只读——前后目录快照一致', before.size === after.size && [...before.keys()].every((k) => before.get(k) === after.get(k)), before.size + ' vs ' + after.size)

  // dock 在线桩：本机 127.0.0.1 起一个 /health 回 fox-dock 2.0.0 的服务。
  // daemon.lock 的路径口径与 lib/dock-shim.mjs 一致：<FOX_DOCK_DATA>/fox-dock/
  const dockPort = 39000 + (process.pid % 900)
  const dockEnv = { LOCALAPPDATA: path.join(TMP, 'dockapp'), FOX_DOCK_DATA: path.join(TMP, 'dockdata') }
  const lockFile = path.join(dockEnv.FOX_DOCK_DATA, 'fox-dock', 'daemon.lock')
  fs.mkdirSync(path.dirname(lockFile), { recursive: true })
  fs.writeFileSync(lockFile, JSON.stringify({ port: dockPort, token: 'test-token' }), 'utf8')
  const dockServer = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(req.url === '/health' ? { ok: true, app: 'fox-dock', version: '2.0.0' } : {}))
  })
  await new Promise((resolve) => dockServer.listen(dockPort, '127.0.0.1', resolve))
  try {
    const preDock = await M.migrationPreflight({ dataDir, configFile: cfgFile, env: dockEnv, startupDir: startupDirTmp, dockTimeoutMs: 1500 })
    check(
      '预检：dock 在线且版本 ≥2.0.0 → checks.dockReady=true',
      preDock.dock.online === true && preDock.dock.version === '2.0.0' && preDock.dock.versionOk === true && preDock.checks.dockReady === true,
      JSON.stringify(preDock.dock)
    )
    check(
      '预检：config 可读 + 磁盘足 + 无未完成更新 → 整体 ok=true',
      preDock.ok === true,
      JSON.stringify(preDock.checks)
    )
    // 版本不足的 dock：换成回 pre.3 版本号的桩
    const oldServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'fox-dock', version: '2.0.0-pre.3' }))
    })
    await new Promise((resolve) => dockServer.close(resolve))
    await new Promise((resolve) => oldServer.listen(dockPort, '127.0.0.1', resolve))
    try {
      const preOld = await M.migrationPreflight({ dataDir, configFile: cfgFile, env: dockEnv, startupDir: startupDirTmp, dockTimeoutMs: 1500 })
      check('预检：dock 版本低于 2.0.0 → dockReady=false', preOld.dock.online === true && preOld.dock.versionOk === false, JSON.stringify(preOld.dock))
    } finally {
      await new Promise((resolve) => oldServer.close(resolve))
    }
  } finally {
    await new Promise((resolve) => dockServer.close(resolve))
  }

  check(
    '预检：启动文件夹两只 VBS 的归属分别报出（本线 fox-widget-watchdog.vbs）',
    pre.startup.own === true && pre.startup.ownFile === 'fox-widget-watchdog.vbs' &&
      pre.startup.dock === true && pre.startup.dockFile === 'fox-dock.vbs',
    JSON.stringify(pre.startup)
  )
  const emptyStartup = path.join(TMP, 'startup-empty')
  fs.mkdirSync(emptyStartup, { recursive: true })
  const preNoStartup = await M.migrationPreflight({ dataDir, configFile: cfgFile, env: {}, startupDir: emptyStartup, dockTimeoutMs: 300 })
  check('预检：没有启动项时都报 false', preNoStartup.startup.own === false && preNoStartup.startup.dock === false)

  // 上次更新未完成：busy 挂着 → update.pending
  U.writeUpdateState({ busy: true, phase: 'downloading' })
  const preBusy = await M.migrationPreflight({ dataDir, configFile: cfgFile, env: {}, startupDir: emptyStartup, dockTimeoutMs: 300 })
  U.writeUpdateState({ busy: false, phase: null })
  check(
    '预检：busy 挂着 → update.pending=true、checks.updateClean=false',
    preBusy.update.pending === true && preBusy.checks.updateClean === false
  )
}

// ---------- 7. runUpdate 的 eol 哨兵 + 普通更新回归 ----------
{
  const testKeys = crypto.generateKeyPairSync('ed25519')
  const testPub = testKeys.publicKey.export({ type: 'spki', format: 'pem' })
  function signedPkg(entries, version) {
    const files = new Map(entries)
    const hashes = {}
    for (const [rel, body] of files) hashes[rel] = crypto.createHash('sha256').update(body).digest('hex')
    const sorted = {}
    for (const k of Object.keys(hashes).sort()) sorted[k] = hashes[k]
    const bytes = Buffer.from(JSON.stringify({ version, files: sorted }, null, 2) + '\n', 'utf8')
    files.set('.release-hashes.json', bytes)
    files.set('.release-hashes.json.sig', Buffer.from(crypto.sign(null, bytes, testKeys.privateKey).toString('base64')))
    return files
  }
  const mkRoot = (name) => {
    const root = path.join(TMP, name)
    fs.mkdirSync(path.join(root, '.codebuddy-plugin'), { recursive: true })
    fs.writeFileSync(path.join(root, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ version: '1.3.4' }), 'utf8')
    return root
  }
  const pkg = () =>
    signedPkg(
      [
        ['.codebuddy-plugin/plugin.json', Buffer.from('{"version":"9.9.9"}')],
        ['lib/server.mjs', Buffer.from('new server')],
      ],
      '9.9.9'
    )
  const pub = { publicKey: testPub }
  // runUpdate 的 eol 门槛会做 tag 真实性核对（verifyReleaseTag）：注入 fetch 桩
  // 模拟「tag 存在 / 不存在」，不出网
  const tagExists = { fetchImpl: async (url) => (String(url).includes('plugin.json') ? fakeRes('{"version":"1.3.4"}') : fakeRes('not found', 404)) }
  const tagMissing = { fetchImpl: async () => fakeRes('not found', 404) }

  // eol:true（与合法 offer 同清单、版本核对通过）→ 下载前只读拦截
  U.writeUpdateState({ busy: false, latest: '9.9.9', available: true, migrationProbe: { at: Date.now(), manifestVersion: '1.3.4', eol: true, offer: GOOD_OFFER } })
  const rootEol = mkRoot('eol-root')
  const rEol = await U.runUpdate({ files: pkg(), roots: [rootEol], ...pub, ...tagExists })
  check(
    'eol 哨兵：宣告真实且版本可核对时拦截下载并给出迁移指引',
    rEol.ok === false && /eol|迁移/.test(String(rEol.error)),
    String(rEol.error)
  )
  check('eol 哨兵：拦截不落盘（安装目录没有新文件）', fs.readFileSync(path.join(rootEol, '.codebuddy-plugin', 'plugin.json'), 'utf8').includes('1.3.4'))

  // 伪造 eol：版本没有真实 tag → 哨兵当场解除，更新照常放行（安全审查 P2-1）
  U.writeUpdateState({ busy: false, latest: '9.9.9', available: true, migrationProbe: { at: Date.now(), manifestVersion: '99.0.0', eol: true, offer: GOOD_OFFER } })
  const rootForge = mkRoot('eol-forge-root')
  const rForge = await U.runUpdate({ files: pkg(), roots: [rootForge], ...pub, ...tagMissing })
  const forgeProbe = U.readUpdateState().migrationProbe
  check(
    'eol 哨兵：宣告版本无真实 tag → 解除锁定并放行更新（伪造被拆穿）',
    rForge.ok === true && forgeProbe.eol === false,
    JSON.stringify({ ok: rForge.ok, eol: forgeProbe.eol })
  )

  // eol 与 offer 不在同一份清单（offer 为 null）→ 门槛不触发（旧状态文件兼容）
  U.writeUpdateState({ busy: false, latest: '9.9.9', available: true, migrationProbe: { at: Date.now(), manifestVersion: '1.3.4', eol: true, offer: null } })
  const rootNoOffer = mkRoot('eol-nooffer-root')
  const rNoOffer = await U.runUpdate({ files: pkg(), roots: [rootNoOffer], ...pub, ...tagExists })
  check('eol 哨兵：eol 无 offer 支撑时不拦（探测侧已不再产生这种状态）', rNoOffer.ok === true)

  // 无 eol 字段 → 普通更新照常（回归：迁移代码不改变 1.x 更新）
  U.writeUpdateState({ busy: false, latest: '9.9.9', available: true, migrationProbe: { at: Date.now(), manifestVersion: '1.3.4', eol: false, offer: GOOD_OFFER } })
  const rootOk = mkRoot('eol-off-root')
  const rOk = await U.runUpdate({ files: pkg(), roots: [rootOk], ...pub, ...tagExists })
  check(
    'eol 哨兵：无 eol 时普通更新照常完成（offer 在场也不影响）',
    rOk.ok === true && U.readUpdateState().phase === 'done',
    JSON.stringify({ ok: rOk.ok, phase: U.readUpdateState().phase })
  )
  // migrationProbe 字段缺整个 → 同样不拦（旧状态文件兼容）
  U.writeUpdateState({ busy: false, latest: '9.9.9', available: true, migrationProbe: null })
  const rNone = await U.runUpdate({ files: pkg(), roots: [rootOk], ...pub, ...tagExists })
  check('eol 哨兵：migrationProbe 缺失时不拦（旧状态文件兼容）', rNone.ok === true)
  U.writeUpdateState({ busy: false, latest: null, available: false, migrationProbe: null, phase: null, error: null })

  // 普通更新回归：清单带 migration 块时 checkForUpdate 行为不变（版本比较只看 version）
  const eps = [{ name: 'mig-manifest', url: 'https://ghproxy.net/x', pick: U.parsePluginJsonVersion }]
  const st = await U.checkForUpdate({
    current: '1.3.4',
    endpoints: eps,
    verifyTag: false,
    fetchImpl: async () => fakeRes(JSON.stringify({ version: '1.3.5', migration: GOOD_OFFER })),
  })
  check(
    '普通更新回归：带 migration 块的清单照常报「有新版」（1.x 更新不被迁移字样挡住）',
    st.available === true && st.latest === '1.3.5',
    JSON.stringify({ latest: st.latest, available: st.available })
  )
}

// ---------- 8. widget-state：migrationSkip / migrationCompleted 独立存储 ----------
{
  B.writeWidgetState({ updateSkip: '1.3.5', migrationSkip: '2.0.0', migrationCompleted: null })
  const ws = B.readWidgetState()
  check(
    '状态白名单：migrationSkip 与 updateSkip 互不干扰',
    ws.updateSkip === '1.3.5' && ws.migrationSkip === '2.0.0' && ws.migrationCompleted === null,
    JSON.stringify({ updateSkip: ws.updateSkip, migrationSkip: ws.migrationSkip })
  )
  B.writeWidgetState({ migrationSkip: null, migrationCompleted: '2.0.0' })
  const ws2 = B.readWidgetState()
  check(
    '状态白名单：migrationCompleted 可写、migrationSkip 可清',
    ws2.migrationSkip === null && ws2.migrationCompleted === '2.0.0' && ws2.updateSkip === '1.3.5'
  )
  check(
    '状态白名单：非法形状被忽略',
    B.writeWidgetState({ migrationSkip: 'latest', migrationCompleted: ['x'] }).migrationCompleted === '2.0.0' &&
      B.readWidgetState().migrationSkip === null
  )
  B.writeWidgetState({ updateSkip: null, migrationCompleted: null })
}

// ---------- 9. 偏好落盘核对（MIGRATE-TO-FOX-DOCK-2.md §4-1 验收） ----------
{
  const back = B.writeWidgetState({ defaultCorner: 'tl', alerts: { quotaPct: 80, moneyAlert: 30, budgetToday: 12.5 } })
  const ws = B.readWidgetState()
  check(
    '偏好落盘：defaultCorner 已入 widget-state（dock 导入 fallbackCorner 的数据源）',
    back.defaultCorner === 'tl' && ws.defaultCorner === 'tl'
  )
  check(
    '偏好落盘：alerts 阈值已入 widget-state（quotaPct/moneyAlert/budgetToday）',
    ws.alerts && ws.alerts.quotaPct === 80 && ws.alerts.moneyAlert === 30 && ws.alerts.budgetToday === 12.5,
    JSON.stringify(ws.alerts)
  )
  check(
    '偏好落盘：非法 defaultCorner 被拒',
    B.writeWidgetState({ defaultCorner: 'center' }).defaultCorner === 'tl'
  )
  B.writeWidgetState({ defaultCorner: 'br', alerts: { quotaPct: 0, moneyAlert: 0, budgetToday: 0 } })
}

// ---------- 10. 源码钉（浏览器/桌面侧行为只能在真机构造的，按源码断言） ----------
{
  const widgetSrc = fs.readFileSync(path.join(process.cwd(), 'lib', 'widget.js'), 'utf8')
  check(
    '前端：两步按钮文案与状态机在位（查看说明后升级 → 立即升级）',
    widgetSrc.includes("'查看说明后升级'") && widgetSrc.includes("'立即升级'") &&
      widgetSrc.includes('migrationArmedFor') && widgetSrc.includes("openMigrationNotes"),
    'armed 状态只在内存；offer 版本变化自动失效'
  )
  check(
    '前端：迁移跳过走 migrate-skip（与 1.x 的 skip 分开）',
    widgetSrc.includes("postUpdateAction('migrate-skip')")
  )
  check(
    '前端：自启交接按钮走 watchdog-uninstall（本线命名，不碰 fox-dock 的启动器）',
    widgetSrc.includes("postUpdateAction('watchdog-uninstall')")
  )
  check(
    '前端：说明页打开失败不武装（没有静默放行）',
    /whaleDesktop\.openExternal/.test(widgetSrc) && /浏览器拦截了弹窗/.test(widgetSrc) &&
      /noopener/.test(widgetSrc)
  )
  check(
    '前端：迁移提醒文案不出现「点一下直接升级」诱导（注释除外）',
    widgetSrc.replace(/\/\/[^\n]*/g, '').includes('点菜单「更新」查看说明后再升级') &&
      !widgetSrc.replace(/\/\/[^\n]*/g, '').includes('点一下直接升级')
  )
  const serverSrc = fs.readFileSync(path.join(process.cwd(), 'lib', 'server.mjs'), 'utf8')
  check(
    '服务端：migrate 动作只做预检/引导，不调用 runUpdate',
    /action === 'migrate'/.test(serverSrc) && /migrationPreflight\(\{\}\)/.test(serverSrc),
    '§8 红线：2.0 迁移不走 1.x 下载/替换路径'
  )
  check(
    '服务端：自启交接动作名是 watchdog-uninstall 且只撤自己的 VBS',
    /action === 'watchdog-uninstall'/.test(serverSrc) && /cmdWatchdogUninstall\(\)/.test(serverSrc)
  )
  check(
    '服务端：GET 触发节流探测（fire-and-forget）',
    /maybeProbeMigration\(\)/.test(serverSrc)
  )
  const mainSrc = fs.readFileSync(path.join(process.cwd(), 'desktop', 'main.cjs'), 'utf8')
  check(
    '主进程：open-external 按 https + GitHub Releases 白名单校验（纵深防御）',
    /whale:open-external/.test(mainSrc) && mainSrc.includes('release-assets.githubusercontent.com') &&
      mainSrc.includes('/pigeon189/zcode-fox-widget/releases/')
  )
  const preloadSrc = fs.readFileSync(path.join(process.cwd(), 'desktop', 'preload.cjs'), 'utf8')
  check('preload：openExternal 暴露给页面（invoke，可拿到布尔返回）', /openExternal/.test(preloadSrc) && /whale:open-external/.test(preloadSrc))
  const cliSrc = fs.readFileSync(path.join(process.cwd(), 'lib', 'cli.mjs'), 'utf8')
  check('CLI：migrate --check 只读 + migrate-probe 隐藏命令在位', /argv\[0\] !== '--check'/.test(cliSrc) && cliSrc.includes('migrate-probe'))
  const autoSrc = fs.readFileSync(path.join(process.cwd(), 'lib', 'autostart.mjs'), 'utf8')
  check('SessionStart：迁移探测以 detached 子进程接入（不拖慢钩子）', /spawnMigrationProbe\(\)/.test(autoSrc))
  const watchdogSrc = fs.readFileSync(path.join(process.cwd(), 'lib', 'watchdog-cli.mjs'), 'utf8')
  check(
    'watchdog-cli：VBS 名与启动目录已导出（预检复用，不做文件操作）',
    /export const VBS_NAME = 'fox-widget-watchdog\.vbs'/.test(watchdogSrc) &&
      /export function startupDir\(\)/.test(watchdogSrc) &&
      /export function vbsFile\(\)/.test(watchdogSrc)
  )
}

fs.rmSync(TMP, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log('\n迁移引导自检：' + (results.length - failed.length) + '/' + results.length + ' 通过')
process.exit(failed.length ? 1 : 0)
