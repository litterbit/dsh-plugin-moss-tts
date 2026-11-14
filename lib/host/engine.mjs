// moss_tts.exe --stdio 的 Node 客户端。
//
// 一个常驻子进程：权重只加载一次，所有句子共用同一份前缀 KV 缓存。
// 引擎是单 worker，所以这里也保持"同一时刻只有一句"：新请求先取消旧的。
import { spawn } from 'node:child_process'

export const AUDIO_FORMAT = { encoding: 's16le', rate: 48000, channels: 2 }
export const AUDIO_HEADER = 's16le;rate=48000;channels=2'

export class Engine {
  constructor(options = {}) {
    this.exe = options.exe
    this.models = options.models
    this.data = options.data
    this.llmThreads = options.llmThreads ?? 0
    this.decodeThreads = options.decodeThreads ?? 0
    this.log = options.logger ?? (() => {})
    this.child = undefined
    this.info = undefined
    this.pending = new Map()
    this.buffer = ''
    this.seq = 0
    this.starting = undefined
    this.active = undefined
    this.disposed = false
    this.stopping = false
  }

  get running() {
    return this.child !== undefined
  }

  async start() {
    if (this.child) return this.info
    if (this.disposed) throw new Error('引擎已卸载')
    if (this.starting) return this.starting
    this.starting = this.#spawn().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async #spawn() {
    if (!this.exe) throw new Error('找不到 moss_tts.exe')
    const args = ['--models', this.models, '--stdio']
    if (this.data) args.push('--data', this.data)
    if (this.llmThreads > 0) args.push('--threads', String(this.llmThreads))
    if (this.decodeThreads > 0) args.push('--decode-threads', String(this.decodeThreads))

    const child = spawn(this.exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const line = String(chunk).trim()
      if (line) this.log(`[engine] ${line.slice(0, 400)}`)
    })
    child.on('error', (error) => {
      this.log(`[engine] spawn 失败：${error.message}`)
      this.#failAll(new Error(`moss_tts 启动失败：${error.message}`))
      this.child = undefined
    })
    child.on('exit', (code) => {
      if (this.stopping) {
        this.log(`[engine] stopped code=${code}`)
      } else {
        this.log(`[engine] exit code=${code}`)
        this.#failAll(new Error(`moss_tts 意外退出（code=${code}）`))
      }
      this.child = undefined
      this.info = undefined
    })

