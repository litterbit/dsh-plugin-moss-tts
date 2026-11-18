// 自动朗读的触发边界：只有"当前正在看的会话里、刚刚定稿的那条回复"才念。
//
// 真机 bug（2026-11-18）：打开任何旧会话都会把最后一条回复念一遍。原因是打开会话的
// 第一帧轨迹是空的，旧逻辑把 undefined 存成了基线；历史一加载完，所有 assistant 节点
// 的 seq 都"大于基线"，最后一条就被当成新回复。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const BUNDLE = path.resolve('lib', 'client.js')

function fakeReact() {
  return {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useMemo: (factory) => factory(),
    useId: () => 'id',
  }
}

function loadClient() {
  const registry = new Map()
  const context = {
    window: {
      __MOSS_TTS_TEST__: {},
      __ModuleLoader__: { load: (entry) => registry.set(entry.id, entry.factory) },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL: { createObjectURL: () => 'blob:x' },
    Blob: class {},
    fetch: async () => ({ ok: true, text: async () => '{}' }),
  }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), context, { filename: 'client.js' })
  const exports = [...registry.values()][0]((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  })
  const ctx = {
    effect: (factory) => factory(),
    locale: { register: () => () => {} },
    slots: { inject: (_name, register) => register(), register: () => () => {} },
  }
  exports.apply(ctx)
  return context.window.__MOSS_TTS_TEST__
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const user = (seq, text = '问题') => ({ kind: 'user', seq, blocks: [{ kind: 'text', text }] })
const streaming = (seq) => ({ kind: 'assistant', seq, blocks: [{ kind: 'text', text: '正在写…' }] })
const reply = (seq, messageId, text) => ({ kind: 'assistant', seq, messageId, blocks: [{ kind: 'text', text }] })

function recorder() {
  const spoken = []
  return { spoken, speak: (options) => spoken.push(options.text) }
}

test('打开旧会话：先空后加载的历史一条都不念', async () => {
  const api = loadClient()
  api.prefsStore.apply({ speakMode: 'full' })
  const { spoken, speak } = recorder()

  api.observeAutoRead('s1', { eventNodes: [] }, true, null, speak)
  api.observeAutoRead('s1', { eventNodes: [user(0), reply(1, 'm1', '四天前的回答')] }, true, null, speak)
  await sleep(350)

  assert.deepEqual(spoken, [], '加载历史不该出声')
})

test('当前会话里新回复定稿后才念，且只念一次', async () => {
  const api = loadClient()
  api.prefsStore.apply({ speakMode: 'full' })
  const { spoken, speak } = recorder()

  api.observeAutoRead('s1', { eventNodes: [] }, true, null, speak)
  api.observeAutoRead('s1', { eventNodes: [user(0), reply(1, 'm1', '旧回答'), user(2)] }, true, null, speak)
  api.observeAutoRead('s1', { eventNodes: [user(0), reply(1, 'm1', '旧回答'), user(2), streaming(3)] }, true, null, speak)
  await sleep(350)
  assert.deepEqual(spoken, [], '流式中的回复不该念')

  api.observeAutoRead('s1', { eventNodes: [user(0), reply(1, 'm1', '旧回答'), user(2), reply(3, 'm3', '新回答')] }, true, null, speak)
  await sleep(350)
  assert.deepEqual(spoken, ['新回答'])

  // 同一条再来两帧（seq 没变）不能重复念
  api.observeAutoRead('s1', { eventNodes: [user(0), reply(1, 'm1', '旧回答'), user(2), reply(3, 'm3', '新回答')] }, true, null, speak)
  await sleep(350)
  assert.deepEqual(spoken, ['新回答'])
})

test('切到另一个更长的旧会话也不念', async () => {
  const api = loadClient()
  api.prefsStore.apply({ speakMode: 'full' })
  const { spoken, speak } = recorder()

  api.observeAutoRead('s1', { eventNodes: [user(0), reply(1, 'a1', '短会话')] }, true, null, speak)
  await sleep(300)
  // s2 的历史更长、seq 更大，旧逻辑会把它整段当成"新回复"
  api.observeAutoRead('s2', { eventNodes: [] }, true, null, speak)
  api.observeAutoRead('s2', { eventNodes: [user(0), reply(1, 'b1', '更长的旧回答'), user(2), reply(3, 'b3', '最后一条')] }, true, null, speak)
  await sleep(350)
  assert.deepEqual(spoken, [])
})

test('关掉自动朗读时，新回复也不念', async () => {
  const api = loadClient()
  api.prefsStore.apply({ speakMode: 'full' })
  const { spoken, speak } = recorder()

  api.observeAutoRead('s1', { eventNodes: [] }, false, null, speak)
  api.observeAutoRead('s1', { eventNodes: [user(0), streaming(1)] }, false, null, speak)
  api.observeAutoRead('s1', { eventNodes: [user(0), reply(1, 'm1', '新回答')] }, false, null, speak)
  await sleep(350)
  assert.deepEqual(spoken, [])
})
