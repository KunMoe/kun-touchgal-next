import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALL,
  NSFW_ONLY,
  SFW,
  SFW_BLOCK_10_20,
  SFW_BLOCK_7_8,
  V,
  getRequest,
  matrixState,
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

import { GET } from '~/app/api/home/random/route'

// count 10 × Math.random 0.5 → skip 5; 抽到 id 42 再按 id 取 unique_id
const randomQueries = (visibility: object) => [
  { call: 'patch.count', where: visibility },
  { call: 'patch.findMany', where: visibility },
  { call: 'patch.findUnique', where: { id: 42 } }
]

// 随机作品只按可见性 where 抽样, 没有页面侧读取器, 也不碰 Redis;
// 管理员与有待审资源的作者在这里没有个人视角
const rows: Array<{ viewer: MatrixViewer; visibility: object }> = [
  { viewer: V.guest, visibility: SFW },
  { viewer: V.guestForged, visibility: SFW },
  { viewer: V.staleToken, visibility: SFW },
  { viewer: V.userSfw, visibility: SFW },
  { viewer: V.userAll, visibility: ALL },
  { viewer: V.userNsfw, visibility: NSFW_ONLY },
  { viewer: V.blockerMirror, visibility: SFW_BLOCK_10_20 },
  { viewer: V.blockerDb, visibility: SFW_BLOCK_10_20 },
  { viewer: V.blockerBadEscape, visibility: SFW_BLOCK_10_20 },
  { viewer: V.blockerBadJson, visibility: SFW_BLOCK_10_20 },
  { viewer: V.mirrorOnly, visibility: SFW },
  { viewer: V.pendingAuthor, visibility: SFW },
  { viewer: V.admin, visibility: SFW },
  { viewer: V.adminBlocker, visibility: SFW_BLOCK_7_8 }
]

beforeEach(() => {
  resetMatrix()
  matrixState.prismaResults = {
    'patch.count': 10,
    'patch.findMany': [{ id: 42 }],
    'patch.findUnique': { unique_id: 'kun00042' }
  }
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('随机作品 /api/home/random 视角矩阵 (只有 route)', () => {
  it.each(rows)('route: $viewer.name', async (row) => {
    const recording = await record(row.viewer, async () =>
      readJson(await GET(getRequest('/api/home/random', row.viewer)))
    )

    expect(recording.prisma).toEqual(randomQueries(row.visibility))
    expect(recording.redis).toEqual([])
    expect(recording.result).toEqual({ uniqueId: 'kun00042' })
  })
})
