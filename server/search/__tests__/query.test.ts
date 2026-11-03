import { describe, expect, it } from 'vitest'
import { searchDocToGalgameCard } from '~/server/search/query'
import type { GalgameSearchDoc } from '~/server/search/document'

describe('searchDocToGalgameCard', () => {
  const baseDoc: GalgameSearchDoc = {
    id: 1024,
    uniqueId: 'abcd1234',
    name: 'サノバウィッチ',
    banner: 'sano-banner.avif',
    alias: ['魔女的夜宴'],
    tag: ['恋爱', '魔女', '校园', '治愈', '喜剧'],
    company: ['Yuzusoft'],
    introduction: '魔女的故事',
    vndbId: 'v16044',
    vndbRelationId: null,
    dlsiteCode: null,
    tagIds: [1, 2, 3, 4, 5],
    companyIds: [3],
    type: ['pc'],
    language: ['zh-Hans', 'ja'],
    platform: ['windows'],
    contentLimit: 'sfw',
    releasedYear: '2015',
    releasedMonth: '02',
    releasedSort: 20150227,
    created: Math.floor(new Date('2023-11-15T00:00:00Z').getTime() / 1000),
    updated: Math.floor(new Date('2024-03-10T00:00:00Z').getTime() / 1000),
    resourceUpdateTime: Math.floor(
      new Date('2024-03-10T00:00:00Z').getTime() / 1000
    ),
    view: 12000,
    download: 3400,
    favoriteCount: 500,
    resourceCount: 8,
    commentCount: 15,
    ratingCount: 87,
    avgRating: 8.6
  }

  it('索引文档完整映射为卡片', () => {
    expect(searchDocToGalgameCard(baseDoc)).toEqual({
      id: 1024,
      uniqueId: 'abcd1234',
      name: 'サノバウィッチ',
      banner: 'sano-banner.avif',
      view: 12000,
      download: 3400,
      type: ['pc'],
      language: ['zh-Hans', 'ja'],
      platform: ['windows'],
      created: '2023-11-15T00:00:00.000Z',
      _count: { favorite_folder: 500, resource: 8, comment: 15 },
      averageRating: 8.6
    })
  })

  it('created 从 Unix 秒还原为 ISO 字符串', () => {
    expect(searchDocToGalgameCard(baseDoc).created).toBe(
      '2023-11-15T00:00:00.000Z'
    )
  })

  it('averageRating 四舍五入至一位小数，0 值归零', () => {
    expect(
      searchDocToGalgameCard({ ...baseDoc, avgRating: 8.567 }).averageRating
    ).toBe(8.6)
    expect(
      searchDocToGalgameCard({ ...baseDoc, avgRating: 0 }).averageRating
    ).toBe(0)
  })

  it('旧索引 / 骨架文档缺失字段时走兜底，不抛异常', () => {
    // 计数刷新的 updateDocuments 对尚未建索引的 id 会 upsert 出仅含计数
    // 的骨架文档；映射时必须容忍缺失字段而非抛错拖垮整个查询。
    const stale: Partial<GalgameSearchDoc> = { ...baseDoc }
    delete stale.banner
    delete stale.resourceCount
    delete stale.commentCount
    const card = searchDocToGalgameCard(stale as GalgameSearchDoc)
    expect(card.banner).toBe('')
    expect(card._count.resource).toBe(0)
    expect(card._count.comment).toBe(0)
  })
})
