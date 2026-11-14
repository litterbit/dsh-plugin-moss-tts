// 5 个工具：直接用宿主接受的普通对象定义（标准 JSON Schema），
// 不从宿主包里 import defineTool —— 少一个"猜 asar 路径"的失败点。
import fs from 'node:fs'
import path from 'node:path'

import { playWavFile, playWavFileDetached, stopPlayback } from './play.mjs'
import { toSpeakable } from './speech.mjs'

const TEXT = (description) => ({ type: 'string', description })
// 和 /stream 的协议上限一致；超过就按句截断，别让整段朗读 413
const MAX_STREAM_CHARS = 4000

/**
 * 宿主对工具输出的要求是"lossless JSON"：`undefined`、NaN、函数都会让整次调用失败
 * （界面上的 "value is not lossless JSON" 就是这么来的）。status() 里必然有
 * undefined 字段，所以统一在这里剔掉。
 */
function jsonSafe(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(jsonSafe).filter((item) => item !== undefined)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item)
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  return undefined
}

function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: spec.output,
      render: (_args, value) => [{ type: 'text', text: spec.render(value) }],
    },
    ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    execute: async (...args) => jsonSafe(await spec.execute(...args)),
  }
}

/** 音色名落在哪个目录：用户克隆的音色不需要调用方再补 voice_scope。 */
function voiceScope(service, voice) {
  if (!voice) return 'builtin'
  try {
    const file = path.join(service.dataDir, 'voices', 'user', `${voice}.mossclone`)
    return fs.existsSync(file) ? 'user' : 'builtin'
  } catch {
    return 'builtin'
  }
}

