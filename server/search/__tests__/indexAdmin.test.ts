import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from 'meilisearch'
import { GALGAME_INDEX_SETTINGS } from '~/server/search/settings'
import {
  FRESH_V1_15_2_SETTINGS,
  LOCAL_V1_15_2_SETTINGS
} from './meiliSettingsFixture'
import { meiliApiError, meiliDown } from './meiliErrors'

const {
  getMeiliClientMock,
  patchCountMock,
  getRawInfoMock,
  getSettingsMock,
  updateSettingsMock,
  createIndexMock,
  updateIndexMock
} = vi.hoisted(() => ({
  getMeiliClientMock: vi.fn(),
  patchCountMock: vi.fn(),
  getRawInfoMock: vi.fn(),
  getSettingsMock: vi.fn(),
  updateSettingsMock: vi.fn(),
  createIndexMock: vi.fn(),
  updateIndexMock: vi.fn()
}))

vi.mock('~/lib/meilisearch', () => ({
  getMeiliClient: getMeiliClientMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: { patch: { count: patchCountMock } }
}))
vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import {
  diffIndexSettings,
  ensureSearchIndex
} from '~/server/search/indexAdmin'

// 在真实输出上改一处, 其余保持引擎返回的原样
const actualWith = (patch: Settings): Settings => ({
  ...structuredClone(LOCAL_V1_15_2_SETTINGS),
  ...patch
})

const SORTABLE_BEFORE_AF42C4AD = [
  'avgRating',
  'created',
  'download',
  'favoriteCount',
  'resourceUpdateTime',
  'view'
]

