// 引擎安装器：定位 → 下载（可续传）→ sha256 校验 → tar 解压 → 复核。
//
// 信任根是发布页的 sha256sums.txt：它和 zip 在同一个 CI 任务里生成，所以插件
// 只钉 release tag + 资产名，不钉哈希——CI 重打包会改哈希，钉死只会自找 404。
// 镜像用户可以用 config.engineUrl + config.engineSha256 完全绕开 GitHub。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { downloadTo, getText } from './http.mjs'
import { tarExe } from './paths.mjs'

const MANIFEST_URL = new URL('../../engine.json', import.meta.url)

/** 读取随包发布的 engine.json（release / asset / sums / minVersion）。 */
export function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_URL, 'utf8'))
}

/** 便携布局下判断"引擎已经在位"。只看文件存在，不做版本探测（那要起进程）。 */
export function detectInstalled(layout, config = {}) {
  const exe = config.exe ? path.resolve(String(config.exe)) : layout.exe
  if (!fs.existsSync(exe)) return undefined
  const models = config.models ? path.resolve(String(config.models)) : path.join(path.dirname(exe), 'models')
  if (!fs.existsSync(models)) return undefined
  return { exe, models }
}

export function engineVersion(layout, exe) {
  const candidates = [
    path.join(path.dirname(exe), 'models', 'manifest.json'),
    path.join(layout.root, 'manifest.json'),
  ]
  for (const file of candidates) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'))
      const version = json.version ?? json.engine_version ?? json.engineVersion
      if (typeof version === 'string' && version) return version
    } catch {
      // 没有就继续找
    }
  }
  return undefined
}

/** 从 sha256sums.txt 里取指定资产的行；格式 "<sha256>  <name>"。 */
export function parseSums(text, asset) {
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line)
    if (!match) continue
    const name = path.basename(match[2].trim())
    if (name === asset) return match[1].toLowerCase()
  }
  return undefined
}

/** /releases/latest 会 302 到 /releases/tag/<tag>，从那里取 tag。 */
export async function resolveLatestTag(repo, options = {}) {
  const { open } = await import('./http.mjs')
  const res = await open(`https://github.com/${repo}/releases/latest`, {
    ...options,
    headers: { ...options.headers, accept: 'text/html' },
  })
  res.stream.resume()
  const match = /\/releases\/tag\/([^/?#]+)/u.exec(res.url)
  if (!match) throw new Error(`无法解析最新版本号：${res.url}`)
  return decodeURIComponent(match[1])
}

function releaseBase(repo, tag) {
  return `https://github.com/${repo}/releases/download/${tag}`
}

async function extract(zip, dest, log) {
  fs.mkdirSync(dest, { recursive: true })
  await new Promise((resolve, reject) => {
    const child = spawn(tarExe(), ['-xf', zip, '-C', dest], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(undefined)
      else reject(new Error(`解压失败（tar ${code}）：${stderr.trim().slice(-400)}`))
    })
  })
  log?.(`[install] extracted ${path.basename(zip)} -> ${dest}`)
}

async function sha256File(file) {
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  const stream = fs.createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * 创建一个安装器：state() 给路由轮询，ensure() 给"要合成了但引擎不在"的路径。
 * 同一时刻只有一个任务；取消会保留 .part（下次续传）。
 */
export function createInstaller(options) {
  const {
    layout,
    config = {},
    manifest = readManifest(),
    log = () => {},
    download = downloadTo,
    text = getText,
    resolveTag = resolveLatestTag,
    extractArchive = extract,
    hashFile = sha256File,
  } = options

  let state = { phase: 'idle', downloaded: 0, total: 0, error: undefined, tag: undefined }
  let running
  let controller

  const publicState = () => ({ ...state })

  const task = async () => {
    controller = new AbortController()
    const signal = controller.signal
    const asset = config.engineAsset ?? manifest.asset
    const sumsName = config.engineSums ?? manifest.sums ?? 'sha256sums.txt'
    const repo = manifest.repo
    let tag = config.engineRelease ?? manifest.release

    let base
    let expected = config.engineSha256?.toLowerCase()
    let assetUrl = config.engineUrl

    if (!assetUrl) {
      base = releaseBase(repo, tag)
      try {
        const sums = await text(`${base}/${sumsName}`, { signal, maxBytes: 64 * 1024 })
        if (!expected) expected = parseSums(sums, asset)
        if (!expected) throw new Error(`${sumsName} 里没有 ${asset}`)
      } catch (error) {
        if (signal.aborted) throw error
        log?.(`[install] ${tag} 不可用（${error.message}），回退到最新发布`)
        tag = await resolveTag(repo, { signal })
        base = releaseBase(repo, tag)
        const sums = await text(`${base}/${sumsName}`, { signal, maxBytes: 64 * 1024 })
        if (!expected) expected = parseSums(sums, asset)
        if (!expected) throw new Error(`${sumsName} 里没有 ${asset}`)
      }
      assetUrl = `${base}/${asset}`
    }
    state.tag = tag
    if (!expected) {
      log?.('[install] 没有可用哈希：跳过校验（自定义 engineUrl 时请同时给 engineSha256）')
    }

    const zip = path.join(layout.downloads, asset)
    state.phase = 'download'
    for (let attempt = 0; attempt < 2; attempt += 1) {
      state.downloaded = 0
      state.total = 0
      const result = await download(assetUrl, zip, {
        signal,
        onProgress: (downloaded, total) => {
          state.downloaded = downloaded
          state.total = total
        },
      })
      state.downloaded = result.bytes
      state.total = result.total || result.bytes
      if (!expected) break
      state.phase = 'verify'
      const actual = await hashFile(zip)
      if (actual === expected) break
      log?.(`[install] 校验不符：${actual} != ${expected}，重下一次`)
      if (attempt === 1) throw new Error('下载的安装包校验不通过（可能是代理改写了内容）')
      fs.rmSync(zip, { force: true })
    }

    state.phase = 'extract'
    await extractArchive(zip, layout.root, log)
    fs.rmSync(layout.downloads, { recursive: true, force: true })

    const found = detectInstalled(layout, config)
    if (!found) throw new Error('解压后没有找到 moss_tts.exe + models/，安装包结构可能变了')
    state.phase = 'ready'
    state.error = undefined
    log?.(`[install] ready ${found.exe}`)
    return found
  }

  const start = () => {
    if (running) return running
    state = { phase: 'download', downloaded: 0, total: 0, error: undefined, tag: state.tag }
    running = task()
      .catch((error) => {
        state.phase = 'error'
        state.error = error?.message ?? String(error)
        throw error
      })
      .finally(() => {
        running = undefined
        controller = undefined
      })
    return running
  }

  const ensure = async () => {
    const found = detectInstalled(layout, config)
    if (found) return found
    if (running) {
      await running
      const again = detectInstalled(layout, config)
      if (again) return again
      throw new Error(state.error ?? '引擎安装失败')
    }
    if (config.autoDownload === false) {
      throw new Error('本机还没有 MOSS-TTS 引擎。打开 设置 → Moss 语音 → 下载引擎（约 160 MB）')
    }
    await start()
    const again = detectInstalled(layout, config)
    if (!again) throw new Error('引擎安装完成但路径不对，请检查安装目录')
    return again
  }

  const cancel = () => {
    controller?.abort()
    state = { phase: 'idle', downloaded: 0, total: 0, error: undefined, tag: state.tag }
    return true
  }

  return { state: publicState, start, ensure, cancel, get busy() { return running !== undefined } }
}
