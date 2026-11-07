// 安装器：校验根、续传入口、失败路径。全部用假的 download/text/hash/extract，
// 不联外网 —— 真正的下载由 e2e 手工验（MOSS_TTS_E2E=1）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createInstaller, detectInstalled, parseSums, readManifest } from '../lib/host/install.mjs'

const RUNS = path.resolve('runs', 'test-install')
const SHA = 'a'.repeat(64)
const ASSET = 'MossTTS-win-x64-full.zip'

function freshRoot(name) {
  const root = path.join(RUNS, name)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  return root
}

function layoutOf(root) {
  return {
    root,
    exe: path.join(root, 'moss_tts.exe'),
    models: path.join(root, 'models'),
    data: path.join(root, 'userdata'),
    downloads: path.join(root, '.download'),
  }
}

function fakeDeps(state) {
  return {
    text: async (url) => {
      state.texts.push(url)
      return `${SHA}  ${ASSET}\n`
    },
    download: async (url, file, { onProgress }) => {
      state.downloads.push(url)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'fake-zip-bytes')
      onProgress?.(14, 14)
      return { bytes: 14, total: 14, resumed: false }
    },
    hashFile: async () => state.hash,
    extractArchive: async (zip, dest) => {
      state.extracts += 1
      fs.mkdirSync(dest, { recursive: true })
      fs.writeFileSync(path.join(dest, 'moss_tts.exe'), 'x')
      fs.mkdirSync(path.join(dest, 'models'), { recursive: true })
    },
    resolveTag: async () => 'v9.9.9',
  }
}

test('parseSums 只认命中的资产，格式宽松', () => {
  const text = [
    '# comment',
    '',
    `${'b'.repeat(64)}  other.zip`,
    `${SHA}  *${ASSET}`,
    `${'c'.repeat(64)}  ${ASSET}`,
  ].join('\n')
  assert.equal(parseSums(text, ASSET), SHA)
  assert.equal(parseSums(text, 'missing.zip'), undefined)
})

test('engine.json 有 repo/release/asset', () => {
  const manifest = readManifest()
  assert.equal(manifest.repo, 'litterbit/dsh-moss-tts')
  assert.match(manifest.release, /^v\d/u)
  assert.equal(manifest.asset, ASSET)
})

test('detectInstalled 认 exe + models，不认半个安装', () => {
  const root = freshRoot('detect')
  const layout = layoutOf(root)
  assert.equal(detectInstalled(layout), undefined)
  fs.writeFileSync(layout.exe, 'x')
  assert.equal(detectInstalled(layout), undefined)
  fs.mkdirSync(layout.models)
  assert.deepEqual(detectInstalled(layout), { exe: layout.exe, models: layout.models })
  const custom = path.join(root, 'custom.exe')
  fs.writeFileSync(custom, 'x')
  assert.deepEqual(detectInstalled(layout, { exe: custom }), {
    exe: custom,
    models: path.join(root, 'models'),
  })
})

test('安装成功：用发布页的 sums 校验，解压后能定位', async () => {
  const root = freshRoot('ok')
  const layout = layoutOf(root)
  const state = { texts: [], downloads: [], extracts: 0, hash: SHA }
  const installer = createInstaller({
    layout,
    config: { engineRelease: 'v1.2.3' },
    manifest: { repo: 'litterbit/dsh-moss-tts', release: 'v0.1.0', asset: ASSET, sums: 'sha256sums.txt' },
    ...fakeDeps(state),
  })
  const found = await installer.ensure()
  assert.equal(found.exe, layout.exe)
  assert.equal(state.extracts, 1)
  assert.match(state.downloads[0], /releases\/download\/v1\.2\.3\/MossTTS-win-x64-full\.zip/u)
  assert.equal(installer.state().phase, 'ready')
  assert.equal(fs.existsSync(layout.downloads), false, '下载目录要清掉')
})

test('哈希不符：重下一次仍不符就报错', async () => {
  const root = freshRoot('bad-hash')
  const layout = layoutOf(root)
  const state = { texts: [], downloads: [], extracts: 0, hash: 'f'.repeat(64) }
  const installer = createInstaller({
    layout,
    config: {},
    manifest: { repo: 'r/r', release: 'v0.1.0', asset: ASSET, sums: 'sha256sums.txt' },
    ...fakeDeps(state),
  })
  await assert.rejects(installer.ensure(), /校验不通过/u)
  assert.equal(state.downloads.length, 2)
  assert.equal(state.extracts, 0)
  assert.equal(installer.state().phase, 'error')
})

test('引擎已在位：一个字节都不下', async () => {
  const root = freshRoot('already')
  const layout = layoutOf(root)
  fs.writeFileSync(layout.exe, 'x')
  fs.mkdirSync(layout.models)
  const state = { texts: [], downloads: [], extracts: 0, hash: SHA }
  const installer = createInstaller({
    layout,
    config: {},
    manifest: { repo: 'r/r', release: 'v0.1.0', asset: ASSET, sums: 'sha256sums.txt' },
    ...fakeDeps(state),
  })
  const found = await installer.ensure()
  assert.equal(found.exe, layout.exe)
  assert.equal(state.downloads.length, 0)
})

test('autoDownload:false 时给可操作提示，不偷偷下载', async () => {
  const root = freshRoot('no-auto')
  const layout = layoutOf(root)
  const state = { texts: [], downloads: [], extracts: 0, hash: SHA }
  const installer = createInstaller({
    layout,
    config: { autoDownload: false },
    manifest: { repo: 'r/r', release: 'v0.1.0', asset: ASSET, sums: 'sha256sums.txt' },
    ...fakeDeps(state),
  })
  await assert.rejects(installer.ensure(), /设置 → Moss 语音/u)
  assert.equal(state.downloads.length, 0)
})

test('release 404 时回退到 latest 并重新取 sums', async () => {
  const root = freshRoot('fallback')
  const layout = layoutOf(root)
  const state = { texts: [], downloads: [], extracts: 0, hash: SHA }
  let first = true
  const installer = createInstaller({
    layout,
    config: {},
    manifest: { repo: 'r/r', release: 'v0.1.1', asset: ASSET, sums: 'sha256sums.txt' },
    ...fakeDeps(state),
    text: async (url) => {
      if (first) {
        first = false
        throw new Error('HTTP 404')
      }
      state.texts.push(url)
      return `${SHA}  ${ASSET}\n`
    },
  })
  await installer.ensure()
  assert.match(state.downloads[0], /releases\/download\/v9\.9\.9/u)
})
