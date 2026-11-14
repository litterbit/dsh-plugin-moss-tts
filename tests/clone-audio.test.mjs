// 浏览器半边的纯逻辑（不碰 DOM）：窗口规则、峰值、WAV 打包。
// 直接跑 src/client/25-clone-audio.js，和打进 lib/client.js 的是同一份源码。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(path.resolve('src', 'client', '25-clone-audio.js'), 'utf8')

function load() {
  const context = { console }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(`${SOURCE}\nglobalThis.MossCloneAudio = MossCloneAudio`, context, { filename: 'clone-audio.js' })
  return context.MossCloneAudio
}

const audio = load()

test('默认窗口：短的整段，长的取前 20 秒', () => {
  assert.deepEqual({ ...audio.defaultWindow(8) }, { start: 0, end: 8 })
  assert.deepEqual({ ...audio.defaultWindow(45) }, { start: 0, end: 20 })
})

test('拖终点超出 20 秒时窗口整段滑动', () => {
  let range = audio.defaultWindow(45)
  range = audio.dragWindow(45, range, 'end', 30)
  assert.equal(range.end, 30)
  assert.equal(range.start, 10)
  assert.equal(audio.windowLength(range), 20)
})

test('拖起点不会越过终点，且至少 1 秒', () => {
  const range = audio.dragWindow(45, { start: 5, end: 9 }, 'start', 9.5)
  assert.ok(range.end - range.start >= 1 - 1e-9)
})

test('平移保持长度并夹在边界内', () => {
  const range = audio.moveWindow(45, { start: 10, end: 30 }, -5)
  assert.deepEqual({ ...range }, { start: 0, end: 20 })
})

test('峰值归一化到 0~1', () => {
  const channels = [new Float32Array([0, 0.5, -1, 0.25]), new Float32Array([0.1, 0.2, 0.3, 0.4])]
  const bars = audio.peaks(channels, 4)
  assert.equal(bars.length, 4)
  for (const value of bars) assert.ok(value >= 0 && value <= 1)
  assert.equal(bars[2], 1)
})

test('WAV16：头部与时长都对，样点夹在不削顶的范围', () => {
  const channels = [new Float32Array(48000).fill(2), new Float32Array(48000).fill(-2)]
  const buffer = audio.buildWav16(channels, 48000)
  const view = new DataView(buffer)
  assert.equal(buffer.byteLength, 44 + 48000 * 2 * 2)
  assert.equal(String.fromCharCode(...new Uint8Array(buffer, 0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...new Uint8Array(buffer, 8, 4)), 'WAVE')
  assert.equal(view.getUint16(22, true), 2)
  assert.equal(view.getUint32(24, true), 48000)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), 48000 * 4)
  assert.equal(view.getInt16(44, true), 32767)
  assert.equal(view.getInt16(46, true), -32767)
})

test('从文件名猜音色名', () => {
  assert.equal(audio.suggestName('My Voice.mp3'), 'my-voice')
  assert.equal(audio.suggestName('录音 2024.wav'), '2024')
  assert.equal(audio.suggestName(''), 'myvoice')
})
