import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALL,
  NSFW_ONLY,
  SFW,
  SFW_BLOCK_10_20,
  SFW_BLOCK_7_8,
  V,
  getRequest,
  interactions,
  matrixState,
  readJson,
  record,
  resetMatrix,
  sharedMissTrace,
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
  'next/headers',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).nextHeadersModule
)
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: (await import('~/server/viewer/__tests__/viewerMatrix')).memoCache
}))

import { GET } from '~/app/api/galgame/route'
import { kunGetActions } from '~/app/galgame/actions'

// 键 = 'galgame:list:' + sha1([type, language, platform, sortField, sortOrder,
// page, limit, minRatingCount, years, months, <contentLimit ?? 'all'>:<屏蔽标签>]
// .join('|')).hex.slice(0, 16); 本文件的输入为
// 'all|all|all|resource_update_time|desc|1|24|10|all|all|<视角>'
const GALGAME_SFW_KEY = 'galgame:list:91942a430dddc404' // 视角 'sfw:'
const GALGAME_ALL_KEY = 'galgame:list:7aa0dac0e764737b' // 视角 'all:'
const GALGAME_NSFW_KEY = 'galgame:list:59e6fc715f34d6f9' // 视角 'nsfw:'
const GALGAME_TTL = 60

const QUERY =
  '/api/galgame?sortField=resource_update_time&sortOrder=desc&page=1&limit=24'

// 与 QUERY 经 galgameSchema 补默认值后的结果逐项相同
const LOADER_PARAMS: Parameters<typeof kunGetActions>[0] = {
  selectedType: 'all',
  selectedLanguage: 'all',
  selectedPlatform: 'all',
  sortField: 'resource_update_time',
  sortOrder: 'desc',
  page: 1,
  limit: 24,
  yearString: '["all"]',
  monthString: '["all"]',
  minRatingCount: 10
}

const EMPTY_LIST = { galgames: [], total: 0 }

// Prisma 降级路径: 年月为 all 不加日期条件; 列表端点的 minRatingCount 恒生效
const prismaQueries = (patch: object) => {
  const where = { rating_stat: { count: { gte: 10 } }, ...patch }
  return [
    { call: 'patch.findMany', where },
    { call: 'patch.count', where }
  ]
}

interface GalgameRow {
  viewer: MatrixViewer
  patch: object
  filter: string
  // null = 带屏蔽标签, 不进共享缓存, 完全不碰 Redis
  key: string | null
}

// galgame 列表没有「个人视角」: 管理员与有待审资源的作者照常读写共享键
const rows: GalgameRow[] = [
  {
    viewer: V.guest,
    patch: SFW,
    filter: 'ratingCount >= 10 AND contentLimit = "sfw"',
    key: GALGAME_SFW_KEY
  },
  {
    viewer: V.guestForged,
    patch: SFW,
    filter: 'ratingCount >= 10 AND contentLimit = "sfw"',
    key: GALGAME_SFW_KEY
  },
  {
    viewer: V.staleToken,
    patch: SFW,
    filter: 'ratingCount >= 10 AND contentLimit = "sfw"',
    key: GALGAME_SFW_KEY
  },
  {
    viewer: V.userSfw,
    patch: SFW,
    filter: 'ratingCount >= 10 AND contentLimit = "sfw"',
    key: GALGAME_SFW_KEY
  },
  {
    viewer: V.userAll,
    patch: ALL,
    filter: 'ratingCount >= 10',
    key: GALGAME_ALL_KEY
  },
  {
    viewer: V.userNsfw,
    patch: NSFW_ONLY,
    filter: 'ratingCount >= 10 AND contentLimit = "nsfw"',
    key: GALGAME_NSFW_KEY
  },
  {
    viewer: V.blockerMirror,
    patch: SFW_BLOCK_10_20,
    filter:
      'ratingCount >= 10 AND contentLimit = "sfw" AND NOT tagIds IN [10, 20]',
    key: null
  },
  {
    viewer: V.blockerDb,
    patch: SFW_BLOCK_10_20,
    filter:
      'ratingCount >= 10 AND contentLimit = "sfw" AND NOT tagIds IN [10, 20]',
    key: null
  },
  {
    viewer: V.blockerBadEscape,
    patch: SFW_BLOCK_10_20,
    filter:
      'ratingCount >= 10 AND contentLimit = "sfw" AND NOT tagIds IN [10, 20]',
    key: null
  },
  {
    viewer: V.blockerBadJson,
    patch: SFW_BLOCK_10_20,
    filter:
      'ratingCount >= 10 AND contentLimit = "sfw" AND NOT tagIds IN [10, 20]',
    key: null
  },
  {
    viewer: V.mirrorOnly,
    patch: SFW,
    filter: 'ratingCount >= 10 AND contentLimit = "sfw"',
    key: GALGAME_SFW_KEY
  },
  {
    viewer: V.pendingAuthor,
    patch: SFW,
    filter: 'ratingCount >= 10 AND contentLimit = "sfw"',
    key: GALGAME_SFW_KEY
  },
  {
    viewer: V.admin,
    patch: SFW,
    filter: 'ratingCount >= 10 AND contentLimit = "sfw"',
    key: GALGAME_SFW_KEY
  },
  {
    viewer: V.adminBlocker,
    patch: SFW_BLOCK_7_8,
    filter:
      'ratingCount >= 10 AND contentLimit = "sfw" AND NOT tagIds IN [7, 8]',
    key: null
  }
]

