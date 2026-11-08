// 代理识别：Node 不读 Windows 的 Internet 设置，插件自己接一层。
// 这里只验"读环境变量"这条最容易在 CI 里测的分支。
process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'

import assert from 'node:assert/strict'
import test from 'node:test'

const { systemProxy } = await import('../lib/host/http.mjs')

test('HTTPS_PROXY 被识别成 host:port', () => {
  assert.deepEqual(systemProxy(), { host: '127.0.0.1', port: 7890 })
})
