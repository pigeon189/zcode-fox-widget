// 版本更新内核单测（独立进程 + 隔离 CODEBUDDY_HOME）。
//
// 为什么单独一个文件：lib/update.mjs 与 lib/balance.mjs 的路径常量在 import 时
// 就从 CODEBUDDY_HOME / FOX_WIDGET_DATA_DIR 求值，直接在主 selftest 进程里 import
// 会写到真实数据目录。这里先把环境变量指到临时目录再 import（与 selftest 的账本
// 子进程同法）。
//
// 覆盖：版本比较 / 出站白名单守卫 / tar.gz 解包（含中文名与路径穿越）/ 落盘计划与
// 清理（有 manifest、无 manifest 非 git、无 manifest 的 git 工作区三种）/ 跳过标记
// 读写 / 注入式远端检查（成功、回退、全失败）/ 注入式整包更新（成功、版本不符、
// 重复触发）。
//
//   node tools/selftest-update.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-update-test-'))
process.env.CODEBUDDY_HOME = TMP
process.env.FOX_WIDGET_DATA_DIR = path.join(TMP, 'plugin-data')
fs.mkdirSync(process.env.FOX_WIDGET_DATA_DIR, { recursive: true })
// 关键：清掉可能从父进程继承来的旧变量，避免子进程写到真实数据目录 / 复用真实服务
delete process.env.CODEBUDDY_PLUGIN_DATA

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail !== undefined ? '  — ' + detail : ''))
}

const U = await import('../lib/update.mjs')
const B = await import('../lib/balance.mjs')

function fakeRes(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : String(headers[String(k).toLowerCase()])) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    },
  }
}

// 流式响应桩：readBodyLimited 在有 res.body.getReader 时走流式分支
function streamRes(chunks, status = 200, headers = {}) {
  let i = 0
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : String(headers[String(k).toLowerCase()])) },
    body: {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { done: true, value: undefined }
            return { done: false, value: new Uint8Array(chunks[i++]) }
          },
          async cancel() {
            i = chunks.length
          },
          releaseLock() {},
        }
      },
    },
  }
}

// ---------- 1. 版本比较 ----------
{
  check(
    'compareVersions：数值段比较（含 v 前缀 / 段数不等 / 非法段按 0）',
    U.compareVersions('1.10.0', '1.9.9') === 1 &&
      U.compareVersions('v1.9.1', '1.10.0') === -1 &&
      U.compareVersions('1.10.0', 'v1.10.0') === 0 &&
      U.compareVersions('1.9', '1.9.0') === 0 &&
      U.compareVersions('2.0.0', '1.99.99') === 1,
    [U.compareVersions('1.10.0', '1.9.9'), U.compareVersions('1.9', '1.9.0')].join(',')
  )
  check(
    'isValidVersion：只收 x.y[.z]',
    U.isValidVersion('1.10.0') && U.isValidVersion('1.2') && !U.isValidVersion('main') && !U.isValidVersion('') && !U.isValidVersion('1.2.3.4')
  )
}

// ---------- 2. 出站守卫 ----------
{
  const bad = (u) => {
    try {
      U.assertUpdateUrl(u)
      return false
    } catch (err) {
      return true
    }
  }
  check(
    '出站守卫：拒绝非白名单主机 / http / 环回 / 私有 / 保留地址',
    bad('https://evil.com/x') && bad('http://ghproxy.net/x') && bad('https://127.0.0.1/x') &&
      bad('https://localhost/x') && bad('https://192.168.1.9/x') && bad('https://10.0.0.1/x') &&
      bad('https://[::1]/x') && bad('https://169.254.1.1/x') && bad('file:///etc/passwd')
  )
  const urls = [...U.buildVersionEndpoints().map((e) => e.url), ...U.buildTarballUrls('1.10.0').map((e) => e.url).filter(Boolean)]
  const allOk = urls.every((u) => {
    try {
      U.assertUpdateUrl(u)
      return true
    } catch (err) {
      return false
    }
  })
  check('出站守卫：全部候选地址都过白名单（' + urls.length + ' 条）', allOk, urls.length + ' urls')
  check(
    '候选链含国内镜像与 jsdelivr 兜底',
    U.buildVersionEndpoints().some((e) => e.name === 'jsdelivr') &&
      U.buildTarballUrls('1.10.0').some((e) => e.name === 'ghproxy') &&
      U.buildTarballUrls('1.10.0').some((e) => e.name === 'jsdelivr' && e.url === null) &&
      U.buildVersionEndpoints().some((e) => e.url.includes('ghproxy.net'))
  )
}

