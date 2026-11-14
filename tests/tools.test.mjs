// 工具层：不启动引擎，只验"宿主能吃下这套定义"。
// 真的注册逻辑在 DSH 里，这里用假 ctx 覆盖形状（name/parameters/output/execute）。
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { apply, name } from '../lib/index.mjs'
import { createPlayback } from '../lib/host/playback.mjs'
import { registerTools } from '../lib/host/tools.mjs'

const ROOT = path.resolve('runs', 'test-tools')

function fakeCtx() {
  const tools = new Map()
  const effects = []
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    effect: (factory, label) => effects.push({ factory, label }),
    get: () => undefined,
    inject: (deps, callback) => callback(ctx),
    logger: { info: () => {} },
    tools_: tools,
    effects,
  }
  return ctx
}

test('apply 注册 5 个工具，形状符合宿主约定', async () => {
  const ctx = fakeCtx()
  apply(ctx, { root: ROOT, autoDownload: false })
  assert.equal(name, 'moss-tts')
  assert.equal(ctx.tools_.size, 5)
  assert.deepEqual(
    [...ctx.tools_.keys()].sort(),
    ['moss_tts_clone', 'moss_tts_engine', 'moss_tts_say', 'moss_tts_stop', 'moss_tts_voices'],
  )
  for (const tool of ctx.tools_.values()) {
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.description, 'string')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    // 宿主只支持标准 JSON Schema：required 必须是数组，不能是 {required:true}
    if (tool.parameters.required !== undefined) assert.ok(Array.isArray(tool.parameters.required))
    const rendered = tool.output.render({}, sampleOutput(tool.name))
    assert.ok(Array.isArray(rendered) && typeof rendered[0].text === 'string')
  }
  assert.equal(typeof ctx.effects[0].factory, 'function')
  const dispose = ctx.effects[0].factory()
  assert.equal(typeof dispose, 'function')
  await dispose()
})

test('moss_tts_engine 在没装引擎时给出可执行文案', async () => {
  const ctx = fakeCtx()
  apply(ctx, { root: ROOT, autoDownload: false })
  const engine = ctx.tools_.get('moss_tts_engine')
  const status = await engine.execute({ action: 'status' })
  assert.equal(status.state, 'missing')
  assert.match(engine.output.render({}, status)[0].text, /状态：missing/u)
  const voices = await ctx.tools_.get('moss_tts_voices').execute({})
  assert.match(voices.detail, /设置 → Moss 语音/u)
})

test('工具输出是 lossless JSON：整棵树里没有 undefined', async () => {
  const ctx = fakeCtx()
  apply(ctx, { root: ROOT, autoDownload: false })
  const status = await ctx.tools_.get('moss_tts_engine').execute({ action: 'status' })
  const walk = (value, path) => {
    assert.notEqual(value, undefined, `${path} 是 undefined`)
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      assert.notEqual(item, undefined, `${path}.${key} 是 undefined`)
      walk(item, `${path}.${key}`)
    }
  }
  walk(status, 'status')
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(status)))
})

function sampleOutput(name) {
  if (name === 'moss_tts_say') {
    return { voice: 'Junhao', seconds: 1.5, compute_ms: 200, rtf: 0.13, file: 'x.wav', played: true }
  }
  if (name === 'moss_tts_engine') return { state: 'ready', version: '0.1.1', exe: 'x.exe', models: 'm' }
  return { detail: 'ok' }
}

/** 只够 moss_tts_say / moss_tts_stop 用的最小 service：合成一律算失败。 */
function sayService(overrides = {}) {
  return {
    root: ROOT,
    dataDir: path.join(ROOT, 'userdata'),
    log: () => {},
    prefs: { get: () => ({ voice: '', maxChars: 1500, skipCode: true, volume: 0.6 }) },
    status: () => ({ state: 'ready', platform: 'win32' }),
    stop: async () => false,
    synthesizeToFile: async () => {
      throw new Error('浏览器在线时不该落盘合成')
    },
    ...overrides,
  }
}

function registerFakeTools(service, options) {
  const tools = new Map()
  registerTools({ tools: { register: (tool) => tools.set(tool.name, tool) } }, service, options)
  return tools
}

test('moss_tts_say 有浏览器时不合成、立刻返回，并把文本丢进事件流', async () => {
  const sent = []
  const events = {
    size: 1,
    send(event) {
      sent.push(event)
      return 1
    },
  }
  const playback = createPlayback()
  const tools = registerFakeTools(sayService(), { events, playback })

  const started = Date.now()
  const out = await tools.get('moss_tts_say').execute({ text: '**你好**，世界。' })
  const spent = Date.now() - started

  assert.ok(spent < 100, `应该立刻返回，实际 ${spent} ms`)
  assert.equal(out.mode, 'stream')
  assert.equal(out.started, true)
  assert.equal(out.background, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'say')
  assert.equal(sent[0].text, '你好，世界。')
  assert.equal(sent[0].maxChars, 0)
  assert.equal(playback.snapshot().state, 'starting')
  assert.match(tools.get('moss_tts_say').output.render({}, out)[0].text, /已开始播放/u)
})

test('wait=true 等浏览器报播完；moss_tts_stop 会发 stop 事件', async () => {
  const sent = []
  const events = {
    size: 1,
    send(event) {
      sent.push(event)
      return 1
    },
  }
  const playback = createPlayback()
  const tools = registerFakeTools(sayService(), { events, playback })

  const waiting = tools.get('moss_tts_say').execute({ text: '等它读完。', wait: true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const id = sent[0].id
  playback.update({ id, state: 'speaking', played: 48000, total: 96000 })
  playback.update({ id, state: 'done', played: 96000, total: 96000 })
  const out = await waiting
  assert.equal(out.background, false)
  assert.equal(out.seconds, 2)

  const stopped = await tools.get('moss_tts_stop').execute({})
  assert.equal(sent.at(-1).type, 'stop')
  assert.match(stopped.detail, /停止/u)
})
