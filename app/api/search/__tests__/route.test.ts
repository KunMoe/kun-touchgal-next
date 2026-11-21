// /api/search 在 Meilisearch 关闭时走 Prisma 降级路径: 钉住它交给 prisma.patch.findMany /
// count 的完整参数与响应映射。只经导出的 POST 调用, 只 mock 会话 / Redis / Prisma /
// Meilisearch 这些接缝; 校验、可见性、筛选与排序 helper、卡片映射都走真实代码
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALL,
  NSFW_ONLY,
  SFW,
  SFW_BLOCK_10_20,
  V,
  postRequest,
  readJson,
  type MatrixViewer
} from '~/server/viewer/__tests__/viewerMatrix'

const { findManyMock, countMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn()
}))

vi.mock(
  '~/server/auth/session',
  async () => (await import('~/server/viewer/__tests__/viewerMatrix')).jwtModule
)
vi.mock(
  '~/lib/redis',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).redisModule
)
vi.mock(
  '~/app/api/utils/pendingResourceCache',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix'))
      .pendingResourceModule
)
// 只有 patch 的两个方法: 降级路径之外的 Prisma 访问会直接抛错
vi.mock('~/prisma/index', () => ({
  prisma: { patch: { findMany: findManyMock, count: countMock } }
}))
vi.mock('~/lib/meilisearch', () => ({
  isMeiliEnabled: () => false,
  getMeiliClient: () => null
}))

import { POST } from '~/app/api/search/route'

const BASE_BODY = {
  queryString: '[{"type":"keyword","name":"kun"}]',
  limit: 24,
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
  minRatingCount: 0
}

interface Suggestion {
  type: string
  mode?: string
  id?: number
  name: string
}

const queryOf = (...items: Suggestion[]) => JSON.stringify(items)

// 值为 undefined 的键经 JSON.stringify 后不出现在请求体里, 用来模拟「没传」
const search = async (
  overrides: Record<string, unknown> = {},
  viewer: MatrixViewer = V.guest
) =>
  readJson(
    await POST(
      postRequest('/api/search', viewer, { ...BASE_BODY, ...overrides })
    )
  )

interface FindManyArgs {
  take: unknown
  skip: unknown
  orderBy: unknown
  where: unknown
  select: unknown
}

// findMany 与 count 各调一次; count 只收 where, 且与 findMany 的 where 相同
const capturedArgs = (): FindManyArgs => {
  expect(findManyMock).toHaveBeenCalledTimes(1)
  expect(countMock).toHaveBeenCalledTimes(1)
  const [args] = findManyMock.mock.calls[0] as [FindManyArgs]
  expect(countMock.mock.calls[0]).toEqual([{ where: args.where }])
  return args
}

const capturedWhere = () => capturedArgs().where

const ci = (value: string) => ({ contains: value, mode: 'insensitive' })

// 三个检索选项都关闭时, 一个包含 / 排除关键词各自的条件
const keywordInclude = (keyword: string) => ({
  OR: [
    { name: ci(keyword) },
    { vndb_id: keyword },
    { vndb_relation_id: keyword },
    { dlsite_code: keyword }
  ]
})

const keywordExclude = (keyword: string) => ({
  AND: [
    { NOT: { name: ci(keyword) } },
    { OR: [{ vndb_id: null }, { vndb_id: { not: keyword } }] },
    {
      OR: [{ vndb_relation_id: null }, { vndb_relation_id: { not: keyword } }]
    },
    { OR: [{ dlsite_code: null }, { dlsite_code: { not: keyword } }] }
  ]
})

// 无 id 的标签 / 会社建议项: 放在 some 里的按名匹配
const tagByName = (name: string) => ({
  tag: { OR: [{ name }, { alias: { has: name } }] }
})

const companyByName = (name: string) => ({
  company: {
    OR: [{ name }, { alias: { has: name } }, { parent_brand: { has: name } }]
  }
})

beforeEach(() => {
  vi.resetAllMocks()
  findManyMock.mockResolvedValue([])
  countMock.mockResolvedValue(0)
})