// ---------- 3. tar.gz 解包 ----------
function makeTar(entries) {
  // 最小 tar 写入器（本测试自用）：ustar 头 + 内容补齐 512
  const blocks = []
  const pad = (b) => {
    const rest = (512 - (b.length % 512)) % 512
    return rest ? Buffer.concat([b, Buffer.alloc(rest)]) : b
  }
  for (const e of entries) {
    const body = Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body || '', 'utf8')
    const header = Buffer.alloc(512)
    const name = Buffer.from(e.name, 'utf8')
    name.copy(header, 0, 0, Math.min(name.length, 100))
    header.write('0000644\0', 100, 'utf8')
    header.write('0000000\0', 108, 'utf8')
    header.write('0000000\0', 116, 'utf8')
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8')
    header.write('00000000000\0', 136, 'utf8')
    header.write(e.type || '0', 156, 'utf8')
    header.write('ustar\0', 257, 'utf8')
    header.write('00', 263, 'utf8')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
    blocks.push(header, pad(body))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
const gz = (tarBuf) => zlib.gzipSync(tarBuf)

{
  const tar = makeTar([
    { name: 'repo-abc/', type: '5', body: '' },
    { name: 'repo-abc/.codebuddy-plugin/plugin.json', body: '{"version":"1.11.0"}' },
    { name: 'repo-abc/lib/widget.js', body: 'x'.repeat(1000) },
    { name: 'repo-abc/assets/说明.txt', body: '中文内容' },
    { name: '../evil.js', body: 'nope' },
  ])
  const files = U.extractTarGz(gz(tar))
  check(
    'tar 解包：剥掉顶层目录 + 目录项跳过 + 中文名保留 + 路径穿越丢弃',
    files.size === 3 &&
      files.get('.codebuddy-plugin/plugin.json').toString('utf8') === '{"version":"1.11.0"}' &&
      files.get('lib/widget.js').length === 1000 &&
      files.get('assets/说明.txt').toString('utf8') === '中文内容' &&
      !files.has('../evil.js'),
    [...files.keys()].join(',')
  )
  check('U.parsePluginJsonVersion 从包内清单取版本', U.parsePluginJsonVersion(files.get('.codebuddy-plugin/plugin.json').toString('utf8')) === '1.11.0')
  // 没有顶层目录的包（git archive 形态）也要能装
  const flat = U.extractTarGz(gz(makeTar([{ name: '.codebuddy-plugin/plugin.json', body: '{"version":"2.0.0"}' }])))
  check('tar 解包：无顶层目录的包同样可用', flat.has('.codebuddy-plugin/plugin.json'), [...flat.keys()].join(','))
  let threw = false
  try {
    U.extractTarGz(Buffer.from('not gzip'))
  } catch (err) {
    threw = true
  }
  check('tar 解包：非 gzip 输入抛错（不静默）', threw)
}

// ---------- 4. 落盘计划 / 清理 ----------
function mkRoot(name, entries) {
  const root = path.join(TMP, name)
  fs.mkdirSync(path.join(root, '.codebuddy-plugin'), { recursive: true })
  fs.writeFileSync(path.join(root, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({ version: '1.10.0' }), 'utf8')
  for (const [rel, body] of Object.entries(entries)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body, 'utf8')
  }
  return root
}

{
  const root = mkRoot('plan-root', { 'lib/keep.js': 'same', 'lib/gone.js': 'old', 'lib/change.js': 'v1' })
  const files = new Map([
    ['lib/keep.js', Buffer.from('same')],
    ['lib/change.js', Buffer.from('v2')],
    ['lib/new.js', Buffer.from('new')],
    ['.codebuddy-plugin/plugin.json', Buffer.from('{"version":"1.11.0"}')],
  ])
  const plan = await U.planApply(root, files, ['lib/keep.js', 'lib/gone.js', 'lib/change.js', 'README.md'])
  check(
    'planApply：内容相同跳过、变化重写、缺失新增、旧清单独有项进删除集、不存在的旧项忽略',
    plan.skip.includes('lib/keep.js') &&
      plan.write.includes('lib/change.js') &&
      plan.write.includes('lib/new.js') &&
      plan.write.includes('.codebuddy-plugin/plugin.json') &&
      plan.remove.includes('lib/gone.js') &&
      !plan.remove.includes('README.md'),
    JSON.stringify(plan)
  )
  // 无 manifest 的 git 工作区：不猜、不删（readOldFileList 返回 null → remove 空）
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  const gitPlan = await U.planApply(root, files, U.readOldFileList(root, { manifest: null }))
  check('readOldFileList：无 manifest 的 git 工作区返回 null（只覆盖不删除）', gitPlan.remove.length === 0, JSON.stringify(gitPlan.remove))

  // 无 manifest 的非 git 目录：整目录扫描 → 旧文件被清理
  const plain = mkRoot('plan-plain', { 'lib/old.js': 'old', 'lib/keep.js': 'same' })
  const plainPlan = await U.planApply(plain, files, U.readOldFileList(plain, { manifest: null }))
  check('readOldFileList：非 git 目录整目录扫描，旧文件进入删除集', plainPlan.remove.includes('lib/old.js') && plainPlan.skip.includes('lib/keep.js'), JSON.stringify(plainPlan))

  // 兜底清单（非 manifest）不得越出「新包顶层目录集合」删文件：git ls-files 给的是
  // 当前 HEAD 的全部被跟踪文件，本地领先目标 tag 的提交若不设限会被连带删除
  const localOnly = await U.planApply(plain, files, { files: ['lib/old.js', 'scratch/local-only.js'], source: 'git' })
  check(
    'planApply：兜底清单只清理新包顶层目录内的文件（本地独有目录不误删）',
    localOnly.remove.includes('lib/old.js') && !localOnly.remove.includes('scratch/local-only.js'),
    JSON.stringify(localOnly.remove)
  )
}

// ---------- 5. 应用到目录 + manifest（多 root 各记各的） ----------
{
  const root = mkRoot('apply-root', { 'lib/old.js': 'old', 'lib/keep.js': 'same' })
  const files = new Map([
    ['.codebuddy-plugin/plugin.json', Buffer.from('{"version":"1.12.0"}')],
    ['lib/keep.js', Buffer.from('same')],
    ['lib/new.js', Buffer.from('brand new')],
  ])
  const results = await U.applyUpdateFiles(files, '1.12.0', [root], { stamp: 'test-1' })
  const after = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8')
    } catch (err) {
      return null
    }
  }
  check(
    'applyUpdateFiles：写入新文件 / 保留未变文件 / 删除旧文件',
    after('lib/new.js') === 'brand new' && after('lib/keep.js') === 'same' && after('lib/old.js') === null,
    JSON.stringify(results[0])
  )
  check('applyUpdateFiles：包内版本号写进 manifest（供下次清理）', (() => {
    const m = U.readManifestFor(root)
    return !!m && m.version === '1.12.0' && m.files.includes('lib/new.js') && !m.files.includes('lib/old.js')
  })())
  check('applyUpdateFiles：旧文件备份到 update/backup/', fs.existsSync(path.join(TMP, 'plugin-data', 'update', 'backup', 'test-1', 'lib', 'old.js')))
  // 再跑一次：所有文件相同 → 不写不删
  const second = await U.applyUpdateFiles(files, '1.12.0', [root], { stamp: 'test-2' })
  check('applyUpdateFiles：重复应用幂等（写入 0 / 删除 0）', second[0].written === 0 && second[0].removed === 0, JSON.stringify(second[0]))

  // 多 root：两个安装目录各自留一份旧文件清单，互不覆盖
  const rootA = mkRoot('multi-a', { 'lib/stale-a.js': 'a' })
  const rootB = mkRoot('multi-b', { 'lib/stale-b.js': 'b' })
  const pkgAB = new Map([
    ['.codebuddy-plugin/plugin.json', Buffer.from('{"version":"1.12.1"}')],
    ['lib/shared.js', Buffer.from('shared')],
    ['scratch/local-only.js', Buffer.from('keep me')],
  ])
  fs.mkdirSync(path.join(rootA, 'scratch'), { recursive: true })
  fs.writeFileSync(path.join(rootA, 'scratch', 'local-only.js'), 'keep me', 'utf8')
  await U.applyUpdateFiles(pkgAB, '1.12.1', [rootA, rootB], { stamp: 'test-3' })
  const mA = U.readManifestFor(rootA)
  const mB = U.readManifestFor(rootB)
  check(
    'applyUpdateFiles：多 root 各自持有清单（后写不覆盖先写）',
    !!mA && !!mB && mA.version === '1.12.1' && mB.version === '1.12.1' && mA.files.includes('lib/shared.js') && mB.files.includes('lib/shared.js'),
    JSON.stringify([mA && mA.version, mB && mB.version])
  )
  check(
    'applyUpdateFiles：前一个 root 的旧文件也被清理（清单未被后一个 root 顶掉）',
    !fs.existsSync(path.join(rootA, 'lib', 'stale-a.js')) && !fs.existsSync(path.join(rootB, 'lib', 'stale-b.js'))
  )
  check('applyUpdateFiles：新包顶层目录之外的本地文件保留', fs.existsSync(path.join(rootA, 'scratch', 'local-only.js')))
}

