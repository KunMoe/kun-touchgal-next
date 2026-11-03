import { describe, expect, it } from 'vitest'
import {
  buildAttributesToSearchOn,
  buildGalgameSearchFilter,
  buildGalgameSearchSort,
  buildReleasedFilter,
  buildSearchQuery,
  matchExactIdQuery
} from '~/server/search/filter-builder'

describe('buildReleasedFilter', () => {
  it('years 含 all 时不过滤', () => {
    expect(buildReleasedFilter(['all'], ['01'])).toBe('')
  })

  it('实际年份 + 月份为 all 时仅按年过滤', () => {
    expect(buildReleasedFilter(['2024'], ['all'])).toBe(
      'releasedYear IN ["2024"]'
    )
  })

  it('实际年份 × 月份组合过滤', () => {
    expect(buildReleasedFilter(['2023', '2024'], ['01', '02'])).toBe(
      '(releasedYear IN ["2023", "2024"] AND releasedMonth IN ["01", "02"])'
    )
  })

  it('future/unknown 不受月份约束', () => {
    expect(buildReleasedFilter(['future', '2024'], ['01'])).toBe(
      '(releasedYear IN ["future"] OR (releasedYear IN ["2024"] AND releasedMonth IN ["01"]))'
    )
  })

  it('仅 unknown', () => {
    expect(buildReleasedFilter(['unknown'], ['all'])).toBe(
      'releasedYear IN ["unknown"]'
    )
  })
})

describe('buildGalgameSearchFilter', () => {
  it('无任何条件时返回空字符串', () => {
    expect(buildGalgameSearchFilter({})).toBe('')
  })

  it('type/language/platform 为 all 时不过滤', () => {
    expect(
      buildGalgameSearchFilter({
        selectedType: 'all',
        selectedLanguage: 'all',
        selectedPlatform: 'all'
      })
    ).toBe('')
  })

  it('单维度筛选', () => {
    expect(buildGalgameSearchFilter({ selectedType: 'pc' })).toBe('type = "pc"')
    expect(buildGalgameSearchFilter({ selectedLanguage: 'zh-Hans' })).toBe(
      'language = "zh-Hans"'
    )
    expect(buildGalgameSearchFilter({ selectedPlatform: 'windows' })).toBe(
      'platform = "windows"'
    )
  })

  it('字符串值中的引号被转义', () => {
    expect(buildGalgameSearchFilter({ selectedType: 'p"c' })).toBe(
      'type = "p\\"c"'
    )
  })

  it('minRatingCount 大于 0 时生效', () => {
    expect(buildGalgameSearchFilter({ minRatingCount: 10 })).toBe(
      'ratingCount >= 10'
    )
    expect(buildGalgameSearchFilter({ minRatingCount: 0 })).toBe('')
  })

  it('内容分级三态', () => {
    expect(buildGalgameSearchFilter({ contentLimit: 'sfw' })).toBe(
      'contentLimit = "sfw"'
    )
    expect(buildGalgameSearchFilter({ contentLimit: 'nsfw' })).toBe(
      'contentLimit = "nsfw"'
    )
    expect(buildGalgameSearchFilter({ contentLimit: null })).toBe('')
  })

  it('屏蔽标签升序排列后排除', () => {
    expect(buildGalgameSearchFilter({ blockedTagIds: [3, 1] })).toBe(
      'NOT tagIds IN [1, 3]'
    )
  })

  it('标签页与会社页的定向过滤', () => {
    expect(buildGalgameSearchFilter({ tagId: 42 })).toBe('tagIds = 42')
    expect(buildGalgameSearchFilter({ companyId: 7 })).toBe('companyIds = 7')
  })

  it('include 组：单 id 用等值，多 id 用 IN，多组之间为 AND', () => {
    expect(
      buildGalgameSearchFilter({ includeTagIdGroups: [[5], [6, 2]] })
    ).toBe('tagIds = 5 AND tagIds IN [2, 6]')
    expect(buildGalgameSearchFilter({ includeCompanyIdGroups: [[9]] })).toBe(
      'companyIds = 9'
    )
  })

  it('include 组解析为空集时返回 null（不可能命中）', () => {
    expect(buildGalgameSearchFilter({ includeTagIdGroups: [[]] })).toBeNull()
    expect(
      buildGalgameSearchFilter({ includeCompanyIdGroups: [[1], []] })
    ).toBeNull()
  })

  it('exclude 集合合并排除', () => {
    expect(buildGalgameSearchFilter({ excludeTagIds: [7, 2] })).toBe(
      'NOT tagIds IN [2, 7]'
    )
    expect(buildGalgameSearchFilter({ excludeCompanyIds: [4] })).toBe(
      'NOT companyIds IN [4]'
    )
  })

  it('exactId 精确子句置于最前，其余条件照常 AND', () => {
    expect(
      buildGalgameSearchFilter({ exactId: { kind: 'vndb', value: 'v17' } })
    ).toBe('(vndbId = "v17" OR vndbRelationId = "v17")')
    expect(
      buildGalgameSearchFilter({ exactId: { kind: 'dlsite', value: 'RJ123' } })
    ).toBe('dlsiteCode = "RJ123"')
    expect(
      buildGalgameSearchFilter({
        exactId: { kind: 'vndb', value: 'v17' },
        contentLimit: 'sfw'
      })
    ).toBe(
      '(vndbId = "v17" OR vndbRelationId = "v17") AND contentLimit = "sfw"'
    )
  })

  it('组合条件按 AND 连接', () => {
    expect(
      buildGalgameSearchFilter({
        selectedType: 'pc',
        selectedLanguage: 'zh-Hans',
        years: ['2024'],
        months: ['all'],
        minRatingCount: 10,
        contentLimit: 'sfw',
        blockedTagIds: [1],
        includeTagIdGroups: [[5]]
      })
    ).toBe(
      'type = "pc" AND language = "zh-Hans" AND releasedYear IN ["2024"] AND ' +
        'ratingCount >= 10 AND contentLimit = "sfw" AND NOT tagIds IN [1] AND tagIds = 5'
    )
  })
})

