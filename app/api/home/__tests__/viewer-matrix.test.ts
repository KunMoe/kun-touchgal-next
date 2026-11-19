import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_STATUS,
  ALL,
  NSFW_ONLY,
  PUBLIC_STATUS,
  SFW,
  SFW_BLOCK_10_20,
  SFW_BLOCK_7_8,
  V,
  getRequest,
  interactions,
  matrixState,
  ownStatus,
  readJson,
  record,
  resetMatrix,
  sharedMissTrace,
  type MatrixViewer,
  type RedisCall
} from '~/server/viewer/__tests__/viewerMatrix'

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
  'next/headers',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).nextHeadersModule
)
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: (await import('~/server/viewer/__tests__/viewerMatrix')).memoCache
}))

import { GET } from '~/app/api/home/route'
import { kunGetActions } from '~/app/actions'

// 键 = 'home:v2:' + sha1(<contentLimit ?? 'all'>:<屏蔽标签>).hex.slice(0, 16)
const HOME_SFW_KEY = 'home:v2:c01ede773657b5e2' // sha1('sfw:')
const HOME_ALL_KEY = 'home:v2:69fdeab2a1c8368d' // sha1('all:')
const HOME_NSFW_KEY = 'home:v2:1f035bb8804256f0' // sha1('nsfw:')
const HOME_TTL = 60

const homeQueries = (patch: object, status: object) => [
  { call: 'patch.findMany', where: patch },
  {
    call: 'patch_resource.findMany',
    where: { patch, section: 'patch', ...status }
  }
]

interface HomeRow {
  viewer: MatrixViewer
  patch: object
  status: object
  redis: RedisCall[]
}

// 共享视角: 按公开基线 status 0 查询并读写共享键;
// 屏蔽视角 (filtered): status 0, 完全不碰 Redis;
// 个人视角 (管理员 / 有待审资源的作者): 带 viewer 的 status, 完全不碰 Redis
const rows: HomeRow[] = [
  {
    viewer: V.guest,
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedMissTrace(HOME_SFW_KEY, HOME_TTL)
  },
  {
    viewer: V.guestForged,
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedMissTrace(HOME_SFW_KEY, HOME_TTL)
  },
  {
    viewer: V.staleToken,
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedMissTrace(HOME_SFW_KEY, HOME_TTL)
  },
  {
    viewer: V.userSfw,
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedMissTrace(HOME_SFW_KEY, HOME_TTL)
  },
  {
    viewer: V.userAll,
    patch: ALL,
    status: PUBLIC_STATUS,
    redis: sharedMissTrace(HOME_ALL_KEY, HOME_TTL)
  },
  {
    viewer: V.userNsfw,
    patch: NSFW_ONLY,
    status: PUBLIC_STATUS,
    redis: sharedMissTrace(HOME_NSFW_KEY, HOME_TTL)
  },
  {
    viewer: V.blockerMirror,
    patch: SFW_BLOCK_10_20,
    status: PUBLIC_STATUS,
    redis: []
  },
  {
    viewer: V.blockerDb,
    patch: SFW_BLOCK_10_20,
    status: PUBLIC_STATUS,
    redis: []
  },
  {
    viewer: V.blockerBadEscape,
    patch: SFW_BLOCK_10_20,
    status: PUBLIC_STATUS,
    redis: []
  },
  {
    viewer: V.blockerBadJson,
    patch: SFW_BLOCK_10_20,
    status: PUBLIC_STATUS,
    redis: []
  },
  {
    viewer: V.mirrorOnly,
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedMissTrace(HOME_SFW_KEY, HOME_TTL)
  },
  {
    viewer: V.pendingAuthor,
    patch: SFW,
    status: ownStatus(31),
    redis: []
  },
  { viewer: V.admin, patch: SFW, status: ADMIN_STATUS, redis: [] },
  {
    viewer: V.adminBlocker,
    patch: SFW_BLOCK_7_8,
    status: ADMIN_STATUS,
    redis: []
  }
]

const viaRoute = (viewer: MatrixViewer) =>
  record(viewer, async () =>
    readJson(await GET(getRequest('/api/home', viewer)))
  )

const viaLoader = (viewer: MatrixViewer) =>
  record(viewer, () => kunGetActions())

beforeEach(() => {
  resetMatrix()
})

describe('首页 /api/home ↔ app/actions.ts kunGetActions 视角矩阵', () => {
  it.each(rows)('route: $viewer.name', async (row) => {
    const recording = await viaRoute(row.viewer)

    expect(recording.prisma).toEqual(homeQueries(row.patch, row.status))
    expect(recording.redis).toEqual(row.redis)
    expect(recording.result).toEqual({ galgames: [], resources: [] })
  })

  it.each(rows)('loader: $viewer.name', async (row) => {
    const recording = await viaLoader(row.viewer)

    expect(recording.prisma).toEqual(homeQueries(row.patch, row.status))
    expect(recording.redis).toEqual(row.redis)
    expect(recording.result).toEqual({ galgames: [], resources: [] })
  })

  it.each(rows)('route ≡ loader: $viewer.name', async (row) => {
    const route = await viaRoute(row.viewer)
    const loader = await viaLoader(row.viewer)

    expect(interactions(loader)).toEqual(interactions(route))
    expect(loader.result).toEqual(route.result)
  })

  it('共享键命中时直接返回缓存, 不查库', async () => {
    const cached = { galgames: [], resources: [{ id: 1 }] }
    // 预置的是公开 sfw 视角的键: 游客与普通 sfw 用户读到同一份
    const seed = { [HOME_SFW_KEY]: JSON.stringify(cached) }

    for (const viewer of [V.guest, V.userSfw]) {
      resetMatrix()
      matrixState.redisSeed = seed
      const route = await viaRoute(viewer)
      expect(route.result).toEqual(cached)
      expect(route.prisma).toEqual([])
      expect(route.redis).toEqual([['getKv', HOME_SFW_KEY]])

      const loader = await viaLoader(viewer)
      expect(loader.result).toEqual(cached)
      expect(interactions(loader)).toEqual(interactions(route))
    }
  })
})
