import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALL,
  NSFW_ONLY,
  SFW,
  SFW_BLOCK_10_20,
  SFW_BLOCK_7_8,
  V,
  getRequest,
  hydrationQueries,
  interactions,
  matrixState,
  readJson,
  record,
  resetMatrix,
  sharedMissTrace,
  type MatrixViewer
} from '~/server/viewer/__tests__/viewerMatrix'

const { COMPANY } = vi.hoisted(() => ({
  COMPANY: { id: 8, name: 'kun-company', count: 1, alias: [] }
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
// 会社详情读取与可见性无关, 固定返回同一个会社
vi.mock('~/app/api/company/service', () => ({
  getCompanyById: async () => COMPANY
}))

import { GET } from '~/app/api/company/galgame/route'
import { kunGetCompanyPageDataActions } from '~/app/company/[id]/actions'

// 键 = 'galgame:list:company:8:' + sha1([type, language, platform, sortField,
// sortOrder, page, limit, minRatingCount, years, months,
// <contentLimit ?? 'all'>:<屏蔽标签>].join('|')).hex.slice(0, 16);
// 非 rating 排序 minRatingCount 归一化为 0, 本文件的输入为
// 'all|all|all|resource_update_time|desc|1|24|0|all|all|<视角>'
const COMPANY_SFW_KEY = 'galgame:list:company:8:b8972ca2e1d2a853' // 视角 'sfw:'
const COMPANY_ALL_KEY = 'galgame:list:company:8:caf5879b9412587f' // 视角 'all:'
const COMPANY_NSFW_KEY = 'galgame:list:company:8:120b2ceb02255f7b' // 视角 'nsfw:'
const GALGAME_TTL = 60

const QUERY =
  '/api/company/galgame?companyId=8&sortField=resource_update_time&sortOrder=desc&page=1&limit=24'

// 与 QUERY 经 getPatchByCompanySchema 补默认值后的结果逐项相同
const LOADER_PARAMS: Parameters<typeof kunGetCompanyPageDataActions>[0] = {
  companyId: 8,
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
const INDEX_HITS = [3, 1]

// Prisma 降级路径: 年月为 all、minRatingCount 0, 除会社关联外只剩可见性
const prismaQueries = (patch: object) => {
  const where = { company: { some: { company_id: 8 } }, ...patch }
  return [
    { call: 'patch.findMany', where },
    { call: 'patch.count', where }
  ]
}

interface CompanyRow {
  viewer: MatrixViewer
  patch: object
  filter: string
  // null = 带屏蔽标签, 不进共享缓存, 完全不碰 Redis
  key: string | null
}

// 会社 loader 不要求登录: 未登录视角两侧都按 sfw 游客服务
const rows: CompanyRow[] = [
  {
    viewer: V.guest,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND companyIds = 8',
    key: COMPANY_SFW_KEY
  },
  {
    viewer: V.guestForged,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND companyIds = 8',
    key: COMPANY_SFW_KEY
  },
  {
    viewer: V.staleToken,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND companyIds = 8',
    key: COMPANY_SFW_KEY
  },
  // 会社列表没有「个人视角」, 管理员与有待审资源的作者照常读写共享键
  {
    viewer: V.userSfw,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND companyIds = 8',
    key: COMPANY_SFW_KEY
  },
  {
    viewer: V.userAll,
    patch: ALL,
    filter: 'companyIds = 8',
    key: COMPANY_ALL_KEY
  },
  {
    viewer: V.userNsfw,
    patch: NSFW_ONLY,
    filter: 'contentLimit = "nsfw" AND companyIds = 8',
    key: COMPANY_NSFW_KEY
  },
  {
    viewer: V.blockerMirror,
    patch: SFW_BLOCK_10_20,
    filter:
      'contentLimit = "sfw" AND NOT tagIds IN [10, 20] AND companyIds = 8',
    key: null
  },
  {
    viewer: V.blockerDb,
    patch: SFW_BLOCK_10_20,
    filter:
      'contentLimit = "sfw" AND NOT tagIds IN [10, 20] AND companyIds = 8',
    key: null
  },
  {
    viewer: V.blockerBadEscape,
    patch: SFW_BLOCK_10_20,
    filter:
      'contentLimit = "sfw" AND NOT tagIds IN [10, 20] AND companyIds = 8',
    key: null
  },
  {
    viewer: V.blockerBadJson,
    patch: SFW_BLOCK_10_20,
    filter:
      'contentLimit = "sfw" AND NOT tagIds IN [10, 20] AND companyIds = 8',
    key: null
  },
  {
    viewer: V.mirrorOnly,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND companyIds = 8',
    key: COMPANY_SFW_KEY
  },
  {
    viewer: V.pendingAuthor,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND companyIds = 8',
    key: COMPANY_SFW_KEY
  },
  {
    viewer: V.admin,
    patch: SFW,
    filter: 'contentLimit = "sfw" AND companyIds = 8',
    key: COMPANY_SFW_KEY
  },
  {
    viewer: V.adminBlocker,
    patch: SFW_BLOCK_7_8,
    filter: 'contentLimit = "sfw" AND NOT tagIds IN [7, 8] AND companyIds = 8',
    key: null
  }
]

const expectedRedis = (row: CompanyRow) =>
  row.key ? sharedMissTrace(row.key, GALGAME_TTL) : []

const viaRoute = (viewer: MatrixViewer) =>
  record(viewer, async () => readJson(await GET(getRequest(QUERY, viewer))))

const viaLoader = (viewer: MatrixViewer) =>
  record(viewer, () => kunGetCompanyPageDataActions(LOADER_PARAMS))

const backends = [
  { backend: 'Meilisearch 关闭', meili: false },
  { backend: 'Meilisearch 开启', meili: true }
]

beforeEach(() => {
  resetMatrix()
})

describe.each(backends)(
  '/api/company/galgame ↔ app/company/[id]/actions.ts kunGetCompanyPageDataActions ($backend)',
  ({ meili }) => {
    beforeEach(() => {
      matrixState.meiliEnabled = meili
    })

    const expectedQueries = (row: CompanyRow) =>
      meili
        ? { prisma: [], meili: [{ filter: row.filter }] }
        : { prisma: prismaQueries(row.patch), meili: [] }

    it.each(rows)('route: $viewer.name', async (row) => {
      const recording = await viaRoute(row.viewer)

      expect(interactions(recording)).toEqual({
        ...expectedQueries(row),
        redis: expectedRedis(row)
      })
      expect(recording.result).toEqual(EMPTY_LIST)
    })

    it.each(rows)('loader: $viewer.name', async (row) => {
      const recording = await viaLoader(row.viewer)

      expect(interactions(recording)).toEqual({
        ...expectedQueries(row),
        redis: expectedRedis(row)
      })
      expect(recording.result).toEqual({
        company: COMPANY,
        response: EMPTY_LIST
      })
    })

    it.each(rows)('route ≡ loader: $viewer.name', async (row) => {
      const route = await viaRoute(row.viewer)
      const loader = await viaLoader(row.viewer)

      expect(interactions(loader)).toEqual(interactions(route))
      expect(loader.result).toEqual({
        company: COMPANY,
        response: route.result
      })
    })

    // 索引只给 id: 卡片回 PG 取, 套的是同一个视角的可见性
    if (meili) {
      it.each(rows)('route, 索引有命中: $viewer.name', async (row) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        matrixState.meiliIds = INDEX_HITS

        const recording = await viaRoute(row.viewer)

        expect(interactions(recording)).toEqual({
          prisma: hydrationQueries(INDEX_HITS, row.patch),
          meili: [{ filter: row.filter }],
          redis: expectedRedis(row)
        })
      })
    }
  }
)
