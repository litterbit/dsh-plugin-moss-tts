// 插件加载生命周期：这两个坑都在真机上出过（设置页全 404、webServer 后到时路由一个不挂）。
//
// 用假 ctx 复刻 cordis 的语义：
//   - `inject(deps, cb)` 只在依赖出现后才回调（这里手动触发）；
//   - `effect(factory)` 的返回值必须是 disposer，返回普通对象会抛 Invalid effect。
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { apply, name } from '../lib/index.mjs'

const ROOT = path.resolve('runs', 'test-lifecycle')
const ROUTE_COUNT = 16

function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      assert.equal(typeof route.path, 'string')
      assert.equal(typeof route.handler, 'function')
      assert.ok(!routes.has(route.path), `重复注册 ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/** webServer 还没出现：inject 的 callback 先攒着，由测试手动触发。 */
function deferredCtx() {
  const tools = new Map()
  const effects = []
  const pending = []
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    effect: (factory, label) => effects.push({ factory, label }),
    get: () => undefined,
    inject: (deps, callback) => pending.push({ deps, callback }),
    logger: { info: () => {} },
  }
  return { ctx, tools, effects, pending }
}

test('apply 不返回对象（cordis 会当成 effect 并抛 Invalid effect）', () => {
  const { ctx } = deferredCtx()
  const result = apply(ctx, { root: ROOT, autoDownload: false })
  assert.equal(result, undefined)
})

test('webServer 后到时先挂工具，等它上线再挂全部路由', () => {
  const { ctx, tools, pending } = deferredCtx()
  apply(ctx, { root: ROOT, autoDownload: false })

  // 工具不依赖 webServer，必须立刻可用
  assert.equal(tools.size, 5)
  const inject = pending.find((item) => item.deps.includes('webServer'))
  assert.ok(inject, '应该用 ctx.inject 等 webServer')

  const webServer = fakeWebServer()
  const disposers = []
  const inner = {
    get: (key) => (key === 'webServer' ? webServer : undefined),
    effect: (factory) => {
      const dispose = factory()
      disposers.push(dispose)
      return dispose
    },
    logger: { info: () => {} },
  }
  inject.callback(inner)

  assert.equal(webServer.routes.size, ROUTE_COUNT)
  for (const route of webServer.routes.keys()) {
    assert.match(route, /^\/moss-tts\//u)
  }
  assert.ok(webServer.routes.has('/moss-tts/status'))
  assert.ok(webServer.routes.has('/moss-tts/events'))

  // 服务消失 / 插件卸载时路由要拆干净
  for (const dispose of disposers) dispose()
  assert.equal(webServer.routes.size, 0)
})

test('webServer 已就绪时 inject 立刻回调，不会漏挂', () => {
  const tools = new Map()
  const webServer = fakeWebServer()
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    effect: (factory) => factory(),
    get: (key) => (key === 'webServer' ? webServer : undefined),
    inject: (_deps, callback) => {
      callback(ctx)
    },
    logger: { info: () => {} },
  }
  apply(ctx, { root: ROOT, autoDownload: false })
  assert.equal(name, 'moss-tts')
  assert.equal(tools.size, 5)
  assert.equal(webServer.routes.size, ROUTE_COUNT)
})

test('路由注册中途失败时，已挂上的半套要拆掉', async () => {
  const { registerRoutes } = await import('../lib/host/routes.mjs')
  const registered = []
  let calls = 0
  const webServer = {
    register(route) {
      calls += 1
      if (calls === 3) throw new Error('webserver: duplicate exact route')
      registered.push(route.path)
      return () => registered.splice(registered.indexOf(route.path), 1)
    },
  }
  const service = { root: ROOT, log: () => {}, status: () => ({ state: 'missing' }) }
  assert.throws(() => registerRoutes(webServer, service, {}), /duplicate/u)
  assert.deepEqual(registered, [], '失败后不该留下半套路由')
})
