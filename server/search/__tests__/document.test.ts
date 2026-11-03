import { describe, expect, it } from 'vitest'
import {
  SEARCH_INTRODUCTION_MAX_LENGTH,
  markdownToSearchText,
  parseReleasedDate,
  patchToSearchDoc
} from '~/server/search/document'
import type { PatchSearchPayload } from '~/server/search/document'

describe('parseReleasedDate', () => {
  it('完整日期解析出年与月', () => {
    expect(parseReleasedDate('2015-02-27')).toEqual({
      releasedYear: '2015',
      releasedMonth: '02'
    })
  })

  it('仅年份时月份为 null', () => {
    expect(parseReleasedDate('2015')).toEqual({
      releasedYear: '2015',
      releasedMonth: null
    })
  })

  it('future/unknown 原样保留', () => {
    expect(parseReleasedDate('future')).toEqual({
      releasedYear: 'future',
      releasedMonth: null
    })
    expect(parseReleasedDate('unknown')).toEqual({
      releasedYear: 'unknown',
      releasedMonth: null
    })
  })

  it('无法解析的值映射为空字符串，不命中任何年份筛选', () => {
    expect(parseReleasedDate('')).toEqual({
      releasedYear: '',
      releasedMonth: null
    })
    expect(parseReleasedDate('garbage')).toEqual({
      releasedYear: '',
      releasedMonth: null
    })
  })
})

describe('markdownToSearchText', () => {
  it('剥离 Markdown 语法与图片，保留文本', async () => {
    const text = await markdownToSearchText(
      '# 标题\n\n**粗体**文本 [链接文字](https://example.com) ![图](x.png)'
    )
    expect(text).toContain('标题')
    expect(text).toContain('粗体文本')
    expect(text).toContain('链接文字')
    expect(text).not.toContain('#')
    expect(text).not.toContain('**')
    expect(text).not.toContain('example.com')
    expect(text).not.toContain('x.png')
  })

  it('空字符串直接返回', async () => {
    expect(await markdownToSearchText('')).toBe('')
  })

  it('超长文本截断至上限', async () => {
    const text = await markdownToSearchText('字'.repeat(5000))
    expect(text.length).toBe(SEARCH_INTRODUCTION_MAX_LENGTH)
  })
})

describe('patchToSearchDoc', () => {
  const basePayload: PatchSearchPayload = {
    id: 1024,
    unique_id: 'abcd1234',
    name: 'サノバウィッチ',
    banner: 'sano-banner.avif',
    vndb_id: 'v16044',
    vndb_relation_id: null,
    dlsite_code: null,
    introduction: '**魔女**的故事',
    released: '2015-02-27',
    released_sort: 20150227,
    content_limit: 'sfw',
    type: ['pc'],
    language: ['zh-Hans', 'ja'],
    platform: ['windows'],
    view: 12000,
    download: 3400,
    favorite_count: 500,
    resource_count: 8,
    comment_count: 15,
    created: new Date('2023-11-15T00:00:00Z'),
    updated: new Date('2024-03-10T00:00:00Z'),
    resource_update_time: new Date('2024-03-10T00:00:00Z'),
    alias: [{ name: '魔女的夜宴' }, { name: 'sanoba witch' }],
    tag: [{ tag: { id: 1, name: '恋爱' } }, { tag: { id: 2, name: '魔女' } }],
    company: [{ company: { id: 3, name: 'Yuzusoft' } }],
    rating_stat: { avg_overall: 8.6, count: 87 }
  }

  it('完整字段映射', async () => {
    const doc = await patchToSearchDoc(basePayload)
    expect(doc).toEqual({
      id: 1024,
      uniqueId: 'abcd1234',
      name: 'サノバウィッチ',
      banner: 'sano-banner.avif',
      alias: ['魔女的夜宴', 'sanoba witch'],
      tag: ['恋爱', '魔女'],
      company: ['Yuzusoft'],
      introduction: '魔女的故事',
      vndbId: 'v16044',
      vndbRelationId: null,
      dlsiteCode: null,
      tagIds: [1, 2],
      companyIds: [3],
      type: ['pc'],
      language: ['zh-Hans', 'ja'],
      platform: ['windows'],
      contentLimit: 'sfw',
      releasedYear: '2015',
      releasedMonth: '02',
      releasedSort: 20150227,
      created: Math.floor(basePayload.created.getTime() / 1000),
      updated: Math.floor(basePayload.updated.getTime() / 1000),
      resourceUpdateTime: Math.floor(
        basePayload.resource_update_time.getTime() / 1000
      ),
      view: 12000,
      download: 3400,
      favoriteCount: 500,
      resourceCount: 8,
      commentCount: 15,
      ratingCount: 87,
      avgRating: 8.6
    })
  })

  it('空关联与缺失评分统计取默认值', async () => {
    const doc = await patchToSearchDoc({
      ...basePayload,
      alias: [],
      tag: [],
      company: [],
      rating_stat: null,
      introduction: '',
      released: 'unknown',
      released_sort: null
    })
    expect(doc.alias).toEqual([])
    expect(doc.tagIds).toEqual([])
    expect(doc.companyIds).toEqual([])
    expect(doc.ratingCount).toBe(0)
    expect(doc.avgRating).toBe(0)
    expect(doc.introduction).toBe('')
    expect(doc.releasedYear).toBe('unknown')
    expect(doc.releasedMonth).toBeNull()
    expect(doc.releasedSort).toBeNull()
  })
})
