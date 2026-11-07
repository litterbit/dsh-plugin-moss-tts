// host 端到端：真引擎 + 真 HTTP 路由（没有 DSH）。验证 /stream 的字节数、
// 格式头、/voices。没有引擎就跳过。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import { registerRoutes } from '../lib/host/routes.mjs'
import { TtsService } from '../lib/host/service.mjs'

const SIBLINGS = [path.resolve('..', 'dsh-moss-tts'), path.resolve('..', '..', 'dsh-moss-tts')]
const SIBLING = SIBLINGS.find((dir) => fs.existsSync(path.join(dir, 'csrc', 'build', 'moss_tts.exe')))
const EXE = process.env.MOSS_TTS_EXE ?? (SIBLING ? path.join(SIBLING, 'csrc', 'build', 'moss_tts.exe') : '')
const MODELS = process.env.MOSS_TTS_MODELS ?? (SIBLING ? path.join(SIBLING, 'models') : '')
const available = Boolean(EXE) && fs.existsSync(EXE) && fs.existsSync(MODELS)
const ROOT = path.resolve('runs', 'test-e2e')

async function serve(service) {
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

test('真引擎经 /stream 出 PCM，格式头与字节数一致', { skip: !available, timeout: 180000 }, async () => {
  const service = new TtsService({ config: { root: ROOT, exe: EXE, models: MODELS }, logger: () => {} })
  const app = await serve(service)
  try {
    const status = await (await fetch(`${app.base}/moss-tts/status`)).json()
    assert.equal(status.state, 'ready')

    const res = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好，我是本地语音。' }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-moss-audio-format'), 's16le;rate=48000;channels=2')
    const bytes = Buffer.from(await res.arrayBuffer())
    assert.ok(bytes.length > 48000, `音频太短：${bytes.length} 字节`)
    assert.equal(bytes.length % 4, 0)

    const voices = await (await fetch(`${app.base}/moss-tts/voices`)).json()
    assert.equal(voices.installed, true)
    assert.ok(voices.builtin.length >= 1)

    // 中断：长文本，读到第一块就 abort，服务端应当很快结束这次作业
    const controller = new AbortController()
    const long = await fetch(`${app.base}/moss-tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '这是一段用来测试中断的很长的文字。'.repeat(20) }),
      signal: controller.signal,
    })
    const reader = long.body.getReader()
    await reader.read()
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(service.engine?.active, undefined, '中断后引擎不应还挂着作业')
  } finally {
    await app.close()
    await service.dispose()
  }
})
