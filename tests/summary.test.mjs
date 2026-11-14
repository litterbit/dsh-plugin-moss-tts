// 智能摘要：短回复不花 token、子代理失败要退化成抽取式、同一条消息只算一次。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createAnnouncer, extractive, SUMMARY_ANSWER_CHARS, SUMMARY_QUESTION_CHARS } from '../lib/host/summary.mjs'

const LONG = '我把设置页重写了一遍，并补上了克隆音色的入口。'.repeat(6)

test('抽取式：第一句 + 截断', () => {
  assert.equal(extractive('任务完成了。后面还有很多无关内容。', 60), '任务完成了。')
  const long = extractive('这是一句没有句号的很长很长的中文内容需要被截断处理一下下', 10)
  assert.ok(long.length <= 11)
})

test('短回复原样念，不碰子代理', async () => {
  let called = 0
  const announcer = createAnnouncer()
  announcer.bind(
    { get: () => ({ id: 'agent' }) },
    { startActivation: async () => { called += 1 } },
  )
  const result = await announcer.announce({ sessionId: 's', messageId: 'm', answer: '好了。' })
  assert.equal(result.mode, 'verbatim')
  assert.equal(result.text, '好了。')
  assert.equal(called, 0)
})

test('没有 agents/subagents 时退化成抽取式', async () => {
  const announcer = createAnnouncer()
  const result = await announcer.announce({ sessionId: 's', messageId: 'm', answer: LONG })
  assert.equal(result.mode, 'extract')
  assert.ok(result.text.length <= 61)
})

test('子代理成功：截断输入、返回一句话、同 messageId 命中缓存', async () => {
  const seen = []
  const announcer = createAnnouncer({
    logger: () => {},
  })
  announcer.bind(
    { get: () => ({ id: 'agent' }) },
    {
      startActivation: async (spec) => {
        seen.push(spec)
        return {
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '"设置页和克隆都做完了。"' }] }),
          dispose: async () => {},
        }
      },
    },
  )
  const result = await announcer.announce({
    sessionId: 's',
    messageId: 'm',
    question: '进展如何'.repeat(100),
    answer: LONG,
    maxChars: 60,
  })
  assert.equal(result.mode, 'llm')
  assert.equal(result.text, '设置页和克隆都做完了。')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, 'spawn')
  assert.equal(seen[0].delivery, 'caller')
  assert.equal(seen[0].request.maxDepth, 0)
  assert.ok(seen[0].request.prompt.length < 1200)
  assert.ok(seen[0].request.prompt.includes('用户：'))
  assert.ok(seen[0].request.prompt.length < SUMMARY_QUESTION_CHARS + SUMMARY_ANSWER_CHARS + 400)

  const again = await announcer.announce({ sessionId: 's', messageId: 'm', question: 'x', answer: LONG })
  assert.equal(again.mode, 'llm')
  assert.equal(seen.length, 1, '同一条消息不该再起一次子代理')
})

test('子代理失败 → 抽取式，并且 dispose 被调用', async () => {
  let disposed = 0
  const announcer = createAnnouncer({ logger: () => {}, timeoutMs: 50 })
  announcer.bind(
    { get: () => ({ id: 'agent' }) },
    {
      startActivation: async () => ({
        result: Promise.resolve({ stopReason: 'error', output: [] }),
        dispose: async () => {
          disposed += 1
        },
      }),
    },
  )
  const result = await announcer.announce({ sessionId: 's', messageId: 'm2', answer: LONG })
  assert.equal(result.mode, 'extract')
  assert.ok(disposed >= 1)
})

test('父会话不在线 → 抽取式', async () => {
  let called = 0
  const announcer = createAnnouncer()
  announcer.bind({ get: () => undefined }, { startActivation: async () => { called += 1 } })
  const result = await announcer.announce({ sessionId: 'gone', messageId: 'm', answer: LONG })
  assert.equal(result.mode, 'extract')
  assert.equal(called, 0)
})

test('拿不到 sessionId 时借一个在线 agent 授权（spawn 子代理不看父历史）', async () => {
  let parent
  const announcer = createAnnouncer({ logger: () => {} })
  announcer.bind(
    {
      get: () => undefined,
      list: () => [{ id: 'live-agent' }],
    },
    {
      startActivation: async (spec) => {
        parent = spec.request.parent
        return {
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '都做完了。' }] }),
          dispose: async () => {},
        }
      },
    },
  )
  const result = await announcer.announce({ sessionId: '', messageId: 'm3', answer: LONG })
  assert.equal(result.mode, 'llm')
  assert.equal(parent.id, 'live-agent')
})
