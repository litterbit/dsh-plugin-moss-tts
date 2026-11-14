// 插件自己的 HTTP 面：同源，所以浏览器端不需要 CORS / Private-Network 豁免。
//
// 路径全部挂在 /moss-tts/ 下。POST 一律要求 application/json（跨源必预检，
// 而我们从不回 CORS 头，等于把"随便哪个网页都能 POST 到本机"这条路堵死），
// 加上 Origin 必须与 Host 同源、Sec-Fetch-Site 不能是 cross-site。
// 唯一的例外是克隆：浏览器解码后的 WAV 以 audio/wav 原样上传。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { AUDIO_HEADER, pcmToWav } from './engine.mjs'
import { writeEngineSettings } from './settings.mjs'
import { toSpeakable } from './speech.mjs'

const PREFIX = '/moss-tts'
const MAX_TEXT = 4000
const BODY_LIMIT = {
  stream: 64 * 1024,
  prefs: 16 * 1024,
  install: 2 * 1024,
  summary: 32 * 1024,
  clone: 8 * 1024 * 1024,
}

function contentType(req) {
  return String(req.headers['content-type'] ?? '').toLowerCase()
}

function isClone(req) {
  return String(req.url ?? '').startsWith(`${PREFIX}/voices/clone`)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  const proto = req.socket?.encrypted ? 'https' : 'http'
  try {
    return new URL(origin).origin === `${proto}://${host}`
  } catch {
    return false
  }
}

function guard(req, res) {
  if (!sameOrigin(req)) {
    json(res, 403, { error: 'origin 不匹配' })
    return false
  }
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') {
    json(res, 403, { error: '拒绝跨站请求' })
    return false
  }
  if (req.method === 'POST') {
    const type = contentType(req)
    if (isClone(req)) {
      if (!type.startsWith('audio/wav') && !type.startsWith('application/octet-stream')) {
        json(res, 415, { error: '克隆需要 audio/wav' })
        return false
      }
    } else if (!type.startsWith('application/json')) {
      json(res, 415, { error: 'POST 需要 application/json' })
      return false
    }
  }
  return true
}

function json(res, status, value) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function collect(req, limit, decode) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > limit) {
      req.resume()
      reject(Object.assign(new Error('请求体过大'), { status: 413 }))
      return
    }
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', (chunk) => {
      if (overflow) return
      size += chunk.length
      if (size > limit) {
        overflow = true
        chunks.length = 0
        // 继续读完但丢弃：直接 destroy 会让客户端拿到 ECONNRESET 而不是 413
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overflow) return
      const raw = Buffer.concat(chunks)
      if (!decode) {
        resolve(raw)
        return
      }
      const text = raw.toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function readJson(req, limit) {
  return collect(req, limit, true)
}

function readBytes(req, limit) {
  return collect(req, limit, false)
}

function failure(res, error) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  json(res, error?.status ?? 500, { error: error?.message ?? String(error) })
}

/** 音色名落在哪个目录：克隆出来的音色不用调用方再告诉 scope。 */
function resolveScope(service, voice) {
  if (!voice) return 'builtin'
  try {
    return fs.existsSync(path.join(service.dataDir ?? '', 'voices', 'user', `${voice}.mossclone`)) ? 'user' : 'builtin'
  } catch {
    return 'builtin'
  }
}

function engineMissing(service) {  const state = service.status()
  if (state.state === 'ready') return undefined
  return {
    code: state.state === 'installing' ? 'installing' : 'engine-missing',
    install: state.install,
    message:
      state.state === 'installing'
        ? '引擎正在安装'
        : '本机还没有 MOSS-TTS 引擎，请在 设置 → Moss 语音 里下载（约 160 MB）',
  }
}

