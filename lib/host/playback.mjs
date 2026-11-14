// 浏览器那边"正在播什么"的镜像。
//
// 用途有三个：moss_tts_say 的 wait=true、moss_tts_stop 的返回值、
// 以及 moss_tts_engine status 里那一行"播放中"。
// 浏览器每次状态变化 POST 一次 /player，这里只做合并，不参与播放。
const RATE = 48000
const TERMINAL = new Set(['done', 'stopped', 'error', 'idle'])

export function createPlayback() {
  const state = { id: undefined, state: 'idle', since: 0, voice: '', chars: 0, played: 0, total: 0 }
  const waiters = new Map()

  const settle = (status) => {
    for (const [id, waiter] of [...waiters]) {
      waiters.delete(id)
      clearTimeout(waiter.timer)
      waiter.resolve(status)
    }
  }

  return {
    snapshot() {
      return {
        state: state.state,
        id: state.id ?? '',
        voice: state.voice,
        chars: state.chars,
        played: Math.round((state.played / RATE) * 10) / 10,
        total: Math.round((state.total / RATE) * 10) / 10,
        since: state.since,
      }
    },
    busy() {
      return state.state !== 'idle' && state.state !== 'error'
    },
    start(id, meta = {}) {
      Object.assign(state, {
        id,
        state: 'starting',
        since: Date.now(),
        voice: String(meta.voice ?? ''),
        chars: Number(meta.chars ?? 0),
        played: 0,
        total: 0,
      })
      return this.snapshot()
    },
    update(patch = {}) {
      if (!patch || typeof patch !== 'object') return this.snapshot()
      // 浏览器直接上报（宿主没先 start）时，用它给的 id 建条目
      if (patch.id && !state.id) state.id = String(patch.id)
      // 迟到的旧作业状态不能盖掉新作业
      if (patch.id && state.id && patch.id !== state.id) return this.snapshot()
      if (patch.state) state.state = String(patch.state)
      if (Number.isFinite(patch.played) && patch.played >= 0) state.played = patch.played
      if (Number.isFinite(patch.total) && patch.total > 0) state.total = patch.total
      if (TERMINAL.has(state.state)) settle(state.state)
      return this.snapshot()
    },
    end(status = 'done') {
      state.state = status
      settle(status)
      return this.snapshot()
    },
    /** 等这一段播完/被停掉；浏览器不在或已播完就立刻返回。 */
    wait(id, timeoutMs = 600000) {
      if (!id || !this.busy() || state.id !== id) return Promise.resolve(state.state)
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(id)
          resolve('timeout')
        }, timeoutMs)
        timer.unref?.()
        waiters.set(id, { resolve, timer })
      })
    },
  }
}