    const info = await this.#request({ cmd: 'info' }, { timeoutMs: 180000 })
    this.info = info.info ?? {}
    return this.info
  }

  #failAll(error) {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  #onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.log(`[engine] 无法解析的行：${line.slice(0, 120)}`)
        continue
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    const entry = this.pending.get(message.id)
    if (!entry) return
    if (message.type === 'audio') {
      try {
        entry.onAudio?.(Buffer.from(message.pcm, 'base64'))
      } catch (error) {
        this.log(`[engine] onAudio 抛错：${error?.message ?? error}`)
      }
      return
    }
    if (message.type === 'begin') {
      entry.onBegin?.(message)
      return
    }
    this.pending.delete(message.id)
    if (message.type === 'error') entry.reject(new Error(`${message.code}: ${message.error}`))
    else entry.resolve(message)
  }

  #write(payload) {
    if (!this.child) throw new Error('引擎还没启动')
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  #request(payload, { timeoutMs = 120000 } = {}) {
    const id = payload.id ?? `r${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 超时多半是 stdout 被 pause 住导致引擎写阻塞，放出来让后续请求有机会恢复
        this.resumeOutput()
        reject(new Error(`引擎请求超时：${payload.cmd ?? payload.id}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.#write({ ...payload, id })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async voices() {
    await this.start()
    const message = await this.#request({ cmd: 'voices' }, { timeoutMs: 15000 })
    return {
      builtin: message.builtin ?? [],
      user: message.user ?? [],
      default: typeof message.default === 'string' ? message.default : undefined,
    }
  }

  async clone(name, wav) {
    await this.start()
    if (!Buffer.isBuffer(wav)) throw new Error('clone 需要 PCM WAV 的字节（Buffer）')
    return this.#request({ cmd: 'clone', name, wav: wav.toString('base64') }, { timeoutMs: 300000 })
  }

  /** 暂停/恢复子进程 stdout：HTTP 端背压一路传回引擎的计算循环。 */
  pauseOutput() {
    this.child?.stdout.pause()
  }

  resumeOutput() {
    this.child?.stdout.resume()
  }

  async cancel(id) {
    if (!this.child || !id) return false
    try {
      const reply = await this.#request({ cmd: 'cancel', job: id }, { timeoutMs: 15000 })
      return reply.ok === true
    } catch {
      return false
    }
  }

  async #cancelActive() {
    const job = this.active
    if (!job) return
    this.active = undefined
    await this.cancel(job.id)
    await Promise.race([job.done.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4000))])
  }

  /**
   * 合成一段话。返回 { id, done, cancel }。
   * onAudio 在每块 PCM 到达时同步调用（Buffer，s16le 48 kHz 立体声）。
   */
  async speak(options) {
    await this.start()
    await this.#cancelActive()

    const id = `s${++this.seq}`
    const payload = {
      id,
      cmd: 'speak',
      text: options.text,
      voice: options.voice ?? 'Junhao',
      scope: options.scope ?? 'builtin',
      seed: options.seed ?? 0,
      greedy: options.greedy ?? false,
      max_frames: options.maxFrames ?? 375,
      chunk_frames: options.chunkFrames ?? 8,
      min_frames: options.minFrames ?? 0,
    }
    if (options.temperature) payload.temperature = options.temperature
    if (options.topK) payload.top_k = options.topK
    if (options.topP) payload.top_p = options.topP
    if (options.repetitionPenalty) payload.repetition_penalty = options.repetitionPenalty

    const done = new Promise((resolve, reject) => {
      this.pending.set(id, {
        onAudio: options.onAudio,
        onBegin: options.onBegin,
        resolve: (message) => resolve(message.job ?? {}),
        reject,
      })
      try {
        this.#write(payload)
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
    done.catch(() => {})
    const handle = { id, done, cancel: () => this.cancel(id).catch(() => {}) }
    this.active = handle
    done.finally(() => {
      if (this.active === handle) this.active = undefined
    }).catch(() => {})
    return handle
  }

  /** 轻量探活：进程在但模型卡死时也能发现。 */
  async ping() {
    if (!this.child) return false
    try {
      const reply = await this.#request({ cmd: 'ping' }, { timeoutMs: 5000 })
      return reply.type === 'pong'
    } catch {
      return false
    }
  }

  /** 关掉子进程，但保留这个 Engine 实例（下次 start() 重新拉起）。 */
  async stop() {
    const child = this.child
    this.stopping = true
    try {
      if (!child) return false
      this.child = undefined
      this.info = undefined
      try {
        child.stdin.end()
      } catch {
        // 已经关了
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            // 已经退了
          }
          resolve(undefined)
        }, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve(undefined)
        })
      })
      // 停止时还挂着的请求（例如正在流的合成）必须被拒掉，否则路由会一直等
      this.#failAll(new Error('引擎已停止'))
      return true
    } finally {
      this.stopping = false
    }
  }

  /** 停止再启动：线程数/权重路径变了都走这里。 */
  async restart() {
    await this.stop()
    this.disposed = false
    return this.start()
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    await this.stop()
  }
}

/** 把交织 s16le PCM 拼成 WAV（44 字节头 + 数据）。 */
export function pcmToWav(pcm, format = AUDIO_FORMAT) {
  const data = Buffer.concat(Array.isArray(pcm) ? pcm : [pcm])
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(format.channels, 22)
  header.writeUInt32LE(format.rate, 24)
  header.writeUInt32LE(format.rate * format.channels * 2, 28)
  header.writeUInt16LE(format.channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * 给 s16le PCM 乘一个音量系数（0~1）。引擎的输出比一般应用响，
 * 工具播放（SoundPlayer 没有音量旋钮）只能在这里压。
 */
export function scalePcm16(pcm, gain) {
  const ratio = Number(gain)
  if (!Number.isFinite(ratio) || ratio === 1) return pcm
  const source = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm)
  const out = Buffer.alloc(source.length)
  for (let offset = 0; offset + 1 < source.length; offset += 2) {
    let value = Math.round(source.readInt16LE(offset) * ratio)
    if (value > 32767) value = 32767
    else if (value < -32768) value = -32768
    out.writeInt16LE(value, offset)
  }
  return out
}