describe('diffIndexSettings 只比较声明了的键', () => {
  it('本地 v1.15.2 的真实输出与代码定义没有差异 (排序、去重与默认值都不算)', () => {
    expect(
      diffIndexSettings(GALGAME_INDEX_SETTINGS, LOCAL_V1_15_2_SETTINGS)
    ).toEqual([])
  })

  it('线上少了 releasedSort 与 id 两个排序字段: sortableAttributes 一条 expand', () => {
    const actual = actualWith({ sortableAttributes: SORTABLE_BEFORE_AF42C4AD })

    expect(diffIndexSettings(GALGAME_INDEX_SETTINGS, actual)).toEqual([
      {
        key: 'sortableAttributes',
        kind: 'expand',
        expected: GALGAME_INDEX_SETTINGS.sortableAttributes,
        actual: SORTABLE_BEFORE_AF42C4AD
      }
    ])
  })

  it('线上多出代码已删除的字段: contract', () => {
    const actual = actualWith({
      filterableAttributes: [
        ...(LOCAL_V1_15_2_SETTINGS.filterableAttributes ?? []),
        'banner'
      ]
    })

    expect(diffIndexSettings(GALGAME_INDEX_SETTINGS, actual)).toMatchObject([
      { key: 'filterableAttributes', kind: 'contract' }
    ])
  })

  it('同一个集合里既有增也有删: change', () => {
    const actual = actualWith({
      sortableAttributes: [...SORTABLE_BEFORE_AF42C4AD, 'releasedSort', 'name']
    })

    expect(diffIndexSettings(GALGAME_INDEX_SETTINGS, actual)).toMatchObject([
      { key: 'sortableAttributes', kind: 'change' }
    ])
  })

  it('filterableAttributes 换成对象形态: 不抛错, 记为 change; 两边相同的对象不算差异', () => {
    const granular = {
      attributePatterns: ['type'],
      features: {
        facetSearch: false,
        filter: { equality: true, comparison: false }
      }
    }
    const filterable = (LOCAL_V1_15_2_SETTINGS.filterableAttributes ?? []).map(
      (attribute) => (attribute === 'type' ? granular : attribute)
    )

    expect(
      diffIndexSettings(
        GALGAME_INDEX_SETTINGS,
        actualWith({ filterableAttributes: filterable })
      )
    ).toMatchObject([{ key: 'filterableAttributes', kind: 'change' }])
    expect(
      diffIndexSettings(
        { filterableAttributes: [...filterable].reverse() },
        actualWith({ filterableAttributes: filterable })
      )
    ).toEqual([])
  })

  it('差异里只有对象形态的条目 (只多或只少一条): 仍记 change, 不当成单纯的增删', () => {
    const granular = {
      attributePatterns: ['banner'],
      features: {
        facetSearch: false,
        filter: { equality: true, comparison: false }
      }
    }
    const declared = LOCAL_V1_15_2_SETTINGS.filterableAttributes ?? []

    expect(
      diffIndexSettings(
        GALGAME_INDEX_SETTINGS,
        actualWith({ filterableAttributes: [...declared, granular] })
      )
    ).toMatchObject([{ key: 'filterableAttributes', kind: 'change' }])
    expect(
      diffIndexSettings(
        { filterableAttributes: [...declared, granular] },
        actualWith({ filterableAttributes: declared })
      )
    ).toMatchObject([{ key: 'filterableAttributes', kind: 'change' }])
  })

  it('searchableAttributes 换了先后: change (顺序即权重)', () => {
    const [first, second, ...rest] =
      GALGAME_INDEX_SETTINGS.searchableAttributes ?? []
    const actual = actualWith({
      searchableAttributes: [second, first, ...rest]
    })

    expect(diffIndexSettings(GALGAME_INDEX_SETTINGS, actual)).toMatchObject([
      { key: 'searchableAttributes', kind: 'change' }
    ])
  })

  it('有序列表按原有先后增删: 代码多了是 expand, 线上多了是 contract', () => {
    const searchable = GALGAME_INDEX_SETTINGS.searchableAttributes ?? []

    expect(
      diffIndexSettings(
        GALGAME_INDEX_SETTINGS,
        actualWith({
          searchableAttributes: searchable.filter((a) => a !== 'dlsiteCode')
        })
      )
    ).toMatchObject([{ key: 'searchableAttributes', kind: 'expand' }])
    expect(
      diffIndexSettings(
        GALGAME_INDEX_SETTINGS,
        actualWith({ searchableAttributes: [...searchable, 'banner'] })
      )
    ).toMatchObject([{ key: 'searchableAttributes', kind: 'contract' }])
  })

  it('线上多出一条同义词: 声明的 {} 也要比出 change', () => {
    const actual = actualWith({ synonyms: { 老婆: ['waifu'] } })

    expect(diffIndexSettings(GALGAME_INDEX_SETTINGS, actual)).toMatchObject([
      { key: 'synonyms', kind: 'change', actual: { 老婆: ['waifu'] } }
    ])
  })

  it('没声明的键与没声明的子键再怎么不同也不算差异', () => {
    const actual = actualWith({
      displayedAttributes: ['name'],
      proximityPrecision: 'byAttribute',
      faceting: { maxValuesPerFacet: 10 },
      dictionary: ['kun'],
      searchCutoffMs: 150,
      typoTolerance: {
        ...LOCAL_V1_15_2_SETTINGS.typoTolerance,
        disableOnWords: ['atri'],
        disableOnNumbers: true
      }
    })

    expect(diffIndexSettings(GALGAME_INDEX_SETTINGS, actual)).toEqual([])
  })

  it('嵌套的 typoTolerance.minWordSizeForTypos 变了: change', () => {
    const actual = actualWith({
      typoTolerance: {
        ...LOCAL_V1_15_2_SETTINGS.typoTolerance,
        minWordSizeForTypos: { oneTypo: 5, twoTypos: 8 }
      }
    })

    expect(diffIndexSettings(GALGAME_INDEX_SETTINGS, actual)).toMatchObject([
      { key: 'typoTolerance', kind: 'change' }
    ])
  })

  it('线上缺键 (null): 集合按空集记 expand, 其余记 change', () => {
    const actual = actualWith({
      sortableAttributes: null,
      localizedAttributes: null
    })

    expect(diffIndexSettings(GALGAME_INDEX_SETTINGS, actual)).toMatchObject([
      { key: 'sortableAttributes', kind: 'expand' },
      { key: 'localizedAttributes', kind: 'change' }
    ])
  })

  it('新建的空索引: 默认值与代码一致的键 (rankingRules、synonyms) 不下发, 没有 contract', () => {
    const diffs = diffIndexSettings(
      GALGAME_INDEX_SETTINGS,
      FRESH_V1_15_2_SETTINGS
    )

    expect(
      Object.fromEntries(diffs.map((diff) => [diff.key, diff.kind]))
    ).toEqual({
      searchableAttributes: 'change',
      filterableAttributes: 'expand',
      sortableAttributes: 'expand',
      stopWords: 'expand',
      typoTolerance: 'change',
      pagination: 'change',
      localizedAttributes: 'change'
    })
  })
})

