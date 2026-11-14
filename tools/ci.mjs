// 一条命令跑完 CI：本地 `node tools/ci.mjs` 和 GitHub Actions 走同一条路。
//
// 为什么不是几个 run: 步骤——步骤失败时 GitHub 只给一句 "Process completed with
// exit code 1"，看不到是哪条断言。这里失败时额外写一行 `::error::`，它会被渲染成
// 注解，直接显示在运行页上（含关键几行输出）。
import { spawnSync } from 'node:child_process'

const steps = [
  ['client bundle 已生成', ['tools/build-client.mjs', '--check']],
  [
    '单元测试',
    [
      '--test',
      'tests/engine-install.test.mjs',
      'tests/routes.test.mjs',
      'tests/speech.test.mjs',
      'tests/http.test.mjs',
      'tests/wav.test.mjs',
      'tests/summary.test.mjs',
      'tests/service.test.mjs',
      'tests/clone-audio.test.mjs',
      'tests/tools.test.mjs',
      'tests/playback.test.mjs',
    ],
  ],
  ['客户端 bundle 可加载', ['--test', 'tests/client-load.test.mjs']],
  ['打包内容', ['tools/check-pack.mjs']],
]

let failed = 0
for (const [label, args] of steps) {
  console.log(`\n== ${label}`)
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' })
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
  process.stdout.write(out)
  if (run.status === 0) continue
  failed += 1
  const lines = out
    .split(/\r?\n/u)
    .filter((line) => /^(not ok|# fail)|AssertionError|\bError\b/u.test(line))
    .slice(0, 4)
  const detail = (lines.length ? lines : out.split(/\r?\n/u).filter(Boolean).slice(-3))
    .join(' | ')
    .replace(/[^\x20-\x7e]/gu, '?')
    .slice(0, 400)
  console.log(`::error title=${label}::${detail || `exit ${run.status}`}`)
}

if (failed) console.log(`\n${failed} 个步骤失败`)
process.exit(failed ? 1 : 0)
