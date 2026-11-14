// 宿主 → 浏览器：一条单向事件流（SSE）。
//
// 为什么需要它：工具要"说完就走"，可声音只有浏览器放得出来（宿主是 Node，
// 没有 AudioContext；交给系统播放器又没法暂停/重播）。所以工具只把"放这段话"
// 丢进这条流就返回，浏览器半边接住后走 /stream 边合成边播。
//
// 浏览器不在线时 size 为 0，调用方退回"落盘 + 系统播放器"的老路。
export function createEventHub(options = {}) {
  const heartbeatMs = options.heartbeatMs ?? 20000
  const clients = new Set()
  let timer

  const beat = () => {
    for (const res of [...clients]) {
      try {
        res.write(': ping\n\n')
      } catch {
        clients.delete(res)
      }
    }
  }

  const startHeartbeat = () => {
    if (timer) return
    timer = setInterval(beat, heartbeatMs)
    timer.unref?.()
  }

  const drop = (res) => {
    clients.delete(res)
    if (clients.size === 0) {
      clearInterval(timer)
      timer = undefined
    }
  }

  return {
    get size() {
      return clients.size
    },
    /** 接管一个 GET /events 的响应；返回后连接一直开着，直到浏览器断开或 closeAll()。 */
    open(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        // 反向代理别缓冲：事件必须立刻出去
        'x-accel-buffering': 'no',
      })
      res.write(': moss-tts\n\n')
      clients.add(res)
      startHeartbeat()
      const done = () => drop(res)
      req.on('close', done)
      res.on('close', done)
      res.on('error', done)
    },
    send(event) {
      if (clients.size === 0) return 0
      const line = `data: ${JSON.stringify(event)}\n\n`
      for (const res of [...clients]) {
        try {
          if (!res.writableEnded) res.write(line)
        } catch {
          drop(res)
        }
      }
      return clients.size
    },
    closeAll() {
      clearInterval(timer)
      timer = undefined
      for (const res of [...clients]) {
        try {
          res.end()
        } catch {
          // 已经断了
        }
      }
      clients.clear()
    },
  }
}
