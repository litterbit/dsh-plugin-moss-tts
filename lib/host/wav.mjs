// WAV 的最小解析与裁剪。
//
// 引擎只吃 PCM WAV（MP3/AAC 由浏览器那半边解码），所以宿主这边只需要两件事：
//   1. 在克隆前看清真实格式 —— 压缩格式要报真实编码，别掉进"块对齐"的坑；
//   2. 把超过 20 秒的参考音频截前 20 秒 —— 引擎对这点的报错很直白，但工具调用方
//      更希望"给长文件也能用"，而不是先自己拿工具剪一遍。
const TAG_PCM = 0x0001
const TAG_FLOAT = 0x0003
const TAG_EXTENSIBLE = 0xfffe

const CODEC_NAMES = new Map([
  [0x0001, 'PCM'],
  [0x0003, 'IEEE float'],
  [0x0006, 'A-law'],
  [0x0007, 'μ-law'],
  [0x0011, 'IMA ADPCM'],
  [0x0050, 'MPEG'],
  [0x0055, 'MP3'],
  [0x00ff, 'AAC'],
  [0x1610, 'AAC'],
  [0x2000, 'AC-3'],
])

function hex(value) {
  return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`
}

function fail(message) {
  const error = new Error(message)
  error.code = 'bad_wav'
  return error
}

function ascii(buffer, offset, length) {
  return buffer.toString('latin1', offset, offset + length)
}

/**
 * 解析一段 WAV。
 * @returns {{pcm: boolean, tag: number, codec: string, channels: number, rate: number, bits: number, blockAlign: number, dataOffset: number, dataLength: number, frames: number, seconds: number}}
 * @throws {Error} 不是 WAV / 压缩编码 / 位深不合法
 */
export function inspectWav(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (buf.length < 44 || ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 4) !== 'WAVE') {
    throw fail('不是 WAV 文件（缺少 RIFF/WAVE 头）')
  }
  let offset = 12
  let fmt
  let dataOffset = -1
  let dataLength = 0
  while (offset + 8 <= buf.length) {
    const id = ascii(buf, offset, 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        tag: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        blockAlign: buf.readUInt16LE(body + 12),
        bits: buf.readUInt16LE(body + 14),
      }
      // WAVE_FORMAT_EXTENSIBLE：真正的编码在前 2 字节
      if (fmt.tag === TAG_EXTENSIBLE && size >= 40 && body + 26 <= buf.length) {
        fmt.tag = buf.readUInt16LE(body + 24)
      }
    } else if (id === 'data') {
      dataOffset = body
      dataLength = Math.min(size, buf.length - body)
      break
    }
    offset = body + size + (size % 2)
  }
  if (!fmt) throw fail('WAV 里没有 fmt 块')
  if (dataOffset < 0) throw fail('WAV 里没有 data 块')
  if (fmt.tag !== TAG_PCM && fmt.tag !== TAG_FLOAT) {
    const name = CODEC_NAMES.get(fmt.tag) ?? '未知编码'
    throw fail(`参考音频是 ${name} 编码（${hex(fmt.tag)}），不是 PCM；请在设置页把文件拖进来让浏览器解码。`)
  }
  if (!fmt.bits || !fmt.channels || !fmt.rate) throw fail('WAV 头不完整（位深/声道/采样率有 0）')
  const frameSize = Math.ceil((fmt.bits * fmt.channels) / 8)
  const frames = Math.floor(dataLength / frameSize)
  return {
    pcm: true,
    tag: fmt.tag,
    codec: CODEC_NAMES.get(fmt.tag) ?? 'PCM',
    channels: fmt.channels,
    rate: fmt.rate,
    bits: fmt.bits,
    blockAlign: frameSize,
    dataOffset,
    dataLength: frames * frameSize,
    frames,
    seconds: frames / fmt.rate,
  }
}

/** 重新生成一个只含 data 的 WAV（头 44 字节，PCM/float 都用标准 fmt）。 */
function repack(buffer, info, start, frames) {
  const bytes = frames * info.blockAlign
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(info.tag, 20)
  header.writeUInt16LE(info.channels, 22)
  header.writeUInt32LE(info.rate, 24)
  header.writeUInt32LE(info.rate * info.blockAlign, 28)
  header.writeUInt16LE(info.blockAlign, 32)
  header.writeUInt16LE(info.bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(bytes, 40)
  const from = info.dataOffset + start * info.blockAlign
  return Buffer.concat([header, buffer.subarray(from, from + bytes)])
}

/**
 * 截取 [startSeconds, startSeconds + seconds) 的一段；越界自动夹住。
 * 不改变格式（PCM16/24/32、float32 都按 blockAlign 直接切）。
 */
export function sliceWav(buffer, startSeconds = 0, seconds = 20) {
  const info = inspectWav(buffer)
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const startFrame = Math.min(info.frames, Math.max(0, Math.floor(Number(startSeconds || 0) * info.rate)))
  const wantedFrames = Math.max(1, Math.round(Number(seconds || 0) * info.rate))
  const frames = Math.min(wantedFrames, info.frames - startFrame)
  return { wav: repack(buf, info, startFrame, frames), info, start: startFrame / info.rate, seconds: frames / info.rate }
}