// ---------- 5b. 写入失败 → 自动回滚（v1.3.3） ----------
{
  const root = mkRoot('rollback-root', { 'lib/old.js': 'old-content', 'lib/gone.js': 'bye' })
  // 目标路径先放一个**目录**，writeFile 必然失败（EISDIR/EPERM），模拟半途失败
  fs.mkdirSync(path.join(root, 'lib', 'blocked.js'), { recursive: true })
  const files = new Map([
    ['.zcode-plugin/plugin.json', Buffer.from('{"version":"9.9.9"}')],
    ['lib/old.js', Buffer.from('NEW')],
    ['lib/blocked.js', Buffer.from('x')],
    ['lib/gone.js', Buffer.from('still here')],
    ['lib/brand-new.js', Buffer.from('new')],
  ])
  const res = (await U.applyUpdateFiles(files, '9.9.9', [root], { stamp: 'rb-1' }))[0]
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8')
    } catch (err) {
      return null
    }
  }
  check('回滚：写入失败时 errors 有记录、rollback.ok 为真', res.errors.length > 0 && !!res.rollback && res.rollback.ok === true, JSON.stringify({ errors: res.errors, rollback: res.rollback }))
  check('回滚：不写新 manifest（否则下次会把半套文件当已更新）', !U.readManifestFor(root), JSON.stringify(U.readManifestFor(root)))
  check(
    '回滚：已写文件恢复原内容、被删文件找回',
    read('lib/old.js') === 'old-content' && read('lib/gone.js') === 'bye',
    JSON.stringify({ old: read('lib/old.js'), gone: read('lib/gone.js') })
  )
  check('回滚：原本不存在的新文件被清掉', read('lib/brand-new.js') === null, String(read('lib/brand-new.js')))
  check('回滚：新建的目录未破坏（blocked.js 仍是目录）', (() => {
    try {
      return fs.statSync(path.join(root, 'lib', 'blocked.js')).isDirectory()
    } catch (err) {
      return false
    }
  })())
}

