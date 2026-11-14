// 设置页：引擎状态 / 试听台 / 克隆 / 自动朗读 / 性能 / 诊断。
// 每个卡片自己订阅 store，页面本身只负责拉一次音色列表并在克隆后刷新。
function SettingsSection(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const status = useStatus()
  const [prefs] = usePrefs()
  const [voices, setVoices] = react.useState({ installed: false, builtin: [], user: [] })
  const playback = usePlayer()

  const refreshVoices = () => {
    if (status.state !== 'ready') {
      setVoices({ installed: false, builtin: [], user: [] })
      return
    }
    apiGet('/voices')
      .then((data) => setVoices(data))
      .catch(() => {})
  }

  react.useEffect(() => {
    refreshVoices()
  }, [status.state, status.running, status.engineVersion])

  return react.createElement(
    'div',
    { style: ui.section },
    react.createElement('h2', { style: ui.heading }, t('settings.title')),
    react.createElement('p', { style: ui.intro }, t('settings.intro')),

    react.createElement(EngineCard, { t, status }),
    react.createElement(VoiceLab, { t, voices }),
    react.createElement(CloneCard, {
      t,
      onCreated: (name) => {
        refreshVoices()
        prefsStore.set({ voice: name })
      },
    }),
    react.createElement(AutoReadCard, { t, playback }),
    react.createElement(PerfCard, { t }),
    react.createElement(DiagCard, { t, status, prefs, voices }),
  )
}

function EngineCard(props) {
  const { t, status } = props
  const [busy, setBusy] = react.useState('')
  const [notice, setNotice] = react.useState('')
  const [error, setError] = react.useState('')

  const act = async (kind, path, body) => {
    setBusy(kind)
    setError('')
    setNotice('')
    try {
      const data = await apiPost(path, body ?? {})
      if (kind === 'check') {
        setNotice(data.ok ? (data.restarted ? t('settings.engineDead') : t('settings.engineReady', { version: data.status?.engineVersion ?? data.status?.version ?? '' })) : '')
      } else if (kind === 'stop') {
        setNotice(t('settings.engineStopped'))
      } else if (kind === 'restart') {
        setNotice(t('settings.engineReady', { version: data.info?.version ?? '0.1.2' }))
      }
      statusStore.refresh()
    } catch (failure) {
      setError(String(failure?.message ?? failure))
    } finally {
      setBusy('')
    }
  }

  const installing = status.state === 'installing'
  const percent = status.install?.total > 0 ? Math.round((status.install.downloaded / status.install.total) * 100) : 0
  const ready = status.state === 'ready'

  return react.createElement(
    Card,
    {
      title: t('settings.engine'),
      right: react.createElement(
        'span',
        { style: { ...ui.row, gap: '6px' } },
        react.createElement(StateDot, { state: status.state, title: status.state }),
        react.createElement('span', { style: ui.label }, t(`settings.state.${status.state === 'unknown' ? 'missing' : status.state}`)),
        status.version ? react.createElement('span', { style: ui.label }, `v${status.version}`) : null,
      ),
    },
    status.updateAvailable
      ? react.createElement(Btn, { primary: true, onClick: () => act('install', '/install') }, t('settings.update', { version: status.manifest?.release ?? '' }))
      : null,
    react.createElement('div', { style: ui.label }, t('settings.enginePath')),
    react.createElement('div', { style: ui.value }, status.exe ?? ''),
    status.engine
      ? react.createElement(
          'div',
          { style: ui.label },
          t('settings.engineNow', {
            llm: status.engine.llm_threads,
            decode: status.engine.decode_threads,
            backend: status.engine.backend ?? '?',
            cores: status.engine.physical_cores ?? '?',
          }),
        )
      : null,
    installing
      ? react.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
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
      ready ? null : react.createElement(Btn, { primary: !installing, disabled: installing || busy, onClick: () => act('install', '/install') }, t('settings.download')),
      installing ? react.createElement(Btn, { onClick: () => act('cancel', '/install/cancel') }, t('settings.cancel')) : null,
      ready
        ? react.createElement(
            Btn,
            { disabled: busy !== '', onClick: () => act('check', '/engine/health') },
            busy === 'check' ? t('settings.checking') : t('settings.recheck'),
          )
        : null,
      ready
        ? react.createElement(
            Btn,
            { disabled: busy !== '', onClick: () => act('restart', '/engine/restart') },
            busy === 'restart' ? t('settings.restarting') : t('settings.restart'),
          )
        : null,
      ready && status.running
        ? react.createElement(Btn, { disabled: busy !== '', onClick: () => act('stop', '/engine/stop') }, t('settings.stop'))
        : null,
      react.createElement(Btn, { onClick: () => act('reveal', '/engine/reveal') }, t('settings.reveal')),
    ),
    notice ? react.createElement('div', { style: ui.label }, notice) : null,
    react.createElement(ErrorLine, null, error),
  )
}

function AutoReadCard(props) {
  const { t, playback } = props
  const [prefs, setPrefs] = usePrefs()
  const modes = ['smart', 'full', 'canned']

  return react.createElement(
    Card,
    { title: t('settings.autoRead'), hint: t('settings.autoReadHint') },
    react.createElement(Toggle, {
      checked: prefs.autoRead,
      onChange: (checked) => setPrefs({ autoRead: checked }),
      label: t('settings.autoReadToggle'),
    }),
    react.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      react.createElement('span', { style: ui.label }, t('settings.mode')),
      modes.map((mode) =>
        react.createElement(RadioOption, {
          key: mode,
          name: 'moss-tts-mode',
          checked: prefs.speakMode === mode,
          onChange: () => setPrefs({ speakMode: mode }),
          label: t(`settings.mode.${mode}`),
          hint: t(`settings.mode.${mode}Hint`),
        }),
      ),
    ),
    prefs.speakMode === 'canned'
      ? react.createElement(Field, { label: t('settings.cannedText') }, react.createElement(TextInput, {
          value: prefs.cannedText,
          onChange: (value) => setPrefs({ cannedText: value }),
          style: { minWidth: '320px' },
        }))
      : null,
    react.createElement(
      'div',
      { style: ui.row },
      react.createElement(Field, { label: t('settings.maxChars') }, react.createElement(NumberInput, {
        value: prefs.maxChars,
        min: 0,
        max: 20000,
        step: 100,
        onChange: (value) => setPrefs({ maxChars: value }),
      })),
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
  )
}

function DiagCard(props) {
  const { t, status, prefs, voices } = props
  const [copied, setCopied] = react.useState(false)
  const [error, setError] = react.useState('')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ status, prefs, voices }, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('剪贴板不可用')
    }
  }
  return react.createElement(
    Card,
    {
      title: t('settings.diag'),
      right: react.createElement(Btn, { onClick: copy }, copied ? t('settings.copied') : t('settings.diagCopy')),
    },
    react.createElement(ErrorLine, null, error),
    react.createElement(
      'pre',
      { style: { ...ui.value, maxHeight: '220px', overflow: 'auto', margin: 0, fontSize: '11px' } },
      JSON.stringify({ state: status.state, engine: status.engine, lastJob: status.lastJob, prefs }, null, 2),
    ),
  )
}
