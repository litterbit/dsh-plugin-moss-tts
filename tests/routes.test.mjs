// 路由层：起一个真的 http.Server，用真的 req/res 打真实请求。
// 引擎是假的 —— 这里验的是协议、安全头和背压开关，不是合成质量。
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { registerRoutes } from '../lib/host/routes.mjs'
import { DEFAULT_PREFS, normalizePrefs } from '../lib/host/prefs.mjs'

function fakeEngine(state) {
  return {
    running: true,
    async start() {},
    pauseOutput() {
      state.paused += 1
    },
    resumeOutput() {
      state.resumed += 1
    },
    async speak(options) {
      state.calls.push(options)
      const chunks = state.chunks
      const done = new Promise((resolve) => {
        const run = async () => {
          options.onBegin?.({ format: { encoding: 's16le', rate: 48000, channels: 2 } })
          for (const chunk of chunks) {
            if (state.cancelled) break
            options.onAudio(chunk)
            await new Promise((resolve) => setTimeout(resolve, state.delay))
          }
          resolve(state.cancelled ? { state: 'cancelled' } : { state: 'completed', audio_ms: 100 })
        }
        run()
      })
      return { id: 's1', done, cancel: () => { state.cancelled = true } }
    },
  }
}

function fakeService(overrides = {}) {
  let prefs = { ...DEFAULT_PREFS }
  const state = { calls: [], paused: 0, resumed: 0, cancelled: false, chunks: [Buffer.alloc(4800)], delay: 1 }
  const service = {
    root: 'D:\\tmp\\MossTTS',
    config: {},
    log: () => {},
    prefs: {
      get: () => prefs,
      update: (patch) => {
        prefs = normalizePrefs(patch, prefs)
        return prefs
      },
    },
    installer: {
      busy: false,
      state: () => ({ phase: 'ready', downloaded: 0, total: 0 }),
      start: async () => {},
      cancel: () => true,
    },
    install: async () => {},
    cancelInstall: () => true,
    status: () => ({
      state: 'ready',
      running: true,
      prefs,
      install: { phase: 'ready', downloaded: 0, total: 0 },
    }),
    ensureEngine: async () => fakeEngine(state),
    voices: async () => ({ builtin: [{ id: 'Junhao' }], user: [] }),
    synthesize: async () => ({ pcm: Buffer.alloc(960), info: { audio_ms: 10, state: 'completed' } }),
    ...overrides,
  }
  return { service, state, prefs: () => prefs }
}

async function harness(service) {
  const routes = new Map()
  const webServer = {
    register({ path, handler }) {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  }
  registerRoutes(webServer, service)
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    const handler = routes.get(pathname)
    if (!handler) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(String(error))
      } else {
        res.destroy()
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('GET /status 返回状态与偏好', async () => {
  const { service } = fakeService()
  const app = await harness(service)
  try {
    const res = await fetch(`${app.base}/moss-tts/status`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.state, 'ready')
    assert.equal(body.prefs.voice, 'Junhao')
    assert.equal(res.headers.get('cache-control'), 'no-store')
  } finally {
    await app.close()
  }
})

test('跨源 Origin 被拒', async () => {
  const { service } = fakeService()
  const app = await harness(service)
  try {
    const res = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ text: '你好' }),
    })
    assert.equal(res.status, 403)
  } finally {
    await app.close()
  }
})

test('非 JSON 的 POST 被拒（挡掉表单/图片型跨站请求）', async () => {
  const { service } = fakeService()
  const app = await harness(service)
  try {
    const res = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })
    assert.equal(res.status, 415)
  } finally {
    await app.close()
  }
})

test('POS 体过大 → 413', async () => {
  const { service } = fakeService()
  const app = await harness(service)
  try {
    const res = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(70 * 1024) }),
    })
    assert.equal(res.status, 413)
  } finally {
    await app.close()
  }
})

test('POST /stream 返回 PCM 流与格式头', async () => {
  const { service, state } = fakeService()
  state.chunks = [Buffer.alloc(4800, 1), Buffer.alloc(4800, 2)]
  const app = await harness(service)
  try {
    const res = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好，世界。', voice: 'Xiaoyu' }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream')
    assert.equal(res.headers.get('x-moss-audio-format'), 's16le;rate=48000;channels=2')
    const bytes = Buffer.from(await res.arrayBuffer())
    assert.equal(bytes.length, 9600)
    assert.equal(state.calls.length, 1)
    assert.equal(state.calls[0].voice, 'Xiaoyu')
  } finally {
    await app.close()
  }
})

test('文本过长 → 413，不进引擎', async () => {
  const { service, state } = fakeService()
  const app = await harness(service)
  try {
    const res = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '好'.repeat(4001) }),
    })
    assert.equal(res.status, 413)
    assert.equal(state.calls.length, 0)
  } finally {
    await app.close()
  }
})

test('引擎缺失 → 503 且带可读原因', async () => {
  const { service } = fakeService({
    status: () => ({ state: 'missing', prefs: {}, install: { phase: 'idle' } }),
  })
  const app = await harness(service)
  try {
    const res = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好' }),
    })
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.code, 'engine-missing')
    assert.match(body.message, /设置/u)
  } finally {
    await app.close()
  }
})

test('客户端中断 → 引擎作业被取消', async () => {
  const { service, state } = fakeService()
  state.chunks = Array.from({ length: 20 }, () => Buffer.alloc(4800))
  state.delay = 10
  const app = await harness(service)
  try {
    const controller = new AbortController()
    const res = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '一段很长的文字。' }),
      signal: controller.signal,
    })
    reader: {
      const reader = res.body.getReader()
      await reader.read()
      controller.abort()
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(state.cancelled, true)
  } finally {
    await app.close()
  }
})

test('偏好读写往返，且只认已知字段', async () => {
  const { service, prefs } = fakeService()
  const app = await harness(service)
  try {
    const before = await (await fetch(`${app.base}/moss-tts/prefs`)).json()
    assert.equal(before.prefs.autoRead, false)
    const res = await fetch(`${app.base}/moss-tts/prefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoRead: true, voice: 'Xiaoyu', evil: 1 }),
    })
    assert.equal(res.status, 200)
    const after = await (await fetch(`${app.base}/moss-tts/prefs`)).json()
    assert.equal(after.prefs.autoRead, true)
    assert.equal(after.prefs.voice, 'Xiaoyu')
    assert.equal('evil' in prefs(), false)
  } finally {
    await app.close()
  }
})

test('/voices 在引擎缺失时返回 installed:false 而不是报错', async () => {
  const { service } = fakeService({
    status: () => ({ state: 'missing', prefs: {}, install: { phase: 'idle' } }),
  })
  const app = await harness(service)
  try {
    const body = await (await fetch(`${app.base}/moss-tts/voices`)).json()
    assert.equal(body.installed, false)
    assert.deepEqual(body.builtin, [])
  } finally {
    await app.close()
  }
})
