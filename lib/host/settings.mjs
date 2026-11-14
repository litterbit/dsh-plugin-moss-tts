// 引擎的线程数落在 `<data>/settings.json`（引擎自己的格式，见 csrc/src/settings.cpp）。
//
// 为什么由插件来写：stdio 模式下引擎只在"没给命令行 --threads"时才读这份文件，
// 而插件是常驻拉起引擎的一方。让文件成为唯一落点之后，插件、引擎网页、命令行看到
// 的是同一个值，也不会出现"插件显示 2+3、引擎实际跑 1+1"的错位。
import fs from 'node:fs'
import path from 'node:path'

/** 引擎设置文件的位置（与引擎的 settings_path 保持一致）。 */
export function engineSettingsFile(dataDir) {
  return path.join(dataDir, 'settings.json')
}

/** 读回引擎设置（坏文件按 0/0 = 自动处理，和引擎自己的行为一致）。 */
export function readEngineSettings(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(engineSettingsFile(dataDir), 'utf8'))
    return { llmThreads: clamp(parsed.llm_threads), decodeThreads: clamp(parsed.decode_threads) }
  } catch {
    return { llmThreads: 0, decodeThreads: 0 }
  }
}

function clamp(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(64, Math.max(0, Math.round(number)))
}

/** 原子写入：先写 .tmp 再 rename，引擎重启时不会读到半截文件。 */
export function writeEngineSettings(dataDir, { llmThreads = 0, decodeThreads = 0 } = {}) {
  const file = engineSettingsFile(dataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = `{\n  "llm_threads": ${clamp(llmThreads)},\n  "decode_threads": ${clamp(decodeThreads)}\n}\n`
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, body, 'utf8')
  fs.renameSync(tmp, file)
  return { llmThreads: clamp(llmThreads), decodeThreads: clamp(decodeThreads) }
}
