import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import type { searchSchema } from '~/validations/search'
import type { SearchSuggestionType } from '~/types/api/search'

const {
  isMeiliEnabledMock,
  queryGalgameIdsMock,
  resolveTagIdsMock,
  resolveCompanyIdsMock,
  patchFindManyMock,
  patchCountMock
} = vi.hoisted(() => ({
  isMeiliEnabledMock: vi.fn(),
  queryGalgameIdsMock: vi.fn(),
  resolveTagIdsMock: vi.fn(),
  resolveCompanyIdsMock: vi.fn(),
  patchFindManyMock: vi.fn(),
  patchCountMock: vi.fn()
}))

vi.mock('~/lib/meilisearch', () => ({
  isMeiliEnabled: isMeiliEnabledMock
}))
vi.mock('~/server/search/query', () => ({
  queryGalgameIds: queryGalgameIdsMock
}))
vi.mock('~/server/search/resolve', () => ({
  resolveTagIdsByNames: resolveTagIdsMock,
  resolveCompanyIdsByNames: resolveCompanyIdsMock
}))
vi.mock('~/prisma/index', () => ({
  prisma: { patch: { findMany: patchFindManyMock, count: patchCountMock } }
}))

import { searchGalgames, toKeywordSearchSpec } from '~/server/galgame/search'
import { MeiliBadRequestError } from '~/server/search/failure'
import { GalgameCardSelectField } from '~/constants/api/select'
import { meiliApiError, meiliDown } from '~/server/search/__tests__/meiliErrors'
import { cardRow } from './cardRow'

const INPUT: z.infer<typeof searchSchema> = {
  queryString: '[]',
  limit: 12,
  searchOption: {
    searchInIntroduction: false,
    searchInAlias: false,
    searchInTag: false
  },
  page: 1,
  selectedType: 'all',
  selectedLanguage: 'all',
  selectedPlatform: 'all',
  sortField: 'resource_update_time',
  sortOrder: 'desc',
  selectedYears: ['all'],
  selectedMonths: ['all'],
  minRatingCount: 10
}

const keyword = (
  name: string,
  mode: SearchSuggestionType['mode'] = 'include'
): SearchSuggestionType => ({ type: 'keyword', mode, name })

const SFW = { contentLimit: 'sfw', blockedTagIds: [] } as const
const SFW_BLOCK = { contentLimit: 'sfw', blockedTagIds: [7, 8] } as const
const SFW_BLOCK_WHERE = {
  content_limit: 'sfw',
  NOT: { tag: { some: { tag_id: { in: [7, 8] } } } }
}

describe('toKeywordSearchSpec', () => {
  it('建议项按 include / exclude 与类型分组, 标签与会社只留 id 和名称', () => {
    const spec = toKeywordSearchSpec(INPUT, [
      keyword('kun'),
      keyword('moe', 'exclude'),
      { type: 'tag', mode: 'include', id: 3, name: '纯爱' },
      { type: 'tag', mode: 'exclude', name: '猎奇' },
      { type: 'company', mode: 'include', name: 'Key' },
      { type: 'company', mode: 'exclude', id: 9, name: 'Yuzusoft' }
    ])

    expect(spec.include).toEqual({
      keywords: ['kun'],
      tags: [{ id: 3, name: '纯爱' }],
      companies: [{ id: undefined, name: 'Key' }]
    })
    expect(spec.exclude).toEqual({
      keywords: ['moe'],
      tags: [{ id: undefined, name: '猎奇' }],
      companies: [{ id: 9, name: 'Yuzusoft' }]
    })
  })

  it('关键词去掉首尾空白, 去掉之后为空的丢弃; 标签与会社名称不动', () => {
    const spec = toKeywordSearchSpec(INPUT, [
      keyword('  kun  '),
      keyword('   '),
      keyword(' moe ', 'exclude'),
      keyword('', 'exclude'),
      { type: 'tag', mode: 'include', name: ' 纯爱 ' }
    ])

    expect(spec.include.keywords).toEqual(['kun'])
    expect(spec.exclude.keywords).toEqual(['moe'])
    expect(spec.include.tags).toEqual([{ id: undefined, name: ' 纯爱 ' }])
  })

  it('评分人数门槛只在按评分排序时带上', () => {
    expect(toKeywordSearchSpec(INPUT, []).filter.minRatingCount).toBe(0)
    expect(
      toKeywordSearchSpec({ ...INPUT, sortField: 'rating' }, []).filter
        .minRatingCount
    ).toBe(10)
  })

  it('筛选、检索选项、排序与分页逐项带上', () => {
    const spec = toKeywordSearchSpec(
      {
        ...INPUT,
        searchOption: {
          searchInIntroduction: true,
          searchInAlias: false,
          searchInTag: true
        },
        selectedType: 'pc',
        selectedLanguage: 'zh-Hans',
        selectedPlatform: 'windows',
        selectedYears: ['2024', 'future'],
        selectedMonths: ['01'],
        sortField: 'released',
        sortOrder: 'asc',
        page: 3,
        limit: 24
      },
      []
    )

    expect(spec).toEqual({
      include: { keywords: [], tags: [], companies: [] },
      exclude: { keywords: [], tags: [], companies: [] },
      searchIn: { introduction: true, alias: false, tag: true },
      filter: {
        type: 'pc',
        language: 'zh-Hans',
        platform: 'windows',
        years: ['2024', 'future'],
        months: ['01'],
        minRatingCount: 0
      },
      sort: { field: 'released', order: 'asc' },
      page: 3,
      limit: 24
    })
  })
})

