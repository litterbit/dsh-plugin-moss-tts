// DSH 宿主插件入口。
//
// 加载方式（profile 的 cordis.patch.yml，通常由包内 bundle 自动插入）：
//   - insert:
//       - id: moss-tts
//         name: dsh-plugin-moss-tts
//         config:
//           voice: Junhao          # 可选，默认值见 prefs
//           threads: 0             # 0 = 引擎自己按物理核数决定
//
// 设计：host 只负责"引擎 + 路由 + 工具"，界面在 lib/client.js（浏览器半边）。
// 权重不随包分发，首次使用时从引擎的 GitHub Release 下载并校验。
import fs from 'node:fs'
import path from 'node:path'

import { pluginLayout, productDir } from './host/paths.mjs'
import { registerRoutes } from './host/routes.mjs'
import { TtsService } from './host/service.mjs'
import { registerTools } from './host/tools.mjs'

export const name = 'moss-tts'
export const inject = ['tools']

function createLogger(ctx, config) {
  const file = pluginLayout(productDir(config)).log
  const hostLog = ctx?.logger
  return (line) => {
    const text = String(line)
    try {
      hostLog?.info?.(text)
    } catch {
      // 宿主没提供 logger
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`)
    } catch {
      // 日志写不进去不该影响合成
    }
  }
}

export function apply(ctx, config = {}) {
  const log = createLogger(ctx, config)
  const service = new TtsService({ config, logger: log })

  let disposeRoutes
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer && typeof webServer.register === 'function') {
    disposeRoutes = registerRoutes(webServer, service, { logger: log })
    log(`[moss-tts] routes ready under /moss-tts (root=${service.root})`)
  } else {
    log('[moss-tts] 没有 webServer 服务：界面不可用，工具仍可调用')
  }

  registerTools(ctx, service, { logger: log })

  ctx.effect(
    () => async () => {
      try {
        disposeRoutes?.()
      } catch {
        // 宿主可能已经拆了路由表
      }
      await service.dispose()
      log('[moss-tts] disposed')
    },
    'moss-tts.engine',
  )

  log(`[moss-tts] ready voice=${service.prefs.get().voice} state=${service.status().state}`)
  return service
}