/** 把一段文本变成 PCM 流；headers 在首块音频到达时才发，之前的失败还能自定义状态码。 */
async function streamText(service, req, res, payload) {
  const prefs = service.prefs.get()
  const maxChars = payload.maxChars === undefined ? prefs.maxChars : Number(payload.maxChars)
  const first = toSpeakable(payload.text, { maxChars, skipCode: payload.skipCode ?? prefs.skipCode })
  // 上限 4000 是协议层的硬约束：超了按句截断，别让整条自动朗读红字失败
  const capped = first.text.length > MAX_TEXT ? toSpeakable(first.text, { maxChars: MAX_TEXT, skipCode: false }) : first
  const text = capped.text
  if (!text) throw Object.assign(new Error('没有可朗读的文字'), { status: 400 })
  if (service.status().state !== 'ready') {
    const missing = engineMissing(service)
    if (missing) {
      if (service.config.autoDownload !== false && missing.code === 'engine-missing' && !service.installer.busy) {
        service.install().catch((error) => service.log?.(`[install] ${error.message}`))
      }
      throw Object.assign(new Error(missing.message), { status: 503, payload: missing })
    }
  }

  const voice = payload.voice ?? prefs.voice
  const job = await service.speak({
    text,
    voice,
    scope: payload.scope ?? resolveScope(service, voice),
    onBegin: (message) => {
      if (res.headersSent) return
      res.setHeader('x-moss-audio-format', AUDIO_HEADER)
      if (message?.format) res.setHeader('x-moss-audio-rate', String(message.format.rate ?? 48000))
    },
    onAudio: (pcm) => {
      if (res.writableEnded || res.destroyed) return
      if (!res.headersSent) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-moss-audio-format': AUDIO_HEADER,
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        })
      }
      if (!res.write(pcm)) service.engine?.pauseOutput()
    },
  })

  // 引擎的 stdout 一旦被 pause，管道写满后引擎主线程会卡在 write 上、连 stdin 都不读了。
  // 所以不管是正常播完、客户端中断还是出错，都必须把 stdout 放出来 —— 否则下一次
  // voices / speak 会永远收不到回复（表现为工具调用卡死）。
  const resume = () => service.engine?.resumeOutput()
  res.on('drain', resume)
  res.on('finish', resume)
  const onClose = () => {
    resume()
    if (!res.writableEnded) job.cancel()
  }
  res.on('close', onClose)

  try {
    const info = await job.done
    res.removeListener('close', onClose)
    service.recordJob(info, { voice, chars: text.length })
    if (info.state === 'failed') throw new Error(info.error ?? '合成失败')
    if (!res.headersSent) {
      // 一个音频块都没出来（例如引擎判定文本为空）
      json(res, 502, { error: '引擎没有产出音频' })
      return
    }
    res.end()
  } catch (error) {
    if (!res.headersSent) throw error
    res.destroy()
  } finally {
    resume()
  }
}

