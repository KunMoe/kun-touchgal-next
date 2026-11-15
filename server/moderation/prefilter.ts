import { createHash } from 'crypto'
import {
  MODERATION_TEXT_HEAD_LENGTH,
  MODERATION_TEXT_MAX_LENGTH,
  MODERATION_TEXT_TAIL_LENGTH
} from '~/constants/moderation'
import { stripInvisible } from '~/utils/text/unicode'

// 黑名单匹配用的归一化。先剥不可见字符: 零宽字符、韩文填充符之类插在违禁词中间,
// 页面显示与黑名单词完全一致, 不剥就能让黑名单失配
export const normalizeModerationText = (text: string) =>
  stripInvisible(text).normalize('NFKC').toLowerCase().replace(/\s+/g, '')

// 裁决缓存键。只抹平大小写、全半角与空白, 刻意不剥不可见字符: 双向控制符会改变显示
// 顺序 (U+202E 后面的「信微加」显示为「加微信」), 缓存键若把它们也剥掉, 先让乱序的
// 无害文本通过并进缓存, 再发带控制符的版本就能直接命中旧裁决, 模型根本看不到
export const hashModerationText = (text: string) =>
  createHash('sha256')
    .update(text.normalize('NFKC').toLowerCase().replace(/\s+/g, ''))
    .digest('hex')

// strip base64 blobs / html tags and collapse whitespace, then keep only the
// head and tail of overlong text (spam contact info clusters at both ends)
export const prepareModerationText = (raw: string) => {
  const compact = raw
    .replace(/data:[a-z0-9/+.-]+;base64,[a-z0-9+/=]+/gi, '[图片]')
    .replace(/<[^>]{0,200}?>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (compact.length <= MODERATION_TEXT_MAX_LENGTH) {
    return compact
  }
  return `${compact.slice(0, MODERATION_TEXT_HEAD_LENGTH)}\n…\n${compact.slice(-MODERATION_TEXT_TAIL_LENGTH)}`
}

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
