// 词典：zh 是主语言，en 覆盖同一批 key（官方 settings-plugins 的做法）。
const NS = 'moss-tts'

const ZH = {
  'settings.nav': 'Moss 语音',
  'settings.title': 'Moss 语音（本地 TTS）',
  'settings.intro': '文本在本机合成，不联网、不上传。权重只装一份，和命令行 / 网页试听台共用。',
  'settings.engine': '引擎',
  'settings.state.missing': '未安装',
  'settings.state.installing': '正在安装',
  'settings.state.ready': '就绪',
  'settings.state.error': '出错',
  'settings.download': '下载引擎（约 160 MB）',
  'settings.cancel': '取消下载',
  'settings.reveal': '打开安装目录',
  'settings.recheck': '重新检测',
  'settings.installing': '已下载 {done} / {total}',
  'settings.phase.verify': '校验中…',
  'settings.phase.extract': '解压中…',
  'settings.voice': '音色',
  'settings.voiceHint': '装好引擎后可选；试听会走整段合成。',
  'settings.test': '试听',
  'settings.testing': '合成中…',
  'settings.autoRead': '自动朗读回复',
  'settings.autoReadHint': '回复定稿后自动念出来；关闭后仍可用每条回复上的朗读键。',
  'settings.maxChars': '自动朗读上限（字，0=不限）',
  'settings.skipCode': '跳过代码块与表格',
  'settings.openSettings': '打开设置',
  'settings.enginePath': '安装位置',
  'settings.diag': '诊断',
  'settings.diagCopy': '复制状态 JSON',
  'settings.copied': '已复制',
  'composer.autoReadOn': '自动朗读已开',
  'composer.autoReadOff': '自动朗读已关',
  'composer.stop': '停止朗读',
  'composer.notReady': 'Moss 语音：引擎未就绪，点此打开设置',
  'action.read': '朗读这条回复',
  'action.stop': '停止朗读',
  'action.empty': '这条回复没有可朗读的文字',
  'error.generic': '出错了：{message}',
}

const EN = {
  'settings.nav': 'Moss Speech',
  'settings.title': 'Moss Speech (local TTS)',
  'settings.intro': 'Synthesized on this machine. No network, no upload. One copy of the weights, shared with the CLI and the web playground.',
  'settings.engine': 'Engine',
  'settings.state.missing': 'not installed',
  'settings.state.installing': 'installing',
  'settings.state.ready': 'ready',
  'settings.state.error': 'error',
  'settings.download': 'Download engine (~160 MB)',
  'settings.cancel': 'Cancel download',
  'settings.reveal': 'Open install folder',
  'settings.recheck': 'Re-check',
  'settings.installing': 'Downloaded {done} / {total}',
  'settings.phase.verify': 'verifying…',
  'settings.phase.extract': 'extracting…',
  'settings.voice': 'Voice',
  'settings.voiceHint': 'Available once the engine is installed. Preview synthesizes the whole clip.',
  'settings.test': 'Preview',
  'settings.testing': 'Synthesizing…',
  'settings.autoRead': 'Read replies aloud',
  'settings.autoReadHint': 'Speak each reply when it settles. Off still leaves the per-message button usable.',
  'settings.maxChars': 'Auto-read limit (characters, 0 = no limit)',
  'settings.skipCode': 'Skip code blocks and tables',
  'settings.openSettings': 'Open settings',
  'settings.enginePath': 'Install location',
  'settings.diag': 'Diagnostics',
  'settings.diagCopy': 'Copy status JSON',
  'settings.copied': 'Copied',
  'composer.autoReadOn': 'Auto-read is on',
  'composer.autoReadOff': 'Auto-read is off',
  'composer.stop': 'Stop speaking',
  'composer.notReady': 'Moss Speech: engine not ready, click to open settings',
  'action.read': 'Read this reply aloud',
  'action.stop': 'Stop speaking',
  'action.empty': 'Nothing speakable in this reply',
  'error.generic': 'Failed: {message}',
}

function format(template, params) {
  if (!params) return template
  return String(template).replace(/\{(\w+)\}/gu, (match, key) => (params[key] === undefined ? match : String(params[key])))
}

function makeT(locale) {
  const bind = locale && typeof locale.bind === 'function' ? locale.bind(NS) : undefined
  return (key, params) => {
    if (bind) {
      try {
        return bind(key, params)
      } catch {
        // 词典还没注册时退回英文
      }
    }
    return format(EN[key] ?? key, params)
  }
}
