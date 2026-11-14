// 性能：LLM / 解码器两个线程池。写入 <data>/settings.json，必须重启引擎才生效。
function PerfCard(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const [prefs, setPrefs] = usePrefs()
  const status = useStatus()
  const [llm, setLlm] = react.useState(prefs.llmThreads)
  const [decode, setDecode] = react.useState(prefs.decodeThreads)
  const [busy, setBusy] = react.useState(false)
  const [notice, setNotice] = react.useState('')
  const [error, setError] = react.useState('')

  react.useEffect(() => {
    setLlm(prefs.llmThreads)
    setDecode(prefs.decodeThreads)
  }, [prefs.llmThreads, prefs.decodeThreads])

  const engine = status.engine
  const restart = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await apiPost('/engine/restart', { llmThreads: llm, decodeThreads: decode })
      setPrefs({ llmThreads: llm, decodeThreads: decode })
      setNotice(t('settings.saved'))
      statusStore.refresh()
    } catch (failure) {
      setError(String(failure?.message ?? failure))
    } finally {
      setBusy(false)
    }
  }

  return react.createElement(
    Card,
    { title: t('settings.perf'), hint: t('settings.perfHint') },
    engine
      ? react.createElement(
          'div',
          { style: ui.label },
          t('settings.engineNow', {
            llm: engine.llm_threads,
            decode: engine.decode_threads,
            backend: engine.backend ?? '?',
            cores: engine.physical_cores ?? '?',
          }),
        )
      : null,
    react.createElement(
      'div',
      { style: ui.row },
      react.createElement(Field, { label: t('settings.llmThreads') }, react.createElement(NumberInput, { value: llm, min: 0, max: 64, onChange: setLlm })),
      react.createElement(Field, { label: t('settings.decodeThreads') }, react.createElement(NumberInput, { value: decode, min: 0, max: 64, onChange: setDecode })),
      react.createElement('span', { style: ui.label }, t('settings.threadsAuto')),
    ),
    react.createElement(
      'div',
      { style: ui.row },
      react.createElement(Btn, { onClick: () => setPrefs({ llmThreads: llm, decodeThreads: decode }) }, t('settings.save')),
      react.createElement(Btn, { primary: true, disabled: busy, onClick: restart }, busy ? t('settings.restarting') : t('settings.saveRestart')),
      notice ? react.createElement('span', { style: ui.label }, notice) : null,
    ),
    react.createElement(ErrorLine, null, error),
  )
}
