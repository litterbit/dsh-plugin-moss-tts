// 打包内容自检：git 安装不跑构建，所以 lib/ 必须完整、client.js 必须已生成。
// 不调 npm（runner 上没必要），只按 package.json 的 files 逐项核对。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

for (const entry of pkg.files ?? []) {
  const target = path.join(ROOT, entry)
  assert.ok(fs.existsSync(target), `files 里的 ${entry} 不存在`)
}

const client = path.join(ROOT, 'lib', 'client.js')
assert.ok(fs.readFileSync(client, 'utf8').includes('__ModuleLoader__'), 'lib/client.js 不是客户端 bundle')

assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须指向 cordis.patch.yml')
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform 必须是 web')
assert.ok(pkg.exports?.['./client'], 'exports["./client"] 缺失，宿主找不到浏览器半边')
assert.ok(fs.existsSync(path.join(ROOT, 'cordis.patch.yml')), 'cordis.patch.yml 缺失')
assert.ok(fs.existsSync(path.join(ROOT, 'engine.json')), 'engine.json 缺失')

for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  assert.ok(/[~^]|>=\d/u.test(String(range)), `peerDependency ${name} 需要明确的版本范围`)
}

console.log(`[ok] ${pkg.name}@${pkg.version} 打包内容完整（${(pkg.files ?? []).length} 项）`)