describe('/api/search POST Prisma 降级路径: 关键词', () => {
  it('单个包含关键词、检索选项全关、游客: findMany 与 count 的完整参数', async () => {
    await search()

    expect(capturedArgs()).toEqual({
      take: 24,
      skip: 0,
      orderBy: [{ resource_update_time: 'desc' }, { id: 'desc' }],
      where: {
        AND: [
          {
            OR: [
              { name: { contains: 'kun', mode: 'insensitive' } },
              { vndb_id: 'kun' },
              { vndb_relation_id: 'kun' },
              { dlsite_code: 'kun' }
            ]
          },
          // 可见性第一次出现: AND 数组的一项
          { content_limit: 'sfw' }
        ],
        // 第二次: 经 buildGalgameWhere 展开在顶层
        content_limit: 'sfw'
      },
      select: {
        id: true,
        unique_id: true,
        name: true,
        banner: true,
        view: true,
        download: true,
        type: true,
        language: true,
        platform: true,
        created: true,
        favorite_count: true,
        resource_count: true,
        comment_count: true,
        rating_stat: { select: { avg_overall: true } }
      }
    })
  })

  const INTRODUCTION = { introduction: ci('kun') }
  const ALIAS = { alias: { some: { name: ci('kun') } } }
  const TAG = { tag: { some: { tag: { name: ci('kun') } } } }

  // 只写开启的那一项: 没写的由 schema 默认为 false
  it.each([
    {
      name: '只开简介',
      searchOption: { searchInIntroduction: true },
      extra: [INTRODUCTION]
    },
    { name: '只开别名', searchOption: { searchInAlias: true }, extra: [ALIAS] },
    { name: '只开标签', searchOption: { searchInTag: true }, extra: [TAG] },
    {
      name: '三项全开',
      searchOption: {
        searchInIntroduction: true,
        searchInAlias: true,
        searchInTag: true
      },
      extra: [INTRODUCTION, ALIAS, TAG]
    }
  ])(
    '包含关键词, $name: OR 末尾按简介 → 别名 → 标签追加',
    async ({ searchOption, extra }) => {
      await search({ searchOption })

      expect(capturedWhere()).toEqual({
        AND: [{ OR: [...keywordInclude('kun').OR, ...extra] }, SFW],
        ...SFW
      })
    }
  )

  it.each([
    {
      name: '检索选项全关',
      searchOption: BASE_BODY.searchOption,
      condition: keywordExclude('kun')
    },
    // 逐项开启: 三个开关各管各的那一段, 写反了会在这里露出来
    {
      name: '只开简介',
      searchOption: { searchInIntroduction: true },
      condition: {
        AND: [
          ...keywordExclude('kun').AND,
          { NOT: { introduction: ci('kun') } }
        ]
      }
    },
    {
      name: '只开别名',
      searchOption: { searchInAlias: true },
      condition: {
        AND: [
          ...keywordExclude('kun').AND,
          { alias: { none: { name: ci('kun') } } }
        ]
      }
    },
    {
      name: '只开标签',
      searchOption: { searchInTag: true },
      condition: {
        AND: [
          ...keywordExclude('kun').AND,
          { tag: { none: { tag: { name: ci('kun') } } } }
        ]
      }
    },
    {
      name: '检索选项全开',
      searchOption: {
        searchInIntroduction: true,
        searchInAlias: true,
        searchInTag: true
      },
      condition: {
        AND: [
          ...keywordExclude('kun').AND,
          { NOT: { introduction: ci('kun') } },
          { alias: { none: { name: ci('kun') } } },
          { tag: { none: { tag: { name: ci('kun') } } } }
        ]
      }
    }
  ])(
    '排除关键词, $name: 名称不含、三个外部 ID 为空或不等, 选项开启时追加简介 / 别名 / 标签',
    async ({ searchOption, condition }) => {
      await search({
        searchOption,
        queryString: queryOf({ type: 'keyword', mode: 'exclude', name: 'kun' })
      })

      expect(capturedWhere()).toEqual({ AND: [SFW, condition], ...SFW })
    }
  )

  it('多个包含关键词各占 AND 的一项, 重复的不去重', async () => {
    await search({
      queryString: queryOf(
        { type: 'keyword', name: 'kun' },
        { type: 'keyword', name: 'galgame' },
        { type: 'keyword', name: 'kun' }
      )
    })

    expect(capturedWhere()).toEqual({
      AND: [
        keywordInclude('kun'),
        keywordInclude('galgame'),
        keywordInclude('kun'),
        SFW
      ],
      ...SFW
    })
  })

  it('关键词去掉首尾空白、空白的丢弃, 关键词的 id 被忽略; 标签 / 会社名原样保留, 空名也不丢', async () => {
    await search({
      queryString: queryOf(
        { type: 'keyword', name: '  kun  ' },
        { type: 'keyword', name: '   ' },
        { type: 'keyword', name: '' },
        // 首尾是全角空格 (U+3000)
        { type: 'keyword', name: '　星　' },
        { type: 'keyword', id: 3, name: 'galgame' },
        { type: 'keyword', mode: 'exclude', name: '\tnsfw\n' },
        { type: 'keyword', mode: 'exclude', name: ' ' },
        { type: 'tag', name: ' 纯爱 ' },
        { type: 'tag', name: '' },
        { type: 'company', mode: 'exclude', name: '  ' }
      )
    })

    expect(capturedWhere()).toEqual({
      AND: [
        keywordInclude('kun'),
        keywordInclude('星'),
        keywordInclude('galgame'),
        SFW,
        { tag: { some: tagByName(' 纯爱 ') } },
        { tag: { some: tagByName('') } },
        keywordExclude('nsfw'),
        { NOT: { company: { some: companyByName('  ') } } }
      ],
      ...SFW
    })
  })

  it.each([
    { name: '空建议数组', queryString: '[]' },
    {
      name: '只有空白关键词',
      queryString: queryOf(
        { type: 'keyword', name: ' ' },
        { type: 'keyword', mode: 'exclude', name: '' }
      )
    }
  ])('$name: AND 里只剩可见性, 不加任何关键词约束', async ({ queryString }) => {
    await search({ queryString })

    expect(capturedWhere()).toEqual({ AND: [SFW], ...SFW })
  })
})