// ---------- 5c. 更新历史（最多 10 条） ----------
{
  U.writeUpdateState({ history: [] })
  for (let i = 0; i < 12; i++) U.appendUpdateHistory({ from: '1.0.' + i, to: '1.0.' + (i + 1), result: 'ok' })
  const st = U.readUpdateState()
  check(
    '更新历史：最多保留 10 条，新的在末尾',
    Array.isArray(st.history) && st.history.length === 10 && st.history[9].to === '1.0.12' && typeof st.history[0].at === 'number',
    JSON.stringify({ n: st.history && st.history.length, last: st.history && st.history[9] })
  )
}

// ---------- 6. 跳过标记（widget-state） ----------
{
  check('updateSkip 写入合法版本号', (() => {
    const r = B.writeWidgetState({ updateSkip: '1.11.0' })
    return r.updateSkip === '1.11.0' && B.readWidgetState().updateSkip === '1.11.0'
  })())
  check('updateSkip 非法值被忽略', B.writeWidgetState({ updateSkip: 'latest' }).updateSkip === '1.11.0')
  check('updateSkip 置 null 取消跳过', B.writeWidgetState({ updateSkip: null }).updateSkip === null)
}

// ---------- 7. 远端检查（注入 fetch，不出网） ----------
{
  const eps = [
    { name: 'bad', url: 'https://ghproxy.net/x', pick: U.parsePluginJsonVersion },
    { name: 'good', url: 'https://cdn.jsdelivr.net/gh/a/b@main/.codebuddy-plugin/plugin.json', pick: U.parsePluginJsonVersion },
  ]
  let calls = 0
  const fetchImpl = async (url) => {
    calls++
    if (String(url).includes('ghproxy.net')) throw new Error('connect timeout')
    return fakeRes('{"version":"1.11.0"}')
  }
  const st = await U.checkForUpdate({ current: '1.10.0', endpoints: eps, fetchImpl, verifyTag: false })
  check(
    'checkForUpdate：首个源失败自动回退，命中后写状态（available + source）',
    calls === 2 && st.available === true && st.latest === '1.11.0' && st.source === 'good' && !st.error,
    JSON.stringify({ calls, source: st.source, latest: st.latest })
  )
  // 上次成功的源会被优先（成功后 source=good，再查时 good 排前）
  let first = null
  const st2 = await U.checkForUpdate({
    current: '1.10.0',
    endpoints: eps,
    fetchImpl: async (url) => {
      if (first === null) first = String(url)
      if (String(url).includes('ghproxy.net')) throw new Error('should not be first')
      return fakeRes('{"version":"1.11.0"}')
    },
  })
  check('checkForUpdate：记住上次可用源并优先使用', String(first).includes('jsdelivr') && st2.source === 'good', String(first))
  // 已是最新：available false
  const st3 = await U.checkForUpdate({ current: '1.11.0', endpoints: eps, fetchImpl: async () => fakeRes('{"version":"1.11.0"}') })
  check('checkForUpdate：版本相同 → available=false', st3.available === false && st3.latest === '1.11.0')
  // 全部失败：写 error，不抛
  const st4 = await U.checkForUpdate({
    current: '1.10.0',
    endpoints: eps,
    fetchImpl: async () => {
      throw new Error('all down')
    },
  })
  check('checkForUpdate：全部源失败写 error（不抛异常）', !!st4.error && st4.error.includes('检查失败'), String(st4.error).slice(0, 60))

  // 镜像缓存陈旧（实测：刚发版后 ghproxy 代理的 raw 仍返回上一版）——不能只看
  // 第一个成功的响应，要取所有候选里的最高版本；旧值不得把新版本盖掉
  const staleEps = [
    { name: 'stale-mirror', url: 'https://ghproxy.net/x', pick: U.parsePluginJsonVersion },
    { name: 'fresh-api', url: 'https://api.github.com/x', pick: U.parsePluginJsonVersion },
  ]
  const staleFirst = await U.checkForUpdate({
    current: '1.10.0',
    endpoints: staleEps,
    fetchImpl: async (url) => fakeRes(String(url).includes('ghproxy.net') ? '{"version":"1.10.0"}' : '{"version":"1.11.0"}'),
  })
  check(
    'checkForUpdate：镜像返回缓存旧版本时不会被当成「已是最新」（取最高版本）',
    staleFirst.latest === '1.11.0' && staleFirst.available === true && staleFirst.source === 'fresh-api',
    JSON.stringify({ latest: staleFirst.latest, source: staleFirst.source })
  )
  const allStale = await U.checkForUpdate({
    current: '1.11.0',
    endpoints: staleEps,
    fetchImpl: async (url) => fakeRes(String(url).includes('ghproxy.net') ? '{"version":"1.10.0"}' : '{"version":"1.11.0"}'),
  })
  check(
    'checkForUpdate：陈旧值 + 权威值并存时以高者为准（available=false，latest 不回退）',
    allStale.latest === '1.11.0' && allStale.available === false,
    JSON.stringify({ latest: allStale.latest, available: allStale.available })
  )
  check(
    '探测地址带时间戳防缓存参数（镜像 CDN 缓存键不命中）',
    U.buildVersionEndpoints().every((e) => e.url.includes('?t=')),
    U.buildVersionEndpoints().map((e) => e.name).join(',')
  )

  // tag 核对：探测读 main、下载读 tag，发版窗口里 main 会先报出还没打 tag 的版本号
  const rawOnly = [{ name: 'raw-mirror', url: 'https://ghproxy.net/x', pick: U.parsePluginJsonVersion }]
  const notYet = await U.checkForUpdate({
    current: '1.10.0',
    endpoints: rawOnly,
    fetchImpl: async (url) => (String(url).endsWith('/x') ? fakeRes('{"version":"1.11.0"}') : fakeRes('not found', 404)),
  })
  check(
    'checkForUpdate：版本号已提交但 tag 未推 → 不报「有更新」（避免点了必然 404）',
    notYet.available === false && notYet.latest === '1.11.0' && /尚未发布/.test(String(notYet.message)),
    JSON.stringify({ latest: notYet.latest, available: notYet.available, message: notYet.message })
  )
  const released = await U.checkForUpdate({
    current: '1.10.0',
    endpoints: rawOnly,
    fetchImpl: async () => fakeRes('{"version":"1.11.0"}'),
  })
  check('checkForUpdate：tag 存在时照常报「有更新」', released.available === true && released.latest === '1.11.0')
  const netErr = await U.checkForUpdate({
    current: '1.10.0',
    endpoints: rawOnly,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/x')) return fakeRes('{"version":"1.11.0"}')
      throw new Error('connect timeout')
    },
  })
  check('checkForUpdate：tag 核对遇网络错误时不误判未发布（宁可让下载去试）', netErr.available === true, JSON.stringify(netErr.available))
}

