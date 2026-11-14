// 「智能摘要」：把一条长回复压成一句能念出来的话。
//
// 三条路，按代价从低到高：
//   1. 回复本来就短（< smartMinChars）→ 原样念，不花 token；
//   2. 起一个 DSH 子代理（`delivery: 'caller'`，不往父会话塞完成通知），
//      只喂 200 字提问 + 600 字回答，让它回一句 ≤60 字的中文；
//   3. 子代理不可用 / 超时 / 报错 → 本地抽取式摘要（0 token）：清洗 Markdown 后取第一句。
// 最后交给调用方决定要不要退回"固定语句"，这里永远返回一段可念的文字（除非回复是空的）。
import { toSpeakable } from './speech.mjs'

export const SUMMARY_TIMEOUT_MS = 20000
export const SUMMARY_QUESTION_CHARS = 200
export const SUMMARY_ANSWER_CHARS = 600
export const SUMMARY_LABEL = 'moss-tts-summary'
export const SUMMARY_PROMPT = [
  '你是语音播报员。根据下面这轮对话，用一句口语化的中文告诉用户结果。',
  '要求：不超过 {max} 个字；不要 Markdown、列表、引号、表情；不要复述代码；只输出这句话。',
  '',
  '用户：{question}',
  '助手（节选）：{answer}',
].join('\n')