describe('searchGalgames', () => {
  const spec = (suggestions: SearchSuggestionType[] = [keyword('kun')]) =>
    toKeywordSearchSpec(INPUT, suggestions)

  beforeEach(() => {
    vi.resetAllMocks()
    isMeiliEnabledMock.mockReturnValue(true)
    resolveTagIdsMock.mockResolvedValue(new Map())
    resolveCompanyIdsMock.mockResolvedValue(new Map())
    queryGalgameIdsMock.mockResolvedValue({ ids: [], total: 0 })
    patchFindManyMock.mockResolvedValue([])
    patchCountMock.mockResolvedValue(0)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('索引给出 id 与总数, 卡片由 PG 按同一视角水合, 响应标明 meili', async () => {
    queryGalgameIdsMock.mockResolvedValue({ ids: [5, 2], total: 40 })
    patchFindManyMock.mockResolvedValue([cardRow(2), cardRow(5)])

    const response = await searchGalgames(spec(), SFW_BLOCK)

    expect(queryGalgameIdsMock).toHaveBeenCalledTimes(1)
    expect(queryGalgameIdsMock).toHaveBeenCalledWith({
      q: 'kun',
      filter: 'contentLimit = "sfw" AND NOT tagIds IN [7, 8]',
      sort: ['resourceUpdateTime:desc', 'id:desc'],
      page: 1,
      hitsPerPage: 12,
      attributesToSearchOn: [
        'name',
        'vndbId',
        'vndbRelationId',
        'dlsiteCode',
        'company'
      ]
    })
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(patchFindManyMock).toHaveBeenCalledWith({
      where: { AND: [{ id: { in: [5, 2] } }, SFW_BLOCK_WHERE] },
      select: GalgameCardSelectField
    })
    expect(patchCountMock).not.toHaveBeenCalled()
    expect(response.galgames.map((card) => card.id)).toEqual([5, 2])
    expect(response.total).toBe(40)
    expect(response.engine).toBe('meili')
  })

  // 上一例全是默认值。这一例每个字段都取非默认值, 整体断言交给索引的查询:
  // 页码、每页条数、排序方向、三项筛选、年月、评分门槛、检索选项、排除项, 任何一项映射错了都会红
  it('非默认的搜索条件逐项映射成索引查询', async () => {
    resolveCompanyIdsMock.mockResolvedValue(
      new Map([
        ['Key', [9]],
        ['Leaf', [11, 12]]
      ])
    )
    const customSpec = toKeywordSearchSpec(
      {
        ...INPUT,
        page: 3,
        limit: 24,
        searchOption: {
          searchInIntroduction: true,
          searchInAlias: false,
          searchInTag: true
        },
        selectedType: 'pc',
        selectedLanguage: 'zh-Hans',
        selectedPlatform: 'windows',
        selectedYears: ['2024', 'future'],
        selectedMonths: ['01', '02'],
        sortField: 'rating',
        sortOrder: 'asc',
        minRatingCount: 5
      },
      [
        keyword('kun'),
        keyword('moe', 'exclude'),
        { type: 'tag', mode: 'exclude', id: 6, name: '猎奇' },
        { type: 'company', mode: 'include', name: 'Key' },
        { type: 'company', mode: 'exclude', name: 'Leaf' },
        { type: 'company', mode: 'exclude', id: 13, name: '带 id 的不解析' }
      ]
    )

    await searchGalgames(customSpec, SFW_BLOCK)

    expect(resolveTagIdsMock).toHaveBeenCalledWith([])
    expect(resolveCompanyIdsMock).toHaveBeenCalledWith(['Key', 'Leaf'])
    expect(queryGalgameIdsMock).toHaveBeenCalledTimes(1)
    expect(queryGalgameIdsMock).toHaveBeenCalledWith({
      q: 'kun -"moe"',
      filter:
        'type = "pc" AND language = "zh-Hans" AND platform = "windows" AND ' +
        '(releasedYear IN ["future"] OR (releasedYear IN ["2024"] AND releasedMonth IN ["01", "02"])) AND ' +
        'ratingCount >= 5 AND contentLimit = "sfw" AND NOT tagIds IN [7, 8] AND ' +
        'companyIds = 9 AND NOT tagIds IN [6] AND NOT companyIds IN [11, 12, 13]',
      sort: ['avgRating:asc', 'id:desc'],
      page: 3,
      hitsPerPage: 24,
      attributesToSearchOn: [
        'name',
        'vndbId',
        'vndbRelationId',
        'dlsiteCode',
        'company',
        'tag',
        'introduction'
      ]
    })
  })

  it.each([
    [
      '只开别名',
      { searchInIntroduction: false, searchInAlias: true, searchInTag: false },
      'alias'
    ],
    [
      '只开标签',
      { searchInIntroduction: false, searchInAlias: false, searchInTag: true },
      'tag'
    ],
    [
      '只开简介',
      { searchInIntroduction: true, searchInAlias: false, searchInTag: false },
      'introduction'
    ]
  ])(
    '检索选项%s: 只多检索对应的那个字段',
    async (_name, searchOption, attribute) => {
      await searchGalgames(
        toKeywordSearchSpec({ ...INPUT, searchOption }, [keyword('kun')]),
        SFW
      )

      expect(queryGalgameIdsMock.mock.calls[0][0].attributesToSearchOn).toEqual(
        ['name', 'vndbId', 'vndbRelationId', 'dlsiteCode', 'company', attribute]
      )
    }
  )

  it('外部 ID 关键词带着排除词时不走精确直查', async () => {
    await searchGalgames(
      spec([keyword('V1965'), keyword('foo', 'exclude')]),
      SFW
    )

    expect(queryGalgameIdsMock.mock.calls[0][0]).toMatchObject({
      q: 'V1965 -"foo"',
      filter: 'contentLimit = "sfw"'
    })
  })

  it('索引里陈旧的命中 (库里已删或此视角不可见) 不出现在结果里, 总数仍是索引的', async () => {
    queryGalgameIdsMock.mockResolvedValue({ ids: [1, 2, 3], total: 3 })
    patchFindManyMock.mockResolvedValue([cardRow(3), cardRow(1)])

    const response = await searchGalgames(spec(), SFW)

    expect(response.galgames.map((card) => card.id)).toEqual([1, 3])
    expect(response.total).toBe(3)
    expect(response.engine).toBe('meili')
  })

  it('单个外部 ID 关键词走精确直查: q 为空, 条件进 filter', async () => {
    await searchGalgames(spec([keyword('V1965')]), SFW)

    expect(queryGalgameIdsMock.mock.calls[0][0]).toMatchObject({
      q: '',
      filter:
        '(vndbId = "v1965" OR vndbRelationId = "v1965") AND contentLimit = "sfw"'
    })
  })

  it('不带 id 的标签 / 会社每类合并成一次名称解析, 解析结果进 filter', async () => {
    resolveTagIdsMock.mockResolvedValue(
      new Map([
        ['纯爱', [3, 4]],
        ['猎奇', [6]]
      ])
    )
    resolveCompanyIdsMock.mockResolvedValue(new Map([['Key', [9]]]))

    await searchGalgames(
      spec([
        keyword('kun'),
        { type: 'tag', mode: 'include', name: '纯爱' },
        { type: 'tag', mode: 'include', id: 1, name: '带 id 的不解析' },
        { type: 'tag', mode: 'exclude', name: '猎奇' },
        { type: 'company', mode: 'include', name: 'Key' }
      ]),
      SFW
    )

    expect(resolveTagIdsMock).toHaveBeenCalledTimes(1)
    expect(resolveTagIdsMock).toHaveBeenCalledWith(['纯爱', '猎奇'])
    expect(resolveCompanyIdsMock).toHaveBeenCalledTimes(1)
    expect(resolveCompanyIdsMock).toHaveBeenCalledWith(['Key'])
    expect(queryGalgameIdsMock.mock.calls[0][0].filter).toBe(
      'contentLimit = "sfw" AND tagIds IN [3, 4] AND tagIds = 1 AND companyIds = 9 AND NOT tagIds IN [6]'
    )
  })

  it('必含的标签解析不到任何 id 时直接是空结果, 不查索引也不查库', async () => {
    const response = await searchGalgames(
      spec([keyword('kun'), { type: 'tag', mode: 'include', name: '不存在' }]),
      SFW
    )

    expect(response).toEqual({ galgames: [], total: 0, engine: 'meili' })
    expect(queryGalgameIdsMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).not.toHaveBeenCalled()
  })

  it('Meilisearch 未启用时只走 basic, 响应标明 basic', async () => {
    isMeiliEnabledMock.mockReturnValue(false)
    patchFindManyMock.mockResolvedValue([cardRow(8)])
    patchCountMock.mockResolvedValue(1)

    const response = await searchGalgames(
      spec([keyword('kun'), { type: 'tag', mode: 'include', name: '纯爱' }]),
      SFW
    )

    expect(queryGalgameIdsMock).not.toHaveBeenCalled()
    // 名称解析只为索引服务: basic 自己按名称匹配, 不为它多查两次库
    expect(resolveTagIdsMock).not.toHaveBeenCalled()
    expect(resolveCompanyIdsMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(patchFindManyMock.mock.calls[0][0]).toMatchObject({
      take: 12,
      skip: 0
    })
    expect(response.galgames.map((card) => card.id)).toEqual([8])
    expect(response.total).toBe(1)
    expect(response.engine).toBe('basic')
  })

  it('Meilisearch 不可用时换到 basic, 响应标明 basic', async () => {
    queryGalgameIdsMock.mockRejectedValue(meiliDown())
    patchFindManyMock.mockResolvedValue([cardRow(8)])
    patchCountMock.mockResolvedValue(1)

    const response = await searchGalgames(spec(), SFW)

    expect(patchCountMock).toHaveBeenCalledTimes(1)
    expect(response.galgames.map((card) => card.id)).toEqual([8])
    expect(response.engine).toBe('basic')
  })

  it('索引没配好 (排序字段没注册) 时同样换到 basic', async () => {
    queryGalgameIdsMock.mockRejectedValue(
      meiliApiError(400, 'invalid_search_sort')
    )

    const response = await searchGalgames(spec(), SFW)

    expect(patchCountMock).toHaveBeenCalledTimes(1)
    expect(response.engine).toBe('basic')
  })

  it('请求参数被 Meilisearch 拒绝时不换引擎, 抛 MeiliBadRequestError', async () => {
    queryGalgameIdsMock.mockRejectedValue(
      meiliApiError(400, 'malformed_payload')
    )

    await expect(searchGalgames(spec(), SFW)).rejects.toBeInstanceOf(
      MeiliBadRequestError
    )
    expect(patchFindManyMock).not.toHaveBeenCalled()
    expect(patchCountMock).not.toHaveBeenCalled()
  })

  it('名称解析 (PG) 失败原样抛出, 两个引擎都不跑', async () => {
    const pgDown = new Error('pg down')
    resolveTagIdsMock.mockRejectedValue(pgDown)

    await expect(searchGalgames(spec(), SFW)).rejects.toBe(pgDown)
    expect(queryGalgameIdsMock).not.toHaveBeenCalled()
    expect(patchFindManyMock).not.toHaveBeenCalled()
  })

  it('卡片水合 (PG) 失败原样抛出, 不换到 basic', async () => {
    const pgDown = new Error('pg down')
    queryGalgameIdsMock.mockResolvedValue({ ids: [1], total: 1 })
    patchFindManyMock.mockRejectedValue(pgDown)

    await expect(searchGalgames(spec(), SFW)).rejects.toBe(pgDown)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(patchCountMock).not.toHaveBeenCalled()
  })
})
