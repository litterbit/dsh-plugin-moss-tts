// 用户偏好：一份 JSON，设置页读写，工具也读它 —— 界面选的音色就是 agent 用的音色。
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_PREFS = Object.freeze({
  voice: 'Junhao',
  autoRead: false,
  maxChars: 1500,
  skipCode: true,
})

function clampText(value, fallback, max = 200) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, max) : fallback
}

function clampChars(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(20000, Math.max(0, Math.round(number)))
}

/** 只接受已知字段，越界值夹回范围（设置页和 curl 都会走到这里）。 */
export function normalizePrefs(patch = {}, base = DEFAULT_PREFS) {
  const next = { ...base }
  if (patch.voice !== undefined) next.voice = clampText(patch.voice, base.voice, 64)
  if (patch.autoRead !== undefined) next.autoRead = patch.autoRead === true || patch.autoRead === 'true'
  if (patch.maxChars !== undefined) next.maxChars = clampChars(patch.maxChars, base.maxChars)
  if (patch.skipCode !== undefined) next.skipCode = patch.skipCode === true || patch.skipCode === 'true'
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
    this.cache = normalizePrefs(stored, DEFAULT_PREFS)
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
