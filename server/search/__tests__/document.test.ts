import { describe, expect, it } from 'vitest'
import {
  SEARCH_COUNT_FIELDS,
  SEARCH_INTRODUCTION_MAX_LENGTH,
  computeSearchDocHash,
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

  it('按码点截断: 上限落在代理对中间时不留下孤立代理', async () => {
    // 1999 个 BMP 字符之后是 emoji: 按 UTF-16 码元截到 2000 会只留下它的高位代理
    const text = await markdownToSearchText(
      '字'.repeat(SEARCH_INTRODUCTION_MAX_LENGTH - 1) + '😀'.repeat(10)
    )
    expect(text.isWellFormed()).toBe(true)
    expect([...text]).toHaveLength(SEARCH_INTRODUCTION_MAX_LENGTH)
    expect(text.endsWith('字😀')).toBe(true)
  })
})

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
  resource_update_time: new Date('2024-03-10T00:00:00Z'),
  alias: [{ name: '魔女的夜宴' }, { name: 'sanoba witch' }],
  tag: [{ tag: { id: 1, name: '恋爱' } }, { tag: { id: 2, name: '魔女' } }],
  company: [{ company: { id: 3, name: 'Yuzusoft' } }],
  rating_stat: { avg_overall: 8.6, count: 87 }
}

describe('patchToSearchDoc', () => {
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
      resourceUpdateTime: Math.floor(
        basePayload.resource_update_time.getTime() / 1000
      ),
      view: 12000,
      download: 3400,
      favoriteCount: 500,
      resourceCount: 8,
      commentCount: 15,
      ratingCount: 87,
      avgRating: 8.6,
      docHash: expect.stringMatching(/^[0-9a-f]{40}$/)
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

describe('computeSearchDocHash 文档摘要', () => {
  const hashOf = async (payload: PatchSearchPayload) =>
    (await patchToSearchDoc(payload)).docHash

  it('计数字段变化不改变摘要: 它们由计数刷新任务单独写入', async () => {
    const base = await hashOf(basePayload)
    const counted = await hashOf({
      ...basePayload,
      view: 1,
      download: 2,
      favorite_count: 3,
      resource_count: 4,
      comment_count: 5,
      rating_stat: { avg_overall: 1, count: 1 }
    })
    expect(counted).toBe(base)
  })

  it('摘要剔除的恰好是全部计数字段', async () => {
    const doc = await patchToSearchDoc(basePayload)
    const { docHash, ...rest } = doc
    for (const field of SEARCH_COUNT_FIELDS) {
      expect(computeSearchDocHash({ ...rest, [field]: -1 })).toBe(docHash)
    }
    expect(computeSearchDocHash({ ...rest, releasedSort: 1 })).not.toBe(docHash)
  })

  it.each([
    [
      '标签改名',
      { tag: [{ tag: { id: 1, name: '纯爱' } }, basePayload.tag[1]] }
    ],
    ['会社改指', { company: [{ company: { id: 4, name: 'Yuzusoft' } }] }],
    ['别名变化', { alias: [{ name: '魔女的夜宴' }] }],
    ['简介变化', { introduction: '**魔女**的故事续' }],
    ['分级变化', { content_limit: 'nsfw' }],
    ['资源更新时间变化', { resource_update_time: new Date('2025-01-01') }]
  ])('%s 改变摘要', async (_name, overrides) => {
    expect(await hashOf({ ...basePayload, ...overrides })).not.toBe(
      await hashOf(basePayload)
    )
  })

  it('关联的返回顺序不影响摘要 (关联查询没有 orderBy)', async () => {
    const reordered = await hashOf({
      ...basePayload,
      alias: [...basePayload.alias].reverse(),
      tag: [...basePayload.tag].reverse(),
      language: [...basePayload.language].reverse()
    })
    expect(reordered).toBe(await hashOf(basePayload))
  })
})
