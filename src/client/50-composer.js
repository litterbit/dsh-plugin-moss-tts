// 输入框左侧的开关 + 自动朗读的判定。
//
// 自动朗读的规则（宁可不读，也不要把历史记录从头念一遍）：
//   1. 第一次看到某个会话：把"已定稿的最大 seq"记成基线，历史一条都不念；
//   2. 之后只有 seq 比基线大、且带 messageId 的 assistant 节点才算新回复
//      （流式中的节点没有 messageId，正好被排除）；
//   3. 新回复出现后等 250 ms 去抖，再按设置里的模式处理：
//        full   —— 清洗后整段念；
//        canned —— 只念固定语句；
//        smart  —— 先问宿主（子代理）要一句摘要，失败退回固定语句/全文；
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

function isUserNode(node) {
  return node && (node.kind === 'user' || node.kind === 'human' || node.role === 'user')
}

/** 这一轮对应的用户提问（seq 在回复之前、最近的一条）。 */
function lastQuestionOf(nodes, beforeSeq) {
  let found = ''
  for (const node of nodes) {
    if (!node || !isUserNode(node)) continue
    if (typeof node.seq === 'number' && typeof beforeSeq === 'number' && node.seq >= beforeSeq) continue
    const text = assistantTextOf(node)
    if (text) found = text
  }
  return found
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

/** 按当前模式决定"念什么"，然后交给播放器。 */
async function announceReply({ text, question, messageId, sessionId, onError }) {
  const prefs = prefsStore.value
  const mode = prefs.speakMode || 'full'
  let spoken = text

  if (mode === 'canned') {
    spoken = prefs.cannedText
  } else if (mode === 'smart') {
    let summary = ''
    try {
      const data = await apiPost('/summary', {
        sessionId,
        messageId,
        question: (question ?? '').slice(0, 1000),
        answer: String(text ?? '').slice(0, 4000),
      })
      summary = typeof data?.text === 'string' ? data.text : ''
    } catch {
      summary = ''
    }
    // 宿主已经做过抽取式回退；接口本身失败才走这里
    spoken = summary || prefs.cannedText || text
  }

  if (!String(spoken ?? '').trim()) return
  await speakText({
    text: spoken,
    voice: prefs.voice,
    maxChars: prefs.maxChars,
    source: 'auto',
    messageId,
    onError,
  })
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
    const last = fresh[fresh.length - 1]
    const text = fresh.map((item) => item.text).join('\n')
    announceReply({
      text,
      question: lastQuestionOf(nodes, last.node.seq),
      messageId: last.node.messageId,
      sessionId,
      onError,
    }).catch((error) => onError?.(error))
  }, 250)
}

function ComposerToggle(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const [prefs, setPrefs] = usePrefs()
  const status = useStatus()
  const playback = usePlayer()
  const [error, setError] = react.useState('')
  const useTrajectorySafe =
    typeof props.useTrajectory === 'function' ? props.useTrajectory : (selector) => selector(undefined)
  const snapshot = useTrajectorySafe((state) => state)
  // composer slot 不保证传 sessionId；轨迹快照里通常带着，再不行就用 'default'
  // （宿主侧对不上时会退回"任意在线 agent"来授权子代理）
  const sessionId = props.sessionId ?? snapshot?.sessionId ?? snapshot?.session?.id ?? 'default'

  react.useEffect(() => {
    observeAutoRead(sessionId, snapshot, prefs.autoRead, (failure) => {
      setError(String(failure?.message ?? failure))
    })
  }, [snapshot, prefs.autoRead, prefs.speakMode, sessionId])

  const ready = statusReady(status)
  const speaking = playback.state !== 'idle'
  const modeLabel = t(`composer.mode.${prefs.speakMode || 'full'}`)
  const title = !ready
    ? t('composer.notReady')
    : speaking
      ? t('composer.stop')
      : prefs.autoRead
        ? `${t('composer.autoReadOn')} · ${modeLabel}`
        : t('composer.autoReadOff')

  const onClick = () => {
    // 有声（不管是工具读的、自动朗读还是手动读的）时就当停止键用
    if (speaking) {
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
      'aria-pressed': speaking ? true : prefs.autoRead,
      onClick,
      style: {
        ...ui.button,
        padding: '4px 8px',
        lineHeight: '16px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        opacity: ready ? 1 : 0.65,
        borderColor: speaking ? 'var(--dsw-alias-state-business-primary, #4c6ef5)' : undefined,
      },
    },
    react.createElement('span', { 'aria-hidden': true }, speaking ? '⏹' : prefs.autoRead ? '🔊' : '🔇'),
    ready ? null : react.createElement(StateDot, { state: status.state, title }),
  )
}
