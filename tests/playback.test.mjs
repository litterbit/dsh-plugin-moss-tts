// 播放回归：真 HTTP 流 + 真客户端 bundle + 模拟时钟的 AudioWorklet。
//
// 这是 v0.1.0 "播到一半没声"的守门测试：信用窗口一旦失效，worklet 环缓会被灌爆，
// dropped 计数和 played 总数会立刻对不上。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { registerRoutes } from '../lib/host/routes.mjs'

const BUNDLE = fs.readFileSync(path.resolve('lib', 'client.js'), 'utf8')

function fakeEngine(state) {
  return {
    running: true,
    async start() {},
    pauseOutput() {},
    resumeOutput() {},
    async speak(options) {
      const id = `s${(state.calls += 1)}`
      const job = { cancelled: false }
      state.jobs.push(job)
      const done = new Promise((resolve) => {
        const run = async () => {
          for (let i = 0; i < state.chunks; i++) {
            if (job.cancelled) break
            const samples = new Int16Array(state.framesPerChunk * 2)
            for (let f = 0; f < samples.length; f++) samples[f] = (i + f) % 2000
            options.onAudio(Buffer.from(samples.buffer))
            await new Promise((resolve) => setTimeout(resolve, 1))
          }
          resolve({ state: job.cancelled ? 'cancelled' : 'completed', audio_ms: state.chunks * 100 })
        }
        run()
      })
      return { id, done, cancel: () => { job.cancelled = true } }
    },
  }
}

async function startHost(state) {
  const service = {
    root: process.cwd(),
    config: {},
    log: () => {},
    prefs: { get: () => ({ voice: 'Junhao', autoRead: false, maxChars: 0, skipCode: true }), update: (patch) => patch },
    installer: { busy: false, state: () => ({ phase: 'ready' }), start: async () => {}, cancel: () => true },
    install: async () => {},
    status: () => ({ state: 'ready', install: { phase: 'ready' }, prefs: {} }),
    ensureEngine: async () => fakeEngine(state),
    voices: async () => ({ builtin: [], user: [] }),
    synthesize: async () => ({ pcm: Buffer.alloc(0), info: {} }),
  }
  const routes = new Map()
  registerRoutes({ register: ({ path: routePath, handler }) => (routes.set(routePath, handler), () => {}) }, service)
  const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!handler) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(handler(req, res)).catch(() => res.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
}

/** 用真 WORKLET_SOURCE 建一个假 worklet：process() 由测试驱动，端口直连。 */
function createWorklet(source) {
  const messages = []
  const listeners = new Set()
  let Processor
  const context = {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (message) => messages.push(message) }
      }
    },
    registerProcessor: (_name, cls) => {
      Processor = cls
    },
    sampleRate: 48000,
    console,
  }
  vm.createContext(context)
  vm.runInContext(source, context)
  const instance = new Processor()
  const emit = (message) => {
    for (const listener of listeners) listener(message)
  }
  // 把 worklet 的 report() 转给宿主端
  const originalPost = instance.port.postMessage
  instance.port.postMessage = (message) => {
    originalPost(message)
    emit(message)
  }
  return {
    instance,
    messages,
    listen(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    process(frames = 128) {
      const out = [new Float32Array(frames), new Float32Array(frames)]
      instance.process([], [out])
    },
  }
}