const NOISE = [
  /^[\s"'“”‘’」』]+/u,
  /[\s"'“”‘’「『]+$/u,
  /^(好的|好|当然|没问题)[，,。！!]\s*/u,
]

function clean(text) {
  let out = String(text ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[*_`#>~]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  for (const rule of NOISE) out = out.replace(rule, '')
  return out.trim()
}

/** 取第一句（句末标点优先），没有就硬切。 */
export function extractive(text, maxChars = 60) {
  const cleaned = clean(toSpeakable(text, { maxChars: 4000, skipCode: true }).text)
  if (!cleaned) return ''
  const limit = Math.max(10, Number(maxChars) || 60)
  const window = cleaned.slice(0, limit * 2)
  const cut = window.search(/[。！？；!?;]/u)
  if (cut >= 0) {
    const sentence = window.slice(0, cut + 1)
    return sentence.length <= limit ? sentence : `${window.slice(0, limit)}…`
  }
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit)}…`
}

function summarizeAnswer(answer, maxChars) {
  const cleaned = clean(answer)
  if (!cleaned) return ''
  if (cleaned.length <= maxChars) return cleaned
  return extractive(cleaned, maxChars)
}

function timeout(ms, signal) {
  let timer
  let rejectCall
  const promise = new Promise((_, reject) => {
    rejectCall = reject
    timer = setTimeout(() => reject(new Error('摘要超时')), ms)
    timer.unref?.()
  })
  // 超时/取消都会让 race 提前结束；调用方负责 dispose 掉 activation
  promise.catch(() => {})
  const abort = () => rejectCall?.(new Error('已取消'))
  signal?.addEventListener('abort', abort, { once: true })
  return {
    promise,
    clear() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    },
  }
}

function blocksToText(output) {
  if (!Array.isArray(output)) return ''
  const parts = []
  for (const block of output) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').trim()
}

/**
 * 创建一个"播报器"。宿主服务拿不到时（headless / 服务没挂）bind 不会被调用，
 * announce 直接走抽取式 —— 调用方不需要分支。
 */
export function createAnnouncer(options = {}) {
  const log = options.logger ?? (() => {})
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : SUMMARY_TIMEOUT_MS
  let agents
  let subagents
  const cache = new Map()

  function bind(nextAgents, nextSubagents) {
    agents = nextAgents
    subagents = nextSubagents
  }

  /**
   * 找到用来"授权起子代理"的父 agent。
   *
   * 子代理是 spawn（不看父会话历史），父 agent 只负责授权，所以哪个都行：
   * 浏览器那边不一定拿得到 sessionId（composer 的 slot 不传），这时退到
   * "任意一个在线的 agent"——单会话场景就是当前会话，多会话也只是借个身份。
   */
  function pickParent(sessionId) {
    const direct = sessionId ? agents?.get?.(sessionId) : undefined
    if (direct) return direct
    const list = agents?.list?.() ?? []
    return list.find((item) => item && item.id) ?? undefined
  }

  async function viaSubagent({ sessionId, question, answer, maxChars, signal }) {
    const parent = pickParent(sessionId)
    if (!parent) return undefined
    if (!subagents || typeof subagents.startActivation !== 'function') return undefined
    const prompt = SUMMARY_PROMPT.replace('{max}', String(maxChars))
      .replace('{question}', question.slice(0, SUMMARY_QUESTION_CHARS) || '（无）')
      .replace('{answer}', answer.slice(0, SUMMARY_ANSWER_CHARS))
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const guard = timeout(timeoutMs, controller.signal)
    let activation
    const starting = subagents.startActivation({
      provider: 'spawn',
      label: SUMMARY_LABEL,
      delivery: 'caller',
      request: { parent, prompt, maxDepth: 0 },
      signal: controller.signal,
    })
    try {
      activation = await Promise.race([
        starting,
        guard.promise.then(() => {
          throw new Error('摘要启动超时')
        }),
      ])
      const result = await Promise.race([activation.result, guard.promise])
      if (result?.stopReason && result.stopReason !== 'completed') {
        throw new Error(`子代理结束状态：${result.stopReason}`)
      }
      const text = blocksToText(result?.output)
      if (!text) throw new Error('子代理没有返回文字')
      return summarizeAnswer(text, maxChars)
    } catch (error) {
      controller.abort()
      // 拒稿/超时都要把这次 activation 收掉，否则子代理会一直驻留；
      // 如果它是在超时之后才创建成功，也要在创建完成后补一刀。
      if (activation) await Promise.resolve(activation.dispose?.()).catch?.(() => {})
      else starting.then((late) => late?.dispose?.()).catch(() => {})
      throw error
    } finally {
      guard.clear()
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * @param {{sessionId?: string, messageId?: string, question?: string, answer: string, minChars?: number, maxChars?: number, signal?: AbortSignal}} request
   * @returns {Promise<{text: string, mode: 'verbatim'|'extract'|'llm', ms: number, reason?: string}>}
   */
  async function announce(request) {
    const started = Date.now()
    const answer = String(request.answer ?? '')
    const minChars = Number(request.minChars) >= 0 ? Number(request.minChars) : 80
    const maxChars = Math.max(10, Number(request.maxChars) || 60)
    const answerChars = clean(answer).length
    if (!answerChars) return { text: '', mode: 'verbatim', ms: 0 }
    if (answerChars <= minChars) {
      return { text: summarizeAnswer(answer, Math.max(maxChars, answerChars)), mode: 'verbatim', ms: 0 }
    }
    const key = `${request.sessionId ?? ''}:${request.messageId ?? ''}`
    if (request.messageId && cache.has(key)) return { ...cache.get(key), ms: Date.now() - started }

    const fallback = () => ({ text: extractive(answer, maxChars), mode: 'extract', ms: Date.now() - started })
    if (!pickParent(request.sessionId) || !subagents) {
      const result = fallback()
      log(`[summary] 没有可用的子代理（agents=${Boolean(agents)} subagents=${Boolean(subagents)}），用抽取式`)
      return result
    }
    try {
      const text = await viaSubagent({
        sessionId: request.sessionId,
        question: String(request.question ?? ''),
        answer,
        maxChars,
        signal: request.signal,
      })
      if (!text) return fallback()
      const result = { text, mode: 'llm', ms: Date.now() - started }
      if (request.messageId) {
        cache.set(key, result)
        while (cache.size > 16) cache.delete(cache.keys().next().value)
      }
      return result
    } catch (error) {
      log(`[summary] 子代理失败，回退抽取式：${error?.message ?? error}`)
      const result = fallback()
      result.reason = String(error?.message ?? error)
      return result
    }
  }

  return { bind, announce, extractive }
}
