// Markdown → 可朗读文本。
//
// 引擎不做语义归一化（数字、单位、日期原样喂模型），清洗是调用侧的事。
// 这里只做"念出来不会出戏"的最小处理：删代码块/表格，去标记符号，折叠空白，
// 按句末边界截断。规则宁可少也不要错——念错一个符号比少念一句更烦人。
const FENCE = /```[\s\S]*?```/gu
const INLINE_CODE = /`([^`]*)`/gu
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/gu
const LINK = /\[([^\]]*)\]\([^)]*\)/gu
const HEADING = /^\s{0,3}#{1,6}\s+/gmu
const QUOTE = /^\s{0,3}>\s?/gmu
const LIST = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/gmu
const TABLE_ROW = /^\s*\|.*\|\s*$/gmu
const TABLE_SEP = /^\s*\|?[\s:|-]{3,}\|?\s*$/gmu
const HTML = /<[^>\n]{1,120}>/gu
const BOLD = /\*\*([^\n]+?)\*\*/gu
const BOLD_ALT = /__([^\n]+?)__/gu
const STRIKE = /~~([^\n]+?)~~/gu
const ITALIC = /(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/gu
const TRAILING_SPACES = /[ \t]+$/gmu
const BLANK_LINES = /\n{2,}/gu

function truncate(text, maxChars) {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return { text, truncated: false }
  const window = text.slice(0, maxChars)
  const cut = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf('；'),
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('\n'),
  )
  const end = cut >= maxChars * 0.5 ? cut + 1 : maxChars
  return { text: window.slice(0, end).trimEnd(), truncated: true }
}

/**
 * @param {string} markdown
 * @param {{maxChars?: number, skipCode?: boolean}} [options]
 * @returns {{text: string, truncated: boolean, originalLength: number}}
 */
export function toSpeakable(markdown, options = {}) {
  const { maxChars = 1500, skipCode = true } = options
  const original = String(markdown ?? '')
  let text = original.replace(/\r\n?/gu, '\n')
  if (skipCode) text = text.replace(FENCE, '\n')
  else text = text.replace(/```[^\n]*\n?/gu, '')
  text = text
    .replace(TABLE_SEP, '\n')
    .replace(TABLE_ROW, '\n')
    .replace(IMAGE, '$1')
    .replace(LINK, '$1')
    .replace(INLINE_CODE, '$1')
    .replace(HEADING, '')
    .replace(QUOTE, '')
    .replace(LIST, '')
    .replace(HTML, ' ')
    .replace(BOLD, '$1')
    .replace(BOLD_ALT, '$1')
    .replace(STRIKE, '$1')
    .replace(ITALIC, '$1')
    .replace(TRAILING_SPACES, '')
    .replace(BLANK_LINES, '\n')
    .replace(/[ \t]{2,}/gu, ' ')

  // 换行在中文里就是停顿；用逗号比用空格自然，但英文句子会被打断。
  // 折中：中文行尾补逗号，其他情况用空格。
  text = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index, rows) => {
      const isLast = index === rows.length - 1
      if (isLast || /[，。！？；、,:;.!?]$/u.test(line)) return line
      const cjk = /[\u4e00-\u9fff]$/u.test(line)
      return cjk ? `${line}，` : `${line} `
    })
    .join('')
    .replace(/，{2,}/gu, '，')
    .replace(/ {2,}/gu, ' ')
    .trim()

  const capped = truncate(text, maxChars)
  return { text: capped.text, truncated: capped.truncated, originalLength: original.length }
}
