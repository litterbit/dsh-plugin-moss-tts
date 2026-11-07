// 工具调用的本机播放：把 WAV 交给系统 SoundPlayer。
//
// 为什么不在 host 里做流式播放：那需要 AudioContext，而 host 是 Node；插进
// ffplay/sox 又给用户加依赖。工具路径的音频通常很短（默认 ≤30 s），整段落盘再播
// 完全够用；浏览器里的自动朗读走 /stream + AudioWorklet，是另一条路。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pcmToWav } from './engine.mjs'

function psLiteral(value) {
  return String(value).replace(/'/gu, "''")
}

/** 播放一个 WAV，等它播完；signal 中断则结束播放器进程。 */
export function playWavFile(file, options = {}) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$player = New-Object System.Media.SoundPlayer '${psLiteral(file)}'`,
    '$player.PlaySync()',
  ].join('; ')

  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
    })
    const onAbort = () => {
      try {
        child.kill()
      } catch {
        // 已经退了
      }
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('exit', (code) => {
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code, canceled: options.signal?.aborted === true })
    })
    child.on('error', () => resolve({ code: -1, canceled: false }))
  })
}

/** 写一个临时 WAV 并播放，播完删掉。 */
export async function playPcm(pcm, options = {}) {
  const dir = options.dir ?? path.join(os.tmpdir(), 'moss-tts-plugin')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `say-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.wav`)
  fs.writeFileSync(file, pcmToWav(pcm))
  try {
    return await playWavFile(file, options)
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {
      // 播放器可能还占着文件
    }
  }
}
