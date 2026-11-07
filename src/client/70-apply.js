// 浏览器半边入口：注册词典与三个 slot。
//
// 用 ctx.slots.inject(name, () => register(...)) 延迟注册，所以不依赖
// dsh.client.inject 的加载顺序 —— 宿主后来才声明的 slot 也能挂上。
const inject = ['slots', 'locale']

function apply(ctx) {
  const t = makeT(ctx.locale)
  if (ctx.locale && typeof ctx.locale.register === 'function') {
    ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'moss-tts: dictionaries')
  }
  // 提前拉一次偏好：输入框开关第一帧就是正确状态，不会闪一下。
  prefsStore.load()

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'moss-tts',
        order: 40,
        label: () => t('settings.nav'),
        locale: NS,
      },
      SettingsSection,
    ),
  )

  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'moss-tts',
        order: 40,
        locale: NS,
      },
      ComposerToggle,
    ),
  )

  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.assistant-actions',
        id: 'moss-tts-read',
        order: 20,
        locale: NS,
      },
      ReadAction,
    ),
  )

  // 测试钩子：只在 window.__MOSS_TTS_TEST__ 存在时挂内部对象（生产环境无副作用）。
  // tests/playback.test.mjs 靠它把真播放器接到假 AudioContext 上跑逐样点回归。
  if (typeof window !== 'undefined' && window.__MOSS_TTS_TEST__) {
    Object.assign(window.__MOSS_TTS_TEST__, { player, prefsStore, statusStore, speakText, WORKLET_SOURCE })
  }
}
