// 输入框左侧的开关 + 自动朗读的判定。
//
// 自动朗读的规则（宁可不读，也不要把历史记录从头念一遍）：
//   1. 第一次看到某个会话：把"已定稿的最大 seq"记成基线，历史一条都不念；
//   2. 之后只有 seq 比基线大、且带 messageId 的 assistant 节点才算新回复
//      （流式中的节点没有 messageId，正好被排除）；
//   3. 新回复出现后等 250 ms 去抖，再整段念（同一轮的多个节点合并成一段）；
//   4. 判不出来就静默跳过 —— 手动朗读键和工具都不受影响。
const autoReaders = new Map()

function assistantTextOf(node) {
  const blocks = Array.isArray(node?.blocks) ? node.blocks : []
  return blocks
    .filter((block) => block && block.kind === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function settledSeq(nodes) {
  let max
  for (const node of nodes) {
    if (!node || typeof node.seq !== 'number') continue
    if (node.kind === 'assistant' && node.messageId === undefined) continue
    if (max === undefined || node.seq > max) max = node.seq
  }
  return max
}

function observeAutoRead(sessionId, snapshot, enabled, onError) {
  if (!snapshot || !Array.isArray(snapshot.eventNodes)) return
  const nodes = snapshot.eventNodes
  let state = autoReaders.get(sessionId)
  if (!state) {
    autoReaders.set(sessionId, { seq: settledSeq(nodes), timer: undefined })
    return
  }
  const fresh = []
  for (const node of nodes) {
    if (typeof node.seq !== 'number') continue
    if (state.seq !== undefined && node.seq <= state.seq) continue
    if (node.kind !== 'assistant' || !node.messageId || node.interrupted === true) continue
    const text = assistantTextOf(node)
    if (text) fresh.push({ node, text })
  }
  const max = settledSeq(nodes)
  if (max !== undefined && (state.seq === undefined || max > state.seq)) state.seq = max
  if (!enabled || fresh.length === 0) return
  clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    const prefs = prefsStore.value
    speakText({
      text: fresh.map((item) => item.text).join('\n'),
      voice: prefs.voice,
      maxChars: prefs.maxChars,
      source: 'auto',
      messageId: fresh[fresh.length - 1].node.messageId,
      onError,
    })
  }, 250)
}

function ComposerToggle(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const [prefs, setPrefs] = usePrefs()
  const status = useStatus()
  const playback = usePlayer()
  const [error, setError] = react.useState('')
  const sessionId = props.sessionId ?? 'default'
  const useTrajectorySafe =
    typeof props.useTrajectory === 'function' ? props.useTrajectory : (selector) => selector(undefined)
  const snapshot = useTrajectorySafe((state) => state)

  react.useEffect(() => {
    observeAutoRead(sessionId, snapshot, prefs.autoRead, (failure) => {
      setError(String(failure?.message ?? failure))
    })
  }, [snapshot, prefs.autoRead, sessionId])

  const ready = statusReady(status)
  const speaking = playback.state !== 'idle'
  const autoSpeaking = speaking && playback.source === 'auto'
  const title = !ready
    ? t('composer.notReady')
    : autoSpeaking
      ? t('composer.stop')
      : prefs.autoRead
        ? t('composer.autoReadOn')
        : t('composer.autoReadOff')

  const onClick = () => {
    if (autoSpeaking) {
      player.stop()
      return
    }
    setPrefs({ autoRead: !prefs.autoRead })
  }

  return react.createElement(
    'button',
    {
      type: 'button',
      title: error ? `${title} · ${error}` : title,
      'aria-pressed': autoSpeaking ? true : prefs.autoRead,
      onClick,
      style: {
        ...ui.button,
        padding: '4px 8px',
        lineHeight: '16px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        opacity: ready ? 1 : 0.65,
        borderColor: autoSpeaking ? 'var(--dsw-alias-state-business-primary, #4c6ef5)' : undefined,
      },
    },
    react.createElement('span', { 'aria-hidden': true }, autoSpeaking ? '⏹' : prefs.autoRead ? '🔊' : '🔇'),
    ready ? null : react.createElement(StateDot, { state: status.state, title }),
  )
}
