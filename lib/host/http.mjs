// 极简 HTTP 客户端：只需要三件事——跟随重定向、断点续传、把字节写到文件。
// 不引第三方库（插件安装时不跑构建，也不该多出依赖）。
//
// 代理：Node 不读 Windows 的 Internet 设置，所以在"浏览器能打开 GitHub、
// 插件却装不上"的机器上必须自己接。顺序是 HTTPS_PROXY 等环境变量 →
// 注册表 ProxyServer（受 ProxyEnable 控制）。只做 CONNECT 隧道，够用。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import tls from 'node:tls'

const MAX_REDIRECTS = 6
const UA = 'dsh-plugin-moss-tts'
const NO_PROXY = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/iu

let cachedProxy

function parseProxy(raw) {
  if (!raw) return null
  let host = String(raw).trim()
  // "http=host:port;https=host:port"：取 https 那条，没有再退回第一条
  if (host.includes('=')) {
    const parts = Object.fromEntries(
      host.split(';').map((item) => {
        const [key, value] = item.split('=')
        return [String(key).trim().toLowerCase(), String(value ?? '').trim()]
      }),
    )
    host = parts.https || parts.http || ''
  }
  if (!host) return null
  if (!host.includes('://')) host = `http://${host}`
  try {
    const url = new URL(host)
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    return { host: url.hostname, port }
  } catch {
    return null
  }
}

/** 系统代理（只算一次）。没有就返回 null，走直连。 */
export function systemProxy() {
  if (cachedProxy !== undefined) return cachedProxy
  cachedProxy = null
  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  if (fromEnv) {
    cachedProxy = parseProxy(fromEnv)
    return cachedProxy
  }
  if (process.platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    try {
      const query = (name) =>
        execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true })
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/iu.test(query('ProxyEnable'))
      if (enabled) cachedProxy = parseProxy(/ProxyServer\s+REG_SZ\s+(\S+)/iu.exec(query('ProxyServer'))?.[1])
    } catch {
      cachedProxy = null
    }
  }
  return cachedProxy
}

function transport(url) {
  return url.protocol === 'https:' ? https : http
}

/** 通过代理开一条到目标主机的 CONNECT 隧道，返回天然 TLS socket。 */
function tunnel(target, proxy, timeoutMs) {
  const host = target.hostname
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}`, 'user-agent': UA },
      timeout: timeoutMs,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`代理拒绝 CONNECT：HTTP ${res.statusCode}`))
        return
      }
      const secure = tls.connect({ socket, servername: host }, () => resolve(secure))
      secure.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`代理连接超时：${proxy.host}:${proxy.port}`)))
    req.on('error', reject)
    req.end()
  })
}

/** 发一个请求并跟随重定向，返回 { status, headers, url, stream }。 */
export async function open(url, options = {}) {
  const { method = 'GET', headers = {}, signal, timeoutMs = 30000, redirects = 0 } = options
  if (signal?.aborted) throw new Error('已取消')
  const parsed = new URL(url)
  const proxy = NO_PROXY.test(parsed.hostname) ? null : systemProxy()
  const viaTunnel = proxy && parsed.protocol === 'https:'
  const socket = viaTunnel ? await tunnel(parsed, proxy, timeoutMs) : undefined

  // 三种走法：直连、https 走 CONNECT 隧道（隧道里已经是 TLS，用 http 说协议）、
  // http 走代理（绝对 URI）。
  const request = (() => {
    if (viaTunnel) {
      // 隧道里已经是 TLS，用 http 说协议；createConnection 交给一次性 agent，
      // 直接写进请求选项会被 Node 忽略（会自己再连一次）。
      const agent = new http.Agent({ keepAlive: false })
      agent.createConnection = () => socket
      return http.request({
        host: parsed.hostname,
        port: Number(parsed.port) || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: { 'user-agent': UA, host: parsed.host, ...headers },
        agent,
      })
    }
    if (proxy) {
      return http.request({
        host: proxy.host,
        port: proxy.port,
        path: parsed.toString(),
        method,
        headers: { 'user-agent': UA, host: parsed.host, ...headers },
      })
    }
    return transport(parsed).request(parsed, {
      method,
      headers: { 'user-agent': UA, ...headers },
    })
  })()

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      request.destroy()
      socket?.destroy()
      reject(new Error('已取消'))
      return
    }
    const onAbort = () => {
      request.destroy(new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`连接超时：${parsed.host}`))
    })
    request.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    request.on('response', (res) => {
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
    request.end()
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
