// 文本清洗 + 偏好归一化：都是纯函数，跑得飞快。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_PREFS, Prefs, normalizePrefs } from '../lib/host/prefs.mjs'
import { toSpeakable } from '../lib/host/speech.mjs'

test('代码块与表格不念', () => {
  const markdown = [
    '先看这段代码：',
    '```js',
    'console.log("hello")',
    '```',
    '然后看表：',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '结论是**可以**。',
  ].join('\n')
  const { text } = toSpeakable(markdown)
  assert.equal(text.includes('console.log'), false)
  assert.equal(text.includes('|'), false)
  assert.equal(text.includes('**'), false)
  assert.match(text, /先看这段代码/u)
  assert.match(text, /结论是可以/u)
})

test('链接保留文字、图片保留 alt、行内代码去反引号', () => {
  const { text } = toSpeakable('见 [文档](https://x.y) 和 ![截图](a.png)，运行 `npm test` 即可。')
  assert.match(text, /见 文档 和 截图/u)
  assert.match(text, /运行 npm test 即可/u)
  assert.equal(text.includes('https://'), false)
  assert.equal(text.includes('`'), false)
})

test('标题/列表/引用符号去掉，中文换行补逗号', () => {
  const { text } = toSpeakable('# 标题\n- 第一条\n- 第二条\n> 引用一句')
  assert.equal(text.includes('#'), false)
  assert.equal(text.includes('- '), false)
  assert.equal(text.includes('>'), false)
  assert.match(text, /第一条/u)
  assert.match(text, /引用一句/u)
})

test('按句末截断，不切半句', () => {
  const text = '第一句话。第二句话。第三句话。第四句话。'
  const result = toSpeakable(text, { maxChars: 12 })
  assert.equal(result.truncated, true)
  assert.ok(result.text.length <= 12)
  assert.match(result.text, /。$/u)
})

test('maxChars=0 表示不限', () => {
  const text = '长'.repeat(5000)
  const result = toSpeakable(text, { maxChars: 0 })
  assert.equal(result.truncated, false)
  assert.equal(result.text.length, 5000)
})

test('空白不会把整段吃掉', () => {
  const { text } = toSpeakable('你好\n\n\n世界')
  assert.match(text, /你好/u)
  assert.match(text, /世界/u)
})

test('normalizePrefs 只认已知字段并夹范围', () => {
  const prefs = normalizePrefs({ voice: '  Xiaoyu  ', maxChars: -5, autoRead: 'true', evil: 1 })
  assert.equal(prefs.voice, 'Xiaoyu')
  assert.equal(prefs.maxChars, 0)
  assert.equal(prefs.autoRead, true)
  assert.equal('evil' in prefs, false)
  const huge = normalizePrefs({ maxChars: 1e9 })
  assert.equal(huge.maxChars, 20000)
  const bad = normalizePrefs({ voice: '', maxChars: 'abc' })
  assert.equal(bad.voice, DEFAULT_PREFS.voice)
  assert.equal(bad.maxChars, DEFAULT_PREFS.maxChars)
})

test('Prefs 落盘后能读回，坏文件退默认', () => {
  const dir = path.resolve('runs', 'test-prefs')
  fs.rmSync(dir, { recursive: true, force: true })
  const file = path.join(dir, 'prefs.json')
  const prefs = new Prefs(file)
  assert.deepEqual(prefs.get(), { ...DEFAULT_PREFS })
  prefs.update({ autoRead: true, maxChars: 300 })
  const again = new Prefs(file)
  assert.equal(again.get().autoRead, true)
  assert.equal(again.get().maxChars, 300)
  fs.writeFileSync(file, '{ broken')
  assert.deepEqual(new Prefs(file).get(), { ...DEFAULT_PREFS })
})

test('0.1.x 的旧 prefs：升级后保持读全文，Junhao 退回引擎默认', () => {
  const dir = path.resolve('runs', 'test-prefs-legacy')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'prefs.json')
  fs.writeFileSync(file, JSON.stringify({ voice: 'Junhao', autoRead: true, maxChars: 800, skipCode: true }))
  const value = new Prefs(file).get()
  assert.equal(value.speakMode, 'full')
  assert.equal(value.voice, '')
  assert.equal(value.autoRead, true)
  assert.equal(value.maxChars, 800)
  assert.equal(value.idleUnloadMinutes, DEFAULT_PREFS.idleUnloadMinutes)
})