describe('/api/search POST Prisma 降级路径: 标签与会社', () => {
  it('包含标签 / 会社: 有 id 按 id, 无 id 按名称精确匹配 (标签: 名称或别名; 会社: 名称、别名或母品牌); 建议项不带 mode 即包含', async () => {
    await search({
      queryString: queryOf(
        { type: 'tag', id: 7, name: '被忽略的标签名' },
        { type: 'tag', mode: 'include', name: '纯爱' },
        { type: 'company', id: 5, name: '被忽略的会社名' },
        { type: 'company', name: 'Key' }
      )
    })

    expect(capturedWhere()).toEqual({
      AND: [
        SFW,
        { tag: { some: { tag_id: 7 } } },
        {
          tag: {
            some: {
              tag: { OR: [{ name: '纯爱' }, { alias: { has: '纯爱' } }] }
            }
          }
        },
        { company: { some: { company_id: 5 } } },
        {
          company: {
            some: {
              company: {
                OR: [
                  { name: 'Key' },
                  { alias: { has: 'Key' } },
                  { parent_brand: { has: 'Key' } }
                ]
              }
            }
          }
        }
      ],
      ...SFW
    })
  })

  it('排除标签 / 会社: 同样的匹配条件包在 NOT 里', async () => {
    await search({
      queryString: queryOf(
        { type: 'tag', mode: 'exclude', id: 7, name: '被忽略的标签名' },
        { type: 'tag', mode: 'exclude', name: '致郁' },
        { type: 'company', mode: 'exclude', id: 5, name: '被忽略的会社名' },
        { type: 'company', mode: 'exclude', name: 'Leaf' }
      )
    })

    expect(capturedWhere()).toEqual({
      AND: [
        SFW,
        { NOT: { tag: { some: { tag_id: 7 } } } },
        {
          NOT: {
            tag: {
              some: {
                tag: { OR: [{ name: '致郁' }, { alias: { has: '致郁' } }] }
              }
            }
          }
        },
        { NOT: { company: { some: { company_id: 5 } } } },
        {
          NOT: {
            company: {
              some: {
                company: {
                  OR: [
                    { name: 'Leaf' },
                    { alias: { has: 'Leaf' } },
                    { parent_brand: { has: 'Leaf' } }
                  ]
                }
              }
            }
          }
        }
      ],
      ...SFW
    })
  })

  it('AND 的分组次序与建议项的输入次序无关: 包含关键词 → 可见性 → 包含标签 → 包含会社 → 排除关键词 → 排除标签 → 排除会社, 组内保持输入次序', async () => {
    await search({
      queryString: queryOf(
        { type: 'company', mode: 'exclude', name: 'Leaf' },
        { type: 'tag', mode: 'exclude', id: 9, name: '致郁' },
        { type: 'keyword', mode: 'exclude', name: 'nsfw' },
        { type: 'company', id: 5, name: 'Key' },
        { type: 'tag', id: 8, name: '校园' },
        { type: 'keyword', name: 'kun' },
        { type: 'tag', name: '纯爱' },
        { type: 'keyword', mode: 'include', name: 'galgame' }
      )
    })

    expect(capturedWhere()).toEqual({
      AND: [
        keywordInclude('kun'),
        keywordInclude('galgame'),
        SFW,
        { tag: { some: { tag_id: 8 } } },
        { tag: { some: tagByName('纯爱') } },
        { company: { some: { company_id: 5 } } },
        keywordExclude('nsfw'),
        { NOT: { tag: { some: { tag_id: 9 } } } },
        { NOT: { company: { some: companyByName('Leaf') } } }
      ],
      ...SFW
    })
  })
})

