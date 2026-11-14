// 路由层：起一个真的 http.Server，用真的 req/res 打真实请求。
// 引擎是假的 —— 这里验的是协议、安全头和背压开关，不是合成质量。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
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
    voices: async () => ({ builtin: [{ id: 'Junhao' }], user: [], default: 'Junhao' }),
    speak: async (options) => fakeEngine(state).speak(options),
    recordJob: () => {},
    dataDir: 'D:\\tmp\\MossTTS\\userdata',
    lastJob: undefined,
    synthesize: async () => ({ pcm: Buffer.alloc(960), info: { audio_ms: 10, state: 'completed' } }),
    ...overrides,
  }
  return { service, state, prefs: () => prefs }
}

async function harness(service, options = {}) {
  const routes = new Map()
  const webServer = {
    register({ path, handler }) {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  }
  registerRoutes(webServer, service, options)
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
    assert.equal(body.prefs.voice, '')
    assert.equal(body.prefs.speakMode, 'smart')
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

test('超长文本：先按 4000 字截断，超过两倍才 413', async () => {
  const { service, state } = fakeService()
  const app = await harness(service)
  try {
    const res = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '好'.repeat(4001) }),
    })
    assert.equal(res.status, 200)
    assert.equal(state.calls.length, 1)
    assert.ok(state.calls[0].text.length <= 4000)

    const huge = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '好'.repeat(9000) }),
    })
    assert.equal(huge.status, 413)
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
﻿
test('GET /last 返回最近一次耗时', async () => {
  const job = { audio_ms: 5120, compute_ms: 764, first_pcm_ms: 128, rtf: 0.149 }
  const { service } = fakeService({ lastJob: job })
  const app = await harness(service)
  try {
    const body = await (await fetch(`${app.base}/moss-tts/last`)).json()
    assert.deepEqual(body.job, job)
  } finally {
    await app.close()
  }
})

test('POST /voices/clone 收 audio/wav，名字非法就 500 带原因', async () => {
  const { service } = fakeService({
    clone: async (name, bytes) => {
      if (!/^[\w-]{1,32}$/u.test(name)) throw new Error('音色名只能是字母/数字/_/-，最长 32')
      return { name, seconds: 12, trimmed: false, bytes: bytes.length }
    },
  })
  const app = await harness(service)
  try {
    const ok = await fetch(`${app.base}/moss-tts/voices/clone?name=me`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.alloc(1024, 7),
    })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).name, 'me')

    const bad = await fetch(`${app.base}/moss-tts/voices/clone?name=${encodeURIComponent('很长的名字!' + 'x'.repeat(40))}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.alloc(16),
    })
    assert.equal(bad.status, 500)
    assert.match((await bad.json()).error, /音色名/u)

    const wrongType = await fetch(`${app.base}/moss-tts/voices/clone?name=me`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(wrongType.status, 415)
  } finally {
    await app.close()
  }
})

test('POST /engine/* 走服务，且 POST 必须 JSON', async () => {
  const calls = []
  const { service } = fakeService({
    restartEngine: async (patch) => {
      calls.push(['restart', patch])
      return { version: '0.1.2' }
    },
    stopEngine: async () => {
      calls.push(['stop'])
      return true
    },
    health: async () => {
      calls.push(['health'])
      return { ok: true, restarted: false, status: { state: 'ready' } }
    },
  })
  const app = await harness(service)
  try {
    const restart = await fetch(`${app.base}/moss-tts/engine/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llmThreads: 2, decodeThreads: 3 }),
    })
    assert.equal(restart.status, 200)
    assert.deepEqual(calls[0], ['restart', { llmThreads: 2, decodeThreads: 3 }])

    const stop = await fetch(`${app.base}/moss-tts/engine/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(stop.status, 200)
    assert.deepEqual(calls[1], ['stop'])

    const health = await fetch(`${app.base}/moss-tts/engine/health`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(health.status, 200)
    assert.deepEqual(calls[2], ['health'])

    const wrong = await fetch(`${app.base}/moss-tts/engine/restart`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
    assert.equal(wrong.status, 415)
  } finally {
    await app.close()
  }
})

test('POST /summary 交给 announcer，空回答 400', async () => {  const seen = []
  const announcer = {
    announce: async (request) => {
      seen.push(request)
      return { text: '三步都做完了。', mode: 'llm', ms: 12 }
    },
  }
  const { service } = fakeService()
  const app = await harness(service, { announcer })
  try {
    const res = await fetch(`${app.base}/moss-tts/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', messageId: 'm1', question: '做完了吗', answer: 'x'.repeat(200) }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.text, '三步都做完了。')
    assert.equal(seen[0].maxChars, 60)
    assert.equal(seen[0].minChars, 80)

    const empty = await fetch(`${app.base}/moss-tts/summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: '  ' }),
    })
    assert.equal(empty.status, 400)
  } finally {
    await app.close()
  }
})

test('用户克隆的音色自动用 scope=user', async () => {
  const root = path.resolve('runs', 'test-routes')
  const userDir = path.join(root, 'userdata', 'voices', 'user')
  fs.mkdirSync(userDir, { recursive: true })
  fs.writeFileSync(path.join(userDir, 'myclone.mossclone'), 'x')
  const { service, state } = fakeService({ dataDir: path.join(root, 'userdata') })
  const app = await harness(service)
  try {
    const res = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好', voice: 'myclone' }),
    })
    assert.equal(res.status, 200)
    assert.equal(state.calls[0].voice, 'myclone')
    assert.equal(state.calls[0].scope, 'user')
  } finally {
    await app.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