const engineSchema = {
  type: 'object',
  properties: {
    state: TEXT('missing / installing / ready / error'),
    running: { type: 'boolean', description: '引擎进程是否在跑' },
    version: TEXT('引擎版本'),
    exe: TEXT('引擎可执行文件路径'),
    models: TEXT('权重目录'),
    engine: {
      type: 'object',
      properties: {
        llm_threads: { type: 'number' },
        decode_threads: { type: 'number' },
        backend: TEXT('avx2 / scalar'),
        physical_cores: { type: 'number' },
      },
      additionalProperties: true,
    },
    install: {
      type: 'object',
      properties: {
        phase: TEXT('download / verify / extract / ready'),
        downloaded: { type: 'number' },
        total: { type: 'number' },
      },
      additionalProperties: true,
    },
    prefs: { type: 'object', additionalProperties: true },
    playback: {
      type: 'object',
      properties: {
        state: TEXT('idle / starting / speaking / paused / draining / done'),
        voice: TEXT('正在播的音色'),
        played: { type: 'number', description: '已播秒数' },
        total: { type: 'number', description: '总秒数（还在合成时为 0）' },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
  required: ['state'],
}

export function registerTools(ctx, service, options = {}) {
  const log = options.logger ?? service.log ?? (() => {})
  const events = options.events
  const playback = options.playback

  if (service.status().platform !== 'win32') {
    log('[moss-tts] 引擎只有 Windows x64 构建，工具会保留但在本机不可用')
  }

  ctx.tools.register(
    tool({
      name: 'moss_tts_say',
      description:
        '用本机 MOSS-TTS 引擎把一段文字读出来（离线、CPU、不联网）。浏览器在场时边合成边播、立刻返回，界面上可以暂停/停止/重播；没有浏览器才退回"落盘 + 系统播放器"。需要等播完再设 wait=true；只存文件用 save_to。',
      parameters: {
        type: 'object',
        properties: {
          text: TEXT('要朗读的文字（Markdown 会被清洗：代码块和表格不念）。'),
          voice: TEXT('音色 id，默认用设置里的音色；克隆的音色直接写名字即可。'),
          voice_scope: { type: 'string', enum: ['builtin', 'user'], description: '一般不用填：名字在用户目录里会自动当 user。' },
          save_to: TEXT('给了就写到这个 WAV 路径，不播放。'),
          play: { type: 'boolean', description: '是否播放，默认 true；给了 save_to 时默认 false。' },
          wait: { type: 'boolean', description: '是否等音频播完再返回，默认 false（开始播放就返回）。' },
          max_chars: { type: 'number', description: '最多念多少字，0=不限；默认取设置值。' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          voice: { type: 'string' },
          mode: { type: 'string', description: 'stream（浏览器流式播放）/ file（落盘后播放或存文件）' },
          started: { type: 'boolean' },
          chars: { type: 'number' },
          seconds: { type: 'number' },
          compute_ms: { type: 'number' },
          first_pcm_ms: { type: 'number' },
          rtf: { type: 'number' },
          file: { type: 'string' },
          played: { type: 'boolean' },
          background: { type: 'boolean' },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
        required: ['voice', 'played'],
      },
      render: (value) => {
        const head = `🔊 ${value.voice || '默认音色'}`
        if (value.mode === 'stream') {
          const tail = value.background ? '已开始播放（输入框上方可暂停 / 停止 / 重播）' : '已播完'
          return `${head} · ${value.chars} 字 · ${tail}`
        }
        const timing =
          value.seconds === undefined
            ? ''
            : ` · ${value.seconds.toFixed(2)} s · 计算 ${Math.round(value.compute_ms ?? 0)} ms · 首音 ${Math.round(value.first_pcm_ms ?? 0)} ms · RTF ${(value.rtf ?? 0).toFixed(3)}`
        const tail = value.played ? (value.background ? ' · 正在后台播放' : '') : ' · 已存文件'
        return `${head}${timing}${tail}${value.file ? `\n${value.file}` : ''}`
      },
      timeoutMs: 300000,
      async execute(args) {
        const prefs = service.prefs.get()
        const limit = args.max_chars === undefined ? prefs.maxChars : Number(args.max_chars)
        const first = toSpeakable(String(args.text ?? ''), { maxChars: limit, skipCode: prefs.skipCode })
        if (!first.text) throw new Error('没有可朗读的文字')
        const voice = String(args.voice ?? prefs.voice)
        const scope = args.voice_scope ? String(args.voice_scope) : voiceScope(service, voice)
        const shouldPlay = args.play === undefined ? args.save_to === undefined : args.play === true
        const wait = args.wait === true

        // 首选：把话交给浏览器（边合成边播，工具立刻返回）。
        // 浏览器不在线（CLI / 界面没开）时下面的落盘路径照旧。
        let handled
        if (shouldPlay && (events?.size ?? 0) > 0) {
          const status = service.status()
          if (status.state !== 'ready') {
            throw new Error(
              status.state === 'installing' ? '引擎正在安装，装完再读' : '本机还没有安装 MOSS-TTS 引擎（设置 → Moss 语音）',
            )
          }
          const spoken =
            first.text.length > MAX_STREAM_CHARS
              ? toSpeakable(first.text, { maxChars: MAX_STREAM_CHARS, skipCode: false })
              : { text: first.text, truncated: false }
          const id = `say-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
          playback?.start(id, { voice, chars: spoken.text.length })
          if (events.send({ type: 'say', id, text: spoken.text, voice, maxChars: 0 }) > 0) {
            handled = { id, truncated: first.truncated || spoken.truncated }
          } else {
            playback?.end('idle')
          }
        }

        if (handled) {
          // wait=true 等浏览器报"播完/被停"；默认立刻把控制权还给 agent
          const state = wait ? ((await playback?.wait(handled.id)) ?? 'done') : 'playing'
          const total = playback?.snapshot().total ?? 0
          return {
            voice,
            mode: 'stream',
            started: true,
            chars: first.text.length,
            played: true,
            background: !wait,
            truncated: handled.truncated,
            ...(wait && total > 0 ? { seconds: total } : {}),
          }
        }

        const outDir = path.join(service.root, 'out')
        fs.mkdirSync(outDir, { recursive: true })
        const file = path.resolve(String(args.save_to ?? path.join(outDir, `say-${Date.now().toString(36)}.wav`)))
        const { info } = await service.synthesizeToFile({ text: first.text, voice, scope, file })
        let background = false
        if (shouldPlay && process.platform === 'win32') {
          if (wait) await playWavFile(file)
          else {
            playWavFileDetached(file)
            background = true
          }
        }
        return {
          voice: voice || prefs.voice || '',
          mode: 'file',
          started: shouldPlay,
          chars: first.text.length,
          seconds: (info.audio_ms ?? 0) / 1000,
          compute_ms: info.compute_ms ?? 0,
          first_pcm_ms: info.first_pcm_ms ?? 0,
          rtf: info.rtf ?? 0,
          file,
          played: shouldPlay,
          background,
          truncated: first.truncated,
        }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'moss_tts_voices',
      description: '列出本机可用的 MOSS-TTS 音色（内置 + 自己克隆的），并标出当前默认音色。',
      output: {
        type: 'object',
        properties: { detail: TEXT('音色清单') },
        additionalProperties: false,
        required: ['detail'],
      },
      render: (value) => value.detail,
      // 引擎被 stdout 背压卡住时，别让工具调用无限期挂着（超时后 UI 能报错）
      timeoutMs: 20000,
      async execute() {
        if (service.status().state !== 'ready') {
          return { detail: '本机还没有安装 MOSS-TTS 引擎。打开 设置 → Moss 语音 → 下载引擎（约 160 MB）。' }
        }
        const { builtin, user, default: fallback } = await service.voices()
        const active = service.prefs.get().voice || fallback || ''
        const label = (voice) => {
          const name = voice.label && voice.label !== voice.id ? `${voice.id}（${voice.label}）` : voice.id
          return voice.id === active ? `${name} ← 当前默认` : name
        }
        const lines = [`内置（${builtin.length}）：${builtin.map(label).join('、') || '（空）'}`]
        if (user.length) {
          lines.push(`我的（${user.length}）：${user.map((v) => `${label(v)}(${Number(v.seconds ?? 0).toFixed(1)}s)`).join('、')}`)
        }
        if (fallback) lines.push(`引擎默认：${fallback}`)
        return { detail: lines.join('\n') }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'moss_tts_stop',
      description: '立刻停止当前正在合成或播放的语音。',
      output: {
        type: 'object',
        properties: { detail: TEXT('结果') },
        additionalProperties: false,
        required: ['detail'],
      },
      render: (value) => value.detail,
      async execute() {
        const synthesizing = await service.stop()
        const streaming = playback?.busy() === true
        // 浏览器那边的播放（工具的 / 自动朗读的）只能靠事件流叫停
        events?.send({ type: 'stop' })
        playback?.end('stopped')
        const local = stopPlayback()
        if (synthesizing || streaming || local) return { detail: '已停止。' }
        return { detail: '已发送停止请求（界面上的朗读会一起停）。' }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'moss_tts_clone',
      description: '用一段参考音频创建克隆音色（PCM WAV；超过 20 秒会自动截前 20 秒）。压缩格式请让用户在设置页拖入，浏览器会解码。',
      parameters: {
        type: 'object',
        properties: {
          name: TEXT('音色名（字母/数字/_/-，≤32）。'),
          wav_path: TEXT('参考音频的 PCM WAV 路径（超过 20 秒会自动截断）。'),
        },
        required: ['name', 'wav_path'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          detail: TEXT('结果'),
          seconds: { type: 'number' },
          trimmed: { type: 'boolean' },
        },
        additionalProperties: false,
        required: ['detail'],
      },
      render: (value) => value.detail,
      timeoutMs: 300000,
      async execute(args) {
        const name = String(args.name ?? '').trim()
        if (!/^[\w-]{1,32}$/u.test(name)) throw new Error('name 只能是字母/数字/_/-，≤32')
        const file = path.resolve(String(args.wav_path ?? ''))
        if (!fs.existsSync(file)) throw new Error(`找不到文件：${file}`)
        const result = await service.clone(name, fs.readFileSync(file))
        const tail = result.trimmed ? `（原音频较长，已截前 ${result.seconds.toFixed(1)} 秒）` : ''
        return {
          detail: `音色 ${name} 已创建${tail}；之后 voice="${name}" 即可直接使用。`,
          seconds: result.seconds,
          trimmed: result.trimmed,
        }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'moss_tts_engine',
      description:
        '查看或管理本机 MOSS-TTS 引擎：status（状态/线程/耗时）、install（下载）、restart（重启，可带线程数）、stop（卸载释放内存）、reveal（打开目录）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'install', 'restart', 'stop', 'reveal'], description: '要做什么。' },
          llm_threads: { type: 'number', description: 'restart 时顺带设置 LLM 线程数（0=自动）。' },
          decode_threads: { type: 'number', description: 'restart 时顺带设置解码器线程数（0=自动）。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: engineSchema,
      render: (value) => {
        const lines = [`状态：${value.state}${value.version ? `（v${value.version}）` : ''}${value.running ? ' · 进程在跑' : ' · 进程未启动'}`]
        const engine = value.engine
        if (engine) lines.push(`线程：LLM ${engine.llm_threads} · 解码 ${engine.decode_threads} · ${engine.backend ?? '?'} · ${engine.physical_cores ?? '?'} 核`)
        if (value.exe) lines.push(`exe：${value.exe}`)
        if (value.models) lines.push(`权重：${value.models}`)
        if (value.playback) {
          const now = value.playback
          const clock = now.total > 0 ? ` · ${now.played.toFixed(1)}/${now.total.toFixed(1)} s` : ''
          lines.push(`播放：${now.state}${now.voice ? ` · ${now.voice}` : ''}${clock}`)
        }
        if (value.lastJob?.audio_ms) {
          lines.push(
            `上次：${(value.lastJob.audio_ms / 1000).toFixed(2)} s 音频 / 计算 ${Math.round(value.lastJob.compute_ms)} ms / 首音 ${Math.round(value.lastJob.first_pcm_ms)} ms`,
          )
        }
        if (value.install?.phase && value.install.phase !== 'idle' && value.install.phase !== 'ready') {
          lines.push(`安装：${value.install.phase} ${value.install.downloaded ?? 0}/${value.install.total ?? 0} 字节`)
        }
        return lines.join('\n')
      },
      timeoutMs: 120000,
      async execute(args) {
        const action = String(args.action ?? 'status')
        // 播放状态由浏览器上报，和引擎状态拼在一起给 agent 看
        const status = () => {
          const value = service.status()
          const now = playback?.snapshot()
          return now && now.state !== 'idle' ? { ...value, playback: now } : value
        }
        if (action === 'install') {
          if (service.status().state === 'ready') return status()
          service.install().catch((error) => log(`[install] ${error?.message ?? error}`))
          return status()
        }
        if (action === 'reveal') {
          const { spawn } = await import('node:child_process')
          spawn('explorer.exe', [service.root], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
          return status()
        }
        if (action === 'stop') {
          await service.stopEngine()
          const value = status()
          value.running = false
          return value
        }
        if (action === 'restart') {
          const info = await service.restartEngine({
            llmThreads: args.llm_threads,
            decodeThreads: args.decode_threads,
          })
          return { ...status(), engineVersion: info.version }
        }
        return status()
      },
    }),
  )
}
