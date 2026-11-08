# Changelog

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