describe('/api/search POST Prisma 降级路径: 筛选', () => {
  it.each([
    {
      name: '类型',
      filters: { selectedType: 'adv' },
      top: { type: { has: 'adv' } }
    },
    {
      name: '语言',
      filters: { selectedLanguage: 'ja' },
      top: { language: { has: 'ja' } }
    },
    {
      name: '平台',
      filters: { selectedPlatform: 'android' },
      top: { platform: { has: 'android' } }
    },
    {
      name: '三项同时',
      filters: {
        selectedType: 'adv',
        selectedLanguage: 'ja',
        selectedPlatform: 'android'
      },
      top: {
        type: { has: 'adv' },
        language: { has: 'ja' },
        platform: { has: 'android' }
      }
    }
  ])('$name不为 all 时顶层加 has 条件', async ({ filters, top }) => {
    await search(filters)

    expect(capturedWhere()).toEqual({
      AND: [keywordInclude('kun'), SFW],
      ...SFW,
      ...top
    })
  })

  const startsWith = (prefix: string) => ({ released: { startsWith: prefix } })

  it.each([
    {
      name: '年份 all: 月份被忽略',
      years: ['all'],
      months: ['01'],
      date: {}
    },
    {
      name: '年份里有 all 即不过滤',
      years: ['2020', 'all'],
      months: ['all'],
      date: {}
    },
    {
      name: '精确年份 × 月份 all: 按整年',
      years: ['2020', '2021'],
      months: ['all'],
      date: { OR: [startsWith('2020'), startsWith('2021')] }
    },
    {
      name: '精确年份 × 精确月份: 按年展开',
      years: ['2020', '2021'],
      months: ['01', '12'],
      date: {
        OR: [
          startsWith('2020-01'),
          startsWith('2020-12'),
          startsWith('2021-01'),
          startsWith('2021-12')
        ]
      }
    },
    {
      name: '月份里有 all 即按整年',
      years: ['2020'],
      months: ['01', 'all'],
      date: { OR: [startsWith('2020')] }
    },
    {
      name: 'future / unknown 精确相等, 恒排在精确年份之前, 不受月份影响',
      years: ['2020', 'unknown', 'future'],
      months: ['03'],
      date: {
        OR: [
          { released: 'future' },
          { released: 'unknown' },
          startsWith('2020-03')
        ]
      }
    },
    {
      name: '只有 unknown',
      years: ['unknown'],
      months: ['all'],
      date: { OR: [{ released: 'unknown' }] }
    },
    {
      name: '年份与月份先经 schema 去掉首尾空白',
      years: [' 2020 '],
      months: [' 05 '],
      date: { OR: [startsWith('2020-05')] }
    },
    {
      name: '年份为空数组: 不过滤',
      years: [],
      months: ['all'],
      date: {}
    },
    {
      name: '精确年份配空月份数组: 年份条件整个消失',
      years: ['2020'],
      months: [],
      date: {}
    },
    {
      name: '精确年份配空月份数组: 只剩 future',
      years: ['future', '2020'],
      months: [],
      date: { OR: [{ released: 'future' }] }
    }
  ])('发售年月, $name', async ({ years, months, date }) => {
    await search({ selectedYears: years, selectedMonths: months })

    expect(capturedWhere()).toEqual({
      AND: [keywordInclude('kun'), SFW],
      ...SFW,
      ...date
    })
  })

  it.each([
    { name: '按评分排序, 传 5', sortField: 'rating', min: 5, gte: 5 },
    {
      name: '按评分排序, 不传: schema 默认 10',
      sortField: 'rating',
      min: undefined,
      gte: 10
    },
    { name: '按评分排序, 传 0', sortField: 'rating', min: 0, gte: null },
    { name: '按浏览量排序, 传 5: 忽略', sortField: 'view', min: 5, gte: null },
    {
      name: '按发售日期排序, 不传: 忽略默认值',
      sortField: 'released',
      min: undefined,
      gte: null
    }
  ])('最少评分人数, $name', async ({ sortField, min, gte }) => {
    await search({ sortField, minRatingCount: min })

    expect(capturedWhere()).toEqual({
      AND: [keywordInclude('kun'), SFW],
      ...SFW,
      ...(gte === null ? {} : { rating_stat: { count: { gte } } })
    })
  })

  it('全部筛选同时生效: 顶层同时带可见性、日期 OR、has 条件与评分人数', async () => {
    await search({
      selectedType: 'adv',
      selectedLanguage: 'ja',
      selectedPlatform: 'android',
      selectedYears: ['2020', 'future'],
      selectedMonths: ['all'],
      sortField: 'rating',
      minRatingCount: 3
    })

    expect(capturedWhere()).toEqual({
      AND: [keywordInclude('kun'), SFW],
      OR: [{ released: 'future' }, startsWith('2020')],
      type: { has: 'adv' },
      language: { has: 'ja' },
      platform: { has: 'android' },
      rating_stat: { count: { gte: 3 } },
      content_limit: 'sfw'
    })
  })
})

