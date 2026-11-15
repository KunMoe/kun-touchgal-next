import { describe, expect, it } from 'vitest'
import {
  filterBlacklistPatterns,
  hashModerationTexts,
  matchBlacklist,
  normalizeModerationText
} from '../prefilter'

describe('filterBlacklistPatterns', () => {
  const entries = [
    { pattern: 'all-types', content_types: [] },
    { pattern: 'comment-only', content_types: ['comment'] },
    { pattern: 'rating-bio', content_types: ['rating', 'bio'] }
  ]

  it('空 content_types 对全部类型生效', () => {
    expect(filterBlacklistPatterns(entries, 'resource')).toEqual(['all-types'])
  })

  it('只返回包含该类型的条目', () => {
    expect(filterBlacklistPatterns(entries, 'comment')).toEqual([
      'all-types',
      'comment-only'
    ])
    expect(filterBlacklistPatterns(entries, 'bio')).toEqual([
      'all-types',
      'rating-bio'
    ])
  })

  it('空条目列表返回空数组', () => {
    expect(filterBlacklistPatterns([], 'comment')).toEqual([])
  })
})

describe('normalizeModerationText (黑名单与缓存键的归一化)', () => {
  it('NFKC + 小写 + 去全部空白', () => {
    expect(normalizeModerationText('ＡＢＣ　１２３ x\n\tY')).toBe('abc123xy')
  })

  it('剥掉不可见字符', () => {
    expect(normalizeModerationText('加\u200B微\u3164信\uFFF9')).toBe('加微信')
  })
})

describe('hashModerationTexts (裁决缓存键)', () => {
  it('只差大小写、全半角与空白 (含换行) 的值共用一个键', () => {
    expect(hashModerationTexts(['标题', 'Hello  World'])).toBe(
      hashModerationTexts(['标题', 'ｈｅｌｌｏ\nworld'])
    )
    expect(hashModerationTexts(['标题', 'Hello World'])).not.toBe(
      hashModerationTexts(['标题', 'Hello Word'])
    )
  })

  // U+202E 之后的文字从右往左显示: 「信微加」读作「加微信」。两者若共用缓存键,
  // 先发乱序的无害版本骗过模型, 再发带控制符的版本就能直接命中旧裁决
  it('不可见字符不被抹掉: 带双向控制符的文本有自己的键', () => {
    expect(hashModerationTexts(['\u202E信微加'])).not.toBe(
      hashModerationTexts(['信微加'])
    )
    expect(hashModerationTexts(['加\u200B微信'])).not.toBe(
      hashModerationTexts(['加微信'])
    )
  })

  // 先序列化再归一化的话, 全角引号与花括号会被 NFKC 折成 JSON 的结构字符
  it('值里的全角标点伪装不成另一种字段划分', () => {
    const honest = hashModerationTexts(['标题', '某游戏', '介绍', '系列合集'])
    const forged = hashModerationTexts([
      '标题',
      '某游戏＂，＂介绍＂，＂系列合集'
    ])
    const asciiForged = hashModerationTexts([
      '标题',
      '某游戏","介绍","系列合集'
    ])

    expect(forged).not.toBe(honest)
    expect(asciiForged).not.toBe(honest)
  })

  it('同样的文字放在不同字段里是不同的键', () => {
    expect(hashModerationTexts(['链接', 'abcd', '提取码', ''])).not.toBe(
      hashModerationTexts(['链接', '', '提取码', 'abcd'])
    )
  })
})

describe('matchBlacklist', () => {
  const hit = (text: string, pattern: string) =>
    matchBlacklist(normalizeModerationText(text), [pattern])

  it('返回命中的原始模式, 模式本身同样归一化', () => {
    expect(hit('快来加微信abc123哦', '加微信 ABC123')).toBe('加微信 ABC123')
  })

  it('全角与插空格都能命中', () => {
    expect(hit('加微信ａｂｃ１２３', '加微信abc123')).toBe('加微信abc123')
    expect(hit('加 微 信 abc 123', '加微信abc123')).toBe('加微信abc123')
  })

  it('归一化后为空的模式不命中任何文本', () => {
    expect(matchBlacklist('anything', ['', '   '])).toBeNull()
  })

  // 不可见字符插在违禁词中间, 页面显示与黑名单词完全一致 (P13-02)
  it.each([
    ['ZWSP', '\u200B'],
    ['ZWNJ', '\u200C'],
    ['ZWJ', '\u200D'],
    ['WJ', '\u2060'],
    ['SHY', '\u00AD'],
    ['BOM', '\uFEFF'],
    ['MVS', '\u180E'],
    ['HANGUL FILLER (Default_Ignorable, 非 Cf)', '\u3164'],
    ['INTERLINEAR ANCHOR (Cf, 非 Default_Ignorable)', '\uFFF9'],
    ['LRM', '\u200E'],
    ['CGJ (Default_Ignorable, 非 Cf)', '\u034F']
  ])('违禁词中间插入 %s 仍命中', (_name, invisible) => {
    const text = `快来加微${invisible}信abc${invisible}123哦`

    expect(hit(text, '加微信abc123')).toBe('加微信abc123')
  })

  it('模式里的不可见字符同样被剥掉', () => {
    expect(hit('快来加微信abc123哦', '加微\u200B信abc123')).toBe(
      '加微\u200B信abc123'
    )
  })
})
