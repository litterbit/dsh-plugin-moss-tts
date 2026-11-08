// 工具层：不启动引擎，只验"宿主能吃下这套定义"。
// 真的注册逻辑在 DSH 里，这里用假 ctx 覆盖形状（name/parameters/output/execute）。
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { apply, name } from '../lib/index.mjs'

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

function sampleOutput(name) {
  if (name === 'moss_tts_say') {
    return { voice: 'Junhao', seconds: 1.5, compute_ms: 200, rtf: 0.13, file: 'x.wav', played: true }
  }
  if (name === 'moss_tts_engine') return { state: 'ready', version: '0.1.1', exe: 'x.exe', models: 'm' }
  return { detail: 'ok' }
}
