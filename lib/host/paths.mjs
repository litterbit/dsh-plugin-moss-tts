// 插件用到的路径。唯一来源：产品目录（默认 %LOCALAPPDATA%\MossTTS）。
//
// 与门户页 / CLI 共用同一份安装：exe 与 models/ 都在产品目录根部（引擎的
// 便携模式据此把 userdata/ 放在旁边），所以插件不需要也不允许复制权重。
import os from 'node:os'
import path from 'node:path'

/** 产品目录：引擎安装 + 用户数据 + 插件设置都在它下面。 */
export function productDir(config = {}, env = process.env) {
  if (config.root) return path.resolve(String(config.root))
  const base = env.LOCALAPPDATA ?? env.APPDATA ?? os.homedir()
  return path.join(base, 'MossTTS')
}

/** 引擎默认安装位置（= 产品目录根部的便携布局）。 */
export function engineLayout(root) {
  return {
    root,
    exe: path.join(root, 'moss_tts.exe'),
    models: path.join(root, 'models'),
    data: path.join(root, 'userdata'),
    downloads: path.join(root, '.download'),
  }
}

/** 插件自己的状态目录（设置、日志），与引擎文件隔离。 */
export function pluginLayout(root) {
  const dir = path.join(root, 'plugin')
  return { dir, prefs: path.join(dir, 'prefs.json'), log: path.join(dir, 'plugin.log') }
}

/** tar.exe：Windows 10 1803+ 自带 bsdtar，可以直接解 zip。 */
export function tarExe(env = process.env) {
  const system = env.SystemRoot ?? env.windir
  if (system) return path.join(system, 'System32', 'tar.exe')
  return 'tar'
}
