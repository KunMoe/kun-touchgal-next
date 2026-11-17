import { describe, expect, it } from 'vitest'

import { extractMentionUserIds } from '~/app/api/utils/createMentionMessage'

describe('extractMentionUserIds', () => {
  it('提取编辑器插入的 /comment 提及链接', () => {
    expect(extractMentionUserIds('召唤 [@kun](/user/3/comment) 看看')).toEqual([
      3
    ])
  })

  it('提取历史内容中的 /resource 提及链接', () => {
    expect(extractMentionUserIds('[@kun](/user/3/resource)')).toEqual([3])
  })

  it('同时提取混合格式的多个提及', () => {
    expect(
      extractMentionUserIds(
        '[@a](/user/1/comment) 和 [@b](/user/2/resource) 以及 [@c](/user/5/comment)'
      )
    ).toEqual([1, 2, 5])
  })

  it('忽略普通链接与非提及内容', () => {
    expect(
      extractMentionUserIds(
        '[@kun](/user/3/setting) [普通链接](/user/3/comment) @裸文本'
      )
    ).toEqual([])
  })
})
