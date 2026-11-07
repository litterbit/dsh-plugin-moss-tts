// 真引擎协议回归：需要一台有引擎的机器。
//   MOSS_TTS_EXE / MOSS_TTS_MODELS 指过去，或者把插件仓放在引擎仓旁边。
// 没有引擎就跳过（CI 里是可选任务）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { Engine } from '../lib/host/engine.mjs'

const SIBLINGS = [path.resolve('..', 'dsh-moss-tts'), path.resolve('..', '..', 'dsh-moss-tts')]
const SIBLING = SIBLINGS.find((dir) => fs.existsSync(path.join(dir, 'csrc', 'build', 'moss_tts.exe')))
const EXE = process.env.MOSS_TTS_EXE ?? (SIBLING ? path.join(SIBLING, 'csrc', 'build', 'moss_tts.exe') : '')
const MODELS = process.env.MOSS_TTS_MODELS ?? (SIBLING ? path.join(SIBLING, 'models') : '')
const available = Boolean(EXE) && fs.existsSync(EXE) && fs.existsSync(MODELS)

const DATA = path.resolve('runs', 'test-engine', 'userdata')

function engine() {
  return new Engine({ exe: EXE, models: MODELS, data: DATA, logger: () => {} })
}

test('真引擎：info / voices / speak / cancel', { skip: !available, timeout: 300000 }, async () => {
  const tts = engine()
  try {
    const info = await tts.start()
    assert.equal(typeof info.version, 'string')
    assert.ok(info.version.length > 0)

    const voices = await tts.voices()
    assert.ok(voices.builtin.length >= 1)
    assert.ok(voices.builtin.some((voice) => typeof voice.id === 'string'))

    const chunks = []
    let began
    const job = await tts.speak({
      text: '你好，这是一次协议自检。',
      voice: voices.builtin[0].id,
      onBegin: (message) => {
        began = message
      },
      onAudio: (pcm) => chunks.push(pcm),
    })
    const done = await job.done
    assert.equal(done.state, 'completed')
    assert.equal(began?.format?.rate, 48000)
    assert.ok(chunks.length > 0)
    const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    assert.ok(bytes > 0)
    assert.equal(bytes % 4, 0, 'PCM 是 s16le 立体声，字节数必须是 4 的倍数')
    assert.ok(done.audio_ms > 0)
    // 48 kHz × 2 声道 × 2 字节 = 192 字节/毫秒
    const expectedMs = bytes / 192
    assert.ok(Math.abs(done.audio_ms - expectedMs) < 200, `audio_ms=${done.audio_ms} bytes=${bytes}`)

    // 取消：长文本第一个音频块到达后立刻取消
    let cancelling
    const long = await tts.speak({
      text: '这是一段用来测试取消的很长的文字。'.repeat(20),
      voice: voices.builtin[0].id,
      onAudio: () => {
        cancelling ??= long.cancel()
      },
    })
    const cancelled = await long.done
    assert.equal(cancelled.state, 'cancelled')
    assert.notEqual(cancelling, undefined, 'onAudio 里应该已经触发过取消')
  } finally {
    await tts.dispose()
  }
  assert.equal(tts.running, false)
})
