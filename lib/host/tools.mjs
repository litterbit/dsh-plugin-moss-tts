// 5 个工具：直接用宿主接受的普通对象定义（标准 JSON Schema），
// 不从宿主包里 import defineTool —— 少一个"猜 asar 路径"的失败点。
import fs from 'node:fs'
import path from 'node:path'

import { playWavFile } from './play.mjs'
import { toSpeakable } from './speech.mjs'

const TEXT = (description) => ({ type: 'string', description })

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
    execute: spec.execute,
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
  },
  additionalProperties: true,
  required: ['state'],
}

export function registerTools(ctx, service, options = {}) {
  const log = options.logger ?? service.log ?? (() => {})

  if (service.status().platform !== 'win32') {
    log('[moss-tts] 引擎只有 Windows x64 构建，工具会保留但在本机不可用')
  }

  ctx.tools.register(
    tool({
      name: 'moss_tts_say',
      description:
        '用本机 MOSS-TTS 引擎把一段文字读出来（离线、CPU、不联网）。默认合成完就在本机播放，适合"把结果念给用户听"；也可以只存文件不播。',
      parameters: {
        type: 'object',
        properties: {
          text: TEXT('要朗读的文字（Markdown 会被清洗：代码块和表格不念）。'),
          voice: TEXT('音色 id，默认用设置里的音色；克隆的音色直接写名字即可。'),
          voice_scope: { type: 'string', enum: ['builtin', 'user'], description: '一般不用填：名字在用户目录里会自动当 user。' },
          save_to: TEXT('给了就写到这个 WAV 路径，不播放。'),
          play: { type: 'boolean', description: '是否在本机播放，默认 true；给了 save_to 时默认 false。' },
          max_chars: { type: 'number', description: '最多念多少字，0=不限；默认取设置值。' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          voice: { type: 'string' },
          seconds: { type: 'number' },
          compute_ms: { type: 'number' },
          first_pcm_ms: { type: 'number' },
          rtf: { type: 'number' },
          file: { type: 'string' },
          played: { type: 'boolean' },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
        required: ['voice', 'seconds', 'file', 'played'],
      },
      render: (value) =>
        `🔊 ${value.voice || '默认音色'} · ${value.seconds.toFixed(2)} s · 计算 ${Math.round(value.compute_ms ?? 0)} ms · 首音 ${Math.round(value.first_pcm_ms ?? 0)} ms · RTF ${(value.rtf ?? 0).toFixed(3)}${value.played ? '' : ' · 已存文件'}\n${value.file}`,
      timeoutMs: 300000,
      async execute(args) {
        const prefs = service.prefs.get()
        const { text, truncated } = toSpeakable(String(args.text ?? ''), {
          maxChars: args.max_chars === undefined ? prefs.maxChars : Number(args.max_chars),
          skipCode: prefs.skipCode,
        })
        if (!text) throw new Error('没有可朗读的文字')
        const voice = String(args.voice ?? prefs.voice)
        const scope = args.voice_scope ? String(args.voice_scope) : voiceScope(service, voice)
        const outDir = path.join(service.root, 'out')
        fs.mkdirSync(outDir, { recursive: true })
        const file = path.resolve(String(args.save_to ?? path.join(outDir, `say-${Date.now().toString(36)}.wav`)))
        const { info } = await service.synthesizeToFile({ text, voice, scope, file })
        const shouldPlay = args.play === undefined ? args.save_to === undefined : args.play === true
        if (shouldPlay && process.platform === 'win32') await playWavFile(file)
        return {
          voice: voice || service.status().prefs?.voice || '',
          seconds: (info.audio_ms ?? 0) / 1000,
          compute_ms: info.compute_ms ?? 0,
          first_pcm_ms: info.first_pcm_ms ?? 0,
          rtf: info.rtf ?? 0,
          file,
          played: shouldPlay,
          truncated,
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
        const stopped = await service.stop()
        return { detail: stopped ? '已请求停止。' : '当前没有正在合成的语音。' }
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
        if (action === 'install') {
          if (service.status().state === 'ready') return service.status()
          service.install().catch((error) => log(`[install] ${error?.message ?? error}`))
          return service.status()
        }
        if (action === 'reveal') {
          const { spawn } = await import('node:child_process')
          spawn('explorer.exe', [service.root], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
          return service.status()
        }
        if (action === 'stop') {
          await service.stopEngine()
          const status = service.status()
          status.running = false
          return status
        }
        if (action === 'restart') {
          const info = await service.restartEngine({
            llmThreads: args.llm_threads,
            decodeThreads: args.decode_threads,
          })
          return { ...service.status(), engineVersion: info.version }
        }
        return service.status()
      },
    }),
  )
}
