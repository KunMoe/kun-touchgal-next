import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_STATUS,
  ALL,
  NSFW_ONLY,
  SFW,
  SFW_BLOCK_10_20,
  SFW_BLOCK_7_8,
  V,
  getRequest,
  interactions,
  ownStatus,
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
  'next/headers',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).nextHeadersModule
)
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: (await import('~/server/viewer/__tests__/viewerMatrix')).memoCache
}))

import { GET } from '~/app/api/user/profile/resource/route'
import { kunGetActions } from '~/app/user/[id]/resource/actions'

// 被查看的主页主人; 与所有视角的 uid 都不同
const PROFILE_UID = 55

const profileQueries = (patch: object, status: object) => {
  const where = { user_id: PROFILE_UID, patch, ...status }
  return [
    { call: 'patch_resource.findMany', where },
    { call: 'patch_resource.count', where }
  ]
}

const viaRoute = (viewer: MatrixViewer) =>
  record(viewer, async () =>
    readJson(
      await GET(
        getRequest(
          `/api/user/profile/resource?uid=${PROFILE_UID}&page=1&limit=20`,
          viewer
        )
      )
    )
  )

const viaLoader = (viewer: MatrixViewer) =>
  record(viewer, () => kunGetActions({ uid: PROFILE_UID, page: 1, limit: 20 }))

// 未登录 (含伪造 cookie / 失效 token): 两侧同一句拒绝, 不查库
const anonymousViewers = [V.guest, V.guestForged, V.staleToken]

// 登录视角: patch 走完整可见性 (NSFW + 屏蔽标签), 资源 status 恒按 viewer 计算
// (没有共享缓存, 所以普通用户也是「公开或自己的待审资源」)
const rows: Array<{ viewer: MatrixViewer; patch: object; status: object }> = [
  { viewer: V.userSfw, patch: SFW, status: ownStatus(11) },
  { viewer: V.userAll, patch: ALL, status: ownStatus(12) },
  { viewer: V.userNsfw, patch: NSFW_ONLY, status: ownStatus(13) },
  { viewer: V.blockerMirror, patch: SFW_BLOCK_10_20, status: ownStatus(21) },
  { viewer: V.blockerDb, patch: SFW_BLOCK_10_20, status: ownStatus(22) },
  { viewer: V.blockerBadEscape, patch: SFW_BLOCK_10_20, status: ownStatus(23) },
  { viewer: V.blockerBadJson, patch: SFW_BLOCK_10_20, status: ownStatus(24) },
  { viewer: V.mirrorOnly, patch: SFW, status: ownStatus(25) },
  { viewer: V.pendingAuthor, patch: SFW, status: ownStatus(31) },
  { viewer: V.admin, patch: SFW, status: ADMIN_STATUS },
  { viewer: V.adminBlocker, patch: SFW_BLOCK_7_8, status: ADMIN_STATUS }
]

beforeEach(() => {
  resetMatrix()
})

describe('个人主页资源 /api/user/profile/resource ↔ app/user/[id]/resource/actions.ts', () => {
  it.each(anonymousViewers)('route: $name → 用户登录失效', async (viewer) => {
    const recording = await viaRoute(viewer)

    expect(recording.result).toBe('用户登录失效')
    expect(interactions(recording)).toEqual({
      prisma: [],
      redis: [],
      meili: []
    })
  })

  it.each(anonymousViewers)('loader: $name → 用户登录失效', async (viewer) => {
    const recording = await viaLoader(viewer)

    expect(recording.result).toBe('用户登录失效')
    expect(interactions(recording)).toEqual({
      prisma: [],
      redis: [],
      meili: []
    })
  })

  it.each(rows)('route: $viewer.name', async (row) => {
    const recording = await viaRoute(row.viewer)

    expect(recording.prisma).toEqual(profileQueries(row.patch, row.status))
    expect(recording.redis).toEqual([])
    expect(recording.result).toEqual({ resources: [], total: 0 })
  })

  it.each(rows)('loader: $viewer.name', async (row) => {
    const recording = await viaLoader(row.viewer)

    expect(recording.prisma).toEqual(profileQueries(row.patch, row.status))
    expect(recording.redis).toEqual([])
    expect(recording.result).toEqual({ resources: [], total: 0 })
  })

  it.each([...anonymousViewers.map((viewer) => ({ viewer })), ...rows])(
    'route ≡ loader: $viewer.name',
    async ({ viewer }) => {
      const route = await viaRoute(viewer)
      const loader = await viaLoader(viewer)

      expect(interactions(loader)).toEqual(interactions(route))
      expect(loader.result).toEqual(route.result)
    }
  )
})
