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

const engineSchema = {
  type: 'object',
  properties: {
    state: TEXT('missing / installing / ready / error'),
    version: TEXT('引擎版本'),
    exe: TEXT('引擎可执行文件路径'),
    models: TEXT('权重目录'),
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
          voice: TEXT('音色 id，默认用设置里的音色。'),
          voice_scope: { type: 'string', enum: ['builtin', 'user'], description: 'builtin=内置音色，user=自己克隆的音色。' },
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
          rtf: { type: 'number' },
          file: { type: 'string' },
          played: { type: 'boolean' },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
        required: ['voice', 'seconds', 'file', 'played'],
      },
      render: (value) =>
        `🔊 ${value.voice} · ${value.seconds.toFixed(2)} s · 计算 ${Math.round(value.compute_ms ?? 0)} ms · RTF ${(value.rtf ?? 0).toFixed(3)}${value.played ? '' : ' · 已存文件'}\n${value.file}`,
      timeoutMs: 180000,
      async execute(args) {
        const prefs = service.prefs.get()
        const { text, truncated } = toSpeakable(String(args.text ?? ''), {
          maxChars: args.max_chars === undefined ? prefs.maxChars : Number(args.max_chars),
          skipCode: prefs.skipCode,
        })
        if (!text) throw new Error('没有可朗读的文字')
        const voice = String(args.voice ?? prefs.voice)
        const scope = String(args.voice_scope ?? 'builtin')
        const outDir = path.join(service.root, 'out')
        fs.mkdirSync(outDir, { recursive: true })
        const file = path.resolve(String(args.save_to ?? path.join(outDir, `say-${Date.now().toString(36)}.wav`)))
        const { info } = await service.synthesizeToFile({ text, voice, scope, file })
        const shouldPlay = args.play === undefined ? args.save_to === undefined : args.play === true
        if (shouldPlay && process.platform === 'win32') await playWavFile(file)
        return {
          voice,
          seconds: (info.audio_ms ?? 0) / 1000,
          compute_ms: info.compute_ms ?? 0,
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
      description: '列出本机可用的 MOSS-TTS 音色（内置 + 自己克隆的）。',
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
        const { builtin, user } = await service.voices()
        const lines = [`内置（${builtin.length}）：${builtin.map((v) => v.id).join('、') || '（空）'}`]
        if (user.length) lines.push(`我的（${user.length}）：${user.map((v) => `${v.id}(${Number(v.seconds ?? 0).toFixed(1)}s)`).join('、')}`)
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
      description: '用一段 5~15 秒的 WAV 参考音频创建克隆音色，存到本机用户音色目录。',
      parameters: {
        type: 'object',
        properties: {
          name: TEXT('音色名（字母/数字/_/-，≤32）。'),
          wav_path: TEXT('参考音频的 WAV 路径（PCM；压缩格式先转）。'),
        },
        required: ['name', 'wav_path'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { detail: TEXT('结果') },
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
        await service.clone(name, fs.readFileSync(file))
        return { detail: `音色 ${name} 已创建；之后用 voice="${name}" + voice_scope="user" 使用。` }
      },
    }),
  )

  ctx.tools.register(
    tool({
      name: 'moss_tts_engine',
      description: '查看或安装本机 MOSS-TTS 引擎（status 看状态，install 开始下载，reveal 打开安装目录）。',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['status', 'install', 'reveal'], description: '要做什么。' } },
        required: ['action'],
        additionalProperties: false,
      },
      output: engineSchema,
      render: (value) => {
        const lines = [`状态：${value.state}${value.version ? `（v${value.version}）` : ''}`]
        if (value.exe) lines.push(`exe：${value.exe}`)
        if (value.models) lines.push(`权重：${value.models}`)
        if (value.install?.phase && value.install.phase !== 'idle' && value.install.phase !== 'ready') {
          lines.push(`安装：${value.install.phase} ${value.install.downloaded ?? 0}/${value.install.total ?? 0} 字节`)
        }
        return lines.join('\n')
      },
      timeoutMs: 20000,
      async execute(args) {
        const action = String(args.action ?? 'status')
        if (action === 'install') {
          if (service.status().state === 'ready') return { ...service.status(), state: 'ready' }
          service.install().catch((error) => log(`[install] ${error?.message ?? error}`))
          return service.status()
        }
        if (action === 'reveal') {
          const { spawn } = await import('node:child_process')
          spawn('explorer.exe', [service.root], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
          return service.status()
        }
        return service.status()
      },
    }),
  )
}
