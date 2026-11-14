# dsh-plugin-moss-tts

[English](README.md) · 版本 **0.2.3** · Apache-2.0 · [引擎仓](https://github.com/litterbit/dsh-moss-tts)

给 DeepSeek Harness 用的**本地 TTS**插件：用 MOSS-TTS-Nano-100M 的 C++ CPU 引擎朗读助手回复。
全部在本机计算，文本不出机器；权重只装一份，和命令行、网页试听台共用。

![设置 → Moss 语音](assets/screenshot-settings.png)

```
Harness 助手回复 ──► 自动朗读 / 每条回复的朗读键
                        │
              POST /moss-tts/stream（同源，无 CORS）
                        │
       host 插件：引擎生命周期 + 下载校验 + 定速代理
                        │  stdin/stdout JSON
              moss_tts.exe --stdio（常驻，权重只加载一次）
                        │
        浏览器 AudioWorklet 环形缓冲 ──► 扬声器

agent 调 moss_tts_say ──► host 只写一行事件（GET /moss-tts/events，SSE）──► 浏览器
                            工具立刻返回，浏览器自己拉 /stream 边合成边播
```

## 需要什么

| 项 | 要求 |
|---|---|
| DeepSeek Harness | 0.2.1-rc 及以上（客户端 slot 契约） |
| 系统 | Windows x64（引擎目前只发布这一个平台） |
| 磁盘 | 约 170 MB（引擎 + 权重），装一次 |

## 安装

**桌面版**：侧栏「插件」→「添加插件」→ 粘贴

```
github:litterbit/dsh-plugin-moss-tts#main
```

> 桌面版的 profile 由应用独占管理，`dsh plugin` 命令行会明确拒绝（`profile ... is managed
> exclusively by the Electron application`），所以别用命令行装。

**命令行 profile**（非 Electron 托管）：

```bash
dsh plugin --profile <name> add github:litterbit/dsh-plugin-moss-tts#main
```

装完**重启 DSH**。插件会出现在设置里（「Moss 语音」），输入框左侧多一个喇叭开关，
每条助手回复的操作栏多一个朗读键，工具表里多 5 个 `moss_tts_*` 工具。

> 想先试本地目录：`dsh plugin --profile <name> add D:\path\to\dsh-plugin-moss-tts`
> （必须是绝对路径）。

## 第一次使用：装引擎

打开 **设置 → Moss 语音 → 下载引擎**。插件从
[引擎 Release](https://github.com/litterbit/dsh-moss-tts/releases) 拉
`MossTTS-win-x64-full.zip`（约 160 MB），用同一发布里的 `sha256sums.txt` 校验后解压到
`%LOCALAPPDATA%\MossTTS`。

- 已经用命令行或网页试听台装过？插件直接复用，不会重复下载。
- 下载可以断点续传；取消只删半包。
- **自动跟系统代理**：先看 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量，没有就读 Windows 的
  Internet 设置（`ProxyEnable` + `ProxyServer`，走 CONNECT 隧道）。所以"浏览器能打开 GitHub"
  的机器不需要额外配置；想强制直连，设 `NO_PROXY=*` 或把代理关掉。
- 连不上 GitHub 时，可以在 `cordis.patch.yml` 的 config 里换 `engineUrl` + `engineSha256`
  （例如镜像站），或用 `autoDownload: false` 完全手动管理。

## 怎么用

| 入口 | 说明 |
|---|---|
| 输入框左侧 🔊 | 自动朗读开关。开着时，每条回复定稿后按所选模式念；**只要在出声就变成 ⏹**，点一下立刻停 |
| 每条回复的 🔊 | 只念这一条。默认念全文，不受"自动朗读上限"影响 |
| 输入框上方播放条 | 有声时出现：暂停/继续、↻ 重播、⏹ 停止、进度与已播时间。播完或停掉自动消失 |
| 设置 → Moss 语音 | 引擎状态/线程/重启、默认音色、**试听台**（填文本逐个音色试）、**拖入音频克隆音色**、三种朗读模式、**音量**、诊断 |
| 工具 `moss_tts_say` | agent 主动朗读：浏览器在场时**只把文本丢给界面就返回**（几十毫秒），界面边合成边播，首块音频约 0.2~0.4 s 出声；`wait=true` 等播完；`save_to` 只落盘；克隆音色自动识别 |
| 工具 `moss_tts_voices` / `moss_tts_stop` / `moss_tts_clone` / `moss_tts_engine` | 音色列表（带中文名与默认标记）/ 停止（含界面播放）/ 克隆（>20 秒自动裁剪）/ 状态、安装、重启、卸载 |

朗读前会清洗 Markdown：代码块和表格不念，链接只念文字，标题与列表符号去掉，
按句末标点截断到「自动朗读上限」（默认 1500 字，0 = 不限）。

### 播放控制

工具、自动朗读、每条回复的朗读键都走**同一个播放器**，所以控制是统一的：

- **暂停/继续**：暂停时 AudioWorklet 停止消耗缓冲（不是关音量），后面没念完的音频留在
  环形缓冲里；暂停久了宿主那边读不动 socket，引擎会自己停下，不白烧 CPU。
- **重播**：浏览器留了这一段的原始 PCM（上限 5 分钟），↻ 立刻从头再放，不用重新合成；
  超过 5 分钟才退回重新合成。
- **停止**：中断下载、清空缓冲。`moss_tts_stop` 工具也会同时叫停界面上的播放。
- 新的一段开始时自动接管上一段（引擎是单 worker，本来也只能一句一句来）。

### 三种朗读模式

| 模式 | 念什么 | 代价 |
|---|---|---|
| **智能摘要**（默认） | 用 DSH 子代理把这一轮结果压成一句 ≤60 字的话；提问只取前 200 字、回答只取前 600 字 | 每次约几 k token（子代理的系统提示）；回复短于 80 字直接念，不调模型 |
| **读全文** | 清洗后整段念（v0.1 的行为） | 只花本机算力 |
| **固定语句** | 只念一句可自定义的话，例如「任务已经完成，请查收。」 | 几乎没有代价 |

摘要失败（没装子代理服务、父会话不在线、超时、报错）会**自动退回本地抽取式摘要**（取第一句，
0 token），再退回固定语句——所以开了就一定会有声音。子代理在会话里显示为 `moss-tts-summary`。

### 克隆音色（不用命令行）

设置页的「克隆音色」是一个拖放区：把 WAV/MP3/M4A 拖进去，浏览器用
`OfflineAudioContext` 解码成 48 kHz，画出波形，拖动起点/终点选 1~20 秒，可以试听选段，
起个名字就能创建。文件**不会上传**，只有裁剪后的 PCM WAV 会交给本机引擎。

### 引擎生命周期与内存

- 插件**默认不预热**：DSH 启动时只加载宿主模块与设置页脚本（几十 KB），不 spawn 引擎。
- 第一次合成/读音色/克隆时才启动 `moss_tts.exe`（加载权重约 1~2 秒，常驻约 250 MB）。
- 空闲 **10 分钟**会自动卸载引擎进程，把内存还回去；下次合成自动拉起。
  `preload: true` 可以改成启动即预热，`idleUnloadMinutes: 0` 可以永不卸载。
- 想**彻底不加载**插件：侧栏「插件」页把 `dsh-plugin-moss-tts` 关掉（写入 profile 的
  `cordis.patch.yml`，`disabled: true`），重启 DSH 后连设置页都不会出现。

### 线程数

设置页「性能」里可以改 LLM / 解码器两个线程池（0 = 自动，默认 2+3），点「保存并重启引擎」生效。
线程数只影响速度与发热，**不影响音频内容**；写入的是引擎自己的
`%LOCALAPPDATA%\MossTTS\userdata\settings.json`，所以命令行和网页试听台看到的是同一个值。


## 隐私

- 合成完全在本机：不联网、不上传文本、不收集使用数据。
- 唯一的出网行为是**你点下载时**从 GitHub 拉引擎包，以及可选的版本检查；关掉自动下载就没有。
- 用户音色（`moss_clone`）写在本机 `%LOCALAPPDATA%\MossTTS\userdata\voices\user\`。

## 和命令行 / 网页试听台的关系

三者跑同一个 `moss_tts.exe`、同一份权重、同一个数据目录：

- 命令行：`moss_tts.exe --text "你好" --out hello.wav`
- 网页试听台：双击 `moss_tts.exe`（无参数）打开 `http://127.0.0.1:8759/`
- 本插件：不需要端口，插件自己 spawn 常驻子进程走 `--stdio`

引擎和插件各自独立升级：插件在 `engine.json` 里钉一个发布版本，找不到时回退到最新发布，
并始终按发布页的 `sha256sums.txt` 校验。

## 卸载

桌面版在**侧栏「插件」**里卸载；命令行 profile（非 Electron 托管）也可以用
`dsh plugin --profile <name> remove dsh-plugin-moss-tts`。

插件不会删权重（命令行 / 网页试听台还在用）。要彻底清掉：删掉 `%LOCALAPPDATA%\MossTTS`。

## 常见问题

| 现象 | 处理 |
|---|---|
| 设置页一直「未安装」 | 点「重新检测」；确认 `%LOCALAPPDATA%\MossTTS\moss_tts.exe` 与 `models\` 都在 |
| 下载失败 / 校验不通过 | 多半是代理改写了内容。重试一次；仍然失败就在 config 里给 `engineUrl` + `engineSha256` 换源 |
| 朗读没有声音但设置页显示就绪 | 浏览器标签页被静音或系统输出设备不对；点一下页面任意处让浏览器允许自动播放 |
| 长回复只念了一部分 | 默认上限 1500 字，改设置里的「自动朗读上限」或点那条回复上的朗读键 |
| 一直占着 250 MB 内存 | 引擎是常驻子进程；空闲 10 分钟会自动卸载，也可以点「停止（释放内存）」，或把 `idleUnloadMinutes` 设小 |
| 智能摘要没生效 | 看诊断 JSON 或 `plugin.log` 里的 `[summary]`；没挂 subagent 服务时会是 `extract`（本地第一句） |
| 声音比别的应用响 | 设置页「音量」滑到 50%~70%（默认 60%）；网页播放与本机工具播放都生效 |
| 工具调用一直不返回 | 0.2.1 修了中断后引擎 stdout 卡死；升级后重启 DSH 即可 |
| 线程数改了没变 | 必须点「保存并重启引擎」；`settings.json` 里残留的旧值会先被读回设置页 |
| 提示引擎版本过旧 | 删掉 `%LOCALAPPDATA%\MossTTS\models` 后重新点下载，升级权重 |
| 插件没出现 | 安装后必须重启 DSH；`dsh --profile desktop --dump-config` 里应能看到一行 `id: moss-tts` |

## 开发

```bash
node tools/build-client.mjs          # 生成 lib/client.js（产物进仓库，安装时不构建）
node tools/build-client.mjs --check  # CI 用它拦"忘了重新生成"
node tools/ci.mjs                    # 本地和 GitHub Actions 走同一条门禁
node --test tests/*.test.mjs         # 不需要 DSH；真引擎的两个用例没有引擎会自动跳过
```

宿主契约（本机 DSH 0.2.1-rc.2 实测）：`dsh.bundle.patch` 一行 `insert` 挂 host 半边，
`dsh.client.platform = "web"` + `exports["./client"]` 挂浏览器半边；host 用
`ctx.get('webServer').register` 开路由，client 用 `ctx.slots.inject` 注册 slot。
没有从宿主包里 import 任何东西——工具定义是标准 JSON Schema 的普通对象。

## 许可与来源

Apache-2.0。模型权重来自 MOSS-TTS-Nano-100M（Apache-2.0），由引擎仓转换为自有容器格式；
本插件**不包含**任何权重或二进制，只在运行时下载。详见 [NOTICE](NOTICE.md)。