export function registerRoutes(webServer, service, options = {}) {
  const log = options.logger ?? service.log ?? (() => {})
  const announcer = options.announcer
  const events = options.events
  const playback = options.playback
  const disposers = []
  const route = (kind, path, handler) => {
    const dispose = webServer.register({ kind, path: `${PREFIX}${path}`, handler })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  route('exact', '/status', (req, res) => {
    if (!guard(req, res)) return
    json(res, 200, service.status())
  })

  // 工具 → 浏览器的事件流。连接会一直挂着（浏览器半边用 EventSource 接）。
  route('exact', '/events', (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'GET') {
      json(res, 405, { error: '只接受 GET' })
      return
    }
    if (!events) {
      json(res, 503, { error: '事件通道未启用' })
      return
    }
    events.open(req, res)
  })

  // 浏览器上报播放状态（开始/暂停/继续/播完/停止），也用来查当前状态。
  route('exact', '/player', async (req, res) => {
    if (!guard(req, res)) return
    if (req.method === 'GET') {
      json(res, 200, { playback: playback?.snapshot() ?? null, clients: events?.size ?? 0 })
      return
    }
    try {
      const body = await readJson(req, BODY_LIMIT.prefs)
      playback?.update(body)
      json(res, 200, { ok: true, playback: playback?.snapshot() ?? null })
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/install', async (req, res) => {
    if (!guard(req, res)) return
    try {
      await readJson(req, BODY_LIMIT.install)
      const running = service.installer.busy
      service.install().catch((error) => log(`[install] ${error?.message ?? error}`))
      json(res, 200, { started: true, alreadyRunning: running, install: service.installer.state() })
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/install/cancel', async (req, res) => {
    if (!guard(req, res)) return
    try {
      await readJson(req, BODY_LIMIT.install)
      json(res, 200, { ok: service.cancelInstall() })
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/voices', async (req, res) => {
    if (!guard(req, res)) return
    try {
      if (service.status().state !== 'ready') {
        json(res, 200, { installed: false, builtin: [], user: [] })
        return
      }
      const voices = await service.voices(req.method === 'GET' && req.headers['x-moss-refresh'] === '1')
      json(res, 200, { installed: true, ...voices })
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/voices/clone', async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      json(res, 405, { error: '只接受 POST' })
      return
    }
    try {
      const name = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('name') ?? ''
      const bytes = await readBytes(req, BODY_LIMIT.clone)
      if (!bytes.length) {
        json(res, 400, { error: '请求体是空的' })
        return
      }
      const result = await service.clone(name, bytes)
      json(res, 200, { ok: true, ...result })
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/prefs', async (req, res) => {
    if (!guard(req, res)) return
    if (req.method === 'GET') {
      json(res, 200, { prefs: service.prefs.get() })
      return
    }
    try {
      const body = await readJson(req, BODY_LIMIT.prefs)
      const prefs = service.prefs.update(body)
      // 线程数一变就落到引擎的 settings.json；重启由 /engine/restart 负责
      if (body.llmThreads !== undefined || body.decodeThreads !== undefined) {
        writeEngineSettings(service.dataDir, prefs)
      }
      json(res, 200, { prefs })
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/last', (req, res) => {
    if (!guard(req, res)) return
    json(res, 200, { job: service.lastJob ?? null })
  })

  route('exact', '/engine/restart', async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      json(res, 405, { error: '只接受 POST' })
      return
    }
    try {
      const body = await readJson(req, BODY_LIMIT.prefs)
      const info = await service.restartEngine(body)
      json(res, 200, { ok: true, info, status: service.status() })
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/engine/stop', async (req, res) => {
    if (!guard(req, res)) return
    try {
      await readJson(req, BODY_LIMIT.install)
      const stopped = await service.stopEngine()
      json(res, 200, { ok: true, stopped, status: service.status() })
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/engine/health', async (req, res) => {
    if (!guard(req, res)) return
    try {
      await readJson(req, BODY_LIMIT.install)
      const result = await service.health()
      json(res, 200, result)
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/summary', async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      json(res, 405, { error: '只接受 POST' })
      return
    }
    try {
      const body = await readJson(req, BODY_LIMIT.summary)
      const answer = String(body.answer ?? '')
      if (!answer.trim()) {
        json(res, 400, { error: 'answer 不能为空' })
        return
      }
      const prefs = service.prefs.get()
      const result = announcer
        ? await announcer.announce({
            sessionId: String(body.sessionId ?? ''),
            messageId: String(body.messageId ?? ''),
            question: String(body.question ?? ''),
            answer,
            minChars: prefs.smartMinChars,
            maxChars: prefs.smartMaxChars,
          })
        : { text: '', mode: 'off', ms: 0 }
      json(res, 200, result)
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/stream', async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      json(res, 405, { error: '只接受 POST' })
      return
    }
    try {
      const body = await readJson(req, BODY_LIMIT.stream)
      const text = String(body.text ?? '')
      if (!text.trim()) {
        json(res, 400, { error: 'text 不能为空' })
        return
      }
      if (text.length > MAX_TEXT * 2) {
        json(res, 413, { error: `文本过长（上限 ${MAX_TEXT} 字符）` })
        return
      }
      await streamText(service, req, res, body)
    } catch (error) {
      const payload = error?.payload
      if (payload && !res.headersSent) json(res, error.status ?? 503, payload)
      else failure(res, error)
    }
  })

  route('exact', '/wav', async (req, res) => {
    if (!guard(req, res)) return
    if (req.method !== 'POST') {
      json(res, 405, { error: '只接受 POST' })
      return
    }
    try {
      const body = await readJson(req, BODY_LIMIT.stream)
      const prefs = service.prefs.get()
      const { text } = toSpeakable(body.text, {
        maxChars: Number(body.maxChars ?? prefs.maxChars),
        skipCode: body.skipCode ?? prefs.skipCode,
      })
      if (!text) {
        json(res, 400, { error: '没有可朗读的文字' })
        return
      }
      if (text.length > MAX_TEXT) {
        json(res, 413, { error: `文本过长（上限 ${MAX_TEXT} 字符）` })
        return
      }
      const missing = engineMissing(service)
      if (missing) {
        json(res, 503, missing)
        return
      }
      const voice = body.voice ?? prefs.voice
      const wav = pcmToWav(
        (await service.synthesize({ text, voice, scope: body.scope ?? resolveScope(service, voice) })).pcm,
      )
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': String(wav.length),
        'cache-control': 'no-store',
      })
      res.end(wav)
    } catch (error) {
      failure(res, error)
    }
  })

  route('exact', '/engine/reveal', async (req, res) => {
    if (!guard(req, res)) return
    try {
      await readJson(req, BODY_LIMIT.install)
      // 目录还不存在时（没装引擎）explorer 会静默什么都不做，先建出来。
      try {
        fs.mkdirSync(service.root, { recursive: true })
      } catch {
        // 建不出来就让 explorer 自己报
      }
      spawn('explorer.exe', [service.root], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
      json(res, 200, { ok: true, root: service.root })
    } catch (error) {
      failure(res, error)
    }
  })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 卸载时路由表可能已经没了
      }
    }
  }
}

export const ROUTE_PREFIX = PREFIX
