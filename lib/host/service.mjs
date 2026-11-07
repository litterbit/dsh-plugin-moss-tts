// 把「安装器 + 引擎 + 偏好」拼成一个服务：路由和工具都只跟它打交道。
import fs from 'node:fs'

import { Engine, pcmToWav } from './engine.mjs'
import { createInstaller, detectInstalled, engineVersion, readManifest } from './install.mjs'
import { engineLayout, pluginLayout, productDir } from './paths.mjs'
import { Prefs } from './prefs.mjs'

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
  }

  /** 引擎实例（必要时先装好并起进程）。并发调用共享同一个 start()。 */
  async ensureEngine() {
    const found = await this.installer.ensure()
    if (this.engine && (this.engine.exe !== found.exe || this.engine.models !== found.models)) {
      await this.engine.dispose()
      this.engine = undefined
    }
    if (!this.engine) {
      this.engine = new Engine({
        exe: found.exe,
        models: found.models,
        data: this.config.data ?? this.layout.data,
        llmThreads: this.config.threads ?? 0,
        decodeThreads: this.config.decodeThreads ?? 0,
        logger: this.log,
      })
    }
    await this.engine.start()
    this.lastError = undefined
    return this.engine
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
    return {
      state,
      running: this.engine?.running === true,
      version: found ? engineVersion(this.layout, found.exe) : undefined,
      engineVersion: this.engine?.info?.version,
      exe: found?.exe ?? this.layout.exe,
      models: found?.models ?? this.layout.models,
      data: this.config.data ?? this.layout.data,
      root: this.root,
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

  async voices() {
    const engine = await this.ensureEngine()
    return engine.voices()
  }

  /** 合成整段，返回 PCM（s16le）与作业信息。 */
  async synthesize({ text, voice, scope }) {
    const engine = await this.ensureEngine()
    const chunks = []
    const job = await engine.speak({
      text,
      voice: voice ?? this.prefs.get().voice,
      scope: scope ?? 'builtin',
      onAudio: (pcm) => chunks.push(pcm),
    })
    const info = await job.done
    if (info.state === 'failed') throw new Error(info.error ?? '合成失败')
    return { pcm: Buffer.concat(chunks), info }
  }

  /** 合成整段并落盘为 WAV，返回路径。 */
  async synthesizeToFile({ text, voice, scope, file }) {
    const { pcm, info } = await this.synthesize({ text, voice, scope })
    fs.writeFileSync(file, pcmToWav(pcm))
    return { file, info, seconds: info.audio_ms / 1000 }
  }

  async clone(name, bytes) {
    const engine = await this.ensureEngine()
    return engine.clone(name, bytes)
  }

  async install() {
    if (this.engine?.running) await this.engine.dispose()
    this.engine = undefined
    return this.installer.start()
  }

  cancelInstall() {
    return this.installer.cancel()
  }

  async stop() {
    if (this.engine?.active) {
      this.engine.active.cancel()
      return true
    }
    return false
  }

  async dispose() {
    await this.engine?.dispose()
    this.engine = undefined
  }
}
