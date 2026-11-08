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

  // 路由：apply 跑起来时 webServer 不一定已经就绪（桌面端重载组合时插件会比
  // Web 服务早一拍，表现为界面全是 404），所以用 ctx.inject 等它就绪。
  // 服务消失时子 effect 自动注销路由，回来时再注册。
  ctx.inject(['webServer'], (ctx) => {
    const webServer = ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    ctx.effect(() => {
      try {
        return registerRoutes(webServer, service, { logger: log })
      } catch (error) {
        log(`[moss-tts] 路由注册失败：${error?.message ?? error}`)
        return () => {}
      }
    }, 'moss-tts.routes')
    log(`[moss-tts] routes ready under /moss-tts (root=${service.root})`)
  })

  registerTools(ctx, service, { logger: log })

  ctx.effect(
    () => async () => {
      await service.dispose()
      log('[moss-tts] disposed')
    },
    'moss-tts.engine',
  )

  log(`[moss-tts] ready voice=${service.prefs.get().voice} state=${service.status().state}`)
  // 注意：这里绝不能 return 任何对象。cordis 把 apply 的返回值当成 effect
  // （函数=disposer，thenable=等它），返回普通对象会抛 "Invalid effect"，
  // 整个 fiber 直接失败、刚注册的路由也被拆掉——表现为界面全 404。
}