describe('/api/search POST Prisma 降级路径: 分页与排序', () => {
  it.each([
    { page: 1, limit: 24, take: 24, skip: 0 },
    { page: 3, limit: 10, take: 10, skip: 20 },
    { page: 9999999, limit: 1, take: 1, skip: 9999998 },
    // 数字字段由 schema 从字符串转成数字
    { page: '2', limit: '5', take: 5, skip: 5 }
  ])(
    'page $page、limit $limit → take $take、skip $skip',
    async ({ page, limit, take, skip }) => {
      await search({ page, limit })

      const args = capturedArgs()
      expect(args.take).toBe(take)
      expect(args.skip).toBe(skip)
    }
  )

  // 7 个排序字段各自的主排序键
  const PRIMARY_ORDER_BY = [
    {
      sortField: 'resource_update_time',
      primary: (o: string) => ({ resource_update_time: o })
    },
    { sortField: 'created', primary: (o: string) => ({ created: o }) },
    { sortField: 'view', primary: (o: string) => ({ view: o }) },
    { sortField: 'download', primary: (o: string) => ({ download: o }) },
    {
      sortField: 'favorite',
      primary: (o: string) => ({ favorite_count: o })
    },
    {
      sortField: 'rating',
      primary: (o: string) => ({ rating_stat: { avg_overall: o } })
    },
    // 按 released_sort 而不是 released 排, 空值升降序都在末尾
    {
      sortField: 'released',
      primary: (o: string) => ({ released_sort: { sort: o, nulls: 'last' } })
    }
  ]

  it.each(
    PRIMARY_ORDER_BY.flatMap((row) => [
      { ...row, sortOrder: 'asc' },
      { ...row, sortOrder: 'desc' }
    ])
  )(
    'sortField $sortField、sortOrder $sortOrder: 主排序键之后恒接 id 降序',
    async ({ sortField, sortOrder, primary }) => {
      await search({ sortField, sortOrder })

      expect(capturedArgs().orderBy).toEqual([
        primary(sortOrder),
        { id: 'desc' }
      ])
    }
  )
})