// ---------- 7b. 响应体上限 ----------
{
  let threw = false
  try {
    await U.readBodyLimited(fakeRes('x', 200, { 'content-length': String(200 * 1024 * 1024) }), 1024, '测试体')
  } catch (err) {
    threw = /上限/.test(String(err.message))
  }
  check('readBodyLimited：Content-Length 超限直接拒绝（不下载）', threw)

  threw = false
  try {
    const chunks = [Buffer.alloc(700, 65), Buffer.alloc(700, 66)]
    await U.readBodyLimited(streamRes(chunks), 1000, '测试体')
  } catch (err) {
    threw = /上限/.test(String(err.message))
  }
  check('readBodyLimited：流式累计超限即中止（无 Content-Length 也拦得住）', threw)

  const ok = await U.readBodyLimited(streamRes([Buffer.from('abc'), Buffer.from('de')]), 1024, '测试体')
  check('readBodyLimited：未超限时完整读出', ok.toString('utf8') === 'abcde', ok.toString('utf8'))

  // 整包下载：镜像返回一个声称超大的响应时，在解析前就被拒（不换源不算失败品）
  let dlErr = null
  try {
    await U.downloadTarball('1.11.0', {
      candidates: [{ name: 'big', url: 'https://ghproxy.net/big' }],
      fetchImpl: async () => fakeRes('x', 200, { 'content-length': String(200 * 1024 * 1024) }),
    })
  } catch (err) {
    dlErr = String((err && err.message) || err)
  }
  check('downloadTarball：超大整包被拒并计入失败原因', /上限/.test(String(dlErr)), String(dlErr).slice(0, 80))
}

