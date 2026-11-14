// 工具调用的本机播放：把 WAV 交给系统 SoundPlayer。
//
// 为什么不在 host 里做流式播放：那需要 AudioContext，而 host 是 Node；插进
// ffplay/sox 又给用户加依赖。工具路径的音频通常很短，整段落盘再播完全够用；
// 浏览器里的自动朗读走 /stream + AudioWorklet，是另一条路。
//
// 0.2.2 起默认「启动播放就返回」：agent 不用等一段话念完才能继续做事。
// 同一时刻只保留一个播放器，新的一句会先掐掉上一句。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pcmToWav } from './engine.mjs'

let active

function psLiteral(value) {
  return String(value).replace(/'/gu, "''")
}

function spawnPlayer(file) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$player = New-Object System.Media.SoundPlayer '${psLiteral(file)}'`,
    '$player.PlaySync()',
  ].join('; ')
  return spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  })
}

/** 停掉当前正在播的那一段（工具播放，不含浏览器）。 */
export function stopPlayback() {
  const child = active
  active = undefined
  if (!child) return false
  try {
    child.kill()
  } catch {
    // 已经退了
  }
  return true
}

export function playing() {
  return active !== undefined
}

/**
 * 启动播放并立刻返回；音频由独立进程继续放。
 * 新调用会先停掉上一段，避免两段叠在一起。
 */
export function playWavFileDetached(file) {
  stopPlayback()
  const child = spawnPlayer(file)
  active = child
  child.on('exit', () => {
    if (active === child) active = undefined
  })
  child.on('error', () => {
    if (active === child) active = undefined
  })
  return true
}

/** 播放一个 WAV 并等它播完；signal 中断则结束播放器进程。 */
export function playWavFile(file, options = {}) {
  stopPlayback()
  const child = spawnPlayer(file)
  active = child
  return new Promise((resolve) => {
    const onAbort = () => {
      try {
        child.kill()
      } catch {
        // 已经退了
      }
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (code) => {
      if (active === child) active = undefined
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code, canceled: options.signal?.aborted === true })
    }
    child.on('exit', (code) => finish(code))
    child.on('error', () => finish(-1))
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
