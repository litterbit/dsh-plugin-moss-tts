// 客户端 bundle 的加载冒烟：假 module loader + 假 react + 假 ctx。
// 验的是"能不能注册上、组件调用不炸"，真实渲染与播放由 GUI 验收。
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

function loadBundle() {
  const registry = new Map()
  const context = {
    window: {
      __ModuleLoader__: {
        load: (entry) => registry.set(entry.id, entry.factory),
      },
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
  return { registry, context }
}

function fakeCtx() {
  const registrations = []
  const dictionaries = {}
  const ctx = {
    effect: (factory) => {
      factory()
    },
    locale: {
      register: (ns, dict) => {
        dictionaries[ns] = dict
        return () => {}
      },
      bind: (ns) => (key, params) => {
        const dict = dictionaries[ns]
        const text = dict?.zh?.[key] ?? dict?.en?.[key] ?? key
        return params ? String(text).replace(/\{(\w+)\}/gu, (m, k) => (params[k] === undefined ? m : String(params[k]))) : text
      },
    },
    slots: {
      inject: (_name, register) => register(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, dictionaries }
}

test('bundle 能加载，并注册 3 个 slot', () => {
  const { registry } = loadBundle()
  assert.equal(registry.size, 1)
  const [id, factory] = [...registry.entries()][0]
  assert.equal(id, 'dsh-plugin-moss-tts')

  const exports = factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots', 'locale'])

  const { ctx, registrations, dictionaries } = fakeCtx()
  exports.apply(ctx)

  assert.equal(registrations.length, 3)
  const byName = new Map(registrations.map((item) => [item.options.name, item]))
  assert.ok(byName.has('settings.section'))
  assert.equal(byName.get('settings.section').options.id, 'moss-tts')
  assert.equal(byName.get('conversation.input.left').options.id, 'moss-tts')
  assert.equal(byName.get('conversation.chat.assistant-actions').options.id, 'moss-tts-read')
  for (const item of registrations) {
    assert.equal(typeof item.component, 'function')
    assert.equal(item.options.locale, 'moss-tts')
  }

  // 词典中英 key 必须一一对应
  const zh = Object.keys(dictionaries['moss-tts'].zh).sort()
  const en = Object.keys(dictionaries['moss-tts'].en).sort()
  assert.deepEqual(zh, en, 'zh/en 词典 key 应该一致')

  // 标签是本地化的（thunk）
  const label = byName.get('settings.section').options.label
  assert.equal(typeof label, 'function')
  assert.equal(label(), 'Moss 语音')
})

test('三个组件浅浅调用一次都不抛错', () => {
  const { registry } = loadBundle()
  const exports = [...registry.values()][0]((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  })
  const { ctx, registrations } = fakeCtx()
  exports.apply(ctx)
  const t = (key) => key
  for (const { options, component } of registrations) {
    const element = component({
      t,
      sessionId: 'session-1',
      messageId: 'message-1',
      useTrajectory: (selector) => selector(undefined),
      useStatus: (selector) => selector(undefined),
    })
    assert.ok(element && typeof element === 'object', `${options.name} 应该返回元素`)
  }
})
