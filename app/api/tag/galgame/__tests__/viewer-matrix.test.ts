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

const { TAG } = vi.hoisted(() => ({
  TAG: { id: 13, name: 'kun-tag', introduction: '', count: 1, alias: [] }
}))

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
// 标签详情读取与可见性无关, 固定返回同一个标签
vi.mock('~/app/api/tag/get', () => ({
  getTagById: async () => TAG
}))

import { GET } from '~/app/api/tag/galgame/route'
import { kunGetTagPageDataActions } from '~/app/tag/[id]/actions'

// 键 = 'galgame:list:tag:13:' + sha1([type, language, platform, sortField,
// sortOrder, page, limit, minRatingCount, years, months,
// <contentLimit ?? 'all'>:<屏蔽标签>].join('|')).hex.slice(0, 16);
// 非 rating 排序 minRatingCount 归一化为 0, 本文件的输入为
// 'all|all|all|resource_update_time|desc|1|24|0|all|all|<视角>'
const TAG_SFW_KEY = 'galgame:list:tag:13:b8972ca2e1d2a853' // 视角 'sfw:'
const TAG_ALL_KEY = 'galgame:list:tag:13:caf5879b9412587f' // 视角 'all:'
const TAG_NSFW_KEY = 'galgame:list:tag:13:120b2ceb02255f7b' // 视角 'nsfw:'
const GALGAME_TTL = 60

const QUERY =
  '/api/tag/galgame?tagId=13&sortField=resource_update_time&sortOrder=desc&page=1&limit=24'

// 与 QUERY 经 getPatchByTagSchema 补默认值后的结果逐项相同
const LOADER_PARAMS: Parameters<typeof kunGetTagPageDataActions>[0] = {
  tagId: 13,
  selectedType: 'all',
  selectedLanguage: 'all',
  selectedPlatform: 'all',
  sortField: 'resource_update_time',
  sortOrder: 'desc',
  page: 1,
  limit: 24,
  yearString: '["all"]',
  monthString: '["all"]',
  minRatingCount: 0
}

const EMPTY_LIST = { galgames: [], total: 0 }

// Prisma 降级路径: 年月为 all、minRatingCount 0, patch 条件只剩可见性
const prismaQueries = (patch: object) => {
  const where = { tag_id: 13, patch }
  return [
    { call: 'patch_tag_relation.findMany', where },
    { call: 'patch_tag_relation.count', where }
  ]
}

interface TagRow {
  viewer: MatrixViewer
  patch: object
  filter: string
  // null = 带屏蔽标签, 不进共享缓存, 完全不碰 Redis
  key: string | null
}

// 未登录的三种视角: route 按 sfw 游客服务, loader 直接返回 null
const anonymousRows: TagRow[] = [
  {
    viewer: V.guest,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND tagIds = 13',
    key: TAG_SFW_KEY
  },
  {
    viewer: V.guestForged,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND tagIds = 13',
    key: TAG_SFW_KEY
  },
  {
    viewer: V.staleToken,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND tagIds = 13',
    key: TAG_SFW_KEY
  }
]

// 登录视角; 标签列表没有「个人视角」, 管理员与有待审资源的作者照常读写共享键
const loggedInRows: TagRow[] = [
  {
    viewer: V.userSfw,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND tagIds = 13',
    key: TAG_SFW_KEY
  },
  {
    viewer: V.userAll,
    patch: ALL,
    filter: 'tagIds = 13',
    key: TAG_ALL_KEY
  },
  {
    viewer: V.userNsfw,
    patch: NSFW_ONLY,
    filter: 'contentLimit = "nsfw" AND tagIds = 13',
    key: TAG_NSFW_KEY
  },
  {
    viewer: V.blockerMirror,
    patch: SFW_BLOCK_10_20,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [10, 20] AND tagIds = 13',
    key: null
  },
  {
    viewer: V.blockerDb,
    patch: SFW_BLOCK_10_20,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [10, 20] AND tagIds = 13',
    key: null
  },
  {
    viewer: V.blockerBadEscape,
    patch: SFW_BLOCK_10_20,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [10, 20] AND tagIds = 13',
    key: null
  },
  {
    viewer: V.blockerBadJson,
    patch: SFW_BLOCK_10_20,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [10, 20] AND tagIds = 13',
    key: null
  },
  {
    viewer: V.mirrorOnly,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND tagIds = 13',
    key: TAG_SFW_KEY
  },
  {
    viewer: V.pendingAuthor,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND tagIds = 13',
    key: TAG_SFW_KEY
  },
  {
    viewer: V.admin,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND tagIds = 13',
    key: TAG_SFW_KEY
  },
  {
    viewer: V.adminBlocker,
    patch: SFW_BLOCK_7_8,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [7, 8] AND tagIds = 13',
    key: null
  }
]

const allRows = [...anonymousRows, ...loggedInRows]

const expectedRedis = (row: TagRow) =>
  row.key ? sharedMissTrace(row.key, GALGAME_TTL) : []

const viaRoute = (viewer: MatrixViewer) =>
  record(viewer, async () => readJson(await GET(getRequest(QUERY, viewer))))

const viaLoader = (viewer: MatrixViewer) =>
  record(viewer, () => kunGetTagPageDataActions(LOADER_PARAMS))

const backends = [
  { backend: 'Meilisearch 关闭', meili: false },
  { backend: 'Meilisearch 开启', meili: true }
]

beforeEach(() => {
  resetMatrix()
})

describe.each(backends)(
  '/api/tag/galgame ↔ app/tag/[id]/actions.ts kunGetTagPageDataActions ($backend)',
  ({ meili }) => {
    beforeEach(() => {
      matrixState.meiliEnabled = meili
    })

    const expectedQueries = (row: TagRow) =>
      meili
        ? { prisma: [], meili: [{ filter: row.filter }] }
        : { prisma: prismaQueries(row.patch), meili: [] }

    it.each(allRows)('route: $viewer.name', async (row) => {
      const recording = await viaRoute(row.viewer)

      expect(interactions(recording)).toEqual({
        ...expectedQueries(row),
        redis: expectedRedis(row)
      })
      expect(recording.result).toEqual(EMPTY_LIST)
    })

    it.each(loggedInRows)('loader: $viewer.name', async (row) => {
      const recording = await viaLoader(row.viewer)

      expect(interactions(recording)).toEqual({
        ...expectedQueries(row),
        redis: expectedRedis(row)
      })
      expect(recording.result).toEqual({ tag: TAG, response: EMPTY_LIST })
    })

    it.each(loggedInRows)('route ≡ loader: $viewer.name', async (row) => {
      const route = await viaRoute(row.viewer)
      const loader = await viaLoader(row.viewer)

      expect(interactions(loader)).toEqual(interactions(route))
      expect(loader.result).toEqual({ tag: TAG, response: route.result })
    })

    // 今日两侧分歧: route 匿名可达 (按 sfw 游客视角), loader 要求登录,
    // 未登录直接返回 null 且不发生任何查询 / 缓存交互
    it.each(anonymousRows)(
      'route 与 loader 分歧 (loader 要求登录): $viewer.name',
      async (row) => {
        const route = await viaRoute(row.viewer)
        const loader = await viaLoader(row.viewer)

        expect(interactions(route)).toEqual({
          ...expectedQueries(row),
          redis: expectedRedis(row)
        })
        expect(route.result).toEqual(EMPTY_LIST)
        expect(loader.result).toBeNull()
        expect(interactions(loader)).toEqual({
          prisma: [],
          redis: [],
          meili: []
        })
      }
    )
  }
)