// ---------- 8. 整包更新编排（注入 files，不出网） ----------
{
  const root = mkRoot('run-root', { 'lib/old.js': 'old' })
  // 发布物完整性（审查 I3）：造一对测试密钥 + 带签名的整包。生产环境私钥在仓库外，
  // 公钥是安装副本里的 .release-pubkey.pem（更新器的信任锚）。
  const testKeys = crypto.generateKeyPairSync('ed25519')
  const testPub = testKeys.publicKey.export({ type: 'spki', format: 'pem' })
  function signedPkg(entries, version, opts = {}) {
    const files = new Map(entries)
    const hashes = {}
    for (const [rel, body] of files) hashes[rel] = crypto.createHash('sha256').update(body).digest('hex')
    const sorted = {}
    for (const k of Object.keys(hashes).sort()) sorted[k] = hashes[k]
    const bytes = Buffer.from(JSON.stringify({ version, files: sorted }, null, 2) + '\n', 'utf8')
    files.set('.release-hashes.json', bytes)
    files.set(
      '.release-hashes.json.sig',
      Buffer.from(crypto.sign(null, bytes, opts.key || testKeys.privateKey).toString('base64'))
    )
    return files
  }
  const basePkg = () => [
    ['.codebuddy-plugin/plugin.json', Buffer.from('{"version":"9.9.9"}')],
    ['lib/server.mjs', Buffer.from('new server')],
  ]
  const pub = { publicKey: testPub }
  const pkg = signedPkg(basePkg(), '9.9.9')
  U.writeUpdateState({ latest: '9.9.9', available: true, busy: false, phase: null, error: null, source: null })
  const r1 = await U.runUpdate({ files: pkg, roots: [root], source: 'test', ...pub })
  const state1 = U.readUpdateState()
  check(
    'runUpdate：注入整包 → 写入并落状态 done（appliedVersion / busy=false）',
    r1.ok === true && state1.phase === 'done' && state1.appliedVersion === '9.9.9' && state1.busy === false && state1.available === false,
    JSON.stringify({ ok: r1.ok, phase: state1.phase, applied: state1.appliedVersion })
  )
  check('runUpdate：旧文件被清理', !fs.existsSync(path.join(root, 'lib', 'old.js')))
  // 版本不符必须拒装
  const badPkg = new Map([['.codebuddy-plugin/plugin.json', Buffer.from('{"version":"1.12.0"}')]])
  U.writeUpdateState({ latest: '9.9.9', available: true, busy: false })
  const r2 = await U.runUpdate({ files: badPkg, roots: [root] })
  check('runUpdate：包内版本与目标不符 → 拒绝安装并报错', r2.ok === false && r2.error.includes('版本不符'), String(r2.error))
  // busy 防重入
  U.writeUpdateState({ busy: true })
  const r3 = await U.runUpdate({ files: pkg, roots: [root], ...pub })
  check('runUpdate：已有任务进行中 → 直接拒绝（防重入）', r3.ok === false && r3.error.includes('在进行'), String(r3.error))
  // 缺清单 / 包体被篡改 / 签名不是本仓库私钥签的：三种都必须拒装（供应链）
  U.writeUpdateState({ busy: false, latest: '9.9.9', available: true, phase: null, error: null })
  const r4 = await U.runUpdate({ files: new Map(basePkg()), roots: [root], ...pub })
  check(
    'runUpdate：没有完整性清单 → 拒绝安装（审查 I3）',
    r4.ok === false && /完整性清单/.test(String(r4.error)),
    String(r4.error).slice(0, 90)
  )
  const tampered = signedPkg(basePkg(), '9.9.9')
  tampered.set('lib/server.mjs', Buffer.from('evil payload'))
  const r5 = await U.runUpdate({ files: tampered, roots: [root], ...pub })
  check(
    'runUpdate：包体被篡改 → 拒绝安装（内容与清单不符）',
    r5.ok === false && /清单不符/.test(String(r5.error)),
    String(r5.error).slice(0, 90)
  )
  const foreignSig = signedPkg(basePkg(), '9.9.9', { key: crypto.generateKeyPairSync('ed25519').privateKey })
  const r6 = await U.runUpdate({ files: foreignSig, roots: [root], ...pub })
  check(
    'runUpdate：签名不是本仓库私钥签的 → 拒绝安装（签名无效）',
    r6.ok === false && /签名无效/.test(String(r6.error)),
    String(r6.error).slice(0, 90)
  )
  const order = U.buildTarballUrls('9.9.9').map((u) => u.name)
  check('下载候选：直连 codeload 排第一（镜像只兜底）', order[0] === 'codeload', order.join(','))
  U.writeUpdateState({ busy: false, latest: null, available: false, phase: null, error: null })
}

