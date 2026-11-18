import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALL,
  NSFW_ONLY,
  SFW,
  SFW_BLOCK_10_20,
  SFW_BLOCK_7_8,
  V,
  interactions,
  matrixState,
  postRequest,
  readJson,
  record,
  resetMatrix,
  type MatrixViewer
} from '~/server/viewer/__tests__/viewerMatrix'

vi.mock(
  '~/app/api/utils/jwt',
  async () => (await import('~/server/viewer/__tests__/viewerMatrix')).jwtModule
)
vi.mock(
  '~/lib/redis',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).redisModule
)
vi.mock(
  '~/prisma/index',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).prismaModule
)
vi.mock(
  '~/prisma',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).prismaModule
)
vi.mock(
  '~/app/api/utils/pendingResourceCache',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix'))
      .pendingResourceModule
)
vi.mock(
  '~/lib/meilisearch',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).meiliModule
)
vi.mock(
  '~/server/search/query',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).searchQueryModule
)
vi.mock(
  '~/server/search/resolve',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).searchResolveModule
)
vi.mock(
  'next/headers',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).nextHeadersModule
)
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: (await import('~/server/viewer/__tests__/viewerMatrix')).memoCache
}))

import { POST } from '~/app/api/search/route'

// 单个普通关键词 (不是 vndb / dlsite 精确 ID), 其余筛选全为默认
const BODY = {
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

const EMPTY_LIST = { galgames: [], total: 0 }

// 三个检索选项都关闭时 buildKeywordCondition('kun') 的输出
const KEYWORD_KUN = {
  OR: [
    { name: { contains: 'kun', mode: 'insensitive' } },
    { vndb_id: 'kun' },
    { vndb_relation_id: 'kun' },
    { dlsite_code: 'kun' }
  ]
}

// Prisma 降级路径: 可见性 where 出现两次 —— 一次作为 AND 数组的一项,
// 一次经 buildGalgameWhere 展开在顶层 (年月 all、minRatingCount 0 不加其他条件)
const prismaQueries = (patch: object) => {
  const where = { AND: [KEYWORD_KUN, patch], ...patch }
  return [
    { call: 'patch.findMany', where },
    { call: 'patch.count', where }
  ]
}

interface SearchRow {
  viewer: MatrixViewer
  patch: object
  filter: string
}

// 搜索不读写任何缓存, 也没有「个人视角」
const rows: SearchRow[] = [
  { viewer: V.guest, patch: SFW, filter: 'contentLimit = "sfw"' },
  { viewer: V.guestForged, patch: SFW, filter: 'contentLimit = "sfw"' },
  { viewer: V.staleToken, patch: SFW, filter: 'contentLimit = "sfw"' },
  { viewer: V.userSfw, patch: SFW, filter: 'contentLimit = "sfw"' },
  // 全部可见时没有任何子句, 传给 Meilisearch 的是空串
  { viewer: V.userAll, patch: ALL, filter: '' },
  { viewer: V.userNsfw, patch: NSFW_ONLY, filter: 'contentLimit = "nsfw"' },
  {
    viewer: V.blockerMirror,
    patch: SFW_BLOCK_7_8,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [7, 8]'
  },
  {
    viewer: V.blockerDb,
    patch: SFW_BLOCK_10_20,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [10, 20]'
  },
  {
    viewer: V.blockerBadEscape,
    patch: SFW_BLOCK_10_20,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [10, 20]'
  },
  {
    viewer: V.blockerBadJson,
    patch: SFW_BLOCK_10_20,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [10, 20]'
  },
  { viewer: V.emptyMirror, patch: SFW, filter: 'contentLimit = "sfw"' },
  { viewer: V.pendingAuthor, patch: SFW, filter: 'contentLimit = "sfw"' },
  { viewer: V.admin, patch: SFW, filter: 'contentLimit = "sfw"' },
  {
    viewer: V.adminBlocker,
    patch: SFW_BLOCK_7_8,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [7, 8]'
  }
]

const viaRoute = (viewer: MatrixViewer) =>
  record(viewer, async () =>
    readJson(await POST(postRequest('/api/search', viewer, BODY)))
  )

beforeEach(() => {
  resetMatrix()
})

describe('/api/search POST 视角矩阵 (Meilisearch 关闭)', () => {
  it.each(rows)('route: $viewer.name', async (row) => {
    const recording = await viaRoute(row.viewer)

    expect(interactions(recording)).toEqual({
      prisma: prismaQueries(row.patch),
      redis: [],
      meili: []
    })
    expect(recording.result).toEqual(EMPTY_LIST)
  })
})

describe('/api/search POST 视角矩阵 (Meilisearch 开启)', () => {
  beforeEach(() => {
    matrixState.meiliEnabled = true
  })

  it.each(rows)('route: $viewer.name', async (row) => {
    const recording = await viaRoute(row.viewer)

    expect(interactions(recording)).toEqual({
      prisma: [],
      redis: [],
      meili: [{ filter: row.filter }]
    })
    expect(recording.result).toEqual(EMPTY_LIST)
  })
})
