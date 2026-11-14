// 试听台：一段文字 + 一排音色。点音色 = 设为默认音色，点 ▶ = 用它试听。
// 耗时来自 /status 里的 lastJob（宿主每次合成都记一条），和引擎网页看到的是同一组数字。
const LAB_DEFAULT_TEXT = '你好，我是deepseek助手，很高兴为您服务。'

function VoiceLab(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const voices = props.voices ?? { builtin: [], user: [] }
  const [prefs, setPrefs] = usePrefs()
  const status = useStatus()
  const playback = usePlayer()
  const [text, setText] = react.useState(LAB_DEFAULT_TEXT)
  const [notice, setNotice] = react.useState('')

  const choices = [
    ...(voices.builtin ?? []).map((voice) => ({ ...voice, user: false })),
    ...(voices.user ?? []).map((voice) => ({ ...voice, user: true })),
  ]
  const speaking = playback.state !== 'idle'
  const disabled = !statusReady(status) || !text.trim()

  const play = (voice) => {
    if (speaking) {
      player.stop()
      return
    }
    player.stop()
    speakText({
      text,
      voice: voice ?? prefs.voice,
      source: 'test',
      onError: (error) => setNotice(String(error?.message ?? error)),
    })
  }

  const download = async () => {
    setNotice('')
    try {
      const res = await fetch('/moss-tts/wav', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice: prefs.voice }),
      })
      if (!res.ok) {
        const detail = await readResponse(res).catch((error) => error.payload ?? { error: String(error) })
        throw new Error(detail.error ?? `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `moss-tts-${Date.now().toString(36)}.wav`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setNotice(String(error?.message ?? error))
    }
  }

  const timing = timingText(status.lastJob)

  return react.createElement(
    Card,
    { title: t('settings.lab'), hint: t('settings.labHint') },
    react.createElement(
      'div',
      { style: { ...ui.row, alignItems: 'flex-start' } },
      react.createElement(TextArea, {
        value: text,
        onChange: setText,
        rows: 3,
        placeholder: t('settings.labText'),
      }),
    ),
    react.createElement(
      'div',
      { style: ui.row },
      react.createElement(Btn, { primary: true, disabled, onClick: () => play(undefined) }, speaking ? t('settings.stopPlay') : t('settings.play')),
      react.createElement(Btn, { disabled, onClick: download }, t('settings.downloadWav')),
      timing ? react.createElement('span', { style: ui.label }, timing) : null,
    ),
    react.createElement(ErrorLine, null, notice),

    react.createElement(
      'div',
      { style: { ...ui.row, alignItems: 'center' } },
      react.createElement('span', { style: { ...ui.label, minWidth: '86px' } }, t('settings.voice')),
      react.createElement(
        SelectInput,
        {
          value: prefs.voice,
          disabled: choices.length === 0,
          onChange: (value) => setPrefs({ voice: value }),
          style: { minWidth: '220px' },
        },
        react.createElement('option', { value: '' }, t('settings.voiceDefault')),
        choices.map((voice) =>
          react.createElement(
            'option',
            { key: `${voice.user ? 'u' : 'b'}:${voice.id}`, value: voice.id },
            `${voice.label && voice.label !== voice.id ? `${voice.label}（${voice.id}）` : voice.id}${voice.user ? ' · 我的' : ''}`,
          ),
        ),
      ),
      react.createElement('span', { style: ui.label }, t('settings.voiceHint')),
    ),

    voices.builtin?.length || voices.user?.length
      ? react.createElement(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          choices.map((voice) =>
            react.createElement(VoiceChip, {
              key: `${voice.user ? 'u' : 'b'}:${voice.id}`,
              voice,
              active: prefs.voice === voice.id,
              disabled: !statusReady(status),
              onPick: () => setPrefs({ voice: voice.id }),
              onPlay: () => play(voice.id),
            }),
          ),
        )
      : null,
  )
}

function VoiceChip(props) {
  const { voice, active, disabled, onPick, onPlay } = props
  const label = voice.label && voice.label !== voice.id ? voice.label : voice.id
  return react.createElement(
    'span',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 4px 3px 10px',
        borderRadius: '999px',
        fontSize: '12px',
        border: `1px solid ${active ? 'var(--dsw-alias-state-business-primary, #4c6ef5)' : 'var(--dsw-alias-border-l2, rgba(127,127,127,.35))'}`,
        background: active ? 'rgba(76,110,245,.10)' : 'transparent',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      },
    },
    react.createElement('span', { onClick: disabled ? undefined : onPick, title: voice.id }, `${label}${voice.user ? ' · 我的' : ''}`),
    react.createElement(
      'button',
      {
        type: 'button',
        title: '试听',
        disabled,
        onClick: onPlay,
        style: {
          ...ui.button,
          border: 'none',
          background: 'transparent',
          padding: '0 6px',
          lineHeight: '16px',
        },
      },
      '▶',
    ),
  )
}
