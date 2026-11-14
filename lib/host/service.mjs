// 把「安装器 + 引擎 + 偏好」拼成一个服务：路由和工具都只跟它打交道。
//
// 0.2.0 起它还负责三件事：
//   - 线程数以 prefs 为准，同步到引擎的 settings.json；
//   - 作业串行化（引擎是单 worker，两次调用不该互相取消）；
//   - 空闲若干分钟后卸掉引擎进程，把 250 MB 还回去。
import fs from 'node:fs'

import { Engine, pcmToWav, scalePcm16 } from './engine.mjs'
import { createInstaller, detectInstalled, engineVersion, readManifest } from './install.mjs'
import { engineLayout, pluginLayout, productDir } from './paths.mjs'
import { Prefs } from './prefs.mjs'
import { readEngineSettings, writeEngineSettings } from './settings.mjs'
import { inspectWav, sliceWav } from './wav.mjs'

const VOICES_TTL_MS = 30_000
const MAX_CLONE_SECONDS = 20

function versionParts(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(String(text ?? ''))
  return match ? match.slice(1, 4).map(Number) : undefined
}

function newerThan(candidate, base) {
  const a = versionParts(candidate)
  const b = versionParts(base)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return false
}

export class TtsService {
  constructor(options = {}) {
    this.config = options.config ?? {}
    this.log = options.logger ?? (() => {})
    this.root = productDir(this.config)
    this.layout = engineLayout(this.root)
    this.paths = pluginLayout(this.root)
    this.manifest = options.manifest ?? readManifest()
    this.prefs = new Prefs(this.paths.prefs)
    this.installer = createInstaller({
      layout: this.layout,
      config: this.config,
      manifest: this.manifest,
      log: this.log,
    })
    this.engine = undefined
    this.lastError = undefined
    this.lastJob = undefined
    this.voicesCache = undefined
    this.queue = Promise.resolve()
    this.active = 0
    this.idleTimer = undefined
    this.announcer = undefined
    this.createEngine = options.createEngine ?? ((engineOptions) => new Engine(engineOptions))
  }

  get dataDir() {
    return this.config.data ?? this.layout.data
  }

  /** 引擎实例（必要时先装好并起进程）。并发调用共享同一个 start()。 */
  async ensureEngine() {
    const found = await this.installer.ensure()
    if (this.engine && (this.engine.exe !== found.exe || this.engine.models !== found.models)) {
      await this.engine.dispose()
      this.engine = undefined
    }
    if (!this.engine) {
      this.#syncThreads()
      this.engine = this.createEngine({
        exe: found.exe,
        models: found.models,
        data: this.dataDir,
        // 线程数走 settings.json；这里只在用户显式配置了 config.threads 时覆盖
        llmThreads: this.config.threads ?? 0,
        decodeThreads: this.config.decodeThreads ?? 0,
        logger: this.log,
      })
    }
    await this.engine.start()
    this.lastError = undefined
    this.touch()
    return this.engine
  }