function loadClient(base) {
  const registry = new Map()
  const blobs = new Map()
  const state = { worklet: undefined, node: undefined }
  const hooks = {}

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000
      this.state = 'running'
      this.destination = {}
      this.audioWorklet = {
        addModule: async (url) => {
          const text = await blobs.get(url).text()
          state.worklet = createWorklet(text)
        },
      }
    }

    resume() {
      this.state = 'running'
      return Promise.resolve()
    }
  }

  class FakeAudioWorkletNode {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          if (message.type === 'push') state.worklet.instance.port.onmessage({ data: { type: 'push', samples: message.samples } })
          else if (message.type === 'end') state.worklet.instance.port.onmessage({ data: { type: 'end' } })
          else if (message.type === 'reset') state.worklet.instance.port.onmessage({ data: { type: 'reset' } })
        },
      }
      state.worklet.listen((message) => this.port.onmessage?.({ data: message }))
    }

    connect() {}
  }

  const context = {
    window: {
      AudioContext: FakeAudioContext,
      __MOSS_TTS_TEST__: hooks,
      __ModuleLoader__: { load: (entry) => registry.set(entry.id, entry.factory) },
    },
    AudioWorkletNode: FakeAudioWorkletNode,
    fetch: (url, init) => fetch(new URL(url, base), init),
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    Blob,
    URL: {
      createObjectURL: (blob) => {
        const key = `blob:${blobs.size}`
        blobs.set(key, blob)
        return key
      },
    },
  }
  vm.createContext(context)
  vm.runInContext(BUNDLE, context)
  const factory = [...registry.values()][0]
  const exports = factory((name) => {
    if (name === 'react') {
      return {
        Fragment: 'Fragment',
        createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
        useRef: (value) => ({ current: value }),
        useMemo: (make) => make(),
        useId: () => 'id',
      }
    }
    throw new Error(`unexpected require: ${name}`)
  })
  const registered = []
  exports.apply({
    effect: (factoryFn) => factoryFn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: (_name, register) => register(), register: (options, component) => registered.push({ options, component }) },
  })
  assert.equal(registered.length, 3)
  return { hooks, state }
}

function tick(worklet, frames) {
  let remaining = frames
  while (remaining > 0) {
    const step = Math.min(128, remaining)
    worklet.process(step)
    remaining -= step
  }
}

test('信用窗口下播放不丢样：played 等于送出的全部帧', { timeout: 60000 }, async () => {
  const engineState = { calls: 0, jobs: [], chunks: 15, framesPerChunk: 4800 }
  const host = await startHost(engineState)
  try {
    const { hooks, state } = loadClient(host.base)
    const speaking = hooks.player.speak({ text: '一段测试音频。', voice: 'Junhao' })

    // 用比实时快得多的时钟推进 worklet，逼出"读得比播得快"
    const timer = setInterval(() => {
      if (state.worklet && hooks.player.snapshot.state !== 'idle') tick(state.worklet, 5120)
    }, 2)

    try {
      await speaking
      // 等缓冲区排空
      for (let i = 0; i < 200 && hooks.player.snapshot.state !== 'idle'; i++) await new Promise((r) => setTimeout(r, 20))
    } finally {
      clearInterval(timer)
    }

    const total = engineState.chunks * engineState.framesPerChunk
    assert.equal(hooks.player.snapshot.state, 'idle')
    assert.equal(hooks.player.snapshot.dropped, 0, '不应丢样')
    assert.equal(state.worklet.instance.played, total, `应播满 ${total} 帧`)
  } finally {
    await host.close()
  }
})

test('新朗读打断旧朗读：旧作业被取消，新的一段照常播完', { timeout: 60000 }, async () => {
  const engineState = { calls: 0, jobs: [], chunks: 20, framesPerChunk: 4800 }
  const host = await startHost(engineState)
  try {
    const { hooks, state } = loadClient(host.base)
    const first = hooks.player.speak({ text: '第一段很长很长的文字。' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    engineState.chunks = 6
    const second = hooks.player.speak({ text: '第二段。' })

    const timer = setInterval(() => {
      if (state.worklet && hooks.player.snapshot.state !== 'idle') tick(state.worklet, 5120)
    }, 2)
    try {
      await Promise.all([first, second])
      for (let i = 0; i < 200 && hooks.player.snapshot.state !== 'idle'; i++) await new Promise((r) => setTimeout(r, 20))
    } finally {
      clearInterval(timer)
    }
    assert.equal(engineState.jobs[0].cancelled, true, '第一个作业应被取消')
    assert.ok(state.worklet.instance.played > 0)
    assert.equal(hooks.player.snapshot.state, 'idle')
  } finally {
    await host.close()
  }
})
