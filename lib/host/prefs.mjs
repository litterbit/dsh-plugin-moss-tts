// 用户偏好：一份 JSON，设置页读写，工具也读它 —— 界面选的音色就是 agent 用的音色。
//
// 0.2.0 起多了三组字段：
//   - 自动朗读的模式（full / canned / smart）与固定语句；
//   - 线程数（0 = 引擎自己按物理核数决定，默认 2+3）；
//   - 引擎生命周期（启动预热、空闲多少分钟卸载）。
// 旧版本的 prefs.json 直接读：缺的字段补默认值，多的字段丢掉。
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_PREFS = Object.freeze({
  voice: '', // '' = 跟随引擎默认音色（manqu 满满）
  autoRead: false,
  speakMode: 'smart', // full | canned | smart
  cannedText: '任务已经完成，请查收。',
  maxChars: 1500,
  skipCode: true,
  volume: 0.6, // 0~1：MOSS 的响度比一般应用高，默认压到 60%
  llmThreads: 0, // 0 = 自动
  decodeThreads: 0, // 0 = 自动
  idleUnloadMinutes: 10, // 0 = 从不卸载
  preload: false,
  smartMinChars: 80, // 短于此的回复不调模型
  smartMaxChars: 60, // 播报句上限
})

const SPEAK_MODES = new Set(['full', 'canned', 'smart'])

function clampText(value, fallback, max = 200) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, max) : fallback
}

function clampChars(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(20000, Math.max(0, Math.round(number)))
}

function clampThreads(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(64, Math.max(0, Math.round(number)))
}

function clampMinutes(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(1440, Math.max(0, Math.round(number)))
}

/** 只接受已知字段，越界值夹回范围（设置页和 curl 都会走到这里）。 */
export function normalizePrefs(patch = {}, base = DEFAULT_PREFS) {
  const next = { ...base }
  // voice 允许空串（= 引擎默认），所以不能用 clampText 的"空就回退"
  if (patch.voice !== undefined) next.voice = String(patch.voice ?? '').trim().slice(0, 64)
  if (patch.autoRead !== undefined) next.autoRead = patch.autoRead === true || patch.autoRead === 'true'
  if (patch.speakMode !== undefined) {
    const mode = String(patch.speakMode)
    if (SPEAK_MODES.has(mode)) next.speakMode = mode
  }
  if (patch.cannedText !== undefined) next.cannedText = String(patch.cannedText ?? '').trim().slice(0, 200)
  if (patch.maxChars !== undefined) next.maxChars = clampChars(patch.maxChars, base.maxChars)
  if (patch.skipCode !== undefined) next.skipCode = patch.skipCode === true || patch.skipCode === 'true'
  if (patch.volume !== undefined) {
    const number = Number(patch.volume)
    next.volume = Number.isFinite(number) ? Math.min(1, Math.max(0, Math.round(number * 100) / 100)) : base.volume
  }
  if (patch.llmThreads !== undefined) next.llmThreads = clampThreads(patch.llmThreads, base.llmThreads)
  if (patch.decodeThreads !== undefined) next.decodeThreads = clampThreads(patch.decodeThreads, base.decodeThreads)
  if (patch.idleUnloadMinutes !== undefined) {
    next.idleUnloadMinutes = clampMinutes(patch.idleUnloadMinutes, base.idleUnloadMinutes)
  }
  if (patch.preload !== undefined) next.preload = patch.preload === true || patch.preload === 'true'
  if (patch.smartMinChars !== undefined) next.smartMinChars = clampChars(patch.smartMinChars, base.smartMinChars)
  if (patch.smartMaxChars !== undefined) {
    const number = Number(patch.smartMaxChars)
    next.smartMaxChars = Number.isFinite(number) ? Math.min(200, Math.max(10, Math.round(number))) : base.smartMaxChars
  }
  // 固定语句为空时允许：canned 模式下就不出声，比硬塞一句默认话更尊重用户
  return next
}

export class Prefs {
  constructor(file) {
    this.file = file
    this.cache = undefined
  }

  get() {
    if (this.cache) return this.cache
    let stored = {}
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      stored = {}
    }
    const next = normalizePrefs(stored, DEFAULT_PREFS)
    // 0.1.x 的旧文件没有 speakMode：保持"读全文"，别在升级时悄悄换行为/花 token；
    // 音色也退回"跟随引擎默认"（旧默认写死 Junhao，而引擎默认已经是 manqu）。
    // 文件不存在/坏掉时 stored 是空对象，按全新安装处理（默认 smart）。
    if (stored && Object.keys(stored).length > 0 && stored.speakMode === undefined) {
      next.speakMode = 'full'
      if (next.voice === 'Junhao') next.voice = ''
    }
    this.cache = next
    return this.cache
  }

  update(patch) {
    const next = normalizePrefs(patch, this.get())
    this.cache = next
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.file)
    return next
  }
}