describe('buildGalgameSearchSort', () => {
  it('排序字段映射与旧实现一致，并追加 id 稳定 tiebreaker', () => {
    expect(buildGalgameSearchSort('created', 'desc')).toEqual([
      'created:desc',
      'id:desc'
    ])
    expect(buildGalgameSearchSort('resource_update_time', 'asc')).toEqual([
      'resourceUpdateTime:asc',
      'id:desc'
    ])
    expect(buildGalgameSearchSort('view', 'desc')).toEqual([
      'view:desc',
      'id:desc'
    ])
    expect(buildGalgameSearchSort('download', 'desc')).toEqual([
      'download:desc',
      'id:desc'
    ])
    expect(buildGalgameSearchSort('favorite', 'desc')).toEqual([
      'favoriteCount:desc',
      'id:desc'
    ])
    expect(buildGalgameSearchSort('rating', 'asc')).toEqual([
      'avgRating:asc',
      'id:desc'
    ])
    expect(buildGalgameSearchSort('released', 'desc')).toEqual([
      'releasedSort:desc',
      'id:desc'
    ])
  })

  it('未知字段返回空数组', () => {
    expect(buildGalgameSearchSort('unknown', 'desc')).toEqual([])
  })
})

describe('buildAttributesToSearchOn', () => {
  const base = ['name', 'vndbId', 'vndbRelationId', 'dlsiteCode', 'company']

  it('三个开关全关时仅搜基础字段', () => {
    expect(
      buildAttributesToSearchOn({
        searchInIntroduction: false,
        searchInAlias: false,
        searchInTag: false
      })
    ).toEqual(base)
  })

  it('开关按需追加字段', () => {
    expect(
      buildAttributesToSearchOn({
        searchInIntroduction: true,
        searchInAlias: true,
        searchInTag: true
      })
    ).toEqual([...base, 'alias', 'tag', 'introduction'])
  })
})

describe('buildSearchQuery', () => {
  it('包含关键词以空格连接', () => {
    expect(buildSearchQuery(['魔女', '夜宴'], [])).toBe('魔女 夜宴')
  })

  it('移除中文复合查询中的独立停用词', () => {
    expect(buildSearchQuery(['魔女的'], [])).toBe('魔女')
    expect(buildSearchQuery(['魔女的夜宴'], [])).toBe('魔女 夜宴')
    expect(buildSearchQuery(['的', '魔女'], [])).toBe('魔女')
  })

  it('保留非独立停用词与纯停用词查询', () => {
    expect(buildSearchQuery(['的确如此'], [])).toBe('的确如此')
    expect(buildSearchQuery(['的'], [])).toBe('的')
  })

  it('排除 phrase 不移除停用词', () => {
    expect(buildSearchQuery([], ['魔女的'])).toBe('-"魔女的"')
  })

  it('词首 - 从包含关键词中剥离，避免翻转为排除', () => {
    expect(buildSearchQuery(['ATRI -My Dear Moments-'], [])).toBe(
      'ATRI My Dear Moments-'
    )
  })

  it('词中 - 不受影响', () => {
    expect(buildSearchQuery(['9-nine-'], [])).toBe('9-nine-')
  })

  it('排除关键词统一 quote 成负向 phrase', () => {
    expect(buildSearchQuery(['a'], ['b'])).toBe('a -"b"')
    expect(buildSearchQuery([], ['c d'])).toBe('-"c d"')
  })

  it('双引号替换为空格，防 phrase 提前闭合或吞并后续查询', () => {
    expect(buildSearchQuery(['a"b'], ['c'])).toBe('a b -"c"')
    expect(buildSearchQuery([], ['c"d'])).toBe('-"c d"')
    expect(buildSearchQuery(['"'], ['"'])).toBe('')
  })

  it('空输入返回空字符串', () => {
    expect(buildSearchQuery([], [])).toBe('')
  })
})

describe('matchExactIdQuery', () => {
  it('唯一 v<数字> 关键词命中 vndb，并归一化为小写', () => {
    expect(matchExactIdQuery(['v123'], [])).toEqual({
      kind: 'vndb',
      value: 'v123'
    })
    expect(matchExactIdQuery(['V17'], [])).toEqual({
      kind: 'vndb',
      value: 'v17'
    })
    expect(matchExactIdQuery([' v9 '], [])).toEqual({
      kind: 'vndb',
      value: 'v9'
    })
  })

  it('RJ / VJ 编号命中 dlsite，并归一化为大写', () => {
    expect(matchExactIdQuery(['RJ01234567'], [])).toEqual({
      kind: 'dlsite',
      value: 'RJ01234567'
    })
    expect(matchExactIdQuery(['vj123'], [])).toEqual({
      kind: 'dlsite',
      value: 'VJ123'
    })
  })

  it('多关键词、含 exclude、或非外部 ID 格式时不短路', () => {
    expect(matchExactIdQuery(['v123', 'extra'], [])).toBeNull()
    expect(matchExactIdQuery(['v123'], ['v456'])).toBeNull()
    expect(matchExactIdQuery(['魔女'], [])).toBeNull()
    expect(matchExactIdQuery(['v'], [])).toBeNull()
    expect(matchExactIdQuery(['12345'], [])).toBeNull()
    expect(matchExactIdQuery(['RJ'], [])).toBeNull()
    expect(matchExactIdQuery(['BJ123'], [])).toBeNull()
    expect(matchExactIdQuery([], [])).toBeNull()
  })
})
