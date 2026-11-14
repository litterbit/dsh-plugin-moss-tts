// 播放器：fetch 流式 PCM → 信用窗口（在途 ≤2.5 s）→ AudioWorklet 环形缓冲。
//
// 为什么不用 <audio> 播 WAV：整段合成完才出声，长回复要等十几秒。这里首块音频
// 约 100 ms 就能起声，而且"读得比播得快"时靠信用窗口 + TCP 背压把引擎压住，
// 不会像 v0.1.0 那样把环形缓冲灌爆丢样。
//
// 0.2.3 起它还是一个"播放器"：暂停/继续、停止、重播、进度都在这层。
// 收到的 PCM 顺手留一份（上限 5 分钟），重播不用重新合成；超了就退回重新合成。
const CREDIT_FRAMES = 48000 * 2.5
const RATE = 48000
const MAX_RECORD_FRAMES = RATE * 300

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
    this.paused = false
    this.dropped = 0
    this.underruns = 0
    this.played = 0
    this.sinceReport = 0
    this.port.onmessage = (event) => {
      const message = event.data || {}
      if (message.type === 'push') this.push(message.samples)
      else if (message.type === 'end') this.ended = true
      else if (message.type === 'reset') this.reset()
      else if (message.type === 'pause') {
        this.paused = message.value === true
        this.report()
      }
    }
  }
  reset() {
    this.readIndex = 0
    this.writeIndex = 0
    this.available = 0
    this.ended = false
    this.paused = false
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
    // 暂停：输出静音但不动读指针，缓冲原样留着
    if (this.paused) {
      for (let i = 0; i < frames; i++) {
        left[i] = 0
        if (right !== left) right[i] = 0
      }
      this.sinceReport += frames
      if (this.sinceReport >= 2048) {
        this.sinceReport = 0
        this.report()
      }
      return true
    }
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
      paused: this.paused,
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
    this.jobId = undefined
    this.error = undefined
    this.dropped = 0
    this.underruns = 0
    this.sent = 0
    this.played = 0
    this.endedFrames = 0
    this.abort = undefined
    this.listeners = new Set()
    this.resample = undefined
    this.worklet = undefined
    // 重播用：这一段的原文 + 收到的原始 PCM
    this.last = undefined
    this.record = []
    this.recordFrames = 0
    this.overflow = false
    this.recording = false
    this.replaying = false
    this.resumeTo = 'speaking'
    this.errorTimer = undefined
  }

  get snapshot() {
    return {
      state: this.state,
      source: this.source,
      messageId: this.messageId,
      error: this.error,
      dropped: this.dropped,
      underruns: this.underruns,
      played: this.played,
      total: this.endedFrames,
      paused: this.state === 'paused',
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

  /** 浏览器 → 宿主：agent 的 wait 和 moss_tts_stop 靠这条状态。 */
  sendHost(state) {
    if (!this.jobId) return
    apiPost('/player', { id: this.jobId, state, played: this.played, total: this.endedFrames }).catch(() => {})
  }

  fail(message) {
    const text = String(message ?? '')
    this.sendHost('error')
    clearTimeout(this.errorTimer)
    this.patch({ state: 'error', error: text })
    this.errorTimer = setTimeout(() => {
      if (this.state === 'error') this.patch({ state: 'idle', source: undefined, messageId: undefined, error: undefined })
    }, 8000)
  }

  dismissError() {
    if (this.state !== 'error') return
    clearTimeout(this.errorTimer)
    this.patch({ state: 'idle', source: undefined, messageId: undefined, error: undefined })
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
      this.sendHost('done')
      this.patch({ state: 'idle', source: undefined, messageId: undefined })
      return
    }
    this.emit()
  }

  /**
   * 停止：中断下载、清空缓冲。默认连录音一起清（重播才需要留）。
   * @param {{keepRecord?: boolean, keepJob?: boolean, notify?: boolean}} [options]
   */
  stop(options = {}) {
    const active = this.state !== 'idle' || this.audio !== undefined
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
    if (active && options.notify !== false) this.sendHost('stopped')
    this.sent = 0
    this.played = 0
    this.endedFrames = 0
    this.recording = false
    this.replaying = false
    if (!options.keepJob) this.jobId = undefined
    if (!options.keepRecord) {
      this.record = []
      this.recordFrames = 0
      this.overflow = false
    }
    clearTimeout(this.errorTimer)
    if (this.state !== 'idle') this.patch({ state: 'idle', source: undefined, messageId: undefined, error: undefined })
  }

  pause() {
    if (this.state !== 'speaking' && this.state !== 'draining') return
    this.resumeTo = this.state
    if (this.worklet) this.worklet.port.postMessage({ type: 'pause', value: true })
    if (this.audio) this.audio.pause()
    this.patch({ state: 'paused' })
    this.sendHost('paused')
  }

  resume() {
    if (this.state !== 'paused') return
    if (this.worklet) this.worklet.port.postMessage({ type: 'pause', value: false })
    if (this.audio) this.audio.play().catch(() => {})
    this.patch({ state: this.resumeTo ?? 'speaking' })
    this.sendHost('speaking')
  }

  /** 重播：本地有录音就立刻从头放，没有（超长/兜底播放）就重新合成。 */
  async replay() {
    const last = this.last
    if (!last || !last.text) return
    const local = this.worklet !== undefined && !this.overflow && this.recordFrames > 0
    if (!local) {
      return this.speak({ ...last, jobId: this.jobId, source: this.source })
    }
    this.stop({ keepRecord: true, keepJob: true, notify: false })
    await this.ensureAudio()
    const controller = new AbortController()
    this.abort = controller
    this.sent = 0
    this.played = 0
    this.dropped = 0
    this.underruns = 0
    this.endedFrames = this.recordFrames
    this.worklet.port.postMessage({ type: 'reset' })
    this.worklet.port.postMessage({ type: 'pause', value: false })
    this.replaying = true
    this.patch({ state: 'speaking', source: this.source, messageId: this.messageId, error: undefined })
    this.sendHost('speaking')
    try {
      for (const chunk of this.record) {
        if (controller.signal.aborted) return
        this.push(chunk)
        await this.waitRoom(controller.signal)
      }
      if (controller.signal.aborted) return
      this.worklet.port.postMessage({ type: 'end' })
      this.patch({ state: 'draining' })
    } catch {
      // 被 stop 打断
    } finally {
      this.replaying = false
    }
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
      this.sendHost('done')
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
    this.jobId = options.jobId
    this.last = { text, voice: options.voice, maxChars: options.maxChars }
    this.record = []
    this.recordFrames = 0
    this.overflow = false
    this.recording = true
    this.endedFrames = 0
    this.resumeTo = 'speaking'
    this.sent = 0
    this.played = 0
    this.dropped = 0
    this.underruns = 0
    clearTimeout(this.errorTimer)
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
      this.fail(String(error?.message ?? error))
      throw error
    }
    if (!response.ok) {
      const detail = await readResponse(response).catch((error) => error.payload ?? { message: String(error) })
      if (controller.signal.aborted) return
      this.fail(detail.message ?? detail.error ?? '合成失败')
      const error = new Error(detail.message ?? detail.error ?? '合成失败')
      error.code = detail.code
      throw error
    }

    this.patch({ state: 'speaking' })
    this.sendHost('speaking')
    if (!this.worklet) {
      try {
        await this.speakWav(response, options)
      } catch (error) {
        if (!controller.signal.aborted) this.fail(String(error?.message ?? error))
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
      if (!controller.signal.aborted) this.fail(String(error?.message ?? error))
      return
    }
    if (controller.signal.aborted) return
    this.recording = false
    this.endedFrames = this.recordFrames
    this.worklet.port.postMessage({ type: 'end' })
    this.patch({ state: 'draining' })
  }

  push(bytes) {
    const aligned = new Uint8Array(bytes.length)
    aligned.set(bytes)
    if (this.recording) this.recordChunk(aligned)
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

  recordChunk(bytes) {
    if (this.overflow) return
    this.recordFrames += bytes.length / 4
    if (this.recordFrames > MAX_RECORD_FRAMES) {
      // 太长了，别把内存当仓库：重播退回重新合成
      this.overflow = true
      this.record = []
      return
    }
    this.record.push(bytes)
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
