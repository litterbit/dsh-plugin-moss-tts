# Changelog

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