describe('/api/search POST Prisma 降级路径: 视角', () => {
  it.each([
    { viewer: V.guest, visibility: SFW },
    // 没有会话时伪造的 NSFW 与屏蔽标签 cookie 不被采信
    { viewer: V.guestForged, visibility: SFW },
    // NSFW 设置为 all: 没有 content_limit, AND 里是一个空对象
    { viewer: V.userAll, visibility: ALL },
    { viewer: V.userNsfw, visibility: NSFW_ONLY },
    { viewer: V.blockerDb, visibility: SFW_BLOCK_10_20 },
    {
      viewer: V.superAdminBlocker,
      visibility: { NOT: { tag: { some: { tag_id: { in: [7, 8] } } } } }
    }
  ])(
    '$viewer.name: 可见性同时出现在 AND 里与顶层',
    async ({ viewer, visibility }) => {
      await search({}, viewer)

      expect(capturedWhere()).toEqual({
        AND: [keywordInclude('kun'), visibility],
        ...visibility
      })
    }
  )
})

describe('/api/search POST Prisma 降级路径: 响应', () => {
  it('查询行经 toGalgameCard 逐字段映射, total 取 count 的结果', async () => {
    findManyMock.mockResolvedValueOnce([
      {
        id: 1,
        unique_id: 'kun00001',
        name: '星之终途',
        banner: 'banner-1.webp',
        view: 100,
        download: 20,
        type: ['adv'],
        language: ['zh-Hans'],
        platform: ['windows'],
        created: new Date('2026-01-02T03:04:05.000Z'),
        favorite_count: 3,
        resource_count: 4,
        comment_count: 5,
        rating_stat: { avg_overall: 7.25 },
        // select 之外的字段不会被带进卡片
        content_limit: 'nsfw'
      },
      {
        id: 2,
        unique_id: 'kun00002',
        name: '无评分',
        banner: '',
        view: 0,
        download: 0,
        type: [],
        language: [],
        platform: [],
        created: new Date('2026-02-03T00:00:00.000Z'),
        favorite_count: 0,
        resource_count: 0,
        comment_count: 0,
        rating_stat: null
      }
    ])
    countMock.mockResolvedValueOnce(42)

    const body = (await search()) as { galgames: unknown; total: unknown }

    expect(body.galgames).toEqual([
      {
        id: 1,
        uniqueId: 'kun00001',
        name: '星之终途',
        banner: 'banner-1.webp',
        view: 100,
        download: 20,
        type: ['adv'],
        language: ['zh-Hans'],
        platform: ['windows'],
        created: '2026-01-02T03:04:05.000Z',
        _count: { favorite_folder: 3, resource: 4, comment: 5 },
        // 四舍五入到一位小数
        averageRating: 7.3
      },
      {
        id: 2,
        uniqueId: 'kun00002',
        name: '无评分',
        banner: '',
        view: 0,
        download: 0,
        type: [],
        language: [],
        platform: [],
        created: '2026-02-03T00:00:00.000Z',
        _count: { favorite_folder: 0, resource: 0, comment: 0 },
        averageRating: 0
      }
    ])
    expect(body.total).toBe(42)
  })

  it.each([
    { name: '不是 JSON', queryString: 'kun' },
    {
      name: 'JSON 对象而不是数组',
      queryString: '{"type":"keyword","name":"kun"}'
    },
    { name: 'type 不在枚举里', queryString: '[{"type":"user","name":"kun"}]' },
    {
      name: 'mode 不在枚举里',
      queryString: '[{"type":"keyword","mode":"maybe","name":"kun"}]'
    },
    { name: 'id 小于 1', queryString: '[{"type":"tag","id":0,"name":"kun"}]' },
    { name: '缺 name', queryString: '[{"type":"keyword"}]' }
  ])('建议项$name: 回业务错误字符串, 不查库', async ({ queryString }) => {
    expect(await search({ queryString })).toBe('搜索条件格式错误')
    expect(findManyMock).not.toHaveBeenCalled()
    expect(countMock).not.toHaveBeenCalled()
  })
})
