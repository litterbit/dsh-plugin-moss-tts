// DSH 宿主插件入口。
//
// 加载方式（profile 的 cordis.patch.yml，通常由包内 bundle 自动插入）：
//   - insert:
//       - id: moss-tts
//         name: dsh-plugin-moss-tts
//
// 设计：host 只负责"引擎 + 路由 + 工具"，界面在 lib/client.js（浏览器半边）。
// 权重不随包分发，首次使用时从引擎的 GitHub Release 下载并校验。
//
// 内存：apply 本身不起引擎进程，只有真正合成/读音色/克隆时才 spawn；
// 空闲若干分钟（prefs.idleUnloadMinutes）会自动卸载，preload=true 才在启动时预热。
import fs from 'node:fs'
import path from 'node:path'

import { pluginLayout, productDir } from './host/paths.mjs'
import { registerRoutes } from './host/routes.mjs'
import { TtsService } from './host/service.mjs'
import { createAnnouncer } from './host/summary.mjs'
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
  const announcer = createAnnouncer({ logger: log })

  // 智能摘要要起子代理：这两个服务不一定挂（headless / 精简 profile），
  // 拿不到就退化成抽取式摘要，所以用 ctx.inject 而不是硬依赖。
  ctx.inject(['agents', 'subagents'], (inner) => {
    announcer.bind(inner.get('agents'), inner.get('subagents'))
    log('[moss-tts] 智能摘要已接入子代理')
  })

  // 路由：apply 跑起来时 webServer 不一定已经就绪（桌面端重载组合时插件会比
  // Web 服务早一拍，表现为界面全是 404），所以用 ctx.inject 等它就绪。
  // 服务消失时子 effect 自动注销路由，回来时再注册。
  ctx.inject(['webServer'], (ctx) => {
    const webServer = ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    ctx.effect(() => {
      try {
        return registerRoutes(webServer, service, { logger: log, announcer })
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

  // 可选预热：只有用户明确打开 preload 才在启动后拉起引擎（默认不占内存）。
  if (service.prefs.get().preload) {
    const timer = setTimeout(() => {
      service.ensureEngine().catch((error) => log(`[moss-tts] 预热失败：${error?.message ?? error}`))
    }, 1500)
    timer.unref?.()
  }

  log(`[moss-tts] ready voice=${service.prefs.get().voice || '(引擎默认)'} state=${service.status().state}`)
  // 注意：这里绝不能 return 任何对象。cordis 把 apply 的返回值当成 effect
  // （函数=disposer，thenable=等它），返回普通对象会抛 "Invalid effect"，
  // 整个 fiber 直接失败、刚注册的路由也被拆掉——表现为界面全 404。
}
