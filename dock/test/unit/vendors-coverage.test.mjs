// 厂商覆盖评估（2026-10-23）：17 个新模板 + 既有中转站不丢
//
// 新模板一律 kind:'tokens'：官方没有公开的「用 API key 查余额」接口，模板只声明
// envKeys，不写 balance/quota 段，因此不会出站。金额按本机 token 用量匹配已有
// 价目（pricing:'model'），模型不在价目表时由计价层给 null，不补 0。
import assert from 'node:assert/strict'
import test from 'node:test'
import { TEMPLATES, resolveTemplateKey } from '../../engines/vendors.mjs'
import { RELAYS } from '../../engines/relays.mjs'

const NEW_TEMPLATES = {
  'azure-openai': { name: 'Azure OpenAI', currency: 'USD', envKeys: ['AZURE_OPENAI_API_KEY'] },
  'aws-bedrock': {
    name: 'AWS Bedrock',
    currency: 'USD',
    envKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
  },
  'google-vertex': {
    name: 'Google Vertex AI',
    currency: 'USD',
    envKeys: ['GOOGLE_VERTEX_API_KEY'],
  },
  'cloudflare-workers-ai': {
    name: 'Cloudflare Workers AI',
    currency: 'USD',
    envKeys: ['CLOUDFLARE_API_TOKEN'],
  },
  cohere: { name: 'Cohere', currency: 'USD', envKeys: ['COHERE_API_KEY'] },
  perplexity: { name: 'Perplexity', currency: 'USD', envKeys: ['PERPLEXITY_API_KEY'] },
  replicate: { name: 'Replicate', currency: 'USD', envKeys: ['REPLICATE_API_TOKEN'] },
  huggingface: { name: 'Hugging Face', currency: 'USD', envKeys: ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'] },
  'nvidia-nim': { name: 'NVIDIA NIM', currency: 'USD', envKeys: ['NVIDIA_API_KEY'] },
  sambanova: { name: 'SambaNova', currency: 'USD', envKeys: ['SAMBANOVA_API_KEY'] },
  lambda: { name: 'Lambda', currency: 'USD', envKeys: ['LAMBDA_API_KEY'] },
  nebius: { name: 'Nebius AI Studio', currency: 'USD', envKeys: ['NEBIUS_API_KEY'] },
  sensetime: { name: '商汤日日新 SenseNova', currency: 'CNY', envKeys: ['SENSENOVA_API_KEY', 'SENSETIME_API_KEY'] },
  baichuan: { name: '百川智能 Baichuan', currency: 'CNY', envKeys: ['BAICHUAN_API_KEY'] },
  yi: { name: '零一万物 Yi', currency: 'CNY', envKeys: ['YI_API_KEY', 'LINGYIWANWU_API_KEY'] },
  minicpm: { name: '面壁智能 MiniCPM', currency: 'CNY', envKeys: ['MODELBEST_API_KEY', 'MINICPM_API_KEY'] },
  kunlun: { name: '昆仑万维天工', currency: 'CNY', envKeys: ['KUNLUN_API_KEY', 'SKYWORK_API_KEY'] },
}

test('vendors-coverage: 17 个新模板存在、kind=tokens、无出站段', () => {
  assert.equal(Object.keys(NEW_TEMPLATES).length, 17)
  for (const [id, expected] of Object.entries(NEW_TEMPLATES)) {
    const tpl = TEMPLATES[id]
    assert.ok(tpl, 'missing template: ' + id)
    assert.equal(tpl.kind, 'tokens', id + ' 必须是 tokens（官方无余额接口）')
    assert.equal(tpl.name, expected.name, id + ' 名称')
    assert.equal(tpl.currency, expected.currency, id + ' 币种')
    assert.deepEqual(tpl.envKeys, expected.envKeys, id + ' envKeys')
    assert.equal(tpl.pricing, 'model', id + ' 只按模型匹配已有价目')
    // 不允许出现任何真实/伪造取数段，否则会把 status 变成 balance/quota 或出站
    for (const key of ['balance', 'quota', 'relay']) {
      assert.equal(key in tpl, false, id + ' 不应声明 ' + key + ' 段')
    }
    assert.match(tpl.note, /官方无公开 API-key 余额接口/, id + ' note 说明原因')
    assert.match(tpl.note, /本机 token 用量计价/, id + ' note 说明计价口径')
    assert.match(tpl.statusNote, /无公开 API-key 余额接口/, id + ' statusNote 说明原因')
  }
})

test('vendors-coverage: 非 API key 的环境变量不能冒充已配置凭据', () => {
  const notKeys = {
    'aws-bedrock': ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    'google-vertex': ['GOOGLE_APPLICATION_CREDENTIALS'],
    'cloudflare-workers-ai': ['CLOUDFLARE_ACCOUNT_ID'],
  }
  for (const [id, names] of Object.entries(notKeys)) {
    for (const name of names) {
      assert.equal(TEMPLATES[id].envKeys.includes(name), false, id + ' 不能把 ' + name + ' 当作 API key')
    }
  }
})

test('vendors-coverage: id 与 envKeys 都不重复，且不与既有模板抢凭据', () => {
  const ids = Object.keys(NEW_TEMPLATES)
  assert.equal(new Set(ids).size, ids.length)

  const seen = new Map()
  for (const id of ids) {
    for (const envName of NEW_TEMPLATES[id].envKeys) {
      assert.equal(seen.has(envName), false, '新模板之间重复 envKey: ' + envName + '（' + seen.get(envName) + ' / ' + id + '）')
      seen.set(envName, id)
    }
  }
  // 既有模板（含中转站）的 envKeys：新模板不得借用，避免同一把 key 被两个模板认领
  const oldKeys = new Set()
  for (const [id, tpl] of Object.entries(TEMPLATES)) {
    if (NEW_TEMPLATES[id]) continue
    for (const envName of tpl.envKeys || []) oldKeys.add(envName)
  }
  for (const [envName, id] of seen) {
    assert.equal(oldKeys.has(envName), false, id + ' 的 envKey ' + envName + ' 已被既有模板占用')
  }
})

test('vendors-coverage: 既有中转站模板一个都没丢', () => {
  // 评估结论：小众中转站保留，只是语义降为「仅计价/无余额接口」
  for (const relay of RELAYS) {
    const tpl = TEMPLATES['relay-' + relay.id]
    assert.ok(tpl, 'missing relay template: ' + relay.id)
    assert.equal(tpl.kind, 'relay')
    assert.equal(tpl.name, relay.name)
  }
  for (const id of ['sssaicode', 'cubence', 'apinebula', 'hapi', 'uuapi']) {
    assert.ok(TEMPLATES['relay-' + id], '中转站被误删: ' + id)
  }
  assert.equal(
    Object.keys(TEMPLATES).filter((id) => id.startsWith('relay-')).length,
    RELAYS.length
  )
})

test('vendors-coverage: 新模板凭据解析（env 优先、按声明顺序）', () => {
  const prev = {
    SENSETIME_API_KEY: process.env.SENSETIME_API_KEY,
    SENSENOVA_API_KEY: process.env.SENSENOVA_API_KEY,
    COHERE_API_KEY: process.env.COHERE_API_KEY,
  }
  try {
    delete process.env.SENSENOVA_API_KEY
    delete process.env.COHERE_API_KEY
    process.env.SENSETIME_API_KEY = 'test-key-sensetime'
    const st = resolveTemplateKey('sensetime')
    assert.equal(st.key, 'test-key-sensetime')
    assert.equal(st.source, 'env:SENSETIME_API_KEY')

    process.env.SENSENOVA_API_KEY = 'test-key-sensenova'
    const st2 = resolveTemplateKey('sensetime')
    assert.equal(st2.key, 'test-key-sensenova', '声明顺序靠前的环境变量优先')
    assert.equal(st2.source, 'env:SENSENOVA_API_KEY')

    process.env.COHERE_API_KEY = 'test-key-cohere'
    const co = resolveTemplateKey('cohere')
    assert.equal(co.key, 'test-key-cohere')
    assert.equal(co.source, 'env:COHERE_API_KEY')
  } finally {
    for (const [name, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
