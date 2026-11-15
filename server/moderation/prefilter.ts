import { createHash } from 'crypto'
import { stripInvisible } from '~/utils/text/unicode'

// 黑名单匹配用的归一化。先剥不可见字符: 零宽字符、韩文填充符之类插在违禁词中间,
// 页面显示与黑名单词完全一致, 不剥就能让黑名单失配
export const normalizeModerationText = (text: string) =>
  stripInvisible(text).normalize('NFKC').toLowerCase().replace(/\s+/g, '')

// 裁决缓存键: 对送审视图里的各个值取 hash, 只差大小写、全半角与空白的内容共用一份裁决。
// 两条承重点:
// - 刻意不剥不可见字符。双向控制符会改变显示顺序 (U+202E 后面的「信微加」显示为
//   「加微信」), 若把它们也抹掉, 先让乱序的无害文本通过并进缓存, 再发带控制符的版本
//   就能直接命中旧裁决, 模型根本看不到。
// - 先逐个值归一化, 再序列化。反过来 (先拼成一条消息再做 NFKC) 的话, 全角的引号、
//   花括号会被折成 JSON 的结构字符, 一个字段的值就能伪装成另一种字段划分, 撞上别的
//   内容的缓存键 —— 比如把只在标题里才违规的文字伪装进介绍
export const hashModerationTexts = (texts: readonly string[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        texts.map((text) =>
          text.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
        )
      )
    )
    .digest('hex')

export interface ModerationBlacklistEntry {
  pattern: string
  content_types: string[]
}

// 取对该 content_type 生效的模式; 空 content_types 表示对全部类型生效
export const filterBlacklistPatterns = (
  entries: ModerationBlacklistEntry[],
  contentType: string
): string[] =>
  entries
    .filter(
      (entry) =>
        !entry.content_types.length || entry.content_types.includes(contentType)
    )
    .map((entry) => entry.pattern)

export const matchBlacklist = (
  normalizedText: string,
  patterns: string[]
): string | null => {
  for (const pattern of patterns) {
    const normalizedPattern = normalizeModerationText(pattern)
    if (normalizedPattern && normalizedText.includes(normalizedPattern)) {
      return pattern
    }
  }
  return null
}
