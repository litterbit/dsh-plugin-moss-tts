// 与 host 的 HTTP 面打交道：一个极薄的 fetch 封装 + 两个共享小 store。
// 组件用 useState + subscribe，不依赖宿主内部状态库。
const API = '/moss-tts'

const DEFAULT_PREFS = {
  voice: '',
  autoRead: false,
  speakMode: 'smart',
  cannedText: '任务已经完成，请查收。',
  maxChars: 1500,
  skipCode: true,
  llmThreads: 0,
  decodeThreads: 0,
  idleUnloadMinutes: 10,
  preload: false,
  smartMinChars: 80,
  smartMaxChars: 60,
}

async function readResponse(res) {
  const text = await res.text()
  let data = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: text.slice(0, 200) }
    }
  }
  if (!res.ok) {
    const error = new Error(data.message ?? data.error ?? `HTTP ${res.status}`)
    error.status = res.status
    error.code = data.code
    error.payload = data
    throw error
  }
  return data
}

async function apiGet(path) {
  const res = await fetch(API + path, { headers: { accept: 'application/json' }, cache: 'no-store' })
  return readResponse(res)
}

async function apiPost(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return readResponse(res)
}

// ---- 偏好：一处改动，设置页和输入框开关同时生效 ----
const prefsStore = {
  value: { ...DEFAULT_PREFS },
  ready: false,
  loading: undefined,
  listeners: new Set(),
  async load(force) {
    if (this.ready && force !== true) return this.value
    if (this.loading) return this.loading
    this.loading = apiGet('/prefs')
      .then((data) => {
        this.ready = true
        this.apply(data.prefs)
      })
      .catch(() => {})
      .finally(() => {
        this.loading = undefined
      })
    return this.loading
  },
  apply(patch) {
    if (!patch) return
    this.value = { ...this.value, ...patch }
    for (const listener of [...this.listeners]) listener(this.value)
  },
  set(patch) {
    this.apply(patch)
    apiPost('/prefs', patch)
      .then((data) => this.apply(data.prefs))
      .catch(() => {})
  },
  subscribe(listener) {
    this.listeners.add(listener)
    listener(this.value)
    return () => this.listeners.delete(listener)
  },
}

function usePrefs() {
  const [value, setValue] = react.useState(prefsStore.value)
  react.useEffect(() => prefsStore.subscribe(setValue), [])
  react.useEffect(() => {
    prefsStore.load()
  }, [])
  return [value, (patch) => prefsStore.set(patch)]
}

// ---- 引擎状态：只在有订阅者时轮询，避免空转 ----
const statusStore = {
  value: { state: 'unknown', install: {}, prefs: DEFAULT_PREFS },
  listeners: new Set(),
  timer: undefined,
  inFlight: false,
  async refresh() {
    if (this.inFlight) return
    this.inFlight = true
    try {
      this.value = await apiGet('/status')
    } catch (error) {
      this.value = { ...this.value, state: 'error', error: String(error?.message ?? error) }
    } finally {
      this.inFlight = false
      for (const listener of [...this.listeners]) listener(this.value)
    }
  },
  start() {
    if (this.timer) return
    this.refresh()
    this.timer = setInterval(() => this.refresh(), 1000)
  },
  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  },
  subscribe(listener) {
    this.listeners.add(listener)
    listener(this.value)
    this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  },
}

function useStatus() {
  const [value, setValue] = react.useState(statusStore.value)
  react.useEffect(() => statusStore.subscribe(setValue), [])
  return value
}

function statusReady(status) {
  return status && status.state === 'ready'
}

function formatBytes(value) {
  const bytes = Number(value ?? 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 最近一次作业的耗时行；没有就返回空串。 */
function timingText(job) {
  if (!job || !job.audio_ms) return ''
  return `音频 ${(job.audio_ms / 1000).toFixed(2)} s · 计算 ${Math.round(job.compute_ms)} ms · 首音 ${Math.round(job.first_pcm_ms ?? 0)} ms · RTF ${(job.rtf ?? 0).toFixed(3)}`
}
