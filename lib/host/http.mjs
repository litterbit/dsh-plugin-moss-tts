// 极简 HTTP 客户端：只需要三件事——跟随重定向、断点续传、把字节写到文件。
// 不引第三方库（插件安装时不跑构建，也不该多出依赖）。
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

const MAX_REDIRECTS = 6
const UA = 'dsh-plugin-moss-tts'

function transport(url) {
  return url.startsWith('https:') ? https : http
}

/** 发一个请求并跟随重定向，返回 { status, headers, url, stream }。 */
export function open(url, options = {}) {
  const { method = 'GET', headers = {}, signal, timeoutMs = 30000, redirects = 0 } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }
    const parsed = new URL(url)
    const req = transport(parsed).request(parsed, {
      method,
      headers: { 'user-agent': UA, ...headers },
    })
    const onAbort = () => {
      req.destroy(new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`连接超时：${parsed.host}`))
    })
    req.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    req.on('response', (res) => {
      signal?.removeEventListener('abort', onAbort)
      const status = res.statusCode ?? 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location && redirects < MAX_REDIRECTS) {
        res.resume()
        const next = new URL(location, parsed).toString()
        open(next, { ...options, redirects: redirects + 1 }).then(resolve, reject)
        return
      }
      resolve({ status, headers: res.headers, url: parsed.toString(), stream: res })
    })
    req.end()
  })
}

/** 取一小段文本（错误页、sha256sums.txt 之类）。 */
export async function getText(url, options = {}) {
  const { maxBytes = 256 * 1024, ...rest } = options
  const res = await open(url, rest)
  if (res.status !== 200) {
    res.stream.resume()
    throw new Error(`HTTP ${res.status}：${url}`)
  }
  const chunks = []
  let size = 0
  for await (const chunk of res.stream) {
    size += chunk.length
    if (size > maxBytes) {
      res.stream.destroy()
      throw new Error(`响应过大：${url}`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 下载到文件，支持续传：文件已存在且 resume 为真时用 Range 从末尾接上；
 * 服务器忽略 Range（200）就重头写。onProgress 按 (已下载, 总字节) 回调。
 */
export async function downloadTo(url, file, options = {}) {
  const { resume = true, onProgress, signal, headers = {} } = options
  let have = 0
  try {
    if (resume) have = fs.statSync(file).size
  } catch {
    have = 0
  }
  const rangeHeaders = have > 0 ? { ...headers, range: `bytes=${have}-` } : headers
  const res = await open(url, { headers: rangeHeaders, signal })
  if (res.status === 416 && have > 0) {
    // 已经下完（.part 与远端等大），直接交给校验
    return { bytes: have, total: have, resumed: true }
  }
  if (res.status !== 200 && res.status !== 206) {
    res.stream.resume()
    throw new Error(`下载失败：HTTP ${res.status}（${url}）`)
  }
  const restart = res.status === 200
  if (restart) have = 0
  const totalHeader = Number(res.headers['content-length'] ?? 0)
  const total = totalHeader > 0 ? (res.status === 206 ? have + totalHeader : totalHeader) : 0

  fs.mkdirSync(path.dirname(file), { recursive: true })
  const sink = fs.createWriteStream(file, restart || have === 0 ? { flags: 'w' } : { flags: 'a' })
  let got = have
  try {
    for await (const chunk of res.stream) {
      if (signal?.aborted) throw new Error('已取消')
      if (!sink.write(chunk)) await new Promise((resolve) => sink.once('drain', resolve))
      got += chunk.length
      onProgress?.(got, total || got)
    }
  } finally {
    await new Promise((resolve) => sink.end(resolve))
  }
  return { bytes: got, total: total || got, resumed: !restart && have > 0 }
}
