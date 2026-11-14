# Changelog

## 0.2.2 — 2026-11-14

- **`moss_tts_engine` 报 "invalid output: value is not lossless JSON"**：`status()` 里天然有
  `undefined`（没启动时的版本/线程/上次作业），宿主校验直接判失败。现在所有工具输出统一过
  一遍 `jsonSafe`：剔掉 `undefined`、把非有限数变 `null`。
- **`moss_tts_say` 不再卡住 agent**：合成完**启动播放就返回**（`background: true`），
  agent 可以在语音播报的同时继续做事；需要等播完再传 `wait: true`。
  同一时刻只保留一个播放器，新的一句会掐掉上一句；`moss_tts_stop` 会同时停合成与播放，
  插件卸载时也会收掉播放器进程。
- 合成本身仍然串行（引擎是单 worker），但工具调用不再被音频时长占住，多个调用可以并行发起。

## 0.2.1 — 2026-11-14

0.2.0 在真机上暴露的三个问题：

- **工具调用卡死且停不下来**：播放流把 `stdout` pause 之后，客户端中断/播完后没有 resume，
  引擎的管道写满就卡在 write 上、连 stdin 都不读，之后 `voices`/`speak` 自然永远没回复。
  现在 `drain` / `finish` / `close` / `finally` 四处都会放行，请求超时也会主动 `resume`；
  `moss_tts_voices` 加了 20 秒上限，不会再无限期挂着。
- **智能摘要根本没走子代理**：`maxDepth: 0` 被服务端判成 `depth 1 exceeds maxDepth 0`，
  每次都退回抽取式。改成 `1`（只允许直接子代理），现在真的会起 `moss-tts-summary`。
- **音量控制**：MOSS 的响度比一般应用高。设置页新增「音量」滑块（0~100%，默认 60%）：
  网页播放按块乘增益（拖动滑块立即生效），工具播放的 WAV 在落盘时按同一比例缩放。

## 0.2.0 — 2026-11-14

把引擎网页试听台的能力搬进设置页，并把「朗读」拆成三种模式。

- **设置页重做**：引擎状态（版本/后端/实际线程/物理核）、检查、重启、停止（释放内存）、
  打开安装目录；默认音色；**试听台**（填文本、音色网格、逐个试听、显示音频/计算/首音/RTF、下载 WAV）；
  **拖放克隆**（浏览器解码 MP3/AAC → 波形上拖选 1~20 秒 → 试听选段 → 创建）；
  性能（LLM/解码线程，保存并重启）；诊断 JSON。
- **三种朗读模式**：智能摘要（DSH 子代理，只喂 200 字提问 + 600 字回答，失败自动退抽取式）、
  读全文、固定语句；设置页可切，输入框开关的 tooltip 显示当前模式。
- **引擎生命周期**：默认不预热；空闲 10 分钟自动卸载（`idleUnloadMinutes`，0 = 从不）；
  `preload` 可改启动预热。README 写清了"彻底不加载"的开关路径（插件页停用）。
- **线程数**：以插件设置为准，写入引擎的 `<data>/settings.json`，与命令行/网页试听台一致；
  重启引擎生效。
- **并发**：引擎是单 worker，现在宿主侧排成一条队，两次 `moss_tts_say`（或自动朗读）不再互相取消；
  「停止」只停当前一句。
- **工具**：`moss_tts_say` 自动识别用户克隆音色、返回首音耗时；`moss_tts_clone` 对 >20 秒的
  PCM WAV 自动截断、对 MP3-in-WAV 报真实编码；`moss_tts_engine` 支持 restart / stop。
- **长文本**：`maxChars=0` 时按 4000 字截断而不是整条 413。
- **测试**：新增 WAV 解析/裁剪、摘要器（含缓存与回退）、克隆纯逻辑、设置页整树展开、
  路由（last / clone / engine / summary）；CI 仍是 `node tools/ci.mjs`。

## 0.1.1 — 2026-11-08

装上就发现的三处硬伤，都是"只在真实宿主/真实网络里才会暴露"的那种：

- **`apply` 返回了服务对象** → cordis 把返回值当成 effect，抛 `Invalid effect`，整个 fiber 失败、
  刚注册的路由被拆掉，界面所有请求 404（设置页能看到，但点"下载引擎"只得到 `HTTP 404`）。
  现在 `apply` 不返回值。
- **`webServer` 竞态**：桌面端重载组合时插件可能比 Web 服务早一拍，改为 `ctx.inject(['webServer'])`，
  服务晚到会自动补注册、服务消失自动注销。
- **HTTP 客户端两处 bug**：`transport()` 对 `URL` 对象调 `startsWith`（每个请求都直接抛），
  以及**不认系统代理**——Node 不读 Windows 的 Internet 设置，于是浏览器能打开 GitHub、插件却
  `ECONNRESET`。现在按 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量 → 注册表 `ProxyServer`（看 `ProxyEnable`）
  的顺序取代理，用 CONNECT 隧道；直连不通的机器（本机就是）实测 166 MB 全量包 23 秒下完。
- 顺手：`engineVersion()` 在发布包里读不到版本（`models/manifest.json` 只有 `min_engine_version`），
  改为回落 `--version` 并按 exe 大小/时间缓存；"打开安装目录"先建目录再 `explorer`。

## 0.1.0 — 2026-11-08

首次发布。

- **host 半边**：定位 / 下载 / 校验 / 解压引擎（`%LOCALAPPDATA%\MossTTS`，与命令行、网页试听台共用一份），
  常驻 `moss_tts.exe --stdio`，单 worker 串行、新请求打断旧请求、stdout 背压。
- **HTTP 面**（同源，`/moss-tts/*`）：`status` `install` `install/cancel` `voices` `stream` `wav` `prefs` `engine/reveal`。
  `POST` 强制 `application/json`，`Origin` 必须同源，挡掉跨站请求。
- **浏览器半边**：设置页（引擎状态/下载进度/音色/试听/自动朗读上限）、输入框喇叭开关、
  每条回复的朗读键；`AudioWorklet` 环形缓冲 + 2.5 s 信用窗口，首块音频约 100 ms 起声，播放中不丢样。
- **自动朗读**：回复定稿后按 250 ms 去抖朗读；进入会话时以当前最大 seq 为基线，历史记录不会被念。
- **文本清洗**：代码块 / 表格不念，链接只念文字，标题与列表符号去掉，按句末截断（默认 1500 字）。
- **工具**：`moss_tts_say` `moss_tts_voices` `moss_tts_stop` `moss_tts_clone` `moss_tts_engine`。
- **测试**：安装器 / 路由安全 / 文本清洗 / 偏好 / 工具注册 / 客户端加载冒烟；另有真引擎的协议与
  主机端到端用例（没有引擎时自动跳过）。
