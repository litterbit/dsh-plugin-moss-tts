// 插件自己的 HTTP 面：同源，所以浏览器端不需要 CORS / Private-Network 豁免。
//
// 路径全部挂在 /moss-tts/ 下。POST 一律要求 application/json（跨源必预检，
// 而我们从不回 CORS 头，等于把"随便哪个网页都能 POST 到本机"这条路堵死），
// 加上 Origin 必须与 Host 同源、Sec-Fetch-Site 不能是 cross-site。
import { spawn } from 'node:child_process'
import fs from 'node:fs'

import { AUDIO_HEADER, pcmToWav } from './engine.mjs'
import { toSpeakable } from './speech.mjs'

const PREFIX = '/moss-tts'
const MAX_TEXT = 4000
const BODY_LIMIT = { stream: 64 * 1024, prefs: 8 * 1024, install: 2 * 1024 }

function contentType(req) {
  return String(req.headers['content-type'] ?? '').toLowerCase()
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
  if (req.method === 'POST' && !contentType(req).startsWith('application/json')) {
    json(res, 415, { error: 'POST 需要 application/json' })
    return false
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

function readJson(req, limit) {
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
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function failure(res, error) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  json(res, error?.status ?? 500, { error: error?.message ?? String(error) })
}

function engineMissing(service) {
  const state = service.status()
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
async function streamText(service, req, res, payload, options = {}) {
  const prefs = service.prefs.get()
  const words = toSpeakable(payload.text, {
    maxChars: options.maxChars ?? Number(payload.maxChars ?? prefs.maxChars),
    skipCode: payload.skipCode ?? prefs.skipCode,
  })
  const text = words.text
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

  const engine = await service.ensureEngine()
  const job = await engine.speak({
    text,
    voice: payload.voice ?? prefs.voice,
    scope: payload.scope ?? 'builtin',
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
      if (!res.write(pcm)) engine.pauseOutput()
    },
  })

  res.on('drain', () => engine.resumeOutput())
  const onClose = () => {
    if (!res.writableEnded) job.cancel()
  }
  res.on('close', onClose)

  try {
    const info = await job.done
    res.removeListener('close', onClose)
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
  }
}

export function registerRoutes(webServer, service, options = {}) {
  const log = options.logger ?? service.log ?? (() => {})
  const disposers = []
  const route = (kind, path, handler) => {
    const dispose = webServer.register({ kind, path: `${PREFIX}${path}`, handler })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  route('exact', '/status', (req, res) => {
    if (!guard(req, res)) return
    json(res, 200, service.status())
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
      const voices = await service.voices()
      json(res, 200, { installed: true, ...voices })
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
      json(res, 200, { prefs: service.prefs.update(body) })
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
      if (text.length > MAX_TEXT) {
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
      const wav = pcmToWav((await service.synthesize({ text, voice: body.voice, scope: body.scope })).pcm)
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
