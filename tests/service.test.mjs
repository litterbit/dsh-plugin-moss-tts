// 宿主服务：串行化、线程落盘、空闲卸载、克隆裁剪。
// 引擎是假的（createEngine 注入），验的是调度逻辑而不是合成质量。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { TtsService } from '../lib/host/service.mjs'
import { readEngineSettings, writeEngineSettings } from '../lib/host/settings.mjs'

const ROOT = path.resolve('runs', 'test-service')
fs.rmSync(ROOT, { recursive: true, force: true })

function pcm16(seconds = 1) {
  const frames = Math.round(seconds * 48000)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + frames * 4, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(48000, 24)
  header.writeUInt32LE(192000, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(frames * 4, 40)
  return Buffer.concat([header, Buffer.alloc(frames * 4)])
}

function makeService(engineFactory) {
  const service = new TtsService({
    config: { root: ROOT, autoDownload: false },
    logger: () => {},
    createEngine: engineFactory,
  })
  service.installer = {
    busy: false,
    state: () => ({ phase: 'ready', downloaded: 0, total: 0 }),
    start: async () => {},
    cancel: () => true,
    ensure: async () => ({ exe: 'fake.exe', models: 'fake-models' }),
  }
  return service
}

test('两句话串行：第一句不被取消，第二句等它结束', async () => {
  const order = []
  const cancels = []
  let live
  const service = makeService(() => ({
    exe: 'fake.exe',
    models: 'fake-models',
    running: false,
    info: { version: '0.1.2', engine: { llm_threads: 2, decode_threads: 3 } },
    async start() {
      this.running = true
      return this.info
    },
    async stop() {
      this.running = false
      return true
    },
    async speak(options) {
      live = options.text
      const id = `job-${order.length + 1}`
      const done = new Promise((resolve) => {
        setTimeout(() => {
          order.push(options.text)
          resolve({ state: 'completed', audio_ms: 100, compute_ms: 10 })
        }, 15)
      })
      return {
        id,
        done,
        cancel: () => {
          cancels.push(options.text)
        },
      }
    },
    async clone() {
      return { ok: true }
    },
    async voices() {
      return { builtin: [], user: [] }
    },
    async dispose() {},
  }))

  const first = await service.speak({ text: '第一句', onAudio: () => {} })
  const second = await service.speak({ text: '第二句', onAudio: () => {} })
  await first.done
  await second.done
  assert.deepEqual(order, ['第一句', '第二句'])
  assert.deepEqual(cancels, [], '串行队列里不该取消上一句')
  assert.equal(live, '第二句')
  await service.dispose()
})

test('保存线程数写进引擎的 settings.json，并在重启后读到', async () => {
  const service = makeService(() => ({
    exe: 'fake.exe',
    models: 'fake-models',
    running: false,
    info: { version: '0.1.2', engine: { llm_threads: 0, decode_threads: 0 } },
    async start() {
      this.running = true
      return this.info
    },
    async stop() {
      this.running = false
      return true
    },
    async dispose() {},
  }))
  await service.restartEngine({ llmThreads: 4, decodeThreads: 6 })
  const file = readEngineSettings(path.join(ROOT, 'userdata'))
  assert.equal(file.llmThreads, 4)
  assert.equal(file.decodeThreads, 6)
  assert.equal(service.prefs.get().llmThreads, 4)
  await service.dispose()
})

test('引擎 settings.json 里的旧值会被采纳进偏好（不会偷偷覆盖）', async () => {
  writeEngineSettings(path.join(ROOT, 'userdata'), { llmThreads: 3, decodeThreads: 5 })
  const service = makeService(() => ({
    exe: 'fake.exe',
    models: 'fake-models',
    running: false,
    info: { version: '0.1.2', engine: { llm_threads: 3, decode_threads: 5 } },
    async start() {
      this.running = true
      return this.info
    },
    async stop() {
      this.running = false
      return true
    },
    async dispose() {},
  }))
  // 先清掉 prefs 缓存：上一个用例可能已经写过 4/6
  fs.rmSync(path.join(ROOT, 'plugin', 'prefs.json'), { force: true })
  service.prefs.cache = undefined
  await service.ensureEngine()
  assert.equal(service.prefs.get().llmThreads, 3)
  assert.equal(service.prefs.get().decodeThreads, 5)
  await service.dispose()
})

test('克隆：>20 秒自动截断，非 PCM 直接拒绝', async () => {
  let sent
  const service = makeService(() => ({
    exe: 'fake.exe',
    models: 'fake-models',
    running: false,
    info: { version: '0.1.2', engine: {} },
    async start() {
      this.running = true
      return this.info
    },
    async stop() {
      return true
    },
    async clone(name, bytes) {
      sent = { name, bytes }
      return { name }
    },
    async dispose() {},
  }))
  const result = await service.clone('me', pcm16(25))
  assert.equal(result.trimmed, true)
  assert.equal(result.seconds, 20)
  assert.equal(sent.name, 'me')
  assert.ok(sent.bytes.length < pcm16(25).length)

  const bad = Buffer.from(pcm16(1))
  bad.writeUInt16LE(0x0055, 20)
  bad.writeUInt16LE(0, 34)
  await assert.rejects(() => service.clone('me', bad), /MP3/u)
  await service.dispose()
})

test('空闲卸载：0 分钟不挂计时器，>0 才会安排', async () => {
  const service = makeService(() => ({
    exe: 'fake.exe',
    models: 'fake-models',
    running: false,
    info: { version: '0.1.2', engine: {} },
    async start() {
      this.running = true
      return this.info
    },
    async stop() {
      this.running = false
      return true
    },
    async dispose() {},
  }))
  service.prefs.update({ idleUnloadMinutes: 0 })
  service.touch()
  assert.equal(service.idleTimer, undefined)
  service.prefs.update({ idleUnloadMinutes: 1 })
  service.touch()
  assert.notEqual(service.idleTimer, undefined)
  clearTimeout(service.idleTimer)
  await service.dispose()
})

test('一次失败不会毒化队列：下一句照常合成', async () => {
  let calls = 0
  const service = makeService(() => ({
    exe: 'fake.exe',
    models: 'fake-models',
    running: false,
    info: { version: '0.1.2', engine: {} },
    async start() {
      this.running = true
      return this.info
    },
    async stop() {
      this.running = false
      return true
    },
    async speak() {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return { id: 'ok', done: Promise.resolve({ state: 'completed', audio_ms: 10 }), cancel: () => {} }
    },
    async dispose() {},
  }))
  await assert.rejects(() => service.speak({ text: 'a', onAudio: () => {} }), /boom/u)
  const job = await service.speak({ text: 'b', onAudio: () => {} })
  assert.equal((await job.done).state, 'completed')
  assert.equal(service.active, 0)
  await service.dispose()
})
