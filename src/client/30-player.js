// 播放器：fetch 流式 PCM → 信用窗口（在途 ≤2.5 s）→ AudioWorklet 环形缓冲。
//
// 为什么不用 <audio> 播 WAV：整段合成完才出声，长回复要等十几秒。这里首块音频
// 约 100 ms 就能起声，而且"读得比播得快"时靠信用窗口 + TCP 背压把引擎压住，
// 不会像 v0.1.0 那样把环形缓冲灌爆丢样。
const CREDIT_FRAMES = 48000 * 2.5
const RATE = 48000

const WORKLET_SOURCE = `
class MossPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.capacity = 48000 * 4
    this.ring = new Float32Array(this.capacity * 2)
    this.readIndex = 0
    this.writeIndex = 0
    this.available = 0
    this.ended = false
    this.dropped = 0
    this.underruns = 0
    this.played = 0
    this.sinceReport = 0
    this.port.onmessage = (event) => {
      const message = event.data || {}
      if (message.type === 'push') this.push(message.samples)
      else if (message.type === 'end') this.ended = true
      else if (message.type === 'reset') this.reset()
    }
  }
  reset() {
    this.readIndex = 0
    this.writeIndex = 0
    this.available = 0
    this.ended = false
    this.dropped = 0
    this.underruns = 0
    this.played = 0
    this.sinceReport = 0
    this.report()
  }
  push(samples) {
    if (!samples || samples.length < 2) return
    const frames = samples.length >> 1
    const room = Math.min(frames, this.capacity - this.available)
    if (room < frames) this.dropped += frames - room
    for (let i = 0; i < room; i++) {
      const at = ((this.writeIndex + i) % this.capacity) * 2
      this.ring[at] = samples[i * 2]
      this.ring[at + 1] = samples[i * 2 + 1]
    }
    this.writeIndex = (this.writeIndex + room) % this.capacity
    this.available += room
    this.report()
  }
  process(inputs, outputs) {
    const output = outputs[0] || []
    const left = output[0]
    if (!left) return true
    const right = output[1] || left
    const frames = left.length
    let produced = 0
    while (produced < frames && this.available > 0) {
      const at = this.readIndex * 2
      left[produced] = this.ring[at]
      if (right !== left) right[produced] = this.ring[at + 1]
      this.readIndex = (this.readIndex + 1) % this.capacity
      this.available -= 1
      produced += 1
    }
    for (let i = produced; i < frames; i++) {
      left[i] = 0
      if (right !== left) right[i] = 0
    }
    if (produced < frames && this.available === 0 && !this.ended && this.played > 0) this.underruns += 1
    this.played += produced
    this.sinceReport += frames
    if (this.sinceReport >= 2048) {
      this.sinceReport = 0
      this.report()
    }
    return true
  }
  report() {
    this.port.postMessage({
      type: 'progress',
      played: this.played,
      underruns: this.underruns,
      dropped: this.dropped,
      buffered: this.available,
      ended: this.ended,
    })
  }
}
registerProcessor('moss-pcm', MossPcmPlayer)
`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 非 48 kHz 上下文才用：块内线性插值（浏览器基本都会给到 48 kHz）。 */
function makeResampler(fromRate, toRate) {
  let offset = 0
  return (floats) => {
    if (fromRate === toRate) return floats
    const ratio = fromRate / toRate
    const frames = floats.length >> 1
    const outFrames = Math.max(0, Math.floor((frames - offset) / ratio))
    const out = new Float32Array(outFrames * 2)
    for (let i = 0; i < outFrames; i++) {
      const pos = offset + i * ratio
      const base = Math.floor(pos)
      const frac = pos - base
      const next = Math.min(base + 1, frames - 1)
      for (let channel = 0; channel < 2; channel++) {
        const a = floats[base * 2 + channel] ?? 0
        const b = floats[next * 2 + channel] ?? a
        out[i * 2 + channel] = a + (b - a) * frac
      }
    }
    offset = offset + outFrames * ratio - frames
    return out
  }
}

class StreamPlayer {
  constructor() {
    this.ctx = undefined
    this.node = undefined
    this.audio = undefined
    this.state = 'idle'
    this.source = undefined
    this.messageId = undefined
    this.error = undefined
    this.dropped = 0
    this.underruns = 0
    this.sent = 0
    this.played = 0
    this.abort = undefined
    this.listeners = new Set()
    this.resample = undefined
    this.worklet = undefined
  }

  get snapshot() {
    return {
      state: this.state,
      source: this.source,
      messageId: this.messageId,
      error: this.error,
      dropped: this.dropped,
      underruns: this.underruns,
    }
  }

  emit() {
    for (const listener of [...this.listeners]) listener(this.snapshot)
  }

