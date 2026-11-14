// WAV 解析/裁剪：克隆链路只信这里的结果，所以把常见坑都钉一遍。
import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectWav, sliceWav } from '../lib/host/wav.mjs'

function wav({ seconds = 1, rate = 48000, channels = 2, bits = 16, tag = 1, fill = 0 } = {}) {
  const blockAlign = Math.ceil((bits * channels) / 8)
  const frames = Math.round(seconds * rate)
  const bytes = frames * blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(tag, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(bytes, 40)
  return Buffer.concat([header, Buffer.alloc(bytes, fill)])
}

test('解析 PCM16 立体声', () => {
  const info = inspectWav(wav({ seconds: 2 }))
  assert.equal(info.pcm, true)
  assert.equal(info.rate, 48000)
  assert.equal(info.channels, 2)
  assert.equal(info.bits, 16)
  assert.equal(info.blockAlign, 4)
  assert.equal(info.frames, 96000)
  assert.equal(info.seconds, 2)
})

test('MP3-in-WAV 报真实编码，而不是块对齐', () => {
  assert.throws(() => inspectWav(wav({ tag: 0x0055, bits: 0 })), /MP3/u)
})

test('不是 RIFF 的文件要拒绝', () => {
  assert.throws(() => inspectWav(Buffer.from('hello world')), /不是 WAV/u)
})

test('float32 也认', () => {
  const info = inspectWav(wav({ tag: 3, bits: 32, seconds: 1 }))
  assert.equal(info.bits, 32)
  assert.equal(info.blockAlign, 8)
  assert.equal(info.seconds, 1)
})

test('超过 20 秒裁剪后时长/头部都对', () => {
  const source = wav({ seconds: 30, fill: 7 })
  const { wav: out, seconds } = sliceWav(source, 0, 20)
  assert.equal(seconds, 20)
  const info = inspectWav(out)
  assert.equal(info.seconds, 20)
  assert.equal(info.rate, 48000)
  assert.equal(out.length, 44 + 20 * 48000 * 4)
  assert.equal(out.subarray(44)[0], 7)
})

test('从中间截 5 秒', () => {
  const source = wav({ seconds: 30 })
  const { wav: out, start, seconds } = sliceWav(source, 12, 5)
  assert.equal(seconds, 5)
  assert.equal(start, 12)
  assert.equal(inspectWav(out).seconds, 5)
})
