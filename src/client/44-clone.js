// 克隆：拖入音频 → 浏览器解码成 48 kHz → 波形上拖选 1~20 秒 → 试听 → 打 PCM16 WAV 上传。
// 引擎只吃 PCM，MP3/AAC 在这一层就变回样点，文件本身不会离开这台机器。
function CloneCard(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const onCreated = typeof props.onCreated === 'function' ? props.onCreated : () => {}
  const [clip, setClip] = react.useState(undefined) // { fileName, duration, channels }
  const [range, setRange] = react.useState(MossCloneAudio.defaultWindow(0))
  const [name, setName] = react.useState('')
  const [busy, setBusy] = react.useState(false)
  const [previewing, setPreviewing] = react.useState(false)
  const [error, setError] = react.useState('')
  const [notice, setNotice] = react.useState('')
  const canvasRef = react.useRef(null)
  const dragRef = react.useRef(undefined)
  const audioRef = react.useRef(undefined)
  const sourceRef = react.useRef(undefined)

  const load = async (file) => {
    if (!file) return
    setError('')
    setNotice('')
    try {
      const bytes = await file.arrayBuffer()
      // OfflineAudioContext 的 decodeAudioData 会把结果重采样到它的 sampleRate
      const ctx = new OfflineAudioContext(2, MossCloneAudio.RATE, MossCloneAudio.RATE)
      const decoded = await ctx.decodeAudioData(bytes)
      const channels = [
        decoded.getChannelData(0),
        decoded.getChannelData(decoded.numberOfChannels > 1 ? 1 : 0),
      ]
      const duration = decoded.length / MossCloneAudio.RATE
      setClip({ fileName: file.name, duration, channels })
      setRange(MossCloneAudio.defaultWindow(duration))
      setName(MossCloneAudio.suggestName(file.name))
      if (duration > MossCloneAudio.MAX_SECONDS) setNotice(t('settings.cloneTooLong'))
    } catch {
      setError(t('settings.cloneBadType'))
      setClip(undefined)
    }
  }

  // 波形：整段画峰值，选区外压暗、选区内高亮
  react.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const width = Math.max(120, canvas.clientWidth || 480)
    const height = 72
    const ratio = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    const g = canvas.getContext('2d')
    if (!g) return
    g.setTransform(ratio, 0, 0, ratio, 0, 0)
    g.clearRect(0, 0, width, height)
    g.fillStyle = 'rgba(127,127,127,.12)'
    g.fillRect(0, 0, width, height)
    if (!clip) return
    const bars = MossCloneAudio.peaks(clip.channels, width)
    const duration = clip.duration || 1
    for (let x = 0; x < width; x += 1) {
      const inside = x / width >= range.start / duration && x / width <= range.end / duration
      const amplitude = Math.max(1, bars[x] * (height / 2 - 4))
      g.fillStyle = inside ? 'rgba(76,110,245,.85)' : 'rgba(127,127,127,.45)'
      g.fillRect(x, height / 2 - amplitude, 1, amplitude * 2)
    }
    const from = (range.start / duration) * width
    const to = (range.end / duration) * width
    g.fillStyle = 'rgba(76,110,245,.12)'
    g.fillRect(from, 0, Math.max(1, to - from), height)
    g.strokeStyle = 'rgba(76,110,245,.9)'
    g.beginPath()
    g.moveTo(from, 0)
    g.lineTo(from, height)
    g.moveTo(to, 0)
    g.lineTo(to, height)
    g.stroke()
  }, [clip, range])

  const secondsAt = (event) => {
    const canvas = canvasRef.current
    if (!canvas || !clip) return 0
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    return ratio * clip.duration
  }

  const onPointerDown = (event) => {
    if (!clip) return
    const at = secondsAt(event)
    const edge = Math.min(Math.abs(at - range.start), Math.abs(at - range.end))
    dragRef.current = { mode: edge < 0.35 || clip.duration <= MossCloneAudio.MAX_SECONDS ? (Math.abs(at - range.start) < Math.abs(at - range.end) ? 'start' : 'end') : 'move', anchor: at, from: range }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event) => {
    const drag = dragRef.current
    if (!drag || !clip) return
    const at = secondsAt(event)
    if (drag.mode === 'move') {
      setRange(MossCloneAudio.moveWindow(clip.duration, drag.from, drag.from.start + (at - drag.anchor)))
    } else {
      setRange(MossCloneAudio.dragWindow(clip.duration, drag.from, drag.mode, at))
    }
  }

  const onPointerUp = () => {
    dragRef.current = undefined
  }

  const stopPreview = () => {
    try {
      sourceRef.current?.stop()
    } catch {
      // 已经停了
    }
    sourceRef.current = undefined
    setPreviewing(false)
  }

  const preview = () => {
    if (!clip) return
    stopPreview()
    player.stop()
    const sliced = MossCloneAudio.sliceWindow(clip.channels, range)
    if (!sliced.length || !sliced[0].length) {
      setError(t('settings.cloneTooShort'))
      return
    }
    const Ctor = window.AudioContext ?? window.webkitAudioContext
    if (!Ctor) return
    const ctx = audioRef.current ?? new Ctor({ sampleRate: MossCloneAudio.RATE })
    audioRef.current = ctx
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const buffer = ctx.createBuffer(2, sliced[0].length, MossCloneAudio.RATE)
    buffer.copyToChannel(sliced[0], 0)
    buffer.copyToChannel(sliced[1] ?? sliced[0], 1)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.onended = () => setPreviewing(false)
    sourceRef.current = source
    setPreviewing(true)
    source.start()
  }

  const create = async () => {
    if (!clip) return
    if (!/^[\w-]{1,32}$/u.test(name)) {
      setError('音色名只能是字母/数字/_/-，最长 32')
      return
    }
    const length = MossCloneAudio.windowLength(range)
    if (length < MossCloneAudio.MIN_SECONDS) {
      setError(t('settings.cloneTooShort'))
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const wav = MossCloneAudio.buildWav16(MossCloneAudio.sliceWindow(clip.channels, range))
      const res = await fetch(`/moss-tts/voices/clone?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav,
      })
      const data = await readResponse(res)
      setNotice(t('settings.cloneDone', { name }))
      onCreated(name)
      if (data.trimmed) setNotice(t('settings.cloneTooLong'))
    } catch (failure) {
      setError(String(failure?.message ?? failure))
    } finally {
      setBusy(false)
    }
  }

  const length = clip ? MossCloneAudio.windowLength(range) : 0

  return react.createElement(
    Card,
    { title: t('settings.clone'), hint: t('settings.cloneHint') },
    react.createElement(
      'div',
      {
        onDragOver: (event) => event.preventDefault(),
        onDrop: (event) => {
          event.preventDefault()
          load(event.dataTransfer?.files?.[0])
        },
        style: {
          padding: clip ? '8px' : '22px 14px',
          border: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.45))',
          borderRadius: '10px',
          textAlign: clip ? 'left' : 'center',
          cursor: 'pointer',
        },
        onClick: () => {
          const input = document.getElementById('moss-tts-clone-input')
          input?.click()
        },
      },
      clip
        ? react.createElement(
            'div',
            {
              style: { display: 'flex', flexDirection: 'column', gap: '8px' },
              // 点波形/滑块不该再弹文件选择框
              onClick: (event) => event.stopPropagation(),
            },
            react.createElement(Canvas, { canvasRef, onPointerDown, onPointerMove, onPointerUp }),
            react.createElement(
              'div',
              { style: ui.row },
              react.createElement(Field, { label: t('settings.cloneStart') }, react.createElement('input', {
                type: 'range',
                min: 0,
                max: clip.duration,
                step: 0.1,
                value: range.start,
                onChange: (event) => setRange(MossCloneAudio.dragWindow(clip.duration, range, 'start', Number(event.target.value))),
                style: { width: '180px' },
              })),
              react.createElement(Field, { label: t('settings.cloneEnd') }, react.createElement('input', {
                type: 'range',
                min: 0,
                max: clip.duration,
                step: 0.1,
                value: range.end,
                onChange: (event) => setRange(MossCloneAudio.dragWindow(clip.duration, range, 'end', Number(event.target.value))),
                style: { width: '180px' },
              })),
            ),
            react.createElement(
              'div',
              { style: ui.row },
              react.createElement('span', { style: ui.label }, `${MossCloneAudio.formatSeconds(range.start)} → ${MossCloneAudio.formatSeconds(range.end)}（${length.toFixed(1)} s）`),
              react.createElement(Btn, { onClick: previewing ? stopPreview : preview }, previewing ? t('settings.cloneStop') : t('settings.clonePreview')),
              react.createElement(Btn, { onClick: () => setRange(MossCloneAudio.defaultWindow(clip.duration)) }, t('settings.cloneWhole')),
            ),
          )
        : react.createElement('div', { style: ui.label }, t('settings.cloneDrop')),
      react.createElement('input', {
        id: 'moss-tts-clone-input',
        type: 'file',
        accept: 'audio/*',
        style: { display: 'none' },
        onChange: (event) => {
          load(event.target.files?.[0])
          event.target.value = ''
        },
      }),
    ),

    clip
      ? react.createElement(
          'div',
          { style: ui.row },
          react.createElement(Field, { label: t('settings.cloneName') }, react.createElement(TextInput, { value: name, onChange: setName, style: { width: '200px' } })),
          react.createElement(Btn, { primary: true, disabled: busy, onClick: create }, busy ? t('settings.cloneBusy') : t('settings.cloneCreate')),
          react.createElement('span', { style: ui.label }, `${clip.fileName} · ${clip.duration.toFixed(1)} s`),
        )
      : null,
    react.createElement(ErrorLine, null, error),
    notice ? react.createElement('div', { style: ui.label }, notice) : null,
  )
}

function Canvas(props) {
  const { canvasRef, onPointerDown, onPointerMove, onPointerUp } = props
  return react.createElement('canvas', {
    ref: canvasRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    style: {
      width: '100%',
      height: '72px',
      borderRadius: '8px',
      touchAction: 'none',
      cursor: 'ew-resize',
      display: 'block',
    },
  })
}
