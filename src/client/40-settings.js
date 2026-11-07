// 设置页：引擎状态 / 下载 / 音色 / 自动朗读开关 / 诊断。
function SettingsSection(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const status = useStatus()
  const [prefs, setPrefs] = usePrefs()
  const [voices, setVoices] = react.useState({ installed: false, builtin: [], user: [] })
  const [notice, setNotice] = react.useState('')
  const [copied, setCopied] = react.useState(false)
  const playback = usePlayer()

  react.useEffect(() => {
    if (status.state !== 'ready') {
      setVoices({ installed: false, builtin: [], user: [] })
      return undefined
    }
    let alive = true
    apiGet('/voices')
      .then((data) => {
        if (alive) setVoices(data)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [status.state])

  const later = (promise) =>
    promise.catch((error) => {
      setNotice(String(error?.message ?? error))
    })

  const install = () => later(apiPost('/install', {}))
  const cancel = () => later(apiPost('/install/cancel', {}))
  const reveal = () => later(apiPost('/engine/reveal', {}))
  const preview = () =>
    speakText({
      text: '你好，我是 MOSS 语音，现在可以用本地引擎朗读了。',
      voice: prefs.voice,
      source: 'test',
      onError: (error) => setNotice(String(error?.message ?? error)),
    })
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ status, prefs, voices }, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setNotice('剪贴板不可用')
    }
  }

  const installing = status.state === 'installing'
  const choices = [...(voices.builtin ?? []), ...(voices.user ?? []).map((voice) => ({ ...voice, user: true }))]
  const percent = status.install?.total > 0 ? Math.round((status.install.downloaded / status.install.total) * 100) : 0

  return react.createElement(
    'div',
    { style: ui.section },
    react.createElement('h2', { style: ui.heading }, t('settings.title')),
    react.createElement('p', { style: ui.intro }, t('settings.intro')),

    react.createElement(
      'div',
      { style: ui.card },
      react.createElement(
        'div',
        { style: ui.row },
        react.createElement(StateDot, { state: status.state, title: status.state }),
        react.createElement('strong', null, t('settings.engine')),
        react.createElement('span', { style: ui.label }, t(`settings.state.${status.state === 'unknown' ? 'missing' : status.state}`)),
        status.version ? react.createElement('span', { style: ui.label }, `v${status.version}`) : null,
      ),
      status.engineVersion && status.engineVersion !== status.version
        ? react.createElement('div', { style: ui.label }, `进程内版本：${status.engineVersion}`)
        : null,
      react.createElement('div', { style: ui.label }, t('settings.enginePath')),
      react.createElement('div', { style: ui.value }, status.exe ?? ''),
      installing
        ? react.createElement(
            'div',
            { style: { ...ui.row, flexDirection: 'column', alignItems: 'stretch' } },
            react.createElement(Progress, { value: status.install.downloaded, total: status.install.total }),
            react.createElement(
              'div',
              { style: ui.label },
              status.install.phase === 'verify'
                ? t('settings.phase.verify')
                : status.install.phase === 'extract'
                  ? t('settings.phase.extract')
                  : `${t('settings.installing', { done: formatBytes(status.install.downloaded), total: formatBytes(status.install.total) })} · ${percent}%`,
            ),
          )
        : null,
      status.state === 'error' || status.install?.error
        ? react.createElement('div', { style: { ...ui.label, color: '#e03131' } }, status.install?.error ?? status.error ?? '')
        : null,
      react.createElement(
        'div',
        { style: ui.row },
        status.state === 'ready'
          ? null
          : react.createElement(Btn, { primary: !installing, disabled: installing, onClick: install }, t('settings.download')),
        installing ? react.createElement(Btn, { onClick: cancel }, t('settings.cancel')) : null,
        react.createElement(Btn, { onClick: reveal }, t('settings.reveal')),
      ),
    ),

    react.createElement(
      'div',
      { style: ui.card },
      react.createElement(
        'div',
        { style: ui.row },
        react.createElement('strong', null, t('settings.voice')),
        react.createElement(
          'select',
          {
            style: ui.input,
            value: prefs.voice,
            disabled: choices.length === 0,
            onChange: (event) => setPrefs({ voice: event.target.value }),
          },
          choices.length === 0
            ? react.createElement('option', { value: prefs.voice }, prefs.voice)
            : choices.map((voice) =>
                react.createElement(
                  'option',
                  { key: `${voice.user ? 'u' : 'b'}:${voice.id}`, value: voice.id },
                  `${voice.id}${voice.user ? '（我的）' : ''}`,
                ),
              ),
        ),
        react.createElement(Btn, { onClick: preview, disabled: status.state !== 'ready' }, playback.state === 'idle' ? t('settings.test') : t('settings.testing')),
      ),
      react.createElement('div', { style: ui.label }, t('settings.voiceHint')),
    ),

    react.createElement(
      'div',
      { style: ui.card },
      react.createElement('strong', null, t('settings.autoRead')),
      react.createElement(Toggle, {
        checked: prefs.autoRead,
        onChange: (checked) => setPrefs({ autoRead: checked }),
        label: t('settings.autoReadHint'),
      }),
      react.createElement(
        'div',
        { style: ui.row },
        react.createElement('span', { style: ui.label }, t('settings.maxChars')),
        react.createElement('input', {
          type: 'number',
          min: 0,
          max: 20000,
          step: 100,
          style: { ...ui.input, width: '110px' },
          value: prefs.maxChars,
          onChange: (event) => setPrefs({ maxChars: Number(event.target.value) }),
        }),
      ),
      react.createElement(Toggle, {
        checked: prefs.skipCode,
        onChange: (checked) => setPrefs({ skipCode: checked }),
        label: t('settings.skipCode'),
      }),
      playback.error ? react.createElement('div', { style: { ...ui.label, color: '#e03131' } }, playback.error) : null,
      playback.dropped || playback.underruns
        ? react.createElement('div', { style: ui.label }, `丢样 ${playback.dropped} · 欠载 ${playback.underruns}`)
        : null,
    ),

    react.createElement(
      'div',
      { style: ui.card },
      react.createElement(
        'div',
        { style: ui.row },
        react.createElement('strong', null, t('settings.diag')),
        react.createElement(Btn, { onClick: copy }, copied ? t('settings.copied') : t('settings.diagCopy')),
      ),
      notice ? react.createElement('div', { style: { ...ui.label, color: '#e03131' } }, notice) : null,
      react.createElement(
        'pre',
        { style: { ...ui.value, maxHeight: '180px', overflow: 'auto', margin: 0, fontSize: '11px' } },
        JSON.stringify({ state: status.state, install: status.install, prefs, playback }, null, 2),
      ),
    ),
  )
}