// ---------- 9. 安装目录发现 ----------
{
  // candidateBases() 用 <CODEBUDDY_HOME>/plugins（host.mjs 的 HOST_HOME 在 import 时求值）
  const base = path.join(TMP, 'plugins')
  const cacheRoot = path.join(base, 'cache', 'fox-local', 'fox-widget', '1.0.0')
  fs.mkdirSync(path.join(cacheRoot, '.codebuddy-plugin'), { recursive: true })
  fs.writeFileSync(path.join(cacheRoot, '.codebuddy-plugin', 'plugin.json'), '{"name":"fox-widget","version":"1.0.0"}', 'utf8')
  const cacheRoot2 = path.join(base, 'cache', 'fox-local', 'fox-widget', '2.0.0')
  fs.mkdirSync(path.join(cacheRoot2, '.codebuddy-plugin'), { recursive: true })
  fs.writeFileSync(path.join(cacheRoot2, '.codebuddy-plugin', 'plugin.json'), '{"name":"fox-widget","version":"2.0.0"}', 'utf8')
  fs.writeFileSync(
    path.join(base, 'installed_plugins.json'),
    JSON.stringify({ version: 1, plugins: { 'fox-widget@fox-local': [{ id: 'fox-widget@fox-local', installPath: cacheRoot }] } }),
    'utf8'
  )
  const roots = U.discoverInstallRoots()
  const hasCache = roots.some((r) => path.resolve(r) === path.resolve(cacheRoot))
  const hasCache2 = roots.some((r) => path.resolve(r) === path.resolve(cacheRoot2))
  check('discoverInstallRoots：按注册表 + 缓存扫描找到安装副本', hasCache && hasCache2, JSON.stringify(roots))
}

