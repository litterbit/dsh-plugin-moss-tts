// 每条助手回复右侧的朗读键。
function ReadAction(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const [prefs] = usePrefs()
  const playback = usePlayer()
  const messageId = props.messageId
  const useTrajectorySafe =
    typeof props.useTrajectory === 'function' ? props.useTrajectory : (selector) => selector(undefined)
  const text = useTrajectorySafe((state) => {
    if (!state || !Array.isArray(state.eventNodes) || messageId === undefined) return ''
    const node = state.eventNodes.find((candidate) => candidate.messageId === messageId)
    return node ? assistantTextOf(node) : ''
  })

  const active = playback.messageId === messageId && playback.state !== 'idle'
  const empty = !text

  const onClick = () => {
    if (active) {
      player.stop()
      return
    }
    if (empty) return
    speakText({
      text,
      voice: prefs.voice,
      source: 'action',
      messageId,
    })
  }

  return react.createElement(
    'button',
    {
      type: 'button',
      title: active ? t('action.stop') : empty ? t('action.empty') : t('action.read'),
      onClick,
      disabled: empty && !active,
      style: {
        ...ui.button,
        border: 'none',
        background: 'transparent',
        padding: '2px 6px',
        lineHeight: '16px',
        opacity: empty && !active ? 0.4 : 1,
      },
    },
    react.createElement('span', { 'aria-hidden': true }, active ? '⏹' : '🔊'),
  )
}