  patch(patch) {
    Object.assign(this, patch)
    this.emit()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  async ensureAudio() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
      return
    }
    const Ctor = window.AudioContext ?? window.webkitAudioContext
    if (!Ctor) throw new Error('这个浏览器不支持 Web Audio')
    let ctx
    try {
      ctx = new Ctor({ sampleRate: RATE })
    } catch {
      ctx = new Ctor()
    }
    this.ctx = ctx
    this.resample = ctx.sampleRate === RATE ? undefined : makeResampler(RATE, ctx.sampleRate)
    if (ctx.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
      await ctx.audioWorklet.addModule(url)
      this.worklet = new AudioWorkletNode(ctx, 'moss-pcm', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      this.worklet.port.onmessage = (event) => this.onProgress(event.data)
      this.worklet.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
  }

  onProgress(message) {
    if (!message || message.type !== 'progress') return
    this.played = message.played
    this.dropped = message.dropped ?? this.dropped
    this.underruns = message.underruns ?? this.underruns
    if (this.state === 'draining' && message.buffered === 0) {
      this.patch({ state: 'idle', source: undefined, messageId: undefined })
      return
    }
    this.emit()
  }

  stop() {
    if (this.abort) {
      this.abort.abort()
      this.abort = undefined
    }
    if (this.worklet) this.worklet.port.postMessage({ type: 'reset' })
    if (this.audio) {
      try {
        this.audio.pause()
        this.audio.src = ''
      } catch {
        // 元素可能已经回收
      }
      this.audio = undefined
    }
    this.sent = 0
    this.played = 0
    if (this.state !== 'idle') this.patch({ state: 'idle', source: undefined, messageId: undefined })
  }

  async waitRoom(signal) {
    while (this.sent - this.played > CREDIT_FRAMES) {
      if (signal.aborted) throw new Error('已取消')
      await sleep(40)
    }
  }

  /** 整段 WAV 兜底：没有 AudioWorklet 的浏览器。 */
  async speakWav(response, context) {
    const blob = await response.blob()
    const audio = new Audio(URL.createObjectURL(blob))
    this.audio = audio
    await new Promise((resolve, reject) => {
      audio.onended = resolve
      audio.onerror = () => reject(new Error('播放失败'))
      audio.play().then(resolve, reject)
    })
    if (this.audio === audio) {
      this.audio = undefined
      this.patch({ state: 'idle', source: undefined, messageId: undefined })
    }
    return context
  }

  /**
   * 朗读一段文字。会自动打断上一条（引擎是单 worker，本来也只能一句一句来）。
   * @returns {Promise<void>} 合成+播放结束时 resolve（被打断则提前 resolve）
   */
  async speak(options) {
    const text = String(options.text ?? '').trim()
    if (!text) throw new Error('没有可朗读的文字')
    this.stop()
    await this.ensureAudio()
    const controller = new AbortController()
    this.abort = controller
    this.sent = 0
    this.played = 0
    this.dropped = 0
    this.underruns = 0
    this.patch({ state: 'starting', source: options.source, messageId: options.messageId, error: undefined })

    const body = JSON.stringify({
      text,
      ...(options.voice ? { voice: options.voice } : {}),
      ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
    })
    let response
    try {
      response = await fetch(`${API}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      this.patch({ state: 'idle', error: String(error?.message ?? error) })
      throw error
    }
    if (!response.ok) {
      const detail = await readResponse(response).catch((error) => error.payload ?? { message: String(error) })
      if (controller.signal.aborted) return
      this.patch({ state: 'idle', source: undefined, messageId: undefined, error: detail.message ?? detail.error })
      const error = new Error(detail.message ?? detail.error ?? '合成失败')
      error.code = detail.code
      throw error
    }

    this.patch({ state: 'speaking' })
    if (!this.worklet) {
      try {
        await this.speakWav(response, options)
      } catch (error) {
        if (!controller.signal.aborted) this.patch({ state: 'idle', error: String(error?.message ?? error) })
        throw error
      }
      return
    }

    const reader = response.body.getReader()
    let carry = new Uint8Array(0)
    try {
      for (;;) {
        await this.waitRoom(controller.signal)
        const { done, value } = await reader.read()
        if (done) break
        let bytes = value
        if (carry.length) {
          bytes = new Uint8Array(carry.length + value.length)
          bytes.set(carry)
          bytes.set(value, carry.length)
        }
        const usable = bytes.length - (bytes.length % 4)
        carry = bytes.subarray(usable)
        if (usable === 0) continue
        this.push(bytes.subarray(0, usable))
      }
    } catch (error) {
      if (!controller.signal.aborted) this.patch({ state: 'idle', error: String(error?.message ?? error) })
      return
    }
    if (controller.signal.aborted) return
    this.worklet.port.postMessage({ type: 'end' })
    this.patch({ state: 'draining' })
  }

  push(bytes) {
    const aligned = new Uint8Array(bytes.length)
    aligned.set(bytes)
    const ints = new Int16Array(aligned.buffer)
    // 音量在浏览器这一侧乘：拖动滑块时，后续到的音频块立刻生效
    const raw = Number(prefsStore.value?.volume)
    const gain = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1
    let floats = new Float32Array(ints.length)
    for (let i = 0; i < ints.length; i++) floats[i] = (ints[i] / 32768) * gain
    if (this.resample) floats = this.resample(floats)
    this.sent += floats.length >> 1
    this.worklet.port.postMessage({ type: 'push', samples: floats }, [floats.buffer])
  }
}

const player = new StreamPlayer()

function usePlayer() {
  const [value, setValue] = react.useState(player.snapshot)
  react.useEffect(() => player.subscribe(setValue), [])
  return value
}

/** 组件共用的入口：朗读失败要把原因显示出来，别静默。 */
function speakText(options) {
  return player.speak(options).catch((error) => {
    if (options.onError) options.onError(error)
    else console.warn('[moss-tts]', error?.message ?? error)
  })
}
