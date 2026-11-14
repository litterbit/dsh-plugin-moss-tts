// 输入框上方的迷你播放条：暂停/继续、重播、停止、进度、已播时间。
//
// 挂在 conversation.input.overlay（宿主给的 composer 顶部锚点），绝对定位到卡片上方，
// 所以聊天区不用为它让位置。只在真的有声时出现，播完/停掉就消失。
function clockOf(frames) {
  const seconds = Math.max(0, Math.floor((Number(frames) || 0) / 48000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function PlayerIcon(props) {
  return react.createElement(
    'button',
    {
      type: 'button',
      title: props.title,
      'aria-label': props.title,
      onClick: props.onClick,
      style: {
        ...ui.button,
        width: '26px',
        height: '26px',
        padding: 0,
        borderRadius: '999px',
        display: 'grid',
        placeItems: 'center',
        fontSize: '12px',
        lineHeight: '24px',
        flex: 'none',
      },
    },
    props.children,
  )
}

function PlayerBar(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const playback = usePlayer()
  if (playback.state === 'idle') return null

  const failed = playback.state === 'error'
  const paused = playback.state === 'paused'
  const total = Number(playback.total) || 0
  const played = Number(playback.played) || 0
  const ratio = total > 0 ? Math.min(1, played / total) : 0
  const label = failed
    ? t('player.error', { message: playback.error ?? '' })
    : playback.state === 'starting'
      ? t('player.buffering')
      : paused
        ? t('player.paused')
        : t('player.playing')
  const time = total > 0 ? `${clockOf(played)} / ${clockOf(total)}` : clockOf(played)

  const actions = failed
    ? [react.createElement(PlayerIcon, { key: 'close', title: t('player.close'), onClick: () => player.dismissError() }, '✕')]
    : [
        paused
          ? react.createElement(PlayerIcon, { key: 'resume', title: t('player.resume'), onClick: () => player.resume() }, '▶')
          : react.createElement(PlayerIcon, { key: 'pause', title: t('player.pause'), onClick: () => player.pause() }, '⏸'),
        react.createElement(PlayerIcon, { key: 'replay', title: t('player.replay'), onClick: () => player.replay() }, '↻'),
        react.createElement(PlayerIcon, { key: 'stop', title: t('player.stop'), onClick: () => player.stop() }, '⏹'),
      ]

  return react.createElement(
    'div',
    {
      style: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        transform: 'translateY(-100%)',
        padding: '0 14px 8px',
        pointerEvents: 'none',
        zIndex: 40,
      },
    },
    react.createElement(
      'div',
      {
        style: {
          pointerEvents: 'auto',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          padding: '6px 10px 7px',
          borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
          background: 'var(--dsw-specific-input-major, rgba(255,255,255,.96))',
          boxShadow: 'var(--dsw-elevation-soft, 0 2px 10px rgba(0,0,0,.12))',
          color: 'var(--dsw-alias-label-primary, inherit)',
        },
      },
      react.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
        ...actions,
        react.createElement(
          'span',
          {
            style: {
              marginLeft: '6px',
              fontSize: '12px',
              color: failed ? '#e03131' : 'var(--dsw-alias-label-secondary, #666)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          },
          label,
        ),
        react.createElement('span', { style: { flex: '1' } }),
        react.createElement(
          'span',
          { style: { fontSize: '12px', fontFamily: 'ui-monospace, monospace', color: 'var(--dsw-alias-label-tertiary, #888)' } },
          time,
        ),
      ),
      failed
        ? null
        : react.createElement(
            'div',
            { style: { ...ui.bar, height: '3px' } },
            react.createElement('div', { style: { ...ui.barFill, width: `${(ratio * 100).toFixed(1)}%` } }),
          ),
    ),
  )
}