// ---------- 10. 重启链路（真实子进程 + 隔离 HOME + 高位端口） ----------
// 这一块是本文件里唯一的端到端用例：cli.mjs 的 restart-all 必须「停干净 → 起得来」。
// 之所以专门测：stop 收到 shutdown 的 200 只代表「已受理」，旧进程还要过上百毫秒才
// 退出；此前 stop 立即返回，紧跟的 start 探到尚未退出的旧进程 → 误判「复用已在运行
// 的服务」→ 旧进程随后退出，结果一个服务都不剩（确定性复现）。
{
  const { spawnSync } = await import('node:child_process')
  const CLI = path.join(process.cwd(), 'lib', 'cli.mjs')
  // 高位端口，避开本机正在运行的真实挂件服务。两个口径都要设：config.json 决定
  // 服务实际绑哪个口，FOX_WIDGET_PORT 决定 findRunningServer 的默认候选——不设后者
  // 它会回落到 39321 并「复用」用户正在跑的那个服务，测试就成了空跑。
  const PORT = 39000 + (process.pid % 900)
  const run = (args) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      env: { ...process.env, WHALE_DISABLE_UPDATE_CHECK: '1', FOX_WIDGET_PORT: String(PORT) },
    })
  const serverInfo = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(process.env.FOX_WIDGET_DATA_DIR, 'server.json'), 'utf8'))
    } catch (err) {
      return null
    }
  }
  const healthOk = async () => {
    const info = serverInfo()
    if (!info || !info.port) return false
    const { probeHealth } = await import('../lib/service.mjs')
    return !!(await probeHealth(info.port, 1500))
  }
  // 端口冲突时 server.mjs 会自行顺延，所以下面一律从 server.json 读实际端口再探活
  fs.mkdirSync(process.env.FOX_WIDGET_DATA_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.FOX_WIDGET_DATA_DIR, 'config.json'), JSON.stringify({ port: PORT }), 'utf8')

  const started = run(['start'])
  check('重启链路：start 后服务在线', started.status === 0 && (await healthOk()), String(started.stdout || '').trim().split('\n').pop())

  const restarted = run(['restart-all'])
  const aliveAfter = await healthOk()
  check(
    '重启链路：restart-all 之后服务仍在线（stop 必须等到端口停止应答）',
    restarted.status === 0 && aliveAfter,
    JSON.stringify({ code: restarted.status, output: String(restarted.stdout || '').trim(), alive: aliveAfter })
  )
  const stopped = run(['stop'])
  check('重启链路：stop 之后端口不再应答', stopped.status === 0 && !(await healthOk()), String(stopped.stdout || '').trim())
}

// ---------- 11. 源码钉（有几条只能在真机上构造，见各条注释） ----------
{
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'update.mjs'), 'utf8')
  check(
    '解压设了输出上限（gunzip maxOutputLength）',
    /gunzipSync\(buf, \{ maxOutputLength: MAX_TOTAL_BYTES \}\)/.test(src),
    '构造 GB 级解压放大会把测试机拖垮，只能按源码钉'
  )
  // 「先整包进内存」只允许出现在 readBodyLimited 内部的降级分支里
  const dlSrc = src.slice(src.indexOf('export async function downloadTarball'), src.indexOf('export async function fetchViaJsdelivr'))
  const jsdSrc = src.slice(src.indexOf('export async function fetchViaJsdelivr'), src.indexOf('// ---------- 安装目录与落盘计划'))
  check(
    '两条下载路径都走带上限的读取（不再先整包进内存）',
    /readBodyLimited\(res, MAX_TARBALL_BYTES/.test(dlSrc) && /readBodyLimited\(res, MAX_FILE_BYTES/.test(jsdSrc) &&
      dlSrc.indexOf('arrayBuffer') === -1 && jsdSrc.indexOf('arrayBuffer') === -1
  )
  check('ustar prefix 按 155 字节读（长前缀不再被截断）', /readStr\(header, 345, 155\)/.test(src))
  const serverSrc = fs.readFileSync(path.join(process.cwd(), 'lib', 'server.mjs'), 'utf8')
  check(
    '停止服务先断连接再等 close 回调（不再裸 setTimeout 强退，避免 Windows libuv 断言）',
    /closeAllConnections/.test(serverSrc) && /server\.close\(finish\)/.test(serverSrc)
  )
  const svcSrc = fs.readFileSync(path.join(process.cwd(), 'lib', 'service.mjs'), 'utf8')
  check('stopServer 等端口真的停止应答（waitServerStopped）', /waitServerStopped/.test(svcSrc))
}

fs.rmSync(TMP, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok)
console.log('\n更新内核自检：' + (results.length - failed.length) + '/' + results.length + ' 通过')
process.exit(failed.length ? 1 : 0)