const succeeded = { uid: 1, status: 'succeeded', error: null }

// SDK 的写方法返回带 waitTask 的 Promise
const enqueued = (task: object = succeeded) => ({
  waitTask: vi.fn().mockResolvedValue(task)
})

const appliedKeys = (report: Awaited<ReturnType<typeof ensureSearchIndex>>) =>
  report?.applied.map((diff) => diff.key)

describe('ensureSearchIndex', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getMeiliClientMock.mockReturnValue({
      index: () => ({
        getRawInfo: getRawInfoMock,
        getSettings: getSettingsMock,
        updateSettings: updateSettingsMock
      }),
      createIndex: createIndexMock,
      updateIndex: updateIndexMock
    })
    patchCountMock.mockResolvedValue(14360)
    getRawInfoMock.mockResolvedValue({ uid: 'galgame', primaryKey: 'id' })
    getSettingsMock.mockResolvedValue(structuredClone(LOCAL_V1_15_2_SETTINGS))
    updateSettingsMock.mockImplementation(() => enqueued())
    createIndexMock.mockImplementation(() => enqueued())
    updateIndexMock.mockImplementation(() => enqueued())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('未配置 Meilisearch 返回 null, 不读库', async () => {
    getMeiliClientMock.mockReturnValue(null)

    await expect(ensureSearchIndex({ mode: 'check' })).resolves.toBeNull()
    expect(patchCountMock).not.toHaveBeenCalled()
  })

  it('线上与代码一致: 两种模式都不写', async () => {
    const report = await ensureSearchIndex({ mode: 'apply' })

    expect(report).toEqual({
      created: false,
      missing: false,
      diffs: [],
      applied: [],
      patchCount: 14360,
      maxTotalHits: 20000
    })
    expect(updateSettingsMock).not.toHaveBeenCalled()
  })

  it('check 模式遇到索引不存在: 报 missing, 不建索引', async () => {
    getRawInfoMock.mockRejectedValue(meiliApiError(404, 'index_not_found'))

    const report = await ensureSearchIndex({ mode: 'check' })

    expect(report).toMatchObject({ missing: true, created: false, diffs: [] })
    expect(createIndexMock).not.toHaveBeenCalled()
    expect(updateSettingsMock).not.toHaveBeenCalled()
  })

  it('apply 模式遇到索引不存在: 以主键 id 建索引, 不分阶段时下发全部差异', async () => {
    getRawInfoMock
      .mockRejectedValueOnce(meiliApiError(404, 'index_not_found'))
      .mockResolvedValueOnce({ uid: 'galgame', primaryKey: 'id' })
    getSettingsMock.mockResolvedValue(structuredClone(FRESH_V1_15_2_SETTINGS))

    const report = await ensureSearchIndex({ mode: 'apply' })

    expect(createIndexMock).toHaveBeenCalledWith('galgame', {
      primaryKey: 'id'
    })
    expect(report).toMatchObject({ created: true, missing: false })
    expect(report?.applied).toEqual(report?.diffs)
    const pushed = updateSettingsMock.mock.calls[0][0]
    expect(Object.keys(pushed).sort()).toEqual(
      [
        'filterableAttributes',
        'localizedAttributes',
        'pagination',
        'searchableAttributes',
        'sortableAttributes',
        'stopWords',
        'typoTolerance'
      ].sort()
    )
  })

  it('建索引时撞上别人刚建好的 (index_already_exists): 照常核对主键与 settings', async () => {
    getRawInfoMock
      .mockRejectedValueOnce(meiliApiError(404, 'index_not_found'))
      .mockResolvedValueOnce({ uid: 'galgame', primaryKey: 'id' })
    createIndexMock.mockImplementation(() =>
      enqueued({
        uid: 2,
        status: 'failed',
        error: { code: 'index_already_exists' }
      })
    )

    const report = await ensureSearchIndex({ mode: 'apply' })

    expect(report).toMatchObject({ created: false, missing: false })
  })

  describe('pre / post 两阶段', () => {
    // 一条 expand (sortable 补字段)、一条 change (typoTolerance)、一条 contract (filterable 多字段)
    beforeEach(() => {
      getSettingsMock.mockResolvedValue(
        actualWith({
          sortableAttributes: SORTABLE_BEFORE_AF42C4AD,
          typoTolerance: {
            ...LOCAL_V1_15_2_SETTINGS.typoTolerance,
            minWordSizeForTypos: { oneTypo: 5, twoTypos: 9 }
          },
          filterableAttributes: [
            ...(LOCAL_V1_15_2_SETTINGS.filterableAttributes ?? []),
            'banner'
          ]
        })
      )
    })

    it('pre 只下发 expand 与 change, 载荷只含这些键且取代码里的值', async () => {
      const report = await ensureSearchIndex({ mode: 'apply', phase: 'pre' })

      expect(report?.diffs).toHaveLength(3)
      expect(appliedKeys(report)).toEqual([
        'sortableAttributes',
        'typoTolerance'
      ])
      expect(updateSettingsMock).toHaveBeenCalledTimes(1)
      expect(updateSettingsMock).toHaveBeenCalledWith({
        sortableAttributes: GALGAME_INDEX_SETTINGS.sortableAttributes,
        typoTolerance: GALGAME_INDEX_SETTINGS.typoTolerance
      })
    })

    it('post 只下发 contract', async () => {
      const report = await ensureSearchIndex({ mode: 'apply', phase: 'post' })

      expect(appliedKeys(report)).toEqual(['filterableAttributes'])
      expect(updateSettingsMock).toHaveBeenCalledWith({
        filterableAttributes: GALGAME_INDEX_SETTINGS.filterableAttributes
      })
    })

    it('check 只报告差异, 不写', async () => {
      const report = await ensureSearchIndex({ mode: 'check' })

      expect(report?.diffs).toHaveLength(3)
      expect(report?.applied).toEqual([])
      expect(updateSettingsMock).not.toHaveBeenCalled()
    })

    it('本阶段没有可下发的差异时不发请求', async () => {
      getSettingsMock.mockResolvedValue(
        actualWith({
          filterableAttributes: [
            ...(LOCAL_V1_15_2_SETTINGS.filterableAttributes ?? []),
            'banner'
          ]
        })
      )

      const report = await ensureSearchIndex({ mode: 'apply', phase: 'pre' })

      expect(report?.applied).toEqual([])
      expect(updateSettingsMock).not.toHaveBeenCalled()
    })
  })

  it('settings 任务没有成功: 抛错', async () => {
    getSettingsMock.mockResolvedValue(
      actualWith({ sortableAttributes: SORTABLE_BEFORE_AF42C4AD })
    )
    updateSettingsMock.mockImplementation(() =>
      enqueued({
        uid: 9,
        status: 'failed',
        error: { code: 'invalid_settings_sortable_attributes' }
      })
    )

    await expect(ensureSearchIndex({ mode: 'apply' })).rejects.toThrow(
      'settings 下发失败 (任务 9, failed)'
    )
  })

  it('主键不是 id: 抛错, 不读也不写 settings', async () => {
    getRawInfoMock.mockResolvedValue({
      uid: 'galgame',
      primaryKey: 'uniqueId'
    })

    await expect(ensureSearchIndex({ mode: 'apply' })).rejects.toThrow(
      '主键是 uniqueId'
    )
    expect(getSettingsMock).not.toHaveBeenCalled()
    expect(updateSettingsMock).not.toHaveBeenCalled()
  })

  it('没有主键的空索引: apply 补成 id 后继续, check 抛错', async () => {
    getRawInfoMock.mockResolvedValue({ uid: 'galgame', primaryKey: null })

    await expect(ensureSearchIndex({ mode: 'check' })).rejects.toThrow(
      '没有主键'
    )
    expect(updateIndexMock).not.toHaveBeenCalled()

    await expect(ensureSearchIndex({ mode: 'apply' })).resolves.toMatchObject({
      diffs: []
    })
    expect(updateIndexMock).toHaveBeenCalledWith('galgame', {
      primaryKey: 'id'
    })
  })

  it('空索引 (刚建的、刚补上主键的) 不分阶段: --phase post 也下发全部差异', async () => {
    getSettingsMock.mockResolvedValue(structuredClone(FRESH_V1_15_2_SETTINGS))
    getRawInfoMock
      .mockRejectedValueOnce(meiliApiError(404, 'index_not_found'))
      .mockResolvedValueOnce({ uid: 'galgame', primaryKey: 'id' })

    const created = await ensureSearchIndex({ mode: 'apply', phase: 'post' })

    expect(created?.created).toBe(true)
    expect(created?.diffs).toHaveLength(7)
    expect(created?.applied).toEqual(created?.diffs)

    getRawInfoMock.mockResolvedValue({ uid: 'galgame', primaryKey: null })

    const repaired = await ensureSearchIndex({ mode: 'apply', phase: 'post' })

    expect(repaired?.created).toBe(false)
    expect(repaired?.applied).toEqual(repaired?.diffs)
    expect(repaired?.applied).toHaveLength(7)
  })

  it('读索引时 Meilisearch 不可用: 原样抛出, 不当成索引不存在', async () => {
    getRawInfoMock.mockRejectedValue(meiliDown())

    await expect(ensureSearchIndex({ mode: 'apply' })).rejects.toMatchObject({
      name: 'MeilisearchRequestError'
    })
    expect(createIndexMock).not.toHaveBeenCalled()
  })

  it('patch 条数逼近 maxTotalHits: 90% 起 warn, 达到上限 error, 都不抛错', async () => {
    const { KUN_LOG_EVENTS } =
      await vi.importActual<typeof import('~/lib/log.server')>(
        '~/lib/log.server'
      )
    expect(KUN_LOG_EVENTS['search.total_hits_near_limit'].level).toBe('warn')
    expect(KUN_LOG_EVENTS['search.total_hits_exceeded'].level).toBe('error')

    patchCountMock.mockResolvedValue(17999)
    await ensureSearchIndex({ mode: 'check' })
    expect(kunLog).not.toHaveBeenCalled()

    patchCountMock.mockResolvedValue(18000)
    await expect(ensureSearchIndex({ mode: 'check' })).resolves.toMatchObject({
      patchCount: 18000
    })
    expect(kunLog).toHaveBeenCalledExactlyOnceWith(
      'search.total_hits_near_limit',
      { patchCount: 18000, maxTotalHits: 20000 }
    )

    vi.mocked(kunLog).mockClear()
    patchCountMock.mockResolvedValue(20000)
    await expect(ensureSearchIndex({ mode: 'check' })).resolves.toMatchObject({
      patchCount: 20000
    })
    expect(kunLog).toHaveBeenCalledExactlyOnceWith(
      'search.total_hits_exceeded',
      { patchCount: 20000, maxTotalHits: 20000 }
    )
  })
})
