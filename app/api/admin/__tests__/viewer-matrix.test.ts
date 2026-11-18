import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALL,
  NSFW_ONLY,
  SFW,
  V,
  getRequest,
  interactions,
  readJson,
  record,
  resetMatrix,
  type MatrixViewer,
  type PrismaCall
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
  'next/headers',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).nextHeadersModule
)
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: (await import('~/server/viewer/__tests__/viewerMatrix')).memoCache
}))

import { GET as galgameGET } from '~/app/api/admin/galgame/route'
import { GET as resourceGET } from '~/app/api/admin/resource/route'
import { GET as resourceApplyGET } from '~/app/api/admin/resource-apply/route'
import { kunGetActions as galgameLoader } from '~/app/admin/galgame/actions'
import { kunGetActions as resourceLoader } from '~/app/admin/resource/actions'
import { kunGetActions as resourceApplyLoader } from '~/app/admin/resource-apply/actions'

interface Denials {
  anonymous: string
  notSuperAdmin: string
}

interface AdminEndpoint {
  name: string
  route: (viewer: MatrixViewer) => Promise<unknown>
  loader: () => Promise<unknown>
  routeDenials: Denials
  // 后台列表只按 NSFW 设置过滤 patch, 不套用屏蔽标签
  queries: (nsfw: object) => PrismaCall[]
  emptyResult: unknown
}

// 三个后台 loader 共用 parseSuperAdminAction 的文案
const LOADER_DENIALS: Denials = {
  anonymous: '用户登录失效',
  notSuperAdmin: '本页面仅超级管理员可访问'
}

const endpoints: AdminEndpoint[] = [
  {
    name: 'admin/galgame',
    route: async (viewer) =>
      readJson(
        await galgameGET(
          getRequest('/api/admin/galgame?page=1&limit=24', viewer)
        )
      ),
    loader: () => galgameLoader({ page: 1, limit: 24 }),
    routeDenials: {
      anonymous: '用户未登录',
      notSuperAdmin: '本页面仅超级管理员可访问'
    },
    queries: (nsfw) => [
      { call: 'patch.findMany', where: nsfw },
      { call: 'patch.count', where: nsfw }
    ],
    emptyResult: { galgames: [], total: 0 }
  },
  {
    name: 'admin/resource',
    route: async (viewer) =>
      readJson(
        await resourceGET(
          getRequest('/api/admin/resource?page=1&limit=24', viewer)
        )
      ),
    // 与页面一致显式带 searchType (路由侧由 schema 默认值补成 'content')
    loader: () => resourceLoader({ page: 1, limit: 24, searchType: 'content' }),
    routeDenials: {
      anonymous: '用户未登录',
      notSuperAdmin: '本页面仅超级管理员可访问'
    },
    queries: (nsfw) => [
      { call: 'patch_resource.findMany', where: { patch: nsfw } },
      { call: 'patch_resource.count', where: { patch: nsfw } }
    ],
    emptyResult: { resources: [], total: 0 }
  },
  {
    name: 'admin/resource-apply',
    route: async (viewer) =>
      readJson(
        await resourceApplyGET(
          getRequest('/api/admin/resource-apply?page=1&limit=24', viewer)
        )
      ),
    loader: () => resourceApplyLoader({ page: 1, limit: 24 }),
    // 该路由的拒绝文案与另外两个后台路由不同
    routeDenials: {
      anonymous: '未登录',
      notSuperAdmin: '仅超级管理员可访问'
    },
    queries: (nsfw) => [
      { call: 'patch_resource.findMany', where: { patch: nsfw, status: 2 } },
      { call: 'patch_resource.count', where: { patch: nsfw, status: 2 } }
    ],
    emptyResult: { resources: [], total: 0 }
  }
]

const viaRoute = (endpoint: AdminEndpoint, viewer: MatrixViewer) =>
  record(viewer, () => endpoint.route(viewer))

const viaLoader = (endpoint: AdminEndpoint, viewer: MatrixViewer) =>
  record(viewer, () => endpoint.loader())

const NO_INTERACTIONS = { prisma: [], redis: [], meili: [] }

// 未登录 (含伪造 cookie / 失效 token)
const anonymousViewers = [V.guest, V.guestForged, V.staleToken]
// 已登录但不是超管 (role 1 / 2 / 3)
const notSuperAdminViewers = [V.userSfw, V.pendingAuthor, V.admin]

interface SuperAdminRow {
  viewer: MatrixViewer
  nsfw: object
}

const superAdminRows: SuperAdminRow[] = [
  { viewer: V.superAdminSfw, nsfw: SFW },
  { viewer: V.superAdminNsfw, nsfw: NSFW_ONLY },
  { viewer: V.superAdminAll, nsfw: ALL },
  // 镜像 [7,8] 不进后台列表: where 里没有 NOT
  { viewer: V.superAdminBlocker, nsfw: ALL }
]

beforeEach(() => {
  resetMatrix()
})

describe.each(endpoints)('后台列表 $name 视角矩阵', (endpoint) => {
  describe('角色闸门: 路由与 loader 文案分歧', () => {
    it.each(anonymousViewers)('route: $name 未登录被拒', async (viewer) => {
      const recording = await viaRoute(endpoint, viewer)

      expect(recording.result).toBe(endpoint.routeDenials.anonymous)
      expect(interactions(recording)).toEqual(NO_INTERACTIONS)
    })

    it.each(anonymousViewers)('loader: $name 未登录被拒', async (viewer) => {
      const recording = await viaLoader(endpoint, viewer)

      expect(recording.result).toBe(LOADER_DENIALS.anonymous)
      expect(interactions(recording)).toEqual(NO_INTERACTIONS)
    })

    it.each(notSuperAdminViewers)('route: $name 非超管被拒', async (viewer) => {
      const recording = await viaRoute(endpoint, viewer)

      expect(recording.result).toBe(endpoint.routeDenials.notSuperAdmin)
      expect(interactions(recording)).toEqual(NO_INTERACTIONS)
    })

    it.each(notSuperAdminViewers)(
      'loader: $name 非超管被拒',
      async (viewer) => {
        const recording = await viaLoader(endpoint, viewer)

        expect(recording.result).toBe(LOADER_DENIALS.notSuperAdmin)
        expect(interactions(recording)).toEqual(NO_INTERACTIONS)
      }
    )
  })

  it.each(superAdminRows)('route: $viewer.name', async (row) => {
    const recording = await viaRoute(endpoint, row.viewer)

    expect(recording.prisma).toEqual(endpoint.queries(row.nsfw))
    expect(recording.redis).toEqual([])
    expect(recording.result).toEqual(endpoint.emptyResult)
  })

  it.each(superAdminRows)('loader: $viewer.name', async (row) => {
    const recording = await viaLoader(endpoint, row.viewer)

    expect(recording.prisma).toEqual(endpoint.queries(row.nsfw))
    expect(recording.redis).toEqual([])
    expect(recording.result).toEqual(endpoint.emptyResult)
  })

  it.each(superAdminRows)('route ≡ loader: $viewer.name', async (row) => {
    const route = await viaRoute(endpoint, row.viewer)
    const loader = await viaLoader(endpoint, row.viewer)

    expect(interactions(loader)).toEqual(interactions(route))
    expect(loader.result).toEqual(route.result)
  })
})
