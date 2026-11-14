// 宿主 → 浏览器的事件流（SSE）。
//
// 工具调用 moss_tts_say 时，宿主只写一行 `{type:'say', text}` 就返回，真正的
// 合成和播放发生在这里：走 /stream 边合成边播，所以工具在几十毫秒内就结束了。
// 代价是"没有浏览器就没人放"——那时宿主会退回落盘 + 系统播放器，各管各的。
//
// EventSource 断线会自己重连；插件重载后路由会重新注册，重连即可。
let eventSource

function connectEvents() {
  if (eventSource) return
  const Ctor = window.EventSource ?? (typeof EventSource === 'function' ? EventSource : undefined)
  if (!Ctor) return
  try {
    eventSource = new Ctor(`${API}/events`)
  } catch {
    // CSP 或老浏览器不允许 SSE：退回"只有宿主自己播"的老路，别拖垮整个客户端
    eventSource = undefined
    return
  }
  eventSource.onmessage = (event) => {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (!data || typeof data !== 'object') return
    if (data.type === 'say') {
      const text = String(data.text ?? '').trim()
      if (!text) return
      speakText({ text, voice: data.voice, maxChars: 0, jobId: data.id, source: 'tool' })
    } else if (data.type === 'stop') {
      player.stop()
    }
  }
}