  /** prefs 与引擎的 settings.json 对齐：有显式值就写文件，没有就采纳文件里的值。 */
  #syncThreads() {
    try {
      const prefs = this.prefs.get()
      const file = readEngineSettings(this.dataDir)
      if (prefs.llmThreads > 0 || prefs.decodeThreads > 0) {
        if (file.llmThreads !== prefs.llmThreads || file.decodeThreads !== prefs.decodeThreads) {
          writeEngineSettings(this.dataDir, prefs)
        }
      } else if (file.llmThreads > 0 || file.decodeThreads > 0) {
        this.prefs.update({ llmThreads: file.llmThreads, decodeThreads: file.decodeThreads })
      }
    } catch (error) {
      this.log(`[engine] 同步线程数失败：${error?.message ?? error}`)
    }
  }

  installed() {
    return detectInstalled(this.layout, this.config)
  }

  status() {
    const install = this.installer.state()
    const found = this.installed()
    const installing = ['download', 'verify', 'extract'].includes(install.phase)
    let state = 'missing'
    if (installing) state = 'installing'
    else if (found) state = 'ready'
    else if (install.phase === 'error' || this.lastError) state = 'error'
    const error = this.lastError ?? install.error
    const version = found ? engineVersion(this.layout, found.exe) : undefined
    return {
      state,
      running: this.engine?.running === true,
      version,
      engineVersion: this.engine?.info?.version,
      updateAvailable: newerThan(this.manifest.release, version),
      exe: found?.exe ?? this.layout.exe,
      models: found?.models ?? this.layout.models,
      data: this.dataDir,
      root: this.root,
      engine: this.engine?.info?.engine,
      lastJob: this.lastJob,
      busy: this.active > 0,
      install: {
        phase: install.phase,
        downloaded: install.downloaded,
        total: install.total,
        tag: install.tag ?? this.manifest.release,
        error: install.error,
      },
      prefs: this.prefs.get(),
      platform: process.platform,
      manifest: { repo: this.manifest.repo, release: this.manifest.release, minVersion: this.manifest.minVersion },
    }
  }

  async voices(force = false) {
    if (!force && this.voicesCache && Date.now() - this.voicesCache.at < VOICES_TTL_MS) {
      return this.voicesCache.value
    }
    const engine = await this.ensureEngine()
    const value = await engine.voices()
    this.voicesCache = { at: Date.now(), value }
    return value
  }

  /** 引擎是单 worker：排成一条队，避免两次调用互相取消（工具 + 自动朗读会撞车）。 */
  #enqueue(task) {
    const previous = this.queue
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    // 队列本身不能带上一次的失败，否则后面每一句都会跟着 reject
    this.queue = previous.catch(() => {}).then(() => gate)
    return previous
      .catch(() => {})
      .then(async () => {
        try {
          return await task(release)
        } catch (error) {
          release()
          throw error
        }
      })
  }

  /** 合成一段，返回 { job, done }；done 结算时自动记耗时、放锁。 */
  async speak(options) {
    return this.#enqueue(async (release) => {
      const engine = await this.ensureEngine()
      const started = Date.now()
      let counted = false
      try {
        this.active += 1
        counted = true
        const job = await engine.speak(options)
        const done = job.done.finally(() => {
          this.active = Math.max(0, this.active - 1)
          release()
          this.touch()
        })
        done.catch(() => {})
        return { id: job.id, done, cancel: job.cancel, release, started }
      } catch (error) {
        if (counted) this.active = Math.max(0, this.active - 1)
        release()
        throw error
      }
    })
  }

  recordJob(info, meta = {}) {
    if (!info) return
    this.lastJob = {
      at: Date.now(),
      state: info.state,
      audio_ms: info.audio_ms ?? 0,
      compute_ms: info.compute_ms ?? 0,
      first_pcm_ms: info.first_pcm_ms ?? 0,
      rtf: info.rtf ?? 0,
      cache_hit: info.cache_hit === true,
      voice: meta.voice ?? this.prefs.get().voice,
      chars: meta.chars ?? 0,
    }
    if (info.state === 'failed') this.lastError = info.error ?? '合成失败'
  }

  /** 合成整段，返回 PCM（s16le）与作业信息。 */
  async synthesize({ text, voice, scope }) {
    const chunks = []
    const { done } = await this.speak({
      text,
      voice: voice ?? this.prefs.get().voice,
      scope: scope ?? 'builtin',
      onAudio: (pcm) => chunks.push(pcm),
    })
    const info = await done
    this.recordJob(info, { voice, chars: text.length })
    if (info.state === 'failed') throw new Error(info.error ?? '合成失败')
    return { pcm: Buffer.concat(chunks), info }
  }

  /** 合成整段并落盘为 WAV，返回路径。 */
  async synthesizeToFile({ text, voice, scope, file }) {
    const { pcm, info } = await this.synthesize({ text, voice, scope })
    // 工具路径的播放器（SoundPlayer）没有音量旋钮，只能在这里压
    fs.writeFileSync(file, pcmToWav(scalePcm16(pcm, this.prefs.get().volume)))
    return { file, info, seconds: info.audio_ms / 1000 }
  }

  /** 克隆：只接受 PCM WAV；超过 20 秒自动截前 20 秒。 */
  async clone(name, bytes) {
    const clean = String(name ?? '').trim()
    if (!/^[\w-]{1,32}$/u.test(clean)) throw new Error('音色名只能是字母/数字/_/-，最长 32')
    const info = inspectWav(bytes)
    let wav = bytes
    let trimmed = false
    if (info.seconds > MAX_CLONE_SECONDS + 0.01) {
      wav = sliceWav(bytes, 0, MAX_CLONE_SECONDS).wav
      trimmed = true
    }
    const engine = await this.ensureEngine()
    const reply = await engine.clone(clean, Buffer.isBuffer(wav) ? wav : Buffer.from(wav))
    this.voicesCache = undefined
    return { name: clean, seconds: Math.min(info.seconds, MAX_CLONE_SECONDS), trimmed, reply }
  }

  async install() {
    if (this.engine?.running) await this.engine.dispose()
    this.engine = undefined
    this.voicesCache = undefined
    return this.installer.start()
  }

  cancelInstall() {
    return this.installer.cancel()
  }

  /** 只停"当前这一句"，不关引擎。 */
  async stop() {
    if (this.engine?.active) {
      this.engine.active.cancel()
      return true
    }
    return false
  }

  /** 关掉引擎进程（释放内存）。下次合成会自动拉起。 */
  async stopEngine() {
    if (!this.engine) return false
    await this.engine.stop()
    this.voicesCache = undefined
    this.log('[engine] 已卸载（空闲/手动）')
    return true
  }

  /** 保存线程数并重启引擎；返回新的 info。 */
  async restartEngine(patch = {}) {
    return this.#enqueue(async (release) => {
      try {
        const prefs = this.prefs.get()
        const next = {
          llmThreads: patch.llmThreads === undefined ? prefs.llmThreads : Number(patch.llmThreads),
          decodeThreads: patch.decodeThreads === undefined ? prefs.decodeThreads : Number(patch.decodeThreads),
        }
        if (patch.llmThreads !== undefined || patch.decodeThreads !== undefined) {
          this.prefs.update(next)
        }
        writeEngineSettings(this.dataDir, this.prefs.get())
        if (this.engine) await this.engine.stop()
        this.engine = undefined
        this.voicesCache = undefined
        const engine = await this.ensureEngine()
        return engine.info ?? {}
      } finally {
        release()
      }
    })
  }

  /** 探活；进程没了或 ping 不通就重启。 */
  async health() {
    if (!this.installed()) return { ok: false, restarted: false, status: this.status() }
    if (!this.engine?.running) {
      await this.ensureEngine()
      return { ok: true, restarted: true, status: this.status() }
    }
    const alive = await this.engine.ping()
    if (alive) return { ok: true, restarted: false, status: this.status() }
    this.log('[engine] ping 失败，重启')
    await this.restartEngine()
    return { ok: true, restarted: true, status: this.status() }
  }

  /** 每次真正用引擎就重置空闲计时；到点且没在忙就卸载。 */
  touch() {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const minutes = this.prefs.get().idleUnloadMinutes
    if (!minutes || minutes <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.active > 0) {
        this.touch()
        return
      }
      this.stopEngine().catch((error) => this.log(`[engine] 卸载失败：${error?.message ?? error}`))
    }, minutes * 60_000)
    this.idleTimer.unref?.()
  }

  async dispose() {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    await this.engine?.dispose()
    this.engine = undefined
  }
}