const expectedRedis = (row: GalgameRow) =>
  row.key ? sharedMissTrace(row.key, GALGAME_TTL) : []

const viaRoute = (viewer: MatrixViewer) =>
  record(viewer, async () => readJson(await GET(getRequest(QUERY, viewer))))

const viaLoader = (viewer: MatrixViewer) =>
  record(viewer, () => kunGetActions(LOADER_PARAMS))

beforeEach(() => {
  resetMatrix()
})

describe('/api/galgame ↔ app/galgame/actions.ts kunGetActions (Meilisearch 关闭)', () => {
  it.each(rows)('route: $viewer.name', async (row) => {
    const recording = await viaRoute(row.viewer)

    expect(recording.prisma).toEqual(prismaQueries(row.patch))
    expect(recording.redis).toEqual(expectedRedis(row))
    expect(recording.meili).toEqual([])
    expect(recording.result).toEqual(EMPTY_LIST)
  })

  it.each(rows)('loader: $viewer.name', async (row) => {
    const recording = await viaLoader(row.viewer)

    expect(recording.prisma).toEqual(prismaQueries(row.patch))
    expect(recording.redis).toEqual(expectedRedis(row))
    expect(recording.meili).toEqual([])
    expect(recording.result).toEqual(EMPTY_LIST)
  })

  it.each(rows)('route ≡ loader: $viewer.name', async (row) => {
    const route = await viaRoute(row.viewer)
    const loader = await viaLoader(row.viewer)

    expect(interactions(loader)).toEqual(interactions(route))
    expect(loader.result).toEqual(route.result)
  })
})

describe('/api/galgame ↔ app/galgame/actions.ts kunGetActions (Meilisearch 开启)', () => {
  beforeEach(() => {
    matrixState.meiliEnabled = true
  })

  // 缓存键与后端无关: 与 Prisma 路径完全相同
  it.each(rows)('route: $viewer.name', async (row) => {
    const recording = await viaRoute(row.viewer)

    expect(recording.prisma).toEqual([])
    expect(recording.meili).toEqual([{ filter: row.filter }])
    expect(recording.redis).toEqual(expectedRedis(row))
    expect(recording.result).toEqual(EMPTY_LIST)
  })

  it.each(rows)('loader: $viewer.name', async (row) => {
    const recording = await viaLoader(row.viewer)

    expect(recording.prisma).toEqual([])
    expect(recording.meili).toEqual([{ filter: row.filter }])
    expect(recording.redis).toEqual(expectedRedis(row))
    expect(recording.result).toEqual(EMPTY_LIST)
  })

  it.each(rows)('route ≡ loader: $viewer.name', async (row) => {
    const route = await viaRoute(row.viewer)
    const loader = await viaLoader(row.viewer)

    expect(interactions(loader)).toEqual(interactions(route))
    expect(loader.result).toEqual(route.result)
  })
})
