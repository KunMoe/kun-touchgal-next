import { createHash } from 'crypto'
import {
  MODERATION_TEXT_HEAD_LENGTH,
  MODERATION_TEXT_MAX_LENGTH,
  MODERATION_TEXT_TAIL_LENGTH
} from '~/constants/moderation'
import { stripInvisible } from '~/utils/text/unicode'

// 先剥不可见字符: 零宽字符、韩文填充符之类插在违禁词中间, 页面显示与黑名单词
// 完全一致, 不剥就能让黑名单失配
export const normalizeModerationText = (text: string) =>
  stripInvisible(text).normalize('NFKC').toLowerCase().replace(/\s+/g, '')

export const hashModerationText = (normalizedText: string) =>
  createHash('sha256').update(normalizedText).digest('hex')

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
